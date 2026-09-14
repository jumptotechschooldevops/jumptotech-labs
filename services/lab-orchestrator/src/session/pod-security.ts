/**
 * Pod security for Kubernetes session namespaces (BETA-P0-016).
 *
 * A student holds `create` on pods, deployments, daemonsets, jobs and cronjobs
 * in their namespace. RBAC says nothing about what those Pods *contain*, so
 * before this module a student could ask for `privileged: true`, `hostPID`,
 * `hostNetwork`, a `hostPath` of `/`, or `CAP_SYS_ADMIN`, and the API server
 * admitted it. Three layers now stand in the way, each for a different failure:
 *
 *   1. **Pod Security Admission labels** on every session namespace. The API
 *      server's built-in PodSecurity plugin enforces them against every Pod,
 *      whoever creates it: the student's kubectl, a ReplicaSet controller acting
 *      for a Deployment, a CronJob. This is the boundary.
 *   2. **`jumptotech-require-pod-security`**, a ValidatingAdmissionPolicy in
 *      `infrastructure/kind/admission/`, refuses a managed namespace that lacks
 *      those labels or weakens them. A platform regression then fails closed
 *      instead of producing a namespace with no pod-level fence at all.
 *   3. **`podSecurityViolations`** below, which reads the workloads a lab ships
 *      in `setup.manifests` when they load. Admission would refuse those Pods
 *      too, but only after the Deployment had been accepted and its ReplicaSet
 *      had failed quietly; this turns that into an authoring error.
 *
 * ## Why `baseline`, not `restricted`
 *
 * `restricted` requires `runAsNonRoot`, `allowPrivilegeEscalation: false`,
 * `capabilities.drop: [ALL]` and a seccomp profile on every container. K8S-001
 * teaches `kubectl run nginx --image=nginx:stable`, which sets none of them, and
 * `nginx:stable` runs its master process as root. Enforcing `restricted` rejects
 * the first command of the first lab (measured, see docs/pod-security.md). It is
 * still recorded: `audit` runs at `restricted`, so a cluster with audit logging
 * sees every Pod that would fail it.
 *
 * `warn` matches `enforce` on purpose. A `restricted` warning would print on
 * nearly every command a beginner types, and train them to ignore warnings. A
 * `baseline` warning prints only for something that is about to be refused —
 * which is exactly when a Deployment author needs it, because the API server
 * accepts the Deployment and only its Pods are rejected.
 *
 * There is no per-lab exception. No lab needs `privileged`, and `privileged` is
 * not a value this module will produce: a lab that genuinely needed host access
 * would need a code change and a review, not a line of YAML.
 */
import type { KubernetesManifestObject } from '../k8s/port.js';

export const POD_SECURITY_ENFORCE_LABEL = 'pod-security.kubernetes.io/enforce';
export const POD_SECURITY_ENFORCE_VERSION_LABEL = 'pod-security.kubernetes.io/enforce-version';
export const POD_SECURITY_WARN_LABEL = 'pod-security.kubernetes.io/warn';
export const POD_SECURITY_WARN_VERSION_LABEL = 'pod-security.kubernetes.io/warn-version';
export const POD_SECURITY_AUDIT_LABEL = 'pod-security.kubernetes.io/audit';
export const POD_SECURITY_AUDIT_VERSION_LABEL = 'pod-security.kubernetes.io/audit-version';

/**
 * The Pod Security Standards a session namespace may carry.
 *
 * `privileged` is deliberately absent. It is the standard that enforces
 * nothing, and no configuration, environment variable or lab can select it.
 */
export const SESSION_POD_SECURITY_LEVELS = ['baseline', 'restricted'] as const;
export type SessionPodSecurityLevel = (typeof SESSION_POD_SECURITY_LEVELS)[number];

export interface PodSecurityConfig {
  enforce: SessionPodSecurityLevel;
  warn: SessionPodSecurityLevel;
  audit: SessionPodSecurityLevel;
  /**
   * The Pod Security Standards version all three modes evaluate against:
   * `v1.<minor>`, or `latest`.
   *
   * Pinned by default. `latest` means a cluster upgrade can change which Pods
   * are admitted with no change here — a lab that worked yesterday is refused
   * today — so production refuses it (`assertPodSecurityConfig`). Raising the
   * pin is a reviewed change made alongside a cluster upgrade.
   */
  version: string;
}

export const DEFAULT_POD_SECURITY: PodSecurityConfig = {
  enforce: 'baseline',
  warn: 'baseline',
  audit: 'restricted',
  version: 'v1.34',
};

const POD_SECURITY_VERSION = /^(latest|v1\.(0|[1-9][0-9]?))$/;

const STRICTNESS: Record<SessionPodSecurityLevel, number> = { baseline: 0, restricted: 1 };

/**
 * Refuse a pod security configuration that would weaken or blur the boundary.
 *
 *   · any level outside `baseline` / `restricted`          → refused everywhere
 *   · `warn` or `audit` weaker than `enforce`              → refused everywhere
 *     (a warning about less than is already refused tells nobody anything)
 *   · a version that is not `v1.<minor>` or `latest`       → refused everywhere
 *   · `latest` under production                            → refused
 */
export function assertPodSecurityConfig(
  config: PodSecurityConfig,
  options: { production: boolean },
): void {
  for (const mode of ['enforce', 'warn', 'audit'] as const) {
    const level = config[mode] as string;
    if (!(SESSION_POD_SECURITY_LEVELS as readonly string[]).includes(level)) {
      throw new Error(
        `Pod security ${mode} level must be one of ${SESSION_POD_SECURITY_LEVELS.join(', ')}, not '${level}'. ` +
          `'privileged' is never permitted for a student namespace.`,
      );
    }
  }
  for (const mode of ['warn', 'audit'] as const) {
    if (STRICTNESS[config[mode]] < STRICTNESS[config.enforce]) {
      throw new Error(
        `Pod security ${mode} level '${config[mode]}' is weaker than enforce level '${config.enforce}'.`,
      );
    }
  }
  if (!POD_SECURITY_VERSION.test(config.version)) {
    throw new Error(
      `Pod security version must be 'v1.<minor>' or 'latest', not '${config.version}'.`,
    );
  }
  if (options.production && config.version === 'latest') {
    throw new Error(
      "Pod security version 'latest' is refused when NODE_ENV=production: a cluster upgrade would change which lab Pods are admitted. Pin it, e.g. POD_SECURITY_VERSION=v1.34.",
    );
  }
}

/** The Pod Security Admission labels a session namespace carries. */
export function podSecurityLabels(config: PodSecurityConfig): Record<string, string> {
  assertPodSecurityConfig(config, { production: false });
  return {
    [POD_SECURITY_ENFORCE_LABEL]: config.enforce,
    [POD_SECURITY_ENFORCE_VERSION_LABEL]: config.version,
    [POD_SECURITY_WARN_LABEL]: config.warn,
    [POD_SECURITY_WARN_VERSION_LABEL]: config.version,
    [POD_SECURITY_AUDIT_LABEL]: config.audit,
    [POD_SECURITY_AUDIT_VERSION_LABEL]: config.version,
  };
}

// ------------------------------------------------------ setup manifest checks

interface SecurityContextLike {
  privileged?: unknown;
  allowPrivilegeEscalation?: unknown;
  capabilities?: { add?: unknown };
  procMount?: unknown;
  seccompProfile?: { type?: unknown };
  appArmorProfile?: { type?: unknown };
  windowsOptions?: { hostProcess?: unknown };
  sysctls?: unknown;
}

interface ContainerLike {
  name?: unknown;
  securityContext?: SecurityContextLike;
  ports?: Array<{ hostPort?: unknown }>;
}

interface PodSpecLike {
  hostNetwork?: unknown;
  hostPID?: unknown;
  hostIPC?: unknown;
  volumes?: Array<{ name?: unknown; hostPath?: unknown }>;
  securityContext?: SecurityContextLike;
  containers?: ContainerLike[];
  initContainers?: ContainerLike[];
  ephemeralContainers?: ContainerLike[];
}

type Nested = { spec?: Record<string, unknown> } | undefined;

/** The Pod spec a workload object will create Pods from, if it has one. */
export function podSpecOf(object: KubernetesManifestObject): PodSpecLike | undefined {
  const spec = (object as { spec?: Record<string, unknown> }).spec;
  switch (object.kind) {
    case 'Pod':
      return spec as PodSpecLike | undefined;
    case 'Deployment':
    case 'ReplicaSet':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'Job':
      return (spec?.template as Nested)?.spec as PodSpecLike | undefined;
    case 'CronJob': {
      const job = (spec?.jobTemplate as Nested)?.spec;
      return (job?.template as Nested)?.spec as PodSpecLike | undefined;
    }
    default:
      return undefined;
  }
}

function list<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Why a lab's setup workload may not ship, or `[]` when it may.
 *
 * Everything Pod Security `baseline` refuses that a lab author could plausibly
 * write — host namespaces, `hostPath`, `hostPort`, `privileged`, an unconfined
 * seccomp or AppArmor profile, an unmasked `/proc`, a host-process container —
 * plus two rules stricter than `baseline`, because a platform-authored fixture
 * has no reason to need either: no added capabilities at all, and no explicit
 * `allowPrivilegeEscalation: true`. Pod-level `sysctls` are refused outright
 * rather than split into safe and unsafe.
 *
 * This is an authoring guard, not the boundary. The namespace's PSA labels are
 * the boundary, and they apply to these Pods as well.
 */
export function podSecurityViolations(object: KubernetesManifestObject): string[] {
  const spec = podSpecOf(object);
  if (!spec || typeof spec !== 'object') return [];
  const violations: string[] = [];

  if (spec.hostNetwork === true) violations.push('spec.hostNetwork is true');
  if (spec.hostPID === true) violations.push('spec.hostPID is true');
  if (spec.hostIPC === true) violations.push('spec.hostIPC is true');

  for (const volume of list(spec.volumes)) {
    if (volume?.hostPath !== undefined) {
      violations.push(`volume '${String(volume.name)}' is a hostPath volume`);
    }
  }

  violations.push(...securityContextViolations('pod securityContext', spec.securityContext));
  if (Array.isArray(spec.securityContext?.sysctls) && spec.securityContext.sysctls.length > 0) {
    violations.push('pod securityContext sets sysctls');
  }

  const containers = [
    ...list(spec.initContainers),
    ...list(spec.containers),
    ...list(spec.ephemeralContainers),
  ];
  for (const container of containers) {
    const where = `container '${String(container?.name)}'`;
    const context = container?.securityContext;
    if (context?.privileged === true) violations.push(`${where}: privileged is true`);
    if (context?.allowPrivilegeEscalation === true) {
      violations.push(`${where}: allowPrivilegeEscalation is true`);
    }
    if (Array.isArray(context?.capabilities?.add) && context.capabilities.add.length > 0) {
      violations.push(`${where}: adds capabilities ${context.capabilities.add.join(', ')}`);
    }
    if (context?.procMount !== undefined && context.procMount !== 'Default') {
      violations.push(`${where}: procMount is ${String(context.procMount)}`);
    }
    violations.push(...securityContextViolations(where, context));
    for (const port of list(container?.ports)) {
      if (port?.hostPort !== undefined && port.hostPort !== 0) {
        violations.push(`${where}: hostPort ${String(port.hostPort)}`);
      }
    }
  }

  return violations;
}

function securityContextViolations(where: string, context: SecurityContextLike | undefined): string[] {
  const violations: string[] = [];
  if (context?.seccompProfile?.type === 'Unconfined') {
    violations.push(`${where}: seccompProfile is Unconfined`);
  }
  if (context?.appArmorProfile?.type === 'Unconfined') {
    violations.push(`${where}: appArmorProfile is Unconfined`);
  }
  if (context?.windowsOptions?.hostProcess === true) {
    violations.push(`${where}: windowsOptions.hostProcess is true`);
  }
  return violations;
}
