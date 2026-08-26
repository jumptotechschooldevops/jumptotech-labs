/**
 * The browser's half of authentication — PLATFORM-010.
 *
 * Deliberately small, because there is deliberately little for it to do. The
 * API is the OIDC client; this file holds **no token, no secret, and no
 * identifier**. It asks "who am I", navigates to sign-in, and posts sign-out.
 *
 * ```text
 *   session()  GET  /auth/session   → { authenticated, identity? }
 *   signIn()   navigate /auth/login?returnTo=…   (a real navigation, not fetch)
 *   signOut()  POST /auth/logout    → cookie cleared server-side
 * ```
 *
 * ## Why nothing is stored here
 *
 * The session lives in an HttpOnly cookie the browser attaches automatically.
 * There is no `localStorage.setItem` anywhere in this module, and there must
 * never be one: anything this file could store, any script on the page could
 * read. Auth state in React is a *cache of a server answer*, refreshed on load
 * and after a 401 — never the source of truth.
 *
 * ## Why sign-in is a navigation
 *
 * `fetch('/auth/login')` would follow the redirect in the background and land
 * the provider's HTML in a JavaScript string. Sign-in has to happen in the
 * address bar, where the user can see the provider's domain and their password
 * manager can too.
 */
import { resolveApiBase } from './urls';

const API_URL = resolveApiBase();

/** What the API says about the current caller. */
export interface AuthIdentity {
  subject: string;
  issuer: string;
  email?: string;
  displayName?: string;
  role: 'STUDENT' | 'INSTRUCTOR' | 'ADMIN';
  source: 'oidc' | 'development';
}

export interface AuthSession {
  authenticated: boolean;
  /** False when the deployment has no identity provider configured. */
  signInAvailable: boolean;
  mode: 'oidc' | 'development';
  identity?: AuthIdentity;
}

export interface AuthEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; remediation?: string };
}

/**
 * Broadcast when the API answers 401 to something that should have worked.
 *
 * A custom event rather than a callback registry: every layer that can see a
 * 401 — the REST client, the terminal socket — dispatches the same one, and the
 * auth provider is the single listener that decides what it means. No module
 * has to know the provider exists.
 */
export const AUTH_EXPIRED_EVENT = 'jumptotech:auth-expired';

export function announceAuthExpired(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
}

/**
 * Ask the API who this browser is.
 *
 * Never throws for "signed out" — that is a successful answer. It throws only
 * when the API cannot be reached at all, which the caller renders differently:
 * "sign in" and "the server is down" are not the same problem.
 */
export async function fetchAuthSession(): Promise<AuthSession> {
  const response = await fetch(`${API_URL}/auth/session`, {
    // Without this the cookie is not sent cross-origin, and the API would
    // correctly answer "signed out" to a browser that is signed in.
    credentials: 'include',
    headers: { accept: 'application/json' },
  });

  const body = (await response.json().catch(() => null)) as AuthEnvelope<AuthSession> | null;
  if (!body?.ok || !body.data) {
    throw new Error('The API did not answer the session query.');
  }
  return body.data;
}

/** Same-origin path to come back to, so a deep link survives sign-in. */
function currentReturnTo(): string {
  if (typeof window === 'undefined') return '/';
  const { pathname, search, hash } = window.location;
  return `${pathname}${search}${hash}` || '/';
}

export function signIn(returnTo: string = currentReturnTo()): void {
  if (typeof window === 'undefined') return;
  const target = `${API_URL}/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  // `assign`, not `replace`: the page the user was on stays in history, so Back
  // from a provider they decided not to use returns them where they were.
  window.location.assign(target);
}

export interface SignOutResult {
  signedOut: boolean;
  /** The provider's single-logout URL, when it publishes one. */
  endSessionUrl?: string;
}

/**
 * Sign out.
 *
 * POST because a GET logout is triggerable by any page that can make this
 * browser load an image — a cross-site request forgery whose payload is
 * "log this person out".
 */
export async function signOut(): Promise<SignOutResult> {
  const response = await fetch(`${API_URL}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  const body = (await response.json().catch(() => null)) as AuthEnvelope<SignOutResult> | null;
  return body?.data ?? { signedOut: response.ok };
}

/** A human label for an identity, preferring the most specific thing we have. */
export function displayNameFor(identity: AuthIdentity): string {
  return identity.displayName?.trim() || identity.email?.trim() || identity.subject;
}
