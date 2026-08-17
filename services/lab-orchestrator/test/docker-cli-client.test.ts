/**
 * `DockerCliClient` — argv construction and daemon-response classification.
 *
 * Hermetic: every case injects a `CliRunner`, so no process is spawned and no
 * daemon is needed. What is *not* invented here is the daemon's wording — each
 * stderr string below is copied verbatim from a real Docker Engine, and
 * `docker-integration.test.ts` is what keeps them honest against a live daemon.
 *
 * The classification matters more than it looks. An absence that is not
 * recognised becomes a thrown `DockerCommandError`, and a throw inside
 * `verifyLab` aborts the whole run instead of reporting one failing check — so
 * a student whose network simply does not exist yet would see a broken
 * environment rather than "Network ledger-net does not exist".
 */
import { describe, expect, it } from 'vitest';
import {
  DockerCliClient,
  DockerCliFactory,
  DockerCommandError,
  DockerUnreachableError,
  type CliRunner,
} from '../src/index.js';

interface Call {
  binary: string;
  argv: string[];
}

/** A runner that records what it was asked to do and replays a scripted reply. */
function runner(
  reply: (argv: string[]) => Partial<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>,
): { run: CliRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: CliRunner = async (binary, argv) => {
    calls.push({ binary, argv });
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...reply(argv) };
  };
  return { run, calls };
}

/** Every reply the daemon gives when the named object is simply not there. */
const ABSENT_REPLIES = [
  { kind: 'container', stderr: 'Error response from daemon: No such container: web' },
  { kind: 'image', stderr: 'Error response from daemon: No such image: ledger:1.0' },
  { kind: 'volume', stderr: 'Error response from daemon: get ledger-data: no such volume' },
  // Networks are phrased differently from everything else, which is exactly
  // the case a fake engine cannot teach you about.
  { kind: 'network', stderr: 'Error response from daemon: network ledger-net not found' },
] as const;

describe('absence is a miss, not a failure', () => {
  for (const { kind, stderr } of ABSENT_REPLIES) {
    it(`reports a missing ${kind} as null rather than raising`, async () => {
      const { run } = runner(() => ({ exitCode: 1, stderr }));
      const client = new DockerCliClient({ run });

      const result =
        kind === 'container'
          ? await client.inspectContainer('web')
          : kind === 'image'
            ? await client.inspectImage('ledger:1.0')
            : kind === 'volume'
              ? await client.inspectVolume('ledger-data')
              : await client.inspectNetwork('ledger-net');

      expect(result).toBeNull();
    });
  }

  it('removing a network that is already gone is the desired end state', async () => {
    const { run } = runner(() => ({
      exitCode: 1,
      stderr: 'Error response from daemon: network ledger-net not found',
    }));
    // Reset re-enters teardown; a second removal must not fail the reset.
    await expect(new DockerCliClient({ run }).removeNetwork('ledger-net')).resolves.toBeUndefined();
  });

  it('a network still in use is refused, not mistaken for an absence', async () => {
    const { run } = runner(() => ({
      exitCode: 1,
      stderr: 'Error response from daemon: error while removing network: network ledger-net id abc has active endpoints',
    }));
    // Tolerated the same way: the container purge that precedes it decides order.
    await expect(new DockerCliClient({ run }).removeNetwork('ledger-net')).resolves.toBeUndefined();
  });

  it('a genuine daemon refusal is still raised', async () => {
    const { run } = runner(() => ({
      exitCode: 1,
      stderr: 'Error response from daemon: invalid reference format',
    }));
    await expect(new DockerCliClient({ run }).inspectImage('NOT A REF')).rejects.toBeInstanceOf(
      DockerCommandError,
    );
  });

  it('a daemon that is down is raised as unreachable, not as a missing object', async () => {
    const { run } = runner(() => ({
      exitCode: 1,
      stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    }));
    await expect(new DockerCliClient({ run }).inspectContainer('web')).rejects.toBeInstanceOf(
      DockerUnreachableError,
    );
  });
});

describe('commands are argv arrays, never command lines', () => {
  it('never hands a shell metacharacter anywhere but its own argv slot', async () => {
    const { run, calls } = runner(() => ({ stdout: 'deadbeef\n' }));
    await new DockerCliClient({ run }).runContainer({
      name: 'web',
      image: 'alpine:3.20',
      detach: true,
      command: ['sh', '-c', 'echo hi && rm -rf /'],
      env: { LEDGER_MODE: 'live; whoami' },
    });

    const argv = calls[0]?.argv ?? [];
    // The dangerous strings are single elements, not fragments of a line.
    expect(argv).toContain('echo hi && rm -rf /');
    expect(argv).toContain('LEDGER_MODE=live; whoami');
    expect(argv.join(' ')).not.toContain('--env LEDGER_MODE=live; whoami --');
  });

  it('places the container command after the image, where Docker stops parsing flags', async () => {
    const { run, calls } = runner(() => ({ stdout: 'id\n' }));
    await new DockerCliClient({ run }).runContainer({
      name: 'web',
      image: 'alpine:3.20',
      detach: true,
      command: ['sleep', '3600'],
    });

    const argv = calls[0]?.argv ?? [];
    expect(argv.indexOf('alpine:3.20')).toBeLessThan(argv.indexOf('sleep'));
    expect(argv.slice(argv.indexOf('alpine:3.20') + 1)).toEqual(['sleep', '3600']);
  });
});

describe('a session client can only ever address its own sandbox', () => {
  it('prefixes every call with an exec into that sandbox', async () => {
    const { run, calls } = runner(() => ({ stdout: '' }));
    const factory = new DockerCliFactory({ run });

    await factory.session('lab-0000000000aa').listContainers();

    expect(calls[0]?.argv.slice(0, 3)).toEqual(['exec', 'lab-0000000000aa', 'docker']);
  });

  it('refuses to address a container that is not a lab sandbox', () => {
    const { run } = runner(() => ({}));
    const factory = new DockerCliFactory({ run });

    // The one place a name becomes part of an argv is gated on the name shape,
    // so a caller holding an arbitrary container name cannot exec into it.
    expect(() => factory.session('postgres')).toThrow(/not a JumpToTech lab sandbox name/);
    expect(() => factory.session('lab-0000000000aa; rm -rf /')).toThrow(/not a JumpToTech/);
  });
});
