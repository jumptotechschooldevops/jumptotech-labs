/**
 * The leak alert's left-hand side: sessions among this owner's containers.
 * infrastructure/observability/prometheus/tests/sandbox-leak-alerts.test.yml
 * proves the rule built on it; this proves the count itself.
 */
import { describe, expect, it } from 'vitest';
import { CONTAINER_SESSION_LABEL, RUNTIME_OWNER_LABEL, type ContainerInfo } from '@jumptotech/lab-orchestrator';
import { distinctContainerSessions, ownedContainers } from '../src/container-accounting.js';

let next = 0;
const container = (labels: Record<string, string>): ContainerInfo => ({
  name: `jtt-lab-${(next += 1)}`,
  id: `id-${next}`,
  state: 'running',
  image: 'jumptotech/lab-linux:latest',
  labels,
});
const of = (session: string, owner = 'jumptotech') =>
  container({ [RUNTIME_OWNER_LABEL]: owner, [CONTAINER_SESSION_LABEL]: session });

describe('distinctContainerSessions', () => {
  it('counts an Ansible session of three containers once', () => {
    expect(distinctContainerSessions([of('s1'), of('s1'), of('s1')])).toBe(1);
  });

  it('counts five sessions of a mixed class as five, whatever each holds', () => {
    const containers = [of('ansible'), of('ansible'), of('ansible'), of('linux'), of('peer'), of('peer'), of('docker'), of('tf')];
    expect(distinctContainerSessions(containers)).toBe(5);
  });

  it('counts a container with no session on its own: nothing could account for it', () => {
    expect(distinctContainerSessions([of('s1'), container({ [RUNTIME_OWNER_LABEL]: 'jumptotech' }), container({})])).toBe(3);
  });

  it('is zero with no containers', () => {
    expect(distinctContainerSessions([])).toBe(0);
  });
});

describe('ownedContainers', () => {
  it("keeps only this runtime owner's containers", () => {
    const mine = of('s1');
    expect(ownedContainers([mine, of('s2', 'another-stack'), container({})], 'jumptotech')).toEqual([mine]);
  });
});
