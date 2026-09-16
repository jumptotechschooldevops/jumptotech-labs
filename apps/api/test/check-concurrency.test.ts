/**
 * One verification per session at a time.
 *
 * A Check runs a lab's whole requirement list against the session's sandbox,
 * inside the API process. Nothing stopped a student sending many at once for
 * the same session — the browser never does (Verify is disabled while a check
 * runs), so a script is the only client that would, and each extra copy was
 * pure load. A concurrent second check on the same session is now refused with
 * 409 `CHECK_IN_PROGRESS`; other sessions are unaffected, and the session can
 * be checked again as soon as the first check finishes, however it finished.
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
  type ContainerExecRequest,
  type ContainerExecResult,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'check-concurrency-test-secret';

/** A runtime whose sandbox reads wait until the test lets them through. */
class GatedRuntime extends FakeContainerRuntime {
  #waiters: Array<() => void> = [];
  gated = false;
  failNext = false;

  override async exec(name: string, execRequest: ContainerExecRequest): Promise<ContainerExecResult> {
    if (this.gated) await new Promise<void>((resolve) => this.#waiters.push(resolve));
    if (this.failNext) {
      this.failNext = false;
      throw new Error('sandbox read failed');
    }
    return super.exec(name, execRequest);
  }

  get waiting(): number {
    return this.#waiters.length;
  }

  release(): void {
    this.gated = false;
    for (const wake of this.#waiters.splice(0)) wake();
  }
}

let registry: LabRegistry;
beforeAll(async () => {
  registry = await realCatalog();
});

function buildApp() {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_MODE: 'development',
  } as NodeJS.ProcessEnv);
  const runtime = new GatedRuntime();
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
  return { app: createApp({ registry, sessions, k8s: new FakeKubernetes(), config }), runtime };
}

async function startAs(app: ReturnType<typeof buildApp>['app'], student: string): Promise<string> {
  const response = await request(app)
    .post('/api/labs/LINUX-001/start')
    .set('Authorization', `Developer ${student}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return String(response.body.data.session.sessionId);
}

function check(app: ReturnType<typeof buildApp>['app'], student: string, sessionId: string) {
  return request(app).post(`/api/sessions/${sessionId}/check`).set('Authorization', `Developer ${student}`);
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('POST /api/sessions/:id/check — one at a time per session', () => {
  it('refuses a second concurrent check of the same session, and allows it again afterwards', async () => {
    const { app, runtime } = buildApp();
    const sessionId = await startAs(app, 'alice');

    runtime.gated = true;
    const first = check(app, 'alice', sessionId).then((response) => response);
    await until(() => runtime.waiting > 0);

    const second = await check(app, 'alice', sessionId);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CHECK_IN_PROGRESS');

    runtime.release();
    expect((await first).status).toBe(200);

    const third = await check(app, 'alice', sessionId);
    expect(third.status).toBe(200);
  });

  it('does not make one student wait on another student’s check', async () => {
    const { app, runtime } = buildApp();
    const alice = await startAs(app, 'alice');
    const bob = await startAs(app, 'bob');

    runtime.gated = true;
    const aliceCheck = check(app, 'alice', alice).then((response) => response);
    await until(() => runtime.waiting > 0);

    const bobCheck = check(app, 'bob', bob).then((response) => response);
    await until(() => runtime.waiting > 1);
    runtime.release();

    expect((await aliceCheck).status).toBe(200);
    expect((await bobCheck).status).toBe(200);
  });

  it('releases the session even when the check itself fails', async () => {
    const { app, runtime } = buildApp();
    const sessionId = await startAs(app, 'alice');

    runtime.failNext = true;
    const failed = await check(app, 'alice', sessionId);
    expect(failed.status).not.toBe(409);

    const again = await check(app, 'alice', sessionId);
    expect(again.status).toBe(200);
  });

  it('never lets a caller learn about a session it does not own through the 409', async () => {
    const { app, runtime } = buildApp();
    const alice = await startAs(app, 'alice');

    runtime.gated = true;
    const aliceCheck = check(app, 'alice', alice).then((response) => response);
    await until(() => runtime.waiting > 0);

    const probe = await check(app, 'mallory', alice);
    expect(probe.status).toBe(404);
    expect(probe.body.error.code).toBe('SESSION_NOT_FOUND');

    runtime.release();
    expect((await aliceCheck).status).toBe(200);
  });
});
