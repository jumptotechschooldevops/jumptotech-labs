/**
 * BETA-P0-018 — Reset Lab, End Lab and the OIDC callback count their outcomes.
 *
 * `jtt_lab_reset_total` and `jtt_auth_callback_total` were defined in
 * PLATFORM-003 and never incremented, so "are resets failing?" and "are
 * sign-ins failing?" had no answer. This drives the composed application
 * through the real routes and reads the registry the routes write to.
 *
 * The distinction it pins is the one the alerts depend on: a refusal before any
 * runtime work — a session that is already over — is `rejected`, never
 * `failed`, so a student pressing Reset on a finished lab cannot page anyone.
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
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let labs: LabRegistry;
beforeAll(async () => {
  labs = await realCatalog();
});

/** A session store whose database has gone away. */
class UnreachableStore extends InMemorySessionStore {
  unreachable = false;
  override async createWithinLimits(...args: Parameters<InMemorySessionStore['createWithinLimits']>) {
    if (this.unreachable) {
      throw Object.assign(new Error('connect ECONNREFUSED 172.18.0.2:5432'), { code: 'ECONNREFUSED' });
    }
    return super.createWithinLimits(...args);
  }
}

function compose() {
  const registry = createRegistry({ service: 'api', defaultMetrics: false });
  const lines: string[] = [];
  const logger = createLogger({ service: 'api', level: 'debug', sink: (line) => lines.push(line) });
  const sessionMetrics = createSessionMetrics(registry);

  const config = loadConfig({
    TERMINAL_SESSION_SECRET: 'session-outcome-metrics-test-secret',
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    MAX_ACTIVE_SESSIONS: '5',
    MAX_ACTIVE_SESSIONS_PER_STUDENT: '1',
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

  const store = new UnreachableStore();
  const sessions = new SessionManager({
    registry: labs,
    provider,
    store,
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: config.lifetimes,
    namespaceSecret: config.namespaceSecret,
    metrics: sessionMetricsHooks(sessionMetrics),
  });

  const app = createApp({
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

  /** Sum of a counter's samples, optionally narrowed to some label values. */
  const counter = async (name: string, labels: Record<string, string> = {}): Promise<number> => {
    const metric = (await registry.getMetricsAsJSON()).find((m) => m.name === name);
    expect(metric, `${name} is registered`).toBeDefined();
    return (metric!.values as Array<{ value: number; labels: Record<string, string | number> }>)
      .filter((v) => Object.entries(labels).every(([k, want]) => v.labels[k] === want))
      .reduce((sum, v) => sum + v.value, 0);
  };

  return { app, lines, counter, store };
}

const as = (student: string) => ({ Authorization: `Developer ${student}` });

describe('Reset Lab and End Lab outcomes', () => {
  it('counts a reset and an end that succeed, and a reset of a finished session as rejected', async () => {
    const { app, lines, counter } = compose();

    const started = await request(app).post('/api/labs/K8S-001/start').set(as('alice'));
    expect(started.status).toBe(200);
    const sessionId = started.body.data.session.sessionId as string;

    const reset = await request(app).post(`/api/sessions/${sessionId}/reset`).set(as('alice'));
    expect(reset.status).toBe(200);
    expect(await counter('jtt_lab_reset_outcome_total', { outcome: 'success' })).toBe(1);
    // The provider-labelled diagnostic counter, which nothing incremented before.
    expect(await counter('jtt_lab_reset_total', { outcome: 'success' })).toBe(1);

    const ended = await request(app).delete(`/api/sessions/${sessionId}`).set(as('alice'));
    expect(ended.status).toBe(200);
    expect(await counter('jtt_lab_end_outcome_total', { outcome: 'success' })).toBe(1);

    const late = await request(app).post(`/api/sessions/${sessionId}/reset`).set(as('alice'));
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('SESSION_NOT_ACTIVE');
    expect(await counter('jtt_lab_reset_outcome_total', { outcome: 'rejected' })).toBe(1);
    expect(await counter('jtt_lab_reset_outcome_total', { outcome: 'failed' })).toBe(0);

    const again = await request(app).delete(`/api/sessions/${sessionId}`).set(as('alice'));
    expect(again.status).toBeLessThan(500);
    expect(await counter('jtt_lab_end_outcome_total', { outcome: 'failed' })).toBe(0);

    expect(lines.filter((line) => line.includes('"event":"lab.reset.succeeded"'))).toHaveLength(1);
    const refused = lines.filter((line) => line.includes('"event":"lab.reset.failed"'));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain('"outcome":"rejected"');
    expect(refused[0]).toContain('"code":"SESSION_NOT_ACTIVE"');
  });

  it('never counts a request the ownership guard refused', async () => {
    const { app, counter } = compose();
    const started = await request(app).post('/api/labs/K8S-001/start').set(as('alice'));
    const sessionId = started.body.data.session.sessionId as string;

    expect((await request(app).post(`/api/sessions/${sessionId}/reset`).set(as('mallory'))).status).toBe(404);
    expect((await request(app).delete(`/api/sessions/${sessionId}`).set(as('mallory'))).status).toBe(404);

    for (const name of ['jtt_lab_reset_outcome_total', 'jtt_lab_end_outcome_total']) {
      expect(await counter(name), name).toBe(0);
    }
  });
});

describe('Start Lab outcomes', () => {
  /*
   * A start that died on the session store never reached the sandbox
   * substrate. Counting it `provision_failed` sent the operator to RB-03 for
   * what is a database outage; it is `platform_error`, and the log keeps the
   * driver's code for the operator. The student still sees nothing internal.
   */
  it('counts a start that failed on the database as platform_error, not provision_failed', async () => {
    const { app, counter, lines, store } = compose();
    store.unreachable = true;

    const reply = await request(app).post('/api/labs/K8S-001/start').set(as('alice'));
    expect(reply.status).toBe(500);
    expect(reply.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(reply.body)).not.toMatch(/ECONNREFUSED|5432/);

    expect(await counter('jtt_lab_start_outcome_total', { outcome: 'platform_error' })).toBe(1);
    expect(await counter('jtt_lab_start_outcome_total', { outcome: 'provision_failed' })).toBe(0);
    const failed = lines.find((line) => line.includes('"event":"lab.start.failed"'));
    expect(failed).toContain('"outcome":"platform_error"');
    expect(failed).toContain('"code":"ECONNREFUSED"');

    store.unreachable = false;
    const recovered = await request(app).post('/api/labs/K8S-001/start').set(as('alice'));
    expect(recovered.status).toBe(200);
    expect(await counter('jtt_lab_start_outcome_total', { outcome: 'success' })).toBe(1);
  });
});

describe('OIDC callback outcomes', () => {
  it('counts a callback on a deployment with no identity provider as not_configured', async () => {
    const { app, counter } = compose();
    const response = await request(app).get('/auth/callback?code=abc&state=def');
    expect(response.status).toBe(503);
    expect(await counter('jtt_auth_callback_total', { outcome: 'not_configured' })).toBe(1);
    expect(await counter('jtt_auth_callback_total', { outcome: 'success' })).toBe(0);
  });
});
