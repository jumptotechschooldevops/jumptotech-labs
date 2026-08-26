#!/bin/bash
# ---------------------------------------------------------------------------
# AWS-005 baseline — a deploy policy that can pass any role to EC2.
#
# Runs once as root inside the session's own container, before the student's
# terminal opens, and is deleted immediately afterwards.
#
# NOTHING HERE TOUCHES AWS. No role exists; the inventory is a text file and
# the policy is graded by parsing it.
# ---------------------------------------------------------------------------
set -euo pipefail

DIR=/home/student/escalation-review

install -d -o student -g student -m 0755 "$DIR"

cat > "$DIR/README.md" <<'DOC'
# Escalation review — finding 8102

SIMULATED ENVIRONMENT. This sandbox is a Linux container, not an AWS account.
No roles exist and no AWS API is called. The files below are a snapshot taken
for review, and the policy is graded by reading it and working out what it
would permit.

    deployer-policy.json   the policy attached to the deploy pipeline's role
    roles-in-account.txt   what each role in the account can do
    finding-8102.txt       what security review wants changed

Read the role inventory before you read the policy. The finding is only
obvious once you know what the roles are for.
DOC

cat > "$DIR/roles-in-account.txt" <<'DOC'
ROLE INVENTORY — account 123456789012
=====================================

arn:aws:iam::123456789012:role/AppServerRole
    Attached to application instances. Reads config from S3 and writes
    application logs to CloudWatch. Trusted by ec2.amazonaws.com.

arn:aws:iam::123456789012:role/AppWorkerRole
    Attached to background worker instances. Reads from SQS and writes to S3.
    Trusted by ec2.amazonaws.com.

arn:aws:iam::123456789012:role/ReconciliationBatchRole
    The nightly finance batch. Reads customer exports. Trusted by
    ec2.amazonaws.com.

arn:aws:iam::123456789012:role/PlatformAdminRole
    Break-glass administration. Effectively unrestricted across the account.
    Trusted by ec2.amazonaws.com so it can be attached to a recovery instance
    during an incident.

--
Every role above is assumable by the EC2 service, because every one of them is
designed to be attached to an instance.
DOC

cat > "$DIR/finding-8102.txt" <<'DOC'
SECURITY FINDING 8102 — deploy pipeline can escalate to administrator
=====================================================================

The deploy pipeline runs with the policy in deployer-policy.json. It launches
EC2 instances and attaches a role to each one so the application on it has
credentials.

Review's finding is that the pipeline can attach ANY role in the account to an
instance it controls, including PlatformAdminRole. Anyone who can change what
the pipeline deploys can therefore obtain administrator credentials from that
instance, without ever being granted administrator themselves. Nothing in the
pipeline's own policy says "administrator", which is why this was missed.

What must remain true
---------------------
  1. The pipeline must still launch, describe and tag EC2 instances. Review
     accepted the EC2 statement exactly as it stands — do not change it.
  2. The pipeline must still be able to attach AppServerRole and AppWorkerRole
     to the instances it launches.

What must become true
---------------------
  3. The pipeline must NOT be able to attach PlatformAdminRole to anything.
  4. The pipeline must NOT be able to attach ReconciliationBatchRole either.
     The finance batch is deployed by a different pipeline.
  5. Whatever the pipeline is allowed to attach, it must only be allowed to
     attach it to the EC2 service. Review wants this stated explicitly in the
     policy rather than left to chance, so that the permission cannot be reused
     to hand a role to some other service later.
  6. No statement may use "*" on its own as an Action.

What must NOT be done
---------------------
  7. Do not grant the pipeline any additional IAM write permission. Adding
     permissions to work around a permissions finding is how findings become
     incidents.

Notes from review
-----------------
The permission that attaches a role to a service is not an API call of its own
and does not appear in CloudTrail under its own name. Look it up rather than
guessing which action it is.

The restriction in line 5 is expressed with a condition. IAM defines a
condition key for exactly this purpose, and it applies to only that one action.
DOC

cat > "$DIR/deployer-policy.json" <<'DOC'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LaunchInstances",
      "Effect": "Allow",
      "Action": [
        "ec2:RunInstances",
        "ec2:DescribeInstances",
        "ec2:CreateTags"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AttachRoleToInstance",
      "Effect": "Allow",
      "Action": [
        "iam:PassRole",
        "iam:GetRole"
      ],
      "Resource": "*"
    }
  ]
}
DOC

chown -R student:student "$DIR"
chmod 0644 "$DIR"/*.json "$DIR"/*.txt "$DIR/README.md"
