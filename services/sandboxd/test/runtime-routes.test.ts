/**
 * The runtime control plane's ownership rules.
 *
 * `attach.test.ts` covers the student's path. This covers the API's: what the
 * broker will and will not do on behalf of a caller that has the internal
 * secret. The interesting cases are all the same shape — a caller asking about
 * something on the runtime that is not this deployment's — because that is the
 * failure that matters when several stacks share one daemon, and the one the
 * reaper could otherwise turn into deleting somebody else's work.
 */
import { describe, expect, it } from 'vitest';
import {
  MANAGED_CONTAINER_LABEL,
  RUNTIME_OWNER_LABEL,
  CONTAINER_SESSION_LABEL,
  type ContainerInfo,
  type ContainerRuntimePort,
  type NetworkInfo,
} from '@jumptotech/lab-orchestrator';
import { RuntimeRequestError, runRuntimeOperation } from '../src/runtime-routes.js';

const OWNER = 'jumptotech';
const OTHER = 'another-worktree';

function container(name: string, owner: string | null): ContainerInfo {
  return {
    name,
    id: `id-${name}`,
    state: 'running',
    image: 'jumptotech/lab-linux:latest',
    labels: {
      ...(owner === null ? {} : { [MANAGED_CONTAINER_LABEL]: 'true', [RUNTIME_OWNER_LABEL]: owner }),
      [CONTAINER_SESSION_LABEL]: 'sess-aaaaaaaaaaaaaaaa',
    },
  };
}

/** A runtime that records what it was actually asked to do. */
function fakeRuntime(inventory: Record<string, ContainerInfo>, networks: Record<string, NetworkInfo> = {}) {
  const calls: Array<{ op: string; arg: unknown }> = [];
  const runtime: ContainerRuntimePort = {
    name: 'fake',
    ping: async () => '27.0.0',
    imageExists: async () => true,
    create: async (spec) => {
      calls.push({ op: 'create', arg: spec });
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
      calls.push({ op: 'remove', arg: name });
      delete inventory[name];
    },
    exec: async (name, request) => {
      calls.push({ op: 'exec', arg: { name, request } });
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    },
    networkCreate: async (spec) => {
      calls.push({ op: 'networkCreate', arg: spec });
      networks[spec.name] = { name: spec.name, id: `id-${spec.name}`, labels: spec.labels };
    },
    networkInspect: async (name) => networks[name] ?? null,
    networkRemove: async (name) => {
      calls.push({ op: 'networkRemove', arg: name });
      delete networks[name];
    },
    networkList: async () => Object.values(networks),
  };
  return { runtime, calls, inventory, networks };
}

const run = (op: string, payload: Record<string, unknown>, runtime: ContainerRuntimePort) =>
  runRuntimeOperation(op, payload, { runtime, runtimeOwner: OWNER });

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

describe('the operation list is closed', () => {
  it('refuses anything that is not one of the eleven verbs', async () => {
    const { runtime } = fakeRuntime({});
    for (const op of ['build', 'pull', 'run', 'cp', 'commit', 'login', '', 'PING', '__proto__']) {
      await expect(run(op, {}, runtime)).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' });
    }
  });
});

describe('ownership is stamped on creation, not trusted', () => {
  it('applies this broker’s owner label whatever the caller sent', async () => {
    const fake = fakeRuntime({});
    await run('create', { spec: { ...SPEC, labels: { [RUNTIME_OWNER_LABEL]: OTHER } } }, fake.runtime);

    const created = fake.calls.find((c) => c.op === 'create')!.arg as { labels: Record<string, string> };
    expect(created.labels[RUNTIME_OWNER_LABEL]).toBe(OWNER);
    expect(created.labels[MANAGED_CONTAINER_LABEL]).toBe('true');
  });

  it('stamps a lab network the same way', async () => {
    const fake = fakeRuntime({});
    await run(
      'networkCreate',
      { spec: { name: 'jtt-net-aabbccdd1122', labels: { [RUNTIME_OWNER_LABEL]: OTHER } } },
      fake.runtime,
    );
    const spec = fake.calls.find((c) => c.op === 'networkCreate')!.arg as { labels: Record<string, string> };
    expect(spec.labels[RUNTIME_OWNER_LABEL]).toBe(OWNER);
  });

  it('refuses a network name that is not a lab network', async () => {
    const fake = fakeRuntime({});
    for (const name of ['bridge', 'host', 'none', 'kind', 'jumptotech-sandboxes']) {
      await expect(run('networkCreate', { spec: { name } }, fake.runtime)).rejects.toBeInstanceOf(
        RuntimeRequestError,
      );
    }
    expect(fake.calls).toEqual([]);
  });
});

describe('nothing belonging to another deployment can be touched', () => {
  const foreign = 'jtt-lab-ffffffffffff';

  it('reports a foreign container as absent rather than confirming it exists', async () => {
    const fake = fakeRuntime({ [foreign]: container(foreign, OTHER) });
    await expect(run('inspect', { name: foreign }, fake.runtime)).resolves.toEqual({ container: null });
  });

  it('refuses to remove a foreign container, and does not call the runtime', async () => {
    const fake = fakeRuntime({ [foreign]: container(foreign, OTHER) });
    await expect(run('remove', { name: foreign }, fake.runtime)).rejects.toMatchObject({
      code: 'SANDBOX_NOT_OWNED',
    });
    expect(fake.calls).toEqual([]);
    expect(fake.inventory[foreign]).toBeDefined();
  });

  it('refuses to remove an unlabelled lookalike created by hand', async () => {
    const fake = fakeRuntime({ [foreign]: container(foreign, null) });
    await expect(run('remove', { name: foreign }, fake.runtime)).rejects.toMatchObject({
      code: 'SANDBOX_NOT_OWNED',
    });
    expect(fake.calls).toEqual([]);
  });

  it('refuses to exec into a foreign container', async () => {
    const fake = fakeRuntime({ [foreign]: container(foreign, OTHER) });
    await expect(
      run('exec', { name: foreign, request: { argv: ['id'] } }, fake.runtime),
    ).rejects.toMatchObject({ code: 'SANDBOX_NOT_FOUND' });
    expect(fake.calls).toEqual([]);
  });

  it('hides foreign containers from a listing, so a reaper cannot see them', async () => {
    const mine = 'jtt-lab-111111111111';
    const fake = fakeRuntime({
      [mine]: container(mine, OWNER),
      [foreign]: container(foreign, OTHER),
    });

    const result = (await run('list', {}, fake.runtime)) as { containers: ContainerInfo[] };
    expect(result.containers.map((c) => c.name)).toEqual([mine]);
  });

  it('refuses to remove a foreign lab network', async () => {
    const net = 'jtt-net-ffffffffffff';
    const fake = fakeRuntime({}, { [net]: { name: net, id: 'x', labels: { [RUNTIME_OWNER_LABEL]: OTHER } } });
    await expect(run('networkRemove', { name: net }, fake.runtime)).rejects.toMatchObject({
      code: 'NETWORK_NOT_OWNED',
    });
    expect(fake.calls).toEqual([]);
  });
});

describe('teardown stays re-entrant', () => {
  it('treats removing something already gone as success', async () => {
    const fake = fakeRuntime({});
    await expect(run('remove', { name: 'jtt-lab-aabbccdd1122' }, fake.runtime)).resolves.toEqual({
      removed: false,
    });
    await expect(run('networkRemove', { name: 'jtt-net-aabbccdd1122' }, fake.runtime)).resolves.toEqual({
      removed: false,
    });
  });

  it('removes a container this broker does own', async () => {
    const mine = 'jtt-lab-111111111111';
    const fake = fakeRuntime({ [mine]: container(mine, OWNER) });
    await expect(run('remove', { name: mine }, fake.runtime)).resolves.toEqual({ removed: true });
    expect(fake.inventory[mine]).toBeUndefined();
  });
});
