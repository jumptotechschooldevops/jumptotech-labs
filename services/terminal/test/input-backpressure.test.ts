/**
 * A student's input cannot pile up in a shared relay either.
 *
 * The finding: `pty.write` never refuses. When the program in a shell is not
 * reading its terminal — `sleep`, a hung command — the kernel's tty buffer
 * fills and node-pty queues every further write in the relaying process.
 * Probed with node-pty 1.1.0 behind `sleep 30`: 60 000 input frames left
 * 469 MiB queued in the process, nothing dropped and nothing refused. Both the
 * terminal service and `sandboxd` wrote each `input` frame straight to the
 * shell, so a client that keeps sending grew them without bound, as an unread
 * `yes` did before output was flow-controlled.
 *
 * ```text
 *   client that keeps sending ──ws──► terminal ──ws──► sandboxd ──► shell not reading
 * ```
 *
 * Every hop is real, as in `output-backpressure.test.ts`. The PTY is a fake
 * that behaves like node-pty's write queue: it accepts every write and counts
 * it as pending until the test lets the shell read.
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
  type LabSession,
  type OutputFlowOptions,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createApp } from '@jumptotech/api';
import { loadConfig } from '@jumptotech/api/config';
import { createSandboxd, type BrokerPty } from '@jumptotech/sandboxd/server';
import { defaultObservabilityConfig, type SandboxdConfig } from '@jumptotech/sandboxd/config';
import type { SandboxSnapshot } from '@jumptotech/sandboxd/attach';
import { loadTerminalConfig } from '../src/config.js';
import { createTerminalServer } from '../src/server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const TERMINAL_SECRET = 'input-backpressure-session-secret';
const INTERNAL_SECRET = 'input-backpressure-internal-secret';
const DERIVATION = 'input-backpressure-derivation-secret';
const RUNTIME_OWNER = 'jumptotech';
const OWNER_A = 'usr-0000000a';
const OWNER_B = 'usr-0000000b';

/** Small limits, so the bound is visible without streaming hundreds of megabytes. */
const FLOW: OutputFlowOptions = {
  highWaterBytes: 256 * 1024,
  lowWaterBytes: 64 * 1024,
  hardLimitBytes: 8 * 1024 * 1024,
  pollIntervalMs: 20,
};


/** A PTY whose program is not reading its terminal until told to. */
interface StalledPty extends BrokerPty {
  /** Everything written so far, in order. */
  received: string[];
  /** Bytes written and not yet read by the shell. */
  pending: number;
  /** Let the shell read everything written so far. */
  drain(): void;
  killed: boolean;
}

function stalledPty(): StalledPty {
  const pty: StalledPty = {
    received: [],
    pending: 0,
    killed: false,
    write(data) {
      pty.received.push(data);
      pty.pending += Buffer.byteLength(data);
    },
    drain() {
      pty.pending = 0;
    },
    pendingInputBytes: () => pty.pending,
    resize() {},
    kill() {
      pty.killed = true;
    },
    pause() {},
    resume() {},
    onData() {},
    onExit() {},
  };
  return pty;
}

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

async function bringUpStack() {
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime: new FakeContainerRuntime() }) });
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: TERMINAL_SECRET,
    INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_MODE: 'development',
    MAX_ACTIVE_SESSIONS_PER_STUDENT: '20',
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
    createServer(createApp({ registry, sessions: manager, k8s: new FakeKubernetes(), config })),
  );

  const a = (await manager.start('LINUX-001', OWNER_A)).session;
  const b = (await manager.start('LINUX-001', OWNER_B)).session;
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

  const ptys: StalledPty[] = [];
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
    outputFlow: FLOW,
    inputFlow: FLOW,
  };
  const brokerPort = await listen(
    createSandboxd({
      config: brokerConfig,
      inspector: { inspect: async (ref) => containers.get(ref) ?? null },
      spawn: () => {
        const pty = stalledPty();
        ptys.push(pty);
        return pty;
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
  const terminalPort = await listen(createTerminalServer({ ...terminalConfig, outputFlow: FLOW, inputFlow: FLOW }));

  return { terminalUrl: `ws://127.0.0.1:${terminalPort}/terminal`, ptys, a, b };
}

function tokenFor(session: LabSession, ownerUserId: string): string {
  return issueSessionToken({
    sessionId: session.sessionId,
    ownerUserId,
    labId: session.labId,
    namespace: session.sandboxRef!,
    secret: TERMINAL_SECRET,
    ttlSeconds: 60,
  }).token;
}


async function attach(url: string, token: string) {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const frames: Array<Record<string, unknown>> = [];
  let closed = false;
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as Record<string, unknown>));
  ws.on('close', () => {
    closed = true;
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'auth', token, cols: 80, rows: 24 }));
  await eventually(() => frames.find((f) => f.type === 'ready'));
  return { ws, frames, closed: () => closed };
}

async function eventually<T>(check: () => T, timeoutMs = 20_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Resolves once `measure` has stopped changing for a few polls in a row — the
 * relays have stopped passing input on — or rejects at the deadline.
 */
async function quiescent(measure: () => number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous = measure();
  let steady = 0;
  while (steady < 5) {
    if (Date.now() > deadline) throw new Error('still changing at the deadline');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const now = measure();
    steady = now === previous ? steady + 1 : 0;
    previous = now;
  }
}

/** Resolves once the client socket has handed everything it queued to the kernel. */
async function flushed(ws: WebSocket, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (ws.bufferedAmount > 0) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

const MiB = 1024 * 1024;
/** One frame of input, at the protocol's 8 KiB limit. */
const FRAME = 'x'.repeat(8 * 1024);

/** Send `bytes` of input as fast as the client's socket takes it. */
function typeFlood(ws: WebSocket, bytes: number): void {
  const frame = JSON.stringify({ type: 'input', data: FRAME });
  for (let sent = 0; sent < bytes; sent += FRAME.length) ws.send(frame);
}

describe('shell input backpressure', () => {
  it('stops reading a client whose shell is not reading, instead of queueing its input', async () => {
    const stack = await bringUpStack();
    const client = await attach(stack.terminalUrl, tokenFor(stack.a, OWNER_A));
    const pty = stack.ptys[0]!;

    typeFlood(client.ws, 64 * MiB);
    // Wait until the flood is visibly held back: the shell has more than the
    // high-water mark pending and has stopped receiving.
    await eventually(() => pty.pending > FLOW.highWaterBytes);
    await quiescent(() => pty.pending);

    // Before this change the relays wrote every frame to the shell: all 64 MiB
    // queued in sandboxd (and, for a local shell, in the terminal service).
    expect(pty.pending).toBeLessThan(FLOW.hardLimitBytes);
    // The client is the one holding the rest — its own socket, not ours.
    expect(client.ws.bufferedAmount).toBeGreaterThan(32 * MiB);
    // Nothing was refused or closed: the student's connection is intact.
    expect(client.closed()).toBe(false);
    expect(pty.killed).toBe(false);
  }, 60_000);

  it('delivers every frame, in order, once the shell reads again', async () => {
    const stack = await bringUpStack();
    const client = await attach(stack.terminalUrl, tokenFor(stack.a, OWNER_A));
    const pty = stack.ptys[0]!;

    const total = 8 * MiB;
    typeFlood(client.ws, total);
    await eventually(() => pty.pending > FLOW.highWaterBytes);
    // The shell reads whatever it is given, a little at a time.
    const reader = setInterval(() => pty.drain(), 25);
    try {
      await eventually(() => pty.received.join('').length >= total, 40_000);
    } finally {
      clearInterval(reader);
    }
    const all = pty.received.join('');
    expect(all.length).toBe(total);
    expect(/^x+$/.test(all)).toBe(true);
    expect(await flushed(client.ws)).toBe(true);
    expect(client.closed()).toBe(false);
  }, 60_000);

  it('holds back only the student whose shell is behind', async () => {
    const stack = await bringUpStack();
    const flooding = await attach(stack.terminalUrl, tokenFor(stack.a, OWNER_A));
    const bystander = await attach(stack.terminalUrl, tokenFor(stack.b, OWNER_B));
    const [floodingPty, bystanderPty] = stack.ptys;

    typeFlood(flooding.ws, 32 * MiB);
    await eventually(() => floodingPty!.pending > FLOW.highWaterBytes);

    bystander.ws.send(JSON.stringify({ type: 'input', data: 'ls -la\r' }));
    await eventually(() => bystanderPty!.received.join('') === 'ls -la\r');
    expect(floodingPty!.pending).toBeLessThan(FLOW.hardLimitBytes);
    expect(bystander.closed()).toBe(false);
  }, 60_000);
});
