/**
 * A Check that a Reset or an End overtook is not recorded.
 *
 * A check holds no claim on its session: it is a sequence of reads over
 * seconds, and a Reset or End may begin while it runs. Its later reads then see
 * a different sandbox — a rebuilt one, or none at all, where `docker exec`
 * fails and every path reads as absent. Before this, whatever verdict came out
 * was recorded on the attempt:
 *
 *   - after a Reset, a check whose reads spanned two sandboxes counted towards
 *     `check_count` with a verdict about neither of them;
 *   - after an End, a lab whose last requirement is "this file is gone" passed
 *     against the destroyed container, and the attempt End had closed as ENDED
 *     was rewritten to PASSED with a completion.
 *
 * Deterministic: the check parks on its last read — LINUX-001's `path_absent`
 * — until the test has finished the Reset or End.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
  InMemorySessionStore,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
  type SandboxReadPort,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { DevStudentIdentity, InMemoryProgressRepository, ProgressService } from '@jumptotech/progress';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AttemptClosingListener } from '../src/progress.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LAB = 'LINUX-001';
/** LINUX-001's last requirement: the log was moved, not copied. */
const LAST_READ = '/home/student/project/app.log';
const STUDENT = { Authorization: 'Developer alice' };

let labs: LabRegistry;
beforeAll(async () => {
  labs = await realCatalog();
  const last = labs.get(LAB).requirements.at(-1) as { type: string; path?: string };
  expect(last).toMatchObject({ type: 'path_absent', path: LAST_READ });
});

/** A pause point the test opens by hand. */
function gate() {
  let arrived!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((resolve) => (arrived = resolve));
  const opened = new Promise<void>((resolve) => (open = resolve));
  return {
    reached,
    release: () => open(),
    async wait() {
      arrived();
      await opened;
    },
  };
}

function compose() {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: 'check-lifecycle-race-test-secret',
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);

  const runtime = new FakeContainerRuntime();
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime }) });
  const progress = new ProgressService({ repository: new InMemoryProgressRepository() });

  const sessions = new SessionManager({
    registry: labs,
    providers,
    store: new InMemorySessionStore(),
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: config.namespaceSecret,
    listener: new AttemptClosingListener(progress),
  });

  // The check parks on its last read while `hold` is set.
  let hold: ReturnType<typeof gate> | undefined;
  const sandboxPort = sessions.sandboxPort.bind(sessions);
  sessions.sandboxPort = (session) => {
    const port = sandboxPort(session);
    if (!port) return port;
    const gated: SandboxReadPort = {
      ...port,
      read: async (relativePath, options) => {
        if (relativePath === LAST_READ && hold) await hold.wait();
        return port.read(relativePath, options);
      },
    };
    return gated;
  };

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

  return {
    app,
    runtime,
    holdLastRead: () => (hold = gate()),
  };
}

type World = ReturnType<typeof compose>;

async function startAndSolve(world: World) {
  const started = await request(world.app).post(`/api/labs/${LAB}/start`).set(STUDENT);
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const { sessionId, sandboxRef } = started.body.data.session as { sessionId: string; sandboxRef: string };
  // The finished state: the tree built and the log moved into the archive.
  world.runtime.put(sandboxRef, '/home/student/project', { type: 'directory', mode: '755' });
  world.runtime.put(sandboxRef, '/home/student/project/config.txt', { type: 'file', mode: '644' });
  world.runtime.put(sandboxRef, '/home/student/project/archive', { type: 'directory', mode: '755' });
  world.runtime.put(sandboxRef, '/home/student/project/archive/app.log', { type: 'file', mode: '644', content: 'boot\n' });
  return { sessionId };
}

async function attempt(world: World) {
  const res = await request(world.app).get('/api/me/attempts').set(STUDENT);
  expect(res.status).toBe(200);
  return res.body.data.attempts[0] as { status: string; checkCount: number; completedAt: string | null };
}

describe('a Check overtaken by a lifecycle change', () => {
  it('is not recorded when the session was reset while it ran', async () => {
    const world = compose();
    const { sessionId } = await startAndSolve(world);

    const held = world.holdLastRead();
    const check = request(world.app).post(`/api/sessions/${sessionId}/check`).set(STUDENT).then((r) => r);
    await held.reached;

    const reset = await request(world.app).post(`/api/sessions/${sessionId}/reset`).set(STUDENT);
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    held.release();

    const checked = await check;
    expect(checked.status).toBe(409);
    expect(checked.body.error.code).toBe('SESSION_NOT_ACTIVE');
    expect(await attempt(world)).toMatchObject({ status: 'IN_PROGRESS', checkCount: 0, completedAt: null });

    // The session itself is fine, and the next check counts normally.
    const next = await request(world.app).post(`/api/sessions/${sessionId}/check`).set(STUDENT);
    expect(next.status).toBe(200);
    expect(next.body.data.passed).toBe(false);
    expect(await attempt(world)).toMatchObject({ checkCount: 1 });
  });

  it('does not pass, or reopen the attempt, when the session was ended while it ran', async () => {
    const world = compose();
    const { sessionId } = await startAndSolve(world);

    const held = world.holdLastRead();
    const check = request(world.app).post(`/api/sessions/${sessionId}/check`).set(STUDENT).then((r) => r);
    await held.reached;

    const ended = await request(world.app).delete(`/api/sessions/${sessionId}`).set(STUDENT);
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(await attempt(world)).toMatchObject({ status: 'ENDED' });
    held.release();

    const checked = await check;
    expect(checked.status).toBe(409);
    expect(checked.body.error.code).toBe('SESSION_NOT_ACTIVE');
    expect(await attempt(world)).toMatchObject({ status: 'ENDED', checkCount: 0, completedAt: null });

    const progress = await request(world.app).get('/api/me/progress').set(STUDENT);
    const lab = (progress.body.data.tracks as Array<{ labs: Array<{ labId: string; status: string }> }>)
      .flatMap((t) => t.labs)
      .find((l) => l.labId === LAB);
    expect(lab?.status).not.toBe('COMPLETED');
  });

  it('an uninterrupted check of the same solved lab still passes and is recorded', async () => {
    const world = compose();
    const { sessionId } = await startAndSolve(world);

    const checked = await request(world.app).post(`/api/sessions/${sessionId}/check`).set(STUDENT);
    expect(checked.status).toBe(200);
    expect(checked.body.data.passed).toBe(true);
    expect(await attempt(world)).toMatchObject({ status: 'PASSED', checkCount: 1 });
  });
});
