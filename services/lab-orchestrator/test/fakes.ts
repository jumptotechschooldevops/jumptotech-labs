/** Shared in-memory Kubernetes fake for unit tests. */
import type {
  ClusterVersion,
  KubernetesPort,
  NamespacedResourceRef,
  NodeInfo,
  PodSnapshot,
} from '../src/index.js';
import { KubernetesUnreachableError } from '../src/index.js';

export interface FakeK8sOptions {
  pods?: Record<string, PodSnapshot[]>;
  resources?: Record<string, NamespacedResourceRef[]>;
  nodes?: NodeInfo[];
  namespaces?: string[];
  version?: ClusterVersion;
  /** When set, every call rejects with this message. */
  unreachable?: string;
}

export class FakeKubernetes implements KubernetesPort {
  pods: Map<string, PodSnapshot[]>;
  resources: Map<string, NamespacedResourceRef[]>;
  nodes: NodeInfo[];
  namespaces: Set<string>;
  version_: ClusterVersion;
  unreachable: string | undefined;
  deleted: string[] = [];

  constructor(options: FakeK8sOptions = {}) {
    this.pods = new Map(Object.entries(options.pods ?? { default: [] }));
    this.resources = new Map(Object.entries(options.resources ?? {}));
    this.nodes = options.nodes ?? [
      { name: 'jumptotech-labs-control-plane', ready: true, roles: ['control-plane'], version: 'v1.34.0' },
    ];
    this.namespaces = new Set(options.namespaces ?? ['default', 'kube-system']);
    this.version_ = options.version ?? { gitVersion: 'v1.34.0', major: '1', minor: '34' };
    this.unreachable = options.unreachable;
  }

  #guard(): void {
    if (this.unreachable) throw new KubernetesUnreachableError(this.unreachable);
  }

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

  async namespaceExists(namespace: string): Promise<boolean> {
    this.#guard();
    return this.namespaces.has(namespace);
  }

  async getPod(namespace: string, name: string): Promise<PodSnapshot | null> {
    this.#guard();
    return (this.pods.get(namespace) ?? []).find((p) => p.name === name) ?? null;
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
}

/** Convenience builder for a healthy nginx Pod snapshot. */
export function podSnapshot(overrides: Partial<PodSnapshot> = {}): PodSnapshot {
  return {
    name: 'nginx',
    namespace: 'default',
    phase: 'Running',
    deleting: false,
    containers: [
      {
        name: 'nginx',
        image: 'nginx:stable',
        imageRunning: 'docker.io/library/nginx:stable',
        ready: true,
        restartCount: 0,
        state: 'running',
      },
    ],
    ...overrides,
  };
}
