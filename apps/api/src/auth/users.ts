/**
 * The user store — PLATFORM-009.
 *
 * Login is upsert-by-external-identity: a verified token names an `(issuer,
 * subject)` pair, and either that pair already has an account or it gets one.
 * Email and display name are refreshed each time because they are descriptive,
 * and the role is deliberately *not* refreshed — a provider claim must never be
 * able to promote someone. Roles change in the database, by an administrator.
 */
import { isRole, type AuthenticatedUser, type Role, type VerifiedClaims } from './identity.js';

export interface UserSqlExecutor {
  query<R>(text: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
}

export interface UserRepository {
  /** Find or create the account for a verified identity. */
  upsert(claims: VerifiedClaims): Promise<AuthenticatedUser>;
  findById(userId: string): Promise<AuthenticatedUser | null>;
  /** Administrative role change. Not reachable from a token claim. */
  setRole(userId: string, role: Role): Promise<AuthenticatedUser | null>;
}

/**
 * Reading accounts for the classroom view — who owns these sessions, and
 * "find the student called …". Separate from `UserRepository` because nothing
 * on the sign-in path needs it, and every read is bounded.
 */
export interface UserDirectory {
  /** The accounts among `userIds` that exist. At most `MAX_DIRECTORY_READ`. */
  findByIds(userIds: readonly string[]): Promise<AuthenticatedUser[]>;
  /** Accounts whose email or display name contains `query`, case-insensitively. */
  search(query: string, limit: number): Promise<AuthenticatedUser[]>;
}

export const MAX_DIRECTORY_READ = 200;

export function isUserDirectory(value: unknown): value is UserDirectory {
  return (
    typeof (value as UserDirectory | null)?.findByIds === 'function' &&
    typeof (value as UserDirectory | null)?.search === 'function'
  );
}

/** `%`, `_` and the escape character itself, escaped in one pass for `ILIKE … ESCAPE '\'`. */
export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, '\\$&')}%`;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface UserRow {
  user_id: string;
  issuer: string;
  subject: string;
  email: string | null;
  display_name: string | null;
  role: string;
}

function toUser(row: UserRow, source: AuthenticatedUser['source']): AuthenticatedUser {
  return {
    userId: row.user_id,
    issuer: row.issuer,
    subject: row.subject,
    ...(row.email ? { email: row.email } : {}),
    ...(row.display_name ? { displayName: row.display_name } : {}),
    role: isRole(row.role) ? row.role : 'STUDENT',
    source,
  };
}

const COLUMNS = 'user_id, issuer, subject, email, display_name, role';

export class PostgresUserRepository implements UserRepository, UserDirectory {
  constructor(
    private readonly db: UserSqlExecutor,
    private readonly source: AuthenticatedUser['source'] = 'oidc',
  ) {}

  async upsert(claims: VerifiedClaims): Promise<AuthenticatedUser> {
    // `ON CONFLICT` on the external identity makes a concurrent first login
    // from two instances resolve to one account rather than to a duplicate-key
    // error on whichever lost. `role` is untouched on conflict: nothing a
    // provider asserts may change what someone is allowed to do.
    const { rows } = await this.db.query<UserRow>(
      `INSERT INTO users (issuer, subject, email, display_name)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (issuer, subject) DO UPDATE
              SET email = EXCLUDED.email,
                  display_name = EXCLUDED.display_name,
                  updated_at = now()
        RETURNING ${COLUMNS}`,
      [claims.issuer, claims.subject, claims.email ?? null, claims.displayName ?? null],
    );
    return toUser(rows[0]!, this.source);
  }

  async findById(userId: string): Promise<AuthenticatedUser | null> {
    const { rows } = await this.db.query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE user_id = $1`,
      [userId],
    );
    return rows[0] ? toUser(rows[0], this.source) : null;
  }

  async findByIds(userIds: readonly string[]): Promise<AuthenticatedUser[]> {
    // A non-UUID id matches no account; filtering first keeps the cast from failing the read.
    const ids = [...new Set(userIds)].filter((id) => UUID_SHAPE.test(id)).slice(0, MAX_DIRECTORY_READ);
    if (ids.length === 0) return [];
    const { rows } = await this.db.query<UserRow>(
      `SELECT ${COLUMNS} FROM users WHERE user_id = ANY($1::uuid[])`,
      [ids],
    );
    return rows.map((row) => toUser(row, this.source));
  }

  async search(query: string, limit: number): Promise<AuthenticatedUser[]> {
    const { rows } = await this.db.query<UserRow>(
      `SELECT ${COLUMNS} FROM users
        WHERE email ILIKE $1 ESCAPE '\\' OR display_name ILIKE $1 ESCAPE '\\'
        ORDER BY display_name NULLS LAST, email NULLS LAST, user_id
        LIMIT $2`,
      [likePattern(query), Math.min(MAX_DIRECTORY_READ, Math.max(1, Math.trunc(limit)))],
    );
    return rows.map((row) => toUser(row, this.source));
  }

  async setRole(userId: string, role: Role): Promise<AuthenticatedUser | null> {
    const { rows } = await this.db.query<UserRow>(
      `UPDATE users SET role = $2, updated_at = now() WHERE user_id = $1 RETURNING ${COLUMNS}`,
      [userId, role],
    );
    return rows[0] ? toUser(rows[0], this.source) : null;
  }
}

/**
 * In-memory equivalent, for tests and for running without a database.
 *
 * Obeys the same rules as the durable one — same uniqueness on (issuer,
 * subject), same refusal to take a role from claims — because a double that is
 * more permissive than production proves nothing.
 */
export class InMemoryUserRepository implements UserRepository, UserDirectory {
  readonly #byId = new Map<string, AuthenticatedUser>();
  #next = 0;

  constructor(private readonly source: AuthenticatedUser['source'] = 'development') {}

  async upsert(claims: VerifiedClaims): Promise<AuthenticatedUser> {
    for (const user of this.#byId.values()) {
      if (user.issuer === claims.issuer && user.subject === claims.subject) {
        const refreshed: AuthenticatedUser = {
          ...user,
          ...(claims.email ? { email: claims.email } : {}),
          ...(claims.displayName ? { displayName: claims.displayName } : {}),
        };
        this.#byId.set(user.userId, refreshed);
        return refreshed;
      }
    }
    this.#next += 1;
    const created: AuthenticatedUser = {
      userId: `usr-${String(this.#next).padStart(8, '0')}`,
      issuer: claims.issuer,
      subject: claims.subject,
      ...(claims.email ? { email: claims.email } : {}),
      ...(claims.displayName ? { displayName: claims.displayName } : {}),
      role: 'STUDENT',
      source: this.source,
    };
    this.#byId.set(created.userId, created);
    return created;
  }

  async findById(userId: string): Promise<AuthenticatedUser | null> {
    return this.#byId.get(userId) ?? null;
  }

  async findByIds(userIds: readonly string[]): Promise<AuthenticatedUser[]> {
    return [...new Set(userIds)]
      .slice(0, MAX_DIRECTORY_READ)
      .map((id) => this.#byId.get(id))
      .filter((user): user is AuthenticatedUser => user !== undefined);
  }

  async search(query: string, limit: number): Promise<AuthenticatedUser[]> {
    const needle = query.toLowerCase();
    return [...this.#byId.values()]
      .filter((user) => user.email?.toLowerCase().includes(needle) || user.displayName?.toLowerCase().includes(needle))
      .sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? ''))
      .slice(0, Math.min(MAX_DIRECTORY_READ, Math.max(1, Math.trunc(limit))));
  }

  /** Every account, in creation order — what the in-memory access store lists. */
  async list(): Promise<AuthenticatedUser[]> {
    return [...this.#byId.values()];
  }

  async setRole(userId: string, role: Role): Promise<AuthenticatedUser | null> {
    const user = this.#byId.get(userId);
    if (!user) return null;
    const updated = { ...user, role };
    this.#byId.set(userId, updated);
    return updated;
  }
}
