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
import { effectiveSessionLimit, PlanCatalog, planIncludesTrack, type Plan } from './plans.js';

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

/**
 * What kind of access a grant is — a label for people, not a permission.
 * What the holder may *use* is the plan (`plans.ts`); what the kind changes is
 * only how the grant is described, and one rule: a trial is started once per
 * account, through `access trial`, for the configured length.
 *
 *   STANDARD  ordinary access (the only kind before kinds existed)
 *   BETA      a private-beta participant
 *   TRIAL     a time-limited trial
 */
export const GRANT_KINDS = ['STANDARD', 'BETA', 'TRIAL'] as const;
export type GrantKind = (typeof GRANT_KINDS)[number];

export interface Entitlement {
  userId: string;
  scope: AccessScope;
  status: EntitlementStatus;
  /** ISO 8601, UTC. */
  startsAt: string;
  /** ISO 8601, UTC; null = no end date, and only ever set on purpose. */
  expiresAt: string | null;
  grantedVia: GrantedVia;
  kind: GrantKind;
  /** A plan id from `ACCESS_PLANS_FILE`; null = no plan (every track, the deployment's limits). */
  planId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * `TRIAL` starts a trial: a grant of kind TRIAL whose window the configured
 * length decides, allowed once per account. It is recorded as a grant.
 */
export const ACCESS_ACTIONS = ['GRANT', 'TRIAL', 'SUSPEND', 'RESTORE', 'REVOKE'] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

export interface EntitlementSnapshot {
  status: EntitlementStatus;
  startsAt: string;
  expiresAt: string | null;
  kind: GrantKind;
  planId: string | null;
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
      | 'INVALID_KIND'
      | 'INVALID_PLAN'
      | 'TRIALS_DISABLED'
      | 'TRIAL_ALREADY_USED'
      | 'ALREADY_ACTIVE'
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
  /** Omitted: the current row's kind, or STANDARD for a first grant. */
  kind?: GrantKind;
  /** Omitted: the current row's plan. null: no plan. */
  planId?: string | null;
}

/** A trial's terms, from configuration (`TRIAL_DURATION_DAYS`, `TRIAL_PLAN`). */
export interface TrialRequest {
  durationDays: number;
  planId: string | null;
}

/** Facts about the account a mutation is planned against, read under the same lock. */
export interface MutationContext {
  /** Whether this account has ever been on a trial. */
  hadTrial: boolean;
}

export function assertKind(value: unknown): GrantKind {
  const raw = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!(GRANT_KINDS as readonly string[]).includes(raw)) {
    throw new AccessError('INVALID_KIND', `--kind is one of ${GRANT_KINDS.map((k) => k.toLowerCase()).join(', ')}.`);
  }
  return raw as GrantKind;
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
  trial?: TrialRequest,
  context: MutationContext = { hadTrial: false },
): MutationPlan {
  switch (action) {
    case 'TRIAL': {
      if (!trial) throw new AccessError('TRIALS_DISABLED', 'Trials are off: TRIAL_DURATION_DAYS is not set.');
      if (current?.status === 'SUSPENDED') {
        throw new AccessError(
          'ENTITLEMENT_SUSPENDED',
          'This access is suspended. `access restore` lifts the suspension; a trial does not override it.',
        );
      }
      // Once per account, ever: a trial that could be started again would be
      // an unlimited free plan with extra steps.
      if (context.hadTrial) {
        throw new AccessError('TRIAL_ALREADY_USED', 'This account has already had a trial. A grant is the way to give more access.');
      }
      if (evaluateAccess(current, Date.parse(nowIso)).active) {
        throw new AccessError(
          'ALREADY_ACTIVE',
          'This account already has active access; a trial would replace it. Nothing was changed.',
        );
      }
      const expiresAt = new Date(Date.parse(nowIso) + trial.durationDays * 86_400_000).toISOString();
      return {
        kind: 'write',
        action,
        next: { status: 'ACTIVE', startsAt: nowIso, expiresAt, kind: 'TRIAL', planId: trial.planId },
      };
    }
    case 'GRANT': {
      if (!grant) throw new AccessError('EXPIRY_REQUIRED', 'A grant needs --until <instant> or --no-expiry.');
      if (current?.status === 'SUSPENDED') {
        throw new AccessError(
          'ENTITLEMENT_SUSPENDED',
          'This access is suspended. `access restore` lifts the suspension; a grant does not override it.',
        );
      }
      /*
       * A trial is started by `access trial` — once, for the configured
       * length — and a grant may only ever *change* an existing one, by saying
       * --kind trial on purpose. Otherwise a grant would be a second way to
       * start trials without either rule. A grant on a trial that does not
       * name a kind is refused rather than guessed: extending the trial and
       * converting it are different decisions.
       */
      // A revoked trial is over: re-granting it as a trial would be a second trial.
      if (grant.kind === 'TRIAL' && (current?.kind !== 'TRIAL' || current.status === 'REVOKED')) {
        throw new AccessError('INVALID_KIND', 'Start a trial with `access trial`; --kind trial only changes an existing trial.');
      }
      if (grant.kind === undefined && current?.kind === 'TRIAL' && current.status !== 'REVOKED') {
        throw new AccessError(
          'INVALID_KIND',
          'This account is on a trial. Say --kind standard or --kind beta to convert it, or --kind trial to change the trial itself.',
        );
      }
      const kind: GrantKind = grant.kind ?? (current && current.status !== 'REVOKED' ? current.kind : 'STANDARD');
      const planId = grant.planId !== undefined ? grant.planId : (current?.planId ?? null);
      const keepStart = current?.status === 'ACTIVE' && grant.startsAt === undefined;
      const startsAt = grant.startsAt ?? (keepStart ? current.startsAt : nowIso);
      if (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= Date.parse(startsAt)) {
        throw new AccessError('INVALID_WINDOW', `The access window must end after it starts (${startsAt}).`);
      }
      // A grant that is over before it is written is a typo, not a decision.
      if (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= Date.parse(nowIso)) {
        throw new AccessError('INVALID_WINDOW', `--until is in the past (now ${nowIso}).`);
      }
      const next: EntitlementSnapshot = { status: 'ACTIVE', startsAt, expiresAt: grant.expiresAt, kind, planId };
      if (
        current &&
        current.status === 'ACTIVE' &&
        current.startsAt === next.startsAt &&
        current.expiresAt === next.expiresAt &&
        current.kind === next.kind &&
        current.planId === next.planId
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
  return {
    status: entitlement.status,
    startsAt: entitlement.startsAt,
    expiresAt: entitlement.expiresAt,
    kind: entitlement.kind,
    planId: entitlement.planId,
  };
}

export interface MutationInput {
  userId: string;
  action: AccessAction;
  actor: string;
  reason: string;
  grant?: GrantRequest;
  /** For TRIAL: the configured terms. */
  trial?: TrialRequest;
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
      const hadTrial = this.#events.some((event) => event.userId === input.userId && event.after.kind === 'TRIAL');
      const plan = planMutation(before, input.action, at, input.grant, input.trial, { hadTrial });
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

/** Why an ACTIVE entitlement still does not cover this lab. */
export type PlanRefusal = 'LAB_NOT_IN_PLAN' | 'PLAN_UNAVAILABLE';

export type AccessDecision =
  | {
      allowed: true;
      via: 'open' | 'entitlement';
      /** The plan the access is on; null for no plan, and always null under `open`. */
      plan: Plan | null;
      /** Labs this holder may run at once; undefined = the session manager's own limit. */
      sessionLimit: number | undefined;
    }
  | { allowed: false; state: Exclude<AccessState, 'ACTIVE'> }
  | { allowed: false; state: 'ACTIVE'; refusal: PlanRefusal; planId: string; track?: string };

/** What the lab-use check knows about the lab, when there is one. */
export interface LabContext {
  /** The lab's track, which a plan may or may not include. */
  track?: string;
  /** Or the lab's id, for a route that knows only the session's lab: resolved with `trackOfLab`. */
  labId?: string;
}

export interface AccessControlOptions {
  /** Plans from `ACCESS_PLANS_FILE`. Absent: none. */
  plans?: PlanCatalog;
  /** `MAX_ACTIVE_SESSIONS_PER_STUDENT`, which a plan may lower but never raise. */
  deploymentSessionLimit?: number;
  /** Where a plan referring to a plan no longer configured is reported. */
  onUnknownPlan?: (planId: string) => void;
  /** The lab catalog's answer to "which track is this lab in?". */
  trackOfLab?: (labId: string) => string | undefined;
}

/** The question every lab-use route asks, answered in one place. */
export class AccessControl {
  readonly plans: PlanCatalog;
  readonly #deploymentSessionLimit: number | undefined;
  readonly #onUnknownPlan: (planId: string) => void;
  readonly #trackOfLab: (labId: string) => string | undefined;

  constructor(
    private readonly store: AccessStore,
    readonly policy: AccessPolicy,
    private readonly now: () => Date = () => new Date(),
    options: AccessControlOptions = {},
  ) {
    this.plans = options.plans ?? new PlanCatalog();
    this.#deploymentSessionLimit = options.deploymentSessionLimit;
    this.#onUnknownPlan = options.onUnknownPlan ?? (() => {});
    this.#trackOfLab = options.trackOfLab ?? (() => undefined);
  }

  /**
   * May this account use labs right now — and, given the lab, this lab?
   *
   * Under `open` no store is read and no plan applies. Under `entitlement` a
   * store that cannot be read throws, and the route's error handler answers
   * 500: access that cannot be checked is not granted.
   *
   * An entitlement on a plan the configuration no longer defines is refused
   * (`PLAN_UNAVAILABLE`), not treated as "no plan": no plan means every track,
   * and removing a plan from the file must never widen what its holders get.
   */
  async decide(userId: string, lab: LabContext = {}): Promise<AccessDecision> {
    if (this.policy === 'open') {
      return { allowed: true, via: 'open', plan: null, sessionLimit: this.#deploymentSessionLimit };
    }
    const entitlement = await this.store.get(userId);
    const evaluation = evaluateAccess(entitlement, this.now().getTime());
    if (!evaluation.active) return { allowed: false, state: evaluation.state as Exclude<AccessState, 'ACTIVE'> };

    let plan: Plan | null = null;
    if (entitlement!.planId !== null) {
      const found = this.plans.get(entitlement!.planId);
      if (!found) {
        this.#onUnknownPlan(entitlement!.planId);
        return { allowed: false, state: 'ACTIVE', refusal: 'PLAN_UNAVAILABLE', planId: entitlement!.planId };
      }
      plan = found;
    }
    const track = lab.track ?? (lab.labId !== undefined ? this.#trackOfLab(lab.labId) : undefined);
    if (track !== undefined && !planIncludesTrack(plan, track)) {
      return { allowed: false, state: 'ACTIVE', refusal: 'LAB_NOT_IN_PLAN', planId: plan!.id, track };
    }
    return {
      allowed: true,
      via: 'entitlement',
      plan,
      sessionLimit: effectiveSessionLimit(this.#deploymentSessionLimit, plan),
    };
  }

  /** The student's own view: their state, window and plan, nothing an operator wrote. */
  async describe(userId: string): Promise<AccessDescription> {
    const entitlement = await this.store.get(userId);
    const evaluation = evaluateAccess(entitlement, this.now().getTime());
    const open = this.policy === 'open';
    const plan = !open && entitlement?.planId ? (this.plans.get(entitlement.planId) ?? null) : null;
    return {
      policy: this.policy,
      state: evaluation.state,
      active: open ? true : evaluation.active,
      startsAt: entitlement?.startsAt ?? null,
      expiresAt: entitlement?.expiresAt ?? null,
      kind: entitlement?.kind ?? null,
      plan: plan ? planView(plan) : null,
      maxConcurrentSessions:
        (open ? this.#deploymentSessionLimit : effectiveSessionLimit(this.#deploymentSessionLimit, plan)) ?? null,
    };
  }
}

export interface AccessDescription {
  policy: AccessPolicy;
  state: AccessState;
  active: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  /** STANDARD, BETA or TRIAL; null without an entitlement. */
  kind: GrantKind | null;
  /** The plan, as the student may see it. Null: no plan (every track), or the `open` policy. */
  plan: { id: string; name: string; description: string | null; tracks: 'all' | string[] } | null;
  /** Labs they may run at once, after any plan; null = no per-student limit. */
  maxConcurrentSessions: number | null;
}

function planView(plan: Plan): NonNullable<AccessDescription['plan']> {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    tracks: plan.tracks === 'all' ? 'all' : [...plan.tracks],
  };
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

/** The refusal for any denied decision: not active, or active but not for this lab. */
export function accessRefusalBody(decision: Extract<AccessDecision, { allowed: false }>) {
  if (!('refusal' in decision)) return accessDeniedBody(decision.state);
  if (decision.refusal === 'LAB_NOT_IN_PLAN') {
    return {
      code: 'LAB_NOT_IN_PLAN',
      message: `Your plan does not include the ${decision.track} track.`,
      details: { track: decision.track, planId: decision.planId },
    };
  }
  return {
    code: 'ACCESS_PLAN_UNAVAILABLE',
    message: 'Your lab access could not be confirmed. Please contact support.',
    details: { planId: decision.planId },
  };
}

/** The audit/log word for a denial: the access state, or why an active plan did not cover the lab. */
export function refusalState(decision: Extract<AccessDecision, { allowed: false }>): string {
  return 'refusal' in decision ? decision.refusal : decision.state;
}

const ACCESS_DENIED_MESSAGES: Record<Exclude<AccessState, 'ACTIVE'>, string> = {
  NONE: 'Your account does not have lab access yet.',
  SCHEDULED: 'Your lab access has not started yet.',
  EXPIRED: 'Your lab access has ended.',
  SUSPENDED: 'Your lab access is paused.',
  REVOKED: 'Your account no longer has lab access.',
};
