/**
 * Real `KubernetesPort` implementation backed by @kubernetes/client-node.
 *
 * All calls go through the Kubernetes API — we never shell out to `kubectl`
 * to *decide* anything, so verification results cannot be influenced by shell
 * parsing quirks or by what the student typed.
 */
import * as k8s from '@kubernetes/client-node';
import type { NodeInfo } from '../types.js';
import {
  KubernetesUnreachableError,
  type ClusterVersion,
  type KubernetesPort,
  type NamespacedResourceRef,
  type PodSnapshot,
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
  return typeof e?.message === 'string' ? e.message : String(error);
}

/** Wrap transport-level failures so callers can report the real cause. */
function asUnreachable(action: string, error: unknown): never {
  throw new KubernetesUnreachableError(
    `Kubernetes API call failed while ${action}: ${messageOf(error)}`,
    error,
  );
}

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
  readonly #version: k8s.VersionApi;
  readonly #handlers: Map<string, ResourceHandlers>;
  readonly #serverUrl: string;

  constructor(options: KubernetesClientOptions = {}) {
    const kc = new k8s.KubeConfig();
    if (options.kubeconfigPath) {
      kc.loadFromFile(options.kubeconfigPath);
    } else {
      kc.loadFromDefault();
    }
    if (options.context) kc.setCurrentContext(options.context);

    this.#serverUrl = kc.getCurrentCluster()?.server ?? '<unknown>';
    this.#core = kc.makeApiClient(k8s.CoreV1Api);
    this.#apps = kc.makeApiClient(k8s.AppsV1Api);
    this.#batch = kc.makeApiClient(k8s.BatchV1Api);
    this.#version = kc.makeApiClient(k8s.VersionApi);
    this.#handlers = this.#buildHandlers();
  }

  get serverUrl(): string {
    return this.#serverUrl;
  }

  #buildHandlers(): Map<string, ResourceHandlers> {
    const core = this.#core;
    const apps = this.#apps;
    const batch = this.#batch;
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
    ]);
  }

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

  async namespaceExists(namespace: string): Promise<boolean> {
    try {
      await this.#core.readNamespace({ name: namespace });
      return true;
    } catch (error) {
      if (statusCodeOf(error) === 404) return false;
      asUnreachable(`reading namespace ${namespace}`, error);
    }
  }

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

  async listNamespacedResources(
    namespace: string,
    resource: string,
  ): Promise<NamespacedResourceRef[]> {
    const handler = this.#handlers.get(resource);
    // Unknown kinds are ignored rather than fatal: a lab definition can name a
    // resource this MVP does not manage yet without breaking Reset.
    if (!handler) return [];
    try {
      const names = await handler.list(namespace);
      return names.map((name) => ({ resource, name }));
    } catch (error) {
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
      asUnreachable(`counting pods in ${namespace}`, error);
    }
  }
}

/** Normalise a V1Pod into the minimal snapshot the lab engine reasons about. */
export function toPodSnapshot(pod: k8s.V1Pod, namespace: string, name: string): PodSnapshot {
  const statuses = new Map(
    (pod.status?.containerStatuses ?? []).map((s) => [s.name, s] as const),
  );

  const containers = (pod.spec?.containers ?? []).map((container) => {
    const status = statuses.get(container.name);
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
    return {
      name: container.name,
      image: container.image ?? '',
      imageRunning: status?.image,
      ready: status?.ready ?? false,
      restartCount: status?.restartCount ?? 0,
      state,
      reason,
    };
  });

  return {
    name: pod.metadata?.name ?? name,
    namespace: pod.metadata?.namespace ?? namespace,
    phase: pod.status?.phase ?? 'Unknown',
    containers,
    deleting: Boolean(pod.metadata?.deletionTimestamp),
  };
}
