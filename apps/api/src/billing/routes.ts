/**
 * The billing webhook endpoint — docs/billing.md §4.
 *
 *   POST /api/billing/webhooks/:provider
 *
 * Unauthenticated by design: the provider has no session here. Its signature
 * over the raw bytes is the authentication, so this route is registered
 * *before* the JSON body parser — a parsed-and-reserialised body would not be
 * the bytes that were signed — and reads at most 64 KB.
 */
import express, { type Router } from 'express';

import type { BillingProcessor } from './processor.js';

/** Larger than any subscription event; small enough that nobody can make the api buffer much. */
export const WEBHOOK_BODY_LIMIT = '64kb';

export function createBillingWebhookRoutes(processor: BillingProcessor): Router {
  const router = express.Router();
  router.post(
    '/:provider',
    express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT }),
    (req, res, next) => {
      // One configured provider; any other path names nothing.
      if (req.params.provider !== processor.provider.id) {
        res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'No such endpoint.' } });
        return;
      }
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      processor
        .handleWebhook(raw, req.headers)
        .then((reply) => res.status(reply.status).json(reply.body))
        .catch(next);
    },
  );
  return router;
}
