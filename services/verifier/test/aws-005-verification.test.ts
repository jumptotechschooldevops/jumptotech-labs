/**
 * AWS-005 — verification behaviour.
 *
 * The lab is about a privilege-escalation path that no statement names, so the
 * grading is entirely about *effective* permissions: which roles the policy
 * would let the pipeline hand to a service, and whether the restriction to one
 * service is stated. A student who removes the permission fails as surely as
 * one who leaves it open, because two checks require deployment to keep working.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type SandboxPathRead } from '@jumptotech/lab-orchestrator';
import { verifyLab, type SandboxPort } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const AWS_005 = path.join(LABS_DIR, 'aws', 'aws-005-passrole-escalation', 'lab.yaml');

const DIR = '/home/student/escalation-review';
const POLICY = `${DIR}/deployer-policy.json`;
const ROLE = (name: string) => `arn:aws:iam::123456789012:role/${name}`;

const EC2_STATEMENT = {
  Sid: 'LaunchInstances',
  Effect: 'Allow',
  Action: ['ec2:RunInstances', 'ec2:DescribeInstances', 'ec2:CreateTags'],
  Resource: '*',
};

/** Exactly what `setup/seed.sh` ships. */
const SEEDED = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    EC2_STATEMENT,
    { Sid: 'AttachRoleToInstance', Effect: 'Allow', Action: ['iam:PassRole', 'iam:GetRole'], Resource: '*' },
  ],
}, null, 2);

/** One correct repair: enumerate the approved roles, restrict the service. */
const SOLVED = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    EC2_STATEMENT,
    {
      Sid: 'AttachApprovedRoles',
      Effect: 'Allow',
      Action: ['iam:PassRole', 'iam:GetRole'],
      Resource: [ROLE('AppServerRole'), ROLE('AppWorkerRole')],
      Condition: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
    },
  ],
});

class FakeSandbox implements SandboxPort {
  constructor(private readonly entries: Record<string, string>) {}
  async read(p: string): Promise<SandboxPathRead | null> {
    const content = this.entries[p];
    if (content === undefined) return null;
    return { type: 'file', mode: '644', owner: 'student', group: 'student', sizeBytes: content.length, content };
  }
}

async function run(policy: string) {
  const lab = await loadLabDefinition(AWS_005);
  const sandbox = new FakeSandbox({ [POLICY]: policy, [`${DIR}/roles-in-account.txt`]: 'inventory' });
  return verifyLab({ lab, sandbox, namespace: 'jtt-lab-000000000005' });
}
const failed = (c: Array<{ status: string; label: string }>) => c.filter((x) => x.status === 'fail').map((x) => x.label);

describe('AWS-005 — the seeded policy contains the escalation', () => {
  it('fails exactly the three checks the finding is about', async () => {
    const result = await run(SEEDED);

    expect(result.passed).toBe(false);
    expect(failed(result.checks).sort()).toEqual([
      'Handing a role over is restricted to the EC2 service',
      'The pipeline can no longer attach the administrator role',
      'The pipeline can no longer attach the finance batch role',
    ]);
  });

  it('leaves the deployment checks passing, so removal is not a fix', async () => {
    const passed = (await run(SEEDED)).checks.filter((c) => c.status === 'pass').map((c) => c.label);

    expect(passed).toContain('The pipeline can still launch instances');
    expect(passed).toContain('The pipeline can still attach the application server role');
  });

  it('does not name the action, the condition key or the answer in any detail', async () => {
    const blob = (await run(SEEDED)).checks.map((c) => `${c.label} ${c.detail ?? ''}`).join('\n');

    expect(blob).not.toContain('iam:PassedToService');
    expect(blob).not.toContain('ec2.amazonaws.com');
    expect(blob).not.toContain('AppServerRole');
  });
});

describe('AWS-005 — correct repairs pass, however expressed', () => {
  it('passes when the approved roles are listed individually', async () => {
    const result = await run(SOLVED);
    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes when the approved roles are matched with a prefix', async () => {
    const prefix = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        EC2_STATEMENT,
        {
          Effect: 'Allow',
          Action: ['iam:PassRole', 'iam:GetRole'],
          Resource: 'arn:aws:iam::123456789012:role/App*',
          Condition: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
        },
      ],
    });
    expect((await run(prefix)).passed).toBe(true);
  });

  it('passes when PassRole and GetRole are split into separate statements', async () => {
    const split = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        EC2_STATEMENT,
        { Effect: 'Allow', Action: 'iam:GetRole', Resource: 'arn:aws:iam::123456789012:role/App*' },
        {
          Effect: 'Allow',
          Action: 'iam:PassRole',
          Resource: [ROLE('AppServerRole'), ROLE('AppWorkerRole')],
          Condition: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
        },
      ],
    });
    expect((await run(split)).passed).toBe(true);
  });

  it('passes with reordered statements, reordered keys and different indentation', async () => {
    const parsed = JSON.parse(SOLVED) as { Statement: unknown[] };
    const reordered = JSON.stringify({ Statement: [...parsed.Statement].reverse(), Version: '2012-10-17' }, null, 8);
    expect((await run(reordered)).passed).toBe(true);
  });

  it('passes when the condition value is written as a one-element array', async () => {
    const arrayValue = SOLVED.replace('"ec2.amazonaws.com"', '["ec2.amazonaws.com"]');
    expect((await run(arrayValue)).passed).toBe(true);
  });
});

describe('AWS-005 — repairs that do not actually close the escalation', () => {
  it('fails when the permission is simply deleted', async () => {
    const removed = JSON.stringify({ Version: '2012-10-17', Statement: [EC2_STATEMENT] });
    const result = await run(removed);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The pipeline can still attach the application server role');
    expect(failed(result.checks)).toContain('Handing a role over is restricted to the EC2 service');
  });

  it('fails when the condition is added but the roles are still unrestricted', async () => {
    const conditionOnly = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        EC2_STATEMENT,
        {
          Effect: 'Allow',
          Action: ['iam:PassRole', 'iam:GetRole'],
          Resource: '*',
          Condition: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
        },
      ],
    });
    const result = await run(conditionOnly);

    expect(result.passed).toBe(false);
    expect(failed(result.checks).sort()).toEqual([
      'The pipeline can no longer attach the administrator role',
      'The pipeline can no longer attach the finance batch role',
    ]);
  });

  it('fails when the roles are scoped but the condition is missing', async () => {
    const noCondition = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        EC2_STATEMENT,
        { Effect: 'Allow', Action: ['iam:PassRole', 'iam:GetRole'], Resource: [ROLE('AppServerRole'), ROLE('AppWorkerRole')] },
      ],
    });
    const result = await run(noCondition);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['Handing a role over is restricted to the EC2 service']);
  });

  it('fails when a prefix is chosen that still reaches a sensitive role', async () => {
    // `role/*` and `role/A*` both still cover PlatformAdminRole.
    for (const wide of ['arn:aws:iam::123456789012:role/*', 'arn:aws:iam::123456789012:role/*Role']) {
      const policy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          EC2_STATEMENT,
          {
            Effect: 'Allow',
            Action: 'iam:PassRole',
            Resource: wide,
            Condition: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
          },
        ],
      });
      const result = await run(policy);
      expect(result.passed, wide).toBe(false);
      expect(failed(result.checks)).toContain('The pipeline can no longer attach the administrator role');
    }
  });

  it('fails when the condition names the wrong service or the wrong key', async () => {
    expect((await run(SOLVED.replace('ec2.amazonaws.com', 'lambda.amazonaws.com'))).passed).toBe(false);
    expect((await run(SOLVED.replace('iam:PassedToService', 'iam:AWSServiceName'))).passed).toBe(false);
  });

  it('fails when the escalation is "fixed" by granting more IAM permissions', async () => {
    const moreIam = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        EC2_STATEMENT,
        {
          Effect: 'Allow',
          Action: ['iam:PassRole', 'iam:GetRole', 'iam:CreateRole', 'iam:AttachRolePolicy'],
          Resource: [ROLE('AppServerRole'), ROLE('AppWorkerRole')],
          Condition: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
        },
      ],
    });
    const result = await run(moreIam);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The pipeline was not given IAM write permissions');
    expect(failed(result.checks)).toContain('The pipeline cannot create roles either');
  });

  it('fails when the EC2 statement is broken while fixing the IAM one', async () => {
    const brokenEc2 = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: 'ec2:DescribeInstances', Resource: '*' },
        JSON.parse(SOLVED).Statement[1],
      ],
    });
    const result = await run(brokenEc2);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The pipeline can still launch instances');
  });

  it('fails when a wildcard Action is introduced', async () => {
    const wide = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: '*', Resource: '*' },
        JSON.parse(SOLVED).Statement[1],
      ],
    });
    const result = await run(wide);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('No Allow statement uses "*" as its Action');
    expect(failed(result.checks)).toContain('The pipeline can no longer attach the administrator role');
  });

  it('fails when a Deny is used that also blocks the approved roles', async () => {
    const overDeny = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        EC2_STATEMENT,
        JSON.parse(SOLVED).Statement[1],
        { Effect: 'Deny', Action: 'iam:PassRole', Resource: 'arn:aws:iam::123456789012:role/*' },
      ],
    });
    const result = await run(overDeny);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The pipeline can still attach the application server role');
  });

  it('accepts a correctly targeted Deny alongside a scoped Allow', async () => {
    // Belt and braces is a legitimate implementation: deny the two sensitive
    // roles explicitly, allow only the approved ones.
    const beltAndBraces = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        EC2_STATEMENT,
        JSON.parse(SOLVED).Statement[1],
        {
          Effect: 'Deny',
          Action: 'iam:PassRole',
          Resource: [ROLE('PlatformAdminRole'), ROLE('ReconciliationBatchRole')],
        },
      ],
    });
    expect((await run(beltAndBraces)).passed).toBe(true);
  });

  it('fails on malformed JSON without crashing', async () => {
    const result = await run('{"Version":"2012-10-17","Statement":[');
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.status === 'fail')?.detail).toContain('not valid JSON');
  });
});

describe('AWS-005 — isolation and shortcuts', () => {
  it('is not passed by a solved copy in another file', async () => {
    const lab = await loadLabDefinition(AWS_005);
    const sandbox = new FakeSandbox({ [POLICY]: SEEDED, [`${DIR}/deployer-policy.fixed.json`]: SOLVED });
    expect((await verifyLab({ lab, sandbox, namespace: 'jtt-lab-x' })).passed).toBe(false);
  });

  it('is not passed by writing the answer into the finding file', async () => {
    const lab = await loadLabDefinition(AWS_005);
    const sandbox = new FakeSandbox({ [POLICY]: SEEDED, [`${DIR}/finding-8102.txt`]: SOLVED });
    expect((await verifyLab({ lab, sandbox, namespace: 'jtt-lab-x' })).passed).toBe(false);
  });

  it('is not passed by another session having solved it', async () => {
    const lab = await loadLabDefinition(AWS_005);
    const a = new FakeSandbox({ [POLICY]: SOLVED });
    const b = new FakeSandbox({ [POLICY]: SEEDED });

    expect((await verifyLab({ lab, sandbox: a, namespace: 'jtt-lab-a' })).passed).toBe(true);
    expect((await verifyLab({ lab, sandbox: b, namespace: 'jtt-lab-b' })).passed).toBe(false);
  });

  it('refuses a symlink standing in for the policy', async () => {
    const lab = await loadLabDefinition(AWS_005);
    const sandbox: SandboxPort = {
      async read(p: string): Promise<SandboxPathRead | null> {
        if (p !== POLICY) return null;
        return { type: 'symlink', mode: '777', owner: 'student', group: 'student', sizeBytes: 0 };
      },
    };
    const result = await verifyLab({ lab, sandbox, namespace: 'jtt-lab-x' });

    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.status === 'fail')?.detail).toContain('not a regular file');
  });
});
