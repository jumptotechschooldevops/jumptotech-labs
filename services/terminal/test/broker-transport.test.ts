/**
 * BETA-P0-011 — the terminal's attach secret travels only over a transport
 * production accepts, and a `wss://` broker is verified.
 *
 * The terminal is the process a student types into and it holds exactly one
 * broker capability, `attach`. This proves that capability cannot be pointed at
 * a plaintext remote broker in production, and that a real `brokerShell` over
 * TLS attaches when the broker's certificate is trusted and fails before
 * presenting the secret when it is not.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  CONTAINER_SANDBOX_PREFIX,
  LAB_LABEL,
  MANAGED_LABEL,
  RUNTIME_OWNER_LABEL,
  SESSION_LABEL,
  deriveSandboxRef,
} from '@jumptotech/lab-orchestrator';
import { createSandboxd, type BrokerPty } from '@jumptotech/sandboxd/server';
import { defaultObservabilityConfig, type SandboxdConfig } from '@jumptotech/sandboxd/config';
import { createTestCa } from '@jumptotech/test-support/tls-pki';
import { loadTerminalConfig } from '../src/config.js';
import { brokerShell } from '../src/shell.js';

const hex = (label: string): string => createHash('sha256').update(label).digest('hex');

const ca = createTestCa();
const unrelatedCa = createTestCa('unrelated CA');
const identity = ca.issue({ dns: ['localhost'], ips: ['127.0.0.1'] });

const work = mkdtempSync(path.join(tmpdir(), 'jtt-terminal-transport-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const caFile = path.join(work, 'ca.pem');
writeFileSync(caFile, ca.cert, { mode: 0o600 });

const PRODUCTION = {
  NODE_ENV: 'production',
  TERMINAL_SESSION_SECRET: hex('terminal-session'),
  INTERNAL_SERVICE_SECRET: hex('internal-service'),
  SANDBOXD_ATTACH_SECRET: hex('attach').slice(0, 48),
  TERMINAL_SANDBOX_BROKER_ENABLED: 'true',
  OBSERVABILITY_SCRAPE_TOKEN: hex('scrape'),
  TERMINAL_DROP_TO_UID: '1001',
} as NodeJS.ProcessEnv;

function refusal(env: NodeJS.ProcessEnv): string {
  try {
    loadTerminalConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected loadTerminalConfig to refuse');
}

describe('terminal broker transport under NODE_ENV=production', () => {
  it('refuses plaintext to a remote broker', () => {
    for (const url of ['http://sandboxd.runtime.example:4002', 'http://10.1.2.3:4002', 'http://sandboxd:4002']) {
      expect(refusal({ ...PRODUCTION, SANDBOX_BROKER_URL: url }), url).toMatch(/terminal refuses to send/);
    }
  });

  it('accepts a verified wss broker with a private CA', () => {
    const config = loadTerminalConfig({
      ...PRODUCTION,
      SANDBOX_BROKER_URL: 'https://sandboxd.runtime.example:4002',
      SANDBOX_BROKER_CA_FILE: caFile,
    });
    expect(config.sandboxBrokerTransport).toMatchObject({ mode: 'tls', protocol: 'https:' });
    expect(config.sandboxBrokerTransport?.ca).toContain('BEGIN CERTIFICATE');
  });

  it('accepts the compose arrangement only as declared', () => {
    const config = loadTerminalConfig({
      ...PRODUCTION,
      SANDBOX_BROKER_URL: 'http://sandboxd:4002',
      SANDBOX_BROKER_SAME_HOST_PLAINTEXT: 'true',
    });
    expect(config.sandboxBrokerTransport?.mode).toBe('same-host-plaintext');
  });

  it('keeps its loopback default', () => {
    expect(loadTerminalConfig(PRODUCTION).sandboxBrokerTransport?.mode).toBe('loopback-plaintext');
  });

  it('does not judge a broker URL it will never use', () => {
    const config = loadTerminalConfig({
      ...PRODUCTION,
      TERMINAL_SANDBOX_BROKER_ENABLED: 'false',
      SANDBOX_BROKER_URL: 'http://sandboxd.runtime.example:4002',
    });
    expect(config.sandboxBrokerTransport).toBeNull();
  });

  it('still reports a missing attach secret first', () => {
    expect(
      refusal({ ...PRODUCTION, SANDBOXD_ATTACH_SECRET: '', SANDBOX_BROKER_URL: 'http://sandboxd.runtime.example:4002' }),
    ).toMatch(/SANDBOXD_ATTACH_SECRET is not set/);
  });

  it('refuses a process-wide verification bypass', () => {
    expect(refusal({ ...PRODUCTION, NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
  });
});

describe('terminal broker transport in development', () => {
  const DEV = { TERMINAL_SESSION_SECRET: 'terminal-session-secret-for-tests', TERMINAL_SANDBOX_BROKER_ENABLED: 'true' };

  it('keeps plaintext localhost and service-name brokers working', () => {
    expect(
      loadTerminalConfig({ ...DEV, SANDBOX_BROKER_URL: 'http://127.0.0.1:4002' } as NodeJS.ProcessEnv).sandboxBrokerTransport
        ?.mode,
    ).toBe('loopback-plaintext');
    expect(
      loadTerminalConfig({ ...DEV, SANDBOX_BROKER_URL: 'http://sandboxd:4002' } as NodeJS.ProcessEnv).sandboxBrokerTransport
        ?.mode,
    ).toBe('development-plaintext');
  });

  it('still refuses a credential in the URL', () => {
    expect(() =>
      loadTerminalConfig({ ...DEV, SANDBOX_BROKER_URL: 'http://attach:secret@127.0.0.1:4002' } as NodeJS.ProcessEnv),
    ).toThrow(/carries credentials/);
  });
});

describe('brokerShell over wss', () => {
  const ATTACH = 'attach-secret-for-transport-tests';
  const DERIVATION = 'derivation-secret-for-transport-tests';
  const SESSION = 'sess-aaaaaaaaaaaaaaaa';
  const ref = deriveSandboxRef({ sessionId: SESSION, secret: DERIVATION, prefix: CONTAINER_SANDBOX_PREFIX });

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

  async function tlsBroker(): Promise<{ url: string; spawned: () => number }> {
    let spawned = 0;
    const config: SandboxdConfig = {
      port: 0,
      observability: defaultObservabilityConfig('sandboxd', 0),
      bindAddress: '127.0.0.1',
      tls: identity,
      transportMode: 'tls',
      scopeSecrets: { attach: ATTACH, runtime: `${ATTACH}-runtime`, docker: `${ATTACH}-docker` },
      derivationSecret: DERIVATION,
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
    const server = createSandboxd({
      config,
      inspector: {
        inspect: async (candidate) =>
          candidate === ref
            ? {
                state: 'running',
                user: 'student',
                workdir: '/home/student',
                labels: {
                  [MANAGED_LABEL]: 'true',
                  [RUNTIME_OWNER_LABEL]: 'jumptotech',
                  [SESSION_LABEL]: SESSION,
                  [LAB_LABEL]: 'LINUX-001',
                },
              }
            : null,
      },
      spawn: (): BrokerPty => {
        spawned += 1;
        return {
          write() {},
          resize() {},
          kill() {},
          pause() {},
          resume() {},
          pendingInputBytes: () => 0,
          onData() {},
          onExit() {},
        };
      },
      log: () => undefined,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    return { url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, spawned: () => spawned };
  }

  it('attaches when the broker certificate is trusted', async () => {
    const broker = await tlsBroker();
    const attachment = await brokerShell({
      brokerUrl: broker.url,
      ca: ca.cert,
      secret: ATTACH,
      sessionId: SESSION,
      cols: 80,
      rows: 24,
    });
    expect(attachment.sandboxRef).toBe(ref);
    expect(broker.spawned()).toBe(1);
    attachment.shell.kill();
  });

  it('fails before attaching, and without repeating the secret, when it is not', async () => {
    const broker = await tlsBroker();
    const attempt = brokerShell({
      brokerUrl: broker.url,
      ca: unrelatedCa.cert,
      secret: ATTACH,
      sessionId: SESSION,
      cols: 80,
      rows: 24,
    });
    await expect(attempt).rejects.toThrow(/Could not reach the runtime broker/);
    await attempt.catch((error: Error) => expect(error.message).not.toContain(ATTACH));
    expect(broker.spawned()).toBe(0);
  });
});
