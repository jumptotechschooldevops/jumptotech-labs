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
               --by <operator> --reason <text>
  access suspend <user-id> --by <operator> --reason <text> [--end-sessions --yes]
  access restore <user-id> --by <operator> --reason <text>
  access revoke  <user-id> --by <operator> --reason <text> [--end-sessions --yes]

The socket path is OPERATOR_SOCKET_PATH, set in the api container by the compose files.`;

export type AccessVerb = 'grant' | 'suspend' | 'restore' | 'revoke';

export type Command =
  | { kind: 'status' }
  | { kind: 'sessions'; recent: boolean }
  | { kind: 'session'; id: string }
  | { kind: 'end'; id: string }
  | { kind: 'access-list'; state?: string }
  | { kind: 'access-find'; email: string }
  | { kind: 'access-show'; userId: string }
  | { kind: 'access-change'; verb: AccessVerb; userId: string; body: Record<string, unknown> };

/** Options that take a value, per access verb. */
const ACCESS_VALUE_OPTIONS: Record<string, readonly string[]> = {
  list: ['--state'],
  find: ['--email'],
  show: [],
  grant: ['--until', '--from', '--by', '--reason'],
  suspend: ['--by', '--reason'],
  restore: ['--by', '--reason'],
  revoke: ['--by', '--reason'],
};
const ACCESS_FLAG_OPTIONS: Record<string, readonly string[]> = {
  list: ['--json'],
  find: ['--json'],
  show: ['--json'],
  grant: ['--json', '--no-expiry'],
  suspend: ['--json', '--end-sessions', '--yes'],
  restore: ['--json'],
  revoke: ['--json', '--end-sessions', '--yes'],
};

export function parseAccessArgs(argv: readonly string[]): { command: Command; json: boolean } | { error: string } {
  const [verb, ...rest] = argv;
  if (!verb || !(verb in ACCESS_VALUE_OPTIONS)) {
    return { error: verb ? `unknown access command ${verb}` : 'access needs a command: list, find, show, grant, suspend, restore, revoke' };
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

export function parseArgs(argv: readonly string[]): { command: Command; json: boolean } | { error: string } {
  if (argv[0] === 'access') return parseAccessArgs(argv.slice(1));
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
    case 'access-change':
      return {
        method: 'POST',
        path: `/v1/access/${encodeURIComponent(command.userId)}/${command.verb}`,
        body: command.body,
      };
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

export function formatAccounts(policy: string, accounts: readonly AccountAccessView[]): string {
  const header = `policy: ${policy}${policy === 'open' ? ' — every signed-in account may use labs' : ''}`;
  if (accounts.length === 0) return `${header}\nno accounts`;
  const rows = [['USER ID', 'EMAIL', 'NAME', 'ROLE', 'STATE', 'WINDOW', 'FIRST SIGN-IN']];
  for (const a of accounts) {
    rows.push([a.userId, a.email ?? '-', a.displayName ?? '-', a.role, a.state, accessWindow(a), a.firstSignInAt]);
  }
  return `${header}\n${table(rows)}`;
}

interface AccessHistoryEntry {
  at: string;
  action: string;
  by: string;
  reason: string;
  before: { status: string; expiresAt: string | null } | null;
  after: { status: string; startsAt: string; expiresAt: string | null };
}

function historyLine(h: AccessHistoryEntry): string {
  const until = h.after.expiresAt ?? 'no end date';
  return `${h.at}  ${h.action.padEnd(7)} by ${h.by}: ${h.before?.status ?? 'NONE'} → ${h.after.status} (${h.after.startsAt} … ${until}) — ${h.reason}`;
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
    'why:',
    ...data.diagnosis.map((line) => `  - ${line}`),
    `running labs:   ${data.liveSessions.length === 0 ? 'none' : ''}`,
    ...data.liveSessions.map((s) => `  ${s.sessionId}  ${s.labId}  ${s.status}`),
    `history:        ${data.history.length === 0 ? 'none' : '(newest first)'}`,
    ...data.history.map((h) => `  ${historyLine(h)}`),
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
    case 'access-change':
      process.stdout.write(
        `${formatAccessChange(parsed.command.verb, data as unknown as Parameters<typeof formatAccessChange>[1])}\n`,
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
