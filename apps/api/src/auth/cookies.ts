/**
 * Cookie reading and writing — PLATFORM-010.
 *
 * Hand-rolled rather than a dependency, for one reason: everything this needs
 * is a header parse and a header build, and the security properties are in the
 * *attributes*, which a helper library would let a caller forget. Here they are
 * not optional — `serializeCookie` always writes `HttpOnly` and `SameSite`, and
 * `Secure` is a decision made once in configuration rather than per call site.
 *
 * Two things are deliberately absent:
 *
 *   - **No signed-cookie scheme for the session cookie.** The value is already
 *     256 bits of randomness indexing a server-side record; a signature would
 *     add a second secret to manage and prove nothing the lookup does not.
 *   - **No `Domain` by default.** A host-only cookie is not sent to sibling
 *     hosts, which is what you want unless a deployment genuinely spans
 *     subdomains — and then it is an explicit setting.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CookieAttributes {
  /** Off only for a plain-HTTP localhost deployment. */
  secure: boolean;
  /**
   * `lax` so the provider's cross-site redirect back to `/auth/callback`
   * arrives with the transaction cookie attached. `strict` would drop it and
   * break sign-in; `none` would send it on every cross-site request, which is
   * exactly what SameSite exists to prevent.
   */
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  domain?: string | undefined;
  maxAgeSeconds?: number | undefined;
  httpOnly?: boolean;
}

/**
 * Cookie names and values may not carry control characters or separators.
 *
 * Checked rather than escaped: a value that needs escaping is a bug in the
 * caller, and silently mangling it would hide that.
 */
const COOKIE_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
const COOKIE_VALUE_PATTERN = /^[A-Za-z0-9!#$%&'()*+\-./:<=>?@[\]^_`{|}~]*$/;

export class CookieError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CookieError';
  }
}

export function serializeCookie(
  name: string,
  value: string,
  attributes: CookieAttributes,
): string {
  if (!COOKIE_NAME_PATTERN.test(name)) {
    throw new CookieError(`'${name}' is not a valid cookie name`);
  }
  if (!COOKIE_VALUE_PATTERN.test(value)) {
    throw new CookieError('Cookie value contains characters that must not be sent raw');
  }

  const parts = [`${name}=${value}`, `Path=${attributes.path}`];
  if (attributes.domain) parts.push(`Domain=${attributes.domain}`);
  if (attributes.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(attributes.maxAgeSeconds))}`);
    parts.push(
      `Expires=${new Date(Date.now() + Math.max(0, attributes.maxAgeSeconds) * 1000).toUTCString()}`,
    );
  }
  // Not conditional. A cookie this module writes is never readable by script.
  if (attributes.httpOnly !== false) parts.push('HttpOnly');
  if (attributes.secure) parts.push('Secure');
  parts.push(`SameSite=${attributes.sameSite === 'lax' ? 'Lax' : attributes.sameSite === 'strict' ? 'Strict' : 'None'}`);
  return parts.join('; ');
}

/** The header that removes a cookie: empty value, immediate expiry. */
export function clearCookie(name: string, attributes: CookieAttributes): string {
  return serializeCookie(name, '', { ...attributes, maxAgeSeconds: 0 });
}

/**
 * Parse a `Cookie` header into a map.
 *
 * Tolerant of the shapes browsers actually send (extra spaces, `=` inside a
 * value) and hard-capped, so an enormous header cannot become work.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header || header.length > 8192) return out;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (!COOKIE_NAME_PATTERN.test(name)) continue;
    // Last one wins, matching how a server would read a duplicated cookie.
    out[name] = pair.slice(eq + 1).trim();
  }
  return out;
}

/**
 * The short-lived sign-in transaction: state, nonce, PKCE verifier, return path.
 *
 * This one *is* signed, because unlike the session cookie it carries data the
 * server needs back rather than an index into a record it already holds.
 * Keeping it in a cookie rather than in server memory is what lets sign-in
 * survive hitting a different API instance on the callback.
 */
export interface AuthTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Where to send the browser afterwards. Always a same-origin path. */
  returnTo: string;
  /** Epoch seconds. */
  exp: number;
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

export function sealTransaction(transaction: AuthTransaction, secret: string): string {
  const payload = base64url(JSON.stringify(transaction));
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

/**
 * Verify and open a transaction cookie.
 *
 * Returns `null` for every failure mode rather than throwing a distinguishable
 * error: a caller that can tell "bad signature" from "expired" from "malformed"
 * learns something about the secret, and no legitimate client needs to.
 */
export function openTransaction(
  sealed: unknown,
  secret: string,
  now: () => number = Date.now,
): AuthTransaction | null {
  if (typeof sealed !== 'string' || sealed.length === 0 || sealed.length > 4096) return null;
  const parts = sealed.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts as [string, string];

  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let transaction: AuthTransaction;
  try {
    transaction = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AuthTransaction;
  } catch {
    return null;
  }

  if (
    typeof transaction?.state !== 'string' ||
    typeof transaction?.nonce !== 'string' ||
    typeof transaction?.codeVerifier !== 'string' ||
    typeof transaction?.returnTo !== 'string' ||
    typeof transaction?.exp !== 'number'
  ) {
    return null;
  }
  if (Math.floor(now() / 1000) >= transaction.exp) return null;
  return transaction;
}
