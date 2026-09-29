/**
 * Billing over the operator socket — docs/billing.md §4.
 *
 *   GET  /v1/billing                  configuration summary and every subscription, newest first
 *   GET  /v1/billing/<user-id>        one account: customer, subscriptions, billing's row, recent events
 *   POST /v1/billing/reconcile        {apply?, by?, reason?} — compare with the provider; with apply, re-process drift
 *
 * The same trust boundary as `ops access` (operator.ts): whoever can reach the
 * socket already holds the host. Nothing here charges, refunds or cancels —
 * those are the provider's, done in its dashboard — and nothing writes billing
 * state by hand: `--apply` re-processes the provider's current state through
 * the webhook processor.
 */
import type { IncomingMessage } from 'node:http';

import type { Logger } from '@jumptotech/observability';

import { AccessError, assertActor, assertReason, assertUserId } from '../access/entitlements.js';
import { readJsonBody } from '../access/operator-access.js';
import type { BillingService } from './service.js';

export type BillingRouteResult = {
  action: 'billing_list' | 'billing_show' | 'billing_reconcile';
  status: number;
  payload: unknown;
  logFields?: Record<string, string>;
};

export function billingActionFor(method: string, parts: readonly string[]): BillingRouteResult['action'] | null {
  if (parts.length === 2 && method === 'GET') return 'billing_list';
  if (parts.length === 3 && parts[2] === 'reconcile' && method === 'POST') return 'billing_reconcile';
  if (parts.length === 3 && method === 'GET') return 'billing_show';
  return null;
}

export async function handleBillingRequest(
  deps: { service: BillingService; logger: Logger },
  req: IncomingMessage,
  url: URL,
): Promise<BillingRouteResult | null> {
  const method = req.method ?? 'GET';
  const parts = url.pathname.split('/').filter(Boolean); // ['v1', 'billing', …]
  const action = billingActionFor(method, parts);
  if (!action) return null;

  if (action === 'billing_list') {
    const subscriptions = await deps.service.operatorList();
    return {
      action,
      status: 200,
      payload: { provider: deps.service.provider.id, mode: deps.service.provider.mode, count: subscriptions.length, subscriptions },
    };
  }

  if (action === 'billing_show') {
    let raw = '';
    try {
      raw = decodeURIComponent(parts[2] ?? '');
    } catch {
      /* a malformed escape is a bad id */
    }
    const userId = assertUserId(raw);
    return { action, status: 200, payload: await deps.service.operatorShow(userId), logFields: { userId } };
  }

  const body = await readJsonBody(req);
  const extra = Object.keys(body).filter((key) => !['apply', 'by', 'reason'].includes(key));
  if (extra.length > 0) throw new AccessError('INVALID_REQUEST', `Unknown field(s): ${extra.join(', ')}.`);
  const apply = body.apply === true;
  // Changing state needs a name and a reason, like every access change.
  const by = apply ? assertActor(body.by) : null;
  const reason = apply ? assertReason(body.reason) : null;
  const report = await deps.service.reconcile(apply ? { apply, by: by!, reason: reason! } : { apply });
  deps.logger.info(
    'ops.operator.request',
    { action: 'billing_reconcile', outcome: apply ? 'applied' : 'report_only', count: report.drift.length },
    `billing reconcile ${apply ? `--apply by ${by}` : '(report only)'}: ${report.drift.length} drifted`,
  );
  return { action, status: 200, payload: report };
}
