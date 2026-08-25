/**
 * The narrow Kubernetes surface the lab engine needs.
 *
 * Defining a port (rather than passing `@kubernetes/client-node` around) means
 * the verifier registry, the session lifecycle, and the cleanup reaper can all
 * be unit-tested against an in-memory fake with no cluster, while production
 * code talks to a real API server.
 *
 * Every reader below returns a *snapshot*: a normalised, minimal view of the
 * object's spec and status. Verifier handlers reason about snapshots only, so
 * they cannot accidentally depend on client library shapes.
 */
import type { NodeInfo } from '../types.js';

/**
 * One configured probe.
 *
 * Probes are read from the *spec*, not from status: a lab that teaches
 * readiness asks whether the student configured a probe, and the answer must
 * not depend on whether the probe happens to be passing at the instant of the
 * check.
 */
export interface ProbeSnapshot {
  kind: 'liveness' | 'readiness' | 'startup';
  /** Which handler the probe uses. `unknown` when the spec sets none. */
  handler: 'httpGet' | 'tcpSocket' | 'exec' | 'grpc' | 'unknown';
  /** `httpGet.path`. */
  path?: string;
  /** `httpGet.port` / `tcpSocket.port` / `grpc.port` — a number or a port name. */
  port?: number | string;
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  failureThreshold?: number;
  successThreshold?: number;
}

/**
 * A ConfigMap or Secret a workload consumes.
 *
 * Records *that* configuration is externalised and how, which is the thing the
 * ConfigMap and Secret labs teach. Secret **values are never read** — only the
 * object name and, where the reference names one, the key.
 */
export interface ConfigReference {
  source: 'configmap' | 'secret';
  /** Name of the referenced ConfigMap / Secret. */
  name: string;
  /** Set for single-key references (`env.valueFrom`, volume `items`). */
  key?: string;
  /** How the workload consumes it. */
  via: 'env' | 'envFrom' | 'volume';
  /** Container carrying the reference. Absent for volume-level references. */
  container?: string;
}

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
  /** `spec.containers[].resources`, verbatim quantity strings. */
  resources?: ResourceRequirementsSnapshot;
  /** Probes declared on this container. Optional so older fixtures stay valid. */
  probes?: ProbeSnapshot[];
}

export interface ResourceRequirementsSnapshot {
  requests?: Record<string, string>;
  limits?: Record<string, string>;
}

export interface TolerationSnapshot {
  key: string;
  operator: string;
  effect?: string;
  value?: string;
}

export interface AffinityTermSnapshot {
  topologyKey: string;
  matchLabels: Record<string, string>;
}

export interface VolumeMountSnapshot {
  name: string;
  mountPath: string;
  /** PersistentVolumeClaim name when the volume uses a claim. */
  claimName?: string;
}

export interface PodSnapshot {
  name: string;
  namespace: string;
  /** `Pending` | `Running` | `Succeeded` | `Failed` | `Unknown`. */
  phase: string;
  labels: Record<string, string>;
  containers: ContainerSnapshot[];
  /** Set while the Pod is terminating. */
  deleting: boolean;
  /** True when every container reports Ready. */
  ready: boolean;
  /** ConfigMaps / Secrets this Pod consumes. */
  configRefs?: ConfigReference[];
  /** `spec.nodeName` when pinned. */
  nodeName?: string;
  /** `spec.nodeSelector`. */
  nodeSelector?: Record<string, string>;
  /** `spec.tolerations`. */
  tolerations?: TolerationSnapshot[];
  /** Node the kubelet scheduled the Pod onto. */
  scheduledNode?: string;
  /** Required pod affinity terms from the Pod spec. */
  requiredAffinity?: AffinityTermSnapshot[];
  /** Required pod anti-affinity terms from the Pod spec. */
  requiredAntiAffinity?: AffinityTermSnapshot[];
  /** Volume mounts from the Pod spec. */
  volumeMounts?: VolumeMountSnapshot[];
}

export interface DeploymentSnapshot {
  name: string;
  namespace: string;
  /** `spec.replicas`, defaulting to 1 when unset — the Kubernetes default. */
  desiredReplicas: number;
  readyReplicas: number;
  availableReplicas: number;
  updatedReplicas: number;
  /** `status.replicas` — total pods owned, including old ones mid-rollout. */
  currentReplicas: number;
  labels: Record<string, string>;
  /**
   * `metadata.annotations`, as the API reports them.
   *
   * Optional so every existing snapshot builder and test fake stays valid;
   * a reader that does not populate it is indistinguishable from an object
   * that carries none, which is the honest reading either way.
   */
  annotations?: Record<string, string>;
  selector: Record<string, string>;
  podLabels: Record<string, string>;
  containers: ContainerSnapshot[];
  conditions: Array<{ type: string; status: string; reason?: string; message?: string }>;
  generation: number;
  observedGeneration: number;
  deleting: boolean;
  /**
   * ConfigMaps / Secrets the Pod template consumes.
   *
   * Read from the template rather than from running Pods, so the check reflects
   * what the student declared.
   */
  configRefs?: ConfigReference[];
  /** Pod template `spec.nodeSelector`. */
  nodeSelector?: Record<string, string>;
  /** Pod template `spec.tolerations`. */
  tolerations?: TolerationSnapshot[];
  /** Pod template volume mounts. */
  volumeMounts?: VolumeMountSnapshot[];
}

/**
 * A Job, normalised around the question labs actually ask: did it finish?
 *
 * `complete` mirrors the `Complete` condition, which is the authoritative
 * signal — `succeeded` alone can be non-zero while a multi-completion Job is
 * still running.
 */
export interface JobSnapshot {
  name: string;
  namespace: string;
  /** `spec.completions`, defaulting to 1 — the Kubernetes default. */
  completions: number;
  parallelism: number;
  succeeded: number;
  failed: number;
  active: number;
  /** The `Complete` condition is True. */
  complete: boolean;
  /** The `Failed` condition is True. */
  failedCondition: boolean;
  /** Reason from the `Failed` condition, e.g. `BackoffLimitExceeded`. */
  failureReason?: string;
  labels: Record<string, string>;
  containers: ContainerSnapshot[];
  deleting: boolean;
  configRefs?: ConfigReference[];
}

export interface CronJobSnapshot {
  name: string;
  namespace: string;
  /** `spec.schedule`, verbatim — e.g. `*​/5 * * * *`. */
  schedule: string;
  suspend: boolean;
  /** `Allow` | `Forbid` | `Replace`. */
  concurrencyPolicy: string;
  /** Jobs the CronJob controller currently owns. */
  activeJobs: number;
  lastScheduleTime?: string;
  successfulJobsHistoryLimit?: number;
  failedJobsHistoryLimit?: number;
  labels: Record<string, string>;
  /** Containers from `spec.jobTemplate.spec.template.spec.containers`. */
  containers: ContainerSnapshot[];
  deleting: boolean;
  configRefs?: ConfigReference[];
}

export interface ServiceSnapshot {
  name: string;
  namespace: string;
  /** `ClusterIP` | `NodePort` | `LoadBalancer` | `ExternalName`. */
  type: string;
  clusterIP?: string;
  selector: Record<string, string>;
  ports: Array<{
    name?: string;
    port: number;
    targetPort?: number | string;
    protocol: string;
    nodePort?: number;
  }>;
}

/** Ready/not-ready backend addresses behind a Service. */
export interface EndpointsSnapshot {
  serviceName: string;
  namespace: string;
  readyAddresses: number;
  notReadyAddresses: number;
  /** Pod names behind the Service, where the API reports them. */
  targets: string[];
}

export interface ConfigMapSnapshot {
  name: string;
  namespace: string;
  data: Record<string, string>;
}

export interface SecretSnapshot {
  name: string;
  namespace: string;
  type: string;
  /** Key names only. Secret *values* are never read into the platform. */
  keys: string[];
}

export interface RoleRuleSnapshot {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
}

export interface RoleSnapshot {
  name: string;
  namespace: string;
  rules: RoleRuleSnapshot[];
  deleting: boolean;
}

export interface RoleBindingSubjectSnapshot {
  kind: string;
  name: string;
}

export interface RoleBindingSnapshot {
  name: string;
  namespace: string;
  roleRef: { kind: string; name: string; apiGroup: string };
  subjects: RoleBindingSubjectSnapshot[];
  deleting: boolean;
}

export interface ServiceAccountSnapshot {
  name: string;
  namespace: string;
  deleting: boolean;
}

export interface AuthorizationResult {
  allowed: boolean;
  reason?: string;
}

export interface PersistentVolumeClaimSnapshot {
  name: string;
  namespace: string;
  phase: string;
  storageClassName?: string;
  accessModes: string[];
  storage?: string;
  volumeMode?: string;
  deleting: boolean;
}

export interface StorageClassSnapshot {
  name: string;
  provisioner: string;
}

export interface IngressRuleSnapshot {
  host: string;
  path: string;
  pathType?: string;
  service: string;
  port: number | string;
}

export interface IngressTlsSnapshot {
  hosts: string[];
  secretName: string;
}

export interface IngressSnapshot {
  name: string;
  namespace: string;
  ingressClassName?: string;
  rules: IngressRuleSnapshot[];
  tls: IngressTlsSnapshot[];
  defaultBackend?: { service: string; port: number | string };
  deleting: boolean;
}

export interface NetworkPolicyPortSnapshot {
  port?: number;
  protocol?: string;
}

export interface NetworkPolicyPeerSnapshot {
  podSelector?: Record<string, string>;
  namespaceSelector?: Record<string, string>;
}

export interface NetworkPolicyRuleSnapshot {
  peers: NetworkPolicyPeerSnapshot[];
  ports: NetworkPolicyPortSnapshot[];
}

export interface NetworkPolicySnapshot {
  name: string;
  namespace: string;
  podSelector: Record<string, string>;
  policyTypes: string[];
  ingress: NetworkPolicyRuleSnapshot[];
  egress: NetworkPolicyRuleSnapshot[];
  deleting: boolean;
}

export interface StatefulSetVolumeClaimTemplateSnapshot {
  name: string;
  storageClassName?: string;
  accessModes: string[];
  storage?: string;
}

export interface StatefulSetSnapshot {
  name: string;
  namespace: string;
  desiredReplicas: number;
  readyReplicas: number;
  serviceName?: string;
  labels: Record<string, string>;
  /**
   * `metadata.annotations`, as the API reports them.
   *
   * Optional so every existing snapshot builder and test fake stays valid;
   * a reader that does not populate it is indistinguishable from an object
   * that carries none, which is the honest reading either way.
   */
  annotations?: Record<string, string>;
  selector: Record<string, string>;
  containers: ContainerSnapshot[];
  volumeClaimTemplates: StatefulSetVolumeClaimTemplateSnapshot[];
  volumeMounts?: VolumeMountSnapshot[];
  deleting: boolean;
}

export interface DaemonSetSnapshot {
  name: string;
  namespace: string;
  desiredScheduled: number;
  numberReady: number;
  selector: Record<string, string>;
  /**
   * `metadata.annotations`, as the API reports them.
   *
   * Optional so every existing snapshot builder and test fake stays valid;
   * a reader that does not populate it is indistinguishable from an object
   * that carries none, which is the honest reading either way.
   */
  annotations?: Record<string, string>;
  containers: ContainerSnapshot[];
  deleting: boolean;
}

export interface HorizontalPodAutoscalerSnapshot {
  name: string;
  namespace: string;
  minReplicas?: number;
  maxReplicas: number;
  targetKind: string;
  targetName: string;
  cpuAverageUtilization?: number;
  resourceMetrics: Array<{ resource: string; averageUtilization?: number }>;
  deleting: boolean;
}

export interface ServiceReachabilityResult {
  ok: boolean;
  detail?: string;
  statusCode?: number;
}

export interface NamespacedResourceRef {
  /** Plural resource name, e.g. `pods`, `deployments`. */
  resource: string;
  name: string;
}

export interface NamespaceSnapshot {
  name: string;
  phase: string;
  labels: Record<string, string>;
}

export interface ClusterVersion {
  gitVersion: string;
  major: string;
  minor: string;
}

/** Enough of the API server's identity to build a kubeconfig. */
export interface ClusterEndpoint {
  server: string;
  /** PEM certificate authority data, base64-encoded as kubeconfig expects. */
  certificateAuthorityData?: string;
  /** Set only when the cluster is contacted without CA verification. */
  insecureSkipTlsVerify?: boolean;
}

/** A Kubernetes object as parsed from a manifest, before it is applied. */
export interface KubernetesManifestObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> } & Record<
    string,
    unknown
  >;
  [key: string]: unknown;
}

export class KubernetesUnreachableError extends Error {
  readonly code = 'ENVIRONMENT_UNREACHABLE';
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'KubernetesUnreachableError';
  }
}

/** A manifest the API server rejected — a lab authoring bug, not an outage. */
export class ManifestApplyError extends Error {
  readonly code = 'SETUP_FAILED';
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ManifestApplyError';
  }
}

export interface KubernetesPort {
  // --- cluster ------------------------------------------------------------

  /** Cheap liveness probe against the API server. Throws when unreachable. */
  ping(): Promise<void>;
  version(): Promise<ClusterVersion>;
  listNodes(): Promise<NodeInfo[]>;
  /** Server address + CA, for minting namespace-scoped kubeconfigs. */
  clusterEndpoint(): ClusterEndpoint;

  // --- namespaces ---------------------------------------------------------

  namespaceExists(namespace: string): Promise<boolean>;
  getNamespace(namespace: string): Promise<NamespaceSnapshot | null>;
  createNamespace(namespace: string, labels: Record<string, string>): Promise<void>;
  deleteNamespace(namespace: string): Promise<void>;
  /** Namespaces carrying a label selector, e.g. the platform's ownership label. */
  listNamespaces(labelSelector?: string): Promise<NamespaceSnapshot[]>;

  // --- reads used by the verifier registry --------------------------------

  /** Returns `null` when the object does not exist (404). */
  getPod(namespace: string, name: string): Promise<PodSnapshot | null>;
  listPods(namespace: string, labelSelector?: string): Promise<PodSnapshot[]>;
  getDeployment(namespace: string, name: string): Promise<DeploymentSnapshot | null>;
  getService(namespace: string, name: string): Promise<ServiceSnapshot | null>;
  getEndpoints(namespace: string, serviceName: string): Promise<EndpointsSnapshot | null>;
  getConfigMap(namespace: string, name: string): Promise<ConfigMapSnapshot | null>;
  getSecret(namespace: string, name: string): Promise<SecretSnapshot | null>;
  getJob(namespace: string, name: string): Promise<JobSnapshot | null>;
  getCronJob(namespace: string, name: string): Promise<CronJobSnapshot | null>;
  getRole(namespace: string, name: string): Promise<RoleSnapshot | null>;
  getRoleBinding(namespace: string, name: string): Promise<RoleBindingSnapshot | null>;
  getServiceAccount(namespace: string, name: string): Promise<ServiceAccountSnapshot | null>;
  getPersistentVolumeClaim(namespace: string, name: string): Promise<PersistentVolumeClaimSnapshot | null>;
  getIngress(namespace: string, name: string): Promise<IngressSnapshot | null>;
  getNetworkPolicy(namespace: string, name: string): Promise<NetworkPolicySnapshot | null>;
  getStatefulSet(namespace: string, name: string): Promise<StatefulSetSnapshot | null>;
  getDaemonSet(namespace: string, name: string): Promise<DaemonSetSnapshot | null>;
  getHorizontalPodAutoscaler(namespace: string, name: string): Promise<HorizontalPodAutoscalerSnapshot | null>;
  getStorageClass(name: string): Promise<StorageClassSnapshot | null>;

  /** SubjectAccessReview against the API server (platform credentials). */
  createSubjectAccessReview(params: {
    namespace: string;
    user: string;
    verb: string;
    resource: string;
    apiGroup: string;
    name?: string;
    subresource?: string;
  }): Promise<AuthorizationResult>;

  /** HTTP GET to a Service ClusterIP in the session namespace. */
  checkServiceHttp(
    namespace: string,
    service: string,
    port: number,
    options?: { path?: string; expectedStatus?: number; bodyContains?: string; timeoutSeconds?: number },
  ): Promise<ServiceReachabilityResult>;

  /** TCP connect to a Service ClusterIP in the session namespace. */
  checkServiceTcp(
    namespace: string,
    service: string,
    port: number,
    options?: { timeoutSeconds?: number },
  ): Promise<ServiceReachabilityResult>;

  // --- writes used by setup / reset / isolation ---------------------------

  /**
   * Create-or-replace a set of objects in a namespace.
   *
   * Objects are forced into the target namespace by the caller, so a lab
   * manifest cannot place resources in someone else's sandbox.
   */
  applyObjects(namespace: string, objects: KubernetesManifestObject[]): Promise<NamespacedResourceRef[]>;

  /**
   * List objects of a supported plural resource in a namespace.
   * Unsupported resources resolve to an empty list rather than throwing, so a
   * lab definition naming an unknown kind degrades gracefully.
   */
  listNamespacedResources(namespace: string, resource: string): Promise<NamespacedResourceRef[]>;
  deleteNamespacedResource(namespace: string, resource: string, name: string): Promise<void>;

  /** Pods still present in the namespace, used to wait out termination. */
  countPods(namespace: string): Promise<number>;

  /** Mint a short-lived bound token for a ServiceAccount (TokenRequest API). */
  requestServiceAccountToken(
    namespace: string,
    serviceAccount: string,
    expirationSeconds: number,
  ): Promise<{ token: string; expirationTimestamp: string }>;
}
