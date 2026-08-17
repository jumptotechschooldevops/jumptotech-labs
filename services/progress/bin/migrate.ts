#!/usr/bin/env node
/**
 * Apply pending database migrations.
 *
 *   npm run db:migrate                 # from the repository root
 *   npm run db:migrate -- --status     # report without changing anything
 *
 * Reads the same `DATABASE_URL` / `POSTGRES_*` variables the API does, and
 * fails with an explanation rather than a stack trace when none is set. It
 * never drops or truncates: see `src/postgres/migrator.ts`.
 */
import {
  MigrationError,
  PostgresDatabase,
  describeDatabase,
  loadDatabaseConfig,
  loadMigrations,
  migrate,
} from '../src/postgres/index.js';

async function main(): Promise<void> {
  const statusOnly = process.argv.includes('--status');
  const config = loadDatabaseConfig();

  if (!config) {
    console.error(
      'No database is configured. Set DATABASE_URL (or POSTGRES_HOST) and try again.\n' +
        'For the local stack: docker compose up -d postgres, then\n' +
        '  DATABASE_URL=postgresql://<user>:<password>@localhost:5432/<database> npm run db:migrate',
    );
    process.exit(2);
  }

  const db = PostgresDatabase.fromConfig(config);
  try {
    console.log(`[migrate] target ${describeDatabase(config)}`);

    if (statusOnly) {
      const migrations = await loadMigrations();
      const { rows } = await db.query<{ version: string }>(
        `SELECT version FROM schema_migrations ORDER BY version`,
      ).catch(() => ({ rows: [] as Array<{ version: string }> }));
      const applied = new Set(rows.map((row) => row.version));
      for (const migration of migrations) {
        console.log(`  ${applied.has(migration.version) ? 'applied' : 'PENDING'}  ${migration.version}`);
      }
      return;
    }

    const report = await migrate(db, { logger: (message) => console.log(`[migrate] ${message}`) });
    console.log(
      report.applied.length > 0
        ? `[migrate] applied ${report.applied.length} migration(s): ${report.applied.join(', ')}`
        : `[migrate] database is up to date (${report.skipped.length} migration(s) already applied)`,
    );
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof MigrationError) {
    console.error(`[migrate] ${error.message}`);
    if (error.remediation) console.error(`[migrate] ${error.remediation}`);
  } else {
    console.error(`[migrate] failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
});
