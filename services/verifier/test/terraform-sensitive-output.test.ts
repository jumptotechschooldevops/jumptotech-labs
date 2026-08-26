/**
 * PLATFORM-006 AC-1 — a sensitive Terraform output never reaches a browser.
 *
 * Terraform stores outputs marked `sensitive = true` in `terraform.tfstate` in
 * cleartext, and `terraform_output_equals` reads that state directly. Before
 * this, a failing check interpolated the value it found into the failure
 * detail — which the API spreads into its response and the UI renders. The
 * state file already carried the `sensitive` flag and the reader already
 * parsed it; the handler simply never consulted it.
 *
 * No shipped or in-flight lab used a sensitive output, so nothing leaked in
 * practice. The primitive was unsafe by construction, which is what these
 * tests pin shut.
 *
 * The rule has since been tightened past `sensitive`, and these tests moved
 * with it. `sensitive` marks only the outputs whose author thought to mark
 * one, so the handler now withholds *every* actual value, marked or not, and
 * the expected value with it — the expected value is the answer, and repeating
 * it turns a failed check into a solution. What a failure may still carry is
 * the output's name and its shape: a type is structural metadata, not a value.
 */
import { describe, expect, it } from 'vitest';
import type { Requirement } from '@jumptotech/lab-orchestrator';
import { SandboxReader, verifyRequirement } from '../src/index.js';
import { FakeSandbox } from './sandbox-fake.js';

const SECRET = 'super-secret-database-password';

/** State with one output, optionally marked sensitive. */
function state(value: string, sensitive: boolean): string {
  return JSON.stringify({
    version: 4,
    outputs: { db_password: { value, type: 'string', ...(sensitive ? { sensitive: true } : {}) } },
    resources: [],
  });
}

function check(value: string, sensitive: boolean) {
  const sandbox = new FakeSandbox({
    files: { 'terraform/terraform.tfstate': { type: 'file', content: state(value, sensitive) } },
  });
  const requirement = {
    type: 'terraform_output_equals',
    dir: 'terraform',
    name: 'db_password',
    value: 'expected-value',
    label: 'The output has the expected value',
  } as unknown as Requirement;
  return verifyRequirement(requirement, { sandbox: new SandboxReader(sandbox) });
}

describe('terraform_output_equals — sensitive outputs', () => {
  it('withholds the value of a sensitive output that does not match', async () => {
    const result = await check(SECRET, true);

    expect(result.status).toBe('fail');
    // The property, not the phrasing: the secret is absent from the whole
    // serialised result, which is what the API spreads into its response.
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.detail).toContain('sensitive');
  });

  it('still names the output, so the student knows what to look at', async () => {
    const result = await check(SECRET, true);
    expect(result.detail).toContain('db_password');
  });

  it('passes a sensitive output that does match, without echoing it', async () => {
    const result = await check('expected-value', true);

    expect(result.status).toBe('pass');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('withholds the actual value of an output that is not marked sensitive', async () => {
    // The tightened rule. `sensitive` marks only what an author remembered to
    // mark, and the lesson of a sensitive-data lab is that an unmarked output
    // can still hold a credential — so the platform does not repeat any actual
    // value, and does not decide which ones are safe.
    const result = await check('build/wrong-path.txt', false);

    expect(result.status).toBe('fail');
    expect(result.detail).not.toContain('build/wrong-path.txt');
  });

  it('names the output and its shape, which is what a student can act on', async () => {
    const result = await check('build/wrong-path.txt', false);

    expect(result.detail).toContain('db_password');
    expect(result.detail).toContain('string');
  });

  it('never repeats the expected value, which is the answer', async () => {
    for (const sensitive of [true, false]) {
      const result = await check('build/wrong-path.txt', sensitive);
      expect(JSON.stringify(result), `sensitive=${sensitive}`).not.toContain('expected-value');
    }
  });
});
