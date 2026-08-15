/**
 * Provider selection.
 *
 * Adding a sandbox backend later (EKS, Firecracker, gVisor …) means adding a
 * case here and implementing `LabProvider`. No API route, verifier rule, or
 * React component changes.
 */
import { KubernetesClient } from '../k8s/client.js';
import type { KubernetesPort } from '../k8s/port.js';
import type { LabProvider } from '../types.js';
import { KindLabProvider } from './kind-provider.js';

export const SUPPORTED_PROVIDERS = ['kind'] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export interface ProviderFactoryOptions {
  provider: string;
  clusterName: string;
  kubeconfigPath?: string;
  /** Injected in tests to avoid touching a real cluster. */
  k8s?: KubernetesPort;
}

export function isSupportedProvider(value: string): value is SupportedProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

export function createLabProvider(options: ProviderFactoryOptions): LabProvider {
  if (!isSupportedProvider(options.provider)) {
    throw new Error(
      `Unknown LAB_PROVIDER '${options.provider}'. Supported: ${SUPPORTED_PROVIDERS.join(', ')}`,
    );
  }

  const k8s =
    options.k8s ??
    new KubernetesClient(
      options.kubeconfigPath ? { kubeconfigPath: options.kubeconfigPath } : {},
    );

  switch (options.provider) {
    case 'kind':
      return new KindLabProvider({
        k8s,
        clusterName: options.clusterName,
        ...(options.kubeconfigPath ? { kubeconfigPath: options.kubeconfigPath } : {}),
      });
    default: {
      const exhaustive: never = options.provider;
      throw new Error(`Unhandled provider ${String(exhaustive)}`);
    }
  }
}
