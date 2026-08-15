/**
 * Core contracts for the lab engine.
 *
 * The `LabProvider` interface is the seam that keeps the rest of the platform
 * independent of *how* a sandbox is produced. PLATFORM-001 ships a single
 * implementation backed by a local `kind` cluster; a future story can add an
 * EKS / Firecracker / gVisor provider by implementing this interface only.
 * Nothing above this interface (API routes, verifier, frontend) knows that
 * kind exists.
 */

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
  /** Opaque handle for this sandbox, e.g. the cluster/namespace pair. */
  environmentId: string;
  provider: string;
  phase: EnvironmentPhase;
  /** Namespace the student works in. */
  namespace: string;
  /** Populated once the environment is reachable. */
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
  | 'RESET_FAILED'
  | 'DESTROY_FAILED'
  | 'EXEC_FAILED'
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
 * The provider abstraction required by PLATFORM-001.
 *
 * Implementations must be idempotent: `create()` on an already-running
 * sandbox initialises it back to the lab's baseline rather than failing.
 */
export interface LabProvider {
  readonly name: string;

  /** Create or initialise the sandbox for a lab, returning step-by-step progress. */
  create(context: LabContext): Promise<CreateResult>;

  /** Current health of the sandbox. Cheap enough to poll. */
  status(context: LabContext): Promise<EnvironmentInfo>;

  /** Restore the sandbox to the lab's baseline state. */
  reset(context: LabContext): Promise<ResetResult>;

  /** Tear the sandbox down entirely. */
  destroy(context: LabContext): Promise<{ ok: boolean; error?: LabError }>;

  /**
   * Run a single non-interactive command inside the sandbox context.
   *
   * Used by internal health checks (e.g. "does kubectl work?"). It is
   * deliberately NOT wired to any REST endpoint — student commands travel
   * through the separate terminal service over an authenticated WebSocket.
   */
  execute(context: LabContext, request: ExecRequest): Promise<ExecResult>;
}

/** Everything a provider needs to act on a specific lab. */
export interface LabContext {
  labId: string;
  namespace: string;
  /** Resources the reset routine is allowed to purge. */
  purgeResources: string[];
  protectedResources: string[];
}
