/**
 * Authorization decisions — PLATFORM-009.
 *
 * Every decision is made here. Not because centralising is tidy, but because
 * `if (role === 'ADMIN')` scattered across twenty handlers is how one handler
 * ends up missing it, and the handler that misses it is the vulnerability. A
 * route asks a question; this file answers it; the route enforces the answer.
 *
 * ## What a session's owner is
 *
 * A student may act on a session **they own**. Ownership is the stored
 * `ownerUserId`, matched against the authenticated caller. It is never inferred
 * from a namespace, a sandbox name, a lab id, an email, or from the caller
 * having quoted the session id — knowing an identifier is not a capability.
 *
 * A session with **no owner** — one created before authentication existed —
 * belongs to nobody and is reachable by no student. It stays reapable.
 *
 * ## 404, not 403
 *
 * A student asking about somebody else's session gets the same answer as one
 * asking about a session that does not exist. 403 would confirm the id is real,
 * which turns id-guessing into an enumeration oracle; there is no legitimate
 * client that needs to tell the two apart. Operators see the difference in the
 * audit line, where `authorization_result` says `denied-not-owner`.
 */
import type { AuthenticatedUser, Role } from './identity.js';

/** What the caller wants to do. */
export type Action =
  | 'session:read'
  | 'session:check'
  | 'session:reset'
  | 'session:activity'
  | 'session:end'
  | 'session:hint'
  | 'session:terminal'
  | 'session:start'
  | 'progress:read'
  | 'admin:users';

/** The session facts a decision needs. Deliberately not the whole record. */
export interface SessionSubject {
  sessionId: string;
  ownerUserId?: string | undefined;
}

export type Decision =
  | { allowed: true; reason: 'owner' | 'role' }
  | { allowed: false; reason: 'not-owner' | 'unowned' | 'role' };

const OWNED_ACTIONS: readonly Action[] = [
  'session:read',
  'session:check',
  'session:reset',
  'session:activity',
  'session:end',
  'session:hint',
  'session:terminal',
];

/**
 * What each role may do to a session that is not its own.
 *
 * INSTRUCTOR is *not* a weaker ADMIN, and is not defined by ordering. It may
 * look at a session to answer "is this student's environment healthy" — and
 * nothing more. It may not attach a terminal, reset, or end another person's
 * lab: that is taking control of someone's work, and a support tool that can do
 * it silently needs a consent and audit design this story does not have. See
 * `docs/authorization.md`.
 */
const CROSS_USER_SESSION_ACTIONS: Record<Role, readonly Action[]> = {
  STUDENT: [],
  INSTRUCTOR: ['session:read'],
  ADMIN: ['session:read', 'session:end'],
};

/** Actions allowed on a caller's own account, whatever their role. */
const SELF_ACTIONS: readonly Action[] = ['session:start', 'progress:read'];

const ROLE_ONLY_ACTIONS: Record<Action, readonly Role[] | undefined> = {
  'admin:users': ['ADMIN'],
  'session:read': undefined,
  'session:check': undefined,
  'session:reset': undefined,
  'session:activity': undefined,
  'session:end': undefined,
  'session:hint': undefined,
  'session:terminal': undefined,
  'session:start': undefined,
  'progress:read': undefined,
};

/**
 * May `user` perform `action`, optionally against `session`?
 *
 * The single entry point. A route that forgets to call it is a bug visible in
 * one place rather than a silent hole in one handler.
 */
export function authorize(
  user: AuthenticatedUser,
  action: Action,
  session?: SessionSubject,
): Decision {
  const requiredRoles = ROLE_ONLY_ACTIONS[action];
  if (requiredRoles) {
    return requiredRoles.includes(user.role)
      ? { allowed: true, reason: 'role' }
      : { allowed: false, reason: 'role' };
  }

  if (SELF_ACTIONS.includes(action) && !session) {
    return { allowed: true, reason: 'owner' };
  }

  if (OWNED_ACTIONS.includes(action)) {
    if (!session) return { allowed: false, reason: 'not-owner' };

    // A session created before authentication existed belongs to nobody, and
    // nobody inherits it — not even an admin, who would otherwise be acting on
    // a lab with no accountable owner.
    if (!session.ownerUserId) return { allowed: false, reason: 'unowned' };

    if (session.ownerUserId === user.userId) return { allowed: true, reason: 'owner' };

    return CROSS_USER_SESSION_ACTIONS[user.role].includes(action)
      ? { allowed: true, reason: 'role' }
      : { allowed: false, reason: 'not-owner' };
  }

  return { allowed: false, reason: 'role' };
}

/** True when the caller may act on their own sessions at all. */
export function canStartLabs(user: AuthenticatedUser): boolean {
  return authorize(user, 'session:start').allowed;
}
