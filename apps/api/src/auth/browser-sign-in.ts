/**
 * The browser sign-in collaborators, built from configuration — BETA-P0-014.
 *
 * One function so the composition root and the test suite construct the client
 * and the ID-token verifier identically. Before this, `index.ts` built them
 * inline and every suite built its own, so a verifier option added in one
 * place (the `iat` requirement, the `azp` check) was proven only in the other.
 */
import type { AuthConfig } from '../config.js';
import { OidcBrowserClient } from './oidc-client.js';
import { OidcTokenVerifier, type JwksFetchOutcome } from './oidc.js';

export interface BrowserSignIn {
  /** Null without `OIDC_CLIENT_SECRET`; `/auth/config` then reports sign-in unavailable. */
  client: OidcBrowserClient | null;
  idTokenVerifier: OidcTokenVerifier | null;
}

export function buildBrowserSignIn(
  auth: AuthConfig,
  options: { fetchImpl?: typeof fetch; onJwksFetch?: (outcome: JwksFetchOutcome) => void } = {},
): BrowserSignIn {
  if (!auth.oidc || !auth.browserFlow) return { client: null, idTokenVerifier: null };

  const fetchImpl = options.fetchImpl ? { fetchImpl: options.fetchImpl } : {};

  return {
    // The secret is read here and never leaves the process except in the
    // token-endpoint POST body.
    client: new OidcBrowserClient({
      issuer: auth.oidc.issuer,
      clientId: auth.oidc.clientId,
      clientSecret: auth.browserFlow.clientSecret,
      redirectUri: auth.browserFlow.redirectUri,
      scopes: auth.browserFlow.scopes,
      ...fetchImpl,
    }),
    /*
     * A second verifier, for the ID token.
     *
     * An ID token's audience is always the *client id*; an API access token's is
     * `OIDC_AUDIENCE`. Verifying one with the other's expectation fails, so the
     * two are separate instances of the same class rather than one loosened to
     * accept both. OIDC Core §3.1.3.7 adds `iat`, and `azp` when a token names
     * several audiences.
     */
    idTokenVerifier: new OidcTokenVerifier({
      issuer: auth.oidc.issuer,
      audience: auth.oidc.clientId,
      ...(auth.oidc.jwksUri ? { jwksUri: auth.oidc.jwksUri } : {}),
      requiredClaims: ['iat'],
      authorizedParty: auth.oidc.clientId,
      ...fetchImpl,
      ...(options.onJwksFetch ? { onJwksFetch: options.onJwksFetch } : {}),
    }),
  };
}
