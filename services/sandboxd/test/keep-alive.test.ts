/**
 * The broker holds an idle keep-alive socket well past the time it tells
 * clients to stop reusing it (src/keep-alive.ts).
 *
 * The failure it prevents: the api reused a pooled socket 4.1–5.08 s after its
 * last answer on a loaded host, the broker's 6 s keep-alive deadline (5 s +
 * Node's 1 s buffer) destroyed the socket with the request unread, and the
 * Start or Reset failed as `fetch failed (ECONNRESET) during 'exec'`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADVERTISED_KEEP_ALIVE_MS, KEEP_ALIVE_GRACE_MS, applyKeepAlivePolicy } from '../src/keep-alive.js';

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  );
});

async function broker(policy: boolean): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  if (policy) applyKeepAlivePolicy(server);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

const REQUEST = 'POST /v1/runtime HTTP/1.1\r\nHost: sandboxd\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}';

/** One request on an open socket: the status line of the answer, or how the socket ended instead. */
function exchange(socket: Socket): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const done = (outcome: string): void => {
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onError);
      resolve(outcome);
    };
    const onData = (chunk: Buffer): void => {
      data += chunk.toString('latin1');
      if (data.includes('{"ok":true}')) done(data.split('\r\n')[0]!);
    };
    const onClose = (): void => done('closed');
    const onError = (error: NodeJS.ErrnoException): void => done(error.code ?? 'error');
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onError);
    socket.write(REQUEST);
  });
}

/** A keep-alive socket reused `idleMs` after its first answer, as a pooled fetch would. */
async function reuseAfter(port: number, idleMs: number): Promise<{ first: string; second: string }> {
  const socket = connect(port, '127.0.0.1');
  sockets.push(socket);
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  const first = await exchange(socket);
  await new Promise((resolve) => setTimeout(resolve, idleMs));
  const second = socket.destroyed ? 'closed' : await exchange(socket);
  return { first, second };
}

describe('the broker keep-alive policy', () => {
  it('still advertises 5 s, so a pooled client keeps idling for 4 s', async () => {
    const { port } = await broker(true);
    const res = await fetch(`http://127.0.0.1:${port}/v1/runtime`, { method: 'POST', body: '{}' });
    await res.text();
    expect(res.headers.get('keep-alive')).toBe(`timeout=${ADVERTISED_KEEP_ALIVE_MS / 1000}`);
  });

  it('holds the idle socket for 60 s on the server side', async () => {
    const { server, port } = await broker(true);
    let serverSide: Socket | undefined;
    server.on('connection', (socket) => (serverSide = socket));
    await (await fetch(`http://127.0.0.1:${port}/v1/runtime`, { method: 'POST', body: '{}' })).text();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(serverSide?.timeout).toBe(ADVERTISED_KEEP_ALIVE_MS + KEEP_ALIVE_GRACE_MS);
  });

  it('answers a request on a socket reused 6.5 s after its last answer; Node’s defaults had already closed it', async () => {
    const [kept, defaults] = await Promise.all([
      broker(true).then(({ port }) => reuseAfter(port, 6_500)),
      broker(false).then(({ port }) => reuseAfter(port, 6_500)),
    ]);
    expect(kept).toEqual({ first: 'HTTP/1.1 200 OK', second: 'HTTP/1.1 200 OK' });
    // The control: without the policy the same reuse finds the socket gone.
    expect(defaults.first).toBe('HTTP/1.1 200 OK');
    expect(defaults.second).not.toBe('HTTP/1.1 200 OK');
  }, 20_000);

  it('is applied to the broker before it listens', () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
    const applied = source.indexOf('applyKeepAlivePolicy(server);');
    expect(applied).toBeGreaterThan(source.indexOf('const server = createSandboxd('));
    expect(applied).toBeLessThan(source.indexOf('server.listen('));
  });
});
