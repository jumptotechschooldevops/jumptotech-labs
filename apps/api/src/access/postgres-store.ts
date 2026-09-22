/**
 * Entitlements in PostgreSQL — migration 006.
 *
 * Every write goes through `mutate`, which runs in one transaction:
 *
 *   1. `SELECT … FROM users … FOR UPDATE` — the lock every mutation for this
 *      user queues on, including a first grant, when there is no entitlement
 *      row yet to lock;
 *   2. read the entitlement as it is now;
 *   3. `planMutation` decides, against that row;
 *   4. upsert the entitlement and append the event, or write nothing.
 *
 * So two operators granting and revoking one student at once are applied one
 * after the other, each against what the other left, and each change has its
 * event or neither exists.
 */
import {
  AccessError,
  PLATFORM_SCOPE,
  planMutation,
  snapshot,
  type AccessEvent,
  type AccessStore,
  type AccountAccess,
  type Entitlement,
  type EntitlementSnapshot,
  type MutationInput,
  type MutationResult,
} from './entitlements.js';

export interface AccessSqlExecutor {
  query<R>(text: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
}

export interface AccessDatabase extends AccessSqlExecutor {
  transaction<T>(work: (tx: AccessSqlExecutor) => Promise<T>): Promise<T>;
}

interface EntitlementRow {
  user_id: string;
  scope: string;
  status: Entitlement['status'];
  starts_at: Date;
  expires_at: Date | null;
  granted_via: Entitlement['grantedVia'];
  created_at: Date;
  updated_at: Date;
}

/** How each action is stored: past tense (see migration 006). */
const STORED_ACTION: Record<AccessEvent['action'], string> = {
  GRANT: 'GRANTED',
  SUSPEND: 'SUSPENDED',
  RESTORE: 'RESTORED',
  REVOKE: 'REVOKED',
};
const ACTION_FROM_STORED = Object.fromEntries(
  Object.entries(STORED_ACTION).map(([action, stored]) => [stored, action]),
) as Record<string, AccessEvent['action']>;

interface EventRow {
  event_id: string;
  user_id: string;
  scope: string;
  action: string;
  actor: string;
  reason: string;
  before_status: Entitlement['status'] | null;
  before_starts_at: Date | null;
  before_expires_at: Date | null;
  after_status: Entitlement['status'];
  after_starts_at: Date;
  after_expires_at: Date | null;
  occurred_at: Date;
}

interface AccountRow {
  user_id: string;
  issuer: string;
  email: string | null;
  display_name: string | null;
  role: string;
  created_at: Date;
  e_status: Entitlement['status'] | null;
  e_starts_at: Date | null;
  e_expires_at: Date | null;
  e_granted_via: Entitlement['grantedVia'] | null;
  e_created_at: Date | null;
  e_updated_at: Date | null;
}

/** A non-UUID id names no row here; asking PostgreSQL would only raise a cast error. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const iso = (value: Date | string): string => new Date(value).toISOString();
const isoOrNull = (value: Date | string | null): string | null => (value === null ? null : iso(value));

function toEntitlement(row: EntitlementRow): Entitlement {
  return {
    userId: row.user_id,
    scope: PLATFORM_SCOPE,
    status: row.status,
    startsAt: iso(row.starts_at),
    expiresAt: isoOrNull(row.expires_at),
    grantedVia: row.granted_via,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toEvent(row: EventRow): AccessEvent {
  return {
    eventId: String(row.event_id),
    userId: row.user_id,
    scope: PLATFORM_SCOPE,
    action: ACTION_FROM_STORED[row.action]!,
    actor: row.actor,
    reason: row.reason,
    before:
      row.before_status === null
        ? null
        : { status: row.before_status, startsAt: iso(row.before_starts_at!), expiresAt: isoOrNull(row.before_expires_at) },
    after: { status: row.after_status, startsAt: iso(row.after_starts_at), expiresAt: isoOrNull(row.after_expires_at) },
    occurredAt: iso(row.occurred_at),
  };
}

function toAccount(row: AccountRow): AccountAccess {
  return {
    userId: row.user_id,
    issuer: row.issuer,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    createdAt: iso(row.created_at),
    entitlement:
      row.e_status === null
        ? null
        : {
            userId: row.user_id,
            scope: PLATFORM_SCOPE,
            status: row.e_status,
            startsAt: iso(row.e_starts_at!),
            expiresAt: isoOrNull(row.e_expires_at),
            grantedVia: row.e_granted_via!,
            createdAt: iso(row.e_created_at!),
            updatedAt: iso(row.e_updated_at!),
          },
  };
}

const ENTITLEMENT_COLUMNS = 'user_id, scope, status, starts_at, expires_at, granted_via, created_at, updated_at';

const ACCOUNT_SELECT = `
  SELECT u.user_id, u.issuer, u.email, u.display_name, u.role, u.created_at,
         e.status AS e_status, e.starts_at AS e_starts_at, e.expires_at AS e_expires_at,
         e.granted_via AS e_granted_via, e.created_at AS e_created_at, e.updated_at AS e_updated_at
    FROM users u
    LEFT JOIN access_entitlements e ON e.user_id = u.user_id AND e.scope = 'platform'`;

export class PostgresAccessStore implements AccessStore {
  constructor(private readonly db: AccessDatabase) {}

  async get(userId: string): Promise<Entitlement | null> {
    if (!UUID.test(userId)) return null;
    const { rows } = await this.db.query<EntitlementRow>(
      `SELECT ${ENTITLEMENT_COLUMNS} FROM access_entitlements WHERE user_id = $1 AND scope = 'platform'`,
      [userId],
    );
    return rows[0] ? toEntitlement(rows[0]) : null;
  }

  mutate(input: MutationInput, now: () => Date): Promise<MutationResult> {
    if (!UUID.test(input.userId)) {
      return Promise.reject(new AccessError('USER_NOT_FOUND', 'No account has that id.'));
    }
    return this.db.transaction(async (tx) => {
      const user = await tx.query<{ user_id: string }>(
        'SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE',
        [input.userId],
      );
      if (user.rows.length === 0) {
        throw new AccessError('USER_NOT_FOUND', 'No account has that id. The student must sign in once first.');
      }
      const current = await tx.query<EntitlementRow>(
        `SELECT ${ENTITLEMENT_COLUMNS} FROM access_entitlements WHERE user_id = $1 AND scope = 'platform'`,
        [input.userId],
      );
      const before = current.rows[0] ? toEntitlement(current.rows[0]) : null;
      // The clock is read under the lock, so "now" is the moment this change
      // is ordered at, not when the request arrived.
      const at = now().toISOString();
      const plan = planMutation(before, input.action, at, input.grant);
      if (plan.kind === 'unchanged') return { changed: false, before, after: before!, event: null };

      const written = await tx.query<EntitlementRow>(
        `INSERT INTO access_entitlements (user_id, scope, status, starts_at, expires_at, granted_via, created_at, updated_at)
              VALUES ($1, 'platform', $2, $3, $4, 'operator', $5, $5)
         ON CONFLICT (user_id, scope) DO UPDATE
               SET status = EXCLUDED.status,
                   starts_at = EXCLUDED.starts_at,
                   expires_at = EXCLUDED.expires_at,
                   updated_at = EXCLUDED.updated_at
         RETURNING ${ENTITLEMENT_COLUMNS}`,
        [input.userId, plan.next.status, plan.next.startsAt, plan.next.expiresAt, at],
      );
      const prior: EntitlementSnapshot | null = before ? snapshot(before) : null;
      const event = await tx.query<EventRow>(
        `INSERT INTO access_events (user_id, scope, action, actor, reason,
                                    before_status, before_starts_at, before_expires_at,
                                    after_status, after_starts_at, after_expires_at, occurred_at)
              VALUES ($1, 'platform', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          input.userId,
          STORED_ACTION[plan.action],
          input.actor,
          input.reason,
          prior?.status ?? null,
          prior?.startsAt ?? null,
          prior?.expiresAt ?? null,
          plan.next.status,
          plan.next.startsAt,
          plan.next.expiresAt,
          at,
        ],
      );
      return { changed: true, before, after: toEntitlement(written.rows[0]!), event: toEvent(event.rows[0]!) };
    });
  }

  async events(userId: string, limit: number): Promise<AccessEvent[]> {
    if (!UUID.test(userId)) return [];
    const { rows } = await this.db.query<EventRow>(
      'SELECT * FROM access_events WHERE user_id = $1 ORDER BY occurred_at DESC, event_id DESC LIMIT $2',
      [userId, limit],
    );
    return rows.map(toEvent);
  }

  async accounts(limit: number): Promise<AccountAccess[]> {
    const { rows } = await this.db.query<AccountRow>(`${ACCOUNT_SELECT} ORDER BY u.created_at, u.user_id LIMIT $1`, [limit]);
    return rows.map(toAccount);
  }

  async findAccounts(query: { userId?: string; email?: string }): Promise<AccountAccess[]> {
    if (query.userId !== undefined) {
      if (!UUID.test(query.userId)) return [];
      const { rows } = await this.db.query<AccountRow>(`${ACCOUNT_SELECT} WHERE u.user_id = $1`, [query.userId]);
      return rows.map(toAccount);
    }
    if (query.email !== undefined) {
      const { rows } = await this.db.query<AccountRow>(
        `${ACCOUNT_SELECT} WHERE lower(u.email) = lower($1) ORDER BY u.created_at LIMIT 20`,
        [query.email],
      );
      return rows.map(toAccount);
    }
    return [];
  }
}
