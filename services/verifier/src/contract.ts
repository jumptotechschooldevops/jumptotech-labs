/**
 * The verifier handler contract.
 *
 * Kept separate from `registry.ts` so handler modules and the registry that
 * collects them never import each other, and so a handler's only dependency is
 * this file plus the read-only `VerifyReader`.
 */
import type {
  DockerRequirementType,
  KubernetesRequirementType,
  RequirementOf,
  RequirementType,
  SandboxRequirementType,
} from '@jumptotech/lab-orchestrator';
import type { VerifyReader } from './reader.js';
import type { SandboxReader } from './sandbox-reader.js';
import type { DockerVerifyReader } from './docker-reader.js';

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  /** Why it failed / what was observed. Never the solution. */
  detail?: string;
}

/**
 * What a handler returns: a verdict, plus the observation behind it.
 *
 * `skipped` is the third state, and it exists because "pass or fail" is not an
 * honest vocabulary for every outcome. A check the platform *could not
 * perform* — a reader that cannot answer this particular question, a substrate
 * feature the provider does not offer — is a platform gap, and reporting it as
 * a failure blames the student for it. The registry already skips a whole
 * family when its reader is absent; this lets one handler say the same thing
 * about one check.
 *
 * `ok` stays `false` when skipped so that any caller which only looks at `ok`
 * still refuses to award a pass. Callers that render results read `skipped`
 * first — see `verifyRequirement`.
 */
export interface HandlerOutcome {
  /** True when the check could not be performed at all. Never a student's fault. */
  skipped?: boolean;
  ok: boolean;
  detail?: string;
}

export function pass(detail?: string): HandlerOutcome {
  return detail === undefined ? { ok: true } : { ok: true, detail };
}

/**
 * The platform could not look, so the student is not told they failed.
 *
 * The lab loader already refuses a lab whose provider cannot verify its
 * requirement families, so this is a backstop for the narrower case: the
 * family is right, but this one observation is unavailable.
 */
export function skip(detail: string): HandlerOutcome {
  return { ok: false, skipped: true, detail };
}

export function fail(detail: string): HandlerOutcome {
  return { ok: false, detail };
}

/** Uniform "the object is not there" message across every handler. */
export function missing(kind: string, name: string, namespace: string): HandlerOutcome {
  return fail(`No ${kind} named '${name}' found in namespace '${namespace}'`);
}

/**
 * The Docker equivalent.
 *
 * Deliberately does not name the sandbox: a Docker student's `docker ps` shows
 * only their own daemon, so "in sandbox lab-3f9c…" would be noise rather than
 * the orienting detail a namespace is on the Kubernetes side.
 */
export function missingDocker(kind: string, name: string): HandlerOutcome {
  return fail(`No ${kind} named '${name}' exists in your Docker environment`);
}

/**
 * One requirement type's implementation.
 *
 * `label` produces the student-facing line when the lab does not override it,
 * which is what lets a lab.yaml stay terse while the UI still reads well.
 *
 * The reader type is a parameter rather than a fixed `VerifyReader` because a
 * Docker handler is handed a Docker reader and a Kubernetes handler a
 * Kubernetes one — and neither can be given the other's, which is what stops a
 * handler reaching a substrate it has no business reading.
 */
export interface Handler<T extends RequirementType, R> {
  readonly type: T;
  label(requirement: RequirementOf<T>): string;
  run(requirement: RequirementOf<T>, reader: R): Promise<HandlerOutcome>;
}

/**
 * A handler and its reader, one alias per family.
 *
 * Keeping these as distinct aliases rather than one handler that receives
 * "whichever reader applies" is what lets the registry's mapped types prove, at
 * compile time, that every requirement type has a handler *of the right
 * family* — a filesystem check cannot accidentally be registered against the
 * Kubernetes reader, and a Docker check cannot reach the sandbox filesystem.
 */

/** A handler that reads the Kubernetes API. */
export type VerifierHandler<T extends KubernetesRequirementType> = Handler<T, VerifyReader>;

/** A handler that reads inside one session's sandbox filesystem. */
export type SandboxVerifierHandler<T extends SandboxRequirementType> = Handler<T, SandboxReader>;

/** A handler that reads a session's own Docker daemon and workspace. */
export type DockerVerifierHandler<T extends DockerRequirementType> = Handler<
  T,
  DockerVerifyReader
>;

/** Uniform "there is nothing at that path" message across the sandbox handlers. */
export function missingPath(kind: string, path: string): HandlerOutcome {
  return fail(`No ${kind} found at '${path}' in your lab environment`);
}
