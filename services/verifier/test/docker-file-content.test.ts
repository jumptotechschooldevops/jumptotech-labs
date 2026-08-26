/**
 * `docker_container_file_content` — the one Docker check that reads inside a
 * container.
 *
 * Three properties are asserted here, and they are the reasons the check was
 * built the way it was:
 *
 *   - **It reads, it does not execute.** The archive endpoint is used, so a
 *     stopped container grades identically to a running one. That is asserted
 *     directly, because it is the capability the exec-based alternative could
 *     not offer.
 *   - **It reads one file, never a tree.** A directory, a link, or an archive
 *     with more than one entry is refused rather than walked.
 *   - **It never discloses.** Neither the expected value nor the file's content
 *     may appear in a check result — including in the JSON the API serialises,
 *     which is asserted against the serialised form rather than the message.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryWorkspace,
  requirementSchema,
  type Requirement,
} from '@jumptotech/lab-orchestrator';
import { FakeDockerDaemon, containerSpec } from '@jumptotech/lab-orchestrator/testing';
import { readSingleFile, TarReadError } from '@jumptotech/lab-orchestrator/testing/tar';
import { DockerVerifyReader, MAX_CONTAINER_FILE_BYTES, verifyRequirement } from '../src/index.js';

const SANDBOX_A = 'jtt-lab-00000000000a';
const SANDBOX_B = 'jtt-lab-00000000000b';

function check(docker: FakeDockerDaemon, requirement: Requirement, sandbox = SANDBOX_A) {
  return verifyRequirement(requirement, new DockerVerifyReader(docker, sandbox));
}

const passed = (result: { status: string }) => result.status === 'pass';

/** A daemon holding one container with one file at /etc/app/config. */
function daemonWith(
  content: string | Buffer,
  options: { state?: string; path?: string; name?: string } = {},
) {
  const docker = new FakeDockerDaemon();
  const name = options.name ?? 'app';
  docker.addContainer(containerSpec({ name, image: 'alpine:3.20' }), options.state ?? 'running', 0);
  docker.putFile(name, options.path ?? '/etc/app/config', content);
  return docker;
}

const equals = (value: string, path = '/etc/app/config') =>
  ({ type: 'docker_container_file_content', container: 'app', path, equals: value }) as Requirement;

// --------------------------------------------------------------- the read

describe('docker_container_file_content — reading', () => {
  it('reads a file from a running container', async () => {
    expect(passed(await check(daemonWith('production\n'), equals('production')))).toBe(true);
  });

  it('reads a file from a STOPPED container, which is the point of the archive read', async () => {
    // The persistence and data-recovery labs destroy a container and read what
    // survived. An exec-based check could not answer this at all.
    const docker = daemonWith('posted\n', { state: 'exited' });
    expect(passed(await check(docker, equals('posted')))).toBe(true);
  });

  it('tolerates a trailing newline on either side, and nothing else', async () => {
    expect(passed(await check(daemonWith('live'), equals('live\n')))).toBe(true);
    expect(passed(await check(daemonWith('live\n'), equals('live')))).toBe(true);
    // Leading whitespace is a real difference, not an artefact.
    expect(passed(await check(daemonWith(' live\n'), equals('live')))).toBe(false);
  });

  it('reads one file once, however many checks ask about it', async () => {
    const docker = daemonWith('production\n');
    let reads = 0;
    const original = docker.copyFileFromContainer.bind(docker);
    docker.copyFileFromContainer = async (...args: Parameters<typeof original>) => {
      reads += 1;
      return original(...args);
    };
    const reader = new DockerVerifyReader(docker, SANDBOX_A);

    await verifyRequirement(equals('production'), reader);
    await verifyRequirement(
      { type: 'docker_container_file_content', container: 'app', path: '/etc/app/config', exists: true } as Requirement,
      reader,
    );
    expect(reads).toBe(1);
  });
});

// ------------------------------------------------------------- assertions

describe('docker_container_file_content — the four assertions', () => {
  it('grades exact content', async () => {
    expect(passed(await check(daemonWith('production\n'), equals('production')))).toBe(true);
    expect(passed(await check(daemonWith('staging\n'), equals('production')))).toBe(false);
  });

  it('grades required values with contains', async () => {
    const docker = daemonWith('mode=live\nregion=eu-west-1\n');
    const requirement = (values: string[]) =>
      ({
        type: 'docker_container_file_content',
        container: 'app',
        path: '/etc/app/config',
        contains: values,
      }) as Requirement;

    expect(passed(await check(docker, requirement(['mode=live', 'eu-west-1'])))).toBe(true);
    expect(passed(await check(docker, requirement(['mode=live', 'us-east-1'])))).toBe(false);
  });

  it('grades mere existence, and absence', async () => {
    const present = daemonWith('anything');
    const exists = { type: 'docker_container_file_content', container: 'app', path: '/etc/app/config', exists: true } as Requirement;
    const absent = { type: 'docker_container_file_content', container: 'app', path: '/etc/app/config', absent: true } as Requirement;

    expect(passed(await check(present, exists))).toBe(true);
    expect(passed(await check(present, absent))).toBe(false);

    const empty = new FakeDockerDaemon();
    empty.addContainer(containerSpec({ name: 'app', image: 'alpine:3.20' }));
    expect(passed(await check(empty, absent))).toBe(true);
    expect(passed(await check(empty, exists))).toBe(false);
  });

  it('requires exactly one assertion', () => {
    const base = { type: 'docker_container_file_content', container: 'app', path: '/etc/app/config' };
    expect(requirementSchema.safeParse(base).success).toBe(false);
    expect(requirementSchema.safeParse({ ...base, equals: 'x', exists: true }).success).toBe(false);
    expect(requirementSchema.safeParse({ ...base, equals: 'x' }).success).toBe(true);
  });
});

// ---------------------------------------------------------------- misses

describe('docker_container_file_content — absences and refusals', () => {
  it('separates a missing container from a missing file', async () => {
    const empty = new FakeDockerDaemon();
    const noContainer = await check(empty, equals('x'));
    expect(noContainer.status).toBe('fail');
    expect(noContainer.detail).toContain("No container named 'app'");

    const container = new FakeDockerDaemon();
    container.addContainer(containerSpec({ name: 'app', image: 'alpine:3.20' }));
    const noFile = await check(container, equals('x'));
    expect(noFile.status).toBe('fail');
    expect(noFile.detail).toContain('has no file at /etc/app/config');
  });

  it('refuses a directory instead of walking it', async () => {
    const docker = new FakeDockerDaemon();
    docker.addContainer(containerSpec({ name: 'app', image: 'alpine:3.20' }));
    docker.putFile('app', '/etc/app', '', { directory: true });

    const result = await check(docker, equals('x', '/etc/app'));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('directory');
  });

  it('refuses a file larger than the read limit rather than comparing a prefix', async () => {
    const big = 'x'.repeat(MAX_CONTAINER_FILE_BYTES + 1024);
    const result = await check(daemonWith(big), equals('x'));
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/larger than/);
    // The size is structural, so naming it is fine; the content is not quoted.
    expect(result.detail).not.toContain('xxxx');
  });

  it('refuses binary content rather than comparing mojibake', async () => {
    const result = await check(daemonWith(Buffer.from([0x00, 0x01, 0x02, 0xff])), equals('x'));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not text');
  });
});

// ------------------------------------------------------------ path safety

describe('docker_container_file_content — path validation', () => {
  const parse = (path: string) =>
    requirementSchema.safeParse({
      type: 'docker_container_file_content',
      container: 'app',
      path,
      exists: true,
    });

  it('rejects traversal, relative paths, and directory forms', () => {
    for (const path of [
      '../etc/shadow',
      '/var/lib/../../etc/shadow',
      '/etc/app/../../root/.ssh/id_rsa',
      'etc/app/config',
      '/etc//app',
      '/etc/app/',
      '/',
      '',
    ]) {
      expect(parse(path).success, JSON.stringify(path)).toBe(false);
    }
  });

  it('rejects every shell-shaped and option-shaped path', () => {
    for (const path of [
      '/etc/app; rm -rf /',
      '/etc/app && id',
      '/etc/app | tee /x',
      '/etc/$(whoami)',
      '/etc/`id`',
      '/etc/app config',
      "/etc/app'",
      '/etc/app"',
      '/etc/app\\x',
      '/--privileged',
      '/etc/-rf',
      '/etc/app\nrm',
      '/etc/café',
      `/${'a'.repeat(300)}`,
    ]) {
      expect(parse(path).success, JSON.stringify(path)).toBe(false);
    }
  });

  it('accepts the paths a lab legitimately needs', () => {
    for (const path of ['/etc/app/config', '/var/lib/ledger/txn.log', '/data/report.txt', '/a.b_c-d']) {
      expect(parse(path).success, path).toBe(true);
    }
  });

  it('rejects an unknown field, so a lab cannot widen the check', () => {
    expect(
      requirementSchema.safeParse({
        type: 'docker_container_file_content',
        container: 'app',
        path: '/etc/app/config',
        exists: true,
        command: 'cat /etc/shadow',
      }).success,
    ).toBe(false);
  });
});

// -------------------------------------------------------- non-disclosure

describe('docker_container_file_content — never discloses what it grades', () => {
  const SECRET = 'eu-west-1-ledger-prod-key';

  it('keeps the expected value out of a failing result, including its JSON', async () => {
    const docker = daemonWith('wrong-answer\n');
    const result = await check(docker, equals(SECRET));

    expect(result.status).toBe('fail');
    // The message a student reads.
    expect(result.detail ?? '').not.toContain(SECRET);
    // And the whole object the API serialises to the browser.
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('keeps the file content out of a failing result, including its JSON', async () => {
    const docker = daemonWith(`${SECRET}\n`);
    const result = await check(docker, equals('something-else'));

    expect(result.status).toBe('fail');
    expect(result.detail ?? '').not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('reports a contains miss by count, never by naming the values', async () => {
    const docker = daemonWith('mode=live\n');
    const result = await check(docker, {
      type: 'docker_container_file_content',
      container: 'app',
      path: '/etc/app/config',
      contains: ['mode=live', SECRET],
    } as Requirement);

    expect(result.status).toBe('fail');
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.detail).toContain('1 of the 2');
  });

  it('keeps the expectation out of the label too, since the label always renders', async () => {
    const result = await check(daemonWith('x\n'), equals(SECRET));
    expect(result.label).not.toContain(SECRET);
  });
});

// ------------------------------------------------------------- isolation

describe('docker_container_file_content — session isolation', () => {
  it('cannot read a container that belongs to another session', async () => {
    // Session B's daemon holds the file. Session A's does not, and A's reader is
    // constructed with A's daemon — there is no parameter that could reach B.
    const sessionB = daemonWith('production\n');
    const sessionA = new FakeDockerDaemon();

    expect(passed(await check(sessionB, equals('production'), SANDBOX_B))).toBe(true);

    const fromA = await check(sessionA, equals('production'), SANDBOX_A);
    expect(fromA.status).toBe('fail');
    expect(fromA.detail).toContain("No container named 'app'");
  });

  it('exposes no way for a requirement to name a daemon or a session', () => {
    const parsed = requirementSchema.parse({
      type: 'docker_container_file_content',
      container: 'app',
      path: '/etc/app/config',
      exists: true,
    });
    for (const key of ['namespace', 'sandbox', 'session', 'sessionId', 'dockerHost', 'host']) {
      expect(Object.keys(parsed)).not.toContain(key);
    }
  });
});

// ------------------------------------------------------------ tar reader

describe('the tar reader refuses anything that is not one regular file', () => {
  /** Build a ustar header for one entry. */
  function header(name: string, size: number, type = '0'): Buffer {
    const block = Buffer.alloc(512);
    block.write(name, 0, 100, 'utf8');
    block.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    block.write(type, 156, 1, 'ascii');
    return block;
  }
  function entry(name: string, body: string, type = '0'): Buffer {
    const content = Buffer.from(body, 'utf8');
    const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
    content.copy(padded);
    return Buffer.concat([header(name, content.length, type), padded]);
  }

  it('reads a single regular file', () => {
    const read = readSingleFile(entry('config', 'production\n'), 64 * 1024);
    expect(read.content.toString('utf8')).toBe('production\n');
    expect(read.size).toBe(11);
    expect(read.truncated).toBe(false);
  });

  it('truncates at the cap and says so', () => {
    const read = readSingleFile(entry('config', 'abcdefghij'), 4);
    expect(read.content.toString('utf8')).toBe('abcd');
    expect(read.truncated).toBe(true);
    expect(read.size).toBe(10);
  });

  it('refuses a directory entry', () => {
    expect(() => readSingleFile(entry('etc/', '', '5'), 1024)).toThrow(TarReadError);
  });

  it('refuses a symlink entry', () => {
    expect(() => readSingleFile(entry('link', '', '2'), 1024)).toThrow(TarReadError);
  });

  it('refuses an archive holding more than one file', () => {
    const two = Buffer.concat([entry('a', 'one'), entry('b', 'two')]);
    expect(() => readSingleFile(two, 1024)).toThrow(/more than one file/);
  });

  it('refuses a malformed size field rather than reading nothing', () => {
    const bad = header('config', 0);
    bad.write('NOTOCTAL\0\0\0\0', 124, 12, 'ascii');
    expect(() => readSingleFile(Buffer.concat([bad, Buffer.alloc(512)]), 1024)).toThrow(TarReadError);
  });

  it('refuses an empty archive', () => {
    expect(() => readSingleFile(Buffer.alloc(0), 1024)).toThrow(TarReadError);
    expect(() => readSingleFile(Buffer.alloc(512), 1024)).toThrow(/no file/);
  });
});
