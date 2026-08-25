/**
 * Sandbox composition shared by the production entrypoint and the test suite.
 *
 * Everything here is the wiring that must stay identical between `npm test` and
 * `docker compose up`: substrate selection for setup verification, the
 * Kubernetes provider, and the provider registry. Auth, progress, and HTTP
 * live in `index.ts`; they call into this module rather than re-implementing
 * the same `waitFor` / provider graph.
 */
import {
  DockerCliFactory,
  InMemoryWorkspace,
  KubernetesClient,
  createLabProvider,
  requirementsNeedDocker,
  type ContainerRuntimePort,
  type DockerEngineFactory,
  type KubernetesPort,
  type LabProvider,
  type RequirementWaiter,
  type WorkspacePort,
} from '@jumptotech/lab-orchestrator';
import { waitForRequirements } from '@jumptotech/verifier';
import type { ApiConfig } from './config.js';
import { buildProviderRegistry } from './providers.js';
import { HttpTerminalWorkspace } from './terminal-workspace.js';

export interface BuildRequirementWaiterOptions {
  k8s: KubernetesPort;
  engines: DockerEngineFactory;
}

/** Production `waitFor` — routes setup checks to the correct substrate. */
export function buildRequirementWaiter(options: BuildRequirementWaiterOptions): RequirementWaiter {
  const { k8s, engines } = options;
  return (input) =>
    waitForRequirements({
      k8s,
      ...(requirementsNeedDocker(input.requirements)
        ? { docker: engines.session(input.namespace) }
        : {}),
      ...input,
    });
}

export interface BuildSandboxCompositionOptions {
  config: ApiConfig;
  /** Injected in tests so no real cluster is touched. */
  k8s?: KubernetesPort;
  /** Injected in tests so no host Docker daemon is touched. */
  engines?: DockerEngineFactory;
  /** Injected in tests for Linux/Terraform providers. */
  containerRuntime?: ContainerRuntimePort;
  /** Where Docker-track students author files; defaults to in-memory in tests. */
  workspace?: WorkspacePort;
}

export interface SandboxComposition {
  k8s: KubernetesPort;
  engines: DockerEngineFactory;
  workspace: WorkspacePort;
  waitFor: RequirementWaiter;
  kubernetes: LabProvider;
  providers: ReturnType<typeof buildProviderRegistry>;
}

/** Build the sandbox substrate graph used by SessionManager and the verifier. */
export function buildSandboxComposition(options: BuildSandboxCompositionOptions): SandboxComposition {
  const k8s =
    options.k8s ??
    new KubernetesClient(
      options.config.kubeconfigPath ? { kubeconfigPath: options.config.kubeconfigPath } : {},
    );

  const engines =
    options.engines ?? new DockerCliFactory(options.config.dockerHost ? { dockerHost: options.config.dockerHost } : {});

  const workspace =
    options.workspace ??
    (options.config.terminalControlUrl
      ? new HttpTerminalWorkspace({
          baseUrl: options.config.terminalControlUrl,
          secret: options.config.internalServiceSecret,
        })
      : new InMemoryWorkspace());

  const waitFor = buildRequirementWaiter({ k8s, engines });

  const kubernetes = createLabProvider({
    provider: options.config.provider,
    clusterName: options.config.clusterName,
    ...(options.config.kubeconfigPath ? { kubeconfigPath: options.config.kubeconfigPath } : {}),
    k8s,
    waitForRequirements: waitFor,
  });

  const providers = buildProviderRegistry({
    config: options.config,
    kubernetes,
    engines,
    workspace: options.workspace,
    waitForRequirements: waitFor,
    ...(options.containerRuntime ? { containerRuntime: options.containerRuntime } : {}),
  });

  return { k8s, engines, workspace, waitFor, kubernetes, providers };
}
