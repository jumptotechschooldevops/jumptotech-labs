/**
 * Lab access — who may *use* labs, as opposed to who has signed in.
 *
 * Before this, "has an account" meant "may launch labs": any identity the
 * configured OIDC issuer authenticated was provisioned as STUDENT on first
 * sign-in and could start, attach, verify and reset labs until the platform
 * stopped. There was no way to grant access to a paying student, to withhold it
 * from somebody who merely has an account at the issuer, to let it lapse, or to
 * take it away without deleting the person. See
 * docs/commercial-access.md for the full model.
 *
 * ```text
 *   identity        users (issuer, subject)          who someone is
 *   authentication  auth_sessions / bearer token     that they proved it
 *   role            users.role                       what staff powers they hold
 *   entitlement     access_entitlements  (this)      whether they may use labs, and until when
 *   lab session     lab_sessions                     what they are running now
 *   progress        lab_attempts / lab_progress      what they have done
 * ```
 *
 * Each row is independent of the others. Revoking an entitlement deletes
 * nothing: the account, its sign-in, its sessions' history and its progress are
 * untouched, and a later grant restores exactly the same person.
 *
 * ## What an entitlement is
 *
 * One row per (user, scope). The only scope today is `platform` — every lab —
 * because the product has no course, cohort or per-track sale to model; the
 * column exists so a narrower scope is a migration, not a redesign.
 *
 * The stored `status` is what an operator *decided*: ACTIVE, SUSPENDED or
 * REVOKED. Whether the student may use labs at this instant also depends on the
 * window, `[startsAt, expiresAt)`, so the effective *state* is computed, never
 * stored: an entitlement expires by the clock passing `expiresAt`, with no job
 * that has to run for it to take effect.
 *
 * `expiresAt` null means "no end date". It is never a default: a grant must say
 * `--until` or `--no-expiry`, so unlimited access is always a written choice.
 *
 * ## Every change is recorded
 *
 * A mutation and its `access_events` row are written in one transaction, under
 * a lock on the user, so there is no change without a record and no two
 * operators interleaving on one student. The record names the operator the CLI
 * was told (`--by`), their reason, and the before and after of status and
 * window. It never carries a token, a cookie or anything a student typed.
 */

/** What an operator decided. Stored. */
export const ENTITLEMENT_STATUSES = ['ACTIVE', 'SUSPENDED', 'REVOKED'] as const;
export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number];

/**
 * What that decision means right now. Computed from status, window and clock.
 *
 *   NONE       signed in at least once, never granted
 *   SCHEDULED  granted, but the window has not opened yet
 *   ACTIVE     may use labs
 *   EXPIRED    the window closed
 *   SUSPENDED  paused by an operator; restorable with the same window
 *   REVOKED    withdrawn by an operator; only a new grant brings it back
 */
export const ACCESS_STATES = ['NONE', 'SCHEDULED', 'ACTIVE', 'EXPIRED', 'SUSPENDED', 'REVOKED'] as const;
export type AccessState = (typeof ACCESS_STATES)[number];

/** The one scope the product sells today. */
export const PLATFORM_SCOPE = 'platform' as const;
export type AccessScope = typeof PLATFORM_SCOPE;

/**
 * How an entitlement came to exist. Only `operator` today — a person ran the
 * CLI. A payment integration would add its own value (docs/commercial-access.md
 * §9), so a support engineer can always tell a manual grant from a paid one.
 */
export type GrantedVia = 'operator';

export interface Entitlement {
  userId: string;
  scope: AccessScope;
  status: EntitlementStatus;
  /** ISO 8601, UTC. */
  startsAt: string;
  /** ISO 8601, UTC; null = no end date, and only ever set on purpose. */
  expiresAt: string | null;
  grantedVia: GrantedVia;
  createdAt: string;
  updatedAt: string;
}

export const ACCESS_ACTIONS = ['GRANT', 'SUSPEND', 'RESTORE', 'REVOKE'] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

export interface EntitlementSnapshot {
  status: EntitlementStatus;
  startsAt: string;
  expiresAt: string | null;
}

/** One administrative change, as recorded. Append-only. */
export interface AccessEvent {
  eventId: string;
  userId: string;
  scope: AccessScope;
  action: AccessAction;
  /** Who the operator said they were (`--by`). Attribution, not authentication: see §5 of the doc. */
  actor: string;
  reason: string;
  before: EntitlementSnapshot | null;
  after: EntitlementSnapshot;
  occurredAt: string;
}

/** An account and its access, as an operator sees it. */
export interface AccountAccess {
  userId: string;
  issuer: string;
  email: string | null;
  displayName: string | null;
  role: string;
  /** When the account was first provisioned, i.e. the first sign-in. */
  createdAt: string;
  entitlement: Entitlement | null;
}

export interface AccessEvaluation {
  state: AccessState;
  /** True exactly when state is ACTIVE. */
  active: boolean;
}

/**
 * The effective state of an entitlement at `nowMs`.
 *
 * The window is half-open: access begins *at* `startsAt` and has ended *at*
 * `expiresAt`. Suspension and revocation win over the window — a revoked
 * entitlement whose dates have also passed is REVOKED, because that is the
 * decision an operator needs to see.
 */
export function evaluateAccess(entitlement: Entitlement | null, nowMs: number): AccessEvaluation {
  if (!entitlement) return { state: 'NONE', active: false };
  if (entitlement.status === 'REVOKED') return { state: 'REVOKED', active: false };
  if (entitlement.status === 'SUSPENDED') return { state: 'SUSPENDED', active: false };
  if (nowMs < Date.parse(entitlement.startsAt)) return { state: 'SCHEDULED', active: false };
  if (entitlement.expiresAt !== null && nowMs >= Date.parse(entitlement.expiresAt)) {
    return { state: 'EXPIRED', active: false };
  }
  return { state: 'ACTIVE', active: true };
}

// --- input validation ---------------------------------------------------------

export class AccessError extends Error {
  constructor(
    readonly code:
      | 'INVALID_USER_ID'
      | 'INVALID_ACTOR'
      | 'INVALID_REASON'
      | 'INVALID_TIME'
      | 'INVALID_WINDOW'
      | 'EXPIRY_REQUIRED'
      | 'USER_NOT_FOUND'
      | 'NO_ENTITLEMENT'
      | 'ENTITLEMENT_SUSPENDED'
      | 'ENTITLEMENT_REVOKED'
      | 'INVALID_REQUEST',
    message: string,
  ) {
    super(message);
    this.name = 'AccessError';
  }
}

/** Internal user ids: a PostgreSQL UUID, or the in-memory store's `usr-00000001`. */
const USER_ID_SHAPE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|usr-[0-9]{8})$/;

export function assertUserId(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!USER_ID_SHAPE.test(raw)) {
    throw new AccessError('INVALID_USER_ID', 'That is not an internal user id. Find it with `access find <email>`.');
  }
  return raw;
}

/** Who did it: a short handle, never free text that could smuggle a newline into a log. */
const ACTOR_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;

export function assertActor(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!ACTOR_SHAPE.test(raw)) {
    throw new AccessError(
      'INVALID_ACTOR',
      '--by must name the operator: 1–64 letters, digits, dot, dash, underscore, plus or @.',
    );
  }
  return raw;
}

export const MAX_REASON_LENGTH = 500;

export function assertReason(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0 || raw.length > MAX_REASON_LENGTH) {
    throw new AccessError('INVALID_REASON', `--reason is required: 1–${MAX_REASON_LENGTH} characters saying why.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new AccessError('INVALID_REASON', '--reason must be one line of printable text.');
  }
  return raw;
}

/**
 * An instant, as an operator typed it.
 *
 * Only a full ISO 8601 date-time **with an explicit offset** (`Z` or `±hh:mm`)
 * is accepted. `2026-10-01` or `2026-10-01T00:00` would be read in whatever
 * timezone the api container happens to run in, and "access ends on the 1st"
 * would then mean a different moment on every host.
 */
const INSTANT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseInstant(value: unknown, name: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  const ms = INSTANT_SHAPE.test(raw) ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new AccessError(
      'INVALID_TIME',
      `${name} must be an ISO 8601 date-time with an explicit offset, e.g. 2026-12-31T23:59:59Z.`,
    );
  }
  return new Date(ms).toISOString();
}

// --- mutations ------------------------------------------------------------------

export interface GrantRequest {
  /** Omitted: now for a new grant, unchanged for an existing ACTIVE one. */
  startsAt?: string;
  /** Required and explicit: an instant, or null for "no end date". */
  expiresAt: string | null;
}

/** What a mutation decided, before anything is written. */
export type MutationPlan =
  | { kind: 'write'; action: AccessAction; next: EntitlementSnapshot }
  | { kind: 'unchanged'; action: AccessAction };

/**
 * The transition rules, as one pure function over the current row.
 *
 *   grant    NONE | ACTIVE | REVOKED  → ACTIVE with the given window
 *            SUSPENDED                → refused: restore it, or revoke then grant.
 *                                       A grant that silently lifted a
 *                                       suspension would undo somebody else's
 *                                       decision without saying so.
 *   suspend  ACTIVE                   → SUSPENDED, window kept
 *   restore  SUSPENDED                → ACTIVE, window kept
 *   revoke   ACTIVE | SUSPENDED       → REVOKED, window kept for the record
 *
 * Repeating a change that is already in effect is `unchanged` — no write, no
 * event — so a retried command is harmless.
 */
export function planMutation(
  current: Entitlement | null,
  action: AccessAction,
  nowIso: string,
  grant?: GrantRequest,
): MutationPlan {
  switch (action) {
    case 'GRANT': {
      if (!grant) throw new AccessError('EXPIRY_REQUIRED', 'A grant needs --until <instant> or --no-expiry.');
      if (current?.status === 'SUSPENDED') {
        throw new AccessError(
          'ENTITLEMENT_SUSPENDED',
          'This access is suspended. `access restore` lifts the suspension; a grant does not override it.',
        );
      }
      const keepStart = current?.status === 'ACTIVE' && grant.startsAt === undefined;
      const startsAt = grant.startsAt ?? (keepStart ? current.startsAt : nowIso);
      if (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= Date.parse(startsAt)) {
        throw new AccessError('INVALID_WINDOW', `The access window must end after it starts (${startsAt}).`);
      }
      // A grant that is over before it is written is a typo, not a decision.
      if (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= Date.parse(nowIso)) {
        throw new AccessError('INVALID_WINDOW', `--until is in the past (now ${nowIso}).`);
      }
      const next: EntitlementSnapshot = { status: 'ACTIVE', startsAt, expiresAt: grant.expiresAt };
      if (
        current &&
        current.status === 'ACTIVE' &&
        current.startsAt === next.startsAt &&
        current.expiresAt === next.expiresAt
      ) {
        return { kind: 'unchanged', action };
      }
      return { kind: 'write', action, next };
    }
    case 'SUSPEND':
      if (!current) throw new AccessError('NO_ENTITLEMENT', 'There is no access to suspend.');
      if (current.status === 'SUSPENDED') return { kind: 'unchanged', action };
      if (current.status === 'REVOKED') {
        throw new AccessError('ENTITLEMENT_REVOKED', 'This access is already revoked.');
      }
      return { kind: 'write', action, next: { ...snapshot(current), status: 'SUSPENDED' } };
    case 'RESTORE':
      if (!current) throw new AccessError('NO_ENTITLEMENT', 'There is no access to restore.');
      if (current.status === 'ACTIVE') return { kind: 'unchanged', action };
      if (current.status === 'REVOKED') {
        throw new AccessError('ENTITLEMENT_REVOKED', 'Revoked access is not restored; grant it again.');
      }
      return { kind: 'write', action, next: { ...snapshot(current), status: 'ACTIVE' } };
    case 'REVOKE':
      if (!current) throw new AccessError('NO_ENTITLEMENT', 'There is no access to revoke.');
      if (current.status === 'REVOKED') return { kind: 'unchanged', action };
      return { kind: 'write', action, next: { ...snapshot(current), status: 'REVOKED' } };
  }
}

export function snapshot(entitlement: Entitlement): EntitlementSnapshot {
  return { status: entitlement.status, startsAt: entitlement.startsAt, expiresAt: entitlement.expiresAt };
}

export interface MutationInput {
  userId: string;
  action: AccessAction;
  actor: string;
  reason: string;
  grant?: GrantRequest;
}

export interface MutationResult {
  changed: boolean;
  before: Entitlement | null;
  after: Entitlement;
  event: AccessEvent | null;
}

/**
 * Where entitlements live.
 *
 * `mutate` is the only write, and it is atomic with its audit event: the plan
 * is computed against the row as read under the user's lock, so two operators
 * racing on one student are serialised rather than interleaved.
 */
export interface AccessStore {
  get(userId: string): Promise<Entitlement | null>;
  mutate(input: MutationInput, now: () => Date): Promise<MutationResult>;
  events(userId: string, limit: number): Promise<AccessEvent[]>;
  /** Every account, with its entitlement if any. Bounded by `limit`. */
  accounts(limit: number): Promise<AccountAccess[]>;
  /** Accounts matching an exact internal id, or an email (case-insensitive). */
  findAccounts(query: { userId?: string; email?: string }): Promise<AccountAccess[]>;
}

// --- the in-memory store ---------------------------------------------------------

/** What the in-memory store needs to know about accounts. */
export interface AccountDirectory {
  list(): Promise<
    Array<{ userId: string; issuer: string; email?: string; displayName?: string; role: string; createdAt?: string }>
  >;
}

/**
 * For tests and for running without a database. Enforces the same rules as the
 * PostgreSQL store — same transitions, same one-row-per-user, same event per
 * change — because a double more permissive than production proves nothing.
 */
export class InMemoryAccessStore implements AccessStore {
  readonly #rows = new Map<string, Entitlement>();
  readonly #events: AccessEvent[] = [];
  #chain: Promise<unknown> = Promise.resolve();
  #nextEvent = 0;

  constructor(private readonly directory: AccountDirectory) {}

  async get(userId: string): Promise<Entitlement | null> {
    return this.#rows.get(userId) ?? null;
  }

  mutate(input: MutationInput, now: () => Date): Promise<MutationResult> {
    // Serialised, like the row lock the PostgreSQL store takes.
    const run = this.#chain.then(async () => {
      const accounts = await this.directory.list();
      if (!accounts.some((account) => account.userId === input.userId)) {
        throw new AccessError('USER_NOT_FOUND', 'No account has that id. The student must sign in once first.');
      }
      const at = now().toISOString();
      const before = this.#rows.get(input.userId) ?? null;
      const plan = planMutation(before, input.action, at, input.grant);
      if (plan.kind === 'unchanged') return { changed: false, before, after: before!, event: null };
      const after: Entitlement = {
        userId: input.userId,
        scope: PLATFORM_SCOPE,
        ...plan.next,
        grantedVia: 'operator',
        createdAt: before?.createdAt ?? at,
        updatedAt: at,
      };
      this.#rows.set(input.userId, after);
      this.#nextEvent += 1;
      const event: AccessEvent = {
        eventId: String(this.#nextEvent),
        userId: input.userId,
        scope: PLATFORM_SCOPE,
        action: plan.action,
        actor: input.actor,
        reason: input.reason,
        before: before ? snapshot(before) : null,
        after: plan.next,
        occurredAt: at,
      };
      this.#events.push(event);
      return { changed: true, before, after, event };
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async events(userId: string, limit: number): Promise<AccessEvent[]> {
    return this.#events.filter((event) => event.userId === userId).slice(-limit).reverse();
  }

  async accounts(limit: number): Promise<AccountAccess[]> {
    const accounts = await this.directory.list();
    return accounts.slice(0, limit).map((account) => this.#account(account));
  }

  async findAccounts(query: { userId?: string; email?: string }): Promise<AccountAccess[]> {
    const accounts = await this.directory.list();
    return accounts
      .filter((account) =>
        query.userId !== undefined
          ? account.userId === query.userId
          : query.email !== undefined && account.email?.toLowerCase() === query.email.toLowerCase(),
      )
      .map((account) => this.#account(account));
  }

  #account(account: Awaited<ReturnType<AccountDirectory['list']>>[number]): AccountAccess {
    return {
      userId: account.userId,
      issuer: account.issuer,
      email: account.email ?? null,
      displayName: account.displayName ?? null,
      role: account.role,
      createdAt: account.createdAt ?? new Date(0).toISOString(),
      entitlement: this.#rows.get(account.userId) ?? null,
    };
  }
}

// --- enforcement ---------------------------------------------------------------------

/**
 * Whether lab use needs an entitlement on this deployment.
 *
 *   open         every signed-in account may use labs — the behaviour before
 *                this existed, and the default outside production so local
 *                development and the existing suites are unchanged
 *   entitlement  only an account whose entitlement is ACTIVE may; the default
 *                under NODE_ENV=production
 */
export type AccessPolicy = 'open' | 'entitlement';

export type AccessDecision =
  | { allowed: true; via: 'open' | 'entitlement' }
  | { allowed: false; state: Exclude<AccessState, 'ACTIVE'> };

/** The question every lab-use route asks, answered in one place. */
export class AccessControl {
  constructor(
    private readonly store: AccessStore,
    readonly policy: AccessPolicy,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * May this account use labs right now?
   *
   * Under `open` no store is read. Under `entitlement` a store that cannot be
   * read throws, and the route's error handler answers 500: access that cannot
   * be checked is not granted.
   */
  async decide(userId: string): Promise<AccessDecision> {
    if (this.policy === 'open') return { allowed: true, via: 'open' };
    const evaluation = evaluateAccess(await this.store.get(userId), this.now().getTime());
    if (evaluation.active) return { allowed: true, via: 'entitlement' };
    return { allowed: false, state: evaluation.state as Exclude<AccessState, 'ACTIVE'> };
  }

  /** The student's own view: their state and window, nothing an operator wrote. */
  async describe(userId: string): Promise<{
    policy: AccessPolicy;
    state: AccessState;
    active: boolean;
    startsAt: string | null;
    expiresAt: string | null;
  }> {
    const entitlement = await this.store.get(userId);
    const evaluation = evaluateAccess(entitlement, this.now().getTime());
    return {
      policy: this.policy,
      state: evaluation.state,
      active: this.policy === 'open' ? true : evaluation.active,
      startsAt: entitlement?.startsAt ?? null,
      expiresAt: entitlement?.expiresAt ?? null,
    };
  }
}

/** The actions that *use* a lab, and therefore need access. */
export const LAB_USE_ACTIONS = [
  'session:start',
  'session:terminal',
  'session:check',
  'session:reset',
  'session:hint',
  'session:activity',
] as const;

export function requiresLabAccess(action: string): boolean {
  return (LAB_USE_ACTIONS as readonly string[]).includes(action);
}

/** The refusal a student sees. States only — never an operator's reason. */
export function accessDeniedBody(state: Exclude<AccessState, 'ACTIVE'>) {
  return {
    code: 'ACCESS_NOT_ACTIVE',
    message: ACCESS_DENIED_MESSAGES[state],
    details: { accessState: state },
  };
}

const ACCESS_DENIED_MESSAGES: Record<Exclude<AccessState, 'ACTIVE'>, string> = {
  NONE: 'Your account does not have lab access yet.',
  SCHEDULED: 'Your lab access has not started yet.',
  EXPIRED: 'Your lab access has ended.',
  SUSPENDED: 'Your lab access is paused.',
  REVOKED: 'Your account no longer has lab access.',
};
