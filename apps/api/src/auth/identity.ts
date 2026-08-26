/**
 * Who is making this request — PLATFORM-009.
 *
 * One canonical identity, whatever established it. Routes and policy never ask
 * *how* someone authenticated; they ask who the user is and what role they
 * hold, which is what lets the development resolver and the OIDC one be
 * genuinely interchangeable.
 *
 * The permanent identity is `(issuer, subject)`. Not email — people change
 * those, providers recycle them, and treating one as an identifier means a
 * freed address silently inherits someone else's session history. Email and
 * display name are carried because a UI needs them, and are never consulted by
 * an authorization decision.
 */

/** The three roles the platform recognises. */
export const ROLES = ['STUDENT', 'INSTRUCTOR', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** A user as the platform knows them, after the token was verified. */
export interface AuthenticatedUser {
  /** Internal surrogate key. Never leaves the server. */
  userId: string;
  issuer: string;
  subject: string;
  email?: string;
  displayName?: string;
  role: Role;
  /** How the identity was established, for audit lines and the UI. */
  source: 'oidc' | 'development';
}

/** What a verified token asserted, before it is matched to a stored user. */
export interface VerifiedClaims {
  issuer: string;
  subject: string;
  email?: string;
  displayName?: string;
  /**
   * The `nonce` claim, when the token carried one (PLATFORM-010).
   *
   * Only an ID token obtained through the browser authorization-code flow has
   * one, and only that flow reads it — to prove the token answers *this*
   * sign-in rather than a replayed earlier one. It is never consulted by an
   * authorization decision and is not part of anyone's identity.
   */
  nonce?: string;
}

export class AuthError extends Error {
  constructor(
    readonly code:
      | 'AUTH_REQUIRED'
      | 'AUTH_INVALID_TOKEN'
      | 'AUTH_EXPIRED'
      | 'AUTH_MISCONFIGURED',
    message: string,
    readonly remediation?: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Turns a request's credentials into a user, or refuses.
 *
 * Deliberately narrow: it receives the Authorization header value and nothing
 * else. A resolver cannot read a body, a query parameter or a cookie, so no
 * implementation can accidentally let a client name the user it wants to be.
 */
export interface IdentityResolver {
  /** `oidc` in production, `development` only where explicitly configured. */
  readonly mode: 'oidc' | 'development';
  resolve(authorizationHeader: string | undefined): Promise<AuthenticatedUser>;
}
