/**
 * Development student identity.
 *
 * ⚠️  THIS IS NOT AUTHENTICATION. ⚠️
 *
 * PLATFORM-005 persists learning history, and history needs an owner. There is
 * no login yet, so the platform uses a *development identity*: a fixed student
 * id configured server-side (`dev-student-001` by default), optionally
 * overridable by a request header when the deployment explicitly switches that
 * on for local multi-student testing.
 *
 * What this means, stated plainly rather than dressed up:
 *
 *   - Nobody proves who they are. Anyone who can reach the API is the
 *     development student, and — where the override is enabled — anyone can
 *     name any other student and read that student's progress.
 *   - So this must not be enabled on any deployment holding real learner data.
 *     `allowHeaderOverride` defaults to false and the composition root only
 *     turns it on outside production; see `apps/api/src/config.ts`.
 *   - Nothing else in the platform is gated on identity. Sandbox access is
 *     still authorised by possession of the session id exactly as PLATFORM-002
 *     described, and a student id grants no access to anyone's sandbox.
 *
 * What is already true, and stays true when real authentication arrives: every
 * persistence call takes a `studentId` that was produced *here*, by a resolver,
 * from a validated source — never a raw string lifted out of a query parameter
 * or a JSON body inside a route handler. Replacing this class with one that
 * reads a verified session cookie or a JWT subject is the whole migration; no
 * repository, service, or route signature changes.
 */
import { ProgressError } from './types.js';

/**
 * Student ids are conservative slugs.
 *
 * Wide enough for a UUID or an OIDC subject when real identity arrives, narrow
 * enough that an id can never carry a control character into a log line, and
 * validated at the edge rather than trusted — even though every query below is
 * parameterised, an unvalidated identifier is the kind of thing that later
 * grows a string-concatenated query around it.
 */
export const STUDENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export function assertValidStudentId(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!STUDENT_ID_PATTERN.test(raw)) {
    throw new ProgressError(
      'INVALID_STUDENT_ID',
      'Student ids are 3–64 characters of lowercase letters, digits, dot, dash or underscore.',
    );
  }
  return raw;
}

/** How a request's student identity was established. */
export type IdentitySource = 'development-default' | 'development-header';

export interface StudentIdentity {
  studentId: string;
  /**
   * Always false in PLATFORM-005, and served to the client on purpose: the UI
   * says "development identity" rather than implying a signed-in user.
   */
  authenticated: false;
  source: IdentitySource;
}

/** The single request-shaped input this resolver accepts. */
export interface IdentityRequest {
  /** Value of the development student header, if the caller sent one. */
  header?: string | undefined;
}

/**
 * The seam authentication will replace.
 *
 * Routes depend on this interface, never on `DevStudentIdentity` directly.
 */
export interface StudentIdentityResolver {
  resolve(request?: IdentityRequest): StudentIdentity;
  /** The header a development deployment reads, or null when disabled. */
  readonly headerName: string | null;
}

export const DEV_STUDENT_HEADER = 'x-dev-student-id';

export const DEFAULT_DEV_STUDENT_ID = 'dev-student-001';

export interface DevStudentIdentityOptions {
  /** The identity every request gets when no override is supplied. */
  studentId?: string;
  /**
   * Whether `x-dev-student-id` may select a different student.
   *
   * Off unless a deployment opts in. It exists so two browser tabs can act as
   * two students on a laptop, which is the only way to exercise "students have
   * independent progress" before login exists.
   */
  allowHeaderOverride?: boolean;
}

export class DevStudentIdentity implements StudentIdentityResolver {
  readonly #studentId: string;
  readonly #allowHeader: boolean;

  constructor(options: DevStudentIdentityOptions = {}) {
    this.#studentId = assertValidStudentId(options.studentId ?? DEFAULT_DEV_STUDENT_ID);
    this.#allowHeader = options.allowHeaderOverride ?? false;
  }

  get headerName(): string | null {
    return this.#allowHeader ? DEV_STUDENT_HEADER : null;
  }

  /** The identity used when nothing overrides it. */
  get defaultStudentId(): string {
    return this.#studentId;
  }

  resolve(request: IdentityRequest = {}): StudentIdentity {
    if (this.#allowHeader && typeof request.header === 'string' && request.header.trim() !== '') {
      // Validated, never trusted: a malformed override is rejected outright
      // rather than quietly falling back, so a typo in a test harness fails
      // loudly instead of silently writing to the default student's history.
      return {
        studentId: assertValidStudentId(request.header),
        authenticated: false,
        source: 'development-header',
      };
    }
    return { studentId: this.#studentId, authenticated: false, source: 'development-default' };
  }
}
