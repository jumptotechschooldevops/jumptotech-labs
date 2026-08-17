/**
 * The verifier handler contract.
 *
 * Kept separate from `registry.ts` so handler modules and the registry that
 * collects them never import each other, and so a handler's only dependency is
 * this file plus the read-only `VerifyReader`.
 */
import type {
  AnsibleRequirementType,
  KubernetesRequirementType,
  RequirementOf,
} from '@jumptotech/lab-orchestrator';
import type { AnsibleVerifyReader } from './ansible-reader.js';
import type { VerifyReader } from './reader.js';

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  /** Why it failed / what was observed. Never the solution. */
  detail?: string;
}

/** What a handler returns: a verdict, plus the observation behind it. */
export interface HandlerOutcome {
  ok: boolean;
  detail?: string;
}

export function pass(detail?: string): HandlerOutcome {
  return detail === undefined ? { ok: true } : { ok: true, detail };
}

export function fail(detail: string): HandlerOutcome {
  return { ok: false, detail };
}

/** Uniform "the object is not there" message across every handler. */
export function missing(kind: string, name: string, namespace: string): HandlerOutcome {
  return fail(`No ${kind} named '${name}' found in namespace '${namespace}'`);
}

/**
 * One requirement type's implementation.
 *
 * `label` produces the student-facing line when the lab does not override it,
 * which is what lets a lab.yaml stay terse while the UI still reads well.
 */
export interface VerifierHandler<T extends KubernetesRequirementType> {
  readonly type: T;
  label(requirement: RequirementOf<T>): string;
  run(requirement: RequirementOf<T>, reader: VerifyReader): Promise<HandlerOutcome>;
}

/**
 * One Ansible requirement type's implementation.
 *
 * Structurally identical to `VerifierHandler`, and separate on purpose: the
 * reader it is handed can only read an Ansible sandbox, so a Kubernetes handler
 * cannot be registered in the Ansible table (or vice versa) even by mistake.
 */
export interface AnsibleVerifierHandler<T extends AnsibleRequirementType> {
  readonly type: T;
  label(requirement: RequirementOf<T>): string;
  run(requirement: RequirementOf<T>, reader: AnsibleVerifyReader): Promise<HandlerOutcome>;
}

/**
 * Everything a verification run may read.
 *
 * A lab runs on exactly one substrate, so exactly one of these is populated for
 * any given check. A requirement whose reader is absent is reported `skipped`
 * with an honest reason rather than failed — a missing reader is a platform
 * problem, and a student must never be told their correct work was wrong
 * because of one.
 */
export interface VerifyContext {
  kubernetes?: VerifyReader;
  ansible?: AnsibleVerifyReader;
}
