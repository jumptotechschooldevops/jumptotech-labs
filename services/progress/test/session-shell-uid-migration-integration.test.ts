/**
 * Migration 007 on a database that already has sessions in it — SEC-ARCH-2.
 *
 * A deploy does not start from an empty table: it runs 007 against whatever
 * sessions are live at that moment. `ADD COLUMN … DEFAULT nextval(…)` must give
 * each of them a distinct, in-range uid, and a row the previous release
 * inserts afterwards — naming no `shell_uid` at all — must get one too. Both
 * are proven here on a real PostgreSQL, in a database of this test's own so it
 * can stop at 006 first.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PostgresDatabase } from '../src/postgres/database.js';
import { MIGRATIONS_DIR, migrate } from '../src/postgres/migrator.js';

const url = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === '1' && typeof url === 'string' && url.length > 0;

function connect(target: string): PostgresDatabase {
  return PostgresDatabase.fromConfig({
    url: target,
    ssl: false,
    maxConnections: 2,
    connectionTimeoutMs: 10_000,
    idleTimeoutMs: 5_000,
    statementTimeoutMs: 30_000,
    applicationName: 'jumptotech-labs-shell-uid-migration-test',
  });
}

/** A session row as the release before 007 wrote it: no shell_uid. */
function insertLegacy(db: PostgresDatabase, sessionId: string, status = 'ACTIVE') {
  return db.query(
    `INSERT INTO lab_sessions (session_id, lab_id, provider, sandbox_kind, sandbox_ref, namespace,
       service_account_name, status, environment_id, created_at, last_activity_at, expires_at,
       idle_timeout_seconds, idle_warning_seconds)
     VALUES ($1, 'K8S-001', 'kubernetes', 'namespace', $2, $2, 'student', $3, '', now(), now(),
       now() + interval '1 hour', 1200, 300)`,
    [sessionId, `lab-${sessionId.slice(-12)}`, status],
  );
}

if (!enabled) {
  // eslint-disable-next-line no-console
  console.log('[shell-uid migration] skipped — set RUN_DB_TESTS=1 and TEST_DATABASE_URL to run');
  describe.skip('migration 007 on a live database', () => {
    it('needs RUN_DB_TESTS=1 and TEST_DATABASE_URL', () => undefined);
  });
} else {
  const name = `jtt_shell_uid_${process.pid}_${Date.now()}`;
  const admin = connect(url!);
  let db: PostgresDatabase;
  let upTo006: string;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${name}`);
    const target = new URL(url!);
    target.pathname = `/${name}`;
    db = connect(target.toString());
    // The migrations of the release before this one, and only those.
    upTo006 = await mkdtemp(path.join(tmpdir(), 'jtt-migrations-006-'));
    for (const file of await readdir(MIGRATIONS_DIR)) {
      if (file.endsWith('.sql') && file < '007') await cp(path.join(MIGRATIONS_DIR, file), path.join(upTo006, file));
    }
  }, 120_000);

  afterAll(async () => {
    await db?.close?.();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
    await admin.close?.();
    if (upTo006) await rm(upTo006, { recursive: true, force: true });
  });

  describe('migration 007 on a live database', () => {
    it('gives every session already there a distinct uid, and every later legacy INSERT one too', async () => {
      await migrate(db, { dir: upTo006 });
      const live = ['sess-00000000000007a1', 'sess-00000000000007a2', 'sess-00000000000007a3'];
      for (const id of live) await insertLegacy(db, id);
      await insertLegacy(db, 'sess-00000000000007a4', 'ENDED');

      await migrate(db);

      const { rows } = await db.query<{ session_id: string; shell_uid: string }>(
        'SELECT session_id, shell_uid FROM lab_sessions ORDER BY session_id',
      );
      expect(rows).toHaveLength(4);
      const uids = rows.map((r) => Number(r.shell_uid));
      expect(new Set(uids).size).toBe(4);
      for (const uid of uids) {
        expect(uid).toBeGreaterThanOrEqual(1_900_000_000);
        expect(uid).toBeLessThanOrEqual(1_900_999_999);
      }

      // The previous release, still running during the rollout, names no
      // shell_uid: the default fills it, distinct from every one above.
      await insertLegacy(db, 'sess-00000000000007b1');
      const { rows: after } = await db.query<{ shell_uid: string }>(
        `SELECT shell_uid FROM lab_sessions WHERE session_id = 'sess-00000000000007b1'`,
      );
      expect(uids).not.toContain(Number(after[0]!.shell_uid));

      // Applying again changes nothing: forward-only, exactly once.
      await migrate(db);
      const { rows: again } = await db.query<{ shell_uid: string }>(
        'SELECT shell_uid FROM lab_sessions ORDER BY session_id',
      );
      expect(again.slice(0, 4).map((r) => Number(r.shell_uid))).toEqual(uids);
    });
  });
}
