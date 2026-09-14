/**
 * BETA-P0-017 — the certificate expiry and TLS edge health checks.
 *
 * Everything here is real X.509 and real TLS: certificates minted in memory by
 * test-support/tls-pki.ts (never committed, never a production certificate),
 * served by in-process HTTPS and HTTP listeners on 127.0.0.1 port 0, and
 * checked with full verification. No domain, DNS record or public CA is
 * involved, and nothing here claims a public certificate was issued.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrivateKey } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo, Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createSelfSignedServer, createTestCa, type TestCa, type TestIdentity } from '@jumptotech/test-support/tls-pki';

import {
  DEFAULT_EXPIRY_THRESHOLDS,
  TlsCheckUsageError,
  compareServedToInstalled,
  exitCodeFor,
  inspectCertificateFiles,
  probeAcmeChallengeRoute,
  probeHttpRedirect,
  probeHttpsEndpoint,
  publicHostname,
  runTlsCheck,
  type TlsHealthReport,
} from '../src/tls-certificate-health.js';

const HOST = 'labs.jtt.test';
const DAY = 86_400_000;
const at = (days: number): Date => new Date(Date.now() + days * DAY);

interface Fixtures {
  root: TestCa;
  intermediate: TestCa;
  unrelated: TestCa;
  good: TestIdentity;
  other: TestIdentity;
  warnSoon: TestIdentity;
  criticalSoon: TestIdentity;
  expired: TestIdentity;
  future: TestIdentity;
  wrongHost: TestIdentity;
  caLeaf: TestIdentity;
  rsa1024: TestIdentity;
  rsa2048: TestIdentity;
  selfSigned: TestIdentity;
  staleIntermediateChain: string;
}

let f: Fixtures;
const chain = (leaf: TestIdentity): string => leaf.cert + f.intermediate.cert;
const codes = (report: TlsHealthReport): string[] => report.findings.map((finding) => finding.code);

/** The base64 body of a PEM key, in chunks long enough to be unmistakable. */
function keyFragments(pem: string): string[] {
  return pem
    .split('\n')
    .filter((line) => line && !line.startsWith('-----'))
    .map((line) => line.slice(0, 40))
    .filter((line) => line.length >= 40);
}

function expectNoKeyMaterial(text: string, ...keys: string[]): void {
  expect(text).not.toContain('PRIVATE KEY');
  for (const key of keys) for (const fragment of keyFragments(key)) expect(text).not.toContain(fragment);
}

beforeAll(() => {
  const root = createTestCa('jtt p0017 root', { notBefore: at(-1), notAfter: at(3650) });
  const intermediate = root.intermediate('jtt p0017 intermediate', { notBefore: at(-1), notAfter: at(1000) });
  const stale = root.intermediate('jtt p0017 stale intermediate', { notBefore: at(-30), notAfter: at(-1) });
  const staleLeaf = stale.issue({ dns: [HOST], notAfter: at(90) });
  f = {
    root,
    intermediate,
    unrelated: createTestCa('jtt p0017 unrelated', { notAfter: at(3650) }),
    good: intermediate.issue({ dns: [HOST], notAfter: at(90) }),
    other: intermediate.issue({ dns: [HOST], notAfter: at(60) }),
    warnSoon: intermediate.issue({ dns: [HOST], notAfter: at(10) }),
    criticalSoon: intermediate.issue({ dns: [HOST], notAfter: at(3) }),
    expired: intermediate.issue({ dns: [HOST], notBefore: at(-30), notAfter: at(-1) }),
    future: intermediate.issue({ dns: [HOST], notBefore: at(1), notAfter: at(90) }),
    wrongHost: intermediate.issue({ dns: ['other.jtt.test'], notAfter: at(90) }),
    caLeaf: intermediate.issue({ dns: [HOST], isCa: true, notAfter: at(90) }),
    rsa1024: intermediate.issue({ dns: [HOST], keyType: 'rsa', rsaBits: 1024, notAfter: at(90) }),
    rsa2048: intermediate.issue({ dns: [HOST], keyType: 'rsa', rsaBits: 2048, notAfter: at(90) }),
    selfSigned: createSelfSignedServer({ dns: [HOST], notAfter: at(90) }),
    staleIntermediateChain: staleLeaf.cert + stale.cert,
  };
}, 60_000);

describe('publicHostname', () => {
  it('takes the one host name from a bare https origin', () => {
    expect(publicHostname('https://labs.example.com')).toBe('labs.example.com');
    expect(publicHostname('https://labs.example.com/')).toBe('labs.example.com');
  });

  it.each([
    ['plain http', 'http://labs.example.com'],
    ['a port', 'https://labs.example.com:8443'],
    ['a path', 'https://labs.example.com/app'],
    ['a query', 'https://labs.example.com/?x=1'],
    ['an IPv4 address', 'https://203.0.113.10'],
    ['an IPv6 address', 'https://[2001:db8::1]'],
    ['upper case', 'https://Labs.Example.com'],
    ['not a URL', 'labs.example.com'],
  ])('refuses %s', (_name, origin) => {
    expect(() => publicHostname(origin)).toThrow(TlsCheckUsageError);
  });

  it('never repeats credentials pasted into the origin', () => {
    try {
      publicHostname('https://operator:hunter2-p0017@labs.example.com');
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('hunter2-p0017');
    }
  });
});

describe('inspectCertificateFiles — the installed pair', () => {
  const inspect = (certificatePem: string, privateKeyPem?: string, extra: { privateKeyMode?: number; now?: Date } = {}) =>
    inspectCertificateFiles({ certificatePem, privateKeyPem, hostname: HOST, ...extra });

  it('accepts a matching, in-date, chained EC pair with a 600 key', () => {
    const report = inspect(chain(f.good), f.good.key, { privateKeyMode: 0o100600 });
    expect(report.findings).toEqual([]);
    expect(report.status).toBe('ok');
    expect(report.certificate?.daysRemaining).toBeGreaterThanOrEqual(89);
    expect(report.certificate?.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(report.certificate?.subjectAltName).toBe(`DNS:${HOST}`);
  });

  it('accepts RSA 2048', () => {
    expect(inspect(chain(f.rsa2048), f.rsa2048.key).status).toBe('ok');
  });

  it.each<[string, () => [string, string | undefined, { privateKeyMode?: number }?], string]>([
    ['an expired certificate', () => [chain(f.expired), f.expired.key], 'expired'],
    ['a certificate not yet valid', () => [chain(f.future), f.future.key], 'not_yet_valid'],
    ['a certificate for another host', () => [chain(f.wrongHost), f.wrongHost.key], 'hostname_mismatch'],
    ['a key that belongs to another certificate', () => [chain(f.good), f.other.key], 'key_mismatch'],
    ['a CA certificate as the server certificate', () => [chain(f.caLeaf), f.caLeaf.key], 'leaf_is_ca'],
    ['a 1024-bit RSA key', () => [chain(f.rsa1024), f.rsa1024.key], 'weak_key'],
    ['a self-signed certificate', () => [f.selfSigned.cert, f.selfSigned.key], 'self_signed'],
    ['the server certificate with no intermediate', () => [f.good.cert, f.good.key], 'chain_incomplete'],
    ['an unrelated certificate after the server certificate', () => [f.good.cert + f.unrelated.cert, f.good.key], 'chain_order'],
    ['an intermediate that has expired', () => [f.staleIntermediateChain, undefined], 'intermediate_out_of_date'],
    ['a private key inside fullchain.pem', () => [chain(f.good) + f.good.key, f.good.key], 'private_key_in_certificate_file'],
    ['a certificate inside privkey.pem', () => [chain(f.good), f.good.key + f.good.cert], 'certificate_in_key_file'],
    ['a key readable by group or others', () => [chain(f.good), f.good.key, { privateKeyMode: 0o100644 }], 'key_file_permissions'],
    ['a file with no certificate', () => ['not a certificate', f.good.key], 'no_certificate'],
  ])('refuses %s', (_name, input, code) => {
    const [certificatePem, privateKeyPem, extra] = input();
    const report = inspect(certificatePem, privateKeyPem, extra ?? {});
    expect(codes(report)).toContain(code);
    expect(report.status).toBe('critical');
    expect(exitCodeFor(report.status)).toBe(2);
  });

  it('refuses an encrypted key without repeating the key or the reason derived from it', () => {
    const encrypted = createPrivateKey(f.good.key)
      .export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'p0017-passphrase' })
      .toString();
    const report = inspect(chain(f.good), encrypted);
    expect(codes(report)).toEqual(['key_unreadable']);
    expectNoKeyMaterial(JSON.stringify(report), encrypted, f.good.key);
    expect(JSON.stringify(report)).not.toContain('p0017-passphrase');
  });

  it('warns inside the renewal window, and is critical inside the failure window', () => {
    const warn = inspect(chain(f.warnSoon), f.warnSoon.key);
    expect(warn.status).toBe('warning');
    expect(codes(warn)).toEqual(['renewal_due']);
    expect(exitCodeFor(warn.status)).toBe(1);

    const soon = inspect(chain(f.criticalSoon), f.criticalSoon.key);
    expect(soon.status).toBe('critical');
    expect(codes(soon)).toEqual(['expires_soon']);
  });

  it('uses the thresholds it is given, against the time it is given', () => {
    expect(DEFAULT_EXPIRY_THRESHOLDS).toEqual({ warnDays: 21, criticalDays: 7 });
    const strict = inspectCertificateFiles({
      certificatePem: chain(f.good),
      hostname: HOST,
      thresholds: { warnDays: 120, criticalDays: 30 },
    });
    expect(codes(strict)).toEqual(['renewal_due']);
    const later = inspectCertificateFiles({ certificatePem: chain(f.good), hostname: HOST, now: at(91) });
    expect(codes(later)).toContain('expired');
  });

  it('never puts key material in a report, whatever it found', () => {
    for (const [cert, key] of [
      [chain(f.good), f.good.key],
      [chain(f.good), f.other.key],
      [chain(f.good) + f.good.key, f.good.key],
      [chain(f.good), f.good.key + f.good.cert],
    ] as const) {
      expectNoKeyMaterial(JSON.stringify(inspect(cert, key, { privateKeyMode: 0o100644 })), f.good.key, f.other.key);
    }
  });
});

// --- live listeners -------------------------------------------------------

const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function serveTls(certificatePem: string, key: string, { hsts = true } = {}): Promise<number> {
  return listen(
    createHttpsServer({ cert: certificatePem, key }, (_req, res) => {
      if (hsts) res.setHeader('strict-transport-security', 'max-age=31536000');
      res.end('ok');
    }),
  );
}

function serveHttp(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  return listen(createHttpServer(handler));
}

async function closedPort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const redirectToOrigin = (req: IncomingMessage, res: ServerResponse): void => {
  if (req.url?.startsWith('/.well-known/acme-challenge/')) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(301, { location: `https://${HOST}${req.url}` }).end();
};

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('probeHttpsEndpoint — what a browser is served', () => {
  const probe = (port: number, ca: string = f.root.cert, extra = {}) =>
    probeHttpsEndpoint({ hostname: HOST, connectHost: '127.0.0.1', port, ca, timeoutMs: 5_000, ...extra });

  it('verifies a trusted chain for the host, over TLS 1.2 or 1.3, with HSTS', async () => {
    const result = await probe(await serveTls(chain(f.good), f.good.key));
    expect(result.report.findings).toEqual([]);
    expect(result.report.status).toBe('ok');
    expect(['TLSv1.2', 'TLSv1.3']).toContain(result.protocol);
    expect(result.statusCode).toBe(200);
    expect(result.report.certificate?.fingerprint256).toBe(
      inspectCertificateFiles({ certificatePem: chain(f.good), hostname: HOST }).certificate?.fingerprint256,
    );
  });

  it.each<[string, () => [string, string], string]>([
    ['an expired certificate', () => [chain(f.expired), f.expired.key], 'served_expired'],
    ['a certificate not yet valid', () => [chain(f.future), f.future.key], 'served_not_yet_valid'],
    ['a certificate for another host', () => [chain(f.wrongHost), f.wrongHost.key], 'served_hostname_mismatch'],
    ['a chain missing its intermediate', () => [f.good.cert, f.good.key], 'served_untrusted'],
    ['a self-signed certificate', () => [f.selfSigned.cert, f.selfSigned.key], 'served_untrusted'],
  ])('is critical when the edge serves %s', async (_name, input, code) => {
    const [cert, key] = input();
    const result = await probe(await serveTls(cert, key));
    expect(codes(result.report)).toEqual([code]);
    expect(result.report.status).toBe('critical');
  });

  it('is critical for a chain no trusted root anchors', async () => {
    const result = await probe(await serveTls(chain(f.good), f.good.key), f.unrelated.cert);
    expect(codes(result.report)).toEqual(['served_untrusted']);
  });

  it('is critical when nothing listens', async () => {
    const result = await probe(await closedPort());
    expect(codes(result.report)).toEqual(['connection_refused']);
  });

  it('warns when the served certificate is due for renewal, or HSTS is missing', async () => {
    const soon = await probe(await serveTls(chain(f.warnSoon), f.warnSoon.key));
    expect(codes(soon.report)).toEqual(['renewal_due']);
    const noHsts = await probe(await serveTls(chain(f.good), f.good.key, { hsts: false }));
    expect(codes(noHsts.report)).toEqual(['hsts_missing']);
    expect(noHsts.report.status).toBe('warning');
  });
});

describe('compareServedToInstalled — renewed, but never reloaded', () => {
  it('is critical when the served fingerprint is not the installed one', () => {
    const installed = inspectCertificateFiles({ certificatePem: chain(f.good), hostname: HOST }).certificate;
    const served = inspectCertificateFiles({ certificatePem: chain(f.other), hostname: HOST }).certificate;
    expect(compareServedToInstalled(installed, installed)).toEqual([]);
    expect(compareServedToInstalled(installed, served).map((finding) => finding.code)).toEqual(['served_differs_from_installed']);
  });
});

describe('probeHttpRedirect and probeAcmeChallengeRoute — port 80', () => {
  const probe = (port: number) => ({ hostname: HOST, connectHost: '127.0.0.1', port, timeoutMs: 5_000 });

  it('accepts a 301 to the same path on the https origin', async () => {
    expect((await probeHttpRedirect(probe(await serveHttp(redirectToOrigin)))).findings).toEqual([]);
  });

  it('is critical for a redirect to anywhere else', async () => {
    const port = await serveHttp((req, res) => res.writeHead(301, { location: `https://evil.example${req.url}` }).end());
    expect(codes(await probeHttpRedirect(probe(port)))).toEqual(['http_redirect_wrong_target']);
  });

  it('is critical for content served in plaintext', async () => {
    const port = await serveHttp((_req, res) => res.writeHead(200).end('the application, unencrypted'));
    const report = await probeHttpRedirect(probe(port));
    expect(codes(report)).toEqual(['http_serves_plaintext']);
    expect(report.status).toBe('critical');
  });

  it('warns when port 80 is closed', async () => {
    const report = await probeHttpRedirect(probe(await closedPort()));
    expect(codes(report)).toEqual(['http_port_closed']);
    expect(report.status).toBe('warning');
  });

  it('accepts a 404 for an unknown ACME token, and is critical when the challenge path is redirected', async () => {
    expect((await probeAcmeChallengeRoute(probe(await serveHttp(redirectToOrigin)))).findings).toEqual([]);
    const redirectsAll = await serveHttp((req, res) => res.writeHead(301, { location: `https://${HOST}${req.url}` }).end());
    expect(codes(await probeAcmeChallengeRoute(probe(redirectsAll)))).toEqual(['acme_route_redirected']);
  });
});

describe('runTlsCheck — the command line an operator schedules', () => {
  let dir: string;
  let caFile: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'jtt-tls-check-'));
    caFile = path.join(dir, 'root.pem');
    writeFileSync(caFile, f.root.cert);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function certDir(name: string, identity: TestIdentity | null, certificatePem?: string): string {
    const target = path.join(dir, name);
    mkdirSync(target);
    writeFileSync(path.join(target, 'fullchain.pem'), certificatePem ?? chain(identity!));
    if (identity) writeFileSync(path.join(target, 'privkey.pem'), identity.key, { mode: 0o600 });
    return target;
  }

  async function edge(identity: TestIdentity): Promise<string[]> {
    const https = await serveTls(chain(identity), identity.key);
    const http = await serveHttp(redirectToOrigin);
    return ['--origin', `https://${HOST}`, '--connect', '127.0.0.1', '--https-port', String(https), '--http-port', String(http), '--ca-file', caFile];
  }

  it('exits 0 for a healthy edge serving the installed certificate, and prints no key material', async () => {
    const args = [...(await edge(f.good)), '--cert-dir', certDir('good', f.good), '--expect-acme'];
    const result = await runTlsCheck(args, {});
    expect(result.output).toContain(`TLS check for ${HOST}: OK`);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/files\s+OK/);
    expect(result.output).toMatch(/served\s+OK/);
    expect(result.output).toMatch(/http\s+OK/);
    expect(result.output).toMatch(/acme\s+OK/);
    expectNoKeyMaterial(result.output, f.good.key);
  });

  it('exits 2 when the installed certificate was renewed but the edge still serves the old one', async () => {
    const args = [...(await edge(f.other)), '--cert-dir', certDir('renewed', f.good)];
    const result = await runTlsCheck(args, {});
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('served_differs_from_installed');
  });

  it('exits 1 inside the renewal window', async () => {
    const result = await runTlsCheck([...(await edge(f.good)), '--warn-days', '120', '--critical-days', '7'], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('renewal_due');
  });

  it('reads PUBLIC_ORIGIN when no --origin is given, and writes JSON on request', async () => {
    const args = (await edge(f.good)).filter((_, index, all) => all[index - 1] !== '--origin' && all[index] !== '--origin');
    const result = await runTlsCheck([...args, '--json'], { PUBLIC_ORIGIN: `https://${HOST}` });
    const parsed = JSON.parse(result.output) as { hostname: string; status: string; sections: Record<string, TlsHealthReport> };
    expect(parsed).toMatchObject({ hostname: HOST, status: 'ok' });
    expect(Object.keys(parsed.sections).sort()).toEqual(['http', 'served']);
  });

  it('checks files alone with --offline, and warns when it may not read the key', async () => {
    const offline = await runTlsCheck(['--origin', `https://${HOST}`, '--offline', '--cert-dir', certDir('offline', f.good)], {});
    expect(offline.exitCode).toBe(0);
    const certOnly = await runTlsCheck(['--origin', `https://${HOST}`, '--offline', '--cert-dir', certDir('cert-only', null, chain(f.good))], {});
    expect(certOnly.exitCode).toBe(1);
    expect(certOnly.output).toContain('key_not_checked');
  });

  it.each([
    ['no origin at all', []],
    ['an http origin', ['--origin', `http://${HOST}`]],
    ['an unknown flag', ['--origin', `https://${HOST}`, '--insecure']],
    ['--offline without --cert-dir', ['--origin', `https://${HOST}`, '--offline']],
    ['a critical threshold above the warning one', ['--origin', `https://${HOST}`, '--warn-days', '5', '--critical-days', '9']],
    ['a threshold that is not a number', ['--origin', `https://${HOST}`, '--warn-days', 'soon']],
  ])('exits 2 with usage for %s', async (_name, args) => {
    const result = await runTlsCheck(args, {});
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('usage: npm run tls:check');
  });
});
