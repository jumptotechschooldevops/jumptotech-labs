/**
 * Who a piece of learning history belongs to.
 *
 * PLATFORM-005 persisted history and needed an owner before there was a login,
 * so it introduced a *development identity*: a fixed student id configured
 * server-side, optionally overridable by a request header for local
 * multi-student testing.
 *
 * **PLATFORM-010 replaced that as the primary path.** History now follows the
 * authenticated user: `apps/api/src/identity.ts` derives the student id from
 * `req.user` through `studentIdForUser` below, and the development resolver is
 * consulted only when there is no authenticated caller at all. In particular
 * the `x-dev-student-id` header can no longer select an authenticated student's
 * history — a browser-supplied identifier chooses nobody.
 *
 * ⚠️  `DevStudentIdentity` is still NOT authentication. ⚠️
 *
 * Where it is reached — a deployment running with no identity provider — it
 * accepts whoever the caller says they are, so:
 *
 *   - it must not be enabled on any deployment holding real learner data;
 *   - `allowHeaderOverride` defaults to false, and the composition root only
 *     turns it on outside production (see `apps/api/src/config.ts`);
 *   - the API refuses to start with `AUTH_MODE=development` when
 *     `NODE_ENV=production`.
 *
 * What was true before and remains true: every persistence call takes a
 * `studentId` produced *here*, by a resolver, from a validated source — never a
 * raw string lifted out of a query parameter or a JSON body inside a route
 * handler. That is what made the PLATFORM-010 migration a one-file change, with
 * no repository, service, or route signature altered.
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

/**
 * How a request's student identity was established.
 *
 * `authenticated` arrived with PLATFORM-010: the student is the user the API
 * verified, so learning history finally has a real owner. The two
 * `development-*` values remain for deployments running without an identity
 * provider, and are the only ones for which `authenticated` is false.
 */
export type IdentitySource = 'development-default' | 'development-header' | 'authenticated';

export interface StudentIdentity {
  studentId: string;
  /**
   * Whether anybody proved this identity.
   *
   * Served to the client on purpose. Before PLATFORM-010 it was always false
   * and the UI said "development identity" rather than implying a signed-in
   * user; it is now true whenever the request carried a verified credential,
   * and the UI can stop hedging.
   */
  authenticated: boolean;
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

/**
 * A student id derived from an authenticated user — PLATFORM-010.
 *
 * The seam this file's header always described:
 *
 * > *"Replacing this class with one that reads a verified session cookie or a
 * > JWT subject is the whole migration; no repository, service, or route
 * > signature changes."*
 *
 * That is what this is, and the promise held: no repository, service or route
 * signature changed.
 *
 * ## Why the internal `userId`, and not the OIDC subject
 *
 * A subject is only unique *within an issuer*, so two providers could collide;
 * subjects are also frequently email-shaped, which would put a personal
 * identifier in every history row and every log line. `userId` is the platform's
 * own surrogate key, already stable across email and display-name changes, and
 * already the thing session ownership is expressed in — so history and
 * ownership now agree on who a person is.
 */
export function studentIdForUser(userId: string): string {
  const normalised = userId.trim().toLowerCase();
  // `usr-00000001` already matches STUDENT_ID_PATTERN. A provider-shaped id
  // with characters the pattern excludes is folded rather than rejected: the
  // caller is authenticated, so refusing them their own history would be a bug,
  // not a defence.
  const safe = normalised.replace(/[^a-z0-9._-]/g, '-');
  const padded = safe.length >= 3 ? safe : `usr-${safe}`;
  return assertValidStudentId(padded.slice(0, 64));
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
