/**
 * A terminal does not outlive the authority it was opened with.
 *
 * Before this, a terminal token was checked once, at attach, against the
 * session's owner and lab access — and not against the browser sign-in that
 * asked for it. So signing out left a token that opened shells for the rest of
 * its hour, and every open shell ran on for as long as somebody typed into it,
 * whatever happened to the sign-in or to the student's access afterwards.
 *
 * Now the token names the sign-in (`asid`), the API refuses it once that
 * sign-in is gone, and the activity report — the check that runs while the
 * student works — closes a socket the API refuses. Real API, real terminal
 * server, real broker; the PTY and container inventory are the only fakes.
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
import { InMemoryAuthSessionStore } from '@jumptotech/api/auth/browser-session';
import { loadConfig } from '@jumptotech/api/config';
import { createSandboxd, type BrokerPty } from '@jumptotech/sandboxd/server';
import { defaultObservabilityConfig, type SandboxdConfig } from '@jumptotech/sandboxd/config';
import type { SandboxSnapshot } from '@jumptotech/sandboxd/attach';
import { loadTerminalConfig } from '../src/config.js';
import { createTerminalServer } from '../src/server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const TERMINAL_SECRET = 'terminal-revocation-session-secret';
const INTERNAL_SECRET = 'terminal-revocation-internal-secret';
const DERIVATION = 'terminal-activity-derivation-secret';
const RUNTIME_OWNER = 'jumptotech';

const OWNER_A = 'usr-0000000a';
const OWNER_B = 'usr-0000000b';

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
const closeCodes = new WeakMap<WebSocket, number>();
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
  authSessions: InMemoryAuthSessionStore;
  /** Flip to refuse the owner's lab access, as a suspension would. */
  access: { allowed: boolean };
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
  const authSessions = new InMemoryAuthSessionStore();
  const access = { allowed: true };
  const apiPort = await listen(
    createServer(
      createApp({
        registry,
        sessions: manager,
        k8s: new FakeKubernetes(),
        config,
        // Only the sign-in store matters here; no route in this test reads a user.
        browserAuth: { users: {} as never, authSessions },
        // The real AccessControl's answer shape, switchable mid-test.
        access: {
          decide: async () =>
            access.allowed
              ? { allowed: true, via: 'entitlement', plan: null, sessionLimit: undefined }
              : { allowed: false, state: 'SUSPENDED' },
        } as never,
      }),
    ),
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

  return { terminalUrl: `ws://127.0.0.1:${terminalPort}/terminal`, authSessions, access, store, manager, ptys, a, b };
}

function tokenFor(session: LabSession, ownerUserId: string, authSessionId?: string): string {
  return issueSessionToken({
    sessionId: session.sessionId,
    ownerUserId,
    ...(authSessionId ? { authSessionId } : {}),
    labId: session.labId,
    namespace: session.sandboxRef!,
    secret: TERMINAL_SECRET,
    ttlSeconds: 60,
  }).token;
}

/** An open socket that records every frame it receives. */
async function open(url: string): Promise<{ ws: WebSocket; frames: Array<Record<string, unknown>> }> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const frames: Array<Record<string, unknown>> = [];
  ws.on('close', (code) => closeCodes.set(ws, code));
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


/** The server's close code for a socket, once it has closed it. */
function closed(ws: WebSocket): Promise<number> {
  return eventually(() => closeCodes.get(ws));
}

describe('signing out ends terminal authority', () => {
  it('refuses a new attach once the sign-in the token was requested under has ended', async () => {
    const stack = await bringUpStack();
    const signIn = await stack.authSessions.create(OWNER_A, 3600);
    const token = tokenFor(stack.a, OWNER_A, signIn.record.authSessionId);

    const before = await authenticate(stack.terminalUrl, token);
    expect(before.first.type).toBe('ready');
    before.ws.close();

    await stack.authSessions.destroy(signIn.cookieValue); // POST /auth/logout
    const after = await authenticate(stack.terminalUrl, token);
    // To the browser this is an expired token: it asks for a fresh one, and
    // that request is where a signed-out browser is sent to sign in again.
    expect(after.first).toMatchObject({ type: 'error', code: 'UNAUTHORIZED' });
    expect(await closed(after.ws)).toBe(4401);
    expect(stack.ptys).toHaveLength(1);
  });

  it('closes an open terminal on its next activity report after sign-out, and keeps its lab running', async () => {
    const stack = await bringUpStack({ activityReportIntervalMs: 50 });
    const signIn = await stack.authSessions.create(OWNER_A, 3600);
    const { ws, frames } = await authenticate(stack.terminalUrl, tokenFor(stack.a, OWNER_A, signIn.record.authSessionId));
    ws.send(JSON.stringify({ type: 'input', data: 'ls\r' }));
    await eventually(() => stack.store.touches.length === 1);

    await stack.authSessions.destroyAllForUser(OWNER_A); // ops sign-out
    await settle(100);
    const closing = closed(ws);
    ws.send(JSON.stringify({ type: 'input', data: 'id\r' }));

    expect(await closing).toBe(4401);
    expect(frames.find((f) => f.type === 'error')).toMatchObject({ code: 'UNAUTHORIZED' });
    // The lab itself is not the terminal's to end.
    expect((await stack.manager.get(stack.a.sessionId))?.status).toBe('ACTIVE');
  });

  it('leaves a terminal opened under another, still-live sign-in of the same student alone', async () => {
    const stack = await bringUpStack({ activityReportIntervalMs: 50 });
    const laptop = await stack.authSessions.create(OWNER_A, 3600);
    const phone = await stack.authSessions.create(OWNER_A, 3600);
    const { ws, frames } = await authenticate(stack.terminalUrl, tokenFor(stack.a, OWNER_A, phone.record.authSessionId));

    await stack.authSessions.destroy(laptop.cookieValue);
    ws.send(JSON.stringify({ type: 'input', data: 'a' }));
    await settle(150);
    ws.send(JSON.stringify({ type: 'input', data: 'b' }));
    await eventually(() => stack.store.touches.length === 2);
    await settle(100);

    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(frames.some((f) => f.type === 'error')).toBe(false);
    expect(stack.ptys[0]!.written).toEqual(['a', 'b']);
  });

  it('refuses a claim naming somebody else’s live sign-in', async () => {
    const stack = await bringUpStack();
    const bobs = await stack.authSessions.create(OWNER_B, 3600);
    // A's session and owner, correctly signed, carrying B's sign-in: only a
    // forged or mis-minted token could, and it opens nothing.
    const refused = await authenticate(stack.terminalUrl, tokenFor(stack.a, OWNER_A, bobs.record.authSessionId));
    expect(refused.first).toMatchObject({ type: 'error', code: 'UNAUTHORIZED' });
    expect(stack.ptys).toHaveLength(0);
  });

  it('still attaches a token with no sign-in binding (a bearer caller), on the owner and access checks alone', async () => {
    const stack = await bringUpStack();
    const { first } = await authenticate(stack.terminalUrl, tokenFor(stack.a, OWNER_A));
    expect(first.type).toBe('ready');
  });
});

describe('suspending lab access ends an open terminal', () => {
  it('closes the socket on its next activity report with the access refusal, not a retry', async () => {
    const stack = await bringUpStack({ activityReportIntervalMs: 50 });
    const { ws, frames } = await authenticate(stack.terminalUrl, tokenFor(stack.a, OWNER_A));
    ws.send(JSON.stringify({ type: 'input', data: 'ls\r' }));
    await eventually(() => stack.store.touches.length === 1);

    stack.access.allowed = false; // ops access suspend
    await settle(100);
    const closing = closed(ws);
    ws.send(JSON.stringify({ type: 'input', data: 'id\r' }));

    expect(await closing).toBe(4403);
    expect(frames.find((f) => f.type === 'error')).toMatchObject({ code: 'ACCESS_NOT_ACTIVE' });
  });

  it('keeps the shell when the API cannot answer, which says nothing about the socket', async () => {
    const stack = await bringUpStack({ activityReportIntervalMs: 50 });
    const { ws, frames } = await authenticate(stack.terminalUrl, tokenFor(stack.a, OWNER_A));
    stack.store.failTouches = true;
    ws.send(JSON.stringify({ type: 'input', data: 'a' }));
    await eventually(() => stack.store.touches.length === 1);
    await settle(100);
    ws.send(JSON.stringify({ type: 'input', data: 'b' }));
    await eventually(() => stack.store.touches.length === 2);
    await settle(100);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(frames.some((f) => f.type === 'error')).toBe(false);
  });
});
