/**
 * CS-006 — grading a rule rather than a transcript.
 *
 * The curriculum plan sketched this lab with a seeded harness importing the
 * student's `decide`. That design is unsound at any file permission: a harness
 * that imports student code runs it in the same process, so the student's
 * module can print the harness's PASS tokens itself at import time. Root
 * ownership does not help — the attack is on the process, not the file.
 *
 * So the student's program is run directly, and each argument set separates a
 * correct implementation from one specific mistake:
 *
 *   10 9 2   comparing as text: "10" > "9" is False
 *   8 8 2    the target boundary, which is strict
 *   3 1 3    the minimum boundary, which is also strict
 *   1 0 0    truthiness: `if minimum and ...` breaks when the minimum is zero
 *   abc 1 1  input that is not a number
 *
 * Each of the tests below turns one of those into a named regression, so a
 * later edit cannot quietly drop the case that catches a particular bug.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type LoadedLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const CS_006 = path.join(LABS_DIR, 'cs', 'cs-006-types-control-flow', 'lab.yaml');
const SANDBOX = 'jtt-lab-000000000006';

const PROGRAM = '/home/student/py/scale.py';
const READINGS = '/srv/kestrel/scaler/readings.txt';

const SOURCE = [
  '#!/usr/bin/env python3',
  'import sys',
  'def decide(c, t, m):',
  '    if c < t: return "scale-up"',
  '    if c > t and c > m: return "scale-down"',
  '    return "hold"',
  '',
].join('\n');

/** The rule, so the fixture's expectations and the lab's cannot drift apart. */
function decide(current: number, target: number, minimum: number): string {
  if (current < target) return 'scale-up';
  if (current > target && current > minimum) return 'scale-down';
  return 'hold';
}

function line(c: string, t: string, m: string): string {
  return `DECISION=${decide(Number(c), Number(t), Number(m))} current=${c} target=${t} minimum=${m}\n`;
}

const BATCH: Array<[string, string, string]> = [
  ['2', '5', '1'],
  ['12', '9', '2'],
  ['7', '7', '3'],
  ['4', '2', '4'],
  ['9', '3', '2'],
];

/** What a correct program prints for every invocation the lab makes. */
function correctRuns(): FakeWorld['scripts'] {
  const runs: FakeWorld['scripts'] = {};
  for (const [c, t, m] of [
    ['10', '9', '2'],
    ['2', '5', '1'],
    ['8', '8', '2'],
    ['3', '1', '3'],
    ['1', '0', '0'],
  ] as Array<[string, string, string]>) {
    runs[`${PROGRAM} ${c} ${t} ${m}`] = { exitCode: 0, stdout: line(c, t, m) };
  }
  runs[`${PROGRAM} abc 1 1`] = { exitCode: 2, stdout: 'DECISION=invalid\n' };
  runs[`${PROGRAM} --file ${READINGS}`] = {
    exitCode: 0,
    stdout: BATCH.map(([c, t, m]) => line(c, t, m)).join(''),
  };
  return runs;
}

function evidence(): FakeWorld['files'] {
  return {
    '/srv/kestrel/scaler/README.txt': { content: 'autoscaler evidence\n', owner: 'root', mode: '444' },
    [READINGS]: { content: BATCH.map((r) => r.join(' ')).join('\n') + '\n', owner: 'root', mode: '444' },
    '/srv/kestrel/scaler/decisions.log': { content: 'decision=hold\n', owner: 'root', mode: '444' },
  };
}

function worldWith(source: string | undefined, runs = correctRuns(), mode = '755'): FakeWorld {
  const world: FakeWorld = { files: evidence(), scripts: runs };
  if (source !== undefined) world.files![PROGRAM] = { content: source, mode };
  return world;
}

let cached: LoadedLabDefinition | undefined;
async function lab(): Promise<LoadedLabDefinition> {
  cached ??= await loadLabDefinition(CS_006);
  return cached;
}
async function verify(world: FakeWorld) {
  return verifyLab({ lab: await lab(), sandbox: new FakeSandbox(world), namespace: SANDBOX });
}
function failed(checks: readonly { status: string; label: string }[]): string[] {
  return checks.filter((c) => c.status === 'fail').map((c) => c.label);
}

/** Re-run every invocation through a student's (possibly wrong) rule. */
function runsUsing(rule: (c: number, t: number, m: number) => string, invalidExit = 2): FakeWorld['scripts'] {
  const runs: FakeWorld['scripts'] = {};
  const emit = (c: string, t: string, m: string) =>
    `DECISION=${rule(Number(c), Number(t), Number(m))} current=${c} target=${t} minimum=${m}\n`;
  for (const [c, t, m] of [
    ['10', '9', '2'],
    ['2', '5', '1'],
    ['8', '8', '2'],
    ['3', '1', '3'],
    ['1', '0', '0'],
  ] as Array<[string, string, string]>) {
    runs[`${PROGRAM} ${c} ${t} ${m}`] = { exitCode: 0, stdout: emit(c, t, m) };
  }
  runs[`${PROGRAM} abc 1 1`] = { exitCode: invalidExit, stdout: 'DECISION=invalid\n' };
  runs[`${PROGRAM} --file ${READINGS}`] = {
    exitCode: 0,
    stdout: BATCH.map(([c, t, m]) => emit(c, t, m)).join(''),
  };
  return runs;
}

describe('CS-006 before the student does anything', () => {
  it('fails every check, and none is skipped', async () => {
    const result = await verify({ files: evidence(), scripts: {} });
    const definition = await lab();

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(definition.requirements.length);
    expect(result.checks.every((c) => c.status !== 'skipped')).toBe(true);
  });
});

describe('CS-006 when the rule is right', () => {
  it('passes', async () => {
    const result = await verify(worldWith(SOURCE));

    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes an implementation with a different shape entirely', async () => {
    // A generator, string concatenation instead of f-strings, sys.stdout.write
    // instead of print. Same rule, no shared line — the lab grades decisions.
    const alternative = [
      '#!/usr/bin/env python3',
      'import sys',
      'def choose(current, target, minimum):',
      '    now, want, floor = [int(v) for v in (current, target, minimum)]',
      '    if now < want:',
      '        return "scale-up"',
      '    elif now > want and now > floor:',
      '        return "scale-down"',
      '    else:',
      '        return "hold"',
      '',
    ].join('\n');

    const result = await verify(worldWith(alternative));
    expect(result.passed).toBe(true);
  });
});

describe('CS-006 rejects each mistake it is built around', () => {
  it('rejects comparing the values as text', async () => {
    // The seeded helper's actual bug. Only the two-digit case and the batch
    // can see it — "2" < "5" is True, so the simple cases still look fine.
    const asText = (c: number, t: number, m: number) => {
      const [C, T, M] = [String(c), String(t), String(m)];
      if (C < T) return 'scale-up';
      if (C > T && C > M) return 'scale-down';
      return 'hold';
    };

    const result = await verify(worldWith(SOURCE, runsUsing(asText)));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'A two-digit current above a one-digit target scales down',
      'Every reading in the batch gets the decision it should have had',
    ]);
  });

  it('rejects a non-strict target boundary', async () => {
    const loose = (c: number, t: number, m: number) => {
      if (c <= t) return 'scale-up';
      if (c > t && c > m) return 'scale-down';
      return 'hold';
    };

    const result = await verify(worldWith(SOURCE, runsUsing(loose)));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('Equal to target holds rather than scaling');
  });

  it('rejects a non-strict minimum boundary', async () => {
    const loose = (c: number, t: number, m: number) => {
      if (c < t) return 'scale-up';
      if (c > t && c >= m) return 'scale-down';
      return 'hold';
    };

    const result = await verify(worldWith(SOURCE, runsUsing(loose)));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('Above target but already at the minimum holds');
  });

  it('rejects the truthiness bug, and only the zero case catches it', async () => {
    // `if minimum and ...` reads naturally and works for every minimum except
    // a genuine zero. One argument set exists purely to catch it.
    const truthy = (c: number, t: number, m: number) => {
      if (c < t) return 'scale-up';
      if (m && c > t && c > m) return 'scale-down';
      return 'hold';
    };

    const result = await verify(worldWith(SOURCE, runsUsing(truthy)));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['A minimum of zero is treated as a real minimum']);
  });

  it('rejects input that is not a number being accepted', async () => {
    const runs = correctRuns();
    runs![`${PROGRAM} abc 1 1`] = { exitCode: 0, stdout: 'DECISION=hold current=abc target=1 minimum=1\n' };

    const result = await verify(worldWith(SOURCE, runs));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['Input that is not a number is rejected rather than guessed']);
  });

  it('rejects the right message with the wrong exit status', async () => {
    const result = await verify(worldWith(SOURCE, runsUsing(decide, 0)));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['Input that is not a number is rejected rather than guessed']);
  });

  it('rejects a program that is not executable', async () => {
    const result = await verify(worldWith(SOURCE, correctRuns(), '644'));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The scaling program exists and can be run as a program');
  });

  it('rejects a missing program', async () => {
    const result = await verify(worldWith(undefined, {}));

    // Every check fails, including the two `file_content_absent` ones: the
    // platform treats a missing path as a failed check rather than as a
    // vacuously-satisfied absence, which is the right call for a lab — the
    // artifact has to exist before anything can be said about it.
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toHaveLength((await lab()).requirements.length);
  });
});

describe('CS-006 rejects the bypasses', () => {
  it('rejects a table that prints every expected decision at once', async () => {
    const table = [
      '#!/bin/sh',
      'echo "DECISION=scale-down current=10 target=9 minimum=2"',
      'echo "DECISION=scale-down current=12 target=9 minimum=2"',
      'echo "DECISION=hold current=3 target=1 minimum=3"',
      '',
    ].join('\n');
    const everything = Object.values(correctRuns()!)
      .map((r) => r.stdout ?? '')
      .join('');
    const runs: FakeWorld['scripts'] = {};
    for (const key of Object.keys(correctRuns()!)) runs[key] = { exitCode: 0, stdout: everything };

    const result = await verify(worldWith(table, runs));
    expect(result.passed).toBe(false);
    // Every behavioural check is satisfied by the blanket output, which is
    // exactly why the two source checks are not redundant.
    expect(failed(result.checks)).toEqual([
      'Input that is not a number is rejected rather than guessed',
      'The program applies the rule rather than containing the answers',
      'The program is not a table of expected decisions',
    ]);
  });
});

describe('CS-006 grading hygiene', () => {
  it('keeps expected decisions out of the failure details', async () => {
    const runs: FakeWorld['scripts'] = {};
    for (const key of Object.keys(correctRuns()!)) runs[key] = { exitCode: 1, stdout: 'nope\n' };

    const result = await verify(worldWith('#!/bin/sh\nexit 1\n', runs));
    for (const check of result.checks) {
      expect(check.detail ?? '', check.label).not.toMatch(
        /DECISION=scale-down current=10|current=12 target=9|DECISION=hold current=3/,
      );
    }
  });

  it('grades only the student’s own program, never the seeded evidence', async () => {
    const sandbox = new FakeSandbox(worldWith(SOURCE));
    await verifyLab({ lab: await lab(), sandbox, namespace: SANDBOX });

    expect(new Set(sandbox.reads)).toEqual(new Set([PROGRAM]));
    expect(sandbox.scriptRuns).toHaveLength(7);
  });

  it('uses no seeded grading harness at all', async () => {
    const definition = await lab();

    // Every script the verifier runs is the student's own program. If a future
    // edit introduced a seeded checker, this fails — and it should, because a
    // harness that imports student code cannot be trusted.
    for (const requirement of definition.requirements) {
      if (requirement.type !== 'script_runs') continue;
      expect(requirement.path, 'verifier ran something outside the student workspace').toBe(PROGRAM);
    }
  });

  it('bounds every program it runs', async () => {
    for (const requirement of (await lab()).requirements) {
      if (requirement.type !== 'script_runs') continue;
      expect(requirement.timeout_seconds).toBeGreaterThan(0);
      expect(requirement.timeout_seconds).toBeLessThanOrEqual(60);
    }
  });
});
