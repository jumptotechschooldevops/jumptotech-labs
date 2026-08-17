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
  AnsibleSandboxUnreachableError,
  KubernetesUnreachableError,
  type AnsibleSandboxPort,
  type KubernetesPort,
  type LabDefinition,
  type Requirement,
} from '@jumptotech/lab-orchestrator';
import { AnsibleVerifyReader } from './ansible-reader.js';
import { VerifyReader } from './reader.js';
import { checkId, verifyRequirements } from './registry.js';
import type { CheckResult, VerifyContext } from './contract.js';

export * from './contract.js';
export * from './registry.js';
export * from './ansible-yaml.js';
export { VerifyReader } from './reader.js';
export { AnsibleVerifyReader, firstMeaningfulLine, type InventoryReading } from './ansible-reader.js';
export { parsePingOutput } from './handlers/ansible-inventory.js';
export { imageMatches, normalizeImageReference } from './image.js';
export { parseQuantity, quantitiesEqual } from './quantity.js';

export interface VerificationResult {
  labId: string;
  namespace: string;
  passed: boolean;
  /** `LAB PASSED` / `LAB NOT COMPLETE` — the headline the UI renders. */
  summary: 'LAB PASSED' | 'LAB NOT COMPLETE';
  checks: CheckResult[];
  checkedAt: string;
  /** Set when verification could not run at all (cluster unreachable). */
  error?: { code: string; message: string };
}

export interface VerifyOptions {
  lab: LabDefinition;
  /** The session's private sandbox id — its namespace, or its container set. */
  namespace: string;
  /** Present for Kubernetes labs. */
  k8s?: KubernetesPort;
  /** Present for Ansible labs. */
  ansible?: AnsibleSandboxPort;
  now?: () => Date;
}

/**
 * Assemble the readers for one verification run.
 *
 * A lab runs on one substrate, so at most one of these is ever used — but both
 * are built when both ports are supplied, because `verifyLab` is called from
 * one route for every lab and deciding which is which is the registry's job,
 * not the caller's.
 */
function buildContext(options: VerifyOptions): VerifyContext {
  return {
    ...(options.k8s ? { kubernetes: new VerifyReader(options.k8s, options.namespace) } : {}),
    ...(options.ansible ? { ansible: new AnsibleVerifyReader(options.ansible, options.namespace) } : {}),
  };
}

export async function verifyLab(options: VerifyOptions): Promise<VerificationResult> {
  const { lab, namespace } = options;
  const checkedAt = (options.now?.() ?? new Date()).toISOString();

  let checks: CheckResult[];
  try {
    checks = await verifyRequirements(
      lab.requirements as readonly Requirement[],
      buildContext(options),
    );
  } catch (error) {
    // An environment we cannot read is not a failed lab — it is a broken
    // environment, and the UI must say so rather than blame the student.
    const unreachable =
      error instanceof KubernetesUnreachableError || error instanceof AnsibleSandboxUnreachableError;
    if (unreachable) {
      return {
        labId: lab.id,
        namespace,
        passed: false,
        summary: 'LAB NOT COMPLETE',
        checkedAt,
        checks: (lab.requirements as readonly Requirement[]).map((requirement, index) => ({
          id: checkId(requirement, index),
          label: requirement.label ?? requirement.type,
          status: 'skipped' as const,
          detail: 'Could not read the lab environment',
        })),
        error: { code: 'ENVIRONMENT_UNREACHABLE', message: (error as Error).message },
      };
    }
    throw error;
  }

  const passed = checks.length > 0 && checks.every((c) => c.status === 'pass');
  return {
    labId: lab.id,
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
  k8s?: KubernetesPort;
  ansible?: AnsibleSandboxPort;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ ok: boolean; checks: CheckResult[] }> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalMs = options.intervalMs ?? 1_000;
  const deadline = now() + options.timeoutMs;

  if (options.requirements.length === 0) return { ok: true, checks: [] };

  let checks: CheckResult[] = [];
  for (;;) {
    // Fresh readers each round: the cache must not outlive one observation.
    checks = await verifyRequirements(options.requirements, {
      ...(options.k8s ? { kubernetes: new VerifyReader(options.k8s, options.namespace) } : {}),
      ...(options.ansible
        ? { ansible: new AnsibleVerifyReader(options.ansible, options.namespace) }
        : {}),
    });
    if (checks.every((c) => c.status === 'pass')) return { ok: true, checks };
    if (now() >= deadline) return { ok: false, checks };
    await sleep(intervalMs);
  }
}
