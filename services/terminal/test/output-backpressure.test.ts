/**
 * A student's shell output cannot pile up in a shared relay.
 *
 * The finding: `term.onData → ws.send` queued whatever the browser had not read
 * in the relaying process, with no bound. A client that stops reading its
 * socket while its shell runs `yes` grew the terminal service by exactly the
 * bytes the shell wrote — probed at 127 MiB queued for 128 MiB written before
 * this change — and the production terminal container is capped at 512 MiB,
 * so one student could take every other student's shell down with it.
 * `sandboxd` relays the same stream one hop earlier and had the same shape.
 *
 * ```text
 *   fake PTY ──► sandboxd ──ws──► terminal ──ws──► client that stops reading
 * ```
 *
 * Every hop is real: the API that releases the binding, the broker that
 * attaches, and the terminal that relays. The PTY is a fake that behaves like
 * a real one under flow control — it stops producing while paused.
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

const TERMINAL_SECRET = 'output-backpressure-session-secret';
const INTERNAL_SECRET = 'output-backpressure-internal-secret';
const DERIVATION = 'output-backpressure-derivation-secret';
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

const CHUNK = 'y\n'.repeat(16 * 1024); // 32 KiB, like `yes`

/** A PTY that writes until told how much, and stops while paused. */
interface FloodPty extends BrokerPty {
  killed: boolean;
  pauses: number;
  resumes: number;
  emitted: number;
  flood(bytes: number): Promise<void>;
}

function floodPty(options: { pausable: boolean }): FloodPty {
  let onData: (d: string) => void = () => undefined;
  let paused = false;
  let killed = false;
  let wake: (() => void) | undefined;
  const pty: FloodPty = {
    killed: false,
    pauses: 0,
    resumes: 0,
    emitted: 0,
    write() {},
    resize() {},
    // A source that cannot be slowed is asked to pause like any other and
    // simply does not: the relay must then fall back to its hard limit.
    pause() {
      pty.pauses += 1;
      if (options.pausable) paused = true;
    },
    resume() {
      pty.resumes += 1;
      paused = false;
      wake?.();
    },
    pendingInputBytes: () => 0,
    kill() {
      killed = true;
      pty.killed = true;
      wake?.();
    },
    onData(listener) {
      onData = listener;
    },
    onExit() {},
    async flood(bytes) {
      while (pty.emitted < bytes && !killed) {
        if (paused) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        onData(CHUNK);
        pty.emitted += CHUNK.length;
        // Yield like a real reader does between reads of the PTY master.
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
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

async function bringUpStack(options: { pausable: boolean }) {
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

  const ptys: FloodPty[] = [];
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
  };
  const brokerPort = await listen(
    createSandboxd({
      config: brokerConfig,
      inspector: { inspect: async (ref) => containers.get(ref) ?? null },
      spawn: () => {
        const pty = floodPty(options);
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
  const terminalPort = await listen(createTerminalServer({ ...terminalConfig, outputFlow: FLOW }));

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

interface Client {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  outputBytes: () => number;
  closed: () => boolean;
}

async function attach(url: string, token: string): Promise<Client> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const frames: Array<Record<string, unknown>> = [];
  let outputBytes = 0;
  let closed = false;
  ws.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as Record<string, unknown>;
    if (frame.type === 'output') outputBytes += String(frame.data).length;
    else frames.push(frame);
  });
  ws.on('close', () => {
    closed = true;
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'auth', token, cols: 80, rows: 24 }));
  await eventually(() => frames.find((f) => f.type === 'ready'));
  return { ws, frames, outputBytes: () => outputBytes, closed: () => closed };
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

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Watch the largest queue any WebSocket in this process holds. */
function watchLargestQueue(): { largest: () => number; stop: () => void } {
  const proto = WebSocket.prototype as unknown as {
    send: (this: WebSocket, ...args: unknown[]) => void;
  };
  const original = proto.send;
  let largest = 0;
  proto.send = function (this: WebSocket, ...args: unknown[]) {
    original.apply(this, args);
    if (this.bufferedAmount > largest) largest = this.bufferedAmount;
  };
  return {
    largest: () => largest,
    stop: () => {
      proto.send = original;
    },
  };
}

const MiB = 1024 * 1024;

describe('shell output backpressure', () => {
  it('stops a shell flooding a client that has stopped reading, instead of queueing it', async () => {
    const stack = await bringUpStack({ pausable: true });
    const client = await attach(stack.terminalUrl, tokenFor(stack.a, OWNER_A));
    const pty = stack.ptys[0]!;

    // The student's own client stops reading its socket.
    (client.ws as unknown as { _socket: { pause(): void } })._socket.pause();

    const queue = watchLargestQueue();
    try {
      void pty.flood(64 * MiB);
      await settle(1_500);
    } finally {
      queue.stop();
    }

    // The shell was told to stop, long before it had written what it wanted to.
    expect(pty.pauses).toBeGreaterThan(0);
    expect(pty.emitted).toBeLessThan(32 * MiB);
    // No relay held more than the hard limit — before this change the terminal
    // queued the whole stream.
    expect(queue.largest()).toBeLessThan(FLOW.hardLimitBytes);
    // Nothing was dropped on the floor either: the connection is still up.
    expect(client.closed()).toBe(false);
  }, 30_000);

  it('delivers every byte once the client reads again', async () => {
    const stack = await bringUpStack({ pausable: true });
    const client = await attach(stack.terminalUrl, tokenFor(stack.a, OWNER_A));
    const pty = stack.ptys[0]!;
    const socket = (client.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;

    socket.pause();
    const done = pty.flood(6 * MiB);
    await eventually(() => pty.pauses > 0);
    socket.resume();
    await done;

    await eventually(() => client.outputBytes() === pty.emitted);
    expect(pty.emitted).toBeGreaterThanOrEqual(6 * MiB);
    expect(pty.resumes).toBeGreaterThan(0);
    expect(client.closed()).toBe(false);
  }, 30_000);

  it('closes only the offending connection when a source cannot be slowed', async () => {
    const stack = await bringUpStack({ pausable: false });
    const flooding = await attach(stack.terminalUrl, tokenFor(stack.a, OWNER_A));
    const bystander = await attach(stack.terminalUrl, tokenFor(stack.b, OWNER_B));
    const [floodingPty, bystanderPty] = stack.ptys;

    (flooding.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    void floodingPty!.flood(64 * MiB);

    // That one shell is ended at the hard limit. (The client is not reading,
    // so it cannot see its own close frame; the relay's action is the signal.)
    await eventually(() => floodingPty!.killed, 20_000);
    expect(floodingPty!.emitted).toBeLessThan(32 * MiB);

    // The other student's shell is untouched and still streams.
    expect(bystanderPty!.killed).toBe(false);
    expect(bystander.closed()).toBe(false);
    await bystanderPty!.flood(64 * 1024);
    await eventually(() => bystander.outputBytes() >= 64 * 1024);
  }, 30_000);
});
