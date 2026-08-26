/**
 * AWS-018 — verification behaviour.
 *
 * The lab grades a repaired CloudFormation template. These tests are mostly
 * about the ways a template can look repaired and not be: a bare string where a
 * reference belongs, the wrong intrinsic for what is being asked, expected
 * words hidden in comments or in an unrelated resource, and a duplicate that
 * declares the right thing under the wrong name.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type SandboxPathRead } from '@jumptotech/lab-orchestrator';
import { verifyLab, type SandboxPort } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const AWS_018 = path.join(LABS_DIR, 'aws', 'aws-018-cloudformation-repair', 'lab.yaml');
const TEMPLATE = '/home/student/stack/payments-export.yaml';

/** Exactly what `setup/seed.sh` ships. */
const SEEDED = `AWSTemplateFormatVersion: '2010-09-09'
Description: Payments export pipeline - bucket, queue, and the role that reads them.

Parameters:
  Environment:
    Type: String
    Default: staging

Resources:
  ExportBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub '\${Environment}-payments-exports'

  ExportQueue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Sub '\${Env}-payments-export-events'

  ExportRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub '\${Environment}-payments-export'

  ExportRolePolicy:
    Type: AWS::IAM::Policy
    Properties:
      PolicyName: payments-export-read
      Roles:
        - ExportRole
      PolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Action:
              - s3:GetObject
            Resource: !GetAtt ExportsBucket.Arn

Outputs:
  ExportBucketName:
    Value: !Ref ExportBucket
`;

/** One correct repair, in short-form YAML. */
const SOLVED = `AWSTemplateFormatVersion: '2010-09-09'
Parameters:
  Environment:
    Type: String
    Default: staging

Resources:
  ExportBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub '\${Environment}-payments-exports'

  ExportQueue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Sub '\${Environment}-payments-export-events'

  ExportRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub '\${Environment}-payments-export'
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: ec2.amazonaws.com
            Action: sts:AssumeRole

  ExportRolePolicy:
    Type: AWS::IAM::Policy
    Properties:
      PolicyName: payments-export-read
      Roles:
        - !Ref ExportRole
      PolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Action:
              - s3:GetObject
            Resource: !GetAtt ExportBucket.Arn

Outputs:
  ExportBucketName:
    Value: !Ref ExportBucket
  ExportRoleArn:
    Value: !GetAtt ExportRole.Arn
`;

class FakeSandbox implements SandboxPort {
  constructor(private readonly entries: Record<string, string>) {}
  async read(p: string): Promise<SandboxPathRead | null> {
    const content = this.entries[p];
    if (content === undefined) return null;
    return { type: 'file', mode: '644', owner: 'student', group: 'student', sizeBytes: content.length, content };
  }
}

async function run(template: string | null) {
  const lab = await loadLabDefinition(AWS_018);
  const entries: Record<string, string> = { '/home/student/stack/stack-events.txt': 'events' };
  if (template !== null) entries[TEMPLATE] = template;
  return verifyLab({ lab, sandbox: new FakeSandbox(entries), namespace: 'jtt-lab-000000000018' });
}
const failed = (c: Array<{ status: string; label: string }>) => c.filter((x) => x.status === 'fail').map((x) => x.label);

// ------------------------------------------------------------ starting state

describe('AWS-018 — the seeded template does not pass', () => {
  it('fails exactly the defects the stack events and change request describe', async () => {
    const result = await run(SEEDED);

    expect(result.passed).toBe(false);
    expect(failed(result.checks).sort()).toEqual([
      "Every reference in the template resolves to something it declares",
      "The policy attaches to the role by referring to it",
      "The policy takes the bucket's ARN from the bucket resource",
      "The role trusts the service the export instances run on",
      "The role's trust document allows rather than denies",
      "The role's trust document allows the role to be assumed",
      "The stack exports the role ARN, taken from the role",
    ]);
  });

  it('still passes the parts that already worked', async () => {
    const passed = (await run(SEEDED)).checks.filter((c) => c.status === 'pass').map((c) => c.label);

    expect(passed).toContain('ExportBucket is an S3 bucket');
    expect(passed).toContain('ExportQueue is an SQS queue');
    expect(passed).toContain('The stack exports the bucket name, taken from the bucket');
  });

  it('names the dangling references without dumping the template', async () => {
    const result = await run(SEEDED);
    const dangling = result.checks.find((c) => c.label.startsWith('Every reference'));

    expect(dangling?.detail).toContain('ExportsBucket');
    expect(dangling?.detail).toContain('Env');
    expect(dangling?.detail).not.toContain('AWSTemplateFormatVersion');
    expect(dangling!.detail!.length).toBeLessThan(400);
  });

  it('does not disclose the repair in any failure detail', async () => {
    const blob = (await run(SEEDED)).checks.map((c) => `${c.label} ${c.detail ?? ''}`).join('\n');

    expect(blob).not.toContain('ec2.amazonaws.com');
    expect(blob).not.toContain('sts:AssumeRole');
    expect(blob).not.toContain('!Ref');
  });
});

// ------------------------------------------------------- correct repairs

describe('AWS-018 — a correct repair passes however it is written', () => {
  it('passes the short-form YAML repair', async () => {
    const result = await run(SOLVED);
    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes the same template written with long-form intrinsics', async () => {
    const longForm = SOLVED
      .replace("Resource: !GetAtt ExportBucket.Arn", "Resource:\n              Fn::GetAtt: [ExportBucket, Arn]")
      .replace("- !Ref ExportRole", "- Ref: ExportRole")
      .replace("Value: !GetAtt ExportRole.Arn", "Value:\n      Fn::GetAtt: [ExportRole, Arn]")
      .replace("Value: !Ref ExportBucket", "Value:\n      Ref: ExportBucket");

    expect((await run(longForm)).passed).toBe(true);
  });

  it('passes the same stack written as JSON', async () => {
    const asJson = JSON.stringify({
      AWSTemplateFormatVersion: '2010-09-09',
      Parameters: { Environment: { Type: 'String', Default: 'staging' } },
      Resources: {
        ExportRolePolicy: {
          Type: 'AWS::IAM::Policy',
          Properties: {
            PolicyName: 'payments-export-read',
            Roles: [{ Ref: 'ExportRole' }],
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [{ Effect: 'Allow', Action: ['s3:GetObject'], Resource: { 'Fn::GetAtt': ['ExportBucket', 'Arn'] } }],
            },
          },
        },
        ExportBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: { 'Fn::Sub': '${Environment}-payments-exports' } } },
        ExportQueue: { Type: 'AWS::SQS::Queue', Properties: { QueueName: { 'Fn::Sub': '${Environment}-events' } } },
        ExportRole: {
          Type: 'AWS::IAM::Role',
          Properties: {
            AssumeRolePolicyDocument: {
              Statement: { Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: ['sts:AssumeRole'] },
            },
          },
        },
      },
      Outputs: {
        ExportRoleArn: { Value: { 'Fn::GetAtt': ['ExportRole', 'Arn'] } },
        ExportBucketName: { Value: { Ref: 'ExportBucket' } },
      },
    }, null, 2);

    expect((await run(asJson)).passed).toBe(true);
  });

  it('passes with resources and properties declared in a different order', async () => {
    const reordered = `Resources:
  ExportRolePolicy:
    Properties:
      PolicyDocument:
        Statement:
          - Resource: !GetAtt ExportBucket.Arn
            Action: [s3:GetObject]
            Effect: Allow
        Version: '2012-10-17'
      Roles: [!Ref ExportRole]
      PolicyName: payments-export-read
    Type: AWS::IAM::Policy
  ExportRole:
    Properties:
      AssumeRolePolicyDocument:
        Statement:
          - Action: [sts:AssumeRole]
            Principal: {Service: ec2.amazonaws.com}
            Effect: Allow
    Type: AWS::IAM::Role
  ExportQueue:
    Type: AWS::SQS::Queue
    Properties: {QueueName: !Sub '\${Environment}-events'}
  ExportBucket:
    Type: AWS::S3::Bucket
Outputs:
  ExportRoleArn: {Value: !GetAtt ExportRole.Arn}
  ExportBucketName: {Value: !Ref ExportBucket}
Parameters:
  Environment: {Type: String, Default: staging}
AWSTemplateFormatVersion: '2010-09-09'
`;
    expect((await run(reordered)).passed).toBe(true);
  });
});

// ------------------------------------------------------------- adversarial

describe('AWS-018 — templates that look repaired but are not', () => {
  it('fails when a bare string stands in for a reference', async () => {
    const bare = SOLVED.replace('- !Ref ExportRole', '- ExportRole');
    const result = await run(bare);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The policy attaches to the role by referring to it']);
  });

  it('fails when Ref is used where an attribute is required', async () => {
    const wrongIntrinsic = SOLVED.replace('Resource: !GetAtt ExportBucket.Arn', 'Resource: !Ref ExportBucket');
    const result = await run(wrongIntrinsic);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(["The policy takes the bucket's ARN from the bucket resource"]);
  });

  it('fails when GetAtt names the wrong attribute', async () => {
    const wrongAttribute = SOLVED.replace('!GetAtt ExportBucket.Arn', '!GetAtt ExportBucket.DomainName');
    const result = await run(wrongAttribute);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain("The policy takes the bucket's ARN from the bucket resource");
  });

  it('fails when the logical ID is right but the resource type is wrong', async () => {
    const wrongType = SOLVED.replace('ExportQueue:\n    Type: AWS::SQS::Queue', 'ExportQueue:\n    Type: AWS::SNS::Topic');
    const result = await run(wrongType);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['ExportQueue is an SQS queue']);
  });

  it('fails when a required property is still absent', async () => {
    const noTrust = SOLVED.replace(/      AssumeRolePolicyDocument:[\s\S]*?Action: sts:AssumeRole\n/, '');
    const result = await run(noTrust);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The role trusts the service the export instances run on');
  });

  it('fails when the trust document denies instead of allowing', async () => {
    const denied = SOLVED.replace('          - Effect: Allow\n            Principal:', '          - Effect: Deny\n            Principal:');
    const result = await run(denied);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain("The role's trust document allows rather than denies");
  });

  it('cannot be passed by putting the expected words in a comment', async () => {
    const commented = SEEDED.replace(
      '  ExportRole:',
      '  # ExportRole needs Principal: Service: ec2.amazonaws.com and Action: sts:AssumeRole\n  # and Outputs ExportRoleArn: !GetAtt ExportRole.Arn\n  ExportRole:',
    );
    const result = await run(commented);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toHaveLength(7);
  });

  it('cannot be passed by putting the expected values in an unrelated resource', async () => {
    const decoy = SEEDED.replace(
      'Outputs:',
      `  DecoyRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Statement:
          - Effect: Allow
            Principal:
              Service: ec2.amazonaws.com
            Action: sts:AssumeRole

Outputs:`,
    );
    const result = await run(decoy);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The role trusts the service the export instances run on');
  });

  it('cannot be passed by a correctly-built duplicate under another logical ID', async () => {
    const renamed = SOLVED.replace(/ExportRolePolicy:/, 'ExportRolePolicyV2:');
    const result = await run(renamed);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('ExportRolePolicy is an IAM policy');
  });

  it('fails when an output is present but reads from the wrong resource', async () => {
    const wrongOutput = SOLVED.replace('  ExportRoleArn:\n    Value: !GetAtt ExportRole.Arn', '  ExportRoleArn:\n    Value: !GetAtt ExportBucket.Arn');
    const result = await run(wrongOutput);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The stack exports the role ARN, taken from the role']);
  });

  it('fails safely on malformed YAML, malformed JSON and an empty file', async () => {
    for (const broken of ['Resources:\n  Bucket:\n   - [', '{"Resources": {', '', '   ']) {
      const result = await run(broken);
      expect(result.passed, JSON.stringify(broken)).toBe(false);
      expect(result.checks.some((c) => c.status === 'fail')).toBe(true);
    }
  });

  it('fails when the template is missing entirely', async () => {
    const result = await run(null);
    expect(result.passed).toBe(false);
  });

  it('gives the same verdict when checked repeatedly', async () => {
    const first = await run(SOLVED);
    const second = await run(SOLVED);
    expect(first.checks.map((c) => c.status)).toEqual(second.checks.map((c) => c.status));
  });
});

// --------------------------------------------------------------- isolation

describe('AWS-018 — isolation', () => {
  it('is not passed by another session having solved it', async () => {
    const lab = await loadLabDefinition(AWS_018);
    const a = new FakeSandbox({ [TEMPLATE]: SOLVED });
    const b = new FakeSandbox({ [TEMPLATE]: SEEDED });

    expect((await verifyLab({ lab, sandbox: a, namespace: 'jtt-lab-a' })).passed).toBe(true);
    expect((await verifyLab({ lab, sandbox: b, namespace: 'jtt-lab-b' })).passed).toBe(false);
  });

  it('is not passed by a repaired copy left in another file', async () => {
    const lab = await loadLabDefinition(AWS_018);
    const sandbox = new FakeSandbox({ [TEMPLATE]: SEEDED, '/home/student/stack/payments-export.fixed.yaml': SOLVED });
    expect((await verifyLab({ lab, sandbox, namespace: 'jtt-lab-x' })).passed).toBe(false);
  });

  it('refuses a symlink standing in for the template', async () => {
    const lab = await loadLabDefinition(AWS_018);
    const sandbox: SandboxPort = {
      async read(p: string): Promise<SandboxPathRead | null> {
        if (p !== TEMPLATE) return null;
        return { type: 'symlink', mode: '777', owner: 'student', group: 'student', sizeBytes: 0 };
      },
    };
    const result = await verifyLab({ lab, sandbox, namespace: 'jtt-lab-x' });

    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.status === 'fail')?.detail).toContain('not a regular file');
  });
});
