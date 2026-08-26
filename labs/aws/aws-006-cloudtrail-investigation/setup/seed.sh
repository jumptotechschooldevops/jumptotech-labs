#!/bin/bash
# ---------------------------------------------------------------------------
# AWS-006 baseline — a CloudTrail export covering the night production broke.
#
# Runs once as root inside the session's own container, before the student's
# terminal opens, and is deleted immediately afterwards.
#
# EXECUTION MODEL: simulated Phase-0 AWS evidence investigation. Nothing here
# touches AWS. The trail is a fixture; no account, credential or API is
# involved. Every identifier is from a documentation-reserved range: account
# 123456789012, AKIA/AROA/ASIA…EXAMPLE keys, and RFC 5737 addresses
# (203.0.113.0/24, 198.51.100.0/24).
#
# The expected findings are NOT in this sandbox. They live only in the lab
# definition, which the student cannot read.
# ---------------------------------------------------------------------------
set -euo pipefail

DIR=/home/student/incident-9214
TRAIL="$DIR/cloudtrail"

install -d -o student -g student -m 0755 "$DIR"
install -d -o student -g student -m 0755 "$TRAIL"

cat > "$DIR/README.md" <<'DOC'
# Incident 9214 — payments API stopped accepting traffic

SIMULATED ENVIRONMENT. This sandbox is a Linux container, not an AWS account.
Nothing here is connected to AWS. The files under `cloudtrail/` are an export
of management events, copied here so they can be read offline.

    incident-9214.txt   the page-out and what operations know so far
    infrastructure.txt  what the account's security groups and instances are
    cloudtrail/         the exported trail, one file per hour
    findings.env        where your conclusions go

Tools available in this sandbox: `grep`, `less`, `cat`, `sed`, `awk`, `find`,
`sort`, `uniq`, `wc`, `tree`. There is no `jq` here; the export is
pretty-printed one field per line so the ordinary text tools work on it.
DOC

cat > "$DIR/incident-9214.txt" <<'DOC'
INCIDENT 9214 — payments API unreachable
========================================

03:16 UTC  Synthetic checks against the payments API begin failing. The load
           balancer reports every target unhealthy.
03:22 UTC  On-call confirms the instances are running and the application is
           listening. Traffic from the load balancer is not arriving.
03:41 UTC  Connectivity restored by re-adding a security group rule by hand.
           Nobody on the call knows who removed it or when.

You have the CloudTrail export for that night. Work out exactly what happened.

Record your conclusions in findings.env. Replace every FILL_ME. Use exactly
KEY=value on its own line, with no spaces around the '=' sign.

What operations need from you
-----------------------------
  · which API call caused this, and which service recorded it
  · when it happened, and in which Region
  · which security group it changed
  · which identity made the call — both the full ARN of the principal that
    made the request and the principalId CloudTrail recorded for it
  · what address the request came from
  · whether the call succeeded or was rejected

There is also an EARLIER attempt at the same API call that night which did NOT
succeed. Operations want that one identified too, separately: who attempted it
and what error CloudTrail recorded. Do not confuse it with the call that
actually changed the group.
DOC

cat > "$DIR/infrastructure.txt" <<'DOC'
ACCOUNT INVENTORY — 123456789012, eu-west-1
===========================================

Security groups
---------------
sg-0a1b2c3d4e5f60718   payments-api-sg
    Attached to the payments API instances. Ingress is expected from the
    payments load balancer only.

sg-0fedcba987654321    payments-alb-sg
    Attached to the payments load balancer itself. Ingress from the internet
    on 443.

sg-0123456789abcdef0   staging-web-sg
    Staging only. Not in the production path.

Instances
---------
i-0d1e2f3a4b5c6d7e8    payments-api-1   (payments-api-sg)
i-0e2f3a4b5c6d7e8f9    payments-api-2   (payments-api-sg)
i-0f3a4b5c6d7e8f9a0    staging-web-1    (staging-web-sg)

Roles and users referenced by automation
----------------------------------------
arn:aws:iam::123456789012:role/PlatformDeployRole   used by the deploy pipeline
arn:aws:iam::123456789012:role/ReadOnlyAuditRole    used by the audit tooling
arn:aws:iam::123456789012:user/priya.raman          platform engineer
arn:aws:iam::123456789012:user/ci-uploader          artifact upload only
DOC

# --- 02:00 hour: ordinary night-time activity ------------------------------
cat > "$TRAIL/2026-08-25T02.json" <<'DOC'
{
  "Records": [
    {
      "eventVersion": "1.11",
      "userIdentity": {
        "type": "IAMUser",
        "principalId": "AIDAEXAMPLEUSER00001",
        "arn": "arn:aws:iam::123456789012:user/ci-uploader",
        "accountId": "123456789012",
        "accessKeyId": "AKIAEXAMPLEKEY00001",
        "userName": "ci-uploader"
      },
      "eventTime": "2026-08-25T02:41:07Z",
      "eventSource": "s3.amazonaws.com",
      "eventName": "PutObject",
      "awsRegion": "eu-west-1",
      "sourceIPAddress": "198.51.100.14",
      "userAgent": "aws-cli/2.15.30 Python/3.11.8 Linux/6.1.0 exe/x86_64.debian.12",
      "requestParameters": {
        "bucketName": "jumptotech-build-artifacts",
        "key": "builds/payments-api-7.4.1.tar.gz"
      },
      "responseElements": null,
      "requestID": "3f1b9d5a-6c21-4a7e-9b13-2d8e5f0a4c66",
      "eventID": "b7c2d1e0-4a5f-4c8b-9e31-77a0d5b2e194",
      "readOnly": false,
      "eventType": "AwsApiCall",
      "managementEvent": false,
      "recipientAccountId": "123456789012",
      "eventCategory": "Data"
    },
    {
      "eventVersion": "1.11",
      "userIdentity": {
        "type": "AssumedRole",
        "principalId": "AROAEXAMPLEROLE00002:audit-nightly",
        "arn": "arn:aws:sts::123456789012:assumed-role/ReadOnlyAuditRole/audit-nightly",
        "accountId": "123456789012",
        "accessKeyId": "ASIAEXAMPLEKEY00002",
        "sessionContext": {
          "sessionIssuer": {
            "type": "Role",
            "principalId": "AROAEXAMPLEROLE00002",
            "arn": "arn:aws:iam::123456789012:role/ReadOnlyAuditRole",
            "accountId": "123456789012",
            "userName": "ReadOnlyAuditRole"
          },
          "attributes": {
            "creationDate": "2026-08-25T02:50:03Z",
            "mfaAuthenticated": "false"
          }
        }
      },
      "eventTime": "2026-08-25T02:50:44Z",
      "eventSource": "ec2.amazonaws.com",
      "eventName": "DescribeSecurityGroups",
      "awsRegion": "eu-west-1",
      "sourceIPAddress": "198.51.100.9",
      "userAgent": "aws-sdk-go/1.50.0",
      "requestParameters": {
        "securityGroupIdSet": {},
        "filterSet": {}
      },
      "responseElements": null,
      "requestID": "8a4c7e2b-1d90-4f36-b5aa-6c3e9f18d072",
      "eventID": "c9d8e7f6-5b4a-4938-8271-1a2b3c4d5e6f",
      "readOnly": true,
      "eventType": "AwsApiCall",
      "managementEvent": true,
      "recipientAccountId": "123456789012",
      "eventCategory": "Management"
    },
    {
      "eventVersion": "1.11",
      "userIdentity": {
        "type": "AssumedRole",
        "principalId": "AROAEXAMPLEROLE00002:audit-nightly",
        "arn": "arn:aws:sts::123456789012:assumed-role/ReadOnlyAuditRole/audit-nightly",
        "accountId": "123456789012",
        "accessKeyId": "ASIAEXAMPLEKEY00002"
      },
      "eventTime": "2026-08-25T02:51:12Z",
      "eventSource": "ec2.amazonaws.com",
      "eventName": "DescribeInstances",
      "awsRegion": "eu-west-1",
      "sourceIPAddress": "198.51.100.9",
      "userAgent": "aws-sdk-go/1.50.0",
      "requestParameters": {
        "instancesSet": {},
        "filterSet": {}
      },
      "responseElements": null,
      "requestID": "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9",
      "eventID": "d0e1f2a3-b4c5-4d6e-8f90-1a2b3c4d5e6f",
      "readOnly": true,
      "eventType": "AwsApiCall",
      "managementEvent": true,
      "recipientAccountId": "123456789012",
      "eventCategory": "Management"
    }
  ]
}
DOC

# --- 03:00 hour: the denied attempt, a decoy, and the incident -------------
cat > "$TRAIL/2026-08-25T03.json" <<'DOC'
{
  "Records": [
    {
      "eventVersion": "1.11",
      "userIdentity": {
        "type": "IAMUser",
        "principalId": "AIDAEXAMPLEUSER00003",
        "arn": "arn:aws:iam::123456789012:user/priya.raman",
        "accountId": "123456789012",
        "accessKeyId": "AKIAEXAMPLEKEY00003",
        "userName": "priya.raman"
      },
      "eventTime": "2026-08-25T03:08:19Z",
      "eventSource": "ec2.amazonaws.com",
      "eventName": "RevokeSecurityGroupIngress",
      "awsRegion": "eu-west-1",
      "sourceIPAddress": "198.51.100.23",
      "userAgent": "aws-cli/2.15.30 Python/3.11.8 Linux/6.1.0 exe/x86_64.debian.12",
      "errorCode": "Client.UnauthorizedOperation",
      "errorMessage": "You are not authorized to perform this operation. User: arn:aws:iam::123456789012:user/priya.raman is not authorized to perform: ec2:RevokeSecurityGroupIngress on resource: arn:aws:ec2:eu-west-1:123456789012:security-group/sg-0a1b2c3d4e5f60718",
      "requestParameters": {
        "groupId": "sg-0a1b2c3d4e5f60718",
        "ipPermissions": {
          "items": [
            {
              "ipProtocol": "tcp",
              "fromPort": 8443,
              "toPort": 8443,
              "groups": {
                "items": [
                  {
                    "groupId": "sg-0fedcba987654321"
                  }
                ]
              }
            }
          ]
        }
      },
      "responseElements": null,
      "requestID": "1a2b3c4d-5e6f-4708-9a1b-2c3d4e5f6071",
      "eventID": "e1f2a3b4-c5d6-4e7f-8091-a2b3c4d5e6f7",
      "readOnly": false,
      "eventType": "AwsApiCall",
      "managementEvent": true,
      "recipientAccountId": "123456789012",
      "eventCategory": "Management"
    },
    {
      "eventVersion": "1.11",
      "userIdentity": {
        "type": "AssumedRole",
        "principalId": "AROAEXAMPLEROLE00004:deploy-9f31c2",
        "arn": "arn:aws:sts::123456789012:assumed-role/PlatformDeployRole/deploy-9f31c2",
        "accountId": "123456789012",
        "accessKeyId": "ASIAEXAMPLEKEY00004",
        "sessionContext": {
          "sessionIssuer": {
            "type": "Role",
            "principalId": "AROAEXAMPLEROLE00004",
            "arn": "arn:aws:iam::123456789012:role/PlatformDeployRole",
            "accountId": "123456789012",
            "userName": "PlatformDeployRole"
          },
          "attributes": {
            "creationDate": "2026-08-25T03:02:11Z",
            "mfaAuthenticated": "false"
          }
        }
      },
      "eventTime": "2026-08-25T03:11:04Z",
      "eventSource": "ec2.amazonaws.com",
      "eventName": "AuthorizeSecurityGroupIngress",
      "awsRegion": "eu-west-1",
      "sourceIPAddress": "203.0.113.47",
      "userAgent": "aws-cli/2.15.30 Python/3.11.8 Linux/6.1.0 exe/x86_64.debian.12",
      "requestParameters": {
        "groupId": "sg-0fedcba987654321",
        "ipPermissions": {
          "items": [
            {
              "ipProtocol": "tcp",
              "fromPort": 443,
              "toPort": 443,
              "ipRanges": {
                "items": [
                  {
                    "cidrIp": "0.0.0.0/0"
                  }
                ]
              }
            }
          ]
        }
      },
      "responseElements": {
        "requestId": "2b3c4d5e-6f70-4819-a2b3-c4d5e6f70819",
        "_return": true
      },
      "requestID": "2b3c4d5e-6f70-4819-a2b3-c4d5e6f70819",
      "eventID": "f2a3b4c5-d6e7-4f80-91a2-b3c4d5e6f708",
      "readOnly": false,
      "eventType": "AwsApiCall",
      "managementEvent": true,
      "recipientAccountId": "123456789012",
      "eventCategory": "Management"
    },
    {
      "eventVersion": "1.11",
      "userIdentity": {
        "type": "AssumedRole",
        "principalId": "AROAEXAMPLEROLE00004:deploy-9f31c2",
        "arn": "arn:aws:sts::123456789012:assumed-role/PlatformDeployRole/deploy-9f31c2",
        "accountId": "123456789012",
        "accessKeyId": "ASIAEXAMPLEKEY00004",
        "sessionContext": {
          "sessionIssuer": {
            "type": "Role",
            "principalId": "AROAEXAMPLEROLE00004",
            "arn": "arn:aws:iam::123456789012:role/PlatformDeployRole",
            "accountId": "123456789012",
            "userName": "PlatformDeployRole"
          },
          "attributes": {
            "creationDate": "2026-08-25T03:02:11Z",
            "mfaAuthenticated": "false"
          }
        }
      },
      "eventTime": "2026-08-25T03:14:52Z",
      "eventSource": "ec2.amazonaws.com",
      "eventName": "RevokeSecurityGroupIngress",
      "awsRegion": "eu-west-1",
      "sourceIPAddress": "203.0.113.47",
      "userAgent": "aws-cli/2.15.30 Python/3.11.8 Linux/6.1.0 exe/x86_64.debian.12",
      "requestParameters": {
        "groupId": "sg-0a1b2c3d4e5f60718",
        "ipPermissions": {
          "items": [
            {
              "ipProtocol": "tcp",
              "fromPort": 8443,
              "toPort": 8443,
              "groups": {
                "items": [
                  {
                    "groupId": "sg-0fedcba987654321"
                  }
                ]
              }
            }
          ]
        }
      },
      "responseElements": {
        "requestId": "3c4d5e6f-7081-492a-b3c4-d5e6f708192a",
        "_return": true
      },
      "requestID": "3c4d5e6f-7081-492a-b3c4-d5e6f708192a",
      "eventID": "a3b4c5d6-e7f8-4091-a2b3-c4d5e6f70819",
      "readOnly": false,
      "eventType": "AwsApiCall",
      "managementEvent": true,
      "recipientAccountId": "123456789012",
      "eventCategory": "Management"
    },
    {
      "eventVersion": "1.11",
      "userIdentity": {
        "type": "AssumedRole",
        "principalId": "AROAEXAMPLEROLE00004:deploy-9f31c2",
        "arn": "arn:aws:sts::123456789012:assumed-role/PlatformDeployRole/deploy-9f31c2",
        "accountId": "123456789012",
        "accessKeyId": "ASIAEXAMPLEKEY00004"
      },
      "eventTime": "2026-08-25T03:19:36Z",
      "eventSource": "ec2.amazonaws.com",
      "eventName": "StopInstances",
      "awsRegion": "eu-west-1",
      "sourceIPAddress": "203.0.113.47",
      "userAgent": "aws-cli/2.15.30 Python/3.11.8 Linux/6.1.0 exe/x86_64.debian.12",
      "requestParameters": {
        "instancesSet": {
          "items": [
            {
              "instanceId": "i-0f3a4b5c6d7e8f9a0"
            }
          ]
        },
        "force": false
      },
      "responseElements": {
        "instancesSet": {
          "items": [
            {
              "instanceId": "i-0f3a4b5c6d7e8f9a0",
              "currentState": {
                "code": 64,
                "name": "stopping"
              },
              "previousState": {
                "code": 16,
                "name": "running"
              }
            }
          ]
        }
      },
      "requestID": "4d5e6f70-8192-4a3b-c4d5-e6f708192a3b",
      "eventID": "b4c5d6e7-f809-41a2-b3c4-d5e6f708192a",
      "readOnly": false,
      "eventType": "AwsApiCall",
      "managementEvent": true,
      "recipientAccountId": "123456789012",
      "eventCategory": "Management"
    },
    {
      "eventVersion": "1.11",
      "userIdentity": {
        "type": "IAMUser",
        "principalId": "AIDAEXAMPLEUSER00003",
        "arn": "arn:aws:iam::123456789012:user/priya.raman",
        "accountId": "123456789012",
        "accessKeyId": "AKIAEXAMPLEKEY00003",
        "userName": "priya.raman"
      },
      "eventTime": "2026-08-25T03:33:58Z",
      "eventSource": "iam.amazonaws.com",
      "eventName": "CreateUser",
      "awsRegion": "us-east-1",
      "sourceIPAddress": "198.51.100.23",
      "userAgent": "AWS Internal",
      "requestParameters": {
        "userName": "breakglass-oncall"
      },
      "responseElements": {
        "user": {
          "userName": "breakglass-oncall",
          "userId": "AIDAEXAMPLEUSER00005",
          "arn": "arn:aws:iam::123456789012:user/breakglass-oncall",
          "createDate": "Aug 25, 2026 3:33:58 AM",
          "path": "/"
        }
      },
      "requestID": "5e6f7081-92a3-4b4c-d5e6-f708192a3b4c",
      "eventID": "c5d6e7f8-0919-42b3-c4d5-e6f708192a3b",
      "readOnly": false,
      "eventType": "AwsApiCall",
      "managementEvent": true,
      "recipientAccountId": "123456789012",
      "eventCategory": "Management"
    },
    {
      "eventVersion": "1.11",
      "userIdentity": {
        "type": "IAMUser",
        "principalId": "AIDAEXAMPLEUSER00003",
        "arn": "arn:aws:iam::123456789012:user/priya.raman",
        "accountId": "123456789012",
        "accessKeyId": "AKIAEXAMPLEKEY00003",
        "userName": "priya.raman"
      },
      "eventTime": "2026-08-25T03:41:22Z",
      "eventSource": "ec2.amazonaws.com",
      "eventName": "AuthorizeSecurityGroupIngress",
      "awsRegion": "eu-west-1",
      "sourceIPAddress": "198.51.100.23",
      "userAgent": "aws-cli/2.15.30 Python/3.11.8 Linux/6.1.0 exe/x86_64.debian.12",
      "requestParameters": {
        "groupId": "sg-0a1b2c3d4e5f60718",
        "ipPermissions": {
          "items": [
            {
              "ipProtocol": "tcp",
              "fromPort": 8443,
              "toPort": 8443,
              "groups": {
                "items": [
                  {
                    "groupId": "sg-0fedcba987654321"
                  }
                ]
              }
            }
          ]
        }
      },
      "responseElements": {
        "requestId": "6f708192-a3b4-4c5d-e6f7-08192a3b4c5d",
        "_return": true
      },
      "requestID": "6f708192-a3b4-4c5d-e6f7-08192a3b4c5d",
      "eventID": "d6e7f809-192a-43c4-d5e6-f708192a3b4c",
      "readOnly": false,
      "eventType": "AwsApiCall",
      "managementEvent": true,
      "recipientAccountId": "123456789012",
      "eventCategory": "Management"
    }
  ]
}
DOC

cat > "$DIR/findings.env" <<'DOC'
# Incident 9214 — findings
#
# Replace every FILL_ME. Use exactly KEY=value on its own line, with no spaces
# around the '=' sign and nothing after the value.

EVENT_NAME=FILL_ME
EVENT_SOURCE=FILL_ME
EVENT_TIME=FILL_ME
AWS_REGION=FILL_ME
AFFECTED_SECURITY_GROUP=FILL_ME
PRINCIPAL_ARN=FILL_ME
PRINCIPAL_ID=FILL_ME
SOURCE_IP=FILL_ME
OUTCOME=FILL_ME

# The earlier attempt at the same API call that did not succeed.
DENIED_PRINCIPAL_ARN=FILL_ME
DENIED_ERROR_CODE=FILL_ME
DOC

chown -R student:student "$DIR"
find "$DIR" -type f -exec chmod 0644 {} +
