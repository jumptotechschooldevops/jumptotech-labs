/**
 * PLATFORM-DOCKER — Docker verification.
 *
 * The Kubernetes suite's counterpart. Same three properties, asserted the same
 * way:
 *
 *   - **State, not commands.** Every check reads `docker inspect` output. A
 *     container created with `docker run`, with `docker create` + `docker
 *     start`, or from a Compose file produces identical state and passes
 *     identically. Nothing here looks at what the student typed.
 *   - **One daemon, fixed at construction.** A handler is never given the
 *     chance to name a daemon, so it cannot read outside the session it grades.
 *   - **A broken environment is not a wrong answer.** A daemon that cannot be
 *     reached reports `ENVIRONMENT_UNREACHABLE` with skipped checks, rather than
 *     telling a student their correct work failed.
 *
 * Every shipped Docker lab is additionally run twice at the bottom: once against
 * an empty daemon, where it must fail, and once against a daemon holding the
 * solution, where it must pass.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOCKER_REQUIREMENT_TYPES,
  InMemoryWorkspace,
  LabRegistry,
  requirementSchema,
  type LoadedLabDefinition,
  type Requirement,
} from '@jumptotech/lab-orchestrator';
import { FakeDockerDaemon, containerSpec } from '@jumptotech/lab-orchestrator/testing';
import { scanLabsDirectory } from '@jumptotech/lab-orchestrator/testing/catalog';
import {
  DockerVerifyReader,
  parseDockerMemory,
  parseDockerCpus,
  parseDockerfile,
  looksLikeDockerfile,
  registeredRequirementTypes,
  verifyLab,
  verifyRequirement,
} from '../src/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SANDBOX_A = 'lab-00000000000a';
const SANDBOX_B = 'lab-00000000000b';
const SESSION_A = 'sess-000000000000000a';

let registry: LabRegistry;

beforeAll(async () => {
  registry = new LabRegistry(path.join(repoRoot, 'labs'));
  await registry.load();
  expect(registry.loadErrors).toEqual([]);
});

/** Run one requirement against a fake daemon and return its result. */
function check(
  docker: FakeDockerDaemon,
  requirement: Requirement,
  workspace?: { port: InMemoryWorkspace; sessionId: string },
) {
  return verifyRequirement(requirement, new DockerVerifyReader(docker, SANDBOX_A, workspace));
}

const passed = (result: { status: string }) => result.status === 'pass';

// ------------------------------------------------------------- containers

describe('docker verifier — container checks', () => {
  it('sees a container that exists and reports one that does not', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(containerSpec({ name: 'web' }));

    expect(
      passed(await check(docker, { type: 'docker_container_exists', name: 'web' } as Requirement)),
    ).toBe(true);

    const missing = await check(docker, {
      type: 'docker_container_exists',
      name: 'api',
    } as Requirement);
    expect(missing.status).toBe('fail');
    // The message orients without naming the sandbox: a student's `docker ps`
    // only shows their own daemon, so "in sandbox lab-…" would be noise.
    expect(missing.detail).toBe("No container named 'api' exists in your Docker environment");
  });

  it('accepts a container however it was created', async () => {
    // `docker run`, and `docker create` + `docker start`, leave the same state.
    const viaRun = new FakeDockerDaemon();
    viaRun.addContainer(containerSpec({ name: 'web' }), 'running');

    const viaCreateThenStart = new FakeDockerDaemon();
    viaCreateThenStart.addContainer(containerSpec({ name: 'web' }), 'created');
    await viaCreateThenStart.startContainer('web');

    for (const docker of [viaRun, viaCreateThenStart]) {
      expect(
        passed(await check(docker, { type: 'docker_container_running', name: 'web' } as Requirement)),
      ).toBe(true);
    }
  });

  it('surfaces the exit code of a container that stopped', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(containerSpec({ name: 'web' }), 'exited', 137);

    const result = await check(docker, {
      type: 'docker_container_running',
      name: 'web',
    } as Requirement);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('exit code 137');
  });

  it('grades an explicit state, for labs where running is the wrong answer', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(containerSpec({ name: 'batch' }), 'exited', 0);

    expect(
      passed(
        await check(docker, {
          type: 'docker_container_state',
          name: 'batch',
          expected: 'exited',
        } as Requirement),
      ),
    ).toBe(true);
    expect(
      (
        await check(docker, {
          type: 'docker_container_state',
          name: 'batch',
          expected: 'running',
        } as Requirement)
      ).status,
    ).toBe('fail');
  });

  it('normalises registry prefixes when matching an image', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(containerSpec({ name: 'web', image: 'docker.io/library/nginx:1.27-alpine' }));

    expect(
      passed(
        await check(docker, {
          type: 'docker_container_image',
          name: 'web',
          image: 'nginx:1.27-alpine',
        } as Requirement),
      ),
    ).toBe(true);
  });

  it('grades an exit code, and refuses to guess while a container still runs', async () => {
    const stopped = new FakeDockerDaemon();
    stopped.addContainer(containerSpec({ name: 'job' }), 'exited', 0);
    const running = new FakeDockerDaemon();
    running.addContainer(containerSpec({ name: 'job' }), 'running');

    expect(
      passed(
        await check(stopped, {
          type: 'docker_container_exit_code',
          name: 'job',
          expected: 0,
        } as Requirement),
      ),
    ).toBe(true);

    const early = await check(running, {
      type: 'docker_container_exit_code',
      name: 'job',
      expected: 0,
    } as Requirement);
    expect(early.status).toBe('fail');
    expect(early.detail).toMatch(/still running/);
  });

  it('checks an environment variable, with or without a value', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(containerSpec({ name: 'app', env: { APP_MODE: 'production' } }));

    for (const requirement of [
      { type: 'docker_container_env', name: 'app', key: 'APP_MODE' },
      { type: 'docker_container_env', name: 'app', key: 'APP_MODE', value: 'production' },
    ]) {
      expect(passed(await check(docker, requirement as Requirement))).toBe(true);
    }

    const wrong = await check(docker, {
      type: 'docker_container_env',
      name: 'app',
      key: 'APP_MODE',
      value: 'debug',
    } as Requirement);
    expect(wrong.status).toBe('fail');
    expect(wrong.detail).toContain("APP_MODE='production'");
  });

  it('distinguishes an exposed port from a published one', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(
      containerSpec({ name: 'web', ports: [{ containerPort: 80, hostPort: 8080 }] }),
    );

    expect(
      passed(
        await check(docker, {
          type: 'docker_container_port',
          name: 'web',
          container_port: 80,
          protocol: 'tcp',
        } as Requirement),
      ),
    ).toBe(true);
    expect(
      passed(
        await check(docker, {
          type: 'docker_container_port',
          name: 'web',
          container_port: 80,
          host_port: 8080,
          protocol: 'tcp',
        } as Requirement),
      ),
    ).toBe(true);

    const wrongHost = await check(docker, {
      type: 'docker_container_port',
      name: 'web',
      container_port: 80,
      host_port: 9090,
      protocol: 'tcp',
    } as Requirement);
    expect(wrongHost.status).toBe('fail');
    expect(wrongHost.detail).toContain('8080');
  });

  it('checks network attachment and lists what it found instead', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(containerSpec({ name: 'api', network: 'ledger-net' }));

    expect(
      passed(
        await check(docker, {
          type: 'docker_container_network',
          name: 'api',
          network: 'ledger-net',
        } as Requirement),
      ),
    ).toBe(true);

    const wrong = await check(docker, {
      type: 'docker_container_network',
      name: 'api',
      network: 'other-net',
    } as Requirement);
    expect(wrong.detail).toContain('ledger-net');
  });

  it('accepts only a named volume, never a bind mount, for a volume check', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(
      containerSpec({
        name: 'db',
        volumes: [{ volume: 'ledger-data', destination: '/var/lib/data' }],
      }),
    );

    expect(
      passed(
        await check(docker, {
          type: 'docker_container_mount',
          name: 'db',
          volume: 'ledger-data',
          destination: '/var/lib/data',
        } as Requirement),
      ),
    ).toBe(true);

    const wrongPath = await check(docker, {
      type: 'docker_container_mount',
      name: 'db',
      volume: 'ledger-data',
      destination: '/data',
    } as Requirement);
    expect(wrongPath.status).toBe('fail');
    expect(wrongPath.detail).toContain('/var/lib/data');
  });
});

// -------------------------------------------------------- resource limits

describe('docker verifier — resource limits are read from what the daemon enforces', () => {
  it('accepts any spelling of the same limit', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(containerSpec({ name: 'web', memory: '512m', cpus: '0.5', pidsLimit: 64 }));

    for (const memory of ['512m', '512M', '536870912']) {
      expect(
        passed(
          await check(docker, {
            type: 'docker_container_resource_limit',
            name: 'web',
            memory,
          } as Requirement),
        ),
        `memory spelled '${memory}'`,
      ).toBe(true);
    }

    expect(
      passed(
        await check(docker, {
          type: 'docker_container_resource_limit',
          name: 'web',
          cpus: '0.5',
          pids_limit: 64,
        } as Requirement),
      ),
    ).toBe(true);
  });

  it('reports an unlimited container as unlimited, not as a mismatch', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(containerSpec({ name: 'web' }));

    const result = await check(docker, {
      type: 'docker_container_resource_limit',
      name: 'web',
      memory: '512m',
      cpus: '0.5',
    } as Requirement);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('memory is unlimited');
    expect(result.detail).toContain('CPU is unlimited');
  });

  it('parses Docker\'s binary suffixes the way the daemon does', () => {
    // `1k` is 1024, not 1000 — as `docker run --help` documents.
    expect(parseDockerMemory('1k')).toBe(1024);
    expect(parseDockerMemory('512m')).toBe(536_870_912);
    expect(parseDockerMemory('2g')).toBe(2_147_483_648);
    expect(parseDockerCpus('1.5')).toBe(1_500_000_000);
  });

  /*
   * DOCKER-009 grades three controls on one container, and the lab's whole
   * point is that a partially-correct budget is *not* a pass. A student who
   * sets memory and CPU but forgets the process limit has to be told which one
   * is missing, so the check must fail and the detail must name it.
   */
  it('fails a partial budget and names the control that is missing', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(containerSpec({ name: 'reporting', memory: '256m', cpus: '0.5' }));

    const result = await check(docker, {
      type: 'docker_container_resource_limit',
      name: 'reporting',
      memory: '256m',
      cpus: '0.5',
      pids_limit: 64,
    } as Requirement);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('process count is unlimited');
    // The two controls the student *did* get right are not reported as problems.
    expect(result.detail).not.toContain('memory');
    expect(result.detail).not.toContain('CPU');
  });

  it('fails a process limit set to the wrong value', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(containerSpec({ name: 'reporting', pidsLimit: 128 }));

    const result = await check(docker, {
      type: 'docker_container_resource_limit',
      name: 'reporting',
      pids_limit: 64,
    } as Requirement);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('process limit is 128, expected 64');
  });
});

/*
 * DOCKER-009's second half asks the student to observe a limit being enforced:
 * `memory-probe` must be a container the kernel stopped, not one that ran to
 * completion. Exit code is the observable that separates those two outcomes, so
 * these tests pin the behaviour the lab depends on.
 */
/*
 * DOCKER-009's second half asks the student to observe a memory limit being
 * enforced. Exit code 137 does NOT establish that: it means "killed by
 * SIGKILL", and the kernel is only one of the things that sends it. Verified
 * against a real daemon (Docker 28.4.0, cgroup v2) — every row below produced
 * exit code 137, and only the first had OOMKilled true:
 *
 *   legitimate OOM                     exited 137  OOMKilled=true
 *   docker kill                        exited 137  OOMKilled=false
 *   docker stop (SIGTERM honoured)     exited 137  OOMKilled=false
 *   docker stop -> SIGKILL escalation  exited 137  OOMKilled=false
 *   application called exit(137)       exited 137  OOMKilled=false
 *
 * These tests pin that distinction, because without it the lab is satisfiable
 * with a single `docker kill`.
 */
describe('docker verifier — OOM kill is not the same as exit code 137', () => {
  const probe = (state: string, exitCode: number, oomKilled: boolean) => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(
      containerSpec({ name: 'memory-probe', image: 'alpine:3.20', memory: '16m' }),
      state,
      exitCode,
      oomKilled,
    );
    return docker;
  };
  const oomCheck = (name = 'memory-probe', expected = true) =>
    ({ type: 'docker_container_oom_killed', name, expected }) as Requirement;

  it('legitimate OOM passes', async () => {
    expect(passed(await check(probe('exited', 137, true), oomCheck()))).toBe(true);
  });

  it('docker kill fails — same exit code, no OOM', async () => {
    const result = await check(probe('exited', 137, false), oomCheck());
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('exit code 137');
    expect(result.detail).toContain('does not report it as killed');
  });

  it('docker stop fails, whether or not it escalated to SIGKILL', async () => {
    // Both spellings observed on a real daemon: 143 when the process handles
    // SIGTERM, 137 when the grace period runs out and the daemon escalates.
    for (const exitCode of [143, 137]) {
      const result = await check(probe('exited', exitCode, false), oomCheck());
      expect(result.status, `exit ${exitCode}`).toBe('fail');
    }
  });

  it('a normal exit fails', async () => {
    expect((await check(probe('exited', 0, false), oomCheck())).status).toBe('fail');
  });

  it('an application that exits 137 by itself fails', async () => {
    // The nastiest false positive the old check had: the student writes a
    // program that returns 137 and never touches the memory limit.
    const result = await check(probe('exited', 137, false), oomCheck());
    expect(result.status).toBe('fail');
  });

  it('a still-running container fails, and says so plainly', async () => {
    const result = await check(probe('running', 0, false), oomCheck());
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('still running');
  });

  it('a differently-named container does not satisfy the check', async () => {
    // A compliant decoy alongside a wrong target must not be substituted in.
    const docker = new FakeDockerDaemon();
    docker.addContainer(containerSpec({ name: 'memory-probe', memory: '16m' }), 'exited', 137, false);
    docker.addContainer(containerSpec({ name: 'other-probe', memory: '16m' }), 'exited', 137, true);

    expect(passed(await check(docker, oomCheck('other-probe')))).toBe(true);
    expect((await check(docker, oomCheck('memory-probe'))).status).toBe('fail');
  });

  it('a missing container fails without inventing a verdict', async () => {
    const result = await check(new FakeDockerDaemon(), oomCheck('nope'));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain("No container named 'nope'");
  });

  it('grades the negative form for production labs', async () => {
    // `expected: false` is "this must NOT have been OOM-killed".
    expect(passed(await check(probe('exited', 0, false), oomCheck('memory-probe', false)))).toBe(true);
    const wasKilled = await check(probe('exited', 137, true), oomCheck('memory-probe', false));
    expect(wasKilled.status).toBe('fail');
    expect(wasKilled.detail).toContain('was killed for exceeding its memory limit');
  });

  it('reads the flag per-run, so a past OOM does not linger', async () => {
    // Verified on a real daemon: a container that was OOM-killed and then
    // started again reports OOMKilled=false for the new run.
    expect((await check(probe('exited', 0, false), oomCheck())).status).toBe('fail');
  });
});

/*
 * Untrusted identifiers. The new requirement carries a container *name*, and a
 * name is the only thing that could conceivably travel toward an argv, so the
 * closed character class is asserted here rather than assumed. Note the
 * property being proved is at the schema layer: a malformed name never reaches
 * a handler at all, because the lab fails to load.
 */
describe('docker verifier — untrusted container identifiers', () => {
  const parse = (name: string) =>
    requirementSchema.safeParse({
      type: 'docker_container_oom_killed',
      name,
      expected: true,
      label: 'x',
    });

  it('rejects every injection-shaped container name', () => {
    for (const name of [
      'probe; rm -rf /',
      'probe && curl evil',
      'probe | tee /etc/passwd',
      'probe$(whoami)',
      'probe`whoami`',
      'probe\nkill',
      'probe\rkill',
      '../../etc/shadow',
      '/etc/shadow',
      '--privileged',
      '-v /:/host',
      'other-sandbox/probe',
      'probe:latest',
      'probe@sha256:abc',
      'probe *',
      "probe'",
      'probe"',
      'probe\\x',
      'probé',
      'p'.repeat(129),
      '',
    ]) {
      expect(parse(name).success, JSON.stringify(name)).toBe(false);
    }
  });

  it('accepts the names a lab legitimately needs', () => {
    for (const name of ['memory-probe', 'ledger_db', 'app.1', 'a', 'A0-_.']) {
      expect(parse(name).success, name).toBe(true);
    }
  });

  it('refuses an unknown field, so the schema cannot be widened by a lab', () => {
    const withExtra = requirementSchema.safeParse({
      type: 'docker_container_oom_killed',
      name: 'memory-probe',
      expected: true,
      command: 'docker inspect memory-probe',
    });
    expect(withExtra.success).toBe(false);
  });

  it('cannot be satisfied by another session holding the OOM-killed container', async () => {
    // Session B did the work. Session A is graded against its own daemon, which
    // is a different object store — not a filtered view of B's.
    const sessionB = new FakeDockerDaemon();
    sessionB.addContainer(containerSpec({ name: 'memory-probe', memory: '16m' }), 'exited', 137, true);

    const requirement = {
      type: 'docker_container_oom_killed',
      name: 'memory-probe',
      expected: true,
    } as Requirement;

    expect(passed(await verifyRequirement(requirement, new DockerVerifyReader(sessionB, SANDBOX_B)))).toBe(
      true,
    );
    const sessionA = await verifyRequirement(
      requirement,
      new DockerVerifyReader(new FakeDockerDaemon(), SANDBOX_A),
    );
    expect(sessionA.status).toBe('fail');
  });
});

/*
 * The exit-code and limit checks DOCKER-009 keeps alongside the OOM check.
 * They are not redundant: together they tell a student whether the container
 * stopped, with what code, and whether the kernel is the one that stopped it.
 */
describe('docker verifier — the checks that surround the OOM signal', () => {
  it('passes the full memory-probe requirement set for a genuine OOM', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(
      containerSpec({ name: 'memory-probe', image: 'alpine:3.20', memory: '16m' }),
      'exited',
      137,
      true,
    );

    for (const requirement of [
      { type: 'docker_container_state', name: 'memory-probe', expected: 'exited' },
      { type: 'docker_container_exit_code', name: 'memory-probe', expected: 137 },
      { type: 'docker_container_resource_limit', name: 'memory-probe', memory: '16m' },
      { type: 'docker_container_oom_killed', name: 'memory-probe', expected: true },
    ] as Requirement[]) {
      expect(passed(await check(docker, requirement)), requirement.type).toBe(true);
    }
  });

  it('fails a probe that ran to completion instead of being killed', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(containerSpec({ name: 'memory-probe', memory: '16m' }), 'exited', 0);

    const result = await check(docker, {
      type: 'docker_container_exit_code',
      name: 'memory-probe',
      expected: 137,
    } as Requirement);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('exited with code 0, expected 137');
  });

  it('fails a probe given no memory limit at all', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(containerSpec({ name: 'memory-probe' }), 'exited', 137, true);

    const result = await check(docker, {
      type: 'docker_container_resource_limit',
      name: 'memory-probe',
      memory: '16m',
    } as Requirement);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('memory is unlimited');
  });
});

// -------------------------------------------- images, volumes, networks

describe('docker verifier — image, volume, and network checks', () => {
  it('finds an image and reports a missing one', async () => {
    const docker = new FakeDockerDaemon({ images: ['nginx:1.27-alpine'] });

    expect(
      passed(
        await check(docker, { type: 'docker_image_exists', image: 'nginx:1.27-alpine' } as Requirement),
      ),
    ).toBe(true);
    expect(
      (await check(docker, { type: 'docker_image_exists', image: 'redis:7' } as Requirement)).status,
    ).toBe('fail');
  });

  it('grades a built image on its configuration, not on the Dockerfile text', async () => {
    const docker = new FakeDockerDaemon();
    docker.addImage('ledger:1.0', {
      workingDir: '/app',
      cmd: ['./run.sh'],
      env: { APP_ENV: 'production' },
      exposedPorts: ['8080/tcp'],
      labels: { maintainer: 'platform' },
    });

    expect(
      passed(
        await check(docker, {
          type: 'docker_image_config',
          image: 'ledger:1.0',
          working_dir: '/app',
          cmd_contains: ['./run.sh'],
          env: { APP_ENV: 'production' },
          exposed_port: 8080,
          labels: { maintainer: 'platform' },
        } as Requirement),
      ),
    ).toBe(true);
  });

  it('accepts ENTRYPOINT and CMD as two ways of writing the same startup', async () => {
    const viaCmd = new FakeDockerDaemon();
    viaCmd.addImage('app:1', { cmd: ['python', 'main.py'] });
    const viaEntrypoint = new FakeDockerDaemon();
    viaEntrypoint.addImage('app:1', { entrypoint: ['python'], cmd: ['main.py'] });

    for (const docker of [viaCmd, viaEntrypoint]) {
      expect(
        passed(
          await check(docker, {
            type: 'docker_image_config',
            image: 'app:1',
            cmd_contains: ['python', 'main.py'],
          } as Requirement),
        ),
      ).toBe(true);
    }
  });

  it('finds volumes and networks, and checks a network driver', async () => {
    const docker = new FakeDockerDaemon();
    await docker.createVolume('ledger-data');
    await docker.createNetwork({ name: 'ledger-net', driver: 'bridge' });

    expect(
      passed(await check(docker, { type: 'docker_volume_exists', name: 'ledger-data' } as Requirement)),
    ).toBe(true);
    expect(
      passed(
        await check(docker, {
          type: 'docker_network_exists',
          name: 'ledger-net',
          driver: 'bridge',
        } as Requirement),
      ),
    ).toBe(true);

    const wrongDriver = await check(docker, {
      type: 'docker_network_exists',
      name: 'ledger-net',
      driver: 'overlay',
    } as Requirement);
    expect(wrongDriver.status).toBe('fail');
  });

  it('passes an absence check only once the thing is genuinely gone', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(containerSpec({ name: 'old' }));

    const stillThere = await check(docker, {
      type: 'docker_resource_absent',
      kind: 'container',
      name: 'old',
    } as Requirement);
    expect(stillThere.status).toBe('fail');

    await docker.removeContainer('old');
    expect(
      passed(
        await check(docker, {
          type: 'docker_resource_absent',
          kind: 'container',
          name: 'old',
        } as Requirement),
      ),
    ).toBe(true);
  });
});

// ------------------------------------------------------------- workspace

describe('docker verifier — workspace checks read a file and nothing more', () => {
  function withWorkspace(files: Record<string, string> = {}) {
    const port = new InMemoryWorkspace();
    for (const [file, content] of Object.entries(files)) port.write(SESSION_A, file, content);
    return { port, sessionId: SESSION_A };
  }

  it('finds a file and checks its content for what the lab asked for', async () => {
    const docker = new FakeDockerDaemon();
    const workspace = withWorkspace({ 'compose.yaml': 'services:\n  api:\n    image: alpine\n' });

    expect(
      passed(
        await check(
          docker,
          { type: 'workspace_file_exists', path: 'compose.yaml', contains: ['services:'] } as Requirement,
          workspace,
        ),
      ),
    ).toBe(true);

    const missingText = await check(
      docker,
      { type: 'workspace_file_exists', path: 'compose.yaml', contains: ['volumes:'] } as Requirement,
      workspace,
    );
    expect(missingText.status).toBe('fail');
    expect(missingText.detail).toContain("'volumes:'");
  });

  it('parses a Dockerfile structurally and never evaluates it', () => {
    const parsed = parseDockerfile(
      [
        '# syntax=docker/dockerfile:1',
        'FROM alpine:3.20 AS build',
        'WORKDIR /app',
        'RUN apk add --no-cache curl \\',
        '    && rm -rf /var/cache/apk/*',
        'CMD ["./run.sh"]',
      ].join('\n'),
    );

    expect(looksLikeDockerfile(parsed)).toBe(true);
    expect(parsed.instructions).toEqual(['FROM', 'WORKDIR', 'RUN', 'CMD']);
    // `AS build` is a stage alias, not part of the image name.
    expect(parsed.baseImages).toEqual(['alpine:3.20']);
    // A continuation is one logical instruction, not two.
    expect(parsed.lines.filter((l) => l.instruction === 'RUN')).toHaveLength(1);
  });

  it('grades a Dockerfile on its instructions and its base image', async () => {
    const docker = new FakeDockerDaemon();
    const workspace = withWorkspace({
      Dockerfile: 'FROM alpine:3.20\nWORKDIR /app\nCMD ["./run.sh"]\n',
    });

    expect(
      passed(
        await check(
          docker,
          {
            type: 'dockerfile_valid',
            path: 'Dockerfile',
            requires: ['FROM', 'WORKDIR', 'CMD'],
            base_image: 'alpine:3.20',
          } as Requirement,
          workspace,
        ),
      ),
    ).toBe(true);

    const missing = await check(
      docker,
      { type: 'dockerfile_valid', path: 'Dockerfile', requires: ['EXPOSE'] } as Requirement,
      workspace,
    );
    expect(missing.status).toBe('fail');
    expect(missing.detail).toContain('missing EXPOSE');
  });

  it('rejects a file that is not a Dockerfile at all', async () => {
    const docker = new FakeDockerDaemon();

    // Two distinct failures a student can actually produce, told apart so the
    // message says which one happened.
    const prose = await check(
      docker,
      { type: 'dockerfile_valid', path: 'Dockerfile', requires: [] } as Requirement,
      withWorkspace({ Dockerfile: 'this is just prose\n' }),
    );
    expect(prose.status).toBe('fail');
    expect(prose.detail).toMatch(/contains no Dockerfile instructions/);

    const noFrom = await check(
      docker,
      { type: 'dockerfile_valid', path: 'Dockerfile', requires: [] } as Requirement,
      withWorkspace({ Dockerfile: 'WORKDIR /app\nCMD ["./run.sh"]\n' }),
    );
    expect(noFrom.status).toBe('fail');
    expect(noFrom.detail).toMatch(/no FROM instruction, so it cannot be built/);
  });

  it('blames the environment, not the student, when no workspace is available', async () => {
    const docker = new FakeDockerDaemon();

    const result = await check(
      docker,
      { type: 'workspace_file_exists', path: 'Dockerfile' } as Requirement,
      undefined,
    );

    expect(result.status).toBe('fail');
    // A student whose terminal never opened has not made a mistake.
    expect(result.detail).toMatch(/the lab workspace is not available/);
  });
});

// ------------------------------------------------------- broken environment

describe('docker verifier — an unreachable daemon is not a failed lab', () => {
  it('reports ENVIRONMENT_UNREACHABLE and skips every check', async () => {
    const docker = new FakeDockerDaemon({ unreachable: 'Cannot connect to the Docker daemon' });

    const result = await verifyLab({
      lab: registry.get('DOCKER-001'),
      namespace: SANDBOX_A,
      docker,
    });

    expect(result.passed).toBe(false);
    expect(result.error?.code).toBe('ENVIRONMENT_UNREACHABLE');
    expect(result.checks.every((c) => c.status === 'skipped')).toBe(true);
    expect(result.checks[0]?.detail).toBe('Could not read Docker state');
  });

  it('refuses to grade a Docker lab with no Docker engine, rather than guessing', async () => {
    // A missing reader is a platform problem, not a student's failed lab, so
    // every check is reported `skipped` with a plain reason and the lab is not
    // marked passed. This is the same contract a Kubernetes lab gets when it
    // reaches the verifier with no cluster reader — see `VerificationReaders`.
    const result = await verifyLab({ lab: registry.get('DOCKER-001'), namespace: SANDBOX_A });

    expect(result.passed).toBe(false);
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.every((c) => c.status === 'skipped')).toBe(true);
    expect(result.checks[0]?.detail).toBe(
      'This lab environment has no Docker daemon to check against',
    );
  });
});

// ---------------------------------------------------------- shipped labs

/**
 * Build the state that solves one shipped lab.
 *
 * Deliberately derived from the lab's own requirements rather than hand-written
 * per lab: a lab that adds a requirement gets it exercised here automatically,
 * and there is no fixture to drift out of step with the catalog.
 */
function solve(lab: LoadedLabDefinition): {
  docker: FakeDockerDaemon;
  workspace: { port: InMemoryWorkspace; sessionId: string };
} {
  const docker = new FakeDockerDaemon();
  const port = new InMemoryWorkspace();
  const specs = new Map<string, Parameters<FakeDockerDaemon['addContainer']>[0]>();
  const states = new Map<string, { state: string; exitCode: number; oomKilled?: boolean }>();
  // Files are placed after the containers exist, since the fake needs one to
  // put a file into.
  const containerFiles: Array<{ container: string; path: string; content: string }> = [];

  const specFor = (name: string) => {
    const existing = specs.get(name);
    if (existing) return existing;
    const created = containerSpec({ name, image: 'alpine:3.20' });
    specs.set(name, created);
    states.set(name, { state: 'running', exitCode: 0, oomKilled: false });
    return created;
  };

  for (const requirement of lab.requirements as readonly Requirement[]) {
    switch (requirement.type) {
      case 'docker_container_exists':
      case 'docker_container_running':
        specFor(requirement.name);
        break;
      case 'docker_container_state':
        specFor(requirement.name);
        states.set(requirement.name, {
          ...(states.get(requirement.name) ?? { state: 'running', exitCode: 0, oomKilled: false }),
          state: requirement.expected,
        });
        break;
      case 'docker_container_exit_code':
        specFor(requirement.name);
        states.set(requirement.name, {
          ...(states.get(requirement.name) ?? { state: 'exited', exitCode: 0, oomKilled: false }),
          state: 'exited',
          exitCode: requirement.expected,
        });
        break;
      case 'docker_container_file_content': {
        specFor(requirement.container);
        // `absent` is satisfied by writing nothing at all.
        if (requirement.absent) break;
        const content =
          requirement.equals ?? (requirement.contains ?? ['placeholder']).join('\n');
        containerFiles.push({ container: requirement.container, path: requirement.path, content });
        break;
      }
      case 'docker_container_oom_killed':
        specFor(requirement.name);
        states.set(requirement.name, {
          ...(states.get(requirement.name) ?? { state: 'exited', exitCode: 137, oomKilled: false }),
          oomKilled: requirement.expected,
        });
        break;
      case 'docker_container_image':
        specFor(requirement.name).image = requirement.image;
        break;
      case 'docker_container_env': {
        const spec = specFor(requirement.name);
        spec.env = { ...spec.env, [requirement.key]: requirement.value ?? 'set' };
        break;
      }
      case 'docker_container_port': {
        const spec = specFor(requirement.name);
        spec.ports = [
          ...(spec.ports ?? []),
          {
            containerPort: requirement.container_port,
            protocol: requirement.protocol,
            ...(requirement.host_port !== undefined ? { hostPort: requirement.host_port } : {}),
          },
        ];
        break;
      }
      case 'docker_container_network': {
        specFor(requirement.name).network = requirement.network;
        void docker.createNetwork({ name: requirement.network });
        break;
      }
      case 'docker_container_mount': {
        const spec = specFor(requirement.name);
        spec.volumes = [
          ...(spec.volumes ?? []),
          { volume: requirement.volume, destination: requirement.destination ?? '/data' },
        ];
        void docker.createVolume(requirement.volume);
        break;
      }
      case 'docker_container_resource_limit': {
        const spec = specFor(requirement.name);
        if (requirement.memory) spec.memory = requirement.memory;
        if (requirement.cpus) spec.cpus = requirement.cpus;
        if (requirement.pids_limit) spec.pidsLimit = requirement.pids_limit;
        break;
      }
      case 'docker_image_exists':
        docker.addImage(requirement.image);
        break;
      case 'docker_image_config':
        docker.addImage(requirement.image, {
          ...(requirement.working_dir ? { workingDir: requirement.working_dir } : {}),
          ...(requirement.cmd_contains ? { cmd: [...requirement.cmd_contains] } : {}),
          ...(requirement.env ? { env: { ...requirement.env } } : {}),
          ...(requirement.labels ? { labels: { ...requirement.labels } } : {}),
          ...(requirement.exposed_port ? { exposedPorts: [`${requirement.exposed_port}/tcp`] } : {}),
        });
        break;
      case 'docker_volume_exists':
        void docker.createVolume(requirement.name);
        break;
      case 'docker_network_exists':
        void docker.createNetwork({
          name: requirement.name,
          ...(requirement.driver ? { driver: requirement.driver } : {}),
        });
        break;
      case 'workspace_file_exists':
        port.write(SESSION_A, requirement.path, `${(requirement.contains ?? []).join('\n')}\n`);
        break;
      case 'dockerfile_valid':
        port.write(
          SESSION_A,
          requirement.path,
          [
            `FROM ${requirement.base_image ?? 'alpine:3.20'}`,
            ...requirement.requires
              .filter((instruction) => instruction !== 'FROM')
              .map((instruction) => `${instruction} placeholder`),
          ].join('\n') + '\n',
        );
        break;
      case 'docker_resource_absent':
        // Already absent in a daemon nothing has been added to.
        break;
      default:
        throw new Error(`solve() does not know how to satisfy '${requirement.type}'`);
    }
  }

  for (const [name, spec] of specs) {
    const state = states.get(name) ?? { state: 'running', exitCode: 0, oomKilled: false };
    docker.addContainer(spec, state.state, state.exitCode, state.oomKilled ?? false);
  }
  for (const file of containerFiles) {
    docker.putFile(file.container, file.path, file.content);
  }

  return { docker, workspace: { port, sessionId: SESSION_A } };
}

/** Full definitions for the Docker track, not the catalog's summary projection. */
const dockerLabs = (): LoadedLabDefinition[] =>
  registry.all().filter((lab) => lab.track === 'docker');

describe('docker verifier — every shipped lab', () => {

  it('ships every Docker lab on disk, all on the Docker substrate', async () => {
    // The count comes from the labs directory, not from a number remembered
    // here: adding a lab is a data change, and a test that restated today's
    // curriculum would break every worktree that added one.
    const disk = await scanLabsDirectory();
    expect(dockerLabs()).toHaveLength(disk.labCountForTrack('docker'));
    expect(dockerLabs().map((l) => l.id).sort()).toEqual([...disk.idsForTrack('docker')].sort());
    for (const lab of dockerLabs()) {
      expect(lab.environment.provider).toBe('docker');
      expect(lab.environment.isolation).toBe('container');
    }
  });

  it('fails against an empty daemon', async () => {
    for (const lab of dockerLabs()) {
      const result = await verifyLab({
        lab,
        namespace: SANDBOX_A,
        docker: new FakeDockerDaemon(),
        workspace: { port: new InMemoryWorkspace(), sessionId: SESSION_A },
      });
      expect(result.passed, `${lab.id} must not pass on an empty environment`).toBe(false);
      expect(result.summary).toBe('LAB NOT COMPLETE');
    }
  });

  it('passes against a daemon holding the solution', async () => {
    for (const lab of dockerLabs()) {
      const { docker, workspace } = solve(lab);
      const result = await verifyLab({ lab, namespace: SANDBOX_A, docker, workspace });

      const failing = result.checks.filter((c) => c.status !== 'pass');
      expect(
        failing.map((c) => `${c.label}: ${c.detail ?? ''}`),
        `${lab.id} should pass when solved`,
      ).toEqual([]);
      expect(result.passed).toBe(true);
      expect(result.summary).toBe('LAB PASSED');
    }
  });
});

// -------------------------------------------------------------- isolation

describe('docker verifier — isolation', () => {
  it('never passes using another session\'s Docker state', async () => {
    for (const lab of dockerLabs()) {
      const solved = solve(lab);

      // Session B did the work. Session A is graded against its *own* daemon,
      // which is a different object store entirely — not a filtered view of B's.
      const sessionB = await verifyLab({
        lab,
        namespace: SANDBOX_B,
        docker: solved.docker,
        workspace: solved.workspace,
      });
      const sessionA = await verifyLab({
        lab,
        namespace: SANDBOX_A,
        docker: new FakeDockerDaemon(),
        workspace: { port: new InMemoryWorkspace(), sessionId: 'sess-000000000000000b' },
      });

      expect(sessionB.passed, `${lab.id} should pass for the session that did the work`).toBe(true);
      expect(sessionA.passed, `${lab.id} must not pass for a session that did not`).toBe(false);
    }
  });

  it('exposes no way for a Docker requirement to name a sandbox or a session', () => {
    // Isolation here is structural: the reader is constructed with one daemon
    // and one session id, and no handler can choose another.
    for (const lab of dockerLabs()) {
      for (const requirement of [...lab.requirements, ...lab.setup.verify]) {
        for (const key of ['namespace', 'sandbox', 'session', 'sessionId', 'dockerHost']) {
          expect(Object.keys(requirement)).not.toContain(key);
        }
      }
    }
  });
});

// ----------------------------------------------------------- completeness

describe('docker verifier — registry completeness', () => {
  it('has a handler for every Docker requirement type the schema defines', () => {
    const registered = new Set(registeredRequirementTypes());

    for (const type of DOCKER_REQUIREMENT_TYPES) {
      expect(registered.has(type), `no handler for '${type}'`).toBe(true);
    }
  });

  it('exercises every Docker requirement type across the shipped labs', () => {
    // A vocabulary word nothing uses is either dead or untested; this keeps the
    // schema and the catalog honest with each other.
    const used = new Set<string>();
    for (const lab of dockerLabs()) {
      for (const requirement of [...lab.requirements, ...lab.setup.verify]) used.add(requirement.type);
    }

    expect([...DOCKER_REQUIREMENT_TYPES].filter((type) => !used.has(type))).toEqual([]);
  });
});
