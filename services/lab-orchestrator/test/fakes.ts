/**
 * Shared in-memory Kubernetes fake.
 *
 * Implements the whole `KubernetesPort`, so provider, session, reaper, and
 * verifier logic can be exercised without a cluster. Anything that genuinely
 * needs the API server's *behaviour* — RBAC decisions, quota admission,
 * namespace finalisation — is tested against real kind in `integration.test.ts`
 * instead; this fake deliberately does not simulate any of that, so no test can
 * accidentally "prove" an authorization property against a mock.
 *
 * The Docker track's equivalent lives in `docker-fakes.ts` and is re-exported
 * here, so `@jumptotech/lab-orchestrator/testing` remains the single import for
 * every substrate's fake.
 */
import type {
  AuthorizationResult,
  ClusterEndpoint,
  ClusterVersion,
  ConfigMapSnapshot,
  CronJobSnapshot,
  DaemonSetSnapshot,
  DeploymentSnapshot,
  EndpointsSnapshot,
  HorizontalPodAutoscalerSnapshot,
  IngressSnapshot,
  JobSnapshot,
  KubernetesManifestObject,
  KubernetesPort,
  NamespaceSnapshot,
  NamespacedResourceRef,
  NetworkPolicySnapshot,
  NodeInfo,
  PersistentVolumeClaimSnapshot,
  PodSnapshot,
  RoleBindingSnapshot,
  RoleSnapshot,
  SecretSnapshot,
  ServiceAccountSnapshot,
  ServiceReachabilityResult,
  ServiceSnapshot,
  StatefulSetSnapshot,
  StorageClassSnapshot,
} from '../src/index.js';
import { KubernetesUnreachableError } from '../src/index.js';

export {
  FakeDockerDaemon,
  FakeDockerEngines,
  containerSpec,
  fakeMemoryBytes,
  type FakeDockerOperation,
  type FakeDockerOptions,
} from './docker-fakes.js';

export interface FakeK8sOptions {
  pods?: Record<string, PodSnapshot[]>;
  deployments?: Record<string, DeploymentSnapshot[]>;
  services?: Record<string, ServiceSnapshot[]>;
  configMaps?: Record<string, ConfigMapSnapshot[]>;
  secrets?: Record<string, SecretSnapshot[]>;
  jobs?: Record<string, JobSnapshot[]>;
  cronJobs?: Record<string, CronJobSnapshot[]>;
  roles?: Record<string, RoleSnapshot[]>;
  roleBindings?: Record<string, RoleBindingSnapshot[]>;
  serviceAccounts?: Record<string, ServiceAccountSnapshot[]>;
  persistentVolumeClaims?: Record<string, PersistentVolumeClaimSnapshot[]>;
  ingresses?: Record<string, IngressSnapshot[]>;
  networkPolicies?: Record<string, NetworkPolicySnapshot[]>;
  statefulSets?: Record<string, StatefulSetSnapshot[]>;
  daemonSets?: Record<string, DaemonSetSnapshot[]>;
  horizontalPodAutoscalers?: Record<string, HorizontalPodAutoscalerSnapshot[]>;
  storageClasses?: Record<string, StorageClassSnapshot>;
  sarResults?: Record<string, AuthorizationResult>;
  httpChecks?: Record<string, ServiceReachabilityResult>;
  tcpChecks?: Record<string, ServiceReachabilityResult>;
  resources?: Record<string, NamespacedResourceRef[]>;
  nodes?: NodeInfo[];
  /** Pre-existing namespaces, as `name` or `[name, labels]`. */
  namespaces?: Array<string | [string, Record<string, string>]>;
  version?: ClusterVersion;
  endpoint?: ClusterEndpoint;
  /** When set, every call rejects with this message. */
  unreachable?: string;
}

interface FakeNamespace {
  name: string;
  phase: string;
  labels: Record<string, string>;
}

export class FakeKubernetes implements KubernetesPort {
  pods: Map<string, PodSnapshot[]>;
  deployments: Map<string, DeploymentSnapshot[]>;
  services: Map<string, ServiceSnapshot[]>;
  configMaps: Map<string, ConfigMapSnapshot[]>;
  secrets: Map<string, SecretSnapshot[]>;
  jobs: Map<string, JobSnapshot[]>;
  cronJobs: Map<string, CronJobSnapshot[]>;
  roles: Map<string, RoleSnapshot[]>;
  roleBindings: Map<string, RoleBindingSnapshot[]>;
  serviceAccounts: Map<string, ServiceAccountSnapshot[]>;
  persistentVolumeClaims: Map<string, PersistentVolumeClaimSnapshot[]>;
  ingresses: Map<string, IngressSnapshot[]>;
  networkPolicies: Map<string, NetworkPolicySnapshot[]>;
  statefulSets: Map<string, StatefulSetSnapshot[]>;
  daemonSets: Map<string, DaemonSetSnapshot[]>;
  horizontalPodAutoscalers: Map<string, HorizontalPodAutoscalerSnapshot[]>;
  storageClasses: Map<string, StorageClassSnapshot>;
  sarResults: Map<string, AuthorizationResult>;
  httpChecks: Map<string, ServiceReachabilityResult>;
  tcpChecks: Map<string, ServiceReachabilityResult>;
  resources: Map<string, NamespacedResourceRef[]>;
  nodes: NodeInfo[];
  namespaces = new Map<string, FakeNamespace>();
  version_: ClusterVersion;
  endpoint: ClusterEndpoint;
  unreachable: string | undefined;

  /** Observability for assertions. */
  deleted: string[] = [];
  deletedNamespaces: string[] = [];
  /** namespace → manifests applied there, in order. */
  applied = new Map<string, KubernetesManifestObject[]>();
  tokenRequests: Array<{ namespace: string; serviceAccount: string; expirationSeconds: number }> = [];

  constructor(options: FakeK8sOptions = {}) {
    this.pods = new Map(Object.entries(options.pods ?? {}));
    this.deployments = new Map(Object.entries(options.deployments ?? {}));
    this.services = new Map(Object.entries(options.services ?? {}));
    this.configMaps = new Map(Object.entries(options.configMaps ?? {}));
    this.secrets = new Map(Object.entries(options.secrets ?? {}));
    this.jobs = new Map(Object.entries(options.jobs ?? {}));
    this.cronJobs = new Map(Object.entries(options.cronJobs ?? {}));
    this.roles = new Map(Object.entries(options.roles ?? {}));
    this.roleBindings = new Map(Object.entries(options.roleBindings ?? {}));
    this.serviceAccounts = new Map(Object.entries(options.serviceAccounts ?? {}));
    this.persistentVolumeClaims = new Map(Object.entries(options.persistentVolumeClaims ?? {}));
    this.ingresses = new Map(Object.entries(options.ingresses ?? {}));
    this.networkPolicies = new Map(Object.entries(options.networkPolicies ?? {}));
    this.statefulSets = new Map(Object.entries(options.statefulSets ?? {}));
    this.daemonSets = new Map(Object.entries(options.daemonSets ?? {}));
    this.horizontalPodAutoscalers = new Map(Object.entries(options.horizontalPodAutoscalers ?? {}));
    this.storageClasses = new Map(Object.entries(options.storageClasses ?? {}));
    this.sarResults = new Map(Object.entries(options.sarResults ?? {}));
    this.httpChecks = new Map(Object.entries(options.httpChecks ?? {}));
    this.tcpChecks = new Map(Object.entries(options.tcpChecks ?? {}));
    this.resources = new Map(Object.entries(options.resources ?? {}));
    this.nodes = options.nodes ?? [
      { name: 'jumptotech-labs-control-plane', ready: true, roles: ['control-plane'], version: 'v1.34.0' },
    ];
    for (const entry of options.namespaces ?? ['default', 'kube-system']) {
      const [name, labels] = typeof entry === 'string' ? [entry, {}] : entry;
      this.namespaces.set(name, { name, phase: 'Active', labels: { ...labels } });
    }
    this.version_ = options.version ?? { gitVersion: 'v1.34.0', major: '1', minor: '34' };
    this.endpoint = options.endpoint ?? {
      server: 'https://127.0.0.1:16443',
      certificateAuthorityData: Buffer.from('fake-ca').toString('base64'),
    };
    this.unreachable = options.unreachable;
  }

  #guard(): void {
    if (this.unreachable) throw new KubernetesUnreachableError(this.unreachable);
  }

  // --- cluster --------------------------------------------------------------

  async ping(): Promise<void> {
    this.#guard();
  }

  async version(): Promise<ClusterVersion> {
    this.#guard();
    return this.version_;
  }

  async listNodes(): Promise<NodeInfo[]> {
    this.#guard();
    return this.nodes;
  }

  clusterEndpoint(): ClusterEndpoint {
    return this.endpoint;
  }

  // --- namespaces -----------------------------------------------------------

  async namespaceExists(namespace: string): Promise<boolean> {
    this.#guard();
    return this.namespaces.has(namespace);
  }

  async getNamespace(namespace: string): Promise<NamespaceSnapshot | null> {
    this.#guard();
    const found = this.namespaces.get(namespace);
    return found ? { name: found.name, phase: found.phase, labels: { ...found.labels } } : null;
  }

  async createNamespace(namespace: string, labels: Record<string, string>): Promise<void> {
    this.#guard();
    if (this.namespaces.has(namespace)) return;
    this.namespaces.set(namespace, { name: namespace, phase: 'Active', labels: { ...labels } });
  }

  async deleteNamespace(namespace: string): Promise<void> {
    this.#guard();
    if (!this.namespaces.has(namespace)) return;
    this.deletedNamespaces.push(namespace);
    this.namespaces.delete(namespace);
    for (const map of [
      this.pods,
      this.deployments,
      this.services,
      this.configMaps,
      this.secrets,
      this.jobs,
      this.cronJobs,
      this.roles,
      this.roleBindings,
      this.serviceAccounts,
      this.persistentVolumeClaims,
      this.ingresses,
      this.networkPolicies,
      this.statefulSets,
      this.daemonSets,
      this.horizontalPodAutoscalers,
    ]) {
      (map as Map<string, unknown>).delete(namespace);
    }
    this.applied.delete(namespace);
    for (const key of [...this.resources.keys()]) {
      if (key.startsWith(`${namespace}/`)) this.resources.delete(key);
    }
  }

  async listNamespaces(labelSelector?: string): Promise<NamespaceSnapshot[]> {
    this.#guard();
    const all = [...this.namespaces.values()];
    const filtered = labelSelector
      ? all.filter((ns) => {
          const [key, value] = labelSelector.split('=');
          return key !== undefined && ns.labels[key] === value;
        })
      : all;
    return filtered.map((ns) => ({ name: ns.name, phase: ns.phase, labels: { ...ns.labels } }));
  }

  // --- reads ----------------------------------------------------------------

  async getPod(namespace: string, name: string): Promise<PodSnapshot | null> {
    this.#guard();
    return (this.pods.get(namespace) ?? []).find((p) => p.name === name) ?? null;
  }

  async listPods(namespace: string): Promise<PodSnapshot[]> {
    this.#guard();
    return [...(this.pods.get(namespace) ?? [])];
  }

  async getDeployment(namespace: string, name: string): Promise<DeploymentSnapshot | null> {
    this.#guard();
    return (this.deployments.get(namespace) ?? []).find((d) => d.name === name) ?? null;
  }

  async getService(namespace: string, name: string): Promise<ServiceSnapshot | null> {
    this.#guard();
    return (this.services.get(namespace) ?? []).find((s) => s.name === name) ?? null;
  }

  async getEndpoints(namespace: string, serviceName: string): Promise<EndpointsSnapshot | null> {
    this.#guard();
    const pods = this.pods.get(namespace) ?? [];
    return {
      serviceName,
      namespace,
      readyAddresses: pods.filter((p) => p.ready).length,
      notReadyAddresses: pods.filter((p) => !p.ready).length,
      targets: pods.map((p) => p.name),
    };
  }

  async getConfigMap(namespace: string, name: string): Promise<ConfigMapSnapshot | null> {
    this.#guard();
    return (this.configMaps.get(namespace) ?? []).find((c) => c.name === name) ?? null;
  }

  async getSecret(namespace: string, name: string): Promise<SecretSnapshot | null> {
    this.#guard();
    return (this.secrets.get(namespace) ?? []).find((s) => s.name === name) ?? null;
  }

  async getJob(namespace: string, name: string): Promise<JobSnapshot | null> {
    this.#guard();
    return (this.jobs.get(namespace) ?? []).find((j) => j.name === name) ?? null;
  }

  async getCronJob(namespace: string, name: string): Promise<CronJobSnapshot | null> {
    this.#guard();
    return (this.cronJobs.get(namespace) ?? []).find((c) => c.name === name) ?? null;
  }

  async getRole(namespace: string, name: string): Promise<RoleSnapshot | null> {
    this.#guard();
    return (this.roles.get(namespace) ?? []).find((r) => r.name === name) ?? null;
  }

  async getRoleBinding(namespace: string, name: string): Promise<RoleBindingSnapshot | null> {
    this.#guard();
    return (this.roleBindings.get(namespace) ?? []).find((r) => r.name === name) ?? null;
  }

  async getServiceAccount(namespace: string, name: string): Promise<ServiceAccountSnapshot | null> {
    this.#guard();
    return (this.serviceAccounts.get(namespace) ?? []).find((s) => s.name === name) ?? null;
  }

  async getPersistentVolumeClaim(
    namespace: string,
    name: string,
  ): Promise<PersistentVolumeClaimSnapshot | null> {
    this.#guard();
    return (this.persistentVolumeClaims.get(namespace) ?? []).find((p) => p.name === name) ?? null;
  }

  async getIngress(namespace: string, name: string): Promise<IngressSnapshot | null> {
    this.#guard();
    return (this.ingresses.get(namespace) ?? []).find((i) => i.name === name) ?? null;
  }

  async getNetworkPolicy(namespace: string, name: string): Promise<NetworkPolicySnapshot | null> {
    this.#guard();
    return (this.networkPolicies.get(namespace) ?? []).find((n) => n.name === name) ?? null;
  }

  async getStatefulSet(namespace: string, name: string): Promise<StatefulSetSnapshot | null> {
    this.#guard();
    return (this.statefulSets.get(namespace) ?? []).find((s) => s.name === name) ?? null;
  }

  async getDaemonSet(namespace: string, name: string): Promise<DaemonSetSnapshot | null> {
    this.#guard();
    return (this.daemonSets.get(namespace) ?? []).find((d) => d.name === name) ?? null;
  }

  async getHorizontalPodAutoscaler(
    namespace: string,
    name: string,
  ): Promise<HorizontalPodAutoscalerSnapshot | null> {
    this.#guard();
    return (this.horizontalPodAutoscalers.get(namespace) ?? []).find((h) => h.name === name) ?? null;
  }

  async getStorageClass(name: string): Promise<StorageClassSnapshot | null> {
    this.#guard();
    return this.storageClasses.get(name) ?? null;
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
    this.#guard();
    const key = [
      params.user,
      params.namespace,
      params.verb,
      params.apiGroup,
      params.resource,
      params.name ?? '*',
      params.subresource ?? '',
    ].join('|');
    return this.sarResults.get(key) ?? { allowed: false, reason: 'not configured in fake' };
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
    this.#guard();
    const key = `${namespace}/${service}:${port}${options.path ?? '/'}`;
    return this.httpChecks.get(key) ?? { ok: false, detail: 'HTTP check not configured in fake' };
  }

  async checkServiceTcp(
    namespace: string,
    service: string,
    port: number,
  ): Promise<ServiceReachabilityResult> {
    this.#guard();
    const key = `${namespace}/${service}:${port}`;
    return this.tcpChecks.get(key) ?? { ok: false, detail: 'TCP check not configured in fake' };
  }

  // --- writes ---------------------------------------------------------------

  async applyObjects(
    namespace: string,
    objects: KubernetesManifestObject[],
  ): Promise<NamespacedResourceRef[]> {
    this.#guard();
    const bucket = this.applied.get(namespace) ?? [];
    bucket.push(...objects);
    this.applied.set(namespace, bucket);
    return objects.map((o) => ({ resource: `${o.kind.toLowerCase()}s`, name: o.metadata.name }));
  }

  /** Manifests applied into a namespace, optionally narrowed to one kind. */
  appliedKinds(namespace: string, kind?: string): KubernetesManifestObject[] {
    const bucket = this.applied.get(namespace) ?? [];
    return kind ? bucket.filter((o) => o.kind === kind) : bucket;
  }

  async listNamespacedResources(
    namespace: string,
    resource: string,
  ): Promise<NamespacedResourceRef[]> {
    this.#guard();
    if (resource === 'pods') {
      return (this.pods.get(namespace) ?? []).map((p) => ({ resource: 'pods', name: p.name }));
    }
    return (this.resources.get(`${namespace}/${resource}`) ?? []).slice();
  }

  async deleteNamespacedResource(namespace: string, resource: string, name: string): Promise<void> {
    this.#guard();
    this.deleted.push(`${namespace}/${resource}/${name}`);
    if (resource === 'pods') {
      this.pods.set(namespace, (this.pods.get(namespace) ?? []).filter((p) => p.name !== name));
      return;
    }
    const key = `${namespace}/${resource}`;
    this.resources.set(key, (this.resources.get(key) ?? []).filter((r) => r.name !== name));
  }

  async countPods(namespace: string): Promise<number> {
    this.#guard();
    return (this.pods.get(namespace) ?? []).length;
  }

  async requestServiceAccountToken(
    namespace: string,
    serviceAccount: string,
    expirationSeconds: number,
  ): Promise<{ token: string; expirationTimestamp: string }> {
    this.#guard();
    this.tokenRequests.push({ namespace, serviceAccount, expirationSeconds });
    return {
      token: `fake-token-for-${namespace}-${serviceAccount}`,
      expirationTimestamp: new Date(1_000_000 + expirationSeconds * 1000).toISOString(),
    };
  }
}

/** Convenience builder for a healthy 3-replica Deployment snapshot. */
export function deploymentSnapshot(overrides: Partial<DeploymentSnapshot> = {}): DeploymentSnapshot {
  const desired = overrides.desiredReplicas ?? 3;
  return {
    name: 'frontend',
    namespace: 'lab-000000000001',
    desiredReplicas: desired,
    readyReplicas: desired,
    availableReplicas: desired,
    updatedReplicas: desired,
    currentReplicas: desired,
    labels: {},
    selector: { app: 'frontend' },
    podLabels: { app: 'frontend' },
    containers: [
      { name: 'web', image: 'nginx:stable', ready: true, restartCount: 0, state: 'running' },
    ],
    conditions: [{ type: 'Available', status: 'True' }],
    generation: 1,
    observedGeneration: 1,
    deleting: false,
    configRefs: [],
    ...overrides,
  };
}

/** Convenience builder for a Job that ran to completion. */
export function jobSnapshot(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    name: 'ledger-migration',
    namespace: 'lab-000000000001',
    completions: 1,
    parallelism: 1,
    succeeded: 1,
    failed: 0,
    active: 0,
    complete: true,
    failedCondition: false,
    labels: {},
    containers: [
      { name: 'task', image: 'nginx:stable', ready: false, restartCount: 0, state: 'terminated' },
    ],
    deleting: false,
    configRefs: [],
    ...overrides,
  };
}

export function cronJobSnapshot(overrides: Partial<CronJobSnapshot> = {}): CronJobSnapshot {
  return {
    name: 'reconciliation',
    namespace: 'lab-000000000001',
    schedule: '*/5 * * * *',
    suspend: false,
    concurrencyPolicy: 'Allow',
    activeJobs: 0,
    labels: {},
    containers: [
      { name: 'task', image: 'nginx:stable', ready: false, restartCount: 0, state: 'waiting' },
    ],
    deleting: false,
    configRefs: [],
    ...overrides,
  };
}

/** Convenience builder for a healthy nginx Pod snapshot. */
export function podSnapshot(overrides: Partial<PodSnapshot> = {}): PodSnapshot {
  const containers = overrides.containers ?? [
    {
      name: 'nginx',
      image: 'nginx:stable',
      imageRunning: 'docker.io/library/nginx:stable',
      ready: true,
      restartCount: 0,
      state: 'running',
    },
  ];
  return {
    name: 'nginx',
    namespace: 'lab-000000000001',
    phase: 'Running',
    labels: {},
    deleting: false,
    ready: containers.length > 0 && containers.every((c) => c.ready),
    ...overrides,
    containers,
  };
}
