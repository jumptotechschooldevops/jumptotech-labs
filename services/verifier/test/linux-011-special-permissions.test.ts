/**
 * LINUX-011 — special permission bits, and the one thing a filesystem cannot
 * tell you.
 *
 * Three of this lab's checks read a mode off a path the student was told to
 * fix, which is ordinary. The other three grade a umask, and a umask is not
 * observable after the fact: once a file exists, a mode produced by a umask and
 * a mode produced by `chmod` are the same bytes. So the lab does not ask what
 * the umask is. It reads what a fresh login shell for the account produced —
 * the handoff writer's file and directory — and those two modes, together with
 * the group the file landed in, are the evidence.
 *
 * Three regressions this suite exists to catch:
 *
 *   1. **A special bit accepted loosely.** Every mode check is an exact match,
 *      so "the bit is set and I widened everything else on the way past" fails.
 *      2777 is not 2770; 0777 on the helper drops setuid and hands the world
 *      write access it never had. Both are tested.
 *   2. **The wrong bit.** setuid where setgid was wanted and setgid where
 *      sticky was wanted are the two mistakes this material actually produces,
 *      and they are one octal digit apart. Both are tested, both fail.
 *   3. **Grading a umask from something other than a created file.** There is
 *      no evidence file in this lab and nothing reads a value the student wrote
 *      down. The test at the bottom pins that: it walks every requirement and
 *      asserts none of them reads content.
 *
 * The mode strings here are the ones a real sandbox produced — the seeded
 * baseline and the solved state were both read back with `stat -c %a` from a
 * container built from the shipped image before these were written down.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LAB_YAML = path.resolve(here, '../../../labs/linux/linux-011-special-permissions/lab.yaml');
const SANDBOX = 'jtt-lab-000000000011';

const DROP = '/srv/jumptotech/drop';
const SCRATCH = '/srv/jumptotech/scratch';
const HELPER = '/usr/local/bin/report-helper';
const CSV = '/srv/jumptotech/drop/handoff.csv';
const DROP_DIR = '/srv/jumptotech/drop/handoff.d';
const RUNBOOK = '/srv/jumptotech/runbooks/shared-areas.md';

const WRITER = '   53 root     /bin/sh /usr/local/bin/jtt-handoff';

interface WorldOptions {
  /** Mode of the drop directory. Seeded 0770; wanted 2770. */
  drop?: string;
  /** Mode of the scratch area. Seeded 0777; wanted 1777. */
  scratch?: string;
  /** Mode of the setuid helper. Seeded 4755; wanted 0755. */
  helper?: string;
  /** Mode of the file the writer created. 0644 under the default umask. */
  csvMode?: string;
  /** Group the writer's file landed in. `student` until the drop is setgid. */
  csvGroup?: string;
  /** Mode of the directory the writer created. 0755 by default; 2750 solved. */
  dirMode?: string;
  /** Whether the handoff writer is still running. */
  writerRunning?: boolean;
  /** Drop the writer's artefacts entirely, as stopping it and cleaning up would. */
  artefacts?: boolean;
}

/**
 * The seeded baseline is this function's defaults, so every test below states
 * only what it changed. That is deliberate: a test that had to spell out six
 * modes to say "the sticky bit is wrong" would stop being readable.
 */
function world(o: WorldOptions = {}): FakeWorld {
  const {
    drop = '770',
    scratch = '777',
    helper = '4755',
    csvMode = '644',
    csvGroup = 'student',
    dirMode = '755',
    writerRunning = true,
    artefacts = true,
  } = o;

  const files: NonNullable<FakeWorld['files']> = {
    [RUNBOOK]: { type: 'file', mode: '644', owner: 'root', group: 'root', content: '# standard\n' },
    [DROP]: { type: 'directory', mode: drop, owner: 'root', group: 'deployers' },
    [SCRATCH]: { type: 'directory', mode: scratch, owner: 'root', group: 'root' },
    [HELPER]: { type: 'file', mode: helper, owner: 'root', group: 'root', content: '\x7fELF' },
  };

  if (artefacts) {
    files[CSV] = { type: 'file', mode: csvMode, owner: 'student', group: csvGroup, content: 'batch\n' };
    files[DROP_DIR] = { type: 'directory', mode: dirMode, owner: 'student', group: csvGroup };
  }

  return { files, processes: writerRunning ? [WRITER] : [] };
}

/** The state a correct solution leaves behind, read back from a real sandbox. */
const SOLVED: WorldOptions = {
  drop: '2770',
  scratch: '1777',
  helper: '755',
  csvMode: '640',
  csvGroup: 'deployers',
  dirMode: '2750',
};

async function verify(o: WorldOptions = {}) {
  return verifyLab({
    lab: await loadLabDefinition(LAB_YAML),
    sandbox: new FakeSandbox(world(o)),
    namespace: SANDBOX,
  });
}

function failed(checks: Array<{ status: string; label: string }>): string[] {
  return checks.filter((c) => c.status !== 'pass').map((c) => c.label);
}

// -------------------------------------------------------------- the outcomes

describe('LINUX-011 grades the bits, and what they produced', () => {
  it('passes the state a correct solution leaves behind', async () => {
    const result = await verify(SOLVED);

    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('fails the seeded baseline on every objective, and says so without naming a fix', async () => {
    const result = await verify();

    expect(result.passed).toBe(false);
    // Six of the seven: the writer is running from the first second, so that
    // one is green in the starting state and stays green throughout.
    expect(failed(result.checks)).toHaveLength(6);
    for (const check of result.checks) {
      const detail = `${check.detail ?? ''}`;
      expect(detail).not.toMatch(/chmod|umask|setgid|setuid|sticky|\.profile/i);
    }
  });

  it('reads no file content anywhere — there is nothing to write down', async () => {
    /*
     * The point of the lab. `file_content` and the command types could all be
     * satisfied by a student writing the expected answer into a file, so this
     * lab uses none of them: every requirement is a mode, a group, or the
     * process table. If someone later "simplifies" the umask grading into
     * reading ~/ops/umask.txt, this fails.
     */
    const lab = await loadLabDefinition(LAB_YAML);
    const types = lab.requirements.map((r) => r.type);

    expect(types).not.toContain('file_content');
    expect(types).not.toContain('command_output');
    expect(types).not.toContain('command_exit_code');
    expect(types).not.toContain('script_runs');
    expect(new Set(types)).toEqual(new Set(['file_mode', 'file_group', 'process_running']));
  });
});

// ------------------------------------------------------- one bit at a time

describe('each special bit is graded on its own', () => {
  it('fails a drop that was made group-writable but never setgid', async () => {
    const result = await verify({ ...SOLVED, drop: '770', csvGroup: 'student', dirMode: '750' });

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain(
      'The drop passes its group on to new entries, and is no wider than it was',
    );
    // And the two downstream facts go with it: without setgid the writer's file
    // lands in the creator's own group and the new directory inherits nothing.
    expect(failed(result.checks)).toContain(
      'That file belongs to the deployers group without anyone setting it',
    );
    expect(failed(result.checks)).toContain(
      'A directory the writer created is owner and group only, and passes the group on in turn',
    );
  });

  it('fails setuid where setgid was wanted', async () => {
    const result = await verify({ ...SOLVED, drop: '4770' });

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain(
      'The drop passes its group on to new entries, and is no wider than it was',
    );
  });

  it('fails setgid where the sticky bit was wanted', async () => {
    const result = await verify({ ...SOLVED, scratch: '2777' });

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain(
      'The scratch area is still writable by all, but only owners may delete',
    );
  });

  it('fails a scratch area left world-writable with nothing protecting it', async () => {
    expect(failed((await verify({ ...SOLVED, scratch: '777' })).checks)).toContain(
      'The scratch area is still writable by all, but only owners may delete',
    );
  });

  it('fails a helper that kept its setuid bit', async () => {
    expect(failed((await verify({ ...SOLVED, helper: '4755' })).checks)).toContain(
      'The reporting helper no longer runs as its owner, and gained nothing else',
    );
  });
});

// --------------------------------------------------- the shortcuts that fail

describe('a bit set by widening everything else is not the bit', () => {
  it('fails a drop opened to the world on the way to setgid', async () => {
    // 2777 contains the setgid bit and hands every account on the box write
    // access to the handoff area. The runbook says 0770 and no wider.
    const result = await verify({ ...SOLVED, drop: '2777' });

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain(
      'The drop passes its group on to new entries, and is no wider than it was',
    );
  });

  it('fails a helper stripped of setuid by chmod 0777', async () => {
    // The setuid bit is genuinely gone, which is the finding — and the file is
    // now writable by anybody, which is a worse one.
    const result = await verify({ ...SOLVED, helper: '777' });

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain(
      'The reporting helper no longer runs as its owner, and gained nothing else',
    );
  });

  it('fails a scratch area given both sticky and setgid', async () => {
    /*
     * Reachable by accident and hard to leave: GNU chmod preserves a
     * directory's setgid bit through an octal mode, so a student who set 2777
     * here and then ran the correct `chmod 1777` lands on 3777 and stays there.
     * The check is right to fail it — 3777 grants what 1777 does and one thing
     * more — and hint 3 names the symbolic `g-s` that gets back out.
     */
    expect(failed((await verify({ ...SOLVED, scratch: '3777' })).checks)).toContain(
      'The scratch area is still writable by all, but only owners may delete',
    );
  });

  it('fails a helper left at 0755 but with the setgid bit added instead', async () => {
    expect(failed((await verify({ ...SOLVED, helper: '2755' })).checks)).toContain(
      'The reporting helper no longer runs as its owner, and gained nothing else',
    );
  });
});

// ------------------------------------------------------------- the umask half

describe('the umask is graded from what a login shell produced', () => {
  it('fails when the bits are all correct but nothing set a umask', async () => {
    /*
     * The interesting failure: three chmods done perfectly, and the writer
     * still producing 0644 because the account's login profile was never
     * touched. This is what a student sees if they set `umask 0027` in the
     * shell they are sitting in — the writer gets its own login shell and
     * never sees it.
     */
    const result = await verify({ ...SOLVED, csvMode: '644', dirMode: '2755' });

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'A file the writer created is readable by its owner and group, and by nobody else',
      'A directory the writer created is owner and group only, and passes the group on in turn',
    ]);
  });

  it('fails a umask that is too tight as well as one that is too loose', async () => {
    // 0077 leaves 0600, which locks out the deployers the drop exists for.
    // The runbook asks for group read, not for "no wider than 0640".
    const tight = await verify({ ...SOLVED, csvMode: '600', dirMode: '2700' });
    expect(tight.passed).toBe(false);

    const loose = await verify({ ...SOLVED, csvMode: '660', dirMode: '2770' });
    expect(loose.passed).toBe(false);
  });

  it('fails a file chmod-ed to 0640 in a directory that still is not setgid', async () => {
    /*
     * The cheapest forgery: chmod the writer's current output instead of
     * configuring anything. It reaches the mode but not the group, because the
     * group is handed out by the directory rather than by the file's creator —
     * and the new directory the writer makes each cycle gives it away too.
     */
    const result = await verify({ ...SOLVED, drop: '770', csvMode: '640', csvGroup: 'student', dirMode: '750' });

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain(
      'That file belongs to the deployers group without anyone setting it',
    );
  });

  it('fails once the writer has been stopped, however good the artefacts look', async () => {
    /*
     * Stopping the writer and hand-making the two artefacts reaches the same
     * modes. It cannot reach them *and* leave the writer running, which is why
     * the writer is a check: the forgery becomes a race against a three-second
     * cycle rather than a couple of commands.
     */
    const result = await verify({ ...SOLVED, writerRunning: false });

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The handoff writer is still running, so what follows is its output',
    ]);
  });

  it('fails when the artefacts are missing entirely rather than reporting them as passed', async () => {
    const result = await verify({ ...SOLVED, artefacts: false });

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toHaveLength(3);
  });
});

// ---------------------------------------------------------- partial progress

describe('progress is reported honestly along the way', () => {
  it('counts the two directory bits without crediting the umask', async () => {
    const result = await verify({ drop: '2770', scratch: '1777' });

    expect(result.passed).toBe(false);
    const passed = result.checks.filter((c) => c.status === 'pass').map((c) => c.label);
    // setgid on the drop is enough for the group to be inherited, so that check
    // goes green with it; the two mode checks still need the umask.
    expect(passed).toContain('The drop passes its group on to new entries, and is no wider than it was');
    expect(passed).toContain('The scratch area is still writable by all, but only owners may delete');
    expect(failed(result.checks)).toContain(
      'The reporting helper no longer runs as its owner, and gained nothing else',
    );
    expect(failed(result.checks)).toContain(
      'A file the writer created is readable by its owner and group, and by nobody else',
    );
  });

  it('treats a leading zero and a bare three-digit mode as the same mode', async () => {
    // The lab writes "0755" and `stat` prints "755". If these ever stopped
    // normalising to each other, the helper check would be unsatisfiable.
    const result = await verify(SOLVED);
    expect(result.checks.find((c) => c.label.startsWith('The reporting helper'))?.status).toBe('pass');
  });
});
