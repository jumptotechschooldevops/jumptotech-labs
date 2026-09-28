/**
 * Billing configuration and the provider-state → product-state mapping
 * (`billing/config.ts`, `billing/lifecycle.ts`), without HTTP.
 *
 * What these pin: billing is off by default; the only provider is the test
 * simulator and it is refused in production; every number that is a business
 * decision must be written down, with no default; an offer carries no amount;
 * and a raw provider status never reaches a student.
 */
import { describe, expect, it } from 'vitest';

import { parsePlans } from '../src/access/plans.js';
import { BillingConfigError, billingFromEnv, parseOffers } from '../src/billing/config.js';
import {
  COMMERCIAL_STATUSES,
  commercialStatus,
  desiredEntitlement,
  entitlementFor,
  type StoredSubscription,
} from '../src/billing/lifecycle.js';
import { SUBSCRIPTION_STATUSES } from '../src/billing/types.js';
import { loadConfig } from '../src/config.js';

const PLANS = parsePlans({ plans: [{ id: 'fixture', name: 'Fixture', tracks: 'all' }] });
const SECRET = 'a'.repeat(40);
const REQUIRED = {
  BILLING_PROVIDER: 'test',
  BILLING_WEBHOOK_SECRET: SECRET,
  BILLING_RENEWAL_LEEWAY_HOURS: '0',
  BILLING_PAST_DUE_GRACE_HOURS: '0',
};

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BillingConfigError);
    return (error as Error).message;
  }
  throw new Error('expected a BillingConfigError');
}

describe('billingFromEnv', () => {
  it('is off unless BILLING_PROVIDER is set', () => {
    expect(billingFromEnv({}, PLANS)).toBeNull();
    expect(billingFromEnv({ BILLING_PROVIDER: ' ' }, PLANS)).toBeNull();
  });

  it('knows only the test provider, and refuses it under production', () => {
    expect(refusal(() => billingFromEnv({ ...REQUIRED, BILLING_PROVIDER: 'stripe' }, PLANS))).toMatch(/not integrated/);
    expect(refusal(() => billingFromEnv({ ...REQUIRED, NODE_ENV: 'production' }, PLANS))).toMatch(/refused under NODE_ENV=production/);
    expect(billingFromEnv(REQUIRED, PLANS)).toMatchObject({ provider: 'test', offers: [] });
  });

  it('requires a webhook secret of at least 32 characters', () => {
    expect(refusal(() => billingFromEnv({ ...REQUIRED, BILLING_WEBHOOK_SECRET: '' }, PLANS))).toMatch(/BILLING_WEBHOOK_SECRET/);
    expect(refusal(() => billingFromEnv({ ...REQUIRED, BILLING_WEBHOOK_SECRET: 'short' }, PLANS))).toMatch(/32/);
  });

  it('has no default for the renewal leeway or the failed-payment grace — both are decisions', () => {
    for (const name of ['BILLING_RENEWAL_LEEWAY_HOURS', 'BILLING_PAST_DUE_GRACE_HOURS']) {
      const env: Record<string, string> = { ...REQUIRED };
      delete env[name];
      expect(refusal(() => billingFromEnv(env, PLANS))).toMatch(new RegExp(`${name} is required.*no default`));
      expect(refusal(() => billingFromEnv({ ...REQUIRED, [name]: '-1' }, PLANS))).toMatch(name);
      expect(refusal(() => billingFromEnv({ ...REQUIRED, [name]: '12h' }, PLANS))).toMatch(name);
    }
    expect(billingFromEnv({ ...REQUIRED, BILLING_RENEWAL_LEEWAY_HOURS: '24', BILLING_PAST_DUE_GRACE_HOURS: '72' }, PLANS)!.policy).toEqual({
      renewalLeewayHours: 24,
      pastDueGraceHours: 72,
    });
  });

  it('is part of the api configuration, and the api refuses to start on a bad one', () => {
    const base = { TERMINAL_SESSION_SECRET: 'billing-config-secret', AUTH_MODE: 'development' };
    expect(loadConfig(base as NodeJS.ProcessEnv).billing).toBeNull();
    expect(loadConfig({ ...base, ...REQUIRED } as NodeJS.ProcessEnv).billing).toMatchObject({ provider: 'test' });
    expect(() => loadConfig({ ...base, BILLING_PROVIDER: 'test' } as NodeJS.ProcessEnv)).toThrow(BillingConfigError);
  });
});

describe('offers', () => {
  const offer = { id: 'fixture-monthly', plan: 'fixture', priceRef: 'price_test_1', name: 'Monthly' };

  it('reads display fields and the plan, and never an amount', () => {
    expect(parseOffers({ offers: [{ ...offer, priceLabel: 'To be announced', interval: 'month', features: ['All tracks'] }] }, PLANS)).toEqual([
      {
        id: 'fixture-monthly',
        planId: 'fixture',
        priceRef: 'price_test_1',
        name: 'Monthly',
        description: null,
        priceLabel: 'To be announced',
        interval: 'month',
        features: ['All tracks'],
      },
    ]);
    for (const field of ['amount', 'currency', 'price', 'tax']) {
      expect(refusal(() => parseOffers({ offers: [{ ...offer, [field]: 10 }] }, PLANS))).toMatch(/unknown field/);
    }
  });

  it('refuses a plan that is not configured, a shared price and a bad reference', () => {
    expect(refusal(() => parseOffers({ offers: [{ ...offer, plan: 'gold' }] }, PLANS))).toMatch(/plan must be a plan/);
    expect(parseOffers({ offers: [{ ...offer, plan: null }] }, PLANS)[0]!.planId).toBeNull();
    expect(refusal(() => parseOffers({ offers: [offer, { ...offer, id: 'other' }] }, PLANS))).toMatch(/used by two offers/);
    expect(refusal(() => parseOffers({ offers: [{ ...offer, priceRef: 'has space' }] }, PLANS))).toMatch(/priceRef/);
    expect(refusal(() => parseOffers({ offers: [{ ...offer, interval: 'week' }] }, PLANS))).toMatch(/interval/);
  });
});

describe('from provider state to product state', () => {
  const START = '2026-10-01T00:00:00.000Z';
  const END = '2026-10-31T00:00:00.000Z';
  const sub = (status: StoredSubscription['status'], cancelAtPeriodEnd = false): StoredSubscription => ({
    provider: 'test',
    subscriptionRef: 'sub_1',
    userId: 'usr-00000001',
    customerRef: 'cus_1',
    priceRef: 'price_1',
    planId: 'fixture',
    status,
    currentPeriodStart: START,
    currentPeriodEnd: END,
    cancelAtPeriodEnd,
    endedAt: null,
    providerStateAt: START,
    updatedAt: START,
  });

  it('maps every provider status to a product status, never passing one through', () => {
    const seen = new Set<string>();
    for (const status of SUBSCRIPTION_STATUSES) {
      const mapped = commercialStatus(sub(status));
      expect(COMMERCIAL_STATUSES).toContain(mapped);
      seen.add(mapped);
    }
    expect(commercialStatus(null)).toBe('NONE');
    expect(commercialStatus(sub('active', true))).toBe('CANCELING');
    expect(commercialStatus(sub('past_due'))).toBe('PAYMENT_PROBLEM');
    expect(commercialStatus(sub('canceled'))).toBe('ENDED');
    expect(seen.has('past_due')).toBe(false);
  });

  it('entitles through the period plus leeway when renewing, exactly the period when canceling, the grace when past due', () => {
    const policy = { renewalLeewayHours: 24, pastDueGraceHours: 48 };
    expect(entitlementFor(sub('active'), policy)).toEqual({
      active: true,
      startsAt: START,
      expiresAt: '2026-11-01T00:00:00.000Z',
      kind: 'SUBSCRIPTION',
      planId: 'fixture',
    });
    expect(entitlementFor(sub('active', true), policy).expiresAt).toBe(END);
    expect(entitlementFor(sub('trialing'), policy)).toMatchObject({ active: true, kind: 'TRIAL' });
    expect(entitlementFor(sub('past_due'), policy)).toMatchObject({ active: true, expiresAt: '2026-10-03T00:00:00.000Z' });
    expect(entitlementFor(sub('past_due'), { ...policy, pastDueGraceHours: 0 }).active).toBe(false);
    for (const status of ['unpaid', 'incomplete', 'incomplete_expired', 'paused', 'canceled'] as const) {
      expect(entitlementFor(sub(status), policy).active, status).toBe(false);
    }
  });

  it('the account is entitled by its longest-running subscription, or closed by its latest', () => {
    const policy = { renewalLeewayHours: 0, pastDueGraceHours: 0 };
    expect(desiredEntitlement([], policy)).toBeNull();
    const later = { ...sub('active'), subscriptionRef: 'sub_2', currentPeriodEnd: '2026-12-01T00:00:00.000Z' };
    expect(desiredEntitlement([sub('active'), later], policy)!.expiresAt).toBe('2026-12-01T00:00:00.000Z');
    expect(desiredEntitlement([sub('canceled'), later], policy)!.active).toBe(true);
    expect(desiredEntitlement([sub('canceled')], policy)!.active).toBe(false);
  });
});
