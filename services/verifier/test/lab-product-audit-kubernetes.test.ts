/**
 * Kubernetes labs: grading defects found by the 2026-09-21 lab product audit,
 * pinned so they stay closed. Each test drives the real catalog lab through the
 * real `verifyLab`. Objects are built from the lab's own setup manifests with
 * the snapshot converter the real client uses (`toDeploymentSnapshot`), then
 * edited the way a student would.
 */
import { describe, expect, it } from 'vitest';
import {
  loadSetupManifests,
  toDeploymentSnapshot,
  type AuthorizationResult,
  type DeploymentSnapshot,
  type EndpointsSnapshot,
  type LoadedLabDefinition,
  type PodSnapshot,
  type RoleSnapshot,
  type RoleBindingSnapshot,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { verifyLab } from '../src/index.js';

const NS = 'jtt-lab-00000000zz01';
type Manifest = Record<string, any>;

async function lab(id: string): Promise<LoadedLabDefinition> {
  return (await realCatalog()).get(id);
}

async function manifests(l: LoadedLabDefinition): Promise<Manifest[]> {
  return (await loadSetupManifests(l)) as Manifest[];
}

/** A Deployment manifest as its controller reports it once fully rolled out. */
function healthy(m: Manifest, revision: number): DeploymentSnapshot {
  const replicas = m.spec?.replicas ?? 1;
  return toDeploymentSnapshot(
    {
      ...m,
      metadata: {
        ...m.metadata,
        namespace: NS,
        generation: revision,
        annotations: { ...(m.metadata.annotations ?? {}), 'deployment.kubernetes.io/revision': String(revision) },
      },
      status: {
        observedGeneration: revision,
        replicas,
        updatedReplicas: replicas,
        readyReplicas: replicas,
        availableReplicas: replicas,
        conditions: [{ type: 'Available', status: 'True' }],
      },
    } as any,
    NS,
    m.metadata.name,
  );
}

const failing = (r: Awaited<ReturnType<typeof verifyLab>>) =>
  r.checks.filter((c) => c.status !== 'pass').map((c) => `${c.label}: ${c.detail ?? ''}`);

/**
 * A faithful-enough namespaced RBAC evaluator: a SubjectAccessReview is allowed
 * when a RoleBinding in the namespace binds the ServiceAccount to a Role with a
 * rule covering apiGroup / resource / verb (and resourceNames when set), with
 * `*` wildcards — the semantics of the RBAC authorizer for namespaced Roles.
 */
class RbacNamespace extends FakeKubernetes {
  override async createSubjectAccessReview(p: {
    namespace: string;
    user: string;
    verb: string;
    resource: string;
    apiGroup: string;
    name?: string;
  }): Promise<AuthorizationResult> {
    const bindings: RoleBindingSnapshot[] = this.roleBindings.get(p.namespace) ?? [];
    const roles: RoleSnapshot[] = this.roles.get(p.namespace) ?? [];
    const sa = p.user.split(':').pop();
    for (const b of bindings) {
      if (!b.subjects.some((s) => s.kind === 'ServiceAccount' && s.name === sa)) continue;
      if (b.roleRef.kind !== 'Role') continue;
      const role = roles.find((r) => r.name === b.roleRef.name);
      for (const rule of role?.rules ?? []) {
        const g = rule.apiGroups.includes('*') || rule.apiGroups.includes(p.apiGroup);
        const res = rule.resources.includes('*') || rule.resources.includes(p.resource);
        const v = rule.verbs.includes('*') || rule.verbs.includes(p.verb);
        const names = (rule as any).resourceNames as string[] | undefined;
        const n = !names || names.length === 0 || (p.name !== undefined && names.includes(p.name));
        if (g && res && v && n) return { allowed: true };
      }
    }
    return { allowed: false, reason: 'RBAC: no rule' };
  }
}

async function k8s012(verbs: string[]) {
  const l = await lab('K8S-012');
  const ms = await manifests(l);
  const dep = ms.find((m) => m.kind === 'Deployment')!;
  const k8s = new RbacNamespace({
    namespaces: ['default', NS],
    deployments: { [NS]: [healthy(dep, 1)] },
    configMaps: { [NS]: [{ name: 'inventory-config', namespace: NS, data: { refresh_seconds: '30', source: 'warehouse' } }] },
    serviceAccounts: { [NS]: [{ name: 'inventory-sync', namespace: NS, deleting: false }] },
    roles: {
      [NS]: [{ name: 'inventory-reader', namespace: NS, deleting: false, rules: [{ apiGroups: [''], resources: ['configmaps'], verbs }] }],
    },
    roleBindings: {
      [NS]: [
        {
          name: 'inventory-reader-binding',
          namespace: NS,
          deleting: false,
          roleRef: { kind: 'Role', name: 'inventory-reader', apiGroup: 'rbac.authorization.k8s.io' },
          subjects: [{ kind: 'ServiceAccount', name: 'inventory-sync' }],
        },
      ],
    },
  });
  return verifyLab({ lab: l, namespace: NS, k8s });
}

describe('K8S-012 — least privilege', () => {
  it('control: the exact grant passes', async () => {
    const r = await k8s012(['get', 'list', 'watch']);
    expect(failing(r)).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('control: verbs ["*"] is refused', async () => {
    const r = await k8s012(['*']);
    expect(r.passed).toBe(false);
  });

  it.each(['patch', 'create', 'deletecollection'])('refuses a Role that also grants %s on ConfigMaps', async (verb) => {
    // Before: passed. `patch` rewrites inventory-config exactly as `update`
    // does (kubectl edit/apply use it), and deletecollection deletes it.
    const r = await k8s012(['get', 'list', 'watch', verb]);
    expect(r.passed).toBe(false);
    expect(failing(r)).toHaveLength(1);
  });
});

describe('K8S-005 — the credential reaches the application container', () => {
  it('refuses a Secret reference that lives in a sidecar while the payments container reads nothing', async () => {
    // Before: passed.
    const l = await lab('K8S-005');
    const [seed] = await manifests(l);
    const d = structuredClone(seed!);
    const app = d.spec.template.spec.containers[0];
    delete app.env; // literal removed, nothing put back into the app container
    d.spec.template.spec.containers.push({
      name: 'token-holder',
      image: 'busybox:1.36',
      command: ['sleep', 'infinity'],
      env: [{ name: 'PAYMENTS_API_TOKEN', valueFrom: { secretKeyRef: { name: 'payments-api', key: 'api-token' } } }],
    });
    const k8s = new FakeKubernetes({
      namespaces: ['default', NS],
      deployments: { [NS]: [healthy(d, 2)] },
      secrets: { [NS]: [{ name: 'payments-api', namespace: NS, type: 'Opaque', keys: ['api-token'] }] },
    });
    const r = await verifyLab({ lab: l, namespace: NS, k8s });
    expect(failing(r)).toEqual([
      "Deployment payments reads the credential from the Secret: Secret 'payments-api' is referenced, but not by container 'payments'",
    ]);
  });

  it('passes the reference in the payments container itself', async () => {
    const l = await lab('K8S-005');
    const [seed] = await manifests(l);
    const d = structuredClone(seed!);
    d.spec.template.spec.containers[0].env = [
      { name: 'PAYMENTS_API_TOKEN', valueFrom: { secretKeyRef: { name: 'payments-api', key: 'api-token' } } },
    ];
    const k8s = new FakeKubernetes({
      namespaces: ['default', NS],
      deployments: { [NS]: [healthy(d, 2)] },
      secrets: { [NS]: [{ name: 'payments-api', namespace: NS, type: 'Opaque', keys: ['api-token'] }] },
    });
    expect(failing(await verifyLab({ lab: l, namespace: NS, k8s }))).toEqual([]);
  });
});

describe('K8S-018 — "Ready on every node the controller scheduled it to"', () => {
  const agent = (numberReady: number) => ({
    name: 'node-agent',
    namespace: NS,
    desiredScheduled: 3,
    numberReady,
    selector: { app: 'node-agent', tier: 'infrastructure' },
    containers: [{ name: 'agent', image: 'busybox:1.36', ready: true, restartCount: 0, state: 'running' }],
    deleting: false,
  });

  it('passes when every scheduled agent is Ready', async () => {
    const k8s = new FakeKubernetes({ namespaces: ['default', NS], daemonSets: { [NS]: [agent(3)] } } as never);
    expect(failing(await verifyLab({ lab: await lab('K8S-018'), namespace: NS, k8s }))).toEqual([]);
  });

  it('refuses 1 of 3 scheduled agents Ready (multi-node)', async () => {
    // Before: `min_ready: 1` passed it.
    const l = await lab('K8S-018');
    const k8s = new FakeKubernetes({
      namespaces: ['default', NS],
      daemonSets: {
        [NS]: [
          {
            name: 'node-agent',
            namespace: NS,
            desiredScheduled: 3,
            numberReady: 1,
            selector: { app: 'node-agent', tier: 'infrastructure' },
            containers: [{ name: 'agent', image: 'busybox:1.36', ready: true, restartCount: 0, state: 'running' }],
            deleting: false,
          },
        ],
      },
    });
    const r = await verifyLab({ lab: l, namespace: NS, k8s });
    expect(failing(r)).toEqual(['The agent is Ready on every node the controller scheduled it to: 1 of 3 scheduled Pod(s) ready']);
  });
});

describe('K8S-011 — mountPath spelling', () => {
  it('accepts mountPath "/data/", the same mount point as "/data"', async () => {
    // Before: refused by an exact string compare.
    const l = await lab('K8S-011');
    const [seed] = await manifests(l);
    const d = structuredClone(seed!);
    d.spec.template.spec.volumes = [{ name: 'data', persistentVolumeClaim: { claimName: 'ledger-data' } }];
    d.spec.template.spec.containers[0].volumeMounts = [{ name: 'data', mountPath: '/data/' }];
    const k8s = new FakeKubernetes({
      namespaces: ['default', NS],
      deployments: { [NS]: [healthy(d, 2)] },
      persistentVolumeClaims: {
        [NS]: [
          {
            name: 'ledger-data',
            namespace: NS,
            phase: 'Bound',
            accessModes: ['ReadWriteOnce'],
            storage: '1Gi',
            deleting: false,
          } as any,
        ],
      },
    });
    const r = await verifyLab({ lab: l, namespace: NS, k8s });
    expect(failing(r)).toEqual([]);

    // and the plain spelling still passes
    d.spec.template.spec.containers[0].volumeMounts = [{ name: 'data', mountPath: '/data' }];
    const ok = new FakeKubernetes({
      namespaces: ['default', NS],
      deployments: { [NS]: [healthy(d, 2)] },
      persistentVolumeClaims: k8s.persistentVolumeClaims.size ? Object.fromEntries(k8s.persistentVolumeClaims) : {},
    });
    const r2 = await verifyLab({ lab: l, namespace: NS, k8s: ok });
    expect(failing(r2)).toEqual([]);
  });
});

// Keep unused type imports referenced for strict TS configs.
export type _Unused = EndpointsSnapshot | PodSnapshot;
