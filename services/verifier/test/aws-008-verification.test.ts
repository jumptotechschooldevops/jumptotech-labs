/**
 * AWS-008 — verification behaviour.
 *
 * The lab's whole subject is a layout property that no single resource holds:
 * a zone is only useful if *both* of its tiers are in it, and the design is
 * only planned-for if it lands on exactly two zones. So the interesting
 * failures here are the ones that look right resource by resource and are
 * wrong across the set — a second zone whose two subnets drifted apart, and a
 * third zone that nobody asked for.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type SandboxPathRead } from '@jumptotech/lab-orchestrator';
import { verifyLab, type SandboxPort } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const AWS_008 = path.join(LABS_DIR, 'aws', 'aws-008-two-az-subnets', 'lab.yaml');
const TEMPLATE = '/home/student/network/vpc.yaml';

/** The deployed single-zone VPC the sandbox is seeded with. */
const SEEDED = `AWSTemplateFormatVersion: '2010-09-09'
Description: Payments platform VPC - deployed, single zone.

Resources:
  Vpc:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: 10.42.0.0/16
      EnableDnsSupport: true
      EnableDnsHostnames: true
      Tags:
        - Key: Name
          Value: payments

  PublicSubnetA:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.42.0.0/24
      AvailabilityZone: eu-west-1a
      MapPublicIpOnLaunch: true

  PrivateSubnetA:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.42.16.0/20
      AvailabilityZone: eu-west-1a
      MapPublicIpOnLaunch: false

Outputs:
  VpcId:
    Value: !Ref Vpc
  PublicSubnetAId:
    Value: !Ref PublicSubnetA
  PrivateSubnetAId:
    Value: !Ref PrivateSubnetA
`;

interface Zone {
  publicCidr?: string;
  privateCidr?: string;
  publicAz?: string;
  privateAz?: string;
  publicMap?: string;
  privateMap?: string;
  publicVpc?: string;
  privateVpc?: string;
  outputs?: string;
}

/** Append a second zone to the seeded template. */
function withSecondZone(zone: Zone = {}): string {
  const {
    publicCidr = '10.42.1.0/24',
    privateCidr = '10.42.32.0/20',
    publicAz = 'eu-west-1b',
    privateAz = 'eu-west-1b',
    publicMap = 'true',
    privateMap = 'false',
    publicVpc = '!Ref Vpc',
    privateVpc = '!Ref Vpc',
    outputs = `  PublicSubnetBId:
    Value: !Ref PublicSubnetB
  PrivateSubnetBId:
    Value: !Ref PrivateSubnetB
`,
  } = zone;

  const resources = `
  PublicSubnetB:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: ${publicVpc}
      CidrBlock: ${publicCidr}
      AvailabilityZone: ${publicAz}
      MapPublicIpOnLaunch: ${publicMap}

  PrivateSubnetB:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: ${privateVpc}
      CidrBlock: ${privateCidr}
      AvailabilityZone: ${privateAz}
      MapPublicIpOnLaunch: ${privateMap}
`;

  const outputsAt = SEEDED.indexOf('Outputs:');
  // Strip only the leading newline: the two-space indent is load-bearing.
  return SEEDED.slice(0, outputsAt) + resources.replace(/^\n/, '') + '\n' + SEEDED.slice(outputsAt) + outputs;
}

class FakeSandbox implements SandboxPort {
  constructor(private readonly entries: Record<string, string>) {}
  async read(p: string): Promise<SandboxPathRead | null> {
    const content = this.entries[p];
    if (content === undefined) return null;
    return { type: 'file', mode: '644', owner: 'student', group: 'student', sizeBytes: content.length, content };
  }
}

async function runRaw(templateText: string, extra: Record<string, string> = {}) {
  const lab = await loadLabDefinition(AWS_008);
  const sandbox = new FakeSandbox({
    [TEMPLATE]: templateText,
    '/home/student/network/incident-4471.txt': 'incident',
    ...extra,
  });
  return verifyLab({ lab, sandbox, namespace: 'jtt-lab-000000000008' });
}
const run = (zone?: Zone) => runRaw(withSecondZone(zone));
const failed = (c: Array<{ status: string; label: string }>) => c.filter((x) => x.status === 'fail').map((x) => x.label);

describe('AWS-008 — the deployed single-zone VPC does not pass', () => {
  it('fails everything the second zone was supposed to bring', async () => {
    const result = await runRaw(SEEDED);
    expect(result.passed).toBe(false);
    const labels = failed(result.checks);

    expect(labels).toContain('A1 — PublicSubnetB is declared');
    expect(labels).toContain('A1 — PrivateSubnetB is declared');
    expect(labels).toContain('A3 — the design uses exactly two Availability Zones');
    expect(labels).toContain('A7 — PublicSubnetBId is published and identifies PublicSubnetB');
    expect(labels).toContain('A7 — PrivateSubnetBId is published and identifies PrivateSubnetB');
  });

  it('does not blame the parts that are already correct', async () => {
    const passing = (await runRaw(SEEDED)).checks.filter((c) => c.status === 'pass').map((c) => c.label);
    // The first zone is deployed and fine; the addressing is fine.
    expect(passing).toContain("A2 — the first zone's public and private subnets are in one zone");
    expect(passing).toContain('Every reference in the template resolves');
  });

  it('never names a zone or a range the student has to choose', async () => {
    const blob = (await runRaw(SEEDED)).checks.map((c) => `${c.label} ${c.detail ?? ''}`).join('\n');
    expect(blob).not.toContain('eu-west-1b');
    expect(blob).not.toContain('10.42.1.0');
    expect(blob).not.toContain('10.42.32.0');
  });
});

describe('AWS-008 — a correct second zone passes', () => {
  it('passes the reference solution', async () => {
    const result = await run();
    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes an alternate solution using a different zone and different ranges', async () => {
    const result = await run({
      publicAz: 'eu-west-1c',
      privateAz: 'eu-west-1c',
      publicCidr: '10.42.8.0/23',
      privateCidr: '10.42.64.0/19',
    });
    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('accepts the long-form spelling of Ref and a CIDR with host bits set', async () => {
    const result = await run({
      publicVpc: '{"Ref": "Vpc"}',
      privateVpc: '{"Ref": "Vpc"}',
      privateCidr: '10.42.32.9/20',
    });
    expect(result.passed).toBe(true);
  });

  it('does not care about resource or property order', async () => {
    const reordered = withSecondZone().replace(
      `      VpcId: !Ref Vpc
      CidrBlock: 10.42.1.0/24
      AvailabilityZone: eu-west-1b
      MapPublicIpOnLaunch: true`,
      `      MapPublicIpOnLaunch: true
      AvailabilityZone: eu-west-1b
      CidrBlock: 10.42.1.0/24
      VpcId: !Ref Vpc`,
    );
    expect((await runRaw(reordered)).passed).toBe(true);
  });
});

describe('AWS-008 — the zone layout is graded across the set', () => {
  it('rejects a second zone whose tiers drifted apart', async () => {
    // Each subnet is individually fine. Neither zone can serve on its own.
    const result = await run({ publicAz: 'eu-west-1b', privateAz: 'eu-west-1c' });
    expect(failed(result.checks)).toContain(
      "A2 — the second zone's public and private subnets are in one zone",
    );
    expect(failed(result.checks)).toContain('A3 — the design uses exactly two Availability Zones');
    expect(result.passed).toBe(false);
  });

  it('rejects a third zone even when every pair is internally consistent', async () => {
    // A2 holds for both zones; there are simply three zones in play.
    const threeZones = withSecondZone().replace(
      '  PrivateSubnetA:\n    Type: AWS::EC2::Subnet\n    Properties:\n      VpcId: !Ref Vpc\n      CidrBlock: 10.42.16.0/20\n      AvailabilityZone: eu-west-1a',
      '  PrivateSubnetA:\n    Type: AWS::EC2::Subnet\n    Properties:\n      VpcId: !Ref Vpc\n      CidrBlock: 10.42.16.0/20\n      AvailabilityZone: eu-west-1c',
    );
    const result = await runRaw(threeZones);
    expect(failed(result.checks)).toContain('A3 — the design uses exactly two Availability Zones');
  });

  it('rejects a second zone that is really the first zone again', async () => {
    const result = await run({ publicAz: 'eu-west-1a', privateAz: 'eu-west-1a' });
    const labels = failed(result.checks);
    expect(labels).toContain('A1 — the public subnets are in different Availability Zones');
    expect(labels).toContain('A1 — the private subnets are in different Availability Zones');
    expect(labels).toContain('A3 — the design uses exactly two Availability Zones');
  });

  it('says how many zones it found, without naming the one to use', async () => {
    const result = await run({ publicAz: 'eu-west-1a', privateAz: 'eu-west-1a' });
    const detail = result.checks.find((c) => c.label.startsWith('A3'))?.detail ?? '';
    expect(detail).toContain('1 different value');
    expect(detail).not.toContain('eu-west-1b');
  });
});

describe('AWS-008 — addressing is still graded', () => {
  it('rejects a new subnet that overlaps a deployed one', async () => {
    const result = await run({ privateCidr: '10.42.16.0/20' });
    expect(failed(result.checks)).toContain('A5 — the new subnets do not overlap the deployed ones');
  });

  it('rejects a new subnet that overlaps the other new one', async () => {
    const result = await run({ publicCidr: '10.42.32.0/24' });
    expect(failed(result.checks)).toContain('A5 — the new subnets do not overlap the deployed ones');
  });

  it('rejects a new subnet outside the VPC', async () => {
    const result = await run({ privateCidr: '10.43.0.0/20' });
    expect(failed(result.checks)).toContain('A5 — every subnet lies inside the VPC');
  });

  it('rejects a second zone sized below its counterpart', async () => {
    const small = await run({ privateCidr: '10.42.32.0/24', publicCidr: '10.42.1.0/25' });
    const labels = failed(small.checks);
    expect(labels).toContain('A4 — PrivateSubnetB can assign at least 4,091 addresses');
    expect(labels).toContain('A4 — PublicSubnetB can assign at least 251 addresses');
  });

  it('rejects a plan that consumes the room left for a third zone', async () => {
    const result = await run({ privateCidr: '10.42.128.0/17' });
    expect(failed(result.checks)).toContain('A5 — at least half the VPC is still unallocated');
  });

  it('fails safely on a malformed CIDR', async () => {
    const result = await run({ publicCidr: '10.42.1.0/99' });
    expect(result.passed).toBe(false);
    expect(result.checks.every((c) => c.status === 'pass' || c.status === 'fail')).toBe(true);
  });
});

describe('AWS-008 — the second zone has to be usable', () => {
  it('rejects a private subnet declared public', async () => {
    const result = await run({ privateMap: 'true' });
    expect(failed(result.checks)).toContain(
      'A6 — PrivateSubnetB does not give instances a public address',
    );
  });

  it('rejects a public subnet that omits the attribute entirely', async () => {
    const missing = withSecondZone().replace('      MapPublicIpOnLaunch: true\n\n  PrivateSubnetB:', '\n  PrivateSubnetB:');
    expect((await runRaw(missing)).passed).toBe(false);
  });

  it('rejects subnets attached to something other than this VPC', async () => {
    const result = await run({ publicVpc: 'vpc-01234567890abcdef', privateVpc: 'vpc-01234567890abcdef' });
    const labels = failed(result.checks);
    expect(labels).toContain('PublicSubnetB belongs to this VPC');
    expect(labels).toContain('PrivateSubnetB belongs to this VPC');
  });

  it('rejects missing outputs even when the subnets are perfect', async () => {
    const result = await run({ outputs: '' });
    const labels = failed(result.checks);
    expect(labels).toContain('A7 — PublicSubnetBId is published and identifies PublicSubnetB');
    expect(labels).toContain('A7 — PrivateSubnetBId is published and identifies PrivateSubnetB');
  });

  it('rejects an output that names one subnet and returns another', async () => {
    // The failure platform-notes.txt warns about: instances sent to the wrong zone.
    const result = await run({
      outputs: `  PublicSubnetBId:
    Value: !Ref PublicSubnetA
  PrivateSubnetBId:
    Value: !Ref PrivateSubnetA
`,
    });
    const labels = failed(result.checks);
    expect(labels).toContain('A7 — PublicSubnetBId is published and identifies PublicSubnetB');
    expect(labels).toContain('A7 — PrivateSubnetBId is published and identifies PrivateSubnetB');
  });
});

describe('AWS-008 — shortcuts do not work', () => {
  it('is not passed by evidence files claiming success', async () => {
    const result = await runRaw(SEEDED, {
      '/home/student/network/PASS': 'ok',
      '/home/student/network/result.json': '{"passed":true}',
      '/home/student/network/vpc.yaml.approved': 'signed off',
    });
    expect(result.passed).toBe(false);
  });

  it('is not passed by describing the second zone in comments', async () => {
    const commented = `# PublicSubnetB: 10.42.1.0/24 in eu-west-1b
# PrivateSubnetB: 10.42.32.0/20 in eu-west-1b
# Outputs: PublicSubnetBId, PrivateSubnetBId
${SEEDED}`;
    expect((await runRaw(commented)).passed).toBe(false);
  });

  it('is not passed by renaming the deployed subnets instead of adding new ones', async () => {
    // Moves PrivateSubnetA's identity onto B: two subnets, still one zone.
    const renamed = SEEDED.replace('  PrivateSubnetA:', '  PrivateSubnetB:').replace(
      '    Value: !Ref PrivateSubnetA',
      '    Value: !Ref PrivateSubnetB',
    );
    expect((await runRaw(renamed)).passed).toBe(false);
  });

  it('is not passed by declaring the new subnets as something cheaper', async () => {
    const wrongType = withSecondZone().replace(
      '  PublicSubnetB:\n    Type: AWS::EC2::Subnet',
      '  PublicSubnetB:\n    Type: AWS::EC2::VPC',
    );
    expect(failed((await runRaw(wrongType)).checks)).toContain('A1 — PublicSubnetB is declared');
  });

  it('returns the same verdict however many times it runs', async () => {
    const a = await runRaw(SEEDED);
    const b = await runRaw(SEEDED);
    const c = await run();
    const d = await run();
    expect(b.checks.map((x) => x.status)).toEqual(a.checks.map((x) => x.status));
    expect(d.checks.map((x) => x.status)).toEqual(c.checks.map((x) => x.status));
    expect(a.passed).toBe(false);
    expect(c.passed).toBe(true);
  });

  it('is not passed by another session having solved it', async () => {
    const lab = await loadLabDefinition(AWS_008);
    const solved = new FakeSandbox({ [TEMPLATE]: withSecondZone() });
    const unsolved = new FakeSandbox({ [TEMPLATE]: SEEDED });
    expect((await verifyLab({ lab, sandbox: solved, namespace: 'jtt-lab-00000000aaaa' })).passed).toBe(true);
    expect((await verifyLab({ lab, sandbox: unsolved, namespace: 'jtt-lab-00000000bbbb' })).passed).toBe(false);
  });
});
