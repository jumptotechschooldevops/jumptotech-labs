/**
 * Cross-site request forgery: the server-side half of the origin allow-list —
 * BETA-P0-014.
 *
 * The platform already had two CSRF defences, and this does not replace either:
 *
 *   · the session cookie is `SameSite=Lax`, so a *cross-site* POST, DELETE or
 *     fetch does not carry it;
 *   · CORS names `ALLOWED_ORIGINS`, so a foreign page cannot *read* a response.
 *
 * What neither covers is a state-changing request from a **same-site, foreign
 * origin** — a sibling subdomain under the same registrable domain, which
 * `SameSite=Lax` treats as "same site" and sends the cookie to. CORS does not
 * stop such a request from being *sent*: a form POST needs no preflight, and
 * several routes (`/api/labs/:id/start`, `DELETE /api/sessions/:id`,
 * `/auth/logout`) need no body to do their work.
 *
 * So the allow-list CORS already uses becomes enforcement as well: an unsafe
 * method from a browser must come from an allowed origin. Same list, same
 * source of truth — not a second mechanism with its own configuration.
 *
 * ```text
 *   GET / HEAD / OPTIONS                  pass (no state change; CORS preflight)
 *   Origin present, allowed               pass
 *   Origin present, anything else         403   ('null' included)
 *   no Origin, Sec-Fetch-Site same-origin pass
 *   no Origin, Sec-Fetch-Site none        pass (user typed it / bookmark)
 *   no Origin, Sec-Fetch-Site other       403   (cross-site or same-site)
 *   neither header                        pass (not a browser: curl, a service,
 *                                               the test suite — none of which
 *                                               carries a victim's cookie)
 * ```
 *
 * Every browser that supports `SameSite` sends `Origin` on a non-GET request, so
 * the last row is not a browser path.
 */
import type { NextFunction, Request, Response } from 'express';
import { sendError } from '../http.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type OriginRefusal = 'origin-not-allowed' | 'cross-site-fetch';

export function requireTrustedOrigin(
  trustedOrigins: readonly string[],
  onRefused: (reason: OriginRefusal) => void = () => {},
) {
  const trusted = new Set(trustedOrigins.filter(Boolean).map((origin) => origin.replace(/\/$/, '')));

  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const origin = req.get('origin');
    if (origin !== undefined) {
      if (trusted.has(origin)) {
        next();
        return;
      }
      refuse(res, 'origin-not-allowed', onRefused);
      return;
    }

    const site = req.get('sec-fetch-site');
    if (site === undefined || site === 'same-origin' || site === 'none') {
      next();
      return;
    }
    refuse(res, 'cross-site-fetch', onRefused);
  };
}

function refuse(res: Response, reason: OriginRefusal, onRefused: (reason: OriginRefusal) => void): void {
  onRefused(reason);
  // Deliberately says nothing about which origins *are* allowed.
  sendError(res, 403, {
    code: 'ORIGIN_NOT_ALLOWED',
    message: 'This request did not come from an allowed origin.',
  });
}
