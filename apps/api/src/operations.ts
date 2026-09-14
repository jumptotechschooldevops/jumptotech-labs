/**
 * Deployment health the API reports for operators — BETA-P0-018.
 *
 * Four readings the private beta needs and nothing else in the platform could
 * take without being handed a capability it does not have today:
 *
 *   · **the public TLS edge** — BETA-P0-017's own checks (`probeHttpsEndpoint`,
 *     `probeHttpRedirect`), run on a timer against the web tier across the
 *     compose network. The same code and the same 21/7-day thresholds as
 *     `npm run tls:check`, so the alert and the command cannot disagree;
 *   · **backup freshness** — the last outcome scripts/db-backup.sh and
 *     `db-restore.sh --verify-only` recorded, read from a status directory
 *     mounted read-only. Timestamps and a size; never an archive;
 *   · **host pressure** — `/proc/meminfo`, `/proc/loadavg` and statfs, which a
 *     container reads for the host without any mount: the kernel does not
 *     namespace them. No Docker socket, no host filesystem;
 *   · **the NetworkPolicy enforcement attestation** (BETA-P0-015) — the same
 *     read the Kubernetes provider gates admission on, reported as a gauge so
 *     "isolation is not proven" is distinguishable from "the cluster is down".
 *
 * Every reading runs on its own timer, never inside a scrape: a hung TLS
 * handshake or a slow API server must not stall `/metrics`, which is how an
 * operator would find out about either. Nothing here can throw into the
 * process — a monitoring failure is a metric, not an outage.
 *
 * Labels carry codes and fixed names only. Host names, fingerprints, paths,
 * finding messages and attestation reasons stay out of every series.
 */
import { readFileSync, readdirSync, statfsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readNetworkEnforcementAttestation,
  type AttestationDecision,
  type KubernetesPort,
  type NetworkPolicyConfig,
} from '@jumptotech/lab-orchestrator';
import {
  BACKUP_OPERATIONS,
  TLS_EDGE_CHECKS,
  exitCodeFor,
  probeHttpRedirect,
  probeHttpsEndpoint,
  type HttpsProbeResult,
  type Logger,
  type OperationsMetrics,
  type TlsHealthReport,
  type TlsHealthStatus,
} from '@jumptotech/observability';

import type { OperationsConfig } from './config.js';

// --- the TLS edge --------------------------------------------------------------

export interface TlsEdgeReports {
  served: TlsHealthReport;
  redirect: TlsHealthReport;
}

/** Publish one completed edge check. The previous findings are replaced, not accumulated. */
export function recordTlsEdgeCheck(metrics: OperationsMetrics, reports: TlsEdgeReports, nowMs: number): void {
  metrics.tlsCheckFindings.reset();
  for (const check of TLS_EDGE_CHECKS) {
    const report = reports[check];
    metrics.tlsCheckStatus.set({ check }, exitCodeFor(report.status));
    for (const finding of report.findings) {
      metrics.tlsCheckFindings.set({ check, status: finding.status, code: finding.code }, 1);
    }
  }
  /*
   * Kept at its last value when a check could not read a certificate at all —
   * an expired certificate fails the handshake, and forgetting its date then
   * would silence the expiry alert at the moment it is most true. The failed
   * handshake is reported by `jtt_tls_check_status{check="served"}` = 2.
   */
  const notAfter = reports.served.certificate?.notAfter;
  if (notAfter) metrics.tlsCertificateNotAfter.set(Date.parse(notAfter) / 1000);
  metrics.tlsCheckLastRun.set(nowMs / 1000);
}

export interface TlsEdgeProbes {
  https: typeof probeHttpsEndpoint;
  redirect: typeof probeHttpRedirect;
}

/** Run both checks against the edge as configured. Never rejects. */
export async function runTlsEdgeCheck(
  edge: OperationsConfig['edgeProbe'],
  probes: TlsEdgeProbes = { https: probeHttpsEndpoint, redirect: probeHttpRedirect },
  now: () => Date = () => new Date(),
): Promise<TlsEdgeReports> {
  const common = { hostname: edge.hostname, connectHost: edge.connectHost, now: now() };
  const [served, redirect] = await Promise.all([
    probes
      .https({ ...common, port: edge.httpsPort })
      .then((result: HttpsProbeResult) => result.report)
      .catch(() => unableToCheck('served')),
    probes.redirect({ ...common, port: edge.httpPort }).catch(() => unableToCheck('redirect')),
  ]);
  return { served, redirect };
}

function unableToCheck(check: string): TlsHealthReport {
  return {
    status: 'critical',
    findings: [{ status: 'critical', code: 'check_failed', message: `the ${check} check could not run` }],
  };
}

// --- backups -------------------------------------------------------------------

export interface BackupStatusRecord {
  timestampSeconds: number;
  sizeBytes?: number;
  offhostCopy?: 'copied' | 'not_configured';
}

export interface BackupStatus {
  /** The directory itself could be listed. */
  readable: boolean;
  records: Record<(typeof BACKUP_OPERATIONS)[number], { success?: BackupStatusRecord; failure?: BackupStatusRecord }>;
}

/**
 * One status file, as scripts/db-lib.sh `jtt_record_status` writes it: `key=value`
 * lines. Strict — a file this cannot read completely is treated as absent, so a
 * truncated write never reads as a fresh backup.
 */
export function parseBackupStatusRecord(text: string): BackupStatusRecord | null {
  const values = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const match = /^([a-z_]+)=([A-Za-z0-9_]+)$/.exec(line.trim());
    if (!match) return null;
    values.set(match[1]!, match[2]!);
  }
  const timestamp = values.get('timestamp_seconds');
  if (!timestamp || !/^\d{9,11}$/.test(timestamp)) return null;
  const record: BackupStatusRecord = { timestampSeconds: Number(timestamp) };
  const size = values.get('size_bytes');
  if (size !== undefined) {
    if (!/^\d{1,15}$/.test(size)) return null;
    record.sizeBytes = Number(size);
  }
  const offhost = values.get('offhost_copy');
  if (offhost !== undefined) {
    if (offhost !== 'copied' && offhost !== 'not_configured') return null;
    record.offhostCopy = offhost;
  }
  return record;
}

export function readBackupStatus(
  dir: string,
  io: { list: (dir: string) => string[]; read: (file: string) => string } = {
    list: (d) => readdirSync(d),
    read: (f) => readFileSync(f, 'utf8'),
  },
): BackupStatus {
  const records = { backup: {}, verify: {} } as BackupStatus['records'];
  let names: Set<string>;
  try {
    names = new Set(io.list(dir));
  } catch {
    return { readable: false, records };
  }
  // A status directory holding archives is a misconfigured mount (BACKUP_STATUS_DIR
  // set to, or above, BACKUP_DIR). Refused as unreadable, so BackupStatusUnreadable
  // fires instead of the api quietly reading beside the archives.
  if ([...names].some((name) => /\.(dump|dump\.sha256|dump\.partial)$/.test(name))) {
    return { readable: false, records };
  }
  for (const operation of BACKUP_OPERATIONS) {
    for (const kind of ['success', 'failure'] as const) {
      const name = `db-${operation}.last-${kind}`;
      if (!names.has(name)) continue;
      try {
        const record = parseBackupStatusRecord(io.read(path.join(dir, name)));
        if (record) records[operation][kind] = record;
      } catch {
        // Unreadable or vanished between the listing and the read: absent.
      }
    }
  }
  return { readable: true, records };
}

export function recordBackupStatus(metrics: OperationsMetrics, status: BackupStatus): void {
  metrics.backupStatusReadable.set(status.readable ? 1 : 0);
  metrics.backupLastSuccess.reset();
  metrics.backupLastFailure.reset();
  for (const operation of BACKUP_OPERATIONS) {
    const { success, failure } = status.records[operation];
    if (success) metrics.backupLastSuccess.set({ operation }, success.timestampSeconds);
    if (failure) metrics.backupLastFailure.set({ operation }, failure.timestampSeconds);
  }
  const backup = status.records.backup.success;
  if (backup?.sizeBytes !== undefined) metrics.backupLastSizeBytes.set(backup.sizeBytes);
  if (backup?.offhostCopy) metrics.backupLastOffHost.set(backup.offhostCopy === 'copied' ? 1 : 0);
}

// --- the host ------------------------------------------------------------------

export interface HostReadings {
  memory?: { totalBytes: number; availableBytes: number };
  load?: { '1m': number; '5m': number; '15m': number };
  cpus?: number;
  filesystems: Array<{ name: string; sizeBytes: number; availableBytes: number }>;
}

export function parseMeminfo(text: string): HostReadings['memory'] | undefined {
  const kib = (key: string): number | undefined => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : undefined;
  };
  const totalBytes = kib('MemTotal');
  const availableBytes = kib('MemAvailable');
  return totalBytes !== undefined && availableBytes !== undefined ? { totalBytes, availableBytes } : undefined;
}

export function parseLoadavg(text: string): HostReadings['load'] | undefined {
  const match = /^(\d+(?:\.\d+)?) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?) /.exec(text);
  return match ? { '1m': Number(match[1]), '5m': Number(match[2]), '15m': Number(match[3]) } : undefined;
}

export interface HostIo {
  read: (file: string) => string;
  statfs: (target: string) => { bsize: number; blocks: number; bavail: number };
  cpus: () => number;
}

const realHostIo: HostIo = {
  read: (file) => readFileSync(file, 'utf8'),
  statfs: (target) => statfsSync(target),
  cpus: () => os.cpus().length,
};

/**
 * Whatever of the host can be read. A reading that is not available — `/proc`
 * outside Linux, a path that is not mounted — is simply absent, never zero:
 * a zero would read as "out of memory".
 */
export function readHostPressure(filesystems: Readonly<Record<string, string>>, io: HostIo = realHostIo): HostReadings {
  const readings: HostReadings = { filesystems: [] };
  try {
    const memory = parseMeminfo(io.read('/proc/meminfo'));
    if (memory) readings.memory = memory;
  } catch {
    /* not Linux, or /proc not visible */
  }
  try {
    const load = parseLoadavg(io.read('/proc/loadavg'));
    if (load) readings.load = load;
  } catch {
    /* as above */
  }
  try {
    const cpus = io.cpus();
    if (cpus > 0) readings.cpus = cpus;
  } catch {
    /* unknown */
  }
  for (const [name, target] of Object.entries(filesystems)) {
    try {
      const stats = io.statfs(target);
      readings.filesystems.push({
        name,
        sizeBytes: stats.blocks * stats.bsize,
        availableBytes: stats.bavail * stats.bsize,
      });
    } catch {
      /* not mounted here */
    }
  }
  return readings;
}

export function recordHostPressure(metrics: OperationsMetrics, readings: HostReadings): void {
  if (readings.memory) {
    metrics.hostMemoryTotal.set(readings.memory.totalBytes);
    metrics.hostMemoryAvailable.set(readings.memory.availableBytes);
  }
  if (readings.load) {
    for (const window of ['1m', '5m', '15m'] as const) {
      metrics.hostLoadAverage.set({ window }, readings.load[window]);
    }
  }
  if (readings.cpus) metrics.hostCpus.set(readings.cpus);
  metrics.hostFilesystemSize.reset();
  metrics.hostFilesystemAvailable.reset();
  for (const filesystem of readings.filesystems) {
    metrics.hostFilesystemSize.set({ filesystem: filesystem.name }, filesystem.sizeBytes);
    metrics.hostFilesystemAvailable.set({ filesystem: filesystem.name }, filesystem.availableBytes);
  }
}

// --- network isolation ---------------------------------------------------------

export function recordAttestationDecision(
  metrics: OperationsMetrics,
  decision: AttestationDecision | 'unreadable',
  maxAgeSeconds: number,
): void {
  metrics.networkAttestationMaxAge.set(maxAgeSeconds);
  if (decision === 'unreadable') {
    metrics.networkAttestationValid.set(0);
    metrics.networkAttestationChecks.inc({ result: 'unreadable' });
    return;
  }
  if (decision.ok) {
    metrics.networkAttestationValid.set(1);
    const verifiedAt = Date.parse(decision.attestation.verifiedAt);
    if (Number.isFinite(verifiedAt)) metrics.networkAttestationVerifiedAt.set(verifiedAt / 1000);
    metrics.networkAttestationChecks.inc({ result: 'valid' });
    return;
  }
  metrics.networkAttestationValid.set(0);
  metrics.networkAttestationChecks.inc({ result: 'invalid' });
}

// --- the timers ----------------------------------------------------------------

export interface OperationsCollectorOptions {
  metrics: OperationsMetrics;
  config: OperationsConfig;
  logger: Logger;
  /** Present exactly when the Kubernetes provider requires an attestation. */
  attestation?: { k8s: KubernetesPort; network: NetworkPolicyConfig };
  now?: () => number;
  probes?: TlsEdgeProbes;
  hostIo?: HostIo;
  backupIo?: Parameters<typeof readBackupStatus>[1];
  readAttestation?: typeof readNetworkEnforcementAttestation;
}

export interface OperationsCollectors {
  checkTlsEdge(): Promise<void>;
  checkAttestation(): Promise<void>;
  readLocal(): void;
  stop(): void;
}

const LOCAL_READ_INTERVAL_MS = 30_000;
const ATTESTATION_INTERVAL_MS = 60_000;

export function installOperationsCollectors(options: OperationsCollectorOptions): OperationsCollectors {
  const { metrics, config, logger } = options;
  const now = options.now ?? (() => Date.now());
  const timers: NodeJS.Timeout[] = [];

  metrics.tlsProbeEnabled.set(config.edgeProbe.enabled ? 1 : 0);

  let lastEdgeStatus: TlsHealthStatus | undefined;
  let edgeRunning = false;
  const checkTlsEdge = async (): Promise<void> => {
    if (!config.edgeProbe.enabled || edgeRunning) return;
    edgeRunning = true;
    try {
      const reports = await runTlsEdgeCheck(config.edgeProbe, options.probes, () => new Date(now()));
      recordTlsEdgeCheck(metrics, reports, now());
      const status = reports.served.status === 'ok' ? reports.redirect.status : reports.served.status;
      if (status !== lastEdgeStatus) {
        const codes = [...reports.served.findings, ...reports.redirect.findings].map((f) => f.code);
        logger[status === 'ok' ? 'info' : 'warn'](
          'ops.tls_edge.checked',
          { outcome: status, ...(codes.length ? { code: codes.join(',') } : {}) },
          `TLS edge check: ${status}${codes.length ? ` (${codes.join(', ')})` : ''} — run npm run tls:check for detail`,
        );
        lastEdgeStatus = status;
      }
    } catch (error) {
      logger.warn('ops.tls_edge.checked', { outcome: 'check_failed', err: error });
    } finally {
      edgeRunning = false;
    }
  };

  let backupWasReadable: boolean | undefined;
  const filesystems: Record<string, string> = { container_root: '/' };
  if (config.backupStatusDir) filesystems.backup_status = config.backupStatusDir;
  const readLocal = (): void => {
    try {
      if (config.hostMetrics) recordHostPressure(metrics, readHostPressure(filesystems, options.hostIo));
    } catch {
      // `readHostPressure` swallows each unavailable reading itself; a gauge
      // write failing is not worth a log line every thirty seconds.
    }
    if (!config.backupStatusDir) return;
    try {
      const status = readBackupStatus(config.backupStatusDir, options.backupIo);
      recordBackupStatus(metrics, status);
      if (!status.readable && backupWasReadable !== false) {
        logger.warn('ops.backup_status.unreadable', { reason: 'directory_unreadable' }, 'the backup status directory cannot be read; backup freshness is unknown');
      }
      backupWasReadable = status.readable;
    } catch (error) {
      logger.warn('ops.backup_status.unreadable', { err: error });
    }
  };

  let lastAttestationValid: boolean | undefined;
  const readAttestation = options.readAttestation ?? readNetworkEnforcementAttestation;
  const checkAttestation = async (): Promise<void> => {
    const attestation = options.attestation;
    if (!attestation) return;
    const maxAge = attestation.network.attestation.maxAgeSeconds;
    let decision: AttestationDecision | 'unreadable';
    try {
      decision = await readAttestation(attestation.k8s, attestation.network, now());
    } catch {
      decision = 'unreadable';
    }
    try {
      recordAttestationDecision(metrics, decision, maxAge);
    } catch {
      /* never fatal */
    }
    const valid = decision !== 'unreadable' && decision.ok;
    if (valid !== lastAttestationValid) {
      const reason = decision === 'unreadable' ? 'the attestation could not be read' : decision.ok ? '' : decision.reason;
      logger[valid ? 'info' : 'warn'](
        'ops.network_attestation.checked',
        { outcome: valid ? 'valid' : decision === 'unreadable' ? 'unreadable' : 'invalid' },
        valid ? 'NetworkPolicy enforcement attestation is valid' : `network isolation is not proven: ${reason}`,
      );
      lastAttestationValid = valid;
    }
  };

  const every = (ms: number, run: () => unknown, firstDelayMs = 0): void => {
    const first = setTimeout(() => {
      void run();
      const timer = setInterval(() => void run(), ms);
      timer.unref?.();
      timers.push(timer);
    }, firstDelayMs);
    first.unref?.();
    timers.push(first);
  };

  readLocal();
  every(LOCAL_READ_INTERVAL_MS, readLocal, LOCAL_READ_INTERVAL_MS);
  if (config.edgeProbe.enabled) {
    // The edge starts after the API: give nginx a moment before the first verdict.
    every(config.edgeProbe.intervalSeconds * 1000, checkTlsEdge, 15_000);
  }
  if (options.attestation) every(ATTESTATION_INTERVAL_MS, checkAttestation, 0);

  return {
    checkTlsEdge,
    checkAttestation,
    readLocal,
    stop(): void {
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
    },
  };
}
