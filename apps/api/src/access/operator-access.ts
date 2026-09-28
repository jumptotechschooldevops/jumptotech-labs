/**
 * Lab access over the operator socket — docs/commercial-access.md §4.
 *
 * The management surface for entitlements is the operator socket and nothing
 * else: no browser route can grant, change or read anyone's access but the
 * caller's own. The socket is reachable only by `docker exec` into the api
 * container (see `operator.ts` for why that is the trust boundary), so a
 * student — whatever role their `users` row says — has no path to any of this.
 *
 *   GET  /v1/access[?state=<STATE>]          every account and its access
 *   GET  /v1/access/find?email=<address>     accounts with that email
 *   GET  /v1/access/<user-id>                one account: access, why, history, live labs
 *   GET  /v1/access/plans                    the configured plans and trial terms
 *   POST /v1/access/<user-id>/grant          {by, reason, until | noExpiry, from?, kind?, plan? | noPlan?}
 *   POST /v1/access/<user-id>/trial          {by, reason} — the configured length, once per account
 *   POST /v1/access/<user-id>/suspend        {by, reason, endSessions?}
 *   POST /v1/access/<user-id>/restore        {by, reason}
 *   POST /v1/access/<user-id>/revoke         {by, reason, endSessions?}
 *
 * Mutations name a user by internal id only, never by email: an email is
 * descriptive, may be shared by two accounts at two issuers, and is exactly the
 * kind of identifier that grants the wrong person access by accident. `find`
 * turns an email into ids; the operator then picks one.
 */
import type { IncomingMessage } from 'node:http';

import { isTerminalStatus, type SessionManager } from '@jumptotech/lab-orchestrator';
import type { Logger } from '@jumptotech/observability';

import {
  ACCESS_STATES,
  AccessError,
  assertActor,
  assertKind,
  assertReason,
  assertUserId,
  evaluateAccess,
  parseInstant,
  type AccessAction,
  type AccessEvent,
  type AccessPolicy,
  type AccessState,
  type AccessStore,
  type AccountAccess,
  type GrantRequest,
} from './entitlements.js';
import { PLAN_ID_SHAPE, PlanCatalog, type TrialConfig } from './plans.js';

export interface OperatorAccessDeps {
  store: AccessStore;
  policy: AccessPolicy;
  /** Plans a grant may name. Absent: none. */
  plans?: PlanCatalog;
  /** Trial terms. Absent or `durationDays: null`: trials are off. */
  trial?: TrialConfig;
}

/** One account as the operator CLI prints it. */
export interface AccountAccessView {
  userId: string;
  issuer: string;
  email: string | null;
  displayName: string | null;
  role: string;
  firstSignInAt: string;
  state: AccessState;
  /** Whether this account may use labs right now, under this deployment's policy. */
  canUseLabs: boolean;
  entitlement: {
    status: string;
    startsAt: string;
    expiresAt: string | null;
    grantedVia: string;
    kind: string;
    planId: string | null;
    updatedAt: string;
  } | null;
}

export function toAccountView(account: AccountAccess, policy: AccessPolicy, nowMs: number): AccountAccessView {
  const evaluation = evaluateAccess(account.entitlement, nowMs);
  return {
    userId: account.userId,
    issuer: account.issuer,
    email: account.email,
    displayName: account.displayName,
    role: account.role,
    firstSignInAt: account.createdAt,
    state: evaluation.state,
    canUseLabs: policy === 'open' || evaluation.active,
    entitlement: account.entitlement
      ? {
          status: account.entitlement.status,
          startsAt: account.entitlement.startsAt,
          expiresAt: account.entitlement.expiresAt,
          grantedVia: account.entitlement.grantedVia,
          kind: account.entitlement.kind,
          planId: account.entitlement.planId,
          updatedAt: account.entitlement.updatedAt,
        }
      : null,
  };
}

/**
 * Why this account can or cannot use labs, in the operator's terms.
 *
 * The support question — "I paid but I can't start a lab" — answered from the
 * account's side. Platform-side reasons (paused, full, a provider down) are
 * `ops status`; this says which of the two to look at.
 */
export function diagnose(view: AccountAccessView, policy: AccessPolicy, nowIso: string): string[] {
  if (policy === 'open') {
    return [
      'ACCESS_POLICY=open: every signed-in account may use labs, whatever its entitlement says.',
      'If this student cannot start a lab, the reason is not access — run `ops status`.',
    ];
  }
  const e = view.entitlement;
  switch (view.state) {
    case 'NONE':
      return ['Signed in, never granted. `access grant <id> --until <instant>|--no-expiry --by <you> --reason <why>`.'];
    case 'SCHEDULED':
      return [`Granted, but the window opens at ${e!.startsAt} (now ${nowIso}). Grant again with an earlier --from to open it sooner.`];
    case 'EXPIRED':
      return [`Access ended at ${e!.expiresAt} (now ${nowIso}). A new grant with a later --until extends it; history is kept.`];
    case 'SUSPENDED':
      return ['Suspended by an operator. `access restore` lifts it with the same window; see the history for who and why.'];
    case 'REVOKED':
      return ['Revoked by an operator. Only a new grant brings it back; see the history for who and why.'];
    case 'ACTIVE':
      return [
        e!.expiresAt ? `Active until ${e!.expiresAt}.` : 'Active, with no end date.',
        `Kind ${e!.kind}; ${e!.planId ? `plan ${e!.planId} — a lab outside its tracks is refused LAB_NOT_IN_PLAN` : 'no plan — every track'}.`,
        'Access is not the problem: if this student cannot start a lab, run `ops status`, and `ops sessions` for a lab they already hold.',
      ];
  }
}

export type AccessRouteResult = {
  action:
    | 'access_list'
    | 'access_find'
    | 'access_show'
    | 'access_grant'
    | 'access_trial'
    | 'access_plans'
    | 'access_suspend'
    | 'access_restore'
    | 'access_revoke';
  status: number;
  payload: unknown;
  /** Fields for the `ops.operator.request` line. Ids and states only — never a reason, email or name. */
  logFields?: Record<string, string>;
};

/** Which action a `/v1/access…` path names, for the counter — before anything is parsed or read. */
export function accessActionFor(method: string, parts: readonly string[]): AccessRouteResult['action'] | null {
  if (parts.length === 2 && method === 'GET') return 'access_list';
  if (parts.length === 3 && method === 'GET') {
    return parts[2] === 'find' ? 'access_find' : parts[2] === 'plans' ? 'access_plans' : 'access_show';
  }
  if (parts.length === 4 && method === 'POST') {
    const verb = parts[3];
    if (verb === 'grant' || verb === 'trial' || verb === 'suspend' || verb === 'restore' || verb === 'revoke') {
      return `access_${verb}`;
    }
  }
  return null;
}

const MAX_BODY_BYTES = 4096;

/** A small JSON body, or an AccessError. The socket's caller is an operator, but input is still input. */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new AccessError('INVALID_REQUEST', 'The request body is too large.');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AccessError('INVALID_REQUEST', 'The request body is not JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AccessError('INVALID_REQUEST', 'The request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

/** Only the fields each mutation understands; anything else is refused, not ignored. */
function assertOnlyFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new AccessError('INVALID_REQUEST', `Unknown field(s): ${extra.map((key) => key.slice(0, 32)).join(', ')}.`);
  }
}

function grantFrom(body: Record<string, unknown>, plans: PlanCatalog): GrantRequest {
  const noExpiry = body.noExpiry === true;
  const hasUntil = body.until !== undefined && body.until !== null;
  if (noExpiry === hasUntil) {
    throw new AccessError(
      'EXPIRY_REQUIRED',
      'A grant needs exactly one of --until <instant> or --no-expiry: unlimited access is never a default.',
    );
  }
  if (body.plan !== undefined && body.noPlan === true) {
    throw new AccessError('INVALID_PLAN', 'Give --plan <id> or --no-plan, not both.');
  }
  let planId: string | null | undefined;
  if (body.noPlan === true) {
    planId = null;
  } else if (body.plan !== undefined) {
    const raw = typeof body.plan === 'string' ? body.plan.trim() : '';
    // Refused unless it is configured now: a grant on a plan nobody defined
    // would be refused at every lab use, which is a support ticket, not access.
    if (!PLAN_ID_SHAPE.test(raw) || !plans.get(raw)) {
      const known = plans.list().map((plan) => plan.id);
      throw new AccessError(
        'INVALID_PLAN',
        known.length > 0
          ? `--plan must be one of: ${known.join(', ')} (ACCESS_PLANS_FILE).`
          : 'No plans are configured (ACCESS_PLANS_FILE is unset); grant without --plan.',
      );
    }
    planId = raw;
  }
  return {
    ...(body.from !== undefined ? { startsAt: parseInstant(body.from, '--from') } : {}),
    expiresAt: noExpiry ? null : parseInstant(body.until, '--until'),
    ...(body.kind !== undefined ? { kind: assertKind(body.kind) } : {}),
    ...(planId !== undefined ? { planId } : {}),
  };
}

/** What `access plans` prints: the plans an operator may name, and whether trials are on. */
function plansPayload(plans: PlanCatalog, trial: TrialConfig | undefined) {
  return {
    plans: plans.list().map((plan) => ({
      id: plan.id,
      name: plan.name,
      tracks: plan.tracks === 'all' ? 'all' : [...plan.tracks],
      maxConcurrentSessions: plan.maxConcurrentSessions,
    })),
    trial: trial?.durationDays
      ? { enabled: true, durationDays: trial.durationDays, planId: trial.planId }
      : { enabled: false, note: 'TRIAL_DURATION_DAYS is not set; the trial length is a business decision.' },
  };
}

function eventView(event: AccessEvent) {
  return {
    at: event.occurredAt,
    action: event.action,
    by: event.actor,
    reason: event.reason,
    before: event.before,
    after: event.after,
  };
}

/**
 * Serve one `/v1/access…` request. Throws `AccessError` for a refusal the
 * caller maps to 4xx; anything else is a failure. `null`: no such endpoint.
 */
export async function handleAccessRequest(
  deps: OperatorAccessDeps & { sessions: SessionManager; logger: Logger; now: () => number },
  req: IncomingMessage,
  url: URL,
): Promise<AccessRouteResult | null> {
  const method = req.method ?? 'GET';
  const parts = url.pathname.split('/').filter(Boolean); // ['v1', 'access', …]
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();

  if (parts.length === 2 && method === 'GET') {
    const wanted = url.searchParams.get('state');
    if (wanted !== null && !(ACCESS_STATES as readonly string[]).includes(wanted)) {
      throw new AccessError('INVALID_REQUEST', `state is one of ${ACCESS_STATES.join(', ')}.`);
    }
    const accounts = (await deps.store.accounts(1000)).map((account) => toAccountView(account, deps.policy, nowMs));
    const filtered = wanted ? accounts.filter((account) => account.state === wanted) : accounts;
    return {
      action: 'access_list',
      status: 200,
      payload: { policy: deps.policy, count: filtered.length, accounts: filtered },
    };
  }

  if (parts.length === 3 && parts[2] === 'find' && method === 'GET') {
    const email = (url.searchParams.get('email') ?? '').trim();
    if (email.length < 3 || email.length > 254 || !email.includes('@')) {
      throw new AccessError('INVALID_REQUEST', 'find needs --email <address>.');
    }
    const accounts = (await deps.store.findAccounts({ email })).map((account) =>
      toAccountView(account, deps.policy, nowMs),
    );
    return { action: 'access_find', status: 200, payload: { policy: deps.policy, count: accounts.length, accounts } };
  }

  if (parts.length === 3 && parts[2] === 'plans' && method === 'GET') {
    return { action: 'access_plans', status: 200, payload: plansPayload(deps.plans ?? new PlanCatalog(), deps.trial) };
  }

  if (parts.length === 3 && method === 'GET') {
    const userId = assertUserId(decodeSegment(parts[2]));
    const [account] = await deps.store.findAccounts({ userId });
    if (!account) throw new AccessError('USER_NOT_FOUND', 'No account has that id. The student must sign in once first.');
    const view = toAccountView(account, deps.policy, nowMs);
    const history = (await deps.store.events(userId, 20)).map(eventView);
    const liveSessions = (await deps.sessions.listOccupying())
      .filter((session) => session.ownerUserId === userId)
      .map((session) => ({ sessionId: session.sessionId, labId: session.labId, status: session.status }));
    return {
      action: 'access_show',
      status: 200,
      payload: {
        policy: deps.policy,
        account: view,
        diagnosis: diagnose(view, deps.policy, nowIso),
        liveSessions,
        history,
      },
      logFields: { userId },
    };
  }

  if (parts.length === 4 && method === 'POST') {
    const userId = assertUserId(decodeSegment(parts[2]));
    const verb = parts[3];
    const action: AccessAction | null =
      verb === 'grant'
        ? 'GRANT'
        : verb === 'trial'
          ? 'TRIAL'
          : verb === 'suspend'
            ? 'SUSPEND'
            : verb === 'restore'
              ? 'RESTORE'
              : verb === 'revoke'
                ? 'REVOKE'
                : null;
    if (!action) return null;
    const body = await readJsonBody(req);
    const endable = action === 'SUSPEND' || action === 'REVOKE';
    assertOnlyFields(body, [
      'by',
      'reason',
      ...(action === 'GRANT' ? ['until', 'noExpiry', 'from', 'kind', 'plan', 'noPlan'] : []),
      ...(endable ? ['endSessions'] : []),
    ]);
    const actor = assertActor(body.by);
    const reason = assertReason(body.reason);
    const grant = action === 'GRANT' ? grantFrom(body, deps.plans ?? new PlanCatalog()) : undefined;
    let trial: { durationDays: number; planId: string | null } | undefined;
    if (action === 'TRIAL') {
      if (!deps.trial?.durationDays) {
        throw new AccessError(
          'TRIALS_DISABLED',
          'Trials are off: TRIAL_DURATION_DAYS is not set. How long a trial lasts is a business decision.',
        );
      }
      trial = { durationDays: deps.trial.durationDays, planId: deps.trial.planId };
    }

    const result = await deps.store.mutate(
      { userId, action, actor, reason, ...(grant ? { grant } : {}), ...(trial ? { trial } : {}) },
      () => new Date(deps.now()),
    );
    const state = evaluateAccess(result.after, deps.now()).state;
    deps.logger.info(
      'ops.operator.access_changed',
      { userId, action: action.toLowerCase(), outcome: result.changed ? 'changed' : 'unchanged', accessState: state },
      result.changed
        ? `operator ${action.toLowerCase()} of lab access for user ${userId}: now ${state}`
        : `operator ${action.toLowerCase()} of lab access for user ${userId}: already in effect, nothing written`,
    );

    // Ending the student's running labs is a separate, explicit choice: an
    // operator suspending access by mistake must not also have destroyed work.
    const ended: Array<{ sessionId: string; labId: string; after: string }> = [];
    const stillRunning: Array<{ sessionId: string; labId: string; status: string }> = [];
    const live = (await deps.sessions.listOccupying()).filter((session) => session.ownerUserId === userId);
    for (const session of live) {
      if (endable && body.endSessions === true) {
        const outcome = await deps.sessions.endByOperator(session.sessionId);
        ended.push({ sessionId: session.sessionId, labId: session.labId, after: outcome.session.status });
        deps.logger.info(
          'ops.operator.session_ended',
          {
            sessionId: session.sessionId,
            labId: session.labId,
            provider: session.provider,
            outcome: isTerminalStatus(outcome.session.status) ? 'ended' : 'pending',
            reason: `access ${action.toLowerCase()}`,
          },
          `operator ended session ${session.sessionId} with the ${action.toLowerCase()} of its owner's access`,
        );
      } else {
        stillRunning.push({ sessionId: session.sessionId, labId: session.labId, status: session.status });
      }
    }

    const [account] = await deps.store.findAccounts({ userId });
    return {
      action: `access_${verb}` as AccessRouteResult['action'],
      status: 200,
      payload: {
        changed: result.changed,
        account: account ? toAccountView(account, deps.policy, deps.now()) : null,
        ...(result.event ? { event: eventView(result.event) } : {}),
        ended,
        stillRunning,
        ...(stillRunning.length > 0 && action !== 'GRANT' && action !== 'TRIAL' && action !== 'RESTORE'
          ? {
              note:
                'Running labs are refused from now on (terminal, Check, Reset, hints) but keep their slot until ' +
                'they idle out, or until `ops end <session> --yes`.',
            }
          : {}),
      },
      logFields: { userId },
    };
  }

  return null;
}

function decodeSegment(segment: string | undefined): string {
  try {
    return decodeURIComponent(segment ?? '');
  } catch {
    return '';
  }
}

/** An AccessError as the socket answers it. */
export function accessRefusal(error: unknown): { status: number; code: string; message: string } | null {
  if (!(error instanceof AccessError)) return null;
  const status =
    error.code === 'USER_NOT_FOUND' || error.code === 'NO_ENTITLEMENT'
      ? 404
      : error.code === 'ENTITLEMENT_SUSPENDED' ||
          error.code === 'ENTITLEMENT_REVOKED' ||
          error.code === 'TRIAL_ALREADY_USED' ||
          error.code === 'ALREADY_ACTIVE' ||
          error.code === 'TRIALS_DISABLED'
        ? 409
        : 400;
  return { status, code: error.code, message: error.message };
}
