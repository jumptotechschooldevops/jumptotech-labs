/**
 * AWS-001 — verification behaviour.
 *
 * AWS-001 is a SIMULATED lab: no AWS account, no credentials, no API call.
 * Nothing in this file touches AWS either — the sandbox is in memory and the
 * requirements come from the real `labs/aws/aws-001-credentials-and-arns`
 * definition, so these tests grade the lab exactly as the platform will.
 *
 * The three properties under test:
 *
 *   1. **State, not transcript.** Nothing reads what the student typed. The
 *      graded artefacts are the findings sheet and the repaired credentials
 *      file, and two different routes to the same file content pass alike.
 *   2. **The lab fails before the work and passes after it**, with plausible
 *      wrong answers failing rather than being waved through.
 *   3. **No failure detail reveals an answer.** A student clicking Check on an
 *      empty sheet must not be handed the solution.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type SandboxPathRead } from '@jumptotech/lab-orchestrator';
import { verifyLab, type SandboxPort } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const AWS_001 = path.join(LABS_DIR, 'aws', 'aws-001-credentials-and-arns', 'lab.yaml');

const FINDINGS = '/home/student/aws-incident/findings.env';
const DEPLOY = '/home/student/aws-incident/deploy/credentials';

/** Exactly what `setup/seed.sh` writes, so "initial state" means initial state. */
const SEEDED_FINDINGS = `# Incident 4471 — findings
#
# Replace every FILL_ME below. Use exactly KEY=value, with no spaces around
# the '=' sign and nothing after the value on the line.

CAPTURE_1_SOURCE=FILL_ME
CAPTURE_2_SOURCE=FILL_ME
CAPTURE_3_SOURCE=FILL_ME

ARN_1=FILL_ME
ARN_2=FILL_ME
ARN_3=FILL_ME
ARN_4=FILL_ME
ARN_5=FILL_ME
`;

const SEEDED_DEPLOY = `# Shipped by the deployment pipeline to ~/.aws/credentials on the
# reconciliation host. The batch job runs with --profile reconciliation and
# reports that the profile cannot be found.

[default]
aws_access_key_id = AKIAI99QH8DHGEXAMPLE
aws_secret_access_key = 7kMtGbClwBF/2Zp9Utk/h3yCoEXAMPLEKEY

[profile reconciliation]
aws_access_key_id = AKIAI88QH8DHFEXAMPLE
aws_secret_access_key = 3nMtGbClwBF/2Zp9Utk/h3yCoEXAMPLEKEY
`;

const SOLVED_FINDINGS = `# Incident 4471 — findings

CAPTURE_1_SOURCE=environment_variables
CAPTURE_2_SOURCE=credentials_file
CAPTURE_3_SOURCE=custom_process

ARN_1=valid
ARN_2=invalid
ARN_3=valid
ARN_4=invalid
ARN_5=invalid
`;

const SOLVED_DEPLOY = SEEDED_DEPLOY.replace('[profile reconciliation]', '[reconciliation]');

/** The strings a failing check must never hand back to the student. */
const ANSWER_STRINGS = [
  'CAPTURE_1_SOURCE=environment_variables',
  'CAPTURE_2_SOURCE=credentials_file',
  'CAPTURE_3_SOURCE=custom_process',
  'ARN_1=valid',
  'ARN_2=invalid',
  'ARN_3=valid',
  'ARN_4=invalid',
  'ARN_5=invalid',
];

class FakeSandbox implements SandboxPort {
  readonly reads: string[] = [];
  constructor(private readonly entries: Record<string, Partial<SandboxPathRead>> = {}) {}

  async read(relativePath: string): Promise<SandboxPathRead | null> {
    this.reads.push(relativePath);
    const entry = this.entries[relativePath];
    if (!entry) return null;
    const content = entry.content ?? '';
    return {
      type: entry.type ?? 'file',
      mode: entry.mode ?? '644',
      owner: entry.owner ?? 'student',
      group: entry.group ?? 'student',
      sizeBytes: entry.sizeBytes ?? content.length,
      ...(entry.type === 'directory' ? {} : { content }),
    };
  }
}

function sandboxWith(findings: string | null, deploy: string | null): FakeSandbox {
  const entries: Record<string, Partial<SandboxPathRead>> = {};
  if (findings !== null) entries[FINDINGS] = { type: 'file', content: findings };
  if (deploy !== null) entries[DEPLOY] = { type: 'file', content: deploy };
  return new FakeSandbox(entries);
}

async function run(findings: string | null, deploy: string | null) {
  const lab = await loadLabDefinition(AWS_001);
  const sandbox = sandboxWith(findings, deploy);
  const result = await verifyLab({ lab, sandbox, namespace: 'jtt-lab-000000000001' });
  return { result, sandbox };
}

const failedLabels = (checks: Array<{ status: string; label: string }>) =>
  checks.filter((c) => c.status === 'fail').map((c) => c.label);

// --------------------------------------------------------- 1. initial state

describe('AWS-001 — the seeded environment does not pass', () => {
  it('fails on the untouched bundle, and fails every graded check', async () => {
    const { result } = await run(SEEDED_FINDINGS, SEEDED_DEPLOY);

    expect(result.passed).toBe(false);
    expect(result.summary).toBe('LAB NOT COMPLETE');
    // Only the two intact-key checks can pass on the seeded file, because the
    // seed deliberately ships both access key ids already present.
    const passed = result.checks.filter((c) => c.status === 'pass').map((c) => c.label);
    expect(passed).toEqual([
      'The reconciliation profile still carries its own access key id',
      'The default profile was left intact',
    ]);
  });

  it('does not reveal any answer in the failure detail', async () => {
    const { result } = await run(SEEDED_FINDINGS, SEEDED_DEPLOY);

    const allDetail = result.checks.map((c) => `${c.label} ${c.detail ?? ''}`).join('\n');
    for (const answer of ANSWER_STRINGS) {
      expect(allDetail).not.toContain(answer);
    }
    expect(allDetail).not.toContain('[reconciliation]');
  });
});

// ------------------------------------------------------- 2. correct solution

describe('AWS-001 — the correct solution passes', () => {
  it('passes when the findings are right and the header is repaired', async () => {
    const { result } = await run(SOLVED_FINDINGS, SOLVED_DEPLOY);

    expect(failedLabels(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.summary).toBe('LAB PASSED');
  });

  it('accepts a differently formatted sheet that still states the same answers', async () => {
    // Same conclusions, different comments, different blank lines, different
    // key order — two correct solutions must both pass.
    const reordered = [
      'ARN_5=invalid',
      'ARN_4=invalid',
      'ARN_3=valid',
      'ARN_2=invalid',
      'ARN_1=valid',
      '# my working notes below',
      'CAPTURE_3_SOURCE=custom_process',
      'CAPTURE_2_SOURCE=credentials_file',
      'CAPTURE_1_SOURCE=environment_variables',
    ].join('\n');

    const { result } = await run(reordered, SOLVED_DEPLOY);

    expect(result.passed).toBe(true);
  });

  it('reads only the two paths the lab declares', async () => {
    const { sandbox } = await run(SOLVED_FINDINGS, SOLVED_DEPLOY);

    expect([...new Set(sandbox.reads)].sort()).toEqual([DEPLOY, FINDINGS]);
  });
});

// --------------------------------------------- 3. plausible incorrect answers

describe('AWS-001 — plausible wrong answers fail', () => {
  it('fails when capture 2 is answered with the config file rather than the credentials file', async () => {
    const wrong = SOLVED_FINDINGS.replace(
      'CAPTURE_2_SOURCE=credentials_file',
      'CAPTURE_2_SOURCE=configuration_file',
    );
    const { result } = await run(wrong, SOLVED_DEPLOY);

    expect(result.passed).toBe(false);
    expect(failedLabels(result.checks)).toContain(
      'Capture 2 — the winning credential source is identified correctly',
    );
  });

  it('fails when capture 3 is answered with the config file rather than the custom process', async () => {
    const wrong = SOLVED_FINDINGS.replace(
      'CAPTURE_3_SOURCE=custom_process',
      'CAPTURE_3_SOURCE=configuration_file',
    );
    const { result } = await run(wrong, SOLVED_DEPLOY);

    expect(result.passed).toBe(false);
    expect(failedLabels(result.checks)).toContain(
      'Capture 3 — the winning credential source is identified correctly',
    );
  });

  it('fails when capture 1 is answered with the credentials file rather than the environment', async () => {
    const wrong = SOLVED_FINDINGS.replace(
      'CAPTURE_1_SOURCE=environment_variables',
      'CAPTURE_1_SOURCE=credentials_file',
    );
    const { result } = await run(wrong, SOLVED_DEPLOY);

    expect(result.passed).toBe(false);
  });

  it('fails when an ARN that legitimately omits its Region is called malformed', async () => {
    // ARN_1 is an IAM user ARN; IAM ARNs omit the Region and that is correct.
    const wrong = SOLVED_FINDINGS.replace('ARN_1=valid', 'ARN_1=invalid');
    const { result } = await run(wrong, SOLVED_DEPLOY);

    expect(result.passed).toBe(false);
    expect(failedLabels(result.checks)).toContain('ARN 1 is judged correctly');
  });

  it('fails when the S3 bucket ARN that omits Region and account is called malformed', async () => {
    const wrong = SOLVED_FINDINGS.replace('ARN_3=valid', 'ARN_3=invalid');
    const { result } = await run(wrong, SOLVED_DEPLOY);

    expect(result.passed).toBe(false);
    expect(failedLabels(result.checks)).toContain('ARN 3 is judged correctly');
  });

  it('fails when the bad partition is waved through as valid', async () => {
    const wrong = SOLVED_FINDINGS.replace('ARN_2=invalid', 'ARN_2=valid');
    const { result } = await run(wrong, SOLVED_DEPLOY);

    expect(result.passed).toBe(false);
  });

  it('fails when the credentials file is left with its config-file header', async () => {
    const { result } = await run(SOLVED_FINDINGS, SEEDED_DEPLOY);

    expect(result.passed).toBe(false);
    expect(failedLabels(result.checks)).toEqual([
      'The reconciliation profile uses a credentials-file section header',
      'No section header in the credentials file uses the word profile',
    ]);
  });
});

// -------------------------------------------------- 4. shortcuts and bypasses

describe('AWS-001 — shortcuts do not pass', () => {
  it('fails when the findings sheet is deleted rather than filled in', async () => {
    const { result } = await run(null, SOLVED_DEPLOY);

    expect(result.passed).toBe(false);
    // A missing file must fail, never silently satisfy the "no FILL_ME" check.
    expect(failedLabels(result.checks)).toContain('Every finding has been filled in');
  });

  it('fails when the sheet is emptied instead of answered', async () => {
    const { result } = await run('', SOLVED_DEPLOY);

    expect(result.passed).toBe(false);
  });

  it('fails when one placeholder is left behind among correct answers', async () => {
    const partial = SOLVED_FINDINGS.replace('ARN_5=invalid', 'ARN_5=FILL_ME');
    const { result } = await run(partial, SOLVED_DEPLOY);

    expect(result.passed).toBe(false);
    expect(failedLabels(result.checks)).toContain('Every finding has been filled in');
  });

  it('fails when the documented KEY=value format is not followed', async () => {
    const spaced = SOLVED_FINDINGS.replace(
      'CAPTURE_1_SOURCE=environment_variables',
      'CAPTURE_1_SOURCE = environment_variables',
    );
    const { result } = await run(spaced, SOLVED_DEPLOY);

    expect(result.passed).toBe(false);
  });

  it('fails when the broken profile is deleted instead of repaired', async () => {
    const deleted = SEEDED_DEPLOY.split('[profile reconciliation]')[0] ?? '';
    const { result } = await run(SOLVED_FINDINGS, deleted);

    expect(result.passed).toBe(false);
    expect(failedLabels(result.checks)).toContain(
      'The reconciliation profile still carries its own access key id',
    );
  });

  it('fails when a correct header is added but the wrong one is left in place', async () => {
    const both = `${SOLVED_DEPLOY}\n[profile reconciliation]\naws_access_key_id = AKIAI88QH8DHFEXAMPLE\n`;
    const { result } = await run(SOLVED_FINDINGS, both);

    expect(result.passed).toBe(false);
    expect(failedLabels(result.checks)).toContain(
      'No section header in the credentials file uses the word profile',
    );
  });

  it('fails when the default profile is dropped while repairing the other one', async () => {
    const onlyOne = '[reconciliation]\naws_access_key_id = AKIAI88QH8DHFEXAMPLE\n';
    const { result } = await run(SOLVED_FINDINGS, onlyOne);

    expect(result.passed).toBe(false);
    expect(failedLabels(result.checks)).toContain('The default profile was left intact');
  });
});
