/**
 * CS-011 — grading a process lifecycle without grading a stopwatch.
 *
 * The curriculum plan proposed catching "never reaps" with a short
 * `timeout_seconds`, so a program that does not wait fails by hanging. That
 * grades the machine as much as the student, and this repository has already
 * seen container reads go slow under load, so it was replaced with an outcome
 * grade: the state read out of /proc, the raw status waitpid returned, and
 * whether the /proc entry is gone afterwards. All three are values. None is a
 * delay.
 *
 * The discriminator is the raw wait status. The exit code is handed to the
 * program at run time and the raw status is that code shifted left by eight —
 * measured in the real image, not assumed: 7 -> 1792, 3 -> 768, 0 -> 0. Three
 * runs with three codes means a fixed answer fails two of them, and the numbers
 * are barred from the source, so they have to come from the kernel.
 *
 * What is deliberately NOT graded is the identity of PID 1: that is whatever
 * the container provider runs, not a property of the lesson.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type LoadedLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const CS_011 = path.join(LABS_DIR, 'cs', 'cs-011-process-lifecycle', 'lab.yaml');
const SANDBOX = 'jtt-lab-000000000011';

const PROGRAM = '/home/student/py/spawn.py';
const WRITEUP = '/home/student/ops/zombies.txt';

/** exit code -> the raw wait status the kernel returns, as measured. */
const RAW: Record<string, number> = { '7': 1792, '3': 768, '0': 0 };

/** A correct program: every reported value is interpolated. */
const SOURCE = [
  '#!/usr/bin/env python3',
  'import os, sys, time',
  'def state_of(pid):',
  '    try:',
  '        return open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[0]',
  '    except FileNotFoundError:',
  '        return None',
  'code = int(sys.argv[1])',
  'child = os.fork()',
  'if child == 0:',
  '    os._exit(code)',
  'print(f"PARENT={os.getpid()} CHILD={child}")',
  'seen = state_of(child)',
  'while seen != "Z":',
  '    seen = state_of(child)',
  'print(f"CHILD_STATE={seen}")',
  'reaped, raw = os.waitpid(child, 0)',
  'print(f"REAPED={reaped} STATUS={os.waitstatus_to_exitcode(raw)} RAW={raw}")',
  'print(f"CHILD_GONE={\'yes\' if state_of(child) is None else \'no\'}")',
  '',
].join('\n');

const WRITTEN_UP = [
  'ZOMBIE_STATE=Z',
  'RAW_WAIT_STATUS=1792',
  'ORPHAN_PARENT=1',
  'STATE_AFTER_SIGKILL=Z',
  '',
].join('\n');

const WRITEUP_TOKENS = [
  'ZOMBIE_STATE=Z',
  'RAW_WAIT_STATUS=1792',
  'ORPHAN_PARENT=1',
  'STATE_AFTER_SIGKILL=Z',
] as const;

/** One run of a correct program, as it actually prints. */
function run(code: string, { state = 'Z', gone = 'yes', raw = RAW[code], status = code } = {}) {
  return {
    exitCode: 0,
    stdout: [
      'PARENT=94 CHILD=95',
      `CHILD_STATE=${state}`,
      `REAPED=95 STATUS=${status} RAW=${raw}`,
      `CHILD_GONE=${gone}`,
      '',
    ].join('\n'),
  };
}

function runs(overrides: Record<string, { exitCode?: number; stdout?: string }> = {}) {
  return {
    [`${PROGRAM} 7`]: run('7'),
    [`${PROGRAM} 3`]: run('3'),
    [`${PROGRAM} 0`]: run('0'),
    ...overrides,
  };
}

/** `grep -x` over the write-up, emulated so near-miss tests stay honest. */
function inspections(writeup = WRITTEN_UP): FakeWorld['commands'] {
  const commands: FakeWorld['commands'] = {};
  for (const token of WRITEUP_TOKENS) {
    const hit = writeup.split('\n').some((line) => line === token);
    commands[`grep -x ${token} ${WRITEUP}`] = hit
      ? { exitCode: 0, stdout: `${token}\n` }
      : { exitCode: 1, stdout: '' };
  }
  return commands;
}

interface World {
  source?: string;
  scripts?: FakeWorld['scripts'];
  writeup?: string;
  commands?: FakeWorld['commands'];
  mode?: string;
}

function solved({
  source = SOURCE,
  scripts = runs(),
  writeup = WRITTEN_UP,
  commands = inspections(writeup),
  mode = '755',
}: World = {}): FakeWorld {
  const files: FakeWorld['files'] = {};
  if (source !== undefined) files[PROGRAM] = { content: source, mode };
  return { files, scripts, commands };
}

let cached: LoadedLabDefinition | undefined;
async function lab(): Promise<LoadedLabDefinition> {
  cached ??= await loadLabDefinition(CS_011);
  return cached;
}
async function verify(world: FakeWorld) {
  return verifyLab({ lab: await lab(), sandbox: new FakeSandbox(world), namespace: SANDBOX });
}
function failed(checks: readonly { status: string; label: string }[]): string[] {
  return checks.filter((c) => c.status === 'fail').map((c) => c.label);
}

describe('CS-011 before the student does anything', () => {
  it('fails every check, and none is skipped', async () => {
    const result = await verify({ files: {}, scripts: {}, commands: {} });
    const definition = await lab();

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(definition.requirements.length);
    expect(result.checks.every((c) => c.status === 'fail')).toBe(true);
  });
});

describe('CS-011 when the child is made, seen, and collected', () => {
  it('passes', async () => {
    const result = await verify(solved());

    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });
});

describe('CS-011 rejects a program that never collects the child', () => {
  it('rejects one that forks and walks away', async () => {
    // The entrypoint's bug, in Python. It sees the zombie and then leaves it,
    // so it can report a state and nothing after it. No timer is involved:
    // the run ends promptly and is missing two lines it cannot produce.
    const neverWaits = {
      exitCode: 0,
      stdout: ['PARENT=94 CHILD=95', 'CHILD_STATE=Z', ''].join('\n'),
    };

    const result = await verify(
      solved({ scripts: runs({ [`${PROGRAM} 7`]: neverWaits, [`${PROGRAM} 3`]: neverWaits, [`${PROGRAM} 0`]: neverWaits }) }),
    );
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'A child is made, seen as a zombie, collected, and its status reported',
      'A different exit code produces a different wait status',
      'A child that succeeded is still a zombie until it is collected',
    ]);
  });

  it('rejects one that reports the exit code where the raw status belongs', async () => {
    // The single most likely misreading: `RAW` is not the exit code. A program
    // that prints the decoded value twice passes the STATUS half and fails here.
    const conflated = runs({
      [`${PROGRAM} 7`]: run('7', { raw: 7 }),
      [`${PROGRAM} 3`]: run('3', { raw: 3 }),
    });

    const result = await verify(solved({ scripts: conflated }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'A child is made, seen as a zombie, collected, and its status reported',
      'A different exit code produces a different wait status',
    ]);
  });

  it('rejects one that never looked, and reported a live state', async () => {
    // Collecting the child immediately means never seeing the window the lab
    // is about, and the state read back is whatever it was still doing.
    const raced = runs({ [`${PROGRAM} 7`]: run('7', { state: 'S' }) });

    const result = await verify(solved({ scripts: raced }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'A child is made, seen as a zombie, collected, and its status reported',
    ]);
  });

  it('rejects one that claims the child is still there after collecting it', async () => {
    const stillThere = runs({ [`${PROGRAM} 7`]: run('7', { gone: 'no' }) });

    const result = await verify(solved({ scripts: stillThere }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'A child is made, seen as a zombie, collected, and its status reported',
    ]);
  });
});

describe('CS-011 rejects an answer that does not depend on the argument', () => {
  it('rejects a program that always reports the first run’s numbers', async () => {
    // Passes the run it was written for and fails the other two, which is why
    // the lab runs three exit codes rather than one.
    const fixed = {
      [`${PROGRAM} 7`]: run('7'),
      [`${PROGRAM} 3`]: run('7'),
      [`${PROGRAM} 0`]: run('7'),
    };

    const result = await verify(solved({ scripts: fixed }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'A different exit code produces a different wait status',
      'A child that succeeded is still a zombie until it is collected',
    ]);
  });

  it('rejects a source that contains the numbers instead of reading them', async () => {
    const typedOut = [
      '#!/bin/sh',
      'case "$1" in',
      '  7) echo "PARENT=1 CHILD=2"; echo "CHILD_STATE=Z"; echo "REAPED=2 STATUS=7 RAW=1792" ;;',
      '  3) echo "PARENT=1 CHILD=2"; echo "CHILD_STATE=Z"; echo "REAPED=2 STATUS=3 RAW=768" ;;',
      '  *) echo "PARENT=1 CHILD=2"; echo "CHILD_STATE=Z"; echo "REAPED=2 STATUS=0 RAW=0" ;;',
      'esac',
      'echo "CHILD_GONE=yes"',
      '',
    ].join('\n');

    const result = await verify(solved({ source: typedOut }));
    expect(result.passed).toBe(false);
    // Every run-check passes — the script behaves perfectly. The four checks
    // that bar the answers from the source are the whole defence.
    expect(failed(result.checks)).toEqual([
      'The wait status is read from the kernel rather than contained in the source',
      'The second wait status is read from the kernel too',
      'The exit code is decoded rather than contained in the source',
      "The child's state is read from /proc rather than asserted",
    ]);
  });
});

describe('CS-011 rejects a write-up that guessed', () => {
  it('rejects the exit code where the raw status was asked for', async () => {
    const wrong = WRITTEN_UP.replace('RAW_WAIT_STATUS=1792', 'RAW_WAIT_STATUS=7');

    const result = await verify(solved({ writeup: wrong }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The write-up records the raw status, not the exit code',
    ]);
  });

  it('rejects the belief that SIGKILL removes a zombie', async () => {
    // The thing the team was stuck on. A dead process cannot be killed again.
    const wrong = WRITTEN_UP.replace('STATE_AFTER_SIGKILL=Z', 'STATE_AFTER_SIGKILL=X');

    const result = await verify(solved({ writeup: wrong }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The write-up records that SIGKILL leaves a zombie exactly where it was',
    ]);
  });

  it('rejects the wrong reparenting target', async () => {
    const wrong = WRITTEN_UP.replace('ORPHAN_PARENT=1', 'ORPHAN_PARENT=0');

    const result = await verify(solved({ writeup: wrong }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The write-up records what an orphan is reparented to',
    ]);
  });

  it('rejects a write-up that is missing entirely', async () => {
    const result = await verify(solved({ writeup: '' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toHaveLength(4);
  });
});

describe('CS-011 rejects forged evidence', () => {
  it('rejects a perfect write-up behind a program that does nothing', async () => {
    const result = await verify(solved({ source: '#!/bin/sh\nexit 0\n', scripts: {} }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'A child is made, seen as a zombie, collected, and its status reported',
      'A different exit code produces a different wait status',
      'A child that succeeded is still a zombie until it is collected',
    ]);
  });

  it('rejects a program that is not executable', async () => {
    const result = await verify(solved({ mode: '644' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The program exists and can be run as a program');
  });
});

describe('CS-011 grading hygiene', () => {
  it('grades no wall-clock time: every run is bounded but none is timed', async () => {
    // A generous ceiling exists so a runaway run cannot hang the check, but no
    // requirement distinguishes a fast run from a slow one. What separates a
    // reaping program from a leaking one is which lines it can print.
    for (const requirement of (await lab()).requirements) {
      if (requirement.type !== 'script_runs') continue;
      expect(requirement.timeout_seconds).toBeGreaterThanOrEqual(30);
      expect(requirement.expected_exit_code).toBe(0);
      expect(requirement.output_contains.some((token: string) => /RAW=|CHILD_STATE=/.test(token))).toBe(
        true,
      );
    }
  });

  it('does not grade the identity of PID 1, which is a provider detail', async () => {
    const definition = await lab();
    const expectations = [
      ...definition.requirements.flatMap((r) => [
        (r as { contains?: string }).contains ?? '',
        ...((r as { output_contains?: string[] }).output_contains ?? []),
      ]),
    ];
    for (const expectation of expectations) {
      expect(expectation).not.toMatch(/PID1|pid 1 is|entrypoint\.sh|sleep infinity/i);
    }
  });

  it('keeps the wait statuses and the state characters out of the failure details', async () => {
    const broken = runs({
      [`${PROGRAM} 7`]: { exitCode: 9, stdout: 'nope\n' },
      [`${PROGRAM} 3`]: { exitCode: 9, stdout: 'nope\n' },
      [`${PROGRAM} 0`]: { exitCode: 9, stdout: 'nope\n' },
    });

    const result = await verify(
      solved({ source: '#!/bin/sh\nexit 9\n', scripts: broken, writeup: 'nope\n' }),
    );
    for (const check of result.checks) {
      expect(check.detail ?? '', check.label).not.toMatch(
        /1792|RAW=768|CHILD_STATE=Z|ZOMBIE_STATE|ORPHAN_PARENT|STATE_AFTER_SIGKILL/,
      );
    }
  });

  it('grades only the student’s own artifacts, never the seeded worker', async () => {
    const sandbox = new FakeSandbox(solved());
    await verifyLab({ lab: await lab(), sandbox, namespace: SANDBOX });

    expect(new Set(sandbox.reads)).toEqual(new Set([PROGRAM]));
    expect(sandbox.scriptRuns).toEqual([`${PROGRAM} 7`, `${PROGRAM} 3`, `${PROGRAM} 0`]);
    for (const inspection of sandbox.inspections) {
      expect(inspection).toContain('/home/student/');
    }
  });

  it('grades nothing outside the student’s home', async () => {
    for (const requirement of (await lab()).requirements) {
      const target = (requirement as { path?: string }).path;
      if (target) expect(target).toMatch(/^\/home\/student\//);
      if (requirement.type === 'command_output') {
        for (const arg of (requirement as { args: string[] }).args) {
          if (arg.startsWith('/')) expect(arg).toMatch(/^\/home\/student\//);
        }
      }
    }
  });

  it('runs three different exit codes, so no single answer can satisfy them', async () => {
    const codes = (await lab()).requirements
      .filter((r) => r.type === 'script_runs')
      .map((r) => (r as { args: string[] }).args[0]);

    expect(codes).toEqual(['7', '3', '0']);
    expect(new Set(codes).size).toBe(3);
  });
});
