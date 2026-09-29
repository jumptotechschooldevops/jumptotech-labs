/**
 * A terminal token is bound to the browser sign-in that requested it.
 *
 * Before this, a terminal token carried the session and its owner and nothing
 * about the sign-in: `POST /auth/logout` deleted the browser's session record
 * and the token went on opening shells for the rest of its hour (measured on
 * 74ea285: credentials 200 and activity 200 after sign-out, TTL 3600 s). The
 * token now names the sign-in (`asid`, its stored hash) and the internal
 * credential and activity routes refuse it once that sign-in is gone —
 * signed out, signed out everywhere by an operator, or expired.
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
import { InMemoryAuthSessionStore, hashAuthSessionId } from '../src/auth/browser-session.js';
import { startFakeIdentityProvider, type FakeIdentityProvider } from './oidc-identity.js';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'terminal-sign-in-binding-secret';
const APP_URL = 'http://localhost:3000';
const API_AUDIENCE = 'jumptotech-labs-api';

let idp: FakeIdentityProvider;
let registry: LabRegistry;

beforeAll(async () => {
  idp = await startFakeIdentityProvider();
  registry = await realCatalog();
});

afterAll(async () => {
  await idp.close();
});

interface Harness {
  app: Express;
  authSessions: InMemoryAuthSessionStore;
  users: InMemoryUserRepository;
  sessions: SessionManager;
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

  return { app, authSessions, users, sessions, now };
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


const cookieOf = (cookie: string) => cookie.slice('jtt_session='.length);

function internal(app: Express, route: 'credentials' | 'activity', sid: string, body: Record<string, unknown>) {
  return request(app).post(`/internal/sessions/${sid}/${route}`).set('x-internal-secret', SECRET).send(body);
}

/** What the terminal service forwards: the verified token's claims, nothing else. */
function forwarded(token: string): Record<string, unknown> {
  const claims = verifySessionToken(token, SECRET);
  return { ownerUserId: claims.uid, ...(claims.asid !== undefined ? { authSession: claims.asid } : {}) };
}

let harness: Harness;
beforeEach(() => {
  harness = buildApp();
});

describe('the token names the sign-in that asked for it', () => {
  it('binds Start’s and a re-issued token to the stored id of the browser’s sign-in, never the cookie', async () => {
    const { app } = harness;
    const alice = await signIn(app, 'auth0|alice');
    const started = await start(app, alice);
    const claims = verifySessionToken(started.terminal.token, SECRET);
    expect(claims.asid).toBe(hashAuthSessionId(cookieOf(alice)));
    expect(started.terminal.token).not.toContain(cookieOf(alice));

    const again = await request(app).post(`/api/sessions/${started.session.sessionId}/terminal`).set('Cookie', alice);
    expect(again.status).toBe(200);
    expect(verifySessionToken(again.body.data.terminal.token, SECRET).asid).toBe(claims.asid);
  });

  it('leaves a bearer caller’s token unbound, since it has no sign-in to end', async () => {
    const { app } = harness;
    const now = Math.floor(Date.now() / 1000);
    const bearer = await idp.sign({ iss: idp.issuer, aud: API_AUDIENCE, sub: 'svc|bearer', iat: now, exp: now + 300 });
    const res = await request(app).post('/api/labs/LINUX-001/start').set('Authorization', `Bearer ${bearer}`);
    expect(res.status, res.text).toBe(200);
    expect(verifySessionToken(res.body.data.terminal.token, SECRET).asid).toBeUndefined();
    expect((await internal(app, 'credentials', res.body.data.session.sessionId, forwarded(res.body.data.terminal.token))).status).toBe(200);
  });
});

describe('signing out ends the token', () => {
  it('refuses credentials and activity for a token whose browser signed out, and keeps the lab', async () => {
    const { app } = harness;
    const alice = await signIn(app, 'auth0|alice');
    const started = await start(app, alice);
    const sid = started.session.sessionId;
    const claims = forwarded(started.terminal.token);

    expect((await internal(app, 'credentials', sid, claims)).status).toBe(200);
    expect((await internal(app, 'activity', sid, claims)).status).toBe(200);

    expect((await request(app).post('/auth/logout').set('Cookie', alice)).status).toBe(200);

    for (const route of ['credentials', 'activity'] as const) {
      const refused = await internal(app, route, sid, claims);
      expect(refused.status, route).toBe(401);
      expect(refused.body.error.code).toBe('AUTH_SESSION_ENDED');
      expect(JSON.stringify(refused.body)).not.toMatch(/kubeconfig|containerRef/);
    }
    // No fresh token either, and the lab is untouched: signing out is not End.
    expect((await request(app).post(`/api/sessions/${sid}/terminal`).set('Cookie', alice)).status).toBe(401);
    expect((await harness.sessions.get(sid))?.status).toBe('ACTIVE');

    // Signed in again, the same student gets a working token for the same lab.
    const back = await signIn(app, 'auth0|alice');
    const fresh = await request(app).post(`/api/sessions/${sid}/terminal`).set('Cookie', back);
    expect(fresh.status).toBe(200);
    expect((await internal(app, 'credentials', sid, forwarded(fresh.body.data.terminal.token))).status).toBe(200);
    // The old token stays dead.
    expect((await internal(app, 'credentials', sid, claims)).status).toBe(401);
  });

  it('ends every token when an operator signs the account out everywhere, and only that account’s', async () => {
    const { app, users, authSessions } = harness;
    const laptop = await signIn(app, 'auth0|alice');
    const bob = await signIn(app, 'auth0|bob');
    const a = await start(app, laptop);
    const b = await start(app, bob);
    const alice = (await users.search('alice', 1))[0]!;

    await authSessions.destroyAllForUser(alice.userId);

    expect((await internal(app, 'credentials', a.session.sessionId, forwarded(a.terminal.token))).status).toBe(401);
    expect((await internal(app, 'credentials', b.session.sessionId, forwarded(b.terminal.token))).status).toBe(200);
  });

  it('only ends the tokens of the browser that signed out', async () => {
    const { app } = harness;
    const laptop = await signIn(app, 'auth0|alice');
    const phone = await signIn(app, 'auth0|alice');
    const started = await start(app, laptop);
    const sid = started.session.sessionId;
    const fromPhone = await request(app).post(`/api/sessions/${sid}/terminal`).set('Cookie', phone);

    await request(app).post('/auth/logout').set('Cookie', laptop);

    expect((await internal(app, 'credentials', sid, forwarded(started.terminal.token))).status).toBe(401);
    expect((await internal(app, 'credentials', sid, forwarded(fromPhone.body.data.terminal.token))).status).toBe(200);
  });

  it('ends the token when its sign-in expires, even inside the token’s own lifetime', async () => {
    const { app, now } = harness;
    const alice = await signIn(app, 'auth0|alice');
    const started = await start(app, alice);
    now.value += 13 * 60 * 60 * 1000; // past the 12 h sign-in; the token's own exp is checked by the terminal
    const refused = await internal(app, 'credentials', started.session.sessionId, forwarded(started.terminal.token));
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe('AUTH_SESSION_ENDED');
  });

  it('refuses a claimed sign-in that is somebody else’s, unknown, or not a string', async () => {
    const { app } = harness;
    const alice = await signIn(app, 'auth0|alice');
    const bob = await signIn(app, 'auth0|bob');
    const started = await start(app, alice);
    const sid = started.session.sessionId;
    const { ownerUserId } = forwarded(started.terminal.token);

    for (const authSession of [hashAuthSessionId(cookieOf(bob)), 'f'.repeat(64), 'not-an-id', 42, null]) {
      const res = await internal(app, 'credentials', sid, { ownerUserId, authSession });
      expect(res.status, String(authSession)).toBe(401);
      expect(res.body.error.code).toBe('AUTH_SESSION_ENDED');
    }
  });
});
