/**
 * A real terminal server, the real API app with its real internal router and
 * session manager, and a real `sandboxd` broker — wired as in production, over
 * loopback HTTP and WebSockets.
 *
 * The only fakes are the PTY at the far end and the container inventory the
 * broker answers from (a container runtime is exactly what a unit suite must
 * not need), and a store wrapper that counts activity writes.
 *
 * `inspectGate` holds every broker attach at the inventory lookup until the
 * test releases it, so a test can put two attaches in flight at once instead of
 * hoping the scheduler interleaves them.
 */
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
  type LabSession,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createApp } from '@jumptotech/api';
import { loadConfig } from '@jumptotech/api/config';
import { createSandboxd, type BrokerPty } from '@jumptotech/sandboxd/server';
import { defaultObservabilityConfig, type SandboxdConfig } from '@jumptotech/sandboxd/config';
import type { SandboxSnapshot } from '@jumptotech/sandboxd/attach';
import { loadTerminalConfig } from '../../src/config.js';
import { createTerminalServer } from '../../src/server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export const TERMINAL_SECRET = 'terminal-activity-session-secret';
const INTERNAL_SECRET = 'terminal-activity-internal-secret';
const DERIVATION = 'terminal-activity-derivation-secret';
const RUNTIME_OWNER = 'jumptotech';

export const OWNER_A = 'usr-0000000a';
export const OWNER_B = 'usr-0000000b';

/** The durable store's contract, with every activity write counted. */
export class CountingStore extends InMemorySessionStore {
  readonly touches: string[] = [];
  failTouches = false;

  override async touchActivity(sessionId: string, at: string): Promise<LabSession | null> {
    this.touches.push(sessionId);
    if (this.failTouches) throw new Error('database unavailable');
    return super.touchActivity(sessionId, at);
  }
}

export type FakePty = BrokerPty & { written: string[]; killed: boolean; emit(d: string): void };

function fakePty(): FakePty {
  let onData: (d: string) => void = () => undefined;
  return {
    written: [],
    killed: false,
    write(data) {
      this.written.push(data);
    },
    resize() {},
    kill() {
      this.killed = true;
    },
    onData(listener) {
      onData = listener;
    },
    onExit() {},
    emit(data) {
      onData(data);
    },
  };
}

let registry: LabRegistry | undefined;

const closables: Server[] = [];
const sockets: WebSocket[] = [];

/** Call from `afterEach`: closes every socket and server this module opened. */
export function tearDownStacks(): void {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const server of closables.splice(0)) server.close();
}

async function listen(server: Server): Promise<number> {
  closables.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

export interface Stack {
  terminalUrl: string;
  terminalControlUrl: string;
  internalSecret: string;
  store: CountingStore;
  manager: SessionManager;
  ptys: FakePty[];
  a: LabSession;
  b: LabSession;
}

export async function bringUpStack(
  options: { activityReportIntervalMs?: number; inspectGate?: () => Promise<void> } = {},
): Promise<Stack> {
  registry ??= await realCatalog();
  const store = new CountingStore();
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
    store,
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: config.lifetimes,
    namespaceSecret: DERIVATION,
  });
  const apiPort = await listen(
    createServer(createApp({ registry, sessions: manager, k8s: new FakeKubernetes(), config })),
  );

  const a = (await manager.start('LINUX-001', OWNER_A)).session;
  const b = (await manager.start('LINUX-001', OWNER_B)).session;

  // The broker derives each container name itself and label-checks it; this
  // inventory answers for exactly the two sessions the manager created.
  const containers = new Map<string, SandboxSnapshot>();
  for (const session of [a, b]) {
    containers.set(session.sandboxRef!, {
      state: 'running',
      user: 'student',
      workdir: '/home/student',
      labels: {
        [MANAGED_LABEL]: 'true',
        [RUNTIME_OWNER_LABEL]: RUNTIME_OWNER,
        [SESSION_LABEL]: session.sessionId,
        [LAB_LABEL]: session.labId,
      },
    });
  }

  const ptys: FakePty[] = [];
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
    runtimeOwner: RUNTIME_OWNER,
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
      inspector: {
        inspect: async (ref) => {
          await options.inspectGate?.();
          return containers.get(ref) ?? null;
        },
      },
      spawn: () => {
        const p = fakePty();
        ptys.push(p);
        return p;
      },
      log: () => undefined,
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
    createTerminalServer({
      ...terminalConfig,
      ...(options.activityReportIntervalMs !== undefined
        ? { activityReportIntervalMs: options.activityReportIntervalMs }
        : {}),
    }),
  );

  return {
    terminalUrl: `ws://127.0.0.1:${terminalPort}/terminal`,
    terminalControlUrl: `http://127.0.0.1:${terminalPort}`,
    internalSecret: INTERNAL_SECRET,
    store,
    manager,
    ptys,
    a,
    b,
  };
}

export function tokenFor(session: LabSession, ownerUserId: string, secret = TERMINAL_SECRET): string {
  return issueSessionToken({
    sessionId: session.sessionId,
    ownerUserId,
    labId: session.labId,
    namespace: session.sandboxRef!,
    secret,
    ttlSeconds: 60,
  }).token;
}

export interface OpenSocket {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  closed: Promise<number>;
}

/** An open socket that records every frame it receives, and when it closes. */
export async function open(url: string): Promise<OpenSocket> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const frames: Array<Record<string, unknown>> = [];
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as Record<string, unknown>));
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, frames, closed };
}

export function sendAuth(socket: OpenSocket, token: string): void {
  socket.ws.send(JSON.stringify({ type: 'auth', token, cols: 80, rows: 24 }));
}

export async function authenticate(url: string, token: string) {
  const socket = await open(url);
  sendAuth(socket, token);
  const first = await eventually(() => socket.frames.find((f) => f.type === 'ready' || f.type === 'error'));
  return { ...socket, first };
}

/** Poll until `check` yields something truthy. */
export async function eventually<T>(check: () => T | Promise<T>, timeoutMs = 5_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
