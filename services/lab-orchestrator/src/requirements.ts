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
 * `exec:`. No requirement carries a command, a script, or a shell fragment.
 *
 * Two domains live here. Kubernetes requirements are answered by reading the
 * API server. Ansible requirements are answered by reading the student's
 * project on the control node, reading the state their automation produced on
 * the managed nodes, and — for the three runtime checks — running one of a
 * closed set of `ansible*` invocations the platform itself constructs. A lab
 * still cannot name what runs: it selects a check, and the argv is ours.
 */
import { z } from 'zod';
import { isAllowedManagedPath, isSafeWorkspacePath } from './ansible/paths.js';

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
  file_exists: z
    .object({
      type: z.literal('file_exists'),
      path: workspacePath,
      kind: z.enum(['file', 'directory']).default('file'),
      ...common,
    })
    .strict(),

  /** The file parses as YAML. The most common first failure in every lab. */
  yaml_valid: z.object({ type: z.literal('yaml_valid'), path: workspacePath, ...common }).strict(),

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

const requirementSchemas = {
  ...kubernetesRequirementSchemas,
  ...ansibleRequirementSchemas,
} as const;

/** The substrate a requirement is answered against. */
export type RequirementDomain = 'kubernetes' | 'ansible';

export const KUBERNETES_REQUIREMENT_TYPES = Object.keys(
  kubernetesRequirementSchemas,
) as ReadonlyArray<KubernetesRequirementType>;

export const ANSIBLE_REQUIREMENT_TYPES = Object.keys(
  ansibleRequirementSchemas,
) as ReadonlyArray<AnsibleRequirementType>;

export type KubernetesRequirementType = keyof typeof kubernetesRequirementSchemas;
export type AnsibleRequirementType = keyof typeof ansibleRequirementSchemas;

/**
 * Which reader answers this requirement.
 *
 * The verifier registry uses this to route a requirement to the right handler
 * table, which is what lets one lab schema, one catalog, and one Check Solution
 * button serve two completely different substrates.
 */
export function requirementDomain(type: RequirementType): RequirementDomain {
  return Object.hasOwn(ansibleRequirementSchemas, type) ? 'ansible' : 'kubernetes';
}

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
