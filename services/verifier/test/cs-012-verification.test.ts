/**
 * CS-012 — grading the kernel boundary without a debugger and without a timer.
 *
 * The curriculum plan had the student read /proc/<pid>/syscall for a *seeded*
 * blocked process. That was checked rather than assumed and it does not work:
 * the file is guarded by PTRACE_MODE_ATTACH_FSCREDS, so an unprivileged student
 * reading a root-owned process gets EPERM. The process the student inspects is
 * therefore one they fork — same user, and a descendant, the only combination
 * that also works on a host with Yama ptrace_scope=1.
 *
 * No strace (absent from the image), no SYS_PTRACE (not in
 * GRANTABLE_CAPABILITIES), no capability added.
 *
 * Two things are deliberately not graded:
 *
 *   the syscall NUMBER   per-architecture — `read` is 63 on aarch64 and 0 on
 *                        x86_64 — so the lab asserts the NAME and only requires
 *                        the number to be printed
 *   elapsed time         the blocked child is found by polling for a state, and
 *                        no requirement distinguishes a fast run from a slow one
 *
 * What makes the rest exact is `syscw` in /proc/self/io. Measured in the real
 * image: 200 unbuffered writes move it by exactly 200, and the same 200 lines
 * through a buffer move it by exactly 1 — 10/10 runs at each of three counts.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type LoadedLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const CS_012 = path.join(LABS_DIR, 'cs', 'cs-012-syscalls', 'lab.yaml');
const SANDBOX = 'jtt-lab-000000000012';

const PROBE = '/home/student/py/probe.py';
const WRITEUP = '/home/student/ops/syscalls.txt';

/** A correct probe: every reported value is interpolated or looked up. */
const SOURCE = [
  '#!/usr/bin/env python3',
  'import io, os, sys, time',
  'TABLE = "/srv/kestrel/printer/syscall-table.txt"',
  'def write_syscalls():',
  '    for line in open("/proc/self/io"):',
  '        if line.startswith("syscw"):',
  '            return int(line.split()[1])',
  'child = os.fork()',
  'number = open(f"/proc/{child}/syscall").read().split()[0]',
  'print(f"BLOCKED_SYSCALL={names.get(number)} BLOCKED_NUMBER={number}")',
  'print(f"LINES={count} UNBUFFERED_WRITES={unbuffered} BUFFERED_WRITES={buffered}")',
  '',
].join('\n');

const WRITTEN_UP = [
  'BLOCKED_SYSCALL=read',
  'PRINTER_IS=unbuffered',
  'SYSCALLS_SAVED_BY_BUFFERING=199',
  '',
].join('\n');

const WRITEUP_TOKENS = [
  'BLOCKED_SYSCALL=read',
  'PRINTER_IS=unbuffered',
  'SYSCALLS_SAVED_BY_BUFFERING=199',
] as const;

/** One `writes <n>` run, as a correct probe prints it. */
function writesRun(lines: number, { unbuffered = lines, buffered = 1 } = {}) {
  return {
    exitCode: 0,
    stdout: `LINES=${lines} UNBUFFERED_WRITES=${unbuffered} BUFFERED_WRITES=${buffered}\n`,
  };
}

/** The `blocked` run. The number is the machine's; the name is the answer. */
function blockedRun({ name = 'read', number = '63' } = {}) {
  return { exitCode: 0, stdout: `BLOCKED_SYSCALL=${name} BLOCKED_NUMBER=${number}\n` };
}

function runs(overrides: Record<string, { exitCode?: number; stdout?: string }> = {}) {
  return {
    [`${PROBE} blocked`]: blockedRun(),
    [`${PROBE} writes 200`]: writesRun(200),
    [`${PROBE} writes 50`]: writesRun(50),
    [`${PROBE} writes 137`]: writesRun(137),
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
  if (source !== undefined) files[PROBE] = { content: source, mode };
  return { files, scripts, commands };
}

let cached: LoadedLabDefinition | undefined;
async function lab(): Promise<LoadedLabDefinition> {
  cached ??= await loadLabDefinition(CS_012);
  return cached;
}
async function verify(world: FakeWorld) {
  return verifyLab({ lab: await lab(), sandbox: new FakeSandbox(world), namespace: SANDBOX });
}
function failed(checks: readonly { status: string; label: string }[]): string[] {
  return checks.filter((c) => c.status === 'fail').map((c) => c.label);
}

describe('CS-012 before the student does anything', () => {
  it('fails every check, and none is skipped', async () => {
    const result = await verify({ files: {}, scripts: {}, commands: {} });
    const definition = await lab();

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(definition.requirements.length);
    expect(result.checks.every((c) => c.status === 'fail')).toBe(true);
  });
});

describe('CS-012 when the boundary is found and priced', () => {
  it('passes', async () => {
    const result = await verify(solved());

    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes on a machine where read has a different syscall number', async () => {
    // The same lab on x86_64, where `read` is 0 rather than 63. The name is the
    // answer; the number is a property of the machine and is never asserted.
    const onX86 = runs({ [`${PROBE} blocked`]: blockedRun({ number: '0' }) });

    const result = await verify(solved({ scripts: onX86 }));
    expect(result.passed).toBe(true);
  });
});

describe('CS-012 rejects a probe that did not measure', () => {
  it('rejects one that reports the same count whatever it is asked for', async () => {
    // Passes the run it was written for and fails the other two, which is why
    // the lab asks for three different line counts.
    const fixed = runs({
      [`${PROBE} writes 50`]: writesRun(50, { unbuffered: 200 }),
      [`${PROBE} writes 137`]: writesRun(137, { unbuffered: 200 }),
    });

    const result = await verify(solved({ scripts: fixed }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'Fewer lines cost proportionally fewer crossings',
      'An awkward number of lines is counted rather than assumed',
    ]);
  });

  it('rejects one that claims buffering costs nothing at all', async () => {
    // Buffering does not remove the boundary crossing, it amortises it. The
    // flush is still one write.
    const noFlush = runs({ [`${PROBE} writes 200`]: writesRun(200, { buffered: 0 }) });

    const result = await verify(solved({ scripts: noFlush }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['Two hundred lines cost two hundred crossings, or exactly one']);
  });

  it('rejects one that measured the buffered path as if it were unbuffered', async () => {
    const unbuffered = runs({ [`${PROBE} writes 200`]: writesRun(200, { buffered: 200 }) });

    const result = await verify(solved({ scripts: unbuffered }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['Two hundred lines cost two hundred crossings, or exactly one']);
  });

  it('rejects a probe that never looked up the name', async () => {
    // Reading the number and stopping there. The number is not the answer: it
    // means nothing on another machine.
    const numberOnly = runs({ [`${PROBE} blocked`]: { exitCode: 0, stdout: 'BLOCKED_NUMBER=63\n' } });

    const result = await verify(solved({ scripts: numberOnly }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The call a blocked process is sitting in is found and named',
    ]);
  });

  it('rejects a probe that never read the number', async () => {
    const nameOnly = runs({
      [`${PROBE} blocked`]: { exitCode: 0, stdout: 'BLOCKED_SYSCALL=read\n' },
    });

    const result = await verify(solved({ scripts: nameOnly }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The call a blocked process is sitting in is found and named',
    ]);
  });

  it('rejects naming the call the child was not in', async () => {
    // A probe that read /proc/self/syscall instead of the child's is sitting in
    // whatever it used to read the file.
    const wrong = runs({ [`${PROBE} blocked`]: blockedRun({ name: 'clock_nanosleep', number: '115' }) });

    const result = await verify(solved({ scripts: wrong }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The call a blocked process is sitting in is found and named',
    ]);
  });
});

describe('CS-012 rejects typed-out answers', () => {
  it('rejects a script that types out all four runs', async () => {
    // Behaves perfectly on every run without forking or reading /proc. The five
    // checks that bar the answers from the source are the whole defence.
    const table = [
      '#!/bin/sh',
      'case "$1$2" in',
      '  blocked) echo "BLOCKED_SYSCALL=read BLOCKED_NUMBER=63" ;;',
      '  writes200) echo "LINES=200 UNBUFFERED_WRITES=200 BUFFERED_WRITES=1" ;;',
      '  writes50) echo "LINES=50 UNBUFFERED_WRITES=50 BUFFERED_WRITES=1" ;;',
      '  writes137) echo "LINES=137 UNBUFFERED_WRITES=137 BUFFERED_WRITES=1" ;;',
      'esac',
      '',
    ].join('\n');

    const result = await verify(solved({ source: table }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The crossings are counted rather than contained in the source',
      'The awkward count is measured rather than contained in the source',
      'The buffered cost is measured rather than assumed to be one',
      'The line count is echoed from the argument rather than typed out',
      'The call is decoded from the table rather than named in the source',
    ]);
  });
});

describe('CS-012 rejects a write-up that guessed', () => {
  it('rejects calling the production printer buffered', async () => {
    const wrong = WRITTEN_UP.replace('PRINTER_IS=unbuffered', 'PRINTER_IS=buffered');

    const result = await verify(solved({ writeup: wrong }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The write-up says what the production printer actually does',
    ]);
  });

  it('rejects saving all two hundred crossings rather than all but one', async () => {
    // Buffering does not make the writes free — it makes them one.
    const wrong = WRITTEN_UP.replace(
      'SYSCALLS_SAVED_BY_BUFFERING=199',
      'SYSCALLS_SAVED_BY_BUFFERING=200',
    );

    const result = await verify(solved({ writeup: wrong }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The write-up puts a number on what buffering is worth',
    ]);
  });

  it('rejects a write-up that is missing entirely', async () => {
    const result = await verify(solved({ writeup: '' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toHaveLength(3);
  });
});

describe('CS-012 rejects forged evidence', () => {
  it('rejects a perfect write-up behind a probe that does nothing', async () => {
    const result = await verify(solved({ source: '#!/bin/sh\nexit 0\n', scripts: {} }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The call a blocked process is sitting in is found and named',
      'Two hundred lines cost two hundred crossings, or exactly one',
      'Fewer lines cost proportionally fewer crossings',
      'An awkward number of lines is counted rather than assumed',
    ]);
  });

  it('rejects a probe that is not executable', async () => {
    const result = await verify(solved({ mode: '644' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The probe exists and can be run as a program');
  });
});

describe('CS-012 grading hygiene', () => {
  it('never asserts a syscall number, because numbers are per-architecture', async () => {
    const definition = await lab();
    for (const requirement of definition.requirements) {
      const expectations = [
        (requirement as { contains?: string }).contains ?? '',
        ...((requirement as { output_contains?: string[] }).output_contains ?? []),
      ];
      for (const expectation of expectations) {
        // `BLOCKED_NUMBER=` on its own is a presence check, not a value.
        expect(expectation).not.toMatch(/BLOCKED_NUMBER=\d/);
      }
    }
  });

  it('requires the number to be printed even though its value is not graded', async () => {
    const blocked = (await lab()).requirements.find(
      (r) => r.type === 'script_runs' && (r as { args: string[] }).args[0] === 'blocked',
    ) as { output_contains: string[] };

    expect(blocked.output_contains).toContain('BLOCKED_NUMBER=');
    expect(blocked.output_contains).toContain('BLOCKED_SYSCALL=read');
  });

  it('grades no wall-clock time: every run is bounded but none is timed', async () => {
    for (const requirement of (await lab()).requirements) {
      if (requirement.type !== 'script_runs') continue;
      expect(requirement.timeout_seconds).toBeGreaterThanOrEqual(30);
      expect(requirement.expected_exit_code).toBe(0);
    }
  });

  it('asks for three different line counts, so no single answer satisfies them', async () => {
    const counts = (await lab()).requirements
      .filter((r) => r.type === 'script_runs' && (r as { args: string[] }).args[0] === 'writes')
      .map((r) => (r as { args: string[] }).args[1]);

    expect(counts).toEqual(['200', '50', '137']);
    expect(new Set(counts).size).toBe(3);
  });

  it('keeps the counts and the call name out of the failure details', async () => {
    const broken = runs({
      [`${PROBE} blocked`]: { exitCode: 9, stdout: 'nope\n' },
      [`${PROBE} writes 200`]: { exitCode: 9, stdout: 'nope\n' },
      [`${PROBE} writes 50`]: { exitCode: 9, stdout: 'nope\n' },
      [`${PROBE} writes 137`]: { exitCode: 9, stdout: 'nope\n' },
    });

    const result = await verify(
      solved({ source: '#!/bin/sh\nexit 9\n', scripts: broken, writeup: 'nope\n' }),
    );
    for (const check of result.checks) {
      expect(check.detail ?? '', check.label).not.toMatch(
        /UNBUFFERED_WRITES=\d|BLOCKED_SYSCALL=read|SAVED_BY_BUFFERING=\d|PRINTER_IS=\w/,
      );
    }
  });

  it('grades only the student’s own artifacts, never the seeded printer', async () => {
    const sandbox = new FakeSandbox(solved());
    await verifyLab({ lab: await lab(), sandbox, namespace: SANDBOX });

    expect(new Set(sandbox.reads)).toEqual(new Set([PROBE]));
    expect(sandbox.scriptRuns).toEqual([
      `${PROBE} blocked`,
      `${PROBE} writes 200`,
      `${PROBE} writes 50`,
      `${PROBE} writes 137`,
    ]);
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

  it('needs no debugger and no capability: nothing names strace or ptrace', async () => {
    const definition = await lab();
    for (const requirement of definition.requirements) {
      expect(JSON.stringify(requirement)).not.toMatch(/strace|ltrace|ptrace|SYS_PTRACE/i);
    }
    // The lab asks for the same capability every other CS lab asks for, and
    // nothing else.
    expect(definition.environment.capabilities).toEqual(['unprivileged_shell']);
  });
});
