#!/bin/bash
# ---------------------------------------------------------------------------
# AWS-003 baseline — a policy whose Deny is doing more than anyone intended.
#
# Runs once as root inside the session's own container, before the student's
# terminal opens, and is deleted immediately afterwards.
#
# NOTHING HERE TOUCHES AWS. The policy is a file, graded by parsing it.
# ---------------------------------------------------------------------------
set -euo pipefail

DIR=/home/student/access-review

install -d -o student -g student -m 0755 "$DIR"

cat > "$DIR/README.md" <<'DOC'
# Access review — incident 6042

SIMULATED ENVIRONMENT. This sandbox is a Linux container, not an AWS account.
Nothing here is connected to AWS. The policy in this directory is never
attached to anything and never sent anywhere — it is graded by reading it and
working out what it would actually permit.

    policy.json        the policy attached to the developer role. Edit this.
    incident-6042.txt  what happened, and what the outcome has to be.

Nothing in this directory tells you what to write. Work it out from what the
policy currently means.
DOC

cat > "$DIR/incident-6042.txt" <<'DOC'
INCIDENT 6042 — developers cannot read build artifacts
======================================================

Since Tuesday the platform team cannot download build artifacts. Deployments
are being done by hand. The developer role's policy has not changed in weeks,
but a bucket reorganisation moved customer exports INTO the build artifacts
bucket, and the policy has behaved differently ever since.

The bucket
----------
    bucket           arn:aws:s3:::jumptotech-build-artifacts
    build artifacts  arn:aws:s3:::jumptotech-build-artifacts/builds/*
    customer exports arn:aws:s3:::jumptotech-build-artifacts/customer-exports/*

What the developer role MUST be able to do
------------------------------------------
  1. List the bucket.
  2. Read build artifacts.
  3. Upload build artifacts.

What the developer role MUST NOT be able to do
----------------------------------------------
  4. Read, upload or delete anything under customer-exports/. This is the
     control the auditors signed off on and it must survive.
  5. Delete build artifacts. Retention owns deletion, not developers.

How the protection must be expressed
------------------------------------
  6. The customer-exports protection must remain an EXPLICIT Deny that names
     those three operations. Simply not granting them is not good enough here:
     the auditors' finding was that a future broad Allow, added by someone in a
     hurry, must not be able to re-expose customer data. A Deny cannot be
     overridden by an Allow. An absent Allow can be added by anybody.

A warning from the last attempt
-------------------------------
Someone already tried to fix this on Wednesday by adding a second Allow
statement for the build artifacts. It changed nothing, and they could not
explain why. Understand that before you edit anything.
DOC

cat > "$DIR/policy.json" <<'DOC'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DeveloperRead",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::jumptotech-build-artifacts/*"
    },
    {
      "Sid": "ProtectCustomerExports",
      "Effect": "Deny",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::jumptotech-build-artifacts/*"
    }
  ]
}
DOC

chown -R student:student "$DIR"
chmod 0644 "$DIR/policy.json" "$DIR/incident-6042.txt" "$DIR/README.md"
