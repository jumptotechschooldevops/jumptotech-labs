/**
 * Lab catalog + Start Lab.
 *
 * Security note: none of these endpoints execute student-supplied commands.
 * `POST /:id/start` provisions an isolated session sandbox and mints a
 * short-lived terminal session token bound to that session; the actual shell
 * lives behind the separate terminal WebSocket service, which verifies the
 * token and resolves credentials from the session id inside it.
 *
 * Everything that acts on a *running* environment (check, reset, activity, end)
 * lives under `/api/sessions/:sessionId` instead — see `sessions.ts`. That
 * split is the PLATFORM-002 change: an operation is addressed by the session
 * that owns the sandbox, never by the lab id, because two students on the same
 * lab now have two different sandboxes.
 */
import { Router, type Request, type Response } from 'express';
import {
  InvalidLabIdError,
  LabNotFoundError,
  assertValidLabId,
  issueSessionToken,
  type LoadedLabDefinition,
} from '@jumptotech/lab-orchestrator';
import { sendError, sendOk } from '../http.js';
import { sessionErrorResponse, toSessionPayload, type SessionRoutesDeps } from './sessions.js';

/** Public shape of a lab — everything the UI renders comes from lab.yaml. */
export function toLabDetail(def: LoadedLabDefinition) {
  return {
    id: def.id,
    slug: def.slug,
    title: def.title,
    track: def.track,
    topic: def.topic,
    difficulty: def.difficulty,
    level: def.level,
    durationMinutes: def.duration_minutes,
    environment: { provider: def.environment.provider, isolation: def.environment.isolation },
    task: { summary: def.task.summary, description: def.task.description },
    // Student-facing checklist, derived from the same requirements the verifier
    // executes — so the UI and the verifier can never drift apart.
    requirements: def.requirements.map((r) => r.label ?? r.type),
    hints: def.hints,
    references: def.references,
    skills: def.skills,
  };
}

/** Translate domain errors into HTTP responses. */
function handleDomainError(res: Response, error: unknown): boolean {
  if (error instanceof InvalidLabIdError) {
    sendError(res, 400, {
      code: 'INVALID_LAB_ID',
      message: error.message,
      remediation: 'Lab ids look like K8S-001.',
    });
    return true;
  }
  if (error instanceof LabNotFoundError) {
    sendError(res, 404, { code: 'LAB_NOT_FOUND', message: error.message });
    return true;
  }
  return false;
}

export function createLabRoutes(deps: SessionRoutesDeps): Router {
  const { registry, sessions, config } = deps;
  const router = Router();

  /** Resolve `:id` → definition, replying with the right error if it fails. */
  function resolveLab(req: Request, res: Response): LoadedLabDefinition | null {
    try {
      const labId = assertValidLabId(req.params.id);
      return registry.get(labId);
    } catch (error) {
      if (handleDomainError(res, error)) return null;
      throw error;
    }
  }

  // GET /api/labs ----------------------------------------------------------
  router.get('/', (_req, res) => {
    const labs = registry.list();
    sendOk(res, { labs, tracks: registry.tracks(), count: labs.length });
  });

  // GET /api/labs/:id ------------------------------------------------------
  router.get('/:id', (req, res) => {
    const def = resolveLab(req, res);
    if (!def) return;
    sendOk(res, toLabDetail(def));
  });

  // POST /api/labs/:id/start ----------------------------------------------
  router.post('/:id/start', async (req, res) => {
    const def = resolveLab(req, res);
    if (!def) return;

    let started;
    try {
      started = await sessions.start(def.id);
    } catch (error) {
      sessionErrorResponse(res, error);
      return;
    }

    // The token is bound to this session id. The browser never sees the
    // namespace as a credential, and never sees a kubeconfig at all.
    const { token } = issueSessionToken({
      sessionId: started.session.sessionId,
      labId: def.id,
      namespace: started.session.namespace,
      secret: config.terminalSessionSecret,
      ttlSeconds: Math.min(
        config.terminalSessionTtlSeconds,
        Math.max(60, Math.ceil((Date.parse(started.session.expiresAt) - Date.now()) / 1000)),
      ),
    });

    sendOk(res, {
      session: toSessionPayload(sessions, started.session),
      environment: started.environment,
      steps: started.steps,
      terminal: {
        url: config.terminalWsUrl,
        // Presented to the terminal service over the WebSocket handshake.
        token,
      },
    });
  });

  return router;
}
