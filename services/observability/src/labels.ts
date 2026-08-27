/**
 * The metric label policy — PLATFORM-003.
 *
 * ## Why labels get a policy when log fields already have one
 *
 * They fail differently, and the metric failure is worse.
 *
 * A log line is written once, read by an operator, and aged out. A Prometheus
 * label creates a **time series**, which is retained for weeks, replicated into
 * every dashboard, and readable by everyone with Grafana access. Putting a
 * `session_id` on a counter does two bad things at once: it identifies a
 * person's activity in a store with a much wider audience and a much longer
 * memory than the log store, and it creates one series per session — which at
 * a cohort's rate is tens of thousands of series that never stop existing,
 * because Prometheus has no way to know a session ended.
 *
 * That is why `userId` and `sessionId` are *permitted in logs and forbidden in
 * metrics*. It is not an inconsistency; the two stores have different
 * retention, different audiences, and different failure modes.
 *
 * ## What is allowed, and why each is bounded
 *
 *   `lab_id`           114 values, from the catalogue. Non-personal, and the
 *                      single most useful debugging dimension there is.
 *   `track`            9 values.
 *   `provider`         9 values.
 *   `route`            ~20 Express *templates*. Never a raw path, which would
 *                      carry ids and be unbounded.
 *   `op`               11 broker verbs.
 *   `outcome`/`reason` closed enums defined at each call site.
 *
 * ## Enforcement
 *
 * `assertLabelPolicy` walks the live registry after every metric is
 * constructed, so this is checked against what the process actually built
 * rather than against what anyone believes it built. `metrics-labels.test.ts`
 * runs it over the full platform metric set.
 */

/** Label names any metric may carry. */
export const PERMITTED_LABELS: ReadonlySet<string> = new Set([
  'service',
  'method',
  'route',
  'status',
  'status_class',
  'provider',
  'implementation',
  'sandbox_kind',
  'track',
  'lab_id',
  'op',
  // A provisioning step name, from the fixed `steps` array each provider
  // returns. Bounded by the provider implementations, not by request input.
  'step',
  // A repository method name, from a closed enum in `progress`. Never SQL, and
  // never anything derived from a request.
  'operation',
  'outcome',
  'reason',
  'result',
  'code',
  'requirement_type',
  'state',
  'direction',
  'scope',
  'endpoint',
  'event',
  'mode',
  'source',
  'action',
  'from',
  'to',
  'store',
  'version',
  'commit',
  'node_version',
  'auth_mode',
  'lab_provider',
  'deny_reason',
  'end_reason',
  'le',
  'quantile',
]);

/**
 * Label names that must never appear.
 *
 * Listed explicitly rather than relying on the allow-list alone, so the failure
 * message can say *why* — an allow-list violation reads as an oversight, and
 * these are not oversights. Someone adding `session_id` believed it was a good
 * idea, and deserves the reasoning rather than a rejection.
 */
export const FORBIDDEN_LABELS: ReadonlyMap<string, string> = new Map([
  ['user_id', 'identifies a person and is unbounded — use it in logs, never in a series'],
  ['userid', 'identifies a person and is unbounded — use it in logs, never in a series'],
  ['student_id', 'identifies a person and is unbounded — use it in logs, never in a series'],
  ['session_id', 'unbounded: one series per lab session, retained after the session is gone'],
  ['sessionid', 'unbounded: one series per lab session, retained after the session is gone'],
  ['attempt_id', 'unbounded: one series per attempt'],
  ['email', 'personal data, and this platform holds real addresses from an identity provider'],
  ['display_name', 'personal data'],
  ['subject', 'the external identity of a person'],
  ['issuer', 'reveals identity-provider configuration; use jtt_config_info if needed'],
  ['namespace', 'derived from a session id — unbounded, and a session handle'],
  ['sandbox_ref', 'derived from a session id — unbounded, and a sandbox handle'],
  ['container', 'unbounded, and a sandbox handle'],
  ['container_id', 'unbounded, and a sandbox handle'],
  ['ip', 'personal data under most regimes, and unbounded'],
  ['remote_addr', 'personal data under most regimes, and unbounded'],
  ['token', 'a credential must never reach a metric'],
  ['secret', 'a credential must never reach a metric'],
  ['cookie', 'a credential must never reach a metric'],
  ['authorization', 'a credential must never reach a metric'],
  ['path', 'raw paths carry ids — use the route template instead'],
  ['url', 'raw URLs carry ids and query strings'],
  ['query', 'carries request input'],
  ['command', 'student command content must never leave the sandbox'],
  ['message', 'free text is unbounded'],
  ['detail', 'free text is unbounded'],
]);

export class LabelPolicyViolation extends Error {
  readonly code = 'LABEL_POLICY_VIOLATION';

  constructor(readonly violations: readonly string[]) {
    super(
      [
        'A metric declares a label the observability policy forbids:',
        '',
        ...violations.map((v) => `  · ${v}`),
        '',
        'Prometheus series are retained for weeks, are readable by everyone with',
        'Grafana access, and are never garbage-collected when the thing they name',
        'stops existing. An identifying or unbounded label is therefore both a',
        'privacy leak and a cardinality leak.',
        '',
        'If you need this dimension for debugging, put it on the LOG LINE — logs',
        'are access-controlled, retention-bounded, and already carry requestId,',
        'sessionId and userId for exactly this purpose.',
        '',
        'See services/observability/src/labels.ts.',
      ].join('\n'),
    );
    this.name = 'LabelPolicyViolation';
  }
}

/** Check one metric's declared label names. Returns human-readable violations. */
export function checkLabelNames(metricName: string, labelNames: readonly string[]): string[] {
  const violations: string[] = [];
  for (const label of labelNames) {
    const forbidden = FORBIDDEN_LABELS.get(label.toLowerCase());
    if (forbidden) {
      violations.push(`${metricName} declares '${label}': ${forbidden}`);
      continue;
    }
    if (!PERMITTED_LABELS.has(label)) {
      violations.push(
        `${metricName} declares '${label}', which is not on the permitted list. ` +
          `Add it to PERMITTED_LABELS only if it is bounded and non-identifying.`,
      );
    }
  }
  return violations;
}

/**
 * Metrics this policy does not govern, because we did not name them.
 *
 * `collectDefaultMetrics` publishes Node's own process telemetry under our
 * prefix, and its label names are upstream's choice: `type` (handle kinds),
 * `space` (V8 heap spaces), `version`/`major`/`minor`/`patch` (the Node
 * version), `kind` (GC kind).
 *
 * Every one was audited and is bounded and non-identifying, so the exemption is
 * a *scoping* decision rather than a hole: the policy governs the metrics this
 * platform authors. Adding those label names to `PERMITTED_LABELS` instead
 * would have been the wrong fix — it would silently permit `major` or `kind` on
 * one of our own metrics, where they would mean something quite different and
 * nobody would have thought about the cardinality.
 */
const UNGOVERNED_PREFIXES = ['jtt_process_', 'jtt_nodejs_'];

function isGoverned(metricName: string): boolean {
  return !UNGOVERNED_PREFIXES.some((prefix) => metricName.startsWith(prefix));
}

/**
 * Assert the policy across a whole registry.
 *
 * Reads `registry.getMetricsAsArray()` — the metrics that actually exist in
 * this process — so it cannot be fooled by a metric that is declared somewhere
 * and never registered, nor miss one registered dynamically.
 */
export function assertLabelPolicy(registry: {
  getMetricsAsArray(): Array<{ name: string; labelNames?: readonly string[] }>;
}): void {
  const violations: string[] = [];
  for (const metric of registry.getMetricsAsArray()) {
    if (!isGoverned(metric.name)) continue;
    violations.push(...checkLabelNames(metric.name, metric.labelNames ?? []));
  }
  if (violations.length > 0) throw new LabelPolicyViolation(violations);
}
