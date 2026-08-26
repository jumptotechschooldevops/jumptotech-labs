/**
 * Attaching identity to a request, and enforcing what it may do — PLATFORM-009.
 *
 * Two pieces, deliberately separate. `authenticate` establishes *who*; the
 * session guard establishes *whether*. Splitting them means a route cannot
 * accidentally get the second by asking for the first.
 */
import type { NextFunction, Request, Response } from 'express';
import type { LabSession, SessionManager } from '@jumptotech/lab-orchestrator';
import { AuthError, type AuthenticatedUser, type IdentityResolver } from './identity.js';
import type { BrowserSessionAuthenticator } from './browser-authenticator.js';
import { authorize, type Action } from './policy.js';
import { sendError } from '../http.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `authenticate`. Never set from anything the client sent. */
    user?: AuthenticatedUser;
  }
}

/** One audit line per authorization decision. Never carries a credential. */
export interface AuthAuditEvent {
  requestId: string;
  authenticatedUserId: string | null;
  action: string;
  sessionId?: string;
  authorizationResult: 'allowed' | 'denied-not-owner' | 'denied-unowned' | 'denied-role' | 'unauthenticated';
  timestamp: string;
}

export type AuthAuditLogger = (event: AuthAuditEvent) => void;

function requestId(req: Request): string {
  const header = req.get('x-request-id');
  return header && /^[A-Za-z0-9._-]{1,128}$/.test(header) ? header : 'req-unknown';
}

/**
 * Resolve the caller, or refuse the request.
 *
 * Two credentials are accepted, in a fixed order, and **neither carries a user
 * identifier the client chose**:
 *
 * ```text
 *   1. Cookie: jtt_session=<opaque id>   the browser (PLATFORM-010)
 *        └─ an index into a server-side record; the record names the user
 *   2. Authorization: <credential>       services, tests, development mode
 *        └─ a signed token; the signature names the user
 * ```
 *
 * The cookie is tried first because it is the browser's path and the browser is
 * the common case. A request carrying neither reaches the header resolver with
 * `undefined`, which is what makes the development resolver's "no header means
 * the default identity" behaviour — and the OIDC resolver's 401 — unchanged.
 *
 * A cookie that is *present but unusable* is a refusal, never a fall-through: a
 * stale session must not quietly degrade into whatever the header path would
 * have produced.
 */
export function authenticate(
  resolver: IdentityResolver,
  audit: AuthAuditLogger = () => {},
  browser?: BrowserSessionAuthenticator,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const fromCookie = browser ? await browser.authenticate(req.get('cookie')) : null;
      req.user = fromCookie ?? (await resolver.resolve(req.get('authorization')));
      next();
    } catch (error) {
      const authError =
        error instanceof AuthError
          ? error
          : new AuthError('AUTH_INVALID_TOKEN', 'The credentials supplied are not valid.');

      audit({
        requestId: requestId(req),
        authenticatedUserId: null,
        action: `${req.method} ${req.path}`,
        authorizationResult: 'unauthenticated',
        timestamp: new Date().toISOString(),
      });

      // 401 with a stable shape. The message never says which part of a token
      // failed — that distinction is an oracle for a caller guessing.
      sendError(res, authError.code === 'AUTH_REQUIRED' ? 401 : 401, {
        code: authError.code,
        message: authError.message,
        ...(authError.remediation ? { remediation: authError.remediation } : {}),
      });
    }
  };
}

export interface SessionGuardResult {
  user: AuthenticatedUser;
  session: LabSession;
}

/**
 * Resolve a session **and** prove the caller may act on it.
 *
 * Returns `null` after having already answered the request, so a handler reads:
 *
 * ```ts
 * const ok = await guard(req, res, 'session:reset');
 * if (!ok) return;
 * ```
 *
 * A student asking about somebody else's session gets exactly what they get for
 * a session that does not exist — a 404. Distinguishing them would confirm the
 * id is real and turn guessing into enumeration.
 */
/** What `createSessionGuard` returns; routers depend on this, not the factory. */
export type SessionGuard = (
  req: Request,
  res: Response,
  action: Action,
) => Promise<SessionGuardResult | null>;

export function createSessionGuard(
  sessions: SessionManager,
  audit: AuthAuditLogger = () => {},
) {
  return async function guard(
    req: Request,
    res: Response,
    action: Action,
  ): Promise<SessionGuardResult | null> {
    const user = req.user;
    if (!user) {
      sendError(res, 401, { code: 'AUTH_REQUIRED', message: 'This request requires authentication.' });
      return null;
    }

    const sessionId = String(req.params.sessionId ?? '');
    let session: LabSession;
    try {
      session = await sessions.require(sessionId);
    } catch (error) {
      /*
       * A malformed id is a validation error, not an existence one.
       *
       * The 404-for-everything rule exists so a caller cannot learn which
       * *valid* ids are real. An id that could never be valid tells them
       * nothing about that, and answering 400 keeps a genuinely useful signal
       * for a client that built a bad request.
       */
      if ((error as { code?: unknown })?.code === 'INVALID_SESSION_ID') {
        sendError(res, 400, {
          code: 'INVALID_SESSION_ID',
          message: 'Session ids look like sess-<hex>.',
        });
        return null;
      }
      audit({
        requestId: requestId(req),
        authenticatedUserId: user.userId,
        action,
        sessionId,
        authorizationResult: 'denied-not-owner',
        timestamp: new Date().toISOString(),
      });
      sendError(res, 404, { code: 'SESSION_NOT_FOUND', message: 'No such lab session.' });
      return null;
    }

    const decision = authorize(user, action, {
      sessionId: session.sessionId,
      ownerUserId: session.ownerUserId,
    });

    audit({
      requestId: requestId(req),
      authenticatedUserId: user.userId,
      action,
      sessionId: session.sessionId,
      authorizationResult: decision.allowed
        ? 'allowed'
        : decision.reason === 'unowned'
          ? 'denied-unowned'
          : decision.reason === 'role'
            ? 'denied-role'
            : 'denied-not-owner',
      timestamp: new Date().toISOString(),
    });

    if (!decision.allowed) {
      sendError(res, 404, { code: 'SESSION_NOT_FOUND', message: 'No such lab session.' });
      return null;
    }

    return { user, session };
  };
}

/** Guard a route that needs a role rather than a session. */
export function requireAction(action: Action, audit: AuthAuditLogger = () => {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      sendError(res, 401, { code: 'AUTH_REQUIRED', message: 'This request requires authentication.' });
      return;
    }
    const decision = authorize(user, action);
    audit({
      requestId: requestId(req),
      authenticatedUserId: user.userId,
      action,
      authorizationResult: decision.allowed ? 'allowed' : 'denied-role',
      timestamp: new Date().toISOString(),
    });
    if (!decision.allowed) {
      // A role failure is a 403: the caller is known, the resource is not
      // secret, and telling them they lack permission is actionable rather
      // than an oracle.
      sendError(res, 403, {
        code: 'FORBIDDEN',
        message: 'Your account does not have permission to do that.',
      });
      return;
    }
    next();
  };
}
