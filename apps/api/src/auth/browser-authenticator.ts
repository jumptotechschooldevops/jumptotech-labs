/**
 * Turning a session cookie into the authenticated user — PLATFORM-010.
 *
 * This is deliberately **not** an `IdentityResolver`. That interface receives
 * the `Authorization` header and nothing else, and the reason is written into
 * its own docstring: a resolver that could read a cookie or a body could be
 * talked into letting a client name the user it wants to be. Widening it to
 * take a whole request would give every implementation that power in order to
 * give it to one.
 *
 * So the cookie path is a separate, narrow collaborator with its own contract,
 * and `authenticate()` composes the two in a documented order. The invariant
 * survives intact: neither path reads an identifier the client chose.
 *
 * ```text
 *   Cookie: jtt_session=<opaque 256-bit id>
 *        └─► sha256 ─► auth_sessions row ─► user_id ─► users row ─► req.user
 * ```
 *
 * The cookie is an index, not an assertion. It says "there is a server-side
 * record"; the record says who the user is. A forged cookie names no record and
 * resolves to nobody.
 */
import { AuthError, type AuthenticatedUser } from './identity.js';
import type { AuthSessionStore } from './browser-session.js';
import { parseCookies } from './cookies.js';
import type { UserRepository } from './users.js';

export interface BrowserSessionAuthenticatorOptions {
  sessions: AuthSessionStore;
  users: UserRepository;
  cookieName: string;
}

/**
 * Resolves a browser session, or reports that there was not one.
 *
 * The three outcomes are kept distinct because the caller treats them
 * differently:
 *
 *   `null`            no cookie at all — fall through to the header path
 *   throws AuthError  a cookie that named nothing, or a user since removed
 *   `AuthenticatedUser` the caller
 *
 * Falling through on "no cookie" is what keeps service callers, the test suite
 * and development mode working unchanged. Throwing on "cookie present but
 * unusable" is what stops a stale cookie silently degrading into the default
 * development identity, which would be a security hole disguised as
 * convenience.
 */
export class BrowserSessionAuthenticator {
  readonly #sessions: AuthSessionStore;
  readonly #users: UserRepository;
  readonly #cookieName: string;

  constructor(options: BrowserSessionAuthenticatorOptions) {
    this.#sessions = options.sessions;
    this.#users = options.users;
    this.#cookieName = options.cookieName;
  }

  get cookieName(): string {
    return this.#cookieName;
  }

  /** Read the raw cookie value, or `undefined`. Never logged by any caller. */
  cookieFrom(cookieHeader: string | undefined): string | undefined {
    const value = parseCookies(cookieHeader)[this.#cookieName];
    return value && value.length > 0 ? value : undefined;
  }

  async authenticate(cookieHeader: string | undefined): Promise<AuthenticatedUser | null> {
    const cookieValue = this.cookieFrom(cookieHeader);
    if (!cookieValue) return null;

    const record = await this.#sessions.resolve(cookieValue);
    if (!record) {
      // Expired and forged are answered identically. Distinguishing them would
      // tell a caller holding a guessed value that it was once real.
      throw new AuthError(
        'AUTH_EXPIRED',
        'Your session has expired.',
        'Sign in again.',
      );
    }

    const user = await this.#users.findById(record.userId);
    if (!user) {
      // The account behind a live session is gone. Refuse rather than invent
      // one: an authenticated request must correspond to a real account, and a
      // deleted user's sessions must stop working immediately.
      throw new AuthError(
        'AUTH_INVALID_TOKEN',
        'The credentials supplied are not valid.',
        'Sign in again.',
      );
    }

    return user;
  }
}
