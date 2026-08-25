/**
 * CloudFormation parsing and semantic inspection.
 *
 * The property under test throughout: **a template is graded on what it
 * declares.** The same stack written as YAML with short forms, as YAML with
 * long forms, and as JSON must be indistinguishable here — and a template that
 * merely mentions the right words must not pass for one that wires them up.
 */
import { describe, expect, it } from 'vitest';
import {
  CloudFormationParseError,
  collectReferences,
  outputReference,
  parseCloudFormationTemplate,
  readPath,
  referenceAt,
  unresolvedReferences,
  valueEquals,
} from '../src/cloudformation.js';
import { verifyRequirement } from '../src/registry.js';
import { SandboxReader, type SandboxPort } from '../src/sandbox-reader.js';
import type { SandboxPathRead } from '@jumptotech/lab-orchestrator';

const SHORT_FORM = `
AWSTemplateFormatVersion: '2010-09-09'
Parameters:
  Environment:
    Type: String
Resources:
  ExportBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub '\${Environment}-exports'
  ExportRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Ref Environment
      PolicyArn: !GetAtt ExportBucket.Arn
Outputs:
  BucketName:
    Value: !Ref ExportBucket
`;

const LONG_FORM = `
AWSTemplateFormatVersion: '2010-09-09'
Parameters:
  Environment:
    Type: String
Resources:
  ExportRole:
    Type: AWS::IAM::Role
    Properties:
      PolicyArn:
        Fn::GetAtt: [ExportBucket, Arn]
      RoleName:
        Ref: Environment
  ExportBucket:
    Properties:
      BucketName:
        Fn::Sub: '\${Environment}-exports'
    Type: AWS::S3::Bucket
Outputs:
  BucketName:
    Value:
      Ref: ExportBucket
`;

const JSON_FORM = JSON.stringify({
  AWSTemplateFormatVersion: '2010-09-09',
  Parameters: { Environment: { Type: 'String' } },
  Resources: {
    ExportBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: { 'Fn::Sub': '${Environment}-exports' } } },
    ExportRole: {
      Type: 'AWS::IAM::Role',
      Properties: { RoleName: { Ref: 'Environment' }, PolicyArn: { 'Fn::GetAtt': ['ExportBucket', 'Arn'] } },
    },
  },
  Outputs: { BucketName: { Value: { Ref: 'ExportBucket' } } },
}, null, 2);

// ------------------------------------------------------------ equivalence

describe('the same template written three ways is the same template', () => {
  it('normalises short-form YAML, long-form YAML and JSON identically', () => {
    const a = parseCloudFormationTemplate(SHORT_FORM);
    const b = parseCloudFormationTemplate(LONG_FORM);
    const c = parseCloudFormationTemplate(JSON_FORM);

    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('ignores resource order, property order and indentation', () => {
    const a = parseCloudFormationTemplate(SHORT_FORM);
    const b = parseCloudFormationTemplate(LONG_FORM);

    expect(Object.keys(a.resources).sort()).toEqual(Object.keys(b.resources).sort());
    expect(a.resources.ExportRole!.properties).toEqual(b.resources.ExportRole!.properties);
  });

  it('reads the same reference out of every form', () => {
    for (const text of [SHORT_FORM, LONG_FORM, JSON_FORM]) {
      const template = parseCloudFormationTemplate(text);
      expect(referenceAt(template, 'ExportRole', 'PolicyArn')).toMatchObject({
        kind: 'GetAtt',
        target: 'ExportBucket',
        attribute: 'Arn',
      });
      expect(outputReference(template, 'BucketName')).toMatchObject({ kind: 'Ref', target: 'ExportBucket' });
    }
  });
});

// -------------------------------------------------------------- intrinsics

describe('intrinsic functions', () => {
  it('splits !GetAtt on the first dot only, so dotted attributes survive', () => {
    const template = parseCloudFormationTemplate(`
Resources:
  Ingress:
    Type: AWS::EC2::SecurityGroup
    Properties:
      Owner: !GetAtt myELB.SourceSecurityGroup.OwnerAlias
`);
    expect(referenceAt(template, 'Ingress', 'Owner')).toMatchObject({
      target: 'myELB',
      attribute: 'SourceSecurityGroup.OwnerAlias',
    });
  });

  it('finds references inside Fn::Sub strings, and skips escaped ones', () => {
    const template = parseCloudFormationTemplate(`
Parameters:
  Environment:
    Type: String
Resources:
  Bucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub '\${Environment}-\${AWS::Region}-\${!NotAVariable}-\${Queue.Arn}'
  Queue:
    Type: AWS::SQS::Queue
`);
    const targets = collectReferences(template).map((r) => r.target);

    expect(targets).toContain('Environment');
    expect(targets).toContain('AWS::Region');
    expect(targets).toContain('Queue');
    expect(targets).not.toContain('NotAVariable');
    expect(unresolvedReferences(template)).toEqual([]);
  });

  it('handles Fn::Join, Fn::Select and nested structures', () => {
    const template = parseCloudFormationTemplate(`
Resources:
  Bucket:
    Type: AWS::S3::Bucket
  Role:
    Type: AWS::IAM::Role
    Properties:
      Name: !Join ['-', [!Ref Bucket, 'suffix']]
      Pick: !Select [0, [!GetAtt Bucket.Arn]]
`);
    const targets = collectReferences(template).map((r) => r.target).sort();
    expect(targets).toEqual(['Bucket', 'Bucket']);
    expect(unresolvedReferences(template)).toEqual([]);
  });

  it('treats pseudo parameters as always resolvable', () => {
    const template = parseCloudFormationTemplate(`
Resources:
  Bucket:
    Type: AWS::S3::Bucket
    Properties:
      Name: !Sub '\${AWS::StackName}-\${AWS::AccountId}'
      Region: !Ref AWS::Region
`);
    expect(unresolvedReferences(template)).toEqual([]);
  });
});

// ----------------------------------------------------- dangling references

describe('unresolved references', () => {
  it('reports a typo in a logical ID', () => {
    const template = parseCloudFormationTemplate(`
Resources:
  ExportBucket:
    Type: AWS::S3::Bucket
  Policy:
    Type: AWS::IAM::Policy
    Properties:
      Resource: !GetAtt ExportsBucket.Arn
`);
    const dangling = unresolvedReferences(template);

    expect(dangling).toHaveLength(1);
    expect(dangling[0]).toMatchObject({ target: 'ExportsBucket', kind: 'GetAtt' });
  });

  it('reports a Sub variable naming an undeclared parameter', () => {
    const template = parseCloudFormationTemplate(`
Parameters:
  Environment:
    Type: String
Resources:
  Queue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Sub '\${Env}-events'
`);
    expect(unresolvedReferences(template).map((r) => r.target)).toEqual(['Env']);
  });

  it('reports a dangling reference in an Output', () => {
    const template = parseCloudFormationTemplate(`
Resources:
  Bucket:
    Type: AWS::S3::Bucket
Outputs:
  RoleArn:
    Value: !GetAtt MissingRole.Arn
`);
    expect(unresolvedReferences(template).map((r) => r.target)).toEqual(['MissingRole']);
  });
});

// ------------------------------------------------------------ path reading

describe('property paths and value comparison', () => {
  const template = parseCloudFormationTemplate(`
Resources:
  Role:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Statement:
          - Effect: Allow
            Action: sts:AssumeRole
            Principal:
              Service: ec2.amazonaws.com
      Tags:
        - Key: env
          Value: prod
  Single:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Statement:
          Effect: Allow
          Action: [sts:AssumeRole]
`);

  it('indexes lists with a numeric segment', () => {
    const role = template.resources.Role!;
    expect(readPath(role.properties, 'AssumeRolePolicyDocument.Statement.0.Principal.Service')).toBe('ec2.amazonaws.com');
    expect(readPath(role.properties, 'Tags.0.Key')).toBe('env');
    expect(readPath(role.properties, 'Tags.5.Key')).toBeUndefined();
  });

  it('accepts a single statement written as a mapping rather than a list', () => {
    const single = template.resources.Single!;
    expect(readPath(single.properties, 'AssumeRolePolicyDocument.Statement.0.Effect')).toBe('Allow');
  });

  it('compares a one-element list as the scalar it wraps', () => {
    expect(valueEquals('sts:AssumeRole', 'sts:AssumeRole')).toBe(true);
    expect(valueEquals(['sts:AssumeRole'], 'sts:AssumeRole')).toBe(true);
    expect(valueEquals(['sts:AssumeRole', 'sts:TagSession'], 'sts:AssumeRole')).toBe(false);
    expect(valueEquals(443, '443')).toBe(true);
    expect(valueEquals(undefined, 'x')).toBe(false);
  });
});

// ------------------------------------------------------------ invalid input

describe('documents that are not templates are refused with a reason', () => {
  const cases: Array<[string, string, string]> = [
    ['an empty file', '   ', 'template is empty'],
    ['malformed YAML', 'Resources:\n  Bucket:\n   - broken: [', 'not valid YAML or JSON'],
    ['malformed JSON', '{"Resources": {', 'not valid YAML or JSON'],
    ['a scalar', 'just a string', 'must be a mapping of sections'],
    ['a list', '- one\n- two', 'must be a mapping of sections'],
    ['no Resources', 'Description: nothing here', 'no Resources section'],
    ['empty Resources', 'Resources: {}', 'Resources section is empty'],
    ['non-mapping Resources', 'Resources: [a, b]', 'must be a mapping of logical IDs'],
    ['a resource with no Type', 'Resources:\n  Bucket:\n    Properties: {}', "resource 'Bucket' has no Type"],
    ['a resource that is a scalar', 'Resources:\n  Bucket: nope', "resource 'Bucket' must be a mapping"],
    ['non-mapping Properties', 'Resources:\n  Bucket:\n    Type: AWS::S3::Bucket\n    Properties: [a]', 'non-mapping Properties'],
  ];

  for (const [name, text, reason] of cases) {
    it(`refuses ${name}`, () => {
      expect(() => parseCloudFormationTemplate(text)).toThrow(CloudFormationParseError);
      expect(() => parseCloudFormationTemplate(text)).toThrow(
        new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    });
  }
});

// ------------------------------------------------- handlers, via the reader

const TEMPLATE_PATH = '/home/student/template.yaml';

class FakeSandbox implements SandboxPort {
  constructor(private readonly entries: Record<string, string>) {}
  async read(p: string): Promise<SandboxPathRead | null> {
    const content = this.entries[p];
    if (content === undefined) return null;
    return { type: 'file', mode: '644', owner: 'student', group: 'student', sizeBytes: content.length, content };
  }
}
const reader = (content: string) => new SandboxReader(new FakeSandbox({ [TEMPLATE_PATH]: content }));

describe('the handlers grade through the same model', () => {
  it('validates a template and refuses a broken one without crashing', async () => {
    const ok = await verifyRequirement(
      { type: 'cfn_template_valid', path: TEMPLATE_PATH, format_version: '2010-09-09', min_resources: 2 },
      reader(SHORT_FORM),
    );
    expect(ok.status).toBe('pass');

    const bad = await verifyRequirement({ type: 'cfn_template_valid', path: TEMPLATE_PATH }, reader('{ broken'));
    expect(bad.status).toBe('fail');
    expect(bad.detail).toContain('not valid YAML or JSON');
  });

  it('reports a missing file rather than throwing', async () => {
    const result = await verifyRequirement(
      { type: 'cfn_template_valid', path: '/home/student/absent.yaml' },
      reader(SHORT_FORM),
    );
    expect(result.status).toBe('fail');
  });

  it('distinguishes a right name with a wrong type', async () => {
    const right = await verifyRequirement(
      { type: 'cfn_resource_exists', path: TEMPLATE_PATH, logical_id: 'ExportBucket', resource_type: 'AWS::S3::Bucket' },
      reader(SHORT_FORM),
    );
    expect(right.status).toBe('pass');

    const wrong = await verifyRequirement(
      { type: 'cfn_resource_exists', path: TEMPLATE_PATH, logical_id: 'ExportBucket', resource_type: 'AWS::S3::BucketPolicy' },
      reader(SHORT_FORM),
    );
    expect(wrong.status).toBe('fail');
    expect(wrong.detail).toContain('AWS::S3::Bucket');
  });

  it('requires the named intrinsic, not merely a reference', async () => {
    const byRef = await verifyRequirement(
      { type: 'cfn_resource_reference', path: TEMPLATE_PATH, logical_id: 'ExportRole', property: 'PolicyArn', references: 'ExportBucket', via: 'Ref' },
      reader(SHORT_FORM),
    );
    expect(byRef.status).toBe('fail');
    expect(byRef.detail).toContain('GetAtt');

    const byGetAtt = await verifyRequirement(
      { type: 'cfn_resource_reference', path: TEMPLATE_PATH, logical_id: 'ExportRole', property: 'PolicyArn', references: 'ExportBucket', via: 'GetAtt', attribute: 'Arn' },
      reader(SHORT_FORM),
    );
    expect(byGetAtt.status).toBe('pass');
  });

  it('does not dump the template in a failure detail', async () => {
    const result = await verifyRequirement(
      { type: 'cfn_resource_property', path: TEMPLATE_PATH, logical_id: 'ExportBucket', property: 'VersioningConfiguration.Status', equals: 'Enabled' },
      reader(SHORT_FORM),
    );
    expect(result.status).toBe('fail');
    expect(result.detail!.length).toBeLessThan(200);
    expect(result.detail).not.toContain('AWSTemplateFormatVersion');
  });
});
