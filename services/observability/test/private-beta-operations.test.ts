/**
 * BETA-P0-018 — the private-beta operations contract, from the files as shipped.
 *
 * `promtool test rules` (tests/private-beta-alerts.test.yml) proves the alerts
 * behave. This proves the things promtool cannot see, because they are about
 * how the alerts relate to the rest of the repository:
 *
 *   · the certificate alerts use BETA-P0-017's own expiry thresholds and status
 *     codes, so `npm run tls:check` and a page can never disagree;
 *   · the capacity alerts follow the deployed ceiling, and read counters that
 *     exist from the first scrape;
 *   · no alert that counts events asks to stay true longer than its window can
 *     hold a burst — the IE-3 defect, which `CapacityExhausted` and
 *     `JwksFetchFailing` still had;
 *   · the backup scripts and the API agree on the status file they share;
 *   · monitoring joins production without becoming reachable — from the
 *     internet, from the host's other interfaces, or from the containers
 *     students have shells in;
 *   · the operator dashboard answers the questions the beta is run by;
 *   · the new metrics carry no identifying or secret label.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BACKUP_OPERATIONS,
  DEFAULT_EXPIRY_THRESHOLDS,
  LAB_START_OUTCOMES,
  assertLabelPolicy,
  createAuthMetrics,
  createOperationsMetrics,
  createReaperMetrics,
  createRegistry,
  createSessionMetrics,
  exitCodeFor,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROMETHEUS = 'infrastructure/observability/prometheus';

const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const withoutComments = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

interface Rule {
  name: string;
  kind: 'alert' | 'record';
  expr: string;
  for?: string;
  severity?: string;
  file: string;
}

/** Rules from a Prometheus rule file: name, expr (single-line or block), for, severity. */
function parseRules(file: string): Rule[] {
  const lines = withoutComments(read(file)).split('\n');
  const rules: Rule[] = [];
  let current: Rule | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const head = /^\s*-\s*(alert|record):\s*(\S+)\s*$/.exec(line);
    if (head) {
      if (current) rules.push(current);
      current = { name: head[2]!, kind: head[1] as Rule['kind'], expr: '', file };
      continue;
    }
    if (!current) continue;
    const expr = /^(\s*)expr:\s*(.*)$/.exec(line);
    if (expr) {
      const indent = expr[1]!.length;
      let value = expr[2]!.trim();
      if (value === '|' || value === '>-' || value === '>') {
        value = '';
        for (let j = i + 1; j < lines.length; j += 1) {
          const next = lines[j]!;
          if (next.trim() !== '' && next.search(/\S/) <= indent) break;
          value += ` ${next.trim()}`;
        }
      }
      current.expr = value.trim();
      continue;
    }
    const forMatch = /^\s*for:\s*(\S+)\s*$/.exec(line);
    if (forMatch) current.for = forMatch[1];
    const severity = /^\s*severity:\s*(\S+)\s*$/.exec(line);
    if (severity) current.severity = severity[1];
  }
  if (current) rules.push(current);
  return rules;
}

const ALERT_FILES = readdirSync(path.join(REPO_ROOT, PROMETHEUS, 'alerts'))
  .filter((file) => file.endsWith('.yml'))
  .map((file) => `${PROMETHEUS}/alerts/${file}`);
const ALERTS = ALERT_FILES.flatMap(parseRules).filter((rule) => rule.kind === 'alert');
const RECORDS = parseRules(`${PROMETHEUS}/rules/recording.yml`).filter((rule) => rule.kind === 'record');

function alert(name: string): Rule {
  const found = ALERTS.find((rule) => rule.name === name);
  expect(found, `no alert named ${name}`).toBeDefined();
  return found!;
}

function record(name: string): Rule {
  const found = RECORDS.find((rule) => rule.name === name);
  expect(found, `no recording rule named ${name}`).toBeDefined();
  return found!;
}

function seconds(duration: string): number {
  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) throw new Error(`unreadable duration ${duration}`);
  return Number(match[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as 's' | 'm' | 'h' | 'd'];
}

describe('the certificate alerts use BETA-P0-017 certificate health', () => {
  it('warns and pages at DEFAULT_EXPIRY_THRESHOLDS, the windows npm run tls:check uses', () => {
    const renewal = /^jtt:tls_certificate_expiry:seconds < (\d+) \* 86400$/.exec(alert('TlsCertificateRenewalDue').expr);
    const page = /^jtt:tls_certificate_expiry:seconds < (\d+) \* 86400$/.exec(alert('TlsCertificateExpiresWithin7Days').expr);
    expect(Number(renewal?.[1])).toBe(DEFAULT_EXPIRY_THRESHOLDS.warnDays);
    expect(Number(page?.[1])).toBe(DEFAULT_EXPIRY_THRESHOLDS.criticalDays);
    expect(alert('TlsCertificateRenewalDue').severity).toBe('warning');
    expect(alert('TlsCertificateExpiresWithin7Days').severity).toBe('critical');
  });

  it('measures expiry from the served certificate notAfter', () => {
    expect(record('jtt:tls_certificate_expiry:seconds').expr).toBe(
      'jtt_tls_certificate_not_after_timestamp_seconds - time()',
    );
    // The API sets that gauge from P0-017's CertificateSummary.notAfter.
    expect(read('apps/api/src/operations.ts')).toMatch(
      /const notAfter = reports\.served\.certificate\?\.notAfter;\n\s+if \(notAfter\) metrics\.tlsCertificateNotAfter\.set\(Date\.parse\(notAfter\) \/ 1000\);/,
    );
  });

  it('pages on the P0-017 CRITICAL status, published as the tls:check exit code', () => {
    expect(alert('TlsEdgeUnhealthy').expr).toBe(`jtt_tls_check_status{check="served"} == ${exitCodeFor('critical')}`);
    expect(alert('TlsHttpRedirectBroken').expr).toBe(`jtt_tls_check_status{check="redirect"} == ${exitCodeFor('critical')}`);
    const operations = read('apps/api/src/operations.ts');
    expect(operations).toContain('metrics.tlsCheckStatus.set({ check }, exitCodeFor(report.status));');
    // The API runs P0-017's probes, not a copy of them.
    expect(operations).toMatch(/import \{[^}]*probeHttpRedirect,\n\s+probeHttpsEndpoint,[^}]*\} from '@jumptotech\/observability';/s);
  });
});

describe('capacity follows the deployed beta limits', () => {
  it('stays quiet at 4 of 5 sessions and warns at 5 of 5', () => {
    const near = alert('CapacityNearExhausted');
    const threshold = Number(/^jtt:sessions_utilization:ratio > ([\d.]+)$/.exec(near.expr)?.[1]);
    expect(record('jtt:sessions_utilization:ratio').expr).toContain('jtt_sessions_capacity_limit');
    const beta = 5;
    expect((beta - 1) / beta).toBeLessThanOrEqual(threshold);
    expect(beta / beta).toBeGreaterThan(threshold);
  });

  it('pages on a refusal counted by a series that exists from the first scrape', () => {
    expect(alert('CapacityExhausted').expr).toContain('jtt_lab_start_outcome_total{outcome="capacity_reached"}');
    expect(LAB_START_OUTCOMES).toContain('capacity_reached');
    expect(alert('CapacityExhausted').severity).toBe('critical');
  });

  it('publishes both limits, and ships the beta per-student default', () => {
    const registry = createRegistry({ service: 'test', defaultMetrics: false });
    createSessionMetrics(registry);
    const names = registry.getMetricsAsArray().map((metric) => metric.name);
    expect(names).toEqual(expect.arrayContaining(['jtt_sessions_capacity_limit', 'jtt_sessions_per_student_limit']));
    expect(read('docker-compose.yml')).toContain('MAX_ACTIVE_SESSIONS_PER_STUDENT: ${MAX_ACTIVE_SESSIONS_PER_STUDENT:-1}');
    expect(read('apps/api/src/index.ts')).toContain(
      'metrics.sessions.perStudentLimit.set(config.lifetimes.maxActiveSessionsPerStudent);',
    );
  });
});

describe('an alert that counts events leaves itself time to fire', () => {
  /*
   * `increase(x[W]) > n` holds a bounded burst true for about W. With `for: F`
   * the alert fires only if F < W — at F >= W a burst that ends is gone before
   * the alert can fire, which IE-3 measured and promtool reproduced for
   * `CapacityExhausted` in this story.
   */
  const windowOf = (expr: string): number[] => [
    ...[...expr.matchAll(/increase\([^\]]*\[(\d+[smhd])\]\)/g)].map((match) => seconds(match[1]!)),
    // A recording rule named level:metric:increaseNm carries its window last.
    ...[...expr.matchAll(/:increase(\d+[smhd])\b/g)].map((match) => seconds(match[1]!)),
  ];

  const counting = ALERTS.filter((rule) => windowOf(rule.expr).length > 0 && rule.for && seconds(rule.for) > 0);

  it('finds the alerts it polices', () => {
    expect(counting.map((rule) => rule.name)).toEqual(
      expect.arrayContaining(['CapacityExhausted', 'LabStartsFailingHard', 'JwksFetchFailing', 'LabResetsFailing', 'OidcSignInFailures']),
    );
  });

  it.each(counting.map((rule): [string, Rule] => [rule.name, rule]))('%s', (_name, rule) => {
    for (const window of windowOf(rule.expr)) {
      expect(seconds(rule.for!), `${rule.name}: for ${rule.for} against a ${window}s window`).toBeLessThan(window);
    }
  });
});

describe('the private-beta alert set', () => {
  it.each([
    ['ServiceDown', 'critical'],
    ['DatabaseDown', 'critical'],
    ['SandboxdRuntimeDown', 'critical'],
    ['CapacityExhausted', 'critical'],
    ['LabStartsFailingHard', 'critical'],
    ['ReaperStalled', 'critical'],
    ['ScopeDenialDetected', 'critical'],
    ['TlsEdgeUnhealthy', 'critical'],
    ['TlsCertificateExpiresWithin7Days', 'critical'],
    ['NetworkIsolationNotAttested', 'critical'],
    ['BackupMissedTwice', 'critical'],
    ['HostDiskSpaceCritical', 'critical'],
    ['HostMemoryCritical', 'critical'],
    ['TlsCertificateRenewalDue', 'warning'],
    ['BackupStale', 'warning'],
    ['BackupLastRunFailed', 'warning'],
    ['BackupVerifyFailed', 'warning'],
    ['LabResetsFailing', 'warning'],
    ['SessionStuckProvisioning', 'warning'],
    ['SessionResetStuck', 'warning'],
    ['SessionTeardownStuck', 'warning'],
    ['SessionDegradedNotReclaimed', 'warning'],
    ['ReaperSweepErrorsPersisting', 'warning'],
    ['AuthRejectionsAbnormal', 'warning'],
    ['OidcSignInFailures', 'warning'],
    ['NetworkIsolationAttestationAging', 'warning'],
  ])('%s is %s', (name, severity) => {
    expect(alert(name).severity).toBe(severity);
  });

  it('stays at a size an operator reads, rather than growing without review', () => {
    // 57 after BETA-P0-018; 60 on main at 001bcf1; 62 with the two
    // alert-delivery alerts (platform.yml). Adding alerts is fine; do it on purpose.
    expect(ALERTS.length).toBeLessThanOrEqual(62);
  });
});

describe('backup freshness', () => {
  it('warns past the 24-hour RPO and pages when two daily runs are missed', () => {
    const stale = Number(/> (\d+) \* 3600$/.exec(alert('BackupStale').expr)?.[1]);
    const missed = Number(/> (\d+) \* 3600$/.exec(alert('BackupMissedTwice').expr)?.[1]);
    expect(stale).toBeGreaterThan(24);
    expect(stale).toBeLessThan(48);
    expect(missed).toBeGreaterThan(48);
    expect(record('jtt:backup_age:seconds').expr).toBe('time() - jtt_backup_last_success_timestamp_seconds');
  });

  it('shares one status-file contract between the scripts and the API', () => {
    const lib = withoutComments(read('scripts/db-lib.sh'));
    expect(lib).toContain('file="$dir/db-$operation.last-$outcome"');
    expect(lib).toContain('backup:success | backup:failure | verify:success | verify:failure) ;;');
    expect(lib).toContain("printf 'timestamp_seconds=%s\\n'");
    expect(lib).toContain("printf 'size_bytes=%s\\n'");
    expect(lib).toContain("printf 'offhost_copy=%s\\n'");
    const api = read('apps/api/src/operations.ts');
    expect(api).toContain('const name = `db-${operation}.last-${kind}`;');
    expect(api).toContain("for (const kind of ['success', 'failure'] as const)");
    expect([...BACKUP_OPERATIONS]).toEqual(['backup', 'verify']);
    // Recorded by the backup, and by --verify-only whichever check refuses.
    expect(withoutComments(read('scripts/db-backup.sh'))).toContain('jtt_record_status backup success "$size" "$offhost_copy"');
    expect(withoutComments(read('scripts/db-backup.sh'))).toContain('jtt_record_status backup failure');
    expect(withoutComments(read('scripts/db-restore.sh'))).toContain("trap 'jtt_record_failure_on_exit verify' EXIT");
    expect(withoutComments(read('scripts/db-restore.sh'))).toContain('jtt_record_status verify success');
  });

  it('mounts only the status directory, read-only, into the api only', () => {
    const overlay = withoutComments(read('docker-compose.production-observability.yml'));
    expect(overlay).toMatch(
      /- type: bind\n\s+source: \$\{BACKUP_STATUS_DIR:-\.\/backups\/status\}\n\s+target: \/var\/lib\/jumptotech\/backup-status\n\s+read_only: true/,
    );
    expect(overlay.match(/backup-status/g)?.length).toBe(2);
    for (const file of ['docker-compose.yml', 'docker-compose.runtime.yml', 'docker-compose.observability.yml', 'docker-compose.production.yml']) {
      expect(withoutComments(read(file)), file).not.toMatch(/backups\/(status|postgres)/);
    }
  });
});

describe('monitoring joins production without becoming reachable', () => {
  const overlay = withoutComments(read('docker-compose.observability.yml'));
  const production = withoutComments(read('docker-compose.production-observability.yml'));

  function block(text: string, service: string): string {
    return new RegExp(`^ {2}${service}:\\n((?: {4,}.*\\n|\\s*\\n)*)`, 'm').exec(`${text}\n`)?.[1] ?? '';
  }

  it('binds Prometheus and Alertmanager to loopback inside their namespace, with lifecycle and gossip off', () => {
    const prometheus = block(production, 'prometheus');
    const alertmanager = block(production, 'alertmanager');
    expect(prometheus).toContain('- --web.listen-address=127.0.0.1:9090');
    expect(prometheus).not.toContain('--web.enable-lifecycle');
    expect(alertmanager).toContain('- --web.listen-address=127.0.0.1:9093');
    expect(alertmanager).toContain('- --cluster.listen-address=');
    expect(prometheus).toMatch(/ports: !override\n\s+- "127\.0\.0\.1:\$\{GRAFANA_PORT:-3001\}:3000"\n/);
  });

  it('runs Alertmanager and Grafana in Prometheus\'s namespace, which joins only the default network', () => {
    for (const service of ['alertmanager', 'grafana']) {
      expect(block(overlay, service), service).toContain('network_mode: service:prometheus');
      expect(block(overlay, service), service).not.toMatch(/^\s+networks:/m);
      expect(block(overlay, service), service).not.toMatch(/^\s+ports:/m);
    }
    expect(block(overlay, 'prometheus')).toMatch(/networks:\n\s+- default\n/);
    // IPv4 literals: inside the namespace `localhost` resolves to ::1 first, and
    // production binds 127.0.0.1 only (measured against the running stack).
    expect(read(`${PROMETHEUS}/prometheus.yml`)).toContain("- targets: ['127.0.0.1:9093']");
    expect(read('infrastructure/observability/grafana/provisioning/datasources/prometheus.yml')).toContain(
      'url: http://127.0.0.1:9090',
    );
  });

  it('gives no monitoring container a Docker socket or a student, cluster or database network', () => {
    for (const text of [overlay, production]) {
      for (const service of ['prometheus', 'alertmanager', 'grafana']) {
        const lines = block(text, service);
        expect(lines, service).not.toContain('docker.sock');
        expect(lines, service).not.toMatch(/- (sandboxes|kind|database)\s*$/m);
      }
    }
  });

  it('keeps Grafana behind a login: no anonymous access, no sign-up, no basic-auth API, brute-force protection on', () => {
    const grafana = block(overlay, 'grafana');
    expect(grafana).toContain('GF_AUTH_ANONYMOUS_ENABLED: "false"');
    expect(grafana).toContain('GF_USERS_ALLOW_SIGN_UP: "false"');
    expect(block(production, 'grafana')).toContain('GF_AUTH_BASIC_ENABLED: "false"');
    expect(block(production, 'grafana')).toContain('GF_SECURITY_DISABLE_BRUTE_FORCE_LOGIN_PROTECTION: "false"');
  });

  it('routes nothing in nginx to a monitoring component', () => {
    for (const file of ['infrastructure/docker/nginx/locations.conf', 'infrastructure/docker/nginx/web.conf', 'infrastructure/docker/nginx/web-tls.conf']) {
      expect(withoutComments(read(file)), file).not.toMatch(/prometheus|grafana|alertmanager|:909\d|:940\d/);
    }
  });

  it('never writes the notification destination into committed configuration', () => {
    const alertmanager = withoutComments(read('infrastructure/observability/alertmanager/alertmanager.yml'));
    expect(alertmanager).toContain('url_file: /etc/alertmanager/secrets/webhook-url');
    expect(alertmanager).not.toMatch(/^\s*-?\s*url:/m);
    expect(read('infrastructure/observability/alertmanager/secrets/.gitignore').split('\n')).toContain('*');
  });
});

/*
 * Nobody is watching the host.
 *
 * Compose restarts nothing on its own: without a policy, a crashed api, a
 * terminal the kernel killed, or a reboot leaves the platform down until an
 * operator happens to look. The runbook's health check (§2) is five minutes
 * before a class, which is not a supervisor.
 *
 * `unless-stopped` rather than `always`, everywhere: `prod stop web` is the
 * runbook's only way to take the site down (§3), and `always` would bring it
 * back at the next daemon start.
 *
 * Development deliberately gets none. A container that died on a laptop should
 * stay dead, where it is read.
 */
describe('the production stack comes back by itself', () => {
  const production = withoutComments(read('docker-compose.production.yml'));
  const productionObservability = withoutComments(read('docker-compose.production-observability.yml'));
  const development = [
    withoutComments(read('docker-compose.yml')),
    withoutComments(read('docker-compose.runtime.yml')),
    withoutComments(read('docker-compose.observability.yml')),
  ];

  function block(text: string, service: string): string {
    return new RegExp(`^ {2}${service}:\\n((?: {4,}.*\\n|\\s*\\n)*)`, 'm').exec(`${text}\n`)?.[1] ?? '';
  }

  it('gives every production platform service an unattended restart', () => {
    for (const service of ['postgres', 'api', 'terminal', 'sandboxd', 'web']) {
      expect(block(production, service), service).toMatch(/^\s+restart: unless-stopped$/m);
    }
  });

  it('gives monitoring one too — it is the component whose absence no alert can report', () => {
    for (const service of ['prometheus', 'alertmanager', 'grafana']) {
      expect(block(productionObservability, service), service).toMatch(/^\s+restart: unless-stopped$/m);
    }
  });

  it('never uses `always`, which would undo the runbook\'s only way to take the site down', () => {
    for (const text of [production, productionObservability]) {
      expect(text).not.toMatch(/^\s+restart:\s*always\s*$/m);
      expect(text).not.toMatch(/^\s+restart:\s*on-failure/m);
    }
  });

  it('leaves the development stack with no restart policy at all', () => {
    for (const text of development) {
      expect(text).not.toMatch(/^\s+restart:/m);
    }
  });
});

describe('the private-beta operator dashboard', () => {
  const dashboard = JSON.parse(
    read('infrastructure/observability/grafana/dashboards/00-private-beta-operations.json'),
  ) as { uid: string; panels: Array<{ targets?: Array<{ expr?: string }> }> };
  const exprs = dashboard.panels.flatMap((panel) => (panel.targets ?? []).map((target) => target.expr ?? '')).join('\n');

  it.each([
    ['firing alerts', 'ALERTS{'],
    ['service health', 'up{job=~"api|terminal|sandboxd"}'],
    ['API readiness', 'jtt_readyz_ok'],
    ['PostgreSQL', 'jtt_db_up'],
    ['the container runtime', 'jtt_sandboxd_runtime_up'],
    ['certificate expiry', 'jtt:tls_certificate_expiry:seconds'],
    ['the HTTPS check', 'jtt_tls_check_status{check="served"}'],
    ['active sessions', 'jtt_sessions_active'],
    ['the capacity ceiling', 'jtt_sessions_capacity_limit'],
    ['the per-student ceiling', 'jtt_sessions_per_student_limit'],
    ['start failures', 'jtt_lab_start_outcome_total'],
    ['reset failures', 'jtt_lab_reset_outcome_total'],
    ['end failures', 'jtt_lab_end_outcome_total'],
    ['stuck states', 'jtt_sessions_oldest_status_age_seconds'],
    ['the reaper', 'jtt:reaper_seconds_since_success'],
    ['recovery', 'jtt_reaper_recoveries_total'],
    ['network isolation', 'jtt_network_isolation_attestation_valid'],
    ['authentication', 'jtt:auth_rejected:increase10m'],
    ['backup freshness', 'jtt:backup_age:seconds{operation="backup"}'],
    ['host memory', 'jtt:host_memory_available:ratio'],
    ['host disk', 'jtt:host_filesystem_available:ratio'],
  ])('shows %s', (_subject, needle) => {
    expect(exprs).toContain(needle);
  });

  it('is one dashboard, not a set', () => {
    expect(dashboard.uid).toBe('jtt-private-beta');
    const beta = readdirSync(path.join(REPO_ROOT, 'infrastructure/observability/grafana/dashboards')).filter((file) =>
      /beta/i.test(file),
    );
    expect(beta).toEqual(['00-private-beta-operations.json']);
  });
});

describe('the new metrics carry nothing identifying or secret', () => {
  const registry = createRegistry({ service: 'test', defaultMetrics: false });
  createOperationsMetrics(registry);
  createSessionMetrics(registry);
  createReaperMetrics(registry);
  createAuthMetrics(registry);
  const metrics = registry.getMetricsAsArray() as Array<{ name: string; labelNames?: readonly string[] }>;

  it('passes the label policy', () => {
    expect(() => assertLabelPolicy(registry)).not.toThrow();
  });

  it('labels a TLS finding by code, never by host, fingerprint or message', () => {
    const labels = new Set(metrics.flatMap((metric) => [...(metric.labelNames ?? [])]));
    for (const forbidden of ['host', 'hostname', 'fingerprint', 'subject', 'issuer', 'message', 'reason_text', 'dir', 'file', 'path', 'url']) {
      expect(labels, forbidden).not.toContain(forbidden);
    }
    const findings = metrics.find((metric) => metric.name === 'jtt_tls_check_findings');
    expect([...(findings?.labelNames ?? [])]).toEqual(['check', 'status', 'code']);
  });

  it('exposes every alerting counter from the first scrape, at zero', async () => {
    const text = await registry.metrics();
    for (const series of [
      'jtt_lab_reset_outcome_total{outcome="failed"} 0',
      'jtt_lab_end_outcome_total{outcome="pending"} 0',
      'jtt_reaper_recoveries_total{reason="interrupted_reset"} 0',
      'jtt_reaper_teardown_incomplete_total{reason="expired"} 0',
      'jtt_auth_callback_total{outcome="verification_failed"} 0',
      'jtt_network_isolation_attestation_checks_total{result="invalid"} 0',
    ]) {
      expect(text).toContain(series);
    }
  });
});
