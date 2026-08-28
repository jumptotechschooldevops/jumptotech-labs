/**
 * PLATFORM-010 — two students sign in for real, and cannot reach each other.
 *
 * `authorization.test.ts` already proves cross-user isolation under
 * `AUTH_MODE=development`. This proves it under the mode the platform actually
 * defaults to, through the whole loop the browser uses:
 *
 * ```text
 *   GET /auth/login  →  provider  →  GET /auth/callback  →  Set-Cookie
 *        └─────────────── that cookie, and nothing else ───────────────┐
 *                                                                      ▼
 *   POST /api/labs/:id/start   read   check   reset   activity   end   terminal
 * ```
 *
 * The identity provider is real (see `oidc-identity.ts`): a loopback HTTP
 * server publishing discovery and JWKS, checking the client secret and the PKCE
 * verifier, and signing an RS256 ID token the API verifies over the network. No
 * verifier is stubbed, because verification is the property under test.
 *
 * Every assertion below hands User B a genuine, live, correct identifier
 * belonging to User A and proves it buys nothing.
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
  verifySessionToken,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes, fakeExec } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildIdentityResolver } from '../src/auth/resolvers.js';
import { OidcTokenVerifier } from '../src/auth/oidc.js';
import { OidcBrowserClient } from '../src/auth/oidc-client.js';
import { InMemoryUserRepository } from '../src/auth/users.js';
import { InMemoryAuthSessionStore } from '../src/auth/browser-session.js';
import { startFakeIdentityProvider, type FakeIdentityProvider } from './oidc-identity.js';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'oidc-e2e-terminal-session-secret';
const APP_URL = 'http://localhost:3000';

let idp: FakeIdentityProvider;
let registry: LabRegistry;

beforeAll(async () => {
  idp = await startFakeIdentityProvider();
  registry = await realCatalog();
  expect(registry.loadErrors).toEqual([]);
});

afterAll(async () => {
  await idp.close();
});

interface Harness {
  app: Express;
  sessions: SessionManager;
  users: InMemoryUserRepository;
}

/** An API composed exactly as `index.ts` composes it, in OIDC mode. */
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
    OIDC_AUDIENCE: 'jumptotech-labs-api',
  } as NodeJS.ProcessEnv);

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

  const client = new OidcBrowserClient({
    issuer: idp.issuer,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    redirectUri: config.auth.browserFlow!.redirectUri,
    scopes: config.auth.browserFlow!.scopes,
  });

  const app = createApp({
    registry,
    sessions,
    k8s,
    config,
    identityResolver: buildIdentityResolver({
      config: { mode: 'oidc', nodeEnv: 'test' },
      users,
      verifier: new OidcTokenVerifier({ issuer: idp.issuer, audience: 'jumptotech-labs-api' }),
    }),
    browserAuth: {
      users,
      authSessions: new InMemoryAuthSessionStore(),
      client,
      // An ID token is audienced to the client id, not to the API audience.
      idTokenVerifier: new OidcTokenVerifier({ issuer: idp.issuer, audience: idp.clientId }),
    },
  });

  return { app, sessions, users };
}

/** Pull one cookie's value out of a `Set-Cookie` header list. */
function cookieValue(setCookie: string[] | undefined, name: string): string | undefined {
  for (const header of setCookie ?? []) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(header);
    // An empty value is a deletion, not a session.
    if (match && match[1]) return match[1];
  }
  return undefined;
}

/**
 * Drive the complete browser sign-in and return the session cookie.
 *
 * Every hop is the real one: the API's redirect, the provider's `/authorize`,
 * the API's `/auth/callback`, the server-to-server token exchange, and JWKS
 * verification. What comes back is exactly what a browser would hold.
 */
async function signIn(app: Express, subject: string, name: string): Promise<string> {
  idp.signInAs({ subject, email: `${name}@example.test`, name });

  const login = await request(app).get('/auth/login').query({ returnTo: '/' });
  expect(login.status, JSON.stringify(login.body)).toBe(302);

  const txCookie = (login.headers['set-cookie'] as unknown as string[])
    .map((c) => c.split(';')[0])
    .join('; ');

  // Follow the provider redirect ourselves — supertest speaks only to the API.
  const authorize = await fetch(login.headers.location as string, { redirect: 'manual' });
  expect(authorize.status).toBe(302);
  const back = new URL(authorize.headers.get('location')!);

  const callback = await request(app)
    .get('/auth/callback')
    .query({ code: back.searchParams.get('code')!, state: back.searchParams.get('state')! })
    .set('Cookie', txCookie);

  expect(callback.status, JSON.stringify(callback.body)).toBe(302);
  const session = cookieValue(callback.headers['set-cookie'] as unknown as string[], 'jtt_session');
  expect(session, 'callback did not set a session cookie').toBeTruthy();
  return `jtt_session=${session!}`;
}

/** Start a lab as a signed-in browser. */
async function start(app: Express, cookie: string, labId = 'LINUX-001') {
  const res = await request(app).post(`/api/labs/${labId}/start`).set('Cookie', cookie);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as {
    session: { sessionId: string; sandboxRef: string; namespace: string };
    terminal: { token: string };
  };
}

let app: Express;
let alice: string;
let bob: string;

beforeEach(async () => {
  ({ app } = buildApp());
  alice = await signIn(app, 'auth0|alice', 'alice');
  bob = await signIn(app, 'auth0|bob', 'bob');
  // Two distinct sign-ins, not one reused — the cookies must differ or every
  // assertion below would be vacuous.
  expect(alice).not.toBe(bob);
});

// ------------------------------------------------------ the flow itself

describe('a browser can sign in, be recognised, and sign out', () => {
  it('reports nobody before sign-in, and does not make that an error', async () => {
    const { app: fresh } = buildApp();
    const res = await request(fresh).get('/auth/session');

    // 200, not 401. "Signed out" is a successful answer to "who am I", and a
    // 401 here would be indistinguishable from a real authorization failure.
    expect(res.status).toBe(200);
    expect(res.body.data.authenticated).toBe(false);
    expect(res.body.data.signInAvailable).toBe(true);
    expect(res.body.data.identity).toBeUndefined();
  });

  it('recognises a signed-in browser from its cookie alone', async () => {
    const res = await request(app).get('/auth/session').set('Cookie', alice);

    expect(res.status).toBe(200);
    expect(res.body.data.authenticated).toBe(true);
    expect(res.body.data.identity).toMatchObject({
      subject: 'auth0|alice',
      issuer: idp.issuer,
      email: 'alice@example.test',
      role: 'STUDENT',
      source: 'oidc',
    });
  });

  it('never puts the internal user id in anything the browser receives', async () => {
    /*
     * The surrogate key is what ownership is decided with server-side.
     * Publishing it would create exactly the thing this design avoids: an
     * identifier a client holds and could be tempted to send back.
     */
    const session = await request(app).get('/auth/session').set('Cookie', alice);
    const me = await request(app).get('/api/me').set('Cookie', alice);
    const started = await start(app, alice);

    for (const body of [session.body, me.body, started]) {
      expect(JSON.stringify(body)).not.toMatch(/"userId"/);
      expect(JSON.stringify(body)).not.toMatch(/ownerUserId/);
    }
  });

  it('signs out server-side, so the cookie stops working immediately', async () => {
    expect((await request(app).get('/auth/session').set('Cookie', alice)).body.data.authenticated).toBe(true);

    const out = await request(app).post('/auth/logout').set('Cookie', alice);
    expect(out.status).toBe(200);
    expect(out.body.data.signedOut).toBe(true);
    // The provider publishes an end-session endpoint, so the API offers it.
    expect(out.body.data.endSessionUrl).toContain('/end-session');

    // The same cookie value, replayed. The record is gone, so it is worthless —
    // this is why sign-out destroys the record rather than only clearing the
    // cookie, which a proxy log would have preserved anyway.
    const after = await request(app).get('/auth/session').set('Cookie', alice);
    expect(after.body.data.authenticated).toBe(false);

    const blocked = await request(app).post('/api/labs/LINUX-001/start').set('Cookie', alice);
    expect(blocked.status).toBe(401);
  });
});

// -------------------------------------------------- A can act on A only

describe('two signed-in students each own exactly one session', () => {
  it('gives each student their own sandbox', async () => {
    const a = await start(app, alice);
    const b = await start(app, bob);

    expect(a.session.sessionId).not.toBe(b.session.sessionId);
    expect(a.session.sandboxRef).not.toBe(b.session.sandboxRef);

    // Each can read their own.
    expect((await request(app).get(`/api/sessions/${a.session.sessionId}`).set('Cookie', alice)).status).toBe(200);
    expect((await request(app).get(`/api/sessions/${b.session.sessionId}`).set('Cookie', bob)).status).toBe(200);
  });

  it('lets each student run every operation on their own session', async () => {
    const a = await start(app, alice);
    const id = a.session.sessionId;

    expect((await request(app).get(`/api/sessions/${id}`).set('Cookie', alice)).status).toBe(200);
    expect((await request(app).post(`/api/sessions/${id}/activity`).set('Cookie', alice)).status).toBe(200);
    expect((await request(app).post(`/api/sessions/${id}/check`).set('Cookie', alice)).status).toBe(200);
    expect((await request(app).post(`/api/sessions/${id}/reset`).set('Cookie', alice)).status).toBe(200);
    // Ending is last: it is the one that takes the session away.
    expect((await request(app).delete(`/api/sessions/${id}`).set('Cookie', alice)).status).toBe(200);
  });
});

// ---------------------------------------------- A cannot act on B, ever

describe('one signed-in student cannot reach another’s session', () => {
  it('denies every session operation across users', async () => {
    const a = await start(app, alice);
    const b = await start(app, bob);

    /*
     * Bob holds Alice's real session id. Every operation the API offers is
     * tried with it, and every one must answer 404 — not 403, which would
     * confirm the id is real and turn guessing into enumeration.
     */
    const operations: Array<[string, () => request.Test]> = [
      ['read', () => request(app).get(`/api/sessions/${a.session.sessionId}`)],
      ['check', () => request(app).post(`/api/sessions/${a.session.sessionId}/check`)],
      ['reset', () => request(app).post(`/api/sessions/${a.session.sessionId}/reset`)],
      ['activity', () => request(app).post(`/api/sessions/${a.session.sessionId}/activity`)],
      ['hint', () => request(app).post(`/api/sessions/${a.session.sessionId}/hints`).send({ level: 1 })],
      ['end', () => request(app).delete(`/api/sessions/${a.session.sessionId}`)],
    ];

    for (const [name, call] of operations) {
      const res = await call().set('Cookie', bob);
      expect(res.status, `${name} should be refused for a non-owner`).toBe(404);
      expect(res.body.error.code, name).toBe('SESSION_NOT_FOUND');
    }

    // And symmetrically, so the result is not an artefact of who went first.
    for (const [name, path] of [
      ['read', `/api/sessions/${b.session.sessionId}`],
      ['activity', `/api/sessions/${b.session.sessionId}/activity`],
    ] as const) {
      const res =
        name === 'read'
          ? await request(app).get(path).set('Cookie', alice)
          : await request(app).post(path).set('Cookie', alice);
      expect(res.status, `alice → bob ${name}`).toBe(404);
    }

    // Alice's session is untouched by everything Bob just tried.
    expect((await request(app).get(`/api/sessions/${a.session.sessionId}`).set('Cookie', alice)).status).toBe(200);
  });

  it('answers "not yours" and "does not exist" identically', async () => {
    const a = await start(app, alice);

    const notOwned = await request(app).get(`/api/sessions/${a.session.sessionId}`).set('Cookie', bob);
    const notReal = await request(app).get('/api/sessions/sess-00000000deadbeef').set('Cookie', bob);

    expect(notOwned.status).toBe(notReal.status);
    expect(notOwned.body.error.code).toBe(notReal.body.error.code);
    expect(notOwned.body.error.message).toBe(notReal.body.error.message);
  });

  it('does not let one student’s check decide another’s result', async () => {
    const a = await start(app, alice);
    const b = await start(app, bob);

    const stolen = await request(app).post(`/api/sessions/${a.session.sessionId}/check`).set('Cookie', bob);
    expect(stolen.status).toBe(404);

    // Bob's own check still works and reports on Bob's own environment.
    const own = await request(app).post(`/api/sessions/${b.session.sessionId}/check`).set('Cookie', bob);
    expect(own.status).toBe(200);
    expect(own.body.data.session.sessionId).toBe(b.session.sessionId);
  });

  it('keeps learning history separate too', async () => {
    await start(app, alice);

    const aliceMe = await request(app).get('/api/me/attempts').set('Cookie', alice);
    const bobMe = await request(app).get('/api/me/attempts').set('Cookie', bob);

    expect(aliceMe.body.data.attempts).toHaveLength(1);
    expect(bobMe.body.data.attempts).toEqual([]);
    expect(aliceMe.body.data.student.authenticated).toBe(true);
    expect(aliceMe.body.data.student.studentId).not.toBe(bobMe.body.data.student.studentId);
  });
});

// ------------------------------------------------------ ownership origin

describe('ownership is assigned from the verified identity', () => {
  it('ignores any attempt to name an owner in the request', async () => {
    const res = await request(app)
      .post('/api/labs/LINUX-001/start')
      .set('Cookie', alice)
      .query({ ownerUserId: 'somebody-else', studentId: 'somebody-else' })
      .send({ ownerUserId: 'somebody-else', owner: 'somebody-else' });
    expect(res.status).toBe(200);

    // Bob still cannot reach it, whatever the request said.
    const id = res.body.data.session.sessionId as string;
    expect((await request(app).get(`/api/sessions/${id}`).set('Cookie', bob)).status).toBe(404);
    expect((await request(app).get(`/api/sessions/${id}`).set('Cookie', alice)).status).toBe(200);
  });

  it('binds the terminal token to the owner the server decided on', async () => {
    const a = await start(app, alice);
    const claims = verifySessionToken(a.terminal.token, SECRET);

    expect(claims.sid).toBe(a.session.sessionId);
    // The claim is the internal user id — the same value ownership is stored
    // in — so the terminal path and the HTTP path agree on who the owner is.
    expect(claims.uid).toBeTruthy();

    const b = await start(app, bob);
    expect(verifySessionToken(b.terminal.token, SECRET).uid).not.toBe(claims.uid);
  });
});
