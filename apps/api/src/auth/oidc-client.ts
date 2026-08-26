/**
 * The API as a confidential OIDC client — PLATFORM-010.
 *
 * `oidc.ts` is the *resource server* half: it verifies a token somebody else
 * obtained. This is the *client* half: it obtains one, on the browser's behalf,
 * so that no OIDC credential ever reaches the page.
 *
 * ```text
 *   /auth/login     → authorizationUrl()   state + nonce + PKCE S256
 *   provider        → user authenticates
 *   /auth/callback  → exchangeCode()       client_secret stays here
 *                   → OidcTokenVerifier    signature, iss, aud, exp
 * ```
 *
 * ## Why PKCE on a confidential client
 *
 * The secret already proves the client, so PKCE is not strictly required. It is
 * used anyway because it binds *this* authorization request to *this* token
 * exchange: an authorization code intercepted in a redirect — a browser
 * history entry, a referrer header, a shared screen — is worthless without the
 * verifier, which never left this process. It costs one hash.
 *
 * ## What is deliberately not requested
 *
 * `offline_access`. Refresh tokens are long-lived credentials that would have
 * to be stored, and storing them is a separate security decision with its own
 * rotation and revocation design. A browser session simply expires and the user
 * signs in again.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthError, type VerifiedClaims } from './identity.js';

/** The endpoints this client needs from an issuer. */
export interface OidcProviderMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri?: string;
  endSessionEndpoint?: string;
}

export interface OidcClientConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  /** Overrides discovery entirely. Used by tests and by non-discoverable IdPs. */
  metadata?: OidcProviderMetadata;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Everything `/auth/login` needs to build a redirect and remember it. */
export interface AuthorizationRequest {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface TokenResponse {
  idToken: string;
  /**
   * Present, and deliberately not returned any further than the callback
   * handler. The browser never sees it and it is never persisted.
   */
  accessToken?: string;
  tokenType?: string;
  expiresIn?: number;
}

function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** RFC 7636 S256: `BASE64URL(SHA256(ASCII(verifier)))`. */
export function codeChallengeFor(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * Compare two opaque strings without leaking their relationship through timing.
 *
 * Used for `state` and `nonce`. Both are server-minted high-entropy values, so
 * the practical risk is low — but a `===` on a security comparison is exactly
 * the line that gets copied somewhere it matters.
 */
export function safeEquals(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

/**
 * An endpoint URL the provider handed us still has to be checked.
 *
 * Discovery output is data from the network. Accepting an arbitrary scheme here
 * would let a hostile or misconfigured discovery document turn a redirect into
 * something else entirely.
 */
function assertHttpUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AuthError('AUTH_MISCONFIGURED', `The identity provider published no ${field}.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthError('AUTH_MISCONFIGURED', `The identity provider published an unusable ${field}.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AuthError('AUTH_MISCONFIGURED', `The identity provider's ${field} is not an HTTP URL.`);
  }
  return url.href;
}

export class OidcBrowserClient {
  readonly #config: OidcClientConfig;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  #metadata: OidcProviderMetadata | undefined;

  constructor(config: OidcClientConfig) {
    if (!config.issuer || !config.clientId || !config.clientSecret) {
      throw new AuthError(
        'AUTH_MISCONFIGURED',
        'The browser sign-in flow needs OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET.',
        'Set them in the API environment. OIDC_CLIENT_SECRET must never be given to the frontend.',
      );
    }
    if (!config.redirectUri) {
      throw new AuthError(
        'AUTH_MISCONFIGURED',
        'The browser sign-in flow needs a redirect URI.',
        'Set PUBLIC_ORIGIN or OIDC_REDIRECT_URI.',
      );
    }
    this.#config = config;
    this.#fetch = config.fetchImpl ?? fetch;
    this.#timeoutMs = config.timeoutMs ?? 10_000;
    this.#metadata = config.metadata;
  }

  get clientId(): string {
    return this.#config.clientId;
  }

  get redirectUri(): string {
    return this.#config.redirectUri;
  }

  /**
   * Resolve and cache the issuer's endpoints.
   *
   * Cached for the process lifetime: these change about as often as the issuer
   * itself, and re-fetching per sign-in would put the provider's availability
   * on the critical path of every login.
   */
  async metadata(): Promise<OidcProviderMetadata> {
    if (this.#metadata) return this.#metadata;

    const url = new URL('.well-known/openid-configuration', ensureTrailingSlash(this.#config.issuer)).href;
    const document = await this.#json(url, { method: 'GET' }, 'discover the identity provider');

    const resolved: OidcProviderMetadata = {
      issuer: typeof document.issuer === 'string' ? document.issuer : this.#config.issuer,
      authorizationEndpoint: assertHttpUrl(document.authorization_endpoint, 'authorization endpoint'),
      tokenEndpoint: assertHttpUrl(document.token_endpoint, 'token endpoint'),
      ...(typeof document.jwks_uri === 'string'
        ? { jwksUri: assertHttpUrl(document.jwks_uri, 'JWKS URI') }
        : {}),
      ...(typeof document.end_session_endpoint === 'string'
        ? { endSessionEndpoint: assertHttpUrl(document.end_session_endpoint, 'end session endpoint') }
        : {}),
    };
    this.#metadata = resolved;
    return resolved;
  }

  /** Build the provider redirect, and the secrets that must be remembered with it. */
  async authorizationRequest(): Promise<AuthorizationRequest> {
    const metadata = await this.metadata();
    const state = randomUrlSafe();
    const nonce = randomUrlSafe();
    const codeVerifier = randomUrlSafe(48);

    const url = new URL(metadata.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.#config.clientId);
    url.searchParams.set('redirect_uri', this.#config.redirectUri);
    url.searchParams.set('scope', this.#config.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', codeChallengeFor(codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');

    return { url: url.href, state, nonce, codeVerifier };
  }

  /**
   * Exchange an authorization code for tokens.
   *
   * The client secret goes in the POST body over TLS to the token endpoint and
   * nowhere else. It is never in a URL — a URL ends up in access logs, proxy
   * logs and browser history — and never in a response this API produces.
   */
  async exchangeCode(code: string, codeVerifier: string): Promise<TokenResponse> {
    const metadata = await this.metadata();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.#config.redirectUri,
      client_id: this.#config.clientId,
      client_secret: this.#config.clientSecret,
      code_verifier: codeVerifier,
    });

    const payload = await this.#json(
      metadata.tokenEndpoint,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
      },
      'exchange the authorization code',
    );

    const idToken = payload.id_token;
    if (typeof idToken !== 'string' || idToken.length === 0) {
      throw new AuthError(
        'AUTH_INVALID_TOKEN',
        'The identity provider returned no ID token.',
        'Check that the OIDC client is configured for the `openid` scope.',
      );
    }

    return {
      idToken,
      ...(typeof payload.access_token === 'string' ? { accessToken: payload.access_token } : {}),
      ...(typeof payload.token_type === 'string' ? { tokenType: payload.token_type } : {}),
      ...(typeof payload.expires_in === 'number' ? { expiresIn: payload.expires_in } : {}),
    };
  }

  /** The provider's single-logout URL, when it publishes one. */
  async endSessionUrl(postLogoutRedirectUri?: string): Promise<string | null> {
    const metadata = await this.metadata();
    if (!metadata.endSessionEndpoint) return null;
    const url = new URL(metadata.endSessionEndpoint);
    url.searchParams.set('client_id', this.#config.clientId);
    if (postLogoutRedirectUri) {
      url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
    }
    return url.href;
  }

  async #json(
    url: string,
    init: RequestInit,
    what: string,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, { ...init, signal: controller.signal });
    } catch {
      // The provider's error text may echo request parameters, so it is never
      // included in what the caller sees.
      throw new AuthError('AUTH_MISCONFIGURED', `Could not reach the identity provider to ${what}.`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new AuthError('AUTH_INVALID_TOKEN', `The identity provider refused to ${what}.`);
    }

    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      throw new AuthError('AUTH_MISCONFIGURED', `The identity provider's response to ${what} was not JSON.`);
    }
  }
}

/**
 * Check the `nonce` in verified ID token claims against the one we sent.
 *
 * Separate from `OidcTokenVerifier` on purpose: the verifier is shared with the
 * bearer-token path, which has no nonce because there was no authorization
 * request. This is the browser flow's own replay defence.
 */
export function assertNonceMatches(claimNonce: unknown, expected: string): void {
  if (!safeEquals(claimNonce, expected)) {
    throw new AuthError(
      'AUTH_INVALID_TOKEN',
      'The credentials supplied are not valid.',
      'Start sign-in again.',
    );
  }
}

/** Claims plus the raw nonce, so the callback can check replay in one place. */
export interface VerifiedIdToken extends VerifiedClaims {
  nonce?: string | undefined;
}
