/**
 * Schema management.
 *
 * Forward-only, checksum-verified, and explicitly NOT a "drop and recreate on
 * startup" scheme:
 *
 *   - each `migrations/NNN_name.sql` runs at most once per database;
 *   - it runs inside a transaction, so a failing migration leaves nothing
 *     half-applied (PostgreSQL DDL is transactional);
 *   - the version and a SHA-256 of the file are recorded, so editing an
 *     already-applied migration is reported as an error rather than silently
 *     ignored;
 *   - an advisory lock serialises the run, so two API instances starting
 *     together cannot apply the same migration twice.
 *
 * Nothing in this runner drops or truncates anything. The only statements
 * executed are the ones in the migration files, and reviewing those files is
 * therefore the whole audit.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PostgresDatabase, SqlExecutor } from './database.js';

/** Ships with the package, so the container image carries its own schema. */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

/**
 * Key for `pg_advisory_lock`. An arbitrary but fixed constant: any other
 * process using the same number would serialise against us, which is why it is
 * derived from this application's name rather than being a round number.
 */
const MIGRATION_LOCK_KEY = 5_318_008_005;

const MIGRATION_FILE_PATTERN = /^(\d{3,})_([a-z0-9_-]+)\.sql$/;

export interface Migration {
  /** Sort key and primary key, e.g. `001_progress`. */
  version: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface MigrationReport {
  /** Versions applied by this run, in order. */
  applied: string[];
  /** Versions already present. */
  skipped: string[];
}

export class MigrationError extends Error {
  constructor(message: string, readonly remediation?: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (cause) {
    throw new MigrationError(
      `Cannot read the migrations directory ${dir}: ${(cause as Error).message}`,
    );
  }

  const migrations: Migration[] = [];
  for (const filename of entries.sort()) {
    const match = MIGRATION_FILE_PATTERN.exec(filename);
    if (!match) {
      if (filename.endsWith('.sql')) {
        throw new MigrationError(
          `Migration ${filename} is not named NNN_lower_snake_case.sql`,
          'Rename it; the numeric prefix is the apply order.',
        );
      }
      continue;
    }
    const sql = await readFile(path.join(dir, filename), 'utf8');
    migrations.push({
      version: filename.replace(/\.sql$/, ''),
      filename,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }

  if (migrations.length === 0) {
    throw new MigrationError(`No migrations found in ${dir}`);
  }
  return migrations;
}

interface AppliedRow {
  version: string;
  checksum: string;
}

/**
 * Apply every migration this database has not seen.
 *
 * Safe to call on every start: a database that is already up to date does one
 * lock, one select, and nothing else.
 */
export async function migrate(
  db: PostgresDatabase,
  options: { dir?: string; logger?: (message: string) => void } = {},
): Promise<MigrationReport> {
  const log = options.logger ?? (() => undefined);
  const migrations = await loadMigrations(options.dir ?? MIGRATIONS_DIR);

  return db.session(async (client) => {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      return await applyPending(client, migrations, log);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    }
  });
}

async function applyPending(
  client: SqlExecutor,
  migrations: Migration[],
  log: (message: string) => void,
): Promise<MigrationReport> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      checksum   TEXT        NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await client.query<AppliedRow>(
    'SELECT version, checksum FROM schema_migrations',
  );
  const applied = new Map(rows.map((row) => [row.version, row.checksum]));

  const report: MigrationReport = { applied: [], skipped: [] };

  for (const migration of migrations) {
    const known = applied.get(migration.version);
    if (known !== undefined) {
      if (known !== migration.checksum) {
        throw new MigrationError(
          `Migration ${migration.filename} was modified after it was applied.`,
          'Migrations are immutable once applied. Revert the edit and add a new migration instead.',
        );
      }
      report.skipped.push(migration.version);
      continue;
    }

    await client.query('BEGIN');
    try {
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
        migration.version,
        migration.checksum,
      ]);
      await client.query('COMMIT');
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new MigrationError(
        `Migration ${migration.filename} failed: ${(cause as Error).message}`,
        'Nothing was applied from this file; the database is unchanged.',
      );
    }
    report.applied.push(migration.version);
    log(`applied ${migration.version}`);
  }

  return report;
}
