/**
 * The current student's learning history.
 *
 * ```text
 *   GET /api/me                       who the request is attributed to
 *   GET /api/me/progress              completed / total, per track
 *   GET /api/me/attempts              recent attempts, newest first
 *   GET /api/me/attempts/:attemptId   one attempt, with the hints it used
 * ```
 *
 * `me` rather than `/api/students/:id` on purpose. A route that takes a student
 * id in the path invites exactly the mistake this platform refuses to make:
 * trusting an arbitrary identifier from the client. The subject of these
 * endpoints is always the authenticated caller, resolved server-side.
 *
 * Since PLATFORM-010 that subject is the user the API verified — through a
 * session cookie or a signed token — rather than a development identity. Where
 * a deployment still runs without an identity provider, the payload says so:
 * `authenticated: false` and a `notice` naming what the identity is worth.
 *
 * **Nothing here exposes the database.** No row ids, no column names, no table
 * names, no session ids. Totals come from the in-memory lab catalog and
 * completions come from the store; the two are joined here so the browser never
 * has to know how either is stored.
 */
import { Router, type Request, type Response } from 'express';
import type { LabRegistry } from '@jumptotech/lab-orchestrator';
import {
  DEFAULT_ATTEMPT_PAGE,
  type AttemptDetail,
  type LabAttempt,
  type LabProgress,
  type ProgressService,
  type StudentIdentity,
  type StudentIdentityResolver,
} from '@jumptotech/progress';
import { asyncRoute, sendError, sendOk } from '../http.js';
import { progressErrorResponse, resolveStudent } from '../identity.js';
import { record } from '../progress.js';

export interface MeRoutesDeps {
  registry: LabRegistry;
  progress: ProgressService;
  identity: StudentIdentityResolver;
  /** False when history is only in memory. Served so the UI can be honest. */
  durable: boolean;
  logger?: (message: string) => void;
}

/** Per-lab standing, including labs the student has never opened. */
export type LabProgressStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';

/**
 * The identity block every `me` response carries.
 *
 * `authenticated: false` is not decoration — it is the API telling the client
 * the truth about what this identity is worth.
 */
export function toStudentPayload(identity: StudentIdentity, durable: boolean) {
  return {
    studentId: identity.studentId,
    authenticated: identity.authenticated,
    identitySource: identity.source,
    /** False means this history is in memory and dies with the process. */
    durable,
  };
}

/** An attempt, as the browser sees it. */
export function toAttemptPayload(attempt: LabAttempt, registry: LabRegistry) {
  return {
    attemptId: attempt.attemptId,
    labId: attempt.labId,
    labTitle: titleOf(registry, attempt.labId),
    track: attempt.track,
    status: attempt.status,
    ...(attempt.statusReason ? { statusReason: attempt.statusReason } : {}),
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    /** When the sandbox went away. Independent of `completedAt`. */
    endedAt: attempt.endedAt,
    checkCount: attempt.checkCount,
    resetCount: attempt.resetCount,
    /*
     * `sessionId` is deliberately absent.
     *
     * Possessing a session id is what authorises acting on a sandbox
     * (PLATFORM-002), so a history endpoint has no business handing them back —
     * least of all in a list. The attempt id is the handle for history, and it
     * grants nothing but reading this student's own record.
     */
  };
}

function titleOf(registry: LabRegistry, labId: string): string {
  try {
    return registry.get(labId).title;
  } catch {
    // A lab that has since been removed from the catalog. The history is still
    // real, so it is shown under its id rather than hidden.
    return labId;
  }
}

/**
 * Join stored progress with the live catalog.
 *
 * Completions come from the store; the denominators come from the registry —
 * "1 of 10" moves on its own when an eleventh Kubernetes lab is added, with no
 * migration and no backfill, because the total was never stored.
 *
 * Rows for labs that no longer exist in the catalog are not counted: a
 * completion cannot be "1 of 10" against a lab that is not one of the ten.
 */
export function toProgressPayload(
  registry: LabRegistry,
  rows: LabProgress[],
  identity: StudentIdentity,
  durable: boolean,
) {
  const byLab = new Map(rows.map((row) => [row.labId, row]));

  const tracks = registry.tracks().map((track) => {
    const labs = registry.labsForTrack(track.track).map((lab) => {
      const row = byLab.get(lab.id);
      const status: LabProgressStatus = row ? row.status : 'NOT_STARTED';
      return {
        labId: lab.id,
        title: lab.title,
        status,
        attemptCount: row?.attemptCount ?? 0,
        completionCount: row?.completionCount ?? 0,
        completedAt: row?.firstCompletedAt ?? null,
        lastCompletedAt: row?.lastCompletedAt ?? null,
      };
    });

    const completed = labs.filter((lab) => lab.status === 'COMPLETED').length;
    const inProgress = labs.filter((lab) => lab.status === 'IN_PROGRESS').length;
    return {
      track: track.track,
      title: track.title,
      total: labs.length,
      completed,
      inProgress,
      notStarted: labs.length - completed - inProgress,
      percent: percentOf(completed, labs.length),
      labs,
    };
  });

  const total = tracks.reduce((sum, track) => sum + track.total, 0);
  const completed = tracks.reduce((sum, track) => sum + track.completed, 0);
  const inProgress = tracks.reduce((sum, track) => sum + track.inProgress, 0);

  return {
    student: toStudentPayload(identity, durable),
    overall: {
      total,
      completed,
      inProgress,
      notStarted: total - completed - inProgress,
      percent: percentOf(completed, total),
    },
    tracks,
  };
}

function percentOf(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

function toAttemptDetailPayload(detail: AttemptDetail, registry: LabRegistry) {
  return {
    ...toAttemptPayload(detail.attempt, registry),
    hints: detail.hints.map((hint) => ({ level: hint.hintIndex, revealedAt: hint.revealedAt })),
    hintsUsed: detail.hints.length,
  };
}

export function createMeRoutes(deps: MeRoutesDeps): Router {
  const { registry, progress, identity: resolver, durable } = deps;
  const log = deps.logger ?? (() => undefined);
  const router = Router();

  /** Resolve the caller, replying 400 if a development override is malformed. */
  function readIdentity(req: Request, res: Response): StudentIdentity | null {
    try {
      return resolveStudent(resolver, req);
    } catch (error) {
      if (progressErrorResponse(res, error)) return null;
      throw error;
    }
  }

  // GET /api/me -------------------------------------------------------------
  router.get('/', asyncRoute(async (req, res) => {
    const identity = readIdentity(req, res);
    if (!identity) return;
    // Creating the row on a read keeps a first-time student from seeing a 404
    // on their own dashboard. It is also the only write on this path.
    await record(log, 'ensure student', () => progress.ensureStudent(identity));
    sendOk(res, {
      student: toStudentPayload(identity, durable),
      /*
       * The notice is now conditional, and that is the point — PLATFORM-010.
       *
       * It existed to stop the UI implying a login that did not exist. Where a
       * caller really has authenticated, repeating it would be the opposite
       * lie, so it is present only for a development identity: absent means
       * somebody actually proved who they are.
       */
      ...(identity.authenticated
        ? {}
        : {
            notice:
              'Development identity. Nobody proved who this is, so this history is not protected by a login.',
          }),
    });
  }));

  // GET /api/me/progress ----------------------------------------------------
  router.get('/progress', asyncRoute(async (req, res) => {
    const identity = readIdentity(req, res);
    if (!identity) return;

    let rows: LabProgress[];
    try {
      rows = await progress.progressFor(identity.studentId);
    } catch (error) {
      unavailable(res, error, log);
      return;
    }

    sendOk(res, toProgressPayload(registry, rows, identity, durable));
  }));

  // GET /api/me/attempts ----------------------------------------------------
  router.get('/attempts', asyncRoute(async (req, res) => {
    const identity = readIdentity(req, res);
    if (!identity) return;

    const limit = Number.parseInt(String(req.query.limit ?? ''), 10);
    let attempts: LabAttempt[];
    try {
      attempts = await progress.listAttempts(
        identity.studentId,
        Number.isFinite(limit) ? limit : DEFAULT_ATTEMPT_PAGE,
      );
    } catch (error) {
      unavailable(res, error, log);
      return;
    }

    sendOk(res, {
      student: toStudentPayload(identity, durable),
      attempts: attempts.map((attempt) => toAttemptPayload(attempt, registry)),
      count: attempts.length,
    });
  }));

  // GET /api/me/attempts/:attemptId -----------------------------------------
  router.get('/attempts/:attemptId', asyncRoute(async (req, res) => {
    const identity = readIdentity(req, res);
    if (!identity) return;

    let detail: AttemptDetail | null;
    try {
      detail = await progress.attemptDetail(identity.studentId, String(req.params.attemptId));
    } catch (error) {
      unavailable(res, error, log);
      return;
    }

    // A miss and "belongs to another student" are the same answer on purpose:
    // an attempt id must not be usable to discover whose it is.
    if (!detail) {
      sendError(res, 404, {
        code: 'ATTEMPT_NOT_FOUND',
        message: 'No such lab attempt for this student.',
      });
      return;
    }

    sendOk(res, {
      student: toStudentPayload(identity, durable),
      attempt: toAttemptDetailPayload(detail, registry),
    });
  }));

  return router;
}

/**
 * The store is unreachable.
 *
 * A read cannot be faked — an empty dashboard would be a lie — so this reports
 * a real 503 with a real reason, while the *write* paths on lab operations
 * deliberately swallow the same failure so a student can still work.
 */
function unavailable(res: Response, error: unknown, log: (message: string) => void): void {
  log(`progress read failed: ${error instanceof Error ? error.message : String(error)}`);
  sendError(res, 503, {
    code: 'PROGRESS_UNAVAILABLE',
    message: 'Your progress could not be read right now.',
    remediation: 'The progress database is unavailable. Your lab environments are unaffected.',
  });
}
