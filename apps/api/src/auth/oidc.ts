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
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose';
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
  /**
   * Told once per real JWKS retrieval — never on a cached key lookup — and once
   * per failed attempt to discover `jwks_uri`. Wired to
   * `jtt_oidc_jwks_fetch_total`, which RB-14 and `JwksFetchFailing` read.
   */
  onJwksFetch?: (outcome: JwksFetchOutcome) => void;
}

/**
 * Why a key retrieval ended the way it did. A closed set, so it is safe as a
 * metric label: no URL, issuer, `kid` or provider text ever reaches it.
 */
export type JwksFetchOutcome =
  | 'success'
  /** The JWKS endpoint answered, but not `200` (a redirect included: jose refuses to follow one). */
  | 'http_error'
  /** No answer: DNS, connection, TLS or the timeout. */
  | 'network_error'
  /** `200`, but not a JSON JWK Set. */
  | 'invalid_response'
  /** `jwks_uri` could not be learned from discovery, so no keys were fetched at all. */
  | 'discovery_failed';

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
      this.#keys = Promise.resolve(this.#remoteKeySet(config.jwksUri));
    }
  }

  /**
   * A remote key set whose every retrieval is reported.
   *
   * `jose` caches keys and refetches only when they go stale or an unknown
   * `kid` arrives, so counting here — at the fetch, not at `verify` — is what
   * makes the metric mean "retrievals" rather than "tokens checked". The fetch
   * itself is unchanged: the same global `fetch`, request and redirect policy
   * `jose` would use, with TLS verification left at Node's default.
   */
  #remoteKeySet(jwksUri: string): KeySet {
    const report = this.#config.onJwksFetch;
    if (!report) return createRemoteJWKSet(new URL(jwksUri));
    const record = (outcome: JwksFetchOutcome): void => safely(report, outcome);
    return createRemoteJWKSet(new URL(jwksUri), {
      [customFetch]: async (url: string, init: RequestInit) => {
        let response: Response;
        try {
          response = await fetch(url, init);
        } catch (error) {
          record('network_error');
          throw error;
        }
        if (response.status !== 200) {
          record('http_error');
          return response;
        }
        // Read once, judge it, and hand `jose` an identical body to parse.
        let body: string;
        try {
          body = await response.text();
        } catch (error) {
          record('network_error');
          throw error;
        }
        let keys: unknown;
        try {
          keys = (JSON.parse(body) as { keys?: unknown } | null)?.keys;
        } catch {
          keys = undefined;
        }
        record(Array.isArray(keys) ? 'success' : 'invalid_response');
        return new Response(body, { status: response.status, headers: response.headers });
      },
    });
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
        this.#remoteKeySet(assertProviderEndpoint(document.jwks_uri, 'JWKS URI', this.#config.issuer)),
      );
      this.#keys = pending;
      pending.catch(() => {
        if (this.#keys === pending) this.#keys = undefined;
        if (this.#config.onJwksFetch) safely(this.#config.onJwksFetch, 'discovery_failed');
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

function safely(report: (outcome: JwksFetchOutcome) => void, outcome: JwksFetchOutcome): void {
  try {
    report(outcome);
  } catch {
    // Bookkeeping must never decide whether a token verifies.
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
