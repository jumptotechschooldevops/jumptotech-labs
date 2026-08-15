/**
 * Integration tests against a REAL kind cluster.
 *
 * Skipped unless RUN_INTEGRATION_TESTS=1, so `npm test` stays hermetic.
 * Run them with:
 *
 *   npm run cluster:up
 *   KUBECONFIG=infrastructure/kind/generated/kubeconfig-host.yaml \
 *     npm run test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  KubernetesClient,
  KindLabProvider,
  loadLabDefinition,
  labContextFor,
  type LabContext,
  type LabDefinition,
} from '../src/index.js';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HOST_KUBECONFIG =
  process.env.KUBECONFIG ?? path.join(repoRoot, 'infrastructure/kind/generated/kubeconfig-host.yaml');

const enabled = process.env.RUN_INTEGRATION_TESTS === '1' && existsSync(HOST_KUBECONFIG);

const suite = enabled ? describe : describe.skip;

async function kubectl(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('kubectl', args, {
    env: { ...process.env, KUBECONFIG: HOST_KUBECONFIG },
    timeout: 60_000,
  });
  return stdout;
}

suite('integration: real kind cluster', () => {
  let k8s: KubernetesClient;
  let provider: KindLabProvider;
  let lab: LabDefinition;
  let context: LabContext;

  beforeAll(async () => {
    lab = await loadLabDefinition(path.join(repoRoot, 'labs/kubernetes/k8s-001-pods/lab.yaml'));
    context = labContextFor(lab);
    k8s = new KubernetesClient({ kubeconfigPath: HOST_KUBECONFIG });
    provider = new KindLabProvider({
      k8s,
      clusterName: process.env.LAB_CLUSTER_NAME ?? 'jumptotech-labs',
      kubeconfigPath: HOST_KUBECONFIG,
      resetDrainTimeoutMs: 90_000,
    });
  }, 120_000);

  afterAll(async () => {
    if (enabled) await provider.reset(context).catch(() => undefined);
  }, 120_000);

  // Test requirement 3 — Kubernetes environment health.
  it('reports a healthy environment', async () => {
    const info = await provider.status(context);

    expect(info.phase).toBe('ready');
    expect(info.nodes?.length).toBeGreaterThan(0);
    expect(info.nodes?.every((n) => n.ready)).toBe(true);
    expect(info.kubernetesVersion).toMatch(/^v1\./);
  }, 60_000);

  it('creates the sandbox and verifies kubectl really works', async () => {
    const result = await provider.create(context);

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.status)).toEqual(['ok', 'ok', 'ok']);

    const exec = await provider.execute(context, { command: 'kubectl', args: ['get', 'nodes', '-o', 'name'] });
    expect(exec.exitCode).toBe(0);
    expect(exec.stdout).toContain('node/');
  }, 120_000);

  // Test requirement 4 — verifier when the Pod does not exist.
  it('sees no Pod on a freshly created sandbox', async () => {
    await provider.create(context);

    expect(await k8s.getPod('default', 'nginx')).toBeNull();
  }, 120_000);

  // Test requirement 6 — verifier with the correct Pod.
  it('observes a real Pod reaching Running/Ready', async () => {
    await provider.create(context);
    await kubectl('run', 'nginx', '--image=nginx:stable', '-n', 'default');
    await kubectl('wait', '--for=condition=Ready', 'pod/nginx', '-n', 'default', '--timeout=180s');

    const pod = await k8s.getPod('default', 'nginx');

    expect(pod).not.toBeNull();
    expect(pod?.name).toBe('nginx');
    expect(pod?.namespace).toBe('default');
    expect(pod?.phase).toBe('Running');
    expect(pod?.containers[0]?.image).toBe('nginx:stable');
    expect(pod?.containers[0]?.ready).toBe(true);
  }, 300_000);

  // Test requirement 7 — reset.
  it('reset removes the student Pod and leaves the cluster healthy', async () => {
    await provider.create(context);
    await kubectl('run', 'nginx', '--image=nginx:stable', '-n', 'default');
    expect(await k8s.getPod('default', 'nginx')).not.toBeNull();

    const result = await provider.reset(context);

    expect(result.ok).toBe(true);
    expect(result.removed).toContain('pods/nginx');
    expect(await k8s.getPod('default', 'nginx')).toBeNull();
    expect(result.environment.phase).toBe('ready');

    // The cluster-managed default/kubernetes Service must survive.
    const services = await k8s.listNamespacedResources('default', 'services');
    expect(services.map((s) => s.name)).toContain('kubernetes');
  }, 300_000);
});

if (!enabled) {
  // Make the skip reason visible in CI output rather than silently passing.
  // eslint-disable-next-line no-console
  console.log(
    `[integration] skipped — set RUN_INTEGRATION_TESTS=1 and ensure ${HOST_KUBECONFIG} exists`,
  );
}
