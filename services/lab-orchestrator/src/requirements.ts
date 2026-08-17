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
 * `exec:`. No requirement carries a command line: the Kubernetes types are
 * pure reads of the API, and the file-backed types are pure reads of the
 * session workspace except for three (`project_builds`, `tests_pass`,
 * `command_exit_code`) which name a task *id* from the platform's closed table
 * in `workspace/tasks.ts`. A lab picks from that table; it never writes an
 * entry in it.
 */
import { z } from 'zod';
import { WORKSPACE_TASK_IDS, type WorkspaceTaskId } from './workspace/tasks.js';
import { isSafeRelativePath } from './workspace/paths.js';

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

// --- scalars for file-backed (workspace) requirements ----------------------

/**
 * A path inside the session workspace.
 *
 * Validated by the same function the filesystem layer uses, so a path that
 * passes the schema is a path the workspace will accept — there is no second,
 * looser rule anywhere.
 */
const workspacePath = z
  .string()
  .min(1)
  .max(255)
  .refine((p) => isSafeRelativePath(p), {
    message:
      'must be a relative workspace path with no traversal, e.g. .github/workflows/ci.yml',
  });

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

/** A YAML mapping key used as an identifier: a job id, an action input name. */
const identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, 'must be an identifier such as build or fetch-depth');

/** A shell environment variable name. */
const envVarName = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name such as REGISTRY_URL');

/** One id from the platform's closed task table. */
const workspaceTaskId = z.enum(
  WORKSPACE_TASK_IDS as unknown as [WorkspaceTaskId, ...WorkspaceTaskId[]],
);

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

  // --- Files in the session workspace -------------------------------------
  /**
   * A file or directory exists in the student's workspace.
   *
   * `min_bytes` guards the commonest false pass in a file-based lab: a student
   * creates the right path with `touch` and moves on. A workflow file that
   * exists but is empty is not a workflow.
   */
  file_exists: z
    .object({
      type: z.literal('file_exists'),
      path: workspacePath,
      kind: z.enum(['file', 'directory']).default('file'),
      min_bytes: z.number().int().min(0).max(10_000_000).optional(),
      ...common,
    })
    .strict(),

  /**
   * A file the student authored says particular things.
   *
   * For content with no dedicated parser — a shell script, a Dockerfile, a
   * note recording a decision. `contains` fragments are plain substrings,
   * compared with whitespace collapsed and case ignored; they are **never**
   * patterns, so a lab cannot hand the verifier a regular expression to
   * compile. `absent` is the mirror image, for "you were asked to replace
   * this, not keep it".
   */
  file_contains: z
    .object({
      type: z.literal('file_contains'),
      path: workspacePath,
      contains: z.array(z.string().min(1).max(120)).max(10).default([]),
      absent: z.array(z.string().min(1).max(120)).max(10).default([]),
      ...common,
    })
    .strict()
    .refine((v) => v.contains.length > 0 || v.absent.length > 0, {
      message: 'must specify contains, absent, or both',
    }),

  /** A file parses as YAML. Structure is checked by the workflow types below. */
  yaml_valid: z
    .object({ type: z.literal('yaml_valid'), path: workspacePath, ...common })
    .strict(),

  // --- GitHub Actions ------------------------------------------------------
  /**
   * A workflow exists where GitHub would look for it.
   *
   * The path must be under `.github/workflows/`, because a valid workflow file
   * in the wrong directory is exactly the mistake CICD-010 injects: GitHub
   * never runs it, and a check that accepted any location would teach the
   * wrong lesson.
   */
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
  command_exit_code: z
    .object({
      type: z.literal('command_exit_code'),
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

/**
 * Where a requirement's evidence comes from.
 *
 * The verifier uses this to say something precise when a check cannot run at
 * all — "this lab reads the session workspace, and none is attached" is a very
 * different message from "the cluster is unreachable", and a student must not
 * see either one reported as a failed attempt.
 */
export type RequirementEvidence = 'kubernetes' | 'workspace';

const WORKSPACE_REQUIREMENT_TYPES = new Set<RequirementType>([
  'file_exists',
  'file_contains',
  'yaml_valid',
  'github_workflow_exists',
  'github_workflow_trigger',
  'github_workflow_job_exists',
  'github_workflow_step_exists',
  'jenkinsfile_exists',
  'jenkins_stage_exists',
  'environment_reference_exists',
  'secret_not_hardcoded',
  'artifact_exists',
  'command_exit_code',
  'project_builds',
  'tests_pass',
]);

export function requirementEvidence(type: RequirementType): RequirementEvidence {
  return WORKSPACE_REQUIREMENT_TYPES.has(type) ? 'workspace' : 'kubernetes';
}

/** Every requirement type that reads a session workspace rather than a cluster. */
export const WORKSPACE_REQUIREMENTS: ReadonlyArray<RequirementType> = [
  ...WORKSPACE_REQUIREMENT_TYPES,
];
