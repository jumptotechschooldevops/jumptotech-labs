/**
 * `DockerCliRuntime.inspect` / `networkInspect` — "absent" is an answer, a
 * failure to ask is not.
 *
 * `null` means the container (or network) does not exist, and callers act on
 * it: `destroySandbox` records "already absent" and reports the sandbox gone,
 * `status()` reports `not_created`, and sandboxd answers 404 SANDBOX_NOT_FOUND.
 * Any non-zero exit used to be that `null` — so a daemon that was down, a
 * restart, or an inspect that ran past its deadline under load told End its
 * sandbox was already released while the container kept running.
 *
 * The rule is the one sandboxd's own inspector and the Docker-track CLI client
 * already follow: only the daemon's "No such …" is absence; a timeout or any
 * other failure throws `ContainerRuntimeError`.
 */
import { describe, expect, it } from 'vitest';
import { LinuxLabProvider } from '../src/index.js';
import { ContainerRuntimeError, DockerCliRuntime } from '../src/providers/container/runtime.js';
import type { ContainerExecResult } from '../src/providers/container/runtime.js';

const NAME = 'jtt-lab-0123456789abcdef';
const NETWORK = 'jtt-net-0123456789abcdef';

function runtimeAnswering(outcome: Partial<ContainerExecResult>): DockerCliRuntime {
  return new DockerCliRuntime({
    run: async () => ({ exitCode: 1, stdout: '', stderr: '', timedOut: false, ...outcome }),
  });
}

const DAEMON_DOWN =
  'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';

describe('DockerCliRuntime.inspect', () => {
  it('reports a container the daemon says does not exist as absent', async () => {
    const cli = runtimeAnswering({ stderr: `Error: No such container: ${NAME}` });
    await expect(cli.inspect(NAME)).resolves.toBeNull();
  });

  it('reports "no such object" as absent', async () => {
    const cli = runtimeAnswering({ stderr: `Error: No such object: ${NAME}` });
    await expect(cli.inspect(NAME)).resolves.toBeNull();
  });

  it('throws, rather than reporting absent, when the daemon is down', async () => {
    const cli = runtimeAnswering({ stderr: DAEMON_DOWN });
    await expect(cli.inspect(NAME)).rejects.toThrow(ContainerRuntimeError);
    await expect(cli.inspect(NAME)).rejects.toThrow(/Cannot connect to the Docker daemon/);
  });

  it('throws, rather than reporting absent, when inspect ran out of time', async () => {
    const cli = runtimeAnswering({ exitCode: 124, timedOut: true });
    await expect(cli.inspect(NAME)).rejects.toThrow(ContainerRuntimeError);
  });

  it('throws when the CLI failed with nothing on stderr', async () => {
    const cli = runtimeAnswering({ exitCode: 1, stderr: '' });
    await expect(cli.inspect(NAME)).rejects.toThrow(/exited with code 1/);
  });
});

describe('DockerCliRuntime.networkInspect', () => {
  it('reports a network the daemon says does not exist as absent', async () => {
    const cli = runtimeAnswering({ stderr: `Error response from daemon: network ${NETWORK} not found` });
    await expect(cli.networkInspect(NETWORK)).resolves.toBeNull();
  });

  it('throws, rather than reporting absent, when the daemon is down', async () => {
    const cli = runtimeAnswering({ stderr: DAEMON_DOWN });
    await expect(cli.networkInspect(NETWORK)).rejects.toThrow(ContainerRuntimeError);
  });

  it('throws, rather than reporting absent, when inspect ran out of time', async () => {
    const cli = runtimeAnswering({ exitCode: 124, timedOut: true });
    await expect(cli.networkInspect(NETWORK)).rejects.toThrow(ContainerRuntimeError);
  });
});

describe('a teardown during a daemon outage', () => {
  it('is not reported as a released sandbox', async () => {
    const provider = new LinuxLabProvider({ runtime: runtimeAnswering({ stderr: DAEMON_DOWN }) });

    const result = await provider.destroySandbox(NAME, 'sess-00000000000000ff');

    // Before: ok, namespaceGone, "already absent" — End freed the slot while
    // the container kept running.
    expect(result.ok).toBe(false);
    expect(result.namespaceGone).toBe(false);
  });
});
