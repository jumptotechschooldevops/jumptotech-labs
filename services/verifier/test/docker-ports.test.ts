/**
 * `docker_container_port`, and the DOCKER-012 contract built on it.
 *
 * The distinction this file exists to pin is the one students get wrong:
 * a container that *exposes* a port and a container that *publishes* one look
 * similar in `docker inspect` and are not the same thing. An exposed port has
 * no host side; a published one does. A check that accepted the first would let
 * a student pass DOCKER-012 with a container nothing outside can reach.
 *
 * Also pinned: two containers may hold the same container port at once, as long
 * as their host ports differ. That is the whole architecture DOCKER-012 asks
 * for, and a check that treated container ports as unique would forbid it.
 *
 * Nothing here asserts HTTP reachability. `docker_container_port` reads a
 * binding; it does not make a request, and DOCKER-012 claims only the binding.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LabRegistry,
  requirementSchema,
  type LoadedLabDefinition,
  type Requirement,
} from '@jumptotech/lab-orchestrator';
import { FakeDockerDaemon, containerSpec } from '@jumptotech/lab-orchestrator/testing';
import { DockerVerifyReader, verifyLab, verifyRequirement } from '../src/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SANDBOX_A = 'jtt-lab-00000000000a';
const SANDBOX_B = 'jtt-lab-00000000000b';

let lab: LoadedLabDefinition;

beforeAll(async () => {
  const registry = new LabRegistry(path.join(repoRoot, 'labs'));
  await registry.load();
  expect(registry.loadErrors).toEqual([]);
  lab = registry.get('DOCKER-012');
});

const check = (docker: FakeDockerDaemon, requirement: Requirement, sandbox = SANDBOX_A) =>
  verifyRequirement(requirement, new DockerVerifyReader(docker, sandbox));
const passed = (result: { status: string }) => result.status === 'pass';

const port = (name: string, containerPort: number, hostPort?: number) =>
  ({
    type: 'docker_container_port',
    name,
    container_port: containerPort,
    protocol: 'tcp',
    ...(hostPort === undefined ? {} : { host_port: hostPort }),
  }) as Requirement;

/** A container publishing HOST:CONTAINER, the way `-p` leaves it. */
function published(name: string, containerPort: number, hostPort: number) {
  return containerSpec({
    name,
    image: 'nginx:1.27-alpine',
    ports: [{ containerPort, hostPort }],
  });
}

/** A container that only EXPOSEs — a port with no host side, as `{"80/tcp":null}` parses. */
function exposedOnly(name: string, containerPort: number) {
  return containerSpec({ name, image: 'nginx:1.27-alpine', ports: [{ containerPort }] });
}

// ------------------------------------------------------ published vs exposed

describe('docker_container_port — publishing is not exposing', () => {
  it('accepts a published port', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(published('web', 80, 8080));
    expect(passed(await check(docker, port('web', 80, 8080)))).toBe(true);
  });

  it('REFUSES a container that only exposes the port, and says why', async () => {
    // `EXPOSE 80` with no `-p`. Nothing outside the daemon can reach it.
    const docker = new FakeDockerDaemon();
    docker.addContainer(exposedOnly('web', 80));

    const result = await check(docker, port('web', 80, 8080));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('does not publish it to a host port');
  });

  it('still confirms an exposure when a lab asks only about the container port', async () => {
    // Without `host_port` the check is "is this port exposed at all", which an
    // EXPOSE-only container satisfies. DOCKER-012 never uses that form.
    const docker = new FakeDockerDaemon();
    docker.addContainer(exposedOnly('web', 80));
    expect(passed(await check(docker, port('web', 80)))).toBe(true);
  });
});

// ---------------------------------------------------------- wrong mappings

describe('docker_container_port — wrong mappings fail, each in its own way', () => {
  it('fails a wrong host port and names the one actually held', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(published('web', 80, 9090));

    const result = await check(docker, port('web', 80, 8081));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('9090');
    expect(result.detail).toContain('expected 8081');
  });

  it('fails a wrong container port and lists what is published', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(published('web', 8080, 8080));

    const result = await check(docker, port('web', 80, 8080));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('does not expose 80/tcp');
  });

  it('fails a container publishing nothing at all', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(containerSpec({ name: 'web', image: 'nginx:1.27-alpine' }));

    const result = await check(docker, port('web', 80, 8080));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('publishes no ports');
  });

  it('fails a missing container without inventing a verdict', async () => {
    const result = await check(new FakeDockerDaemon(), port('web', 80, 8080));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain("No container named 'web'");
  });
});

// ------------------------------------------------- the DOCKER-012 topology

describe('DOCKER-012 — two services, one host', () => {
  /** Both containers on port 80 internally, on different host ports. */
  function solved() {
    const docker = new FakeDockerDaemon();
    docker.addContainer(published('ledger-web', 80, 8080), 'running', 0);
    docker.addContainer(published('statements-web', 80, 8081), 'running', 0);
    return docker;
  }

  const verify = (docker: FakeDockerDaemon, sandbox = SANDBOX_A) =>
    verifyLab({ lab, namespace: sandbox, docker });
  const failing = (r: Awaited<ReturnType<typeof verify>>) =>
    r.checks.filter((c) => c.status !== 'pass').map((c) => c.label);

  it('two containers may share a container port when their host ports differ', async () => {
    const result = await verify(solved());
    expect(failing(result)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('the seeded incident fails: the second service is stopped and unbound', async () => {
    // Exactly what provisioning leaves behind — the failed deployment holds no
    // binding at all, because it never successfully started.
    const docker = new FakeDockerDaemon();
    docker.addContainer(published('ledger-web', 80, 8080), 'running', 0);
    docker.addContainer(
      containerSpec({ name: 'statements-web', image: 'nginx:1.27-alpine' }),
      'exited',
      128,
    );

    const result = await verify(docker);
    expect(result.passed).toBe(false);
    expect(failing(result).sort()).toEqual([
      'Container statements-web is running',
      'statements-web publishes container port 80 on host port 8081',
    ].sort());
  });

  it('fixing the second service by taking the first one down does not pass', async () => {
    // The obvious wrong move: free 8080 by stopping production.
    const docker = new FakeDockerDaemon();
    docker.addContainer(published('ledger-web', 80, 8080), 'exited', 0);
    docker.addContainer(published('statements-web', 80, 8081), 'running', 0);

    const result = await verify(docker);
    expect(result.passed).toBe(false);
    expect(failing(result)).toContain('Container ledger-web is still running');
  });

  it('putting the second service on the wrong host port does not pass', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(published('ledger-web', 80, 8080), 'running', 0);
    docker.addContainer(published('statements-web', 80, 9090), 'running', 0);

    const result = await verify(docker);
    expect(result.passed).toBe(false);
    expect(failing(result)).toEqual([
      'statements-web publishes container port 80 on host port 8081',
    ]);
  });

  it('swapping the two host ports does not pass, even though both are in use', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(published('ledger-web', 80, 8081), 'running', 0);
    docker.addContainer(published('statements-web', 80, 8080), 'running', 0);

    const result = await verify(docker);
    expect(result.passed).toBe(false);
    expect(failing(result).length).toBe(2);
  });

  it('an exposed-but-unpublished second service does not pass', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(published('ledger-web', 80, 8080), 'running', 0);
    docker.addContainer(exposedOnly('statements-web', 80), 'running', 0);

    const result = await verify(docker);
    expect(result.passed).toBe(false);
    expect(
      result.checks.find((c) => c.label.includes('8081'))?.detail,
    ).toContain('does not publish it to a host port');
  });

  it('a stopped second service does not pass, however it is configured', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(published('ledger-web', 80, 8080), 'running', 0);
    docker.addContainer(published('statements-web', 80, 8081), 'exited', 0);

    const result = await verify(docker);
    expect(result.passed).toBe(false);
    expect(failing(result)).toContain('Container statements-web is running');
  });

  it('the wrong image on the right port does not pass', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(published('ledger-web', 80, 8080), 'running', 0);
    docker.addContainer(
      containerSpec({ name: 'statements-web', image: 'alpine:3.20', ports: [{ containerPort: 80, hostPort: 8081 }] }),
      'running',
      0,
    );

    const result = await verify(docker);
    expect(result.passed).toBe(false);
    expect(failing(result)).toEqual(['statements-web runs the nginx:1.27-alpine image']);
  });

  it('accepts a registry-qualified image, so an alternate workflow still passes', async () => {
    // `docker pull docker.io/library/nginx:1.27-alpine` then run: same image,
    // different spelling. The check normalises rather than string-matching.
    const docker = new FakeDockerDaemon();
    docker.addContainer(published('ledger-web', 80, 8080), 'running', 0);
    docker.addContainer(
      containerSpec({
        name: 'statements-web',
        image: 'docker.io/library/nginx:1.27-alpine',
        ports: [{ containerPort: 80, hostPort: 8081 }],
      }),
      'running',
      0,
    );

    const result = await verify(docker);
    expect(failing(result)).toEqual([]);
  });

  it('is graded against the session that did the work, and no other', async () => {
    const sessionB = solved();
    expect((await verify(sessionB, SANDBOX_B)).passed).toBe(true);

    const sessionA = await verify(new FakeDockerDaemon(), SANDBOX_A);
    expect(sessionA.passed).toBe(false);
    expect(failing(sessionA)).toHaveLength(6);
  });

  it('asserts port bindings only — no requirement claims HTTP reachability', () => {
    // The lab contract, pinned. If a reachability check is ever added it must
    // be a deliberate change here, not an accident.
    for (const requirement of lab.requirements as readonly Requirement[]) {
      expect(requirement.type).not.toBe('docker_http_reachable');
      expect(Object.keys(requirement)).not.toContain('expect_status');
    }
    const portChecks = (lab.requirements as readonly Requirement[]).filter(
      (r) => r.type === 'docker_container_port',
    );
    expect(portChecks).toHaveLength(2);
    // Both name a host port, so neither can be satisfied by EXPOSE alone.
    for (const requirement of portChecks) {
      expect(requirement).toHaveProperty('host_port');
    }
  });

  it('rejects a malformed port in the schema rather than at check time', () => {
    for (const value of [0, -1, 70000, 1.5]) {
      expect(
        requirementSchema.safeParse({
          type: 'docker_container_port',
          name: 'web',
          container_port: value,
          host_port: 8080,
        }).success,
        String(value),
      ).toBe(false);
    }
  });
});
