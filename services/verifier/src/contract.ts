/**
 * The verifier handler contract.
 *
 * Kept separate from `registry.ts` so handler modules and the registry that
 * collects them never import each other, and so a handler's only dependency is
 * this file plus the read-only `VerifyReader`.
 */
import type { RequirementOf, RequirementType } from '@jumptotech/lab-orchestrator';
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
export interface VerifierHandler<T extends RequirementType> {
  readonly type: T;
  label(requirement: RequirementOf<T>): string;
  run(requirement: RequirementOf<T>, reader: VerifyReader): Promise<HandlerOutcome>;
}
