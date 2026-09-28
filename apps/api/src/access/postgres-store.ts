/**
 * Entitlements in PostgreSQL — migrations 006, 009 and 010.
 *
 * Every write goes through `mutate` (or `mutateWithin`, for a caller that
 * already holds a transaction — the billing webhook), which runs:
 *
 *   1. `SELECT … FROM users … FOR UPDATE` — the lock every mutation for this
 *      user queues on, including a first grant, when there is no entitlement
 *      row yet to lock;
 *   2. read every entitlement row the account has (one per source);
 *   3. `planAccountMutation` decides, against those rows;
 *   4. upsert each changed row and append its event, or write nothing.
 *
 * So two operators — or an operator and a billing event — changing one
 * student at once are applied one after the other, each against what the other
 * left, and each change has its event or neither exists.
 */
import {
  AccessError,
  PLATFORM_SCOPE,
  planAccountMutation,
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
  kind: Entitlement['kind'];
  plan_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * How each action is stored: past tense (see migration 006). A trial is
 * recorded as what it is — a grant, whose `after_kind` is TRIAL — so the
 * stored vocabulary needs no new word. A billing change is SYNCED.
 */
const STORED_ACTION: Record<AccessEvent['action'], string> = {
  GRANT: 'GRANTED',
  TRIAL: 'GRANTED',
  SUSPEND: 'SUSPENDED',
  RESTORE: 'RESTORED',
  REVOKE: 'REVOKED',
  SYNC: 'SYNCED',
};
const ACTION_FROM_STORED: Record<string, AccessEvent['action']> = {
  GRANTED: 'GRANT',
  SUSPENDED: 'SUSPEND',
  RESTORED: 'RESTORE',
  REVOKED: 'REVOKE',
  SYNCED: 'SYNC',
};

interface EventRow {
  event_id: string;
  user_id: string;
  scope: string;
  source: Entitlement['grantedVia'];
  action: string;
  actor: string;
  reason: string;
  before_status: Entitlement['status'] | null;
  before_starts_at: Date | null;
  before_expires_at: Date | null;
  after_status: Entitlement['status'];
  after_starts_at: Date;
  after_expires_at: Date | null;
  before_kind: Entitlement['kind'] | null;
  before_plan_id: string | null;
  after_kind: Entitlement['kind'];
  after_plan_id: string | null;
  occurred_at: Date;
}

interface UserRow {
  user_id: string;
  issuer: string;
  email: string | null;
  display_name: string | null;
  role: string;
  created_at: Date;
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
    kind: row.kind,
    planId: row.plan_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toEvent(row: EventRow): AccessEvent {
  return {
    eventId: String(row.event_id),
    userId: row.user_id,
    scope: PLATFORM_SCOPE,
    source: row.source,
    action: ACTION_FROM_STORED[row.action]!,
    actor: row.actor,
    reason: row.reason,
    before:
      row.before_status === null
        ? null
        : {
            status: row.before_status,
            startsAt: iso(row.before_starts_at!),
            expiresAt: isoOrNull(row.before_expires_at),
            kind: row.before_kind ?? 'STANDARD',
            planId: row.before_plan_id,
          },
    after: {
      status: row.after_status,
      startsAt: iso(row.after_starts_at),
      expiresAt: isoOrNull(row.after_expires_at),
      kind: row.after_kind,
      planId: row.after_plan_id,
    },
    occurredAt: iso(row.occurred_at),
  };
}

function toAccount(row: UserRow, grants: Entitlement[]): AccountAccess {
  return {
    userId: row.user_id,
    issuer: row.issuer,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    createdAt: iso(row.created_at),
    entitlement: grants.find((grant) => grant.grantedVia === 'operator') ?? null,
    grants,
  };
}

const ENTITLEMENT_COLUMNS =
  'user_id, scope, status, starts_at, expires_at, granted_via, kind, plan_id, created_at, updated_at';

const USER_COLUMNS = 'u.user_id, u.issuer, u.email, u.display_name, u.role, u.created_at';

export class PostgresAccessStore implements AccessStore {
  constructor(private readonly db: AccessDatabase) {}

  async get(userId: string): Promise<Entitlement | null> {
    return (await this.grants(userId)).find((grant) => grant.grantedVia === 'operator') ?? null;
  }

  async grants(userId: string): Promise<Entitlement[]> {
    if (!UUID.test(userId)) return [];
    const { rows } = await this.db.query<EntitlementRow>(
      `SELECT ${ENTITLEMENT_COLUMNS} FROM access_entitlements WHERE user_id = $1 AND scope = 'platform' ORDER BY granted_via`,
      [userId],
    );
    return rows.map(toEntitlement);
  }

  mutate(input: MutationInput, now: () => Date): Promise<MutationResult> {
    if (!UUID.test(input.userId)) {
      return Promise.reject(new AccessError('USER_NOT_FOUND', 'No account has that id.'));
    }
    return this.db.transaction((tx) => this.mutateWithin(tx, input, now));
  }

  /**
   * `mutate`, inside a transaction the caller owns — so a billing event's
   * bookkeeping and the entitlement change it causes commit, or roll back,
   * together.
   */
  async mutateWithin(tx: AccessSqlExecutor, input: MutationInput, now: () => Date): Promise<MutationResult> {
    if (!UUID.test(input.userId)) throw new AccessError('USER_NOT_FOUND', 'No account has that id.');
    const user = await tx.query<{ user_id: string }>('SELECT user_id FROM users WHERE user_id = $1 FOR UPDATE', [
      input.userId,
    ]);
    if (user.rows.length === 0) {
      throw new AccessError('USER_NOT_FOUND', 'No account has that id. The student must sign in once first.');
    }
    const current = await tx.query<EntitlementRow>(
      `SELECT ${ENTITLEMENT_COLUMNS} FROM access_entitlements WHERE user_id = $1 AND scope = 'platform' ORDER BY granted_via`,
      [input.userId],
    );
    const rows = current.rows.map(toEntitlement);
    // Read under the same lock: two trials racing for one account see each other.
    const trial = await tx.query<{ had: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM access_events WHERE user_id = $1 AND after_kind = 'TRIAL') AS had`,
      [input.userId],
    );
    // The clock is read under the lock, so "now" is the moment this change
    // is ordered at, not when the request arrived.
    const at = now().toISOString();
    const changes = planAccountMutation(rows, input, at, { hadTrial: trial.rows[0]?.had === true });
    const source = input.source ?? 'operator';

    const written = new Map(rows.map((row) => [row.grantedVia, row]));
    const events: AccessEvent[] = [];
    for (const change of changes) {
      const upserted = await tx.query<EntitlementRow>(
        `INSERT INTO access_entitlements (user_id, scope, status, starts_at, expires_at, granted_via, kind, plan_id,
                                          created_at, updated_at)
              VALUES ($1, 'platform', $2, $3, $4, $5, $6, $7, $8, $8)
         ON CONFLICT (user_id, scope, granted_via) DO UPDATE
               SET status = EXCLUDED.status,
                   starts_at = EXCLUDED.starts_at,
                   expires_at = EXCLUDED.expires_at,
                   kind = EXCLUDED.kind,
                   plan_id = EXCLUDED.plan_id,
                   updated_at = EXCLUDED.updated_at
         RETURNING ${ENTITLEMENT_COLUMNS}`,
        [
          input.userId,
          change.next.status,
          change.next.startsAt,
          change.next.expiresAt,
          change.source,
          change.next.kind,
          change.next.planId,
          at,
        ],
      );
      written.set(change.source, toEntitlement(upserted.rows[0]!));
      const prior: EntitlementSnapshot | null = change.before ? snapshot(change.before) : null;
      const event = await tx.query<EventRow>(
        `INSERT INTO access_events (user_id, scope, source, action, actor, reason,
                                    before_status, before_starts_at, before_expires_at, before_kind, before_plan_id,
                                    after_status, after_starts_at, after_expires_at, after_kind, after_plan_id,
                                    occurred_at)
              VALUES ($1, 'platform', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING *`,
        [
          input.userId,
          change.source,
          STORED_ACTION[change.action],
          input.actor,
          input.reason,
          prior?.status ?? null,
          prior?.startsAt ?? null,
          prior?.expiresAt ?? null,
          prior?.kind ?? null,
          prior?.planId ?? null,
          change.next.status,
          change.next.startsAt,
          change.next.expiresAt,
          change.next.kind,
          change.next.planId,
          at,
        ],
      );
      events.push(toEvent(event.rows[0]!));
    }
    const grants = [...written.values()].sort((a, b) => a.grantedVia.localeCompare(b.grantedVia));
    return {
      changed: changes.length > 0,
      before: rows.find((row) => row.grantedVia === source) ?? null,
      after: written.get(source) ?? null,
      event: events[0] ?? null,
      events,
      grants,
    };
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
    const { rows } = await this.db.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users u ORDER BY u.created_at, u.user_id LIMIT $1`,
      [limit],
    );
    return this.#withGrants(rows);
  }

  async findAccounts(query: { userId?: string; email?: string }): Promise<AccountAccess[]> {
    if (query.userId !== undefined) {
      if (!UUID.test(query.userId)) return [];
      const { rows } = await this.db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users u WHERE u.user_id = $1`, [
        query.userId,
      ]);
      return this.#withGrants(rows);
    }
    if (query.email !== undefined) {
      const { rows } = await this.db.query<UserRow>(
        `SELECT ${USER_COLUMNS} FROM users u WHERE lower(u.email) = lower($1) ORDER BY u.created_at LIMIT 20`,
        [query.email],
      );
      return this.#withGrants(rows);
    }
    return [];
  }

  /** Every row of these accounts, in one query rather than one per account. */
  async #withGrants(users: UserRow[]): Promise<AccountAccess[]> {
    if (users.length === 0) return [];
    const { rows } = await this.db.query<EntitlementRow>(
      `SELECT ${ENTITLEMENT_COLUMNS} FROM access_entitlements
        WHERE scope = 'platform' AND user_id = ANY($1::uuid[]) ORDER BY granted_via`,
      [users.map((user) => user.user_id)],
    );
    const byUser = new Map<string, Entitlement[]>();
    for (const row of rows) {
      const list = byUser.get(row.user_id) ?? [];
      list.push(toEntitlement(row));
      byUser.set(row.user_id, list);
    }
    return users.map((user) => toAccount(user, byUser.get(user.user_id) ?? []));
  }
}
