/**
 * Log sanitisation for the operator support bundle
 * (scripts/private-beta-diagnostics.sh).
 *
 * After an incident, an operator collects evidence and sends it to whoever
 * diagnoses it. Service logs are the evidence that matters most and the one
 * most likely to carry something that must not leave the host. The platform's
 * own lines are already allow-listed and redacted when they are written
 * (`logger.ts`, `redact.ts`). This is the second pass, for three reasons:
 *
 *   · **not every line is ours.** PostgreSQL and nginx write free text: a
 *     `STATEMENT:` or `DETAIL:` line can quote row values, and nginx's error
 *     log quotes the request line, query string included.
 *   · **the bundle leaves the host.** It has a narrower purpose than the log:
 *     answer "what failed, where, when". It keeps fewer fields than the log
 *     does, and it drops the internal user id.
 *   · **the configured secrets are known here.** The script registers this
 *     deployment's own secret values, so one that somehow reached a line in an
 *     unrecognised shape is still replaced.
 *
 * Everything is allow-listed, never deny-listed. A structured line keeps a
 * fixed set of keys. A PostgreSQL line is kept only if it is a severity line
 * or a lifecycle line. An nginx line is kept only if it is an error-log entry
 * or a 5xx access entry, with its query string removed. Anything the parser
 * does not recognise is dropped and counted, never passed through.
 */
import { redactString } from './redact.js';

export type LogSource = 'structured' | 'postgres' | 'nginx';

export interface SanitizeOptions {
  source: LogSource;
  /** Keep at most this many lines: the newest. */
  maxLines: number;
}

export interface SanitizeResult {
  lines: string[];
  /** Lines read. */
  read: number;
  /** Lines that matched a keep rule, before the `maxLines` cap. */
  matched: number;
  /** Lines dropped because nothing recognised them. */
  unrecognised: number;
}

const MAX_TEXT = 400;

/** Keys a structured line keeps in the bundle. Not `userId`: a session id correlates, a user id identifies. */
const STRUCTURED_KEYS = [
  'ts', 'level', 'service', 'event', 'msg',
  'requestId', 'sessionId', 'attemptId',
  'labId', 'track', 'provider', 'implementation', 'sandboxKind', 'sandboxRef',
  'step', 'op', 'scope', 'endpoint', 'requirementType', 'denyReason', 'operation', 'migrationVersion',
  'outcome', 'reason', 'result', 'code', 'status', 'count', 'durationMs',
  'route', 'method', 'securityEvent', 'authorizationResult', 'action',
  'version', 'commit', 'port', 'store', 'authMode', 'labsLoaded', 'durable', 'truncated',
] as const;

/** Informational events worth having beside the warnings: when things started, stopped and changed. */
const LIFECYCLE_EVENTS = new Set([
  'process.started',
  'process.stopping',
  'migration.applied',
  'provider.registered',
  'ops.tls_edge.checked',
  'ops.network_attestation.checked',
  'ops.operator.session_ended',
  'ops.operator_socket.started',
  'observability.listener.started',
]);

/** Longest text any value is scanned at: the redactor's own bound. */
const MAX_SCANNED = 8192;

/**
 * `/path?anything` → `/path?[query removed]`, wherever a URL appears in free text.
 *
 * The prefix is the last path segment only (`[^…/]`), which keeps this linear:
 * an earlier `(\/[^\s?"']*)` could restart at every `/` of a long run and
 * backtrack over the rest, quadratic on a student-supplied path (1.2 s at 32k
 * characters).
 */
export function stripQueryStrings(text: string): string {
  return text.replace(/(\/[^\s?"'/]*)\?[^\s"']*/g, '$1?[query removed]');
}

function clean(text: string): string {
  const bounded = text.length > MAX_SCANNED ? text.slice(0, MAX_SCANNED) : text;
  const once = redactString(stripQueryStrings(bounded));
  return once.length > MAX_TEXT ? `${once.slice(0, MAX_TEXT)}…[truncated]` : once;
}

function cleanValue(value: unknown): unknown {
  if (typeof value === 'string') return clean(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined;
}

function sanitizeStructured(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.event !== 'string' || typeof record.level !== 'string') return null;
  const keep = record.level === 'warn' || record.level === 'error' || LIFECYCLE_EVENTS.has(record.event);
  if (!keep) return '';

  const out: Record<string, unknown> = {};
  for (const key of STRUCTURED_KEYS) {
    const value = cleanValue(record[key]);
    if (value !== undefined) out[key] = value;
  }
  const err = record.err;
  if (err && typeof err === 'object' && !Array.isArray(err)) {
    const e = err as Record<string, unknown>;
    out.err = {
      ...(typeof e.name === 'string' ? { name: clean(e.name) } : {}),
      ...(typeof e.code === 'string' ? { code: clean(e.code) } : {}),
      ...(typeof e.message === 'string' ? { message: clean(e.message) } : {}),
    };
  }
  return JSON.stringify(out);
}

/**
 * PostgreSQL's own log. Kept: a line naming a severity, and the server's
 * lifecycle. Dropped: `STATEMENT:`, `DETAIL:`, `QUERY:`, `CONTEXT:`, `HINT:`
 * continuation lines — the ones that quote SQL and row values — and anything
 * else unrecognised.
 */
const POSTGRES_SEVERITY = /\b(?:ERROR|FATAL|PANIC|WARNING):\s/;
const POSTGRES_LIFECYCLE =
  /\b(?:database system is (?:ready to accept connections|shut down|starting up|in recovery mode)|received (?:fast|smart|immediate) shutdown request|starting PostgreSQL|terminating any other active server processes|server process \(PID \d+\) was terminated|checkpoint starting: (?:shutdown|end-of-recovery)|could not (?:write|extend|open))/;
const POSTGRES_CONTINUATION = /\b(?:STATEMENT|DETAIL|QUERY|CONTEXT|HINT|LOCATION):\s/;

/**
 * Object names PostgreSQL quotes after a keyword — `constraint "users_email_key"`,
 * `role "jumptotech"` — are what make an error line useful, and are kept. Every
 * other quoted text is treated as data: an ERROR quotes the value it could not
 * parse (`invalid input syntax for type uuid: "…"`, `near "…"`), in double
 * quotes as often as in single ones.
 */
const POSTGRES_NAMED = /\b(constraint|relation|column|role|database|table|index|schema|function|sequence|extension|type|user)\s+"([^"]{0,128})"/gi;

function sanitizePostgres(line: string): string | null {
  if (POSTGRES_CONTINUATION.test(line)) return '';
  if (POSTGRES_SEVERITY.test(line) || POSTGRES_LIFECYCLE.test(line)) {
    const bounded = line.length > MAX_SCANNED ? line.slice(0, MAX_SCANNED) : line;
    const names: string[] = [];
    const shielded = bounded.replace(POSTGRES_NAMED, (_whole, keyword: string, name: string) => {
      names.push(`${keyword} "${name}"`);
      return `\u0000${names.length - 1}\u0000`;
    });
    const scrubbed = shielded
      .replace(/'[^']*'/g, "'[value removed]'")
      .replace(/"[^"]*"/g, '"[value removed]"')
      .replace(/\u0000(\d+)\u0000/g, (_m, index: string) => names[Number(index)] ?? '');
    return clean(scrubbed);
  }
  return null;
}

/**
 * nginx, as the web container writes it: the error log (`2026/09/18 06:02:35
 * [error] …`), the `jtt_edge` or stock access log, and the certificate gate.
 * Access lines are kept only for 5xx answers, reduced to address, time,
 * method, path and status. Error lines lose their query strings, their
 * `referrer:` and their `host:` fields.
 */
const NGINX_ERROR = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} \[(emerg|alert|crit|error|warn)\]/;
const NGINX_ACCESS = /^(\S+) (?:- \S+ )?\[([^\]]+)\] "(\S+) (\S+)(?: [^"]*)?" (\d{3}) /;
const TLS_GATE = /^(?:jtt-tls-preflight|\/docker-entrypoint\.d\/05-jumptotech-tls-preflight\.sh):/;

function sanitizeNginx(line: string): string | null {
  if (NGINX_ERROR.test(line)) {
    return clean(line.replace(/, referrer: "[^"]*"/g, '').replace(/, host: "[^"]*"/g, ''));
  }
  if (TLS_GATE.test(line)) return clean(line);
  const access = NGINX_ACCESS.exec(line);
  if (access) {
    const [, address, time, method, target, status] = access;
    if (Number(status) < 500) return '';
    const pathOnly = target!.split('?')[0]!;
    return clean(`${address} [${time}] "${method} ${pathOnly}" ${status}`);
  }
  // The stock entrypoint's own chatter ("Configuration complete; ready for start up").
  if (/^\/docker-entrypoint\.sh: /.test(line)) return '';
  return null;
}

/**
 * Sanitise one service's recent log for the bundle.
 *
 * Returns only lines that matched a keep rule, newest `maxLines`, each already
 * redacted. A line that is dropped by a rule (an info line, a 2xx access line,
 * a `STATEMENT:`) is not counted as unrecognised; a line nothing understood is.
 */
export function sanitizeLogLines(input: readonly string[], options: SanitizeOptions): SanitizeResult {
  const kept: string[] = [];
  let unrecognised = 0;
  const handler =
    options.source === 'structured' ? sanitizeStructured : options.source === 'postgres' ? sanitizePostgres : sanitizeNginx;
  for (const raw of input) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;
    let result: string | null;
    try {
      result = handler(line);
    } catch {
      result = null;
    }
    if (result === null) unrecognised += 1;
    else if (result !== '') kept.push(result);
  }
  const cap = Math.max(0, options.maxLines);
  return {
    lines: kept.slice(Math.max(0, kept.length - cap)),
    read: input.filter((line) => line.trim() !== '').length,
    matched: kept.length,
    unrecognised,
  };
}

/**
 * The last gate before a bundle is packaged: does any text still hold this
 * deployment's configured secrets, or something unmistakably a credential?
 *
 * Deliberately narrower than `redactString`: a bundle legitimately holds hex
 * runs (container ids, image digests) and base64-looking names, and a gate
 * that cried wolf on those would be switched off. It looks for the literal
 * values of the configured secrets — the check that matters — and for shapes
 * that are never innocent: PEM blocks, JWTs, connection strings with a
 * password, credential headers, and OAuth parameters with a value.
 *
 * Returns what kind was found, never the value.
 */
const LEAK_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: 'pem', re: /-----BEGIN [A-Z0-9 ]{0,40}(?:KEY|CERTIFICATE)-----/ },
  { kind: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./ },
  { kind: 'dsn', re: /\b(?:postgres|postgresql|mysql|redis):\/\/[^\s:/@]{1,128}:[^\s@]{1,256}@/i },
  { kind: 'authorization', re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/i },
  // A value assigned to something named as a credential. Twelve characters at
  // least, and never a redaction marker (`[` is not a value character).
  {
    kind: 'credential',
    re: /(?:secret|password|passwd|token|api[_-]?key|private[_-]?key)[A-Za-z0-9_-]{0,32}["']?\s{0,4}[:=]\s{0,4}["']?[^\s"',;&[\]{}]{12,}/i,
  },
  { kind: 'oauth', re: /\b(?:client_secret|refresh_token|id_token|access_token|code_verifier)=[^&\s"'[]{4,}/i },
  { kind: 'cookie', re: /\bjtt_session=[^;\s"'[]{8,}/ },
];

export function findSecretLeaks(text: string, literals: readonly string[]): string[] {
  const found = new Set<string>();
  for (const literal of literals) {
    if (literal.trim().length >= 8 && text.includes(literal.trim())) found.add('configured-secret');
  }
  for (const { kind, re } of LEAK_PATTERNS) if (re.test(text)) found.add(kind);
  return [...found];
}
