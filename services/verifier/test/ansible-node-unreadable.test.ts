/**
 * An Ansible managed node the runtime could not reach is not a node where a
 * file is absent or a service stopped.
 *
 * The node reads (`stat`, `head`, `pgrep`) read every non-zero exit as "no",
 * and Docker exits 1 for an exec into a removed or stopped container just as
 * `stat` does for a missing file. With both managed nodes gone,
 * `managed_file_exists state: absent` (ANSIBLE-005's scheduler.lock) and
 * `managed_service_state expected: stopped` PASSED — "verified on node1,
 * node2" — while the present-file check blamed the student.
 */
import { describe, expect, it } from 'vitest';
import { DockerAnsibleSandbox, topologyFor, type LoadedLabDefinition } from '@jumptotech/lab-orchestrator';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { verifyLab } from '../src/index.js';

const SANDBOX = 'jtt-lab-000000000001';

function sandboxWith(answer: (container: string) => { exitCode: number; stderr: string; timedOut?: boolean }) {
  return new DockerAnsibleSandbox({
    docker: {
      async exec(spec: { container: string }) {
        return { stdout: '', timedOut: false, ...answer(spec.container) };
      },
      async inspectContainer() {
        return { running: true };
      },
    } as never,
    managedNodeCount: 2,
  });
}

async function lab(requirements: unknown[]): Promise<LoadedLabDefinition> {
  const registry = await realCatalog();
  return { ...registry.get('ANSIBLE-005'), requirements } as unknown as LoadedLabDefinition;
}

const NEGATIVE = [
  { type: 'managed_file_exists', path: '/etc/jumptotech/scheduler.lock', hosts: ['node2'], state: 'absent' },
  { type: 'managed_service_state', service: 'nginx', hosts: 'all', expected: 'stopped' },
];

describe('an Ansible managed node the runtime could not read', () => {
  const managed = new Set(topologyFor(SANDBOX, 2).managed.map((node) => node.container));

  it.each([
    ['removed', { exitCode: 1, stderr: 'Error response from daemon: No such container: x\n' }],
    ['stopped', { exitCode: 1, stderr: 'Error response from daemon: container abc is not running\n' }],
    ['timed out', { exitCode: 124, stderr: '', timedOut: true }],
  ] as const)('is an environment error when the nodes are %s', async (_what, failure) => {
    const result = await verifyLab({
      lab: await lab(NEGATIVE),
      namespace: SANDBOX,
      ansible: sandboxWith((container) => (managed.has(container) ? failure : { exitCode: 0, stderr: '' })),
    });

    expect(result.passed).toBe(false);
    expect(result.error?.code).toBe('ENVIRONMENT_UNREACHABLE');
    expect(result.checks.map((check) => check.status)).toEqual(['skipped', 'skipped']);
  });

  it('still reads a file that is genuinely missing, and a service that is genuinely stopped', async () => {
    const result = await verifyLab({
      lab: await lab(NEGATIVE),
      namespace: SANDBOX,
      ansible: sandboxWith(() => ({ exitCode: 1, stderr: "stat: cannot statx '/etc/jumptotech/scheduler.lock': No such file or directory\n" })),
    });

    expect(result.error).toBeUndefined();
    expect(result.checks.map((check) => check.status)).toEqual(['pass', 'pass']);
  });
});
