/**
 * BETA-P0-014 — the sign-in flow, end to end, against a real in-process
 * provider, with the collaborators built exactly as production builds them
 * (`buildBrowserSignIn`).
 *
 * The public origin is `https://…`, so every cookie assertion below is about the
 * cookie a production browser receives.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
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
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildIdentityResolver } from '../src/auth/resolvers.js';
import { OidcTokenVerifier } from '../src/auth/oidc.js';
import { OidcBrowserClient } from '../src/auth/oidc-client.js';
import { buildBrowserSignIn } from '../src/auth/browser-sign-in.js';
import { InMemoryUserRepository } from '../src/auth/users.js';
import { InMemoryAuthSessionStore } from '../src/auth/browser-session.js';
import { deriveTransactionKey, openTransaction, sealTransaction } from '../src/auth/cookies.js';
import { AuthError } from '../src/auth/identity.js';
import { startFakeIdentityProvider, type FakeIdentityProvider, type IdTokenOverrides } from './oidc-identity.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TERMINAL_SECRET = 'oidc-flow-hardening-terminal-session-secret';
const APP_URL = 'https://labs.example.com';
const API_AUDIENCE = 'jumptotech-labs-api';
const JWT_SHAPE = /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/;

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
  sessions: SessionManager;
}

function buildApp(env: Record<string, string> = {}): Harness {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: TERMINAL_SECRET,
    INTERNAL_SERVICE_SECRET: TERMINAL_SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: APP_URL,
    PUBLIC_ORIGIN: APP_URL,
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: idp.issuer,
    OIDC_CLIENT_ID: idp.clientId,
    OIDC_CLIENT_SECRET: idp.clientSecret,
    OIDC_AUDIENCE: API_AUDIENCE,
    ...env,
  } as NodeJS.ProcessEnv);

  const authSessions = new InMemoryAuthSessionStore();
  const users = new InMemoryUserRepository('oidc');
  const k8s = new FakeKubernetes();
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new KindLabProvider({ k8s, clusterName: 'jumptotech-labs', exec: fakeExec() }) });
  providers.register({ provider: new LinuxLabProvider({ runtime: new FakeContainerRuntime() }) });
  const sessions = new SessionManager({
    registry,
    providers,
    store: new InMemorySessionStore(),
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: config.lifetimes,
    namespaceSecret: TERMINAL_SECRET,
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
    browserAuth: { users, authSessions, ...buildBrowserSignIn(config.auth) },
  });
  return { app, authSessions, sessions };
}

function setCookies(res: request.Response): string[] {
  return (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
}

function cookieHeader(res: request.Response, name: string): string | undefined {
  return setCookies(res).find((c) => c.startsWith(`${name}=`));
}

function cookieValue(res: request.Response, name: string): string | undefined {
  const value = cookieHeader(res, name)?.split(';')[0]!.slice(name.length + 1);
  return value ? value : undefined;
}

interface Flow {
  tx: string;
  code: string;
  state: string;
}

async function beginLogin(app: Express): Promise<Flow> {
  const login = await request(app).get('/auth/login');
  expect(login.status).toBe(302);
  const tx = setCookies(login).map((c) => c.split(';')[0]).join('; ');
  const authorize = await fetch(login.headers.location as string, { redirect: 'manual' });
  const back = new URL(authorize.headers.get('location')!);
  return { tx, code: back.searchParams.get('code')!, state: back.searchParams.get('state')! };
}

function callback(app: Express, flow: Flow, extraCookie?: string) {
  return request(app)
    .get('/auth/callback')
    .query({ code: flow.code, state: flow.state })
    .set('Cookie', [flow.tx, extraCookie].filter(Boolean).join('; '));
}

async function signIn(app: Express, subject: string, extraCookie?: string): Promise<string> {
  idp.signInAs({ subject, email: `${subject.replace(/\W/g, '')}@example.test` });
  const res = await callback(app, await beginLogin(app), extraCookie);
  expect(res.status, res.text).toBe(302);
  return `jtt_session=${cookieValue(res, 'jtt_session')!}`;
}

let harness: Harness;
beforeEach(() => {
  harness = buildApp();
});

// ------------------------------------------------------------ cookie security

describe('the browser session cookie', () => {
  it('is HttpOnly, Secure, SameSite=Lax, Path=/, host-only and bounded', async () => {
    idp.signInAs({ subject: 'p0014|cookie' });
    const res = await callback(harness.app, await beginLogin(harness.app));
    const header = cookieHeader(res, 'jtt_session')!;

    expect(header).toMatch(/; HttpOnly/);
    expect(header).toMatch(/; Secure/);
    expect(header).toMatch(/; SameSite=Lax/);
    expect(header).toMatch(/; Path=\/;/);
    expect(header).toMatch(/; Max-Age=43200;/);
    expect(header).not.toMatch(/Domain=/);
  });

  it('keeps the sign-in transaction cookie HttpOnly, Secure, short-lived and under /auth only', async () => {
    const login = await request(harness.app).get('/auth/login');
    const header = cookieHeader(login, 'jtt_session_tx')!;
    expect(header).toMatch(/; HttpOnly/);
    expect(header).toMatch(/; Secure/);
    expect(header).toMatch(/; SameSite=Lax/);
    expect(header).toMatch(/; Path=\/auth;/);
    expect(header).toMatch(/; Max-Age=600;/);
  });

  it('is an opaque random index: no claims, no JWT, and only its hash is stored', async () => {
    const cookie = await signIn(harness.app, 'p0014|opaque-subject');
    const value = cookie.slice('jtt_session='.length);

    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(value).not.toContain('opaque');
    expect(value).not.toMatch(JWT_SHAPE);

    const record = await harness.authSessions.resolve(value);
    expect(record).not.toBeNull();
    expect(record!.authSessionId).toBe(createHash('sha256').update(value).digest('hex'));
    expect(JSON.stringify(record)).not.toContain(value);
  });

  it('is answered with Cache-Control: no-store on every /auth route', async () => {
    const cookie = await signIn(harness.app, 'p0014|no-store');
    for (const res of [
      await request(harness.app).get('/auth/login'),
      await request(harness.app).get('/auth/session').set('Cookie', cookie),
      await request(harness.app).get('/auth/config'),
      await request(harness.app).get('/auth/callback'),
    ]) {
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });
});

// ------------------------------------------------------- tokens stay server-side

describe('provider tokens never reach the browser', () => {
  it('puts no token, code or secret in the callback redirect, its cookies, or any /auth body', async () => {
    idp.signInAs({ subject: 'p0014|no-tokens' });
    const flow = await beginLogin(harness.app);
    const res = await callback(harness.app, flow);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP_URL}/`);

    const cookie = `jtt_session=${cookieValue(res, 'jtt_session')!}`;
    const everything = [
      JSON.stringify(res.headers),
      res.text,
      (await request(harness.app).get('/auth/session').set('Cookie', cookie)).text,
      (await request(harness.app).get('/auth/config')).text,
      (await request(harness.app).post('/auth/logout').set('Cookie', cookie)).text,
    ].join('\n');

    expect(everything).not.toMatch(JWT_SHAPE);
    expect(everything).not.toContain('test-access-token');
    expect(everything).not.toContain(idp.clientSecret);
    expect(everything).not.toContain(flow.code);
    expect(everything).not.toMatch(/id_token|access_token|refresh_token/);
  });

  it('keeps the client secret out of the transaction cookie and the provider redirect', async () => {
    const login = await request(harness.app).get('/auth/login');
    expect(String(login.headers.location)).not.toContain(idp.clientSecret);
    expect(JSON.stringify(login.headers)).not.toContain(idp.clientSecret);
    const sealed = cookieValue(login, 'jtt_session_tx')!;
    expect(Buffer.from(sealed.split('.')[0]!, 'base64url').toString('utf8')).not.toContain(idp.clientSecret);
  });
});

// ----------------------------------------------------------- fixation / logout

describe('session fixation', () => {
  it('replaces, never reuses, a session the browser already had when sign-in completes', async () => {
    const first = await signIn(harness.app, 'p0014|shared-machine-previous-user');
    expect((await request(harness.app).get('/api/me').set('Cookie', first)).status).toBe(200);

    const second = await signIn(harness.app, 'p0014|shared-machine-next-user', first);
    expect(second).not.toBe(first);

    expect((await request(harness.app).get('/api/me').set('Cookie', first)).status).toBe(401);
    expect((await request(harness.app).get('/api/me').set('Cookie', second)).status).toBe(200);
    expect(await harness.authSessions.countActive()).toBe(1);
  });

  it('mints a fresh id even when the browser presents a planted value', async () => {
    const planted = 'jtt_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const issued = await signIn(harness.app, 'p0014|planted', planted);
    expect(issued).not.toBe(planted);
    expect((await request(harness.app).get('/api/me').set('Cookie', planted)).status).toBe(401);
  });

  it('does not sign anybody out on a callback that fails', async () => {
    const cookie = await signIn(harness.app, 'p0014|failed-callback');
    const flow = await beginLogin(harness.app);
    const res = await request(harness.app)
      .get('/auth/callback')
      .query({ code: flow.code, state: 'wrong' })
      .set('Cookie', `${flow.tx}; ${cookie}`);
    expect(res.status).toBe(400);
    expect((await request(harness.app).get('/api/me').set('Cookie', cookie)).status).toBe(200);
  });
});

describe('logout', () => {
  it('destroys the server-side session, so the same cookie is refused everywhere afterwards', async () => {
    const cookie = await signIn(harness.app, 'p0014|logout');
    expect((await request(harness.app).get('/api/me').set('Cookie', cookie)).status).toBe(200);

    const out = await request(harness.app).post('/auth/logout').set('Origin', APP_URL).set('Cookie', cookie);
    expect(out.status).toBe(200);
    expect(cookieHeader(out, 'jtt_session')).toMatch(/^jtt_session=; .*Max-Age=0/);

    // Replayed exactly, as a proxy log would have it.
    expect((await request(harness.app).get('/api/me').set('Cookie', cookie)).status).toBe(401);
    const session = await request(harness.app).get('/auth/session').set('Cookie', cookie);
    expect(session.body.data.authenticated).toBe(false);
    expect(await harness.authSessions.countActive()).toBe(0);
  });
});

// ------------------------------------------------------- state / PKCE / redirect

describe('state, PKCE and the return path', () => {
  async function expectNoSession(res: request.Response, status: number) {
    expect(res.status, res.text).toBe(status);
    expect(cookieValue(res, 'jtt_session')).toBeUndefined();
    expect(await harness.authSessions.countActive()).toBe(0);
  }

  it('rejects an invalid or missing state', async () => {
    const flow = await beginLogin(harness.app);
    await expectNoSession(await callback(harness.app, { ...flow, state: 'forged' }), 400);
    await expectNoSession(
      await request(harness.app).get('/auth/callback').query({ code: flow.code }).set('Cookie', flow.tx),
      400,
    );
  });

  it("rejects another sign-in's state, even a genuine one", async () => {
    const mine = await beginLogin(harness.app);
    const theirs = await beginLogin(harness.app);
    await expectNoSession(await callback(harness.app, { ...mine, state: theirs.state }), 400);
  });

  it("rejects an authorization code injected from another sign-in (PKCE binds it)", async () => {
    const mine = await beginLogin(harness.app);
    const theirs = await beginLogin(harness.app);
    // Their code, my state and transaction: the provider refuses my verifier.
    await expectNoSession(await callback(harness.app, { ...mine, code: theirs.code }), 401);
  });

  it('re-sanitises returnTo at the callback, and refuses a transaction signed with the terminal secret', async () => {
    idp.signInAs({ subject: 'p0014|return-to' });
    const flow = await beginLogin(harness.app);
    const sealed = flow.tx.split('=')[1]!;
    const key = deriveTransactionKey(idp.clientSecret);
    const transaction = openTransaction(sealed, key)!;
    expect(transaction).not.toBeNull();

    // A transaction cookie that could only exist if the signing key leaked.
    const hostile = sealTransaction({ ...transaction, returnTo: '@evil.example/steal' }, key);
    const res = await request(harness.app)
      .get('/auth/callback')
      .query({ code: flow.code, state: flow.state })
      .set('Cookie', `jtt_session_tx=${hostile}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP_URL}/`);

    // And the key is not TERMINAL_SESSION_SECRET, which the terminal also holds.
    const byTerminal = sealTransaction(transaction, TERMINAL_SECRET);
    const refused = await request(harness.app)
      .get('/auth/callback')
      .query({ code: flow.code, state: flow.state })
      .set('Cookie', `jtt_session_tx=${byTerminal}`);
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('AUTH_NO_TRANSACTION');
  });
});

// ------------------------------------------------------------ ID token checks

describe('the ID token is validated, not trusted', () => {
  const now = () => Math.floor(Date.now() / 1000);

  const cases: Array<[string, () => IdTokenOverrides]> = [
    ['a nonce from another sign-in', () => ({ nonce: 'not-the-nonce-we-sent' })],
    ['no nonce at all', () => ({ nonce: null })],
    ['an expired token', () => ({ issuedAt: now() - 7200, expiresAt: now() - 3600 })],
    ['a token with no exp', () => ({ expiresAt: null })],
    ['a token with no iat', () => ({ issuedAt: null })],
    ['a token for another client', () => ({ audience: 'somebody-elses-client' })],
    ['several audiences and no azp', () => ({ audience: [idp.clientId, 'another-api'] })],
    ['an azp naming another client', () => ({ azp: 'somebody-elses-client' })],
    ['another issuer', () => ({ issuer: 'https://evil.example' })],
    ['a signature from a key the issuer never published', () => ({ foreignKey: true })],
  ];

  for (const [name, overrides] of cases) {
    it(`refuses ${name}, and mints no session`, async () => {
      idp.signInAs({ subject: `p0014|${name}` });
      const flow = await beginLogin(harness.app);
      idp.nextIdToken(overrides());
      const res = await callback(harness.app, flow);
      expect(res.status, res.text).toBe(401);
      expect(cookieValue(res, 'jtt_session')).toBeUndefined();
      expect(await harness.authSessions.countActive()).toBe(0);
      expect(res.text).not.toMatch(JWT_SHAPE);
    });
  }

  it('accepts several audiences when azp names this client', async () => {
    idp.signInAs({ subject: 'p0014|azp-ok' });
    const flow = await beginLogin(harness.app);
    idp.nextIdToken({ audience: [idp.clientId, 'another-api'], azp: idp.clientId });
    expect((await callback(harness.app, flow)).status).toBe(302);
  });
});

describe('bearer tokens on the API are validated the same way', () => {
  const now = () => Math.floor(Date.now() / 1000);

  it('accepts a signed, unexpired token for this audience', async () => {
    const token = await idp.sign({ iss: idp.issuer, aud: API_AUDIENCE, sub: 'p0014|bearer', iat: now(), exp: now() + 300 });
    expect((await request(harness.app).get('/api/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
  });

  it('refuses a correctly signed token that never expires', async () => {
    const token = await idp.sign({ iss: idp.issuer, aud: API_AUDIENCE, sub: 'p0014|forever', iat: now() });
    const res = await request(harness.app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('refuses an expired token', async () => {
    const token = await idp.sign({ iss: idp.issuer, aud: API_AUDIENCE, sub: 'p0014|old', iat: now() - 7200, exp: now() - 3600 });
    const res = await request(harness.app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_EXPIRED');
  });

  it('refuses a symmetric (HS256) token, whatever secret signed it', async () => {
    const token = await new SignJWT({ sub: 'p0014|hs256' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(idp.issuer)
      .setAudience(API_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(idp.clientSecret));
    expect((await request(harness.app).get('/api/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });
});

// ----------------------------------------------------------------- discovery

describe('discovery is standards-based and binds the issuer', () => {
  function documentFetch(document: Record<string, unknown>): typeof fetch {
    return (async () => new Response(JSON.stringify(document), { status: 200 })) as typeof fetch;
  }

  it('refuses a discovery document naming a different issuer', async () => {
    const client = new OidcBrowserClient({
      issuer: 'https://issuer.example.com/',
      clientId: 'c',
      clientSecret: 's',
      redirectUri: `${APP_URL}/auth/callback`,
      scopes: ['openid'],
      fetchImpl: documentFetch({
        issuer: 'https://evil.example/',
        authorization_endpoint: 'https://evil.example/authorize',
        token_endpoint: 'https://evil.example/token',
      }),
    });
    await expect(client.authorizationRequest()).rejects.toMatchObject({ code: 'AUTH_MISCONFIGURED' });
  });

  it('refuses an https issuer that publishes a plain-http endpoint', async () => {
    const client = new OidcBrowserClient({
      issuer: 'https://issuer.example.com/',
      clientId: 'c',
      clientSecret: 's',
      redirectUri: `${APP_URL}/auth/callback`,
      scopes: ['openid'],
      fetchImpl: documentFetch({
        issuer: 'https://issuer.example.com/',
        authorization_endpoint: 'https://issuer.example.com/authorize',
        token_endpoint: 'http://issuer.example.com/token',
      }),
    });
    await expect(client.authorizationRequest()).rejects.toMatchObject({ code: 'AUTH_MISCONFIGURED' });
  });

  it('never follows a redirect with the client secret, and uses default TLS verification', async () => {
    const seen: RequestInit[] = [];
    const client = new OidcBrowserClient({
      issuer: 'https://issuer.example.com/',
      clientId: 'c',
      clientSecret: 'the-client-secret',
      redirectUri: `${APP_URL}/auth/callback`,
      scopes: ['openid'],
      metadata: {
        issuer: 'https://issuer.example.com/',
        authorizationEndpoint: 'https://issuer.example.com/authorize',
        tokenEndpoint: 'https://issuer.example.com/token',
      },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen.push(init);
        return new Response(JSON.stringify({ id_token: 'x.y.z' }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await client.exchangeCode('code', 'verifier');
    expect(seen[0]!.redirect).toBe('error');
    expect(Object.keys(seen[0]!)).not.toContain('dispatcher');
    expect(Object.keys(seen[0]!)).not.toContain('agent');
  });

  describe('the verifier finds keys through jwks_uri, not a path convention', () => {
    let server: Server;
    let issuer = '';
    let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
    let publishedIssuer = '';

    beforeAll(async () => {
      const pair = await generateKeyPair('ES256');
      privateKey = pair.privateKey;
      const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' };
      server = createServer((req, res) => {
        if (req.url === '/.well-known/openid-configuration') {
          res.writeHead(200, { 'content-type': 'application/json' });
          // Keys at a non-conventional path: only a verifier that reads
          // discovery can find them.
          res.end(JSON.stringify({ issuer: publishedIssuer, jwks_uri: `${issuer}/protocol/keys` }));
          return;
        }
        if (req.url === '/protocol/keys') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ keys: [jwk] }));
          return;
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      publishedIssuer = issuer;
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const token = () =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
        .setIssuer(issuer)
        .setAudience('aud')
        .setSubject('p0014|discovered')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);

    it('verifies with keys found through discovery', async () => {
      publishedIssuer = issuer;
      const verifier = new OidcTokenVerifier({ issuer, audience: 'aud' });
      await expect(verifier.verify(await token())).resolves.toMatchObject({ subject: 'p0014|discovered' });
    });

    it('refuses to use keys from a document that names another issuer', async () => {
      publishedIssuer = 'https://evil.example';
      const verifier = new OidcTokenVerifier({ issuer, audience: 'aud' });
      const error = await verifier.verify(await token()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe('AUTH_MISCONFIGURED');
      publishedIssuer = issuer;
    });
  });
});

// ------------------------------------------------------------------ CSRF

describe('state-changing requests must come from an allowed origin', () => {
  it('refuses a cross-origin logout, and the session survives it', async () => {
    const cookie = await signIn(harness.app, 'p0014|csrf-logout');
    const res = await request(harness.app).post('/auth/logout').set('Origin', 'https://evil.example').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect((await request(harness.app).get('/api/me').set('Cookie', cookie)).status).toBe(200);
  });

  it('refuses a same-site sibling origin starting a lab with the victim cookie', async () => {
    const cookie = await signIn(harness.app, 'p0014|csrf-start');
    for (const origin of ['https://student-pages.example.com', 'null', 'http://labs.example.com']) {
      const res = await request(harness.app).post('/api/labs/LINUX-001/start').set('Origin', origin).set('Cookie', cookie);
      expect(res.status, origin).toBe(403);
    }
    expect(await harness.sessions.activeCount()).toBe(0);
  });

  it('refuses cross-site and same-site fetches that carry no Origin', async () => {
    const cookie = await signIn(harness.app, 'p0014|csrf-fetch-site');
    for (const site of ['cross-site', 'same-site']) {
      const res = await request(harness.app).post('/auth/logout').set('Sec-Fetch-Site', site).set('Cookie', cookie);
      expect(res.status, site).toBe(403);
    }
    expect((await request(harness.app).get('/api/me').set('Cookie', cookie)).status).toBe(200);
  });

  it('allows the application origin, a same-origin fetch, and non-browser callers', async () => {
    const cookie = await signIn(harness.app, 'p0014|csrf-allowed');
    const started = await request(harness.app).post('/api/labs/LINUX-001/start').set('Origin', APP_URL).set('Cookie', cookie);
    expect(started.status, started.text).toBe(200);

    const sameOrigin = await request(harness.app).post('/auth/logout').set('Sec-Fetch-Site', 'same-origin').set('Cookie', cookie);
    expect(sameOrigin.status).toBe(200);
  });

  it('leaves safe methods alone: a foreign GET changes nothing and CORS still hides the answer', async () => {
    const cookie = await signIn(harness.app, 'p0014|csrf-get');
    const res = await request(harness.app).get('/api/me').set('Origin', 'https://evil.example').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('trusts PUBLIC_ORIGIN even when ALLOWED_ORIGINS forgot to repeat it (development only)', async () => {
    const dev = buildApp({ ALLOWED_ORIGINS: 'http://localhost:3000' });
    const res = await request(dev.app).post('/auth/logout').set('Origin', APP_URL);
    expect(res.status).toBe(200);
  });
});
