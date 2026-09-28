/**
 * The identity provider is down — reliability audit 2026-09-28.
 *
 * An outage on the provider's side was reported as this deployment's mistake:
 * every unreachable, timed-out or 5xx provider call became AUTH_MISCONFIGURED,
 * so the student read "no identity provider configured"-class errors and the
 * operator went looking at `.env`. It was also counted nowhere — `/auth/login`
 * recorded no outcome, and with discovery failing no callback ever happened —
 * so no alert could fire while nobody could sign in.
 *
 * What must hold, and does:
 *   - a student already signed in is not affected (browser sessions live in the
 *     session store and are never checked against the provider);
 *   - a new sign-in is refused as AUTH_PROVIDER_UNAVAILABLE, 503 + Retry-After,
 *     and counted as `provider_unavailable` — whether the api learnt of the
 *     outage at discovery (restarted during it) or at the token endpoint
 *     (running since before it, with discovery cached);
 *   - a provider that answers but is wrong stays AUTH_MISCONFIGURED.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import {
  createAuthMetrics,
  createCommonMetrics,
  createLogger,
  createRegistry,
  createSessionMetrics,
  createVerificationMetrics,
} from '@jumptotech/observability';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildIdentityResolver } from '../src/auth/resolvers.js';
import { OidcTokenVerifier } from '../src/auth/oidc.js';
import { buildBrowserSignIn } from '../src/auth/browser-sign-in.js';
import { fetchDiscoveryDocument } from '../src/auth/discovery.js';
import { InMemoryUserRepository } from '../src/auth/users.js';
import { InMemoryAuthSessionStore } from '../src/auth/browser-session.js';
import { startFakeIdentityProvider, type FakeIdentityProvider } from './oidc-identity.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'identity-provider-outage-terminal-secret';
const APP_URL = 'https://labs.example.com';
const AUDIENCE = 'jumptotech-labs-api';

const providers: FakeIdentityProvider[] = [];
afterEach(async () => {
  await Promise.all(providers.splice(0).map((p) => p.close().catch(() => undefined)));
});

async function provider(): Promise<FakeIdentityProvider> {
  const idp = await startFakeIdentityProvider();
  providers.push(idp);
  return idp;
}

/** One api process, configured for `idp`, with a registry the test can read. */
async function api(idp: FakeIdentityProvider, authSessions = new InMemoryAuthSessionStore()) {
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
    OIDC_AUDIENCE: AUDIENCE,
  } as NodeJS.ProcessEnv);
  const users = new InMemoryUserRepository('oidc');
  const registry = createRegistry({ service: 'api', defaultMetrics: false });
  const lines: string[] = [];
  const labs = new ProviderRegistry({ availabilityTtlMs: 0 });
  labs.register({ provider: new LinuxLabProvider({ runtime: new FakeContainerRuntime() }) });
  const app = createApp({
    registry: await realCatalog(),
    sessions: new SessionManager({
      registry: await realCatalog(),
      providers: labs,
      store: new InMemorySessionStore(),
      policy: DEFAULT_SESSION_POLICY,
      lifetimes: config.lifetimes,
      namespaceSecret: SECRET,
    }),
    k8s: new FakeKubernetes(),
    config,
    identityResolver: buildIdentityResolver({
      config: { mode: 'oidc', nodeEnv: 'test' },
      users,
      verifier: new OidcTokenVerifier({ issuer: idp.issuer, audience: AUDIENCE }),
    }),
    browserAuth: { users, authSessions, ...buildBrowserSignIn(config.auth) },
    observability: {
      logger: createLogger({ service: 'api', level: 'debug', sink: (line) => lines.push(line) }),
      metrics: {
        common: createCommonMetrics(registry, 'api'),
        sessions: createSessionMetrics(registry),
        verification: createVerificationMetrics(registry),
        auth: createAuthMetrics(registry),
      },
    },
  });
  const count = async (name: string, outcome: string): Promise<number> => {
    const metric = (await registry.getMetricsAsJSON()).find((m) => m.name === name);
    return (metric?.values ?? []).find((v) => v.labels.outcome === outcome)?.value ?? 0;
  };
  return { app, authSessions, count, lines };
}

function cookies(res: request.Response): string {
  return ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? []).map((c) => c.split(';')[0]).join('; ');
}

/** GET /auth/login, then the provider's (auto-approving) authorize step. */
async function beginLogin(app: Express) {
  const login = await request(app).get('/auth/login');
  expect(login.status, login.text).toBe(302);
  const authorize = await fetch(login.headers.location as string, { redirect: 'manual' });
  const back = new URL(authorize.headers.get('location')!);
  return { tx: cookies(login), code: back.searchParams.get('code')!, state: back.searchParams.get('state')! };
}

function finishLogin(app: Express, flow: Awaited<ReturnType<typeof beginLogin>>) {
  return request(app).get('/auth/callback').query({ code: flow.code, state: flow.state }).set('Cookie', flow.tx);
}

describe('the identity provider is down', () => {
  it('a student already signed in stays signed in', async () => {
    const idp = await provider();
    const { app } = await api(idp);
    idp.signInAs({ subject: 'student-a', email: 'a@example.test' });
    const signedIn = await finishLogin(app, await beginLogin(app));
    expect(signedIn.status, signedIn.text).toBe(302);
    const session = cookies(signedIn).split('; ').find((c) => c.startsWith('jtt_session='))!;

    await idp.close();

    const check = await request(app).get('/auth/session').set('Cookie', session);
    expect(check.status).toBe(200);
    expect(check.body.data).toMatchObject({ authenticated: true });
  });

  it('an api restarted during the outage refuses new sign-ins as provider-unavailable, and counts them', async () => {
    const idp = await provider();
    await idp.close();
    const { app, count, lines } = await api(idp);

    const login = await request(app).get('/auth/login');
    expect(login.status).toBe(503);
    expect(login.headers['retry-after']).toBe('60');
    expect(login.body.error).toMatchObject({
      code: 'AUTH_PROVIDER_UNAVAILABLE',
      remediation: expect.stringMatching(/already signed in, you are not affected/),
    });
    expect(await count('jtt_auth_login_total', 'provider_unavailable')).toBe(1);
    expect(await count('jtt_auth_login_total', 'misconfigured')).toBe(0);
    // And the operator can read why, which the router's unwired logger never let them.
    expect(lines.some((l) => l.includes('auth.login.unavailable') && l.includes('AUTH_PROVIDER_UNAVAILABLE'))).toBe(true);
  });

  it('an api running since before the outage fails at the token endpoint, as provider-unavailable', async () => {
    const idp = await provider();
    const { app, count } = await api(idp);
    idp.signInAs({ subject: 'student-b', email: 'b@example.test' });
    // Discovery is cached from here on; the redirect still works.
    const flow = await beginLogin(app);
    expect(await count('jtt_auth_login_total', 'redirected')).toBe(1);

    await idp.close();

    const callback = await finishLogin(app, flow);
    expect(callback.status).toBe(503);
    expect(callback.body.error.code).toBe('AUTH_PROVIDER_UNAVAILABLE');
    expect(await count('jtt_auth_callback_total', 'provider_unavailable')).toBe(1);
    expect(await count('jtt_auth_callback_total', 'verification_failed')).toBe(0);
  });
});

describe('discovery tells an outage from a mistake', () => {
  const answering = (status: number, body: unknown = {}) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('unreachable or 5xx is the provider; 4xx or an unusable document is the configuration', async () => {
    const issuer = 'https://idp.example.com';
    const refused = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(fetchDiscoveryDocument(issuer, { fetchImpl: refused })).rejects.toMatchObject({
      code: 'AUTH_PROVIDER_UNAVAILABLE',
    });
    await expect(fetchDiscoveryDocument(issuer, { fetchImpl: answering(503) })).rejects.toMatchObject({
      code: 'AUTH_PROVIDER_UNAVAILABLE',
    });
    await expect(fetchDiscoveryDocument(issuer, { fetchImpl: answering(404) })).rejects.toMatchObject({
      code: 'AUTH_MISCONFIGURED',
    });
    await expect(fetchDiscoveryDocument(issuer, { fetchImpl: answering(200, []) })).rejects.toMatchObject({
      code: 'AUTH_MISCONFIGURED',
    });
  });
});
