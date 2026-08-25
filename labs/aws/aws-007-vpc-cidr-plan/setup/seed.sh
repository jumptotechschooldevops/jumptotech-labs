#!/bin/bash
# ---------------------------------------------------------------------------
# AWS-007 baseline — a VPC plan that was drawn without doing the arithmetic.
#
# Runs once as root inside the session's own container, before the student's
# terminal opens, and is deleted immediately afterwards.
#
# EXECUTION MODEL: simulated Phase-0. Nothing here touches AWS. The template is
# a file; it is parsed, never deployed. No AWS credentials exist in this
# sandbox and no AWS API is called.
#
# The seeded draft is deliberately plausible: every range in it is a real
# private range, every subnet is a real CIDR block, and it is still wrong in
# five different ways. None of the correct answers appear anywhere below —
# the requirements are stated as capacities, not as ranges.
# ---------------------------------------------------------------------------
set -euo pipefail

DIR=/home/student/network

install -d -o student -g student -m 0755 "$DIR"

cat > "$DIR/README.md" <<'DOC'
# Network design review — the address plan

SIMULATED ENVIRONMENT. This sandbox is a Linux container, not an AWS account.
Nothing is deployed and no AWS API is called. Your template is graded by
parsing it and doing the subnet arithmetic.

    vpc.yaml                 the address plan. Edit this.
    network-requirements.txt what the plan has to satisfy
    review.txt               why the current draft came back

There is no single correct answer. Any plan that satisfies every requirement
in network-requirements.txt passes, whichever ranges you choose.
DOC

cat > "$DIR/network-requirements.txt" <<'DOC'
NETWORK REQUIREMENTS — payments platform, Region eu-west-1
==========================================================

The VPC
-------
  R1. The VPC must use a private address range, as the VPC User Guide
      recommends. Do not use a publicly routable range.

  R2. The VPC must hold at least 65,536 addresses. A VPC's CIDR block cannot
      be resized after the VPC is created, so this is a one-way decision.

The subnets
-----------
  Four subnets, with these logical IDs, so the platform module's tests keep
  working:

      PublicSubnetA     PublicSubnetB     PrivateSubnetA     PrivateSubnetB

  R3. Every subnet must sit wholly inside the VPC's range.

  R4. No two subnets may overlap.

  R5. Each public subnet must offer at least 251 addresses that can actually
      be assigned to a resource.

  R6. Each private subnet must offer at least 4,091 addresses that can
      actually be assigned to a resource. The workloads live here.

      Note for R5 and R6: the number of addresses a subnet *offers* is not
      the number its CIDR block *contains*. The VPC User Guide is explicit
      about the difference and about how large it is.

  R7. The two public subnets must be in different Availability Zones, and so
      must the two private subnets. Use the Availability Zones of eu-west-1.

  R8. Public subnets must give instances a public IPv4 address on launch.
      Private subnets must not.

Growth
------
  R9. At least half of the VPC's address space must be left unallocated, for
      subnets this design does not have yet.

Every one of R1-R9 is checked. Nothing else is: the ranges you pick are
yours to choose.
DOC

cat > "$DIR/review.txt" <<'DOC'
DESIGN REVIEW — returned to the author
======================================

The draft in vpc.yaml was written by sizing the subnets to the servers that
were being migrated this quarter, and then picking a VPC big enough to hold
exactly those subnets. Reviewers rejected it. Their notes:

  · "The VPC is sized for today. We cannot resize it later."
  · "Two of these ranges cover some of the same addresses."
  · "One of these subnets is not in the VPC at all."
  · "Both public subnets are in one Availability Zone. That is one AZ."
  · "The private subnets do not say what they are."

Rework the plan against network-requirements.txt. You may change every range
in the file; only the five logical IDs are fixed.
DOC

cat > "$DIR/vpc.yaml" <<'DOC'
AWSTemplateFormatVersion: '2010-09-09'
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
DOC

chown -R student:student "$DIR"
find "$DIR" -type f -exec chmod 0644 {} +
