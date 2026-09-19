/**
 * Five students and a sixth who wants in — every cross-student move, against
 * one composed API.
 *
 * The per-route ownership tests (`authorization.test.ts`, `terminal-ownership`,
 * `check-concurrency`, `student-session-limit`) each prove one boundary with two
 * users. This is the red-team pass's cohort-shaped replay of them: five students
 * with live labs at once, each handed another's real, live identifiers, and a
 * sixth trying to get a slot the platform does not have. Every move must fail
 * *and leave the victim's lab and history exactly as they were*.
 *
 * ```text
 *   A reads B's session        B resets C's      C checks D's
 *   D ends E's                 E takes A's terminal (API and /internal)
 *   F starts past capacity     A races its own per-student limit
 * ```
 *
 * Synthetic development identities only; the sandbox runtime is the fake one.
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
  verifySessionToken,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { DevelopmentIdentityResolver } from '../src/auth/resolvers.js';
import { InMemoryUserRepository } from '../src/auth/users.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TERMINAL_SECRET = 'five-student-terminal-session-secret';
const INTERNAL_SECRET = 'five-student-internal-service-secret';
const LAB = 'LINUX-001';

const STUDENTS = ['alice', 'bob', 'carol', 'dave', 'erin'] as const;
type Student = (typeof STUDENTS)[number];
const as = (name: string) => `Developer ${name}`;

interface Live {
  sessionId: string;
  attemptId: string;
  userId: string;
  token: string;
}

let app: ReturnType<typeof createApp>;
let sessions: SessionManager;
let runtime: FakeContainerRuntime;
const live = new Map<Student, Live>();

beforeAll(async () => {
  const registry: LabRegistry = await realCatalog();
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: TERMINAL_SECRET,
    INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_MODE: 'development',
    // The private beta: five students, one lab each.
    MAX_ACTIVE_SESSIONS: '5',
    MAX_ACTIVE_SESSIONS_PER_STUDENT: '1',
  } as NodeJS.ProcessEnv);
  runtime = new FakeContainerRuntime();
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime }) });
  sessions = new SessionManager({
    registry,
    providers,
    store: new InMemorySessionStore(),
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: TERMINAL_SECRET,
  });
  app = createApp({
    registry,
    sessions,
    k8s: new FakeKubernetes(),
    config,
    identityResolver: new DevelopmentIdentityResolver(new InMemoryUserRepository()),
  });

  for (const student of STUDENTS) {
    const res = await request(app)
      .post(`/api/labs/${LAB}/start`)
      .set('Authorization', as(student))
      // Server-owned fields a client might try to assign. None may land.
      .send({ ownerUserId: 'usr-00000001', studentId: 'someone-else', status: 'COMPLETED', provider: 'kubernetes' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const token = res.body.data.terminal.token as string;
    live.set(student, {
      sessionId: res.body.data.session.sessionId,
      attemptId: res.body.data.attempt.attemptId,
      userId: verifySessionToken(token, TERMINAL_SECRET).uid!,
      token,
    });
  }
});

const get = (student: Student) => live.get(student)!;

/** What the victim's own view of its lab and history is right now. */
async function victimView(student: Student) {
  const session = await request(app).get(`/api/sessions/${get(student).sessionId}`).set('Authorization', as(student));
  const attempt = await request(app).get(`/api/me/attempts/${get(student).attemptId}`).set('Authorization', as(student));
  return {
    status: session.body.data?.session?.status,
    lastActivityAt: session.body.data?.session?.lastActivityAt,
    checkCount: attempt.body.data?.attempt?.checkCount,
    resetCount: attempt.body.data?.attempt?.resetCount,
    attemptStatus: attempt.body.data?.attempt?.status,
  };
}

describe('five students, each holding another one\'s live identifiers', () => {
  it('gave every student their own session, whatever the start body claimed', async () => {
    const owners = new Set([...live.values()].map((entry) => entry.userId));
    expect(owners.size).toBe(5);
    expect(new Set([...live.values()].map((entry) => entry.sessionId)).size).toBe(5);
    for (const student of STUDENTS) {
      const mine = await request(app).get('/api/sessions').set('Authorization', as(student));
      expect(mine.body.data.sessions.map((entry: { session: { sessionId: string } }) => entry.session.sessionId)).toEqual([
        get(student).sessionId,
      ]);
      const stored = await sessions.require(get(student).sessionId);
      expect(stored.ownerUserId).toBe(get(student).userId);
      expect(stored.provider).toBe('linux');
      expect((await victimView(student)).attemptStatus).not.toBe('COMPLETED');
    }
  });

  it('A cannot read B\'s session, its terminal, or its history', async () => {
    const before = await victimView('bob');
    const b = get('bob');
    for (const [method, url] of [
      ['get', `/api/sessions/${b.sessionId}`],
      ['post', `/api/sessions/${b.sessionId}/terminal`],
      ['post', `/api/sessions/${b.sessionId}/activity`],
      ['post', `/api/sessions/${b.sessionId}/hints`],
    ] as const) {
      const res = await request(app)[method](url).set('Authorization', as('alice')).send({ level: 0 });
      expect(res.status, `${method} ${url}`).toBe(404);
      expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
      expect(JSON.stringify(res.body)).not.toContain(b.sessionId);
    }
    const history = await request(app).get(`/api/me/attempts/${b.attemptId}`).set('Authorization', as('alice'));
    expect(history.status).toBe(404);
    const list = await request(app).get('/api/me/attempts').set('Authorization', as('alice'));
    expect(JSON.stringify(list.body)).not.toContain(b.attemptId);
    expect(await victimView('bob')).toEqual(before);
  });

  it('B cannot reset C\'s lab', async () => {
    const before = await victimView('carol');
    const created = runtime.created.length;
    const res = await request(app).post(`/api/sessions/${get('carol').sessionId}/reset`).set('Authorization', as('bob'));
    expect(res.status).toBe(404);
    // No sandbox was rebuilt, and C's record did not move.
    expect(runtime.created.length).toBe(created);
    expect(await victimView('carol')).toEqual(before);
  });

  it('C cannot run D\'s verification, or pass it with a forged result', async () => {
    const before = await victimView('dave');
    const res = await request(app)
      .post(`/api/sessions/${get('dave').sessionId}/check`)
      .set('Authorization', as('carol'))
      .send({ passed: true, checks: [{ status: 'pass' }], newlyCompleted: true });
    expect(res.status).toBe(404);
    expect(await victimView('dave')).toEqual(before);
    // And C's own check ignores the same forged body: the verdict is the
    // verifier's, run against C's own sandbox.
    const own = await request(app)
      .post(`/api/sessions/${get('carol').sessionId}/check`)
      .set('Authorization', as('carol'))
      .send({ passed: true, newlyCompleted: true });
    expect(own.body.data?.passed ?? false).toBe(false);
    expect((await victimView('carol')).attemptStatus).not.toBe('COMPLETED');
  });

  it('D cannot end E\'s lab', async () => {
    const res = await request(app).delete(`/api/sessions/${get('erin').sessionId}`).set('Authorization', as('dave'));
    expect(res.status).toBe(404);
    expect((await victimView('erin')).status).toBe('ACTIVE');
    expect((await sessions.require(get('erin').sessionId)).status).toBe('ACTIVE');
  });

  it('E cannot take A\'s terminal, through the API or with its own valid token at /internal', async () => {
    const res = await request(app).post(`/api/sessions/${get('alice').sessionId}/terminal`).set('Authorization', as('erin'));
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);

    // What a terminal service holding E's verified token would ask for, aimed
    // at A's session: the owner in the token is E, the live record says A.
    const internal = await request(app)
      .post(`/internal/sessions/${get('alice').sessionId}/credentials`)
      .set('x-internal-secret', INTERNAL_SECRET)
      .send({ ownerUserId: get('erin').userId });
    expect(internal.status).toBe(403);
    expect(internal.body.error.code).toBe('SESSION_NOT_OWNED');

    // And E's own token names E's session, not A's: a token is not a
    // capability over any other id.
    expect(verifySessionToken(get('erin').token, TERMINAL_SECRET).sid).toBe(get('erin').sessionId);
  });

  it('F, a sixth student, gets no slot — not by asking, and not by asking eight times at once', async () => {
    const one = await request(app).post(`/api/labs/${LAB}/start`).set('Authorization', as('frank'));
    expect(one.status).toBe(503);
    expect(one.body.error.code).toBe('LAB_CAPACITY_REACHED');

    const burst = await Promise.all(
      Array.from({ length: 8 }, () => request(app).post(`/api/labs/${LAB}/start`).set('Authorization', as('frank'))),
    );
    expect(burst.filter((res) => res.status === 200)).toHaveLength(0);
    expect(await sessions.activeCount()).toBe(5);
    const mine = await request(app).get('/api/sessions').set('Authorization', as('frank'));
    expect(mine.body.data.count).toBe(0);
  });

  it('A, after ending its lab, gets exactly one new one from a burst of starts', async () => {
    const ended = await request(app).delete(`/api/sessions/${get('alice').sessionId}`).set('Authorization', as('alice'));
    expect(ended.status).toBe(200);

    const burst = await Promise.all(
      Array.from({ length: 6 }, () => request(app).post(`/api/labs/${LAB}/start`).set('Authorization', as('alice'))),
    );
    expect(burst.filter((res) => res.status === 200)).toHaveLength(1);
    for (const refused of burst.filter((res) => res.status !== 200)) {
      expect(['STUDENT_SESSION_LIMIT_REACHED', 'LAB_CAPACITY_REACHED']).toContain(refused.body.error.code);
    }
    expect(await sessions.activeCount()).toBe(5);
  });

  it('a stale (ended) session id is dead for its owner and still invisible to everyone else', async () => {
    const stale = get('alice').sessionId;
    for (const [method, url] of [
      ['post', `/api/sessions/${stale}/terminal`],
      ['post', `/api/sessions/${stale}/check`],
      ['post', `/api/sessions/${stale}/reset`],
    ] as const) {
      const own = await request(app)[method](url).set('Authorization', as('alice'));
      expect(own.status, `${method} ${url} (owner)`).toBe(409);
      const other = await request(app)[method](url).set('Authorization', as('bob'));
      expect(other.status, `${method} ${url} (bob)`).toBe(404);
    }
    const internal = await request(app)
      .post(`/internal/sessions/${stale}/credentials`)
      .set('x-internal-secret', INTERNAL_SECRET)
      .send({ ownerUserId: get('alice').userId });
    expect(internal.status).toBe(409);
  });

  it('refuses malformed and traversal-shaped ids without reaching a session', async () => {
    for (const id of ['not-a-session', 'sess-', `${get('bob').sessionId}x`, 'sess-0123456789abcdef%00']) {
      const res = await request(app).get(`/api/sessions/${id}`).set('Authorization', as('alice'));
      expect([400, 404], id).toContain(res.status);
    }
    const traversal = await request(app)
      .get(`/api/sessions/..%2F..%2Finternal%2Fsessions%2F${get('bob').sessionId}`)
      .set('Authorization', as('alice'));
    expect(traversal.status).toBe(400);
  });
});
