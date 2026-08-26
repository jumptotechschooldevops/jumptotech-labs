/**
 * PLATFORM-004 — the provider registry (story test requirements 1–5).
 *
 * The registry is the seam that makes a track's technology lab metadata rather
 * than application code, so these tests pin the four things a caller can
 * expect from it: the providers that exist resolve, the ones that do not are
 * refused by name, and a provider that cannot run here reports *why* instead of
 * failing at the click.
 *
 * PLATFORM-DOCKER folded its own multi-provider routing suite in here rather
 * than keeping a parallel one against a second registry class. What that half
 * covers, at the bottom of this file: a lab lands on the substrate its own
 * `environment.provider` names, a *session* is torn down by the provider that
 * created it, the reaper sweeps every substrate because an orphan has no
 * session record to resolve one from, and a deployment that cannot run Docker
 * still serves Kubernetes and says why. The Kubernetes half of each of those is
 * a regression test: single-provider behaviour has to survive the seam.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AwsLabProvider,
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  LabRegistry,
  SessionManager,
  SessionReaper,
  DockerLabProvider,
  DOCKER_PROVIDER_DISABLED_REASON,
  KindLabProvider,
  LinuxLabProvider,
  ProviderRegistry,
  ProviderUnavailableError,
  TerraformLabProvider,
  singleProviderRegistry,
} from '../src/index.js';
import { FakeKubernetes, fakeExec } from './fakes.js';
import { FakeContainerRuntime } from './container-fakes.js';
import { FakeDockerEngines } from './docker-fakes.js';
import { LABS_DIR } from './helpers.js';

function registry(runtime = new FakeContainerRuntime()) {
  const reg = new ProviderRegistry({ availabilityTtlMs: 0 });
  reg.register({
    provider: new KindLabProvider({
      k8s: new FakeKubernetes(),
      clusterName: 'jumptotech-labs',
      exec: fakeExec(),
    }),
  });
  reg.register({ provider: new LinuxLabProvider({ runtime }) });
  reg.register({ provider: new TerraformLabProvider({ runtime }) });
  // The Docker provider drives a per-session daemon through an engine factory,
  // not the shared container runtime the Linux/Terraform sandboxes use.
  reg.register({
    provider: new DockerLabProvider({ engines: new FakeDockerEngines() }),
    enabled: false,
    disabledReason: DOCKER_PROVIDER_DISABLED_REASON,
  });
  reg.register({ provider: new AwsLabProvider(), enabled: false, disabledReason: 'architecture only' });
  return { reg, runtime };
}

describe('provider registry (test requirements 1–5)', () => {
  it('resolves the kubernetes provider', async () => {
    const { reg } = registry();
    const provider = await reg.resolve('kubernetes');
    expect(provider.id).toBe('kubernetes');
    expect(provider.sandboxKind).toBe('namespace');
  });

  it('resolves the linux provider', async () => {
    const { reg } = registry();
    const provider = await reg.resolve('linux');
    expect(provider.id).toBe('linux');
    expect(provider.sandboxKind).toBe('container');
  });

  it('resolves the terraform provider', async () => {
    const { reg } = registry();
    const provider = await reg.resolve('terraform');
    expect(provider.id).toBe('terraform');
    expect(provider.sandboxKind).toBe('container');
  });

  it('rejects an unknown provider by name, listing the ones that exist', async () => {
    const { reg } = registry();
    await expect(reg.resolve('jenkins')).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(reg.resolve('jenkins')).rejects.toThrow(/unknown provider/);
    await expect(reg.resolve('jenkins')).rejects.toThrow(/kubernetes, linux, docker, terraform, aws/);
  });

  it('rejects a provider in the vocabulary that nothing implements', async () => {
    const bare = new ProviderRegistry();
    bare.register({ provider: new AwsLabProvider() });
    await expect(bare.resolve('linux')).rejects.toThrow(/no implementation is registered/);
  });

  it('refuses a disabled provider with its reason rather than starting it', async () => {
    const { reg } = registry();
    await expect(reg.resolve('docker')).rejects.toThrow(/host daemon|architecture only|per-session/i);

    const status = await reg.status('docker');
    expect(status.registered).toBe(true);
    expect(status.available).toBe(false);
    expect(status.reason).toContain('Docker labs need a per-session Docker daemon');
  });

  it('reports AWS as registered but never available', async () => {
    const { reg } = registry();
    const status = await reg.status('aws');
    expect(status.registered).toBe(true);
    expect(status.available).toBe(false);
    await expect(reg.resolve('aws')).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe('availability is reported, not thrown', () => {
  it('marks container providers unavailable when no runtime answers', async () => {
    const runtime = new FakeContainerRuntime({ unreachable: 'Cannot connect to the Docker daemon' });
    const { reg } = registry(runtime);

    const status = await reg.status('linux');
    expect(status.available).toBe(false);
    expect(status.reason).toContain('no container runtime is reachable');
    expect(status.remediation).toMatch(/Start Docker/);
  });

  it('marks a container provider unavailable when its sandbox image is missing', async () => {
    const runtime = new FakeContainerRuntime({ images: [] });
    const { reg } = registry(runtime);

    const status = await reg.status('terraform');
    expect(status.available).toBe(false);
    expect(status.reason).toContain('has not been built');
    expect(status.remediation).toContain('npm run sandbox:build');
  });

  it('marks the kubernetes provider unavailable when the cluster is down', async () => {
    const k8s = new FakeKubernetes();
    k8s.unreachable = 'connect ECONNREFUSED 172.18.0.2:6443';
    const reg = new ProviderRegistry({ availabilityTtlMs: 0 });
    reg.register({
      provider: new KindLabProvider({ k8s, clusterName: 'jumptotech-labs', exec: fakeExec() }),
    });

    const status = await reg.status('kubernetes');
    expect(status.available).toBe(false);
    expect(status.reason).toContain('ECONNREFUSED');
  });

  it('reports every provider in the vocabulary, registered or not', async () => {
    const bare = new ProviderRegistry();
    const statuses = await bare.statuses();
    expect(statuses.map((s) => s.providerId)).toEqual([
      'kubernetes',
      'linux',
      'docker',
      'terraform',
      'aws',
      'ansible',
    ]);
    expect(statuses.every((s) => !s.registered && !s.available)).toBe(true);
  });
});

describe('single-provider registry', () => {
  it('answers for the provider it holds and refuses every other', async () => {
    const reg = singleProviderRegistry(
      new KindLabProvider({
        k8s: new FakeKubernetes(),
        clusterName: 'jumptotech-labs',
        exec: fakeExec(),
      }),
    );
    await expect(reg.resolve('kubernetes')).resolves.toBeDefined();
    // The point of this: a lab that declares another provider must not silently
    // land in the wrong kind of sandbox.
    await expect(reg.resolve('linux')).rejects.toThrow(/no implementation is registered/);
  });
});

// --------------------------------------------------- routing through sessions

/** A platform serving Kubernetes and Docker at once, against fakes for each. */
async function platform() {
  const labs = new LabRegistry(LABS_DIR);
  await labs.load();
  expect(labs.loadErrors).toEqual([]);

  const k8s = new FakeKubernetes();
  const engines = new FakeDockerEngines({ images: ['docker:27-dind'] });
  const clock = { now: 1_700_000_000_000 };

  const kind = new KindLabProvider({
    k8s,
    exec: fakeExec(),
    clusterName: 'jumptotech-labs',
    now: () => clock.now,
    sleep: async () => undefined,
  });
  vi.spyOn(kind, 'execute').mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.34.2' } }),
    stderr: '',
    timedOut: false,
  });

  const docker = new DockerLabProvider({
    engines,
    sandboxDaemonAvailable: true,
    now: () => clock.now,
    sleep: async () => undefined,
  });

  const providers = new ProviderRegistry({ availabilityTtlMs: 0 })
    .register({ provider: kind })
    .register({ provider: docker });

  const manager = new SessionManager({
    registry: labs,
    providers,
    store: new InMemorySessionStore(),
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: {
      maxSessionSeconds: 3_600,
      idleTimeoutSeconds: 1_200,
      warningSeconds: 300,
      maxActiveSessions: 20,
    },
    namespaceSecret: 'a-namespace-derivation-secret',
    now: () => clock.now,
  });

  return { labs, manager, providers, kind, docker, k8s, engines, clock };
}

function reaperFor(platformInstance: Awaited<ReturnType<typeof platform>>) {
  return new SessionReaper({
    sessions: platformInstance.manager,
    intervalMs: 60_000,
    orphanGraceMs: 60_000,
    retentionMs: 15 * 60_000,
    now: () => platformInstance.clock.now,
    log: () => undefined,
  });
}

describe('session manager — a lab lands on the substrate it declares', () => {
  it('starts a Kubernetes lab on the Kubernetes provider only', async () => {
    const { manager, k8s, engines } = await platform();

    const { session } = await manager.start('K8S-001');

    expect(session.provider).toBe('kubernetes');
    expect(session.environmentId.startsWith('kind:')).toBe(true);
    expect(k8s.namespaces.has(session.namespace)).toBe(true);
    // Nothing was created on the Docker host.
    expect(await engines.host.listContainers()).toEqual([]);
  });

  it('starts a Docker lab on the Docker provider only', async () => {
    const { manager, k8s, engines } = await platform();
    const before = new Set(k8s.namespaces.keys());

    const { session } = await manager.start('DOCKER-001');

    expect(session.provider).toBe('docker');
    expect(session.environmentId.startsWith('docker-sandbox:')).toBe(true);
    expect(await engines.host.inspectContainer(session.sandboxRef)).not.toBeNull();
    // No namespace was created in the cluster for a lab that does not use one.
    expect([...k8s.namespaces.keys()]).toEqual([...before]);
  });

  it('builds the terminal shape each substrate uses', async () => {
    const { manager } = await platform();

    const k8sSession = await manager.start('K8S-001');
    const dockerSession = await manager.start('DOCKER-001');

    const k8sTerminal = await manager.getTerminalContext(k8sSession.session.sessionId);
    const dockerTerminal = await manager.getTerminalContext(dockerSession.session.sessionId);

    // The discriminated union is what stops a Docker field being read off a
    // Kubernetes context; the terminal builds a different shell from each.
    expect(k8sTerminal.kind).toBe('kubernetes');
    expect(dockerTerminal.kind).toBe('docker-daemon');
  });

  it('resets and ends each session through its own provider', async () => {
    const { manager, k8s, engines } = await platform();
    const docker = await manager.start('DOCKER-001');
    const kubernetes = await manager.start('K8S-001');

    await manager.reset(docker.session.sessionId);
    // The Kubernetes session is untouched by a Docker reset.
    expect(k8s.namespaces.has(kubernetes.session.namespace)).toBe(true);

    await manager.end(docker.session.sessionId);

    expect(await engines.host.inspectContainer(docker.session.sandboxRef)).toBeNull();
    expect(k8s.namespaces.has(kubernetes.session.namespace)).toBe(true);
  });

  it('exposes every provider for the reaper to sweep', async () => {
    const { manager } = await platform();

    expect(manager.providers.registeredIds).toEqual(['kubernetes', 'docker']);
    expect(manager.providers.all()).toHaveLength(2);
  });
});

// ------------------------------------------------------------- the reaper

describe('reaper — orphans are reclaimed on every substrate', () => {
  it('removes an expired Docker sandbox that has no session record', async () => {
    const instance = await platform();
    const { manager, engines, clock } = instance;
    const reaper = reaperFor(instance);

    // A sandbox created by a session the store has since forgotten.
    const { session } = await manager.start('DOCKER-001');
    await manager.forget(session.sessionId);
    clock.now += 3 * 60 * 60_000;

    const result = await reaper.sweep();

    expect(result.removed).toContain(session.sandboxRef);
    expect(result.reasons[session.sandboxRef]).toBe('orphaned');
    expect(await engines.host.inspectContainer(session.sandboxRef)).toBeNull();
  });

  it('sweeps Kubernetes and Docker in one pass', async () => {
    const instance = await platform();
    const { manager, k8s, engines, clock } = instance;
    const reaper = reaperFor(instance);

    const k8sSession = (await manager.start('K8S-001')).session;
    const dockerSession = (await manager.start('DOCKER-001')).session;
    await manager.forget(k8sSession.sessionId);
    await manager.forget(dockerSession.sessionId);
    clock.now += 3 * 60 * 60_000;

    const result = await reaper.sweep();

    expect(result.removed).toEqual(
      expect.arrayContaining([k8sSession.namespace, dockerSession.sandboxRef]),
    );
    expect(k8s.namespaces.has(k8sSession.namespace)).toBe(false);
    expect(await engines.host.inspectContainer(dockerSession.sandboxRef)).toBeNull();
  });

  it('one unreachable substrate does not stop the other being reclaimed', async () => {
    const instance = await platform();
    const { manager, engines, k8s, clock } = instance;
    const reaper = reaperFor(instance);

    const k8sSession = (await manager.start('K8S-001')).session;
    await manager.forget(k8sSession.sessionId);
    clock.now += 3 * 60 * 60_000;

    engines.host.unreachable = 'Cannot connect to the Docker daemon';

    const result = await reaper.sweep();

    // The Docker failure is reported, and the Kubernetes orphan is still gone.
    expect(result.errors.join(' ')).toMatch(/docker/i);
    expect(result.removed).toContain(k8sSession.namespace);
    expect(k8s.namespaces.has(k8sSession.namespace)).toBe(false);
  });

  it('leaves a live session on either substrate alone', async () => {
    const instance = await platform();
    const { manager, engines, k8s } = instance;
    const reaper = reaperFor(instance);

    const k8sSession = (await manager.start('K8S-001')).session;
    const dockerSession = (await manager.start('DOCKER-001')).session;

    const result = await reaper.sweep();

    expect(result.removed).toEqual([]);
    expect(k8s.namespaces.has(k8sSession.namespace)).toBe(true);
    expect(await engines.host.inspectContainer(dockerSession.sandboxRef)).not.toBeNull();
  });
});
