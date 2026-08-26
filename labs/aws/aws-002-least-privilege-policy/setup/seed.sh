#!/bin/bash
# ---------------------------------------------------------------------------
# AWS-002 baseline — an over-permissive IAM policy, and the ticket that says
# what the job actually needs.
#
# Runs once as root inside the session's own container, before the student's
# terminal opens, and is deleted immediately afterwards.
#
# NOTHING HERE TOUCHES AWS. The policy is a file. There is no account, no
# credential, and no API call: it is graded by parsing it.
# ---------------------------------------------------------------------------
set -euo pipefail

DIR=/home/student/aws-iam

install -d -o student -g student -m 0755 "$DIR"

cat > "$DIR/README.md" <<'DOC'
# Least privilege for the reconciliation job

SIMULATED ENVIRONMENT. This sandbox is a Linux container, not an AWS account.
Nothing here is connected to AWS. The policy in this directory is never sent
anywhere and never attached to anything — it is graded by reading it and
working out what it would mean.

    policy.json       the policy as it stands today. Edit this file.
    ticket-5120.txt   what the reconciliation job actually needs.

Your job is to make policy.json say exactly what the ticket asks for, and
nothing more.
DOC

cat > "$DIR/ticket-5120.txt" <<'DOC'
CHANGE 5120 — tighten the reconciliation job's permissions
==========================================================

Security review rejected the current policy. It was written as "allow
everything" on the day the job shipped and never revisited.

The job runs nightly. Everything it does is against ONE bucket:

    bucket   arn:aws:s3:::jumptotech-ledger-exports
    objects  arn:aws:s3:::jumptotech-ledger-exports/*

What it must be able to do
--------------------------
  1. List the bucket, to find yesterday's exports.
  2. Read objects from the bucket.
  3. Upload the reconciliation report back into the bucket — but ONLY when the
     upload asks for server-side encryption with AWS KMS. Uploads without it
     must not be permitted.

What it must NOT be able to do
------------------------------
  4. Delete anything. The retention rules own deletion, not this job.
  5. Reach any other bucket. Finance keeps payroll exports in
     arn:aws:s3:::jumptotech-payroll and this job has no business there.

Review rules
------------
  6. No statement may use "*" on its own as an Action.
  7. No statement may use "*" on its own as a Resource.

The encryption requirement is expressed with a condition. The S3 context key
for it is  s3:x-amz-server-side-encryption  and the value the ticket requires
is  aws:kms .
DOC

cat > "$DIR/policy.json" <<'DOC'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ShippedInAHurry",
      "Effect": "Allow",
      "Action": "*",
      "Resource": "*"
    }
  ]
}
DOC

chown -R student:student "$DIR"
chmod 0644 "$DIR/policy.json" "$DIR/ticket-5120.txt" "$DIR/README.md"
