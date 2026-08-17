/**
 * Core contracts for the lab engine.
 *
 * `LabProvider` is the seam that keeps the rest of the platform independent of
 * *how* a sandbox is produced. Today one implementation backs it — a namespace
 * inside a shared kind cluster. A future EKS / Firecracker / gVisor provider
 * implements this interface and nothing above it changes: not the API routes,
 * not the verifier, not React.
 *
 * The unit of isolation is a **session**, not a lab. Two students on the same
 * lab get two namespaces; one student cannot see, name, or reach the other's.
 */
import type { LoadedLabDefinition } from './lab-definition.js';
import type { SessionPolicy } from './session/types.js';
import type { WorkspacePort } from './workspace/port.js';

export type ProvisionStepStatus = 'pending' | 'ok' | 'failed';

/** One line of the "Preparing Kubernetes environment…" progress report. */
export interface ProvisionStep {
  id: string;
  label: string;
  status: ProvisionStepStatus;
  /** Human-readable detail — on failure this is the *actual* error text. */
  detail?: string;
  durationMs?: number;
}

export type EnvironmentPhase =
  | 'not_created'
  | 'provisioning'
  | 'ready'
  | 'degraded'
  | 'error';

export interface EnvironmentInfo {
  /** Opaque handle for this sandbox: provider, cluster, and namespace. */
  environmentId: string;
  provider: string;
  phase: EnvironmentPhase;
  /** The session's private namespace. */
  namespace: string;
  sessionId?: string;
  /**
   * One line describing the environment, written by the provider.
   *
   * Exists so the UI can show "what am I connected to?" without knowing which
   * provider produced it. A Kubernetes sandbox fills it with a version and a
   * node count; a workspace sandbox with a runtime version. The fields below
   * stay for callers that want the structured Kubernetes detail.
   */
  summary?: string;
  kubernetesVersion?: string;
  nodes?: NodeInfo[];
  message?: string;
}

export interface NodeInfo {
  name: string;
  ready: boolean;
  roles: string[];
  version: string;
}

export interface CreateResult {
  ok: boolean;
  environment: EnvironmentInfo;
  steps: ProvisionStep[];
  /** Present when `ok === false`; the real underlying failure. */
  error?: LabError;
}

export interface ResetResult {
  ok: boolean;
  /** Resources actually removed, as `kind/name`. */
  removed: string[];
  /** Setup manifests re-applied to restore the lab's starting condition. */
  restored: string[];
  steps: ProvisionStep[];
  environment: EnvironmentInfo;
  error?: LabError;
}

export interface LabError {
  code: LabErrorCode;
  message: string;
  /** Operator-facing remediation hint. Safe to show in the local MVP UI. */
  remediation?: string;
}

export type LabErrorCode =
  | 'ENVIRONMENT_UNREACHABLE'
  | 'ENVIRONMENT_NOT_CREATED'
  | 'KUBECTL_UNAVAILABLE'
  | 'PROVISION_FAILED'
  | 'SETUP_FAILED'
  | 'RESET_FAILED'
  | 'DESTROY_FAILED'
  | 'EXEC_FAILED'
  | 'CREDENTIALS_FAILED'
  | 'LAB_NOT_FOUND'
  | 'INVALID_LAB_ID'
  | 'VERIFICATION_FAILED';

export interface ExecRequest {
  /** Executable to run. Never passed through a shell. */
  command: string;
  args: string[];
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Everything a provider needs to act on one student's sandbox.
 *
 * Carrying the whole lab definition (rather than a handful of copied fields)
 * is what keeps providers data-driven: setup manifests, reset policy, and the
 * namespace all come from the definition the registry loaded.
 */
export interface LabSessionContext {
  sessionId: string;
  labId: string;
  /** Private namespace for this session. Derived, never client-supplied. */
  namespace: string;
  /** ServiceAccount the student's kubectl authenticates as. */
  serviceAccountName: string;
  lab: LoadedLabDefinition;
  /** Epoch ms after which the reaper may delete this sandbox. */
  expiresAtMs: number;
  /** Quota / LimitRange / NetworkPolicy shape for this session. */
  policy: SessionPolicy;
}

/**
 * What a student's shell is given, and nothing more.
 *
 * Handed to the terminal service over the internal, service-authenticated
 * route; never to the browser. The `kind` discriminator is what lets a single
 * terminal service serve every track: it decides how one PTY is configured and
 * carries no branch on lab id, track, or provider name.
 */
export type StudentCredentials = KubeconfigCredentials | WorkspaceCredentials;

/**
 * Kubernetes sandbox credentials.
 *
 * Authenticates as the session's ServiceAccount, whose rights stop at the
 * namespace edge, and carries a bound, short-lived token rather than a
 * long-lived secret.
 */
export interface KubeconfigCredentials {
  kind: 'kubeconfig';
  /** A complete kubeconfig YAML document scoped to the session namespace. */
  kubeconfig: string;
  namespace: string;
  serviceAccountName: string;
  /** ISO-8601 expiry of the embedded ServiceAccount token. */
  expiresAt: string;
}

/**
 * File-backed sandbox credentials.
 *
 * There is no token here, and deliberately so: a workspace lab gives the
 * student *no* cluster credential at all. What it gives them is a directory —
 * their own — plus the environment variables their shell should start with.
 *
 * `workspacePath` is a server-side path shared between the API and the terminal
 * service. It is not a capability (the terminal already authenticates to the
 * API with the internal secret to obtain it) and it never reaches a browser.
 */
export interface WorkspaceCredentials {
  kind: 'workspace';
  /** The session's isolation identifier, and the workspace directory name. */
  namespace: string;
  /** Absolute path of the session's private workspace. */
  workspacePath: string;
  /** Extra environment for the student's shell. Never contains a secret. */
  environment: Record<string, string>;
  /** ISO-8601 time after which this workspace may be reclaimed. */
  expiresAt: string;
}

export function isKubeconfigCredentials(
  credentials: StudentCredentials,
): credentials is KubeconfigCredentials {
  return credentials.kind === 'kubeconfig';
}

export function isWorkspaceCredentials(
  credentials: StudentCredentials,
): credentials is WorkspaceCredentials {
  return credentials.kind === 'workspace';
}

/** Outcome of tearing a sandbox down. */
export interface DestroyResult {
  ok: boolean;
  /**
   * True only when the namespace is *verifiably* absent from the cluster.
   *
   * Namespace deletion is asynchronous, so a successful delete call is not the
   * same as a deleted namespace. Session teardown only reaches ENDED/EXPIRED
   * once this is true, which is what makes the reaper safe to re-enter.
   */
  namespaceGone: boolean;
  steps: ProvisionStep[];
  error?: LabError;
}

/** A sandbox namespace as seen by the cleanup reaper. */
export interface ManagedNamespace {
  namespace: string;
  sessionId: string;
  labId: string;
  /** Epoch ms, parsed from the namespace label the provider wrote at creation. */
  expiresAtMs: number;
  phase: string;
}

/**
 * Read-only handles the verifier can use to observe one session's sandbox.
 *
 * Kubernetes evidence is deliberately absent: the API already holds one cluster
 * client and scopes reads by namespace, so there is nothing per-session for a
 * provider to hand over. A file-backed sandbox is different — its evidence *is*
 * a per-session object, bound to one directory — so this is how a provider
 * supplies it without any caller learning which provider produced it.
 */
export interface VerificationEvidence {
  workspace?: WorkspacePort;
}

/**
 * The sandbox lifecycle.
 *
 * Implementations must be idempotent: creating an already-existing sandbox
 * initialises it back to the lab's baseline rather than failing.
 */
export interface LabProvider {
  readonly name: string;

  /** Create the session sandbox: namespace, guardrails, lab initial state. */
  create(context: LabSessionContext): Promise<CreateResult>;

  /** Current health of the sandbox. Cheap enough to poll. */
  status(context: LabSessionContext): Promise<EnvironmentInfo>;

  /** Restore the sandbox to the lab's starting condition. */
  reset(context: LabSessionContext): Promise<ResetResult>;

  /** Tear the sandbox down entirely, and confirm the namespace is gone. */
  destroy(context: LabSessionContext): Promise<DestroyResult>;

  /**
   * Run a single non-interactive command in the sandbox context.
   *
   * Used by internal health checks ("does kubectl work?"). Deliberately NOT
   * wired to any REST endpoint — student commands travel through the separate
   * terminal service over an authenticated WebSocket.
   */
  execute(context: LabSessionContext, request: ExecRequest): Promise<ExecResult>;

  /** Mint sandbox-scoped credentials for the student's shell. */
  issueCredentials(context: LabSessionContext): Promise<StudentCredentials>;

  /**
   * Per-session read handles for verification.
   *
   * Optional: a provider whose sandbox the verifier can already reach (the
   * Kubernetes one) does not implement it.
   */
  verificationEvidence?(context: LabSessionContext): VerificationEvidence;

  /** Every sandbox this platform owns, for expiry and orphan cleanup. */
  listManagedNamespaces(): Promise<ManagedNamespace[]>;

  /**
   * Delete one sandbox namespace by name. Used by the reaper for orphans.
   *
   * Implementations MUST refuse any namespace that is not both name-shaped like
   * a lab sandbox and labelled as managed by this platform.
   */
  destroyNamespace(namespace: string, expectedSessionId?: string): Promise<DestroyResult>;
}
