/**
 * PLATFORM-007 — a sandbox operation affects only the sandbox that owns it.
 *
 * The rule under test, stated once: **a name is never authorisation.** Every
 * destructive lifecycle operation — reset, destroy, reap — must first prove
 * from platform-controlled metadata that the resource is managed, belongs to
 * the expected session, and belongs to this provider. Anything it cannot prove
 * is left alone.
 *
 * Why this needs adversarial tests rather than a unit test per method: the
 * failure mode is not "the wrong error message". It is one worktree's test run
 * deleting a sandbox another worktree is actively using, which looks exactly
 * like flakiness and is nearly impossible to diagnose after the fact. So each
 * case below stands up a *populated* daemon — this session, another session, an
 * unmanaged container, and another provider's sandbox — and asserts on what
 * survived, not only on what the call returned.
 *
 * The cast, used throughout:
 *
 *   A  this session's sandbox            (managed, ours, this provider)
 *   B  another live session's sandbox    (managed, not ours)
 *   C  an unmanaged container            (a developer's, no labels)
 *   D  a foreign worktree's test sandbox (managed, another provider)
 *   E  a lookalike                       (our name shape, no ownership labels)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_POLICY,
  LinuxLabProvider,
  MANAGED_CONTAINER_LABEL,
  CONTAINER_SESSION_LABEL,
  CONTAINER_LAB_LABEL,
  CONTAINER_EXPIRES_LABEL,
  CONTAINER_PROVIDER_LABEL,
} from '../src/index.js';
import { FakeContainerRuntime } from './container-fakes.js';
import { loadK8s001, sessionContext } from './helpers.js';
import type { LoadedLabDefinition } from '../src/index.js';

const SESSION_A = 'sess-0000000000000a0a';
const SESSION_B = 'sess-0000000000000b0b';
const REF_A = 'jtt-lab-aaaaaaaaaaaa';
const REF_B = 'jtt-lab-bbbbbbbbbbbb';
const UNMANAGED_C = 'my-dev-postgres';
const FOREIGN_D = 'jtt-lab-dddddddddddd';
const LOOKALIKE_E = 'jtt-lab-eeeeeeeeeeee';

const HOUR = 3_600_000;

let lab: LoadedLabDefinition;
let runtime: FakeContainerRuntime;
let provider: LinuxLabProvider;

/** Labels the platform itself stamps on a sandbox it owns. */
function ownedLabels(sessionId: string, expiresAtMs: number, providerId = 'linux') {
  return {
    [MANAGED_CONTAINER_LABEL]: 'true',
    [CONTAINER_SESSION_LABEL]: sessionId,
    [CONTAINER_LAB_LABEL]: 'K8S-001',
    [CONTAINER_EXPIRES_LABEL]: String(expiresAtMs),
    [CONTAINER_PROVIDER_LABEL]: providerId,
  };
}

/** Stand up the full cast on one shared daemon. */
function populate(now: number): void {
  runtime.addForeignContainer(REF_B, ownedLabels(SESSION_B, now + HOUR));
  runtime.addForeignContainer(UNMANAGED_C, {});
  runtime.addForeignContainer(FOREIGN_D, ownedLabels('sess-000000000000d0d0', now + HOUR, 'docker'));
  runtime.addForeignContainer(LOOKALIKE_E, {});
}

const survivors = () => [...runtime.containers.keys()].sort();

beforeEach(async () => {
  lab = await loadK8s001();
  runtime = new FakeContainerRuntime();
  provider = new LinuxLabProvider({ runtime });
});

// ------------------------------------------------------------------ destroy

describe('destroy affects only the session that owns the sandbox', () => {
  it('removes A and leaves B, C, D and E untouched', async () => {
    const now = Date.now();
    const context = sessionContext(lab, { sessionId: SESSION_A, sandboxRef: REF_A });
    await provider.create(context);
    populate(now);

    const result = await provider.destroy(context);

    expect(result.ok).toBe(true);
    expect(survivors()).toEqual([UNMANAGED_C, FOREIGN_D, REF_B, LOOKALIKE_E].sort());
  });

  it('refuses a sandbox belonging to another session, and removes nothing', async () => {
    const now = Date.now();
    await provider.create(sessionContext(lab, { sessionId: SESSION_A, sandboxRef: REF_A }));
    populate(now);
    const before = survivors();

    // Session A's identity, pointed at session B's sandbox.
    const result = await provider.destroySandbox(REF_B, SESSION_A);

    expect(result.ok).toBe(false);
    expect(result.error?.message ?? '').toMatch(/belongs to/);
    expect(survivors()).toEqual(before);
  });

  it('refuses an unmanaged container even when asked directly', async () => {
    populate(Date.now());
    const before = survivors();

    const result = await provider.destroySandbox(UNMANAGED_C);

    expect(result.ok).toBe(false);
    expect(survivors()).toEqual(before);
  });

  it('refuses a sandbox belonging to another provider', async () => {
    /*
     * Found by real-daemon validation, not by this suite's first draft: the
     * ownership gate checked the managed and session labels and never the
     * provider, so the Linux provider would delete a Docker sandbox outright.
     * Discovery already filtered on the provider, which hid it — the reaper
     * never offered such a sandbox — but `destroySandbox` is public and the
     * reaper is not its only caller.
     *
     * This is the sibling-worktree failure in its purest form: managed, valid,
     * correctly labelled, and simply somebody else's.
     */
    populate(Date.now());
    const before = survivors();

    const result = await provider.destroySandbox(FOREIGN_D);

    expect(result.ok).toBe(false);
    expect(result.error?.message ?? '').toMatch(/provider/i);
    expect(survivors()).toEqual(before);
  });

  it('refuses a lookalike: our name shape, none of our metadata', async () => {
    populate(Date.now());
    const before = survivors();

    // The whole point: the name is exactly what a real sandbox looks like.
    const result = await provider.destroySandbox(LOOKALIKE_E);

    expect(result.ok).toBe(false);
    expect(result.error?.message ?? '').toMatch(/not labelled/);
    expect(survivors()).toEqual(before);
  });
});

// -------------------------------------------------------------------- reset

describe('reset affects only the session that owns the sandbox', () => {
  it('replaces A and leaves every other container in place', async () => {
    const now = Date.now();
    const context = sessionContext(lab, { sessionId: SESSION_A, sandboxRef: REF_A });
    await provider.create(context);
    populate(now);

    const result = await provider.reset(context);

    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    // A is recreated, so it is present again — and nothing else moved.
    expect(survivors()).toEqual([REF_A, UNMANAGED_C, FOREIGN_D, REF_B, LOOKALIKE_E].sort());
  });
});

// ----------------------------------------------------- managed discovery

describe('listManagedSandboxes returns only what the platform can prove it owns', () => {
  it('excludes unmanaged, lookalike and other providers’ sandboxes', async () => {
    const now = Date.now();
    await provider.create(sessionContext(lab, { sessionId: SESSION_A, sandboxRef: REF_A }));
    populate(now);

    const refs = (await provider.listManagedSandboxes()).map((s) => s.sandboxRef).sort();

    // B is another session's, but it is this provider's kind of sandbox and a
    // legitimate reap candidate once it expires — so discovery includes it.
    // C has no labels, E has our name but no labels, D belongs to another
    // provider: none of the three may appear.
    expect(refs).toEqual([REF_A, REF_B].sort());
    expect(refs).not.toContain(UNMANAGED_C);
    expect(refs).not.toContain(LOOKALIKE_E);
    expect(refs).not.toContain(FOREIGN_D);
  });

  it('proves the provider from metadata rather than assuming it', async () => {
    const now = Date.now();
    populate(now);

    const found = await provider.listManagedSandboxes();

    // Every entry carries the provider it was *labelled* with, and this
    // provider only reports its own.
    for (const entry of found) expect(entry.providerId).toBe('linux');
  });

  it('reports a missing expiry as zero rather than guessing a deadline', async () => {
    runtime.addForeignContainer(REF_B, {
      [MANAGED_CONTAINER_LABEL]: 'true',
      [CONTAINER_SESSION_LABEL]: SESSION_B,
      [CONTAINER_PROVIDER_LABEL]: 'linux',
    });

    const [entry] = await provider.listManagedSandboxes();
    expect(entry?.expiresAtMs).toBe(0);
  });

  it('reports a malformed expiry as zero rather than as a past deadline', async () => {
    for (const malformed of ['not-a-number', '-1', '0', '']) {
      const local = new FakeContainerRuntime();
      const p = new LinuxLabProvider({ runtime: local });
      local.addForeignContainer(REF_B, {
        [MANAGED_CONTAINER_LABEL]: 'true',
        [CONTAINER_SESSION_LABEL]: SESSION_B,
        [CONTAINER_PROVIDER_LABEL]: 'linux',
        [CONTAINER_EXPIRES_LABEL]: malformed,
      });

      const [entry] = await p.listManagedSandboxes();
      // Zero is the "undateable" signal the reaper refuses to act on. A
      // malformed value must never parse to something already in the past.
      expect(entry?.expiresAtMs, malformed).toBe(0);
    }
  });
});

// ------------------------------------------------------------- idempotence

describe('lifecycle operations are idempotent', () => {
  it('destroying twice removes once and does not disturb the rest', async () => {
    const now = Date.now();
    const context = sessionContext(lab, { sessionId: SESSION_A, sandboxRef: REF_A });
    await provider.create(context);
    populate(now);

    const first = await provider.destroy(context);
    const after = survivors();
    const second = await provider.destroy(context);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(survivors()).toEqual(after);
  });
});
