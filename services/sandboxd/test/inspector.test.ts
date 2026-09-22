/**
 * What an inspect failure means.
 *
 * Only the runtime's own "no such container" is an answer about the container.
 * A daemon that is down, restarting, slow or refusing TLS says nothing about
 * it — and read as "no sandbox" it told a student their lab had none, a
 * refusal the web client never retries, counted as an ownership refusal.
 * `execFile` is stubbed: no host process is started.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `killed` is what Node records when it stopped the child at its time limit.
const reply = vi.hoisted(() => ({ code: 0, stdout: '', stderr: '', killed: false }));

vi.mock('node:child_process', () => ({
  execFile: (
    _binary: string,
    _argv: string[],
    _options: unknown,
    callback: (error: { code: number | null; killed?: boolean } | null, stdout: string, stderr: string) => void,
  ) => {
    const child = { killed: reply.killed };
    // Asynchronous, as the real callback is: the caller holds `child` by then.
    queueMicrotask(() => {
      const error = reply.code === 0 ? null : { code: reply.code, killed: reply.killed };
      callback(error, reply.stdout, reply.stderr);
    });
    return child;
  },
}));

const { DockerSandboxInspector, InspectorUnavailableError } = await import('../src/inspector.js');

const REF = 'jtt-lab-0123456789abcdef';

beforeEach(() => {
  reply.code = 0;
  reply.stdout = '';
  reply.stderr = '';
  reply.killed = false;
});

describe('DockerSandboxInspector.inspect', () => {
  it.each(['Error: No such container: ' + REF, 'Error: No such object: ' + REF])('reads "%s" as no sandbox', async (stderr) => {
    reply.code = 1;
    reply.stderr = stderr;
    expect(await new DockerSandboxInspector().inspect(REF)).toBeNull();
  });

  it.each([
    'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    'error during connect: Get "https://sandbox-runtime:2376/v1.47/containers/json": tls: bad certificate',
    '',
  ])('throws, rather than answering "no sandbox", on "%s"', async (stderr) => {
    reply.code = 1;
    reply.stderr = stderr;
    await expect(new DockerSandboxInspector().inspect(REF)).rejects.toBeInstanceOf(InspectorUnavailableError);
  });

  // Docker CLI 28.4.0 catches the SIGTERM sent at the limit and exits 0 with
  // nothing on stdout — which, read by exit code alone, was "no sandbox".
  it('throws unavailable, not "no sandbox", for an inspect stopped at its limit that exited 0', async () => {
    reply.killed = true;
    await expect(new DockerSandboxInspector().inspect(REF)).rejects.toBeInstanceOf(InspectorUnavailableError);
  });

  it('throws unavailable for a timed-out inspect even if its stderr says "no such container"', async () => {
    reply.code = 1;
    reply.killed = true;
    reply.stderr = 'Error: No such container: ' + REF;
    await expect(new DockerSandboxInspector().inspect(REF)).rejects.toBeInstanceOf(InspectorUnavailableError);
  });

  it('reads a container', async () => {
    reply.stdout = 'running\tstudent\t/home/student\t{"jumptotech.io/managed":"true"}\n';
    expect(await new DockerSandboxInspector().inspect(REF)).toEqual({
      state: 'running',
      user: 'student',
      workdir: '/home/student',
      labels: { 'jumptotech.io/managed': 'true' },
    });
  });
});

describe('DockerSandboxInspector.ping', () => {
  it('throws for a `docker version` stopped at its limit that exited 0', async () => {
    reply.killed = true;
    await expect(new DockerSandboxInspector().ping()).rejects.toThrow(/did not answer in time/);
  });

  it('returns the server version', async () => {
    reply.stdout = '28.4.0\n';
    expect(await new DockerSandboxInspector().ping()).toBe('28.4.0');
  });
});
