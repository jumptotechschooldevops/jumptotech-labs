/**
 * Session events against a real PostgreSQL — migration 008.
 *
 * What the in-memory double cannot prove: the table's own refusals (a code
 * that is prose, an operation or outcome outside the closed sets), that
 * `DISTINCT ON` really answers "newest per (session, operation)", that the
 * store writes a non-UUID owner as NULL rather than failing the operation it
 * records, and that the purge removes by age only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresDatabase, migrate } from '@jumptotech/progress';

import { PostgresUserRepository } from '../src/auth/users.js';
import { PostgresSessionEventStore } from '../src/classroom/session-events.js';

const url = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === '1' && typeof url === 'string' && url.length > 0;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.log('[session-events-persistence] skipped — set RUN_DB_TESTS=1 and TEST_DATABASE_URL to run against a real database');
  describe.skip('session events against PostgreSQL', () => {
    it('needs RUN_DB_TESTS=1 and TEST_DATABASE_URL', () => undefined);
  });
} else {
  let db: PostgresDatabase;
  beforeAll(async () => {
    db = PostgresDatabase.fromConfig({
      url: url!,
      ssl: false,
      maxConnections: 4,
      connectionTimeoutMs: 5_000,
      idleTimeoutMs: 5_000,
      statementTimeoutMs: 10_000,
      applicationName: 'jumptotech-session-events-tests',
    });
    await migrate(db);
  });

  afterAll(async () => {
    await db.close().catch(() => undefined);
  });

  beforeEach(async () => {
    await db.query('TRUNCATE session_events RESTART IDENTITY');
    await db.query('TRUNCATE users, lab_sessions, hint_usage, lab_attempts, lab_progress, students RESTART IDENTITY CASCADE');
  });

  describe('session events against PostgreSQL', () => {
    it('records a timeline and reads it back newest first, with owner and actor', async () => {
      const store = new PostgresSessionEventStore(db);
      const { userId } = await new PostgresUserRepository(db).upsert({ issuer: 'https://issuer.example.com/', subject: 'amy' });
      const base = { sessionId: 'sess-aaaa1111', labId: 'LINUX-001', ownerUserId: userId, actorUserId: userId };
      await store.record({ ...base, operation: 'start', outcome: 'ok', durationMs: 1234.6 });
      await store.record({ ...base, operation: 'check', outcome: 'error', code: 'ENVIRONMENT_UNREACHABLE' });
      await store.record({ ...base, operation: 'check', outcome: 'fail' });

      const timeline = await store.listForSession('sess-aaaa1111', 10);
      expect(timeline.map((event) => `${event.operation}:${event.outcome}`)).toEqual(['check:fail', 'check:error', 'start:ok']);
      expect(timeline[2]).toMatchObject({ ownerUserId: userId, actorUserId: userId, durationMs: 1235 });
      expect(timeline[1]!.code).toBe('ENVIRONMENT_UNREACHABLE');
      expect(await store.listForOwner(userId, 2)).toHaveLength(2);
    });

    it('answers newest per (session, operation) in one query', async () => {
      const store = new PostgresSessionEventStore(db);
      await store.record({ sessionId: 'sess-a', labId: 'L', operation: 'check', outcome: 'fail' });
      await store.record({ sessionId: 'sess-a', labId: 'L', operation: 'check', outcome: 'pass' });
      await store.record({ sessionId: 'sess-a', labId: 'L', operation: 'reset', outcome: 'failed', code: 'SESSION_RESET_FAILED' });
      await store.record({ sessionId: 'sess-b', labId: 'L', operation: 'start', outcome: 'ok' });
      const latest = await store.latestForSessions(['sess-a', 'sess-b']);
      expect(latest.get('sess-a')?.check?.outcome).toBe('pass');
      expect(latest.get('sess-a')?.reset?.code).toBe('SESSION_RESET_FAILED');
      expect(latest.get('sess-b')?.start?.outcome).toBe('ok');
      expect((await store.latestForSessions([])).size).toBe(0);
    });

    it('stores prose as `unknown` and a non-UUID owner as nothing, rather than failing', async () => {
      const store = new PostgresSessionEventStore(db);
      await store.record({
        labId: 'LINUX-001',
        ownerUserId: 'usr-00000001',
        operation: 'start',
        outcome: 'refused',
        code: 'Error response from daemon: 172.18.0.5',
      });
      const [event] = await store.listRecent({ sinceIso: new Date(0).toISOString(), outcomes: ['refused'], limit: 5 });
      expect(event).toMatchObject({ code: 'unknown', operation: 'start' });
      expect(event!.ownerUserId).toBeUndefined();
      expect(event!.sessionId).toBeUndefined();
    });

    it('the table itself refuses prose codes and unknown operations or outcomes', async () => {
      const insert = (operation: string, outcome: string, code: string | null) =>
        db.query(`INSERT INTO session_events (lab_id, operation, outcome, code) VALUES ('L', $1, $2, $3)`, [operation, outcome, code]);
      await expect(insert('check', 'fail', 'has spaces in it')).rejects.toThrow(/session_events_code_shape/);
      await expect(insert('shell', 'ok', null)).rejects.toThrow(/check/i);
      await expect(insert('check', 'maybe', null)).rejects.toThrow(/check/i);
    });

    it('purges by age only', async () => {
      const store = new PostgresSessionEventStore(db);
      await store.record({ sessionId: 'old', labId: 'L', operation: 'start', outcome: 'ok', occurredAt: '2026-01-01T00:00:00Z' });
      await store.record({ sessionId: 'new', labId: 'L', operation: 'start', outcome: 'ok' });
      expect(await store.purgeOlderThan('2026-06-01T00:00:00Z')).toBe(1);
      expect(await store.listForSession('old', 5)).toHaveLength(0);
      expect(await store.listForSession('new', 5)).toHaveLength(1);
    });
  });
}
