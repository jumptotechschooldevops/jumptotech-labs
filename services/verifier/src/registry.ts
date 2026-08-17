/**
 * The verification engine.
 *
 * ```text
 *                      requirement
 *                           │
 *                    requirement family
 *          ┌────────────┬───┴────────┬──────────────┐
 *     kubernetes    filesystem   terraform        linux
 *          │            │            │              │
 *     VerifyReader  SandboxReader SandboxReader SandboxReader
 *          │            │            │              │
 *   Kubernetes API      the sandbox's real filesystem, and — for the
 *          │            linux family — its process table, listening
 *          │            sockets and account databases
 *          └────────────┴────────────┴──────────────┘
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
  isSupportedRequirementType,
  requirementFamily,
  REQUIREMENT_TYPES,
  type KubernetesRequirementType,
  type Requirement,
  type RequirementType,
  type SandboxRequirementType,
} from '@jumptotech/lab-orchestrator';
import type { CheckResult, SandboxVerifierHandler, VerifierHandler } from './contract.js';
import type { VerifyReader } from './reader.js';
import type { SandboxReader } from './sandbox-reader.js';
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
  commandExitCode,
  commandOutput,
  fileContentAbsent,
  groupExists,
  pathAbsent,
  portListening,
  portNotListening,
  processNotRunning,
  processRunning,
  scriptExecutable,
  scriptRuns,
  userExists,
  userInGroup,
} from './handlers/linux.js';

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
const HANDLERS: { [K in KubernetesRequirementType]: VerifierHandler<K> } = {
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
 * Same completeness guarantee as `HANDLERS`, over the other families. These
 * read a real filesystem inside one session's sandbox rather than the
 * Kubernetes API.
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

  path_absent: pathAbsent,
  file_content_absent: fileContentAbsent,
  script_executable: scriptExecutable,
  script_runs: scriptRuns,
  process_running: processRunning,
  process_not_running: processNotRunning,
  port_listening: portListening,
  port_not_listening: portNotListening,
  user_exists: userExists,
  group_exists: groupExists,
  user_in_group: userInGroup,
  command_exit_code: commandExitCode,
  command_output: commandOutput,
};

/** Requirement types that currently have a handler. */
export function registeredRequirementTypes(): RequirementType[] {
  return [...Object.keys(HANDLERS), ...Object.keys(SANDBOX_HANDLERS)] as RequirementType[];
}

export function hasHandler(type: string): boolean {
  if (!isSupportedRequirementType(type)) return false;
  return Object.hasOwn(HANDLERS, type) || Object.hasOwn(SANDBOX_HANDLERS, type);
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
}

/** Stable, human-meaningful id for a check, used as the React key. */
export function checkId(requirement: Requirement, index: number): string {
  const name = 'name' in requirement ? requirement.name : 'target';
  return `${index + 1}-${requirement.type}-${name}`;
}

/** Accept either a bare Kubernetes reader or the full reader set. */
function toReaders(input: VerifyReader | VerificationReaders): VerificationReaders {
  return 'namespace' in input ? { kubernetes: input } : input;
}

/**
 * Run one requirement.
 *
 * Dispatch is by requirement *family*, so the same call site serves a
 * Kubernetes check and a filesystem check without knowing which it has.
 * Throws only for a requirement type with no registered handler at all.
 */
export async function verifyRequirement(
  requirement: Requirement,
  readers: VerifyReader | VerificationReaders,
  index = 0,
): Promise<CheckResult> {
  if (!hasHandler(requirement.type)) throw new UnsupportedRequirementError(requirement.type);
  const available = toReaders(readers);
  const family = requirementFamily(requirement.type);
  const id = checkId(requirement, index);

  if (family === 'kubernetes') {
    const handler = HANDLERS[requirement.type as KubernetesRequirementType] as VerifierHandler<RequirementType>;
    const label = requirement.label ?? handler.label(requirement);
    if (!available.kubernetes) {
      return {
        id,
        label,
        status: 'skipped',
        detail: 'This lab environment has no Kubernetes API to check against',
      };
    }
    const outcome = await handler.run(requirement, available.kubernetes);
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
  /*
   * A `linux` check needs more than a path read: a process table, a socket
   * list, an account database. A sandbox that offers reads but not inspection
   * cannot answer one, and saying so is the honest outcome — the platform could
   * not look, so the student is not told they failed. The lab loader already
   * refuses a lab whose provider cannot verify its family, so this is a
   * backstop rather than a routine path.
   */
  if (requirement.type === 'script_runs' && !available.sandbox.canRunScripts) {
    return {
      id,
      label,
      status: 'skipped',
      detail: 'This lab environment cannot run scripts',
    };
  }
  if (family === 'linux' && !available.sandbox.canInspect) {
    return {
      id,
      label,
      status: 'skipped',
      detail: 'This lab environment cannot be inspected for system state',
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
  readers: VerifyReader | VerificationReaders,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const [index, requirement] of requirements.entries()) {
    results.push(await verifyRequirement(requirement, readers, index));
  }
  return results;
}
