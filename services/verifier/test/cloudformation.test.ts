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
  asSubTemplate,
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

describe('asSubTemplate — a value as the Sub template that would produce it', () => {
  it('writes GetAtt, Ref, Join and a Sub variable map the same way', () => {
    expect(asSubTemplate({ 'Fn::GetAtt': ['Bucket', 'Arn'] })).toBe('${Bucket.Arn}');
    expect(asSubTemplate({ 'Fn::GetAtt': 'Bucket.Arn' })).toBe('${Bucket.Arn}');
    expect(asSubTemplate({ Ref: 'Bucket' })).toBe('${Bucket}');
    expect(asSubTemplate({ 'Fn::Join': ['', [{ 'Fn::GetAtt': ['Bucket', 'Arn'] }, '/*']] })).toBe('${Bucket.Arn}/*');
    expect(asSubTemplate({ 'Fn::Sub': ['${B}/*', { B: { 'Fn::GetAtt': ['Bucket', 'Arn'] } }] })).toBe('${Bucket.Arn}/*');
    expect(asSubTemplate({ 'Fn::Sub': '${Bucket.Arn}/*' })).toBe('${Bucket.Arn}/*');
  });

  it('never lets a plain string equal a template with a reference in it', () => {
    expect(asSubTemplate('${Bucket.Arn}/*')).toBe('${!Bucket.Arn}/*');
    expect(asSubTemplate({ 'Fn::Join': ['', ['${Bucket.Arn}', '/*']] })).toBe('${!Bucket.Arn}/*');
    // An escaped Sub variable stays escaped, even when the map defines it.
    expect(asSubTemplate({ 'Fn::Sub': ['${!B}/*', { B: { Ref: 'Bucket' } }] })).toBe('${!B}/*');
  });

  it('gives up on anything it cannot write as a template', () => {
    expect(asSubTemplate({ 'Fn::Select': [0, ['a']] })).toBeNull();
    expect(asSubTemplate({ 'Fn::Join': ['', 'not-a-list'] })).toBeNull();
    expect(asSubTemplate({ 'Fn::Sub': ['${B}', { B: { 'Fn::Select': [0, ['a']] } }] })).toBeNull();
    expect(asSubTemplate({ Ref: 'A', Other: 1 })).toBeNull();
    expect(asSubTemplate(['${Bucket.Arn}'])).toBeNull();
  });
});

describe('Fn::Sub variable substitution scans the template, it does not match a pattern', () => {
  const sub = (template: string, variables: Record<string, unknown> = { B: { Ref: 'Bucket' } }) =>
    asSubTemplate({ 'Fn::Sub': [template, variables] });

  it('replaces a mapped variable and leaves the text around it alone', () => {
    expect(sub('${B}')).toBe('${Bucket}');
    expect(sub('arn:aws:s3:::${B}/data/*')).toBe('arn:aws:s3:::${Bucket}/data/*');
    expect(sub('${B}', { B: { 'Fn::GetAtt': ['Bucket', 'Arn'] } })).toBe('${Bucket.Arn}');
  });

  it('leaves a variable the map does not define exactly as written', () => {
    expect(sub('${C}/*')).toBe('${C}/*');
    expect(sub('${AWS::Region}')).toBe('${AWS::Region}');
    // A name the map has no entry for must not pick one up from Object's prototype.
    expect(sub('${toString}')).toBe('${toString}');
    expect(sub('${__proto__}')).toBe('${__proto__}');
  });

  it('never substitutes an escaped variable, even one the map defines', () => {
    expect(sub('${!B}')).toBe('${!B}');
    expect(sub('${!B}/${B}')).toBe('${!B}/${Bucket}');
    expect(sub('${!}')).toBe('${!}');
  });

  it('replaces every occurrence in one string, left to right', () => {
    expect(sub('${B}${B}', { B: { Ref: 'Bucket' } })).toBe('${Bucket}${Bucket}');
    expect(sub('${A}:${B}:${A}', { A: { Ref: 'Alpha' }, B: { Ref: 'Beta' } })).toBe(
      '${Alpha}:${Beta}:${Alpha}',
    );
    // A mapped literal keeps its text, with its own `${` escaped as Sub escapes it.
    expect(sub('a${A}b${C}c${B}d', { A: { Ref: 'Alpha' }, B: 'lit${x}' })).toBe(
      'a${Alpha}b${C}clit${!x}d',
    );
  });

  it('keeps malformed placeholder text as it stands', () => {
    // No closing brace: nothing is a placeholder, so nothing changes.
    expect(sub('${B')).toBe('${B');
    expect(sub('prefix ${B and ${A')).toBe('prefix ${B and ${A');
    // A closed placeholder still resolves; a trailing unclosed one is text.
    expect(sub('${B}${')).toBe('${Bucket}${');
    expect(sub('${B}-${B')).toBe('${Bucket}-${B');
    // Each `${` is closed by the first `}` after it, so the inner name is `${B`.
    expect(sub('${${B}')).toBe('${${B}');
    expect(sub('${${B}}')).toBe('${${B}}');
    // Stray braces are ordinary characters.
    expect(sub('}${B}{')).toBe('}${Bucket}{');
    expect(sub('$B} {B} ${')).toBe('$B} {B} ${');
  });

  it('handles a long run of ${ without pathological slowdown', () => {
    // The shape CodeQL flagged: `/\$\{([^}]*)\}/g` backtracks quadratically over
    // this, taking tens of seconds. A single scan is linear, so it is immediate.
    const repeats = 200_000;
    const shapes = [
      '${'.repeat(repeats) + 'x', // never closed
      '${'.repeat(repeats) + '}', // one closing brace, far away
      '${'.repeat(repeats) + '${B}', // a real variable behind the run
      '${}'.repeat(repeats), // many empty placeholders
      '${!'.repeat(repeats), // many escapes, none closed
    ];
    const started = performance.now();
    for (const shape of shapes) {
      // None of these names is in the map, so every one comes back unchanged.
      expect(sub(shape)).toBe(shape);
    }
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('a Sub variable map defines local names, not references', () => {
  it('does not report a mapped variable as dangling, but still checks the map values', () => {
    const template = parseCloudFormationTemplate(`Resources:
  Bucket:
    Type: AWS::S3::Bucket
  Policy:
    Type: AWS::IAM::Policy
    Properties:
      Resource: !Sub ['\${B}/*', {B: !GetAtt Bucket.Arn}]
      Other: !Sub ['\${C}/*', {C: !GetAtt Missing.Arn}]
      Unmapped: !Sub ['\${D}/*', {E: x}]
`);
    expect(unresolvedReferences(template).map((r) => r.target).sort()).toEqual(['D', 'Missing']);
  });
});
