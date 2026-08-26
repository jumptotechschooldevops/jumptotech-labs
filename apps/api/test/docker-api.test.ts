/**
 * PLATFORM-DOCKER — the Docker track through the HTTP API.
 *
 * The whole student journey, over the same routes the browser uses: start a
 * Docker lab, get a terminal token, fail a check, do the work, pass the check,
 * reset, and end. Nothing here is Docker-specific at the route level — that is
 * the point. The API has no `/api/docker/*`, no `if (track === 'docker')`, and
 * no branch on substrate anywhere; the lab's own `environment.provider` selects
 * the provider that builds the sandbox and the reader that grades it.
 *
 * The one rule this suite exists to pin down: **the sandbox and the session id
 * come from the stored session record, never from the request.** There is no
 * parameter a browser could send that would point a check at somebody else's
 * daemon or somebody else's workspace.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import {
  DEFAULT_SESSION_POLICY,
  DockerLabProvider,
  InMemorySessionStore,
  InMemoryWorkspace,
  KindLabProvider,
  ProviderRegistry,
  LabRegistry,
  SessionManager,
  verifySessionToken,
} from '@jumptotech/lab-orchestrator';
import { FakeDockerEngines, FakeKubernetes, containerSpec } from '@jumptotech/lab-orchestrator/testing';
import { createApp } from '../src/app.js';
import { loadConfig, loadDockerSandboxPolicy } from '../src/config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'integration-test-secret-value';

let registry: LabRegistry;

beforeAll(async () => {
  registry = new LabRegistry(path.join(repoRoot, 'labs'));
  await registry.load();
  expect(registry.loadErrors).toEqual([]);
});

function buildApp(env: Partial<NodeJS.ProcessEnv> = {}) {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    ...env,
  } as NodeJS.ProcessEnv);

  const k8s = new FakeKubernetes();
  const engines = new FakeDockerEngines({ images: [config.policy.docker.image] });
  const workspace = new InMemoryWorkspace();

  const kind = new KindLabProvider({
    k8s,
    clusterName: 'jumptotech-labs',
    destroyTimeoutMs: 2_000,
    sleep: async () => undefined,
  });
  kind.execute = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.34.2' } }),
    stderr: '',
    timedOut: false,
  });

  const docker = new DockerLabProvider({
    engines,
    workspace,
    // Enabled: this suite is about a deployment that *can* run Docker labs.
    sandboxDaemonAvailable: true,
    sleep: async () => undefined,
  });
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 })
    .register({ provider: kind })
    .register({ provider: docker });

  const sessions = new SessionManager({
    registry,
    providers,
    store: new InMemorySessionStore(),
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: config.namespaceSecret,
  });

  return {
    app: createApp({ registry, sessions, k8s, engines, workspace, config }),
    engines,
    workspace,
    sessions,
    k8s,
    config,
  };
}

interface StartPayload {
  session: {
    sessionId: string;
    /** Container sandbox handle. A Docker session has no namespace. */
    sandboxRef: string;
    namespace?: string;
    status: string;
    labId: string;
  };
  terminal: { token: string; url: string };
  steps: Array<{ id: string; status: string; detail?: string }>;
  environment: { phase: string; provider: string };
}

async function startDockerLab(harness: ReturnType<typeof buildApp>, labId = 'DOCKER-001') {
  const res = await request(harness.app).post(`/api/labs/${labId}/start`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as StartPayload;
}

// ------------------------------------------------------------------ start

describe('POST /api/labs/DOCKER-001/start', () => {
  it('provisions a Docker sandbox and hands back a terminal token', async () => {
    const harness = buildApp();

    const payload = await startDockerLab(harness);

    expect(payload.session.status).toBe('ACTIVE');
    expect(payload.session.labId).toBe('DOCKER-001');
    expect(payload.environment.phase).toBe('ready');
    expect(payload.environment.provider).toBe('docker-sandbox');
    expect(payload.steps.map((s) => s.id)).toContain('docker-daemon');
    expect(payload.steps.every((s) => s.status === 'ok')).toBe(true);

    // The sandbox exists, and the token is bound to this session and this lab.
    expect(await harness.engines.host.inspectContainer(payload.session.sandboxRef)).not.toBeNull();
    const claims = verifySessionToken(payload.terminal.token, SECRET);
    expect(claims).toMatchObject({ sid: payload.session.sessionId, labId: 'DOCKER-001' });
  });

  it('never puts the sandbox name in the browser\'s hands as a capability', async () => {
    const harness = buildApp();

    const payload = await startDockerLab(harness);

    // The namespace is disclosed (the UI shows it), but it is an HMAC of the
    // session id — it cannot be inverted back into the capability that controls
    // the session, and no route accepts it as a parameter.
    expect(payload.session.sandboxRef).toMatch(/^jtt-lab-[0-9a-f]{12}$/);
    expect(payload.session.sandboxRef).not.toContain(payload.session.sessionId);
  });

  it('starts Kubernetes and Docker labs side by side in one deployment', async () => {
    const harness = buildApp();

    const docker = await startDockerLab(harness);
    const kubernetes = (await request(harness.app).post('/api/labs/K8S-001/start')).body.data as
      StartPayload;

    expect(docker.environment.provider).toBe('docker-sandbox');
    expect(kubernetes.environment.provider).toBe('kind');
    expect(await harness.engines.host.inspectContainer(docker.session.sandboxRef)).not.toBeNull();
    expect(harness.k8s.namespaces.has(kubernetes.session.namespace!)).toBe(true);
    // Neither substrate saw the other's session.
    expect(harness.k8s.namespaces.has(docker.session.sandboxRef)).toBe(false);
    expect(await harness.engines.host.inspectContainer(kubernetes.session.sandboxRef)).toBeNull();
  });
});

// ------------------------------------------------------------------ check

describe('POST /api/sessions/:id/check — Docker labs', () => {
  it('fails an untouched environment and passes once the work is done', async () => {
    const harness = buildApp();
    const { session } = await startDockerLab(harness);

    const before = await request(harness.app).post(`/api/sessions/${session.sessionId}/check`);
    expect(before.status).toBe(200);
    expect(before.body.data.passed).toBe(false);
    expect(before.body.data.summary).toBe('LAB NOT COMPLETE');

    // The student does the work — in their own sandbox's daemon.
    harness.engines
      .daemon(session.sandboxRef)
      .addContainer(containerSpec({ name: 'web', image: 'nginx:1.27-alpine' }), 'running');

    const after = await request(harness.app).post(`/api/sessions/${session.sessionId}/check`);
    expect(after.body.data.passed).toBe(true);
    expect(after.body.data.summary).toBe('LAB PASSED');
    expect(after.body.data.checks.every((c: { status: string }) => c.status === 'pass')).toBe(true);
  });

  /*
   * A lab that grades a file is often grading an answer. The check must fail
   * without handing that answer to whoever submitted a wrong one — and the
   * place that actually matters is the HTTP response, not the handler's
   * message, so this asserts against the serialised body the browser receives.
   */
  it('never returns an expected file value, or file content, to the browser', async () => {
    const harness = buildApp();
    const { session } = await startDockerLab(harness, 'DOCKER-011');
    const daemon = harness.engines.daemon(session.sandboxRef);

    // The student got it wrong, and their file holds something private.
    daemon.addContainer(
      containerSpec({ name: 'statements-api', image: 'alpine:3.20' }),
      'running',
    );
    daemon.putFile('statements-api', '/var/run/statements/status', 'degraded: region=us-east-1\n');

    const response = await request(harness.app).post(`/api/sessions/${session.sessionId}/check`);
    expect(response.status).toBe(200);
    expect(response.body.data.passed).toBe(false);

    const body = JSON.stringify(response.body);
    // Neither the expectation the lab holds…
    expect(body).not.toContain('ready: region=eu-west-1');
    // …nor what the student's container actually said.
    expect(body).not.toContain('degraded: region=us-east-1');
  });

  it('grades against the requesting session\'s own daemon, not any other', async () => {
    const harness = buildApp();
    const alice = (await startDockerLab(harness)).session;
    const bob = (await startDockerLab(harness)).session;

    // Bob solves the lab. Alice has done nothing.
    harness.engines
      .daemon(bob.sandboxRef)
      .addContainer(containerSpec({ name: 'web', image: 'nginx:1.27-alpine' }), 'running');

    const bobResult = await request(harness.app).post(`/api/sessions/${bob.sessionId}/check`);
    const aliceResult = await request(harness.app).post(`/api/sessions/${alice.sessionId}/check`);

    expect(bobResult.body.data.passed).toBe(true);
    // A correct container in somebody else's sandbox is invisible here.
    expect(aliceResult.body.data.passed).toBe(false);
    expect(aliceResult.body.data.namespace).toBe(alice.sandboxRef);
  });

  it('reads the requesting session\'s own workspace for a Dockerfile lab', async () => {
    const harness = buildApp();
    const alice = (await startDockerLab(harness, 'DOCKER-004')).session;
    const bob = (await startDockerLab(harness, 'DOCKER-004')).session;

    // Bob writes a Dockerfile. Alice does not.
    harness.workspace.write(bob.sessionId, 'Dockerfile', 'FROM node:22-alpine\nWORKDIR /app\n');

    const bobChecks = (await request(harness.app).post(`/api/sessions/${bob.sessionId}/check`)).body
      .data.checks as Array<{ id: string; status: string }>;
    const aliceChecks = (await request(harness.app).post(`/api/sessions/${alice.sessionId}/check`))
      .body.data.checks as Array<{ id: string; status: string }>;

    const fileCheck = (checks: Array<{ id: string; status: string }>) =>
      checks.find((c) => c.id.includes('file_exists'))?.status;

    expect(fileCheck(bobChecks)).toBe('pass');
    expect(fileCheck(aliceChecks)).toBe('fail');
  });

  it('reports a dead sandbox as a broken environment, not a wrong answer', async () => {
    const harness = buildApp();
    const { session } = await startDockerLab(harness);

    harness.engines.daemon(session.sandboxRef).unreachable = 'Cannot connect to the Docker daemon';

    const res = await request(harness.app).post(`/api/sessions/${session.sessionId}/check`);

    // 503, not a 200 with passed:false — the student is told their environment
    // is broken rather than that their work is wrong.
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ENVIRONMENT_UNREACHABLE');
    expect(
      res.body.error.details.checks.every((c: { status: string }) => c.status === 'skipped'),
    ).toBe(true);
  });
});

// ------------------------------------------------------------------ reset

describe('POST /api/sessions/:id/reset — Docker labs', () => {
  it('restores this session\'s environment and leaves every other alone', async () => {
    const harness = buildApp();
    const alice = (await startDockerLab(harness)).session;
    const bob = (await startDockerLab(harness)).session;

    for (const session of [alice, bob]) {
      harness.engines
        .daemon(session.sandboxRef)
        .addContainer(containerSpec({ name: 'web', image: 'nginx:1.27-alpine' }), 'running');
    }

    const res = await request(harness.app).post(`/api/sessions/${alice.sessionId}/reset`);

    expect(res.status).toBe(200);
    expect(res.body.data.removed).toContain('container/web');
    expect(res.body.data.clearTerminal).toBe(true);
    expect(await harness.engines.daemon(alice.sandboxRef).inspectContainer('web')).toBeNull();
    // Bob's work survives Alice's reset.
    expect(await harness.engines.daemon(bob.sandboxRef).inspectContainer('web')).not.toBeNull();
  });

  it('leaves the session, its sandbox, and its terminal token intact', async () => {
    const harness = buildApp();
    const { session, terminal } = await startDockerLab(harness);

    await request(harness.app).post(`/api/sessions/${session.sessionId}/reset`);

    const after = await request(harness.app).get(`/api/sessions/${session.sessionId}`);
    expect(after.body.data.session.status).toBe('ACTIVE');
    expect(await harness.engines.host.inspectContainer(session.sandboxRef)).not.toBeNull();
    expect(verifySessionToken(terminal.token, SECRET)).toMatchObject({ sid: session.sessionId });
  });
});

// -------------------------------------------------------------- end lab

describe('DELETE /api/sessions/:id — Docker labs', () => {
  it('tears down the sandbox and everything inside it', async () => {
    const harness = buildApp();
    const { session } = await startDockerLab(harness);
    harness.engines
      .daemon(session.sandboxRef)
      .addContainer(containerSpec({ name: 'web' }), 'running');

    const res = await request(harness.app).delete(`/api/sessions/${session.sessionId}`);

    expect(res.status).toBe(200);
    expect(await harness.engines.host.inspectContainer(session.sandboxRef)).toBeNull();
    // Nothing has to enumerate the student's containers; they lived in a daemon
    // that no longer exists.
    expect(harness.engines.host.daemonFor(session.sandboxRef)).toBeUndefined();
  });

  it('ends only the session it was asked about', async () => {
    const harness = buildApp();
    const alice = (await startDockerLab(harness)).session;
    const bob = (await startDockerLab(harness)).session;

    await request(harness.app).delete(`/api/sessions/${alice.sessionId}`);

    expect(await harness.engines.host.inspectContainer(bob.sandboxRef)).not.toBeNull();
    const bobStatus = await request(harness.app).get(`/api/sessions/${bob.sessionId}`);
    expect(bobStatus.body.data.session.status).toBe('ACTIVE');
  });
});

// -------------------------------------------------------------- credentials

describe('POST /internal/sessions/:id/credentials — Docker sessions', () => {
  it('issues sandbox-scoped Docker credentials to the terminal service only', async () => {
    const harness = buildApp();
    const { session } = await startDockerLab(harness);
    const url = `/internal/sessions/${session.sessionId}/credentials`;

    const unauthenticated = await request(harness.app).post(url);
    expect(unauthenticated.status).toBe(401);

    const res = await request(harness.app).post(url).set('x-internal-secret', SECRET);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      kind: 'docker-daemon',
      sandboxRef: session.sandboxRef,
      dockerHost: `tcp://${session.sandboxRef}:2376`,
    });
    expect(res.body.data.ca).toContain('BEGIN CERTIFICATE');
    expect(res.body.data.clientKey).toContain('BEGIN PRIVATE KEY');
  });

  it('issues material that differs per session', async () => {
    const harness = buildApp();
    const alice = (await startDockerLab(harness)).session;
    const bob = (await startDockerLab(harness)).session;

    const of = async (sessionId: string) =>
      (
        await request(harness.app)
          .post(`/internal/sessions/${sessionId}/credentials`)
          .set('x-internal-secret', SECRET)
      ).body.data;

    const a = await of(alice.sessionId);
    const b = await of(bob.sessionId);

    expect(a.ca).not.toBe(b.ca);
    expect(a.dockerHost).not.toBe(b.dockerHost);
  });
});

// ------------------------------------------------------- resource controls

describe('Docker resource controls come from configuration, never from code', () => {
  it('reads every sandbox limit from the environment', () => {
    const policy = loadDockerSandboxPolicy({
      DOCKER_SANDBOX_IMAGE: 'docker:28-dind',
      DOCKER_SANDBOX_MEMORY: '4g',
      DOCKER_SANDBOX_CPUS: '3',
      DOCKER_SANDBOX_PIDS_LIMIT: '1024',
      DOCKER_SANDBOX_MAX_CONTAINERS: '25',
      DOCKER_SANDBOX_NETWORK: 'custom-sandboxes',
      DOCKER_SANDBOX_DAEMON_PORT: '2377',
      DOCKER_SANDBOX_READY_TIMEOUT_SECONDS: '240',
      DOCKER_SANDBOX_RESTART_ATTEMPTS: '7',
      DOCKER_SANDBOX_REGISTRY_MIRROR: 'http://mirror.internal:5000',
    } as NodeJS.ProcessEnv);

    expect(policy).toEqual({
      image: 'docker:28-dind',
      privileged: true,
      memory: '4g',
      cpus: '3',
      pidsLimit: 1024,
      maxContainers: 25,
      network: 'custom-sandboxes',
      daemonPort: 2377,
      readyTimeoutSeconds: 240,
      restartAttempts: 7,
      registryMirror: 'http://mirror.internal:5000',
    });
  });

  it('falls back to defaults that bound a session on an unconfigured host', () => {
    const policy = loadDockerSandboxPolicy({} as NodeJS.ProcessEnv);

    expect(policy).toMatchObject({ memory: '2g', cpus: '2', pidsLimit: 512 });
    expect(policy.registryMirror).toBeUndefined();
  });

  it('applies those limits to the sandbox the API actually creates', async () => {
    const harness = buildApp({
      DOCKER_SANDBOX_MEMORY: '1g',
      DOCKER_SANDBOX_CPUS: '1',
      DOCKER_SANDBOX_PIDS_LIMIT: '128',
    });

    const { session } = await startDockerLab(harness);

    // These are the limits that actually bind: every container the student
    // starts is a child of this one process tree.
    expect(harness.engines.host.runs.find((r) => r.name === session.sandboxRef)).toMatchObject({
      memory: '1g',
      cpus: '1',
      pidsLimit: 128,
    });
  });

  it('reports the container budget in the provisioning step a student sees', async () => {
    const harness = buildApp({ DOCKER_SANDBOX_MAX_CONTAINERS: '10' });

    const payload = await startDockerLab(harness);

    // Advisory, and said so: Docker has no per-daemon container cap, so pids
    // and memory are what enforce. See README → Docker resource controls.
    expect(payload.steps.find((s) => s.id === 'docker-daemon')?.detail).toContain(
      '10 container budget',
    );
  });

  it('creates nothing at all for a student who only browses the catalog', async () => {
    const harness = buildApp();

    await request(harness.app).get('/api/labs');
    await request(harness.app).get('/api/labs/DOCKER-001');
    await request(harness.app).get('/api/tracks/docker/labs');

    expect(await harness.engines.host.listContainers()).toEqual([]);
    expect(await harness.engines.host.listVolumes()).toEqual([]);
  });
});
