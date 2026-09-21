/**
 * A reset's reattach takes its turn with every other attach of the session.
 *
 * It ran outside the per-session queue. Two reattaches that overlapped — the
 * api gives up on one after 20 s and the student resets again — each killed
 * the same old shell and each opened a new one; the first new shell was never
 * killed and, through the broker, sandboxd's
 * one-shell-per-session rule closed one of them, which the student saw as
 * "the shell exited". The broker attach is stubbed; the api answers slowly.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { issueSessionToken } from '@jumptotech/lab-orchestrator/session-token';

const shells = vi.hoisted(() => [] as Array<{ killed: boolean }>);

vi.mock('../src/shell.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shell.js')>();
  return {
    ...actual,
    // The broker's attach is a network round trip: slow enough for two
    // reattaches to be inside it at once.
    brokerShell: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const record = { killed: false };
      shells.push(record);
      return {
        sandboxRef: 'jtt-lab-aaaaaaaa',
        user: 'student',
        workdir: '/home/student',
        shell: {
          write: () => undefined,
          resize: () => undefined,
          kill: () => {
            record.killed = true;
          },
          pause: () => undefined,
          resume: () => undefined,
          onData: () => undefined,
          onExit: () => undefined,
        },
      };
    },
  };
});

const { loadTerminalConfig } = await import('../src/config.js');
const { createTerminalServer } = await import('../src/server.js');

const TERMINAL_SECRET = 'reattach-serial-terminal-secret';
const INTERNAL_SECRET = 'reattach-serial-internal-secret';
const SESSION = 'sess-aaaaaaaaaaaaaaaa';
const OWNER = 'usr-aaaa0001';

let root: string;
const servers: Server[] = [];
const sockets: WebSocket[] = [];
let apiDelayMs = 0;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jtt-reattach-serial-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const server of servers.splice(0)) server.close();
  shells.splice(0);
  apiDelayMs = 0;
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function post(port: number, pathname: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': INTERNAL_SECRET } },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

describe('two reattaches of one session at once', () => {
  it('leave exactly one live shell on the socket', async () => {
    const api = createServer((req, res) => {
      req.resume();
      req.on('end', () =>
        setTimeout(
          () =>
            res.writeHead(200, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                ok: true,
                data: {
                  kind: 'container-exec',
                  runtime: 'docker',
                  containerRef: 'jtt-lab-aaaaaaaa',
                  user: 'student',
                  workdir: '/home/student',
                  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                },
              }),
            ),
          apiDelayMs,
        ),
      );
    });
    const apiPort = await listen(api);
    const config = loadTerminalConfig({
      TERMINAL_SESSION_SECRET: TERMINAL_SECRET,
      INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
      TERMINAL_WORKSPACE_ROOT: path.join(root, 'ws'),
      TERMINAL_CREDENTIALS_DIR: path.join(root, 'creds'),
      ALLOWED_ORIGINS: 'http://localhost:3000',
      API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
      SANDBOX_BROKER_URL: 'http://127.0.0.1:9',
      SANDBOXD_ATTACH_SECRET: `${INTERNAL_SECRET}-attach`,
      TERMINAL_SANDBOX_BROKER_ENABLED: 'true',
      TERMINAL_CONTAINER_EXEC_ENABLED: 'false',
    } as NodeJS.ProcessEnv);
    const port = await listen(createTerminalServer(config));
    const { token } = issueSessionToken({
      sessionId: SESSION,
      ownerUserId: OWNER,
      labId: 'LINUX-001',
      namespace: 'jtt-lab-aaaaaaaa',
      secret: TERMINAL_SECRET,
      ttlSeconds: 3600,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal`, { origin: 'http://localhost:3000' });
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
      ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as { type: string; code?: string };
        if (frame.type === 'ready') resolve();
        if (frame.type === 'error') reject(new Error(frame.code));
      });
    });
    expect(shells).toHaveLength(1);

    apiDelayMs = 200;
    const [first, second] = await Promise.all([
      post(port, '/internal/reattach', { sessionId: SESSION }),
      post(port, '/internal/reattach', { sessionId: SESSION }),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(JSON.parse(first.body).data.reattached || JSON.parse(second.body).data.reattached).toBe(true);
    expect(shells).toHaveLength(3);

    expect(shells.filter((shell) => !shell.killed)).toHaveLength(1);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});
