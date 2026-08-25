/**
 * K8S-015 — update strategy, and the `deployment_strategy` primitive.
 *
 * The primitive compares meaning rather than text. `maxSurge: 1` and
 * `maxSurge: "1"` are the same instruction written two ways and must agree;
 * `1` and `"1%"` are different instructions — one Pod versus one percent of
 * replicas — and must not. Nothing here inspects YAML: every fixture is a
 * snapshot of the object as the API server stores it, which is the only thing
 * the verifier ever sees.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LabRegistry, requirementSchema, type LoadedLabDefinition } from '@jumptotech/lab-orchestrator';
import { FakeKubernetes, deploymentSnapshot } from '@jumptotech/lab-orchestrator/testing';
import { verifyLab, verifyRequirement, VerifyReader } from '../src/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NS = 'lab-00000000000a';
const NS_B = 'lab-00000000000b';
const OLD = 'nginx:1.27-alpine';
const NEW = 'nginx:1.28-alpine';

let registry: LabRegistry;
let lab: LoadedLabDefinition;

beforeAll(async () => {
  registry = new LabRegistry(path.join(repoRoot, 'labs'));
  await registry.load();
  expect(registry.loadErrors).toEqual([]);
  lab = registry.get('K8S-015');
});

type Strategy = { type: string; maxSurge?: number | string; maxUnavailable?: number | string };

/** A Deployment carrying one strategy, for exercising the primitive alone. */
const withStrategy = (strategy: Strategy | undefined, name = 'checkout-api') =>
  new FakeKubernetes({
    deployments: {
      [NS]: [deploymentSnapshot({ name, namespace: NS, ...(strategy ? { strategy } : { strategy: undefined }) })],
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
    const result = await strategyCheck(rolling('25%', '25%'), {
      name: 'checkout-api',
      strategy: 'RollingUpdate',
      maxSurge: 1,
      maxUnavailable: 0,
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('maxSurge');
    expect(result.detail).toContain('maxUnavailable');
  });

  it('never confuses an absolute count with a percentage', async () => {
    // `1` is one Pod. `"1%"` is one percent of replicas. Different instructions.
    expect(
      (await strategyCheck(rolling('1%', 0), { name: 'checkout-api', strategy: 'RollingUpdate', maxSurge: 1 })).status,
    ).toBe('fail');
    expect(
      (await strategyCheck(rolling(1, 0), { name: 'checkout-api', strategy: 'RollingUpdate', maxSurge: '1%' })).status,
    ).toBe('fail');
    // …and 100% is not the same as "all of them" expressed as a count.
    expect(
      (await strategyCheck(rolling('100%', 0), { name: 'checkout-api', strategy: 'RollingUpdate', maxSurge: 3 })).status,
    ).toBe('fail');
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
            ...overrides.ledger,
          }),
          deploymentSnapshot({
            name: 'checkout-api',
            namespace: NS,
            desiredReplicas: 3,
            readyReplicas: 3,
            availableReplicas: 3,
            updatedReplicas: 3,
            currentReplicas: 3,
            selector: { app: 'checkout-api', tier: 'api' },
            podLabels: { app: 'checkout-api', tier: 'api' },
            strategy: defaultStrategy,
            containers: [{ name: 'api', image: OLD, ready: true, restartCount: 0, state: 'running' }],
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
        ...over.ledger,
      },
      checkout: {
        strategy: { type: 'RollingUpdate', maxSurge: 1, maxUnavailable: 0 },
        containers: [{ name: 'api', image: NEW, ready: true, restartCount: 0, state: 'running' }],
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
        'deployment_strategy',
        'deployment_image',
        'deployment_available',
        'deployment_rollout_complete',
      ]),
    );
  });

  it('fails on the untouched fixture, on strategy and image for both services', async () => {
    expect(await failed(seeded())).toEqual([
      'ledger-writer never runs two versions at once',
      'ledger-writer was released to nginx:1.28-alpine',
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

  it('fails a percentage that happens to work out, because the constraint is in Pods', async () => {
    // 33% of 3 replicas rounds to 1, but the requirement asks for one Pod.
    const percentage = solved({
      checkout: { strategy: { type: 'RollingUpdate', maxSurge: '33%', maxUnavailable: 0 } },
    });
    expect(await failed(percentage)).toEqual(['checkout-api keeps every replica serving and adds at most one']);
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
    expect(await failed(configuredOnly)).toEqual([
      'ledger-writer was released to nginx:1.28-alpine',
      'checkout-api was released to nginx:1.28-alpine',
    ]);
  });

  it('still refuses a deleted-and-recreated Deployment', async () => {
    const recreated = solved({ checkout: { selector: { app: 'checkout-api' }, podLabels: { app: 'checkout-api' } } });
    expect(await failed(recreated)).toEqual(['checkout-api was reconfigured, not replaced']);
  });

  it('fails mid-rollout rather than on configuration alone', async () => {
    const midway = solved({ checkout: { updatedReplicas: 1, currentReplicas: 3, availableReplicas: 2, readyReplicas: 2 } });
    const problems = await failed(midway);

    expect(problems).toContain('The checkout-api rollout finished');
    expect(problems).toContain('All three checkout-api replicas are available');
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
