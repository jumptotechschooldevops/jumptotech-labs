/**
 * Check has a per-student request budget.
 *
 * A check is dozens of reads against the sandbox and a write to the attempt.
 * One at a time per session was already enforced (`check-concurrency.test.ts`);
 * how many in a row was not, and a loop that re-asked as each answer arrived ran
 * about a hundred checks a second, five sandbox execs each, against the fake
 * runtime. The budget is per authenticated student, so a classroom behind one
 * address does not share it, and a request for somebody else's session spends
 * the caller's budget, never the owner's.
 */
import { beforeAll, describe, expect, it } from 'vitest';
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
  createRegistry,
  createSessionMetrics,
  createVerificationMetrics,
  silentLogger,
} from '@jumptotech/observability';
import { createApp, type CreateAppDeps } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { CHECK_RATE_LIMIT } from '../src/rate-limit.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'check-rate-limit-test-secret';

let registry: LabRegistry;
beforeAll(async () => {
  registry = await realCatalog();
});

function observability(): NonNullable<CreateAppDeps['observability']> {
  const metrics = createRegistry({ service: 'api', defaultMetrics: false });
  return {
    logger: silentLogger(),
    metrics: {
      common: createCommonMetrics(metrics, 'api'),
      sessions: createSessionMetrics(metrics),
      verification: createVerificationMetrics(metrics),
      auth: createAuthMetrics(metrics),
    },
  };
}

function buildApp(limit?: number) {
  let execs = 0;
  const runtime = new FakeContainerRuntime();
  const exec = runtime.exec.bind(runtime);
  runtime.exec = async (name, request) => {
    execs += 1;
    return exec(name, request);
  };
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_MODE: 'development',
  } as NodeJS.ProcessEnv);
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime }) });
  const sessions = new SessionManager({
    registry,
    providers,
    store: new InMemorySessionStore(),
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: SECRET,
  });
  const obs = observability();
  const app = createApp({
    registry,
    sessions,
    k8s: new FakeKubernetes(),
    config,
    observability: obs,
    ...(limit !== undefined ? { checkRateLimit: { limit, windowMs: 60_000 } } : {}),
  });
  return { app, obs, execs: () => execs };
}

const as = (student: string, address = '203.0.113.7') => ({
  Authorization: `Developer ${student}`,
  'X-Forwarded-For': address,
});

async function rateLimitedEvents(obs: NonNullable<CreateAppDeps['observability']>): Promise<number> {
  const { values } = await obs.metrics.common.securityEvents.get();
  return values.filter((v) => v.labels.event === 'rate_limited').reduce((sum, v) => sum + v.value, 0);
}


async function start(app: ReturnType<typeof buildApp>['app'], student: string): Promise<string> {
  const res = await request(app).post('/api/labs/LINUX-001/start').set(as(student));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return String(res.body.data.session.sessionId);
}

describe('the check budget', () => {
  it('refuses a student who keeps checking past the budget, before the sandbox is read', async () => {
    const { app, obs, execs } = buildApp(3);
    const sessionId = await start(app, 'alice');

    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).post(`/api/sessions/${sessionId}/check`).set(as('alice'))).status).toBe(200);
    }
    const before = execs();
    const flooded = await request(app).post(`/api/sessions/${sessionId}/check`).set(as('alice'));
    expect(flooded.status).toBe(429);
    expect(flooded.body.error.code).toBe('RATE_LIMITED');
    expect(flooded.headers['retry-after']).toBeDefined();
    expect(execs()).toBe(before);
    expect(await rateLimitedEvents(obs)).toBe(1);

    // Nothing was recorded for the refused one: the attempt counted three.
    const attempts = await request(app).get('/api/me/attempts').set(as('alice'));
    expect(attempts.body.data.attempts[0].checkCount).toBe(3);
  });

  it('keeps each student’s budget their own, even from one address', async () => {
    const { app } = buildApp(1);
    const alice = await start(app, 'alice');
    const bob = await start(app, 'bob');
    expect((await request(app).post(`/api/sessions/${alice}/check`).set(as('alice'))).status).toBe(200);
    expect((await request(app).post(`/api/sessions/${alice}/check`).set(as('alice'))).status).toBe(429);
    expect((await request(app).post(`/api/sessions/${bob}/check`).set(as('bob'))).status).toBe(200);
  });

  it('charges a request for somebody else’s session to the caller, not to the owner', async () => {
    const { app } = buildApp(2);
    const alice = await start(app, 'alice');
    for (let i = 0; i < 2; i += 1) {
      expect((await request(app).post(`/api/sessions/${alice}/check`).set(as('mallory'))).status).toBe(404);
    }
    expect((await request(app).post(`/api/sessions/${alice}/check`).set(as('mallory'))).status).toBe(429);
    for (let i = 0; i < 2; i += 1) {
      expect((await request(app).post(`/api/sessions/${alice}/check`).set(as('alice'))).status).toBe(200);
    }
  });

  it('does not limit reads, Reset or End Lab', async () => {
    const { app } = buildApp(1);
    const sessionId = await start(app, 'alice');
    expect((await request(app).post(`/api/sessions/${sessionId}/check`).set(as('alice'))).status).toBe(200);
    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).get(`/api/sessions/${sessionId}`).set(as('alice'))).status).toBe(200);
    }
    expect((await request(app).post(`/api/sessions/${sessionId}/reset`).set(as('alice'))).status).toBe(200);
    expect((await request(app).delete(`/api/sessions/${sessionId}`).set(as('alice'))).status).toBe(200);
  });

  it('allows more than the browser or the release gate ever asks for by default', () => {
    // The release gate polls a check every three seconds (scripts/beta-validation).
    expect(CHECK_RATE_LIMIT).toEqual({ limit: 40, windowMs: 60_000 });
  });
});
