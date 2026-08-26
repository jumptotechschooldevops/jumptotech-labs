/**
 * PLATFORM-SEC — a Terraform output's value must never reach the student.
 *
 * `terraform_output_equals` used to answer a failed comparison by quoting what
 * it found: `Output 'db_password' is 's3cret'`. A `CheckResult`'s `detail` is
 * serialised straight into the API response the browser reads, so that string
 * was a disclosure channel — and `sensitive: true` in state, which the reader
 * already parsed, was never consulted.
 *
 * These tests are the regression fence. They assert the two things that must
 * hold for every future change to this handler:
 *
 *   1. the verdict is still correct — semantics were not traded for silence;
 *   2. neither the expected value nor the actual value appears anywhere in the
 *      result, for any output type, sensitive or not.
 *
 * The placeholders below are obviously fake on purpose. A test that needs a
 * real-looking secret to be meaningful is a test that would leak one if it
 * ever printed its fixtures.
 */
import { describe, expect, it } from 'vitest';
import { verifyRequirement, verifyRequirements } from '../src/registry.js';
import { SandboxReader } from '../src/sandbox-reader.js';
import { FakeSandbox } from './sandbox-fake.js';

const DIR = 'terraform';
const EXPECTED = 'EXPECTED-VALUE-must-never-be-shown';
const ACTUAL = 'ACTUAL-VALUE-must-never-be-shown';

function stateWith(outputs: Record<string, unknown>): string {
  return JSON.stringify({
    version: 4,
    terraform_version: '1.9.8',
    serial: 3,
    lineage: 'aaaa-bbbb',
    outputs,
    resources: [],
  });
}

function readerFor(outputs: Record<string, unknown>): SandboxReader {
  return new SandboxReader(
    new FakeSandbox({
      files: {
        terraform: { type: 'directory', mode: '755' },
        'terraform/terraform.tfstate': { type: 'file', mode: '644', content: stateWith(outputs) },
      },
    } as never),
  );
}

const check = (outputs: Record<string, unknown>, name: string, value: string) =>
  verifyRequirement(
    { type: 'terraform_output_equals', dir: DIR, name, value } as never,
    readerFor(outputs),
  );

/** Everything a student could ever see from one check. */
const surfaceOf = (result: { label: string; detail?: string; status: string; id: string }) =>
  JSON.stringify(result);

// ------------------------------------------------------- semantics preserved

describe('PLATFORM-SEC — the check still decides correctly', () => {
  it('passes when the value matches', async () => {
    const result = await check({ token: { value: EXPECTED, type: 'string' } }, 'token', EXPECTED);
    expect(result.status).toBe('pass');
  });

  it('fails when the value does not match', async () => {
    const result = await check({ token: { value: ACTUAL, type: 'string' } }, 'token', EXPECTED);
    expect(result.status).toBe('fail');
  });

  it('passes for a sensitive output whose value matches', async () => {
    const result = await check(
      { token: { value: EXPECTED, type: 'string', sensitive: true } },
      'token',
      EXPECTED,
    );
    // Silence is not refusal: a sensitive output is still compared.
    expect(result.status).toBe('pass');
  });

  it('fails for a sensitive output whose value does not match', async () => {
    const result = await check(
      { token: { value: ACTUAL, type: 'string', sensitive: true } },
      'token',
      EXPECTED,
    );
    expect(result.status).toBe('fail');
  });
});

// -------------------------------------------------------------- no disclosure

describe('PLATFORM-SEC — no value reaches the student', () => {
  it('does not disclose the actual value of a sensitive output', async () => {
    const result = await check(
      { token: { value: ACTUAL, type: 'string', sensitive: true } },
      'token',
      EXPECTED,
    );
    expect(surfaceOf(result)).not.toContain(ACTUAL);
  });

  it('does not disclose the actual value of a NON-sensitive output either', async () => {
    // The lesson of a sensitive-data lab is that an unmarked output can still
    // hold a credential. The handler cannot tell, so it never repeats a value.
    const result = await check({ token: { value: ACTUAL, type: 'string' } }, 'token', EXPECTED);
    expect(surfaceOf(result)).not.toContain(ACTUAL);
  });

  it('never discloses the expected value — it is the answer', async () => {
    const result = await check({ token: { value: ACTUAL, type: 'string' } }, 'token', EXPECTED);
    expect(surfaceOf(result)).not.toContain(EXPECTED);
  });

  it('discloses nothing from a structured output', async () => {
    const secretMap = { username: 'ACTUAL-user', password: ACTUAL };
    const result = await check(
      { creds: { value: secretMap, type: ['object', {}], sensitive: true } },
      'creds',
      JSON.stringify({ username: 'EXPECTED-user', password: EXPECTED }),
    );
    expect(result.status).toBe('fail');
    const surface = surfaceOf(result);
    for (const leak of [ACTUAL, EXPECTED, 'ACTUAL-user', 'EXPECTED-user']) {
      expect(surface).not.toContain(leak);
    }
  });

  it('discloses nothing from a list output', async () => {
    const result = await check(
      { hosts: { value: [ACTUAL, 'second'], type: ['list', 'string'] } },
      'hosts',
      JSON.stringify([EXPECTED]),
    );
    expect(result.status).toBe('fail');
    expect(surfaceOf(result)).not.toContain(ACTUAL);
  });

  it('still says something useful — the name and the shape, which are not values', async () => {
    const result = await check(
      { hosts: { value: ['a', 'b', 'c'], type: ['list', 'string'] } },
      'hosts',
      'nope',
    );
    expect(result.detail).toContain('hosts');
    expect(result.detail).toContain('a list of 3 items');
  });

  it('says a sensitive output was not read, rather than pretending it has no shape', async () => {
    const result = await check(
      { token: { value: ACTUAL, type: 'string', sensitive: true } },
      'token',
      EXPECTED,
    );
    expect(result.detail).toContain('marked sensitive');
  });

  it('leaks nothing through the whole-lab result payload either', async () => {
    const results = await verifyRequirements(
      [
        { type: 'terraform_output_equals', dir: DIR, name: 'token', value: EXPECTED },
        { type: 'terraform_output_equals', dir: DIR, name: 'missing', value: EXPECTED },
      ] as never,
      readerFor({ token: { value: ACTUAL, type: 'string', sensitive: true } }),
    );
    const payload = JSON.stringify(results);
    expect(payload).not.toContain(ACTUAL);
    expect(payload).not.toContain(EXPECTED);
  });
});

// ------------------------------------------------- structured comparison kept

describe('PLATFORM-SEC — structured outputs still compare semantically', () => {
  const cases: Array<[string, unknown, string, boolean]> = [
    ['string', 'ledger-api', 'ledger-api', true],
    ['number as digits', 8080, '8080', true],
    ['boolean', true, 'true', true],
    ['null as empty', null, '', true],
    ['list in order', ['a', 'b'], '["a","b"]', true],
    ['list out of order', ['b', 'a'], '["a","b"]', false],
    ['object, key order irrelevant', { a: 1, b: 2 }, '{"b":2,"a":1}', true],
    ['object, missing key', { a: 1 }, '{"a":1,"b":2}', false],
    ['object, extra key', { a: 1, b: 2, c: 3 }, '{"a":1,"b":2}', false],
    ['nested structure', { a: [1, { b: 'x' }] }, '{"a":[1,{"b":"x"}]}', true],
    ['nested mismatch', { a: [1, { b: 'y' }] }, '{"a":[1,{"b":"x"}]}', false],
  ];

  for (const [name, actual, expected, shouldPass] of cases) {
    it(`${shouldPass ? 'passes' : 'fails'}: ${name}`, async () => {
      const result = await check({ out: { value: actual, type: 'any' } }, 'out', expected);
      expect(result.status).toBe(shouldPass ? 'pass' : 'fail');
    });
  }

  it('is equality, never a substring match', async () => {
    const result = await check({ out: { value: 'ledger-api-v2', type: 'string' } }, 'out', 'ledger-api');
    expect(result.status).toBe('fail');
  });

  it('falls back to canonical rendering when the expected text is not JSON', async () => {
    // A lab that wrote a list expectation by hand rather than as JSON still
    // works the way it always did.
    const result = await check({ out: { value: ['a', 'b'], type: 'any' } }, 'out', '["a","b"]');
    expect(result.status).toBe('pass');
  });
});

// ------------------------------------------------------- unchanged behaviour

describe('PLATFORM-SEC — existing behaviour is compatible', () => {
  it('still reports a missing output by listing the names that do exist', async () => {
    const result = await check({ other: { value: 'x', type: 'string' } }, 'wanted', 'x');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('other');
    expect(result.detail).toContain('wanted');
  });

  it('still reports "no outputs" when state declares none', async () => {
    const result = await check({}, 'wanted', 'x');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('no outputs');
  });

  it('still reports missing state', async () => {
    const reader = new SandboxReader(
      new FakeSandbox({ files: { terraform: { type: 'directory', mode: '755' } } } as never),
    );
    const result = await verifyRequirement(
      { type: 'terraform_output_equals', dir: DIR, name: 'x', value: 'y' } as never,
      reader,
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('nothing has been applied');
  });
});
