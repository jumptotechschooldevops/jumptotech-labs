/**
 * Test requirements 3 and 7 — Kubernetes environment health, and reset.
 * These run against the in-memory fake; `integration.test.ts` runs the same
 * ideas against a real kind cluster.
 */
import { describe, expect, it, vi } from 'vitest';
import { KindLabProvider, type LabContext } from '../src/index.js';
import { FakeKubernetes, podSnapshot } from './fakes.js';

const CONTEXT: LabContext = {
  labId: 'K8S-001',
  namespace: 'default',
  purgeResources: ['pods', 'deployments', 'services', 'configmaps'],
  protectedResources: ['services/kubernetes', 'configmaps/kube-root-ca.crt'],
};

/** Provider with `execute()` stubbed so tests never shell out to kubectl. */
function makeProvider(k8s: FakeKubernetes, kubectlOk = true) {
  const provider = new KindLabProvider({
    k8s,
    clusterName: 'jumptotech-labs',
    resetDrainTimeoutMs: 2_000,
  });
  vi.spyOn(provider, 'execute').mockResolvedValue(
    kubectlOk
      ? { exitCode: 0, stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.34.2' } }), stderr: '', timedOut: false }
      : { exitCode: 127, stdout: '', stderr: 'kubectl: command not found', timedOut: false },
  );
  return provider;
}

describe('environment health (test requirement 3)', () => {
  it('reports ready when the API is up and all nodes are Ready', async () => {
    const provider = makeProvider(new FakeKubernetes());

    const info = await provider.status(CONTEXT);

    expect(info.phase).toBe('ready');
    expect(info.provider).toBe('kind');
    expect(info.namespace).toBe('default');
    expect(info.kubernetesVersion).toBe('v1.34.0');
    expect(info.nodes?.[0]?.name).toBe('jumptotech-labs-control-plane');
  });

  it('reports degraded when a node is NotReady', async () => {
    const k8s = new FakeKubernetes({
      nodes: [{ name: 'cp', ready: false, roles: ['control-plane'], version: 'v1.34.0' }],
    });

    const info = await makeProvider(k8s).status(CONTEXT);

    expect(info.phase).toBe('degraded');
    expect(info.message).toContain('cp');
  });

  it('reports error with the real transport message when the API is down', async () => {
    const k8s = new FakeKubernetes({ unreachable: 'connect ECONNREFUSED 172.18.0.2:6443' });
    const provider = makeProvider(k8s);

    const info = await provider.status(CONTEXT);

    expect(info.phase).toBe('error');
    expect(info.message).toContain('ECONNREFUSED');
  });

  it('reports not_created when the lab namespace is missing', async () => {
    const k8s = new FakeKubernetes({ namespaces: ['kube-system'] });
    const provider = makeProvider(k8s);

    const info = await provider.status(CONTEXT);

    expect(info.phase).toBe('not_created');
    expect(info.message).toContain('default');
  });
});

describe('create()', () => {
  it('reports every provisioning step in order on success', async () => {
    const p = makeProvider(new FakeKubernetes());

    const result = await p.create(CONTEXT);

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.id)).toEqual(['environment-created', 'kubernetes-api', 'kubectl']);
    expect(result.steps.every((s) => s.status === 'ok')).toBe(true);
    expect(result.environment.phase).toBe('ready');
    expect(result.error).toBeUndefined();
  });

  it('clears leftover student resources so the lab starts from baseline', async () => {
    const k8s = new FakeKubernetes({ pods: { default: [podSnapshot({ name: 'leftover' })] } });
    const p = makeProvider(k8s);

    const result = await p.create(CONTEXT);

    expect(result.ok).toBe(true);
    expect(await k8s.countPods('default')).toBe(0);
    expect(result.steps[0]?.detail).toMatch(/cleared 1 leftover resource/);
  });

  it('fails with the real error — never a fake "ready" — when the API is down', async () => {
    const k8s = new FakeKubernetes({ unreachable: 'connect ECONNREFUSED 172.18.0.2:6443' });
    const p = makeProvider(k8s);

    const result = await p.create(CONTEXT);

    expect(result.ok).toBe(false);
    expect(result.environment.phase).toBe('error');
    expect(result.error?.message).toContain('ECONNREFUSED');
    expect(result.steps.some((s) => s.status === 'failed')).toBe(true);
  });

  it('fails when kubectl is unavailable', async () => {
    const p = makeProvider(new FakeKubernetes(), /* kubectlOk */ false);

    const result = await p.create(CONTEXT);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('KUBECTL_UNAVAILABLE');
    expect(result.error?.message).toContain('command not found');
  });

  it('is idempotent — a second create still succeeds', async () => {
    const p = makeProvider(new FakeKubernetes());

    expect((await p.create(CONTEXT)).ok).toBe(true);
    expect((await p.create(CONTEXT)).ok).toBe(true);
  });
});

describe('reset() (test requirement 7)', () => {
  it('removes student resources and reports what went', async () => {
    const k8s = new FakeKubernetes({
      pods: { default: [podSnapshot(), podSnapshot({ name: 'extra' })] },
      resources: {
        'default/deployments': [{ resource: 'deployments', name: 'web' }],
        'default/services': [{ resource: 'services', name: 'kubernetes' }],
        'default/configmaps': [{ resource: 'configmaps', name: 'kube-root-ca.crt' }],
      },
    });
    const p = makeProvider(k8s);

    const result = await p.reset(CONTEXT);

    expect(result.ok).toBe(true);
    expect(result.removed).toEqual(['pods/nginx', 'pods/extra', 'deployments/web']);
    expect(await k8s.countPods('default')).toBe(0);
  });

  it('never deletes protected cluster-managed objects', async () => {
    const k8s = new FakeKubernetes({
      resources: {
        'default/services': [{ resource: 'services', name: 'kubernetes' }],
        'default/configmaps': [{ resource: 'configmaps', name: 'kube-root-ca.crt' }],
      },
    });
    const p = makeProvider(k8s);

    await p.reset(CONTEXT);

    expect(k8s.deleted).toEqual([]);
    expect(await k8s.listNamespacedResources('default', 'services')).toHaveLength(1);
  });

  it('succeeds on an already-clean namespace', async () => {
    const p = makeProvider(new FakeKubernetes());

    const result = await p.reset(CONTEXT);

    expect(result.ok).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.steps.map((s) => s.status)).toEqual(['ok', 'ok', 'ok']);
  });

  it('confirms cluster health as part of the reset', async () => {
    const p = makeProvider(new FakeKubernetes());

    const result = await p.reset(CONTEXT);

    expect(result.steps.find((s) => s.id === 'health')?.status).toBe('ok');
    expect(result.environment.phase).toBe('ready');
  });

  it('reports failure when the cluster is unreachable', async () => {
    const k8s = new FakeKubernetes({ unreachable: 'connect ECONNREFUSED 172.18.0.2:6443' });
    const p = makeProvider(k8s);

    const result = await p.reset(CONTEXT);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('RESET_FAILED');
    expect(result.error?.message).toContain('ECONNREFUSED');
  });

  it('lets the lab be attempted repeatedly', async () => {
    const k8s = new FakeKubernetes();
    const p = makeProvider(k8s);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      k8s.pods.set('default', [podSnapshot()]);
      expect(await k8s.countPods('default')).toBe(1);
      expect((await p.reset(CONTEXT)).ok).toBe(true);
      expect(await k8s.countPods('default')).toBe(0);
    }
  });
});

describe('execute() command allow-list', () => {
  it('refuses a binary that is not allow-listed', async () => {
    const p = new KindLabProvider({ k8s: new FakeKubernetes(), clusterName: 'jumptotech-labs' });

    await expect(p.execute(CONTEXT, { command: 'sh', args: ['-c', 'id'] })).rejects.toThrow(
      /not allow-listed/,
    );
    await expect(p.execute(CONTEXT, { command: '/bin/bash', args: [] })).rejects.toThrow(
      /not allow-listed/,
    );
  });

  it('requires args to be an array of strings', async () => {
    const p = new KindLabProvider({ k8s: new FakeKubernetes(), clusterName: 'jumptotech-labs' });

    await expect(
      p.execute(CONTEXT, { command: 'kubectl', args: [42 as unknown as string] }),
    ).rejects.toThrow(/array of strings/);
  });
});
