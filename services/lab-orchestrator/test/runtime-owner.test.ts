/**
 * PLATFORM-007 — runtime ownership, the level above a session.
 *
 * `0683da9` established that a destructive operation must prove the resource is
 * managed, belongs to this provider, and belongs to the expected session. That
 * closed cross-provider deletion. It does not close cross-*process* deletion,
 * and the reaper is where the gap shows:
 *
 *   the orphan sweep calls `destroySandbox(ref)` with no session on purpose —
 *   an orphan is precisely a sandbox the store has no record of, so there is no
 *   session to name. What is left to authorise the delete is `managed` and
 *   `provider`, and two worktrees running the same provider are identical on
 *   both.
 *
 * On a developer laptop that is not hypothetical: seven worktrees share one
 * Docker daemon, and at the time this was written five foreign sandboxes were
 * live, two of them orphaned `Exited (255)` containers from a crashed run. One
 * worktree's reaper would happily reclaim another's.
 *
 * A runtime owner is the missing discriminator: who *ran* this, as distinct from
 * which session or provider it belongs to. Production has a single owner and is
 * unaffected; each test process and each worktree takes its own.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTAINER_EXPIRES_LABEL,
  CONTAINER_PROVIDER_LABEL,
  CONTAINER_SESSION_LABEL,
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  LabRegistry,
  LinuxLabProvider,
  MANAGED_CONTAINER_LABEL,
  RUNTIME_OWNER_LABEL,
  SessionManager,
  SessionReaper,
} from '../src/index.js';
import { FakeContainerRuntime } from './container-fakes.js';
import { LABS_DIR } from './helpers.js';

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

const OWNER_A = 'wt-alpha';
const OWNER_B = 'wt-bravo';
const SANDBOX_A = 'jtt-lab-aaaaaaaaaaaa';
const SANDBOX_B = 'jtt-lab-bbbbbbbbbbbb';
const LEGACY = 'jtt-lab-cccccccccccc';

/** An expired sandbox belonging to `owner`, as that owner's platform stamped it. */
function expiredSandbox(owner: string | undefined): Record<string, string> {
  return {
    [MANAGED_CONTAINER_LABEL]: 'true',
    [CONTAINER_PROVIDER_LABEL]: 'linux',
    [CONTAINER_SESSION_LABEL]: 'sess-0000000000000001',
    [CONTAINER_EXPIRES_LABEL]: String(NOW - HOUR),
    ...(owner ? { [RUNTIME_OWNER_LABEL]: owner } : {}),
  };
}

async function reaperFor(runtimeOwner: string, runtime: FakeContainerRuntime) {
  const registry = new LabRegistry(LABS_DIR);
  await registry.load();
  const provider = new LinuxLabProvider({ runtime, runtimeOwner });
  const sessions = new SessionManager({
    registry,
    provider,
    store: new InMemorySessionStore(),
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: {
      maxSessionSeconds: 3_600,
      idleTimeoutSeconds: 1_200,
      warningSeconds: 300,
      maxActiveSessions: 20,
    },
    namespaceSecret: 'runtime-owner-tests',
    now: () => NOW,
  });
  return {
    provider,
    reaper: new SessionReaper({ sessions, provider, intervalMs: 60_000, now: () => NOW }),
  };
}

const survivors = (r: FakeContainerRuntime) => [...r.containers.keys()].sort();

describe('a reaper reclaims only its own runtime owner’s sandboxes', () => {
  it('leaves another owner’s expired sandbox alone', async () => {
    const runtime = new FakeContainerRuntime();
    runtime.addForeignContainer(SANDBOX_A, expiredSandbox(OWNER_A));
    runtime.addForeignContainer(SANDBOX_B, expiredSandbox(OWNER_B));

    const { reaper } = await reaperFor(OWNER_A, runtime);
    const sweep = await reaper.sweep();

    // Both are managed, both this provider's, both expired. Only the owner
    // distinguishes them — which is the whole point.
    expect(sweep.removed).toEqual([SANDBOX_A]);
    expect(survivors(runtime)).toEqual([SANDBOX_B]);
  });

  it('is symmetric: B’s reaper takes B and leaves A', async () => {
    const runtime = new FakeContainerRuntime();
    runtime.addForeignContainer(SANDBOX_A, expiredSandbox(OWNER_A));
    runtime.addForeignContainer(SANDBOX_B, expiredSandbox(OWNER_B));

    const { reaper } = await reaperFor(OWNER_B, runtime);
    const sweep = await reaper.sweep();

    expect(sweep.removed).toEqual([SANDBOX_B]);
    expect(survivors(runtime)).toEqual([SANDBOX_A]);
  });

  it('does not discover another owner’s sandbox at all', async () => {
    const runtime = new FakeContainerRuntime();
    runtime.addForeignContainer(SANDBOX_A, expiredSandbox(OWNER_A));
    runtime.addForeignContainer(SANDBOX_B, expiredSandbox(OWNER_B));

    const { provider } = await reaperFor(OWNER_A, runtime);
    const refs = (await provider.listManagedSandboxes()).map((s) => s.sandboxRef);

    // Discovery is the first gate: what it cannot see, it cannot delete.
    expect(refs).toEqual([SANDBOX_A]);
  });

  it('refuses a direct destroy of another owner’s sandbox', async () => {
    const runtime = new FakeContainerRuntime();
    runtime.addForeignContainer(SANDBOX_B, expiredSandbox(OWNER_B));

    const { provider } = await reaperFor(OWNER_A, runtime);
    const result = await provider.destroySandbox(SANDBOX_B);

    expect(result.ok).toBe(false);
    expect(result.error?.message ?? '').toMatch(/runtime owner|owner/i);
    expect(survivors(runtime)).toEqual([SANDBOX_B]);
  });

  it('still reclaims a sandbox from before the label existed', async () => {
    // Backward compatibility: an unlabelled sandbox belongs to whoever finds
    // it, exactly as before. Upgrading must not strand running sandboxes.
    const runtime = new FakeContainerRuntime();
    runtime.addForeignContainer(LEGACY, expiredSandbox(undefined));

    const { reaper } = await reaperFor(OWNER_A, runtime);
    const sweep = await reaper.sweep();

    expect(sweep.removed).toEqual([LEGACY]);
  });

  it('stamps its owner on every sandbox it creates', async () => {
    const runtime = new FakeContainerRuntime();
    const { provider } = await reaperFor(OWNER_A, runtime);
    const registry = new LabRegistry(LABS_DIR);
    await registry.load();
    const lab = registry.get('LINUX-001');

    await provider.create({
      sessionId: 'sess-000000000000000a',
      labId: lab.id,
      sandboxRef: SANDBOX_A,
      namespace: SANDBOX_A,
      serviceAccountName: 'student',
      lab,
      expiresAtMs: NOW + HOUR,
      policy: DEFAULT_SESSION_POLICY,
    } as never);

    const created = runtime.created.at(-1);
    expect(created?.labels?.[RUNTIME_OWNER_LABEL]).toBe(OWNER_A);
  });
});

// ------------------------------------------------- the four-sandbox scenario

describe('two runtime owners with two sessions each never touch one another', () => {
  /**
   * The shape a developer laptop actually has: two worktrees, two sessions
   * apiece, one daemon. Every assertion below is about what *survived*, because
   * the failure this guards against is silent — a sandbox disappearing under a
   * neighbour mid-test looks like flakiness, not like a bug.
   */
  const A1 = 'jtt-lab-a1a1a1a1a1a1';
  const A2 = 'jtt-lab-a2a2a2a2a2a2';
  const B1 = 'jtt-lab-b1b1b1b1b1b1';
  const B2 = 'jtt-lab-b2b2b2b2b2b2';
  const UNMANAGED = 'someones-dev-database';

  function world() {
    const runtime = new FakeContainerRuntime();
    // A1 and B1 are live; A2 and B2 have expired and are reap candidates.
    runtime.addForeignContainer(A1, {
      ...expiredSandbox(OWNER_A),
      [CONTAINER_EXPIRES_LABEL]: String(NOW + HOUR),
    });
    runtime.addForeignContainer(A2, expiredSandbox(OWNER_A));
    runtime.addForeignContainer(B1, {
      ...expiredSandbox(OWNER_B),
      [CONTAINER_EXPIRES_LABEL]: String(NOW + HOUR),
    });
    runtime.addForeignContainer(B2, expiredSandbox(OWNER_B));
    runtime.addForeignContainer(UNMANAGED, {});
    return runtime;
  }

  it('owner A’s reaper takes only A2', async () => {
    const runtime = world();
    const { reaper } = await reaperFor(OWNER_A, runtime);

    const sweep = await reaper.sweep();

    expect(sweep.removed).toEqual([A2]);
    expect(survivors(runtime)).toEqual([A1, B1, B2, UNMANAGED].sort());
  });

  it('owner B’s reaper then takes only B2, and A1/B1 still stand', async () => {
    const runtime = world();
    const a = await reaperFor(OWNER_A, runtime);
    const b = await reaperFor(OWNER_B, runtime);

    await a.reaper.sweep();
    const sweep = await b.reaper.sweep();

    expect(sweep.removed).toEqual([B2]);
    expect(survivors(runtime)).toEqual([A1, B1, UNMANAGED].sort());
  });

  it('destroying A1 leaves every one of B’s sandboxes alone', async () => {
    const runtime = world();
    const { provider } = await reaperFor(OWNER_A, runtime);

    const result = await provider.destroySandbox(A1);

    expect(result.ok).toBe(true);
    expect(survivors(runtime)).toEqual([A2, B1, B2, UNMANAGED].sort());
  });

  it('neither owner can reach the other’s live sandbox', async () => {
    const runtime = world();
    const a = await reaperFor(OWNER_A, runtime);
    const b = await reaperFor(OWNER_B, runtime);

    expect((await a.provider.destroySandbox(B1)).ok).toBe(false);
    expect((await b.provider.destroySandbox(A1)).ok).toBe(false);
    expect(survivors(runtime)).toEqual([A1, A2, B1, B2, UNMANAGED].sort());
  });

  it('sweeping repeatedly is idempotent for both owners', async () => {
    const runtime = world();
    const a = await reaperFor(OWNER_A, runtime);
    const b = await reaperFor(OWNER_B, runtime);

    await a.reaper.sweep();
    await b.reaper.sweep();
    const settled = survivors(runtime);
    const againA = await a.reaper.sweep();
    const againB = await b.reaper.sweep();

    expect(againA.removed).toEqual([]);
    expect(againB.removed).toEqual([]);
    expect(againA.errors).toEqual([]);
    expect(againB.errors).toEqual([]);
    expect(survivors(runtime)).toEqual(settled);
  });

  it('survives a container that vanished between discovery and delete', async () => {
    // The process-died case: the store still lists it, the daemon does not.
    const runtime = world();
    const { reaper } = await reaperFor(OWNER_A, runtime);
    const original = runtime.remove.bind(runtime);
    runtime.remove = async (name: string) => {
      runtime.containers.delete(name);
      return original(name);
    };

    const first = await reaper.sweep();
    const second = await reaper.sweep();

    expect(first.errors).toEqual([]);
    expect(second.removed).toEqual([]);
    expect(survivors(runtime)).toEqual([A1, B1, B2, UNMANAGED].sort());
  });
});
