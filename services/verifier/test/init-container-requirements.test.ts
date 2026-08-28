/**
 * K8S-016 — init containers, and the `workload_container` primitive.
 *
 * The property that carries the most weight here is that the two container
 * lists stay separate. A Pod may name the same container in `containers` and
 * `initContainers`, and "there is an init container called X" is a different
 * claim from "there is a container called X". If the primitive blurred them, a
 * lab could be satisfied by the application container doing the init
 * container's job — which is precisely the mistake K8S-016 exists to correct.
 *
 * The second is the restartPolicy distinction. Every Deployment's Pod template
 * carries `restartPolicy: Always` at *Pod* level, so a handler that read that
 * field instead of the container's own would report every init container as a
 * native sidecar. There is a test for exactly that.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'node:url';
import {
  LabRegistry,
  requirementSchema,
  type ContainerSnapshot,
  type LoadedLabDefinition,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes, deploymentSnapshot, podSnapshot } from '@jumptotech/lab-orchestrator/testing';
import { verifyLab, verifyRequirement, VerifyReader } from '../src/index.js';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NS = 'lab-00000000000a';
const NS_B = 'lab-00000000000b';

const APP_IMAGE = 'nginx:1.28-alpine';
const INIT_IMAGE = 'busybox:1.36';
const SELECTOR = { app: 'reporting-api', tier: 'api' };

let registry: LabRegistry;
let lab: LoadedLabDefinition;

beforeAll(async () => {
  registry = await realCatalog();
  expect(registry.loadErrors).toEqual([]);
  lab = registry.get('K8S-016');
});

const container = (over: Partial<ContainerSnapshot> = {}): ContainerSnapshot => ({
  name: 'api',
  image: APP_IMAGE,
  ready: true,
  restartCount: 0,
  state: 'running',
  ...over,
});

const check = (k8s: FakeKubernetes, requirement: Record<string, unknown>, ns = NS) =>
  verifyRequirement({ type: 'workload_container', ...requirement } as never, new VerifyReader(k8s, ns));

// -------------------------------------------------------------- the primitive

describe('workload_container — the two container lists stay separate', () => {
  const deploymentWith = (containers: ContainerSnapshot[], initContainers?: ContainerSnapshot[]) =>
    new FakeKubernetes({
      deployments: {
        [NS]: [
          deploymentSnapshot({
            name: 'reporting-api',
            namespace: NS,
            containers,
            ...(initContainers ? { initContainers } : {}),
          }),
        ],
      },
    });

  it('finds a container in the list the requirement names', async () => {
    const k8s = deploymentWith([container()], [container({ name: 'prepare-content', image: INIT_IMAGE })]);

    expect((await check(k8s, { kind: 'deployment', name: 'reporting-api', container: 'api', collection: 'containers' })).status).toBe('pass');
    expect((await check(k8s, { kind: 'deployment', name: 'reporting-api', container: 'prepare-content', collection: 'initContainers' })).status).toBe('pass');
  });

  it('does not find an init container in `containers`, or the reverse', async () => {
    const k8s = deploymentWith([container()], [container({ name: 'prepare-content', image: INIT_IMAGE })]);

    const asApp = await check(k8s, { kind: 'deployment', name: 'reporting-api', container: 'prepare-content', collection: 'containers' });
    expect(asApp.status).toBe('fail');
    expect(asApp.detail).toContain('prepare-content');

    const asInit = await check(k8s, { kind: 'deployment', name: 'reporting-api', container: 'api', collection: 'initContainers' });
    expect(asInit.status).toBe('fail');
  });

  it('refuses the shortcut of doing init work in the application container', async () => {
    // No initContainers at all: a student who added the command to `api`.
    const k8s = deploymentWith([container({ name: 'api', command: ['sh', '-c', 'echo hi > /x'] })]);

    const result = await check(k8s, { kind: 'deployment', name: 'reporting-api', container: 'prepare-content', collection: 'initContainers' });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('declares no init containers');
  });

  it('defaults to `containers` when the collection is not named', async () => {
    const parsed = requirementSchema.safeParse({
      type: 'workload_container',
      kind: 'deployment',
      name: 'reporting-api',
      container: 'api',
      label: 'x',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && (parsed.data as { collection: string }).collection).toBe('containers');
  });

  it('reads Pods as well as Deployments', async () => {
    const k8s = new FakeKubernetes({
      pods: {
        [NS]: [
          podSnapshot({
            name: 'solo',
            containers: [container()],
            initContainers: [container({ name: 'prepare-content', image: INIT_IMAGE })],
          }),
        ],
      },
    });

    expect((await check(k8s, { kind: 'pod', name: 'solo', container: 'prepare-content', collection: 'initContainers', image: INIT_IMAGE })).status).toBe('pass');
  });

  it('fails on a workload that does not exist, naming the session namespace', async () => {
    const result = await check(deploymentWith([container()]), { kind: 'deployment', name: 'nope', container: 'api' });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(NS);
  });
});

describe('workload_container — image comparison reuses platform policy', () => {
  const withInit = (image: string) =>
    new FakeKubernetes({
      deployments: {
        [NS]: [
          deploymentSnapshot({
            name: 'reporting-api',
            namespace: NS,
            containers: [container()],
            initContainers: [container({ name: 'prepare-content', image })],
          }),
        ],
      },
    });

  const initCheck = (image: string, expected: string) =>
    check(withInit(image), {
      kind: 'deployment',
      name: 'reporting-api',
      container: 'prepare-content',
      collection: 'initContainers',
      image: expected,
    });

  it('matches the same image written the ways the platform already normalises', async () => {
    // Existing policy in image.ts: Docker Hub prefixes stripped, missing tag
    // reads as :latest. Nothing new is invented here.
    expect((await initCheck('busybox:1.36', 'busybox:1.36')).status).toBe('pass');
    expect((await initCheck('docker.io/library/busybox:1.36', 'busybox:1.36')).status).toBe('pass');
    expect((await initCheck('busybox', 'busybox:latest')).status).toBe('pass');
  });

  it('does not treat a different registry as the same image', async () => {
    const result = await initCheck('registry.example.com/busybox:latest', 'busybox:latest');
    expect(result.status).toBe('fail');
  });

  it('does not treat a different tag as the same image', async () => {
    expect((await initCheck('busybox:1.35', 'busybox:1.36')).status).toBe('fail');
    expect((await initCheck('busybox:latest', 'busybox:1.36')).status).toBe('fail');
  });
});

describe('workload_container — container restartPolicy is not the Pod\'s', () => {
  const initWith = (restartPolicy?: string) =>
    new FakeKubernetes({
      deployments: {
        [NS]: [
          deploymentSnapshot({
            name: 'reporting-api',
            namespace: NS,
            containers: [container()],
            initContainers: [
              container({ name: 'logs', image: INIT_IMAGE, ...(restartPolicy ? { restartPolicy } : {}) }),
            ],
          }),
        ],
      },
    });

  const sidecarCheck = (restartPolicy?: string) =>
    check(initWith(restartPolicy), {
      kind: 'deployment',
      name: 'reporting-api',
      container: 'logs',
      collection: 'initContainers',
      restartPolicy: 'Always',
    });

  it('passes for a native sidecar that sets restartPolicy on the container', async () => {
    expect((await sidecarCheck('Always')).status).toBe('pass');
  });

  it('fails a plain init container even though the Pod template restarts Always', async () => {
    /*
     * The trap. Every Deployment Pod template has `restartPolicy: Always` at
     * Pod level. A handler that read that field would call this a sidecar; the
     * container's own field is unset, so it is not one.
     */
    const result = await sidecarCheck(undefined);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not set on the container');
  });

  it('refuses at schema level to ask a normal container for a restartPolicy', async () => {
    const parsed = requirementSchema.safeParse({
      type: 'workload_container',
      kind: 'deployment',
      name: 'reporting-api',
      container: 'api',
      collection: 'containers',
      restartPolicy: 'Always',
      label: 'x',
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses Pod-level restartPolicy values that a container may not take', async () => {
    for (const value of ['Never', 'OnFailure']) {
      const parsed = requirementSchema.safeParse({
        type: 'workload_container',
        kind: 'deployment',
        name: 'reporting-api',
        container: 'logs',
        collection: 'initContainers',
        restartPolicy: value,
        label: 'x',
      });
      expect(parsed.success, value).toBe(false);
    }
  });
});

describe('workload_container — command and args', () => {
  const withCommand = (over: Partial<ContainerSnapshot>) =>
    new FakeKubernetes({
      deployments: {
        [NS]: [
          deploymentSnapshot({
            name: 'reporting-api',
            namespace: NS,
            containers: [container()],
            initContainers: [container({ name: 'prepare-content', image: INIT_IMAGE, ...over })],
          }),
        ],
      },
    });

  const cmdCheck = (over: Partial<ContainerSnapshot>, requirement: Record<string, unknown>) =>
    check(withCommand(over), {
      kind: 'deployment',
      name: 'reporting-api',
      container: 'prepare-content',
      collection: 'initContainers',
      ...requirement,
    });

  it('compares command as an ordered argv, not as a joined string', async () => {
    expect((await cmdCheck({ command: ['sh', '-c', 'echo hi'] }, { command: ['sh', '-c', 'echo hi'] })).status).toBe('pass');
    // Same tokens, different order — a different command.
    expect((await cmdCheck({ command: ['-c', 'sh', 'echo hi'] }, { command: ['sh', '-c', 'echo hi'] })).status).toBe('fail');
    // A prefix is not a match.
    expect((await cmdCheck({ command: ['sh', '-c'] }, { command: ['sh', '-c', 'echo hi'] })).status).toBe('fail');
  });

  it('compares args independently of command', async () => {
    expect((await cmdCheck({ args: ['--verbose'] }, { args: ['--verbose'] })).status).toBe('pass');
    expect((await cmdCheck({ args: ['--quiet'] }, { args: ['--verbose'] })).status).toBe('fail');
  });

  it('fails safely when command or args are absent', async () => {
    const result = await cmdCheck({}, { command: ['sh'] });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('unset');
  });
});

// ------------------------------------------------------------------- the lab

describe('K8S-016 — the shipped lab', () => {
  const app = (over: Partial<ContainerSnapshot> = {}) => container({ name: 'api', image: APP_IMAGE, ...over });
  const init = (over: Partial<ContainerSnapshot> = {}) =>
    container({ name: 'prepare-content', image: INIT_IMAGE, ...over });

  function state(over: Partial<Parameters<typeof deploymentSnapshot>[0]> = {}) {
    return new FakeKubernetes({
      deployments: {
        [NS]: [
          deploymentSnapshot({
            name: 'reporting-api',
            namespace: NS,
            desiredReplicas: 2,
            readyReplicas: 2,
            availableReplicas: 2,
            updatedReplicas: 2,
            currentReplicas: 2,
            selector: SELECTOR,
            podLabels: SELECTOR,
            containers: [app()],
            ...over,
          }),
        ],
      },
    });
  }

  /** The fixture: app container only, nothing Ready. */
  const seeded = () => state({ readyReplicas: 0, availableReplicas: 0 });
  /** Solved: init container added, both replicas up. */
  const solved = (over: Partial<Parameters<typeof deploymentSnapshot>[0]> = {}) =>
    state({ initContainers: [init()], generation: 2, observedGeneration: 2, ...over });

  const run = (k8s: FakeKubernetes, ns = NS) => verifyLab({ k8s, lab, namespace: ns });
  const failed = async (k8s: FakeKubernetes, ns = NS) =>
    (await run(k8s, ns)).checks.filter((c) => c.status !== 'pass').map((c) => c.label);

  it('the fixture allows an un-Ready replica to be replaced', async () => {
    /*
     * The seeded Pods are Running but never Ready. Under the API default,
     * `maxUnavailable: 25%` of 2 replicas rounds down to zero, and Kubernetes
     * may then refuse to retire the un-Ready Pods while `maxSurge` caps the
     * replacement ReplicaSet at one — so a correct fix stalls, which was
     * reproduced live before this was pinned. The fixture therefore sets an
     * explicit bound, and this test keeps it there.
     */
    const raw = await readFile(
      path.join(repoRoot, 'labs/kubernetes/k8s-016-init-containers/setup/reporting-api.yaml'),
      'utf8',
    );
    const fixture = parseYaml(raw) as {
      spec: { replicas: number; strategy?: { rollingUpdate?: { maxUnavailable?: number | string } } };
    };

    const maxUnavailable = fixture.spec.strategy?.rollingUpdate?.maxUnavailable;
    expect(maxUnavailable, 'fixture must bound maxUnavailable explicitly').toBeDefined();
    // Whatever spelling is used, it has to permit at least one replica to go.
    const asPods =
      typeof maxUnavailable === 'number'
        ? maxUnavailable
        : Math.floor((Number(String(maxUnavailable).replace('%', '')) / 100) * fixture.spec.replicas);
    expect(asPods).toBeGreaterThanOrEqual(1);
  });

  it('asks only for implemented requirement types', () => {
    expect(lab.id).toBe('K8S-016');
    expect(lab.level).toBe('challenge');
    expect(new Set(lab.requirements.map((r) => r.type))).toEqual(
      new Set([
        'deployment_exists',
        'deployment_selector',
        'workload_container',
        'deployment_replicas',
        'deployment_rollout_complete',
        'deployment_available',
      ]),
    );
  });

  it('fails on the seeded workload — nothing is Ready, so the rollout is not complete either', async () => {
    /*
     * Three checks fail, and all three are true of the real fixture: there is
     * no init container, no replica is available, and a Deployment with zero
     * available replicas has not finished rolling out. The app container check
     * passes, because the fixture's application is not the broken part.
     */
    expect(await failed(seeded())).toEqual([
      'An init container prepare-content runs before the application',
      'The rollout finished',
      'Both replicas are available and serving',
    ]);
  });

  it('passes once the init container is added and the rollout completes', async () => {
    expect((await run(solved())).passed).toBe(true);
  });

  it('fails when the preparation was added as a second app container', async () => {
    // The most likely wrong answer: right name and image, wrong list.
    const wrongList = state({ containers: [app(), init()], generation: 2, observedGeneration: 2 });
    expect(await failed(wrongList)).toEqual(['An init container prepare-content runs before the application']);
  });

  it('fails when the init container uses the wrong image', async () => {
    expect(await failed(solved({ initContainers: [init({ image: 'alpine:3.19' })] }))).toEqual([
      'An init container prepare-content runs before the application',
    ]);
  });

  it('fails when the init container is misnamed', async () => {
    expect(await failed(solved({ initContainers: [init({ name: 'setup' })] }))).toEqual([
      'An init container prepare-content runs before the application',
    ]);
  });

  it('fails when the application container was swapped out', async () => {
    expect(await failed(solved({ containers: [app({ image: 'httpd:2.4' })] }))).toEqual([
      'The application container is unchanged',
    ]);
  });

  it('fails a fix that was made by hand and never rolled out', async () => {
    const notReady = solved({ readyReplicas: 0, availableReplicas: 0, updatedReplicas: 0, currentReplicas: 2 });
    const problems = await failed(notReady);
    expect(problems).toContain('The rollout finished');
    expect(problems).toContain('Both replicas are available and serving');
  });

  it('still refuses a deleted-and-recreated Deployment', async () => {
    expect(await failed(solved({ selector: { app: 'reporting-api' }, podLabels: { app: 'reporting-api' } }))).toEqual([
      'The original Deployment was fixed, not replaced',
    ]);
  });

  it('does not pass on another session"s fixed namespace', async () => {
    const theirs = new FakeKubernetes({
      deployments: { [NS_B]: (solved().deployments.get(NS) ?? []).map((d) => ({ ...d, namespace: NS_B })) },
    });

    expect((await run(theirs, NS)).passed).toBe(false);
    expect((await run(theirs, NS_B)).passed).toBe(true);
  });
});
