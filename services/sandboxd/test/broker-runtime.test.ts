/**
 * `BrokerRuntime` against a real `sandboxd`, over real HTTP.
 *
 * The point is the round trip. Provider code holds a `ContainerRuntimePort` and
 * cannot tell whether it is a local daemon or a service one hop away — so the
 * thing worth proving is that the remote one behaves like the local one for the
 * calls providers actually make, and that its refusals arrive as refusals
 * rather than as a silently empty result.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  BrokerRuntime,
  ContainerRuntimeError,
  MANAGED_CONTAINER_LABEL,
  RUNTIME_OWNER_LABEL,
  CONTAINER_SESSION_LABEL,
  type ContainerInfo,
  type ContainerRuntimePort,
} from '@jumptotech/lab-orchestrator';
import type { SandboxdConfig } from '../src/config.js';
import { createSandboxd } from '../src/server.js';

const SECRET = 'internal-service-secret-for-tests';
const OWNER = 'jumptotech';

const config: SandboxdConfig = {
  port: 0,
  bindAddress: '127.0.0.1',
  internalServiceSecret: SECRET,
  derivationSecret: 'derivation-secret-for-tests',
  runtimeOwner: OWNER,
  containerBinary: 'docker',
  shell: '/bin/bash',
  docker: null,
  sandboxUser: 'student',
  sandboxHome: '/home/student',
  maxSessions: 4,
  idleTimeoutMs: 60_000,
  maxSessionMs: 120_000,
};

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function inMemoryRuntime(seed: Record<string, ContainerInfo> = {}) {
  const inventory = { ...seed };
  const runtime: ContainerRuntimePort = {
    name: 'fake',
    ping: async () => '27.0.0',
    imageExists: async (image) => image === 'jumptotech/lab-linux:latest',
    create: async (spec) => {
      const info: ContainerInfo = {
        name: spec.name,
        id: `id-${spec.name}`,
        state: 'running',
        image: spec.image,
        labels: spec.labels,
      };
      inventory[spec.name] = info;
      return info;
    },
    inspect: async (name) => inventory[name] ?? null,
    list: async () => Object.values(inventory),
    remove: async (name) => {
      delete inventory[name];
    },
    exec: async () => ({ exitCode: 0, stdout: 'student\n', stderr: '', timedOut: false }),
    networkCreate: async () => undefined,
    networkInspect: async () => null,
    networkRemove: async () => undefined,
    networkList: async () => [],
  };
  return { runtime, inventory };
}

async function connected(seed: Record<string, ContainerInfo> = {}) {
  const fake = inMemoryRuntime(seed);
  const server = createSandboxd({
    config,
    inspector: { inspect: async () => null },
    runtime: fake.runtime,
    log: () => undefined,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    ...fake,
    port,
    client: new BrokerRuntime({ baseUrl: `http://127.0.0.1:${port}`, secret: SECRET }),
  };
}

const SPEC = {
  name: 'jtt-lab-aabbccdd1122',
  image: 'jumptotech/lab-linux:latest',
  labels: { [CONTAINER_SESSION_LABEL]: 'sess-aaaaaaaaaaaaaaaa' },
  user: 'student',
  workdir: '/home/student',
  cpus: '0.5',
  memory: '512m',
  pidsLimit: 128,
  network: 'none',
  hostname: 'lab',
  command: ['sleep', 'infinity'],
};

describe('BrokerRuntime round trip', () => {
  it('creates, inspects, execs and removes a sandbox with no local daemon', async () => {
    const { client, inventory } = await connected();

    const created = await client.create(SPEC);
    expect(created.name).toBe(SPEC.name);
    // Stamped by the broker, not by the caller.
    expect(created.labels[RUNTIME_OWNER_LABEL]).toBe(OWNER);
    expect(created.labels[MANAGED_CONTAINER_LABEL]).toBe('true');

    expect(await client.inspect(SPEC.name)).toMatchObject({ name: SPEC.name, state: 'running' });
    expect((await client.exec(SPEC.name, { argv: ['id', '-un'] })).stdout).toBe('student\n');
    expect(await client.imageExists('jumptotech/lab-linux:latest')).toBe(true);
    expect(await client.ping()).toBe('27.0.0');

    await client.remove(SPEC.name);
    expect(inventory[SPEC.name]).toBeUndefined();
    expect(await client.inspect(SPEC.name)).toBeNull();
  });

  it('surfaces a refusal as an error rather than an empty result', async () => {
    const foreign = 'jtt-lab-ffffffffffff';
    const { client } = await connected({
      [foreign]: {
        name: foreign,
        id: 'x',
        state: 'running',
        image: 'busybox',
        labels: { [MANAGED_CONTAINER_LABEL]: 'true', [RUNTIME_OWNER_LABEL]: 'another-worktree' },
      },
    });

    await expect(client.remove(foreign)).rejects.toBeInstanceOf(ContainerRuntimeError);
  });

  it('is refused without the internal secret', async () => {
    const { port } = await connected();
    const wrong = new BrokerRuntime({ baseUrl: `http://127.0.0.1:${port}`, secret: 'nope' });
    await expect(wrong.ping()).rejects.toThrow(/internal service secret/);
  });

  it('reports an unreachable broker as a runtime error, not a hang', async () => {
    const client = new BrokerRuntime({
      baseUrl: 'http://127.0.0.1:1',
      secret: SECRET,
      timeoutMs: 2_000,
    });
    await expect(client.ping()).rejects.toThrow(/unreachable/);
  });
});
