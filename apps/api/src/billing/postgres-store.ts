/**
 * Billing state in PostgreSQL — migration 010.
 *
 * A webhook's processing is one transaction (`transaction`): the event id is
 * claimed with `INSERT … ON CONFLICT DO NOTHING`, so of two deliveries of one
 * event racing, exactly one inserts and the other sees a duplicate once the
 * first commits; the entitlement change runs through
 * `PostgresAccessStore.mutateWithin` on the same connection, under the same
 * user row lock every operator change takes.
 */
import type { AccessDatabase, AccessSqlExecutor, PostgresAccessStore } from '../access/postgres-store.js';
import type { StoredSubscription } from './lifecycle.js';
import type { BillingStore, BillingTx, EventOutcome, StoredCheckout, StoredEvent } from './store.js';
import type { SubscriptionStatus } from './types.js';

interface SubscriptionRow {
  provider: string;
  subscription_ref: string;
  user_id: string;
  customer_ref: string;
  price_ref: string;
  plan_id: string | null;
  status: SubscriptionStatus;
  current_period_start: Date;
  current_period_end: Date;
  cancel_at_period_end: boolean;
  ended_at: Date | null;
  provider_state_at: Date;
  updated_at: Date;
}

interface EventRow {
  provider: string;
  event_id: string;
  event_type: string;
  outcome: EventOutcome;
  subscription_ref: string | null;
  occurred_at: Date;
  processed_at: Date;
}

interface CheckoutRow {
  provider: string;
  checkout_ref: string;
  user_id: string;
  offer_id: string;
  created_at: Date;
  completed_at: Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const iso = (value: Date | string): string => new Date(value).toISOString();

function toSubscription(row: SubscriptionRow): StoredSubscription {
  return {
    provider: row.provider,
    subscriptionRef: row.subscription_ref,
    userId: row.user_id,
    customerRef: row.customer_ref,
    priceRef: row.price_ref,
    planId: row.plan_id,
    status: row.status,
    currentPeriodStart: iso(row.current_period_start),
    currentPeriodEnd: iso(row.current_period_end),
    cancelAtPeriodEnd: row.cancel_at_period_end,
    endedAt: row.ended_at === null ? null : iso(row.ended_at),
    providerStateAt: iso(row.provider_state_at),
    updatedAt: iso(row.updated_at),
  };
}

function toEvent(row: EventRow): StoredEvent {
  return {
    provider: row.provider,
    eventId: row.event_id,
    eventType: row.event_type,
    outcome: row.outcome,
    subscriptionRef: row.subscription_ref,
    occurredAt: iso(row.occurred_at),
    processedAt: iso(row.processed_at),
  };
}

const SUBSCRIPTION_COLUMNS = `provider, subscription_ref, user_id, customer_ref, price_ref, plan_id, status,
  current_period_start, current_period_end, cancel_at_period_end, ended_at, provider_state_at, updated_at`;

export class PostgresBillingStore implements BillingStore {
  constructor(
    private readonly db: AccessDatabase,
    private readonly access: PostgresAccessStore,
  ) {}

  transaction<T>(work: (tx: BillingTx) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work(this.#tx(tx)));
  }

  #tx(tx: AccessSqlExecutor): BillingTx {
    return {
      claimEvent: async (event, at) => {
        const { rows } = await tx.query<{ event_id: string }>(
          `INSERT INTO billing_events (provider, event_id, event_type, outcome, subscription_ref, occurred_at, processed_at)
                VALUES ($1, $2, $3, 'applied', $4, $5, $6)
           ON CONFLICT (provider, event_id) DO NOTHING
           RETURNING event_id`,
          [event.provider, event.eventId, event.eventType, event.subscriptionRef, event.occurredAt, at],
        );
        return rows.length === 1;
      },
      setEventOutcome: async (provider, eventId, outcome) => {
        await tx.query('UPDATE billing_events SET outcome = $3 WHERE provider = $1 AND event_id = $2', [provider, eventId, outcome]);
      },
      customerUser: async (provider, customerRef) => {
        const { rows } = await tx.query<{ user_id: string }>(
          'SELECT user_id FROM billing_customers WHERE provider = $1 AND customer_ref = $2',
          [provider, customerRef],
        );
        return rows[0]?.user_id ?? null;
      },
      bindCustomer: async (provider, customerRef, userId, at) => {
        if (!UUID.test(userId)) return 'conflict';
        const inserted = await tx.query<{ user_id: string }>(
          `INSERT INTO billing_customers (provider, customer_ref, user_id, created_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING RETURNING user_id`,
          [provider, customerRef, userId, at],
        );
        if (inserted.rows.length === 1) return 'bound';
        const { rows } = await tx.query<{ user_id: string }>(
          'SELECT user_id FROM billing_customers WHERE provider = $1 AND customer_ref = $2',
          [provider, customerRef],
        );
        // Either the customer is someone else's, or this account already has
        // a different customer (the one-per-account constraint refused it).
        return rows[0]?.user_id === userId ? 'exists' : 'conflict';
      },
      checkout: async (provider, checkoutRef) => {
        const { rows } = await tx.query<CheckoutRow>(
          'SELECT * FROM billing_checkouts WHERE provider = $1 AND checkout_ref = $2',
          [provider, checkoutRef],
        );
        const row = rows[0];
        return row
          ? {
              provider: row.provider,
              checkoutRef: row.checkout_ref,
              userId: row.user_id,
              offerId: row.offer_id,
              createdAt: iso(row.created_at),
              completedAt: row.completed_at === null ? null : iso(row.completed_at),
            }
          : null;
      },
      hasCheckoutFor: async (provider, userId) => {
        if (!UUID.test(userId)) return false;
        const { rows } = await tx.query<{ found: boolean }>(
          'SELECT EXISTS (SELECT 1 FROM billing_checkouts WHERE provider = $1 AND user_id = $2) AS found',
          [provider, userId],
        );
        return rows[0]?.found === true;
      },
      completeCheckout: async (provider, checkoutRef, at) => {
        await tx.query(
          'UPDATE billing_checkouts SET completed_at = $3 WHERE provider = $1 AND checkout_ref = $2 AND completed_at IS NULL',
          [provider, checkoutRef, at],
        );
      },
      subscription: async (provider, ref) => {
        const { rows } = await tx.query<SubscriptionRow>(
          `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing_subscriptions WHERE provider = $1 AND subscription_ref = $2`,
          [provider, ref],
        );
        return rows[0] ? toSubscription(rows[0]) : null;
      },
      putSubscription: async (s) => {
        // The WHERE is the ordering rule again, in SQL: even a caller that
        // skipped the check cannot put an older state over a newer one.
        await tx.query(
          `INSERT INTO billing_subscriptions (${SUBSCRIPTION_COLUMNS})
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (provider, subscription_ref) DO UPDATE
                 SET customer_ref = EXCLUDED.customer_ref,
                     price_ref = EXCLUDED.price_ref,
                     plan_id = EXCLUDED.plan_id,
                     status = EXCLUDED.status,
                     current_period_start = EXCLUDED.current_period_start,
                     current_period_end = EXCLUDED.current_period_end,
                     cancel_at_period_end = EXCLUDED.cancel_at_period_end,
                     ended_at = EXCLUDED.ended_at,
                     provider_state_at = EXCLUDED.provider_state_at,
                     updated_at = EXCLUDED.updated_at
               WHERE billing_subscriptions.user_id = EXCLUDED.user_id
                 AND billing_subscriptions.provider_state_at <= EXCLUDED.provider_state_at`,
          [
            s.provider,
            s.subscriptionRef,
            s.userId,
            s.customerRef,
            s.priceRef,
            s.planId,
            s.status,
            s.currentPeriodStart,
            s.currentPeriodEnd,
            s.cancelAtPeriodEnd,
            s.endedAt,
            s.providerStateAt,
            s.updatedAt,
          ],
        );
      },
      subscriptionsOf: (userId) => this.#subscriptionsOf(tx, userId),
      lockAccount: async (userId) => {
        await tx.query('SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE', [userId]);
      },
      mutateAccess: (input, now) => this.access.mutateWithin(tx, input, now),
    };
  }

  async #subscriptionsOf(executor: AccessSqlExecutor, userId: string): Promise<StoredSubscription[]> {
    if (!UUID.test(userId)) return [];
    const { rows } = await executor.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing_subscriptions WHERE user_id = $1 ORDER BY updated_at DESC`,
      [userId],
    );
    return rows.map(toSubscription);
  }

  async recordCheckout(checkout: Omit<StoredCheckout, 'completedAt'>): Promise<void> {
    await this.db.query(
      `INSERT INTO billing_checkouts (provider, checkout_ref, user_id, offer_id, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [checkout.provider, checkout.checkoutRef, checkout.userId, checkout.offerId, checkout.createdAt],
    );
  }

  async customerOf(provider: string, userId: string): Promise<string | null> {
    if (!UUID.test(userId)) return null;
    const { rows } = await this.db.query<{ customer_ref: string }>(
      'SELECT customer_ref FROM billing_customers WHERE provider = $1 AND user_id = $2',
      [provider, userId],
    );
    return rows[0]?.customer_ref ?? null;
  }

  subscriptionsOf(userId: string): Promise<StoredSubscription[]> {
    return this.#subscriptionsOf(this.db, userId);
  }

  async subscriptions(provider: string, limit: number): Promise<StoredSubscription[]> {
    const { rows } = await this.db.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing_subscriptions WHERE provider = $1 ORDER BY updated_at DESC LIMIT $2`,
      [provider, limit],
    );
    return rows.map(toSubscription);
  }

  async recentEvents(provider: string, limit: number): Promise<StoredEvent[]> {
    const { rows } = await this.db.query<EventRow>(
      'SELECT * FROM billing_events WHERE provider = $1 ORDER BY processed_at DESC, event_id DESC LIMIT $2',
      [provider, limit],
    );
    return rows.map(toEvent);
  }
}
