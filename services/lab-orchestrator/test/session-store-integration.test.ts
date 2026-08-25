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
import { PostgresSessionStore, type LabSession } from '../src/index.js';
import { sessionStoreContract, session } from './session-store-contract.test.js';

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
}
