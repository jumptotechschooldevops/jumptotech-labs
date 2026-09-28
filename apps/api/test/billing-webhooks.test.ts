/**
 * Billing — the provider boundary, verified webhooks, and entitlements
 * changed only by them (docs/billing.md).
 *
 * Every test runs against the `test` provider, in process: no network, no
 * credential, no card, no money. The webhooks are real HTTP requests to the
 * real route, signed the way the provider signs them, so signature checking,
 * body limits, idempotency and ordering are exercised end to end.
 *
 * The invariants:
 *
 *   1. Only a verified provider event changes access. A browser returning from
 *      checkout grants nothing.
 *   2. Anything not provably from the provider is refused before it is read.
 *   3. A retried event changes nothing twice; an older event never overwrites
 *      a newer state; a failed attempt leaves no trace and the retry succeeds.
 *   4. The subscription lifecycle — renewal, failed payment, cancellation at
 *      the period end or at once, reactivation — maps to access without any
 *      policy the configuration did not state.
 *   5. A subscription and a manual grant are separate rows; suspension is
 *      account-wide and survives billing events.
 *   6. A provider customer or subscription cannot move between accounts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
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
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createBillingMetrics, createRegistry } from '@jumptotech/observability';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { DevelopmentIdentityResolver } from '../src/auth/resolvers.js';
import { InMemoryUserRepository } from '../src/auth/users.js';
import { AccessControl, InMemoryAccessStore, type MutationInput, type MutationResult } from '../src/access/entitlements.js';
import { parsePlans } from '../src/access/plans.js';
import { BillingProcessor } from '../src/billing/processor.js';
import { InMemoryBillingStore } from '../src/billing/store.js';
import { TestBillingProvider, type SignedWebhook } from '../src/billing/test-provider.js';
import type { BillingPolicy } from '../src/billing/config.js';
import type { Offer } from '../src/billing/types.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'billing-webhooks-test-secret-value';
const WEBHOOK_SECRET = 'whsec-test-0123456789abcdef0123456789abcdef';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Fixture plans and offers. Not product decisions: the product has made none. */
const PLANS = parsePlans({
  plans: [
    { id: 'fixture-linux', name: 'Linux only', tracks: ['linux'] },
    { id: 'fixture-all', name: 'Everything', tracks: 'all' },
  ],
});
const OFFERS: Offer[] = [
  {
    id: 'fixture-monthly',
    planId: 'fixture-all',
    priceRef: 'price_test_monthly',
    name: 'Fixture monthly',
    description: null,
    priceLabel: 'Test price',
    interval: 'month',
    features: [],
  },
  {
    id: 'fixture-linux',
    planId: 'fixture-linux',
    priceRef: 'price_test_linux',
    name: 'Fixture Linux',
    description: null,
    priceLabel: null,
    interval: 'month',
    features: [],
  },
];

let registry: LabRegistry;
beforeAll(async () => {
  registry = await realCatalog();
});

/** An access store that can be told to fail its next billing change, as a database blip would. */
class FlakyAccessStore extends InMemoryAccessStore {
  failNextSync = false;
  override mutate(input: MutationInput, now: () => Date): Promise<MutationResult> {
    if (input.action === 'SYNC' && this.failNextSync) {
      this.failNextSync = false;
      return Promise.reject(new Error('connection terminated unexpectedly'));
    }
    return super.mutate(input, now);
  }
}

function compose(policy: BillingPolicy = { renewalLeewayHours: 0, pastDueGraceHours: 0 }) {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_MODE: 'development',
    MAX_ACTIVE_SESSIONS_PER_STUDENT: '5',
    ACCESS_POLICY: 'entitlement',
  } as NodeJS.ProcessEnv);

  const clock = { now: Date.parse('2026-10-01T12:00:00.000Z') };
  const users = new InMemoryUserRepository();
  const accessStore = new FlakyAccessStore(users);
  const access = new AccessControl(accessStore, 'entitlement', () => new Date(clock.now), {
    plans: PLANS,
    deploymentSessionLimit: 5,
    trackOfLab: (labId) => (registry.has(labId) ? registry.get(labId).track : undefined),
  });
  const provider = new TestBillingProvider({ webhookSecret: WEBHOOK_SECRET, appUrl: 'http://localhost:3000', now: () => clock.now });
  const billingStore = new InMemoryBillingStore(accessStore);
  const metricsRegistry = createRegistry({ service: 'api', defaultMetrics: false });
  const metrics = createBillingMetrics(metricsRegistry, 'test');
  const lines: string[] = [];
  const processor = new BillingProcessor({
    provider,
    store: billingStore,
    offers: OFFERS,
    plans: PLANS,
    policy,
    now: () => clock.now,
    metrics,
    logger: {
      debug: () => undefined,
      info: (event: string, fields?: object) => lines.push(JSON.stringify({ event, ...fields })),
      warn: (event: string, fields?: object) => lines.push(JSON.stringify({ event, ...fields })),
      error: (event: string, fields?: object) => lines.push(JSON.stringify({ event, ...fields, err: undefined })),
      child: () => {
        throw new Error('unused');
      },
    } as never,
  });

  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime: new FakeContainerRuntime() }) });
  const app: Express = createApp({
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
    billing: { processor },
  });

  const as = (who: string) => ({ Authorization: `Developer ${who}` });
  const userId = async (who: string) => {
    await request(app).get('/api/me').set(as(who));
    return (await users.list()).find((u) => u.subject === who)!.userId;
  };

  /** What the checkout route (docs/billing.md §4) does: a provider checkout, recorded for this account. */
  const checkout = async (who: string, offerId = 'fixture-monthly') => {
    const id = await userId(who);
    const offer = OFFERS.find((o) => o.id === offerId)!;
    const created = await provider.createCheckout({
      userId: id,
      offer,
      customerRef: await billingStore.customerOf('test', id),
      successUrl: 'http://localhost:3000/#/account?checkout=success',
      cancelUrl: 'http://localhost:3000/#/account?checkout=cancel',
    });
    await billingStore.recordCheckout({
      provider: 'test',
      checkoutRef: created.checkoutRef,
      userId: id,
      offerId,
      createdAt: new Date(clock.now).toISOString(),
    });
    return { userId: id, checkoutRef: created.checkoutRef };
  };

  const deliver = (webhook: SignedWebhook | { rawBody: Buffer; headers: Record<string, string> }) =>
    // As a string: supertest would JSON-encode a Buffer. The bytes are the same.
    request(app).post('/api/billing/webhooks/test').set(webhook.headers).send(webhook.rawBody.toString('utf8'));

  const deliverAll = async (webhooks: SignedWebhook[]) => {
    for (const webhook of webhooks) {
      const res = await deliver(webhook);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
  };

  /** Subscribe `who` and deliver the provider's webhooks. */
  const subscribe = async (who: string, offerId = 'fixture-monthly', options: { trialDays?: number } = {}) => {
    const started = await checkout(who, offerId);
    const webhooks = provider.completeCheckout(started.checkoutRef, options);
    await deliverAll(webhooks);
    const subscriptionRef = JSON.parse(webhooks[1]!.rawBody.toString('utf8')).data.subscription.id as string;
    return { ...started, subscriptionRef };
  };

  const start = (who: string, lab = 'LINUX-001') => request(app).post(`/api/labs/${lab}/start`).set(as(who));
  const endAll = async (who: string) => {
    const list = await request(app).get('/api/sessions').set(as(who));
    for (const s of list.body.data.sessions ?? []) await request(app).delete(`/api/sessions/${s.sessionId}`).set(as(who));
  };
  const metric = async (outcome: string) => {
    const found = (await metricsRegistry.getMetricsAsJSON()).find((m) => m.name === 'jtt_billing_webhooks_total');
    return ((found?.values ?? []) as Array<{ value: number; labels: Record<string, string> }>)
      .filter((v) => v.labels.outcome === outcome)
      .reduce((sum, v) => sum + v.value, 0);
  };

  return {
    app,
    clock,
    users,
    accessStore,
    billingStore,
    provider,
    access,
    lines,
    as,
    userId,
    checkout,
    deliver,
    deliverAll,
    subscribe,
    start,
    endAll,
    metric,
  };
}

describe('only a verified provider event grants paid access', () => {
  it('checkout → payment at the provider → signed webhooks → the student can start labs', async () => {
    const h = compose();
    const { userId, checkoutRef } = await h.checkout('ana');

    // The browser comes back to the success URL. Nothing about that grants access.
    expect((await h.start('ana')).status).toBe(403);
    const me = await request(h.app).get('/api/me/access').set(h.as('ana'));
    expect(me.body.data.access).toMatchObject({ state: 'NONE', active: false });

    const [completed, created] = h.provider.completeCheckout(checkoutRef);
    expect((await h.deliver(completed!)).body.data).toEqual({ received: true, outcome: 'applied' });
    expect((await h.deliver(created!)).body.data).toEqual({ received: true, outcome: 'applied' });

    expect((await h.start('ana')).status).toBe(200);
    const after = await request(h.app).get('/api/me/access').set(h.as('ana'));
    expect(after.body.data.access).toMatchObject({
      state: 'ACTIVE',
      active: true,
      kind: 'SUBSCRIPTION',
      source: 'billing',
      plan: { id: 'fixture-all' },
      expiresAt: new Date(h.clock.now + 30 * DAY).toISOString(),
    });
    expect(await h.billingStore.customerOf('test', userId)).toMatch(/^cus_test_/);
    const history = await h.accessStore.events(userId, 5);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ source: 'billing', action: 'SYNC', actor: 'billing.test' });
    expect(history[0]!.reason).toMatch(/^billing event subscription\.created evt_test_/);
  });

  it('the plan comes from the offer the provider charged for', async () => {
    const h = compose();
    await h.subscribe('ben', 'fixture-linux');
    expect((await h.start('ben', 'LINUX-001')).status).toBe(200);
    expect((await h.start('ben', 'DOCKER-001')).body.error.code).toBe('LAB_NOT_IN_PLAN');
  });
});

describe('what is refused before anything is read', () => {
  it('refuses a missing, wrong or tampered signature, and a replay outside the tolerance', async () => {
    const h = compose();
    const { checkoutRef, userId } = await h.checkout('cy');
    const [, created] = h.provider.completeCheckout(checkoutRef);

    const missing = await request(h.app)
      .post('/api/billing/webhooks/test')
      .set('content-type', 'application/json')
      .send(created!.rawBody.toString('utf8'));
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('WEBHOOK_REJECTED');

    const tampered = Buffer.from(created!.rawBody.toString('utf8').replace('"active"', '"trialing"'));
    expect((await h.deliver({ rawBody: tampered, headers: created!.headers })).status).toBe(400);

    const forged = new TestBillingProvider({ webhookSecret: 'x'.repeat(40), appUrl: 'http://x', now: () => h.clock.now });
    const forgedHeaders = forged.signatureHeaders(created!.rawBody);
    expect((await h.deliver({ rawBody: created!.rawBody, headers: forgedHeaders })).status).toBe(400);

    const garbage = { ...created!.headers, 'jtt-test-signature': 't=abc,v1=zz' };
    expect((await h.deliver({ rawBody: created!.rawBody, headers: garbage })).status).toBe(400);

    // A captured, genuinely signed webhook replayed ten minutes later.
    h.clock.now += 10 * 60 * 1000;
    const replay = await h.deliver(created!);
    expect(replay.status).toBe(400);
    expect(h.lines.some((l) => l.includes('TIMESTAMP_OUT_OF_TOLERANCE'))).toBe(true);

    expect(await h.billingStore.subscriptionsOf(userId)).toEqual([]);
    expect(await h.accessStore.grants(userId)).toEqual([]);
    expect(await h.metric('invalid_signature')).toBe(5);
    // Never the body or the secret in a log line.
    expect(h.lines.join('\n')).not.toContain(WEBHOOK_SECRET);
    expect(h.lines.join('\n')).not.toContain('price_test_monthly');
  });

  it('refuses a signed body it does not understand, and a body over 64 KB', async () => {
    const h = compose();
    for (const body of ['not json', '{"id":"evt_1","type":"subscription.updated","occurredAt":"2026-10-01T12:00:00Z","data":{}}', '[]']) {
      const raw = Buffer.from(body);
      const res = await h.deliver({ rawBody: raw, headers: h.provider.signatureHeaders(raw) });
      expect(res.status, body).toBe(400);
    }
    expect(await h.metric('malformed')).toBe(3);

    const huge = Buffer.alloc(70 * 1024, 'a');
    const res = await h.deliver({ rawBody: huge, headers: h.provider.signatureHeaders(huge) });
    expect(res.status).toBe(413);
  });

  it('answers only for the configured provider', async () => {
    const h = compose();
    const res = await request(h.app).post('/api/billing/webhooks/stripe').send('{}');
    expect(res.status).toBe(404);
  });

  it('acknowledges a verified event type it does not use, and changes nothing', async () => {
    const h = compose();
    const res = await h.deliver(h.provider.sign('invoice.finalized', { invoice: 'in_test_1' }));
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('ignored');
  });
});

describe('retries, ordering and failures', () => {
  it('a duplicate delivery changes nothing and says so', async () => {
    const h = compose();
    const { checkoutRef, userId } = await h.checkout('dee');
    const webhooks = h.provider.completeCheckout(checkoutRef);
    await h.deliverAll(webhooks);
    const before = await h.accessStore.grants(userId);

    for (const webhook of [...webhooks, ...webhooks]) {
      const again = await h.deliver({ rawBody: webhook.rawBody, headers: h.provider.signatureHeaders(webhook.rawBody) });
      expect(again.body.data.outcome).toBe('duplicate');
    }
    expect(await h.accessStore.grants(userId)).toEqual(before);
    expect(await h.accessStore.events(userId, 10)).toHaveLength(1);
    expect(await h.billingStore.subscriptionsOf(userId)).toHaveLength(1);
    expect(await h.metric('duplicate')).toBe(4);
  });

  it('two deliveries of one event at the same instant: one applies, one is a duplicate', async () => {
    const h = compose();
    const { checkoutRef, userId } = await h.checkout('eli');
    const [completed, created] = h.provider.completeCheckout(checkoutRef);
    await h.deliver(completed!);
    const [a, b] = await Promise.all([h.deliver(created!), h.deliver(created!)]);
    expect([a.body.data.outcome, b.body.data.outcome].sort()).toEqual(['applied', 'duplicate']);
    expect(await h.accessStore.events(userId, 10)).toHaveLength(1);
  });

  it('an older state arriving after a newer one is recorded and not applied', async () => {
    const h = compose();
    const { checkoutRef, userId } = await h.checkout('fin');
    const [completed, created] = h.provider.completeCheckout(checkoutRef);
    const subRef = JSON.parse(created!.rawBody.toString()).data.subscription.id as string;
    h.clock.now += 30 * DAY;
    const renewed = h.provider.renew(subRef);

    await h.deliver(completed!);
    expect((await h.deliver(renewed)).body.data.outcome).toBe('applied');
    // The delayed "created" (period one) arrives last — re-signed, as a provider retry would be.
    const late = await h.deliver({ rawBody: created!.rawBody, headers: h.provider.signatureHeaders(created!.rawBody) });
    expect(late.body.data.outcome).toBe('stale');

    const [sub] = await h.billingStore.subscriptionsOf(userId);
    expect(sub!.currentPeriodEnd).toBe(new Date(Date.parse('2026-10-01T12:00:00.000Z') + 60 * DAY).toISOString());
    expect((await h.accessStore.grants(userId))[0]!.expiresAt).toBe(sub!.currentPeriodEnd);
  });

  it('a subscription that arrives before its checkout.completed is matched through this platform\'s own checkout', async () => {
    const h = compose();
    const { checkoutRef, userId } = await h.checkout('gus');
    const [completed, created] = h.provider.completeCheckout(checkoutRef);
    expect((await h.deliver(created!)).body.data.outcome).toBe('applied');
    expect((await h.deliver(completed!)).body.data.outcome).toBe('applied');
    expect((await h.access.decide(userId)).allowed).toBe(true);
  });

  it('a failed attempt leaves no trace, and the provider\'s retry applies it exactly once', async () => {
    const h = compose();
    const { checkoutRef, userId } = await h.checkout('hal');
    const [completed, created] = h.provider.completeCheckout(checkoutRef);
    await h.deliver(completed!);

    h.accessStore.failNextSync = true;
    const failed = await h.deliver(created!);
    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe('WEBHOOK_NOT_PROCESSED');
    expect(await h.billingStore.subscriptionsOf(userId)).toEqual([]);
    expect(await h.accessStore.grants(userId)).toEqual([]);
    expect(await h.metric('failed')).toBe(1);

    const retried = await h.deliver({ rawBody: created!.rawBody, headers: h.provider.signatureHeaders(created!.rawBody) });
    expect(retried.body.data.outcome).toBe('applied');
    expect(await h.accessStore.events(userId, 10)).toHaveLength(1);
    expect((await h.access.decide(userId)).allowed).toBe(true);
  });

  it('a subscription for no known account, or for a price no offer names, is retried rather than dropped', async () => {
    const h = compose();
    const stranger = await h.userId('ivy'); // signed in, but never started a checkout
    const foreign = h.provider.sign('subscription.created', {
      subscription: {
        id: 'sub_test_foreign',
        customer: 'cus_test_foreign',
        price: 'price_test_monthly',
        status: 'active',
        currentPeriodStart: '2026-10-01T12:00:00.000Z',
        currentPeriodEnd: '2026-10-31T12:00:00.000Z',
        cancelAtPeriodEnd: false,
        endedAt: null,
        clientReference: stranger,
      },
    });
    expect((await h.deliver(foreign)).status).toBe(500);
    expect(await h.accessStore.grants(stranger)).toEqual([]);

    const { checkoutRef, userId } = await h.checkout('jo');
    const [completed] = h.provider.completeCheckout(checkoutRef);
    await h.deliver(completed!);
    const customer = (await h.billingStore.customerOf('test', userId))!;
    const unknownPrice = h.provider.sign('subscription.created', {
      subscription: {
        id: 'sub_test_other_price',
        customer,
        price: 'price_test_not_offered',
        status: 'active',
        currentPeriodStart: '2026-10-01T12:00:00.000Z',
        currentPeriodEnd: '2026-10-31T12:00:00.000Z',
        cancelAtPeriodEnd: false,
        endedAt: null,
        clientReference: userId,
      },
    });
    expect((await h.deliver(unknownPrice)).status).toBe(500);
    expect(await h.metric('unmapped')).toBe(2);
    expect(await h.accessStore.grants(userId)).toEqual([]);
  });
});

describe('the subscription lifecycle', () => {
  it('renewal extends access; with no leeway it lapses at the period end until the renewal arrives', async () => {
    const h = compose({ renewalLeewayHours: 0, pastDueGraceHours: 0 });
    const { subscriptionRef, userId } = await h.subscribe('kim');
    h.clock.now += 30 * DAY; // the period end
    expect((await h.access.decide(userId)).allowed).toBe(false);
    await h.deliverAll([h.provider.renew(subscriptionRef)]);
    expect((await h.access.decide(userId)).allowed).toBe(true);
  });

  it('a configured renewal leeway bridges the gap between period end and the renewal event', async () => {
    const h = compose({ renewalLeewayHours: 24, pastDueGraceHours: 0 });
    const { userId } = await h.subscribe('lu');
    h.clock.now += 30 * DAY + 2 * HOUR;
    expect((await h.access.decide(userId)).allowed).toBe(true);
    h.clock.now += 23 * HOUR;
    expect((await h.access.decide(userId)).allowed).toBe(false);
  });

  it('a failed renewal ends access at the paid period\'s end with no grace, and a recovered payment restores it', async () => {
    const h = compose({ renewalLeewayHours: 24, pastDueGraceHours: 0 });
    const { subscriptionRef, userId } = await h.subscribe('max');
    h.clock.now += 30 * DAY;
    await h.deliverAll([h.provider.failRenewal(subscriptionRef)]);
    const denied = await h.start('max');
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.accessState).toBe('EXPIRED');
    await h.deliverAll([h.provider.recoverPayment(subscriptionRef)]);
    expect((await h.access.decide(userId)).allowed).toBe(true);
  });

  it('a configured failed-payment grace keeps access for exactly that long', async () => {
    const h = compose({ renewalLeewayHours: 0, pastDueGraceHours: 72 });
    const { subscriptionRef, userId } = await h.subscribe('ned');
    h.clock.now += 30 * DAY;
    await h.deliverAll([h.provider.failRenewal(subscriptionRef)]);
    h.clock.now += 71 * HOUR;
    expect((await h.access.decide(userId)).allowed).toBe(true);
    h.clock.now += 2 * HOUR;
    expect((await h.access.decide(userId)).allowed).toBe(false);
    // The provider gives up: still no access, and no grace starts again.
    await h.deliverAll([h.provider.markUnpaid(subscriptionRef)]);
    expect((await h.access.decide(userId)).allowed).toBe(false);
  });

  it('cancel at period end keeps access to the end — with no renewal leeway — then ends it', async () => {
    const h = compose({ renewalLeewayHours: 48, pastDueGraceHours: 0 });
    const { subscriptionRef, userId } = await h.subscribe('ola');
    h.clock.now += 5 * DAY;
    await h.deliverAll([h.provider.setCancelAtPeriodEnd(subscriptionRef, true)]);
    expect((await h.access.decide(userId)).allowed).toBe(true);
    const grant = (await h.accessStore.grants(userId))[0]!;
    expect(grant.expiresAt).toBe(new Date(Date.parse('2026-10-01T12:00:00.000Z') + 30 * DAY).toISOString());
    h.clock.now += 25 * DAY;
    expect((await h.access.decide(userId)).allowed).toBe(false);
    await h.deliverAll([h.provider.endAtPeriodEnd(subscriptionRef)]);
    expect((await h.access.decide(userId)).allowed).toBe(false);
  });

  it('cancel at once ends access on the next request; changing one\'s mind before the end resumes renewal', async () => {
    const h = compose({ renewalLeewayHours: 24, pastDueGraceHours: 0 });
    const first = await h.subscribe('pat');
    await h.deliverAll([h.provider.setCancelAtPeriodEnd(first.subscriptionRef, true)]);
    await h.deliverAll([h.provider.setCancelAtPeriodEnd(first.subscriptionRef, false)]);
    const renewing = (await h.accessStore.grants(first.userId))[0]!;
    expect(Date.parse(renewing.expiresAt!)).toBe(Date.parse('2026-10-01T12:00:00.000Z') + 30 * DAY + 24 * HOUR);

    h.clock.now += 3 * DAY;
    await h.deliverAll([h.provider.cancelNow(first.subscriptionRef)]);
    const denied = await h.start('pat');
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.accessState).toBe('EXPIRED');
  });

  it('reactivation is a new subscription through a new checkout, on the same provider customer', async () => {
    const h = compose();
    const first = await h.subscribe('quin');
    await h.deliverAll([h.provider.cancelNow(first.subscriptionRef)]);
    expect((await h.access.decide(first.userId)).allowed).toBe(false);
    h.clock.now += DAY;
    const second = await h.subscribe('quin');
    expect(second.subscriptionRef).not.toBe(first.subscriptionRef);
    expect((await h.access.decide(first.userId)).allowed).toBe(true);
    expect(await h.billingStore.subscriptionsOf(first.userId)).toHaveLength(2);
    // Still one customer for the account.
    expect(await h.billingStore.customerOf('test', first.userId)).toBeTruthy();
  });

  it('a provider trial is a TRIAL row, and counts as the account\'s one trial', async () => {
    const h = compose();
    const { userId } = await h.subscribe('rae', 'fixture-monthly', { trialDays: 14 });
    expect((await h.accessStore.grants(userId))[0]).toMatchObject({ kind: 'TRIAL', grantedVia: 'billing' });
    await expect(
      h.accessStore.mutate(
        { userId, action: 'TRIAL', actor: 'ops', reason: 'x', trial: { durationDays: 7, planId: null } },
        () => new Date(h.clock.now),
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/TRIAL_ALREADY_USED|ALREADY_ACTIVE/) });
  });
});

describe('manual grants, suspension and billing together', () => {
  it('a subscription ending never removes a manual beta grant, and revoking the grant never cancels anything paid', async () => {
    const h = compose();
    const id = await h.userId('sam');
    await h.accessStore.mutate(
      { userId: id, action: 'GRANT', actor: 'ops', reason: 'beta', grant: { expiresAt: null, kind: 'BETA' } },
      () => new Date(h.clock.now),
    );
    const { subscriptionRef } = await h.subscribe('sam');
    expect((await h.accessStore.grants(id)).map((g) => `${g.grantedVia}:${g.kind}`).sort()).toEqual([
      'billing:SUBSCRIPTION',
      'operator:BETA',
    ]);
    await h.deliverAll([h.provider.cancelNow(subscriptionRef)]);
    expect((await h.access.decide(id)).allowed).toBe(true); // the beta grant still stands

    const again = await h.subscribe('sam');
    await h.accessStore.mutate({ userId: id, action: 'REVOKE', actor: 'ops', reason: 'beta over' }, () => new Date(h.clock.now));
    expect((await h.access.decide(id)).allowed).toBe(true); // the subscription still stands
    expect(again.subscriptionRef).toBeTruthy();
  });

  it('suspension is account-wide: a renewal while suspended stays suspended, and restore brings the new period', async () => {
    const h = compose();
    const { subscriptionRef, userId } = await h.subscribe('tia');
    await h.accessStore.mutate({ userId, action: 'SUSPEND', actor: 'support', reason: 'chargeback opened' }, () => new Date(h.clock.now));
    expect((await h.start('tia')).body.error.details.accessState).toBe('SUSPENDED');

    h.clock.now += 30 * DAY;
    await h.deliverAll([h.provider.renew(subscriptionRef)]);
    expect((await h.accessStore.grants(userId))[0]).toMatchObject({
      status: 'SUSPENDED',
      expiresAt: new Date(Date.parse('2026-10-01T12:00:00.000Z') + 60 * DAY).toISOString(),
    });
    expect((await h.access.decide(userId)).allowed).toBe(false);

    await h.accessStore.mutate({ userId, action: 'RESTORE', actor: 'support', reason: 'resolved' }, () => new Date(h.clock.now));
    expect((await h.access.decide(userId)).allowed).toBe(true);
  });

  it('a subscription bought while the account is suspended is born suspended', async () => {
    const h = compose();
    const id = await h.userId('uma');
    await h.accessStore.mutate(
      { userId: id, action: 'GRANT', actor: 'ops', reason: 'x', grant: { expiresAt: null } },
      () => new Date(h.clock.now),
    );
    await h.accessStore.mutate({ userId: id, action: 'SUSPEND', actor: 'ops', reason: 'abuse' }, () => new Date(h.clock.now));
    await h.subscribe('uma');
    expect((await h.accessStore.grants(id)).every((g) => g.status === 'SUSPENDED')).toBe(true);
    expect((await h.access.decide(id)).allowed).toBe(false);
  });

  it('a subscription that ended while suspended is not revived by restore', async () => {
    const h = compose();
    const { subscriptionRef, userId } = await h.subscribe('vic');
    await h.accessStore.mutate({ userId, action: 'SUSPEND', actor: 'ops', reason: 'x' }, () => new Date(h.clock.now));
    h.clock.now += DAY;
    await h.deliverAll([h.provider.cancelNow(subscriptionRef)]);
    await h.accessStore.mutate({ userId, action: 'RESTORE', actor: 'ops', reason: 'y' }, () => new Date(h.clock.now));
    const decision = await h.access.decide(userId);
    expect(decision).toMatchObject({ allowed: false, state: 'EXPIRED' });
  });

  it('an operator cannot revoke a paid subscription — that is the provider\'s — and is told how to stop lab use', async () => {
    const h = compose();
    const { userId } = await h.subscribe('wes');
    await expect(
      h.accessStore.mutate({ userId, action: 'REVOKE', actor: 'ops', reason: 'x' }, () => new Date(h.clock.now)),
    ).rejects.toMatchObject({ code: 'NO_ENTITLEMENT', message: expect.stringMatching(/Cancel it in the billing provider/) });
  });
});

describe('accounts and ownership', () => {
  it('a completed checkout this platform did not start, or for another account, binds nothing', async () => {
    const h = compose();
    const mine = await h.userId('xan');
    const theirs = await h.userId('yve');
    const notOurs = h.provider.sign('checkout.completed', { checkout: 'cs_test_elsewhere', customer: 'cus_test_x', clientReference: mine });
    expect((await h.deliver(notOurs)).body.data.outcome).toBe('ignored');

    const { checkoutRef } = await h.checkout('xan');
    const mismatched = h.provider.sign('checkout.completed', { checkout: checkoutRef, customer: 'cus_test_y', clientReference: theirs });
    expect((await h.deliver(mismatched)).body.data.outcome).toBe('ignored');
    expect(await h.billingStore.customerOf('test', mine)).toBeNull();
    expect(await h.billingStore.customerOf('test', theirs)).toBeNull();
  });

  it('one account\'s provider customer can never be bound to another account', async () => {
    const h = compose();
    const a = await h.subscribe('zed');
    const customer = (await h.billingStore.customerOf('test', a.userId))!;
    const b = await h.checkout('ada');
    const hijack = h.provider.sign('checkout.completed', { checkout: b.checkoutRef, customer, clientReference: b.userId });
    expect((await h.deliver(hijack)).body.data.outcome).toBe('ignored');
    expect(h.lines.some((l) => l.includes('billing.ownership_conflict'))).toBe(true);
    expect(await h.billingStore.customerOf('test', b.userId)).toBeNull();

    // Nor can A's subscription be re-reported as B's.
    const moved = h.provider.sign('subscription.updated', {
      subscription: {
        id: a.subscriptionRef,
        customer: 'cus_test_new_for_b',
        price: 'price_test_monthly',
        status: 'active',
        currentPeriodStart: '2026-10-01T12:00:00.000Z',
        currentPeriodEnd: '2026-12-31T12:00:00.000Z',
        cancelAtPeriodEnd: false,
        endedAt: null,
        clientReference: b.userId,
      },
    });
    expect((await h.deliver(moved)).body.data.outcome).toBe('ignored');
    expect(await h.accessStore.grants(b.userId)).toEqual([]);
  });

  it('stores references and product state only — never a payload, and nothing card-shaped', async () => {
    const h = compose();
    const { checkoutRef, userId } = await h.checkout('bea');
    const [completed, created] = h.provider.completeCheckout(checkoutRef);
    const withCard = JSON.parse(created!.rawBody.toString());
    withCard.data.subscription.card = { number: '4242424242424242', cvc: '123' };
    const raw = Buffer.from(JSON.stringify(withCard));
    await h.deliver(completed!);
    expect((await h.deliver({ rawBody: raw, headers: h.provider.signatureHeaders(raw) })).status).toBe(200);
    const stored = JSON.stringify([
      await h.billingStore.subscriptionsOf(userId),
      await h.billingStore.recentEvents('test', 10),
      await h.accessStore.events(userId, 10),
    ]);
    expect(stored).not.toMatch(/4242|cvc|card/i);
    expect(h.lines.join('\n')).not.toMatch(/4242|cvc/i);
  });
});
