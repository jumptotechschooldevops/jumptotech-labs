/**
 * `BrokerDockerEngines` against a real `sandboxd`, over real HTTP.
 *
 * `docker-ops.test.ts` proves what the broker refuses. This proves the other
 * half of the boundary — that the *client* the API holds cannot express the
 * things the broker would have to refuse, and that a broker outage fails closed
 * rather than falling back to a local daemon.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  BrokerDockerEngines,
  COMPONENT_LABEL,
  CONTAINER_SANDBOX_PREFIX,
  DockerUnreachableError,
  EXPIRES_AT_LABEL,
  LAB_LABEL,
  MANAGED_LABEL,
  PROVIDER_LABEL,
  RUNTIME_OWNER_LABEL,
  SESSION_LABEL,
  deriveSandboxRef,
  type DockerContainerSnapshot,
  type DockerEngineFactory,
  type DockerEnginePort,
  type DockerSandboxPolicy,
  type RunContainerSpec,
} from '@jumptotech/lab-orchestrator';
import type { SandboxdConfig } from '../src/config.js';
import { DockerOps, SANDBOX_COMPONENT } from '../src/docker-ops.js';
import { createSandboxd } from '../src/server.js';

const SECRET = 'internal-secret-for-broker-docker-tests';
const DERIVATION = 'derivation-secret-for-broker-docker-tests';
const OWNER = 'jumptotech';
const SESSION_A = 'sess-aaaaaaaaaaaaaaaa';
const SESSION_B = 'sess-bbbbbbbbbbbbbbbb';

const POLICY: DockerSandboxPolicy = {
  image: 'docker:27-dind',
  privileged: true,
  memory: '2g',
  cpus: '2',
  pidsLimit: 512,
  maxContainers: 10,
  network: 'jumptotech-sandboxes',
  daemonPort: 2376,
  readyTimeoutSeconds: 180,
  restartAttempts: 5,
};

const config: SandboxdConfig = {
  port: 0,
  bindAddress: '127.0.0.1',
  scopeSecrets: { attach: SECRET + '-attach', runtime: SECRET + '-runtime', docker: SECRET + '-docker' },
  derivationSecret: DERIVATION,
  runtimeOwner: OWNER,
  containerBinary: 'docker',
  shell: '/bin/bash',
  docker: POLICY,
  sandboxUser: 'student',
  sandboxHome: '/home/student',
  maxSessions: 4,
  idleTimeoutMs: 60_000,
  maxSessionMs: 120_000,
};

const refFor = (sessionId: string): string =>
  deriveSandboxRef({ sessionId, secret: DERIVATION, prefix: CONTAINER_SANDBOX_PREFIX });

function snapshot(sessionId: string): DockerContainerSnapshot {
  const name = refFor(sessionId);
  return {
    id: `id-${name}`,
    name,
    image: 'docker:27-dind',
    imageId: 'sha256:abc',
    state: 'running',
    running: true,
    exitCode: 0,
    oomKilled: false,
    labels: {
      [MANAGED_LABEL]: 'true',
      [RUNTIME_OWNER_LABEL]: OWNER,
      [COMPONENT_LABEL]: SANDBOX_COMPONENT,
      [PROVIDER_LABEL]: 'docker',
      [SESSION_LABEL]: sessionId,
      [LAB_LABEL]: 'DOCKER-001',
    },
  } as unknown as DockerContainerSnapshot;
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function fakeEngines(containers: Record<string, DockerContainerSnapshot>) {
  const sessionReads: Array<{ sandbox: string; op: string }> = [];
  let spec: RunContainerSpec | undefined;
  const engines: DockerEngineFactory = {
    host: {
      version: async () => ({ serverVersion: '27.0.0' }),
      inspectContainer: async (n: string) => containers[n] ?? null,
      listContainers: async () =>
        Object.values(containers).map((c) => ({ name: c.name, labels: c.labels })),
      runContainer: async (s: RunContainerSpec) => {
        spec = s;
        containers[s.name] = snapshot(s.labels?.[SESSION_LABEL] ?? '');
        return s.name;
      },
      removeContainer: async (n: string) => {
        delete containers[n];
      },
      createVolume: async () => undefined,
      removeVolume: async () => undefined,
      createNetwork: async () => undefined,
      execInContainer: async () => ({
        exitCode: 0,
        stdout: 'CERT\n',
        stderr: '',
        timedOut: false,
      }),
    } as unknown as DockerEnginePort,
    session(sandbox: string) {
      return {
        version: async () => {
          sessionReads.push({ sandbox, op: 'version' });
          return { serverVersion: '27.0.0' };
        },
        inspectContainer: async () => {
          sessionReads.push({ sandbox, op: 'inspectContainer' });
          return null;
        },
        inspectImage: async () => {
          sessionReads.push({ sandbox, op: 'inspectImage' });
          return null;
        },
        copyFileFromContainer: async () => {
          sessionReads.push({ sandbox, op: 'copyFile' });
          return null;
        },
      } as unknown as DockerEnginePort;
    },
  };
  return { engines, sessionReads, containers, spec: () => spec };
}

async function connected(seed: Record<string, DockerContainerSnapshot> = {}) {
  const fake = fakeEngines(seed);
  const server = createSandboxd({
    config,
    inspector: { inspect: async () => null },
    docker: new DockerOps({
      engines: fake.engines,
      derivationSecret: DERIVATION,
      runtimeOwner: OWNER,
      policy: POLICY,
    }),
    log: () => undefined,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    ...fake,
    port,
    engines_: new BrokerDockerEngines({ baseUrl: `http://127.0.0.1:${port}`, secret: SECRET + '-docker' }),
  };
}

function sandboxSpec(sessionId: string): RunContainerSpec {
  return {
    name: 'ignored-by-the-broker',
    image: 'ignored',
    detach: true,
    labels: {
      [SESSION_LABEL]: sessionId,
      [LAB_LABEL]: 'DOCKER-001',
      [EXPIRES_AT_LABEL]: String(Date.now() + 3_600_000),
    },
  };
}

describe('the API drives Docker with no daemon of its own', () => {
  it('creates a sandbox, reads its certificates, and destroys it', async () => {
    const h = await connected();

    const ref = await h.engines_.host.runContainer(sandboxSpec(SESSION_A));
    expect(ref).toBe(refFor(SESSION_A));
    // The broker built the spec; nothing the caller sent shaped it.
    expect(h.spec()!.image).toBe(POLICY.image);
    expect(h.spec()!.privileged).toBe(true);

    const cert = await h.engines_.host.execInContainer(ref, ['cat', '/certs/client/ca.pem']);
    expect(cert.stdout).toContain('CERT');

    await h.engines_.host.removeContainer(ref);
    expect(h.containers[ref]).toBeUndefined();
  });

  it('reads a session daemon only through the session it was told', async () => {
    const h = await connected({
      [refFor(SESSION_A)]: snapshot(SESSION_A),
      [refFor(SESSION_B)]: snapshot(SESSION_B),
    });

    await h.engines_.session(refFor(SESSION_A), SESSION_A).version();
    await h.engines_.session(refFor(SESSION_B), SESSION_B).inspectImage('nginx');

    expect(h.sessionReads).toEqual([
      { sandbox: refFor(SESSION_A), op: 'version' },
      { sandbox: refFor(SESSION_B), op: 'inspectImage' },
    ]);
  });

  it('refuses to build a session engine for a sandbox it has no session for', () => {
    // The path an arbitrary container name would have to travel. It stops in
    // the client, before any request is made.
    return connected().then((h) => {
      expect(() => h.engines_.session('jtt-lab-ffffffffffff')).toThrow(/no session is bound/i);
      expect(() => h.engines_.session('some-other-container')).toThrow();
    });
  });

  it('refuses every Docker operation the broker does not offer', async () => {
    const h = await connected({ [refFor(SESSION_A)]: snapshot(SESSION_A) });
    const host = h.engines_.host;

    // `removeVolume` is deliberately absent from this list: it is a no-op
    // rather than a refusal, because `removeSandbox` already removed the
    // session's named data volume. See the method's comment.
    await expect(host.removeVolume('x')).resolves.toBeUndefined();

    for (const call of [
      () => host.pullImage('alpine'),
      () => host.removeImage('alpine'),
      () => host.startContainer('x'),
      () => host.stopContainer('x'),
      () => host.containerLogs('x'),
      () => host.listImages(),
      () => host.listVolumes(),
      () => host.removeNetwork('x'),
      () => host.listNetworks(),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(DockerUnreachableError);
    }

    /*
     * A session daemon is wider on purpose — the platform seeds and resets a
     * lab's declared state there. Two things stay refused even so, because
     * nothing needs them and each is a capability worth not having.
     */
    const session = h.engines_.session(refFor(SESSION_A), SESSION_A);
    for (const call of [
      () => session.execInContainer('x', ['id']),
      () => session.startContainer('x'),
      () => session.containerLogs('x'),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(DockerUnreachableError);
    }
  });

  it('refuses an arbitrary argv dressed up as a certificate read', async () => {
    const h = await connected({ [refFor(SESSION_A)]: snapshot(SESSION_A) });
    await h.engines_.host.runContainer(sandboxSpec(SESSION_A));

    for (const argv of [
      ['sh', '-c', 'id'],
      ['cat', '/etc/shadow'],
      ['cat', '/certs/client/../../etc/passwd'],
      ['cat', '/certs/server/key.pem'],
    ]) {
      await expect(
        h.engines_.host.execInContainer(refFor(SESSION_A), argv),
      ).rejects.toBeInstanceOf(DockerUnreachableError);
    }
  });
});

describe('a broker outage fails closed', () => {
  it('reports the environment unreachable rather than falling back', async () => {
    const engines = new BrokerDockerEngines({
      baseUrl: 'http://127.0.0.1:1',
      secret: SECRET + '-docker',
      timeoutMs: 2_000,
    });

    await expect(engines.host.version()).rejects.toBeInstanceOf(DockerUnreachableError);
    await expect(engines.host.runContainer(sandboxSpec(SESSION_A))).rejects.toBeInstanceOf(
      DockerUnreachableError,
    );
    await expect(
      engines.session('jtt-lab-aabbccddeeff', SESSION_A).version(),
    ).rejects.toBeInstanceOf(DockerUnreachableError);
  });

  it('is refused without the internal secret', async () => {
    const h = await connected();
    const wrong = new BrokerDockerEngines({
      baseUrl: `http://127.0.0.1:${h.port}`,
      secret: 'not-the-secret',
    });
    await expect(wrong.host.version()).rejects.toThrow(/does not carry the 'docker' capability/);
  });

  it('answers 503 when the broker runs with the Docker track off', async () => {
    const server = createSandboxd({
      config: { ...config, docker: null },
      inspector: { inspect: async () => null },
      log: () => undefined,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const engines = new BrokerDockerEngines({ baseUrl: `http://127.0.0.1:${port}`, secret: SECRET + '-docker' });
    await expect(engines.host.version()).rejects.toThrow(/Docker track switched off/);
  });
});
