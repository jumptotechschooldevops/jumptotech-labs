/**
 * Plans, beta grants and trials — enforced at the server, on every lab use.
 *
 * ## What this adds to `commercial-access.test.ts`
 *
 * Before plans, an ACTIVE entitlement meant every track and the deployment's
 * per-student limit; nothing could say "Linux only", "one lab at a time on
 * this plan", "private beta" or "a 14-day trial". Now:
 *
 *   1. A plan's tracks are checked where a lab is used — Start, and every
 *      route acting on a running lab (the session's lab decides) — and a lab
 *      outside them is refused 403 LAB_NOT_IN_PLAN, naming the track.
 *   2. A plan lowers the per-student limit and never raises it; the session
 *      manager applies it inside its capacity lock.
 *   3. An entitlement on a plan that configuration no longer defines is
 *      refused (ACCESS_PLAN_UNAVAILABLE), never read as "no plan".
 *   4. A trial is started once per account, for the configured length, and
 *      ends by the clock like any other window.
 *   5. None of it applies under ACCESS_POLICY=open.
 *   6. Nothing a student sends changes any of it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
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
import {
  AccessControl,
  AccessError,
  InMemoryAccessStore,
  type AccessPolicy,
  type MutationInput,
} from '../src/access/entitlements.js';
import { parsePlans } from '../src/access/plans.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'access-plans-test-secret-value';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Fixture plans. Not product decisions: the product has made none. */
const PLANS = parsePlans({
  plans: [
    { id: 'fixture-linux', name: 'Linux only', tracks: ['linux'] },
    { id: 'fixture-docker', name: 'Docker only', tracks: ['docker'] },
    { id: 'fixture-one-lab', name: 'One lab at a time', tracks: 'all', maxConcurrentSessions: 1 },
    { id: 'fixture-many-labs', name: 'Many labs', tracks: 'all', maxConcurrentSessions: 5 },
  ],
});

let registry: LabRegistry;
beforeAll(async () => {
  registry = await realCatalog();
});

interface Harness {
  app: Express;
  store: InMemoryAccessStore;
  clock: { now: number };
  unknownPlans: string[];
  change(subject: string, input: Omit<MutationInput, 'userId' | 'actor' | 'reason'>): Promise<void>;
}

function compose(policy: AccessPolicy, perStudent = 1): Harness {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_MODE: 'development',
    MAX_ACTIVE_SESSIONS_PER_STUDENT: String(perStudent),
    ACCESS_POLICY: policy,
  } as NodeJS.ProcessEnv);

  const users = new InMemoryUserRepository();
  const store = new InMemoryAccessStore(users);
  const clock = { now: Date.parse('2026-10-01T12:00:00.000Z') };
  const unknownPlans: string[] = [];
  const access = new AccessControl(store, config.accessPolicy, () => new Date(clock.now), {
    plans: PLANS,
    deploymentSessionLimit: perStudent,
    trackOfLab: (labId) => (registry.has(labId) ? registry.get(labId).track : undefined),
    onUnknownPlan: (planId) => unknownPlans.push(planId),
  });
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime: new FakeContainerRuntime() }) });

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
  });

  return {
    app,
    store,
    clock,
    unknownPlans,
    change: async (subject, input) => {
      await request(app).get('/api/me').set(as(subject)); // first sign-in creates the account
      const user = (await users.list()).find((u) => u.subject === subject)!;
      await store.mutate(
        { ...input, userId: user.userId, actor: 'ops-test', reason: `test ${input.action}` },
        () => new Date(clock.now),
      );
    },
  };
}

const as = (who: string) => ({ Authorization: `Developer ${who}` });
const start = (h: Harness, who: string, lab: string) => request(h.app).post(`/api/labs/${lab}/start`).set(as(who));
const grant = (expiresAt: string | null, extra: Record<string, unknown> = {}) => ({
  action: 'GRANT' as const,
  grant: { expiresAt, ...extra },
});

describe('a plan decides which tracks an active entitlement covers', () => {
  it('starts a lab in the plan and refuses one outside it, naming the track', async () => {
    const h = compose('entitlement');
    await h.change('ana', grant(null, { planId: 'fixture-linux' }));

    const outside = await start(h, 'ana', 'DOCKER-001');
    expect(outside.status, JSON.stringify(outside.body)).toBe(403);
    expect(outside.body.error).toEqual({
      code: 'LAB_NOT_IN_PLAN',
      message: 'Your plan does not include the docker track.',
      details: { track: 'docker', planId: 'fixture-linux' },
    });

    const inside = await start(h, 'ana', 'LINUX-001');
    expect(inside.status, JSON.stringify(inside.body)).toBe(200);
  });

  it('a plan change reaches a running lab on its next use; End still works', async () => {
    const h = compose('entitlement');
    await h.change('ben', grant(null, { planId: 'fixture-linux' }));
    const started = await start(h, 'ben', 'LINUX-001');
    expect(started.status).toBe(200);
    const sessionId = started.body.data.session.sessionId as string;

    await h.change('ben', grant(null, { planId: 'fixture-docker' }));
    for (const route of ['terminal', 'check', 'reset', 'activity']) {
      const used = await request(h.app).post(`/api/sessions/${sessionId}/${route}`).set(as('ben'));
      expect(used.status, `${route}: ${JSON.stringify(used.body)}`).toBe(403);
      expect(used.body.error.code).toBe('LAB_NOT_IN_PLAN');
    }
    const ended = await request(h.app).delete(`/api/sessions/${sessionId}`).set(as('ben'));
    expect(ended.status).toBe(200);
  });

  it('an entitlement on a plan nobody configures any more is refused, not widened to "every track"', async () => {
    const h = compose('entitlement');
    await h.change('cy', grant(null, { planId: 'fixture-linux' }));
    // The same store, read by a process whose plan file no longer has the plan.
    const moved = new AccessControl(h.store, 'entitlement', () => new Date(h.clock.now), {
      plans: parsePlans({ plans: [] }),
      onUnknownPlan: (planId) => h.unknownPlans.push(planId),
    });
    const userId = (await h.store.accounts(10))[0]!.userId;
    const decision = await moved.decide(userId, { track: 'linux' });
    expect(decision).toEqual({ allowed: false, state: 'ACTIVE', refusal: 'PLAN_UNAVAILABLE', planId: 'fixture-linux' });
    expect(h.unknownPlans).toEqual(['fixture-linux']);
  });

  it('under ACCESS_POLICY=open no plan applies', async () => {
    const h = compose('open');
    await h.change('dee', grant(null, { planId: 'fixture-linux' }));
    const res = await start(h, 'dee', 'DOCKER-001');
    // Whatever else refuses it here (no Docker runtime in this harness), a plan does not.
    expect(res.body.error?.code).not.toBe('LAB_NOT_IN_PLAN');
    expect(res.body.error?.code).not.toBe('ACCESS_NOT_ACTIVE');
  });

  it('shows the student their own plan, kind and limit — and nothing they send changes them', async () => {
    const h = compose('entitlement', 3);
    await h.change('eve', grant(null, { planId: 'fixture-one-lab', kind: 'BETA' }));
    const me = await request(h.app).get('/api/me/access').set(as('eve'));
    expect(me.body.data.access).toMatchObject({
      policy: 'entitlement',
      state: 'ACTIVE',
      active: true,
      kind: 'BETA',
      plan: { id: 'fixture-one-lab', name: 'One lab at a time', tracks: 'all' },
      maxConcurrentSessions: 1,
    });

    for (const body of [{ planId: 'fixture-many-labs' }, { kind: 'STANDARD' }, { plan: 'fixture-many-labs' }]) {
      await request(h.app).post('/api/me/access').set(as('eve')).send(body);
      await request(h.app).post('/api/labs/LINUX-001/start').set(as('eve')).send(body);
    }
    const after = await request(h.app).get('/api/me/access').set(as('eve'));
    expect(after.body.data.access.plan.id).toBe('fixture-one-lab');
    expect(after.body.data.access.kind).toBe('BETA');
  });
});

describe('a plan lowers the per-student limit and never raises it', () => {
  it('plan limit 1 under a deployment limit of 3: the second lab is refused', async () => {
    const h = compose('entitlement', 3);
    await h.change('fay', grant(null, { planId: 'fixture-one-lab' }));
    expect((await start(h, 'fay', 'LINUX-001')).status).toBe(200);
    const second = await start(h, 'fay', 'LINUX-002');
    expect(second.status, JSON.stringify(second.body)).toBe(429);
    expect(second.body.error.code).toBe('STUDENT_SESSION_LIMIT_REACHED');
    expect(second.body.error.details).toMatchObject({ activeSessions: 1, maxActiveSessionsPerStudent: 1 });
  });

  it('no plan limit under a deployment limit of 3: a second lab starts', async () => {
    const h = compose('entitlement', 3);
    await h.change('gus', grant(null));
    expect((await start(h, 'gus', 'LINUX-001')).status).toBe(200);
    expect((await start(h, 'gus', 'LINUX-002')).status).toBe(200);
  });

  it('plan limit 5 under a deployment limit of 1: still one — the safety cap wins', async () => {
    const h = compose('entitlement', 1);
    await h.change('hal', grant(null, { planId: 'fixture-many-labs' }));
    expect((await start(h, 'hal', 'LINUX-001')).status).toBe(200);
    const second = await start(h, 'hal', 'LINUX-002');
    expect(second.status).toBe(429);
    expect(second.body.error.details).toMatchObject({ maxActiveSessionsPerStudent: 1 });
  });
});

describe('beta grants and trials', () => {
  it('a beta grant is ordinary access with a label, and keeps its kind when extended', async () => {
    const h = compose('entitlement');
    await h.change('ivy', grant(new Date(h.clock.now + 30 * DAY).toISOString(), { kind: 'BETA' }));
    expect((await start(h, 'ivy', 'LINUX-001')).status).toBe(200);
    await h.change('ivy', grant(new Date(h.clock.now + 60 * DAY).toISOString()));
    const [account] = await h.store.accounts(10);
    expect(account!.entitlement).toMatchObject({ kind: 'BETA', status: 'ACTIVE' });
  });

  it('a trial allows labs for the configured length, then ends by the clock', async () => {
    const h = compose('entitlement');
    await h.change('jo', { action: 'TRIAL', trial: { durationDays: 7, planId: 'fixture-linux' } });
    const me = await request(h.app).get('/api/me/access').set(as('jo'));
    expect(me.body.data.access).toMatchObject({
      state: 'ACTIVE',
      kind: 'TRIAL',
      expiresAt: new Date(h.clock.now + 7 * DAY).toISOString(),
      plan: { id: 'fixture-linux' },
    });
    expect((await start(h, 'jo', 'LINUX-001')).status).toBe(200);
    expect((await start(h, 'jo', 'DOCKER-001')).body.error.code).toBe('LAB_NOT_IN_PLAN');

    h.clock.now += 7 * DAY;
    const expired = await start(h, 'jo', 'LINUX-002');
    expect(expired.status).toBe(403);
    expect(expired.body.error).toMatchObject({ code: 'ACCESS_NOT_ACTIVE', details: { accessState: 'EXPIRED' } });
  });

  it('a trial is once per account, ever — not again after it expires, nor after a revoke', async () => {
    const h = compose('entitlement');
    await h.change('kim', { action: 'TRIAL', trial: { durationDays: 1, planId: null } });
    await expect(h.change('kim', { action: 'TRIAL', trial: { durationDays: 1, planId: null } })).rejects.toMatchObject({
      code: 'TRIAL_ALREADY_USED',
    });
    h.clock.now += 2 * DAY;
    await expect(h.change('kim', { action: 'TRIAL', trial: { durationDays: 1, planId: null } })).rejects.toMatchObject({
      code: 'TRIAL_ALREADY_USED',
    });
    await h.change('kim', { action: 'REVOKE' });
    await expect(h.change('kim', { action: 'TRIAL', trial: { durationDays: 1, planId: null } })).rejects.toBeInstanceOf(
      AccessError,
    );
    // Nor by a grant that calls itself a trial.
    await expect(h.change('kim', grant(new Date(h.clock.now + DAY).toISOString(), { kind: 'TRIAL' }))).rejects.toMatchObject({
      code: 'INVALID_KIND',
    });
  });

  it('a trial is refused for an account that already has access, and while suspended', async () => {
    const h = compose('entitlement');
    await h.change('lu', grant(null));
    await expect(h.change('lu', { action: 'TRIAL', trial: { durationDays: 7, planId: null } })).rejects.toMatchObject({
      code: 'ALREADY_ACTIVE',
    });
    await h.change('lu', { action: 'SUSPEND' });
    await expect(h.change('lu', { action: 'TRIAL', trial: { durationDays: 7, planId: null } })).rejects.toMatchObject({
      code: 'ENTITLEMENT_SUSPENDED',
    });
  });

  it('a grant cannot start a trial, and must say what to do with an existing one', async () => {
    const h = compose('entitlement');
    const until = new Date(h.clock.now + 30 * DAY).toISOString();
    await expect(h.change('max', grant(until, { kind: 'TRIAL' }))).rejects.toMatchObject({ code: 'INVALID_KIND' });

    await h.change('max', { action: 'TRIAL', trial: { durationDays: 7, planId: null } });
    // Ambiguous: extend the trial, or convert it? Refused rather than guessed.
    await expect(h.change('max', grant(until))).rejects.toMatchObject({ code: 'INVALID_KIND' });
    // Deliberate extension of the trial itself.
    await h.change('max', grant(new Date(h.clock.now + 10 * DAY).toISOString(), { kind: 'TRIAL' }));
    // Conversion.
    await h.change('max', grant(until, { kind: 'STANDARD' }));
    const [account] = await h.store.accounts(10);
    expect(account!.entitlement).toMatchObject({ kind: 'STANDARD', expiresAt: until });
    const history = await h.store.events(account!.userId, 10);
    expect(history.map((e) => `${e.action}:${e.after.kind}`)).toEqual([
      'GRANT:STANDARD',
      'GRANT:TRIAL',
      'TRIAL:TRIAL',
    ]);
  });

  it('an expired trial converts to paid access with a grant', async () => {
    const h = compose('entitlement');
    await h.change('ned', { action: 'TRIAL', trial: { durationDays: 1, planId: null } });
    h.clock.now += 2 * DAY;
    expect((await start(h, 'ned', 'LINUX-001')).status).toBe(403);
    await h.change('ned', grant(new Date(h.clock.now + 30 * DAY).toISOString(), { kind: 'STANDARD' }));
    expect((await start(h, 'ned', 'LINUX-001')).status).toBe(200);
  });
});
