/**
 * What a student types and what their shell prints never reaches a log.
 *
 * `src/server.ts` calls the output stream "the single most sensitive stream in
 * the platform" and said a test asserted no logger call receives it — but no
 * such test existed. This is that test, across every process the stream passes
 * through: the API, `sandboxd` and the terminal each log to a capturing sink at
 * debug level while a student authenticates, types, gets output back, and sends
 * frames the protocol refuses. The session token is held to the same rule.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  LAB_LABEL,
  LabRegistry,
  LinuxLabProvider,
  MANAGED_LABEL,
  ProviderRegistry,
  RUNTIME_OWNER_LABEL,
  SESSION_LABEL,
  SessionManager,
  issueSessionToken,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createApp } from '@jumptotech/api';
import { loadConfig } from '@jumptotech/api/config';
import {
  createAuthMetrics,
  createCommonMetrics,
  createLogger,
  createRegistry,
  createSessionMetrics,
  createTerminalMetrics,
  createVerificationMetrics,
} from '@jumptotech/observability';
import { createSandboxd, type BrokerPty } from '@jumptotech/sandboxd/server';
import { defaultObservabilityConfig, type SandboxdConfig } from '@jumptotech/sandboxd/config';
import type { SandboxSnapshot } from '@jumptotech/sandboxd/attach';
import { loadTerminalConfig } from '../src/config.js';
import { createTerminalServer } from '../src/server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const TERMINAL_SECRET = 'content-logging-session-secret';
const INTERNAL_SECRET = 'content-logging-internal-secret';
const DERIVATION = 'content-logging-derivation-secret';
const OWNER = 'usr-0000000a';

/** What the student types, and what the shell answers. Unmistakable in a log. */
const TYPED = 'echo TYPED-SENTINEL-7f3a91 && passwd student';
const PRINTED = 'PRINTED-SENTINEL-c02e55 root:$6$saltsalt$hash:19000:0:99999:7:::';
const REFUSED_TYPE = 'REFUSED-SENTINEL-9d11b0';

let registry: LabRegistry;
beforeAll(async () => {
  registry = await realCatalog();
});

const closables: Server[] = [];
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const server of closables.splice(0)) server.close();
});

async function listen(server: Server): Promise<number> {
  closables.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** A PTY that echoes what it is given and prints one line of its own. */
function echoPty(): BrokerPty & { written: string[] } {
  let onData: (data: string) => void = () => undefined;
  return {
    written: [],
    write(data) {
      this.written.push(data);
      onData(data);
      onData(`\r\n${PRINTED}\r\n`);
    },
    resize() {},
    kill() {},
    onData(listener) {
      onData = listener;
    },
    onExit() {},
  };
}

async function eventually<T>(check: () => T, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('terminal content is never logged', () => {
  it('keeps typed input, shell output and the session token out of every log line', async () => {
    const lines: string[] = [];
    const sink = (line: string) => lines.push(line);

    const metrics = createRegistry({ service: 'api', defaultMetrics: false });
    const terminalMetrics = createRegistry({ service: 'terminal', defaultMetrics: false });
    const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
    providers.register({ provider: new LinuxLabProvider({ runtime: new FakeContainerRuntime() }) });
    const config = loadConfig({
      TERMINAL_SESSION_SECRET: TERMINAL_SECRET,
      INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
      LABS_DIR: path.join(repoRoot, 'labs'),
      ALLOWED_ORIGINS: 'http://localhost:3000',
      AUTH_MODE: 'development',
    } as NodeJS.ProcessEnv);
    const manager = new SessionManager({
      registry,
      providers,
      store: new InMemorySessionStore(),
      policy: DEFAULT_SESSION_POLICY,
      lifetimes: config.lifetimes,
      namespaceSecret: DERIVATION,
    });
    const apiPort = await listen(
      createServer(
        createApp({
          registry,
          sessions: manager,
          k8s: new FakeKubernetes(),
          config,
          observability: {
            logger: createLogger({ service: 'api', level: 'debug', sink }),
            metrics: {
              common: createCommonMetrics(metrics, 'api'),
              sessions: createSessionMetrics(metrics),
              verification: createVerificationMetrics(metrics),
              auth: createAuthMetrics(metrics),
            },
          },
        }),
      ),
    );

    const { session } = await manager.start('LINUX-001', OWNER);
    const containers = new Map<string, SandboxSnapshot>([
      [
        session.sandboxRef!,
        {
          state: 'running',
          user: 'student',
          workdir: '/home/student',
          labels: {
            [MANAGED_LABEL]: 'true',
            [RUNTIME_OWNER_LABEL]: 'jumptotech',
            [SESSION_LABEL]: session.sessionId,
            [LAB_LABEL]: session.labId,
          },
        },
      ],
    ]);

    const ptys: ReturnType<typeof echoPty>[] = [];
    const brokerConfig: SandboxdConfig = {
      observability: defaultObservabilityConfig('sandboxd', 0),
      port: 0,
      bindAddress: '127.0.0.1',
      scopeSecrets: {
        attach: `${INTERNAL_SECRET}-attach`,
        runtime: `${INTERNAL_SECRET}-runtime`,
        docker: `${INTERNAL_SECRET}-docker`,
      },
      derivationSecret: DERIVATION,
      runtimeOwner: 'jumptotech',
      containerBinary: 'docker',
      shell: '/bin/bash',
      docker: null,
      sandboxUser: 'student',
      sandboxHome: '/home/student',
      maxSessions: 8,
      idleTimeoutMs: 60_000,
      maxSessionMs: 120_000,
    };
    const brokerPort = await listen(
      createSandboxd({
        config: brokerConfig,
        inspector: { inspect: async (ref) => containers.get(ref) ?? null },
        spawn: () => {
          const pty = echoPty();
          ptys.push(pty);
          return pty;
        },
        logger: createLogger({ service: 'sandboxd', level: 'debug', sink }),
      }),
    );

    const terminalConfig = loadTerminalConfig({
      TERMINAL_SESSION_SECRET: TERMINAL_SECRET,
      INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
      API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
      SANDBOX_BROKER_URL: `http://127.0.0.1:${brokerPort}`,
      SANDBOXD_ATTACH_SECRET: `${INTERNAL_SECRET}-attach`,
      TERMINAL_SANDBOX_BROKER_ENABLED: 'true',
      TERMINAL_CONTAINER_EXEC_ENABLED: 'false',
      ALLOWED_ORIGINS: 'http://localhost:3000',
    } as NodeJS.ProcessEnv);
    const terminalPort = await listen(
      createTerminalServer(terminalConfig, {
        logger: createLogger({ service: 'terminal', level: 'debug', sink }),
        terminal: createTerminalMetrics(terminalMetrics),
        common: createCommonMetrics(terminalMetrics, 'terminal'),
      }),
    );

    const { token } = issueSessionToken({
      sessionId: session.sessionId,
      ownerUserId: OWNER,
      labId: session.labId,
      namespace: session.sandboxRef!,
      secret: TERMINAL_SECRET,
      ttlSeconds: 60,
    });

    const url = `ws://127.0.0.1:${terminalPort}/terminal`;
    const ws = new WebSocket(url);
    sockets.push(ws);
    const frames: Array<Record<string, unknown>> = [];
    ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as Record<string, unknown>));
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'auth', token, cols: 80, rows: 24 }));
    await eventually(() => frames.find((frame) => frame.type === 'ready'));

    ws.send(JSON.stringify({ type: 'input', data: `${TYPED}\r` }));
    ws.send(JSON.stringify({ type: REFUSED_TYPE, data: TYPED }));
    ws.send('not json at all ' + TYPED);
    await eventually(() =>
      frames.some((frame) => frame.type === 'output' && String(frame.data).includes('PRINTED-SENTINEL')),
    );

    // A second socket with a forged token, which is refused and logged as such.
    const forged = new WebSocket(url);
    sockets.push(forged);
    await new Promise((resolve) => forged.once('open', resolve));
    forged.send(JSON.stringify({ type: 'auth', token: `${token.slice(0, -4)}AAAA` }));
    await new Promise((resolve) => forged.once('close', resolve));

    // The stream really went through all three processes, and they really logged.
    expect(ptys[0]!.written.join('')).toContain('TYPED-SENTINEL');
    expect(lines.some((line) => line.includes('"service":"terminal"'))).toBe(true);
    expect(lines.some((line) => line.includes('"service":"sandboxd"'))).toBe(true);
    expect(lines.some((line) => line.includes('"service":"api"'))).toBe(true);

    const log = lines.join('\n');
    expect(log).not.toContain('TYPED-SENTINEL');
    expect(log).not.toContain('PRINTED-SENTINEL');
    expect(log).not.toContain('$6$saltsalt');
    expect(log).not.toContain('passwd student');
    expect(log).not.toContain(REFUSED_TYPE);
    expect(log).not.toContain(token);
    expect(log).not.toContain(token.split('.')[1]!);
  }, 30_000);
});
