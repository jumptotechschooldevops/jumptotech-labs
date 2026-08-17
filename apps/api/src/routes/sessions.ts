/**
 * Session-scoped routes.
 *
 * ```text
 *   GET    /api/sessions/:sessionId            live status + countdowns
 *   POST   /api/sessions/:sessionId/check      verify against THIS namespace
 *   POST   /api/sessions/:sessionId/reset      restore THIS namespace only
 *   POST   /api/sessions/:sessionId/activity   "Continue Lab" / terminal keepalive
 *   DELETE /api/sessions/:sessionId            End Lab
 * ```
 *
 * **Authorization, honestly labelled.** PLATFORM-002 has no user
 * authentication. Possessing the session id is what authorises these calls, and
 * that is an MVP mechanism, NOT production authentication — it is why session
 * ids are 64 bits of `crypto.randomBytes` rather than a counter. Real identity
 * arrives in a later story; until then this is documented as a limitation in
 * the README rather than dressed up as security.
 *
 * What is *already* true, and stays true when auth arrives: the namespace is
 * never an input. It is looked up from the session record on every request, so
 * learning or guessing a namespace name grants nothing at all — there is no
 * route that accepts one.
 */
import { Router, type Response } from 'express';
import {
  SessionError,
  type KubernetesPort,
  type LabRegistry,
  type LabSession,
  type SessionManager,
} from '@jumptotech/lab-orchestrator';
import { verifyLab } from '@jumptotech/verifier';
import type { ProgressService, StudentIdentityResolver } from '@jumptotech/progress';
import type { ApiConfig } from '../config.js';
import { asyncRoute, sendError, sendOk } from '../http.js';
import { progressErrorResponse } from '../identity.js';
import { record } from '../progress.js';
import { toAttemptPayload } from './me.js';

export interface SessionRoutesDeps {
  registry: LabRegistry;
  sessions: SessionManager;
  k8s: KubernetesPort;
  config: ApiConfig;
  /**
   * Persistent learning state (PLATFORM-005).
   *
   * Every write here is addressed by the session id the caller already holds;
   * the attempt — and therefore the student — is resolved server-side. No route
   * on this router accepts an attempt id or a student id.
   */
  progress: ProgressService;
  identity: StudentIdentityResolver;
  /** False when history is in memory only. */
  durable: boolean;
  logger?: (message: string) => void;
}

/** HTTP status for each session-domain error code. */
const STATUS_BY_CODE: Record<string, number> = {
  PROVIDER_UNAVAILABLE: 503,
  LAB_CAPACITY_REACHED: 503,
  SESSION_NOT_FOUND: 404,
  SESSION_NOT_ACTIVE: 409,
  INVALID_SESSION_ID: 400,
  SESSION_PROVISION_FAILED: 503,
  SESSION_RESET_FAILED: 503,
  SESSION_CLEANUP_FAILED: 503,
  CREDENTIALS_UNAVAILABLE: 503,
};

export function sessionErrorResponse(res: Response, error: unknown): void {
  if (error instanceof SessionError) {
    sendError(res, STATUS_BY_CODE[error.code] ?? 500, {
      code: error.code,
      message: error.message,
      ...(error.remediation ? { remediation: error.remediation } : {}),
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }
  throw error;
}

/**
 * The client-facing session shape.
 *
 * Deliberately excludes anything credential-shaped. The namespace is included
 * because the UI shows it in a developer panel and it is not a secret — it
 * grants nothing on its own — but no token, kubeconfig, or ServiceAccount
 * detail ever crosses this boundary.
 */
export function toSessionPayload(manager: SessionManager, session: LabSession) {
  const view = manager.view(session);
  return {
    sessionId: view.sessionId,
    labId: view.labId,
    status: view.status,
    /*
     * Which sandbox backend the session runs on, and the sandbox's own handle.
     *
     * `sandboxRef` is a developer detail shown in the terminal pane header, and
     * possessing it grants nothing: no endpoint accepts a sandbox reference as
     * input, and every operation resolves one from the session record. It is
     * derived from the session id through a keyed HMAC, so it cannot be
     * inverted back into the capability that does control the session.
     *
     * `namespace` is served only for Kubernetes sessions. A Linux session has
     * no namespace, and echoing the container name under that key would be a
     * lie the UI would then repeat.
     */
    provider: view.provider,
    sandboxKind: view.sandboxKind,
    sandboxRef: view.sandboxRef,
    ...(view.provider === 'kubernetes' ? { namespace: view.namespace } : {}),
    createdAt: view.createdAt,
    lastActivityAt: view.lastActivityAt,
    expiresAt: view.expiresAt,
    ...(view.endedAt ? { endedAt: view.endedAt } : {}),
    ...(view.statusReason ? { statusReason: view.statusReason } : {}),
    secondsRemaining: view.secondsRemaining,
    secondsUntilIdle: view.secondsUntilIdle,
    idleWarning: view.idleWarning,
    idleTimeoutSeconds: view.idleTimeoutSeconds,
    warningSeconds: view.warningSeconds,
  };
}

export function createSessionRoutes(deps: SessionRoutesDeps): Router {
  const { registry, sessions, k8s, progress } = deps;
  const log = deps.logger ?? (() => undefined);
  const router = Router();

  // GET /api/sessions/:sessionId -------------------------------------------
  // Polling this deliberately does NOT count as activity: an abandoned browser
  // tab must not be able to keep a sandbox alive forever.
  router.get('/:sessionId', asyncRoute(async (req, res) => {
    let session: LabSession;
    try {
      session = await sessions.require(req.params.sessionId);
    } catch (error) {
      sessionErrorResponse(res, error);
      return;
    }

    let environment = null;
    if (session.status === 'ACTIVE' || session.status === 'RESETTING') {
      environment = await sessions.status(session);
    }

    sendOk(res, { session: toSessionPayload(sessions, session), environment });
  }));

  // POST /api/sessions/:sessionId/activity ---------------------------------
  // Backs the "Continue Lab" button. It moves the idle deadline only; the
  // absolute deadline is untouched, so this can never extend a lab forever.
  router.post('/:sessionId/activity', asyncRoute(async (req, res) => {
    try {
      const session = await sessions.require(req.params.sessionId);
      const updated = (await sessions.touch(session.sessionId, 'continue')) ?? session;
      sendOk(res, { session: toSessionPayload(sessions, updated) });
    } catch (error) {
      sessionErrorResponse(res, error);
    }
  }));

  // POST /api/sessions/:sessionId/check ------------------------------------
  router.post('/:sessionId/check', asyncRoute(async (req, res) => {
    let session: LabSession;
    try {
      ({ session } = await sessions.requireActive(req.params.sessionId));
    } catch (error) {
      sessionErrorResponse(res, error);
      return;
    }

    const lab = registry.get(session.labId);
    /*
     * The readers are built from the session record, never from the request.
     *
     * The Kubernetes reader is scoped to this session's namespace; the sandbox
     * reader is bound to this session's container. A correct Pod — or a correct
     * file — in someone else's environment is invisible here, and there is no
     * request field anywhere that could name another one.
     */
    const sandboxPort = sessions.sandboxPort(session);
    const result = await verifyLab({
      lab,
      namespace: session.sandboxRef ?? session.namespace,
      ...(session.provider === 'kubernetes' ? { k8s } : {}),
      ...(sandboxPort ? { sandbox: sandboxPort } : {}),
    });
    await sessions.touch(session.sessionId, 'check');

    if (result.error) {
      // The environment could not be read, so no check actually happened —
      // recording one would inflate `check_count` with a cluster outage.
      sendError(res, 503, {
        code: result.error.code,
        message: result.error.message,
        remediation: 'Start the lab environment before checking your solution.',
        details: { checks: result.checks },
      });
      return;
    }

    /*
     * Persist the check, and the completion if this was the passing one.
     *
     * Wrapped in `record`: a bookkeeping failure must not turn a successful
     * verification into an error for the student. The attempt is resolved from
     * the session, and a repeated PASS updates nothing — the store decides that,
     * not this route.
     */
    const outcome = await record(log, 'record check', () =>
      progress.recordCheck(session.sessionId, result.passed),
    );

    // A failing lab is a successful *check*: HTTP 200 with passed:false.
    sendOk(res, {
      ...result,
      session: toSessionPayload(sessions, session),
      ...(outcome
        ? {
            attempt: toAttemptPayload(outcome.attempt, registry),
            /** True only for the check that first completed this attempt. */
            newlyCompleted: outcome.newlyCompleted,
          }
        : {}),
    });
  }));

  // POST /api/sessions/:sessionId/hints -------------------------------------
  // Records that a hint was revealed. Idempotent per (attempt, hint level): a
  // replayed request returns the original record rather than counting twice.
  router.post('/:sessionId/hints', asyncRoute(async (req, res) => {
    let session: LabSession;
    try {
      session = await sessions.require(req.params.sessionId);
    } catch (error) {
      sessionErrorResponse(res, error);
      return;
    }

    const body = (req.body ?? {}) as { level?: unknown };
    let outcome;
    try {
      outcome = await progress.recordHint(session.sessionId, body.level as number);
    } catch (error) {
      if (progressErrorResponse(res, error)) return;
      // The store is unavailable. Revealing a hint still worked in the browser;
      // saying otherwise would be a worse lie than losing the record.
      log(`could not record hint: ${error instanceof Error ? error.message : String(error)}`);
      sendOk(res, { recorded: false, persisted: false, revealedCount: null });
      return;
    }

    if (!outcome) {
      // No attempt for this session (started before progress existed, or the
      // attempt could not be written). Nothing to record; not an error.
      sendOk(res, { recorded: false, persisted: false, revealedCount: null });
      return;
    }

    sendOk(res, {
      recorded: outcome.recorded,
      persisted: true,
      hint: { level: outcome.usage.hintIndex, revealedAt: outcome.usage.revealedAt },
      revealedCount: outcome.revealedCount,
    });
  }));

  // POST /api/sessions/:sessionId/reset ------------------------------------
  router.post('/:sessionId/reset', asyncRoute(async (req, res) => {
    try {
      const { session, result } = await sessions.reset(String(req.params.sessionId));
      if (!result.ok) {
        sendError(res, 503, {
          code: result.error?.code ?? 'RESET_FAILED',
          message: result.error?.message ?? 'Failed to reset the lab environment',
          details: { steps: result.steps, removed: result.removed },
        });
        return;
      }

      /*
       * A reset wipes the sandbox, never the record.
       *
       * `reset_count` goes up; the attempt, its checks, and any completion it
       * already earned stay exactly as they were. That asymmetry is the whole
       * point of keeping learning state outside the sandbox.
       */
      const attempt = await record(log, 'record reset', () =>
        progress.recordReset(session.sessionId),
      );

      sendOk(res, {
        message: 'Lab reset successfully.',
        ...(attempt ? { attempt: toAttemptPayload(attempt, registry) } : {}),
        removed: result.removed,
        restored: result.restored,
        steps: result.steps,
        environment: result.environment,
        session: toSessionPayload(sessions, session),
        /** Tells the UI it is safe to clear the terminal scrollback. */
        clearTerminal: true,
        /*
         * Container-backed providers reset by replacing the sandbox, which
         * necessarily ends the `docker exec` the student's shell was running.
         * The UI reconnects rather than leaving a dead terminal on screen.
         * A Kubernetes reset keeps the namespace and the shell, so it does not
         * ask for this.
         */
        reconnectTerminal: session.sandboxKind === 'container',
      });
    } catch (error) {
      sessionErrorResponse(res, error);
    }
  }));

  // DELETE /api/sessions/:sessionId ----------------------------------------
  // End Lab: terminate the terminal, delete the namespace, release the slot.
  //
  // The *attempt* is closed by the session manager's lifecycle listener, not
  // here — see apps/api/src/progress.ts. Ending a lab and the reaper expiring
  // one therefore travel the same path and cannot record different things.
  // Nothing is deleted from history either way.
  router.delete('/:sessionId', asyncRoute(async (req, res) => {
    try {
      const { session, destroy } = await sessions.end(String(req.params.sessionId));
      if (!destroy.namespaceGone) {
        sendError(res, 503, {
          code: destroy.error?.code ?? 'DESTROY_FAILED',
          message: destroy.error?.message ?? 'The lab environment is still shutting down.',
          remediation: 'Cleanup will retry automatically within a minute.',
          details: { steps: destroy.steps, session: toSessionPayload(sessions, session) },
        });
        return;
      }

      // Read back the closed attempt so the UI can show the outcome that was
      // actually persisted rather than inferring one from the session status.
      const attempt = await record(log, 'read attempt', () =>
        progress.attemptForSession(session.sessionId),
      );

      sendOk(res, {
        message: 'Lab environment released.',
        session: toSessionPayload(sessions, session),
        ...(attempt ? { attempt: toAttemptPayload(attempt, registry) } : {}),
        steps: destroy.steps,
      });
    } catch (error) {
      sessionErrorResponse(res, error);
    }
  }));

  return router;
}
