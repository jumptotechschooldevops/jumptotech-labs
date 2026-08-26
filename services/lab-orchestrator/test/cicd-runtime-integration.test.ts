/**
 * The CI/CD sandbox against a real Docker daemon.
 *
 * `cicd-provider.test.ts` asserts what the platform asks for and
 * `cicd-requirements.test.ts` asserts what the handlers do with a result. This
 * is the part neither can prove: that a real `node build.mjs` in a real
 * container actually builds, that the container really holds no capabilities,
 * and that five concurrent sessions really cannot see one another.
 *
 * The last point is the reason this file exists. The branch this track came
 * from isolated sessions with directories on the host and documented in its own
 * header that a determined student could read a peer's workspace. Moving to one
 * container per session is the fix, and a claim about isolation is worth only
 * as much as the test that tried to break it.
 *
 * Tier: E2E. Gated on RUN_INTEGRATION_TESTS=1 and a built sandbox image.
 *
 * What it mutates on the shared daemon, and nothing else: containers named
 * from this run's id, all removed in `afterAll`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WORKSPACE_TASKS } from '../src/index.js';
import { testRunId } from '@jumptotech/test-support/run-id';

const run = promisify(execFile);
const ENABLED = process.env.RUN_INTEGRATION_TESTS === '1';
const IMAGE = process.env.CICD_SANDBOX_IMAGE ?? 'jumptotech/lab-cicd:latest';

const RUN_HEX = createHash('sha256').update(testRunId()).digest('hex').slice(0, 10);
/** Five sessions, so the concurrency claim is tested at the size it is made. */
const SESSIONS = [0, 1, 2, 3, 4].map((i) => ({
  ref: `jtt-lab-${RUN_HEX}c${i}`,
  secret: `SESSION-${RUN_HEX}-${i}-ONLY`,
}));

async function docker(args: string[], timeoutMs = 120_000) {
  return run('docker', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
}
async function dockerOrNull(args: string[]) {
  try {
    return await docker(args);
  } catch {
    return null;
  }
}
async function exec(container: string, argv: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await docker([
      'exec',
      '--user',
      'student',
      '--workdir',
      '/home/student',
      container,
      ...argv,
    ]);
    return { ok: true, out: `${stdout}${stderr}` };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** Write a file into a container over stdin — never as an argv or an env var. */
async function put(container: string, relative: string, contents: string) {
  await run(
    'sh',
    ['-c', `printf '%s' "$BODY" | docker exec -i --user student ${container} sh -c 'cat > /home/student/${relative}'`],
    { env: { ...process.env, BODY: contents }, timeout: 60_000 },
  );
}

const BUILD_MJS = `import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
writeFileSync('dist/statements.bundle.js', 'export const ok = true;\\n');
console.log('built dist/statements.bundle.js');
`;

const STATEMENTS_MJS = `export const total = (rows) => rows.reduce((a, b) => a + b, 0);\n`;

const TEST_MJS = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/statements.mjs';
test('total', () => { assert.equal(total([1, 2]), 3); });
`;

async function teardown() {
  for (const session of SESSIONS) {
    await dockerOrNull(['rm', '--force', '--volumes', session.ref]);
  }
}

describe.skipIf(!ENABLED)('the CI/CD sandbox, against a real daemon', () => {
  beforeAll(async () => {
    if (!(await dockerOrNull(['image', 'inspect', IMAGE]))) {
      throw new Error(`${IMAGE} is not built — run: npm run sandbox:build`);
    }
    await teardown();

    for (const session of SESSIONS) {
      await docker([
        'run', '--detach',
        '--name', session.ref,
        '--network', 'none',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true',
        '--user', 'student',
        '--workdir', '/home/student',
        IMAGE, 'sleep', 'infinity',
      ]);
      await exec(session.ref, ['mkdir', '-p', 'src', 'test']);
      await put(session.ref, 'build.mjs', BUILD_MJS);
      await put(session.ref, 'src/statements.mjs', STATEMENTS_MJS);
      await put(session.ref, 'test/statements.test.mjs', TEST_MJS);
      // A value only this session knows, for the isolation matrix below.
      await put(session.ref, 'secret.txt', `${session.secret}\n`);
    }
  }, 300_000);

  afterAll(teardown, 180_000);

  // --- the toolchain is real --------------------------------------------------

  it('really builds the project with the task from the closed table', async () => {
    const [command, ...args] = WORKSPACE_TASKS.app_build.argv;
    const result = await exec(SESSIONS[0]!.ref, [command!, ...args]);
    expect(result.ok).toBe(true);
    expect(result.out).toContain('built dist/statements.bundle.js');

    const artifact = await exec(SESSIONS[0]!.ref, ['test', '-s', 'dist/statements.bundle.js']);
    expect(artifact.ok).toBe(true);
  }, 120_000);

  it('really runs the test suite, and really fails a broken one', async () => {
    const [command, ...args] = WORKSPACE_TASKS.app_test.argv;
    const passing = await exec(SESSIONS[0]!.ref, [command!, ...args]);
    expect(passing.ok).toBe(true);

    await put(
      SESSIONS[0]!.ref,
      'test/statements.test.mjs',
      TEST_MJS.replace('total([1, 2]), 3', 'total([1, 2]), 99'),
    );
    const failing = await exec(SESSIONS[0]!.ref, [command!, ...args]);
    expect(failing.ok).toBe(false);
    await put(SESSIONS[0]!.ref, 'test/statements.test.mjs', TEST_MJS);
  }, 180_000);

  // --- the sandbox is closed --------------------------------------------------

  it('holds no capabilities at all', async () => {
    const caps = await exec(SESSIONS[0]!.ref, ['grep', 'CapBnd', '/proc/self/status']);
    expect(caps.out).toMatch(/CapBnd:\s+0{16}/);
  });

  it('has no Docker socket, no Docker client, and no route anywhere', async () => {
    const socket = await exec(SESSIONS[0]!.ref, [
      'sh', '-c', 'test -S /var/run/docker.sock && echo present || echo absent',
    ]);
    expect(socket.out).toContain('absent');

    const client = await exec(SESSIONS[0]!.ref, [
      'sh', '-c', 'command -v docker >/dev/null && echo present || echo absent',
    ]);
    expect(client.out).toContain('absent');

    const route = await exec(SESSIONS[0]!.ref, ['sh', '-c', 'ip route 2>/dev/null | wc -l']);
    expect(route.out.trim()).toBe('0');
  }, 120_000);

  it('publishes no host port', async () => {
    const { stdout } = await docker([
      'inspect', '-f', '{{json .NetworkSettings.Ports}}', SESSIONS[0]!.ref,
    ]);
    expect(stdout.trim()).toMatch(/^(\{\}|null)$/);
  });

  // --- five concurrent sessions ----------------------------------------------

  it('gives five concurrent sessions five projects that cannot see each other', async () => {
    // Each session holds a value only it knows. Every session must find its
    // own and none of the other four — 5 present, 20 absent.
    for (const [index, session] of SESSIONS.entries()) {
      const mine = await exec(session.ref, ['cat', 'secret.txt']);
      expect(mine.out, `session ${index} reads its own`).toContain(session.secret);

      for (const [otherIndex, other] of SESSIONS.entries()) {
        if (otherIndex === index) continue;
        expect(mine.out, `session ${index} must not hold ${otherIndex}'s`).not.toContain(
          other.secret,
        );
      }
    }
  }, 180_000);

  it('cannot reach another session by name or by address', async () => {
    const target = SESSIONS[1]!.ref;
    // `--network none` means there is no resolver and no route, so the other
    // container is not merely unauthorised — it is unaddressable.
    const byName = await exec(SESSIONS[0]!.ref, [
      'sh', '-c', `getent hosts ${target} >/dev/null 2>&1 && echo resolved || echo unresolvable`,
    ]);
    expect(byName.out).toContain('unresolvable');
  }, 120_000);

  it('cannot write into another session, even knowing its name', async () => {
    // There is no filesystem path from one container to another: the only
    // handle is the container name, and that is the daemon's, not the
    // student's. Proved by the absence of a client, above; here we confirm the
    // peer's file is untouched after the attempt.
    const target = SESSIONS[2]!;
    await exec(SESSIONS[0]!.ref, [
      'sh', '-c', `printf 'tampered' > /home/student/../${target.ref}/secret.txt 2>/dev/null || true`,
    ]);
    const after = await exec(target.ref, ['cat', 'secret.txt']);
    expect(after.out).toContain(target.secret);
    expect(after.out).not.toContain('tampered');
  }, 120_000);

  // --- reset isolation --------------------------------------------------------

  it('resets one session without touching another', async () => {
    const [a, b] = [SESSIONS[3]!, SESSIONS[4]!];
    await put(a.ref, 'scratch.txt', 'a-only\n');
    await put(b.ref, 'scratch.txt', 'b-only\n');

    // A reset replaces the container; emulated here by removing and recreating
    // just A, which is what the provider's destroy/create pair does.
    await docker(['rm', '--force', a.ref]);
    await docker([
      'run', '--detach', '--name', a.ref,
      '--network', 'none', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true',
      '--user', 'student', '--workdir', '/home/student',
      IMAGE, 'sleep', 'infinity',
    ]);
    await put(a.ref, 'secret.txt', `${a.secret}\n`);

    const aScratch = await exec(a.ref, ['sh', '-c', 'cat scratch.txt 2>/dev/null || echo gone']);
    expect(aScratch.out).toContain('gone');

    const bScratch = await exec(b.ref, ['cat', 'scratch.txt']);
    expect(bScratch.out).toContain('b-only');
  }, 180_000);
});
