/**
 * Five signed-in students at once, cycle after cycle, through the real API.
 *
 * LOCAL SOFTWARE EVIDENCE — not capacity evidence. The container runtime is a
 * fake (with jittered latency, so requests really interleave); nothing here
 * says how many students a host can carry. That is `make beta-validate` and
 * the five-person rehearsal on the host (production-host-readiness.md §13).
 *
 * What it does prove, repeatedly rather than once: with the private-beta
 * contract (5 total, 1 per student) and real OIDC sign-in cookies,
 *
 *   · six simultaneous Starts admit exactly five, each owned by its student,
 *     and refuse the sixth for capacity; a second Start by an admitted student
 *     is refused for the per-student limit;
 *   · every student's own session is invisible to every other student, on
 *     every session route;
 *   · simultaneous Verify (and a double-click on it) grades each student's own
 *     sandbox and records only that student's progress;
 *   · simultaneous Reset gives each student a fresh sandbox and keeps a
 *     completed result;
 *   · the refused student gets the slot the moment one student ends, and
 *     nothing is left behind once everyone has ended.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createServer, type Server } from 'node:http';
import {
  InMemorySessionStore,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
  type ContainerExecRequest,
  type ContainerSpec,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildIdentityResolver } from '../src/auth/resolvers.js';
import { OidcTokenVerifier } from '../src/auth/oidc.js';
import { OidcBrowserClient } from '../src/auth/oidc-client.js';
import { InMemoryUserRepository } from '../src/auth/users.js';
import { InMemoryAuthSessionStore } from '../src/auth/browser-session.js';
import { startFakeIdentityProvider, type FakeIdentityProvider } from './oidc-identity.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'five-student-stress-terminal-secret';
const APP_URL = 'http://localhost:3000';
const LAB = 'LINUX-001';
const CYCLES = 3;

const SOLVED_LINUX_001 = {
  '/home/student/project': { type: 'directory' as const, mode: '755' },
  '/home/student/project/config.txt': { type: 'file' as const, mode: '644' },
  '/home/student/project/archive': { type: 'directory' as const, mode: '755' },
  '/home/student/project/archive/app.log': {
    type: 'file' as const,
    mode: '644',
    content: 'boot\n',
  },
};

/** A runtime whose every call takes a little, differently long, so concurrent requests interleave. */
class JitteredRuntime extends FakeContainerRuntime {
  private jitter = () => new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 12)));
  override async create(spec: ContainerSpec) {
    await this.jitter();
    return super.create(spec);
  }
  override async exec(name: string, req: ContainerExecRequest) {
    await this.jitter();
    return super.exec(name, req);
  }
  override async remove(name: string) {
    await this.jitter();
    return super.remove(name);
  }
}

let idp: FakeIdentityProvider;
let registry: LabRegistry;

beforeAll(async () => {
  idp = await startFakeIdentityProvider();
  registry = await realCatalog();
  expect(registry.loadErrors).toEqual([]);
});

afterAll(async () => {
  await idp.close();
});

async function buildApp() {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: APP_URL,
    PUBLIC_ORIGIN: APP_URL,
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: idp.issuer,
    OIDC_CLIENT_ID: idp.clientId,
    OIDC_CLIENT_SECRET: idp.clientSecret,
    OIDC_AUDIENCE: 'jumptotech-labs-api',
    // The private-beta contract, as the production config check requires it.
    MAX_ACTIVE_SESSIONS: '5',
    MAX_ACTIVE_SESSIONS_PER_STUDENT: '1',
  } as NodeJS.ProcessEnv);
  expect(config.lifetimes).toMatchObject({
    maxActiveSessions: 5,
    maxActiveSessionsPerStudent: 1,
  });

  const users = new InMemoryUserRepository('oidc');
  const k8s = new FakeKubernetes();
  const runtime = new JitteredRuntime();
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime }) });
  const sessions = new SessionManager({
    registry,
    providers,
    store: new InMemorySessionStore(),
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: SECRET,
  });
  const client = new OidcBrowserClient({
    issuer: idp.issuer,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    redirectUri: config.auth.browserFlow!.redirectUri,
    scopes: config.auth.browserFlow!.scopes,
  });
  const app = createApp({
    registry,
    sessions,
    k8s,
    config,
    // Every cycle each student also fires Reset at four other students' labs;
    // those count against the per-student Start/Reset budget (20 a minute),
    // which sandbox-write-rate-limit.test.ts proves on its own. Raised here so a
    // refused probe is refused for ownership, which is what this suite checks.
    sandboxWriteRateLimit: { limit: 1_000, windowMs: 60_000 },
    identityResolver: buildIdentityResolver({
      config: { mode: 'oidc', nodeEnv: 'test' },
      users,
      verifier: new OidcTokenVerifier({
        issuer: idp.issuer,
        audience: 'jumptotech-labs-api',
      }),
    }),
    browserAuth: {
      users,
      authSessions: new InMemoryAuthSessionStore(),
      client,
      idTokenVerifier: new OidcTokenVerifier({
        issuer: idp.issuer,
        audience: idp.clientId,
      }),
    },
  });
  // One listening server for the whole run. supertest given the bare app
  // starts and stops a server per request, and a hundred of those at once end
  // in "socket hang up" on a loaded machine — the harness, not the API.
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    app: server,
    runtime,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function cookieValue(setCookie: string[] | undefined, name: string): string | undefined {
  for (const header of setCookie ?? []) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(header);
    if (match && match[1]) return match[1];
  }
  return undefined;
}

/** The whole browser sign-in: API redirect, provider, callback, token exchange, JWKS. */
async function signIn(app: Server, name: string): Promise<string> {
  idp.signInAs({
    subject: `auth0|${name}`,
    email: `${name}@example.test`,
    name,
  });
  const login = await request(app).get('/auth/login').query({ returnTo: '/' });
  expect(login.status).toBe(302);
  const txCookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  const authorize = await fetch(login.headers.location as string, {
    redirect: 'manual',
  });
  const back = new URL(authorize.headers.get('location')!);
  const callback = await request(app)
    .get('/auth/callback')
    .query({
      code: back.searchParams.get('code')!,
      state: back.searchParams.get('state')!,
    })
    .set('Cookie', txCookie);
  expect(callback.status, JSON.stringify(callback.body)).toBe(302);
  const session = cookieValue(callback.headers['set-cookie'] as unknown as string[], 'jtt_session');
  expect(session).toBeTruthy();
  return `jtt_session=${session!}`;
}

interface Student {
  name: string;
  cookie: string;
}

const as = (app: Server, student: Student) => ({
  get: (url: string) => request(app).get(url).set('Cookie', student.cookie),
  post: (url: string) => request(app).post(url).set('Cookie', student.cookie).set('Origin', APP_URL),
  del: (url: string) => request(app).delete(url).set('Cookie', student.cookie).set('Origin', APP_URL),
});

async function mySessions(app: Server, student: Student) {
  const res = await as(app, student).get('/api/sessions');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  // Only sessions that still hold a sandbox are listed; an ended lab drops out.
  return (
    res.body.data.sessions as Array<{
      session: {
        sessionId: string;
        status: string;
        sandboxRef: string;
        labId: string;
      };
    }>
  ).map((entry) => entry.session);
}

async function completed(app: Server, student: Student): Promise<number> {
  const res = await as(app, student).get('/api/me/progress');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.overall.completed as number;
}

describe('five signed-in students, repeated cycles', () => {
  it(`holds the 5/1 contract, ownership, verification and reset isolation over ${CYCLES} cycles`, async () => {
    const { app, runtime, close } = await buildApp();
    try {
      const students: Student[] = [];
      for (const name of ['ana', 'ben', 'cho', 'dev', 'eli', 'fay']) {
        students.push({ name, cookie: await signIn(app, name) });
      }
      expect(new Set(students.map((s) => s.cookie)).size).toBe(6);
      const everCompleted = new Set<string>();

      for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
        const label = `cycle ${cycle}`;

        // --- six press Start at once: five admitted, one refused for capacity.
        const starts = await Promise.all(students.map((s) => as(app, s).post(`/api/labs/${LAB}/start`)));
        const admitted = students.filter((_, i) => starts[i]!.status === 200);
        const refused = students.filter((_, i) => starts[i]!.status !== 200);
        expect(admitted, label).toHaveLength(5);
        expect(refused, label).toHaveLength(1);
        const refusal = starts.find((r) => r.status !== 200)!;
        expect(
          refusal.status,
          `${label} ${JSON.stringify(starts.map((r) => [r.status, r.body.error?.code, r.body.error?.message]))}`,
        ).toBe(503);
        expect(refusal.body.error.code, label).toBe('LAB_CAPACITY_REACHED');
        const waiting = refused[0]!;

        const own = new Map<string, { sessionId: string; sandboxRef: string }>();
        for (const [i, s] of students.entries()) {
          if (starts[i]!.status !== 200) continue;
          const session = starts[i]!.body.data.session as {
            sessionId: string;
            sandboxRef: string;
          };
          own.set(s.name, session);
        }
        expect(new Set([...own.values()].map((s) => s.sessionId)).size, label).toBe(5);
        expect(new Set([...own.values()].map((s) => s.sandboxRef)).size, label).toBe(5);

        // --- each admitted student sees exactly their own lab, and a second Start is refused for them alone.
        for (const s of admitted) {
          const listed = await mySessions(app, s);
          expect(
            listed.map((x) => x.sessionId),
            `${label} ${s.name}`,
          ).toEqual([own.get(s.name)!.sessionId]);
          const again = await as(app, s).post(`/api/labs/${LAB}/start`);
          expect(again.status, `${label} ${s.name}`).toBe(429);
          expect(again.body.error.code).toBe('STUDENT_SESSION_LIMIT_REACHED');
        }
        expect(await mySessions(app, waiting), label).toEqual([]);

        // --- nobody can reach anybody else's session, on any route.
        const probes: Promise<void>[] = [];
        for (const intruder of students) {
          for (const [ownerName, target] of own) {
            if (ownerName === intruder.name) continue;
            const base = `/api/sessions/${target.sessionId}`;
            for (const call of [
              () => as(app, intruder).get(base),
              () => as(app, intruder).post(`${base}/check`),
              () => as(app, intruder).post(`${base}/reset`),
              () => as(app, intruder).post(`${base}/terminal`),
              () => as(app, intruder).del(base),
            ]) {
              probes.push(
                call().then((res) => {
                  expect(res.status, `${label} ${intruder.name} → ${ownerName}`).toBe(404);
                  expect(res.body.error.code).toBe('SESSION_NOT_FOUND');
                }),
              );
            }
          }
        }
        await Promise.all(probes);
        for (const s of admitted) {
          expect((await mySessions(app, s))[0]!.status, `${label} ${s.name} after probes`).toBe('ACTIVE');
        }

        // --- a different subset solves each cycle; everyone Verifies at once, twice.
        const solvers = new Set(admitted.filter((_, i) => (i + cycle) % 2 === 0).map((s) => s.name));
        for (const name of solvers) {
          for (const [p, entry] of Object.entries(SOLVED_LINUX_001)) runtime.put(own.get(name)!.sandboxRef, p, entry);
        }
        const execsBefore = runtime.execs.length;
        const verifies = await Promise.all(
          admitted.flatMap((s) =>
            [0, 1].map(() =>
              as(app, s)
                .post(`/api/sessions/${own.get(s.name)!.sessionId}/check`)
                .then((res) => ({ s, res })),
            ),
          ),
        );
        for (const { s, res } of verifies) {
          // A double-click: one check runs, the overlapping one is told a check is running.
          if (res.status === 409) {
            expect(res.body.error.code).toBe('CHECK_IN_PROGRESS');
            continue;
          }
          expect(res.status, `${label} ${s.name} ${JSON.stringify(res.body)}`).toBe(200);
          expect(res.body.data.passed, `${label} ${s.name}`).toBe(solvers.has(s.name));
        }
        for (const s of admitted) {
          expect(
            verifies.filter((v) => v.s === s && v.res.status === 200).length,
            `${label} ${s.name}`,
          ).toBeGreaterThanOrEqual(1);
        }
        // Grading read the five students' own containers and nothing else.
        const graded = new Set(runtime.execs.slice(execsBefore).map((e) => e.container));
        expect(graded, label).toEqual(new Set([...own.values()].map((s) => s.sandboxRef)));
        for (const name of solvers) everCompleted.add(name);
        for (const s of students) {
          expect(await completed(app, s), `${label} progress ${s.name}`).toBe(everCompleted.has(s.name) ? 1 : 0);
        }

        // --- everyone Resets at once: a fresh sandbox each, the completed result kept.
        const resets = await Promise.all(
          admitted.map((s) => as(app, s).post(`/api/sessions/${own.get(s.name)!.sessionId}/reset`)),
        );
        for (const [i, res] of resets.entries())
          expect(res.status, `${label} reset ${admitted[i]!.name} ${JSON.stringify(res.body)}`).toBe(200);
        const afterReset = await Promise.all(
          admitted.map((s) => as(app, s).post(`/api/sessions/${own.get(s.name)!.sessionId}/check`)),
        );
        for (const [i, res] of afterReset.entries()) {
          expect(res.status).toBe(200);
          expect(res.body.data.passed, `${label} ${admitted[i]!.name} after reset`).toBe(false);
        }
        for (const s of students) {
          expect(await completed(app, s), `${label} progress after reset ${s.name}`).toBe(
            everCompleted.has(s.name) ? 1 : 0,
          );
        }

        // --- the waiting student is still refused while full, and admitted the moment one student ends.
        const stillFull = await as(app, waiting).post(`/api/labs/${LAB}/start`);
        expect(stillFull.status, label).toBe(503);
        expect(stillFull.body.error.code).toBe('LAB_CAPACITY_REACHED');
        const leaver = admitted[cycle % admitted.length]!;
        expect((await as(app, leaver).del(`/api/sessions/${own.get(leaver.name)!.sessionId}`)).status, label).toBe(200);
        const late = await as(app, waiting).post(`/api/labs/${LAB}/start`);
        expect(late.status, `${label} ${JSON.stringify(late.body)}`).toBe(200);
        own.delete(leaver.name);
        own.set(waiting.name, late.body.data.session);

        // --- everyone ends at once; nothing is left running.
        const ends = await Promise.all(
          students
            .filter((s) => own.has(s.name))
            .map((s) => as(app, s).del(`/api/sessions/${own.get(s.name)!.sessionId}`)),
        );
        for (const res of ends) expect(res.status, label).toBe(200);
        for (const s of students) {
          expect(await mySessions(app, s), `${label} ${s.name} after End`).toEqual([]);
        }
        expect(runtime.containers.size, `${label} containers left`).toBe(0);
      }
    } finally {
      await close();
    }
  }, 120_000);
});
