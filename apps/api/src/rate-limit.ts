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
import type { Request } from 'express';
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

/**
 * Starting and resetting a lab — the two requests that create a sandbox.
 *
 * Per *student*, not per address: these routes are authenticated, and a
 * classroom behind one NAT address must not share one budget. The per-student
 * session limit already stops a second live lab; what it cannot stop is a
 * script asking a thousand times a second, each refusal still opening and
 * closing an attempt row and queueing on the capacity lock every other
 * student's Start waits for. 20 a minute is several times what anyone
 * pressing buttons does, including the release gate's own races.
 */
export const SANDBOX_WRITE_RATE_LIMIT: RateLimitPolicy = { limit: 20, windowMs: 60_000 };

/** Budget key: the client address. IPv6 is grouped by /56, so one host cannot mint fresh budgets. */
export const byClientAddress = (req: Request): string => ipKeyGenerator(req.ip ?? '');

/** Budget key: the authenticated user, falling back to the address before authentication. */
export const byAuthenticatedUser = (req: Request): string =>
  req.user ? `user:${req.user.userId}` : `addr:${byClientAddress(req)}`;

export function createRateLimiter(
  policy: RateLimitPolicy,
  onLimited: () => void = () => undefined,
  keyFor: (req: Request) => string = byClientAddress,
): RateLimitRequestHandler {
  return rateLimit({
    windowMs: policy.windowMs,
    limit: policy.limit,
    // `RateLimit` / `RateLimit-Policy` on every response, `Retry-After` on a 429.
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: keyFor,
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
