/**
 * Named `*-integration` since PLATFORM-006: this suite requires a real
 * PostgreSQL. It was always gated on RUN_DB_TESTS, but the old name hid that,
 * and `test-classification.test.ts` now refuses an unclassified infra suite.
 *
 * The contract suite against a real PostgreSQL, plus the migration runner.
 *
 * Skipped unless a throwaway database is pointed at it, exactly like the kind
 * and sandbox integration suites:
 *
 *   docker run --rm -d --name jtt-test-pg -e POSTGRES_PASSWORD=test \
 *     -e POSTGRES_USER=test -e POSTGRES_DB=jumptotech_labs_test \
 *     -p 55432:5432 postgres:16-alpine
 *
 *   RUN_DB_TESTS=1 \
 *   TEST_DATABASE_URL=postgresql://test:test@localhost:55432/jumptotech_labs_test \
 *   npm run test:db
 *
 * Everything a fake could prove is proved in `memory-repository.test.ts`. What
 * needs a real server is here: the constraints, the ON CONFLICT clauses, the
 * transaction boundaries, and the migrations themselves.
 */
import { describe, expect, it } from 'vitest';
import { PostgresDatabase } from '../src/postgres/database.js';
import { PostgresProgressRepository } from '../src/postgres/repository.js';
import { MigrationError, migrate, loadMigrations } from '../src/postgres/migrator.js';
import { describeProgressRepository } from './repository-contract.js';

const url = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === '1' && typeof url === 'string' && url.length > 0;

const TABLES = 'hint_usage, lab_attempts, lab_progress, students';

function connect(): PostgresDatabase {
  return PostgresDatabase.fromConfig({
    url: url!,
    ssl: false,
    maxConnections: 4,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 5_000,
    statementTimeoutMs: 10_000,
    applicationName: 'jumptotech-labs-tests',
  });
}

if (!enabled) {
  // eslint-disable-next-line no-console
  console.log(
    '[postgres] skipped — set RUN_DB_TESTS=1 and TEST_DATABASE_URL to run against a real database',
  );

  describe.skip('PostgresProgressRepository', () => {
    it('needs RUN_DB_TESTS=1 and TEST_DATABASE_URL', () => undefined);
  });
} else {
  describeProgressRepository('PostgresProgressRepository', async () => {
    const db = connect();
    await migrate(db);
    const repository = new PostgresProgressRepository(db);
    return {
      repository,
      async reset() {
        await db.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
      },
      async close() {
        await db.close();
      },
    };
  });

  describe('migrations', () => {
    it('is idempotent: a second run applies nothing', async () => {
      const db = connect();
      try {
        await migrate(db);
        const second = await migrate(db);
        expect(second.applied).toEqual([]);
        expect(second.skipped).toContain('001_progress');

        // And the data is still there — this is the property the story asks
        // for: startup must never re-initialise a populated database.
        await db.query(
          `INSERT INTO students (student_id, identity_source, created_at, last_seen_at)
           VALUES ($1, 'development-default', now(), now())
           ON CONFLICT (student_id) DO NOTHING`,
          ['migration-survivor'],
        );
        await migrate(db);
        const { rows } = await db.query<{ count: number }>(
          'SELECT COUNT(*)::bigint AS count FROM students WHERE student_id = $1',
          ['migration-survivor'],
        );
        expect(Number(rows[0]?.count)).toBe(1);
        await db.query('DELETE FROM students WHERE student_id = $1', ['migration-survivor']);
      } finally {
        await db.close();
      }
    });

    it('refuses to run when an applied migration was edited', async () => {
      const db = connect();
      try {
        await migrate(db);
        const [first] = await loadMigrations();
        await db.query('UPDATE schema_migrations SET checksum = $2 WHERE version = $1', [
          first!.version,
          'tampered',
        ]);
        await expect(migrate(db)).rejects.toBeInstanceOf(MigrationError);
      } finally {
        // Put the recorded checksum back so the next run is clean.
        const [first] = await loadMigrations();
        await db
          .query('UPDATE schema_migrations SET checksum = $2 WHERE version = $1', [
            first!.version,
            first!.checksum,
          ])
          .catch(() => undefined);
        await db.close();
      }
    });

    it('rejects a passing attempt with no completion timestamp', async () => {
      // The schema, not the application, is the last line of defence: a bug
      // that wrote PASSED without a completed_at would be a lie on the
      // dashboard, so the database refuses it outright.
      const db = connect();
      try {
        await migrate(db);
        await db.query(
          `INSERT INTO students (student_id, identity_source, created_at, last_seen_at)
           VALUES ('constraint-probe', 'development-default', now(), now())
           ON CONFLICT (student_id) DO NOTHING`,
        );
        await expect(
          db.query(
            `INSERT INTO lab_attempts
               (attempt_id, student_id, lab_id, track, status, started_at, updated_at)
             VALUES (gen_random_uuid(), 'constraint-probe', 'K8S-001', 'kubernetes',
                     'PASSED', now(), now())`,
          ),
        ).rejects.toThrow(/lab_attempts_completed_at_matches_status/);
      } finally {
        await db.query('DELETE FROM students WHERE student_id = $1', ['constraint-probe']).catch(
          () => undefined,
        );
        await db.close();
      }
    });
  });
}
