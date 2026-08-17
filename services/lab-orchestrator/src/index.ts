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
  createProviderRouter,
  isSupportedProvider,
  LAB_SUBSTRATES,
  SUPPORTED_PROVIDERS,
  type LabSubstrate,
  type SupportedProvider,
} from './providers/factory.js';
export { CompositeLabProvider, UnknownLabProviderError } from './providers/composite-provider.js';

// --- ansible track (PLATFORM-ANSIBLE-001) -----------------------------------
export * from './ansible/topology.js';
export * from './ansible/port.js';
export * from './ansible/paths.js';
export * from './ansible/docker-port.js';
export { DockerCli, type DockerCliOptions } from './ansible/docker-cli.js';
export { DockerAnsibleSandbox, type DockerAnsibleSandboxOptions } from './ansible/sandbox.js';
export {
  generateSessionKeyPair,
  toOpenSshPublicKey,
  type SessionKeyPair,
} from './ansible/keys.js';
export {
  loadLabWorkspace,
  workspaceDirectories,
  MAX_WORKSPACE_FILES,
  MAX_WORKSPACE_FILE_BYTES,
  MAX_WORKSPACE_TOTAL_BYTES,
  type WorkspaceFile,
} from './ansible/workspace.js';
export {
  AnsibleDockerProvider,
  DEFAULT_ANSIBLE_SANDBOX_LIMITS,
  SANDBOX_CAPABILITIES,
  type AnsibleDockerProviderOptions,
  type AnsibleSandboxLimits,
} from './providers/ansible-docker-provider.js';

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
