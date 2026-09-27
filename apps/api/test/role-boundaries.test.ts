/**
 * What an instructor or an administrator may do to a student's lab — over HTTP.
 *
 * `authorize()` is unit-tested role by role (`authentication.test.ts`); this is
 * the same table proved through the routes, against one composed API, with
 * real stored roles. The roles are set the only way they can be: in the user
 * store, by an administrator. Nothing a request carries can choose one.
 *
 * ```text
 *                   read  terminal  check  reset  activity  hint  end
 *   owner            ✓      ✓        ✓      ✓       ✓       ✓     ✓
 *   STUDENT          ✗      ✗        ✗      ✗       ✗       ✗     ✗
 *   INSTRUCTOR       ✓      ✗        ✗      ✗       ✗       ✗     ✗
 *   ADMIN            ✓      ✗        ✗      ✗       ✗       ✗     ✓
 * ```
 *
 * And for every role: an unowned session is nobody's, "my sessions" is only
 * the caller's own, and the terminal is owner-only on the internal path too.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
  InMemorySessionStore,
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
import type { AuthAuditEvent } from '../src/auth/middleware.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TERMINAL_SECRET = 'role-boundaries-terminal-session-secret';
const INTERNAL_SECRET = 'role-boundaries-internal-service-secret';
const LAB = 'LINUX-001';
const as = (name: string) => `Developer ${name}`;

let app: ReturnType<typeof createApp>;
let sessions: SessionManager;
let users: InMemoryUserRepository;
let audit: AuthAuditEvent[];

async function start(name: string): Promise<{ sessionId: string; userId: string }> {
  const res = await request(app).post(`/api/labs/${LAB}/start`).set('Authorization', as(name));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    sessionId: res.body.data.session.sessionId,
    userId: verifySessionToken(res.body.data.terminal.token, TERMINAL_SECRET).uid,
  };
}

/** A user who exists and holds `role`, set in the store as an administrator would. */
async function withRole(name: string, role: 'INSTRUCTOR' | 'ADMIN'): Promise<string> {
  const me = await request(app).get('/api/me').set('Authorization', as(name));
  expect(me.status).toBe(200);
  const user = await users.upsert({ issuer: DevelopmentIdentityResolver.ISSUER, subject: name, displayName: name });
  await users.setRole(user.userId, role);
  return user.userId;
}

const OWNER_ONLY = [
  ['post', 'terminal'],
  ['post', 'check'],
  ['post', 'reset'],
  ['post', 'activity'],
  ['post', 'hints'],
] as const;

beforeEach(async () => {
  const registry = await realCatalog();
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: TERMINAL_SECRET,
    INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_MODE: 'development',
    MAX_ACTIVE_SESSIONS: '10',
  } as NodeJS.ProcessEnv);
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime: new FakeContainerRuntime() }) });
  sessions = new SessionManager({
    registry,
    providers,
    store: new InMemorySessionStore(),
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: TERMINAL_SECRET,
  });
  users = new InMemoryUserRepository();
  audit = [];
  app = createApp({
    registry,
    sessions,
    k8s: new FakeKubernetes(),
    config,
    identityResolver: new DevelopmentIdentityResolver(users),
    browserAuth: { users },
    authAudit: (event) => audit.push(event),
  });
});

describe('an instructor', () => {
  it('may read a student’s session, and do nothing else to it', async () => {
    const alice = await start('alice');
    await withRole('teacher', 'INSTRUCTOR');

    const read = await request(app).get(`/api/sessions/${alice.sessionId}`).set('Authorization', as('teacher'));
    expect(read.status).toBe(200);
    expect(read.body.data.session.sessionId).toBe(alice.sessionId);
    // A read is a status view: no terminal grant, no owner id.
    expect(JSON.stringify(read.body)).not.toMatch(/token|ownerUserId|kubeconfig/i);

    for (const [method, action] of OWNER_ONLY) {
      const res = await request(app)[method](`/api/sessions/${alice.sessionId}/${action}`)
        .set('Authorization', as('teacher'))
        .send({ level: 1 });
      expect(res.status, action).toBe(404);
      expect(res.body.error.code, action).toBe('SESSION_NOT_FOUND');
    }
    const end = await request(app).delete(`/api/sessions/${alice.sessionId}`).set('Authorization', as('teacher'));
    expect(end.status).toBe(404);

    const still = await request(app).get(`/api/sessions/${alice.sessionId}`).set('Authorization', as('alice'));
    expect(still.body.data.session.status).toBe('ACTIVE');
  });
});

describe('an administrator', () => {
  it('may read and end a student’s session, but not attach, check, reset, hint or keep it alive', async () => {
    const alice = await start('alice');
    await withRole('boss', 'ADMIN');

    expect((await request(app).get(`/api/sessions/${alice.sessionId}`).set('Authorization', as('boss'))).status).toBe(200);
    for (const [method, action] of OWNER_ONLY) {
      const res = await request(app)[method](`/api/sessions/${alice.sessionId}/${action}`)
        .set('Authorization', as('boss'))
        .send({ level: 1 });
      expect(res.status, action).toBe(404);
    }

    const end = await request(app).delete(`/api/sessions/${alice.sessionId}`).set('Authorization', as('boss'));
    expect(end.status).toBe(200);
    expect(end.body.data.session.status).toBe('ENDED');
    // The decision is on the record as a role decision, not an ownership one.
    expect(audit).toContainEqual(
      expect.objectContaining({ action: 'session:end', sessionId: alice.sessionId, authorizationResult: 'allowed' }),
    );
  });

  it('cannot open a student’s terminal through the internal path with its own identity', async () => {
    const alice = await start('alice');
    const bossId = await withRole('boss', 'ADMIN');
    const res = await request(app)
      .post(`/internal/sessions/${alice.sessionId}/credentials`)
      .set('x-internal-secret', INTERNAL_SECRET)
      .send({ ownerUserId: bossId });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SESSION_NOT_OWNED');
  });
});

describe('every role', () => {
  it('lists only its own sessions, never the ones it may read', async () => {
    await start('alice');
    await withRole('teacher', 'INSTRUCTOR');
    await withRole('boss', 'ADMIN');
    for (const name of ['teacher', 'boss']) {
      const mine = await request(app).get('/api/sessions').set('Authorization', as(name));
      expect(mine.status).toBe(200);
      expect(mine.body.data.count, name).toBe(0);
    }
  });

  it('cannot reach a session that has no owner — not even an administrator', async () => {
    const orphan = await sessions.start(LAB);
    await withRole('boss', 'ADMIN');
    for (const name of ['boss', 'alice']) {
      expect((await request(app).get(`/api/sessions/${orphan.session.sessionId}`).set('Authorization', as(name))).status).toBe(404);
      expect((await request(app).delete(`/api/sessions/${orphan.session.sessionId}`).set('Authorization', as(name))).status).toBe(404);
    }
    expect(audit.filter((e) => e.sessionId === orphan.session.sessionId).map((e) => e.authorizationResult)).toContain(
      'denied-unowned',
    );
  });

  it('is decided by the stored role alone: nothing in the request can claim one', async () => {
    const alice = await start('alice');
    const attempts = [
      request(app).get(`/api/sessions/${alice.sessionId}?role=ADMIN`).set('Authorization', as('mallory')),
      request(app).get(`/api/sessions/${alice.sessionId}`).set('Authorization', as('mallory')).set('X-Role', 'ADMIN'),
      request(app)
        .delete(`/api/sessions/${alice.sessionId}`)
        .set('Authorization', as('mallory'))
        .send({ role: 'ADMIN', user: { role: 'ADMIN' } }),
      request(app).get(`/api/sessions/${alice.sessionId}`).set('Authorization', 'Developer ADMIN'),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(404);
    }
    const still = await request(app).get(`/api/sessions/${alice.sessionId}`).set('Authorization', as('alice'));
    expect(still.body.data.session.status).toBe('ACTIVE');
  });
});
