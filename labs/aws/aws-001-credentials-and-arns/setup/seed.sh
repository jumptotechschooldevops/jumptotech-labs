#!/bin/bash
# ---------------------------------------------------------------------------
# AWS-001 baseline — an evidence bundle captured from a host, and one broken
# credentials file to repair.
#
# Runs once as root inside the session's own container, before the student's
# terminal opens, and is deleted immediately afterwards.
#
# NOTHING HERE TOUCHES AWS. Every value below is fictional: the access key ids
# are AWS's own documentation examples, the account ids are the documentation
# placeholder 123456789012, and no file is ever sent anywhere.
# ---------------------------------------------------------------------------
set -euo pipefail

BUNDLE=/home/student/aws-incident

install -d -o student -g student -m 0755 "$BUNDLE"
install -d -o student -g student -m 0755 "$BUNDLE/capture-1"
install -d -o student -g student -m 0755 "$BUNDLE/capture-2"
install -d -o student -g student -m 0755 "$BUNDLE/capture-3"
install -d -o student -g student -m 0755 "$BUNDLE/deploy"

cat > "$BUNDLE/README.md" <<'DOC'
# Incident 4471 — evidence bundle

SIMULATED ENVIRONMENT. This sandbox is a Linux container, not an AWS account.
Nothing here is connected to AWS. There is no AWS CLI to run, no credentials
that work, and no API to call. Every file below is a *capture* taken from the
reconciliation host and copied here for analysis.

Three captures were taken while the nightly reconciliation job was failing.
Each one records the state of a host at the moment an `aws` command ran:

    capture-N/environment.txt   the AWS_* environment variables that were set
    capture-N/config            the contents of ~/.aws/config
    capture-N/credentials       the contents of ~/.aws/credentials
    capture-N/command.txt       the command that was run

`change-ticket-4471.txt` is the resource inventory the change ticket carried.

`deploy/credentials` is the file the deployment pipeline ships to the host. It
is the one file in this bundle you are expected to change.

Record your conclusions in `findings.env`.
DOC

# --- capture 1 -------------------------------------------------------------
cat > "$BUNDLE/capture-1/environment.txt" <<'DOC'
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
AWS_DEFAULT_REGION=eu-west-1
DOC

cat > "$BUNDLE/capture-1/config" <<'DOC'
[default]
region = eu-west-1
output = json
DOC

cat > "$BUNDLE/capture-1/credentials" <<'DOC'
[default]
aws_access_key_id = AKIAI44QH8DHBEXAMPLE
aws_secret_access_key = je7MtGbClwBF/2Zp9Utk/h3yCoEXAMPLEKEY
DOC

cat > "$BUNDLE/capture-1/command.txt" <<'DOC'
aws s3 ls s3://jumptotech-ledger-exports
DOC

# --- capture 2 -------------------------------------------------------------
cat > "$BUNDLE/capture-2/environment.txt" <<'DOC'
(no AWS_ environment variables were set on the host at capture time)
DOC

cat > "$BUNDLE/capture-2/config" <<'DOC'
[default]
region = eu-west-1
output = json
aws_access_key_id = AKIAI55QH8DHCEXAMPLE
aws_secret_access_key = 8dMtGbClwBF/2Zp9Utk/h3yCoEXAMPLEKEY
DOC

cat > "$BUNDLE/capture-2/credentials" <<'DOC'
[default]
aws_access_key_id = AKIAI66QH8DHDEXAMPLE
aws_secret_access_key = 2fMtGbClwBF/2Zp9Utk/h3yCoEXAMPLEKEY
DOC

cat > "$BUNDLE/capture-2/command.txt" <<'DOC'
aws sts get-caller-identity
DOC

# --- capture 3 -------------------------------------------------------------
cat > "$BUNDLE/capture-3/environment.txt" <<'DOC'
(no AWS_ environment variables were set on the host at capture time)
DOC

cat > "$BUNDLE/capture-3/config" <<'DOC'
[default]
region = eu-west-1
output = json
credential_process = /opt/jumptotech/bin/fetch-ledger-credentials
aws_access_key_id = AKIAI77QH8DHEEXAMPLE
aws_secret_access_key = 5hMtGbClwBF/2Zp9Utk/h3yCoEXAMPLEKEY
DOC

cat > "$BUNDLE/capture-3/credentials" <<'DOC'
(no credentials file existed on the host at capture time)
DOC

cat > "$BUNDLE/capture-3/command.txt" <<'DOC'
aws s3 cp reconciliation.csv s3://jumptotech-ledger-exports/2026/
DOC

# --- the change ticket -----------------------------------------------------
cat > "$BUNDLE/change-ticket-4471.txt" <<'DOC'
CHANGE 4471 — resources touched by the reconciliation job
=========================================================

Five resource names were pasted into this ticket by hand. Some of them are not
well-formed Amazon Resource Names. Decide which.

ARN_1  arn:aws:iam::123456789012:user/ledger-batch
ARN_2  arn:aws-eu:s3:::jumptotech-ledger-exports
ARN_3  arn:aws:s3:::jumptotech-ledger-exports
ARN_4  arn:aws:ec2:eu-west-1:1234-5678-9012:vpc/vpc-0a1b2c3d
ARN_5  arn:aws:lambda:eu-west-1:123456789012:functi*:reconcile
DOC

# --- the file the pipeline ships -------------------------------------------
cat > "$BUNDLE/deploy/credentials" <<'DOC'
# Shipped by the deployment pipeline to ~/.aws/credentials on the
# reconciliation host. The batch job runs with --profile reconciliation and
# reports that the profile cannot be found.

[default]
aws_access_key_id = AKIAI99QH8DHGEXAMPLE
aws_secret_access_key = 7kMtGbClwBF/2Zp9Utk/h3yCoEXAMPLEKEY

[profile reconciliation]
aws_access_key_id = AKIAI88QH8DHFEXAMPLE
aws_secret_access_key = 3nMtGbClwBF/2Zp9Utk/h3yCoEXAMPLEKEY
DOC

# --- the answer sheet ------------------------------------------------------
cat > "$BUNDLE/findings.env" <<'DOC'
# Incident 4471 — findings
#
# Replace every FILL_ME below. Use exactly KEY=value, with no spaces around
# the '=' sign and nothing after the value on the line.

CAPTURE_1_SOURCE=FILL_ME
CAPTURE_2_SOURCE=FILL_ME
CAPTURE_3_SOURCE=FILL_ME

ARN_1=FILL_ME
ARN_2=FILL_ME
ARN_3=FILL_ME
ARN_4=FILL_ME
ARN_5=FILL_ME
DOC

chown -R student:student "$BUNDLE"
chmod 0644 "$BUNDLE/findings.env" "$BUNDLE/deploy/credentials"
