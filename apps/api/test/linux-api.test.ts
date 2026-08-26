/**
 * The Linux track through the HTTP API.
 *
 * The provider, the verifier and the session lifecycle each have their own
 * suites. This one is about the seam the browser actually touches: that
 * `POST /api/labs/LINUX-001/start` reaches the container substrate and not the
 * Kubernetes one, that the terminal is handed a container rather than a
 * credential, that `check` reads this session's own sandbox and nobody else's,
 * and that a deployment which cannot run Linux labs says so instead of quietly
 * creating a namespace for one.
 *
 * `multi-track-api.test.ts` covers the generic cross-provider routing; what is
 * here is what would go wrong for *Linux specifically*. Both substrates are
 * faked — routing, projection and error mapping are what is under test. Real
 * containers are exercised in `test/sandbox-integration.test.ts`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { terminalCredentialBody } from './terminal-owner.js';
import {
  DOCKER_PROVIDER_DISABLED_REASON,
  DockerLabProvider,
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
  type TerminalTerminator,
} from '@jumptotech/lab-orchestrator';
import { FakeDockerEngines, FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'integration-test-secret-value';

let registry: LabRegistry;

beforeAll(async () => {
  registry = new LabRegistry(path.join(repoRoot, 'labs'));
  await registry.load();
  expect(registry.loadErrors).toEqual([]);
});

/** The world LINUX-001 asks for: the tree built, and `app.log` *moved*. */
const SOLVED_LINUX_001 = {
  '/home/student/project': { type: 'directory' as const, mode: '755' },
  '/home/student/project/config.txt': { type: 'file' as const, mode: '644' },
  '/home/student/project/archive': { type: 'directory' as const, mode: '755' },
  '/home/student/project/archive/app.log': { type: 'file' as const, mode: '644', content: 'boot\n' },
};

interface HarnessOptions {
  /** Leave the Linux provider unregistered, as a Kubernetes-only deployment. */
  withoutLinux?: boolean;
  runtime?: FakeContainerRuntime;
}

function buildApp(options: HarnessOptions = {}) {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);

  const k8s = new FakeKubernetes();
  const runtime = options.runtime ?? new FakeContainerRuntime();

  const kubernetes = new KindLabProvider({
    k8s,
    clusterName: 'jumptotech-labs',
    resetDrainTimeoutMs: 2_000,
    destroyTimeoutMs: 2_000,
    sleep: async () => undefined,
    waitForRequirements: async () => ({ ok: true, checks: [] }),
  });
  // Keep `kubectl version` out of these tests: this suite is about routing.
  kubernetes.execute = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.34.2' } }),
    stderr: '',
    timedOut: false,
  });

  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({ provider: kubernetes });
  if (!options.withoutLinux) {
    providers.register({ provider: new LinuxLabProvider({ runtime }) });
  }
  providers.register({
    provider: new DockerLabProvider({ engines: new FakeDockerEngines() }),
    enabled: false,
    disabledReason: DOCKER_PROVIDER_DISABLED_REASON,
  });

  const terminated: string[] = [];
  const reattached: string[] = [];
  const terminal: TerminalTerminator = {
    async terminate(sessionId) {
      terminated.push(sessionId);
    },
    async reattach(sessionId) {
      reattached.push(sessionId);
    },
  };

  const sessions = new SessionManager({
    registry,
    providers,
    store: new InMemorySessionStore(),
    terminal,
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: SECRET,
  });

  return {
    app: createApp({ registry, sessions, k8s, config }),
    sessions,
    k8s,
    runtime,
    terminated,
    reattached,
  };
}

async function start(app: ReturnType<typeof buildApp>['app'], labId: string) {
  const response = await request(app).post(`/api/labs/${labId}/start`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as {
    session: Record<string, unknown>;
    environment: Record<string, unknown>;
    terminal: { url: string; token: string };
  };
}

/** Put a correct LINUX-001 solution inside one sandbox. */
function solve(runtime: FakeContainerRuntime, sandboxRef: string): void {
  for (const [pathName, entry] of Object.entries(SOLVED_LINUX_001)) {
    runtime.put(sandboxRef, pathName, entry);
  }
}

// ------------------------------------------------------------------- start

describe('POST /api/labs/:id/start — a Linux lab', () => {
  it('provisions a container, not a namespace', async () => {
    const { app, runtime, k8s } = buildApp();

    const { session, environment } = await start(app, 'LINUX-001');

    expect(session.provider).toBe('linux');
    expect(session.sandboxKind).toBe('container');
    expect(String(session.sandboxRef)).toMatch(/^jtt-lab-[0-9a-f]{12}$/);
    expect(runtime.containers.has(String(session.sandboxRef))).toBe(true);
    expect(environment.phase).toBe('ready');
    // Nothing was created on the cluster for a lab that does not use one.
    expect([...k8s.namespaces.keys()].filter((n) => n.startsWith('lab-'))).toEqual([]);
  });

  it('mints a terminal token and hands the browser no credential of any kind', async () => {
    const { app } = buildApp();

    const payload = await start(app, 'LINUX-001');

    expect(payload.terminal.token).toBeTruthy();
    const body = JSON.stringify(payload);
    expect(body).not.toMatch(/kubeconfig|BEGIN CERTIFICATE|client-key|password/i);
    // The sandbox reference is a developer detail the UI labels; it is not a
    // capability, and no endpoint accepts one as input. What must never be
    // here is anything the browser could turn into a command.
    expect(body).not.toMatch(/"runtime"|docker exec|sh -c/);
  });

  it('gives two students two containers, each named from its own session', async () => {
    const { app, runtime } = buildApp();

    const a = await start(app, 'LINUX-001');
    const b = await start(app, 'LINUX-001');

    expect(a.session.sandboxRef).not.toBe(b.session.sandboxRef);
    expect(runtime.containers.size).toBe(2);
  });

  it('still routes a Kubernetes lab to a namespace from the same API', async () => {
    const { app, runtime, k8s } = buildApp();

    const { session } = await start(app, 'K8S-001');

    expect(session.provider).toBe('kubernetes');
    expect(session.sandboxKind).toBe('namespace');
    expect([...k8s.namespaces.keys()]).toContain(String(session.sandboxRef));
    expect(runtime.containers.size).toBe(0);
  });
});

// --------------------------------------------------- the terminal binding

describe('the internal terminal binding for a Linux session', () => {
  it('names the container to attach to, and carries no credential', async () => {
    const { app } = buildApp();
    const { session, terminal } = await start(app, 'LINUX-001');

    const response = await request(app)
      .post(`/internal/sessions/${String(session.sessionId)}/credentials`)
      .set('x-internal-secret', SECRET)
      .send(terminalCredentialBody(terminal.token, SECRET));

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      kind: 'container-exec',
      runtime: 'docker',
      containerRef: session.sandboxRef,
      user: 'student',
    });
    // No credential, and — crucially — no command line. The terminal service
    // builds the argv itself from this shape.
    expect(JSON.stringify(response.body.data)).not.toMatch(/kubeconfig|token|exec |sh -c/i);
  });

  it('is unreachable without the service secret', async () => {
    const { app } = buildApp();
    const { session } = await start(app, 'LINUX-001');

    const response = await request(app).post(
      `/internal/sessions/${String(session.sessionId)}/credentials`,
    );

    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toContain('containerRef');
  });

  it('still issues a kubeconfig for a Kubernetes session', async () => {
    const { app } = buildApp();
    const { session, terminal } = await start(app, 'K8S-001');

    const response = await request(app)
      .post(`/internal/sessions/${String(session.sessionId)}/credentials`)
      .set('x-internal-secret', SECRET)
      .send(terminalCredentialBody(terminal.token, SECRET));

    expect(response.status).toBe(200);
    expect(response.body.data.kind).toBe('kubernetes');
    expect(response.body.data.kubeconfig).toContain('apiVersion');
  });
});

// ------------------------------------------------------------------- check

describe('POST /api/sessions/:id/check — a Linux lab', () => {
  it('reads the container and reports every requirement, unsolved', async () => {
    const { app } = buildApp();
    const { session } = await start(app, 'LINUX-001');

    const response = await request(app).post(`/api/sessions/${String(session.sessionId)}/check`);

    expect(response.status).toBe(200);
    expect(response.body.data.passed).toBe(false);
    expect(response.body.data.checks).toHaveLength(registry.get('LINUX-001').requirements.length);
    expect(response.body.data.checks.every((c: { status: string }) => c.status !== 'skipped')).toBe(
      true,
    );
  });

  it('passes once the state inside that container is right', async () => {
    const { app, runtime } = buildApp();
    const { session } = await start(app, 'LINUX-001');
    solve(runtime, String(session.sandboxRef));

    const response = await request(app).post(`/api/sessions/${String(session.sessionId)}/check`);

    expect(response.body.data.passed, JSON.stringify(response.body.data.checks)).toBe(true);
    expect(response.body.data.summary).toBe('LAB PASSED');
  });

  it('never counts another student’s container', async () => {
    const { app, runtime } = buildApp();
    const a = await start(app, 'LINUX-001');
    const b = await start(app, 'LINUX-001');

    // B does the work; A does not.
    solve(runtime, String(b.session.sandboxRef));

    const forA = await request(app).post(`/api/sessions/${String(a.session.sessionId)}/check`);
    const forB = await request(app).post(`/api/sessions/${String(b.session.sessionId)}/check`);

    expect(forA.body.data.passed).toBe(false);
    expect(forB.body.data.passed).toBe(true);
  });

  it('reports an unreachable container runtime as a broken environment, not a failed lab', async () => {
    const runtime = new FakeContainerRuntime();
    const { app } = buildApp({ runtime });
    const { session } = await start(app, 'LINUX-001');

    // The daemon goes away between starting the lab and checking it.
    runtime.unreachable = 'Cannot connect to the Docker daemon';

    const response = await request(app).post(`/api/sessions/${String(session.sessionId)}/check`);

    // Whatever the shape of the answer, the student is never told they failed
    // because the platform could not look.
    expect(response.body.data?.passed ?? false).toBe(false);
    const checks = (response.body.data?.checks ?? []) as Array<{ status: string }>;
    expect(checks.every((c) => c.status !== 'fail')).toBe(true);
  });

  it('still verifies a Kubernetes lab against its own namespace', async () => {
    const { app } = buildApp();
    const { session } = await start(app, 'K8S-001');

    const response = await request(app).post(`/api/sessions/${String(session.sessionId)}/check`);

    expect(response.status).toBe(200);
    expect(response.body.data.checks.length).toBeGreaterThan(0);
    expect(response.body.data.sandboxRef).toBe(session.sandboxRef);
  });
});

// ------------------------------------------------------------ reset and end

describe('reset and end — a Linux lab', () => {
  it('replaces the container and asks the shell to reconnect', async () => {
    const { app, runtime, reattached } = buildApp();
    const { session } = await start(app, 'LINUX-001');
    solve(runtime, String(session.sandboxRef));

    const response = await request(app).post(`/api/sessions/${String(session.sessionId)}/reset`);

    expect(response.status).toBe(200);
    expect(response.body.data.reconnectTerminal).toBe(true);
    // The student's work is genuinely gone, and the shell was reconnected to
    // the replacement rather than left attached to a dead container.
    expect(runtime.entry(String(session.sandboxRef), '/home/student/project')).toBeUndefined();
    expect(reattached).toEqual([session.sessionId]);
  });

  it('does not reconnect a Kubernetes terminal, whose namespace survives its reset', async () => {
    const { app, reattached } = buildApp();
    const { session } = await start(app, 'K8S-001');

    const response = await request(app).post(`/api/sessions/${String(session.sessionId)}/reset`);

    expect(response.status).toBe(200);
    expect(response.body.data.reconnectTerminal).not.toBe(true);
    expect(reattached).toEqual([]);
  });

  it('closes the shell and removes the container on End Lab', async () => {
    const { app, runtime, terminated } = buildApp();
    const { session } = await start(app, 'LINUX-001');

    const response = await request(app).delete(`/api/sessions/${String(session.sessionId)}`);

    expect(response.status).toBe(200);
    expect(response.body.data.session.status).toBe('ENDED');
    expect(runtime.containers.has(String(session.sandboxRef))).toBe(false);
    expect(terminated).toContain(session.sessionId);
  });

  it('leaves every other student’s container running', async () => {
    const { app, runtime } = buildApp();
    const a = await start(app, 'LINUX-001');
    const b = await start(app, 'LINUX-001');

    await request(app).delete(`/api/sessions/${String(a.session.sessionId)}`);

    expect(runtime.containers.has(String(a.session.sandboxRef))).toBe(false);
    expect(runtime.containers.has(String(b.session.sandboxRef))).toBe(true);
  });
});

// ------------------------------------------ a deployment without the track

describe('a deployment that does not run the Linux track', () => {
  it('refuses to start a Linux lab rather than creating a namespace for it', async () => {
    const { app, k8s, runtime } = buildApp({ withoutLinux: true });

    const response = await request(app).post('/api/labs/LINUX-001/start');

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(response.body)).toMatch(/provider|linux/i);
    // Nothing was created anywhere as a consolation prize.
    expect([...k8s.namespaces.keys()].filter((n) => n.startsWith('lab-'))).toEqual([]);
    expect(runtime.containers.size).toBe(0);
  });

  it('still catalogues the Linux labs, so the track is visible and honest', async () => {
    const { app } = buildApp({ withoutLinux: true });

    const response = await request(app).get('/api/labs?track=linux');

    expect(response.status).toBe(200);
    // The whole Linux track is still listed — the count is the track's own, so
    // a Linux lab landing does not fail this on an unrelated assertion.
    expect(response.body.data.labs).toHaveLength(registry.labsForTrack('linux').length);
    expect(response.body.data.labs.length).toBeGreaterThan(0);
    const card = response.body.data.labs[0] as { availability?: { available: boolean } };
    expect(card.availability?.available).toBe(false);
  });

  it('still starts a Kubernetes lab', async () => {
    const { app } = buildApp({ withoutLinux: true });

    const response = await request(app).post('/api/labs/K8S-001/start');

    expect(response.status).toBe(200);
    expect(response.body.data.session.provider).toBe('kubernetes');
  });
});
