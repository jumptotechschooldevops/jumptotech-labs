/**
 * The isolated lab network capability.
 *
 * The Networking track needed something no lab had needed before: a link, an
 * address, and a neighbour to resolve. `--network none` cannot provide one, and
 * a *shared* bridge would put every student on the same segment — so a session
 * that asks for a network gets its own, and nothing else changes.
 *
 * Two properties are load-bearing and every test here exists to hold one of
 * them down:
 *
 *   1. **Opt-in.** A lab that says nothing keeps `--network none`, exactly as
 *      it did before this capability existed. That is asserted against the real
 *      shipped catalog, not a fixture, so it cannot quietly stop being true.
 *   2. **Session-scoped.** One session, one network, named from that session's
 *      own sandbox reference. A teardown can never name another session's
 *      topology, and Docker's `bridge`, `host` and `none` cannot be named at
 *      all — they do not match the pattern.
 *
 * What a fake cannot show is that `--internal` really blocks egress, or that
 * two bridges really cannot see each other. Those are kernel behaviours and
 * belong to a real daemon; what belongs here is that the provider *asks* for
 * them and that the lifecycle around them is correct.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  CONTAINER_NETWORK_PATTERN,
  LAB_NETWORK_MODES,
  LabDefinitionError,
  LabRegistry,
  LinuxLabProvider,
  MANAGED_CONTAINER_SELECTOR,
  loadLabDefinition,
  networkRefForSandbox,
  parseLabDefinition,
  type LabSessionContext,
  type LoadedLabDefinition,
} from '../src/index.js';
import { FakeContainerRuntime } from './container-fakes.js';
import { LABS_DIR, sessionContext } from './helpers.js';

const SANDBOX_A = 'jtt-lab-000000000001';
const SANDBOX_B = 'jtt-lab-000000000002';
const NETWORK_A = networkRefForSandbox(SANDBOX_A);
const NETWORK_B = networkRefForSandbox(SANDBOX_B);

const LINUX_001 = path.join(LABS_DIR, 'linux', 'linux-001-files', 'lab.yaml');

function contextFor(
  lab: LoadedLabDefinition,
  overrides: { sessionId?: string; sandboxRef?: string } = {},
): LabSessionContext {
  return sessionContext(lab, {
    sessionId: overrides.sessionId ?? 'sess-000000000000000a',
    sandboxRef: overrides.sandboxRef ?? SANDBOX_A,
  });
}

/** A lab that asks for a link, without needing one to exist on disk. */
function networkedLab(overrides: { network?: string; provider?: string } = {}): LoadedLabDefinition {
  const yaml = `
id: NET-902
slug: net-902-probe
title: Network probe
track: networking
topic: layering
difficulty: beginner
duration_minutes: 10
environment:
  provider: ${overrides.provider ?? 'linux'}
${overrides.network === undefined ? '  network: link' : overrides.network === '' ? '' : `  network: ${overrides.network}`}
task:
  summary: s
  description: d
requirements:
  - type: file_exists
    path: /home/student/x
    label: l
references:
  - title: RFC 826
    url: https://www.rfc-editor.org/info/rfc826
skills:
  - net.l2.arp
`;
  return {
    ...parseLabDefinition(yaml),
    directory: '/labs/net-902',
    sourcePath: '/labs/net-902/lab.yaml',
  };
}

// ------------------------------------------------------------ 1. the schema

describe('the network a lab may ask for', () => {
  it('offers exactly two modes, and host networking is not one of them', () => {
    expect([...LAB_NETWORK_MODES]).toEqual(['none', 'link']);
  });

  it('defaults to none when a lab says nothing', () => {
    expect(networkedLab({ network: '' }).environment.network).toBe('none');
  });

  it('accepts an explicit link', () => {
    expect(networkedLab().environment.network).toBe('link');
  });

  it.each([
    ['host networking', 'host'],
    ['the default bridge', 'bridge'],
    ['another session by name', 'jtt-net-000000000002'],
    ['a container namespace', 'container:jtt-lab-000000000002'],
    ['an empty string', '""'],
  ])('refuses %s', (_name, mode) => {
    expect(() => networkedLab({ network: mode })).toThrow(LabDefinitionError);
  });

  it('refuses a link on a provider that creates no container', () => {
    expect(() => networkedLab({ provider: 'kubernetes' })).toThrow(LabDefinitionError);
    expect(() => networkedLab({ provider: 'aws' })).toThrow(LabDefinitionError);
  });
});

// ----------------------------------------------- 2. the default is preserved

describe('labs that never asked for a network are untouched', () => {
  it('every shipped lab still resolves to none', async () => {
    const registry = new LabRegistry(LABS_DIR);
    await registry.load();

    expect(registry.loadErrors).toEqual([]);
    const declared = registry
      .all()
      .map((summary) => registry.get(summary.id))
      .filter((lab) => lab.environment.network !== 'none')
      .map((lab) => `${lab.id}:${lab.environment.network}`);

    // Only the Networking track may appear here, and only ever asking for
    // `link`. Every other track's boundary is unchanged by this capability,
    // and no lab anywhere can obtain a mode outside the vocabulary.
    for (const entry of declared) expect(entry).toMatch(/^NET-\d{3}:link$/);
  });

  it('creates a Linux lab on --network none and touches no network at all', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });

    const result = await provider.create(contextFor(lab));

    expect(result.ok).toBe(true);
    expect(runtime.created.at(-1)!.network).toBe('none');
    expect(runtime.networksCreated).toEqual([]);
    expect(runtime.networks.size).toBe(0);
  });

  it('destroys a network-free lab without naming a network', async () => {
    const lab = await loadLabDefinition(LINUX_001);
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const context = contextFor(lab);

    await provider.create(context);
    const result = await provider.destroy(context);

    expect(result.ok).toBe(true);
    // Teardown still reclaims a network if one were somehow left behind, but
    // with nothing to remove it must not report having removed anything.
    expect(runtime.networksRemoved).toEqual([]);
  });
});

// -------------------------------------------------------- 3. the lifecycle

describe('a lab that asks for a link gets its own network', () => {
  it('creates the network before the container, and joins the container to it', async () => {
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const context = contextFor(networkedLab());

    const result = await provider.create(context);

    expect(result.ok).toBe(true);
    expect(runtime.networksCreated.map((n) => n.name)).toEqual([NETWORK_A]);
    expect(runtime.created.at(-1)!.network).toBe(NETWORK_A);
    // The name is derived, never supplied.
    expect(NETWORK_A).toMatch(CONTAINER_NETWORK_PATTERN);
  });

  it('labels the network with its owner, exactly as the container is', async () => {
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const context = contextFor(networkedLab());

    await provider.create(context);

    const network = runtime.networks.get(NETWORK_A)!;
    expect(network.labels['jumptotech.io/managed']).toBe('true');
    expect(network.labels['jumptotech.io/session-id']).toBe(context.sessionId);
    expect(network.labels['jumptotech.io/lab-id']).toBe(context.labId);
    expect(network.labels['jumptotech.io/provider']).toBe('linux');
  });

  it('is re-entrant: a retried start does not fail on an existing network', async () => {
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const context = contextFor(networkedLab());

    await provider.create(context);
    const second = await provider.create(context);

    expect(second.ok).toBe(true);
    expect(runtime.networks.size).toBe(1);
  });

  it('removes the network when the sandbox is destroyed', async () => {
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const context = contextFor(networkedLab());

    await provider.create(context);
    const result = await provider.destroy(context);

    expect(result.ok).toBe(true);
    expect(runtime.networksRemoved).toEqual([NETWORK_A]);
    expect(runtime.networks.size).toBe(0);
  });

  it('removes the network after the container, never before', async () => {
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const context = contextFor(networkedLab());
    await provider.create(context);

    const order: string[] = [];
    const realRemove = runtime.remove.bind(runtime);
    const realNetworkRemove = runtime.networkRemove.bind(runtime);
    runtime.remove = async (name: string) => {
      order.push(`container:${name}`);
      return realRemove(name);
    };
    runtime.networkRemove = async (name: string) => {
      order.push(`network:${name}`);
      return realNetworkRemove(name);
    };

    await provider.destroy(context);

    // Docker refuses to remove a network still in use, so the order matters.
    expect(order).toEqual([`container:${SANDBOX_A}`, `network:${NETWORK_A}`]);
  });

  it('reclaims the network when the container could not be created', async () => {
    const runtime = new FakeContainerRuntime({ images: [] });
    const provider = new LinuxLabProvider({ runtime });

    const result = await provider.create(contextFor(networkedLab()));

    expect(result.ok).toBe(false);
    // The partial resource is taken back rather than left on a shared daemon.
    expect(runtime.networksRemoved).toEqual([NETWORK_A]);
    expect(runtime.networks.size).toBe(0);
  });

  it('restores the topology on reset, deterministically', async () => {
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const context = contextFor(networkedLab());
    await provider.create(context);

    const result = await provider.reset(context);

    expect(result.ok).toBe(true);
    // Same network name, still exactly one, and the fresh container is on it.
    expect(runtime.networks.size).toBe(1);
    expect(runtime.networks.has(NETWORK_A)).toBe(true);
    expect(runtime.created.at(-1)!.network).toBe(NETWORK_A);
  });

  it('is idempotent: destroying twice is safe', async () => {
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const context = contextFor(networkedLab());
    await provider.create(context);

    const first = await provider.destroy(context);
    const second = await provider.destroy(context);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(runtime.networks.size).toBe(0);
  });

  it('reclaims a network whose container has already gone', async () => {
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const context = contextFor(networkedLab());
    await provider.create(context);

    // Someone removed the container by hand; the network is now an orphan.
    await runtime.remove(SANDBOX_A);

    const sandboxes = await provider.listManagedSandboxes();
    expect(sandboxes.map((s) => s.sandboxRef)).toContain(SANDBOX_A);

    await provider.destroySandbox(SANDBOX_A, context.sessionId);
    expect(runtime.networks.size).toBe(0);
  });
});

// ------------------------------------------------------------ 4. ownership

describe('a network is only ever deleted when it is provably ours', () => {
  it('leaves a network this platform does not manage alone', async () => {
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    // Same name shape, but no managed label — not ours.
    runtime.addNetwork(NETWORK_A, { 'jumptotech.io/session-id': 'sess-000000000000000a' });

    await provider.destroySandbox(SANDBOX_A, 'sess-000000000000000a');

    expect(runtime.networksRemoved).toEqual([]);
    expect(runtime.networks.has(NETWORK_A)).toBe(true);
  });

  it("leaves another session's network alone", async () => {
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    runtime.addNetwork(NETWORK_A, {
      'jumptotech.io/managed': 'true',
      'jumptotech.io/session-id': 'sess-000000000000000b',
    });

    await provider.destroySandbox(SANDBOX_A, 'sess-000000000000000a');

    expect(runtime.networksRemoved).toEqual([]);
    expect(runtime.networks.has(NETWORK_A)).toBe(true);
  });

  it.each(['bridge', 'host', 'none', 'jumptotech-sandboxes', '../../etc', 'net;rm -rf /'])(
    'cannot be talked into naming %s',
    async (hostile) => {
      const runtime = new FakeContainerRuntime();
      runtime.addNetwork(NETWORK_A, { 'jumptotech.io/managed': 'true' });

      // Neither the derivation nor the runtime will accept it.
      expect(() => networkRefForSandbox(hostile)).toThrow();
      await expect(runtime.networkRemove(hostile)).rejects.toThrow();
      expect(CONTAINER_NETWORK_PATTERN.test(hostile)).toBe(false);
    },
  );
});

// ------------------------------------------------------------ 5. isolation

describe('two sessions never share a topology', () => {
  it('gives each session its own network', async () => {
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const lab = networkedLab();

    await provider.create(contextFor(lab, { sessionId: 'sess-000000000000000a', sandboxRef: SANDBOX_A }));
    await provider.create(contextFor(lab, { sessionId: 'sess-000000000000000b', sandboxRef: SANDBOX_B }));

    expect(NETWORK_A).not.toBe(NETWORK_B);
    expect([...runtime.networks.keys()].sort()).toEqual([NETWORK_A, NETWORK_B].sort());
    const specs = runtime.created.map((c) => c.network);
    expect(specs).toContain(NETWORK_A);
    expect(specs).toContain(NETWORK_B);
  });

  it('ending one session leaves the other topology intact', async () => {
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const lab = networkedLab();
    const a = contextFor(lab, { sessionId: 'sess-000000000000000a', sandboxRef: SANDBOX_A });
    const b = contextFor(lab, { sessionId: 'sess-000000000000000b', sandboxRef: SANDBOX_B });
    await provider.create(a);
    await provider.create(b);

    await provider.destroy(a);

    expect(runtime.networks.has(NETWORK_A)).toBe(false);
    expect(runtime.networks.has(NETWORK_B)).toBe(true);
    expect(runtime.containers.has(SANDBOX_B)).toBe(true);
  });

  it('resetting one session leaves the other topology intact', async () => {
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const lab = networkedLab();
    const a = contextFor(lab, { sessionId: 'sess-000000000000000a', sandboxRef: SANDBOX_A });
    const b = contextFor(lab, { sessionId: 'sess-000000000000000b', sandboxRef: SANDBOX_B });
    await provider.create(a);
    await provider.create(b);

    await provider.reset(a);

    expect(runtime.networks.has(NETWORK_B)).toBe(true);
    expect(runtime.containers.has(SANDBOX_B)).toBe(true);
  });

  it('reaping one session leaves the other topology intact', async () => {
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const lab = networkedLab();
    const a = contextFor(lab, { sessionId: 'sess-000000000000000a', sandboxRef: SANDBOX_A });
    const b = contextFor(lab, { sessionId: 'sess-000000000000000b', sandboxRef: SANDBOX_B });
    await provider.create(a);
    await provider.create(b);

    // What the reaper does: enumerate, then destroy one by its own reference.
    const managed = await provider.listManagedSandboxes();
    expect(managed.map((s) => s.sandboxRef).sort()).toEqual([SANDBOX_A, SANDBOX_B].sort());
    await provider.destroySandbox(SANDBOX_A, 'sess-000000000000000a');

    expect(runtime.networks.has(NETWORK_A)).toBe(false);
    expect(runtime.networks.has(NETWORK_B)).toBe(true);
  });

  it('lists lab networks only through the managed selector', async () => {
    const runtime = new FakeContainerRuntime();
    runtime.addNetwork(NETWORK_A, { 'jumptotech.io/managed': 'true' });
    runtime.addNetwork(NETWORK_B, {});

    const managed = await runtime.networkList(MANAGED_CONTAINER_SELECTOR);

    expect(managed.map((n) => n.name)).toEqual([NETWORK_A]);
  });
});
