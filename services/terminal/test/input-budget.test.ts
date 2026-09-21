/**
 * Input to a shell is bounded, as output already was.
 *
 * A PTY whose reader has stopped accepts nothing, and node-pty queues what it
 * is given without limit — here, and in sandboxd behind the broker socket. A
 * student flooding `input` frames from devtools grew either process by
 * 150 MiB in seconds. The shell stub below records how much reached it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { issueSessionToken } from '@jumptotech/lab-orchestrator/session-token';
import { InputBudget } from '../src/input-budget.js';

const written = vi.hoisted(() => ({ bytes: 0, killed: 0 }));

vi.mock('../src/shell.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shell.js')>();
  return {
    ...actual,
    localShell: () => ({
      write: (data: string) => {
        written.bytes += Buffer.byteLength(data);
      },
      resize: () => undefined,
      kill: () => {
        written.killed += 1;
      },
      onData: () => undefined,
      onExit: () => undefined,
    }),
  };
});

const { loadTerminalConfig } = await import('../src/config.js');
const { createTerminalServer } = await import('../src/server.js');

describe('InputBudget', () => {
  it('accepts a burst, refills at its rate, and refuses what exceeds both', () => {
    let now = 0;
    const budget = new InputBudget({ burstBytes: 1000, bytesPerSecond: 100, now: () => now });
    expect(budget.spend(1000)).toBe(true);
    expect(budget.spend(1)).toBe(false);
    now += 500;
    expect(budget.spend(50)).toBe(true);
    expect(budget.spend(1)).toBe(false);
    now += 60_000;
    // Never more than the burst, however long the socket was quiet.
    expect(budget.spend(1001)).toBe(false);
    expect(budget.spend(1000)).toBe(true);
  });
});

const TERMINAL_SECRET = 'input-budget-terminal-secret';
const INTERNAL_SECRET = 'input-budget-internal-secret';
const SESSION = 'sess-aaaaaaaaaaaaaaaa';
const OWNER = 'usr-aaaa0001';

let root: string;
const servers: Server[] = [];
const sockets: WebSocket[] = [];

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jtt-input-budget-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const server of servers.splice(0)) server.close();
  written.bytes = 0;
  written.killed = 0;
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** An attached socket, and every frame the server sends it. */
async function attached() {
  const api = createServer((req, res) => {
    req.resume();
    req.on('end', () =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          ok: true,
          data: {
            kind: 'docker-daemon',
            dockerHost: 'tcp://jtt-lab-abcdef:2376',
            ca: 'CA',
            clientCert: 'CERT',
            clientKey: 'KEY',
            sandboxRef: 'jtt-lab-abcdef',
            workspaceFiles: [],
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        }),
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
  } as NodeJS.ProcessEnv);
  const port = await listen(createTerminalServer(config));
  const { token } = issueSessionToken({
    sessionId: SESSION,
    ownerUserId: OWNER,
    labId: 'DOCKER-013',
    namespace: 'jtt-lab-abcdef',
    secret: TERMINAL_SECRET,
    ttlSeconds: 3600,
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal`, { origin: 'http://localhost:3000' });
  sockets.push(ws);
  const frames: Array<{ type: string; code?: string }> = [];
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { type: string; code?: string };
      frames.push(frame);
      if (frame.type === 'ready') resolve();
      if (frame.type === 'error') reject(new Error(frame.code));
    });
  });
  return { ws, frames, closed };
}

const CHUNK = 'x'.repeat(8 * 1024);

describe('a terminal socket', () => {
  it('takes a large paste', async () => {
    const { ws, frames } = await attached();
    for (let i = 0; i < 24; i += 1) ws.send(JSON.stringify({ type: 'input', data: CHUNK }));
    await vi.waitFor(() => expect(written.bytes).toBe(24 * CHUNK.length));
    expect(frames.some((frame) => frame.type === 'error')).toBe(false);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('is closed, and its shell killed, when it floods input — not queued without end', async () => {
    const { ws, frames, closed } = await attached();
    for (let i = 0; i < 2_000; i += 1) ws.send(JSON.stringify({ type: 'input', data: CHUNK }));
    expect(await closed).toBe(4408);
    expect(frames).toContainEqual(expect.objectContaining({ type: 'error', code: 'INPUT_RATE_EXCEEDED' }));
    expect(written.killed).toBeGreaterThan(0);
    // The burst, and nothing like the 16 MiB sent.
    expect(written.bytes).toBeLessThanOrEqual(300 * 1024);
  });
});
