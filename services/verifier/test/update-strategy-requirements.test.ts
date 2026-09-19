/**
 * K8S-015 — update strategy, and the `deployment_strategy` primitive.
 *
 * The primitive compares meaning rather than text: a bound is graded by the
 * number of Pods it allows at the Deployment's replica count, resolved the
 * way the controller resolves it (maxSurge rounds up, maxUnavailable down).
 * `maxSurge: 1`, `"1"` and — at 4 replicas — `"25%"` are one instruction; `1`
 * and `"1%"` agree only when the replica count makes them allow the same
 * Pods. Nothing here inspects YAML: every fixture is a snapshot of the object
 * as the API server stores it, which is the only thing the verifier sees.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { LabRegistry, requirementSchema, type LoadedLabDefinition } from '@jumptotech/lab-orchestrator';
import { FakeKubernetes, deploymentSnapshot } from '@jumptotech/lab-orchestrator/testing';
import { verifyLab, verifyRequirement, VerifyReader } from '../src/index.js';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';

const NS = 'lab-00000000000a';
const NS_B = 'lab-00000000000b';
const OLD = 'nginx:1.27-alpine';
const NEW = 'nginx:1.28-alpine';

let registry: LabRegistry;
let lab: LoadedLabDefinition;

beforeAll(async () => {
  registry = await realCatalog();
  expect(registry.loadErrors).toEqual([]);
  lab = registry.get('K8S-015');
});

type Strategy = { type: string; maxSurge?: number | string; maxUnavailable?: number | string };

/** A Deployment carrying one strategy, for exercising the primitive alone. */
const withStrategy = (strategy: Strategy | undefined, name = 'checkout-api', replicas = 4) =>
  new FakeKubernetes({
    deployments: {
      [NS]: [
        deploymentSnapshot({
          name,
          namespace: NS,
          desiredReplicas: replicas,
          ...(strategy ? { strategy } : { strategy: undefined }),
        }),
      ],
    },
  });

const strategyCheck = (
  k8s: FakeKubernetes,
  requirement: Record<string, unknown>,
  ns = NS,
) => verifyRequirement({ type: 'deployment_strategy', ...requirement } as never, new VerifyReader(k8s, ns));

// -------------------------------------------------------------- the primitive

describe('deployment_strategy — strategy type', () => {
  it('matches RollingUpdate and Recreate', async () => {
    const rolling = withStrategy({ type: 'RollingUpdate', maxSurge: '25%', maxUnavailable: '25%' });
    const recreate = withStrategy({ type: 'Recreate' });

    expect((await strategyCheck(rolling, { name: 'checkout-api', strategy: 'RollingUpdate' })).status).toBe('pass');
    expect((await strategyCheck(recreate, { name: 'checkout-api', strategy: 'Recreate' })).status).toBe('pass');
  });

  it('fails when the type is the other one, and says which', async () => {
    const recreate = withStrategy({ type: 'Recreate' });
    const result = await strategyCheck(recreate, { name: 'checkout-api', strategy: 'RollingUpdate' });

    expect(result.status).toBe('fail');
    expect(result.detail).toContain("'Recreate'");
  });

  it('treats an absent strategy as RollingUpdate, which is the API default', async () => {
    // A live object always carries a strategy; a reader that has not populated
    // one must not be reported as Recreate.
    const bare = withStrategy(undefined);
    expect((await strategyCheck(bare, { name: 'checkout-api', strategy: 'RollingUpdate' })).status).toBe('pass');
    expect((await strategyCheck(bare, { name: 'checkout-api', strategy: 'Recreate' })).status).toBe('fail');
  });

  it('fails on a Deployment that does not exist, naming the session namespace', async () => {
    const result = await strategyCheck(withStrategy({ type: 'Recreate' }), {
      name: 'nope',
      strategy: 'Recreate',
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(NS);
  });
});

describe('deployment_strategy — maxSurge and maxUnavailable', () => {
  const rolling = (maxSurge: number | string, maxUnavailable: number | string) =>
    withStrategy({ type: 'RollingUpdate', maxSurge, maxUnavailable });

  it('accepts correct integer values', async () => {
    const result = await strategyCheck(rolling(1, 0), {
      name: 'checkout-api',
      strategy: 'RollingUpdate',
      maxSurge: 1,
      maxUnavailable: 0,
    });
    expect(result.status).toBe('pass');
  });

  it('accepts correct percentage values', async () => {
    const result = await strategyCheck(rolling('25%', '50%'), {
      name: 'checkout-api',
      strategy: 'RollingUpdate',
      maxSurge: '25%',
      maxUnavailable: '50%',
    });
    expect(result.status).toBe('pass');
  });

  it('rejects an incorrect maxSurge', async () => {
    const result = await strategyCheck(rolling(2, 0), {
      name: 'checkout-api',
      strategy: 'RollingUpdate',
      maxSurge: 1,
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('maxSurge is 2');
  });

  it('rejects an incorrect maxUnavailable', async () => {
    const result = await strategyCheck(rolling(1, 1), {
      name: 'checkout-api',
      strategy: 'RollingUpdate',
      maxUnavailable: 0,
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('maxUnavailable is 1');
  });

  it('reports both bounds when both are wrong', async () => {
    const result = await strategyCheck(rolling('50%', '50%'), {
      name: 'checkout-api',
      strategy: 'RollingUpdate',
      maxSurge: 1,
      maxUnavailable: 0,
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('maxSurge');
    expect(result.detail).toContain('maxUnavailable');
  });

  it('compares the Pods a bound allows, rounding the way the controller does', async () => {
    const at = (replicas: number, maxSurge: number | string, maxUnavailable: number | string) =>
      new FakeKubernetes({
        deployments: {
          [NS]: [
            deploymentSnapshot({
              name: 'checkout-api',
              namespace: NS,
              desiredReplicas: replicas,
              strategy: { type: 'RollingUpdate', maxSurge, maxUnavailable },
            }),
          ],
        },
      });
    const want = { name: 'checkout-api', strategy: 'RollingUpdate', maxSurge: 1, maxUnavailable: 0 };
    // 25% of 3: surge ceil(0.75) = 1, unavailable floor(0.75) = 0 — the same rollout.
    expect((await strategyCheck(at(3, '25%', '25%'), want)).status).toBe('pass');
    // 25% of 4: unavailable floor(1) = 1 — one Pod may go down.
    expect((await strategyCheck(at(4, '25%', '25%'), want)).status).toBe('fail');
    expect((await strategyCheck(at(4, '25%', '0%'), want)).status).toBe('pass');
    // 1% still rounds up to a whole Pod of surge; 50% of 4 is two.
    expect((await strategyCheck(at(4, '1%', 0), want)).status).toBe('pass');
    expect((await strategyCheck(at(4, '50%', 0), want)).status).toBe('fail');
  });

  it('never prints the bound it wants, and shows what a percentage resolves to', async () => {
    const result = await strategyCheck(rolling('25%', '25%'), {
      name: 'checkout-api',
      strategy: 'RollingUpdate',
      maxSurge: 1,
      maxUnavailable: 0,
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('maxUnavailable is 25% (1 of 4 Pods)');
    expect(result.detail).not.toContain('expected');
    expect(result.detail).not.toMatch(/maxUnavailable[^;]*\b0\b/);
  });

  it('agrees across equivalent spellings of the same value', async () => {
    /*
     * IntOrString round-trips differently depending on how the manifest was
     * written — `maxSurge: 1` arrives as a number, `maxSurge: "1"` as a string.
     * Both mean one Pod, so both must satisfy either spelling of the
     * requirement. This is the "different YAML formatting" case.
     */
    for (const observed of [1, '1'] as const) {
      for (const expected of [1, '1'] as const) {
        const result = await strategyCheck(rolling(observed, 0), {
          name: 'checkout-api',
          strategy: 'RollingUpdate',
          maxSurge: expected,
        });
        expect(result.status, `observed ${JSON.stringify(observed)} vs expected ${JSON.stringify(expected)}`).toBe('pass');
      }
    }
  });

  it('fails safely when the rolling update bounds are missing entirely', async () => {
    const noBounds = withStrategy({ type: 'RollingUpdate' });
    const result = await strategyCheck(noBounds, {
      name: 'checkout-api',
      strategy: 'RollingUpdate',
      maxSurge: 1,
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('unset');
  });

  it('fails safely on a malformed stored value', async () => {
    for (const junk of ['', 'lots', '25 %', '-1', '1.5']) {
      const result = await strategyCheck(withStrategy({ type: 'RollingUpdate', maxSurge: junk }), {
        name: 'checkout-api',
        strategy: 'RollingUpdate',
        maxSurge: 1,
      });
      expect(result.status, `junk ${JSON.stringify(junk)}`).toBe('fail');
    }
  });

  it('refuses at schema level to ask Recreate for rolling bounds', async () => {
    const parsed = requirementSchema.safeParse({
      type: 'deployment_strategy',
      name: 'ledger-writer',
      strategy: 'Recreate',
      maxSurge: 1,
      label: 'x',
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses malformed expected values at schema level', async () => {
    for (const bad of ['25', 'half', '25%%', -1, 1.5, '%25']) {
      const parsed = requirementSchema.safeParse({
        type: 'deployment_strategy',
        name: 'checkout-api',
        strategy: 'RollingUpdate',
        maxSurge: bad,
        label: 'x',
      });
      expect(parsed.success, `bad ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

// ------------------------------------------------------------------- the lab

// The Deployment controller's revision: 1 once the fixture is applied, 2 after
// a template change rolls out in place.
const REVISION_1 = { 'deployment.kubernetes.io/revision': '1' };
const REVISION_2 = { 'deployment.kubernetes.io/revision': '2' };

describe('K8S-015 — the shipped lab', () => {
  /** Both workloads exactly as the fixture leaves them: default strategy, old image. */
  function seeded(overrides: { ledger?: Partial<Parameters<typeof deploymentSnapshot>[0]>; checkout?: Partial<Parameters<typeof deploymentSnapshot>[0]> } = {}) {
    const defaultStrategy = { type: 'RollingUpdate', maxSurge: '25%', maxUnavailable: '25%' };
    return new FakeKubernetes({
      deployments: {
        [NS]: [
          deploymentSnapshot({
            name: 'ledger-writer',
            namespace: NS,
            desiredReplicas: 2,
            readyReplicas: 2,
            availableReplicas: 2,
            updatedReplicas: 2,
            currentReplicas: 2,
            selector: { app: 'ledger-writer', tier: 'data' },
            podLabels: { app: 'ledger-writer', tier: 'data' },
            strategy: defaultStrategy,
            containers: [{ name: 'writer', image: OLD, ready: true, restartCount: 0, state: 'running' }],
            annotations: REVISION_1,
            ...overrides.ledger,
          }),
          deploymentSnapshot({
            name: 'checkout-api',
            namespace: NS,
            desiredReplicas: 4,
            readyReplicas: 4,
            availableReplicas: 4,
            updatedReplicas: 4,
            currentReplicas: 4,
            selector: { app: 'checkout-api', tier: 'api' },
            podLabels: { app: 'checkout-api', tier: 'api' },
            strategy: defaultStrategy,
            containers: [{ name: 'api', image: OLD, ready: true, restartCount: 0, state: 'running' }],
            annotations: REVISION_1,
            ...overrides.checkout,
          }),
        ],
      },
    });
  }

  const solved = (over: Parameters<typeof seeded>[0] = {}) =>
    seeded({
      ledger: {
        strategy: { type: 'Recreate' },
        containers: [{ name: 'writer', image: NEW, ready: true, restartCount: 0, state: 'running' }],
        annotations: REVISION_2,
        ...over.ledger,
      },
      checkout: {
        strategy: { type: 'RollingUpdate', maxSurge: 1, maxUnavailable: 0 },
        containers: [{ name: 'api', image: NEW, ready: true, restartCount: 0, state: 'running' }],
        annotations: REVISION_2,
        ...over.checkout,
      },
    });

  const run = (k8s: FakeKubernetes, ns = NS) => verifyLab({ k8s, lab, namespace: ns });
  const failed = async (k8s: FakeKubernetes, ns = NS) =>
    (await run(k8s, ns)).checks.filter((c) => c.status !== 'pass').map((c) => c.label);

  it('asks only for implemented requirement types', () => {
    expect(lab.id).toBe('K8S-015');
    expect(new Set(lab.requirements.map((r) => r.type))).toEqual(
      new Set([
        'deployment_exists',
        'deployment_selector',
        'workload_annotation',
        'deployment_strategy',
        'deployment_image',
        'deployment_available',
        'deployment_rollout_complete',
      ]),
    );
  });

  it('fails on the untouched fixture, on strategy and image for both services', async () => {
    expect(await failed(seeded())).toEqual([
      'ledger-writer was reconfigured, not replaced',
      'ledger-writer never runs two versions at once',
      'ledger-writer was released to nginx:1.28-alpine',
      'checkout-api was reconfigured, not replaced',
      'checkout-api keeps every replica serving and adds at most one',
      'checkout-api was released to nginx:1.28-alpine',
    ]);
  });

  it('passes once both services are configured and released', async () => {
    expect((await run(solved())).passed).toBe(true);
  });

  it('fails when the two strategies are swapped', async () => {
    // The trap for a student who changes one and copies it to the other.
    const swapped = solved({
      ledger: { strategy: { type: 'RollingUpdate', maxSurge: 1, maxUnavailable: 0 } },
      checkout: { strategy: { type: 'Recreate' } },
    });
    const problems = await failed(swapped);

    expect(problems).toContain('ledger-writer never runs two versions at once');
    expect(problems).toContain('checkout-api keeps every replica serving and adds at most one');
  });

  it('passes percentages that allow exactly the same Pods — the rollout is identical', async () => {
    // 25% of 4 replicas is a surge of one Pod; 0% is none unavailable.
    for (const strategy of [
      { type: 'RollingUpdate', maxSurge: '25%', maxUnavailable: '0%' },
      { type: 'RollingUpdate', maxSurge: '25%', maxUnavailable: 0 },
    ]) {
      expect(await failed(solved({ checkout: { strategy } })), JSON.stringify(strategy)).toEqual([]);
    }
  });

  it('fails a percentage that allows more than the constraint', async () => {
    // 50% of 4 replicas is a surge of two.
    const percentage = solved({
      checkout: { strategy: { type: 'RollingUpdate', maxSurge: '50%', maxUnavailable: 0 } },
    });
    expect(await failed(percentage)).toEqual(['checkout-api keeps every replica serving and adds at most one']);
  });

  it('fails the API default on checkout-api: 25% of four replicas lets one Pod go down', async () => {
    const untouched = solved({ checkout: { strategy: { type: 'RollingUpdate', maxSurge: '25%', maxUnavailable: '25%' } } });
    expect(await failed(untouched)).toEqual(['checkout-api keeps every replica serving and adds at most one']);
  });

  it('never names the strategy or bounds a Deployment needs on the first Check', async () => {
    const checks = (await run(seeded())).checks.filter((c) => c.label.includes('never runs two') || c.label.includes('keeps every replica'));
    expect(checks).toHaveLength(2);
    const text = checks.map((c) => c.detail ?? '').join('\n');
    expect(text).not.toContain('Recreate');
    expect(text).not.toContain('expected');
  });

  it('fails maxUnavailable left at the default even with the right type', async () => {
    const lazy = solved({
      checkout: { strategy: { type: 'RollingUpdate', maxSurge: 1, maxUnavailable: '25%' } },
    });
    expect(await failed(lazy)).toEqual(['checkout-api keeps every replica serving and adds at most one']);
  });

  it('fails a strategy change that was never released', async () => {
    const configuredOnly = seeded({
      ledger: { strategy: { type: 'Recreate' } },
      checkout: { strategy: { type: 'RollingUpdate', maxSurge: 1, maxUnavailable: 0 } },
    });
    // The strategy is not part of the Pod template, so changing it alone rolls
    // out no new revision: nothing has been released yet.
    expect(await failed(configuredOnly)).toEqual([
      'ledger-writer was reconfigured, not replaced',
      'ledger-writer was released to nginx:1.28-alpine',
      'checkout-api was reconfigured, not replaced',
      'checkout-api was released to nginx:1.28-alpine',
    ]);
  });

  it('still refuses a deleted-and-recreated Deployment', async () => {
    const recreated = solved({
      checkout: { selector: { app: 'checkout-api' }, podLabels: { app: 'checkout-api' }, annotations: REVISION_1 },
    });
    expect(await failed(recreated)).toEqual([
      'checkout-api still selects its own Pods',
      'checkout-api was reconfigured, not replaced',
    ]);
  });

  it('refuses a Deployment re-created from the fixture with the right settings', async () => {
    // Same labels, same strategy, same image — and back at revision 1.
    const reapplied = solved({ ledger: { annotations: REVISION_1 } });
    expect(await failed(reapplied)).toEqual(['ledger-writer was reconfigured, not replaced']);
  });

  it('fails mid-rollout rather than on configuration alone', async () => {
    const midway = solved({ checkout: { updatedReplicas: 1, currentReplicas: 3, availableReplicas: 2, readyReplicas: 2 } });
    const problems = await failed(midway);

    expect(problems).toContain('The checkout-api rollout finished');
    expect(problems).toContain('All four checkout-api replicas are available');
  });

  it('does not pass on another session"s solved namespace', async () => {
    const mine = solved();
    const theirs = new FakeKubernetes({
      deployments: { [NS_B]: (mine.deployments.get(NS) ?? []).map((d) => ({ ...d, namespace: NS_B })) },
    });

    expect((await run(theirs, NS)).passed).toBe(false);
    expect((await run(theirs, NS_B)).passed).toBe(true);
  });
});
