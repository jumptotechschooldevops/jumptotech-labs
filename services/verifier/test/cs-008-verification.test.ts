/**
 * CS-008 — grading a parser by what it fails to lose.
 *
 * The fixture's traps were each verified against the real thing rather than
 * assumed, and one assumption turned out to be wrong, which is why the cases
 * below are specific:
 *
 *   whitespace split      accepts 10 of 16 lines, losing the slowest request
 *                         and three of the four errors
 *   dict from key=value   invents a `fallback` field from a message — real,
 *                         and verified, but it surfaces through the same
 *                         truncated-message and dropped-line failures rather
 *                         than as a distinct one, so it is not asserted twice
 *   dur_ms=99999 decoy    does NOT affect a first-match search, because the
 *                         real field comes first. It bites a parser taking the
 *                         last or largest match, which reads 99999 instead of
 *                         1180 and reorders the ranking
 *   truncated message     breaks LONGEST_MSG, which is the only check that
 *                         requires the whole quoted field
 *
 * `DROPPED` is graded as zero so that silently answering a smaller question
 * counts as a failure rather than as a rounding error.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type LoadedLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const CS_008 = path.join(LABS_DIR, 'cs', 'cs-008-strings', 'lab.yaml');
const SANDBOX = 'jtt-lab-000000000008';

const PROGRAM = '/home/student/py/parselog.py';
const MAIN = '/srv/kestrel/requests/requests.log';
const QUIET = '/srv/kestrel/requests/requests-quiet.log';

const SOURCE = '#!/usr/bin/env python3\nimport sys\n# walks the fields from the left\n';

interface Report {
  total: number;
  errors: number;
  dropped: number;
  slowest: string[];
  longest: string;
  paths: string[];
}

const MAIN_REPORT: Report = {
  total: 16,
  errors: 4,
  dropped: 0,
  slowest: ['R-1007', 'R-1003', 'R-1010'],
  longest: 'R-1012',
  paths: ['/api/depots', '/api/track'],
};
const QUIET_REPORT: Report = {
  total: 5,
  errors: 1,
  dropped: 0,
  slowest: ['Q-2002', 'Q-2005', 'Q-2004'],
  longest: 'Q-2002',
  paths: ['/api/track'],
};

function render(r: Report): string {
  return [
    `TOTAL=${r.total}`,
    `ERRORS=${r.errors}`,
    `DROPPED=${r.dropped}`,
    `SLOWEST=${r.slowest.join(',')}`,
    `LONGEST_MSG=${r.longest}`,
    `ERROR_PATHS=${r.paths.join(',')}`,
  ].join('\n') + '\n';
}

function runs(main = MAIN_REPORT, quiet = QUIET_REPORT): FakeWorld['scripts'] {
  return {
    [`${PROGRAM} ${MAIN}`]: { exitCode: 0, stdout: render(main) },
    [`${PROGRAM} ${QUIET}`]: { exitCode: 0, stdout: render(quiet) },
  };
}

function evidence(): FakeWorld['files'] {
  return {
    '/srv/kestrel/requests/README.txt': { content: 'request log\n', owner: 'root', mode: '444' },
    [MAIN]: { content: 'msg="slow upstream, fallback=disabled"\n', owner: 'root', mode: '444' },
    [QUIET]: { content: 'msg="ok"\n', owner: 'root', mode: '444' },
  };
}

function worldWith(source: string | undefined = SOURCE, scripts = runs(), mode = '755'): FakeWorld {
  const world: FakeWorld = { files: evidence(), scripts };
  if (source !== undefined) world.files![PROGRAM] = { content: source, mode };
  return world;
}

let cached: LoadedLabDefinition | undefined;
async function lab(): Promise<LoadedLabDefinition> {
  cached ??= await loadLabDefinition(CS_008);
  return cached;
}
async function verify(world: FakeWorld) {
  return verifyLab({ lab: await lab(), sandbox: new FakeSandbox(world), namespace: SANDBOX });
}
function failed(checks: readonly { status: string; label: string }[]): string[] {
  return checks.filter((c) => c.status === 'fail').map((c) => c.label);
}

describe('CS-008 before the student does anything', () => {
  it('fails every check, and none is skipped', async () => {
    const result = await verify(worldWith(undefined, {}));
    const definition = await lab();

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(definition.requirements.length);
    expect(result.checks.every((c) => c.status !== 'skipped')).toBe(true);
  });
});

describe('CS-008 when the parser loses nothing', () => {
  it('passes', async () => {
    const result = await verify(worldWith());

    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes an anchored-regex implementation', async () => {
    // One regex per line with the message anchored to the end of the record,
    // instead of consuming fields from the left. Same result, different means.
    const regexParser = [
      '#!/usr/bin/env python3',
      'import re, sys',
      'LINE = re.compile(r"^\\S+ level=(?P<level>\\S+) req=(?P<req>\\S+) dur_ms=(?P<dur>\\d+) path=(?P<path>\\S+) msg=\\"(?P<msg>.*)\\"$")',
      '',
    ].join('\n');

    const result = await verify(worldWith(regexParser));
    expect(result.passed).toBe(true);
  });
});

describe('CS-008 rejects the parsers that lose lines', () => {
  it('rejects splitting the line on whitespace', async () => {
    // The production parser. It accepts 10 of 16 lines and never notices,
    // because the ones it drops are the ones with a message worth reading.
    const naiveMain: Report = {
      total: 10,
      errors: 1,
      dropped: 6,
      slowest: ['R-1015', 'R-1014', 'R-1002'],
      longest: 'R-1001',
      paths: ['/api/track'],
    };
    const naiveQuiet: Report = {
      total: 3,
      errors: 0,
      dropped: 2,
      slowest: ['Q-2004', 'Q-2003', 'Q-2001'],
      longest: 'Q-2001',
      paths: [],
    };

    const result = await verify(worldWith(SOURCE, runs(naiveMain, naiveQuiet)));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The overnight log is parsed without losing a line',
      'A second log is parsed correctly rather than the first one repeated',
    ]);
  });

  it('rejects a non-zero DROPPED even when the totals look plausible', async () => {
    // Dropping two lines and reporting it honestly is still not a parser that
    // reads this log; DROPPED is graded at zero for exactly that reason.
    const partial: Report = { ...MAIN_REPORT, total: 14, dropped: 2 };

    const result = await verify(worldWith(SOURCE, runs(partial)));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The overnight log is parsed without losing a line']);
  });

  it('rejects a duration taken from the last match rather than the first', async () => {
    // The decoy inside a message. Verified against the fixture: a first-match
    // search is unaffected because the real field comes first, but taking the
    // last match reads 99999 and puts R-1012 at the top of the ranking.
    const decoyed: Report = { ...MAIN_REPORT, slowest: ['R-1012', 'R-1007', 'R-1003'] };

    const result = await verify(worldWith(SOURCE, runs(decoyed)));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The overnight log is parsed without losing a line']);
  });

  it('rejects a truncated message', async () => {
    // Cutting the message at its first space leaves every length wrong, which
    // only LONGEST_MSG can see — the totals and the ranking stay correct.
    const truncated: Report = { ...MAIN_REPORT, longest: 'R-1001' };

    const result = await verify(worldWith(SOURCE, runs(truncated)));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The overnight log is parsed without losing a line']);
  });

  it('rejects a program that is not executable', async () => {
    const result = await verify(worldWith(SOURCE, runs(), '644'));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The parser exists and can be run as a program');
  });
});

describe('CS-008 rejects the bypasses', () => {
  it('rejects a table of both logs’ answers', async () => {
    const table = ['#!/bin/sh', 'echo "TOTAL=16"', 'echo "SLOWEST=R-1007,R-1003,R-1010"', ''].join('\n');
    const everything = render(MAIN_REPORT) + render(QUIET_REPORT);
    const both: FakeWorld['scripts'] = {
      [`${PROGRAM} ${MAIN}`]: { exitCode: 0, stdout: everything },
      [`${PROGRAM} ${QUIET}`]: { exitCode: 0, stdout: everything },
    };

    const result = await verify(worldWith(table, both));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The parser derives its ranking rather than containing it',
      'The parser counts the lines rather than containing the total',
    ]);
  });
});

describe('CS-008 grading hygiene', () => {
  it('keeps expected totals and rankings out of the failure details', async () => {
    const broken: FakeWorld['scripts'] = {
      [`${PROGRAM} ${MAIN}`]: { exitCode: 1, stdout: 'nope\n' },
      [`${PROGRAM} ${QUIET}`]: { exitCode: 1, stdout: 'nope\n' },
    };

    const result = await verify(worldWith('#!/bin/sh\nexit 1\n', broken));
    for (const check of result.checks) {
      expect(check.detail ?? '', check.label).not.toMatch(
        /TOTAL=16|ERRORS=4|SLOWEST=R-1007|LONGEST_MSG=R-1012|ERROR_PATHS=/,
      );
    }
  });

  it('grades only the student’s own parser, never the seeded logs', async () => {
    const sandbox = new FakeSandbox(worldWith());
    await verifyLab({ lab: await lab(), sandbox, namespace: SANDBOX });

    expect(new Set(sandbox.reads)).toEqual(new Set([PROGRAM]));
    expect(sandbox.scriptRuns).toEqual([`${PROGRAM} ${MAIN}`, `${PROGRAM} ${QUIET}`]);
  });

  it('uses no seeded grading harness and bounds every run', async () => {
    for (const requirement of (await lab()).requirements) {
      if (requirement.type !== 'script_runs') continue;
      expect(requirement.path).toBe(PROGRAM);
      expect(requirement.timeout_seconds).toBeGreaterThan(0);
      expect(requirement.timeout_seconds).toBeLessThanOrEqual(60);
    }
  });
});
