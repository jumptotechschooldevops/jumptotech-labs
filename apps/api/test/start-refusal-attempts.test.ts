/**
 * A refused Start is not an attempt.
 *
 * The attempt used to be opened before the start was admitted, so every refusal
 * left a FAILED attempt behind it and added one to the lab's `attempt_count`:
 * a double-clicked Start, a retry after a slow answer, a second tab, or trying
 * a second lab while one is running. A lab the student never got into was then
 * reported "in progress" on their dashboard.
 *
 * What is pinned here, through HTTP against the real session manager and the
 * real progress service:
 *
 *   - refusals (per-student limit, platform full, substrate down) record
 *     nothing at all;
 *   - two simultaneous Starts from one student leave exactly one attempt, and
 *     it is the one bound to the session that is running;
 *   - a start that was admitted and then failed to provision still leaves an
 *     honest FAILED attempt — the architecture rule the old order existed for.
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
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let labs: LabRegistry;
beforeAll(async () => {
  labs = await realCatalog();
});

function compose(options: { maxActiveSessions?: number } = {}) {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: 'start-refusal-attempts-test-secret',
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    MAX_ACTIVE_SESSIONS: String(options.maxActiveSessions ?? 5),
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
  });
  // The app's own in-memory progress service: the real one, not a double.
  const app = createApp({ registry: labs, sessions, k8s, config });

  return { app, k8s, provider, sessions };
}

type App = ReturnType<typeof compose>['app'];

const as = (student: string) => ({ Authorization: `Developer ${student}` });
const start = (app: App, student: string, labId = 'K8S-001') =>
  request(app).post(`/api/labs/${labId}/start`).set(as(student));

async function attemptsOf(app: App, student: string) {
  const res = await request(app).get('/api/me/attempts').set(as(student));
  expect(res.status).toBe(200);
  return res.body.data.attempts as Array<{ attemptId: string; labId: string; status: string }>;
}

async function labProgress(app: App, student: string, labId: string) {
  const res = await request(app).get('/api/me/progress').set(as(student));
  expect(res.status).toBe(200);
  const all = (res.body.data.tracks as Array<{ labs: Array<{ labId: string; status: string; attemptCount: number }> }>)
    .flatMap((track) => track.labs);
  return all.find((lab) => lab.labId === labId);
}

describe('a refused Start records no attempt', () => {
  it('a second Start of the running lab leaves one attempt and one attempt_count', async () => {
    const { app } = compose();

    const first = await start(app, 'alice');
    expect(first.status).toBe(200);
    const again = await start(app, 'alice');
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('STUDENT_SESSION_LIMIT_REACHED');

    const attempts = await attemptsOf(app, 'alice');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attemptId: first.body.data.attempt.attemptId,
      labId: 'K8S-001',
      status: 'IN_PROGRESS',
    });
    expect(await labProgress(app, 'alice', 'K8S-001')).toMatchObject({
      status: 'IN_PROGRESS',
      attemptCount: 1,
    });
  });

  it('trying a second lab while one is running does not mark it started', async () => {
    const { app } = compose();

    expect((await start(app, 'alice', 'K8S-001')).status).toBe(200);
    expect((await start(app, 'alice', 'K8S-002')).status).toBe(429);

    expect((await attemptsOf(app, 'alice')).map((a) => a.labId)).toEqual(['K8S-001']);
    expect(await labProgress(app, 'alice', 'K8S-002')).toMatchObject({
      status: 'NOT_STARTED',
      attemptCount: 0,
    });
  });

  it('a Start refused because the platform is full records nothing for that student', async () => {
    const { app } = compose({ maxActiveSessions: 1 });

    expect((await start(app, 'alice')).status).toBe(200);
    const full = await start(app, 'bob');
    expect(full.status).toBe(503);
    expect(full.body.error.code).toBe('LAB_CAPACITY_REACHED');

    expect(await attemptsOf(app, 'bob')).toEqual([]);
    expect(await labProgress(app, 'bob', 'K8S-001')).toMatchObject({
      status: 'NOT_STARTED',
      attemptCount: 0,
    });
  });

  it('a Start refused because the substrate is down records nothing', async () => {
    const { app, k8s } = compose();
    k8s.unreachable = 'connection refused';

    const refused = await start(app, 'alice');
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('PROVIDER_UNAVAILABLE');

    expect(await attemptsOf(app, 'alice')).toEqual([]);
  });

  it('two simultaneous Starts leave exactly one attempt, bound to the running session', async () => {
    const { app, sessions } = compose();

    const [a, b] = await Promise.all([start(app, 'alice'), start(app, 'alice')]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 429]);
    const won = a.status === 200 ? a : b;

    const attempts = await attemptsOf(app, 'alice');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.attemptId).toBe(won.body.data.attempt.attemptId);
    expect(await labProgress(app, 'alice', 'K8S-001')).toMatchObject({ attemptCount: 1 });

    // The one attempt is the running session's: a check against it lands there.
    const running = (await sessions.listOccupying()).filter((s) => s.ownerUserId !== undefined);
    expect(running).toHaveLength(1);
    expect(running[0]!.sessionId).toBe(won.body.data.session.sessionId);
  });
});

describe('an admitted start that fails to provision is still an attempt', () => {
  it('records a FAILED attempt', async () => {
    const { app, provider } = compose();
    provider.create = async () => {
      throw new Error('the cluster refused the namespace');
    };

    const failed = await start(app, 'alice');
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe('SESSION_PROVISION_FAILED');

    const attempts = await attemptsOf(app, 'alice');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ labId: 'K8S-001', status: 'FAILED' });
  });
});
