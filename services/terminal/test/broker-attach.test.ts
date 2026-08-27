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
import type { AddressInfo } from 'node:net';
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
import type { SandboxdConfig } from '@jumptotech/sandboxd/config';
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

function fakePty(): BrokerPty & { written: string[]; killed: boolean; emit(d: string): void } {
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
  ptys: ReturnType<typeof fakePty>[];
  argvs: string[][];
  /** Who the stub API says owns each session. */
  owners: Map<string, string>;
}

/**
 * A stub API, a real broker and a real terminal service.
 *
 * The stub API stands in for `/internal/sessions/:id/credentials`, and it
 * enforces the same ownership rule the real one does — that is the check the
 * cross-user tests below are exercising.
 */
async function bringUpStack(containers: Record<string, SandboxSnapshot>): Promise<Stack> {
  const owners = new Map<string, string>([
    [SESSION_A, OWNER_A],
    [SESSION_B, OWNER_B],
  ]);

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
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
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
    inspector: { inspect: async (ref) => containers[ref] ?? null },
    spawn: (_cmd, args) => {
      argvs.push(args);
      const p = fakePty();
      ptys.push(p);
      return p;
    },
    log: () => undefined,
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

  return { terminalUrl: `ws://127.0.0.1:${terminalPort}/terminal`, ptys, argvs, owners };
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

function frame(ws: WebSocket, types: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${types.join('/')} frame`)), 5000);
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
    await new Promise((r) => setTimeout(r, 80));
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
    await new Promise((r) => setTimeout(r, 100));
    expect(stack.ptys[0]!.written).toEqual(['A\r']);
    expect(stack.ptys[1]!.written).toEqual(['B\r']);

    // Closing A's shell leaves B's alone.
    a.ws.close();
    await new Promise((r) => setTimeout(r, 120));
    expect(stack.ptys[0]!.killed).toBe(true);
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
