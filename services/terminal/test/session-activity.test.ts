/**
 * BETA-P0-005 — typing in the terminal is lab-session activity.
 *
 * The gap: `lastActivityAt` only moved on REST actions (Continue, Check, Reset).
 * A student working purely in the shell never touched it, so the reaper judged
 * an environment in active use to be idle and collected it.
 *
 * ```text
 *   ws input ──► terminal service ──internal secret + uid──► real API
 *                                                            └─► SessionStore.touchActivity
 * ```
 *
 * Every boundary that carries the fix is real here: a real terminal server, the
 * real API app with its real internal router and session manager, and a real
 * `sandboxd` broker. The only fakes are the PTY at the far end and the
 * container inventory it answers from — a container runtime is exactly what a
 * unit suite must not need — and a store wrapper that counts writes.
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

const TERMINAL_SECRET = 'terminal-activity-session-secret';
const INTERNAL_SECRET = 'terminal-activity-internal-secret';
const DERIVATION = 'terminal-activity-derivation-secret';
const RUNTIME_OWNER = 'jumptotech';

const OWNER_A = 'usr-0000000a';
const OWNER_B = 'usr-0000000b';

/** Well inside the idle budget, and unmistakably not "now". */
const PAST = () => new Date(Date.now() - 10 * 60_000).toISOString();

/** The durable store's contract, with every activity write counted. */
class CountingStore extends InMemorySessionStore {
  readonly touches: string[] = [];
  failTouches = false;

  override async touchActivity(sessionId: string, at: string): Promise<LabSession | null> {
    this.touches.push(sessionId);
    if (this.failTouches) throw new Error('database unavailable');
    return super.touchActivity(sessionId, at);
  }
}

function fakePty(): BrokerPty & { written: string[]; emit(d: string): void } {
  let onData: (d: string) => void = () => undefined;
  return {
    written: [],
    write(data) {
      this.written.push(data);
    },
    resize() {},
    kill() {},
    // No backlog to model: never paused, never behind on input.
    pause() {},
    resume() {},
    pendingInputBytes() {
      return 0;
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

interface Stack {
  terminalUrl: string;
  store: CountingStore;
  manager: SessionManager;
  ptys: ReturnType<typeof fakePty>[];
  a: LabSession;
  b: LabSession;
}

async function bringUpStack(options: { activityReportIntervalMs?: number } = {}): Promise<Stack> {
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

  const ptys: ReturnType<typeof fakePty>[] = [];
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
      inspector: { inspect: async (ref) => containers.get(ref) ?? null },
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

  return { terminalUrl: `ws://127.0.0.1:${terminalPort}/terminal`, store, manager, ptys, a, b };
}

function tokenFor(session: LabSession, ownerUserId: string, secret = TERMINAL_SECRET): string {
  return issueSessionToken({
    sessionId: session.sessionId,
    ownerUserId,
    labId: session.labId,
    namespace: session.sandboxRef!,
    secret,
    ttlSeconds: 60,
  }).token;
}

/** An open socket that records every frame it receives. */
async function open(url: string): Promise<{ ws: WebSocket; frames: Array<Record<string, unknown>> }> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const frames: Array<Record<string, unknown>> = [];
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as Record<string, unknown>));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, frames };
}

async function authenticate(url: string, token: string) {
  const socket = await open(url);
  socket.ws.send(JSON.stringify({ type: 'auth', token, cols: 80, rows: 24 }));
  const first = await eventually(() => socket.frames.find((f) => f.type === 'ready' || f.type === 'error'));
  return { ...socket, first };
}

/** Poll until `check` yields something truthy. */
async function eventually<T>(check: () => T | Promise<T>, timeoutMs = 5_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

async function lastActivity(stack: Stack, session: LabSession): Promise<string | undefined> {
  return (await stack.manager.get(session.sessionId))?.lastActivityAt;
}

describe('terminal input is lab-session activity', () => {
  it('advances the session’s activity timestamp from typing alone', async () => {
    const stack = await bringUpStack();
    const past = PAST();
    await stack.store.update(stack.a.sessionId, { lastActivityAt: past });

    const { ws, first } = await authenticate(stack.terminalUrl, tokenFor(stack.a, OWNER_A));
    expect(first.type).toBe('ready');
    // Opening the terminal is not the student doing anything.
    await settle();
    expect(await lastActivity(stack, stack.a)).toBe(past);
    expect(stack.store.touches).toEqual([]);

    // Input, and nothing else: no Continue, no Check, no other API call.
    ws.send(JSON.stringify({ type: 'input', data: 'ls -la\r' }));

    const advanced = await eventually(async () => {
      const at = await lastActivity(stack, stack.a);
      return at !== past ? at : undefined;
    });
    expect(Date.parse(advanced)).toBeGreaterThan(Date.parse(past));
    // Idle deadline only; the absolute one is never moved by activity.
    expect((await stack.manager.get(stack.a.sessionId))?.expiresAt).toBe(stack.a.expiresAt);
    expect(stack.ptys[0]!.written).toEqual(['ls -la\r']);
  });

  it('writes once per window under sustained typing, not once per keystroke', async () => {
    const stack = await bringUpStack({ activityReportIntervalMs: 400 });
    const { ws } = await authenticate(stack.terminalUrl, tokenFor(stack.a, OWNER_A));

    const burstStartedAt = Date.now();
    for (const ch of 'kubectl get pods --all-namespaces -o wide\r') {
      ws.send(JSON.stringify({ type: 'input', data: ch }));
    }
    await eventually(() => stack.ptys[0]!.written.length === 42);
    await settle(100);
    // Every keystroke reached the shell; one of them reached the database.
    expect(stack.store.touches).toEqual([stack.a.sessionId]);

    // Still typing once the window has passed: the session is refreshed again.
    await settle(Math.max(0, 450 - (Date.now() - burstStartedAt)));
    ws.send(JSON.stringify({ type: 'input', data: 'x' }));
    ws.send(JSON.stringify({ type: 'input', data: 'y' }));
    await eventually(() => stack.store.touches.length === 2);
    await settle(100);
    expect(stack.store.touches).toEqual([stack.a.sessionId, stack.a.sessionId]);
  });

  it('never moves another session’s clock', async () => {
    const stack = await bringUpStack();
    const past = PAST();
    await stack.store.update(stack.a.sessionId, { lastActivityAt: past });
    await stack.store.update(stack.b.sessionId, { lastActivityAt: past });

    // Both students connected; only A types.
    const a = await authenticate(stack.terminalUrl, tokenFor(stack.a, OWNER_A));
    const b = await authenticate(stack.terminalUrl, tokenFor(stack.b, OWNER_B));
    expect(a.first.type).toBe('ready');
    expect(b.first.type).toBe('ready');

    a.ws.send(JSON.stringify({ type: 'input', data: 'whoami\r' }));
    await eventually(async () => (await lastActivity(stack, stack.a)) !== past);
    await settle();

    expect(await lastActivity(stack, stack.b)).toBe(past);
    expect(stack.store.touches).toEqual([stack.a.sessionId]);
  });

  it('records nothing for a token whose owner does not own the session', async () => {
    const stack = await bringUpStack();
    const past = PAST();
    await stack.store.update(stack.a.sessionId, { lastActivityAt: past });

    // Correctly signed, A's session, B's owner: the API refuses the attach.
    const { ws, first } = await authenticate(stack.terminalUrl, tokenFor(stack.a, OWNER_B));
    expect(first.type).toBe('error');
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: 'id\r' }));
    await settle();

    expect(stack.ptys).toHaveLength(0);
    expect(stack.store.touches).toEqual([]);
    expect(await lastActivity(stack, stack.a)).toBe(past);
  });

  it('records nothing for unauthenticated or forged traffic', async () => {
    const stack = await bringUpStack();
    const past = PAST();
    await stack.store.update(stack.a.sessionId, { lastActivityAt: past });

    // Typing before authenticating.
    const early = await open(stack.terminalUrl);
    early.ws.send(JSON.stringify({ type: 'input', data: 'id\r' }));
    expect((await eventually(() => early.frames.find((f) => f.type === 'error'))).code).toBe(
      'UNAUTHENTICATED',
    );

    // A token for A signed with the wrong secret, followed by input.
    const forged = await authenticate(stack.terminalUrl, tokenFor(stack.a, OWNER_A, 'not-the-terminal-secret'));
    expect(forged.first.code).toBe('UNAUTHORIZED');
    if (forged.ws.readyState === WebSocket.OPEN) {
      forged.ws.send(JSON.stringify({ type: 'input', data: 'id\r' }));
    }
    await settle();

    expect(stack.store.touches).toEqual([]);
    expect(await lastActivity(stack, stack.a)).toBe(past);
  });

  it('does not count connecting, resizing, keep-alive pings or disconnecting', async () => {
    const stack = await bringUpStack();
    const past = PAST();
    await stack.store.update(stack.a.sessionId, { lastActivityAt: past });

    const { ws, frames } = await authenticate(stack.terminalUrl, tokenFor(stack.a, OWNER_A));
    ws.send(JSON.stringify({ type: 'resize', cols: 132, rows: 43 }));
    ws.send(JSON.stringify({ type: 'ping' }));
    await eventually(() => frames.some((f) => f.type === 'pong'));
    ws.close();
    await settle();

    expect(stack.store.touches).toEqual([]);
    expect(await lastActivity(stack, stack.a)).toBe(past);
  });

  it('keeps the shell working when the activity write fails', async () => {
    const stack = await bringUpStack();
    stack.store.failTouches = true;

    const { ws, frames } = await authenticate(stack.terminalUrl, tokenFor(stack.a, OWNER_A));
    ws.send(JSON.stringify({ type: 'input', data: 'echo hi\r' }));
    await eventually(() => stack.store.touches.length === 1);

    // The failure is not retried per keystroke: the window still applies.
    ws.send(JSON.stringify({ type: 'input', data: 'pwd\r' }));
    await eventually(() => stack.ptys[0]!.written.length === 2);
    await settle();
    expect(stack.store.touches).toHaveLength(1);

    // And the terminal is untouched: input arrived, output comes back.
    expect(stack.ptys[0]!.written).toEqual(['echo hi\r', 'pwd\r']);
    stack.ptys[0]!.emit('hi\r\n');
    await eventually(() => frames.some((f) => f.type === 'output' && f.data === 'hi\r\n'));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(frames.some((f) => f.type === 'error')).toBe(false);
  });
});
