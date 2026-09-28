/**
 * Session events — migration 008.
 *
 * One row per thing that happened to a student's lab: a Start and how it went,
 * each Check and whether it graded or could not read the environment, each
 * Reset, each End, the cleanup that confirmed the sandbox gone, and a staff
 * member ending a lab for a student. The classroom view reads them to answer
 * the questions an instructor is actually asked:
 *
 * ```text
 *   "Check says error"        check  error  VERIFY_…      ← the platform, not the student
 *   "I pressed Check"         check  fail                 ← graded; not finished yet
 *   "Reset doesn't work"      reset  failed SESSION_RESET_FAILED
 *   "I ended it, is it gone?" end    pending → cleanup ok
 *   "It won't let me start"   start  refused LAB_CAPACITY_REACHED
 * ```
 *
 * ## What an event never holds
 *
 * A message, a command, terminal output, a requirement's expected value, a
 * credential, anything a student typed. `code` is a machine code squeezed to
 * an identifier shape (`safeCode`) before it is stored, and the table refuses
 * anything else, so a provider's prose cannot land here even by mistake.
 *
 * ## Recording never breaks the classroom
 *
 * `recordSafely` swallows and logs. An event is support information; losing
 * one is a gap in a timeline, and failing a student's Check because the
 * timeline could not be written would be the wrong way round.
 */
import type { Logger } from '@jumptotech/observability';

export const SESSION_OPERATIONS = ['start', 'check', 'reset', 'end', 'cleanup', 'staff_end'] as const;
export type SessionOperation = (typeof SESSION_OPERATIONS)[number];

/**
 * Outcomes, deliberately not one "success/failure" pair.
 *
 * `pass`/`fail` are a *grade* — a Check that ran and read the environment.
 * `error` is a Check that could not read it: the platform's problem, never the
 * student's. `refused` is an operation turned away before it did anything
 * (capacity, a lab already running). `failed` is one that ran and did not
 * finish. `pending` is an End whose cleanup is not confirmed yet.
 */
export const SESSION_OUTCOMES = ['ok', 'pass', 'fail', 'error', 'refused', 'failed', 'pending'] as const;
export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

export interface SessionEvent {
  eventId: string;
  /** Absent only for a Start refused before any session existed. */
  sessionId?: string;
  labId: string;
  /** The student whose lab this is. */
  ownerUserId?: string;
  /** Who asked. Absent: the platform itself (the reaper). */
  actorUserId?: string;
  operation: SessionOperation;
  outcome: SessionOutcome;
  code?: string;
  durationMs?: number;
  occurredAt: string;
}

export type SessionEventInput = Omit<SessionEvent, 'eventId' | 'occurredAt'> & { occurredAt?: string };

/** The newest event of each operation, for one session. */
export type LatestEvents = Partial<Record<SessionOperation, SessionEvent>>;

export interface SessionEventStore {
  record(event: SessionEventInput): Promise<void>;
  /** Newest first. */
  listForSession(sessionId: string, limit: number): Promise<SessionEvent[]>;
  /** Newest first. */
  listForOwner(ownerUserId: string, limit: number): Promise<SessionEvent[]>;
  /** Newest first, at or after `sinceIso`, only the listed outcomes. */
  listRecent(options: { sinceIso: string; outcomes: readonly SessionOutcome[]; limit: number }): Promise<SessionEvent[]>;
  /** One query for a whole classroom: the newest event per (session, operation). */
  latestForSessions(sessionIds: readonly string[]): Promise<Map<string, LatestEvents>>;
  /** Removes events older than `beforeIso`; returns how many. */
  purgeOlderThan(beforeIso: string): Promise<number>;
}

/** Hard ceiling on any read, whatever a caller asks for. */
export const MAX_EVENT_READ = 200;

/** How long events are kept. Long enough for "what happened in last week's class". */
export const SESSION_EVENT_RETENTION_DAYS = 30;

export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.min(MAX_EVENT_READ, Math.max(1, Math.trunc(limit)));
}

const CODE_SHAPE = /^[A-Za-z0-9_.-]{1,64}$/;

/** A machine code as stored: an identifier, or nothing. Never prose. */
export function safeCode(code: unknown): string | undefined {
  if (typeof code !== 'string' || code.length === 0) return undefined;
  return CODE_SHAPE.test(code) ? code : 'unknown';
}

function normalise(event: SessionEventInput): SessionEventInput {
  const code = safeCode(event.code);
  return {
    ...event,
    ...(code ? { code } : { code: undefined }),
    ...(event.durationMs !== undefined
      ? { durationMs: Math.max(0, Math.min(2_147_483_647, Math.round(event.durationMs))) }
      : {}),
  };
}

/**
 * Record, and never throw.
 *
 * Returns nothing a caller could branch on: an event is support information,
 * and no operation's result may depend on whether it was written.
 */
export async function recordSafely(
  store: SessionEventStore | undefined,
  logger: Pick<Logger, 'warn'> | undefined,
  event: SessionEventInput,
): Promise<void> {
  if (!store) return;
  try {
    await store.record(event);
  } catch (error) {
    try {
      logger?.warn('session_event.write_failed', {
        operation: event.operation,
        outcome: event.outcome,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        err: error,
      });
    } catch {
      /* a broken logger never breaks the classroom either */
    }
  }
}

// --- in memory -------------------------------------------------------------------

/** For tests and for running without a database. Same bounds as the durable one. */
export class InMemorySessionEventStore implements SessionEventStore {
  readonly #events: SessionEvent[] = [];
  #next = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async record(input: SessionEventInput): Promise<void> {
    const event = normalise(input);
    this.#next += 1;
    this.#events.push({
      eventId: String(this.#next),
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      labId: event.labId,
      ...(event.ownerUserId ? { ownerUserId: event.ownerUserId } : {}),
      ...(event.actorUserId ? { actorUserId: event.actorUserId } : {}),
      operation: event.operation,
      outcome: event.outcome,
      ...(event.code ? { code: event.code } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      occurredAt: event.occurredAt ?? new Date(this.now()).toISOString(),
    });
  }

  #newestFirst(filter: (event: SessionEvent) => boolean, limit: number): SessionEvent[] {
    const out: SessionEvent[] = [];
    for (let i = this.#events.length - 1; i >= 0 && out.length < clampLimit(limit); i -= 1) {
      const event = this.#events[i]!;
      if (filter(event)) out.push(event);
    }
    return out;
  }

  async listForSession(sessionId: string, limit: number): Promise<SessionEvent[]> {
    return this.#newestFirst((event) => event.sessionId === sessionId, limit);
  }

  async listForOwner(ownerUserId: string, limit: number): Promise<SessionEvent[]> {
    return this.#newestFirst((event) => event.ownerUserId === ownerUserId, limit);
  }

  async listRecent(options: {
    sinceIso: string;
    outcomes: readonly SessionOutcome[];
    limit: number;
  }): Promise<SessionEvent[]> {
    const since = Date.parse(options.sinceIso);
    return this.#newestFirst(
      (event) => Date.parse(event.occurredAt) >= since && options.outcomes.includes(event.outcome),
      options.limit,
    );
  }

  async latestForSessions(sessionIds: readonly string[]): Promise<Map<string, LatestEvents>> {
    const wanted = new Set(sessionIds);
    const out = new Map<string, LatestEvents>();
    for (let i = this.#events.length - 1; i >= 0; i -= 1) {
      const event = this.#events[i]!;
      if (!event.sessionId || !wanted.has(event.sessionId)) continue;
      const latest = out.get(event.sessionId) ?? {};
      if (!latest[event.operation]) latest[event.operation] = event;
      out.set(event.sessionId, latest);
    }
    return out;
  }

  async purgeOlderThan(beforeIso: string): Promise<number> {
    const before = Date.parse(beforeIso);
    let removed = 0;
    for (let i = this.#events.length - 1; i >= 0; i -= 1) {
      if (Date.parse(this.#events[i]!.occurredAt) < before) {
        this.#events.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }
}

// --- PostgreSQL --------------------------------------------------------------------

export interface SessionEventSqlExecutor {
  query<R>(text: string, params?: readonly unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}

interface EventRow {
  event_id: string | number;
  session_id: string | null;
  lab_id: string;
  owner_user_id: string | null;
  actor_user_id: string | null;
  operation: SessionOperation;
  outcome: SessionOutcome;
  code: string | null;
  duration_ms: number | null;
  occurred_at: Date | string;
}

const COLUMNS =
  'event_id, session_id, lab_id, owner_user_id, actor_user_id, operation, outcome, code, duration_ms, occurred_at';

function toEvent(row: EventRow): SessionEvent {
  return {
    eventId: String(row.event_id),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    labId: row.lab_id,
    ...(row.owner_user_id ? { ownerUserId: row.owner_user_id } : {}),
    ...(row.actor_user_id ? { actorUserId: row.actor_user_id } : {}),
    operation: row.operation,
    outcome: row.outcome,
    ...(row.code ? { code: row.code } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    occurredAt: (row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at)).toISOString(),
  };
}

/** A user id as the users table mints them; anything else is stored as NULL rather than failing the write. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidOrNull(value: string | undefined): string | null {
  return value && UUID_SHAPE.test(value) ? value : null;
}

export class PostgresSessionEventStore implements SessionEventStore {
  constructor(private readonly db: SessionEventSqlExecutor) {}

  async record(input: SessionEventInput): Promise<void> {
    const event = normalise(input);
    await this.db.query(
      `INSERT INTO session_events
         (session_id, lab_id, owner_user_id, actor_user_id, operation, outcome, code, duration_ms, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()))`,
      [
        event.sessionId ?? null,
        event.labId.slice(0, 64),
        uuidOrNull(event.ownerUserId),
        uuidOrNull(event.actorUserId),
        event.operation,
        event.outcome,
        event.code ?? null,
        event.durationMs ?? null,
        event.occurredAt ?? null,
      ],
    );
  }

  async listForSession(sessionId: string, limit: number): Promise<SessionEvent[]> {
    const { rows } = await this.db.query<EventRow>(
      `SELECT ${COLUMNS} FROM session_events WHERE session_id = $1 ORDER BY event_id DESC LIMIT $2`,
      [sessionId, clampLimit(limit)],
    );
    return rows.map(toEvent);
  }

  async listForOwner(ownerUserId: string, limit: number): Promise<SessionEvent[]> {
    const owner = uuidOrNull(ownerUserId);
    if (!owner) return [];
    const { rows } = await this.db.query<EventRow>(
      `SELECT ${COLUMNS} FROM session_events WHERE owner_user_id = $1 ORDER BY event_id DESC LIMIT $2`,
      [owner, clampLimit(limit)],
    );
    return rows.map(toEvent);
  }

  async listRecent(options: {
    sinceIso: string;
    outcomes: readonly SessionOutcome[];
    limit: number;
  }): Promise<SessionEvent[]> {
    const { rows } = await this.db.query<EventRow>(
      `SELECT ${COLUMNS} FROM session_events
        WHERE occurred_at >= $1::timestamptz AND outcome = ANY($2)
        ORDER BY event_id DESC LIMIT $3`,
      [options.sinceIso, [...options.outcomes], clampLimit(options.limit)],
    );
    return rows.map(toEvent);
  }

  async latestForSessions(sessionIds: readonly string[]): Promise<Map<string, LatestEvents>> {
    const out = new Map<string, LatestEvents>();
    const ids = [...new Set(sessionIds)].slice(0, MAX_EVENT_READ);
    if (ids.length === 0) return out;
    const { rows } = await this.db.query<EventRow>(
      `SELECT DISTINCT ON (session_id, operation) ${COLUMNS}
         FROM session_events
        WHERE session_id = ANY($1)
        ORDER BY session_id, operation, event_id DESC`,
      [ids],
    );
    for (const row of rows) {
      const event = toEvent(row);
      const latest = out.get(event.sessionId!) ?? {};
      latest[event.operation] = event;
      out.set(event.sessionId!, latest);
    }
    return out;
  }

  async purgeOlderThan(beforeIso: string): Promise<number> {
    const result = await this.db.query(`DELETE FROM session_events WHERE occurred_at < $1::timestamptz`, [beforeIso]);
    return result.rowCount ?? 0;
  }
}
