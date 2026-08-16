/**
 * Real `KubernetesPort` implementation backed by @kubernetes/client-node.
 *
 * Every call goes through the Kubernetes API. We never shell out to `kubectl`
 * to *decide* anything, so verification results cannot be influenced by shell
 * parsing quirks or by what the student typed into their terminal.
 */
import { readFileSync } from 'node:fs';
import * as k8s from '@kubernetes/client-node';
import type { NodeInfo } from '../types.js';
import {
  KubernetesUnreachableError,
  ManifestApplyError,
  type ClusterEndpoint,
  type ClusterVersion,
  type ConfigMapSnapshot,
  type DeploymentSnapshot,
  type EndpointsSnapshot,
  type KubernetesManifestObject,
  type KubernetesPort,
  type NamespaceSnapshot,
  type NamespacedResourceRef,
  type PodSnapshot,
  type SecretSnapshot,
  type ServiceSnapshot,
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

export class KubernetesClient implements KubernetesPort {
  readonly #core: k8s.CoreV1Api;
  readonly #apps: k8s.AppsV1Api;
  readonly #batch: k8s.BatchV1Api;
  readonly #networking: k8s.NetworkingV1Api;
  readonly #rbac: k8s.RbacAuthorizationV1Api;
  readonly #discovery: k8s.DiscoveryV1Api;
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
        try {
          const existing = await this.#objects.read(
            spec as ObjectReadRef,
          );
          await this.#objects.replace({
            ...spec,
            metadata: {
              ...spec.metadata,
              resourceVersion: existing.metadata?.resourceVersion,
            },
          });
        } catch (readError) {
          if (statusCodeOf(readError) !== 404) throw readError;
          await this.#objects.create(spec);
        }
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
    return {
      name: container.name,
      image: container.image ?? '',
      ...(status?.image ? { imageRunning: status.image } : {}),
      ready: status?.ready ?? false,
      restartCount: status?.restartCount ?? 0,
      state,
      ...(reason ? { reason } : {}),
      ...(resources?.requests || resources?.limits
        ? {
            resources: {
              ...(resources.requests ? { requests: { ...resources.requests } } : {}),
              ...(resources.limits ? { limits: { ...resources.limits } } : {}),
            },
          }
        : {}),
    };
  });
}

/** Normalise a V1Pod into the minimal snapshot the lab engine reasons about. */
export function toPodSnapshot(pod: k8s.V1Pod, namespace: string, name: string): PodSnapshot {
  const containers = toContainerSnapshots(pod.spec?.containers ?? [], pod.status?.containerStatuses ?? []);
  return {
    name: pod.metadata?.name ?? name,
    namespace: pod.metadata?.namespace ?? namespace,
    phase: pod.status?.phase ?? 'Unknown',
    labels: pod.metadata?.labels ?? {},
    containers,
    deleting: Boolean(pod.metadata?.deletionTimestamp),
    ready: containers.length > 0 && containers.every((c) => c.ready),
  };
}

/** Normalise a V1Deployment, including the rollout numbers labs check. */
export function toDeploymentSnapshot(
  deployment: k8s.V1Deployment,
  namespace: string,
  name: string,
): DeploymentSnapshot {
  const status = deployment.status ?? {};
  return {
    name: deployment.metadata?.name ?? name,
    namespace: deployment.metadata?.namespace ?? namespace,
    // An unset spec.replicas means 1 in the Kubernetes API.
    desiredReplicas: deployment.spec?.replicas ?? 1,
    readyReplicas: status.readyReplicas ?? 0,
    availableReplicas: status.availableReplicas ?? 0,
    updatedReplicas: status.updatedReplicas ?? 0,
    currentReplicas: status.replicas ?? 0,
    labels: deployment.metadata?.labels ?? {},
    selector: deployment.spec?.selector?.matchLabels ?? {},
    podLabels: deployment.spec?.template?.metadata?.labels ?? {},
    containers: toContainerSnapshots(deployment.spec?.template?.spec?.containers ?? []),
    conditions: (status.conditions ?? []).map((c) => ({
      type: c.type,
      status: c.status,
      ...(c.reason ? { reason: c.reason } : {}),
      ...(c.message ? { message: c.message } : {}),
    })),
    generation: deployment.metadata?.generation ?? 0,
    observedGeneration: status.observedGeneration ?? 0,
    deleting: Boolean(deployment.metadata?.deletionTimestamp),
  };
}
