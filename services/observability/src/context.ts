/**
 * The ambient request context — PLATFORM-003.
 *
 * ## The problem this solves
 *
 * A Start Lab request crosses `routes/labs.ts` → `SessionManager` →
 * `ProviderRegistry` → a provider → the broker client, and every one of those
 * wants the same three facts on its log lines: which request, which session,
 * which user. Threading a context object through all of them would mean
 * changing the signature of most of the orchestrator — a large diff whose only
 * purpose is logging, and one that would make the seams worse rather than
 * better.
 *
 * `AsyncLocalStorage` carries it instead. The middleware establishes the
 * context once, and any code running under that request — however deep, across
 * however many awaits — can read it without being handed it.
 *
 * ## What it deliberately is not
 *
 * **Not an authorization channel.** Nothing reads `userId` from here to decide
 * anything. `authorize()` takes `req.user`, which was established by
 * `authenticate()` from a verified credential, and that is unchanged. The
 * context is a *description* of work in flight, and the moment it becomes an
 * input to a decision it becomes a way to confuse one request for another.
 *
 * **Not a store.** It is written once at the boundary and enriched with facts
 * as they become known (a session id exists only after the session is created).
 * It is never used to pass data between components that should be passing it
 * explicitly.
 *
 * ## Missing context is normal
 *
 * A reaper sweep, a startup line, a scheduled purge — none of these run under a
 * request. `current()` returns `undefined` there and the logger simply omits
 * the fields. Code must never assume a context exists.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Facts about the work in flight.
 *
 * Mutable by design: `sessionId` is not knowable when the request arrives.
 * Every field is optional except `requestId`, which is the one thing always
 * available because it is generated rather than derived.
 */
export interface RequestContext {
  readonly requestId: string;
  /** Internal UUID surrogate. Never an email, never a display name. */
  userId?: string;
  sessionId?: string;
  attemptId?: string;
  labId?: string;
  track?: string;
  provider?: string;
  /** The Express route *template*, never a raw path. */
  route?: string;
  method?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * The shape a correlation id may take.
 *
 * Identical to the pattern `apps/api/src/auth/middleware.ts` already applies to
 * `x-request-id`, kept in step deliberately: two different opinions about what
 * a valid id is would mean the audit line and the log line could disagree about
 * whether the same header was acceptable.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Accept a caller-supplied correlation id, or mint one.
 *
 * A client-supplied value is *only* ever used for correlation. It is never a
 * key into a store, never an authorization input, and never trusted to be
 * unique — two requests claiming the same id produce two log streams sharing a
 * tag, which is confusing for that client and harmless for everyone else.
 *
 * A malformed value is replaced rather than rejected. Refusing the request
 * would turn a cosmetic header into an availability problem, and there is no
 * security value in a 400 here: the substitute id is generated server-side and
 * the client learns nothing either way.
 */
export function normaliseRequestId(supplied: string | undefined): string {
  return supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID();
}

/** Run `fn` with `context` ambient. */
export function withContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The ambient context, or `undefined` outside a request. */
export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/** The ambient correlation id, or `undefined` outside a request. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Add facts to the ambient context as they become known.
 *
 * A no-op outside a request, so a component that sometimes runs under one and
 * sometimes does not (the session manager, called by both a route and the
 * reaper) needs no conditional.
 */
export function enrichContext(fields: Partial<Omit<RequestContext, 'requestId'>>): void {
  const context = storage.getStore();
  if (!context) return;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    (context as unknown as Record<string, unknown>)[key] = value;
  }
}
