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
  podReady,
  podResources,
  podRunning,
} from './handlers/pods.js';
import {
  deploymentAvailable,
  deploymentExists,
  deploymentImage,
  deploymentReplicas,
  deploymentRolloutComplete,
} from './handlers/deployments.js';
import {
  serviceEndpoints,
  serviceExists,
  servicePort,
  serviceSelector,
  serviceType,
} from './handlers/services.js';
import { configMapExists, configMapKey, secretExists } from './handlers/config.js';

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
  pod_ready: podReady,
  pod_label: podLabel,
  pod_resources: podResources,

  deployment_exists: deploymentExists,
  deployment_image: deploymentImage,
  deployment_replicas: deploymentReplicas,
  deployment_available: deploymentAvailable,
  deployment_rollout_complete: deploymentRolloutComplete,

  service_exists: serviceExists,
  service_type: serviceType,
  service_port: servicePort,
  service_selector: serviceSelector,
  service_endpoints: serviceEndpoints,

  configmap_exists: configMapExists,
  configmap_key: configMapKey,
  secret_exists: secretExists,
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

/** Stable, human-meaningful id for a check, used as the React key. */
export function checkId(requirement: Requirement, index: number): string {
  const name = 'name' in requirement ? requirement.name : 'target';
  return `${index + 1}-${requirement.type}-${name}`;
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
