/**
 * Terminal session tokens.
 *
 * The browser cannot open a terminal on its own. `POST /api/labs/:id/start`
 * mints a short-lived HMAC-signed token bound to a lab + session id, and the
 * terminal service verifies it before spawning any PTY. This keeps the shell
 * boundary separate from the REST API: no HTTP route executes commands, and a
 * WebSocket without a valid token gets nothing.
 *
 * Intentionally dependency-free (node:crypto only) so the terminal service can
 * import it without pulling in the Kubernetes client.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface TerminalSessionClaims {
  /** Session identifier, unique per Start Lab click. */
  sid: string;
  /** Lab this session may operate on. */
  labId: string;
  /** Namespace the terminal starts in. */
  namespace: string;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
}

export class InvalidSessionTokenError extends Error {
  readonly code = 'INVALID_SESSION_TOKEN';
  constructor(reason: string) {
    super(`Invalid terminal session token: ${reason}`);
    this.name = 'InvalidSessionTokenError';
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function newSessionId(): string {
  return randomUUID();
}

export interface IssueOptions {
  labId: string;
  namespace: string;
  secret: string;
  ttlSeconds: number;
  sessionId?: string;
  now?: () => number;
}

export function issueSessionToken(options: IssueOptions): {
  token: string;
  claims: TerminalSessionClaims;
} {
  if (!options.secret || options.secret.length < 8) {
    throw new Error('TERMINAL_SESSION_SECRET must be set and at least 8 characters long');
  }
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const claims: TerminalSessionClaims = {
    sid: options.sessionId ?? newSessionId(),
    labId: options.labId,
    namespace: options.namespace,
    iat: nowSeconds,
    exp: nowSeconds + options.ttlSeconds,
  };
  const payload = base64url(JSON.stringify(claims));
  return { token: `${payload}.${sign(payload, options.secret)}`, claims };
}

export function verifySessionToken(
  token: unknown,
  secret: string,
  now: () => number = Date.now,
): TerminalSessionClaims {
  if (typeof token !== 'string' || token.length === 0) {
    throw new InvalidSessionTokenError('missing token');
  }
  // Guard against absurd inputs before doing any crypto work.
  if (token.length > 4096) throw new InvalidSessionTokenError('token too long');

  const parts = token.split('.');
  if (parts.length !== 2) throw new InvalidSessionTokenError('malformed token');
  const [payload, signature] = parts as [string, string];

  const expected = sign(payload, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new InvalidSessionTokenError('signature mismatch');
  }

  let claims: TerminalSessionClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TerminalSessionClaims;
  } catch {
    throw new InvalidSessionTokenError('unreadable payload');
  }

  if (
    typeof claims?.sid !== 'string' ||
    typeof claims?.labId !== 'string' ||
    typeof claims?.namespace !== 'string' ||
    typeof claims?.exp !== 'number'
  ) {
    throw new InvalidSessionTokenError('incomplete claims');
  }

  if (Math.floor(now() / 1000) >= claims.exp) {
    throw new InvalidSessionTokenError('token expired');
  }

  return claims;
}
