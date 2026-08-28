/**
 * K8S-014 — rollback, and the `workload_annotation` primitive it needed.
 *
 * Two things are under test and they are worth keeping distinct:
 *
 *   1. The primitive. It is generic — kind, name, key, and either an exact
 *      value or a numeric floor — and it must be safe to point at any workload
 *      a lab names. The security properties (no namespace parameter, no API
 *      traversal, no secret spillage in failure text) are asserted here rather
 *      than asserted in prose.
 *   2. The lab. A rollback returns a workload to where it started, so the end
 *      state of a correct solution resembles an untouched namespace. The
 *      revision annotation is what separates them, and the first test below is
 *      the one that matters: doing nothing must fail.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { LabRegistry, type LoadedLabDefinition } from '@jumptotech/lab-orchestrator';
import { FakeKubernetes, deploymentSnapshot } from '@jumptotech/lab-orchestrator/testing';
import { verifyLab, verifyRequirement, VerifyReader } from '../src/index.js';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';

const NS = 'lab-00000000000a';
const NS_B = 'lab-00000000000b';

const GOOD = 'nginx:1.28-alpine';
const BAD = 'nginx:1.29-rc1-jumptotech';
const SELECTOR = { app: 'payments-api', tier: 'api' };
const REVISION = 'deployment.kubernetes.io/revision';

let registry: LabRegistry;
let lab: LoadedLabDefinition;

beforeAll(async () => {
  registry = await realCatalog();
  expect(registry.loadErrors).toEqual([]);
  lab = registry.get('K8S-014');
});

/** The Deployment exactly as the setup manifest leaves it: healthy, revision 1. */
function seeded(overrides: Parameters<typeof deploymentSnapshot>[0] = {}) {
  return deploymentSnapshot({
    name: 'payments-api',
    namespace: NS,
    desiredReplicas: 3,
    readyReplicas: 3,
    availableReplicas: 3,
    updatedReplicas: 3,
    currentReplicas: 3,
    selector: SELECTOR,
    podLabels: SELECTOR,
    annotations: { [REVISION]: '1' },
    containers: [{ name: 'api', image: GOOD, ready: true, restartCount: 0, state: 'running' }],
    ...overrides,
  });
}

/** After a roll-forward into the broken tag and a `rollout undo` back. */
const rolledBack = (overrides: Parameters<typeof deploymentSnapshot>[0] = {}) =>
  seeded({ annotations: { [REVISION]: '3' }, generation: 3, observedGeneration: 3, ...overrides });

const clusterWith = (...d: ReturnType<typeof deploymentSnapshot>[]) =>
  new FakeKubernetes({ deployments: { [NS]: d } });

const run = (k8s: FakeKubernetes, namespace = NS) => verifyLab({ k8s, lab, namespace });

async function failures(k8s: FakeKubernetes, namespace = NS): Promise<string[]> {
  const result = await run(k8s, namespace);
  return result.checks.filter((c) => c.status !== 'pass').map((c) => c.label);
}

const check = (k8s: FakeKubernetes, requirement: Parameters<typeof verifyRequirement>[0], ns = NS) =>
  verifyRequirement(requirement, new VerifyReader(k8s, ns));

// ------------------------------------------------------------------ the lab

describe('K8S-014 — the shipped lab', () => {
  it('loads and asks only for implemented requirement types', () => {
    expect(lab.id).toBe('K8S-014');
    expect(lab.level).toBe('challenge');
    expect(lab.prerequisites).toEqual(['K8S-013']);
    expect(lab.requirements.map((r) => r.type)).toEqual([
      'deployment_exists',
      'deployment_selector',
      'deployment_replicas',
      'workload_annotation',
      'deployment_image',
      'deployment_rollout_complete',
      'deployment_available',
    ]);
  });

  it('FAILS on an untouched namespace — the test this lab exists for', async () => {
    /*
     * The seeded state already has the correct image, replica count and
     * availability, because a rollback ends where it began. Only the revision
     * separates "recovered" from "never touched", so exactly one check may
     * fail here — and it must be that one.
     */
    expect(await failures(clusterWith(seeded()))).toEqual([
      'A new revision was rolled out and then rolled back',
    ]);
  });

  it('passes once the workload has gone out and come back', async () => {
    const result = await run(clusterWith(rolledBack()));
    expect(result.passed).toBe(true);
  });

  it('accepts a higher revision, so a second attempt is not punished', async () => {
    // A student who fumbles and rolls twice lands on revision 4. Still correct.
    expect((await run(clusterWith(rolledBack({ annotations: { [REVISION]: '4' } })))).passed).toBe(true);
  });

  it('fails while still stuck on the broken release', async () => {
    const stuck = rolledBack({
      annotations: { [REVISION]: '2' },
      containers: [{ name: 'api', image: BAD, ready: false, restartCount: 0, state: 'waiting' }],
      updatedReplicas: 1,
      currentReplicas: 3,
      availableReplicas: 0,
      readyReplicas: 0,
    });

    const failed = await failures(clusterWith(stuck));
    expect(failed).toContain('Image is back on nginx:1.28-alpine');
    expect(failed).toContain('A new revision was rolled out and then rolled back');
    expect(failed).toContain('All three replicas are available again');
  });

  it('fails an image hand-edited back without any rollout having happened', async () => {
    // Right image, right everything — but revision 1 says nothing ever rolled.
    expect(await failures(clusterWith(seeded({ generation: 1, observedGeneration: 1 })))).toEqual([
      'A new revision was rolled out and then rolled back',
    ]);
  });

  it('still refuses a deleted-and-recreated Deployment', async () => {
    const recreated = rolledBack({ selector: { app: 'payments-api' }, podLabels: { app: 'payments-api' } });
    expect(await failures(clusterWith(recreated))).toEqual([
      'The original Deployment was recovered, not replaced',
    ]);
  });

  it('does not pass on another session"s recovered namespace', async () => {
    const k8s = new FakeKubernetes({
      deployments: { [NS_B]: [rolledBack({ namespace: NS_B })] },
    });

    expect((await run(k8s, NS)).passed).toBe(false);
    expect((await run(k8s, NS_B)).passed).toBe(true);
  });
});

// ------------------------------------------------- the primitive, generically

describe('workload_annotation — semantics', () => {
  const withAnnotations = (annotations: Record<string, string>) =>
    clusterWith(seeded({ annotations }));

  it('matches an exact value', async () => {
    const k8s = withAnnotations({ 'jumptotech.io/owner': 'payments-team' });
    const ok = await check(k8s, {
      type: 'workload_annotation',
      kind: 'deployment',
      name: 'payments-api',
      key: 'jumptotech.io/owner',
      value: 'payments-team',
    });
    expect(ok.status).toBe('pass');
  });

  it('fails a wrong value, and says what it found', async () => {
    const k8s = withAnnotations({ 'jumptotech.io/owner': 'platform-team' });
    const bad = await check(k8s, {
      type: 'workload_annotation',
      kind: 'deployment',
      name: 'payments-api',
      key: 'jumptotech.io/owner',
      value: 'payments-team',
    });
    expect(bad.status).toBe('fail');
    expect(bad.detail).toContain('platform-team');
  });

  it('fails a wrong key rather than matching some other annotation', async () => {
    const k8s = withAnnotations({ 'jumptotech.io/owner': 'payments-team' });
    const wrongKey = await check(k8s, {
      type: 'workload_annotation',
      kind: 'deployment',
      name: 'payments-api',
      key: 'jumptotech.io/team',
      value: 'payments-team',
    });
    expect(wrongKey.status).toBe('fail');
    expect(wrongKey.detail).toContain('no');
  });

  it('fails on a workload that does not exist, naming the session namespace', async () => {
    const missing = await check(clusterWith(seeded()), {
      type: 'workload_annotation',
      kind: 'deployment',
      name: 'does-not-exist',
      key: REVISION,
      min_int: 1,
    });
    expect(missing.status).toBe('fail');
    expect(missing.detail).toContain(NS);
  });

  it('fails on the right annotation attached to the wrong workload', async () => {
    const k8s = new FakeKubernetes({
      deployments: {
        [NS]: [
          seeded({ name: 'payments-api', annotations: {} }),
          seeded({ name: 'other-api', annotations: { [REVISION]: '9' } }),
        ],
      },
    });
    const result = await check(k8s, {
      type: 'workload_annotation',
      kind: 'deployment',
      name: 'payments-api',
      key: REVISION,
      min_int: 3,
    });
    expect(result.status).toBe('fail');
  });

  it('compares numerically, not lexically', async () => {
    // '10' > '9' as a number but '10' < '9' as a string. The floor is numeric.
    const k8s = withAnnotations({ [REVISION]: '10' });
    const result = await check(k8s, {
      type: 'workload_annotation',
      kind: 'deployment',
      name: 'payments-api',
      key: REVISION,
      min_int: 9,
    });
    expect(result.status).toBe('pass');
  });

  it('fails safely on a non-numeric value under min_int', async () => {
    for (const value of ['', '   ', 'three', '3.5', 'Infinity', '0x3', 'NaN']) {
      const result = await check(withAnnotations({ [REVISION]: value }), {
        type: 'workload_annotation',
        kind: 'deployment',
        name: 'payments-api',
        key: REVISION,
        min_int: 3,
      });
      expect(result.status, `value ${JSON.stringify(value)}`).toBe('fail');
      expect(result.detail).toContain('not a whole number');
    }
  });

  it('reads statefulsets and daemonsets through the same primitive', async () => {
    const k8s = new FakeKubernetes({
      statefulSets: {
        [NS]: [
          {
            name: 'ledger-db',
            namespace: NS,
            desiredReplicas: 1,
            readyReplicas: 1,
            labels: {},
            selector: {},
            containers: [],
            volumeClaimTemplates: [],
            deleting: false,
            annotations: { 'jumptotech.io/owner': 'data-team' },
          },
        ],
      },
      daemonSets: {
        [NS]: [
          {
            name: 'log-agent',
            namespace: NS,
            desiredScheduled: 1,
            numberReady: 1,
            selector: {},
            containers: [],
            deleting: false,
            annotations: { 'jumptotech.io/owner': 'ops-team' },
          },
        ],
      },
    });

    expect(
      (await check(k8s, { type: 'workload_annotation', kind: 'statefulset', name: 'ledger-db', key: 'jumptotech.io/owner', value: 'data-team' })).status,
    ).toBe('pass');
    expect(
      (await check(k8s, { type: 'workload_annotation', kind: 'daemonset', name: 'log-agent', key: 'jumptotech.io/owner', value: 'ops-team' })).status,
    ).toBe('pass');
  });
});

// --------------------------------------------------- the primitive's security

describe('workload_annotation — security properties', () => {
  it('cannot be pointed at another session, because there is no namespace field', async () => {
    /*
     * The strongest statement available: the schema is `.strict()`, so a lab
     * that tries to name a namespace is rejected at load time rather than
     * quietly honoured. Reads are bound to the reader's namespace and there is
     * no other way in.
     */
    const { requirementSchema } = await import('@jumptotech/lab-orchestrator');
    const withNamespace = requirementSchema.safeParse({
      type: 'workload_annotation',
      kind: 'deployment',
      name: 'payments-api',
      namespace: NS_B,
      key: REVISION,
      min_int: 3,
      label: 'x',
    });
    expect(withNamespace.success).toBe(false);
  });

  it('reads only the session it was given, even when a neighbour matches', async () => {
    const k8s = new FakeKubernetes({
      deployments: {
        [NS]: [seeded({ annotations: { [REVISION]: '1' } })],
        [NS_B]: [seeded({ namespace: NS_B, annotations: { [REVISION]: '9' } })],
      },
    });
    const requirement = {
      type: 'workload_annotation' as const,
      kind: 'deployment' as const,
      name: 'payments-api',
      key: REVISION,
      min_int: 3,
    };

    expect((await check(k8s, requirement, NS)).status).toBe('fail');
    expect((await check(k8s, requirement, NS_B)).status).toBe('pass');
  });

  it('rejects a kind outside the closed workload set, so it is not API traversal', async () => {
    const { requirementSchema } = await import('@jumptotech/lab-orchestrator');
    for (const kind of ['secret', 'configmap', 'namespace', 'node', 'pod']) {
      const parsed = requirementSchema.safeParse({
        type: 'workload_annotation',
        kind,
        name: 'x',
        key: 'k',
        value: 'v',
        label: 'x',
      });
      expect(parsed.success, kind).toBe(false);
    }
  });

  it('requires exactly one of value or min_int', async () => {
    const { requirementSchema } = await import('@jumptotech/lab-orchestrator');
    const base = { type: 'workload_annotation', kind: 'deployment', name: 'x', key: 'k', label: 'l' };

    expect(requirementSchema.safeParse(base).success).toBe(false);
    expect(requirementSchema.safeParse({ ...base, value: 'v', min_int: 1 }).success).toBe(false);
    expect(requirementSchema.safeParse({ ...base, value: 'v' }).success).toBe(true);
    expect(requirementSchema.safeParse({ ...base, min_int: 1 }).success).toBe(true);
  });

  it('truncates a long observed value instead of dumping it', async () => {
    /*
     * Annotations are a general-purpose store — `last-applied-configuration`
     * holds an entire object, environment variables included. A failure message
     * has to stay debuggable without becoming an exfiltration channel.
     */
    const secretish = `SUPERSECRET-${'x'.repeat(500)}-TRAILER`;
    const result = await check(clusterWith(seeded({ annotations: { 'jumptotech.io/blob': secretish } })), {
      type: 'workload_annotation',
      kind: 'deployment',
      name: 'payments-api',
      key: 'jumptotech.io/blob',
      value: 'expected',
    });

    expect(result.status).toBe('fail');
    expect(result.detail!.length).toBeLessThan(200);
    expect(result.detail).toContain('truncated');
    expect(result.detail).not.toContain('TRAILER');
  });

  it('never echoes an annotation the requirement did not name', async () => {
    const result = await check(
      clusterWith(
        seeded({
          annotations: {
            'jumptotech.io/owner': 'payments-team',
            'kubectl.kubernetes.io/last-applied-configuration': '{"env":[{"name":"DB_PASSWORD","value":"hunter2"}]}',
          },
        }),
      ),
      {
        type: 'workload_annotation',
        kind: 'deployment',
        name: 'payments-api',
        key: 'jumptotech.io/owner',
        value: 'platform-team',
      },
    );

    expect(result.status).toBe('fail');
    expect(result.detail).not.toContain('hunter2');
    expect(result.detail).not.toContain('last-applied-configuration');
  });

  it('does not echo a non-numeric value, which is the likeliest blob', async () => {
    const result = await check(
      clusterWith(seeded({ annotations: { [REVISION]: 'DB_PASSWORD=hunter2' } })),
      { type: 'workload_annotation', kind: 'deployment', name: 'payments-api', key: REVISION, min_int: 3 },
    );

    expect(result.status).toBe('fail');
    expect(result.detail).not.toContain('hunter2');
  });
});
