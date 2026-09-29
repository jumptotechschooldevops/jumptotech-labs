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
 *     together cannot apply the same migration twice;
 *   - a database that records a version this release does not ship — it was
 *     migrated by a newer release — is refused unless `allowNewerSchema` says
 *     otherwise. That is the rollback boundary: older code on a newer schema is
 *     a decision (restore the pre-upgrade backup, or accept it explicitly),
 *     never something that happens because a rollback started cleanly.
 *   - each migration says whether the release before it can run on its schema
 *     (`-- rollback: older-code-runs` or `-- rollback: restore-required`), and
 *     the ledger keeps that answer. A release that finds an unknown version
 *     recorded as `restore-required` refuses even under the override: the
 *     release that applied it knew its predecessors could not run on it.
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

/**
 * Can the release before a migration run on the schema it leaves?
 *
 *   - `older-code-runs` — yes, as an explicit rollback decision
 *     (DATABASE_ALLOW_NEWER_SCHEMA=true): older code reads and writes it
 *     correctly, though it may lack what the migration was for.
 *   - `restore-required` — no: older code fails on it or decides wrongly from
 *     it, so the way back is the pre-migration archive.
 *
 * Stated by the migration itself, in a line of its own:
 *
 *   -- rollback: restore-required
 */
export type RollbackClass = 'older-code-runs' | 'restore-required';

const ROLLBACK_HEADER = /^-- rollback: (older-code-runs|restore-required)[ \t]*$/m;

/**
 * 001–010 were applied before the header existed, and an applied file can
 * never change (its checksum is in every ledger), so they are classified here.
 * Measured, not assumed: the previous release of each was run against the
 * newer schema (docs/releases/dr-certification-2026-09-28.md). Only 010 fails:
 * pre-010 code writes every access change with ON CONFLICT (user_id, scope),
 * which no constraint matches after 010 re-keys access_entitlements, and reads
 * one row per account where an account can now have two — so an operator's
 * suspension can lose to a subscription, depending on the query plan.
 */
export const ROLLBACK_CLASS_BEFORE_HEADERS: Readonly<Record<string, RollbackClass>> = {
  '001_progress': 'older-code-runs',
  '002_sessions': 'older-code-runs',
  '003_users_and_ownership': 'older-code-runs',
  '004_auth_sessions': 'older-code-runs',
  '005_session_recovery': 'older-code-runs',
  '006_access_entitlements': 'older-code-runs',
  '007_session_shell_uid': 'older-code-runs',
  '008_session_events': 'older-code-runs',
  '009_access_plans_and_kinds': 'older-code-runs',
  '010_billing': 'restore-required',
};

export interface Migration {
  /** Sort key and primary key, e.g. `001_progress`. */
  version: string;
  filename: string;
  sql: string;
  checksum: string;
  /** From the file's `-- rollback:` line, or the table above; null when neither says. */
  rollback: RollbackClass | null;
}

export interface MigrationReport {
  /** Versions applied by this run, in order. */
  applied: string[];
  /** Versions already present. */
  skipped: string[];
  /**
   * Versions the database records that this release does not ship: it was
   * migrated by a newer release. Only ever non-empty when `allowNewerSchema`.
   */
  unknown: string[];
  /**
   * True when the ledger was empty: this run built the schema from nothing.
   * Right on a first deployment; after a lost volume it is the only sign that
   * the database was re-created rather than recovered, because afterwards it
   * reports the same migration version a restored database does.
   */
  initialized: boolean;
  /**
   * When the ledger was started: the earliest applied_at. A restore keeps the
   * original; a re-created database carries the time it was re-created.
   */
  ledgerStartedAt: Date | null;
}

export interface MigrateOptions {
  dir?: string;
  logger?: (message: string) => void;
  /**
   * Run against a database migrated by a newer release. Off by default: that
   * is older code on a schema it was never written for, and choosing it is a
   * rollback decision (the api maps DATABASE_ALLOW_NEWER_SCHEMA=true here).
   */
  allowNewerSchema?: boolean;
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
    const version = filename.replace(/\.sql$/, '');
    const declared = ROLLBACK_HEADER.exec(sql)?.[1] as RollbackClass | undefined;
    migrations.push({
      version,
      filename,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
      rollback: declared ?? ROLLBACK_CLASS_BEFORE_HEADERS[version] ?? null,
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

function newerSchemaError(unknown: string[]): MigrationError {
  return new MigrationError(
    `The database records migration(s) this release does not ship: ${unknown.join(', ')}. ` +
      'It was migrated by a newer release, and this code was not written for that schema.',
    'Deploy the release that matches the database, or restore the pre-upgrade backup ' +
      '(docs/runbooks/postgres-backup-restore.md §6.4). To run this release against the newer ' +
      'schema anyway — an explicit rollback decision — set DATABASE_ALLOW_NEWER_SCHEMA=true.',
  );
}

/**
 * Under DATABASE_ALLOW_NEWER_SCHEMA: which of the unknown versions did the
 * release that applied them record as `restore-required`? A ledger from before
 * the column existed answers nothing, which keeps the override's old meaning.
 */
async function versionsOlderCodeCannotRun(client: SqlExecutor, unknown: string[]): Promise<string[]> {
  const column = await client.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = current_schema() AND table_name = 'schema_migrations'
                       AND column_name = 'older_code_runs') AS present`,
  );
  if (column.rows[0]?.present !== true) return [];
  const { rows } = await client.query<{ version: string }>(
    'SELECT version FROM schema_migrations WHERE version = ANY($1::text[]) AND older_code_runs IS FALSE ORDER BY version',
    [unknown],
  );
  return rows.map((row) => row.version);
}

function restoreRequiredError(barred: string[]): MigrationError {
  return new MigrationError(
    `The database records migration(s) this release does not ship: ${barred.join(', ')}, and the release ` +
      'that applied them recorded that older code cannot run on the schema they leave (rollback: restore-required).',
    'DATABASE_ALLOW_NEWER_SCHEMA does not override this. Restore the pre-upgrade backup ' +
      '(docs/runbooks/postgres-backup-restore.md §6.4), or deploy the release that matches the database.',
  );
}

/** Refuse, or warn under the override, when the ledger holds versions this release does not ship. */
async function checkNewerSchema(
  client: SqlExecutor,
  unknown: string[],
  allowNewerSchema: boolean,
  log: (message: string) => void,
): Promise<void> {
  if (unknown.length === 0) return;
  if (!allowNewerSchema) throw newerSchemaError(unknown);
  const barred = await versionsOlderCodeCannotRun(client, unknown);
  if (barred.length > 0) throw restoreRequiredError(barred);
  log(
    `WARNING: running against a newer schema (DATABASE_ALLOW_NEWER_SCHEMA): ` +
      `this release does not ship ${unknown.join(', ')}`,
  );
}

/**
 * Apply every migration this database has not seen.
 *
 * Safe to call on every start: a database that is already up to date does one
 * lock, one select, and nothing else.
 */
export async function migrate(
  db: Pick<PostgresDatabase, 'session'>,
  options: MigrateOptions = {},
): Promise<MigrationReport> {
  const log = options.logger ?? (() => undefined);
  const migrations = await loadMigrations(options.dir ?? MIGRATIONS_DIR);

  return db.session(async (client) => {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      return await applyPending(client, migrations, log, options.allowNewerSchema === true);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    }
  });
}

/**
 * Check, without changing anything, that this release can run on the schema it
 * finds. The api calls it when DATABASE_AUTO_MIGRATE is off, where `migrate`
 * never runs and nothing else would notice either side of the boundary:
 *
 *   - a version this release does not ship: a newer release migrated it. The
 *     same refusal, and the same override, as `migrate`;
 *   - a version this release ships and the database lacks: the migration step
 *     the operator took on did not run, and this code would fail on its first
 *     query against a missing column instead of at start;
 *   - a shipped version whose file was edited after it was applied.
 *
 * Read-only: no lock, no DDL — it does not even create the ledger.
 */
export async function verifySchema(
  db: Pick<PostgresDatabase, 'session'>,
  options: MigrateOptions = {},
): Promise<MigrationReport> {
  const log = options.logger ?? (() => undefined);
  const migrations = await loadMigrations(options.dir ?? MIGRATIONS_DIR);
  const allowNewerSchema = options.allowNewerSchema === true;

  return db.session(async (client) => {
    const ledger = await client.query<{ ledger: string | null }>(
      "SELECT to_regclass('schema_migrations')::text AS ledger",
    );
    const rows =
      ledger.rows[0]?.ledger == null
        ? []
        : (await client.query<AppliedRow>('SELECT version, checksum FROM schema_migrations')).rows;
    const applied = new Map(rows.map((row) => [row.version, row.checksum]));

    const shipped = new Set(migrations.map((migration) => migration.version));
    const unknown = [...applied.keys()].filter((version) => !shipped.has(version)).sort();
    await checkNewerSchema(client, unknown, allowNewerSchema, log);

    const pending: string[] = [];
    const skipped: string[] = [];
    for (const migration of migrations) {
      const known = applied.get(migration.version);
      if (known === undefined) pending.push(migration.version);
      else if (known !== migration.checksum) {
        throw new MigrationError(
          `Migration ${migration.filename} was modified after it was applied.`,
          'Migrations are immutable once applied. Revert the edit and add a new migration instead.',
        );
      } else skipped.push(migration.version);
    }
    if (pending.length > 0) {
      throw new MigrationError(
        `DATABASE_AUTO_MIGRATE is off and the database lacks migration(s) this release needs: ${pending.join(', ')}.`,
        'Run `npm run db:migrate` against this database first, or set DATABASE_AUTO_MIGRATE=true.',
      );
    }

    return { applied: [], skipped, unknown, initialized: false, ledgerStartedAt: null };
  });
}

async function applyPending(
  client: SqlExecutor,
  migrations: Migration[],
  log: (message: string) => void,
  allowNewerSchema: boolean,
): Promise<MigrationReport> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      checksum   TEXT        NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Whether the release before each migration can run on it (`-- rollback:`).
  // NULL: not stated — a ledger row written before this column existed.
  await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS older_code_runs BOOLEAN');

  const { rows } = await client.query<AppliedRow>(
    'SELECT version, checksum FROM schema_migrations',
  );
  const applied = new Map(rows.map((row) => [row.version, row.checksum]));

  // Before anything is applied: a pending file must not be run against a
  // schema a newer release has already moved on from.
  const shipped = new Set(migrations.map((migration) => migration.version));
  const unknown = [...applied.keys()].filter((version) => !shipped.has(version)).sort();
  await checkNewerSchema(client, unknown, allowNewerSchema, log);

  const report: MigrationReport = {
    applied: [],
    skipped: [],
    unknown,
    initialized: rows.length === 0,
    ledgerStartedAt: null,
  };

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
      await client.query(
        'INSERT INTO schema_migrations (version, checksum, older_code_runs) VALUES ($1, $2, $3)',
        [migration.version, migration.checksum, olderCodeRuns(migration)],
      );
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

  // Rows applied before the column existed learn their class from this
  // release, so the next release to roll back past them can read it.
  const known = migrations.filter((migration) => migration.rollback !== null);
  if (report.skipped.length > 0 && known.length > 0) {
    await client.query(
      `UPDATE schema_migrations AS m SET older_code_runs = c.runs
         FROM unnest($1::text[], $2::boolean[]) AS c(version, runs)
        WHERE m.version = c.version AND m.older_code_runs IS NULL`,
      [known.map((migration) => migration.version), known.map(olderCodeRuns)],
    );
  }

  const started = await client.query<{ started_at: Date | string | null }>(
    'SELECT min(applied_at) AS started_at FROM schema_migrations',
  );
  const startedAt = started.rows[0]?.started_at;
  report.ledgerStartedAt = startedAt === null || startedAt === undefined ? null : new Date(startedAt);
  return report;
}

function olderCodeRuns(migration: Migration): boolean | null {
  return migration.rollback === null ? null : migration.rollback === 'older-code-runs';
}
