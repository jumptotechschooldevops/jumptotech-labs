/**
 * A sandbox the runtime could not read is not a sandbox with nothing in it.
 *
 * Every filesystem read of a container lab is a `docker exec` of `stat`, `cat`
 * or `find`, and Docker 28.4.0 exits 1 both when `stat` finds no file and when
 * the exec never ran: the container stopped, removed, the daemon down (measured
 * against the real CLI; only the words differ). The provider read every
 * non-zero exit as "not there", so during an outage `path_absent` PASSED,
 * `file_exists` failed the student with "No file found", and the Check was
 * recorded as an ordinary verdict rather than an environment error. The
 * process and socket reads already refused to guess, but their refusal
 * escaped `verifyLab` and became HTTP 500.
 *
 * The runtime here is the real `LinuxLabProvider` over an exec that answers
 * with Docker's own words.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_POLICY,
  LinuxLabProvider,
  type ContainerExecResult,
  type LabRegistry,
  type LabSessionContext,
  type LoadedLabDefinition,
} from '@jumptotech/lab-orchestrator';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { verifyLab } from '../src/index.js';
import type { SandboxPort } from '../src/sandbox-reader.js';

const SANDBOX = 'jtt-lab-000000000001';
const SESSION = 'sess-000000000000000a';

const RUNTIME_FAILURES: Record<string, ContainerExecResult> = {
  'a stopped container': {
    exitCode: 1,
    stdout: '',
    stderr: `Error response from daemon: container 8201393a82df is not running\n`,
    timedOut: false,
  },
  'a removed container': {
    exitCode: 1,
    stdout: '',
    stderr: `Error response from daemon: No such container: ${SANDBOX}\n`,
    timedOut: false,
  },
  'a daemon that is down': {
    exitCode: 1,
    stdout: '',
    stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
    timedOut: false,
  },
  'an exec that timed out': { exitCode: 124, stdout: '', stderr: '', timedOut: true },
};

let registry: LabRegistry;
beforeAll(async () => {
  registry = await realCatalog();
});

function checking(requirements: unknown[]): LoadedLabDefinition {
  return { ...registry.get('LINUX-001'), requirements } as unknown as LoadedLabDefinition;
}

function sandboxAnswering(answer: (argv: readonly string[]) => ContainerExecResult): SandboxPort {
  const runtime = new Proxy(
    {},
    { get: (_target, property) => (property === 'exec' ? async (_name: string, request: { argv: string[] }) => answer(request.argv) : undefined) },
  );
  const provider = new LinuxLabProvider({ runtime: runtime as never });
  const context: LabSessionContext = {
    sessionId: SESSION,
    labId: 'LINUX-001',
    sandboxRef: SANDBOX,
    namespace: SANDBOX,
    serviceAccountName: 'student',
    lab: registry.get('LINUX-001'),
    expiresAtMs: Date.now() + 3_600_000,
    policy: DEFAULT_SESSION_POLICY,
  };
  return {
    read: (path, options) => provider.readSandboxPath(context, path, options),
    list: (dir, options) => provider.listSandboxFiles(context, dir, options),
    inspect: (command, args, options) => provider.inspectSandbox(context, command, args, options),
  };
}

describe('a sandbox the runtime could not read', () => {
  it.each(Object.keys(RUNTIME_FAILURES))('is an environment error, not a verdict, for %s', async (failure) => {
    const result = await verifyLab({
      lab: checking([
        { type: 'path_absent', path: 'scratch/tmp.log' },
        { type: 'file_exists', path: 'notes.txt' },
      ]),
      namespace: SANDBOX,
      sandbox: sandboxAnswering(() => RUNTIME_FAILURES[failure]!),
    });

    expect(result.passed).toBe(false);
    expect(result.error?.code).toBe('ENVIRONMENT_UNREACHABLE');
    expect(result.checks.map((check) => check.status)).toEqual(['skipped', 'skipped']);
  });

  it.each(Object.keys(RUNTIME_FAILURES))('reports a process read that failed for %s, instead of throwing', async (failure) => {
    const result = await verifyLab({
      lab: checking([{ type: 'process_not_running', pattern: 'nginx' }]),
      namespace: SANDBOX,
      sandbox: sandboxAnswering(() => RUNTIME_FAILURES[failure]!),
    });

    expect(result.error?.code).toBe('ENVIRONMENT_UNREACHABLE');
    expect(result.checks.map((check) => check.status)).toEqual(['skipped']);
  });

  it('still reads a file that is genuinely missing as absent', async () => {
    const result = await verifyLab({
      lab: checking([
        { type: 'path_absent', path: 'scratch/tmp.log' },
        { type: 'file_exists', path: 'notes.txt' },
      ]),
      namespace: SANDBOX,
      sandbox: sandboxAnswering((argv) => ({
        exitCode: 1,
        stdout: '',
        stderr: `stat: cannot statx '${argv.at(-1) ?? ''}': No such file or directory\n`,
        timedOut: false,
      })),
    });

    expect(result.error).toBeUndefined();
    expect(result.checks.map((check) => check.status)).toEqual(['pass', 'fail']);
  });
});
