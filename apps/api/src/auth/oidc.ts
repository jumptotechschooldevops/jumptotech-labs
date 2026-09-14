/**
 * OIDC token verification — PLATFORM-009, hardened by BETA-P0-014.
 *
 * Standards-based and vendor-neutral: everything below is issuer, audience and
 * JWKS, so any compliant provider is configuration rather than code. Nothing in
 * the session layer knows a provider exists.
 *
 * **This verifies; it does not decode.** A decoded JWT is an unauthenticated
 * claim — anyone can mint one that *parses*. The signature is checked against
 * the issuer's published keys, and the issuer, audience and time window are
 * checked too, because a valid signature from the wrong issuer or for a
 * different audience is still somebody else's token.
 *
 * BETA-P0-014 closed four gaps:
 *
 *   · **`exp` is required.** `jwtVerify` checks `exp` only when a token carries
 *     one, so a correctly signed token with no expiry was valid forever.
 *   · **Asymmetric algorithms only.** The accepted `alg` values are pinned
 *     rather than inferred from whatever key a JWKS happens to contain.
 *   · **Keys come from discovery.** The JWKS location is the issuer's published
 *     `jwks_uri`, not one provider's path convention; `OIDC_JWKS_URI` still
 *     overrides it for an issuer that publishes no discovery document.
 *   · **`azp` is enforced for ID tokens** (OIDC Core §3.1.3.7): a token issued to
 *     several audiences must name this client as the authorized party.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { AuthError, type VerifiedClaims } from './identity.js';
import { assertProviderEndpoint, fetchDiscoveryDocument } from './discovery.js';

/**
 * Signature algorithms a token may use.
 *
 * Asymmetric only. An `HS*` token is signed with a shared secret, and the only
 * secret an OIDC client shares with its provider is the client secret — which
 * is not a key this API should accept identity assertions under.
 */
export const ACCEPTED_SIGNING_ALGORITHMS = [
  'RS256', 'RS384', 'RS512',
  'PS256', 'PS384', 'PS512',
  'ES256', 'ES384', 'ES512',
  'EdDSA', 'Ed25519',
] as const;

export interface OidcConfig {
  /** Exactly as the provider states it, e.g. `https://login.example.com/`. */
  issuer: string;
  /** The API's own audience. A token minted for another API is not ours. */
  audience: string;
  /**
   * Where the signing keys live. Unset means the issuer's discovery document
   * is asked for its `jwks_uri`, which is the standard.
   */
  jwksUri?: string;
  /** Tolerance for clock skew between the provider and this host. */
  clockToleranceSeconds?: number;
  /** Claims that must be present in addition to `exp`, e.g. `iat` for an ID token. */
  requiredClaims?: string[];
  /**
   * The client id an ID token must have been issued to. When set, a token with
   * several audiences must carry `azp`, and any `azp` present must equal this.
   */
  authorizedParty?: string;
  /** Injected in tests; discovery only. */
  fetchImpl?: typeof fetch;
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

type KeySet = ReturnType<typeof createRemoteJWKSet>;

export class OidcTokenVerifier implements TokenVerifier {
  readonly #config: OidcConfig;
  #keys: Promise<KeySet> | undefined;

  constructor(config: OidcConfig) {
    if (!config.issuer || !config.audience) {
      throw new AuthError(
        'AUTH_MISCONFIGURED',
        'OIDC requires both an issuer and an audience.',
      );
    }
    this.#config = config;
    if (config.jwksUri) {
      // Configured explicitly: parse now, so a typo fails at startup.
      this.#keys = Promise.resolve(createRemoteJWKSet(new URL(config.jwksUri)));
    }
  }

  /**
   * The issuer's key set, resolved through discovery on first use.
   *
   * Lazy so an API can start while its provider is briefly unreachable, and
   * reset on failure so the next request tries again rather than caching the
   * outage for the life of the process.
   */
  #keySet(): Promise<KeySet> {
    if (!this.#keys) {
      const pending = fetchDiscoveryDocument(this.#config.issuer, {
        ...(this.#config.fetchImpl ? { fetchImpl: this.#config.fetchImpl } : {}),
      }).then((document) =>
        createRemoteJWKSet(new URL(assertProviderEndpoint(document.jwks_uri, 'JWKS URI', this.#config.issuer))),
      );
      this.#keys = pending;
      pending.catch(() => {
        if (this.#keys === pending) this.#keys = undefined;
      });
    }
    return this.#keys;
  }

  async verify(token: string): Promise<VerifiedClaims> {
    const keys = await this.#keySet();

    let payload: JWTPayload;
    try {
      // `jwtVerify` checks the signature against the issuer's published keys
      // and enforces issuer, audience, `exp` and `nbf` in one step. Each of
      // those is a separate way a token can be somebody else's.
      ({ payload } = await jwtVerify(token, keys, {
        issuer: this.#config.issuer,
        audience: this.#config.audience,
        algorithms: [...ACCEPTED_SIGNING_ALGORITHMS],
        requiredClaims: ['exp', ...(this.#config.requiredClaims ?? [])],
        clockTolerance: this.#config.clockToleranceSeconds ?? 5,
      }));
    } catch (error) {
      throw asAuthError(error);
    }

    if (this.#config.authorizedParty !== undefined) {
      const multipleAudiences = Array.isArray(payload.aud) && payload.aud.length > 1;
      const azp = payload.azp;
      if ((multipleAudiences && azp === undefined) || (azp !== undefined && azp !== this.#config.authorizedParty)) {
        throw new AuthError('AUTH_INVALID_TOKEN', 'The credentials supplied are not valid.');
      }
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
