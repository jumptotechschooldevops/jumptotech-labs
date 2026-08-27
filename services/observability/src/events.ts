/**
 * The log event vocabulary — PLATFORM-003.
 *
 * Every structured line carries an `event`, and the set of legal events is a
 * closed union rather than a free string. Three reasons, in order of how much
 * they matter:
 *
 *   1. **A dashboard or a log query can be written against it.** `event` is the
 *      field an operator greps for; a vocabulary that drifts per call site is
 *      not queryable, and "search for whatever wording someone chose that day"
 *      is how log-based debugging fails at 2am.
 *   2. **It is reviewable.** Adding an event is a diff in this file, which is
 *      where a reviewer can ask whether the thing being logged should be logged
 *      at all.
 *   3. **It keeps `msg` honest.** With the event carrying the meaning, `msg`
 *      is free to be a human sentence and nothing depends on parsing it — so
 *      no query breaks when someone improves the wording.
 *
 * Naming is `subject.action` or `subject.action.outcome`, lowercase, dotted.
 */
export const LOG_EVENTS = [
  // --- process lifecycle -----------------------------------------------------
  'process.started',
  'process.stopping',
  'process.stopped',
  'process.start_failed',
  'config.loaded',

  // --- HTTP ------------------------------------------------------------------
  'http.request.completed',
  'http.request.failed',

  // --- lab sessions ----------------------------------------------------------
  'lab.start.attempted',
  'lab.start.succeeded',
  'lab.start.failed',
  'lab.reset.succeeded',
  'lab.reset.failed',
  'lab.end.succeeded',
  'lab.end.failed',
  'session.created',
  'session.active',
  'session.failed',
  'session.ended',
  'session.expired',
  'session.transition',
  'provision.step.completed',

  // --- providers -------------------------------------------------------------
  'provider.availability.changed',
  'provider.availability.probe_failed',
  'provider.registered',

  // --- sandboxes / runtime broker -------------------------------------------
  'sandbox.create.succeeded',
  'sandbox.create.failed',
  'sandbox.remove.succeeded',
  'sandbox.remove.failed',
  'sandbox.exec.succeeded',
  'sandbox.exec.failed',
  'sandbox.runtime.op',
  'sandbox.runtime.unreachable',
  'sandbox.runtime.ready',
  'sandbox.attach.opened',
  'sandbox.attach.denied',
  'sandbox.attach.closed',

  // --- terminal --------------------------------------------------------------
  'terminal.connection.opened',
  'terminal.connection.rejected',
  'terminal.connection.closed',
  'terminal.reattach.succeeded',
  'terminal.reattach.failed',
  'terminal.terminate.requested',

  // --- verification ----------------------------------------------------------
  'verify.passed',
  'verify.failed',
  'verify.errored',

  // --- cleanup ---------------------------------------------------------------
  'reaper.started',
  'reaper.sweep.completed',
  'reaper.sweep.failed',
  'reaper.sandbox.reclaimed',
  'reaper.sandbox.skipped',
  'reaper.sandbox.delete_failed',

  // --- persistence -----------------------------------------------------------
  'db.up',
  'db.down',
  'db.query_failed',
  'db.pool_error',
  'migration.applied',
  'migration.failed',
  'progress.write_failed',

  // --- identity --------------------------------------------------------------
  'authn.succeeded',
  'authn.failed',
  'authz.decision',
  'auth.login.started',
  'auth.login.unavailable',
  'auth.callback.succeeded',
  'auth.callback.failed',
  'auth.logout',
  'auth.sessions.purged',

  // --- security --------------------------------------------------------------
  //
  // One event, discriminated by the `securityEvent` field, because the useful
  // operator query is "show me everything security-relevant" and that should
  // not require knowing the full list in advance.
  'security.event',

  // --- observability itself --------------------------------------------------
  'observability.listener.started',
  'observability.scrape.denied',
] as const;

export type LogEvent = (typeof LOG_EVENTS)[number];

/**
 * Security event kinds, carried on `security.event`.
 *
 * Each of these is a boundary being tested. Most are refusals the platform
 * already performed correctly and silently; making them countable is the whole
 * point — a boundary that holds without anyone knowing it was pushed on is
 * indistinguishable from one nobody has tried.
 */
export const SECURITY_EVENTS = [
  'origin_rejected',
  'internal_secret_mismatch',
  'scope_denied',
  'attach_ownership_refused',
  'sandbox_ownership_refused',
  'path_traversal_blocked',
  'open_redirect_blocked',
  'unowned_session_access',
  'oversized_body_rejected',
  'malformed_session_id',
  'cross_session_reference_ignored',
  'scrape_unauthorized',
  'dev_identity_in_use',
] as const;

export type SecurityEventKind = (typeof SECURITY_EVENTS)[number];
