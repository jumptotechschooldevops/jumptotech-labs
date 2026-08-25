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
  type SessionManager,
} from '@jumptotech/lab-orchestrator';
import type { LabAttempt } from '@jumptotech/progress';
import { asyncRoute, sendError, sendOk } from '../http.js';
import { progressErrorResponse, resolveStudent } from '../identity.js';
import { record } from '../progress.js';
import { resolveTerminalWsBaseForClient } from '../public-origin.js';
import { toAttemptPayload } from './me.js';
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

/**
 * Provider readiness, keyed by provider id.
 *
 * The catalog's honesty rule: a lab is only offered as startable when the
 * backend that would run it can actually run it. A missing sandbox image, a
 * stopped Docker daemon, a cluster that is down, and a provider that is
 * deliberately architecture-only all produce the same shape — `available:
 * false` plus the real reason — so the UI never has to guess and never shows a
 * Start Lab button that was always going to fail.
 */
export type ProviderReadiness = Map<string, LabProviderReadiness>;

export interface LabProviderReadiness {
  provider: string;
  available: boolean;
  reason?: string;
  remediation?: string;
}

async function providerReadiness(sessions: SessionManager): Promise<ProviderReadiness> {
  const statuses = await sessions.providers.statuses();
  return new Map(
    statuses.map((status) => [
      status.providerId,
      {
        provider: status.providerId,
        available: status.available,
        ...(status.reason ? { reason: status.reason } : {}),
        ...(status.remediation ? { remediation: status.remediation } : {}),
      },
    ]),
  );
}

function availabilityFor(provider: string, readiness: ProviderReadiness): LabProviderReadiness {
  return (
    readiness.get(provider) ?? {
      provider,
      available: false,
      reason: `no implementation is registered for the '${provider}' provider`,
    }
  );
}

function withAvailability<T extends { provider: string }>(lab: T, readiness: ProviderReadiness) {
  return { ...lab, availability: availabilityFor(lab.provider, readiness) };
}

/**
 * A track is startable when *any* of its labs' providers is.
 *
 * Tracks map to one provider today, but the catalog groups by track rather
 * than by provider, and a future track could mix them — so the readiness is
 * derived from the providers actually present in the track rather than assumed.
 */
function withTrackAvailability(
  track: { track: string; providers: string[] },
  readiness: ProviderReadiness,
) {
  const statuses = track.providers.map((provider) => availabilityFor(provider, readiness));
  const blocked = statuses.filter((status) => !status.available);
  return {
    ...track,
    availability: {
      available: statuses.some((status) => status.available),
      ...(blocked.length > 0 && blocked[0]?.reason ? { reason: blocked[0].reason } : {}),
      ...(blocked.length > 0 && blocked[0]?.remediation
        ? { remediation: blocked[0].remediation }
        : {}),
    },
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
  const { registry, sessions, config, progress, identity } = deps;
  const log = deps.logger ?? (() => undefined);
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
  router.get('/', asyncRoute(async (req, res) => {
    const labs = registry.list(readFilter(req));
    const readiness = await providerReadiness(sessions);
    sendOk(res, {
      labs: labs.map((lab) => withAvailability(lab, readiness)),
      tracks: registry.tracks().map((track) => withTrackAvailability(track, readiness)),
      providers: [...readiness.values()],
      count: labs.length,
      prerequisitesEnforced: false,
    });
  }));

  // GET /api/labs/:id ------------------------------------------------------
  router.get('/:id', asyncRoute(async (req, res) => {
    const def = resolveLab(req, res);
    if (!def) return;
    const readiness = await providerReadiness(sessions);
    sendOk(res, {
      ...toLabDetail(def, registry),
      availability: availabilityFor(def.environment.provider, readiness),
    });
  }));

  // POST /api/labs/:id/start ----------------------------------------------
  router.post('/:id/start', asyncRoute(async (req, res) => {
    const def = resolveLab(req, res);
    if (!def) return;

    /*
     * The attempt is opened *before* the sandbox exists.
     *
     * That order is the architecture rule made executable: the attempt is the
     * parent of the session, not a footnote on it. A start that never gets an
     * environment still leaves an honest FAILED record, and the sandbox that
     * follows can be destroyed without taking anything with it.
     *
     * It is best-effort on purpose. If the progress store is down the lab still
     * starts — the student loses the record, not the lesson.
     */
    let identityUsed;
    try {
      identityUsed = resolveStudent(identity, req);
    } catch (error) {
      if (progressErrorResponse(res, error)) return;
      throw error;
    }

    const attempt = await record(log, 'open attempt', () =>
      progress.startAttempt({
        studentId: identityUsed.studentId,
        labId: def.id,
        track: def.track,
        identitySource: identityUsed.source,
      }),
    );

    /*
     * The session belongs to the authenticated caller, decided here.
     *
     * `req.user` was resolved from the Authorization header before this handler
     * ran. Nothing reads a body or query field, so a browser has no way to
     * start a lab on somebody else's behalf — there is no owner parameter to
     * send.
     */
    const owner = req.user;
    if (!owner) {
      sendError(res, 401, {
        code: 'AUTH_REQUIRED',
        message: 'Starting a lab requires authentication.',
      });
      return;
    }

    let started;
    try {
      started = await sessions.start(def.id, owner.userId);
    } catch (error) {
      // The sandbox never came up. Close the attempt honestly rather than
      // leaving a row that says the student is still working on it.
      if (attempt) {
        await record(log, 'close failed attempt', () =>
          progress.failAttempt(
            attempt.attemptId,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
      sessionErrorResponse(res, error);
      return;
    }

    // Bind the sandbox to the attempt. From here on every session-scoped write
    // finds its attempt through this one column.
    let bound: LabAttempt | undefined = attempt;
    if (attempt) {
      bound =
        (await record(log, 'bind session to attempt', () =>
          progress.bindSession(attempt.attemptId, started.session.sessionId),
        )) ?? attempt;
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
      ...(bound ? { attempt: toAttemptPayload(bound, registry) } : {}),
      environment: started.environment,
      steps: started.steps,
      terminal: {
        url: resolveTerminalWsBaseForClient(req, {
          publicOrigin: config.publicOrigin,
          defaultTerminalWsUrl: config.terminalWsUrl,
        }),
        // Presented to the terminal service over the WebSocket handshake.
        token,
      },
    });
  }));

  return router;
}
