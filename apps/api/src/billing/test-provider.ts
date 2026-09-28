/**
 * The `test` billing provider — a deterministic, in-process simulator.
 *
 * It exists so every part of the commercial flow can be exercised, in CI and on
 * a laptop, without a real provider, a network call, a credential, a card or
 * money: checkout, the signed webhook, renewal, failed payment, cancellation at
 * the period end or at once, and reconciliation.
 *
 * It behaves like a hosted-checkout subscription provider on purpose:
 *
 *   - the platform creates a checkout and sends the browser to a URL; the
 *     "payment" happens elsewhere (here: `completeCheckout`, which only the
 *     test-mode page or a test can call);
 *   - state changes reach the platform only as signed webhooks, and the
 *     platform acts only on those — a browser arriving at a success URL grants
 *     nothing;
 *   - the signature scheme is `t=<unix seconds>,v1=<hex HMAC-SHA256 of
 *     "<t>.<raw body>">` with a timestamp tolerance, the scheme hosted
 *     providers commonly use, so the verification code path is the real one.
 *
 * Refused under NODE_ENV=production (`billing/config.ts`). It never holds or
 * accepts payment details: there is nothing to hold.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  BillingError,
  BillingWebhookError,
  SUBSCRIPTION_STATUSES,
  isRef,
  type BillingEvent,
  type BillingProvider,
  type CheckoutRequest,
  type Offer,
  type SubscriptionSnapshot,
  type SubscriptionStatus,
} from './types.js';

export const TEST_SIGNATURE_HEADER = 'jtt-test-signature';
/** How old a signed timestamp may be: replaying a captured webhook later fails. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
const DAY = 86_400_000;

/** A webhook as the simulator sends it: raw bytes and headers, exactly what arrives over HTTP. */
export interface SignedWebhook {
  rawBody: Buffer;
  headers: Record<string, string>;
  eventId: string;
}

interface SimCheckout {
  ref: string;
  userId: string;
  offer: Offer;
  customerRef: string | null;
  status: 'open' | 'completed';
}

export class TestBillingProvider implements BillingProvider {
  readonly id = 'test';
  readonly mode = 'test' as const;
  readonly #secret: string;
  readonly #appUrl: string;
  readonly #now: () => number;
  readonly #checkouts = new Map<string, SimCheckout>();
  readonly #subscriptions = new Map<string, SubscriptionSnapshot & { intervalDays: number }>();
  #sequence = 0;
  /** For tests: make the provider's API fail, as an outage would. */
  unavailable = false;

  constructor(options: { webhookSecret: string; appUrl: string; now?: () => number }) {
    this.#secret = options.webhookSecret;
    this.#appUrl = options.appUrl.replace(/\/+$/, '');
    this.#now = options.now ?? (() => Date.now());
  }

  #id(prefix: string): string {
    return `${prefix}_test_${randomBytes(8).toString('hex')}`;
  }

  #api(): void {
    if (this.unavailable) throw new BillingError('PROVIDER_UNAVAILABLE', 'The billing provider did not answer.');
  }

  // --- BillingProvider ---------------------------------------------------------

  async createCheckout(request: CheckoutRequest): Promise<{ checkoutRef: string; url: string }> {
    this.#api();
    const ref = this.#id('cs');
    this.#checkouts.set(ref, {
      ref,
      userId: request.userId,
      offer: request.offer,
      customerRef: request.customerRef,
      status: 'open',
    });
    return { checkoutRef: ref, url: `${this.#appUrl}/#/account/test-checkout/${ref}` };
  }

  async createPortal(request: { customerRef: string; returnUrl: string }): Promise<{ url: string }> {
    this.#api();
    if (!isRef(request.customerRef)) throw new BillingError('INVALID_REQUEST', 'Not a customer reference.');
    return { url: `${this.#appUrl}/#/account/test-portal` };
  }

  async getSubscription(subscriptionRef: string): Promise<SubscriptionSnapshot | null> {
    this.#api();
    const found = this.#subscriptions.get(subscriptionRef);
    return found ? snapshotOf(found) : null;
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    nowMs: number,
  ): BillingEvent {
    const header = headers[TEST_SIGNATURE_HEADER];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value) throw new BillingWebhookError('SIGNATURE_MISSING', `No ${TEST_SIGNATURE_HEADER} header.`);
    const parts = Object.fromEntries(
      value.split(',').map((part) => {
        const at = part.indexOf('=');
        return at > 0 ? [part.slice(0, at).trim(), part.slice(at + 1).trim()] : ['', ''];
      }),
    );
    const t = parts.t ?? '';
    const v1 = parts.v1 ?? '';
    if (!/^\d{1,12}$/.test(t) || !/^[0-9a-f]{64}$/.test(v1)) {
      throw new BillingWebhookError('SIGNATURE_INVALID', 'The signature header is not t=<seconds>,v1=<hex>.');
    }
    const expected = createHmac('sha256', this.#secret).update(`${t}.`).update(rawBody).digest();
    const given = Buffer.from(v1, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new BillingWebhookError('SIGNATURE_INVALID', 'The signature does not match.');
    }
    // Checked after the signature, so an unsigned request learns nothing about the clock.
    if (Math.abs(nowMs / 1000 - Number(t)) > SIGNATURE_TOLERANCE_SECONDS) {
      throw new BillingWebhookError('TIMESTAMP_OUT_OF_TOLERANCE', 'The signed timestamp is too old or in the future.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BillingWebhookError('MALFORMED', 'The body is not JSON.');
    }
    return parseEvent(parsed);
  }

  // --- the simulation (what a customer does at the provider) --------------------

  /** The checkout's owner, for the test-mode page to confirm it is theirs. */
  checkout(ref: string): { userId: string; offerId: string; status: 'open' | 'completed' } | null {
    const found = this.#checkouts.get(ref);
    return found ? { userId: found.userId, offerId: found.offer.id, status: found.status } : null;
  }

  /**
   * "The customer paid" (or started the offer's trial): a customer and a
   * subscription now exist at the provider, and it sends two webhooks.
   */
  completeCheckout(ref: string, options: { trialDays?: number } = {}): SignedWebhook[] {
    const checkout = this.#checkouts.get(ref);
    if (!checkout || checkout.status !== 'open') throw new BillingError('CHECKOUT_NOT_FOUND', 'No open test checkout has that reference.');
    checkout.status = 'completed';
    const customerRef = checkout.customerRef ?? this.#id('cus');
    const now = this.#now();
    const intervalDays = checkout.offer.interval === 'year' ? 365 : 30;
    const trial = options.trialDays !== undefined && options.trialDays > 0;
    const subscription = {
      subscriptionRef: this.#id('sub'),
      customerRef,
      priceRef: checkout.offer.priceRef,
      status: (trial ? 'trialing' : 'active') as SubscriptionStatus,
      currentPeriodStart: new Date(now).toISOString(),
      currentPeriodEnd: new Date(now + (trial ? options.trialDays! : intervalDays) * DAY).toISOString(),
      cancelAtPeriodEnd: false,
      endedAt: null,
      clientReference: checkout.userId,
      intervalDays,
    };
    this.#subscriptions.set(subscription.subscriptionRef, subscription);
    return [
      this.sign('checkout.completed', { checkout: ref, customer: customerRef, clientReference: checkout.userId }),
      this.#subscriptionEvent('subscription.created', subscription),
    ];
  }

  /** The period rolled over and the renewal was paid. */
  renew(subscriptionRef: string): SignedWebhook {
    return this.#advance(subscriptionRef, 'active');
  }

  /** The period rolled over and the renewal payment failed. */
  failRenewal(subscriptionRef: string): SignedWebhook {
    return this.#advance(subscriptionRef, 'past_due');
  }

  /** The provider gave up collecting a failed payment. */
  markUnpaid(subscriptionRef: string): SignedWebhook {
    return this.#change(subscriptionRef, (s) => ({ ...s, status: 'unpaid' }));
  }

  /** A failed payment was eventually collected. */
  recoverPayment(subscriptionRef: string): SignedWebhook {
    return this.#change(subscriptionRef, (s) => ({ ...s, status: 'active' }));
  }

  /** The holder chose to cancel at the period end (true), or changed their mind (false). */
  setCancelAtPeriodEnd(subscriptionRef: string, cancel: boolean): SignedWebhook {
    return this.#change(subscriptionRef, (s) => ({ ...s, cancelAtPeriodEnd: cancel }));
  }

  /** Cancelled with immediate effect (by the holder, support, or a dispute). */
  cancelNow(subscriptionRef: string): SignedWebhook {
    const now = new Date(this.#now()).toISOString();
    return this.#change(subscriptionRef, (s) => ({ ...s, status: 'canceled', endedAt: now }), 'subscription.deleted');
  }

  /** A subscription set to cancel at the period end reached it. */
  endAtPeriodEnd(subscriptionRef: string): SignedWebhook {
    return this.#change(
      subscriptionRef,
      (s) => ({ ...s, status: 'canceled', endedAt: s.currentPeriodEnd }),
      'subscription.deleted',
    );
  }

  /** Change the provider's state *without* telling the platform — a webhook that never arrived. */
  silently(subscriptionRef: string, change: (s: SubscriptionSnapshot) => SubscriptionSnapshot): void {
    const current = this.#require(subscriptionRef);
    this.#subscriptions.set(subscriptionRef, { ...change(current), intervalDays: current.intervalDays });
  }

  /** Sign any event, as the provider would send it. */
  sign(type: string, data: Record<string, unknown>, options: { eventId?: string; occurredAt?: string } = {}): SignedWebhook {
    this.#sequence += 1;
    const eventId = options.eventId ?? `evt_test_${String(this.#sequence).padStart(6, '0')}_${randomBytes(4).toString('hex')}`;
    const body = JSON.stringify({
      id: eventId,
      type,
      occurredAt: options.occurredAt ?? new Date(this.#now()).toISOString(),
      data,
    });
    const rawBody = Buffer.from(body, 'utf8');
    return { rawBody, headers: this.signatureHeaders(rawBody), eventId };
  }

  /** The headers for these bytes, signed now. */
  signatureHeaders(rawBody: Buffer, atMs: number = this.#now()): Record<string, string> {
    const t = String(Math.floor(atMs / 1000));
    const v1 = createHmac('sha256', this.#secret).update(`${t}.`).update(rawBody).digest('hex');
    return { 'content-type': 'application/json', [TEST_SIGNATURE_HEADER]: `t=${t},v1=${v1}` };
  }

  #require(subscriptionRef: string) {
    const found = this.#subscriptions.get(subscriptionRef);
    if (!found) throw new BillingError('SUBSCRIPTION_NOT_FOUND', 'No test subscription has that reference.');
    return found;
  }

  #advance(subscriptionRef: string, status: SubscriptionStatus): SignedWebhook {
    return this.#change(subscriptionRef, (s) => {
      const start = Date.parse(s.currentPeriodEnd);
      const intervalDays = this.#require(subscriptionRef).intervalDays;
      return {
        ...s,
        status,
        currentPeriodStart: new Date(start).toISOString(),
        currentPeriodEnd: new Date(start + intervalDays * DAY).toISOString(),
      };
    });
  }

  #change(
    subscriptionRef: string,
    change: (s: SubscriptionSnapshot) => SubscriptionSnapshot,
    type = 'subscription.updated',
  ): SignedWebhook {
    const current = this.#require(subscriptionRef);
    const next = { ...change(snapshotOf(current)), intervalDays: current.intervalDays };
    this.#subscriptions.set(subscriptionRef, next);
    return this.#subscriptionEvent(type, next);
  }

  #subscriptionEvent(type: string, s: SubscriptionSnapshot): SignedWebhook {
    return this.sign(type, {
      subscription: {
        id: s.subscriptionRef,
        customer: s.customerRef,
        price: s.priceRef,
        status: s.status,
        currentPeriodStart: s.currentPeriodStart,
        currentPeriodEnd: s.currentPeriodEnd,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        endedAt: s.endedAt,
        clientReference: s.clientReference,
      },
    });
  }
}

function snapshotOf(s: SubscriptionSnapshot): SubscriptionSnapshot {
  return {
    subscriptionRef: s.subscriptionRef,
    customerRef: s.customerRef,
    priceRef: s.priceRef,
    status: s.status,
    currentPeriodStart: s.currentPeriodStart,
    currentPeriodEnd: s.currentPeriodEnd,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    endedAt: s.endedAt,
    clientReference: s.clientReference,
  };
}

// --- the wire format, parsed strictly ---------------------------------------------

const EVENT_ID = /^[A-Za-z0-9_\-.:]{1,255}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_.]{0,99}$/;
const UUID_OR_DEV = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|usr-[0-9]{8})$/;

function malformed(message: string): never {
  throw new BillingWebhookError('MALFORMED', message);
}

function instant(value: unknown, field: string): string {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) malformed(`${field} is not an instant.`);
  return new Date(ms).toISOString();
}

function clientReference(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !UUID_OR_DEV.test(value)) malformed('clientReference is not an account id.');
  return value;
}

export function parseEvent(input: unknown): BillingEvent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) malformed('The event is not an object.');
  const e = input as Record<string, unknown>;
  if (typeof e.id !== 'string' || !EVENT_ID.test(e.id)) malformed('The event has no usable id.');
  if (typeof e.type !== 'string' || !EVENT_TYPE.test(e.type)) malformed('The event has no usable type.');
  const base = { eventId: e.id, eventType: e.type, occurredAt: instant(e.occurredAt, 'occurredAt') };
  const data = e.data && typeof e.data === 'object' && !Array.isArray(e.data) ? (e.data as Record<string, unknown>) : null;
  if (!data) malformed('The event has no data object.');

  if (e.type === 'checkout.completed') {
    if (!isRef(data.checkout) || !isRef(data.customer)) malformed('checkout.completed needs checkout and customer references.');
    return {
      ...base,
      kind: 'checkout.completed',
      checkoutRef: data.checkout,
      customerRef: data.customer,
      clientReference: clientReference(data.clientReference),
    };
  }
  if (e.type === 'subscription.created' || e.type === 'subscription.updated' || e.type === 'subscription.deleted') {
    const s = data.subscription && typeof data.subscription === 'object' ? (data.subscription as Record<string, unknown>) : null;
    if (!s) malformed(`${e.type} has no subscription.`);
    if (!isRef(s.id) || !isRef(s.customer) || !isRef(s.price)) malformed('The subscription is missing a reference.');
    if (typeof s.status !== 'string' || !(SUBSCRIPTION_STATUSES as readonly string[]).includes(s.status)) {
      malformed('The subscription status is not one this platform knows.');
    }
    if (typeof s.cancelAtPeriodEnd !== 'boolean') malformed('cancelAtPeriodEnd must be a boolean.');
    const currentPeriodStart = instant(s.currentPeriodStart, 'currentPeriodStart');
    const currentPeriodEnd = instant(s.currentPeriodEnd, 'currentPeriodEnd');
    if (Date.parse(currentPeriodEnd) <= Date.parse(currentPeriodStart)) malformed('The period ends before it starts.');
    return {
      ...base,
      kind: 'subscription',
      subscription: {
        subscriptionRef: s.id,
        customerRef: s.customer,
        priceRef: s.price,
        status: s.status as SubscriptionStatus,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        endedAt: s.endedAt === null || s.endedAt === undefined ? null : instant(s.endedAt, 'endedAt'),
        clientReference: clientReference(s.clientReference),
      },
    };
  }
  // A verified event of a type this platform does not act on (an invoice, a
  // payment method change): acknowledged, recorded, nothing changed.
  return { ...base, kind: 'ignored' };
}
