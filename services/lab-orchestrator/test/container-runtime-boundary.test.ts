/**
 * The daemon boundary refuses a sandbox spec that would stop being a sandbox.
 *
 * `sandboxd` holds the Docker socket and forwards the API's `ContainerSpec` for
 * a runtime `create` to `DockerCliRuntime`. Before this check the image, name
 * and capabilities were validated there but `network`, `pidsLimit`, `memory`
 * and `cpus` reached `docker run` as given, so a caller holding the runtime
 * scope — or an operator's typo in `SANDBOX_NETWORK` / `SANDBOX_PIDS_LIMIT` —
 * could produce `--network host`, `--network container:<another sandbox>`, or
 * an unlimited `--pids-limit 0`. No `docker` binary is run: argv is captured.
 */
import { describe, expect, it } from 'vitest';
import {
  ContainerRuntimeError,
  DockerCliRuntime,
  execFileOutcome,
  type ContainerSpec,
} from '../src/providers/container/runtime.js';

const NAME = 'jtt-lab-0123456789abcdef';

function spec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: NAME,
    image: 'jumptotech/lab-linux:latest',
    labels: { 'jumptotech.io/managed': 'true' },
    user: 'student',
    workdir: '/home/student',
    cpus: '0.5',
    memory: '512m',
    pidsLimit: 128,
    network: 'none',
    hostname: 'lab',
    command: ['sleep', 'infinity'],
    ...overrides,
  };
}

function runtime() {
  const calls: string[][] = [];
  const cli = new DockerCliRuntime({
    run: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'inspect') {
        return {
          exitCode: 0,
          stdout: `id\trunning\tjumptotech/lab-linux:latest\t{"jumptotech.io/managed":"true"}\n`,
          stderr: '',
          timedOut: false,
        };
      }
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    },
  });
  return { cli, calls, ran: () => calls.some((argv) => argv[0] === 'run') };
}

describe('container runtime create — network', () => {
  it.each(['none', 'jumptotech-sandboxes', 'jtt-net-0123456789abcdef'])('accepts %s', async (network) => {
    const { cli, calls } = runtime();
    await cli.create(spec({ network }));
    const run = calls.find((argv) => argv[0] === 'run')!;
    expect(run[run.indexOf('--network') + 1]).toBe(network);
  });

  it.each([
    'host',
    'HOST',
    'container:jtt-lab-fedcba9876543210',
    'container:jumptotech-labs-api-1',
    'ns:/proc/1/ns/net',
    '',
    '--privileged',
  ])('refuses %j before docker is run', async (network) => {
    const { cli, ran } = runtime();
    await expect(cli.create(spec({ network }))).rejects.toBeInstanceOf(ContainerRuntimeError);
    expect(ran()).toBe(false);
  });
});

describe('container runtime create — resource ceilings', () => {
  it.each([
    { pidsLimit: 0 },
    { pidsLimit: -1 },
    { pidsLimit: 1.5 },
    { memory: '0' },
    { memory: '0m' },
    { memory: '-1' },
    { memory: 'unlimited' },
    { cpus: '0' },
    { cpus: '0.0' },
    { cpus: '-1' },
    { cpus: 'all' },
  ])('refuses an unbounded or malformed ceiling: %j', async (ceiling) => {
    const { cli, ran } = runtime();
    await expect(cli.create(spec(ceiling as Partial<ContainerSpec>))).rejects.toBeInstanceOf(ContainerRuntimeError);
    expect(ran()).toBe(false);
  });

  it('passes a valid set of ceilings through unchanged', async () => {
    const { cli, calls } = runtime();
    await cli.create(spec({ cpus: '2', memory: '2g', pidsLimit: 512 }));
    const run = calls.find((argv) => argv[0] === 'run')!;
    expect(run[run.indexOf('--cpus') + 1]).toBe('2');
    expect(run[run.indexOf('--memory') + 1]).toBe('2g');
    expect(run[run.indexOf('--pids-limit') + 1]).toBe('512');
    expect(run).toContain('--cap-drop');
  });
});

describe('execFileOutcome — how a runner reads a finished child process', () => {
  // Node's shape for a command killed at its `timeout` (measured, Node 22):
  // { code: null, killed: true, signal: 'SIGTERM', message: 'Command failed: …' }.
  it('reports a command killed at its time limit as timed out', () => {
    expect(execFileOutcome(Object.assign(new Error('Command failed: docker exec'), { code: null, killed: true, signal: 'SIGTERM' }))).toEqual({
      exitCode: 1,
      timedOut: true,
    });
  });

  it('keeps a real exit code, and does not call it a timeout', () => {
    expect(execFileOutcome(Object.assign(new Error('Command failed'), { code: 126, killed: false }))).toEqual({ exitCode: 126, timedOut: false });
  });

  it('reports success as exit 0', () => {
    expect(execFileOutcome(null)).toEqual({ exitCode: 0, timedOut: false });
    expect(execFileOutcome(null, { killed: false })).toEqual({ exitCode: 0, timedOut: false });
  });

  /*
   * Measured with Docker CLI 28.4.0 on Node 22: a `docker exec` killed at its
   * `timeout` catches the SIGTERM and exits 0, so the callback gets no error
   * at all — only the child's own `killed` says Node stopped it. Read from the
   * error alone, a hung `script_runs` or `command_exit_code` expecting 0
   * PASSED, and its process stayed behind in the sandbox for every Check.
   */
  it('reports a child Node killed at its time limit as timed out, even when it exited 0', () => {
    expect(execFileOutcome(null, { killed: true })).toEqual({ exitCode: 124, timedOut: true });
  });

  it('does not call output over the buffer cap a timeout, although Node kills that child too', () => {
    const overflow = Object.assign(new RangeError('stdout maxBuffer length exceeded'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
    expect(execFileOutcome(overflow, { killed: true })).toEqual({ exitCode: 1, timedOut: false });
  });
});

/*
 * `inspect` answers "is this sandbox there", and End, Reset and the attach
 * gates act on the answer. It returned null — "absent" — for any failure, so a
 * daemon that was down, or an inspect that timed out, read as a sandbox already
 * gone: End recorded ENDED and released the slot with the container, its peer
 * and its network still running. Both cases below exit 1 on Docker 28.4.0;
 * only the words differ (captured from the real CLI).
 */
describe('container runtime inspect — absent is not unreachable', () => {
  function answering(result: { exitCode: number; stderr: string; timedOut?: boolean }) {
    return new DockerCliRuntime({
      run: async () => ({ stdout: '', timedOut: false, ...result }),
    });
  }

  it('reads "No such container" as absent', async () => {
    const cli = answering({ exitCode: 1, stderr: `Error response from daemon: No such container: ${NAME}\n` });
    await expect(cli.inspect(NAME)).resolves.toBeNull();
  });

  it('reads an unreachable daemon as an error', async () => {
    const cli = answering({
      exitCode: 1,
      stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
    });
    await expect(cli.inspect(NAME)).rejects.toBeInstanceOf(ContainerRuntimeError);
  });

  it('reads an inspect that timed out as an error', async () => {
    const cli = answering({ exitCode: 124, stderr: '', timedOut: true });
    await expect(cli.inspect(NAME)).rejects.toBeInstanceOf(ContainerRuntimeError);
  });
});
