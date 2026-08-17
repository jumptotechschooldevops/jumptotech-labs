/**
 * The verification engine.
 *
 * ```text
 *                      requirement
 *                           │
 *                    requirement family
 *          ┌────────────────┼─────────────────┐
 *     kubernetes        filesystem         terraform
 *          │                │                  │
 *     VerifyReader      SandboxReader     SandboxReader
 *          │                │                  │
 *   Kubernetes API    the sandbox's real filesystem
 *          └────────────────┴──────────────────┘
 *                           │
 *                    PASS / FAIL + observed detail
 * ```
 *
 * Adding a lab never touches this file. Adding a *new kind of check* means one
 * entry in `requirements.ts` — including its family — and one handler here.
 * The type system enforces that both happen: the two handler maps are mapped
 * types over the requirement types of each family, so a requirement type with
 * no handler fails to compile, and a handler registered against the wrong
 * reader fails to compile too.
 *
 * There is no path from lab.yaml to arbitrary execution. A requirement names a
 * type from a closed vocabulary; the handler for that type is code that shipped
 * with the platform, and the only thing it is given is a read-only reader
 * already scoped to one session's sandbox.
 */
import {
  isDockerRequirementType,
  isSupportedRequirementType,
  requirementFamily,
  REQUIREMENT_TYPES,
  type DockerRequirementType,
  type KubernetesRequirementType,
  type Requirement,
  type RequirementType,
  type SandboxRequirementType,
} from '@jumptotech/lab-orchestrator';
import type {
  CheckResult,
  DockerVerifierHandler,
  Handler,
  SandboxVerifierHandler,
  VerifierHandler,
} from './contract.js';
import { VerifyReader } from './reader.js';
import { SandboxReader } from './sandbox-reader.js';
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
  directoryExists,
  fileContent,
  fileExists,
  fileGroup,
  fileMode,
  fileOwner,
} from './handlers/filesystem.js';
import {
  terraformInitialized,
  terraformOutputEquals,
  terraformResourceExists,
} from './handlers/terraform.js';
import {
  dockerContainerEnv,
  dockerContainerExists,
  dockerContainerExitCode,
  dockerContainerImage,
  dockerContainerMount,
  dockerContainerNetwork,
  dockerContainerPort,
  dockerContainerResourceLimit,
  dockerContainerRunning,
  dockerContainerState,
} from './handlers/docker-containers.js';
import {
  dockerImageConfig,
  dockerImageExists,
  dockerNetworkExists,
  dockerResourceAbsent,
  dockerVolumeExists,
} from './handlers/docker-resources.js';
import { dockerfileValid, workspaceFileExists } from './handlers/docker-workspace.js';
import { DockerVerifyReader } from './docker-reader.js';

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
 * this object unless it has exactly one handler per `KubernetesRequirementType`.
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

/**
 * Every sandbox requirement type, mapped to its handler.
 *
 * Same completeness guarantee as `KUBERNETES_HANDLERS`, over the other
 * families. These read a real filesystem inside one session's sandbox rather
 * than the Kubernetes API.
 */
const SANDBOX_HANDLERS: { [K in SandboxRequirementType]: SandboxVerifierHandler<K> } = {
  file_exists: fileExists,
  directory_exists: directoryExists,
  file_content: fileContent,
  file_mode: fileMode,
  file_owner: fileOwner,
  file_group: fileGroup,

  terraform_initialized: terraformInitialized,
  terraform_resource_exists: terraformResourceExists,
  terraform_output_equals: terraformOutputEquals,
};

/**
 * Every Docker requirement type, mapped to its handler.
 *
 * Same completeness guarantee, enforced independently: adding a Docker
 * requirement type without a handler fails to compile, and it cannot be
 * satisfied by a Kubernetes handler because the reader types differ.
 */
const DOCKER_HANDLERS: { [K in DockerRequirementType]: DockerVerifierHandler<K> } = {
  docker_container_exists: dockerContainerExists,
  docker_container_running: dockerContainerRunning,
  docker_container_state: dockerContainerState,
  docker_container_image: dockerContainerImage,
  docker_container_exit_code: dockerContainerExitCode,
  docker_container_env: dockerContainerEnv,
  docker_container_port: dockerContainerPort,
  docker_container_network: dockerContainerNetwork,
  docker_container_mount: dockerContainerMount,
  docker_container_resource_limit: dockerContainerResourceLimit,

  docker_image_exists: dockerImageExists,
  docker_image_config: dockerImageConfig,
  docker_volume_exists: dockerVolumeExists,
  docker_network_exists: dockerNetworkExists,

  workspace_file_exists: workspaceFileExists,
  dockerfile_valid: dockerfileValid,
  docker_resource_absent: dockerResourceAbsent,
};

/** Any reader a handler might be given. */
export type AnyVerifyReader = VerifyReader | SandboxReader | DockerVerifyReader;

/** Requirement types that currently have a handler. */
export function registeredRequirementTypes(): RequirementType[] {
  return [
    ...Object.keys(KUBERNETES_HANDLERS),
    ...Object.keys(SANDBOX_HANDLERS),
    ...Object.keys(DOCKER_HANDLERS),
  ] as RequirementType[];
}

export function hasHandler(type: string): boolean {
  if (!isSupportedRequirementType(type)) return false;
  return (
    Object.hasOwn(KUBERNETES_HANDLERS, type) ||
    Object.hasOwn(SANDBOX_HANDLERS, type) ||
    Object.hasOwn(DOCKER_HANDLERS, type)
  );
}

/** Is this requirement graded against a Docker daemon? */
export function isDockerRequirement(requirement: Requirement): boolean {
  return isDockerRequirementType(requirement.type);
}

/**
 * The readers a verification run may use.
 *
 * A run supplies whichever readers its provider can back. Asking for a check
 * whose reader is absent is reported as `skipped` with a plain explanation
 * rather than as a failed check — a missing reader is a platform problem, and
 * blaming the student for it would be wrong. In practice the lab loader already
 * refuses a lab whose requirements its provider cannot verify, so this is a
 * backstop rather than a routine path.
 */
export interface VerificationReaders {
  kubernetes?: VerifyReader | undefined;
  sandbox?: SandboxReader | undefined;
  docker?: DockerVerifyReader | undefined;
}

/** Stable, human-meaningful id for a check, used as the React key. */
export function checkId(requirement: Requirement, index: number): string {
  const name = 'name' in requirement ? requirement.name : 'target';
  return `${index + 1}-${requirement.type}-${name}`;
}

/** Accept a bare Kubernetes reader, a Docker reader, or the full reader set. */
function toReaders(input: AnyVerifyReader | VerificationReaders): VerificationReaders {
  if (input instanceof VerifyReader) return { kubernetes: input };
  if (input instanceof DockerVerifyReader) return { docker: input };
  if (input instanceof SandboxReader) return { sandbox: input };
  return input;
}

/**
 * Run one requirement.
 *
 * Dispatch is by requirement *family*, so the same call site serves a
 * Kubernetes check, a filesystem check and a Docker check without knowing which
 * it has. Throws only for a requirement type with no registered handler at all.
 */
export async function verifyRequirement(
  requirement: Requirement,
  readers: AnyVerifyReader | VerificationReaders,
  index = 0,
): Promise<CheckResult> {
  if (!hasHandler(requirement.type)) throw new UnsupportedRequirementError(requirement.type);
  const available = toReaders(readers);
  const family = requirementFamily(requirement.type);
  const id = checkId(requirement, index);

  if (family === 'kubernetes') {
    const handler = KUBERNETES_HANDLERS[
      requirement.type as KubernetesRequirementType
    ] as VerifierHandler<KubernetesRequirementType>;
    const label = requirement.label ?? handler.label(requirement as never);
    if (!available.kubernetes) {
      return {
        id,
        label,
        status: 'skipped',
        detail: 'This lab environment has no Kubernetes API to check against',
      };
    }
    const outcome = await handler.run(requirement as never, available.kubernetes);
    return {
      id,
      label,
      status: outcome.ok ? 'pass' : 'fail',
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    };
  }

  if (family === 'docker') {
    const handler = DOCKER_HANDLERS[
      requirement.type as DockerRequirementType
    ] as DockerVerifierHandler<DockerRequirementType>;
    const label = requirement.label ?? handler.label(requirement as never);
    if (!available.docker) {
      return {
        id,
        label,
        status: 'skipped',
        detail: 'This lab environment has no Docker daemon to check against',
      };
    }
    const outcome = await handler.run(requirement as never, available.docker);
    return {
      id,
      label,
      status: outcome.ok ? 'pass' : 'fail',
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    };
  }

  const handler = SANDBOX_HANDLERS[
    requirement.type as SandboxRequirementType
  ] as SandboxVerifierHandler<SandboxRequirementType>;
  const label = requirement.label ?? handler.label(requirement as never);
  if (!available.sandbox) {
    return {
      id,
      label,
      status: 'skipped',
      detail: 'This lab environment has no sandbox filesystem to check against',
    };
  }
  const outcome = await handler.run(requirement as never, available.sandbox);
  return {
    id,
    label,
    status: outcome.ok ? 'pass' : 'fail',
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  };
}

/**
 * Run every requirement against one session's environment.
 *
 * Checks run sequentially and independently: one failure never short-circuits
 * the rest, because a student is owed the full picture of what is and is not
 * yet correct.
 */
export async function verifyRequirements(
  requirements: readonly Requirement[],
  readers: AnyVerifyReader | VerificationReaders,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const [index, requirement] of requirements.entries()) {
    results.push(await verifyRequirement(requirement, readers, index));
  }
  return results;
}
