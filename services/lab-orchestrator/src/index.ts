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
  WorkspaceLabProvider,
  INDEX_DIRECTORY,
  describeWorkspaceTask,
  type WorkspaceProviderOptions,
  type WorkspaceRequirementWaiter,
} from './providers/workspace-provider.js';
export {
  CompositeLabProvider,
  UnknownProviderError,
  type CompositeProviderOptions,
} from './providers/composite-provider.js';
export {
  createLabProvider,
  createKubernetesProvider,
  createWorkspaceProvider,
  isSandboxKind,
  isSupportedProvider,
  SANDBOX_KINDS,
  SUPPORTED_PROVIDERS,
  type SandboxKind,
  type SupportedProvider,
} from './providers/factory.js';

// --- file-backed sandbox layer (PLATFORM-CICD-001) --------------------------
export * from './workspace/paths.js';
export * from './workspace/port.js';
export * from './workspace/tasks.js';
export {
  FsWorkspace,
  defaultTaskEnv,
  DEFAULT_MAX_READ_BYTES,
  MAX_TASK_OUTPUT_BYTES,
  type FsWorkspaceOptions,
} from './workspace/fs-workspace.js';
export {
  loadWorkspaceSeed,
  MAX_SEED_FILES,
  MAX_SEED_FILE_BYTES,
  MAX_SEED_TOTAL_BYTES,
  type SeedFile,
} from './workspace/seed.js';

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
