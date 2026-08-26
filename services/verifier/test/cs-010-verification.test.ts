/**
 * CS-010 — grading a canonical form, and four YAML traps, on real content.
 *
 * The hash is the part that needed proving rather than asserting. CS-007
 * rejected a byte hash because `csv.writer` emits CRLF and the hash would have
 * graded line endings. This one was measured in the real image first: 18
 * plausible implementations of the stated contract (`json.dump` vs `dumps` vs
 * `print`, `load` vs `loads` vs bytes, `separators` and `ensure_ascii` spelled
 * out, a re-normalise round trip) across both seeded configs, under three
 * PYTHONHASHSEED values, produced exactly one digest — the one below.
 *
 * It is reproducible because the contract is complete and the fixture avoids
 * everything that is not: no floats, no non-ASCII, and `sort_keys` removing any
 * dependence on dict ordering.
 *
 * `depot-a.json` and `depot-b.json` are the same config in different key
 * orders. That both normalise to the same bytes is the lab, not a coincidence
 * of the fixture, so both are graded against the same digest.
 *
 * The YAML half is graded on the repaired file's bytes. Each absent-check names
 * the *broken* spelling, so quoting with '' or "" both pass — verified against
 * a real YAML parser, where both spellings parse to the identical document.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type LoadedLabDefinition } from '@jumptotech/lab-orchestrator';
import { verifyLab } from '../src/index.js';
import { FakeSandbox, type FakeWorld } from './sandbox-fake.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const CS_010 = path.join(LABS_DIR, 'cs', 'cs-010-json-yaml', 'lab.yaml');
const SANDBOX = 'jtt-lab-000000000010';

const LOADER = '/home/student/py/config.py';
const OUT_A = '/home/student/out/depot-a.json';
const OUT_B = '/home/student/out/depot-b.json';
const YAML_FIX = '/home/student/ops/depots.yaml';
const WRITEUP = '/home/student/ops/yaml.txt';

const CONFIG = '/srv/kestrel/config';
const CANONICAL = 'd8cd267fcd4ffad806d82ef8601ea3209b72be782ff0847cb4badf779e02269c';

/** A correct loader: the reported key is interpolated, no depot is named. */
const SOURCE = [
  '#!/usr/bin/env python3',
  'import json, sys',
  'REQUIRED = {"depot": str, "region": str, "version": str,',
  '            "enabled": bool, "limits": dict, "scanners": list}',
  'try:',
  '    config = json.load(open(sys.argv[1], encoding="utf-8"))',
  'except json.JSONDecodeError:',
  '    print("CONFIG_ERROR=invalid-json", file=sys.stderr)',
  '    sys.exit(4)',
  'for key, wanted in REQUIRED.items():',
  '    if key not in config:',
  '        print(f"CONFIG_ERROR=missing-key key={key}", file=sys.stderr)',
  '        sys.exit(2)',
  'open(sys.argv[2], "w").write(json.dumps(config, sort_keys=True, indent=2) + "\\n")',
  'print("CONFIG_OK")',
  '',
].join('\n');

/** The repaired YAML: quoted scalars, spaces, and the stale block removed. */
const REPAIRED = [
  '# kestrel depot configuration',
  'depots:',
  '  leeds:',
  '    country: "no"',
  '    version: "3.10"',
  '    enabled: yes',
  '  bristol:',
  '    country: gb',
  '    version: "2.4"',
  '    enabled: yes',
  '',
].join('\n');

const WRITTEN_UP = [
  'DUPLICATE_KEY=leeds',
  'COUNTRY_BECAME=false',
  'VERSION_BECAME=3.1',
  'TAB_DEPOT=bristol',
  '',
].join('\n');

/** The five runs a correct loader produces. */
function runs(): FakeWorld['scripts'] {
  return {
    [`${LOADER} ${CONFIG}/depot-a.json ${OUT_A}`]: { exitCode: 0, stdout: 'CONFIG_OK\n' },
    [`${LOADER} ${CONFIG}/depot-b.json ${OUT_B}`]: { exitCode: 0, stdout: 'CONFIG_OK\n' },
    [`${LOADER} ${CONFIG}/depot-missing.json /home/student/out/missing.json`]: {
      exitCode: 2,
      stderr: 'CONFIG_ERROR=missing-key key=region\n',
    },
    [`${LOADER} ${CONFIG}/depot-wrongtype.json /home/student/out/wrongtype.json`]: {
      exitCode: 3,
      stderr: 'CONFIG_ERROR=wrong-type key=enabled\n',
    },
    [`${LOADER} ${CONFIG}/depot-broken.json /home/student/out/broken.json`]: {
      exitCode: 4,
      stderr: 'CONFIG_ERROR=invalid-json\n',
    },
  };
}

const WRITEUP_TOKENS = [
  'DUPLICATE_KEY=leeds',
  'COUNTRY_BECAME=false',
  'VERSION_BECAME=3.1',
  'TAB_DEPOT=bristol',
] as const;

/**
 * The inspection commands the lab runs, answered the way the real tools would.
 *
 * `grep` is emulated rather than canned so the near-miss tests stay honest: a
 * write-up saying `VERSION_BECAME=3.10` really does fail `grep -x`, and really
 * would pass a substring test, which is why the lab uses whole-line matching.
 */
function inspections({
  a = CANONICAL,
  b = CANONICAL,
  yaml = REPAIRED,
  writeup = WRITTEN_UP,
}: { a?: string; b?: string; yaml?: string; writeup?: string } = {}): FakeWorld['commands'] {
  const commands: FakeWorld['commands'] = {
    [`sha256sum ${OUT_A}`]: { exitCode: 0, stdout: `${a}  ${OUT_A}\n` },
    [`sha256sum ${OUT_B}`]: { exitCode: 0, stdout: `${b}  ${OUT_B}\n` },
  };

  const leeds = yaml.split('\n').filter((line) => line.includes('leeds:')).length;
  commands[`grep -c leeds: ${YAML_FIX}`] =
    leeds > 0 ? { exitCode: 0, stdout: `${leeds}\n` } : { exitCode: 1, stdout: '0\n' };

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
  commands?: FakeWorld['commands'];
  yaml?: string;
  writeup?: string;
  mode?: string;
}

function solved({
  source = SOURCE,
  scripts = runs(),
  yaml = REPAIRED,
  writeup = WRITTEN_UP,
  commands = inspections({ yaml, writeup }),
  mode = '755',
}: World = {}): FakeWorld {
  const files: FakeWorld['files'] = {};
  if (source !== undefined) files[LOADER] = { content: source, mode };
  if (yaml !== undefined) files[YAML_FIX] = { content: yaml, mode: '644' };
  if (writeup !== undefined) files[WRITEUP] = { content: writeup, mode: '644' };
  return { files, scripts, commands };
}

let cached: LoadedLabDefinition | undefined;
async function lab(): Promise<LoadedLabDefinition> {
  cached ??= await loadLabDefinition(CS_010);
  return cached;
}
async function verify(world: FakeWorld) {
  return verifyLab({ lab: await lab(), sandbox: new FakeSandbox(world), namespace: SANDBOX });
}
function failed(checks: readonly { status: string; label: string }[]): string[] {
  return checks.filter((c) => c.status === 'fail').map((c) => c.label);
}

describe('CS-010 before the student does anything', () => {
  it('fails every check, and none is skipped', async () => {
    const result = await verify({ files: {}, scripts: {}, commands: {} });
    const definition = await lab();

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(definition.requirements.length);
    expect(result.checks.every((c) => c.status === 'fail')).toBe(true);
  });
});

describe('CS-010 when the config is validated and normalised', () => {
  it('passes', async () => {
    const result = await verify(solved());

    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes a repair that quotes with single quotes instead', async () => {
    // Both spellings parse to the identical document, so both are correct. The
    // absent-checks name the broken spelling precisely so neither is favoured.
    const singleQuoted = REPAIRED.replace('"no"', "'no'").replace('"3.10"', "'3.10'");

    const result = await verify(solved({ yaml: singleQuoted }));
    expect(result.passed).toBe(true);
  });
});

describe('CS-010 rejects a normalisation that is not canonical', () => {
  it('rejects output that is a different serialisation of the right document', async () => {
    // Four spellings differ from the contract and each changes the digest:
    // no trailing newline, indent 4, no indent, and keys left unsorted. Measured
    // in the real image — all four produce a digest that is not the canonical one.
    const notCanonical = inspections({ a: '0'.repeat(64) });

    const result = await verify(solved({ commands: notCanonical }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The collector’s config normalises to the canonical form'.replace('’', "'"),
    ]);
  });

  it('rejects normalising only one of the two configs', async () => {
    // The whole point is that these two files are the same config. Getting one
    // right and not the other means the canonical form is not canonical.
    const onlyA = inspections({ b: '0'.repeat(64) });

    const result = await verify(solved({ commands: onlyA }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      "The console's export normalises to the very same bytes",
    ]);
  });

  it('rejects a missing normalised file, because the hash command fails', async () => {
    const absent = { ...inspections(), [`sha256sum ${OUT_A}`]: { exitCode: 1, stderr: 'No such file\n' } };

    const result = await verify(solved({ commands: absent }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain("The collector's config normalises to the canonical form");
  });
});

describe('CS-010 rejects a loader that does not tell the failures apart', () => {
  it('rejects one exit status used for every bad config', async () => {
    const undifferentiated = {
      ...runs(),
      [`${LOADER} ${CONFIG}/depot-missing.json /home/student/out/missing.json`]: {
        exitCode: 1,
        stderr: 'CONFIG_ERROR=missing-key key=region\n',
      },
      [`${LOADER} ${CONFIG}/depot-broken.json /home/student/out/broken.json`]: {
        exitCode: 1,
        stderr: 'CONFIG_ERROR=invalid-json\n',
      },
    };

    const result = await verify(solved({ scripts: undifferentiated }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'A config with a key absent is reported, and the key is named',
      'A file that is not JSON is told apart from a config that is merely wrong',
    ]);
  });

  it('rejects treating an unparseable file as merely invalid', async () => {
    // The distinction the lab is about: `json.JSONDecodeError` is not the same
    // event as a config that loaded fine and is the wrong shape.
    const conflated = {
      ...runs(),
      [`${LOADER} ${CONFIG}/depot-broken.json /home/student/out/broken.json`]: {
        exitCode: 2,
        stderr: 'CONFIG_ERROR=missing-key key=depot\n',
      },
    };

    const result = await verify(solved({ scripts: conflated }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'A file that is not JSON is told apart from a config that is merely wrong',
    ]);
  });

  it('rejects naming the wrong key', async () => {
    const wrongKey = {
      ...runs(),
      [`${LOADER} ${CONFIG}/depot-missing.json /home/student/out/missing.json`]: {
        exitCode: 2,
        stderr: 'CONFIG_ERROR=missing-key key=depot\n',
      },
    };

    const result = await verify(solved({ scripts: wrongKey }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'A config with a key absent is reported, and the key is named',
    ]);
  });
});

describe('CS-010 rejects a YAML repair that is not a repair', () => {
  it('rejects leaving the untagged boolean unquoted', async () => {
    const unquoted = REPAIRED.replace('country: "no"', 'country: no');

    const result = await verify(solved({ yaml: unquoted }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The country is quoted, so it stays a country and does not become false',
    ]);
  });

  it('rejects leaving the version unquoted', async () => {
    const unquoted = REPAIRED.replace('version: "3.10"', 'version: 3.10');

    const result = await verify(solved({ yaml: unquoted }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The version is quoted, so it stays 3.10 and does not become 3.1',
    ]);
  });

  it('rejects leaving the tab in', async () => {
    const tabbed = REPAIRED.replace('    enabled: yes\n  bristol', '\tenabled: yes\n  bristol');

    const result = await verify(solved({ yaml: tabbed }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The indentation is spaces, which is the only indentation YAML allows',
    ]);
  });

  it('rejects keeping the duplicate block', async () => {
    const duplicated = `${REPAIRED}  leeds:\n    country: gb\n    version: "1.0"\n    enabled: no\n`;
    const result = await verify(solved({ yaml: duplicated }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The duplicated depot key appears once, and still appears',
      'The values the duplicate block was silently winning with are gone',
    ]);
  });

  it('rejects renaming the duplicate instead of removing it', async () => {
    // `grep -c leeds:` now counts one, but the stale values the second block
    // was winning with are still in the file and still wrong.
    const renamed = `${REPAIRED}  leeds-old:\n    country: gb\n    version: "1.0"\n    enabled: no\n`;

    const result = await verify(solved({ yaml: renamed }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The values the duplicate block was silently winning with are gone',
    ]);
  });

  it('rejects deleting the depot rather than repairing it', async () => {
    const deleted = ['# kestrel', 'depots:', '  bristol:', '    country: gb', ''].join('\n');
    const result = await verify(solved({ yaml: deleted }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The duplicated depot key appears once, and still appears');
  });
});

describe('CS-010 rejects a write-up that guessed', () => {
  it('rejects the version the file says rather than the version YAML produced', async () => {
    const wrong = WRITTEN_UP.replace('VERSION_BECAME=3.1\n', 'VERSION_BECAME=3.10\n');

    const result = await verify(solved({ writeup: wrong }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The write-up records the version that was actually deployed',
    ]);
  });

  it('rejects the country the file says rather than the value YAML produced', async () => {
    const wrong = WRITTEN_UP.replace('COUNTRY_BECAME=false', 'COUNTRY_BECAME=no');

    const result = await verify(solved({ writeup: wrong }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The write-up records what the country became']);
  });

  it('rejects naming the wrong depot for the tab', async () => {
    const wrong = WRITTEN_UP.replace('TAB_DEPOT=bristol', 'TAB_DEPOT=leeds');

    const result = await verify(solved({ writeup: wrong }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The write-up names the depot whose line stopped the file parsing',
    ]);
  });
});

describe('CS-010 rejects forged evidence and typed-out answers', () => {
  it('rejects a loader that matches on the filename instead of parsing', async () => {
    // Behaves perfectly on all five configs without opening one. The three
    // checks that bar the answers from the source are what stop it.
    const table = [
      '#!/bin/sh',
      'case "$1" in',
      '  *depot-missing*) echo "CONFIG_ERROR=missing-key key=region" >&2; exit 2 ;;',
      '  *depot-wrongtype*) echo "CONFIG_ERROR=wrong-type key=enabled" >&2; exit 3 ;;',
      '  *depot-broken*) echo "CONFIG_ERROR=invalid-json" >&2; exit 4 ;;',
      'esac',
      'cat <<JSON > "$2"',
      '{ "depot": "leeds" }',
      'JSON',
      'echo CONFIG_OK',
      '',
    ].join('\n');

    const result = await verify(solved({ source: table }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The loader works out which key is absent rather than containing the answer',
      'The loader works out which key is mistyped rather than containing the answer',
      'The loader normalises the config rather than containing it',
    ]);
  });

  it('rejects a perfect write-up and a repaired YAML behind a loader that does nothing', async () => {
    // The YAML half and the write-up are student-written, so they are only safe
    // to grade because the loader is graded independently by being run.
    // A loader that never ran wrote no normalised files, so the hash checks
    // fail on the missing file rather than on its contents.
    const nothingWritten = {
      ...inspections(),
      [`sha256sum ${OUT_A}`]: { exitCode: 1, stderr: 'No such file or directory\n' },
      [`sha256sum ${OUT_B}`]: { exitCode: 1, stderr: 'No such file or directory\n' },
    };

    const result = await verify(
      solved({ source: '#!/bin/sh\nexit 0\n', scripts: {}, commands: nothingWritten }),
    );

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'The collector\'s config is accepted',
      'The console\'s export of the same config is accepted too',
      'A config with a key absent is reported, and the key is named',
      'A config with a key of the wrong type is reported, and the key is named',
      'A file that is not JSON is told apart from a config that is merely wrong',
      'The collector\'s config normalises to the canonical form',
      'The console\'s export normalises to the very same bytes',
    ]);
  });

  it('rejects a broken loader even when a previous attempt left correct output behind', async () => {
    // The normalised files are graded where they lie, so a student who solved
    // the lab once and then broke the loader still has two files that hash
    // correctly. That is deliberate — those two checks are not the defence.
    // The five that run the loader are, and they fail, so the lab does not pass
    // on a stale artifact.
    const stillCorrect = inspections();

    const result = await verify(
      solved({ source: '#!/bin/sh\nexit 1\n', scripts: {}, commands: stillCorrect }),
    );

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      "The collector's config is accepted",
      "The console's export of the same config is accepted too",
      'A config with a key absent is reported, and the key is named',
      'A config with a key of the wrong type is reported, and the key is named',
      'A file that is not JSON is told apart from a config that is merely wrong',
    ]);
  });

  it('rejects a program that is not executable', async () => {
    const result = await verify(solved({ mode: '644' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The loader exists and can be run as a program');
  });
});

describe('CS-010 grading hygiene', () => {
  it('keeps the digest, the key names and the trap values out of the failure details', async () => {
    const broken: FakeWorld['scripts'] = {};
    for (const key of Object.keys(runs() ?? {})) broken[key] = { exitCode: 9, stdout: 'nope\n' };

    const result = await verify(
      solved({ source: '#!/bin/sh\nexit 9\n', scripts: broken, commands: {}, yaml: 'nope\n', writeup: 'nope\n' }),
    );
    for (const check of result.checks) {
      expect(check.detail ?? '', check.label).not.toMatch(
        /d8cd267f|key=region|key=enabled|COUNTRY_BECAME|VERSION_BECAME|TAB_DEPOT|DUPLICATE_KEY/,
      );
    }
  });

  it('grades only the student’s own artifacts, never the seeded configs', async () => {
    const sandbox = new FakeSandbox(solved());
    await verifyLab({ lab: await lab(), sandbox, namespace: SANDBOX });

    expect(new Set(sandbox.reads)).toEqual(new Set([LOADER, YAML_FIX]));
    for (const inspection of sandbox.inspections) {
      expect(inspection).toMatch(/^(sha256sum|grep) /);
      expect(inspection).toContain('/home/student/');
    }
  });

  it('runs the student’s own loader every time, and bounds every run', async () => {
    for (const requirement of (await lab()).requirements) {
      if (requirement.type !== 'script_runs') continue;
      // No seeded grading harness: what runs is always what the student wrote.
      expect(requirement.path).toBe(LOADER);
      expect(requirement.args).toHaveLength(2);
      expect(requirement.args[0]).toMatch(/^\/srv\/kestrel\/config\//);
      expect(requirement.args[1]).toMatch(/^\/home\/student\/out\//);
      expect(requirement.timeout_seconds).toBeGreaterThan(0);
      expect(requirement.timeout_seconds).toBeLessThanOrEqual(60);
    }
  });

  it('grades nothing outside the student’s home', async () => {
    for (const requirement of (await lab()).requirements) {
      const target = (requirement as { path?: string }).path;
      if (target) expect(target).toMatch(/^\/home\/student\//);
      const args = (requirement as { args?: string[] }).args;
      if (requirement.type === 'command_output') {
        for (const arg of args ?? []) {
          if (arg.startsWith('/')) expect(arg).toMatch(/^\/home\/student\//);
        }
      }
    }
  });

  it('normalises both seeded configs to one digest, which is the lab', async () => {
    const digests = (await lab()).requirements
      .filter((r) => r.type === 'command_output' && r.command === 'sha256sum')
      .map((r) => (r as { contains: string }).contains);

    expect(digests).toHaveLength(2);
    expect(new Set(digests).size).toBe(1);
    expect(digests[0]).toBe(CANONICAL);
  });
});
