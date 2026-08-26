/**
 * CS-002 — what the verifier accepts, and the one bypass it was designed for.
 *
 * CS-002 is the first CS lab graded by *running* the student's program, so the
 * interesting question is what a program can get away with. The bypass that
 * shaped the lab's requirements is the lookup table: `output_contains` is a
 * substring test over the whole of stdout, so a program that prints every
 * answer set it can think of satisfies every invocation at once, no matter
 * what it was asked to convert. Requiring the *source* to be free of the
 * expected values is what turns that into a losing strategy, and the test
 * below is what stops that pair of checks from being deleted as redundant.
 *
 * The reader is an in-memory sandbox: it models what a sandbox can be asked,
 * not how a container behaves. The real `docker exec` path — including the
 * timeout and output ceiling — is exercised against a live container.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type LoadedLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const CS_002 = path.join(LABS_DIR, 'cs', 'cs-002-bits-bytes-units', 'lab.yaml');
const SANDBOX = 'jtt-lab-000000000002';

const PROGRAM = '/home/student/py/units.py';
const FINDINGS = '/home/student/ops/units.txt';

/** A correct converter, as a student would write it. */
const CORRECT_SOURCE = [
  '#!/usr/bin/env python3',
  'import sys',
  'n = int(sys.argv[1])',
  'print(f"BYTES={n}")',
  'print(f"SI={n / 10**6:.2f} MB")',
  'print(f"IEC={n / 1024**2:.2f} MiB")',
  '',
].join('\n');

const CORRECT_FINDINGS = [
  'LIMIT_BYTES=536870912',
  'TAG_HEX=4d69',
  'SI=537M',
  'IEC=512M',
  'VERDICT=over',
  '',
].join('\n');

/** What a correct converter prints for each graded input. */
const CORRECT_OUTPUT: Record<string, string> = {
  '536870912': 'BYTES=536870912\nSI=536.87 MB\nIEC=512.00 MiB\n',
  '1000000': 'BYTES=1000000\nSI=1.00 MB\nIEC=0.95 MiB\n',
  '1073741824': 'BYTES=1073741824\nSI=1073.74 MB\nIEC=1024.00 MiB\n',
};

function evidence(): FakeWorld['files'] {
  return {
    '/srv/kestrel/scan-api': { type: 'directory', owner: 'root', group: 'root', mode: '755' },
    '/srv/kestrel/scan-api/README.txt': { content: 'scan-api — memory alert evidence\n', owner: 'root', mode: '444' },
    '/srv/kestrel/scan-api/alert.txt': { content: '06:12:04  ALERT  scan-api  memory 640M of 512Mi limit\n', owner: 'root', mode: '444' },
    '/srv/kestrel/scan-api/limit.hex': { content: '0x20000000\n', owner: 'root', mode: '444' },
    '/srv/kestrel/scan-api/tag.bin': { content: 'Mi', owner: 'root', mode: '444' },
  };
}

/** The world the student is dropped into: evidence, and nothing of theirs. */
function initialWorld(): FakeWorld {
  return { files: evidence() };
}

interface Solution {
  /** Program source, or undefined for no program at all. */
  source?: string;
  /** Findings file, or undefined for none. */
  findings?: string;
  /** stdout per argument; defaults to a correct converter's output. */
  output?: Record<string, string>;
  exitCode?: number;
  timedOut?: boolean;
  mode?: string;
}

function worldWith(solution: Solution): FakeWorld {
  const world = initialWorld();
  if (solution.source !== undefined) {
    world.files![PROGRAM] = { content: solution.source, mode: solution.mode ?? '755' };
  }
  if (solution.findings !== undefined) {
    world.files![FINDINGS] = { content: solution.findings };
  }
  const output = solution.output ?? CORRECT_OUTPUT;
  world.scripts = {};
  for (const [arg, stdout] of Object.entries(output)) {
    world.scripts[`${PROGRAM} ${arg}`] = {
      exitCode: solution.exitCode ?? 0,
      stdout,
      ...(solution.timedOut ? { timedOut: true } : {}),
    };
  }
  return world;
}

let cached: LoadedLabDefinition | undefined;
async function lab(): Promise<LoadedLabDefinition> {
  cached ??= await loadLabDefinition(CS_002);
  return cached;
}

async function verify(world: FakeWorld) {
  return verifyLab({ lab: await lab(), sandbox: new FakeSandbox(world), namespace: SANDBOX });
}

function failed(checks: readonly { status: string; label: string }[]): string[] {
  return checks.filter((c) => c.status === 'fail').map((c) => c.label);
}

// ------------------------------------------------------------ initial state

describe('CS-002 before the student does anything', () => {
  it('fails every check, and none is skipped', async () => {
    const result = await verify(initialWorld());
    const definition = await lab();

    expect(result.passed).toBe(false);
    expect(result.summary).toBe('LAB NOT COMPLETE');
    expect(result.checks).toHaveLength(definition.requirements.length);
    expect(result.checks.every((c) => c.status !== 'skipped')).toBe(true);
    expect(failed(result.checks)).toHaveLength(definition.requirements.length);
  });

  it('never names an expected value in a failure detail', async () => {
    const result = await verify(worldWith({ source: 'nope\n', findings: 'nothing\n', output: { '536870912': 'wrong\n', '1000000': 'wrong\n', '1073741824': 'wrong\n' } }));

    for (const check of result.checks) {
      const detail = check.detail ?? '';
      expect(detail, check.label).not.toMatch(/536\.87|512\.00|1073\.74|4d69|537M|536870912/);
    }
  });
});

// --------------------------------------------------------- correct solution

describe('CS-002 when the work has been done', () => {
  it('passes', async () => {
    const result = await verify(worldWith({ source: CORRECT_SOURCE, findings: CORRECT_FINDINGS }));

    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  });

  it('passes a different but correct implementation', async () => {
    // No f-strings, different arithmetic spelling, extra commentary. The lab
    // grades what the program does, never how it is written.
    const alternative = [
      '#!/usr/bin/env python3',
      '"""Convert a byte count into both unit systems."""',
      'import sys',
      'count = int(sys.argv[1])',
      'si = count / 1000 / 1000',
      'iec = count / 1024 / 1024',
      'print("BYTES=%d" % count)',
      'print("SI=%.2f MB" % si)',
      'print("IEC=%.2f MiB" % iec)',
      '',
    ].join('\n');

    const result = await verify(worldWith({ source: alternative, findings: CORRECT_FINDINGS }));
    expect(result.passed).toBe(true);
  });
});

// ------------------------------------------------------------- the bypasses

describe('CS-002 rejects the bypasses', () => {
  it('rejects a lookup table that prints every answer set at once', async () => {
    // The bypass the source checks exist for. This program ignores its
    // argument entirely and prints all three answer sets, which satisfies
    // `output_contains` for all three invocations.
    const table = [
      '#!/bin/sh',
      'echo "BYTES=536870912"; echo "SI=536.87 MB"; echo "IEC=512.00 MiB"',
      'echo "BYTES=1000000";   echo "SI=1.00 MB";   echo "IEC=0.95 MiB"',
      'echo "BYTES=1073741824";echo "SI=1073.74 MB";echo "IEC=1024.00 MiB"',
      '',
    ].join('\n');
    const everything = Object.values(CORRECT_OUTPUT).join('');

    const result = await verify(
      worldWith({
        source: table,
        findings: CORRECT_FINDINGS,
        output: { '536870912': everything, '1000000': everything, '1073741824': everything },
      }),
    );

    expect(result.passed).toBe(false);
    // Every behavioural check passes — which is exactly why the source checks
    // are not redundant.
    expect(failed(result.checks)).toEqual([
      'The converter works the answer out rather than containing it',
      'The converter is not a table of expected outputs',
    ]);
  });

  it('rejects a converter that uses the wrong divisor', async () => {
    const result = await verify(
      worldWith({
        source: CORRECT_SOURCE,
        findings: CORRECT_FINDINGS,
        output: {
          '536870912': 'BYTES=536870912\nSI=512.00 MB\nIEC=512.00 MiB\n',
          '1000000': 'BYTES=1000000\nSI=0.95 MB\nIEC=0.95 MiB\n',
          '1073741824': 'BYTES=1073741824\nSI=1024.00 MB\nIEC=1024.00 MiB\n',
        },
      }),
    );

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The converter is correct for the limit from the alert',
      'The converter is correct for a round decimal megabyte',
      'The converter is correct for a gibibyte',
    ]);
  });

  it('rejects a converter that is only right for the first input', async () => {
    // Hard-coding one answer and ignoring the rest — the reason three
    // different byte counts are graded rather than one.
    const result = await verify(
      worldWith({
        source: '#!/bin/sh\necho "BYTES=536870912"\necho "SI=536.87 MB"\necho "IEC=512.00 MiB"\n',
        findings: CORRECT_FINDINGS,
        output: {
          '536870912': CORRECT_OUTPUT['536870912']!,
          '1000000': CORRECT_OUTPUT['536870912']!,
          '1073741824': CORRECT_OUTPUT['536870912']!,
        },
      }),
    );

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The converter is correct for a round decimal megabyte');
    expect(failed(result.checks)).toContain('The converter is correct for a gibibyte');
  });

  it('rejects a program that is not executable', async () => {
    const result = await verify(worldWith({ source: CORRECT_SOURCE, findings: CORRECT_FINDINGS, mode: '644' }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The converter exists and can be run as a program');
  });

  it('rejects a malformed program, without pretending it succeeded', async () => {
    const result = await verify(
      worldWith({
        source: '#!/usr/bin/env python3\nprint(f"BYTES={\n',
        findings: CORRECT_FINDINGS,
        output: { '536870912': '', '1000000': '', '1073741824': '' },
        exitCode: 1,
      }),
    );

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The converter is correct for the limit from the alert',
      'The converter is correct for a round decimal megabyte',
      'The converter is correct for a gibibyte',
    ]);
  });

  it('rejects a program that never finishes', async () => {
    // The sandbox reports the timeout rather than blocking the verifier; the
    // lab must treat that as a failure and carry on.
    const result = await verify(
      worldWith({
        source: '#!/usr/bin/env python3\nwhile True: pass\n',
        findings: CORRECT_FINDINGS,
        output: { '536870912': '', '1000000': '', '1073741824': '' },
        timedOut: true,
      }),
    );

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toHaveLength(3);
  });

  it('rejects findings written without doing the conversions', async () => {
    const guessed = [
      'LIMIT_BYTES=0x20000000',
      'TAG_HEX=Mi',
      'SI=512M',
      'IEC=537M',
      'VERDICT=within',
      '',
    ].join('\n');

    const result = await verify(worldWith({ source: CORRECT_SOURCE, findings: guessed }));

    expect(result.passed).toBe(false);
    // Every findings check fails: the hex was not converted, the bytes were not
    // dumped, the two unit systems were swapped and the verdict is wrong.
    expect(failed(result.checks)).toHaveLength(5);
  });

  it('rejects half the lab in either direction', async () => {
    const programOnly = await verify(worldWith({ source: CORRECT_SOURCE }));
    expect(programOnly.passed).toBe(false);
    expect(failed(programOnly.checks)).toHaveLength(6);

    const findingsOnly = await verify(worldWith({ findings: CORRECT_FINDINGS, output: {} }));
    expect(findingsOnly.passed).toBe(false);
    expect(failed(findingsOnly.checks)).toHaveLength(6);
  });
});

// ----------------------------------------------------------------- lifecycle

describe('CS-002 lifecycle', () => {
  it('returns to the starting verdict when the sandbox is reset', async () => {
    const solved = await verify(worldWith({ source: CORRECT_SOURCE, findings: CORRECT_FINDINGS }));
    expect(solved.passed).toBe(true);

    // Reset replaces the container and re-runs the baseline, so the verifier
    // sees the world it saw at the start — including for a student who passed.
    const afterReset = await verify(initialWorld());
    expect(afterReset.passed).toBe(false);
    expect(failed(afterReset.checks)).toHaveLength((await lab()).requirements.length);
  });

  it('grades only the student’s own artifacts, never the seeded evidence', async () => {
    const sandbox = new FakeSandbox(worldWith({ source: CORRECT_SOURCE, findings: CORRECT_FINDINGS }));
    await verifyLab({ lab: await lab(), sandbox, namespace: SANDBOX });

    // The evidence is input for the student, not an input to the verdict, so
    // tampering with it cannot move the grade in either direction.
    expect(new Set(sandbox.reads)).toEqual(new Set([PROGRAM, FINDINGS]));
    expect(sandbox.scriptRuns).toEqual([
      `${PROGRAM} 536870912`,
      `${PROGRAM} 1000000`,
      `${PROGRAM} 1073741824`,
    ]);
  });
});
