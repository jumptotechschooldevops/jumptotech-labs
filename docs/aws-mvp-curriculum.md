# AWS MVP Curriculum — Corrected Plan (C1–C8 applied)

**Branch:** `claude/aws` · **Status:** curriculum documentation only
**Primary certification:** AWS Certified CloudOps Engineer – Associate (**SOA-C03**)
**Objective source:** `docs.aws.amazon.com/aws-certification/latest/sysops-administrator-associate-03/`
**Last verified:** **2026-08-23**

Supersedes §10 of [`aws-production-security-spec.md`](aws-production-security-spec.md).
Applies the corrections approved in the review
[`aws-curriculum-source-verification.md`](aws-curriculum-source-verification.md).

**No lab implemented. No AWS account, credential, resource, or API call. No shared
platform file modified. No other track touched.**

---

## 1. Corrections C1–C8

| Correction | Old classification | New classification | Official SOA-C03 objective | Lab(s) affected | Why the change is required |
|---|---|---|---|---|---|
| **C1** Add AWS-native IaC coverage | *(absent)* — Domain 3 provisioning had no lab | **CERTIFICATION OBJECTIVE** · exec **LOCAL** (Phase 0 static template authoring/validation) | **3.1.2** "Create and manage AWS resources by using CloudFormation and the AWS CDK"; **3.1.3** "Identify and remediate deployment issues (for example, subnet sizing issues, CloudFormation errors, permissions issues)" | **AWS-018** (new) | Domain 3 is **22%** of the exam and CloudFormation is named directly in two skills. A curriculum claiming SOA-C03 preparation with no IaC lab has a hole in nearly a quarter of the exam. |
| **C2** Add EventBridge | *(absent)* | **CERTIFICATION OBJECTIVE** · exec **REAL AWS CHEAP** | **1.2.2** "Use EventBridge to route, enrich, and deliver events, and troubleshoot any issues with event bus rules"; **3.2.2** "Implement event-driven automation … (for example, Lambda, S3 Event Notifications, EventBridge)" | **AWS-031** (new) | EventBridge is named in two domains (22% + 22%). Lambda alone does not cover event routing or bus-rule troubleshooting. |
| **C3** Extend logging lab to VPC Flow Logs | CERTIFICATION OBJECTIVE (1.1.1 only) | CERTIFICATION OBJECTIVE (1.1.1 **+ 5.3.2**) · exec unchanged **REAL AWS CHEAP** | **5.3.2** "Collect and interpret networking logs to troubleshoot issues (for example, VPC flow logs, ELB access logs …)" | **AWS-026** (was F2) | 5.3.2 names flow logs explicitly and nothing covered them. Adding them to an existing Logs lab closes the gap at no new cost band and reinforces AWS-013. |
| **C4** Re-scope the security/cost review onto named services | **PRODUCTION SKILL** — mapped to nothing | **CERTIFICATION OBJECTIVE** · exec unchanged **REAL AWS CHEAP** | **4.1.4** "Implement remediation based on the results of AWS Trusted Advisor security checks"; **4.1.5** "Enforce compliance requirements and continuous monitoring (… AWS Config conformance packs)" | **AWS-036** (was I1) | A generic "find the exposure and the waste" lab maps to no objective. Triaging **AWS Config** and **Trusted Advisor** findings covers two uncovered skills without changing the lab's character. GuardDuty deliberately excluded — findings cannot be generated on demand. |
| **C5** Extend the alarm lab to composite alarms and a dashboard | CERTIFICATION OBJECTIVE (1.1.3 partial, 1.1.5) | CERTIFICATION OBJECTIVE (1.1.3 **full** + **1.1.4** + 1.1.5) · exec unchanged **REAL AWS CHEAP** | **1.1.3** "… by creating composite alarms and identifying their invokable actions"; **1.1.4** "Create, implement, and manage customizable and shareable CloudWatch dashboards" | **AWS-025** (was F1) | Both skills were uncovered; both are additive to an existing lab at zero extra cost. |
| **C6** Re-label the certification alignment | "Solutions Architect Associate / DevOps Engineer Professional" | **SOA-C03 primary**, SAA-C03 secondary, DOP-C02 long-term | *(catalogue-level; SOA-C02 retired, last exam day **2025-09-29**)* | All 37 labs; spec §10 and §12.1 | The labs teach *operating* workloads. The current operations certification is CloudOps Engineer – Associate. Continuing to name a retired exam, or the wrong exam, misrepresents coverage. |
| **C7** Mark production-skill labs explicitly | Implicitly presented as exam-relevant | **PRODUCTION SKILL** / **FOUNDATIONAL SKILL** as applicable | *(none — that is the point)* | AWS-001, 005, 020, 028, 029, 034, 035 | Policy §4: a lab must not imply an objective it does not have. Seven labs (19%) map to no current SOA-C03 skill. |
| **C8** Read SAA-C03 task statements before any SAA claim | SAA mappings implied | **No SAA-C03 mapping claimed anywhere** until the task statements are read | *(SAA-C03 domains/weights confirmed; task statements NOT read)* | All labs with a would-be SAA mapping | Policy §10: never claim coverage against an objective that has not been opened and read. Domains and weightings alone are insufficient. |

### Do C1–C8 change shared platform architecture?

**No.** All eight are curriculum classification and objective mapping. They touch
no schema, no provider, no verifier contract, no other track. **They are applied
below.**

*(That does **not** mean the first lab is unblocked — see §7.)*

---

## 2. Lab count decision — 37, not 35

Per the decision, the curriculum is **not** optimised around an arbitrary count.
C1 and C2 each close a gap in a **22%-weight domain**, and both are `VERY LOW`
cost. Removing H4/G2 to reach 35 would have deleted useful material to hit a
number. **The MVP is 37 labs.**

**Duplicate-skill audit** — checked for labs teaching essentially the same skill:

| Pair examined | Verdict |
|---|---|
| AWS-028 (SQS DLQ/visibility) vs AWS-029 (SNS→SQS fan-out) | **Distinct.** Queue delivery semantics vs pub/sub topology. Different failure modes. Keep both. |
| AWS-030 (Lambda + SQS trigger) vs AWS-031 (EventBridge) | **Distinct.** Poll-based event source mapping vs rule-based routing/enrichment. 1.2.2 explicitly requires bus-rule troubleshooting. Keep both. |
| AWS-034 (ECS Fargate) vs AWS-035 (EKS concepts) | **Distinct.** One builds a service; the other is an architecture-choice judgement lab with no build. Keep both. |
| AWS-010 (security groups) vs AWS-011 (NACL vs SG) | **Overlap, justified.** 5.1.1 names both, and stateful-vs-stateless is the whole point of the second lab. Keep, but AWS-011 must not re-teach SG creation — it must start from AWS-010's end state. **Noted as an authoring constraint.** |
| AWS-013 (networking troubleshooting) vs AWS-037 (capstone) | **Overlap, justified.** AWS-013 is single-cause and scoped; AWS-037 is multi-service with an unknown cause. Different coverage depth (PRACTICED vs ASSESSMENT). |
| AWS-018 (CloudFormation) vs AWS-007 (CIDR plan) | **Distinct**, but both touch 3.1.3. AWS-007 covers subnet sizing; AWS-018 covers template errors. Complementary halves of one skill. |

**No duplicates found requiring removal.**

---

## 3. Infrastructure-as-code decision (C1 detail)

- **CloudFormation is the core AWS-native IaC lab** (AWS-018), per the decision.
- **CDK is named in objective 3.1.2 alongside CloudFormation**, so CDK is *not*
  purely a production skill — but the MVP covers 3.1.2 through CloudFormation
  only. Coverage level is therefore recorded as **INTRODUCED**, not PRACTICED,
  and the curriculum **does not claim CDK coverage**. A future CDK lab would be
  a CERTIFICATION OBJECTIVE lab (3.1.2), not a production-skill lab — recorded
  here so the classification is not mis-stated later.
- **Terraform is also named** in objective **3.1.6** ("Use and manage third-party
  tools to automate resource deployment (for example, **Terraform, Git**)"). The
  existing JumpToTech Terraform track already contributes to SOA-C03 coverage.
  **Cross-track credit is recorded in §6, not duplicated as an AWS lab.**
- **Phase 0 execution for AWS-018:** the student authors and repairs a
  CloudFormation template and validates it **structurally and locally**. No
  `cloudformation:ValidateTemplate` call (that is an AWS API), no deployment, no
  resources. The lab text must state plainly that the template is not deployed.
  Real deployment coverage is a separate, later lab behind Gate C.

**Honesty constraint recorded:** no Phase 0 lab may print, imply, or simulate a
successful AWS API response. Absence of deployment is stated to the student, not
concealed.

---

## 4. The 37-lab curriculum with full classification

**Skill class:** `CERT` = CERTIFICATION OBJECTIVE · `PROD` = PRODUCTION SKILL ·
`FOUND` = FOUNDATIONAL SKILL
**Execution class:** `SIM` = SIMULATED (graded against fixtures/models, nothing
executes) · `LOCAL` = real tooling runs locally, never reaches AWS ·
`R-CHEAP` = REAL AWS CHEAP · `R-CTRL` = REAL AWS CONTROLLED · `NOT ALLOWED`
**Coverage:** INTRODUCED · PRACTICED · ADVANCED · ASSESSMENT
**Last verified (all objective mappings):** 2026-08-23

Source keys: `SOA` = SOA-C03 exam guide · `IAM` = IAM User Guide · `VPC` = VPC
User Guide · `EC2` = EC2 User Guide · `EBS` = EBS User Guide · `SSM` = Systems
Manager UG · `S3` = Amazon S3 UG · `KMS` = KMS Developer Guide · `SM` = Secrets
Manager UG · `ELB` = ELB Application LB Guide · `ASG` = Auto Scaling UG ·
`R53` = Route 53 Developer Guide · `CW` = CloudWatch UG · `CT` = CloudTrail UG ·
`SQS`/`SNS`/`LAM`/`EVB` = respective guides · `CFN` = CloudFormation UG ·
`RDS`/`ECR`/`ECS`/`EKS` = respective guides · `CFG` = AWS Config DG ·
`TA` = Trusted Advisor UG · `CLI` = AWS CLI User Guide

### Module A — Identity and access (6)

| ID | Title | Skill | Exec | Domain | Objective | Coverage | Source |
|---|---|---|---|---|---|---|---|
| AWS-001 | ARNs, the account boundary, and credential resolution | **FOUND** | LOCAL | — | *none — foundational* | — | IAM, CLI |
| AWS-002 | Author a least-privilege identity policy | CERT | SIM | 4 | 4.1.1 IAM features — policy conditions | PRACTICED | IAM |
| AWS-003 | Explicit deny and policy evaluation order | CERT | SIM | 4 | 4.1.2 Troubleshoot and audit access issues (IAM policy simulator) | PRACTICED | IAM |
| AWS-004 | Roles, trust policies, and cross-account access | CERT | SIM | 4 | 4.1.1 IAM features — roles, resource policies | PRACTICED | IAM |
| AWS-005 | `PassRole` and the privilege-escalation path | **PROD** | SIM | — | *none — production security skill* | — | IAM |
| AWS-006 | Assume a role and prove your effective permissions | CERT | R-CHEAP | 4 | 4.1.2 Troubleshoot and audit access issues | PRACTICED | IAM |

### Module B — Networking (7)

| ID | Title | Skill | Exec | Domain | Objective | Coverage | Source |
|---|---|---|---|---|---|---|---|
| AWS-007 | Plan a VPC CIDR and subnet layout | CERT | SIM | 3, 5 | 3.1.3 deployment issues — **subnet sizing**; 5.1.1 configure a VPC | PRACTICED | VPC |
| AWS-008 | VPC with subnets across two AZs | CERT | R-CHEAP | 5 | 5.1.1 configure a VPC — subnets | PRACTICED | VPC |
| AWS-009 | Internet gateway and route tables | CERT | R-CHEAP | 5 | 5.1.1 configure a VPC — route tables, IGW | PRACTICED | VPC |
| AWS-010 | Security groups | CERT | R-CHEAP | 5 | 5.1.1 configure a VPC — security groups | PRACTICED | VPC |
| AWS-011 | NACLs vs security groups; stateless vs stateful | CERT | R-CHEAP | 5 | 5.1.1 configure a VPC — network ACLs | PRACTICED | VPC |
| AWS-012 | NAT concepts, alternatives, and network cost | CERT | SIM | 5 | 5.1.4 **Optimize the cost of network architectures** | PRACTICED | VPC |
| AWS-013 | Networking troubleshooting: no route to the internet | CERT | R-CHEAP | 5 | 5.3.1 Troubleshoot VPC configurations | ADVANCED | VPC |

### Module C — Compute and storage (4)

| ID | Title | Skill | Exec | Domain | Objective | Coverage | Source |
|---|---|---|---|---|---|---|---|
| AWS-014 | Launch from an allowed AMI; tag on create | CERT | R-CTRL | 3 | 3.1.1 Create and manage AMIs and container images | INTRODUCED | EC2 |
| AWS-015 | Instance profiles, IMDSv2, and user data | CERT | R-CTRL | 4, 1 | 4.1.1 IAM roles; 1.3.6 EC2 instances and associated capabilities | PRACTICED | EC2, IAM |
| AWS-016 | EBS attach, resize, snapshot, restore | CERT | R-CTRL | 1, 2 | 1.3.2 EBS performance and volume types; 2.3.1 automate snapshots | PRACTICED | EBS |
| AWS-017 | SSM Session Manager instead of SSH and a bastion | CERT | R-CTRL | 3 | 3.2.1 Automate operational processes (Systems Manager) | INTRODUCED | SSM |

### Module D — Infrastructure as code (1) · **new, C1**

| ID | Title | Skill | Exec | Domain | Objective | Coverage | Source |
|---|---|---|---|---|---|---|---|
| AWS-018 | CloudFormation: author, repair, and statically validate a template | CERT | **LOCAL** | 3 | 3.1.2 CloudFormation and the AWS CDK; 3.1.3 remediate deployment issues — CloudFormation errors | INTRODUCED (3.1.2) · PRACTICED (3.1.3) | CFN |

### Module E — Storage, encryption, secrets (3)

| ID | Title | Skill | Exec | Domain | Objective | Coverage | Source |
|---|---|---|---|---|---|---|---|
| AWS-019 | S3 buckets, storage classes, lifecycle, versioning | CERT | R-CHEAP | 1, 2 | 1.3.3 S3 Lifecycle; 2.3.3 versioning for storage services | PRACTICED | S3 |
| AWS-020 | Block Public Access and bucket-policy forensics | **PROD** | R-CHEAP | — | *none — production security skill* | — | S3 |
| AWS-021 | SSE-KMS, Secrets Manager, and SSM SecureString | CERT | R-CHEAP | 4 | 4.2.2 encryption at rest (KMS); 4.2.4 securely store secrets | PRACTICED | KMS, SM, SSM |

### Module F — Load balancing, scaling, DNS (3)

| ID | Title | Skill | Exec | Domain | Objective | Coverage | Source |
|---|---|---|---|---|---|---|---|
| AWS-022 | ALB, target groups, and health checks | CERT | R-CTRL | 2 | 2.2.1 Configure and troubleshoot ELB and Route 53 health checks | PRACTICED | ELB |
| AWS-023 | Launch templates, Auto Scaling groups, scaling policies | CERT | R-CTRL | 2 | 2.1.1 Scaling mechanisms in compute environments | PRACTICED | ASG |
| AWS-024 | Route 53 records and routing policies | CERT | R-CTRL | 5 | 5.2.2 Route 53 routing policies, configurations, query logging | INTRODUCED | R53 |

### Module G — Observability (3) · *C3, C5 applied*

| ID | Title | Skill | Exec | Domain | Objective | Coverage | Source |
|---|---|---|---|---|---|---|---|
| AWS-025 | Metrics, composite alarms, dashboards, SNS notifications | CERT | R-CHEAP | 1 | 1.1.3 alarms incl. composite; 1.1.4 dashboards; 1.1.5 SNS notifications | PRACTICED | CW, SNS |
| AWS-026 | CloudWatch Logs, Logs Insights, and VPC Flow Logs | CERT | R-CHEAP | 1, 5 | 1.1.1 monitoring and logging; 5.3.2 interpret networking logs | PRACTICED | CW, VPC |
| AWS-027 | Reconstruct an incident from CloudTrail | CERT | SIM | 4 | 4.1.2 Troubleshoot and audit access issues using CloudTrail | ADVANCED | CT |

### Module H — Decoupling and serverless (4) · *C2 applied*

| ID | Title | Skill | Exec | Domain | Objective | Coverage | Source |
|---|---|---|---|---|---|---|---|
| AWS-028 | SQS: visibility timeout and dead-letter queues | **PROD** | R-CHEAP | — | *none — DVA-C02 territory* | — | SQS |
| AWS-029 | SNS → SQS fan-out | **PROD** | R-CHEAP | — | *none* | — | SNS, SQS |
| AWS-030 | Lambda: execution role, packaging, SQS trigger | CERT | R-CHEAP | 3 | 3.2.2 Event-driven automation (Lambda) | PRACTICED | LAM |
| AWS-031 | EventBridge: rules, targets, event-driven remediation | CERT | R-CHEAP | 1, 3 | 1.2.2 EventBridge routing and bus-rule troubleshooting; 3.2.2 event-driven automation | PRACTICED | EVB |

### Module I — Data and containers (4)

| ID | Title | Skill | Exec | Domain | Objective | Coverage | Source |
|---|---|---|---|---|---|---|---|
| AWS-032 | RDS: create, back up, restore point-in-time, Multi-AZ | CERT | R-CTRL | 2 | 2.2.2 fault-tolerant Multi-AZ; 2.3.2 point-in-time restore for RTO/RPO | PRACTICED | RDS |
| AWS-033 | ECR: build, push, and scan an image | CERT | R-CHEAP | 3 | 3.1.1 Create and manage AMIs and **container images** | PRACTICED | ECR |
| AWS-034 | ECS on Fargate: task definition and service | **PROD** | R-CTRL | — | *none — ECS appears in SOA-C03 only under 1.1.2 monitoring* | — | ECS |
| AWS-035 | EKS concepts, and when EKS is the wrong answer | **PROD** | SIM | — | *none — judgement, not an objective* | — | EKS |

### Module J — Compliance and capstone (2) · *C4 applied*

| ID | Title | Skill | Exec | Domain | Objective | Coverage | Source |
|---|---|---|---|---|---|---|---|
| AWS-036 | Triage AWS Config and Trusted Advisor findings | CERT | R-CHEAP | 4 | 4.1.4 remediation from Trusted Advisor security checks; 4.1.5 compliance and continuous monitoring (Config) | PRACTICED | CFG, TA |
| AWS-037 | Capstone: the three-tier application will not serve traffic | CERT | R-CTRL | 5, 2 | 5.3.1 Troubleshoot VPC configurations; 2.2.1 troubleshoot ELB health checks | **ASSESSMENT** | VPC, ELB |

### Totals

| Skill class | Labs |
|---|---:|
| CERTIFICATION OBJECTIVE | 30 |
| PRODUCTION SKILL | 6 |
| FOUNDATIONAL SKILL | 1 |
| **Total** | **37** |

| Execution class | Labs |
|---|---:|
| SIMULATED | 8 |
| LOCAL | 2 |
| REAL AWS CHEAP | 16 |
| REAL AWS CONTROLLED | 11 |
| NOT ALLOWED | 0 |

**Estimated SOA-C03 coverage after C1–C5: ~70–75% at skill level** (was ~55–60%).

---

## 5. Phase 0 — the 10 labs implementable without AWS

`SIMULATED` or `LOCAL` only. No credentials, no account, no AWS API call, no CLI
against AWS, no Terraform against AWS, no CloudFormation deployment, no paid
resource. Official AWS documentation remains the source of truth.

| Order | ID | Title | Skill | Exec |
|---:|---|---|---|---|
| 1 | **AWS-001** | ARNs, the account boundary, and credential resolution | FOUND | LOCAL |
| 2 | AWS-002 | Author a least-privilege identity policy | CERT | SIM |
| 3 | AWS-003 | Explicit deny and policy evaluation order | CERT | SIM |
| 4 | AWS-004 | Roles, trust policies, and cross-account access | CERT | SIM |
| 5 | AWS-005 | `PassRole` and the privilege-escalation path | PROD | SIM |
| 6 | AWS-007 | Plan a VPC CIDR and subnet layout | CERT | SIM |
| 7 | AWS-012 | NAT concepts, alternatives, and network cost | CERT | SIM |
| 8 | AWS-018 | CloudFormation: author, repair, statically validate | CERT | LOCAL |
| 9 | AWS-027 | Reconstruct an incident from CloudTrail | CERT | SIM |
| 10 | AWS-035 | EKS concepts, and when EKS is the wrong answer | PROD | SIM |

Every Phase 0 lab must display a **simulation notice** to the student: this
environment is not an AWS account, nothing is deployed, and no AWS API is called.

---

## 6. Proposed additions NOT applied (require approval)

The three §9 policy conflicts identified objectives that are currently uncovered
because our security model forbids teaching them in a real account. Covering
them would add three `SIMULATED` labs. **Not added** — outside the approved
C1–C8 scope.

| Proposed | Objective | Why it is not in the 37 |
|---|---|---|
| IAM users, password policies, MFA | 4.1.1 (partial) | IAM users are SCP-denied in every sandbox account (spec T4/T5). Only teachable SIMULATED. |
| Organizations, SCPs, IAM Identity Center | **4.1.3 — entirely uncovered** | Cannot be practised in a member account at all. Strong candidate: JumpToTech's own sandbox architecture is an original, real multi-account case study. |
| CloudFront caching and distribution | 2.1.2, 5.2.3, 5.3.3 | Excluded from real execution on cost/abuse grounds. Only teachable SIMULATED. |

**Recommendation:** approve all three as Phase 0 `SIMULATED` labs. 4.1.3 has
**zero** coverage today, and the case study is content no competitor can copy.

**Cross-track credit (no AWS lab needed):** SOA-C03 **3.1.6** names *Terraform
and Git*. The existing Terraform track covers this. Record it in the shared
coverage matrix; do not duplicate it here.

---

## 7. Registers — recorded, not acted on

### 7.1 CROSS-TRACK FINDING — Docker / DCA

> **CROSS-TRACK FINDING:** Existing Docker labs claiming DCA certification need
> official-source review. Eight labs under `labs/docker/` carry
> `certification: [{ certification: DCA, relevant: true, domains: [...] }]` with
> free-form domain slugs (`image-creation-and-registry`, `networking`,
> `orchestration`, `installation-and-configuration`). No objective text, no
> objective version, no `last_verified`. Whether the Docker Certified Associate
> programme and these objectives are current was **not** verified — that is the
> Docker owner's call.
> **Owner:** Docker track. **Not edited from this branch.**

### 7.2 Documentation host allow-list gaps

Recorded for the central authoritative-source policy update. **Not modified from
this branch.**

| Track | Policy-mandated official source | Present in `OFFICIAL_DOC_HOSTS`? |
|---|---|---|
| kubernetes | `training.linuxfoundation.org` (CKA objectives) | ❌ |
| kubernetes | `github.com/cncf` (curriculum repo) | ❌ (only `github.com/kubernetes`) |
| linux | `systemd.io` | ❌ |
| linux | `freedesktop.org` (systemd man pages) | ❌ |
| linux | `openssh.com` | ❌ |
| networking (future) | `rfc-editor.org`, `iana.org` | ❌ |
| CS fundamentals (future) | `docs.python.org`, `git-scm.com`, `postgresql.org`, `unicode.org` | ❌ |
| aws | `d1.awsstatic.com` (exam guide PDFs) | ❌ — low priority; the HTML guide on `docs.aws.amazon.com` is allowed and preferred |
| aws | `docs.aws.amazon.com`, `aws.amazon.com` | ✅ — **the AWS track needs no change** |

### 7.3 Approved implementation gates

- **GATE A — OFFICIAL SOURCE:** confirm the current official objective, the
  official AWS technical documentation, and the correct classification.
- **GATE B — EXECUTION SAFETY:** classify SIMULATED / LOCAL / REAL AWS CHEAP /
  REAL AWS CONTROLLED / PROHIBITED.
- **GATE C — REAL AWS SECURITY:** account isolation approved · STS credential
  model approved · SCP/guardrail design approved · preventative cost controls
  approved · cleanup engine implemented · independent cleanup verification
  implemented · quarantine lifecycle implemented · cross-student isolation
  tested · credential expiration tested · abuse threat model tested.

**Until Gate C is complete: no real AWS lab implementation.** 27 of the 37 labs
are behind Gate C.

---

## 8. First Phase 0 lab — proposal

| Field | Value |
|---|---|
| **LAB ID** | `AWS-001` |
| **TITLE** | ARNs, the account boundary, and credential resolution |
| **SOA-C03 DOMAIN** | — (none) |
| **OFFICIAL OBJECTIVE** | **None.** Classified **FOUNDATIONAL SKILL**. No SOA-C03 task statement covers ARN anatomy or the CLI credential provider chain, and the lab must not claim one. |
| **CLASSIFICATION** | FOUNDATIONAL SKILL |
| **EXECUTION CLASS** | **LOCAL** — real tooling runs in the existing container sandbox; nothing reaches AWS |
| **OFFICIAL SOURCES** | AWS General Reference — Amazon Resource Names (ARNs); AWS CLI User Guide — configuration and credential precedence; IAM User Guide — identifiers. *Each page must be opened and its exact URL recorded at authoring time (policy §10 step 3).* |
| **WHAT THE STUDENT ACTUALLY DOES** | A JumpToTech Bank on-call scenario. The sandbox contains a populated `~/.aws/config`, `~/.aws/credentials`, exported environment variables, and an inventory of ARNs from a change ticket. Three tasks: **(1)** determine which credential source the CLI would actually use for a given command and record the winning source and profile; **(2)** identify which ARNs in the inventory are malformed and why — wrong partition, missing region for a regional service, account id in a global-service ARN, wrong resource-type separator; **(3)** repair the misconfigured profile so the intended profile would win. Reasoning is the work: precedence order is a documented chain, and ARN structure is service-dependent. |
| **HOW IT IS VERIFIED** | Existing `filesystem` family only — `file_exists`, `file_content` (`contains`), `file_content_absent` on canonical, unambiguous tokens (profile names, ARN partitions, source names) copied from fixtures rather than free-written. Optionally `command_output` with the already-allow-listed `grep`. **No new requirement type.** |
| **FILES TO MODIFY** | `labs/aws/track.yaml` (new) · `labs/aws/aws-001-identity-and-arns/lab.yaml` (new) · `labs/aws/aws-001-identity-and-arns/setup/*` (new fixtures) — **plus three shared test files, see below** |
| **NEW REQUIREMENT TYPES** | **NONE** ✅ |
| **SHARED PLATFORM CHANGES** | **REQUIRED** ❌ — see §9 |

**Provider note.** The lab would declare `track: aws` with
`environment.provider: linux`. This is legal — the loader validates capability
by *provider*, never by track, and the schema comments state nothing maps a
track to a provider. `PROVIDER_REQUIREMENT_FAMILIES.linux = ['filesystem',
'linux']` and `setup.files` are permitted for container-isolated providers.
`PROVIDER_REQUIREMENT_FAMILIES.aws = []`, so the `aws` provider still cannot
verify anything — and it stays disabled and untouched. The lab text must state
that the environment is a local sandbox, not an AWS account.

---

## 9. STOP — the first lab requires a shared platform change

Adding **any** lab under `labs/aws/` creates a fifth track. The lab registry
discovers tracks from disk, and three shared test suites assert the current
four-track catalogue **against the real `labs/` directory**
(`LABS_DIR = <repo>/labs`, `services/lab-orchestrator/test/helpers.ts:15`):

| File | Assertion that breaks |
|---|---|
| `services/lab-orchestrator/test/lab-catalog.test.ts:178–180` | `tracks.map(t => t.track)` → `['kubernetes','docker','linux','terraform']`; titles; `labCount` → `[12,10,10,1]`; and the full lab-id enumeration above it |
| `apps/api/test/catalog-api.test.ts:130` and `:367` | the same track list twice, plus `GET /api/tracks` → `count` **`toBe(4)`** |
| `apps/api/test/multi-track-api.test.ts:133–142` | sorted track list and per-track lab counts |

Two things make this a shared change rather than routine content work:

1. **It alters an observable API contract.** `GET /api/tracks` returns
   `count: 4` today and would return `5`. Every catalogue client sees it.
2. **The three files are cross-track.** They pin Kubernetes, Docker, Linux and
   Terraform data in the same assertions. Editing them from `claude/aws` means
   touching other tracks' expectations, and — with parallel worktrees on the
   same commit — inviting a conflict.

Per the standing instruction — *"If a shared platform change is required,
STOP"* — **no lab has been created.**

### Requested shared-platform contract §7.7 — data-driven catalogue tests

- **CURRENT BEHAVIOR** — three shared suites hard-code the track list, the
  per-track lab counts, and the full lab-id enumeration, read from the real
  `labs/` directory.
- **PROBLEM** — **no track can add its first lab, and no track can add any lab,
  without editing shared cross-track test files.** This is a structural
  coordination bottleneck: it will block the AWS track's first lab, and it
  already forces every track owner into the same three files for routine content
  additions.
- **PROPOSED CONTRACT** — make the catalogue assertions derive from the labs
  directory (assert *invariants* — every discovered track appears, ordering
  follows `track.yaml`, counts match what was discovered) rather than restating
  a snapshot. Keep one deliberately-pinned snapshot test if a canary is wanted,
  in a single agreed location that names its update procedure.
- **FILES AFFECTED** — the three test files above.
- **OTHER TRACKS AFFECTED** — all four, positively: they stop colliding.
- **BACKWARD COMPATIBILITY** — test-only; no production code path changes.
- **SECURITY IMPACT** — none.
- **DECISION NEEDED** — either (a) adopt §7.7 centrally, then AWS-001 proceeds
  with zero shared changes; or (b) explicitly authorise this branch to update
  the four-track assertions to five; or (c) hold the AWS track until the central
  contract work lands.

**Recommendation: (a).** It is the smaller long-term cost and it unblocks every
track, not just this one.
