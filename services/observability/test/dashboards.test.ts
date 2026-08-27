/**
 * PLATFORM-003 — the dashboards reference metrics that exist.
 *
 * ## Why this is the most valuable test in the operational layer
 *
 * A Grafana panel whose query names a metric that was renamed does not error.
 * It renders an **empty graph**. During an incident an empty graph reads as
 * "this value is zero" — the platform is fine, the queue is empty, nothing is
 * leaking — which is worse than no panel at all, because it actively argues
 * against the truth.
 *
 * Nothing else catches it. The dashboard is valid JSON, Grafana loads it
 * happily, Prometheus answers the query with an empty result, and the first
 * person to find out is someone at 2am deciding not to escalate.
 *
 * So every `expr` in every dashboard is parsed for metric names and checked
 * against the registry this platform actually builds.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
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
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DASHBOARD_DIR = path.join(REPO_ROOT, 'infrastructure/observability/grafana/dashboards');
const RULES_DIR = path.join(REPO_ROOT, 'infrastructure/observability/prometheus');

/** Every metric name this platform can expose, across all three services. */
function knownMetricNames(): Set<string> {
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

  const names = new Set<string>();
  for (const metric of registry.getMetricsAsArray()) {
    names.add(metric.name);
    // Histograms are exposed as three derived series; a dashboard querying a
    // `_bucket` is querying a metric that exists even though the registry
    // records only the base name.
    names.add(`${metric.name}_bucket`);
    names.add(`${metric.name}_sum`);
    names.add(`${metric.name}_count`);
  }
  return names;
}

/** Recording-rule names, which dashboards may reference like any other metric. */
function recordedSeriesNames(): Set<string> {
  const yaml = readFileSync(path.join(RULES_DIR, 'rules/recording.yml'), 'utf8');
  return new Set([...yaml.matchAll(/^\s*-\s*record:\s*(\S+)/gm)].map((m) => m[1]!));
}

/**
 * Metric names appearing in a PromQL expression.
 *
 * A deliberately simple scanner rather than a parser: it takes every
 * identifier that is not a PromQL keyword, function, label name, or the
 * left-hand side of a label matcher. Over-reporting is safe — an extra name
 * that turns out to be known costs nothing — and under-reporting is what would
 * make the test useless, so the bias is towards catching too much.
 */
const PROMQL_WORDS = new Set([
  'sum', 'rate', 'irate', 'increase', 'avg', 'min', 'max', 'count', 'by', 'without',
  'on', 'ignoring', 'group_left', 'group_right', 'histogram_quantile', 'clamp_min',
  'clamp_max', 'time', 'vector', 'scalar', 'abs', 'ceil', 'floor', 'round', 'topk',
  'bottomk', 'quantile', 'stddev', 'stdvar', 'delta', 'idelta', 'changes', 'and',
  'or', 'unless', 'offset', 'bool', 'le', 'absent', 'absent_over_time', 'label_replace',
  'humanizeDuration', 'sort', 'sort_desc', 'predict_linear', 'deriv',
]);

function stripNonMetricIdentifiers(expr: string): string {
  return (
    expr
      // Label matcher blocks: `{service="api"}` holds label names, not metrics.
      .replace(/\{[^}]*\}/g, '')
      // Grouping clauses: `by (le, provider)` and `without (...)`, plus the
      // vector-matching modifiers. Everything inside their parentheses is a
      // label name — treating those as metrics is what made an earlier version
      // of this scanner report `outcome` and `result` as missing metrics.
      .replace(/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' ')
      // String literals, which can hold anything at all.
      .replace(/"[^"]*"/g, ' ')
      .replace(/'[^']*'/g, ' ')
  );
}

function metricNamesIn(expr: string): string[] {
  const withoutLabels = stripNonMetricIdentifiers(expr);
  const found = new Set<string>();
  for (const match of withoutLabels.matchAll(/\b([a-zA-Z_:][a-zA-Z0-9_:]*)\b/g)) {
    const name = match[1]!;
    if (PROMQL_WORDS.has(name)) continue;
    // Bare numbers, durations, and quantile arguments.
    if (/^\d/.test(name)) continue;
    found.add(name);
  }
  return [...found];
}

interface Panel {
  id?: number;
  type?: string;
  title?: string;
  targets?: Array<{ expr?: string }>;
  panels?: Panel[];
}

interface Dashboard {
  uid?: string;
  title?: string;
  panels?: Panel[];
  annotations?: { list?: Array<{ expr?: string; name?: string }> };
}

function flatten(panels: Panel[] = []): Panel[] {
  return panels.flatMap((panel) => [panel, ...flatten(panel.panels ?? [])]);
}

const files = readdirSync(DASHBOARD_DIR).filter((f) => f.endsWith('.json')).sort();
const known = knownMetricNames();
const recorded = recordedSeriesNames();
const resolvable = new Set([...known, ...recorded, 'up']);

describe('the dashboard set is complete', () => {
  it('ships the eight dashboards the story requires', () => {
    expect(files).toHaveLength(8);
  });

  it('covers every required subject', () => {
    const titles = files.map((f) =>
      (JSON.parse(readFileSync(path.join(DASHBOARD_DIR, f), 'utf8')) as Dashboard).title ?? '',
    );
    for (const subject of [
      'Platform Overview',
      'Lab Sessions',
      'Providers',
      'Sandbox / Runtime',
      'API',
      'Terminal',
      'Database',
      'Auth / Security',
    ]) {
      expect(titles.some((t) => t.includes(subject)), `no dashboard for ${subject}`).toBe(true);
    }
  });

  it('gives every dashboard a unique uid', () => {
    const uids = files.map(
      (f) => (JSON.parse(readFileSync(path.join(DASHBOARD_DIR, f), 'utf8')) as Dashboard).uid,
    );
    expect(new Set(uids).size).toBe(uids.length);
  });
});

describe.each(files)('%s', (file) => {
  const dashboard = JSON.parse(
    readFileSync(path.join(DASHBOARD_DIR, file), 'utf8'),
  ) as Dashboard;
  const panels = flatten(dashboard.panels).filter((p) => p.type !== 'row');

  it('is valid JSON with a title, uid and panels', () => {
    expect(dashboard.title).toBeTruthy();
    expect(dashboard.uid).toBeTruthy();
    expect(panels.length).toBeGreaterThan(0);
  });

  it('gives every panel a title and at least one query', () => {
    for (const panel of panels) {
      expect(panel.title, `panel ${panel.id} has no title`).toBeTruthy();
      expect(panel.targets?.length, `panel "${panel.title}" has no target`).toBeGreaterThan(0);
    }
  });

  it('references only metrics this platform actually exposes', () => {
    const unknown: string[] = [];
    for (const panel of panels) {
      for (const target of panel.targets ?? []) {
        for (const name of metricNamesIn(target.expr ?? '')) {
          if (!resolvable.has(name)) unknown.push(`${panel.title}: ${name}`);
        }
      }
    }
    expect(
      unknown,
      `these queries name metrics that do not exist — the panel would render empty, ` +
        `which during an incident reads as "the value is zero":\n  ${unknown.join('\n  ')}`,
    ).toEqual([]);
  });

  it('points every panel at the provisioned datasource', () => {
    for (const panel of panels) {
      for (const target of panel.targets ?? []) {
        const ds = (target as { datasource?: { uid?: string } }).datasource;
        expect(ds?.uid, `panel "${panel.title}" targets a different datasource`).toBe(
          'jtt-prometheus',
        );
      }
    }
  });

  it('carries the deploy annotation, so every panel can answer "what changed?"', () => {
    const annotation = dashboard.annotations?.list?.[0];
    expect(annotation?.expr).toContain('jtt_process_start_time_seconds');
  });
});

describe('the dashboards never expose an identifying dimension', () => {
  /*
   * The label policy stops a metric being *created* with a forbidden label.
   * This is the other half: a query that groups by one would either return
   * nothing or, worse, would work if somebody later added the label.
   */
  const FORBIDDEN = ['session_id', 'user_id', 'student_id', 'attempt_id', 'email', 'namespace', 'sandbox_ref'];

  it.each(files)('%s groups by nothing identifying', (file) => {
    const raw = readFileSync(path.join(DASHBOARD_DIR, file), 'utf8');
    for (const label of FORBIDDEN) {
      expect(raw, `${file} references the forbidden label ${label}`).not.toContain(label);
    }
  });
});
