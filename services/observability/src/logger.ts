/**
 * The structured logger — PLATFORM-003, gate one.
 *
 * ## Why this is not pino
 *
 * Redaction here is a **security control**, not formatting, and the control has
 * to be fail-closed: a field nobody anticipated must not reach the output. A
 * library's redaction works the other way round — you enumerate the paths to
 * hide and everything else passes. That is fail-open, and the failure is
 * silent.
 *
 * So the logger takes a *typed field set* and drops every key it does not know.
 * `logger.info('lab.start.failed', { labId, token })` compiles with an error
 * and, if it somehow did not, would emit no `token` — because the serialiser
 * copies from a fixed list rather than iterating the caller's object.
 *
 * Two smaller reasons reinforce it. Pino's transports run on worker threads,
 * which the platform's `read_only: true` containers and the host-execution
 * guard both interact badly with; and this repository has a demonstrated
 * preference for small purpose-built modules over dependencies for things it
 * needs to reason about precisely (`test-support`, `session-token`).
 *
 * ## The three gates, in one place
 *
 *   1. **this file** — unknown keys are never copied
 *   2. `redact.ts` — every emitted string is scanned for secret *shapes*
 *   3. `assertSecretsAreRedactable` at boot — this deployment's own secrets
 *      are proven catchable before the process serves anything
 *
 * ## The logger never throws
 *
 * A logger that can fail turns an observability bug into an outage. Every path
 * here is total: serialisation is bounded, redaction cannot recurse forever,
 * and the final write is wrapped. The worst case is a line that says less than
 * it should.
 */
import { currentContext } from './context.js';
import type { LogEvent, SecurityEventKind } from './events.js';
import { redactString, redactValue } from './redact.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Every field a log line may carry, and nothing else.
 *
 * Adding one is a deliberate edit here, which is where a reviewer can ask
 * whether it is safe to log. That review step is the point of the type.
 *
 * Note what is absent and will stay absent: no `email`, no `displayName`, no
 * `token`, no `secret`, no `cookie`, no `kubeconfig`, no `command`, no `stdin`,
 * no `stdout`, no `body`, no `query`, no raw `path`, no `sql`.
 */
export interface LogFields {
  // --- correlation (usually inherited from the ambient context) -------------
  requestId?: string;
  /** Internal UUID surrogate for a user. Never an address or a name. */
  userId?: string;
  sessionId?: string;
  attemptId?: string;

  // --- what the work is about ----------------------------------------------
  labId?: string;
  track?: string;
  provider?: string;
  implementation?: string;
  sandboxKind?: string;
  /** HMAC-derived sandbox handle. Already served to the browser; grants nothing. */
  sandboxRef?: string;
  step?: string;
  op?: string;
  scope?: string;
  endpoint?: string;
  requirementType?: string;
  /** Why an attach was refused. A bounded enum, never free text. */
  denyReason?: string;
  operation?: string;
  migrationVersion?: string;

  // --- outcome --------------------------------------------------------------
  outcome?: string;
  reason?: string;
  result?: string;
  code?: string;
  status?: number;
  count?: number;
  durationMs?: number;

  // --- HTTP -----------------------------------------------------------------
  /** The Express route *template* — `/api/sessions/:sessionId`. Never a raw URL. */
  route?: string;
  method?: string;

  // --- security -------------------------------------------------------------
  securityEvent?: SecurityEventKind;
  authorizationResult?: string;
  action?: string;

  // --- errors ---------------------------------------------------------------
  err?: unknown;

  // --- startup description --------------------------------------------------
  service?: string;
  version?: string;
  commit?: string;
  port?: number;
  store?: string;
  authMode?: string;
  labsLoaded?: number;
  durable?: boolean;
}

/**
 * The copy allow-list.
 *
 * Deliberately a runtime array rather than `Object.keys(someSchema)`: the type
 * above is erased at build time, so a runtime list is what actually enforces
 * the boundary. `logger-schema.test.ts` asserts the two stay in step, so a
 * field added to the interface and forgotten here fails the build.
 */
const ALLOWED_FIELDS = [
  'requestId', 'userId', 'sessionId', 'attemptId',
  'labId', 'track', 'provider', 'implementation', 'sandboxKind', 'sandboxRef',
  'step', 'op', 'scope', 'endpoint', 'requirementType', 'denyReason', 'operation', 'migrationVersion',
  'outcome', 'reason', 'result', 'code', 'status', 'count', 'durationMs',
  'route', 'method',
  'securityEvent', 'authorizationResult', 'action',
  'err',
  'service', 'version', 'commit', 'port', 'store', 'authMode', 'labsLoaded', 'durable',
] as const;

const ALLOWED = new Set<string>(ALLOWED_FIELDS);

export interface LoggerOptions {
  service: string;
  level?: LogLevel;
  /** Where a finished line goes. Injected in tests; stdout in production. */
  sink?: (line: string) => void;
  /** Injected in tests so a snapshot is stable. */
  now?: () => Date;
  /** Lines longer than this are truncated, preserving valid JSON. */
  maxLineBytes?: number;
}

const DEFAULT_MAX_LINE_BYTES = 8192;

/**
 * Serialise an error without its stack.
 *
 * A stack contains absolute filesystem paths from the build host and,
 * routinely, the arguments of the frame that threw — which is exactly how a
 * connection string or a token ends up in a log. `name`, `message` and a
 * structured `code` answer every operational question a stack would, and the
 * message is redacted on the way out regardless.
 */
function serialiseError(error: unknown): unknown {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: redactString(error.message),
      ...(typeof code === 'string' || typeof code === 'number' ? { code: String(code) } : {}),
    };
  }
  if (typeof error === 'string') return { name: 'Error', message: redactString(error) };
  return { name: 'Error', message: redactString(String(error)) };
}

export interface Logger {
  debug(event: LogEvent, fields?: LogFields, msg?: string): void;
  info(event: LogEvent, fields?: LogFields, msg?: string): void;
  warn(event: LogEvent, fields?: LogFields, msg?: string): void;
  error(event: LogEvent, fields?: LogFields, msg?: string): void;
  /**
   * Adapter for the `(message: string) => void` seams that already exist
   * throughout the orchestrator, the progress service and the broker.
   *
   * It lets those call sites keep working — and keep their ambient correlation
   * — while they are migrated one at a time, instead of requiring one enormous
   * commit that changes logging and behaviour together.
   */
  legacy(event: LogEvent, level?: LogLevel): (message: string) => void;
  /** A child logger with fields pre-bound. */
  child(bound: LogFields): Logger;
  readonly level: LogLevel;
}

export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? 'info';
  const now = options.now ?? (() => new Date());
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const sink =
    options.sink ??
    ((line: string) => {
      // Deliberately `process.stdout.write` and not `console.log`: console is
      // what this story is removing, and routing through it would reintroduce
      // the formatting layer the JSON contract exists to avoid.
      process.stdout.write(`${line}\n`);
    });

  function build(level: LogLevel, event: LogEvent, fields: LogFields, msg: string | undefined, bound: LogFields): string {
    const context = currentContext();

    const line: Record<string, unknown> = {
      ts: now().toISOString(),
      level,
      service: options.service,
      event,
    };

    if (msg !== undefined) line.msg = redactString(msg);

    /*
     * Ambient correlation first, then bound fields, then explicit ones.
     *
     * The order is what makes an explicit `sessionId` win over the ambient one
     * — which matters for the reaper, where one sweep touches many sessions
     * under no request context at all.
     */
    if (context) {
      if (context.requestId) line.requestId = context.requestId;
      if (context.userId) line.userId = context.userId;
      if (context.sessionId) line.sessionId = context.sessionId;
      if (context.attemptId) line.attemptId = context.attemptId;
      if (context.labId) line.labId = context.labId;
      if (context.track) line.track = context.track;
      if (context.provider) line.provider = context.provider;
      if (context.route) line.route = context.route;
      if (context.method) line.method = context.method;
    }

    for (const source of [bound, fields]) {
      for (const [key, value] of Object.entries(source)) {
        // The gate. A key that is not on the list is not copied — not renamed,
        // not nested, not stringified. It does not exist in the output.
        if (!ALLOWED.has(key)) continue;
        if (value === undefined) continue;
        line[key] = key === 'err' ? serialiseError(value) : redactValue(value);
      }
    }

    let serialised: string;
    try {
      serialised = JSON.stringify(line);
    } catch {
      // A field that cannot be serialised (a cycle that survived `redactValue`)
      // must not take the process down. Emit what is certainly safe.
      serialised = JSON.stringify({ ts: line.ts, level, service: options.service, event, msg: '[unserialisable fields dropped]' });
    }

    if (Buffer.byteLength(serialised, 'utf8') <= maxLineBytes) return serialised;

    /*
     * Truncation has to preserve valid JSON, or a collector drops the line and
     * the operator loses the one record of an unusual event — and unusually
     * large lines are disproportionately the interesting ones.
     *
     * So the *line* is rebuilt with oversized string values shortened, rather
     * than the serialised text being cut mid-token.
     */
    const trimmed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(line)) {
      trimmed[key] =
        typeof value === 'string' && value.length > 512 ? `${value.slice(0, 512)}…[truncated]` : value;
    }
    trimmed.truncated = true;
    try {
      const out = JSON.stringify(trimmed);
      return Buffer.byteLength(out, 'utf8') <= maxLineBytes
        ? out
        : JSON.stringify({ ts: line.ts, level, service: options.service, event, truncated: true });
    } catch {
      return JSON.stringify({ ts: line.ts, level, service: options.service, event, truncated: true });
    }
  }

  function make(bound: LogFields): Logger {
    function emit(at: LogLevel, event: LogEvent, fields: LogFields = {}, msg?: string): void {
      if (LEVEL_RANK[at] < LEVEL_RANK[level]) return;
      try {
        sink(build(at, event, fields, msg, bound));
      } catch {
        // The sink itself failed — a closed stdout, a full pipe. There is
        // nowhere left to report it, and throwing would propagate a logging
        // failure into request handling. Drop the line.
      }
    }

    return {
      level,
      debug: (event, fields, msg) => emit('debug', event, fields, msg),
      info: (event, fields, msg) => emit('info', event, fields, msg),
      warn: (event, fields, msg) => emit('warn', event, fields, msg),
      error: (event, fields, msg) => emit('error', event, fields, msg),
      legacy: (event, at: LogLevel = 'info') => (message: string) => emit(at, event, {}, message),
      child: (extra) => make({ ...bound, ...extra }),
    };
  }

  return make({});
}

/** A logger that discards everything. For tests and for library defaults. */
export function silentLogger(): Logger {
  return createLogger({ service: 'silent', sink: () => undefined, level: 'error' });
}

/** The runtime allow-list, exported so `logger-schema.test.ts` can check it. */
export const ALLOWED_LOG_FIELDS: readonly string[] = ALLOWED_FIELDS;
