/**
 * "The runtime broker is unreachable" says why.
 *
 * Over the plaintext same-host transport the broker clients use global
 * `fetch`, and undici reports every connection-level failure (a refused
 * connect, a reset, a keep-alive socket the server closed under the request)
 * as the same `TypeError: fetch failed`, with the reason on `error.cause`.
 * Both clients kept only `error.message`. On a loaded host a five-student
 * burst failed one Start with exactly
 * `the runtime broker is unreachable: fetch failed` and nothing else in any
 * log. An operator could not tell a broker that was down from a connection
 * that was reset, which are different incidents.
 *
 * The code on the cause is appended, and only the code. It is a fixed token
 * such as ECONNRESET, never the cause's message, which carries the broker's
 * address.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BrokerDockerEngines } from '../src/docker/broker-engines.js';
import { BrokerRuntime } from '../src/providers/container/broker-runtime.js';
import { describeTransportFailure, transportContext } from '../src/broker-transport.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** A broker that accepts the request and then drops the connection without answering. */
async function resettingBroker(): Promise<string> {
  const server = createServer((req) => {
    req.resume();
    req.on('end', () => req.socket.destroy());
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A port nothing listens on: bind, read the port, close. */
async function refusedUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

async function failure(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('the call was expected to fail');
}

describe('an unreachable broker is reported with the transport reason', () => {
  it('BrokerRuntime names a refused connection', async () => {
    const client = new BrokerRuntime({ baseUrl: await refusedUrl(), secret: 's', timeoutMs: 5_000 });
    const message = await failure(client.list('jumptotech.io/managed=true'));
    expect(message).toMatch(/^the runtime broker is unreachable: fetch failed \(ECONNREFUSED\) during 'list' after \d+ ms$/);
  });

  it('BrokerRuntime names a connection dropped mid-request', async () => {
    const client = new BrokerRuntime({ baseUrl: await resettingBroker(), secret: 's', timeoutMs: 5_000 });
    const message = await failure(client.list('jumptotech.io/managed=true'));
    expect(message).toMatch(/^the runtime broker is unreachable: fetch failed \([A-Z_]+\) during 'list' after \d+ ms$/);
  });

  it('the Docker broker client names a refused connection', async () => {
    const engines = new BrokerDockerEngines({ baseUrl: await refusedUrl(), secret: 's', timeoutMs: 5_000 });
    const message = await failure(engines.host.version());
    expect(message).toMatch(/^the runtime broker is unreachable: fetch failed \(ECONNREFUSED\) during '[A-Za-z]+' after \d+ ms$/);
  });

  it('never carries the address in the cause message', async () => {
    const url = await refusedUrl();
    const client = new BrokerRuntime({ baseUrl: url, secret: 's', timeoutMs: 5_000 });
    const message = await failure(client.list('jumptotech.io/managed=true'));
    expect(message).not.toContain(new URL(url).port);
    expect(message).not.toContain('127.0.0.1');
  });
});

describe('describeTransportFailure', () => {
  it('keeps a plain message when there is no cause', () => {
    expect(describeTransportFailure(new Error('boom'))).toBe('boom');
    expect(describeTransportFailure('text')).toBe('text');
  });

  it('appends the code of the innermost cause that has one', () => {
    const inner = Object.assign(new Error('read ECONNRESET 10.0.0.1:4600'), { code: 'ECONNRESET' });
    const outer = new TypeError('fetch failed', { cause: inner });
    expect(describeTransportFailure(outer)).toBe('fetch failed (ECONNRESET)');
  });

  it('ignores a code that is not a plain token', () => {
    const inner = Object.assign(new Error('x'), { code: 'connect to 10.0.0.1 failed' });
    expect(describeTransportFailure(new TypeError('fetch failed', { cause: inner }))).toBe('fetch failed');
  });
});

describe('transportContext', () => {
  it('names the operation and how long after sending it failed', () => {
    expect(transportContext('exec', Date.now() - 1_500)).toMatch(/^ during 'exec' after 1[5-9]\d\d ms$/);
  });

  it('reports a verb that is not a plain token as unknown', () => {
    expect(transportContext('exec; rm -rf /', Date.now())).toMatch(/^ during 'unknown' after \d+ ms$/);
    expect(transportContext('', Date.now())).toMatch(/^ during 'unknown' after \d+ ms$/);
  });

  it('never reports a negative duration', () => {
    expect(transportContext('ping', Date.now() + 60_000)).toBe(" during 'ping' after 0 ms");
  });
});
