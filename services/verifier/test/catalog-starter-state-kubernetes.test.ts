/**
 * No Kubernetes lab passes on the objects it hands the student.
 *
 * `catalog-starter-state.test.ts` proves this for labs graded by reading the
 * sandbox. A Kubernetes lab's starting state is different: it is whatever the
 * lab's setup manifests create in a fresh namespace. A lab whose manifests
 * already *are* the answer — a Service that already selects the right Pods, a
 * Deployment already on the new image — would pass Verify for a student who
 * typed nothing, and nothing but a person re-reading the YAML would notice.
 *
 * The model, and why a failure here is a proof:
 *
 *   - The namespace holds exactly the objects the setup manifests declare,
 *     converted to snapshots by the same functions the real client uses.
 *   - Everything the *runtime* decides is assumed to have gone as well as it
 *     possibly could: every Deployment is fully rolled out and available, each
 *     of its replicas is a Running, ready Pod carrying the template's labels,
 *     every claim is Bound, and an in-cluster request to a Service with a
 *     ready backend succeeds.
 *
 *   Checks only pass more often as the world gets healthier (with the one
 *   exception of absence checks, which the model does not affect), so a lab
 *   that still fails in this most-favourable world fails in the real one. A
 *   lab whose starting failure depends on the runtime going *wrong* — an image
 *   that cannot be pulled, a probe that never succeeds — would show up here as
 *   passing, and must then be listed below with the reason, so that reliance is
 *   written down instead of assumed.
 *
 * This proves START → FAIL only. Whether a correct solution passes is the
 * per-lab suites' job.
 */
import { describe, expect, it } from 'vitest';
import {
  loadSetupManifests,
  toDeploymentSnapshot,
  toPersistentVolumeClaimSnapshot,
  toPodSnapshot,
  toServiceSnapshot,
  type AuthorizationResult,
  type EndpointsSnapshot,
  type KubernetesManifestObject,
  type LoadedLabDefinition,
  type PodSnapshot,
  type ServiceReachabilityResult,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { verifyLab } from '../src/index.js';

const NS = 'jtt-lab-000000000001';

/**
 * Labs that pass in the most-favourable model, and why they still fail for a
 * real student. Empty today; an entry needs a reason a reviewer can check.
 */
const PASSES_ONLY_IF_RUNTIME_SUCCEEDS: Record<string, string> = {};

/** Kinds this model can stand up. A manifest of any other kind fails the test. */
const MODELLED_KINDS = new Set([
  'Deployment',
  'Service',
  'ConfigMap',
  'Secret',
  'ServiceAccount',
  'PersistentVolumeClaim',
]);

type Manifest = KubernetesManifestObject & Record<string, any>;

function matches(selector: Record<string, string>, labels: Record<string, string>): boolean {
  const entries = Object.entries(selector);
  return entries.length > 0 && entries.every(([key, value]) => labels[key] === value);
}

/**
 * A Deployment as its controller reports it once every replica is up.
 *
 * Applying a manifest once creates revision 1; the controller writes that onto
 * the Deployment, and a rollout lab (K8S-014) grades the revision number.
 */
function healthyDeployment(manifest: Manifest): Manifest {
  const replicas = manifest.spec?.replicas ?? 1;
  return {
    ...manifest,
    metadata: {
      ...manifest.metadata,
      generation: 1,
      annotations: { ...(manifest.metadata.annotations ?? {}), 'deployment.kubernetes.io/revision': '1' },
    },
    status: {
      observedGeneration: 1,
      replicas,
      updatedReplicas: replicas,
      readyReplicas: replicas,
      availableReplicas: replicas,
      conditions: [
        { type: 'Available', status: 'True' },
        { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable' },
      ],
    },
  };
}

/** The Pods a healthy Deployment runs: its template, Running and ready. */
function podsOf(manifest: Manifest): PodSnapshot[] {
  const replicas = manifest.spec?.replicas ?? 1;
  const template = manifest.spec?.template ?? {};
  const containers: Array<{ name: string; image?: string }> = template.spec?.containers ?? [];
  return Array.from({ length: replicas }, (_, index) => {
    const name = `${manifest.metadata.name}-7d9f8c6b5-${String(index).padStart(5, 'a')}`;
    return toPodSnapshot(
      {
        metadata: { name, namespace: NS, labels: template.metadata?.labels ?? {} },
        spec: template.spec,
        status: {
          phase: 'Running',
          conditions: [{ type: 'Ready', status: 'True' }],
          containerStatuses: containers.map((container) => ({
            name: container.name,
            image: container.image ?? '',
            imageID: '',
            ready: true,
            restartCount: 0,
            started: true,
            state: { running: { startedAt: new Date(0) } },
          })),
        },
      } as any,
      NS,
      name,
    );
  });
}

/**
 * A namespace holding exactly a lab's setup objects, with a runtime that never
 * lets anything down.
 */
class StarterNamespace extends FakeKubernetes {
  constructor(manifests: readonly Manifest[]) {
    const byKind = (kind: string) => manifests.filter((m) => m.kind === kind);
    const deployments = byKind('Deployment');
    super({
      namespaces: ['default', 'kube-system', NS],
      deployments: {
        [NS]: deployments.map((m) => toDeploymentSnapshot(healthyDeployment(m) as any, NS, m.metadata.name)),
      },
      pods: { [NS]: deployments.flatMap(podsOf) },
      services: {
        [NS]: byKind('Service').map((m) => toServiceSnapshot(m as any, NS, m.metadata.name)),
      },
      configMaps: {
        [NS]: byKind('ConfigMap').map((m) => ({
          name: m.metadata.name,
          namespace: NS,
          data: { ...(m.data ?? {}) },
        })),
      },
      secrets: {
        [NS]: byKind('Secret').map((m) => ({
          name: m.metadata.name,
          namespace: NS,
          type: m.type ?? 'Opaque',
          keys: Object.keys({ ...(m.data ?? {}), ...(m.stringData ?? {}) }).sort(),
        })),
      },
      serviceAccounts: {
        [NS]: byKind('ServiceAccount').map((m) => ({ name: m.metadata.name, namespace: NS, deleting: false })),
      },
      persistentVolumeClaims: {
        [NS]: byKind('PersistentVolumeClaim').map((m) =>
          toPersistentVolumeClaimSnapshot({ ...m, status: { phase: 'Bound' } } as any, NS, m.metadata.name),
        ),
      },
    });
  }

  /** Endpoints the way the EndpointSlice controller builds them: by selector. */
  override async getEndpoints(namespace: string, serviceName: string): Promise<EndpointsSnapshot | null> {
    const service = await this.getService(namespace, serviceName);
    if (!service) return null;
    const backends = (this.pods.get(namespace) ?? []).filter((pod) => matches(service.selector, pod.labels));
    return {
      serviceName,
      namespace,
      readyAddresses: backends.filter((pod) => pod.ready).length,
      notReadyAddresses: backends.filter((pod) => !pod.ready).length,
      targets: backends.map((pod) => pod.name),
    };
  }

  async #reachable(namespace: string, service: string): Promise<ServiceReachabilityResult> {
    const endpoints = await this.getEndpoints(namespace, service);
    return endpoints && endpoints.readyAddresses > 0
      ? { ok: true, detail: 'modelled as reachable', statusCode: 200 }
      : { ok: false, detail: 'no ready backend' };
  }

  /**
   * Any Service with a ready backend answers — with whatever status and body a
   * check asks for. That is the most favourable answer there is, so a lab that
   * still fails is not failing on reachability.
   */
  override async checkServiceHttp(
    namespace: string,
    service: string,
    _port: number,
    options: { expectedStatus?: number } = {},
  ): Promise<ServiceReachabilityResult> {
    const result = await this.#reachable(namespace, service);
    return result.ok ? { ...result, statusCode: options.expectedStatus ?? 200 } : result;
  }

  override async checkServiceTcp(namespace: string, service: string): Promise<ServiceReachabilityResult> {
    return this.#reachable(namespace, service);
  }

  /** Setup never grants a subject anything, so nothing is allowed yet. */
  override async createSubjectAccessReview(): Promise<AuthorizationResult> {
    return { allowed: false, reason: 'no RoleBinding exists in the starting namespace' };
  }
}

async function starterManifests(lab: LoadedLabDefinition): Promise<Manifest[]> {
  return (await loadSetupManifests(lab)) as Manifest[];
}

describe('the starting state of every Kubernetes lab', () => {
  it('models every Kubernetes lab, so the guard cannot quietly shrink', async () => {
    const registry = await realCatalog();
    const labs = registry.all().filter((lab) => lab.environment.provider === 'kubernetes');
    expect(labs.length).toBeGreaterThanOrEqual(21);

    const unmodelled: string[] = [];
    for (const lab of labs) {
      for (const manifest of await starterManifests(lab)) {
        if (!MODELLED_KINDS.has(manifest.kind)) unmodelled.push(`${lab.id}: ${manifest.kind}`);
      }
    }
    expect(unmodelled, 'teach this model the kind, rather than skipping the lab').toEqual([]);
  });

  it('fails Verify before the student has done anything, however well the runtime behaves', async () => {
    const registry = await realCatalog();
    const passedAtStart: string[] = [];

    for (const lab of registry.all().filter((l) => l.environment.provider === 'kubernetes')) {
      const result = await verifyLab({
        lab,
        namespace: NS,
        k8s: new StarterNamespace(await starterManifests(lab)),
      });
      expect(result.error, `${lab.id} could not be verified`).toBeUndefined();
      if (process.env.STARTER_STATE_DEBUG) {
        console.log(lab.id, result.checks.filter((c) => c.status !== 'pass').map((c) => `${c.label}: ${c.detail}`));
      }
      if (result.passed && !(lab.id in PASSES_ONLY_IF_RUNTIME_SUCCEEDS)) passedAtStart.push(lab.id);
    }

    expect(passedAtStart, 'these labs pass on the objects their setup creates').toEqual([]);
  });

  it('reads the manifests the way the real client does, so a correct object would pass', async () => {
    // The model is only a proof if it can say "pass". K8S-003 hands over a
    // healthy Deployment; add the Service the lab asks for and every check
    // must turn green in this world — otherwise the guard above could be
    // "failing" labs for reasons of its own.
    const registry = await realCatalog();
    const lab = registry.get('K8S-003');
    const service: Manifest = {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'accounts' },
      spec: { type: 'ClusterIP', selector: { app: 'accounts' }, ports: [{ port: 80, targetPort: 80 }] },
    };
    const k8s = new StarterNamespace([...(await starterManifests(lab)), service]);
    const result = await verifyLab({ lab, namespace: NS, k8s });

    expect(result.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    expect(result.passed).toBe(true);
  });
});
