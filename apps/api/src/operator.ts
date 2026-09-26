/**
 * The operator socket — what an instructor on the host can ask the running api.
 *
 * The private beta's operator had no way to answer "who has a lab running,
 * which one, since when, and is it healthy?" short of hand-written SQL against
 * `lab_sessions`, and no way at all to end one broken student's lab: the
 * runbooks said "the student presses End, or wait twenty minutes for idle
 * expiry", and forbade editing the row by hand. Both answers belong to the
 * process that owns the sessions, so this asks it.
 *
 * ```text
 *   operator ──ssh──► host ──docker exec──► api container
 *                                             └─ operator-cli.ts ──unix socket──► this
 * ```
 *
 * ## Why a Unix socket and not a route
 *
 * Every HTTP listener this service has is reachable from something that is not
 * an operator: `:4000` through nginx from the internet, `:9400` from
 * Prometheus's network. An admin route on either would need a credential, a
 * credential needs distributing, and one more secret in `.env` is one more
 * thing a leak hands over. A socket in a 0700 directory inside the container's
 * own `/tmp` is reachable by nothing on any network. The only way in is
 * `docker exec` into this container, and whoever can do that already holds the
 * database password in this container's environment — so the socket grants
 * nothing its caller does not have, and needs no secret of its own. It is the
 * same "has no way to" argument that put `/metrics` on its own port.
 *
 * ## What it can do
 *
 *   GET  /v1/status                 capacity, launches paused, providers,
 *                                   database, reaper — and whether a new lab
 *                                   can start right now, with the reasons
 *   GET  /v1/sessions               sessions holding a slot
 *   GET  /v1/sessions?scope=recent  those, and the ones that finished within
 *                                   the retention window, with their reasons
 *   GET  /v1/sessions/<id>          one session, in any status
 *   POST /v1/sessions/<id>/end      end one session through the same fenced
 *                                   teardown the reaper uses
 *   /v1/access…                     lab access: list, find, show, grant,
 *                                   suspend, restore, revoke — see
 *                                   `access/operator-access.ts` and
 *                                   docs/commercial-access.md
 *
 * Nothing else: no raw SQL, no status edits, no terminal, no workspace, no
 * credentials. A session is reported by its identifiers, lab, status and
 * timestamps; its owner by the internal user id, never an address or a name.
 * What the student typed or saw is not something this process holds.
 *
 * Every request is logged (`ops.operator.request`) and counted
 * (`jtt_operator_actions_total`); an end is logged again with its result.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import {
  OPERATOR_END_REASON,
  SessionError,
  isTerminalStatus,
  type LabSession,
  type SessionManager,
  type SessionStatus,
} from '@jumptotech/lab-orchestrator';
import type { Counter, Logger } from '@jumptotech/observability';

import {
  accessActionFor,
  accessRefusal,
  handleAccessRequest,
  type AccessRouteResult,
  type OperatorAccessDeps,
} from './access/operator-access.js';

type OperatorAction = 'status' | 'sessions' | 'session' | 'end_session' | AccessRouteResult['action'];
type OperatorOutcome = 'ok' | 'rejected' | 'failed';

export interface OperatorDeps {
  sessions: SessionManager;
  logger: Logger;
  /** `jtt_operator_actions_total`. Optional so a test can compose without metrics. */
  actions?: Counter;
  launchesPaused: boolean;
  /** How long a finished session stays readable — `SESSION_RETENTION_MINUTES`. */
  retentionSeconds: number;
  /** Epoch ms of the reaper's last successful sweep; undefined before the first. */
  reaperLastSuccessMs: () => number | undefined;
  /** The sweep interval, for judging whether the reaper is keeping up. */
  reaperIntervalSeconds: number;
  /**
   * Lab access management (docs/commercial-access.md): list, find, show,
   * grant, suspend, restore, revoke. Absent: those endpoints answer 404.
   */
  access?: OperatorAccessDeps;
  now?: () => number;
}

/** One session as an operator sees it. Identifiers, lab, status and time — nothing a student typed. */
export interface OperatorSessionView {
  sessionId: string;
  labId: string;
  provider: string;
  status: SessionStatus;
  statusReason?: string;
  /** The sandbox's handle: the container name (`jtt-lab-…`) or namespace suffix to look for on the host. */
  sandboxRef: string;
  /** Kubernetes sessions only. */
  namespace?: string;
  /** The internal user id. Map it to a person in the users table only when you need to. */
  ownerUserId: string | null;
  createdAt: string;
  statusChangedAt: string;
  lastActivityAt: string;
  expiresAt: string;
  endedAt?: string;
  ageSeconds: number;
  inStatusSeconds: number;
  idleSeconds: number;
  secondsUntilExpiry: number;
  occupiesSlot: boolean;
}

export interface OperatorStatus {
  capacity: {
    occupying: number | null;
    maxActive: number;
    available: number | null;
    perStudentLimit: number | null;
    byStatus: Partial<Record<SessionStatus, number>>;
  };
  launchesPaused: boolean;
  database: { ok: boolean };
  /** Every registered provider. `disabled` ones were switched off on purpose and never degrade the verdict. */
  providers: Array<{ provider: string; available: boolean; disabled: boolean; reason?: string }>;
  reaper: { lastSuccessAt: string | null; secondsSinceSuccess: number | null; stalled: boolean };
  /**
   * Can a student press Start Lab and get a lab right now? `no` names every
   * reason, `degraded` names the ones that make a start likely to go wrong.
   */
  newLabs: { verdict: 'yes' | 'degraded' | 'no'; reasons: string[] };
}

/** Five missed sweeps, the same threshold as `ReaperStalled`. */
const REAPER_STALL_SWEEPS = 5;

/** A session id as the orchestrator mints them. Checked before anything is looked up. */
const SESSION_ID_SHAPE = /^[A-Za-z0-9-]{8,64}$/;

function seconds(fromIso: string, nowMs: number): number {
  const at = Date.parse(fromIso);
  return Number.isFinite(at) ? Math.max(0, Math.round((nowMs - at) / 1000)) : 0;
}

export function toOperatorView(session: LabSession, nowMs: number, occupiesSlot: boolean): OperatorSessionView {
  const expiresAtMs = Date.parse(session.expiresAt);
  return {
    sessionId: session.sessionId,
    labId: session.labId,
    provider: session.provider,
    status: session.status,
    ...(session.statusReason ? { statusReason: session.statusReason } : {}),
    sandboxRef: session.sandboxRef,
    ...(session.provider === 'kubernetes' ? { namespace: session.namespace } : {}),
    ownerUserId: session.ownerUserId ?? null,
    createdAt: session.createdAt,
    statusChangedAt: session.statusChangedAt,
    lastActivityAt: session.lastActivityAt,
    expiresAt: session.expiresAt,
    ...(session.endedAt ? { endedAt: session.endedAt } : {}),
    ageSeconds: seconds(session.createdAt, nowMs),
    inStatusSeconds: seconds(session.statusChangedAt, nowMs),
    idleSeconds: seconds(session.lastActivityAt, nowMs),
    secondsUntilExpiry: Number.isFinite(expiresAtMs) ? Math.max(0, Math.round((expiresAtMs - nowMs) / 1000)) : 0,
    occupiesSlot,
  };
}

export async function operatorStatus(deps: OperatorDeps): Promise<OperatorStatus> {
  const now = deps.now?.() ?? Date.now();
  const lifetimes = deps.sessions.lifetimes;

  let occupying: LabSession[] | null = null;
  try {
    occupying = await deps.sessions.listOccupying();
  } catch {
    occupying = null;
  }
  const byStatus: Partial<Record<SessionStatus, number>> = {};
  for (const session of occupying ?? []) byStatus[session.status] = (byStatus[session.status] ?? 0) + 1;

  let providers: OperatorStatus['providers'] = [];
  try {
    providers = (await deps.sessions.providers.statuses())
      .filter((status) => status.registered)
      .map((status) => ({
        provider: status.providerId,
        available: status.available,
        disabled: status.disabled === true,
        ...(status.reason ? { reason: status.reason } : {}),
      }));
  } catch {
    providers = [];
  }

  const lastSuccessMs = deps.reaperLastSuccessMs();
  const sinceSuccess = lastSuccessMs === undefined ? null : Math.max(0, Math.round((now - lastSuccessMs) / 1000));
  const stalled = sinceSuccess !== null && sinceSuccess > deps.reaperIntervalSeconds * REAPER_STALL_SWEEPS;

  const count = occupying?.length ?? null;
  const available = count === null ? null : Math.max(0, lifetimes.maxActiveSessions - count);

  const no: string[] = [];
  const degraded: string[] = [];
  if (deps.launchesPaused) no.push('launches are paused (LAB_LAUNCHES_PAUSED=true)');
  if (occupying === null) no.push('the session store cannot be read — PostgreSQL (RB-02)');
  else if (available === 0) no.push(`capacity is full: ${count} of ${lifetimes.maxActiveSessions} slots held`);
  // A track switched off by configuration is the deployment as intended; only
  // an enabled provider that fails its probe is news.
  const enabled = providers.filter((provider) => !provider.disabled);
  if (enabled.length === 0 || enabled.every((provider) => !provider.available)) {
    no.push(enabled.length === 0 ? 'no sandbox provider is enabled' : 'no enabled sandbox provider is available');
  } else {
    for (const provider of enabled.filter((p) => !p.available)) {
      degraded.push(`provider ${provider.provider} is unavailable: its labs refuse to start`);
    }
  }
  if (stalled) degraded.push(`the reaper has not completed a sweep for ${sinceSuccess}s: slots are not being reclaimed (RB-05)`);
  const stuck = (occupying ?? []).filter((session) => session.status === 'DEGRADED' || session.status === 'ENDING' || session.status === 'EXPIRING');
  if (stuck.length > 0 && available !== null && available <= 1) {
    degraded.push(`${stuck.length} slot(s) held by sessions that are ending or DEGRADED`);
  }

  return {
    capacity: {
      occupying: count,
      maxActive: lifetimes.maxActiveSessions,
      available,
      perStudentLimit: lifetimes.maxActiveSessionsPerStudent ?? null,
      byStatus,
    },
    launchesPaused: deps.launchesPaused,
    database: { ok: occupying !== null },
    providers,
    reaper: {
      lastSuccessAt: lastSuccessMs === undefined ? null : new Date(lastSuccessMs).toISOString(),
      secondsSinceSuccess: sinceSuccess,
      stalled,
    },
    newLabs: {
      verdict: no.length > 0 ? 'no' : degraded.length > 0 ? 'degraded' : 'yes',
      reasons: [...no, ...degraded],
    },
  };
}

export async function operatorSessions(
  deps: OperatorDeps,
  scope: 'live' | 'recent',
): Promise<OperatorSessionView[]> {
  const now = deps.now?.() ?? Date.now();
  const occupying = await deps.sessions.listOccupying();
  const views = occupying.map((session) => toOperatorView(session, now, true));
  if (scope === 'recent') {
    const cutoff = now - deps.retentionSeconds * 1000;
    const finished = (await deps.sessions.list()).filter(
      (session) =>
        isTerminalStatus(session.status) && Date.parse(session.endedAt ?? session.statusChangedAt) >= cutoff,
    );
    views.push(...finished.map((session) => toOperatorView(session, now, false)));
  }
  return views.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// --- the HTTP handler ------------------------------------------------------------

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** A session-domain refusal, mapped to what the CLI prints. Never a stack. */
function refusal(error: unknown): { status: number; code: string; message: string } | null {
  const access = accessRefusal(error);
  if (access) return access;
  if (!(error instanceof SessionError)) return null;
  const status = error.code === 'SESSION_NOT_FOUND' ? 404 : error.code === 'INVALID_SESSION_ID' ? 400 : 409;
  return { status, code: error.code, message: error.message };
}

export function createOperatorHandler(deps: OperatorDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const count = (action: OperatorAction, outcome: OperatorOutcome): void => {
    try {
      deps.actions?.inc({ action, outcome });
    } catch {
      /* instrumentation never breaks the tool */
    }
  };

  return (req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      let action: OperatorAction | undefined;
      let sessionId: string | undefined;

      try {
        // Inside the try: the HTTP parser accepts request targets (`http://[`)
        // that URL refuses, and a rejection escaping this handler would take
        // the api down with it.
        let url: URL;
        try {
          url = new URL(req.url ?? '/', 'http://operator.invalid');
        } catch {
          send(res, 400, { ok: false, error: { code: 'INVALID_REQUEST', message: 'that is not a request path' } });
          return;
        }
        const parts = url.pathname.split('/').filter(Boolean);
        if (method === 'GET' && url.pathname === '/v1/status') {
          action = 'status';
          send(res, 200, { ok: true, data: await operatorStatus(deps) });
        } else if (method === 'GET' && url.pathname === '/v1/sessions') {
          action = 'sessions';
          const scope = url.searchParams.get('scope') ?? 'live';
          if (scope !== 'live' && scope !== 'recent') {
            count(action, 'rejected');
            send(res, 400, { ok: false, error: { code: 'INVALID_SCOPE', message: 'scope is live or recent' } });
            return;
          }
          const sessions = await operatorSessions(deps, scope);
          send(res, 200, { ok: true, data: { scope, count: sessions.length, sessions } });
        } else if (parts[0] === 'v1' && parts[1] === 'access' && deps.access) {
          action = accessActionFor(method, parts) ?? undefined;
          const served = await handleAccessRequest(
            { ...deps.access, sessions: deps.sessions, logger: deps.logger, now: () => deps.now?.() ?? Date.now() },
            req,
            url,
          );
          if (!served) {
            send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'no such operator endpoint' } });
            return;
          }
          action = served.action;
          send(res, served.status, { ok: true, data: served.payload });
          count(action, 'ok');
          deps.logger.info('ops.operator.request', { action, outcome: 'ok', ...(served.logFields ?? {}) });
          return;
        } else if (parts.length >= 3 && parts[0] === 'v1' && parts[1] === 'sessions') {
          const isEnd = parts.length === 4 && parts[3] === 'end' && method === 'POST';
          const isRead = parts.length === 3 && method === 'GET';
          if (!isEnd && !isRead) {
            send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'no such operator endpoint' } });
            return;
          }
          action = isEnd ? 'end_session' : 'session';
          let candidate = '';
          try {
            candidate = decodeURIComponent(parts[2] ?? '');
          } catch {
            // A malformed escape is a bad id, not a failure of the api.
          }
          if (!SESSION_ID_SHAPE.test(candidate)) {
            count(action, 'rejected');
            send(res, 400, { ok: false, error: { code: 'INVALID_SESSION_ID', message: 'that is not a session id' } });
            return;
          }
          sessionId = candidate;
          const now = deps.now?.() ?? Date.now();
          if (isRead) {
            const session = await deps.sessions.require(sessionId);
            send(res, 200, { ok: true, data: toOperatorView(session, now, !isTerminalStatus(session.status)) });
          } else {
            const before = await deps.sessions.require(sessionId);
            if (isTerminalStatus(before.status)) {
              // Nothing to end, and nothing to record as the operator's.
              count(action, 'rejected');
              deps.logger.info('ops.operator.request', { action, outcome: 'rejected', sessionId, code: 'SESSION_ALREADY_FINISHED' });
              send(res, 409, {
                ok: false,
                error: {
                  code: 'SESSION_ALREADY_FINISHED',
                  message: `session ${sessionId} is already ${before.status}${before.statusReason ? ` (${before.statusReason})` : ''}`,
                },
              });
              return;
            }
            const result = await deps.sessions.endByOperator(sessionId);
            const after = result.session;
            const finished = isTerminalStatus(after.status);
            // Whose ending is it? A teardown already in flight (a student's End,
            // the reaper's expiry) keeps its own reason; the operator only
            // finished it, and the log says so rather than claiming it.
            const byOperator = after.statusReason === OPERATOR_END_REASON;
            deps.logger[finished ? 'info' : 'warn'](
              'ops.operator.session_ended',
              {
                sessionId,
                labId: after.labId,
                provider: after.provider,
                outcome: !finished ? 'pending' : byOperator ? 'ended' : 'finished_existing_teardown',
                reason: after.statusReason ?? '',
                ...(result.destroy.error?.code ? { code: result.destroy.error.code } : {}),
              },
              !finished
                ? `operator end of session ${sessionId} is not confirmed yet: it stays ${after.status} and the reaper resumes it`
                : byOperator
                  ? `operator ended session ${sessionId} (was ${before.status}, now ${after.status})`
                  : `session ${sessionId} was already being torn down (${after.statusReason ?? before.status}); the operator's request finished it as ${after.status}`,
            );
            send(res, finished ? 200 : 202, {
              ok: true,
              data: {
                before: before.status,
                after: after.status,
                endedBy: byOperator ? 'operator' : 'existing_teardown',
                sandboxGone: result.destroy.namespaceGone === true || finished,
                ...(finished
                  ? {}
                  : {
                      note: 'the delete is not confirmed yet; the session keeps its slot and the reaper retries it every sweep',
                      ...(result.destroy.error ? { destroyError: result.destroy.error.code } : {}),
                    }),
                session: toOperatorView(after, deps.now?.() ?? Date.now(), !finished),
              },
            });
          }
        } else {
          send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'no such operator endpoint' } });
          return;
        }
        count(action, 'ok');
        deps.logger.info('ops.operator.request', { action, outcome: 'ok', ...(sessionId ? { sessionId } : {}) });
      } catch (error) {
        const refused = refusal(error);
        if (action) count(action, refused ? 'rejected' : 'failed');
        deps.logger[refused ? 'info' : 'error']('ops.operator.request', {
          ...(action ? { action } : {}),
          outcome: refused ? 'rejected' : 'failed',
          ...(sessionId ? { sessionId } : {}),
          ...(refused ? { code: refused.code } : { err: error }),
        });
        if (res.headersSent) return;
        if (refused) {
          send(res, refused.status, { ok: false, error: { code: refused.code, message: refused.message } });
        } else {
          // The CLI user is an operator, but the message may still quote a
          // driver error; the log line carries it, redacted. The reply says where.
          send(res, 500, {
            ok: false,
            error: { code: 'OPERATOR_REQUEST_FAILED', message: 'the api could not answer; see `ops.operator.request` in the api log' },
          });
        }
      }
    })().catch(() => {
      // The last line of defence: nothing thrown here may reach the process.
      if (!res.headersSent) {
        try {
          send(res, 500, { ok: false, error: { code: 'OPERATOR_REQUEST_FAILED', message: 'the api could not answer' } });
        } catch {
          res.destroy();
        }
      }
    });
  };
}

// --- the socket ------------------------------------------------------------------

export class OperatorSocketError extends Error {
  readonly code = 'OPERATOR_SOCKET_UNSAFE';
}

/**
 * Prepare the socket's directory, refusing anything this process did not make
 * private: a directory owned by someone else, open to group or other, or a
 * symlink. The directory is the gate — a 0700 directory cannot be traversed
 * by anyone but its owner, whatever the socket file's own mode.
 */
export function prepareOperatorSocketPath(socketPath: string): void {
  if (!path.isAbsolute(socketPath)) {
    throw new OperatorSocketError('OPERATOR_SOCKET_PATH must be an absolute path.');
  }
  const dir = path.dirname(socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new OperatorSocketError(`${dir} is not a directory.`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new OperatorSocketError(`${dir} is not owned by this process's user.`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new OperatorSocketError(`${dir} is open to group or other (mode ${(stat.mode & 0o777).toString(8)}); it must be 0700.`);
  }
  let existing;
  try {
    existing = lstatSync(socketPath);
  } catch {
    return;
  }
  if (!existing.isSocket()) {
    throw new OperatorSocketError(`${socketPath} exists and is not a socket; refusing to replace it.`);
  }
  // A socket left by a previous process in this container. Nothing listens on it.
  unlinkSync(socketPath);
}

/**
 * Start the operator socket. Never throws into the caller: an operator tool
 * that cannot start is logged, and the api serves students regardless.
 */
export function startOperatorSocket(options: {
  socketPath: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  logger: Logger;
}): Promise<Server | null> {
  const { socketPath, logger } = options;
  try {
    prepareOperatorSocketPath(socketPath);
  } catch (error) {
    logger.error('ops.operator_socket.failed', { err: error }, 'the operator socket is not available');
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const server = createServer(options.handler);
    const failedToStart = (error: Error) => {
      logger.error('ops.operator_socket.failed', { err: error }, 'the operator socket is not available');
      resolve(null);
    };
    server.once('error', failedToStart);
    server.listen(socketPath, () => {
      /*
       * A listening server can still emit 'error' — an accept failing with
       * EMFILE when the process is out of descriptors. The one-shot listener
       * above would take the first and leave the next unhandled, which ends
       * the api; from here on every one is logged instead.
       */
      server.off('error', failedToStart);
      server.on('error', (error) => {
        logger.error('ops.operator_socket.failed', { err: error }, 'the operator socket reported an error');
      });
      try {
        chmodSync(socketPath, 0o600);
      } catch {
        /* the 0700 directory is the gate */
      }
      logger.info('ops.operator_socket.started', {}, `operator socket on ${socketPath}`);
      resolve(server);
    });
  });
}
