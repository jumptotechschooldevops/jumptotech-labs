/**
 * PLATFORM-003 — the observability listener's exposure model.
 *
 * Everything here is about who may read what. The listener carries the
 * platform's capacity, failure rates and catalogue shape, and it runs inside
 * services that are otherwise reachable from a browser through a proxy.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';

import {
  createCommonMetrics,
  createObservabilityListener,
  createRegistry,
  ObservabilityConfigError,
  silentLogger,
  simpleCheck,
} from '../src/index.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

interface Harness {
  url: string;
  registry: ReturnType<typeof createRegistry>;
}

async function listen(options: {
  scrapeToken?: string;
  allowUnauthenticatedMetrics?: boolean;
  ready?: boolean;
  started?: boolean;
}): Promise<Harness> {
  const registry = createRegistry({ service: 'test', defaultMetrics: false });
  const common = createCommonMetrics(registry, 'test');

  const server = createObservabilityListener({
    service: 'test',
    // Port 0: the OS picks a free one, so two suites in one run never collide.
    port: 0,
    host: '127.0.0.1',
    registry,
    scrapeToken: options.scrapeToken ?? 'test-scrape-token-0123456789abcdef',
    ...(options.allowUnauthenticatedMetrics !== undefined
      ? { allowUnauthenticatedMetrics: options.allowUnauthenticatedMetrics }
      : {}),
    checks: [
      simpleCheck('dependency', () =>
        options.ready === false ? { ok: false, reason: 'unreachable' } : { ok: true },
      ),
    ],
    isStarted: () => options.started !== false,
    logger: silentLogger(),
    readyzGauge: common.readyzOk,
    onScrapeDenied: () => common.scrapeDenied.inc({ service: 'test' }),
  });
  servers.push(server);

  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', () => resolve());
  });

  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, registry };
}

describe('/metrics requires a bearer token', () => {
  const TOKEN = 'test-scrape-token-0123456789abcdef';

  it('serves the exposition format to a correct token', async () => {
    const { url } = await listen({ scrapeToken: TOKEN });
    const res = await fetch(`${url}/metrics`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('jtt_http_requests_total');
  });

  it('refuses a request with no credential', async () => {
    const { url } = await listen({ scrapeToken: TOKEN });
    const res = await fetch(`${url}/metrics`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    // A bare 401. An error body describing what was wrong with the credential
    // would be an oracle.
    expect(await res.text()).toBe('');
  });

  it('refuses a wrong token', async () => {
    const { url } = await listen({ scrapeToken: TOKEN });
    const res = await fetch(`${url}/metrics`, {
      headers: { authorization: 'Bearer wrong-token-0123456789abcdefgh' },
    });
    expect(res.status).toBe(401);
  });

  it('refuses a token of a different length without throwing', async () => {
    // `timingSafeEqual` throws on a length mismatch, so length is checked
    // first — the same shape as sandboxd/src/scopes.ts.
    const { url } = await listen({ scrapeToken: TOKEN });
    for (const value of ['Bearer x', 'Bearer ', `Bearer ${'y'.repeat(500)}`]) {
      const res = await fetch(`${url}/metrics`, { headers: { authorization: value } });
      expect(res.status).toBe(401);
    }
  });

  it('refuses a non-Bearer scheme carrying the right value', async () => {
    const { url } = await listen({ scrapeToken: TOKEN });
    const res = await fetch(`${url}/metrics`, { headers: { authorization: `Basic ${TOKEN}` } });
    expect(res.status).toBe(401);
  });

  it('counts refused scrapes', async () => {
    const { url, registry } = await listen({ scrapeToken: TOKEN });
    await fetch(`${url}/metrics`);
    await fetch(`${url}/metrics`);
    const scraped = await registry.metrics();
    expect(scraped).toContain('jtt_observability_scrape_denied_total{service="test"} 2');
  });

  it('refuses to start with no token unless anonymous access is explicit', () => {
    expect(() =>
      createObservabilityListener({
        service: 'test',
        port: 0,
        registry: createRegistry({ service: 'test', defaultMetrics: false }),
        scrapeToken: '',
        checks: [],
        logger: silentLogger(),
      }),
    ).toThrow(ObservabilityConfigError);
  });

  it('serves anonymously only when told to explicitly', async () => {
    const { url } = await listen({ scrapeToken: '', allowUnauthenticatedMetrics: true });
    expect((await fetch(`${url}/metrics`)).status).toBe(200);
  });
});

describe('/livez ignores dependencies', () => {
  it('is 200 even when every readiness dependency is down', async () => {
    /*
     * The property that stops a dependency blip becoming a restart storm.
     * Liveness answers "should this process be killed", and a database outage
     * is never a reason to kill a healthy API — least of all because the
     * restart discards the telemetry explaining the outage.
     */
    const { url } = await listen({ ready: false });
    const res = await fetch(`${url}/livez`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { status: 'alive' } });
  });

  it('is 200 even before startup work has finished', async () => {
    const { url } = await listen({ started: false });
    expect((await fetch(`${url}/livez`)).status).toBe(200);
  });

  it('needs no credential', async () => {
    const { url } = await listen({});
    expect((await fetch(`${url}/livez`)).status).toBe(200);
  });
});

describe('/readyz reflects dependencies', () => {
  it('is 200 when dependencies are healthy', async () => {
    const { url } = await listen({ ready: true });
    const res = await fetch(`${url}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { ready: true } });
  });

  it('is 503 with a bounded reason when a dependency is down', async () => {
    const { url } = await listen({ ready: false });
    const res = await fetch(`${url}/readyz`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { data: { ready: boolean; checks: unknown[] } };
    expect(body.data.ready).toBe(false);
    expect(body.data.checks).toContainEqual({
      name: 'dependency',
      ok: false,
      reason: 'unreachable',
    });
  });

  it('is 503 while the instance is still starting', async () => {
    const { url } = await listen({ started: false });
    expect((await fetch(`${url}/readyz`)).status).toBe(503);
  });

  it('keeps jtt_readyz_ok in step, so an alert can fire on sustained unreadiness', async () => {
    const { url, registry } = await listen({ ready: false });
    await fetch(`${url}/readyz`);
    expect(await registry.metrics()).toContain('jtt_readyz_ok{service="test"} 0');
  });

  it('needs no credential', async () => {
    const { url } = await listen({});
    expect((await fetch(`${url}/readyz`)).status).toBe(200);
  });

  it('is never cached by an intermediary', async () => {
    const { url } = await listen({});
    expect((await fetch(`${url}/readyz`)).headers.get('cache-control')).toBe('no-store');
  });
});

describe('the listener exposes nothing else', () => {
  it('404s every other path', async () => {
    const { url } = await listen({});
    for (const path of ['/', '/health', '/api/labs', '/metricsX', '/metrics/']) {
      const res = await fetch(`${url}${path}`);
      expect(res.status, path).toBe(404);
    }
  });

  it('does no prefix matching, so a traversal is simply not an endpoint', async () => {
    /*
     * Sent over a raw socket rather than with `fetch`, which normalises
     * `/metrics/../livez` to `/livez` in the client before anything is put on
     * the wire — so a `fetch`-based assertion here would prove nothing about
     * the server. This puts the un-normalised path in the request line, which
     * is what a hostile client would do.
     */
    const { url } = await listen({});
    const port = Number(new URL(url).port);

    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(
          'GET /metrics/../livez HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
        );
      });
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
      });
      socket.on('end', () => resolve(buffer.split('\r\n')[0] ?? ''));
      socket.on('error', reject);
    });

    expect(status).toContain('404');
  });

  it('refuses non-GET methods', async () => {
    const { url } = await listen({});
    const res = await fetch(`${url}/metrics`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});
