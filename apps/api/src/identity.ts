/**
 * Reading the current student from a request.
 *
 * One function, one place. Routes never touch `req.query.studentId` or a body
 * field — and since PLATFORM-010 they never reach the development header either
 * when somebody is actually signed in.
 *
 * ```text
 *   req.user present (cookie or bearer, both server-verified)
 *        └─► studentIdForUser(user.userId)      authenticated: true
 *
 *   req.user absent (a deployment running without an identity provider)
 *        └─► StudentIdentityResolver             authenticated: false
 * ```
 *
 * The order is the whole point. Before this, learning history was attributed
 * through `DevStudentIdentity` regardless of who had authenticated, so every
 * student's attempts landed on one shared `dev-student-001` — and where
 * `DEV_STUDENT_HEADER_ENABLED=true`, a **browser-supplied header** selected
 * whose progress was read and written. Both are gone: an authenticated request
 * is attributed to the user the server verified, and the header is only
 * consulted when there is no authenticated user at all.
 *
 * Concentrating it here is what made that a one-file change, exactly as
 * `services/progress/src/identity.ts` predicted it would be.
 */
import type { Request, Response } from 'express';
import {
  ProgressError,
  studentIdForUser,
  type StudentIdentity,
  type StudentIdentityResolver,
} from '@jumptotech/progress';
import { sendError } from './http.js';

export function resolveStudent(
  resolver: StudentIdentityResolver,
  req: Request,
): StudentIdentity {
  /*
   * An authenticated caller is the student. Full stop.
   *
   * `req.user` was established by `authenticate()` from a session cookie or a
   * signed token — never from anything the client named — so this is the same
   * identity `authorize()` makes ownership decisions with. History and
   * ownership now agree on who a person is, which they did not before.
   */
  const user = req.user;
  if (user) {
    return {
      studentId: studentIdForUser(user.userId),
      authenticated: true,
      source: 'authenticated',
    };
  }

  const headerName = resolver.headerName;
  // When the override is disabled the header is not even read, so a client
  // cannot tell the difference between "ignored" and "not supported".
  return resolver.resolve(headerName ? { header: req.get(headerName) } : {});
}

/** Translate a rejected identity or progress input into an HTTP response. */
export function progressErrorResponse(res: Response, error: unknown): boolean {
  if (!(error instanceof ProgressError)) return false;
  const status = error.code === 'ATTEMPT_NOT_FOUND' ? 404 : 400;
  sendError(res, status, {
    code: error.code,
    message: error.message,
    ...(error.remediation ? { remediation: error.remediation } : {}),
  });
  return true;
}
