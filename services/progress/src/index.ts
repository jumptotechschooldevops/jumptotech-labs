/**
 * `@jumptotech/progress` — persistent learning state (PLATFORM-005).
 *
 * What belongs here: students, attempts, progress, hint usage.
 * What must never appear here: namespaces, containers, kubeconfigs, providers,
 * or any import from `@jumptotech/lab-orchestrator`. This package has no
 * dependency on the sandbox layer, which is what makes "the environment is
 * disposable, the history is not" a structural property rather than a promise.
 */
export * from './types.js';
export * from './identity.js';
export * from './repository.js';
export { InMemoryProgressRepository } from './memory-repository.js';
export {
  ProgressService,
  assertValidHintIndex,
  DEFAULT_ATTEMPT_PAGE,
  MAX_ATTEMPT_PAGE,
  type AttemptDetail,
  type ProgressServiceOptions,
  type StartAttemptInput,
} from './service.js';
export * from './postgres/index.js';
