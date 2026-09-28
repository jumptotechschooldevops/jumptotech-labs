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
import { commercialStatus, entitlementFor, primarySubscription, type CommercialStatus } from './lifecycle.js';
import type { BillingProcessor } from './processor.js';
import type { BillingStore } from './store.js';
import { TestBillingProvider, type SignedWebhook } from './test-provider.js';
import { BillingError, type BillingProvider, type Offer } from './types.js';

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
