/**
 * The learning-history use cases.
 *
 * Sits between the HTTP layer and the persistence port and owns the three
 * things a route should never own: identifier generation, the clock, and the
 * translation from "a sandbox session did something" into "a student's attempt
 * changed". Routes stay thin, and every write is addressed by a session id the
 * caller already possessed rather than by an attempt id or a student id it
 * could have made up.
 *
 * Note what is *not* here: nothing about namespaces, containers, providers, or
 * cleanup. A session id is an opaque string to this service. That is what lets
 * the whole sandbox layer be deleted, restarted, or re-implemented without
 * touching a row of learning history.
 */
import { randomUUID } from 'node:crypto';
import type { ProgressRepository } from './repository.js';
import type { StudentIdentity } from './identity.js';
import { assertValidStudentId } from './identity.js';
import {
  ProgressError,
  type AttemptOutcome,
  type CheckOutcome,
  type HintOutcome,
  type HintUsage,
  type LabAttempt,
  type LabProgress,
  type ProgressStoreHealth,
  type Student,
} from './types.js';

/** Hint levels are small positive integers; anything else is a client bug. */
const MAX_HINT_INDEX = 50;

/** Bound on `GET /api/me/attempts?limit=` so one request cannot read the table. */
export const MAX_ATTEMPT_PAGE = 100;
export const DEFAULT_ATTEMPT_PAGE = 20;

export interface ProgressServiceOptions {
  repository: ProgressRepository;
  now?: () => number;
  logger?: (message: string) => void;
}

export interface StartAttemptInput {
  studentId: string;
  labId: string;
  track: string;
  /** Recorded on the student row the first time we see this identity. */
  identitySource: string;
}

export interface AttemptDetail {
  attempt: LabAttempt;
  hints: HintUsage[];
}

export class ProgressService {
  readonly #repository: ProgressRepository;
  readonly #now: () => number;
  readonly #log: (message: string) => void;

  constructor(options: ProgressServiceOptions) {
    this.#repository = options.repository;
    this.#now = options.now ?? (() => Date.now());
    this.#log = options.logger ?? (() => undefined);
  }

  #timestamp(): string {
    return new Date(this.#now()).toISOString();
  }

  // --- identity -------------------------------------------------------------

  /**
   * Make sure the student row exists.
   *
   * Called on the read paths too, so a brand-new development identity can open
   * the dashboard and see an honest empty state rather than a 404.
   */
  async ensureStudent(identity: StudentIdentity): Promise<Student> {
    return this.#repository.ensureStudent({
      studentId: assertValidStudentId(identity.studentId),
      identitySource: identity.source,
      at: this.#timestamp(),
    });
  }

  // --- attempt lifecycle ----------------------------------------------------

  /**
   * Open an attempt, before any sandbox exists.
   *
   * The order matters and is the architecture rule made executable: the attempt
   * is the parent of the session. A start that never gets a sandbox still
   * leaves an honest record (`FAILED`), and a sandbox that is later destroyed
   * cannot take the attempt with it.
   */
  async startAttempt(input: StartAttemptInput): Promise<LabAttempt> {
    const studentId = assertValidStudentId(input.studentId);
    const at = this.#timestamp();
    await this.#repository.ensureStudent({
      studentId,
      identitySource: input.identitySource,
      at,
    });
    const attempt = await this.#repository.createAttempt({
      attemptId: randomUUID(),
      studentId,
      labId: input.labId,
      track: input.track,
      startedAt: at,
    });
    this.#log(`attempt ${attempt.attemptId} started (student=${studentId} lab=${input.labId})`);
    return attempt;
  }

  /** Record which sandbox session ended up hosting an attempt. */
  async bindSession(attemptId: string, sessionId: string): Promise<LabAttempt | null> {
    return this.#repository.bindSession(attemptId, sessionId, this.#timestamp());
  }

  /** The sandbox could not be created; the attempt is over before it began. */
  async failAttempt(attemptId: string, reason: string): Promise<LabAttempt | null> {
    return this.#repository.finishAttempt({
      attemptId,
      outcome: 'FAILED',
      reason,
      at: this.#timestamp(),
    });
  }

  async attemptForSession(sessionId: string): Promise<LabAttempt | null> {
    return this.#repository.findAttemptBySession(sessionId);
  }

  /**
   * Record a Check Solution against whatever attempt owns this session.
   *
   * Returns null when the session has no attempt — which happens for a session
   * started before this feature existed, or when attempt creation failed and
   * the lab was allowed to run anyway. A missing record must never stop a
   * student from checking their work.
   */
  async recordCheck(sessionId: string, passed: boolean): Promise<CheckOutcome | null> {
    const attempt = await this.#repository.findAttemptBySession(sessionId);
    if (!attempt) return null;
    const outcome = await this.#repository.recordCheck({
      attemptId: attempt.attemptId,
      passed,
      at: this.#timestamp(),
    });
    if (outcome.newlyCompleted) {
      this.#log(
        `attempt ${outcome.attempt.attemptId} PASSED (student=${outcome.attempt.studentId} lab=${outcome.attempt.labId})`,
      );
    }
    return outcome;
  }

  /** Reset the sandbox; keep the history. */
  async recordReset(sessionId: string): Promise<LabAttempt | null> {
    const attempt = await this.#repository.findAttemptBySession(sessionId);
    if (!attempt) return null;
    return this.#repository.recordReset(attempt.attemptId, this.#timestamp());
  }

  /**
   * The sandbox for this session went away.
   *
   * Called for End Lab and for expiry alike — the two differ only in the
   * outcome recorded. Never deletes anything.
   */
  async closeSession(input: {
    sessionId: string;
    outcome: AttemptOutcome;
    reason?: string | undefined;
  }): Promise<LabAttempt | null> {
    const attempt = await this.#repository.findAttemptBySession(input.sessionId);
    if (!attempt) return null;
    return this.#repository.finishAttempt({
      attemptId: attempt.attemptId,
      outcome: input.outcome,
      reason: input.reason,
      at: this.#timestamp(),
    });
  }

  /**
   * Close attempts whose sandbox cannot possibly exist any more.
   *
   * The sandbox layer keeps its sessions in memory, so restarting the API
   * forgets them — and with them, the event that would have closed the attempts
   * they hosted. This sweep is the backstop: past the absolute session lifetime
   * no sandbox can still be alive, so anything still IN_PROGRESS by then was
   * abandoned rather than being worked on.
   *
   * `maxSessionSeconds` must be the platform's absolute deadline; the grace
   * period on top of it is what keeps this from racing a teardown in flight.
   */
  async expireAbandonedAttempts(input: {
    maxSessionSeconds: number;
    graceSeconds?: number;
    reason?: string;
  }): Promise<number> {
    const graceSeconds = input.graceSeconds ?? 300;
    const now = this.#now();
    const closed = await this.#repository.expireStaleAttempts({
      startedBefore: new Date(now - (input.maxSessionSeconds + graceSeconds) * 1000).toISOString(),
      reason: input.reason ?? 'the lab environment is no longer running',
      at: new Date(now).toISOString(),
    });
    if (closed > 0) this.#log(`closed ${closed} abandoned attempt(s)`);
    return closed;
  }

  // --- hints ----------------------------------------------------------------

  /**
   * Record that a hint was revealed.
   *
   * Idempotent per (attempt, hint): a replayed request returns the original
   * record with `recorded: false` rather than a second row.
   */
  async recordHint(sessionId: string, hintIndex: number): Promise<HintOutcome | null> {
    const index = assertValidHintIndex(hintIndex);
    const attempt = await this.#repository.findAttemptBySession(sessionId);
    if (!attempt) return null;
    return this.#repository.recordHint({
      hintUsageId: randomUUID(),
      attemptId: attempt.attemptId,
      hintIndex: index,
      at: this.#timestamp(),
    });
  }

  // --- reads ----------------------------------------------------------------

  async progressFor(studentId: string): Promise<LabProgress[]> {
    return this.#repository.listProgress(assertValidStudentId(studentId));
  }

  async listAttempts(studentId: string, limit = DEFAULT_ATTEMPT_PAGE): Promise<LabAttempt[]> {
    const bounded = Math.min(MAX_ATTEMPT_PAGE, Math.max(1, Math.floor(limit)));
    return this.#repository.listAttempts(assertValidStudentId(studentId), bounded);
  }

  /** One attempt and its hints — only if this student owns it. */
  async attemptDetail(studentId: string, attemptId: string): Promise<AttemptDetail | null> {
    const attempt = await this.#repository.getAttempt(assertValidStudentId(studentId), attemptId);
    if (!attempt) return null;
    return { attempt, hints: await this.#repository.listHintUsage(attempt.attemptId) };
  }

  async health(): Promise<ProgressStoreHealth> {
    return this.#repository.health();
  }

  async close(): Promise<void> {
    await this.#repository.close();
  }
}

export function assertValidHintIndex(value: unknown): number {
  const index = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(index) || index < 1 || index > MAX_HINT_INDEX) {
    throw new ProgressError(
      'INVALID_HINT_INDEX',
      `Hint index must be an integer between 1 and ${MAX_HINT_INDEX}.`,
    );
  }
  return index;
}
