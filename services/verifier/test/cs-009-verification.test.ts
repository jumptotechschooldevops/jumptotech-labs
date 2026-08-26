/**
 * CS-009 — grading how wide a `try` was cast, without reading the `try`.
 *
 * The lab's real subject is a judgement call: handle the failures you can
 * describe, let the rest escape. Grepping the student's source for
 * `except Exception` would grade what they typed, and would fail a correct
 * solution that mentions the phrase in a comment.
 *
 * So the fourth ledger path is a *directory*. Opening it raises
 * IsADirectoryError, and where that error ends up is a behaviour rather than a
 * source pattern:
 *
 *   narrow catching       escapes — traceback, exit 1, which the lab requires
 *   except OSError        swallowed — the program reports missing-input, exit 2
 *   except Exception      swallowed — same, exit 2
 *
 * Verified against Python 3.11 in the real sandbox image, not assumed:
 * IsADirectoryError is a subclass of OSError but *not* of FileNotFoundError,
 * so a handler narrow enough to be correct cannot catch it by accident, and one
 * wide enough to be wrong cannot avoid catching it.
 *
 * The other half of the file is the shortcut. Four paths with four fixed
 * outcomes is a table a shell script could type out, which is what the three
 * `file_content_absent` checks exist to make expensive — and what the last
 * describe block proves is actually rejected.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type LoadedLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const CS_009 = path.join(LABS_DIR, 'cs', 'cs-009-errors-exceptions', 'lab.yaml');
const SANDBOX = 'jtt-lab-000000000009';

const PROGRAM = '/home/student/py/reconcile.py';
const WRITEUP = '/home/student/ops/errors.txt';

const GOOD = '/srv/kestrel/ledger/ledger-2026-08-24';
const MISSING = '/srv/kestrel/ledger/ledger-2026-08-25';
const TORN = '/srv/kestrel/ledger/ledger-torn';
const ARCHIVE = '/srv/kestrel/ledger/ledger-archive';

/**
 * A correct solution's source, in the shape a correct one actually has: the
 * reported values are interpolated, so none of the graded literals appears.
 */
const SOURCE = [
  '#!/usr/bin/env python3',
  'import sys',
  'try:',
  '    handle = open(sys.argv[1], encoding="utf-8")',
  'except FileNotFoundError:',
  '    print("RECONCILE_ERROR=missing-input", file=sys.stderr)',
  '    sys.exit(2)',
  'print(f"RECONCILED={count} TOTAL={total}")',
  '',
].join('\n');

/** What the traceback of an uncaught IsADirectoryError looks like. */
const TRACEBACK = [
  'Traceback (most recent call last):',
  `  File "${PROGRAM}", line 9, in main`,
  '    handle = open(path, encoding="utf-8")',
  `IsADirectoryError: [Errno 21] Is a directory: '${ARCHIVE}'`,
  '',
].join('\n');

const WRITTEN_UP = ['UNCAUGHT_TYPE=IsADirectoryError', 'UNCAUGHT_EXIT=1', ''].join('\n');

/** The four runs a correct reconciliation produces. */
function runs(): FakeWorld['scripts'] {
  return {
    [`${PROGRAM} ${GOOD}`]: { exitCode: 0, stdout: 'RECONCILED=6 TOTAL=8484\n' },
    [`${PROGRAM} ${MISSING}`]: { exitCode: 2, stderr: 'RECONCILE_ERROR=missing-input\n' },
    [`${PROGRAM} ${TORN}`]: { exitCode: 3, stderr: 'RECONCILE_ERROR=malformed-record line=3\n' },
    [`${PROGRAM} ${ARCHIVE}`]: { exitCode: 1, stderr: TRACEBACK },
  };
}

interface World {
  source?: string;
  scripts?: FakeWorld['scripts'];
  writeup?: string;
  mode?: string;
}

function solved({ source = SOURCE, scripts = runs(), writeup = WRITTEN_UP, mode = '755' }: World = {}): FakeWorld {
  const files: FakeWorld['files'] = {};
  if (source !== undefined) files[PROGRAM] = { content: source, mode };
  if (writeup !== undefined) files[WRITEUP] = { content: writeup, mode: '644' };
  return { files, scripts };
}

let cached: LoadedLabDefinition | undefined;
async function lab(): Promise<LoadedLabDefinition> {
  cached ??= await loadLabDefinition(CS_009);
  return cached;
}
async function verify(world: FakeWorld) {
  return verifyLab({ lab: await lab(), sandbox: new FakeSandbox(world), namespace: SANDBOX });
}
function failed(checks: readonly { status: string; label: string }[]): string[] {
  return checks.filter((c) => c.status === 'fail').map((c) => c.label);
}

describe('CS-009 before the student does anything', () => {
  it('fails every check, and none is skipped', async () => {
    const result = await verify({ files: {}, scripts: {} });
    const definition = await lab();

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(definition.requirements.length);
    expect(result.checks.every((c) => c.status === 'fail')).toBe(true);
  });
});

describe('CS-009 when each failure is told apart from the others', () => {
  it('passes', async () => {
    const result = await verify(solved());

    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes a solution that handles each failure where it happens', async () => {
    // No single `try` around the whole body: the open is guarded on its own and
    // the amount is converted inside its own handler. Same behaviour, and the
    // shape the level-3 hint points at.
    const perSite = [
      '#!/usr/bin/env python3',
      'import sys',
      'path = sys.argv[1]',
      'try:',
      '    handle = open(path, encoding="utf-8")',
      'except FileNotFoundError:',
      '    sys.exit(report_missing())',
      'for number, line in enumerate(handle, start=1):',
      '    try:',
      '        total += int(line.rsplit(",", 1)[1])',
      '    except ValueError:',
      '        print(f"RECONCILE_ERROR=malformed-record line={number}", file=sys.stderr)',
      '        sys.exit(3)',
      '',
    ].join('\n');

    const result = await verify(solved({ source: perSite }));
    expect(result.passed).toBe(true);
  });
});

describe('CS-009 rejects catching more than the program can describe', () => {
  it('rejects `except OSError`, which swallows the path that is not a file', async () => {
    // OSError is the parent of both FileNotFoundError and IsADirectoryError, so
    // the archive path is reported as a missing input and exits 2. Verified on
    // Python 3.11: this is what the over-broad program actually does.
    const swallowed = {
      ...runs(),
      [`${PROGRAM} ${ARCHIVE}`]: { exitCode: 2, stderr: 'RECONCILE_ERROR=missing-input\n' },
    };

    const result = await verify(solved({ scripts: swallowed }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'A failure the program cannot describe is allowed to reach the caller',
    ]);
  });

  it('rejects `except Exception`, whatever it decides to report', async () => {
    const swallowed = {
      ...runs(),
      [`${PROGRAM} ${ARCHIVE}`]: { exitCode: 3, stderr: 'RECONCILE_ERROR=malformed-record line=1\n' },
    };

    const result = await verify(solved({ scripts: swallowed }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'A failure the program cannot describe is allowed to reach the caller',
    ]);
  });

  it('rejects the production job, which reports success on everything', async () => {
    // `except: pass` and `return 0`. Three weeks of green nights, graded here
    // as three failures — only the ledger that genuinely reconciles passes.
    const silent = {
      [`${PROGRAM} ${GOOD}`]: { exitCode: 0, stdout: 'RECONCILED=6 TOTAL=8484\n' },
      [`${PROGRAM} ${MISSING}`]: { exitCode: 0, stdout: '' },
      [`${PROGRAM} ${TORN}`]: { exitCode: 0, stdout: '' },
      [`${PROGRAM} ${ARCHIVE}`]: { exitCode: 0, stdout: '' },
    };

    const result = await verify(solved({ scripts: silent }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'A ledger that is not there is reported as a missing input',
      'A record with no usable amount is reported, with the line it was on',
      'A failure the program cannot describe is allowed to reach the caller',
    ]);
  });
});

describe('CS-009 rejects the near misses', () => {
  it('rejects the right exit status reported with the wrong line', async () => {
    // Counting only the records it parsed rather than every line in the file
    // puts the torn record on line 2. The status is right and the finding is
    // not, which is why the line number is graded.
    const offByOne = {
      ...runs(),
      [`${PROGRAM} ${TORN}`]: { exitCode: 3, stderr: 'RECONCILE_ERROR=malformed-record line=2\n' },
    };

    const result = await verify(solved({ scripts: offByOne }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'A record with no usable amount is reported, with the line it was on',
    ]);
  });

  it('rejects one exit status used for every failure', async () => {
    const undifferentiated = {
      ...runs(),
      [`${PROGRAM} ${MISSING}`]: { exitCode: 1, stderr: 'RECONCILE_ERROR=missing-input\n' },
      [`${PROGRAM} ${TORN}`]: { exitCode: 1, stderr: 'RECONCILE_ERROR=malformed-record line=3\n' },
    };

    const result = await verify(solved({ scripts: undifferentiated }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'A ledger that is not there is reported as a missing input',
      'A record with no usable amount is reported, with the line it was on',
    ]);
  });

  it('rejects a write-up naming the exception the program handled instead', async () => {
    // FileNotFoundError is the one they caught; it is not the one that got out.
    const wrong = ['UNCAUGHT_TYPE=FileNotFoundError', 'UNCAUGHT_EXIT=1', ''].join('\n');

    const result = await verify(solved({ writeup: wrong }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The write-up names the exception the traceback ended with']);
  });

  it('rejects a write-up that records the exit status the old job returned', async () => {
    const wrong = ['UNCAUGHT_TYPE=IsADirectoryError', 'UNCAUGHT_EXIT=0', ''].join('\n');

    const result = await verify(solved({ writeup: wrong }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The write-up records what an uncaught exception does to the exit status',
    ]);
  });

  it('rejects a program that is not executable', async () => {
    const result = await verify(solved({ mode: '644' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The reconciliation exists and can be run as a program');
  });
});

describe('CS-009 and the two ways of letting the error out', () => {
  it('passes a broad handler that re-raises what it cannot describe', async () => {
    // `except OSError` is only wrong when it *swallows*. Re-raising anything
    // that is not a missing file leaves the archive path escaping exactly as a
    // narrow handler would, and it is graded on that behaviour, not the shape.
    const result = await verify(solved());
    expect(result.passed).toBe(true);
  });

  it('accepts a hand-printed traceback, which is a known and deliberate limit', async () => {
    // A student who catches IsADirectoryError by name and prints the traceback
    // themselves reaches exit 1 with both tokens on stderr, and passes.
    //
    // This is accepted rather than defended against. Writing it requires
    // knowing which exception escapes, that it is IsADirectoryError, that an
    // uncaught exception exits 1, and what a traceback looks like — which is
    // the whole objective. It is more work than the correct solution and
    // cannot be discovered without doing the exercise, so it is a long way
    // round rather than a shortcut. Recorded in labs/cs/SOURCES.md.
    const handPrinted = {
      ...runs(),
      [`${PROGRAM} ${ARCHIVE}`]: {
        exitCode: 1,
        stderr: 'Traceback (most recent call last):\nIsADirectoryError: [Errno 21]\n',
      },
    };

    const result = await verify(solved({ scripts: handPrinted }));
    expect(result.passed).toBe(true);
  });
});

describe('CS-009 rejects forged evidence and typed-out answers', () => {
  it('rejects a table of the four outcomes matched on the argument', async () => {
    // A shell script that never opens a ledger and behaves perfectly on all
    // four paths. Every `script_runs` check passes; the three checks that bar
    // the computed answers from the source are what stop it.
    const table = [
      '#!/bin/sh',
      'case "$1" in',
      '  *ledger-2026-08-24) echo "RECONCILED=6 TOTAL=8484"; exit 0 ;;',
      '  *ledger-torn) echo "RECONCILE_ERROR=malformed-record line=3" >&2; exit 3 ;;',
      '  *ledger-archive) printf "Traceback\\nIsADirectoryError\\n" >&2; exit 1 ;;',
      '  *) echo "RECONCILE_ERROR=missing-input" >&2; exit 2 ;;',
      'esac',
      '',
    ].join('\n');

    const result = await verify(solved({ source: table }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The reconciliation counts the records rather than containing the count',
      'The reconciliation adds the amounts rather than containing the sum',
      'The reconciliation locates the bad record rather than containing its position',
    ]);
  });

  it('rejects a perfect write-up behind a program that does nothing', async () => {
    // The write-up is student-written, so it is only safe to grade because the
    // program is graded independently by being run. Forging the deliverable
    // alone reaches 4 of 11 and never passes.
    const result = await verify(solved({ source: '#!/bin/sh\nexit 0\n', scripts: {} }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'A ledger that reconciles reports its totals and succeeds',
      'A ledger that is not there is reported as a missing input',
      'A record with no usable amount is reported, with the line it was on',
      'A failure the program cannot describe is allowed to reach the caller',
    ]);
  });
});

describe('CS-009 grading hygiene', () => {
  it('keeps the expected totals, line number and exception out of the failure details', async () => {
    const broken: FakeWorld['scripts'] = {
      [`${PROGRAM} ${GOOD}`]: { exitCode: 9, stdout: 'nope\n' },
      [`${PROGRAM} ${MISSING}`]: { exitCode: 9, stdout: 'nope\n' },
      [`${PROGRAM} ${TORN}`]: { exitCode: 9, stdout: 'nope\n' },
      [`${PROGRAM} ${ARCHIVE}`]: { exitCode: 9, stdout: 'nope\n' },
    };

    const result = await verify(solved({ source: '#!/bin/sh\nexit 9\n', scripts: broken, writeup: 'nope\n' }));
    for (const check of result.checks) {
      expect(check.detail ?? '', check.label).not.toMatch(
        /RECONCILED=6|TOTAL=8484|line=3|IsADirectoryError|UNCAUGHT_EXIT=/,
      );
    }
  });

  it('grades only the student’s own artifacts, never the seeded ledgers or the job', async () => {
    const sandbox = new FakeSandbox(solved());
    await verifyLab({ lab: await lab(), sandbox, namespace: SANDBOX });

    expect(new Set(sandbox.reads)).toEqual(new Set([PROGRAM, WRITEUP]));
    expect(sandbox.scriptRuns).toEqual([
      `${PROGRAM} ${GOOD}`,
      `${PROGRAM} ${MISSING}`,
      `${PROGRAM} ${TORN}`,
      `${PROGRAM} ${ARCHIVE}`,
    ]);
  });

  it('runs the student’s own program every time, and bounds every run', async () => {
    for (const requirement of (await lab()).requirements) {
      if (requirement.type !== 'script_runs') continue;
      // No seeded grading harness: the thing being run is always what the
      // student wrote, against a ledger path they were told about.
      expect(requirement.path).toBe(PROGRAM);
      expect(requirement.args).toHaveLength(1);
      expect(requirement.args[0]).toMatch(/^\/srv\/kestrel\/ledger\//);
      expect(requirement.timeout_seconds).toBeGreaterThan(0);
      expect(requirement.timeout_seconds).toBeLessThanOrEqual(60);
    }
  });

  it('never grades the seeded job, which a student cannot change anyway', async () => {
    const graded = (await lab()).requirements
      .map((r) => (r as { path?: string }).path ?? '')
      .filter(Boolean);

    for (const target of graded) expect(target).toMatch(/^\/home\/student\//);
  });
});
