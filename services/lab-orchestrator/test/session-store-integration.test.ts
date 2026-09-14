/**
 * PLATFORM-008 — the durable session store, against a real PostgreSQL.
 *
 * Gated on RUN_DB_TESTS so `npm test` stays hermetic:
 *
 *   RUN_DB_TESTS=1 \
 *   TEST_DATABASE_URL=postgresql://test:test@localhost:55450/jumptotech_labs_test \
 *   npx vitest run --root services/lab-orchestrator test/session-store-integration.test.ts
 *
 * Two things are proved here that a double cannot prove. The first is that the
 * migration produces a schema the store can actually use. The second is
 * concurrency: the in-memory store is single-threaded, so "exactly one caller
 * wins" is trivially true there and means nothing — the question is whether two
 * *connections* racing on one row resolve to one outcome, and only a real
 * database can answer it.
 *
 * Each test runs in its own schema, so a run cannot see another run's rows and
 * two runs on one server do not collide.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresDatabase, migrate } from '@jumptotech/progress';
import {
  OCCUPYING_STATUSES,
  PostgresSessionStore,
  type CapacityDecision,
  type LabSession,
} from '../src/index.js';
import {
  CONTRACT_OWNERS,
  seat,
  session,
  sessionStoreContract,
} from './session-store-contract.test.js';
import { sessionLifecycleRaces } from './session-lifecycle-races.test.js';
import { sessionRecovery } from './session-recovery.test.js';
import { perStudentCapacity } from './session-per-student-capacity.test.js';

const url = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === '1' && typeof url === 'string' && url.length > 0;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.log(
    '[session-store-integration] skipped — set RUN_DB_TESTS=1 and TEST_DATABASE_URL to run',
  );
  describe.skip('durable session store (needs PostgreSQL)', () => {
    it('needs RUN_DB_TESTS=1 and TEST_DATABASE_URL', () => undefined);
  });
} else {
  let database: PostgresDatabase;

  beforeAll(async () => {
    database = PostgresDatabase.fromConfig({
      url: url!,
      ssl: false,
      maxConnections: 8,
      connectionTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      statementTimeoutMs: 30_000,
      applicationName: 'jtt-session-store-tests',
    });
    await migrate(database);
    // `owner_user_id` references `users`, so the owners the per-student tests
    // start sessions for have to exist first.
    for (const [i, userId] of CONTRACT_OWNERS.entries()) {
      await database.query(
        `INSERT INTO users (user_id, issuer, subject) VALUES ($1, 'urn:jumptotech:test', $2)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, `session-store-owner-${i}`],
      );
    }
  }, 120_000);

  afterAll(async () => {
    await database?.close?.();
  });

  const fresh = async (): Promise<PostgresSessionStore> => {
    await database.query('TRUNCATE lab_sessions');
    return new PostgresSessionStore(database);
  };

  // The same contract the in-memory store satisfies, against real SQL.
  sessionStoreContract('PostgresSessionStore', fresh);

  // BETA-P0-006: the manager's lifecycle races, decided by PostgreSQL. Each
  // "instance" reaches the row through its own pooled connections.
  sessionLifecycleRaces('PostgresSessionStore', fresh);

  // BETA-P0-007: interrupted operations recovered, with the claims and their
  // status timestamps decided by PostgreSQL.
  sessionRecovery('PostgresSessionStore', fresh);

  // BETA-P0-009: the per-student limit through two managers, each standing for
  // an API instance with a pool of its own — so no two starts share a backend
  // by construction, and every admission is decided by PostgreSQL.
  const instancePools: PostgresDatabase[] = [];
  const instancePool = (name: string): PostgresDatabase => {
    const pool = PostgresDatabase.fromConfig({
      url: url!,
      ssl: false,
      maxConnections: 3,
      connectionTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      statementTimeoutMs: 30_000,
      applicationName: name,
    });
    instancePools.push(pool);
    return pool;
  };
  afterAll(async () => {
    await Promise.all(instancePools.map((pool) => pool.close().catch(() => undefined)));
  });
  let apiA: PostgresDatabase | undefined;
  let apiB: PostgresDatabase | undefined;
  perStudentCapacity(
    'PostgresSessionStore, two API instances',
    async () => {
      apiA ??= instancePool('jtt-per-student-api-a');
      apiB ??= instancePool('jtt-per-student-api-b');
      await database.query('TRUNCATE lab_sessions');
      return { a: new PostgresSessionStore(apiA), b: new PostgresSessionStore(apiB) };
    },
    CONTRACT_OWNERS,
  );

  describe('durable session store — persistence and recovery', () => {
    beforeEach(async () => {
      await database.query('TRUNCATE lab_sessions');
    });

    it('survives the process that created it', async () => {
      // The restart, modelled honestly: the row is written through one store
      // instance and read through a completely separate one, exactly as a new
      // API process would.
      const writer = new PostgresSessionStore(database);
      const created = session({ status: 'ACTIVE', environmentId: 'kind:x/y#LINUX-001' });
      await writer.create(created);

      const afterRestart = new PostgresSessionStore(database);
      expect(await afterRestart.get(created.sessionId)).toEqual(created);
    });

    it('lets a second instance resolve and advance a session the first started', async () => {
      const apiA = new PostgresSessionStore(database);
      const apiB = new PostgresSessionStore(database);
      const created = session({ status: 'CREATING' });
      await apiA.create(created);

      // B reads what A wrote, and moves it on.
      expect((await apiB.get(created.sessionId))?.status).toBe('CREATING');
      expect((await apiB.transition(created.sessionId, ['CREATING'], 'ACTIVE'))?.status).toBe(
        'ACTIVE',
      );

      // And A sees B's change: no process-local copy is authoritative.
      expect((await apiA.get(created.sessionId))?.status).toBe('ACTIVE');
    });

    it('refuses a stale write from an instance holding an old copy', async () => {
      const apiA = new PostgresSessionStore(database);
      const apiB = new PostgresSessionStore(database);
      const created = session({ status: 'ACTIVE' });
      await apiA.create(created);

      // B ends it.
      await apiB.transition(created.sessionId, ['ACTIVE'], 'ENDED');

      // A, still believing the session is ACTIVE, tries to reset it. The
      // conditional write matches nothing — an in-flight request cannot undo a
      // completed teardown.
      expect(await apiA.transition(created.sessionId, ['ACTIVE'], 'RESETTING')).toBeNull();
      expect((await apiA.get(created.sessionId))?.status).toBe('ENDED');
    });
  });

  describe('durable session store — real concurrency', () => {
    beforeEach(async () => {
      await database.query('TRUNCATE lab_sessions');
    });

    it('lets exactly one of two connections end the same session', async () => {
      const store = new PostgresSessionStore(database);
      const created = session({ status: 'ACTIVE' });
      await store.create(created);

      // Two independent connections from the pool, racing.
      const [a, b] = await Promise.all([
        new PostgresSessionStore(database).transition(created.sessionId, ['ACTIVE'], 'ENDING'),
        new PostgresSessionStore(database).transition(created.sessionId, ['ACTIVE'], 'ENDING'),
      ]);

      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect((await store.get(created.sessionId))?.status).toBe('ENDING');
    });

    it('lets exactly one of two reapers claim the same expired session', async () => {
      const store = new PostgresSessionStore(database);
      const expired = session({ status: 'ACTIVE', expiresAt: '2020-01-01T00:00:00.000Z' });
      await store.create(expired);

      const now = '2026-08-25T12:00:00.000Z';
      const [seenByA, seenByB] = await Promise.all([
        new PostgresSessionStore(database).listExpirable(now),
        new PostgresSessionStore(database).listExpirable(now),
      ]);
      // Both *see* it — discovery is not the exclusion mechanism.
      expect(seenByA).toHaveLength(1);
      expect(seenByB).toHaveLength(1);

      // Claiming it is. Exactly one reaper proceeds to tear down.
      const [claimA, claimB] = await Promise.all([
        new PostgresSessionStore(database).transition(expired.sessionId, ['ACTIVE'], 'EXPIRING'),
        new PostgresSessionStore(database).transition(expired.sessionId, ['ACTIVE'], 'EXPIRING'),
      ]);
      expect([claimA, claimB].filter(Boolean)).toHaveLength(1);
    });

    it('holds capacity across connections that all see a free slot', async () => {
      const candidates: LabSession[] = Array.from({ length: 6 }, (_, i) =>
        session({
          sessionId: `sess-000000000000cc${i}`,
          sandboxRef: `jtt-lab-000000cc000${i}`,
          namespace: `jtt-lab-000000cc000${i}`,
          status: 'CREATING',
        }),
      );

      // Six starts arriving together on six connections, limit of three.
      const admitted = await Promise.all(
        candidates.map((c) => new PostgresSessionStore(database).createWithinCapacity(c, 3)),
      );

      expect(admitted.filter(Boolean)).toHaveLength(3);
      expect(await new PostgresSessionStore(database).countOccupying()).toBe(3);
    });

    /*
     * BETA-P0-004. The test above leaves the interleaving to the pool's
     * scheduling, so it never establishes that two starts overlapped between
     * count and insert — it passed against the store this story fixed. The two
     * tests below each force one half of the race.
     *
     * This one proves the lock serialises the decision across separate
     * backends. The gate is a table lock that admits reads and blocks inserts. Every
     * start can therefore get as far as its INSERT and no further, and the test
     * waits — on PostgreSQL's own lock table, not on a timer — until every start
     * is blocked. At that point the invariant is observable directly: a start
     * that has counted must still hold the capacity lock, so at most one can be
     * waiting on the table while the rest wait on the advisory lock. Opening the
     * gate then shows the consequence: one slot, one admission.
     */
    it('admits exactly one start into the last slot when every start reaches its insert', async () => {
      const LIMIT = 5;
      const STARTS = 6;
      const RACERS = 'jtt-capacity-race';

      const store = new PostgresSessionStore(database);
      for (let i = 0; i < LIMIT - 1; i += 1) {
        await store.create(
          session({ sessionId: `sess-00000000000ee${i}`, sandboxRef: `jtt-lab-000000ee000${i}`, status: 'ACTIVE' }),
        );
      }

      // Its own pool, big enough that no start waits for a client, and named so
      // its backends can be picked out of pg_stat_activity.
      const racers = PostgresDatabase.fromConfig({
        url: url!,
        ssl: false,
        maxConnections: STARTS + 4,
        connectionTimeoutMs: 10_000,
        idleTimeoutMs: 10_000,
        statementTimeoutMs: 30_000,
        applicationName: RACERS,
      });

      let openGate!: () => void;
      const gateReleased = new Promise<void>((resolve) => (openGate = resolve));
      let gateHeld!: () => void;
      const gateReady = new Promise<void>((resolve) => (gateHeld = resolve));
      const gate = database.transaction(async (tx) => {
        await tx.query('LOCK TABLE lab_sessions IN SHARE ROW EXCLUSIVE MODE');
        gateHeld();
        await gateReleased;
      });

      try {
        await gateReady;

        const attempts = Array.from({ length: STARTS }, (_, i) =>
          new PostgresSessionStore(racers).createWithinCapacity(
            session({ sessionId: `sess-00000000000ff${i}`, sandboxRef: `jtt-lab-000000ff000${i}` }),
            LIMIT,
          ),
        );

        const blocked = async (): Promise<Record<string, number>> => {
          const { rows } = await database.query<{ locktype: string; waiting: number }>(
            `SELECT l.locktype, count(DISTINCT l.pid)::int AS waiting
               FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
              WHERE NOT l.granted AND a.application_name = $1
              GROUP BY l.locktype`,
            [RACERS],
          );
          return Object.fromEntries(rows.map((r) => [r.locktype, r.waiting]));
        };

        let waiting: Record<string, number> = {};
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          waiting = await blocked();
          const total = Object.values(waiting).reduce((sum, n) => sum + n, 0);
          if (total >= STARTS) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        // Every start is parked in PostgreSQL, so the race is fully set up.
        expect(Object.values(waiting).reduce((sum, n) => sum + n, 0)).toBe(STARTS);
        // Only the start holding the capacity lock may have counted and gone on
        // to insert; everyone else is still waiting to count.
        expect(waiting).toEqual({ relation: 1, advisory: STARTS - 1 });

        openGate();
        let timer: NodeJS.Timeout | undefined;
        const settled = await Promise.race([
          Promise.allSettled(attempts),
          new Promise<'hung'>((resolve) => {
            timer = setTimeout(() => resolve('hung'), 15_000);
          }),
        ]);
        clearTimeout(timer);
        expect(settled, 'starts still blocked 15s after the gate opened').not.toBe('hung');

        const outcomes = settled as PromiseSettledResult<boolean>[];
        // Refusals are the ordinary `false`, not errors.
        expect(outcomes.every((o) => o.status === 'fulfilled')).toBe(true);
        expect(outcomes.filter((o) => o.status === 'fulfilled' && o.value)).toHaveLength(1);

        // Committed rows, read from a connection that took no part in the race.
        expect(await store.countOccupying()).toBe(LIMIT);
        expect((await store.list()).length).toBe(LIMIT);

        // Nothing left behind: no connection parked mid-transaction, no lock.
        const { rows: leftovers } = await database.query<{ open: number; locks: number }>(
          `SELECT
             (SELECT count(*)::int FROM pg_stat_activity
               WHERE application_name = $1 AND state LIKE 'idle in transaction%') AS open,
             (SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory') AS locks`,
          [RACERS],
        );
        expect(leftovers[0]).toEqual({ open: 0, locks: 0 });
      } finally {
        openGate();
        await gate.catch(() => undefined);
        // A broken store can leave a backend waiting forever; closing the pool
        // would then wait with it.
        await database.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1',
          [RACERS],
        );
        await racers.close().catch(() => undefined);
      }
    }, 60_000);

    /*
     * The test above cannot catch a store that sends its statements through the
     * pool one at a time, because it keeps every other start parked on its own
     * connection: the lock holder's client is then the only idle one, and every
     * statement it sends lands back on it by accident.
     *
     * Production does not look like that. The pool is shared with every other
     * query the API makes, and once it is contended a released client goes to
     * whoever is queued next — so start A's BEGIN, start B's lock and start A's
     * count can all travel on one connection, where the advisory lock is
     * re-entrant and admits both. A pool smaller than the number of starts makes
     * that hand-off happen on every statement, deterministically: pg-pool
     * serves its queue in order.
     */
    it.each([1, 2, 3])(
      'admits exactly one start into the last slot when %i pooled connection(s) serve every start',
      async (connections) => {
        const LIMIT = 5;
        const STARTS = 6;
        const CONTENDED = `jtt-capacity-contended-${connections}`;

        const store = new PostgresSessionStore(database);
        for (let i = 0; i < LIMIT - 1; i += 1) {
          await store.create(
            session({ sessionId: `sess-00000000000hh${i}`, sandboxRef: `jtt-lab-000000hh000${i}`, status: 'ACTIVE' }),
          );
        }

        const pool = PostgresDatabase.fromConfig({
          url: url!,
          ssl: false,
          maxConnections: connections,
          connectionTimeoutMs: 10_000,
          idleTimeoutMs: 10_000,
          statementTimeoutMs: 30_000,
          applicationName: CONTENDED,
        });
        try {
          let timer: NodeJS.Timeout | undefined;
          const settled = await Promise.race([
            Promise.allSettled(
              Array.from({ length: STARTS }, (_, i) =>
                new PostgresSessionStore(pool).createWithinCapacity(
                  session({ sessionId: `sess-00000000000ii${i}`, sandboxRef: `jtt-lab-000000ii000${i}` }),
                  LIMIT,
                ),
              ),
            ),
            new Promise<'hung'>((resolve) => {
              timer = setTimeout(() => resolve('hung'), 15_000);
            }),
          ]);
          clearTimeout(timer);
          expect(settled, 'starts still blocked after 15s').not.toBe('hung');

          const outcomes = settled as PromiseSettledResult<boolean>[];
          expect(outcomes.every((o) => o.status === 'fulfilled')).toBe(true);
          expect(outcomes.filter((o) => o.status === 'fulfilled' && o.value)).toHaveLength(1);
          expect(await store.countOccupying()).toBe(LIMIT);
          expect((await store.list()).length).toBe(LIMIT);

          const { rows } = await database.query<{ open: number; locks: number }>(
            `SELECT
               (SELECT count(*)::int FROM pg_stat_activity
                 WHERE application_name = $1 AND state LIKE 'idle in transaction%') AS open,
               (SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory') AS locks`,
            [CONTENDED],
          );
          expect(rows[0]).toEqual({ open: 0, locks: 0 });
        } finally {
          await database.query(
            'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1',
            [CONTENDED],
          );
          await pool.close().catch(() => undefined);
        }
      },
      60_000,
    );

    it('gives the slot back when the insert fails, and leaves no transaction open', async () => {
      const INSERTERS = 'jtt-capacity-insert-failure';
      const pool = PostgresDatabase.fromConfig({
        url: url!,
        ssl: false,
        maxConnections: 2,
        connectionTimeoutMs: 10_000,
        idleTimeoutMs: 10_000,
        statementTimeoutMs: 30_000,
        applicationName: INSERTERS,
      });
      try {
        const store = new PostgresSessionStore(pool);
        const first = session({ sessionId: 'sess-00000000000gg1', sandboxRef: 'jtt-lab-0000000gg001' });
        const clash = session({ sessionId: 'sess-00000000000gg2', sandboxRef: first.sandboxRef });
        const next = session({ sessionId: 'sess-00000000000gg3', sandboxRef: 'jtt-lab-0000000gg003' });

        expect(await store.createWithinCapacity(first, 2)).toBe(true);
        // Admitted by the count, then refused by the unique sandbox handle.
        await expect(store.createWithinCapacity(clash, 2)).rejects.toThrow(/already exists/);
        expect(await store.get(clash.sessionId)).toBeNull();

        // The failed insert consumed nothing and released the lock: the last
        // slot is still there for the next start.
        expect(await store.createWithinCapacity(next, 2)).toBe(true);
        expect(await store.countOccupying()).toBe(2);

        const { rows } = await database.query<{ open: number; locks: number }>(
          `SELECT
             (SELECT count(*)::int FROM pg_stat_activity
               WHERE application_name = $1 AND state LIKE 'idle in transaction%') AS open,
             (SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory') AS locks`,
          [INSERTERS],
        );
        expect(rows[0]).toEqual({ open: 0, locks: 0 });
        // Every client went back to the pool.
        expect(pool.poolStats()).toMatchObject({ waiting: 0 });
        expect(pool.poolStats().idle).toBe(pool.poolStats().total);
      } finally {
        await pool.close().catch(() => undefined);
      }
    });

    it('refuses two sessions claiming one sandbox, even from separate connections', async () => {
      const a = session({ sessionId: 'sess-000000000000dd1', sandboxRef: 'jtt-lab-00000000dd11' });
      const b = session({ sessionId: 'sess-000000000000dd2', sandboxRef: 'jtt-lab-00000000dd11' });

      const results = await Promise.allSettled([
        new PostgresSessionStore(database).create(a),
        new PostgresSessionStore(database).create(b),
      ]);

      // The database decides, not the application: one insert, one rejection.
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await new PostgresSessionStore(database).countOccupying()).toBe(1);
    });
  });

  /*
   * BETA-P0-009 — the per-student limit against real connections.
   *
   * The same two proofs the global ceiling has above, for the owner's count:
   * one that parks every start inside PostgreSQL before releasing them, so the
   * overlap is established rather than hoped for, and one that forces pooled
   * connections to be handed between starts statement by statement. Then the
   * shape production actually has — two API instances, each with its own pool,
   * one student or many.
   */
  describe('durable session store — per-student capacity under real concurrency', () => {
    const [ALICE, BOB, CAROL, DAVE, ERIN] = CONTRACT_OWNERS as [string, string, string, string, string];

    beforeEach(async () => {
      await database.query('TRUNCATE lab_sessions');
    });

    const poolFor = (applicationName: string, maxConnections: number) =>
      PostgresDatabase.fromConfig({
        url: url!,
        ssl: false,
        maxConnections,
        connectionTimeoutMs: 10_000,
        idleTimeoutMs: 10_000,
        statementTimeoutMs: 30_000,
        applicationName,
      });

    /** Settle every start, failing the test rather than hanging if one never returns. */
    const settleAll = async (
      attempts: Promise<CapacityDecision>[],
    ): Promise<CapacityDecision[]> => {
      let timer: NodeJS.Timeout | undefined;
      const settled = await Promise.race([
        Promise.allSettled(attempts),
        new Promise<'hung'>((resolve) => {
          timer = setTimeout(() => resolve('hung'), 15_000);
        }),
      ]);
      clearTimeout(timer);
      expect(settled, 'starts still blocked after 15s').not.toBe('hung');
      const outcomes = settled as PromiseSettledResult<CapacityDecision>[];
      // A refusal is an ordinary decision, never an error.
      expect(outcomes.filter((o) => o.status === 'rejected')).toEqual([]);
      return outcomes.map((o) => (o as PromiseFulfilledResult<CapacityDecision>).value);
    };

    /** Occupying sessions per owner, read from a connection that took no part. */
    const heldPerOwner = async (): Promise<Record<string, number>> => {
      const { rows } = await database.query<{ owner: string | null; held: number }>(
        `SELECT owner_user_id::text AS owner, count(*)::int AS held
           FROM lab_sessions WHERE status = ANY($1) GROUP BY owner_user_id`,
        [[...OCCUPYING_STATUSES]],
      );
      return Object.fromEntries(rows.map((r) => [r.owner ?? 'none', r.held]));
    };

    /** Nothing left behind by `applicationName`: no open transaction, no advisory lock. */
    const expectNothingLeftOpen = async (applicationName: string) => {
      const { rows } = await database.query<{ open: number; locks: number }>(
        `SELECT
           (SELECT count(*)::int FROM pg_stat_activity
             WHERE application_name = $1 AND state LIKE 'idle in transaction%') AS open,
           (SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory') AS locks`,
        [applicationName],
      );
      expect(rows[0]).toEqual({ open: 0, locks: 0 });
    };

    it("admits exactly one start into a student's last slot when every start reaches its insert", async () => {
      const STARTS = 6;
      const RACERS = 'jtt-per-student-race';
      const store = new PostgresSessionStore(database);
      // Alice holds one of her two; Bob's sessions show the global count is not
      // what decides this.
      await store.create(seat('11111111', 0, { ownerUserId: ALICE, status: 'ACTIVE' }));
      for (let i = 0; i < 3; i += 1) {
        await store.create(seat('22222222', i, { ownerUserId: BOB, status: 'ACTIVE' }));
      }

      const racers = poolFor(RACERS, STARTS + 4);
      let openGate!: () => void;
      const gateReleased = new Promise<void>((resolve) => (openGate = resolve));
      let gateHeld!: () => void;
      const gateReady = new Promise<void>((resolve) => (gateHeld = resolve));
      // Admits reads, blocks inserts: every start can count and get no further.
      const gate = database.transaction(async (tx) => {
        await tx.query('LOCK TABLE lab_sessions IN SHARE ROW EXCLUSIVE MODE');
        gateHeld();
        await gateReleased;
      });

      try {
        await gateReady;
        const attempts = Array.from({ length: STARTS }, (_, i) =>
          new PostgresSessionStore(racers).createWithinLimits(
            seat('33333333', i, { ownerUserId: ALICE }),
            { maxOccupying: 50, maxOccupyingPerOwner: 2 },
          ),
        );

        let waiting: Record<string, number> = {};
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const { rows } = await database.query<{ locktype: string; waiting: number }>(
            `SELECT l.locktype, count(DISTINCT l.pid)::int AS waiting
               FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
              WHERE NOT l.granted AND a.application_name = $1
              GROUP BY l.locktype`,
            [RACERS],
          );
          waiting = Object.fromEntries(rows.map((r) => [r.locktype, r.waiting]));
          if (Object.values(waiting).reduce((sum, n) => sum + n, 0) >= STARTS) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        // Every start is parked in PostgreSQL. Only the one holding the capacity
        // lock has counted Alice's sessions; the rest have not counted yet.
        expect(waiting).toEqual({ relation: 1, advisory: STARTS - 1 });

        openGate();
        const decisions = await settleAll(attempts);
        expect(decisions.filter((d) => d.admitted)).toHaveLength(1);
        expect(decisions.filter((d) => !d.admitted)).toEqual(
          Array.from({ length: STARTS - 1 }, () => ({
            admitted: false,
            refusedBy: 'owner',
            occupying: 5,
            ownerOccupying: 2,
          })),
        );
        expect(await heldPerOwner()).toEqual({ [ALICE]: 2, [BOB]: 3 });
        await expectNothingLeftOpen(RACERS);
      } finally {
        openGate();
        await gate.catch(() => undefined);
        await database.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1',
          [RACERS],
        );
        await racers.close().catch(() => undefined);
      }
    }, 60_000);

    it.each([1, 2, 3])(
      "admits exactly one start into a student's last slot when %i pooled connection(s) serve every start",
      async (connections) => {
        const STARTS = 6;
        const CONTENDED = `jtt-per-student-contended-${connections}`;
        await new PostgresSessionStore(database).create(
          seat('44444444', 0, { ownerUserId: ALICE, status: 'ACTIVE' }),
        );

        const pool = poolFor(CONTENDED, connections);
        try {
          const decisions = await settleAll(
            Array.from({ length: STARTS }, (_, i) =>
              new PostgresSessionStore(pool).createWithinLimits(
                seat('55555555', i, { ownerUserId: ALICE }),
                { maxOccupying: 50, maxOccupyingPerOwner: 2 },
              ),
            ),
          );

          expect(decisions.filter((d) => d.admitted)).toHaveLength(1);
          expect(decisions.filter((d) => !d.admitted && d.refusedBy === 'owner')).toHaveLength(STARTS - 1);
          expect(await heldPerOwner()).toEqual({ [ALICE]: 2 });
          await expectNothingLeftOpen(CONTENDED);
        } finally {
          await database.query(
            'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1',
            [CONTENDED],
          );
          await pool.close().catch(() => undefined);
        }
      },
      60_000,
    );

    it('holds one student to their limit across two API instances with separate pools', async () => {
      const apiA = poolFor('jtt-per-student-instance-a', 3);
      const apiB = poolFor('jtt-per-student-instance-b', 3);
      try {
        const decisions = await settleAll(
          Array.from({ length: 12 }, (_, i) =>
            new PostgresSessionStore(i % 2 === 0 ? apiA : apiB).createWithinLimits(
              seat('66666666', i, { ownerUserId: ALICE }),
              { maxOccupying: 50, maxOccupyingPerOwner: 3 },
            ),
          ),
        );

        expect(decisions.filter((d) => d.admitted)).toHaveLength(3);
        expect(decisions.filter((d) => !d.admitted && d.refusedBy === 'owner')).toHaveLength(9);
        expect(await heldPerOwner()).toEqual({ [ALICE]: 3 });
        await expectNothingLeftOpen('jtt-per-student-instance-a');
        await expectNothingLeftOpen('jtt-per-student-instance-b');
      } finally {
        await Promise.all([apiA.close(), apiB.close()].map((p) => p.catch(() => undefined)));
      }
    }, 60_000);

    it('admits many students together across two instances, each to their own limit, when the platform has room', async () => {
      const owners = [ALICE, BOB, CAROL, DAVE, ERIN];
      const apiA = poolFor('jtt-per-student-many-a', 3);
      const apiB = poolFor('jtt-per-student-many-b', 3);
      try {
        // Five students, four starts each, two allowed each: ten fit exactly
        // under a ceiling of ten, so no refusal may be the platform's.
        const decisions = await settleAll(
          Array.from({ length: 20 }, (_, i) =>
            new PostgresSessionStore(i % 2 === 0 ? apiA : apiB).createWithinLimits(
              seat('77777777', i, { ownerUserId: owners[i % owners.length]! }),
              { maxOccupying: 10, maxOccupyingPerOwner: 2 },
            ),
          ),
        );

        expect(decisions.filter((d) => d.admitted)).toHaveLength(10);
        expect(decisions.filter((d) => !d.admitted && d.refusedBy === 'owner')).toHaveLength(10);
        expect(await heldPerOwner()).toEqual(Object.fromEntries(owners.map((o) => [o, 2])));
      } finally {
        await Promise.all([apiA.close(), apiB.close()].map((p) => p.catch(() => undefined)));
      }
    }, 60_000);

    it('keeps the global ceiling authoritative when students under their own limits start together', async () => {
      const owners = [ALICE, BOB, CAROL, DAVE, ERIN];
      const apiA = poolFor('jtt-per-student-global-a', 3);
      const apiB = poolFor('jtt-per-student-global-b', 3);
      try {
        const decisions = await settleAll(
          Array.from({ length: 20 }, (_, i) =>
            new PostgresSessionStore(i % 2 === 0 ? apiA : apiB).createWithinLimits(
              seat('88888888', i, { ownerUserId: owners[i % owners.length]! }),
              { maxOccupying: 7, maxOccupyingPerOwner: 2 },
            ),
          ),
        );

        expect(decisions.filter((d) => d.admitted)).toHaveLength(7);
        expect(await new PostgresSessionStore(database).countOccupying()).toBe(7);
        const held = await heldPerOwner();
        expect(Object.values(held).reduce((sum, n) => sum + n, 0)).toBe(7);
        for (const count of Object.values(held)) expect(count).toBeLessThanOrEqual(2);
        // Once seven are in, every later start is refused by the ceiling unless
        // its student was already full.
        expect(decisions.some((d) => !d.admitted && d.refusedBy === 'global')).toBe(true);
      } finally {
        await Promise.all([apiA.close(), apiB.close()].map((p) => p.catch(() => undefined)));
      }
    }, 60_000);

    it('releases a student slot for the session that ended, and not for the one still tearing down', async () => {
      const store = new PostgresSessionStore(database);
      const ending = seat('99999999', 0, { ownerUserId: ALICE, status: 'ACTIVE' });
      const ended = seat('99999999', 1, { ownerUserId: ALICE, status: 'ACTIVE' });
      await store.create(ending);
      await store.create(ended);
      await store.create(seat('99999999', 2, { ownerUserId: ALICE, status: 'FAILED' }));
      const limits = { maxOccupying: 50, maxOccupyingPerOwner: 2 };

      // Read through a second instance: nothing about the answer is process-local.
      const other = new PostgresSessionStore(database);
      expect(await other.createWithinLimits(seat('99999999', 3, { ownerUserId: ALICE }), limits)).toMatchObject({
        admitted: false,
        refusedBy: 'owner',
        ownerOccupying: 2,
      });

      await store.transition(ending.sessionId, ['ACTIVE'], 'ENDING');
      await store.transition(ended.sessionId, ['ACTIVE'], 'ENDING');
      await store.transition(ended.sessionId, ['ENDING'], 'ENDED');

      expect(await other.createWithinLimits(seat('99999999', 4, { ownerUserId: ALICE }), limits)).toEqual({
        admitted: true,
      });
      expect(await other.createWithinLimits(seat('99999999', 5, { ownerUserId: ALICE }), limits)).toMatchObject({
        admitted: false,
        refusedBy: 'owner',
      });
      expect(await heldPerOwner()).toEqual({ [ALICE]: 2 });
    });

    it('still counts a session without an owner towards the global ceiling', async () => {
      const store = new PostgresSessionStore(database);
      await store.create(session({ sessionId: 'sess-0000aaaa00000000', status: 'ACTIVE' }));

      expect(
        await store.createWithinLimits(seat('aaaaaaaa', 1, { ownerUserId: ALICE }), {
          maxOccupying: 1,
          maxOccupyingPerOwner: 5,
        }),
      ).toEqual({ admitted: false, refusedBy: 'global', occupying: 1, ownerOccupying: 0 });
    });
  });
}
