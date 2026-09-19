/**
 * One shell per lab session, even when attaches race.
 *
 * A second connection for a session replaces the first: `startSession` closes
 * the existing shell before it attaches. That check ran *before* the
 * credentials fetch, so sockets that authenticated with the same token at the
 * same moment each found nothing to replace, each fetched credentials, and each
 * registered a shell. One student then held as many shells — and as many of the
 * terminal's shared `TERMINAL_MAX_SESSIONS` slots — as sockets they opened at
 * once, and End Lab could reach only the last one.
 *
 * Container sessions were already held to one shell by `sandboxd`, which
 * replaces a broker attach for the same session after its own await
 * (`broker-attach.test.ts`). A Kubernetes session's shell is spawned *here*,
 * with the session's kubeconfig, so nothing downstream deduplicated it. The PTY
 * is faked; everything else — the WebSocket, the token check, the credentials
 * exchange over HTTP, the kubeconfig file — is real.
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

const TERMINAL_SECRET = 'concurrent-attach-terminal-secret';
const INTERNAL_SECRET = 'concurrent-attach-internal-secret';
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
  credentialsDir = await mkdtemp(path.join(tmpdir(), 'jtt-concurrent-attach-creds-'));
  workspaceRoot = await mkdtemp(path.join(tmpdir(), 'jtt-concurrent-attach-ws-'));
});

afterAll(async () => {
  await rm(credentialsDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

afterEach(() => {
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

async function bringUp(options: { apiDelayMs: number; maxSessions?: number }): Promise<string> {
  const apiPort = await stubApi(options.apiDelayMs);
  const config = loadTerminalConfig({
    TERMINAL_SESSION_SECRET: TERMINAL_SECRET,
    INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
    API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
    TERMINAL_CREDENTIALS_DIR: credentialsDir,
    TERMINAL_WORKSPACE_ROOT: workspaceRoot,
    ALLOWED_ORIGINS: 'http://localhost:3000',
    ...(options.maxSessions ? { TERMINAL_MAX_SESSIONS: String(options.maxSessions) } : {}),
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

describe('one shell per session, even when attaches race', () => {
  it('keeps exactly one live shell when one token authenticates on many sockets at once', async () => {
    const url = await bringUp({ apiDelayMs: 300 });
    const token = tokenFor(SESSION_A, OWNER_A);
    const racers = await openSockets(url, 4);
    for (const ws of racers) ws.send(JSON.stringify({ type: 'auth', token, cols: 80, rows: 24 }));

    // Attaches for one session are taken in turn: four at 300 ms each.
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    expect(shells.filter((shell) => !shell.killed)).toHaveLength(1);
    expect(racers.filter((ws) => ws.readyState === WebSocket.OPEN)).toHaveLength(1);
    // The survivor's kubeconfig is still on disk: the replaced shells did not
    // take the file it shares with them when they were closed.
    expect(await readdir(credentialsDir)).toHaveLength(1);
  });

  it("cannot take another student's terminal slot by racing their own token", async () => {
    // Two slots: one student racing three sockets must still leave room for
    // a second student.
    const url = await bringUp({ apiDelayMs: 300, maxSessions: 2 });
    const tokenA = tokenFor(SESSION_A, OWNER_A);
    const racers = await openSockets(url, 3);
    for (const ws of racers) ws.send(JSON.stringify({ type: 'auth', token: tokenA, cols: 80, rows: 24 }));
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const [b] = await openSockets(url, 1);
    const ready = firstFrame(b!);
    b!.send(JSON.stringify({ type: 'auth', token: tokenFor(SESSION_B, OWNER_B), cols: 80, rows: 24 }));
    expect(await ready).toMatchObject({ type: 'ready', sessionId: SESSION_B });
  });

  it('still lets a later connection replace an established one (reconnect)', async () => {
    const url = await bringUp({ apiDelayMs: 50 });
    const token = tokenFor(SESSION_A, OWNER_A);
    const [first] = await openSockets(url, 1);
    const firstReady = firstFrame(first!);
    first!.send(JSON.stringify({ type: 'auth', token, cols: 80, rows: 24 }));
    expect(await firstReady).toMatchObject({ type: 'ready' });

    const [second] = await openSockets(url, 1);
    const secondReady = firstFrame(second!);
    second!.send(JSON.stringify({ type: 'auth', token, cols: 80, rows: 24 }));
    expect(await secondReady).toMatchObject({ type: 'ready' });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(first!.readyState).not.toBe(WebSocket.OPEN);
    expect(second!.readyState).toBe(WebSocket.OPEN);
    expect(shells.map((shell) => shell.killed)).toEqual([true, false]);
  });
});
