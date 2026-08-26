#!/bin/bash
# ---------------------------------------------------------------------------
# AWS-009 baseline — a two-zone VPC whose "public" subnets cannot reach anything.
#
# Runs once as root inside the session's own container, before the student's
# terminal opens, and is deleted immediately afterwards.
#
# EXECUTION MODEL: simulated Phase-0. Nothing here touches AWS. The template is
# a file; it is parsed, never deployed. No AWS credentials exist in this
# sandbox, no AWS API is called, and no AWS resource — billable or otherwise —
# is created.
#
# The starting template is the end state of AWS-008 plus private routing. It is
# correct as far as it goes: two zones, paired tiers, sound addressing, and
# subnets that auto-assign public IPv4 addresses. It has no internet gateway
# and no route to one, which is the entire fault.
#
# Nothing the student must add appears anywhere below: not the resource types,
# not the property names, and not the destination of the route.
# ---------------------------------------------------------------------------
set -euo pipefail

DIR=/home/student/network

install -d -o student -g student -m 0755 "$DIR"

cat > "$DIR/README.md" <<'DOC'
# The public subnets are not public

SIMULATED ENVIRONMENT. This sandbox is a Linux container, not an AWS account.
Nothing is deployed and no AWS API is called. Your template is graded by
parsing it and checking the architecture it describes.

    vpc.yaml           the VPC. Edit this.
    ticket-8830.txt    what was reported, and what is required
    routing-notes.txt  how routing decides what a subnet is

The four subnets, their zones and their addressing are already correct and
signed off. Do not renumber, resize, move or rename them.
DOC

cat > "$DIR/ticket-8830.txt" <<'DOC'
TICKET 8830 — instances in the public subnets cannot reach the internet
=======================================================================

Reported
--------
Every instance launched into PublicSubnetA and PublicSubnetB comes up with a
public IPv4 address, as intended. None of them can reach anything outside the
VPC. Package installs hang. Outbound API calls time out. Instances in the
private subnets behave exactly the same way, which is expected — they are
supposed to.

The subnets are named public. They are configured to hand out public IPv4
addresses. Neither of those facts is what makes a subnet public.

Required
--------
  R1. The VPC must have an internet gateway, and that gateway must be attached
      to this VPC. A gateway that exists but is attached to nothing is not
      reachable from anywhere.

  R2. A route table for the public tier, belonging to this VPC.

  R3. In that route table, a route that sends all traffic with no more specific
      destination to the internet gateway. Both halves matter: the destination
      covers everything not already known to the table, and the target is the
      gateway from R1.

  R4. Both public subnets must be associated with that route table. A route
      table with a perfect route in it changes nothing for a subnet that is
      not associated with it.

  R5. The private subnets must stay private. They are already associated with
      the private route table; leave that association alone. A private subnet
      that acquires a path to the internet gateway is an incident, not a fix.

Use these logical IDs, because the platform module and the change record both
refer to them:

    InternetGateway
    InternetGatewayAttachment
    PublicRouteTable
    PublicDefaultRoute
    PublicSubnetARouteTableAssociation
    PublicSubnetBRouteTableAssociation

Do not change anything that is already in the file.
DOC

cat > "$DIR/routing-notes.txt" <<'DOC'
ROUTING NOTES — what actually makes a subnet public
===================================================

A subnet is not public because of its name. It is not public because it
auto-assigns public IPv4 addresses, either — that setting decides whether an
instance *has* a public address, not whether packets can get anywhere with it.
Both of those are already true of PublicSubnetA and PublicSubnetB, and both
subnets are unreachable.

What decides it is routing, and the Amazon VPC User Guide states the rule
directly in "Enable internet access for a VPC using an internet gateway".
Read that page. It defines a public subnet and a private subnet in terms of
one thing only: the route table the subnet is associated with, and whether
that table has a route to an internet gateway.

So there are four separate things that all have to be true, and the design
fails if any one of them is missing:

    the gateway exists
    the gateway is attached to this VPC
    a route table has a route whose target is that gateway
    the subnet is associated with that route table

The existing PrivateRouteTable in vpc.yaml shows how a route table is declared
and how a subnet is associated with one. It deliberately has no route out;
that is what makes the private subnets private.

The AWS::EC2 resource types and property names you need are in the AWS
CloudFormation resource reference. Look them up rather than guessing — the
property that names a route's target is not called the same thing as the
property that names its destination.
DOC

cat > "$DIR/vpc.yaml" <<'DOC'
AWSTemplateFormatVersion: '2010-09-09'
Description: Payments platform VPC - two zones, private routing only.

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
      Tags:
        - Key: Name
          Value: payments-private

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
  PublicSubnetAId:
    Value: !Ref PublicSubnetA
  PublicSubnetBId:
    Value: !Ref PublicSubnetB
  PrivateSubnetAId:
    Value: !Ref PrivateSubnetA
  PrivateSubnetBId:
    Value: !Ref PrivateSubnetB
DOC

chown -R student:student "$DIR"
find "$DIR" -type f -exec chmod 0644 {} +
