/**
 * The persistence port.
 *
 * Every operation is a *use case*, not a CRUD primitive: `recordCheck` rather
 * than `updateAttempt` + `upsertProgress`. That is deliberate. The two writes
 * behind a passing check have to happen together or not at all, and an
 * interface of setters would push that decision up into a route handler where
 * it cannot be enforced. Here, the PostgreSQL implementation wraps them in one
 * transaction and the in-memory implementation performs them synchronously —
 * and both are held to the same behaviour by one shared contract test suite
 * (`test/repository-contract.ts`).
 *
 * No SQL exists above this interface. Routes call the service, the service
 * calls the port, and only `postgres/repository.ts` knows a database is
 * involved. Swapping the store is a one-line change in the composition root.
 */
import type {
  AttemptOutcome,
  CheckOutcome,
  HintOutcome,
  HintUsage,
  LabAttempt,
  LabProgress,
  NewAttempt,
  ProgressStoreHealth,
  Student,
} from './types.js';

export interface EnsureStudentInput {
  studentId: string;
  identitySource: string;
  displayName?: string | null;
  at: string;
}

export interface RecordCheckInput {
  attemptId: string;
  passed: boolean;
  at: string;
}

export interface FinishAttemptInput {
  attemptId: string;
  outcome: AttemptOutcome;
  reason?: string | undefined;
  at: string;
}

export interface RecordHintInput {
  hintUsageId: string;
  attemptId: string;
  hintIndex: number;
  at: string;
}

export interface ProgressRepository {
  /** Idempotent: creates the student on first sight, refreshes `last_seen_at`. */
  ensureStudent(input: EnsureStudentInput): Promise<Student>;

  /**
   * Open an attempt.
   *
   * Also touches `lab_progress`, because "this student has started this lab" is
   * itself progress the catalog renders — and because a lab that is started,
   * abandoned, and started again must show one lab in progress, not two.
   */
  createAttempt(input: NewAttempt): Promise<LabAttempt>;

  /** Bind the sandbox session that ended up hosting an attempt. */
  bindSession(attemptId: string, sessionId: string, at: string): Promise<LabAttempt | null>;

  findAttempt(attemptId: string): Promise<LabAttempt | null>;

  /**
   * The attempt a sandbox session belongs to.
   *
   * This is how every session-scoped route reaches persistence: the browser
   * sends a session id (which is already its capability for that sandbox), and
   * the attempt — and therefore the student — is resolved server-side. No route
   * accepts an attempt id or a student id as input for a write.
   */
  findAttemptBySession(sessionId: string): Promise<LabAttempt | null>;

  /**
   * Record one Check Solution, transactionally.
   *
   * Always increments `check_count`. On the first passing check it also sets
   * `completed_at`, moves the attempt to PASSED, and marks the lab completed
   * for the student. A repeated pass increments the check count and changes
   * nothing else — `newlyCompleted` is false and no second completion is
   * recorded.
   */
  recordCheck(input: RecordCheckInput): Promise<CheckOutcome>;

  /**
   * Increment `reset_count`.
   *
   * Resetting wipes the sandbox, never the record: no attempt row is deleted,
   * no completion is withdrawn, and an attempt that already passed stays
   * passed.
   */
  recordReset(attemptId: string, at: string): Promise<LabAttempt | null>;

  /**
   * Close an attempt because its sandbox went away.
   *
   * `ended_at` is stamped whatever the outcome. The status only moves to
   * ENDED/EXPIRED/FAILED if the attempt had not already passed — the sandbox
   * lifecycle does not get to overwrite a learning result.
   */
  finishAttempt(input: FinishAttemptInput): Promise<LabAttempt | null>;

  /**
   * Record a hint reveal, at most once per (attempt, hint).
   *
   * Idempotent by construction rather than by convention: the uniqueness lives
   * in the schema, so a frontend that replays the same request — or two tabs
   * racing — cannot inflate the count.
   */
  recordHint(input: RecordHintInput): Promise<HintOutcome>;

  /**
   * Close attempts that have been open longer than any sandbox can live.
   *
   * The sandbox layer is in memory, so an API restart forgets every live
   * session — and with it, the event that would have closed those attempts.
   * Without this sweep a student's dashboard would show a lab stuck "in
   * progress" forever.
   *
   * `startedBefore` must be older than the absolute session lifetime, which is
   * what makes this safe: past that deadline no sandbox can still exist, so the
   * sweep cannot close an attempt somebody is still working on — not even one
   * belonging to another API instance.
   *
   * Returns how many attempts were closed.
   */
  expireStaleAttempts(input: {
    startedBefore: string;
    reason: string;
    at: string;
  }): Promise<number>;

  /** Most recent attempts first. */
  listAttempts(studentId: string, limit: number): Promise<LabAttempt[]>;

  /** Scoped to the owner: an attempt of another student's is not visible. */
  getAttempt(studentId: string, attemptId: string): Promise<LabAttempt | null>;

  listHintUsage(attemptId: string): Promise<HintUsage[]>;

  /** Every lab this student has touched. Labs never started have no row. */
  listProgress(studentId: string): Promise<LabProgress[]>;

  health(): Promise<ProgressStoreHealth>;

  close(): Promise<void>;
}
