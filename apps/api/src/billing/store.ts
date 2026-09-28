/**
 * Where billing state lives — migration 010's tables — and the transaction a
 * webhook is processed in.
 *
 * `transaction` is the unit of idempotency: the event's id is claimed, the
 * subscription stored and billing's entitlement row synchronised in one
 * transaction. If any step throws, none of it happened — including the claim —
 * so the provider's retry processes the event again from the start.
 */
import type { AccessStore, MutationInput, MutationResult } from '../access/entitlements.js';
import type { StoredSubscription } from './lifecycle.js';

export type EventOutcome = 'applied' | 'stale' | 'ignored';

export interface StoredEvent {
  provider: string;
  eventId: string;
  eventType: string;
  outcome: EventOutcome;
  subscriptionRef: string | null;
  occurredAt: string;
  processedAt: string;
}

export interface StoredCheckout {
  provider: string;
  checkoutRef: string;
  userId: string;
  offerId: string;
  createdAt: string;
  completedAt: string | null;
}

/** What a webhook's processing may read and write, inside one transaction. */
export interface BillingTx {
  /** Record the event id. false: already processed — a duplicate. */
  claimEvent(event: Omit<StoredEvent, 'processedAt' | 'outcome'>, at: string): Promise<boolean>;
  setEventOutcome(provider: string, eventId: string, outcome: EventOutcome): Promise<void>;
  customerUser(provider: string, customerRef: string): Promise<string | null>;
  /** 'conflict': that customer is another account's, or this account already has another customer. */
  bindCustomer(provider: string, customerRef: string, userId: string, at: string): Promise<'bound' | 'exists' | 'conflict'>;
  checkout(provider: string, checkoutRef: string): Promise<StoredCheckout | null>;
  /** Whether this platform ever started a checkout for this account. */
  hasCheckoutFor(provider: string, userId: string): Promise<boolean>;
  completeCheckout(provider: string, checkoutRef: string, at: string): Promise<void>;
  subscription(provider: string, subscriptionRef: string): Promise<StoredSubscription | null>;
  putSubscription(subscription: StoredSubscription): Promise<void>;
  subscriptionsOf(userId: string): Promise<StoredSubscription[]>;
  /** Take the account's row lock (the one access changes queue on) for the rest of the transaction. */
  lockAccount(userId: string): Promise<void>;
  /** The access mutation, inside this transaction (billing's SYNC). */
  mutateAccess(input: MutationInput, now: () => Date): Promise<MutationResult>;
}

export interface BillingStore {
  transaction<T>(work: (tx: BillingTx) => Promise<T>): Promise<T>;
  recordCheckout(checkout: Omit<StoredCheckout, 'completedAt'>): Promise<void>;
  customerOf(provider: string, userId: string): Promise<string | null>;
  subscriptionsOf(userId: string): Promise<StoredSubscription[]>;
  /** Every subscription, newest first, bounded — reconciliation and `billing list`. */
  subscriptions(provider: string, limit: number): Promise<StoredSubscription[]>;
  recentEvents(provider: string, limit: number): Promise<StoredEvent[]>;
}

/**
 * For tests and for running without a database. The same rules as PostgreSQL:
 * one event id once, one customer per account, a transaction that leaves
 * nothing behind when it throws.
 */
export class InMemoryBillingStore implements BillingStore {
  #customers = new Map<string, { userId: string; createdAt: string }>();
  #checkouts = new Map<string, StoredCheckout>();
  #subscriptions = new Map<string, StoredSubscription>();
  #events = new Map<string, StoredEvent>();
  #chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly access: AccessStore) {}

  static #key(provider: string, ref: string): string {
    return `${provider}|${ref}`;
  }

  transaction<T>(work: (tx: BillingTx) => Promise<T>): Promise<T> {
    const run = this.#chain.then(async () => {
      // Snapshot, and put back on failure: nothing a failed webhook did survives it.
      const saved = {
        customers: new Map(this.#customers),
        checkouts: new Map([...this.#checkouts].map(([k, v]) => [k, { ...v }])),
        subscriptions: new Map([...this.#subscriptions].map(([k, v]) => [k, { ...v }])),
        events: new Map([...this.#events].map(([k, v]) => [k, { ...v }])),
      };
      try {
        return await work(this.#tx());
      } catch (error) {
        this.#customers = saved.customers;
        this.#checkouts = saved.checkouts;
        this.#subscriptions = saved.subscriptions;
        this.#events = saved.events;
        throw error;
      }
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  #tx(): BillingTx {
    const key = InMemoryBillingStore.#key;
    return {
      claimEvent: async (event, at) => {
        const k = key(event.provider, event.eventId);
        if (this.#events.has(k)) return false;
        this.#events.set(k, { ...event, outcome: 'applied', processedAt: at });
        return true;
      },
      setEventOutcome: async (provider, eventId, outcome) => {
        const found = this.#events.get(key(provider, eventId));
        if (found) found.outcome = outcome;
      },
      customerUser: async (provider, customerRef) => this.#customers.get(key(provider, customerRef))?.userId ?? null,
      bindCustomer: async (provider, customerRef, userId, at) => {
        const existing = this.#customers.get(key(provider, customerRef));
        if (existing) return existing.userId === userId ? 'exists' : 'conflict';
        const other = [...this.#customers.entries()].find(
          ([k, v]) => k.startsWith(`${provider}|`) && v.userId === userId,
        );
        if (other) return 'conflict';
        this.#customers.set(key(provider, customerRef), { userId, createdAt: at });
        return 'bound';
      },
      checkout: async (provider, checkoutRef) => {
        const found = this.#checkouts.get(key(provider, checkoutRef));
        return found ? { ...found } : null;
      },
      hasCheckoutFor: async (provider, userId) =>
        [...this.#checkouts.values()].some((c) => c.provider === provider && c.userId === userId),
      completeCheckout: async (provider, checkoutRef, at) => {
        const found = this.#checkouts.get(key(provider, checkoutRef));
        if (found && !found.completedAt) found.completedAt = at;
      },
      subscription: async (provider, ref) => {
        const found = this.#subscriptions.get(key(provider, ref));
        return found ? { ...found } : null;
      },
      putSubscription: async (subscription) => {
        this.#subscriptions.set(key(subscription.provider, subscription.subscriptionRef), { ...subscription });
      },
      subscriptionsOf: async (userId) => this.#subscriptionsOf(userId),
      // Transactions here already run one at a time.
      lockAccount: async () => undefined,
      mutateAccess: (input, now) => this.access.mutate(input, now),
    };
  }

  #subscriptionsOf(userId: string): StoredSubscription[] {
    return [...this.#subscriptions.values()].filter((s) => s.userId === userId).map((s) => ({ ...s }));
  }

  async recordCheckout(checkout: Omit<StoredCheckout, 'completedAt'>): Promise<void> {
    this.#checkouts.set(InMemoryBillingStore.#key(checkout.provider, checkout.checkoutRef), { ...checkout, completedAt: null });
  }

  async customerOf(provider: string, userId: string): Promise<string | null> {
    for (const [k, v] of this.#customers) {
      if (k.startsWith(`${provider}|`) && v.userId === userId) return k.slice(provider.length + 1);
    }
    return null;
  }

  async subscriptionsOf(userId: string): Promise<StoredSubscription[]> {
    return this.#subscriptionsOf(userId);
  }

  async subscriptions(provider: string, limit: number): Promise<StoredSubscription[]> {
    return [...this.#subscriptions.values()]
      .filter((s) => s.provider === provider)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, limit)
      .map((s) => ({ ...s }));
  }

  async recentEvents(provider: string, limit: number): Promise<StoredEvent[]> {
    return [...this.#events.values()]
      .filter((e) => e.provider === provider)
      .sort((a, b) => Date.parse(b.processedAt) - Date.parse(a.processedAt))
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }
}
