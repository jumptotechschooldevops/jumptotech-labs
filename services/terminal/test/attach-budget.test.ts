/**
 * How often one student may open a terminal.
 *
 * Every attach is a credentials exchange with the API — a ServiceAccount token
 * minted, or a sandbox's client certificates read with `docker exec` — and a
 * shell. Attaches for one session were already taken in turn, but nothing
 * bounded how many: one valid token on a connect-authenticate-close loop drove
 * about 60 a second through this service. The PTY is faked; the WebSocket, the
 * token check and the credentials exchange over HTTP are real.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { issueSessionToken } from '@jumptotech/lab-orchestrator/session-token';

interface FakeShell {
  killed: boolean;
  written: string[];
}
const shells: FakeShell[] = [];
let credentialCalls = 0;

vi.mock('../src/shell.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shell.js')>();
  return {
    ...actual,
    localShell: () => {
      const record: FakeShell = { killed: false, written: [] };
      shells.push(record);
      return {
        write: (data: string) => record.written.push(data),
        resize: () => undefined,
        kill: () => {
          record.killed = true;
        },
        onData: () => undefined,
        onExit: () => undefined,
      };
    },
  };
});

const { loadTerminalConfig } = await import('../src/config.js');
const { createTerminalServer } = await import('../src/server.js');
const { AttachBudget, DEFAULT_ATTACH_BUDGET } = await import('../src/attach-budget.js');

const TERMINAL_SECRET = 'attach-budget-terminal-secret';
const INTERNAL_SECRET = 'attach-budget-internal-secret';
const OWNER_A = 'usr-aaaa0001';
const OWNER_B = 'usr-bbbb0002';
const SESSION_A = 'sess-aaaaaaaaaaaaaaaa';
const SESSION_B = 'sess-bbbbbbbbbbbbbbbb';
const OWNERS = new Map([
  [SESSION_A, OWNER_A],
  [SESSION_B, OWNER_B],
]);

let credentialsDir: string;
let workspaceRoot: string;
const servers: Server[] = [];
const sockets: WebSocket[] = [];

beforeAll(async () => {
  credentialsDir = await mkdtemp(path.join(tmpdir(), 'jtt-attach-budget-creds-'));
  workspaceRoot = await mkdtemp(path.join(tmpdir(), 'jtt-attach-budget-ws-'));
});

afterAll(async () => {
  await rm(credentialsDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

afterEach(() => {
  credentialCalls = 0;
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const server of servers.splice(0)) server.close();
  shells.splice(0);
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** A stub API answering the credentials exchange with a Kubernetes binding, slowly. */
async function stubApi(delayMs: number): Promise<number> {
  const api = createServer((req, res) => {
    const match = /^\/internal\/sessions\/(sess-[0-9a-f]+)\/credentials$/.exec(req.url ?? '');
    if (!match || req.method !== 'POST' || req.headers['x-internal-secret'] !== INTERNAL_SECRET) {
      res.writeHead(404).end('{}');
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      credentialCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const claimed = (JSON.parse(body || '{}') as { ownerUserId?: string }).ownerUserId;
      if (OWNERS.get(match[1]!) !== claimed) {
        res.writeHead(403, { 'content-type': 'application/json' }).end(
          JSON.stringify({ ok: false, error: { code: 'SESSION_NOT_OWNED', message: 'not yours' } }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          ok: true,
          data: {
            kind: 'kubernetes',
            kubeconfig: 'apiVersion: v1\nkind: Config\n',
            namespace: 'lab-aaaaaaaaaaaa',
            serviceAccountName: 'student',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      );
    });
  });
  return listen(api);
}

async function bringUp(options: { apiDelayMs: number; maxSessions?: number; burst?: number }): Promise<string> {
  const apiPort = await stubApi(options.apiDelayMs);
  const config = loadTerminalConfig({
    TERMINAL_SESSION_SECRET: TERMINAL_SECRET,
    INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
    API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
    TERMINAL_CREDENTIALS_DIR: credentialsDir,
    TERMINAL_WORKSPACE_ROOT: workspaceRoot,
    ALLOWED_ORIGINS: 'http://localhost:3000',
    ...(options.maxSessions ? { TERMINAL_MAX_SESSIONS: String(options.maxSessions) } : {}),
    ...(options.burst ? { TERMINAL_ATTACH_BURST: String(options.burst), TERMINAL_ATTACHES_PER_MINUTE: '1' } : {}),
  } as NodeJS.ProcessEnv);
  const port = await listen(createTerminalServer(config));
  return `ws://127.0.0.1:${port}/terminal`;
}

function tokenFor(sessionId: string, ownerUserId: string): string {
  return issueSessionToken({
    sessionId,
    ownerUserId,
    labId: 'K8S-001',
    namespace: 'lab-aaaaaaaaaaaa',
    secret: TERMINAL_SECRET,
    ttlSeconds: 60,
  }).token;
}

async function openSockets(url: string, count: number): Promise<WebSocket[]> {
  return Promise.all(
    Array.from({ length: count }, async () => {
      const ws = new WebSocket(url);
      sockets.push(ws);
      await new Promise((resolve) => ws.on('open', resolve));
      return ws;
    }),
  );
}

function firstFrame(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no ready/error frame')), 5_000);
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      if (message.type !== 'ready' && message.type !== 'error') return;
      clearTimeout(timer);
      resolve(message);
    });
  });
}


/** Authenticate one new socket and wait for the first `ready` or `error`, and the close code if it closes. */
async function attach(url: string, token: string): Promise<{ frame: Record<string, unknown>; ws: WebSocket; closed: Promise<number> }> {
  const [ws] = await openSockets(url, 1);
  const closed = new Promise<number>((resolve) => ws!.on('close', (code) => resolve(code)));
  const frame = firstFrame(ws!);
  ws!.send(JSON.stringify({ type: 'auth', token, cols: 80, rows: 24 }));
  return { frame: await frame, ws: ws!, closed };
}

describe('the attach budget', () => {
  it('allows a burst, then refuses until it refills', () => {
    let now = 0;
    const budget = new AttachBudget({ burst: 3, perMinute: 6, now: () => now });
    expect([budget.spend('usr-a'), budget.spend('usr-a'), budget.spend('usr-a')]).toEqual([true, true, true]);
    expect(budget.spend('usr-a')).toBe(false);
    // Six a minute is one every ten seconds.
    now += 9_000;
    expect(budget.spend('usr-a')).toBe(false);
    now += 1_000;
    expect(budget.spend('usr-a')).toBe(true);
    expect(budget.spend('usr-a')).toBe(false);
  });

  it('is kept per student', () => {
    const budget = new AttachBudget({ burst: 1, perMinute: 1, now: () => 0 });
    expect(budget.spend('usr-a')).toBe(true);
    expect(budget.spend('usr-a')).toBe(false);
    expect(budget.spend('usr-b')).toBe(true);
  });

  it('forgets a student whose budget has refilled', () => {
    let now = 0;
    const budget = new AttachBudget({ burst: 2, perMinute: 60, now: () => now });
    budget.spend('usr-a');
    budget.spend('usr-b');
    expect(budget.size).toBe(2);
    now += 1_000;
    budget.spend('usr-c');
    expect(budget.size).toBe(1);
  });

  it('defaults far above what the browser does on its own', () => {
    // The workspace retries six times over about a minute (AUTO_RECONNECTS).
    expect(DEFAULT_ATTACH_BUDGET.burst).toBeGreaterThanOrEqual(20);
    const config = loadTerminalConfig({
      TERMINAL_SESSION_SECRET: TERMINAL_SECRET,
      INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
    } as NodeJS.ProcessEnv);
    expect(config.attachBudget).toEqual({ burst: DEFAULT_ATTACH_BUDGET.burst, perMinute: DEFAULT_ATTACH_BUDGET.perMinute });
  });

  it('refuses a budget that is not a positive integer', () => {
    for (const value of ['0', '-1', '2.5', 'many']) {
      expect(() =>
        loadTerminalConfig({
          TERMINAL_SESSION_SECRET: TERMINAL_SECRET,
          INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
          TERMINAL_ATTACH_BURST: value,
        } as NodeJS.ProcessEnv),
      ).toThrow(/TERMINAL_ATTACH_BURST/);
    }
  });
});

describe('one student cannot turn a token into unbounded attaches', () => {
  it('refuses an attach over budget before any credentials exchange, and keeps the live shell', async () => {
    const url = await bringUp({ apiDelayMs: 0, burst: 3 });
    const token = tokenFor(SESSION_A, OWNER_A);

    let live: WebSocket | undefined;
    for (let i = 0; i < 3; i += 1) {
      const { frame, ws } = await attach(url, token);
      expect(frame).toMatchObject({ type: 'ready', sessionId: SESSION_A });
      live = ws;
    }
    expect(credentialCalls).toBe(3);

    const refused = await attach(url, token);
    expect(refused.frame).toMatchObject({ type: 'error', code: 'ATTACH_RATE_LIMITED' });
    expect(await refused.closed).toBe(4429);
    // Refused before the API was asked for anything, or a shell was opened.
    expect(credentialCalls).toBe(3);
    expect(shells).toHaveLength(3);

    // …and before it could replace the student's working shell.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(live!.readyState).toBe(WebSocket.OPEN);
    expect(shells.filter((shell) => !shell.killed)).toHaveLength(1);
  });

  it("does not spend another student's budget", async () => {
    const url = await bringUp({ apiDelayMs: 0, burst: 1 });
    expect((await attach(url, tokenFor(SESSION_A, OWNER_A))).frame).toMatchObject({ type: 'ready' });
    expect((await attach(url, tokenFor(SESSION_A, OWNER_A))).frame).toMatchObject({ code: 'ATTACH_RATE_LIMITED' });
    expect((await attach(url, tokenFor(SESSION_B, OWNER_B))).frame).toMatchObject({
      type: 'ready',
      sessionId: SESSION_B,
    });
  });

  it('counts a refused token as nothing: a forged or expired one spends no budget', async () => {
    const url = await bringUp({ apiDelayMs: 0, burst: 1 });
    const expired = issueSessionToken({
      sessionId: SESSION_A,
      ownerUserId: OWNER_A,
      labId: 'K8S-001',
      namespace: 'lab-aaaaaaaaaaaa',
      secret: TERMINAL_SECRET,
      ttlSeconds: 60,
      now: () => Date.now() - 120_000,
    }).token;
    for (let i = 0; i < 3; i += 1) {
      expect((await attach(url, expired)).frame).toMatchObject({ type: 'error', code: 'UNAUTHORIZED' });
    }
    expect((await attach(url, tokenFor(SESSION_A, OWNER_A))).frame).toMatchObject({ type: 'ready' });
  });

  it('bounds a connect-authenticate-close loop', async () => {
    const url = await bringUp({ apiDelayMs: 0, burst: 5 });
    const token = tokenFor(SESSION_A, OWNER_A);
    for (let i = 0; i < 25; i += 1) {
      const { ws } = await attach(url, token);
      ws.close();
    }
    expect(credentialCalls).toBe(5);
  });
});
