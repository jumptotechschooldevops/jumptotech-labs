/**
 * CS-007 — grading a transformation, not a transcript.
 *
 * Two design decisions are pinned here because both are easy to undo later.
 *
 * The ranking is graded as one `ORDER=` line rather than by hashing the CSV.
 * `output_contains` checks each expected string independently, so it cannot
 * assert that four lines came out in a given order; and a byte hash of the CSV
 * would fail a student using `csv.writer`, which emits CRLF by default. One
 * order-exact literal grades the ordering and is indifferent to line endings.
 *
 * The tie is the point. manchester and bristol both finish on 7 and manchester
 * appears first in the log, so sorting by count alone leaves them in insertion
 * order — and every `DEPOT=` line is still correct. Only the ranking reveals
 * whether the tie-break was applied, which is why it is a separate assertion.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type LoadedLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const CS_007 = path.join(LABS_DIR, 'cs', 'cs-007-lists-dictionaries', 'lab.yaml');
const SANDBOX = 'jtt-lab-000000000007';

const PROGRAM = '/home/student/py/depots.py';
const CSV = '/home/student/ops/depots.csv';
const MAIN_LOG = '/srv/kestrel/scans/scan-events.log';
const SMALL_LOG = '/srv/kestrel/scans/scan-events-small.log';

const SOURCE = [
  '#!/usr/bin/env python3',
  'import collections, sys',
  'counts = collections.Counter()',
  '# ...',
  '',
].join('\n');

/** The overnight batch, and the afternoon re-run. */
const MAIN: Array<[string, number]> = [
  ['leeds', 9],
  ['bristol', 7],
  ['manchester', 7],
  ['cardiff', 3],
];
const SMALL: Array<[string, number]> = [
  ['york', 3],
  ['cardiff', 2],
];

function report(ranked: Array<[string, number]>): string {
  const lines = ranked.map(([d, c]) => `DEPOT=${d} COUNT=${c}`);
  lines.push(`ORDER=${ranked.map(([d]) => d).join(',')}`);
  lines.push(`TOTAL=${ranked.reduce((sum, [, c]) => sum + c, 0)}`);
  return lines.join('\n') + '\n';
}

function csvOf(ranked: Array<[string, number]>): string {
  return ranked.map(([d, c]) => `${d},${c}`).join('\n') + '\n';
}

function correctRuns(): FakeWorld['scripts'] {
  return {
    [`${PROGRAM} ${MAIN_LOG} /tmp/cs007-check-a.csv`]: { exitCode: 0, stdout: report(MAIN) },
    [`${PROGRAM} ${SMALL_LOG} /tmp/cs007-check-b.csv`]: { exitCode: 0, stdout: report(SMALL) },
  };
}

function evidence(): FakeWorld['files'] {
  return {
    '/srv/kestrel/scans/README.txt': { content: 'scan events\n', owner: 'root', mode: '444' },
    [MAIN_LOG]: { content: 'depot=manchester\ndepot=bristol\n', owner: 'root', mode: '444' },
    [SMALL_LOG]: { content: 'depot=york\n', owner: 'root', mode: '444' },
  };
}

interface Solution {
  source?: string;
  csv?: string;
  runs?: FakeWorld['scripts'];
  mode?: string;
}

function worldWith(s: Solution = {}): FakeWorld {
  const world: FakeWorld = { files: evidence(), scripts: s.runs ?? correctRuns() };
  if (s.source !== undefined) world.files![PROGRAM] = { content: s.source, mode: s.mode ?? '755' };
  if (s.csv !== undefined) world.files![CSV] = { content: s.csv };
  return world;
}

function solved(overrides: Solution = {}): FakeWorld {
  return worldWith({ source: SOURCE, csv: csvOf(MAIN), ...overrides });
}

let cached: LoadedLabDefinition | undefined;
async function lab(): Promise<LoadedLabDefinition> {
  cached ??= await loadLabDefinition(CS_007);
  return cached;
}
async function verify(world: FakeWorld) {
  return verifyLab({ lab: await lab(), sandbox: new FakeSandbox(world), namespace: SANDBOX });
}
function failed(checks: readonly { status: string; label: string }[]): string[] {
  return checks.filter((c) => c.status === 'fail').map((c) => c.label);
}

describe('CS-007 before the student does anything', () => {
  it('fails every check, and none is skipped', async () => {
    const result = await verify(worldWith());
    const definition = await lab();

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(definition.requirements.length);
    expect(result.checks.every((c) => c.status !== 'skipped')).toBe(true);
  });
});

describe('CS-007 when the transformation is right', () => {
  it('passes', async () => {
    const result = await verify(solved());

    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes an implementation built a completely different way', async () => {
    // A regex, a list of record dicts, a plain dict tally and %-formatting.
    const alternative = [
      '#!/usr/bin/env python3',
      'import re, sys',
      'PATTERN = re.compile(r"(?:^|\\s)depot=(\\S+)")',
      'records = []',
      'tally = {}',
      '',
    ].join('\n');

    const result = await verify(solved({ source: alternative }));
    expect(result.passed).toBe(true);
  });
});

describe('CS-007 rejects the wrong transformations', () => {
  it('rejects ranking without the tie-break', async () => {
    // Sorting by count alone leaves the two depots on 7 in insertion order.
    // Every DEPOT line is still right; only the ranking is wrong, and only on
    // the batch that actually contains a tie.
    const insertionOrder: Array<[string, number]> = [
      ['leeds', 9],
      ['manchester', 7],
      ['bristol', 7],
      ['cardiff', 3],
    ];
    const runs = correctRuns();
    runs![`${PROGRAM} ${MAIN_LOG} /tmp/cs007-check-a.csv`] = { exitCode: 0, stdout: report(insertionOrder) };

    const result = await verify(solved({ runs }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The overnight batch is counted, ranked and totalled correctly']);
  });

  it('rejects counting the lines that are not scan records', async () => {
    // A truncated line, a blank one and one with no depot field. Counting them
    // as a depot inflates the total and invents a name.
    const withJunk: Array<[string, number]> = [...MAIN, ['unknown', 3]];
    const runs: FakeWorld['scripts'] = {
      [`${PROGRAM} ${MAIN_LOG} /tmp/cs007-check-a.csv`]: { exitCode: 0, stdout: report(withJunk) },
      [`${PROGRAM} ${SMALL_LOG} /tmp/cs007-check-b.csv`]: {
        exitCode: 0,
        stdout: report([...SMALL, ['unknown', 1]]),
      },
    };

    const result = await verify(solved({ runs }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toHaveLength(2);
  });

  it('rejects ranking the wrong way round', async () => {
    const ascending = [...MAIN].reverse() as Array<[string, number]>;
    const runs: FakeWorld['scripts'] = {
      [`${PROGRAM} ${MAIN_LOG} /tmp/cs007-check-a.csv`]: { exitCode: 0, stdout: report(ascending) },
      [`${PROGRAM} ${SMALL_LOG} /tmp/cs007-check-b.csv`]: {
        exitCode: 0,
        stdout: report([...SMALL].reverse() as Array<[string, number]>),
      },
    };

    const result = await verify(solved({ runs }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toHaveLength(2);
  });

  it('rejects an empty result', async () => {
    const runs: FakeWorld['scripts'] = {
      [`${PROGRAM} ${MAIN_LOG} /tmp/cs007-check-a.csv`]: { exitCode: 0, stdout: 'ORDER=\nTOTAL=0\n' },
      [`${PROGRAM} ${SMALL_LOG} /tmp/cs007-check-b.csv`]: { exitCode: 0, stdout: 'ORDER=\nTOTAL=0\n' },
    };

    const result = await verify(solved({ runs, csv: '' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks).length).toBeGreaterThanOrEqual(5);
  });

  it('rejects a missing depot from the CSV', async () => {
    // Only the busy ones written out — a common shortcut when the report is
    // built from a "top N" slice rather than the whole tally.
    const result = await verify(solved({ csv: csvOf(MAIN.slice(0, 2)) }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The CSV carries every depot, not only the busy ones']);
  });

  it('rejects a missing CSV entirely', async () => {
    const world = solved();
    delete world.files![CSV];

    const result = await verify(world);
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toHaveLength(4);
  });

  it('rejects a program that is not executable', async () => {
    const result = await verify(solved({ mode: '644' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The report program exists and can be run as a program');
  });
});

describe('CS-007 rejects forged evidence', () => {
  it('rejects a hand-written CSV behind a broken program', async () => {
    // The artifact is perfect and the program does nothing. The CSV checks
    // pass and both program checks fail, so forging the deliverable alone can
    // never reach a pass — which is the property that makes a student-written
    // file safe to grade at all.
    const runs: FakeWorld['scripts'] = {
      [`${PROGRAM} ${MAIN_LOG} /tmp/cs007-check-a.csv`]: { exitCode: 0, stdout: '' },
      [`${PROGRAM} ${SMALL_LOG} /tmp/cs007-check-b.csv`]: { exitCode: 0, stdout: '' },
    };

    const result = await verify(solved({ runs, source: '#!/bin/sh\nexit 0\n' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The overnight batch is counted, ranked and totalled correctly',
      'A different batch is counted, ranked and totalled correctly',
    ]);
  });

  it('rejects a table that prints both rankings at once', async () => {
    const table = ['#!/bin/sh', 'echo "ORDER=leeds,bristol,manchester,cardiff"', 'echo "ORDER=york,cardiff"', ''].join('\n');
    const everything = report(MAIN) + report(SMALL);
    const runs: FakeWorld['scripts'] = {
      [`${PROGRAM} ${MAIN_LOG} /tmp/cs007-check-a.csv`]: { exitCode: 0, stdout: everything },
      [`${PROGRAM} ${SMALL_LOG} /tmp/cs007-check-b.csv`]: { exitCode: 0, stdout: everything },
    };

    const result = await verify(solved({ runs, source: table }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The program derives the ranking rather than containing it',
      'The program is not a table of expected rankings',
    ]);
  });
});

describe('CS-007 grading hygiene', () => {
  it('keeps expected counts and rankings out of the failure details', async () => {
    const runs: FakeWorld['scripts'] = {
      [`${PROGRAM} ${MAIN_LOG} /tmp/cs007-check-a.csv`]: { exitCode: 1, stdout: 'nope\n' },
      [`${PROGRAM} ${SMALL_LOG} /tmp/cs007-check-b.csv`]: { exitCode: 1, stdout: 'nope\n' },
    };

    const result = await verify(solved({ runs, source: '#!/bin/sh\nexit 1\n', csv: 'nope\n' }));
    for (const check of result.checks) {
      expect(check.detail ?? '', check.label).not.toMatch(
        /ORDER=leeds|ORDER=york|TOTAL=26|COUNT=9|leeds,9/,
      );
    }
  });

  it('grades only the student’s own artifacts, never the seeded logs', async () => {
    const sandbox = new FakeSandbox(solved());
    await verifyLab({ lab: await lab(), sandbox, namespace: SANDBOX });

    expect(new Set(sandbox.reads)).toEqual(new Set([PROGRAM, CSV]));
    expect(sandbox.scriptRuns).toHaveLength(2);
  });

  it('uses no seeded grading harness, and writes its scratch output outside the workspace', async () => {
    for (const requirement of (await lab()).requirements) {
      if (requirement.type !== 'script_runs') continue;
      // Every script run is the student's own program...
      expect(requirement.path).toBe(PROGRAM);
      // ...and the CSV the verifier makes it write is a scratch path, so the
      // student's own deliverable is never clobbered by grading.
      expect(requirement.args.at(-1)).toMatch(/^\/tmp\//);
      expect(requirement.timeout_seconds).toBeGreaterThan(0);
    }
  });
});
