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
    try {
      const context = await sessions.getTerminalContext(String(req.params.sessionId));
      sendOk(res, context);
    } catch (error) {
      sessionErrorResponse(res, error);
    }
  }));

  return router;
}
