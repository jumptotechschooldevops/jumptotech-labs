/**
 * AWS-009 — verification behaviour.
 *
 * Every check in this lab is about a *relationship*, because the thing being
 * taught is that a subnet is public by virtue of what its route table routes
 * to and nothing else. So the tests that matter are the ones where all six
 * resources exist, every name is right, and one edge of the graph points at
 * the wrong node: an unattached gateway, a route in the wrong table, an
 * association to the wrong table, a route to a decoy gateway.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type SandboxPathRead } from '@jumptotech/lab-orchestrator';
import { verifyLab, type SandboxPort } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const AWS_009 = path.join(LABS_DIR, 'aws', 'aws-009-internet-gateway-routing', 'lab.yaml');
const TEMPLATE = '/home/student/network/vpc.yaml';

/** The two-zone VPC with private routing only, as the sandbox seeds it. */
const SEEDED = `AWSTemplateFormatVersion: '2010-09-09'
Description: Payments platform VPC - two zones, private routing only.

Resources:
  Vpc:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: 10.42.0.0/16
      EnableDnsSupport: true
      EnableDnsHostnames: true

  PublicSubnetA:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.42.0.0/24
      AvailabilityZone: eu-west-1a
      MapPublicIpOnLaunch: true

  PublicSubnetB:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.42.1.0/24
      AvailabilityZone: eu-west-1b
      MapPublicIpOnLaunch: true

  PrivateSubnetA:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.42.16.0/20
      AvailabilityZone: eu-west-1a
      MapPublicIpOnLaunch: false

  PrivateSubnetB:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.42.32.0/20
      AvailabilityZone: eu-west-1b
      MapPublicIpOnLaunch: false

  PrivateRouteTable:
    Type: AWS::EC2::RouteTable
    Properties:
      VpcId: !Ref Vpc

  PrivateSubnetARouteTableAssociation:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      SubnetId: !Ref PrivateSubnetA
      RouteTableId: !Ref PrivateRouteTable

  PrivateSubnetBRouteTableAssociation:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      SubnetId: !Ref PrivateSubnetB
      RouteTableId: !Ref PrivateRouteTable

Outputs:
  VpcId:
    Value: !Ref Vpc
`;

interface PublicPath {
  attachVpc?: string;
  attachIgw?: string;
  routeTableVpc?: string;
  routeTable?: string;
  destination?: string;
  target?: string;
  assocASubnet?: string;
  assocATable?: string;
  assocBSubnet?: string;
  assocBTable?: string;
  igwType?: string;
  extra?: string;
}

/** Append the public path to the seeded template, with any edge redirected. */
function withPublicPath(p: PublicPath = {}): string {
  const {
    attachVpc = '!Ref Vpc',
    attachIgw = '!Ref InternetGateway',
    routeTableVpc = '!Ref Vpc',
    routeTable = '!Ref PublicRouteTable',
    destination = '0.0.0.0/0',
    target = '!Ref InternetGateway',
    assocASubnet = '!Ref PublicSubnetA',
    assocATable = '!Ref PublicRouteTable',
    assocBSubnet = '!Ref PublicSubnetB',
    assocBTable = '!Ref PublicRouteTable',
    igwType = 'AWS::EC2::InternetGateway',
    extra = '',
  } = p;

  const added = `  InternetGateway:
    Type: ${igwType}
    Properties: {}

  InternetGatewayAttachment:
    Type: AWS::EC2::VPCGatewayAttachment
    Properties:
      VpcId: ${attachVpc}
      InternetGatewayId: ${attachIgw}

  PublicRouteTable:
    Type: AWS::EC2::RouteTable
    Properties:
      VpcId: ${routeTableVpc}

  PublicDefaultRoute:
    Type: AWS::EC2::Route
    Properties:
      RouteTableId: ${routeTable}
      DestinationCidrBlock: ${destination}
      GatewayId: ${target}

  PublicSubnetARouteTableAssociation:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      SubnetId: ${assocASubnet}
      RouteTableId: ${assocATable}

  PublicSubnetBRouteTableAssociation:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      SubnetId: ${assocBSubnet}
      RouteTableId: ${assocBTable}

${extra}`;

  const outputsAt = SEEDED.indexOf('Outputs:');
  return SEEDED.slice(0, outputsAt) + added + '\n' + SEEDED.slice(outputsAt);
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
  const lab = await loadLabDefinition(AWS_009);
  const sandbox = new FakeSandbox({
    [TEMPLATE]: templateText,
    '/home/student/network/ticket-8830.txt': 'ticket',
    ...extra,
  });
  return verifyLab({ lab, sandbox, namespace: 'jtt-lab-000000000009' });
}
const run = (p?: PublicPath) => runRaw(withPublicPath(p));
const failed = (c: Array<{ status: string; label: string }>) => c.filter((x) => x.status === 'fail').map((x) => x.label);

describe('AWS-009 — the seeded VPC does not pass', () => {
  it('fails every part of the public path', async () => {
    const result = await runRaw(SEEDED);
    expect(result.passed).toBe(false);
    const labels = failed(result.checks);

    expect(labels).toContain('R1 — an internet gateway is declared');
    expect(labels).toContain('R1 — the gateway attachment is declared');
    expect(labels).toContain('R2 — a public route table is declared');
    expect(labels).toContain('R3 — a route is declared');
    expect(labels).toContain('R4 — PublicSubnetA has a route table association');
    expect(labels).toContain('R4 — PublicSubnetB has a route table association');
  });

  it('does not blame the private tier, which is already correct', async () => {
    const passing = (await runRaw(SEEDED)).checks.filter((c) => c.status === 'pass').map((c) => c.label);
    expect(passing).toContain('R5 — PrivateSubnetA is still on the private route table');
    expect(passing).toContain('R5 — PrivateSubnetB is still on the private route table');
    expect(passing).toContain('Every reference in the template resolves');
    expect(passing).toContain('The template is still a valid CloudFormation template');
  });

  it('never states the destination or the resource types the student must find', async () => {
    const blob = (await runRaw(SEEDED)).checks.map((c) => `${c.label} ${c.detail ?? ''}`).join('\n');
    expect(blob).not.toContain('0.0.0.0/0');
    expect(blob).not.toContain('AWS::EC2::InternetGateway');
    expect(blob).not.toContain('AWS::EC2::VPCGatewayAttachment');
    expect(blob).not.toContain('GatewayId');
  });
});

describe('AWS-009 — a correct public path passes', () => {
  it('passes the reference solution', async () => {
    const result = await run();
    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('accepts long-form intrinsics and JSON-style properties', async () => {
    const result = await run({
      attachVpc: '{"Ref": "Vpc"}',
      target: '{"Ref": "InternetGateway"}',
      assocATable: '{"Ref": "PublicRouteTable"}',
    });
    expect(result.passed).toBe(true);
  });

  it('does not care where in the template the new resources are declared', async () => {
    // Put the whole public path *before* the VPC it references.
    const full = withPublicPath();
    const start = full.indexOf('  InternetGateway:');
    const end = full.indexOf('Outputs:');
    const block = full.slice(start, end);
    const reordered = full.slice(0, full.indexOf('  Vpc:')) + block + full.slice(full.indexOf('  Vpc:'), start) + full.slice(end);
    expect((await runRaw(reordered)).passed).toBe(true);
  });

  it('tolerates extra resources that do not interfere', async () => {
    const result = await run({
      extra: `  SpareRouteTable:
    Type: AWS::EC2::RouteTable
    Properties:
      VpcId: !Ref Vpc

`,
    });
    expect(result.passed).toBe(true);
  });
});

describe('AWS-009 — right names, wrong relationships', () => {
  it('fails a gateway that is attached to nothing this template owns', async () => {
    const result = await run({ attachVpc: 'vpc-01234567890abcdef' });
    expect(failed(result.checks)).toContain('R1 — the attachment attaches to this VPC');
    expect(result.passed).toBe(false);
  });

  it('fails an attachment that attaches some other gateway', async () => {
    const result = await run({
      attachIgw: '!Ref DecoyGateway',
      extra: `  DecoyGateway:
    Type: AWS::EC2::InternetGateway
    Properties: {}

`,
    });
    expect(failed(result.checks)).toContain('R1 — the attachment attaches that internet gateway');
  });

  it('fails a route that points at a decoy gateway rather than the attached one', async () => {
    // The classic false pass: everything exists, the route works on paper,
    // and the gateway it targets is not the one attached to the VPC.
    const result = await run({
      target: '!Ref DecoyGateway',
      extra: `  DecoyGateway:
    Type: AWS::EC2::InternetGateway
    Properties: {}

`,
    });
    expect(failed(result.checks)).toContain("R3 — the route's target is the internet gateway");
    expect(result.passed).toBe(false);
  });

  it('fails a route placed in the private route table', async () => {
    const result = await run({ routeTable: '!Ref PrivateRouteTable' });
    expect(failed(result.checks)).toContain('R3 — the route is in the public route table');
  });

  it('fails a public route table that belongs to another VPC', async () => {
    const result = await run({ routeTableVpc: 'vpc-01234567890abcdef' });
    expect(failed(result.checks)).toContain('R2 — the public route table belongs to this VPC');
  });

  it('fails when the public subnets are associated with the private table', async () => {
    const result = await run({ assocATable: '!Ref PrivateRouteTable', assocBTable: '!Ref PrivateRouteTable' });
    const labels = failed(result.checks);
    expect(labels).toContain('R4 — PublicSubnetA is associated with the public route table');
    expect(labels).toContain('R4 — PublicSubnetB is associated with the public route table');
  });

  it('fails when public and private are swapped', async () => {
    // Public subnets left on the private table, private subnets moved to the
    // public one: the exact inversion R5 exists to catch.
    const swapped = withPublicPath({
      assocATable: '!Ref PrivateRouteTable',
      assocBTable: '!Ref PrivateRouteTable',
    })
      .replace(
        '      SubnetId: !Ref PrivateSubnetA\n      RouteTableId: !Ref PrivateRouteTable',
        '      SubnetId: !Ref PrivateSubnetA\n      RouteTableId: !Ref PublicRouteTable',
      )
      .replace(
        '      SubnetId: !Ref PrivateSubnetB\n      RouteTableId: !Ref PrivateRouteTable',
        '      SubnetId: !Ref PrivateSubnetB\n      RouteTableId: !Ref PublicRouteTable',
      );
    const labels = failed((await runRaw(swapped)).checks);
    expect(labels).toContain('R5 — PrivateSubnetA is still on the private route table');
    expect(labels).toContain('R5 — PrivateSubnetB is still on the private route table');
  });

  it('fails an association that names the wrong subnet', async () => {
    // Both associations point at PublicSubnetA; B is never associated.
    const result = await run({ assocBSubnet: '!Ref PublicSubnetA' });
    expect(failed(result.checks)).toContain('R4 — that association is for PublicSubnetB');
  });

  it('fails a private subnet given its own path to the gateway', async () => {
    const result = await run({ assocBSubnet: '!Ref PrivateSubnetB' });
    expect(failed(result.checks)).toContain('R4 — that association is for PublicSubnetB');
  });
});

describe('AWS-009 — the route itself', () => {
  it('fails a route scoped to something narrower than everything', async () => {
    const result = await run({ destination: '10.0.0.0/8' });
    expect(failed(result.checks)).toContain(
      'R3 — the route covers every destination the table does not already know',
    );
  });

  it('fails a route with no destination at all', async () => {
    const noDestination = withPublicPath().replace('      DestinationCidrBlock: 0.0.0.0/0\n', '');
    expect(failed((await runRaw(noDestination)).checks)).toContain(
      'R3 — the route covers every destination the table does not already know',
    );
  });

  it('fails an IPv6 default route where an IPv4 one is required', async () => {
    const result = await run({ destination: '::/0' });
    expect(failed(result.checks)).toContain(
      'R3 — the route covers every destination the table does not already know',
    );
  });

  it('fails a gateway declared as the wrong resource type', async () => {
    const result = await run({ igwType: 'AWS::EC2::EgressOnlyInternetGateway' });
    expect(failed(result.checks)).toContain('R1 — an internet gateway is declared');
  });
});

describe('AWS-009 — partial answers fail, and say which link is missing', () => {
  it('fails when the gateway exists but is never attached', async () => {
    const unattached = withPublicPath().replace(
      /  InternetGatewayAttachment:\n    Type: AWS::EC2::VPCGatewayAttachment\n    Properties:\n      VpcId: [^\n]*\n      InternetGatewayId: [^\n]*\n\n/,
      '',
    );
    const result = await runRaw(unattached);
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toEqual([
      'R1 — the gateway attachment is declared',
      'R1 — the attachment attaches to this VPC',
      'R1 — the attachment attaches that internet gateway',
    ]);
  });

  it('fails when the route exists but no subnet is associated', async () => {
    const noAssociations = withPublicPath().replace(
      /  PublicSubnetARouteTableAssociation:[\s\S]*?\n\n  PublicSubnetBRouteTableAssociation:[\s\S]*?RouteTableId: [^\n]*\n/,
      '',
    );
    const result = await runRaw(noAssociations);
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('R4 — PublicSubnetA has a route table association');
    // The rest of the chain is intact and reported as such.
    const passing = result.checks.filter((c) => c.status === 'pass').map((c) => c.label);
    expect(passing).toContain("R3 — the route's target is the internet gateway");
  });

  it('fails when the subnets are associated but the table has no route', async () => {
    const noRoute = withPublicPath().replace(
      /  PublicDefaultRoute:[\s\S]*?GatewayId: [^\n]*\n\n/,
      '',
    );
    const result = await runRaw(noRoute);
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('R3 — a route is declared');
    const passing = result.checks.filter((c) => c.status === 'pass').map((c) => c.label);
    expect(passing).toContain('R4 — PublicSubnetA is associated with the public route table');
  });
});

describe('AWS-009 — shortcuts do not work', () => {
  it('is not passed by evidence files claiming success', async () => {
    const result = await runRaw(SEEDED, {
      '/home/student/network/PASS': 'ok',
      '/home/student/network/result.json': '{"passed":true}',
      '/home/student/network/routing-notes.txt': 'InternetGateway attached, 0.0.0.0/0 -> igw, associations done',
      '/home/student/network/proof.log': 'LAB PASSED',
    });
    expect(result.passed).toBe(false);
  });

  it('is not passed by writing the architecture into comments', async () => {
    const commented = `# InternetGateway: AWS::EC2::InternetGateway
# InternetGatewayAttachment attaches it to Vpc
# PublicDefaultRoute: 0.0.0.0/0 -> InternetGateway in PublicRouteTable
# PublicSubnetARouteTableAssociation, PublicSubnetBRouteTableAssociation
${SEEDED}`;
    expect((await runRaw(commented)).passed).toBe(false);
  });

  it('is not passed by an unrelated resource carrying the expected values', async () => {
    // A resource whose properties contain every expected string, wired to
    // nothing. Existence of the values is not the same as the architecture.
    const decoy = SEEDED.replace(
      '  PrivateRouteTable:',
      `  Placeholder:
    Type: AWS::EC2::RouteTable
    Properties:
      VpcId: !Ref Vpc
      Tags:
        - Key: InternetGateway
          Value: 0.0.0.0/0
        - Key: PublicRouteTable
          Value: PublicDefaultRoute

  PrivateRouteTable:`,
    );
    expect((await runRaw(decoy)).passed).toBe(false);
  });

  it('is not passed by renaming the private route table to the public one', async () => {
    // Makes every private subnet public and satisfies nothing.
    const renamed = SEEDED.replace(/PrivateRouteTable/g, 'PublicRouteTable');
    const result = await runRaw(renamed);
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('R5 — PrivateSubnetA is still on the private route table');
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
    const lab = await loadLabDefinition(AWS_009);
    const solved = new FakeSandbox({ [TEMPLATE]: withPublicPath() });
    const unsolved = new FakeSandbox({ [TEMPLATE]: SEEDED });
    expect((await verifyLab({ lab, sandbox: solved, namespace: 'jtt-lab-00000000aaaa' })).passed).toBe(true);
    expect((await verifyLab({ lab, sandbox: unsolved, namespace: 'jtt-lab-00000000bbbb' })).passed).toBe(false);
  });
});
