/**
 * Real `KubernetesPort` implementation backed by @kubernetes/client-node.
 *
 * Every call goes through the Kubernetes API. We never shell out to `kubectl`
 * to *decide* anything, so verification results cannot be influenced by shell
 * parsing quirks or by what the student typed into their terminal.
 */
import { connect as netConnect } from 'node:net';
import { readFileSync } from 'node:fs';
import * as k8s from '@kubernetes/client-node';
import type { NodeInfo } from '../types.js';
import {
  KubernetesUnreachableError,
  ManifestApplyError,
  type ClusterEndpoint,
  type ClusterVersion,
  type AuthorizationResult,
  type ConfigMapSnapshot,
  type ConfigReference,
  type CronJobSnapshot,
  type DaemonSetSnapshot,
  type DeploymentSnapshot,
  type EndpointsSnapshot,
  type HorizontalPodAutoscalerSnapshot,
  type IngressSnapshot,
  type JobSnapshot,
  type KubernetesManifestObject,
  type KubernetesPort,
  type NamespaceSnapshot,
  type NamespacedResourceRef,
  type NetworkPolicySnapshot,
  type PersistentVolumeClaimSnapshot,
  type PodSnapshot,
  type ProbeSnapshot,
  type RoleBindingSnapshot,
  type RoleSnapshot,
  type SecretSnapshot,
  type ServiceReachabilityResult,
  type ServiceAccountSnapshot,
  type ServiceSnapshot,
  type StatefulSetSnapshot,
  type StorageClassSnapshot,
  type TolerationSnapshot,
  type AffinityTermSnapshot,
  type VolumeMountSnapshot,
  type VolumeSourceSnapshot,
} from './port.js';

function statusCodeOf(error: unknown): number | undefined {
  const e = error as { code?: unknown; statusCode?: unknown; response?: { statusCode?: unknown } };
  for (const candidate of [e?.code, e?.statusCode, e?.response?.statusCode]) {
    if (typeof candidate === 'number') return candidate;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  const e = error as { body?: unknown; message?: unknown };
  if (typeof e?.body === 'string' && e.body.length > 0) {
    try {
      const parsed = JSON.parse(e.body) as { message?: string };
      if (parsed.message) return parsed.message;
    } catch {
      /* body was not JSON; fall through */
    }
  }
  if (e?.body && typeof e.body === 'object' && 'message' in e.body) {
    const msg = (e.body as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return typeof e?.message === 'string' ? e.message : String(error);
}

/** Wrap transport-level failures so callers can report the real cause. */
function asUnreachable(action: string, error: unknown): never {
  throw new KubernetesUnreachableError(
    `Kubernetes API call failed while ${action}: ${messageOf(error)}`,
    error,
  );
}

/** The identifying subset of an object that `KubernetesObjectApi.read` needs. */
type ObjectReadRef = Parameters<k8s.KubernetesObjectApi['read']>[0];

type ResourceHandlers = {
  list: (namespace: string) => Promise<string[]>;
  remove: (namespace: string, name: string) => Promise<void>;
};

export interface KubernetesClientOptions {
  /** Path to a kubeconfig file. Falls back to in-cluster / default rules. */
  kubeconfigPath?: string;
  /** Context name to select from the kubeconfig. */
  context?: string;
}

/**
 * How many times an apply re-reads and retries after a `409 Conflict`.
 *
 * Five is client-go's `retry.DefaultRetry` count, for the same reason: a
 * conflict means somebody else won a race we can simply re-run, and a handful
 * of attempts clears every realistic contender while still failing loudly
 * against a controller that is rewriting the object continuously.
 */
const APPLY_CONFLICT_ATTEMPTS = 5;

/**
 * Apply one object, resolving optimistic-concurrency conflicts.
 *
 * The defect this exists for
 * --------------------------
 * `applyObjects` reads an object for its `resourceVersion` and then `replace`s
 * it. That is optimistic concurrency: if anything writes to the object between
 * the read and the replace, the API server rejects the write with `409
 * Conflict` and the apply fails.
 *
 * For the guardrail objects that is not a rare race, it is the expected case.
 * `reset()` purges the namespace and *then* reconciles guardrails, and the
 * quota controller rewrites `ResourceQuota.status.used` on every pod that
 * terminates — so the platform re-applies the quota during the exact window in
 * which the quota controller is busiest. A student resetting a lab with a few
 * replicas could get:
 *
 *     Platform guardrails restored — failed
 *     Operation cannot be fulfilled on resourcequotas
 *     "jumptotech-session-quota": the object has been modified
 *
 * Re-reading and retrying is the resolution optimistic concurrency is designed
 * around, not a retry papering over an unknown flake: the conflict is a
 * *reported*, specific, self-clearing condition, the retry re-reads rather than
 * repeating a stale write, and every other status code still fails on the first
 * attempt.
 *
 * Split out of the method so it can be tested without a cluster.
 */
export async function applyWithConflictRetry(ops: {
  read: () => Promise<{ metadata?: { resourceVersion?: string } }>;
  replace: (resourceVersion: string | undefined) => Promise<unknown>;
  create: () => Promise<unknown>;
  attempts?: number;
  /** Injected by tests so the backoff costs no wall clock. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const attempts = ops.attempts ?? APPLY_CONFLICT_ATTEMPTS;
  const sleep = ops.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  for (let attempt = 1; ; attempt += 1) {
    try {
      let existing: { metadata?: { resourceVersion?: string } };
      try {
        existing = await ops.read();
      } catch (readError) {
        if (statusCodeOf(readError) !== 404) throw readError;
        // Absent, so create it. A 409 here means somebody created it between
        // our read and our create, which the loop below resolves by re-reading.
        await ops.create();
        return;
      }
      await ops.replace(existing.metadata?.resourceVersion);
      return;
    } catch (error) {
      if (statusCodeOf(error) !== 409 || attempt >= attempts) throw error;
      // A short, growing pause: the contending controller is mid-write, and
      // re-reading instantly just loses the same race again.
      await sleep(10 * attempt);
    }
  }
}

export class KubernetesClient implements KubernetesPort {
  readonly #core: k8s.CoreV1Api;
  readonly #apps: k8s.AppsV1Api;
  readonly #batch: k8s.BatchV1Api;
  readonly #networking: k8s.NetworkingV1Api;
  readonly #rbac: k8s.RbacAuthorizationV1Api;
  readonly #discovery: k8s.DiscoveryV1Api;
  readonly #autoscaling: k8s.AutoscalingV2Api;
  readonly #authorization: k8s.AuthorizationV1Api;
  readonly #storage: k8s.StorageV1Api;
  readonly #version: k8s.VersionApi;
  readonly #objects: k8s.KubernetesObjectApi;
  readonly #handlers: Map<string, ResourceHandlers>;
  readonly #serverUrl: string;
  readonly #endpoint: ClusterEndpoint;

  constructor(options: KubernetesClientOptions = {}) {
    const kc = new k8s.KubeConfig();
    if (options.kubeconfigPath) {
      kc.loadFromFile(options.kubeconfigPath);
    } else {
      kc.loadFromDefault();
    }
    if (options.context) kc.setCurrentContext(options.context);

    const cluster = kc.getCurrentCluster();
    this.#serverUrl = cluster?.server ?? '<unknown>';
    this.#endpoint = toClusterEndpoint(cluster);

    this.#core = kc.makeApiClient(k8s.CoreV1Api);
    this.#apps = kc.makeApiClient(k8s.AppsV1Api);
    this.#batch = kc.makeApiClient(k8s.BatchV1Api);
    this.#networking = kc.makeApiClient(k8s.NetworkingV1Api);
    this.#rbac = kc.makeApiClient(k8s.RbacAuthorizationV1Api);
    this.#discovery = kc.makeApiClient(k8s.DiscoveryV1Api);
    this.#autoscaling = kc.makeApiClient(k8s.AutoscalingV2Api);
    this.#authorization = kc.makeApiClient(k8s.AuthorizationV1Api);
    this.#storage = kc.makeApiClient(k8s.StorageV1Api);
    this.#version = kc.makeApiClient(k8s.VersionApi);
    this.#objects = k8s.KubernetesObjectApi.makeApiClient(kc);
    this.#handlers = this.#buildHandlers();
  }

  get serverUrl(): string {
    return this.#serverUrl;
  }

  clusterEndpoint(): ClusterEndpoint {
    return this.#endpoint;
  }

  #buildHandlers(): Map<string, ResourceHandlers> {
    const core = this.#core;
    const apps = this.#apps;
    const batch = this.#batch;
    const networking = this.#networking;
    const rbac = this.#rbac;
    const autoscaling = this.#autoscaling;
    const names = (res: { items: Array<{ metadata?: { name?: string } }> }): string[] =>
      res.items.map((i) => i.metadata?.name).filter((n): n is string => Boolean(n));

    return new Map<string, ResourceHandlers>([
      [
        'pods',
        {
          list: async (ns) => names(await core.listNamespacedPod({ namespace: ns })),
          // grace period 0: a lab namespace is disposable, and making Reset
          // wait out nginx's 30s graceful shutdown would make it feel broken.
          remove: async (ns, name) =>
            void (await core.deleteNamespacedPod({ name, namespace: ns, gracePeriodSeconds: 0 })),
        },
      ],
      [
        'services',
        {
          list: async (ns) => names(await core.listNamespacedService({ namespace: ns })),
          remove: async (ns, name) =>
            void (await core.deleteNamespacedService({ name, namespace: ns })),
        },
      ],
      [
        'configmaps',
        {
          list: async (ns) => names(await core.listNamespacedConfigMap({ namespace: ns })),
          remove: async (ns, name) =>
            void (await core.deleteNamespacedConfigMap({ name, namespace: ns })),
        },
      ],
      [
        'secrets',
        {
          list: async (ns) => names(await core.listNamespacedSecret({ namespace: ns })),
          remove: async (ns, name) =>
            void (await core.deleteNamespacedSecret({ name, namespace: ns })),
        },
      ],
      [
        'deployments',
        {
          list: async (ns) => names(await apps.listNamespacedDeployment({ namespace: ns })),
          remove: async (ns, name) =>
            void (await apps.deleteNamespacedDeployment({ name, namespace: ns })),
        },
      ],
      [
        'replicasets',
        {
          list: async (ns) => names(await apps.listNamespacedReplicaSet({ namespace: ns })),
          remove: async (ns, name) =>
            void (await apps.deleteNamespacedReplicaSet({ name, namespace: ns })),
        },
      ],
      [
        'statefulsets',
        {
          list: async (ns) => names(await apps.listNamespacedStatefulSet({ namespace: ns })),
          remove: async (ns, name) =>
            void (await apps.deleteNamespacedStatefulSet({ name, namespace: ns })),
        },
      ],
      [
        'daemonsets',
        {
          list: async (ns) => names(await apps.listNamespacedDaemonSet({ namespace: ns })),
          remove: async (ns, name) =>
            void (await apps.deleteNamespacedDaemonSet({ name, namespace: ns })),
        },
      ],
      [
        'jobs',
        {
          list: async (ns) => names(await batch.listNamespacedJob({ namespace: ns })),
          remove: async (ns, name) => void (await batch.deleteNamespacedJob({ name, namespace: ns })),
        },
      ],
      [
        'cronjobs',
        {
          list: async (ns) => names(await batch.listNamespacedCronJob({ namespace: ns })),
          remove: async (ns, name) =>
            void (await batch.deleteNamespacedCronJob({ name, namespace: ns })),
        },
      ],
      [
        'ingresses',
        {
          list: async (ns) => names(await networking.listNamespacedIngress({ namespace: ns })),
          remove: async (ns, name) =>
            void (await networking.deleteNamespacedIngress({ name, namespace: ns })),
        },
      ],
      [
        'networkpolicies',
        {
          list: async (ns) => names(await networking.listNamespacedNetworkPolicy({ namespace: ns })),
          remove: async (ns, name) =>
            void (await networking.deleteNamespacedNetworkPolicy({ name, namespace: ns })),
        },
      ],
      [
        'serviceaccounts',
        {
          list: async (ns) => names(await core.listNamespacedServiceAccount({ namespace: ns })),
          remove: async (ns, name) =>
            void (await core.deleteNamespacedServiceAccount({ name, namespace: ns })),
        },
      ],
      [
        'roles',
        {
          list: async (ns) => names(await rbac.listNamespacedRole({ namespace: ns })),
          remove: async (ns, name) => void (await rbac.deleteNamespacedRole({ name, namespace: ns })),
        },
      ],
      [
        'rolebindings',
        {
          list: async (ns) => names(await rbac.listNamespacedRoleBinding({ namespace: ns })),
          remove: async (ns, name) =>
            void (await rbac.deleteNamespacedRoleBinding({ name, namespace: ns })),
        },
      ],
      [
        'resourcequotas',
        {
          list: async (ns) => names(await core.listNamespacedResourceQuota({ namespace: ns })),
          remove: async (ns, name) =>
            void (await core.deleteNamespacedResourceQuota({ name, namespace: ns })),
        },
      ],
      [
        'limitranges',
        {
          list: async (ns) => names(await core.listNamespacedLimitRange({ namespace: ns })),
          remove: async (ns, name) =>
            void (await core.deleteNamespacedLimitRange({ name, namespace: ns })),
        },
      ],
      [
        'persistentvolumeclaims',
        {
          list: async (ns) => names(await core.listNamespacedPersistentVolumeClaim({ namespace: ns })),
          remove: async (ns, name) =>
            void (await core.deleteNamespacedPersistentVolumeClaim({ name, namespace: ns })),
        },
      ],
      [
        'horizontalpodautoscalers',
        {
          list: async (ns) => names(await autoscaling.listNamespacedHorizontalPodAutoscaler({ namespace: ns })),
          remove: async (ns, name) =>
            void (await autoscaling.deleteNamespacedHorizontalPodAutoscaler({ name, namespace: ns })),
        },
      ],
    ]);
  }

  // --- cluster ------------------------------------------------------------

  async ping(): Promise<void> {
    try {
      await this.#version.getCode();
    } catch (error) {
      asUnreachable(`contacting the Kubernetes API at ${this.#serverUrl}`, error);
    }
  }

  async version(): Promise<ClusterVersion> {
    try {
      const info = await this.#version.getCode();
      return {
        gitVersion: info.gitVersion ?? 'unknown',
        major: info.major ?? '',
        minor: info.minor ?? '',
      };
    } catch (error) {
      asUnreachable('reading the cluster version', error);
    }
  }

  async listNodes(): Promise<NodeInfo[]> {
    try {
      const list = await this.#core.listNode();
      return list.items.map((node) => {
        const labels = node.metadata?.labels ?? {};
        const roles = Object.keys(labels)
          .filter((key) => key.startsWith('node-role.kubernetes.io/'))
          .map((key) => key.slice('node-role.kubernetes.io/'.length))
          .filter(Boolean);
        const ready =
          node.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false;
        return {
          name: node.metadata?.name ?? '<unnamed>',
          ready,
          roles: roles.length > 0 ? roles : ['worker'],
          version: node.status?.nodeInfo?.kubeletVersion ?? 'unknown',
        };
      });
    } catch (error) {
      asUnreachable('listing nodes', error);
    }
  }

  // --- namespaces ---------------------------------------------------------

  async namespaceExists(namespace: string): Promise<boolean> {
    return (await this.getNamespace(namespace)) !== null;
  }

  async getNamespace(namespace: string): Promise<NamespaceSnapshot | null> {
    try {
      const ns = await this.#core.readNamespace({ name: namespace });
      return {
        name: ns.metadata?.name ?? namespace,
        phase: ns.status?.phase ?? 'Unknown',
        labels: ns.metadata?.labels ?? {},
      };
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      asUnreachable(`reading namespace ${namespace}`, error);
    }
  }

  async createNamespace(namespace: string, labels: Record<string, string>): Promise<void> {
    try {
      await this.#core.createNamespace({
        body: { metadata: { name: namespace, labels } },
      });
    } catch (error) {
      // Already present is success: session namespace names are unique, and a
      // retry after a partial failure must be able to proceed.
      if (statusCodeOf(error) === 409) return;
      asUnreachable(`creating namespace ${namespace}`, error);
    }
  }

  async deleteNamespace(namespace: string): Promise<void> {
    try {
      await this.#core.deleteNamespace({ name: namespace });
    } catch (error) {
      if (statusCodeOf(error) === 404) return;
      asUnreachable(`deleting namespace ${namespace}`, error);
    }
  }

  async listNamespaces(labelSelector?: string): Promise<NamespaceSnapshot[]> {
    try {
      const list = await this.#core.listNamespace(labelSelector ? { labelSelector } : {});
      return list.items.map((ns) => ({
        name: ns.metadata?.name ?? '<unnamed>',
        phase: ns.status?.phase ?? 'Unknown',
        labels: ns.metadata?.labels ?? {},
      }));
    } catch (error) {
      asUnreachable('listing namespaces', error);
    }
  }

  // --- reads --------------------------------------------------------------

  async getPod(namespace: string, name: string): Promise<PodSnapshot | null> {
    let pod: k8s.V1Pod;
    try {
      pod = await this.#core.readNamespacedPod({ name, namespace });
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      asUnreachable(`reading pod ${namespace}/${name}`, error);
    }
    return toPodSnapshot(pod, namespace, name);
  }

  async listPods(namespace: string, labelSelector?: string): Promise<PodSnapshot[]> {
    try {
      const list = await this.#core.listNamespacedPod({
        namespace,
        ...(labelSelector ? { labelSelector } : {}),
      });
      return list.items.map((pod) => toPodSnapshot(pod, namespace, pod.metadata?.name ?? ''));
    } catch (error) {
      asUnreachable(`listing pods in ${namespace}`, error);
    }
  }

  async getDeployment(namespace: string, name: string): Promise<DeploymentSnapshot | null> {
    let deployment: k8s.V1Deployment;
    try {
      deployment = await this.#apps.readNamespacedDeployment({ name, namespace });
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      asUnreachable(`reading deployment ${namespace}/${name}`, error);
    }
    return toDeploymentSnapshot(deployment, namespace, name);
  }

  async getService(namespace: string, name: string): Promise<ServiceSnapshot | null> {
    let service: k8s.V1Service;
    try {
      service = await this.#core.readNamespacedService({ name, namespace });
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      asUnreachable(`reading service ${namespace}/${name}`, error);
    }
    return {
      name: service.metadata?.name ?? name,
      namespace: service.metadata?.namespace ?? namespace,
      type: service.spec?.type ?? 'ClusterIP',
      ...(service.spec?.clusterIP ? { clusterIP: service.spec.clusterIP } : {}),
      selector: service.spec?.selector ?? {},
      ports: (service.spec?.ports ?? []).map((port) => ({
        ...(port.name ? { name: port.name } : {}),
        port: port.port,
        ...(port.targetPort !== undefined ? { targetPort: port.targetPort as number | string } : {}),
        protocol: port.protocol ?? 'TCP',
        ...(port.nodePort !== undefined ? { nodePort: port.nodePort } : {}),
      })),
    };
  }

  /**
   * Backend addresses behind a Service, read from EndpointSlices.
   *
   * EndpointSlice is the current API; the legacy `Endpoints` object is not
   * consulted. A Service with no matching Pods produces zero ready addresses,
   * which is exactly the signal a connectivity lab needs.
   */
  async getEndpoints(namespace: string, serviceName: string): Promise<EndpointsSnapshot | null> {
    try {
      const slices = await this.#discovery.listNamespacedEndpointSlice({
        namespace,
        labelSelector: `kubernetes.io/service-name=${serviceName}`,
      });

      let ready = 0;
      let notReady = 0;
      const targets: string[] = [];
      for (const slice of slices.items) {
        for (const endpoint of slice.endpoints ?? []) {
          const count = endpoint.addresses?.length ?? 0;
          if (endpoint.conditions?.ready === false) notReady += count;
          else ready += count;
          if (endpoint.targetRef?.name) targets.push(endpoint.targetRef.name);
        }
      }

      return {
        serviceName,
        namespace,
        readyAddresses: ready,
        notReadyAddresses: notReady,
        targets,
      };
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      asUnreachable(`reading endpoints for service ${namespace}/${serviceName}`, error);
    }
  }

  async getJob(namespace: string, name: string): Promise<JobSnapshot | null> {
    let job: k8s.V1Job;
    try {
      job = await this.#batch.readNamespacedJob({ name, namespace });
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      asUnreachable(`reading job ${namespace}/${name}`, error);
    }
    return toJobSnapshot(job, namespace, name);
  }

  async getCronJob(namespace: string, name: string): Promise<CronJobSnapshot | null> {
    let cronJob: k8s.V1CronJob;
    try {
      cronJob = await this.#batch.readNamespacedCronJob({ name, namespace });
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      asUnreachable(`reading cronjob ${namespace}/${name}`, error);
    }
    return toCronJobSnapshot(cronJob, namespace, name);
  }

  async getConfigMap(namespace: string, name: string): Promise<ConfigMapSnapshot | null> {
    try {
      const cm = await this.#core.readNamespacedConfigMap({ name, namespace });
      return {
        name: cm.metadata?.name ?? name,
        namespace: cm.metadata?.namespace ?? namespace,
        data: { ...(cm.data ?? {}) },
      };
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      asUnreachable(`reading configmap ${namespace}/${name}`, error);
    }
  }

  /** Reads key names and type only — Secret *values* never enter the platform. */
  async getSecret(namespace: string, name: string): Promise<SecretSnapshot | null> {
    try {
      const secret = await this.#core.readNamespacedSecret({ name, namespace });
      return {
        name: secret.metadata?.name ?? name,
        namespace: secret.metadata?.namespace ?? namespace,
        type: secret.type ?? 'Opaque',
        keys: Object.keys({ ...(secret.data ?? {}), ...(secret.stringData ?? {}) }).sort(),
      };
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      asUnreachable(`reading secret ${namespace}/${name}`, error);
    }
  }

  async getRole(namespace: string, name: string): Promise<RoleSnapshot | null> {
    try {
      const role = await this.#rbac.readNamespacedRole({ name, namespace });
      return toRoleSnapshot(role, namespace, name);
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      asUnreachable(`reading role ${namespace}/${name}`, error);
    }
  }

  async getRoleBinding(namespace: string, name: string): Promise<RoleBindingSnapshot | null> {
    try {
      const binding = await this.#rbac.readNamespacedRoleBinding({ name, namespace });
      return toRoleBindingSnapshot(binding, namespace, name);
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      asUnreachable(`reading rolebinding ${namespace}/${name}`, error);
    }
  }

  async getServiceAccount(namespace: string, name: string): Promise<ServiceAccountSnapshot | null> {
    try {
      const sa = await this.#core.readNamespacedServiceAccount({ name, namespace });
      return {
        name: sa.metadata?.name ?? name,
        namespace: sa.metadata?.namespace ?? namespace,
        deleting: Boolean(sa.metadata?.deletionTimestamp),
      };
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      asUnreachable(`reading serviceaccount ${namespace}/${name}`, error);
    }
  }

  async getPersistentVolumeClaim(
    namespace: string,
    name: string,
  ): Promise<PersistentVolumeClaimSnapshot | null> {
    try {
      const pvc = await this.#core.readNamespacedPersistentVolumeClaim({ name, namespace });
      return toPersistentVolumeClaimSnapshot(pvc, namespace, name);
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      asUnreachable(`reading persistentvolumeclaim ${namespace}/${name}`, error);
    }
  }

  async getIngress(namespace: string, name: string): Promise<IngressSnapshot | null> {
    try {
      const ingress = await this.#networking.readNamespacedIngress({ name, namespace });
      return toIngressSnapshot(ingress, namespace, name);
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      asUnreachable(`reading ingress ${namespace}/${name}`, error);
    }
  }

  async getNetworkPolicy(namespace: string, name: string): Promise<NetworkPolicySnapshot | null> {
    try {
      const policy = await this.#networking.readNamespacedNetworkPolicy({ name, namespace });
      return toNetworkPolicySnapshot(policy, namespace, name);
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      asUnreachable(`reading networkpolicy ${namespace}/${name}`, error);
    }
  }

  async getStatefulSet(namespace: string, name: string): Promise<StatefulSetSnapshot | null> {
    try {
      const sts = await this.#apps.readNamespacedStatefulSet({ name, namespace });
      return toStatefulSetSnapshot(sts, namespace, name);
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      asUnreachable(`reading statefulset ${namespace}/${name}`, error);
    }
  }

  async getDaemonSet(namespace: string, name: string): Promise<DaemonSetSnapshot | null> {
    try {
      const ds = await this.#apps.readNamespacedDaemonSet({ name, namespace });
      return toDaemonSetSnapshot(ds, namespace, name);
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      asUnreachable(`reading daemonset ${namespace}/${name}`, error);
    }
  }

  async getHorizontalPodAutoscaler(
    namespace: string,
    name: string,
  ): Promise<HorizontalPodAutoscalerSnapshot | null> {
    try {
      const hpa = await this.#autoscaling.readNamespacedHorizontalPodAutoscaler({ name, namespace });
      return toHorizontalPodAutoscalerSnapshot(hpa, namespace, name);
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      asUnreachable(`reading horizontalpodautoscaler ${namespace}/${name}`, error);
    }
  }

  async getStorageClass(name: string): Promise<StorageClassSnapshot | null> {
    try {
      const sc = await this.#storage.readStorageClass({ name });
      return {
        name: sc.metadata?.name ?? name,
        provisioner: sc.provisioner ?? '',
      };
    } catch (error) {
      if (statusCodeOf(error) === 404) return null;
      asUnreachable(`reading storageclass ${name}`, error);
    }
  }

  async createSubjectAccessReview(params: {
    namespace: string;
    user: string;
    verb: string;
    resource: string;
    apiGroup: string;
    name?: string;
    subresource?: string;
  }): Promise<AuthorizationResult> {
    try {
      const review = await this.#authorization.createSubjectAccessReview({
        body: {
          apiVersion: 'authorization.k8s.io/v1',
          kind: 'SubjectAccessReview',
          spec: {
            user: params.user,
            ...(params.name || params.subresource
              ? {
                  resourceAttributes: {
                    namespace: params.namespace,
                    verb: params.verb,
                    resource: params.resource,
                    group: params.apiGroup || undefined,
                    ...(params.name ? { name: params.name } : {}),
                    ...(params.subresource ? { subresource: params.subresource } : {}),
                  },
                }
              : {
                  resourceAttributes: {
                    namespace: params.namespace,
                    verb: params.verb,
                    resource: params.resource,
                    group: params.apiGroup || undefined,
                  },
                }),
          },
        },
      });
      return {
        allowed: review.status?.allowed ?? false,
        ...(review.status?.reason ? { reason: review.status.reason } : {}),
      };
    } catch (error) {
      asUnreachable(`creating SubjectAccessReview for ${params.user}`, error);
    }
  }

  async checkServiceHttp(
    namespace: string,
    service: string,
    port: number,
    options: {
      path?: string;
      expectedStatus?: number;
      bodyContains?: string;
      timeoutSeconds?: number;
    } = {},
  ): Promise<ServiceReachabilityResult> {
    const svc = await this.getService(namespace, service);
    if (!svc?.clusterIP || svc.clusterIP === 'None') {
      return { ok: false, detail: `Service '${service}' has no ClusterIP to probe` };
    }

    const timeoutMs = (options.timeoutSeconds ?? 5) * 1000;
    const path = options.path ?? '/';
    const url = `http://${svc.clusterIP}:${port}${path}`;

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: '*/*' },
      });
      const body = await response.text();
      const expectedStatus = options.expectedStatus ?? 200;
      if (response.status !== expectedStatus) {
        return {
          ok: false,
          detail: `HTTP ${response.status} from ${service}:${port}${path}, expected ${expectedStatus}`,
          statusCode: response.status,
        };
      }
      if (options.bodyContains && !body.includes(options.bodyContains)) {
        return {
          ok: false,
          detail: `Response body from ${service}:${port}${path} does not contain '${options.bodyContains}'`,
          statusCode: response.status,
        };
      }
      return { ok: true, statusCode: response.status };
    } catch (error) {
      return {
        ok: false,
        detail: `Could not reach ${service}:${port}${path} — ${messageOf(error)}`,
      };
    }
  }

  async checkServiceTcp(
    namespace: string,
    service: string,
    port: number,
    options: { timeoutSeconds?: number } = {},
  ): Promise<ServiceReachabilityResult> {
    const svc = await this.getService(namespace, service);
    if (!svc?.clusterIP || svc.clusterIP === 'None') {
      return { ok: false, detail: `Service '${service}' has no ClusterIP to probe` };
    }

    const timeoutMs = (options.timeoutSeconds ?? 5) * 1000;
    return new Promise((resolve) => {
      const socket = netConnect({ host: svc.clusterIP!, port, timeout: timeoutMs });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve({ ok: false, detail: `TCP connect to ${service}:${port} timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      socket.once('connect', () => {
        clearTimeout(timer);
        socket.end();
        resolve({ ok: true });
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, detail: `TCP connect to ${service}:${port} failed — ${error.message}` });
      });
    });
  }


  // --- writes -------------------------------------------------------------

  async applyObjects(
    namespace: string,
    objects: KubernetesManifestObject[],
  ): Promise<NamespacedResourceRef[]> {
    const applied: NamespacedResourceRef[] = [];

    for (const object of objects) {
      // The namespace is imposed here, never taken from the manifest, so a lab
      // definition cannot write into another session's sandbox.
      const spec = {
        ...object,
        metadata: { ...object.metadata, namespace },
      } as k8s.KubernetesObject;

      try {
        await applyWithConflictRetry({
          read: () => this.#objects.read(spec as ObjectReadRef),
          replace: (resourceVersion) =>
            this.#objects.replace({
              ...spec,
              metadata: { ...spec.metadata, resourceVersion },
            }),
          create: () => this.#objects.create(spec),
        });
      } catch (error) {
        throw new ManifestApplyError(
          `Could not apply ${object.kind}/${object.metadata.name} into ${namespace}: ${messageOf(error)}`,
          error,
        );
      }

      applied.push({ resource: pluralise(object.kind), name: object.metadata.name });
    }

    return applied;
  }

  async listNamespacedResources(
    namespace: string,
    resource: string,
  ): Promise<NamespacedResourceRef[]> {
    const handler = this.#handlers.get(resource);
    // Unknown kinds are ignored rather than fatal: a lab definition can name a
    // resource this platform does not manage yet without breaking Reset.
    if (!handler) return [];
    try {
      const names = await handler.list(namespace);
      return names.map((name) => ({ resource, name }));
    } catch (error) {
      if (statusCodeOf(error) === 404) return [];
      asUnreachable(`listing ${resource} in ${namespace}`, error);
    }
  }

  async deleteNamespacedResource(
    namespace: string,
    resource: string,
    name: string,
  ): Promise<void> {
    const handler = this.#handlers.get(resource);
    if (!handler) return;
    try {
      await handler.remove(namespace, name);
    } catch (error) {
      // Already gone is success for an idempotent reset.
      if (statusCodeOf(error) === 404) return;
      asUnreachable(`deleting ${resource}/${name} in ${namespace}`, error);
    }
  }

  async countPods(namespace: string): Promise<number> {
    try {
      const list = await this.#core.listNamespacedPod({ namespace });
      return list.items.length;
    } catch (error) {
      if (statusCodeOf(error) === 404) return 0;
      asUnreachable(`counting pods in ${namespace}`, error);
    }
  }

  async requestServiceAccountToken(
    namespace: string,
    serviceAccount: string,
    expirationSeconds: number,
  ): Promise<{ token: string; expirationTimestamp: string }> {
    try {
      const response = await this.#core.createNamespacedServiceAccountToken({
        name: serviceAccount,
        namespace,
        body: {
          apiVersion: 'authentication.k8s.io/v1',
          kind: 'TokenRequest',
          // An empty `audiences` means "the API server's own default
          // audiences" (`--api-audiences`), which is exactly what a token used
          // against the API server needs. Naming an audience the cluster does
          // not accept yields a token it rejects as Unauthorized — which is
          // what a student's kubectl would then report, with no hint as to why.
          spec: { expirationSeconds, audiences: [] },
        },
      });
      const token = response.status?.token;
      if (!token) throw new Error('TokenRequest returned no token');
      return {
        token,
        expirationTimestamp:
          response.status?.expirationTimestamp instanceof Date
            ? response.status.expirationTimestamp.toISOString()
            : String(response.status?.expirationTimestamp ?? ''),
      };
    } catch (error) {
      asUnreachable(`requesting a token for serviceaccount ${namespace}/${serviceAccount}`, error);
    }
  }
}

function toClusterEndpoint(cluster: k8s.Cluster | null): ClusterEndpoint {
  if (!cluster) return { server: '<unknown>', insecureSkipTlsVerify: true };

  let caData = cluster.caData;
  if (!caData && cluster.caFile) {
    try {
      caData = readFileSync(cluster.caFile).toString('base64');
    } catch {
      /* fall through to skipTLSVerify below */
    }
  }

  return {
    server: cluster.server,
    ...(caData ? { certificateAuthorityData: caData } : {}),
    ...(caData ? {} : { insecureSkipTlsVerify: true }),
  };
}

/** Minimal kind → plural mapping for reporting what a setup applied. */
function pluralise(kind: string): string {
  const lower = kind.toLowerCase();
  if (lower.endsWith('s')) return `${lower}es`;
  if (lower.endsWith('y')) return `${lower.slice(0, -1)}ies`;
  return `${lower}s`;
}

/** Normalise one probe, recording the handler the student actually chose. */
function toProbeSnapshot(kind: ProbeSnapshot['kind'], probe: k8s.V1Probe): ProbeSnapshot {
  let handler: ProbeSnapshot['handler'] = 'unknown';
  let path: string | undefined;
  let port: number | string | undefined;

  if (probe.httpGet) {
    handler = 'httpGet';
    path = probe.httpGet.path ?? '/';
    port = probe.httpGet.port as number | string | undefined;
  } else if (probe.tcpSocket) {
    handler = 'tcpSocket';
    port = probe.tcpSocket.port as number | string | undefined;
  } else if (probe.exec) {
    handler = 'exec';
  } else if (probe.grpc) {
    handler = 'grpc';
    port = probe.grpc.port;
  }

  return {
    kind,
    handler,
    ...(path !== undefined ? { path } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(probe.initialDelaySeconds !== undefined
      ? { initialDelaySeconds: probe.initialDelaySeconds }
      : {}),
    ...(probe.periodSeconds !== undefined ? { periodSeconds: probe.periodSeconds } : {}),
    ...(probe.timeoutSeconds !== undefined ? { timeoutSeconds: probe.timeoutSeconds } : {}),
    ...(probe.failureThreshold !== undefined ? { failureThreshold: probe.failureThreshold } : {}),
    ...(probe.successThreshold !== undefined ? { successThreshold: probe.successThreshold } : {}),
  };
}

function probesOf(container: k8s.V1Container): ProbeSnapshot[] {
  const probes: ProbeSnapshot[] = [];
  if (container.livenessProbe) probes.push(toProbeSnapshot('liveness', container.livenessProbe));
  if (container.readinessProbe) probes.push(toProbeSnapshot('readiness', container.readinessProbe));
  if (container.startupProbe) probes.push(toProbeSnapshot('startup', container.startupProbe));
  return probes;
}

/**
 * Every ConfigMap / Secret a Pod spec consumes, from all three mechanisms:
 * `envFrom`, a single-key `env[].valueFrom`, and volumes.
 *
 * Secret *values* are never touched — only names and key names, which is all a
 * lab needs in order to check that configuration was externalised correctly.
 */
export function configReferencesOf(spec: k8s.V1PodSpec | undefined): ConfigReference[] {
  if (!spec) return [];
  const refs: ConfigReference[] = [];

  for (const container of spec.containers ?? []) {
    for (const source of container.envFrom ?? []) {
      if (source.configMapRef?.name) {
        refs.push({
          source: 'configmap',
          name: source.configMapRef.name,
          via: 'envFrom',
          container: container.name,
        });
      }
      if (source.secretRef?.name) {
        refs.push({
          source: 'secret',
          name: source.secretRef.name,
          via: 'envFrom',
          container: container.name,
        });
      }
    }

    for (const variable of container.env ?? []) {
      const configMapKeyRef = variable.valueFrom?.configMapKeyRef;
      if (configMapKeyRef?.name) {
        refs.push({
          source: 'configmap',
          name: configMapKeyRef.name,
          key: configMapKeyRef.key,
          via: 'env',
          container: container.name,
        });
      }
      const secretKeyRef = variable.valueFrom?.secretKeyRef;
      if (secretKeyRef?.name) {
        refs.push({
          source: 'secret',
          name: secretKeyRef.name,
          key: secretKeyRef.key,
          via: 'env',
          container: container.name,
        });
      }
    }
  }

  for (const volume of spec.volumes ?? []) {
    if (volume.configMap?.name) {
      const items = volume.configMap.items ?? [];
      if (items.length === 0) {
        refs.push({ source: 'configmap', name: volume.configMap.name, via: 'volume' });
      } else {
        for (const item of items) {
          refs.push({
            source: 'configmap',
            name: volume.configMap.name,
            key: item.key,
            via: 'volume',
          });
        }
      }
    }
    if (volume.secret?.secretName) {
      const items = volume.secret.items ?? [];
      if (items.length === 0) {
        refs.push({ source: 'secret', name: volume.secret.secretName, via: 'volume' });
      } else {
        for (const item of items) {
          refs.push({
            source: 'secret',
            name: volume.secret.secretName,
            key: item.key,
            via: 'volume',
          });
        }
      }
    }
  }

  return refs;
}

function toContainerSnapshots(
  containers: k8s.V1Container[],
  statuses: k8s.V1ContainerStatus[] = [],
): PodSnapshot['containers'] {
  const byName = new Map(statuses.map((s) => [s.name, s] as const));

  return containers.map((container) => {
    const status = byName.get(container.name);
    let state = 'unknown';
    let reason: string | undefined;
    if (status?.state?.running) {
      state = 'running';
    } else if (status?.state?.waiting) {
      state = 'waiting';
      reason = status.state.waiting.reason;
    } else if (status?.state?.terminated) {
      state = 'terminated';
      reason = status.state.terminated.reason;
    }

    const resources = container.resources;
    const probes = probesOf(container);
    return {
      name: container.name,
      image: container.image ?? '',
      ...(status?.image ? { imageRunning: status.image } : {}),
      ready: status?.ready ?? false,
      restartCount: status?.restartCount ?? 0,
      state,
      ...(container.volumeMounts?.length
        ? {
            volumeMounts: container.volumeMounts.map((m) => ({
              name: m.name,
              mountPath: m.mountPath,
              ...(m.readOnly !== undefined ? { readOnly: m.readOnly } : {}),
              ...(m.subPath !== undefined ? { subPath: m.subPath } : {}),
            })),
          }
        : {}),
      ...(container.command ? { command: [...container.command] } : {}),
      ...(container.args ? { args: [...container.args] } : {}),
      // The container's own restartPolicy. `V1Container.restartPolicy` is only
      // meaningful on an init container, where `Always` makes it a native
      // sidecar. Read from the container, never from the Pod spec.
      ...(container.restartPolicy ? { restartPolicy: container.restartPolicy } : {}),
      ...(reason ? { reason } : {}),
      ...(resources?.requests || resources?.limits
        ? {
            resources: {
              ...(resources.requests ? { requests: { ...resources.requests } } : {}),
              ...(resources.limits ? { limits: { ...resources.limits } } : {}),
            },
          }
        : {}),
      ...(probes.length > 0 ? { probes } : {}),
    };
  });
}

/** Normalise a V1Job around the `Complete` / `Failed` conditions. */
export function toJobSnapshot(job: k8s.V1Job, namespace: string, name: string): JobSnapshot {
  const status = job.status ?? {};
  const conditions = status.conditions ?? [];
  const complete = conditions.some((c) => c.type === 'Complete' && c.status === 'True');
  const failedCondition = conditions.find((c) => c.type === 'Failed' && c.status === 'True');

  return {
    name: job.metadata?.name ?? name,
    namespace: job.metadata?.namespace ?? namespace,
    completions: job.spec?.completions ?? 1,
    parallelism: job.spec?.parallelism ?? 1,
    succeeded: status.succeeded ?? 0,
    failed: status.failed ?? 0,
    active: status.active ?? 0,
    complete,
    failedCondition: Boolean(failedCondition),
    ...(failedCondition?.reason ? { failureReason: failedCondition.reason } : {}),
    labels: job.metadata?.labels ?? {},
    containers: toContainerSnapshots(job.spec?.template?.spec?.containers ?? []),
    deleting: Boolean(job.metadata?.deletionTimestamp),
    configRefs: configReferencesOf(job.spec?.template?.spec),
  };
}

export function toCronJobSnapshot(
  cronJob: k8s.V1CronJob,
  namespace: string,
  name: string,
): CronJobSnapshot {
  const spec = cronJob.spec;
  const podSpec = spec?.jobTemplate?.spec?.template?.spec;
  const lastScheduleTime = cronJob.status?.lastScheduleTime;

  return {
    name: cronJob.metadata?.name ?? name,
    namespace: cronJob.metadata?.namespace ?? namespace,
    schedule: spec?.schedule ?? '',
    suspend: spec?.suspend ?? false,
    concurrencyPolicy: spec?.concurrencyPolicy ?? 'Allow',
    activeJobs: cronJob.status?.active?.length ?? 0,
    ...(lastScheduleTime
      ? {
          lastScheduleTime:
            lastScheduleTime instanceof Date
              ? lastScheduleTime.toISOString()
              : String(lastScheduleTime),
        }
      : {}),
    ...(spec?.successfulJobsHistoryLimit !== undefined
      ? { successfulJobsHistoryLimit: spec.successfulJobsHistoryLimit }
      : {}),
    ...(spec?.failedJobsHistoryLimit !== undefined
      ? { failedJobsHistoryLimit: spec.failedJobsHistoryLimit }
      : {}),
    labels: cronJob.metadata?.labels ?? {},
    containers: toContainerSnapshots(podSpec?.containers ?? []),
    deleting: Boolean(cronJob.metadata?.deletionTimestamp),
    configRefs: configReferencesOf(podSpec),
  };
}

/** Normalise a V1Pod into the minimal snapshot the lab engine reasons about. */
export function toPodSnapshot(pod: k8s.V1Pod, namespace: string, name: string): PodSnapshot {
  const spec = pod.spec;
  const containers = toContainerSnapshots(spec?.containers ?? [], pod.status?.containerStatuses ?? []);
  const affinity = schedulingAffinityOf(spec);
  const mounts = volumeMountsOf(spec);
  return {
    name: pod.metadata?.name ?? name,
    namespace: pod.metadata?.namespace ?? namespace,
    phase: pod.status?.phase ?? 'Unknown',
    labels: pod.metadata?.labels ?? {},
    containers,
    ...(spec?.initContainers?.length
      ? {
          initContainers: toContainerSnapshots(
            spec.initContainers,
            pod.status?.initContainerStatuses ?? [],
          ),
        }
      : {}),
    ...(spec?.volumes?.length ? { volumes: volumeSourcesOf(spec) } : {}),
    deleting: Boolean(pod.metadata?.deletionTimestamp),
    ready: containers.length > 0 && containers.every((c) => c.ready),
    configRefs: configReferencesOf(spec),
    ...(spec?.nodeName ? { nodeName: spec.nodeName } : {}),
    ...(spec?.nodeSelector ? { nodeSelector: { ...spec.nodeSelector } } : {}),
    ...(spec?.tolerations?.length ? { tolerations: tolerationsOf(spec.tolerations) } : {}),
    ...(spec?.nodeName ? { scheduledNode: spec.nodeName } : {}),
    ...(affinity.requiredAffinity.length ? { requiredAffinity: affinity.requiredAffinity } : {}),
    ...(affinity.requiredAntiAffinity.length
      ? { requiredAntiAffinity: affinity.requiredAntiAffinity }
      : {}),
    ...(mounts.length ? { volumeMounts: mounts } : {}),
  };
}

/** Normalise a V1Deployment, including the rollout numbers labs check. */
export function toDeploymentSnapshot(
  deployment: k8s.V1Deployment,
  namespace: string,
  name: string,
): DeploymentSnapshot {
  const status = deployment.status ?? {};
  const templateSpec = deployment.spec?.template?.spec;
  const mounts = volumeMountsOf(templateSpec);
  return {
    name: deployment.metadata?.name ?? name,
    namespace: deployment.metadata?.namespace ?? namespace,
    annotations: deployment.metadata?.annotations ?? {},
    ...(deployment.spec?.strategy
      ? {
          strategy: {
            type: deployment.spec.strategy.type ?? 'RollingUpdate',
            ...(deployment.spec.strategy.rollingUpdate?.maxSurge !== undefined
              ? { maxSurge: deployment.spec.strategy.rollingUpdate.maxSurge }
              : {}),
            ...(deployment.spec.strategy.rollingUpdate?.maxUnavailable !== undefined
              ? { maxUnavailable: deployment.spec.strategy.rollingUpdate.maxUnavailable }
              : {}),
          },
        }
      : {}),
    // An unset spec.replicas means 1 in the Kubernetes API.
    desiredReplicas: deployment.spec?.replicas ?? 1,
    readyReplicas: status.readyReplicas ?? 0,
    availableReplicas: status.availableReplicas ?? 0,
    updatedReplicas: status.updatedReplicas ?? 0,
    currentReplicas: status.replicas ?? 0,
    labels: deployment.metadata?.labels ?? {},
    selector: deployment.spec?.selector?.matchLabels ?? {},
    podLabels: deployment.spec?.template?.metadata?.labels ?? {},
    containers: toContainerSnapshots(templateSpec?.containers ?? []),
    ...(templateSpec?.initContainers?.length
      ? { initContainers: toContainerSnapshots(templateSpec.initContainers) }
      : {}),
    ...(templateSpec?.volumes?.length ? { volumes: volumeSourcesOf(templateSpec) } : {}),
    conditions: (status.conditions ?? []).map((c) => ({
      type: c.type,
      status: c.status,
      ...(c.reason ? { reason: c.reason } : {}),
      ...(c.message ? { message: c.message } : {}),
    })),
    generation: deployment.metadata?.generation ?? 0,
    observedGeneration: status.observedGeneration ?? 0,
    deleting: Boolean(deployment.metadata?.deletionTimestamp),
    configRefs: configReferencesOf(templateSpec),
    ...(templateSpec?.nodeSelector ? { nodeSelector: { ...templateSpec.nodeSelector } } : {}),
    ...(templateSpec?.tolerations?.length
      ? { tolerations: tolerationsOf(templateSpec.tolerations) }
      : {}),
    ...(mounts.length ? { volumeMounts: mounts } : {}),
  };
}

function tolerationsOf(tolerations: k8s.V1Toleration[]): TolerationSnapshot[] {
  return tolerations.map((t) => ({
    key: t.key ?? '',
    operator: t.operator ?? 'Equal',
    ...(t.effect ? { effect: t.effect } : {}),
    ...(t.value !== undefined ? { value: t.value } : {}),
  }));
}

function schedulingAffinityOf(spec: k8s.V1PodSpec | undefined): {
  requiredAffinity: AffinityTermSnapshot[];
  requiredAntiAffinity: AffinityTermSnapshot[];
} {
  const requiredAffinity = affinityTermsOf(spec?.affinity?.podAffinity?.requiredDuringSchedulingIgnoredDuringExecution);
  const requiredAntiAffinity = affinityTermsOf(
    spec?.affinity?.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution,
  );
  return { requiredAffinity, requiredAntiAffinity };
}

function affinityTermsOf(
  terms: k8s.V1PodAffinityTerm[] | undefined,
): AffinityTermSnapshot[] {
  return (terms ?? []).map((term) => ({
    topologyKey: term.topologyKey ?? 'kubernetes.io/hostname',
    matchLabels: { ...(term.labelSelector?.matchLabels ?? {}) },
  }));
}

/**
 * `spec.volumes`, reduced to the source kind a lab can reason about.
 *
 * Only the sources the Kubernetes track actually teaches are named; anything
 * else is `other` rather than being guessed at, so a requirement can never
 * accidentally match a volume type nobody modelled.
 */
function volumeSourcesOf(spec: k8s.V1PodSpec | undefined): VolumeSourceSnapshot[] {
  return (spec?.volumes ?? []).map((volume) => {
    if (volume.persistentVolumeClaim) {
      return {
        name: volume.name,
        source: 'persistentVolumeClaim' as const,
        sourceName: volume.persistentVolumeClaim.claimName,
      };
    }
    if (volume.configMap) {
      return {
        name: volume.name,
        source: 'configMap' as const,
        ...(volume.configMap.name ? { sourceName: volume.configMap.name } : {}),
      };
    }
    if (volume.secret) {
      return {
        name: volume.name,
        source: 'secret' as const,
        ...(volume.secret.secretName ? { sourceName: volume.secret.secretName } : {}),
      };
    }
    if (volume.projected) return { name: volume.name, source: 'projected' as const };
    if (volume.hostPath) return { name: volume.name, source: 'hostPath' as const };
    if (volume.downwardAPI) return { name: volume.name, source: 'downwardAPI' as const };
    if (volume.emptyDir) {
      return {
        name: volume.name,
        source: 'emptyDir' as const,
        ...(volume.emptyDir.medium ? { medium: volume.emptyDir.medium } : {}),
      };
    }
    return { name: volume.name, source: 'other' as const };
  });
}

function volumeMountsOf(spec: k8s.V1PodSpec | undefined): VolumeMountSnapshot[] {
  if (!spec) return [];
  const volumeByName = new Map((spec.volumes ?? []).map((volume) => [volume.name, volume] as const));
  const mounts: VolumeMountSnapshot[] = [];
  for (const container of spec.containers ?? []) {
    for (const mount of container.volumeMounts ?? []) {
      const volume = volumeByName.get(mount.name);
      mounts.push({
        name: mount.name,
        mountPath: mount.mountPath,
        ...(volume?.persistentVolumeClaim?.claimName
          ? { claimName: volume.persistentVolumeClaim.claimName }
          : {}),
      });
    }
  }
  return mounts;
}

function toRoleSnapshot(role: k8s.V1Role, namespace: string, name: string): RoleSnapshot {
  return {
    name: role.metadata?.name ?? name,
    namespace: role.metadata?.namespace ?? namespace,
    rules: (role.rules ?? []).map((rule) => ({
      apiGroups: rule.apiGroups ?? [''],
      resources: rule.resources ?? [],
      verbs: rule.verbs ?? [],
    })),
    deleting: Boolean(role.metadata?.deletionTimestamp),
  };
}

function toRoleBindingSnapshot(
  binding: k8s.V1RoleBinding,
  namespace: string,
  name: string,
): RoleBindingSnapshot {
  return {
    name: binding.metadata?.name ?? name,
    namespace: binding.metadata?.namespace ?? namespace,
    roleRef: {
      kind: binding.roleRef.kind,
      name: binding.roleRef.name,
      apiGroup: binding.roleRef.apiGroup ?? 'rbac.authorization.k8s.io',
    },
    subjects: (binding.subjects ?? []).map((subject) => ({
      kind: subject.kind,
      name: subject.name,
    })),
    deleting: Boolean(binding.metadata?.deletionTimestamp),
  };
}

function toPersistentVolumeClaimSnapshot(
  pvc: k8s.V1PersistentVolumeClaim,
  namespace: string,
  name: string,
): PersistentVolumeClaimSnapshot {
  const spec = pvc.spec;
  const status = pvc.status;
  return {
    name: pvc.metadata?.name ?? name,
    namespace: pvc.metadata?.namespace ?? namespace,
    phase: status?.phase ?? 'Pending',
    ...(spec?.storageClassName !== undefined ? { storageClassName: spec.storageClassName } : {}),
    accessModes: [...(spec?.accessModes ?? status?.accessModes ?? [])],
    ...(spec?.resources?.requests?.storage ? { storage: spec.resources.requests.storage } : {}),
    ...(spec?.volumeMode ? { volumeMode: spec.volumeMode } : {}),
    deleting: Boolean(pvc.metadata?.deletionTimestamp),
  };
}

function toIngressSnapshot(ingress: k8s.V1Ingress, namespace: string, name: string): IngressSnapshot {
  const spec = ingress.spec;
  const rules: IngressSnapshot['rules'] = [];
  for (const rule of spec?.rules ?? []) {
    const host = rule.host ?? '';
    for (const path of rule.http?.paths ?? []) {
      const backend = path.backend;
      const serviceName = backend.service?.name ?? backend.resource?.name ?? '';
      const port = backend.service?.port?.number ?? backend.service?.port?.name ?? 0;
      rules.push({
        host,
        path: path.path ?? '/',
        ...(path.pathType ? { pathType: path.pathType } : {}),
        service: serviceName,
        port,
      });
    }
  }

  const defaultBackend = spec?.defaultBackend;
  return {
    name: ingress.metadata?.name ?? name,
    namespace: ingress.metadata?.namespace ?? namespace,
    ...(spec?.ingressClassName ? { ingressClassName: spec.ingressClassName } : {}),
    rules,
    tls: (spec?.tls ?? []).map((entry) => ({
      hosts: [...(entry.hosts ?? [])],
      secretName: entry.secretName ?? '',
    })),
    ...(defaultBackend?.service?.name
      ? {
          defaultBackend: {
            service: defaultBackend.service.name,
            port: defaultBackend.service.port?.number ?? defaultBackend.service.port?.name ?? 0,
          },
        }
      : {}),
    deleting: Boolean(ingress.metadata?.deletionTimestamp),
  };
}

function toNetworkPolicySnapshot(
  policy: k8s.V1NetworkPolicy,
  namespace: string,
  name: string,
): NetworkPolicySnapshot {
  const spec = policy.spec;
  return {
    name: policy.metadata?.name ?? name,
    namespace: policy.metadata?.namespace ?? namespace,
    podSelector: { ...(spec?.podSelector?.matchLabels ?? {}) },
    policyTypes: [...(spec?.policyTypes ?? [])],
    ingress: (spec?.ingress ?? []).map((rule) => networkPolicyIngressRuleOf(rule)),
    egress: (spec?.egress ?? []).map((rule) => networkPolicyEgressRuleOf(rule)),
    deleting: Boolean(policy.metadata?.deletionTimestamp),
  };
}

function networkPolicyIngressRuleOf(
  rule: k8s.V1NetworkPolicyIngressRule,
): NetworkPolicySnapshot['ingress'][number] {
  return {
    peers: (rule._from ?? []).map((peer: k8s.V1NetworkPolicyPeer) => networkPolicyPeerOf(peer)),
    ports: networkPolicyPortsOf(rule.ports),
  };
}

function networkPolicyEgressRuleOf(
  rule: k8s.V1NetworkPolicyEgressRule,
): NetworkPolicySnapshot['egress'][number] {
  return {
    peers: (rule.to ?? []).map((peer: k8s.V1NetworkPolicyPeer) => networkPolicyPeerOf(peer)),
    ports: networkPolicyPortsOf(rule.ports),
  };
}

function networkPolicyPeerOf(peer: k8s.V1NetworkPolicyPeer): NetworkPolicySnapshot['ingress'][number]['peers'][number] {
  return {
    ...(peer.podSelector?.matchLabels ? { podSelector: { ...peer.podSelector.matchLabels } } : {}),
    ...(peer.namespaceSelector?.matchLabels
      ? { namespaceSelector: { ...peer.namespaceSelector.matchLabels } }
      : {}),
  };
}

function networkPolicyPortsOf(
  ports: k8s.V1NetworkPolicyPort[] | undefined,
): NetworkPolicySnapshot['ingress'][number]['ports'] {
  return (ports ?? []).flatMap((port) => {
    const numericPort = typeof port.port === 'number' ? port.port : undefined;
    if (numericPort === undefined && port.protocol === undefined) return [];
    return [
      {
        ...(numericPort !== undefined ? { port: numericPort } : {}),
        ...(port.protocol ? { protocol: port.protocol } : {}),
      },
    ];
  });
}

function toStatefulSetSnapshot(
  sts: k8s.V1StatefulSet,
  namespace: string,
  name: string,
): StatefulSetSnapshot {
  const templateSpec = sts.spec?.template?.spec;
  return {
    name: sts.metadata?.name ?? name,
    namespace: sts.metadata?.namespace ?? namespace,
    annotations: sts.metadata?.annotations ?? {},
    desiredReplicas: sts.spec?.replicas ?? 1,
    readyReplicas: sts.status?.readyReplicas ?? 0,
    ...(sts.spec?.serviceName ? { serviceName: sts.spec.serviceName } : {}),
    labels: sts.metadata?.labels ?? {},
    selector: sts.spec?.selector?.matchLabels ?? {},
    containers: toContainerSnapshots(templateSpec?.containers ?? []),
    volumeClaimTemplates: (sts.spec?.volumeClaimTemplates ?? []).map((template) => ({
      name: template.metadata?.name ?? '',
      ...(template.spec?.storageClassName !== undefined
        ? { storageClassName: template.spec.storageClassName }
        : {}),
      accessModes: [...(template.spec?.accessModes ?? [])],
      ...(template.spec?.resources?.requests?.storage
        ? { storage: template.spec.resources.requests.storage }
        : {}),
    })),
    ...(volumeMountsOf(templateSpec).length ? { volumeMounts: volumeMountsOf(templateSpec) } : {}),
    deleting: Boolean(sts.metadata?.deletionTimestamp),
  };
}

function toDaemonSetSnapshot(ds: k8s.V1DaemonSet, namespace: string, name: string): DaemonSetSnapshot {
  return {
    name: ds.metadata?.name ?? name,
    namespace: ds.metadata?.namespace ?? namespace,
    annotations: ds.metadata?.annotations ?? {},
    desiredScheduled: ds.status?.desiredNumberScheduled ?? 0,
    numberReady: ds.status?.numberReady ?? 0,
    selector: ds.spec?.selector?.matchLabels ?? {},
    containers: toContainerSnapshots(ds.spec?.template?.spec?.containers ?? []),
    deleting: Boolean(ds.metadata?.deletionTimestamp),
  };
}

function toHorizontalPodAutoscalerSnapshot(
  hpa: k8s.V2HorizontalPodAutoscaler,
  namespace: string,
  name: string,
): HorizontalPodAutoscalerSnapshot {
  const spec = hpa.spec;
  const targetRef = spec?.scaleTargetRef;
  const resourceMetrics: HorizontalPodAutoscalerSnapshot['resourceMetrics'] = [];
  let cpuAverageUtilization: number | undefined;

  for (const metric of spec?.metrics ?? []) {
    if (metric.type === 'Resource' && metric.resource) {
      const target = metric.resource.target;
      const utilization =
        target.type === 'Utilization' ? target.averageUtilization : undefined;
      if (metric.resource.name === 'cpu' && utilization !== undefined) {
        cpuAverageUtilization = utilization;
      }
      resourceMetrics.push({
        resource: metric.resource.name,
        ...(utilization !== undefined ? { averageUtilization: utilization } : {}),
      });
    }
  }

  return {
    name: hpa.metadata?.name ?? name,
    namespace: hpa.metadata?.namespace ?? namespace,
    ...(spec?.minReplicas !== undefined ? { minReplicas: spec.minReplicas } : {}),
    maxReplicas: spec?.maxReplicas ?? 1,
    targetKind: targetRef?.kind?.toLowerCase() ?? '',
    targetName: targetRef?.name ?? '',
    ...(cpuAverageUtilization !== undefined ? { cpuAverageUtilization } : {}),
    resourceMetrics,
    deleting: Boolean(hpa.metadata?.deletionTimestamp),
  };
}
