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
 * therefore cannot smuggle extra keys — no `shell:`, no free-form `exec:`. The
 * `linux` family does contain three types that *run* something
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

const requirementSchemas = {
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

  // --- Sandbox filesystem (Linux / Terraform / Docker) -------------------
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

  // --- Generic -----------------------------------------------------------
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
} as const;

/** Every requirement type the platform supports, in documentation order. */
export const REQUIREMENT_TYPES = Object.keys(requirementSchemas) as ReadonlyArray<RequirementType>;

export type RequirementType = keyof typeof requirementSchemas;

/**
 * Which reader a requirement needs.
 *
 * This is the whole of the verifier's dispatch: `kubernetes` checks read the
 * Kubernetes API in the session's namespace; `filesystem`, `terraform` and
 * `linux` checks all read inside the session's sandbox. Splitting them is not
 * cosmetic — it is what lets `lab-definition.ts` say "the Linux provider
 * cannot verify Terraform state", or "the Terraform provider cannot inspect a
 * process table", and refuse the lab at load time.
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
export type RequirementFamily = 'kubernetes' | 'filesystem' | 'terraform' | 'linux';

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

export function isSupportedRequirementType(value: unknown): value is RequirementType {
  return typeof value === 'string' && Object.hasOwn(requirementSchemas, value);
}

export function isLinuxRequirementType(value: unknown): value is LinuxRequirementType {
  return isSupportedRequirementType(value) && REQUIREMENT_FAMILIES[value] === 'linux';
}

export function isKubernetesRequirementType(value: unknown): value is KubernetesRequirementType {
  return isSupportedRequirementType(value) && REQUIREMENT_FAMILIES[value] === 'kubernetes';
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
