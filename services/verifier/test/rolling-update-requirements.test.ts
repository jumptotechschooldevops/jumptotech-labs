/**
 * K8S-013 — rolling update.
 *
 * The lab adds no new requirement type; what these tests protect is the
 * *composition*. Three properties have to hold together, and each one is a way
 * the lab could be passed without doing what it teaches:
 *
 *   - the image must be the new one          (the task itself)
 *   - the rollout must have finished          (not "in progress and hopeful")
 *   - the selector must still be the original (not deleted and recreated)
 *
 * Everything here runs the real registry against the shared in-memory
 * Kubernetes fake, and every fixture is placed in one namespace so the
 * isolation test can prove a correct Deployment in a *different* namespace
 * satisfies nothing.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'node:url';
import { LabRegistry, type LoadedLabDefinition } from '@jumptotech/lab-orchestrator';
import { FakeKubernetes, deploymentSnapshot } from '@jumptotech/lab-orchestrator/testing';
import { verifyLab, verifyRequirement, VerifyReader } from '../src/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NS = 'lab-00000000000a';
const NS_B = 'lab-00000000000b';

const OLD_IMAGE = 'nginx:1.27-alpine';
const NEW_IMAGE = 'nginx:1.28-alpine';
const SELECTOR = { app: 'payments-api', tier: 'api' };

let registry: LabRegistry;
let lab: LoadedLabDefinition;

beforeAll(async () => {
  registry = new LabRegistry(path.join(repoRoot, 'labs'));
  await registry.load();
  expect(registry.loadErrors).toEqual([]);
  lab = registry.get('K8S-013');
});

/**
 * The Deployment as the lab's setup manifest leaves it: three replicas, all
 * settled, still on the old image.
 */
function initialState(overrides: Parameters<typeof deploymentSnapshot>[0] = {}) {
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
    containers: [{ name: 'api', image: OLD_IMAGE, ready: true, restartCount: 0, state: 'running' }],
    ...overrides,
  });
}

/** The same Deployment after a completed rolling update. */
function solvedState(overrides: Parameters<typeof deploymentSnapshot>[0] = {}) {
  return initialState({
    containers: [{ name: 'api', image: NEW_IMAGE, ready: true, restartCount: 0, state: 'running' }],
    generation: 2,
    observedGeneration: 2,
    ...overrides,
  });
}

const clusterWith = (...deployments: ReturnType<typeof deploymentSnapshot>[]) =>
  new FakeKubernetes({ deployments: { [NS]: deployments } });

const run = (k8s: FakeKubernetes, namespace = NS) => verifyLab({ k8s, lab, namespace });

/** Which of the lab's own checks failed, by label. */
async function failures(k8s: FakeKubernetes, namespace = NS): Promise<string[]> {
  const result = await run(k8s, namespace);
  return result.checks.filter((c) => c.status !== 'pass').map((c) => c.label);
}

// ------------------------------------------------------------------ the lab

describe('K8S-013 — the shipped lab', () => {
  it('is loadable and asks only for requirement types the verifier implements', () => {
    expect(lab.id).toBe('K8S-013');
    expect(lab.environment.provider).toBe('kubernetes');
    expect(lab.requirements.map((r) => r.type)).toEqual([
      'deployment_exists',
      'deployment_selector',
      'deployment_replicas',
      'deployment_image',
      'deployment_rollout_complete',
      'deployment_available',
    ]);
  });

  it('fails on the initial state the setup manifest establishes', async () => {
    const result = await run(clusterWith(initialState()));

    expect(result.passed).toBe(false);
    // Exactly one thing is wrong before the student starts, and it is the task.
    expect(result.checks.filter((c) => c.status !== 'pass').map((c) => c.label)).toEqual([
      'Image is now nginx:1.28-alpine',
    ]);
  });

  it('passes once the rolling update has completed', async () => {
    const result = await run(clusterWith(solvedState()));

    expect(result.passed).toBe(true);
    expect(result.checks.every((c) => c.status === 'pass')).toBe(true);
  });

  it('fails on an empty namespace rather than throwing', async () => {
    const result = await run(new FakeKubernetes());

    expect(result.passed).toBe(false);
    expect(result.checks.every((c) => c.status === 'fail')).toBe(true);
  });
});

// ------------------------------------------------------- wrong value / state

describe('K8S-013 — wrong values do not pass', () => {
  it('rejects a tag that is neither the old nor the required one', async () => {
    const wrong = solvedState({
      containers: [
        { name: 'api', image: 'nginx:1.29-alpine', ready: true, restartCount: 0, state: 'running' },
      ],
    });

    expect(await failures(clusterWith(wrong))).toEqual(['Image is now nginx:1.28-alpine']);
  });

  it('rejects the new image while the rollout is still in progress', async () => {
    // Two replicas moved across, one from the old ReplicaSet still running —
    // the state a student sees if they check the moment after `set image`.
    const midRollout = solvedState({
      updatedReplicas: 2,
      currentReplicas: 3,
      availableReplicas: 2,
      readyReplicas: 2,
    });

    expect(await failures(clusterWith(midRollout))).toEqual([
      'Rollout finished — no replica from the old version remains',
      'All three replicas are available',
    ]);
  });

  it('rejects a rollout the controller has not observed yet', async () => {
    const unobserved = solvedState({ generation: 3, observedGeneration: 2 });
    const result = await verifyRequirement(
      { type: 'deployment_rollout_complete', name: 'payments-api' },
      new VerifyReader(clusterWith(unobserved), NS),
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('has not observed the latest change');
  });

  it('rejects a scaled-down Deployment even on the right image', async () => {
    const scaled = solvedState({
      desiredReplicas: 1,
      readyReplicas: 1,
      availableReplicas: 1,
      updatedReplicas: 1,
      currentReplicas: 1,
    });

    expect(await failures(clusterWith(scaled))).toEqual([
      'Three replicas are still requested',
      'All three replicas are available',
    ]);
  });

  it('rejects replicas that are updated but not yet available', async () => {
    const unavailable = solvedState({ availableReplicas: 0, readyReplicas: 0 });

    expect(await failures(clusterWith(unavailable))).toEqual([
      'Rollout finished — no replica from the old version remains',
      'All three replicas are available',
    ]);
  });
});

// ------------------------------------------------------------ delete-and-recreate

describe('K8S-013 — the Deployment must be updated, not replaced', () => {
  it('rejects the single-label selector `kubectl create deployment` produces', async () => {
    // What a student gets from
    //   kubectl delete deploy payments-api
    //   kubectl create deployment payments-api --image=nginx:1.28-alpine
    //   kubectl scale deployment payments-api --replicas=3
    // Right name, right image, right count — wrong object.
    const recreated = solvedState({
      selector: { app: 'payments-api' },
      podLabels: { app: 'payments-api' },
      generation: 1,
      observedGeneration: 1,
    });

    expect(await failures(clusterWith(recreated))).toEqual([
      'The original Deployment was updated, not replaced',
    ]);
  });

  it('rejects a selector whose second label has drifted', async () => {
    const drifted = solvedState({
      selector: { app: 'payments-api', tier: 'backend' },
      podLabels: { app: 'payments-api', tier: 'backend' },
    });

    expect(await failures(clusterWith(drifted))).toEqual([
      'The original Deployment was updated, not replaced',
    ]);
  });

  it('rejects a Deployment that is terminating', async () => {
    const deleting = solvedState({ deleting: true });
    const result = await verifyRequirement(
      { type: 'deployment_exists', name: 'payments-api' },
      new VerifyReader(clusterWith(deleting), NS),
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('terminating');
  });
});

// ------------------------------------------------------------- wrong resource

describe('K8S-013 — the right change to the wrong object does not pass', () => {
  it('rejects a correctly updated Deployment under a different name', async () => {
    const wrongName = solvedState({ name: 'payments-api-v2' });
    const result = await run(clusterWith(wrongName));

    expect(result.passed).toBe(false);
    expect(result.checks.every((c) => c.status === 'fail')).toBe(true);
  });

  it('does not let a second, correct Deployment rescue the real one', async () => {
    const stale = initialState();
    const decoy = solvedState({ name: 'payments-api-new' });

    expect(await failures(clusterWith(stale, decoy))).toEqual(['Image is now nginx:1.28-alpine']);
  });
});

// --------------------------------------------------------- namespace isolation

describe('K8S-013 — namespace isolation', () => {
  it('does not pass on another session"s solved namespace', async () => {
    // The neighbour finished the lab; this session has not started it.
    const k8s = new FakeKubernetes({ deployments: { [NS_B]: [solvedState({ namespace: NS_B })] } });

    const mine = await run(k8s, NS);
    expect(mine.passed).toBe(false);
    expect(mine.checks.every((c) => c.status === 'fail')).toBe(true);

    // Same cluster, same lab, the other namespace — that one does pass, which
    // is what makes the assertion above about scoping rather than emptiness.
    const theirs = await run(k8s, NS_B);
    expect(theirs.passed).toBe(true);
  });

  it('reports the session namespace, not the cluster, when the object is missing', async () => {
    const k8s = new FakeKubernetes({ deployments: { [NS_B]: [solvedState({ namespace: NS_B })] } });
    const result = await verifyRequirement(
      { type: 'deployment_exists', name: 'payments-api' },
      new VerifyReader(k8s, NS),
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain(NS);
  });
});

// -------------------------------------------------- the adversarial matrix

/*
 * These are the states a student can actually put the namespace into, including
 * the ones that *look* finished. The property under test throughout is that the
 * grader reads desired and observed state from the API — never how the state was
 * produced. There is no command history anywhere in the verifier to consult:
 * `VerifyReader` exposes typed object snapshots and a SubjectAccessReview, and
 * nothing else.
 */
describe('K8S-013 — adversarial: state is graded, commands are not', () => {
  it('case 2 — right image, rollout not finished → FAIL', async () => {
    // The template is updated and the controller has seen it, but only one
    // replica has moved across. A student who checks the instant after
    // `set image` sees exactly this.
    const midRollout = solvedState({ updatedReplicas: 1, currentReplicas: 3, availableReplicas: 1, readyReplicas: 1 });

    expect(await failures(clusterWith(midRollout))).toEqual([
      'Rollout finished — no replica from the old version remains',
      'All three replicas are available',
    ]);
  });

  it('case 3 — old ReplicaSet still serving because the rollout stalled → FAIL', async () => {
    // The shape a ResourceQuota stall produces: template updated, controller
    // has observed it, but zero replicas moved and all three old ones still run.
    const stalled = solvedState({ updatedReplicas: 0, currentReplicas: 3, availableReplicas: 3, readyReplicas: 3 });
    const result = await run(clusterWith(stalled));

    expect(result.passed).toBe(false);
    const rollout = result.checks.find((c) => c.label.startsWith('Rollout finished'))!;
    expect(rollout.status).toBe('fail');
    expect(rollout.detail).toContain('0 of 3');
    // The trap this case exists for: availability alone still reads healthy,
    // so `deployment_available` is not sufficient evidence of a finished rollout.
    expect(result.checks.find((c) => c.label === 'All three replicas are available')!.status).toBe('pass');
  });

  it('case 4 — desired replicas correct but replicas unavailable → FAIL', async () => {
    const unavailable = solvedState({ availableReplicas: 1, readyReplicas: 1 });
    const result = await run(clusterWith(unavailable));

    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.label === 'Three replicas are still requested')!.status).toBe('pass');
    const available = result.checks.find((c) => c.label === 'All three replicas are available')!;
    expect(available.status).toBe('fail');
    expect(available.detail).toContain('1 of 3');
  });

  it('case 6 — hand-built lookalike that never rolled out → FAIL', async () => {
    // Every *visible* field says success — right name, selector, replicas,
    // image, three available — but the controller has not observed the current
    // generation, so no rollout has actually completed. This is the closest a
    // student can get to faking it by patching status-adjacent fields.
    const lookalike = solvedState({ generation: 5, observedGeneration: 4 });
    const result = await run(clusterWith(lookalike));

    expect(result.passed).toBe(false);
    expect(result.checks.filter((c) => c.status !== 'pass').map((c) => c.label)).toEqual([
      'Rollout finished — no replica from the old version remains',
    ]);
  });

  it('case 8 — deleted and rebuilt with a matching selector still has to be correct', async () => {
    // If a student *does* reproduce the two-label selector by hand (a manifest,
    // not `kubectl create deployment`), the lab is satisfied — the objective is
    // the end state, and that state is indistinguishable from an in-place
    // update. What must not happen is a crash or a false pass on a half-built
    // replacement, so both are asserted.
    const faithfulRebuild = solvedState({ generation: 1, observedGeneration: 1 });
    expect((await run(clusterWith(faithfulRebuild))).passed).toBe(true);

    const halfBuilt = solvedState({ generation: 1, observedGeneration: 1, availableReplicas: 0, readyReplicas: 0, updatedReplicas: 0, currentReplicas: 0 });
    expect((await run(clusterWith(halfBuilt))).passed).toBe(false);
  });

  it('case 10 — swapping to the Recreate strategy still has to reach the end state', async () => {
    /*
     * K8S-013's objectives are: change a running Deployment's image in place,
     * follow the rollout to completion, and know why the selector is immutable.
     * None of them is "use RollingUpdate" — that is K8S-015's subject, which is
     * why no requirement here inspects `spec.strategy`.
     *
     * So a student who switches to Recreate and ends up with three available
     * replicas on the new image has met this lab's objectives and passes. The
     * snapshot cannot express strategy at all, which is the honest reflection
     * of that: the grader has no opinion on it. Mid-Recreate — every old Pod
     * gone, none of the new ones up yet — still fails, because the end state
     * is what is graded.
     */
    const recreateFinished = solvedState();
    expect((await run(clusterWith(recreateFinished))).passed).toBe(true);

    const midRecreate = solvedState({ updatedReplicas: 0, currentReplicas: 0, availableReplicas: 0, readyReplicas: 0 });
    expect((await run(clusterWith(midRecreate))).passed).toBe(false);
  });

  it('grades identically no matter which command produced the state', async () => {
    // `kubectl set image`, `kubectl edit`, and `kubectl apply -f` differ only in
    // how they mutate the template. Given the same resulting object the verifier
    // must return the same verdict — there is nothing else for it to read.
    const viaSetImage = solvedState({ generation: 2, observedGeneration: 2 });
    const viaEdit = solvedState({ generation: 2, observedGeneration: 2 });
    const viaApply = solvedState({ generation: 7, observedGeneration: 7 });

    for (const state of [viaSetImage, viaEdit, viaApply]) {
      expect((await run(clusterWith(state))).passed).toBe(true);
    }
  });
});

// ------------------------------------------------------------------- setup

describe('K8S-013 — setup verification', () => {
  it('setup.verify passes on the initial state and fails on an empty namespace', async () => {
    const reader = new VerifyReader(clusterWith(initialState()), NS);
    for (const requirement of lab.setup.verify) {
      expect((await verifyRequirement(requirement, reader)).status).toBe('pass');
    }

    const empty = new VerifyReader(new FakeKubernetes(), NS);
    for (const requirement of lab.setup.verify) {
      expect((await verifyRequirement(requirement, empty)).status).toBe('fail');
    }
  });

  /*
   * A rolling update needs room for `replicas + maxSurge` Pods at once, and
   * every surging Pod is charged against the session ResourceQuota's
   * `limits.*`. A container declaring no limits inherits the LimitRange
   * default — 1 CPU / 1Gi on this platform — so an unqualified 3-replica
   * fixture peaks at 4 CPU / 4Gi, which is the entire namespace budget. The
   * rollout then only fits in an otherwise-empty namespace, and a single debug
   * Pod is enough to stall it with `exceeded quota`.
   *
   * This was observed against a real session, not theorised. The fixture
   * therefore declares explicit limits, and this test is what stops them being
   * dropped again — it reads the shipped YAML rather than a copy of it.
   */
  it('the fixture declares limits small enough for the rollout to surge', async () => {
    const raw = await readFile(
      path.join(repoRoot, 'labs/kubernetes/k8s-013-rolling-update/setup/payments-api.yaml'),
      'utf8',
    );
    const fixture = parseYaml(raw) as {
      spec: {
        replicas: number;
        template: { spec: { containers: { resources?: { limits?: { cpu?: string; memory?: string } } }[] } };
      };
    };

    const container = fixture.spec.template.spec.containers[0]!;
    expect(container.resources?.limits).toBeDefined();

    const millicores = (v: string) => (v.endsWith('m') ? Number(v.slice(0, -1)) : Number(v) * 1000);
    const mebibytes = (v: string) =>
      v.endsWith('Gi') ? Number(v.slice(0, -2)) * 1024 : Number(v.replace('Mi', ''));

    // Peak concurrent Pods: replicas + maxSurge, with the default 25% surge.
    const replicas = fixture.spec.replicas;
    const peakPods = replicas + Math.ceil(replicas * 0.25);
    const peakCpu = peakPods * millicores(container.resources!.limits!.cpu!);
    const peakMemory = peakPods * mebibytes(container.resources!.limits!.memory!);

    // The session quota, from DEFAULT_SESSION_POLICY: limits.cpu 4, memory 4Gi.
    // Half the budget is the ceiling worth defending: it leaves a student room
    // to run debug Pods during the rollout, which is what broke before.
    expect(peakCpu).toBeLessThanOrEqual(2_000);
    expect(peakMemory).toBeLessThanOrEqual(2_048);
  });

  it('setup.verify pins the old image, so a half-applied fixture is caught', async () => {
    // If the fixture were ever applied with the new tag the lab would start
    // already solved. setup.verify is what stops that shipping unnoticed.
    const reader = new VerifyReader(clusterWith(solvedState()), NS);
    const results = await Promise.all(
      lab.setup.verify.map((requirement) => verifyRequirement(requirement, reader)),
    );

    expect(results.some((r) => r.status === 'fail')).toBe(true);
  });
});
