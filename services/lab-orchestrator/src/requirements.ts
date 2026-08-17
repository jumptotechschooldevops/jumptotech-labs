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
 * Security property: every schema below is `.strict()`. A lab definition
 * therefore cannot smuggle extra keys — no `command:`, no `script:`, no
 * `exec:`. There is deliberately no requirement type that runs anything; all
 * verification is a read of a live API — the Kubernetes API server for the
 * Kubernetes track, a session's own Docker daemon for the Docker track.
 *
 * The vocabulary is split into two objects, `kubernetesRequirementSchemas` and
 * `dockerRequirementSchemas`, and re-joined into `requirementSchemas` at the
 * bottom. The split is what lets each substrate's verifier registry prove — at
 * compile time — that it implements every type it is responsible for, without
 * either registry having to know the other exists.
 */
import { z } from 'zod';
import { isSafeSandboxPath, MAX_SANDBOX_PATH_LENGTH } from './session/sandbox-paths.js';

/**
 * A path inside the session's sandbox home.
 *
 * Never absolute, never `..`, never a shell metacharacter — see
 * `session/sandbox-paths.ts` for the rule and for the second check the runtime
 * applies before any read. A lab definition therefore cannot name a host path,
 * and cannot name a path outside its own student's sandbox.
 */
const sandboxPath = z
  .string()
  .min(1)
  .max(MAX_SANDBOX_PATH_LENGTH)
  .refine(isSafeSandboxPath, {
    message:
      'must be a relative path inside the sandbox home (no leading /, no ~, no .. segments, no backslashes)',
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
 * Kubernetes and Docker requirement types live in separate objects above so
 * that each substrate's verifier registry can be checked for completeness
 * independently — see `services/verifier/src/registry.ts`, where the mapped
 * types make a missing handler a compile error rather than a runtime surprise.
 */
const requirementSchemas = {
  ...kubernetesRequirementSchemas,
  ...dockerRequirementSchemas,
} as const;

/** Every requirement type the platform supports, in documentation order. */
export const REQUIREMENT_TYPES = Object.keys(requirementSchemas) as ReadonlyArray<RequirementType>;

export type RequirementType = keyof typeof requirementSchemas;

/**
 * Which reader a requirement needs.
 *
 * This is the whole of the verifier's dispatch: `kubernetes` checks read the
 * Kubernetes API in the session's namespace, `filesystem` and `terraform`
 * checks read inside the session's sandbox, and `docker` checks read one
 * session's own Docker daemon and workspace. Splitting Terraform out from plain
 * filesystem checks is not cosmetic — it is what lets `lab-definition.ts` say
 * "the Linux provider cannot verify Terraform state" and refuse the lab.
 *
 * The mapped type below is the completeness guarantee: adding a requirement
 * type without classifying it fails to compile, so a new check can never
 * silently fall through to the wrong reader.
 */
export type RequirementFamily = 'kubernetes' | 'filesystem' | 'terraform' | 'docker';

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

/** Requirement types read through the sandbox filesystem rather than Kubernetes. */
export type SandboxRequirementType = RequirementTypeOf<'filesystem' | 'terraform'>;

export type KubernetesRequirementType = RequirementTypeOf<'kubernetes'>;

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

export function isDockerRequirementType(value: unknown): value is DockerRequirementType {
  return isSupportedRequirementType(value) && requirementFamily(value) === 'docker';
}

export function isKubernetesRequirementType(value: unknown): value is KubernetesRequirementType {
  return isSupportedRequirementType(value) && requirementFamily(value) === 'kubernetes';
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

/** Narrow a validated requirement to one type. */
export type RequirementOf<T extends RequirementType> = z.infer<(typeof requirementSchemas)[T]>;

/** The Kubernetes object kind a requirement reads, used for grouping/fetch planning. */
export function requirementSubject(requirement: Requirement): string {
  return requirement.type.split('_')[0] ?? requirement.type;
}
