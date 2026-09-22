/**
 * Commercial access — signed in is not the same as entitled.
 *
 * ## The defect
 *
 * Before `access/entitlements.ts`, lab access *was* the account: any identity
 * the configured issuer authenticated was provisioned as STUDENT on first
 * sign-in and could start, attach, verify and reset labs indefinitely. There
 * was no way to grant access to a paying student only, to let it lapse, to
 * suspend it, or to take it away without deleting the person — and a terminal
 * token minted while somebody was a student kept opening shells after that
 * stopped being true. With the three enforcement points disabled — which is
 * the behaviour at 24e09f1 — five of the tests below fail: the first because
 * an account nobody granted anything starts a lab with a 200.
 *
 * ## The invariants
 *
 *   1. Under ACCESS_POLICY=entitlement, every route that *uses* a lab — Start,
 *      terminal grant, the terminal's credential exchange, Check, Reset, hints,
 *      Continue — refuses a caller whose access is not ACTIVE, 403
 *      ACCESS_NOT_ACTIVE, naming the state and nothing an operator wrote.
 *   2. Reading is not using: the catalog, the caller's own sessions, End, and
 *      their progress history stay available whatever the state.
 *   3. Nothing a student can send changes their access.
 *   4. Access is checked live, so expiry, suspension and revocation take
 *      effect on the next request with no job and no sign-out.
 *   5. Under ACCESS_POLICY=open, nothing changes from before.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
} from '@jumptotech/lab-orchestrator';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { DevelopmentIdentityResolver } from '../src/auth/resolvers.js';
import { InMemoryUserRepository } from '../src/auth/users.js';
import type { AuthAuditEvent } from '../src/auth/middleware.js';
import {
  AccessControl,
  InMemoryAccessStore,
  type AccessAction,
  type AccessPolicy,
  type GrantRequest,
} from '../src/access/entitlements.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'commercial-access-test-secret-value';
const LAB = 'LINUX-001';

let registry: LabRegistry;
beforeAll(async () => {
  registry = await realCatalog();
});

interface Harness {
  app: Express;
  users: InMemoryUserRepository;
  store: InMemoryAccessStore;
  audit: AuthAuditEvent[];
  clock: { now: number };
  /** An operator change, exactly as the socket makes it. */
  admin(action: AccessAction, subject: string, grant?: GrantRequest): Promise<void>;
  userId(subject: string): Promise<string>;
}

function compose(policy: AccessPolicy, env: Record<string, string> = {}): Harness {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_MODE: 'development',
    MAX_ACTIVE_SESSIONS_PER_STUDENT: '1',
    ACCESS_POLICY: policy,
    ...env,
  } as NodeJS.ProcessEnv);

  const users = new InMemoryUserRepository();
  const store = new InMemoryAccessStore(users);
  const clock = { now: Date.parse('2026-10-01T12:00:00.000Z') };
  const access = new AccessControl(store, config.accessPolicy, () => new Date(clock.now));
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime: new FakeContainerRuntime() }) });
  const audit: AuthAuditEvent[] = [];

  const app = createApp({
    registry,
    sessions: new SessionManager({
      registry,
      providers,
      store: new InMemorySessionStore(),
      policy: DEFAULT_SESSION_POLICY,
      lifetimes: config.lifetimes,
      namespaceSecret: SECRET,
    }),
    k8s: undefined as never,
    config,
    identityResolver: new DevelopmentIdentityResolver(users),
    browserAuth: { users },
    access,
    authAudit: (event) => audit.push(event),
  });

  const userId = async (subject: string) => {
    const found = (await users.list()).find((user) => user.subject === subject);
    if (!found) throw new Error(`${subject} has not signed in`);
    return found.userId;
  };

  return {
    app,
    users,
    store,
    audit,
    clock,
    userId,
    admin: async (action, subject, grant) => {
      await store.mutate(
        { userId: await userId(subject), action, actor: 'ops-test', reason: `test ${action}`, ...(grant ? { grant } : {}) },
        () => new Date(clock.now),
      );
    },
  };
}

const as = (who: string) => ({ Authorization: `Developer ${who}` });
const HOUR = 60 * 60 * 1000;

async function signIn(h: Harness, who: string) {
  const res = await request(h.app).get('/api/me').set(as(who));
  expect(res.status).toBe(200);
}

async function start(h: Harness, who: string) {
  return request(h.app).post(`/api/labs/${LAB}/start`).set(as(who));
}

function expectDenied(res: request.Response, state: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(403);
  expect(res.body.error.code).toBe('ACCESS_NOT_ACTIVE');
  expect(res.body.error.details).toEqual({ accessState: state });
  // Only the state: never who granted it, why, or when an operator changed it.
  expect(JSON.stringify(res.body)).not.toMatch(/ops-test|test (GRANT|SUSPEND|REVOKE|RESTORE)/);
}

describe('ACCESS_POLICY=entitlement: a signed-in account is not an entitled one', () => {
  let h: Harness;
  beforeEach(() => {
    h = compose('entitlement');
  });

  it('refuses Start Lab to an account nobody granted, without opening an attempt or taking a slot', async () => {
    await signIn(h, 'newcomer');

    expectDenied(await start(h, 'newcomer'), 'NONE');

    // No FAILED attempt, and no session: the refusal wrote nothing.
    const attempts = await request(h.app).get('/api/me/attempts').set(as('newcomer'));
    expect(attempts.status).toBe(200);
    expect(attempts.body.data.attempts).toEqual([]);
    const sessions = await request(h.app).get('/api/sessions').set(as('newcomer'));
    expect(sessions.body.data.sessions).toEqual([]);

    // The refusal is audited as its own result, with the state.
    expect(h.audit).toContainEqual(
      expect.objectContaining({ action: 'session:start', authorizationResult: 'denied-access', accessState: 'NONE' }),
    );
  });

  it('still shows the catalog, the student their own access, and their history', async () => {
    await signIn(h, 'browser');
    expect((await request(h.app).get('/api/labs').set(as('browser'))).status).toBe(200);
    expect((await request(h.app).get(`/api/labs/${LAB}`).set(as('browser'))).status).toBe(200);
    expect((await request(h.app).get('/api/me/progress').set(as('browser'))).status).toBe(200);

    const access = await request(h.app).get('/api/me/access').set(as('browser'));
    expect(access.status).toBe(200);
    expect(access.body.data.access).toEqual({
      policy: 'entitlement',
      state: 'NONE',
      active: false,
      startsAt: null,
      expiresAt: null,
    });
  });

  it('walks the lifecycle: granted → active → expired → re-granted → suspended → restored → revoked', async () => {
    await signIn(h, 'learner');
    const until = new Date(h.clock.now + 2 * HOUR).toISOString();
    await h.admin('GRANT', 'learner', { expiresAt: until });

    const me = await request(h.app).get('/api/me/access').set(as('learner'));
    expect(me.body.data.access).toMatchObject({ state: 'ACTIVE', active: true, expiresAt: until });

    const started = await start(h, 'learner');
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const sessionId = started.body.data.session.sessionId as string;
    const terminal = () => request(h.app).post(`/api/sessions/${sessionId}/terminal`).set(as('learner'));
    expect((await terminal()).status).toBe(200);

    // The window closes at `until` exactly — half-open, so one ms before is still in.
    h.clock.now = Date.parse(until) - 1;
    expect((await terminal()).status).toBe(200);
    h.clock.now = Date.parse(until);
    expectDenied(await terminal(), 'EXPIRED');

    // Every lab-use route on the *running* session is refused …
    expectDenied(await request(h.app).post(`/api/sessions/${sessionId}/check`).set(as('learner')), 'EXPIRED');
    expectDenied(await request(h.app).post(`/api/sessions/${sessionId}/reset`).set(as('learner')), 'EXPIRED');
    expectDenied(
      await request(h.app).post(`/api/sessions/${sessionId}/hints`).set(as('learner')).send({}),
      'EXPIRED',
    );
    expectDenied(await request(h.app).post(`/api/sessions/${sessionId}/activity`).set(as('learner')), 'EXPIRED');
    // … and so is a new one.
    expectDenied(await start(h, 'learner'), 'EXPIRED');

    // Reading is not using: the session, the list, history and progress stay.
    expect((await request(h.app).get(`/api/sessions/${sessionId}`).set(as('learner'))).status).toBe(200);
    expect((await request(h.app).get('/api/sessions').set(as('learner'))).body.data.sessions).toHaveLength(1);
    expect((await request(h.app).get('/api/me/attempts').set(as('learner'))).body.data.attempts).toHaveLength(1);

    // A later grant extends it; the same session is usable again.
    await h.admin('GRANT', 'learner', { expiresAt: new Date(h.clock.now + 24 * HOUR).toISOString() });
    expect((await terminal()).status).toBe(200);

    await h.admin('SUSPEND', 'learner');
    expectDenied(await terminal(), 'SUSPENDED');
    await h.admin('RESTORE', 'learner');
    expect((await terminal()).status).toBe(200);

    await h.admin('REVOKE', 'learner');
    expectDenied(await terminal(), 'REVOKED');
    expect((await request(h.app).get('/api/me/access').set(as('learner'))).body.data.access).toMatchObject({
      state: 'REVOKED',
      active: false,
    });

    // End stays available, so a student without access can still free their slot.
    expect((await request(h.app).delete(`/api/sessions/${sessionId}`).set(as('learner'))).status).toBe(200);

    // Revocation deleted nothing: the account signs in, and its history is there.
    expect((await request(h.app).get('/api/me/attempts').set(as('learner'))).body.data.attempts).toHaveLength(1);
  });

  it('opens a scheduled grant only when its window does', async () => {
    await signIn(h, 'cohort');
    const from = new Date(h.clock.now + HOUR).toISOString();
    await h.admin('GRANT', 'cohort', { startsAt: from, expiresAt: new Date(h.clock.now + 5 * HOUR).toISOString() });
    expectDenied(await start(h, 'cohort'), 'SCHEDULED');
    h.clock.now = Date.parse(from);
    expect((await start(h, 'cohort')).status).toBe(200);
  });

  it('refuses the terminal credential exchange for a token minted before access ended', async () => {
    await signIn(h, 'holder');
    await h.admin('GRANT', 'holder', { expiresAt: null });
    const started = await start(h, 'holder');
    expect(started.status).toBe(200);
    const sessionId = started.body.data.session.sessionId as string;
    const ownerUserId = await h.userId('holder');

    const exchange = () =>
      request(h.app)
        .post(`/internal/sessions/${sessionId}/credentials`)
        .set('x-internal-secret', SECRET)
        .send({ ownerUserId });
    expect((await exchange()).status).toBe(200);

    // The token in the browser is unchanged and still validly signed; the
    // live entitlement is what the API consults on every attach.
    await h.admin('REVOKE', 'holder');
    const refused = await exchange();
    expectDenied(refused, 'REVOKED');
  });

  it('gives a student no way to grant, extend or restore their own access', async () => {
    await signIn(h, 'mallory');
    const mine = await h.userId('mallory');

    // No browser route mutates access: every plausible shape is a 404.
    for (const [method, url] of [
      ['post', '/api/me/access'],
      ['post', '/api/me/access/grant'],
      ['post', `/api/access/${mine}/grant`],
      ['post', `/api/admin/access/${mine}/grant`],
      ['get', '/api/access'],
    ] as const) {
      const res = await request(h.app)[method](url).set(as('mallory')).send({ until: '2099-01-01T00:00:00Z', by: 'mallory' });
      expect(res.status, `${method} ${url}`).toBe(404);
    }

    // Fields on a Start body are not read: mass assignment has nothing to assign to.
    const smuggled = await request(h.app)
      .post(`/api/labs/${LAB}/start`)
      .set(as('mallory'))
      .send({ access: { state: 'ACTIVE' }, entitlement: { status: 'ACTIVE' }, accessState: 'ACTIVE', role: 'ADMIN' });
    expectDenied(smuggled, 'NONE');

    // Neither a claimed role nor a header changes the answer.
    const headers = await request(h.app)
      .post(`/api/labs/${LAB}/start`)
      .set({ ...as('mallory'), 'x-access-state': 'ACTIVE', 'x-dev-student-id': 'someone-else' });
    expectDenied(headers, 'NONE');

    expect(await h.store.get(mine)).toBeNull();
  });

  it("does not reveal another student's session through the access refusal", async () => {
    await signIn(h, 'alice');
    await signIn(h, 'bob');
    await h.admin('GRANT', 'alice', { expiresAt: null });
    const started = await start(h, 'alice');
    const sessionId = started.body.data.session.sessionId as string;

    // Bob has no access *and* does not own the session: he gets the same 404
    // as for a session that does not exist, not a 403 confirming it is real.
    const probe = await request(h.app).post(`/api/sessions/${sessionId}/terminal`).set(as('bob'));
    expect(probe.status).toBe(404);
    expect(probe.body.error.code).toBe('SESSION_NOT_FOUND');
  });

  it('keeps the per-student session limit for an entitled student', async () => {
    await signIn(h, 'busy');
    await h.admin('GRANT', 'busy', { expiresAt: null });
    expect((await start(h, 'busy')).status).toBe(200);
    const second = await start(h, 'busy');
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('STUDENT_SESSION_LIMIT_REACHED');
  });
});

describe('ACCESS_POLICY=open: the behaviour before entitlements existed', () => {
  it('lets every signed-in account use labs, and says so', async () => {
    const h = compose('open');
    await signIn(h, 'anyone');
    const started = await start(h, 'anyone');
    expect(started.status).toBe(200);
    const access = await request(h.app).get('/api/me/access').set(as('anyone'));
    expect(access.body.data.access).toMatchObject({ policy: 'open', state: 'NONE', active: true });
  });

  it('is what a caller composing createApp without an access control gets', async () => {
    const config = loadConfig({
      TERMINAL_SESSION_SECRET: SECRET,
      LABS_DIR: path.join(repoRoot, 'labs'),
      ALLOWED_ORIGINS: 'http://localhost:3000',
    } as NodeJS.ProcessEnv);
    expect(config.accessPolicy).toBe('open');
  });
});

describe('ACCESS_POLICY configuration', () => {
  const base = {
    TERMINAL_SESSION_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
  };

  it('defaults to open outside production', () => {
    expect(loadConfig({ ...base } as NodeJS.ProcessEnv).accessPolicy).toBe('open');
    expect(loadConfig({ ...base, NODE_ENV: 'test' } as NodeJS.ProcessEnv).accessPolicy).toBe('open');
  });

  it('is honoured when set, in either case', () => {
    expect(loadConfig({ ...base, ACCESS_POLICY: 'Entitlement' } as NodeJS.ProcessEnv).accessPolicy).toBe('entitlement');
    expect(loadConfig({ ...base, ACCESS_POLICY: ' open ' } as NodeJS.ProcessEnv).accessPolicy).toBe('open');
  });

  it('defaults to entitlement under NODE_ENV=production, and open must be chosen out loud', () => {
    const hex = (label: string) => createHash('sha256').update(label).digest('hex');
    // The production fixture production-oidc-config.test.ts uses, reduced to what loadConfig needs.
    const production = {
      NODE_ENV: 'production',
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: 'https://issuer.example.com/',
      OIDC_CLIENT_ID: 'jumptotech-labs',
      OIDC_CLIENT_SECRET: hex('access-oidc-client-secret').slice(0, 40),
      OIDC_AUDIENCE: 'jumptotech-labs-api',
      PUBLIC_ORIGIN: 'https://labs.example.com',
      ALLOWED_ORIGINS: 'https://labs.example.com',
      TERMINAL_SESSION_SECRET: hex('access-terminal'),
      INTERNAL_SERVICE_SECRET: hex('access-internal'),
      NAMESPACE_DERIVATION_SECRET: hex('access-namespace'),
      OBSERVABILITY_SCRAPE_TOKEN: hex('access-scrape'),
      RUNTIME_OWNER_ID: 'labs-prod',
      DATABASE_URL: `postgresql://jumptotech:${hex('access-database').slice(0, 32)}@127.0.0.1:5432/jumptotech_labs`,
    } as NodeJS.ProcessEnv;
    expect(loadConfig(production).accessPolicy).toBe('entitlement');
    expect(loadConfig({ ...production, ACCESS_POLICY: 'open' }).accessPolicy).toBe('open');
  });

  it('refuses a value that is neither, rather than guessing', () => {
    for (const value of ['closed', 'true', 'none', 'entitlements']) {
      expect(() => loadConfig({ ...base, ACCESS_POLICY: value } as NodeJS.ProcessEnv), value).toThrow(/ACCESS_POLICY/);
    }
  });
});
