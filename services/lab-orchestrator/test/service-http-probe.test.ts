/**
 * `service_http` treats the student's Service as hostile — see
 * `probeServiceHttp` in `src/k8s/client.ts`.
 *
 * Hermetic: `fetch` is a fake, so no socket is opened. What is proven is what
 * this process asks `fetch` to do and how much of an answer it reads.
 */
import { describe, expect, it } from 'vitest';
import { MAX_SERVICE_HTTP_BODY_BYTES, probeServiceHttp } from '../src/k8s/client.js';

const TARGET = { host: '10.96.0.42', service: 'web', port: 80, path: '/healthz' };

function fakeFetch(respond: () => Response) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  }) as typeof fetch;
  return { impl, calls };
}

/** A body that keeps producing until it is cancelled, counting what it gave. */
function endlessBody() {
  let produced = 0;
  let cancelled = false;
  const chunk = new Uint8Array(16 * 1024).fill(0x61);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      produced += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, produced: () => produced, cancelled: () => cancelled };
}

describe('service_http probe', () => {
  it('asks fetch not to follow redirects', async () => {
    const { impl, calls } = fakeFetch(
      () => new Response(null, { status: 302, headers: { location: 'http://sandboxd:4002/v1/runtime' } }),
    );
    const result = await probeServiceHttp(TARGET, {}, impl);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://10.96.0.42:80/healthz');
    expect(calls[0]!.init?.redirect).toBe('manual');
    // The redirect is the Service's answer, reported as such.
    expect(result).toMatchObject({ ok: false, statusCode: 302 });
    expect(result.detail).toBe('HTTP 302 from web:80/healthz, expected 200');
    expect(result.detail).not.toContain('sandboxd');
  });

  it('reads no more than the cap of a body it has to search', async () => {
    const body = endlessBody();
    const { impl } = fakeFetch(() => new Response(body.stream, { status: 200 }));

    const result = await probeServiceHttp(TARGET, { bodyContains: 'ready' }, impl);

    expect(result.ok).toBe(false);
    expect(body.cancelled()).toBe(true);
    // One chunk of slack at most: the reader stops as soon as the cap is met.
    expect(body.produced()).toBeLessThanOrEqual(MAX_SERVICE_HTTP_BODY_BYTES + 2 * 16 * 1024);
  });

  it('does not read a body the check does not look at', async () => {
    const body = endlessBody();
    const { impl } = fakeFetch(() => new Response(body.stream, { status: 200 }));

    const result = await probeServiceHttp(TARGET, {}, impl);

    expect(result).toEqual({ ok: true, statusCode: 200 });
    expect(body.cancelled()).toBe(true);
    expect(body.produced()).toBeLessThanOrEqual(2 * 16 * 1024);
  });

  it('still passes a body that contains the expected text within the cap', async () => {
    const { impl } = fakeFetch(() => new Response('status: ready\n', { status: 200 }));
    await expect(probeServiceHttp(TARGET, { bodyContains: 'ready' }, impl)).resolves.toEqual({
      ok: true,
      statusCode: 200,
    });
  });

  it('honours an expected non-200 status', async () => {
    const { impl } = fakeFetch(() => new Response('', { status: 404 }));
    await expect(probeServiceHttp(TARGET, { expectedStatus: 404 }, impl)).resolves.toEqual({
      ok: true,
      statusCode: 404,
    });
  });

  it('reports an unreachable Service without throwing', async () => {
    const impl = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch;
    const result = await probeServiceHttp(TARGET, {}, impl);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/^Could not reach web:80\/healthz — /);
  });
});
