/**
 * PLATFORM-008 — the contract both session stores must satisfy.
 *
 * Written once and run against `InMemorySessionStore` here, and against a real
 * PostgreSQL in `session-store-integration.test.ts`. That is the point: a test
 * that passed only against the in-memory double would prove nothing about the
 * store production actually runs, and the two would drift.
 *
 * The properties under test are the ones that make multiple API instances safe.
 * Not "a row was written" — that is easy and uninteresting. What matters is
 * that a lifecycle change is *decided* by the store rather than by whichever
 * caller wrote last, because a read-then-write cannot arbitrate between two
 * processes and a mutex in one of them cannot protect the other.
 */
import { describe, expect, it } from 'vitest';
import { InMemorySessionStore, type LabSession, type SessionStore } from '../src/index.js';

const NOW = '2026-08-25T12:00:00.000Z';
const HOUR_LATER = '2026-08-25T13:00:00.000Z';

export function session(overrides: Partial<LabSession> = {}): LabSession {
  const id = overrides.sessionId ?? 'sess-000000000000000a';
  return {
    sessionId: id,
    labId: 'LINUX-001',
    provider: 'linux',
    sandboxKind: 'container',
    sandboxRef: overrides.sandboxRef ?? `jtt-lab-${id.slice(-12)}`,
    namespace: overrides.namespace ?? `jtt-lab-${id.slice(-12)}`,
    serviceAccountName: 'student',
    status: 'CREATING',
    environmentId: '',
    createdAt: NOW,
    lastActivityAt: NOW,
    expiresAt: HOUR_LATER,
    idleTimeoutSeconds: 1_200,
    idleWarningSeconds: 300,
    ...overrides,
  };
}

/**
 * The shared suite. Exported so the PostgreSQL integration test runs exactly
 * these assertions against a real database.
 */
export function sessionStoreContract(
  name: string,
  makeStore: () => Promise<SessionStore> | SessionStore,
): void {
  describe(`${name} — session store contract`, () => {
    it('round-trips a session', async () => {
      const store = await makeStore();
      const created = session();
      await store.create(created);

      expect(await store.get(created.sessionId)).toEqual(created);
    });

    it('refuses a duplicate session id', async () => {
      const store = await makeStore();
      await store.create(session());
      await expect(store.create(session())).rejects.toThrow(/already exists/);
    });

    it('never hands two sessions the same sandbox', async () => {
      const store = await makeStore();
      const first = session({ sessionId: 'sess-00000000000000a1' });
      await store.create(first);

      // A second session claiming the same sandbox must not be storable: this
      // is the guarantee that stops two students sharing an environment.
      await expect(
        store.create(session({ sessionId: 'sess-00000000000000a2', sandboxRef: first.sandboxRef })),
      ).rejects.toThrow();
    });

    it('resolves a session by its sandbox handle', async () => {
      const store = await makeStore();
      const created = session();
      await store.create(created);

      expect((await store.findBySandboxRef(created.sandboxRef))?.sessionId).toBe(created.sessionId);
      expect(await store.findBySandboxRef('jtt-lab-ffffffffffff')).toBeNull();
    });

    it('refuses to move identity fields', async () => {
      const store = await makeStore();
      const created = session();
      await store.create(created);

      const patched = await store.update(created.sessionId, {
        sandboxRef: 'jtt-lab-ffffffffffff',
        provider: 'docker',
        status: 'ACTIVE',
      } as Partial<LabSession>);

      // A live session cannot be moved to another sandbox or another provider.
      expect(patched?.sandboxRef).toBe(created.sandboxRef);
      expect(patched?.provider).toBe('linux');
      expect(patched?.status).toBe('ACTIVE');
    });

    // ------------------------------------------------------ transitions

    it('transitions only from an expected state', async () => {
      const store = await makeStore();
      const created = session();
      await store.create(created);

      expect((await store.transition(created.sessionId, ['CREATING'], 'ACTIVE'))?.status).toBe(
        'ACTIVE',
      );
      // The same transition again finds the row somewhere else and declines.
      expect(await store.transition(created.sessionId, ['CREATING'], 'ACTIVE')).toBeNull();
    });

    it('lets exactly one of two competing terminal transitions win', async () => {
      const store = await makeStore();
      const created = session({ status: 'ACTIVE' });
      await store.create(created);

      // End and expire, racing on one session — a student pressing End while a
      // reaper reclaims the same row.
      const [ending, expiring] = await Promise.all([
        store.transition(created.sessionId, ['ACTIVE'], 'ENDING'),
        store.transition(created.sessionId, ['ACTIVE'], 'EXPIRING'),
      ]);

      const winners = [ending, expiring].filter(Boolean);
      expect(winners).toHaveLength(1);
      // And the loser is told it lost, rather than believing it won.
      expect((await store.get(created.sessionId))?.status).toBe(winners[0]?.status);
    });

    it('cannot resurrect a finished session', async () => {
      const store = await makeStore();
      const created = session({ status: 'ENDED' });
      await store.create(created);

      expect(await store.transition(created.sessionId, ['ACTIVE'], 'ACTIVE')).toBeNull();
      expect(await store.touchActivity(created.sessionId, HOUR_LATER)).toBeNull();
      expect((await store.get(created.sessionId))?.status).toBe('ENDED');
    });

    it('records activity without moving the absolute deadline', async () => {
      const store = await makeStore();
      const created = session({ status: 'ACTIVE' });
      await store.create(created);

      const touched = await store.touchActivity(created.sessionId, HOUR_LATER);

      expect(touched?.lastActivityAt).toBe(HOUR_LATER);
      // Activity slides the idle window, never the hard deadline.
      expect(touched?.expiresAt).toBe(created.expiresAt);
    });

    // -------------------------------------------------------- expiry scan

    it('finds sessions past their absolute deadline', async () => {
      const store = await makeStore();
      // Active *and* recently active: with a 20-minute idle window and a scan at
      // 12:30, a session last seen at 12:00 would be idle-expired, which is a
      // different rule than the one this test is about.
      await store.create(
        session({
          sessionId: 'sess-00000000000000b1',
          status: 'ACTIVE',
          lastActivityAt: '2026-08-25T12:29:00.000Z',
        }),
      );
      await store.create(
        session({
          sessionId: 'sess-00000000000000b2',
          status: 'ACTIVE',
          expiresAt: '2026-08-25T11:00:00.000Z',
        }),
      );

      const expirable = await store.listExpirable('2026-08-25T12:30:00.000Z');
      expect(expirable.map((s) => s.sessionId)).toEqual(['sess-00000000000000b2']);
    });

    it('finds sessions that have been idle too long', async () => {
      const store = await makeStore();
      await store.create(
        session({
          sessionId: 'sess-00000000000000c1',
          status: 'ACTIVE',
          lastActivityAt: '2026-08-25T11:00:00.000Z',
          idleTimeoutSeconds: 600,
        }),
      );

      expect((await store.listExpirable('2026-08-25T12:00:00.000Z')).map((s) => s.sessionId)).toEqual(
        ['sess-00000000000000c1'],
      );
    });

    it('never offers a finished session as an expiry candidate', async () => {
      const store = await makeStore();
      for (const status of ['ENDED', 'EXPIRED', 'FAILED'] as const) {
        await store.create(
          session({
            sessionId: `sess-0000000000000${status.slice(0, 3).toLowerCase()}`,
            sandboxRef: `jtt-lab-${status.toLowerCase()}00`,
            status,
            expiresAt: '2020-01-01T00:00:00.000Z',
          }),
        );
      }
      expect(await store.listExpirable(NOW)).toEqual([]);
    });

    // ----------------------------------------------------------- capacity

    it('counts only sessions holding a sandbox', async () => {
      const store = await makeStore();
      await store.create(session({ sessionId: 'sess-00000000000000d1', status: 'ACTIVE' }));
      await store.create(
        session({ sessionId: 'sess-00000000000000d2', sandboxRef: 'jtt-lab-0000000000d2', status: 'ENDED' }),
      );

      expect(await store.countOccupying()).toBe(1);
    });

    it('admits up to the limit and refuses beyond it, without inserting', async () => {
      const store = await makeStore();
      const first = session({ sessionId: 'sess-00000000000000e1', status: 'ACTIVE' });
      const second = session({
        sessionId: 'sess-00000000000000e2',
        sandboxRef: 'jtt-lab-0000000000e2',
        status: 'CREATING',
      });

      expect(await store.createWithinCapacity(first, 1)).toBe(true);
      expect(await store.createWithinCapacity(second, 1)).toBe(false);
      // Refused means *not written*: no row, so no sandbox is ever provisioned
      // for a session that was not admitted.
      expect(await store.get(second.sessionId)).toBeNull();
    });

    it('holds the limit when starts arrive together', async () => {
      const store = await makeStore();
      const candidates = Array.from({ length: 5 }, (_, i) =>
        session({
          sessionId: `sess-00000000000000f${i}`,
          sandboxRef: `jtt-lab-0000000000f${i}`,
          status: 'CREATING',
        }),
      );

      const admitted = await Promise.all(
        candidates.map((c) => store.createWithinCapacity(c, 2)),
      );

      expect(admitted.filter(Boolean)).toHaveLength(2);
      expect(await store.countOccupying()).toBe(2);
    });
  });
}

sessionStoreContract('InMemorySessionStore', () => new InMemorySessionStore());
