/**
 * Shared in-memory Kubernetes fake.
 *
 * Implements the whole `KubernetesPort`, so provider, session, reaper, and
 * verifier logic can be exercised without a cluster. Anything that genuinely
 * needs the API server's *behaviour* — RBAC decisions, quota admission,
 * namespace finalisation — is tested against real kind in `integration.test.ts`
 * instead; this fake deliberately does not simulate any of that, so no test can
 * accidentally "prove" an authorization property against a mock.
 */
import type {
  ClusterEndpoint,
  ClusterVersion,
  ConfigMapSnapshot,
  DeploymentSnapshot,
  EndpointsSnapshot,
  KubernetesManifestObject,
  KubernetesPort,
  NamespaceSnapshot,
  NamespacedResourceRef,
  NodeInfo,
  PodSnapshot,
  SecretSnapshot,
  ServiceSnapshot,
} from '../src/index.js';
import { KubernetesUnreachableError } from '../src/index.js';

export interface FakeK8sOptions {
  pods?: Record<string, PodSnapshot[]>;
  deployments?: Record<string, DeploymentSnapshot[]>;
  services?: Record<string, ServiceSnapshot[]>;
  configMaps?: Record<string, ConfigMapSnapshot[]>;
  secrets?: Record<string, SecretSnapshot[]>;
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
    for (const map of [this.pods, this.deployments, this.services, this.configMaps, this.secrets]) {
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
