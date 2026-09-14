/**
 * BETA-P0-012 — the api reaches PostgreSQL over verified TLS, or over plaintext
 * only where production accepts it, and the earlier gates keep their order.
 *
 *   1. `loadConfig` refuses, under NODE_ENV=production, a database the password
 *      would reach in plaintext across a network, TLS parameters smuggled into
 *      `DATABASE_URL`, and PGSSLMODE. It accepts verified TLS, loopback, and the
 *      declared compose bridge, and reports which.
 *   2. The P0-008 owner gate, the P0-010 secret gate and the P0-011 transport
 *      gate still run first; runtime owner and beta capacity survive.
 *   3. The shipped compose files are the declared arrangement: the declaration
 *      is made once, for the api, and the production overlay pins
 *      NODE_ENV=production so none of this can be skipped by `.env`.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadDatabaseConfig, resolveDatabaseTransport } from '@jumptotech/progress';
import { createTestCa } from '@jumptotech/test-support/tls-pki';
import { loadConfig } from '../src/config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const hex = (label: string): string => createHash('sha256').update(label).digest('hex');
const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');

const DB_PASSWORD = hex('database-password').slice(0, 32);
const PRODUCTION = {
  NODE_ENV: 'production',
  AUTH_MODE: 'oidc',
  OIDC_ISSUER: 'https://issuer.example.com',
  OIDC_CLIENT_ID: 'jumptotech-labs',
  OIDC_AUDIENCE: 'jumptotech-labs',
  // BETA-P0-014: the confidential client's credential is required in production.
  OIDC_CLIENT_SECRET: hex('oidc-client').slice(0, 40),
  PUBLIC_ORIGIN: 'https://labs.example.com',
  ALLOWED_ORIGINS: 'https://labs.example.com',
  TERMINAL_SESSION_SECRET: hex('terminal-session'),
  INTERNAL_SERVICE_SECRET: hex('internal-service'),
  NAMESPACE_DERIVATION_SECRET: hex('namespace-derivation'),
  OBSERVABILITY_SCRAPE_TOKEN: hex('scrape-token'),
  RUNTIME_OWNER_ID: 'labs-prod',
} as NodeJS.ProcessEnv;
const url = (host: string, query = ''): string => `postgresql://jumptotech:${DB_PASSWORD}@${host}:5432/labs${query}`;

const ca = createTestCa();
const work = mkdtempSync(path.join(tmpdir(), 'jtt-api-db-transport-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const caFile = path.join(work, 'ca.pem');
writeFileSync(caFile, ca.cert, { mode: 0o600 });

function refusal(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected loadConfig to refuse');
}

describe('the api database transport under NODE_ENV=production', () => {
  it('refuses the database password in plaintext to a host of its own, without echoing it', () => {
    for (const host of ['db.internal.example', '10.20.0.7', 'postgres']) {
      const message = refusal({ ...PRODUCTION, DATABASE_URL: url(host) });
      expect(message, host).toMatch(/api refuses to send the database password over plaintext/);
      expect(message, host).not.toContain(DB_PASSWORD);
    }
  });

  it('accepts verified TLS, and carries the CA for the database connection only', () => {
    const config = loadConfig({
      ...PRODUCTION,
      DATABASE_URL: url('db.internal.example'),
      DATABASE_SSL: 'true',
      DATABASE_SSL_CA_FILE: caFile,
    });
    expect(config.progress.databaseTransport).toBe('tls');
    expect(config.progress.database?.ssl).toBe(true);
    expect(config.progress.database?.sslCa).toContain('BEGIN CERTIFICATE');
    expect(process.env.NODE_EXTRA_CA_CERTS ?? '').not.toContain(caFile);
  });

  it('accepts the compose arrangement as declared, and loopback', () => {
    expect(
      loadConfig({ ...PRODUCTION, DATABASE_URL: url('postgres'), DATABASE_SAME_HOST_PLAINTEXT: 'true' }).progress
        .databaseTransport,
    ).toBe('same-host-plaintext');
    expect(loadConfig({ ...PRODUCTION, DATABASE_URL: url('127.0.0.1') }).progress.databaseTransport).toBe(
      'loopback-plaintext',
    );
  });

  it('refuses TLS parameters in DATABASE_URL, which would override verification', () => {
    for (const query of ['?sslmode=no-verify', '?sslmode=disable', '?uselibpqcompat=true&sslmode=require']) {
      const message = refusal({ ...PRODUCTION, DATABASE_URL: url('db.internal.example', query), DATABASE_SSL: 'true' });
      expect(message, query).toMatch(/DATABASE_URL carries TLS parameters/);
      expect(message, query).not.toContain(DB_PASSWORD);
    }
  });

  it('refuses PGSSLMODE and a process-wide verification bypass', () => {
    const tls = { ...PRODUCTION, DATABASE_URL: url('db.internal.example'), DATABASE_SSL: 'true' };
    expect(refusal({ ...tls, PGSSLMODE: 'no-verify' })).toMatch(/PGSSLMODE is set/);
    expect(refusal({ ...tls, NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
  });

  it('refuses the declaration beside TLS', () => {
    expect(
      refusal({ ...PRODUCTION, DATABASE_URL: url('db.internal.example'), DATABASE_SSL: 'true', DATABASE_SAME_HOST_PLAINTEXT: 'true' }),
    ).toMatch(/exists only for plaintext/);
  });

  it('refuses production with no database at all, and resolves no transport without one elsewhere', () => {
    // BETA-P0-014: production sign-in needs durable sessions, so "no database"
    // is a refusal there rather than a transport of null.
    expect(refusal(PRODUCTION)).toMatch(/DATABASE_URL is not set: production sign-in requires durable/);
    expect(
      loadConfig({ TERMINAL_SESSION_SECRET: 'a-long-enough-dev-secret' } as NodeJS.ProcessEnv).progress
        .databaseTransport,
    ).toBeNull();
  });

  it('keeps the owner, secret and broker transport gates ahead of the database gate', () => {
    const remotePlaintext = { ...PRODUCTION, DATABASE_URL: url('db.internal.example') };
    expect(refusal({ ...remotePlaintext, RUNTIME_OWNER_ID: undefined })).toMatch(/RUNTIME_OWNER_ID must be set/);
    expect(refusal({ ...remotePlaintext, INTERNAL_SERVICE_SECRET: 'dev-only-insecure-secret-change-me' })).toContain(
      'INTERNAL_SERVICE_SECRET is a placeholder',
    );
    expect(
      refusal({
        ...remotePlaintext,
        SANDBOX_BROKER_URL: 'http://sandboxd.runtime.example:4002',
        SANDBOXD_RUNTIME_SECRET: hex('runtime').slice(0, 48),
        SANDBOXD_DOCKER_SECRET: hex('docker').slice(0, 48),
      }),
    ).toMatch(/api refuses to send sandboxd capability secrets/);
  });

  it('leaves runtime ownership, beta capacity and the broker transport unchanged', () => {
    const config = loadConfig({
      ...PRODUCTION,
      DATABASE_URL: url('postgres'),
      DATABASE_SAME_HOST_PLAINTEXT: 'true',
      SANDBOX_BROKER_URL: 'http://sandboxd:4002',
      SANDBOX_BROKER_SAME_HOST_PLAINTEXT: 'true',
      SANDBOXD_RUNTIME_SECRET: hex('runtime').slice(0, 48),
      SANDBOXD_DOCKER_SECRET: hex('docker').slice(0, 48),
      MAX_ACTIVE_SESSIONS: '5',
      MAX_ACTIVE_SESSIONS_PER_STUDENT: '1',
    });
    expect(config.sandbox.runtimeOwner).toBe('labs-prod');
    expect(config.lifetimes).toMatchObject({ maxActiveSessions: 5, maxActiveSessionsPerStudent: 1 });
    expect(config.sandbox.runtimeBrokerTransport?.mode).toBe('same-host-plaintext');
    expect(config.progress.databaseTransport).toBe('same-host-plaintext');
  });

  it('keeps development plaintext working', () => {
    const config = loadConfig({
      TERMINAL_SESSION_SECRET: 'a-long-enough-dev-secret',
      DATABASE_URL: url('db.internal.example'),
    } as NodeJS.ProcessEnv);
    expect(config.progress.databaseTransport).toBe('development-plaintext');
  });
});

/** One service's `environment:` entries from a compose file, comments ignored. */
function composeEnvironment(file: string, service: string): Record<string, string> {
  const env: Record<string, string> = {};
  let inServices = false;
  let current: string | null = null;
  for (const line of read(file).split('\n')) {
    if (/^\S/.test(line)) {
      inServices = line.startsWith('services:');
      current = null;
      continue;
    }
    if (!inServices || /^\s*#/.test(line)) continue;
    const name = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line);
    if (name) {
      current = name[1]!;
      continue;
    }
    if (current !== service) continue;
    const entry = /^ {6}([A-Z][A-Z0-9_]*):\s*"?([^"#]*?)"?\s*$/.exec(line);
    if (entry) env[entry[1]!] = entry[2]!;
  }
  return env;
}

describe('the shipped database configuration', () => {
  const COMPOSE_FILES = [
    'docker-compose.yml',
    'docker-compose.runtime.yml',
    'docker-compose.observability.yml',
    'docker-compose.production.yml',
  ];

  it('is the declared single-host arrangement, and passes the production rules as such', () => {
    const api = composeEnvironment('docker-compose.yml', 'api');
    expect(api.DATABASE_SAME_HOST_PLAINTEXT).toBe('true');
    expect(api.DATABASE_SSL).toBeUndefined();
    const host = /@([a-z][a-z0-9-]*):5432\//.exec(api.DATABASE_URL ?? '')?.[1];
    expect(host).toBe('postgres');
    const env = { NODE_ENV: 'production', DATABASE_SAME_HOST_PLAINTEXT: api.DATABASE_SAME_HOST_PLAINTEXT };
    const config = loadDatabaseConfig({ DATABASE_URL: url(host!) })!;
    expect(resolveDatabaseTransport(config, env, 'api').mode).toBe('same-host-plaintext');
  });

  it('makes that declaration for the api in the base file, and nowhere else', () => {
    const holders = COMPOSE_FILES.flatMap((file) =>
      ['postgres', 'api', 'terminal', 'sandboxd', 'web', 'prometheus', 'alertmanager', 'grafana']
        .filter((service) => composeEnvironment(file, service).DATABASE_SAME_HOST_PLAINTEXT !== undefined)
        .map((service) => `${file}:${service}`),
    );
    expect(holders).toEqual(['docker-compose.yml:api']);
  });

  it('pins NODE_ENV=production for the api in the production overlay, so the gate always runs', () => {
    expect(composeEnvironment('docker-compose.production.yml', 'api')).toMatchObject({
      NODE_ENV: 'production',
      AUTH_MODE: 'oidc',
    });
  });

  it('gives no service but the api a database credential or URL', () => {
    for (const file of COMPOSE_FILES) {
      for (const service of ['terminal', 'sandboxd', 'web', 'prometheus', 'alertmanager', 'grafana']) {
        const env = composeEnvironment(file, service);
        expect(Object.keys(env).filter((name) => /^(DATABASE_|PG)/.test(name)), `${file}:${service}`).toEqual([]);
      }
    }
  });
});
