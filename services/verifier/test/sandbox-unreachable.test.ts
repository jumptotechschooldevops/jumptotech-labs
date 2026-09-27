/**
 * A container sandbox the platform could not read is not a failed lab.
 *
 * `verifyLab` turns an unreadable environment into ENVIRONMENT_UNREACHABLE with
 * every check skipped — the shape the API answers, the UI words as "could not
 * be read", and `jtt_verification_errors_total` counts. It recognised only the
 * Kubernetes, Docker-track and workspace transport errors, so the verifier's
 * *own* `SandboxUnreachableError` (a `ps`/`ss`/`ip neigh` that could not run)
 * and the container runtime's `ContainerRuntimeError` (the broker unreachable,
 * an exec it refused) escaped it, and `POST /api/sessions/:id/check` answered
 * 500 INTERNAL_ERROR with no skipped checks and no verification-error metric.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ContainerRuntimeError,
  loadLabDefinition,
  type LabDefinition,
} from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LINUX_005 = path.resolve(here, '../../../labs/linux/linux-005-services/lab.yaml');
const SANDBOX = 'jtt-lab-000000000005';

let lab: LabDefinition;
beforeAll(async () => {
  lab = await loadLabDefinition(LINUX_005);
});

function expectUnreachable(result: Awaited<ReturnType<typeof verifyLab>>): void {
  expect(result.passed).toBe(false);
  expect(result.error?.code).toBe('ENVIRONMENT_UNREACHABLE');
  expect(result.checks.length).toBeGreaterThan(0);
  expect(result.checks.every((c) => c.status === 'skipped')).toBe(true);
}

describe('verifyLab — a container sandbox that cannot be read', () => {
  it('reports ENVIRONMENT_UNREACHABLE when the process table cannot be read', async () => {
    const sandbox = new FakeSandbox({
      commands: {
        'ps -eo pid=,user=,args=': { exitCode: 1, stderr: 'Error response from daemon: container is not running' },
      },
    });

    const result = await verifyLab({ lab, namespace: SANDBOX, sandbox });

    expectUnreachable(result);
    expect(result.error?.message).toMatch(/not running/);
  });

  it('reports ENVIRONMENT_UNREACHABLE when the container runtime refuses a read', async () => {
    const sandbox = new FakeSandbox();
    sandbox.read = async () => {
      throw new ContainerRuntimeError('runtime broker unreachable: connect ECONNREFUSED');
    };

    const result = await verifyLab({ lab, namespace: SANDBOX, sandbox });

    expectUnreachable(result);
    expect(result.error?.message).toMatch(/ECONNREFUSED/);
  });

  it('still lets a genuine defect escape as one', async () => {
    const sandbox = new FakeSandbox();
    sandbox.read = async () => {
      throw new TypeError('cannot read properties of undefined');
    };

    await expect(verifyLab({ lab, namespace: SANDBOX, sandbox })).rejects.toThrow(TypeError);
  });
});
