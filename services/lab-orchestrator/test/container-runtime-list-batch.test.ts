/**
 * `DockerCliRuntime.list` costs a fixed number of processes, not one per container.
 *
 * `list` ran `docker ps` and then one `docker inspect` process per container,
 * one after another. It is called by every container provider on every reaper
 * sweep (once a minute each) and by sandboxd on every metrics scrape (the
 * managed-container gauges, at most every five seconds). Its selector is
 * `jumptotech.io/managed=true` and is filtered to this runtime owner only
 * afterwards, so every managed container on the daemon was inspected in its own
 * process. With 30 containers and four container providers that is ~124
 * sequential `docker` processes per sweep plus 31 per scrape, a steady load
 * that grows with every student. Measured on a loaded five-student run: the
 * broker's `list` op averaged 9.2 s.
 *
 * `docker inspect` takes many names in one call. The contract is unchanged:
 * a name that vanished between `ps` and `inspect` is simply absent, a timeout
 * or any other daemon failure throws, and results keep the `ps` order.
 */
import { describe, expect, it } from 'vitest';
import { ContainerRuntimeError, DockerCliRuntime } from '../src/providers/container/runtime.js';
import type { ContainerExecResult } from '../src/providers/container/runtime.js';

const SELECTOR = 'jumptotech.io/managed=true';

function names(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `jtt-lab-${i.toString(16).padStart(12, '0')}`);
}

/** One inspect line, with the name column only when the format asks for it. */
function inspectLine(name: string, withName: boolean, state = 'running'): string {
  return `${withName ? `/${name}\t` : ''}sha256:${name}\t${state}\tjumptotech/lab-linux:latest\t${JSON.stringify({
    'jumptotech.io/managed': 'true',
    'jumptotech.io/session-id': `sess-${name.slice(-12)}`,
  })}`;
}

/** A fake docker CLI over a fixed set of containers, counting every process. */
function fakeDocker(containers: string[], opts: { vanished?: string[]; inspectOutcome?: Partial<ContainerExecResult> } = {}) {
  const calls: string[][] = [];
  const cli = new DockerCliRuntime({
    run: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'ps') return { exitCode: 0, stdout: `${containers.join('\n')}\n`, stderr: '', timedOut: false };
      if (argv[0] === 'inspect') {
        if (opts.inspectOutcome) return { exitCode: 1, stdout: '', stderr: '', timedOut: false, ...opts.inspectOutcome };
        const format = argv[argv.indexOf('--format') + 1] ?? '';
        const withName = format.startsWith('{{.Name}}');
        const asked = argv.slice(argv.indexOf('--format') + 2);
        const present = asked.filter((n) => !opts.vanished?.includes(n));
        const missing = asked.filter((n) => opts.vanished?.includes(n));
        return {
          exitCode: missing.length ? 1 : 0,
          stdout: present.map((n) => `${inspectLine(n, withName)}\n`).join(''),
          stderr: missing.map((n) => `Error: No such container: ${n}\n`).join(''),
          timedOut: false,
        };
      }
      throw new Error(`unexpected docker ${argv.join(' ')}`);
    },
  });
  return { cli, calls };
}

describe('DockerCliRuntime.list', () => {
  it('inspects thirty containers in one process, not thirty', async () => {
    const { cli, calls } = fakeDocker(names(30));
    const found = await cli.list(SELECTOR);
    expect(found).toHaveLength(30);
    expect(calls.filter((c) => c[0] === 'inspect')).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('keeps the listing order and every field', async () => {
    const all = names(3).reverse();
    const { cli } = fakeDocker(all);
    const found = await cli.list(SELECTOR);
    expect(found.map((c) => c.name)).toEqual(all);
    expect(found[0]).toMatchObject({
      name: all[0],
      id: `sha256:${all[0]}`,
      state: 'running',
      image: 'jumptotech/lab-linux:latest',
      labels: { 'jumptotech.io/managed': 'true' },
    });
  });

  it('asks nothing more when there is nothing to inspect', async () => {
    const { cli, calls } = fakeDocker([]);
    await expect(cli.list(SELECTOR)).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('never passes a name that is not a managed sandbox reference to inspect', async () => {
    const { cli, calls } = fakeDocker(['jtt-lab-000000000001', 'somebody-elses-container', '--format=x']);
    const found = await cli.list(SELECTOR);
    expect(found.map((c) => c.name)).toEqual(['jtt-lab-000000000001']);
    const inspect = calls.find((c) => c[0] === 'inspect')!;
    expect(inspect).not.toContain('somebody-elses-container');
    expect(inspect).not.toContain('--format=x');
  });

  it('treats a container removed between ps and inspect as absent', async () => {
    const all = names(4);
    const { cli } = fakeDocker(all, { vanished: [all[1]!, all[3]!] });
    const found = await cli.list(SELECTOR);
    expect(found.map((c) => c.name)).toEqual([all[0], all[2]]);
  });

  it('throws when inspect ran out of time, as a single inspect does', async () => {
    const { cli } = fakeDocker(names(2), { inspectOutcome: { exitCode: 124, timedOut: true } });
    await expect(cli.list(SELECTOR)).rejects.toThrow(ContainerRuntimeError);
  });

  it('throws when the daemon fails for a reason other than absence', async () => {
    const { cli } = fakeDocker(names(2), {
      inspectOutcome: { stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.' },
    });
    await expect(cli.list(SELECTOR)).rejects.toThrow(/Cannot connect to the Docker daemon/);
  });

  it('splits a very long listing into bounded batches', async () => {
    const { cli, calls } = fakeDocker(names(250));
    const found = await cli.list(SELECTOR);
    expect(found).toHaveLength(250);
    const inspects = calls.filter((c) => c[0] === 'inspect');
    expect(inspects.length).toBeGreaterThan(1);
    expect(inspects.length).toBeLessThanOrEqual(5);
  });
});
