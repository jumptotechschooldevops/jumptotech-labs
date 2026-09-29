/**
 * The billing-provider boundary — docs/billing.md.
 *
 * Everything outside `billing/` sees a provider only through this interface,
 * and sees provider state only in the provider-neutral shapes below. A real
 * provider (Stripe, Paddle, …) is one more implementation of `BillingProvider`;
 * nothing else changes. Which provider — if any — is a business decision, so
 * the only implementation today is `test-provider.ts`, an in-process simulator
 * that never talks to a network and can never move money.
 *
 * ```text
 *   browser ──Start checkout──► api ──createCheckout──► provider (hosted page)
 *                                                            │ card details go here, never to us
 *   provider ──signed webhook──► api: verify → dedupe → order → apply
 *                                                            │ one transaction
 *                                  billing_subscriptions + access_entitlements(billing)
 *                                                            │
 *                                  AccessControl.decide — unchanged, on every lab use
 * ```
 *
 * Returning to a `success` URL grants nothing. Only a verified provider event
 * changes access.
 */

/**
 * A subscription's status, normalised. These are the states subscription
 * providers commonly report; a provider adapter maps its own onto them and
 * refuses what it cannot map.
 */
export const SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'paused',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** A subscription as the provider reports it. Every reference is opaque. */
export interface SubscriptionSnapshot {
  subscriptionRef: string;
  customerRef: string;
  priceRef: string;
  status: SubscriptionStatus;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  /** The holder asked to cancel when the period ends; access continues until then. */
  cancelAtPeriodEnd: boolean;
  endedAt: string | null;
  /**
   * The internal user id this platform attached when it created the checkout,
   * as the provider echoes it back. A hint only: it is trusted only together
   * with a checkout this platform recorded for that same account.
   */
  clientReference: string | null;
}

interface EventBase {
  /** The provider's own event id — the idempotency key. */
  eventId: string;
  /** The provider's event type, for the record. */
  eventType: string;
  /** When the provider produced this event: the ordering key. */
  occurredAt: string;
  /**
   * Set only by `ops billing reconcile --apply`: the operator who asked for
   * this re-processing and why. The access history records them, not the
   * provider.
   */
  requestedBy?: { actor: string; reason: string };
}

/** A verified provider event, in the platform's terms. */
export type BillingEvent =
  | (EventBase & {
      kind: 'checkout.completed';
      checkoutRef: string;
      customerRef: string;
      clientReference: string | null;
    })
  | (EventBase & { kind: 'subscription'; subscription: SubscriptionSnapshot })
  | (EventBase & { kind: 'ignored' });

/** A purchasable offer: a provider price, the plan it entitles, and how it is shown. */
export interface Offer {
  id: string;
  /** A plan id from ACCESS_PLANS_JSON, or null for "no plan" (every track). */
  planId: string | null;
  /** The provider's price reference. Server-side only: never sent to a browser, never taken from one. */
  priceRef: string;
  name: string;
  description: string | null;
  /** Display only, exactly as configured ("Price to be announced"). The provider's price is what is charged. */
  priceLabel: string | null;
  /** Display only. */
  interval: 'month' | 'year' | null;
  features: string[];
}

export interface CheckoutRequest {
  userId: string;
  offer: Offer;
  /** The account's existing provider customer, if it has one. */
  customerRef: string | null;
  successUrl: string;
  cancelUrl: string;
}

export interface BillingProvider {
  /** Stored with every reference: `test`. */
  readonly id: string;
  /** Only `test` exists. A live mode is a deliberate, reviewed change (docs/billing.md §9). */
  readonly mode: 'test';
  createCheckout(request: CheckoutRequest): Promise<{ checkoutRef: string; url: string }>;
  /** A provider-hosted page where the holder manages payment methods and cancellation. */
  createPortal(request: { customerRef: string; returnUrl: string }): Promise<{ url: string }>;
  /** The provider's current view of a subscription, for reconciliation. null: the provider does not know it. */
  getSubscription(subscriptionRef: string): Promise<SubscriptionSnapshot | null>;
  /**
   * Verify a webhook's signature over the raw bytes and parse it. Throws
   * `BillingWebhookError` for anything not provably from the provider or not
   * understood.
   */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, nowMs: number): BillingEvent;
}

export class BillingWebhookError extends Error {
  constructor(
    readonly code: 'SIGNATURE_MISSING' | 'SIGNATURE_INVALID' | 'TIMESTAMP_OUT_OF_TOLERANCE' | 'MALFORMED',
    message: string,
  ) {
    super(message);
    this.name = 'BillingWebhookError';
  }
}

export class BillingError extends Error {
  constructor(
    readonly code:
      | 'BILLING_DISABLED'
      | 'OFFER_NOT_FOUND'
      | 'ALREADY_SUBSCRIBED'
      | 'NO_BILLING_ACCOUNT'
      | 'CHECKOUT_NOT_FOUND'
      | 'SUBSCRIPTION_NOT_FOUND'
      | 'PROVIDER_UNAVAILABLE'
      | 'UNMAPPED_PRICE'
      | 'UNMAPPED_SUBSCRIPTION'
      | 'OWNERSHIP_CONFLICT'
      | 'ACCOUNT_SUSPENDED'
      | 'TOO_MANY_CHECKOUTS'
      | 'INVALID_REQUEST',
    message: string,
  ) {
    super(message);
    this.name = 'BillingError';
  }
}

/** Opaque provider references: printable, no whitespace, bounded. */
const REF_SHAPE = /^[A-Za-z0-9_\-.:]{1,255}$/;

export function isRef(value: unknown): value is string {
  return typeof value === 'string' && REF_SHAPE.test(value);
}
