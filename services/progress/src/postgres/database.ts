/**
 * The PostgreSQL connection pool, and the only place `pg` is imported.
 *
 * Everything above this file talks to `SqlExecutor`, which has exactly one
 * method: `query(text, params)`. There is no string-building helper, no
 * `where()` builder, and no way to pass an interpolated statement — the
 * parameter array is the only channel for a value, so a repository method
 * cannot accidentally concatenate one in.
 */
import pg from 'pg';
import { describeDatabase, type DatabaseConfig } from './config.js';

/**
 * Postgres returns `bigint` as a string to avoid silent precision loss, which
 * is right for ids but wrong for the counters this schema uses — `COUNT(*)`
 * comes back as `"3"`. Only `int8` (OID 20) is affected; `integer` columns are
 * already numbers. The rows here are small enough that this is always safe.
 */
pg.types.setTypeParser(20, (value: string) => Number.parseInt(value, 10));

export interface QueryResult<R> {
  rows: R[];
  rowCount: number;
}

/** A thing that can run a parameterised statement: the pool, or one client. */
export interface SqlExecutor {
  query<R>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
}

export class PostgresDatabase implements SqlExecutor {
  readonly #pool: pg.Pool;
  readonly #description: string;

  constructor(pool: pg.Pool, description: string) {
    this.#pool = pool;
    this.#description = description;
    // An idle client erroring (server restart, network blip) must not take the
    // process down; the pool discards it and the next query gets a fresh one.
    this.#pool.on('error', (error: Error) => {
      console.error(`[db] idle client error: ${error.message}`);
    });
  }

  static fromConfig(config: DatabaseConfig): PostgresDatabase {
    const pool = new pg.Pool({
      ...(config.url ? { connectionString: config.url } : {}),
      ...(config.host ? { host: config.host } : {}),
      ...(config.port ? { port: config.port } : {}),
      ...(config.database ? { database: config.database } : {}),
      ...(config.user ? { user: config.user } : {}),
      ...(config.password ? { password: config.password } : {}),
      ...(config.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
      max: config.maxConnections,
      connectionTimeoutMillis: config.connectionTimeoutMs,
      idleTimeoutMillis: config.idleTimeoutMs,
      statement_timeout: config.statementTimeoutMs,
      application_name: config.applicationName,
    });
    return new PostgresDatabase(pool, describeDatabase(config));
  }

  /** Host/port/database, never a credential. Safe to log. */
  get description(): string {
    return this.#description;
  }

  async query<R>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
    return run<R>(this.#pool, text, params);
  }

  /**
   * Run a unit of work in one transaction.
   *
   * Used wherever two writes have to agree — recording a pass touches
   * `lab_attempts` and `lab_progress`, and a crash between them would leave a
   * student's dashboard disagreeing with their own attempt history.
   */
  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(executorFor(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Hold one connection for the duration of `work`.
   *
   * Session-scoped state — advisory locks especially — must be taken and
   * released on the *same* connection, which a pool cannot promise across two
   * separate queries. The migration runner is the only caller.
   */
  async session<T>(work: (client: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      return await work(executorFor(client));
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

/**
 * Run a statement, using the simple query protocol when there are no
 * parameters.
 *
 * `pg` switches to the extended (prepared) protocol as soon as a values array
 * is present — even an empty one — and that protocol permits exactly one
 * statement per message. The migration files are multi-statement by nature, so
 * a parameterless call has to stay on the simple protocol. Values still travel
 * as parameters and are never interpolated into the text.
 */
async function run<R>(
  executor: pg.Pool | pg.PoolClient,
  text: string,
  params: readonly unknown[],
): Promise<QueryResult<R>> {
  const result = await (params.length > 0
    ? executor.query(text, params as unknown[])
    : executor.query(text));

  /*
   * A simple query carrying several statements comes back as an array of
   * results, one per statement — which is exactly what a migration file
   * produces. The last one is the meaningful result for our callers (nothing
   * here asks a multi-statement query for rows), and flattening it here keeps
   * every call site working with one shape.
   */
  const last = Array.isArray(result) ? result[result.length - 1] : result;
  const rows = (last?.rows ?? []) as R[];
  return { rows, rowCount: last?.rowCount ?? rows.length };
}

function executorFor(client: pg.PoolClient): SqlExecutor {
  return {
    query: <R>(text: string, params: readonly unknown[] = []) => run<R>(client, text, params),
  };
}
