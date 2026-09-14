/**
 * BETA-P0-018 — the deployment gauges the API publishes for the private beta.
 *
 * The TLS cases run BETA-P0-017's real probes against real TLS servers on
 * loopback, with certificates from the test CA, so what is pinned is the data
 * P0-017 produces becoming the series the alerts read — the same path
 * production takes, with the test CA trusted in place of the public roots.
 *
 * Every section also checks what must NOT reach a series: the host name, the
 * certificate fingerprint, a finding's message, a directory path, an
 * attestation's reason.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo, Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createSelfSignedServer, createTestCa, type TestCa } from '@jumptotech/test-support/tls-pki';
import type { AttestationDecision, KubernetesPort, LabSession, NetworkPolicyConfig } from '@jumptotech/lab-orchestrator';
import {
  DEFAULT_EXPIRY_THRESHOLDS,
  createLogger,
  createOperationsMetrics,
  createRegistry,
  probeHttpRedirect,
  probeHttpsEndpoint,
  type Registry,
} from '@jumptotech/observability';

import { loadOperationsConfig, type OperationsConfig } from '../src/config.js';
import { oldestInStatus } from '../src/observability-collectors.js';
import {
  installOperationsCollectors,
  parseBackupStatusRecord,
  parseLoadavg,
  parseMeminfo,
  readBackupStatus,
  readHostPressure,
  recordAttestationDecision,
  recordBackupStatus,
  recordHostPressure,
  recordTlsEdgeCheck,
  runTlsEdgeCheck,
} from '../src/operations.js';

const HOST = 'labs.jtt.test';
const DAY_MS = 86_400_000;

function fresh() {
  const registry = createRegistry({ service: 'api', defaultMetrics: false });
  return { registry, metrics: createOperationsMetrics(registry) };
}

async function value(registry: Registry, name: string, labels: Record<string, string> = {}): Promise<number | undefined> {
  const metric = (await registry.getMetricsAsJSON()).find((m) => m.name === name);
  const values = (metric?.values ?? []) as Array<{ value: number; labels: Record<string, string | number> }>;
  return values.find((v) => Object.entries(labels).every(([k, want]) => v.labels[k] === want))?.value;
}

// --- the TLS edge ------------------------------------------------------------------

describe('the TLS edge check publishes BETA-P0-017 certificate health', () => {
  let ca: TestCa;
  const servers: Server[] = [];

  async function listen(server: Server): Promise<number> {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  const serve = (identity: { cert: string; key: string }): Promise<number> =>
    listen(
      createHttpsServer({ cert: identity.cert, key: identity.key }, (_req, res) => {
        res.writeHead(200, { 'strict-transport-security': 'max-age=63072000' });
        res.end('ok');
      }),
    );

  const edge = (daysLeft: number): Promise<number> =>
    serve(ca.issue({ dns: [HOST], notBefore: new Date(Date.now() - DAY_MS), notAfter: new Date(Date.now() + daysLeft * DAY_MS) }));

  const redirector = (): Promise<number> =>
    listen(
      createHttpServer((req, res) => {
        res.writeHead(301, { location: `https://${HOST}${req.url}` });
        res.end();
      }),
    );

  /** A port with nothing listening on it. */
  async function closedPort(): Promise<number> {
    const server = createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    return port;
  }

  const config: OperationsConfig['edgeProbe'] = {
    enabled: true,
    hostname: HOST,
    connectHost: '127.0.0.1',
    httpsPort: 8443,
    httpPort: 8080,
    intervalSeconds: 300,
  };

  /** P0-017's probes, pointed at the test servers and trusting the test CA. */
  const probes = (httpsPort: number, httpPort: number) => ({
    https: (options: Parameters<typeof probeHttpsEndpoint>[0]) =>
      probeHttpsEndpoint({ ...options, port: httpsPort, ca: ca.cert, timeoutMs: 5_000 }),
    redirect: (options: Parameters<typeof probeHttpRedirect>[0]) =>
      probeHttpRedirect({ ...options, port: httpPort, timeoutMs: 5_000 }),
  });

  beforeAll(() => {
    ca = createTestCa();
  });

  afterAll(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  });

  it('reports a certificate inside the renewal window as a warning, with its notAfter', async () => {
    const reports = await runTlsEdgeCheck(config, probes(await edge(10), await redirector()));
    const { registry, metrics } = fresh();
    recordTlsEdgeCheck(metrics, reports, Date.now());

    expect(await value(registry, 'jtt_tls_check_status', { check: 'served' })).toBe(1);
    expect(await value(registry, 'jtt_tls_check_status', { check: 'redirect' })).toBe(0);
    expect(await value(registry, 'jtt_tls_check_findings', { check: 'served', status: 'warning', code: 'renewal_due' })).toBe(1);

    const notAfter = (await value(registry, 'jtt_tls_certificate_not_after_timestamp_seconds'))!;
    expect(notAfter).toBe(Date.parse(reports.served.certificate!.notAfter) / 1000);
    // Where the alert's arithmetic puts it: inside 21 days, outside 7.
    const left = notAfter - Date.now() / 1000;
    expect(left).toBeLessThan(DEFAULT_EXPIRY_THRESHOLDS.warnDays * 86_400);
    expect(left).toBeGreaterThan(DEFAULT_EXPIRY_THRESHOLDS.criticalDays * 86_400);
  });

  it('reports a certificate under seven days as critical', async () => {
    const reports = await runTlsEdgeCheck(config, probes(await edge(3), await redirector()));
    const { registry, metrics } = fresh();
    recordTlsEdgeCheck(metrics, reports, Date.now());

    expect(await value(registry, 'jtt_tls_check_status', { check: 'served' })).toBe(2);
    expect(await value(registry, 'jtt_tls_check_findings', { check: 'served', status: 'critical', code: 'expires_soon' })).toBe(1);
  });

  it('reports an untrusted certificate as critical, without disabling verification', async () => {
    const selfSigned = createSelfSignedServer({ dns: [HOST] });
    const reports = await runTlsEdgeCheck(config, probes(await serve(selfSigned), await redirector()));
    const { registry, metrics } = fresh();
    recordTlsEdgeCheck(metrics, reports, Date.now());

    expect(await value(registry, 'jtt_tls_check_status', { check: 'served' })).toBe(2);
    expect(await value(registry, 'jtt_tls_check_findings', { check: 'served', status: 'critical', code: 'served_untrusted' })).toBe(1);
  });

  it('keeps the last known expiry when the edge stops answering, and replaces the findings', async () => {
    const { registry, metrics } = fresh();
    recordTlsEdgeCheck(metrics, await runTlsEdgeCheck(config, probes(await edge(10), await redirector())), Date.now());
    const before = await value(registry, 'jtt_tls_certificate_not_after_timestamp_seconds');

    const down = await runTlsEdgeCheck(config, probes(await closedPort(), await closedPort()));
    recordTlsEdgeCheck(metrics, down, Date.now());

    expect(await value(registry, 'jtt_tls_check_status', { check: 'served' })).toBe(2);
    expect(await value(registry, 'jtt_tls_check_findings', { check: 'served', status: 'critical', code: 'connection_refused' })).toBe(1);
    expect(await value(registry, 'jtt_tls_check_findings', { check: 'served', status: 'warning', code: 'renewal_due' })).toBeUndefined();
    expect(await value(registry, 'jtt_tls_certificate_not_after_timestamp_seconds')).toBe(before);
  });

  it('turns a probe that throws into a critical check rather than an exception', async () => {
    const reports = await runTlsEdgeCheck(config, {
      https: () => Promise.reject(new Error(`boom ${HOST}`)),
      redirect: () => Promise.reject(new Error('boom')),
    });
    expect(reports.served.status).toBe('critical');
    expect(reports.served.findings.map((f) => f.code)).toEqual(['check_failed']);
  });

  it('puts no host name, address, fingerprint or message into a series', async () => {
    const reports = await runTlsEdgeCheck(config, probes(await edge(10), await redirector()));
    const { registry, metrics } = fresh();
    recordTlsEdgeCheck(metrics, reports, Date.now());
    const text = await registry.metrics();

    expect(text).not.toContain(HOST);
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain(reports.served.certificate!.fingerprint256);
    expect(text).not.toContain('renew it');
    expect(text).not.toMatch(/CN=|jumptotech test CA/);
  });
});

// --- backups -------------------------------------------------------------------------

describe('backup freshness is read from the status the scripts write', () => {
  // Exactly what scripts/db-lib.sh jtt_record_status writes (pinned on that side
  // by scripts/test-db-backup-restore.sh).
  const SUCCESS = 'timestamp_seconds=1757890000\nsize_bytes=4096\noffhost_copy=not_configured\n';
  const dirs: string[] = [];

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('parses the record', () => {
    expect(parseBackupStatusRecord(SUCCESS)).toEqual({ timestampSeconds: 1757890000, sizeBytes: 4096, offhostCopy: 'not_configured' });
    expect(parseBackupStatusRecord('timestamp_seconds=1757890000\n')).toEqual({ timestampSeconds: 1757890000 });
  });

  it('treats anything it cannot read completely as absent, never as a fresh backup', () => {
    for (const text of [
      '',
      'timestamp_seconds=17\n',
      'timestamp_seconds=1757890000\nsize_bytes=abc\n',
      'timestamp_seconds=1757890000\noffhost_copy=maybe\n',
      'timestamp_seconds=1757890000\npath=/srv/backups/x.dump\n',
      'timestamp_seconds=1757890000 # comment\n',
    ]) {
      expect(parseBackupStatusRecord(text), JSON.stringify(text)).toBeNull();
    }
  });

  it('reads a status directory and publishes both operations', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jtt-backup-status-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'db-backup.last-success'), SUCCESS);
    writeFileSync(path.join(dir, 'db-backup.last-failure'), 'timestamp_seconds=1757800000\n');
    writeFileSync(path.join(dir, 'db-verify.last-failure'), 'timestamp_seconds=1757895000\n');
    // A write in progress, and a stranger: both ignored.
    writeFileSync(path.join(dir, '.db-backup.last-success.4242'), 'timestamp_seconds=1\n');
    writeFileSync(path.join(dir, 'notes.txt'), 'hello\n');

    const status = readBackupStatus(dir);
    expect(status.readable).toBe(true);
    const { registry, metrics } = fresh();
    recordBackupStatus(metrics, status);

    expect(await value(registry, 'jtt_backup_status_readable')).toBe(1);
    expect(await value(registry, 'jtt_backup_last_success_timestamp_seconds', { operation: 'backup' })).toBe(1757890000);
    expect(await value(registry, 'jtt_backup_last_failure_timestamp_seconds', { operation: 'backup' })).toBe(1757800000);
    expect(await value(registry, 'jtt_backup_last_failure_timestamp_seconds', { operation: 'verify' })).toBe(1757895000);
    expect(await value(registry, 'jtt_backup_last_success_timestamp_seconds', { operation: 'verify' })).toBeUndefined();
    expect(await value(registry, 'jtt_backup_last_success_size_bytes')).toBe(4096);
    expect(await value(registry, 'jtt_backup_last_success_offhost')).toBe(0);
    expect(await registry.metrics()).not.toContain(dir);
  });

  it('refuses a status directory that holds archives: a mount pointed at BACKUP_DIR', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jtt-backup-status-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'db-backup.last-success'), SUCCESS);
    writeFileSync(path.join(dir, 'jtt-pg-jumptotech_labs-20260914T031700Z.dump'), 'PGDMP');
    const status = readBackupStatus(dir);
    expect(status.readable).toBe(false);
    expect(status.records.backup.success).toBeUndefined();
  });

  it('reports a directory it cannot read as unreadable, with no timestamps', async () => {
    const status = readBackupStatus(path.join(tmpdir(), 'jtt-no-such-backup-status-dir'));
    const { registry, metrics } = fresh();
    recordBackupStatus(metrics, status);
    expect(await value(registry, 'jtt_backup_status_readable')).toBe(0);
    expect(await value(registry, 'jtt_backup_last_success_timestamp_seconds', { operation: 'backup' })).toBeUndefined();
  });
});

// --- the host ------------------------------------------------------------------------

describe('host pressure', () => {
  const MEMINFO = 'MemTotal:       16000000 kB\nMemFree:          100000 kB\nMemAvailable:    4000000 kB\nBuffers: 1 kB\n';

  it('parses /proc/meminfo and /proc/loadavg', () => {
    expect(parseMeminfo(MEMINFO)).toEqual({ totalBytes: 16_000_000 * 1024, availableBytes: 4_000_000 * 1024 });
    expect(parseMeminfo('MemTotal: 1 kB\n')).toBeUndefined();
    expect(parseLoadavg('0.52 1.20 2.00 1/234 5678\n')).toEqual({ '1m': 0.52, '5m': 1.2, '15m': 2 });
  });

  it('publishes what it can read under fixed filesystem names, and leaves the rest absent', async () => {
    const readings = readHostPressure(
      { container_root: '/', backup_status: '/var/lib/jumptotech/backup-status' },
      {
        read: (file) => {
          if (file === '/proc/meminfo') return MEMINFO;
          throw new Error('ENOENT');
        },
        statfs: (target) => {
          if (target === '/') return { bsize: 4096, blocks: 1000, bavail: 100 };
          throw new Error('ENOENT');
        },
        cpus: () => 4,
      },
    );
    const { registry, metrics } = fresh();
    recordHostPressure(metrics, readings);

    expect(await value(registry, 'jtt_host_memory_available_bytes')).toBe(4_000_000 * 1024);
    expect(await value(registry, 'jtt_host_load_average', { window: '5m' })).toBeUndefined();
    expect(await value(registry, 'jtt_host_cpus')).toBe(4);
    expect(await value(registry, 'jtt_host_filesystem_size_bytes', { filesystem: 'container_root' })).toBe(4_096_000);
    expect(await value(registry, 'jtt_host_filesystem_available_bytes', { filesystem: 'container_root' })).toBe(409_600);
    expect(await value(registry, 'jtt_host_filesystem_size_bytes', { filesystem: 'backup_status' })).toBeUndefined();
    expect(await registry.metrics()).not.toContain('/var/lib/jumptotech');
  });
});

// --- network isolation ---------------------------------------------------------------

describe('the NetworkPolicy enforcement attestation', () => {
  const network = { attestation: { required: true, maxAgeSeconds: 3600 } } as NetworkPolicyConfig;

  it('publishes a valid attestation with the time it was proven', async () => {
    const { registry, metrics } = fresh();
    recordAttestationDecision(
      metrics,
      { ok: true, attestation: { verifiedAt: '2026-09-14T10:00:00.000Z' } } as AttestationDecision,
      3600,
    );
    expect(await value(registry, 'jtt_network_isolation_attestation_valid')).toBe(1);
    expect(await value(registry, 'jtt_network_isolation_attestation_verified_timestamp_seconds')).toBe(
      Date.parse('2026-09-14T10:00:00.000Z') / 1000,
    );
    expect(await value(registry, 'jtt_network_isolation_attestation_max_age_seconds')).toBe(3600);
    expect(await value(registry, 'jtt_network_isolation_attestation_checks_total', { result: 'valid' })).toBe(1);
  });

  it('publishes a refused attestation as invalid and keeps the reason out of the series', async () => {
    const { registry, metrics } = fresh();
    const reason = 'the attestation was recorded on a different cluster (kube-system UID mismatch)';
    recordAttestationDecision(metrics, { ok: false, reason } as AttestationDecision, 3600);
    expect(await value(registry, 'jtt_network_isolation_attestation_valid')).toBe(0);
    expect(await value(registry, 'jtt_network_isolation_attestation_checks_total', { result: 'invalid' })).toBe(1);
    expect(await registry.metrics()).not.toContain('kube-system');
  });

  it('reports an unreadable attestation from the timer, logging the reason and never throwing', async () => {
    const { registry, metrics } = fresh();
    const lines: string[] = [];
    const collectors = installOperationsCollectors({
      metrics,
      config: {
        edgeProbe: { enabled: false, hostname: '', connectHost: 'web', httpsPort: 8443, httpPort: 8080, intervalSeconds: 300 },
        backupStatusDir: undefined,
        hostMetrics: false,
      },
      logger: createLogger({ service: 'api', level: 'debug', sink: (line) => lines.push(line) }),
      attestation: { k8s: {} as KubernetesPort, network },
      readAttestation: () => Promise.reject(new Error('connect ECONNREFUSED')),
    });
    try {
      await collectors.checkAttestation();
      expect(await value(registry, 'jtt_network_isolation_attestation_valid')).toBe(0);
      expect(await value(registry, 'jtt_network_isolation_attestation_checks_total', { result: 'unreadable' })).toBeGreaterThanOrEqual(1);
      expect(await value(registry, 'jtt_tls_probe_enabled')).toBe(0);
      expect(lines.some((line) => line.includes('"event":"ops.network_attestation.checked"') && line.includes('not proven'))).toBe(true);
      expect(await registry.metrics()).not.toContain('ECONNREFUSED');
    } finally {
      collectors.stop();
    }
  });
});

// --- configuration and the stuck-session gauge ----------------------------------------

describe('operations configuration', () => {
  it('probes the edge by default exactly in production with an https PUBLIC_ORIGIN', () => {
    const production = loadOperationsConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv, 'https://labs.example.com');
    expect(production.edgeProbe).toMatchObject({ enabled: true, hostname: 'labs.example.com', connectHost: 'web', httpsPort: 8443, httpPort: 8080 });
    expect(loadOperationsConfig({} as NodeJS.ProcessEnv, 'https://labs.example.com').edgeProbe.enabled).toBe(false);
    expect(loadOperationsConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv, undefined).edgeProbe.enabled).toBe(false);
    expect(
      loadOperationsConfig({ NODE_ENV: 'production', EDGE_PROBE_ENABLED: 'false' } as NodeJS.ProcessEnv, 'https://labs.example.com').edgeProbe.enabled,
    ).toBe(false);
  });

  it('refuses an edge probe it cannot aim, and a relative status directory', () => {
    expect(() => loadOperationsConfig({ EDGE_PROBE_ENABLED: 'true' } as NodeJS.ProcessEnv, undefined)).toThrow(/PUBLIC_ORIGIN/);
    expect(() => loadOperationsConfig({ EDGE_PROBE_ENABLED: 'true' } as NodeJS.ProcessEnv, 'http://localhost:3000')).toThrow(/PUBLIC_ORIGIN/);
    expect(() => loadOperationsConfig({ BACKUP_STATUS_DIR: 'backups/status' } as NodeJS.ProcessEnv, undefined)).toThrow(/absolute/);
    expect(loadOperationsConfig({ BACKUP_STATUS_DIR: '/var/lib/jumptotech/backup-status' } as NodeJS.ProcessEnv, undefined).backupStatusDir).toBe(
      '/var/lib/jumptotech/backup-status',
    );
  });
});

describe('the oldest session in each status', () => {
  it('reports every occupying status, at zero when empty, and ignores finished sessions', () => {
    const now = Date.parse('2026-09-14T12:00:00.000Z');
    const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();
    const sessions = [
      { status: 'CREATING', statusChangedAt: at(600) },
      { status: 'CREATING', statusChangedAt: at(60) },
      { status: 'ENDING', statusChangedAt: at(1300) },
      { status: 'ENDED', statusChangedAt: at(99_999) },
      { status: 'DEGRADED', statusChangedAt: 'not a time' },
    ] as LabSession[];

    expect(Object.fromEntries(oldestInStatus(sessions, now))).toEqual({
      CREATING: 600,
      ACTIVE: 0,
      RESETTING: 0,
      DEGRADED: 0,
      EXPIRING: 0,
      ENDING: 1300,
    });
  });
});
