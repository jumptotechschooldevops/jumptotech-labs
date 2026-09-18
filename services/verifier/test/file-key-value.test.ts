/**
 * `file_key_value` — one answer on a worksheet, given once.
 *
 * The requirement exists because `file_content contains` could not grade a
 * worksheet: a student who wrote every allowed value on its own line
 * satisfied every `contains` at once. The cases below are the hedges that used
 * to pass, and the ordinary ways of writing a right answer that must keep
 * passing.
 */
import { describe, expect, it } from 'vitest';
import { requirementSchema, type Requirement } from '@jumptotech/lab-orchestrator';
import { SandboxReader, verifyRequirement } from '../src/index.js';
import { keyValues } from '../src/handlers/filesystem.js';
import { FakeSandbox } from './sandbox-fake.js';

const PATH = '/home/student/triage/triage.txt';

function check(content: string | undefined, fields: Record<string, unknown> = {}) {
  const requirement = requirementSchema.parse({
    type: 'file_key_value',
    path: PATH,
    key: 'refused_layer',
    equals: 'L4',
    ...fields,
  }) as Requirement;
  const sandbox = new FakeSandbox(content === undefined ? {} : { files: { [PATH]: { content } } });
  return verifyRequirement(requirement, new SandboxReader(sandbox));
}

const WORKSHEET = (answer: string) => `JumpToTech Bank — layer triage
Fill in the value after each "= ". Do not change the labels.
Allowed values: L1  L2  L3  L4  L5  L6  L7

  refused_layer = ${answer}
  unreachable_layer = L3
`;

describe('file_key_value accepts a right answer however it is written', () => {
  it.each([
    ['the seeded line filled in', WORKSHEET('L4')],
    ['no spaces', 'refused_layer=L4\n'],
    ['trailing whitespace and CRLF', 'refused_layer =   L4   \r\n'],
    ['quoted', 'refused_layer = "L4"\n'],
    ['an env-file export', 'export refused_layer=L4\n'],
    ['a blank placeholder left alongside the answer', 'refused_layer = \nrefused_layer = L4\n'],
    ['a comment that repeats the key', '# refused_layer = L3 was my first guess\nrefused_layer = L4\n'],
  ])('%s', async (_name, content) => {
    expect((await check(content)).status).toBe('pass');
  });

  it('compares case-insensitively only when asked to', async () => {
    expect((await check('refused_layer = l4\n')).status).toBe('fail');
    expect((await check('refused_layer = l4\n', { ignore_case: true })).status).toBe('pass');
  });

  it('reads a colon-separated file when told to', async () => {
    expect((await check('refused_layer: L4\n', { separator: ':' })).status).toBe('pass');
    expect((await check('refused_layer: L4\n')).status).toBe('fail');
  });
});

describe('file_key_value fails a hedge, and never says what the answer is', () => {
  it('fails every value listed on one line', async () => {
    const result = await check(WORKSHEET('L4 L3'));
    expect(result.status).toBe('fail');
    expect(result.detail).toBe(`'${PATH}' has the wrong value for refused_layer`);
  });

  it('fails the right value given alongside a wrong one on another line', async () => {
    const result = await check(`${WORKSHEET('L4')}refused_layer = L3\n`);
    expect(result.status).toBe('fail');
    expect(result.detail).toBe(`'${PATH}' answers refused_layer 2 times — give one answer`);
  });

  it('fails one line per allowed value, the shotgun a substring check accepted', async () => {
    const shotgun = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'].map((l) => `refused_layer = ${l}`).join('\n');
    expect((await check(shotgun)).status).toBe('fail');
  });

  it('fails a longer value that merely starts with the answer', async () => {
    expect((await check('refused_layer = L45\n')).status).toBe('fail');
  });

  it('distinguishes an unanswered key from a wrong one, without the expected value', async () => {
    const blank = await check(WORKSHEET(''));
    expect(blank.detail).toBe(`'${PATH}' has no answer for refused_layer`);
    const wrong = await check(WORKSHEET('L7'));
    expect(wrong.detail).not.toContain('L4');
    expect(wrong.detail).not.toContain('L7');
  });

  it('does not take a different key that ends with this one', async () => {
    expect((await check('not_refused_layer = L4\n')).status).toBe('fail');
  });

  it('fails a missing file and a file too large to read in full', async () => {
    expect((await check(undefined)).status).toBe('fail');
    const sandbox = new FakeSandbox({ files: { [PATH]: { content: 'refused_layer = L4\n', truncated: true } } });
    const requirement = requirementSchema.parse({ type: 'file_key_value', path: PATH, key: 'refused_layer', equals: 'L4' });
    expect((await verifyRequirement(requirement as Requirement, new SandboxReader(sandbox))).status).toBe('fail');
  });
});

describe('file_key_value is refused when a lab writes it wrongly', () => {
  it.each([
    ['a key with a separator in it', { key: 'a=b' }],
    ['a key with surrounding spaces', { key: ' refused_layer' }],
    ['a comment mark in the key', { key: '#refused_layer' }],
    ['an empty expected value', { equals: '' }],
    ['an unknown separator', { separator: ';' }],
  ])('%s', (_name, fields) => {
    expect(() =>
      requirementSchema.parse({ type: 'file_key_value', path: PATH, key: 'refused_layer', equals: 'L4', ...fields }),
    ).toThrow();
  });
});

describe('keyValues parses in one pass', () => {
  it('handles a hostile line in linear time', () => {
    const line = `refused_layer${' '.repeat(200_000)}= ${' '.repeat(200_000)}L4${' '.repeat(200_000)}x`;
    const started = performance.now();
    expect(keyValues(line, 'refused_layer', '=')).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
