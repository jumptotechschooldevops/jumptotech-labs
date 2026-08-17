/**
 * Provider selection.
 *
 * Adding a sandbox backend later (EKS, Firecracker, gVisor …) means adding a
 * case here and implementing `LabProvider`. No API route, verifier rule, or
 * React component changes.
 *
 * Two axes meet in this file and it is worth keeping them apart:
 *
 *   - **`SupportedProvider`** is an *implementation*: `kind`, `ansible-docker`.
 *     It is what an operator configures.
 *   - **`environment.provider`** in a lab.yaml is a *substrate*: `kubernetes`,
 *     `ansible`. It is what a lab author declares.
 *
 * `createProviderRouter` binds the two, producing the single `LabProvider` the
 * session manager holds.
 */
import { KubernetesClient } from '../k8s/client.js';
import type { KubernetesPort } from '../k8s/port.js';
import type { LabProvider } from '../types.js';
import type { DockerPort } from '../ansible/docker-port.js';
import { DockerCli } from '../ansible/docker-cli.js';
import { KindLabProvider, type RequirementWaiter } from './kind-provider.js';
import {
  AnsibleDockerProvider,
  type AnsibleSandboxLimits,
} from './ansible-docker-provider.js';
import { CompositeLabProvider } from './composite-provider.js';

export const SUPPORTED_PROVIDERS = ['kind', 'ansible-docker'] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

/** The substrate keys a lab.yaml may declare. */
export const LAB_SUBSTRATES = ['kubernetes', 'ansible'] as const;
export type LabSubstrate = (typeof LAB_SUBSTRATES)[number];

export interface ProviderFactoryOptions {
  provider: string;
  clusterName: string;
  kubeconfigPath?: string;
  /** Injected in tests to avoid touching a real cluster. */
  k8s?: KubernetesPort;
  /** Injected in tests to avoid touching a real Docker daemon. */
  docker?: DockerPort;
  /** Sandbox node image for the Ansible track. */
  ansibleImage?: string;
  ansibleManagedNodeCount?: number;
  ansibleLimits?: AnsibleSandboxLimits;
  ansibleSshHost?: string;
  dockerBinary?: string;
  dockerHost?: string;
  /** Confirms a lab's declared initial state actually materialised. */
  waitForRequirements?: RequirementWaiter;
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

  switch (options.provider) {
    case 'kind':
      return createKindProvider(options);
    case 'ansible-docker':
      return createAnsibleProvider(options);
    default: {
      const exhaustive: never = options.provider;
      throw new Error(`Unhandled provider ${String(exhaustive)}`);
    }
  }
}

function createKindProvider(options: ProviderFactoryOptions): KindLabProvider {
  const k8s =
    options.k8s ??
    new KubernetesClient(options.kubeconfigPath ? { kubeconfigPath: options.kubeconfigPath } : {});

  return new KindLabProvider({
    k8s,
    clusterName: options.clusterName,
    ...(options.kubeconfigPath ? { kubeconfigPath: options.kubeconfigPath } : {}),
    ...(options.waitForRequirements ? { waitForRequirements: options.waitForRequirements } : {}),
  });
}

function createAnsibleProvider(options: ProviderFactoryOptions): AnsibleDockerProvider {
  const docker =
    options.docker ??
    new DockerCli({
      ...(options.dockerBinary ? { binary: options.dockerBinary } : {}),
      ...(options.dockerHost ? { dockerHost: options.dockerHost } : {}),
    });

  return new AnsibleDockerProvider({
    docker,
    image: options.ansibleImage ?? 'jumptotech/ansible-lab:local',
    ...(options.ansibleManagedNodeCount !== undefined
      ? { managedNodeCount: options.ansibleManagedNodeCount }
      : {}),
    ...(options.ansibleLimits ? { limits: options.ansibleLimits } : {}),
    ...(options.ansibleSshHost ? { sshHost: options.ansibleSshHost } : {}),
    ...(options.waitForRequirements ? { waitForRequirements: options.waitForRequirements } : {}),
  });
}

/**
 * Build the single provider the session manager holds.
 *
 * `substrates` names which tracks this deployment serves. A deployment with no
 * Docker daemon simply omits `ansible`, and Ansible labs then fail to start
 * with a clear message rather than half-provisioning.
 */
export function createProviderRouter(
  options: ProviderFactoryOptions & { substrates: readonly LabSubstrate[] },
): LabProvider {
  const delegates: Record<string, LabProvider> = {};

  for (const substrate of options.substrates) {
    switch (substrate) {
      case 'kubernetes':
        delegates.kubernetes = createKindProvider(options);
        break;
      case 'ansible':
        delegates.ansible = createAnsibleProvider(options);
        break;
      default: {
        const exhaustive: never = substrate;
        throw new Error(`Unknown lab substrate ${String(exhaustive)}`);
      }
    }
  }

  return new CompositeLabProvider(delegates);
}
