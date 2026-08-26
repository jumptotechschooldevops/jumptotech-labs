/**
 * Migration files and database configuration — the parts that need no server.
 *
 * The runner's behaviour against a live database (idempotence, the checksum
 * guard, the advisory lock) is in `postgres-repository.test.ts`.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, MigrationError, loadMigrations } from '../src/postgres/migrator.js';
import { describeDatabase, loadDatabaseConfig } from '../src/postgres/config.js';

describe('migration files', () => {
  it('ships the schema with the package', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIR);

    // PLATFORM-008 added 002; PLATFORM-009 added 003; PLATFORM-010 added 004.
    // The list is asserted so a migration cannot be added without someone
    // noticing here, but the *safety* checks below apply to every file rather
    // than to a numbered one — that is the invariant, and it should not need
    // editing when 005 arrives.
    expect(migrations.map((m) => m.version)).toEqual([
      '001_progress',
      '002_sessions',
      '003_users_and_ownership',
      '004_auth_sessions',
    ]);
    for (const migration of migrations) {
      expect(migration.checksum, migration.version).toMatch(/^[0-9a-f]{64}$/);
    }

    const progress = migrations.find((m) => m.version === '001_progress')!.sql;
    for (const table of ['students', 'lab_attempts', 'lab_progress', 'hint_usage']) {
      expect(progress).toContain(`CREATE TABLE ${table}`);
    }

    /*
     * Browser sessions (PLATFORM-010) hold an index, not a credential.
     *
     * Asserted here rather than trusted to review: the whole security argument
     * for this table is that a copy of it is worthless, and that argument rests
     * on the primary key being a hash and on no token column existing.
     */
    const auth = migrations.find((m) => m.version === '004_auth_sessions')!.sql;
    expect(auth).toContain('CREATE TABLE IF NOT EXISTS auth_sessions');
    expect(auth).toContain('auth_session_id  CHAR(64)     PRIMARY KEY');
    // Deleting a user must take their live browser sessions with it, in one
    // statement, with no window in which a removed account still has a cookie.
    expect(auth).toContain('REFERENCES users(user_id) ON DELETE CASCADE');
    /*
     * No credential column of any kind. If one is ever added, this fails.
     *
     * Comments are stripped first: the file's own prose explains *why* there is
     * no client secret here, and a check that read the explanation as a
     * violation would be unmaintainable.
     */
    const authStatements = auth
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    for (const forbidden of ['access_token', 'id_token', 'refresh_token', 'password', 'secret']) {
      expect(authStatements, forbidden).not.toContain(forbidden);
    }

    const sessions = migrations.find((m) => m.version === '002_sessions')!.sql;
    expect(sessions).toContain('CREATE TABLE IF NOT EXISTS lab_sessions');
    // The durable session identity is the unpredictable id, not a row number,
    // and one sandbox belongs to at most one session.
    expect(sessions).toContain('session_id            TEXT        PRIMARY KEY');
    expect(sessions).toMatch(/sandbox_ref\s+TEXT\s+NOT NULL UNIQUE/);

    const users = migrations.find((m) => m.version === '003_users_and_ownership')!.sql;
    expect(users).toContain('CREATE TABLE IF NOT EXISTS users');
    // The permanent identity is the provider pair, not an email.
    expect(users).toMatch(/UNIQUE \(issuer, subject\)/);
    expect(users).toContain('owner_user_id');
    // No credential is ever stored on a user record.
    for (const forbidden of ['password', 'access_token', 'refresh_token', 'client_secret']) {
      expect(users.toLowerCase(), forbidden).not.toContain(`${forbidden} `);
    }

    // Forward-only, and never destructive on startup — for every migration.
    for (const migration of migrations) {
      expect(migration.sql, migration.version).not.toMatch(/\bDROP\s+TABLE\b/i);
      expect(migration.sql, migration.version).not.toMatch(/\bTRUNCATE\b/i);
      expect(migration.sql, migration.version).not.toMatch(/\bDROP\s+DATABASE\b/i);
    }
  });

  it('applies in filename order', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'jtt-migrations-'));
    await writeFile(path.join(dir, '010_later.sql'), 'SELECT 1;');
    await writeFile(path.join(dir, '002_middle.sql'), 'SELECT 1;');
    await writeFile(path.join(dir, '001_first.sql'), 'SELECT 1;');
    await writeFile(path.join(dir, 'README.md'), 'not a migration');

    const migrations = await loadMigrations(dir);
    expect(migrations.map((m) => m.version)).toEqual(['001_first', '002_middle', '010_later']);
  });

  it('rejects a misnamed migration rather than guessing its order', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'jtt-migrations-'));
    await writeFile(path.join(dir, 'add-progress.sql'), 'SELECT 1;');
    await expect(loadMigrations(dir)).rejects.toBeInstanceOf(MigrationError);
  });

  it('fails loudly when the directory is missing or empty', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'jtt-migrations-'));
    await expect(loadMigrations(dir)).rejects.toBeInstanceOf(MigrationError);
    await expect(loadMigrations(path.join(dir, 'nope'))).rejects.toBeInstanceOf(MigrationError);
  });
});

describe('database configuration', () => {
  it('is absent until a deployment configures one', () => {
    expect(loadDatabaseConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(loadDatabaseConfig({ DATABASE_URL: '' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('reads a connection string', () => {
    const config = loadDatabaseConfig({
      DATABASE_URL: 'postgresql://labs:secret@postgres:5432/jumptotech_labs',
    } as NodeJS.ProcessEnv);

    expect(config?.url).toBe('postgresql://labs:secret@postgres:5432/jumptotech_labs');
    expect(config?.maxConnections).toBe(10);
    expect(config?.statementTimeoutMs).toBe(10_000);
  });

  it('reads discrete variables for deployments that inject the password separately', () => {
    const config = loadDatabaseConfig({
      POSTGRES_HOST: 'db.internal',
      POSTGRES_PORT: '6432',
      POSTGRES_DB: 'labs',
      POSTGRES_USER: 'labs',
      POSTGRES_PASSWORD: 'from-a-secret-store',
      DATABASE_POOL_MAX: '4',
    } as NodeJS.ProcessEnv);

    expect(config).toMatchObject({ host: 'db.internal', port: 6432, database: 'labs', maxConnections: 4 });
  });

  it('never puts a password in a log line', () => {
    const config = loadDatabaseConfig({
      DATABASE_URL: 'postgresql://labs:hunter2@postgres:5432/jumptotech_labs',
    } as NodeJS.ProcessEnv)!;

    const described = describeDatabase(config);
    expect(described).toBe('postgres:5432/jumptotech_labs');
    expect(described).not.toContain('hunter2');
    expect(describeDatabase({ ...config, url: 'not a url' })).toBe('(configured)');
  });

  it('rejects a nonsensical numeric setting instead of silently defaulting', () => {
    expect(() =>
      loadDatabaseConfig({ DATABASE_URL: 'postgresql://x/y', DATABASE_POOL_MAX: 'lots' } as NodeJS.ProcessEnv),
    ).toThrow(/DATABASE_POOL_MAX/);
  });
});
