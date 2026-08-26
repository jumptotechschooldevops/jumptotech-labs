/**
 * `unprivileged_shell` — removing the student's route to root.
 *
 * The vulnerability this closes, demonstrated end to end before the capability
 * existed: the verifier reads state back by running `/usr/bin/stat` and
 * `/bin/cat` *inside the student's own container*. The Linux sandbox grants
 * passwordless `sudo`, so a student could replace those two binaries and make
 * an untouched home directory report a finished lab. CS-001 went from 0/11 to
 * a full LAB PASSED with nothing solved.
 *
 * The fix is not "chmod the grader" — inside a sandbox where the student can
 * become root, no file permission is a trust boundary. It is to stop handing
 * out root at all in labs that do not teach administration, and to keep every
 * expected value outside the sandbox where a student has no reach.
 *
 * These tests pin the mechanism. The end-to-end proof — the same attack
 * scripted against a live session before and after — lives in the CS track's
 * manual procedure, because it needs a real container.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  LinuxLabProvider,
  loadLabDefinition,
  LAB_CAPABILITIES,
  labHasCapability,
  type LoadedLabDefinition,
} from '../src/index.js';
import { FakeContainerRuntime } from './container-fakes.js';
import { LABS_DIR, sessionContext } from './helpers.js';

const CS_001 = path.join(LABS_DIR, 'cs', 'cs-001-machine-anatomy', 'lab.yaml');
const LINUX_002 = path.join(LABS_DIR, 'linux', 'linux-002-permissions', 'lab.yaml');

const SUDOERS = '/etc/sudoers.d/010-student';

/** Every exec the provider issued, as `user argv…`. */
function execLines(runtime: FakeContainerRuntime): string[] {
  return runtime.execs.map((e) => `${e.request.user ?? ''} ${e.request.argv.join(' ')}`.trim());
}

function removedSudoers(runtime: FakeContainerRuntime): boolean {
  return execLines(runtime).some((line) => line.startsWith('root /bin/rm') && line.includes(SUDOERS));
}

describe('the capability vocabulary', () => {
  it('offers unprivileged_shell', () => {
    expect(LAB_CAPABILITIES).toContain('unprivileged_shell');
  });

  it('is declared by CS labs and not by Linux labs', async () => {
    const cs = await loadLabDefinition(CS_001);
    const linux = await loadLabDefinition(LINUX_002);

    // CS teaches what a system is; it never asks a student to administer one.
    expect(labHasCapability(cs, 'unprivileged_shell')).toBe(true);
    // LINUX-002 is *about* changing ownership of a file the student does not
    // own. Taking sudo away here would make the lab unsolvable, which is why
    // the capability narrows rather than the image being changed for everyone.
    expect(labHasCapability(linux, 'unprivileged_shell')).toBe(false);
  });
});

describe('LinuxLabProvider — privilege reduction', () => {
  async function create(labPath: string): Promise<{ runtime: FakeContainerRuntime; steps: string[]; lab: LoadedLabDefinition }> {
    const lab = await loadLabDefinition(labPath);
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const result = await provider.create(sessionContext(lab, { sandboxRef: 'jtt-lab-000000000001' }));
    return { runtime, steps: result.steps.map((s) => s.id), lab };
  }

  it('removes the sudo grant for a lab that declares unprivileged_shell', async () => {
    const { runtime, steps } = await create(CS_001);

    expect(steps).toContain('sandbox-privilege');
    expect(removedSudoers(runtime)).toBe(true);
  });

  it('removes it as root, before any seed script or student shell exists', async () => {
    const { runtime } = await create(CS_001);
    const lines = execLines(runtime);

    const removal = lines.findIndex((l) => l.startsWith('root /bin/rm') && l.includes(SUDOERS));
    const seed = lines.findIndex((l) => l.includes('/opt/jumptotech/seed'));
    expect(removal).toBeGreaterThanOrEqual(0);
    // If a seed script ran first it would run in a sandbox that still had a
    // route to root — and a troubleshooting seed is exactly where a student
    // would look for one.
    if (seed >= 0) expect(removal).toBeLessThan(seed);
  });

  it('verifies the grant is actually gone rather than assuming the removal worked', async () => {
    const { runtime } = await create(CS_001);

    // A sandbox that still hands out root must never reach a student, so the
    // provider probes instead of trusting `rm`'s exit code.
    expect(execLines(runtime).some((l) => l.includes('/usr/bin/sudo') && l.includes('-n'))).toBe(true);
  });

  it('leaves a lab that did not declare it completely alone', async () => {
    const { runtime, steps } = await create(LINUX_002);

    expect(steps).not.toContain('sandbox-privilege');
    expect(removedSudoers(runtime)).toBe(false);
    expect(execLines(runtime).some((l) => l.includes('/usr/bin/sudo'))).toBe(false);
  });

  it('re-applies the reduction when the sandbox is reset', async () => {
    const lab = await loadLabDefinition(CS_001);
    const runtime = new FakeContainerRuntime();
    const provider = new LinuxLabProvider({ runtime });
    const context = sessionContext(lab, { sandboxRef: 'jtt-lab-000000000001' });
    await provider.create(context);

    const before = runtime.execs.length;
    const reset = await provider.reset(context);

    // Reset replaces the container, so the fresh one arrives with sudo again
    // unless the reduction runs a second time. A student who could get root
    // back by clicking Reset would defeat the whole capability.
    expect(reset.steps.map((s) => s.id)).toContain('recreate-sandbox-privilege');
    const after = execLines(runtime).slice(before);
    expect(after.some((l) => l.startsWith('root /bin/rm') && l.includes(SUDOERS))).toBe(true);
  });
});
