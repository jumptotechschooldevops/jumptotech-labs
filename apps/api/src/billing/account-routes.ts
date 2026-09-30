/**
 * A signed-in student's billing — docs/billing.md §2.
 *
 *   GET  /api/billing                      offers, own subscription (product status), legal links
 *   POST /api/billing/checkout {offerId}   start a checkout for *this* account → { url }
 *   POST /api/billing/portal               the provider's portal for *this* account → { url }
 *
 * Test provider only (never registered otherwise, and it is refused in production):
 *
 *   GET  /api/billing/test/checkouts/:ref            this account's test checkout
 *   POST /api/billing/test/checkouts/:ref/complete   "pay" it: the simulator's signed webhooks are processed
 *   POST /api/billing/test/subscription/:action      renew, fail-renewal, recover, cancel-at-period-end, resume, cancel-now
 *
 * The account is always the authenticated caller. The only input is an offer
 * id, which names configuration; a body naming a customer, subscription, plan
 * or price is refused, not ignored.
 */
import { Router, type Request, type Response } from 'express';

import { asyncRoute, sendError, sendOk } from '../http.js';
import type { LegalLinks } from './config.js';
import { BillingError } from './types.js';
import { TEST_ACTIONS, type BillingService, type TestAction } from './service.js';

const STATUS: Record<BillingError['code'], number> = {
  BILLING_DISABLED: 404,
  OFFER_NOT_FOUND: 400,
  ALREADY_SUBSCRIBED: 409,
  NO_BILLING_ACCOUNT: 404,
  CHECKOUT_NOT_FOUND: 404,
  SUBSCRIPTION_NOT_FOUND: 404,
  PROVIDER_UNAVAILABLE: 503,
  UNMAPPED_PRICE: 500,
  UNMAPPED_SUBSCRIPTION: 500,
  OWNERSHIP_CONFLICT: 409,
  ACCOUNT_SUSPENDED: 409,
  TOO_MANY_CHECKOUTS: 429,
  INVALID_REQUEST: 400,
};

const REF = /^[A-Za-z0-9_\-.:]{1,255}$/;

function refuse(res: Response, error: unknown): boolean {
  if (!(error instanceof BillingError)) return false;
  sendError(res, STATUS[error.code], { code: error.code, message: error.message });
  return true;
}

function onlyFields(req: Request, res: Response, allowed: readonly string[]): boolean {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length === 0) return true;
  sendError(res, 400, {
    code: 'INVALID_REQUEST',
    message: `Unknown field(s): ${extra.map((key) => key.slice(0, 32)).join(', ')}. The account is always the one signed in.`,
  });
  return false;
}

export function createBillingAccountRoutes(deps: { service?: BillingService; legal: LegalLinks }): Router {
  const router = Router();
  const { service, legal } = deps;

  const caller = (req: Request, res: Response): string | null => {
    if (!req.user) {
      sendError(res, 401, { code: 'AUTH_REQUIRED', message: 'This request requires authentication.' });
      return null;
    }
    return req.user.userId;
  };
  const enabled = (res: Response): BillingService | null => {
    if (service) return service;
    sendError(res, 404, { code: 'BILLING_DISABLED', message: 'Billing is not enabled on this platform.' });
    return null;
  };

  router.get('/', asyncRoute(async (req, res) => {
    const userId = caller(req, res);
    if (!userId) return;
    sendOk(res, {
      billing: service
        ? await service.view(userId)
        : { enabled: false, offers: [], subscription: null, canManageBilling: false, canSubscribe: false },
      legal,
    });
  }));

  router.post('/checkout', asyncRoute(async (req, res) => {
    const userId = caller(req, res);
    if (!userId || !onlyFields(req, res, ['offerId'])) return;
    const billing = enabled(res);
    if (!billing) return;
    try {
      sendOk(res, await billing.startCheckout(userId, (req.body as { offerId?: unknown } | undefined)?.offerId));
    } catch (error) {
      if (!refuse(res, error)) throw error;
    }
  }));

  router.post('/portal', asyncRoute(async (req, res) => {
    const userId = caller(req, res);
    if (!userId || !onlyFields(req, res, [])) return;
    const billing = enabled(res);
    if (!billing) return;
    try {
      sendOk(res, await billing.openPortal(userId));
    } catch (error) {
      if (!refuse(res, error)) throw error;
    }
  }));

  if (service?.testMode) {
    router.get('/test/checkouts/:ref', asyncRoute(async (req, res) => {
      const userId = caller(req, res);
      if (!userId) return;
      const ref = String(req.params.ref ?? '');
      try {
        if (!REF.test(ref)) throw new BillingError('CHECKOUT_NOT_FOUND', 'No such checkout.');
        sendOk(res, { mode: 'test', checkout: service.testCheckout(userId, ref) });
      } catch (error) {
        if (!refuse(res, error)) throw error;
      }
    }));

    router.post('/test/checkouts/:ref/complete', asyncRoute(async (req, res) => {
      const userId = caller(req, res);
      if (!userId || !onlyFields(req, res, [])) return;
      const ref = String(req.params.ref ?? '');
      try {
        if (!REF.test(ref)) throw new BillingError('CHECKOUT_NOT_FOUND', 'No such checkout.');
        sendOk(res, { mode: 'test', ...(await service.completeTestCheckout(userId, ref)) });
      } catch (error) {
        if (!refuse(res, error)) throw error;
      }
    }));

    router.post('/test/subscription/:action', asyncRoute(async (req, res) => {
      const userId = caller(req, res);
      if (!userId || !onlyFields(req, res, [])) return;
      const action = String(req.params.action ?? '') as TestAction;
      if (!TEST_ACTIONS.includes(action)) {
        sendError(res, 400, { code: 'INVALID_REQUEST', message: `action is one of ${TEST_ACTIONS.join(', ')}.` });
        return;
      }
      try {
        sendOk(res, { mode: 'test', ...(await service.simulate(userId, action)) });
      } catch (error) {
        if (!refuse(res, error)) throw error;
      }
    }));
  }

  return router;
}
