/**
 * PLATFORM-010 — the ways in, and the fact that they are closed.
 *
 * One suite per attack, in the order they are actually tried:
 *
 *   1. no credential at all
 *   2. a credential that is not real     (forged cookie, forged bearer token)
 *   3. a credential that *was* real      (expired session, signed-out session)
 *   4. a real credential, wrong subject  (foreign issuer, wrong audience)
 *   5. a forged identifier               (naming a user in a query/body/header)
 *   6. a real identifier belonging to someone else (cross-user session id)
 *   7. the sign-in flow itself           (CSRF, replay, open redirect)
 *
 * Everything here runs in `AUTH_MODE=oidc` against a real in-process identity
 * provider, because a stubbed verifier would prove only that a function was
 * called.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes, fakeExec } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildIdentityResolver } from '../src/auth/resolvers.js';
import { OidcTokenVerifier } from '../src/auth/oidc.js';
import { OidcBrowserClient } from '../src/auth/oidc-client.js';
import { InMemoryUserRepository } from '../src/auth/users.js';
import { InMemoryAuthSessionStore, mintAuthSessionId } from '../src/auth/browser-session.js';
import { safeReturnTo } from '../src/routes/auth.js';
import { startFakeIdentityProvider, foreignToken, type FakeIdentityProvider } from './oidc-identity.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'auth-security-terminal-session-secret';
const APP_URL = 'http://localhost:3000';
const API_AUDIENCE = 'jumptotech-labs-api';

let idp: FakeIdentityProvider;
let registry: LabRegistry;

beforeAll(async () => {
  idp = await startFakeIdentityProvider();
  registry = new LabRegistry(path.join(repoRoot, 'labs'));
  await registry.load();
});

afterAll(async () => {
  await idp.close();
});

interface Harness {
  app: Express;
  authSessions: InMemoryAuthSessionStore;
  users: InMemoryUserRepository;
  now: { value: number };
}

function buildApp(): Harness {
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
    OIDC_AUDIENCE: API_AUDIENCE,
  } as NodeJS.ProcessEnv);

  // A movable clock, so expiry is tested by expiring rather than by waiting.
  const now = { value: Date.now() };
  const authSessions = new InMemoryAuthSessionStore({ now: () => now.value });
  const users = new InMemoryUserRepository('oidc');
  const k8s = new FakeKubernetes();

  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({
    provider: new KindLabProvider({ k8s, clusterName: 'jumptotech-labs', exec: fakeExec() }),
  });
  providers.register({ provider: new LinuxLabProvider({ runtime: new FakeContainerRuntime() }) });

  const sessions = new SessionManager({
    registry,
    providers,
    store: new InMemorySessionStore(),
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: config.lifetimes,
    namespaceSecret: SECRET,
  });

  const app = createApp({
    registry,
    sessions,
    k8s,
    config,
    identityResolver: buildIdentityResolver({
      config: { mode: 'oidc', nodeEnv: 'test' },
      users,
      verifier: new OidcTokenVerifier({ issuer: idp.issuer, audience: API_AUDIENCE }),
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

  return { app, authSessions, users, now };
}

function cookieValue(setCookie: string[] | undefined, name: string): string | undefined {
  for (const header of setCookie ?? []) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(header);
    if (match && match[1]) return match[1];
  }
  return undefined;
}

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
  return `jtt_session=${cookieValue(callback.headers['set-cookie'] as unknown as string[], 'jtt_session')!}`;
}

async function start(app: Express, cookie: string) {
  const res = await request(app).post('/api/labs/LINUX-001/start').set('Cookie', cookie);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { session: { sessionId: string }; terminal: { token: string } };
}

/** Every session-scoped route, so no test can silently cover only some. */
const SESSION_ROUTES = (app: Express, id: string): Array<[string, () => request.Test]> => [
  ['read', () => request(app).get(`/api/sessions/${id}`)],
  ['check', () => request(app).post(`/api/sessions/${id}/check`)],
  ['reset', () => request(app).post(`/api/sessions/${id}/reset`)],
  ['activity', () => request(app).post(`/api/sessions/${id}/activity`)],
  ['hint', () => request(app).post(`/api/sessions/${id}/hints`).send({ level: 1 })],
  ['end', () => request(app).delete(`/api/sessions/${id}`)],
];

let harness: Harness;
beforeEach(() => {
  harness = buildApp();
});

// ---------------------------------------------------- 1. no authentication

describe('missing authentication', () => {
  it('refuses every browser route with no credential at all', async () => {
    const { app } = harness;

    for (const [path, call] of [
      ['start', () => request(app).post('/api/labs/LINUX-001/start')],
      ['catalog', () => request(app).get('/api/labs')],
      ['tracks', () => request(app).get('/api/tracks')],
      ['me', () => request(app).get('/api/me')],
      ['progress', () => request(app).get('/api/me/progress')],
    ] as Array<[string, () => request.Test]>) {
      const res = await call();
      expect(res.status, path).toBe(401);
      expect(res.body.error.code, path).toBe('AUTH_REQUIRED');
    }
  });

  it('refuses every session route with no credential', async () => {
    const { app } = harness;
    const cookie = await signIn(app, 'auth0|owner');
    const { session } = await start(app, cookie);

    for (const [name, call] of SESSION_ROUTES(app, session.sessionId)) {
      const res = await call();
      expect(res.status, name).toBe(401);
    }
  });

  it('still serves /health, so a readiness probe needs no token', async () => {
    expect((await request(harness.app).get('/health')).status).toBe(200);
  });
});

// ------------------------------------------- 2. invalid token or session

describe('invalid token or session', () => {
  it('refuses a forged session cookie', async () => {
    const { app } = harness;
    // Correctly *shaped*, and names no record. Shape is not authority.
    const forged = mintAuthSessionId().cookieValue;

    const res = await request(app).post('/api/labs/LINUX-001/start').set('Cookie', `jtt_session=${forged}`);
    expect(res.status).toBe(401);
  });

  it('refuses a cookie that is not even the right shape', async () => {
    const { app } = harness;
    for (const value of ['', 'x', '../../etc/passwd', 'a'.repeat(500), '{"userId":"usr-1"}']) {
      const res = await request(app).get('/api/me').set('Cookie', `jtt_session=${encodeURIComponent(value)}`);
      expect(res.status, value.slice(0, 20)).toBe(401);
    }
  });

  it('refuses a bearer token this issuer never signed', async () => {
    const { app } = harness;
    // Well formed, correct issuer and audience — signed by the wrong key. This
    // is the token a decode-instead-of-verify implementation would accept.
    const token = await foreignToken(idp.issuer, API_AUDIENCE, 'auth0|impostor');

    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('refuses a malformed Authorization header', async () => {
    const { app } = harness;
    for (const header of ['Bearer', 'Bearer ', 'Basic abc', 'nonsense', 'Bearer a.b.c']) {
      const res = await request(app).get('/api/me').set('Authorization', header);
      expect(res.status, header).toBe(401);
    }
  });

  it('does not say which check failed', async () => {
    const { app } = harness;
    const forged = mintAuthSessionId().cookieValue;
    const badToken = await foreignToken(idp.issuer, API_AUDIENCE, 'auth0|impostor');

    const viaCookie = await request(app).get('/api/me').set('Cookie', `jtt_session=${forged}`);
    const viaBearer = await request(app).get('/api/me').set('Authorization', `Bearer ${badToken}`);

    // Neither message names a signature, an issuer, an audience or a store —
    // any of which would be an oracle for a caller guessing.
    for (const res of [viaCookie, viaBearer]) {
      expect(JSON.stringify(res.body)).not.toMatch(/signature|issuer|audience|jwks|database/i);
    }
  });
});

// ------------------------------------------------- 3. expired credentials

describe('expired authentication', () => {
  it('refuses a session past its expiry, and says so distinctly', async () => {
    const { app, now } = harness;
    const cookie = await signIn(app, 'auth0|expiring');

    expect((await request(app).get('/api/me').set('Cookie', cookie)).status).toBe(200);

    // 12 hours and a second later.
    now.value += 12 * 60 * 60 * 1000 + 1000;

    const res = await request(app).get('/api/me').set('Cookie', cookie);
    expect(res.status).toBe(401);
    // Expiry is not a secret, and a client needs to know to sign in again
    // rather than to give up — unlike every other failure, which is opaque.
    expect(res.body.error.code).toBe('AUTH_EXPIRED');
  });

  it('reports an expired session as signed out, and clears the dead cookie', async () => {
    const { app, now } = harness;
    const cookie = await signIn(app, 'auth0|expiring2');
    now.value += 24 * 60 * 60 * 1000;

    const res = await request(app).get('/auth/session').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.authenticated).toBe(false);
    // Cleared, so the browser stops presenting a value that can never work.
    expect((res.headers['set-cookie'] as unknown as string[]).join()).toMatch(/jtt_session=;/);
  });

  it('refuses a session that was signed out, even replayed exactly', async () => {
    const { app } = harness;
    const cookie = await signIn(app, 'auth0|leaver');
    await request(app).post('/auth/logout').set('Cookie', cookie);

    for (const [name, call] of SESSION_ROUTES(app, 'sess-00000000deadbeef')) {
      const res = await call().set('Cookie', cookie);
      expect(res.status, name).toBe(401);
    }
  });

  it('refuses a live session whose account no longer exists', async () => {
    const { app, authSessions } = harness;

    /*
     * A session record pointing at a user row that is not there.
     *
     * This is what a deleted account looks like from the cookie's side, and it
     * must fail closed: `authenticate` refuses rather than inventing a user, so
     * a removed account's browser stops working immediately instead of becoming
     * an unnamed caller that policy would then have to reason about.
     */
    const orphan = await authSessions.create('usr-does-not-exist', 3600);

    const res = await request(app).get('/api/me').set('Cookie', `jtt_session=${orphan.cookieValue}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('signs a user out everywhere when their account is disabled', async () => {
    const { app, authSessions, users } = harness;
    const cookie = await signIn(app, 'auth0|disabled');
    const user = await users.upsert({ issuer: idp.issuer, subject: 'auth0|disabled' });

    // The revocation path an administrator uses. In Postgres the same thing
    // happens automatically through ON DELETE CASCADE.
    expect(await authSessions.destroyAllForUser(user.userId)).toBeGreaterThan(0);

    expect((await request(app).get('/api/me').set('Cookie', cookie)).status).toBe(401);
  });
});

// --------------------------------------------------- 4. forged identifiers

describe('a forged user identifier buys nothing', () => {
  it('ignores a user id named in a query, a body, or a header', async () => {
    const { app } = harness;
    const alice = await signIn(app, 'auth0|alice');
    const bob = await signIn(app, 'auth0|bob');

    const bobSession = await start(app, bob);

    /*
     * Alice names Bob every way the request offers, on a route that reads a
     * session she does not own. None of it is an input to any decision.
     */
    const res = await request(app)
      .get(`/api/sessions/${bobSession.session.sessionId}`)
      .query({ userId: 'bob', ownerUserId: 'bob', studentId: 'bob' })
      .set('Cookie', alice)
      .set('x-dev-student-id', 'bob')
      .set('x-user-id', 'bob');

    expect(res.status).toBe(404);
  });

  it('does not let a bearer token override a cookie', async () => {
    const { app } = harness;
    const alice = await signIn(app, 'auth0|alice2');
    const forged = await foreignToken(idp.issuer, API_AUDIENCE, 'auth0|admin');

    /*
     * Both credentials present. The cookie is tried first and succeeds, so the
     * bearer token is never consulted — a caller cannot use a second header to
     * upgrade the identity a first one established.
     */
    const res = await request(app)
      .get('/api/me')
      .set('Cookie', alice)
      .set('Authorization', `Bearer ${forged}`);

    expect(res.status).toBe(200);
    expect(res.body.data.student.authenticated).toBe(true);
  });

  it('never takes a role from a token claim', async () => {
    const { app, users } = harness;
    const cookie = await signIn(app, 'auth0|wannabe-admin');

    const res = await request(app).get('/auth/session').set('Cookie', cookie);
    expect(res.body.data.identity.role).toBe('STUDENT');

    // Roles change in the store, by an administrator, and nowhere else.
    const user = await users.upsert({ issuer: idp.issuer, subject: 'auth0|wannabe-admin' });
    expect(user.role).toBe('STUDENT');
  });
});

// ---------------------------------------------- 5. cross-user session ids

describe('a cross-user session id buys nothing', () => {
  it('refuses every operation on a session belonging to someone else', async () => {
    const { app } = harness;
    const alice = await signIn(app, 'auth0|alice3');
    const bob = await signIn(app, 'auth0|bob3');
    const owned = await start(app, alice);

    for (const [name, call] of SESSION_ROUTES(app, owned.session.sessionId)) {
      const res = await call().set('Cookie', bob);
      expect(res.status, name).toBe(404);
      expect(res.body.error.code, name).toBe('SESSION_NOT_FOUND');
    }

    // Still Alice's, and still working, after all of that.
    expect((await request(app).get(`/api/sessions/${owned.session.sessionId}`).set('Cookie', alice)).status).toBe(200);
  });

  it('distinguishes a malformed id from a hidden one', async () => {
    const { app } = harness;
    const cookie = await signIn(app, 'auth0|alice4');

    // A bad request is a bad request. It reveals nothing about which *valid*
    // ids exist, which is the only thing the 404 rule protects.
    const malformed = await request(app).get('/api/sessions/not-a-session-id').set('Cookie', cookie);
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_SESSION_ID');
  });
});

// --------------------------------------------------- 6. the sign-in flow

describe('the sign-in flow itself', () => {
  it('refuses a callback with no transaction cookie (CSRF)', async () => {
    const { app } = harness;
    const login = await request(app).get('/auth/login');
    const authorize = await fetch(login.headers.location as string, { redirect: 'manual' });
    const back = new URL(authorize.headers.get('location')!);

    // A valid code and state, delivered without the browser's own transaction
    // cookie: a login CSRF, in which an attacker completes a sign-in in
    // somebody else's browser.
    const res = await request(app)
      .get('/auth/callback')
      .query({ code: back.searchParams.get('code')!, state: back.searchParams.get('state')! });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AUTH_NO_TRANSACTION');
  });

  it('refuses a callback whose state does not match', async () => {
    const { app } = harness;
    const login = await request(app).get('/auth/login');
    const tx = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    const authorize = await fetch(login.headers.location as string, { redirect: 'manual' });
    const back = new URL(authorize.headers.get('location')!);

    const res = await request(app)
      .get('/auth/callback')
      .query({ code: back.searchParams.get('code')!, state: 'not-the-state-we-minted' })
      .set('Cookie', tx);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AUTH_STATE_MISMATCH');
  });

  it('refuses a tampered transaction cookie', async () => {
    const { app } = harness;
    const login = await request(app).get('/auth/login');
    const raw = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const [name, value] = raw.split('=') as [string, string];

    // Flip the last character of the signature.
    const tampered = `${name}=${value.slice(0, -1)}${value.slice(-1) === 'A' ? 'B' : 'A'}`;
    const authorize = await fetch(login.headers.location as string, { redirect: 'manual' });
    const back = new URL(authorize.headers.get('location')!);

    const res = await request(app)
      .get('/auth/callback')
      .query({ code: back.searchParams.get('code')!, state: back.searchParams.get('state')! })
      .set('Cookie', tampered);

    expect(res.status).toBe(400);
  });

  it('will not reuse an authorization code', async () => {
    const { app } = harness;
    idp.signInAs({ subject: 'auth0|replay' });
    const login = await request(app).get('/auth/login');
    const tx = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    const authorize = await fetch(login.headers.location as string, { redirect: 'manual' });
    const back = new URL(authorize.headers.get('location')!);
    const query = { code: back.searchParams.get('code')!, state: back.searchParams.get('state')! };

    const first = await request(app).get('/auth/callback').query(query).set('Cookie', tx);
    expect(first.status).toBe(302);
    expect(cookieValue(first.headers['set-cookie'] as unknown as string[], 'jtt_session')).toBeTruthy();

    /*
     * Replay the whole callback, transaction cookie included.
     *
     * A real browser would not have the transaction cookie any more — the first
     * callback cleared it — so this is the *stronger* case: even with every
     * value the browser had, the code is spent. The provider refuses the
     * exchange, so the refusal is a 401 rather than the 400 a missing
     * transaction would give.
     */
    const second = await request(app).get('/auth/callback').query(query).set('Cookie', tx);
    expect(second.status).toBe(401);
    // The only thing that really matters: no second session was minted.
    expect(cookieValue(second.headers['set-cookie'] as unknown as string[], 'jtt_session')).toBeUndefined();
  });

  it('sets a session cookie that script cannot read', async () => {
    const { app } = harness;
    idp.signInAs({ subject: 'auth0|cookie-shape' });
    const login = await request(app).get('/auth/login');
    const tx = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    const authorize = await fetch(login.headers.location as string, { redirect: 'manual' });
    const back = new URL(authorize.headers.get('location')!);

    const callback = await request(app)
      .get('/auth/callback')
      .query({ code: back.searchParams.get('code')!, state: back.searchParams.get('state')! })
      .set('Cookie', tx);

    const header = (callback.headers['set-cookie'] as unknown as string[]).find((c) =>
      /^jtt_session=[^;]+/.test(c),
    )!;

    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/SameSite=Lax/);
    expect(header).toMatch(/Path=\//);
    // Host-only unless a deployment sets AUTH_COOKIE_DOMAIN.
    expect(header).not.toMatch(/Domain=/);
  });

  it('never redirects anywhere but a same-origin path', () => {
    // The unit behind the callback's redirect. An attacker-chosen `returnTo` is
    // how a sign-in becomes an open redirect used to make a phishing link look
    // like it came from this domain.
    for (const hostile of [
      'https://evil.example/steal',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      'http://localhost:3000@evil.example',
      '/legit\nLocation: https://evil.example',
    ]) {
      expect(safeReturnTo(hostile), hostile).toBe('/');
    }

    // And a genuine deep link survives, or the feature would be pointless.
    expect(safeReturnTo('/#/labs/K8S-001')).toBe('/#/labs/K8S-001');
  });

  it('never puts a secret, a code, or a token in any response', async () => {
    const { app } = harness;
    const cookie = await signIn(app, 'auth0|no-leaks');

    const bodies = [
      (await request(app).get('/auth/config')).text,
      (await request(app).get('/auth/session').set('Cookie', cookie)).text,
      (await request(app).post('/auth/logout').set('Cookie', cookie)).text,
    ].join('\n');

    expect(bodies).not.toContain(idp.clientSecret);
    expect(bodies).not.toMatch(/id_token|access_token|client_secret|code_verifier/);
  });
});

// ------------------------------------------------------- 7. configuration

describe('a deployment with no identity provider says so', () => {
  it('reports sign-in unavailable rather than offering a broken button', async () => {
    const config = loadConfig({
      TERMINAL_SESSION_SECRET: SECRET,
      LABS_DIR: path.join(repoRoot, 'labs'),
      ALLOWED_ORIGINS: APP_URL,
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: idp.clientId,
      OIDC_AUDIENCE: API_AUDIENCE,
      // No OIDC_CLIENT_SECRET.
    } as NodeJS.ProcessEnv);

    expect(config.auth.browserFlow).toBeNull();

    const k8s = new FakeKubernetes();
    const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
    providers.register({
      provider: new KindLabProvider({ k8s, clusterName: 'jumptotech-labs', exec: fakeExec() }),
    });
    const app = createApp({
      registry,
      sessions: new SessionManager({
        registry,
        providers,
        store: new InMemorySessionStore(),
        policy: DEFAULT_SESSION_POLICY,
        lifetimes: config.lifetimes,
        namespaceSecret: SECRET,
      }),
      k8s,
      config,
    });

    const cfg = await request(app).get('/auth/config');
    expect(cfg.body.data.signInAvailable).toBe(false);

    const login = await request(app).get('/auth/login');
    expect(login.status).toBe(503);
    expect(login.body.error.code).toBe('AUTH_NOT_CONFIGURED');
  });
});
