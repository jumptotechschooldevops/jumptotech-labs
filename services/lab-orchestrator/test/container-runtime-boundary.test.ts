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
  });
});
