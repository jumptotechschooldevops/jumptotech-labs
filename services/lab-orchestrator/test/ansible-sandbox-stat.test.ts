/**
 * `DockerAnsibleSandbox` path stats — "absent" is an answer, a failure to ask
 * is not.
 *
 * `exists: false` is what `managed_file_exists state: absent` passes on. Any
 * failed `stat` used to be that answer, so a managed node that was stopped, or
 * a stat stopped at its deadline under load, passed an "is absent" check with
 * nothing having been removed. Only stat's own "No such file or directory" /
 * "Not a directory" is absence; anything else is the environment being
 * unreadable, which the verifier reports as ENVIRONMENT_UNREACHABLE.
 */
import { describe, expect, it } from 'vitest';
import { DockerAnsibleSandbox, managedNodeNames } from '../src/index.js';
import type { AnsibleExecPort, AnsibleExecResult } from '../src/ansible/exec-port.js';

const SANDBOX = 'jtt-lab-0123456789abcdef';
const NODE = managedNodeNames(1)[0]!;
const PATH = '/etc/jumptotech/app.conf';

function sandboxAnswering(result: Partial<AnsibleExecResult>): DockerAnsibleSandbox {
  const docker: AnsibleExecPort = {
    async exec() {
      return { exitCode: 1, stdout: '', stderr: '', timedOut: false, ...result };
    },
    async inspectContainer() {
      return { running: true };
    },
  };
  return new DockerAnsibleSandbox({ docker });
}

describe('DockerAnsibleSandbox.statManagedPath', () => {
  it('reports a path stat says does not exist as absent', async () => {
    const sandbox = sandboxAnswering({ stderr: `stat: cannot statx '${PATH}': No such file or directory\n` });
    await expect(sandbox.statManagedPath(SANDBOX, NODE, PATH)).resolves.toMatchObject({ exists: false });
  });

  it('does not report a stopped node as an absent path', async () => {
    const sandbox = sandboxAnswering({ stderr: 'Error response from daemon: container is not running' });
    await expect(sandbox.statManagedPath(SANDBOX, NODE, PATH)).rejects.toMatchObject({
      code: 'ENVIRONMENT_UNREACHABLE',
    });
  });

  it('does not report a stat that ran out of time as an absent path', async () => {
    const sandbox = sandboxAnswering({ exitCode: 124, timedOut: true });
    await expect(sandbox.statManagedPath(SANDBOX, NODE, PATH)).rejects.toMatchObject({
      code: 'ENVIRONMENT_UNREACHABLE',
    });
  });
});

describe('DockerAnsibleSandbox.statWorkspacePath', () => {
  it('does not report an unsearchable workspace path as absent', async () => {
    const sandbox = sandboxAnswering({ stderr: "stat: cannot statx '/home/student/project/site.yml': Permission denied" });
    await expect(sandbox.statWorkspacePath(SANDBOX, 'site.yml')).rejects.toMatchObject({
      code: 'ENVIRONMENT_UNREACHABLE',
    });
  });
});
