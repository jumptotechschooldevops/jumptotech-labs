/**
 * The verifier registry.
 *
 *   Requirement → requirement type → handler → Kubernetes API → PASS / FAIL
 *
 * Adding a lab never touches this file. Adding a *new kind of check* means
 * adding one entry to `requirements.ts` and one handler here — and the type
 * system enforces that both happen: `HANDLERS` is a mapped type over every
 * `RequirementType`, so a requirement type without a handler fails to compile.
 *
 * There is no path from lab.yaml to arbitrary execution. A requirement names a
 * type from a closed vocabulary; the handler for that type is code that shipped
 * with the platform, and the only thing it is given is a read-only reader.
 */
import {
  isSupportedRequirementType,
  REQUIREMENT_TYPES,
  type Requirement,
  type RequirementType,
} from '@jumptotech/lab-orchestrator';
import type { CheckResult, VerifierHandler } from './contract.js';
import type { VerifyReader } from './reader.js';
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
import { artifactExists, fileContains, fileExists, yamlValid } from './handlers/files.js';
import {
  githubWorkflowExists,
  githubWorkflowJobExists,
  githubWorkflowStepExists,
  githubWorkflowTrigger,
} from './handlers/github-actions.js';
import { jenkinsStageExists, jenkinsfileExists } from './handlers/jenkins.js';
import { environmentReferenceExists, secretNotHardcoded } from './handlers/pipeline-config.js';
import { commandExitCode, projectBuilds, testsPass } from './handlers/build.js';

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
 * Every requirement type, mapped to its handler.
 *
 * The mapped type is the completeness guarantee: TypeScript will not accept
 * this object unless it has exactly one handler per `RequirementType`.
 */
const HANDLERS: { [K in RequirementType]: VerifierHandler<K> } = {
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

  // --- file-backed sandboxes (CI/CD today; Linux, Docker, Terraform next) ---
  file_exists: fileExists,
  file_contains: fileContains,
  yaml_valid: yamlValid,
  artifact_exists: artifactExists,

  github_workflow_exists: githubWorkflowExists,
  github_workflow_trigger: githubWorkflowTrigger,
  github_workflow_job_exists: githubWorkflowJobExists,
  github_workflow_step_exists: githubWorkflowStepExists,

  jenkinsfile_exists: jenkinsfileExists,
  jenkins_stage_exists: jenkinsStageExists,

  environment_reference_exists: environmentReferenceExists,
  secret_not_hardcoded: secretNotHardcoded,

  command_exit_code: commandExitCode,
  project_builds: projectBuilds,
  tests_pass: testsPass,

  resource_absent: resourceAbsent,
};

/** Requirement types that currently have a handler. */
export function registeredRequirementTypes(): RequirementType[] {
  return Object.keys(HANDLERS) as RequirementType[];
}

export function hasHandler(type: string): boolean {
  return isSupportedRequirementType(type) && Object.hasOwn(HANDLERS, type);
}

function handlerFor(type: string): VerifierHandler<RequirementType> {
  if (!hasHandler(type)) throw new UnsupportedRequirementError(type);
  return HANDLERS[type as RequirementType] as VerifierHandler<RequirementType>;
}

/**
 * Stable, human-meaningful id for a check, used as the React key.
 *
 * The subject is whichever identifying field the requirement carries: a
 * Kubernetes object `name`, a workspace `path`, or an allow-listed task
 * `command`. Falling back to a constant would give two file checks in one lab
 * the same key.
 */
export function checkId(requirement: Requirement, index: number): string {
  const subject =
    'name' in requirement
      ? requirement.name
      : 'path' in requirement
        ? requirement.path
        : 'command' in requirement
          ? requirement.command
          : 'target';
  return `${index + 1}-${requirement.type}-${subject}`;
}

/** Run one requirement. Throws only for an unregistered type. */
export async function verifyRequirement(
  requirement: Requirement,
  reader: VerifyReader,
  index = 0,
): Promise<CheckResult> {
  const handler = handlerFor(requirement.type);
  const label = requirement.label ?? handler.label(requirement);
  const outcome = await handler.run(requirement, reader);

  return {
    id: checkId(requirement, index),
    label,
    status: outcome.ok ? 'pass' : 'fail',
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  };
}

/**
 * Run every requirement against one namespace.
 *
 * Checks run sequentially and independently: one failure never short-circuits
 * the rest, because a student is owed the full picture of what is and is not
 * yet correct.
 */
export async function verifyRequirements(
  requirements: readonly Requirement[],
  reader: VerifyReader,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const [index, requirement] of requirements.entries()) {
    results.push(await verifyRequirement(requirement, reader, index));
  }
  return results;
}
