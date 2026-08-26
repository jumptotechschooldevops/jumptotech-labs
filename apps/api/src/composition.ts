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
  /**
   * Where Docker-track students author files.
   *
   * Needed because a Docker lab's `setup.verify` may contain
   * `workspace_file_exists` or `dockerfile_valid` — DOCKER-004, DOCKER-007 and
   * DOCKER-008 all do. Those grade files in the terminal container rather than
   * objects on the daemon, so the waiter's reader needs the workspace port and
   * the session it belongs to. Without both, the provider seeds the files and
   * the setup check then waits out its whole timeout looking somewhere else.
   */
  workspace?: WorkspacePort;
}

/** Production `waitFor` — routes setup checks to the correct substrate. */
export function buildRequirementWaiter(options: BuildRequirementWaiterOptions): RequirementWaiter {
  const { k8s, engines, workspace } = options;
  return (input) => {
    const needsDocker = requirementsNeedDocker(input.requirements);
    return waitForRequirements({
      k8s,
      ...(needsDocker ? { docker: engines.session(input.namespace) } : {}),
      // Only a Docker run can use it, and only when the caller said whose
      // workspace it is. A Kubernetes setup check never reaches this.
      ...(needsDocker && workspace && input.sessionId
        ? { workspace: { port: workspace, sessionId: input.sessionId } }
        : {}),
      ...input,
    });
  };
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
  /** Injected in tests so provisioning does not spend real seconds waiting. */
  sleep?: (ms: number) => Promise<void>;
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

  const waitFor = buildRequirementWaiter({ k8s, engines, workspace });

  const kubernetes = createLabProvider({
    provider: options.config.provider,
    clusterName: options.config.clusterName,
    ...(options.config.kubeconfigPath ? { kubeconfigPath: options.config.kubeconfigPath } : {}),
    k8s,
    waitForRequirements: waitFor,
  });

  /*
   * `workspace`, not `options.workspace`.
   *
   * The resolved port is the one the rest of the composition already uses, and
   * it is the only one that is ever real: `options.workspace` is the *test*
   * injection point and is undefined in production. Passing it here meant the
   * Docker provider fell back to `noopWorkspace` on every deployment — so a
   * Docker lab's `setup.docker` workspace files were never seeded into the
   * terminal container and `reset` silently restored nothing, while the
   * verifier read the student's real workspace through the port `index.ts`
   * hands `createApp`. The two halves disagreed about where the workspace was.
   */
  const providers = buildProviderRegistry({
    config: options.config,
    kubernetes,
    engines,
    workspace,
    waitForRequirements: waitFor,
    ...(options.containerRuntime ? { containerRuntime: options.containerRuntime } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });

  return { k8s, engines, workspace, waitFor, kubernetes, providers };
}
