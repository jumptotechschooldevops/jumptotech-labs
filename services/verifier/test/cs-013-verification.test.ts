/**
 * CS-013 — grading the mechanism a race was a proxy for.
 *
 * The curriculum plan graded a `FASTEST=<mode>` verdict from a three-way race
 * between serial, threaded and multi-process runs. That was measured in the
 * real sandbox before anything was written, and it does not survive a busy
 * machine — serial/threaded ratios over four runs at load 22:
 *
 *   CPU-bound : 1.79  0.61  0.84  0.71
 *   I/O-bound : 10.6  2.48  4.00  5.45
 *
 * Those bands nearly touch, so no threshold between them separates honest work
 * from a contended host. The 0.5-CPU quota also makes the plan's expected
 * answer wrong twice over: extra processes cannot run in parallel here, so
 * `serial` won every CPU-bound race.
 *
 * The counters say the same thing exactly. Re-measured at load 37, and again
 * at load 63 with four spinners inside the same container:
 *
 *   n sleeps         -> exactly n voluntary switches   (n = 5, 12, 37)  15/15
 *   pure computation -> exactly 0 voluntary switches                    15/15
 *   n live threads   -> Threads: is exactly n+1                         20/20
 *   cpu.max          -> 0.5, while os.cpu_count() reports the host's     15/15
 *
 * One asynchrony was found and made explicit rather than hidden: `join()`
 * returns before the kernel's thread count settles, so reading `Threads:` once
 * straight afterwards saw 3 rather than 1 in one run of twelve. The task tells
 * the student to poll for the settled count, which is the honest instruction
 * and a true thing about threads.
 *
 * Nothing in this lab is timed, and a test below asserts that.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type LoadedLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const CS_013 = path.join(LABS_DIR, 'cs', 'cs-013-threads-scheduling', 'lab.yaml');
const SANDBOX = 'jtt-lab-000000000013';

const PROGRAM = '/home/student/py/workers.py';
const WRITEUP = '/home/student/ops/threads.txt';

/** A correct program: every reported number is measured and interpolated. */
const SOURCE = [
  '#!/usr/bin/env python3',
  'import hashlib, os, sys, threading, time',
  'def status_field(name):',
  '    for line in open("/proc/self/status"):',
  '        if line.startswith(name):',
  '            return int(line.split()[1])',
  'print(f"UNITS={units} IO_VOLUNTARY={waiting} CPU_VOLUNTARY={computing}")',
  'print(f"STARTED={count} THREADS_DURING={during} THREADS_AFTER={after}")',
  'print(f"CPUS_VISIBLE={visible} CPU_QUOTA={allowed} OVERSUBSCRIBED={oversubscribed}")',
  '',
].join('\n');

const WRITTEN_UP = [
  'WHY_THREADS_DONT_HELP_CPU=gil',
  'WHY_MORE_WORKERS_DIDNT_HELP=quota',
  'BLOCKING_SHOWS_UP_AS=voluntary',
  'POOL_SIZE_SHOULD_FOLLOW=quota',
  '',
].join('\n');

const WRITEUP_TOKENS = [
  'WHY_THREADS_DONT_HELP_CPU=gil',
  'WHY_MORE_WORKERS_DIDNT_HELP=quota',
  'BLOCKING_SHOWS_UP_AS=voluntary',
  'POOL_SIZE_SHOULD_FOLLOW=quota',
] as const;

function switchesRun(units: number, { io = units, cpu = 0 } = {}) {
  return { exitCode: 0, stdout: `UNITS=${units} IO_VOLUNTARY=${io} CPU_VOLUNTARY=${cpu}\n` };
}
function threadsRun(started: number, { during = started + 1, after = 1 } = {}) {
  return {
    exitCode: 0,
    stdout: `STARTED=${started} THREADS_DURING=${during} THREADS_AFTER=${after}\n`,
  };
}
function budgetRun({ visible = 10, quota = '0.5', over = 'yes' } = {}) {
  return {
    exitCode: 0,
    stdout: `CPUS_VISIBLE=${visible} CPU_QUOTA=${quota} OVERSUBSCRIBED=${over}\n`,
  };
}

function runs(overrides: Record<string, { exitCode?: number; stdout?: string }> = {}) {
  return {
    [`${PROGRAM} switches 5`]: switchesRun(5),
    [`${PROGRAM} switches 12`]: switchesRun(12),
    [`${PROGRAM} switches 37`]: switchesRun(37),
    [`${PROGRAM} threads 8`]: threadsRun(8),
    [`${PROGRAM} threads 3`]: threadsRun(3),
    [`${PROGRAM} budget`]: budgetRun(),
    ...overrides,
  };
}

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
  cached ??= await loadLabDefinition(CS_013);
  return cached;
}
async function verify(world: FakeWorld) {
  return verifyLab({ lab: await lab(), sandbox: new FakeSandbox(world), namespace: SANDBOX });
}
function failed(checks: readonly { status: string; label: string }[]): string[] {
  return checks.filter((c) => c.status === 'fail').map((c) => c.label);
}

describe('CS-013 before the student does anything', () => {
  it('fails every check, and none is skipped', async () => {
    const result = await verify({ files: {}, scripts: {}, commands: {} });
    const definition = await lab();

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(definition.requirements.length);
    expect(result.checks.every((c) => c.status === 'fail')).toBe(true);
  });
});

describe('CS-013 when the counters are actually measured', () => {
  it('passes', async () => {
    const result = await verify(solved());

    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes on a host with a different number of CPUs', async () => {
    // CPUS_VISIBLE is the host's, not the student's. The quota is the
    // platform's and is the same everywhere, so only that is asserted.
    const bigHost = runs({ [`${PROGRAM} budget`]: budgetRun({ visible: 96 }) });

    const result = await verify(solved({ scripts: bigHost }));
    expect(result.passed).toBe(true);
  });
});

describe('CS-013 rejects counts that were not counted', () => {
  it('rejects a program that reports the same switch count whatever it is asked', async () => {
    const fixed = runs({
      [`${PROGRAM} switches 12`]: switchesRun(12, { io: 5 }),
      [`${PROGRAM} switches 37`]: switchesRun(37, { io: 5 }),
    });

    const result = await verify(solved({ scripts: fixed }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'Twelve waits cost twelve, which is what makes it a count and not a coincidence',
      'An awkward number of waits is counted rather than assumed',
    ]);
  });

  it('rejects computing that appears to have blocked', async () => {
    // Work that yields is not CPU-bound. A student whose "computation" reads a
    // file or sleeps sees a non-zero count, and that is the distinction.
    const yielded = runs({ [`${PROGRAM} switches 12`]: switchesRun(12, { cpu: 4 }) });

    const result = await verify(solved({ scripts: yielded }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'Twelve waits cost twelve, which is what makes it a count and not a coincidence',
    ]);
  });

  it('rejects forgetting that the kernel counts the main thread too', async () => {
    // The off-by-one this measurement invites: eight started, nine alive.
    const offByOne = runs({
      [`${PROGRAM} threads 8`]: threadsRun(8, { during: 8 }),
      [`${PROGRAM} threads 3`]: threadsRun(3, { during: 3 }),
    });

    const result = await verify(solved({ scripts: offByOne }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'Eight live threads read as nine, and as one again once they are done',
      'A different number of threads is read rather than assumed',
    ]);
  });

  it('rejects reading the thread count before it has settled', async () => {
    // join() returns before the kernel's count comes back down. Reading once
    // straight afterwards saw 3 rather than 1 in a real run, which is why the
    // task says to poll for it.
    const unsettled = runs({ [`${PROGRAM} threads 8`]: threadsRun(8, { after: 3 }) });

    const result = await verify(solved({ scripts: unsettled }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'Eight live threads read as nine, and as one again once they are done',
    ]);
  });

  it('rejects reading the reported CPU count as though it were the allowance', async () => {
    // The bug in the story, reproduced in the student's own program: taking
    // os.cpu_count() for the budget and concluding there is room.
    const confused = runs({
      [`${PROGRAM} budget`]: budgetRun({ quota: '10', over: 'no' }),
    });

    const result = await verify(solved({ scripts: confused }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The CPU the container may use is found, and the pool is larger than it',
    ]);
  });
});

describe('CS-013 rejects typed-out answers', () => {
  it('rejects a script that types out all six runs', async () => {
    const table = [
      '#!/bin/sh',
      'case "$1$2" in',
      '  switches5) echo "UNITS=5 IO_VOLUNTARY=5 CPU_VOLUNTARY=0" ;;',
      '  switches12) echo "UNITS=12 IO_VOLUNTARY=12 CPU_VOLUNTARY=0" ;;',
      '  switches37) echo "UNITS=37 IO_VOLUNTARY=37 CPU_VOLUNTARY=0" ;;',
      '  threads8) echo "STARTED=8 THREADS_DURING=9 THREADS_AFTER=1" ;;',
      '  threads3) echo "STARTED=3 THREADS_DURING=4 THREADS_AFTER=1" ;;',
      '  budget) echo "CPUS_VISIBLE=10 CPU_QUOTA=0.5 OVERSUBSCRIBED=yes" ;;',
      'esac',
      '',
    ].join('\n');

    const result = await verify(solved({ source: table }));
    expect(result.passed).toBe(false);
    // Every run passes — the script behaves perfectly. The six checks that bar
    // the answers from the source are the whole defence.
    expect(failed(result.checks)).toEqual([
      'The switches are counted rather than contained in the source',
      'The second count is measured rather than contained in the source',
      'Computing costing nothing is measured rather than assumed',
      'The thread count is read from status rather than worked out on paper',
      'The quota is read from the cgroup rather than contained in the source',
      'The comparison is made rather than its answer typed out',
    ]);
  });
});

describe('CS-013 rejects a write-up that guessed', () => {
  it('rejects giving the Python reason for the container problem', async () => {
    // The two questions have different answers, and this is the confusion the
    // lab exists to clear up: the GIL would still be there on an idle host
    // with forty cores, and the quota would not.
    const wrong = WRITTEN_UP.replace('WHY_MORE_WORKERS_DIDNT_HELP=quota', 'WHY_MORE_WORKERS_DIDNT_HELP=gil');

    const result = await verify(solved({ writeup: wrong }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The write-up names the reason that is about this container, not Python',
    ]);
  });

  it('rejects calling a blocking wait an involuntary switch', async () => {
    const wrong = WRITTEN_UP.replace('BLOCKING_SHOWS_UP_AS=voluntary', 'BLOCKING_SHOWS_UP_AS=involuntary');

    const result = await verify(solved({ writeup: wrong }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The write-up says which counter waiting moves']);
  });

  it('rejects sizing the pool from the reported CPU count', async () => {
    const wrong = WRITTEN_UP.replace('POOL_SIZE_SHOULD_FOLLOW=quota', 'POOL_SIZE_SHOULD_FOLLOW=cpu_count');

    const result = await verify(solved({ writeup: wrong }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The write-up says what the pool should have been sized from',
    ]);
  });

  it('rejects a write-up that is missing entirely', async () => {
    const result = await verify(solved({ writeup: '' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toHaveLength(4);
  });
});

describe('CS-013 rejects forged evidence', () => {
  it('rejects a perfect write-up behind a program that does nothing', async () => {
    const result = await verify(solved({ source: '#!/bin/sh\nexit 0\n', scripts: {} }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'Five waits cost five voluntary switches, and computing costs none',
      'Twelve waits cost twelve, which is what makes it a count and not a coincidence',
      'An awkward number of waits is counted rather than assumed',
      'Eight live threads read as nine, and as one again once they are done',
      'A different number of threads is read rather than assumed',
      'The CPU the container may use is found, and the pool is larger than it',
    ]);
  });

  it('rejects a program that is not executable', async () => {
    const result = await verify(solved({ mode: '644' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The program exists and can be run as a program');
  });
});

describe('CS-013 grading hygiene', () => {
  it('grades no duration anywhere: the plan raced, this counts', async () => {
    // The three-way race the plan proposed produced overlapping ratio bands on
    // a busy host. Nothing here asserts a time, a rate, or a speedup.
    const definition = await lab();
    for (const requirement of definition.requirements) {
      const expectations = [
        (requirement as { contains?: string }).contains ?? '',
        ...((requirement as { output_contains?: string[] }).output_contains ?? []),
      ];
      for (const expectation of expectations) {
        expect(expectation).not.toMatch(/SECONDS|ELAPSED|FASTEST|SPEEDUP|_MS\b|DURATION/i);
      }
    }
  });

  it('never asserts the host CPU count, which is not a property of the student', async () => {
    const budget = (await lab()).requirements.find(
      (r) => r.type === 'script_runs' && (r as { args: string[] }).args[0] === 'budget',
    ) as { output_contains: string[] };

    expect(budget.output_contains).toContain('CPUS_VISIBLE=');
    for (const expectation of budget.output_contains) {
      expect(expectation).not.toMatch(/CPUS_VISIBLE=\d/);
    }
    // The quota is the platform's own setting, so it is asserted.
    expect(budget.output_contains).toContain('CPU_QUOTA=0.5');
  });

  it('asks for three switch counts and two thread counts, so no single answer fits', async () => {
    const args = (await lab()).requirements
      .filter((r) => r.type === 'script_runs')
      .map((r) => (r as { args: string[] }).args.join(' '));

    expect(args).toEqual([
      'switches 5',
      'switches 12',
      'switches 37',
      'threads 8',
      'threads 3',
      'budget',
    ]);
  });

  it('keeps the counts and the write-up answers out of the failure details', async () => {
    const broken = runs();
    for (const key of Object.keys(broken)) {
      (broken as Record<string, { exitCode: number; stdout: string }>)[key] = {
        exitCode: 9,
        stdout: 'nope\n',
      };
    }

    const result = await verify(
      solved({ source: '#!/bin/sh\nexit 9\n', scripts: broken, writeup: 'nope\n' }),
    );
    for (const check of result.checks) {
      expect(check.detail ?? '', check.label).not.toMatch(
        /IO_VOLUNTARY=\d|THREADS_DURING=\d|CPU_QUOTA=0\.5|OVERSUBSCRIBED=|=gil|=quota|=voluntary/,
      );
    }
  });

  it('grades only the student’s own artifacts, never the seeded worker', async () => {
    const sandbox = new FakeSandbox(solved());
    await verifyLab({ lab: await lab(), sandbox, namespace: SANDBOX });

    expect(new Set(sandbox.reads)).toEqual(new Set([PROGRAM]));
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

  it('needs no capability beyond the one every CS lab already asks for', async () => {
    const definition = await lab();
    expect(definition.environment.capabilities).toEqual(['unprivileged_shell']);
    for (const requirement of definition.requirements) {
      expect(JSON.stringify(requirement)).not.toMatch(/SYS_ADMIN|SYS_NICE|privileged|ptrace/i);
    }
  });
});
