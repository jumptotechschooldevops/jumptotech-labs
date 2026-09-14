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
import {
  InMemorySessionStore,
  OCCUPYING_STATUSES,
  type LabSession,
  type SessionStore,
} from '../src/index.js';

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
    statusChangedAt: NOW,
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

    // ------------------------------------------- BETA-P0-007: recovery

    it('stamps statusChangedAt only when the status really changes', async () => {
      const store = await makeStore();
      const created = session({ status: 'ACTIVE' });
      await store.create(created);

      const ending = await store.transition(created.sessionId, ['ACTIVE'], 'ENDING', {
        statusChangedAt: '2026-08-25T12:10:00.000Z',
      });
      expect(ending?.statusChangedAt).toBe('2026-08-25T12:10:00.000Z');

      // Resuming a teardown from its own state keeps the time it began, which
      // is what an abandoned teardown is measured by.
      const resumed = await store.transition(created.sessionId, ['ENDING'], 'ENDING', {
        statusChangedAt: '2026-08-25T12:20:00.000Z',
      });
      expect(resumed?.status).toBe('ENDING');
      expect(resumed?.statusChangedAt).toBe('2026-08-25T12:10:00.000Z');
      expect((await store.get(created.sessionId))?.statusChangedAt).toBe('2026-08-25T12:10:00.000Z');

      // Activity is not a status change either.
      const active = session({ sessionId: 'sess-00000000000000h1', sandboxRef: 'jtt-lab-0000000000h1', status: 'ACTIVE' });
      await store.create(active);
      expect((await store.touchActivity(active.sessionId, HOUR_LATER))?.statusChangedAt).toBe(NOW);
    });

    it('refuses a transition whose status timestamp guard no longer matches', async () => {
      const store = await makeStore();
      const created = session({ status: 'ACTIVE' });
      await store.create(created);

      const first = await store.transition(created.sessionId, ['ACTIVE'], 'RESETTING', {
        statusChangedAt: '2026-08-25T12:01:00.000Z',
      });
      // The first claim is recovered and a second reset claims the same state.
      await store.transition(created.sessionId, ['RESETTING'], 'DEGRADED', {
        statusChangedAt: '2026-08-25T12:11:00.000Z',
      });
      await store.transition(created.sessionId, ['DEGRADED'], 'RESETTING', {
        statusChangedAt: '2026-08-25T12:12:00.000Z',
      });

      // Same status, different claim: the first reset cannot release it.
      expect(
        await store.transition(created.sessionId, ['RESETTING'], 'ACTIVE', {}, {
          statusChangedAt: first!.statusChangedAt,
        }),
      ).toBeNull();
      expect((await store.get(created.sessionId))?.status).toBe('RESETTING');

      // The current claim can.
      expect(
        (
          await store.transition(created.sessionId, ['RESETTING'], 'ACTIVE', {}, {
            statusChangedAt: '2026-08-25T12:12:00.000Z',
          })
        )?.status,
      ).toBe('ACTIVE');
    });

    it('stores DEGRADED as occupying, expirable, and closed to activity', async () => {
      const store = await makeStore();
      const created = session({ status: 'DEGRADED', lastActivityAt: '2026-08-25T11:00:00.000Z', idleTimeoutSeconds: 600 });
      await store.create(created);

      expect(await store.get(created.sessionId)).toEqual(created);
      expect(await store.countOccupying()).toBe(1);
      expect(await store.touchActivity(created.sessionId, HOUR_LATER)).toBeNull();
      expect((await store.listExpirable(NOW)).map((s) => s.sessionId)).toEqual([created.sessionId]);
    });

    /*
     * BETA-P0-006. Activity is accepted where a student can be working — ACTIVE,
     * and RESETTING, which they asked for — and nowhere else. "Occupying" was
     * the old rule, and it included ENDING and EXPIRING: an activity write
     * racing End landed on a row End had already claimed.
     */
    it('records no activity on a session that is being created or torn down', async () => {
      const store = await makeStore();
      const statuses = ['CREATING', 'ENDING', 'EXPIRING'] as const;
      for (const [i, status] of statuses.entries()) {
        await store.create(
          session({ sessionId: `sess-00000000000000g${i}`, sandboxRef: `jtt-lab-0000000000g${i}`, status }),
        );
      }

      for (const [i, status] of statuses.entries()) {
        const id = `sess-00000000000000g${i}`;
        expect(await store.touchActivity(id, HOUR_LATER)).toBeNull();
        expect(await store.get(id)).toMatchObject({ status, lastActivityAt: NOW });
      }
    });

    it('records activity during a reset', async () => {
      const store = await makeStore();
      const created = session({ status: 'RESETTING' });
      await store.create(created);

      expect((await store.touchActivity(created.sessionId, HOUR_LATER))?.lastActivityAt).toBe(
        HOUR_LATER,
      );
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

    // -------------------------------------------- per-student capacity (P0-009)

    const [ALICE, BOB, CAROL, DAVE] = CONTRACT_OWNERS as [string, string, string, string];

    it('refuses a student at their own limit, says which limit refused, and inserts nothing', async () => {
      const store = await makeStore();
      await store.create(seat('a1a1a1a1', 0, { ownerUserId: ALICE, status: 'ACTIVE' }));
      await store.create(seat('a1a1a1a1', 1, { ownerUserId: ALICE, status: 'ACTIVE' }));

      const third = seat('a1a1a1a1', 2, { ownerUserId: ALICE });
      expect(
        await store.createWithinLimits(third, { maxOccupying: 10, maxOccupyingPerOwner: 2 }),
      ).toEqual({ admitted: false, refusedBy: 'owner', occupying: 2, ownerOccupying: 2 });
      expect(await store.get(third.sessionId)).toBeNull();
      expect(await store.countOccupying()).toBe(2);
    });

    it('admits another student while one is at their limit', async () => {
      const store = await makeStore();
      await store.create(seat('b2b2b2b2', 0, { ownerUserId: ALICE, status: 'ACTIVE' }));

      const limits = { maxOccupying: 10, maxOccupyingPerOwner: 1 };
      expect((await store.createWithinLimits(seat('b2b2b2b2', 1, { ownerUserId: ALICE }), limits)).admitted).toBe(false);
      const bobs = seat('b2b2b2b2', 2, { ownerUserId: BOB });
      expect(await store.createWithinLimits(bobs, limits)).toEqual({ admitted: true });
      expect((await store.get(bobs.sessionId))?.ownerUserId).toBe(BOB);
    });

    it('admits exactly up to the per-student boundary', async () => {
      const store = await makeStore();
      const limits = { maxOccupying: 10, maxOccupyingPerOwner: 3 };
      const outcomes = [];
      for (let i = 0; i < 4; i += 1) {
        outcomes.push((await store.createWithinLimits(seat('c3c3c3c3', i, { ownerUserId: ALICE }), limits)).admitted);
      }
      expect(outcomes).toEqual([true, true, true, false]);
    });

    it('reports the global ceiling when the student still has room of their own', async () => {
      const store = await makeStore();
      await store.create(seat('d4d4d4d4', 0, { ownerUserId: ALICE, status: 'ACTIVE' }));
      await store.create(seat('d4d4d4d4', 1, { ownerUserId: BOB, status: 'ACTIVE' }));

      const candidate = seat('d4d4d4d4', 2, { ownerUserId: ALICE });
      expect(
        await store.createWithinLimits(candidate, { maxOccupying: 2, maxOccupyingPerOwner: 2 }),
      ).toEqual({ admitted: false, refusedBy: 'global', occupying: 2, ownerOccupying: 1 });
      expect(await store.get(candidate.sessionId)).toBeNull();
    });

    it('reports the per-student limit when both limits would refuse', async () => {
      const store = await makeStore();
      await store.create(seat('e5e5e5e5', 0, { ownerUserId: ALICE, status: 'ACTIVE' }));

      expect(
        await store.createWithinLimits(seat('e5e5e5e5', 1, { ownerUserId: ALICE }), {
          maxOccupying: 1,
          maxOccupyingPerOwner: 1,
        }),
      ).toMatchObject({ admitted: false, refusedBy: 'owner' });
    });

    it('counts every status that holds a sandbox against the student, and none that does not', async () => {
      const store = await makeStore();
      // DEGRADED (BETA-P0-007) may still hold some or all of its sandbox.
      const holding = ['CREATING', 'ACTIVE', 'RESETTING', 'DEGRADED', 'ENDING', 'EXPIRING'] as const;
      const released = ['ENDED', 'EXPIRED', 'FAILED'] as const;
      // Written out rather than imported, so a status silently joining or
      // leaving the occupying set fails here instead of passing with it.
      expect([...OCCUPYING_STATUSES].sort()).toEqual([...holding].sort());
      let i = 0;
      for (const status of [...holding, ...released]) {
        await store.create(seat('f6f6f6f6', i++, { ownerUserId: ALICE, status }));
      }

      // Six held, three released: a limit of seven leaves exactly one slot.
      const limits = { maxOccupying: 50, maxOccupyingPerOwner: holding.length + 1 };
      expect((await store.createWithinLimits(seat('f6f6f6f6', i++, { ownerUserId: ALICE }), limits)).admitted).toBe(true);
      expect(
        await store.createWithinLimits(seat('f6f6f6f6', i++, { ownerUserId: ALICE }), limits),
      ).toEqual({ admitted: false, refusedBy: 'owner', occupying: 7, ownerOccupying: 7 });
    });

    it('gives the student their slot back only once the session stops holding a sandbox', async () => {
      const store = await makeStore();
      const held = seat('a7a7a7a7', 0, { ownerUserId: ALICE, status: 'ACTIVE' });
      await store.create(held);
      const limits = { maxOccupying: 10, maxOccupyingPerOwner: 1 };

      // Teardown in flight: the sandbox still exists, so the slot is still taken.
      await store.transition(held.sessionId, ['ACTIVE'], 'ENDING');
      expect((await store.createWithinLimits(seat('a7a7a7a7', 1, { ownerUserId: ALICE }), limits)).admitted).toBe(false);

      await store.transition(held.sessionId, ['ENDING'], 'ENDED');
      expect((await store.createWithinLimits(seat('a7a7a7a7', 2, { ownerUserId: ALICE }), limits)).admitted).toBe(true);
    });

    it('applies no per-student limit to a session without an owner, but still the global one', async () => {
      const store = await makeStore();
      const limits = { maxOccupying: 3, maxOccupyingPerOwner: 1 };
      const outcomes = [];
      for (let i = 0; i < 4; i += 1) {
        outcomes.push(await store.createWithinLimits(seat('b8b8b8b8', i), limits));
      }
      expect(outcomes.map((o) => o.admitted)).toEqual([true, true, true, false]);
      expect(outcomes[3]).toMatchObject({ refusedBy: 'global', ownerOccupying: 0 });
    });

    it('treats an unset per-student limit as no limit', async () => {
      const store = await makeStore();
      for (let i = 0; i < 5; i += 1) {
        expect((await store.createWithinLimits(seat('c9c9c9c9', i, { ownerUserId: ALICE }), { maxOccupying: 5 })).admitted).toBe(true);
      }
      expect(
        await store.createWithinLimits(seat('c9c9c9c9', 5, { ownerUserId: ALICE }), { maxOccupying: 5 }),
      ).toMatchObject({ admitted: false, refusedBy: 'global' });
    });

    it("holds one student's limit when their starts arrive together", async () => {
      const store = await makeStore();
      const decisions = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          store.createWithinLimits(seat('dadadada', i, { ownerUserId: ALICE }), {
            maxOccupying: 20,
            maxOccupyingPerOwner: 3,
          }),
        ),
      );

      expect(decisions.filter((d) => d.admitted)).toHaveLength(3);
      expect(decisions.filter((d) => !d.admitted && d.refusedBy === 'owner')).toHaveLength(5);
      expect(await store.countOccupying()).toBe(3);
    });

    it('admits different students together up to the global ceiling', async () => {
      const store = await makeStore();
      const owners = [ALICE, BOB, CAROL, DAVE];
      // Four students, three starts each, two each allowed: exactly eight fit
      // and the global ceiling of eight never has to refuse anyone.
      const candidates = owners.flatMap((owner, o) =>
        Array.from({ length: 3 }, (_, i) => seat('ebebebeb', o * 10 + i, { ownerUserId: owner })),
      );
      const decisions = await Promise.all(
        candidates.map((c) => store.createWithinLimits(c, { maxOccupying: 8, maxOccupyingPerOwner: 2 })),
      );

      expect(decisions.filter((d) => d.admitted)).toHaveLength(8);
      expect(decisions.filter((d) => !d.admitted).every((d) => !d.admitted && d.refusedBy === 'owner')).toBe(true);
      const occupying = await store.listOccupying();
      for (const owner of owners) {
        expect(occupying.filter((s) => s.ownerUserId === owner)).toHaveLength(2);
      }
    });

    it('holds the global ceiling when students under their own limits arrive together', async () => {
      const store = await makeStore();
      const owners = [ALICE, BOB, CAROL, DAVE];
      const candidates = owners.flatMap((owner, o) =>
        Array.from({ length: 3 }, (_, i) => seat('fcfcfcfc', o * 10 + i, { ownerUserId: owner })),
      );
      const decisions = await Promise.all(
        candidates.map((c) => store.createWithinLimits(c, { maxOccupying: 5, maxOccupyingPerOwner: 2 })),
      );

      expect(decisions.filter((d) => d.admitted)).toHaveLength(5);
      expect(await store.countOccupying()).toBe(5);
      const occupying = await store.listOccupying();
      for (const owner of owners) {
        expect(occupying.filter((s) => s.ownerUserId === owner).length).toBeLessThanOrEqual(2);
      }
    });
  });
}

/**
 * Owners the per-student tests start sessions for.
 *
 * UUIDs because `owner_user_id` is a UUID with a foreign key to `users`; the
 * PostgreSQL run inserts these rows before the contract runs.
 */
export const CONTRACT_OWNERS: readonly string[] = [
  '00000000-0000-4000-8000-00000000a11c',
  '00000000-0000-4000-8000-000000000b0b',
  '00000000-0000-4000-8000-0000000ca201',
  '00000000-0000-4000-8000-0000000da7e0',
  '00000000-0000-4000-8000-0000000e7e00',
];

/**
 * A session with an id and sandbox handle unique to `(tag, index)`.
 *
 * `tag` is eight hex characters, so the last twelve characters — which
 * `session()` derives the sandbox handle from — never repeat.
 */
export function seat(tag: string, index: number, overrides: Partial<LabSession> = {}): LabSession {
  const sessionId = `sess-0000${tag}${String(index).padStart(4, '0')}`;
  return session({ sessionId, ...overrides });
}

sessionStoreContract('InMemorySessionStore', () => new InMemorySessionStore());
