/**
 * K8S-019 — StatefulSets, and the `service_headless` primitive.
 *
 * Two concerns, kept apart:
 *
 *   1. `service_headless` reads `spec.clusterIP` and nothing else. It exists
 *      because `service_type` cannot answer this question — a headless Service
 *      still reports type `ClusterIP` — so the two are not interchangeable.
 *   2. The lab has to grade one coherent workload. A lab this size is easy to
 *      satisfy with unrelated objects, so the tests below deliberately build
 *      decoys that pass individual checks and confirm the lab still fails.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  LabRegistry,
  type LoadedLabDefinition,
  type ServiceSnapshot,
  type StatefulSetSnapshot,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes, deploymentSnapshot, podSnapshot } from '@jumptotech/lab-orchestrator/testing';
import { verifyLab, verifyRequirement, VerifyReader } from '../src/index.js';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';

const NS = 'lab-00000000000a';
const NS_B = 'lab-00000000000b';
const IMAGE = 'nginx:1.28-alpine';

let registry: LabRegistry;
let lab: LoadedLabDefinition;

beforeAll(async () => {
  registry = await realCatalog();
  expect(registry.loadErrors).toEqual([]);
  lab = registry.get('K8S-019');
});

const service = (over: Partial<ServiceSnapshot> = {}): ServiceSnapshot => ({
  name: 'ledger-db',
  namespace: NS,
  type: 'ClusterIP',
  clusterIP: 'None',
  selector: { app: 'ledger-db' },
  ports: [{ name: 'db', port: 5432, targetPort: 'db', protocol: 'TCP' }],
  ...over,
});

const statefulSet = (over: Partial<StatefulSetSnapshot> = {}): StatefulSetSnapshot => ({
  name: 'ledger-db',
  namespace: NS,
  desiredReplicas: 2,
  readyReplicas: 2,
  serviceName: 'ledger-db',
  labels: {},
  selector: { app: 'ledger-db' },
  containers: [{ name: 'db', image: IMAGE, ready: true, restartCount: 0, state: 'running' }],
  volumeClaimTemplates: [
    { name: 'data', accessModes: ['ReadWriteOnce'], storage: '1Gi' },
  ],
  deleting: false,
  ...over,
});

/**
 * A solved namespace: headless Service, StatefulSet, and the Pods behind it.
 *
 * The fake derives a Service's endpoints from the *ready Pods in the namespace*
 * rather than from the selector, so `readyPods` is how endpoint count is
 * expressed here. That is a limit of the fake, not of the check: whether the
 * Service really selects those Pods is proved against a live cluster instead,
 * where the endpoints controller does the matching for real.
 */
const solved = (over: {
  svc?: Partial<ServiceSnapshot>;
  sts?: Partial<StatefulSetSnapshot>;
  readyPods?: number;
  extraDeployments?: ReturnType<typeof deploymentSnapshot>[];
  pvcNames?: string[];
} = {}) =>
  new FakeKubernetes({
    services: { [NS]: [service(over.svc)] },
    statefulSets: { [NS]: [statefulSet(over.sts)] },
    pods: {
      [NS]: Array.from({ length: over.readyPods ?? 2 }, (_, i) =>
        podSnapshot({ name: `ledger-db-${i}`, namespace: NS, labels: { app: 'ledger-db' }, ready: true }),
      ),
    },
    ...(over.extraDeployments ? { deployments: { [NS]: over.extraDeployments } } : {}),
    ...(over.pvcNames
      ? {
          persistentVolumeClaims: {
            [NS]: over.pvcNames.map((name) => ({
              name, namespace: NS, phase: 'Bound', accessModes: ['ReadWriteOnce'], deleting: false,
            })),
          },
        }
      : {}),
  });

const run = (k8s: FakeKubernetes, ns = NS) => verifyLab({ k8s, lab, namespace: ns });
const failed = async (k8s: FakeKubernetes, ns = NS) =>
  (await run(k8s, ns)).checks.filter((c) => c.status !== 'pass').map((c) => c.label);

// ------------------------------------------------------ service_headless only

describe('service_headless — reads spec.clusterIP, nothing else', () => {
  const check = (svc: Partial<ServiceSnapshot> | null, ns = NS) =>
    verifyRequirement(
      { type: 'service_headless', name: 'ledger-db' },
      new VerifyReader(
        new FakeKubernetes(svc ? { services: { [NS]: [service(svc)] } } : {}),
        ns,
      ),
    );

  it('passes when clusterIP is None', async () => {
    expect((await check({ clusterIP: 'None' })).status).toBe('pass');
  });

  it('fails a load-balanced Service and reports the IP it found', async () => {
    const result = await check({ clusterIP: '10.96.14.3' });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('10.96.14.3');
    expect(result.detail).toContain('not a headless one');
  });

  it('fails a Service with no clusterIP at all, such as ExternalName', async () => {
    const result = await check({ type: 'ExternalName', clusterIP: undefined });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('no clusterIP field');
  });

  it('is not the same question as service_type — a headless Service is still ClusterIP', async () => {
    /*
     * The reason this primitive had to exist. Both Services below report type
     * `ClusterIP`; only one is headless.
     */
    const k8s = new FakeKubernetes({
      services: {
        [NS]: [service({ name: 'headless', clusterIP: 'None' }), service({ name: 'normal', clusterIP: '10.96.0.9' })],
      },
    });
    const reader = new VerifyReader(k8s, NS);

    expect((await verifyRequirement({ type: 'service_type', name: 'normal', expected: 'ClusterIP' }, reader)).status).toBe('pass');
    expect((await verifyRequirement({ type: 'service_type', name: 'headless', expected: 'ClusterIP' }, reader)).status).toBe('pass');
    expect((await verifyRequirement({ type: 'service_headless', name: 'headless' }, reader)).status).toBe('pass');
    expect((await verifyRequirement({ type: 'service_headless', name: 'normal' }, reader)).status).toBe('fail');
  });

  it('fails safely on a missing Service and names the session namespace', async () => {
    const result = await check(null);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(NS);
  });

  it('is scoped to the session namespace', async () => {
    const k8s = new FakeKubernetes({ services: { [NS_B]: [service({ namespace: NS_B })] } });
    const mine = await verifyRequirement({ type: 'service_headless', name: 'ledger-db' }, new VerifyReader(k8s, NS));
    const theirs = await verifyRequirement({ type: 'service_headless', name: 'ledger-db' }, new VerifyReader(k8s, NS_B));

    expect(mine.status).toBe('fail');
    expect(theirs.status).toBe('pass');
  });
});

// ------------------------------------------------------------------- the lab

describe('K8S-019 — the shipped lab', () => {
  it('reuses the StatefulSet primitives and adds only service_headless', () => {
    expect(lab.id).toBe('K8S-019');
    expect(lab.level).toBe('challenge');
    expect(new Set(lab.requirements.map((r) => r.type))).toEqual(
      new Set([
        'statefulset_exists',
        'statefulset_image',
        'statefulset_replicas',
        'statefulset_service_name',
        'service_exists',
        'service_headless',
        'service_selector',
        'statefulset_volume_claim_template',
        'statefulset_ready',
        'service_endpoints',
        'resource_absent',
      ]),
    );
  });

  it('fails on the seeded fixture', async () => {
    const seeded = new FakeKubernetes({
      deployments: {
        [NS]: [
          deploymentSnapshot({
            name: 'ledger-db', namespace: NS,
            desiredReplicas: 2, readyReplicas: 1, availableReplicas: 1,
            selector: { app: 'ledger-db' }, podLabels: { app: 'ledger-db' },
            containers: [{ name: 'db', image: IMAGE, ready: true, restartCount: 0, state: 'running' }],
          }),
        ],
      },
      services: { [NS]: [service({ clusterIP: '10.96.0.21' })] },
      persistentVolumeClaims: {
        [NS]: [{ name: 'ledger-shared-data', namespace: NS, phase: 'Bound', accessModes: ['ReadWriteOnce'], deleting: false }],
      },
    });

    const problems = await failed(seeded);
    expect(problems).toContain('A StatefulSet named ledger-db exists');
    expect(problems).toContain('The governing Service is headless, so replicas get their own DNS names');
    expect(problems).toContain('The old ledger-db Deployment is gone');
    expect(problems).toContain('The shared claim that caused the conflict is gone');
  });

  it('passes on the intended architecture', async () => {
    expect((await run(solved())).passed).toBe(true);
  });

  it('fails a normal ClusterIP Service instead of a headless one', async () => {
    expect(await failed(solved({ svc: { clusterIP: '10.96.0.21' } }))).toEqual([
      'The governing Service is headless, so replicas get their own DNS names',
    ]);
  });

  it('fails a StatefulSet naming the wrong governing Service', async () => {
    expect(await failed(solved({ sts: { serviceName: 'ledger-db-headless' } }))).toEqual([
      'The StatefulSet names ledger-db as its governing Service',
    ]);
  });

  it('fails a wrong image and a wrong replica count', async () => {
    expect(
      await failed(solved({ sts: { containers: [{ name: 'db', image: 'postgres:16', ready: true, restartCount: 0, state: 'running' }] } })),
    ).toEqual(['The StatefulSet runs the ledger image']);

    expect(await failed(solved({ sts: { desiredReplicas: 3 } }))).toEqual(['Two replicas are requested']);
  });

  it('fails replicas that are not Ready', async () => {
    expect(await failed(solved({ sts: { readyReplicas: 1 }, readyPods: 1 }))).toEqual([
      'Both replicas are Ready',
      'The Service resolves to both ready replicas',
    ]);
  });

  it('fails a missing or wrong volumeClaimTemplate', async () => {
    expect(await failed(solved({ sts: { volumeClaimTemplates: [] } }))).toEqual([
      'Each replica gets its own 1Gi volume from a claim template',
    ]);
    expect(
      await failed(solved({ sts: { volumeClaimTemplates: [{ name: 'data', accessModes: ['ReadWriteOnce'], storage: '5Gi' }] } })),
    ).toEqual(['Each replica gets its own 1Gi volume from a claim template']);
    expect(
      await failed(solved({ sts: { volumeClaimTemplates: [{ name: 'storage', accessModes: ['ReadWriteOnce'], storage: '1Gi' }] } })),
    ).toEqual(['Each replica gets its own 1Gi volume from a claim template']);
  });

  it('fails when the old Deployment or shared claim is left behind', async () => {
    const leftovers = solved({
      extraDeployments: [deploymentSnapshot({ name: 'ledger-db', namespace: NS })],
      pvcNames: ['ledger-shared-data'],
    });
    expect(await failed(leftovers)).toEqual([
      'The old ledger-db Deployment is gone',
      'The shared claim that caused the conflict is gone',
    ]);
  });
});

// ------------------------------------------------------- decoys and coherence

describe('K8S-019 — unrelated objects cannot satisfy the checks together', () => {
  it('fails a correct headless Service with no StatefulSet behind it', async () => {
    const serviceOnly = new FakeKubernetes({ services: { [NS]: [service()] } });
    const problems = await failed(serviceOnly);

    expect(problems).toContain('A StatefulSet named ledger-db exists');
    expect(problems).toContain('The Service resolves to both ready replicas');
  });

  it('fails a correct StatefulSet with no governing Service', async () => {
    const stsOnly = new FakeKubernetes({ statefulSets: { [NS]: [statefulSet()] } });
    const problems = await failed(stsOnly);

    expect(problems).toContain('The governing Service exists');
    expect(problems).toContain('The governing Service is headless, so replicas get their own DNS names');
  });

  it('fails a decoy headless Service under another name', async () => {
    // `ledger-db-headless` is perfectly headless and completely irrelevant:
    // both the Service checks and the StatefulSet's serviceName name `ledger-db`.
    const decoy = new FakeKubernetes({
      services: { [NS]: [service({ name: 'ledger-db-headless' })] },
      statefulSets: { [NS]: [statefulSet({ serviceName: 'ledger-db-headless' })] },
    });
    const problems = await failed(decoy);

    expect(problems).toContain('The governing Service exists');
    expect(problems).toContain('The StatefulSet names ledger-db as its governing Service');
  });

  it('fails when the Service resolves to no ready backends', async () => {
    /*
     * The coherence check. Every name and field lines up, but nothing ready is
     * behind the Service — so the Service and the workload are not actually
     * connected, whatever the YAML says.
     *
     * The fake counts ready Pods in the namespace rather than applying the
     * selector, so a genuine selector mismatch is proved against a live
     * cluster, where the endpoints controller does the matching itself.
     */
    expect(await failed(solved({ readyPods: 0 }))).toEqual([
      'The Service resolves to both ready replicas',
    ]);
  });

  it('fails a Service selecting something else entirely', async () => {
    expect(await failed(solved({ svc: { selector: { app: 'something-else' } } }))).toEqual([
      'The Service selects the ledger-db Pods',
    ]);
  });

  it('does not pass on another session"s solved namespace', async () => {
    const mine = solved();
    const theirs = new FakeKubernetes({
      services: { [NS_B]: [service({ namespace: NS_B })] },
      statefulSets: { [NS_B]: [statefulSet({ namespace: NS_B })] },
      pods: {
        [NS_B]: [0, 1].map((i) =>
          podSnapshot({ name: `ledger-db-${i}`, namespace: NS_B, labels: { app: 'ledger-db' }, ready: true }),
        ),
      },
    });

    expect((await run(mine)).passed).toBe(true);
    expect((await run(theirs, NS)).passed).toBe(false);
    expect((await run(theirs, NS_B)).passed).toBe(true);
  });
});
