/**
 * What a signed-in student can do about billing, and what the operator socket
 * asks of it — docs/billing.md §2.
 *
 * Every method takes the account from the caller's authenticated identity.
 * None accepts a customer, subscription or price reference from outside:
 * those are looked up here, for that account, or they do not exist.
 */
import type { BillingMetrics, Logger } from '@jumptotech/observability';

import { evaluateAccount, type AccessStore } from '../access/entitlements.js';
import type { PlanCatalog } from '../access/plans.js';
import type { BillingPolicy } from './config.js';
import {
  commercialStatus,
  desiredEntitlement,
  entitlementFor,
  primarySubscription,
  type CommercialStatus,
  type StoredSubscription,
} from './lifecycle.js';
import type { BillingProcessor } from './processor.js';
import type { BillingStore } from './store.js';
import { TestBillingProvider, type SignedWebhook } from './test-provider.js';
import { BillingError, type BillingProvider, type Offer, type SubscriptionSnapshot } from './types.js';

/** How many checkouts one account may start per hour — each is a provider object and a row. */
export const MAX_CHECKOUTS_PER_HOUR = 5;

export interface OfferView {
  id: string;
  name: string;
  description: string | null;
  priceLabel: string | null;
  interval: 'month' | 'year' | null;
  features: string[];
  plan: { id: string; name: string; tracks: 'all' | string[] } | null;
}

export interface AccountBillingView {
  enabled: true;
  mode: 'test';
  offers: OfferView[];
  subscription: {
    status: CommercialStatus;
    planId: string | null;
    planName: string | null;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    /** Until when the subscription entitles lab use; null when it does not. */
    accessUntil: string | null;
  } | null;
  /** The account has a provider customer, so the provider's portal can be opened. */
  canManageBilling: boolean;
  /** A checkout may be started: offers exist, nothing already entitles, the account is not suspended. */
  canSubscribe: boolean;
}

/** One disagreement reconciliation found. Ids and product terms only. */
export interface Drift {
  subscriptionRef: string;
  userId: string;
  /** What disagrees: a field of the subscription, the provider not knowing it, or billing's entitlement row. */
  field: 'status' | 'period' | 'cancelAtPeriodEnd' | 'endedAt' | 'price' | 'plan' | 'missing_at_provider' | 'entitlement';
  stored: string;
  provider: string;
}

export interface ReconcileReport {
  provider: string;
  checked: number;
  drift: Drift[];
  /** With --apply: what re-processing each drifted subscription did. */
  applied: Array<{ subscriptionRef: string; outcome: string }>;
  /** Drift reconciliation cannot fix by itself — the provider does not know the subscription. */
  manual: Drift[];
}

/** At most this many subscriptions per reconciliation run: a bounded, repeatable job. */
export const RECONCILE_LIMIT = 1000;

export type TestAction = 'renew' | 'fail-renewal' | 'recover' | 'cancel-at-period-end' | 'resume' | 'cancel-now';
export const TEST_ACTIONS: readonly TestAction[] = ['renew', 'fail-renewal', 'recover', 'cancel-at-period-end', 'resume', 'cancel-now'];

export interface BillingServiceDeps {
  provider: BillingProvider;
  store: BillingStore;
  processor: BillingProcessor;
  access: AccessStore;
  offers: readonly Offer[];
  plans: PlanCatalog;
  policy: BillingPolicy;
  /** Where the provider sends the browser back: the public origin of the web app. */
  appUrl: string;
  now?: () => number;
  logger?: Logger;
  metrics?: BillingMetrics;
}

export class BillingService {
  readonly #d: BillingServiceDeps;
  readonly #now: () => number;

  constructor(deps: BillingServiceDeps) {
    this.#d = deps;
    this.#now = deps.now ?? (() => Date.now());
  }

  get provider(): BillingProvider {
    return this.#d.provider;
  }

  get testMode(): TestBillingProvider | null {
    return this.#d.provider instanceof TestBillingProvider ? this.#d.provider : null;
  }

  offerViews(): OfferView[] {
    return this.#d.offers.map((offer) => {
      const plan = offer.planId ? this.#d.plans.get(offer.planId) : undefined;
      return {
        id: offer.id,
        name: offer.name,
        description: offer.description,
        priceLabel: offer.priceLabel,
        interval: offer.interval,
        features: [...offer.features],
        plan: plan ? { id: plan.id, name: plan.name, tracks: plan.tracks === 'all' ? 'all' : [...plan.tracks] } : null,
      };
    });
  }

  async view(userId: string): Promise<AccountBillingView> {
    const subscriptions = await this.#d.store.subscriptionsOf(userId);
    const primary = primarySubscription(subscriptions, this.#d.policy);
    const nowMs = this.#now();
    let subscription: AccountBillingView['subscription'] = null;
    let entitled = false;
    if (primary) {
      const request = entitlementFor(primary, this.#d.policy);
      const covers = request.active && Date.parse(request.expiresAt) > nowMs;
      entitled = covers;
      subscription = {
        status: commercialStatus(primary),
        planId: primary.planId,
        planName: primary.planId ? (this.#d.plans.get(primary.planId)?.name ?? null) : null,
        currentPeriodEnd: primary.currentPeriodEnd,
        cancelAtPeriodEnd: primary.cancelAtPeriodEnd,
        accessUntil: covers ? request.expiresAt : null,
      };
    }
    const suspended = evaluateAccount(await this.#d.access.grants(userId), nowMs).state === 'SUSPENDED';
    return {
      enabled: true,
      mode: this.#d.provider.mode,
      offers: this.offerViews(),
      subscription,
      canManageBilling: (await this.#d.store.customerOf(this.#d.provider.id, userId)) !== null,
      canSubscribe: this.#d.offers.length > 0 && !entitled && !suspended,
    };
  }

  /**
   * Start a checkout for this account and this offer. The provider's hosted
   * page takes payment; only its webhook will change access.
   */
  async startCheckout(userId: string, offerId: unknown): Promise<{ url: string }> {
    const offer = typeof offerId === 'string' ? this.#d.offers.find((candidate) => candidate.id === offerId) : undefined;
    if (!offer) throw new BillingError('OFFER_NOT_FOUND', 'That offer does not exist.');
    const view = await this.view(userId);
    if (evaluateAccount(await this.#d.access.grants(userId), this.#now()).state === 'SUSPENDED') {
      // Charging an account that cannot use what it pays for helps nobody.
      throw new BillingError('ACCOUNT_SUSPENDED', 'This account’s lab access is paused, so a subscription cannot be started.');
    }
    if (view.subscription?.accessUntil) {
      throw new BillingError(
        'ALREADY_SUBSCRIBED',
        'This account already has an active subscription. Change or cancel it through “Manage billing”.',
      );
    }
    const since = new Date(this.#now() - 3_600_000).toISOString();
    if ((await this.#d.store.countCheckoutsSince(this.#d.provider.id, userId, since)) >= MAX_CHECKOUTS_PER_HOUR) {
      throw new BillingError('TOO_MANY_CHECKOUTS', 'Too many checkouts were started for this account in the last hour. Try again later.');
    }

    // A returning customer checks out as the same provider customer.
    const customerRef = await this.#d.store.customerOf(this.#d.provider.id, userId);
    const created = await this.#call('checkout', () =>
      this.#d.provider.createCheckout({
        userId,
        offer,
        customerRef,
        successUrl: `${this.#d.appUrl}/#/account?checkout=returned`,
        cancelUrl: `${this.#d.appUrl}/#/account?checkout=canceled`,
      }),
    );
    await this.#d.store.recordCheckout({
      provider: this.#d.provider.id,
      checkoutRef: created.checkoutRef,
      userId,
      offerId: offer.id,
      createdAt: new Date(this.#now()).toISOString(),
    });
    this.#d.logger?.info(
      'billing.checkout_created',
      { provider: this.#d.provider.id, userId, op: offer.id },
      `checkout started for offer ${offer.id}`,
    );
    return { url: created.url };
  }

  /** The provider's own page for payment methods, invoices and cancellation. */
  async openPortal(userId: string): Promise<{ url: string }> {
    const customerRef = await this.#d.store.customerOf(this.#d.provider.id, userId);
    if (!customerRef) throw new BillingError('NO_BILLING_ACCOUNT', 'This account has no billing account yet.');
    return this.#call('portal', () =>
      this.#d.provider.createPortal({ customerRef, returnUrl: `${this.#d.appUrl}/#/account` }),
    );
  }

  async #call<T>(op: 'checkout' | 'portal' | 'subscription', work: () => Promise<T>): Promise<T> {
    const provider = this.#d.provider.id;
    try {
      const result = await work();
      this.#d.metrics?.providerRequests.inc({ provider, op, outcome: 'ok' });
      return result;
    } catch (error) {
      this.#d.metrics?.providerRequests.inc({ provider, op, outcome: 'failed' });
      this.#d.logger?.error('billing.provider_failed', { provider, op, err: error }, `billing provider ${op} failed`);
      if (error instanceof BillingError && error.code !== 'PROVIDER_UNAVAILABLE') throw error;
      throw new BillingError('PROVIDER_UNAVAILABLE', 'The billing provider could not be reached. Try again shortly.');
    }
  }

  // --- the operator's view (docs/billing.md §4) ------------------------------------

  /** One account's billing, as support needs it: references, product states, recent events. */
  async operatorShow(userId: string) {
    const subscriptions = await this.#d.store.subscriptionsOf(userId);
    const refs = new Set(subscriptions.map((s) => s.subscriptionRef));
    const events = (await this.#d.store.recentEvents(this.#d.provider.id, 500)).filter(
      (event) => event.subscriptionRef !== null && refs.has(event.subscriptionRef),
    );
    const grants = await this.#d.access.grants(userId);
    return {
      provider: this.#d.provider.id,
      mode: this.#d.provider.mode,
      userId,
      customerRef: await this.#d.store.customerOf(this.#d.provider.id, userId),
      account: await this.view(userId),
      billingEntitlement: grants.find((grant) => grant.grantedVia === 'billing') ?? null,
      subscriptions: subscriptions.map((s) => ({ ...s, productStatus: commercialStatus(s) })),
      recentEvents: events.slice(0, 20),
    };
  }

  /** Every stored subscription, newest first, in product terms. */
  async operatorList(limit = 200) {
    const subscriptions = await this.#d.store.subscriptions(this.#d.provider.id, limit);
    return subscriptions.map((s) => ({
      subscriptionRef: s.subscriptionRef,
      userId: s.userId,
      productStatus: commercialStatus(s),
      planId: s.planId,
      currentPeriodEnd: s.currentPeriodEnd,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      updatedAt: s.updatedAt,
    }));
  }

  /**
   * Compare what this platform stored with what the provider says now, and
   * billing's entitlement rows with what their subscriptions imply.
   *
   * Report-only by default. With `apply`, each drifted subscription is
   * re-processed from the provider's current state through the webhook
   * processor — the same verification-free-but-otherwise-identical path: the
   * same ownership rules, ordering, transaction and audit record. Nothing is
   * written by hand, and a subscription the provider no longer knows is only
   * reported: whether that means "refunded and deleted" or "a bug" is a
   * person's call.
   */
  async reconcile(options: { apply: boolean }): Promise<ReconcileReport> {
    const provider = this.#d.provider;
    const stored = await this.#d.store.subscriptions(provider.id, RECONCILE_LIMIT);
    const drift: Drift[] = [];
    const manual: Drift[] = [];
    const toApply = new Map<string, SubscriptionSnapshot>();

    for (const s of stored) {
      const current = await this.#call('subscription', () => provider.getSubscription(s.subscriptionRef));
      if (!current) {
        const item: Drift = { subscriptionRef: s.subscriptionRef, userId: s.userId, field: 'missing_at_provider', stored: s.status, provider: 'absent' };
        drift.push(item);
        manual.push(item);
        continue;
      }
      const found = compareSubscription(s, current, this.#d.offers);
      drift.push(...found);
      if (found.length > 0) toApply.set(s.subscriptionRef, current);
    }

    // Billing's row against what the account's subscriptions imply now —
    // catches a change of offer→plan mapping or of the configured leeway/grace.
    const users = [...new Set(stored.map((s) => s.userId))];
    for (const userId of users) {
      const subscriptions = stored.filter((s) => s.userId === userId);
      const desired = desiredEntitlement(subscriptions, this.#d.policy);
      const row = (await this.#d.access.grants(userId)).find((grant) => grant.grantedVia === 'billing') ?? null;
      if (!desired || !row) continue;
      const nowMs = this.#now();
      const rowActive = row.status === 'ACTIVE' && (row.expiresAt === null || Date.parse(row.expiresAt) > nowMs);
      const desiredActive = desired.active && Date.parse(desired.expiresAt) > nowMs;
      const differs =
        rowActive !== desiredActive ||
        (desiredActive && (row.expiresAt !== desired.expiresAt || row.planId !== desired.planId || row.kind !== desired.kind));
      if (differs && row.status !== 'SUSPENDED') {
        const primary = primarySubscription(subscriptions, this.#d.policy)!;
        drift.push({
          subscriptionRef: primary.subscriptionRef,
          userId,
          field: 'entitlement',
          stored: `${row.status} ${row.kind}/${row.planId ?? '-'} until ${row.expiresAt ?? 'no end'}`,
          provider: `${desiredActive ? 'ACTIVE' : 'ended'} ${desired.kind}/${desired.planId ?? '-'} until ${desired.expiresAt}`,
        });
        if (!toApply.has(primary.subscriptionRef)) {
          const current = await this.#call('subscription', () => provider.getSubscription(primary.subscriptionRef));
          if (current) toApply.set(primary.subscriptionRef, current);
        }
      }
    }

    const applied: ReconcileReport['applied'] = [];
    if (options.apply) {
      for (const [ref, snapshot] of toApply) {
        const at = new Date(this.#now()).toISOString();
        const result = await this.#d.processor.process({
          kind: 'subscription',
          eventId: `reconcile-${ref}-${this.#now()}`.slice(0, 255),
          eventType: 'reconcile.subscription',
          occurredAt: at,
          subscription: snapshot,
        });
        applied.push({ subscriptionRef: ref, outcome: result.outcome });
      }
    }

    this.#d.metrics?.reconcileDrift.set({ provider: provider.id }, options.apply ? manual.length : drift.length);
    this.#d.metrics?.reconcileLastRun.set({ provider: provider.id }, Math.floor(this.#now() / 1000));
    this.#d.logger?.info(
      'billing.reconciled',
      { provider: provider.id, count: drift.length, outcome: options.apply ? 'applied' : 'report_only' },
      `billing reconciliation: ${stored.length} checked, ${drift.length} drifted, ${applied.length} re-processed, ${manual.length} need a person`,
    );
    return { provider: provider.id, checked: stored.length, drift, applied, manual };
  }

  // --- test mode only ------------------------------------------------------------

  #test(): TestBillingProvider {
    const test = this.testMode;
    if (!test) throw new BillingError('BILLING_DISABLED', 'Test-mode actions exist only with the test provider.');
    return test;
  }

  /** A test checkout, if it is this account's. */
  testCheckout(userId: string, checkoutRef: string): { offer: OfferView; status: 'open' | 'completed' } {
    const found = this.#test().checkout(checkoutRef);
    const offer = found ? this.offerViews().find((candidate) => candidate.id === found.offerId) : undefined;
    if (!found || found.userId !== userId || !offer) throw new BillingError('CHECKOUT_NOT_FOUND', 'No such checkout.');
    return { offer, status: found.status };
  }

  /**
   * "Pay" a test checkout: the simulator creates the subscription and its
   * webhooks, which are delivered to the same processor — signature and all —
   * that a real delivery reaches.
   */
  async completeTestCheckout(userId: string, checkoutRef: string): Promise<{ outcomes: string[] }> {
    this.testCheckout(userId, checkoutRef);
    return this.#deliver(this.#test().completeCheckout(checkoutRef));
  }

  /** What a customer or the provider does to this account's subscription, simulated. */
  async simulate(userId: string, action: TestAction): Promise<{ outcomes: string[] }> {
    const test = this.#test();
    const primary = primarySubscription(await this.#d.store.subscriptionsOf(userId), this.#d.policy);
    if (!primary) throw new BillingError('SUBSCRIPTION_NOT_FOUND', 'This account has no subscription.');
    const ref = primary.subscriptionRef;
    const webhook =
      action === 'renew'
        ? test.renew(ref)
        : action === 'fail-renewal'
          ? test.failRenewal(ref)
          : action === 'recover'
            ? test.recoverPayment(ref)
            : action === 'cancel-at-period-end'
              ? test.setCancelAtPeriodEnd(ref, true)
              : action === 'resume'
                ? test.setCancelAtPeriodEnd(ref, false)
                : test.cancelNow(ref);
    return this.#deliver([webhook]);
  }

  async #deliver(webhooks: SignedWebhook[]): Promise<{ outcomes: string[] }> {
    const outcomes: string[] = [];
    for (const webhook of webhooks) {
      const reply = await this.#d.processor.handleWebhook(webhook.rawBody, webhook.headers);
      const body = reply.body as { data?: { outcome?: string } };
      outcomes.push(reply.status === 200 ? (body.data?.outcome ?? 'applied') : `error-${reply.status}`);
    }
    return { outcomes };
  }
}

/** Field by field: the stored subscription against the provider's current one. */
function compareSubscription(stored: StoredSubscription, current: SubscriptionSnapshot, offers: readonly Offer[]): Drift[] {
  const base = { subscriptionRef: stored.subscriptionRef, userId: stored.userId };
  const out: Drift[] = [];
  if (stored.status !== current.status) out.push({ ...base, field: 'status', stored: stored.status, provider: current.status });
  if (stored.currentPeriodStart !== current.currentPeriodStart || stored.currentPeriodEnd !== current.currentPeriodEnd) {
    out.push({
      ...base,
      field: 'period',
      stored: `${stored.currentPeriodStart} … ${stored.currentPeriodEnd}`,
      provider: `${current.currentPeriodStart} … ${current.currentPeriodEnd}`,
    });
  }
  if (stored.cancelAtPeriodEnd !== current.cancelAtPeriodEnd) {
    out.push({ ...base, field: 'cancelAtPeriodEnd', stored: String(stored.cancelAtPeriodEnd), provider: String(current.cancelAtPeriodEnd) });
  }
  if (stored.endedAt !== current.endedAt) {
    out.push({ ...base, field: 'endedAt', stored: stored.endedAt ?? 'none', provider: current.endedAt ?? 'none' });
  }
  if (stored.priceRef !== current.priceRef) out.push({ ...base, field: 'price', stored: stored.priceRef, provider: current.priceRef });
  const plan = offers.find((offer) => offer.priceRef === current.priceRef)?.planId ?? null;
  if (stored.priceRef === current.priceRef && stored.planId !== plan) {
    out.push({ ...base, field: 'plan', stored: stored.planId ?? 'no plan', provider: plan ?? 'no plan' });
  }
  return out;
}
