/**
 * PLATFORM-004 — the multi-track API (story test requirements 29–30, 32–35).
 *
 * One generic lab/session API serves every track. These tests pin that:
 *
 *   · there is no `/api/kubernetes/start`, `/api/linux/start` or
 *     `/api/terraform/start` — one `POST /api/labs/:id/start` covers all of it;
 *   · the catalog says which tracks can actually run here, and which cannot;
 *   · a session payload carries its provider and sandbox reference but never a
 *     credential;
 *   · the terminal binding is resolved server-side, per session, and the
 *     browser cannot influence which sandbox it attaches to.
 *
 * The cluster and the container runtime are faked here; the real thing is in
 * `sandbox-integration.test.ts`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { terminalCredentialBody } from './terminal-owner.js';
import {
  AwsLabProvider,
  DockerLabProvider,
  DOCKER_PROVIDER_DISABLED_REASON,
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
  TerraformLabProvider,
} from '@jumptotech/lab-orchestrator';
import { FakeDockerEngines, FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { scanLabsDirectory } from '@jumptotech/lab-orchestrator/testing/catalog';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'integration-test-secret-value';

let registry: LabRegistry;
/** The catalog as it is on disk — where every expected count comes from. */
let disk: Awaited<ReturnType<typeof scanLabsDirectory>>;

beforeAll(async () => {
  registry = new LabRegistry(path.join(repoRoot, 'labs'));
  await registry.load();
  expect(registry.loadErrors).toEqual([]);
  disk = await scanLabsDirectory();
});

interface HarnessOptions {
  runtime?: FakeContainerRuntime;
  k8s?: FakeKubernetes;
}

function buildApp(options: HarnessOptions = {}) {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);

  const k8s = options.k8s ?? new FakeKubernetes();
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
  providers.register({ provider: new LinuxLabProvider({ runtime }) });
  providers.register({ provider: new TerraformLabProvider({ runtime }) });
  // The Docker provider drives a per-session daemon through an engine factory,
  // not the shared container runtime; this suite leaves it switched off.
  providers.register({
    provider: new DockerLabProvider({ engines: new FakeDockerEngines() }),
    enabled: false,
    disabledReason: DOCKER_PROVIDER_DISABLED_REASON,
  });
  providers.register({
    provider: new AwsLabProvider(),
    enabled: false,
    disabledReason: 'AWS labs are architecture only.',
  });

  const sessions = new SessionManager({
    registry,
    providers,
    store: new InMemorySessionStore(),
    policy: config.policy,
    lifetimes: config.lifetimes,
    namespaceSecret: SECRET,
  });

  return { app: createApp({ registry, sessions, k8s, config }), sessions, k8s, runtime, config };
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

// --- catalog ----------------------------------------------------------------

describe('the catalog shows every track (test requirements 33–35)', () => {
  it('lists every discovered track with its lab count and its providers', async () => {
    const { app } = buildApp();
    const response = await request(app).get('/api/labs');

    expect(response.status).toBe(200);
    const tracks = response.body.data.tracks as Array<{
      track: string;
      title: string;
      labCount: number;
      providers: string[];
    }>;

    // No track is named in a literal here: the list and the counts are read off
    // disk, so a new track appears in this assertion by existing.
    expect(tracks.map((t) => t.track)).toEqual(disk.trackIds);
    for (const track of tracks) {
      expect(track.labCount, track.track).toBe(disk.labCountForTrack(track.track));
      // A track's providers are the providers its own labs declare, in
      // first-appearance order — never a mapping held somewhere in code.
      expect(track.providers, track.track).toEqual([
        ...new Set(
          disk.labs.filter((l) => l.track === track.track).map((l) => l.provider),
        ),
      ]);
      expect(track.providers.length, track.track).toBeGreaterThan(0);
    }
  });

  it('marks each lab with its provider and whether it can run here', async () => {
    const { app } = buildApp();
    const response = await request(app).get('/api/labs');
    const labs = response.body.data.labs as Array<{
      id: string;
      provider: string;
      availability: { available: boolean; reason?: string };
    }>;

    // Every lab is marked with the provider its own definition declares.
    for (const onDisk of disk.labs) {
      expect(labs.find((l) => l.id === onDisk.id)?.provider, onDisk.id).toBe(onDisk.provider);
    }
    /*
     * A lab is startable exactly when its provider is. Docker is switched off in
     * this suite, and its labs are still listed — marked with the reason rather
     * than hidden. Reading the provider states out of the same payload is what
     * keeps this true when a provider is switched on, or when a track ships its
     * first lab for a provider that has none today.
     */
    const readiness = new Map(
      (response.body.data.providers as Array<{ provider: string; available: boolean }>).map(
        (p) => [p.provider, p.available],
      ),
    );
    for (const lab of labs) {
      expect(lab.availability.available, lab.id).toBe(readiness.get(lab.provider) ?? false);
    }
    expect(labs.filter((l) => l.provider === 'docker').length).toBeGreaterThan(0);
    expect(labs.filter((l) => l.provider === 'docker').every((l) => l.availability.available)).toBe(
      false,
    );
  });

  it('reports Docker and AWS as registered but not available', async () => {
    const { app } = buildApp();
    const response = await request(app).get('/api/labs');
    const providers = response.body.data.providers as Array<{
      provider: string;
      available: boolean;
      reason?: string;
    }>;

    const docker = providers.find((p) => p.provider === 'docker');
    const aws = providers.find((p) => p.provider === 'aws');

    expect(docker?.available).toBe(false);
    expect(docker?.reason).toContain('per-session Docker daemon');
    expect(aws?.available).toBe(false);
    // AWS ships no lab at all. Every Docker lab there is says it cannot run
    // here rather than offering a button that was going to fail.
    const labs = response.body.data.labs as Array<{
      provider: string;
      availability: { available: boolean; reason?: string };
    }>;
    // A provider is reported whether or not a lab uses it — `aws` is registered
    // here and ships nothing today. Asserted against disk rather than pinned,
    // so the day an AWS lab lands this describes the new truth instead of
    // failing an unrelated suite.
    expect(providers.map((p) => p.provider)).toContain('aws');
    expect(labs.some((l) => l.provider === 'aws')).toBe(
      disk.labs.some((l) => l.provider === 'aws'),
    );
    const dockerLabs = labs.filter((l) => l.provider === 'docker');
    expect(dockerLabs).toHaveLength(disk.labs.filter((l) => l.provider === 'docker').length);
    expect(dockerLabs.length).toBeGreaterThan(0);
    expect(dockerLabs.every((l) => !l.availability.available)).toBe(true);
    expect(dockerLabs[0]?.availability.reason).toContain('per-session Docker daemon');
  });

  it('marks a track unavailable when its backend is missing, without hiding it', async () => {
    const runtime = new FakeContainerRuntime({ images: [] });
    const { app } = buildApp({ runtime });

    const response = await request(app).get('/api/labs');
    const tracks = response.body.data.tracks as Array<{
      track: string;
      availability: { available: boolean; reason?: string };
    }>;
    const labs = response.body.data.labs as Array<{
      id: string;
      availability: { available: boolean; reason?: string; remediation?: string };
    }>;

    const linux = tracks.find((t) => t.track === 'linux');
    expect(linux?.availability.available).toBe(false);
    expect(linux?.availability.reason).toContain('has not been built');

    const lab = labs.find((l) => l.id === 'LINUX-001');
    expect(lab?.availability.available).toBe(false);
    expect(lab?.availability.remediation).toContain('npm run sandbox:build');

    // Kubernetes is unaffected: one backend being down does not take the
    // catalog with it.
    expect(tracks.find((t) => t.track === 'kubernetes')?.availability.available).toBe(true);
  });

  it('filters labs by track, the same way through both routes', async () => {
    const { app } = buildApp();

    for (const track of disk.trackIds) {
      const expected = disk.idsForTrack(track);

      const viaLabs = await request(app).get(`/api/labs?track=${track}`);
      expect((viaLabs.body.data.labs as Array<{ id: string }>).map((l) => l.id), track).toEqual(
        expected,
      );

      const viaTrack = await request(app).get(`/api/tracks/${track}/labs`);
      expect((viaTrack.body.data.labs as Array<{ id: string }>).map((l) => l.id), track).toEqual(
        expected,
      );
    }
  });

  it('serves per-lab availability on the detail endpoint', async () => {
    const { app } = buildApp();
    const response = await request(app).get('/api/labs/LINUX-001');

    expect(response.status).toBe(200);
    expect(response.body.data.environment).toEqual({ provider: 'linux', isolation: 'container' });
    expect(response.body.data.availability.available).toBe(true);
    /*
     * Still student-safe. The task text names the group on purpose — the
     * student has to be told what to do. What must not appear is the
     * *machine-readable* requirement: no requirement type, and no expected
     * mode, owner or content as its own field, because that is the answer key.
     */
    expect(response.body.data.requirements).toContain('The project directory exists');
    const detail = JSON.stringify(response.body.data);
    expect(detail).not.toContain('file_mode');
    expect(detail).not.toContain('"mode"');
    expect(detail).not.toContain('"equals"');
    expect(detail).not.toContain('"group"');
  });

  it('reports provider readiness on /health', async () => {
    const { app } = buildApp();
    const response = await request(app).get('/health');

    const providers = response.body.data.providers as Array<{
      provider: string;
      registered: boolean;
      available: boolean;
    }>;
    expect(providers.map((p) => p.provider)).toEqual([
      'kubernetes',
      'linux',
      'docker',
      'terraform',
      'aws',
      'ansible',
      'cicd',
    ]);
    expect(response.body.data.labsLoaded).toBe(disk.labCount);
  });
});

// --- one generic session API ------------------------------------------------

describe('one session API serves every provider (test requirement 21)', () => {
  it('has no per-technology start endpoints', async () => {
    const { app } = buildApp();
    for (const route of ['/api/kubernetes/start', '/api/linux/start', '/api/terraform/start']) {
      const response = await request(app).post(route);
      expect(response.status).toBe(404);
    }
  });

  it('starts a Linux lab through the same endpoint as a Kubernetes lab', async () => {
    const { app, runtime } = buildApp();

    const linux = await start(app, 'LINUX-001');
    expect(linux.session.provider).toBe('linux');
    expect(linux.session.sandboxKind).toBe('container');
    expect(linux.session.sandboxRef).toMatch(/^jtt-lab-[0-9a-f]{12}$/);
    // A Linux session has no namespace, and the payload does not invent one.
    expect(linux.session.namespace).toBeUndefined();
    expect(runtime.containers.has(String(linux.session.sandboxRef))).toBe(true);

    const kubernetes = await start(app, 'K8S-001');
    expect(kubernetes.session.provider).toBe('kubernetes');
    expect(kubernetes.session.sandboxKind).toBe('namespace');
    expect(kubernetes.session.namespace).toMatch(/^lab-[0-9a-f]{12}$/);
  });

  it('checks, resets and ends a Linux session through the generic routes', async () => {
    const { app, runtime } = buildApp();
    const { session } = await start(app, 'LINUX-001');
    const sessionId = String(session.sessionId);
    const sandbox = String(session.sandboxRef);

    // Check fails on an untouched sandbox…
    const failing = await request(app).post(`/api/sessions/${sessionId}/check`);
    expect(failing.status).toBe(200);
    expect(failing.body.data.passed).toBe(false);

    // …and passes once the filesystem holds what the lab describes. LINUX-001
    // is the "move it, do not copy it" lab: the archive gains the log, and the
    // original path has to be genuinely gone.
    runtime.put(sandbox, '/home/student/project', { type: 'directory', mode: '755' });
    runtime.put(sandbox, '/home/student/project/config.txt', { type: 'file', mode: '644' });
    runtime.put(sandbox, '/home/student/project/archive', { type: 'directory', mode: '755' });
    runtime.put(sandbox, '/home/student/project/archive/app.log', { type: 'file', mode: '644' });

    const passing = await request(app).post(`/api/sessions/${sessionId}/check`);
    expect(passing.body.data.passed, JSON.stringify(passing.body.data.checks)).toBe(true);
    expect(passing.body.data.summary).toBe('LAB PASSED');

    // Reset restores the baseline and asks the UI to reattach its terminal.
    const reset = await request(app).post(`/api/sessions/${sessionId}/reset`);
    expect(reset.status).toBe(200);
    expect(reset.body.data.reconnectTerminal).toBe(true);
    expect(runtime.entry(sandbox, '/home/student/project')).toBeUndefined();

    const afterReset = await request(app).post(`/api/sessions/${sessionId}/check`);
    expect(afterReset.body.data.passed).toBe(false);

    // End releases the sandbox.
    const ended = await request(app).delete(`/api/sessions/${sessionId}`);
    expect(ended.status).toBe(200);
    expect(runtime.containers.has(sandbox)).toBe(false);
    expect(ended.body.data.session.status).toBe('ENDED');
  });

  it('does not ask a Kubernetes session to reconnect its terminal on reset', async () => {
    const { app } = buildApp();
    const { session } = await start(app, 'K8S-001');
    const reset = await request(app).post(`/api/sessions/${String(session.sessionId)}/reset`);
    expect(reset.body.data.reconnectTerminal).toBe(false);
  });

  it('refuses to start a lab whose provider is disabled, and creates nothing', async () => {
    const { app, sessions } = buildApp();
    // No Docker or AWS lab ships, so this is asserted at the registry: the
    // session manager refuses before a slot or a record exists.
    await expect(sessions.start('K8S-001')).resolves.toBeDefined();
    await expect(sessions.providers.resolve('docker')).rejects.toThrow(/per-session Docker daemon/);
    await expect(sessions.providers.resolve('aws')).rejects.toThrow(/architecture only/);
  });
});

// --- the terminal binding ---------------------------------------------------

describe('the terminal binding is resolved server-side (test requirements 29–30, 32)', () => {
  it('hands the terminal service a container reference for a Linux session', async () => {
    const { app, config } = buildApp();
    const { session, terminal } = await start(app, 'LINUX-001');

    const response = await request(app)
      .post(`/internal/sessions/${String(session.sessionId)}/credentials`)
      .set('x-internal-secret', config.internalServiceSecret)
      .send(terminalCredentialBody(terminal.token, config.terminalSessionSecret));

    expect(response.status).toBe(200);
    expect(response.body.data.kind).toBe('container-exec');
    expect(response.body.data.containerRef).toBe(session.sandboxRef);
    expect(response.body.data.user).toBe('student');
    // No credential of any kind for a container sandbox.
    expect(response.body.data.kubeconfig).toBeUndefined();
  });

  it('still hands the terminal service a kubeconfig for a Kubernetes session', async () => {
    const { app, config } = buildApp();
    const { session, terminal } = await start(app, 'K8S-001');

    const response = await request(app)
      .post(`/internal/sessions/${String(session.sessionId)}/credentials`)
      .set('x-internal-secret', config.internalServiceSecret)
      .send(terminalCredentialBody(terminal.token, config.terminalSessionSecret));

    expect(response.status).toBe(200);
    expect(response.body.data.kind).toBe('kubernetes');
    expect(response.body.data.namespace).toBe(session.namespace);
    expect(response.body.data.kubeconfig).toContain(`namespace: ${String(session.namespace)}`);
  });

  it('never serves a terminal binding to an unauthenticated caller', async () => {
    const { app } = buildApp();
    const { session } = await start(app, 'LINUX-001');

    const unauthenticated = await request(app).post(
      `/internal/sessions/${String(session.sessionId)}/credentials`,
    );
    expect(unauthenticated.status).toBe(401);
    expect(JSON.stringify(unauthenticated.body)).not.toContain('containerRef');
  });

  it('accepts no sandbox reference as input on any public route', async () => {
    const { app, runtime } = buildApp();
    const a = await start(app, 'LINUX-001');
    const b = await start(app, 'LINUX-001');

    runtime.put(String(b.session.sandboxRef), '/home/student/project', {
      type: 'directory',
      mode: '755',
      owner: 'student',
      group: 'student',
    });

    // Session A asks for a check while naming B's sandbox every way a body or
    // a query string allows. All of it is ignored: the sandbox comes from the
    // session record.
    const attack = await request(app)
      .post(`/api/sessions/${String(a.session.sessionId)}/check?sandboxRef=${String(b.session.sandboxRef)}`)
      .send({
        sandboxRef: b.session.sandboxRef,
        containerRef: b.session.sandboxRef,
        namespace: b.session.sandboxRef,
        provider: 'kubernetes',
      });

    expect(attack.status).toBe(200);
    expect(attack.body.data.passed).toBe(false);
    expect(attack.body.data.sandboxRef).toBe(a.session.sandboxRef);
    expect(attack.body.data.checks[0].detail).toMatch(
      /No directory found at '\/home\/student\/project'/,
    );
  });

  it('never returns a credential or a sandbox internal on a public route', async () => {
    const { app } = buildApp();
    const { session } = await start(app, 'LINUX-001');
    const sessionId = String(session.sessionId);

    const bodies = await Promise.all([
      request(app).get('/api/labs'),
      request(app).get('/api/labs/LINUX-001'),
      request(app).get('/api/tracks'),
      request(app).get(`/api/sessions/${sessionId}`),
      request(app).post(`/api/sessions/${sessionId}/check`),
      request(app).post(`/api/sessions/${sessionId}/activity`),
    ]);

    for (const response of bodies) {
      const text = JSON.stringify(response.body);
      expect(text).not.toMatch(/kubeconfig/i);
      expect(text).not.toMatch(/BEGIN CERTIFICATE/);
      expect(text).not.toMatch(/serviceAccountName/);
      expect(text).not.toMatch(/docker\.sock/);
      expect(text).not.toMatch(/"token"/);
      // The container *id* is a runtime handle and stays inside the
      // orchestrator; only the derived, non-granting name is ever served.
      expect(text).not.toMatch(/sha256:/);
    }
  });
});
