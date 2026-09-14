/**
 * Lab session domain types (PLATFORM-002).
 *
 * A *session* is one student's attempt at one lab. It owns exactly one
 * Kubernetes namespace and everything inside it, and it has an explicit
 * lifecycle — never an ambiguous `active: true` boolean.
 */
export type { StudentCredentials } from '../types.js';
import type { LabProviderId, SandboxKind } from '../providers/catalog.js';

/**
 * Session lifecycle.
 *
 * ```text
 *  CREATING ──► ACTIVE ◄──► RESETTING ──► DEGRADED   (reset failed or was interrupted)
 *      │           │  ▲                       │
 *      │           │  └───────── RESETTING ◄──┘      (the student resets again)
 *      │           ├──► EXPIRING ──► EXPIRED     (reaper: max lifetime / idle)
 *      │           └──► ENDING   ──► ENDED       (student pressed End Lab)
 *      └──────────────► FAILED                   (provisioning failed)
 * ```
 *
 * `EXPIRING` / `ENDING` are the states in which teardown is in flight. The
 * reaper re-enters them idempotently until the namespace is verifiably gone.
 *
 * `DEGRADED` is the safe state for a sandbox nobody can vouch for: a reset that
 * failed, or one whose process died mid-way. It is never reported as usable —
 * no check, terminal or activity — but it is not terminal either: Reset rebuilds
 * it, End releases it, and idle/absolute expiry reclaim it if the student leaves.
 */
export const SESSION_STATUSES = [
  'CREATING',
  'ACTIVE',
  'RESETTING',
  'DEGRADED',
  'EXPIRING',
  'EXPIRED',
  'ENDING',
  'ENDED',
  'FAILED',
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Statuses that hold a live namespace and therefore consume capacity. */
export const OCCUPYING_STATUSES: readonly SessionStatus[] = [
  'CREATING',
  'ACTIVE',
  'RESETTING',
  // May still hold some or all of its runtime resources.
  'DEGRADED',
  'EXPIRING',
  'ENDING',
];

/** Statuses from which no further student action is possible. */
export const TERMINAL_STATUSES: readonly SessionStatus[] = ['EXPIRED', 'ENDED', 'FAILED'];

export function isTerminalStatus(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Statuses a reset may claim: a working sandbox, or one a failed reset left behind. */
export const RESETTABLE_STATUSES: readonly SessionStatus[] = ['ACTIVE', 'DEGRADED'];

/**
 * Statuses in which a teardown owns the session, or has finished it.
 *
 * Once a session is here nothing but that teardown may act on its sandbox, and
 * whatever a racing start or reset built must be discarded rather than kept.
 */
export function isTeardownOwned(status: SessionStatus): boolean {
  return status === 'ENDING' || status === 'EXPIRING' || isTerminalStatus(status);
}

/**
 * Statuses in which a student can be working, so activity may be recorded.
 *
 * Narrower than the occupying set on purpose. ENDING and EXPIRING hold a
 * sandbox a teardown already owns, and CREATING one nobody has used yet: an
 * activity write racing End used to land on the row End had just claimed.
 */
export const ACTIVITY_STATUSES: readonly SessionStatus[] = ['ACTIVE', 'RESETTING'];

export function acceptsActivity(status: SessionStatus): boolean {
  return ACTIVITY_STATUSES.includes(status);
}

export function occupiesCapacity(status: SessionStatus): boolean {
  return OCCUPYING_STATUSES.includes(status);
}

/**
 * The stored session record.
 *
 * Deliberately flat, serialisable and timestamped (ISO-8601 strings) so the
 * in-memory store can be replaced by a PostgreSQL table without reshaping it.
 */
export interface LabSession {
  sessionId: string;
  labId: string;
  /**
   * Which provider owns this session's sandbox.
   *
   * Recorded at creation from the lab definition and never mutable afterwards:
   * a live session cannot be moved to another provider's sandbox, which is why
   * `SessionStore.update` refuses to patch it (see `store.ts`).
   */
  provider: LabProviderId;
  sandboxKind: SandboxKind;
  /**
   * The provider's handle for this session's sandbox — namespace name,
   * container name, … Derived server-side from the session id.
   */
  sandboxRef: string;
  /**
   * Kubernetes namespace for this session.
   *
   * The Kubernetes view of `sandboxRef`, kept as its own field so Kubernetes
   * code and the existing API payload read naturally. Carries the same derived
   * sandbox id for every provider; only meaningful when `provider` is
   * `kubernetes`, and the API payload omits it otherwise.
   */
  namespace: string;
  serviceAccountName: string;
  status: SessionStatus;
  /** Provider handle, e.g. `kind:jumptotech-labs/lab-ab12…#K8S-001`. */
  environmentId: string;
  createdAt: string;
  lastActivityAt: string;
  /**
   * When `status` last actually changed.
   *
   * Two jobs. The reaper measures how long a RESETTING or ENDING operation has
   * been in flight from it, which is the only way to tell a dead owner from a
   * slow one. And it fences a status claim: a reset releases its claim only if
   * the row still carries the timestamp its own claim wrote, so a claim that was
   * recovered and then taken by a *second* reset cannot be released by the first.
   *
   * Written by `SessionStore.transition` only when the status really changes;
   * resuming a teardown from its own in-flight state leaves it alone.
   */
  statusChangedAt: string;
  /** Absolute deadline. Activity never moves this. */
  expiresAt: string;
  /** Set once teardown finished. */
  endedAt?: string;
  /** Why the session ended / failed. Operator-facing. */
  statusReason?: string;
  /**
   * The authenticated user this session belongs to.
   *
   * Set server-side from the caller's verified identity at start, and never
   * from a request field — there is no way for a browser to name an owner.
   * Optional only because sessions created before authentication existed have
   * none; the authorization layer treats an absent owner as "owned by nobody",
   * which is reachable by no student.
   */
  ownerUserId?: string;
  /** Idle window in seconds, copied from config at creation time. */
  idleTimeoutSeconds: number;
  /** How long before idle expiry the UI should warn, in seconds. */
  idleWarningSeconds: number;
}

export type SessionErrorCode =
  | 'PROVIDER_UNAVAILABLE'
  | 'LAB_CAPACITY_REACHED'
  | 'STUDENT_SESSION_LIMIT_REACHED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_ACTIVE'
  | 'INVALID_SESSION_ID'
  | 'SESSION_PROVISION_FAILED'
  | 'SESSION_RESET_FAILED'
  | 'SESSION_CLEANUP_FAILED'
  | 'CREDENTIALS_UNAVAILABLE';

export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
    readonly remediation?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

// ---------------------------------------------------------------- policy

/** Container CPU/memory pair. */
export interface ComputeAmounts {
  cpu: string;
  memory: string;
}

/**
 * The LimitRange applied to every lab namespace. Containers that declare no
 * resources inherit `defaultRequest` / `default`, so one student's workload
 * cannot silently claim a whole shared node.
 */
export interface LimitRangePolicy {
  name: string;
  defaultRequest: ComputeAmounts;
  default: ComputeAmounts;
  /** Optional hard per-container ceiling. Omitted when not configured. */
  max?: ComputeAmounts;
}

/**
 * The session network contract's inputs — see `session/network-policy.ts` and
 * docs/kubernetes-network-security.md.
 */
export interface NetworkPolicyConfig {
  name: string;
  /** Whether session NetworkPolicies are created at all. Refused as false in production. */
  enabled: boolean;
  /** Namespace running cluster DNS. */
  dnsNamespace: string;
  /**
   * Labels selecting the DNS Pods inside `dnsNamespace`. Port 53 egress goes to
   * these Pods only, not to everything that happens to run in that namespace.
   */
  dnsPodSelector: Record<string, string>;
  /**
   * Cluster Pod/Service CIDRs. Never reachable through the external-egress
   * allowance; traffic between sessions is refused by the deny-by-default
   * policies on both sides.
   */
  podCidr: string;
  serviceCidr: string;
  /**
   * Whether the platform permits external egress at all. Off by default. Even
   * when on, only a lab declaring `external_egress` receives it, and it reaches
   * public IPv4 space only.
   */
  allowExternalEgress: boolean;
  /** Further ranges external egress must never reach, e.g. the node network or VPC. */
  additionalDeniedEgressCidrs: string[];
  /** The behavioural proof required before students are admitted. */
  attestation: {
    /** Forced on under NODE_ENV=production. */
    required: boolean;
    maxAgeSeconds: number;
  };
}

/**
 * Resource bounds for a container-exec sandbox (Linux, Terraform).
 *
 * The container equivalent of the Kubernetes ResourceQuota/LimitRange pair:
 * one student cannot exhaust the host, and an abandoned shell cannot fork-bomb
 * it. Centralised here rather than written into each provider so the
 * container-exec providers are tuned in one place — see PLATFORM-004 §18.
 *
 * The Docker track does not use this: its sandbox runs a whole daemon rather
 * than a single shell, so it is bounded by `DockerSandboxPolicy` below.
 */
export interface SandboxContainerPolicy {
  /** CPU cores, as Docker's `--cpus` accepts, e.g. `0.5`. */
  cpus: string;
  /** Memory ceiling, e.g. `512m`. */
  memory: string;
  /** Process ceiling (`--pids-limit`), which is what stops a fork bomb. */
  pidsLimit: number;
  /** Writable scratch size for the sandbox home, e.g. `64m`. */
  tmpfsSize: string;
  /** Unprivileged user the student's shell runs as inside the sandbox. */
  user: string;
  /** The student's home directory, and the root every verifier path resolves under. */
  home: string;
  /**
   * Docker network mode. `none` by default: a Linux or Terraform lab needs no
   * network, and giving one away would be a cost and egress risk for nothing.
   */
  network: string;
}

/**
 * Resource controls applied to one Docker sandbox.
 *
 * A Docker session's sandbox is a single container that runs an isolated Docker
 * daemon; every container the student creates is a child of that one process
 * tree. Capping the sandbox therefore caps the *whole session* — a student
 * cannot escape their memory, CPU, or process budget by launching more
 * containers, because those containers spend the same budget.
 *
 * This is the Docker counterpart of `quota` + `limitRange`, and it is
 * configured the same way: from the environment, never from literals in
 * provider code.
 */
export interface DockerSandboxPolicy {
  /** Image providing the isolated daemon, e.g. `docker:27-dind`. */
  image: string;
  /**
   * Whether the sandbox container runs `--privileged`.
   *
   * Docker-in-Docker cannot run without it: the inner daemon needs to create
   * cgroups, mount filesystems, and program iptables. This is the single
   * privileged component in the design and it exists so that the *student*
   * never needs any privilege at all — see README → Docker sandbox security.
   */
  privileged: boolean;
  /** `--memory` for the sandbox, e.g. `2g`. Caps the whole session. */
  memory: string;
  /** `--cpus` for the sandbox, e.g. `2`. Caps the whole session. */
  cpus: string;
  /** `--pids-limit` for the sandbox. The hard ceiling on session processes. */
  pidsLimit: number;
  /**
   * Advisory ceiling on containers a student is expected to create.
   *
   * Docker has no per-daemon container cap, so this is reported rather than
   * enforced; `pidsLimit` and `memory` are the limits that actually bind. See
   * README → Docker resource controls.
   */
  maxContainers: number;
  /** User-defined bridge every sandbox joins, so the terminal can reach it. */
  network: string;
  /** Port the sandbox daemon serves the TLS Docker API on. */
  daemonPort: number;
  /** How long to wait for a sandbox's daemon to accept commands, in seconds. */
  readyTimeoutSeconds: number;
  /**
   * Restart attempts for the sandbox container.
   *
   * `dockerd` gives its managed containerd a fixed 15s to start and gives up if
   * it misses that window, which happens on a loaded host. A restart policy
   * turns that transient failure into a retry instead of a failed lab start.
   */
  restartAttempts: number;
  /** Extra registry mirror the sandbox daemon should prefer, if configured. */
  registryMirror?: string;
}

/**
 * Everything that shapes a session's sandbox. Values come from configuration
 * (see `apps/api/src/config.ts`), never from literals buried in provider code,
 * so production values can be tuned after load testing without a code change.
 *
 * One policy object covers both substrates. A Kubernetes session reads `quota`,
 * `limitRange`, and `network`; a Docker session reads `docker`. Neither
 * provider sees the other's fields, but keeping a single policy type means the
 * session manager, the API config loader, and the store never branch on track.
 */
export interface SessionPolicy {
  /** ResourceQuota `spec.hard`, e.g. `{ pods: '15', 'requests.cpu': '2' }`. */
  quota: Record<string, string>;
  quotaName: string;
  limitRange: LimitRangePolicy;
  network: NetworkPolicyConfig;
  /** Name of the per-session ServiceAccount the student's kubectl uses. */
  serviceAccountName: string;
  /** Lifetime of a minted student ServiceAccount token, in seconds. */
  credentialTtlSeconds: number;
  /** Bounds applied to container-exec sandboxes (Linux, Terraform). */
  sandbox: SandboxContainerPolicy;
  /** Resource controls for Docker-track sandboxes. */
  docker: DockerSandboxPolicy;
}

/**
 * Development defaults, straight from the PLATFORM-002 story.
 *
 * These are *defaults*, not constants: every value is overridable from the
 * environment (see `apps/api/src/config.ts`) precisely so production values can
 * be tuned after load testing without touching application logic.
 */
export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  quotaName: 'jumptotech-session-quota',
  quota: {
    pods: '15',
    services: '10',
    persistentvolumeclaims: '5',
    'requests.cpu': '2',
    'requests.memory': '2Gi',
    'limits.cpu': '4',
    'limits.memory': '4Gi',
    // Cost safety: a lab may never ask the cloud for an address.
    'services.loadbalancers': '0',
    'services.nodeports': '0',
  },
  limitRange: {
    name: 'jumptotech-session-limits',
    defaultRequest: { cpu: '50m', memory: '64Mi' },
    default: { cpu: '500m', memory: '512Mi' },
    max: { cpu: '1', memory: '1Gi' },
  },
  network: {
    name: 'jumptotech-session-isolation',
    enabled: true,
    dnsNamespace: 'kube-system',
    dnsPodSelector: { 'k8s-app': 'kube-dns' },
    podCidr: '10.244.0.0/16',
    serviceCidr: '10.96.0.0/16',
    // No shipped lab needs the internet from a Pod: images are pulled by the
    // kubelet, and K8S-012's in-cluster client reaches the API server through
    // its own allowance. See docs/kubernetes-network-security.md.
    allowExternalEgress: false,
    additionalDeniedEgressCidrs: [],
    attestation: { required: false, maxAgeSeconds: 7 * 24 * 3_600 },
  },
  serviceAccountName: 'student',
  credentialTtlSeconds: 3_600,
  sandbox: {
    cpus: '0.5',
    memory: '512m',
    pidsLimit: 128,
    tmpfsSize: '64m',
    user: 'student',
    home: '/home/student',
    network: 'none',
  },
  docker: {
    image: 'docker:27-dind',
    // Required by Docker-in-Docker. Documented, and confined to this one
    // platform-created container; no student process ever runs inside it.
    privileged: true,
    memory: '2g',
    cpus: '2',
    pidsLimit: 512,
    maxContainers: 10,
    network: 'jumptotech-sandboxes',
    daemonPort: 2376,
    readyTimeoutSeconds: 180,
    restartAttempts: 5,
  },
};
