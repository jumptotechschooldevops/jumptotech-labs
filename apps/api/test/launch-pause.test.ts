/**
 * The stop-launches switch (`LAB_LAUNCHES_PAUSED`).
 *
 * The operations runbook had no way to stop new labs without taking the whole
 * site down. Paused, Start Lab is refused before anything is written or
 * counted; a lab that is already running keeps every route it had. The pause
 * is read from the same environment as the capacity ceiling and changed the
 * same way (`prod up -d api`), so the tests build two apps over one session
 * manager: the running platform before and after that change.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  SessionManager,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import {
  createAuthMetrics,
  createCommonMetrics,
  createLogger,
  createRegistry,
  createSessionMetrics,
  createVerificationMetrics,
} from '@jumptotech/observability';
import { createApp } from '../src/app.js';
import { sessionMetricsHooks } from '../src/observability.js';
import { loadConfig } from '../src/config.js';
import { InMemoryUserRepository } from '../src/auth/users.js';
import { DevelopmentIdentityResolver } from '../src/auth/resolvers.js';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';

// One user table for every app built here, as one PostgreSQL database would be:
// an in-memory repository numbers users per instance.
const users = new InMemoryUserRepository();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let labs: LabRegistry;
beforeAll(async () => {
  labs = await realCatalog();
});

function compose(sessionsFrom?: SessionManager, env: Record<string, string> = {}) {
  const registry = createRegistry({ service: 'api', defaultMetrics: false });
  const lines: string[] = [];
  const logger = createLogger({ service: 'api', level: 'debug', sink: (line) => lines.push(line) });
  const sessionMetrics = createSessionMetrics(registry);

  const config = loadConfig({
    TERMINAL_SESSION_SECRET: 'launch-pause-test-secret-value',
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    MAX_ACTIVE_SESSIONS: '2',
    MAX_ACTIVE_SESSIONS_PER_STUDENT: '1',
    ...env,
  } as NodeJS.ProcessEnv);

  const k8s = new FakeKubernetes();
  const provider = new KindLabProvider({
    k8s,
    clusterName: 'jumptotech-labs',
    resetDrainTimeoutMs: 2_000,
    destroyTimeoutMs: 2_000,
    sleep: async () => undefined,
  });
  provider.execute = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.34.2' } }),
    stderr: '',
    timedOut: false,
  });

  const sessions = sessionsFrom ?? new SessionManager({
    registry: labs,
    provider,
    store: new InMemorySessionStore(),
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: config.lifetimes,
    namespaceSecret: config.namespaceSecret,
    // The composition root's own mapping — the function `index.ts` calls.
    metrics: sessionMetricsHooks(sessionMetrics),
  });

  const app = createApp({
    identityResolver: new DevelopmentIdentityResolver(users),
    registry: labs,
    sessions,
    k8s,
    config,
    observability: {
      logger,
      metrics: {
        common: createCommonMetrics(registry, 'api'),
        sessions: sessionMetrics,
        verification: createVerificationMetrics(registry),
        auth: createAuthMetrics(registry),
      },
    },
  });

  /** Sum of a counter's samples, optionally narrowed to one label value. */
  const counter = async (name: string, labels: Record<string, string> = {}): Promise<number> => {
    const metric = (await registry.getMetricsAsJSON()).find((m) => m.name === name);
    expect(metric, `${name} is registered`).toBeDefined();
    return (metric!.values as Array<{ value: number; labels: Record<string, string | number> }>)
      .filter((v) => Object.entries(labels).every(([k, want]) => v.labels[k] === want))
      .reduce((sum, v) => sum + v.value, 0);
  };

  return { app, lines, counter, sessions };
}

const as = (student: string) => ({ Authorization: `Developer ${student}` });

describe('LAB_LAUNCHES_PAUSED', () => {
  it('is off unless set, and reads the usual true spellings', () => {
    const base = { TERMINAL_SESSION_SECRET: 'launch-pause-test-secret-value', ALLOWED_ORIGINS: 'http://localhost:3000' };
    expect(loadConfig(base as NodeJS.ProcessEnv).launchesPaused).toBe(false);
    expect(loadConfig({ ...base, LAB_LAUNCHES_PAUSED: 'true' } as NodeJS.ProcessEnv).launchesPaused).toBe(true);
    expect(loadConfig({ ...base, LAB_LAUNCHES_PAUSED: 'false' } as NodeJS.ProcessEnv).launchesPaused).toBe(false);
  });

  it('refuses every start, writes nothing, and leaves a running lab fully usable; unpausing restores starts', async () => {
    const running = compose();
    const started = await request(running.app).post('/api/labs/K8S-001/start').set(as('alice'));
    expect(started.status).toBe(200);
    const sessionId = started.body.data.session.sessionId as string;

    // The operator sets LAB_LAUNCHES_PAUSED=true and re-creates the api.
    const paused = compose(running.sessions, { LAB_LAUNCHES_PAUSED: 'true' });

    const refused = await request(paused.app).post('/api/labs/K8S-002/start').set(as('bob'));
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('LAB_LAUNCHES_PAUSED');
    // Nothing was created or counted for bob, and no start outcome was recorded.
    expect((await request(paused.app).get('/api/sessions').set(as('bob'))).body.data.sessions).toHaveLength(0);
    expect(await paused.counter('jtt_lab_start_outcome_total')).toBe(0);
    expect(paused.lines.some((line) => line.includes('lab.start.paused'))).toBe(true);

    // alice's running lab: read, terminal grant, and End all still work.
    expect((await request(paused.app).get(`/api/sessions/${sessionId}`).set(as('alice'))).status).toBe(200);
    expect((await request(paused.app).post(`/api/sessions/${sessionId}/terminal`).set(as('alice'))).status).toBe(200);
    const health = await request(paused.app).get('/health');
    expect(health.body.data.sessions).toMatchObject({ active: 1, launchesPaused: true });
    expect((await request(paused.app).delete(`/api/sessions/${sessionId}`).set(as('alice'))).status).toBe(200);

    // Unpaused again.
    const resumed = compose(running.sessions, { LAB_LAUNCHES_PAUSED: 'false' });
    expect((await request(resumed.app).post('/api/labs/K8S-002/start').set(as('bob'))).status).toBe(200);
    expect((await request(resumed.app).get('/health')).body.data.sessions.launchesPaused).toBe(false);
  });
});
