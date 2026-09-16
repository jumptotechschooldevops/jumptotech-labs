/**
 * SEC-API-1: a malformed or oversized request body is the client's error.
 *
 * `express.json` runs before authentication, so anyone who can reach the API
 * can send a body it refuses. Those refusals used to fall through to the
 * central handler and come back as 500 INTERNAL_ERROR — logged at error level
 * with the parser's message (which quotes the body), and counted as a 5xx,
 * the series `ApiErrorRate` pages on. An unauthenticated client could therefore
 * fire the API's error alert and write its own text into error logs.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
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
import {
  createAuthMetrics,
  createCommonMetrics,
  createLogger,
  createRegistry,
  createSessionMetrics,
  createVerificationMetrics,
} from '@jumptotech/observability';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'request-body-errors-test-secret';
/**
 * Text an attacker controls, which must not be echoed into a log line. Short,
 * because V8 quotes only a few characters around the offending token.
 */
const MARKER = 'zq9xk';

let registry: LabRegistry;
let lines: string[];
let metricRegistry: ReturnType<typeof createRegistry>;

beforeAll(async () => {
  registry = await realCatalog();
});

beforeEach(() => {
  lines = [];
  metricRegistry = createRegistry({ service: 'api', defaultMetrics: false });
});

function buildApp() {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
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
  const logger = createLogger({ service: 'api', level: 'debug', sink: (line) => lines.push(line) });
  return createApp({
    registry,
    sessions,
    k8s: new FakeKubernetes(),
    config,
    observability: {
      logger,
      metrics: {
        common: createCommonMetrics(metricRegistry, 'api'),
        sessions: createSessionMetrics(metricRegistry),
        verification: createVerificationMetrics(metricRegistry),
        auth: createAuthMetrics(metricRegistry),
      },
    },
  });
}

async function expectNoServerError(): Promise<void> {
  const exposition = await metricRegistry.metrics();
  expect(exposition).not.toMatch(/status_class="5xx"/);
  const errorLines = lines.filter((line) => /"level":"error"/.test(line));
  expect(errorLines).toEqual([]);
  expect(lines.join('\n')).not.toContain(MARKER);
}

describe('request bodies the parser refuses', () => {
  it('answers malformed JSON with 400, before authentication, without logging the body', async () => {
    const res = await request(buildApp())
      .post('/api/labs/LINUX-001/start')
      .set('Content-Type', 'application/json')
      .send(`{"k": ${MARKER}}`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: { code: 'INVALID_JSON', message: expect.any(String) } });
    expect(JSON.stringify(res.body)).not.toContain(MARKER);
    await expectNoServerError();
  });

  it('answers a body over the 16 KiB limit with 413', async () => {
    const res = await request(buildApp())
      .post('/api/labs/LINUX-001/start')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ note: MARKER.repeat(4_000) }));

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: expect.any(String) } });
    await expectNoServerError();
  });

  it('answers an unsupported body encoding with 415', async () => {
    const res = await request(buildApp())
      .post('/api/labs/LINUX-001/start')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'x-unknown')
      .send('{}');

    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_BODY');
    await expectNoServerError();
  });

  it('leaves a well-formed body untouched', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/labs/LINUX-001/start')
      .set('Content-Type', 'application/json')
      .set('Authorization', 'Developer alice')
      .send('{}');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
