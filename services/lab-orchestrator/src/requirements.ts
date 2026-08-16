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
