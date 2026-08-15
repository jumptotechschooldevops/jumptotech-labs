/**
 * The narrow Kubernetes surface the lab engine needs.
 *
 * Defining a port (rather than passing `@kubernetes/client-node` around)
 * means the verifier and reset logic can be unit-tested against fakes with no
 * cluster, while production code talks to a real API server.
 */
import type { NodeInfo } from '../types.js';

export interface ContainerSnapshot {
  name: string;
  /** Image as declared in `spec.containers[].image`. */
  image: string;
  /** Image actually reported by the kubelet, when available. */
  imageRunning?: string;
  ready: boolean;
  restartCount: number;
  /** e.g. `running`, `waiting`, `terminated`. */
  state: string;
  /** e.g. `ImagePullBackOff`, `CrashLoopBackOff`. */
  reason?: string;
}

export interface PodSnapshot {
  name: string;
  namespace: string;
  /** `Pending` | `Running` | `Succeeded` | `Failed` | `Unknown`. */
  phase: string;
  containers: ContainerSnapshot[];
  /** Set while the Pod is terminating. */
  deleting: boolean;
}

export interface NamespacedResourceRef {
  /** Plural resource name, e.g. `pods`, `deployments`. */
  resource: string;
  name: string;
}

export interface ClusterVersion {
  gitVersion: string;
  major: string;
  minor: string;
}

export class KubernetesUnreachableError extends Error {
  readonly code = 'ENVIRONMENT_UNREACHABLE';
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'KubernetesUnreachableError';
  }
}

export interface KubernetesPort {
  /** Cheap liveness probe against the API server. Throws when unreachable. */
  ping(): Promise<void>;

  version(): Promise<ClusterVersion>;

  listNodes(): Promise<NodeInfo[]>;

  namespaceExists(namespace: string): Promise<boolean>;

  /** Returns `null` when the Pod does not exist (404). */
  getPod(namespace: string, name: string): Promise<PodSnapshot | null>;

  /**
   * List objects of a supported plural resource in a namespace.
   * Unsupported resources resolve to an empty list rather than throwing, so a
   * lab definition naming an unknown kind degrades gracefully.
   */
  listNamespacedResources(namespace: string, resource: string): Promise<NamespacedResourceRef[]>;

  deleteNamespacedResource(namespace: string, resource: string, name: string): Promise<void>;

  /** Pods still present in the namespace, used to wait out termination. */
  countPods(namespace: string): Promise<number>;
}
