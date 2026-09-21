/**
 * An internal call's deadline covers the body, not only the headers.
 *
 * `fetch` resolves as soon as headers arrive. The workspace read cleared its
 * timer there, so a terminal service that sent headers and then stalled held
 * the Check that asked — and, through `checksInFlight`, every later Check of
 * that session — forever.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpTerminalWorkspace } from '../src/terminal-workspace.js';

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

describe('the workspace read', () => {
  it('fails at its deadline when the body stalls after the headers', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      res.write('{"ok":true,');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const workspace = new HttpTerminalWorkspace({ baseUrl: `http://127.0.0.1:${port}`, secret: 's', timeoutMs: 200 });

    const outcome = await Promise.race([
      workspace.read('sess-0000000000000001', 'Dockerfile').then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 3_000)),
    ]);
    expect(outcome).toBe('rejected');
  });
});
