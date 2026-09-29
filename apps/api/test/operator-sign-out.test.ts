/**
 * Signing an account out everywhere through the operator socket.
 *
 * `AuthSessionStore.destroyAllForUser` existed from PLATFORM-010 on, documented
 * as "used when an account is disabled", and nothing called it: an operator
 * facing a stolen session cookie, or a student removed from the course, had no
 * way to end that student's sign-ins short of `DELETE FROM auth_sessions` by
 * hand. `ops sign-out` is that way, at the same trust level as `access` and
 * `role` (`docker exec` into the api container), with the same rules: the
 * account named by internal id, who and why required, the change logged.
 *
 * The browser half is real: students sign in through the OIDC flow against a
 * loopback identity provider, and the cookies they hold are the ones refused.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createLogger, createOperationsMetrics, createRegistry } from '@jumptotech/observability';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildIdentityResolver } from '../src/auth/resolvers.js';
import { OidcTokenVerifier } from '../src/auth/oidc.js';
import { OidcBrowserClient } from '../src/auth/oidc-client.js';
import { InMemoryUserRepository } from '../src/auth/users.js';
import { InMemoryAuthSessionStore } from '../src/auth/browser-session.js';
import { createOperatorHandler, startOperatorSocket } from '../src/operator.js';
import { main as cli, parseArgs } from '../src/operator-cli.js';
import { startFakeIdentityProvider, type FakeIdentityProvider } from './oidc-identity.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'operator-sign-out-terminal-secret';
const APP_URL = 'http://localhost:3000';

let idp: FakeIdentityProvider;
let labs: LabRegistry;

beforeAll(async () => {
  idp = await startFakeIdentityProvider();
  labs = await realCatalog();
});

afterAll(async () => {
  await idp.close();
});

const dirs: string[] = [];
const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function compose(options: { withAuthSessions?: boolean } = {}) {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: APP_URL,
    PUBLIC_ORIGIN: APP_URL,
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: idp.issuer,
    OIDC_CLIENT_ID: idp.clientId,
    OIDC_CLIENT_SECRET: idp.clientSecret,
    OIDC_AUDIENCE: 'jumptotech-labs-api',
  } as NodeJS.ProcessEnv);

  const users = new InMemoryUserRepository('oidc');
  const authSessions = new InMemoryAuthSessionStore();
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime: new FakeContainerRuntime() }) });
  const sessions = new SessionManager({
    registry: labs,
    providers,
    store: new InMemorySessionStore(),
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: config.lifetimes,
    namespaceSecret: SECRET,
  });

  const app = createApp({
    registry: labs,
    sessions,
    k8s: new FakeKubernetes(),
    config,
    identityResolver: buildIdentityResolver({
      config: { mode: 'oidc', nodeEnv: 'test' },
      users,
      verifier: new OidcTokenVerifier({ issuer: idp.issuer, audience: 'jumptotech-labs-api' }),
    }),
    browserAuth: {
      users,
      authSessions,
      client: new OidcBrowserClient({
        issuer: idp.issuer,
        clientId: idp.clientId,
        clientSecret: idp.clientSecret,
        redirectUri: config.auth.browserFlow!.redirectUri,
        scopes: config.auth.browserFlow!.scopes,
      }),
      idTokenVerifier: new OidcTokenVerifier({ issuer: idp.issuer, audience: idp.clientId }),
    },
  });

  const registry = createRegistry({ service: 'api', defaultMetrics: false });
  const operations = createOperationsMetrics(registry);
  const lines: string[] = [];
  const logger = createLogger({ service: 'api', level: 'debug', sink: (line) => lines.push(line) });
  const dir = mkdtempSync('/tmp/jttsignout-');
  dirs.push(dir);
  const socketPath = path.join(dir, 'operator', 'api.sock');
  const server = await startOperatorSocket({
    socketPath,
    logger,
    handler: createOperatorHandler({
      sessions,
      logger,
      actions: operations.operatorActions,
      launchesPaused: false,
      retentionSeconds: 900,
      reaperLastSuccessMs: () => Date.now(),
      reaperIntervalSeconds: 60,
      users,
      ...(options.withAuthSessions === false ? {} : { authSessions }),
    }),
  });
  servers.push(server!);

  const call = (method: 'GET' | 'POST', urlPath: string, body?: unknown) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = httpRequest({ socketPath, method, path: urlPath, headers: payload ? { 'content-type': 'application/json' } : {} }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
      });
      req.on('error', reject);
      req.end(payload);
    });

  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    const writeErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      const code = await cli(argv, { OPERATOR_SOCKET_PATH: socketPath });
      return { code, out: out.join(''), err: err.join('') };
    } finally {
      process.stdout.write = write;
      process.stderr.write = writeErr;
    }
  };

  const metric = async (labels: Record<string, string>) => {
    const found = (await registry.getMetricsAsJSON()).find((m) => m.name === 'jtt_operator_actions_total');
    return ((found?.values ?? []) as Array<{ value: number; labels: Record<string, string | number> }>)
      .filter((v) => Object.entries(labels).every(([k, want]) => v.labels[k] === want))
      .reduce((sum, v) => sum + v.value, 0);
  };

  return { app, users, authSessions, call, run, lines, metric };
}

function cookieValue(setCookie: string[] | undefined, name: string): string | undefined {
  for (const header of setCookie ?? []) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(header);
    if (match && match[1]) return match[1];
  }
  return undefined;
}

/** The whole browser sign-in, as a browser does it; returns the cookie it ends up holding. */
async function signIn(app: Express, subject: string): Promise<string> {
  idp.signInAs({ subject, email: `${subject.replace(/\W/g, '')}@example.test` });
  const login = await request(app).get('/auth/login');
  const tx = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  const authorize = await fetch(login.headers.location as string, { redirect: 'manual' });
  const back = new URL(authorize.headers.get('location')!);
  const callback = await request(app)
    .get('/auth/callback')
    .query({ code: back.searchParams.get('code')!, state: back.searchParams.get('state')! })
    .set('Cookie', tx);
  expect(callback.status, callback.text).toBe(302);
  return `jtt_session=${cookieValue(callback.headers['set-cookie'] as unknown as string[], 'jtt_session')!}`;
}

async function signedIn(app: Express, cookie: string): Promise<boolean> {
  const res = await request(app).get('/auth/session').set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body.data.authenticated === true;
}

describe('ops sign-out', () => {
  it('ends every sign-in the account holds, and nobody else’s', async () => {
    const { app, users, run, lines, metric } = await compose();
    const laptop = await signIn(app, 'auth0|alice');
    const phone = await signIn(app, 'auth0|alice');
    const bob = await signIn(app, 'auth0|bob');
    const alice = (await users.search('alice', 1))[0]!;

    const out = await run('sign-out', alice.userId, '--by', 'aisalkyn', '--reason', 'laptop reported stolen');
    expect(out.code, out.err + out.out).toBe(0);
    expect(out.out).toContain('signed out: 2 browser sign-in(s)');

    // Both of Alice's browsers are refused from their next request, on every path.
    for (const cookie of [laptop, phone]) {
      expect(await signedIn(app, cookie)).toBe(false);
      expect((await request(app).get('/api/me').set('Cookie', cookie)).status).toBe(401);
      expect((await request(app).post('/api/labs/LINUX-001/start').set('Cookie', cookie)).status).toBe(401);
    }
    // Bob is untouched.
    expect(await signedIn(app, bob)).toBe(true);

    const entry = lines.map((line) => JSON.parse(line)).find((e) => e.event === 'ops.operator.signed_out');
    expect(entry).toMatchObject({ userId: alice.userId, result: '2', level: 'warn' });
    expect(entry.msg).toContain('by aisalkyn: laptop reported stolen');
    expect(await metric({ action: 'sign_out', outcome: 'ok' })).toBe(1);

    // It ends sign-ins, not the account: Alice can sign in again.
    const again = await signIn(app, 'auth0|alice');
    expect(await signedIn(app, again)).toBe(true);

    // Nothing left to end is still an answer, not an error.
    await request(app).post('/auth/logout').set('Cookie', again);
    const idle = await run('sign-out', alice.userId, '--by', 'aisalkyn', '--reason', 'again');
    expect(idle.code).toBe(0);
    expect(idle.out).toContain('signed out: 0 browser sign-in(s)');
  });

  it('refuses a missing who or why, an unknown account, a smuggled field and a reason with a newline', async () => {
    const { app, users, run, call, metric } = await compose();
    const cookie = await signIn(app, 'auth0|carol');
    const carol = (await users.search('carol', 1))[0]!;

    expect((await run('sign-out', carol.userId, '--reason', 'y')).code).toBe(2);
    expect((await run('sign-out', carol.userId, '--by', 'x')).code).toBe(2);

    const unknown = await run('sign-out', 'usr-99999999', '--by', 'x', '--reason', 'y');
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain('USER_NOT_FOUND');
    expect(await metric({ action: 'sign_out', outcome: 'rejected' })).toBe(1);

    const byEmail = await call('POST', `/v1/users/${encodeURIComponent('carol@example.test')}/sign-out`, { by: 'x', reason: 'y' });
    expect(byEmail.status).toBe(400);
    expect(byEmail.body.error.code).toBe('INVALID_USER_ID');

    const smuggled = await call('POST', `/v1/users/${carol.userId}/sign-out`, { by: 'x', reason: 'y', all: true });
    expect(smuggled.status).toBe(400);
    const newline = await call('POST', `/v1/users/${carol.userId}/sign-out`, { by: 'x', reason: 'ok\nFAKE LOG LINE' });
    expect(newline.status).toBe(400);
    expect(newline.body.error.code).toBe('INVALID_REASON');
    const read = await call('GET', `/v1/users/${carol.userId}/sign-out`);
    expect(read.status).toBe(404);

    // None of those ended anything.
    expect(await signedIn(app, cookie)).toBe(true);
  });

  it('does not exist where no sign-in store was composed', async () => {
    const { app, users, call } = await compose({ withAuthSessions: false });
    await signIn(app, 'auth0|dave');
    const dave = (await users.search('dave', 1))[0]!;
    expect((await call('POST', `/v1/users/${dave.userId}/sign-out`, { by: 'x', reason: 'y' })).status).toBe(404);
  });

  it('parses the CLI strictly', () => {
    expect(parseArgs(['sign-out'])).toMatchObject({ error: expect.stringContaining('exactly one <user-id>') });
    expect(parseArgs(['sign-out', 'u', 'v', '--by', 'x', '--reason', 'y'])).toMatchObject({ error: expect.stringContaining('exactly one') });
    expect(parseArgs(['sign-out', 'u', '--by', 'x', '--reason', 'y', '--everyone'])).toMatchObject({ error: 'unknown option --everyone for sign-out' });
    expect(parseArgs(['sign-out', 'u', '--by', 'me', '--reason', 'why', '--json'])).toEqual({
      command: { kind: 'sign-out', userId: 'u', body: { by: 'me', reason: 'why' } },
      json: true,
    });
  });
});
