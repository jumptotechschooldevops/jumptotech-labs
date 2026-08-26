export * from './types.js';
export * from './validation.js';
export * from './requirements.js';
export * from './lab-definition.js';
export * from './lab-registry.js';
export * from './track-definition.js';
export * from './k8s/port.js';
export * from './k8s/labels.js';
/**
 * Terraform configuration inspection.
 *
 * A block-structure scanner and a reference extractor — static reading only.
 * Nothing here evaluates an expression, calls a function, resolves a variable
 * or contacts anything; a lab asks what the configuration *says*, and Terraform
 * itself remains the only thing that decides what it means.
 */
export {
  scanHcl,
  scanHclFiles,
  blocksOfType,
  findBlock,
  findNestedBlock,
  argumentValue,
  argumentNames,
  hasArgument,
  referencedNames,
  literalString,
  type HclArgument,
  type HclBlock,
  type HclDocument,
} from './terraform/hcl.js';
export {
  extractReferences,
  referencesTarget,
  isLiteralExpression,
  type ReferenceKind,
  type TerraformReference,
} from './terraform/references.js';

export { buildStudentKubeconfig, type StudentKubeconfigInput } from './k8s/student-kubeconfig.js';
export { KubernetesClient, toPodSnapshot, toDeploymentSnapshot } from './k8s/client.js';
export {
  KindLabProvider,
  execFileExecRunner,
  type ProviderExecRunner,
  type RequirementWaiter,
} from './providers/kind-provider.js';
export {
  createLabProvider,
  isSupportedProvider,
  SUPPORTED_PROVIDERS,
  type ProviderFactoryOptions,
  type SupportedProvider,
} from './providers/factory.js';

// --- Docker track (PLATFORM-DOCKER-001) ------------------------------------
export * from './docker/port.js';
export * from './docker/workspace.js';
export {
  DockerCliClient,
  DockerCliFactory,
  execFileRunner,
  toContainerSnapshot,
  toImageSnapshot,
  type CliRunner,
  type DockerCliOptions,
} from './docker/cli-client.js';
export {
  describeDockerSetup,
  dockerSetupSchema,
  isEmptyDockerSetup,
  requiredImages,
  workspacePath,
  type DockerSetupContainer,
  type DockerSetupFile,
  type DockerSetupPlan,
} from './docker/setup.js';

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
  PROVIDER_RESTRICTED_CAPABILITIES,
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
  type NetworkInfo,
  type NetworkSpec,
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
  SANDBOX_LABELS,
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
export {
  PostgresSessionStore,
  type SessionSqlExecutor,
} from './session/postgres-store.js';
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

export { LAB_NETWORK_MODES, type LabNetworkMode } from './providers/catalog.js';

// --- Ansible -----------------------------------------------------------------
export {
  ALLOWED_MANAGED_ROOTS,
  MAX_READ_BYTES as ANSIBLE_MAX_READ_BYTES,
  ForbiddenSandboxPathError,
  type AnsibleNodeName,
  type AnsiblePathInfo,
  type AnsiblePlaybookRun,
  type AnsibleRunResult,
  type AnsibleSandboxPort,
} from './ansible/port.js';
export {
  ANSIBLE_CALLBACK_DIR,
  ANSIBLE_CALLBACK_NAME,
  ANSIBLE_MANAGED_USER,
  ANSIBLE_SHELL_USER,
  ANSIBLE_WORKSPACE_DIR,
  InvalidSandboxIdError,
  type AnsibleNode,
  type AnsibleNodeRole,
  type AnsibleTopology,
} from './ansible/topology.js';
export { isAllowedManagedPath, isSafeWorkspacePath } from './ansible/paths.js';

// --- CI/CD -------------------------------------------------------------------
export {
  WORKSPACE_TASKS,
  WORKSPACE_TASK_IDS,
  isWorkspaceTaskId,
  workspaceTask,
  type WorkspaceTaskDefinition,
  type WorkspaceTaskId,
  type WorkspaceTaskResult,
} from './cicd/tasks.js';
export {
  CICD_INSPECTION_COMMANDS,
  CicdLabProvider,
  DEFAULT_CICD_SANDBOX_IMAGE,
  type CicdProviderOptions,
} from './providers/cicd-provider.js';
export { DockerAnsibleSandbox, type DockerAnsibleSandboxOptions } from './ansible/sandbox.js';
export {
  DockerRuntimeExecPort,
  type AnsibleExecPort,
  type AnsibleExecResult,
  type AnsibleExecSpec,
} from './ansible/exec-port.js';
export { topologyFor, managedNodeNames, DEFAULT_MANAGED_NODE_COUNT } from './ansible/topology.js';
export {
  ANSIBLE_MANAGED_NODE_CAPABILITIES,
  ANSIBLE_MANAGED_NODE_COUNT,
  ANSIBLE_SSH_PORT,
  AnsibleLabProvider,
  DEFAULT_ANSIBLE_SANDBOX_IMAGE,
  type AnsibleProviderOptions,
} from './providers/ansible-provider.js';
export {
  CONTAINER_NODE_PATTERN,
  isContainerNodeRef,
  nodeRefForSandbox,
} from './session/identifiers.js';
export type {
  AnsibleRequirementType,
  AnsibleFamily,
  CicdRequirementType,
  CicdFamily,
} from './requirements.js';
