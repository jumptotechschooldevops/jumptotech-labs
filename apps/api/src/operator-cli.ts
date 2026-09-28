/**
 * The operator CLI — the client half of `operator.ts`.
 *
 * Run inside the api container, where the socket is:
 *
 *   prod exec -T api node /app/node_modules/.bin/tsx apps/api/src/operator-cli.ts status
 *   prod exec -T api node /app/node_modules/.bin/tsx apps/api/src/operator-cli.ts sessions [--recent]
 *   prod exec -T api node /app/node_modules/.bin/tsx apps/api/src/operator-cli.ts session <session-id>
 *   prod exec -T api node /app/node_modules/.bin/tsx apps/api/src/operator-cli.ts end <session-id> --yes
 *   prod exec -T api node /app/node_modules/.bin/tsx apps/api/src/operator-cli.ts access <verb> …
 *   prod exec -T api node /app/node_modules/.bin/tsx apps/api/src/operator-cli.ts role <verb> …
 *   prod exec -T api node /app/node_modules/.bin/tsx apps/api/src/operator-cli.ts sign-out <user-id> --by … --reason …
 *
 * `access` manages lab access (docs/commercial-access.md): list, find, show,
 * grant, suspend, restore, revoke. Every change needs `--by` and `--reason`,
 * and is recorded in `access_events`.
 *
 * (docs/runbooks/private-beta-operations.md §1 defines `ops` for this.)
 * `--json` prints the api's answer as it came. Exit 0 on success, 1 when the
 * api refused or failed, 2 on a usage error, 3 when the socket cannot be
 * reached.
 */
import { request } from 'node:http';

import type { OperatorSessionView, OperatorStatus } from './operator.js';
import type { AccountAccessView } from './access/operator-access.js';

export const USAGE = `usage: operator-cli <command> [--json]

  status                 capacity, launches paused, providers, database, reaper,
                         and whether a new lab can start right now
  sessions [--recent]    sessions holding a slot (--recent: and those that
                         finished within the retention window, with reasons)
  session <id>           one session, in any status
  end <id> --yes         end one student's lab through the platform's own
                         teardown; recorded EXPIRED, "ended by operator"

  Lab access (docs/commercial-access.md). Instants are ISO 8601 with an
  explicit offset, e.g. 2026-12-31T23:59:59Z. <user-id> comes from list/find.

  access list [--state NONE|SCHEDULED|ACTIVE|EXPIRED|SUSPENDED|REVOKED]
  access find --email <address>
  access show <user-id>  access, why, recent history and running labs
  access grant <user-id> (--until <instant> | --no-expiry) [--from <instant>]
               [--kind standard|beta|trial] [--plan <plan-id> | --no-plan]
               --by <operator> --reason <text>
  access trial <user-id> --by <operator> --reason <text>
                         start a trial of TRIAL_DURATION_DAYS, once per account
  access plans           the configured plans (ACCESS_PLANS_FILE) and trial terms

  Billing (docs/billing.md) — only when BILLING_PROVIDER is set.

  billing list           every subscription, newest first, in product terms
  billing show <user-id> one account: customer, subscriptions, billing's row, events
  billing reconcile [--apply --by <operator> --reason <text>]
                         compare stored state with the provider; --apply
                         re-processes what drifted through the webhook path
  access suspend <user-id> --by <operator> --reason <text> [--end-sessions --yes]
  access restore <user-id> --by <operator> --reason <text>
  access revoke  <user-id> --by <operator> --reason <text> [--end-sessions --yes]

  Roles. STUDENT (the default for every sign-in), INSTRUCTOR (reads the
  classroom view at #/classroom) or ADMIN (also ends a student's lab from it).
  A sign-in never changes a role; only this does. <user-id> from access find.

  role show <user-id>
  role set  <user-id> STUDENT|INSTRUCTOR|ADMIN --by <operator> --reason <text>

  Sign-ins (docs/runbooks/identity-and-access.md). Access is unchanged: the
  account may sign in again unless its access is suspended or revoked.

  sign-out <user-id> --by <operator> --reason <text>
                         end every browser sign-in this account holds

The socket path is OPERATOR_SOCKET_PATH, set in the api container by the compose files.`;

export type AccessVerb = 'grant' | 'trial' | 'suspend' | 'restore' | 'revoke';

export type Command =
  | { kind: 'status' }
  | { kind: 'sessions'; recent: boolean }
  | { kind: 'session'; id: string }
  | { kind: 'end'; id: string }
  | { kind: 'access-list'; state?: string }
  | { kind: 'access-find'; email: string }
  | { kind: 'access-show'; userId: string }
  | { kind: 'access-plans' }
  | { kind: 'access-change'; verb: AccessVerb; userId: string; body: Record<string, unknown> }
  | { kind: 'role-show'; userId: string }
  | { kind: 'role-set'; userId: string; body: { role: string; by: string; reason: string } }
  | { kind: 'sign-out'; userId: string; body: { by: string; reason: string } }
  | { kind: 'billing-list' }
  | { kind: 'billing-show'; userId: string }
  | { kind: 'billing-reconcile'; body: Record<string, unknown> };

/** Options that take a value, per access verb. */
const ACCESS_VALUE_OPTIONS: Record<string, readonly string[]> = {
  list: ['--state'],
  find: ['--email'],
  show: [],
  plans: [],
  grant: ['--until', '--from', '--kind', '--plan', '--by', '--reason'],
  trial: ['--by', '--reason'],
  suspend: ['--by', '--reason'],
  restore: ['--by', '--reason'],
  revoke: ['--by', '--reason'],
};
const ACCESS_FLAG_OPTIONS: Record<string, readonly string[]> = {
  list: ['--json'],
  find: ['--json'],
  show: ['--json'],
  plans: ['--json'],
  grant: ['--json', '--no-expiry', '--no-plan'],
  trial: ['--json'],
  suspend: ['--json', '--end-sessions', '--yes'],
  restore: ['--json'],
  revoke: ['--json', '--end-sessions', '--yes'],
};

export function parseAccessArgs(argv: readonly string[]): { command: Command; json: boolean } | { error: string } {
  const [verb, ...rest] = argv;
  if (!verb || !(verb in ACCESS_VALUE_OPTIONS)) {
    return { error: verb ? `unknown access command ${verb}` : 'access needs a command: list, find, show, plans, grant, trial, suspend, restore, revoke' };
  }
  const valued = ACCESS_VALUE_OPTIONS[verb]!;
  const flagged = ACCESS_FLAG_OPTIONS[verb]!;
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const words: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (valued.includes(arg)) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      if (arg in values) return { error: `${arg} given twice` };
      values[arg] = value;
      i += 1;
    } else if (flagged.includes(arg)) {
      flags.add(arg);
    } else if (arg.startsWith('--')) {
      return { error: `unknown option ${arg} for access ${verb}` };
    } else {
      words.push(arg);
    }
  }
  const json = flags.has('--json');
  if (verb === 'list') {
    if (words.length > 0) return { error: 'access list takes no argument' };
    return { command: { kind: 'access-list', ...(values['--state'] ? { state: values['--state'].toUpperCase() } : {}) }, json };
  }
  if (verb === 'find') {
    if (words.length > 0 || !values['--email']) return { error: 'access find needs --email <address>' };
    return { command: { kind: 'access-find', email: values['--email'] }, json };
  }
  if (verb === 'plans') {
    if (words.length > 0) return { error: 'access plans takes no argument' };
    return { command: { kind: 'access-plans' }, json };
  }
  if (words.length !== 1) return { error: `access ${verb} needs exactly one <user-id>` };
  const userId = words[0]!;
  if (verb === 'show') return { command: { kind: 'access-show', userId }, json };

  if (!values['--by']) return { error: `access ${verb} needs --by <operator>: every change records who made it` };
  if (!values['--reason']) return { error: `access ${verb} needs --reason <text>: every change records why` };
  const body: Record<string, unknown> = { by: values['--by'], reason: values['--reason'] };
  if (verb === 'grant') {
    const noExpiry = flags.has('--no-expiry');
    if (noExpiry === (values['--until'] !== undefined)) {
      return { error: 'access grant needs exactly one of --until <instant> or --no-expiry: unlimited access is never a default' };
    }
    if (noExpiry) body.noExpiry = true;
    else body.until = values['--until'];
    if (values['--from'] !== undefined) body.from = values['--from'];
    if (values['--kind'] !== undefined) body.kind = values['--kind'];
    if (values['--plan'] !== undefined && flags.has('--no-plan')) return { error: 'give --plan <id> or --no-plan, not both' };
    if (values['--plan'] !== undefined) body.plan = values['--plan'];
    if (flags.has('--no-plan')) body.noPlan = true;
  }
  if (flags.has('--end-sessions')) {
    if (!flags.has('--yes')) {
      return {
        error:
          '--end-sessions tears down this student\'s running labs and cannot be undone. Check `access show <id>` first, then add --yes.',
      };
    }
    body.endSessions = true;
  }
  return { command: { kind: 'access-change', verb: verb as AccessVerb, userId, body }, json };
}

export function parseRoleArgs(argv: readonly string[]): { command: Command; json: boolean } | { error: string } {
  const [verb, ...rest] = argv;
  const values: Record<string, string> = {};
  const words: string[] = [];
  let json = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--by' || arg === '--reason') {
      const value = rest[i + 1];
      if (verb !== 'set') return { error: `${arg} is for role set` };
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      if (arg in values) return { error: `${arg} given twice` };
      values[arg] = value;
      i += 1;
    } else if (arg.startsWith('--')) return { error: `unknown option ${arg} for role ${verb ?? ''}`.trim() };
    else words.push(arg);
  }
  if (verb === 'show') {
    if (words.length !== 1) return { error: 'role show needs exactly one <user-id>' };
    return { command: { kind: 'role-show', userId: words[0]! }, json };
  }
  if (verb === 'set') {
    if (words.length !== 2) return { error: 'role set needs <user-id> and a role: STUDENT, INSTRUCTOR or ADMIN' };
    if (!values['--by']) return { error: 'role set needs --by <operator>: every change records who made it' };
    if (!values['--reason']) return { error: 'role set needs --reason <text>: every change records why' };
    return {
      command: { kind: 'role-set', userId: words[0]!, body: { role: words[1]!.toUpperCase(), by: values['--by'], reason: values['--reason'] } },
      json,
    };
  }
  return { error: verb ? `unknown role command ${verb}` : 'role needs a command: show, set' };
}

export function parseSignOutArgs(argv: readonly string[]): { command: Command; json: boolean } | { error: string } {
  const values: Record<string, string> = {};
  const words: string[] = [];
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--by' || arg === '--reason') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      if (arg in values) return { error: `${arg} given twice` };
      values[arg] = value;
      i += 1;
    } else if (arg.startsWith('--')) return { error: `unknown option ${arg} for sign-out` };
    else words.push(arg);
  }
  if (words.length !== 1) return { error: 'sign-out needs exactly one <user-id> (from access find)' };
  if (!values['--by']) return { error: 'sign-out needs --by <operator>: every change records who made it' };
  if (!values['--reason']) return { error: 'sign-out needs --reason <text>: every change records why' };
  return { command: { kind: 'sign-out', userId: words[0]!, body: { by: values['--by'], reason: values['--reason'] } }, json };
}

export function parseBillingArgs(argv: readonly string[]): { command: Command; json: boolean } | { error: string } {
  const [verb, ...rest] = argv;
  const json = rest.includes('--json');
  const words: string[] = [];
  const values: Record<string, string> = {};
  let apply = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === '--json') continue;
    if (arg === '--apply' && verb === 'reconcile') {
      apply = true;
    } else if ((arg === '--by' || arg === '--reason') && verb === 'reconcile') {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      values[arg] = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      return { error: `unknown option ${arg} for billing ${verb ?? ''}`.trim() };
    } else {
      words.push(arg);
    }
  }
  switch (verb) {
    case 'list':
      return words.length === 0 ? { command: { kind: 'billing-list' }, json } : { error: 'billing list takes no argument' };
    case 'show':
      return words.length === 1 ? { command: { kind: 'billing-show', userId: words[0]! }, json } : { error: 'billing show needs exactly one <user-id>' };
    case 'reconcile': {
      if (words.length > 0) return { error: 'billing reconcile takes no argument' };
      if (!apply && (values['--by'] || values['--reason'])) return { error: '--by and --reason go with --apply' };
      if (apply && (!values['--by'] || !values['--reason'])) {
        return { error: 'billing reconcile --apply needs --by <operator> and --reason <text>: it changes access' };
      }
      return {
        command: {
          kind: 'billing-reconcile',
          body: apply ? { apply: true, by: values['--by'], reason: values['--reason'] } : {},
        },
        json,
      };
    }
    default:
      return { error: verb ? `unknown billing command ${verb}` : 'billing needs a command: list, show, reconcile' };
  }

}

export function parseArgs(argv: readonly string[]): { command: Command; json: boolean } | { error: string } {
  if (argv[0] === 'access') return parseAccessArgs(argv.slice(1));
  if (argv[0] === 'role') return parseRoleArgs(argv.slice(1));
  if (argv[0] === 'sign-out') return parseSignOutArgs(argv.slice(1));
  if (argv[0] === 'billing') return parseBillingArgs(argv.slice(1));
  const json = argv.includes('--json');
  const recent = argv.includes('--recent');
  const yes = argv.includes('--yes');
  const words = argv.filter((arg) => !arg.startsWith('--'));
  const unknown = argv.filter((arg) => arg.startsWith('--') && !['--json', '--recent', '--yes'].includes(arg));
  if (unknown.length > 0) return { error: `unknown option ${unknown[0]}` };
  const [verb, id, extra] = words;
  if (extra !== undefined) return { error: 'too many arguments' };
  switch (verb) {
    case 'status':
      return id === undefined ? { command: { kind: 'status' }, json } : { error: 'status takes no argument' };
    case 'sessions':
      return id === undefined ? { command: { kind: 'sessions', recent }, json } : { error: 'sessions takes no argument' };
    case 'session':
      return id ? { command: { kind: 'session', id }, json } : { error: 'session needs a session id' };
    case 'end':
      if (!id) return { error: 'end needs a session id' };
      if (!yes) {
        return {
          error:
            'end tears down a student\'s lab and cannot be undone. Read it first (`session <id>`), tell the student, then add --yes.',
        };
      }
      return { command: { kind: 'end', id }, json };
    default:
      return { error: verb ? `unknown command ${verb}` : 'no command' };
  }
}

interface Reply {
  status: number;
  body: { ok: boolean; data?: unknown; error?: { code: string; message: string } };
}

function call(socketPath: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = payload === undefined
      ? {}
      : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) };
    const req = request({ socketPath, method, path, timeout: 120_000, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('the operator socket did not answer within 120s')));
    req.on('error', reject);
    req.end(payload);
  });
}

function pathFor(command: Command): { method: 'GET' | 'POST'; path: string; body?: unknown } {
  switch (command.kind) {
    case 'access-list':
      return { method: 'GET', path: `/v1/access${command.state ? `?state=${encodeURIComponent(command.state)}` : ''}` };
    case 'access-find':
      return { method: 'GET', path: `/v1/access/find?email=${encodeURIComponent(command.email)}` };
    case 'access-show':
      return { method: 'GET', path: `/v1/access/${encodeURIComponent(command.userId)}` };
    case 'access-plans':
      return { method: 'GET', path: '/v1/access/plans' };
    case 'billing-list':
      return { method: 'GET', path: '/v1/billing' };
    case 'billing-show':
      return { method: 'GET', path: `/v1/billing/${encodeURIComponent(command.userId)}` };
    case 'billing-reconcile':
      return { method: 'POST', path: '/v1/billing/reconcile', body: command.body };
    case 'access-change':
      return {
        method: 'POST',
        path: `/v1/access/${encodeURIComponent(command.userId)}/${command.verb}`,
        body: command.body,
      };
    case 'role-show':
      return { method: 'GET', path: `/v1/users/${encodeURIComponent(command.userId)}/role` };
    case 'role-set':
      return { method: 'POST', path: `/v1/users/${encodeURIComponent(command.userId)}/role`, body: command.body };
    case 'sign-out':
      return { method: 'POST', path: `/v1/users/${encodeURIComponent(command.userId)}/sign-out`, body: command.body };
    case 'status':
      return { method: 'GET', path: '/v1/status' };
    case 'sessions':
      return { method: 'GET', path: `/v1/sessions?scope=${command.recent ? 'recent' : 'live'}` };
    case 'session':
      return { method: 'GET', path: `/v1/sessions/${encodeURIComponent(command.id)}` };
    case 'end':
      return { method: 'POST', path: `/v1/sessions/${encodeURIComponent(command.id)}/end` };
  }
}

function duration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length)));
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd()).join('\n');
}

export function formatStatus(status: OperatorStatus): string {
  const c = status.capacity;
  const byStatus = Object.entries(c.byStatus)
    .map(([name, count]) => `${name} ${count}`)
    .join(', ');
  const lines = [
    `new labs:        ${status.newLabs.verdict.toUpperCase()}`,
    ...status.newLabs.reasons.map((reason) => `                 - ${reason}`),
    `slots:           ${c.occupying ?? '?'} of ${c.maxActive} held, ${c.available ?? '?'} free${byStatus ? ` (${byStatus})` : ''}`,
    `per student:     ${c.perStudentLimit ?? 'unlimited'}`,
    `launches paused: ${status.launchesPaused ? 'YES — every Start Lab is refused' : 'no'}`,
    `database:        ${status.database.ok ? 'ok' : 'NOT READABLE'}`,
    `reaper:          ${
      status.reaper.secondsSinceSuccess === null
        ? 'no sweep yet'
        : `last sweep ${duration(status.reaper.secondsSinceSuccess)} ago${status.reaper.stalled ? ' — STALLED' : ''}`
    }`,
    'providers:',
    ...status.providers.map(
      (p) =>
        `  ${p.provider.padEnd(12)} ${
          p.available ? 'available' : p.disabled ? 'off (by configuration)' : `UNAVAILABLE${p.reason ? ` — ${p.reason}` : ''}`
        }`,
    ),
  ];
  return lines.join('\n');
}

export function formatSessions(sessions: readonly OperatorSessionView[]): string {
  if (sessions.length === 0) return 'no sessions';
  const rows = [['SESSION', 'LAB', 'PROVIDER', 'STATUS', 'IN STATUS', 'AGE', 'IDLE', 'EXPIRES IN', 'SANDBOX', 'OWNER', 'REASON']];
  for (const s of sessions) {
    rows.push([
      s.sessionId,
      s.labId,
      s.provider,
      s.status,
      duration(s.inStatusSeconds),
      duration(s.ageSeconds),
      duration(s.idleSeconds),
      s.occupiesSlot ? duration(s.secondsUntilExpiry) : '-',
      s.sandboxRef,
      s.ownerUserId ?? '(none)',
      s.statusReason ?? '',
    ]);
  }
  return table(rows);
}

export function formatSession(s: OperatorSessionView): string {
  return [
    `session:      ${s.sessionId}`,
    `lab:          ${s.labId} (${s.provider})`,
    `status:       ${s.status} for ${duration(s.inStatusSeconds)}${s.statusReason ? ` — ${s.statusReason}` : ''}`,
    `holds a slot: ${s.occupiesSlot ? 'yes' : 'no'}`,
    `sandbox:      ${s.sandboxRef}${s.namespace ? ` (namespace ${s.namespace})` : ''}`,
    `owner:        ${s.ownerUserId ?? '(none)'}`,
    `created:      ${s.createdAt} (${duration(s.ageSeconds)} ago)`,
    `last active:  ${s.lastActivityAt} (${duration(s.idleSeconds)} ago)`,
    `expires:      ${s.expiresAt}${s.occupiesSlot ? ` (in ${duration(s.secondsUntilExpiry)})` : ''}`,
    ...(s.endedAt ? [`ended:        ${s.endedAt}`] : []),
  ].join('\n');
}

function accessWindow(account: AccountAccessView): string {
  const e = account.entitlement;
  if (!e) return '-';
  return e.expiresAt ? `until ${e.expiresAt}` : 'no end date';
}

function accessLabel(account: AccountAccessView): string {
  const e = account.entitlement;
  if (!e) return '-';
  return `${e.grantedVia === 'billing' ? 'paid:' : ''}${e.kind}${e.planId ? `/${e.planId}` : ''}`;
}

export function formatAccounts(policy: string, accounts: readonly AccountAccessView[]): string {
  const header = `policy: ${policy}${policy === 'open' ? ' — every signed-in account may use labs' : ''}`;
  if (accounts.length === 0) return `${header}\nno accounts`;
  const rows = [['USER ID', 'EMAIL', 'NAME', 'ROLE', 'STATE', 'KIND/PLAN', 'WINDOW', 'FIRST SIGN-IN']];
  for (const a of accounts) {
    rows.push([
      a.userId,
      a.email ?? '-',
      a.displayName ?? '-',
      a.role,
      a.state,
      accessLabel(a),
      accessWindow(a),
      a.firstSignInAt,
    ]);
  }
  return `${header}\n${table(rows)}`;
}

interface AccessHistoryEntry {
  at: string;
  action: string;
  by: string;
  reason: string;
  source?: string;
  before: { status: string; expiresAt: string | null } | null;
  after: { status: string; startsAt: string; expiresAt: string | null; kind?: string; planId?: string | null };
}

function historyLine(h: AccessHistoryEntry): string {
  const until = h.after.expiresAt ?? 'no end date';
  const label = h.after.kind ? ` ${h.after.kind}${h.after.planId ? `/${h.after.planId}` : ''}` : '';
  const source = h.source === 'billing' ? ' [billing]' : '';
  return `${h.at}  ${h.action.padEnd(7)} by ${h.by}${source}: ${h.before?.status ?? 'NONE'} → ${h.after.status}${label} (${h.after.startsAt} … ${until}) — ${h.reason}`;
}

export function formatPlans(data: {
  plans: Array<{ id: string; name: string; tracks: 'all' | string[]; maxConcurrentSessions: number | null }>;
  trial: { enabled: boolean; durationDays?: number; planId?: string | null; note?: string };
}): string {
  const rows = [['PLAN', 'NAME', 'TRACKS', 'LABS AT ONCE']];
  for (const p of data.plans) {
    rows.push([
      p.id,
      p.name,
      p.tracks === 'all' ? 'all' : p.tracks.join(','),
      p.maxConcurrentSessions === null ? 'deployment limit' : `≤ ${p.maxConcurrentSessions} (and the deployment limit)`,
    ]);
  }
  return [
    data.plans.length === 0 ? 'plans: none configured (ACCESS_PLANS_FILE unset) — a grant covers every track' : table(rows),
    data.trial.enabled
      ? `trials: ${data.trial.durationDays} days${data.trial.planId ? ` on plan ${data.trial.planId}` : ', no plan'}, once per account`
      : `trials: off — ${data.trial.note ?? ''}`,
  ].join('\n');
}

export function formatAccountDetail(data: {
  policy: string;
  account: AccountAccessView;
  diagnosis: string[];
  liveSessions: Array<{ sessionId: string; labId: string; status: string }>;
  history: AccessHistoryEntry[];
}): string {
  const a = data.account;
  const e = a.entitlement;
  return [
    `user:           ${a.userId}`,
    `email:          ${a.email ?? '-'}`,
    `name:           ${a.displayName ?? '-'}`,
    `issuer:         ${a.issuer}`,
    `role:           ${a.role}`,
    `first sign-in:  ${a.firstSignInAt}`,
    `policy:         ${data.policy}`,
    `access:         ${a.state}${a.canUseLabs ? ' — may use labs' : ' — may NOT use labs'}`,
    ...(e ? [`window:         ${e.startsAt} … ${e.expiresAt ?? 'no end date'} (${e.grantedVia}, updated ${e.updatedAt})`] : []),
    ...(e ? [`kind / plan:    ${e.kind} / ${e.planId ?? 'no plan (every track)'}`] : []),
    ...(a.grants && a.grants.length > 1
      ? [
          'rows:',
          ...a.grants.map(
            (g) =>
              `  ${g.grantedVia.padEnd(8)} ${g.status.padEnd(9)} ${g.kind}${g.planId ? `/${g.planId}` : ''}  ${g.startsAt} … ${g.expiresAt ?? 'no end date'}`,
          ),
        ]
      : []),
    'why:',
    ...data.diagnosis.map((line) => `  - ${line}`),
    `running labs:   ${data.liveSessions.length === 0 ? 'none' : ''}`,
    ...data.liveSessions.map((s) => `  ${s.sessionId}  ${s.labId}  ${s.status}`),
    `history:        ${data.history.length === 0 ? 'none' : '(newest first)'}`,
    ...data.history.map((h) => `  ${historyLine(h)}`),
  ].join('\n');
}

export function formatBillingList(data: {
  provider: string;
  mode: string;
  subscriptions: Array<{ subscriptionRef: string; userId: string; productStatus: string; planId: string | null; currentPeriodEnd: string }>;
}): string {
  const header = `billing: provider ${data.provider}, ${data.mode.toUpperCase()} mode`;
  if (data.subscriptions.length === 0) return `${header}\nno subscriptions`;
  const rows = [['SUBSCRIPTION', 'USER ID', 'STATUS', 'PLAN', 'PERIOD END']];
  for (const s of data.subscriptions) rows.push([s.subscriptionRef, s.userId, s.productStatus, s.planId ?? '-', s.currentPeriodEnd]);
  return `${header}\n${table(rows)}`;
}

export function formatBillingShow(data: {
  provider: string;
  mode: string;
  userId: string;
  customerRef: string | null;
  account: { subscription: { status: string; accessUntil: string | null } | null; canSubscribe: boolean };
  billingEntitlement: { status: string; kind: string; planId: string | null; expiresAt: string | null } | null;
  subscriptions: Array<{ subscriptionRef: string; productStatus: string; status: string; currentPeriodEnd: string; cancelAtPeriodEnd: boolean; providerStateAt: string }>;
  recentEvents: Array<{ processedAt: string; eventType: string; eventId: string; outcome: string }>;
}): string {
  const e = data.billingEntitlement;
  return [
    `user:            ${data.userId}`,
    `provider:        ${data.provider} (${data.mode.toUpperCase()} mode)`,
    `customer:        ${data.customerRef ?? 'none — never completed a checkout'}`,
    `student sees:    ${data.account.subscription ? `${data.account.subscription.status}${data.account.subscription.accessUntil ? ` until ${data.account.subscription.accessUntil}` : ''}` : 'no subscription'}`,
    `billing row:     ${e ? `${e.status} ${e.kind}/${e.planId ?? '-'} until ${e.expiresAt ?? 'no end'}` : 'none'}`,
    `subscriptions:   ${data.subscriptions.length === 0 ? 'none' : ''}`,
    ...data.subscriptions.map(
      (s) =>
        `  ${s.subscriptionRef}  ${s.productStatus} (provider: ${s.status})  period end ${s.currentPeriodEnd}` +
        `${s.cancelAtPeriodEnd ? '  cancels at period end' : ''}  state as of ${s.providerStateAt}`,
    ),
    `recent events:   ${data.recentEvents.length === 0 ? 'none' : '(newest first)'}`,
    ...data.recentEvents.map((ev) => `  ${ev.processedAt}  ${ev.eventType.padEnd(22)} ${ev.outcome.padEnd(8)} ${ev.eventId}`),
  ].join('\n');
}

export function formatReconcile(data: {
  checked: number;
  drift: Array<{ subscriptionRef: string; userId: string; field: string; stored: string; provider: string }>;
  applied: Array<{ subscriptionRef: string; outcome: string }>;
  manual: Array<{ subscriptionRef: string; userId: string }>;
}): string {
  return [
    `checked ${data.checked} subscription(s); ${data.drift.length} disagreement(s)`,
    ...data.drift.map((d) => `  ${d.subscriptionRef}  ${d.userId}  ${d.field}: stored ${d.stored} | provider ${d.provider}`),
    ...(data.applied.length > 0 ? ['re-processed from the provider:', ...data.applied.map((a) => `  ${a.subscriptionRef}: ${a.outcome}`)] : []),
    ...(data.manual.length > 0
      ? ['needs a person (the provider does not know it):', ...data.manual.map((m) => `  ${m.subscriptionRef}  ${m.userId}`)]
      : []),
    ...(data.drift.length > 0 && data.applied.length === 0 ? ['report only — nothing changed. Add --apply --by <you> --reason <why> to fix.'] : []),
  ].join('\n');
}

export function formatAccessChange(verb: string, data: {
  changed: boolean;
  account: AccountAccessView | null;
  ended: Array<{ sessionId: string; after: string }>;
  stillRunning: Array<{ sessionId: string; labId: string; status: string }>;
  note?: string;
}): string {
  const a = data.account;
  return [
    data.changed ? `${verb}: done — ${a?.userId ?? ''} is now ${a?.state ?? '?'}` : `${verb}: already in effect — nothing changed, nothing recorded`,
    ...(a?.entitlement ? [`window: ${a.entitlement.startsAt} … ${a.entitlement.expiresAt ?? 'no end date'}`] : []),
    ...data.ended.map((s) => `ended ${s.sessionId} (now ${s.after})`),
    ...data.stillRunning.map((s) => `still running: ${s.sessionId} ${s.labId} ${s.status}`),
    ...(data.note ? [data.note] : []),
  ].join('\n');
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    process.stderr.write(`operator-cli: ${parsed.error}\n\n${USAGE}\n`);
    return 2;
  }
  const socketPath = env.OPERATOR_SOCKET_PATH?.trim();
  if (!socketPath) {
    process.stderr.write('operator-cli: OPERATOR_SOCKET_PATH is not set in this container, so the api has no operator socket.\n');
    return 3;
  }
  const { method, path, body } = pathFor(parsed.command);
  let reply: Reply;
  try {
    reply = await call(socketPath, method, path, body);
  } catch (error) {
    const code = (error as { code?: string }).code;
    process.stderr.write(
      `operator-cli: cannot reach the api's operator socket (${code ?? (error instanceof Error ? error.message : 'error')}).\n` +
        'Is the api running and ready? `prod ps api`, `ready api 9400`, and look for ops.operator_socket in its log.\n',
    );
    return 3;
  }
  if (parsed.json || !reply.body.ok) {
    process.stdout.write(`${JSON.stringify(reply.body, null, 2)}\n`);
    return reply.body.ok ? 0 : 1;
  }
  const data = reply.body.data as Record<string, unknown>;
  switch (parsed.command.kind) {
    case 'access-list':
    case 'access-find':
      process.stdout.write(`${formatAccounts(String(data.policy), data.accounts as AccountAccessView[])}\n`);
      break;
    case 'access-show':
      process.stdout.write(`${formatAccountDetail(data as unknown as Parameters<typeof formatAccountDetail>[0])}\n`);
      break;
    case 'access-plans':
      process.stdout.write(`${formatPlans(data as unknown as Parameters<typeof formatPlans>[0])}\n`);
      break;
    case 'billing-list':
      process.stdout.write(`${formatBillingList(data as unknown as Parameters<typeof formatBillingList>[0])}\n`);
      break;
    case 'billing-show':
      process.stdout.write(`${formatBillingShow(data as unknown as Parameters<typeof formatBillingShow>[0])}\n`);
      break;
    case 'billing-reconcile':
      process.stdout.write(`${formatReconcile(data as unknown as Parameters<typeof formatReconcile>[0])}\n`);
      break;
    case 'access-change':
      process.stdout.write(
        `${formatAccessChange(parsed.command.verb, data as unknown as Parameters<typeof formatAccessChange>[1])}\n`,
      );
      break;
    case 'role-show':
      process.stdout.write(`${String(data.userId)}  ${String(data.role)}  ${String(data.email ?? data.displayName ?? '')}\n`);
      break;
    case 'role-set':
      process.stdout.write(
        data.changed
          ? `changed: ${parsed.command.userId} is now ${String(data.after)} (was ${String(data.before)}). The api applies it to their next request; the Classroom link appears when they reload the page.\n`
          : `unchanged: ${parsed.command.userId} is already ${String(data.after)}.\n`,
      );
      break;
    case 'sign-out':
      process.stdout.write(
        `signed out: ${String(data.signedOut)} browser sign-in(s) of ${parsed.command.userId} ended; each is refused from its next request.\n` +
          `${String(data.note)}\n`,
      );
      break;
    case 'status':
      process.stdout.write(`${formatStatus(data as unknown as OperatorStatus)}\n`);
      break;
    case 'sessions':
      process.stdout.write(`${formatSessions(data.sessions as OperatorSessionView[])}\n`);
      break;
    case 'session':
      process.stdout.write(`${formatSession(data as unknown as OperatorSessionView)}\n`);
      break;
    case 'end': {
      const session = data.session as OperatorSessionView;
      process.stdout.write(
        reply.status === 200
          ? data.endedBy === 'existing_teardown'
            ? `finished: ${session.sessionId} was already being torn down (${session.statusReason ?? String(data.before)}); now ${session.status}. Its slot is free.\n`
            : `ended: ${session.sessionId} was ${String(data.before)}, now ${session.status}. Its slot is free.\n`
          : `NOT YET: ${session.sessionId} is ${session.status}. ${String(data.note ?? '')}${data.destroyError ? ` (${String(data.destroyError)})` : ''}\n` +
            'Check again with `session <id>` after the next sweep; RB-17 §4 if it stays.\n',
      );
      break;
    }
  }
  return 0;
}

// Run when executed, not when imported by the tests.
const invokedDirectly = process.argv[1] !== undefined && /operator-cli\.[cm]?[jt]s$/.test(process.argv[1]);
if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
