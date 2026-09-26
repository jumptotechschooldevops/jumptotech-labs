/**
 * The container-backed track, end to end, with no container runtime anywhere in
 * this process.
 *
 * This is the test for the architectural change. Before it, a Linux, Ansible,
 * CI/CD, Terraform, Networking or CS lab could only get a shell if *this*
 * service could run `docker exec` — which means giving a container runtime to
 * the one process a student types into, which no deployment may do. So those
 * tracks were switched off and 81 of 114 labs could not run.
 *
 * ```text
 *   browser ──auth token──► terminal ──ws + internal secret──► sandboxd ──► runtime
 *                              │                                  │
 *                    this process: no runtime,        derives the container from the
 *                    no socket, no DOCKER_HOST        session id and label-checks it
 * ```
 *
 * Everything below runs against a real `sandboxd` over a real WebSocket. The
 * only fake is the PTY at the far end and the container inventory it answers
 * from, because a container runtime is exactly what a unit test must not need.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import WebSocket from 'ws';
import {
  CONTAINER_SANDBOX_PREFIX,
  LAB_LABEL,
  MANAGED_LABEL,
  RUNTIME_OWNER_LABEL,
  SESSION_LABEL,
  deriveSandboxRef,
} from '@jumptotech/lab-orchestrator';
import { issueSessionToken } from '@jumptotech/lab-orchestrator/session-token';
import { createSandboxd, type BrokerPty } from '@jumptotech/sandboxd/server';
import { defaultObservabilityConfig, type SandboxdConfig } from '@jumptotech/sandboxd/config';
import type { SandboxSnapshot } from '@jumptotech/sandboxd/attach';
import { loadTerminalConfig } from '../src/config.js';
import { createTerminalServer } from '../src/server.js';

const TERMINAL_SECRET = 'terminal-session-secret-for-broker-tests';
const INTERNAL_SECRET = 'internal-service-secret-for-broker-tests';
const DERIVATION = 'namespace-derivation-secret-for-broker-tests';

const OWNER_A = 'usr-aaaa0001';
const OWNER_B = 'usr-bbbb0002';
const SESSION_A = 'sess-aaaaaaaaaaaaaaaa';
const SESSION_B = 'sess-bbbbbbbbbbbbbbbb';

const refFor = (sessionId: string): string =>
  deriveSandboxRef({ sessionId, secret: DERIVATION, prefix: CONTAINER_SANDBOX_PREFIX });

function snapshot(sessionId: string): SandboxSnapshot {
  return {
    state: 'running',
    user: 'student',
    workdir: '/home/student',
    labels: {
      [MANAGED_LABEL]: 'true',
      [RUNTIME_OWNER_LABEL]: 'jumptotech',
      [SESSION_LABEL]: sessionId,
      [LAB_LABEL]: 'LINUX-001',
    },
  };
}

function fakePty(): BrokerPty & {
  written: string[];
  resizes: [number, number][];
  killed: boolean;
  emit(d: string): void;
  exit(exitCode: number): void;
} {
  let onData: (d: string) => void = () => undefined;
  let onExit: (e: { exitCode: number }) => void = () => undefined;
  return {
    written: [],
    resizes: [],
    killed: false,
    write(data) {
      this.written.push(data);
    },
    resize(cols, rows) {
      this.resizes.push([cols, rows]);
    },
    kill() {
      this.killed = true;
    },
    // No backlog to model: never paused, never behind on input.
    pause() {},
    resume() {},
    pendingInputBytes() {
      return 0;
    },
    onData(listener) {
      onData = listener;
    },
    onExit(listener) {
      onExit = listener;
    },
    emit(data) {
      onData(data);
    },
    exit(exitCode) {
      onExit({ exitCode });
    },
  };
}

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

/** A pause point a test opens by hand: whoever reaches it waits for a release. */
interface Gate {
  /** Resolves once `n` callers have reached the gate. */
  reached(n: number): Promise<void>;
  /** Let everyone through, those parked here and those still to arrive. */
  release(): void;
  /**
   * Let through only whoever is parked here right now, and shut the gate again.
   *
   * Same-session attaches are taken in turn, so a second attach reaches a gate
   * only after the first has finished. Releasing one arrival at a time is how a
   * test steps through that order without pausing for it.
   */
  releaseArrived(): void;
  wait(): Promise<void>;
}

function gate(): Gate {
  let arrivals = 0;
  let openToAll = false;
  const counters: Array<{ n: number; resolve: () => void }> = [];
  const parked: Array<() => void> = [];
  const resumeParked = (): void => {
    for (const resume of parked.splice(0)) resume();
  };
  return {
    reached(n) {
      return arrivals >= n ? Promise.resolve() : new Promise((resolve) => counters.push({ n, resolve }));
    },
    release() {
      openToAll = true;
      resumeParked();
    },
    releaseArrived: resumeParked,
    async wait() {
      arrivals += 1;
      for (const c of counters.filter((c) => arrivals >= c.n)) c.resolve();
      if (openToAll) return;
      await new Promise<void>((resume) => parked.push(resume));
    },
  };
}

interface Stack {
  terminalUrl: string;
  /** The terminal service's HTTP base, for its internal control endpoints. */
  controlUrl: string;
  ptys: ReturnType<typeof fakePty>[];
  argvs: string[][];
  /** Who the stub API says owns each session. */
  owners: Map<string, string>;
  /** Every TCP connection the broker holds, so a test can drop them as a crash would. */
  brokerConnections: Set<Socket>;
  /** Credential exchanges the stub API has been asked for. */
  credentialCalls(): number;
}

/**
 * A stub API, a real broker and a real terminal service.
 *
 * The stub API stands in for `/internal/sessions/:id/credentials`, and it
 * enforces the same ownership rule the real one does — that is the check the
 * cross-user tests below are exercising.
 */
async function bringUpStack(
  containers: Record<string, SandboxSnapshot>,
  /** Latency to add, each kept inside that step's own timeout. */
  delays: { apiMs?: number; inspectMs?: number; apiGate?: Gate; inspectGate?: Gate } = {},
): Promise<Stack> {
  const owners = new Map<string, string>([
    [SESSION_A, OWNER_A],
    [SESSION_B, OWNER_B],
  ]);

  let credentialCalls = 0;
  const api = createServer((req, res) => {
    const match = /^\/internal\/sessions\/(sess-[0-9a-f]+)\/credentials$/.exec(req.url ?? '');
    if (!match || req.method !== 'POST') {
      res.writeHead(404).end('{}');
      return;
    }
    if (req.headers['x-internal-secret'] !== INTERNAL_SECRET) {
      res.writeHead(401).end(JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED' } }));
      return;
    }
    const sessionId = match[1]!;
    credentialCalls += 1;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      if (delays.apiMs) await new Promise((r) => setTimeout(r, delays.apiMs));
      await delays.apiGate?.wait();
      const claimed = (JSON.parse(body || '{}') as { ownerUserId?: string }).ownerUserId;
      if (!claimed || owners.get(sessionId) !== claimed) {
        res
          .writeHead(403, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: false, error: { code: 'SESSION_NOT_OWNED', message: 'not yours' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          ok: true,
          data: {
            kind: 'container-exec',
            runtime: 'docker',
            containerRef: refFor(sessionId),
            user: 'student',
            workdir: '/home/student',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      );
    });
  });
  const apiPort = await listen(api);

  const ptys: ReturnType<typeof fakePty>[] = [];
  const argvs: string[][] = [];
  const brokerConfig: SandboxdConfig = {
    observability: defaultObservabilityConfig('sandboxd', 0),
    port: 0,
    bindAddress: '127.0.0.1',
    scopeSecrets: { attach: INTERNAL_SECRET + '-attach', runtime: INTERNAL_SECRET + '-runtime', docker: INTERNAL_SECRET + '-docker' },
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
  const broker = createSandboxd({
    config: brokerConfig,
    inspector: {
      inspect: async (ref) => {
        if (delays.inspectMs) await new Promise((r) => setTimeout(r, delays.inspectMs));
        await delays.inspectGate?.wait();
        return containers[ref] ?? null;
      },
    },
    spawn: (_cmd, args) => {
      argvs.push(args);
      const p = fakePty();
      ptys.push(p);
      return p;
    },
    log: () => undefined,
  });
  const brokerConnections = new Set<Socket>();
  broker.on('connection', (socket: Socket) => {
    brokerConnections.add(socket);
    socket.on('close', () => brokerConnections.delete(socket));
  });
  const brokerPort = await listen(broker);

  const terminalConfig = loadTerminalConfig({
    TERMINAL_SESSION_SECRET: TERMINAL_SECRET,
    INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
    API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
    SANDBOX_BROKER_URL: `http://127.0.0.1:${brokerPort}`,
    SANDBOXD_ATTACH_SECRET: `${INTERNAL_SECRET}-attach`,
    TERMINAL_SANDBOX_BROKER_ENABLED: 'true',
    // Off, so nothing below can be passing because this process ran a shell.
    TERMINAL_CONTAINER_EXEC_ENABLED: 'false',
    ALLOWED_ORIGINS: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);

  const terminal = createTerminalServer(terminalConfig);
  const terminalPort = await listen(terminal);

  return {
    terminalUrl: `ws://127.0.0.1:${terminalPort}/terminal`,
    controlUrl: `http://127.0.0.1:${terminalPort}`,
    ptys,
    argvs,
    owners,
    brokerConnections,
    credentialCalls: () => credentialCalls,
  };
}

function tokenFor(sessionId: string, ownerUserId: string): string {
  return issueSessionToken({
    sessionId,
    ownerUserId,
    labId: 'LINUX-001',
    namespace: refFor(sessionId),
    secret: TERMINAL_SECRET,
    ttlSeconds: 60,
  }).token;
}

function open(url: string): WebSocket {
  const ws = new WebSocket(url);
  sockets.push(ws);
  return ws;
}

/**
 * Wait until `check` holds, or fail after a generous deadline.
 *
 * Bytes cross two sockets here (test → terminal → broker), so "it arrived" is
 * polled for rather than assumed after a fixed pause: on a loaded host a pause
 * that is usually enough is sometimes not, and the test then fails for timing,
 * not for behaviour.
 */
async function eventually(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function frame(ws: WebSocket, types: string[], timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${types.join('/')} frame`)), timeoutMs);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      if (!types.includes(String(msg.type))) return;
      clearTimeout(timer);
      resolve(msg);
    });
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function authenticate(url: string, token: string): Promise<{ ws: WebSocket; first: Record<string, unknown> }> {
  const ws = open(url);
  await new Promise((resolve) => ws.on('open', resolve));
  const first = frame(ws, ['ready', 'error']);
  ws.send(JSON.stringify({ type: 'auth', token, cols: 80, rows: 24 }));
  return { ws, first: await first };
}

describe('a container-backed lab gets a shell without this process holding a runtime', () => {
  it('attaches through the broker and carries bytes both ways', async () => {
    const stack = await bringUpStack({ [refFor(SESSION_A)]: snapshot(SESSION_A) });

    const { ws, first } = await authenticate(stack.terminalUrl, tokenFor(SESSION_A, OWNER_A));
    expect(first).toMatchObject({ type: 'ready', sandboxKind: 'container', sandboxRef: refFor(SESSION_A) });

    // The PTY was opened in the broker, against the session's own container.
    expect(stack.argvs).toHaveLength(1);
    expect(stack.argvs[0]).toContain(refFor(SESSION_A));

    ws.send(JSON.stringify({ type: 'input', data: 'id -un\r' }));
    await eventually(() => stack.ptys[0]!.written.length > 0, 'input to reach the PTY');
    expect(stack.ptys[0]!.written).toEqual(['id -un\r']);

    const output = frame(ws, ['output']);
    stack.ptys[0]!.emit('student\r\n');
    expect((await output).data).toBe('student\r\n');
  });

  it('opens no shell at all when the API refuses the ownership check', async () => {
    // User B presenting a token minted for A's session: the token verifies —
    // it is signed — and the API still refuses, because the *live* record says
    // A owns that session.
    const stack = await bringUpStack({ [refFor(SESSION_A)]: snapshot(SESSION_A) });

    const { first } = await authenticate(stack.terminalUrl, tokenFor(SESSION_A, OWNER_B));

    expect(first.type).toBe('error');
    expect(stack.ptys).toHaveLength(0);
  });

  it('gives two concurrent users two different sandboxes and no path between them', async () => {
    const stack = await bringUpStack({
      [refFor(SESSION_A)]: snapshot(SESSION_A),
      [refFor(SESSION_B)]: snapshot(SESSION_B),
    });

    const a = await authenticate(stack.terminalUrl, tokenFor(SESSION_A, OWNER_A));
    const b = await authenticate(stack.terminalUrl, tokenFor(SESSION_B, OWNER_B));

    expect(a.first.sandboxRef).toBe(refFor(SESSION_A));
    expect(b.first.sandboxRef).toBe(refFor(SESSION_B));
    expect(a.first.sandboxRef).not.toBe(b.first.sandboxRef);

    // Each socket's input reaches only its own PTY.
    a.ws.send(JSON.stringify({ type: 'input', data: 'A\r' }));
    b.ws.send(JSON.stringify({ type: 'input', data: 'B\r' }));
    await eventually(
      () => stack.ptys[0]!.written.length > 0 && stack.ptys[1]!.written.length > 0,
      'input to reach both PTYs',
    );
    expect(stack.ptys[0]!.written).toEqual(['A\r']);
    expect(stack.ptys[1]!.written).toEqual(['B\r']);

    // Closing A's shell leaves B's alone.
    a.ws.close();
    await eventually(() => stack.ptys[0]!.killed, "A's PTY to be closed");
    expect(stack.ptys[1]!.killed).toBe(false);
  });

  it('refuses a token signed with the wrong secret before it reaches the broker', async () => {
    const stack = await bringUpStack({ [refFor(SESSION_A)]: snapshot(SESSION_A) });
    const forged = issueSessionToken({
      sessionId: SESSION_A,
      ownerUserId: OWNER_A,
      labId: 'LINUX-001',
      namespace: refFor(SESSION_A),
      secret: 'not-the-terminal-secret',
      ttlSeconds: 60,
    }).token;

    const { first } = await authenticate(stack.terminalUrl, forged);
    expect(first.type).toBe('error');
    expect(stack.ptys).toHaveLength(0);
  });

  it("refuses when the session's sandbox is not on the runtime", async () => {
    const stack = await bringUpStack({});
    const { first } = await authenticate(stack.terminalUrl, tokenFor(SESSION_A, OWNER_A));
    expect(first).toMatchObject({ type: 'error' });
    expect(stack.ptys).toHaveLength(0);
  });
});

/** Every frame and the close code a browser socket receives, from now on. */
function record(ws: WebSocket): { frames: Record<string, unknown>[]; closed: Promise<number> } {
  const frames: Record<string, unknown>[] = [];
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as Record<string, unknown>));
  return { frames, closed: new Promise((resolve) => ws.on('close', (code) => resolve(code))) };
}

/*
 * A broker shell ends one of two ways, and a student has to be told which.
 * The shell exiting — `exit`, a program that ended it — is final, and the
 * browser does not reconnect. Losing the broker — sandboxd restarted, crashed
 * or was killed for memory — is not the student's doing, and it is exactly what
 * the workspace's automatic reconnect exists to ride out. Both used to reach
 * the browser as an `exit` frame and close 1000: "The shell exited (code 0)",
 * and no reconnect.
 */
describe('a broker shell that ends', () => {
  it('reports the shell exiting as an exit', async () => {
    const stack = await bringUpStack({ [refFor(SESSION_A)]: snapshot(SESSION_A) });
    const { ws, first } = await authenticate(stack.terminalUrl, tokenFor(SESSION_A, OWNER_A));
    expect(first.type).toBe('ready');
    const seen = record(ws);

    stack.ptys[0]!.exit(3);

    expect(await seen.closed).toBe(1000);
    expect(seen.frames).toContainEqual({ type: 'exit', exitCode: 3 });
    expect(seen.frames.some((f) => f.type === 'error')).toBe(false);
  });

  it('reports losing the broker as a transient failure, not as the shell exiting', async () => {
    const stack = await bringUpStack({ [refFor(SESSION_A)]: snapshot(SESSION_A) });
    const { ws, first } = await authenticate(stack.terminalUrl, tokenFor(SESSION_A, OWNER_A));
    expect(first.type).toBe('ready');
    const seen = record(ws);

    for (const socket of stack.brokerConnections) socket.destroy();

    expect(await seen.closed).toBe(1011);
    expect(seen.frames.some((f) => f.type === 'exit')).toBe(false);
    expect(seen.frames).toContainEqual(expect.objectContaining({ type: 'error', code: 'SANDBOX_UNAVAILABLE' }));
  });
});

describe('the auth grace period bounds the wait for a token, not the attach', () => {
  // Both tests run on the real 10 s grace period, so each takes over 10 s.

  it('gives a shell to a client that sent its token at once, however long the attach then takes', async () => {
    // 6 s for credentials plus 6 s for the broker's inspect: past the grace
    // period, each within its own step's timeout. An API this slow was
    // measured on a loaded host (docs/development/browser-e2e-private-beta.md).
    const stack = await bringUpStack({ [refFor(SESSION_A)]: snapshot(SESSION_A) }, { apiMs: 6_000, inspectMs: 6_000 });
    const ws = open(stack.terminalUrl);
    await new Promise((resolve) => ws.on('open', resolve));
    const started = Date.now();
    const first = frame(ws, ['ready', 'error'], 25_000);
    ws.send(JSON.stringify({ type: 'auth', token: tokenFor(SESSION_A, OWNER_A), cols: 80, rows: 24 }));

    expect(await first).toMatchObject({ type: 'ready', sandboxRef: refFor(SESSION_A) });
    expect(Date.now() - started).toBeGreaterThan(10_000);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(stack.ptys).toHaveLength(1);
  }, 30_000);

  it('still drops a socket that never sends a token', async () => {
    const stack = await bringUpStack({ [refFor(SESSION_A)]: snapshot(SESSION_A) });
    const ws = open(stack.terminalUrl);
    await new Promise((resolve) => ws.on('open', resolve));
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));

    expect(await frame(ws, ['error'], 15_000)).toMatchObject({ code: 'AUTH_TIMEOUT' });
    expect(await closed).toBe(4401);
    expect(stack.ptys).toHaveLength(0);
  }, 30_000);
});

describe('frames that arrive while a signed token is still attaching', () => {
  /*
   * PR #37 CI, student-isolation.spec.ts: a browser re-opening a workspace sent
   * `resize` *before* `auth` (LabTerminal fitted in `onopen`, and xterm's
   * resize handler wrote to the open socket). The service rightly refused it,
   * 4401 "First message must be an auth frame"; the fix for that is in the web
   * client (apps/web/test/LabTerminal.test.tsx). These tests pin the other side
   * of the boundary: frames after a *verified* token, while it attaches, keep
   * the socket and reach no shell; a frame before any token is still refused;
   * and a browser that leaves mid-attach leaves no shell behind.
   */

  it('keeps the socket, and opens the shell at the size the browser settled on', async () => {
    const stack = await bringUpStack({ [refFor(SESSION_A)]: snapshot(SESSION_A) }, { apiMs: 400 });
    const ws = open(stack.terminalUrl);
    await new Promise((resolve) => ws.on('open', resolve));
    const first = frame(ws, ['ready', 'error']);
    ws.send(JSON.stringify({ type: 'auth', token: tokenFor(SESSION_A, OWNER_A), cols: 80, rows: 24 }));
    ws.send(JSON.stringify({ type: 'resize', cols: 132, rows: 40 }));
    ws.send(JSON.stringify({ type: 'ping' }));

    expect(await first).toMatchObject({ type: 'ready', sandboxRef: refFor(SESSION_A) });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(stack.ptys).toHaveLength(1);
    await eventually(() => stack.ptys[0]!.resizes.length > 0, 'the settled size to reach the PTY');
    expect(stack.ptys[0]!.resizes.at(-1)).toEqual([132, 40]);
  });

  it('never delivers input typed before the shell exists', async () => {
    const stack = await bringUpStack({ [refFor(SESSION_A)]: snapshot(SESSION_A) }, { apiMs: 400 });
    const ws = open(stack.terminalUrl);
    await new Promise((resolve) => ws.on('open', resolve));
    const first = frame(ws, ['ready', 'error']);
    ws.send(JSON.stringify({ type: 'auth', token: tokenFor(SESSION_A, OWNER_A), cols: 80, rows: 24 }));
    ws.send(JSON.stringify({ type: 'input', data: 'early\r' }));

    expect(await first).toMatchObject({ type: 'ready' });
    ws.send(JSON.stringify({ type: 'input', data: 'after\r' }));
    await eventually(() => stack.ptys[0]!.written.length > 0, 'input to reach the PTY');
    expect(stack.ptys[0]!.written).toEqual(['after\r']);
  });

  it('still refuses a socket whose first frame is not auth', async () => {
    const stack = await bringUpStack({ [refFor(SESSION_A)]: snapshot(SESSION_A) });
    const ws = open(stack.terminalUrl);
    await new Promise((resolve) => ws.on('open', resolve));
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    const error = frame(ws, ['error']);
    ws.send(JSON.stringify({ type: 'resize', cols: 132, rows: 40 }));
    ws.send(JSON.stringify({ type: 'auth', token: tokenFor(SESSION_A, OWNER_A), cols: 80, rows: 24 }));

    expect(await error).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await closed).toBe(4401);
    await new Promise((r) => setTimeout(r, 300));
    expect(stack.ptys).toHaveLength(0);
  });

  it('still refuses a resize that follows a token the API rejects', async () => {
    // B's signed token re-used on A's session: the resize rides along and must
    // neither open a shell nor keep the socket.
    const stack = await bringUpStack({ [refFor(SESSION_A)]: snapshot(SESSION_A) }, { apiMs: 200 });
    const ws = open(stack.terminalUrl);
    await new Promise((resolve) => ws.on('open', resolve));
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    const first = frame(ws, ['ready', 'error']);
    ws.send(JSON.stringify({ type: 'auth', token: tokenFor(SESSION_A, OWNER_B), cols: 80, rows: 24 }));
    ws.send(JSON.stringify({ type: 'resize', cols: 132, rows: 40 }));

    expect(await first).toMatchObject({ type: 'error' });
    expect(await closed).toBe(4403);
    expect(stack.ptys).toHaveLength(0);
  });

  it('leaves no shell behind when the browser leaves during the broker attach', async () => {
    const inspectGate = gate();
    const stack = await bringUpStack({ [refFor(SESSION_A)]: snapshot(SESSION_A) }, { inspectGate });
    const ws = open(stack.terminalUrl);
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'auth', token: tokenFor(SESSION_A, OWNER_A), cols: 80, rows: 24 }));
    // Past the credentials fetch, inside the broker's inspect.
    await inspectGate.reached(1);
    const closed = new Promise((resolve) => ws.on('close', resolve));
    ws.close(1000, 'navigated away');
    await closed;
    inspectGate.release();

    await eventually(() => stack.ptys.length === 1 && stack.ptys[0]!.killed, 'the PTY to be closed');
    expect(stack.ptys).toHaveLength(1);
  });
});

describe('one shell per session, even while attaches are still in flight', () => {
  /*
   * `startSession` closed the session's existing shell *before* its own attach,
   * then waited on the API and the broker. Anything that happened for the same
   * session during that wait went unseen: a second socket attaching at once
   * registered a second shell (the first no longer reachable by session id, so
   * End could not close it), and a Terminate — End Lab, the reaper — found no
   * shell to close and was followed by one being opened anyway. Each of those
   * PTYs lived until the terminal's idle timer, 30 minutes in compose.
   *
   * Every pause below is a gate the test opens: no timing is assumed.
   */

  const closeCode = (ws: WebSocket): Promise<number> =>
    new Promise((resolve) => ws.on('close', (code) => resolve(code)));

  async function terminate(stack: Stack, sessionId: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${stack.controlUrl}/internal/terminate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify({ sessionId }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Record<string, unknown> }).data;
  }

  async function authOnly(stack: Stack): Promise<WebSocket> {
    const ws = open(stack.terminalUrl);
    await new Promise((resolve) => ws.on('open', resolve));
    // Resolves once the frame has been written to the socket, so a test that
    // steps a gate afterwards knows the token is on its way rather than still
    // sitting in this process.
    await new Promise<void>((resolve, reject) =>
      ws.send(
        JSON.stringify({ type: 'auth', token: tokenFor(SESSION_A, OWNER_A), cols: 80, rows: 24 }),
        (err) => (err ? reject(err) : resolve()),
      ),
    );
    return ws;
  }

  it('two sockets attaching together leave one shell: the newer one', async () => {
    const apiGate = gate();
    const stack = await bringUpStack({ [refFor(SESSION_A)]: snapshot(SESSION_A) }, { apiGate });

    const first = await authOnly(stack);
    // Only the end: this socket is given a shell, and then loses it to the
    // newer connection. `frame` ignores the types it was not asked for.
    const firstEnded = frame(first, ['error']);
    const firstClosed = closeCode(first);
    await apiGate.reached(1);

    /*
     * A second socket authenticates with the same token while the first attach
     * is parked in the credentials fetch.
     *
     * It cannot reach the API — cannot do anything this test can observe — until
     * the first turn is over, so the ordering is stepped rather than waited for:
     * let through only the attach already parked here, then wait for the second
     * to arrive. That arrival is the proof it queued behind the first.
     */
    const second = await authOnly(stack);
    const secondReady = frame(second, ['ready', 'error']);
    apiGate.releaseArrived();
    await apiGate.reached(2);

    // Serialized: the first attach ran to completion — one shell, the first
    // socket's — before the second one asked the API for anything.
    expect(stack.ptys).toHaveLength(1);
    apiGate.release();

    expect(await secondReady).toMatchObject({ type: 'ready', sandboxRef: refFor(SESSION_A) });
    expect(await firstEnded).toMatchObject({ type: 'error', code: 'SESSION_ENDED' });
    expect(await firstClosed).toBe(4410);

    // The newer attach replaced the older shell as it started: two PTYs were
    // opened over the session's life and exactly one of them is live.
    await eventually(
      () => stack.ptys.length === 2 && stack.ptys[0]!.killed,
      "the older socket's shell to be closed",
    );
    expect(stack.ptys[1]!.killed).toBe(false);
    second.send(JSON.stringify({ type: 'input', data: 'B\r' }));
    await eventually(() => stack.ptys[1]!.written.includes('B\r'), 'input to reach the shell');

    // And that one shell is the session's, so ending the session reaches it.
    expect(await terminate(stack, SESSION_A)).toEqual({ terminated: true });
    await eventually(() => stack.ptys.every((p) => p.killed), 'the shell to be closed');
  });

  /*
   * Serializing a session's attaches bounded it to one in flight, but not the
   * line behind it: every socket that authenticated with the session's token
   * waited its turn with no timer — the auth grace is cleared once a token
   * verifies — and then ran a whole attach, a credential mint and a PTY, only
   * to be replaced by the next. Sixty sockets from one student were sixty
   * mints and sixty spawns one after another, and a Reset's reattach queued
   * behind them outlived the API's 20 s wait. The newest attach always wins,
   * so one waiting behind the running one is all a session ever needs.
   */
  it('keeps only the newest attach waiting, and closes the ones it replaces at once', async () => {
    const apiGate = gate();
    const stack = await bringUpStack({ [refFor(SESSION_A)]: snapshot(SESSION_A) }, { apiGate });

    const running = await authOnly(stack);
    const runningClosed = closeCode(running);
    await apiGate.reached(1);

    // Each is replaced by the next one's auth, so its close is listened for
    // before that auth is sent.
    const replacedClosed: Promise<number>[] = [];
    for (let i = 0; i < 20; i += 1) replacedClosed.push(closeCode(await authOnly(stack)));
    const newest = await authOnly(stack);
    const newestReady = frame(newest, ['ready', 'error']);

    // Closed while still waiting — before the attach ahead of them has moved.
    expect(new Set(await Promise.all(replacedClosed))).toEqual(new Set([4410]));
    expect(stack.credentialCalls()).toBe(1);

    apiGate.release();
    expect(await newestReady).toMatchObject({ type: 'ready', sandboxRef: refFor(SESSION_A) });
    expect(await runningClosed).toBe(4410);
    // The attach that was already running, and the newest: nothing in between
    // reached the API or the broker.
    expect(stack.credentialCalls()).toBe(2);
    expect(stack.ptys).toHaveLength(2);
  });

  it('a second socket arriving during the first one’s broker attach replaces it', async () => {
    const inspectGate = gate();
    const stack = await bringUpStack({ [refFor(SESSION_A)]: snapshot(SESSION_A) }, { inspectGate });

    const first = await authOnly(stack);
    const firstClosed = closeCode(first);
    await inspectGate.reached(1);

    // The same race one step later: the first attach is past the credentials
    // fetch and inside the broker's inspect when the second socket
    // authenticates. It still waits its turn, so the gate is stepped the same
    // way, and the second arrival is again the proof that it did.
    const second = await authOnly(stack);
    const secondReady = frame(second, ['ready', 'error']);
    inspectGate.releaseArrived();
    await inspectGate.reached(2);
    expect(stack.ptys).toHaveLength(1);
    inspectGate.release();

    expect(await secondReady).toMatchObject({ type: 'ready' });
    expect(await firstClosed).toBe(4410);

    // Both attaches reached the broker; the older one's PTY is closed again.
    await eventually(() => stack.ptys.length === 2 && stack.ptys.filter((p) => p.killed).length === 1, 'one PTY to be closed');
    const live = stack.ptys.filter((p) => !p.killed);
    expect(live).toHaveLength(1);
    second.send(JSON.stringify({ type: 'input', data: 'B\r' }));
    await eventually(() => live[0]!.written.includes('B\r'), 'input to reach the live shell');
  });

  it('a Terminate that lands while the shell is attaching opens no shell', async () => {
    const apiGate = gate();
    const stack = await bringUpStack({ [refFor(SESSION_A)]: snapshot(SESSION_A) }, { apiGate });

    const ws = await authOnly(stack);
    const outcome = frame(ws, ['error', 'ready']);
    const closed = closeCode(ws);
    await apiGate.reached(1);

    // End Lab, or the reaper, closing the session's terminal. There is no shell
    // yet — but there is an attach, and it is cancelled.
    expect(await terminate(stack, SESSION_A)).toEqual({ terminated: true });
    apiGate.release();

    expect(await outcome).toMatchObject({ type: 'error', code: 'SESSION_ENDED' });
    expect(await closed).toBe(4410);
    expect(stack.ptys).toHaveLength(0);
  });

  it('a Terminate that lands during the broker attach closes the PTY it opened', async () => {
    const inspectGate = gate();
    const stack = await bringUpStack({ [refFor(SESSION_A)]: snapshot(SESSION_A) }, { inspectGate });

    const ws = await authOnly(stack);
    const closed = closeCode(ws);
    await inspectGate.reached(1);
    expect(await terminate(stack, SESSION_A)).toEqual({ terminated: true });
    inspectGate.release();

    expect(await closed).toBe(4410);
    await eventually(() => stack.ptys.length === 1 && stack.ptys[0]!.killed, 'the PTY to be closed');
  });

  it('a cancelled attach does not stop the session attaching again', async () => {
    const apiGate = gate();
    const stack = await bringUpStack({ [refFor(SESSION_A)]: snapshot(SESSION_A) }, { apiGate });

    const ws = await authOnly(stack);
    const closed = closeCode(ws);
    await apiGate.reached(1);
    await terminate(stack, SESSION_A);
    apiGate.release();
    expect(await closed).toBe(4410);

    // Nothing is left claiming the session.
    expect(await terminate(stack, SESSION_A)).toEqual({ terminated: false });
    const { first } = await authenticate(stack.terminalUrl, tokenFor(SESSION_A, OWNER_A));
    expect(first).toMatchObject({ type: 'ready' });
    expect(stack.ptys).toHaveLength(1);
  });
});

describe('a reattach after a container reset, when the socket goes away meanwhile', () => {
  /*
   * A container reset recreates the sandbox and the API asks this service to
   * give the student's socket a fresh shell. That reattach waits on the API and
   * on the broker, and installed whatever the broker handed back without
   * looking at the socket again. A tab closed during a Reset — or an End
   * arriving then — had already run `endSession` for that socket, so the new
   * broker shell was wired to a closed socket and never closed: a PTY in the
   * student's container for the broker's idle timer, 30 minutes in compose.
   */

  async function reattach(stack: Stack, sessionId: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${stack.controlUrl}/internal/reattach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
      body: JSON.stringify({ sessionId }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Record<string, unknown> }).data;
  }

  it('closes the shell it opened instead of wiring it to a closed socket', async () => {
    const delays: Parameters<typeof bringUpStack>[1] = {};
    const stack = await bringUpStack({ [refFor(SESSION_A)]: snapshot(SESSION_A) }, delays);
    const { ws, first } = await authenticate(stack.terminalUrl, tokenFor(SESSION_A, OWNER_A));
    expect(first).toMatchObject({ type: 'ready' });
    expect(stack.ptys).toHaveLength(1);

    // The reattach's broker attach parks in the inspect.
    const inspectGate = gate();
    delays!.inspectGate = inspectGate;
    const reattaching = reattach(stack, SESSION_A);
    await inspectGate.reached(1);

    // The student closes the tab while the new shell is being opened.
    const closed = new Promise((resolve) => ws.on('close', resolve));
    ws.close(1000, 'tab closed');
    await closed;
    inspectGate.release();

    expect(await reattaching).toEqual({ reattached: false });
    // The broker opened the replacement shell; it is closed again, and so is
    // the original one.
    const deadline = Date.now() + 3_000;
    while (!(stack.ptys.length === 2 && stack.ptys.every((p) => p.killed)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(stack.ptys).toHaveLength(2);
    expect(stack.ptys.map((p) => p.killed)).toEqual([true, true]);
  });

  it('closes the socket when the new shell cannot be opened, so the browser reconnects', async () => {
    const containers = { [refFor(SESSION_A)]: snapshot(SESSION_A) };
    const stack = await bringUpStack(containers);
    const { ws, first } = await authenticate(stack.terminalUrl, tokenFor(SESSION_A, OWNER_A));
    expect(first).toMatchObject({ type: 'ready' });

    // The rebuilt sandbox is not there (yet): the broker refuses the attach.
    delete containers[refFor(SESSION_A)];
    const error = frame(ws, ['error']);
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    expect(await reattach(stack, SESSION_A)).toEqual({ reattached: false });

    // SANDBOX_UNAVAILABLE is one the workspace retries on disconnect; a socket
    // left open around a dead shell never disconnected, so it never retried.
    expect(await error).toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(await closed).toBe(1011);
    expect(stack.ptys.map((p) => p.killed)).toEqual([true]);
  });

  it('still hands a live socket its new shell', async () => {
    const stack = await bringUpStack({ [refFor(SESSION_A)]: snapshot(SESSION_A) });
    const { ws, first } = await authenticate(stack.terminalUrl, tokenFor(SESSION_A, OWNER_A));
    expect(first).toMatchObject({ type: 'ready' });

    const reattached = frame(ws, ['reattached']);
    expect(await reattach(stack, SESSION_A)).toEqual({ reattached: true });
    expect(await reattached).toMatchObject({ sandboxRef: refFor(SESSION_A) });
    expect(stack.ptys.map((p) => p.killed)).toEqual([true, false]);
  });
});
