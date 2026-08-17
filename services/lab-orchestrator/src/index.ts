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

// --- multi-track sandbox providers (PLATFORM-004) ---------------------------
export * from './providers/catalog.js';
export {
  ProviderRegistry,
  singleProviderRegistry,
  type ProviderRegistration,
  type ProviderStatus,
} from './providers/registry.js';
export {
  ContainerLabProvider,
  type ContainerProviderOptions,
} from './providers/container/sandbox-provider.js';
export {
  DockerCliRuntime,
  ContainerRuntimeError,
  GRANTABLE_CAPABILITIES,
  assertCapabilityName,
  MANAGED_CONTAINER_LABEL,
  MANAGED_CONTAINER_SELECTOR,
  CONTAINER_EXPIRES_LABEL,
  CONTAINER_LAB_LABEL,
  CONTAINER_PROVIDER_LABEL,
  CONTAINER_SESSION_LABEL,
  MAX_SANDBOX_READ_BYTES,
  assertEnvName,
  assertImageReference,
  assertUserName,
  type ContainerExecRequest,
  type ContainerExecResult,
  type ContainerInfo,
  type ContainerRuntimePort,
  type ContainerSpec,
} from './providers/container/runtime.js';
export {
  LinuxLabProvider,
  DEFAULT_LINUX_SANDBOX_IMAGE,
  LINUX_SANDBOX_CAPABILITIES,
  LINUX_SANDBOX_HOSTNAME,
  type LinuxProviderOptions,
} from './providers/linux-provider.js';
export {
  TerraformLabProvider,
  DEFAULT_TERRAFORM_SANDBOX_IMAGE,
  type TerraformProviderOptions,
} from './providers/terraform-provider.js';
export {
  DockerLabProvider,
  DEFAULT_DOCKER_SANDBOX_IMAGE,
  DOCKER_PROVIDER_DISABLED_REASON,
  DOCKER_PROVIDER_REMEDIATION,
  type DockerProviderOptions,
} from './providers/docker-provider.js';
export {
  AwsLabProvider,
  AWS_PROVIDER_DISABLED_REASON,
  AWS_PROVIDER_REMEDIATION,
  AWS_LAB_TAG,
  AWS_SESSION_TAG,
  AWS_STUDENT_TAG,
  type AwsSessionCredentials,
} from './providers/aws-provider.js';
export * from './session/sandbox-paths.js';
export {
  loadSetupFiles,
  nonExecutableMode,
  MAX_SETUP_FILE_BYTES,
  type LoadedSetupFile,
} from './session/setup-files.js';
export {
  loadSeedScripts,
  MAX_SEED_SCRIPT_BYTES,
  type LoadedSeedScript,
} from './session/seed-scripts.js';

// --- session layer (PLATFORM-002) ------------------------------------------
export * from './session/types.js';
export * from './session/identifiers.js';
export * from './session/isolation.js';
export * from './session/store.js';
export * from './session/manifests.js';
export {
  SessionManager,
  type ActivityReason,
  type SessionClosedEvent,
  type SessionLifecycleListener,
  type SessionLifetimeConfig,
  type SessionManagerOptions,
  type SandboxInspectResult,
  type SandboxReadPort,
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
