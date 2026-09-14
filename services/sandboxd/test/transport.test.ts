/**
 * BETA-P0-011 — sandboxd serves its capability endpoints over TLS, or refuses
 * to start in production where that would matter.
 *
 * `lab-orchestrator/test/broker-transport.test.ts` covers the rules; this pins
 * them to `loadSandboxdConfig` and to the real listener: every endpoint on the
 * port — `/health`, `/v1/runtime`, the attach upgrade — speaks TLS when a
 * certificate is configured, and a caller that does not trust it never gets as
 * far as presenting a capability.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { BrokerRuntime, ContainerRuntimeError, brokerFetch, brokerTlsOptions } from '@jumptotech/lab-orchestrator';
import { createTestCa } from '@jumptotech/test-support/tls-pki';
import { defaultObservabilityConfig, loadSandboxdConfig, type SandboxdConfig } from '../src/config.js';
import { createSandboxd } from '../src/server.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const hex = (label: string): string => createHash('sha256').update(label).digest('hex');

const ca = createTestCa();
const unrelatedCa = createTestCa('unrelated CA');
const identity = ca.issue({ dns: ['localhost'], ips: ['127.0.0.1'] });

const work = mkdtempSync(path.join(tmpdir(), 'jtt-sandboxd-transport-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const certFile = path.join(work, 'broker.pem');
const keyFile = path.join(work, 'broker-key.pem');
writeFileSync(certFile, identity.cert, { mode: 0o600 });
writeFileSync(keyFile, identity.key, { mode: 0o600 });

const PRODUCTION = {
  NODE_ENV: 'production',
  SANDBOXD_ATTACH_SECRET: hex('attach').slice(0, 48),
  SANDBOXD_RUNTIME_SECRET: hex('runtime').slice(0, 48),
  SANDBOXD_DOCKER_SECRET: hex('docker').slice(0, 48),
  NAMESPACE_DERIVATION_SECRET: hex('namespace'),
  OBSERVABILITY_SCRAPE_TOKEN: hex('scrape'),
  DOCKER_TRACK_ENABLED: 'true',
  RUNTIME_OWNER_ID: 'labs-prod',
} as NodeJS.ProcessEnv;

function refusal(env: NodeJS.ProcessEnv): string {
  try {
    loadSandboxdConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected loadSandboxdConfig to refuse');
}

describe('sandboxd transport under NODE_ENV=production', () => {
  it('serves plaintext on a loopback bind with nothing further', () => {
    const config = loadSandboxdConfig(PRODUCTION);
    expect(config.transportMode).toBe('loopback-plaintext');
    expect(config.tls).toBeNull();
  });

  it('refuses plaintext on every interface, which is what the image binds, unless declared', () => {
    expect(refusal({ ...PRODUCTION, SANDBOXD_BIND: '0.0.0.0' })).toMatch(/plaintext on SANDBOXD_BIND=0.0.0.0/);
    const compose = loadSandboxdConfig({
      ...PRODUCTION,
      SANDBOXD_BIND: '0.0.0.0',
      SANDBOX_BROKER_SAME_HOST_PLAINTEXT: 'true',
    });
    expect(compose.transportMode).toBe('same-host-plaintext');
  });

  it('serves TLS on any bind once it holds a certificate and key', () => {
    const config = loadSandboxdConfig({
      ...PRODUCTION,
      SANDBOXD_BIND: '0.0.0.0',
      SANDBOXD_TLS_CERT_FILE: certFile,
      SANDBOXD_TLS_KEY_FILE: keyFile,
    });
    expect(config.transportMode).toBe('tls');
    expect(config.tls).toEqual({ cert: identity.cert, key: identity.key });
  });

  it('keeps the owner and secret refusals ahead of the transport one', () => {
    const unsafe = { ...PRODUCTION, SANDBOXD_BIND: '0.0.0.0' };
    expect(refusal({ ...unsafe, RUNTIME_OWNER_ID: undefined })).toMatch(/RUNTIME_OWNER_ID must be set/);
    expect(refusal({ ...unsafe, SANDBOXD_RUNTIME_SECRET: '' })).toMatch(/SANDBOXD_RUNTIME_SECRET is not set/);
  });

  it('leaves runtime ownership exactly as it was', () => {
    const config = loadSandboxdConfig({
      ...PRODUCTION,
      SANDBOXD_BIND: '0.0.0.0',
      SANDBOXD_TLS_CERT_FILE: certFile,
      SANDBOXD_TLS_KEY_FILE: keyFile,
    });
    expect(config.runtimeOwner).toBe('labs-prod');
    expect(config.runtimeOwnerSource).not.toBe('development-default');
  });

  it('refuses a process-wide verification bypass', () => {
    expect(refusal({ ...PRODUCTION, NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
  });

  it('refuses half a certificate in any environment', () => {
    expect(() => loadSandboxdConfig({ ...PRODUCTION, NODE_ENV: 'development', SANDBOXD_TLS_CERT_FILE: certFile })).toThrow(
      /must be set together/,
    );
  });
});

describe('the TLS listener', () => {
  const SECRET = 'internal-service-secret-for-tests';
  const config: SandboxdConfig = {
    port: 0,
    observability: defaultObservabilityConfig('sandboxd', 0),
    bindAddress: '127.0.0.1',
    tls: { cert: identity.cert, key: identity.key },
    transportMode: 'tls',
    scopeSecrets: { attach: SECRET + '-attach', runtime: SECRET + '-runtime', docker: SECRET + '-docker' },
    derivationSecret: 'derivation-secret-for-tests',
    runtimeOwner: 'jumptotech',
    containerBinary: 'docker',
    shell: '/bin/bash',
    docker: null,
    sandboxUser: 'student',
    sandboxHome: '/home/student',
    maxSessions: 4,
    idleTimeoutMs: 60_000,
    maxSessionMs: 120_000,
  };

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

  async function start(): Promise<{ origin: string; pings: () => number }> {
    let pings = 0;
    const server = createSandboxd({
      config,
      inspector: { inspect: async () => null },
      runtime: {
        name: 'fake',
        ping: async () => {
          pings += 1;
          return '27.0.0';
        },
      } as never,
      log: () => undefined,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    return { origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, pings: () => pings };
  }

  it('serves the runtime control plane to a caller that trusts its CA', async () => {
    const broker = await start();
    const client = new BrokerRuntime({ baseUrl: broker.origin, secret: config.scopeSecrets.runtime, ca: ca.cert });
    await expect(client.ping()).resolves.toBe('27.0.0');
    expect(broker.pings()).toBe(1);
  });

  it('never receives the capability from a caller that does not trust the certificate', async () => {
    const broker = await start();
    const client = new BrokerRuntime({
      baseUrl: broker.origin,
      secret: config.scopeSecrets.runtime,
      ca: unrelatedCa.cert,
    });
    const attempt = client.ping();
    await expect(attempt).rejects.toBeInstanceOf(ContainerRuntimeError);
    await attempt.catch((error: Error) => expect(error.message).not.toContain(config.scopeSecrets.runtime));
    expect(broker.pings()).toBe(0);
  });

  it('answers nothing in plaintext on the same port', async () => {
    const broker = await start();
    const outcome = await fetch(`${broker.origin.replace('https:', 'http:')}/health`).then(
      (response) => response.status,
      () => 'refused',
    );
    expect(outcome).not.toBe(200);
  });

  it('serves /health over TLS with no credential in it', async () => {
    const broker = await start();
    const response = await brokerFetch({ url: broker.origin, ca: ca.cert })(`${broker.origin}/health`);
    expect(response.status).toBe(200);
    const body = JSON.stringify(await response.json());
    for (const secret of Object.values(config.scopeSecrets)) expect(body).not.toContain(secret);
  });

  it('upgrades attach over wss for a verified caller, and not for an unverified one', async () => {
    const broker = await start();
    const url = `${broker.origin.replace('https:', 'wss:')}/v1/attach`;
    const connect = (trusted: string) =>
      new Promise<'open' | 'error'>((resolve) => {
        const ws = new WebSocket(url, {
          ...brokerTlsOptions({ ca: trusted }),
          headers: { 'x-internal-secret': config.scopeSecrets.attach },
        });
        ws.on('open', () => {
          ws.close();
          resolve('open');
        });
        ws.on('error', () => resolve('error'));
      });
    await expect(connect(ca.cert)).resolves.toBe('open');
    await expect(connect(unrelatedCa.cert)).resolves.toBe('error');
  });
});

describe('the sandboxd image', () => {
  it('health-checks a TLS listener without skipping certificate verification', () => {
    const dockerfile = readFileSync(path.join(REPO_ROOT, 'infrastructure/docker/sandboxd.Dockerfile'), 'utf8');
    const healthcheck = dockerfile.slice(dockerfile.indexOf('HEALTHCHECK'));
    expect(healthcheck).toContain('SANDBOXD_TLS_CERT_FILE');
    expect(healthcheck).not.toMatch(/rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|x-internal-secret/);
  });
});
