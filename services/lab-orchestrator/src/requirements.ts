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
import { isAllowedManagedPath, isSafeWorkspacePath } from './ansible/paths.js';
import { WORKSPACE_TASK_IDS, type WorkspaceTaskId } from './cicd/tasks.js';
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
/** A provider resource or data-source type, e.g. `local_file`. */
const terraformTypeName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_]*$/, 'must be a Terraform type such as local_file');

/** A block label or identifier, e.g. `service_config`, `channel`. */
const terraformLabel = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/, 'must be a Terraform identifier');

/**
 * The object a reference points at, without an attribute.
 *
 * Deliberately a closed shape rather than free text: it is parsed into parts
 * and compared field by field, so nothing a lab writes ever becomes a pattern.
 */
const terraformReferenceTarget = z
  .string()
  .min(3)
  .max(200)
  .regex(
    /^(var\.[a-zA-Z_][a-zA-Z0-9_-]*|local\.[a-zA-Z_][a-zA-Z0-9_-]*|module\.[a-zA-Z_][a-zA-Z0-9_-]*|data\.[a-z][a-z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_-]*|[a-z][a-z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_-]*)$/,
    'must be a Terraform address such as local_file.config, var.channel or data.local_file.seed',
  );

/** A dotted attribute path on a referenced object, e.g. `content_sha256`. */
const terraformAttributePath = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z_][a-zA-Z0-9_.-]*$/, 'must be an attribute path');

const common = {
  label: z.string().min(1).max(160).optional(),
};

/** `Allow` or `Deny`, as an IAM policy writes them. */
const iamEffect = z.enum(['Allow', 'Deny']);

/** An IAM action, e.g. `s3:GetObject`, `s3:Get*`, `*`. */
const iamAction = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9*?:_-]+$/, 'must be an IAM action such as s3:GetObject');

/** An ARN or ARN pattern, e.g. `arn:aws:s3:::bucket/*`. */
const iamResource = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[^\s"]+$/, 'must be an ARN or ARN pattern with no whitespace');

/**
 * One principal a statement's `Principal` (or `NotPrincipal`) must name.
 *
 * Exact, never a pattern: AWS documents that a wildcard cannot match part of a
 * principal name or ARN. `type` uses the documented spelling.
 */
const iamPrincipalSelector = z
  .object({
    type: z.enum(['AWS', 'Service', 'Federated', 'CanonicalUser']),
    /** e.g. `ec2.amazonaws.com`, `arn:aws:iam::123456789012:role/deployer`. */
    id: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[^\s"]+$/, 'must be a principal id or ARN with no whitespace'),
  })
  .strict();

/** A CloudFormation logical ID: alphanumeric, as the template reference defines. */
const cfnLogicalId = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9]+$/, 'must be an alphanumeric CloudFormation logical ID');

/** A resource type such as `AWS::S3::Bucket`. */
const cfnResourceType = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9]+::[A-Za-z0-9]+::[A-Za-z0-9]+$/, 'must look like AWS::S3::Bucket');

/** A dotted property path, where a numeric segment indexes a list. */
/** An IPv4 netmask length. */
const cidrPrefixLength = z.number().int().min(0).max(32);

const cfnPropertyPath = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, 'must be a dotted property path such as Tags.0.Key');

/** One condition a statement must carry. */
const iamConditionSelector = z
  .object({
    /** e.g. `StringEquals`, `Bool`, `IpAddress`. */
    operator: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9:]+$/, 'must be an IAM condition operator such as StringEquals'),
    /** e.g. `aws:SourceIp`. */
    key: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9:._/-]+$/, 'must be an IAM condition key such as aws:SourceIp'),
    /** When omitted, only the operator and key must be present. */
    value: z.string().min(1).max(1024).optional(),
  })
  .strict();

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

/**
 * Binaries the *verifier* may run that a lab may never name.
 *
 * `VERIFIER_COMMANDS` above is lab-facing: a lab picks one and supplies argv.
 * This list is the opposite arrangement — trusted verifier code owns both the
 * executable and the whole argv, and a lab contributes only strictly validated
 * operands that the handler places itself.
 *
 * `ip` is here rather than in the list above for exactly that reason. It is not
 * read-only as a binary: `ip neigh add`, `ip link set`, `ip route del` all
 * mutate. Exposing it to `command_output` would hand every lab author a way to
 * change the sandbox's networking from a YAML file. `neighbour_state` runs the
 * single form `ip -json neigh show`, which is a read, and nothing else can ask
 * for `ip` at all.
 */
export const VERIFIER_INTERNAL_COMMANDS = ['ip'] as const;

export type VerifierInternalCommand = (typeof VERIFIER_INTERNAL_COMMANDS)[number];

/**
 * The states the Linux neighbour table can hold, as `ip -json neigh show`
 * reports them.
 *
 * These are the kernel's NUD ("neighbour unreachability detection") states.
 * They matter to a lab because they are not interchangeable: a resolved entry
 * is `REACHABLE` only while the kernel has recent confirmation, and ages to
 * `STALE` on its own without anything being wrong. A lab that demanded
 * `REACHABLE` would therefore fail a correct student who paused; one that
 * accepts the set `[REACHABLE, STALE]` grades what it means to grade. At the
 * other end, `INCOMPLETE` and `FAILED` are the states of a neighbour that never
 * answered — which is a legitimate thing for a lab to require a student to
 * produce.
 */
export const NEIGHBOUR_STATES = [
  'PERMANENT',
  'NOARP',
  'REACHABLE',
  'STALE',
  'NONE',
  'INCOMPLETE',
  'DELAY',
  'PROBE',
  'FAILED',
] as const;

export type NeighbourState = (typeof NEIGHBOUR_STATES)[number];

/**
 * An IP address a lab may ask about.
 *
 * Deliberately a literal address and never a hostname or a range: the operand
 * reaches an argv, and the narrower the shape the less there is to reason
 * about. The character sets here cannot express a shell metacharacter, a path
 * separator, or an option.
 */
const ipAddress = z
  .string()
  .min(2)
  .max(45)
  .refine(
    (value) =>
      /^(\d{1,3}\.){3}\d{1,3}$/.test(value)
        ? value.split('.').every((octet) => Number(octet) <= 255)
        : /^[0-9a-fA-F:]+$/.test(value) && value.includes(':'),
    { message: 'must be an IPv4 or IPv6 literal address' },
  );

/**
 * A local address a socket may be bound to.
 *
 * Accepts the forms a lab author would reasonably write: an IPv4 literal, an
 * IPv6 literal with or without brackets, and the two wildcards — `0.0.0.0` for
 * IPv4 and `::` for IPv6. `*` is accepted too, because that is how `ss` prints
 * the IPv6 any-address socket on Linux, and an author reading their own
 * terminal should be able to write down what they saw.
 *
 * Normalisation happens at comparison time, in one place, so the value a lab
 * writes and the value the kernel reports cannot drift apart.
 */
const bindAddress = z
  .string()
  .min(1)
  .max(47)
  .regex(
    /^(\*|\[?[0-9a-fA-F:]+\]?|(\d{1,3}\.){3}\d{1,3})$/,
    'must be an IPv4 or IPv6 address, or a wildcard (0.0.0.0, ::, *)',
  );

/** A network interface name, as the kernel allows one. */
const interfaceName = z
  .string()
  .min(1)
  .max(15)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be a network interface name such as eth0');

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
    .object({
      type: z.literal('file_exists'),
      path: sandboxPath,
      /**
       * A size floor, for a file the student was asked to *write* rather than
       * merely create. `touch ci.yml` satisfies "exists" and teaches nothing;
       * a lab that wants a real workflow file says so here.
       */
      min_bytes: z.number().int().min(1).max(1_048_576).optional(),
      ...common,
    })
    .strict(),

  /**
   * The file parses as YAML.
   *
   * The most common first failure in every track that has students author a
   * YAML document — an Ansible playbook, a GitHub Actions workflow — which is
   * why it lives with the other path reads rather than in either track's own
   * family. Any provider with a sandbox filesystem can answer it.
   */
  yaml_valid: z.object({ type: z.literal('yaml_valid'), path: sandboxPath, ...common }).strict(),

  /**
   * Several fragments must appear in one file, and/or several must not.
   *
   * `file_content` takes one `contains` and answers "does this string occur".
   * A pipeline script or a Dockerfile is graded on *several* things at once —
   * a base image, a workdir, a copy, a start command — and expressing that as
   * four separate checks would report four failures for one missing line.
   * Substrings, never regular expressions.
   */
  file_contains: z
    .object({
      type: z.literal('file_contains'),
      path: sandboxPath,
      contains: z.array(z.string().min(1).max(120)).max(10).default([]),
      absent: z.array(z.string().min(1).max(120)).max(10).default([]),
      ...common,
    })
    .strict()
    .refine((v) => v.contains.length > 0 || v.absent.length > 0, {
      message: 'must specify contains, absent, or both',
    }),

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
      /**
       * Where state lives inside `dir`. Defaults to `terraform.tfstate`.
       *
       * Symmetrical with `terraform_state_absent`, and for the same reason: a
       * lab may need to assert what a *previous* state held — the backup a
       * destroy wrote, or a workspace's own state — not only what the current
       * one holds.
       */
      state_file: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9._-]+$/, 'state_file must be a plain file name, not a path')
        .optional(),
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

  /**
   * Terraform state holds no managed object at an address — or none at all.
   *
   * This is the check a `terraform destroy` lab is graded on, and it is
   * deliberately **not** "terraform.tfstate does not exist". A completed
   * destroy leaves a perfectly valid state file behind, with `resources: []`
   * and its serial incremented; deleting the file is a different act with a
   * different meaning, and one a student could perform with `rm`. So a missing
   * state file fails this check rather than passing it.
   *
   * `address` selects between the two shapes:
   *
   *   · **given** — that one managed address must hold no instance. Used by
   *     targeted-destroy, `state rm` and refactoring labs.
   *   · **omitted** — the state must hold no managed instances at all. Used by
   *     a full-destroy lab.
   *
   * Only `mode: "managed"` is counted. Data sources are readings of things
   * Terraform does not own, and `terraform destroy` clears them as a side
   * effect of dropping what depends on them; a state holding only data sources
   * manages no infrastructure and passes.
   *
   * Every instance in `instances[]` counts, whatever its status — a *deposed*
   * object is a real object that a failed replacement left behind, and a lab
   * that called such a state "destroyed" would be teaching the opposite of the
   * lesson.
   */
  // =========================================================================
  // Terraform configuration (static, semantic)
  // =========================================================================
  //
  // These read the student's `.tf` files instead of state, because some things
  // a Terraform course teaches leave no trace in an applied result: whether a
  // variable was declared or a value hardcoded, whether a dependency came from
  // a reference or a pasted string, whether a validation rule exists at all.
  //
  // Read is all they do. The scanner behind them evaluates nothing, calls no
  // function, resolves no variable and reaches nothing outside the text it was
  // given — see `terraform/hcl.ts` and `terraform/references.ts`. There is no
  // path from a lab definition to running a student's configuration.

  /**
   * A resource attribute *refers to* another Terraform object.
   *
   * The check a dependency lab needs, and the one state cannot answer.
   * `content = "sha: ${local_file.config.content_sha256}"` creates an edge in
   * Terraform's graph; `content = "sha: d0e6aa15…"` does not, and the two
   * produce identical state. Only the configuration distinguishes them.
   *
   * A literal that merely looks like an address never counts — the reference
   * has to be live, meaning bare or inside `${…}` interpolation.
   */
  terraform_resource_references: z
    .object({
      type: z.literal('terraform_resource_references'),
      dir: sandboxPath,
      resource_type: terraformTypeName,
      name: terraformLabel,
      /** Which argument must carry the reference, e.g. `content`. */
      attribute: terraformLabel,
      /**
       * The object that must be referred to: `local_file.config`,
       * `var.channel`, `local.service`, `data.local_file.seed`, `module.app`.
       */
      references: terraformReferenceTarget,
      /** Require the reference to reach a particular attribute of that object. */
      referenced_attribute: terraformAttributePath.optional(),
      ...common,
    })
    .strict(),

  /** A `variable "name"` block is declared, optionally with a shape. */
  terraform_variable_declared: z
    .object({
      type: z.literal('terraform_variable_declared'),
      dir: sandboxPath,
      name: terraformLabel,
      /** Require the variable to declare (or deliberately omit) a default. */
      has_default: z.boolean().optional(),
      /** Require a `type` argument to be present — teaches typed variables. */
      has_type: z.boolean().optional(),
      /**
       * A substring the declared type expression must contain, e.g.
       * `map(object(`. A substring rather than an exact match because a complex
       * type is written across several lines with the author's own spacing, and
       * a lab teaching a map of objects cares that the student reached for one,
       * not that they laid it out a particular way. Compared against the type
       * expression's source with whitespace collapsed; nothing is evaluated.
       */
      type_contains: z.string().min(1).max(200).optional(),
      ...common,
    })
    .strict(),

  /** Names that must be defined in a `locals` block. */
  terraform_locals_declared: z
    .object({
      type: z.literal('terraform_locals_declared'),
      dir: sandboxPath,
      names: z.array(terraformLabel).min(1).max(20),
      ...common,
    })
    .strict(),

  /** A `data "type" "name"` block is declared. */
  terraform_data_source_declared: z
    .object({
      type: z.literal('terraform_data_source_declared'),
      dir: sandboxPath,
      data_type: terraformTypeName,
      name: terraformLabel,
      ...common,
    })
    .strict(),

  /**
   * A resource declares `depends_on`, naming given addresses.
   *
   * Configuration, not state: an explicit dependency exists precisely because
   * no attribute reference implies it, so it leaves no trace in the applied
   * result. That is also what distinguishes it from
   * `terraform_resource_references`.
   */
  terraform_resource_depends_on: z
    .object({
      type: z.literal('terraform_resource_depends_on'),
      dir: sandboxPath,
      resource_type: terraformTypeName,
      name: terraformLabel,
      /** Addresses the list must mention, e.g. `null_resource.database`. */
      references: z.array(terraformReferenceTarget).min(1).max(10),
      ...common,
    })
    .strict(),

  /** A variable declares at least one `validation` block. */
  terraform_variable_validation: z
    .object({
      type: z.literal('terraform_variable_validation'),
      dir: sandboxPath,
      name: terraformLabel,
      /** Minimum number of `validation` blocks. Defaults to 1. */
      min_rules: z.number().int().min(1).max(10).default(1),
      /** Identifiers or function names the conditions must between them mention. */
      condition_mentions: z.array(terraformLabel).min(1).max(10).optional(),
      ...common,
    })
    .strict(),

  /**
   * A resource or data source declares a custom condition.
   *
   * `precondition` and `postcondition` live inside a `lifecycle` block, and are
   * looked for there.
   */
  terraform_resource_condition: z
    .object({
      type: z.literal('terraform_resource_condition'),
      dir: sandboxPath,
      resource_type: terraformTypeName,
      name: terraformLabel,
      mode: z.enum(['managed', 'data']).default('managed'),
      condition: z.enum(['precondition', 'postcondition']),
      /** Identifiers or function names the condition must mention. */
      condition_mentions: z.array(terraformLabel).min(1).max(10).optional(),
      ...common,
    })
    .strict(),

  /** A `check "name"` block with at least one `assert`. */
  terraform_check_declared: z
    .object({
      type: z.literal('terraform_check_declared'),
      dir: sandboxPath,
      name: terraformLabel,
      /** Minimum number of `assert` blocks. Defaults to 1. */
      min_assertions: z.number().int().min(1).max(10).default(1),
      ...common,
    })
    .strict(),

  terraform_state_absent: z
    .object({
      type: z.literal('terraform_state_absent'),
      dir: sandboxPath,
      /** Where state lives inside `dir`. Defaults to `terraform.tfstate`. */
      state_file: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9._-]+$/, 'state_file must be a plain file name, not a path')
        .optional(),
      /**
       * A managed resource address, e.g. `local_file.report`. Omit to require
       * that no managed resource remains anywhere in the state.
       *
       * Deliberately not free text: it is parsed into type and name and
       * compared field by field, so nothing here ever becomes a pattern.
       */
      address: z
        .string()
        .min(3)
        .max(257)
        .regex(
          /^[a-z][a-z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_-]*$/,
          'address must be a managed resource address such as local_file.report',
        )
        .optional(),
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

  // --- IAM policy documents ------------------------------------------------
  //
  // These grade an IAM policy the student wrote, by *parsing* it. No check here
  // matches text: the document is read into a normalised model, so key order,
  // whitespace, `Action` as a string versus an array, and statement order are
  // all irrelevant to the verdict — as they are to AWS.
  //
  // The reader is the sandbox filesystem, exactly as for Terraform state: the
  // policy is an artefact on disk, and reading it needs no cloud account.

  /** The file at `path` parses as a well-formed IAM policy document. */
  iam_policy_document: z
    .object({
      type: z.literal('iam_policy_document'),
      path: sandboxPath,
      /** Optional exact `Version`, e.g. `2012-10-17`. */
      version: z.string().min(1).max(32).optional(),
      /** Optional exact number of statements the document must contain. */
      statement_count: z.number().int().min(1).max(50).optional(),
      ...common,
    })
    .strict(),

  /**
   * At least one statement satisfies every part of the selector.
   *
   * A statement "covers" an action or resource when one of its patterns matches
   * it, with IAM's `*` and `?` wildcards — so `s3:Get*` covers `s3:GetObject`.
   */
  iam_policy_statement: z
    .object({
      type: z.literal('iam_policy_statement'),
      path: sandboxPath,
      effect: iamEffect.optional(),
      sid: z.string().min(1).max(128).optional(),
      /** The statement must cover every action listed. */
      actions: z.array(iamAction).min(1).max(50).optional(),
      /** The statement must cover every resource listed. */
      resources: z.array(iamResource).min(1).max(50).optional(),
      condition: iamConditionSelector.optional(),
      /** Every principal listed must appear in the statement's `Principal`. */
      principals: z.array(iamPrincipalSelector).min(1).max(20).optional(),
      /** Every principal listed must appear in the statement's `NotPrincipal`. */
      not_principals: z.array(iamPrincipalSelector).min(1).max(20).optional(),
      ...common,
    })
    .strict(),

  /**
   * The policy as a whole permits this action on this resource.
   *
   * Evaluated the way AWS documents a single identity policy: an explicit Deny
   * wins, otherwise a matching Allow grants.
   */
  iam_policy_allows: z
    .object({
      type: z.literal('iam_policy_allows'),
      path: sandboxPath,
      action: iamAction,
      resource: iamResource,
      ...common,
    })
    .strict(),

  /** The policy does **not** permit this action on this resource. */
  iam_policy_not_allows: z
    .object({
      type: z.literal('iam_policy_not_allows'),
      path: sandboxPath,
      action: iamAction,
      resource: iamResource,
      ...common,
    })
    .strict(),

  /**
   * No statement uses the bare `*` wildcard in the named field.
   *
   * The least-privilege check: `"Action": "*"` or `"Resource": "*"` is what a
   * policy review flags first, and a lab that asks for least privilege has to
   * be able to say so. `Principal` is the trust-policy equivalent — a role that
   * trusts `"*"` can be assumed by anyone.
   */
  iam_policy_no_wildcard: z
    .object({
      type: z.literal('iam_policy_no_wildcard'),
      path: sandboxPath,
      field: z.enum(['Action', 'Resource', 'Principal']),
      /** Restrict the check to statements of one effect. */
      effect: iamEffect.optional(),
      ...common,
    })
    .strict(),

  // --- CloudFormation templates ---------------------------------------------
  //
  // These grade a template the student wrote or repaired, by *parsing* it. The
  // YAML short forms are normalised to their canonical `Fn::` shape at parse
  // time, so a YAML template and the equivalent JSON template are the same
  // object, and resource order, property order and formatting are all
  // irrelevant to the verdict — as they are to CloudFormation.
  //
  // The reader is the sandbox filesystem, as for Terraform state and IAM
  // policies: a template is an artefact on disk, and reading it needs no cloud
  // account and deploys nothing.

  /** The file at `path` parses as a well-formed CloudFormation template. */
  cfn_template_valid: z
    .object({
      type: z.literal('cfn_template_valid'),
      path: sandboxPath,
      /** Optional exact `AWSTemplateFormatVersion`, e.g. `2010-09-09`. */
      format_version: z.string().min(1).max(32).optional(),
      /** Optional floor on how many resources the template must declare. */
      min_resources: z.number().int().min(1).max(200).optional(),
      ...common,
    })
    .strict(),

  /** A resource with this logical ID exists, and has this type. */
  cfn_resource_exists: z
    .object({
      type: z.literal('cfn_resource_exists'),
      path: sandboxPath,
      logical_id: cfnLogicalId,
      resource_type: cfnResourceType,
      ...common,
    })
    .strict(),

  /**
   * A resource carries a property, optionally with an exact value.
   *
   * A one-element list is compared as the scalar it wraps, because
   * `Action: sts:AssumeRole` and `Action: [sts:AssumeRole]` mean the same.
   */
  cfn_resource_property: z
    .object({
      type: z.literal('cfn_resource_property'),
      path: sandboxPath,
      logical_id: cfnLogicalId,
      property: cfnPropertyPath,
      /** When omitted, the property need only be present. */
      equals: z.string().min(1).max(1024).optional(),
      ...common,
    })
    .strict(),

  /**
   * One resource's property refers to another resource.
   *
   * `via` names the intrinsic the reference must be made with, so a lab can
   * require `Fn::GetAtt` where an ARN is needed and `Ref` where an id is.
   */
  cfn_resource_reference: z
    .object({
      type: z.literal('cfn_resource_reference'),
      path: sandboxPath,
      logical_id: cfnLogicalId,
      property: cfnPropertyPath,
      /** Logical ID the property must point at. */
      references: cfnLogicalId,
      via: z.enum(['Ref', 'GetAtt', 'Sub']),
      /** Required attribute for a `GetAtt`, e.g. `Arn`. */
      attribute: z.string().min(1).max(128).regex(/^[A-Za-z0-9.]+$/).optional(),
      ...common,
    })
    .strict(),

  /**
   * Every `Ref`, `Fn::GetAtt` and `Fn::Sub` variable resolves.
   *
   * The check a failed deployment usually needed: a typo in a logical ID, or a
   * `Sub` variable naming a parameter nobody declared.
   */
  cfn_references_resolve: z
    .object({ type: z.literal('cfn_references_resolve'), path: sandboxPath, ...common })
    .strict(),

  /** An output exists, optionally pointing at a named resource. */
  cfn_output_exists: z
    .object({
      type: z.literal('cfn_output_exists'),
      path: sandboxPath,
      name: cfnLogicalId,
      /** Logical ID the output's `Value` must reference. */
      references: cfnLogicalId.optional(),
      ...common,
    })
    .strict(),

  // ------------------------------------------------------------------ CIDR
  //
  // Network *design* checks. These grade the addressing a template lays out,
  // not the text it lays it out in, so any plan that satisfies the stated
  // constraints passes and no particular set of ranges is privileged.
  //
  // The AWS bounds they express are documented: a VPC or subnet IPv4 block
  // lies between a /16 and a /28 netmask, and AWS reserves five addresses in
  // every subnet. See Amazon VPC User Guide, "VPC CIDR blocks" and "Subnet
  // CIDR blocks".

  /** A property parses as an IPv4 CIDR block, within optional bounds. */
  cfn_cidr_valid: z
    .object({
      type: z.literal('cfn_cidr_valid'),
      path: sandboxPath,
      logical_id: cfnLogicalId,
      property: cfnPropertyPath,
      /** Inclusive netmask bounds. `prefix_min: 16` forbids anything wider. */
      prefix_min: cidrPrefixLength.optional(),
      prefix_max: cidrPrefixLength.optional(),
      /** Floor on addresses the block holds, reserved ones included. */
      min_addresses: z.number().int().min(1).max(4_294_967_296).optional(),
      /** Floor on *assignable* addresses: five fewer than the block holds. */
      min_usable: z.number().int().min(1).max(4_294_967_296).optional(),
      /** Require the block to sit inside an RFC 1918 private range. */
      rfc1918: z.boolean().optional(),
      ...common,
    })
    .strict()
    .refine((v) => v.prefix_min === undefined || v.prefix_max === undefined || v.prefix_min <= v.prefix_max, {
      message: 'prefix_min must not exceed prefix_max',
    }),

  /** Every listed resource's CIDR lies wholly inside another resource's. */
  cfn_cidr_within: z
    .object({
      type: z.literal('cfn_cidr_within'),
      path: sandboxPath,
      /** The containing resource, e.g. the VPC. */
      parent: cfnLogicalId,
      parent_property: cfnPropertyPath,
      /** The contained resources, e.g. the subnets. */
      logical_ids: z.array(cfnLogicalId).min(1).max(64),
      property: cfnPropertyPath,
      ...common,
    })
    .strict(),

  /** No two of the listed resources' CIDRs share an address. */
  cfn_cidr_disjoint: z
    .object({
      type: z.literal('cfn_cidr_disjoint'),
      path: sandboxPath,
      logical_ids: z.array(cfnLogicalId).min(2).max(64),
      property: cfnPropertyPath,
      ...common,
    })
    .strict(),

  /**
   * The listed resources leave room inside the parent for later growth.
   *
   * A VPC's CIDR cannot be resized after creation, so how much of it a first
   * design consumes is a decision the student has to make on purpose.
   */
  cfn_cidr_free_space: z
    .object({
      type: z.literal('cfn_cidr_free_space'),
      path: sandboxPath,
      parent: cfnLogicalId,
      parent_property: cfnPropertyPath,
      logical_ids: z.array(cfnLogicalId).min(1).max(64),
      property: cfnPropertyPath,
      /** Share of the parent that must remain unallocated, 1-99. */
      min_free_percent: z.number().int().min(1).max(99),
      ...common,
    })
    .strict(),

  /**
   * How many different values the listed resources hold for a property.
   *
   * Bounded from either side, which is what lets a lab state both halves of a
   * multi-AZ layout: subnets of one tier must be spread (`min_distinct`), and
   * the two tiers of one zone must sit together (`max_distinct`). Setting both
   * pins the count exactly. Nothing here is CIDR- or AZ-specific.
   */
  cfn_property_distinct: z
    .object({
      type: z.literal('cfn_property_distinct'),
      path: sandboxPath,
      logical_ids: z.array(cfnLogicalId).min(2).max(64),
      property: cfnPropertyPath,
      /** Floor on the number of different values across the set. */
      min_distinct: z.number().int().min(1).max(64).optional(),
      /** Ceiling on the number of different values across the set. */
      max_distinct: z.number().int().min(1).max(64).optional(),
      ...common,
    })
    .strict()
    .refine((v) => v.min_distinct !== undefined || v.max_distinct !== undefined, {
      message: 'must specify min_distinct, max_distinct, or both',
    })
    .refine((v) => v.min_distinct === undefined || v.max_distinct === undefined || v.min_distinct <= v.max_distinct, {
      message: 'min_distinct must not exceed max_distinct',
    }),

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
      /**
       * The local address the socket must be bound to.
       *
       * Omitted, the check means what it has always meant: *something* is
       * listening on this port, wherever it is bound. Naming an address makes
       * the check the stricter question a networking lab needs — the
       * difference between a service on `127.0.0.1` that only its own host can
       * reach and one on `0.0.0.0` that the network can.
       *
       * A list accepts any one of several bindings, which is how a lab says
       * "reachable off this host" without dictating an address family: an IPv4
       * wildcard and an IPv6 wildcard are different bindings that both satisfy
       * that sentence.
       */
      address: z.union([bindAddress, z.array(bindAddress).min(1).max(6)]).optional(),
      ...common,
    })
    .strict(),

  port_not_listening: z
    .object({
      type: z.literal('port_not_listening'),
      port: z.number().int().min(1).max(65535),
      protocol: z.enum(['tcp', 'udp']).default('tcp'),
      /**
       * Restrict the absence to one binding.
       *
       * Omitted, the check means nothing at all is listening on the port.
       * Naming an address asserts the narrower thing — that nothing is bound
       * *there* — which is what a lab needs when a service is supposed to have
       * moved off loopback rather than gone away.
       */
      address: z.union([bindAddress, z.array(bindAddress).min(1).max(6)]).optional(),
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

  /**
   * One entry in the kernel's neighbour table.
   *
   * The check a networking lab needs and no file read can answer: did this host
   * actually resolve that neighbour, and what did the kernel conclude?
   *
   * Graded from `ip -json neigh show` inside the session's own sandbox — the
   * kernel's own answer, per network namespace. It cannot be satisfied by
   * writing a file, echoing the expected output, or editing shell history,
   * because none of those put an entry in a neighbour table. Nor can a student
   * forge one: `ip neigh add` needs CAP_NET_ADMIN, which no sandbox grants.
   *
   * `state` is a *set*, because more than one state is often correct — see
   * `NEIGHBOUR_STATES`. `absent: true` asserts the opposite: that no entry
   * exists at all, which is what an off-subnet destination with no route
   * produces, and is a distinct lesson from a neighbour that failed to answer.
   */
  neighbour_state: z
    .object({
      type: z.literal('neighbour_state'),
      /**
       * The neighbour to look for. Optional, because the address often cannot
       * be known when the lab is written: a session's bridge is allocated by
       * the daemon, so its gateway is not a constant a lab author could name.
       * Omitting it asks about *any* neighbour on the named interface, which is
       * how a lab grades "this host resolved a neighbour on its link" without
       * pretending to know which one.
       */
      address: ipAddress.optional(),
      /** Restrict the match to one interface. Omit to match on any. */
      device: interfaceName.optional(),
      /** Any one of these states satisfies the check. */
      state: z.array(z.enum(NEIGHBOUR_STATES)).min(1).max(NEIGHBOUR_STATES.length).optional(),
      /** Whether the entry must carry a resolved hardware address. */
      lladdr: z.enum(['present', 'absent']).optional(),
      /** Assert that no entry for this address exists. */
      absent: z.boolean().optional(),
      ...common,
    })
    .strict()
    .refine((r) => !(r.absent && (r.state || r.lladdr)), {
      message: "absent: true cannot be combined with 'state' or 'lladdr'",
    })
    .refine((r) => r.address !== undefined || r.device !== undefined, {
      message: "needs an 'address', a 'device', or both — an unqualified check would match anything",
    })
    .refine((r) => !r.absent || r.address !== undefined, {
      message: "absent: true needs the 'address' it is asserting the absence of",
    }),

  /**
   * One HTTP request, made by this session's peer against this session's
   * sandbox.
   *
   * The check a reachability lab needs and no local observation can answer.
   * "This service is reachable from another machine" is a claim only another
   * machine can settle, and a student controls neither end of the measurement:
   * the request is issued by a container the platform owns, on the session's
   * own segment, against the sandbox's own container name.
   *
   * There is no `host` field, deliberately. The target is always this
   * session's sandbox, so a lab cannot aim the platform's HTTP client at an
   * address of its choosing — the one shape that would turn a grading check
   * into a request forgery primitive.
   */
  http_request: z
    .object({
      type: z.literal('http_request'),
      port: z.number().int().min(1).max(65535),
      /** Request path. Never a full URL, and never a host. */
      path: z
        .string()
        .min(1)
        .max(255)
        .regex(/^\/[A-Za-z0-9._~\-/]*$/, 'must be a path beginning with / and free of query syntax')
        .default('/'),
      expected_status: z.number().int().min(100).max(599).default(200),
      timeout_seconds: z.number().int().min(1).max(30).default(5),
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
// ---------------------------------------------------------------------------
// Ansible
// ---------------------------------------------------------------------------

/**
 * A path inside the student's project on the control node.
 *
 * Relative, no traversal, conservative character class. `isSafeWorkspacePath`
 * is the same function the sandbox uses at read time, so a path that validates
 * here is a path the sandbox will accept — the two cannot drift.
 */
const workspacePath = z
  .string()
  .min(1)
  .max(255)
  .refine(isSafeWorkspacePath, {
    message: 'must be a relative path inside the lab workspace (letters, digits, . _ - and /)',
  });

/**
 * A path on a managed node.
 *
 * Absolute, and confined to the directories the labs write into. A lab cannot
 * write a requirement that reads `/etc/shadow` — see `ALLOWED_MANAGED_ROOTS`.
 */
const managedPath = z
  .string()
  .min(1)
  .max(255)
  .refine(isAllowedManagedPath, {
    message:
      'must be an absolute managed-node path under an allowed root (/etc/jumptotech, /opt/jumptotech, /srv/jumptotech, /var/log/jumptotech, /var/www, /tmp/jumptotech)',
  });

/** A managed node in the session topology: `node1`, `node2`, … */
const managedNodeName = z.string().regex(/^node[1-9]$/, 'must be a managed node such as node1');

/**
 * Which managed nodes a check applies to.
 *
 * `all` is the default and the interesting case: a multi-node lab passes only
 * when *every* node reached the desired state, which is exactly the property a
 * "configure both web servers" exercise is teaching.
 */
const hostSelection = z
  .union([z.literal('all'), z.array(managedNodeName).min(1).max(4)])
  .default('all');

/** An inventory pattern, e.g. `all`, `web`, `node1`. */
const inventoryPattern = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.:,!&*-]*$/, 'must be an inventory pattern such as all or web');

const inventoryName = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/, 'must be an inventory group or host name');

const roleName = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9_][a-z0-9_-]*$/, 'must be a lowercase role name such as web');

/** A module reference: `copy`, `ansible.builtin.copy`, `template`. */
const moduleName = z
  .string()
  .min(2)
  .max(96)
  .regex(/^[a-z0-9_]+(\.[a-z0-9_]+){0,2}$/, 'must be a module name such as copy or ansible.builtin.copy');

/** Free text a check looks for inside a file. Never a regular expression. */
const contentFragment = z.string().min(1).max(512);


const ansibleRequirementSchemas = {
  // --- the student's project ----------------------------------------------

  /**
   * `ansible-inventory --list` succeeds and returns a parseable inventory.
   *
   * Deliberately the real command rather than a YAML/INI parse of our own: the
   * question a student is being taught to answer is "does *Ansible* accept my
   * inventory", and only Ansible can answer that.
   */
  ansible_inventory_valid: z
    .object({ type: z.literal('ansible_inventory_valid'), ...common })
    .strict(),

  ansible_group_exists: z
    .object({
      type: z.literal('ansible_group_exists'),
      group: inventoryName,
      /** Hosts that must be members. Order is irrelevant. */
      hosts: z.array(inventoryName).max(8).optional(),
      min_hosts: z.number().int().min(1).max(16).optional(),
      ...common,
    })
    .strict(),

  ansible_host_exists: z
    .object({
      type: z.literal('ansible_host_exists'),
      host: inventoryName,
      /** Require membership of this group as well as mere presence. */
      group: inventoryName.optional(),
      ...common,
    })
    .strict(),

  /** `ansible-playbook --syntax-check` passes. */
  ansible_playbook_valid: z
    .object({
      type: z.literal('ansible_playbook_valid'),
      playbook: workspacePath,
      ...common,
    })
    .strict(),

  /**
   * The playbook contains a task using a given module, and/or with a given name.
   *
   * A structural check on the YAML the student wrote, not on console output.
   * Module matching ignores the collection prefix, so `copy` and
   * `ansible.builtin.copy` are the same answer — which they are.
   */
  ansible_task_exists: z
    .object({
      type: z.literal('ansible_task_exists'),
      playbook: workspacePath,
      module: moduleName.optional(),
      /** Match on the task's `name:`, case-insensitively and as a substring. */
      name: z.string().min(1).max(160).optional(),
      /** Require the task to carry a `when:` condition. */
      has_when: z.boolean().optional(),
      /** Require the task to carry a `loop:` / `with_items:`. */
      has_loop: z.boolean().optional(),
      /** Require the task to notify this handler. */
      notifies: z.string().min(1).max(160).optional(),
      ...common,
    })
    .strict()
    .refine(
      (v) =>
        v.module !== undefined ||
        v.name !== undefined ||
        v.has_when === true ||
        v.has_loop === true ||
        v.notifies !== undefined,
      {
        message:
          'must state something to look for: module, name, has_when, has_loop, or notifies',
      },
    ),

  /** A role exists with the standard directory layout. */
  ansible_role_exists: z
    .object({
      type: z.literal('ansible_role_exists'),
      role: roleName,
      /** Directory the role must contain, each with a main.yml where relevant. */
      requires: z
        .array(z.enum(['tasks', 'handlers', 'templates', 'defaults', 'vars', 'files', 'meta']))
        .max(7)
        .default(['tasks']),
      /** Roles directory, relative to the project. */
      roles_dir: workspacePath.default('roles'),
      /**
       * A playbook that must actually apply the role.
       *
       * A role nobody includes is a directory tree, not automation — this is
       * what distinguishes "converted the playbook into a role" from "created
       * a role and left the old playbook doing the work".
       */
      used_by: workspacePath.optional(),
      ...common,
    })
    .strict(),

  /**
   * A handler exists, in a playbook or in a role.
   *
   * `notified_by` additionally requires some task to `notify:` it — the part
   * students most often leave out, and the reason a handler silently never runs.
   */
  ansible_handler_exists: z
    .object({
      type: z.literal('ansible_handler_exists'),
      name: z.string().min(1).max(160),
      /** Look in this playbook's `handlers:` section. */
      playbook: workspacePath.optional(),
      /** Look in `roles/<role>/handlers/main.yml`. */
      role: roleName.optional(),
      roles_dir: workspacePath.default('roles'),
      /** Require a task somewhere in the same file to notify it. */
      notified: z.boolean().default(false),
      ...common,
    })
    .strict()
    .refine((v) => v.playbook !== undefined || v.role !== undefined, {
      message: 'must specify playbook, role, or both',
    }),

  /** A Jinja2 template exists and actually templates something. */
  ansible_template_exists: z
    .object({
      type: z.literal('ansible_template_exists'),
      path: workspacePath,
      /** Variable names the template must reference, e.g. `app_port`. */
      references: z.array(inventoryName).max(8).default([]),
      ...common,
    })
    .strict(),

  // --- state on the managed nodes -----------------------------------------
  managed_file_exists: z
    .object({
      type: z.literal('managed_file_exists'),
      path: managedPath,
      hosts: hostSelection,
      kind: z.enum(['file', 'directory']).default('file'),
      /**
       * `absent` is what makes a conditionals lab gradable: "this file exists
       * on the primary and *not* on the replica" is the whole point of `when:`,
       * and a check that could only assert presence would pass a playbook that
       * ignored the condition entirely.
       */
      state: z.enum(['present', 'absent']).default('present'),
      /** Octal permissions the file must carry, e.g. `0644`. */
      mode: z.string().regex(/^0?[0-7]{3}$/, 'must be an octal mode such as 0644').optional(),
      ...common,
    })
    .strict(),

  managed_file_content: z
    .object({
      type: z.literal('managed_file_content'),
      path: managedPath,
      hosts: hostSelection,
      /** Every fragment must appear. Substrings, never regular expressions. */
      contains: z.array(contentFragment).max(8).default([]),
      /** No fragment may appear. */
      not_contains: z.array(contentFragment).max(8).default([]),
      /** The whole file, compared after trimming trailing whitespace. */
      equals: z.string().max(4096).optional(),
      ...common,
    })
    .strict()
    .refine((v) => v.contains.length > 0 || v.not_contains.length > 0 || v.equals !== undefined, {
      message: 'must specify contains, not_contains, or equals',
    }),

  /**
   * A daemon is (or is not) running on the managed nodes.
   *
   * Sandbox nodes are containers with no init system, so this is honestly a
   * process check: is a process with this name running. It is real observed
   * state on the node, and it is documented as such rather than dressed up as
   * a systemd unit query that could not be true here.
   */
  managed_service_state: z
    .object({
      type: z.literal('managed_service_state'),
      service: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/, 'must be a process name'),
      hosts: hostSelection,
      expected: z.enum(['running', 'stopped']).default('running'),
      ...common,
    })
    .strict(),

  // --- runtime ------------------------------------------------------------
  /**
   * Real connectivity: `ansible <pattern> -m ping` from the control node.
   *
   * Nothing here is simulated. The check passes only when Ansible opened an SSH
   * session to every matched host and the ping module answered `pong`.
   */
  ansible_connectivity: z
    .object({
      type: z.literal('ansible_connectivity'),
      pattern: inventoryPattern.default('all'),
      min_hosts: z.number().int().min(1).max(16).default(1),
      ...common,
    })
    .strict(),

  /**
   * The playbook converges: run it twice, and the second run changes nothing.
   *
   * `require_initial_change` additionally proves the first run *did* something,
   * by clearing `reset_paths` on every managed node first. Those paths go
   * through the same allow-list as every other managed-node path, so this can
   * only ever clear directories the labs themselves own.
   */
  ansible_idempotent: z
    .object({
      type: z.literal('ansible_idempotent'),
      playbook: workspacePath,
      require_initial_change: z.boolean().default(false),
      reset_paths: z.array(managedPath).max(8).default([]),
      ...common,
    })
    .strict()
    .refine((v) => !v.require_initial_change || v.reset_paths.length > 0, {
      message: 'require_initial_change needs reset_paths, so the first run has something to do',
    }),
} as const;

// ---------------------------------------------------------------------------
// CI/CD
// ---------------------------------------------------------------------------
//
// Every check here reads an artefact the student wrote — a workflow file, a
// Jenkinsfile, a pipeline script — or runs the project's own build and tests.
// Nothing contacts GitHub or Jenkins: a lab about *pipelines as code* is
// graded on the code, and the two things a pipeline ultimately has to do
// (build, test) are done for real in the session's own sandbox.

/**
 * A workflow path, additionally required to live where GitHub looks.
 *
 * Documented in the GitHub Actions workflow-syntax reference: workflow files
 * are read from `.github/workflows` in the repository root.
 */
const workflowPath = workspacePath.refine(
  (p) => /^\.github\/workflows\/[^/]+\.(ya?ml)$/i.test(p),
  { message: 'must be a .yml or .yaml file directly inside .github/workflows/' },
);

/** A GitHub Actions event name, e.g. `push`, `pull_request`, `workflow_dispatch`. */
const eventName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'must be a lowercase event name such as push or pull_request');

/** A git branch name, as it would appear in a `branches:` filter. */
const branchName = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/*]*$/, 'must be a branch name or pattern');

/** An environment variable name, as a workflow or Jenkinsfile would set it. */
const envVarName = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name such as REGISTRY_URL');

/**
 * One id from the platform's closed task table.
 *
 * A lab names a task *id*; the argv it maps to is written in platform code and
 * never composed from a lab definition. That is what keeps "run the student's
 * build" from becoming "run whatever a lab file says".
 */
const workspaceTaskId = z.enum(
  WORKSPACE_TASK_IDS as unknown as [WorkspaceTaskId, ...WorkspaceTaskId[]],
);

/** A YAML mapping key used as an identifier: a job id, an action input name. */
const identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, 'must be an identifier such as build or fetch-depth');

const cicdRequirementSchemas = {
  github_workflow_exists: z
    .object({
      type: z.literal('github_workflow_exists'),
      path: workflowPath,
      /** Require `name:` to be set. Off by default — `name` is optional syntax. */
      require_name: z.boolean().default(false),
      ...common,
    })
    .strict(),

  github_workflow_trigger: z
    .object({
      type: z.literal('github_workflow_trigger'),
      path: workflowPath,
      /** An event name from the `on:` key, e.g. `push`. */
      trigger: eventName,
      /** Require the trigger to be filtered to these branches. */
      branches: z.array(branchName).max(10).optional(),
      ...common,
    })
    .strict(),

  github_workflow_job_exists: z
    .object({
      type: z.literal('github_workflow_job_exists'),
      path: workflowPath,
      /** The job's key under `jobs:`. */
      job: identifier,
      /** Require a `runs-on` value, e.g. `ubuntu-latest`. */
      runs_on: z.string().min(1).max(64).optional(),
      /** Require the job to declare at least this many steps. */
      min_steps: z.number().int().min(1).max(50).optional(),
      /** Require `needs:` to include these job ids, so ordering is explicit. */
      needs: z.array(identifier).max(10).optional(),
      ...common,
    })
    .strict(),

  /**
   * A step inside a job does a particular thing.
   *
   * Either it *uses* an action (matched on the action name, ignoring the
   * version, so `actions/checkout@v4` and `@v5` both satisfy a lab that only
   * cares that code is checked out), or it *runs* a command containing all of
   * the given fragments. Fragments are plain substrings, never patterns: a lab
   * cannot supply a regular expression for the verifier to compile.
   */
  github_workflow_step_exists: z
    .object({
      type: z.literal('github_workflow_step_exists'),
      path: workflowPath,
      job: identifier,
      uses: z.string().min(1).max(160).optional(),
      run_contains: z.array(z.string().min(1).max(120)).max(6).optional(),
      /** Require the step's `with:` block to set these input names. */
      with_keys: z.array(identifier).max(10).optional(),
      ...common,
    })
    .strict()
    .refine((v) => v.uses !== undefined || v.run_contains !== undefined, {
      message: 'must specify uses, run_contains, or both',
    }),

  // --- Jenkins -------------------------------------------------------------
  /**
   * A Jenkinsfile exists and parses as a declarative pipeline.
   *
   * "Parses" means the platform's structural reader finds a `pipeline` block
   * with an `agent` and a `stages` block. It is a syntax and structure check,
   * not a Groovy interpreter — see README → Jenkins for exactly what that does
   * and does not prove.
   */
  jenkinsfile_exists: z
    .object({
      type: z.literal('jenkinsfile_exists'),
      path: workspacePath.default('Jenkinsfile'),
      /** Require an explicit `agent` directive at pipeline level. */
      require_agent: z.boolean().default(true),
      ...common,
    })
    .strict(),

  jenkins_stage_exists: z
    .object({
      type: z.literal('jenkins_stage_exists'),
      path: workspacePath.default('Jenkinsfile'),
      /** The stage name, matched exactly as written in `stage('…')`. */
      stage: z.string().min(1).max(64),
      /** Require the stage's `steps` block to mention all of these substrings. */
      steps_contain: z.array(z.string().min(1).max(120)).max(6).optional(),
      /** Require the stage to appear after these stages, in file order. */
      after: z.array(z.string().min(1).max(64)).max(10).optional(),
      ...common,
    })
    .strict(),

  // --- Environment and credentials ----------------------------------------
  /**
   * A named value is supplied by *reference* rather than written in the file.
   *
   * `via` pins the mechanism where the lab teaches one specific pattern:
   *
   *   `workflow_env`        `env:` in a GitHub Actions workflow
   *   `workflow_secret`     `${{ secrets.NAME }}`
   *   `jenkins_environment` an `environment { }` entry in a Jenkinsfile
   *   `jenkins_credentials` `credentials('id')` in a Jenkinsfile
   */
  environment_reference_exists: z
    .object({
      type: z.literal('environment_reference_exists'),
      path: workspacePath,
      /** The variable name, e.g. `REGISTRY_URL` or `DEPLOY_TOKEN`. */
      name: envVarName,
      via: z
        .enum(['workflow_env', 'workflow_secret', 'jenkins_environment', 'jenkins_credentials'])
        .optional(),
      ...common,
    })
    .strict(),

  /**
   * No credential-shaped value is written in plain text.
   *
   * Structural, not a word list: a value fails when a key that names a
   * credential (`*_TOKEN`, `*_PASSWORD`, `*_SECRET`, `*_API_KEY`, …) is
   * assigned a *literal* instead of a reference to a secret store. The lab
   * definition therefore never has to contain a secret value in order to
   * forbid one — which is the whole point.
   */
  secret_not_hardcoded: z
    .object({
      type: z.literal('secret_not_hardcoded'),
      path: workspacePath,
      ...common,
    })
    .strict(),

  // --- Build, test, artifacts ---------------------------------------------
  /**
   * A build artifact is present in the workspace.
   *
   * Distinct from `file_exists` only in intent and wording, but the distinction
   * matters to a student: this check is about what the pipeline *produced*, and
   * its failure text says so.
   */
  artifact_exists: z
    .object({
      type: z.literal('artifact_exists'),
      path: workspacePath,
      kind: z.enum(['file', 'directory']).default('file'),
      min_bytes: z.number().int().min(1).max(10_000_000).default(1),
      ...common,
    })
    .strict(),

  /**
   * An allow-listed task exits with an expected status.
   *
   * `command` is an *id* from `workspace/tasks.ts`, not a command line. There
   * is no field anywhere in this schema that carries one.
   */
  /**
   * One named task from the closed table exits with the expected status.
   *
   * Deliberately NOT `command_exit_code`, which already exists in the `linux`
   * family and means something different: that one runs an allow-listed
   * binary the lab names, this one runs a *task id* whose argv the platform
   * owns. Two checks with one name would be two contracts with one spelling.
   */
  workspace_task_exit_code: z
    .object({
      type: z.literal('workspace_task_exit_code'),
      command: workspaceTaskId,
      expected_exit_code: z.number().int().min(0).max(255).default(0),
      ...common,
    })
    .strict(),

  /** The project's build task succeeds, and optionally leaves an output path. */
  project_builds: z
    .object({
      type: z.literal('project_builds'),
      /** A path the build must have produced, checked after it exits. */
      produces: workspacePath.optional(),
      ...common,
    })
    .strict(),

  /** The project's test task succeeds. */
  tests_pass: z.object({ type: z.literal('tests_pass'), ...common }).strict(),
} as const;

const requirementSchemas = {
  ...kubernetesRequirementSchemas,
  ...sandboxRequirementSchemas,
  ...dockerRequirementSchemas,
  ...ansibleRequirementSchemas,
  ...cicdRequirementSchemas,
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
  // An IAM policy and a CloudFormation template are both *documents on disk*:
  // they are graded by parsing an artefact in the session's sandbox, exactly
  // as Terraform state is. Neither reaches an AWS account, holds a credential,
  // or calls an API — see docs/aws-production-security-spec.md. They are their
  // own families rather than `filesystem` checks because the provider table
  // has to be able to say which providers can answer them.
  iam: 'sandbox',
  cloudformation: 'sandbox',
  docker: 'docker',
  // An Ansible check is observed across a *set* of containers — the control
  // node and the managed nodes — over the session's own segment, so it needs a
  // reader of its own rather than the single-sandbox one. Keeping it a distinct
  // family is also what stops an Ansible check being written into a Linux lab,
  // where there are no managed nodes for it to be true about.
  ansible: 'ansible',
  // A CI/CD check reads a pipeline definition out of the student's project, or
  // runs the project's own build and tests. Both happen inside the session's
  // sandbox, but neither is a plain path read: the reader parses workflow and
  // Jenkinsfile syntax and memoises one build across several checks, so it is
  // its own family rather than a `filesystem` one.
  cicd: 'cicd',
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
export type AnsibleFamily = FamiliesFor<'ansible'>;
export type CicdFamily = FamiliesFor<'cicd'>;

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

export function isAnsibleFamily(family: RequirementFamily): family is AnsibleFamily {
  return REQUIREMENT_FAMILY_READERS[family] === 'ansible';
}

export function isCicdFamily(family: RequirementFamily): family is CicdFamily {
  return REQUIREMENT_FAMILY_READERS[family] === 'cicd';
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
  terraform_state_absent: 'terraform',
  terraform_resource_references: 'terraform',
  terraform_variable_declared: 'terraform',
  terraform_locals_declared: 'terraform',
  terraform_data_source_declared: 'terraform',
  terraform_resource_depends_on: 'terraform',
  terraform_variable_validation: 'terraform',
  terraform_resource_condition: 'terraform',
  terraform_check_declared: 'terraform',

  // Read from a policy document on disk, parsed rather than matched. Grouped
  // as their own family because the *meaning* of the artefact is IAM's, not the
  // filesystem's — the same reason `terraform` is separate from `filesystem`.
  iam_policy_document: 'iam',
  iam_policy_statement: 'iam',
  iam_policy_allows: 'iam',
  iam_policy_not_allows: 'iam',
  iam_policy_no_wildcard: 'iam',

  // Parsed from a template on disk. Its own family for the same reason
  // `terraform` is separate from `filesystem`: the meaning of the artefact is
  // CloudFormation's, not the filesystem's.
  cfn_template_valid: 'cloudformation',
  cfn_resource_exists: 'cloudformation',
  cfn_resource_property: 'cloudformation',
  cfn_resource_reference: 'cloudformation',
  cfn_references_resolve: 'cloudformation',
  cfn_output_exists: 'cloudformation',
  cfn_cidr_valid: 'cloudformation',
  cfn_cidr_within: 'cloudformation',
  cfn_cidr_disjoint: 'cloudformation',
  cfn_cidr_free_space: 'cloudformation',
  cfn_property_distinct: 'cloudformation',

  resource_absent: 'kubernetes',

  // These three read a path and nothing else, so they belong with the rest of
  // the filesystem family — a sandbox that can answer `file_mode` can answer
  // them too. `linux` is reserved for the checks that genuinely need the
  // sandbox to answer an *inspection command*.
  path_absent: 'filesystem',
  file_content_absent: 'filesystem',
  file_contains: 'filesystem',
  yaml_valid: 'filesystem',
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
  systemd_unit_section: 'linux',
  systemd_unit_directive: 'linux',
  neighbour_state: 'linux',
  http_request: 'linux',

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

  // --- Ansible: the control node and its managed nodes -------------------
  //
  // Every one of these is observed across the session's own topology — the
  // student's project on the control node, or real state on a managed node
  // reached over the session segment. None of them is answerable from a
  // single-container sandbox, which is why they are their own family.
  ansible_inventory_valid: 'ansible',
  ansible_group_exists: 'ansible',
  ansible_host_exists: 'ansible',
  ansible_playbook_valid: 'ansible',
  ansible_task_exists: 'ansible',
  ansible_role_exists: 'ansible',
  ansible_handler_exists: 'ansible',
  ansible_template_exists: 'ansible',
  managed_file_exists: 'ansible',
  managed_file_content: 'ansible',
  managed_service_state: 'ansible',
  ansible_connectivity: 'ansible',
  ansible_idempotent: 'ansible',

  // --- CI/CD: the pipeline the student wrote, and the project it builds ----
  github_workflow_exists: 'cicd',
  github_workflow_trigger: 'cicd',
  github_workflow_job_exists: 'cicd',
  github_workflow_step_exists: 'cicd',
  jenkinsfile_exists: 'cicd',
  jenkins_stage_exists: 'cicd',
  environment_reference_exists: 'cicd',
  secret_not_hardcoded: 'cicd',
  artifact_exists: 'cicd',
  workspace_task_exit_code: 'cicd',
  project_builds: 'cicd',
  tests_pass: 'cicd',
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

/** Requirement types answered across an Ansible session's control and managed nodes. */
export type AnsibleRequirementType = RequirementTypeOf<AnsibleFamily>;

/** Requirement types answered by reading a CI/CD project and running its build. */
export type CicdRequirementType = RequirementTypeOf<CicdFamily>;

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
