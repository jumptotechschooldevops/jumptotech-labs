/**
 * Memoised, sandbox-scoped reads for one verification run.
 *
 * A lab typically asks several questions about the same thing ("does the
 * Deployment exist", "is its image right", "are three replicas available";
 * "does the workflow exist", "does it have a build job", "does that job check
 * the code out"). Without memoisation each of those would re-read the same
 * object or the same file, and worse, could observe *different* states mid-run
 * and produce a self-contradictory report. Reading each subject at most once
 * per run keeps a single check consistent with itself.
 *
 * The reader carries whichever evidence sources this session has: a Kubernetes
 * API scoped to one namespace, a workspace scoped to one directory, or both.
 * Neither is a method parameter, so a handler cannot read outside its own
 * session — it is never given the chance to name a namespace or a root.
 *
 * When a handler asks for a source the session does not have, that is not a
 * failed lab: it is a broken environment, and `EvidenceUnavailableError` is
 * raised so `verifyLab` can report it as such instead of blaming the student.
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
  WorkspacePort,
  WorkspaceStat,
  WorkspaceTaskId,
  WorkspaceTaskResult,
} from '@jumptotech/lab-orchestrator';

/** Raised when a check needs an evidence source this session does not have. */
export class EvidenceUnavailableError extends Error {
  readonly code = 'ENVIRONMENT_UNREACHABLE';
  constructor(readonly source: 'kubernetes' | 'workspace') {
    super(
      source === 'kubernetes'
        ? 'This check reads the Kubernetes API, but this session has no cluster environment attached.'
        : 'This check reads the session workspace, but this session has no workspace attached.',
    );
    this.name = 'EvidenceUnavailableError';
  }
}

export interface VerifyReaderOptions {
  /** Present for Kubernetes-backed sessions. */
  k8s?: KubernetesPort | undefined;
  /** Present for file-backed sessions. */
  workspace?: WorkspacePort | undefined;
  /** The session's isolation identifier — a namespace or a workspace name. */
  namespace: string;
}

export class VerifyReader {
  readonly #cache = new Map<string, Promise<unknown>>();
  readonly #k8s: KubernetesPort | undefined;
  readonly #workspace: WorkspacePort | undefined;
  readonly namespace: string;

  constructor(options: VerifyReaderOptions) {
    this.#k8s = options.k8s;
    this.#workspace = options.workspace;
    this.namespace = options.namespace;
  }

  get hasKubernetes(): boolean {
    return this.#k8s !== undefined;
  }

  get hasWorkspace(): boolean {
    return this.#workspace !== undefined;
  }

  #cluster(): KubernetesPort {
    if (!this.#k8s) throw new EvidenceUnavailableError('kubernetes');
    return this.#k8s;
  }

  #files(): WorkspacePort {
    if (!this.#workspace) throw new EvidenceUnavailableError('workspace');
    return this.#workspace;
  }

  #once<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.#cache.get(key);
    if (existing) return existing as Promise<T>;
    const promise = load();
    this.#cache.set(key, promise);
    return promise;
  }

  // --- Kubernetes ---------------------------------------------------------

  pod(name: string): Promise<PodSnapshot | null> {
    return this.#once(`pod/${name}`, () => this.#cluster().getPod(this.namespace, name));
  }

  deployment(name: string): Promise<DeploymentSnapshot | null> {
    return this.#once(`deployment/${name}`, () => this.#cluster().getDeployment(this.namespace, name));
  }

  service(name: string): Promise<ServiceSnapshot | null> {
    return this.#once(`service/${name}`, () => this.#cluster().getService(this.namespace, name));
  }

  endpoints(serviceName: string): Promise<EndpointsSnapshot | null> {
    return this.#once(`endpoints/${serviceName}`, () =>
      this.#cluster().getEndpoints(this.namespace, serviceName),
    );
  }

  configMap(name: string): Promise<ConfigMapSnapshot | null> {
    return this.#once(`configmap/${name}`, () => this.#cluster().getConfigMap(this.namespace, name));
  }

  secret(name: string): Promise<SecretSnapshot | null> {
    return this.#once(`secret/${name}`, () => this.#cluster().getSecret(this.namespace, name));
  }

  job(name: string): Promise<JobSnapshot | null> {
    return this.#once(`job/${name}`, () => this.#cluster().getJob(this.namespace, name));
  }

  cronJob(name: string): Promise<CronJobSnapshot | null> {
    return this.#once(`cronjob/${name}`, () => this.#cluster().getCronJob(this.namespace, name));
  }

  pods(labelSelector?: string): Promise<PodSnapshot[]> {
    return this.#once(`pods/${labelSelector ?? '*'}`, () =>
      this.#cluster().listPods(this.namespace, labelSelector),
    );
  }

  // --- workspace ----------------------------------------------------------

  fileStat(relativePath: string): Promise<WorkspaceStat | null> {
    return this.#once(`stat/${relativePath}`, () => this.#files().stat(relativePath));
  }

  fileText(relativePath: string): Promise<string | null> {
    return this.#once(`text/${relativePath}`, () => this.#files().readText(relativePath));
  }

  directory(relativePath: string): Promise<string[]> {
    return this.#once(`list/${relativePath}`, () => this.#files().list(relativePath));
  }

  /**
   * Run one allow-listed task, at most once per verification run.
   *
   * Memoisation matters more here than anywhere else: a lab that checks both
   * "the project builds" and "the build produced dist/bundle.js" must run the
   * build once, and both checks must be talking about that same run.
   */
  task(id: WorkspaceTaskId): Promise<WorkspaceTaskResult> {
    return this.#once(`task/${id}`, () => this.#files().runTask(id));
  }
}
