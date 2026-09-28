/**
 * The classroom view over HTTP — who may see it, what it shows, and the one
 * thing it can do.
 *
 * ```text
 *                     /api/admin/* reads   operator detail   end another's lab
 *   no credential        401                  —                  401
 *   STUDENT              403                  —                  403
 *   INSTRUCTOR           200                  ✗                  403
 *   ADMIN                200                  ✓                  200 (confirmed)
 * ```
 *
 * Roles are set the only way they can be — in the user store, as an
 * administrator would. A role in a header or a body is ignored.
 *
 * Then a real class: five students on five labs across Linux, Docker,
 * Kubernetes and Terraform, capacity 5, and a sixth student turned away —
 * shown to the instructor as a capacity refusal with that student's name.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
  DockerLabProvider,
  InMemorySessionStore,
  InMemoryWorkspace,
  KindLabProvider,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
  TerraformLabProvider,
} from '@jumptotech/lab-orchestrator';
import { FakeDockerEngines, FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { DevelopmentIdentityResolver } from '../src/auth/resolvers.js';
import { InMemoryUserRepository } from '../src/auth/users.js';
import { AuthError, type IdentityResolver } from '../src/auth/identity.js';
import type { AuthAuditEvent } from '../src/auth/middleware.js';
import { InMemorySessionEventStore } from '../src/classroom/session-events.js';
import { CleanupEventListener } from '../src/classroom/cleanup-events.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'classroom-admin-test-secret';
const ORIGIN = 'http://localhost:3000';
const as = (name: string) => `Developer ${name}`;

let registry: LabRegistry;
beforeAll(async () => {
  registry = await realCatalog();
});

interface Harness {
  app: ReturnType<typeof createApp>;
  users: InMemoryUserRepository;
  store: InMemorySessionStore;
  events: InMemorySessionEventStore;
  k8s: FakeKubernetes;
  audit: AuthAuditEvent[];
}

function harness(env: Record<string, string> = {}): Harness {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: ORIGIN,
    AUTH_MODE: 'development',
    MAX_ACTIVE_SESSIONS: '5',
    ...env,
  } as NodeJS.ProcessEnv);
  const k8s = new FakeKubernetes();
  const runtime = new FakeContainerRuntime();
  const kind = new KindLabProvider({ k8s, clusterName: 'jumptotech-labs', destroyTimeoutMs: 2_000, sleep: async () => undefined });
  kind.execute = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.34.2' } }),
    stderr: '',
    timedOut: false,
  });
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 })
    .register({ provider: kind })
    .register({ provider: new LinuxLabProvider({ runtime }) })
    .register({ provider: new TerraformLabProvider({ runtime }) })
    .register({
      provider: new DockerLabProvider({
        engines: new FakeDockerEngines({ images: [config.policy.docker.image] }),
        workspace: new InMemoryWorkspace(),
        sandboxDaemonAvailable: true,
        sleep: async () => undefined,
      }),
    });
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
  const audit: AuthAuditEvent[] = [];
  // Development identity, except that *no* credential is refused rather than
  // defaulting to a student: the production behaviour, for the 401 row.
  const dev = new DevelopmentIdentityResolver(users);
  const identityResolver: IdentityResolver = {
    mode: 'development',
    resolve: async (header) => {
      if (!header) throw new AuthError('AUTH_REQUIRED', 'This request requires authentication.');
      return dev.resolve(header);
    },
  };
  const app = createApp({
    registry,
    sessions,
    k8s,
    config,
    identityResolver,
    browserAuth: { users },
    sessionEvents: events,
    authAudit: (event) => audit.push(event),
  });
  return { app, users, store, events, k8s, audit };
}

async function withRole(h: Harness, name: string, role: 'INSTRUCTOR' | 'ADMIN'): Promise<string> {
  const user = await h.users.upsert({ issuer: DevelopmentIdentityResolver.ISSUER, subject: name, displayName: name });
  await h.users.setRole(user.userId, role);
  return user.userId;
}

async function start(h: Harness, lab: string, who: string): Promise<string> {
  const res = await request(h.app).post(`/api/labs/${lab}/start`).set('Authorization', as(who));
  expect(res.status, `${who} ${lab}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.data.session.sessionId as string;
}

const READS = ['/api/admin/classroom', '/api/admin/labs', '/api/admin/students?q=am', '/api/admin/sessions/sess-00000000'];

describe('who may use the classroom view', () => {
  let h: Harness;
  let sessionId: string;
  beforeEach(async () => {
    h = harness();
    sessionId = await start(h, 'LINUX-001', 'amy');
    await withRole(h, 'teacher', 'INSTRUCTOR');
    await withRole(h, 'boss', 'ADMIN');
  });

  it('refuses a request with no credential: 401 on every read and on end', async () => {
    for (const url of READS) {
      const res = await request(h.app).get(url);
      expect(res.status, url).toBe(401);
    }
    const end = await request(h.app)
      .post(`/api/admin/sessions/${sessionId}/end`)
      .set('Origin', ORIGIN)
      .send({ confirmSessionId: sessionId });
    expect(end.status).toBe(401);
  });

  it('refuses a student: 403 on every path, even ones that do not exist, and records the denial', async () => {
    for (const url of [...READS, `/api/admin/sessions/${sessionId}`, '/api/admin/no-such-thing']) {
      const res = await request(h.app).get(url).set('Authorization', as('amy'));
      expect(res.status, url).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(JSON.stringify(res.body)).not.toContain(sessionId);
    }
    expect(h.audit.some((event) => event.action === 'classroom:read' && event.authorizationResult === 'denied-role')).toBe(true);
  });

  it('ignores a role the request claims for itself', async () => {
    const res = await request(h.app)
      .get('/api/admin/classroom?role=ADMIN')
      .set('Authorization', as('amy'))
      .set('x-role', 'ADMIN')
      .set('x-jtt-role', 'ADMIN');
    expect(res.status).toBe(403);
    const end = await request(h.app)
      .post(`/api/admin/sessions/${sessionId}/end`)
      .set('Authorization', as('amy'))
      .set('Origin', ORIGIN)
      .send({ confirmSessionId: sessionId, role: 'ADMIN' });
    expect(end.status).toBe(403);
    expect((await h.store.get(sessionId))!.status).toBe('ACTIVE');
  });

  it('lets an instructor read, without operator detail, and never end', async () => {
    const classroom = await request(h.app).get('/api/admin/classroom').set('Authorization', as('teacher'));
    expect(classroom.status).toBe(200);
    expect(classroom.body.data.viewer).toMatchObject({ role: 'INSTRUCTOR', canEndSessions: false, operatorDetail: false });
    expect(classroom.body.data.sessions[0]).not.toHaveProperty('operator');
    expect(JSON.stringify(classroom.body)).not.toMatch(/sandboxRef|namespace|jtt-lab-|statusReason/);

    const detail = await request(h.app).get(`/api/admin/sessions/${sessionId}`).set('Authorization', as('teacher'));
    expect(detail.status).toBe(200);
    expect(detail.body.data.actions.canEnd).toBe(false);

    const end = await request(h.app)
      .post(`/api/admin/sessions/${sessionId}/end`)
      .set('Authorization', as('teacher'))
      .set('Origin', ORIGIN)
      .send({ confirmSessionId: sessionId });
    expect(end.status).toBe(403);
    expect(end.body.error.message).toMatch(/administrator/);
    expect((await h.store.get(sessionId))!.status).toBe('ACTIVE');
  });

  it('lets an admin see operator detail', async () => {
    const classroom = await request(h.app).get('/api/admin/classroom').set('Authorization', as('boss'));
    expect(classroom.status).toBe(200);
    expect(classroom.body.data.viewer).toMatchObject({ role: 'ADMIN', canEndSessions: true, operatorDetail: true });
    expect(classroom.body.data.sessions[0].operator.sandboxRef).toMatch(/^jtt-lab-|^lab-/);
  });

  it('never serves a terminal token, credential or kubeconfig, to anyone', async () => {
    for (const who of ['teacher', 'boss']) {
      for (const url of ['/api/admin/classroom', `/api/admin/sessions/${sessionId}`, '/api/admin/students?q=amy']) {
        const res = await request(h.app).get(url).set('Authorization', as(who));
        expect(res.status, `${who} ${url}`).toBe(200);
        expect(JSON.stringify(res.body), `${who} ${url}`).not.toMatch(/token|kubeconfig|password|secret|shellUid|credential/i);
      }
    }
  });
});

describe('ending a student’s lab (ADMIN)', () => {
  let h: Harness;
  let sessionId: string;
  let adminId: string;
  beforeEach(async () => {
    h = harness();
    sessionId = await start(h, 'LINUX-001', 'amy');
    adminId = await withRole(h, 'boss', 'ADMIN');
  });

  const end = (body: object, who = 'boss', id = sessionId) =>
    request(h.app).post(`/api/admin/sessions/${id}/end`).set('Authorization', as(who)).set('Origin', ORIGIN).send(body);

  it('requires the Support ID repeated as confirmation', async () => {
    expect((await end({})).status).toBe(400);
    expect((await end({ confirmSessionId: 'sess-somebody-else' })).body.error.code).toBe('CONFIRMATION_REQUIRED');
    expect((await h.store.get(sessionId))!.status).toBe('ACTIVE');
  });

  it('requires a trusted origin, like every write', async () => {
    const res = await request(h.app)
      .post(`/api/admin/sessions/${sessionId}/end`)
      .set('Authorization', as('boss'))
      .set('Origin', 'https://evil.example')
      .send({ confirmSessionId: sessionId });
    expect(res.status).toBe(403);
    expect((await h.store.get(sessionId))!.status).toBe('ACTIVE');
  });

  it('ends it through the platform’s teardown, records who did it, and is idempotent', async () => {
    const res = await end({ confirmSessionId: sessionId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ before: 'ACTIVE', after: 'EXPIRED', cleanup: 'confirmed' });
    expect(res.body.data.session.state.label).toBe('Ended by staff');

    const timeline = await h.events.listForSession(sessionId, 20);
    expect(timeline.find((event) => event.operation === 'staff_end')).toMatchObject({ outcome: 'ok', actorUserId: adminId });
    expect(timeline.find((event) => event.operation === 'cleanup')).toMatchObject({ outcome: 'ok', code: 'ENDED_BY_STAFF' });
    expect(h.audit.some((event) => event.action === 'session:end' && event.sessionId === sessionId && event.authorizationResult === 'allowed')).toBe(true);

    // The student sees it ended; a second press changes nothing.
    const again = await end({ confirmSessionId: sessionId });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SESSION_ALREADY_FINISHED');

    const classroom = await request(h.app).get('/api/admin/classroom').set('Authorization', as('boss'));
    expect(classroom.body.data.capacity).toMatchObject({ active: 0, available: 5 });
    expect(classroom.body.data.recent[0]).toMatchObject({ sessionId, cleanup: 'confirmed' });
  });

  it('is not how staff end their own lab', async () => {
    const own = await start(h, 'LINUX-005', 'boss');
    const res = await end({ confirmSessionId: own }, 'boss', own);
    expect(res.status).toBe(403);
  });

  it('answers 400 and 404 for bad and unknown ids', async () => {
    expect((await end({ confirmSessionId: 'x' }, 'boss', 'x')).status).toBe(400);
    expect((await end({ confirmSessionId: 'sess-00000000' }, 'boss', 'sess-00000000')).status).toBe(404);
  });
});

describe('a class of five, and a sixth student', () => {
  it('shows every student on their own lab, capacity 5/5, and why the sixth was refused', async () => {
    const h = harness();
    await withRole(h, 'teacher', 'INSTRUCTOR');
    const plan = [
      ['amy', 'LINUX-001'],
      ['ben', 'DOCKER-001'],
      ['cai', 'K8S-001'],
      ['dee', 'TF-001'],
      ['eve', 'NET-006'],
    ] as const;
    const ids = new Map<string, string>();
    for (const [who, lab] of plan) ids.set(who, await start(h, lab, who));

    const sixth = await request(h.app).post('/api/labs/LINUX-005/start').set('Authorization', as('fin'));
    expect(sixth.status).toBe(503);
    expect(sixth.body.error.code).toBe('LAB_CAPACITY_REACHED');

    const res = await request(h.app).get('/api/admin/classroom').set('Authorization', as('teacher'));
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.capacity).toEqual({ active: 5, max: 5, available: 0, full: true, perStudentLimit: 1 });
    expect(data.newLabs.verdict).toBe('no');
    expect(data.newLabs.reasons.join(' ')).toMatch(/capacity is full: 5 of 5/);

    expect(data.sessions).toHaveLength(5);
    for (const [who, lab] of plan) {
      const row = data.sessions.find((r: { student: { name: string } }) => r.student.name === who);
      expect(row, who).toBeDefined();
      expect(row.lab.id).toBe(lab);
      expect(row.sessionId).toBe(ids.get(who));
      expect(row.state).toEqual({ label: 'Running', tone: 'ok' });
      expect(row.cleanup).toBe('not-started');
    }
    // No two rows share a student or a session.
    expect(new Set(data.sessions.map((r: { sessionId: string }) => r.sessionId)).size).toBe(5);
    expect(new Set(data.sessions.map((r: { student: { userId: string } }) => r.student.userId)).size).toBe(5);

    const refusal = data.problems.find((p: { operation: string }) => p.operation === 'start');
    expect(refusal).toMatchObject({ outcome: 'refused', code: 'LAB_CAPACITY_REACHED', by: 'student' });
    expect(refusal.student.name).toBe('fin');
    expect(refusal.text).toMatch(/Start refused — classroom capacity was full/);
    expect(refusal.lab.id).toBe('LINUX-005');

    // Everyone ends: the class returns to 0/5 and no row still holds a slot.
    for (const [who] of plan) {
      const end = await request(h.app).delete(`/api/sessions/${ids.get(who)}`).set('Authorization', as(who));
      expect(end.status, who).toBe(200);
    }
    const after = await request(h.app).get('/api/admin/classroom').set('Authorization', as('teacher'));
    expect(after.body.data.capacity).toMatchObject({ active: 0, available: 5, full: false });
    expect(after.body.data.sessions).toHaveLength(0);
    expect(after.body.data.recent).toHaveLength(5);
    for (const row of after.body.data.recent) {
      expect(row).toMatchObject({ status: 'ENDED', cleanup: 'confirmed', occupiesSlot: false });
      expect(row.state.label).toBe('Ended by student');
    }
  });
});

describe('what an instructor can find out', () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    await withRole(h, 'teacher', 'INSTRUCTOR');
  });

  it('tells a Check that broke from a Check that graded', async () => {
    const graded = await start(h, 'LINUX-001', 'amy');
    await request(h.app).post(`/api/sessions/${graded}/check`).set('Authorization', as('amy'));
    const broken = await start(h, 'K8S-001', 'ben');
    h.k8s.unreachable = 'connect ECONNREFUSED 172.18.0.5:6443';
    await request(h.app).post(`/api/sessions/${broken}/check`).set('Authorization', as('ben'));
    h.k8s.unreachable = undefined;

    const res = await request(h.app).get('/api/admin/classroom').set('Authorization', as('teacher'));
    const row = (id: string) => res.body.data.sessions.find((r: { sessionId: string }) => r.sessionId === id);
    expect(row(graded).lastCheck).toMatchObject({ outcome: 'fail', text: 'Check ran — not complete yet' });
    expect(row(graded).attention).toEqual([]);
    expect(row(broken).lastCheck).toMatchObject({ outcome: 'error', code: 'ENVIRONMENT_UNREACHABLE' });
    expect(row(broken).attention[0]).toMatchObject({ code: 'CHECK_ERROR', severity: 'problem' });
    expect(JSON.stringify(res.body)).not.toContain('172.18.0.5');
  });

  it('shows one lab’s timeline by Support ID, even after its live record is gone', async () => {
    const id = await start(h, 'LINUX-001', 'amy');
    await request(h.app).post(`/api/sessions/${id}/check`).set('Authorization', as('amy'));
    await request(h.app).delete(`/api/sessions/${id}`).set('Authorization', as('amy'));

    const live = await request(h.app).get(`/api/admin/sessions/${id}`).set('Authorization', as('teacher'));
    expect(live.status).toBe(200);
    expect(live.body.data.tracked).toBe(true);
    expect(live.body.data.session.student.name).toBe('amy');
    expect(live.body.data.attempt).toMatchObject({ labId: 'LINUX-001' });
    expect(live.body.data.timeline.map((e: { text: string }) => e.text)).toEqual([
      'Student ended the lab',
      'Cleanup confirmed — the student ended it',
      'Check ran — not complete yet',
      'Lab started',
    ]);

    // The retention purge removes the row; the timeline outlives it.
    await h.store.delete(id);
    const purged = await request(h.app).get(`/api/admin/sessions/${id}`).set('Authorization', as('teacher'));
    expect(purged.status).toBe(200);
    expect(purged.body.data.tracked).toBe(false);
    expect(purged.body.data.summary.student.name).toBe('amy');
    expect(purged.body.data.timeline).toHaveLength(4);
  });

  it('answers 400 for a malformed Support ID and 404 for an unknown one', async () => {
    expect((await request(h.app).get('/api/admin/sessions/not%20an%20id').set('Authorization', as('teacher'))).status).toBe(400);
    const unknown = await request(h.app).get('/api/admin/sessions/sess-0123456789ab').set('Authorization', as('teacher'));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('probes the runtime for one session only, and reports a missing sandbox', async () => {
    const id = await start(h, 'K8S-001', 'cai');
    const ok = await request(h.app).get(`/api/admin/sessions/${id}`).set('Authorization', as('teacher'));
    expect(ok.body.data.environment.phase).toBe('ready');
    // The database says the lab is running; the cluster no longer has it.
    const session = (await h.store.get(id))!;
    h.k8s.namespaces.delete(session.namespace);
    const missing = await request(h.app).get(`/api/admin/sessions/${id}`).set('Authorization', as('teacher'));
    expect(missing.body.data.environment.phase).not.toBe('ready');
  });

  it('finds students by name, bounded, with their live labs; a wildcard is just a character', async () => {
    await start(h, 'LINUX-001', 'amy');
    for (const name of ['amber', 'ambrose', 'bob']) {
      await h.users.upsert({ issuer: DevelopmentIdentityResolver.ISSUER, subject: name, displayName: name });
    }
    const found = await request(h.app).get('/api/admin/students?q=am').set('Authorization', as('teacher'));
    expect(found.status).toBe(200);
    expect(found.body.data.students.map((s: { student: { name: string } }) => s.student.name)).toEqual(['amber', 'ambrose', 'amy']);
    const amy = found.body.data.students.find((s: { student: { name: string } }) => s.student.name === 'amy');
    expect(amy.liveSessions).toHaveLength(1);
    expect(amy.liveSessions[0].lab.id).toBe('LINUX-001');

    expect((await request(h.app).get('/api/admin/students?q=%25').set('Authorization', as('teacher'))).status).toBe(400);
    expect((await request(h.app).get('/api/admin/students?q=%25%25').set('Authorization', as('teacher'))).body.data.students).toEqual([]);
    expect((await request(h.app).get(`/api/admin/students?q=${'x'.repeat(65)}`).set('Authorization', as('teacher'))).status).toBe(400);
  });

  it('shows one student’s live labs, history and timeline', async () => {
    const id = await start(h, 'LINUX-001', 'amy');
    await request(h.app).delete(`/api/sessions/${id}`).set('Authorization', as('amy'));
    await start(h, 'LINUX-005', 'amy');
    const amy = (await h.users.list()).find((user) => user.subject === 'amy')!;

    const res = await request(h.app).get(`/api/admin/students/${amy.userId}`).set('Authorization', as('teacher'));
    expect(res.status).toBe(200);
    expect(res.body.data.student.name).toBe('amy');
    expect(res.body.data.liveSessions.map((s: { lab: { id: string } }) => s.lab.id)).toEqual(['LINUX-005']);
    expect(res.body.data.history.map((a: { labId: string }) => a.labId)).toEqual(['LINUX-005', 'LINUX-001']);
    expect(res.body.data.timeline.length).toBeGreaterThanOrEqual(4);
    expect((await request(h.app).get('/api/admin/students/usr-99999999').set('Authorization', as('teacher'))).status).toBe(404);
  });

  it('lists every lab with whether it can run here', async () => {
    const res = await request(h.app).get('/api/admin/labs').set('Authorization', as('teacher'));
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(registry.size);
    const byId = new Map(res.body.data.labs.map((lab: { id: string }) => [lab.id, lab]));
    expect(byId.get('LINUX-001')).toMatchObject({ runnable: true, availability: 'Available', runtime: 'Linux labs' });
    // No Ansible provider is registered in this harness.
    const ansible = res.body.data.labs.find((lab: { provider: string }) => lab.provider === 'ansible');
    expect(ansible).toMatchObject({ runnable: false });
  });
});
