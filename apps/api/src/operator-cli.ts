/**
 * The operator CLI — the client half of `operator.ts`.
 *
 * Run inside the api container, where the socket is:
 *
 *   prod exec -T api node /app/node_modules/.bin/tsx apps/api/src/operator-cli.ts status
 *   prod exec -T api node /app/node_modules/.bin/tsx apps/api/src/operator-cli.ts sessions [--recent]
 *   prod exec -T api node /app/node_modules/.bin/tsx apps/api/src/operator-cli.ts session <session-id>
 *   prod exec -T api node /app/node_modules/.bin/tsx apps/api/src/operator-cli.ts end <session-id> --yes
 *
 * (docs/runbooks/private-beta-operations.md §1 defines `ops` for this.)
 * `--json` prints the api's answer as it came. Exit 0 on success, 1 when the
 * api refused or failed, 2 on a usage error, 3 when the socket cannot be
 * reached.
 */
import { request } from 'node:http';

import type { OperatorSessionView, OperatorStatus } from './operator.js';

export const USAGE = `usage: operator-cli <command> [--json]

  status                 capacity, launches paused, providers, database, reaper,
                         and whether a new lab can start right now
  sessions [--recent]    sessions holding a slot (--recent: and those that
                         finished within the retention window, with reasons)
  session <id>           one session, in any status
  end <id> --yes         end one student's lab through the platform's own
                         teardown; recorded EXPIRED, "ended by operator"

The socket path is OPERATOR_SOCKET_PATH, set in the api container by the compose files.`;

export type Command =
  | { kind: 'status' }
  | { kind: 'sessions'; recent: boolean }
  | { kind: 'session'; id: string }
  | { kind: 'end'; id: string };

export function parseArgs(argv: readonly string[]): { command: Command; json: boolean } | { error: string } {
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

function call(socketPath: string, method: 'GET' | 'POST', path: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, timeout: 120_000 }, (res) => {
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
    req.end();
  });
}

function pathFor(command: Command): { method: 'GET' | 'POST'; path: string } {
  switch (command.kind) {
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
  const { method, path } = pathFor(parsed.command);
  let reply: Reply;
  try {
    reply = await call(socketPath, method, path);
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
          ? `ended: ${session.sessionId} was ${String(data.before)}, now ${session.status}. Its slot is free.\n`
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
