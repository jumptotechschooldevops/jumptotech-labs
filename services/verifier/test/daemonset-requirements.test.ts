/**
 * K8S-018 — DaemonSets.
 *
 * No new requirement type: the five `daemonset_*` primitives already existed
 * and had never been used by a lab. What these tests protect is that the lab
 * cannot be satisfied by anything other than a real DaemonSet.
 *
 * The property doing that work is not something the lab asserts — it falls out
 * of what the primitives read. `daemonset_scheduled` and `daemonset_ready`
 * read `status.desiredNumberScheduled` and `status.numberReady`, which only the
 * DaemonSet controller writes, and only onto a DaemonSet object. A Deployment,
 * a bare Pod, or a hand-labelled decoy has no such status to offer, whatever it
 * is named. The adversarial cases below are there to keep that true.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LabRegistry,
  type DaemonSetSnapshot,
  type LoadedLabDefinition,
} from '@jumptotech/lab-orchestrator';
import {
  FakeKubernetes,
  deploymentSnapshot,
  podSnapshot,
} from '@jumptotech/lab-orchestrator/testing';
import { verifyLab, verifyRequirement, VerifyReader } from '../src/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NS = 'lab-00000000000a';
const NS_B = 'lab-00000000000b';
const IMAGE = 'busybox:1.36';
const LABELS = { app: 'node-agent', tier: 'infrastructure' };

let registry: LabRegistry;
let lab: LoadedLabDefinition;

beforeAll(async () => {
  registry = new LabRegistry(path.join(repoRoot, 'labs'));
  await registry.load();
  expect(registry.loadErrors).toEqual([]);
  lab = registry.get('K8S-018');
});

/** A DaemonSet as the controller reports it once it has settled. */
const daemonSet = (over: Partial<DaemonSetSnapshot> = {}): DaemonSetSnapshot => ({
  name: 'node-agent',
  namespace: NS,
  desiredScheduled: 1,
  numberReady: 1,
  selector: LABELS,
  containers: [{ name: 'agent', image: IMAGE, ready: true, restartCount: 0, state: 'running' }],
  deleting: false,
  ...over,
});

const cluster = (over: {
  daemonSets?: DaemonSetSnapshot[];
  deployments?: ReturnType<typeof deploymentSnapshot>[];
  pods?: ReturnType<typeof podSnapshot>[];
} = {}) =>
  new FakeKubernetes({
    ...(over.daemonSets ? { daemonSets: { [NS]: over.daemonSets } } : {}),
    ...(over.deployments ? { deployments: { [NS]: over.deployments } } : {}),
    ...(over.pods ? { pods: { [NS]: over.pods } } : {}),
  });

/** The fixture: a Deployment doing a DaemonSet's job. */
const seededDeployment = () =>
  deploymentSnapshot({
    name: 'node-agent',
    namespace: NS,
    desiredReplicas: 3,
    readyReplicas: 3,
    availableReplicas: 3,
    updatedReplicas: 3,
    currentReplicas: 3,
    selector: LABELS,
    podLabels: LABELS,
    containers: [{ name: 'agent', image: IMAGE, ready: true, restartCount: 0, state: 'running' }],
  });

const run = (k8s: FakeKubernetes, ns = NS) => verifyLab({ k8s, lab, namespace: ns });
const failed = async (k8s: FakeKubernetes, ns = NS) =>
  (await run(k8s, ns)).checks.filter((c) => c.status !== 'pass').map((c) => c.label);

// ------------------------------------------------------------------ the lab

describe('K8S-018 — the shipped lab', () => {
  it('reuses existing primitives and adds none', () => {
    expect(lab.id).toBe('K8S-018');
    expect(new Set(lab.requirements.map((r) => r.type))).toEqual(
      new Set([
        'daemonset_exists',
        'daemonset_image',
        'daemonset_selector',
        'daemonset_scheduled',
        'daemonset_ready',
        'resource_absent',
      ]),
    );
  });

  it('fails on the seeded fixture — a healthy Deployment is still the wrong controller', async () => {
    const seeded = cluster({ deployments: [seededDeployment()] });
    const problems = await failed(seeded);

    // Everything DaemonSet-shaped fails, and the leftover Deployment is called out.
    expect(problems).toContain('A DaemonSet named node-agent exists');
    expect(problems).toContain('The old node-agent Deployment is gone');
    expect(problems).toHaveLength(6);
  });

  it('passes when the Deployment has been replaced by a working DaemonSet', async () => {
    expect((await run(cluster({ daemonSets: [daemonSet()] }))).passed).toBe(true);
  });

  it('fails when the DaemonSet was added ALONGSIDE the Deployment', async () => {
    // Correct DaemonSet, but the cluster is still in the state the lab exists
    // to fix — three agents on one node, plus the new one.
    const both = cluster({ daemonSets: [daemonSet()], deployments: [seededDeployment()] });
    expect(await failed(both)).toEqual(['The old node-agent Deployment is gone']);
  });
});

// ------------------------------------------------------- adversarial attempts

describe('K8S-018 — nothing but a real DaemonSet satisfies it', () => {
  it('a Deployment with the right name and image does not', async () => {
    // The seeded state *is* this case; asserted directly so the intent is
    // explicit rather than incidental.
    const asDeployment = cluster({ deployments: [seededDeployment()] });
    expect((await run(asDeployment)).passed).toBe(false);
  });

  it('a standalone Pod with the right image and labels does not', async () => {
    const loosePod = cluster({
      pods: [
        podSnapshot({
          name: 'node-agent',
          namespace: NS,
          labels: LABELS,
          containers: [{ name: 'agent', image: IMAGE, ready: true, restartCount: 0, state: 'running' }],
        }),
      ],
    });
    const problems = await failed(loosePod);

    expect(problems).toContain('A DaemonSet named node-agent exists');
    expect(problems).toContain('The controller wants a Pod on every eligible node');
  });

  it('a fleet of correctly-labelled Pods does not, however many there are', async () => {
    /*
     * The sharpest decoy: Pods that look exactly like what a DaemonSet would
     * have produced. They carry no DaemonSet status, so the scheduled and ready
     * checks have nothing to read.
     */
    const fakeFleet = cluster({
      pods: [1, 2, 3].map((n) =>
        podSnapshot({
          name: `node-agent-${n}`,
          namespace: NS,
          labels: LABELS,
          containers: [{ name: 'agent', image: IMAGE, ready: true, restartCount: 0, state: 'running' }],
        }),
      ),
    });
    expect((await run(fakeFleet)).passed).toBe(false);
  });

  it('a DaemonSet with the wrong image does not', async () => {
    const wrongImage = cluster({
      daemonSets: [
        daemonSet({
          containers: [{ name: 'agent', image: 'alpine:3.19', ready: true, restartCount: 0, state: 'running' }],
        }),
      ],
    });
    expect(await failed(wrongImage)).toEqual(['The DaemonSet runs the agent image']);
  });

  it('a DaemonSet with the wrong selector does not', async () => {
    const wrongSelector = cluster({ daemonSets: [daemonSet({ selector: { app: 'node-agent' } })] });
    expect(await failed(wrongSelector)).toEqual(['The DaemonSet selects the agent Pods']);
  });

  it('a DaemonSet that exists but has scheduled nothing does not', async () => {
    const unscheduled = cluster({ daemonSets: [daemonSet({ desiredScheduled: 0, numberReady: 0 })] });
    const problems = await failed(unscheduled);

    expect(problems).toContain('The controller wants a Pod on every eligible node');
    expect(problems).toContain('The agent is Ready on every node the controller scheduled it to');
  });

  it('a DaemonSet scheduled but not Ready does not', async () => {
    const notReady = cluster({ daemonSets: [daemonSet({ desiredScheduled: 1, numberReady: 0 })] });
    expect(await failed(notReady)).toEqual([
      'The agent is Ready on every node the controller scheduled it to',
    ]);
  });

  it('a terminating DaemonSet does not', async () => {
    const terminating = cluster({ daemonSets: [daemonSet({ deleting: true })] });
    const result = await verifyRequirement(
      { type: 'daemonset_exists', name: 'node-agent' },
      new VerifyReader(terminating, NS),
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('terminating');
  });

  it('a DaemonSet under a different name does not', async () => {
    const misnamed = cluster({ daemonSets: [daemonSet({ name: 'node-agent-v2' })] });
    expect((await run(misnamed)).passed).toBe(false);
  });

  it('an empty namespace fails every DaemonSet check but passes the absence check', async () => {
    // Nothing exists, so the old Deployment is legitimately gone — the lab is
    // still unsolved, and the checklist says which parts are missing.
    const empty = cluster();
    const problems = await failed(empty);

    expect(problems).toHaveLength(5);
    expect(problems).not.toContain('The old node-agent Deployment is gone');
  });

  it('repeated checks on an unsolved namespace stay failed', async () => {
    const seeded = cluster({ deployments: [seededDeployment()] });
    for (let i = 0; i < 3; i += 1) {
      expect((await run(seeded)).passed).toBe(false);
    }
  });
});

// ------------------------------------------ multi-node semantics and isolation

describe('K8S-018 — semantics survive a bigger cluster, and stay in one session', () => {
  it('passes on a three-node cluster with three Pods, unchanged', async () => {
    /*
     * The requirement asks for *at least* one scheduled and ready, because the
     * number is the controller's business. If it had been written as "expect 1"
     * this lab would start failing the day a node was added.
     */
    const threeNodes = cluster({ daemonSets: [daemonSet({ desiredScheduled: 3, numberReady: 3 })] });
    expect((await run(threeNodes)).passed).toBe(true);
  });

  it('fails when only some eligible nodes have a ready agent', async () => {
    const partial = cluster({ daemonSets: [daemonSet({ desiredScheduled: 3, numberReady: 0 })] });
    expect(await failed(partial)).toEqual([
      'The agent is Ready on every node the controller scheduled it to',
    ]);
  });

  it('does not pass on another session"s DaemonSet', async () => {
    const theirs = new FakeKubernetes({
      daemonSets: { [NS_B]: [daemonSet({ namespace: NS_B })] },
    });

    expect((await run(theirs, NS)).passed).toBe(false);
    expect((await run(theirs, NS_B)).passed).toBe(true);
  });

  it('reports the session namespace when the DaemonSet is missing', async () => {
    const theirs = new FakeKubernetes({ daemonSets: { [NS_B]: [daemonSet({ namespace: NS_B })] } });
    const result = await verifyRequirement(
      { type: 'daemonset_exists', name: 'node-agent' },
      new VerifyReader(theirs, NS),
    );

    expect(result.status).toBe('fail');
    expect(result.detail).toContain(NS);
  });
});
