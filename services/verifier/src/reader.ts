/**
 * Memoised, namespace-scoped reads for one verification run.
 *
 * A lab typically asks several questions about the same object ("does the
 * Deployment exist", "is its image right", "are three replicas available").
 * Without memoisation each of those would re-read the same object, and worse,
 * could observe *different* states mid-rollout and produce a self-contradictory
 * report. Reading each object at most once per run keeps a single check
 * consistent with itself.
 *
 * The namespace is fixed at construction. A handler cannot read outside the
 * session's own namespace, because it is never given the chance to name one.
 */
import type {
  ConfigMapSnapshot,
  CronJobSnapshot,
  DeploymentSnapshot,
  EndpointsSnapshot,
  JobSnapshot,
  KubernetesPort,
  PodSnapshot,
  SecretSnapshot,
  ServiceSnapshot,
} from '@jumptotech/lab-orchestrator';

export class VerifyReader {
  readonly #cache = new Map<string, Promise<unknown>>();

  constructor(
    private readonly k8s: KubernetesPort,
    readonly namespace: string,
  ) {}

  #once<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.#cache.get(key);
    if (existing) return existing as Promise<T>;
    const promise = load();
    this.#cache.set(key, promise);
    return promise;
  }

  pod(name: string): Promise<PodSnapshot | null> {
    return this.#once(`pod/${name}`, () => this.k8s.getPod(this.namespace, name));
  }

  deployment(name: string): Promise<DeploymentSnapshot | null> {
    return this.#once(`deployment/${name}`, () => this.k8s.getDeployment(this.namespace, name));
  }

  service(name: string): Promise<ServiceSnapshot | null> {
    return this.#once(`service/${name}`, () => this.k8s.getService(this.namespace, name));
  }

  endpoints(serviceName: string): Promise<EndpointsSnapshot | null> {
    return this.#once(`endpoints/${serviceName}`, () =>
      this.k8s.getEndpoints(this.namespace, serviceName),
    );
  }

  configMap(name: string): Promise<ConfigMapSnapshot | null> {
    return this.#once(`configmap/${name}`, () => this.k8s.getConfigMap(this.namespace, name));
  }

  secret(name: string): Promise<SecretSnapshot | null> {
    return this.#once(`secret/${name}`, () => this.k8s.getSecret(this.namespace, name));
  }

  job(name: string): Promise<JobSnapshot | null> {
    return this.#once(`job/${name}`, () => this.k8s.getJob(this.namespace, name));
  }

  cronJob(name: string): Promise<CronJobSnapshot | null> {
    return this.#once(`cronjob/${name}`, () => this.k8s.getCronJob(this.namespace, name));
  }

  pods(labelSelector?: string): Promise<PodSnapshot[]> {
    return this.#once(`pods/${labelSelector ?? '*'}`, () =>
      this.k8s.listPods(this.namespace, labelSelector),
    );
  }
}
