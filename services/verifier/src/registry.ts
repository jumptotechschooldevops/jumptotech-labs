/**
 * The verifier registry.
 *
 * ```text
 *   requirement ──► type ──► domain ──► handler ──► reader ──► PASS / FAIL
 *                                                   ├── Kubernetes API
 *                                                   └── Ansible sandbox
 * ```
 *
 * Adding a lab never touches this file. Adding a *new kind of check* means
 * adding one entry to `requirements.ts` and one handler here — and the type
 * system enforces that both happen: each table below is a mapped type over
 * every requirement type in its domain, so a requirement type without a handler
 * fails to compile.
 *
 * Two tables rather than one, keyed by domain. That is what lets a single lab
 * schema, a single catalog, and a single Check Solution button serve two
 * substrates: the requirement chooses the domain, the domain chooses the table,
 * and the table hands the handler a reader that can only read that substrate.
 *
 * There is no path from lab.yaml to arbitrary execution. A requirement names a
 * type from a closed vocabulary; the handler for that type is code that shipped
 * with the platform, and the only thing it is given is a reader.
 */
import {
  isSupportedRequirementType,
  requirementDomain,
  REQUIREMENT_TYPES,
  type AnsibleRequirementType,
  type KubernetesRequirementType,
  type Requirement,
  type RequirementType,
} from '@jumptotech/lab-orchestrator';
import type {
  AnsibleVerifierHandler,
  CheckResult,
  VerifierHandler,
  VerifyContext,
} from './contract.js';
import { AnsibleVerifyReader } from './ansible-reader.js';
import { VerifyReader } from './reader.js';
import {
  podExists,
  podImage,
  podLabel,
  podPhase,
  podReady,
  podResources,
  podRunning,
} from './handlers/pods.js';
import {
  deploymentAvailable,
  deploymentExists,
  deploymentImage,
  deploymentProbe,
  deploymentReplicas,
  deploymentResources,
  deploymentRolloutComplete,
  deploymentSelector,
  deploymentUsesConfigMap,
  deploymentUsesSecret,
} from './handlers/deployments.js';
import {
  serviceEndpoints,
  serviceExists,
  servicePort,
  serviceSelector,
  serviceType,
} from './handlers/services.js';
import {
  configMapExists,
  configMapKey,
  secretExists,
  secretKey,
  secretType,
} from './handlers/config.js';
import {
  cronJobExists,
  cronJobSchedule,
  cronJobSuspended,
  jobCompleted,
  jobExists,
  jobImage,
} from './handlers/batch.js';
import { resourceAbsent } from './handlers/generic.js';
import {
  ansibleHandlerExists,
  ansiblePlaybookValid,
  ansibleRoleExists,
  ansibleTaskExists,
  ansibleTemplateExists,
  fileExists,
  yamlValid,
} from './handlers/ansible-project.js';
import {
  ansibleConnectivity,
  ansibleGroupExists,
  ansibleHostExists,
  ansibleInventoryValid,
} from './handlers/ansible-inventory.js';
import {
  managedFileContent,
  managedFileExists,
  managedServiceState,
} from './handlers/ansible-managed.js';
import { ansibleIdempotent } from './handlers/ansible-idempotency.js';

/** Raised when a requirement names a type with no registered handler. */
export class UnsupportedRequirementError extends Error {
  readonly code = 'UNSUPPORTED_REQUIREMENT_TYPE';
  constructor(readonly requirementType: string) {
    super(
      `No verifier is registered for requirement type '${requirementType}'. Supported types: ${REQUIREMENT_TYPES.join(', ')}`,
    );
    this.name = 'UnsupportedRequirementError';
  }
}

/**
 * Every Kubernetes requirement type, mapped to its handler.
 *
 * The mapped type is the completeness guarantee: TypeScript will not accept
 * this object unless it has exactly one handler per requirement type.
 */
const KUBERNETES_HANDLERS: { [K in KubernetesRequirementType]: VerifierHandler<K> } = {
  pod_exists: podExists,
  pod_image: podImage,
  pod_running: podRunning,
  pod_phase: podPhase,
  pod_ready: podReady,
  pod_label: podLabel,
  pod_resources: podResources,

  deployment_exists: deploymentExists,
  deployment_image: deploymentImage,
  deployment_replicas: deploymentReplicas,
  deployment_available: deploymentAvailable,
  deployment_rollout_complete: deploymentRolloutComplete,
  deployment_selector: deploymentSelector,
  deployment_resources: deploymentResources,
  deployment_probe: deploymentProbe,
  deployment_uses_configmap: deploymentUsesConfigMap,
  deployment_uses_secret: deploymentUsesSecret,

  service_exists: serviceExists,
  service_type: serviceType,
  service_port: servicePort,
  service_selector: serviceSelector,
  service_endpoints: serviceEndpoints,

  configmap_exists: configMapExists,
  configmap_key: configMapKey,
  secret_exists: secretExists,
  secret_key: secretKey,
  secret_type: secretType,

  job_exists: jobExists,
  job_completed: jobCompleted,
  job_image: jobImage,
  cronjob_exists: cronJobExists,
  cronjob_schedule: cronJobSchedule,
  cronjob_suspended: cronJobSuspended,

  resource_absent: resourceAbsent,
};

/** Every Ansible requirement type, mapped to its handler. */
const ANSIBLE_HANDLERS: { [K in AnsibleRequirementType]: AnsibleVerifierHandler<K> } = {
  file_exists: fileExists,
  yaml_valid: yamlValid,
  ansible_inventory_valid: ansibleInventoryValid,
  ansible_group_exists: ansibleGroupExists,
  ansible_host_exists: ansibleHostExists,
  ansible_playbook_valid: ansiblePlaybookValid,
  ansible_task_exists: ansibleTaskExists,
  ansible_role_exists: ansibleRoleExists,
  ansible_handler_exists: ansibleHandlerExists,
  ansible_template_exists: ansibleTemplateExists,

  managed_file_exists: managedFileExists,
  managed_file_content: managedFileContent,
  managed_service_state: managedServiceState,

  ansible_connectivity: ansibleConnectivity,
  ansible_idempotent: ansibleIdempotent,
};

/** Requirement types that currently have a handler. */
export function registeredRequirementTypes(): RequirementType[] {
  return [...Object.keys(KUBERNETES_HANDLERS), ...Object.keys(ANSIBLE_HANDLERS)] as RequirementType[];
}

export function hasHandler(type: string): boolean {
  if (!isSupportedRequirementType(type)) return false;
  return Object.hasOwn(KUBERNETES_HANDLERS, type) || Object.hasOwn(ANSIBLE_HANDLERS, type);
}

/** Stable, human-meaningful id for a check, used as the React key. */
export function checkId(requirement: Requirement, index: number): string {
  const name = 'name' in requirement ? requirement.name : 'target';
  return `${index + 1}-${requirement.type}-${name}`;
}

/**
 * Normalise what a caller passed as "the reader".
 *
 * `verifyRequirement(requirement, reader)` with a bare `VerifyReader` predates
 * the Ansible track and is still the natural call for a Kubernetes-only test,
 * so it keeps working; anything else arrives as an explicit `VerifyContext`.
 */
function toContext(input: VerifyReader | AnsibleVerifyReader | VerifyContext): VerifyContext {
  if (input instanceof VerifyReader) return { kubernetes: input };
  if (input instanceof AnsibleVerifyReader) return { ansible: input };
  return input;
}

/**
 * The student-facing label for a requirement.
 *
 * A lab's own `label` always wins; the handler's generated one is the fallback,
 * which is what lets a lab.yaml stay terse while the UI still reads well.
 */
function labelFor(requirement: Requirement): string {
  if (requirement.label) return requirement.label;
  const handler =
    requirementDomain(requirement.type) === 'ansible'
      ? (ANSIBLE_HANDLERS[requirement.type as AnsibleRequirementType] as {
          label: (r: Requirement) => string;
        })
      : (KUBERNETES_HANDLERS[requirement.type as KubernetesRequirementType] as {
          label: (r: Requirement) => string;
        });
  return handler.label(requirement);
}

/**
 * Run one requirement.
 *
 * Throws only for an unregistered type — a platform bug. A requirement whose
 * domain has no reader in this context is reported `skipped`, never `fail`: a
 * missing reader says nothing about whether the student's work is correct, and
 * telling them otherwise would be a lie the UI would faithfully repeat.
 */
export async function verifyRequirement(
  requirement: Requirement,
  reader: VerifyReader | AnsibleVerifyReader | VerifyContext,
  index = 0,
): Promise<CheckResult> {
  if (!hasHandler(requirement.type)) throw new UnsupportedRequirementError(requirement.type);

  const context = toContext(reader);
  const id = checkId(requirement, index);
  const label = labelFor(requirement);

  if (requirementDomain(requirement.type) === 'ansible') {
    if (!context.ansible) {
      return { id, label, status: 'skipped', detail: 'No Ansible sandbox is available to check' };
    }
    const handler = ANSIBLE_HANDLERS[requirement.type as AnsibleRequirementType];
    const outcome = await (
      handler as AnsibleVerifierHandler<AnsibleRequirementType>
    ).run(requirement as never, context.ansible);
    return toCheckResult(id, label, outcome);
  }

  if (!context.kubernetes) {
    return { id, label, status: 'skipped', detail: 'No Kubernetes environment is available to check' };
  }
  const handler = KUBERNETES_HANDLERS[requirement.type as KubernetesRequirementType];
  const outcome = await (
    handler as VerifierHandler<KubernetesRequirementType>
  ).run(requirement as never, context.kubernetes);
  return toCheckResult(id, label, outcome);
}

function toCheckResult(
  id: string,
  label: string,
  outcome: { ok: boolean; detail?: string },
): CheckResult {
  return {
    id,
    label,
    status: outcome.ok ? 'pass' : 'fail',
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  };
}

/**
 * Run every requirement against one sandbox.
 *
 * Checks run sequentially and independently: one failure never short-circuits
 * the rest, because a student is owed the full picture of what is and is not
 * yet correct. Sequential also matters for the Ansible track, where two checks
 * running a playbook at once in the same sandbox would race each other.
 */
export async function verifyRequirements(
  requirements: readonly Requirement[],
  reader: VerifyReader | AnsibleVerifyReader | VerifyContext,
): Promise<CheckResult[]> {
  const context = toContext(reader);
  const results: CheckResult[] = [];
  for (const [index, requirement] of requirements.entries()) {
    results.push(await verifyRequirement(requirement, context, index));
  }
  return results;
}
