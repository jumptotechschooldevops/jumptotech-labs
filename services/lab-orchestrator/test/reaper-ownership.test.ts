/**
 * PLATFORM-007 — the reaper deletes only what it can prove it may delete.
 *
 * The reaper is the most dangerous code in the platform: it runs unattended, on
 * a timer, and its job is to remove containers. Every other destructive path is
 * driven by a request naming one session; this one goes looking. On a developer
 * laptop the same daemon carries sandboxes from seven worktrees at once, so a
 * reaper that swept by name shape would delete a colleague's running lab and
 * look exactly like flakiness afterwards.
 *
 * Three conditions must all hold before anything is removed — **managed**,
 * **owned by this provider**, and **eligible** — and each test below removes
 * exactly one of them and asserts the container survives.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTAINER_EXPIRES_LABEL,
  CONTAINER_LAB_LABEL,
  CONTAINER_PROVIDER_LABEL,
  CONTAINER_SESSION_LABEL,
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  LinuxLabProvider,
  MANAGED_CONTAINER_LABEL,
  SessionManager,
  SessionReaper,
} from '../src/index.js';
import { FakeContainerRuntime } from './container-fakes.js';
import { realCatalog } from './real-catalog.js';

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

const EXPIRED_OURS = 'jtt-lab-a1a1a1a1a1a1';
const ACTIVE_OURS = 'jtt-lab-b2b2b2b2b2b2';
const UNMANAGED = 'my-dev-postgres';
const FOREIGN_PROVIDER = 'jtt-lab-d4d4d4d4d4d4';
const LOOKALIKE = 'jtt-lab-e5e5e5e5e5e5';
const NO_EXPIRY = 'jtt-lab-f6f6f6f6f6f6';
const MALFORMED_EXPIRY = 'jtt-lab-a7a7a7a7a7a7';

function labels(over: Record<string, string> = {}): Record<string, string> {
  return {
    [MANAGED_CONTAINER_LABEL]: 'true',
    [CONTAINER_SESSION_LABEL]: 'sess-0000000000000001',
    [CONTAINER_LAB_LABEL]: 'LINUX-001',
    [CONTAINER_PROVIDER_LABEL]: 'linux',
    [CONTAINER_EXPIRES_LABEL]: String(NOW + HOUR),
    ...over,
  };
}

async function harness() {
  const registry = await realCatalog();
  const runtime = new FakeContainerRuntime();
  const provider = new LinuxLabProvider({ runtime });
  const manager = new SessionManager({
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
    namespaceSecret: 'a-secret-for-ownership-tests',
    now: () => NOW,
  });
  const reaper = new SessionReaper({
    sessions: manager,
    provider,
    intervalMs: 60_000,
    now: () => NOW,
  });

  // The full cast, on one shared daemon. Nothing here is in the session store,
  // so every one of them is an orphan candidate as far as the reaper knows.
  runtime.addForeignContainer(EXPIRED_OURS, labels({ [CONTAINER_EXPIRES_LABEL]: String(NOW - HOUR) }));
  runtime.addForeignContainer(ACTIVE_OURS, labels());
  runtime.addForeignContainer(UNMANAGED, {});
  runtime.addForeignContainer(
    FOREIGN_PROVIDER,
    labels({ [CONTAINER_PROVIDER_LABEL]: 'docker', [CONTAINER_EXPIRES_LABEL]: String(NOW - HOUR) }),
  );
  runtime.addForeignContainer(LOOKALIKE, {});
  runtime.addForeignContainer(NO_EXPIRY, {
    [MANAGED_CONTAINER_LABEL]: 'true',
    [CONTAINER_PROVIDER_LABEL]: 'linux',
    [CONTAINER_SESSION_LABEL]: 'sess-0000000000000002',
  });
  runtime.addForeignContainer(
    MALFORMED_EXPIRY,
    labels({ [CONTAINER_EXPIRES_LABEL]: 'yesterday-ish' }),
  );

  return { runtime, reaper };
}

const survivors = (runtime: FakeContainerRuntime) => [...runtime.containers.keys()].sort();

describe('the reaper removes only managed + owned + eligible sandboxes', () => {
  it('removes an expired sandbox of its own and nothing else', async () => {
    const { runtime, reaper } = await harness();

    const sweep = await reaper.sweep();

    expect(sweep.removed).toEqual([EXPIRED_OURS]);
    expect(survivors(runtime)).toEqual(
      [ACTIVE_OURS, UNMANAGED, FOREIGN_PROVIDER, LOOKALIKE, NO_EXPIRY, MALFORMED_EXPIRY].sort(),
    );
  });

  it('preserves a live sandbox whose deadline has not passed', async () => {
    const { runtime, reaper } = await harness();
    await reaper.sweep();
    expect(survivors(runtime)).toContain(ACTIVE_OURS);
  });

  it('preserves an unmanaged container', async () => {
    const { runtime, reaper } = await harness();
    await reaper.sweep();
    expect(survivors(runtime)).toContain(UNMANAGED);
  });

  it('preserves another provider’s expired sandbox — eligible, but not ours', async () => {
    const { runtime, reaper } = await harness();
    await reaper.sweep();
    // This is the sibling-worktree case: expired and managed, so the only
    // thing standing between it and deletion is the provider label.
    expect(survivors(runtime)).toContain(FOREIGN_PROVIDER);
  });

  it('preserves a container that merely looks like one of ours', async () => {
    const { runtime, reaper } = await harness();
    await reaper.sweep();
    expect(survivors(runtime)).toContain(LOOKALIKE);
  });

  it('preserves a managed sandbox with no expiry — it will not guess a deadline', async () => {
    const { runtime, reaper } = await harness();
    await reaper.sweep();
    expect(survivors(runtime)).toContain(NO_EXPIRY);
  });

  it('preserves a managed sandbox whose expiry is malformed', async () => {
    const { runtime, reaper } = await harness();
    await reaper.sweep();
    // The dangerous reading of unparseable metadata is "0", i.e. long expired.
    // It must fail closed instead.
    expect(survivors(runtime)).toContain(MALFORMED_EXPIRY);
  });

  it('is idempotent: a second sweep removes nothing and changes nothing', async () => {
    const { runtime, reaper } = await harness();

    const first = await reaper.sweep();
    const afterFirst = survivors(runtime);
    const second = await reaper.sweep();

    expect(first.removed).toEqual([EXPIRED_OURS]);
    expect(second.removed).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(survivors(runtime)).toEqual(afterFirst);
  });

  it('re-verifies ownership at delete time, not only at discovery time', async () => {
    // TOCTOU: discovery and deletion are two calls, and the world can change
    // between them. If the sandbox stops being ours in that gap, the delete
    // must refuse rather than act on what discovery saw.
    const { runtime, reaper } = await harness();
    const original = runtime.remove.bind(runtime);
    let swapped = false;
    runtime.remove = async (name: string) => {
      if (!swapped && name === EXPIRED_OURS) {
        swapped = true;
        throw new Error('simulated: ownership changed between discovery and delete');
      }
      return original(name);
    };

    const sweep = await reaper.sweep();

    // The failure is reported, not swallowed, and nothing else was touched.
    expect(sweep.removed).not.toContain(EXPIRED_OURS);
    expect(survivors(runtime)).toContain(ACTIVE_OURS);
    expect(survivors(runtime)).toContain(FOREIGN_PROVIDER);
  });
});
