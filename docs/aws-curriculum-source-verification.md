# AWS MVP Curriculum — Official-Source Policy Review

**Applies:** Official-Source Curriculum Policy (mandatory) · **Branch:** `claude/aws`
**Reviewed artefact:** [`aws-production-security-spec.md`](aws-production-security-spec.md) §10 — the 35-lab AWS MVP curriculum
**Date of source verification:** 2026-08-23
**Status:** review only. No lab implemented. No AWS resource, credential, or account. No commit, no push.

**Method:** every certification claim below was read from `aws.amazon.com` or
`docs.aws.amazon.com` during this pass. No exam dump, no third-party training
catalogue, no blog, and no video was consulted, and none is cited.

---

## 0. Headline finding

**The curriculum was designed against the wrong certification.**

Spec v1 §12.1 named *"Solutions Architect Associate, DevOps Engineer
Professional"* as the alignment. Verification of the current official
certification catalogue shows:

- **AWS Certified SysOps Administrator – Associate (SOA-C02) no longer exists.**
  AWS retired it and replaced it with **AWS Certified CloudOps Engineer –
  Associate (SOA-C03)**. The last day to take SOA-C02 was **September 29, 2025**.
- **SOA-C03 is the correct primary alignment for this MVP**, not SAA-C03. Its
  target candidate is *"CloudOps engineers… deploy, manage, and operate workloads
  on AWS"* — which is what a DevOps/cloud engineer does, and what our labs teach.
  SAA-C03 validates *design* ability; our labs are operational.

This is exactly the failure mode the policy exists to prevent, caught before a
single lab was written. The curriculum is **re-aligned to SOA-C03 primary,
SAA-C03 secondary, DOP-C02 as the long-term target** for the 122-lab roadmap.

A second, structural finding is in §9: **several current official objectives
cannot be taught in a real leased sandbox account**, because our own security
model forbids the actions they require. Those must be `SIMULATED` or the
security model must change. This is reported, not silently resolved.

---

## 1. Objectives confirmed from official sources

### 1.1 The current AWS certification catalogue

Read from the official exam-guide index
(`docs.aws.amazon.com/aws-certification/latest/examguides/aws-certification-exam-guides.html`),
verified 2026-08-23:

| Level | Certification | Code |
|---|---|---|
| Foundational | AWS Certified AI Practitioner | AIF-C01 |
| Foundational | AWS Certified Cloud Practitioner | CLF-C02 |
| Associate | **AWS Certified CloudOps Engineer – Associate** | **SOA-C03** |
| Associate | AWS Certified Data Engineer – Associate | DEA-C01 |
| Associate | AWS Certified Developer – Associate | DVA-C02 |
| Associate | AWS Certified Machine Learning Engineer – Associate | MLA-C01 |
| Associate | **AWS Certified Solutions Architect – Associate** | **SAA-C03** |
| Professional | **AWS Certified DevOps Engineer – Professional** | **DOP-C02** |
| Professional | AWS Certified Generative AI Developer – Professional | AIP-C01 |
| Professional | AWS Certified Solutions Architect – Professional | SAP-C02 |
| Specialty | AWS Certified Advanced Networking – Specialty | ANS-C01 |
| Specialty | AWS Certified Security – Specialty | SCS-C03 |

Bold = in scope for this curriculum.

### 1.2 SOA-C03 content domains and weightings — confirmed verbatim

Source: `docs.aws.amazon.com/aws-certification/latest/sysops-administrator-associate-03/`

| Domain | Weight |
|---|---:|
| 1 — Monitoring, Logging, Analysis, Remediation, and Performance Optimization | 22% |
| 2 — Reliability and Business Continuity | 22% |
| 3 — Deployment, Provisioning, and Automation | 22% |
| 4 — Security and Compliance | 16% |
| 5 — Networking and Content Delivery | 18% |

Exam mechanics confirmed: 50 scored questions plus 15 unscored; scaled score
100–1,000; **minimum passing score 720**; compensatory scoring (no per-domain
pass requirement).

### 1.3 SOA-C03 task statements — confirmed verbatim

**Domain 1 — Monitoring, Logging, Analysis, Remediation, and Performance Optimization (22%)**

- **Task 1.1:** Implement metrics, alarms, and filters by using AWS monitoring and logging services.
  - 1.1.1 CloudWatch / CloudTrail / Amazon Managed Service for Prometheus for serverless, compute, AI workloads
  - 1.1.2 CloudWatch agent on EC2, ECS, EKS
  - 1.1.3 CloudWatch alarms invoking services directly or via EventBridge; composite alarms
  - 1.1.4 Customizable, shareable dashboards across accounts and Regions
  - 1.1.5 SNS notifications from AWS services and alarms
- **Task 1.2:** Identify and remediate issues by using monitoring and availability metrics.
  - 1.2.1 Analyze performance metrics; automate remediation (CloudWatch, Lambda, Systems Manager, CloudTrail)
  - 1.2.2 EventBridge to route, enrich, deliver events; troubleshoot event bus rules
  - 1.2.3 Custom and predefined Systems Manager Automation runbooks
- **Task 1.3:** Implement performance optimization strategies for compute, storage, and database resources.
  - 1.3.1 Optimize compute; remediate performance problems using metrics, tags, tools
  - 1.3.2 EBS performance metrics; volume type optimization for performance and cost
  - 1.3.3 S3 performance (DataSync, Transfer Acceleration, multipart, Lifecycle)
  - 1.3.4 Shared storage selection and optimization (EFS, FSx, S3 Files)
  - 1.3.5 RDS metrics (Performance Insights, alarms), RDS Proxy
  - 1.3.6 EC2 instances with associated storage and networking (placement groups)

**Domain 2 — Reliability and Business Continuity (22%)**

- **Task 2.1:** Implement scalability and elasticity.
  - 2.1.1 Scaling mechanisms in compute environments
  - 2.1.2 Caching (CloudFront, ElastiCache)
  - 2.1.3 Scaling in managed databases (RDS, DynamoDB)
- **Task 2.2:** Implement highly available and resilient environments.
  - 2.2.1 ELB and Route 53 health checks — configure and troubleshoot
  - 2.2.2 Fault-tolerant systems (Multi-AZ deployments)
- **Task 2.3:** Implement backup and restore strategies.
  - 2.3.1 Automate snapshots and backups (EC2, RDS, EBS, S3, DynamoDB; AWS Backup)
  - 2.3.2 Restore databases (point-in-time) to meet RTO/RPO and cost
  - 2.3.3 Versioning for storage services (S3, FSx)
  - 2.3.4 DR procedures (backup and restore, pilot light, warm standby, active/active)

**Domain 3 — Deployment, Provisioning, and Automation (22%)**

- **Task 3.1:** Provision and maintain cloud resources.
  - 3.1.1 Create and manage AMIs and container images (EC2 Image Builder)
  - 3.1.2 Create and manage resources with **CloudFormation and the AWS CDK**
  - 3.1.3 Identify and remediate deployment issues (subnet sizing, CloudFormation errors, permissions)
  - 3.1.4 Provision and share across Regions and accounts (AWS RAM, CloudFormation StackSets)
  - 3.1.5 Deployment strategies and services
  - 3.1.6 Third-party automation tools (**Terraform, Git**)
- **Task 3.2:** Automate the management of existing resources.
  - 3.2.1 Automate operational processes (Systems Manager)
  - 3.2.2 Event-driven automation (Lambda, S3 Event Notifications, EventBridge)

**Domain 4 — Security and Compliance (16%)**

- **Task 4.1:** Implement and manage security and compliance tools and policies.
  - 4.1.1 IAM features (password policies, MFA, roles, federated identity, resource policies, policy conditions)
  - 4.1.2 Troubleshoot and audit access (CloudTrail, IAM Access Analyzer, **IAM policy simulator**)
  - 4.1.3 Multi-account strategies (**AWS Organizations, service control policies, IAM Identity Center**)
  - 4.1.4 Remediation from Trusted Advisor security checks
  - 4.1.5 Compliance and continuous monitoring (Region and service selections, AWS Config conformance packs)
- **Task 4.2:** Implement strategies to protect data and infrastructure.
  - 4.2.1 Data classification scheme
  - 4.2.2 Encryption at rest (AWS KMS)
  - 4.2.3 Encryption in transit (ACM)
  - 4.2.4 Securely store secrets
  - 4.2.5 Reports and findings remediation (Security Hub, GuardDuty, Config, Inspector)

**Domain 5 — Networking and Content Delivery (18%)**

- **Task 5.1:** Implement and optimize networking features and connectivity.
  - 5.1.1 Configure a VPC (subnets, route tables, NACLs, security groups, NAT gateways, IGW, egress-only IGW)
  - 5.1.2 Private connectivity (VPC endpoints, PrivateLink, peering)
  - 5.1.3 Audit network protection services (Route 53 Resolver DNS Firewall, WAF, Shield, Network Firewall)
  - 5.1.4 **Optimize the cost of network architectures**
- **Task 5.2:** Configure domains, DNS services, and content delivery.
  - 5.2.1 Configure DNS (Route 53 Resolver)
  - 5.2.2 Route 53 routing policies, configurations, query logging
  - 5.2.3 Content and service distribution (CloudFront, Global Accelerator)
- **Task 5.3:** Troubleshoot network connectivity issues.
  - 5.3.1 Troubleshoot VPC configurations
  - 5.3.2 Collect and interpret networking logs (VPC flow logs, ELB access logs, WAF logs, CloudFront logs, container logs)
  - 5.3.3 CloudFront caching issues
  - 5.3.4 Hybrid and private connectivity issues
  - 5.3.5 CloudWatch network monitoring services

### 1.4 SAA-C03 domains and weightings — confirmed

| Domain | Weight |
|---|---:|
| 1 — Design Secure Architectures | 30% |
| 2 — Design Resilient Architectures | 26% |
| 3 — Design High-Performing Architectures | 24% |
| 4 — Design Cost-Optimized Architectures | 20% |

SAA-C03 task statements were **not** fetched in this pass. **They must be read
before any lab claims an SAA-C03 objective mapping** (policy §10). Until then no
SAA mapping in §8 below is stated as confirmed.

### 1.5 SOA-C03 out-of-scope services — confirmed, and useful

AWS publishes an explicit out-of-scope list. Several entries independently
validate MVP exclusions made on *security and cost* grounds in the spec — the two
rationales agree:

Out of scope per AWS, and already excluded by us: **Amazon EMR**, **Amazon
Pinpoint**, **AWS End User Messaging SMS**, **Amazon Lightsail**, **AWS Transfer
Family**, **AWS CloudHSM**, **AWS Cloud WAN**, **Amazon Neptune**, **Amazon
Timestream**, **AWS AppConfig**.

Useful corollary: excluding them costs the curriculum **nothing** in exam
coverage. This is now a documented justification rather than an assertion.

---

## 2. Labs directly mapped to current certification objectives

24 of 35 MVP labs map to a current SOA-C03 task statement. Mapping is to the
**skill** level where the match is exact.

| Lab | Maps to | Objective |
|---|---|---|
| A2 Least-privilege identity policy | SOA-C03 4.1.1 | IAM features — policy conditions |
| A3 Explicit deny and evaluation order | SOA-C03 4.1.2 | Audit access; **IAM policy simulator** named explicitly |
| A4 Roles and trust policies | SOA-C03 4.1.1 | IAM features — roles, resource policies |
| A6 Assume a role, prove effective permissions | SOA-C03 4.1.2 | Troubleshoot and audit access issues |
| B1 CIDR and subnet plan | SOA-C03 3.1.3 | Deployment issues — **subnet sizing named explicitly** |
| B2 VPC with multi-AZ subnets | SOA-C03 5.1.1 | Configure a VPC — subnets |
| B3 IGW and route tables | SOA-C03 5.1.1 | Configure a VPC — route tables, internet gateway |
| B4 Security groups | SOA-C03 5.1.1 | Configure a VPC — security groups |
| B5 NACLs vs security groups | SOA-C03 5.1.1 | Configure a VPC — network ACLs |
| B6 NAT concepts and cost | SOA-C03 5.1.4 | **Optimize the cost of network architectures** |
| B7 Networking troubleshooting | SOA-C03 5.3.1 | Troubleshoot VPC configurations |
| C1 Launch from an allowed AMI | SOA-C03 3.1.1 | Create and manage AMIs |
| C2 Instance profiles, IMDSv2, user data | SOA-C03 4.1.1 / 1.3.6 | IAM roles; EC2 instances |
| C3 EBS attach, resize, snapshot | SOA-C03 1.3.2 / 2.3.1 | EBS performance and volume types; automate snapshots |
| C4 SSM Session Manager | SOA-C03 3.2.1 | Automate operational processes (Systems Manager) |
| D1 Buckets, lifecycle, versioning | SOA-C03 1.3.3 / 2.3.3 | S3 Lifecycle policies; versioning for storage services |
| D3 SSE-KMS; Secrets Manager; SecureString | SOA-C03 4.2.2 / 4.2.4 | Encryption at rest (KMS); securely store secrets |
| E1 ALB, target groups, health checks | SOA-C03 2.2.1 | Configure and troubleshoot ELB health checks |
| E2 Launch templates, ASG, scaling policies | SOA-C03 2.1.1 | Scaling mechanisms in compute environments |
| E3 Route 53 records | SOA-C03 5.2.2 | Route 53 routing policies and configurations |
| F1 Metrics, alarm, SNS notification | SOA-C03 1.1.3 / 1.1.5 | Alarms; SNS notifications |
| F2 CloudWatch Logs and Logs Insights | SOA-C03 1.1.1 | Configure monitoring and logging |
| F3 CloudTrail incident reconstruction | SOA-C03 4.1.2 | Audit access issues using CloudTrail |
| G3 Lambda, execution role, SQS trigger | SOA-C03 3.2.2 | Event-driven automation (Lambda, EventBridge) |
| H1 RDS create, backups, restore, Multi-AZ | SOA-C03 2.2.2 / 2.3.2 | Fault-tolerant Multi-AZ; point-in-time restore |
| H2 ECR build, push, scan | SOA-C03 3.1.1 | Create and manage container images |
| I2 Capstone — three-tier will not serve traffic | SOA-C03 5.3.1 / 2.2.1 | Troubleshoot VPC; troubleshoot ELB health checks |

*(27 rows; four labs map to two objectives each.)*

---

## 3. Labs that are production skills, NOT current exam objectives

Per policy §4, these are labelled **PRODUCTION DEVOPS SKILL**. They stay in the
curriculum — they are valuable — but the platform must not claim they are exam
objectives.

| Lab | Why it is not an objective | Keep? |
|---|---|---|
| **A1** ARNs, account boundary, CLI credential resolution order | Foundational orientation. No SOA-C03 task statement covers ARN anatomy or the credential provider chain. | Yes — prerequisite for everything else |
| **A5** `PassRole` and the privilege-escalation path | A real and important AWS security skill. Not named in any current SOA-C03 skill; closest is 4.1.1 "roles", which does not reach escalation analysis. | Yes — high production value |
| **D2** Block Public Access and bucket-policy forensics | 4.2.5 covers remediating findings from AWS *services*; manual bucket-policy forensics is broader. Partial overlap only. | Yes |
| **G1** SQS visibility timeout and DLQs | SQS is in scope as a service, but no SOA-C03 skill names queue semantics. This is a DVA-C02 concern. | Yes — flag as DVA-relevant |
| **G2** SNS → SQS fan-out | Same. 1.1.5 covers SNS *notifications*, not fan-out architecture. | Yes |
| **H3** ECS on Fargate task and service | ECS appears in SOA-C03 only in 1.1.2 (CloudWatch agent on ECS clusters). Building an ECS service is not itself an objective. | Yes — production skill |
| **H4** EKS concepts and when EKS is the wrong answer | EKS appears only in 1.1.2. "When not to use it" is judgement, not an objective. | Yes — production skill |
| **I1** Security and cost review of a running environment | Closest is 4.1.4 (Trusted Advisor) and 4.2.5 (findings), but the lab as designed does not use those services. | Yes — **but see §7 correction C4** |

**Eight labs (23%) are production skills rather than exam objectives.** That
proportion is defensible and should be stated openly in marketing rather than
folded into an "exam prep" claim.

---

## 4. Unsupported or outdated topics

| # | Finding | Severity | Action |
|---|---|---|---|
| U1 | **Spec v1 §12.1 aligned to "Solutions Architect Associate, DevOps Engineer Professional".** SAA-C03 validates *design*; our labs are *operations*. The operations certification is SOA-C03. | **High** | Re-align: SOA-C03 primary, SAA-C03 secondary, DOP-C02 long-term. |
| U2 | **SOA-C02 is retired** (last exam day 2025-09-29), renamed AWS Certified CloudOps Engineer – Associate. Any material referring to "SysOps Administrator – Associate" as current is outdated. | **High** | Never use the SysOps name for a current objective. |
| U3 | Spec §10 says the MVP creates "a foundation for later certification preparation" without naming a certification or version. | Medium | Name SOA-C03 with a verified date, per policy §9. |
| U4 | No lab in the MVP covers **CloudFormation or CDK**, yet Domain 3 is 22% and skill 3.1.2 names both. | **High** | See §7 correction C1. |
| U5 | No lab covers **EventBridge**, named in 1.2.2 and 3.2.2. | **High** | See §7 correction C2. |
| U6 | No lab covers **VPC Flow Logs / ELB access logs**, named in 5.3.2. | Medium | See §7 correction C3. |
| U7 | No lab covers **AWS Backup**, named in 2.3.1. | Medium | v2 |
| U8 | No lab covers **DR strategies** (pilot light, warm standby, active/active), named in 2.3.4. | Medium | v2 — cheap as `SIMULATED` |
| U9 | No lab covers **CloudFront or Global Accelerator**, named in 2.1.2 and 5.2.3. | Medium | v2. Note both are on the spec's `NOT SAFE FOR MVP` list on cost grounds — a genuine tension, resolvable only as `SIMULATED`. |
| U10 | No lab covers **Trusted Advisor, Security Hub, GuardDuty, Inspector, Config conformance packs** (4.1.4, 4.1.5, 4.2.5). | Medium | See §7 correction C4. |
| U11 | No lab covers **ACM / encryption in transit** (4.2.3). | Medium | v2 — pairs naturally with E1 |
| U12 | No lab covers **EFS/FSx shared storage** (1.3.4). | Low | v2 |
| U13 | No lab covers **CloudWatch agent** (1.1.2) or **dashboards** (1.1.4). | Medium | See §7 correction C5. |
| U14 | Spec §10 assigns **cost bands with no verified pricing**. | Medium | Already flagged as §11 F2; unchanged, and correct under this policy — inventing dollar figures would violate it. |
| U15 | No MVP lab is marked **ASSESSMENT** depth; I2 is the only capstone. | Low | Acceptable for an MVP; note in the matrix. |

**No outdated *technical* content was found** — the spec's technical claims were
verified against current AWS documentation in the previous pass and re-checked
here. The outdated material was entirely in the **certification framing**.

---

## 5. Official documentation for every proposed lab

Per policy §12, we link students to official documentation rather than reproduce
it. Per policy §10, the specific deep link for each lab must be **opened and
read at authoring time**, immediately before that lab is implemented.

**Verified in this session** (opened and read; safe to cite now):

| Topic | Official source | Used by |
|---|---|---|
| SOA-C03 exam guide | `docs.aws.amazon.com/aws-certification/latest/sysops-administrator-associate-03/` | all cert mappings |
| SAA-C03 exam guide | `docs.aws.amazon.com/aws-certification/latest/solutions-architect-associate-03/` | secondary mappings |
| Certification index | `docs.aws.amazon.com/aws-certification/latest/examguides/aws-certification-exam-guides.html` | §1.1 |
| CloudOps certification page | `aws.amazon.com/certification/certified-cloudops-engineer-associate/` | §1.1, U2 |
| `SimulatePrincipalPolicy` | `docs.aws.amazon.com/IAM/latest/APIReference/API_SimulatePrincipalPolicy.html` | A2, A3, A4, A5 |
| STS `AssumeRole` | `docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html` | A6 |
| Revoke role sessions | `docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_revoke-sessions.html` | A6, platform §4 |
| Console federation | `docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_enable-console-custom-url.html` | platform §4.6 |
| VPC Block Public Access | `docs.aws.amazon.com/vpc/latest/userguide/security-vpc-bpa.html` | D2, platform §5 |
| Organizations SCPs | `docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html` | platform §5 |
| Organizations RCPs | `docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_rcps.html` | platform §5 |
| Declarative / EC2 policies | `docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_ec2.html` | C1, C2, platform §5 |
| Organizations quotas | `docs.aws.amazon.com/organizations/latest/userguide/orgs_reference_limits.html` | platform §3 |
| Service Quotas | `docs.aws.amazon.com/servicequotas/latest/userguide/request-quota-increase.html` | platform §5 |
| AWS Budgets | `docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html` and `budgets-controls.html` | platform §5 |
| Innovation Sandbox on AWS | `docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/` | platform §1, §3, §6 |

**Assigned but NOT yet opened** — each lab's authoring gate (policy §10) must
open the exact page before implementation. The canonical service guide for each:

| Lab group | Service guide root |
|---|---|
| A1, A6 | `docs.aws.amazon.com/IAM/latest/UserGuide/` · `docs.aws.amazon.com/cli/latest/userguide/` |
| A2–A5 | `docs.aws.amazon.com/IAM/latest/UserGuide/` |
| B1–B7 | `docs.aws.amazon.com/vpc/latest/userguide/` |
| C1–C4 | `docs.aws.amazon.com/AWSEC2/latest/UserGuide/` · `docs.aws.amazon.com/ebs/latest/userguide/` · `docs.aws.amazon.com/systems-manager/latest/userguide/` |
| D1–D3 | `docs.aws.amazon.com/AmazonS3/latest/userguide/` · `docs.aws.amazon.com/kms/latest/developerguide/` · `docs.aws.amazon.com/secretsmanager/latest/userguide/` |
| E1–E3 | `docs.aws.amazon.com/elasticloadbalancing/latest/application/` · `docs.aws.amazon.com/autoscaling/ec2/userguide/` · `docs.aws.amazon.com/Route53/latest/DeveloperGuide/` |
| F1–F3 | `docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/` · `docs.aws.amazon.com/awscloudtrail/latest/userguide/` |
| G1–G3 | `docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/` · `docs.aws.amazon.com/sns/latest/dg/` · `docs.aws.amazon.com/lambda/latest/dg/` |
| H1–H4 | `docs.aws.amazon.com/AmazonRDS/latest/UserGuide/` · `docs.aws.amazon.com/AmazonECR/latest/userguide/` · `docs.aws.amazon.com/AmazonECS/latest/developerguide/` · `docs.aws.amazon.com/eks/latest/userguide/` |
| I1, I2 | composite — every guide the lab touches |
| Architecture framing | `docs.aws.amazon.com/wellarchitected/latest/framework/` |

**Rule for authors:** a service-guide root is a starting point, not a citation. A
lab's `references` must carry the **specific page** that documents the behaviour
the lab verifies, opened on the recorded `last_verified` date.

---

## 6. Missing official objectives

Coverage of SOA-C03 by the 35-lab MVP, at task-statement level:

| Domain (weight) | Task statements | Covered | Gap |
|---|---:|---:|---|
| 1 — Monitoring, Logging… (22%) | 3 | 2 | 1.2 partial (no EventBridge, no SSM Automation runbooks) |
| 2 — Reliability & BC (22%) | 3 | 3 | all partial — no AWS Backup, no DR strategies, no caching |
| 3 — Deployment, Provisioning, Automation (22%) | 2 | 1 | **3.1 largely uncovered — no CloudFormation, no CDK, no StackSets** |
| 4 — Security & Compliance (16%) | 2 | 2 | no Trusted Advisor, Config, Security Hub, GuardDuty, Inspector, ACM |
| 5 — Networking & Content Delivery (18%) | 3 | 3 | no CloudFront, no Global Accelerator, no flow logs, no DNS Firewall/WAF |

**Estimated objective coverage of SOA-C03 by the MVP: ~55–60% at skill level.**

The single largest gap is **Domain 3 at 22% with no infrastructure-as-code lab.**
CloudFormation is named directly in skill 3.1.2 and indirectly in 3.1.3
("CloudFormation errors") and 3.1.4 (StackSets). A curriculum claiming SOA-C03
preparation without a CloudFormation lab has a hole in nearly a quarter of the
exam.

Second largest is the **security tooling cluster** — Trusted Advisor, Config
conformance packs, Security Hub, GuardDuty, Inspector — five named services with
no lab.

**Note:** skill 3.1.6 names **Terraform and Git** as exam content. The existing
JumpToTech Terraform track therefore already contributes to SOA-C03 coverage.
That cross-track credit should appear in the matrix rather than being duplicated
in the AWS track.

---

## 7. Recommended curriculum corrections

Corrections are stated as proposals. **No lab is added or changed on this branch.**

**C1 — Add a CloudFormation lab. Highest priority.**
New lab **`C5 — CloudFormation: template, change set, drift, and a failed stack`**.
Classification `REAL AWS CHEAP`, cost `VERY LOW` (the template provisions only
S3/SG-class resources). Maps to 3.1.2 and 3.1.3. Closes the largest gap. It also
strengthens the platform: the cleanup engine must handle `DELETE_FAILED` stacks
(spec §6.4), and this lab produces them deliberately in a controlled way.

**C2 — Add an EventBridge lab.**
New lab **`G4 — EventBridge: rules, targets, and event-driven remediation`**.
`REAL AWS CHEAP`, `VERY LOW`. Maps to 1.2.2 and 3.2.2. Pairs with G3.

**C3 — Extend F2 to cover VPC Flow Logs.**
F2 currently covers CloudWatch Logs and Logs Insights. Extending it to ingest and
query **VPC Flow Logs** maps 5.3.2 at no extra cost band and reinforces B7.

**C4 — Re-scope I1 onto named AWS services.**
I1 is currently a generic "find the exposure and the waste" lab, which maps to
nothing. Re-scoping it to **triage AWS Config and Trusted Advisor findings**
converts a production-skill lab into coverage of 4.1.4 and 4.1.5 without losing
its character. GuardDuty is deliberately excluded: findings cannot be generated
on demand in a lab.

**C5 — Extend F1 to a CloudWatch dashboard and a composite alarm.**
Maps 1.1.3 (composite alarms) and 1.1.4 (dashboards) at no additional cost.

**C6 — Re-label the alignment throughout.**
Spec §10 and §12.1 must name **SOA-C03**, with SAA-C03 secondary and DOP-C02 as
the 122-lab target. Remove every reference to the SysOps name.

**C7 — Mark the eight production-skill labs explicitly** (§3), so no lab
implicitly claims an objective it does not have.

**C8 — Read the SAA-C03 task statements before claiming any SAA mapping.**
Not done in this pass; must precede any SAA claim.

**Effect of C1–C5 on size:** 35 → **37 labs** (C1 and C2 are new; C3, C4, C5
re-scope existing labs). 37 exceeds the approved 25–35 band by two. Two options,
and the recommendation is explicit: **accept 37**, because both additions close
22%-weight and 16%-weight gaps and neither adds a cost band above `VERY LOW`.
If the band must hold, drop **H4 (EKS concepts)** and **G2 (SNS fan-out)** — the
two lowest objective-value labs in the set — returning to 35.

Estimated coverage after C1–C5: **~70–75%** of SOA-C03 at skill level.

---

## 8. Proposed certification coverage matrix

Coverage depth per policy §11: `NOT COVERED` · `INTRODUCED` · `PRACTICED` ·
`ADVANCED` · `ASSESSMENT`.

**Primary certification: AWS Certified CloudOps Engineer – Associate (SOA-C03)**
Objective source: `docs.aws.amazon.com/aws-certification/latest/sysops-administrator-associate-03/`
Verified: **2026-08-23**

| Objective | Labs | Difficulty | Depth | Official source | Verified |
|---|---|---|---|---|---|
| 1.1 Metrics, alarms, filters | F1, F2 (+C5) | beginner | PRACTICED | CloudWatch UG | 2026-08-23 |
| 1.2 Identify and remediate issues | F2, C4·I1 (+C2·G4) | intermediate | INTRODUCED | CloudWatch / EventBridge / SSM UG | 2026-08-23 |
| 1.3 Performance optimization | C3, D1 | intermediate | INTRODUCED | EBS / S3 / RDS UG | 2026-08-23 |
| 2.1 Scalability and elasticity | E2 | intermediate | PRACTICED | Auto Scaling UG | 2026-08-23 |
| 2.2 HA and resilient environments | E1, H1, I2 | intermediate | PRACTICED | ELB / RDS UG | 2026-08-23 |
| 2.3 Backup and restore | C3, D1, H1 | intermediate | INTRODUCED | EBS / S3 / RDS UG | 2026-08-23 |
| 3.1 Provision and maintain resources | C1, H2 (+C1·C5 CFN) | intermediate | **NOT COVERED → INTRODUCED** | CloudFormation UG | 2026-08-23 |
| 3.2 Automate management | C4, G3 (+C2·G4) | intermediate | INTRODUCED | SSM / Lambda UG | 2026-08-23 |
| 4.1 Security and compliance tools | A2–A6, F3 (+C4·I1) | beginner→adv | **PRACTICED** | IAM UG · policy simulator API | 2026-08-23 |
| 4.2 Protect data and infrastructure | D2, D3 | intermediate | PRACTICED | S3 / KMS / Secrets Manager UG | 2026-08-23 |
| 5.1 Networking features and connectivity | B2–B7 | beginner→int | **PRACTICED** | VPC UG | 2026-08-23 |
| 5.2 Domains, DNS, content delivery | E3 | intermediate | INTRODUCED | Route 53 DG | 2026-08-23 |
| 5.3 Troubleshoot network connectivity | B7, I2 (+C3 flow logs) | advanced | **ASSESSMENT** | VPC UG | 2026-08-23 |

Domain 4 (IAM) and Domain 5.1/5.3 (networking) are the curriculum's strengths —
`PRACTICED` to `ASSESSMENT` depth — and Domain 4 is achieved almost entirely with
`SIMULATED` labs at zero cost. Domain 3.1 is the weakness and C1 addresses it.

**Secondary: AWS Certified Solutions Architect – Associate (SAA-C03)**
Domains and weightings confirmed (§1.4). **Task statements not yet read.** No
lab may claim an SAA-C03 objective until they are.

**Long-term: AWS Certified DevOps Engineer – Professional (DOP-C02)**
Confirmed current. Target for the 122-lab roadmap. Objectives not yet read; not
claimed anywhere.

**Cross-track credit:** SOA-C03 skill 3.1.6 names **Terraform and Git**. The
existing Terraform track contributes here. The matrix should be maintained
across tracks, not per track.

---

## 9. Policy §10 STOP report — official objectives that conflict with our security model

Policy §10 requires a STOP-and-report when official documentation conflicts with
our curriculum. Three conflicts are structural: the objective is real and
current, and **our own sandbox security model forbids the actions needed to
teach it in a real account.**

---

**CONFLICT 1 — IAM users, passwords, and MFA**

- **EXISTING LAB:** none yet; would fall under Module A.
- **CURRENT BEHAVIOR (proposed):** spec §2 threats T4 and T5 deny
  `iam:CreateUser`, `iam:CreateLoginProfile`, and `iam:CreateAccessKey` by SCP
  across every sandbox account. This is deliberate and load-bearing: it is what
  makes "no long-lived credential can exist in a sandbox account" structural.
- **OFFICIAL DOCUMENTATION:** SOA-C03 skill **4.1.1** — *"Implement IAM features
  (for example, password policies, multi-factor authentication [MFA], roles,
  federated identity, resource policies, policy conditions)."*
- **CONFLICT:** password policies and MFA are IAM-user features. A student cannot
  practise them in an account where IAM users cannot exist.
- **RECOMMENDED CORRECTION:** teach the IAM-user half of 4.1.1 as a `SIMULATED`
  lab graded against policy documents and account-settings fixtures. **Do not
  relax the SCP.** The security property is worth more than the fidelity, and the
  objective is still covered — a point to state plainly in the lab text.

---

**CONFLICT 2 — Multi-account strategy, Organizations, SCPs, IAM Identity Center**

- **EXISTING LAB:** none.
- **CURRENT BEHAVIOR (proposed):** students receive a **member** account. AWS
  Organizations is managed only from the management account, and SCPs cannot be
  created or attached from a member account. Spec §2 T7/T8 additionally deny
  organization-affecting calls.
- **OFFICIAL DOCUMENTATION:** SOA-C03 skill **4.1.3** — *"Implement multi-account
  strategies securely (for example, AWS Organizations, service control policies,
  IAM Identity Center)."*
- **CONFLICT:** the objective **cannot be practised in a leased member account at
  all**, under any policy relaxation short of giving students an organization —
  which is not on the table.
- **RECOMMENDED CORRECTION:** cover 4.1.3 as `SIMULATED` — SCP authoring graded
  by policy analysis, OU-design reasoning graded against a declared model.
  **There is a strong asset here:** JumpToTech's own sandbox architecture *is* a
  production multi-account strategy with SCPs, RCPs and an account pool. Once
  built, it is original, real, and ours to teach from — an unusually credible
  case study that no third-party curriculum can copy.

---

**CONFLICT 3 — CloudFront, Global Accelerator, and cost policy**

- **EXISTING LAB:** none; both are on the spec's `NOT SAFE FOR MVP` list.
- **CURRENT BEHAVIOR (proposed):** spec §10 excludes public CloudFront
  distributions and Global Accelerator on cost and abuse grounds (T13, T19 —
  a public distribution is a phishing-hosting and egress-cost surface).
- **OFFICIAL DOCUMENTATION:** SOA-C03 skills **2.1.2**, **5.2.3**, **5.3.3**
  name CloudFront three times, including *"Identify and remediate CloudFront
  caching issues."*
- **CONFLICT:** ~3 skills across two 22%/18% domains are excluded on security
  grounds.
- **RECOMMENDED CORRECTION:** cover CloudFront caching behaviour as `SIMULATED`
  from captured response headers and distribution configuration fixtures —
  caching semantics are exactly the kind of thing a fixture teaches well. Defer
  any real distribution to v2 behind a dedicated profile. **Do not** relax the
  exclusion for the MVP.

---

**Common pattern.** All three conflicts resolve the same way: **the security
model wins, and the objective is covered by a `SIMULATED` lab.** That is a
strength of the tiered design rather than a compromise — it also means these
labs cost nothing and ship in Phase 0.

---

## 10. Schema extension — recommendation

Policy §9 asks whether a schema extension will eventually be useful, and says not
to implement one globally yet. **Answer: yes, and less is missing than expected.**

**What already exists** (`services/lab-orchestrator/src/lab-definition.ts`):

```ts
const certificationSchema = z.object({
  certification: z.string().min(1).max(32),   // e.g. "CKA", "DCA"
  relevant: z.boolean(),
  domains: z.array(z.string().min(1).max(64)).default([]),
}).strict();
```

plus `references: [{ title, url }]` (1–10, https only), an
`OFFICIAL_DOC_HOSTS` allow-list requiring **at least one official link for the
lab's track**, and a `DISALLOWED_DOC_HOSTS` ban list.

**The platform already enforces a substantial part of this policy.**
`DISALLOWED_DOC_HOSTS` bans `kodekloud.com`, `udemy.com`, `acloudguru.com`,
`pluralsight.com`, `linuxacademy.com`, `whizlabs.com`, `examtopics.com` — the
same third-party sources the policy names. `OFFICIAL_DOC_HOSTS` already lists
`docs.aws.amazon.com` and `aws.amazon.com` for the `aws` track. No change is
needed for the AWS track to comply today.

**What the policy needs that does not exist** — proposed as shared-platform
contract **§7.6** in the spec, for central coordination, **not implemented here**:

| Field | Purpose | Policy ref |
|---|---|---|
| `certification[].objective` | The current official objective, verbatim | §9 |
| `certification[].objective_version` | Exam code and guide version, e.g. `SOA-C03` | §3, §9 |
| `certification[].coverage` | `INTRODUCED` \| `PRACTICED` \| `ADVANCED` \| `ASSESSMENT` | §11 |
| `certification[].last_verified` | ISO date the objective was read | §9, §13 |
| `references[].type` | `official_documentation` \| `official_exam_guide` \| `official_specification` | §9 |
| `skill_class` (lab level) | `CERTIFICATION_OBJECTIVE` \| `PRODUCTION_SKILL` \| `FOUNDATIONAL_SKILL` | §4, §8, §13 |

Backward compatibility: all additive and optional; existing Docker and
Kubernetes labs keep loading unchanged. Security impact: none — metadata only.
Other tracks affected: none until they opt in.

**Allow-list gaps the policy creates** (report only; the AWS track is unaffected):

| Track | Policy-mandated source | In `OFFICIAL_DOC_HOSTS`? |
|---|---|---|
| kubernetes | `kubernetes.io` | ✅ |
| kubernetes | `training.linuxfoundation.org` (CKA objectives) | ❌ — permitted but does not satisfy the "official link" requirement |
| kubernetes | `github.com/cncf` (curriculum repo) | ❌ — only `github.com/kubernetes` is listed |
| terraform | `developer.hashicorp.com` | ✅ (covers both docs and the Associate review page) |
| linux | `systemd.io`, `freedesktop.org`, `openssh.com` | ❌ — all three mandated by policy §5, none listed |
| docker | `docs.docker.com` | ✅ |
| aws | `docs.aws.amazon.com`, `aws.amazon.com` | ✅ |
| aws | `d1.awsstatic.com` (exam guide PDFs) | ❌ — prefer the HTML guide on `docs.aws.amazon.com`, so low priority |
| networking | `rfc-editor.org`, `iana.org` | ❌ — policy §7 |
| CS fundamentals | `docs.python.org`, `git-scm.com`, `postgresql.org`, `unicode.org` | ❌ — policy §8; no such track exists yet |

These are **other tracks' concerns** and belong in the central coordination queue,
not on `claude/aws`.

---

## 11. Compliance status of this branch

| Policy section | Status |
|---|---|
| §1 Official sources only | ✅ Every source in the spec and this review is `aws.amazon.com` / `docs.aws.amazon.com`. No dumps, no third-party training material, no blogs. |
| §4 AWS official sources | ✅ Docs, Organizations, IAM, Service Quotas, Well-Architected, official exam guides. |
| §4 Certification vs production skill | ✅ Now separated — §2 and §3 above. |
| §9 Source metadata | ⚠️ Documented here; schema extension proposed, not implemented (per §9's own instruction). |
| §10 Verify before implementing | ✅ No lab implemented. Authoring gate defined in §5. |
| §10 Report conflicts | ✅ Three STOP reports in §9. |
| §11 Coverage matrix | ✅ Proposed in §8. |
| §12 Original content | ✅ No exam question, third-party lab, or bulk documentation reproduced. Objectives are quoted as objectives — the minimum needed to prove mapping — and everything else links out. |
| §13 Freshness | ✅ `last_verified: 2026-08-23` recorded; SOA-C02 retirement caught. |

---

## Next step

Per the standing instruction, **no additional labs are designed or implemented**.

Two items need a decision before the one-lab-at-a-time authoring workflow can
start on the AWS track:

1. **Approve or amend corrections C1–C8** (§7), in particular whether the MVP
   grows to 37 labs or drops H4 and G2 to stay at 35.
2. **Confirm the one-lab-at-a-time workflow's entry gate for AWS.** The workflow
   referenced in review has not been established in this session for this track.
   Proposed gate, per policy §10, to be applied per lab:

   ```
   1. name the objective (or mark PRODUCTION_SKILL / FOUNDATIONAL_SKILL)
   2. open and read the current official objective
   3. open and read the specific official technical documentation
   4. confirm the task actually teaches the objective
   5. verify every command, API and resource behaviour against current docs
   6. record sources + last_verified
   7. only then write the lab
   ```

   Note the ordering constraint this creates: **the first eleven AWS labs must be
   the `SIMULATED` ones** (spec §10 Phase 0), because every `REAL AWS` lab is
   blocked behind spec §13 Gates A–G, and Gate C — proven cleanup — is not
   negotiable.
