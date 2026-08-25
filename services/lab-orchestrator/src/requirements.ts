/**
 * Requirement types — the closed vocabulary shared by the lab schema and the
 * verifier registry.
 *
 * This module is the single source of truth for *what a lab may ask for*.
 * `lab-definition.ts` validates lab.yaml against these schemas; the verifier
 * registry implements one handler per type. Because both sides import the same
 * list, a lab can never name a requirement the verifier cannot execute, and a
 * verifier handler can never accept a shape the schema did not validate.
 *
 * The vocabulary is split by **family**, because the families observe
 * completely different substrates:
 *
 * ```text
 *   kubernetes  ──► read the Kubernetes API in the session namespace
 *   filesystem  ──► read a path inside the session's own sandbox container
 *   terraform   ──► read terraform.tfstate inside that sandbox
 *   linux       ──► additionally ask the sandbox an allow-listed inspection
 *                   question: process table, listening sockets, accounts
 * ```
 *
 * `lab-definition.ts` refuses a lab that asks its provider for a family the
 * provider cannot answer, so a Kubernetes lab can never ask for a file check
 * and a Linux lab can never ask for a Pod.
 *
 * Security property: every schema below is `.strict()`. A lab definition
 * therefore cannot smuggle extra keys — no `shell:`, no free-form `exec:`.
 *
 * The `linux` family does contain three types that *run* something
 * (`command_exit_code`, `command_output`, `script_runs`), and they are fenced
 * deliberately:
 *
 *   - `command`/`args` are never a shell string. They are an argv array,
 *     executed with no shell, so argument content cannot become syntax.
 *   - `command` is drawn from `VERIFIER_COMMANDS`, a closed allow-list of
 *     read-only inspection binaries that ship in the sandbox image.
 *   - `script_runs` executes only a path the lab names, **inside that
 *     student's own throwaway container** — the one place where that code can
 *     already run, because the student has a shell in it. It reaches nothing
 *     on the host and nothing belonging to any other student.
 *
 * The Docker family is read-only: every handler inspects one session's own
 * Docker daemon or workspace. Nothing in that vocabulary executes anything.
 *
 * The vocabulary is split into three objects — `kubernetesRequirementSchemas`,
 * `sandboxRequirementSchemas`, and `dockerRequirementSchemas` — and re-joined
 * into `requirementSchemas` at the bottom. The split lets each substrate's
 * verifier registry prove — at compile time — that it implements every type it
 * is responsible for, without either registry having to know the others exist.
 */
import { z } from 'zod';
import { isSafeSandboxPath, MAX_SANDBOX_PATH_LENGTH } from './session/sandbox-paths.js';

/**
 * A path inside the session's sandbox.
 *
 * Either relative to the sandbox home (`deploy/release.txt`) or absolute
 * inside the container (`/var/log/jumptotech/payments.log`). Never `~`, never
 * a `..` segment, never a shell metacharacter, never a backslash — see
 * `session/sandbox-paths.ts` for the rule and for the second check the runtime
 * applies before any read.
 *
 * Absolute forms are accepted because a Linux system-administration lab is
 * *about* `/etc`, `/var/log` and `/srv`, and because the whole container — not
 * just one home directory — is the throwaway thing that belongs to exactly one
 * session. What the rule still guarantees is unchanged: an absolute path is
 * resolved inside the sandbox by the provider, so a lab definition can never
 * name a path on the host or in another student's sandbox.
 */
const sandboxPath = z
  .string()
  .min(1)
  .max(MAX_SANDBOX_PATH_LENGTH)
  .refine(isSafeSandboxPath, {
    message:
      'must be a path inside the sandbox (no ~, no .. segments, no backslashes, no shell metacharacters)',
  });

/** A POSIX user or group name, as `stat` reports it. */
const posixName = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z_][a-z0-9_-]*\$?$/, 'must be a POSIX user or group name');

/** An octal permission string, e.g. `750`. */
const fileMode = z
  .string()
  .regex(/^0?[0-7]{3,4}$/, 'must be an octal permission string such as 750');

/** DNS-1123 subdomain, the naming rule for most Kubernetes objects. */
const resourceName = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/,
    'must be a lowercase DNS-1123 name (letters, digits, - and .)',
  );

/** Container image reference, e.g. `nginx:stable`. */
const imageReference = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/, 'must be a container image reference');

/** A Kubernetes label key/value map, e.g. `{ app: frontend }`. */
const labelMap = z
  .record(
    z.string().min(1).max(63 + 253 + 1),
    z.string().max(63).regex(/^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/, 'invalid label value'),
  )
  .refine((value) => Object.keys(value).length > 0, { message: 'must declare at least one label' });

/** A Kubernetes resource quantity, e.g. `100m`, `64Mi`, `0.5`. */
const quantity = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[0-9]+(\.[0-9]+)?([EPTGMK]i?|[munk]|e[0-9]+)?$/, 'must be a Kubernetes quantity such as 100m or 64Mi');

const resourceList = z
  .object({ cpu: quantity.optional(), memory: quantity.optional() })
  .strict()
  .refine((v) => v.cpu !== undefined || v.memory !== undefined, {
    message: 'must specify cpu, memory, or both',
  });

/**
 * Fields every requirement may carry.
 *
 * `label` overrides the student-facing text. Troubleshooting labs use it to
 * state the goal ("Service routes to the application Pods") without naming the
 * injected fault, which the generated default label might otherwise hint at.
 */
const common = {
  label: z.string().min(1).max(160).optional(),
};

/** Kubernetes object kinds a requirement may name generically. */
const CHECKABLE_KINDS = [
  'pod',
  'deployment',
  'service',
  'configmap',
  'secret',
  'job',
  'cronjob',
  'statefulset',
  'daemonset',
  'ingress',
  'persistentvolumeclaim',
  'role',
  'rolebinding',
  'networkpolicy',
  'horizontalpodautoscaler',
  'serviceaccount',
] as const;

/**
 * A cron schedule, e.g. `*​/5 * * * *`.
 *
 * Deliberately a permissive character class rather than a full cron grammar:
 * the check compares the student's schedule to the lab's expected one after
 * whitespace normalisation, so this only has to exclude obvious nonsense.
 */
const cronSchedule = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[-*/,?\dA-Za-z\s]+$/, 'must be a cron schedule such as */5 * * * *');

/** A port number, or the name of a named container port. */
const portValue = z.union([
  z.number().int().min(1).max(65535),
  z
    .string()
    .min(1)
    .max(15)
    .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'must be a named port'),
]);

/**
 * A fixed string matched against a process command line.
 *
 * Matching happens in the verifier, over a process table it read itself — this
 * is never handed to `pgrep`, a shell, or a regular-expression engine, so it
 * can neither inject nor backtrack.
 */
const processPattern = z
  .string()
  .min(2)
  .max(160)
  .regex(/^[A-Za-z0-9._\-/ :=@,+]+$/, 'must be a plain command-line fragment');

/** Literal text a file or command output must contain. */
const literalText = z
  .string()
  .min(1)
  .max(512)
  .refine((v) => !v.includes('\0'), { message: 'must not contain null bytes' });

/**
 * Inspection binaries a lab may name in `command_exit_code` / `command_output`.
 *
 * All of them read state; none of them mutate it. A lab cannot name `rm`,
 * `chmod`, `bash`, or anything else outside this list, and there is no
 * mechanism to extend the list from a lab definition. `LinuxLabProvider` hands
 * exactly this array to the container provider, so the schema and the thing
 * that enforces it cannot drift apart.
 */
export const VERIFIER_COMMANDS = [
  'test',
  'stat',
  'id',
  'getent',
  'ps',
  'ss',
  'df',
  'du',
  'ls',
  'cat',
  'grep',
  'wc',
  'hostname',
  'readlink',
  'find',
  'sha256sum',
  'head',
  'tail',
  'awk',
  'cut',
  'sort',
  'uniq',
] as const;

export type VerifierCommand = (typeof VERIFIER_COMMANDS)[number];

/** One argv element. Never concatenated into a string, never shell-expanded. */
const commandArgument = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._\-/=:,%@+]+$/, 'command arguments are restricted to a safe character set');

/** Which account a check observes the sandbox as. */
const asUser = z.enum(['student', 'root']).default('student');

/** Kubernetes label selector — empty object matches every Pod. */
const selectorLabels = z
  .record(
    z.string().min(1).max(63 + 253 + 1),
    z.string().max(63).regex(/^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/, 'invalid label value'),
  )
  .default({});

const rbacSubjectKind = z.enum(['ServiceAccount', 'User', 'Group']);

const rbacRoleKind = z.enum(['Role', 'ClusterRole']);

const tolerationSpec = z
  .object({
    key: z.string().min(1).max(253),
    operator: z.enum(['Equal', 'Exists']),
    effect: z.enum(['NoSchedule', 'PreferNoSchedule', 'NoExecute']).optional(),
    value: z.string().max(253).optional(),
  })
  .strict();

const authCheckFields = {
  serviceAccount: resourceName,
  verb: z.string().min(1).max(32),
  resource: z.string().min(1).max(64),
  apiGroup: z.string().max(64),
  name: resourceName.optional(),
  subresource: z.string().min(1).max(64).optional(),
};

const kubernetesRequirementSchemas = {
  // --- Pods --------------------------------------------------------------
  pod_exists: z.object({ type: z.literal('pod_exists'), name: resourceName, ...common }).strict(),

  pod_image: z
    .object({
      type: z.literal('pod_image'),
      name: resourceName,
      /** Restrict the check to one container; omit to accept any container. */
      container: resourceName.optional(),
      image: imageReference,
      ...common,
    })
    .strict(),

  pod_running: z.object({ type: z.literal('pod_running'), name: resourceName, ...common }).strict(),

  pod_ready: z.object({ type: z.literal('pod_ready'), name: resourceName, ...common }).strict(),

  /**
   * Any Pod phase, not only Running.
   *
   * `pod_running` stays as the readable form of the common case; this covers
   * `Succeeded` (a completed one-shot Pod) and `Pending`/`Failed` for labs that
   * deliberately teach an unschedulable or crashing workload.
   */
  pod_phase: z
    .object({
      type: z.literal('pod_phase'),
      name: resourceName,
      phase: z.enum(['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown']),
      ...common,
    })
    .strict(),

  pod_label: z
    .object({ type: z.literal('pod_label'), name: resourceName, labels: labelMap, ...common })
    .strict(),

  pod_resources: z
    .object({
      type: z.literal('pod_resources'),
      name: resourceName,
      container: resourceName.optional(),
      requests: resourceList.optional(),
      limits: resourceList.optional(),
      ...common,
    })
    .strict()
    .refine((v) => v.requests !== undefined || v.limits !== undefined, {
      message: 'must specify requests, limits, or both',
    }),

  // --- Deployments -------------------------------------------------------
  deployment_exists: z
    .object({ type: z.literal('deployment_exists'), name: resourceName, ...common })
    .strict(),

  deployment_image: z
    .object({
      type: z.literal('deployment_image'),
      name: resourceName,
      container: resourceName.optional(),
      image: imageReference,
      ...common,
    })
    .strict(),

  deployment_replicas: z
    .object({
      type: z.literal('deployment_replicas'),
      name: resourceName,
      replicas: z.number().int().min(0).max(20),
      ...common,
    })
    .strict(),

  deployment_available: z
    .object({
      type: z.literal('deployment_available'),
      name: resourceName,
      /** Defaults to "every desired replica is available". */
      min_available: z.number().int().min(1).max(20).optional(),
      ...common,
    })
    .strict(),

  deployment_rollout_complete: z
    .object({ type: z.literal('deployment_rollout_complete'), name: resourceName, ...common })
    .strict(),

  deployment_selector: z
    .object({
      type: z.literal('deployment_selector'),
      name: resourceName,
      selector: labelMap,
      ...common,
    })
    .strict(),

  /**
   * Resource requests/limits on the Deployment's **Pod template**.
   *
   * Deliberately not `pod_resources`: a namespace LimitRange injects defaults
   * into every Pod, so a Pod always reports requests and limits whether or not
   * the student declared any. The template shows only what was actually
   * written, which is what a resource-management lab must grade.
   */
  deployment_resources: z
    .object({
      type: z.literal('deployment_resources'),
      name: resourceName,
      container: resourceName.optional(),
      requests: resourceList.optional(),
      limits: resourceList.optional(),
      ...common,
    })
    .strict()
    .refine((v) => v.requests !== undefined || v.limits !== undefined, {
      message: 'must specify requests, limits, or both',
    }),

  /** A probe of the given kind is configured, optionally with a given handler. */
  deployment_probe: z
    .object({
      type: z.literal('deployment_probe'),
      name: resourceName,
      container: resourceName.optional(),
      probe: z.enum(['readiness', 'liveness', 'startup']),
      handler: z.enum(['httpGet', 'tcpSocket', 'exec', 'grpc']).optional(),
      path: z.string().min(1).max(255).optional(),
      port: portValue.optional(),
      ...common,
    })
    .strict(),

  /**
   * The Deployment consumes a ConfigMap.
   *
   * Any mechanism counts — `envFrom`, a single-key `env.valueFrom`, or a
   * volume — unless the lab pins one with `via`. The point of a ConfigMap lab
   * is that configuration left the image, not that one syntax was used.
   */
  deployment_uses_configmap: z
    .object({
      type: z.literal('deployment_uses_configmap'),
      name: resourceName,
      configmap: resourceName,
      /** Require a specific key to be referenced. */
      key: z.string().min(1).max(253).regex(/^[-._a-zA-Z0-9]+$/, 'invalid ConfigMap key').optional(),
      via: z.enum(['env', 'envFrom', 'volume']).optional(),
      ...common,
    })
    .strict(),

  deployment_uses_secret: z
    .object({
      type: z.literal('deployment_uses_secret'),
      name: resourceName,
      secret: resourceName,
      key: z.string().min(1).max(253).regex(/^[-._a-zA-Z0-9]+$/, 'invalid Secret key').optional(),
      via: z.enum(['env', 'envFrom', 'volume']).optional(),
      ...common,
    })
    .strict(),

  // --- Services ----------------------------------------------------------
  service_exists: z
    .object({ type: z.literal('service_exists'), name: resourceName, ...common })
    .strict(),

  service_type: z
    .object({
      type: z.literal('service_type'),
      name: resourceName,
      expected: z.enum(['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName']),
      ...common,
    })
    .strict(),

  service_port: z
    .object({
      type: z.literal('service_port'),
      name: resourceName,
      port: z.number().int().min(1).max(65535),
      /** Container port or named port the Service forwards to. */
      target_port: z.union([z.number().int().min(1).max(65535), z.string().min(1).max(15)]).optional(),
      protocol: z.enum(['TCP', 'UDP', 'SCTP']).optional(),
      ...common,
    })
    .strict(),

  service_selector: z
    .object({ type: z.literal('service_selector'), name: resourceName, selector: labelMap, ...common })
    .strict(),

  service_endpoints: z
    .object({
      type: z.literal('service_endpoints'),
      name: resourceName,
      /** Ready backend addresses the Service must currently have. */
      min_ready: z.number().int().min(1).max(20).default(1),
      ...common,
    })
    .strict(),

  // --- Configuration -----------------------------------------------------
  configmap_exists: z
    .object({ type: z.literal('configmap_exists'), name: resourceName, ...common })
    .strict(),

  configmap_key: z
    .object({
      type: z.literal('configmap_key'),
      name: resourceName,
      key: z.string().min(1).max(253).regex(/^[-._a-zA-Z0-9]+$/, 'invalid ConfigMap key'),
      /** Omit to require only that the key is present. */
      value: z.string().max(4096).optional(),
      ...common,
    })
    .strict(),

  secret_exists: z
    .object({ type: z.literal('secret_exists'), name: resourceName, ...common })
    .strict(),

  /**
   * A Secret carries a given key.
   *
   * There is deliberately **no `value` field**, unlike `configmap_key`. Secret
   * values are never read into the platform, never logged, and never compared —
   * so a lab cannot be written that would require the verifier to hold one.
   */
  secret_key: z
    .object({
      type: z.literal('secret_key'),
      name: resourceName,
      key: z.string().min(1).max(253).regex(/^[-._a-zA-Z0-9]+$/, 'invalid Secret key'),
      ...common,
    })
    .strict(),

  secret_type: z
    .object({
      type: z.literal('secret_type'),
      name: resourceName,
      expected: z.string().min(1).max(253),
      ...common,
    })
    .strict(),

  // --- Batch workloads ---------------------------------------------------
  job_exists: z.object({ type: z.literal('job_exists'), name: resourceName, ...common }).strict(),

  /**
   * The Job finished successfully.
   *
   * Checks the `Complete` condition rather than a non-zero `succeeded` count,
   * because a Job asking for several completions can report successes while
   * still running.
   */
  job_completed: z
    .object({
      type: z.literal('job_completed'),
      name: resourceName,
      /** Require at least this many successful completions. Defaults to all. */
      min_succeeded: z.number().int().min(1).max(50).optional(),
      ...common,
    })
    .strict(),

  job_image: z
    .object({
      type: z.literal('job_image'),
      name: resourceName,
      container: resourceName.optional(),
      image: imageReference,
      ...common,
    })
    .strict(),

  cronjob_exists: z
    .object({ type: z.literal('cronjob_exists'), name: resourceName, ...common })
    .strict(),

  cronjob_schedule: z
    .object({ type: z.literal('cronjob_schedule'), name: resourceName, schedule: cronSchedule, ...common })
    .strict(),

  /** A CronJob must not be left suspended, or it never runs. */
  cronjob_suspended: z
    .object({
      type: z.literal('cronjob_suspended'),
      name: resourceName,
      expected: z.boolean(),
      ...common,
    })
    .strict(),

  // --- RBAC --------------------------------------------------------------
  role_exists: z.object({ type: z.literal('role_exists'), name: resourceName, ...common }).strict(),

  role_rule: z
    .object({
      type: z.literal('role_rule'),
      name: resourceName,
      apiGroups: z.array(z.string().max(64)).min(1).max(8),
      resources: z.array(z.string().min(1).max(64)).min(1).max(16),
      verbs: z.array(z.string().min(1).max(32)).min(1).max(16),
      ...common,
    })
    .strict(),

  rolebinding_exists: z
    .object({ type: z.literal('rolebinding_exists'), name: resourceName, ...common })
    .strict(),

  rolebinding_subject: z
    .object({
      type: z.literal('rolebinding_subject'),
      name: resourceName,
      kind: rbacSubjectKind,
      subjectName: z.string().min(1).max(253),
      ...common,
    })
    .strict(),

  rolebinding_role_ref: z
    .object({
      type: z.literal('rolebinding_role_ref'),
      name: resourceName,
      roleName: resourceName,
      roleKind: rbacRoleKind,
      ...common,
    })
    .strict(),

  serviceaccount_exists: z
    .object({ type: z.literal('serviceaccount_exists'), name: resourceName, ...common })
    .strict(),

  auth_allowed: z.object({ type: z.literal('auth_allowed'), ...authCheckFields, ...common }).strict(),

  auth_forbidden: z
    .object({ type: z.literal('auth_forbidden'), ...authCheckFields, ...common })
    .strict(),

  // --- Storage -----------------------------------------------------------
  pvc_exists: z.object({ type: z.literal('pvc_exists'), name: resourceName, ...common }).strict(),

  pvc_bound: z.object({ type: z.literal('pvc_bound'), name: resourceName, ...common }).strict(),

  pvc_storage_class: z
    .object({
      type: z.literal('pvc_storage_class'),
      name: resourceName,
      storageClassName: z.string().max(253),
      ...common,
    })
    .strict(),

  pvc_access_modes: z
    .object({
      type: z.literal('pvc_access_modes'),
      name: resourceName,
      accessModes: z
        .array(z.enum(['ReadWriteOnce', 'ReadOnlyMany', 'ReadWriteMany', 'ReadWriteOncePod']))
        .min(1)
        .max(4),
      ...common,
    })
    .strict(),

  pvc_storage_request: z
    .object({
      type: z.literal('pvc_storage_request'),
      name: resourceName,
      storage: quantity,
      ...common,
    })
    .strict(),

  pvc_volume_mode: z
    .object({
      type: z.literal('pvc_volume_mode'),
      name: resourceName,
      volumeMode: z.enum(['Filesystem', 'Block']),
      ...common,
    })
    .strict(),

  workload_mounts_pvc: z
    .object({
      type: z.literal('workload_mounts_pvc'),
      kind: z.enum(['pod', 'deployment', 'statefulset']),
      name: resourceName,
      claim: resourceName,
      mountPath: z.string().min(1).max(253).regex(/^\//, 'mountPath must be absolute'),
      container: resourceName.optional(),
      ...common,
    })
    .strict(),

  storageclass_exists: z
    .object({ type: z.literal('storageclass_exists'), name: resourceName, ...common })
    .strict(),

  // --- Ingress -----------------------------------------------------------
  ingress_exists: z
    .object({ type: z.literal('ingress_exists'), name: resourceName, ...common })
    .strict(),

  ingress_class: z
    .object({
      type: z.literal('ingress_class'),
      name: resourceName,
      ingressClassName: z.string().min(1).max(253),
      ...common,
    })
    .strict(),

  ingress_rule: z
    .object({
      type: z.literal('ingress_rule'),
      name: resourceName,
      host: z.string().min(1).max(253),
      path: z.string().min(1).max(512),
      pathType: z.enum(['Prefix', 'Exact', 'ImplementationSpecific']).optional(),
      service: resourceName,
      port: portValue,
      ...common,
    })
    .strict(),

  ingress_tls: z
    .object({
      type: z.literal('ingress_tls'),
      name: resourceName,
      hosts: z.array(z.string().min(1).max(253)).min(1).max(16),
      secretName: resourceName,
      ...common,
    })
    .strict(),

  ingress_default_backend: z
    .object({
      type: z.literal('ingress_default_backend'),
      name: resourceName,
      service: resourceName,
      port: portValue,
      ...common,
    })
    .strict(),

  // --- NetworkPolicy -----------------------------------------------------
  networkpolicy_exists: z
    .object({ type: z.literal('networkpolicy_exists'), name: resourceName, ...common })
    .strict(),

  networkpolicy_pod_selector: z
    .object({
      type: z.literal('networkpolicy_pod_selector'),
      name: resourceName,
      matchLabels: selectorLabels,
      ...common,
    })
    .strict(),

  networkpolicy_policy_types: z
    .object({
      type: z.literal('networkpolicy_policy_types'),
      name: resourceName,
      policyTypes: z.array(z.enum(['Ingress', 'Egress'])).min(1).max(2),
      ...common,
    })
    .strict(),

  networkpolicy_ingress_rule: z
    .object({
      type: z.literal('networkpolicy_ingress_rule'),
      name: resourceName,
      fromPodSelector: selectorLabels.optional(),
      fromNamespaceSelector: selectorLabels.optional(),
      port: z.number().int().min(1).max(65535).optional(),
      protocol: z.enum(['TCP', 'UDP', 'SCTP']).optional(),
      ...common,
    })
    .strict(),

  networkpolicy_egress_rule: z
    .object({
      type: z.literal('networkpolicy_egress_rule'),
      name: resourceName,
      toPodSelector: selectorLabels.optional(),
      toNamespaceSelector: selectorLabels.optional(),
      port: z.number().int().min(1).max(65535).optional(),
      protocol: z.enum(['TCP', 'UDP', 'SCTP']).optional(),
      ...common,
    })
    .strict(),

  networkpolicy_allows_dns: z
    .object({ type: z.literal('networkpolicy_allows_dns'), name: resourceName, ...common })
    .strict(),

  // --- StatefulSet -------------------------------------------------------
  statefulset_exists: z
    .object({ type: z.literal('statefulset_exists'), name: resourceName, ...common })
    .strict(),

  statefulset_replicas: z
    .object({
      type: z.literal('statefulset_replicas'),
      name: resourceName,
      replicas: z.number().int().min(0).max(20),
      ...common,
    })
    .strict(),

  statefulset_ready: z
    .object({
      type: z.literal('statefulset_ready'),
      name: resourceName,
      min_ready: z.number().int().min(1).max(20).optional(),
      ...common,
    })
    .strict(),

  statefulset_image: z
    .object({
      type: z.literal('statefulset_image'),
      name: resourceName,
      container: resourceName.optional(),
      image: imageReference,
      ...common,
    })
    .strict(),

  statefulset_service_name: z
    .object({
      type: z.literal('statefulset_service_name'),
      name: resourceName,
      serviceName: resourceName,
      ...common,
    })
    .strict(),

  statefulset_volume_claim_template: z
    .object({
      type: z.literal('statefulset_volume_claim_template'),
      name: resourceName,
      claimName: resourceName,
      storageClassName: z.string().max(253).optional(),
      accessModes: z
        .array(z.enum(['ReadWriteOnce', 'ReadOnlyMany', 'ReadWriteMany', 'ReadWriteOncePod']))
        .min(1)
        .max(4)
        .optional(),
      storage: quantity.optional(),
      ...common,
    })
    .strict(),

  // --- DaemonSet ---------------------------------------------------------
  daemonset_exists: z
    .object({ type: z.literal('daemonset_exists'), name: resourceName, ...common })
    .strict(),

  daemonset_image: z
    .object({
      type: z.literal('daemonset_image'),
      name: resourceName,
      container: resourceName.optional(),
      image: imageReference,
      ...common,
    })
    .strict(),

  daemonset_selector: z
    .object({
      type: z.literal('daemonset_selector'),
      name: resourceName,
      selector: labelMap,
      ...common,
    })
    .strict(),

  daemonset_scheduled: z
    .object({
      type: z.literal('daemonset_scheduled'),
      name: resourceName,
      min_scheduled: z.number().int().min(1).max(50).optional(),
      ...common,
    })
    .strict(),

  daemonset_ready: z
    .object({
      type: z.literal('daemonset_ready'),
      name: resourceName,
      min_ready: z.number().int().min(1).max(50).optional(),
      ...common,
    })
    .strict(),

  // --- Scheduling --------------------------------------------------------
  pod_node_selector: z
    .object({
      type: z.literal('pod_node_selector'),
      name: resourceName,
      nodeSelector: labelMap,
      ...common,
    })
    .strict(),

  pod_tolerations: z
    .object({
      type: z.literal('pod_tolerations'),
      name: resourceName,
      tolerations: z.array(tolerationSpec).min(1).max(16),
      ...common,
    })
    .strict(),

  pod_node_name: z
    .object({
      type: z.literal('pod_node_name'),
      name: resourceName,
      nodeName: z.string().min(1).max(253),
      ...common,
    })
    .strict(),

  deployment_node_selector: z
    .object({
      type: z.literal('deployment_node_selector'),
      name: resourceName,
      nodeSelector: labelMap,
      ...common,
    })
    .strict(),

  deployment_tolerations: z
    .object({
      type: z.literal('deployment_tolerations'),
      name: resourceName,
      tolerations: z.array(tolerationSpec).min(1).max(16),
      ...common,
    })
    .strict(),

  pod_affinity_required: z
    .object({
      type: z.literal('pod_affinity_required'),
      name: resourceName,
      topologyKey: z.string().min(1).max(253),
      matchLabels: selectorLabels.optional(),
      ...common,
    })
    .strict(),

  pod_anti_affinity_required: z
    .object({
      type: z.literal('pod_anti_affinity_required'),
      name: resourceName,
      topologyKey: z.string().min(1).max(253),
      matchLabels: selectorLabels.optional(),
      ...common,
    })
    .strict(),

  pod_scheduled_on_node: z
    .object({
      type: z.literal('pod_scheduled_on_node'),
      name: resourceName,
      nodeName: z.string().min(1).max(253),
      ...common,
    })
    .strict(),

  // --- HPA ---------------------------------------------------------------
  hpa_exists: z.object({ type: z.literal('hpa_exists'), name: resourceName, ...common }).strict(),

  hpa_target: z
    .object({
      type: z.literal('hpa_target'),
      name: resourceName,
      targetKind: z.enum(['deployment', 'statefulset']),
      targetName: resourceName,
      ...common,
    })
    .strict(),

  hpa_replicas: z
    .object({
      type: z.literal('hpa_replicas'),
      name: resourceName,
      minReplicas: z.number().int().min(1).max(100).optional(),
      maxReplicas: z.number().int().min(1).max(100).optional(),
      ...common,
    })
    .strict(),

  hpa_metric_cpu: z
    .object({
      type: z.literal('hpa_metric_cpu'),
      name: resourceName,
      averageUtilization: z.number().int().min(1).max(100).optional(),
      ...common,
    })
    .strict(),

  hpa_metric_resource: z
    .object({
      type: z.literal('hpa_metric_resource'),
      name: resourceName,
      resource: z.enum(['cpu', 'memory']),
      averageUtilization: z.number().int().min(1).max(100).optional(),
      ...common,
    })
    .strict(),

  // --- Reachability ------------------------------------------------------
  service_http: z
    .object({
      type: z.literal('service_http'),
      service: resourceName,
      port: z.number().int().min(1).max(65535),
      path: z.string().max(512).regex(/^\//, 'path must start with /').optional(),
      expected_status: z.number().int().min(100).max(599).optional(),
      body_contains: z.string().min(1).max(256).optional(),
      timeout_seconds: z.number().int().min(1).max(15).optional(),
      ...common,
    })
    .strict(),

  service_tcp: z
    .object({
      type: z.literal('service_tcp'),
      service: resourceName,
      port: z.number().int().min(1).max(65535),
      timeout_seconds: z.number().int().min(1).max(15).optional(),
      ...common,
    })
    .strict(),

  /**
   * A named object must NOT exist.
   *
   * Used by clean-up and troubleshooting labs ("the failed Job was removed"),
   * and by labs whose point is that a resource was replaced rather than added.
   */
  resource_absent: z
    .object({
      type: z.literal('resource_absent'),
      kind: z.enum(CHECKABLE_KINDS),
      name: resourceName,
      ...common,
    })
    .strict(),
} as const;

// ---------------------------------------------------------------- Sandbox
//
// Filesystem, Terraform, and Linux checks read inside one session's own
// container — the Linux and Terraform tracks, never the Docker daemon.

const sandboxRequirementSchemas = {
  // --- Sandbox filesystem (Linux / Terraform) ----------------------------
  /**
   * A regular file exists at this path.
   *
   * Deliberately strict about *what* is there: a symlink pointing at the
   * expected name does not satisfy `file_exists`, because the point of a
   * permissions lab is the file, not a name that resolves to one. The reader
   * runs `stat` without `-L` so it can tell the difference.
   */
  file_exists: z
    .object({ type: z.literal('file_exists'), path: sandboxPath, ...common })
    .strict(),

  directory_exists: z
    .object({ type: z.literal('directory_exists'), path: sandboxPath, ...common })
    .strict(),

  /**
   * A file's contents.
   *
   * `equals` compares after trimming trailing whitespace, so a student is not
   * failed for a trailing newline their editor added. `contains` is for files
   * whose exact wording is not the point. There is deliberately no regular
   * expression form: a lab-supplied pattern is untrusted input to a regex
   * engine, and a catastrophic backtrack in the verifier would be a denial of
   * service on the API for everyone.
   */
  file_content: z
    .object({
      type: z.literal('file_content'),
      path: sandboxPath,
      equals: z.string().max(4096).optional(),
      contains: z.string().min(1).max(1024).optional(),
      ...common,
    })
    .strict()
    .refine((v) => v.equals !== undefined || v.contains !== undefined, {
      message: 'must specify equals, contains, or both',
    }),

  file_mode: z
    .object({ type: z.literal('file_mode'), path: sandboxPath, mode: fileMode, ...common })
    .strict(),

  file_owner: z
    .object({ type: z.literal('file_owner'), path: sandboxPath, owner: posixName, ...common })
    .strict(),

  file_group: z
    .object({ type: z.literal('file_group'), path: sandboxPath, group: posixName, ...common })
    .strict(),

  // --- Terraform ---------------------------------------------------------
  /**
   * `terraform init` completed in this directory.
   *
   * Checked from what init actually leaves behind — the `.terraform` directory
   * and the dependency lock file — not from a transcript. A student who ran
   * init in the wrong directory has not initialised the one the lab grades.
   */
  terraform_initialized: z
    .object({ type: z.literal('terraform_initialized'), dir: sandboxPath, ...common })
    .strict(),

  /**
   * A resource is present in the Terraform state.
   *
   * Read from `terraform.tfstate`, so it reflects a *successful apply*.
   * Typing `terraform apply` and answering no leaves no state, and therefore
   * does not pass.
   */
  terraform_resource_exists: z
    .object({
      type: z.literal('terraform_resource_exists'),
      dir: sandboxPath,
      /** Provider resource type, e.g. `local_file`. */
      resource_type: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-z][a-z0-9_]*$/, 'must be a Terraform resource type such as local_file'),
      /** The resource's local name, e.g. `manifest`. */
      name: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/, 'must be a Terraform resource name'),
      ...common,
    })
    .strict(),

  terraform_output_equals: z
    .object({
      type: z.literal('terraform_output_equals'),
      dir: sandboxPath,
      name: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/, 'must be a Terraform output name'),
      value: z.string().max(1024),
      ...common,
    })
    .strict(),

  // =========================================================================
  // Linux sandbox family
  // =========================================================================
  //
  // Everything below observes the *inside of one session's container*: its
  // process table, its listening sockets, its account databases, and paths
  // outside the student's home such as `/etc` and `/var/log`. The filesystem
  // family above stays as it is — these are the checks a Linux system
  // administration lab needs and a plain file check cannot express.
  //
  // Three of them (`script_runs`, `command_exit_code`, `command_output`) run
  // something, which no requirement type did before. They are fenced:
  //
  //   · `command` is drawn from `VERIFIER_COMMANDS`, a closed allow-list of
  //     read-only inspection binaries. A lab cannot name `rm`, `bash`, or
  //     anything outside it, and the list cannot be extended from lab.yaml.
  //   · arguments are an argv array executed with no shell, so argument
  //     content can never become syntax.
  //   · `script_runs` executes only a path the lab names, inside that
  //     student's own throwaway container — the one place that code can
  //     already run, because the student has a shell in it. It reaches
  //     nothing on the host and nothing belonging to another student.

  /**
   * Nothing exists at this path.
   *
   * Used by labs whose point is that something was *moved* rather than copied,
   * and by clean-up steps in troubleshooting labs.
   */
  path_absent: z.object({ type: z.literal('path_absent'), path: sandboxPath, ...common }).strict(),

  /** The file must NOT contain this text — e.g. a fault that had to be removed. */
  file_content_absent: z
    .object({
      type: z.literal('file_content_absent'),
      path: sandboxPath,
      contains: literalText,
      ignore_case: z.boolean().default(false),
      ...common,
    })
    .strict(),

  // --- Processes and ports ------------------------------------------------
  process_running: z
    .object({
      type: z.literal('process_running'),
      /** Fixed text that must appear in the process command line. */
      pattern: processPattern,
      min_count: z.number().int().min(1).max(50).default(1),
      ...common,
    })
    .strict(),

  process_not_running: z
    .object({ type: z.literal('process_not_running'), pattern: processPattern, ...common })
    .strict(),

  port_listening: z
    .object({
      type: z.literal('port_listening'),
      port: z.number().int().min(1).max(65535),
      protocol: z.enum(['tcp', 'udp']).default('tcp'),
      ...common,
    })
    .strict(),

  port_not_listening: z
    .object({
      type: z.literal('port_not_listening'),
      port: z.number().int().min(1).max(65535),
      protocol: z.enum(['tcp', 'udp']).default('tcp'),
      ...common,
    })
    .strict(),

  // --- Accounts -----------------------------------------------------------
  user_exists: z.object({ type: z.literal('user_exists'), name: posixName, ...common }).strict(),

  group_exists: z.object({ type: z.literal('group_exists'), name: posixName, ...common }).strict(),

  user_in_group: z
    .object({
      type: z.literal('user_in_group'),
      user: posixName,
      group: posixName,
      ...common,
    })
    .strict(),

  // --- Scripts ------------------------------------------------------------
  /** A regular file that is executable by its owner. */
  script_executable: z
    .object({ type: z.literal('script_executable'), path: sandboxPath, ...common })
    .strict(),

  /**
   * Run the student's own script and grade its behaviour, not its source.
   *
   * This is what lets a scripting lab accept every correct solution: two
   * students who solve the task with completely different code both pass,
   * because what is compared is the exit status and the output.
   */
  script_runs: z
    .object({
      type: z.literal('script_runs'),
      path: sandboxPath,
      args: z.array(commandArgument).max(8).default([]),
      expected_exit_code: z.number().int().min(0).max(255).default(0),
      output_contains: z.array(literalText).max(8).default([]),
      timeout_seconds: z.number().int().min(1).max(60).default(15),
      ...common,
    })
    .strict(),

  // --- Allow-listed inspection commands -----------------------------------
  command_exit_code: z
    .object({
      type: z.literal('command_exit_code'),
      command: z.enum(VERIFIER_COMMANDS),
      args: z.array(commandArgument).max(12).default([]),
      expected_exit_code: z.number().int().min(0).max(255).default(0),
      as_user: asUser,
      ...common,
    })
    .strict(),

  command_output: z
    .object({
      type: z.literal('command_output'),
      command: z.enum(VERIFIER_COMMANDS),
      args: z.array(commandArgument).max(12).default([]),
      contains: literalText,
      as_user: asUser,
      ...common,
    })
    .strict(),

  /**
   * One directive of a systemd unit file, read semantically.
   *
   * Substring matching grades the wrong thing here. `ExecStart=/usr/bin/app`
   * and `ExecStart = /usr/bin/app` are one directive; a commented-out
   * `#ExecStart=/bin/false` is not a directive at all; `After=` written twice
   * means what `After=a b` means once. A `file_content` check gets all three
   * wrong, and wrong in the direction that passes a broken unit.
   *
   * The verifier parses the file and answers one question about one directive.
   * How that directive is read depends on what systemd documents for it: a
   * dependency or environment setting accumulates across repetitions and is
   * matched by membership, while an ordinary setting is a scalar whose last
   * assignment wins. `LIST_DIRECTIVES` in the verifier holds that mapping.
   *
   * Exactly one of `equals`, `contains` or `absent` is required, so a lab
   * cannot write a check whose meaning is ambiguous.
   */
  systemd_unit_directive: z
    .object({
      type: z.literal('systemd_unit_directive'),
      path: sandboxPath,
      section: z.enum(['Unit', 'Service', 'Install']),
      directive: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z][A-Za-z0-9-]*$/, 'must be a systemd directive name'),
      /** Effective scalar value — the last assignment — must equal this. */
      equals: z.string().min(1).max(512).optional(),
      /** Accumulated, whitespace-split members must include this token. */
      contains: z.string().min(1).max(512).optional(),
      /** The directive must have no value in effect. */
      absent: z.boolean().optional(),
      ...common,
    })
    .strict()
    .refine(
      (v) =>
        [v.equals !== undefined, v.contains !== undefined, v.absent === true].filter(Boolean)
          .length === 1,
      { message: 'must specify exactly one of equals, contains or absent' },
    ),

  /**
   * A systemd unit file declares a section at all.
   *
   * Separate from the directive check so that "there is no [Install] section"
   * reads as its own failure rather than as three unrelated missing
   * directives — which is what a student actually needs to be told.
   */
  systemd_unit_section: z
    .object({
      type: z.literal('systemd_unit_section'),
      path: sandboxPath,
      section: z.enum(['Unit', 'Service', 'Install']),
      ...common,
    })
    .strict(),
} as const;

// ---------------------------------------------------------------- Docker
//
// The Docker vocabulary, subject to exactly the same rules as the Kubernetes
// one above: every schema is `.strict()`, no field carries a command, a script,
// or a shell fragment, and every handler is a *read* of the session's own
// Docker daemon. A student passes by leaving the right state behind, never by
// typing a particular command.

/** A Docker object name, as `docker run --name` and friends accept it. */
const dockerObjectName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, 'must be a Docker object name (letters, digits, and _ . -)');

/**
 * A memory or CPU limit, as the student would have typed it.
 *
 * Compared after normalisation to bytes / nano-CPUs, so `--memory 512m`,
 * `--memory 512M`, and `--memory 536870912` are all the same answer. A lab
 * grades the constraint the daemon is enforcing, not the spelling.
 */
const dockerMemoryValue = z
  .string()
  .min(1)
  .max(24)
  .regex(/^[0-9]+(\.[0-9]+)?\s*([bkmg]|[kmg]b|bytes)?$/i, 'must be a memory value such as 512m');

const dockerCpuValue = z
  .string()
  .min(1)
  .max(12)
  .regex(/^[0-9]+(\.[0-9]+)?$/, 'must be a CPU count such as 0.5');

/** Docker object kinds a requirement may name generically. */
const DOCKER_KINDS = ['container', 'image', 'volume', 'network'] as const;

const dockerRequirementSchemas = {
  // --- Containers ---------------------------------------------------------
  docker_container_exists: z
    .object({ type: z.literal('docker_container_exists'), name: dockerObjectName, ...common })
    .strict(),

  docker_container_running: z
    .object({ type: z.literal('docker_container_running'), name: dockerObjectName, ...common })
    .strict(),

  /**
   * The container's state, for labs where "running" is the wrong answer.
   *
   * The lifecycle lab needs `exited`; the troubleshooting lab needs to confirm
   * a container the student *stopped* is genuinely stopped rather than removed.
   */
  docker_container_state: z
    .object({
      type: z.literal('docker_container_state'),
      name: dockerObjectName,
      expected: z.enum(['created', 'running', 'paused', 'restarting', 'exited', 'dead']),
      ...common,
    })
    .strict(),

  docker_container_image: z
    .object({
      type: z.literal('docker_container_image'),
      name: dockerObjectName,
      image: imageReference,
      ...common,
    })
    .strict(),

  /**
   * The container's last exit code.
   *
   * How a Dockerfile lab confirms the built image "behaves correctly": the
   * student runs a container from their image and it has to succeed.
   */
  docker_container_exit_code: z
    .object({
      type: z.literal('docker_container_exit_code'),
      name: dockerObjectName,
      expected: z.number().int().min(0).max(255),
      ...common,
    })
    .strict(),

  /**
   * An environment variable is set on the container.
   *
   * `value` is optional so a lab can require only that a variable was passed.
   * Lab content never uses this for anything secret — see the Docker track's
   * environment lab, which configures an application, not a credential.
   */
  docker_container_env: z
    .object({
      type: z.literal('docker_container_env'),
      name: dockerObjectName,
      key: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid environment variable name'),
      value: z.string().max(1024).optional(),
      ...common,
    })
    .strict(),

  docker_container_port: z
    .object({
      type: z.literal('docker_container_port'),
      name: dockerObjectName,
      /** Port inside the container. */
      container_port: z.number().int().min(1).max(65535),
      /** Published port on the daemon side. Omit to require only an exposure. */
      host_port: z.number().int().min(1).max(65535).optional(),
      protocol: z.enum(['tcp', 'udp']).default('tcp'),
      ...common,
    })
    .strict(),

  docker_container_network: z
    .object({
      type: z.literal('docker_container_network'),
      name: dockerObjectName,
      network: dockerObjectName,
      ...common,
    })
    .strict(),

  /** A named volume is mounted into the container, optionally at a given path. */
  docker_container_mount: z
    .object({
      type: z.literal('docker_container_mount'),
      name: dockerObjectName,
      volume: dockerObjectName,
      destination: z.string().min(1).max(255).optional(),
      ...common,
    })
    .strict(),

  /**
   * A resource control the daemon is actually enforcing.
   *
   * Read from the container's HostConfig, so it reflects what Docker applied
   * rather than what the student believes they typed.
   */
  docker_container_resource_limit: z
    .object({
      type: z.literal('docker_container_resource_limit'),
      name: dockerObjectName,
      memory: dockerMemoryValue.optional(),
      cpus: dockerCpuValue.optional(),
      pids_limit: z.number().int().min(1).max(100_000).optional(),
      ...common,
    })
    .strict()
    .refine(
      (v) => v.memory !== undefined || v.cpus !== undefined || v.pids_limit !== undefined,
      { message: 'must specify memory, cpus, pids_limit, or a combination' },
    ),

  // --- Images -------------------------------------------------------------
  docker_image_exists: z
    .object({ type: z.literal('docker_image_exists'), image: imageReference, ...common })
    .strict(),

  /**
   * Configuration baked into an image by its Dockerfile.
   *
   * This is how a Dockerfile lab grades the instructions the student wrote:
   * `WORKDIR` becomes `working_dir`, `CMD` becomes `cmd`, `ENV` becomes `env`,
   * `EXPOSE` becomes `exposed_port`. Reading the built image rather than the
   * source text means a student who achieves the same result differently — a
   * different base, an ENTRYPOINT instead of a CMD form — is graded on what
   * they actually produced.
   */
  docker_image_config: z
    .object({
      type: z.literal('docker_image_config'),
      image: imageReference,
      working_dir: z.string().min(1).max(255).optional(),
      /** Every listed argv element must appear, in order, in CMD or ENTRYPOINT. */
      cmd_contains: z.array(z.string().min(1).max(255)).max(10).optional(),
      env: z.record(z.string().min(1).max(128), z.string().max(1024)).optional(),
      exposed_port: z.number().int().min(1).max(65535).optional(),
      labels: z.record(z.string().min(1).max(128), z.string().max(256)).optional(),
      ...common,
    })
    .strict()
    .refine(
      (v) =>
        v.working_dir !== undefined ||
        v.cmd_contains !== undefined ||
        v.env !== undefined ||
        v.exposed_port !== undefined ||
        v.labels !== undefined,
      { message: 'must assert at least one image configuration field' },
    ),

  // --- Volumes and networks ------------------------------------------------
  docker_volume_exists: z
    .object({ type: z.literal('docker_volume_exists'), name: dockerObjectName, ...common })
    .strict(),

  docker_network_exists: z
    .object({
      type: z.literal('docker_network_exists'),
      name: dockerObjectName,
      driver: z.enum(['bridge', 'host', 'none', 'overlay', 'macvlan']).optional(),
      ...common,
    })
    .strict(),

  // --- Workspace -----------------------------------------------------------
  /**
   * A file exists in the session workspace.
   *
   * Deliberately *not* `file_exists`. That check reads the sandbox filesystem,
   * which for a Linux or Terraform lab is the container the student's shell
   * runs in. A Docker lab's authored files live somewhere else entirely — the
   * terminal service's per-session workspace, which is the build context
   * `docker build` sees — so it is read through a different reader and named
   * for what it actually looks at.
   *
   * `contains` is a plain substring test over the file's text, used to confirm
   * the student wrote the thing the lab asked for. It is a *read*: the file is
   * never executed, sourced, or parsed as code by the platform.
   */
  workspace_file_exists: z
    .object({
      type: z.literal('workspace_file_exists'),
      path: z
        .string()
        .min(1)
        .max(255)
        .regex(/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/, 'must be a relative path inside the lab workspace')
        .refine((p) => !p.split('/').includes('..'), { message: 'must not traverse upwards' }),
      contains: z.array(z.string().min(1).max(255)).max(10).optional(),
      ...common,
    })
    .strict(),

  /**
   * A Dockerfile in the workspace parses and carries the required instructions.
   *
   * Parsing is structural only — instruction keywords and their arguments. The
   * platform never builds, runs, or evaluates the file; the student's own
   * `docker build` is what proves it works, and `docker_image_exists` is what
   * grades the result.
   */
  dockerfile_valid: z
    .object({
      type: z.literal('dockerfile_valid'),
      path: z
        .string()
        .min(1)
        .max(255)
        .regex(/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/, 'must be a relative path inside the lab workspace')
        .refine((p) => !p.split('/').includes('..'), { message: 'must not traverse upwards' })
        .default('Dockerfile'),
      /** Instructions that must be present, e.g. `[FROM, WORKDIR, CMD]`. */
      requires: z
        .array(
          z.enum([
            'FROM',
            'RUN',
            'CMD',
            'LABEL',
            'EXPOSE',
            'ENV',
            'ADD',
            'COPY',
            'ENTRYPOINT',
            'VOLUME',
            'USER',
            'WORKDIR',
            'ARG',
            'HEALTHCHECK',
          ]),
        )
        .max(14)
        .default([]),
      /** Require the base image named by `FROM`. */
      base_image: imageReference.optional(),
      ...common,
    })
    .strict(),

  /**
   * A named Docker object must NOT exist.
   *
   * The Docker counterpart of `resource_absent`: the check a student satisfies
   * by removing something, which is what `docker rm` labs are about.
   */
  docker_resource_absent: z
    .object({
      type: z.literal('docker_resource_absent'),
      kind: z.enum(DOCKER_KINDS),
      name: z.string().min(1).max(512),
      ...common,
    })
    .strict(),
} as const;

/**
 * The complete requirement vocabulary, across every track.
 *
 * Kubernetes, sandbox, and Docker requirement types live in separate objects
 * above so that each substrate's verifier registry can be checked for
 * completeness independently — see `services/verifier/src/registry.ts`, where
 * the mapped types make a missing handler a compile error rather than a runtime
 * surprise.
 */
const requirementSchemas = {
  ...kubernetesRequirementSchemas,
  ...sandboxRequirementSchemas,
  ...dockerRequirementSchemas,
} as const;

/** Every requirement type the platform supports, in documentation order. */
export const REQUIREMENT_TYPES = Object.keys(requirementSchemas) as ReadonlyArray<RequirementType>;

export type RequirementType = keyof typeof requirementSchemas;

/**
 * Which reader a requirement needs.
 *
 * This is the whole of the verifier's dispatch: `kubernetes` checks read the
 * Kubernetes API in the session's namespace; `filesystem`, `terraform` and
 * `linux` checks read inside the session's sandbox; `docker` checks read one
 * session's own Docker daemon and workspace. Splitting them is not cosmetic —
 * it is what lets `lab-definition.ts` say "the Linux provider cannot verify
 * Terraform state", "the Kubernetes provider cannot inspect a process table",
 * or "a Docker lab cannot ask for `pod_running`", and refuse the lab at load
 * time.
 *
 * `filesystem` needs only a path read; `linux` additionally needs the sandbox
 * to answer an allow-listed inspection command, which is why a provider that
 * offers reads but not exec reports `linux` checks as skipped rather than
 * failed.
 *
 * The mapped type below is the completeness guarantee: adding a requirement
 * type without classifying it fails to compile, so a new check can never
 * silently fall through to the wrong reader.
 */
export type RequirementFamily =
  | 'kubernetes'
  | 'filesystem'
  | 'terraform'
  | 'linux'
  | 'docker';

export const REQUIREMENT_FAMILIES = {
  pod_exists: 'kubernetes',
  pod_image: 'kubernetes',
  pod_running: 'kubernetes',
  pod_phase: 'kubernetes',
  pod_ready: 'kubernetes',
  pod_label: 'kubernetes',
  pod_resources: 'kubernetes',

  deployment_exists: 'kubernetes',
  deployment_image: 'kubernetes',
  deployment_replicas: 'kubernetes',
  deployment_available: 'kubernetes',
  deployment_rollout_complete: 'kubernetes',
  deployment_selector: 'kubernetes',
  deployment_resources: 'kubernetes',
  deployment_probe: 'kubernetes',
  deployment_uses_configmap: 'kubernetes',
  deployment_uses_secret: 'kubernetes',

  service_exists: 'kubernetes',
  service_type: 'kubernetes',
  service_port: 'kubernetes',
  service_selector: 'kubernetes',
  service_endpoints: 'kubernetes',

  configmap_exists: 'kubernetes',
  configmap_key: 'kubernetes',
  secret_exists: 'kubernetes',
  secret_key: 'kubernetes',
  secret_type: 'kubernetes',

  job_exists: 'kubernetes',
  job_completed: 'kubernetes',
  job_image: 'kubernetes',
  cronjob_exists: 'kubernetes',
  cronjob_schedule: 'kubernetes',
  cronjob_suspended: 'kubernetes',

  role_exists: 'kubernetes',
  role_rule: 'kubernetes',
  rolebinding_exists: 'kubernetes',
  rolebinding_subject: 'kubernetes',
  rolebinding_role_ref: 'kubernetes',
  serviceaccount_exists: 'kubernetes',
  auth_allowed: 'kubernetes',
  auth_forbidden: 'kubernetes',

  pvc_exists: 'kubernetes',
  pvc_bound: 'kubernetes',
  pvc_storage_class: 'kubernetes',
  pvc_access_modes: 'kubernetes',
  pvc_storage_request: 'kubernetes',
  pvc_volume_mode: 'kubernetes',
  workload_mounts_pvc: 'kubernetes',
  storageclass_exists: 'kubernetes',

  ingress_exists: 'kubernetes',
  ingress_class: 'kubernetes',
  ingress_rule: 'kubernetes',
  ingress_tls: 'kubernetes',
  ingress_default_backend: 'kubernetes',

  networkpolicy_exists: 'kubernetes',
  networkpolicy_pod_selector: 'kubernetes',
  networkpolicy_policy_types: 'kubernetes',
  networkpolicy_ingress_rule: 'kubernetes',
  networkpolicy_egress_rule: 'kubernetes',
  networkpolicy_allows_dns: 'kubernetes',

  statefulset_exists: 'kubernetes',
  statefulset_replicas: 'kubernetes',
  statefulset_ready: 'kubernetes',
  statefulset_image: 'kubernetes',
  statefulset_service_name: 'kubernetes',
  statefulset_volume_claim_template: 'kubernetes',

  daemonset_exists: 'kubernetes',
  daemonset_image: 'kubernetes',
  daemonset_selector: 'kubernetes',
  daemonset_scheduled: 'kubernetes',
  daemonset_ready: 'kubernetes',

  pod_node_selector: 'kubernetes',
  pod_tolerations: 'kubernetes',
  pod_node_name: 'kubernetes',
  deployment_node_selector: 'kubernetes',
  deployment_tolerations: 'kubernetes',
  pod_affinity_required: 'kubernetes',
  pod_anti_affinity_required: 'kubernetes',
  pod_scheduled_on_node: 'kubernetes',

  hpa_exists: 'kubernetes',
  hpa_target: 'kubernetes',
  hpa_replicas: 'kubernetes',
  hpa_metric_cpu: 'kubernetes',
  hpa_metric_resource: 'kubernetes',

  service_http: 'kubernetes',
  service_tcp: 'kubernetes',

  file_exists: 'filesystem',
  directory_exists: 'filesystem',
  file_content: 'filesystem',
  file_mode: 'filesystem',
  file_owner: 'filesystem',
  file_group: 'filesystem',

  terraform_initialized: 'terraform',
  terraform_resource_exists: 'terraform',
  terraform_output_equals: 'terraform',

  resource_absent: 'kubernetes',

  // These three read a path and nothing else, so they belong with the rest of
  // the filesystem family — a sandbox that can answer `file_mode` can answer
  // them too. `linux` is reserved for the checks that genuinely need the
  // sandbox to answer an *inspection command*.
  path_absent: 'filesystem',
  file_content_absent: 'filesystem',
  script_executable: 'filesystem',

  process_running: 'linux',
  process_not_running: 'linux',
  port_listening: 'linux',
  port_not_listening: 'linux',
  user_exists: 'linux',
  group_exists: 'linux',
  user_in_group: 'linux',
  script_runs: 'linux',
  command_exit_code: 'linux',
  command_output: 'linux',
  systemd_unit_section: 'linux',
  systemd_unit_directive: 'linux',

  // --- Docker: one session's own daemon --------------------------------
  docker_container_exists: 'docker',
  docker_container_running: 'docker',
  docker_container_state: 'docker',
  docker_container_image: 'docker',
  docker_container_exit_code: 'docker',
  docker_container_env: 'docker',
  docker_container_port: 'docker',
  docker_container_network: 'docker',
  docker_container_mount: 'docker',
  docker_container_resource_limit: 'docker',

  docker_image_exists: 'docker',
  docker_image_config: 'docker',
  docker_volume_exists: 'docker',
  docker_network_exists: 'docker',

  // Read through the same Docker reader: the session workspace is reached
  // over the terminal service, not through the sandbox filesystem.
  workspace_file_exists: 'docker',
  dockerfile_valid: 'docker',

  docker_resource_absent: 'docker',
  // `as const satisfies` rather than a plain annotation: the literal family of
  // each type has to survive for `RequirementTypeOf` to be able to filter on
  // it, while `satisfies` still enforces that every requirement type is
  // classified and that no family outside the union sneaks in.
} as const satisfies { [K in RequirementType]: RequirementFamily };

export function requirementFamily(type: RequirementType): RequirementFamily {
  return REQUIREMENT_FAMILIES[type];
}

/** The requirement types belonging to one family, at the type level. */
export type RequirementTypeOf<F extends RequirementFamily> = {
  [K in RequirementType]: (typeof REQUIREMENT_FAMILIES)[K] extends F ? K : never;
}[RequirementType];

/** Requirement types read inside the session's sandbox rather than Kubernetes. */
export type SandboxRequirementType = RequirementTypeOf<'filesystem' | 'terraform' | 'linux'>;

export type KubernetesRequirementType = RequirementTypeOf<'kubernetes'>;

/** Sandbox checks that additionally need an allow-listed inspection command. */
export type LinuxRequirementType = RequirementTypeOf<'linux'>;

export const LINUX_REQUIREMENT_TYPES = requirementTypesForFamily('linux') as LinuxRequirementType[];

export function requirementTypesForFamily(family: RequirementFamily): RequirementType[] {
  return REQUIREMENT_TYPES.filter((type) => REQUIREMENT_FAMILIES[type] === family);
}

/** Requirement types verified by reading a session's own Docker daemon. */
export type DockerRequirementType = RequirementTypeOf<'docker'>;

export const KUBERNETES_REQUIREMENT_TYPES = requirementTypesForFamily(
  'kubernetes',
) as ReadonlyArray<KubernetesRequirementType>;

export const DOCKER_REQUIREMENT_TYPES = requirementTypesForFamily(
  'docker',
) as ReadonlyArray<DockerRequirementType>;

export function isSupportedRequirementType(value: unknown): value is RequirementType {
  return typeof value === 'string' && Object.hasOwn(requirementSchemas, value);
}

export function isLinuxRequirementType(value: unknown): value is LinuxRequirementType {
  return isSupportedRequirementType(value) && requirementFamily(value) === 'linux';
}

export function isDockerRequirementType(value: unknown): value is DockerRequirementType {
  return isSupportedRequirementType(value) && requirementFamily(value) === 'docker';
}

export function isKubernetesRequirementType(value: unknown): value is KubernetesRequirementType {
  return isSupportedRequirementType(value) && requirementFamily(value) === 'kubernetes';
}

/** True when every requirement in a batch needs the Docker engine reader. */
export function requirementsNeedDocker(requirements: readonly { type: string }[]): boolean {
  return requirements.some(
    (r) => isSupportedRequirementType(r.type) && requirementFamily(r.type) === 'docker',
  );
}

/** True when every requirement in a batch needs the Kubernetes API reader. */
export function requirementsNeedKubernetes(requirements: readonly { type: string }[]): boolean {
  return requirements.some(
    (r) => isSupportedRequirementType(r.type) && requirementFamily(r.type) === 'kubernetes',
  );
}

const schemaValues = Object.values(requirementSchemas) as unknown as [
  z.ZodTypeAny,
  z.ZodTypeAny,
  ...z.ZodTypeAny[],
];

/**
 * Union of every requirement schema.
 *
 * A plain union (rather than `discriminatedUnion`) is used because several
 * members carry `.refine()` wrappers, which the discriminated variant rejects.
 * `lab-definition.ts` checks the `type` discriminator itself first, so the
 * union never has to produce the "no matching variant" error.
 */
export const requirementSchema = z.union(schemaValues);

export type Requirement = {
  [K in RequirementType]: z.infer<(typeof requirementSchemas)[K]>;
}[RequirementType];

/** A requirement observed against a Kubernetes namespace. */
export type KubernetesRequirement = {
  [K in KubernetesRequirementType]: z.infer<(typeof requirementSchemas)[K]>;
}[KubernetesRequirementType];

/** A requirement observed inside the session's sandbox container. */
export type SandboxRequirement = {
  [K in SandboxRequirementType]: z.infer<(typeof requirementSchemas)[K]>;
}[SandboxRequirementType];

/** Narrow a validated requirement to one type. */
export type RequirementOf<T extends RequirementType> = z.infer<(typeof requirementSchemas)[T]>;

/** The Kubernetes object kind a requirement reads, used for grouping/fetch planning. */
export function requirementSubject(requirement: Requirement): string {
  return requirement.type.split('_')[0] ?? requirement.type;
}
