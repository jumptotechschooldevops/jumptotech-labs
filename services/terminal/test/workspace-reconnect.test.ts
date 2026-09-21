/**
 * A reconnect keeps the student's work.
 *
 * Every attach of a Docker session seeds its workspace, because `docker build`
 * needs the baseline files there before the shell opens. It used to *restore*
 * them: a page reload, a second tab, the automatic reconnect after a network
 * blip — each wrote the lab's baseline Dockerfile back over the one the student
 * had spent the lab editing, and Check then graded the baseline. A file the
 * student had made read-only, or a directory at a baseline path, went further
 * and failed the attach outright, for good.
 *
 * The real server, with the shell stubbed and a stub API answering the
 * credential exchange with a docker-daemon binding.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { issueSessionToken } from '@jumptotech/lab-orchestrator/session-token';

vi.mock('../src/shell.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shell.js')>();
  return {
    ...actual,
    localShell: () => ({
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      onData: () => undefined,
      onExit: () => undefined,
    }),
  };
});

const { loadTerminalConfig } = await import('../src/config.js');
const { createTerminalServer } = await import('../src/server.js');
const { workspaceDirFor } = await import('../src/workspace.js');

const TERMINAL_SECRET = 'workspace-reconnect-terminal-secret';
const INTERNAL_SECRET = 'workspace-reconnect-internal-secret';
const OWNER = 'usr-aaaa0001';
const SESSION = 'sess-aaaaaaaaaaaaaaaa';
const BASELINE = 'FROM alpine:3.20\nCOPY . /app\n';

let root: string;
const servers: Server[] = [];
const sockets: WebSocket[] = [];

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jtt-workspace-reconnect-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const server of servers.splice(0)) server.close();
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function harness() {
  const api = createServer((req, res) => {
    if (req.headers['x-internal-secret'] !== INTERNAL_SECRET || !req.url?.endsWith('/credentials')) {
      res.writeHead(404).end('{}');
      return;
    }
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
            workspaceFiles: [
              { path: 'Dockerfile', content: BASELINE },
              { path: 'src/app.sh', content: 'echo baseline\n' },
            ],
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
    TERMINAL_WORKSPACE_ROOT: path.join(root, `ws-${servers.length}`),
    TERMINAL_CREDENTIALS_DIR: path.join(root, `creds-${servers.length}`),
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
  const dir = workspaceDirFor(config.workspaceRoot, SESSION, config.sessionSecret);

  /** Attach, and resolve with the first frame that says how it went. */
  const attach = async (): Promise<{ type: string; code?: string }> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal`, { origin: 'http://localhost:3000' });
    sockets.push(ws);
    const outcome = await new Promise<{ type: string; code?: string }>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
      ws.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as { type: string; code?: string };
        if (message.type === 'ready' || message.type === 'error') resolve(message);
      });
      ws.on('error', reject);
    });
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return outcome;
  };
  return { attach, dir };
}

describe('a reconnect of a Docker session', () => {
  it('keeps the student’s edited files, and still creates a baseline file that is missing', async () => {
    const { attach, dir } = await harness();
    expect((await attach()).type).toBe('ready');
    expect(await readFile(path.join(dir, 'Dockerfile'), 'utf8')).toBe(BASELINE);

    await writeFile(path.join(dir, 'Dockerfile'), 'FROM alpine:3.20\nCOPY src /app/src\n');
    await rm(path.join(dir, 'src'), { recursive: true });

    expect((await attach()).type).toBe('ready');
    expect(await readFile(path.join(dir, 'Dockerfile'), 'utf8')).toBe('FROM alpine:3.20\nCOPY src /app/src\n');
    expect(await readFile(path.join(dir, 'src/app.sh'), 'utf8')).toBe('echo baseline\n');
  });

  it('still attaches when the student made a baseline file read-only or put a file where a directory was', async () => {
    const { attach, dir } = await harness();
    expect((await attach()).type).toBe('ready');

    await chmod(path.join(dir, 'Dockerfile'), 0o444);
    await rm(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'src'), 'not a directory\n');

    expect((await attach()).type).toBe('ready');
    expect(await readFile(path.join(dir, 'src'), 'utf8')).toBe('not a directory\n');
    await chmod(path.join(dir, 'Dockerfile'), 0o644);
  });
});
