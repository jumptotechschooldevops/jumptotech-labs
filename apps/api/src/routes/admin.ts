/**
 * The classroom view — what an instructor can see and do from the browser.
 *
 * The question it answers: *five students are in a class and something
 * happens; can the instructor tell what, without a terminal on the server?*
 * Before this, the answers lived behind `ssh` + `docker exec` (the operator
 * socket, `operator.ts`) or in the api log.
 *
 * ```text
 *   GET  /api/admin/classroom              capacity, can labs start, runtimes,
 *                                          every live lab, recently finished
 *                                          ones, and the last hour's problems
 *   GET  /api/admin/sessions/:id           one lab: state, why, what happened
 *                                          (its events), environment probe
 *   GET  /api/admin/students?q=            find a student by name or email
 *   GET  /api/admin/students/:userId       one student: live labs, history
 *   GET  /api/admin/labs                   the catalog, and which labs can run
 *   POST /api/admin/sessions/:id/end       end one student's lab (ADMIN)
 * ```
 *
 * ## Authorization
 *
 * The router is mounted behind `requireAction('classroom:read')`: INSTRUCTOR
 * and ADMIN, decided by `policy.ts` from the role stored on the account —
 * never from anything the request carries. A STUDENT gets 403 on every path;
 * no credential gets 401. Ending a lab is asked again, per session, with
 * `authorize(user, 'session:end', session)`: the same decision the student's
 * own End Lab goes through, which grants it cross-user to ADMIN only.
 * INSTRUCTOR stays read-only, as `policy.ts` designed it.
 *
 * ## What it never serves
 *
 * A terminal, a terminal token, a credential, a kubeconfig, a command, terminal
 * output, a requirement's expected value, or a provider's words. Events carry
 * codes; statuses carry labels. The sandbox handle, namespace and raw status
 * reason are ADMIN-only (`classroom:operator-detail`).
 *
 * ## Bounds
 *
 * Live sessions are bounded by capacity; finished ones by the session
 * retention window (their rows are purged after it) and a cap; events, user
 * reads and searches by explicit limits. One classroom read is a fixed number
 * of queries, whatever the class size — never one per row.
 */
import { Router, type Request, type RequestHandler } from 'express';
import {
  isTerminalStatus,
  type LabProviderId,
  type LabRegistry,
  type LabSession,
  type SessionManager,
} from '@jumptotech/lab-orchestrator';
import { studentIdForUser, type ProgressService } from '@jumptotech/progress';
import { silentLogger, type Logger } from '@jumptotech/observability';

import { asyncRoute, sendError, sendOk } from '../http.js';
import { authorize } from '../auth/policy.js';
import { requestId, type AuthAuditLogger } from '../auth/middleware.js';
import type { AuthenticatedUser } from '../auth/identity.js';
import type { UserDirectory } from '../auth/users.js';
import { operatorStatus } from '../operator.js';
import { recordSafely, type LatestEvents, type SessionEvent, type SessionEventStore } from '../classroom/session-events.js';
import { PROBLEM_OUTCOMES, attentionFor, describeEvent, runtimeLabel, statusLabel } from '../classroom/view.js';
import { toAttemptPayload } from './me.js';
import { noLimit } from './sessions.js';

export interface AdminRoutesDeps {
  registry: LabRegistry;
  sessions: SessionManager;
  progress: ProgressService;
  sessionEvents: SessionEventStore;
  users: UserDirectory;
  launchesPaused: boolean;
  /** How long a finished session's row is kept — `SESSION_RETENTION_MINUTES`. */
  retentionSeconds: number;
  /** When the reaper last finished a sweep; undefined when unknown. */
  reaperLastSuccessMs: () => number | undefined;
  reaperIntervalSeconds: number;
  authAudit?: AuthAuditLogger;
  obs?: Logger;
  sandboxWriteLimiter?: RequestHandler;
  now?: () => number;
}

/** Finished sessions shown, newest first. Their rows expire with retention anyway. */
const MAX_RECENT = 50;
/** The problems feed looks back this far. */
const PROBLEM_WINDOW_MS = 60 * 60_000;
const MAX_PROBLEMS = 30;
const MAX_TIMELINE = 50;
const MAX_STUDENT_RESULTS = 20;
const MAX_ATTEMPTS = 20;
/** A provider probe never holds up the detail view longer than this. */
const PROBE_TIMEOUT_MS = 5_000;

/** A session id as the orchestrator mints them; checked before anything is read. */
const SESSION_ID_SHAPE = /^[A-Za-z0-9-]{8,64}$/;
/** A user id: a UUID in PostgreSQL, `usr-…` in memory. */
const USER_ID_SHAPE = /^[A-Za-z0-9-]{1,64}$/;

export interface StudentRef {
  userId: string;
  name: string;
  email?: string;
}

function studentRef(userId: string | undefined, directory: Map<string, AuthenticatedUser>): StudentRef | null {
  if (!userId) return null;
  const user = directory.get(userId);
  return {
    userId,
    // The name a class knows; the email when there is no name; the id when neither is known.
    name: user?.displayName ?? user?.email ?? userId,
    ...(user?.email ? { email: user.email } : {}),
  };
}

export function createAdminRoutes(deps: AdminRoutesDeps): Router {
  const router = Router();
  const obs = deps.obs ?? silentLogger();
  const now = () => deps.now?.() ?? Date.now();

  const lab = (labId: string) => {
    try {
      const def = deps.registry.get(labId);
      return { id: def.id, title: def.title, track: def.track };
    } catch {
      // A lab removed from the catalog while a session of it still ran.
      return { id: labId, title: labId, track: 'unknown' };
    }
  };

  const operatorDetail = (req: Request) => authorize(req.user!, 'classroom:operator-detail').allowed;

  async function directoryFor(ids: Iterable<string | undefined>): Promise<Map<string, AuthenticatedUser>> {
    const wanted = [...new Set([...ids].filter((id): id is string => typeof id === 'string'))];
    if (wanted.length === 0) return new Map();
    const found = await deps.users.findByIds(wanted);
    return new Map(found.map((user) => [user.userId, user]));
  }

  function eventView(event: SessionEvent, directory: Map<string, AuthenticatedUser>) {
    const { text, problem } = describeEvent(event);
    return {
      eventId: event.eventId,
      at: event.occurredAt,
      operation: event.operation,
      outcome: event.outcome,
      ...(event.code ? { code: event.code } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      text,
      problem,
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      lab: lab(event.labId),
      student: studentRef(event.ownerUserId, directory),
      // Who asked, when it was not the student: staff, or the platform itself.
      by:
        event.actorUserId === undefined
          ? 'platform'
          : event.actorUserId === event.ownerUserId
            ? 'student'
            : 'staff',
    };
  }

  function sessionRow(
    session: LabSession,
    latest: LatestEvents,
    directory: Map<string, AuthenticatedUser>,
    withOperator: boolean,
  ) {
    const at = now();
    const view = deps.sessions.view(session);
    const lastCheck = latest.check;
    return {
      sessionId: session.sessionId,
      student: studentRef(session.ownerUserId, directory),
      lab: lab(session.labId),
      provider: session.provider,
      runtime: runtimeLabel(session.provider),
      status: session.status,
      state: statusLabel(session),
      occupiesSlot: !isTerminalStatus(session.status),
      startedAt: session.createdAt,
      statusChangedAt: session.statusChangedAt,
      lastActivityAt: session.lastActivityAt,
      expiresAt: session.expiresAt,
      ...(session.endedAt ? { endedAt: session.endedAt } : {}),
      secondsRemaining: view.secondsRemaining,
      secondsUntilIdle: view.secondsUntilIdle,
      lastCheck: lastCheck
        ? { at: lastCheck.occurredAt, outcome: lastCheck.outcome, ...(lastCheck.code ? { code: lastCheck.code } : {}), text: describeEvent(lastCheck).text }
        : null,
      lastReset: latest.reset
        ? { at: latest.reset.occurredAt, outcome: latest.reset.outcome, ...(latest.reset.code ? { code: latest.reset.code } : {}), text: describeEvent(latest.reset).text }
        : null,
      /*
       * ENDED and EXPIRED are recorded only once the provider confirmed the
       * sandbox gone. FAILED is different: the failed start's teardown is
       * best-effort, and the reaper reclaims anything it left. The slot is
       * free either way, but "confirmed" would claim more than is known.
       */
      cleanup: isTerminalStatus(session.status)
        ? session.status === 'FAILED'
          ? 'automatic'
          : 'confirmed'
        : session.status === 'ENDING' || session.status === 'EXPIRING'
          ? 'in-progress'
          : 'not-started',
      attention: isTerminalStatus(session.status) ? [] : attentionFor(session, latest, view, at),
      ...(withOperator
        ? {
            operator: {
              sandboxRef: session.sandboxRef,
              ...(session.provider === 'kubernetes' ? { namespace: session.namespace } : {}),
              ...(session.statusReason ? { statusReason: session.statusReason } : {}),
            },
          }
        : {}),
    };
  }

  // GET /api/admin/classroom ------------------------------------------------------
  router.get('/classroom', asyncRoute(async (req, res) => {
    const at = now();
    const withOperator = operatorDetail(req);

    const status = await operatorStatus({
      sessions: deps.sessions,
      logger: obs,
      launchesPaused: deps.launchesPaused,
      retentionSeconds: deps.retentionSeconds,
      reaperLastSuccessMs: deps.reaperLastSuccessMs,
      reaperIntervalSeconds: deps.reaperIntervalSeconds,
      now,
    });

    // The session store unreadable is an answer, not a crash: say so plainly.
    if (status.capacity.occupying === null) {
      sendError(res, 503, {
        code: 'SESSION_STORE_UNAVAILABLE',
        message: 'Lab sessions cannot be read right now — the platform database is not answering.',
        remediation: 'Students cannot start labs either. Escalate to DevOps (P0 if every student is affected).',
      });
      return;
    }

    const cutoff = at - deps.retentionSeconds * 1000;
    const all = await deps.sessions.list();
    const live = all.filter((session) => !isTerminalStatus(session.status));
    const recent = all
      .filter(
        (session) =>
          isTerminalStatus(session.status) && Date.parse(session.endedAt ?? session.statusChangedAt) >= cutoff,
      )
      .sort((a, b) => (b.endedAt ?? b.statusChangedAt).localeCompare(a.endedAt ?? a.statusChangedAt))
      .slice(0, MAX_RECENT);

    const [latest, problems] = await Promise.all([
      deps.sessionEvents.latestForSessions([...live, ...recent].map((session) => session.sessionId)),
      deps.sessionEvents.listRecent({
        sinceIso: new Date(at - PROBLEM_WINDOW_MS).toISOString(),
        outcomes: PROBLEM_OUTCOMES,
        limit: MAX_PROBLEMS,
      }),
    ]);
    const directory = await directoryFor([
      ...live.map((session) => session.ownerUserId),
      ...recent.map((session) => session.ownerUserId),
      ...problems.map((event) => event.ownerUserId),
    ]);

    const rows = live
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((session) => sessionRow(session, latest.get(session.sessionId) ?? {}, directory, withOperator));

    sendOk(res, {
      generatedAt: new Date(at).toISOString(),
      viewer: {
        role: req.user!.role,
        // The policy's own answer to "may I end somebody else's lab?".
        canEndSessions: authorize(req.user!, 'session:end', { sessionId: 'any', ownerUserId: `not-${req.user!.userId}` }).allowed,
        operatorDetail: withOperator,
      },
      capacity: {
        active: status.capacity.occupying,
        max: status.capacity.maxActive,
        available: status.capacity.available,
        full: status.capacity.available === 0,
        perStudentLimit: status.capacity.perStudentLimit,
      },
      newLabs: {
        verdict: status.newLabs.verdict,
        summary:
          status.newLabs.verdict === 'yes'
            ? 'Students can start labs.'
            : status.newLabs.verdict === 'degraded'
              ? 'Students can start labs, but some are affected.'
              : 'Students cannot start new labs right now.',
        reasons: instructorReasons(status),
        ...(withOperator ? { operatorReasons: status.newLabs.reasons } : {}),
      },
      runtimes: status.providers.map((provider) => ({
        provider: provider.provider,
        label: runtimeLabel(provider.provider),
        state: provider.disabled ? 'disabled' : provider.available ? 'available' : 'unavailable',
        ...(withOperator && provider.reason ? { detail: provider.reason } : {}),
      })),
      cleanupWorker: {
        healthy: !status.reaper.stalled,
        lastRunAt: status.reaper.lastSuccessAt,
      },
      sessions: rows,
      recent: recent.map((session) => sessionRow(session, latest.get(session.sessionId) ?? {}, directory, withOperator)),
      problems: problems.map((event) => eventView(event, directory)),
    });
  }));

  // GET /api/admin/sessions/:sessionId ---------------------------------------------
  router.get('/sessions/:sessionId', asyncRoute(async (req, res) => {
    const sessionId = String(req.params.sessionId ?? '');
    if (!SESSION_ID_SHAPE.test(sessionId)) {
      sendError(res, 400, { code: 'INVALID_SESSION_ID', message: 'Support IDs look like sess-<letters and digits>.' });
      return;
    }
    const withOperator = operatorDetail(req);
    const [session, events, attempt] = await Promise.all([
      deps.sessions.get(sessionId),
      deps.sessionEvents.listForSession(sessionId, MAX_TIMELINE),
      deps.progress.attemptForSession(sessionId).catch(() => null),
    ]);
    if (!session && events.length === 0) {
      sendError(res, 404, {
        code: 'SESSION_NOT_FOUND',
        message: 'No lab with that Support ID.',
        remediation: 'Check the ID with the student. Labs older than 30 days are no longer kept.',
      });
      return;
    }
    const owner = session?.ownerUserId ?? events.find((event) => event.ownerUserId)?.ownerUserId;
    const directory = await directoryFor([owner, ...events.map((event) => event.actorUserId)]);
    const latest: LatestEvents = {};
    for (const event of events) if (!latest[event.operation]) latest[event.operation] = event;

    /*
     * Does the runtime agree the sandbox exists? Asked of one session only, on
     * request, with a deadline: the classroom list never probes, so it costs no
     * provider call per row.
     */
    let environment: { phase: string; checkedAt: string } | { phase: 'unknown'; checkedAt: string; reason: string } | null = null;
    if (session && (session.status === 'ACTIVE' || session.status === 'DEGRADED')) {
      environment = await Promise.race([
        deps.sessions
          .status(session)
          .then((info) => ({ phase: info.phase, checkedAt: new Date(now()).toISOString() }))
          .catch(() => ({ phase: 'unknown' as const, checkedAt: new Date(now()).toISOString(), reason: 'The runtime did not answer.' })),
        new Promise<{ phase: 'unknown'; checkedAt: string; reason: string }>((resolve) =>
          setTimeout(
            () => resolve({ phase: 'unknown', checkedAt: new Date(now()).toISOString(), reason: 'The runtime did not answer in time.' }),
            PROBE_TIMEOUT_MS,
          ).unref(),
        ),
      ]);
    }

    const endDecision = session
      ? authorize(req.user!, 'session:end', { sessionId: session.sessionId, ownerUserId: session.ownerUserId })
      : { allowed: false };

    sendOk(res, {
      sessionId,
      tracked: session !== null,
      ...(session
        ? { session: sessionRow(session, latest, directory, withOperator) }
        : {
            // The row was purged after the retention window; the events outlive it.
            summary: {
              student: studentRef(owner, directory),
              lab: lab(events[0]!.labId),
              note: 'This lab finished more than a few minutes ago; its live record is gone, but what happened to it is below.',
            },
          }),
      environment,
      attempt: attempt ? toAttemptPayload(attempt, deps.registry) : null,
      timeline: events.map((event) => eventView(event, directory)),
      actions: {
        canEnd: Boolean(session && !isTerminalStatus(session.status) && endDecision.allowed && session.ownerUserId !== req.user!.userId),
      },
    });
  }));

  // GET /api/admin/students?q= -------------------------------------------------
  router.get('/students', asyncRoute(async (req, res) => {
    const raw = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (raw.length < 2 || raw.length > 64) {
      sendError(res, 400, {
        code: 'INVALID_QUERY',
        message: 'Search for 2 to 64 characters of a student’s name or email.',
      });
      return;
    }
    const [matches, occupying] = await Promise.all([
      deps.users.search(raw, MAX_STUDENT_RESULTS),
      deps.sessions.listOccupying(),
    ]);
    const directory = new Map(matches.map((user) => [user.userId, user]));
    const latest = await deps.sessionEvents.latestForSessions(
      occupying.filter((session) => session.ownerUserId && directory.has(session.ownerUserId)).map((session) => session.sessionId),
    );
    const withOperator = operatorDetail(req);
    sendOk(res, {
      query: raw,
      limit: MAX_STUDENT_RESULTS,
      students: matches.map((user) => ({
        student: studentRef(user.userId, directory)!,
        role: user.role,
        liveSessions: occupying
          .filter((session) => session.ownerUserId === user.userId)
          .map((session) => sessionRow(session, latest.get(session.sessionId) ?? {}, directory, withOperator)),
      })),
    });
  }));

  // GET /api/admin/students/:userId ------------------------------------------
  router.get('/students/:userId', asyncRoute(async (req, res) => {
    const userId = String(req.params.userId ?? '');
    if (!USER_ID_SHAPE.test(userId)) {
      sendError(res, 400, { code: 'INVALID_USER_ID', message: 'That is not a student id.' });
      return;
    }
    const [found] = await deps.users.findByIds([userId]);
    if (!found) {
      sendError(res, 404, { code: 'STUDENT_NOT_FOUND', message: 'No such student.' });
      return;
    }
    const [live, events, attempts] = await Promise.all([
      deps.sessions.listOccupyingForOwner(userId),
      deps.sessionEvents.listForOwner(userId, MAX_TIMELINE),
      deps.progress.listAttempts(studentIdForUser(userId), MAX_ATTEMPTS).catch(() => null),
    ]);
    const directory = await directoryFor([userId, ...events.map((event) => event.actorUserId)]);
    const latest = await deps.sessionEvents.latestForSessions(live.map((session) => session.sessionId));
    const withOperator = operatorDetail(req);
    sendOk(res, {
      student: studentRef(userId, directory)!,
      role: found.role,
      liveSessions: live.map((session) => sessionRow(session, latest.get(session.sessionId) ?? {}, directory, withOperator)),
      history: attempts === null ? null : attempts.map((attempt) => toAttemptPayload(attempt, deps.registry)),
      historyLimit: MAX_ATTEMPTS,
      timeline: events.map((event) => eventView(event, directory)),
    });
  }));

  // GET /api/admin/labs --------------------------------------------------------
  router.get('/labs', asyncRoute(async (_req, res) => {
    const [statuses, occupying] = await Promise.all([
      deps.sessions.providers.statuses().catch(() => null),
      deps.sessions.listOccupying().catch(() => null),
    ]);
    const byProvider = new Map((statuses ?? []).map((status) => [status.providerId, status]));
    const running = new Map<string, number>();
    for (const session of occupying ?? []) running.set(session.labId, (running.get(session.labId) ?? 0) + 1);
    const labs = deps.registry.list().map((def) => {
      const provider = def.provider;
      const status = byProvider.get(provider as LabProviderId);
      const runnable = status ? status.registered && status.available && status.disabled !== true : null;
      return {
        id: def.id,
        title: def.title,
        track: def.track,
        provider,
        runtime: runtimeLabel(provider),
        runnable,
        availability:
          runnable === null
            ? 'Unknown — the runtime could not be asked'
            : runnable
              ? 'Available'
              : status?.disabled
                ? 'Not offered on this platform'
                : !status?.registered
                  ? 'Not installed on this platform'
                  : 'Unavailable right now',
        running: running.get(def.id) ?? 0,
      };
    });
    sendOk(res, { count: labs.length, labs });
  }));

  // POST /api/admin/sessions/:sessionId/end ------------------------------------------
  /*
   * End one student's lab for them — through the same fenced teardown the
   * operator socket and the reaper use (`endByOperator`), recorded EXPIRED,
   * "ended by operator", with a `staff_end` event naming who asked.
   *
   * Guarded three ways beyond the router's role check: `authorize` for
   * `session:end` on this session (ADMIN only, cross-user), a body that repeats
   * the session id (the confirmation the page asks for — a stray or replayed
   * POST without it does nothing), and the origin guard every write passes.
   * Idempotent: a finished session answers 409 and changes nothing.
   */
  router.post('/sessions/:sessionId/end', deps.sandboxWriteLimiter ?? noLimit, asyncRoute(async (req, res) => {
    const user = req.user!;
    const sessionId = String(req.params.sessionId ?? '');
    if (!SESSION_ID_SHAPE.test(sessionId)) {
      sendError(res, 400, { code: 'INVALID_SESSION_ID', message: 'That is not a Support ID.' });
      return;
    }
    const session = await deps.sessions.get(sessionId);
    if (!session) {
      sendError(res, 404, { code: 'SESSION_NOT_FOUND', message: 'No such lab session.' });
      return;
    }
    const decision = authorize(user, 'session:end', { sessionId, ownerUserId: session.ownerUserId });
    // Staff ending their *own* lab use End Lab like anyone; this is for other people's.
    const allowed = decision.allowed && decision.reason === 'role';
    deps.authAudit?.({
      requestId: requestId(req),
      authenticatedUserId: user.userId,
      action: 'session:end',
      sessionId,
      authorizationResult: allowed ? 'allowed' : decision.reason === 'unowned' ? 'denied-unowned' : 'denied-role',
      timestamp: new Date(now()).toISOString(),
    });
    if (!allowed) {
      sendError(res, 403, {
        code: 'FORBIDDEN',
        message: 'Only an administrator can end a student’s lab.',
        remediation: 'Ask the student to press End Lab, or ask an administrator.',
      });
      return;
    }
    const body = (req.body ?? {}) as { confirmSessionId?: unknown };
    if (body.confirmSessionId !== sessionId) {
      sendError(res, 400, {
        code: 'CONFIRMATION_REQUIRED',
        message: 'Confirm by sending the Support ID of the lab being ended as confirmSessionId.',
      });
      return;
    }
    if (isTerminalStatus(session.status)) {
      sendError(res, 409, {
        code: 'SESSION_ALREADY_FINISHED',
        message: `This lab has already finished (${statusLabel(session).label}).`,
      });
      return;
    }

    const startedAt = now();
    let result;
    try {
      result = await deps.sessions.endByOperator(sessionId);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      await recordSafely(deps.sessionEvents, obs, {
        sessionId,
        labId: session.labId,
        ...(session.ownerUserId ? { ownerUserId: session.ownerUserId } : {}),
        actorUserId: user.userId,
        operation: 'staff_end',
        outcome: 'refused',
        code: typeof code === 'string' ? code : 'INTERNAL_ERROR',
      });
      throw error;
    }
    const after = result.session;
    const finished = isTerminalStatus(after.status);
    await recordSafely(deps.sessionEvents, obs, {
      sessionId,
      labId: session.labId,
      ...(session.ownerUserId ? { ownerUserId: session.ownerUserId } : {}),
      actorUserId: user.userId,
      operation: 'staff_end',
      outcome: finished ? 'ok' : 'pending',
      ...(result.destroy.error?.code ? { code: result.destroy.error.code } : {}),
      durationMs: now() - startedAt,
    });
    obs[finished ? 'info' : 'warn']('classroom.session_ended', {
      sessionId,
      labId: session.labId,
      provider: session.provider,
      // The staff account that asked — not the student. Never a name or an address.
      userId: user.userId,
      outcome: finished ? 'ended' : 'pending',
      ...(result.destroy.error?.code ? { code: result.destroy.error.code } : {}),
    });

    const [latest, directory] = await Promise.all([
      deps.sessionEvents.latestForSessions([sessionId]),
      directoryFor([after.ownerUserId]),
    ]);
    res.status(finished ? 200 : 202);
    sendOk(res, {
      before: session.status,
      after: after.status,
      cleanup: finished ? 'confirmed' : 'pending',
      ...(finished
        ? {}
        : { note: 'The lab is ending but its cleanup is not confirmed yet. The platform keeps retrying; the slot frees when it finishes.' }),
      session: sessionRow(after, latest.get(sessionId) ?? {}, directory, operatorDetail(req)),
    });
  }));

  return router;
}

/** Why labs cannot start (or start badly), in an instructor's words. */
function instructorReasons(status: Awaited<ReturnType<typeof operatorStatus>>): string[] {
  const out: string[] = [];
  if (status.launchesPaused) out.push('Starting labs is paused for maintenance. Labs already running keep working.');
  if (status.capacity.available === 0) {
    out.push(`Classroom capacity is full: ${status.capacity.occupying} of ${status.capacity.maxActive} labs are running. A slot frees when a student ends their lab.`);
  }
  const enabled = status.providers.filter((provider) => !provider.disabled);
  if (enabled.length > 0 && enabled.every((provider) => !provider.available)) {
    out.push('No kind of lab can start: the lab runtimes are unavailable. Escalate to DevOps.');
  } else {
    for (const provider of enabled.filter((p) => !p.available)) {
      out.push(`${runtimeLabel(provider.provider)} cannot start right now. Other labs are unaffected.`);
    }
  }
  if (status.reaper.stalled) out.push('Finished labs are not being cleaned up, so slots may not free. Escalate to DevOps.');
  return out;
}
