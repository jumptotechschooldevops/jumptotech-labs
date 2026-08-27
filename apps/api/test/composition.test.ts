/**
 * Production composition regression (Phase 0).
 *
 * Proves the wiring in `apps/api/src/composition.ts` — the same code path
 * `index.ts` uses — routes setup verification and provider resolution to the
 * correct substrate. Hermetic fakes only; no Docker daemon or kind cluster.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  LabRegistry,
  ProviderUnavailableError,
  REQUIREMENT_TYPES,
  SessionManager,
  parseLabDefinition,
  requirementsNeedDocker,
  requirementsNeedKubernetes,
} from '@jumptotech/lab-orchestrator';
import { InMemoryWorkspace } from '@jumptotech/lab-orchestrator';
import {
  FakeDockerEngines,
  FakeKubernetes,
  deploymentSnapshot,
} from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { loadConfig } from '../src/config.js';
import { buildRequirementWaiter, buildSandboxComposition } from '../src/composition.js';
import { buildDockerEngines } from '../src/providers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'composition-test-secret-value';

const K8S_SETUP_REQUIREMENTS = [
  { type: 'deployment_exists' as const, name: 'ledger', label: 'Deployment ledger exists' },
  {
    type: 'deployment_available' as const,
    name: 'ledger',
    min_available: 1,
    label: 'ledger is available',
  },
];

const DOCKER_SETUP_REQUIREMENTS = [
  {
    type: 'docker_container_running' as const,
    name: 'web',
    label: 'Container web is running',
  },
];

function testConfig(env: Partial<NodeJS.ProcessEnv> = {}) {
  return loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    ...env,
  } as NodeJS.ProcessEnv);
}

describe('buildRequirementWaiter — substrate routing', () => {
  it('classifies K8S-011 setup requirements as kubernetes-only', () => {
    expect(requirementsNeedDocker(K8S_SETUP_REQUIREMENTS)).toBe(false);
    expect(requirementsNeedKubernetes(K8S_SETUP_REQUIREMENTS)).toBe(true);
  });

  it('does not invoke Docker session execution for a kubernetes namespace', async () => {
    const namespace = 'lab-f31fde487e8b';
    const k8s = new FakeKubernetes({
      deployments: {
        [namespace]: [deploymentSnapshot({ name: 'ledger', namespace, availableReplicas: 1 })],
      },
    });
    const session = vi.fn(() => {
      throw new Error('engines.session must not be called for kubernetes setup');
    });
    const engines = { session } as unknown as FakeDockerEngines;

    const waitFor = buildRequirementWaiter({ k8s, engines });
    const result = await waitFor({
      namespace,
      requirements: K8S_SETUP_REQUIREMENTS,
      timeoutMs: 2_000,
    });

    expect(result.ok).toBe(true);
    expect(session).not.toHaveBeenCalled();
  });

  it('invokes Docker session execution only for docker setup requirements', async () => {
    const sandbox = 'jtt-lab-000000000001';
    const k8s = new FakeKubernetes();
    const engines = new FakeDockerEngines({ images: ['docker:27-dind'] });
    await engines.host.runContainer({
      name: sandbox,
      image: 'docker:27-dind',
      detach: true,
      labels: { 'jumptotech.io/managed': 'true', 'jumptotech.io/component': 'docker-sandbox' },
    });
    await engines.host.startContainer(sandbox);
    const sessionSpy = vi.spyOn(engines, 'session');

    const sessionDaemon = engines.session(sandbox);
    await sessionDaemon.runContainer({ name: 'web', image: 'nginx:stable', detach: true });

    const waitFor = buildRequirementWaiter({ k8s, engines });
    const result = await waitFor({
      namespace: sandbox,
      requirements: DOCKER_SETUP_REQUIREMENTS,
      timeoutMs: 2_000,
    });

    expect(sessionSpy).toHaveBeenCalledWith(sandbox);
    expect(result.ok).toBe(true);
  });

  it('grades a Docker workspace check against the named session, not the sandbox', async () => {
    const sandbox = 'jtt-lab-000000000002';
    const sessionId = 'session-waiter-workspace';
    const k8s = new FakeKubernetes();
    const engines = new FakeDockerEngines({ images: ['docker:27-dind'] });
    const workspace = new InMemoryWorkspace();
    await workspace.seed(sessionId, [{ path: 'Dockerfile', content: 'FROM alpine\n' }]);

    const waitFor = buildRequirementWaiter({ k8s, engines, workspace });
    const result = await waitFor({
      namespace: sandbox,
      sessionId,
      requirements: [
        { type: 'workspace_file_exists' as const, path: 'Dockerfile', label: 'Dockerfile exists' },
      ],
      timeoutMs: 2_000,
    });

    expect(result.ok).toBe(true);
  });

  it('does not hand a workspace to a Kubernetes batch', async () => {
    const namespace = 'lab-f31fde487e8b';
    const k8s = new FakeKubernetes({
      deployments: {
        [namespace]: [deploymentSnapshot({ name: 'ledger', namespace, availableReplicas: 1 })],
      },
    });
    const workspace = new InMemoryWorkspace();
    const read = vi.spyOn(workspace, 'read');
    const engines = { session: vi.fn() } as unknown as FakeDockerEngines;

    const waitFor = buildRequirementWaiter({ k8s, engines, workspace });
    const result = await waitFor({
      namespace,
      sessionId: 'session-kubernetes-only',
      requirements: K8S_SETUP_REQUIREMENTS,
      timeoutMs: 2_000,
    });

    expect(result.ok).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('buildSandboxComposition — provider routing', () => {
  let registry: LabRegistry;

  beforeAll(async () => {
    registry = new LabRegistry(path.join(repoRoot, 'labs'));
    await registry.load();
    expect(registry.loadErrors).toEqual([]);
  });

  function composition(env: Partial<NodeJS.ProcessEnv> = {}) {
    const config = testConfig(env);
    const runtime = new FakeContainerRuntime();
    const k8s = new FakeKubernetes();
    const engines = new FakeDockerEngines({ images: ['docker:27-dind'] });
    return buildSandboxComposition({ config, k8s, engines, containerRuntime: runtime });
  }

  it('routes kubernetes labs through the kind provider', async () => {
    const { providers } = composition();
    const provider = await providers.resolve('kubernetes');
    expect(provider.id).toBe('kubernetes');
  });

  it('routes linux labs through the linux provider', async () => {
    const { providers } = composition();
    const provider = await providers.resolve('linux');
    expect(provider.id).toBe('linux');
  });

  it('routes terraform labs through the terraform provider', async () => {
    const { providers } = composition();
    const provider = await providers.resolve('terraform');
    expect(provider.id).toBe('terraform');
  });

  it('routes docker labs through the docker provider when enabled', async () => {
    const { providers } = composition({ DOCKER_TRACK_ENABLED: 'true' });
    const provider = await providers.resolve('docker');
    expect(provider.id).toBe('docker');
  });

  it('chooses provider from environment.provider, not track name', async () => {
    const lab = parseLabDefinition(
      `id: SIM-001
slug: sim-001-track-mismatch
title: Track Mismatch Fixture
track: aws
topic: fixtures
difficulty: beginner
level: practice
duration_minutes: 10
order: 1
environment:
  provider: linux
  isolation: container
story: Fixture lab.
objectives:
  - Prove routing uses provider
task:
  summary: No-op
  description: No-op
requirements:
  - type: file_exists
    path: /etc/hostname
    label: hostname exists
references:
  - title: AWS General Reference
    url: https://docs.aws.amazon.com/general/latest/gr/
skills:
  - linux.files.read
hints:
  - level: 1
    text: Look around.
`,
      '<fixture>',
    );

    expect(lab.track).toBe('aws');
    expect(lab.environment.provider).toBe('linux');

    const { providers } = composition();
    const resolved = await providers.resolve(lab.environment.provider);
    expect(resolved.id).toBe('linux');
  });

  it('fails closed when a provider is unavailable instead of falling back', async () => {
    const { providers } = composition({ LINUX_PROVIDER_ENABLED: 'false' });
    await expect(providers.resolve('linux')).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('preserves session ownership on start via the composed provider registry', async () => {
    const config = testConfig();
    const runtime = new FakeContainerRuntime();
    const k8s = new FakeKubernetes();
    const engines = new FakeDockerEngines();
    const { providers, kubernetes } = buildSandboxComposition({
      config,
      k8s,
      engines,
      containerRuntime: runtime,
    });
    vi.spyOn(kubernetes, 'execute').mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.34.2' } }),
      stderr: '',
      timedOut: false,
    });

    const sessions = new SessionManager({
      registry,
      providers,
      store: new InMemorySessionStore(),
      policy: DEFAULT_SESSION_POLICY,
      lifetimes: config.lifetimes,
      namespaceSecret: config.namespaceSecret,
    });

    const started = await sessions.start('K8S-001', 'user-composition-owner');
    expect(started.session.ownerUserId).toBe('user-composition-owner');
  });
});

describe('buildSandboxComposition — workspace routing', () => {
  let labs: LabRegistry;

  beforeAll(async () => {
    labs = new LabRegistry(path.join(repoRoot, 'labs'));
    await labs.load();
    expect(labs.loadErrors).toEqual([]);
  });

  it('seeds a Docker lab workspace through the port the composition resolved', async () => {
    const config = testConfig({ DOCKER_TRACK_ENABLED: 'true' });
    const built = buildSandboxComposition({
      config,
      k8s: new FakeKubernetes(),
      // No `workspace` injected: this is the production shape, where the
      // resolved port is the only one that exists.
      engines: new FakeDockerEngines({ images: [config.policy.docker.image] }),
      containerRuntime: new FakeContainerRuntime(),
      sleep: async () => undefined,
    });
    expect(built.workspace).toBeInstanceOf(InMemoryWorkspace);

    const sessions = new SessionManager({
      registry: labs,
      providers: built.providers,
      store: new InMemorySessionStore(),
      policy: config.policy,
      lifetimes: config.lifetimes,
      namespaceSecret: config.namespaceSecret,
    });

    const started = await sessions.start('DOCKER-004', 'user-workspace-routing');

    // DOCKER-004 declares `setup.docker.files: message.txt`. Reading it back
    // through the composition's own port is what proves the Docker provider
    // was handed that port rather than falling back to `noopWorkspace`.
    expect(
      await built.workspace.read(started.session.sessionId, 'message.txt'),
    ).toContain('JumpToTech Bank');
  }, 30_000);

  it('does not pass an undefined workspace through to the provider registry', async () => {
    const source = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/composition.ts'),
      'utf8',
    );
    // `options.workspace` is the test injection point and is undefined in
    // production; the resolved `workspace` is what every consumer must get.
    expect(source).not.toMatch(/workspace:\s*options\.workspace/);
    expect(source).toMatch(/buildProviderRegistry\(\{[\s\S]*?\n\s*workspace,\n/);
  });

  it('seeds a Docker session workspace through the composed provider', async () => {
    const config = testConfig({ DOCKER_TRACK_ENABLED: 'true' });
    const workspace = new InMemoryWorkspace();
    const built = buildSandboxComposition({
      config,
      k8s: new FakeKubernetes(),
      engines: new FakeDockerEngines({ images: ['docker:27-dind'] }),
      containerRuntime: new FakeContainerRuntime(),
      workspace,
    });
    expect(built.workspace).toBe(workspace);
    await expect(built.providers.resolve('docker')).resolves.toMatchObject({ id: 'docker' });
  });
});

describe('verifier registration preserved in production composition', () => {
  it('registers process_environ for linux checks', () => {
    expect(REQUIREMENT_TYPES).toContain('process_environ');
  });
});

describe('production entrypoint uses the shared composition module', () => {
  it('imports buildSandboxComposition rather than duplicating waitFor wiring', async () => {
    const indexSource = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/index.ts'),
      'utf8',
    );
    expect(indexSource).toMatch(/from '\.\/composition\.js'/);
    expect(indexSource).toMatch(/buildSandboxComposition\(/);
    expect(indexSource).not.toMatch(/requirementsNeedDocker\(input\.requirements\)/);
  });
});

/**
 * Which runtime the composition actually builds.
 *
 * The tests above inject a fake runtime, which is right for provider routing
 * and useless for this question: the thing worth proving here is what
 * production *constructs* when nobody injects one, because that is the decision
 * that determines whether this service holds a Docker socket at all.
 */
describe('the container runtime a deployment gets', () => {
  /** The provider graph with no container runtime injected. */
  function realRuntime(env: Partial<NodeJS.ProcessEnv> = {}): string {
    const config = testConfig({
      INTERNAL_SERVICE_SECRET: 'an-internal-service-secret-for-tests',
      ...env,
    });
    const { providers } = buildSandboxComposition({
      config,
      k8s: new FakeKubernetes(),
      engines: new FakeDockerEngines({ images: ['docker:27-dind'] }),
    });
    return runtimeNameOf(providers);
  }

  it('drives a local Docker daemon when nothing is configured', () => {
    // `DockerCliRuntime` names itself `docker`; `BrokerRuntime` names itself
    // `sandboxd`. That name is the whole assertion.
    expect(realRuntime()).toBe('docker');
  });

  it('drives the broker — and holds no daemon access — when SANDBOX_BROKER_URL is set', () => {
    expect(realRuntime({ SANDBOX_BROKER_URL: 'http://sandboxd:4002' })).toBe('sandboxd');
  });

  it('prefers the broker over a daemon address, never the other way round', () => {
    expect(
      realRuntime({
        SANDBOX_BROKER_URL: 'http://sandboxd:4002',
        SANDBOX_RUNTIME_HOST: 'tcp://some-daemon:2376',
      }),
    ).toBe('sandboxd');
  });
});

/** The runtime name a provider reports. See `ContainerLabProvider.runtimeName`. */
function runtimeNameOf(providers: { peek(id: string): unknown }): string {
  const provider = providers.peek('linux') as { runtimeName?: string } | null;
  return provider?.runtimeName ?? 'none';
}

/**
 * Which Docker engine a deployment gets.
 *
 * The Docker track is the one that speaks `DockerEnginePort`, and it was the
 * last thing asking this service to hold a host Docker socket. The assertion
 * that matters is what production *constructs*: a brokered factory whose every
 * method is either a named broker operation or a hard refusal.
 */
describe('the Docker engine a deployment gets', () => {
  function engines(env: Partial<NodeJS.ProcessEnv> = {}) {
    return buildDockerEngines(
      testConfig({ INTERNAL_SERVICE_SECRET: 'an-internal-service-secret-for-tests', ...env }),
    );
  }

  it('drives a local Docker daemon when no broker is configured', () => {
    expect(engines().constructor.name).toBe('DockerCliFactory');
  });

  it('drives the broker — and holds no daemon access — when SANDBOX_BROKER_URL is set', () => {
    expect(engines({ SANDBOX_BROKER_URL: 'http://sandboxd:4002' }).constructor.name).toBe(
      'BrokerDockerEngines',
    );
  });

  it('cannot address a container it has no session for', () => {
    // The whole point of the brokered factory: a sandbox name is not an
    // argument the API can supply. There is no wire field for one.
    const brokered = engines({ SANDBOX_BROKER_URL: 'http://sandboxd:4002' });
    expect(() => brokered.session('jtt-lab-ffffffffffff')).toThrow(/no session is bound/i);
  });

  it('refuses the Docker operations the broker does not offer', async () => {
    const brokered = engines({ SANDBOX_BROKER_URL: 'http://sandboxd:4002' });
    // Never reaches the network: the refusal is in the client.
    await expect(brokered.host.pullImage('alpine')).rejects.toThrow(/not a brokered Docker operation/);
    await expect(brokered.host.listImages()).rejects.toThrow(/not a brokered Docker operation/);
    await expect(brokered.host.removeNetwork('x')).rejects.toThrow(/not a brokered Docker operation/);
  });
});
