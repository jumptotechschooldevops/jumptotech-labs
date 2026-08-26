/**
 * Internal service-to-service routes.
 *
 * One endpoint: the terminal service exchanges a session id for the student's
 * namespace-scoped kubeconfig.
 *
 * ```text
 *   browser ──token──► terminal svc ──sid + service secret──► api
 *                                   ◄── kubeconfig (SA token, one namespace) ──
 * ```
 *
 * Why this exists rather than mounting a kubeconfig into the terminal
 * container: the mounted kubeconfig was the *cluster-admin* one. A student
 * shell must never hold it. Credentials are now minted per session, scoped to
 * one namespace, and expire with the session.
 *
 * Three properties this route must keep:
 *
 *   1. It is never reachable from the browser. It is not under `/api`, it is
 *      excluded from CORS, and it requires a shared service secret that the
 *      browser does not have.
 *   2. It takes a session id and returns credentials *for that session only* —
 *      it accepts no namespace, no ServiceAccount name, and no kubeconfig path.
 *   3. Its response is never logged.
 *   4. **It re-proves ownership** (PLATFORM-010). The caller must name the user
 *      the terminal token was minted for, and that name must still match the
 *      live session record. See below.
 */
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { SessionManager } from '@jumptotech/lab-orchestrator';
import type { ApiConfig } from '../config.js';
import { asyncRoute, sendError, sendOk } from '../http.js';
import { sessionErrorResponse } from './sessions.js';

export interface InternalRoutesDeps {
  sessions: SessionManager;
  config: ApiConfig;
}

function secretsMatch(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createInternalRoutes(deps: InternalRoutesDeps): Router {
  const { sessions, config } = deps;
  const router = Router();

  router.use((req, res, next) => {
    if (!secretsMatch(req.get('x-internal-secret'), config.internalServiceSecret)) {
      sendError(res, 401, {
        code: 'UNAUTHORIZED',
        message: 'This endpoint is for internal service use only.',
      });
      return;
    }
    next();
  });

  /*
   * POST /internal/sessions/:sessionId/credentials
   *
   * ## The ownership re-check — PLATFORM-010
   *
   * Before this, a valid terminal-session HMAC was on its own sufficient to
   * obtain a session's terminal binding. Every REST route proved ownership
   * against the stored `ownerUserId`; this path proved only that a token had
   * been signed at some point. That asymmetry is the WebSocket bypass: the two
   * paths reach the same sandbox and only one of them checked.
   *
   * So the terminal service now sends the `uid` claim from the token it just
   * verified, and this route compares it with the *live* session record — the
   * same source of truth `authorize()` uses. Three consequences:
   *
   *   - a token for session A cannot be used to open session B, because the
   *     session id and the owner must agree with one stored row;
   *   - a token outlives neither its session's ownership nor the owner's
   *     account, so a leaked token stops working when either changes;
   *   - a request with no `ownerUserId` is refused rather than served, which is
   *     what makes an old token fail closed.
   *
   * The failure is 403 rather than 404: the caller is an authenticated internal
   * service, not a browser guessing ids, so there is no enumeration oracle to
   * protect and an operator debugging this needs the real reason.
   *
   * PLATFORM-004 generalised this from "hand back a kubeconfig" to "hand back
   * the terminal binding for whatever sandbox this session has". The response
   * is a closed, typed union — `kubernetes` or `container-exec` — and carries
   * no command line: the terminal service builds its own argv from the variant
   * after re-validating every field. So even a compromised API cannot talk the
   * terminal into running an arbitrary command.
   *
   * The Kubernetes variant keeps `kubeconfig` and `namespace` at the top level,
   * where they have always been, so nothing that already reads this changes.
   */
  router.post('/sessions/:sessionId/credentials', asyncRoute(async (req, res) => {
    const sessionId = String(req.params.sessionId);
    const claimedOwner = (req.body as { ownerUserId?: unknown } | undefined)?.ownerUserId;

    if (typeof claimedOwner !== 'string' || claimedOwner.length === 0) {
      sendError(res, 400, {
        code: 'OWNER_REQUIRED',
        message: 'A terminal credential request must name the session owner it was issued for.',
        remediation:
          'Re-issue the terminal session token: tokens minted before ownership binding are not accepted.',
      });
      return;
    }

    try {
      const session = await sessions.require(sessionId);

      /*
       * An unowned session is reachable by nobody, exactly as `policy.ts` says
       * for the HTTP path — including by a service holding a valid token.
       */
      if (!session.ownerUserId || session.ownerUserId !== claimedOwner) {
        sendError(res, 403, {
          code: 'SESSION_NOT_OWNED',
          message: 'That terminal token is not valid for this session.',
        });
        return;
      }

      const context = await sessions.getTerminalContext(sessionId);
      sendOk(res, context);
    } catch (error) {
      sessionErrorResponse(res, error);
    }
  }));

  return router;
}
