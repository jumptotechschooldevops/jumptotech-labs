/**
 * Browser authentication sessions — PLATFORM-010.
 *
 * The API is the confidential OIDC client (see `docs/authentication.md`). After
 * a successful code exchange the browser is handed an **opaque** session id in
 * an HttpOnly cookie, and this module is where that id lives.
 *
 * Three rules, all enforced below rather than documented and hoped for:
 *
 *   1. **The stored value is a hash, never the cookie.** A `SELECT *` on this
 *      table yields nothing a caller could present. The raw id exists only in
 *      the `Set-Cookie` header and in the browser's cookie jar.
 *   2. **The id is opaque and carries no claims.** It is 256 bits of
 *      `randomBytes` and says nothing about who the user is — the mapping to a
 *      user is server-side, which is what makes "never trust a user id supplied
 *      by the browser" structurally true rather than a review comment.
 *   3. **Lookup is by hash and is constant-time-safe by construction.** The
 *      hash is the primary key, so there is no comparison loop to leak timing.
 *
 * What this deliberately does NOT store: the access token, the ID token, or a
 * refresh token. The ID token is verified and discarded at callback time and
 * only its claims are persisted as a user row; no OIDC credential outlives the
 * exchange. That is why a compromised database cannot be replayed against the
 * identity provider.
 */
import { createHash, randomBytes } from 'node:crypto';

/** How long a browser session may live before re-authentication is required. */
export const DEFAULT_AUTH_SESSION_TTL_SECONDS = 12 * 60 * 60;

/**
 * A browser session as the server knows it.
 *
 * `authSessionId` is the *hash*, not the cookie. Nothing that leaves this module
 * carries the raw id except `create()`'s return value, which goes straight into
 * a `Set-Cookie` header.
 */
export interface AuthSessionRecord {
  authSessionId: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface CreatedAuthSession {
  /** The value to put in the cookie. Never stored, never logged. */
  cookieValue: string;
  record: AuthSessionRecord;
}

export interface AuthSessionStore {
  create(userId: string, ttlSeconds: number): Promise<CreatedAuthSession>;
  /** Resolve a raw cookie value, or `null` if unknown or expired. */
  resolve(cookieValue: string): Promise<AuthSessionRecord | null>;
  /** Sign out. Idempotent: destroying an unknown session is not an error. */
  destroy(cookieValue: string): Promise<boolean>;
  /** Sign out everywhere. Used when an account is disabled. */
  destroyAllForUser(userId: string): Promise<number>;
  /** Drop expired rows. Called on a timer by the composition root. */
  purgeExpired(): Promise<number>;
}

/**
 * Mint a cookie value and its stored hash.
 *
 * 32 bytes, base64url: unguessable, and short enough to sit comfortably inside
 * the 4 KB a cookie is allowed.
 */
export function mintAuthSessionId(): { cookieValue: string; hash: string } {
  const cookieValue = randomBytes(32).toString('base64url');
  return { cookieValue, hash: hashAuthSessionId(cookieValue) };
}

/**
 * The stored form of a cookie value.
 *
 * SHA-256 with no salt and no stretching, deliberately: the input is already
 * 256 bits of uniform randomness, so there is no dictionary to defend against
 * and a slow KDF would only add latency to every authenticated request.
 */
export function hashAuthSessionId(cookieValue: string): string {
  return createHash('sha256').update(cookieValue, 'utf8').digest('hex');
}

/**
 * A cookie value has to *look* right before it is used as a lookup key.
 *
 * Not security on its own — the hash lookup is what decides — but it keeps
 * absurd input out of the database and out of any error path.
 */
export function looksLikeAuthSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function isoIn(seconds: number, now: number): string {
  return new Date(now + seconds * 1000).toISOString();
}

/**
 * In-memory store, for tests and for running without a database.
 *
 * Same contract as the durable one, including the hash-not-value rule — a
 * double that is more permissive than production proves nothing.
 */
export class InMemoryAuthSessionStore implements AuthSessionStore {
  readonly #byHash = new Map<string, AuthSessionRecord>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  async create(userId: string, ttlSeconds: number): Promise<CreatedAuthSession> {
    const now = this.#now();
    const { cookieValue, hash } = mintAuthSessionId();
    const record: AuthSessionRecord = {
      authSessionId: hash,
      userId,
      createdAt: new Date(now).toISOString(),
      expiresAt: isoIn(ttlSeconds, now),
    };
    this.#byHash.set(hash, record);
    return { cookieValue, record };
  }

  async resolve(cookieValue: string): Promise<AuthSessionRecord | null> {
    if (!looksLikeAuthSessionId(cookieValue)) return null;
    const record = this.#byHash.get(hashAuthSessionId(cookieValue));
    if (!record) return null;
    if (Date.parse(record.expiresAt) <= this.#now()) {
      // Expired rows are removed on read as well as on the purge timer, so an
      // expired session cannot be resurrected by a clock adjustment.
      this.#byHash.delete(record.authSessionId);
      return null;
    }
    return record;
  }

  async destroy(cookieValue: string): Promise<boolean> {
    if (!looksLikeAuthSessionId(cookieValue)) return false;
    return this.#byHash.delete(hashAuthSessionId(cookieValue));
  }

  async destroyAllForUser(userId: string): Promise<number> {
    let removed = 0;
    for (const [hash, record] of this.#byHash) {
      if (record.userId === userId) {
        this.#byHash.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }

  async purgeExpired(): Promise<number> {
    const now = this.#now();
    let removed = 0;
    for (const [hash, record] of this.#byHash) {
      if (Date.parse(record.expiresAt) <= now) {
        this.#byHash.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }
}

export interface AuthSessionSqlExecutor {
  query<R>(text: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
}

interface AuthSessionRow {
  auth_session_id: string;
  user_id: string;
  created_at: Date | string;
  expires_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toRecord(row: AuthSessionRow): AuthSessionRecord {
  return {
    authSessionId: row.auth_session_id,
    userId: row.user_id,
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
  };
}

/**
 * The durable store.
 *
 * Every statement is parameterised and every one is addressed by the *hash*.
 * `resolve` filters on `expires_at > now()` in SQL rather than in JavaScript, so
 * an expired row can never be returned even by an instance whose clock has
 * drifted relative to the database.
 */
export class PostgresAuthSessionStore implements AuthSessionStore {
  constructor(private readonly db: AuthSessionSqlExecutor) {}

  async create(userId: string, ttlSeconds: number): Promise<CreatedAuthSession> {
    const { cookieValue, hash } = mintAuthSessionId();
    const { rows } = await this.db.query<AuthSessionRow>(
      `INSERT INTO auth_sessions (auth_session_id, user_id, expires_at)
            VALUES ($1, $2, now() + make_interval(secs => $3))
        RETURNING auth_session_id, user_id, created_at, expires_at`,
      [hash, userId, ttlSeconds],
    );
    return { cookieValue, record: toRecord(rows[0]!) };
  }

  async resolve(cookieValue: string): Promise<AuthSessionRecord | null> {
    if (!looksLikeAuthSessionId(cookieValue)) return null;
    const { rows } = await this.db.query<AuthSessionRow>(
      `SELECT auth_session_id, user_id, created_at, expires_at
         FROM auth_sessions
        WHERE auth_session_id = $1 AND expires_at > now()`,
      [hashAuthSessionId(cookieValue)],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async destroy(cookieValue: string): Promise<boolean> {
    if (!looksLikeAuthSessionId(cookieValue)) return false;
    const { rows } = await this.db.query<{ auth_session_id: string }>(
      `DELETE FROM auth_sessions WHERE auth_session_id = $1 RETURNING auth_session_id`,
      [hashAuthSessionId(cookieValue)],
    );
    return rows.length > 0;
  }

  async destroyAllForUser(userId: string): Promise<number> {
    const { rows } = await this.db.query<{ auth_session_id: string }>(
      `DELETE FROM auth_sessions WHERE user_id = $1 RETURNING auth_session_id`,
      [userId],
    );
    return rows.length;
  }

  async purgeExpired(): Promise<number> {
    const { rows } = await this.db.query<{ auth_session_id: string }>(
      `DELETE FROM auth_sessions WHERE expires_at <= now() RETURNING auth_session_id`,
    );
    return rows.length;
  }
}
