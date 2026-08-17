/**
 * Persistent learning domain (PLATFORM-005).
 *
 * These types describe what a student *did*, and they deliberately know nothing
 * about how the sandbox that hosted it was built. There is no namespace here, no
 * container reference, no provider implementation and no Kubernetes anything —
 * a lab attempt records a `track` and a `session_id`, both of which are plain
 * strings from this layer's point of view.
 *
 * ```text
 *   Student Identity        students
 *        ↓
 *   Persistent Learning     lab_progress          ← survives every sandbox
 *        ↓
 *   Lab Attempt             lab_attempts          ← one try at one lab
 *        ↓                  hint_usage
 *   Temporary Sandbox       (session_id, in the orchestrator)
 *        ↓
 *   Provider                (kubernetes | linux | terraform)
 * ```
 *
 * The arrow only ever points downwards. Nothing in this package imports the
 * orchestrator, and nothing here may be given a provider-specific field: the
 * moment a column called `namespace` appears in this file, deleting a namespace
 * has become capable of damaging a student's history.
 *
 * Timestamps are ISO-8601 strings, matching the session layer, so a record can
 * cross an HTTP boundary without a second serialisation convention.
 */

/**
 * The lifecycle of one attempt at one lab.
 *
 * ```text
 *   IN_PROGRESS ──► PASSED     the verifier returned PASS
 *        │
 *        ├────────► ENDED      the student pressed End Lab without passing
 *        ├────────► EXPIRED    the sandbox hit its idle/absolute deadline
 *        └────────► FAILED     the sandbox could not be provisioned at all
 * ```
 *
 * `PASSED` is absorbing. A student who passes and *then* ends or expires the
 * lab has still passed: the teardown records `ended_at` and leaves the status
 * alone. This is the whole point of separating the two timestamps — one is
 * about learning, the other is about infrastructure.
 *
 * Never a `completed` boolean: "ended without passing" and "expired without
 * passing" are different facts, and a boolean cannot tell them apart.
 */
export const ATTEMPT_STATUSES = ['IN_PROGRESS', 'PASSED', 'FAILED', 'ENDED', 'EXPIRED'] as const;

export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** Statuses from which an attempt can no longer change. */
export const CLOSED_ATTEMPT_STATUSES: readonly AttemptStatus[] = [
  'PASSED',
  'FAILED',
  'ENDED',
  'EXPIRED',
];

export function isClosedAttempt(status: AttemptStatus): boolean {
  return CLOSED_ATTEMPT_STATUSES.includes(status);
}

/** How an attempt that never passed was closed. */
export type AttemptOutcome = Extract<AttemptStatus, 'ENDED' | 'EXPIRED' | 'FAILED'>;

/**
 * Stored per-lab progress.
 *
 * `NOT_STARTED` is deliberately absent: a lab a student has never opened has no
 * row, and inventing one for every lab in the catalog would make the table grow
 * with the catalog rather than with what students actually do. The API derives
 * `NOT_STARTED` by subtracting these rows from the catalog.
 */
export const PROGRESS_STATUSES = ['IN_PROGRESS', 'COMPLETED'] as const;

export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];

/**
 * A student.
 *
 * `identitySource` records *how* this identity was established, so the day
 * authentication arrives the rows created before it are still legible rather
 * than silently reinterpreted as authenticated users. In PLATFORM-005 it is
 * always `development`.
 */
export interface Student {
  studentId: string;
  displayName: string | null;
  identitySource: string;
  createdAt: string;
  lastSeenAt: string;
}

/** One attempt at one lab. */
export interface LabAttempt {
  attemptId: string;
  studentId: string;
  labId: string;
  track: string;
  /**
   * The sandbox session that hosted this attempt, when one was created.
   *
   * Nullable on purpose. The attempt is the parent of the session, not the
   * other way round: it exists from the moment the student presses Start, and
   * it outlives the sandbox by a long way. When the sandbox is deleted this
   * column keeps pointing at a session id that no longer resolves, which is
   * correct — it is a historical reference, not a live handle.
   */
  sessionId: string | null;
  status: AttemptStatus;
  /** Why the attempt closed the way it did. Operator- and student-facing. */
  statusReason: string | null;
  startedAt: string;
  /** When the verifier first returned PASS. Never overwritten by a later pass. */
  completedAt: string | null;
  /** When the sandbox went away. Independent of `completedAt`. */
  endedAt: string | null;
  checkCount: number;
  resetCount: number;
  updatedAt: string;
}

/** A student's standing on one lab, independent of any sandbox. */
export interface LabProgress {
  studentId: string;
  labId: string;
  track: string;
  status: ProgressStatus;
  /** How many attempts this student has started at this lab. */
  attemptCount: number;
  /** How many of those attempts reached PASS. */
  completionCount: number;
  firstCompletedAt: string | null;
  lastCompletedAt: string | null;
  lastAttemptId: string | null;
  firstAttemptAt: string;
  updatedAt: string;
}

/** One hint reveal, recorded once. */
export interface HintUsage {
  hintUsageId: string;
  studentId: string;
  attemptId: string;
  labId: string;
  /** The hint's own level as authored in lab.yaml (1-based). */
  hintIndex: number;
  revealedAt: string;
}

// --- repository inputs / outputs --------------------------------------------

export interface NewAttempt {
  attemptId: string;
  studentId: string;
  labId: string;
  track: string;
  startedAt: string;
}

/**
 * The outcome of recording one Check Solution.
 *
 * `newlyCompleted` is the flag that makes repeated PASS safe: it is true for
 * the check that first completed this attempt and false for every later one, so
 * a caller can never double-count a completion by pressing the button twice.
 */
export interface CheckOutcome {
  attempt: LabAttempt;
  passed: boolean;
  newlyCompleted: boolean;
  progress: LabProgress;
}

/** The outcome of recording one hint reveal. */
export interface HintOutcome {
  usage: HintUsage;
  /** False when this exact hint was already recorded for this attempt. */
  recorded: boolean;
  /** How many distinct hints this attempt has revealed. */
  revealedCount: number;
}

export interface ProgressStoreHealth {
  ok: boolean;
  /** `postgres` or `memory`. Reported on /health so the truth is visible. */
  store: string;
  detail?: string;
}

export class ProgressError extends Error {
  constructor(
    readonly code:
      | 'INVALID_STUDENT_ID'
      | 'INVALID_HINT_INDEX'
      | 'ATTEMPT_NOT_FOUND'
      | 'STORE_UNAVAILABLE',
    message: string,
    readonly remediation?: string,
  ) {
    super(message);
    this.name = 'ProgressError';
  }
}
