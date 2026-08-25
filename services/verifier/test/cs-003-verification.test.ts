/**
 * CS-003 — what the verifier accepts for the encoding lab.
 *
 * The lab's whole point is that characters and bytes are different counts, so
 * the tests that matter are the ones where a student conflates them: a program
 * that reports `len(line)` for both, findings that record a Latin-1 byte where
 * UTF-8 needs two, and a conclusion that the partner's limit counts characters.
 * Each must fail, and fail on precisely the check that names the misunderstanding.
 *
 * The lookup-table case is inherited from CS-002 and is the reason the two
 * `file_content_absent` checks exist: `output_contains` is a substring test
 * over the whole of stdout, so a program printing both batches' answers at
 * once satisfies both invocations. This suite is what stops that pair being
 * deleted as redundant.
 *
 * The reader is an in-memory sandbox. The real container path — including the
 * privilege reduction that stops a student replacing `/bin/cat` — is exercised
 * against a live session.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type LoadedLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const CS_003 = path.join(LABS_DIR, 'cs', 'cs-003-text-encoding', 'lab.yaml');
const SANDBOX = 'jtt-lab-000000000003';

const PROGRAM = '/home/student/py/encoding.py';
const FINDINGS = '/home/student/ops/encoding.txt';
const BATCH_1 = '/srv/kestrel/import/batch-1.txt';
const BATCH_2 = '/srv/kestrel/import/batch-2.txt';

/** A correct measuring program, as a student would write it. */
const CORRECT_SOURCE = [
  '#!/usr/bin/env python3',
  'import sys',
  'text = open(sys.argv[1], encoding="utf-8").read()',
  'tc = tb = 0',
  'best_c = best_b = (0, 0)',
  'for i, ln in enumerate(text.splitlines(), 1):',
  '    c = len(ln)',
  '    b = len(ln.encode("utf-8"))',
  '    tc += c; tb += b',
  '    if c > best_c[1]: best_c = (i, c)',
  '    if b > best_b[1]: best_b = (i, b)',
  '    print(f"LINE={i} CHARS={c} BYTES={b}")',
  'print(f"TOTAL_CHARS={tc}")',
  'print(f"TOTAL_BYTES={tb}")',
  'print(f"MAX_CHARS_LINE={best_c[0]}")',
  'print(f"MAX_BYTES_LINE={best_b[0]}")',
  '',
].join('\n');

const CORRECT_FINDINGS = [
  'ASCII_HEX=41',
  'UMLAUT_HEX=c3bc',
  'CJK_HEX=e69db1',
  'UMLAUT_CODEPOINT=U+00FC',
  'OVER_LIMIT_LINE=4',
  'LIMIT_COUNTS=bytes',
  '',
].join('\n');

/** What a correct program prints for each seeded batch. */
const CORRECT_OUTPUT: Record<string, string> = {
  [BATCH_1]: [
    'LINE=1 CHARS=18 BYTES=18',
    'LINE=2 CHARS=14 BYTES=15',
    'LINE=3 CHARS=16 BYTES=17',
    'LINE=4 CHARS=13 BYTES=37',
    'TOTAL_CHARS=61',
    'TOTAL_BYTES=87',
    'MAX_CHARS_LINE=1',
    'MAX_BYTES_LINE=4',
    '',
  ].join('\n'),
  [BATCH_2]: [
    'LINE=1 CHARS=13 BYTES=13',
    'LINE=2 CHARS=13 BYTES=15',
    'TOTAL_CHARS=26',
    'TOTAL_BYTES=28',
    'MAX_CHARS_LINE=1',
    'MAX_BYTES_LINE=2',
    '',
  ].join('\n'),
};

/**
 * What the same program prints if it counts characters for both — the ASCII
 * assumption. Identical on pure-ASCII input, wrong the moment a line is not.
 */
const ASCII_ASSUMPTION_OUTPUT: Record<string, string> = {
  [BATCH_1]: [
    'LINE=1 CHARS=18 BYTES=18',
    'LINE=2 CHARS=14 BYTES=14',
    'LINE=3 CHARS=16 BYTES=16',
    'LINE=4 CHARS=13 BYTES=13',
    'TOTAL_CHARS=61',
    'TOTAL_BYTES=61',
    'MAX_CHARS_LINE=1',
    'MAX_BYTES_LINE=1',
    '',
  ].join('\n'),
  [BATCH_2]: [
    'LINE=1 CHARS=13 BYTES=13',
    'LINE=2 CHARS=13 BYTES=13',
    'TOTAL_CHARS=26',
    'TOTAL_BYTES=26',
    'MAX_CHARS_LINE=1',
    'MAX_BYTES_LINE=1',
    '',
  ].join('\n'),
};

function evidence(): FakeWorld['files'] {
  return {
    '/srv/kestrel/import': { type: 'directory', owner: 'root', group: 'root', mode: '755' },
    '/srv/kestrel/import/README.txt': { content: 'scan-api address import — failing batches\n', owner: 'root', mode: '444' },
    [BATCH_1]: {
      content: 'Manchester England\nZürich Schweiz\nSão Paulo Brasil\n東京都千代田区丸の内 日本\n',
      owner: 'root',
      mode: '444',
    },
    [BATCH_2]: { content: 'Leeds England\nMálaga España\n', owner: 'root', mode: '444' },
  };
}

function initialWorld(): FakeWorld {
  return { files: evidence() };
}

interface Solution {
  source?: string;
  findings?: string;
  output?: Record<string, string>;
  exitCode?: number;
  mode?: string;
}

function worldWith(solution: Solution): FakeWorld {
  const world = initialWorld();
  if (solution.source !== undefined) {
    world.files![PROGRAM] = { content: solution.source, mode: solution.mode ?? '755' };
  }
  if (solution.findings !== undefined) world.files![FINDINGS] = { content: solution.findings };
  world.scripts = {};
  for (const [file, stdout] of Object.entries(solution.output ?? CORRECT_OUTPUT)) {
    world.scripts[`${PROGRAM} ${file}`] = { exitCode: solution.exitCode ?? 0, stdout };
  }
  return world;
}

let cached: LoadedLabDefinition | undefined;
async function lab(): Promise<LoadedLabDefinition> {
  cached ??= await loadLabDefinition(CS_003);
  return cached;
}

async function verify(world: FakeWorld) {
  return verifyLab({ lab: await lab(), sandbox: new FakeSandbox(world), namespace: SANDBOX });
}

function failed(checks: readonly { status: string; label: string }[]): string[] {
  return checks.filter((c) => c.status === 'fail').map((c) => c.label);
}

// ------------------------------------------------------------ initial state

describe('CS-003 before the student does anything', () => {
  it('fails every check, and none is skipped', async () => {
    const result = await verify(initialWorld());
    const definition = await lab();

    expect(result.passed).toBe(false);
    expect(result.summary).toBe('LAB NOT COMPLETE');
    expect(result.checks).toHaveLength(definition.requirements.length);
    expect(result.checks.every((c) => c.status !== 'skipped')).toBe(true);
  });
});

// --------------------------------------------------------- correct solution

describe('CS-003 when the work has been done', () => {
  it('passes', async () => {
    const result = await verify(worldWith({ source: CORRECT_SOURCE, findings: CORRECT_FINDINGS }));

    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  });

  it('passes an equivalent implementation written a completely different way', async () => {
    // Reads bytes and decodes rather than opening in text mode, tabulates
    // first, uses %-formatting and `max(key=...)`. Same measurements, no
    // shared line of code — the lab grades the finding, never the phrasing.
    const alternative = [
      '#!/usr/bin/env python3',
      '"""Report characters and bytes for each line of a UTF-8 file."""',
      'import sys',
      '',
      'document = open(sys.argv[1], "rb").read().decode("utf-8")',
      'rows = []',
      'for number, line in enumerate(document.splitlines(), start=1):',
      '    rows.append((number, len(line), len(line.encode())))',
      'for number, chars, octets in rows:',
      '    print("LINE=%d CHARS=%d BYTES=%d" % (number, chars, octets))',
      'print("TOTAL_CHARS=%d" % sum(r[1] for r in rows))',
      'print("TOTAL_BYTES=%d" % sum(r[2] for r in rows))',
      'print("MAX_CHARS_LINE=%d" % max(rows, key=lambda r: r[1])[0])',
      'print("MAX_BYTES_LINE=%d" % max(rows, key=lambda r: r[2])[0])',
      '',
    ].join('\n');

    const result = await verify(worldWith({ source: alternative, findings: CORRECT_FINDINGS }));
    expect(result.passed).toBe(true);
  });
});

// --------------------------------------------------- the misunderstandings

describe('CS-003 rejects the encoding mistakes it exists to correct', () => {
  it('rejects the ASCII assumption — one character, one byte', async () => {
    const result = await verify(
      worldWith({ source: CORRECT_SOURCE, findings: CORRECT_FINDINGS, output: ASCII_ASSUMPTION_OUTPUT }),
    );

    expect(result.passed).toBe(false);
    // Both batches contain non-ASCII, so both measurements are wrong.
    expect(failed(result.checks)).toEqual([
      'The program measures the failing batch correctly',
      'The program measures the sanity-check batch correctly',
    ]);
  });

  it('rejects a Latin-1 byte where UTF-8 needs two', async () => {
    // `ü` is one byte in Latin-1 and two in UTF-8. Recording `fc` means the
    // student read the code point and assumed it was the storage.
    const latin1 = CORRECT_FINDINGS.replace('UMLAUT_HEX=c3bc', 'UMLAUT_HEX=fc');
    const result = await verify(worldWith({ source: CORRECT_SOURCE, findings: latin1 }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The findings record the bytes of a two-byte character']);
  });

  it('rejects a code point written as though it were the bytes', async () => {
    const confused = CORRECT_FINDINGS.replace('UMLAUT_CODEPOINT=U+00FC', 'UMLAUT_CODEPOINT=U+C3BC');
    const result = await verify(worldWith({ source: CORRECT_SOURCE, findings: confused }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The findings record the code point behind those bytes']);
  });

  it('rejects encoding with the wrong codec', async () => {
    // UTF-16 gives every character two bytes plus a byte-order mark, so every
    // count changes even for pure ASCII.
    const utf16: Record<string, string> = {
      [BATCH_1]: 'LINE=1 CHARS=18 BYTES=38\nTOTAL_CHARS=61\nTOTAL_BYTES=130\nMAX_CHARS_LINE=1\nMAX_BYTES_LINE=4\n',
      [BATCH_2]: 'LINE=1 CHARS=13 BYTES=28\nTOTAL_CHARS=26\nTOTAL_BYTES=54\nMAX_CHARS_LINE=1\nMAX_BYTES_LINE=2\n',
    };
    const result = await verify(worldWith({ source: CORRECT_SOURCE, findings: CORRECT_FINDINGS, output: utf16 }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The program measures the failing batch correctly');
  });

  it('rejects the wrong conclusion about what the limit counts', async () => {
    const wrong = CORRECT_FINDINGS.replace('LIMIT_COUNTS=bytes', 'LIMIT_COUNTS=characters');
    const result = await verify(worldWith({ source: CORRECT_SOURCE, findings: wrong }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(["The findings say what the partner's limit is counting"]);
  });

  it('rejects blaming the longest-looking line instead of the longest in bytes', async () => {
    const wrong = CORRECT_FINDINGS.replace('OVER_LIMIT_LINE=4', 'OVER_LIMIT_LINE=1');
    const result = await verify(worldWith({ source: CORRECT_SOURCE, findings: wrong }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The findings identify the line the byte limit rejects']);
  });
});

// -------------------------------------------------------- missing artifacts

describe('CS-003 requires both artifacts', () => {
  it('rejects a missing findings file', async () => {
    const result = await verify(worldWith({ source: CORRECT_SOURCE }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toHaveLength(7);
  });

  it('rejects a missing program', async () => {
    const result = await verify(worldWith({ findings: CORRECT_FINDINGS, output: {} }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toHaveLength(5);
  });

  it('rejects a program that is not executable', async () => {
    const result = await verify(worldWith({ source: CORRECT_SOURCE, findings: CORRECT_FINDINGS, mode: '644' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The measuring program exists and can be run as a program');
  });
});

// ------------------------------------------------------------- the bypasses

describe('CS-003 rejects the bypasses', () => {
  it('rejects a lookup table that prints both batches at once', async () => {
    const table = [
      '#!/bin/sh',
      'echo "LINE=1 CHARS=18 BYTES=18"',
      'echo "LINE=4 CHARS=13 BYTES=37"',
      'echo "LINE=2 CHARS=13 BYTES=15"',
      '',
    ].join('\n');
    const everything = Object.values(CORRECT_OUTPUT).join('');

    const result = await verify(
      worldWith({
        source: table,
        findings: CORRECT_FINDINGS,
        output: { [BATCH_1]: everything, [BATCH_2]: everything },
      }),
    );

    expect(result.passed).toBe(false);
    // Both behavioural checks are satisfied — which is precisely why the two
    // source checks are not redundant.
    expect(failed(result.checks)).toEqual([
      'The program measures the text rather than containing the answer',
      'The program is not a table of expected output',
    ]);
  });
});

// -------------------------------------------------- answer-leak regression

describe('CS-003 never hands the answers back', () => {
  it('keeps every expected value out of the failure details', async () => {
    const result = await verify(
      worldWith({
        source: '#!/bin/sh\necho nope\n',
        findings: 'WRONG=1\n',
        output: { [BATCH_1]: 'nope\n', [BATCH_2]: 'nope\n' },
      }),
    );

    for (const check of result.checks) {
      const detail = check.detail ?? '';
      expect(detail, check.label).not.toMatch(
        /CHARS=18|BYTES=37|TOTAL_BYTES=87|TOTAL_CHARS=61|c3bc|e69db1|U\+00FC|LIMIT_COUNTS=bytes|OVER_LIMIT_LINE=4/,
      );
    }
  });

  it('keeps every expected value out of the student-visible check labels', async () => {
    const definition = await lab();

    for (const requirement of definition.requirements) {
      expect(requirement.label ?? '').not.toMatch(
        /18|37|87|61|c3bc|e69db1|00FC|=4\b|=bytes/,
      );
    }
  });

  it('grades only the student’s own artifacts, never the seeded batches', async () => {
    const sandbox = new FakeSandbox(worldWith({ source: CORRECT_SOURCE, findings: CORRECT_FINDINGS }));
    await verifyLab({ lab: await lab(), sandbox, namespace: SANDBOX });

    expect(new Set(sandbox.reads)).toEqual(new Set([PROGRAM, FINDINGS]));
    expect(sandbox.scriptRuns).toEqual([`${PROGRAM} ${BATCH_1}`, `${PROGRAM} ${BATCH_2}`]);
  });
});
