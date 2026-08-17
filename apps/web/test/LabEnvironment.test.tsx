/**
 * PLATFORM-LINUX-001 — the environment line on the lab page.
 *
 * One line, both tracks. It is built from whatever the provider actually
 * reported rather than from a switch on the track name, so a Kubernetes
 * session, a Linux session, and a future substrate that reports neither all get
 * an honest line instead of a mislabelled one.
 */
import { describe, expect, it } from 'vitest';
import { describeEnvironment } from '../src/lib/environment';
import type { EnvironmentInfo } from '../src/lib/types';

function environment(overrides: Partial<EnvironmentInfo>): EnvironmentInfo {
  return {
    environmentId: 'test',
    provider: 'test',
    phase: 'ready',
    namespace: 'lab-0000000000aa',
    ...overrides,
  };
}

describe('describeEnvironment', () => {
  it('describes a Kubernetes session by its cluster and nodes', () => {
    const line = describeEnvironment(
      environment({
        provider: 'kind',
        isolation: 'namespace',
        kubernetesVersion: 'v1.34.2',
        nodes: [{ name: 'control-plane', ready: true, roles: ['control-plane'], version: 'v1.34.2' }],
      }),
    );

    expect(line).toBe('kind · v1.34.2 · 1 node');
  });

  it('describes a Linux session by its image and kernel', () => {
    const line = describeEnvironment(
      environment({
        provider: 'linux',
        isolation: 'container',
        namespace: 'jtt-lnx-0000000000aa',
        image: 'jumptotech/linux-lab:0.1',
        osRelease: 'Linux 6.10.14-linuxkit',
      }),
    );

    expect(line).toBe('linux · jumptotech/linux-lab:0.1 · Linux 6.10.14-linuxkit');
    // Never borrows the other track's vocabulary for a container.
    expect(line).not.toContain('node');
    expect(line).not.toContain('k8s');
  });

  it('names a provider that reports nothing else, rather than inventing detail', () => {
    expect(describeEnvironment(environment({ provider: 'future-substrate' }))).toBe(
      'future-substrate',
    );
  });

  it('counts nodes in the plural only when there is more than one', () => {
    const nodes = [
      { name: 'a', ready: true, roles: [], version: 'v1.34.2' },
      { name: 'b', ready: true, roles: [], version: 'v1.34.2' },
    ];
    expect(describeEnvironment(environment({ provider: 'kind', nodes }))).toBe('kind · 2 nodes');
  });
});
