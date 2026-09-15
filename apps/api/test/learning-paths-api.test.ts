/**
 * V1 EPIC-02 — the learning-path API, through HTTP.
 *
 *   GET /api/learning-paths                  catalog: every path
 *   GET /api/learning-paths/:pathId          catalog: one path, its stages, labs and gaps
 *   GET /api/me/learning-paths/:pathId       the caller's verified progress and next lab
 *
 * The session, verifier and persistence layers are the real ones; only the
 * container runtime is faked. Completion is produced the way a student produces
 * it — Start, Verify, End — so "completed" in these payloads is proved to mean
 * "Verify passed", and nothing else.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
  InMemorySessionStore,
  LearningPathCatalog,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
  labSourceFromRegistry,
  learningPathsDirectory,
  type LabRegistry,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { DevStudentIdentity, InMemoryProgressRepository, ProgressService } from '@jumptotech/progress';
import { BrokenProgressRepository } from '@jumptotech/progress/testing';
import {
  createAuthMetrics,
  createCommonMetrics,
  createRegistry,
  createSessionMetrics,
  createVerificationMetrics,
  silentLogger,
} from '@jumptotech/observability';
import { createApp, type CreateAppDeps } from '../src/app.js';
import type { RateLimitPolicy } from '../src/rate-limit.js';
import { loadConfig } from '../src/config.js';
import { AttemptClosingListener } from '../src/progress.js';
import { DevelopmentIdentityResolver } from '../src/auth/resolvers.js';
import { InMemoryUserRepository } from '../src/auth/users.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LABS = path.join(repoRoot, 'labs');
const SECRET = 'learning-paths-api-test-secret';
const ALICE = 'Developer alice';
const BOB = 'Developer bob';

/** LINUX-001's end state, as in `progress-api.test.ts` (which pins it to the lab on disk). */
const LINUX_001_SOLUTION: Record<string, Parameters<FakeContainerRuntime['put']>[2]> = {
  '/home/student/project': { type: 'directory', mode: '755' },
  '/home/student/project/config.txt': { type: 'file', mode: '644' },
  '/home/student/project/archive': { type: 'directory', mode: '755' },
  '/home/student/project/archive/app.log': { type: 'file', mode: '644', content: 'boot\n' },
};

let registry: LabRegistry;
let learningPaths: LearningPathCatalog;

beforeAll(async () => {
  registry = await realCatalog();
  learningPaths = await LearningPathCatalog.load(learningPathsDirectory(LABS), labSourceFromRegistry(registry));
  expect(learningPaths.loadErrors).toEqual([]);
});

function harness(
  options: {
    repository?: InMemoryProgressRepository | BrokenProgressRepository;
    withPaths?: boolean;
    catalog?: LearningPathCatalog;
    rateLimit?: RateLimitPolicy;
    observability?: CreateAppDeps['observability'];
  } = {},
) {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LABS_DIR: LABS,
    ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_MODE: 'development',
    MAX_ACTIVE_SESSIONS: '5',
    MAX_ACTIVE_SESSIONS_PER_STUDENT: '1',
  } as NodeJS.ProcessEnv);

  const runtime = new FakeContainerRuntime();
  // Only the Linux provider is registered, so Linux and CS labs can start and
  // every other track's labs honestly cannot.
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime }) });

  const progress = new ProgressService({ repository: options.repository ?? new InMemoryProgressRepository() });
  const sessions = new SessionManager({
    registry,
    providers,
    store: new InMemorySessionStore(),
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: SECRET,
    listener: new AttemptClosingListener(progress),
  });

  const app = createApp({
    registry,
    sessions,
    k8s: new FakeKubernetes(),
    config,
    identityResolver: new DevelopmentIdentityResolver(new InMemoryUserRepository()),
    progress: {
      progress,
      // The development header is switched on to prove it selects nobody once
      // a caller has authenticated.
      identity: new DevStudentIdentity({ studentId: config.progress.devStudentId, allowHeaderOverride: true }),
      store: 'memory',
      durable: false,
    },
    ...(options.withPaths === false ? {} : { learningPaths: options.catalog ?? learningPaths }),
    ...(options.rateLimit ? { learningPathRateLimit: options.rateLimit } : {}),
    ...(options.observability ? { observability: options.observability } : {}),
  });
  return { app, sessions, runtime };
}

const devops = () => learningPaths.get('devops-engineer')!;
const as = (who: string) => ({ Authorization: who });

async function myPath(app: ReturnType<typeof harness>['app'], who: string, suffix = '') {
  const res = await request(app).get(`/api/me/learning-paths/devops-engineer${suffix}`).set(as(who));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

const labStatus = (data: { labs: Array<{ labId: string; status: string }> }, labId: string) =>
  data.labs.find((lab) => lab.labId === labId)?.status;
const stageOf = (data: { stages: Array<{ stageId: string }> }, stageId: string) =>
  data.stages.find((stage) => stage.stageId === stageId) as unknown as Record<string, unknown> & {
    core: { completed: number };
  };

/** Every key anywhere in a JSON value. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, into));
  else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      into.add(key);
      keysOf(nested, into);
    }
  }
  return into;
}

// --- the catalog -------------------------------------------------------------

describe('GET /api/learning-paths', () => {
  it('lists the DevOps Engineer path with totals taken from the catalog', async () => {
    const { app } = harness();
    const res = await request(app).get('/api/learning-paths').set(as(ALICE));

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    const [summary] = res.body.data.learningPaths;
    expect(summary).toMatchObject({ id: 'devops-engineer', title: 'DevOps Engineer' });
    expect(summary.totals).toMatchObject({
      stages: devops().stages.length,
      labs: registry.size,
      comingSoonStages: devops().stages.filter((stage) => stage.labs.length === 0).length,
    });
    expect(summary.totals.coreLabs).toBeLessThan(summary.totals.labs);
    expect(summary.totals.gapSkills).toBeGreaterThan(0);
  });

  it('lists nothing, and finds nothing, on a deployment with no paths', async () => {
    const { app } = harness({ withPaths: false });
    expect((await request(app).get('/api/learning-paths').set(as(ALICE))).body.data).toEqual({ learningPaths: [], count: 0 });
    expect((await request(app).get('/api/learning-paths/devops-engineer').set(as(ALICE))).status).toBe(404);
  });
});

describe('GET /api/learning-paths/:pathId', () => {
  it('serves the stages in order, labs in recommended order, and gaps as gaps', async () => {
    const { app } = harness();
    const res = await request(app).get('/api/learning-paths/devops-engineer').set(as(ALICE));
    expect(res.status).toBe(200);
    const detail = res.body.data.learningPath;

    expect(detail.stages.map((stage: { id: string }) => stage.id)).toEqual(devops().stages.map((stage) => stage.id));

    const linux = detail.stages.find((stage: { id: string }) => stage.id === 'linux');
    expect(linux.labs[0]).toMatchObject({
      labId: 'LINUX-001',
      title: registry.get('LINUX-001').title,
      trackTitle: 'Linux',
      optional: false,
      availability: { available: true },
    });
    expect(linux.prerequisites).toEqual([{ stageId: 'foundations', title: 'Foundations', kind: 'recommended' }]);

    // No Kubernetes provider is registered here, and the path says so.
    const kubernetes = detail.stages.find((stage: { id: string }) => stage.id === 'kubernetes');
    expect(kubernetes.labs.every((lab: { availability: { available: boolean } }) => !lab.availability.available)).toBe(true);

    const git = detail.stages.find((stage: { id: string }) => stage.id === 'git');
    expect(git.labs).toEqual([]);
    expect(git.comingSoon).toMatch(/does not have Git labs yet/);
    expect(git.skills.find((skill: { id: string }) => skill.id === 'git.fundamentals').labIds).toEqual([]);
  });

  it('carries nothing that runs, grades or identifies a sandbox', async () => {
    const { app } = harness();
    const res = await request(app).get('/api/learning-paths/devops-engineer').set(as(ALICE));
    const keys = keysOf(res.body);
    for (const forbidden of ['sessionId', 'sandboxRef', 'requirements', 'setup', 'reset', 'hints', 'provider', 'reason', 'remediation']) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
  });

  it('refuses a malformed id and 404s an unknown one', async () => {
    const { app } = harness();
    const malformed = await request(app).get('/api/learning-paths/Not_A_Path').set(as(ALICE));
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_LEARNING_PATH_ID');
    expect(JSON.stringify(malformed.body)).not.toContain('Not_A_Path');

    const unknown = await request(app).get('/api/learning-paths/site-reliability').set(as(ALICE));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('LEARNING_PATH_NOT_FOUND');
  });

  it('reports a path that failed to load as unavailable, not as a wrong address', async () => {
    // A lab the path references is missing from the catalog — e.g. its lab.yaml
    // stopped validating. The path is refused; students must not be told the
    // Learning Path link points nowhere.
    const real = labSourceFromRegistry(registry);
    const withoutLinux001 = { lab: (id: string) => (id === 'LINUX-001' ? undefined : real.lab(id)) };
    const read = (name: string) => ({
      text: readFileSync(path.join(learningPathsDirectory(LABS), name), 'utf8'),
      source: name,
      expectedId: name.replace(/\.yaml$/, ''),
    });
    const broken = LearningPathCatalog.build(
      { skills: read('skills.yaml'), paths: [read('devops-engineer.yaml')] },
      withoutLinux001,
    );
    expect(broken.loadErrors.join('\n')).toContain('lab LINUX-001 does not exist in the lab catalog');

    const { app } = harness({ catalog: broken });
    for (const url of ['/api/learning-paths/devops-engineer', '/api/me/learning-paths/devops-engineer']) {
      const res = await request(app).get(url).set(as(ALICE));
      expect(res.status, url).toBe(503);
      expect(res.body.error.code).toBe('LEARNING_PATH_UNAVAILABLE');
      expect(JSON.stringify(res.body)).not.toMatch(/LINUX-001|lab\.yaml|\/app\/labs/);
    }
    // A path that was never defined is still simply not found.
    expect((await request(app).get('/api/learning-paths/site-reliability').set(as(ALICE))).status).toBe(404);
    expect((await request(app).get('/health')).body.data.learningPathLoadErrors).toHaveLength(1);
  });

  it('requires a valid credential, like every other browser route', async () => {
    const { app } = harness();
    for (const url of ['/api/learning-paths', '/api/learning-paths/devops-engineer', '/api/me/learning-paths/devops-engineer']) {
      const res = await request(app).get(url).set('Authorization', 'Bearer nonsense');
      expect(res.status, url).toBe(401);
    }
  });
});

// --- the caller's progress ----------------------------------------------------

describe('GET /api/me/learning-paths/:pathId', () => {
  it('starts a new student at the beginning, counting nothing', async () => {
    const { app } = harness();
    const data = await myPath(app, ALICE);

    expect(data.student).toMatchObject({ authenticated: true, identitySource: 'authenticated' });
    expect(data.pathId).toBe('devops-engineer');
    expect(data.overall.labs).toEqual({ total: registry.size, completed: 0, inProgress: 0, notStarted: registry.size });
    expect(stageOf(data, 'git').status).toBe('COMING_SOON');
    expect(data.recommendation).toEqual({
      kind: 'START_STAGE',
      labId: 'CS-001',
      labTitle: registry.get('CS-001').title,
      stageId: 'foundations',
      reason: 'Start here. Foundations is the first stage of the DevOps Engineer path.',
    });
  });

  it('counts a lab only when Verify passed, and puts a running lab first', async () => {
    const { app, runtime } = harness();

    const started = await request(app).post('/api/labs/LINUX-001/start').set(as(ALICE));
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const { sessionId, sandboxRef } = started.body.data.session as { sessionId: string; sandboxRef: string };

    // Launched: attempted, not completed — and the running lab comes first.
    let data = await myPath(app, ALICE);
    expect(labStatus(data, 'LINUX-001')).toBe('IN_PROGRESS');
    expect(data.overall.labs.completed).toBe(0);
    expect(data.recommendation).toMatchObject({
      kind: 'RESUME_ACTIVE',
      labId: 'LINUX-001',
      labTitle: registry.get('LINUX-001').title,
      stageId: 'linux',
    });

    // A failing Verify changes nothing.
    await request(app).post(`/api/sessions/${sessionId}/check`).set(as(ALICE));
    data = await myPath(app, ALICE);
    expect(labStatus(data, 'LINUX-001')).toBe('IN_PROGRESS');

    // A passing Verify completes it.
    for (const [file, entry] of Object.entries(LINUX_001_SOLUTION)) runtime.put(sandboxRef, file, entry);
    const passed = await request(app).post(`/api/sessions/${sessionId}/check`).set(as(ALICE));
    expect(passed.body.data.passed, JSON.stringify(passed.body.data.checks)).toBe(true);

    data = await myPath(app, ALICE);
    expect(labStatus(data, 'LINUX-001')).toBe('COMPLETED');
    expect(stageOf(data, 'linux')).toMatchObject({ status: 'IN_PROGRESS', core: { completed: 1 } });
    expect(data.skills.find((skill: { skillId: string }) => skill.skillId === 'linux.filesystem').labs.completed).toBe(1);
    // Still running, so still "continue it" rather than "start another".
    expect(data.recommendation.kind).toBe('RESUME_ACTIVE');
    // No session id — the capability for the sandbox — anywhere in the payload.
    expect(JSON.stringify(data)).not.toContain(sessionId);
    expect(keysOf(data).has('sessionId')).toBe(false);

    // Ended: the completion stays, and the path moves on within Linux.
    expect((await request(app).delete(`/api/sessions/${sessionId}`).set(as(ALICE))).status).toBe(200);
    data = await myPath(app, ALICE);
    expect(data.overall.labs.completed).toBe(1);
    expect(data.recommendation).toMatchObject({ kind: 'NEXT_IN_STAGE', labId: 'LINUX-002', stageId: 'linux' });
  });

  it("never shows one student another's progress, whatever the request says", async () => {
    const { app, runtime } = harness();
    const started = await request(app).post('/api/labs/LINUX-001/start').set(as(ALICE));
    const { sessionId, sandboxRef } = started.body.data.session;
    for (const [file, entry] of Object.entries(LINUX_001_SOLUTION)) runtime.put(sandboxRef, file, entry);
    await request(app).post(`/api/sessions/${sessionId}/check`).set(as(ALICE));
    const alice = await myPath(app, ALICE);
    expect(labStatus(alice, 'LINUX-001')).toBe('COMPLETED');

    const res = await request(app)
      .get(`/api/me/learning-paths/devops-engineer?studentId=${encodeURIComponent(alice.student.studentId)}`)
      .set(as(BOB))
      .set('x-dev-student-id', alice.student.studentId);
    expect(res.status).toBe(200);
    const bob = res.body.data;
    expect(bob.student.studentId).not.toBe(alice.student.studentId);
    expect(labStatus(bob, 'LINUX-001')).toBe('NOT_STARTED');
    expect(bob.overall.labs.completed).toBe(0);
    // Alice's running lab is not Bob's to resume.
    expect(bob.recommendation.kind).toBe('START_STAGE');
  });

  it('says progress is unavailable rather than serving zeros, while the path itself still loads', async () => {
    const { app } = harness({ repository: new BrokenProgressRepository() });

    const mine = await request(app).get('/api/me/learning-paths/devops-engineer').set(as(ALICE));
    expect(mine.status).toBe(503);
    expect(mine.body.error.code).toBe('PROGRESS_UNAVAILABLE');

    expect((await request(app).get('/api/learning-paths/devops-engineer').set(as(ALICE))).status).toBe(200);
  });

  it('suggests no lab when it cannot tell whether one is already running', async () => {
    const { app, sessions } = harness();
    (sessions as unknown as { listOccupying: () => Promise<never> }).listOccupying = async () => {
      throw new Error('session store unavailable');
    };

    const data = await myPath(app, ALICE);
    expect(data.recommendation.kind).toBe('ACTIVE_SESSION_UNKNOWN');
    expect(data.recommendation.labId).toBeUndefined();
    // The progress itself is still real.
    expect(data.overall.labs.total).toBe(registry.size);
  });

  it('refuses a malformed id and 404s an unknown one', async () => {
    const { app } = harness();
    expect((await request(app).get('/api/me/learning-paths/NOPE!').set(as(ALICE))).status).toBe(400);
    const unknown = await request(app).get('/api/me/learning-paths/site-reliability').set(as(ALICE));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('LEARNING_PATH_NOT_FOUND');
  });
});

describe('/health', () => {
  it('reports the learning paths it loaded and any it refused', async () => {
    const { app } = harness();
    const res = await request(app).get('/health');
    expect(res.body.data).toMatchObject({ learningPathsLoaded: 1, learningPathLoadErrors: [] });
  });
});

// --- rate limiting (CodeQL js/missing-rate-limiting) --------------------------

function testObservability(): NonNullable<CreateAppDeps['observability']> {
  const registry = createRegistry({ service: 'api', defaultMetrics: false });
  return {
    logger: silentLogger(),
    metrics: {
      common: createCommonMetrics(registry, 'api'),
      sessions: createSessionMetrics(registry),
      verification: createVerificationMetrics(registry),
      auth: createAuthMetrics(registry),
    },
  };
}

async function rateLimitedEvents(obs: NonNullable<CreateAppDeps['observability']>): Promise<number> {
  const { values } = await obs.metrics.common.securityEvents.get();
  return values.filter((v) => v.labels.event === 'rate_limited').reduce((sum, v) => sum + v.value, 0);
}

/** A student reaching the API through nginx, which appends their address. */
const via = (address: string, who = ALICE) => ({ ...as(who), 'X-Forwarded-For': address });

describe('rate limiting of the learning-path routes', () => {
  it('lets normal use through under the default budget, and says what the budget is', async () => {
    const { app } = harness();
    for (let i = 0; i < 30; i += 1) {
      const url = i % 2 === 0 ? '/api/learning-paths/devops-engineer' : '/api/me/learning-paths/devops-engineer';
      const res = await request(app).get(url).set(via('203.0.113.10'));
      expect(res.status, `${url} #${i}`).toBe(200);
    }
    const res = await request(app).get('/api/learning-paths').set(via('203.0.113.10'));
    expect(res.headers['ratelimit-policy']).toMatch(/q=600;\s*w=60/);
    expect(res.headers.ratelimit).toBeDefined();
  });

  it('refuses excess requests with 429 in the API envelope, one budget across catalog and progress', async () => {
    const obs = testObservability();
    const { app } = harness({ rateLimit: { limit: 3, windowMs: 60_000 }, observability: obs });
    const client = { ...via('203.0.113.20'), Origin: 'http://localhost:3000' };

    expect((await request(app).get('/api/learning-paths').set(client)).status).toBe(200);
    expect((await request(app).get('/api/learning-paths/devops-engineer').set(client)).status).toBe(200);
    expect((await request(app).get('/api/me/learning-paths/devops-engineer').set(client)).status).toBe(200);

    for (const url of ['/api/learning-paths/devops-engineer', '/api/me/learning-paths/devops-engineer']) {
      const res = await request(app).get(url).set(client);
      expect(res.status, url).toBe(429);
      expect(res.body).toEqual({
        ok: false,
        error: { code: 'RATE_LIMITED', message: expect.any(String), remediation: expect.any(String) },
      });
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      // Readable by the browser: CORS ran before the limiter.
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      expect(JSON.stringify(res.body)).not.toMatch(/203\.0\.113|studentId|sessionId|devops-engineer/);
    }
    expect(await rateLimitedEvents(obs)).toBe(2);
  });

  it('counts before authentication, so a flood of forged credentials is refused unverified', async () => {
    const { app } = harness({ rateLimit: { limit: 2, windowMs: 60_000 } });
    const forged = { Authorization: 'Bearer x.y.z', 'X-Forwarded-For': '203.0.113.25' };

    expect((await request(app).get('/api/learning-paths').set(forged)).status).toBe(401);
    expect((await request(app).get('/api/me/learning-paths/devops-engineer').set(forged)).status).toBe(401);
    const third = await request(app).get('/api/learning-paths').set(forged);
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
  });

  it('keys the budget on the address nginx appended, not on one the client prepends', async () => {
    const { app } = harness({ rateLimit: { limit: 1, windowMs: 60_000 } });

    expect((await request(app).get('/api/learning-paths').set(via('203.0.113.30'))).status).toBe(200);
    expect((await request(app).get('/api/learning-paths').set(via('203.0.113.30'))).status).toBe(429);
    // A spoofed address in front of the real one does not buy a fresh budget.
    expect((await request(app).get('/api/learning-paths').set(via('198.51.100.7, 203.0.113.30'))).status).toBe(429);
    // Another student has their own budget.
    expect((await request(app).get('/api/learning-paths').set(via('203.0.113.31', BOB))).status).toBe(200);
  });

  it('leaves every other route unlimited, and identity server-derived, while the budget is spent', async () => {
    const { app } = harness({ rateLimit: { limit: 1, windowMs: 60_000 } });
    const alice = via('203.0.113.40');
    const bobId = (await request(app).get('/api/me/learning-paths/devops-engineer').set(via('203.0.113.41', BOB))).body
      .data.student.studentId as string;

    const own = await request(app)
      .get(`/api/me/learning-paths/devops-engineer?studentId=${encodeURIComponent(bobId)}`)
      .set(alice)
      .set('x-dev-student-id', bobId);
    expect(own.status).toBe(200);
    expect(own.body.data.student.studentId).not.toBe(bobId);

    expect((await request(app).get('/api/learning-paths').set(alice)).status).toBe(429);
    for (const url of ['/api/labs', '/api/tracks', '/api/me', '/api/me/progress', '/api/me/attempts', '/api/sessions']) {
      expect((await request(app).get(url).set(alice)).status, url).toBe(200);
    }
    expect((await request(app).get('/health')).status).toBe(200);
  });
});
