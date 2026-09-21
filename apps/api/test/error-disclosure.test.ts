/**
 * A provider's own words stay on the server.
 *
 * When a sandbox cannot be created, rebuilt or read, the failure carries what
 * the container runtime, the runtime broker or the Kubernetes API said:
 * `docker run` stderr with daemon paths, a container name, an API server URL,
 * an internal address. The operator has all of it (the session manager's log,
 * the session row `ops sessions` reads). The student's browser used to get it
 * too — as the error message, as every failed step's `detail`, as the
 * session's `statusReason`, and in their permanent attempt history — although
 * the web client never shows any of it, rendering its own words for each code.
 *
 * Synthetic "internal" strings only. Each assertion fails against the previous
 * routes.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
  ContainerRuntimeError,
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
  type ContainerInfo,
  type ContainerSpec,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes, fakeExec } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { createApp } from '../src/app.js';
import { studentSteps } from '../src/routes/sessions.js';
import { loadConfig } from '../src/config.js';
import { DevelopmentIdentityResolver } from '../src/auth/resolvers.js';
import { InMemoryUserRepository } from '../src/auth/users.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'error-disclosure-test-secret';
const STUDENT = 'Developer dana';

/** What a real daemon, broker or API server puts in a message. */
const INTERNALS = [
  '/var/lib/docker/overlay2/3f9a2c1b77e0/merged',
  '172.18.0.5',
  'jumptotech-labs-control-plane:6443',
  'jtt-lab-internal-ref',
];
const RAW = `docker: Error response from daemon: failed to create task for jtt-lab-internal-ref: mount /var/lib/docker/overlay2/3f9a2c1b77e0/merged: connect 172.18.0.5 via jumptotech-labs-control-plane:6443`;

/** The fake runtime, able to fail `create` with a daemon's words. */
class DaemonWordsRuntime extends FakeContainerRuntime {
  failCreate: string | undefined;
  override async create(spec: ContainerSpec): Promise<ContainerInfo> {
    if (this.failCreate) throw new ContainerRuntimeError(this.failCreate);
    return super.create(spec);
  }
}

let registry: LabRegistry;
beforeAll(async () => {
  registry = await realCatalog();
});

function harness() {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_MODE: 'development',
  } as NodeJS.ProcessEnv);
  const runtime = new DaemonWordsRuntime();
  const k8s = new FakeKubernetes();
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: new LinuxLabProvider({ runtime }) });
  providers.register({ provider: new KindLabProvider({ k8s, clusterName: 'jumptotech-labs', exec: fakeExec() }) });
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
    identityResolver: new DevelopmentIdentityResolver(new InMemoryUserRepository()),
  });
  return { app, runtime, k8s, sessions };
}

function expectNoInternals(body: unknown, where: string): void {
  const text = JSON.stringify(body);
  for (const internal of INTERNALS) expect(text, `${where} carried ${internal}`).not.toContain(internal);
}

describe("a provider's own words stay on the server", () => {
  it('a failed Start answers with the code and our words, and the history keeps only ours', async () => {
    const { app, runtime, sessions } = harness();
    runtime.failCreate = RAW;

    const res = await request(app).post('/api/labs/LINUX-001/start').set('Authorization', STUDENT);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SESSION_PROVISION_FAILED');
    expectNoInternals(res.body, 'the Start response');

    const history = await request(app).get('/api/me/attempts').set('Authorization', STUDENT);
    expect(history.body.data.attempts).toHaveLength(1);
    expectNoInternals(history.body, 'the attempt history');

    // The FAILED session, read by its owner.
    const [failed] = await sessions.list();
    expect(failed!.statusReason).toContain('/var/lib/docker'); // the operator's copy
    const read = await request(app).get(`/api/sessions/${failed!.sessionId}`).set('Authorization', STUDENT);
    expect(read.status).toBe(200);
    expect(read.body.data.session.status).toBe('FAILED');
    expectNoInternals(read.body, 'the FAILED session');
  });

  it('a failed Reset answers with the code and our words, and the DEGRADED session says only that', async () => {
    const { app, runtime } = harness();
    const started = await request(app).post('/api/labs/LINUX-001/start').set('Authorization', STUDENT);
    expect(started.status).toBe(200);
    const sessionId = started.body.data.session.sessionId as string;

    runtime.failCreate = RAW;
    const res = await request(app).post(`/api/sessions/${sessionId}/reset`).set('Authorization', STUDENT);
    expect(res.status).toBe(503);
    expectNoInternals(res.body, 'the Reset response');
    // The steps keep what the web client renders: which ones, and how they went.
    for (const step of res.body.error.details?.steps ?? []) {
      expect(step).toHaveProperty('label');
      expect(step).toHaveProperty('status');
    }

    const read = await request(app).get(`/api/sessions/${sessionId}`).set('Authorization', STUDENT);
    expect(read.body.data.session.status).toBe('DEGRADED');
    expect(read.body.data.session.statusReason).toBe('The last reset did not finish.');
    expectNoInternals(read.body, 'the DEGRADED session');
  });

  it('a Check that cannot read the cluster says so without naming the cluster', async () => {
    const { app, k8s } = harness();
    const started = await request(app).post('/api/labs/K8S-001/start').set('Authorization', STUDENT);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    k8s.unreachable = RAW;

    const res = await request(app).post(`/api/sessions/${started.body.data.session.sessionId}/check`).set('Authorization', STUDENT);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ENVIRONMENT_UNREACHABLE');
    expectNoInternals(res.body, 'the Check response');
  });

  /*
   * The status poll. The web client reads it every few seconds while a lab is
   * open, so during an outage every poll carried the provider's message — the
   * API server URL, the broker's address — for as long as the outage lasted.
   * The state survives: it is what the page renders.
   */
  it('the status poll reports an unreadable environment without the provider’s words', async () => {
    const { app, k8s, sessions } = harness();
    const started = await request(app).post('/api/labs/K8S-001/start').set('Authorization', STUDENT);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const sessionId = started.body.data.session.sessionId as string;
    k8s.unreachable = RAW;

    const read = await request(app).get(`/api/sessions/${sessionId}`).set('Authorization', STUDENT);
    expect(read.status).toBe(200);
    expect(read.body.data.environment.phase).toBe('error');
    expectNoInternals(read.body, 'the status poll');
    // The operator's copy is untouched.
    const [session] = await sessions.list();
    expect((await sessions.status(session!)).message).toContain('172.18.0.5');
  });

  it('a failed Start does not hand the student an operator’s remediation', async () => {
    const { app, runtime } = harness();
    runtime.failCreate = RAW;

    const res = await request(app).post('/api/labs/LINUX-001/start').set('Authorization', STUDENT);
    expect(res.status).toBe(503);
    expect(res.body.error.remediation ?? '').not.toMatch(/npm run|sandbox:build|docker|kubectl/);
  });

  it('a step that failed on the way to a success loses its detail; the platform’s notes stay', () => {
    const steps = studentSteps([
      { id: 'docker-daemon', label: 'Docker daemon ready', status: 'ok', detail: '10 container budget' },
      { id: 'delete-peer', label: 'Peer host deleted', status: 'failed', detail: RAW },
    ]);
    expect(steps[0]).toHaveProperty('detail', '10 container budget');
    expect(steps[1]).toEqual({ id: 'delete-peer', label: 'Peer host deleted', status: 'failed' });
  });
});
