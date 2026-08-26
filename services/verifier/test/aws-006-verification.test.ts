/**
 * AWS-006 — verification behaviour.
 *
 * The lab grades an investigation's *conclusions*, never how they were reached.
 * Nothing here reads a shell history, and the evidence contains several events
 * that look like the answer — so most of these tests are about the ways a
 * plausible-but-wrong reading of the trail must fail.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type SandboxPathRead } from '@jumptotech/lab-orchestrator';
import { verifyLab, type SandboxPort } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const AWS_006 = path.join(LABS_DIR, 'aws', 'aws-006-cloudtrail-investigation', 'lab.yaml');

const DIR = '/home/student/incident-9214';
const FINDINGS = `${DIR}/findings.env`;

/** Exactly what `setup/seed.sh` writes. */
const SEEDED = `# Incident 9214 — findings
#
# Replace every FILL_ME. Use exactly KEY=value on its own line, with no spaces
# around the '=' sign and nothing after the value.

EVENT_NAME=FILL_ME
EVENT_SOURCE=FILL_ME
EVENT_TIME=FILL_ME
AWS_REGION=FILL_ME
AFFECTED_SECURITY_GROUP=FILL_ME
PRINCIPAL_ARN=FILL_ME
PRINCIPAL_ID=FILL_ME
SOURCE_IP=FILL_ME
OUTCOME=FILL_ME

# The earlier attempt at the same API call that did not succeed.
DENIED_PRINCIPAL_ARN=FILL_ME
DENIED_ERROR_CODE=FILL_ME
`;

const CORRECT: Record<string, string> = {
  EVENT_NAME: 'RevokeSecurityGroupIngress',
  EVENT_SOURCE: 'ec2.amazonaws.com',
  EVENT_TIME: '2026-08-25T03:14:52Z',
  AWS_REGION: 'eu-west-1',
  AFFECTED_SECURITY_GROUP: 'sg-0a1b2c3d4e5f60718',
  PRINCIPAL_ARN: 'arn:aws:sts::123456789012:assumed-role/PlatformDeployRole/deploy-9f31c2',
  PRINCIPAL_ID: 'AROAEXAMPLEROLE00004:deploy-9f31c2',
  SOURCE_IP: '203.0.113.47',
  OUTCOME: 'success',
  DENIED_PRINCIPAL_ARN: 'arn:aws:iam::123456789012:user/priya.raman',
  DENIED_ERROR_CODE: 'Client.UnauthorizedOperation',
};

/** Build a findings sheet, optionally overriding some answers. */
function sheet(overrides: Partial<Record<string, string>> = {}, header = '# Incident 9214 — findings\n\n'): string {
  const merged = { ...CORRECT, ...overrides };
  return header + Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

class FakeSandbox implements SandboxPort {
  constructor(private readonly entries: Record<string, string>) {}
  async read(p: string): Promise<SandboxPathRead | null> {
    const content = this.entries[p];
    if (content === undefined) return null;
    return { type: 'file', mode: '644', owner: 'student', group: 'student', sizeBytes: content.length, content };
  }
}

async function run(findings: string | null) {
  const lab = await loadLabDefinition(AWS_006);
  const entries: Record<string, string> = {};
  if (findings !== null) entries[FINDINGS] = findings;
  return verifyLab({ lab, sandbox: new FakeSandbox(entries), namespace: 'jtt-lab-000000000006' });
}
const failed = (c: Array<{ status: string; label: string }>) => c.filter((x) => x.status === 'fail').map((x) => x.label);

// -------------------------------------------------------- starting state

describe('AWS-006 — the untouched sheet does not pass', () => {
  it('fails every conclusion before the investigation is done', async () => {
    const result = await run(SEEDED);

    expect(result.passed).toBe(false);
    // 11 conclusions plus the "no placeholders left" check.
    expect(failed(result.checks)).toHaveLength(12);
  });

  it('does not disclose a single expected answer in any check output', async () => {
    const result = await run(SEEDED);
    const blob = result.checks.map((c) => `${c.label} ${c.detail ?? ''}`).join('\n');

    for (const [key, value] of Object.entries(CORRECT)) {
      expect(blob, `${key} leaked`).not.toContain(value);
    }
  });
});

// ----------------------------------------------------- correct investigation

describe('AWS-006 — a correct investigation passes', () => {
  it('passes when every conclusion is right', async () => {
    const result = await run(sheet());
    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('accepts a differently arranged sheet with the same conclusions', async () => {
    const reordered = [
      '# my working notes',
      '',
      'DENIED_ERROR_CODE=Client.UnauthorizedOperation',
      'DENIED_PRINCIPAL_ARN=arn:aws:iam::123456789012:user/priya.raman',
      '',
      '# the call that did it',
      'OUTCOME=success',
      'SOURCE_IP=203.0.113.47',
      'PRINCIPAL_ID=AROAEXAMPLEROLE00004:deploy-9f31c2',
      'PRINCIPAL_ARN=arn:aws:sts::123456789012:assumed-role/PlatformDeployRole/deploy-9f31c2',
      'AFFECTED_SECURITY_GROUP=sg-0a1b2c3d4e5f60718',
      'AWS_REGION=eu-west-1',
      'EVENT_TIME=2026-08-25T03:14:52Z',
      'EVENT_SOURCE=ec2.amazonaws.com',
      'EVENT_NAME=RevokeSecurityGroupIngress',
      '',
    ].join('\n');

    expect((await run(reordered)).passed).toBe(true);
  });
});

// ------------------------------------------------- plausible wrong readings

describe('AWS-006 — plausible misreadings of the trail fail', () => {
  it('fails when the refused attempt is reported as the cause', async () => {
    // Same eventName, earlier, different person, and it changed nothing.
    const result = await run(sheet({
      EVENT_TIME: '2026-08-25T03:08:19Z',
      PRINCIPAL_ARN: 'arn:aws:iam::123456789012:user/priya.raman',
      PRINCIPAL_ID: 'AIDAEXAMPLEUSER00003',
      SOURCE_IP: '198.51.100.23',
      OUTCOME: 'failure',
    }));

    expect(result.passed).toBe(false);
    expect(failed(result.checks).sort()).toEqual([
      'The address the request came from is identified',
      'The call is correctly reported as having succeeded',
      'The principal that made the call is identified by its full ARN',
      'The principalId CloudTrail recorded for that identity is captured',
      'The time of the call is recorded exactly as CloudTrail has it',
    ]);
  });

  it('fails when the wrong API action is chosen', async () => {
    // AuthorizeSecurityGroupIngress also appears, twice.
    const result = await run(sheet({ EVENT_NAME: 'AuthorizeSecurityGroupIngress' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The API call that caused the outage is identified']);
  });

  it('fails when the decoy security group is chosen', async () => {
    const result = await run(sheet({ AFFECTED_SECURITY_GROUP: 'sg-0fedcba987654321' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The security group that was changed is identified']);
  });

  it('fails when a different identity from the same night is named', async () => {
    const result = await run(sheet({
      PRINCIPAL_ARN: 'arn:aws:sts::123456789012:assumed-role/ReadOnlyAuditRole/audit-nightly',
      PRINCIPAL_ID: 'AROAEXAMPLEROLE00002:audit-nightly',
    }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toHaveLength(2);
  });

  it('fails when the role ARN is given instead of the session ARN', async () => {
    // sessionContext.sessionIssuer.arn is the role; the caller is the session.
    const result = await run(sheet({ PRINCIPAL_ARN: 'arn:aws:iam::123456789012:role/PlatformDeployRole' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The principal that made the call is identified by its full ARN']);
  });

  it('fails when the ARN is repeated instead of the principalId', async () => {
    const result = await run(sheet({ PRINCIPAL_ID: CORRECT.PRINCIPAL_ARN! }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The principalId CloudTrail recorded for that identity is captured']);
  });

  it('fails on a rounded or reformatted timestamp', async () => {
    for (const wrong of ['2026-08-25T03:15:00Z', '2026-08-25 03:14:52', '03:14:52']) {
      const result = await run(sheet({ EVENT_TIME: wrong }));
      expect(result.passed, wrong).toBe(false);
      expect(failed(result.checks)).toContain('The time of the call is recorded exactly as CloudTrail has it');
    }
  });

  it('fails on the wrong source address', async () => {
    const result = await run(sheet({ SOURCE_IP: '198.51.100.23' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The address the request came from is identified']);
  });

  it('fails on the wrong Region or the wrong event source', async () => {
    expect((await run(sheet({ AWS_REGION: 'us-east-1' }))).passed).toBe(false);
    expect((await run(sheet({ EVENT_SOURCE: 'iam.amazonaws.com' }))).passed).toBe(false);
  });

  it('fails when the refused attempt is attributed to the wrong person or error', async () => {
    expect((await run(sheet({ DENIED_PRINCIPAL_ARN: CORRECT.PRINCIPAL_ARN! }))).passed).toBe(false);
    expect((await run(sheet({ DENIED_ERROR_CODE: 'AccessDenied' }))).passed).toBe(false);
  });

  it('fails when the successful call is reported as a failure', async () => {
    const result = await run(sheet({ OUTCOME: 'failure' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The call is correctly reported as having succeeded']);
  });
});

// ------------------------------------------------------ shortcuts and gaps

describe('AWS-006 — shortcuts and missing work', () => {
  it('fails when the findings sheet is missing entirely', async () => {
    const result = await run(null);
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('Every finding has been filled in');
  });

  it('fails when the sheet is emptied rather than answered', async () => {
    expect((await run('')).passed).toBe(false);
  });

  it('fails when one placeholder is left among correct answers', async () => {
    const partial = sheet().replace('SOURCE_IP=203.0.113.47', 'SOURCE_IP=FILL_ME');
    const result = await run(partial);
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('Every finding has been filled in');
  });

  it('fails when the raw CloudTrail record is pasted in as the findings', async () => {
    const pasted = sheet() + '\n' + JSON.stringify({
      eventVersion: '1.11',
      eventName: 'RevokeSecurityGroupIngress',
      eventTime: '2026-08-25T03:14:52Z',
    }, null, 2);
    const result = await run(pasted);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual(['The findings sheet holds conclusions rather than pasted records']);
  });

  it('does not accept a value that is only mentioned in a comment', async () => {
    const commented = SEEDED.replace(
      'EVENT_NAME=FILL_ME',
      '# the answer is EVENT_NAME=RevokeSecurityGroupIngress\nEVENT_NAME=FILL_ME',
    );
    const result = await run(commented);

    // The comment line does satisfy the line-anchored match only if it starts
    // the line, which it does not — it is prefixed by "# the answer is ".
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The API call that caused the outage is identified');
  });

  it('does not let one key satisfy another whose name ends the same way', async () => {
    // DENIED_PRINCIPAL_ARN ends in PRINCIPAL_ARN; line anchoring keeps them apart.
    const onlyDenied = '# notes\nDENIED_PRINCIPAL_ARN=arn:aws:sts::123456789012:assumed-role/PlatformDeployRole/deploy-9f31c2\n';
    const result = await run(onlyDenied);

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The principal that made the call is identified by its full ARN');
  });
});

// ----------------------------------------------------------- isolation

describe('AWS-006 — isolation', () => {
  it('is not passed by another session having solved it', async () => {
    const lab = await loadLabDefinition(AWS_006);
    const a = new FakeSandbox({ [FINDINGS]: sheet() });
    const b = new FakeSandbox({ [FINDINGS]: SEEDED });

    expect((await verifyLab({ lab, sandbox: a, namespace: 'jtt-lab-a' })).passed).toBe(true);
    expect((await verifyLab({ lab, sandbox: b, namespace: 'jtt-lab-b' })).passed).toBe(false);
  });

  it('is not passed by a solved sheet written to a different file', async () => {
    const lab = await loadLabDefinition(AWS_006);
    const sandbox = new FakeSandbox({ [FINDINGS]: SEEDED, [`${DIR}/findings.solved.env`]: sheet() });
    expect((await verifyLab({ lab, sandbox, namespace: 'jtt-lab-x' })).passed).toBe(false);
  });

  it('refuses a symlink standing in for the findings sheet', async () => {
    const lab = await loadLabDefinition(AWS_006);
    const sandbox: SandboxPort = {
      async read(p: string): Promise<SandboxPathRead | null> {
        if (p !== FINDINGS) return null;
        return { type: 'symlink', mode: '777', owner: 'student', group: 'student', sizeBytes: 0 };
      },
    };
    const result = await verifyLab({ lab, sandbox, namespace: 'jtt-lab-x' });

    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.status === 'fail')?.detail).toContain('not a regular file');
  });
});
