export * from './types.js';
export * from './validation.js';
export * from './requirements.js';
export * from './lab-definition.js';
export * from './lab-registry.js';
export * from './k8s/port.js';
export * from './k8s/labels.js';
export { buildStudentKubeconfig, type StudentKubeconfigInput } from './k8s/student-kubeconfig.js';
export { KubernetesClient, toPodSnapshot, toDeploymentSnapshot } from './k8s/client.js';
export { KindLabProvider, type RequirementWaiter } from './providers/kind-provider.js';
export {
  createLabProvider,
  isSupportedProvider,
  SUPPORTED_PROVIDERS,
  type SupportedProvider,
} from './providers/factory.js';

// --- session layer (PLATFORM-002) ------------------------------------------
export * from './session/types.js';
export * from './session/identifiers.js';
export * from './session/isolation.js';
export * from './session/store.js';
export * from './session/manifests.js';
export {
  SessionManager,
  type ActivityReason,
  type SessionLifetimeConfig,
  type SessionManagerOptions,
  type SessionView,
  type StartSessionResult,
  type TeardownResult,
  type TerminalTerminator,
} from './session/manager.js';
export {
  SessionReaper,
  type ReaperOptions,
  type SweepReason,
  type SweepResult,
} from './session/reaper.js';

export * from './session-token.js';
