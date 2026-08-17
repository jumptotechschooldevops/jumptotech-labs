/**
 * PLATFORM-004 — the provider registry (story test requirements 1–5).
 *
 * The registry is the seam that makes a track's technology lab metadata rather
 * than application code, so these tests pin the four things a caller can
 * expect from it: the providers that exist resolve, the ones that do not are
 * refused by name, and a provider that cannot run here reports *why* instead of
 * failing at the click.
 */
import { describe, expect, it } from 'vitest';
import {
  AwsLabProvider,
  DockerLabProvider,
  DOCKER_PROVIDER_DISABLED_REASON,
  KindLabProvider,
  LinuxLabProvider,
  ProviderRegistry,
  ProviderUnavailableError,
  TerraformLabProvider,
  singleProviderRegistry,
} from '../src/index.js';
import { FakeKubernetes } from './fakes.js';
import { FakeContainerRuntime } from './container-fakes.js';

function registry(runtime = new FakeContainerRuntime()) {
  const reg = new ProviderRegistry({ availabilityTtlMs: 0 });
  reg.register({ provider: new KindLabProvider({ k8s: new FakeKubernetes(), clusterName: 'jumptotech-labs' }) });
  reg.register({ provider: new LinuxLabProvider({ runtime }) });
  reg.register({ provider: new TerraformLabProvider({ runtime }) });
  reg.register({
    provider: new DockerLabProvider({ runtime }),
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
    reg.register({ provider: new KindLabProvider({ k8s, clusterName: 'jumptotech-labs' }) });

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
    ]);
    expect(statuses.every((s) => !s.registered && !s.available)).toBe(true);
  });
});

describe('single-provider registry', () => {
  it('answers for the provider it holds and refuses every other', async () => {
    const reg = singleProviderRegistry(
      new KindLabProvider({ k8s: new FakeKubernetes(), clusterName: 'jumptotech-labs' }),
    );
    await expect(reg.resolve('kubernetes')).resolves.toBeDefined();
    // The point of this: a lab that declares another provider must not silently
    // land in the wrong kind of sandbox.
    await expect(reg.resolve('linux')).rejects.toThrow(/no implementation is registered/);
  });
});
