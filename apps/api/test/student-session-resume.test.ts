/**
 * Student beta experience — a running lab can be returned to.
 *
 * The defect this pins: the only copy of a session id and a terminal token was
 * the page that pressed Start. A reload, Back, or a second tab left the student
 * with a sandbox they owned and could not reach — and Start answered
 * STUDENT_SESSION_LIMIT_REACHED, so there was no way forward at all until the
 * idle reaper released it.
 *
 * Two additive routes close it, and every test below is about what they must
 * *not* do as much as what they do:
 *
 *   GET  /api/sessions                      only the caller's own live sessions
 *   POST /api/sessions/:sessionId/terminal  a token only for the owner of an ACTIVE one
 */
import { beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
  verifySessionToken,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes, fakeExec } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { DevelopmentIdentityResolver } from '../src/auth/resolvers.js';
import { InMemoryUserRepository } from '../src/auth/users.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'student-session-resume-test-secret';

const ALICE = 'Developer alice';
const BOB = 'Developer bob';

let registry: LabRegistry;
let users: InMemoryUserRepository;

beforeEach(async () => {
  registry = await realCatalog();
  users = new InMemoryUserRepository();
});

async function harness(env: Record<string, string> = {}) {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_MODE: 'development',
    MAX_ACTIVE_SESSIONS: '5',
    MAX_ACTIVE_SESSIONS_PER_STUDENT: '1',
    ...env,
  } as NodeJS.ProcessEnv);

  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  const k8s = new FakeKubernetes();
  providers.register({
    provider: new KindLabProvider({ k8s, clusterName: 'jumptotech-labs', exec: fakeExec() }),
  });
  providers.register({ provider: new LinuxLabProvider({ runtime: new FakeContainerRuntime() }) });

  const sessions = new SessionManager({
    registry,
    providers,
    store: new InMemorySessionStore(),
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: SECRET,
  });

  const app = createApp({
    registry,
    sessions,
    k8s,
    config,
    identityResolver: new DevelopmentIdentityResolver(users),
  });
  return { app, sessions };
}

type App = Awaited<ReturnType<typeof harness>>['app'];

async function start(app: App, who: string, labId = 'LINUX-001') {
  const res = await request(app).post(`/api/labs/${labId}/start`).set('Authorization', who);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as {
    session: { sessionId: string; labId: string; status: string };
    terminal: { url: string; token: string };
  };
}

const mine = (app: App, who: string) => request(app).get('/api/sessions').set('Authorization', who);

describe('GET /api/sessions — the caller\'s own live sessions', () => {
  it('lets a student who lost the page find their running lab again, after Start refused them', async () => {
    const { app } = await harness();
    const started = await start(app, ALICE);

    // The dead end, as it was: a second Start is refused by the student's own limit.
    const again = await request(app).post('/api/labs/LINUX-001/start').set('Authorization', ALICE);
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('STUDENT_SESSION_LIMIT_REACHED');

    // The way back.
    const res = await mine(app, ALICE);
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.sessions[0].session.sessionId).toBe(started.session.sessionId);
    expect(res.body.data.sessions[0].session.status).toBe('ACTIVE');
    expect(res.body.data.sessions[0].labTitle).toBe(registry.get('LINUX-001').title);
    expect(res.body.data.limits).toEqual({ maxActiveSessionsPerStudent: 1 });
  });

  it('never shows one student another student\'s session', async () => {
    const { app } = await harness();
    await start(app, ALICE);

    const bob = await mine(app, BOB);
    expect(bob.status).toBe(200);
    expect(bob.body.data.sessions).toEqual([]);
    expect(JSON.stringify(bob.body)).not.toContain('alice');
  });

  it('carries no terminal token and nothing about how busy the platform is', async () => {
    const { app } = await harness();
    const started = await start(app, ALICE);
    const res = await mine(app, ALICE);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain(started.terminal.token);
    expect(body).not.toMatch(/"token"|maxActiveSessions"|activeSessions/);
  });

  it('drops a session once it has ended', async () => {
    const { app } = await harness();
    const started = await start(app, ALICE);
    const ended = await request(app)
      .delete(`/api/sessions/${started.session.sessionId}`)
      .set('Authorization', ALICE);
    expect(ended.status).toBe(200);

    expect((await mine(app, ALICE)).body.data.sessions).toEqual([]);
  });

  it('refuses a caller with no valid identity', async () => {
    const { app } = await harness();
    const res = await request(app).get('/api/sessions').set('Authorization', 'Bearer forged.token.value');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/sessions/:sessionId/terminal — a fresh terminal token', () => {
  it('issues a token bound to the same session and the same owner as Start did', async () => {
    const { app } = await harness();
    const started = await start(app, ALICE);

    const res = await request(app)
      .post(`/api/sessions/${started.session.sessionId}/terminal`)
      .set('Authorization', ALICE);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.terminal.url).toBe(started.terminal.url);
    expect(res.body.data.session.status).toBe('ACTIVE');

    const fresh = verifySessionToken(res.body.data.terminal.token, SECRET);
    const original = verifySessionToken(started.terminal.token, SECRET);
    expect(fresh.sid).toBe(original.sid);
    expect(fresh.uid).toBe(original.uid);
    expect(fresh.labId).toBe('LINUX-001');
    expect(fresh.exp).toBeLessThanOrEqual(fresh.iat + 3600);
  });

  it('gives another student the same 404 as a session that does not exist', async () => {
    const { app } = await harness();
    const started = await start(app, ALICE);

    const stolen = await request(app)
      .post(`/api/sessions/${started.session.sessionId}/terminal`)
      .set('Authorization', BOB);
    const missing = await request(app)
      .post('/api/sessions/sess-ffffffffffffffff/terminal')
      .set('Authorization', BOB);

    expect(stolen.status).toBe(404);
    expect(stolen.body.error.code).toBe(missing.body.error.code);
    expect(JSON.stringify(stolen.body)).not.toContain('token');
  });

  it('refuses a session that is no longer ACTIVE', async () => {
    const { app } = await harness();
    const started = await start(app, ALICE);
    await request(app).delete(`/api/sessions/${started.session.sessionId}`).set('Authorization', ALICE);

    const res = await request(app)
      .post(`/api/sessions/${started.session.sessionId}/terminal`)
      .set('Authorization', ALICE);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SESSION_NOT_ACTIVE');
    expect(res.body.data).toBeUndefined();
  });

  it('is refused without a valid identity', async () => {
    const { app } = await harness();
    const started = await start(app, ALICE);
    const res = await request(app)
      .post(`/api/sessions/${started.session.sessionId}/terminal`)
      .set('Authorization', 'Bearer forged.token.value');
    expect(res.status).toBe(401);
  });

  it('does not count as activity', async () => {
    const { app, sessions } = await harness();
    const started = await start(app, ALICE);
    const before = (await sessions.get(started.session.sessionId))!.lastActivityAt;
    await new Promise((resolve) => setTimeout(resolve, 5));

    await request(app).post(`/api/sessions/${started.session.sessionId}/terminal`).set('Authorization', ALICE);
    expect((await sessions.get(started.session.sessionId))!.lastActivityAt).toBe(before);
  });
});
