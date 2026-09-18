/**
 * IAM `Condition` evaluation against a stated request context.
 *
 * The rules are the documented ones (IAM User Guide, "IAM JSON policy
 * elements: Condition operators"): keys and operators AND together, values for
 * one key OR together, a missing key fails a positive operator and satisfies a
 * negated one, `…IfExists` and `Null` treat absence explicitly. The lab cases at
 * the bottom are the shapes the AWS track's audit found passing when conditions
 * were ignored.
 */
import { describe, expect, it } from 'vitest';
import {
  IamConditionUnsupportedError,
  conditionsHold,
  evaluateIamPolicy,
  parseIamPolicy,
  type IamStatement,
} from '../src/index.js';

function statement(condition: Record<string, Record<string, string | string[]>>): IamStatement {
  const policy = parseIamPolicy(
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 's3:PutObject', Resource: '*', Condition: condition }],
    }),
  );
  return policy.statements[0]!;
}

describe('conditionsHold', () => {
  it('ANDs operators and keys, and ORs the values of one key', () => {
    const s = statement({
      StringEquals: { 's3:x-amz-server-side-encryption': ['aws:kms', 'aws:kms:dsse'] },
      Bool: { 'aws:SecureTransport': 'true' },
    });
    expect(conditionsHold(s, { 's3:x-amz-server-side-encryption': 'aws:kms:dsse', 'aws:SecureTransport': 'true' })).toBe(true);
    expect(conditionsHold(s, { 's3:x-amz-server-side-encryption': 'aws:kms', 'aws:SecureTransport': 'false' })).toBe(false);
    expect(conditionsHold(s, { 's3:x-amz-server-side-encryption': 'AES256', 'aws:SecureTransport': 'true' })).toBe(false);
  });

  it('fails a positive operator and satisfies a negated one when the key is missing', () => {
    expect(conditionsHold(statement({ StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } }), {})).toBe(false);
    expect(conditionsHold(statement({ StringNotEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } }), {})).toBe(true);
    expect(conditionsHold(statement({ ArnNotLike: { 'aws:SourceArn': 'arn:aws:*' } }), {})).toBe(true);
  });

  it('requires a negated operator to match none of its values', () => {
    const s = statement({ StringNotEquals: { 's3:x-amz-server-side-encryption': ['aws:kms', 'AES256'] } });
    expect(conditionsHold(s, { 's3:x-amz-server-side-encryption': 'AES256' })).toBe(false);
    expect(conditionsHold(s, { 's3:x-amz-server-side-encryption': 'none' })).toBe(true);
  });

  it('treats IfExists and Null as statements about absence', () => {
    expect(conditionsHold(statement({ StringEqualsIfExists: { 'aws:RequestedRegion': 'eu-west-1' } }), {})).toBe(true);
    expect(conditionsHold(statement({ StringEqualsIfExists: { 'aws:RequestedRegion': 'eu-west-1' } }), { 'aws:RequestedRegion': 'us-east-1' })).toBe(false);
    expect(conditionsHold(statement({ Null: { 'aws:TokenIssueTime': 'true' } }), {})).toBe(true);
    expect(conditionsHold(statement({ Null: { 'aws:TokenIssueTime': 'false' } }), {})).toBe(false);
  });

  it('matches keys without regard to case, and Like patterns with * and ?', () => {
    expect(conditionsHold(statement({ StringLike: { 'AWS:SourceArn': 'arn:aws:ec2:*:123456789012:instance/*' } }), { 'aws:sourcearn': 'arn:aws:ec2:eu-west-1:123456789012:instance/i-0abc' })).toBe(true);
  });

  it('evaluates IP ranges and numbers', () => {
    expect(conditionsHold(statement({ IpAddress: { 'aws:SourceIp': '203.0.113.0/24' } }), { 'aws:SourceIp': '203.0.113.47' })).toBe(true);
    expect(conditionsHold(statement({ NotIpAddress: { 'aws:SourceIp': '203.0.113.0/24' } }), { 'aws:SourceIp': '198.51.100.1' })).toBe(true);
    expect(conditionsHold(statement({ NumericLessThanEquals: { 's3:max-keys': '10' } }), { 's3:max-keys': '10' })).toBe(true);
    expect(conditionsHold(statement({ NumericLessThanEquals: { 's3:max-keys': '10' } }), { 's3:max-keys': '11' })).toBe(false);
  });

  it('refuses to guess about an operator it does not implement', () => {
    expect(() => conditionsHold(statement({ DateLessThan: { 'aws:CurrentTime': '2026-01-01T00:00:00Z' } }), {})).toThrow(
      IamConditionUnsupportedError,
    );
  });
});

describe('evaluateIamPolicy with a request context', () => {
  const policy = (statements: unknown[]) => parseIamPolicy(JSON.stringify({ Version: '2012-10-17', Statement: statements }));
  const put = { action: 's3:PutObject', resource: 'arn:aws:s3:::jtt-exports/a.csv' };

  it('keeps the context-free answer when no context is given', () => {
    const p = policy([{ Effect: 'Allow', Action: 's3:PutObject', Resource: '*', Condition: { StringEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } } }]);
    expect(evaluateIamPolicy(p, put)).toBe('allow');
  });

  it('allows an upload only in the context its condition names', () => {
    const p = policy([{ Effect: 'Allow', Action: 's3:PutObject', Resource: '*', Condition: { StringEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } } }]);
    expect(evaluateIamPolicy(p, { ...put, context: { 's3:x-amz-server-side-encryption': 'aws:kms' } })).toBe('allow');
    expect(evaluateIamPolicy(p, { ...put, context: {} })).toBe('implicitDeny');
  });

  it('lets an unconditional Allow through when the only other statement is conditional — AWS-002', () => {
    const p = policy([
      { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: '*' },
      { Effect: 'Allow', Action: 's3:PutObject', Resource: '*', Condition: { StringEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } } },
    ]);
    expect(evaluateIamPolicy(p, { ...put, context: {} })).toBe('allow');
  });

  it('honours the Deny-unless-encrypted pattern in both directions', () => {
    const p = policy([
      { Effect: 'Allow', Action: 's3:PutObject', Resource: '*' },
      { Effect: 'Deny', Action: 's3:PutObject', Resource: '*', Condition: { StringNotEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } } },
    ]);
    expect(evaluateIamPolicy(p, { ...put, context: {} })).toBe('explicitDeny');
    expect(evaluateIamPolicy(p, { ...put, context: { 's3:x-amz-server-side-encryption': 'aws:kms' } })).toBe('allow');
  });

  it('does not count a Deny that never fires as protection — AWS-003', () => {
    const p = policy([
      { Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' },
      { Effect: 'Deny', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/customer-exports/*', Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
    ]);
    const get = { action: 's3:GetObject', resource: 'arn:aws:s3:::b/customer-exports/x.csv' };
    expect(evaluateIamPolicy(p, get)).toBe('explicitDeny');
    expect(evaluateIamPolicy(p, { ...get, context: { 'aws:SecureTransport': 'true' } })).toBe('allow');
  });
});
