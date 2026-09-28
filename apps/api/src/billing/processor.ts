/**
 * Webhook processing — docs/billing.md §4.
 *
 * ```text
 *   raw bytes ──verify signature + timestamp──► event          (else 400, nothing read)
 *   event ──claim its id──────────────────────► duplicate?     (yes: 200, nothing done)
 *         ──whose account?────────────────────► customer map, or a checkout this platform started
 *         ──older than what is stored?────────► stale          (200, recorded, not applied)
 *         ──store the subscription, sync billing's entitlement row
 *   all of it one transaction: a failure leaves no trace, and the provider's retry starts over
 * ```
 *
 * The only inputs are the provider's signed event and this platform's own
 * records. Nothing a browser sends reaches this code.
 */
import type { BillingMetrics, Logger } from '@jumptotech/observability';

import type { PlanCatalog } from '../access/plans.js';
import type { BillingPolicy } from './config.js';
import { desiredEntitlement, type StoredSubscription } from './lifecycle.js';
import type { BillingStore } from './store.js';
import {
  BillingError,
  BillingWebhookError,
  type BillingEvent,
  type BillingProvider,
  type Offer,
} from './types.js';

export type ProcessOutcome = 'applied' | 'duplicate' | 'stale' | 'ignored';

export interface BillingProcessorDeps {
  provider: BillingProvider;
  store: BillingStore;
  offers: readonly Offer[];
  plans: PlanCatalog;
  policy: BillingPolicy;
  now?: () => number;
  logger?: Logger;
  metrics?: BillingMetrics;
}

export interface WebhookReply {
  status: number;
  body: unknown;
}

/** One line for the access history: the event, never its payload. */
function reasonFor(event: BillingEvent): string {
  return `billing event ${event.eventType} ${event.eventId}`.slice(0, 500);
}

export class BillingProcessor {
  readonly #deps: BillingProcessorDeps;
  readonly #now: () => number;

  constructor(deps: BillingProcessorDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
  }

  get provider(): BillingProvider {
    return this.#deps.provider;
  }

  /** The HTTP answer to one webhook delivery. Never throws. */
  async handleWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<WebhookReply> {
    const { provider, logger, metrics } = this.#deps;
    let event: BillingEvent;
    try {
      event = provider.verifyWebhook(rawBody, headers, this.#now());
    } catch (error) {
      const code = error instanceof BillingWebhookError ? error.code : 'MALFORMED';
      const outcome = code === 'MALFORMED' ? 'malformed' : 'invalid_signature';
      metrics?.webhooks.inc({ provider: provider.id, outcome });
      // The code only: never the body, the header or the secret.
      logger?.warn('billing.webhook_rejected', { provider: provider.id, outcome, code }, `billing webhook refused: ${code}`);
      return {
        status: 400,
        body: { ok: false, error: { code: 'WEBHOOK_REJECTED', message: 'The webhook could not be verified.' } },
      };
    }

    try {
      const result = await this.process(event);
      metrics?.webhooks.inc({ provider: provider.id, outcome: result.outcome });
      logger?.info(
        'billing.webhook_processed',
        {
          provider: provider.id,
          outcome: result.outcome,
          op: event.eventType,
          eventRef: event.eventId,
          ...(result.userId ? { userId: result.userId } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
        },
        `billing event ${event.eventType} ${event.eventId}: ${result.outcome}`,
      );
      return { status: 200, body: { ok: true, data: { received: true, outcome: result.outcome } } };
    } catch (error) {
      const code = error instanceof BillingError ? error.code : 'INTERNAL';
      const outcome = code === 'UNMAPPED_PRICE' || code === 'UNMAPPED_SUBSCRIPTION' ? 'unmapped' : 'failed';
      metrics?.webhooks.inc({ provider: provider.id, outcome });
      logger?.error(
        'billing.webhook_failed',
        { provider: provider.id, outcome, code, op: event.eventType, eventRef: event.eventId, err: error },
        `billing event ${event.eventType} ${event.eventId} not processed (${code}); the provider will retry it`,
      );
      // 5xx: the provider retries, and the event — never claimed — is processed afresh.
      return {
        status: 500,
        body: { ok: false, error: { code: 'WEBHOOK_NOT_PROCESSED', message: 'Not processed; retry later.' } },
      };
    }
  }

  /** Process one verified event. Throws for a failure the provider should retry. */
  async process(event: BillingEvent): Promise<{ outcome: ProcessOutcome; userId?: string; reason?: string }> {
    const { provider, store, logger } = this.#deps;
    const at = new Date(this.#now()).toISOString();
    return store.transaction(async (tx) => {
      const claimed = await tx.claimEvent(
        {
          provider: provider.id,
          eventId: event.eventId,
          eventType: event.eventType,
          subscriptionRef: event.kind === 'subscription' ? event.subscription.subscriptionRef : null,
          occurredAt: event.occurredAt,
        },
        at,
      );
      if (!claimed) return { outcome: 'duplicate' as const };

      const settle = async (outcome: 'applied' | 'stale' | 'ignored', extra: { userId?: string; reason?: string } = {}) => {
        await tx.setEventOutcome(provider.id, event.eventId, outcome);
        return { outcome, ...extra };
      };

      if (event.kind === 'ignored') return settle('ignored', { reason: 'event_type_not_used' });

      if (event.kind === 'checkout.completed') {
        const checkout = await tx.checkout(provider.id, event.checkoutRef);
        // Not a checkout this platform started for this account: not ours to act on.
        if (!checkout || (event.clientReference !== null && event.clientReference !== checkout.userId)) {
          logger?.warn(
            'billing.checkout_unknown',
            { provider: provider.id, eventRef: event.eventId, reason: checkout ? 'client_reference_mismatch' : 'not_started_here' },
            'a completed checkout this platform did not start for that account was ignored',
          );
          return settle('ignored', { reason: 'checkout_not_ours' });
        }
        const bound = await tx.bindCustomer(provider.id, event.customerRef, checkout.userId, at);
        if (bound === 'conflict') {
          logger?.error(
            'billing.ownership_conflict',
            { provider: provider.id, userId: checkout.userId, eventRef: event.eventId, reason: 'customer_bound_elsewhere' },
            'a checkout named a provider customer that belongs to a different account; nothing was bound',
          );
          return settle('ignored', { userId: checkout.userId, reason: 'ownership_conflict' });
        }
        await tx.completeCheckout(provider.id, event.checkoutRef, at);
        return settle('applied', { userId: checkout.userId });
      }

      // A subscription changed.
      const s = event.subscription;
      let userId = await tx.customerUser(provider.id, s.customerRef);
      if (!userId) {
        // The subscription can arrive before its checkout.completed. The
        // account it names is believed only if this platform started a
        // checkout for that account.
        if (s.clientReference && (await tx.hasCheckoutFor(provider.id, s.clientReference))) {
          const bound = await tx.bindCustomer(provider.id, s.customerRef, s.clientReference, at);
          if (bound === 'conflict') {
            logger?.error(
              'billing.ownership_conflict',
              { provider: provider.id, userId: s.clientReference, eventRef: event.eventId, reason: 'customer_bound_elsewhere' },
              'a subscription named an account whose provider customer is a different one; nothing was applied',
            );
            return settle('ignored', { reason: 'ownership_conflict' });
          }
          userId = s.clientReference;
        } else {
          throw new BillingError('UNMAPPED_SUBSCRIPTION', 'This subscription belongs to no account this platform knows yet.');
        }
      }

      // Serialise everything for this account from here: a newer and an older
      // event racing must not both pass the staleness check below.
      await tx.lockAccount(userId);
      const existing = await tx.subscription(provider.id, s.subscriptionRef);
      if (existing && existing.userId !== userId) {
        logger?.error(
          'billing.ownership_conflict',
          { provider: provider.id, userId, eventRef: event.eventId, reason: 'subscription_moved_accounts' },
          'a subscription already stored for one account was reported for another; nothing was applied',
        );
        return settle('ignored', { reason: 'ownership_conflict' });
      }
      if (existing && Date.parse(event.occurredAt) < Date.parse(existing.providerStateAt)) {
        return settle('stale', { userId, reason: 'older_than_stored' });
      }

      const offer = this.#deps.offers.find((candidate) => candidate.priceRef === s.priceRef);
      if (!offer || (offer.planId !== null && !this.#deps.plans.get(offer.planId))) {
        throw new BillingError('UNMAPPED_PRICE', 'The subscription is for a price no configured offer names.');
      }

      const stored: StoredSubscription = {
        provider: provider.id,
        subscriptionRef: s.subscriptionRef,
        userId,
        customerRef: s.customerRef,
        priceRef: s.priceRef,
        planId: offer.planId,
        status: s.status,
        currentPeriodStart: s.currentPeriodStart,
        currentPeriodEnd: s.currentPeriodEnd,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        endedAt: s.endedAt,
        providerStateAt: event.occurredAt,
        updatedAt: at,
      };
      await tx.putSubscription(stored);

      const desired = desiredEntitlement(await tx.subscriptionsOf(userId), this.#deps.policy);
      if (desired) {
        await tx.mutateAccess(
          {
            userId,
            source: 'billing',
            action: 'SYNC',
            actor: `billing.${provider.id}`,
            reason: reasonFor(event),
            sync: desired,
          },
          () => new Date(this.#now()),
        );
      }
      return settle('applied', { userId });
    });
  }
}
