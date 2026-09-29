/**
 * Lab-session activity, reported from the one place a student actually works.
 *
 * The API decides whether a session is idle from `lastActivityAt`, and until
 * BETA-P0-005 only REST actions moved it. A student typing in the shell for
 * twenty minutes looked exactly like an abandoned tab, and was reaped as one.
 *
 * ```text
 *   input frame ──► (throttled, per socket) ──► POST /internal/sessions/<sid>/activity
 *                                                { ownerUserId: claims.uid }
 *                                                └─► SessionStore.touchActivity
 * ```
 *
 * Both the session id and the owner come from the token verified at `auth`,
 * never from the frame, and the API re-proves ownership exactly as it does for
 * the credential exchange.
 */
import { claimsBody, type FetchOptions } from './credentials.js';

/**
 * The API refused the report outright — as opposed to not answering, which
 * says nothing about the socket. Carries the API's code, so the caller can
 * tell "this terminal no longer has the authority it was opened with" from a
 * refusal it should ignore.
 */
export class ActivityRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`the lab API refused the activity report (${status}${code ? ` ${code}` : ''})`);
    this.name = 'ActivityRefusedError';
  }
}

/**
 * Refusals that end the authority an open terminal was opened with: its
 * sign-in was ended, its session changed hands, or its owner's lab access
 * stopped. A socket told one of these is closed — the same answer a new attach
 * would get — rather than kept open for as long as the student keeps typing.
 */
export const AUTHORITY_REFUSALS: ReadonlySet<string> = new Set([
  'AUTH_SESSION_ENDED',
  'SESSION_NOT_OWNED',
  'OWNER_REQUIRED',
  'ACCESS_NOT_ACTIVE',
  'LAB_NOT_IN_PLAN',
  'ACCESS_PLAN_UNAVAILABLE',
]);

/**
 * Tell the API a student is working in this session.
 *
 * Resolves to whether the API recorded it — `false` for a session that is no
 * longer live. Rejects on any transport or authorisation failure; callers treat
 * that as best-effort, because a missed report must never cost a working shell.
 */
export async function reportSessionActivity(options: FetchOptions): Promise<boolean> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    const response = await doFetch(
      `${options.apiInternalUrl.replace(/\/$/, '')}/internal/sessions/${encodeURIComponent(options.sessionId)}/activity`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': options.secret },
        body: claimsBody(options),
        signal: controller.signal,
      },
    );
    const body = (await response.json().catch(() => null)) as
      | { ok?: boolean; data?: { recorded?: unknown }; error?: { code?: string } }
      | null;
    if (!response.ok || !body?.ok) {
      throw new ActivityRefusedError(response.status, body?.error?.code);
    }
    return body.data?.recorded === true;
  } finally {
    clearTimeout(timer);
  }
}
