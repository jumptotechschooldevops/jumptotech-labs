/**
 * PostgreSQL implementation of the persistence port.
 *
 * Every value reaches the database as a bound parameter — there is no string
 * concatenation, no template literal, and no identifier taken from a request
 * anywhere in this file. The multi-write use cases (`createAttempt`,
 * `recordCheck`, `recordHint`) run inside one transaction each, so a student's
 * attempt row and their progress row can never disagree.
 *
 * This class is held to exactly the same behaviour as the in-memory store by
 * `test/repository-contract.ts`, which runs the same suite against both.
 */
import {
  ProgressError,
  type CheckOutcome,
  type HintOutcome,
  type HintUsage,
  type LabAttempt,
  type LabProgress,
  type NewAttempt,
  type ProgressStoreHealth,
  type Student,
} from '../types.js';
import type {
  EnsureStudentInput,
  FinishAttemptInput,
  ProgressRepository,
  RecordCheckInput,
  RecordHintInput,
} from '../repository.js';
import type { PostgresDatabase, SqlExecutor } from './database.js';

// --- row shapes --------------------------------------------------------------

interface StudentRow {
  student_id: string;
  display_name: string | null;
  identity_source: string;
  created_at: Date;
  last_seen_at: Date;
}

interface AttemptRow {
  attempt_id: string;
  student_id: string;
  lab_id: string;
  track: string;
  session_id: string | null;
  status: string;
  status_reason: string | null;
  started_at: Date;
  completed_at: Date | null;
  ended_at: Date | null;
  check_count: number;
  reset_count: number;
  updated_at: Date;
}

interface ProgressRow {
  student_id: string;
  lab_id: string;
  track: string;
  status: string;
  attempt_count: number;
  completion_count: number;
  first_completed_at: Date | null;
  last_completed_at: Date | null;
  last_attempt_id: string | null;
  first_attempt_at: Date;
  updated_at: Date;
}

interface HintRow {
  hint_usage_id: string;
  student_id: string;
  attempt_id: string;
  lab_id: string;
  hint_index: number;
  revealed_at: Date;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function toStudent(row: StudentRow): Student {
  return {
    studentId: row.student_id,
    displayName: row.display_name,
    identitySource: row.identity_source,
    createdAt: iso(row.created_at),
    lastSeenAt: iso(row.last_seen_at),
  };
}

function toAttempt(row: AttemptRow): LabAttempt {
  return {
    attemptId: row.attempt_id,
    studentId: row.student_id,
    labId: row.lab_id,
    track: row.track,
    sessionId: row.session_id,
    status: row.status as LabAttempt['status'],
    statusReason: row.status_reason,
    startedAt: iso(row.started_at),
    completedAt: isoOrNull(row.completed_at),
    endedAt: isoOrNull(row.ended_at),
    checkCount: Number(row.check_count),
    resetCount: Number(row.reset_count),
    updatedAt: iso(row.updated_at),
  };
}

function toProgress(row: ProgressRow): LabProgress {
  return {
    studentId: row.student_id,
    labId: row.lab_id,
    track: row.track,
    status: row.status as LabProgress['status'],
    attemptCount: Number(row.attempt_count),
    completionCount: Number(row.completion_count),
    firstCompletedAt: isoOrNull(row.first_completed_at),
    lastCompletedAt: isoOrNull(row.last_completed_at),
    lastAttemptId: row.last_attempt_id,
    firstAttemptAt: iso(row.first_attempt_at),
    updatedAt: iso(row.updated_at),
  };
}

function toHintUsage(row: HintRow): HintUsage {
  return {
    hintUsageId: row.hint_usage_id,
    studentId: row.student_id,
    attemptId: row.attempt_id,
    labId: row.lab_id,
    hintIndex: Number(row.hint_index),
    revealedAt: iso(row.revealed_at),
  };
}

const ATTEMPT_COLUMNS = `attempt_id, student_id, lab_id, track, session_id, status, status_reason,
                         started_at, completed_at, ended_at, check_count, reset_count, updated_at`;

const PROGRESS_COLUMNS = `student_id, lab_id, track, status, attempt_count, completion_count,
                          first_completed_at, last_completed_at, last_attempt_id, first_attempt_at,
                          updated_at`;

export class PostgresProgressRepository implements ProgressRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async ensureStudent(input: EnsureStudentInput): Promise<Student> {
    const { rows } = await this.db.query<StudentRow>(
      `INSERT INTO students (student_id, display_name, identity_source, created_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (student_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at
       RETURNING student_id, display_name, identity_source, created_at, last_seen_at`,
      [input.studentId, input.displayName ?? null, input.identitySource, input.at],
    );
    return toStudent(rows[0]!);
  }

  /** Attempt row and progress row are written together or not at all. */
  async createAttempt(input: NewAttempt): Promise<LabAttempt> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<AttemptRow>(
        `INSERT INTO lab_attempts
           (attempt_id, student_id, lab_id, track, status, started_at, updated_at)
         VALUES ($1, $2, $3, $4, 'IN_PROGRESS', $5, $5)
         RETURNING ${ATTEMPT_COLUMNS}`,
        [input.attemptId, input.studentId, input.labId, input.track, input.startedAt],
      );
      await touchProgressOnStart(tx, input);
      return toAttempt(rows[0]!);
    });
  }

  async bindSession(attemptId: string, sessionId: string, at: string): Promise<LabAttempt | null> {
    const { rows } = await this.db.query<AttemptRow>(
      `UPDATE lab_attempts SET session_id = $2, updated_at = $3
       WHERE attempt_id = $1
       RETURNING ${ATTEMPT_COLUMNS}`,
      [attemptId, sessionId, at],
    );
    return rows[0] ? toAttempt(rows[0]) : null;
  }

  async findAttempt(attemptId: string): Promise<LabAttempt | null> {
    if (!isUuid(attemptId)) return null;
    const { rows } = await this.db.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM lab_attempts WHERE attempt_id = $1`,
      [attemptId],
    );
    return rows[0] ? toAttempt(rows[0]) : null;
  }

  async findAttemptBySession(sessionId: string): Promise<LabAttempt | null> {
    const { rows } = await this.db.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM lab_attempts WHERE session_id = $1`,
      [sessionId],
    );
    return rows[0] ? toAttempt(rows[0]) : null;
  }

  /**
   * One transaction, one row lock.
   *
   * `SELECT … FOR UPDATE` first, so two Check Solution requests racing on the
   * same attempt serialise: the first sees `completed_at IS NULL` and records
   * the completion, the second sees it set and records only the check. Without
   * the lock both could observe null and increment `completion_count` twice.
   */
  async recordCheck(input: RecordCheckInput): Promise<CheckOutcome> {
    return this.db.transaction(async (tx) => {
      const locked = await tx.query<AttemptRow>(
        `SELECT ${ATTEMPT_COLUMNS} FROM lab_attempts WHERE attempt_id = $1 FOR UPDATE`,
        [input.attemptId],
      );
      const before = locked.rows[0];
      if (!before) {
        throw new ProgressError('ATTEMPT_NOT_FOUND', `No lab attempt ${input.attemptId}`);
      }

      const newlyCompleted = input.passed && before.completed_at === null;

      const updated = await tx.query<AttemptRow>(
        `UPDATE lab_attempts SET
           check_count  = check_count + 1,
           updated_at   = $2,
           status       = CASE WHEN $3::boolean THEN 'PASSED' ELSE status END,
           completed_at = CASE WHEN $3::boolean THEN COALESCE(completed_at, $2::timestamptz)
                               ELSE completed_at END
         WHERE attempt_id = $1
         RETURNING ${ATTEMPT_COLUMNS}`,
        [input.attemptId, input.at, input.passed],
      );
      const attempt = toAttempt(updated.rows[0]!);

      const progress = newlyCompleted
        ? await markCompleted(tx, attempt, input.at)
        : await readProgress(tx, attempt);

      return { attempt, passed: input.passed, newlyCompleted, progress };
    });
  }

  async recordReset(attemptId: string, at: string): Promise<LabAttempt | null> {
    const { rows } = await this.db.query<AttemptRow>(
      `UPDATE lab_attempts SET reset_count = reset_count + 1, updated_at = $2
       WHERE attempt_id = $1
       RETURNING ${ATTEMPT_COLUMNS}`,
      [attemptId, at],
    );
    return rows[0] ? toAttempt(rows[0]) : null;
  }

  /**
   * The sandbox went away.
   *
   * The `CASE` reads the row's pre-update status, so an attempt that already
   * PASSED keeps its status and only gains an `ended_at`. Nothing is deleted
   * and no completion is withdrawn.
   */
  async finishAttempt(input: FinishAttemptInput): Promise<LabAttempt | null> {
    const { rows } = await this.db.query<AttemptRow>(
      `UPDATE lab_attempts SET
         status        = CASE WHEN status = 'IN_PROGRESS' THEN $2 ELSE status END,
         status_reason = CASE WHEN status = 'IN_PROGRESS' THEN $3 ELSE status_reason END,
         ended_at      = COALESCE(ended_at, $4::timestamptz),
         updated_at    = $4
       WHERE attempt_id = $1
       RETURNING ${ATTEMPT_COLUMNS}`,
      [input.attemptId, input.outcome, input.reason ?? null, input.at],
    );
    return rows[0] ? toAttempt(rows[0]) : null;
  }

  /**
   * One statement, and only over attempts no sandbox can still back.
   *
   * `started_at < $1` where `$1` is older than the absolute session lifetime,
   * so this can never close an attempt that is still being worked on.
   */
  async expireStaleAttempts(input: {
    startedBefore: string;
    reason: string;
    at: string;
  }): Promise<number> {
    const { rows } = await this.db.query<{ attempt_id: string }>(
      `UPDATE lab_attempts SET
         status        = 'EXPIRED',
         status_reason = $2,
         ended_at      = COALESCE(ended_at, $3::timestamptz),
         updated_at    = $3
       WHERE status = 'IN_PROGRESS' AND started_at < $1::timestamptz
       RETURNING attempt_id`,
      [input.startedBefore, input.reason, input.at],
    );
    return rows.length;
  }

  /**
   * Idempotent by constraint: the second insert of the same (attempt, hint)
   * conflicts and writes nothing, and the original row is returned instead.
   */
  async recordHint(input: RecordHintInput): Promise<HintOutcome> {
    return this.db.transaction(async (tx) => {
      const owner = await tx.query<{ student_id: string; lab_id: string }>(
        'SELECT student_id, lab_id FROM lab_attempts WHERE attempt_id = $1',
        [input.attemptId],
      );
      const attempt = owner.rows[0];
      if (!attempt) {
        throw new ProgressError('ATTEMPT_NOT_FOUND', `No lab attempt ${input.attemptId}`);
      }

      const inserted = await tx.query<HintRow>(
        `INSERT INTO hint_usage
           (hint_usage_id, student_id, attempt_id, lab_id, hint_index, revealed_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT ON CONSTRAINT hint_usage_once_per_attempt DO NOTHING
         RETURNING hint_usage_id, student_id, attempt_id, lab_id, hint_index, revealed_at`,
        [
          input.hintUsageId,
          attempt.student_id,
          input.attemptId,
          attempt.lab_id,
          input.hintIndex,
          input.at,
        ],
      );

      const row =
        inserted.rows[0] ??
        (
          await tx.query<HintRow>(
            `SELECT hint_usage_id, student_id, attempt_id, lab_id, hint_index, revealed_at
             FROM hint_usage WHERE attempt_id = $1 AND hint_index = $2`,
            [input.attemptId, input.hintIndex],
          )
        ).rows[0]!;

      const counted = await tx.query<{ count: number }>(
        'SELECT COUNT(*)::bigint AS count FROM hint_usage WHERE attempt_id = $1',
        [input.attemptId],
      );

      return {
        usage: toHintUsage(row),
        recorded: inserted.rows.length > 0,
        revealedCount: Number(counted.rows[0]?.count ?? 0),
      };
    });
  }

  async listAttempts(studentId: string, limit: number): Promise<LabAttempt[]> {
    const { rows } = await this.db.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM lab_attempts
       WHERE student_id = $1
       ORDER BY started_at DESC, seq DESC
       LIMIT $2`,
      [studentId, limit],
    );
    return rows.map(toAttempt);
  }

  async getAttempt(studentId: string, attemptId: string): Promise<LabAttempt | null> {
    // A malformed id is a miss, not a 500: `uuid = $1` would otherwise raise a
    // type error for anything that is not a UUID.
    if (!isUuid(attemptId)) return null;
    const { rows } = await this.db.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM lab_attempts WHERE attempt_id = $1 AND student_id = $2`,
      [attemptId, studentId],
    );
    return rows[0] ? toAttempt(rows[0]) : null;
  }

  async listHintUsage(attemptId: string): Promise<HintUsage[]> {
    if (!isUuid(attemptId)) return [];
    const { rows } = await this.db.query<HintRow>(
      `SELECT hint_usage_id, student_id, attempt_id, lab_id, hint_index, revealed_at
       FROM hint_usage WHERE attempt_id = $1 ORDER BY hint_index ASC`,
      [attemptId],
    );
    return rows.map(toHintUsage);
  }

  async listProgress(studentId: string): Promise<LabProgress[]> {
    const { rows } = await this.db.query<ProgressRow>(
      `SELECT ${PROGRESS_COLUMNS} FROM lab_progress WHERE student_id = $1 ORDER BY lab_id ASC`,
      [studentId],
    );
    return rows.map(toProgress);
  }

  async health(): Promise<ProgressStoreHealth> {
    try {
      await this.db.ping();
      return { ok: true, store: 'postgres', detail: this.db.description };
    } catch (error) {
      return {
        ok: false,
        store: 'postgres',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

// --- shared statements -------------------------------------------------------

/**
 * "This student has started this lab."
 *
 * Starting a lab a second time increments the attempt count and never demotes
 * a completed lab back to in-progress — practising something you have already
 * passed does not un-pass it.
 */
async function touchProgressOnStart(tx: SqlExecutor, input: NewAttempt): Promise<void> {
  await tx.query(
    `INSERT INTO lab_progress
       (student_id, lab_id, track, status, attempt_count, completion_count,
        last_attempt_id, first_attempt_at, updated_at)
     VALUES ($1, $2, $3, 'IN_PROGRESS', 1, 0, $4, $5, $5)
     ON CONFLICT (student_id, lab_id) DO UPDATE SET
       attempt_count   = lab_progress.attempt_count + 1,
       last_attempt_id = EXCLUDED.last_attempt_id,
       status          = CASE WHEN lab_progress.status = 'COMPLETED' THEN 'COMPLETED'
                              ELSE 'IN_PROGRESS' END,
       updated_at      = EXCLUDED.updated_at`,
    [input.studentId, input.labId, input.track, input.attemptId, input.startedAt],
  );
}

async function markCompleted(
  tx: SqlExecutor,
  attempt: LabAttempt,
  at: string,
): Promise<LabProgress> {
  const { rows } = await tx.query<ProgressRow>(
    `INSERT INTO lab_progress
       (student_id, lab_id, track, status, attempt_count, completion_count,
        first_completed_at, last_completed_at, last_attempt_id, first_attempt_at, updated_at)
     VALUES ($1, $2, $3, 'COMPLETED', 1, 1, $5, $5, $4, $5, $5)
     ON CONFLICT (student_id, lab_id) DO UPDATE SET
       status             = 'COMPLETED',
       completion_count   = lab_progress.completion_count + 1,
       first_completed_at = COALESCE(lab_progress.first_completed_at, EXCLUDED.first_completed_at),
       last_completed_at  = EXCLUDED.last_completed_at,
       updated_at         = EXCLUDED.updated_at
     RETURNING ${PROGRESS_COLUMNS}`,
    [attempt.studentId, attempt.labId, attempt.track, attempt.attemptId, at],
  );
  return toProgress(rows[0]!);
}

/** The stored progress row, materialised if it is somehow missing. */
async function readProgress(tx: SqlExecutor, attempt: LabAttempt): Promise<LabProgress> {
  const found = await tx.query<ProgressRow>(
    `SELECT ${PROGRESS_COLUMNS} FROM lab_progress WHERE student_id = $1 AND lab_id = $2`,
    [attempt.studentId, attempt.labId],
  );
  if (found.rows[0]) return toProgress(found.rows[0]);

  const created = await tx.query<ProgressRow>(
    `INSERT INTO lab_progress
       (student_id, lab_id, track, status, attempt_count, completion_count,
        last_attempt_id, first_attempt_at, updated_at)
     VALUES ($1, $2, $3, 'IN_PROGRESS', 1, 0, $4, $5, $5)
     ON CONFLICT (student_id, lab_id) DO UPDATE SET updated_at = EXCLUDED.updated_at
     RETURNING ${PROGRESS_COLUMNS}`,
    [attempt.studentId, attempt.labId, attempt.track, attempt.attemptId, attempt.updatedAt],
  );
  return toProgress(created.rows[0]!);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
