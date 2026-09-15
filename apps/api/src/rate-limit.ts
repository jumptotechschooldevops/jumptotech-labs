/**
 * Request-rate limits for browser-facing routes.
 *
 * Built on `express-rate-limit`, a maintained Express middleware, rather than a
 * hand-rolled counter. One in-memory store per limiter: the API runs as a
 * single process in the private beta, so a per-process budget is the whole
 * budget. A multi-instance deployment would need a shared store.
 *
 * Budgets are per client address. `app.ts` trusts exactly one proxy hop (the
 * web tier's nginx), so `req.ip` is the student's address rather than nginx's,
 * and an address a client prepends to `X-Forwarded-For` is ignored.
 */
import { ipKeyGenerator, rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import { sendError } from './http.js';

export interface RateLimitPolicy {
  /** Requests allowed per client address within one window. */
  limit: number;
  windowMs: number;
}

/**
 * The learning-path reads (V1 EPIC-02).
 *
 * A page view costs two requests (the path and the student's progress through
 * it), so 600 a minute is far above any person clicking — including a classroom
 * sharing one NAT address — and far below a script hammering token checks and
 * progress queries.
 */
export const LEARNING_PATH_RATE_LIMIT: RateLimitPolicy = { limit: 600, windowMs: 60_000 };

export function createRateLimiter(
  policy: RateLimitPolicy,
  onLimited: () => void = () => undefined,
): RateLimitRequestHandler {
  return rateLimit({
    windowMs: policy.windowMs,
    limit: policy.limit,
    // `RateLimit` / `RateLimit-Policy` on every response, `Retry-After` on a 429.
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // IPv6 clients are grouped by /56, so one host cannot mint fresh budgets.
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? ''),
    handler: (_req, res) => {
      onLimited();
      sendError(res, 429, {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Please wait a moment and try again.',
        remediation: 'Wait a minute before reloading. Your labs and saved progress are not affected.',
      });
    },
  });
}
