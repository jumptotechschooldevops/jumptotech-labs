/**
 * Kubernetes backend selection.
 *
 * This factory answers one narrow question: *which* Kubernetes substrate backs
 * the `kubernetes` provider — `kind` today, EKS later. It is not the place that
 * chooses between Kubernetes, Linux and Terraform; that is
 * [`ProviderRegistry`](registry.ts), driven by `environment.provider` in each
 * lab definition.
 *
 * Keeping the two separate is deliberate. `LAB_PROVIDER=kind` is a deployment
 * decision ("this install runs its Kubernetes labs on a local kind cluster");
 * `provider: kubernetes` in a lab is content metadata ("this lab needs a
 * Kubernetes sandbox"). Conflating them is what would force a frontend to know
 * about substrates. The Docker track is likewise not a Kubernetes substrate:
 * its provider is constructed and registered in the API composition root
 * (`apps/api/src/providers.ts`), like every other non-Kubernetes provider.
 */
import { KubernetesClient } from '../k8s/client.js';
import type { KubernetesPort } from '../k8s/port.js';
import type { LabProvider } from '../types.js';
import { KindLabProvider, type RequirementWaiter } from './kind-provider.js';

/** Kubernetes substrates this build can drive. */
export const SUPPORTED_PROVIDERS = ['kind'] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export interface ProviderFactoryOptions {
  provider: string;
  clusterName: string;
  kubeconfigPath?: string;
  /** Injected in tests to avoid touching a real cluster. */
  k8s?: KubernetesPort;
  /** Confirms a lab's declared initial state actually materialised. */
  waitForRequirements?: RequirementWaiter;
}

export function isSupportedProvider(value: string): value is SupportedProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

export function createLabProvider(options: ProviderFactoryOptions): LabProvider {
  if (!isSupportedProvider(options.provider)) {
    throw new Error(
      `Unknown LAB_PROVIDER '${options.provider}'. Supported Kubernetes substrates: ${SUPPORTED_PROVIDERS.join(', ')}`,
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
        ...(options.waitForRequirements ? { waitForRequirements: options.waitForRequirements } : {}),
      });
    default: {
      const exhaustive: never = options.provider;
      throw new Error(`Unhandled provider ${String(exhaustive)}`);
    }
  }
}
