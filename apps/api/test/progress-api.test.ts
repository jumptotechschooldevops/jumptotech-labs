/**
 * PLATFORM-005 — persistent progress and lab attempts, through the real API.
 *
 * The storage contract itself is proved in `services/progress` (against both
 * the in-memory store and a real PostgreSQL). What is proved here is the thing
 * a student actually experiences: pressing Start, Check, Reset and End through
 * HTTP produces the right history, and destroying the sandbox does not touch it.
 *
 * The cluster and the container runtime are faked; the session, verifier and
 * persistence layers are the real ones.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';
import {
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
  SessionReaper,
  TerraformLabProvider,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes, podSnapshot } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { DevStudentIdentity, InMemoryProgressRepository, ProgressService } from '@jumptotech/progress';
import { BrokenProgressRepository } from '@jumptotech/progress/testing';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AttemptClosingListener } from '../src/progress.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'integration-test-secret-value';

/**
 * The end state LINUX-001 asks for, so a check can be made to pass.
 *
 * This mirrors `labs/linux/linux-001-files/lab.yaml` and nothing else: the
 * tree is built, and `app.log` lives *only* under `archive`. The lab's last
 * requirement is `path_absent` on `/home/student/project/app.log` — the log
 * had to be moved, not copied — so that path is deliberately never written.
 */
const LINUX_001_SOLUTION: Record<string, Parameters<FakeContainerRuntime['put']>[2]> = {
  '/home/student/project': { type: 'directory', mode: '755' },
  '/home/student/project/config.txt': { type: 'file', mode: '644' },
  '/home/student/project/archive': { type: 'directory', mode: '755' },
  '/home/student/project/archive/app.log': { type: 'file', mode: '644', content: 'boot\n' },
};

function completeLinuxLab(runtime: FakeContainerRuntime, sandbox: string): void {
  for (const [pathName, entry] of Object.entries(LINUX_001_SOLUTION)) {
    runtime.put(sandbox, pathName, entry);
  }
}

let registry: LabRegistry;

beforeAll(async () => {
  registry = new LabRegistry(path.join(repoRoot, 'labs'));
  await registry.load();
  expect(registry.loadErrors).toEqual([]);

  /*
   * Pin the helper above to the lab on disk.
   *
   * A completion test that silently stops completing anything fails eight
   * assertions away from the cause — an attempt that reads IN_PROGRESS, then
   * ENDED, then EXPIRED, none of which is a progress bug. If LINUX-001's
   * requirements move, this is the assertion that should break.
   */
  const requirements = registry.get('LINUX-001').requirements;
  const pathOf = (r: (typeof requirements)[number]) => ('path' in r ? r.path : r.type);
  expect(requirements.filter((r) => r.type !== 'path_absent').map(pathOf).sort()).toEqual(
    Object.keys(LINUX_001_SOLUTION).sort(),
  );
  for (const requirement of requirements.filter((r) => r.type === 'path_absent')) {
    expect(Object.keys(LINUX_001_SOLUTION)).not.toContain(pathOf(requirement));
  }
});

/** Catalog totals come from the labs on disk, never from a remembered number. */
const catalogTotal = (): number => registry.tracks().reduce((sum, t) => sum + t.labCount, 0);
const trackTotal = (track: string): number => registry.labsForTrack(track).length;

interface Harness {
  app: Express;
  sessions: SessionManager;
  providers: ProviderRegistry;
  progress: ProgressService;
  runtime: FakeContainerRuntime;
  k8s: FakeKubernetes;
}

function buildApp(options: { repository?: InMemoryProgressRepository | BrokenProgressRepository } = {}): Harness {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    // Two students on one laptop is the only way to exercise per-student
    // isolation before authentication exists. Development only.
    DEV_STUDENT_HEADER_ENABLED: 'true',
  } as NodeJS.ProcessEnv);

  const k8s = new FakeKubernetes();
  const runtime = new FakeContainerRuntime();

  const kubernetes = new KindLabProvider({
    k8s,
    clusterName: 'jumptotech-labs',
    resetDrainTimeoutMs: 2_000,
    destroyTimeoutMs: 2_000,
    sleep: async () => undefined,
    waitForRequirements: async () => ({ ok: true, checks: [] }),
  });
  kubernetes.execute = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.34.2' } }),
    stderr: '',
    timedOut: false,
  });

  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: kubernetes });
  providers.register({ provider: new LinuxLabProvider({ runtime }) });
  providers.register({ provider: new TerraformLabProvider({ runtime }) });

  const progress = new ProgressService({
    repository: options.repository ?? new InMemoryProgressRepository(),
  });

  const sessions = new SessionManager({
    registry,
    providers,
    store: new InMemorySessionStore(),
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: SECRET,
    // The seam PLATFORM-005 hangs off: the orchestrator tells us a sandbox is
    // gone, and the attempt is closed. It never learns what an attempt is.
    listener: new AttemptClosingListener(progress),
  });

  const app = createApp({
    registry,
    sessions,
    k8s,
    config,
    progress: {
      progress,
      identity: new DevStudentIdentity({
        studentId: config.progress.devStudentId,
        allowHeaderOverride: true,
      }),
      store: 'memory',
      // Accurate: this harness is memory-backed, and the API must say so.
      durable: false,
    },
  });

  return { app, sessions, providers, progress, runtime, k8s };
}

/** Start a lab as a given student, returning the session and attempt payloads. */
/**
 * Who a request is, as a credential rather than as a claim — PLATFORM-010.
 *
 * These tests used `x-dev-student-id`, a header the *client* chose. That is
 * precisely what no longer selects a student: learning history follows the
 * authenticated user, so a student is now named the only way anything names one
 * — by authenticating as them.
 */
const asStudent = (name: string) => `Developer ${name}`;

async function start(app: Express, labId: string, student?: string) {
  const call = request(app).post(`/api/labs/${labId}/start`);
  if (student) call.set('Authorization', asStudent(student));
  const response = await call;
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as {
    session: { sessionId: string; sandboxRef: string };
    attempt: Record<string, unknown>;
  };
}

function as(app: Express, method: 'get' | 'post', url: string, student?: string) {
  const call = request(app)[method](url);
  return student ? call.set('Authorization', asStudent(student)) : call;
}

// --- starting a lab records an attempt (test requirement 2) ------------------

describe('starting a lab records an attempt', () => {
  it('creates an IN_PROGRESS attempt bound to the session', async () => {
    const { app } = buildApp();
    const { attempt } = await start(app, 'K8S-001');

    expect(attempt.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(attempt).toMatchObject({
      labId: 'K8S-001',
      track: 'kubernetes',
      status: 'IN_PROGRESS',
      checkCount: 0,
      resetCount: 0,
      completedAt: null,
      endedAt: null,
    });
    // The session id is the capability for the sandbox; a history payload has
    // no business carrying one.
    expect(attempt.sessionId).toBeUndefined();
  });

  it('shows the lab as in progress on the dashboard immediately', async () => {
    const { app } = buildApp();
    await start(app, 'K8S-001');

    const response = await request(app).get('/api/me/progress');
    expect(response.status).toBe(200);
    const kubernetes = response.body.data.tracks.find(
      (track: { track: string }) => track.track === 'kubernetes',
    );
    expect(kubernetes.total).toBe(trackTotal('kubernetes'));
    expect(kubernetes.completed).toBe(0);
    expect(kubernetes.inProgress).toBe(1);
    expect(
      kubernetes.labs.find((lab: { labId: string }) => lab.labId === 'K8S-001').status,
    ).toBe('IN_PROGRESS');
    expect(
      kubernetes.labs.find((lab: { labId: string }) => lab.labId === 'K8S-002').status,
    ).toBe('NOT_STARTED');
  });

  it('records a FAILED attempt when the environment cannot be created', async () => {
    const { app, k8s } = buildApp();
    k8s.unreachable = 'connection refused';

    const failed = await request(app).post('/api/labs/K8S-001/start');
    expect(failed.status).toBeGreaterThanOrEqual(500);

    const attempts = await request(app).get('/api/me/attempts');
    expect(attempts.body.data.attempts).toHaveLength(1);
    expect(attempts.body.data.attempts[0]).toMatchObject({
      labId: 'K8S-001',
      status: 'FAILED',
    });
    // An attempt that never got a sandbox is not a completion, and is not
    // counted as one anywhere.
    const progress = await request(app).get('/api/me/progress');
    expect(progress.body.data.overall.completed).toBe(0);
    expect(progress.body.data.overall.inProgress).toBe(1);
  });
});

// --- check solution (test requirements 3–4) ---------------------------------

describe('Check Solution persists completion', () => {
  it('marks the attempt PASSED and records the completion once', async () => {
    const { app, runtime } = buildApp();
    const { session, attempt } = await start(app, 'LINUX-001');

    const failing = await request(app).post(`/api/sessions/${session.sessionId}/check`);
    expect(failing.body.data.passed).toBe(false);
    expect(failing.body.data.attempt).toMatchObject({ status: 'IN_PROGRESS', checkCount: 1 });
    expect(failing.body.data.newlyCompleted).toBe(false);

    completeLinuxLab(runtime, session.sandboxRef);

    const passing = await request(app).post(`/api/sessions/${session.sessionId}/check`);
    expect(passing.body.data.passed, JSON.stringify(passing.body.data.checks)).toBe(true);
    expect(passing.body.data.attempt).toMatchObject({
      attemptId: attempt.attemptId,
      status: 'PASSED',
      checkCount: 2,
    });
    expect(passing.body.data.newlyCompleted).toBe(true);
    expect(passing.body.data.attempt.completedAt).not.toBeNull();

    const progress = await request(app).get('/api/me/progress');
    const linux = progress.body.data.tracks.find((t: { track: string }) => t.track === 'linux');
    expect(linux.completed).toBe(1);
    expect(linux.labs[0]).toMatchObject({ labId: 'LINUX-001', status: 'COMPLETED' });
  });

  it('does not duplicate the completion when PASS is repeated', async () => {
    const { app, runtime } = buildApp();
    const { session } = await start(app, 'LINUX-001');
    completeLinuxLab(runtime, session.sandboxRef);

    const first = await request(app).post(`/api/sessions/${session.sessionId}/check`);
    const second = await request(app).post(`/api/sessions/${session.sessionId}/check`);
    const third = await request(app).post(`/api/sessions/${session.sessionId}/check`);

    expect(first.body.data.newlyCompleted).toBe(true);
    expect(second.body.data.newlyCompleted).toBe(false);
    expect(third.body.data.newlyCompleted).toBe(false);
    // Every check is counted — three checks really did happen…
    expect(third.body.data.attempt.checkCount).toBe(3);
    // …and the completion timestamp is still the first one.
    expect(third.body.data.attempt.completedAt).toBe(first.body.data.attempt.completedAt);

    const attempts = await request(app).get('/api/me/attempts');
    expect(attempts.body.data.attempts).toHaveLength(1);

    const progress = await request(app).get('/api/me/progress');
    expect(progress.body.data.overall.completed).toBe(1);
    const linux = progress.body.data.tracks.find((t: { track: string }) => t.track === 'linux');
    expect(linux.labs[0].completionCount).toBe(1);
  });

  it('does not record a check when the environment could not be read', async () => {
    const { app, k8s } = buildApp();
    const { session } = await start(app, 'K8S-001');

    k8s.unreachable = 'connection refused';
    const broken = await request(app).post(`/api/sessions/${session.sessionId}/check`);
    expect(broken.status).toBe(503);

    k8s.unreachable = undefined;
    const attempt = await request(app).get('/api/me/attempts');
    // A check that could not run is not a check the student made.
    expect(attempt.body.data.attempts[0].checkCount).toBe(0);
  });
});

// --- reset (test requirement 5) ---------------------------------------------

describe('resetting a lab', () => {
  it('increments reset_count and erases nothing', async () => {
    const { app, runtime } = buildApp();
    const { session, attempt } = await start(app, 'LINUX-001');
    completeLinuxLab(runtime, session.sandboxRef);
    await request(app).post(`/api/sessions/${session.sessionId}/check`);

    const first = await request(app).post(`/api/sessions/${session.sessionId}/reset`);
    expect(first.status).toBe(200);
    expect(first.body.data.attempt).toMatchObject({ resetCount: 1, status: 'PASSED' });

    const second = await request(app).post(`/api/sessions/${session.sessionId}/reset`);
    expect(second.body.data.attempt.resetCount).toBe(2);

    // The sandbox is genuinely back to its starting state…
    const afterReset = await request(app).post(`/api/sessions/${session.sessionId}/check`);
    expect(afterReset.body.data.passed).toBe(false);
    // …and the completion earned before the reset is untouched.
    expect(afterReset.body.data.attempt).toMatchObject({
      attemptId: attempt.attemptId,
      status: 'PASSED',
      resetCount: 2,
    });
    const progress = await request(app).get('/api/me/progress');
    expect(progress.body.data.overall.completed).toBe(1);
  });
});

// --- teardown preserves history (test requirements 1, 6, 7) ------------------

describe('the sandbox is disposable, the history is not', () => {
  it('keeps the attempt and the completion after End Lab', async () => {
    const { app, runtime } = buildApp();
    const { session } = await start(app, 'LINUX-001');
    completeLinuxLab(runtime, session.sandboxRef);
    await request(app).post(`/api/sessions/${session.sessionId}/check`);

    const ended = await request(app).delete(`/api/sessions/${session.sessionId}`);
    expect(ended.status).toBe(200);
    // The container really is gone.
    expect(runtime.containers.has(session.sandboxRef)).toBe(false);
    // The attempt records both facts: it passed, and its sandbox died.
    expect(ended.body.data.attempt).toMatchObject({ status: 'PASSED' });
    expect(ended.body.data.attempt.endedAt).not.toBeNull();

    const progress = await request(app).get('/api/me/progress');
    expect(progress.body.data.overall.completed).toBe(1);
    const attempts = await request(app).get('/api/me/attempts');
    expect(attempts.body.data.attempts[0]).toMatchObject({ labId: 'LINUX-001', status: 'PASSED' });
  });

  it('records ENDED for a lab the student left without passing', async () => {
    const { app, runtime } = buildApp();
    const { session } = await start(app, 'LINUX-001');
    await request(app).post(`/api/sessions/${session.sessionId}/check`);

    await request(app).delete(`/api/sessions/${session.sessionId}`);
    expect(runtime.containers.has(session.sandboxRef)).toBe(false);

    const attempts = await request(app).get('/api/me/attempts');
    expect(attempts.body.data.attempts[0]).toMatchObject({
      status: 'ENDED',
      checkCount: 1,
      completedAt: null,
    });
    const progress = await request(app).get('/api/me/progress');
    expect(progress.body.data.overall.completed).toBe(0);
    expect(progress.body.data.overall.inProgress).toBe(1);
  });

  it('preserves history when the reaper expires the session', async () => {
    const { app, sessions, providers, k8s } = buildApp();
    const { session } = await start(app, 'K8S-001');
    const namespace = session.sandboxRef;
    expect(k8s.namespaces.has(namespace)).toBe(true);

    // Two hours later, well past the absolute deadline: the reaper collects it
    // exactly as it does in production — the student is not involved at all.
    const reaper = new SessionReaper({
      sessions,
      providers,
      intervalMs: 60_000,
      now: () => Date.now() + 2 * 60 * 60_000,
      log: () => undefined,
    });
    const sweep = await reaper.sweep();

    expect(sweep.removed).toContain(namespace);
    expect(k8s.namespaces.has(namespace)).toBe(false);

    const attempts = await request(app).get('/api/me/attempts');
    expect(attempts.body.data.attempts[0]).toMatchObject({
      labId: 'K8S-001',
      status: 'EXPIRED',
    });
    expect(attempts.body.data.attempts[0].endedAt).not.toBeNull();
    // The lab still counts as attempted; the student can come back to it.
    const progress = await request(app).get('/api/me/progress');
    expect(progress.body.data.overall.inProgress).toBe(1);
  });

  it('keeps a completion when the passed lab is later expired', async () => {
    const { app, sessions, providers, runtime } = buildApp();
    const { session } = await start(app, 'LINUX-001');
    completeLinuxLab(runtime, session.sandboxRef);
    await request(app).post(`/api/sessions/${session.sessionId}/check`);

    const reaper = new SessionReaper({
      sessions,
      providers,
      intervalMs: 60_000,
      now: () => Date.now() + 2 * 60 * 60_000,
      log: () => undefined,
    });
    await reaper.sweep();
    expect(runtime.containers.has(session.sandboxRef)).toBe(false);

    const attempts = await request(app).get('/api/me/attempts');
    // Infrastructure expired; the learning outcome did not.
    expect(attempts.body.data.attempts[0].status).toBe('PASSED');
    expect(attempts.body.data.attempts[0].endedAt).not.toBeNull();
    const progress = await request(app).get('/api/me/progress');
    expect(progress.body.data.overall.completed).toBe(1);
  });

  it('serves the whole history after every sandbox is gone', async () => {
    const { app, runtime, k8s } = buildApp();

    const linux = await start(app, 'LINUX-001');
    completeLinuxLab(runtime, linux.session.sandboxRef);
    await request(app).post(`/api/sessions/${linux.session.sessionId}/check`);
    await request(app).delete(`/api/sessions/${linux.session.sessionId}`);

    const kubernetes = await start(app, 'K8S-001');
    await request(app).delete(`/api/sessions/${kubernetes.session.sessionId}`);

    expect(runtime.containers.size).toBe(0);
    expect(k8s.namespaces.has(kubernetes.session.sandboxRef)).toBe(false);

    const attempts = await request(app).get('/api/me/attempts');
    expect(attempts.body.data.attempts.map((a: { labId: string }) => a.labId)).toEqual([
      'K8S-001',
      'LINUX-001',
    ]);
    const progress = await request(app).get('/api/me/progress');
    expect(progress.body.data.overall.completed).toBe(1);
  });
});

// --- hints (test requirements 8–9) ------------------------------------------

describe('hint usage', () => {
  it('persists a revealed hint against the attempt', async () => {
    const { app } = buildApp();
    const { session, attempt } = await start(app, 'K8S-001');

    const first = await request(app)
      .post(`/api/sessions/${session.sessionId}/hints`)
      .send({ level: 1 });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ recorded: true, persisted: true, revealedCount: 1 });

    const second = await request(app)
      .post(`/api/sessions/${session.sessionId}/hints`)
      .send({ level: 2 });
    expect(second.body.data.revealedCount).toBe(2);

    const detail = await request(app).get(`/api/me/attempts/${String(attempt.attemptId)}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.attempt.hintsUsed).toBe(2);
    expect(detail.body.data.attempt.hints.map((h: { level: number }) => h.level)).toEqual([1, 2]);
  });

  it('ignores a replayed hint event', async () => {
    const { app } = buildApp();
    const { session, attempt } = await start(app, 'K8S-001');

    const first = await request(app)
      .post(`/api/sessions/${session.sessionId}/hints`)
      .send({ level: 1 });
    const replay = await request(app)
      .post(`/api/sessions/${session.sessionId}/hints`)
      .send({ level: 1 });
    const again = await request(app)
      .post(`/api/sessions/${session.sessionId}/hints`)
      .send({ level: 1 });

    expect(first.body.data.recorded).toBe(true);
    expect(replay.body.data.recorded).toBe(false);
    expect(again.body.data.recorded).toBe(false);
    expect(again.body.data.revealedCount).toBe(1);
    expect(replay.body.data.hint.revealedAt).toBe(first.body.data.hint.revealedAt);

    const detail = await request(app).get(`/api/me/attempts/${String(attempt.attemptId)}`);
    expect(detail.body.data.attempt.hintsUsed).toBe(1);
  });

  it('rejects a nonsensical hint level', async () => {
    const { app } = buildApp();
    const { session } = await start(app, 'K8S-001');

    for (const level of [0, -1, 'two', 999]) {
      const response = await request(app)
        .post(`/api/sessions/${session.sessionId}/hints`)
        .send({ level });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_HINT_INDEX');
    }
  });

  it('refuses to record a hint against an unknown session', async () => {
    const { app } = buildApp();
    const response = await request(app)
      .post('/api/sessions/sess-0123456789abcdef/hints')
      .send({ level: 1 });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('SESSION_NOT_FOUND');
  });
});

// --- students are independent (test requirement 10) --------------------------

describe('students have independent progress', () => {
  it('keeps two development students entirely separate', async () => {
    const { app, runtime } = buildApp();

    const alice = await start(app, 'LINUX-001', 'alice');
    completeLinuxLab(runtime, alice.session.sandboxRef);
    // The check runs as Alice: since PLATFORM-010 nobody else may check her
    // session, which is the same rule the authorization suite proves.
    await as(app, 'post', `/api/sessions/${alice.session.sessionId}/check`, 'alice');

    const bob = await start(app, 'LINUX-001', 'bob');

    const aliceProgress = await as(app, 'get', '/api/me/progress', 'alice');
    const bobProgress = await as(app, 'get', '/api/me/progress', 'bob');

    expect(aliceProgress.body.data.overall.completed).toBe(1);
    expect(bobProgress.body.data.overall.completed).toBe(0);
    expect(bobProgress.body.data.overall.inProgress).toBe(1);

    const bobAttempts = await as(app, 'get', '/api/me/attempts', 'bob');
    expect(bobAttempts.body.data.attempts).toHaveLength(1);
    expect(bobAttempts.body.data.attempts[0].attemptId).toBe(bob.attempt.attemptId);

    // Knowing another student's attempt id gets you nothing.
    const stolen = await as(
      app,
      'get',
      `/api/me/attempts/${String(alice.attempt.attemptId)}`,
      'bob',
    );
    expect(stolen.status).toBe(404);
  });

  it('never takes a student id from a query parameter, a body, or a header', async () => {
    const { app } = buildApp();

    /*
     * Every way a client might try to name somebody else — including the
     * development header, which used to work and deliberately no longer does.
     * The attempt is attributed to whoever authenticated, and nothing else.
     */
    const response = await request(app)
      .post('/api/labs/K8S-001/start?studentId=someone-else')
      .set('Authorization', asStudent('alice'))
      .set('x-dev-student-id', 'someone-else')
      .send({ studentId: 'someone-else', student: 'someone-else' });
    expect(response.status).toBe(200);

    // The named victim has nothing, because naming somebody achieves nothing.
    const victim = await as(app, 'get', '/api/me/attempts', 'someone-else');
    expect(victim.body.data.attempts).toEqual([]);

    // Alice has it, and the header did not move it.
    const actual = await request(app)
      .get('/api/me/attempts')
      .set('Authorization', asStudent('alice'))
      .set('x-dev-student-id', 'someone-else');
    expect(actual.body.data.attempts).toHaveLength(1);
    expect(actual.body.data.student.authenticated).toBe(true);
    expect(actual.body.data.student.identitySource).toBe('authenticated');
  });

  it('gives each authenticated identity its own history', async () => {
    const { app } = buildApp();

    await start(app, 'K8S-001', 'alice');

    const alice = await as(app, 'get', '/api/me/attempts', 'alice');
    const bob = await as(app, 'get', '/api/me/attempts', 'bob');

    expect(alice.body.data.attempts).toHaveLength(1);
    expect(bob.body.data.attempts).toEqual([]);
    // Two identities, two student ids, neither chosen by the client.
    expect(alice.body.data.student.studentId).not.toBe(bob.body.data.student.studentId);
  });
});

// --- every track (test requirements 11–13) -----------------------------------

describe('progress works for every track', () => {
  it('records Kubernetes, Linux and Terraform completions the same way', async () => {
    const { app, runtime, k8s } = buildApp();

    // Kubernetes: the lab passes once the expected Pod is running.
    const kubernetes = await start(app, 'K8S-001');
    k8s.pods.set(kubernetes.session.sandboxRef, [
      podSnapshot({ namespace: kubernetes.session.sandboxRef }),
    ]);
    const k8sCheck = await request(app).post(`/api/sessions/${kubernetes.session.sessionId}/check`);
    expect(k8sCheck.body.data.passed, JSON.stringify(k8sCheck.body.data.checks)).toBe(true);

    // Linux: the lab passes once the filesystem matches.
    const linux = await start(app, 'LINUX-001');
    completeLinuxLab(runtime, linux.session.sandboxRef);
    const linuxCheck = await request(app).post(`/api/sessions/${linux.session.sessionId}/check`);
    expect(linuxCheck.body.data.passed).toBe(true);

    // Terraform: the lab passes once the state file shows the applied resource.
    const terraform = await start(app, 'TF-001');
    const tf = (relative: string, entry: Parameters<FakeContainerRuntime['put']>[2]) =>
      runtime.put(terraform.session.sandboxRef, `/home/student/${relative}`, entry);
    tf('terraform/.terraform', { type: 'directory', mode: '755' });
    tf('terraform/.terraform.lock.hcl', {
      type: 'file',
      content: 'provider "registry.terraform.io/hashicorp/local" {}',
    });
    tf('terraform/terraform.tfstate', {
      type: 'file',
      content: JSON.stringify({
        version: 4,
        terraform_version: '1.9.8',
        outputs: { manifest_path: { value: 'build/manifest.txt', type: 'string' } },
        resources: [
          {
            mode: 'managed',
            type: 'local_file',
            name: 'manifest',
            provider: 'provider["registry.terraform.io/hashicorp/local"]',
            instances: [{ schema_version: 0, attributes: { filename: 'build/manifest.txt' } }],
          },
        ],
      }),
    });
    tf('terraform/build/manifest.txt', { type: 'file', content: 'service=ledger-api\n' });
    const tfCheck = await request(app).post(`/api/sessions/${terraform.session.sessionId}/check`);
    expect(tfCheck.body.data.passed, JSON.stringify(tfCheck.body.data.checks)).toBe(true);

    const progress = await request(app).get('/api/me/progress');
    const byTrack = Object.fromEntries(
      progress.body.data.tracks.map((track: { track: string; completed: number; total: number }) => [
        track.track,
        `${track.completed}/${track.total}`,
      ]),
    );
    // Every discovered track appears on the dashboard with its own total. The
    // three named here are named because this test completed a lab in each;
    // any other track — including one added later — shows up as 0/n rather
    // than failing an assertion that had nothing to do with it.
    const completedTracks = new Set(['kubernetes', 'linux', 'terraform']);
    expect(Object.keys(byTrack).sort()).toEqual(
      registry
        .tracks()
        .map((t) => t.track)
        .sort(),
    );
    for (const { track } of registry.tracks()) {
      expect(byTrack[track], track).toBe(
        `${completedTracks.has(track) ? 1 : 0}/${trackTotal(track)}`,
      );
    }
    expect(progress.body.data.overall).toMatchObject({ completed: 3, total: catalogTotal() });
  });
});

// --- the API surface ---------------------------------------------------------

describe('the progress API', () => {
  it('describes an authenticated identity honestly', async () => {
    const { app } = buildApp();
    const response = await request(app).get('/api/me').set('Authorization', asStudent('alice'));

    expect(response.status).toBe(200);
    expect(response.body.data.student).toMatchObject({
      authenticated: true,
      identitySource: 'authenticated',
      // This harness is memory-backed and the API says so rather than
      // implying the history is safe.
      durable: false,
    });
    // The student id is derived server-side and is nothing the caller chose.
    expect(response.body.data.student.studentId).not.toBe('alice');
    /*
     * No development notice for somebody who really signed in. It said "there
     * is no authentication yet", and repeating that to an authenticated caller
     * would be exactly the kind of dishonesty it existed to prevent.
     */
    expect(response.body.data.notice).toBeUndefined();
  });

  it('serves an empty, honest dashboard for a student with no history', async () => {
    const { app } = buildApp();
    const response = await request(app).get('/api/me/progress');

    expect(response.status).toBe(200);
    expect(response.body.data.overall).toMatchObject({
      completed: 0,
      total: catalogTotal(),
      percent: 0,
    });
    expect(response.body.data.tracks).toHaveLength(registry.tracks().length);
    expect(
      (await request(app).get('/api/me/attempts')).body.data.attempts,
    ).toEqual([]);
  });

  it('bounds the attempt page and orders it newest first', async () => {
    const { app } = buildApp();
    for (const labId of ['K8S-001', 'K8S-002', 'K8S-003']) {
      await start(app, labId);
    }

    const all = await request(app).get('/api/me/attempts');
    expect(all.body.data.attempts.map((a: { labId: string }) => a.labId)).toEqual([
      'K8S-003',
      'K8S-002',
      'K8S-001',
    ]);

    const limited = await request(app).get('/api/me/attempts?limit=2');
    expect(limited.body.data.attempts).toHaveLength(2);
    const silly = await request(app).get('/api/me/attempts?limit=99999');
    expect(silly.body.data.attempts).toHaveLength(3);
  });

  it('never exposes a session id or a database internal', async () => {
    const { app, runtime } = buildApp();
    const { session, attempt } = await start(app, 'LINUX-001');
    completeLinuxLab(runtime, session.sandboxRef);
    await request(app).post(`/api/sessions/${session.sessionId}/check`);
    await request(app).post(`/api/sessions/${session.sessionId}/hints`).send({ level: 1 });

    const bodies = await Promise.all([
      request(app).get('/api/me'),
      request(app).get('/api/me/progress'),
      request(app).get('/api/me/attempts'),
      request(app).get(`/api/me/attempts/${String(attempt.attemptId)}`),
    ]);

    for (const response of bodies) {
      const text = JSON.stringify(response.body);
      expect(text).not.toContain(session.sessionId);
      expect(text).not.toMatch(/sessionId/);
      expect(text).not.toMatch(/lab_attempts|lab_progress|hint_usage|student_id/);
      expect(text).not.toMatch(/postgres|DATABASE_URL|password/i);
      expect(text).not.toMatch(/kubeconfig/i);
    }
  });

  it('404s an attempt that does not exist', async () => {
    const { app } = buildApp();
    const missing = await request(app).get(
      '/api/me/attempts/00000000-0000-4000-8000-000000000000',
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('ATTEMPT_NOT_FOUND');

    // And a malformed id is a miss, not a crash.
    const malformed = await request(app).get('/api/me/attempts/not-a-uuid');
    expect(malformed.status).toBe(404);
  });

  it('reports the store on /health', async () => {
    const { app } = buildApp();
    const response = await request(app).get('/health');
    expect(response.body.data.progress).toMatchObject({
      store: 'memory',
      ok: true,
      durable: false,
    });
  });
});

// --- degradation -------------------------------------------------------------

describe('when the progress store is unavailable', () => {
  it('lets a student start, check, reset and end a lab anyway', async () => {
    const { app, runtime } = buildApp({ repository: new BrokenProgressRepository() });

    const response = await request(app).post('/api/labs/LINUX-001/start');
    expect(response.status).toBe(200);
    // No attempt could be written, and the payload does not pretend otherwise.
    expect(response.body.data.attempt).toBeUndefined();

    const sessionId = response.body.data.session.sessionId as string;
    const sandbox = response.body.data.session.sandboxRef as string;
    completeLinuxLab(runtime, sandbox);

    const check = await request(app).post(`/api/sessions/${sessionId}/check`);
    expect(check.status).toBe(200);
    expect(check.body.data.passed).toBe(true);
    expect(check.body.data.attempt).toBeUndefined();

    const hint = await request(app).post(`/api/sessions/${sessionId}/hints`).send({ level: 1 });
    expect(hint.body.data).toMatchObject({ recorded: false, persisted: false });

    expect((await request(app).post(`/api/sessions/${sessionId}/reset`)).status).toBe(200);
    expect((await request(app).delete(`/api/sessions/${sessionId}`)).status).toBe(200);
  });

  it('says so on a read rather than serving an empty dashboard', async () => {
    const { app } = buildApp({ repository: new BrokenProgressRepository() });

    const progress = await request(app).get('/api/me/progress');
    expect(progress.status).toBe(503);
    expect(progress.body.error.code).toBe('PROGRESS_UNAVAILABLE');

    const attempts = await request(app).get('/api/me/attempts');
    expect(attempts.status).toBe(503);

    const health = await request(app).get('/health');
    expect(health.body.data.progress.ok).toBe(false);
  });
});
