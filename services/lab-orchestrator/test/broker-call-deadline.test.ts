/**
 * A runtime-broker call is bounded end to end, body included.
 *
 * Both broker clients armed their deadline for the request and cleared it the
 * moment response *headers* arrived; the body was then read with no deadline
 * at all. Over the plaintext same-host transport (global `fetch`, which
 * resolves at headers) a broker that stalls mid-reply — frozen, starved, or a
 * connection that dies without a reset — left the caller waiting forever: a
 * Start, a Check, a Reset, or a reaper sweep's `list`, which stalls every
 * later sweep behind it. The TLS transport buffers the whole body before
 * resolving, so it was already bounded; this pins both to the same contract.
 *
 * The broker here is real HTTP on loopback that sends its headers and half a
 * JSON body, then goes quiet.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BrokerDockerEngines } from '../src/docker/broker-engines.js';
import { BrokerRuntime } from '../src/providers/container/broker-runtime.js';

const servers: Server[] = [];
const stalled: ServerResponse[] = [];
afterEach(async () => {
  for (const res of stalled.splice(0)) res.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** A broker that answers with headers and the start of a body, and never finishes. */
async function stallingBroker(): Promise<string> {
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

describe('runtime broker calls are bounded while the body is read', () => {
  it('BrokerRuntime gives up on a broker that stalls after its headers', async () => {
    const client = new BrokerRuntime({ baseUrl: await stallingBroker(), secret: 's', timeoutMs: DEADLINE_MS });
    expect(await outcomeWithin(client.list('jumptotech.io/managed=true'), WAIT_MS)).toBe('rejected');
  }, 20_000);

  it('the Docker broker client gives up on a broker that stalls after its headers', async () => {
    const engines = new BrokerDockerEngines({ baseUrl: await stallingBroker(), secret: 's', timeoutMs: DEADLINE_MS });
    expect(await outcomeWithin(engines.host.version(), WAIT_MS)).toBe('rejected');
  }, 20_000);

  it('reports the stall as the broker being unreachable, not as a malformed reply it never finished', async () => {
    const client = new BrokerRuntime({ baseUrl: await stallingBroker(), secret: 's', timeoutMs: DEADLINE_MS });
    await expect(client.inspect('lab-x')).rejects.toThrow(/did not answer in time/);
  }, 20_000);
});
