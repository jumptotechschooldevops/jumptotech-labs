/**
 * Every session's shell gets a Unix uid of its own — SEC-ARCH-2.
 *
 * Kubernetes- and Docker-track shells run in the terminal service's container
 * and all used to share uid 1001. The session store now assigns each session a
 * uid when its row is created; the terminal runs that session's shell, and
 * owns its files, as that uid. This suite pins the allocation half:
 *
 *   - distinct for every session, under concurrent admission too;
 *   - stable: the row carries it, so a reader after a restart sees the same;
 *   - never reused, even after the session it belonged to is gone;
 *   - never chosen by a caller or changed by a patch;
 *   - in range, and refused — never wrapped — when the range is spent.
 *
 * Exported so the PostgreSQL integration test runs the same assertions against
 * a real database (`session-store-integration.test.ts`), where the sequence,
 * the UNIQUE constraint and the CHECK of migration 007 do the work.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemorySessionStore,
  SHELL_UID_MAX,
  SHELL_UID_MIN,
  isValidShellUid,
  type SessionStore,
} from '../src/index.js';
import { CONTRACT_OWNERS, seat } from './session-store-contract.test.js';

export interface ShellIdentityHarness {
  store: SessionStore;
  /** A second store over the same data, as a restarted api would build. */
  reopen: () => Promise<SessionStore> | SessionStore;
}

export function sessionShellIdentity(
  name: string,
  make: () => Promise<ShellIdentityHarness> | ShellIdentityHarness,
): void {
  describe(`${name} — session shell identity (SEC-ARCH-2)`, () => {
    it('assigns every session a valid uid of its own', async () => {
      const { store } = await make();
      for (let i = 0; i < 5; i += 1) await store.create(seat('uid', i));
      const uids = (await store.list()).map((s) => s.shellUid);
      expect(uids).toHaveLength(5);
      for (const uid of uids) expect(isValidShellUid(uid), String(uid)).toBe(true);
      expect(new Set(uids).size).toBe(5);
    });

    it('never gives two sessions admitted at the same moment one uid', async () => {
      const { store } = await make();
      const decisions = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          store.createWithinLimits(seat('rac', i, { ownerUserId: CONTRACT_OWNERS[i % CONTRACT_OWNERS.length]! }), {
            maxOccupying: 50,
            maxOccupyingPerOwner: 50,
          }),
        ),
      );
      expect(decisions.every((d) => d.admitted)).toBe(true);
      const uids = (await store.list()).map((s) => s.shellUid);
      expect(uids).toHaveLength(12);
      expect(new Set(uids).size).toBe(12);
    });

    it('ignores a uid the caller put on the session', async () => {
      const { store } = await make();
      for (const [i, claimed] of [0, 1001, SHELL_UID_MIN, SHELL_UID_MAX].entries()) {
        await store.create(seat('clm', i, { shellUid: claimed }));
      }
      // Whatever was claimed, each got a fresh one: no two alike, and none
      // equal to a value a caller could have predicted and planted.
      const uids = (await store.list()).map((s) => s.shellUid!);
      expect(new Set(uids).size).toBe(4);
      for (const uid of uids) {
        expect(isValidShellUid(uid)).toBe(true);
        expect([0, 1001, SHELL_UID_MAX]).not.toContain(uid);
      }
    });

    it('cannot be changed by a patch or a transition', async () => {
      const { store } = await make();
      await store.create(seat('pat', 0));
      const [before] = await store.list();
      await store.update(before!.sessionId, { shellUid: 1001, status: 'ACTIVE' });
      await store.transition(before!.sessionId, ['ACTIVE'], 'ENDING', { shellUid: 0 });
      expect((await store.get(before!.sessionId))!.shellUid).toBe(before!.shellUid);
    });

    it('is the same uid for a reader after a restart', async () => {
      const harness = await make();
      await harness.store.create(seat('rst', 0));
      const [original] = await harness.store.list();
      const reopened = await harness.reopen();
      expect((await reopened.get(original!.sessionId))!.shellUid).toBe(original!.shellUid);
    });

    it('never hands a finished session’s uid to a new one', async () => {
      const { store } = await make();
      await store.create(seat('rus', 0));
      const [first] = await store.list();
      await store.transition(first!.sessionId, ['CREATING'], 'ENDED');
      await store.delete(first!.sessionId);
      await store.create(seat('rus', 1));
      const [second] = await store.list();
      expect(second!.shellUid).not.toBe(first!.shellUid);
      expect(second!.shellUid!).toBeGreaterThan(first!.shellUid!);
    });
  });
}

sessionShellIdentity('InMemorySessionStore', () => {
  const store = new InMemorySessionStore();
  // An in-memory store does not outlive its process; "reopening" it is the
  // same object, which is all a restart of it could mean.
  return { store, reopen: () => store };
});

describe('InMemorySessionStore — the end of the range', () => {
  it('refuses a session rather than reusing or wrapping a uid', async () => {
    const store = new InMemorySessionStore({ firstShellUid: SHELL_UID_MAX });
    await store.create(seat('end', 0));
    expect((await store.list())[0]!.shellUid).toBe(SHELL_UID_MAX);
    await expect(store.create(seat('end', 1))).rejects.toMatchObject({ code: 'SHELL_UID_EXHAUSTED' });
    await expect(
      store.createWithinLimits(seat('end', 2), { maxOccupying: 50, maxOccupyingPerOwner: 50 }),
    ).rejects.toMatchObject({ code: 'SHELL_UID_EXHAUSTED' });
    expect(await store.list()).toHaveLength(1);
  });
});

describe('the shell uid range', () => {
  it('accepts only integers inside it', () => {
    for (const ok of [SHELL_UID_MIN, SHELL_UID_MIN + 1, SHELL_UID_MAX]) expect(isValidShellUid(ok)).toBe(true);
    for (const bad of [0, 1, 1001, 65534, SHELL_UID_MIN - 1, SHELL_UID_MAX + 1, -SHELL_UID_MIN, 1.5 + SHELL_UID_MIN, NaN,
      Infinity, `${SHELL_UID_MIN}`, null, undefined, [SHELL_UID_MIN]]) {
      expect(isValidShellUid(bad), String(bad)).toBe(false);
    }
  });

  it('stays below 2^31, so nothing reading a uid as a signed 32-bit integer misreads it', () => {
    expect(SHELL_UID_MAX).toBeLessThan(2 ** 31 - 1);
    expect(SHELL_UID_MIN).toBeGreaterThan(165_535);
  });
});
