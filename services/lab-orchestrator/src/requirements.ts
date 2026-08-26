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

/**
 * A Kubernetes IntOrString used for surge/unavailable counts: a non-negative
 * whole number of Pods, or a percentage of `replicas`.
 */
const intOrPercent = z.union([
  z.number().int().min(0).max(1000),
  z.string().regex(/^\d{1,3}%$/, 'must be a whole number or a percentage such as 25%'),
]);

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
 * How many matching processes `process_environ` will read.
 *
 * A bound, not a preference: without one, a lab pointed at a common pattern
 * would make the verifier read `/proc/<pid>/environ` once per matching process,
 * and a student could inflate that number at will.
 */
const MAX_ENVIRON_PROCESSES = 20;

/** An environment variable name, as the kernel and POSIX allow one to be. */
const environName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid environment variable name');

/**
 * One assertion about one variable.
 *
 * Exactly one predicate per entry, so a check can never be ambiguous about what
 * it is asserting. `present` and `absent` compare nothing, which is what makes
 * them the right choice for a variable whose value is a secret.
 */
const environAssertion = z
  .object({
    name: environName,
    /** The variable must exist. Its value is not read. */
    present: z.literal(true).optional(),
    /** The variable must not exist. */
    absent: z.literal(true).optional(),
    /** The variable must equal this exactly. For non-secret values only. */
    equals: literalText.optional(),
    /** The variable must not equal this. */
    not_equals: literalText.optional(),
    /**
     * Suppress the variable name in failure detail.
     *
     * The verifier never emits a *value*. This additionally withholds the
     * *name*, for a lab where even naming the variable would say too much.
     */
    sensitive: z.boolean().default(false),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const predicates = (['present', 'absent', 'equals', 'not_equals'] as const).filter(
      (key) => entry[key] !== undefined,
    );
    if (predicates.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          predicates.length === 0
            ? `variable '${entry.name}' must state one of present, absent, equals or not_equals`
            : `variable '${entry.name}' states ${predicates.join(', ')}; exactly one is allowed`,
      });
    }
  });

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

  /**
   * A Service with no cluster IP of its own.
   *
   * `spec.clusterIP: "None"` is what makes a Service headless: kube-proxy
   * allocates no virtual IP and does no load balancing, and DNS returns the
   * Pod addresses directly instead of one VIP. That is the property a
   * StatefulSet's governing Service must have for per-Pod DNS names to exist,
   * and it is invisible to `service_type` — a headless Service is still of
   * type `ClusterIP`, so the two checks answer different questions.
   */
  service_headless: z
    .object({ type: z.literal('service_headless'), name: resourceName, ...common })
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
  /**
   * An annotation on a workload's own metadata.
   *
   * Deliberately has no `namespace` field. The reader is constructed for one
   * session's namespace and every read goes through it, so there is no way to
   * express "look in another student's namespace" — the check cannot reach one
   * even if a lab definition tried. `kind` is a closed enum over the three
   * workloads the reader already fetches, so this is not a general API
   * traversal primitive either.
   *
   * Exactly one of `value` (exact match) or `min_int` (numeric floor) is
   * required. `min_int` exists because the useful annotations are often
   * counters — `deployment.kubernetes.io/revision` is the motivating case, and
   * asserting an exact revision would fail a student who simply rolled twice.
   */
  /**
   * A Deployment's update strategy.
   *
   * `maxSurge` / `maxUnavailable` are Kubernetes IntOrString: an absolute Pod
   * count or a percentage of `replicas`. Both spellings are accepted here and
   * compared by meaning rather than by text, so `1` and `"1"` agree while `1`
   * and `"1%"` do not — one is a Pod, the other is a proportion.
   *
   * There is no defaulting to reproduce: the API server stores the effective
   * strategy on the object, defaulting an unset one to RollingUpdate at 25%/25%
   * and omitting `rollingUpdate` entirely under Recreate. The handler reads
   * what is actually stored.
   */
  /**
   * One container inside a workload's Pod template.
   *
   * `collection` is what makes this precise rather than approximate: a Pod has
   * two independent lists and a name may appear in either, so the requirement
   * says which one it means. `containers` is the default because that is the
   * common case.
   *
   * `restartPolicy` here is the *container's* field, which only an init
   * container may set and only to `Always` — that is what makes it a native
   * sidecar. It is not the Pod's `restartPolicy`, which every Deployment
   * template carries as `Always` anyway.
   *
   * `kind` is a closed enum, and there is no `namespace` field: reads are bound
   * to the session's own namespace by the reader.
   */
  /**
   * One container's mount of one volume, at one path.
   *
   * The question this answers is deliberately narrow and deliberately not
   * "does this workload have a volume called x". A volume in `spec.volumes`
   * that nothing mounts is inert, and two containers each mounting *a* volume
   * is not the same as two containers sharing *one* volume — which is the only
   * thing that makes a sidecar work. So the check is anchored to a named
   * container in a named list, and the volume must appear in that container's
   * own `volumeMounts`.
   *
   * `source` is optional and, when given, is resolved through the Pod's
   * `spec.volumes` — so a lab can require that the shared volume is an
   * `emptyDir` rather than, say, a Secret that happens to carry the right name.
   *
   * As with the other workload checks there is no `namespace` field: reads are
   * bound to the session's namespace by the reader, and `kind` is a closed
   * enum rather than a group/version/resource triple.
   */
  workload_volume_mount: z
    .object({
      type: z.literal('workload_volume_mount'),
      kind: z.enum(['pod', 'deployment']),
      name: resourceName,
      container: resourceName,
      collection: z.enum(['containers', 'initContainers']).default('containers'),
      /** The `volumes[].name` the container must mount. */
      volume: resourceName,
      mountPath: z.string().min(1).max(253).regex(/^\//, 'mountPath must be absolute'),
      readOnly: z.boolean().optional(),
      subPath: z.string().min(1).max(253).optional(),
      source: z
        .enum(['emptyDir', 'configMap', 'secret', 'projected', 'persistentVolumeClaim'])
        .optional(),
      ...common,
    })
    .strict(),
  workload_container: z
    .object({
      type: z.literal('workload_container'),
      kind: z.enum(['pod', 'deployment']),
      name: resourceName,
      container: resourceName,
      collection: z.enum(['containers', 'initContainers']).default('containers'),
      image: imageReference.optional(),
      // Kubernetes accepts `Always` on an init container; `OnFailure` and
      // `Never` are Pod-level values and are rejected on a container.
      restartPolicy: z.literal('Always').optional(),
      command: z.array(z.string().min(1).max(1024)).min(1).max(16).optional(),
      args: z.array(z.string().max(1024)).min(1).max(16).optional(),
      ...common,
    })
    .strict()
    .refine((v) => v.restartPolicy === undefined || v.collection === 'initContainers', {
      message: 'restartPolicy applies to init containers only — a native sidecar sets it, a normal container cannot',
    }),
  deployment_strategy: z
    .object({
      type: z.literal('deployment_strategy'),
      name: resourceName,
      strategy: z.enum(['RollingUpdate', 'Recreate']),
      maxSurge: intOrPercent.optional(),
      maxUnavailable: intOrPercent.optional(),
      ...common,
    })
    .strict()
    .refine((v) => v.strategy === 'RollingUpdate' || (v.maxSurge === undefined && v.maxUnavailable === undefined), {
      message: 'maxSurge and maxUnavailable only apply to the RollingUpdate strategy',
    }),
  workload_annotation: z
    .object({
      type: z.literal('workload_annotation'),
      kind: z.enum(['deployment', 'statefulset', 'daemonset']),
      name: resourceName,
      // Annotation keys may carry a DNS-subdomain prefix, e.g.
      // `deployment.kubernetes.io/revision`, so `/` is permitted here.
      key: z
        .string()
        .min(1)
        .max(253)
        .regex(/^[-._a-zA-Z0-9]+(\/[-._a-zA-Z0-9]+)?$/, 'invalid annotation key'),
      value: z.string().max(1024).optional(),
      min_int: z.number().int().min(0).max(1_000_000).optional(),
      ...common,
    })
    .strict()
    .refine((v) => (v.value !== undefined) !== (v.min_int !== undefined), {
      message: 'must specify exactly one of value or min_int',
    }),
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

  /**
   * Assertions about the environment a *running process* actually has.
   *
   * Why this exists: a lab that teaches "configure the service's environment"
   * could previously only be graded by reading a file the service was supposed
   * to have written — which a student with a shell can simply write by hand.
   * This reads `/proc/<pid>/environ` of the process itself, so the only way to
   * pass is for the service to genuinely be running with that environment.
   *
   * What it deliberately is *not*: a way to read an environment. A lab must
   * name every variable it asks about, and the handler returns a verdict —
   * never a value. See `environForPid` in the verifier's sandbox reader.
   */
  process_environ: z
    .object({
      type: z.literal('process_environ'),
      /** Which process. Matched against the command line, as `process_running`. */
      pattern: processPattern,
      /** How many processes must match. Every match must satisfy `variables`. */
      min_count: z.number().int().min(1).max(MAX_ENVIRON_PROCESSES).default(1),
      variables: z
        .array(environAssertion)
        .min(1)
        .max(20)
        .superRefine((list, ctx) => {
          const seen = new Set<string>();
          for (const entry of list) {
            if (seen.has(entry.name)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `variables contains duplicate entries for '${entry.name}'`,
              });
            }
            seen.add(entry.name);
          }
        }),
      ...common,
    })
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

/** No control characters, matching the rule `envValue` and setup argv already use. */
const noControlCharacters = /^[^\u0000-\u001f\u007f]*$/;

/**
 * An absolute path to one file inside a container.
 *
 * Narrow on purpose. The class excludes whitespace, quotes, `$`, backtick, `;`,
 * `|`, `&`, `\` and every control character — none of which a shell ever sees,
 * because there is no shell on this path, but keeping the class closed means a
 * future refactor that introduced one could not be exploited through lab
 * content that already shipped.
 *
 * The refinements are what make it a *file* reference rather than a traversal:
 * no `..` segment, no empty segment, no trailing slash, and no segment starting
 * with `-` so that combined with the `--` separator in the argv it can never be
 * read as an option.
 */
const containerAbsolutePath = z
  .string()
  .min(2)
  .max(255)
  .regex(/^\/[A-Za-z0-9._/-]*$/, 'must be an absolute path inside the container')
  .refine((p) => !p.split('/').includes('..'), { message: 'must not traverse upwards' })
  .refine((p) => !p.includes('//'), { message: 'must not contain empty segments' })
  .refine((p) => !p.endsWith('/'), { message: 'must name a file, not a directory' })
  .refine((p) => !p.split('/').some((segment) => segment.startsWith('-')), {
    message: 'no path segment may begin with -',
  });

/**
 * One element of an argv a requirement compares against.
 *
 * Compared, never executed: this describes what a container's start command
 * *is*, and no handler ever runs it. Control characters are excluded so a
 * value cannot smuggle a newline into a check's detail.
 */
const argvToken = z
  .string()
  .min(1)
  .max(255)
  .regex(noControlCharacters, 'must not contain control characters');

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
   * The command and entrypoint a container was created with.
   *
   * Read from `Config.Entrypoint` and `Config.Cmd` — what the daemon holds for
   * this container, which is the image's values unless the run overrode them.
   * That is exactly the pair DOCKER-014 teaches: a runtime argument replaces
   * `Cmd` and leaves `Entrypoint` alone, so the two fields together show
   * whether a student built a tool that takes arguments or one that ignores
   * them.
   *
   * Compared as **exact argv arrays**, not membership, because the distinction
   * that matters here is invisible to a looser test. `ENTRYPOINT ["/app/x"]`
   * gives `["/app/x"]`; the shell form `ENTRYPOINT /app/x` gives
   * `["/bin/sh","-c","/app/x"]` and silently discards every runtime argument.
   * Both run, both exit 0, and only the array tells them apart.
   */
  docker_container_command: z
    .object({
      type: z.literal('docker_container_command'),
      name: dockerObjectName,
      command: z.array(argvToken).max(20).optional(),
      entrypoint: z.array(argvToken).max(20).optional(),
      ...common,
    })
    .strict()
    .refine((v) => v.command !== undefined || v.entrypoint !== undefined, {
      message: 'must assert a command, an entrypoint, or both',
    }),

  /**
   * The kernel's OOM killer stopped the container's last run.
   *
   * Read from `State.OOMKilled`, which is the daemon's own report of a cgroup
   * memory-limit kill. This is the **only** field that distinguishes one: a
   * `docker kill`, a `docker stop` that escalates past its grace period, and an
   * application that exits 137 by itself all produce exit code 137 with
   * `OOMKilled` false. A lab that graded exit code 137 alone would accept all
   * four, which is why this exists as its own check rather than as a detail on
   * `docker_container_exit_code`.
   *
   * Per-run, not cumulative: a container that was OOM-killed and then started
   * again reports false for the new run, so a student cannot OOM once and keep
   * the flag.
   *
   * `expected: false` is the form a production lab wants — "this worker must
   * run without being OOM-killed" — so the field is a boolean rather than the
   * check being implicitly positive.
   */
  docker_container_oom_killed: z
    .object({
      type: z.literal('docker_container_oom_killed'),
      name: dockerObjectName,
      expected: z.boolean().default(true),
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

  /**
   * The content of one file inside a container.
   *
   * Read through the daemon's archive endpoint (`docker cp`), never by
   * executing anything in the student's container. That is what lets it grade a
   * **stopped** container — the persistence and data-recovery labs need exactly
   * that — and what stops a student's own image influencing the read by
   * shipping a doctored `cat`.
   *
   * Deliberately one path, one file. There is no listing form, no glob, and no
   * directory form: an archive holding anything other than a single regular
   * file is refused rather than walked, so this cannot become a way to browse a
   * container's filesystem.
   *
   * `equals` is the preferred assertion because it is exact. `contains` exists
   * for the case where a lab legitimately needs several independent tokens in
   * one file, and is a whole-content test either way — never a substitute for
   * comparing the thing the lab actually cares about.
   *
   * **Expected values never leave the server.** They live here, in lab.yaml,
   * and the handler is forbidden from echoing either them or the file's content
   * back into a check's detail — see `dockerContainerFileContent`. A lab that
   * grades an answer would otherwise hand the answer to anyone who submitted a
   * wrong one.
   */
  docker_container_file_content: z
    .object({
      type: z.literal('docker_container_file_content'),
      container: dockerObjectName,
      path: containerAbsolutePath,
      /** Exact match, after trimming one trailing newline from each side. */
      equals: z.string().max(4096).regex(noControlCharacters, 'must not contain control characters').optional(),
      /** Every entry must appear somewhere in the file. */
      contains: z
        .array(z.string().min(1).max(256).regex(noControlCharacters, 'must not contain control characters'))
        .min(1)
        .max(5)
        .optional(),
      /** The path must be readable, whatever it holds. */
      exists: z.literal(true).optional(),
      /** The path must not be there at all. */
      absent: z.literal(true).optional(),
      ...common,
    })
    .strict()
    .refine(
      (v) =>
        [v.equals, v.contains, v.exists, v.absent].filter((x) => x !== undefined).length === 1,
      { message: 'must assert exactly one of equals, contains, exists, or absent' },
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
      /**
       * `ENTRYPOINT` and `CMD` as exact argv arrays, separately.
       *
       * `cmd_contains` deliberately merges the two and tests membership, which
       * is right for "does this image start the thing it should". It cannot
       * show which half a value came from, or tell exec form from shell form —
       * so a lab teaching the difference asserts these instead.
       */
      entrypoint: z.array(argvToken).max(20).optional(),
      cmd: z.array(argvToken).max(20).optional(),
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
        v.entrypoint !== undefined ||
        v.cmd !== undefined ||
        v.env !== undefined ||
        v.exposed_port !== undefined ||
        v.labels !== undefined,
      { message: 'must assert at least one image configuration field' },
    ),

  /**
   * Two images share a run of leading filesystem layers.
   *
   * Docker's build cache is not observable from one image. It is a property of
   * a *rebuild*: when an instruction and its inputs are unchanged, the daemon
   * reuses the layer it produced last time, and the two images then carry the
   * same digest for it. Comparing the ordered `RootFS.Layers` of a before and
   * an after image is therefore the only way to prove cache reuse from state
   * rather than from build output the student could have written themselves.
   *
   * **Prefix means prefix.** `[A,B,C,D]` and `[A,B,C,E]` share three; `[A,B,C]`
   * and `[A,X,B,C]` share one, because the run stops at the first difference.
   * Order matters, and the digests come from the daemon.
   *
   * `maximum_changed_suffix` is the constraint to reach for. It says "only the
   * last N layers may differ", which is exactly the property a cache-friendly
   * Dockerfile has and is **independent of how many layers the image has in
   * total** — so a lab does not have to guess a number that changes whenever a
   * student adds an instruction. `minimum_shared_prefix` is available for the
   * cases where an absolute floor is genuinely what is meant.
   *
   * `must_differ` exists because two *identical* images share every layer and
   * would otherwise satisfy any prefix constraint. A rebuild that changed
   * nothing proves nothing.
   */
  docker_image_layers: z
    .object({
      type: z.literal('docker_image_layers'),
      /** The image built after the change. */
      image: imageReference,
      /** The image built before it. */
      shares_prefix_with: imageReference,
      /** At least this many leading layers must be identical, in order. */
      minimum_shared_prefix: z.number().int().min(1).max(200).optional(),
      /** At most this many trailing layers may differ. */
      maximum_changed_suffix: z.number().int().min(0).max(200).optional(),
      /** The two images must not be the same image. */
      must_differ: z.boolean().default(true),
      ...common,
    })
    .strict()
    .refine(
      (v) => v.minimum_shared_prefix !== undefined || v.maximum_changed_suffix !== undefined,
      { message: 'must constrain the shared prefix, the changed suffix, or both' },
    )
    .refine((v) => v.image !== v.shares_prefix_with, {
      message: 'an image cannot be compared against itself',
    }),

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
/**
 * Every family, and the reader that answers it.
 *
 * One table rather than a hand-written union plus a hand-written
 * `RequirementTypeOf<'filesystem' | 'terraform' | 'linux'>`. A family is not
 * free-floating: it exists to name *which reader* observes it, so the family
 * vocabulary and the routing are the same fact and are written once. A
 * curriculum track that brings a new family — an AWS policy document, a
 * cloud template — adds one line here, and `RequirementFamily`, the
 * `SandboxRequirementType` alias, the provider capability table and the
 * verifier's dispatch all follow.
 *
 * Exhaustive by construction: `RequirementFamily` is `keyof` this table, so a
 * family that is not routed is not a family at all and cannot be named in
 * `REQUIREMENT_FAMILIES` below. The failure this prevents is quiet — a new
 * family added to a union alone would compile and then be swept into the
 * verifier's sandbox `else` branch whether or not the sandbox is the right
 * substrate.
 */
export const REQUIREMENT_FAMILY_READERS = {
  kubernetes: 'kubernetes',
  filesystem: 'sandbox',
  terraform: 'sandbox',
  linux: 'sandbox',
  docker: 'docker',
} as const;

export type RequirementFamily = keyof typeof REQUIREMENT_FAMILY_READERS;

/** The three substrates a check can be observed against. */
export type ReaderGroup = (typeof REQUIREMENT_FAMILY_READERS)[RequirementFamily];

type FamiliesFor<G extends ReaderGroup> = {
  [F in RequirementFamily]: (typeof REQUIREMENT_FAMILY_READERS)[F] extends G ? F : never;
}[RequirementFamily];

export type KubernetesFamily = FamiliesFor<'kubernetes'>;
export type SandboxFamily = FamiliesFor<'sandbox'>;
export type DockerFamily = FamiliesFor<'docker'>;

/** Every family, in declaration order. */
export const REQUIREMENT_FAMILY_LIST = Object.keys(
  REQUIREMENT_FAMILY_READERS,
) as ReadonlyArray<RequirementFamily>;

/** Which reader observes this family. */
export function familyReader(family: RequirementFamily): ReaderGroup {
  return REQUIREMENT_FAMILY_READERS[family];
}

export function isKubernetesFamily(family: RequirementFamily): family is KubernetesFamily {
  return REQUIREMENT_FAMILY_READERS[family] === 'kubernetes';
}

export function isSandboxFamily(family: RequirementFamily): family is SandboxFamily {
  return REQUIREMENT_FAMILY_READERS[family] === 'sandbox';
}

export function isDockerFamily(family: RequirementFamily): family is DockerFamily {
  return REQUIREMENT_FAMILY_READERS[family] === 'docker';
}

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
  service_headless: 'kubernetes',
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

  workload_annotation: 'kubernetes',
  deployment_strategy: 'kubernetes',
  workload_container: 'kubernetes',
  workload_volume_mount: 'kubernetes',

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
  process_environ: 'linux',
  process_not_running: 'linux',
  port_listening: 'linux',
  port_not_listening: 'linux',
  user_exists: 'linux',
  group_exists: 'linux',
  user_in_group: 'linux',
  script_runs: 'linux',
  command_exit_code: 'linux',
  command_output: 'linux',

  // --- Docker: one session's own daemon --------------------------------
  docker_container_exists: 'docker',
  docker_container_running: 'docker',
  docker_container_state: 'docker',
  docker_container_image: 'docker',
  docker_container_exit_code: 'docker',
  docker_container_oom_killed: 'docker',
  docker_container_command: 'docker',
  docker_container_file_content: 'docker',
  docker_container_env: 'docker',
  docker_container_port: 'docker',
  docker_container_network: 'docker',
  docker_container_mount: 'docker',
  docker_container_resource_limit: 'docker',

  docker_image_exists: 'docker',
  docker_image_config: 'docker',
  docker_image_layers: 'docker',
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
export type SandboxRequirementType = RequirementTypeOf<SandboxFamily>;

export type KubernetesRequirementType = RequirementTypeOf<KubernetesFamily>;

/** Sandbox checks that additionally need an allow-listed inspection command. */
export type LinuxRequirementType = RequirementTypeOf<'linux'>;

export const LINUX_REQUIREMENT_TYPES = requirementTypesForFamily('linux') as LinuxRequirementType[];

export function requirementTypesForFamily(family: RequirementFamily): RequirementType[] {
  return REQUIREMENT_TYPES.filter((type) => REQUIREMENT_FAMILIES[type] === family);
}

/** Requirement types verified by reading a session's own Docker daemon. */
export type DockerRequirementType = RequirementTypeOf<DockerFamily>;

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
  return isSupportedRequirementType(value) && isDockerFamily(requirementFamily(value));
}

export function isKubernetesRequirementType(value: unknown): value is KubernetesRequirementType {
  return isSupportedRequirementType(value) && isKubernetesFamily(requirementFamily(value));
}

/** Requirement types read inside the session's own sandbox container. */
export function isSandboxRequirementType(value: unknown): value is SandboxRequirementType {
  return isSupportedRequirementType(value) && isSandboxFamily(requirementFamily(value));
}

/** True when any requirement in a batch needs the Docker engine reader. */
export function requirementsNeedDocker(requirements: readonly { type: string }[]): boolean {
  return requirements.some((r) => isDockerRequirementType(r.type));
}

/** True when any requirement in a batch needs the Kubernetes API reader. */
export function requirementsNeedKubernetes(requirements: readonly { type: string }[]): boolean {
  return requirements.some((r) => isKubernetesRequirementType(r.type));
}

/** True when any requirement in a batch needs the sandbox filesystem reader. */
export function requirementsNeedSandbox(requirements: readonly { type: string }[]): boolean {
  return requirements.some((r) => isSandboxRequirementType(r.type));
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
