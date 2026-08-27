/**
 * PLATFORM-003 — the label policy, over the real metric catalogue.
 *
 * This walks every metric the platform actually constructs, not a list somebody
 * maintains. A metric added tomorrow with a `session_id` label fails here
 * whether or not anyone remembered this file exists — which is the only version
 * of this check worth having.
 */
import { describe, expect, it } from 'vitest';

import {
  assertLabelPolicy,
  checkLabelNames,
  createAuthMetrics,
  createCommonMetrics,
  createDatabaseMetrics,
  createProviderMetrics,
  createReaperMetrics,
  createRegistry,
  createSandboxdMetrics,
  createSessionMetrics,
  createTerminalMetrics,
  createVerificationMetrics,
  LabelPolicyViolation,
  promClient,
} from '../src/index.js';

/** Every group the platform can construct, in one registry. */
function fullCatalogue() {
  const registry = createRegistry({ service: 'test', defaultMetrics: true });
  createCommonMetrics(registry, 'test');
  createSessionMetrics(registry);
  createProviderMetrics(registry);
  createVerificationMetrics(registry);
  createDatabaseMetrics(registry);
  createAuthMetrics(registry);
  createReaperMetrics(registry);
  createTerminalMetrics(registry);
  createSandboxdMetrics(registry);
  return registry;
}

describe('the whole platform metric catalogue obeys the label policy', () => {
  it('declares no forbidden or unpermitted label anywhere', () => {
    expect(() => assertLabelPolicy(fullCatalogue())).not.toThrow();
  });

  it('covers a substantial catalogue, so a passing run means something', () => {
    const names = fullCatalogue()
      .getMetricsAsArray()
      .map((m) => m.name)
      .filter((n) => n.startsWith('jtt_'));
    expect(names.length).toBeGreaterThan(45);
  });

  it('names every metric with the jtt_ prefix', () => {
    for (const metric of fullCatalogue().getMetricsAsArray()) {
      expect(metric.name, `${metric.name} is missing the jtt_ prefix`).toMatch(/^jtt_/);
    }
  });

  it('suffixes counters with _total', () => {
    const registry = fullCatalogue();
    for (const metric of registry.getMetricsAsArray()) {
      const type = (metric as unknown as { type?: string }).type;
      // `jtt_process_*` and `jtt_nodejs_*` come from collectDefaultMetrics and
      // follow upstream's naming, which predates ours.
      if (type !== 'counter') continue;
      if (/^jtt_(process|nodejs)_/.test(metric.name)) continue;
      expect(metric.name, `${metric.name} is a counter without _total`).toMatch(/_total$/);
    }
  });

  it('suffixes histograms with a base unit', () => {
    for (const metric of fullCatalogue().getMetricsAsArray()) {
      const type = (metric as unknown as { type?: string }).type;
      if (type !== 'histogram') continue;
      if (/^jtt_(process|nodejs)_/.test(metric.name)) continue;
      expect(metric.name, `${metric.name} is a histogram without a unit suffix`).toMatch(
        /_(seconds|bytes)$/,
      );
    }
  });
});

describe('the policy actually refuses what it claims to', () => {
  const IDENTIFYING = [
    'user_id',
    'student_id',
    'session_id',
    'attempt_id',
    'email',
    'display_name',
    'subject',
    'namespace',
    'sandbox_ref',
    'container_id',
    'ip',
    'token',
    'cookie',
    'authorization',
    'path',
    'url',
    'query',
    'command',
  ];

  for (const label of IDENTIFYING) {
    it(`refuses '${label}'`, () => {
      expect(checkLabelNames('jtt_example_total', [label])).toHaveLength(1);
    });
  }

  it('refuses a label that is merely unknown, not only a listed one', () => {
    const violations = checkLabelNames('jtt_example_total', ['some_new_dimension']);
    expect(violations[0]).toContain('not on the permitted list');
  });

  it('throws over a registry containing a violating metric', () => {
    const registry = createRegistry({ service: 'test', defaultMetrics: false });
    new promClient.Counter({
      name: 'jtt_bad_total',
      help: 'deliberately wrong',
      labelNames: ['session_id'],
      registers: [registry],
    });
    expect(() => assertLabelPolicy(registry)).toThrow(LabelPolicyViolation);
  });

  it('explains why, rather than only refusing', () => {
    // A developer adding session_id believed it was a good idea. The failure
    // has to be an argument, not a rejection, or it just gets worked around.
    try {
      assertLabelPolicy(
        (() => {
          const registry = createRegistry({ service: 'test', defaultMetrics: false });
          new promClient.Counter({
            name: 'jtt_bad_total',
            help: 'x',
            labelNames: ['session_id'],
            registers: [registry],
          });
          return registry;
        })(),
      );
      expect.unreachable('expected a policy violation');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('one series per lab session');
      expect(message).toContain('put it on the LOG LINE');
    }
  });
});

describe('the metrics an operator most needs are present', () => {
  const REQUIRED = [
    'jtt_http_requests_total',
    'jtt_http_request_duration_seconds',
    'jtt_lab_start_total',
    'jtt_lab_provision_duration_seconds',
    'jtt_lab_provision_step_duration_seconds',
    'jtt_sessions_active',
    'jtt_sessions_capacity_limit',
    'jtt_session_capacity_rejections_total',
    'jtt_provider_available',
    'jtt_provider_labs_total',
    'jtt_sandboxd_runtime_ops_total',
    'jtt_sandboxd_runtime_up',
    'jtt_sandboxd_containers_managed',
    'jtt_sandboxd_scope_denials_total',
    'jtt_terminal_connections_total',
    'jtt_terminal_bytes_total',
    'jtt_verification_total',
    'jtt_verification_requirement_total',
    'jtt_db_up',
    'jtt_db_pool_connections',
    'jtt_db_store_info',
    'jtt_reaper_last_success_timestamp_seconds',
    'jtt_reaper_orphans_found',
    'jtt_reaper_reclaimed_total',
    'jtt_auth_attempts_total',
    'jtt_authz_decisions_total',
    'jtt_security_events_total',
    'jtt_build_info',
    'jtt_config_info',
    'jtt_readyz_ok',
  ];

  const present = new Set(fullCatalogue().getMetricsAsArray().map((m) => m.name));

  for (const name of REQUIRED) {
    it(`exposes ${name}`, () => {
      expect(present.has(name)).toBe(true);
    });
  }
});

describe('the terminal byte counter is volume-only', () => {
  it('carries no label that could describe content', () => {
    const registry = createRegistry({ service: 'test', defaultMetrics: false });
    createTerminalMetrics(registry);
    const bytes = registry
      .getMetricsAsArray()
      .find((m) => m.name === 'jtt_terminal_bytes_total') as
      | { labelNames?: readonly string[] }
      | undefined;
    expect(bytes?.labelNames).toEqual(['direction']);
  });
});
