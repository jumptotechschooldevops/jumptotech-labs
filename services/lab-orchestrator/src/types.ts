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
 * Namespace-scoped credentials handed to the terminal service, never to the
 * browser.
 *
 * This is the *only* credential a student shell is ever given. It authenticates
 * as the session's ServiceAccount, whose rights stop at the namespace edge, and
 * it carries a bound, short-lived token rather than a long-lived secret.
 */
export interface StudentCredentials {
  /**
   * A complete kubeconfig YAML document scoped to the session namespace.
   *
   * Empty for sandboxes that have no Kubernetes API at all (the Ansible
   * track), which is deliberately different from "a kubeconfig we failed to
   * mint" — the terminal chooses how to attach from `shell`, not from whether
   * this string happens to be populated.
   */
  kubeconfig: string;
  namespace: string;
  serviceAccountName: string;
  /** ISO-8601 expiry of the credential. */
  expiresAt: string;
  /**
   * How the terminal service should attach a student to this sandbox.
   *
   * `local` (the default, and what every Kubernetes lab uses) means "spawn a
   * shell here with this kubeconfig". `ssh` means "open a session on the
   * sandbox's own control node with the key below".
   */
  shell?: 'local' | 'ssh';
  /** Present only when `shell` is `ssh`. */
  ssh?: SshCredentials;
}

/**
 * A session-scoped SSH credential.
 *
 * Minted per session, authorised on that session's containers only, and
 * destroyed with them. It is never persisted, never logged, and never returned
 * to the browser — the internal credential route is the only way to obtain it.
 */
export interface SshCredentials {
  /** Loopback address the control node's SSH port is published on. */
  host: string;
  port: number;
  user: string;
  /** PEM private key. Written 0600 by the terminal, removed when the PTY exits. */
  privateKey: string;
  /** Directory the shell should start in. */
  workdir?: string;
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

  /** Mint namespace-scoped credentials for the student's shell. */
  issueCredentials(context: LabSessionContext): Promise<StudentCredentials>;

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
