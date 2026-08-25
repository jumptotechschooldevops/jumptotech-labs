/**
 * AWS-004 — verification behaviour.
 *
 * The lab is about *who* may assume a role, so these tests are about the
 * `Principal` element: which principals a trust policy actually names, that a
 * wildcard is not a substitute for a named one, and that editing the wrong
 * file does not help.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type SandboxPathRead } from '@jumptotech/lab-orchestrator';
import { verifyLab, type SandboxPort } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const AWS_004 = path.join(LABS_DIR, 'aws', 'aws-004-roles-and-trust', 'lab.yaml');

const DIR = '/home/student/role-setup';
const TRUST = `${DIR}/trust-policy.json`;
const PERMS = `${DIR}/permissions-policy.json`;
const BUCKET = 'arn:aws:s3:::jumptotech-reconciliation';

const TRUST_SEEDED = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    { Sid: 'TrustAnyone', Effect: 'Allow', Principal: '*', Action: 'sts:AssumeRole' },
    { Sid: 'ContractorAccess', Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::210987654321:role/contractor-build' }, Action: 'sts:AssumeRole' },
  ],
}, null, 2);

const TRUST_SOLVED = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    { Sid: 'AllowEc2ToAssume', Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' },
  ],
});

const PERMS_SEEDED = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    { Sid: 'ReadReconciliationInputs', Effect: 'Allow', Action: ['s3:GetObject', 's3:ListBucket'], Resource: [BUCKET, `${BUCKET}/*`] },
  ],
}, null, 2);

class FakeSandbox implements SandboxPort {
  constructor(private readonly entries: Record<string, string>) {}
  async read(p: string): Promise<SandboxPathRead | null> {
    const content = this.entries[p];
    if (content === undefined) return null;
    return { type: 'file', mode: '644', owner: 'student', group: 'student', sizeBytes: content.length, content };
  }
}

async function run(trust: string, perms: string = PERMS_SEEDED) {
  const lab = await loadLabDefinition(AWS_004);
  return verifyLab({ lab, sandbox: new FakeSandbox({ [TRUST]: trust, [PERMS]: perms }), namespace: 'jtt-lab-000000000004' });
}
const failed = (c: Array<{ status: string; label: string }>) => c.filter((x) => x.status === 'fail').map((x) => x.label);

describe('AWS-004 — the seeded trust policy is the finding', () => {
  it('fails exactly the three trust-policy checks', async () => {
    const result = await run(TRUST_SEEDED);

    expect(result.passed).toBe(false);
    expect(failed(result.checks).sort()).toEqual([
      'No statement trusts every principal',
      'The EC2 service is allowed to assume the role',
      'The trust policy is a valid document with exactly one statement',
    ]);
  });

  it('leaves the approved permissions policy passing throughout', async () => {
    const passed = (await run(TRUST_SEEDED)).checks.filter((c) => c.status === 'pass').map((c) => c.label);

    expect(passed).toContain('The role can still read its reconciliation inputs');
    expect(passed).toContain('The role still cannot delete reconciliation inputs');
  });

  it('does not name the answer in any failure detail', async () => {
    const blob = (await run(TRUST_SEEDED)).checks.map((c) => `${c.label} ${c.detail ?? ''}`).join('\n');

    expect(blob).not.toContain('ec2.amazonaws.com');
    expect(blob).not.toContain('"Service"');
  });
});

describe('AWS-004 — a correct trust policy passes however it is written', () => {
  it('passes the intended answer', async () => {
    const result = await run(TRUST_SOLVED);
    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes with Action and Service written as one-element arrays', async () => {
    const arrays = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { Service: ['ec2.amazonaws.com'] }, Action: ['sts:AssumeRole'] }],
    });
    expect((await run(arrays)).passed).toBe(true);
  });

  it('passes with reordered keys, no Sid, and heavy indentation', async () => {
    const reordered = JSON.stringify({
      Statement: [{ Action: 'sts:AssumeRole', Principal: { Service: 'ec2.amazonaws.com' }, Effect: 'Allow' }],
      Version: '2012-10-17',
    }, null, 8);
    expect((await run(reordered)).passed).toBe(true);
  });

  it('passes when the statement is written as an object rather than an array', async () => {
    const single = JSON.stringify({
      Version: '2012-10-17',
      Statement: { Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' },
    });
    expect((await run(single)).passed).toBe(true);
  });
});

describe('AWS-004 — trust policies that look right but are not', () => {
  it('fails when the wildcard principal is kept alongside a correct statement', async () => {
    const both = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' },
        { Effect: 'Allow', Principal: '*', Action: 'sts:AssumeRole' },
      ],
    });
    const result = await run(both);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('No statement trusts every principal');
    expect(failed(result.checks)).toContain('The trust policy is a valid document with exactly one statement');
  });

  it('fails when the contractor trust is left in place', async () => {
    const stale = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' },
        { Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::210987654321:role/contractor-build' }, Action: 'sts:AssumeRole' },
      ],
    });
    expect((await run(stale)).passed).toBe(false);
  });

  it('fails when the service principal is written as an account or an ARN', async () => {
    for (const wrong of [
      { AWS: 'ec2.amazonaws.com' },
      { AWS: 'arn:aws:iam::123456789012:role/ec2' },
      { Service: 'ec2' },
      { Service: 'EC2.amazonaws.com' },
      { Service: 'ec2.aws.amazon.com' },
    ]) {
      const policy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: wrong, Action: 'sts:AssumeRole' }],
      });
      const result = await run(policy);
      expect(result.passed, JSON.stringify(wrong)).toBe(false);
      expect(failed(result.checks)).toContain('The EC2 service is allowed to assume the role');
    }
  });

  it('fails when the wrong assume-role action is used', async () => {
    for (const action of ['sts:AssumeRoleWithWebIdentity', 'sts:AssumeRoleWithSAML', 'sts:GetCallerIdentity']) {
      const policy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: action }],
      });
      expect((await run(policy)).passed, action).toBe(false);
    }
  });

  it('accepts sts:Assume* as covering the action, but still rejects a bare wildcard', async () => {
    const scoped = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:Assume*' }],
    });
    expect((await run(scoped)).passed).toBe(true);

    const bare = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: '*' }],
    });
    const result = await run(bare);
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('No statement in the trust policy uses "*" as its Action');
  });

  it('fails when the statement denies rather than allows', async () => {
    const denied = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Deny', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
    });
    expect((await run(denied)).passed).toBe(false);
  });

  it('fails on NotPrincipal with Allow, which AWS does not support', async () => {
    const notPrincipal = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', NotPrincipal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
    });
    const result = await run(notPrincipal);

    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.status === 'fail')?.detail).toContain('NotPrincipal with Effect Allow');
  });

  it('fails on malformed JSON without crashing', async () => {
    const result = await run('{"Version":"2012-10-17","Statement":[');
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.status === 'fail')?.detail).toContain('not valid JSON');
  });
});

describe('AWS-004 — the permissions policy must survive', () => {
  it('fails when the student widens the permissions policy instead', async () => {
    const widened = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }],
    });
    const result = await run(TRUST_SOLVED, widened);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The permissions policy still uses no "*" Resource');
    expect(failed(result.checks)).toContain('The role still cannot delete reconciliation inputs');
  });

  it('fails when the permissions policy is emptied or broken', async () => {
    expect((await run(TRUST_SOLVED, '{"Version":"2012-10-17","Statement":[]}')).passed).toBe(false);
    expect((await run(TRUST_SOLVED, 'not json')).passed).toBe(false);
  });

  it('fails when the trust policy is written into the permissions file', async () => {
    expect((await run(TRUST_SEEDED, TRUST_SOLVED)).passed).toBe(false);
  });
});

describe('AWS-004 — isolation and shortcuts', () => {
  it('is not passed by a solved copy in another file', async () => {
    const lab = await loadLabDefinition(AWS_004);
    const sandbox = new FakeSandbox({
      [TRUST]: TRUST_SEEDED,
      [`${DIR}/trust-policy.json.fixed`]: TRUST_SOLVED,
      [PERMS]: PERMS_SEEDED,
    });
    expect((await verifyLab({ lab, sandbox, namespace: 'jtt-lab-x' })).passed).toBe(false);
  });

  it('is not passed by another session having solved it', async () => {
    const lab = await loadLabDefinition(AWS_004);
    const a = new FakeSandbox({ [TRUST]: TRUST_SOLVED, [PERMS]: PERMS_SEEDED });
    const b = new FakeSandbox({ [TRUST]: TRUST_SEEDED, [PERMS]: PERMS_SEEDED });

    expect((await verifyLab({ lab, sandbox: a, namespace: 'jtt-lab-a' })).passed).toBe(true);
    expect((await verifyLab({ lab, sandbox: b, namespace: 'jtt-lab-b' })).passed).toBe(false);
  });

  it('refuses a symlink standing in for the trust policy', async () => {
    const lab = await loadLabDefinition(AWS_004);
    const sandbox: SandboxPort = {
      async read(p: string): Promise<SandboxPathRead | null> {
        if (p === TRUST) return { type: 'symlink', mode: '777', owner: 'student', group: 'student', sizeBytes: 0 };
        if (p === PERMS) return { type: 'file', mode: '644', owner: 'student', group: 'student', sizeBytes: PERMS_SEEDED.length, content: PERMS_SEEDED };
        return null;
      },
    };
    const result = await verifyLab({ lab, sandbox, namespace: 'jtt-lab-x' });

    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.status === 'fail')?.detail).toContain('not a regular file');
  });
});
