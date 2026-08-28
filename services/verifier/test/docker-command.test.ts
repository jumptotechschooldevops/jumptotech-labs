/**
 * `docker_container_command`, the image-side ENTRYPOINT/CMD assertions, and the
 * DOCKER-014 contract built on them.
 *
 * The property this file exists to pin: **exact argv, not membership**. The
 * mistake DOCKER-014 teaches is silent —
 *
 *     ENTRYPOINT ["/app/batch.sh"]   ->  Entrypoint = ["/app/batch.sh"]
 *     ENTRYPOINT /app/batch.sh       ->  Entrypoint = ["/bin/sh","-c","/app/batch.sh"]
 *
 * and the second discards every runtime argument. Measured on a real daemon:
 * the shell-form image starts, prints `mode=none` for a run that supplied
 * `--commit`, and exits 0. A membership test ("does the argv mention
 * /app/batch.sh") passes the broken image. An exact comparison does not, and
 * that is the only reason this check is worth having.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  InMemoryWorkspace,
  LabRegistry,
  requirementSchema,
  type LoadedLabDefinition,
  type Requirement,
} from '@jumptotech/lab-orchestrator';
import { FakeDockerDaemon, containerSpec } from '@jumptotech/lab-orchestrator/testing';
import { DockerVerifyReader, verifyLab, verifyRequirement } from '../src/index.js';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';

const SANDBOX_A = 'jtt-lab-00000000000a';
const SANDBOX_B = 'jtt-lab-00000000000b';
const SESSION_A = 'sess-000000000000000a';

let lab: LoadedLabDefinition;

beforeAll(async () => {
  const registry = await realCatalog();
  expect(registry.loadErrors).toEqual([]);
  lab = registry.get('DOCKER-014');
});

const check = (docker: FakeDockerDaemon, requirement: Requirement, sandbox = SANDBOX_A) =>
  verifyRequirement(requirement, new DockerVerifyReader(docker, sandbox));
const passed = (result: { status: string }) => result.status === 'pass';

/** The two forms, exactly as a real daemon reports them. */
const EXEC_ENTRYPOINT = ['/app/batch.sh'];
const SHELL_ENTRYPOINT = ['/bin/sh', '-c', '/app/batch.sh'];

function withCommand(entrypoint: string[], command: string[], state = 'exited', exitCode = 0) {
  const docker = new FakeDockerDaemon();
  docker.addContainer(
    containerSpec({ name: 'batch', image: 'jumptotech/batch:1.0', entrypoint, command }),
    state,
    exitCode,
  );
  return docker;
}

const commandCheck = (entrypoint?: string[], command?: string[], name = 'batch') =>
  ({
    type: 'docker_container_command',
    name,
    ...(entrypoint ? { entrypoint } : {}),
    ...(command ? { command } : {}),
  }) as Requirement;

// --------------------------------------------------- exec form vs shell form

describe('docker_container_command — exec form and shell form are different things', () => {
  it('accepts an exec-form entrypoint', async () => {
    const docker = withCommand(EXEC_ENTRYPOINT, ['--dry-run']);
    expect(passed(await check(docker, commandCheck(EXEC_ENTRYPOINT, ['--dry-run'])))).toBe(true);
  });

  it('REFUSES the shell form, which a membership test would have accepted', async () => {
    // The whole point. This container mentions /app/batch.sh, starts fine, and
    // throws away every runtime argument.
    const docker = withCommand(SHELL_ENTRYPOINT, ['--commit']);

    const result = await check(docker, commandCheck(EXEC_ENTRYPOINT, ['--commit']));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('/bin/sh');
    expect(result.detail).toContain('its entrypoint is');
  });

  it('compares argv order, not just contents', async () => {
    const docker = withCommand(['/app/batch.sh'], ['--commit', '--dry-run']);
    expect(passed(await check(docker, commandCheck(undefined, ['--dry-run', '--commit'])))).toBe(false);
  });

  it('compares argv length, so extra arguments fail', async () => {
    const docker = withCommand(EXEC_ENTRYPOINT, ['--commit', '--force']);
    expect(passed(await check(docker, commandCheck(undefined, ['--commit'])))).toBe(false);
  });
});

// --------------------------------------------------------------- the fields

describe('docker_container_command — each half, and both together', () => {
  it('grades the entrypoint alone', async () => {
    const docker = withCommand(EXEC_ENTRYPOINT, ['--anything']);
    expect(passed(await check(docker, commandCheck(EXEC_ENTRYPOINT)))).toBe(true);
    expect(passed(await check(docker, commandCheck(['/other'])))).toBe(false);
  });

  it('grades the command alone', async () => {
    const docker = withCommand(['/whatever'], ['--commit']);
    expect(passed(await check(docker, commandCheck(undefined, ['--commit'])))).toBe(true);
    expect(passed(await check(docker, commandCheck(undefined, ['--dry-run'])))).toBe(false);
  });

  it('reports both halves when both are wrong', async () => {
    const docker = withCommand(SHELL_ENTRYPOINT, ['--dry-run']);
    const result = await check(docker, commandCheck(EXEC_ENTRYPOINT, ['--commit']));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('its entrypoint is');
    expect(result.detail).toContain('its command is');
  });

  it('fails a missing container without inventing a verdict', async () => {
    const result = await check(new FakeDockerDaemon(), commandCheck(EXEC_ENTRYPOINT));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain("No container named 'batch'");
  });

  it('requires at least one half, and rejects unknown fields', () => {
    const base = { type: 'docker_container_command', name: 'batch' };
    expect(requirementSchema.safeParse(base).success).toBe(false);
    expect(requirementSchema.safeParse({ ...base, command: ['x'] }).success).toBe(true);
    expect(requirementSchema.safeParse({ ...base, entrypoint: ['x'] }).success).toBe(true);
    expect(
      requirementSchema.safeParse({ ...base, command: ['x'], shell: 'sh -c evil' }).success,
    ).toBe(false);
  });

  it('rejects an argv element carrying control characters', () => {
    expect(
      requirementSchema.safeParse({
        type: 'docker_container_command',
        name: 'batch',
        command: ['ok', 'bad\nvalue'],
      }).success,
    ).toBe(false);
  });
});

// ------------------------------------------------------------- image config

describe('docker_image_config — ENTRYPOINT and CMD, separately and exactly', () => {
  function image(entrypoint: string[], cmd: string[]) {
    const docker = new FakeDockerDaemon();
    docker.addImage('jumptotech/batch:1.0', { entrypoint, cmd });
    return docker;
  }
  const imageCheck = (entrypoint: string[], cmd: string[]) =>
    ({ type: 'docker_image_config', image: 'jumptotech/batch:1.0', entrypoint, cmd }) as Requirement;

  it('accepts the correct split', async () => {
    const docker = image(EXEC_ENTRYPOINT, ['--dry-run']);
    expect(passed(await check(docker, imageCheck(EXEC_ENTRYPOINT, ['--dry-run'])))).toBe(true);
  });

  it('refuses everything crammed into CMD, which cmd_contains would have allowed', async () => {
    // `CMD ["/app/batch.sh","--dry-run"]` with no ENTRYPOINT: the merged argv
    // contains both tokens, so the older membership check passes it — but a
    // runtime argument would replace the program instead of the mode.
    const docker = image([], ['/app/batch.sh', '--dry-run']);

    const merged = await check(docker, {
      type: 'docker_image_config',
      image: 'jumptotech/batch:1.0',
      cmd_contains: ['/app/batch.sh', '--dry-run'],
    } as Requirement);
    expect(passed(merged), 'membership test accepts the wrong packaging').toBe(true);

    const exact = await check(docker, imageCheck(EXEC_ENTRYPOINT, ['--dry-run']));
    expect(exact.status).toBe('fail');
    expect(exact.detail).toContain('ENTRYPOINT is (none)');
  });

  it('refuses a shell-form ENTRYPOINT in the image', async () => {
    const docker = image(SHELL_ENTRYPOINT, ['--dry-run']);
    const result = await check(docker, imageCheck(EXEC_ENTRYPOINT, ['--dry-run']));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('/bin/sh');
  });

  it('refuses a missing default mode', async () => {
    const docker = image(EXEC_ENTRYPOINT, []);
    const result = await check(docker, imageCheck(EXEC_ENTRYPOINT, ['--dry-run']));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('CMD is (none)');
  });
});

// --------------------------------------------------------- the lab contract

describe('DOCKER-014 — the lab', () => {
  function solved(overrides: {
    imageEntrypoint?: string[];
    imageCmd?: string[];
    defaultCmd?: string[];
    overrideCmd?: string[];
    overrideEntrypoint?: string[];
    defaultExit?: number;
    overrideExit?: number;
    dockerfile?: string;
  } = {}) {
    const docker = new FakeDockerDaemon();
    const port = new InMemoryWorkspace();
    docker.addImage('jumptotech/batch:1.0', {
      entrypoint: overrides.imageEntrypoint ?? EXEC_ENTRYPOINT,
      cmd: overrides.imageCmd ?? ['--dry-run'],
    });
    docker.addContainer(
      containerSpec({
        name: 'batch-default',
        image: 'jumptotech/batch:1.0',
        entrypoint: EXEC_ENTRYPOINT,
        command: overrides.defaultCmd ?? ['--dry-run'],
      }),
      'exited',
      overrides.defaultExit ?? 0,
    );
    docker.addContainer(
      containerSpec({
        name: 'batch-override',
        image: 'jumptotech/batch:1.0',
        entrypoint: overrides.overrideEntrypoint ?? EXEC_ENTRYPOINT,
        command: overrides.overrideCmd ?? ['--commit'],
      }),
      'exited',
      overrides.overrideExit ?? 0,
    );
    port.write(
      SESSION_A,
      'Dockerfile',
      overrides.dockerfile ??
        'FROM alpine:3.20\nWORKDIR /app\nCOPY batch.sh /app/batch.sh\nRUN chmod +x /app/batch.sh\nENTRYPOINT ["/app/batch.sh"]\nCMD ["--dry-run"]\n',
    );
    return { docker, workspace: { port, sessionId: SESSION_A } };
  }

  const verify = (built: ReturnType<typeof solved>, sandbox = SANDBOX_A) =>
    verifyLab({ lab, namespace: sandbox, docker: built.docker, workspace: built.workspace });
  const failing = (r: Awaited<ReturnType<typeof verify>>) =>
    r.checks.filter((c) => c.status !== 'pass').map((c) => c.label);

  it('passes when the tool is packaged correctly', async () => {
    const result = await verify(solved());
    expect(failing(result)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('fails an empty environment', async () => {
    const result = await verifyLab({
      lab,
      namespace: SANDBOX_A,
      docker: new FakeDockerDaemon(),
      workspace: { port: new InMemoryWorkspace(), sessionId: SESSION_A },
    });
    expect(result.passed).toBe(false);
    expect(failing(result)).toHaveLength(result.checks.length);
  });

  // ------------------------------------------------------------ anti-cheat

  it('a Dockerfile claiming the right thing does not pass without the image', async () => {
    const port = new InMemoryWorkspace();
    port.write(
      SESSION_A,
      'Dockerfile',
      'FROM alpine:3.20\nCOPY batch.sh /app/batch.sh\nENTRYPOINT ["/app/batch.sh"]\nCMD ["--dry-run"]\n',
    );
    const result = await verifyLab({
      lab,
      namespace: SANDBOX_A,
      docker: new FakeDockerDaemon(),
      workspace: { port, sessionId: SESSION_A },
    });
    expect(result.passed).toBe(false);
    expect(failing(result)).toContain('Image jumptotech/batch:1.0 was built');
  });

  it('a README or a text file claiming the answer changes nothing', async () => {
    const built = solved();
    built.workspace.port.write(SESSION_A, 'README.md', 'ENTRYPOINT ["/app/batch.sh"] CMD ["--dry-run"] — done!');
    built.workspace.port.write(SESSION_A, 'answers.txt', 'batch-default OK, batch-override OK, exit 0');
    // Still passes only because the real state is right; and breaking the real
    // state fails despite the files.
    expect((await verify(built)).passed).toBe(true);

    const cheating = solved({ imageEntrypoint: [] });
    cheating.workspace.port.write(SESSION_A, 'README.md', 'ENTRYPOINT ["/app/batch.sh"]');
    expect((await verify(cheating)).passed).toBe(false);
  });

  it('the right image with the wrong container command does not pass', async () => {
    // Built correctly, then run wrongly: `docker run … /bin/sh` replaces the
    // program instead of selecting a mode.
    const result = await verify(solved({ overrideCmd: ['/bin/sh'] }));
    expect(result.passed).toBe(false);
    expect(failing(result)).toEqual([
      'batch-override replaced the mode while keeping the same program',
    ]);
  });

  it('overriding the entrypoint instead of the command does not pass', async () => {
    // `docker run --entrypoint /bin/sh …` — the program was replaced, which is
    // exactly what ENTRYPOINT exists to prevent.
    const result = await verify(solved({ overrideEntrypoint: ['/bin/sh'] }));
    expect(result.passed).toBe(false);
    expect(failing(result)).toContain(
      'batch-override replaced the mode while keeping the same program',
    );
  });

  it('a shell-form image fails on the argv even when both containers exit 0', async () => {
    // The silent bug: nothing about the exit codes reveals it.
    const result = await verify({
      ...solved({ imageEntrypoint: SHELL_ENTRYPOINT }),
    });
    expect(result.passed).toBe(false);
    expect(failing(result)).toContain(
      'The image runs the script directly, with --dry-run as its default mode',
    );
  });

  it('a container that ran with a bad mode fails on its exit code', async () => {
    const result = await verify(solved({ overrideExit: 64 }));
    expect(result.passed).toBe(false);
    expect(failing(result)).toEqual(['batch-override completed successfully']);
  });

  it('running both containers with the default mode does not prove the override', async () => {
    const result = await verify(solved({ overrideCmd: ['--dry-run'] }));
    expect(result.passed).toBe(false);
    expect(failing(result)).toEqual([
      'batch-override replaced the mode while keeping the same program',
    ]);
  });

  it('a Dockerfile missing ENTRYPOINT fails even if the image is somehow right', async () => {
    const result = await verify(
      solved({ dockerfile: 'FROM alpine:3.20\nCOPY batch.sh /app/batch.sh\nCMD ["--dry-run"]\n' }),
    );
    expect(result.passed).toBe(false);
    expect(failing(result)).toContain(
      'The Dockerfile builds on alpine:3.20 and uses COPY, ENTRYPOINT, and CMD',
    );
  });

  it('is graded against the session that did the work, and no other', async () => {
    const sessionB = solved();
    expect((await verify(sessionB, SANDBOX_B)).passed).toBe(true);

    const sessionA = await verifyLab({
      lab,
      namespace: SANDBOX_A,
      docker: new FakeDockerDaemon(),
      workspace: { port: new InMemoryWorkspace(), sessionId: 'sess-000000000000000b' },
    });
    expect(sessionA.passed).toBe(false);
  });

  it('exposes no way for a requirement to name a daemon or a session', () => {
    for (const requirement of [...lab.requirements, ...lab.setup.verify]) {
      for (const key of ['namespace', 'sandbox', 'session', 'sessionId', 'dockerHost', 'command_line', 'script']) {
        expect(Object.keys(requirement)).not.toContain(key);
      }
    }
  });

  it('removes the built image on reset, so a previous pass cannot linger', () => {
    // The student's own image is the artefact being graded; keeping it across a
    // reset would let a stale pass survive into a fresh attempt.
    expect(lab.reset.docker?.images).toBe(true);
    expect(lab.reset.docker?.containers).toBe(true);
    expect(lab.reset.docker?.workspace).toBe(true);
  });
});
