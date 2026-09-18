/**
 * Browser sign-in — PLATFORM-010.
 *
 * ```text
 *   GET  /auth/config    can this deployment sign anyone in, and how
 *   GET  /auth/session   who am I  (200 signed in / 200 signed out — never 401)
 *   GET  /auth/login     302 to the identity provider
 *   GET  /auth/callback  302 back to the app, with the session cookie set
 *   POST /auth/logout    destroy the server-side session, clear the cookie
 * ```
 *
 * These routes sit **outside** `authenticate`, deliberately: three of them are
 * how an unauthenticated caller becomes authenticated, and `/auth/session` has
 * to be able to answer "nobody" without that being an error.
 *
 * ## What never appears here
 *
 * No response body, redirect URL, log line, or error message in this file
 * contains the client secret, an authorization code, an ID token, an access
 * token, or the session cookie value. The two places a secret is legitimately
 * handled — the token-endpoint POST body and the `Set-Cookie` header — are both
 * server-to-somewhere-specific, and neither is echoed back.
 *
 * ## Why `/auth/session` is not 401
 *
 * The frontend calls it on load to decide whether to render a sign-in button. A
 * 401 there would be indistinguishable from a real authorization failure inside
 * the app, and the client would have to special-case one path to avoid a
 * redirect loop. "Signed out" is a successful answer to "who am I".
 */
import { Router, type Request, type Response } from 'express';
import { AuthError, type AuthenticatedUser } from '../auth/identity.js';
import type { AuthSessionStore } from '../auth/browser-session.js';
import type { BrowserSessionAuthenticator } from '../auth/browser-authenticator.js';
import type { OidcBrowserClient } from '../auth/oidc-client.js';
import { assertNonceMatches } from '../auth/oidc-client.js';
import { safeEquals } from '../auth/oidc-client.js';
import type { TokenVerifier } from '../auth/oidc.js';
import type { UserRepository } from '../auth/users.js';
import {
  clearCookie,
  openTransaction,
  parseCookies,
  sealTransaction,
  serializeCookie,
  type AuthTransaction,
  type CookieAttributes,
} from '../auth/cookies.js';
import type { AUTH_CALLBACK_OUTCOMES } from '@jumptotech/observability';
import type { AuthCookieConfig } from '../config.js';
import { asyncRoute, sendError, sendOk } from '../http.js';

/** How long a half-finished sign-in may sit before it must be restarted. */
const TRANSACTION_TTL_SECONDS = 10 * 60;
const TRANSACTION_COOKIE_SUFFIX = '_tx';
/**
 * The transaction cookie is only ever read by `/auth/callback`, so it is only
 * ever sent under `/auth` (BETA-P0-014). It used to ride along on every API
 * request for ten minutes after each sign-in attempt.
 */
const TRANSACTION_COOKIE_PATH = '/auth';

export interface AuthRoutesDeps {
  /** Null when this deployment has no browser sign-in configured. */
  client: OidcBrowserClient | null;
  /** Verifies the ID token. Audience is the *client id*, not the API audience. */
  idTokenVerifier: TokenVerifier | null;
  users: UserRepository;
  authSessions: AuthSessionStore;
  browser: BrowserSessionAuthenticator;
  cookie: AuthCookieConfig;
  /** Where the browser is sent after sign-in and sign-out. */
  appUrl: string;
  /** Signs the sign-in transaction cookie. */
  transactionSecret: string;
  /** `development` deployments report themselves as such rather than pretending. */
  mode: 'oidc' | 'development';
  logger?: (message: string) => void;
  /**
   * Counts each callback's outcome — BETA-P0-018. A closed code from
   * `AUTH_CALLBACK_OUTCOMES`, never the provider's error text.
   */
  onCallback?: (outcome: (typeof AUTH_CALLBACK_OUTCOMES)[number]) => void;
}

function cookieAttributes(cookie: AuthCookieConfig, maxAgeSeconds?: number): CookieAttributes {
  return {
    secure: cookie.secure,
    sameSite: 'lax',
    path: '/',
    domain: cookie.domain,
    ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds }),
  };
}

function transactionCookieAttributes(cookie: AuthCookieConfig, maxAgeSeconds?: number): CookieAttributes {
  return { ...cookieAttributes(cookie, maxAgeSeconds), path: TRANSACTION_COOKIE_PATH };
}

/**
 * The identity block the frontend renders from.
 *
 * `userId` is deliberately absent. It is an internal surrogate key, the browser
 * has no use for it, and every route resolves ownership from the session record
 * server-side — so publishing it would only create something for a client to be
 * tempted to send back.
 */
export function toIdentityPayload(user: AuthenticatedUser) {
  return {
    subject: user.subject,
    issuer: user.issuer,
    ...(user.email ? { email: user.email } : {}),
    ...(user.displayName ? { displayName: user.displayName } : {}),
    role: user.role,
    source: user.source,
  };
}

/**
 * Sanitise the post-sign-in destination.
 *
 * A `returnTo` that a caller controls is an open-redirect waiting to happen, so
 * only a same-origin *path* is accepted — never an absolute URL, never a
 * protocol-relative `//evil.example`, never a backslash variant. Anything else
 * silently becomes the app root, because a failed redirect target is not worth
 * an error page.
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  /*
   * Control characters are refused, written as escapes on purpose.
   *
   * This class previously held the raw 0x00 and 0x1F bytes. It behaved
   * correctly, but a security guard whose source form is invisible in an
   * editor — and reads as "[ -]" in a grep — is one formatter, linter, or
   * copy-paste away from silently becoming a different check. DEL joins CR
   * and LF for the same reason: it has no business in a URL path.
   */
  if (/[\u0000-\u001F\u007F]/.test(value)) return '/';
  return value;
}

export function createAuthRoutes(deps: AuthRoutesDeps): Router {
  const router = Router();
  const log = deps.logger ?? (() => undefined);
  const txCookieName = `${deps.cookie.name}${TRANSACTION_COOKIE_SUFFIX}`;

  /*
   * Nothing under /auth may be cached (BETA-P0-014).
   *
   * `/auth/session` answers "who is this browser" and `/auth/callback` carries
   * a `Set-Cookie` with a fresh session id. A shared cache or a CDN in front of
   * the deployment that stored either would hand one student's answer — or
   * session — to the next request for the same URL.
   */
  router.use((_req, res, next) => {
    res.setHeader('cache-control', 'no-store');
    next();
  });

  /** True when this deployment can actually complete a sign-in. */
  const signInAvailable = (): boolean => deps.client !== null && deps.idTokenVerifier !== null;

  // GET /auth/config -------------------------------------------------------
  // Lets the UI render honestly on a deployment with no identity provider
  // configured, instead of offering a button that leads to a 503.
  router.get('/config', (_req: Request, res: Response) => {
    sendOk(res, {
      mode: deps.mode,
      signInAvailable: signInAvailable(),
      loginPath: '/auth/login',
      logoutPath: '/auth/logout',
      sessionPath: '/auth/session',
    });
  });

  // GET /auth/session ------------------------------------------------------
  router.get('/session', asyncRoute(async (req, res) => {
    let user: AuthenticatedUser | null = null;
    try {
      user = await deps.browser.authenticate(req.get('cookie'));
    } catch (error) {
      if (!(error instanceof AuthError)) {
        /*
         * The store could not answer (a PostgreSQL restart, a pool timeout).
         * That says nothing about the cookie, so it is neither "signed out" nor
         * cleared: clearing it here signed a student with a lab open out for
         * good over a database blip. The browser keeps its app mounted on a
         * failed re-check and asks again later.
         */
        log(`session check could not reach the session store: ${error instanceof Error ? error.name : 'error'}`);
        res.setHeader('retry-after', '5');
        sendError(res, 503, {
          code: 'AUTH_UNAVAILABLE',
          message: 'Your sign-in could not be checked right now.',
          remediation: 'Try again in a moment. You are still signed in.',
        });
        return;
      }
      /*
       * An expired or unusable cookie is "signed out", not an error.
       *
       * The cookie is also cleared, so the browser stops sending a value that
       * will never work again — otherwise every subsequent request pays for a
       * failed lookup and the user sees no reason to sign in again.
       */
      res.setHeader('set-cookie', clearCookie(deps.cookie.name, cookieAttributes(deps.cookie)));
    }

    sendOk(res, {
      authenticated: user !== null,
      signInAvailable: signInAvailable(),
      mode: deps.mode,
      ...(user ? { identity: toIdentityPayload(user) } : {}),
    });
  }));

  // GET /auth/login --------------------------------------------------------
  /** Answer a failed sign-in step: the app's sign-in screen for a browser, the JSON error otherwise. */
  const signInFailed = (req: Request, res: Response, reason: SignInFailureReason, json: () => void): void => {
    if (!isBrowserNavigation(req)) {
      json();
      return;
    }
    res.setHeader('cache-control', 'no-store');
    res.redirect(302, `${deps.appUrl}/?signin=${reason}`);
  };

  router.get('/login', asyncRoute(async (req, res) => {
    if (!deps.client) {
      signInFailed(req, res, 'unavailable', () =>
        sendError(res, 503, {
          code: 'AUTH_NOT_CONFIGURED',
          message: 'This deployment has no identity provider configured.',
          remediation: 'Set OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and OIDC_AUDIENCE.',
        }),
      );
      return;
    }

    let request;
    try {
      request = await deps.client.authorizationRequest();
    } catch (error) {
      signInFailed(req, res, reasonFor(error), () => authErrorResponse(res, error, 'start sign-in'));
      return;
    }

    const transaction: AuthTransaction = {
      state: request.state,
      nonce: request.nonce,
      codeVerifier: request.codeVerifier,
      returnTo: safeReturnTo(req.query.returnTo),
      exp: Math.floor(Date.now() / 1000) + TRANSACTION_TTL_SECONDS,
    };

    res.setHeader(
      'set-cookie',
      serializeCookie(
        txCookieName,
        sealTransaction(transaction, deps.transactionSecret),
        transactionCookieAttributes(deps.cookie, TRANSACTION_TTL_SECONDS),
      ),
    );
    // 302 rather than a JSON body with a URL: the browser must *navigate*, and
    // a fetch that returned the URL would need the page to redirect itself,
    // which is a second place to get the destination wrong.
    res.redirect(302, request.url);
  }));

  // GET /auth/callback -----------------------------------------------------
  router.get('/callback', asyncRoute(async (req, res) => {
    const outcome = (value: (typeof AUTH_CALLBACK_OUTCOMES)[number]): void => {
      try {
        deps.onCallback?.(value);
      } catch {
        /* counting a sign-in must never break one */
      }
    };

    if (!deps.client || !deps.idTokenVerifier) {
      outcome('not_configured');
      signInFailed(req, res, 'unavailable', () =>
        sendError(res, 503, {
          code: 'AUTH_NOT_CONFIGURED',
          message: 'This deployment has no identity provider configured.',
        }),
      );
      return;
    }

    const clearTx = clearCookie(txCookieName, transactionCookieAttributes(deps.cookie));

    /*
     * The provider reporting a failure is not our failure to hide.
     *
     * `error_description` is provider-controlled text, so it is logged and not
     * reflected: reflecting it would put an attacker-influenced string on a
     * page the user is about to trust.
     */
    if (typeof req.query.error === 'string') {
      log(`sign-in refused by the identity provider: ${String(req.query.error).slice(0, 200)}`);
      outcome('provider_refused');
      res.setHeader('set-cookie', clearTx);
      signInFailed(req, res, 'refused', () =>
        sendError(res, 401, {
          code: 'AUTH_REFUSED',
          message: 'The identity provider did not complete sign-in.',
          remediation: 'Try signing in again.',
        }),
      );
      return;
    }

    const transaction = openTransaction(parseCookies(req.get('cookie'))[txCookieName], deps.transactionSecret);
    if (!transaction) {
      outcome('no_transaction');
      res.setHeader('set-cookie', clearTx);
      signInFailed(req, res, 'expired', () =>
        sendError(res, 400, {
          code: 'AUTH_NO_TRANSACTION',
          message: 'This sign-in could not be matched to a request from this browser.',
          remediation: 'Start sign-in again from the application.',
        }),
      );
      return;
    }

    // CSRF defence: the state we minted must come back exactly.
    if (!safeEquals(req.query.state, transaction.state)) {
      outcome('state_mismatch');
      res.setHeader('set-cookie', clearTx);
      signInFailed(req, res, 'expired', () =>
        sendError(res, 400, {
          code: 'AUTH_STATE_MISMATCH',
          message: 'This sign-in could not be matched to a request from this browser.',
          remediation: 'Start sign-in again from the application.',
        }),
      );
      return;
    }

    const code = req.query.code;
    if (typeof code !== 'string' || code.length === 0 || code.length > 4096) {
      outcome('no_code');
      res.setHeader('set-cookie', clearTx);
      signInFailed(req, res, 'failed', () =>
        sendError(res, 400, {
          code: 'AUTH_NO_CODE',
          message: 'The identity provider returned no authorization code.',
        }),
      );
      return;
    }

    let user: AuthenticatedUser;
    try {
      const tokens = await deps.client.exchangeCode(code, transaction.codeVerifier);
      const claims = await deps.idTokenVerifier.verify(tokens.idToken);
      // Replay defence: this token must answer *this* authorization request.
      assertNonceMatches(claims.nonce, transaction.nonce);
      // The access token and ID token stop here. Only the claims go further,
      // and only as a user row.
      user = await deps.users.upsert(claims);
    } catch (error) {
      outcome('verification_failed');
      res.setHeader('set-cookie', clearTx);
      signInFailed(req, res, reasonFor(error), () => authErrorResponse(res, error, 'complete sign-in'));
      return;
    }

    /*
     * Never reuse, always replace (BETA-P0-014).
     *
     * A browser arriving at the callback with a session cookie already set gets
     * that session destroyed and a brand-new id. Without this, a session id
     * planted before sign-in — or the previous user's, on a shared lab machine —
     * stayed live alongside the new one. Done only after the new identity is
     * verified, so a failed callback cannot be used to sign somebody out.
     */
    const previous = deps.browser.cookieFrom(req.get('cookie'));
    if (previous) await deps.authSessions.destroy(previous);

    const created = await deps.authSessions.create(user.userId, deps.cookie.ttlSeconds);

    res.setHeader('set-cookie', [
      clearTx,
      serializeCookie(
        deps.cookie.name,
        created.cookieValue,
        cookieAttributes(deps.cookie, deps.cookie.ttlSeconds),
      ),
    ]);

    outcome('success');

    // The identity is never in the redirect URL. The browser learns who it is
    // by calling /auth/session with the cookie it just received.
    // Re-sanitised here, not only at /auth/login: the value came back out of a
    // cookie, and the redirect must not depend on the signing key never leaking.
    res.redirect(302, `${deps.appUrl}${safeReturnTo(transaction.returnTo)}`);
  }));

  // POST /auth/logout ------------------------------------------------------
  // POST, not GET: a GET logout can be triggered by any page that can make the
  // browser fetch an image, which is a cross-site request forgery that logs
  // people out. Combined with SameSite=Lax on the cookie, a cross-site POST
  // does not carry it at all.
  router.post('/logout', asyncRoute(async (req, res) => {
    const cookieValue = deps.browser.cookieFrom(req.get('cookie'));

    /*
     * Destroy the record first, then clear the cookie.
     *
     * In that order the session is dead even if the browser ignores the
     * `Set-Cookie` — clearing the cookie alone would leave a live session id in
     * every proxy log that saw it.
     */
    if (cookieValue) {
      await deps.authSessions.destroy(cookieValue);
    }
    res.setHeader('set-cookie', clearCookie(deps.cookie.name, cookieAttributes(deps.cookie)));

    let endSessionUrl: string | null = null;
    if (deps.client) {
      try {
        endSessionUrl = await deps.client.endSessionUrl(deps.appUrl);
      } catch {
        // Best effort. The local session is already gone, which is the part
        // this platform controls.
        endSessionUrl = null;
      }
    }

    sendOk(res, {
      signedOut: true,
      ...(endSessionUrl ? { endSessionUrl } : {}),
    });
  }));

  return router;
}

/**
 * Translate a sign-in failure into a response.
 *
 * Coarse on purpose, exactly as `oidc.ts` is: an unauthenticated caller learning
 * *which* step failed learns something about the configuration.
 */
/**
 * Why a browser's sign-in did not complete, as the app's sign-in screen words it.
 *
 * `/auth/login` and `/auth/callback` are top-level navigations. A JSON error
 * body there is what the browser *displays*: a beta student the identity
 * provider refused (the way the private beta is restricted, D3), a student who
 * pressed Back after signing in, or anyone during a provider outage was left
 * reading `{"ok":false,"error":…}`. A navigation is sent back to the app with
 * one of these fixed words instead; the provider's own text is never carried.
 */
export const SIGN_IN_FAILURE_REASONS = ['refused', 'expired', 'unavailable', 'failed'] as const;
export type SignInFailureReason = (typeof SIGN_IN_FAILURE_REASONS)[number];

/** A browser navigating (Accept prefers HTML), as opposed to an API client or a script. */
function isBrowserNavigation(req: Request): boolean {
  return req.accepts(['json', 'html']) === 'html';
}

function reasonFor(error: unknown): SignInFailureReason {
  return error instanceof AuthError && error.code === 'AUTH_MISCONFIGURED' ? 'unavailable' : 'failed';
}

function authErrorResponse(res: Response, error: unknown, what: string): void {
  if (error instanceof AuthError) {
    const status = error.code === 'AUTH_MISCONFIGURED' ? 503 : 401;
    sendError(res, status, {
      code: error.code,
      message: error.message,
      ...(error.remediation ? { remediation: error.remediation } : {}),
    });
    return;
  }
  sendError(res, 401, {
    code: 'AUTH_INVALID_TOKEN',
    message: `Could not ${what}.`,
    remediation: 'Try signing in again.',
  });
}
