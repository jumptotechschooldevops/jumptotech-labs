/**
 * Database configuration, read from the environment.
 *
 * Two rules, both non-negotiable:
 *
 *   1. No credential appears in source. There is no default password, no
 *      fallback user and no baked-in connection string anywhere in this
 *      package — an unconfigured deployment gets `null` and runs on the
 *      in-memory store, loudly, rather than silently connecting somewhere.
 *   2. Credentials stay server-side. Nothing in this file is ever serialised
 *      into an API response; `describe()` exists so logs and `/health` can name
 *      the host and database without the password.
 */

export interface DatabaseConfig {
  /** Full connection string, when the deployment supplies one. */
  url?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl: boolean;
  /** Pool ceiling. One API instance should not exhaust the server's slots. */
  maxConnections: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  /** Server-side cap on any single query, so a bad plan cannot pin a worker. */
  statementTimeoutMs: number;
  applicationName: string;
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got '${raw}'`);
  }
  return parsed;
}

function boolFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Build the database configuration, or `null` when none is configured.
 *
 * `DATABASE_URL` is the primary form (it is what Docker Compose, Heroku-style
 * platforms and most managed Postgres services hand you). The discrete
 * `POSTGRES_*` variables are honoured for deployments that inject a password
 * from a secret store separately from the host.
 */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig | null {
  const url = env.DATABASE_URL?.trim();
  const host = env.POSTGRES_HOST?.trim();
  if (!url && !host) return null;

  const shared = {
    ssl: boolFromEnv(env, 'DATABASE_SSL', false),
    maxConnections: intFromEnv(env, 'DATABASE_POOL_MAX', 10),
    connectionTimeoutMs: intFromEnv(env, 'DATABASE_CONNECT_TIMEOUT_MS', 5_000),
    idleTimeoutMs: intFromEnv(env, 'DATABASE_IDLE_TIMEOUT_MS', 30_000),
    statementTimeoutMs: intFromEnv(env, 'DATABASE_STATEMENT_TIMEOUT_MS', 10_000),
    applicationName: env.DATABASE_APPLICATION_NAME?.trim() || 'jumptotech-labs-api',
  };

  if (url) return { url, ...shared };

  return {
    host: host!,
    port: intFromEnv(env, 'POSTGRES_PORT', 5432),
    ...(env.POSTGRES_DB?.trim() ? { database: env.POSTGRES_DB.trim() } : {}),
    ...(env.POSTGRES_USER?.trim() ? { user: env.POSTGRES_USER.trim() } : {}),
    ...(env.POSTGRES_PASSWORD ? { password: env.POSTGRES_PASSWORD } : {}),
    ...shared,
  };
}

/** A log-safe description: host, port and database only — never the password. */
export function describeDatabase(config: DatabaseConfig): string {
  if (config.url) {
    try {
      const parsed = new URL(config.url);
      const database = parsed.pathname.replace(/^\//, '') || '(default)';
      return `${parsed.hostname}:${parsed.port || '5432'}/${database}`;
    } catch {
      // A connection string we cannot parse is never echoed back: it may well
      // be malformed *because* it contains something unexpected.
      return '(configured)';
    }
  }
  return `${config.host}:${config.port ?? 5432}/${config.database ?? '(default)'}`;
}
