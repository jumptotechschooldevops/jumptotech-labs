/**
 * Starting and finishing a sign-in have a per-address request budget.
 *
 * `/auth/login` gives any caller a signed transaction cookie, and that cookie
 * can be sent to `/auth/callback` with its own state and any code, as often as
 * the caller likes. Each time, the api posts to the identity provider's token
 * endpoint under this deployment's client credentials: an anonymous loop was
 * a loop of token requests in the platform's name, which a provider answers by
 * throttling the client, and then nobody can sign in. The provider here is a
 * stub that counts those requests.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
  InMemorySessionStore,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { InMemoryUserRepository } from '../src/auth/users.js';
import type { OidcBrowserClient } from '../src/auth/oidc-client.js';
import type { TokenVerifier } from '../src/auth/oidc.js';
import { AuthError } from '../src/auth/identity.js';
import { SIGN_IN_RATE_LIMIT } from '../src/rate-limit.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'sign-in-rate-limit-test-secret';
const APP_URL = 'https://labs.example.com';

let registry: LabRegistry;
beforeAll(async () => {
  registry = await realCatalog();
});

function buildApp(limit?: number) {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: APP_URL,
    PUBLIC_ORIGIN: APP_URL,
    AUTH_MODE: 'development',
    OIDC_CLIENT_SECRET: 'sign-in-rate-limit-client-secret',
  } as NodeJS.ProcessEnv);
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime: new FakeContainerRuntime() }) });
  const sessions = new SessionManager({
    registry,
    providers,
    store: new InMemorySessionStore(),
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: SECRET,
  });

  let tokenRequests = 0;
  let next = 0;
  const client = {
    authorizationRequest: async () => {
      next += 1;
      return {
        url: `https://idp.example.com/authorize?state=state-${next}`,
        state: `state-${next}`,
        nonce: `nonce-${next}`,
        codeVerifier: `verifier-${next}-${'v'.repeat(43)}`,
      };
    },
    exchangeCode: async () => {
      tokenRequests += 1;
      throw new AuthError('AUTH_INVALID_TOKEN', 'The identity provider refused the code.');
    },
    endSessionUrl: async () => null,
  } as unknown as OidcBrowserClient;
  const idTokenVerifier: TokenVerifier = {
    verify: async () => {
      throw new AuthError('AUTH_INVALID_TOKEN', 'unused');
    },
  };

  const app = createApp({
    registry,
    sessions,
    k8s: new FakeKubernetes(),
    config,
    browserAuth: { users: new InMemoryUserRepository(), client, idTokenVerifier },
    ...(limit !== undefined ? { signInRateLimit: { limit, windowMs: 60_000 } } : {}),
  });
  return { app, tokenRequests: () => tokenRequests };
}

const from = (address: string) => ({ 'X-Forwarded-For': address });

/** One `/auth/login`: the transaction cookie and the state it carries. */
async function login(app: ReturnType<typeof buildApp>['app'], address: string) {
  const res = await request(app).get('/auth/login').set(from(address));
  expect(res.status, JSON.stringify(res.body)).toBe(302);
  const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const tx = cookies.find((c) => c.startsWith('jtt_session_tx='))!.split(';')[0]!;
  const state = new URL(String(res.headers.location)).searchParams.get('state')!;
  return { tx, state };
}

describe('the sign-in budget', () => {
  it('stops a replayed transaction from reaching the provider’s token endpoint', async () => {
    const { app, tokenRequests } = buildApp(5);
    const { tx, state } = await login(app, '198.51.100.9');

    // The same cookie, over and over: every one used to be a token request.
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const res = await request(app)
        .get(`/auth/callback?state=${state}&code=junk-${i}`)
        .set({ ...from('198.51.100.9'), Cookie: tx });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(statuses.slice(4)).toEqual([429, 429, 429, 429]);
    expect(tokenRequests()).toBe(4);
  });

  it('counts starting a sign-in against the same budget', async () => {
    const { app } = buildApp(2);
    await login(app, '198.51.100.10');
    await login(app, '198.51.100.10');
    const refused = await request(app).get('/auth/login').set(from('198.51.100.10'));
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('RATE_LIMITED');
  });

  it('keeps each address’s budget its own', async () => {
    const { app } = buildApp(1);
    await login(app, '198.51.100.11');
    expect((await request(app).get('/auth/login').set(from('198.51.100.11'))).status).toBe(429);
    await login(app, '198.51.100.12');
  });

  it('does not count the session read the page makes on every load', async () => {
    const { app } = buildApp(1);
    for (let i = 0; i < 5; i += 1) {
      expect((await request(app).get('/auth/session').set(from('198.51.100.13'))).status).toBe(200);
    }
    await login(app, '198.51.100.13');
  });

  it('allows a class behind one address to sign in at once by default', () => {
    expect(SIGN_IN_RATE_LIMIT).toEqual({ limit: 120, windowMs: 60_000 });
  });
});
