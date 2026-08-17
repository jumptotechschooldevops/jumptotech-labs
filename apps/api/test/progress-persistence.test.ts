/**
 * PLATFORM-005 — the story's headline claim, end to end against PostgreSQL.
 *
 * "A student can leave the platform, come back later, and see their progress."
 * Everything else can be argued from unit tests; this one has to be shown:
 *
 *   1. a student completes a lab,
 *   2. the sandbox is destroyed,
 *   3. the API process is thrown away — a brand-new app, a brand-new session
 *      manager, a brand-new (empty) container runtime, a brand-new connection
 *      pool — and only the database survives,
 *   4. the dashboard still says the lab is complete.
 *
 * Skipped unless a throwaway database is supplied:
 *
 *   docker run --rm -d --name jtt-test-pg -e POSTGRES_PASSWORD=test \
 *     -e POSTGRES_USER=test -e POSTGRES_DB=jumptotech_labs_test \
 *     -p 55432:5432 postgres:16-alpine
 *
 *   RUN_DB_TESTS=1 \
 *   TEST_DATABASE_URL=postgresql://test:test@localhost:55432/jumptotech_labs_test \
 *   npm run test:db
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import {
  DevStudentIdentity,
  PostgresDatabase,
  PostgresProgressRepository,
  ProgressService,
  migrate,
} from '@jumptotech/progress';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AttemptClosingListener } from '../src/progress.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'integration-test-secret-value';

const url = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === '1' && typeof url === 'string' && url.length > 0;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.log(
    '[progress-persistence] skipped — set RUN_DB_TESTS=1 and TEST_DATABASE_URL to run this suite',
  );
  describe.skip('progress survives everything but the database', () => {
    it('needs RUN_DB_TESTS=1 and TEST_DATABASE_URL', () => undefined);
  });
} else {
  describe('progress survives everything but the database', () => {
    let registry: LabRegistry;
    /** Every pool opened by a simulated API process, closed at the end. */
    const pools: PostgresDatabase[] = [];

    beforeAll(async () => {
      registry = new LabRegistry(path.join(repoRoot, 'labs'));
      await registry.load();
      const db = openPool();
      await migrate(db);
    });

    beforeEach(async () => {
      await pools[0]!.query('TRUNCATE hint_usage, lab_attempts, lab_progress, students CASCADE');
    });

    afterAll(async () => {
      await Promise.all(pools.map((pool) => pool.close().catch(() => undefined)));
    });

    function openPool(): PostgresDatabase {
      const db = PostgresDatabase.fromConfig({
        url: url!,
        ssl: false,
        maxConnections: 4,
        connectionTimeoutMs: 5_000,
        idleTimeoutMs: 5_000,
        statementTimeoutMs: 10_000,
        applicationName: 'jumptotech-labs-tests',
      });
      pools.push(db);
      return db;
    }

    /**
     * One API "process".
     *
     * Everything except the database is fresh, which is the point: the second
     * one shares nothing with the first but the rows.
     */
    function boot(): { app: Express; runtime: FakeContainerRuntime } {
      const config = loadConfig({
        TERMINAL_SESSION_SECRET: SECRET,
        LABS_DIR: path.join(repoRoot, 'labs'),
        ALLOWED_ORIGINS: 'http://localhost:3000',
      } as NodeJS.ProcessEnv);

      const runtime = new FakeContainerRuntime();
      const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
      providers.register({ provider: new LinuxLabProvider({ runtime }) });

      const progress = new ProgressService({
        repository: new PostgresProgressRepository(openPool()),
      });

      const sessions = new SessionManager({
        registry,
        providers,
        store: new InMemorySessionStore(),
        policy: config.policy,
        lifetimes: config.lifetimes,
        namespaceSecret: SECRET,
        listener: new AttemptClosingListener(progress),
      });

      const app = createApp({
        registry,
        sessions,
        k8s: new FakeKubernetes(),
        config,
        progress: {
          progress,
          identity: new DevStudentIdentity({ studentId: config.progress.devStudentId }),
          store: 'postgres',
          durable: true,
        },
      });

      return { app, runtime };
    }

    function completeLinuxLab(runtime: FakeContainerRuntime, sandbox: string): void {
      runtime.put(sandbox, '/home/student/deploy', {
        type: 'directory',
        mode: '750',
        owner: 'student',
        group: 'deployers',
      });
      runtime.put(sandbox, '/home/student/deploy/releases', { type: 'directory', mode: '755' });
      runtime.put(sandbox, '/home/student/deploy/release.txt', {
        type: 'file',
        mode: '640',
        owner: 'student',
        group: 'deployers',
        content: 'service=ledger-api\nversion=4.2.0\n',
      });
    }

    it('a student can leave, the platform can restart, and the progress is still there', async () => {
      // --- the first visit --------------------------------------------------
      const first = boot();

      const started = await request(first.app).post('/api/labs/LINUX-001/start');
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const sessionId = started.body.data.session.sessionId as string;
      const sandboxRef = started.body.data.session.sandboxRef as string;
      const attemptId = started.body.data.attempt.attemptId as string;

      await request(first.app).post(`/api/sessions/${sessionId}/hints`).send({ level: 1 });

      completeLinuxLab(first.runtime, sandboxRef);
      const check = await request(first.app).post(`/api/sessions/${sessionId}/check`);
      expect(check.body.data.passed, JSON.stringify(check.body.data.checks)).toBe(true);

      // The student ends the lab. The container is destroyed for real.
      await request(first.app).delete(`/api/sessions/${sessionId}`);
      expect(first.runtime.containers.has(sandboxRef)).toBe(false);

      // --- the platform restarts -------------------------------------------
      const second = boot();
      // Nothing carried over: no sessions, no sandboxes, no pool, no service.
      expect(second.runtime.containers.size).toBe(0);
      const goneSession = await request(second.app).get(`/api/sessions/${sessionId}`);
      expect(goneSession.status).toBe(404);

      // --- the student comes back ------------------------------------------
      const progress = await request(second.app).get('/api/me/progress');
      expect(progress.status).toBe(200);
      expect(progress.body.data.student.durable).toBe(true);
      expect(progress.body.data.overall).toMatchObject({ completed: 1, total: 21 });
      const linux = progress.body.data.tracks.find((t: { track: string }) => t.track === 'linux');
      expect(linux.labs[0]).toMatchObject({ labId: 'LINUX-001', status: 'COMPLETED' });

      const attempts = await request(second.app).get('/api/me/attempts');
      expect(attempts.body.data.attempts[0]).toMatchObject({
        attemptId,
        labId: 'LINUX-001',
        status: 'PASSED',
      });
      expect(attempts.body.data.attempts[0].endedAt).not.toBeNull();

      const detail = await request(second.app).get(`/api/me/attempts/${attemptId}`);
      expect(detail.body.data.attempt.hintsUsed).toBe(1);
      expect(detail.body.data.attempt.hints[0].level).toBe(1);
    });

    it('a second visit to a completed lab does not double-count it', async () => {
      const first = boot();
      const one = await request(first.app).post('/api/labs/LINUX-001/start');
      const sessionOne = one.body.data.session.sessionId as string;
      completeLinuxLab(first.runtime, one.body.data.session.sandboxRef as string);
      await request(first.app).post(`/api/sessions/${sessionOne}/check`);
      await request(first.app).delete(`/api/sessions/${sessionOne}`);

      // Back later, on a fresh process, to practise the same lab again.
      const second = boot();
      const two = await request(second.app).post('/api/labs/LINUX-001/start');
      const sessionTwo = two.body.data.session.sessionId as string;
      // The lab is still shown as completed while the new attempt is open.
      const midway = await request(second.app).get('/api/me/progress');
      expect(midway.body.data.overall.completed).toBe(1);

      completeLinuxLab(second.runtime, two.body.data.session.sandboxRef as string);
      await request(second.app).post(`/api/sessions/${sessionTwo}/check`);

      const after = await request(second.app).get('/api/me/progress');
      // Still one lab out of twelve: a second pass of the same lab is practice,
      // not new progress.
      expect(after.body.data.overall.completed).toBe(1);
      const linux = after.body.data.tracks.find((t: { track: string }) => t.track === 'linux');
      expect(linux.labs[0].completionCount).toBe(2);
      expect(linux.labs[0].attemptCount).toBe(2);

      const attempts = await request(second.app).get('/api/me/attempts');
      expect(attempts.body.data.attempts).toHaveLength(2);
      expect(attempts.body.data.attempts.every((a: { status: string }) => a.status === 'PASSED')).toBe(
        true,
      );
    });
  });
}
