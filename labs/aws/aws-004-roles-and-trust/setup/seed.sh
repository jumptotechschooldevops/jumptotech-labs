#!/bin/bash
# ---------------------------------------------------------------------------
# AWS-004 baseline — a role whose permissions are right and whose trust policy
# is not.
#
# Runs once as root inside the session's own container, before the student's
# terminal opens, and is deleted immediately afterwards.
#
# NOTHING HERE TOUCHES AWS. Both policies are files, graded by parsing them.
# ---------------------------------------------------------------------------
set -euo pipefail

DIR=/home/student/role-setup

install -d -o student -g student -m 0755 "$DIR"

cat > "$DIR/README.md" <<'DOC'
# Role review — finding 7318

SIMULATED ENVIRONMENT. This sandbox is a Linux container, not an AWS account.
No role exists, nothing is attached to anything, and no AWS API is called. Both
policies below are graded by reading them and working out what they mean.

    trust-policy.json        who is allowed to assume the role
    permissions-policy.json  what the role is allowed to do once assumed
    finding-7318.txt         what security review wants changed

Two different policies, two different questions. Read the finding before you
decide which file to edit.
DOC

cat > "$DIR/finding-7318.txt" <<'DOC'
SECURITY FINDING 7318 — reconciliation role trust relationship
==============================================================

The nightly reconciliation batch runs on EC2 instances. Those instances receive
their AWS permissions from an IAM role, ReconciliationBatchRole.

Security review has accepted the role's PERMISSIONS policy without change. It
grants exactly the S3 access the batch needs and nothing more. Do not alter it.

The TRUST policy is the finding. It currently says two things review will not
accept:

  1. It allows any principal at all to assume the role. A role that anyone can
     assume is not a boundary.

  2. It still trusts a contractor account from a project that ended in March.
     Nobody has been able to explain why it is there.

What the trust policy must end up saying
----------------------------------------
  3. Exactly one statement.
  4. It must allow the EC2 service — and only the EC2 service — to assume the
     role, because that is what an instance profile needs in order to hand
     credentials to the batch.
  5. The action it allows must be the one an EC2 instance actually calls to
     assume a role. It is not "everything under sts".
  6. No wildcard principal, and no wildcard action.

Notes from review
-----------------
A service principal is an identifier the service is known by, not an ARN and
not an account number. The identifier for a service is given in AWS's own
documentation; do not guess it from the service's console name.

Trust policies are resource-based policies. NotPrincipal is not supported in
them, so it is not a way around anything here.
DOC

cat > "$DIR/trust-policy.json" <<'DOC'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TrustAnyone",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "sts:AssumeRole"
    },
    {
      "Sid": "ContractorAccess",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::210987654321:role/contractor-build"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
DOC

cat > "$DIR/permissions-policy.json" <<'DOC'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadReconciliationInputs",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::jumptotech-reconciliation",
        "arn:aws:s3:::jumptotech-reconciliation/*"
      ]
    }
  ]
}
DOC

chown -R student:student "$DIR"
chmod 0644 "$DIR"/*.json "$DIR"/*.txt "$DIR"/README.md
