/**
 * Which rollbacks the ledger forbids, whatever DATABASE_ALLOW_NEWER_SCHEMA says.
 *
 * The override exists so an operator can run the previous release on a schema a
 * newer one migrated. For most migrations that works. For 010 it did not: the
 * previous release started, then failed every access change and read one of two
 * entitlement rows per account — so a suspended student with a subscription got
 * lab access, depending on the query plan (measured, 2026-09-28). The runbook
 * said so, but only a reader of the runbook knew.
 *
 * Each migration now states whether the release before it can run on it, and
 * the ledger keeps the answer where an older release can read it: a version it
 * does not ship, recorded `restore-required`, is refused even under the override.
 *
 * Proven against a scripted SQL session: what matters is which statements run,
 * with which values, and when the runner stops.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MIGRATIONS_DIR,
  MigrationError,
  ROLLBACK_CLASS_BEFORE_HEADERS,
  loadMigrations,
  migrate,
  verifySchema,
} from '../src/postgres/migrator.js';
import type { QueryResult, SqlExecutor } from '../src/postgres/database.js';

async function migrationsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'jtt-migrations-'));
  for (const [name, sql] of Object.entries(files)) await writeFile(path.join(dir, name), sql);
  return dir;
}

interface LedgerRow {
  version: string;
  checksum: string;
  /** undefined: the column does not exist (a ledger from before it). */
  older_code_runs?: boolean | null;
}

/** A session over one ledger. Logs every statement with its values; refuses any it does not expect. */
function ledgerDatabase(rows: LedgerRow[] | null) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const hasColumn = rows !== null && rows.some((row) => row.older_code_runs !== undefined);
  const result = <R>(r: unknown[]): QueryResult<R> => ({ rows: r as R[], rowCount: r.length }) as QueryResult<R>;
  const client: SqlExecutor = {
    async query<R>(text: string, values: unknown[] = []): Promise<QueryResult<R>> {
      const sql = text.trim().replace(/\s+/g, ' ');
      statements.push({ sql, values });
      if (sql.includes('to_regclass')) return result([{ ledger: rows === null ? null : 'schema_migrations' }]);
      if (sql.startsWith('SELECT version, checksum FROM schema_migrations')) {
        return result((rows ?? []).map(({ version, checksum }) => ({ version, checksum })));
      }
      if (sql.includes('information_schema.columns')) return result([{ present: hasColumn }]);
      if (sql.startsWith('SELECT version FROM schema_migrations WHERE version = ANY')) {
        const asked = values[0] as string[];
        return result(
          (rows ?? [])
            .filter((row) => asked.includes(row.version) && row.older_code_runs === false)
            .map(({ version }) => ({ version })),
        );
      }
      if (sql.startsWith('SELECT min(applied_at)')) return result([{ started_at: null }]);
      if (/^(SELECT pg_advisory|CREATE TABLE IF NOT EXISTS schema_migrations|ALTER TABLE schema_migrations|BEGIN|COMMIT|ROLLBACK|INSERT INTO schema_migrations|UPDATE schema_migrations)/.test(sql) || /CREATE TABLE (one|two) /.test(sql)) {
        return result([]);
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  };
  return { statements, database: { session: <T>(work: (c: SqlExecutor) => Promise<T>) => work(client) } };
}

const FILES = {
  '001_one.sql': '-- rollback: older-code-runs\nCREATE TABLE one (id int);',
  '002_two.sql': 'CREATE TABLE two (id int);\n-- rollback: restore-required\n',
};

describe('what each migration says about the release before it', () => {
  it('every migration this release ships is classified, and every one after 010 in its own file', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIR);
    const unclassified = migrations.filter((m) => m.rollback === null).map((m) => m.filename);
    expect(unclassified, 'add "-- rollback: older-code-runs" or "-- rollback: restore-required" (docs/runbooks/disaster-recovery.md §4.2)').toEqual([]);
    const afterTable = migrations.filter((m) => !(m.version in ROLLBACK_CLASS_BEFORE_HEADERS));
    for (const migration of afterTable) {
      expect(migration.sql, `${migration.filename} states its class in a line of its own`).toMatch(
        /^-- rollback: (older-code-runs|restore-required)[ \t]*$/m,
      );
    }
    // The table covers exactly what was applied before headers: it is never extended.
    expect(Object.keys(ROLLBACK_CLASS_BEFORE_HEADERS)).toEqual(
      migrations.slice(0, 10).map((m) => m.version),
    );
    expect(ROLLBACK_CLASS_BEFORE_HEADERS['010_billing']).toBe('restore-required');
  });

  it('reads the line wherever it is in the file, and nothing else', async () => {
    const dir = await migrationsDir({
      ...FILES,
      '003_three.sql': 'CREATE TABLE three (id int);',
      '004_four.sql': '-- rollback: probably fine\nCREATE TABLE four (id int);',
      '005_five.sql': "SELECT '-- rollback: older-code-runs';",
    });
    const classes = Object.fromEntries((await loadMigrations(dir)).map((m) => [m.version, m.rollback]));
    expect(classes).toEqual({
      '001_one': 'older-code-runs',
      '002_two': 'restore-required',
      '003_three': null,
      '004_four': null,
      '005_five': null,
    });
  });
});

describe('the ledger records the class', () => {
  it('with every migration it applies', async () => {
    const dir = await migrationsDir(FILES);
    const { database, statements } = ledgerDatabase([]);
    await migrate(database, { dir });
    const alter = statements.findIndex((s) => s.sql.startsWith('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS older_code_runs'));
    const inserts = statements.filter((s) => s.sql.startsWith('INSERT INTO schema_migrations'));
    expect(alter).toBeGreaterThan(-1);
    expect(alter).toBeLessThan(statements.findIndex((s) => s.sql.startsWith('INSERT INTO schema_migrations')));
    expect(inserts.map((s) => s.values)).toEqual([
      ['001_one', expect.any(String), true],
      ['002_two', expect.any(String), false],
    ]);
  });

  it('for rows applied before the column existed, without overwriting a recorded one', async () => {
    const dir = await migrationsDir(FILES);
    const shipped = await loadMigrations(dir);
    const { database, statements } = ledgerDatabase(shipped.map((m) => ({ version: m.version, checksum: m.checksum })));
    await migrate(database, { dir });
    const update = statements.find((s) => s.sql.startsWith('UPDATE schema_migrations'));
    expect(update?.sql).toMatch(/older_code_runs IS NULL/);
    expect(update?.values).toEqual([['001_one', '002_two'], [true, false]]);
  });
});

describe('rolling back past a migration recorded restore-required', () => {
  it('is refused even with DATABASE_ALLOW_NEWER_SCHEMA=true, before anything is applied', async () => {
    const dir = await migrationsDir({ '001_one.sql': FILES['001_one.sql'] });
    const [one] = await loadMigrations(dir);
    const { database, statements } = ledgerDatabase([
      { version: '001_one', checksum: one!.checksum, older_code_runs: true },
      { version: '002_two', checksum: 'f'.repeat(64), older_code_runs: false },
    ]);
    const error = await migrate(database, { dir, allowNewerSchema: true }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MigrationError);
    if (!(error instanceof MigrationError)) return;
    expect(error.message).toMatch(/002_two.*restore-required/);
    expect(error.remediation).toMatch(/DATABASE_ALLOW_NEWER_SCHEMA does not override this/);
    expect(error.remediation).toMatch(/§6\.4/);
    expect(statements.map((s) => s.sql)).not.toContain('BEGIN');
    expect(statements.at(-1)?.sql).toMatch(/pg_advisory_unlock/);
  });

  it('is refused the same way when DATABASE_AUTO_MIGRATE is off', async () => {
    const dir = await migrationsDir({ '001_one.sql': FILES['001_one.sql'] });
    const [one] = await loadMigrations(dir);
    const { database } = ledgerDatabase([
      { version: '001_one', checksum: one!.checksum, older_code_runs: true },
      { version: '002_two', checksum: 'f'.repeat(64), older_code_runs: false },
    ]);
    await expect(verifySchema(database, { dir, allowNewerSchema: true })).rejects.toThrow(/002_two.*restore-required/);
  });

  it('without the override, is the ordinary newer-schema refusal that offers it', async () => {
    const dir = await migrationsDir({ '001_one.sql': FILES['001_one.sql'] });
    const [one] = await loadMigrations(dir);
    const { database } = ledgerDatabase([
      { version: '001_one', checksum: one!.checksum, older_code_runs: true },
      { version: '002_two', checksum: 'f'.repeat(64), older_code_runs: false },
    ]);
    await expect(migrate(database, { dir })).rejects.toThrow(/does not ship: 002_two\. It was migrated/);
  });
});

describe('the override still works where the newer release allowed it', () => {
  it.each([
    ['recorded older-code-runs', true],
    ['recorded before the class existed (NULL)', null],
  ])('an unknown version %s runs, with the warning', async (_label, olderCodeRuns) => {
    const dir = await migrationsDir({ '001_one.sql': FILES['001_one.sql'] });
    const [one] = await loadMigrations(dir);
    const logged: string[] = [];
    const { database } = ledgerDatabase([
      { version: '001_one', checksum: one!.checksum, older_code_runs: true },
      { version: '002_two', checksum: 'f'.repeat(64), older_code_runs: olderCodeRuns },
    ]);
    const report = await migrate(database, { dir, allowNewerSchema: true, logger: (m) => logged.push(m) });
    expect(report.unknown).toEqual(['002_two']);
    expect(logged.join('\n')).toMatch(/WARNING: running against a newer schema/);
    const verified = await verifySchema(database, { dir, allowNewerSchema: true });
    expect(verified.unknown).toEqual(['002_two']);
  });

  it('a ledger without the column (every release before this one wrote it) keeps the old meaning', async () => {
    const dir = await migrationsDir({ '001_one.sql': FILES['001_one.sql'] });
    const [one] = await loadMigrations(dir);
    const { database, statements } = ledgerDatabase([
      { version: '001_one', checksum: one!.checksum },
      { version: '002_two', checksum: 'f'.repeat(64) },
    ]);
    const report = await verifySchema(database, { dir, allowNewerSchema: true });
    expect(report.unknown).toEqual(['002_two']);
    // Read-only: it asked whether the column exists, and did not ask the column.
    expect(statements.some((s) => s.sql.startsWith('SELECT version FROM schema_migrations WHERE'))).toBe(false);
    expect(statements.every((s) => s.sql.startsWith('SELECT'))).toBe(true);
  });
});
