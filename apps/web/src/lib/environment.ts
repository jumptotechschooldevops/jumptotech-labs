import type { EnvironmentInfo } from './types';

/**
 * One line describing the live environment, built from whatever the provider
 * actually reported.
 *
 * Deliberately not a switch on the track name: a Kubernetes sandbox reports a
 * cluster version and nodes, a Linux sandbox reports an image and a kernel, and
 * a future provider that reports neither still gets an honest line naming
 * itself rather than a mislabelled one.
 */
export function describeEnvironment(environment: EnvironmentInfo): string {
  const parts: string[] = [environment.provider];

  if (environment.kubernetesVersion) parts.push(environment.kubernetesVersion);
  if (environment.nodes) {
    const count = environment.nodes.length;
    parts.push(`${count} node${count === 1 ? '' : 's'}`);
  }
  if (environment.image) parts.push(environment.image);
  if (environment.osRelease) parts.push(environment.osRelease);

  return parts.join(' · ');
}
