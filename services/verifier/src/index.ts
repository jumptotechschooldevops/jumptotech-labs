/**
 * Lab verifier.
 *
 * Reads the *desired state* from the lab definition and the *actual state*
 * from the live Kubernetes API, then reports each requirement independently.
 *
 * Explicit non-goals:
 *   - It never looks at command history, shell buffers, or terminal output. A
 *     student who creates the Deployment from a manifest, from `kubectl create`,
 *     or from a script they wrote themselves all pass identically, because all
 *     three produce the same desired state.
 *   - It never reveals the solution. Failure details describe *what is wrong
 *     with the observed state*, not what to type.
 *   - It never runs anything the lab author wrote. Requirements select from a
 *     closed vocabulary of handlers that ship with the platform.
 *
 * Verification is always scoped to one session's namespace, which is supplied
 * by the caller from the session record — never by the browser.
 */
import {
  DockerUnreachableError,
  KubernetesUnreachableError,
  assertValidLabNamespace,
  requirementsNeedDocker,
  requirementsNeedKubernetes,
  type DockerEnginePort,
  type KubernetesPort,
  type LabDefinition,
  type Requirement,
  type WorkspacePort,
} from '@jumptotech/lab-orchestrator';
import { VerifyReader } from './reader.js';
import {
  checkId,
  verifyRequirements,
  type AnyVerifyReader,
  type VerificationReaders,
} from './registry.js';
import { SandboxReader, type SandboxPort } from './sandbox-reader.js';
import { DockerVerifyReader } from './docker-reader.js';
import type { CheckResult } from './contract.js';

export * from './contract.js';
export * from './registry.js';
export { VerifyReader } from './reader.js';
export {
  SandboxReader,
  parseTerraformState,
  TERRAFORM_LOCK_FILE,
  TERRAFORM_STATE_FILE,
  TERRAFORM_WORK_DIR,
  type SandboxPort,
  type TerraformStateSnapshot,
} from './sandbox-reader.js';
export { normalizeMode } from './handlers/filesystem.js';
export {
  IamPolicyParseError,
  evaluateIamPolicy,
  findStatements,
  IAM_PRINCIPAL_TYPES,
  matchesIamPattern,
  parseIamPolicy,
  principalMatches,
  statementHasNotPrincipal,
  statementHasPrincipal,
  statementCoversAction,
  statementCoversResource,
  statementHasCondition,
  wildcardStatements,
  type ConditionSelector,
  type IamCondition,
  type IamDecision,
  type IamPolicy,
  type IamPrincipal,
  type IamStatement,
  type StatementSelector,
} from './iam-policy.js';
export {
  CFN_PSEUDO_PARAMETERS,
  CloudFormationParseError,
  collectReferences,
  outputReference,
  parseCloudFormationTemplate,
  readPath,
  referenceAt,
  unresolvedReferences,
  valueEquals,
  type CfnReference,
  type CfnResource,
  type CfnTemplate,
} from './cloudformation.js';
export { DockerVerifyReader } from './docker-reader.js';
export { imageMatches, normalizeImageReference } from './image.js';
export { parseQuantity, quantitiesEqual } from './quantity.js';
export {
  formatBytes,
  formatNanoCpus,
  memoryEqual,
  parseDockerCpus,
  parseDockerMemory,
} from './docker-quantity.js';
export {
  DOCKERFILE_INSTRUCTIONS,
  looksLikeDockerfile,
  parseDockerfile,
  type DockerfileInstruction,
  type ParsedDockerfile,
} from './dockerfile.js';

export interface VerificationResult {
  labId: string;
  /** The sandbox the checks ran against: a namespace, a container name, … */
  sandboxRef: string;
  /**
   * Kubernetes namespace the checks ran against.
   *
   * Carries the sandbox reference whatever the provider, so existing callers
   * keep working; for a container-backed lab read `sandboxRef` instead.
   */
  namespace: string;
  passed: boolean;
  /** `LAB PASSED` / `LAB NOT COMPLETE` — the headline the UI renders. */
  summary: 'LAB PASSED' | 'LAB NOT COMPLETE';
  checks: CheckResult[];
  checkedAt: string;
  /** Set when verification could not run at all (environment unreachable). */
  error?: { code: string; message: string };
}

export interface VerifyOptions {
  /** Required for labs with Kubernetes requirements. */
  k8s?: KubernetesPort;
  /** Required for labs with filesystem or Terraform requirements. */
  sandbox?: SandboxPort;
  /** Required for Docker labs: a port bound to *this session's* daemon. */
  docker?: DockerEnginePort;
  lab: LabDefinition;
  /**
   * The session's private sandbox: namespace for Kubernetes labs, container
   * name for container-backed ones. Always resolved from the session record.
   */
  namespace: string;
  /** Lets workspace checks read files the student authored. */
  workspace?: { port: WorkspacePort; sessionId: string };
  now?: () => Date;
}

/**
 * Verify a lab against its session's live environment.
 *
 * Which readers exist is decided by the caller from the session's provider, and
 * the registry dispatches each requirement to the right one. A Kubernetes lab
 * and a Linux lab therefore travel the same code path from the API route down.
 */
export async function verifyLab(options: VerifyOptions): Promise<VerificationResult> {
  const { lab, namespace } = options;
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const readers: VerificationReaders = {
    ...(options.k8s ? { kubernetes: new VerifyReader(options.k8s, namespace) } : {}),
    ...(options.sandbox ? { sandbox: new SandboxReader(options.sandbox) } : {}),
    ...(options.docker
      ? { docker: new DockerVerifyReader(options.docker, namespace, options.workspace) }
      : {}),
  };

  let checks: CheckResult[];
  try {
    checks = await verifyRequirements(lab.requirements as readonly Requirement[], readers);
  } catch (error) {
    // An environment we cannot read is not a failed lab — it is a broken
    // environment, and the UI must say so rather than blame the student.
    const unreachable =
      error instanceof KubernetesUnreachableError || error instanceof DockerUnreachableError;
    if (unreachable) {
      const substrate = lab.environment.provider === 'docker' ? 'Docker' : 'cluster';
      return {
        labId: lab.id,
        sandboxRef: namespace,
        namespace,
        passed: false,
        summary: 'LAB NOT COMPLETE',
        checkedAt,
        checks: (lab.requirements as readonly Requirement[]).map((requirement, index) => ({
          id: checkId(requirement, index),
          label: requirement.label ?? requirement.type,
          status: 'skipped' as const,
          detail: `Could not read ${substrate} state`,
        })),
        error: { code: 'ENVIRONMENT_UNREACHABLE', message: (error as Error).message },
      };
    }
    throw error;
  }

  const passed = checks.length > 0 && checks.every((c) => c.status === 'pass');
  return {
    labId: lab.id,
    sandboxRef: namespace,
    namespace,
    passed,
    summary: passed ? 'LAB PASSED' : 'LAB NOT COMPLETE',
    checks,
    checkedAt,
  };
}

/**
 * Poll a set of requirements until they all pass or the deadline expires.
 *
 * Used for lab *setup* verification: after the initial manifests are applied,
 * the Deployment they created needs a moment to become available. A student
 * must never be handed an environment whose starting condition was never
 * confirmed, so provisioning waits here rather than hoping.
 */
export async function waitForRequirements(options: {
  namespace: string;
  requirements: readonly Requirement[];
  timeoutMs: number;
  /** Supply exactly one of these, matching the lab's substrate. */
  k8s?: KubernetesPort;
  docker?: DockerEnginePort;
  workspace?: { port: WorkspacePort; sessionId: string };
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ ok: boolean; checks: CheckResult[] }> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalMs = options.intervalMs ?? 1_000;
  const deadline = now() + options.timeoutMs;

  if (options.requirements.length === 0) return { ok: true, checks: [] };

  const needsDocker = requirementsNeedDocker(options.requirements);
  const needsKubernetes = requirementsNeedKubernetes(options.requirements);

  if (needsDocker && needsKubernetes) {
    throw new Error('waitForRequirements cannot verify mixed docker and kubernetes requirements');
  }
  if (!needsDocker && !needsKubernetes) {
    throw new Error('waitForRequirements needs docker or kubernetes requirements');
  }

  const newReader = (): AnyVerifyReader => {
    if (needsDocker) {
      if (!options.docker) {
        throw new Error('waitForRequirements needs a docker port for docker requirements');
      }
      return new DockerVerifyReader(options.docker, options.namespace, options.workspace);
    }
    if (!options.k8s) {
      throw new Error('waitForRequirements needs a k8s port for kubernetes requirements');
    }
    assertValidLabNamespace(options.namespace);
    return new VerifyReader(options.k8s, options.namespace);
  };

  let checks: CheckResult[] = [];
  for (;;) {
    // A fresh reader each round: the cache must not outlive one observation.
    checks = await verifyRequirements(options.requirements, newReader());
    if (checks.every((c) => c.status === 'pass')) return { ok: true, checks };
    if (now() >= deadline) return { ok: false, checks };
    await sleep(intervalMs);
  }
}
