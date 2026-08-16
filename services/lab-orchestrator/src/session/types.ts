/**
 * Lab session domain types (PLATFORM-002).
 *
 * A *session* is one student's attempt at one lab. It owns exactly one
 * Kubernetes namespace and everything inside it, and it has an explicit
 * lifecycle — never an ambiguous `active: true` boolean.
 */
export type { StudentCredentials } from '../types.js';

/**
 * Session lifecycle.
 *
 * ```text
 *  CREATING ──► ACTIVE ◄──► RESETTING
 *      │           │
 *      │           ├──► EXPIRING ──► EXPIRED     (reaper: max lifetime / idle)
 *      │           └──► ENDING   ──► ENDED       (student pressed End Lab)
 *      └──────────────► FAILED                   (provisioning failed)
 * ```
 *
 * `EXPIRING` / `ENDING` are the states in which teardown is in flight. The
 * reaper re-enters them idempotently until the namespace is verifiably gone.
 */
export const SESSION_STATUSES = [
  'CREATING',
  'ACTIVE',
  'RESETTING',
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
  'EXPIRING',
  'ENDING',
];

/** Statuses from which no further student action is possible. */
export const TERMINAL_STATUSES: readonly SessionStatus[] = ['EXPIRED', 'ENDED', 'FAILED'];

export function isTerminalStatus(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
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
  namespace: string;
  serviceAccountName: string;
  status: SessionStatus;
  /** Provider handle, e.g. `kind:jumptotech-labs/lab-ab12…#K8S-001`. */
  environmentId: string;
  createdAt: string;
  lastActivityAt: string;
  /** Absolute deadline. Activity never moves this. */
  expiresAt: string;
  /** Set once teardown finished. */
  endedAt?: string;
  /** Why the session ended / failed. Operator-facing. */
  statusReason?: string;
  /** Idle window in seconds, copied from config at creation time. */
  idleTimeoutSeconds: number;
  /** How long before idle expiry the UI should warn, in seconds. */
  idleWarningSeconds: number;
}

export type SessionErrorCode =
  | 'LAB_CAPACITY_REACHED'
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

export interface NetworkPolicyConfig {
  name: string;
  enabled: boolean;
  /** Namespace running CoreDNS; egress to it on :53 is always allowed. */
  dnsNamespace: string;
  /**
   * Cluster Pod/Service CIDRs. Egress to everything *except* these ranges is
   * allowed, which keeps image-agnostic internet access working while cutting
   * pod-to-pod traffic to other students.
   */
  podCidr: string;
  serviceCidr: string;
  /** When false, egress is restricted to the session namespace + DNS only. */
  allowExternalEgress: boolean;
}

/**
 * Everything that shapes a session's namespace. Values come from configuration
 * (see `apps/api/src/config.ts`), never from literals buried in provider code,
 * so production values can be tuned after load testing without a code change.
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
    podCidr: '10.244.0.0/16',
    serviceCidr: '10.96.0.0/16',
    allowExternalEgress: true,
  },
  serviceAccountName: 'student',
  credentialTtlSeconds: 3_600,
};
