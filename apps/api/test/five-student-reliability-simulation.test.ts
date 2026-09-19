/**
 * Five students and a sixth, doing everything at once, through the real API.
 *
 * `make beta-validate` exercises the private beta against a running stack and
 * is a release gate. This is its hermetic counterpart for the lifecycle: the
 * real session manager, session guard, verifier and progress service, with a
 * fake container runtime underneath, driven by six concurrent students whose
 * next action is chosen by a seeded generator — Start (singly and doubled),
 * Check, Reset, Check racing Reset, two Resets, End (singly, doubled, and
 * racing a Reset), Continue, a terminal token, reading their own sessions, and
 * reaching for somebody else's session.
 *
 * Interleavings are whatever the event loop produces; every assertion is an
 * invariant that must hold under any of them:
 *
 *   - never more than MAX_ACTIVE_SESSIONS sessions hold a sandbox, and never
 *     more than one per student;
 *   - every response is one the route documents — no 500, ever;
 *   - a student only ever sees, and can only ever act on, their own sessions;
 *   - after everyone ends, no session holds a slot and no container is left;
 *   - learning history agrees with what happened: one attempt per admitted
 *     start, none for a refusal, every attempt closed, and the dashboard's
 *     attempt counts sum to the same number.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';
import {
  InMemorySessionStore,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { BETA_CONTRACT } from '@jumptotech/test-support/beta-contract';
import { DevStudentIdentity, InMemoryProgressRepository, ProgressService } from '@jumptotech/progress';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AttemptClosingListener } from '../src/progress.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const STUDENTS = ['ada', 'bea', 'cal', 'dee', 'eli', 'fay'] as const;
const LABS = ['LINUX-001', 'LINUX-002'] as const;
const STEPS_PER_STUDENT = 18;

let labs: LabRegistry;
beforeAll(async () => {
  labs = await realCatalog();
  for (const lab of LABS) expect(labs.get(lab).environment.provider).toBe('linux');
}, 60_000);

/** mulberry32: small, seeded, good enough to pick actions reproducibly. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function compose() {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: 'five-student-simulation-secret',
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    MAX_ACTIVE_SESSIONS: String(BETA_CONTRACT.maxActiveSessions),
    MAX_ACTIVE_SESSIONS_PER_STUDENT: String(BETA_CONTRACT.maxActiveSessionsPerStudent),
  } as NodeJS.ProcessEnv);

  const runtime = new FakeContainerRuntime();
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime }) });
  const store = new InMemorySessionStore();
  const progress = new ProgressService({ repository: new InMemoryProgressRepository() });
  const sessions = new SessionManager({
    registry: labs,
    providers,
    store,
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: config.namespaceSecret,
    listener: new AttemptClosingListener(progress),
  });
  const app = createApp({
    registry: labs,
    sessions,
    k8s: new FakeKubernetes(),
    config,
    progress: {
      progress,
      identity: new DevStudentIdentity({ studentId: config.progress.devStudentId }),
      store: 'memory',
      durable: false,
    },
  });
  return { app, store, runtime };
}

type World = ReturnType<typeof compose>;

interface Ledger {
  admitted: number;
  refused: number;
  sessionIds: Set<string>;
}

class Simulation {
  readonly violations: string[] = [];
  readonly ledger = new Map<string, Ledger>(STUDENTS.map((s) => [s, { admitted: 0, refused: 0, sessionIds: new Set() }]));
  /** Every session id any student has been handed, for cross-student probes. */
  readonly seen = new Map<string, string>();

  constructor(private readonly world: World) {}

  as(student: string) {
    const auth = { Authorization: `Developer ${student}` };
    const app: Express = this.world.app;
    return {
      get: (url: string) => request(app).get(url).set(auth).then((r) => r),
      post: (url: string) => request(app).post(url).set(auth).then((r) => r),
      delete: (url: string) => request(app).delete(url).set(auth).then((r) => r),
    };
  }

  expectStatus(student: string, what: string, res: { status: number; body: unknown }, allowed: number[]): void {
    if (!allowed.includes(res.status)) {
      this.violations.push(`${student} ${what}: HTTP ${res.status} not in [${allowed}] — ${JSON.stringify(res.body).slice(0, 300)}`);
    }
  }

  /** The store's view, checked after every step of every student. */
  async checkCapacity(context: string): Promise<void> {
    const occupying = await this.world.store.listOccupying();
    if (occupying.length > BETA_CONTRACT.maxActiveSessions) {
      this.violations.push(`${context}: ${occupying.length} sessions hold a sandbox`);
    }
    const perOwner = new Map<string, number>();
    for (const s of occupying) perOwner.set(s.ownerUserId ?? '', (perOwner.get(s.ownerUserId ?? '') ?? 0) + 1);
    for (const [owner, count] of perOwner) {
      if (count > BETA_CONTRACT.maxActiveSessionsPerStudent) {
        this.violations.push(`${context}: ${owner || '(unowned)'} holds ${count} sessions`);
      }
    }
  }

  async start(student: string, lab: string): Promise<string | undefined> {
    const res = await this.as(student).post(`/api/labs/${lab}/start`);
    this.expectStatus(student, `start ${lab}`, res, [200, 429, 503]);
    const led = this.ledger.get(student)!;
    if (res.status === 200) {
      led.admitted += 1;
      const id = res.body.data.session.sessionId as string;
      led.sessionIds.add(id);
      this.seen.set(id, student);
      if (!res.body.data.attempt) this.violations.push(`${student} start ${lab}: admitted without an attempt`);
      return id;
    }
    led.refused += 1;
    return undefined;
  }

  async mine(student: string): Promise<string[]> {
    const res = await this.as(student).get('/api/sessions');
    this.expectStatus(student, 'list own sessions', res, [200]);
    const ids = ((res.body.data?.sessions ?? []) as Array<{ session: { sessionId: string } }>).map((e) => e.session.sessionId);
    for (const id of ids) {
      if (this.seen.get(id) !== student) this.violations.push(`${student} was shown ${id}, which belongs to ${this.seen.get(id)}`);
    }
    return ids;
  }

  /** One student's life: `steps` actions, chosen by their own seeded generator. */
  async run(student: string, seed: number, steps: number): Promise<void> {
    const pick = rng(seed);
    const choose = <T>(items: readonly T[]): T => items[Math.floor(pick() * items.length)]!;
    const api = this.as(student);
    let current: string | undefined;

    for (let step = 0; step < steps; step += 1) {
      const where = `${student}#${step}`;
      if (!current) {
        if (pick() < 0.3) {
          // Double-clicked Start: at most one may be admitted.
          const lab = choose(LABS);
          const [a, b] = await Promise.all([this.start(student, lab), this.start(student, lab)]);
          if (a && b) this.violations.push(`${where}: two simultaneous starts were both admitted`);
          current = a ?? b;
        } else {
          current = await this.start(student, choose(LABS));
        }
        await this.checkCapacity(where);
        continue;
      }

      const url = `/api/sessions/${current}`;
      const action = choose([
        'check', 'check', 'reset', 'activity', 'terminal', 'get', 'list', 'end', 'endTwice',
        'startAgain', 'checkDuringReset', 'resetTwice', 'endDuringReset', 'probeOther',
      ] as const);

      switch (action) {
        case 'check':
          this.expectStatus(student, 'check', await api.post(`${url}/check`), [200, 409]);
          break;
        case 'reset':
          this.expectStatus(student, 'reset', await api.post(`${url}/reset`), [200]);
          break;
        case 'activity':
          this.expectStatus(student, 'activity', await api.post(`${url}/activity`), [200]);
          break;
        case 'terminal':
          this.expectStatus(student, 'terminal token', await api.post(`${url}/terminal`), [200]);
          break;
        case 'get':
          this.expectStatus(student, 'get', await api.get(url), [200]);
          break;
        case 'list': {
          const ids = await this.mine(student);
          if (!ids.includes(current)) this.violations.push(`${where}: own live session ${current} missing from /api/sessions`);
          break;
        }
        case 'end':
          this.expectStatus(student, 'end', await api.delete(url), [200]);
          current = undefined;
          break;
        case 'endTwice': {
          const both = await Promise.all([api.delete(url), api.delete(url)]);
          for (const res of both) this.expectStatus(student, 'end twice', res, [200]);
          current = undefined;
          break;
        }
        case 'startAgain': {
          const res = await api.post(`/api/labs/${choose(LABS)}/start`);
          this.expectStatus(student, 'start while holding a lab', res, [429]);
          this.ledger.get(student)!.refused += 1;
          break;
        }
        case 'checkDuringReset': {
          const [check, reset] = await Promise.all([api.post(`${url}/check`), api.post(`${url}/reset`)]);
          this.expectStatus(student, 'check racing reset', check, [200, 409]);
          this.expectStatus(student, 'reset racing check', reset, [200]);
          break;
        }
        case 'resetTwice': {
          const both = await Promise.all([api.post(`${url}/reset`), api.post(`${url}/reset`)]);
          for (const res of both) this.expectStatus(student, 'reset twice', res, [200, 409]);
          if (!both.some((r) => r.status === 200)) this.violations.push(`${where}: neither of two resets ran`);
          break;
        }
        case 'endDuringReset': {
          const [reset, end] = await Promise.all([api.post(`${url}/reset`), api.delete(url)]);
          this.expectStatus(student, 'reset racing end', reset, [200, 409]);
          this.expectStatus(student, 'end racing reset', end, [200]);
          current = undefined;
          break;
        }
        case 'probeOther': {
          const others = [...this.seen].filter(([, owner]) => owner !== student).map(([id]) => id);
          if (others.length === 0) break;
          const target = `/api/sessions/${choose(others)}`;
          for (const res of await Promise.all([
            api.get(target),
            api.post(`${target}/check`),
            api.post(`${target}/reset`),
            api.post(`${target}/terminal`),
            api.post(`${target}/activity`),
            api.delete(target),
          ])) {
            if (res.status !== 404) this.violations.push(`${where}: reached another student's session — HTTP ${res.status}`);
          }
          break;
        }
      }
      await this.checkCapacity(`${where} ${action}`);
    }

    if (current) this.expectStatus(student, 'final end', await api.delete(`/api/sessions/${current}`), [200]);
  }
}

describe('five students, and a sixth, through every lifecycle operation at once', () => {
  for (const seed of [20260919, 7, 424242]) {
    it(`keeps every invariant (seed ${seed})`, async () => {
      const world = compose();
      const sim = new Simulation(world);

      await Promise.all(STUDENTS.map((student, i) => sim.run(student, seed + i * 7919, STEPS_PER_STUDENT)));

      expect(sim.violations).toEqual([]);

      // Everyone ended: no slot held, no sandbox left behind.
      expect(await world.store.listOccupying()).toEqual([]);
      expect([...world.runtime.containers.keys()]).toEqual([]);

      // Something actually happened, and the platform was really contended.
      const totals = [...sim.ledger.values()].reduce(
        (sum, l) => ({ admitted: sum.admitted + l.admitted, refused: sum.refused + l.refused }),
        { admitted: 0, refused: 0 },
      );
      expect(totals.admitted).toBeGreaterThan(STUDENTS.length);
      expect(totals.refused).toBeGreaterThan(0);

      // History agrees with what happened, per student.
      for (const student of STUDENTS) {
        const api = sim.as(student);
        const led = sim.ledger.get(student)!;
        const attempts = (await api.get('/api/me/attempts?limit=100')).body.data.attempts as Array<{
          status: string;
          endedAt: string | null;
        }>;
        expect(attempts, `${student}: one attempt per admitted start`).toHaveLength(led.admitted);
        for (const attempt of attempts) {
          expect(['ENDED', 'PASSED'], `${student}: attempt closed`).toContain(attempt.status);
          expect(attempt.endedAt, `${student}: attempt has an end`).not.toBeNull();
        }
        const progress = (await api.get('/api/me/progress')).body.data.tracks as Array<{ labs: Array<{ attemptCount: number }> }>;
        const counted = progress.flatMap((t) => t.labs).reduce((sum, lab) => sum + lab.attemptCount, 0);
        expect(counted, `${student}: dashboard attempt counts`).toBe(led.admitted);
        expect(await sim.mine(student)).toEqual([]);
      }
      expect(sim.violations).toEqual([]);
    }, 120_000);
  }
});
