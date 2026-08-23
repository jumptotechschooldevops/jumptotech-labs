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
  AuthorizationResult,
  ConfigMapSnapshot,
  CronJobSnapshot,
  DaemonSetSnapshot,
  DeploymentSnapshot,
  EndpointsSnapshot,
  HorizontalPodAutoscalerSnapshot,
  IngressSnapshot,
  JobSnapshot,
  KubernetesPort,
  NetworkPolicySnapshot,
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

  role(name: string): Promise<RoleSnapshot | null> {
    return this.#once(`role/${name}`, () => this.k8s.getRole(this.namespace, name));
  }

  roleBinding(name: string): Promise<RoleBindingSnapshot | null> {
    return this.#once(`rolebinding/${name}`, () => this.k8s.getRoleBinding(this.namespace, name));
  }

  serviceAccount(name: string): Promise<ServiceAccountSnapshot | null> {
    return this.#once(`serviceaccount/${name}`, () =>
      this.k8s.getServiceAccount(this.namespace, name),
    );
  }

  persistentVolumeClaim(name: string): Promise<PersistentVolumeClaimSnapshot | null> {
    return this.#once(`pvc/${name}`, () => this.k8s.getPersistentVolumeClaim(this.namespace, name));
  }

  ingress(name: string): Promise<IngressSnapshot | null> {
    return this.#once(`ingress/${name}`, () => this.k8s.getIngress(this.namespace, name));
  }

  networkPolicy(name: string): Promise<NetworkPolicySnapshot | null> {
    return this.#once(`networkpolicy/${name}`, () => this.k8s.getNetworkPolicy(this.namespace, name));
  }

  statefulSet(name: string): Promise<StatefulSetSnapshot | null> {
    return this.#once(`statefulset/${name}`, () => this.k8s.getStatefulSet(this.namespace, name));
  }

  daemonSet(name: string): Promise<DaemonSetSnapshot | null> {
    return this.#once(`daemonset/${name}`, () => this.k8s.getDaemonSet(this.namespace, name));
  }

  horizontalPodAutoscaler(name: string): Promise<HorizontalPodAutoscalerSnapshot | null> {
    return this.#once(`hpa/${name}`, () => this.k8s.getHorizontalPodAutoscaler(this.namespace, name));
  }

  storageClass(name: string): Promise<StorageClassSnapshot | null> {
    return this.#once(`storageclass/${name}`, () => this.k8s.getStorageClass(name));
  }

  pods(labelSelector?: string): Promise<PodSnapshot[]> {
    return this.#once(`pods/${labelSelector ?? '*'}`, () =>
      this.k8s.listPods(this.namespace, labelSelector),
    );
  }

  checkAuthorization(params: {
    serviceAccount: string;
    verb: string;
    resource: string;
    apiGroup: string;
    name?: string;
    subresource?: string;
  }): Promise<AuthorizationResult> {
    const key = [
      'sar',
      params.serviceAccount,
      params.verb,
      params.resource,
      params.apiGroup,
      params.name ?? '',
      params.subresource ?? '',
    ].join('|');
    return this.#once(key, () =>
      this.k8s.createSubjectAccessReview({
        namespace: this.namespace,
        user: `system:serviceaccount:${this.namespace}:${params.serviceAccount}`,
        verb: params.verb,
        resource: params.resource,
        apiGroup: params.apiGroup,
        ...(params.name !== undefined ? { name: params.name } : {}),
        ...(params.subresource !== undefined ? { subresource: params.subresource } : {}),
      }),
    );
  }

  checkHttp(
    service: string,
    port: number,
    options?: {
      path?: string;
      expectedStatus?: number;
      bodyContains?: string;
      timeoutSeconds?: number;
    },
  ): Promise<ServiceReachabilityResult> {
    const key = ['http', service, String(port), options?.path ?? '/', String(options?.expectedStatus ?? 200)].join('|');
    return this.#once(key, () => this.k8s.checkServiceHttp(this.namespace, service, port, options));
  }

  checkTcp(
    service: string,
    port: number,
    options?: { timeoutSeconds?: number },
  ): Promise<ServiceReachabilityResult> {
    const key = ['tcp', service, String(port)].join('|');
    return this.#once(key, () => this.k8s.checkServiceTcp(this.namespace, service, port, options));
  }
}
