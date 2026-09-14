/**
 * BETA-P0-008 — runtime ownership reaches Kubernetes namespaces.
 *
 * The container and Docker providers have stamped and filtered on
 * `jumptotech.io/runtime-owner` since PLATFORM-007. The kind provider never
 * did: it created namespaces with no owner and its orphan sweep listed every
 * managed `lab-*` namespace in the cluster. Every worktree and CI job on a
 * machine shares one kind cluster, so one runtime's reaper reclaimed another's
 * expired namespaces — the exact failure the label exists to prevent.
 *
 * Each test here asserts on what *survived* in the cluster, not only on what a
 * call returned.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SESSION_POLICY,
  EXPIRES_AT_LABEL,
  InMemorySessionStore,
  KindLabProvider,
  LAB_LABEL,
  MANAGED_LABEL,
  RUNTIME_OWNER_LABEL,
  SESSION_LABEL,
  SessionManager,
  SessionReaper,
  type LoadedLabDefinition,
} from '../src/index.js';
import { FakeKubernetes, fakeExec } from './fakes.js';
import { loadK8s001, sessionContext } from './helpers.js';
import { realCatalog } from './real-catalog.js';

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

const OWNER_A = 'wt-alpha';
const OWNER_B = 'wt-bravo';
const NS_A = 'lab-aaaaaaaaaaaa';
const NS_B = 'lab-bbbbbbbbbbbb';
const NS_LEGACY = 'lab-cccccccccccc';
const SESSION_A = 'sess-00000000000000aa';
const SESSION_B = 'sess-00000000000000bb';
const SESSION_LEGACY = 'sess-00000000000000cc';

let lab: LoadedLabDefinition;

beforeAll(async () => {
  lab = await loadK8s001();
});

function makeProvider(k8s: FakeKubernetes, runtimeOwner: string) {
  const provider = new KindLabProvider({
    k8s,
    clusterName: 'jumptotech-labs',
    exec: fakeExec(),
    runtimeOwner,
    resetDrainTimeoutMs: 2_000,
    destroyTimeoutMs: 2_000,
    now: () => NOW,
    sleep: async () => undefined,
  });
  vi.spyOn(provider, 'execute').mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.34.2' } }),
    stderr: '',
    timedOut: false,
  });
  return provider;
}

/** Namespace labels as a runtime's own provider would have written them. */
function namespaceLabels(sessionId: string, expiresAtMs: number, owner?: string) {
  return {
    [MANAGED_LABEL]: 'true',
    [SESSION_LABEL]: sessionId,
    [LAB_LABEL]: 'K8S-001',
    [EXPIRES_AT_LABEL]: String(expiresAtMs),
    ...(owner === undefined ? {} : { [RUNTIME_OWNER_LABEL]: owner }),
  };
}

async function reaperFor(k8s: FakeKubernetes, runtimeOwner: string) {
  const provider = makeProvider(k8s, runtimeOwner);
  const sessions = new SessionManager({
    registry: await realCatalog(),
    provider,
    store: new InMemorySessionStore(),
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: {
      maxSessionSeconds: 3_600,
      idleTimeoutSeconds: 1_200,
      warningSeconds: 300,
      maxActiveSessions: 20,
    },
    namespaceSecret: 'kind-runtime-owner-tests',
    now: () => NOW,
  });
  const orphanCounts: Array<Record<string, number>> = [];
  const reaper = new SessionReaper({
    sessions,
    provider,
    intervalMs: 60_000,
    now: () => NOW,
    metrics: { onSweep: (event) => orphanCounts.push(event.orphansByProvider) },
  });
  return { provider, reaper, orphanCounts };
}

const namespaces = async (k8s: FakeKubernetes) =>
  (await k8s.listNamespaces()).map((ns) => ns.name).filter((n) => n.startsWith('lab-')).sort();

describe('a kind provider owns the namespaces it creates', () => {
  it('stamps its owner, discovers the namespace, and tears it down (same-owner lifecycle)', async () => {
    const k8s = new FakeKubernetes();
    const provider = makeProvider(k8s, OWNER_A);
    const context = sessionContext(lab, { namespace: NS_A, sessionId: SESSION_A });

    const created = await provider.create(context);
    expect(created.ok).toBe(true);
    expect((await k8s.getNamespace(NS_A))?.labels[RUNTIME_OWNER_LABEL]).toBe(OWNER_A);
    expect(provider.runtimeOwner).toBe(OWNER_A);

    expect((await provider.listManagedSandboxes()).map((s) => s.sandboxRef)).toEqual([NS_A]);

    const destroyed = await provider.destroy(context);
    expect(destroyed.ok).toBe(true);
    expect(destroyed.namespaceGone).toBe(true);
    expect(await namespaces(k8s)).toEqual([]);
  });

  it('writes identical ownership labels for identical input', async () => {
    const first = new FakeKubernetes();
    const second = new FakeKubernetes();
    const context = sessionContext(lab, { namespace: NS_A, sessionId: SESSION_A, expiresAtMs: NOW + HOUR });

    await makeProvider(first, OWNER_A).create(context);
    await makeProvider(second, OWNER_A).create(context);

    expect((await first.getNamespace(NS_A))?.labels).toEqual((await second.getNamespace(NS_A))?.labels);
  });
});

describe('a kind provider refuses another owner’s namespace', () => {
  it('does not discover it', async () => {
    const k8s = new FakeKubernetes();
    await k8s.createNamespace(NS_A, namespaceLabels(SESSION_A, NOW + HOUR, OWNER_A));
    await k8s.createNamespace(NS_B, namespaceLabels(SESSION_B, NOW + HOUR, OWNER_B));

    const refs = (await makeProvider(k8s, OWNER_A).listManagedSandboxes()).map((s) => s.sandboxRef);

    expect(refs).toEqual([NS_A]);
  });

  it('refuses to delete it with or without a session named, and deletes nothing', async () => {
    const k8s = new FakeKubernetes();
    await k8s.createNamespace(NS_B, namespaceLabels(SESSION_B, NOW - HOUR, OWNER_B));
    const provider = makeProvider(k8s, OWNER_A);

    const bare = await provider.destroySandbox(NS_B);
    // Even the right session id does not override a foreign owner.
    const named = await provider.destroySandbox(NS_B, SESSION_B);

    for (const result of [bare, named]) {
      expect(result.ok).toBe(false);
      expect(result.namespaceGone).toBe(false);
      expect(result.error?.message ?? '').toContain(`'${OWNER_B}'`);
    }
    expect(k8s.deletedNamespaces).toEqual([]);
    expect(await namespaces(k8s)).toEqual([NS_B]);
  });

  it('refuses a namespace with no owner when no session vouches for it', async () => {
    const k8s = new FakeKubernetes();
    await k8s.createNamespace(NS_LEGACY, namespaceLabels(SESSION_LEGACY, NOW - HOUR));
    const provider = makeProvider(k8s, OWNER_A);

    const result = await provider.destroySandbox(NS_LEGACY);

    expect(result.ok).toBe(false);
    expect(result.error?.message ?? '').toContain(RUNTIME_OWNER_LABEL);
    expect(await namespaces(k8s)).toEqual([NS_LEGACY]);
  });

  it('still removes a pre-label namespace when its own session is named', async () => {
    // A live session created before the label existed is this deployment's by
    // its own store record, and its session label must still match.
    const k8s = new FakeKubernetes();
    await k8s.createNamespace(NS_LEGACY, namespaceLabels(SESSION_LEGACY, NOW + HOUR));
    const provider = makeProvider(k8s, OWNER_A);

    expect((await provider.destroySandbox(NS_LEGACY, SESSION_A)).ok).toBe(false);
    expect(await namespaces(k8s)).toEqual([NS_LEGACY]);

    const own = await provider.destroySandbox(NS_LEGACY, SESSION_LEGACY);
    expect(own.ok).toBe(true);
    expect(await namespaces(k8s)).toEqual([]);
  });
});

describe('the reaper reclaims only its own runtime’s orphaned namespaces', () => {
  async function cluster() {
    const k8s = new FakeKubernetes();
    // All three expired an hour ago and none is in any session store.
    await k8s.createNamespace(NS_A, namespaceLabels(SESSION_A, NOW - HOUR, OWNER_A));
    await k8s.createNamespace(NS_B, namespaceLabels(SESSION_B, NOW - HOUR, OWNER_B));
    await k8s.createNamespace(NS_LEGACY, namespaceLabels(SESSION_LEGACY, NOW - HOUR));
    return k8s;
  }

  it('A’s reaper takes A’s namespace and adopts neither B’s nor the unowned one', async () => {
    const k8s = await cluster();
    const { reaper, orphanCounts } = await reaperFor(k8s, OWNER_A);

    const sweep = await reaper.sweep();

    expect(sweep.removed).toEqual([NS_A]);
    expect(sweep.errors).toEqual([]);
    expect(await namespaces(k8s)).toEqual([NS_B, NS_LEGACY].sort());
    // What it cannot see is not even counted as its orphan.
    expect(orphanCounts.at(-1)).toEqual({ kubernetes: 1 });
  });

  it('is symmetric across two simulated runtimes on one cluster, and idempotent', async () => {
    const k8s = await cluster();
    const a = await reaperFor(k8s, OWNER_A);
    const b = await reaperFor(k8s, OWNER_B);

    expect((await a.reaper.sweep()).removed).toEqual([NS_A]);
    expect((await b.reaper.sweep()).removed).toEqual([NS_B]);
    expect((await a.reaper.sweep()).removed).toEqual([]);
    expect((await b.reaper.sweep()).removed).toEqual([]);

    // Nobody provably owns the unlabelled namespace, so nobody took it.
    expect(await namespaces(k8s)).toEqual([NS_LEGACY]);
  });
});
