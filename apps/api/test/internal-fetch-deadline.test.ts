/**
 * Outbound calls the api makes are bounded end to end, body included.
 *
 * Each armed its deadline for the request and cleared it when the response
 * headers arrived, then read the body with no deadline. A peer that stalled
 * after its headers left the caller waiting forever:
 *
 *   - the terminal workspace read runs inside a Check, and a session holds one
 *     check slot (`checksInFlight`) — the student was refused every later
 *     Check with CHECK_IN_PROGRESS until the api restarted;
 *   - discovery and the token exchange run inside a sign-in request.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpTerminalWorkspace } from '../src/terminal-workspace.js';
import { fetchDiscoveryDocument } from '../src/auth/discovery.js';
import { OidcBrowserClient } from '../src/auth/oidc-client.js';

const servers: Server[] = [];
const stalled: ServerResponse[] = [];
afterEach(async () => {
  for (const res of stalled.splice(0)) res.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/**
 * A peer that answers with headers and the start of a JSON body, and never
 * finishes. Chunked by default; `declaredLength` instead promises a
 * content-length the peer never delivers.
 */
async function stallingPeer(declaredLength?: number): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'application/json',
        ...(declaredLength === undefined ? {} : { 'content-length': String(declaredLength) }),
      });
      res.write('{"ok":true,"data":');
      stalled.push(res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Settles with the call's outcome, or with 'still waiting' long after its deadline. */
async function outcomeWithin<T>(call: Promise<T>, ms: number): Promise<'resolved' | 'rejected' | 'still waiting'> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<'still waiting'>((resolve) => {
    timer = setTimeout(() => resolve('still waiting'), ms);
  });
  try {
    return await Promise.race([call.then(() => 'resolved' as const, () => 'rejected' as const), guard]);
  } finally {
    clearTimeout(timer);
  }
}

const DEADLINE_MS = 300;
/** Generous against a loaded machine; the point is "not forever". */
const WAIT_MS = 10_000;

describe('outbound call deadlines cover the response body', () => {
  it('a workspace read gives up on a terminal reply that stalls after its headers', async () => {
    const workspace = new HttpTerminalWorkspace({ baseUrl: await stallingPeer(), secret: 's', timeoutMs: DEADLINE_MS });
    const call = workspace.read('sess-0123456789abcdef', 'Dockerfile');
    expect(await outcomeWithin(call, WAIT_MS)).toBe('rejected');
    await expect(call).rejects.toThrow(/did not finish replying in time/);
  }, 20_000);

  it('a workspace read gives up on a reply short of its declared content-length', async () => {
    const workspace = new HttpTerminalWorkspace({
      baseUrl: await stallingPeer(1000),
      secret: 's',
      timeoutMs: DEADLINE_MS,
    });
    const call = workspace.read('sess-0000000000000001', 'Dockerfile');
    expect(await outcomeWithin(call, WAIT_MS)).toBe('rejected');
    await expect(call).rejects.toThrow(/did not finish replying in time/);
  }, 20_000);

  it('discovery gives up on a document that stalls after its headers', async () => {
    const call = fetchDiscoveryDocument(await stallingPeer(), { timeoutMs: DEADLINE_MS });
    expect(await outcomeWithin(call, WAIT_MS)).toBe('rejected');
    await expect(call).rejects.toThrow(/did not finish sending/);
  }, 20_000);

  it('the token exchange gives up on a reply that stalls after its headers', async () => {
    const peer = await stallingPeer();
    const client = new OidcBrowserClient({
      issuer: peer,
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'http://localhost/auth/callback',
      scopes: ['openid'],
      metadata: { issuer: peer, authorizationEndpoint: `${peer}/authorize`, tokenEndpoint: `${peer}/token` },
      timeoutMs: DEADLINE_MS,
    });
    const call = client.exchangeCode('code', 'verifier');
    expect(await outcomeWithin(call, WAIT_MS)).toBe('rejected');
    await expect(call).rejects.toThrow(/did not finish replying in time/);
  }, 20_000);
});
