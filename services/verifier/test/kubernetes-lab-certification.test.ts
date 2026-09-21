/**
 * Kubernetes labs, graded end to end against states a student can plausibly
 * leave behind — found by the 2026-09-20 lab certification pass.
 *
 * Each case starts from the lab's own setup manifests (so the seeded names,
 * labels and images are the real ones) and builds snapshots with the real
 * snapshot builders. What the fake cannot model — the endpoints controller and
 * a request through a Service's cluster IP — is modelled here the way the
 * cluster does it: endpoints by selector, and no request at all for a Service
 * without a cluster IP, which is exactly what `checkServiceHttp` refuses.
 */
import { describe, expect, it } from 'vitest';
import {
  loadSetupManifests,
  toDeploymentSnapshot,
  toPodSnapshot,
  toServiceSnapshot,
  type DeploymentSnapshot,
  type EndpointsSnapshot,
  type PodSnapshot,
  type ServiceReachabilityResult,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { verifyLab } from '../src/index.js';

const NS = 'jtt-lab-000000000001';
// Manifests are untyped YAML documents.
type Manifest = Record<string, any>;

function selects(selector: Record<string, string>, labels: Record<string, string>): boolean {
  const entries = Object.entries(selector);
  return entries.length > 0 && entries.every(([k, v]) => labels[k] === v);
}

function readyPod(name: string, labels: Record<string, string>, spec: Manifest): PodSnapshot {
  return toPodSnapshot(
    {
      metadata: { name, namespace: NS, labels },
      spec,
      status: {
        phase: 'Running',
        containerStatuses: (spec.containers ?? []).map((c: Manifest) => ({
          name: c.name,
          image: c.image,
          imageID: '',
          ready: true,
          restartCount: 0,
          started: true,
          state: { running: { startedAt: new Date(0) } },
        })),
      },
    } as never,
    NS,
    name,
  );
}

/** A cluster whose endpoints and Service requests follow the selector, as a real one does. */
class Cluster extends FakeKubernetes {
  override async getEndpoints(namespace: string, serviceName: string): Promise<EndpointsSnapshot | null> {
    const service = await this.getService(namespace, serviceName);
    if (!service) return null;
    const backends = (this.pods.get(namespace) ?? []).filter((p) => selects(service.selector, p.labels));
    return {
      serviceName,
      namespace,
      readyAddresses: backends.filter((p) => p.ready).length,
      notReadyAddresses: backends.filter((p) => !p.ready).length,
      targets: backends.map((p) => p.name),
    };
  }

  override async checkServiceHttp(namespace: string, serviceName: string): Promise<ServiceReachabilityResult> {
    const service = await this.getService(namespace, serviceName);
    if (!service?.clusterIP || service.clusterIP === 'None') {
      return { ok: false, detail: `Service '${serviceName}' has no ClusterIP to probe` };
    }
    const endpoints = await this.getEndpoints(namespace, serviceName);
    return endpoints && endpoints.readyAddresses > 0
      ? { ok: true, statusCode: 200 }
      : { ok: false, detail: 'no ready backend' };
  }
}

function deployment(
  manifest: Manifest,
  status: Manifest,
  revision = '1',
): DeploymentSnapshot {
  return toDeploymentSnapshot(
    {
      ...manifest,
      metadata: { ...manifest.metadata, generation: 2, annotations: { 'deployment.kubernetes.io/revision': revision } },
      status: { observedGeneration: 2, ...status },
    } as never,
    NS,
    manifest.metadata.name,
  );
}

async function setup(labId: string) {
  const lab = (await realCatalog()).get(labId);
  const manifests = (await loadSetupManifests(lab)) as Manifest[];
  return { lab, manifests };
}

const failing = (result: Awaited<ReturnType<typeof verifyLab>>) =>
  result.checks.filter((c) => c.status !== 'pass').map((c) => c.label);

// ---------------------------------------------------------------- K8S-003

describe('K8S-003 — a Service with a stable cluster address', () => {
  async function graded(clusterIP: string) {
    const { lab, manifests } = await setup('K8S-003');
    const dep = manifests.find((m) => m.kind === 'Deployment')!;
    const labels = dep.spec.template.metadata.labels as Record<string, string>;
    const pods = [0, 1].map((i) => readyPod(`accounts-x-${i}`, labels, dep.spec.template.spec));
    const service = toServiceSnapshot(
      {
        metadata: { name: 'accounts' },
        spec: {
          type: 'ClusterIP',
          clusterIP,
          selector: { app: 'accounts' },
          ports: [{ name: '80-80', port: 80, targetPort: 80, protocol: 'TCP' }],
        },
      } as never,
      NS,
      'accounts',
    );
    const k8s = new Cluster({
      namespaces: [NS],
      deployments: {
        [NS]: [deployment(dep, { replicas: 2, updatedReplicas: 2, readyReplicas: 2, availableReplicas: 2 })],
      },
      pods: { [NS]: pods },
      services: { [NS]: [service] },
    });
    return failing(await verifyLab({ lab, namespace: NS, k8s }));
  }

  it('passes a ClusterIP Service with a virtual IP', async () => {
    expect(await graded('10.96.40.12')).toEqual([]);
  });

  it('fails a headless Service, which reports type ClusterIP but has no address of its own', async () => {
    // Before: `kubectl create service clusterip accounts --clusterip="None" --tcp=80:80`
    // — the second example in `--help` — passed every check.
    expect(await graded('None')).toEqual(['The Service answers requests on its stable cluster address']);
  });
});

// --------------------------------------------------- K8S-004, K8S-005, K8S-011

describe('"still running after the change" means the changed template is running', () => {
  /**
   * The controller's real state when the edited template never becomes ready:
   * one Pod of the new ReplicaSet (not available) beside the old one, which the
   * default strategy keeps serving because maxUnavailable rounds down to 0.
   */
  const STUCK = {
    replicas: 2,
    updatedReplicas: 1,
    readyReplicas: 1,
    availableReplicas: 1,
    conditions: [
      { type: 'Available', status: 'True' },
      { type: 'Progressing', status: 'True', reason: 'ReplicaSetUpdated' },
    ],
  };
  const DONE = { replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 };

  async function k8s004(status: Manifest) {
    const { lab, manifests } = await setup('K8S-004');
    const dep = manifests.find((m) => m.kind === 'Deployment')!;
    const template = structuredClone(dep.spec.template);
    const container = template.spec.containers[0];
    delete container.env;
    // The ConfigMap mounted over nginx's own config directory — a plausible
    // reading of "a mounted volume", and one that hides nginx.conf, so every
    // new Pod crash-loops.
    container.volumeMounts = [{ name: 'config', mountPath: '/etc/nginx' }];
    template.spec.volumes = [{ name: 'config', configMap: { name: 'statements-config' } }];
    const k8s = new Cluster({
      namespaces: [NS],
      deployments: { [NS]: [deployment({ ...dep, spec: { ...dep.spec, template } }, status, '2')] },
      configMaps: {
        [NS]: [{ name: 'statements-config', namespace: NS, data: { STATEMENT_FORMAT: 'pdf', RETENTION_DAYS: '90' } }],
      },
    });
    return failing(await verifyLab({ lab, namespace: NS, k8s }));
  }

  it('K8S-004 passes once the ConfigMap-backed template has rolled out', async () => {
    expect(await k8s004(DONE)).toEqual([]);
  });

  it('K8S-004 fails while only the previous ReplicaSet is serving', async () => {
    // Before: all eight checks passed, because availability counted the old Pod.
    expect(await k8s004(STUCK)).toEqual(['The changed Deployment has rolled out']);
  });

  it.each(['K8S-005', 'K8S-011'])('%s grades the rollout, not just availability', async (labId) => {
    const { lab } = await setup(labId);
    expect(lab.requirements.some((r) => r.type === 'deployment_rollout_complete')).toBe(true);
  });
});
