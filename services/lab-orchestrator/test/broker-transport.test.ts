/**
 * BETA-P0-011 — the transport capability secrets travel over to `sandboxd`.
 *
 * Three claims, each against real code and, where it matters, a real TLS
 * handshake with certificates minted for the test:
 *
 *   1. Configuration fails closed. Under NODE_ENV=production a caller refuses
 *      plaintext to anything but a loopback literal or a declared single-host
 *      bridge, and the broker refuses to serve that way. No URL may carry a
 *      credential, and no refusal repeats one.
 *   2. Verification cannot be switched off. There is no option for it, the
 *      clients pass `rejectUnauthorized: true` explicitly, and a process-wide
 *      `NODE_TLS_REJECT_UNAUTHORIZED=0` neither weakens them nor survives a
 *      production start.
 *   3. The clients actually use it: an untrusted CA or a certificate for the
 *      wrong host is refused before a single request byte — and so before the
 *      capability header — is sent.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createTestCa, type TestIdentity } from '@jumptotech/test-support/tls-pki';
import {
  BrokerTransportError,
  assertTlsVerificationEnabled,
  brokerFetch,
  brokerTlsOptions,
  resolveBrokerClientTransport,
  resolveBrokerServerTransport,
} from '../src/broker-transport.js';
import { BrokerRuntime } from '../src/providers/container/broker-runtime.js';
import { ContainerRuntimeError } from '../src/providers/container/runtime.js';
import { BrokerDockerEngines } from '../src/docker/broker-engines.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'capability-secret-that-must-never-leak-7f3a9c2e';
const PROD = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
const DEV = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;
const DECLARED = { ...PROD, SANDBOX_BROKER_SAME_HOST_PLAINTEXT: 'true' } as NodeJS.ProcessEnv;

const ca = createTestCa();
const unrelatedCa = createTestCa('unrelated CA');
const brokerIdentity = ca.issue({ dns: ['localhost'], ips: ['127.0.0.1'] });
const wrongHostIdentity = ca.issue({ dns: ['wrong-host.test'] });

const work = mkdtempSync(path.join(tmpdir(), 'jtt-broker-transport-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function file(name: string, content: string): string {
  const target = path.join(work, name);
  writeFileSync(target, content, { mode: 0o600 });
  return target;
}

const caFile = file('ca.pem', ca.cert);

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BrokerTransportError);
    return (error as Error).message;
  }
  throw new Error('expected the transport to be refused');
}

const client = (env: NodeJS.ProcessEnv, url: string) =>
  resolveBrokerClientTransport(env, { service: 'api', url });

describe('a production caller', () => {
  it('refuses plaintext to a remote host, by name or by address', () => {
    for (const url of [
      'http://sandboxd.runtime.example:4002',
      'http://runtime-host.internal:4002',
      'http://10.20.0.5:4002',
      'http://[2001:db8::5]:4002',
    ]) {
      expect(refusal(() => client(PROD, url)), url).toMatch(/refuses to send sandboxd capability secrets over plaintext/);
    }
  });

  it('refuses a Compose service name unless the single-host arrangement is declared', () => {
    expect(refusal(() => client(PROD, 'http://sandboxd:4002'))).toMatch(/SANDBOX_BROKER_SAME_HOST_PLAINTEXT=true/);
  });

  it('accepts https, verified against the system trust store by default', () => {
    expect(client(PROD, 'https://sandboxd.runtime.example:4002')).toEqual({
      url: 'https://sandboxd.runtime.example:4002',
      protocol: 'https:',
      mode: 'tls',
    });
  });

  it('accepts https with a private CA bundle, carried for this connection only', () => {
    const transport = client({ ...PROD, SANDBOX_BROKER_CA_FILE: caFile }, 'https://sandboxd.runtime.example:4002');
    expect(transport.mode).toBe('tls');
    expect(transport.ca).toContain('-----BEGIN CERTIFICATE-----');
  });

  it('accepts plaintext to loopback literals, and not to a name that merely resolves there', () => {
    expect(client(PROD, 'http://127.0.0.1:4002').mode).toBe('loopback-plaintext');
    expect(client(PROD, 'http://127.8.9.10:4002').mode).toBe('loopback-plaintext');
    expect(client(PROD, 'http://[::1]:4002').mode).toBe('loopback-plaintext');
    expect(refusal(() => client(PROD, 'http://localhost:4002'))).toMatch(/plaintext/);
  });

  it('lets the same-host declaration cover one DNS label and nothing wider', () => {
    expect(client(DECLARED, 'http://sandboxd:4002').mode).toBe('same-host-plaintext');
    for (const url of ['http://sandboxd.internal:4002', 'http://10.0.0.5:4002', 'http://[fd00::5]:4002']) {
      expect(refusal(() => client(DECLARED, url)), url).toMatch(/covers a Compose service name/);
    }
  });

  it('refuses the declaration beside https, and any value but true', () => {
    expect(refusal(() => client(DECLARED, 'https://sandboxd.runtime.example:4002'))).toMatch(/only for plaintext/);
    expect(
      refusal(() => client({ ...PROD, SANDBOX_BROKER_SAME_HOST_PLAINTEXT: 'yes' }, 'http://sandboxd:4002')),
    ).toMatch(/must be 'true' or unset/);
  });
});

describe('in every environment', () => {
  it('keeps credentials out of the URL, and never repeats one', () => {
    for (const env of [PROD, DEV]) {
      for (const url of [
        `https://api:${SECRET}@sandboxd.runtime.example:4002`,
        `http://${SECRET}@127.0.0.1:4002`,
        `https://sandboxd.runtime.example:4002/?secret=${SECRET}`,
        `https://sandboxd.runtime.example:4002/#${SECRET}`,
        `https://sandboxd.runtime.example:4002/${SECRET}`,
      ]) {
        const message = refusal(() => client(env, url));
        expect(message, url).not.toContain(SECRET);
      }
    }
  });

  it('refuses a scheme that is neither http nor https', () => {
    for (const url of ['ws://sandboxd:4002', 'tcp://sandboxd:4002', 'unix:///run/sandboxd.sock', 'sandboxd:4002']) {
      expect(() => client(DEV, url), url).toThrow(BrokerTransportError);
    }
  });

  it('refuses a CA file beside http://, rather than silently not using it', () => {
    for (const env of [PROD, DEV]) {
      expect(refusal(() => client({ ...env, SANDBOX_BROKER_CA_FILE: caFile }, 'http://127.0.0.1:4002'))).toMatch(
        /A CA file means TLS was intended/,
      );
    }
  });

  it('refuses a CA bundle that is missing, empty, malformed, or holds a private key', () => {
    const https = 'https://sandboxd.runtime.example:4002';
    const withCa = (name: string) => ({ ...DEV, SANDBOX_BROKER_CA_FILE: name });
    expect(refusal(() => client(withCa(path.join(work, 'absent.pem')), https))).toMatch(/could not be read/);
    expect(refusal(() => client(withCa(file('empty.pem', 'not a certificate\n')), https))).toMatch(/no PEM certificate/);
    expect(
      refusal(() =>
        client(withCa(file('bad.pem', '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n')), https),
      ),
    ).toMatch(/does not parse/);
    const leaked = refusal(() => client(withCa(file('with-key.pem', ca.cert + brokerIdentity.key)), https));
    expect(leaked).toMatch(/contains a private key/);
    expect(leaked).not.toContain(brokerIdentity.key.split('\n')[1]!);
  });

  it('allows plaintext to any host outside production', () => {
    expect(client(DEV, 'http://sandboxd:4002').mode).toBe('development-plaintext');
    expect(client({}, 'http://runtime.example:4002').mode).toBe('development-plaintext');
  });
});

describe('certificate verification cannot be switched off', () => {
  it('refuses NODE_TLS_REJECT_UNAUTHORIZED in production, and only there', () => {
    for (const value of ['0', 'false']) {
      expect(refusal(() => assertTlsVerificationEnabled({ ...PROD, NODE_TLS_REJECT_UNAUTHORIZED: value }, 'api'))).toMatch(
        /refuses to start with it under NODE_ENV=production/,
      );
    }
    expect(() => assertTlsVerificationEnabled(PROD, 'api')).not.toThrow();
    expect(() => assertTlsVerificationEnabled({ ...PROD, NODE_TLS_REJECT_UNAUTHORIZED: '1' }, 'api')).not.toThrow();
    expect(() => assertTlsVerificationEnabled({ ...DEV, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, 'api')).not.toThrow();
  });

  it('builds every TLS connection with verification on and a TLS 1.2 floor', () => {
    expect(brokerTlsOptions({})).toEqual({ rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    expect(brokerTlsOptions({ ca: ca.cert })).toEqual({ rejectUnauthorized: true, minVersion: 'TLSv1.2', ca: ca.cert });
  });

  it('has no bypass anywhere on the app-to-runtime path', () => {
    const sources = [
      'services/lab-orchestrator/src/broker-transport.ts',
      'services/lab-orchestrator/src/providers/container/broker-runtime.ts',
      'services/lab-orchestrator/src/docker/broker-engines.ts',
      'apps/api/src/config.ts',
      'apps/api/src/providers.ts',
      ...['services/terminal/src', 'services/sandboxd/src'].flatMap((dir) =>
        readdirSync(path.join(REPO_ROOT, dir))
          .filter((name) => name.endsWith('.ts'))
          .map((name) => `${dir}/${name}`),
      ),
    ];
    const bypasses = [
      /rejectUnauthorized\s*:\s*false/,
      /process\.env\.NODE_TLS_REJECT_UNAUTHORIZED\s*=[^=]/,
      /checkServerIdentity/,
      /insecure-skip-tls-verify|skipTLSVerify/,
    ];
    const found = sources.flatMap((source) => {
      const text = readFileSync(path.join(REPO_ROOT, source), 'utf8');
      return bypasses.filter((pattern) => pattern.test(text)).map((pattern) => `${source}: ${pattern}`);
    });
    expect(found).toEqual([]);
  });
});

describe('the broker clients over a real TLS connection', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  interface Seen {
    url?: string;
    method?: string;
    secret?: string;
    body: string;
  }

  async function tlsBroker(
    identity: TestIdentity,
    reply: unknown = { ok: true, data: {} },
    respond = true,
  ): Promise<{ origin: string; seen: Seen[] }> {
    const seen: Seen[] = [];
    const server = createServer(identity, (req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        seen.push({
          url: req.url,
          method: req.method,
          secret: req.headers['x-internal-secret'] as string | undefined,
          body,
        });
        if (!respond) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    return { origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
  }

  it('delivers the capability in a header, over a connection verified against the CA', async () => {
    const broker = await tlsBroker(brokerIdentity, { ok: true });
    const response = await brokerFetch({ url: broker.origin, ca: ca.cert })(`${broker.origin}/v1/runtime`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': SECRET },
      body: JSON.stringify({ op: 'ping' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(broker.seen).toEqual([{ url: '/v1/runtime', method: 'POST', secret: SECRET, body: '{"op":"ping"}' }]);
  });

  it('refuses a certificate from an unrelated CA before sending anything', async () => {
    const broker = await tlsBroker(brokerIdentity);
    const attempt = brokerFetch({ url: broker.origin, ca: unrelatedCa.cert })(`${broker.origin}/v1/runtime`, {
      method: 'POST',
      headers: { 'x-internal-secret': SECRET },
      body: '{}',
    });
    await expect(attempt).rejects.toThrow();
    await attempt.catch((error: Error) => expect(error.message).not.toContain(SECRET));
    expect(broker.seen).toEqual([]);
  });

  it('refuses a certificate for a different host, even from the trusted CA', async () => {
    const broker = await tlsBroker(wrongHostIdentity);
    await expect(
      brokerFetch({ url: broker.origin, ca: ca.cert })(`${broker.origin}/v1/runtime`, {
        method: 'POST',
        headers: { 'x-internal-secret': SECRET },
        body: '{}',
      }),
    ).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    expect(broker.seen).toEqual([]);
  });

  it('refuses a private certificate when no CA is configured', async () => {
    const broker = await tlsBroker(brokerIdentity);
    await expect(brokerFetch({ url: broker.origin })(`${broker.origin}/health`)).rejects.toThrow();
    expect(broker.seen).toEqual([]);
  });

  it('ignores NODE_TLS_REJECT_UNAUTHORIZED=0 in its own process', async () => {
    const broker = await tlsBroker(brokerIdentity);
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      await expect(
        brokerFetch({ url: broker.origin, ca: unrelatedCa.cert })(`${broker.origin}/v1/runtime`, {
          method: 'POST',
          headers: { 'x-internal-secret': SECRET },
          body: '{}',
        }),
      ).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
    expect(broker.seen).toEqual([]);
  });

  it('honours an abort signal', async () => {
    const broker = await tlsBroker(brokerIdentity, undefined, false);
    const controller = new AbortController();
    const attempt = brokerFetch({ url: broker.origin, ca: ca.cert })(`${broker.origin}/v1/runtime`, {
      method: 'POST',
      body: '{}',
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(attempt).rejects.toThrow();
  });

  it('leaves plaintext targets on the global fetch', () => {
    expect(brokerFetch({ url: 'http://127.0.0.1:4002' })).toBe(fetch);
  });

  it('BrokerRuntime reaches an https broker, and reports an untrusted one as unreachable without the secret', async () => {
    const broker = await tlsBroker(brokerIdentity, { ok: true, data: { version: '27.0.0' } });
    await expect(new BrokerRuntime({ baseUrl: broker.origin, secret: SECRET, ca: ca.cert }).ping()).resolves.toBe(
      '27.0.0',
    );
    expect(broker.seen).toHaveLength(1);
    expect(broker.seen[0]).toMatchObject({ url: '/v1/runtime', secret: SECRET });

    const refused = new BrokerRuntime({ baseUrl: broker.origin, secret: SECRET, ca: unrelatedCa.cert }).ping();
    await expect(refused).rejects.toBeInstanceOf(ContainerRuntimeError);
    await refused.catch((error: Error) => {
      expect(error.message).toMatch(/unreachable/);
      expect(error.message).not.toContain(SECRET);
    });
    expect(broker.seen).toHaveLength(1);
  });

  it('BrokerDockerEngines uses the same verified transport', async () => {
    const version = { version: '27.3.1', apiVersion: '1.47', os: 'linux', arch: 'amd64' };
    const broker = await tlsBroker(brokerIdentity, { ok: true, data: { version } });
    const engines = new BrokerDockerEngines({ baseUrl: broker.origin, secret: SECRET, ca: ca.cert });
    await expect(engines.host.version()).resolves.toEqual(version);
    expect(broker.seen[0]).toMatchObject({ url: '/v1/docker', secret: SECRET });

    const untrusted = new BrokerDockerEngines({ baseUrl: broker.origin, secret: SECRET, ca: unrelatedCa.cert });
    await expect(untrusted.host.version()).rejects.toThrow(/unreachable/);
    expect(broker.seen).toHaveLength(1);
  });
});

describe('the broker listener', () => {
  const certFile = file('broker.pem', brokerIdentity.cert);
  const keyFile = file('broker-key.pem', brokerIdentity.key);
  const server = (env: NodeJS.ProcessEnv, bindAddress: string) => resolveBrokerServerTransport(env, { bindAddress });

  it('refuses plaintext on a non-loopback bind in production', () => {
    for (const bindAddress of ['0.0.0.0', '::', '10.0.0.4']) {
      expect(refusal(() => server(PROD, bindAddress)), bindAddress).toMatch(
        /refuses to serve capability endpoints in plaintext/,
      );
    }
  });

  it('accepts a loopback bind, the single-host declaration, or a certificate', () => {
    expect(server(PROD, '127.0.0.1')).toEqual({ mode: 'loopback-plaintext', tls: null });
    expect(server(PROD, '::1')).toEqual({ mode: 'loopback-plaintext', tls: null });
    expect(server(DECLARED, '0.0.0.0')).toEqual({ mode: 'same-host-plaintext', tls: null });
    expect(
      server({ ...PROD, SANDBOXD_TLS_CERT_FILE: certFile, SANDBOXD_TLS_KEY_FILE: keyFile }, '0.0.0.0'),
    ).toEqual({ mode: 'tls', tls: { cert: brokerIdentity.cert, key: brokerIdentity.key } });
  });

  it('refuses half a certificate, or a key that does not match, without repeating key material', () => {
    expect(refusal(() => server({ ...DEV, SANDBOXD_TLS_CERT_FILE: certFile }, '0.0.0.0'))).toMatch(
      /must be set together/,
    );
    const mismatched = refusal(() =>
      server(
        { ...DEV, SANDBOXD_TLS_CERT_FILE: certFile, SANDBOXD_TLS_KEY_FILE: file('other-key.pem', wrongHostIdentity.key) },
        '0.0.0.0',
      ),
    );
    expect(mismatched).toMatch(/could not be loaded as a certificate and its matching private key/);
    expect(mismatched).not.toContain(wrongHostIdentity.key.split('\n')[1]!);
  });

  it('refuses the plaintext declaration beside a certificate in production', () => {
    expect(
      refusal(() =>
        server({ ...DECLARED, SANDBOXD_TLS_CERT_FILE: certFile, SANDBOXD_TLS_KEY_FILE: keyFile }, '0.0.0.0'),
      ),
    ).toMatch(/configured for TLS/);
  });

  it('serves plaintext anywhere outside production', () => {
    expect(server(DEV, '0.0.0.0').mode).toBe('development-plaintext');
  });
});
