/**
 * Production authentication gate — BETA-P0-014.
 *
 * PLATFORM-009 refused `AUTH_MODE=development` under `NODE_ENV=production`, and
 * PLATFORM-010 refused a localhost public origin. Everything else about sign-in
 * was accepted as configured, so a production API could start:
 *
 *   · with no `OIDC_CLIENT_SECRET` — no student could sign in at all;
 *   · with an `http:` issuer — discovery, JWKS and the code exchange in clear;
 *   · with `OIDC_REDIRECT_URI` on an origin this deployment does not serve —
 *     authorization codes delivered to somebody else;
 *   · with `AUTH_COOKIE_SECURE=false` — a session id readable by any proxy;
 *   · with `DEV_STUDENT_HEADER_ENABLED=true` — a browser header selecting whose
 *     progress is read.
 *
 * Each of those is a working deployment that is quietly unsafe, which is the
 * worst kind. This module turns every one into a refusal to start.
 *
 * It is pure — configuration in, problems out — and it names variables and
 * the non-secret values it rejects (origins, URLs), never `OIDC_CLIENT_SECRET`.
 * Nothing here is provider-specific: every rule is OIDC Core, OIDC Discovery,
 * RFC 6265 or RFC 6454.
 */
import { AuthError } from './identity.js';

/** Scopes the browser flow must and must not request. */
export const REQUIRED_SCOPE = 'openid';
/**
 * Refused everywhere. A refresh token is a long-lived credential; the callback
 * would discard it, so requesting one only makes the provider mint something
 * nobody is accountable for. Holding refresh tokens is a separate decision.
 */
export const REFUSED_SCOPES = ['offline_access'] as const;

/** The only callback route this API serves. */
export const CALLBACK_PATH = '/auth/callback';

/** Bounds on the browser session lifetime, in seconds. */
export const MIN_AUTH_SESSION_TTL_SECONDS = 5 * 60;
export const MAX_AUTH_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface ProductionAuthInput {
  mode: 'oidc' | 'development';
  issuer: string;
  clientId: string;
  /** Checked for presence only. Its strength is `assertProductionSecrets`' job. */
  clientSecretPresent: boolean;
  audience: string;
  jwksUri: string;
  /** `PUBLIC_ORIGIN` exactly as configured, or empty when unset. */
  publicOrigin: string;
  /** The redirect URI the client will send, explicit or derived. */
  redirectUri: string;
  allowedOrigins: string[];
  cookieSecure: boolean;
  cookieDomain: string | undefined;
  scopes: string[];
  devStudentHeaderEnabled: boolean;
  /** `DATABASE_URL` or `POSTGRES_HOST` names a PostgreSQL database. */
  databaseConfigured: boolean;
}

/**
 * Parse a value that must be a bare origin: scheme, host, optional port, and
 * nothing else. Returns the canonical `URL#origin`, or `null`.
 *
 * A trailing slash is tolerated because operators type one; a path, query,
 * fragment or userinfo is not, because each of those changes where a redirect
 * built from this value actually lands (`https://labs.example.com@evil.example`
 * is a different host).
 */
export function bareOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  // `new URL` normalises case and default ports; the input must already be
  // that canonical form, so what an operator reads is what is enforced.
  if (value.replace(/\/$/, '') !== url.origin) return null;
  return url.origin;
}

function httpsUrlProblem(name: string, value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${name} is not an absolute URL.`;
  }
  if (url.protocol !== 'https:') return `${name} must use https: (got '${url.protocol}').`;
  if (url.username || url.password) return `${name} must not carry credentials.`;
  if (url.hash) return `${name} must not carry a fragment.`;
  return null;
}

/** RFC 6265 §5.1.3 domain-match, for a configured `Domain` attribute. */
export function cookieDomainMatches(host: string, domain: string): boolean {
  const normalized = domain.trim().replace(/^\./, '').toLowerCase();
  const h = host.toLowerCase();
  if (!normalized || normalized.includes('/') || normalized.includes(':')) return false;
  return h === normalized || h.endsWith(`.${normalized}`);
}

/** Scope rules that hold in every environment where the browser flow exists. */
export function scopeProblems(scopes: string[]): string[] {
  const problems: string[] = [];
  if (!scopes.includes(REQUIRED_SCOPE)) {
    problems.push(`OIDC_SCOPES must include '${REQUIRED_SCOPE}'; without it the provider issues no ID token.`);
  }
  for (const refused of REFUSED_SCOPES) {
    if (scopes.includes(refused)) {
      problems.push(
        `OIDC_SCOPES must not include '${refused}': refresh tokens are not held by this platform.`,
      );
    }
  }
  return problems;
}

/** Every reason this configuration may not serve production sign-in. */
export function productionAuthProblems(input: ProductionAuthInput): string[] {
  const problems: string[] = [];

  if (input.mode !== 'oidc') {
    problems.push(
      'AUTH_MODE must be oidc: development authentication accepts any identity the caller claims.',
    );
    // Nothing below applies to a mode that is itself refused.
    return problems;
  }

  // --- the provider -------------------------------------------------------
  if (!input.issuer) {
    problems.push('OIDC_ISSUER is not set.');
  } else {
    const issuerProblem = httpsUrlProblem('OIDC_ISSUER', input.issuer);
    if (issuerProblem) problems.push(issuerProblem);
    else if (new URL(input.issuer).search) {
      // OIDC Discovery §2: an issuer identifier has no query component.
      problems.push('OIDC_ISSUER must not carry a query string.');
    }
  }
  if (!input.clientId) problems.push('OIDC_CLIENT_ID is not set.');
  if (!input.clientSecretPresent) {
    problems.push(
      'OIDC_CLIENT_SECRET is not set: the API is a confidential client, and without it no student can sign in.',
    );
  }
  if (!input.audience) problems.push('OIDC_AUDIENCE is not set.');
  if (input.jwksUri) {
    const jwksProblem = httpsUrlProblem('OIDC_JWKS_URI', input.jwksUri);
    if (jwksProblem) problems.push(jwksProblem);
  }

  // --- where the browser lives -------------------------------------------
  let publicOrigin: string | null = null;
  if (!input.publicOrigin) {
    problems.push(
      'PUBLIC_ORIGIN is not set: production does not derive the callback and logout origin from ALLOWED_ORIGINS.',
    );
  } else {
    publicOrigin = bareOrigin(input.publicOrigin);
    if (!publicOrigin) {
      // Not echoed: a malformed origin is exactly where a pasted credential
      // sits (`https://user:password@host`), and this message reaches the
      // container log and `make production-config-check`.
      problems.push('PUBLIC_ORIGIN is not a bare origin (scheme://host[:port], nothing else).');
    } else if (!publicOrigin.startsWith('https://')) {
      problems.push(`PUBLIC_ORIGIN must use https: (got '${publicOrigin}').`);
      publicOrigin = null;
    }
  }

  // --- the callback ------------------------------------------------------
  const redirectProblem = httpsUrlProblem('OIDC_REDIRECT_URI', input.redirectUri);
  if (redirectProblem) {
    problems.push(redirectProblem);
  } else {
    const redirect = new URL(input.redirectUri);
    if (redirect.search) problems.push('OIDC_REDIRECT_URI must not carry a query string.');
    if (publicOrigin && redirect.origin !== publicOrigin) {
      problems.push(
        `OIDC_REDIRECT_URI must be on PUBLIC_ORIGIN (${publicOrigin}), not '${redirect.origin}': ` +
          'the sign-in transaction cookie is host-only, and a code delivered elsewhere is a code given away.',
      );
    }
    if (redirect.pathname !== CALLBACK_PATH) {
      problems.push(`OIDC_REDIRECT_URI path must be ${CALLBACK_PATH}, the only callback this API serves.`);
    }
  }

  // --- who may call with credentials --------------------------------------
  for (const [index, origin] of input.allowedOrigins.entries()) {
    const parsed = bareOrigin(origin);
    if (!parsed) {
      // By position, not value — as for PUBLIC_ORIGIN above.
      problems.push(`ALLOWED_ORIGINS entry ${index + 1} is not a bare origin (scheme://host[:port], nothing else).`);
    } else if (!parsed.startsWith('https://')) {
      problems.push(`ALLOWED_ORIGINS entry '${origin}' must use https:.`);
    }
  }
  if (publicOrigin && !input.allowedOrigins.some((origin) => bareOrigin(origin) === publicOrigin)) {
    problems.push(`ALLOWED_ORIGINS must include PUBLIC_ORIGIN (${publicOrigin}).`);
  }

  // --- the cookie ---------------------------------------------------------
  if (!input.cookieSecure) {
    problems.push('AUTH_COOKIE_SECURE must not be false: the session cookie would be sent over plain HTTP.');
  }
  if (input.cookieDomain && publicOrigin) {
    const host = new URL(publicOrigin).hostname;
    if (!cookieDomainMatches(host, input.cookieDomain)) {
      problems.push(
        `AUTH_COOKIE_DOMAIN '${input.cookieDomain}' does not domain-match PUBLIC_ORIGIN's host '${host}'.`,
      );
    }
  }

  problems.push(...scopeProblems(input.scopes));

  // --- where a signed-in browser is remembered ----------------------------
  if (!input.databaseConfigured) {
    problems.push(
      'DATABASE_URL is not set: production sign-in requires durable PostgreSQL-backed sessions. ' +
        'Without it every sign-in lives in process memory, is lost on each restart, and is invisible to a second instance.',
    );
  }

  // --- development identity switches --------------------------------------
  if (input.devStudentHeaderEnabled) {
    problems.push(
      'DEV_STUDENT_HEADER_ENABLED must not be true: it lets a browser header choose whose progress is read.',
    );
  }

  return problems;
}

/**
 * The same rule at the composition root, where the stores are actually chosen.
 *
 * `loadConfig` already refuses a production configuration with no database; this
 * is the second line, so that no future path to an `ApiConfig` can quietly hand
 * a production process the in-memory session, user and progress stores.
 */
export function assertDurableStoresInProduction(input: { nodeEnv: string; durable: boolean }): void {
  if (input.nodeEnv.trim() !== 'production' || input.durable) return;
  throw new AuthError(
    'AUTH_MISCONFIGURED',
    'api refuses to start under NODE_ENV=production without a PostgreSQL database: browser sessions would be in memory.',
    'Set DATABASE_URL. See docs/authentication.md §4.2 (BETA-P0-014).',
  );
}

/** Refuse to start, listing every problem at once so a deploy is fixed in one pass. */
export function assertProductionAuthConfig(input: ProductionAuthInput): void {
  const problems = productionAuthProblems(input);
  if (problems.length === 0) return;
  throw new AuthError(
    'AUTH_MISCONFIGURED',
    `api refuses to start under NODE_ENV=production — authentication is not production-ready:\n  - ${problems.join('\n  - ')}`,
    'See docs/authentication.md §4 (BETA-P0-014).',
  );
}
