/**
 * Structured JSON envelope shared by every route.
 *
 * Success: { "ok": true,  "data": … }
 * Failure: { "ok": false, "error": { "code", "message", "remediation"?, "details"? } }
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface ApiErrorBody {
  code: string;
  message: string;
  remediation?: string;
  details?: unknown;
}

export function sendOk<T>(res: Response, data: T, statusCode = 200): void {
  res.status(statusCode).json({ ok: true, data });
}

export function sendError(res: Response, statusCode: number, error: ApiErrorBody): void {
  res.status(statusCode).json({ ok: false, error });
}

/**
 * Wrap an async route so a rejected promise reaches the error handler.
 *
 * Express 4 does not await route handlers, so an unexpected throw inside one
 * leaves the request hanging forever rather than failing: the student's browser
 * sits on a spinner, and the only evidence is an unhandled rejection in the
 * log. That is the wrong failure mode for a platform whose whole job is to tell
 * you honestly what went wrong, so every async handler goes through this.
 *
 * It is a backstop, not a licence: routes still translate the errors they
 * *expect* into precise codes. This is only for the ones nobody predicted.
 */
export function asyncRoute(
  handler: (req: Request, res: Response) => Promise<unknown>,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void Promise.resolve(handler(req, res)).catch(next);
  };
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = 'HttpError';
  }
}
