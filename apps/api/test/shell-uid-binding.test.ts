/**
 * The terminal binding carries the session's own shell uid — SEC-ARCH-2.
 *
 * A Kubernetes- or Docker-track shell runs in the terminal service's container,
 * as the uid the session store assigned the session. The terminal learns that
 * uid from one place only: the credential exchange, which resolves the session
 * record server-side (`/internal/sessions/:id/credentials`). This suite proves
 * that path end to end against a composed api:
 *
 *   - two students' sessions get two different uids, each valid;
 *   - a Start body naming a uid changes nothing;
 *   - a restarted api (a new manager over the same store) hands out the same uid;
 *   - a container-track binding, whose shell runs in its own sandbox, has none;
 *   - a local-shell session without a valid uid gets no binding at all.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
  InMemorySessionStore,
  KindLabProvider,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
  isValidShellUid,
  verifySessionToken,
  type LabRegistry,
  type LabSession,
  type SessionStore,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes, fakeExec } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { DevelopmentIdentityResolver } from '../src/auth/resolvers.js';
import { InMemoryUserRepository } from '../src/auth/users.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TERMINAL_SECRET = 'shell-uid-binding-terminal-secret';
const INTERNAL_SECRET = 'shell-uid-binding-internal-secret';
const K8S_LAB = 'K8S-001';
const LINUX_LAB = 'LINUX-001';

let registry: LabRegistry;

function compose(store: SessionStore, k8s = new FakeKubernetes()) {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: TERMINAL_SECRET,
    INTERNAL_SERVICE_SECRET: INTERNAL_SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_MODE: 'development',
    MAX_ACTIVE_SESSIONS: '10',
  } as NodeJS.ProcessEnv);
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new KindLabProvider({ k8s, clusterName: 'jumptotech-labs', exec: fakeExec() }) });
  providers.register({ provider: new LinuxLabProvider({ runtime: new FakeContainerRuntime() }) });
  const sessions = new SessionManager({
    registry,
    providers,
    store,
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: TERMINAL_SECRET,
  });
  const users = new InMemoryUserRepository();
  const app = createApp({
    registry,
    sessions,
    k8s,
    config,
    identityResolver: new DevelopmentIdentityResolver(users),
    browserAuth: { users },
  });
  return { app, sessions, k8s };
}

async function start(app: ReturnType<typeof compose>['app'], student: string, lab: string, body: object = {}) {
  const res = await request(app).post(`/api/labs/${lab}/start`).set('Authorization', `Developer ${student}`).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const claims = verifySessionToken(res.body.data.terminal.token, TERMINAL_SECRET);
  return { sessionId: claims.sid, owner: claims.uid, body: res.body };
}

async function binding(app: ReturnType<typeof compose>['app'], sessionId: string, owner: string) {
  return request(app)
    .post(`/internal/sessions/${sessionId}/credentials`)
    .set('x-internal-secret', INTERNAL_SECRET)
    .send({ ownerUserId: owner });
}

beforeEach(async () => {
  registry ??= await realCatalog();
});

describe('the terminal binding and the session shell uid', () => {
  it('gives two students’ Kubernetes shells two different uids, each the one stored on the session', async () => {
    const store = new InMemorySessionStore();
    const { app } = compose(store);
    const alice = await start(app, 'alice', K8S_LAB);
    const bob = await start(app, 'bob', K8S_LAB);

    const a = await binding(app, alice.sessionId, alice.owner);
    const b = await binding(app, bob.sessionId, bob.owner);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.data.kind).toBe('kubernetes');
    expect(isValidShellUid(a.body.data.shellUid)).toBe(true);
    expect(isValidShellUid(b.body.data.shellUid)).toBe(true);
    expect(a.body.data.shellUid).not.toBe(b.body.data.shellUid);
    expect(a.body.data.shellUid).toBe((await store.get(alice.sessionId))!.shellUid);

    // The browser is never told: it has no use for it.
    expect(JSON.stringify(alice.body)).not.toContain(String(a.body.data.shellUid));
  });

  it('ignores a uid named in the Start body', async () => {
    const store = new InMemorySessionStore();
    const { app } = compose(store);
    const planted = await start(app, 'mallory', K8S_LAB, { shellUid: 1001, uid: 0, gid: 0, user: 'root' });
    const res = await binding(app, planted.sessionId, planted.owner);
    expect(res.status).toBe(200);
    expect(isValidShellUid(res.body.data.shellUid)).toBe(true);
    expect(res.body.data.shellUid).not.toBe(1001);
  });

  it('hands out the same uid after an api restart', async () => {
    const store = new InMemorySessionStore();
    const k8s = new FakeKubernetes();
    const first = compose(store, k8s);
    const alice = await start(first.app, 'alice', K8S_LAB);
    const before = (await binding(first.app, alice.sessionId, alice.owner)).body.data.shellUid;

    // A new process: a new manager and app over the same rows.
    const restarted = compose(store, k8s);
    const after = await binding(restarted.app, alice.sessionId, alice.owner);
    expect(after.status).toBe(200);
    expect(after.body.data.shellUid).toBe(before);
  });

  it('gives a container-track binding no uid: that shell runs in its own sandbox', async () => {
    const { app } = compose(new InMemorySessionStore());
    const linux = await start(app, 'carol', LINUX_LAB);
    const res = await binding(app, linux.sessionId, linux.owner);
    expect(res.status).toBe(200);
    expect(res.body.data.kind).toBe('container-exec');
    expect(res.body.data).not.toHaveProperty('shellUid');
  });

  it('opens no local shell for a session without a valid uid', async () => {
    const store = new InMemorySessionStore();
    // A store that lost the uid — a row predating it, or a corrupted one.
    const stripped: SessionStore = new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'get' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value;
        return async (id: string) => {
          const found = (await target.get(id)) as LabSession | null;
          return found ? { ...found, shellUid: 1001 } : found;
        };
      },
    });
    const { app } = compose(stripped);
    const dave = await start(app, 'dave', K8S_LAB);
    const res = await binding(app, dave.sessionId, dave.owner);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CREDENTIALS_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('kubeconfig');
  });
});
