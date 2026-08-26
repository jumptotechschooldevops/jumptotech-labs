/**
 * AWS-002 — verification behaviour.
 *
 * The property this file exists to prove: **the policy is graded on meaning.**
 * Every "same answer, written differently" case must pass, and every
 * "superficially similar, semantically wrong" case must fail. Requirements come
 * from the real lab definition, so these are the checks students will meet.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type SandboxPathRead } from '@jumptotech/lab-orchestrator';
import { verifyLab, type SandboxPort } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const AWS_002 = path.join(LABS_DIR, 'aws', 'aws-002-least-privilege-policy', 'lab.yaml');

const POLICY = '/home/student/aws-iam/policy.json';
const TICKET = '/home/student/aws-iam/ticket-5120.txt';
const BUCKET = 'arn:aws:s3:::jumptotech-ledger-exports';
const OBJECTS = 'arn:aws:s3:::jumptotech-ledger-exports/*';

/** Exactly what `setup/seed.sh` ships. */
const STARTER = JSON.stringify(
  { Version: '2012-10-17', Statement: [{ Sid: 'ShippedInAHurry', Effect: 'Allow', Action: '*', Resource: '*' }] },
  null,
  2,
);

/** One correct answer. Deliberately not the only one — see below. */
const SOLVED = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    { Sid: 'List', Effect: 'Allow', Action: 's3:ListBucket', Resource: BUCKET },
    { Sid: 'Read', Effect: 'Allow', Action: 's3:GetObject', Resource: OBJECTS },
    {
      Sid: 'UploadEncrypted',
      Effect: 'Allow',
      Action: 's3:PutObject',
      Resource: OBJECTS,
      Condition: { StringEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } },
    },
  ],
});

class FakeSandbox implements SandboxPort {
  constructor(private readonly entries: Record<string, string>) {}
  async read(relativePath: string): Promise<SandboxPathRead | null> {
    const content = this.entries[relativePath];
    if (content === undefined) return null;
    return { type: 'file', mode: '644', owner: 'student', group: 'student', sizeBytes: content.length, content };
  }
}

async function run(policy: string) {
  const lab = await loadLabDefinition(AWS_002);
  const sandbox = new FakeSandbox({ [POLICY]: policy, [TICKET]: 'ticket' });
  return verifyLab({ lab, sandbox, namespace: 'jtt-lab-000000000002' });
}

const failed = (checks: Array<{ status: string; label: string }>) =>
  checks.filter((c) => c.status === 'fail').map((c) => c.label);

describe('AWS-002 — the seeded policy does not pass', () => {
  it('fails the over-permissive starter on exactly the least-privilege checks', async () => {
    const result = await run(STARTER);

    expect(result.passed).toBe(false);
    expect(failed(result.checks).sort()).toEqual(
      [
        'No Allow statement uses "*" as its Action',
        'No Allow statement uses "*" as its Resource',
        'The job cannot reach the payroll bucket',
        'The job may not delete objects',
        'The upload permission is conditional on KMS server-side encryption',
      ].sort(),
    );
  });
});

describe('AWS-002 — a correct policy passes however it is written', () => {
  it('passes the intended answer', async () => {
    const result = await run(SOLVED);
    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes the same policy with reordered statements and keys', async () => {
    const parsed = JSON.parse(SOLVED) as { Statement: unknown[] };
    const reordered = JSON.stringify({
      Statement: [...parsed.Statement].reverse(),
      Version: '2012-10-17',
    });

    expect((await run(reordered)).passed).toBe(true);
  });

  it('passes when Action and Resource are written as arrays instead of strings', async () => {
    const arrays = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: [BUCKET] },
        { Effect: 'Allow', Action: ['s3:GetObject'], Resource: [OBJECTS] },
        {
          Effect: 'Allow',
          Action: ['s3:PutObject'],
          Resource: [OBJECTS],
          Condition: { StringEquals: { 's3:x-amz-server-side-encryption': ['aws:kms'] } },
        },
      ],
    });

    expect((await run(arrays)).passed).toBe(true);
  });

  it('passes a different but equally correct shape: read and list in one statement', async () => {
    const merged = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['s3:ListBucket', 's3:GetObject'], Resource: [BUCKET, OBJECTS] },
        {
          Effect: 'Allow',
          Action: 's3:PutObject',
          Resource: OBJECTS,
          Condition: { StringEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } },
        },
      ],
    });

    expect((await run(merged)).passed).toBe(true);
  });

  it('passes when a scoped wildcard is used instead of an exact action', async () => {
    // `s3:Get*` is a wildcard pattern, but not the bare `*` the review forbids.
    const scoped = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: 's3:ListBucket', Resource: BUCKET },
        { Effect: 'Allow', Action: 's3:Get*', Resource: OBJECTS },
        {
          Effect: 'Allow',
          Action: 's3:PutObject',
          Resource: OBJECTS,
          Condition: { StringEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } },
        },
      ],
    });

    expect((await run(scoped)).passed).toBe(true);
  });
});

describe('AWS-002 — policies that look right but mean something else fail', () => {
  it('fails when the encryption condition is missing', async () => {
    const noCondition = SOLVED.replace(
      /,"Condition":\{[^}]*\}\}/,
      '}',
    );
    const result = await run(noCondition);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain(
      'The upload permission is conditional on KMS server-side encryption',
    );
  });

  it('fails when the condition names the wrong value', async () => {
    const wrongValue = SOLVED.replace('aws:kms', 'AES256');
    const result = await run(wrongValue);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain(
      'The upload permission is conditional on KMS server-side encryption',
    );
  });

  it('fails when s3:* quietly grants deletion', async () => {
    const tooWide = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: 's3:*', Resource: [BUCKET, OBJECTS] },
        {
          Effect: 'Allow',
          Action: 's3:PutObject',
          Resource: OBJECTS,
          Condition: { StringEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } },
        },
      ],
    });
    const result = await run(tooWide);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The job may not delete objects');
  });

  it('fails when the object ARN is used where the bucket ARN is required', async () => {
    const wrongArn = SOLVED.replace(`"Resource":"${BUCKET}"`, `"Resource":"${OBJECTS}"`);
    const result = await run(wrongArn);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The job may list the ledger exports bucket');
  });

  it('fails when another bucket is left reachable', async () => {
    const leaky = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        ...(JSON.parse(SOLVED) as { Statement: unknown[] }).Statement,
        { Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::jumptotech-*/*' },
      ],
    });
    const result = await run(leaky);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The job cannot reach the payroll bucket');
  });

  it('fails, without crashing, when the document is not valid JSON', async () => {
    const result = await run('{ "Version": "2012-10-17", "Statement": [ ');

    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.status === 'fail')?.detail).toContain('not valid JSON');
  });

  it('fails when the wrong Version is declared', async () => {
    const result = await run(SOLVED.replace('2012-10-17', '2008-10-17'));

    expect(failed(result.checks)).toContain(
      'The policy is a valid document declaring the 2012-10-17 version',
    );
  });

  it('does not pass a policy that merely mentions the right words in a Deny', async () => {
    // Every required string is present, but the statement denies rather than
    // allows — a substring grader would pass this.
    const inverted = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Deny', Action: ['s3:ListBucket', 's3:GetObject', 's3:PutObject'], Resource: [BUCKET, OBJECTS] },
      ],
    });
    const result = await run(inverted);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The job may read objects from the bucket');
  });
});

describe('AWS-002 — adversarial attempts', () => {
  it('fails a NotAction trick that quietly grants everything else', async () => {
    // "Everything except delete" satisfies the delete rule but leaves the
    // payroll bucket reachable — the policy is broader than the ticket asks.
    const notAction = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', NotAction: 's3:DeleteObject', Resource: '*' },
        {
          Effect: 'Allow',
          Action: 's3:PutObject',
          Resource: OBJECTS,
          Condition: { StringEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } },
        },
      ],
    });
    const result = await run(notAction);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The job cannot reach the payroll bucket');
    expect(failed(result.checks)).toContain('No Allow statement uses "*" as its Resource');
  });

  it('fails a NotResource trick that reaches every other bucket', async () => {
    const notResource = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        ...(JSON.parse(SOLVED) as { Statement: unknown[] }).Statement,
        { Effect: 'Allow', Action: 's3:GetObject', NotResource: 'arn:aws:s3:::somewhere-else/*' },
      ],
    });
    const result = await run(notResource);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The job cannot reach the payroll bucket');
  });

  it('fails when a later duplicate statement contradicts an earlier correct one', async () => {
    const duplicated = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        ...(JSON.parse(SOLVED) as { Statement: unknown[] }).Statement,
        { Sid: 'Oops', Effect: 'Allow', Action: 's3:DeleteObject', Resource: OBJECTS },
      ],
    });
    const result = await run(duplicated);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The job may not delete objects']);
  });

  it('fails when the condition uses the wrong context key', async () => {
    const wrongKey = SOLVED.replace('s3:x-amz-server-side-encryption', 's3:x-amz-acl');
    const result = await run(wrongKey);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain(
      'The upload permission is conditional on KMS server-side encryption',
    );
  });

  it('fails when the required statement is a Deny rather than an Allow', async () => {
    const inverted = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: 's3:ListBucket', Resource: BUCKET },
        { Effect: 'Allow', Action: 's3:GetObject', Resource: OBJECTS },
        {
          Effect: 'Deny',
          Action: 's3:PutObject',
          Resource: OBJECTS,
          Condition: { StringEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } },
        },
      ],
    });
    const result = await run(inverted);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The job may upload objects to the bucket');
  });

  it('fails when the right policy is written to the wrong file', async () => {
    const lab = await loadLabDefinition(AWS_002);
    const sandbox = new FakeSandbox({
      '/home/student/aws-iam/policy.json.new': SOLVED,
      [TICKET]: 'ticket',
    });
    const result = await verifyLab({ lab, sandbox, namespace: 'jtt-lab-000000000002' });

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toHaveLength(9);
  });

  it('refuses a symlink standing in for the policy file', async () => {
    const lab = await loadLabDefinition(AWS_002);
    const sandbox: SandboxPort = {
      async read(relativePath: string): Promise<SandboxPathRead | null> {
        if (relativePath !== POLICY) return null;
        return { type: 'symlink', mode: '777', owner: 'student', group: 'student', sizeBytes: 0 };
      },
    };
    const result = await verifyLab({ lab, sandbox, namespace: 'jtt-lab-000000000002' });

    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.status === 'fail')?.detail).toContain('not a regular file');
  });

  it('cannot be passed by another session having solved it', async () => {
    // Two sandboxes. The reader is constructed per session and can only reach
    // the one it was given, so a neighbour's correct policy is invisible.
    const lab = await loadLabDefinition(AWS_002);
    const neighbour = new FakeSandbox({ [POLICY]: SOLVED, [TICKET]: 'ticket' });
    const mine = new FakeSandbox({ [POLICY]: STARTER, [TICKET]: 'ticket' });

    expect((await verifyLab({ lab, sandbox: neighbour, namespace: 'jtt-lab-neighbour' })).passed).toBe(true);
    expect((await verifyLab({ lab, sandbox: mine, namespace: 'jtt-lab-mine' })).passed).toBe(false);
  });
});
