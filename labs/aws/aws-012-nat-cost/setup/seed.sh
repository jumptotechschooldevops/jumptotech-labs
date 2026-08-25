#!/bin/bash
# ---------------------------------------------------------------------------
# AWS-012 baseline — a VPC whose private subnets reach S3 the expensive way.
#
# Runs once as root inside the session's own container, before the student's
# terminal opens, and is deleted immediately afterwards.
#
# EXECUTION MODEL: simulated Phase-0. Nothing here touches AWS. The template is
# a file; it is parsed, never deployed. The traffic report is a fixture.
# ---------------------------------------------------------------------------
set -euo pipefail

DIR=/home/student/network

install -d -o student -g student -m 0755 "$DIR"

cat > "$DIR/README.md" <<'DOC'
# Network review — where the egress bill comes from

SIMULATED ENVIRONMENT. This sandbox is a Linux container, not an AWS account.
Nothing is deployed and no AWS API is called. The template is graded by
parsing it; the traffic report is a capture.

    vpc.yaml            the VPC template. Edit this.
    traffic-report.txt  a month of egress, by destination
    review-notes.txt    what the platform team has been asked to change
    findings.env        where your conclusions go
DOC

cat > "$DIR/traffic-report.txt" <<'DOC'
EGRESS THROUGH THE NAT GATEWAY — 30 days, account 123456789012, eu-west-1
=========================================================================

Every byte below left a private subnet and was processed by the NAT gateway.
Percentages are of total NAT-processed bytes.

  destination                                       share    initiated by
  ------------------------------------------------  -------  ---------------
  Amazon S3 (jumptotech-backups, same Region)         61%     nightly backup
  Amazon DynamoDB (ledger-sessions, same Region)      18%     session store
  Amazon S3 (jumptotech-build-artifacts, same Region)  9%     deploy agent
  deb.debian.org / security.debian.org                 7%     OS patching
  api.stripe-sandbox.example                           3%     payments sandbox
  hub.docker.com                                       2%     image pulls

Notes from the capture
----------------------
  · All three AWS destinations above are in the same Region as the VPC.
  · The two private subnets share a single route table.
  · The NAT gateway itself is healthy and correctly sized.
DOC

cat > "$DIR/review-notes.txt" <<'DOC'
NETWORK REVIEW 4402 — reduce what the NAT gateway processes
===========================================================

Finance has asked why the NAT gateway bill grew with backup volume. The
platform team's answer is that most of what the NAT gateway processes never
needed to go through it at all.

What to change in vpc.yaml
--------------------------
  1. Traffic to the two AWS services that dominate the report must reach those
     services without being processed by the NAT gateway. AWS provides a VPC
     endpoint type that does exactly this for those two services, and only
     those two. Add one for each, using these logical IDs so the network
     module's tests keep working:

         S3Endpoint          for the Amazon S3 traffic
         DynamoDbEndpoint    for the Amazon DynamoDB traffic

  2. Each endpoint must be of the type that is attached to route tables rather
     than placed in subnets, must belong to this VPC, and must be associated
     with the route table the private subnets use. An endpoint that exists but
     is not associated with that route table changes nothing: instances whose
     route table is not associated keep using the public service endpoint.

  3. The NAT gateway stays, and the private subnets keep their default route
     to it. Some of the traffic in the report still needs it.

What to record in findings.env
------------------------------
  4. Which of the destinations in the report can stop using the NAT gateway,
     and which cannot, and what the endpoint type you added costs.

Notes
-----
The endpoint type you need is documented, as is the exact list of services it
supports and what AWS charges for it. Do not guess any of the three.
DOC

cat > "$DIR/vpc.yaml" <<'DOC'
AWSTemplateFormatVersion: '2010-09-09'
Description: Payments platform VPC - two private subnets behind one NAT gateway.

Resources:
  Vpc:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: 10.20.0.0/16
      EnableDnsSupport: true
      EnableDnsHostnames: true

  InternetGateway:
    Type: AWS::EC2::InternetGateway

  GatewayAttachment:
    Type: AWS::EC2::VPCGatewayAttachment
    Properties:
      VpcId: !Ref Vpc
      InternetGatewayId: !Ref InternetGateway

  PublicSubnet:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.20.0.0/24
      MapPublicIpOnLaunch: true

  PrivateSubnetA:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.20.10.0/24

  PrivateSubnetB:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.20.11.0/24

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

  PrivateSubnetARouteAssociation:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      SubnetId: !Ref PrivateSubnetA
      RouteTableId: !Ref PrivateRouteTable

  PrivateSubnetBRouteAssociation:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties:
      SubnetId: !Ref PrivateSubnetB
      RouteTableId: !Ref PrivateRouteTable

Outputs:
  VpcId:
    Value: !Ref Vpc
DOC

cat > "$DIR/findings.env" <<'DOC'
# Network review 4402 — findings
#
# Replace every FILL_ME. Use exactly KEY=value on its own line, with no spaces
# around the '=' sign and nothing after the value.

# The endpoint type you added, written as AWS names it.
ENDPOINT_TYPE=FILL_ME

# What AWS charges for that endpoint type: none, hourly, per_gb, or hourly_and_per_gb
ENDPOINT_CHARGE=FILL_ME

# How the backup traffic reaches S3 after your change:
#   gateway_endpoint, interface_endpoint, nat_gateway, or internet_gateway
BACKUP_TRAFFIC_VIA=FILL_ME

# How OS patching from deb.debian.org reaches the internet after your change:
PATCHING_TRAFFIC_VIA=FILL_ME

# Percentage share of NAT-processed bytes your change removes, from the report.
NAT_SHARE_REMOVED=FILL_ME
DOC

chown -R student:student "$DIR"
find "$DIR" -type f -exec chmod 0644 {} +
