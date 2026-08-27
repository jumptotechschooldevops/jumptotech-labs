/**
 * The platform metric catalogue — PLATFORM-003.
 *
 * ## One file, deliberately
 *
 * Every metric the platform exposes is constructed here rather than beside the
 * code that increments it. Three properties follow from that, and none of them
 * survive scattering:
 *
 *   · **The label policy is checkable over the whole set.** `assertLabelPolicy`
 *     walks the registry, and a policy that can only see half the metrics is
 *     not a policy.
 *   · **Naming stays consistent.** Prometheus convention — `jtt_` prefix, base
 *     unit suffix, `_total` on counters — is easy to hold in one file and
 *     impossible to hold across thirty.
 *   · **It is reviewable as a whole.** "What does this platform expose?" has a
 *     single answer, which is what makes the privacy question answerable.
 *
 * ## Grouped by service, not by subject
 *
 * `api`, `terminal` and `sandboxd` are separate processes with separate
 * registries. A process only constructs the groups it can actually observe, so
 * `sandboxd` does not publish a permanently-zero `jtt_lab_start_total` that an
 * operator would reasonably read as "no labs are starting".
 *
 * ## Buckets
 *
 * Chosen from the platform's own configured ceilings rather than from a default
 * ladder. Provisioning is bounded by `DOCKER_SANDBOX_READY_TIMEOUT_SECONDS`
 * (180s); session lifetime by `MAX_SESSION_MINUTES` (60) and
 * `IDLE_TIMEOUT_MINUTES` (20). Buckets that stop short of the real ceiling make
 * the interesting tail invisible, which is the usual way a latency histogram
 * turns out to be useless exactly when it is needed.
 */
import client from 'prom-client';

import { assertLabelPolicy } from './labels.js';

export type Registry = client.Registry;
export type Counter = client.Counter<string>;
export type Gauge = client.Gauge<string>;
export type Histogram = client.Histogram<string>;

/** HTTP request latency. Sub-millisecond to ten seconds. */
const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Sandbox provisioning. Seconds to minutes.
 *
 * The top bucket is 300 because a Docker-track sandbox may legitimately take up
 * to `DOCKER_SANDBOX_READY_TIMEOUT_SECONDS` (180) plus image pull. A ladder
 * ending at 10s would put every real provision in `+Inf`.
 */
const PROVISION_BUCKETS = [1, 2.5, 5, 10, 20, 30, 60, 120, 180, 300];

/** Broker verbs: a `ping` is milliseconds, a `create` is minutes. */
const RUNTIME_OP_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 180];

/** Session lifetime, against a 60-minute absolute cap and a 20-minute idle cap. */
const SESSION_LIFETIME_BUCKETS = [60, 300, 600, 1200, 1800, 2700, 3600, 5400];

/** Verification reads live cluster or filesystem state. */
const VERIFY_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/** A database round trip on a healthy pool, out to a pathological one. */
const DB_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5];

export interface CommonMetrics {
  httpRequests: Counter;
  httpDuration: Histogram;
  httpInFlight: Gauge;
  buildInfo: Gauge;
  configInfo: Gauge;
  readyzOk: Gauge;
  securityEvents: Counter;
  scrapeDenied: Counter;
}

/**
 * Metrics every service publishes.
 *
 * `jtt_readyz_ok` exists as a *metric* as well as an endpoint because an alert
 * needs a time series: "readiness has been false for three minutes" is not
 * expressible against an HTTP probe, and a probe that a load balancer polls is
 * not visible to Prometheus at all.
 */
export function createCommonMetrics(registry: Registry, service: string): CommonMetrics {
  const common = { registers: [registry] };

  return {
    httpRequests: new client.Counter({
      name: 'jtt_http_requests_total',
      help: 'HTTP requests completed, by templated route and status.',
      // `route` is the Express template. A raw path would carry session ids and
      // be unbounded — see labels.ts.
      labelNames: ['service', 'method', 'route', 'status', 'status_class'],
      ...common,
    }),

    httpDuration: new client.Histogram({
      name: 'jtt_http_request_duration_seconds',
      help: 'HTTP request duration in seconds.',
      labelNames: ['service', 'method', 'route', 'status_class'],
      buckets: HTTP_BUCKETS,
      ...common,
    }),

    httpInFlight: new client.Gauge({
      name: 'jtt_http_requests_in_flight',
      help: 'HTTP requests currently being handled.',
      labelNames: ['service'],
      ...common,
    }),

    /*
     * Answers "what changed before the incident?".
     *
     * A constant-1 gauge whose labels carry the facts is the standard
     * Prometheus idiom for build metadata: it joins onto any other series and
     * changes value only when the deployment does.
     */
    buildInfo: new client.Gauge({
      name: 'jtt_build_info',
      help: 'Build metadata. Always 1; the labels carry the information.',
      labelNames: ['service', 'version', 'commit', 'node_version'],
      ...common,
    }),

    /*
     * The same idiom for the configuration an operator needs during an
     * incident. Carries no secret, no URL, no credential — only the handful of
     * switches that change how the platform behaves.
     */
    configInfo: new client.Gauge({
      name: 'jtt_config_info',
      help: 'Operationally significant configuration. Always 1; labels carry the information.',
      labelNames: ['service', 'auth_mode', 'lab_provider', 'store'],
      ...common,
    }),

    readyzOk: new client.Gauge({
      name: 'jtt_readyz_ok',
      help: 'Whether this instance reports ready (1) or not (0).',
      labelNames: ['service'],
      ...common,
    }),

    securityEvents: new client.Counter({
      name: 'jtt_security_events_total',
      help: 'Security-relevant refusals and boundary events.',
      labelNames: ['service', 'event'],
      ...common,
    }),

    scrapeDenied: new client.Counter({
      name: 'jtt_observability_scrape_denied_total',
      help: 'Metrics scrapes refused for a missing or wrong bearer token.',
      labelNames: ['service'],
      ...common,
    }),
  };
}

export interface SessionMetrics {
  labStarts: Counter;
  provisionDuration: Histogram;
  provisionStepDuration: Histogram;
  labResets: Counter;
  labEnds: Counter;
  sessionsActive: Gauge;
  capacityLimit: Gauge;
  capacityRejections: Counter;
  sessionLifetime: Histogram;
  stateTransitions: Counter;
  labsLoaded: Gauge;
  labLoadErrors: Gauge;
}

export function createSessionMetrics(registry: Registry): SessionMetrics {
  const common = { registers: [registry] };

  return {
    labStarts: new client.Counter({
      name: 'jtt_lab_start_total',
      help: 'Start Lab requests by outcome.',
      labelNames: ['track', 'lab_id', 'provider', 'outcome'],
      ...common,
    }),

    provisionDuration: new client.Histogram({
      name: 'jtt_lab_provision_duration_seconds',
      help: 'Time to provision a lab sandbox, success or failure.',
      labelNames: ['provider', 'sandbox_kind', 'outcome'],
      buckets: PROVISION_BUCKETS,
      ...common,
    }),

    /*
     * Per-step timing, from the `steps` array the providers already return.
     *
     * This is what turns "provisioning is slow" into "the image pull is slow"
     * without reading any code. It is the panel incident exercise 3 is built
     * around.
     */
    provisionStepDuration: new client.Histogram({
      name: 'jtt_lab_provision_step_duration_seconds',
      help: 'Duration of an individual provisioning step.',
      labelNames: ['provider', 'step', 'outcome'],
      buckets: PROVISION_BUCKETS,
      ...common,
    }),

    labResets: new client.Counter({
      name: 'jtt_lab_reset_total',
      help: 'Reset Lab requests by outcome.',
      labelNames: ['provider', 'outcome'],
      ...common,
    }),

    labEnds: new client.Counter({
      name: 'jtt_lab_end_total',
      help: 'Sessions ended, by what ended them.',
      labelNames: ['provider', 'reason'],
      ...common,
    }),

    /*
     * A gauge with a collector, not a counter the code keeps in step.
     *
     * Read at scrape time from the session store, so it is always the truth
     * rather than a number that drifts whenever an increment is missed on an
     * error path. Drift in exactly this metric is what would hide a leak.
     */
    sessionsActive: new client.Gauge({
      name: 'jtt_sessions_active',
      help: 'Sessions currently holding a sandbox.',
      labelNames: ['provider', 'status'],
      ...common,
    }),

    capacityLimit: new client.Gauge({
      name: 'jtt_sessions_capacity_limit',
      help: 'MAX_ACTIVE_SESSIONS, the configured ceiling.',
      ...common,
    }),

    capacityRejections: new client.Counter({
      name: 'jtt_session_capacity_rejections_total',
      help: 'Start Lab requests refused because the platform was at capacity.',
      labelNames: ['track'],
      ...common,
    }),

    sessionLifetime: new client.Histogram({
      name: 'jtt_session_lifetime_seconds',
      help: 'How long sessions lived, by how they ended.',
      labelNames: ['provider', 'end_reason'],
      buckets: SESSION_LIFETIME_BUCKETS,
      ...common,
    }),

    stateTransitions: new client.Counter({
      name: 'jtt_session_state_transitions_total',
      help: 'Session lifecycle transitions.',
      labelNames: ['from', 'to'],
      ...common,
    }),

    labsLoaded: new client.Gauge({
      name: 'jtt_labs_loaded',
      help: 'Lab definitions loaded from disk at startup.',
      ...common,
    }),

    labLoadErrors: new client.Gauge({
      name: 'jtt_lab_load_errors',
      help: 'Lab definitions rejected at startup.',
      ...common,
    }),
  };
}

export interface ProviderMetrics {
  available: Gauge;
  probes: Counter;
  probeDuration: Histogram;
  labsPerProvider: Gauge;
}

export function createProviderMetrics(registry: Registry): ProviderMetrics {
  const common = { registers: [registry] };

  return {
    available: new client.Gauge({
      name: 'jtt_provider_available',
      help: 'Whether a provider can run a lab right now (1) or not (0).',
      labelNames: ['provider', 'implementation', 'sandbox_kind'],
      ...common,
    }),

    probes: new client.Counter({
      name: 'jtt_provider_availability_probe_total',
      help: 'Provider availability probes by result.',
      labelNames: ['provider', 'result'],
      ...common,
    }),

    probeDuration: new client.Histogram({
      name: 'jtt_provider_availability_probe_duration_seconds',
      help: 'How long a provider availability probe took.',
      labelNames: ['provider'],
      buckets: HTTP_BUCKETS,
      ...common,
    }),

    /*
     * Blast radius, as a number.
     *
     * "docker is unavailable" is a fact; "14 labs cannot start" is a decision.
     * Pairing the availability gauge with the catalogue count is what lets one
     * dashboard panel answer how much of the product is down.
     */
    labsPerProvider: new client.Gauge({
      name: 'jtt_provider_labs_total',
      help: 'Catalogue labs backed by each provider — the blast radius of an outage.',
      labelNames: ['provider'],
      ...common,
    }),
  };
}

export interface VerificationMetrics {
  checks: Counter;
  duration: Histogram;
  requirements: Counter;
  errors: Counter;
}

export function createVerificationMetrics(registry: Registry): VerificationMetrics {
  const common = { registers: [registry] };

  return {
    /*
     * `result` distinguishes pass / fail / error, and the distinction is the
     * whole value of the metric.
     *
     * `fail` is a student who has not finished yet — the most normal event in
     * the product, and alerting on it would page someone every time a class
     * starts. `error` is the environment being unreadable, which is an outage.
     * Collapsing them into "not passed" is the mistake this label exists to
     * prevent.
     */
    checks: new client.Counter({
      name: 'jtt_verification_total',
      help: 'Check Solution requests. result=pass|fail is normal; result=error is an outage.',
      labelNames: ['track', 'lab_id', 'result'],
      ...common,
    }),

    duration: new client.Histogram({
      name: 'jtt_verification_duration_seconds',
      help: 'Time to verify a lab against live state.',
      labelNames: ['track', 'provider'],
      buckets: VERIFY_BUCKETS,
      ...common,
    }),

    /*
     * Per requirement *type*, across all ~41 of them.
     *
     * Identifies which check family regressed after a content or platform
     * change, which a per-lab counter cannot: one broken handler shows up as a
     * scattering of unrelated labs failing.
     */
    requirements: new client.Counter({
      name: 'jtt_verification_requirement_total',
      help: 'Individual requirement checks by type and result.',
      labelNames: ['requirement_type', 'result'],
      ...common,
    }),

    errors: new client.Counter({
      name: 'jtt_verification_errors_total',
      help: 'Verification attempts that could not read the environment.',
      labelNames: ['code'],
      ...common,
    }),
  };
}

export interface DatabaseMetrics {
  up: Gauge;
  pingDuration: Histogram;
  poolConnections: Gauge;
  queryDuration: Histogram;
  queryErrors: Counter;
  storeInfo: Gauge;
  migrationsApplied: Gauge;
  migrationVersion: Gauge;
  authSessionsActive: Gauge;
  authSessionsPurged: Counter;
}

export function createDatabaseMetrics(registry: Registry): DatabaseMetrics {
  const common = { registers: [registry] };

  return {
    up: new client.Gauge({
      name: 'jtt_db_up',
      help: 'Whether the progress/session database answered its last health check.',
      ...common,
    }),

    pingDuration: new client.Histogram({
      name: 'jtt_db_ping_duration_seconds',
      help: 'Database health-check round trip.',
      buckets: DB_BUCKETS,
      ...common,
    }),

    poolConnections: new client.Gauge({
      name: 'jtt_db_pool_connections',
      help: 'pg pool connections by state. state=waiting above zero means the app is starved, not the database dead.',
      labelNames: ['state'],
      ...common,
    }),

    /*
     * `operation` is a bounded enum of repository method names.
     *
     * Never SQL text: query strings are unbounded, and a query containing a
     * literal would put request input into a label. The method name answers the
     * operational question ("which write is slow?") without either problem.
     */
    queryDuration: new client.Histogram({
      name: 'jtt_db_query_duration_seconds',
      help: 'Database operation duration, by repository operation name.',
      labelNames: ['operation'],
      buckets: DB_BUCKETS,
      ...common,
    }),

    queryErrors: new client.Counter({
      name: 'jtt_db_query_errors_total',
      help: 'Database operations that failed.',
      labelNames: ['operation', 'code'],
      ...common,
    }),

    /*
     * Whether history is actually durable.
     *
     * The API already falls back to an in-memory store when DATABASE_URL is
     * unset and says so in its startup log — which nobody reads three weeks
     * later, after a restart has silently discarded a cohort's progress. As a
     * metric it is alertable.
     */
    storeInfo: new client.Gauge({
      name: 'jtt_db_store_info',
      help: 'Which progress store is in use. Always 1; the store label carries it.',
      labelNames: ['store'],
      ...common,
    }),

    migrationsApplied: new client.Gauge({
      name: 'jtt_migrations_applied_total',
      help: 'Migrations applied to this database.',
      ...common,
    }),

    migrationVersion: new client.Gauge({
      name: 'jtt_migration_version_info',
      help: 'Latest applied migration. Always 1; the version label carries it.',
      labelNames: ['version'],
      ...common,
    }),

    authSessionsActive: new client.Gauge({
      name: 'jtt_auth_sessions_active',
      help: 'Browser sign-in sessions currently valid.',
      ...common,
    }),

    authSessionsPurged: new client.Counter({
      name: 'jtt_auth_sessions_purged_total',
      help: 'Expired browser sessions removed by the purge sweep.',
      ...common,
    }),
  };
}

export interface AuthMetrics {
  attempts: Counter;
  logins: Counter;
  callbacks: Counter;
  logouts: Counter;
  jwksFetches: Counter;
  authzDecisions: Counter;
}

export function createAuthMetrics(registry: Registry): AuthMetrics {
  const common = { registers: [registry] };

  return {
    attempts: new client.Counter({
      name: 'jtt_auth_attempts_total',
      help: 'Credential resolution attempts by outcome.',
      labelNames: ['mode', 'source', 'outcome'],
      ...common,
    }),

    logins: new client.Counter({
      name: 'jtt_auth_login_total',
      help: 'Sign-in flows started, by outcome.',
      labelNames: ['outcome'],
      ...common,
    }),

    callbacks: new client.Counter({
      name: 'jtt_auth_callback_total',
      help: 'OIDC callbacks by outcome. Non-success values are security-relevant.',
      labelNames: ['outcome'],
      ...common,
    }),

    logouts: new client.Counter({
      name: 'jtt_auth_logout_total',
      help: 'Sign-outs by outcome.',
      labelNames: ['outcome'],
      ...common,
    }),

    jwksFetches: new client.Counter({
      name: 'jtt_oidc_jwks_fetch_total',
      help: 'JWKS retrievals from the identity provider.',
      labelNames: ['outcome'],
      ...common,
    }),

    /*
     * The security metric.
     *
     * `result` is exactly `AuthAuditEvent.authorizationResult`, so the counter
     * and the audit log line can never disagree about what happened. A rising
     * `denied-not-owner` rate is somebody trying session ids that are not
     * theirs — the one signal that distinguishes a probe from a bug.
     */
    authzDecisions: new client.Counter({
      name: 'jtt_authz_decisions_total',
      help: 'Authorization decisions by action and result.',
      labelNames: ['action', 'result'],
      ...common,
    }),
  };
}

export interface ReaperMetrics {
  sweeps: Counter;
  sweepDuration: Histogram;
  lastSuccess: Gauge;
  reclaimed: Counter;
  orphansFound: Gauge;
  skipped: Counter;
  deleteFailures: Counter;
}

export function createReaperMetrics(registry: Registry): ReaperMetrics {
  const common = { registers: [registry] };

  return {
    sweeps: new client.Counter({
      name: 'jtt_reaper_sweeps_total',
      help: 'Cleanup sweeps by outcome.',
      labelNames: ['outcome'],
      ...common,
    }),

    sweepDuration: new client.Histogram({
      name: 'jtt_reaper_sweep_duration_seconds',
      help: 'How long a cleanup sweep took.',
      buckets: HTTP_BUCKETS,
      ...common,
    }),

    /*
     * The single most important reliability metric in the platform.
     *
     * Cleanup is what stops sandboxes accumulating until the host is full, and
     * it is entirely invisible when it works. A counter cannot express "it
     * stopped": the counter simply stops rising, which looks identical to a
     * quiet period. A last-success timestamp turns that into
     * `time() - jtt_reaper_last_success_timestamp_seconds`, which rises on its
     * own and alerts without anyone having to notice an absence.
     */
    lastSuccess: new client.Gauge({
      name: 'jtt_reaper_last_success_timestamp_seconds',
      help: 'Unix time of the last successful cleanup sweep.',
      ...common,
    }),

    reclaimed: new client.Counter({
      name: 'jtt_reaper_reclaimed_total',
      help: 'Sandboxes reclaimed, by why they were reclaimed.',
      labelNames: ['reason', 'provider'],
      ...common,
    }),

    orphansFound: new client.Gauge({
      name: 'jtt_reaper_orphans_found',
      help: 'Managed sandboxes the session store had no record of, at the last sweep.',
      labelNames: ['provider'],
      ...common,
    }),

    /*
     * A refusal to delete is a *safety* property, and one of its reasons is a
     * security signal: `foreign_owner` means something the platform does not
     * own is wearing its labels.
     */
    skipped: new client.Counter({
      name: 'jtt_reaper_skipped_total',
      help: 'Sandboxes the reaper declined to delete, by reason.',
      labelNames: ['reason'],
      ...common,
    }),

    deleteFailures: new client.Counter({
      name: 'jtt_reaper_delete_failures_total',
      help: 'Sandbox deletions that failed.',
      labelNames: ['provider', 'reason'],
      ...common,
    }),
  };
}

export interface TerminalMetrics {
  connectionsOpen: Gauge;
  connections: Counter;
  sessionDuration: Histogram;
  closes: Counter;
  reattaches: Counter;
  bytes: Counter;
}

export function createTerminalMetrics(registry: Registry): TerminalMetrics {
  const common = { registers: [registry] };

  return {
    connectionsOpen: new client.Gauge({
      name: 'jtt_terminal_connections_open',
      help: 'Student shells currently attached.',
      ...common,
    }),

    connections: new client.Counter({
      name: 'jtt_terminal_connections_total',
      help: 'Terminal connection attempts by outcome.',
      labelNames: ['outcome'],
      ...common,
    }),

    sessionDuration: new client.Histogram({
      name: 'jtt_terminal_session_duration_seconds',
      help: 'How long a student shell stayed attached.',
      buckets: SESSION_LIFETIME_BUCKETS,
      ...common,
    }),

    closes: new client.Counter({
      name: 'jtt_terminal_close_total',
      help: 'Terminal WebSocket closes by close code.',
      labelNames: ['code'],
      ...common,
    }),

    reattaches: new client.Counter({
      name: 'jtt_terminal_reattach_total',
      help: 'Shell reattachments after a sandbox reset.',
      labelNames: ['outcome'],
      ...common,
    }),

    /*
     * VOLUME ONLY. This counter is incremented from `chunk.length` and nothing
     * else: the buffer is never decoded, inspected, sampled, or logged.
     *
     * Student command content is the single most sensitive thing that flows
     * through this platform — it is a person's work, and on the Linux track it
     * routinely includes passwords they are being taught to set. A byte count
     * answers every operational question (is the shell alive, is something
     * flooding it) and reveals none of it.
     */
    bytes: new client.Counter({
      name: 'jtt_terminal_bytes_total',
      help: 'Bytes moved through student shells. Volume only — content is never inspected.',
      labelNames: ['direction'],
      ...common,
    }),
  };
}

export interface SandboxdMetrics {
  runtimeOps: Counter;
  runtimeOpDuration: Histogram;
  dockerOps: Counter;
  containersManaged: Gauge;
  runtimeUp: Gauge;
  shellsOpen: Gauge;
  attaches: Counter;
  scopeDenials: Counter;
}

export function createSandboxdMetrics(registry: Registry): SandboxdMetrics {
  const common = { registers: [registry] };

  return {
    runtimeOps: new client.Counter({
      name: 'jtt_sandboxd_runtime_ops_total',
      help: 'Runtime broker operations by verb and outcome.',
      labelNames: ['op', 'outcome'],
      ...common,
    }),

    runtimeOpDuration: new client.Histogram({
      name: 'jtt_sandboxd_runtime_op_duration_seconds',
      help: 'Runtime broker operation duration by verb.',
      labelNames: ['op'],
      buckets: RUNTIME_OP_BUCKETS,
      ...common,
    }),

    dockerOps: new client.Counter({
      name: 'jtt_sandboxd_docker_ops_total',
      help: 'Docker-track daemon operations by verb and outcome.',
      labelNames: ['op', 'outcome'],
      ...common,
    }),

    /*
     * The leak detector, one half of it.
     *
     * Compared against `jtt_sessions_active` on the Sandbox/Runtime dashboard:
     * containers the runtime holds minus sessions the store knows about is the
     * number of sandboxes nobody is paying attention to. It should sit at zero
     * and rise only briefly while a sweep is in flight.
     */
    containersManaged: new client.Gauge({
      name: 'jtt_sandboxd_containers_managed',
      help: 'Sandbox containers the runtime currently holds, by provider.',
      labelNames: ['provider'],
      ...common,
    }),

    /*
     * Distinct from `up{job="sandboxd"}`, and the distinction is the first
     * question incident exercise 2 asks: the broker being reachable and the
     * container runtime beneath it being usable are two different failures with
     * two different fixes.
     */
    runtimeUp: new client.Gauge({
      name: 'jtt_sandboxd_runtime_up',
      help: 'Whether the container runtime under the broker answered its last ping.',
      ...common,
    }),

    shellsOpen: new client.Gauge({
      name: 'jtt_sandboxd_shells_open',
      help: 'PTYs the broker currently holds open.',
      ...common,
    }),

    attaches: new client.Counter({
      name: 'jtt_sandboxd_attach_total',
      help: 'Shell attach attempts by outcome and, when denied, why.',
      labelNames: ['outcome', 'deny_reason'],
      ...common,
    }),

    /*
     * Should be flat zero forever.
     *
     * Each service holds only the scope secrets it needs, so a denial means
     * either a misconfiguration or something presenting a credential it should
     * not have. There is no benign explanation, which is why the alert on this
     * has no threshold above zero.
     */
    scopeDenials: new client.Counter({
      name: 'jtt_sandboxd_scope_denials_total',
      help: 'Requests refused for presenting the wrong capability credential. Expected to be zero.',
      labelNames: ['scope', 'endpoint'],
      ...common,
    }),
  };
}

export interface CreateRegistryOptions {
  service: string;
  /** Node process metrics: heap, event-loop lag, GC, file descriptors. */
  defaultMetrics?: boolean;
}

/**
 * A fresh registry with process metrics installed.
 *
 * Not the `prom-client` global registry: a global would make two servers in one
 * test process share state, and the health/readiness suites do exactly that.
 */
export function createRegistry(options: CreateRegistryOptions): Registry {
  const registry = new client.Registry();
  registry.setDefaultLabels({});
  if (options.defaultMetrics !== false) {
    client.collectDefaultMetrics({ register: registry, prefix: 'jtt_' });
  }
  return registry;
}

/**
 * Read a gauge from its source of truth at scrape time.
 *
 * ## Why not just increment a counter as things happen
 *
 * Because the two disagree, and the disagreement is silent. A counter the
 * application maintains drifts whenever an increment is missed on an error
 * path, and error paths are exactly where sessions and sandboxes go missing.
 * A gauge that reads the store at the moment of the scrape cannot drift: if
 * the number is wrong, the store is wrong, which is a bug worth seeing.
 *
 * That property is load-bearing for `jtt_sessions_active` and
 * `jtt_sandboxd_containers_managed`, because the leak alert is a *comparison*
 * of the two. Two independently drifting counters would produce a permanent
 * false difference and the alert would be turned off within a week.
 *
 * The collector is awaited by `prom-client`, so an async read of the database
 * or the container runtime is safe here. It must still be cheap: it runs on
 * every scrape, once per fifteen seconds.
 */
export function setCollector(
  metric: Gauge,
  collect: (metric: Gauge) => void | Promise<void>,
): void {
  (metric as unknown as { collect: () => void | Promise<void> }).collect = function collector(
    this: Gauge,
  ) {
    return collect(this);
  };
}

export { assertLabelPolicy };
export { client as promClient };
