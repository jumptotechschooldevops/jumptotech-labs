/**
 * The linear line parsers that replaced `(.+?)\s*$` — see `src/line-value.ts`.
 *
 * Two properties. They agree with the patterns they replaced on every input
 * that pattern could be run on quickly, and they stay fast on the inputs where
 * that pattern took seconds.
 */
import { describe, expect, it } from 'vitest';
import { matchLineValue, valueAfterSeparator } from '../src/line-value.js';
import { parseProcessTable } from '../src/sandbox-reader.js';
import { scanTextForAssignments } from '../src/ci/secrets.js';

/** A tiny deterministic generator, so a failure names a reproducible input. */
function* randomLines(seed: number, count: number, alphabet: readonly string[], maxTokens: number) {
  let state = seed;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state;
  };
  for (let i = 0; i < count; i += 1) {
    const tokens = next() % (maxTokens + 1);
    let line = '';
    for (let t = 0; t < tokens; t += 1) line += alphabet[next() % alphabet.length];
    yield line;
  }
}

const ALPHABET = ['a', 'Z', '_', '-', '1', ' ', '  ', '\t', '\r', '\u2028', '\u00a0', ':', '=', 'export ', '.'];

/** What the old patterns captured, for comparison only. */
const OLD = {
  process: /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/,
  secrets: /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*(.+?)\s*$/,
  jenkins: /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/,
  separator: /[:=]\s*(.+?)\s*$/,
};

/** The old capture, minus the one case this change drops on purpose. */
function oldValue(match: RegExpExecArray | null, group: number): string | undefined {
  const value = match?.[group];
  return value === undefined || value.trim() === '' ? undefined : value;
}

describe('linear line values agree with the patterns they replaced', () => {
  it('for a process table line', () => {
    const prefix = /^\s*(\d+)\s+(\S+)\s+/;
    for (const line of randomLines(1, 20_000, [...ALPHABET, '42 ', 'root '], 12)) {
      const old = OLD.process.exec(line);
      const now = matchLineValue(line, prefix);
      expect({ line, value: now?.value }).toEqual({ line, value: oldValue(old, 3) });
      if (now && old) expect([now.groups[1], now.groups[2]]).toEqual([old[1], old[2]]);
    }
  });

  it('for a secret-shaped assignment', () => {
    const prefix = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*/;
    for (const line of randomLines(2, 20_000, ALPHABET, 12)) {
      const old = OLD.secrets.exec(line);
      const now = matchLineValue(line, prefix);
      expect({ line, value: now?.value }).toEqual({ line, value: oldValue(old, 2) });
      if (now && old) expect(now.groups[1]).toEqual(old[1]);
    }
  });

  it('for a Jenkinsfile environment assignment', () => {
    const prefix = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/;
    for (const line of randomLines(3, 20_000, ALPHABET, 12)) {
      const old = OLD.jenkins.exec(line);
      const now = matchLineValue(line, prefix);
      expect({ line, value: now?.value }).toEqual({ line, value: oldValue(old, 2) });
    }
  });

  it('for the first separator on an unanchored line', () => {
    for (const line of randomLines(4, 40_000, [...ALPHABET, '\n'], 14)) {
      expect({ line, value: valueAfterSeparator(line) }).toEqual({
        line,
        value: oldValue(OLD.separator.exec(line), 1),
      });
    }
  });
});

describe('linear line values stay fast on adversarial lines', () => {
  const RUN = 250_000;
  const budgetMs = 250;

  it('parses a process line with a quarter-megabyte argument', () => {
    // The shape a student gets from `sh -c 'sleep 1e6' x "<spaces>y"`: ~15 s
    // for 100 KiB with the old pattern, on the API's event loop.
    const line = `    7 student  sh -c sleep 1e6 x ${' '.repeat(RUN)}y`;
    const started = performance.now();
    const [entry] = parseProcessTable(line);
    expect(performance.now() - started).toBeLessThan(budgetMs);
    expect(entry).toMatchObject({ pid: 7, user: 'student' });
    expect(entry!.command.endsWith('y')).toBe(true);
  });

  it('scans a pipeline file holding a long whitespace run', () => {
    const text = `API_TOKEN=x${' '.repeat(RUN)}y\n`;
    const started = performance.now();
    const found = scanTextForAssignments(text, '.env');
    expect(performance.now() - started).toBeLessThan(budgetMs);
    expect(found[0]?.key).toBe('API_TOKEN');
  });

  it('finds a separator value in a long line', () => {
    const line = `token:x${' '.repeat(RUN)}y`;
    const started = performance.now();
    expect(valueAfterSeparator(line)?.endsWith('y')).toBe(true);
    expect(performance.now() - started).toBeLessThan(budgetMs);
  });

  it('matches an anchored prefix in a long line', () => {
    const line = `NAME = x${' \t'.repeat(RUN / 2)}y`;
    const started = performance.now();
    expect(matchLineValue(line, /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/)?.value.endsWith('y')).toBe(true);
    expect(performance.now() - started).toBeLessThan(budgetMs);
  });
});
