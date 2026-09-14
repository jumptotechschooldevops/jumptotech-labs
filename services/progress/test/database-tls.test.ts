/**
 * BETA-P0-012 — the connection to PostgreSQL is verified TLS, or plaintext only
 * where production says plaintext is acceptable.
 *
 *   1. Configuration. `DATABASE_SSL` is read strictly; a CA file without TLS, a
 *      CA bundle holding a key, and any TLS parameter in `DATABASE_URL` are
 *      refused in every environment, without echoing the URL's password.
 *   2. The production transport rules: TLS, a Unix socket, loopback, or a
 *      declared single-host bridge — nothing else.
 *   3. A real TLS handshake against a PostgreSQL-speaking listener: a trusted
 *      certificate connects; an untrusted CA or the wrong host name is refused
 *      before the startup message (which carries the user) is sent; and neither
 *      `NODE_TLS_REJECT_UNAUTHORIZED=0` nor `PGSSLMODE=no-verify` in the process
 *      weakens that.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TLSSocket, createSecureContext } from 'node:tls';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createTestCa, type TestIdentity } from '@jumptotech/test-support/tls-pki';
import { loadDatabaseConfig, type DatabaseConfig } from '../src/postgres/config.js';
import { PostgresDatabase } from '../src/postgres/database.js';
import {
  DatabaseTransportError,
  databaseTlsOptions,
  resolveDatabaseTransport,
} from '../src/postgres/tls.js';

const PASSWORD = 'p0012-database-password-sentinel';
const PROD = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
const DEV = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;
const DECLARED = { ...PROD, DATABASE_SAME_HOST_PLAINTEXT: 'true' } as NodeJS.ProcessEnv;

const ca = createTestCa();
const work = mkdtempSync(path.join(tmpdir(), 'jtt-db-tls-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const caFile = path.join(work, 'ca.pem');
writeFileSync(caFile, ca.cert, { mode: 0o600 });

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseTransportError);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
}

const url = (host: string, query = ''): string => `postgresql://labs:${PASSWORD}@${host}:5432/labs${query}`;
const transport = (env: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv = {}) =>
  resolveDatabaseTransport(loadDatabaseConfig({ ...env, ...extra })!, { ...env, ...extra }, 'api').mode;

describe('database TLS configuration, in every environment', () => {
  it('builds verified TLS or none, and has no unverified form', () => {
    expect(databaseTlsOptions({ ssl: false })).toBe(false);
    expect(databaseTlsOptions({ ssl: true })).toEqual({ rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    expect(databaseTlsOptions({ ssl: true, sslCa: ca.cert })).toEqual({
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      ca: ca.cert,
    });
  });

  it('reads DATABASE_SSL strictly, so a typo cannot mean plaintext', () => {
    for (const value of ['true', '1', 'yes', 'ON']) {
      expect(loadDatabaseConfig({ DATABASE_URL: url('db'), DATABASE_SSL: value })?.ssl, value).toBe(true);
    }
    for (const value of ['', 'false', '0', 'no', 'off']) {
      expect(loadDatabaseConfig({ DATABASE_URL: url('db'), DATABASE_SSL: value })?.ssl, value).toBe(false);
    }
    for (const value of ['verify', 'require', 'no-verify']) {
      expect(refusal(() => loadDatabaseConfig({ DATABASE_URL: url('db'), DATABASE_SSL: value }))).toMatch(
        /DATABASE_SSL must be true or false/,
      );
    }
  });

  it('refuses every TLS parameter in DATABASE_URL, without echoing the password', () => {
    for (const query of [
      '?sslmode=no-verify',
      '?sslmode=disable',
      '?sslmode=require',
      '?sslmode=verify-full',
      '?ssl=true',
      '?ssl=no-verify',
      '?sslrootcert=/etc/ssl/ca.pem',
      '?sslcert=/c&sslkey=/k',
      '?uselibpqcompat=true&sslmode=require',
      '?SSLMODE=no-verify',
      '?ssl%6Dode=no-verify',
      '?application_name=x&sslmode=no-verify',
    ]) {
      const message = refusal(() => loadDatabaseConfig({ DATABASE_URL: url('db', query), DATABASE_SSL: 'true' }));
      expect(message, query).toMatch(/DATABASE_URL carries TLS parameters/);
      expect(message, query).not.toContain(PASSWORD);
    }
    expect(loadDatabaseConfig({ DATABASE_URL: url('db', '?application_name=labs') })?.url).toContain('application_name');
  });

  it('refuses the same parameters in a hand-built config, before a pool exists', () => {
    const config: DatabaseConfig = {
      url: url('db', '?sslmode=no-verify'),
      ssl: true,
      maxConnections: 1,
      connectionTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      statementTimeoutMs: 1000,
      applicationName: 'test',
    };
    expect(refusal(() => PostgresDatabase.fromConfig(config))).toMatch(/TLS parameters \(sslmode\)/);
  });

  it('refuses a CA file without TLS, and a CA file that is not a CA bundle', () => {
    expect(refusal(() => loadDatabaseConfig({ DATABASE_URL: url('db'), DATABASE_SSL_CA_FILE: caFile }))).toMatch(
      /A CA file means TLS was intended/,
    );
    const withKey = path.join(work, 'with-key.pem');
    writeFileSync(withKey, `${ca.cert}${ca.issue({ dns: ['db'] }).key}`);
    const empty = path.join(work, 'empty.pem');
    writeFileSync(empty, 'not a certificate\n');
    const env = { DATABASE_URL: url('db'), DATABASE_SSL: 'true' };
    expect(refusal(() => loadDatabaseConfig({ ...env, DATABASE_SSL_CA_FILE: withKey }))).toMatch(/private key/);
    expect(refusal(() => loadDatabaseConfig({ ...env, DATABASE_SSL_CA_FILE: empty }))).toMatch(/no PEM certificate/);
    expect(refusal(() => loadDatabaseConfig({ ...env, DATABASE_SSL_CA_FILE: path.join(work, 'missing.pem') }))).toMatch(
      /could not be read/,
    );
    expect(loadDatabaseConfig({ ...env, DATABASE_SSL_CA_FILE: caFile })?.sslCa).toContain('BEGIN CERTIFICATE');
  });
});

describe('the database transport under NODE_ENV=production', () => {
  it('accepts verified TLS to any host, with or without a private CA', () => {
    expect(transport(PROD, { DATABASE_URL: url('db.internal.example'), DATABASE_SSL: 'true' })).toBe('tls');
    expect(
      transport(PROD, { DATABASE_URL: url('10.0.0.5'), DATABASE_SSL: 'true', DATABASE_SSL_CA_FILE: caFile }),
    ).toBe('tls');
    expect(transport(PROD, { POSTGRES_HOST: 'db.internal.example', DATABASE_SSL: 'true' })).toBe('tls');
  });

  it('refuses plaintext to anything that is not local or declared', () => {
    for (const host of ['db.internal.example', '10.0.0.5', 'postgres', 'localhost']) {
      const message = refusal(() => transport(PROD, { DATABASE_URL: url(host) }));
      expect(message, host).toMatch(/refuses to send the database password over plaintext/);
      expect(message, host).not.toContain(PASSWORD);
    }
    expect(refusal(() => transport(PROD, { POSTGRES_HOST: 'db.internal.example' }))).toMatch(/over plaintext/);
  });

  it('accepts a Unix socket and loopback literals, which never leave the host', () => {
    expect(transport(PROD, { POSTGRES_HOST: '/var/run/postgresql' })).toBe('local-socket');
    expect(transport(PROD, { DATABASE_URL: `postgresql://labs:${PASSWORD}@/labs?host=/var/run/postgresql` })).toBe(
      'local-socket',
    );
    expect(transport(PROD, { DATABASE_URL: url('127.0.0.1') })).toBe('loopback-plaintext');
    expect(transport(PROD, { DATABASE_URL: url('[::1]') })).toBe('loopback-plaintext');
  });

  it('accepts the compose arrangement only as declared, and only for a service name', () => {
    expect(transport(DECLARED, { DATABASE_URL: url('postgres') })).toBe('same-host-plaintext');
    for (const host of ['db.internal.example', '10.0.0.5']) {
      expect(refusal(() => transport(DECLARED, { DATABASE_URL: url(host) })), host).toMatch(
        /covers a Compose service name/,
      );
    }
    expect(refusal(() => transport({ ...PROD, DATABASE_SAME_HOST_PLAINTEXT: 'yes' }, { DATABASE_URL: url('postgres') }))).toMatch(
      /must be 'true' or unset/,
    );
  });

  it('refuses the declaration beside TLS, where it would mean nothing', () => {
    expect(refusal(() => transport(DECLARED, { DATABASE_URL: url('postgres'), DATABASE_SSL: 'true' }))).toMatch(
      /exists only for plaintext/,
    );
  });

  it('refuses PGSSLMODE, which the pool never reads, rather than let it look effective', () => {
    for (const mode of ['no-verify', 'disable', 'verify-full']) {
      expect(
        refusal(() => transport(PROD, { DATABASE_URL: url('db.internal.example'), DATABASE_SSL: 'true', PGSSLMODE: mode })),
      ).toMatch(/PGSSLMODE is set/);
    }
  });

  it('keeps development plaintext working, and says so', () => {
    expect(transport(DEV, { DATABASE_URL: url('db.internal.example') })).toBe('development-plaintext');
    expect(transport({}, { DATABASE_URL: url('postgres'), PGSSLMODE: 'no-verify' })).toBe('development-plaintext');
  });
});

/**
 * Just enough of the PostgreSQL wire protocol to prove the TLS decision: answer
 * the SSLRequest with `S`, complete a handshake with the given identity, then
 * accept the startup message with AuthenticationOk + ReadyForQuery.
 */
interface FakePostgres {
  port: number;
  handshakes: number;
  startups: number;
  plaintextStartups: number;
  close(): Promise<void>;
}

const SSL_REQUEST_CODE = 80877103;
const listeners: Server[] = [];
afterEach(async () => {
  await Promise.all(listeners.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function fakePostgres(identity: TestIdentity): Promise<FakePostgres> {
  const sockets = new Set<Socket>();
  const state = { handshakes: 0, startups: 0, plaintextStartups: 0 };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('data', (first) => {
      if (first.length < 8 || first.readInt32BE(4) !== SSL_REQUEST_CODE) {
        state.plaintextStartups += 1;
        socket.destroy();
        return;
      }
      socket.write('S');
      const secure = new TLSSocket(socket, {
        isServer: true,
        secureContext: createSecureContext({ cert: identity.cert, key: identity.key }),
      });
      secure.on('error', () => undefined);
      secure.on('secure', () => {
        state.handshakes += 1;
      });
      secure.once('data', () => {
        state.startups += 1;
        secure.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0])); // AuthenticationOk
        secure.write(Buffer.from([0x5a, 0, 0, 0, 5, 0x49])); // ReadyForQuery (idle)
      });
    });
  });
  listeners.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    get handshakes() {
      return state.handshakes;
    },
    get startups() {
      return state.startups;
    },
    get plaintextStartups() {
      return state.plaintextStartups;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
    },
  };
}

async function connect(env: NodeJS.ProcessEnv): Promise<void> {
  const config = loadDatabaseConfig({ DATABASE_CONNECT_TIMEOUT_MS: '3000', ...env })!;
  const db = PostgresDatabase.fromConfig(config);
  try {
    await db.session(async () => undefined);
  } finally {
    await db.close().catch(() => undefined);
  }
}

describe('the pool over a real TLS handshake', () => {
  it('connects to a server whose certificate the configured CA vouches for', async () => {
    const server = await fakePostgres(ca.issue({ dns: ['localhost'] }));
    await connect({
      DATABASE_URL: `postgresql://labs:${PASSWORD}@localhost:${server.port}/labs`,
      DATABASE_SSL: 'true',
      DATABASE_SSL_CA_FILE: caFile,
    });
    expect(server.handshakes).toBe(1);
    expect(server.startups).toBe(1);
    await server.close();
  });

  it('refuses a certificate from an untrusted CA before sending the startup message', async () => {
    const server = await fakePostgres(createTestCa('someone else').issue({ dns: ['localhost'] }));
    await expect(
      connect({
        DATABASE_URL: `postgresql://labs:${PASSWORD}@localhost:${server.port}/labs`,
        DATABASE_SSL: 'true',
        DATABASE_SSL_CA_FILE: caFile,
      }),
    ).rejects.toThrow(/certificate|self.signed|verify/i);
    expect(server.startups).toBe(0);
    await server.close();
  });

  it('refuses a trusted certificate issued for another host', async () => {
    const server = await fakePostgres(ca.issue({ dns: ['db.other.example'] }));
    await expect(
      connect({
        DATABASE_URL: `postgresql://labs:${PASSWORD}@localhost:${server.port}/labs`,
        DATABASE_SSL: 'true',
        DATABASE_SSL_CA_FILE: caFile,
      }),
    ).rejects.toThrow(/localhost|altname|host/i);
    expect(server.startups).toBe(0);
    await server.close();
  });

  it('is not weakened by NODE_TLS_REJECT_UNAUTHORIZED=0 or PGSSLMODE=no-verify in the process', async () => {
    const server = await fakePostgres(createTestCa('someone else').issue({ dns: ['localhost'] }));
    const previous = { tls: process.env.NODE_TLS_REJECT_UNAUTHORIZED, mode: process.env.PGSSLMODE };
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    process.env.PGSSLMODE = 'no-verify';
    try {
      await expect(
        connect({
          DATABASE_URL: `postgresql://labs:${PASSWORD}@localhost:${server.port}/labs`,
          DATABASE_SSL: 'true',
          DATABASE_SSL_CA_FILE: caFile,
        }),
      ).rejects.toThrow();
      expect(server.startups).toBe(0);
    } finally {
      if (previous.tls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous.tls;
      if (previous.mode === undefined) delete process.env.PGSSLMODE;
      else process.env.PGSSLMODE = previous.mode;
      await server.close();
    }
  });

  it('passes ssl explicitly when TLS is off, so PGSSLMODE cannot switch on an unverified handshake', async () => {
    const server = await fakePostgres(ca.issue({ dns: ['localhost'] }));
    const previous = process.env.PGSSLMODE;
    process.env.PGSSLMODE = 'no-verify';
    try {
      await expect(
        connect({ DATABASE_URL: `postgresql://labs:${PASSWORD}@localhost:${server.port}/labs` }),
      ).rejects.toThrow();
      expect(server.plaintextStartups).toBe(1);
      expect(server.handshakes).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.PGSSLMODE;
      else process.env.PGSSLMODE = previous;
      await server.close();
    }
  });
});
