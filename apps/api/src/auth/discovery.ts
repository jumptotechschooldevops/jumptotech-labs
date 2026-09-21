/**
 * OIDC Discovery, shared by the client and the verifier — BETA-P0-014.
 *
 * Both halves of the OIDC integration need something from the issuer's
 * discovery document: the client its endpoints, the verifier its `jwks_uri`.
 * Before this module the verifier did not ask at all — it assumed keys live at
 * `<issuer>/.well-known/jwks.json`, which is one provider's convention and not
 * the standard — and the client accepted whatever `issuer` the document named.
 *
 * Two rules, both from OpenID Connect Discovery 1.0:
 *
 *   · §4.3 — the `issuer` in the document MUST be identical to the issuer the
 *     client was configured with. Otherwise a document served from the right
 *     URL can point at somebody else's keys and endpoints.
 *   · endpoints are data from the network, so each is parsed and its scheme
 *     checked. An `https:` issuer may not publish an `http:` endpoint: that
 *     would downgrade the code exchange or the key fetch to plaintext behind a
 *     configuration that looks secure.
 *
 * TLS verification is Node's default and is never relaxed here; production
 * additionally refuses `NODE_TLS_REJECT_UNAUTHORIZED` at startup (BETA-P0-011).
 */
import { AuthError } from './identity.js';

export interface DiscoveryOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

/**
 * Check one URL the provider published.
 *
 * `http:` is accepted only when the issuer itself is `http:` — a loopback test
 * provider. Production never gets that far: its issuer must be `https:`.
 */
export function assertProviderEndpoint(value: unknown, field: string, issuer: string): string {
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
  if (url.protocol === 'http:' && issuer.startsWith('https:')) {
    throw new AuthError(
      'AUTH_MISCONFIGURED',
      `The identity provider's ${field} is plain http: under an https: issuer.`,
    );
  }
  if (url.username || url.password) {
    throw new AuthError('AUTH_MISCONFIGURED', `The identity provider's ${field} carries credentials.`);
  }
  return url.href;
}

/** Fetch the discovery document and prove it describes the configured issuer. */
export async function fetchDiscoveryDocument(
  issuer: string,
  options: DiscoveryOptions = {},
): Promise<Record<string, unknown>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL('.well-known/openid-configuration', ensureTrailingSlash(issuer)).href;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    throw new AuthError('AUTH_MISCONFIGURED', 'Could not reach the identity provider for discovery.');
  }
  if (!response.ok) {
    clearTimeout(timer);
    throw new AuthError('AUTH_MISCONFIGURED', 'The identity provider refused the discovery request.');
  }

  // Still under the deadline: `fetch` resolves at the headers, and a document
  // that never finishes arriving must not hold the request reading it.
  let document: Record<string, unknown>;
  try {
    document = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new AuthError(
      'AUTH_MISCONFIGURED',
      controller.signal.aborted
        ? 'The identity provider did not finish sending its discovery document in time.'
        : "The identity provider's discovery document was not JSON.",
    );
  } finally {
    clearTimeout(timer);
  }
  if (document === null || typeof document !== 'object') {
    throw new AuthError('AUTH_MISCONFIGURED', "The identity provider's discovery document was not an object.");
  }

  if (document.issuer !== issuer) {
    // Named without either value: the configured one is in the operator's own
    // environment, and the published one is provider-controlled text.
    throw new AuthError(
      'AUTH_MISCONFIGURED',
      'The identity provider published an issuer that does not match OIDC_ISSUER.',
      'Set OIDC_ISSUER to exactly the `issuer` value in the provider discovery document, trailing slash included.',
    );
  }
  return document;
}
