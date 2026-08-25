/**
 * PLATFORM-009 — a student can only reach their own session.
 *
 * The property that matters is not "the API asks for a token". It is that
 * knowing a session id is worth nothing. Ids are unpredictable, but they travel
 * — in a URL, a log, a screenshot, a support ticket — and the moment one is
 * enough to act, every one of those is a compromise.
 *
 * So each test below hands User B a real, live, correct identifier belonging to
 * User A and proves it buys nothing. Two users, two sessions, one API.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { fakeExec } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { DevelopmentIdentityResolver } from '../src/auth/resolvers.js';
import { InMemoryUserRepository } from '../src/auth/users.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'integration-test-secret-value';

/** Two students, as the Authorization header carries them. */
const ALICE = 'Developer alice';
const BOB = 'Developer bob';

let registry: LabRegistry;
let users: InMemoryUserRepository;

async function harness() {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_MODE: 'development',
  } as NodeJS.ProcessEnv);

  const runtime = new FakeContainerRuntime();
  const k8s = new FakeKubernetes();
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({
    provider: new KindLabProvider({ k8s, clusterName: 'jumptotech-labs', exec: fakeExec() }),
  });
  providers.register({ provider: new LinuxLabProvider({ runtime }) });

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
  return { app, sessions, runtime };
}

/** Start a lab as `who`, returning the session. */
async function start(app: unknown, who: string) {
  const res = await request(app as never)
    .post('/api/labs/LINUX-001/start')
    .set('Authorization', who);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.session as { sessionId: string; sandboxRef: string; namespace: string };
}

beforeEach(async () => {
  registry = new LabRegistry(path.join(repoRoot, 'labs'));
  await registry.load();
  // One user store across a test, so Alice is the same Alice throughout.
  users = new InMemoryUserRepository();
});

// -------------------------------------------------------- authentication

describe('every session route requires authentication', () => {
  it('refuses an unauthenticated start', async () => {
    const { app } = await harness();
    // The development resolver treats "no header" as its default identity, so
    // the sharper proof is that a *malformed* credential is refused outright
    // rather than falling back to somebody.
    const res = await request(app).post('/api/labs/LINUX-001/start').set('Authorization', 'Bearer nonsense');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_TOKEN');
  });

  it('refuses a malformed credential on every session route', async () => {
    const { app } = await harness();
    const alice = await start(app, ALICE);

    // A bearer token offered to a development deployment is a
    // misconfiguration, not an identity — every route refuses it.
    const forged = 'Bearer forged.token.value';
    const id = alice.sessionId;

    expect((await request(app).get(`/api/sessions/${id}`).set('Authorization', forged)).status).toBe(401);
    expect(
      (await request(app).post(`/api/sessions/${id}/check`).set('Authorization', forged)).status,
    ).toBe(401);
    expect(
      (await request(app).post(`/api/sessions/${id}/reset`).set('Authorization', forged)).status,
    ).toBe(401);
    expect(
      (await request(app).post(`/api/sessions/${id}/activity`).set('Authorization', forged)).status,
    ).toBe(401);
    expect(
      (await request(app).delete(`/api/sessions/${id}`).set('Authorization', forged)).status,
    ).toBe(401);
  });
});

// ------------------------------------------------- cross-user authorization

describe('one student cannot reach another student’s session', () => {
  it('denies every session operation across users', async () => {
    const { app } = await harness();
    const alice = await start(app, ALICE);
    const bob = await start(app, BOB);

    // Bob holds Alice's real session id. Every operation must refuse.
    const asBob = (r: string) => request(app).get(r).set('Authorization', BOB);
    expect((await asBob(`/api/sessions/${alice.sessionId}`)).status).toBe(404);

    for (const route of ['check', 'reset', 'activity'] as const) {
      const res = await request(app)
        .post(`/api/sessions/${alice.sessionId}/${route}`)
        .set('Authorization', BOB);
      expect(res.status, route).toBe(404);
    }

    const ended = await request(app)
      .delete(`/api/sessions/${alice.sessionId}`)
      .set('Authorization', BOB);
    expect(ended.status).toBe(404);

    // …and Alice's session is untouched by any of it.
    const still = await request(app)
      .get(`/api/sessions/${alice.sessionId}`)
      .set('Authorization', ALICE);
    expect(still.status).toBe(200);
    expect(still.body.data.session.status).toBe('ACTIVE');

    // Symmetric: Alice cannot reach Bob's either.
    expect(
      (await request(app).get(`/api/sessions/${bob.sessionId}`).set('Authorization', ALICE)).status,
    ).toBe(404);
  });

  it('answers "not yours" and "does not exist" identically', async () => {
    const { app } = await harness();
    const alice = await start(app, ALICE);

    const notMine = await request(app)
      .get(`/api/sessions/${alice.sessionId}`)
      .set('Authorization', BOB);
    const notReal = await request(app)
      .get('/api/sessions/sess-ffffffffffffffff')
      .set('Authorization', BOB);

    // Byte-identical, deliberately: a different answer would confirm the id is
    // real and turn guessing into enumeration.
    expect(notMine.status).toBe(notReal.status);
    expect(notMine.body).toEqual(notReal.body);
  });

  it('still rejects a malformed id as a bad request, not a missing one', async () => {
    const { app } = await harness();
    const res = await request(app).get('/api/sessions/not-a-session').set('Authorization', ALICE);

    // An id that could never be valid says nothing about which ids are real, so
    // the useful signal is kept.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_SESSION_ID');
  });

  it('gives each student their own sandbox, and no route back from one to the other', async () => {
    const { app } = await harness();
    const alice = await start(app, ALICE);
    const bob = await start(app, BOB);

    expect(alice.sandboxRef).not.toBe(bob.sandboxRef);

    // Knowing a sandbox name or a namespace is not a way in: neither is a
    // session id, so neither resolves to a session at all.
    for (const guess of [alice.sandboxRef, alice.namespace]) {
      const res = await request(app).get(`/api/sessions/${guess}`).set('Authorization', BOB);
      expect([400, 404]).toContain(res.status);
    }
  });

  it('does not let a check by one student decide another’s result', async () => {
    const { app, runtime } = await harness();
    const alice = await start(app, ALICE);
    const bob = await start(app, BOB);

    // Alice solves her lab.
    for (const [p, entry] of [
      ['/home/student/project', { type: 'directory' as const, mode: '755' }],
      ['/home/student/project/config.txt', { type: 'file' as const, mode: '644' }],
      ['/home/student/project/archive', { type: 'directory' as const, mode: '755' }],
      ['/home/student/project/archive/app.log', { type: 'file' as const, mode: '644' }],
    ] as const) {
      runtime.put(alice.sandboxRef, p, entry);
    }

    const hers = await request(app)
      .post(`/api/sessions/${alice.sessionId}/check`)
      .set('Authorization', ALICE);
    expect(hers.body.data.passed).toBe(true);

    // Bob's own lab is unaffected: verification reads his sandbox, not hers.
    const his = await request(app)
      .post(`/api/sessions/${bob.sessionId}/check`)
      .set('Authorization', BOB);
    expect(his.body.data.passed).toBe(false);
  });

  it('does not let one student reset or end another’s sandbox', async () => {
    const { app, runtime } = await harness();
    const alice = await start(app, ALICE);
    const bob = await start(app, BOB);

    await request(app).post(`/api/sessions/${alice.sessionId}/reset`).set('Authorization', BOB);
    await request(app).delete(`/api/sessions/${alice.sessionId}`).set('Authorization', BOB);

    // Alice's container is still there and still hers.
    expect(runtime.containers.has(alice.sandboxRef)).toBe(true);
    expect(runtime.containers.has(bob.sandboxRef)).toBe(true);
    const alicesSession = await request(app)
      .get(`/api/sessions/${alice.sessionId}`)
      .set('Authorization', ALICE);
    expect(alicesSession.body.data.session.status).toBe('ACTIVE');
  });
});

// ----------------------------------------------------------- ownership

describe('ownership is assigned server-side', () => {
  it('ignores any attempt to name an owner in the request', async () => {
    const { app, sessions } = await harness();

    const res = await request(app)
      .post('/api/labs/LINUX-001/start')
      .set('Authorization', ALICE)
      // Every shape a client might try. None is read: there is no owner
      // parameter anywhere on this route.
      .send({ ownerUserId: 'usr-00000001', owner: 'bob', userId: 'bob', sub: 'bob' });

    expect(res.status).toBe(200);
    const stored = await sessions.require(res.body.data.session.sessionId);
    const alice = await users.upsert({
      issuer: DevelopmentIdentityResolver.ISSUER,
      subject: 'alice',
    });
    expect(stored.ownerUserId).toBe(alice.userId);
  });

  it('never serves the owner id to the browser', async () => {
    const { app } = await harness();
    const alice = await start(app, ALICE);

    const res = await request(app)
      .get(`/api/sessions/${alice.sessionId}`)
      .set('Authorization', ALICE);

    // Internal identifiers stay internal: there is nothing here for a client to
    // quote back, and nothing to enumerate.
    expect(JSON.stringify(res.body)).not.toContain('ownerUserId');
  });
});
