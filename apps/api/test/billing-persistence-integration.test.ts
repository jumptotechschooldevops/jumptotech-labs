/**
 * Billing against a real PostgreSQL — migration 010, `PostgresBillingStore`,
 * and the entitlement change a webhook makes in the same transaction.
 *
 * The in-memory store proves the rules (`billing-webhooks.test.ts`); this
 * proves the SQL keeps them where it matters: two deliveries of one event on
 * two connections apply once; a failed processing leaves no row at all; an
 * older state never lands over a newer one; operator and billing rows coexist
 * under the widened key; and the schema itself refuses what the application
 * would never write — a customer on two accounts, an operator row calling
 * itself a subscription.
 *
 * Named `*-integration` and gated on `RUN_DB_TESTS`, per `test-support/README.md`.
 *
 *   make test-db TEST_DB_PORT=55463
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresDatabase, migrate } from '@jumptotech/progress';

import { PostgresUserRepository } from '../src/auth/users.js';
import { PostgresAccessStore } from '../src/access/postgres-store.js';
import { AccessControl } from '../src/access/entitlements.js';
import { parsePlans } from '../src/access/plans.js';
import { BillingProcessor } from '../src/billing/processor.js';
import { PostgresBillingStore } from '../src/billing/postgres-store.js';
import { TestBillingProvider, type SignedWebhook } from '../src/billing/test-provider.js';
import type { Offer } from '../src/billing/types.js';

const url = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === '1' && typeof url === 'string' && url.length > 0;

const PLANS = parsePlans({ plans: [{ id: 'fixture-all', name: 'Everything', tracks: 'all' }] });
const OFFER: Offer = {
  id: 'fixture-monthly',
  planId: 'fixture-all',
  priceRef: 'price_test_monthly',
  name: 'Fixture',
  description: null,
  priceLabel: null,
  interval: 'month',
  features: [],
};
const DAY = 86_400_000;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.log('[billing-persistence] skipped — set RUN_DB_TESTS=1 and TEST_DATABASE_URL to run against a real database');
  describe.skip('billing against PostgreSQL', () => {
    it('needs RUN_DB_TESTS=1 and TEST_DATABASE_URL', () => undefined);
  });
} else {
  const pools: PostgresDatabase[] = [];
  function connect(): PostgresDatabase {
    const pool = PostgresDatabase.fromConfig({
      url: url!,
      ssl: false,
      maxConnections: 4,
      connectionTimeoutMs: 10_000,
      idleTimeoutMs: 5_000,
      statementTimeoutMs: 30_000,
      applicationName: 'jumptotech-billing-persistence-tests',
    });
    pools.push(pool);
    return pool;
  }

  let db: PostgresDatabase;
  beforeAll(async () => {
    db = connect();
    await migrate(db);
  });
  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.close().catch(() => undefined)));
  });
  beforeEach(async () => {
    await db.query(
      'TRUNCATE billing_events, billing_subscriptions, billing_checkouts, billing_customers, access_events, access_entitlements, users, lab_sessions, hint_usage, lab_attempts, lab_progress, students RESTART IDENTITY CASCADE',
    );
  });

  const clock = { now: Date.parse('2026-10-01T12:00:00.000Z') };
  const provider = new TestBillingProvider({
    webhookSecret: 'whsec-integration-0123456789abcdef0123456789',
    appUrl: 'http://localhost:3000',
    now: () => clock.now,
  });

  function stack(pool: PostgresDatabase = db, offers: Offer[] = [OFFER]) {
    const access = new PostgresAccessStore(pool);
    const store = new PostgresBillingStore(pool, access);
    const processor = new BillingProcessor({
      provider,
      store,
      offers,
      plans: PLANS,
      policy: { renewalLeewayHours: 0, pastDueGraceHours: 0 },
      now: () => clock.now,
    });
    return { access, store, processor };
  }

  async function student(subject: string) {
    return new PostgresUserRepository(db).upsert({ issuer: 'https://issuer.example.com/', subject, email: `${subject}@example.com` });
  }

  async function checkout(subject: string) {
    const { userId } = await student(subject);
    const { store } = stack();
    const created = await provider.createCheckout({ userId, offer: OFFER, customerRef: null, successUrl: 'x', cancelUrl: 'y' });
    await store.recordCheckout({
      provider: 'test',
      checkoutRef: created.checkoutRef,
      userId,
      offerId: OFFER.id,
      createdAt: new Date(clock.now).toISOString(),
    });
    return { userId, checkoutRef: created.checkoutRef };
  }

  const deliver = (processor: BillingProcessor, webhook: SignedWebhook) =>
    processor.handleWebhook(webhook.rawBody, provider.signatureHeaders(webhook.rawBody));

  describe('billing against PostgreSQL', () => {
    it('applies a subscription and its entitlement in one transaction, and a new process decides from it', async () => {
      const { processor } = stack();
      const { userId, checkoutRef } = await checkout('alice');
      for (const webhook of provider.completeCheckout(checkoutRef)) {
        expect((await deliver(processor, webhook)).status).toBe(200);
      }
      const fresh = stack(connect());
      const [sub] = await fresh.store.subscriptionsOf(userId);
      expect(sub).toMatchObject({ status: 'active', planId: 'fixture-all', userId });
      expect(await fresh.access.grants(userId)).toEqual([
        expect.objectContaining({ grantedVia: 'billing', kind: 'SUBSCRIPTION', status: 'ACTIVE', expiresAt: sub!.currentPeriodEnd }),
      ]);
      const decision = await new AccessControl(fresh.access, 'entitlement', () => new Date(clock.now), { plans: PLANS }).decide(userId);
      expect(decision).toMatchObject({ allowed: true, plan: { id: 'fixture-all' } });
      const [event] = await fresh.access.events(userId, 1);
      expect(event).toMatchObject({ source: 'billing', action: 'SYNC', actor: 'billing.test' });
    });

    it('two deliveries of one event on two connections apply exactly once', async () => {
      const a = stack(connect());
      const b = stack(connect());
      const { userId, checkoutRef } = await checkout('bob');
      const [completed, created] = provider.completeCheckout(checkoutRef);
      await deliver(a.processor, completed!);
      const replies = await Promise.all([deliver(a.processor, created!), deliver(b.processor, created!)]);
      const outcomes = replies.map((r) => (r.body as { data: { outcome: string } }).data.outcome).sort();
      expect(outcomes).toEqual(['applied', 'duplicate']);
      expect(await a.access.events(userId, 10)).toHaveLength(1);
      const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM billing_events');
      expect(Number(rows[0]!.n)).toBe(2);
    });

    it('a failed processing leaves no row, and the retry after the fix applies it', async () => {
      const { userId, checkoutRef } = await checkout('cara');
      const [completed, created] = provider.completeCheckout(checkoutRef);
      const misconfigured = stack(db, []); // no offer names the price
      await deliver(misconfigured.processor, completed!);
      expect((await deliver(misconfigured.processor, created!)).status).toBe(500);
      const { rows } = await db.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM billing_subscriptions) + (SELECT count(*) FROM access_entitlements) AS n`,
      );
      expect(Number(rows[0]!.n)).toBe(0);
      const claimed = await db.query('SELECT 1 FROM billing_events WHERE event_id = $1', [created!.eventId]);
      expect(claimed.rows).toHaveLength(0);

      const fixed = stack();
      expect(((await deliver(fixed.processor, created!)).body as { data: { outcome: string } }).data.outcome).toBe('applied');
      expect(await fixed.access.grants(userId)).toHaveLength(1);
    });

    it('an older state never overwrites a newer one, even delivered last', async () => {
      const { processor, store } = stack();
      const { userId, checkoutRef } = await checkout('dan');
      const [completed, created] = provider.completeCheckout(checkoutRef);
      const subRef = JSON.parse(created!.rawBody.toString()).data.subscription.id as string;
      clock.now += 30 * DAY;
      const renewed = provider.renew(subRef);
      await deliver(processor, completed!);
      await deliver(processor, renewed);
      expect(((await deliver(processor, created!)).body as { data: { outcome: string } }).data.outcome).toBe('stale');
      const [sub] = await store.subscriptionsOf(userId);
      expect(Date.parse(sub!.currentPeriodEnd)).toBe(clock.now + 30 * DAY);
      clock.now -= 30 * DAY;
    });

    it('keeps an operator row and a billing row side by side; suspension holds across both', async () => {
      const { processor, access } = stack();
      const { userId, checkoutRef } = await checkout('eve');
      await access.mutate({ userId, action: 'GRANT', actor: 'ops', reason: 'beta', grant: { expiresAt: null, kind: 'BETA' } }, () => new Date(clock.now));
      for (const webhook of provider.completeCheckout(checkoutRef)) await deliver(processor, webhook);
      expect((await access.grants(userId)).map((g) => g.grantedVia)).toEqual(['billing', 'operator']);
      await access.mutate({ userId, action: 'SUSPEND', actor: 'ops', reason: 'x' }, () => new Date(clock.now));
      expect((await access.grants(userId)).every((g) => g.status === 'SUSPENDED')).toBe(true);
      const shown = await access.findAccounts({ userId });
      expect(shown[0]!.grants).toHaveLength(2);
      expect(shown[0]!.entitlement).toMatchObject({ grantedVia: 'operator', kind: 'BETA' });
    });

    it('refuses in the schema what the application never writes', async () => {
      const a = await student('fay');
      const b = await student('gil');
      await db.query(`INSERT INTO billing_customers (provider, customer_ref, user_id) VALUES ('test', 'cus_1', $1)`, [a.userId]);
      // One customer, one account.
      await expect(
        db.query(`INSERT INTO billing_customers (provider, customer_ref, user_id) VALUES ('test', 'cus_1', $1)`, [b.userId]),
      ).rejects.toThrow(/duplicate key/);
      // One customer per account per provider.
      await expect(
        db.query(`INSERT INTO billing_customers (provider, customer_ref, user_id) VALUES ('test', 'cus_2', $1)`, [a.userId]),
      ).rejects.toThrow(/billing_customers_one_per_user/);
      // An operator row cannot claim to be a subscription, nor billing a beta.
      const row = (via: string, kind: string) =>
        db.query(
          `INSERT INTO access_entitlements (user_id, scope, status, starts_at, granted_via, kind) VALUES ($1, 'platform', 'ACTIVE', now(), $2, $3)`,
          [a.userId, via, kind],
        );
      await expect(row('operator', 'SUBSCRIPTION')).rejects.toThrow(/access_entitlements_kind_by_source/);
      await expect(row('billing', 'BETA')).rejects.toThrow(/access_entitlements_kind_by_source/);
      await expect(row('stripe', 'SUBSCRIPTION')).rejects.toThrow(/access_entitlements_granted_via/);
      await row('operator', 'STANDARD');
      await row('billing', 'SUBSCRIPTION');
      await expect(row('billing', 'SUBSCRIPTION')).rejects.toThrow(/duplicate key/);
      // A period that ends before it starts.
      await expect(
        db.query(
          `INSERT INTO billing_subscriptions (provider, subscription_ref, user_id, customer_ref, price_ref, status,
                                              current_period_start, current_period_end, cancel_at_period_end, provider_state_at)
                VALUES ('test', 'sub_x', $1, 'cus_1', 'p', 'active', now(), now() - interval '1 day', false, now())`,
          [a.userId],
        ),
      ).rejects.toThrow(/billing_subscriptions_period/);
    });

    it('has no column that could hold payment details', async () => {
      const { rows } = await db.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name LIKE 'billing_%'`,
      );
      expect(rows.length).toBeGreaterThan(20);
      for (const { table_name, column_name } of rows) {
        expect(`${table_name}.${column_name}`).not.toMatch(/card|cvv|cvc|pan|iban|account_number|expiry|payment_method|address|payload/);
      }
    });
  });
}
