/**
 * Session events (migration 008): what the classroom view is told happened.
 *
 * The point of the table is three distinctions nothing recorded before —
 *
 *   - a Check that graded `fail` versus one that could not read the
 *     environment (`error`): the student's work versus the platform's outage;
 *   - a Start `refused` (capacity, a lab already running: nothing was built)
 *     versus one that `failed` (admitted, and broke);
 *   - an End that answered `pending` versus the `cleanup` that later confirmed
 *     the sandbox gone —
 *
 * and one promise: an event carries codes, never words. Nothing a provider
 * said, and nothing a student typed, reaches a row.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
  ContainerRuntimeError,
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  LinuxLabProvider,
  OPERATOR_END_REASON,
  ProviderRegistry,
  SessionManager,
  type ContainerInfo,
  type ContainerSpec,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes, fakeExec } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { DevelopmentIdentityResolver } from '../src/auth/resolvers.js';
import { InMemoryUserRepository } from '../src/auth/users.js';
import {
  InMemorySessionEventStore,
  MAX_EVENT_READ,
  clampLimit,
  recordSafely,
  safeCode,
  type SessionEventStore,
} from '../src/classroom/session-events.js';
import { CleanupEventListener, closedReasonCode } from '../src/classroom/cleanup-events.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'session-events-test-secret';
const as = (name: string) => `Developer ${name}`;
const RAW = 'docker: Error response from daemon: mount /var/lib/docker/overlay2/abc/merged: connect 172.18.0.5:6443';

class BreakableRuntime extends FakeContainerRuntime {
  failCreate: string | undefined;
  override async create(spec: ContainerSpec): Promise<ContainerInfo> {
    if (this.failCreate) throw new ContainerRuntimeError(this.failCreate);
    return super.create(spec);
  }
}

let registry: LabRegistry;
beforeAll(async () => {
  registry = await realCatalog();
});

function harness(env: Record<string, string> = {}) {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_MODE: 'development',
    ...env,
  } as NodeJS.ProcessEnv);
  const runtime = new BreakableRuntime();
  const k8s = new FakeKubernetes();
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime }) });
  providers.register({ provider: new KindLabProvider({ k8s, clusterName: 'jumptotech-labs', exec: fakeExec() }) });
  const store = new InMemorySessionStore();
  const events = new InMemorySessionEventStore();
  const sessions = new SessionManager({
    registry,
    providers,
    store,
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: SECRET,
    listener: new CleanupEventListener(events, async (id) => (await store.get(id))?.ownerUserId),
  });
  const users = new InMemoryUserRepository();
  const app = createApp({
    registry,
    sessions,
    k8s,
    config,
    identityResolver: new DevelopmentIdentityResolver(users),
    browserAuth: { users },
    sessionEvents: events,
  });
  return { app, runtime, k8s, sessions, events, users };
}

async function startLab(app: ReturnType<typeof harness>['app'], lab: string, who: string) {
  const res = await request(app).post(`/api/labs/${lab}/start`).set('Authorization', as(who));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.session.sessionId as string;
}

describe('recording', () => {
  it('Start, a graded Check and End: ok, fail, then end ok and the cleanup that confirmed it', async () => {
    const { app, events, users } = harness();
    const sessionId = await startLab(app, 'LINUX-001', 'amy');
    const amy = (await users.list()).find((user) => user.subject === 'amy')!;

    const check = await request(app).post(`/api/sessions/${sessionId}/check`).set('Authorization', as('amy'));
    expect(check.status).toBe(200);
    expect(check.body.data.passed).toBe(false);

    const end = await request(app).delete(`/api/sessions/${sessionId}`).set('Authorization', as('amy'));
    expect(end.status).toBe(200);

    const timeline = (await events.listForSession(sessionId, 50)).reverse();
    expect(timeline.map((event) => `${event.operation}:${event.outcome}`)).toEqual([
      'start:ok',
      'check:fail',
      'cleanup:ok',
      'end:ok',
    ]);
    for (const event of timeline) {
      expect(event.ownerUserId).toBe(amy.userId);
      expect(event.labId).toBe('LINUX-001');
    }
    expect(timeline.find((event) => event.operation === 'cleanup')!.code).toBe('ENDED_BY_STUDENT');
    // The student asked for everything but the cleanup, which the platform confirmed.
    expect(timeline.filter((event) => event.operation !== 'cleanup').every((event) => event.actorUserId === amy.userId)).toBe(true);
    expect(timeline.find((event) => event.operation === 'cleanup')!.actorUserId).toBeUndefined();
  });

  it('a Check that cannot read the environment is `error` with its code — not a failed grade', async () => {
    const { app, events, k8s } = harness();
    const sessionId = await startLab(app, 'K8S-001', 'ben');
    k8s.unreachable = RAW;

    const check = await request(app).post(`/api/sessions/${sessionId}/check`).set('Authorization', as('ben'));
    expect(check.status).toBe(503);

    const [latest] = await events.listForSession(sessionId, 1);
    expect(latest).toMatchObject({ operation: 'check', outcome: 'error', code: 'ENVIRONMENT_UNREACHABLE' });
    expect(JSON.stringify(await events.listForSession(sessionId, 50))).not.toContain('172.18.0.5');
  });

  it('a Start the runtime breaks is `failed` against its session; the provider’s words are not stored', async () => {
    const { app, events, runtime } = harness();
    runtime.failCreate = RAW;
    const res = await request(app).post('/api/labs/LINUX-001/start').set('Authorization', as('cai'));
    expect(res.status).toBe(503);

    const [start] = await events.listRecent({ sinceIso: new Date(0).toISOString(), outcomes: ['failed'], limit: 10 });
    expect(start).toMatchObject({ operation: 'start', outcome: 'failed', labId: 'LINUX-001' });
    expect(start!.sessionId).toMatch(/^sess-/);
    expect(start!.code).toMatch(/^[A-Z_]+$/);
    expect(JSON.stringify(start)).not.toMatch(/overlay2|172\.18|daemon/);
  });

  it('a Start refused for capacity is `refused` with no session, attributed to the student who was turned away', async () => {
    const { app, events, users } = harness({ MAX_ACTIVE_SESSIONS: '1' });
    await startLab(app, 'LINUX-001', 'dee');
    const refused = await request(app).post('/api/labs/LINUX-001/start').set('Authorization', as('eve'));
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('LAB_CAPACITY_REACHED');

    const eve = (await users.list()).find((user) => user.subject === 'eve')!;
    const [event] = await events.listForOwner(eve.userId, 5);
    expect(event).toMatchObject({ operation: 'start', outcome: 'refused', code: 'LAB_CAPACITY_REACHED' });
    expect(event!.sessionId).toBeUndefined();
  });

  it('a failed Reset is `failed` with its code; the retry that works is `ok`', async () => {
    const { app, events, runtime } = harness();
    const sessionId = await startLab(app, 'LINUX-001', 'fay');
    runtime.failCreate = RAW;
    const broken = await request(app).post(`/api/sessions/${sessionId}/reset`).set('Authorization', as('fay'));
    expect(broken.status).toBe(503);
    runtime.failCreate = undefined;
    const retried = await request(app).post(`/api/sessions/${sessionId}/reset`).set('Authorization', as('fay'));
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);

    const resets = (await events.listForSession(sessionId, 50)).filter((event) => event.operation === 'reset').reverse();
    expect(resets.map((event) => event.outcome)).toEqual(['failed', 'ok']);
    expect(resets[0]!.code).toMatch(/^[A-Z_]+$/);
  });

  it('a Check refused because the lab is not ready says so, and another student’s request records nothing', async () => {
    const { app, events, runtime } = harness();
    const sessionId = await startLab(app, 'LINUX-001', 'gus');
    runtime.failCreate = RAW;
    await request(app).post(`/api/sessions/${sessionId}/reset`).set('Authorization', as('gus'));

    const check = await request(app).post(`/api/sessions/${sessionId}/check`).set('Authorization', as('gus'));
    expect(check.status).toBe(409);
    const before = await events.listForSession(sessionId, 50);
    expect(before[0]).toMatchObject({ operation: 'check', outcome: 'refused', code: 'SESSION_NOT_ACTIVE' });

    // Someone else's attempt is a 404 at the guard, before anything is recorded.
    const intruder = await request(app).post(`/api/sessions/${sessionId}/check`).set('Authorization', as('hal'));
    expect(intruder.status).toBe(404);
    expect(await events.listForSession(sessionId, 50)).toHaveLength(before.length);
  });
});

describe('the store', () => {
  it('keeps codes and drops prose', () => {
    expect(safeCode('ENVIRONMENT_UNREACHABLE')).toBe('ENVIRONMENT_UNREACHABLE');
    expect(safeCode(RAW)).toBe('unknown');
    expect(safeCode('')).toBeUndefined();
    expect(safeCode(undefined)).toBeUndefined();
    expect(safeCode({ toString: () => 'X' })).toBeUndefined();
  });

  it('never reads more than the ceiling, whatever it is asked for', async () => {
    expect(clampLimit(10_000)).toBe(MAX_EVENT_READ);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(Number.NaN)).toBe(50);
    const store = new InMemorySessionEventStore();
    for (let i = 0; i < MAX_EVENT_READ + 20; i += 1) {
      await store.record({ sessionId: 'sess-1', labId: 'LINUX-001', operation: 'check', outcome: 'fail' });
    }
    expect(await store.listForSession('sess-1', 10_000)).toHaveLength(MAX_EVENT_READ);
  });

  it('answers a classroom’s latest outcomes in one read', async () => {
    const store = new InMemorySessionEventStore();
    await store.record({ sessionId: 'sess-a', labId: 'L', operation: 'check', outcome: 'fail' });
    await store.record({ sessionId: 'sess-a', labId: 'L', operation: 'check', outcome: 'error', code: 'X' });
    await store.record({ sessionId: 'sess-a', labId: 'L', operation: 'reset', outcome: 'ok' });
    await store.record({ sessionId: 'sess-b', labId: 'L', operation: 'check', outcome: 'pass' });
    const latest = await store.latestForSessions(['sess-a', 'sess-b', 'sess-none']);
    expect(latest.get('sess-a')?.check).toMatchObject({ outcome: 'error', code: 'X' });
    expect(latest.get('sess-a')?.reset).toMatchObject({ outcome: 'ok' });
    expect(latest.get('sess-b')?.check).toMatchObject({ outcome: 'pass' });
    expect(latest.has('sess-none')).toBe(false);
  });

  it('purges by age only', async () => {
    let now = Date.parse('2026-09-01T00:00:00Z');
    const store = new InMemorySessionEventStore(() => now);
    await store.record({ sessionId: 'old', labId: 'L', operation: 'start', outcome: 'ok' });
    now += 40 * 86_400_000;
    await store.record({ sessionId: 'new', labId: 'L', operation: 'start', outcome: 'ok' });
    expect(await store.purgeOlderThan(new Date(now - 30 * 86_400_000).toISOString())).toBe(1);
    expect(await store.listForSession('old', 5)).toHaveLength(0);
    expect(await store.listForSession('new', 5)).toHaveLength(1);
  });

  it('a store that throws never fails the operation, and the failure is logged', async () => {
    const broken: SessionEventStore = {
      ...new InMemorySessionEventStore(),
      record: async () => {
        throw new Error('db down');
      },
    } as unknown as SessionEventStore;
    const warned: string[] = [];
    await expect(
      recordSafely(broken, { warn: (event: string) => void warned.push(event) } as never, {
        labId: 'L',
        operation: 'check',
        outcome: 'pass',
      }),
    ).resolves.toBeUndefined();
    expect(warned).toEqual(['session_event.write_failed']);
  });

  it('names why a session closed with a code, never the reason text', () => {
    expect(closedReasonCode({ status: 'ENDED', reason: 'ended by student' })).toBe('ENDED_BY_STUDENT');
    expect(closedReasonCode({ status: 'EXPIRED', reason: OPERATOR_END_REASON })).toBe('ENDED_BY_STAFF');
    expect(closedReasonCode({ status: 'EXPIRED', reason: 'idle for more than 1200s' })).toBe('IDLE_TIMEOUT');
    expect(closedReasonCode({ status: 'EXPIRED', reason: 'maximum lifetime reached' })).toBe('LIFETIME_REACHED');
  });
});
