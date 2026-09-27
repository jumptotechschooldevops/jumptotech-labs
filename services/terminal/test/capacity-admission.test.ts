/**
 * `TERMINAL_MAX_SESSIONS` binds when a class attaches at once.
 *
 * The ceiling exists because every shell costs a PTY (or a broker socket) and
 * up to a megabyte of buffered output and input before flow control pauses it,
 * inside a container capped at 512 MiB. It was checked once, on `connection`,
 * against `sessions.size` — the shells that already exist. Attaching is not
 * instant: the credentials exchange is one HTTP call to the API (10 s
 * deadline) and a container attach is a broker WebSocket (15 s). Sockets that
 * arrive together therefore all passed the check while the count was still
 * low, and each went on to register a shell.
 *
 * That is precisely the shape of the burst the ceiling exists for: twenty
 * students pressing Start when a class begins, or reconnecting together after
 * a terminal restart.
 *
 * Invariant: at most `maxSessions` shells exist at any moment, whatever the
 * arrival pattern. The check stays *after* authentication — counting sockets
 * that never present a token would let anyone fill the ceiling by opening
 * connections and saying nothing — and a session that already holds a shell is
 * replacing it, not taking a second slot, so a reconnect does not spend one.
 *
 * The earlier check on `connection` is unchanged: a socket opened while the
 * terminal is already full is still refused before it authenticates.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { issueSessionToken } from '@jumptotech/lab-orchestrator/session-token';

interface FakeShell {
  killed: boolean;
}
const shells: FakeShell[] = [];

vi.mock('../src/shell.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shell.js')>();
  return {
    ...actual,
    localShell: () => {
      const record: FakeShell = { killed: false };
      shells.push(record);
      return {
        write: () => undefined,
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

const TERMINAL_SECRET = 'capacity-admission-terminal-secret';
const INTERNAL_SECRET = 'capacity-admission-internal-secret';

/** One student, one session, one owner. */
function student(index: number): { sessionId: string; ownerUserId: string } {
  const suffix = index.toString(16).padStart(4, '0');
  return { sessionId: `sess-aaaaaaaaaaaa${suffix}`, ownerUserId: `usr-bbbbbbbb${suffix}` };
}

let credentialsDir: string;
let workspaceRoot: string;
const servers: Server[] = [];
const sockets: WebSocket[] = [];

beforeAll(async () => {
  credentialsDir = await mkdtemp(path.join(tmpdir(), 'jtt-capacity-creds-'));
  workspaceRoot = await mkdtemp(path.join(tmpdir(), 'jtt-capacity-ws-'));
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

/** The API's credentials exchange, answering every session after `delayMs`. */
async function stubApi(delayMs: number): Promise<number> {
  const api = createServer((req, res) => {
    const match = /^\/internal\/sessions\/(sess-[0-9a-f]+)\/credentials$/.exec(req.url ?? '');
    if (!match || req.method !== 'POST' || req.headers['x-internal-secret'] !== INTERNAL_SECRET) {
      res.writeHead(404).end('{}');
      return;
    }
    req.on('data', () => undefined);
    req.on('end', () => {
      setTimeout(() => {
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
      }, delayMs);
    });
  });
  return listen(api);
}

async function bringUp(options: { apiDelayMs: number; maxSessions: number }): Promise<string> {
  const apiPort = await stubApi(options.apiDelayMs);
  const config = loadTerminalConfig({
    TERMINAL_SESSION_SECRET: TERMINAL_SECRET,
    INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
    API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
    TERMINAL_CREDENTIALS_DIR: credentialsDir,
    TERMINAL_WORKSPACE_ROOT: workspaceRoot,
    ALLOWED_ORIGINS: 'http://localhost:3000',
    TERMINAL_MAX_SESSIONS: String(options.maxSessions),
  } as NodeJS.ProcessEnv);
  const port = await listen(createTerminalServer(config));
  return `ws://127.0.0.1:${port}/terminal`;
}

function tokenFor(who: { sessionId: string; ownerUserId: string }): string {
  return issueSessionToken({
    sessionId: who.sessionId,
    ownerUserId: who.ownerUserId,
    labId: 'K8S-001',
    namespace: 'lab-aaaaaaaaaaaa',
    secret: TERMINAL_SECRET,
    ttlSeconds: 60,
  }).token;
}

/** Open one socket and return the first `ready` or `error` frame it is sent. */
async function attach(url: string, who: { sessionId: string; ownerUserId: string }) {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const frame = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no ready/error frame')), 10_000);
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      if (message.type !== 'ready' && message.type !== 'error') return;
      clearTimeout(timer);
      resolve(message);
    });
    ws.on('close', () => setTimeout(() => reject(new Error('closed with no frame')), 50));
  });
  await new Promise((resolve) => ws.on('open', resolve));
  ws.send(JSON.stringify({ type: 'auth', token: tokenFor(who), cols: 80, rows: 24 }));
  return frame;
}

const live = () => shells.filter((shell) => !shell.killed).length;

describe('the terminal session ceiling under a simultaneous class', () => {
  it('never opens more shells than TERMINAL_MAX_SESSIONS, however many attach at once', async () => {
    const MAX = 4;
    const url = await bringUp({ apiDelayMs: 300, maxSessions: MAX });

    // Twelve students, twelve distinct sessions, all authenticating together —
    // every one of them inside the credentials exchange at the same moment.
    const frames = await Promise.all(
      Array.from({ length: 12 }, (_, i) => attach(url, student(i))),
    );

    const ready = frames.filter((frame) => frame.type === 'ready');
    const refused = frames.filter((frame) => frame.code === 'CAPACITY');

    expect(live()).toBeLessThanOrEqual(MAX);
    expect(ready).toHaveLength(MAX);
    expect(refused).toHaveLength(12 - MAX);
  }, 30_000);

  it('does not spend a second slot on a reconnect racing another student', async () => {
    const MAX = 2;
    const url = await bringUp({ apiDelayMs: 300, maxSessions: MAX });

    expect(await attach(url, student(1))).toMatchObject({ type: 'ready' });
    expect(live()).toBe(1);

    // One student reconnecting while another attaches, both in flight at once.
    // The reconnect replaces a shell rather than adding one, so counting it
    // against the ceiling would refuse the second student for no reason.
    const [again, second] = await Promise.all([
      attach(url, student(1)),
      attach(url, student(2)),
    ]);

    expect(again).toMatchObject({ type: 'ready' });
    expect(second).toMatchObject({ type: 'ready' });
    expect(live()).toBe(MAX);
  }, 30_000);
});
