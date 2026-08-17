/**
 * Provider selection.
 *
 * Two kinds of sandbox exist today and a lab picks one with
 * `environment.provider`:
 *
 *   `kubernetes` → a private namespace in the shared kind cluster
 *   `workspace`  → a private project directory on disk
 *
 * The factory builds the members that are configured and wraps them in a
 * `CompositeLabProvider`, so callers keep dealing with exactly one
 * `LabProvider`. Adding a sandbox backend later (EKS, Firecracker, gVisor, a
 * per-session container) means implementing `LabProvider` and adding it to the
 * map here. No API route, verifier rule, or React component changes.
 */
import { KubernetesClient } from '../k8s/client.js';
import type { KubernetesPort } from '../k8s/port.js';
import type { LabProvider } from '../types.js';
import { KindLabProvider, type RequirementWaiter } from './kind-provider.js';
import {
  WorkspaceLabProvider,
  type WorkspaceRequirementWaiter,
} from './workspace-provider.js';
import { CompositeLabProvider } from './composite-provider.js';

/** Substrates that can back the `kubernetes` sandbox kind. */
export const SUPPORTED_PROVIDERS = ['kind'] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

/** The value a lab writes in `environment.provider`. */
export const SANDBOX_KINDS = ['kubernetes', 'workspace'] as const;
export type SandboxKind = (typeof SANDBOX_KINDS)[number];

export interface ProviderFactoryOptions {
  /** Which Kubernetes substrate to use for `kubernetes` labs. */
  provider: string;
  clusterName: string;
  kubeconfigPath?: string;
  /** Injected in tests to avoid touching a real cluster. */
  k8s?: KubernetesPort;
  /** Confirms a Kubernetes lab's declared initial state actually materialised. */
  waitForRequirements?: RequirementWaiter;

  /**
   * Root directory for file-backed sandboxes.
   *
   * Omit to run without the workspace provider — a deployment that serves only
   * Kubernetes tracks needs no workspace storage, and a lab that asks for one
   * then fails loudly at start rather than silently getting the wrong sandbox.
   */
  workspaceRoot?: string;
  /** Confirms a workspace lab's seeded project files are in place. */
  waitForWorkspaceRequirements?: WorkspaceRequirementWaiter;
}

export function isSupportedProvider(value: string): value is SupportedProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

export function isSandboxKind(value: string): value is SandboxKind {
  return (SANDBOX_KINDS as readonly string[]).includes(value);
}

/** Build the Kubernetes-backed provider on its own. */
export function createKubernetesProvider(options: ProviderFactoryOptions): LabProvider {
  if (!isSupportedProvider(options.provider)) {
    throw new Error(
      `Unknown LAB_PROVIDER '${options.provider}'. Supported: ${SUPPORTED_PROVIDERS.join(', ')}`,
    );
  }

  const k8s =
    options.k8s ??
    new KubernetesClient(options.kubeconfigPath ? { kubeconfigPath: options.kubeconfigPath } : {});

  switch (options.provider) {
    case 'kind':
      return new KindLabProvider({
        k8s,
        clusterName: options.clusterName,
        ...(options.kubeconfigPath ? { kubeconfigPath: options.kubeconfigPath } : {}),
        ...(options.waitForRequirements ? { waitForRequirements: options.waitForRequirements } : {}),
      });
    default: {
      const exhaustive: never = options.provider;
      throw new Error(`Unhandled provider ${String(exhaustive)}`);
    }
  }
}

/** Build the file-backed provider on its own. */
export function createWorkspaceProvider(
  options: Pick<ProviderFactoryOptions, 'workspaceRoot' | 'waitForWorkspaceRequirements'>,
): WorkspaceLabProvider {
  if (!options.workspaceRoot) {
    throw new Error('createWorkspaceProvider requires a workspaceRoot');
  }
  return new WorkspaceLabProvider({
    root: options.workspaceRoot,
    ...(options.waitForWorkspaceRequirements
      ? { waitForRequirements: options.waitForWorkspaceRequirements }
      : {}),
  });
}

/**
 * The provider the composition root installs: one facade over every configured
 * sandbox kind.
 */
export function createLabProvider(options: ProviderFactoryOptions): LabProvider {
  const providers: Record<string, LabProvider> = {
    kubernetes: createKubernetesProvider(options),
  };
  if (options.workspaceRoot) {
    providers.workspace = createWorkspaceProvider(options);
  }
  return new CompositeLabProvider({ providers });
}
