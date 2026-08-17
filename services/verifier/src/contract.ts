/**
 * The verifier handler contract.
 *
 * Kept separate from `registry.ts` so handler modules and the registry that
 * collects them never import each other, and so a handler's only dependency is
 * this file plus the read-only `VerifyReader`.
 */
import type {
  RequirementOf,
  RequirementType,
  SandboxRequirementType,
} from '@jumptotech/lab-orchestrator';
import type { VerifyReader } from './reader.js';
import type { SandboxReader } from './sandbox-reader.js';

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
  /**
   * The check could not be performed at all.
   *
   * Reported to the student as `skipped`, never as a failure. A platform that
   * cannot look at something has learned nothing about the student's work, and
   * saying "fail" there would blame them for the platform's gap.
   */
  skipped?: boolean;
}

export function pass(detail?: string): HandlerOutcome {
  return detail === undefined ? { ok: true } : { ok: true, detail };
}

export function fail(detail: string): HandlerOutcome {
  return { ok: false, detail };
}

/** The check could not run here — a platform limitation, not a student error. */
export function skip(detail: string): HandlerOutcome {
  return { ok: false, detail, skipped: true };
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

/**
 * One sandbox requirement type's implementation.
 *
 * Identical in shape to `VerifierHandler`, but handed a `SandboxReader` instead
 * of a Kubernetes one. Keeping them as two contracts rather than one handler
 * that receives "whichever reader applies" is what lets the registry's mapped
 * types prove, at compile time, that every requirement type has a handler *of
 * the right family* — a filesystem check cannot accidentally be registered
 * against the Kubernetes reader.
 */
export interface SandboxVerifierHandler<T extends SandboxRequirementType> {
  readonly type: T;
  label(requirement: RequirementOf<T>): string;
  run(requirement: RequirementOf<T>, reader: SandboxReader): Promise<HandlerOutcome>;
}

/** Uniform "there is nothing at that path" message across the sandbox handlers. */
export function missingPath(kind: string, path: string): HandlerOutcome {
  return fail(`No ${kind} found at '${path}' in your lab environment`);
}
