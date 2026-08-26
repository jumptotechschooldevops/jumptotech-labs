/**
 * OIDC token verification — PLATFORM-009.
 *
 * Standards-based and vendor-neutral: everything below is issuer, audience and
 * JWKS, so Auth0, Cognito, Google or any compliant provider is configuration
 * rather than code. Nothing in the session layer knows a provider exists.
 *
 * **This verifies; it does not decode.** A decoded JWT is an unauthenticated
 * claim — anyone can mint one that *parses*. The signature is checked against
 * the issuer's published keys, and the issuer, audience and time window are
 * checked too, because a valid signature from the wrong issuer or for a
 * different audience is still somebody else's token.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { AuthError, type VerifiedClaims } from './identity.js';

export interface OidcConfig {
  /** Exactly as the provider states it, e.g. `https://example.eu.auth0.com/`. */
  issuer: string;
  /** The API's own audience. A token minted for another API is not ours. */
  audience: string;
  /** Where the signing keys live. Defaults to the standard discovery path. */
  jwksUri?: string;
  /** Tolerance for clock skew between the provider and this host. */
  clockToleranceSeconds?: number;
}

/** The verifier, so tests can supply one without a network. */
export interface TokenVerifier {
  verify(token: string): Promise<VerifiedClaims>;
}

/** `Bearer <token>` → the token, or a refusal that says which part was wrong. */
export function bearerToken(header: string | undefined): string {
  if (!header) {
    throw new AuthError('AUTH_REQUIRED', 'This request requires authentication.', 'Sign in and retry.');
  }
  const match = /^Bearer[ ]+(\S+)$/.exec(header.trim());
  if (!match) {
    throw new AuthError('AUTH_INVALID_TOKEN', 'Malformed Authorization header.');
  }
  return match[1]!;
}

function claimString(payload: JWTPayload, name: string): string | undefined {
  const value = payload[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export class OidcTokenVerifier implements TokenVerifier {
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;
  readonly #config: OidcConfig;

  constructor(config: OidcConfig) {
    if (!config.issuer || !config.audience) {
      throw new AuthError(
        'AUTH_MISCONFIGURED',
        'OIDC requires both an issuer and an audience.',
      );
    }
    this.#config = config;
    const uri = config.jwksUri ?? new URL('.well-known/jwks.json', ensureTrailingSlash(config.issuer)).href;
    this.#jwks = createRemoteJWKSet(new URL(uri));
  }

  async verify(token: string): Promise<VerifiedClaims> {
    let payload: JWTPayload;
    try {
      // `jwtVerify` checks the signature against the issuer's published keys
      // and enforces issuer, audience, `exp` and `nbf` in one step. Each of
      // those is a separate way a token can be somebody else's.
      ({ payload } = await jwtVerify(token, this.#jwks, {
        issuer: this.#config.issuer,
        audience: this.#config.audience,
        clockTolerance: this.#config.clockToleranceSeconds ?? 5,
      }));
    } catch (error) {
      throw asAuthError(error);
    }

    const subject = payload.sub;
    if (typeof subject !== 'string' || subject.length === 0) {
      throw new AuthError('AUTH_INVALID_TOKEN', 'Token carries no subject.');
    }
    const issuer = typeof payload.iss === 'string' ? payload.iss : this.#config.issuer;

    return {
      issuer,
      subject,
      ...(claimString(payload, 'email') ? { email: claimString(payload, 'email')! } : {}),
      ...(claimString(payload, 'name') ? { displayName: claimString(payload, 'name')! } : {}),
      // Carried through for the browser flow's replay check. Absent on a bearer
      // access token, which never had an authorization request to bind to.
      ...(claimString(payload, 'nonce') ? { nonce: claimString(payload, 'nonce')! } : {}),
    };
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

/**
 * Translate a verification failure into something safe to return.
 *
 * Deliberately coarse. `jose` distinguishes a bad signature from a wrong
 * issuer from a wrong audience, and telling an unauthenticated caller which one
 * they got wrong is an oracle for guessing. Expiry is the exception: it is not
 * a secret, and a client needs to know to refresh rather than to give up. The
 * precise reason is logged server-side.
 */
function asAuthError(error: unknown): AuthError {
  const code = (error as { code?: unknown })?.code;
  if (code === 'ERR_JWT_EXPIRED') {
    return new AuthError('AUTH_EXPIRED', 'Your session has expired.', 'Sign in again.');
  }
  return new AuthError('AUTH_INVALID_TOKEN', 'The credentials supplied are not valid.');
}
