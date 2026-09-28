/**
 * From provider state to product state — docs/billing.md §5–§7.
 *
 * Two mappings, both pure:
 *
 *   `commercialStatus`     what the student and the operator are told
 *                          (never a raw provider status)
 *   `desiredEntitlement`   what billing's entitlement row should be, from all
 *                          of an account's subscriptions
 *
 * Nothing here decides a policy. Cancellation timing is the provider's
 * (`cancelAtPeriodEnd`); the renewal leeway and the failed-payment grace are
 * configuration with no default (`billing/config.ts`).
 */
import type { SyncRequest } from '../access/entitlements.js';
import type { BillingPolicy } from './config.js';
import type { SubscriptionStatus } from './types.js';

/** A subscription as stored (`billing_subscriptions`). */
export interface StoredSubscription {
  provider: string;
  subscriptionRef: string;
  userId: string;
  customerRef: string;
  priceRef: string;
  planId: string | null;
  status: SubscriptionStatus;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  endedAt: string | null;
  /** When the provider produced this state: an older event never overwrites it. */
  providerStateAt: string;
  updatedAt: string;
}

/**
 * What a student is told about their subscription.
 *
 *   NONE             no subscription
 *   TRIAL            the provider's trial period
 *   ACTIVE           paid, renewing
 *   CANCELING        paid until the period ends, then ends (cancel at period end)
 *   PAYMENT_PROBLEM  a payment failed or never completed (past_due, unpaid, incomplete)
 *   PAUSED           paused at the provider
 *   ENDED            canceled, or a checkout that was never paid for and expired
 */
export const COMMERCIAL_STATUSES = ['NONE', 'TRIAL', 'ACTIVE', 'CANCELING', 'PAYMENT_PROBLEM', 'PAUSED', 'ENDED'] as const;
export type CommercialStatus = (typeof COMMERCIAL_STATUSES)[number];

export function commercialStatus(subscription: StoredSubscription | null): CommercialStatus {
  if (!subscription) return 'NONE';
  switch (subscription.status) {
    case 'trialing':
      return subscription.cancelAtPeriodEnd ? 'CANCELING' : 'TRIAL';
    case 'active':
      return subscription.cancelAtPeriodEnd ? 'CANCELING' : 'ACTIVE';
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
      return 'PAYMENT_PROBLEM';
    case 'paused':
      return 'PAUSED';
    case 'canceled':
    case 'incomplete_expired':
      return 'ENDED';
  }
}

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** The window one subscription entitles, and whether it entitles at all. */
export function entitlementFor(subscription: StoredSubscription, policy: BillingPolicy): SyncRequest {
  const start = Date.parse(subscription.currentPeriodStart);
  const end = Date.parse(subscription.currentPeriodEnd);
  const kind = subscription.status === 'trialing' ? 'TRIAL' : 'SUBSCRIPTION';
  const base = { startsAt: iso(start), kind, planId: subscription.planId } as const;
  switch (subscription.status) {
    case 'trialing':
    case 'active': {
      // A subscription set to end gets no leeway: no renewal is coming.
      const leeway = subscription.cancelAtPeriodEnd ? 0 : policy.renewalLeewayHours * HOUR;
      return { ...base, active: true, expiresAt: iso(end + leeway) };
    }
    case 'past_due':
      // The unpaid period began at `start`; the grace (possibly none) counts from there.
      return policy.pastDueGraceHours > 0
        ? { ...base, active: true, expiresAt: iso(start + policy.pastDueGraceHours * HOUR) }
        : { ...base, active: false, expiresAt: iso(end) };
    case 'unpaid':
    case 'incomplete':
    case 'incomplete_expired':
    case 'paused':
    case 'canceled':
      return { ...base, active: false, expiresAt: iso(end) };
  }
}

/**
 * Billing's row for an account with these subscriptions: the entitling one
 * that runs longest, or — when none entitles — the one that ended last, as an
 * inactive sync that closes the row. null: no subscriptions at all.
 */
export function desiredEntitlement(
  subscriptions: readonly StoredSubscription[],
  policy: BillingPolicy,
): SyncRequest | null {
  if (subscriptions.length === 0) return null;
  const all = subscriptions.map((subscription) => entitlementFor(subscription, policy));
  const byEnd = (a: SyncRequest, b: SyncRequest) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt);
  const entitling = all.filter((request) => request.active).sort(byEnd);
  if (entitling.length > 0) return entitling[0]!;
  return [...all].sort(byEnd)[0]!;
}

/** The subscription a student is told about: the one that entitles longest, else the latest. */
export function primarySubscription(subscriptions: readonly StoredSubscription[], policy: BillingPolicy): StoredSubscription | null {
  if (subscriptions.length === 0) return null;
  const ranked = subscriptions
    .map((subscription) => ({ subscription, request: entitlementFor(subscription, policy) }))
    .sort(
      (a, b) =>
        Number(b.request.active) - Number(a.request.active) ||
        Date.parse(b.request.expiresAt) - Date.parse(a.request.expiresAt) ||
        Date.parse(b.subscription.updatedAt) - Date.parse(a.subscription.updatedAt),
    );
  return ranked[0]!.subscription;
}
