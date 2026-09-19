/**
 * A request target with dot segments reaches no router.
 *
 * nginx picks a `location` on the *normalised* path but, with a variable
 * `proxy_pass`, forwards the client's *raw* request target, and Express does
 * not resolve `.` or `..`. So through the public edge
 *
 * ```text
 *   GET /internal/../api/labs          nginx: location /api/  → proxied as sent
 *                                      api:   app.use('/internal') → internal router
 * ```
 *
 * put the service-to-service router — the one that hands out a session's
 * terminal credentials — one shared secret away from the internet, instead of
 * off the edge entirely (reproduced against the shipped `locations.conf` with
 * nginx:alpine). No browser sends a dot segment: it resolves them before the
 * request leaves. So the api refuses any path that has one, raw or
 * percent-encoded, before routing, and the edge refuses them too
 * (`services/observability/test/tls-edge-contract.test.ts`).
 *
 * Raw `node:http` requests, because a client library may normalise the path
 * this is about.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  InMemorySessionStore,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'request-target-test-terminal-secret';
const INTERNAL = 'request-target-test-internal-secret';

let server: Server;
let port: number;
let registry: LabRegistry;

beforeAll(async () => {
  registry = await realCatalog();
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: INTERNAL,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_MODE: 'development',
  } as NodeJS.ProcessEnv);
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime: new FakeContainerRuntime() }) });
  const sessions = new SessionManager({
    registry,
    providers,
    store: new InMemorySessionStore(),
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: SECRET,
  });
  const app = createApp({ registry, sessions, k8s: new FakeKubernetes(), config });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function raw(
  method: string,
  target: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: { error?: { code?: string } } }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('a path with dot segments reaches no router', () => {
  it.each([
    ['/internal/../api/labs'],
    ['/internal/./../api/labs'],
    ['/internal/%2e%2e/api/labs'],
    ['/internal/.%2E/api/labs'],
    ['/internal/sessions/sess-0123456789abcdef%2F..%2F..%2F..%2Fapi/credentials'],
    ['/api/labs/..'],
    ['/api/labs/./K8S-001'],
    ['/api\\..\\internal'],
  ])('refuses %s before routing', async (target) => {
    const response = await raw('GET', target);
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('INVALID_PATH');
  });

  it('does not let a dot segment carry the service secret into the internal router', async () => {
    const response = await raw(
      'POST',
      '/internal/sessions/sess-0123456789abcdef%2F..%2F..%2F..%2Fapi/credentials',
      { 'x-internal-secret': INTERNAL, 'content-type': 'application/json' },
    );
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe('INVALID_PATH');
  });

  it('refuses a path whose escapes cannot be decoded', async () => {
    const response = await raw('GET', '/api/labs/%E0%A4%A');
    expect(response.status).toBe(400);
  });

  it('leaves ordinary paths, and dots inside a segment or a query, alone', async () => {
    expect((await raw('GET', '/api/labs')).status).toBe(200);
    expect((await raw('GET', '/api/labs?q=../etc')).status).toBe(200);
    expect((await raw('GET', '/api/labs/K8S-001')).status).toBe(200);
    // Still the internal router's own refusal, reached the ordinary way.
    const internal = await raw('POST', '/internal/sessions/sess-0123456789abcdef/credentials');
    expect(internal.status).toBe(401);
    expect(internal.body.error?.code).toBe('UNAUTHORIZED');
  });
});
