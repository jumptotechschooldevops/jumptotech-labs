#!/bin/bash
# ---------------------------------------------------------------------------
# AWS-018 baseline — a CloudFormation template that will not create.
#
# Runs once as root inside the session's own container, before the student's
# terminal opens, and is deleted immediately afterwards.
#
# EXECUTION MODEL: simulated Phase-0. Nothing here touches AWS. The template is
# a file; it is parsed, never deployed. No account, credential or API is
# involved, and the stack events below are a fixture.
# ---------------------------------------------------------------------------
set -euo pipefail

DIR=/home/student/stack

install -d -o student -g student -m 0755 "$DIR"

cat > "$DIR/README.md" <<'DOC'
# Stack payments-export — will not create

SIMULATED ENVIRONMENT. This sandbox is a Linux container, not an AWS account.
Nothing here is deployed and no AWS API is called. The template is graded by
parsing it and reading what it declares.

    payments-export.yaml   the template. Edit this.
    stack-events.txt       what CloudFormation reported on the last attempt
    change-request.txt     what the stack is supposed to end up creating

Tools available here: `grep`, `less`, `cat`, `sed`, `awk`, `find`, `tree`.
There is no `aws` CLI and no `cfn-lint` in this sandbox — read the template.
DOC

cat > "$DIR/change-request.txt" <<'DOC'
CHANGE REQUEST 3376 — payments export pipeline
==============================================

The payments export pipeline needs one CloudFormation stack containing four
resources, all named with the logical IDs already in the template. Do not
rename them; other teams' templates import these outputs by name.

  ExportBucket        an S3 bucket, named from the Environment parameter
  ExportQueue         an SQS queue, named from the Environment parameter
  ExportRole          an IAM role the export instances will run as
  ExportRolePolicy    an IAM policy attached to that role

What the stack must end up declaring
------------------------------------
  1. Every resource keeps the type it is supposed to be. The template was
     copied from another stack, so check them.

  2. ExportRole must be assumable by the service the export instances run on.
     You covered how a role expresses that in an earlier lab; the same document
     goes in the template, as a property of the role.

  3. ExportRolePolicy must attach to ExportRole, and must be attached by
     referring to it — not by repeating its name as a string.

  4. ExportRolePolicy must grant read access to the objects in ExportBucket,
     and must obtain the bucket's ARN from the bucket resource rather than
     hard-coding it. The bucket does not exist yet, so its ARN cannot be known
     when the template is written.

  5. Every reference in the template must point at something the template
     actually declares — a resource, or a parameter.

  6. The stack must export two outputs: ExportBucketName, giving the bucket's
     name, and ExportRoleArn, giving the role's ARN. Each must be taken from
     the resource rather than reconstructed.

Notes
-----
CloudFormation has two ways to point at another resource. One returns the
resource's identifier; the other returns a named attribute of it. Which one you
need depends on what you are asking for — an ARN is not an identifier.
DOC

cat > "$DIR/stack-events.txt" <<'DOC'
STACK payments-export — events from the last create attempt
===========================================================

2026-08-25T09:41:02Z  payments-export     CREATE_IN_PROGRESS
                      User Initiated

2026-08-25T09:41:09Z  payments-export     ROLLBACK_IN_PROGRESS
                      The following resource(s) failed to create:
                      [ExportRole, ExportRolePolicy, ExportQueue].

2026-08-25T09:41:08Z  ExportRole          CREATE_FAILED
                      Property AssumeRolePolicyDocument cannot be empty.

2026-08-25T09:41:08Z  ExportRolePolicy    CREATE_FAILED
                      Template error: instance of Fn::GetAtt references
                      undefined resource ExportsBucket

2026-08-25T09:41:08Z  ExportQueue         CREATE_FAILED
                      Template format error: Unresolved resource dependencies
                      [Env] in the Resources block of the template

2026-08-25T09:41:07Z  ExportBucket        CREATE_COMPLETE

2026-08-25T09:41:31Z  payments-export     ROLLBACK_COMPLETE
DOC

cat > "$DIR/payments-export.yaml" <<'DOC'
AWSTemplateFormatVersion: '2010-09-09'
Description: Payments export pipeline - bucket, queue, and the role that reads them.

Parameters:
  Environment:
    Type: String
    Description: Deployment environment prefix, for example staging or prod.
    Default: staging

Resources:
  ExportBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub '${Environment}-payments-exports'

  ExportQueue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: !Sub '${Env}-payments-export-events'
      MessageRetentionPeriod: 345600

  ExportRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: !Sub '${Environment}-payments-export'
      Description: Runs the nightly payments export on EC2.

  ExportRolePolicy:
    Type: AWS::IAM::Policy
    Properties:
      PolicyName: payments-export-read
      Roles:
        - ExportRole
      PolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Action:
              - s3:GetObject
            Resource: !GetAtt ExportsBucket.Arn

Outputs:
  ExportBucketName:
    Description: Name of the export bucket.
    Value: !Ref ExportBucket
DOC

chown -R student:student "$DIR"
find "$DIR" -type f -exec chmod 0644 {} +
