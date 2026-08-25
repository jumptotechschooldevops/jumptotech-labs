/**
 * The durable `SessionStore` — PLATFORM-008.
 *
 * Every line of SQL in the session lifecycle lives in this file. Routes, the
 * manager, the reaper and the providers all keep working in terms of
 * `SessionStore`, which is what makes swapping the in-memory store for this one
 * a change to the composition root and nothing else.
 *
 * What durability buys, concretely: an API restart used to lose every session
 * record while the sandboxes carried on running, so the student's lab was
 * unreachable and the sandbox was an orphan nobody would reclaim. The rows now
 * outlive the process, so any healthy instance can resolve a session it did not
 * create, and the reaper finds expired sessions no process remembers.
 *
 * ## Concurrency
 *
 * Two API instances may act on one session at the same time — a student
 * pressing End while a reaper expires the same row. A read-then-write cannot
 * make that safe: both read `ACTIVE`, both write, and the later one silently
 * wins, which is how `ENDED` gets resurrected.
 *
 * So no lifecycle change is a read-then-write. Each is a **single conditional
 * UPDATE** naming the states it is allowed to move from. Exactly one caller
 * gets the row back; the others get `null` and can *see* they lost rather than
 * assume they won. `revision` advances on every write, so a caller holding a
 * stale copy matches nothing.
 *
 * Capacity is the one place needing more than that, because it is a check
 * against a *set* rather than a row: two instances could each count 4 of 5 and
 * both admit. A transaction-scoped advisory lock serialises just that check —
 * narrower than SERIALIZABLE and it cannot deadlock, since it is one lock taken
 * for the duration of one short transaction.
 *
 * ## What is not here
 *
 * No credential of any kind. A kubeconfig, a Docker client certificate and an
 * AWS credential are all minted on demand by the provider when the terminal
 * asks, and none is a field on `LabSession` — so there is nothing to leave out
 * of these statements. The table holds identifiers and timestamps.
 */
import {
  OCCUPYING_STATUSES,
  occupiesCapacity,
  type LabSession,
  type SessionStatus,
} from './types.js';
import type { SessionStore } from './store.js';

/**
 * The database seam.
 *
 * Structurally identical to `@jumptotech/progress`'s `SqlExecutor`, declared
 * here so the orchestrator gains no dependency on the progress service to talk
 * to a database. The composition root passes the one pooled connection both
 * already share.
 */
export interface SessionSqlExecutor {
  query<R>(text: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
}

/** One row of `lab_sessions`, as PostgreSQL returns it. */
interface SessionRow {
  session_id: string;
  lab_id: string;
  provider: string;
  sandbox_kind: string;
  sandbox_ref: string;
  namespace: string;
  service_account_name: string;
  status: string;
  environment_id: string;
  owner_user_id: string | null;
  created_at: Date | string;
  last_activity_at: Date | string;
  expires_at: Date | string;
  ended_at: Date | string | null;
  status_reason: string | null;
  idle_timeout_seconds: number;
  idle_warning_seconds: number;
  revision: string | number;
}

const COLUMNS = `session_id, lab_id, provider, sandbox_kind, sandbox_ref, namespace,
  service_account_name, status, environment_id, owner_user_id, created_at, last_activity_at,
  expires_at, ended_at, status_reason, idle_timeout_seconds, idle_warning_seconds, revision`;

/** Timestamps come back as `Date`; the model is ISO-8601 strings throughout. */
function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toSession(row: SessionRow): LabSession {
  return {
    sessionId: row.session_id,
    labId: row.lab_id,
    provider: row.provider as LabSession['provider'],
    sandboxKind: row.sandbox_kind as LabSession['sandboxKind'],
    sandboxRef: row.sandbox_ref,
    namespace: row.namespace,
    serviceAccountName: row.service_account_name,
    status: row.status as SessionStatus,
    environmentId: row.environment_id,
    ...(row.owner_user_id ? { ownerUserId: row.owner_user_id } : {}),
    createdAt: iso(row.created_at),
    lastActivityAt: iso(row.last_activity_at),
    expiresAt: iso(row.expires_at),
    ...(row.ended_at ? { endedAt: iso(row.ended_at) } : {}),
    ...(row.status_reason ? { statusReason: row.status_reason } : {}),
    idleTimeoutSeconds: row.idle_timeout_seconds,
    idleWarningSeconds: row.idle_warning_seconds,
  };
}

/**
 * Columns a patch may write, and the model field each comes from.
 *
 * A closed table rather than a loop over the patch: identity — the session id,
 * its provider, its sandbox kind and its sandbox handle — is fixed at creation,
 * and leaving those out here is what makes "a live session cannot be moved to
 * another sandbox" true by construction, exactly as the in-memory store does it.
 */
const PATCHABLE = {
  status: 'status',
  environmentId: 'environment_id',
  lastActivityAt: 'last_activity_at',
  expiresAt: 'expires_at',
  endedAt: 'ended_at',
  statusReason: 'status_reason',
  idleTimeoutSeconds: 'idle_timeout_seconds',
  idleWarningSeconds: 'idle_warning_seconds',
  serviceAccountName: 'service_account_name',
} as const satisfies Partial<Record<keyof LabSession, string>>;

/** Build the `SET` fragment for a patch. Values are always parameterised. */
function assignments(
  patch: Partial<LabSession>,
  params: unknown[],
): string[] {
  const sets: string[] = [];
  for (const [field, column] of Object.entries(PATCHABLE)) {
    const value = patch[field as keyof LabSession];
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  return sets;
}

/** A stable 64-bit key for the capacity advisory lock. */
const CAPACITY_LOCK_KEY = 8_008_001;

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly db: SessionSqlExecutor) {}

  async create(session: LabSession): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO lab_sessions (${COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,1)`,
        [
          session.sessionId,
          session.labId,
          session.provider,
          session.sandboxKind,
          session.sandboxRef,
          session.namespace,
          session.serviceAccountName,
          session.status,
          session.environmentId,
          session.ownerUserId ?? null,
          session.createdAt,
          session.lastActivityAt,
          session.expiresAt,
          session.endedAt ?? null,
          session.statusReason ?? null,
          session.idleTimeoutSeconds,
          session.idleWarningSeconds,
        ],
      );
    } catch (error) {
      // A duplicate id or a duplicate sandbox handle is a conflict, not a
      // database failure, and the message must say which without echoing the
      // driver's text back to a caller.
      if (isUniqueViolation(error)) {
        throw new Error(`session ${session.sessionId} already exists`);
      }
      throw error;
    }
  }

  async get(sessionId: string): Promise<LabSession | null> {
    const { rows } = await this.db.query<SessionRow>(
      `SELECT ${COLUMNS} FROM lab_sessions WHERE session_id = $1`,
      [sessionId],
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  async update(sessionId: string, patch: Partial<LabSession>): Promise<LabSession | null> {
    const params: unknown[] = [];
    const sets = assignments(patch, params);
    if (sets.length === 0) return this.get(sessionId);

    params.push(sessionId);
    const { rows } = await this.db.query<SessionRow>(
      `UPDATE lab_sessions SET ${sets.join(', ')}, revision = revision + 1
       WHERE session_id = $${params.length}
       RETURNING ${COLUMNS}`,
      params,
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  /**
   * The conditional write every lifecycle change goes through.
   *
   * `status = ANY($from)` is the whole mechanism: the row moves only if it is
   * still where the caller believed it was. A second instance attempting the
   * same transition matches nothing and is told so.
   */
  async transition(
    sessionId: string,
    from: readonly SessionStatus[],
    to: SessionStatus,
    patch: Partial<LabSession> = {},
  ): Promise<LabSession | null> {
    const params: unknown[] = [];
    const sets = assignments({ ...patch, status: to }, params);
    params.push(sessionId, [...from]);

    const { rows } = await this.db.query<SessionRow>(
      `UPDATE lab_sessions SET ${sets.join(', ')}, revision = revision + 1
       WHERE session_id = $${params.length - 1} AND status = ANY($${params.length})
       RETURNING ${COLUMNS}`,
      params,
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  /**
   * Activity, which may never revive a finished session.
   *
   * Restricted to the occupying states for that reason: a ping racing an End
   * must not move `ENDED` back to `ACTIVE`.
   */
  async touchActivity(sessionId: string, at: string): Promise<LabSession | null> {
    const { rows } = await this.db.query<SessionRow>(
      `UPDATE lab_sessions
          SET last_activity_at = $1, revision = revision + 1
        WHERE session_id = $2 AND status = ANY($3)
        RETURNING ${COLUMNS}`,
      [at, sessionId, [...OCCUPYING_STATUSES]],
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  async delete(sessionId: string): Promise<void> {
    await this.db.query(`DELETE FROM lab_sessions WHERE session_id = $1`, [sessionId]);
  }

  async list(): Promise<LabSession[]> {
    const { rows } = await this.db.query<SessionRow>(
      `SELECT ${COLUMNS} FROM lab_sessions ORDER BY created_at`,
    );
    return rows.map(toSession);
  }

  async listOccupying(): Promise<LabSession[]> {
    const { rows } = await this.db.query<SessionRow>(
      `SELECT ${COLUMNS} FROM lab_sessions WHERE status = ANY($1) ORDER BY created_at`,
      [[...OCCUPYING_STATUSES]],
    );
    return rows.map(toSession);
  }

  /**
   * Expiry candidates: past the absolute deadline, or idle too long.
   *
   * Computed in the database so a fresh instance finds sessions no process
   * remembers — which is the point of the whole story.
   */
  async listExpirable(nowIso: string): Promise<LabSession[]> {
    const { rows } = await this.db.query<SessionRow>(
      `SELECT ${COLUMNS} FROM lab_sessions
        WHERE status = ANY($1)
          AND (expires_at <= $2::timestamptz
               OR last_activity_at + (idle_timeout_seconds * INTERVAL '1 second') <= $2::timestamptz)
        ORDER BY expires_at`,
      [[...OCCUPYING_STATUSES], nowIso],
    );
    return rows.map(toSession);
  }

  async countOccupying(): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM lab_sessions WHERE status = ANY($1)`,
      [[...OCCUPYING_STATUSES]],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async findBySandboxRef(sandboxRef: string): Promise<LabSession | null> {
    const { rows } = await this.db.query<SessionRow>(
      `SELECT ${COLUMNS} FROM lab_sessions WHERE sandbox_ref = $1`,
      [sandboxRef],
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  async findByNamespace(namespace: string): Promise<LabSession | null> {
    return this.findBySandboxRef(namespace);
  }

  /**
   * Reserve a capacity slot and insert, atomically.
   *
   * The check is against a *set*, so a conditional UPDATE cannot express it:
   * two instances could each count four of five and both admit a fifth. The
   * advisory lock is transaction-scoped and taken on one constant, so it
   * serialises exactly this check and is released when the transaction ends —
   * including when it aborts.
   *
   * Returns `false` when the deployment is at capacity, so the caller can
   * refuse the start without a sandbox ever being created.
   */
  async createWithinCapacity(session: LabSession, maxOccupying: number): Promise<boolean> {
    await this.db.query('BEGIN');
    try {
      await this.db.query('SELECT pg_advisory_xact_lock($1)', [CAPACITY_LOCK_KEY]);
      const occupied = await this.countOccupying();
      if (occupiesCapacity(session.status) && occupied >= maxOccupying) {
        await this.db.query('ROLLBACK');
        return false;
      }
      await this.create(session);
      await this.db.query('COMMIT');
      return true;
    } catch (error) {
      await this.db.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
}

/** A PostgreSQL unique-violation, without depending on the driver's types. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  );
}
