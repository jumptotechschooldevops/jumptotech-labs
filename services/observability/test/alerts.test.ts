/**
 * PLATFORM-003 — the alert rules are actionable.
 *
 * `promtool check rules` proves the YAML parses and the PromQL is well-formed.
 * It cannot prove the two things that decide whether an alert is any use at
 * 2am:
 *
 *   · it names a metric that exists — otherwise it can never fire, and an
 *     alert that can never fire is indistinguishable from a healthy platform;
 *   · it links to a runbook that exists — a dead link costs an operator the two
 *     minutes they spend looking for it, at the worst possible moment.
 *
 * Both are checked here, against the real metric catalogue and the real
 * `docs/runbooks/` directory.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
const ALERTS_DIR = path.join(REPO_ROOT, 'infrastructure/observability/prometheus/alerts');
const RECORDING = path.join(
  REPO_ROOT,
  'infrastructure/observability/prometheus/rules/recording.yml',
);

interface Rule {
  alert: string;
  expr: string;
  for?: string;
  severity?: string;
  summary?: string;
  runbook?: string;
  file: string;
}

/**
 * A deliberately small YAML reader.
 *
 * Adding a YAML dependency to this package for one test would put a parser in
 * the dependency tree of the module that every service loads at startup. The
 * rule files have a fixed, machine-generated shape, and `promtool` is what
 * actually validates them — this only has to pull four fields out.
 */
function parseAlerts(file: string): Rule[] {
  const text = readFileSync(path.join(ALERTS_DIR, file), 'utf8');
  const rules: Rule[] = [];
  let current: Partial<Rule> | null = null;

  const push = (): void => {
    if (current?.alert && current.expr) rules.push({ ...current, file } as Rule);
    current = null;
  };

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const alert = /^\s*-\s*alert:\s*(\S.*)$/.exec(line);
    if (alert) {
      push();
      current = { alert: alert[1]!.trim() };
      continue;
    }
    if (!current) continue;

    const expr = /^\s*expr:\s*(.*)$/.exec(line);
    if (expr) {
      let value = expr[1]!.trim();
      // A `|`-style block scalar continues on the following indented lines.
      if (value === '|' || value === '>-' || value === '>') {
        value = '';
        for (let j = i + 1; j < lines.length; j += 1) {
          const next = lines[j]!;
          if (next.trim() === '' || /^\s{10,}/.test(next)) {
            value += ` ${next.trim()}`;
          } else break;
        }
      }
      current.expr = value.trim();
      continue;
    }
    const sev = /^\s*severity:\s*(\S+)$/.exec(line);
    if (sev) current.severity = sev[1];
    const rb = /^\s*runbook_url:\s*(\S+)$/.exec(line);
    if (rb) current.runbook = rb[1];
    const sm = /^\s*summary:\s*(.*)$/.exec(line);
    if (sm) current.summary = sm[1]!.trim();
    const f = /^\s*for:\s*(\S+)$/.exec(line);
    if (f) current.for = f[1];
  }
  push();
  return rules;
}

function knownSeries(): Set<string> {
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

  const names = new Set<string>(['up']);
  for (const metric of registry.getMetricsAsArray()) {
    names.add(metric.name);
    names.add(`${metric.name}_bucket`);
    names.add(`${metric.name}_sum`);
    names.add(`${metric.name}_count`);
  }
  const yaml = readFileSync(RECORDING, 'utf8');
  for (const m of yaml.matchAll(/^\s*-\s*record:\s*(\S+)/gm)) names.add(m[1]!);
  return names;
}

const PROMQL_WORDS = new Set([
  'sum', 'rate', 'irate', 'increase', 'avg', 'min', 'max', 'count', 'by', 'without',
  'on', 'ignoring', 'group_left', 'group_right', 'histogram_quantile', 'clamp_min',
  'clamp_max', 'time', 'vector', 'scalar', 'abs', 'ceil', 'floor', 'round', 'topk',
  'and', 'or', 'unless', 'offset', 'bool', 'le', 'absent', 'changes',
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
  const out = new Set<string>();
  for (const m of withoutLabels.matchAll(/\b([a-zA-Z_:][a-zA-Z0-9_:]*)\b/g)) {
    const name = m[1]!;
    if (PROMQL_WORDS.has(name) || /^\d/.test(name)) continue;
    out.add(name);
  }
  return [...out];
}

const files = readdirSync(ALERTS_DIR).filter((f) => f.endsWith('.yml')).sort();
const rules = files.flatMap(parseAlerts);
const known = knownSeries();

describe('the alert set', () => {
  it('parses every rule file', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(rules.length).toBeGreaterThanOrEqual(25);
  });

  it('covers every subject an operator has to be woken for', () => {
    const names = rules.map((r) => r.alert);
    for (const required of [
      'ServiceDown',
      'DatabaseDown',
      'LabStartsFailingHard',
      'CapacityExhausted',
      'ReaperStalled',
      'SandboxdRuntimeDown',
      'SandboxLeakSuspected',
      'ProviderUnavailable',
      'TerminalConnectionFailures',
      'VerificationErrorRate',
      'AuthFailureSpike',
      'ScopeDenialDetected',
      'ProgressStoreIsMemory',
    ]) {
      expect(names, `no alert named ${required}`).toContain(required);
    }
  });

  it('gives every alert a unique name', () => {
    const names = rules.map((r) => r.alert);
    expect(new Set(names).size, `duplicate alert names: ${names.join(', ')}`).toBe(names.length);
  });
});

describe.each(rules.map((r): [string, Rule] => [r.alert, r]))('%s', (_name, rule) => {
  it('names only metrics that exist', () => {
    const unknown = metricNamesIn(rule.expr).filter((n) => !known.has(n));
    expect(
      unknown,
      `${rule.alert} in ${rule.file} references ${unknown.join(', ')} — it can never fire, ` +
        `which is indistinguishable from a healthy platform`,
    ).toEqual([]);
  });

  it('declares a severity the routing understands', () => {
    expect(['critical', 'warning']).toContain(rule.severity);
  });

  it('says what happened', () => {
    expect(rule.summary, `${rule.alert} has no summary`).toBeTruthy();
  });

  it('links to a runbook that exists', () => {
    expect(rule.runbook, `${rule.alert} has no runbook_url`).toBeTruthy();
    const target = path.join(REPO_ROOT, rule.runbook!);
    expect(
      existsSync(target),
      `${rule.alert} points at ${rule.runbook}, which does not exist — a dead runbook link ` +
        `costs an operator two minutes at the worst possible moment`,
    ).toBe(true);
  });
});

describe('thresholds are sane', () => {
  it('gives every alert but the zero-tolerance ones a `for` duration', () => {
    /*
     * `for: 0m` is correct for exactly two kinds of alert: a security event
     * with no benign explanation, and a safety mechanism that has stopped.
     * Everywhere else it means the alert fires on a single scrape and will
     * flap.
     */
    const ZERO_TOLERANCE = [
      'ScopeDenialDetected',
      'ReaperStalled',
      'ReaperDeleteFailures',
      'ReaperRefusingForeignOwner',
      'SecurityEventBurst',
      'MetricsScrapeDenied',
    ];
    for (const rule of rules) {
      if (ZERO_TOLERANCE.includes(rule.alert)) continue;
      expect(rule.for, `${rule.alert} has no 'for' and would fire on one scrape`).toBeTruthy();
      expect(rule.for).not.toBe('0m');
    }
  });

  it('never alerts on a verification *failure*, only on an error', () => {
    // A student who has not solved the lab yet is the most normal event in the
    // product. An alert on it would page somebody every time a class starts.
    for (const rule of rules) {
      if (!rule.expr.includes('jtt_verification')) continue;
      expect(rule.expr, `${rule.alert} would fire on ordinary student failures`).not.toMatch(
        /result="fail"/,
      );
    }
  });
});
