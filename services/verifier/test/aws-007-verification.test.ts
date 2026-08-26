/**
 * AWS-007 — verification behaviour.
 *
 * The property that matters most here is the one an answer-key grader cannot
 * have: **two different, equally valid plans both pass.** Everything else in
 * this file exists to show that the arithmetic is real — that a subnet one
 * address outside the VPC fails, that overlap is detected wherever it is, and
 * that capacity is counted after the five addresses AWS reserves, not before.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type SandboxPathRead } from '@jumptotech/lab-orchestrator';
import { verifyLab, type SandboxPort } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const AWS_007 = path.join(LABS_DIR, 'aws', 'aws-007-vpc-cidr-plan', 'lab.yaml');
const TEMPLATE = '/home/student/network/vpc.yaml';

interface Plan {
  vpc: string;
  publicA: string;
  publicB: string;
  privateA: string;
  privateB: string;
  azA?: string;
  azB?: string;
  publicMap?: string;
  privateMap?: string;
}

/** Render a plan as the template a student would leave behind. */
function template(plan: Plan): string {
  const azA = plan.azA ?? 'eu-west-1a';
  const azB = plan.azB ?? 'eu-west-1b';
  const pub = plan.publicMap ?? 'true';
  const priv = plan.privateMap ?? 'false';
  return `AWSTemplateFormatVersion: '2010-09-09'
Description: address plan
Resources:
  Vpc:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: ${plan.vpc}
  PublicSubnetA:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: ${plan.publicA}
      AvailabilityZone: ${azA}
      MapPublicIpOnLaunch: ${pub}
  PublicSubnetB:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: ${plan.publicB}
      AvailabilityZone: ${azB}
      MapPublicIpOnLaunch: ${pub}
  PrivateSubnetA:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: ${plan.privateA}
      AvailabilityZone: ${azA}
      MapPublicIpOnLaunch: ${priv}
  PrivateSubnetB:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: ${plan.privateB}
      AvailabilityZone: ${azB}
      MapPublicIpOnLaunch: ${priv}
Outputs:
  VpcId:
    Value: !Ref Vpc
`;
}

/** A plan that satisfies R1-R9. Used as the base for targeted breakage. */
const GOOD: Plan = {
  vpc: '10.0.0.0/16',
  publicA: '10.0.0.0/24',
  publicB: '10.0.1.0/24',
  privateA: '10.0.16.0/20',
  privateB: '10.0.32.0/20',
};

/** The draft the sandbox is seeded with, copied from setup/seed.sh. */
const SEEDED = `AWSTemplateFormatVersion: '2010-09-09'
Description: Payments platform VPC - address plan, first draft.

Resources:
  Vpc:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: 192.168.0.0/24
      EnableDnsSupport: true
      EnableDnsHostnames: true
      Tags:
        - Key: Name
          Value: payments

  PublicSubnetA:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 192.168.0.0/25
      AvailabilityZone: eu-west-1a
      MapPublicIpOnLaunch: true

  PublicSubnetB:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 192.168.0.128/25
      AvailabilityZone: eu-west-1a
      MapPublicIpOnLaunch: true

  PrivateSubnetA:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 192.168.0.64/26
      AvailabilityZone: eu-west-1a

  PrivateSubnetB:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 192.168.1.0/24
      AvailabilityZone: eu-west-1b

Outputs:
  VpcId:
    Value: !Ref Vpc
`;

class FakeSandbox implements SandboxPort {
  constructor(private readonly entries: Record<string, string>) {}
  async read(p: string): Promise<SandboxPathRead | null> {
    const content = this.entries[p];
    if (content === undefined) return null;
    return { type: 'file', mode: '644', owner: 'student', group: 'student', sizeBytes: content.length, content };
  }
}

async function runRaw(templateText: string, extra: Record<string, string> = {}) {
  const lab = await loadLabDefinition(AWS_007);
  const sandbox = new FakeSandbox({
    [TEMPLATE]: templateText,
    '/home/student/network/network-requirements.txt': 'requirements',
    ...extra,
  });
  return verifyLab({ lab, sandbox, namespace: 'jtt-lab-000000000007' });
}
const run = (plan: Plan) => runRaw(template(plan));
const failed = (c: Array<{ status: string; label: string }>) => c.filter((x) => x.status === 'fail').map((x) => x.label);

describe('AWS-007 — the seeded draft does not pass', () => {
  it('fails every rule the review complained about', async () => {
    const result = await runRaw(SEEDED);
    expect(result.passed).toBe(false);
    const labels = failed(result.checks);

    expect(labels).toContain('R1, R2 — the VPC uses a private range large enough to grow into');
    expect(labels).toContain('R3 — every subnet lies inside the VPC');
    expect(labels).toContain('R4 — no two subnets cover the same address');
    expect(labels).toContain('R9 — at least half the VPC is left unallocated');
    expect(labels).toContain('R7 — the public subnets are in different Availability Zones');
    expect(labels).toContain('R8 — PrivateSubnetA does not give instances a public address');
    expect(labels).toContain('R6 — PrivateSubnetA can assign at least 4,091 addresses');
  });

  it('still recognises it as a template, so the student is not told to start over', async () => {
    const result = await runRaw(SEEDED);
    const passing = result.checks.filter((c) => c.status === 'pass').map((c) => c.label);
    expect(passing).toContain('The plan is still a valid CloudFormation template');
    expect(passing).toContain('PublicSubnetA is declared');
    expect(passing).toContain('Every reference in the template resolves');
  });

  it('never names a range the student is meant to choose', async () => {
    const blob = (await runRaw(SEEDED)).checks.map((c) => `${c.label} ${c.detail ?? ''}`).join('\n');
    // Detail may quote what the student wrote; it must not quote a solution.
    expect(blob).not.toMatch(/10\.0\.\d+\.\d+/);
    expect(blob).not.toMatch(/172\.16\./);
    expect(blob).not.toContain('/20');
  });
});

describe('AWS-007 — any plan that satisfies the requirements passes', () => {
  it('passes the reference plan', async () => {
    const result = await run(GOOD);
    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes a completely different, equally valid plan', async () => {
    // Different RFC 1918 block, different sizes, subnets in a different order
    // of the range — nothing in common with GOOD except being correct.
    const result = await run({
      vpc: '172.20.0.0/16',
      publicA: '172.20.240.0/23',
      publicB: '172.20.242.0/23',
      privateA: '172.20.64.0/19',
      privateB: '172.20.96.0/19',
      azA: 'eu-west-1b',
      azB: 'eu-west-1c',
    });
    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes a third plan in the 192.168 range', async () => {
    const result = await run({
      vpc: '192.168.0.0/16',
      publicA: '192.168.1.0/24',
      publicB: '192.168.2.0/24',
      privateA: '192.168.16.0/20',
      privateB: '192.168.48.0/20',
    });
    expect(result.passed).toBe(true);
  });

  it('accepts a CIDR written with host bits set, as AWS does', async () => {
    // The VPC guide canonicalises 100.68.0.18/18 to 100.68.0.0/18; a student
    // who writes 10.0.16.7/20 has still allocated 10.0.16.0/20.
    const result = await run({ ...GOOD, privateA: '10.0.16.7/20' });
    expect(result.passed).toBe(true);
  });

  it('does not care about resource order, property order, or quoting', async () => {
    const reordered = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  PrivateSubnetB:
    Properties:
      MapPublicIpOnLaunch: false
      AvailabilityZone: "eu-west-1b"
      CidrBlock: "10.0.32.0/20"
      VpcId: !Ref Vpc
    Type: AWS::EC2::Subnet
  PrivateSubnetA:
    Type: "AWS::EC2::Subnet"
    Properties:
      CidrBlock: 10.0.16.0/20
      VpcId: {"Ref": "Vpc"}
      MapPublicIpOnLaunch: false
      AvailabilityZone: eu-west-1a
  PublicSubnetB:
    Type: AWS::EC2::Subnet
    Properties: {VpcId: !Ref Vpc, CidrBlock: 10.0.1.0/24, AvailabilityZone: eu-west-1b, MapPublicIpOnLaunch: true}
  PublicSubnetA:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.0.0.0/24
      AvailabilityZone: eu-west-1a
      MapPublicIpOnLaunch: true
  Vpc:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: 10.0.0.0/16
`;
    const result = await runRaw(reordered);
    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });
});

describe('AWS-007 — the arithmetic is real', () => {
  it('rejects a subnet one address outside the VPC', async () => {
    // 10.0.0.0/16 ends at 10.0.255.255; this starts at 10.1.0.0.
    const result = await run({ ...GOOD, privateB: '10.1.0.0/20' });
    expect(failed(result.checks)).toContain('R3 — every subnet lies inside the VPC');
    expect(result.passed).toBe(false);
  });

  it('accepts subnets that sit exactly at both edges of the VPC', async () => {
    const result = await run({
      ...GOOD,
      publicA: '10.0.0.0/24',
      privateB: '10.0.240.0/20',
    });
    expect(result.passed).toBe(true);
  });

  it('detects overlap even when neither range starts at the other', async () => {
    // 10.0.16.0/20 covers 10.0.16.0-10.0.31.255; this lands in the middle.
    const result = await run({ ...GOOD, publicB: '10.0.24.0/24' });
    expect(failed(result.checks)).toContain('R4 — no two subnets cover the same address');
  });

  it('detects a subnet nested wholly inside another', async () => {
    const result = await run({ ...GOOD, publicB: '10.0.16.0/24' });
    expect(failed(result.checks)).toContain('R4 — no two subnets cover the same address');
  });

  it('counts capacity after the five addresses AWS reserves', async () => {
    // A /24 holds 256 and offers 251 — exactly the R5 floor, so it passes.
    expect((await run({ ...GOOD, publicA: '10.0.0.0/24' })).passed).toBe(true);
    // A /25 holds 128 and offers 123, so it does not.
    const tight = await run({ ...GOOD, publicA: '10.0.0.0/25' });
    expect(failed(tight.checks)).toContain('R5 — PublicSubnetA can assign at least 251 addresses');
    // A /20 holds 4,096 and offers 4,091 — exactly the R6 floor.
    expect((await run(GOOD)).passed).toBe(true);
    // A /21 holds 2,048 and offers 2,043, which is short.
    const short = await run({ ...GOOD, privateA: '10.0.16.0/21' });
    expect(failed(short.checks)).toContain('R6 — PrivateSubnetA can assign at least 4,091 addresses');
  });

  it('explains a capacity failure in terms of assignable addresses', async () => {
    const result = await run({ ...GOOD, privateA: '10.0.16.0/21' });
    const detail = result.checks.find((c) => c.label.startsWith('R6 — PrivateSubnetA'))?.detail ?? '';
    expect(detail).toContain('2043');
    expect(detail).toContain('5');
  });

  it('requires the VPC to be big enough to grow into', async () => {
    // A /20 VPC is a valid VPC, and cannot hold what R2 asks for.
    const result = await run({
      vpc: '10.0.0.0/20',
      publicA: '10.0.0.0/24',
      publicB: '10.0.1.0/24',
      privateA: '10.0.2.0/24',
      privateB: '10.0.3.0/24',
    });
    expect(failed(result.checks)).toContain('R1, R2 — the VPC uses a private range large enough to grow into');
  });

  it('rejects a publicly routable VPC range', async () => {
    const result = await run({
      vpc: '54.0.0.0/16',
      publicA: '54.0.0.0/24',
      publicB: '54.0.1.0/24',
      privateA: '54.0.16.0/20',
      privateB: '54.0.32.0/20',
    });
    expect(failed(result.checks)).toContain('R1, R2 — the VPC uses a private range large enough to grow into');
  });

  it('rejects a plan that consumes too much of the VPC to grow', async () => {
    // Four /18s tile the whole /16: every rule but R9 is satisfied.
    const result = await run({
      vpc: '10.0.0.0/16',
      publicA: '10.0.0.0/18',
      publicB: '10.0.64.0/18',
      privateA: '10.0.128.0/18',
      privateB: '10.0.192.0/18',
    });
    expect(failed(result.checks)).toEqual(['R9 — at least half the VPC is left unallocated']);
  });

  it('accepts a plan that uses exactly half, leaving exactly half', async () => {
    // 16,384 + 8,192 + 4,096 + 4,096 = 32,768, which is half of a /16.
    const result = await run({
      vpc: '10.0.0.0/16',
      privateA: '10.0.0.0/18',
      privateB: '10.0.64.0/19',
      publicA: '10.0.96.0/20',
      publicB: '10.0.112.0/20',
    });
    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });
});

describe('AWS-007 — malformed input fails safely', () => {
  it.each([
    ['10.0.0.0', 'no prefix'],
    ['10.0.0.0/33', 'impossible prefix'],
    ['10.0.0.256/24', 'impossible octet'],
    ['not-a-cidr', 'not an address at all'],
    ['10.0.0.0/24 ', 'trailing space'],
  ])('rejects a VPC CIDR of %s (%s) without throwing', async (value) => {
    const result = await run({ ...GOOD, vpc: value });
    expect(result.passed).toBe(false);
    expect(result.checks.every((c) => c.status === 'pass' || c.status === 'fail')).toBe(true);
  });

  it('rejects an IPv6 block where an IPv4 block is required', async () => {
    const result = await run({ ...GOOD, privateA: '2001:db8::/32' });
    expect(failed(result.checks)).toContain('R6 — PrivateSubnetA can assign at least 4,091 addresses');
  });

  it('fails cleanly when a CIDR is an intrinsic rather than a literal', async () => {
    const withRef = template(GOOD).replace('CidrBlock: 10.0.16.0/20', 'CidrBlock: !Ref SomeParameter');
    const result = await runRaw(withRef);
    expect(result.passed).toBe(false);
    const detail = result.checks.find((c) => c.label.startsWith('R6 — PrivateSubnetA'))?.detail ?? '';
    expect(detail).toContain('intrinsic');
  });

  it('fails cleanly when the template is not a template at all', async () => {
    const result = await runRaw('this: is\njust: yaml\n');
    expect(result.passed).toBe(false);
    expect(result.checks.some((c) => c.status === 'fail')).toBe(true);
  });

  it('fails cleanly when the file is missing entirely', async () => {
    const lab = await loadLabDefinition(AWS_007);
    const sandbox = new FakeSandbox({});
    const result = await verifyLab({ lab, sandbox, namespace: 'jtt-lab-000000000007' });
    expect(result.passed).toBe(false);
  });
});

describe('AWS-007 — shortcuts do not work', () => {
  it('is not passed by a file claiming the plan is correct', async () => {
    const result = await runRaw(SEEDED, {
      '/home/student/network/PASS': 'ok',
      '/home/student/network/result.json': '{"passed":true}',
      '/home/student/network/vpc.yaml.reviewed': 'approved',
    });
    expect(result.passed).toBe(false);
  });

  it('is not passed by writing the requirements into the template as comments', async () => {
    const commented = `# R1 satisfied
# R2 satisfied: 65536 addresses
# R9 satisfied: 50% free
${SEEDED}`;
    expect((await runRaw(commented)).passed).toBe(false);
  });

  it('is not passed by a wide-open plan that ignores the tiers', async () => {
    // One range for everything: contained and enormous, but overlapping.
    const result = await run({
      vpc: '10.0.0.0/16',
      publicA: '10.0.0.0/16',
      publicB: '10.0.0.0/16',
      privateA: '10.0.0.0/16',
      privateB: '10.0.0.0/16',
    });
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('R4 — no two subnets cover the same address');
    expect(failed(result.checks)).toContain('R9 — at least half the VPC is left unallocated');
  });

  it('is not passed by declaring public subnets private', async () => {
    const result = await run({ ...GOOD, publicMap: 'false' });
    expect(failed(result.checks)).toContain('R8 — PublicSubnetA gives instances a public address');
  });

  it('is not passed by putting both subnets of a tier in one AZ', async () => {
    const result = await run({ ...GOOD, azA: 'eu-west-1a', azB: 'eu-west-1a' });
    expect(failed(result.checks)).toContain('R7 — the public subnets are in different Availability Zones');
    expect(failed(result.checks)).toContain('R7 — the private subnets are in different Availability Zones');
  });

  it('returns the same verdict however many times it is run', async () => {
    const first = await run(GOOD);
    const second = await run(GOOD);
    const third = await runRaw(SEEDED);
    const fourth = await runRaw(SEEDED);
    expect(second.checks.map((c) => c.status)).toEqual(first.checks.map((c) => c.status));
    expect(fourth.checks.map((c) => c.status)).toEqual(third.checks.map((c) => c.status));
    expect(first.passed).toBe(true);
    expect(third.passed).toBe(false);
  });

  it('is not passed by another session having solved it', async () => {
    const lab = await loadLabDefinition(AWS_007);
    const solved = new FakeSandbox({ [TEMPLATE]: template(GOOD) });
    const unsolved = new FakeSandbox({ [TEMPLATE]: SEEDED });
    expect((await verifyLab({ lab, sandbox: solved, namespace: 'jtt-lab-00000000aaaa' })).passed).toBe(true);
    expect((await verifyLab({ lab, sandbox: unsolved, namespace: 'jtt-lab-00000000bbbb' })).passed).toBe(false);
  });
});
