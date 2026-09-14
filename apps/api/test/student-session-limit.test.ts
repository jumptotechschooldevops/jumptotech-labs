/**
 * BETA-P0-009 — a per-student refusal is observable as itself.
 *
 * `CapacityExhausted` pages on `jtt_lab_start_outcome_total{outcome="capacity_reached"}`
 * (BETA-P0-018; it read `jtt_session_capacity_rejections_total` before), and
 * `LabStartsFailingHard` reads the other start outcomes. A student pressing Start
 * past their own limit is neither the platform being full nor a failed start,
 * so this pins that it lands on its own outcome, its own counter and its own
 * log field — and that a genuine global refusal still lands on the old ones.
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

function compose() {
  const registry = createRegistry({ service: 'api', defaultMetrics: false });
  const lines: string[] = [];
  const logger = createLogger({ service: 'api', level: 'debug', sink: (line) => lines.push(line) });
  const sessionMetrics = createSessionMetrics(registry);

  const config = loadConfig({
    TERMINAL_SESSION_SECRET: 'student-session-limit-test-secret',
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    MAX_ACTIVE_SESSIONS: '2',
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

  const sessions = new SessionManager({
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

  return { app, lines, counter };
}

const start = (app: ReturnType<typeof compose>['app'], student: string) =>
  request(app).post('/api/labs/K8S-001/start').set({ Authorization: `Developer ${student}` });

describe('per-student refusals are told apart from the platform being full', () => {
  it('records its own outcome, counter and log field, and leaves the capacity signals to real capacity', async () => {
    const { app, lines, counter } = compose();

    expect((await start(app, 'alice')).status).toBe(200);
    expect((await start(app, 'alice')).status).toBe(429);
    expect((await start(app, 'bob')).status).toBe(200);
    // The platform is now full for somebody who holds nothing.
    const full = await start(app, 'carol');
    expect(full.status).toBe(503);
    expect(full.body.error.code).toBe('LAB_CAPACITY_REACHED');

    expect(await counter('jtt_lab_start_outcome_total', { outcome: 'student_limit_reached' })).toBe(1);
    expect(await counter('jtt_lab_start_outcome_total', { outcome: 'capacity_reached' })).toBe(1);
    expect(await counter('jtt_lab_start_outcome_total', { outcome: 'provision_failed' })).toBe(0);
    expect(await counter('jtt_lab_start_outcome_total', { outcome: 'success' })).toBe(2);

    expect(await counter('jtt_session_student_limit_rejections_total', { track: 'kubernetes' })).toBe(1);
    expect(await counter('jtt_session_capacity_rejections_total', { track: 'kubernetes' })).toBe(1);

    const failures = lines.filter((line) => line.includes('lab.start.failed'));
    expect(failures).toHaveLength(2);
    expect(failures.filter((line) => line.includes('"outcome":"student_limit_reached"'))).toHaveLength(1);
    expect(failures.filter((line) => line.includes('"code":"STUDENT_SESSION_LIMIT_REACHED"'))).toHaveLength(1);
    expect(failures.filter((line) => line.includes('"outcome":"capacity_reached"'))).toHaveLength(1);
  });
});
