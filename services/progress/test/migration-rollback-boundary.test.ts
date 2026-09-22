/**
 * The rollback boundary a migration draws (disaster-recovery audit).
 *
 * Migrations are forward-only. Once release B has applied a migration release A
 * does not ship, A's code is running against a schema it was never written
 * for. Before this, the runner refused a *modified* migration but skipped a
 * version it did not know, so rolling the code back after a migration started
 * without a word — the one step of a rollback that most needs a decision.
 *
 * Proven against a scripted SQL session, not a server: what matters is which
 * statements run, and in what order, before the runner refuses.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MigrationError, loadMigrations, migrate } from '../src/postgres/migrator.js';
import type { QueryResult, SqlExecutor } from '../src/postgres/database.js';

async function migrationsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'jtt-migrations-'));
  for (const [name, sql] of Object.entries(files)) await writeFile(path.join(dir, name), sql);
  return dir;
}

/** A database whose ledger already holds `recorded`; logs every statement. */
function scriptedDatabase(recorded: Array<{ version: string; checksum: string }>) {
  const statements: string[] = [];
  const client: SqlExecutor = {
    async query<R>(text: string): Promise<QueryResult<R>> {
      statements.push(text.trim().replace(/\s+/g, ' '));
      if (/^SELECT version, checksum FROM schema_migrations/.test(text.trim())) {
        return { rows: recorded as R[], rowCount: recorded.length } as QueryResult<R>;
      }
      return { rows: [] as R[], rowCount: 0 } as QueryResult<R>;
    },
  };
  return {
    statements,
    database: { session: <T>(work: (c: SqlExecutor) => Promise<T>) => work(client) },
  };
}

const FILES = {
  '001_one.sql': 'CREATE TABLE one (id int);',
  '002_two.sql': 'CREATE TABLE two (id int);',
};

describe('a database migrated by a newer release', () => {
  it('is refused before anything is applied, naming the versions this release does not ship', async () => {
    const dir = await migrationsDir(FILES);
    const shipped = await loadMigrations(dir);
    const { database, statements } = scriptedDatabase([
      { version: '001_one', checksum: shipped[0]!.checksum },
      { version: '003_three', checksum: 'f'.repeat(64) },
    ]);

    const run = migrate(database, { dir });
    await expect(run).rejects.toBeInstanceOf(MigrationError);
    await expect(run).rejects.toThrow(/003_three/);
    // 002 is pending, and was not applied: the refusal comes first.
    expect(statements.some((s) => s.startsWith('CREATE TABLE two'))).toBe(false);
    expect(statements).not.toContain('BEGIN');
    // The lock is released on the way out.
    expect(statements.at(-1)).toMatch(/pg_advisory_unlock/);
  });

  it('names the explicit override and the restore in its remediation', async () => {
    const dir = await migrationsDir(FILES);
    const { database } = scriptedDatabase([{ version: '009_future', checksum: 'a'.repeat(64) }]);
    const error = await migrate(database, { dir }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MigrationError);
    if (!(error instanceof MigrationError)) return;
    expect(error.remediation).toMatch(/DATABASE_ALLOW_NEWER_SCHEMA=true/);
    expect(error.remediation).toMatch(/pre-upgrade/);
  });

  it('runs only when the newer schema is explicitly allowed, and reports what it does not know', async () => {
    const dir = await migrationsDir(FILES);
    const shipped = await loadMigrations(dir);
    const logged: string[] = [];
    const { database, statements } = scriptedDatabase([
      { version: '001_one', checksum: shipped[0]!.checksum },
      { version: '003_three', checksum: 'f'.repeat(64) },
    ]);

    const report = await migrate(database, {
      dir,
      allowNewerSchema: true,
      logger: (m) => logged.push(m),
    });
    expect(report.unknown).toEqual(['003_three']);
    expect(report.applied).toEqual(['002_two']);
    expect(statements.some((s) => s.startsWith('CREATE TABLE two'))).toBe(true);
    expect(logged.join('\n')).toMatch(/003_three/);
  });

  it('a database this release fully knows reports nothing unknown', async () => {
    const dir = await migrationsDir(FILES);
    const shipped = await loadMigrations(dir);
    const { database } = scriptedDatabase(shipped.map((m) => ({ version: m.version, checksum: m.checksum })));
    const report = await migrate(database, { dir });
    expect(report).toMatchObject({ applied: [], skipped: ['001_one', '002_two'], unknown: [] });
  });
});

/**
 * Recovered or re-created? (disaster-recovery audit)
 *
 * A database that comes back on an empty volume is healthy by every measure
 * the api exported: it accepts connections, and once auto-migrate has run it
 * reports the newest migration version — exactly what a restored database
 * reports. The runner now says when it built the schema from nothing, and when
 * the ledger was started: a restore keeps the original applied_at, a
 * re-creation stamps a new one.
 */
describe('a database initialised from nothing', () => {
  function ledgerDatabase(
    recorded: Array<{ version: string; checksum: string }>,
    startedAt: string | null,
  ) {
    const statements: string[] = [];
    const client: SqlExecutor = {
      async query<R>(text: string): Promise<QueryResult<R>> {
        const sql = text.trim().replace(/\s+/g, ' ');
        statements.push(sql);
        if (sql.startsWith('SELECT version, checksum FROM schema_migrations')) {
          return { rows: recorded as R[], rowCount: recorded.length } as QueryResult<R>;
        }
        if (sql.includes('min(applied_at)')) {
          return { rows: [{ started_at: startedAt }] as R[], rowCount: 1 } as QueryResult<R>;
        }
        return { rows: [] as R[], rowCount: 0 } as QueryResult<R>;
      },
    };
    return { statements, database: { session: <T>(work: (c: SqlExecutor) => Promise<T>) => work(client) } };
  }

  it('reports initialised when the ledger was empty, with the time the ledger started', async () => {
    const dir = await migrationsDir(FILES);
    const { database } = ledgerDatabase([], '2026-09-21T04:00:00.000Z');
    const report = await migrate(database, { dir });
    expect(report.initialized).toBe(true);
    expect(report.applied).toEqual(['001_one', '002_two']);
    expect(report.ledgerStartedAt?.toISOString()).toBe('2026-09-21T04:00:00.000Z');
  });

  it('a populated database is not initialised, and keeps its original ledger start', async () => {
    const dir = await migrationsDir(FILES);
    const shipped = await loadMigrations(dir);
    const { database } = ledgerDatabase(
      [{ version: '001_one', checksum: shipped[0]!.checksum }],
      '2026-01-02T03:04:05.000Z',
    );
    const report = await migrate(database, { dir });
    expect(report.initialized).toBe(false);
    expect(report.applied).toEqual(['002_two']);
    expect(report.ledgerStartedAt?.toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });
});
