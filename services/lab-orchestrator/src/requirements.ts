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
 * verification is a read of the Kubernetes API.
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

// --- Terraform scalars -----------------------------------------------------

/** An HCL identifier: a resource type, a resource name, a variable name. */
const terraformIdentifier = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_-]*$/,
    'must be a Terraform identifier (letter or underscore, then letters, digits, - or _)',
  );

/** A module reference: `application` or `module.application`. */
const terraformModuleRef = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^(module\.)?[A-Za-z_][A-Za-z0-9_-]*(\.module\.[A-Za-z_][A-Za-z0-9_-]*)*$/,
    'must be a module reference such as application or module.application',
  );

/**
 * A resource address as `terraform state list` prints it.
 *
 * The character class is deliberately tight — this string is compared against
 * addresses the platform itself derived from state, never interpolated into a
 * command or a path.
 */
const terraformAddress = z
  .string()
  .min(1)
  .max(512)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_.\-[\]"]*$/,
    'must be a Terraform address such as local_file.greeting or module.application.random_pet.name',
  );

/**
 * A provider source address, e.g. `hashicorp/local` or
 * `registry.terraform.io/hashicorp/local`.
 */
const providerSource = z
  .string()
  .min(3)
  .max(128)
  .regex(
    /^([a-z0-9][a-z0-9.-]*\/)?[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/,
    'must be a provider source such as hashicorp/local',
  );

/**
 * A version or version-constraint string, e.g. `2.5.2` or `~> 2.5`.
 *
 * A narrow character class rather than a constraint grammar: the value is only
 * ever compared against text the platform read out of the student's own files,
 * never parsed as a constraint or interpolated anywhere.
 */
const versionConstraint = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z.,>=<~^!+*\s-]+$/, 'must be a version or version constraint such as ~> 2.5');

/**
 * Where a lab's Terraform state actually lives, relative to the working
 * directory.
 *
 * Almost always omitted — the local backend's default is `terraform.tfstate`
 * beside the configuration, and every lab before TF-016 uses it. A lab that
 * teaches `backend "local" { path = … }` moves the file, and the checks have to
 * follow it there rather than reporting "nothing has been applied" about a
 * workspace that plainly has been.
 */
const stateFilePath = z
  .string()
  .min(1)
  .max(MAX_SANDBOX_PATH_LENGTH)
  .refine(isSafeSandboxPath, {
    message: 'must be a relative path inside the working directory (no leading /, no .. segments)',
  });

/**
 * Fields shared by every check that reads Terraform state.
 *
 * Spread rather than repeated, so a state-reading check cannot be added that
 * silently ignores a relocated backend — the two fields always travel together.
 */
const stateSource = {
  /** The Terraform working directory, relative to the sandbox home. */
  dir: sandboxPath,
  /** Where state lives inside `dir`. Defaults to `terraform.tfstate`. */
  state_file: stateFilePath.optional(),
};

/** A dotted path into an instance's attributes, e.g. `permissions.0.role`. */
const attributePath = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/,
    'must be a dotted attribute path such as filename or triggers.environment',
  );

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

  /**
   * A path must NOT exist in the sandbox.
   *
   * Proves an apply actually removed something, rather than only dropping it
   * from state and leaving the artefact behind.
   */
  file_absent: z
    .object({ type: z.literal('file_absent'), path: sandboxPath, ...common })
    .strict(),

  // --- Terraform ---------------------------------------------------------
  //
  // Every check below reads one of three things, and nothing else:
  //
  //   state   — the parsed `terraform.tfstate` in the lab's working directory
  //   config  — the block structure of that directory's `.tf` files
  //   files   — whether a path exists in the sandbox
  //
  // Two of them shell out to Terraform itself (`validate`, `fmt -check`), and
  // both are documented read-only subcommands. Nothing here can apply, destroy,
  // refresh, or reach a provider API — so a student can never lose work by
  // pressing Check Solution, and a check can never create a billable resource.
  //
  // Every type carries `dir`: the Terraform working directory, relative to the
  // sandbox home. A student who ran the workflow in the wrong directory has not
  // done the one the lab grades.

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

  /** `terraform validate` reports the configuration as valid. */
  terraform_valid: z
    .object({ type: z.literal('terraform_valid'), dir: sandboxPath, ...common })
    .strict(),

  /** `terraform fmt -check -recursive` finds nothing to rewrite. */
  terraform_formatted: z
    .object({ type: z.literal('terraform_formatted'), dir: sandboxPath, ...common })
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
      ...stateSource,
      /** Provider resource type, e.g. `local_file`. */
      resource_type: terraformIdentifier,
      /** The resource's local name, e.g. `manifest`. */
      name: terraformIdentifier,
      /** `application` or `module.application`. Omit for the root module. */
      module: terraformModuleRef.optional(),
      mode: z.enum(['managed', 'data']).default('managed'),
      /** Require an exact instance count, for `count` / `for_each` labs. */
      instances: z.number().int().min(0).max(100).optional(),
      ...common,
    })
    .strict(),

  /**
   * A resource address is present in state.
   *
   * A bare address (`local_file.report`) matches any instance, so a lab can
   * require "this is managed" without pinning an index it never asked for.
   */
  terraform_state_contains: z
    .object({
      type: z.literal('terraform_state_contains'),
      ...stateSource,
      address: terraformAddress,
      ...common,
    })
    .strict(),

  /**
   * A resource address must NOT be in state.
   *
   * The Terraform counterpart of `resource_absent`: the point of a state lab is
   * often that something was *removed* — a resource deleted from configuration
   * and applied away, or a `terraform state rm` performed deliberately.
   */
  terraform_state_absent: z
    .object({
      type: z.literal('terraform_state_absent'),
      ...stateSource,
      address: terraformAddress,
      ...common,
    })
    .strict(),

  /**
   * One attribute of a managed resource, as recorded in state.
   *
   * State holds what the provider actually produced, which is the honest place
   * to grade from: a student who hardcodes a value and one who derives it from
   * a variable both end up here, and both are correct if the result is right.
   */
  terraform_resource_attribute: z
    .object({
      type: z.literal('terraform_resource_attribute'),
      ...stateSource,
      resource_type: terraformIdentifier,
      name: terraformIdentifier,
      module: terraformModuleRef.optional(),
      mode: z.enum(['managed', 'data']).default('managed'),
      /** Which instance, for a counted resource. Defaults to the first. */
      index: z.union([z.number().int().min(0).max(99), z.string().min(1).max(64)]).optional(),
      /** Dotted path into the instance attributes, e.g. `triggers.environment`. */
      attribute: attributePath,
      /** Exact match, compared as text so YAML `8080` and `"8080"` agree. */
      equals: z.union([z.string().max(2048), z.number(), z.boolean()]).optional(),
      /** Substring match, for generated content whose whole value is not fixed. */
      contains: z.string().min(1).max(2048).optional(),
      ...common,
    })
    .strict()
    .refine((v) => !(v.equals !== undefined && v.contains !== undefined), {
      message: 'specify equals or contains, not both',
    }),

  /** How many instances of a resource type the state manages, across modules. */
  terraform_resource_count: z
    .object({
      type: z.literal('terraform_resource_count'),
      ...stateSource,
      resource_type: terraformIdentifier,
      count: z.number().int().min(0).max(100),
      ...common,
    })
    .strict(),

  terraform_output_exists: z
    .object({
      type: z.literal('terraform_output_exists'),
      ...stateSource,
      name: terraformIdentifier,
      ...common,
    })
    .strict(),

  /**
   * An output has a given value in state.
   *
   * There is deliberately no way to require the value of a *sensitive* output:
   * the handler refuses to compare one, so no lab can be written that would
   * make the platform hold a secret. This mirrors `secret_key`, which likewise
   * has no `value` field.
   */
  terraform_output_equals: z
    .object({
      type: z.literal('terraform_output_equals'),
      ...stateSource,
      name: terraformIdentifier,
      value: z.union([z.string().max(2048), z.number(), z.boolean()]),
      ...common,
    })
    .strict(),

  /** A `variable "name"` block is declared in the configuration. */
  terraform_variable_declared: z
    .object({
      type: z.literal('terraform_variable_declared'),
      dir: sandboxPath,
      name: terraformIdentifier,
      /** Require the variable to declare (or deliberately omit) a default. */
      has_default: z.boolean().optional(),
      /** Require a `type` argument to be present — teaches typed variables. */
      has_type: z.boolean().optional(),
      /**
       * A substring the declared type must contain, e.g. `map(object(`.
       *
       * A substring rather than an exact match because a complex type is
       * written across several lines with the author's own spacing, and a lab
       * teaching `map(object(…))` cares that the student reached for a map of
       * objects — not that they laid it out the way the lab author did. The
       * comparison is made against the type expression's source text with
       * whitespace collapsed; nothing is evaluated.
       */
      type_contains: z.string().min(1).max(200).optional(),
      ...common,
    })
    .strict(),

  /**
   * A variable is (or is not) marked `sensitive`.
   *
   * Read from configuration, because that is where the *decision* lives.
   * Whether a value then still appears in state is the lesson of the lab, not
   * something the check needs to read — and this platform deliberately never
   * compares a sensitive value.
   */
  terraform_variable_sensitive: z
    .object({
      type: z.literal('terraform_variable_sensitive'),
      dir: sandboxPath,
      name: terraformIdentifier,
      /** Defaults to "must be sensitive". */
      expected: z.boolean().default(true),
      ...common,
    })
    .strict(),

  /**
   * A variable declares at least one `validation` block.
   *
   * Optionally requires the rule's condition to mention a given function or
   * identifier, so a lab can ask for a *specific* kind of rule without pinning
   * the exact expression a student wrote.
   */
  terraform_variable_validation: z
    .object({
      type: z.literal('terraform_variable_validation'),
      dir: sandboxPath,
      name: terraformIdentifier,
      /** Minimum number of `validation` blocks. Defaults to 1. */
      min_rules: z.number().int().min(1).max(10).default(1),
      /** Identifiers or function names the conditions must between them mention. */
      condition_mentions: z.array(terraformIdentifier).min(1).max(10).optional(),
      ...common,
    })
    .strict(),

  /**
   * An output is (or is not) marked `sensitive`.
   *
   * Read from *state*, where Terraform records the flag it actually applied, so
   * a student who marked the output sensitive but never applied does not pass.
   * The value itself is never read — see `terraform_output_equals`.
   */
  terraform_output_sensitive: z
    .object({
      type: z.literal('terraform_output_sensitive'),
      ...stateSource,
      name: terraformIdentifier,
      expected: z.boolean().default(true),
      ...common,
    })
    .strict(),

  /** Names that must be defined in a `locals` block. */
  terraform_locals_declared: z
    .object({
      type: z.literal('terraform_locals_declared'),
      dir: sandboxPath,
      names: z.array(terraformIdentifier).min(1).max(20),
      ...common,
    })
    .strict(),

  /** A `data "type" "name"` block is declared in the configuration. */
  terraform_data_source_declared: z
    .object({
      type: z.literal('terraform_data_source_declared'),
      dir: sandboxPath,
      data_type: terraformIdentifier,
      name: terraformIdentifier,
      ...common,
    })
    .strict(),

  /**
   * A `lifecycle` rule is declared on a resource.
   *
   * Read from configuration rather than state, because that is where a
   * lifecycle rule lives — it shapes how Terraform plans changes and leaves no
   * trace in the applied result.
   */
  terraform_resource_lifecycle: z
    .object({
      type: z.literal('terraform_resource_lifecycle'),
      dir: sandboxPath,
      resource_type: terraformIdentifier,
      name: terraformIdentifier,
      setting: z.enum(['create_before_destroy', 'prevent_destroy', 'ignore_changes']),
      /** For a boolean setting: the value it must be set to. Defaults to true. */
      expected: z.boolean().optional(),
      /** For `ignore_changes`: attribute names the list must mention. */
      attributes: z.array(terraformIdentifier).min(1).max(20).optional(),
      ...common,
    })
    .strict(),

  /**
   * A module is both *called* and *present on disk*.
   *
   * Both halves matter: a `module` block alone is a call to nothing, and a
   * directory alone is dead code. A modules lab is only complete when the
   * student has written the module and wired it in.
   */
  terraform_module_exists: z
    .object({
      type: z.literal('terraform_module_exists'),
      dir: sandboxPath,
      /** The module call's label: `module "application"`. */
      name: terraformIdentifier,
      /** Require an exact `source` value, e.g. `./modules/application`. */
      source: z.string().min(1).max(255).optional(),
      /** Sandbox directory the module must live in. */
      directory: sandboxPath.optional(),
      ...common,
    })
    .strict(),

  /** A module call passes a named input argument. */
  terraform_module_input: z
    .object({
      type: z.literal('terraform_module_input'),
      dir: sandboxPath,
      module: terraformIdentifier,
      input: terraformIdentifier,
      ...common,
    })
    .strict(),

  // --- Providers ---------------------------------------------------------

  /**
   * A provider is declared in `required_providers`, with the source and version
   * constraint the lab asked for.
   *
   * Read from configuration: `required_providers` is a *statement of intent*,
   * and the objective it serves ("install and version Terraform providers") is
   * about writing that statement. What actually got installed is a separate
   * check — `terraform_lock_provider` — so a lab can require both and tell a
   * student which half is missing.
   */
  terraform_required_provider: z
    .object({
      type: z.literal('terraform_required_provider'),
      dir: sandboxPath,
      /** The local name: the key inside `required_providers`, e.g. `local`. */
      name: terraformIdentifier,
      /** The full source address the entry must declare. */
      source: providerSource.optional(),
      /** The exact constraint text, e.g. `~> 2.5`. Compared after collapsing spaces. */
      version_constraint: versionConstraint.optional(),
      ...common,
    })
    .strict(),

  /**
   * A `provider` block exists, optionally with a given alias.
   *
   * The alias is what makes "write configuration using multiple providers"
   * verifiable in a directory that only has one provider *plugin* available:
   * two configurations of the same provider exercise exactly the mechanism the
   * objective is about.
   */
  terraform_provider_configured: z
    .object({
      type: z.literal('terraform_provider_configured'),
      dir: sandboxPath,
      /** Provider local name, i.e. the block's label: `provider "local"`. */
      provider: terraformIdentifier,
      /** Require this alias. Omit to accept the default (unaliased) configuration. */
      alias: terraformIdentifier.optional(),
      ...common,
    })
    .strict(),

  /**
   * A resource in state is bound to a particular provider configuration.
   *
   * State records the full provider reference Terraform resolved
   * (`provider["registry.terraform.io/hashicorp/local"].reports`), which is the
   * only honest proof that the student's `provider = local.reports` argument
   * took effect rather than merely being typed.
   */
  terraform_resource_provider: z
    .object({
      type: z.literal('terraform_resource_provider'),
      ...stateSource,
      resource_type: terraformIdentifier,
      name: terraformIdentifier,
      module: terraformModuleRef.optional(),
      /** The alias the resource must be using. Omit to require the default config. */
      alias: terraformIdentifier.optional(),
      ...common,
    })
    .strict(),

  /**
   * The dependency lock file records a provider, at a version.
   *
   * Reads `.terraform.lock.hcl`, which `terraform init` writes and a student
   * cannot produce by typing a constraint. Together with
   * `terraform_required_provider` this is the difference between "declared a
   * version" and "installed the version they declared".
   */
  terraform_lock_provider: z
    .object({
      type: z.literal('terraform_lock_provider'),
      dir: sandboxPath,
      /** Registry address as the lock file writes it, e.g. `hashicorp/local`. */
      source: providerSource,
      /** The exact resolved version the lock must record. */
      version: versionConstraint.optional(),
      ...common,
    })
    .strict(),

  // --- Dependencies and conditions ---------------------------------------

  /**
   * A resource declares `depends_on`, naming given references.
   *
   * Configuration, not state: an explicit dependency exists precisely because
   * there is no attribute reference to infer it from, so it leaves no trace in
   * the applied result. That is also why the objective distinguishes it from
   * the implicit dependencies `terraform_resource_attribute` already proves.
   */
  terraform_resource_depends_on: z
    .object({
      type: z.literal('terraform_resource_depends_on'),
      dir: sandboxPath,
      resource_type: terraformIdentifier,
      name: terraformIdentifier,
      /** Addresses the list must mention, e.g. `null_resource.database`. */
      references: z.array(terraformAddress).min(1).max(10),
      ...common,
    })
    .strict(),

  /**
   * A resource or data source declares a custom condition.
   *
   * `precondition` and `postcondition` live inside a `lifecycle` block; both are
   * checked there. A lab may additionally require the condition text to mention
   * something, for the same reason `ignore_changes` can.
   */
  terraform_resource_condition: z
    .object({
      type: z.literal('terraform_resource_condition'),
      dir: sandboxPath,
      resource_type: terraformIdentifier,
      name: terraformIdentifier,
      mode: z.enum(['managed', 'data']).default('managed'),
      condition: z.enum(['precondition', 'postcondition']),
      /** Identifiers or function names the condition must mention. */
      condition_mentions: z.array(terraformIdentifier).min(1).max(10).optional(),
      ...common,
    })
    .strict(),

  /** A `check "name"` block with at least one `assert`. */
  terraform_check_declared: z
    .object({
      type: z.literal('terraform_check_declared'),
      dir: sandboxPath,
      name: terraformIdentifier,
      /** Minimum number of `assert` blocks. Defaults to 1. */
      min_assertions: z.number().int().min(1).max(10).default(1),
      ...common,
    })
    .strict(),

  // --- Backends and refactoring -------------------------------------------

  /**
   * The `terraform` block configures a backend of the given kind.
   *
   * Configuration only. There is no way for a lab in this sandbox to *prove* a
   * remote backend works — the sandbox has no network — so the platform does not
   * pretend otherwise: what it verifies is the block the student wrote, and the
   * state file that a local backend actually produced (via `state_file` on the
   * state checks).
   */
  terraform_backend_configured: z
    .object({
      type: z.literal('terraform_backend_configured'),
      dir: sandboxPath,
      /** Backend type, i.e. the block label: `backend "local"`. */
      backend: terraformIdentifier,
      /** Arguments the backend block must set, compared as literal strings. */
      arguments: z
        .record(terraformIdentifier, z.string().min(1).max(255))
        .refine((value) => Object.keys(value).length > 0, {
          message: 'must name at least one argument',
        })
        .optional(),
      ...common,
    })
    .strict(),

  /**
   * A `moved` block records a rename.
   *
   * The point of the block is that a resource keeps its identity through a
   * refactor, so a lab pairs this with a state check on the *new* address and an
   * attribute check proving the object was not recreated.
   */
  terraform_moved_declared: z
    .object({
      type: z.literal('terraform_moved_declared'),
      dir: sandboxPath,
      from: terraformAddress,
      to: terraformAddress,
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

/** Every requirement type the platform supports, in documentation order. */
export const REQUIREMENT_TYPES = Object.keys(requirementSchemas) as ReadonlyArray<RequirementType>;

export type RequirementType = keyof typeof requirementSchemas;

/**
 * Which reader a requirement needs.
 *
 * This is the whole of the verifier's dispatch: `kubernetes` checks read the
 * Kubernetes API in the session's namespace, `filesystem` and `terraform`
 * checks read inside the session's sandbox. Splitting Terraform out from plain
 * filesystem checks is not cosmetic — it is what lets `lab-definition.ts` say
 * "the Linux provider cannot verify Terraform state" and refuse the lab.
 *
 * The mapped type below is the completeness guarantee: adding a requirement
 * type without classifying it fails to compile, so a new check can never
 * silently fall through to the wrong reader.
 */
export type RequirementFamily = 'kubernetes' | 'filesystem' | 'terraform';

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
  file_absent: 'filesystem',

  terraform_initialized: 'terraform',
  terraform_valid: 'terraform',
  terraform_formatted: 'terraform',
  terraform_resource_exists: 'terraform',
  terraform_state_contains: 'terraform',
  terraform_state_absent: 'terraform',
  terraform_resource_attribute: 'terraform',
  terraform_resource_count: 'terraform',
  terraform_output_exists: 'terraform',
  terraform_output_equals: 'terraform',
  terraform_variable_declared: 'terraform',
  terraform_variable_sensitive: 'terraform',
  terraform_variable_validation: 'terraform',
  terraform_output_sensitive: 'terraform',
  terraform_locals_declared: 'terraform',
  terraform_data_source_declared: 'terraform',
  terraform_resource_lifecycle: 'terraform',
  terraform_module_exists: 'terraform',
  terraform_module_input: 'terraform',
  terraform_required_provider: 'terraform',
  terraform_provider_configured: 'terraform',
  terraform_resource_provider: 'terraform',
  terraform_lock_provider: 'terraform',
  terraform_resource_depends_on: 'terraform',
  terraform_resource_condition: 'terraform',
  terraform_check_declared: 'terraform',
  terraform_backend_configured: 'terraform',
  terraform_moved_declared: 'terraform',

  resource_absent: 'kubernetes',
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

export function isSupportedRequirementType(value: unknown): value is RequirementType {
  return typeof value === 'string' && Object.hasOwn(requirementSchemas, value);
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
