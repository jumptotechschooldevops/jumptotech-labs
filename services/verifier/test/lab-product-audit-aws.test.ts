/**
 * AWS labs: grading defects found by the 2026-09-21 lab product audit, pinned
 * so they stay closed. The real catalog lab, graded by the real `verifyLab`.
 *
 * Most share one cause. An IAM check asked with no request context ignores
 * every Condition, so a conditional Deny reads as always firing: the
 * AWS-recommended "deny plain-HTTP requests" statement made a correct policy
 * look as if it denied everything (false negative), and a Deny that never
 * fires over TLS made an allowed delete look refused (false positive). The
 * "may" checks now ask about an ordinary TLS request, and the "must never"
 * checks ask about every request at once (`any_context`).
 */
import { describe, expect, it } from 'vitest';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';
import { verifyLab } from '../src/index.js';
import { FakeSandbox } from './sandbox-fake.js';

async function failing(labId: string, files: Record<string, string>): Promise<string[]> {
  const lab = (await realCatalog()).get(labId);
  const world = { files: Object.fromEntries(Object.entries(files).map(([p, content]) => [p, { content }])) };
  const result = await verifyLab({ lab, namespace: 'jtt-lab-000000000001', sandbox: new FakeSandbox(world) });
  expect(result.error).toBeUndefined();
  return result.checks.filter((c) => c.status !== 'pass').map((c) => c.label);
}

const doc = (...Statement: unknown[]) => JSON.stringify({ Version: '2012-10-17', Statement });
const DENY_INSECURE = (resource: string | string[]) => ({
  Sid: 'DenyInsecureTransport',
  Effect: 'Deny',
  Action: 's3:*',
  Resource: resource,
  Condition: { Bool: { 'aws:SecureTransport': 'false' } },
});

// ------------------------------------------------------------------ AWS-002
const P2 = '/home/student/aws-iam/policy.json';
const B2 = 'arn:aws:s3:::jumptotech-ledger-exports';
const O2 = `${B2}/*`;
const SOLVED_2 = [
  { Effect: 'Allow', Action: 's3:ListBucket', Resource: B2 },
  { Effect: 'Allow', Action: 's3:GetObject', Resource: O2 },
  {
    Effect: 'Allow',
    Action: 's3:PutObject',
    Resource: O2,
    Condition: { StringEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } },
  },
];

describe('AWS-002 — a scoped policy is graded by what a real request can do', () => {
  it('baseline: the reference solution passes', async () => {
    expect(await failing('AWS-002', { [P2]: doc(...SOLVED_2), '/home/student/aws-iam/ticket-5120.txt': 't' })).toEqual([]);
  });

  it('passes a correct policy that also denies plain-HTTP requests', async () => {
    // Before: failed "may list" and "may read".
    const f = await failing('AWS-002', {
      [P2]: doc(...SOLVED_2, DENY_INSECURE([B2, O2])),
      '/home/student/aws-iam/ticket-5120.txt': 't',
    });
    expect(f).toEqual([]);
  });

  it('fails an Allow of DeleteObject beside a Deny that never fires over TLS', async () => {
    // Before: passed the whole lab, although an ordinary delete is allowed.
    const f = await failing('AWS-002', {
      [P2]: doc(
        SOLVED_2[0],
        { Effect: 'Allow', Action: ['s3:GetObject', 's3:DeleteObject'], Resource: O2 },
        SOLVED_2[2],
        { Effect: 'Deny', Action: 's3:DeleteObject', Resource: O2, Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
      ),
      '/home/student/aws-iam/ticket-5120.txt': 't',
    });
    expect(f).toEqual(['The job may not delete objects']);
  });
});

// ------------------------------------------------------------------ AWS-003
const P3 = '/home/student/access-review/policy.json';
const B3 = 'arn:aws:s3:::jumptotech-build-artifacts';
const SOLVED_3 = [
  { Effect: 'Allow', Action: 's3:ListBucket', Resource: B3 },
  { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: `${B3}/builds/*` },
  {
    Effect: 'Deny',
    Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
    Resource: `${B3}/customer-exports/*`,
  },
];
const INC3 = { '/home/student/access-review/incident-6042.txt': 'i' };

describe('AWS-003 — the explicit Deny repair, graded by what a real request can do', () => {
  it('baseline: the reference solution passes', async () => {
    expect(await failing('AWS-003', { [P3]: doc(...SOLVED_3), ...INC3 })).toEqual([]);
  });

  it('passes a correct policy that also denies plain-HTTP requests', async () => {
    // Before: failed all three "may" checks.
    const f = await failing('AWS-003', { [P3]: doc(...SOLVED_3, DENY_INSECURE([B3, `${B3}/*`])), ...INC3 });
    expect(f).toEqual([]);
  });

  it('fails build-artifact deletion "denied" only by a Deny that never fires over TLS', async () => {
    // Before: passed, although incident line 5 says deletion must stay impossible.
    const f = await failing('AWS-003', {
      [P3]: doc(
        SOLVED_3[0],
        { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: `${B3}/builds/*` },
        SOLVED_3[2],
        {
          Effect: 'Deny',
          Action: 's3:DeleteObject',
          Resource: `${B3}/builds/*`,
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        },
      ),
      ...INC3,
    });
    expect(f).toEqual(['Build artifacts cannot be deleted either']);
  });
});

// ------------------------------------------------------------------ AWS-005
const P5 = '/home/student/escalation-review/deployer-policy.json';
const PASS_APP = {
  Effect: 'Allow',
  Action: 'iam:PassRole',
  Resource: 'arn:aws:iam::123456789012:role/App*',
  Condition: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
};
const INV5 = { '/home/student/escalation-review/roles-in-account.txt': 'r' };

describe('AWS-005 — the EC2 statement stays as it was', () => {
  it('baseline: the reference solution passes', async () => {
    expect(
      await failing('AWS-005', {
        [P5]: doc(
          { Effect: 'Allow', Action: ['ec2:RunInstances', 'ec2:DescribeInstances', 'ec2:CreateTags'], Resource: '*' },
          PASS_APP,
        ),
        ...INV5,
      }),
    ).toEqual([]);
  });

  it('fails the EC2 statement widened to every non-IAM action', async () => {
    // Before: `NotAction: iam:*` on "*" passed every check.
    const f = await failing('AWS-005', {
      [P5]: doc({ Effect: 'Allow', NotAction: 'iam:*', Resource: '*' }, PASS_APP),
      ...INV5,
    });
    expect(f).toEqual(['The EC2 statement grants no more than it did', 'The pipeline gained no access outside EC2 and PassRole']);
  });
});

// ------------------------------------------------------------------ AWS-001
const FINDINGS_1 = [
  'CAPTURE_1_SOURCE=environment_variables',
  'CAPTURE_2_SOURCE=credentials_file',
  'CAPTURE_3_SOURCE=custom_process',
  'ARN_1=valid',
  'ARN_2=invalid',
  'ARN_3=valid',
  'ARN_4=invalid',
  'ARN_5=invalid',
  '',
].join('\n');
const base1 = (credentials: string) => ({
  '/home/student/aws-incident/findings.env': FINDINGS_1,
  '/home/student/aws-incident/change-ticket-4471.txt': 't',
  '/home/student/aws-incident/deploy/credentials': credentials,
});

describe('AWS-001 — the credentials-file repair renames the header over its own keys', () => {
  it('baseline: the honest repair passes', async () => {
    expect(
      await failing(
        'AWS-001',
        base1(
          '[default]\naws_access_key_id = AKIAI99QH8DHGEXAMPLE\naws_secret_access_key = x\n\n[reconciliation]\naws_access_key_id = AKIAI88QH8DHFEXAMPLE\naws_secret_access_key = y\n',
        ),
      ),
    ).toEqual([]);
  });

  it('fails a deleted header with "[reconciliation]" only in a comment — the profile still does not exist', async () => {
    expect(
      await failing(
        'AWS-001',
        base1(
          '# renamed to [reconciliation]\n[default]\naws_access_key_id = AKIAI99QH8DHGEXAMPLE\naws_secret_access_key = x\n\naws_access_key_id = AKIAI88QH8DHFEXAMPLE\naws_secret_access_key = y\n',
        ),
      ),
    ).toEqual(['The reconciliation profile uses a credentials-file section header']);
  });

  it('fails the two profiles\' keys swapped ("without changing either profile\'s keys")', async () => {
    expect(
      await failing(
        'AWS-001',
        base1(
          '[default]\naws_access_key_id = AKIAI88QH8DHFEXAMPLE\naws_secret_access_key = y\n\n[reconciliation]\naws_access_key_id = AKIAI99QH8DHGEXAMPLE\naws_secret_access_key = x\n',
        ),
      ),
    ).toEqual(['The reconciliation profile uses a credentials-file section header']);
  });
});
