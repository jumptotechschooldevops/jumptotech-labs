/**
 * The browser is told what failed, not what the platform's internals said.
 *
 * The terminal writes a refused attach's message into the student's terminal
 * (`LabTerminal.tsx`). Two of those messages were other components' own
 * words: a credential exchange the API could not complete carries the
 * provider's error (a Kubernetes API URL, `docker` stderr), and a broker that
 * could not be reached carried Node's socket error with the broker's address.
 * The code still travels; the words are ours, and the originals stay in this
 * service's log.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { issueSessionToken } from '@jumptotech/lab-orchestrator/session-token';
import { loadTerminalConfig } from '../src/config.js';
import { createTerminalServer } from '../src/server.js';

const TERMINAL_SECRET = 'error-disclosure-terminal-secret';
const INTERNAL_SECRET = 'error-disclosure-internal-secret';
const SESSION = 'sess-0123456789abcdef';
const OWNER = 'usr-0000000d';
const RAW = 'request to https://jumptotech-labs-control-plane:6443/api/v1/namespaces failed, reason: connect ECONNREFUSED 172.18.0.2:6443';

const servers: Server[] = [];
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const server of servers.splice(0)) server.close();
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** A stub API that answers the credential exchange with `respond`. */
async function stubApi(respond: (res: import('node:http').ServerResponse) => void): Promise<number> {
  return listen(
    createServer((req, res) => {
      req.resume();
      req.on('end', () => respond(res));
    }),
  );
}

async function terminal(apiPort: number, env: Record<string, string> = {}): Promise<string> {
  const config = loadTerminalConfig({
    TERMINAL_SESSION_SECRET: TERMINAL_SECRET,
    INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
    API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
    ALLOWED_ORIGINS: 'http://localhost:3000',
    ...env,
  } as NodeJS.ProcessEnv);
  const port = await listen(createTerminalServer(config));
  return `ws://127.0.0.1:${port}/terminal`;
}

async function firstError(url: string): Promise<Record<string, unknown>> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  await new Promise((resolve) => ws.on('open', resolve));
  const frame = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no error frame')), 20_000);
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      if (message.type !== 'error') return;
      clearTimeout(timer);
      resolve(message);
    });
  });
  const { token } = issueSessionToken({
    sessionId: SESSION,
    ownerUserId: OWNER,
    labId: 'LINUX-001',
    namespace: 'jtt-lab-aaaaaaaa',
    secret: TERMINAL_SECRET,
    ttlSeconds: 60,
  });
  ws.send(JSON.stringify({ type: 'auth', token, cols: 80, rows: 24 }));
  return frame;
}

describe("a refused attach tells the browser the code and the platform's words", () => {
  it('when the credential exchange fails in the provider', async () => {
    const api = await stubApi((res) =>
      res
        .writeHead(503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: false, error: { code: 'CREDENTIALS_UNAVAILABLE', message: RAW } })),
    );
    const frame = await firstError(await terminal(api));
    expect(frame.code).toBe('CREDENTIALS_UNAVAILABLE');
    expect(String(frame.message)).not.toMatch(/control-plane|172\.18|ECONNREFUSED|6443/);
  });

  it('when the runtime broker cannot be reached', async () => {
    const api = await stubApi((res) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          ok: true,
          data: {
            kind: 'container-exec',
            runtime: 'docker',
            containerRef: 'jtt-lab-aaaaaaaa',
            user: 'student',
            workdir: '/home/student',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      ),
    );
    // A port nothing listens on: the connect is refused, with the address in
    // Node's own message.
    const closed = await listen(createServer());
    servers.pop()!.close();
    const frame = await firstError(
      await terminal(api, {
        SANDBOX_BROKER_URL: `http://127.0.0.1:${closed}`,
        SANDBOXD_ATTACH_SECRET: `${INTERNAL_SECRET}-attach`,
        TERMINAL_SANDBOX_BROKER_ENABLED: 'true',
        TERMINAL_CONTAINER_EXEC_ENABLED: 'false',
      }),
    );
    expect(frame.code).toBe('BROKER_UNREACHABLE');
    expect(String(frame.message)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|:\d{2,5}/);
  });

  it("still forwards the platform's own refusal, which is what the student needs", async () => {
    const api = await stubApi((res) =>
      res.writeHead(409, { 'content-type': 'application/json' }).end(
        JSON.stringify({ ok: false, error: { code: 'SESSION_NOT_ACTIVE', message: 'This lab session is DEGRADED, not ACTIVE.' } }),
      ),
    );
    const frame = await firstError(await terminal(api));
    expect(frame).toMatchObject({ code: 'SESSION_NOT_ACTIVE', message: 'This lab session is DEGRADED, not ACTIVE.' });
  });

  it('forwards a lab-access refusal, so a student whose access ended is told so', async () => {
    const api = await stubApi((res) =>
      res.writeHead(403, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          ok: false,
          error: { code: 'ACCESS_NOT_ACTIVE', message: 'Your lab access has ended.', details: { accessState: 'EXPIRED' } },
        }),
      ),
    );
    const frame = await firstError(await terminal(api));
    expect(frame).toMatchObject({ code: 'ACCESS_NOT_ACTIVE', message: 'Your lab access has ended.' });
  });
});
