/**
 * Reading the current student from a request.
 *
 * One function, one place. Routes never touch `req.query.studentId` or a body
 * field: the identity comes from the resolver, which in PLATFORM-005 is the
 * development identity described in `@jumptotech/progress` — and is not
 * authentication. Concentrating it here is what makes replacing it later a
 * one-file change.
 */
import type { Request, Response } from 'express';
import { ProgressError, type StudentIdentity, type StudentIdentityResolver } from '@jumptotech/progress';
import { sendError } from './http.js';

export function resolveStudent(
  resolver: StudentIdentityResolver,
  req: Request,
): StudentIdentity {
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
