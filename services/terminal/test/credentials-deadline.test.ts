/**
 * The credential exchange is bounded end to end, body included.
 *
 * `fetchInternal` armed its deadline for the request and cleared it when the
 * response headers arrived; the body was then read with no deadline. An API
 * reply that stalled after its headers left the attach waiting forever — and
 * attaches for one session are taken in turn (`attachInTurn`), so every later
 * attach for that session queued behind it: the student's terminal could not
 * reconnect until this service restarted.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CredentialsUnavailableError, fetchTerminalContext } from '../src/credentials.js';

const servers: Server[] = [];
const stalled: ServerResponse[] = [];
afterEach(async () => {
  for (const res of stalled.splice(0)) res.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** A peer that answers with headers and the start of a JSON body, and never finishes. */
async function stallingPeer(): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
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

describe('credential exchange deadline', () => {
  it('gives up on an API reply that stalls after its headers', async () => {
    const call = fetchTerminalContext({
      apiInternalUrl: await stallingPeer(),
      secret: 'internal-secret',
      sessionId: 'sess-0123456789abcdef',
      ownerUserId: 'usr-0000000a',
      timeoutMs: DEADLINE_MS,
    });
    expect(await outcomeWithin(call, WAIT_MS)).toBe('rejected');
    await expect(call).rejects.toBeInstanceOf(CredentialsUnavailableError);
    await expect(call).rejects.toThrow(/did not finish replying/);
  }, 20_000);
});
