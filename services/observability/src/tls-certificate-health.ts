/**
 * Certificate and TLS edge health — BETA-P0-017.
 *
 * The checks behind `npm run tls:check` (scripts/tls-check.ts), written to be
 * run from outside the edge, on a schedule, by whatever an operator already
 * uses to run a command and alert on its exit code:
 *
 *   files   the installed fullchain.pem / privkey.pem, read from disk: parsed,
 *           matched, in date, naming the host, chained in order, key strength
 *           and file mode. The same rules the web image's startup gate
 *           (infrastructure/docker/nginx/tls-preflight.sh) enforces.
 *   served  a real, fully verified TLS connection to the edge, as a browser
 *           makes it: the chain against the public roots (or a staging CA),
 *           the host name, the protocol, expiry, HSTS, and whether the
 *           certificate served is the one installed.
 *   http    port 80 redirects to the https origin and serves nothing itself.
 *   acme    (on request) port 80 answers the ACME HTTP-01 path itself rather
 *           than redirecting it.
 *
 * Nothing here disables certificate verification. A failed verification is the
 * finding. Nothing here reads a private key except to ask whether it belongs
 * to the certificate, and no message contains key material or an error text
 * derived from it.
 *
 * Exit status: 0 OK, 1 WARNING (renewal due), 2 CRITICAL or unable to check.
 */
import { X509Certificate, createPrivateKey, randomBytes, type KeyObject } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import type { TLSSocket } from 'node:tls';
import { parseArgs } from 'node:util';

export type TlsHealthStatus = 'ok' | 'warning' | 'critical';

export interface TlsFinding {
  status: Exclude<TlsHealthStatus, 'ok'>;
  code: string;
  message: string;
}

/** Public facts about a certificate. Nothing in it is secret. */
export interface CertificateSummary {
  subject: string;
  issuer: string;
  subjectAltName: string;
  notBefore: string;
  notAfter: string;
  /** Whole days until notAfter; negative once expired. */
  daysRemaining: number;
  fingerprint256: string;
}

export interface TlsHealthReport {
  status: TlsHealthStatus;
  findings: TlsFinding[];
  certificate?: CertificateSummary;
}

export interface ExpiryThresholds {
  /** Below this many days: WARNING, renew now. */
  warnDays: number;
  /** Below this many days: CRITICAL, renewal has failed or was never scheduled. */
  criticalDays: number;
}

export const DEFAULT_EXPIRY_THRESHOLDS: ExpiryThresholds = { warnDays: 21, criticalDays: 7 };

const DAY_MS = 86_400_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const ACCEPTED_CURVES = ['prime256v1', 'secp384r1', 'secp521r1'];
/** The same shape tls-preflight.sh accepts: a DNS name whose last label starts with a letter. */
const DNS_HOSTNAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A problem with how the check was asked for, rather than with the edge. */
export class TlsCheckUsageError extends Error {}

function buildReport(findings: TlsFinding[], certificate?: CertificateSummary): TlsHealthReport {
  const status: TlsHealthStatus = findings.some((f) => f.status === 'critical')
    ? 'critical'
    : findings.some((f) => f.status === 'warning')
      ? 'warning'
      : 'ok';
  return certificate ? { status, findings, certificate } : { status, findings };
}

const critical = (code: string, message: string): TlsFinding => ({ status: 'critical', code, message });
const warning = (code: string, message: string): TlsFinding => ({ status: 'warning', code, message });

export function worstStatus(statuses: readonly TlsHealthStatus[]): TlsHealthStatus {
  if (statuses.includes('critical')) return 'critical';
  if (statuses.includes('warning')) return 'warning';
  return 'ok';
}

export function exitCodeFor(status: TlsHealthStatus): 0 | 1 | 2 {
  return status === 'ok' ? 0 : status === 'warning' ? 1 : 2;
}

/**
 * The one host name the edge serves, from `PUBLIC_ORIGIN`. Stricter than the
 * api's bare-origin rule: no port, because the edge is the 443 listener, and no
 * IP address, because a public certificate names a DNS host.
 */
export function publicHostname(origin: string): string {
  const trimmed = origin.trim().replace(/\/$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TlsCheckUsageError('the origin is not a URL; expected https://<host>.');
  }
  if (url.protocol !== 'https:') throw new TlsCheckUsageError('the origin must be https://<host>.');
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new TlsCheckUsageError('the origin must be exactly https://<host>: no credentials, path, query or fragment.');
  }
  if (url.port) throw new TlsCheckUsageError('the origin must not carry a port: the edge serves 443.');
  if (trimmed !== url.origin) throw new TlsCheckUsageError('the origin must be written in canonical form (lower case).');
  if (!DNS_HOSTNAME.test(url.hostname)) {
    throw new TlsCheckUsageError('the origin host must be a DNS name, not an IP address.');
  }
  return url.hostname;
}

export function splitPemCertificates(pem: string): string[] {
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
}

export function summarizeCertificate(cert: X509Certificate, now: Date): CertificateSummary {
  const notAfter = new Date(cert.validTo);
  return {
    subject: cert.subject.replace(/\n/g, ', '),
    issuer: cert.issuer.replace(/\n/g, ', '),
    subjectAltName: cert.subjectAltName ?? '',
    notBefore: new Date(cert.validFrom).toISOString(),
    notAfter: notAfter.toISOString(),
    daysRemaining: Math.floor((notAfter.getTime() - now.getTime()) / DAY_MS),
    fingerprint256: cert.fingerprint256,
  };
}

function validityFindings(summary: CertificateSummary, now: Date, thresholds: ExpiryThresholds): TlsFinding[] {
  const notBefore = Date.parse(summary.notBefore);
  const notAfter = Date.parse(summary.notAfter);
  if (notBefore > now.getTime()) {
    return [critical('not_yet_valid', `the certificate is not valid until ${summary.notBefore}.`)];
  }
  if (notAfter <= now.getTime()) {
    return [critical('expired', `the certificate expired at ${summary.notAfter}.`)];
  }
  const days = (notAfter - now.getTime()) / DAY_MS;
  if (days < thresholds.criticalDays) {
    return [
      critical(
        'expires_soon',
        `the certificate expires at ${summary.notAfter}, in under ${thresholds.criticalDays} days: renewal has failed or never ran.`,
      ),
    ];
  }
  if (days < thresholds.warnDays) {
    return [warning('renewal_due', `the certificate expires at ${summary.notAfter}, in under ${thresholds.warnDays} days: renew it.`)];
  }
  return [];
}

function keyStrengthFindings(key: KeyObject): TlsFinding[] {
  const details = key.asymmetricKeyDetails ?? {};
  if (key.asymmetricKeyType === 'rsa') {
    const bits = details.modulusLength ?? 0;
    return bits >= 2048 ? [] : [critical('weak_key', `the certificate has a ${bits}-bit RSA key; use RSA 2048 or larger, or EC P-256.`)];
  }
  if (key.asymmetricKeyType === 'ec') {
    const curve = details.namedCurve ?? 'unknown';
    return ACCEPTED_CURVES.includes(curve)
      ? []
      : [critical('weak_key', `the certificate has an EC key on ${curve}; use P-256, P-384 or P-521.`)];
  }
  return [
    critical('unsupported_key_type', `the certificate has a ${key.asymmetricKeyType ?? 'unknown'} key, which browsers do not all accept; use RSA or EC.`),
  ];
}

function chainFindings(chain: readonly X509Certificate[], now: Date): TlsFinding[] {
  const leaf = chain[0]!;
  if (chain.length === 1) {
    if (leaf.checkIssued(leaf) && leaf.verify(leaf.publicKey)) {
      return [critical('self_signed', 'the certificate is self-signed: no browser trusts it.')];
    }
    return [
      critical(
        'chain_incomplete',
        'the file holds only the server certificate. Append its intermediate certificate(s): clients that do not fetch them, curl and Node among them, refuse the connection.',
      ),
    ];
  }
  const findings: TlsFinding[] = [];
  for (let i = 0; i + 1 < chain.length; i += 1) {
    const child = chain[i]!;
    const parent = chain[i + 1]!;
    if (!child.checkIssued(parent) || !child.verify(parent.publicKey)) {
      findings.push(
        critical('chain_order', `certificate ${i + 1} in the file is not issued by certificate ${i + 2}: the chain is out of order or holds an unrelated certificate.`),
      );
      break;
    }
  }
  chain.slice(1).forEach((cert, index) => {
    if (Date.parse(cert.validFrom) > now.getTime() || Date.parse(cert.validTo) <= now.getTime()) {
      findings.push(critical('intermediate_out_of_date', `certificate ${index + 2} in the file (${cert.subject.replace(/\n/g, ', ')}) is outside its validity period.`));
    }
  });
  return findings;
}

function privateKeyFindings(leaf: X509Certificate, privateKeyPem: string): TlsFinding[] {
  if (/-----BEGIN CERTIFICATE-----/.test(privateKeyPem)) {
    return [critical('certificate_in_key_file', 'the private key file contains a certificate; it must hold the key only.')];
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    // The error text is not repeated: it is derived from the key file.
    return [critical('key_unreadable', 'the private key cannot be read: it is malformed, encrypted, or not a private key.')];
  }
  return leaf.checkPrivateKey(key) ? [] : [critical('key_mismatch', 'the private key does not belong to the server certificate.')];
}

export interface CertificateFilesInput {
  /** fullchain.pem: the server certificate, then its intermediates. */
  certificatePem: string;
  /** privkey.pem, when the check may read it. */
  privateKeyPem?: string;
  /** privkey.pem's st_mode, when known. */
  privateKeyMode?: number;
  hostname: string;
  now?: Date;
  thresholds?: ExpiryThresholds;
}

/** The installed pair, as files. */
export function inspectCertificateFiles(input: CertificateFilesInput): TlsHealthReport {
  const now = input.now ?? new Date();
  const thresholds = input.thresholds ?? DEFAULT_EXPIRY_THRESHOLDS;
  const findings: TlsFinding[] = [];

  if (/PRIVATE KEY-----/.test(input.certificatePem)) {
    findings.push(critical('private_key_in_certificate_file', 'the certificate file contains a private key; it must hold certificates only.'));
  }
  const pems = splitPemCertificates(input.certificatePem);
  if (pems.length === 0) {
    findings.push(critical('no_certificate', 'the certificate file holds no PEM certificate.'));
    return buildReport(findings);
  }
  let chain: X509Certificate[];
  try {
    chain = pems.map((pem) => new X509Certificate(pem));
  } catch {
    findings.push(critical('certificate_unparseable', 'a certificate in the file cannot be parsed.'));
    return buildReport(findings);
  }

  const leaf = chain[0]!;
  const summary = summarizeCertificate(leaf, now);
  if (leaf.ca) findings.push(critical('leaf_is_ca', 'the first certificate in the file is a CA certificate, not the server certificate.'));
  if (leaf.checkHost(input.hostname) === undefined) {
    findings.push(critical('hostname_mismatch', `the certificate does not name ${input.hostname} (${summary.subjectAltName || 'no subjectAltName'}).`));
  }
  findings.push(...validityFindings(summary, now, thresholds));
  findings.push(...keyStrengthFindings(leaf.publicKey));
  findings.push(...chainFindings(chain, now));
  if (input.privateKeyPem !== undefined) findings.push(...privateKeyFindings(leaf, input.privateKeyPem));
  if (input.privateKeyMode !== undefined && (input.privateKeyMode & 0o077) !== 0) {
    findings.push(
      critical('key_file_permissions', `the private key file is readable by group or others (mode ${(input.privateKeyMode & 0o777).toString(8)}); chmod 600 it.`),
    );
  }
  return buildReport(findings, summary);
}

/** A renewal installed on disk but never loaded, or an edge serving something else entirely. */
export function compareServedToInstalled(installed: CertificateSummary | undefined, served: CertificateSummary | undefined): TlsFinding[] {
  if (!installed || !served || installed.fingerprint256 === served.fingerprint256) return [];
  return [
    critical(
      'served_differs_from_installed',
      `the edge serves ${served.fingerprint256} (until ${served.notAfter}), not the installed ${installed.fingerprint256}: reload nginx (scripts/tls-install.sh does), or find what is answering instead.`,
    ),
  ];
}

export interface EndpointProbeOptions {
  /** The public host: the TLS server name, the certificate identity and the Host header. */
  hostname: string;
  /** Where to connect, when not the hostname's DNS record: a staging address, or loopback. */
  connectHost?: string;
  port?: number;
  /** Trust this CA instead of the public roots. Staging only; a production check never passes one. */
  ca?: string | Buffer;
  timeoutMs?: number;
  now?: Date;
  thresholds?: ExpiryThresholds;
}

const HANDSHAKE_REASONS: Record<string, [string, string]> = {
  CERT_HAS_EXPIRED: ['served_expired', 'the served certificate has expired'],
  CERT_NOT_YET_VALID: ['served_not_yet_valid', 'the served certificate is not yet valid'],
  ERR_TLS_CERT_ALTNAME_INVALID: ['served_hostname_mismatch', 'the served certificate does not name the host'],
  DEPTH_ZERO_SELF_SIGNED_CERT: ['served_untrusted', 'the served certificate is self-signed'],
  SELF_SIGNED_CERT_IN_CHAIN: ['served_untrusted', 'the served chain ends in an untrusted root'],
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: ['served_untrusted', 'the served chain does not reach a trusted root (a missing intermediate?)'],
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: ['served_untrusted', 'the served chain does not reach a trusted root (a missing intermediate?)'],
  ECONNREFUSED: ['connection_refused', 'nothing accepts connections there'],
  ECONNRESET: ['handshake_failed', 'the connection was reset during the handshake (the server did not recognise the name?)'],
  ETIMEDOUT: ['timeout', 'no answer in time'],
  ENOTFOUND: ['dns_lookup_failed', 'the host name does not resolve'],
};

function connectFailure(error: NodeJS.ErrnoException, where: string): TlsFinding {
  const code = error.code ?? 'UNKNOWN';
  const [findingCode, reason] = HANDSHAKE_REASONS[code] ?? ['handshake_failed', 'the TLS connection failed'];
  return critical(findingCode, `${where}: ${reason} [${code}].`);
}

export interface HttpsProbeResult {
  report: TlsHealthReport;
  protocol?: string;
  statusCode?: number;
}

/** A browser's view of the edge: one fully verified HTTPS request. */
export function probeHttpsEndpoint(options: EndpointProbeOptions): Promise<HttpsProbeResult> {
  const port = options.port ?? 443;
  const connectHost = options.connectHost ?? options.hostname;
  const where = `https://${options.hostname}${port === 443 ? '' : `:${port}`} via ${connectHost}`;
  const now = options.now ?? new Date();
  const thresholds = options.thresholds ?? DEFAULT_EXPIRY_THRESHOLDS;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HttpsProbeResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = httpsRequest(
      {
        host: connectHost,
        port,
        servername: options.hostname,
        method: 'GET',
        path: '/',
        headers: { host: options.hostname, 'user-agent': 'jumptotech-tls-check' },
        ...(options.ca ? { ca: options.ca } : {}),
        agent: false,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
      (response) => {
        const socket = response.socket as TLSSocket;
        const peer = socket.getPeerX509Certificate();
        const protocol = socket.getProtocol() ?? undefined;
        const statusCode = response.statusCode;
        const findings: TlsFinding[] = [];
        const summary = peer ? summarizeCertificate(peer, now) : undefined;
        if (summary) findings.push(...validityFindings(summary, now, thresholds));
        if (protocol !== 'TLSv1.2' && protocol !== 'TLSv1.3') {
          findings.push(critical('legacy_protocol', `${where}: negotiated ${protocol ?? 'no protocol'}.`));
        }
        if (!response.headers['strict-transport-security']) {
          findings.push(warning('hsts_missing', `${where}: no Strict-Transport-Security header.`));
        }
        if (statusCode === undefined || statusCode >= 500) {
          findings.push(warning('unexpected_status', `${where}: GET / answered ${statusCode ?? 'nothing'}.`));
        }
        response.destroy();
        finish({ report: buildReport(findings, summary), ...(protocol ? { protocol } : {}), ...(statusCode ? { statusCode } : {}) });
      },
    );
    request.on('timeout', () => {
      request.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
    });
    request.on('error', (error: NodeJS.ErrnoException) => {
      finish({ report: buildReport([connectFailure(error, where)]) });
    });
    request.end();
  });
}

interface PlainResponse {
  statusCode: number;
  location: string | undefined;
}

function plainGet(options: EndpointProbeOptions, requestPath: string): Promise<PlainResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: options.connectHost ?? options.hostname,
        port: options.port ?? 80,
        method: 'GET',
        path: requestPath,
        headers: { host: options.hostname, 'user-agent': 'jumptotech-tls-check' },
        agent: false,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
      (response) => {
        const location = response.headers.location;
        response.destroy();
        resolve({ statusCode: response.statusCode ?? 0, location });
      },
    );
    request.on('timeout', () => request.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    request.on('error', reject);
    request.end();
  });
}

/** Port 80 sends every request to the https origin, and serves nothing itself. */
export async function probeHttpRedirect(options: EndpointProbeOptions): Promise<TlsHealthReport> {
  const requestPath = '/jtt-tls-check?probe=redirect';
  const expected = `https://${options.hostname}${requestPath}`;
  const where = `http://${options.hostname}${(options.port ?? 80) === 80 ? '' : `:${options.port}`}`;
  try {
    const { statusCode, location } = await plainGet(options, requestPath);
    if ((statusCode === 301 || statusCode === 308) && location === expected) return buildReport([]);
    if (statusCode >= 300 && statusCode < 400) {
      return buildReport([critical('http_redirect_wrong_target', `${where}: ${statusCode} to ${location ?? 'nowhere'}, expected ${expected}.`)]);
    }
    return buildReport([critical('http_serves_plaintext', `${where}: answered ${statusCode} over plain HTTP instead of redirecting to https.`)]);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === 'ECONNREFUSED') {
      return buildReport([
        warning('http_port_closed', `${where}: nothing answers on port 80, so http:// links fail instead of redirecting, and ACME HTTP-01 cannot validate.`),
      ]);
    }
    return buildReport([connectFailure(failure, where)]);
  }
}

/** Port 80 answers the ACME HTTP-01 path itself: an absent token is a 404, not a redirect. */
export async function probeAcmeChallengeRoute(options: EndpointProbeOptions): Promise<TlsHealthReport> {
  const requestPath = `/.well-known/acme-challenge/jtt-tls-check-${randomBytes(8).toString('hex')}`;
  const where = `http://${options.hostname}${requestPath}`;
  try {
    const { statusCode, location } = await plainGet(options, requestPath);
    if (statusCode === 404) return buildReport([]);
    if (statusCode >= 300 && statusCode < 400) {
      return buildReport([critical('acme_route_redirected', `${where}: ${statusCode} to ${location ?? 'nowhere'}; an HTTP-01 challenge would not be answered.`)]);
    }
    return buildReport([critical('acme_route_unexpected', `${where}: answered ${statusCode} for a token that does not exist; expected 404.`)]);
  } catch (error) {
    return buildReport([connectFailure(error as NodeJS.ErrnoException, where)]);
  }
}

export interface TlsCheckResult {
  exitCode: 0 | 1 | 2;
  output: string;
}

const USAGE = `usage: npm run tls:check -- [--origin https://host] [--connect host] [--https-port 443] [--http-port 80]
                           [--ca-file staging-ca.pem] [--cert-dir infrastructure/docker/nginx/tls]
                           [--warn-days 21] [--critical-days 7] [--skip-http] [--expect-acme] [--offline] [--json]`;

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new TlsCheckUsageError(`--${name} must be a whole number, got '${value}'.`);
  return Number(value);
}

/**
 * The command line, as a function. `argv` excludes node and the script; the
 * origin defaults to `PUBLIC_ORIGIN`, as the deployment itself reads it.
 */
export async function runTlsCheck(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Promise<TlsCheckResult> {
  let hostname: string;
  const sections: Record<string, TlsHealthReport> = {};
  let json = false;
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        origin: { type: 'string' },
        connect: { type: 'string' },
        'https-port': { type: 'string' },
        'http-port': { type: 'string' },
        'ca-file': { type: 'string' },
        'cert-dir': { type: 'string' },
        'warn-days': { type: 'string' },
        'critical-days': { type: 'string' },
        'skip-http': { type: 'boolean', default: false },
        'expect-acme': { type: 'boolean', default: false },
        offline: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    json = values.json === true;
    const origin = values.origin ?? env.PUBLIC_ORIGIN;
    if (!origin) throw new TlsCheckUsageError('no origin: pass --origin or set PUBLIC_ORIGIN.');
    hostname = publicHostname(origin);
    const thresholds: ExpiryThresholds = {
      warnDays: positiveInteger('warn-days', values['warn-days'], DEFAULT_EXPIRY_THRESHOLDS.warnDays),
      criticalDays: positiveInteger('critical-days', values['critical-days'], DEFAULT_EXPIRY_THRESHOLDS.criticalDays),
    };
    if (thresholds.criticalDays > thresholds.warnDays) {
      throw new TlsCheckUsageError('--critical-days must not exceed --warn-days.');
    }
    if (values.offline && !values['cert-dir']) throw new TlsCheckUsageError('--offline checks files only, and needs --cert-dir.');

    if (values['cert-dir']) {
      const dir = path.resolve(cwd, values['cert-dir']);
      const certFile = path.join(dir, 'fullchain.pem');
      const keyFile = path.join(dir, 'privkey.pem');
      let certificatePem: string;
      try {
        certificatePem = readFileSync(certFile, 'utf8');
      } catch {
        throw new TlsCheckUsageError(`${certFile} cannot be read.`);
      }
      let privateKeyPem: string | undefined;
      let privateKeyMode: number | undefined;
      try {
        privateKeyMode = statSync(keyFile).mode;
        privateKeyPem = readFileSync(keyFile, 'utf8');
      } catch {
        // Monitoring often may read the certificate but not the key: say so, and check the rest.
      }
      sections.files = inspectCertificateFiles({ certificatePem, privateKeyPem, privateKeyMode, hostname, thresholds });
      if (privateKeyPem === undefined) {
        sections.files.findings.push(warning('key_not_checked', `${keyFile} could not be read by this check; the key match was not verified.`));
        sections.files = buildReport(sections.files.findings, sections.files.certificate);
      }
    }

    if (!values.offline) {
      let ca: Buffer | undefined;
      if (values['ca-file']) {
        try {
          ca = readFileSync(path.resolve(cwd, values['ca-file']));
        } catch {
          throw new TlsCheckUsageError(`${values['ca-file']} cannot be read.`);
        }
      }
      const endpoint = {
        hostname,
        ...(values.connect ? { connectHost: values.connect } : {}),
        thresholds,
      };
      const served = await probeHttpsEndpoint({
        ...endpoint,
        port: positiveInteger('https-port', values['https-port'], 443),
        ...(ca ? { ca } : {}),
      });
      const differs = compareServedToInstalled(sections.files?.certificate, served.report.certificate);
      sections.served = buildReport([...served.report.findings, ...differs], served.report.certificate);
      const httpPort = positiveInteger('http-port', values['http-port'], 80);
      if (!values['skip-http']) sections.http = await probeHttpRedirect({ ...endpoint, port: httpPort });
      if (values['expect-acme']) sections.acme = await probeAcmeChallengeRoute({ ...endpoint, port: httpPort });
    }
  } catch (error) {
    if (error instanceof TlsCheckUsageError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      const message = error instanceof Error ? error.message : String(error);
      return { exitCode: 2, output: `tls-check: ${message}\n${USAGE}\n` };
    }
    throw error;
  }

  const status = worstStatus(Object.values(sections).map((section) => section.status));
  if (json) {
    return { exitCode: exitCodeFor(status), output: `${JSON.stringify({ hostname, status, sections }, null, 2)}\n` };
  }
  const lines = [`TLS check for ${hostname}: ${status.toUpperCase()}`];
  for (const [name, section] of Object.entries(sections)) {
    const cert = section.certificate;
    const detail = cert ? `sha256=${cert.fingerprint256} notAfter=${cert.notAfter} (${cert.daysRemaining} days)` : '';
    lines.push(`  ${name.padEnd(7)} ${section.status.toUpperCase().padEnd(8)} ${detail}`.trimEnd());
    for (const finding of section.findings) {
      lines.push(`    ${finding.status.toUpperCase()} ${finding.code}: ${finding.message}`);
    }
  }
  return { exitCode: exitCodeFor(status), output: `${lines.join('\n')}\n` };
}
