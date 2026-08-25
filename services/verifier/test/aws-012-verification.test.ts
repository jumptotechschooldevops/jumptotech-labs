/**
 * AWS-012 — verification behaviour.
 *
 * Two artefacts are graded: the template change (parsed) and the written
 * conclusions (canonical tokens, line-anchored). The interesting failures are
 * endpoints that exist but are wired to nothing, the wrong endpoint type, and
 * "savings" achieved by deleting the NAT gateway.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLabDefinition, type SandboxPathRead } from '@jumptotech/lab-orchestrator';
import { verifyLab, type SandboxPort } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LABS_DIR = path.resolve(here, '../../../labs');
const AWS_012 = path.join(LABS_DIR, 'aws', 'aws-012-nat-cost', 'lab.yaml');
const TEMPLATE = '/home/student/network/vpc.yaml';
const FINDINGS = '/home/student/network/findings.env';

const BASE = `AWSTemplateFormatVersion: '2010-09-09'
Resources:
  Vpc:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: 10.20.0.0/16
  PublicSubnet:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.20.0.0/24
  PrivateSubnetA:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.20.10.0/24
  NatEip:
    Type: AWS::EC2::EIP
    Properties:
      Domain: vpc
  NatGateway:
    Type: AWS::EC2::NatGateway
    Properties:
      AllocationId: !GetAtt NatEip.AllocationId
      SubnetId: !Ref PublicSubnet
  PrivateRouteTable:
    Type: AWS::EC2::RouteTable
    Properties:
      VpcId: !Ref Vpc
  PrivateDefaultRoute:
    Type: AWS::EC2::Route
    Properties:
      RouteTableId: !Ref PrivateRouteTable
      DestinationCidrBlock: 0.0.0.0/0
      NatGatewayId: !Ref NatGateway
`;

const ENDPOINTS = `  S3Endpoint:
    Type: AWS::EC2::VPCEndpoint
    Properties:
      VpcId: !Ref Vpc
      VpcEndpointType: Gateway
      ServiceName: !Sub 'com.amazonaws.\${AWS::Region}.s3'
      RouteTableIds:
        - !Ref PrivateRouteTable
  DynamoDbEndpoint:
    Type: AWS::EC2::VPCEndpoint
    Properties:
      VpcId: !Ref Vpc
      VpcEndpointType: Gateway
      ServiceName: !Sub 'com.amazonaws.\${AWS::Region}.dynamodb'
      RouteTableIds:
        - !Ref PrivateRouteTable
`;

const SOLVED_TEMPLATE = BASE + ENDPOINTS;

const SEEDED_FINDINGS = `# Network review 4402 — findings

ENDPOINT_TYPE=FILL_ME
ENDPOINT_CHARGE=FILL_ME
BACKUP_TRAFFIC_VIA=FILL_ME
PATCHING_TRAFFIC_VIA=FILL_ME
NAT_SHARE_REMOVED=FILL_ME
`;

const CORRECT: Record<string, string> = {
  ENDPOINT_TYPE: 'Gateway',
  ENDPOINT_CHARGE: 'none',
  BACKUP_TRAFFIC_VIA: 'gateway_endpoint',
  PATCHING_TRAFFIC_VIA: 'nat_gateway',
  NAT_SHARE_REMOVED: '88',
};
const findings = (overrides: Partial<Record<string, string>> = {}) =>
  '# findings\n\n' + Object.entries({ ...CORRECT, ...overrides }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';

class FakeSandbox implements SandboxPort {
  constructor(private readonly entries: Record<string, string>) {}
  async read(p: string): Promise<SandboxPathRead | null> {
    const content = this.entries[p];
    if (content === undefined) return null;
    return { type: 'file', mode: '644', owner: 'student', group: 'student', sizeBytes: content.length, content };
  }
}

async function run(template: string, sheet: string) {
  const lab = await loadLabDefinition(AWS_012);
  const sandbox = new FakeSandbox({
    [TEMPLATE]: template,
    [FINDINGS]: sheet,
    '/home/student/network/traffic-report.txt': 'report',
  });
  return verifyLab({ lab, sandbox, namespace: 'jtt-lab-000000000012' });
}
const failed = (c: Array<{ status: string; label: string }>) => c.filter((x) => x.status === 'fail').map((x) => x.label);

describe('AWS-012 — the seeded state does not pass', () => {
  it('fails the endpoint work and every unanswered finding', async () => {
    const result = await run(BASE, SEEDED_FINDINGS);

    expect(result.passed).toBe(false);
    // 8 endpoint checks + 5 findings + the placeholder check.
    expect(failed(result.checks)).toHaveLength(14);
  });

  it('still passes what already worked', async () => {
    const passed = (await run(BASE, SEEDED_FINDINGS)).checks.filter((c) => c.status === 'pass').map((c) => c.label);

    expect(passed).toContain('The NAT gateway is still declared');
    expect(passed).toContain('The private subnets keep their default route to the NAT gateway');
    expect(passed).toContain('Every reference in the template still resolves');
  });

  it('discloses no answer in any failure detail', async () => {
    const blob = (await run(BASE, SEEDED_FINDINGS)).checks.map((c) => `${c.label} ${c.detail ?? ''}`).join('\n');

    for (const value of ['Gateway', 'gateway_endpoint', 'com.amazonaws', '88']) {
      expect(blob, value).not.toContain(value);
    }
  });
});

describe('AWS-012 — a correct change passes', () => {
  it('passes with both endpoints wired and the findings right', async () => {
    const result = await run(SOLVED_TEMPLATE, findings());
    expect(failed(result.checks)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('passes with long-form intrinsics and reordered resources', async () => {
    const longForm = SOLVED_TEMPLATE
      .replace(/RouteTableIds:\n        - !Ref PrivateRouteTable/g, 'RouteTableIds:\n        - Ref: PrivateRouteTable')
      .replace(/VpcId: !Ref Vpc/g, 'VpcId:\n        Ref: Vpc');
    expect((await run(longForm, findings())).passed).toBe(true);
  });

  it('passes when ServiceName is a plain string rather than a Sub', async () => {
    const plain = SOLVED_TEMPLATE.replace(/!Sub 'com\.amazonaws\.\$\{AWS::Region\}\.(\w+)'/g, "'com.amazonaws.eu-west-1.$1'");
    expect((await run(plain, findings())).passed).toBe(true);
  });
});

describe('AWS-012 — changes that do not actually save anything', () => {
  it('fails when the endpoints exist but are associated with no route table', async () => {
    const unwired = SOLVED_TEMPLATE.replace(/      RouteTableIds:\n        - !Ref PrivateRouteTable\n/g, '');
    const result = await run(unwired, findings());

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('S3Endpoint is associated with the private route table');
    expect(failed(result.checks)).toContain('DynamoDbEndpoint is associated with the private route table');
  });

  it('fails when the endpoints are associated with the wrong route table', async () => {
    const wrong = SOLVED_TEMPLATE
      .replace('Resources:', 'Resources:\n  PublicRouteTable:\n    Type: AWS::EC2::RouteTable\n    Properties:\n      VpcId: !Ref Vpc')
      .replace(/- !Ref PrivateRouteTable/g, '- !Ref PublicRouteTable');
    const result = await run(wrong, findings());

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('S3Endpoint is associated with the private route table');
  });

  it('fails when the interface endpoint type is chosen instead', async () => {
    const iface = SOLVED_TEMPLATE.replace(/VpcEndpointType: Gateway/g, 'VpcEndpointType: Interface');
    const result = await run(iface, findings());

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('S3Endpoint is the endpoint type that attaches to route tables');
  });

  it('fails when the NAT gateway is deleted to save money', async () => {
    const noNat = SOLVED_TEMPLATE
      .replace(/  NatGateway:[\s\S]*?SubnetId: !Ref PublicSubnet\n/, '')
      .replace(/      NatGatewayId: !Ref NatGateway\n/, '');
    const result = await run(noNat, findings());

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('The NAT gateway is still declared');
  });

  it('fails when only one of the two endpoints is added', async () => {
    const onlyS3 = SOLVED_TEMPLATE.replace(/  DynamoDbEndpoint:[\s\S]*$/, '');
    const result = await run(onlyS3, findings());

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('An endpoint named DynamoDbEndpoint is declared');
  });

  it('fails when ServiceName is omitted', async () => {
    const noService = SOLVED_TEMPLATE.replace(/      ServiceName: [^\n]*\n/, '');
    const result = await run(noService, findings());

    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('S3Endpoint names the service it points at');
  });

  it('fails on a wrong percentage, a wrong charge, or a wrong route', async () => {
    expect((await run(SOLVED_TEMPLATE, findings({ NAT_SHARE_REMOVED: '61' }))).passed).toBe(false);
    expect((await run(SOLVED_TEMPLATE, findings({ NAT_SHARE_REMOVED: '90' }))).passed).toBe(false);
    expect((await run(SOLVED_TEMPLATE, findings({ ENDPOINT_CHARGE: 'per_gb' }))).passed).toBe(false);
    expect((await run(SOLVED_TEMPLATE, findings({ PATCHING_TRAFFIC_VIA: 'gateway_endpoint' }))).passed).toBe(false);
    expect((await run(SOLVED_TEMPLATE, findings({ BACKUP_TRAFFIC_VIA: 'nat_gateway' }))).passed).toBe(false);

    // A value the right answer is a *prefix* of is still wrong. `Gateway` and
    // `GatewayLoadBalancer` are both real endpoint types, and 88% is not 880%.
    expect((await run(SOLVED_TEMPLATE, findings({ ENDPOINT_TYPE: 'GatewayLoadBalancer' }))).passed).toBe(
      false,
    );
    expect((await run(SOLVED_TEMPLATE, findings({ NAT_SHARE_REMOVED: '880' }))).passed).toBe(false);
    expect((await run(SOLVED_TEMPLATE, findings({ ENDPOINT_CHARGE: 'none_hourly' }))).passed).toBe(false);
  });

  it('does not accept an answer that only appears in a comment', async () => {
    const commented =
      '# findings\n# ENDPOINT_TYPE=Gateway\n' +
      'ENDPOINT_TYPE=FILL_ME\nENDPOINT_CHARGE=none\nBACKUP_TRAFFIC_VIA=gateway_endpoint\n' +
      'PATCHING_TRAFFIC_VIA=nat_gateway\nNAT_SHARE_REMOVED=88\n';
    const result = await run(SOLVED_TEMPLATE, commented);
    expect(result.passed).toBe(false);
    expect(result.checks.filter((c) => c.status === 'fail').map((c) => c.label)).toContain(
      'The endpoint type is named as AWS names it',
    );
  });

  it('does not let a longer key satisfy a shorter one that ends the same way', async () => {
    const shadowed =
      '# findings\nBACKUP_ENDPOINT_TYPE=Gateway\nENDPOINT_TYPE=FILL_ME\n' +
      'ENDPOINT_CHARGE=none\nBACKUP_TRAFFIC_VIA=gateway_endpoint\n' +
      'PATCHING_TRAFFIC_VIA=nat_gateway\nNAT_SHARE_REMOVED=88\n';
    expect((await run(SOLVED_TEMPLATE, shadowed)).passed).toBe(false);
  });

  it('fails safely on a broken template', async () => {
    for (const broken of ['', 'Resources:\n  X:\n   - [', '{"Resources": {']) {
      const result = await run(broken, findings());
      expect(result.passed, JSON.stringify(broken)).toBe(false);
    }
  });

  it('fails when a placeholder is left behind', async () => {
    const result = await run(SOLVED_TEMPLATE, findings({ ENDPOINT_TYPE: 'FILL_ME' }));
    expect(result.passed).toBe(false);
    expect(failed(result.checks)).toContain('Every finding has been filled in');
  });
});

describe('AWS-012 — isolation', () => {
  it('is not passed by another session having solved it', async () => {
    const lab = await loadLabDefinition(AWS_012);
    const a = new FakeSandbox({ [TEMPLATE]: SOLVED_TEMPLATE, [FINDINGS]: findings() });
    const b = new FakeSandbox({ [TEMPLATE]: BASE, [FINDINGS]: SEEDED_FINDINGS });

    expect((await verifyLab({ lab, sandbox: a, namespace: 'jtt-lab-a' })).passed).toBe(true);
    expect((await verifyLab({ lab, sandbox: b, namespace: 'jtt-lab-b' })).passed).toBe(false);
  });

  it('is not passed by a solved template left in another file', async () => {
    const lab = await loadLabDefinition(AWS_012);
    const sandbox = new FakeSandbox({
      [TEMPLATE]: BASE,
      '/home/student/network/vpc.fixed.yaml': SOLVED_TEMPLATE,
      [FINDINGS]: findings(),
    });
    expect((await verifyLab({ lab, sandbox, namespace: 'jtt-lab-x' })).passed).toBe(false);
  });
});
