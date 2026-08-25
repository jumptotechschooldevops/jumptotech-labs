/**
 * K8S-017 — sidecar logging, and the `workload_volume_mount` primitive.
 *
 * The primitive exists because "the workload has a volume called x" is not the
 * question a sidecar lab is asking. A volume nothing mounts is inert, and two
 * containers each mounting a volume of their own is not sharing — it ships no
 * logs and would satisfy any check anchored to the workload rather than to a
 * container. So every assertion here is anchored to one named container in one
 * named list, and the adversarial cases are the near-misses that a looser check
 * would wave through.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LabRegistry,
  requirementSchema,
  type ContainerSnapshot,
  type LoadedLabDefinition,
  type VolumeSourceSnapshot,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes, deploymentSnapshot, podSnapshot } from '@jumptotech/lab-orchestrator/testing';
import { verifyLab, verifyRequirement, VerifyReader } from '../src/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NS = 'lab-00000000000a';
const NS_B = 'lab-00000000000b';
const IMAGE = 'busybox:1.36';
const PATH_ = '/var/log/audit';
const VOL = 'audit-logs';
const SELECTOR = { app: 'audit-api', tier: 'api' };

let registry: LabRegistry;
let lab: LoadedLabDefinition;

beforeAll(async () => {
  registry = new LabRegistry(path.join(repoRoot, 'labs'));
  await registry.load();
  expect(registry.loadErrors).toEqual([]);
  lab = registry.get('K8S-017');
});

const c = (over: Partial<ContainerSnapshot> = {}): ContainerSnapshot => ({
  name: 'api',
  image: IMAGE,
  ready: true,
  restartCount: 0,
  state: 'running',
  ...over,
});

const emptyDirVol = (name = VOL): VolumeSourceSnapshot => ({ name, source: 'emptyDir' });

const check = (k8s: FakeKubernetes, r: Record<string, unknown>, ns = NS) =>
  verifyRequirement({ type: 'workload_volume_mount', ...r } as never, new VerifyReader(k8s, ns));

const deployWith = (over: Partial<Parameters<typeof deploymentSnapshot>[0]>) =>
  new FakeKubernetes({
    deployments: { [NS]: [deploymentSnapshot({ name: 'audit-api', namespace: NS, ...over })] },
  });

// -------------------------------------------------------------- the primitive

describe('workload_volume_mount — the container must actually mount it', () => {
  const base = {
    kind: 'deployment' as const,
    name: 'audit-api',
    container: 'api',
    volume: VOL,
    mountPath: PATH_,
  };

  it('passes when the named container mounts the named volume at the path', async () => {
    const k8s = deployWith({
      containers: [c({ volumeMounts: [{ name: VOL, mountPath: PATH_ }] })],
      volumes: [emptyDirVol()],
    });
    expect((await check(k8s, base)).status).toBe('pass');
  });

  it('fails when the volume exists but nothing mounts it', async () => {
    /*
     * The case the primitive exists for. `spec.volumes` alone changes nothing
     * about how the Pod runs, and the message says so rather than sending the
     * student hunting for a typo.
     */
    const k8s = deployWith({ containers: [c()], volumes: [emptyDirVol()] });
    const result = await check(k8s, base);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('exists on the Pod but');
    expect(result.detail).toContain('does not mount it');
  });

  it('fails when the volume is not declared at all', async () => {
    const k8s = deployWith({ containers: [c()] });
    const result = await check(k8s, base);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('does not mount a volume named');
  });

  it('fails when a different volume is mounted at the right path', async () => {
    const k8s = deployWith({
      containers: [c({ volumeMounts: [{ name: 'other-logs', mountPath: PATH_ }] })],
      volumes: [emptyDirVol('other-logs')],
    });
    expect((await check(k8s, base)).status).toBe('fail');
  });

  it('fails when the right volume is mounted at the wrong path', async () => {
    const k8s = deployWith({
      containers: [c({ volumeMounts: [{ name: VOL, mountPath: '/var/log' }] })],
      volumes: [emptyDirVol()],
    });
    const result = await check(k8s, base);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain("mounted at '/var/log'");
  });

  it('fails when the right volume is mounted in the wrong container', async () => {
    // `api` mounts nothing; `helper` mounts it. Anchoring to the workload
    // rather than the container would call this a pass.
    const k8s = deployWith({
      containers: [c(), c({ name: 'helper', volumeMounts: [{ name: VOL, mountPath: PATH_ }] })],
      volumes: [emptyDirVol()],
    });
    expect((await check(k8s, base)).status).toBe('fail');
  });

  it('keeps the two container lists apart', async () => {
    const k8s = deployWith({
      containers: [c()],
      initContainers: [c({ name: 'log-shipper', volumeMounts: [{ name: VOL, mountPath: PATH_ }] })],
      volumes: [emptyDirVol()],
    });

    // Mounted in the init container only.
    expect((await check(k8s, { ...base, container: 'log-shipper', collection: 'initContainers' })).status).toBe('pass');
    expect((await check(k8s, { ...base, container: 'log-shipper', collection: 'containers' })).status).toBe('fail');
    expect((await check(k8s, base)).status).toBe('fail');
  });

  it('picks the right mount when a container has several', async () => {
    const k8s = deployWith({
      containers: [
        c({
          volumeMounts: [
            { name: 'config', mountPath: '/etc/app' },
            { name: VOL, mountPath: PATH_ },
            { name: 'cache', mountPath: '/cache' },
          ],
        }),
      ],
      volumes: [{ name: 'config', source: 'configMap' }, emptyDirVol(), { name: 'cache', source: 'emptyDir' }],
    });
    expect((await check(k8s, base)).status).toBe('pass');
  });

  it('resolves the volume source through the Pod spec', async () => {
    // A Secret that happens to carry the expected name must not satisfy a
    // requirement that asks for an emptyDir.
    const asSecret = deployWith({
      containers: [c({ volumeMounts: [{ name: VOL, mountPath: PATH_ }] })],
      volumes: [{ name: VOL, source: 'secret', sourceName: 'audit-logs' }],
    });
    const wrongSource = await check(asSecret, { ...base, source: 'emptyDir' });
    expect(wrongSource.status).toBe('fail');
    expect(wrongSource.detail).toContain('is a secret, expected emptyDir');

    const asEmptyDir = deployWith({
      containers: [c({ volumeMounts: [{ name: VOL, mountPath: PATH_ }] })],
      volumes: [emptyDirVol()],
    });
    expect((await check(asEmptyDir, { ...base, source: 'emptyDir' })).status).toBe('pass');
  });

  it('checks readOnly and subPath only when asked', async () => {
    const k8s = deployWith({
      containers: [c({ volumeMounts: [{ name: VOL, mountPath: PATH_, readOnly: true, subPath: 'audit.log' }] })],
      volumes: [emptyDirVol()],
    });

    expect((await check(k8s, base)).status).toBe('pass');
    expect((await check(k8s, { ...base, readOnly: true })).status).toBe('pass');
    expect((await check(k8s, { ...base, readOnly: false })).status).toBe('fail');
    expect((await check(k8s, { ...base, subPath: 'audit.log' })).status).toBe('pass');
    expect((await check(k8s, { ...base, subPath: 'other.log' })).status).toBe('fail');
  });

  it('treats an unset readOnly as false', async () => {
    const k8s = deployWith({
      containers: [c({ volumeMounts: [{ name: VOL, mountPath: PATH_ }] })],
      volumes: [emptyDirVol()],
    });
    expect((await check(k8s, { ...base, readOnly: false })).status).toBe('pass');
    expect((await check(k8s, { ...base, readOnly: true })).status).toBe('fail');
  });

  it('reads Pods as well as Deployments', async () => {
    const k8s = new FakeKubernetes({
      pods: {
        [NS]: [
          podSnapshot({
            name: 'solo',
            containers: [c({ volumeMounts: [{ name: VOL, mountPath: PATH_ }] })],
            volumes: [emptyDirVol()],
          }),
        ],
      },
    });
    expect((await check(k8s, { ...base, kind: 'pod', name: 'solo' })).status).toBe('pass');
  });

  it('fails safely on a missing workload and names the session namespace', async () => {
    const result = await check(deployWith({ containers: [c()] }), { ...base, name: 'nope' });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(NS);
  });

  it('rejects a relative mountPath and an unknown source at schema level', async () => {
    const bad = requirementSchema.safeParse({
      type: 'workload_volume_mount', kind: 'deployment', name: 'audit-api',
      container: 'api', volume: VOL, mountPath: 'var/log/audit', label: 'x',
    });
    expect(bad.success).toBe(false);

    const badSource = requirementSchema.safeParse({
      type: 'workload_volume_mount', kind: 'deployment', name: 'audit-api',
      container: 'api', volume: VOL, mountPath: PATH_, source: 'hostPath', label: 'x',
    });
    expect(badSource.success).toBe(false);
  });

  it('has no namespace field, so it cannot be pointed at another session', async () => {
    const withNamespace = requirementSchema.safeParse({
      type: 'workload_volume_mount', kind: 'deployment', name: 'audit-api',
      container: 'api', volume: VOL, mountPath: PATH_, namespace: NS_B, label: 'x',
    });
    expect(withNamespace.success).toBe(false);
  });
});

// ------------------------------------------------------------------- the lab

describe('K8S-017 — the shipped lab', () => {
  const app = (over: Partial<ContainerSnapshot> = {}) => c({ name: 'api', ...over });
  const shipper = (over: Partial<ContainerSnapshot> = {}) =>
    c({ name: 'log-shipper', restartPolicy: 'Always', ...over });
  const mount = [{ name: VOL, mountPath: PATH_ }];

  /** The fixture: healthy, Ready, no volume and no sidecar. */
  const seeded = (over: Partial<Parameters<typeof deploymentSnapshot>[0]> = {}) =>
    new FakeKubernetes({
      deployments: {
        [NS]: [
          deploymentSnapshot({
            name: 'audit-api', namespace: NS,
            desiredReplicas: 2, readyReplicas: 2, availableReplicas: 2,
            updatedReplicas: 2, currentReplicas: 2,
            selector: SELECTOR, podLabels: SELECTOR,
            containers: [app()],
            ...over,
          }),
        ],
      },
    });

  const solved = (over: Partial<Parameters<typeof deploymentSnapshot>[0]> = {}) =>
    seeded({
      containers: [app({ volumeMounts: mount })],
      initContainers: [shipper({ volumeMounts: mount })],
      volumes: [emptyDirVol()],
      generation: 2, observedGeneration: 2,
      ...over,
    });

  const run = (k8s: FakeKubernetes, ns = NS) => verifyLab({ k8s, lab, namespace: ns });
  const failed = async (k8s: FakeKubernetes, ns = NS) =>
    (await run(k8s, ns)).checks.filter((x) => x.status !== 'pass').map((x) => x.label);

  it('asks only for implemented requirement types', () => {
    expect(lab.id).toBe('K8S-017');
    expect(new Set(lab.requirements.map((r) => r.type))).toEqual(
      new Set([
        'deployment_exists',
        'deployment_selector',
        'workload_container',
        'workload_volume_mount',
        'deployment_rollout_complete',
        'deployment_available',
      ]),
    );
  });

  it('fails on the seeded fixture — healthy, but nothing is shipped', async () => {
    // Availability passes: the point is that a healthy workload can still be
    // wrong, which is what this lab teaches.
    expect(await failed(seeded())).toEqual([
      'log-shipper runs for the whole life of the Pod, as a sidecar',
      'The application writes into a shared volume',
      'log-shipper reads the same shared volume',
    ]);
  });

  it('passes on the intended solution', async () => {
    expect((await run(solved())).passed).toBe(true);
  });

  it('fails when the volume is declared but neither container mounts it', async () => {
    const declaredOnly = solved({ containers: [app()], initContainers: [shipper()] });
    expect(await failed(declaredOnly)).toEqual([
      'The application writes into a shared volume',
      'log-shipper reads the same shared volume',
    ]);
  });

  it('fails when each container mounts its OWN volume — the near-miss that ships nothing', async () => {
    const notShared = solved({
      containers: [app({ volumeMounts: [{ name: 'app-logs', mountPath: PATH_ }] })],
      initContainers: [shipper({ volumeMounts: [{ name: 'shipper-logs', mountPath: PATH_ }] })],
      volumes: [emptyDirVol('app-logs'), emptyDirVol('shipper-logs')],
    });
    expect(await failed(notShared)).toEqual([
      'The application writes into a shared volume',
      'log-shipper reads the same shared volume',
    ]);
  });

  it('fails a shipper added as an ordinary init container, not a sidecar', async () => {
    // No container-level restartPolicy: it would run once and exit before the
    // app starts, shipping nothing.
    const notSidecar = solved({
      initContainers: [c({ name: 'log-shipper', volumeMounts: mount })],
    });
    expect(await failed(notSidecar)).toEqual([
      'log-shipper runs for the whole life of the Pod, as a sidecar',
    ]);
  });

  it('fails a shipper added as a second ordinary container', async () => {
    const asAppContainer = solved({
      containers: [app({ volumeMounts: mount }), shipper({ volumeMounts: mount })],
      initContainers: undefined,
    });
    const problems = await failed(asAppContainer);
    expect(problems).toContain('log-shipper runs for the whole life of the Pod, as a sidecar');
    expect(problems).toContain('log-shipper reads the same shared volume');
  });

  it('fails a wrong mount path on either side', async () => {
    expect(await failed(solved({ containers: [app({ volumeMounts: [{ name: VOL, mountPath: '/logs' }] })] }))).toEqual([
      'The application writes into a shared volume',
    ]);
    expect(
      await failed(solved({ initContainers: [shipper({ volumeMounts: [{ name: VOL, mountPath: '/logs' }] })] })),
    ).toEqual(['log-shipper reads the same shared volume']);
  });

  it('fails when the application container was modified', async () => {
    expect(await failed(solved({ containers: [app({ image: 'alpine:3.19', volumeMounts: mount })] }))).toEqual([
      'The application container is unchanged',
    ]);
  });

  it('still refuses a deleted-and-recreated Deployment', async () => {
    expect(await failed(solved({ selector: { app: 'audit-api' }, podLabels: { app: 'audit-api' } }))).toEqual([
      'The original Deployment was extended, not replaced',
    ]);
  });

  it('does not pass on another session"s solved namespace', async () => {
    const theirs = new FakeKubernetes({
      deployments: { [NS_B]: (solved().deployments.get(NS) ?? []).map((d) => ({ ...d, namespace: NS_B })) },
    });
    expect((await run(theirs, NS)).passed).toBe(false);
    expect((await run(theirs, NS_B)).passed).toBe(true);
  });
});
