#!/bin/bash
# ---------------------------------------------------------------------------
# AWS-008 baseline — a VPC that works, and lives entirely in one zone.
#
# Runs once as root inside the session's own container, before the student's
# terminal opens, and is deleted immediately afterwards.
#
# EXECUTION MODEL: simulated Phase-0. Nothing here touches AWS. The template is
# a file; it is parsed, never deployed. No AWS credentials exist in this
# sandbox and no AWS API is called.
#
# The starting template is deliberately *correct* — it deploys, it is well
# addressed, and it has been in production. Its only fault is that everything
# in it is in one Availability Zone, which is the fault that does not show up
# until the zone is gone. No range or zone the student needs to add appears
# anywhere below.
# ---------------------------------------------------------------------------
set -euo pipefail

DIR=/home/student/network

install -d -o student -g student -m 0755 "$DIR"

cat > "$DIR/README.md" <<'DOC'
# Post-incident work — spread the VPC across two zones

SIMULATED ENVIRONMENT. This sandbox is a Linux container, not an AWS account.
Nothing is deployed and no AWS API is called. Your template is graded by
parsing it and checking the layout it describes.

    vpc.yaml           the deployed VPC. Extend this.
    incident-4471.txt  what happened, and what operations asked for
    platform-notes.txt how the application stack consumes this template

The addressing rules from the previous design review still apply. They are
restated in incident-4471.txt so you do not have to go and find them.
DOC

cat > "$DIR/incident-4471.txt" <<'DOC'
INCIDENT 4471 — payments unavailable 04:12-06:48 UTC
====================================================

What happened
-------------
An Availability Zone in eu-west-1 became unavailable. Every payments instance
became unreachable at the same moment and stayed unreachable until the zone
recovered. There was no failover because there was nowhere to fail over to:
the VPC has two subnets and both are in the same zone.

The VPC itself is fine. The addressing is fine. The design has one zone.

What operations asked for
-------------------------
  A1. A second Availability Zone, with its own public subnet and its own
      private subnet. Use these logical IDs, because the application stack
      already refers to them:

          PublicSubnetB      PrivateSubnetB

  A2. Each zone must be able to serve on its own: the public subnet and the
      private subnet of a zone must both be in that same zone. A zone that
      holds a public subnet but whose private subnet is somewhere else is not
      a zone that can serve a request end to end.

  A3. The design must use exactly two Availability Zones. Not one, and not
      three — the on-call rotation, the capacity plan and the reserved
      capacity are all sized for two, and a stray third zone is capacity
      nobody is watching.

  A4. The new subnets must be sized like their counterparts in the first zone,
      because the same workloads will run in both:
        · the public subnet must offer at least 251 assignable addresses
        · the private subnet must offer at least 4,091 assignable addresses
      As before, the number of addresses a subnet *offers* is not the number
      its CIDR block *contains*.

  A5. The new subnets must be inside this VPC's range, must not overlap
      anything already allocated, and must leave at least half of the VPC
      still unallocated. We are not doing this again for zone three.

  A6. Public means public and private means private, declared the same way
      the first zone declares it.

  A7. The application stack cannot use a subnet it cannot find. See
      platform-notes.txt.

Do not renumber, resize or move the subnets that are already there. They are
deployed, and changing a subnet's CIDR block means replacing it.
DOC

cat > "$DIR/platform-notes.txt" <<'DOC'
PLATFORM NOTES — how the application stack consumes this template
=================================================================

The application stack does not read this template. It reads this stack's
outputs, by name, and places instances into whatever subnets those outputs
identify.

Today the network stack publishes two outputs, one per subnet, named after
the subnet they identify:

    PublicSubnetAId       ->  PublicSubnetA
    PrivateSubnetAId      ->  PrivateSubnetA

The application stack already expects the two matching names for the second
zone and currently gets nothing back for them, which is why the failover
capacity it was supposed to have never existed even on paper.

Follow the naming pattern that is already there. An output whose value does
not actually identify the subnet it is named after is worse than a missing
one, because it sends instances to the wrong zone.
DOC

cat > "$DIR/vpc.yaml" <<'DOC'
AWSTemplateFormatVersion: '2010-09-09'
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
DOC

chown -R student:student "$DIR"
find "$DIR" -type f -exec chmod 0644 {} +
