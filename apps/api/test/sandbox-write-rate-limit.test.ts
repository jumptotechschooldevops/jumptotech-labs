/**
 * Start Lab and Reset Lab share one per-student request budget.
 *
 * The per-student session limit already refuses a second live lab, atomically.
 * What it cannot do is refuse *cheaply*: every refused Start still opened and
 * closed an attempt row and queued on the capacity lock that every other
 * student's Start waits for, and every Reset rebuilt a sandbox. A script could
 * ask as fast as the network allowed. The budget is per authenticated student,
 * so students sharing one address — a classroom behind NAT — do not share it.
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
import { SANDBOX_WRITE_RATE_LIMIT } from '../src/rate-limit.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'sandbox-write-rate-limit-secret';

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
  const obs = observability();
  const app = createApp({
    registry,
    sessions,
    k8s: new FakeKubernetes(),
    config,
    observability: obs,
    ...(limit !== undefined ? { sandboxWriteRateLimit: { limit, windowMs: 60_000 } } : {}),
  });
  return { app, obs };
}

const as = (student: string, address = '203.0.113.7') => ({
  Authorization: `Developer ${student}`,
  'X-Forwarded-For': address,
});

async function rateLimitedEvents(obs: NonNullable<CreateAppDeps['observability']>): Promise<number> {
  const { values } = await obs.metrics.common.securityEvents.get();
  return values.filter((v) => v.labels.event === 'rate_limited').reduce((sum, v) => sum + v.value, 0);
}

describe('the sandbox write budget', () => {
  it('refuses a student who keeps pressing Start past the budget, without touching the session limit', async () => {
    const { app, obs } = buildApp(3);

    const first = await request(app).post('/api/labs/LINUX-001/start').set(as('alice'));
    expect(first.status).toBe(200);
    // Already holding a lab: refused by the session limit, and still counted.
    for (let i = 0; i < 2; i += 1) {
      const again = await request(app).post('/api/labs/LINUX-001/start').set(as('alice'));
      expect(again.body.error.code).toBe('STUDENT_SESSION_LIMIT_REACHED');
    }

    const flooded = await request(app).post('/api/labs/LINUX-001/start').set(as('alice'));
    expect(flooded.status).toBe(429);
    expect(flooded.body.error.code).toBe('RATE_LIMITED');
    expect(flooded.headers['retry-after']).toBeDefined();
    expect(await rateLimitedEvents(obs)).toBe(1);
  });

  it('keeps each student’s budget their own, even from one address', async () => {
    const { app } = buildApp(2);
    await request(app).post('/api/labs/LINUX-001/start').set(as('alice'));
    await request(app).post('/api/labs/LINUX-001/start').set(as('alice'));
    expect((await request(app).post('/api/labs/LINUX-001/start').set(as('alice'))).status).toBe(429);

    const bob = await request(app).post('/api/labs/LINUX-001/start').set(as('bob'));
    expect(bob.status).toBe(200);
  });

  it('counts Reset against the same budget as Start', async () => {
    const { app } = buildApp(3);
    const started = await request(app).post('/api/labs/LINUX-001/start').set(as('alice'));
    const sessionId = String(started.body.data.session.sessionId);

    for (let i = 0; i < 2; i += 1) {
      const reset = await request(app).post(`/api/sessions/${sessionId}/reset`).set(as('alice'));
      expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    }
    const flooded = await request(app).post(`/api/sessions/${sessionId}/reset`).set(as('alice'));
    expect(flooded.status).toBe(429);
    expect(flooded.body.error.code).toBe('RATE_LIMITED');
  });

  it('does not limit reads, checks or End Lab', async () => {
    const { app } = buildApp(1);
    const started = await request(app).post('/api/labs/LINUX-001/start').set(as('alice'));
    const sessionId = String(started.body.data.session.sessionId);

    for (let i = 0; i < 5; i += 1) {
      expect((await request(app).get(`/api/sessions/${sessionId}`).set(as('alice'))).status).toBe(200);
    }
    expect((await request(app).post(`/api/sessions/${sessionId}/check`).set(as('alice'))).status).toBe(200);
    expect((await request(app).delete(`/api/sessions/${sessionId}`).set(as('alice'))).status).toBe(200);
  });

  it('allows several times what a person pressing buttons does by default', () => {
    expect(SANDBOX_WRITE_RATE_LIMIT).toEqual({ limit: 20, windowMs: 60_000 });
  });
});
