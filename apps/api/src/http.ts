/**
 * Structured JSON envelope shared by every route.
 *
 * Success: { "ok": true,  "data": … }
 * Failure: { "ok": false, "error": { "code", "message", "remediation"?, "details"? } }
 */
import type { Response } from 'express';

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

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = 'HttpError';
  }
}
