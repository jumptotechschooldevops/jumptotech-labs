import type { EnvironmentInfo } from './types';

/**
 * The one-line "what am I connected to?" caption.
 *
 * The provider writes `summary`, so this stays true for any sandbox kind
 * without the UI knowing which kinds exist. The Kubernetes-shaped fallback is
 * kept for a server that predates the field — not as a branch on track.
 */
export function describeEnvironment(environment: EnvironmentInfo): string {
  if (environment.summary) return `${environment.provider} · ${environment.summary}`;
  if (environment.kubernetesVersion || environment.nodes) {
    const nodeCount = environment.nodes?.length ?? 0;
    return `${environment.provider} · ${environment.kubernetesVersion ?? 'k8s'} · ${nodeCount} node${nodeCount === 1 ? '' : 's'}`;
  }
  return environment.provider;
}
