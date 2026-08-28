#!/usr/bin/env node
/**
 * Wait until a PostgreSQL server can actually serve a query.
 *
 * ## Why this exists rather than `pg_isready`
 *
 * `make test-db` used to gate on `docker exec <container> pg_isready`, and that
 * is not the same question the suites go on to ask. Two things make it
 * unreliable, and both were measured on this repository rather than assumed:
 *
 *   · **It probes from the wrong side.** `pg_isready` inside the container
 *     talks to the server over its unix socket. The suites connect from the
 *     host over a published TCP port. Those become true at different moments.
 *
 *   · **It answers "yes" to the wrong server.** The official image's entrypoint
 *     runs `initdb` against a *temporary* postmaster with `listen_addresses`
 *     empty, then stops it and starts the real one. `pg_isready` is satisfied
 *     by the temporary one.
 *
 * Measured on a loaded laptop: a host TCP connect succeeded at 2.9s (Docker's
 * port proxy accepts before anything is behind it), `pg_isready` at 10.7s — and
 * a real query at that instant still failed with `ECONNRESET`. So the suites
 * started against a database that could not serve them, and three migration
 * tests failed for a reason that had nothing to do with migrations.
 *
 * A readiness check is only worth anything if it performs the operation it is
 * gating. This one connects over the same URL, with the same driver, and runs a
 * statement — so when it returns, the next connection cannot be the first.
 *
 *   node scripts/wait-for-postgres.mjs "$TEST_DATABASE_URL" [timeoutSeconds]
 */
import pg from 'pg';

const url = process.argv[2] ?? process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const timeoutSeconds = Number(process.argv[3] ?? 60);

if (!url) {
  console.error('wait-for-postgres: no connection URL given (argv[2] or TEST_DATABASE_URL)');
  process.exit(2);
}

const deadline = Date.now() + timeoutSeconds * 1000;
let lastError = 'no attempt was made';

// Credentials belong to a throwaway container, but they are still credentials:
// report the host and port and never the URL.
const shown = (() => {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || 5432}`;
  } catch {
    return 'the configured server';
  }
})();

while (Date.now() < deadline) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.query('select 1');
    await client.end();
    process.exit(0);
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    await client.end().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

console.error(
  `wait-for-postgres: ${shown} did not serve a query within ${timeoutSeconds}s — ${lastError}`,
);
process.exit(1);
