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
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.detail).toContain('withheld');
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

  it('still reports the actual value for an output that is not sensitive', async () => {
    // Unchanged behaviour where there is no secret: a Terraform lab that checks
    // a path or a count is more useful when it says what it found.
    const result = await check('build/wrong-path.txt', false);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('build/wrong-path.txt');
  });
});
