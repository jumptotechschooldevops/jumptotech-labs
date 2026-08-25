/**
 * AWS-003 — verification behaviour.
 *
 * The lab is about IAM's evaluation order, so these tests are about it too:
 * an applicable explicit `Deny` beats any `Allow`; a request nothing allows is
 * denied implicitly; and the two are repaired in different ways. A student who
 * cannot tell them apart cannot pass, and a student who expresses the
 * protection as an absence rather than a `Deny` cannot either.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type SandboxPathRead } from '@jumptotech/lab-orchestrator';
import { verifyLab, type SandboxPort } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const AWS_003 = path.join(LABS_DIR, 'aws', 'aws-003-explicit-deny', 'lab.yaml');

const DIR = '/home/student/access-review';
const POLICY = `${DIR}/policy.json`;
const INCIDENT = `${DIR}/incident-6042.txt`;

const BUCKET = 'arn:aws:s3:::jumptotech-build-artifacts';
const BUILDS = `${BUCKET}/builds/*`;
const EXPORTS = `${BUCKET}/customer-exports/*`;

/** Exactly what `setup/seed.sh` ships: one Deny scoped to the whole bucket. */
const STARTER = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    { Sid: 'DeveloperRead', Effect: 'Allow', Action: 's3:GetObject', Resource: `${BUCKET}/*` },
    {
      Sid: 'ProtectCustomerExports',
      Effect: 'Deny',
      Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      Resource: `${BUCKET}/*`,
    },
  ],
}, null, 2);

/** One correct repair: narrow the Deny, allow what the incident needs. */
const SOLVED = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    { Sid: 'List', Effect: 'Allow', Action: 's3:ListBucket', Resource: BUCKET },
    { Sid: 'ReadWriteBuilds', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: BUILDS },
    {
      Sid: 'ProtectCustomerExports',
      Effect: 'Deny',
      Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      Resource: EXPORTS,
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

async function runWith(entries: Record<string, string>) {
  const lab = await loadLabDefinition(AWS_003);
  return verifyLab({ lab, sandbox: new FakeSandbox(entries), namespace: 'jtt-lab-000000000003' });
}
const run = (policy: string) => runWith({ [POLICY]: policy, [INCIDENT]: 'incident text' });
const failed = (checks: Array<{ status: string; label: string }>) =>
  checks.filter((c) => c.status === 'fail').map((c) => c.label);

// ---------------------------------------------------------- starting state

describe('AWS-003 — the seeded policy reproduces the incident', () => {
  it('fails exactly the three operations the incident says are broken', async () => {
    const result = await run(STARTER);

    expect(result.passed).toBe(false);
    expect(failed(result.checks).sort()).toEqual([
      'The developer role may list the bucket',
      'The developer role may read a build artifact',
      'The developer role may upload a build artifact',
    ]);
  });

  it('already satisfies the protections, so only the breakage is left to fix', async () => {
    const result = await run(STARTER);
    const passed = result.checks.filter((c) => c.status === 'pass').map((c) => c.label);

    expect(passed).toContain('Customer exports cannot be read');
    expect(passed).toContain(
      'Customer exports are protected by an explicit Deny, not merely by omission',
    );
  });

  it('does not reveal the repair in any failure detail', async () => {
    const result = await run(STARTER);
    const blob = result.checks.map((c) => `${c.label} ${c.detail ?? ''}`).join('\n');

    expect(blob).not.toContain('customer-exports/*');
    expect(blob).not.toContain('builds/*');
    expect(blob).not.toContain('"Effect"');
  });
});

// ------------------------------------------------- evaluation order, proved

describe('AWS-003 — the three evaluation outcomes are graded differently', () => {
  it('Allow plus an applicable explicit Deny is DENIED — adding Allows cannot fix it', async () => {
    // Exactly what the colleague tried on Wednesday: another Allow, Deny intact.
    const moreAllows = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        ...(JSON.parse(STARTER) as { Statement: unknown[] }).Statement,
        { Sid: 'TryingAgain', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: BUILDS },
        { Sid: 'AndAgain', Effect: 'Allow', Action: 's3:ListBucket', Resource: BUCKET },
      ],
    });
    const result = await run(moreAllows);

    expect(result.passed).toBe(false);
    // Listing is fixed — nothing denied it. Reading and uploading are not.
    expect(failed(result.checks).sort()).toEqual([
      'The developer role may read a build artifact',
      'The developer role may upload a build artifact',
    ]);
  });

  it('Allow with no applicable Deny is ALLOWED', async () => {
    expect((await run(SOLVED)).passed).toBe(true);
  });

  it('no applicable Allow is DENIED implicitly — and that is not the same as a Deny', async () => {
    // Narrowing the Allow instead of the Deny leaves customer-exports merely
    // ungranted. Every not_allows check passes; the explicit-Deny check does
    // not, which is the distinction the incident's line 6 is about.
    const implicitOnly = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Sid: 'List', Effect: 'Allow', Action: 's3:ListBucket', Resource: BUCKET },
        { Sid: 'ReadWriteBuilds', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: BUILDS },
      ],
    });
    const result = await run(implicitOnly);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'Customer exports are protected by an explicit Deny, not merely by omission',
    ]);
  });
});

// ------------------------------------------------------------- equivalence

describe('AWS-003 — equivalent policies are graded equivalently', () => {
  it('accepts reordered statements and reordered keys', async () => {
    const parsed = JSON.parse(SOLVED) as { Statement: unknown[] };
    const reordered = JSON.stringify({ Statement: [...parsed.Statement].reverse(), Version: '2012-10-17' });

    expect((await run(reordered)).passed).toBe(true);
  });

  it('accepts pretty-printed and packed JSON alike', async () => {
    expect((await run(JSON.stringify(JSON.parse(SOLVED), null, 4))).passed).toBe(true);
    expect((await run(JSON.stringify(JSON.parse(SOLVED)))).passed).toBe(true);
  });

  it('accepts Action and Resource as strings or as arrays', async () => {
    const arrays = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: [BUCKET] },
        { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: [BUILDS] },
        { Effect: 'Deny', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: [EXPORTS] },
      ],
    });
    expect((await run(arrays)).passed).toBe(true);
  });

  it('accepts a different correct shape: separate read and upload statements', async () => {
    const split = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: 's3:ListBucket', Resource: BUCKET },
        { Effect: 'Allow', Action: 's3:GetObject', Resource: BUILDS },
        { Effect: 'Allow', Action: 's3:PutObject', Resource: BUILDS },
        { Effect: 'Deny', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: EXPORTS },
      ],
    });
    expect((await run(split)).passed).toBe(true);
  });

  it('accepts a Deny scoped by a broader prefix that still spares the builds', async () => {
    const prefix = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: 's3:ListBucket', Resource: BUCKET },
        { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: BUILDS },
        { Effect: 'Deny', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: `${BUCKET}/customer-*` },
      ],
    });
    expect((await run(prefix)).passed).toBe(true);
  });
});

// -------------------------------------------------------------- adversarial

describe('AWS-003 — adversarial attempts', () => {
  it('1. adding an Allow while leaving the conflicting Deny does not pass', async () => {
    const result = await run(JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        ...(JSON.parse(STARTER) as { Statement: unknown[] }).Statement,
        { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'], Resource: [BUCKET, `${BUCKET}/*`] },
      ],
    }));
    expect(result.passed).toBe(false);
  });

  it('2. deleting the Deny outright re-exposes customer exports', async () => {
    const noDeny = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: 's3:ListBucket', Resource: BUCKET },
        { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: `${BUCKET}/*` },
      ],
    });
    const result = await run(noDeny);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('Customer exports cannot be read');
    expect(failed(result.checks)).toContain(
      'Customer exports are protected by an explicit Deny, not merely by omission',
    );
  });

  it('3. a wildcard Action does not pass', async () => {
    const result = await run(JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: '*', Resource: [BUCKET, BUILDS] },
        { Effect: 'Deny', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: EXPORTS },
      ],
    }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('No Allow statement uses "*" as its Action');
    // and it over-grants deletion of build artifacts
    expect(failed(result.checks)).toContain('Build artifacts cannot be deleted either');
  });

  it('4. a wildcard Resource does not pass', async () => {
    const result = await run(JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['s3:ListBucket', 's3:GetObject', 's3:PutObject'], Resource: '*' },
        { Effect: 'Deny', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: EXPORTS },
      ],
    }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('No Allow statement uses "*" as its Resource');
  });

  it('5. writing the answer into the incident file changes nothing', async () => {
    const result = await runWith({ [POLICY]: STARTER, [INCIDENT]: SOLVED });
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toHaveLength(3);
  });

  it('7. a second, solved policy file is not the file that is graded', async () => {
    const result = await runWith({
      [POLICY]: STARTER,
      [`${DIR}/policy.solved.json`]: SOLVED,
      [`${DIR}/policy.json.bak`]: SOLVED,
      [INCIDENT]: 'incident text',
    });
    expect(result.passed).toBe(false);
  });

  it('8. another session having solved it does not pass this one', async () => {
    const lab = await loadLabDefinition(AWS_003);
    const a = new FakeSandbox({ [POLICY]: SOLVED, [INCIDENT]: 'x' });
    const b = new FakeSandbox({ [POLICY]: STARTER, [INCIDENT]: 'x' });

    expect((await verifyLab({ lab, sandbox: a, namespace: 'jtt-lab-a' })).passed).toBe(true);
    expect((await verifyLab({ lab, sandbox: b, namespace: 'jtt-lab-b' })).passed).toBe(false);
  });

  it('9. repeated checks are pure and give the same verdict', async () => {
    const first = await run(SOLVED);
    const second = await run(SOLVED);
    expect(first.checks.map((c) => c.status)).toEqual(second.checks.map((c) => c.status));
  });

  it('10. malformed JSON fails without crashing', async () => {
    const result = await run('{"Version":"2012-10-17","Statement":[');
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.status === 'fail')?.detail).toContain('not valid JSON');
  });

  it('11. a statement that reads correctly but evaluates wrongly does not pass', async () => {
    // Deny written with NotResource: it denies everything *except* the exports,
    // which is the exact inverse of what the incident asks for.
    const inverted = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: 's3:ListBucket', Resource: BUCKET },
        { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: BUILDS },
        { Effect: 'Deny', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], NotResource: EXPORTS },
      ],
    });
    const result = await run(inverted);

    expect(result.passed).toBe(false);
    // The inversion denies the builds and leaves the exports merely ungranted:
    // the reads break, and the auditors' explicit Deny no longer covers what it
    // was written to cover.
    expect(failed(result.checks).sort()).toEqual([
      'Customer exports are protected by an explicit Deny, not merely by omission',
      'The developer role may read a build artifact',
      'The developer role may upload a build artifact',
    ]);
  });

  it('12. weakening the Deny until the protected object is reachable does not pass', async () => {
    const weakened = JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: 's3:ListBucket', Resource: BUCKET },
        { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: `${BUCKET}/*` },
        // Deny narrowed to a prefix that does not actually cover the export.
        { Effect: 'Deny', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: `${BUCKET}/customer-exports/archive/*` },
      ],
    });
    const result = await run(weakened);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('Customer exports cannot be read');
  });

  it('refuses a symlink standing in for the policy', async () => {
    const lab = await loadLabDefinition(AWS_003);
    const sandbox: SandboxPort = {
      async read(p: string): Promise<SandboxPathRead | null> {
        if (p !== POLICY) return null;
        return { type: 'symlink', mode: '777', owner: 'student', group: 'student', sizeBytes: 0 };
      },
    };
    const result = await verifyLab({ lab, sandbox, namespace: 'jtt-lab-000000000003' });

    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.status === 'fail')?.detail).toContain('not a regular file');
  });
});
