/**
 * A student's billing over HTTP — `GET /api/billing`, checkout, portal, and
 * the test-mode checkout and portal (docs/billing.md §2).
 *
 * The invariants:
 *
 *   1. Every answer is about the caller's own account. There is no parameter
 *      that names another — a customer, subscription, plan or price in a body
 *      is refused — and one student can reach nothing of another's.
 *   2. Starting a checkout grants nothing; only the provider's verified
 *      webhook does (here: the simulator's, delivered to the real processor).
 *   3. Students see product states (ACTIVE, CANCELING, PAYMENT_PROBLEM, ENDED),
 *      never a raw provider status, and never a price reference.
 *   4. With billing off the page still has one shape to read, and no billing
 *      action exists.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
} from '@jumptotech/lab-orchestrator';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createBillingMetrics, createRegistry } from '@jumptotech/observability';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { DevelopmentIdentityResolver } from '../src/auth/resolvers.js';
import { InMemoryUserRepository } from '../src/auth/users.js';
import { AccessControl, InMemoryAccessStore } from '../src/access/entitlements.js';
import { parsePlans } from '../src/access/plans.js';
import { BillingConfigError, legalFromEnv } from '../src/billing/config.js';
import { BillingProcessor } from '../src/billing/processor.js';
import { BillingService, MAX_CHECKOUTS_PER_HOUR } from '../src/billing/service.js';
import { InMemoryBillingStore } from '../src/billing/store.js';
import { TestBillingProvider } from '../src/billing/test-provider.js';
import type { Offer } from '../src/billing/types.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'billing-account-test-secret-value';
const DAY = 86_400_000;
const PLANS = parsePlans({ plans: [{ id: 'fixture-all', name: 'Everything', tracks: 'all' }] });
const OFFERS: Offer[] = [
  {
    id: 'fixture-monthly',
    planId: 'fixture-all',
    priceRef: 'price_test_secret_ref',
    name: 'Fixture monthly',
    description: 'A test fixture, not a product decision.',
    priceLabel: 'Test price',
    interval: 'month',
    features: ['Every track'],
  },
];

let registry: LabRegistry;
beforeAll(async () => {
  registry = await realCatalog();
});

function compose(options: { billing?: boolean; env?: Record<string, string> } = {}) {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_MODE: 'development',
    ACCESS_POLICY: 'entitlement',
    ...options.env,
  } as NodeJS.ProcessEnv);
  const clock = { now: Date.parse('2026-10-01T12:00:00.000Z') };
  const users = new InMemoryUserRepository();
  const accessStore = new InMemoryAccessStore(users);
  const access = new AccessControl(accessStore, 'entitlement', () => new Date(clock.now), { plans: PLANS });
  const provider = new TestBillingProvider({ webhookSecret: 'w'.repeat(40), appUrl: 'http://localhost:3000', now: () => clock.now });
  const store = new InMemoryBillingStore(accessStore);
  const metricsRegistry = createRegistry({ service: 'api', defaultMetrics: false });
  const metrics = createBillingMetrics(metricsRegistry, 'test');
  const policy = { renewalLeewayHours: 0, pastDueGraceHours: 0 };
  const processor = new BillingProcessor({ provider, store, offers: OFFERS, plans: PLANS, policy, now: () => clock.now, metrics });
  const service = new BillingService({
    provider,
    store,
    processor,
    access: accessStore,
    offers: OFFERS,
    plans: PLANS,
    policy,
    appUrl: 'http://localhost:3000',
    now: () => clock.now,
    metrics,
  });
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime: new FakeContainerRuntime() }) });
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
    k8s: undefined as never,
    config,
    identityResolver: new DevelopmentIdentityResolver(users),
    browserAuth: { users },
    access,
    ...(options.billing === false ? {} : { billing: { processor, service } }),
  });
  const as = (who: string) => ({ Authorization: `Developer ${who}` });
  const userId = async (who: string) => {
    await request(app).get('/api/me').set(as(who));
    return (await users.list()).find((u) => u.subject === who)!.userId;
  };
  const refFrom = (url: string) => url.split('/').pop()!;
  const subscribe = async (who: string) => {
    const started = await request(app).post('/api/billing/checkout').set(as(who)).send({ offerId: 'fixture-monthly' });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const done = await request(app).post(`/api/billing/test/checkouts/${refFrom(started.body.data.url)}/complete`).set(as(who));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data.outcomes).toEqual(['applied', 'applied']);
  };
  const metric = async (op: string, outcome: string) => {
    const found = (await metricsRegistry.getMetricsAsJSON()).find((m) => m.name === 'jtt_billing_provider_requests_total');
    return ((found?.values ?? []) as Array<{ value: number; labels: Record<string, string> }>)
      .filter((v) => v.labels.op === op && v.labels.outcome === outcome)
      .reduce((sum, v) => sum + v.value, 0);
  };
  return { app, clock, as, userId, refFrom, subscribe, accessStore, provider, metric };
}

describe('billing off', () => {
  it('the account page still reads one shape, and no billing action exists', async () => {
    const h = compose({ billing: false });
    const view = await request(h.app).get('/api/billing').set(h.as('ana'));
    expect(view.status).toBe(200);
    expect(view.body.data).toEqual({
      billing: { enabled: false, offers: [], subscription: null, canManageBilling: false, canSubscribe: false },
      legal: { termsUrl: null, privacyUrl: null, refundUrl: null },
    });
    expect((await request(h.app).post('/api/billing/checkout').set(h.as('ana')).send({ offerId: 'x' })).body.error.code).toBe(
      'BILLING_DISABLED',
    );
    expect((await request(h.app).post('/api/billing/portal').set(h.as('ana'))).status).toBe(404);
    expect((await request(h.app).post('/api/billing/test/checkouts/cs_test_1/complete').set(h.as('ana'))).status).toBe(404);
  });
});

describe('checkout', () => {
  it('starting a checkout grants nothing; the verified webhook does', async () => {
    const h = compose();
    const id = await h.userId('ben');
    const before = await request(h.app).get('/api/billing').set(h.as('ben'));
    expect(before.body.data.billing).toMatchObject({ enabled: true, mode: 'test', subscription: null, canSubscribe: true });
    expect(before.body.data.billing.offers).toEqual([
      {
        id: 'fixture-monthly',
        name: 'Fixture monthly',
        description: 'A test fixture, not a product decision.',
        priceLabel: 'Test price',
        interval: 'month',
        features: ['Every track'],
        plan: { id: 'fixture-all', name: 'Everything', tracks: 'all' },
      },
    ]);
    // The provider's price reference never reaches a browser.
    expect(JSON.stringify(before.body)).not.toContain('price_test_secret_ref');

    const started = await request(h.app).post('/api/billing/checkout').set(h.as('ben')).send({ offerId: 'fixture-monthly' });
    expect(started.body.data.url).toMatch(/^http:\/\/localhost:3000\/#\/account\/test-checkout\/cs_test_/);
    expect(await h.accessStore.grants(id)).toEqual([]);
    expect((await request(h.app).post('/api/labs/LINUX-001/start').set(h.as('ben'))).status).toBe(403);

    const done = await request(h.app).post(`/api/billing/test/checkouts/${h.refFrom(started.body.data.url)}/complete`).set(h.as('ben'));
    expect(done.body.data).toEqual({ mode: 'test', outcomes: ['applied', 'applied'] });
    expect((await request(h.app).post('/api/labs/LINUX-001/start').set(h.as('ben'))).status).toBe(200);

    const after = await request(h.app).get('/api/billing').set(h.as('ben'));
    expect(after.body.data.billing).toMatchObject({
      subscription: {
        status: 'ACTIVE',
        planId: 'fixture-all',
        planName: 'Everything',
        cancelAtPeriodEnd: false,
        accessUntil: new Date(h.clock.now + 30 * DAY).toISOString(),
      },
      canManageBilling: true,
      canSubscribe: false,
    });
    expect(JSON.stringify(after.body)).not.toMatch(/cus_test_|sub_test_|price_test_|"active"/);
  });

  it('refuses a body that names anything but an offer, and an offer that does not exist', async () => {
    const h = compose();
    for (const body of [
      { offerId: 'fixture-monthly', customerId: 'cus_test_someone' },
      { offerId: 'fixture-monthly', planId: 'fixture-all' },
      { offerId: 'fixture-monthly', priceRef: 'price_test_cheap' },
      { offerId: 'fixture-monthly', userId: 'usr-00000002' },
    ]) {
      const res = await request(h.app).post('/api/billing/checkout').set(h.as('cy')).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST');
    }
    for (const offerId of ['gold', '', 42, null]) {
      const res = await request(h.app).post('/api/billing/checkout').set(h.as('cy')).send({ offerId });
      expect(res.body.error.code).toBe('OFFER_NOT_FOUND');
    }
  });

  it('refuses a second subscription, a suspended account, and too many checkouts in an hour', async () => {
    const h = compose();
    await h.subscribe('dee');
    const again = await request(h.app).post('/api/billing/checkout').set(h.as('dee')).send({ offerId: 'fixture-monthly' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_SUBSCRIBED');

    const eli = await h.userId('eli');
    await h.accessStore.mutate({ userId: eli, action: 'GRANT', actor: 'ops', reason: 'x', grant: { expiresAt: null } }, () => new Date(h.clock.now));
    await h.accessStore.mutate({ userId: eli, action: 'SUSPEND', actor: 'ops', reason: 'x' }, () => new Date(h.clock.now));
    const suspended = await request(h.app).post('/api/billing/checkout').set(h.as('eli')).send({ offerId: 'fixture-monthly' });
    expect(suspended.body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect((await request(h.app).get('/api/billing').set(h.as('eli'))).body.data.billing.canSubscribe).toBe(false);

    for (let i = 0; i < MAX_CHECKOUTS_PER_HOUR; i += 1) {
      expect((await request(h.app).post('/api/billing/checkout').set(h.as('fin')).send({ offerId: 'fixture-monthly' })).status).toBe(200);
    }
    const tooMany = await request(h.app).post('/api/billing/checkout').set(h.as('fin')).send({ offerId: 'fixture-monthly' });
    expect(tooMany.status).toBe(429);
    h.clock.now += 61 * 60 * 1000;
    expect((await request(h.app).post('/api/billing/checkout').set(h.as('fin')).send({ offerId: 'fixture-monthly' })).status).toBe(200);
  });

  it('answers 503 when the provider is down, and counts it', async () => {
    const h = compose();
    h.provider.unavailable = true;
    const res = await request(h.app).post('/api/billing/checkout').set(h.as('gus')).send({ offerId: 'fixture-monthly' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(await h.metric('checkout', 'failed')).toBe(1);
  });

  it('refuses a checkout started from a foreign origin', async () => {
    const h = compose();
    const res = await request(h.app)
      .post('/api/billing/checkout')
      .set(h.as('hal'))
      .set('Origin', 'https://evil.example')
      .send({ offerId: 'fixture-monthly' });
    expect(res.status).toBe(403);
  });
});

describe('one account never reaches another\'s billing', () => {
  it('another student\'s test checkout, portal and subscription are out of reach', async () => {
    const h = compose();
    const started = await request(h.app).post('/api/billing/checkout').set(h.as('ivy')).send({ offerId: 'fixture-monthly' });
    const ref = h.refFrom(started.body.data.url);

    expect((await request(h.app).get(`/api/billing/test/checkouts/${ref}`).set(h.as('jo'))).status).toBe(404);
    expect((await request(h.app).post(`/api/billing/test/checkouts/${ref}/complete`).set(h.as('jo'))).status).toBe(404);
    const jo = await h.userId('jo');
    expect(await h.accessStore.grants(jo)).toEqual([]);

    await request(h.app).post(`/api/billing/test/checkouts/${ref}/complete`).set(h.as('ivy'));
    // Jo has no billing account of her own; there is no way to name Ivy's.
    const portal = await request(h.app).post('/api/billing/portal').set(h.as('jo'));
    expect(portal.status).toBe(404);
    expect(portal.body.error.code).toBe('NO_BILLING_ACCOUNT');
    expect((await request(h.app).post('/api/billing/portal').set(h.as('jo')).send({ customerId: 'cus_test_x' })).status).toBe(400);
    expect((await request(h.app).get('/api/billing').set(h.as('jo'))).body.data.billing.subscription).toBeNull();
    expect((await request(h.app).post('/api/billing/test/subscription/cancel-now').set(h.as('jo'))).status).toBe(404);
    // Ivy's own portal works.
    expect((await request(h.app).post('/api/billing/portal').set(h.as('ivy'))).body.data.url).toMatch(/test-portal/);
    // And completing Ivy's checkout twice is refused.
    expect((await request(h.app).post(`/api/billing/test/checkouts/${ref}/complete`).set(h.as('ivy'))).status).toBe(404);
  });
});

describe('the subscription lifecycle, as the student sees it', () => {
  it('cancel at period end, resume, failed renewal, recovery, cancel now', async () => {
    const h = compose();
    await h.subscribe('kim');
    const status = async () => (await request(h.app).get('/api/billing').set(h.as('kim'))).body.data.billing.subscription;
    const act = (action: string) => request(h.app).post(`/api/billing/test/subscription/${action}`).set(h.as('kim'));

    expect((await act('cancel-at-period-end')).body.data.outcomes).toEqual(['applied']);
    expect(await status()).toMatchObject({ status: 'CANCELING', cancelAtPeriodEnd: true, accessUntil: new Date(h.clock.now + 30 * DAY).toISOString() });
    await act('resume');
    expect((await status()).status).toBe('ACTIVE');

    h.clock.now += 30 * DAY;
    await act('fail-renewal');
    expect(await status()).toMatchObject({ status: 'PAYMENT_PROBLEM', accessUntil: null });
    expect((await request(h.app).post('/api/labs/LINUX-001/start').set(h.as('kim'))).body.error.details.accessState).toBe('EXPIRED');
    await act('recover');
    expect((await status()).status).toBe('ACTIVE');

    await act('cancel-now');
    expect(await status()).toMatchObject({ status: 'ENDED', accessUntil: null });
    expect((await request(h.app).get('/api/billing').set(h.as('kim'))).body.data.billing.canSubscribe).toBe(true);
    expect((await act('reboot')).status).toBe(400);
  });
});

describe('legal links', () => {
  it('are links only, https, and shown exactly as configured', async () => {
    const h = compose({
      env: { LEGAL_TERMS_URL: 'https://example.com/terms', LEGAL_PRIVACY_URL: 'https://example.com/privacy' },
    });
    expect((await request(h.app).get('/api/billing').set(h.as('lu'))).body.data.legal).toEqual({
      termsUrl: 'https://example.com/terms',
      privacyUrl: 'https://example.com/privacy',
      refundUrl: null,
    });
    expect(() => legalFromEnv({ LEGAL_TERMS_URL: 'http://example.com/terms' })).toThrow(BillingConfigError);
    expect(() => legalFromEnv({ LEGAL_TERMS_URL: 'javascript:alert(1)' })).toThrow(BillingConfigError);
    expect(() => legalFromEnv({ LEGAL_TERMS_URL: 'https://user:pw@example.com/' })).toThrow(BillingConfigError);
    expect(legalFromEnv({ LEGAL_REFUND_URL: 'http://localhost:8080/refunds' }).refundUrl).toBe('http://localhost:8080/refunds');
  });
});
