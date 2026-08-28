/**
 * PLATFORM-003 — the generic setup engine.
 *
 * Story test requirements 13–15: setup manifests apply only to the session
 * namespace, Reset restores the lab's initial state, and setup can never
 * target a protected namespace.
 *
 * The safety properties here are the reason lab content is data rather than
 * code. A lab author writes YAML; they cannot write a namespace, a kind
 * outside the allow-list, or anything that executes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ALLOWED_SETUP_KINDS,
  KindLabProvider,
  LabDefinitionError,
  loadLabDefinition,
  loadSetupManifests,
  type LoadedLabDefinition,
} from '../src/index.js';
import { FakeKubernetes, fakeExec } from './fakes.js';
import { sessionContext } from './helpers.js';
import { realCatalog } from './real-catalog.js';

const NS_A = 'lab-00000000000a';
const NS_B = 'lab-00000000000b';

const tempDirs: string[] = [];

/** Write a throwaway lab directory containing a lab.yaml plus setup manifests. */
async function fixtureLab(
  manifests: Record<string, string>,
  setupYaml = 'setup:\n  manifests: [setup/app.yaml]\n  verify:\n    - type: deployment_exists\n      name: app\n',
): Promise<LoadedLabDefinition> {
  const root = await mkdtemp(path.join(tmpdir(), 'jtt-setup-'));
  tempDirs.push(root);
  await mkdir(path.join(root, 'setup'), { recursive: true });
  for (const [file, contents] of Object.entries(manifests)) {
    await writeFile(path.join(root, file), contents, 'utf8');
  }
  await writeFile(
    path.join(root, 'lab.yaml'),
    `id: K8S-901
slug: k8s-901-demo
title: Setup Fixture
track: kubernetes
topic: pods
difficulty: beginner
duration_minutes: 15
environment:
  provider: kubernetes
task:
  summary: Fixture.
  description: Fixture lab used by the setup engine tests.
requirements:
  - type: deployment_exists
    name: app
    label: Deployment app exists
references:
  - title: Kubernetes Pods
    url: https://kubernetes.io/docs/concepts/workloads/pods/
skills:
  - kubernetes.pods.create
${setupYaml}`,
    'utf8',
  );
  return loadLabDefinition(path.join(root, 'lab.yaml'));
}

const DEPLOYMENT_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  replicas: 1
  selector:
    matchLabels: { app: app }
  template:
    metadata:
      labels: { app: app }
    spec:
      containers:
        - name: app
          image: nginx:stable
`;

/** A provider whose setup verification always succeeds, so tests isolate setup itself. */
function provider(k8s: FakeKubernetes): KindLabProvider {
  return new KindLabProvider({
    k8s,
    clusterName: 'jumptotech-labs',
    exec: fakeExec(),
    resetDrainTimeoutMs: 1_000,
    destroyTimeoutMs: 1_000,
    sleep: async () => undefined,
    waitForRequirements: async () => ({ ok: true, checks: [] }),
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// -------------------------------------------- 13. setup targets one namespace

describe('setup engine — manifests apply only to the session namespace (test requirement 13)', () => {
  it('applies a lab fixture into the session namespace and nowhere else', async () => {
    const lab = await fixtureLab({ 'setup/app.yaml': DEPLOYMENT_YAML });
    const k8s = new FakeKubernetes();
    const result = await provider(k8s).create(sessionContext(lab, { namespace: NS_A }));

    expect(result.ok).toBe(true);
    expect(k8s.appliedKinds(NS_A, 'Deployment').map((o) => o.metadata.name)).toEqual(['app']);
    // Nothing was written anywhere else at all.
    expect([...k8s.applied.keys()]).toEqual([NS_A]);
  });

  it('keeps two sessions of the same lab in separate namespaces', async () => {
    const lab = await fixtureLab({ 'setup/app.yaml': DEPLOYMENT_YAML });
    const k8s = new FakeKubernetes();
    const engine = provider(k8s);

    await engine.create(sessionContext(lab, { sessionId: 'sess-a', namespace: NS_A }));
    await engine.create(sessionContext(lab, { sessionId: 'sess-b', namespace: NS_B }));

    expect(k8s.appliedKinds(NS_A, 'Deployment')).toHaveLength(1);
    expect(k8s.appliedKinds(NS_B, 'Deployment')).toHaveLength(1);
    expect([...k8s.applied.keys()].sort()).toEqual([NS_A, NS_B]);
  });

  it('rejects a setup manifest that names its own namespace', async () => {
    const lab = await fixtureLab({
      'setup/app.yaml': DEPLOYMENT_YAML.replace('  name: app', '  name: app\n  namespace: kube-system'),
    });

    await expect(loadSetupManifests(lab)).rejects.toThrow(/must not set metadata\.namespace/);
  });

  it('reads setup manifests in declaration order', async () => {
    const lab = await fixtureLab(
      {
        'setup/config.yaml': 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cfg\ndata:\n  a: b\n',
        'setup/app.yaml': DEPLOYMENT_YAML,
      },
      'setup:\n  manifests: [setup/config.yaml, setup/app.yaml]\n  verify:\n    - type: deployment_exists\n      name: app\n',
    );

    // Order matters: a Deployment mounting a ConfigMap needs the ConfigMap first.
    expect((await loadSetupManifests(lab)).map((o) => o.kind)).toEqual(['ConfigMap', 'Deployment']);
  });
});

// ------------------------------------------------- 14. reset restores state

describe('setup engine — reset restores the lab initial state (test requirement 14)', () => {
  it('purges student resources and re-applies the fixture', async () => {
    const lab = await fixtureLab({ 'setup/app.yaml': DEPLOYMENT_YAML });
    const k8s = new FakeKubernetes({
      // The namespace must exist for reset's closing health check to pass —
      // reset keeps the sandbox, so a missing namespace is a genuine failure.
      namespaces: ['default', 'kube-system', NS_A],
      resources: {
        [`${NS_A}/deployments`]: [{ resource: 'deployments', name: 'student-made' }],
        [`${NS_A}/services`]: [{ resource: 'services', name: 'kubernetes' }],
      },
    });
    const context = sessionContext(lab, { namespace: NS_A });

    const result = await provider(k8s).reset(context);

    expect(result.ok).toBe(true);
    expect(result.removed).toContain('deployments/student-made');
    // Cluster-managed objects survive a reset.
    expect(result.removed).not.toContain('services/kubernetes');
    expect(result.restored).toEqual(['setup/app.yaml']);
    expect(k8s.appliedKinds(NS_A, 'Deployment').map((o) => o.metadata.name)).toEqual(['app']);
  });

  it('never strips a session of its own guardrails', async () => {
    const lab = await fixtureLab({ 'setup/app.yaml': DEPLOYMENT_YAML });
    const context = sessionContext(lab, { namespace: NS_A });
    const k8s = new FakeKubernetes({
      resources: {
        [`${NS_A}/resourcequotas`]: [{ resource: 'resourcequotas', name: context.policy.quotaName }],
        [`${NS_A}/limitranges`]: [{ resource: 'limitranges', name: context.policy.limitRange.name }],
        [`${NS_A}/serviceaccounts`]: [{ resource: 'serviceaccounts', name: 'student' }],
      },
    });

    // The lab asks for these kinds to be purged; the platform refuses anyway.
    const greedy: LoadedLabDefinition = {
      ...lab,
      reset: {
        ...lab.reset,
        purge_namespaced_resources: ['resourcequotas', 'limitranges', 'serviceaccounts'],
      },
    };

    const result = await provider(k8s).reset({ ...context, lab: greedy });

    expect(result.removed).toEqual([]);
    expect(k8s.deleted).toEqual([]);
  });

  it('restores a troubleshooting lab to its broken starting condition', async () => {
    const registry = await realCatalog();
    const lab = registry.get('K8S-010');
    const k8s = new FakeKubernetes();

    await provider(k8s).reset(sessionContext(lab, { namespace: NS_A }));

    // Reset re-applies the fault: the point of Reset on K8S-010 is to replay
    // the scenario, not to leave the student with a healthy workload.
    const applied = k8s.appliedKinds(NS_A);
    const deployment = applied.find((o) => o.kind === 'Deployment');
    const service = applied.find((o) => o.kind === 'Service');
    const containers = (deployment?.spec as { template: { spec: { containers: Array<{ image: string }> } } })
      .template.spec.containers;

    expect(containers[0]?.image).toBe('nginx:stabel');
    expect((service?.spec as { selector: Record<string, string> }).selector).toEqual({ app: 'ledger' });
  });

  it('only ever touches the resetting session namespace', async () => {
    const lab = await fixtureLab({ 'setup/app.yaml': DEPLOYMENT_YAML });
    const k8s = new FakeKubernetes({
      resources: {
        [`${NS_A}/deployments`]: [{ resource: 'deployments', name: 'a-work' }],
        [`${NS_B}/deployments`]: [{ resource: 'deployments', name: 'b-work' }],
      },
    });

    await provider(k8s).reset(sessionContext(lab, { namespace: NS_A }));

    expect(k8s.deleted).toEqual([`${NS_A}/deployments/a-work`]);
    expect(await k8s.listNamespacedResources(NS_B, 'deployments')).toEqual([
      { resource: 'deployments', name: 'b-work' },
    ]);
  });
});

// -------------------------------------- 15. setup cannot reach anything else

describe('setup engine — setup cannot target protected namespaces or kinds (test requirement 15)', () => {
  it('refuses a manifest that would create a Namespace', async () => {
    const lab = await fixtureLab({
      'setup/app.yaml': 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: kube-system\n',
    });

    await expect(loadSetupManifests(lab)).rejects.toThrow(/kind 'Namespace' is not allowed/);
  });

  it('refuses manifests that would grant RBAC or edit the guardrails', async () => {
    for (const kind of ['Role', 'RoleBinding', 'ClusterRole', 'ResourceQuota', 'LimitRange', 'NetworkPolicy']) {
      const lab = await fixtureLab({
        'setup/app.yaml': `apiVersion: v1\nkind: ${kind}\nmetadata:\n  name: escalate\n`,
      });
      await expect(loadSetupManifests(lab)).rejects.toThrow(/is not allowed in lab setup/);
    }
  });

  it('allows only namespaced, disposable workload kinds', () => {
    expect(ALLOWED_SETUP_KINDS).toEqual(
      expect.arrayContaining(['Pod', 'Deployment', 'Service', 'ConfigMap', 'Secret', 'Job', 'CronJob']),
    );
    for (const forbidden of ['Namespace', 'Node', 'ClusterRole', 'ResourceQuota', 'PersistentVolume']) {
      expect(ALLOWED_SETUP_KINDS).not.toContain(forbidden);
    }
  });

  it('refuses a manifest path that escapes the lab directory', async () => {
    const lab = await fixtureLab({ 'setup/app.yaml': DEPLOYMENT_YAML });
    const escaped: LoadedLabDefinition = {
      ...lab,
      setup: { ...lab.setup, manifests: ['setup/../../../etc/hosts.yaml'] },
    };

    // The schema rejects `..` at authoring time; this asserts the loader
    // re-checks the resolved path, so a path that slipped through still cannot
    // read outside the lab's own directory.
    await expect(loadSetupManifests(escaped)).rejects.toThrow(LabDefinitionError);
  });

  it('refuses a manifest with no kind or no name', async () => {
    const noKind = await fixtureLab({ 'setup/app.yaml': 'apiVersion: v1\nmetadata:\n  name: x\n' });
    await expect(loadSetupManifests(noKind)).rejects.toThrow(/missing kind/);

    const noName = await fixtureLab({ 'setup/app.yaml': 'apiVersion: v1\nkind: ConfigMap\nmetadata: {}\n' });
    await expect(loadSetupManifests(noName)).rejects.toThrow(/missing metadata\.name/);
  });

  it('loads every shipped lab fixture without complaint', async () => {
    const registry = await realCatalog();

    for (const lab of registry.all()) {
      const objects = await loadSetupManifests(lab);
      for (const object of objects) {
        expect(ALLOWED_SETUP_KINDS).toContain(object.kind);
        expect(object.metadata.namespace).toBeUndefined();
      }
    }
  });
});
