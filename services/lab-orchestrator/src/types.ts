/**
 * Core contracts for the lab engine.
 *
 * `LabProvider` is the seam that keeps the rest of the platform independent of
 * *how* a sandbox is produced. PLATFORM-004 generalised it: a sandbox is a
 * namespace for a Kubernetes lab, a container for a Linux or Terraform lab,
 * and (later) a scoped cloud session for an AWS lab. Everything above this
 * interface — API routes, the verifier, the terminal binding, React — works in
 * terms of a *session* and a *sandbox reference*, never in terms of Kubernetes.
 *
 * The unit of isolation is a **session**, not a lab. Two students on the same
 * lab get two sandboxes; one student cannot see, name, or reach the other's.
 */
import type { LoadedLabDefinition } from './lab-definition.js';
import type { SessionPolicy } from './session/types.js';
import type { LabProviderId, ProviderAvailability, SandboxKind } from './providers/catalog.js';

export type {
  LabProviderId,
  ProviderAvailability,
  SandboxKind,
  IsolationMode,
} from './providers/catalog.js';

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
  /** Opaque handle for this sandbox: provider, substrate, and sandbox ref. */
  environmentId: string;
  /** Implementation name, e.g. `kind`, `docker`. */
  provider: string;
  /** The lab-facing provider id this sandbox satisfies, e.g. `kubernetes`. */
  providerId?: LabProviderId;
  phase: EnvironmentPhase;
  /**
   * The session's private sandbox handle: a namespace, a container name, …
   *
   * Always derived server-side from the session id. Never client-supplied, and
   * never accepted as an input by any endpoint.
   */
  sandboxRef?: string;
  sandboxKind?: SandboxKind;
  /**
   * The session's private namespace.
   *
   * Kubernetes' view of `sandboxRef`. Kept as a distinct field so Kubernetes
   * code and the existing API payload read naturally; for a container-backed
   * provider it carries the same derived sandbox id and means nothing.
   */
  namespace: string;
  sessionId?: string;
  kubernetesVersion?: string;
  nodes?: NodeInfo[];
  /** Sandbox image, for container-backed providers. */
  image?: string;
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
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_NOT_REGISTERED'
  | 'VERIFICATION_FAILED';

/**
 * A provider was asked to do something it cannot do here.
 *
 * Distinct from a runtime failure: this means the *capability* is missing
 * (Docker is not reachable, the sandbox image was never built, the provider is
 * architecture-only). The catalog reports it up front so a student never
 * clicks Start Lab on something that was never going to run.
 */
export class ProviderUnavailableError extends Error {
  readonly code = 'PROVIDER_UNAVAILABLE';
  constructor(
    readonly providerId: string,
    reason: string,
    readonly remediation?: string,
  ) {
    super(`Provider '${providerId}' is not available: ${reason}`);
    this.name = 'ProviderUnavailableError';
  }
}

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
  /**
   * Private sandbox handle for this session. Derived server-side from the
   * session id through a keyed HMAC; never client-supplied.
   *
   * Kubernetes reads it as a namespace, the container providers as a container
   * name. It is the same derived `lab-<hex>` id in both cases, which is why
   * `namespace` below is an alias rather than a second identity.
   */
  sandboxRef?: string;
  /** Private namespace for this session. Kubernetes' view of `sandboxRef`. */
  namespace: string;
  /** ServiceAccount the student's kubectl authenticates as. */
  serviceAccountName: string;
  lab: LoadedLabDefinition;
  /** Epoch ms after which the reaper may delete this sandbox. */
  expiresAtMs: number;
  /** Quota / LimitRange / NetworkPolicy / container-limit shape for this session. */
  policy: SessionPolicy;
}

/** The sandbox handle for a context, whichever field carries it. */
export function sandboxRefOf(context: LabSessionContext): string {
  return context.sandboxRef ?? context.namespace;
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
  /** A complete kubeconfig YAML document scoped to the session namespace. */
  kubeconfig: string;
  namespace: string;
  serviceAccountName: string;
  /** ISO-8601 expiry of the embedded ServiceAccount token. */
  expiresAt: string;
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

/**
 * The terminal binding for one session.
 *
 * The terminal service never learns *what to run* from the browser. It presents
 * a signed session token, and the API answers with one of these — resolved
 * server-side from the session record. The union is deliberately closed and
 * carries no command line: the terminal service builds the argv itself from the
 * variant, after re-validating every field it was given. Nothing here can turn
 * into "run this string".
 */
export type TerminalContext =
  /** A local PTY holding a namespace-scoped kubeconfig (Kubernetes labs). */
  | {
      kind: 'kubernetes';
      /** A complete kubeconfig YAML document scoped to the session namespace. */
      kubeconfig: string;
      namespace: string;
      serviceAccountName: string;
      /** ISO-8601 expiry of the embedded ServiceAccount token. */
      expiresAt: string;
      /** Extra environment for the shell. Never secrets. */
      env?: Record<string, string>;
    }
  /** A PTY attached to this session's sandbox container (Linux/Terraform). */
  | {
      kind: 'container-exec';
      /** Only `docker` today; the terminal service allow-lists this value. */
      runtime: 'docker';
      /** The session's container. Validated by name shape on both sides. */
      containerRef: string;
      /** Unprivileged user inside the container, e.g. `student`. */
      user: string;
      workdir: string;
      env?: Record<string, string>;
      expiresAt: string;
    };

/** A sandbox as seen by the cleanup reaper, whatever produced it. */
export interface ManagedSandbox {
  /** Which provider owns it. */
  providerId: LabProviderId;
  /** Namespace name, container name, … */
  sandboxRef: string;
  sandboxKind: SandboxKind;
  sessionId: string;
  labId: string;
  /** Epoch ms, parsed from the label the provider wrote at creation. */
  expiresAtMs: number;
  phase: string;
}

/** A sandbox namespace as seen by the cleanup reaper (Kubernetes-specific). */
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
  /** Lab-facing provider id, as declared by `environment.provider` in lab.yaml. */
  readonly id: LabProviderId;
  /** Implementation name, e.g. `kind`, `docker`. Shown to operators only. */
  readonly name: string;
  /** What this provider's sandbox physically is. */
  readonly sandboxKind: SandboxKind;

  /**
   * Can this provider actually run a lab right now?
   *
   * Cheap and cached by the registry. A provider that is architecture-only
   * (AWS today) reports `available: false` forever; a provider that needs a
   * container runtime reports why it cannot reach one.
   */
  availability(): Promise<ProviderAvailability>;

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

  /**
   * Everything the terminal service needs to open a shell into this sandbox.
   *
   * Resolved entirely from the session record. The browser contributes nothing
   * to it — not a container id, not a namespace, not a kubeconfig path.
   */
  getTerminalContext(context: LabSessionContext): Promise<TerminalContext>;

  /** Every sandbox this provider owns, for expiry and orphan cleanup. */
  listManagedSandboxes(): Promise<ManagedSandbox[]>;

  /**
   * Delete one sandbox by reference. Used by the reaper for orphans.
   *
   * Implementations MUST refuse any reference that is not both name-shaped like
   * a lab sandbox and labelled as managed by this platform.
   */
  destroySandbox(sandboxRef: string, expectedSessionId?: string): Promise<DestroyResult>;

  /**
   * Read a file from inside the sandbox, for state-based verification.
   *
   * Only providers whose labs declare filesystem or Terraform requirements
   * implement this; Kubernetes labs verify through the Kubernetes API instead.
   * Paths are resolved against the sandbox root and re-checked for traversal by
   * the implementation, never trusted from a lab definition alone.
   */
  readSandboxPath?(
    context: LabSessionContext,
    relativePath: string,
    options?: { maxBytes?: number },
  ): Promise<SandboxPathRead | null>;
}

/** What a sandbox path looks like on disk, as seen from inside the sandbox. */
export interface SandboxPathRead {
  /** `file` | `directory` | `symlink` | `other`. */
  type: 'file' | 'directory' | 'symlink' | 'other';
  /** Octal permission bits without a leading zero, e.g. `750`. */
  mode: string;
  owner: string;
  group: string;
  sizeBytes: number;
  /** Present only for regular files that were read. */
  content?: string;
  /** True when the file was longer than `maxBytes` and got cut. */
  truncated?: boolean;
}
