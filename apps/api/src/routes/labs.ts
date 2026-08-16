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
  titleCase,
  type LabRegistry,
  type LoadedLabDefinition,
} from '@jumptotech/lab-orchestrator';
import { sendError, sendOk } from '../http.js';
import { sessionErrorResponse, toSessionPayload, type SessionRoutesDeps } from './sessions.js';

/**
 * Public, student-safe shape of a lab.
 *
 * Everything the UI renders comes from lab.yaml. Three things are deliberately
 * *not* projected, because a student could otherwise read the answer before
 * starting:
 *
 *   - `setup`, which for a troubleshooting lab is the injected fault itself;
 *   - `reset`, an internal purge policy;
 *   - the requirement objects, whose fields (expected image, expected
 *     selector, expected schedule) are the solution in machine-readable form.
 *
 * Requirements are flattened to their `label` — the schema makes that label
 * mandatory precisely so this projection never has to fall back to a raw
 * requirement type.
 */
export function toLabDetail(def: LoadedLabDefinition, registry?: LabRegistry) {
  return {
    id: def.id,
    slug: def.slug,
    title: def.title,
    track: def.track,
    topic: def.topic,
    topicTitle: titleCase(def.topic),
    difficulty: def.difficulty,
    level: def.level,
    durationMinutes: def.duration_minutes,
    environment: { provider: def.environment.provider, isolation: def.environment.isolation },
    ...(def.story ? { story: def.story } : {}),
    objectives: def.objectives,
    task: { summary: def.task.summary, description: def.task.description },
    // Student-facing checklist, derived from the same requirements the verifier
    // executes — so the UI and the verifier can never drift apart.
    requirements: def.requirements.map((r) => r.label ?? r.type),
    hints: def.hints,
    references: def.references,
    skills: def.skills,
    certifications: def.certification
      .filter((c) => c.relevant)
      .map((c) => ({ certification: c.certification, domains: c.domains })),
    prerequisites: registry
      ? registry.prerequisitesOf(def)
      : def.prerequisites.map((id) => ({ id, title: id, available: false })),
    /**
     * Prerequisites are advisory in PLATFORM-003.
     *
     * There are no authenticated users and no stored progress yet, so nothing
     * is enforced per student. This flag is served explicitly rather than left
     * implicit, so the UI states the truth instead of implying a gate that
     * does not exist.
     */
    prerequisitesEnforced: false,
    /** True when the lab seeds resources the student starts from. */
    hasSetup: def.setup.manifests.length > 0,
  };
}

/**
 * Read catalog filters from the query string.
 *
 * Only known keys are honoured and each is length-capped, so a filter can
 * never become an unbounded string that reaches the registry.
 */
export function readFilter(req: Request): {
  track?: string;
  topic?: string;
  difficulty?: string;
  level?: string;
  q?: string;
} {
  const read = (key: string): string | undefined => {
    const raw = req.query[key];
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim().slice(0, 64);
    return trimmed.length > 0 ? trimmed : undefined;
  };

  return {
    ...(read('track') !== undefined ? { track: read('track')! } : {}),
    ...(read('topic') !== undefined ? { topic: read('topic')! } : {}),
    ...(read('difficulty') !== undefined ? { difficulty: read('difficulty')! } : {}),
    ...(read('level') !== undefined ? { level: read('level')! } : {}),
    ...(read('q') !== undefined ? { q: read('q')! } : {}),
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
  // Optional filters: ?track= &topic= &difficulty= &level= &q=
  // Unknown filter values are not an error; they simply match nothing.
  router.get('/', (req, res) => {
    const labs = registry.list(readFilter(req));
    sendOk(res, {
      labs,
      tracks: registry.tracks(),
      count: labs.length,
      prerequisitesEnforced: false,
    });
  });

  // GET /api/labs/:id ------------------------------------------------------
  router.get('/:id', (req, res) => {
    const def = resolveLab(req, res);
    if (!def) return;
    sendOk(res, toLabDetail(def, registry));
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
