# JumpToTech Labs — AWS Track Production Security Specification

**Version:** 1.0 (specification) · **Branch:** `claude/aws` · **Status:** design only

**Nothing in this document is implemented.** No AWS account, organization, IAM
role, SCP, credential, or resource exists or is created by this branch. No AWS
API has been called. No AWS CLI has been run. The only network access used to
produce this document was reading published AWS documentation (§11).

**Supersedes** the architecture analysis in
[`aws-track-architecture.md`](aws-track-architecture.md), which is retained but
carries two now-corrected factual errors (see the banner on that file).

**Approved direction (from review):**

```
AWS Organizations → sandbox account pool → temporary account lease
→ temporary credentials → strict guardrails → automatic cleanup
→ independent cleanup verification → quarantine on cleanup failure
→ return clean account to pool
```

This document specifies that direction to the level of detail required before
provider code is written.

### Corrections to v1

| v1 claim | Corrected | Impact |
|---|---|---|
| "AWS caps closures at ~10% of accounts in a rolling window" | **20% of member accounts or 250, whichever is higher, max 1,000, per 30 days — not adjustable** | The closure quota is *less* of a constraint than v1 said. The binding constraints on per-session account creation are different ones (§11 F3) — the conclusion (use a pool) is unchanged, the reasoning is corrected. |
| "Reduce per-account service quotas — a hard technical ceiling" as a **primary** control | Service Quotas documents **increases only**; the console flow states the new value *must be greater* than the current value. Decreases are service-dependent and go through Support. | **A primary cost control from v1 does not exist as specified.** Replaced by: inherit low new-account defaults, and **deny the student the ability to request increases** (§5). |
| "SCP size limit 5,120 bytes, 5 per target" | **SCP: 10,240 characters, 10 per target.** 5,120/5 are the **RCP** numbers. | Allow-list SCPs are more feasible than v1 implied, though still not the recommended shape (§5). |
| v1 did not use RCPs or declarative policies | Both exist and are directly applicable | Materially strengthens the containment story (§2, §5). |

---

## Contents

1. [Recommended AWS sandbox architecture](#1-recommended-aws-sandbox-architecture)
2. [Threat model](#2-threat-model)
3. [Account lifecycle](#3-account-lifecycle)
4. [Credential architecture](#4-credential-architecture)
5. [Preventative cost controls](#5-preventative-cost-controls)
6. [Cleanup architecture](#6-cleanup-architecture)
7. [Shared-platform contracts requested](#7-shared-platform-contracts-requested)
8. [Provider interface](#8-provider-interface)
9. [Verifier design](#9-verifier-design)
10. [MVP curriculum — 35 labs](#10-mvp-curriculum--35-labs)
11. [Verified AWS assumptions](#11-verified-aws-assumptions)
12. [Unresolved risks](#12-unresolved-risks)
13. [Prerequisites before any AWS implementation](#13-prerequisites-before-any-aws-implementation)

---

## 1. Recommended AWS sandbox architecture

### 1.1 Independent validation

The approved direction is not novel, and that is a point in its favour. AWS
publishes a solution — **Innovation Sandbox on AWS** — implementing the same
shape: a pool of sandbox accounts, lease-based allocation, an Account Cleaner
that runs AWS Nuke in a retry loop, and **quarantine on cleanup failure with
manual remediation before an account may return to the pool** (§11 A1).

Consequences for this specification:

- The lifecycle state machine in §3 is aligned to that solution's states rather
  than invented, including two states v1 missed (`Frozen`, `Exit`).
- Its Account Cleaner is a **reference for the hardest subsystem** (§6) — the
  retry-loop-until-stable pattern and the "cleanup creates resources too"
  problem (snapshots, logs, `OnDelete` custom resources) are things it already
  solved.
- Whether to adopt the solution, fork it, or build the equivalent is a §13
  decision. This spec assumes **build the control plane, model the cleaner on
  the published design** — because leases must be owned by the JumpToTech
  session state machine, not by a second scheduler with its own idea of expiry.

### 1.2 Organization design

```text
                        ┌──────────────────────────────────────┐
                        │  ROOT — JumpToTech Organization      │
                        │  Management account                  │
                        │  · no workloads, no daily humans     │
                        │  · MFA + break-glass only            │
                        │  · SCPs and RCPs DO NOT APPLY HERE   │
                        └──────────────────┬───────────────────┘
                                           │
   ┌──────────────┬──────────────┬─────────┴────────┬──────────────┬─────────────┐
   ▼              ▼              ▼                  ▼              ▼             ▼
┌─────────┐  ┌──────────┐  ┌──────────────────────────────┐  ┌──────────┐  ┌────────┐
│Security │  │Infra-    │  │      Sandbox (parent OU)     │  │Sandbox-  │  │Sandbox-│
│OU       │  │structure │  │  guardrail SCP/RCP/declara-  │  │Quarantine│  │Exit    │
│         │  │OU        │  │  tive policies attach HERE   │  │OU        │  │OU      │
│log-     │  │api, db,  │  │  and are inherited by all    │  │          │  │        │
│archive  │  │terminal, │  │  child OUs — one authoring   │  │deny-all  │  │released│
│audit    │  │orchestr. │  │  point, no drift between     │  │pending   │  │from the│
│         │  │          │  │  pool states                 │  │human     │  │pool    │
└─────────┘  └──────────┘  │  ┌────────┬────────┬───────┐ │  └──────────┘  └────────┘
                           │  │ Ready  │ Leased │Cleanup│ │
                           │  │  OU    │  OU    │  OU   │ │
                           │  └────────┴────────┴───────┘ │
                           └──────────────────────────────┘
```

**Why this structure rather than the one sketched in review.** The review sketch
put `Sandbox-Ready`, `Sandbox-Leased` and `Sandbox-Quarantine` as siblings under
the root. Three changes:

1. **A parent `Sandbox` OU with the state OUs nested inside it.** Guardrails are
   authored once on the parent and inherited, so a `Ready` account and a `Leased`
   account cannot drift apart in policy. If the state OUs are siblings, every
   guardrail must be attached three times and stay in sync — an SCP attached to
   two of three OUs is a silent hole. Nesting is supported: **five levels deep**
   is the documented maximum (§11 A2), and this uses two.
2. **`Quarantine` and `Exit` are siblings of `Sandbox`, not children.** A
   quarantined account must *lose* the sandbox guardrails and *gain* a deny-all
   — that is a different policy set, not a stricter one, so it belongs outside
   the inheritance path. `Exit` exists because an account sometimes has to leave
   the pool permanently (preserved evidence, a problem account, downsizing) and
   needs a boundary OU to land in.
3. **A separate `Security` OU holding the log-archive account.** Audit data must
   not live where the control plane can be compromised into deleting it.

**Where policies attach:**

| Policy type | Attach point | Purpose |
|---|---|---|
| SCP (guardrails) | `Sandbox` parent OU | Bound what student principals may do. 10,240 chars, up to 10 policies (§11 B1) |
| SCP (deny-all) | `Sandbox-Quarantine` OU | Freeze a failed account |
| RCP | `Sandbox` parent OU | Bound what *external* principals may do to student resources — closes the public-exposure and cross-org-sharing paths SCPs cannot reach (§11 B2) |
| Declarative policies (EC2) | `Sandbox` parent OU | Enforce VPC BPA, Allowed AMIs, IMDSv2 defaults, AMI/snapshot public-access blocks — *in the service control plane*, and unlike SCP/RCP these **do govern service-linked roles** (§11 B3) |
| Budget action SCP | per account | Cost backstop (§5) |

**Critical structural fact:** SCPs and RCPs **do not apply to the management
account** (§11 B1, B2). The management account is therefore not a place where
anything runs. The control plane lives in the `Infrastructure` OU, under
guardrails of its own.

### 1.3 Component map

```text
  ┌── Infrastructure OU ──────────────────────────────────────────────┐
  │  api / lab-orchestrator / terminal        (existing services)     │
  │  ┌─────────────────────────────────────────────────────────────┐  │
  │  │ NEW, all design-only:                                       │  │
  │  │  AwsAccountPool     leases; durable (Postgres); source of   │  │
  │  │                     truth reconciled against account tags   │  │
  │  │  AwsCredentialMinter the ONLY component that holds a cred   │  │
  │  │  AwsJanitor          discover → delete → re-discover →      │  │
  │  │                      verify → quarantine-on-fail            │  │
  │  │  AwsAbuseResponder   central EventBridge consumer; may end  │  │
  │  │                      a session with no human in the loop    │  │
  │  │  AwsLabProvider      implements LabProvider (§8)            │  │
  │  │  AwsVerifyReader     read-only, separate role (§9)          │  │
  │  └─────────────────────────────────────────────────────────────┘  │
  └───────────────────────────────────────────────────────────────────┘
                    │ sts:AssumeRole (org access, ExternalId)
                    ▼
  ┌── Sandbox OU ─────────────────────────────────────────────────────┐
  │  Per-account baseline, applied by StackSet at vend AND at every    │
  │  recycle — the account never holds the template defining its own   │
  │  guardrails:                                                       │
  │   · JumpToTechLabRole       + permissions boundary  (student)      │
  │   · JumpToTechJanitorRole                            (cleanup)     │
  │   · JumpToTechVerifierRole  read-only                (grading)     │
  │   · lab-profile managed policies (session policies by ARN — §4.3)  │
  │   · CloudTrail → Security OU archive; GuardDuty; Config            │
  │   · Budget + budget action; EventBridge → central bus              │
  │   · account tags: pool-state / lease-session-id / lease-expires-at │
  └───────────────────────────────────────────────────────────────────┘
```

### 1.4 Tiering — what never touches an account

Restated because it drives §10: **the majority of high-value AWS teaching does
not require an AWS account.** IAM policy work is gradable by `SimulatePrincipalPolicy`,
which "does not perform the API operations; it only checks the authorization"
(§11 D1). Design, CIDR planning, cost reasoning and log/trail forensics are
gradable from fixtures. Those labs cost nothing, carry no abuse surface, run at
unlimited concurrency, and ship before any AWS account exists.

---

## 2. Threat model

Actor assumption: **a paying but untrusted student who is deliberately trying to
break out.** Payment is friction, not trust. Every threat below is assumed to be
attempted.

Notation: **P**revention · **D**etection · **C**ontainment · **CL**eanup ·
**RR** = residual risk.

---

**T1 — Escape IAM restrictions (generic escalation)**

- **Attack path:** Enumerate the lab role's permissions; find any action that
  can widen them — create a role, attach a policy, edit a trust policy, use a
  service that acts with a different identity.
- **P:** Three independent layers that must *all* allow: SCP on the Sandbox OU ∩
  permissions boundary on `JumpToTechLabRole` ∩ session policy at assume time.
  SCP denies `iam:*` writes on principals under the platform IAM path and denies
  removing a permissions boundary. Boundary denies writes to its own policy.
- **D:** CloudTrail `AccessDenied` volume per session; a spike is boundary
  probing. Central EventBridge rule on repeated denies.
- **C:** The account is the boundary. A total IAM escape still leaves the
  attacker inside one disposable account under an SCP that IAM cannot override
  (SCPs bound the member-account **root user** itself — §11 B1).
- **CL:** Full nuke; the account never returns to the pool without verification.
- **RR:** **Medium.** SCPs do not restrict **service-linked roles** (§11 B1) or
  the management account. A novel escalation through a service-linked role is
  the live residual. Declarative policies *do* govern service-linked roles
  (§11 B3) and are the only lever there — which is why they are in the baseline.

---

**T2 — Create expensive resources**

- **Attack path:** Launch large instance families, GPU/accelerated instances,
  provisioned-IOPS storage, dedicated hosts, managed services with hourly floors
  (EKS control planes, NAT gateways, Global Accelerator, Redshift, SageMaker).
- **P:** Allow-list by **shape, not by service name** in the boundary and session
  policy: `ec2:InstanceType` conditions pinning a short list of small current-gen
  types; deny `ec2:RunInstances` for anything else; deny the expensive services
  outright at SCP. The MVP session policy grants ~12 services, not "EC2".
- **D:** CloudTrail on denied `RunInstances`; GuardDuty; Cost Anomaly Detection.
- **C:** Budget action attaches a deny policy at threshold; lease TTL is short.
- **CL:** Janitor terminates and deletes; TTL-tag sweeper as in-account backstop.
- **RR:** **Medium-low, with a latency caveat.** Budgets update **up to three
  times a day, typically 8–12 hours apart**, and AWS documents an explicit delay
  between incurring a charge and the notification (§11 C1). Budgets cannot stop
  a fast attack; only the allow-list can. Loss is bounded by
  `allow-listed shapes × lease TTL`, computed per profile in §5.4.

---

**T3 — Crypto-mining**

- **Attack path:** T2 at scale, or mining inside allowed small instances /
  Lambda / Fargate / CodeBuild; a mining AMI or container image; many concurrent
  sessions.
- **P:** Instance-type allow-list; **Allowed Images Settings** declarative policy
  restricting which AMIs are even discoverable (§11 B3); Lambda concurrency and
  timeout bounded by the profile; per-student concurrent-session cap; progressive
  trust for new accounts.
- **D:** GuardDuty crypto-currency findings; CPU-saturation alarms; egress to
  mining pool ranges; spend velocity per student.
- **C:** `AwsAbuseResponder` ends the session and moves the account to
  `Sandbox-Quarantine` (deny-all SCP) without human approval.
- **CL:** Nuke + verify; account may be permanently retired via `Exit` OU.
- **RR:** **Low-medium.** Mining is *profitable at any scale*, so the economic
  control is the per-student lifetime spend cap, not the per-session one.

---

**T4 — Create IAM users**

- **Attack path:** `iam:CreateUser` to obtain a principal that survives the
  session.
- **P:** SCP denies `iam:CreateUser`, `iam:CreateLoginProfile`. Not merely
  omitted from the boundary — **explicitly denied at the OU**, so no identity
  policy anywhere in the account can permit it.
- **D:** CloudTrail denied `CreateUser`.
- **C:** N/A — prevented.
- **CL:** Janitor deletes any IAM user found (defence against a boundary gap).
- **RR:** **Very low.**

---

**T5 — Create access keys**

- **Attack path:** `iam:CreateAccessKey` on any principal — the highest-value
  persistence primitive in AWS, because a static key survives session teardown.
- **P:** SCP denies `iam:CreateAccessKey` and `iam:UpdateAccessKey` account-wide.
- **D:** CloudTrail denied.
- **C:** N/A — prevented.
- **CL:** Janitor enumerates and deletes access keys before returning the account.
- **RR:** **Very low.** This is the single most important SCP statement in the
  design: it makes "no long-lived credential can exist in a sandbox account" a
  structural property rather than a policy hope.

---

**T6 — Create roles**

- **Attack path:** Create a role with a fat policy and assume it — the standard
  boundary bypass.
- **P:** Role creation is **allowed but constrained**: the SCP requires that any
  `iam:CreateRole` / `iam:PutRolePolicy` / `iam:AttachRolePolicy` set the
  platform permissions boundary (`iam:PermissionsBoundary` condition), and denies
  `iam:DeleteRolePermissionsBoundary`. A created role therefore cannot exceed the
  student's own ceiling.
- **D:** CloudTrail `CreateRole` without the boundary condition → denied → alert.
- **C:** Account boundary.
- **CL:** Janitor deletes non-baseline roles (path-protected baseline roles are
  excluded by an explicit allow-list, not by a name pattern).
- **RR:** **Medium.** Roles must be creatable — labs teach instance profiles and
  Lambda execution roles. The boundary-required condition is the entire defence,
  and it must be verified per-action, because not every IAM write supports the
  condition uniformly. **Test before enabling any lab that creates a role.**

---

**T7 — Modify trust policies**

- **Attack path:** Edit `JumpToTechLabRole`'s (or the janitor's / verifier's)
  trust policy to trust an attacker-controlled account, obtaining access that
  outlives the lease.
- **P:** SCP denies `iam:UpdateAssumeRolePolicy` on any principal under the
  platform IAM path; the janitor and verifier roles are in that path.
- **D:** CloudTrail on the denied call; Config rule on trust-policy change.
- **C:** Account boundary; RCP restricts `sts:AssumeRole` on resources in the
  org from principals outside the org — STS is an RCP-supported service
  (§11 B2), which closes this at a second, independent layer.
- **CL:** Baseline StackSet re-applies role definitions at recycle, so any
  surviving edit is overwritten.
- **RR:** **Low.**

---

**T8 — Disable logging**

- **Attack path:** `cloudtrail:StopLogging`, delete the trail, disable GuardDuty
  or Config, delete the log destination.
- **P:** SCP denies `cloudtrail:StopLogging`, `cloudtrail:DeleteTrail`,
  `guardduty:Delete*`/`Disable*`, `config:Delete*`/`Stop*`. The trail is an
  **organization trail** owned by the management account and delivering to the
  `Security` OU — the student's account does not own the destination.
- **D:** Absence-of-logs alarm on the central bus; CloudTrail delivery gaps.
- **C:** Even total in-account logging loss leaves the org trail intact.
- **CL:** Baseline re-applied at recycle.
- **RR:** **Low.** Note the honest limit: SCPs cannot restrict service-linked
  roles, so logging controls are only as strong as the absence of a
  service-linked path to them.

---

**T9 — Remove cost-control tags**

- **Attack path:** `UntagResource` to detach a resource from session attribution,
  hoping to survive tag-based cleanup and cost allocation.
- **P:** SCP denies `*:UntagResource` / `*:DeleteTags` for the platform tag keys
  via an `aws:TagKeys` condition. **But this is defence in depth only.**
- **D:** Config rule for required tags; the janitor's discovery pass reports
  untagged resources as anomalies.
- **C:** Account boundary.
- **CL:** **Cleanup does not depend on tags.** The janitor deletes *everything
  that is not baseline*, so an untagged resource is deleted precisely because it
  is untagged. This is why the pool model tolerates incomplete tagging where a
  shared-account model could not.
- **RR:** **Very low for cleanup; medium for cost attribution.** Untagged spend
  still lands on the account, and the account maps to a lease, so per-session
  cost survives even when per-resource tagging does not.

---

**T10 — Leave persistent resources**

- **Attack path:** Anything that keeps running or costing after teardown: ASGs
  that relaunch terminated instances, EventBridge schedules, Lambda on a cron,
  S3 Object Lock, RDS deletion protection, EC2 termination protection, KMS keys
  with pending-deletion windows.
- **P:** SCP denies the *anti-cleanup* primitives outright — Object Lock
  configuration, RDS deletion protection, EC2 `DisableApiTermination`. The
  cheapest way to make cleanup reliable is to forbid the states that make it
  impossible.
- **D:** Post-cleanup verification pass (§6.4) is the detector by construction.
- **C:** Budget action; lease TTL; account never re-enters the pool dirty.
- **CL:** Nuke in dependency order with a **retry loop** — the published
  reference design loops precisely because deletions fail on dependencies and
  because cleanup itself creates resources (snapshots, logs, `OnDelete` custom
  resources) that must then also be deleted (§11 A1).
- **RR:** **Medium** — the dominant operational risk. Mitigated by quarantine,
  never by "assume it worked".

---

**T11 — Create resources in unauthorized regions**

- **Attack path:** Operate in a region with no monitoring, no budget alarm and no
  janitor coverage.
- **P:** SCP with an `aws:RequestedRegion` condition restricting to the allowed
  region set.
- **D:** Org CloudTrail is **all-regions**; the janitor's discovery sweep runs in
  every enabled region, not only allowed ones.
- **C:** Account boundary.
- **CL:** Janitor sweeps all enabled regions regardless of the allow-list —
  cleanup must never trust the same assumption prevention makes.
- **RR:** **Medium, and this one carries an unverified dependency.** Global
  service endpoints (IAM, STS, Organizations, CloudFront, Route 53) behave
  specially under region conditions, and **this specification could not verify
  that behaviour from official documentation** (§11 F1). A naive region SCP can
  break IAM and STS and thereby break the platform itself. **The region SCP must
  be empirically tested in a throwaway account before it is attached anywhere.**
  Additional hard control: **disable unused regions at the account level** at
  vend time, which removes the question entirely for those regions.

---

**T12 — Increase service quotas**

- **Attack path:** Raise the account's own EC2 vCPU or Lambda concurrency quota
  to escape the compute ceiling, then run T2/T3 at scale.
- **P:** SCP denies `servicequotas:RequestServiceQuotaIncrease`,
  `servicequotas:RequestQuotaIncreaseForTemplate`, `support:CreateCase`. **This
  is now the primary quota control**, replacing v1's "reduce the quotas", which
  the documentation does not support (§11 C2).
- **D:** CloudTrail on the denied call; quota-change events.
- **C:** New accounts ship with low default quotas; those defaults are the
  ceiling the student inherits.
- **CL:** Quota state is account-level and survives cleanup — a quota that *was*
  raised stays raised. **A recycled account must have its applied quotas
  re-verified**, and an account whose quotas were raised should be ejected to
  `Exit` rather than returned to the pool.
- **RR:** **Medium.** Default quotas are AWS's choice, not ours; they can be
  higher than we would like, and we cannot lower them self-service.

---

**T13 — Expose resources publicly**

- **Attack path:** Public S3 bucket, `0.0.0.0/0` security group, public AMI or
  EBS snapshot, resource policy granting `Principal: "*"` — either to serve
  phishing/malware or to exfiltrate lab content.
- **P:** Four independent layers, three of which are new to this spec:
  **(a)** **RCP** on the Sandbox OU restricting access to S3/SQS/KMS/Secrets
  Manager/ECR resources by external principals — RCPs constrain the *resource*
  regardless of what the resource policy says, and apply even to principals
  outside the org (§11 B2). **(b)** **Declarative EC2 policies**: VPC Block
  Public Access, Image Block Public Access, EBS Snapshot Block Public Access
  (§11 B3). **(c)** S3 Block Public Access enforced in the baseline.
  **(d)** SCP denying `ec2:AuthorizeSecurityGroupIngress` with `0.0.0.0/0` for
  sensitive ports — though note labs legitimately need `0.0.0.0/0` on 80/443.
- **D:** Config rules; GuardDuty; the `I1` lab's own subject matter.
- **C:** VPC BPA is authoritative at account/region scope with per-VPC/subnet
  exclusions (§11 B4), so it can be default-on with a lab-specific exclusion.
- **CL:** Nuke.
- **RR:** **Low-medium.** Some labs *must* expose an ALB publicly; those run
  under a profile with a BPA exclusion and a shorter TTL.

---

**T14 — Access another student's account**

- **Attack path:** Assume a role in another sandbox account; access another
  account's S3/KMS/Secrets by ARN; enumerate account ids.
- **P:** **Structural.** Each session holds exactly one account. Cross-account
  access requires a trust policy in the target account that does not exist. RCP
  restricts resource access to principals in the org *and* can be scoped to deny
  cross-account within the org.
- **D:** CloudTrail cross-account `AssumeRole` denials.
- **C:** Account boundary.
- **CL:** N/A.
- **RR:** **Very low.** This is the threat the pool model exists to eliminate,
  and it is the strongest single argument against the shared-account alternative.

---

**T15 — Retain credentials after session expiration**

- **Attack path:** Copy the STS triple off-box and keep using it; keep a console
  session open past the lease.
- **P:** Credential TTL is 900 s — the documented STS minimum (§11 D2) — and is
  minted on demand rather than written to disk (§4.4). Under role chaining the
  ceiling is **one hour regardless of what is requested** (§11 D2).
- **D:** **The strong signal.** Credentials are only ever used from the sandbox's
  egress IP, so a CloudTrail event for a session principal from a foreign
  `sourceIPAddress` is near-proof of exfiltration. Scoped to CLI/API principals —
  console traffic legitimately originates from the student's browser (§4.6).
- **C:** Three-stage revocation (§4.5), the strongest being the
  `AWSRevokeOlderSessions` inline policy using `aws:TokenIssueTime`, which denies
  everything to sessions issued before a timestamp, effective for past sessions
  **and ~30 seconds into the future** to cover propagation (§11 D3).
- **CL:** Account nuked; a retained credential points at an empty account whose
  role has been revoked.
- **RR:** **Low.** Bounded by the 900 s window plus revocation propagation.

---

**T16 — Abuse Lambda**

- **Attack path:** High-concurrency, long-timeout functions for mining or
  outbound abuse; a function on an EventBridge schedule for persistence; a
  function used to escalate via its execution role (`iam:PassRole`).
- **P:** Session policy pins `lambda:CreateFunction` with conditions on memory
  and timeout where supported; account concurrency limit set in the baseline;
  `iam:PassRole` allowed **only** for roles carrying the permissions boundary;
  no VPC attachment in the MVP profile.
- **D:** Concurrency and duration alarms; GuardDuty; spend velocity.
- **C:** Budget action; account concurrency limit; lease TTL.
- **CL:** Nuke deletes functions, event source mappings, EventBridge rules, and
  log groups — **event source mappings and schedules must be deleted before the
  functions**, or they resurrect work mid-cleanup.
- **RR:** **Medium.** Lambda's cost profile is small per invocation and
  unbounded in aggregate; the account concurrency limit is the real ceiling.

---

**T17 — Abuse EC2**

- **Attack path:** Covered by T2/T3, plus: spot fleets and ASGs launching in
  bulk; user-data payloads; instance-profile credential theft via IMDS; using an
  instance as a proxy/scanner.
- **P:** Instance-type allow-list; **IMDSv2 required by declarative policy**
  (§11 B3), which blocks the classic SSRF-to-credentials path; ASG max size
  bounded by session policy; **Allowed Images Settings** restricts AMIs.
- **D:** GuardDuty `UnauthorizedAccess:EC2/*` and `Backdoor:*`; VPC Flow Logs;
  outbound connection alarms.
- **C:** VPC BPA available as a default-on containment for labs that need no
  inbound internet; port 25 is blocked by AWS by default.
- **CL:** ASGs deleted before instances, or terminated instances relaunch.
- **RR:** **Medium.** EC2 is the largest attack surface in the MVP and the
  reason C-module labs are classified `REAL AWS CONTROLLED` rather than `CHEAP`.

---

**T18 — Abuse container services (ECS/ECR/EKS/CodeBuild)**

- **Attack path:** Fargate tasks as mining workers; a malicious image pushed to
  ECR and run; CodeBuild as free compute; EKS control-plane hourly cost.
- **P:** Fargate task CPU/memory pinned by session policy; desired-count
  bounded; **EKS excluded from the MVP entirely** (`NOT SAFE FOR MVP` — hourly
  control-plane cost plus slow create/delete that lengthens every recycle);
  CodeBuild denied at SCP.
- **D:** Task count and duration alarms; ECR image scanning; spend velocity.
- **C:** Budget action; lease TTL; account boundary.
- **CL:** Services scaled to zero before deletion; ECR images and repositories
  deleted; the cluster deleted last.
- **RR:** **Medium.** Container services hide compute behind a control plane,
  which makes "how much am I running" less obvious to both student and operator.

---

**T19 — Abuse networking resources**

- **Attack path:** NAT gateways and their data-processing charges; VPC endpoints;
  Transit Gateway; egress-heavy workloads; VPC peering to an external account.
- **P:** NAT gateway **denied** in the MVP profile — taught as concepts and cost
  reasoning instead (lab `B6`); Transit Gateway, Direct Connect, Global
  Accelerator denied at SCP; peering-accepter denied.
- **D:** Flow logs; data-transfer cost anomaly.
- **C:** Budget action; VPC BPA.
- **CL:** ENIs are the classic dependency blocker — the janitor must delete
  ENIs, endpoints, NAT gateways and load balancers *before* subnets and VPCs.
- **RR:** **Low-medium.** Data-transfer cost is the one dimension the allow-list
  bounds poorly, because a permitted small instance can still egress a lot.

---

**T20 — Create resources the platform does not know about**

- **Attack path:** Use any permitted API the platform's authors did not
  anticipate, in any region, producing resources absent from the platform's
  records — the meta-threat behind T2, T10 and T11.
- **P:** Allow-list, not deny-list, at the session-policy layer: an unanticipated
  service is denied because it was never granted.
- **D:** The janitor's **discovery** phase is authoritative and independent of
  platform records (§6.2). Config resource inventory as a second, independent
  view.
- **C:** Account boundary — an unknown resource is still inside a disposable
  account.
- **CL:** **This threat is the reason cleanup must be discovery-based rather than
  record-based.** The janitor deletes what it *finds*, not what the platform
  *remembers creating*.
- **RR:** **Medium.** The residual is a resource type the *cleaner* does not
  know how to delete — which is exactly the case the verification pass is
  designed to catch, and which correctly ends in quarantine.

---

### 2.1 Cross-cutting residual risks

| Residual | Why it persists | Mitigation posture |
|---|---|---|
| Service-linked roles are outside SCP **and** RCP | Documented AWS behaviour (§11 B1, B2) | Declarative policies are the only org lever that governs them; keep the baseline set current |
| Management account is outside SCP and RCP | Documented (§11 B1, B2) | Nothing runs there; break-glass only |
| Budget feedback is hours late | Documented (§11 C1) | Budgets are a backstop; prevention is the control |
| Quotas cannot be lowered self-service | Documented (§11 C2) | Deny increases; accept AWS defaults as the ceiling |
| Region-condition behaviour for global services | **Unverified** (§11 F1) | Empirical test required before attaching; disable unused regions |
| Cleanup of an unknown resource type | Unbounded by nature | Verification gate + quarantine, never silent return |

---

## 3. Account lifecycle

### 3.1 States

Aligned to the AWS-published sandbox lifecycle (§11 A1), with JumpToTech's
session state machine as the driver.

```text
                    ┌──────────┐
                    │  ENTRY   │  account vended or manually added
                    └────┬─────┘  (never trusted — always cleaned first)
                         │ onboard
                         ▼
      ┌─────────────► CLEANING ─────────────┐
      │              (janitor)              │ failure / drift
      │                  │ success          ▼
      │                  ▼            ┌────────────┐
      │             VERIFYING         │ QUARANTINE │ deny-all SCP
      │           (independent)       │  human     │ no auto-return
      │              │        │       └─────┬──────┘
      │       clean  │        │ dirty       │ retry cleanup only
      │              ▼        └─────────────┤
      │            READY ◄──────────────────┘ (on verified success)
      │              │ lease()
      │              ▼
      │            LEASED  ◄────────┐ unfreeze
      │              │      │       │
      │       end /  │      │ threshold breach / manual
      │       expire │      ▼       │
      │              │    FROZEN ───┘   access revoked, contents preserved
      │              │      │              for review
      │              ▼      ▼
      └──────────── (back to CLEANING)

   From any state except CLEANING:  ──► EXIT   (ejected from the pool)
```

### 3.2 State definitions

| State | OU | Student access | Meaning |
|---|---|---|---|
| `ENTRY` | `Sandbox/Cleanup` | none | Newly vended or re-added. **Always cleaned before first use** — never assume a new account is empty. |
| `CLEANING` | `Sandbox/Cleanup` | none | Janitor running discover→delete→re-discover loop. |
| `VERIFYING` | `Sandbox/Cleanup` | none | Independent read-only proof that only baseline remains. |
| `READY` | `Sandbox/Ready` | none | Verified clean, baselined, leasable. The only state `lease()` may draw from. |
| `LEASED` | `Sandbox/Leased` | yes | Bound to exactly one session. Account tags carry `lease-session-id` and `lease-expires-at`. |
| `FROZEN` | `Sandbox/Leased` | **revoked** | Budget threshold, abuse signal, or manual hold. Contents preserved for investigation. Reversible to `LEASED`. |
| `QUARANTINE` | `Sandbox-Quarantine` | none | Cleanup failed, or OU drift detected. Deny-all SCP. **Returns to the pool only by a successful cleanup retry**, never by an operator toggling a flag. |
| `EXIT` | `Sandbox-Exit` | none | Permanently removed from the pool: evidence preservation, a problem account, or downsizing. |

### 3.3 Why `FROZEN` matters

v1 had no equivalent, and its absence was a real gap. Without it the only
responses to a budget breach or an abuse signal are "do nothing" or "destroy the
evidence". `FROZEN` revokes the student's access while preserving the account
contents, which is what an incident investigation actually needs — and it is
reversible, so a false positive costs the student a pause rather than their work.

### 3.4 Transition triggers

| Transition | Trigger | Actor |
|---|---|---|
| `ENTRY → CLEANING` | onboarding | operator (deliberate manual step) |
| `CLEANING → VERIFYING` | cleaner reports success | janitor |
| `VERIFYING → READY` | verification finds only baseline | verifier (independent role) |
| `VERIFYING → QUARANTINE` | verification finds non-baseline | verifier |
| `CLEANING → QUARANTINE` | cleaner exhausts retries, or drift monitor sees OU mismatch | janitor / drift monitor |
| `READY → LEASED` | `AwsLabProvider.lease()` inside session start | pool manager (transactional) |
| `LEASED → FROZEN` | budget threshold, GuardDuty finding, manual hold | abuse responder / operator |
| `FROZEN → LEASED` | investigation cleared | operator |
| `LEASED/FROZEN → CLEANING` | session ended, expired, idle, or force-terminated | session manager |
| `QUARANTINE → CLEANING` | operator retries cleanup | operator |
| `any → EXIT` | operator ejection | operator |

### 3.5 Invariants

1. `READY` is reachable **only** through `VERIFYING`. There is no path from
   `CLEANING` straight to `READY`, and no operator override that creates one.
2. A `LEASED` account is bound to exactly one session id, recorded in the durable
   lease table **and** in the account's tags. Disagreement between the two is
   drift and quarantines the account.
3. `destroy()` does not report complete until the account has left `VERIFYING`.
4. Pool capacity for admission control is `count(READY)`, never
   `count(all accounts)`.
5. Quarantine is **not** an operator convenience — no state transition may skip
   the verification gate.

### 3.6 Pool sizing

```
pool ≥ peak concurrent AWS sessions
     + accounts in CLEANING + VERIFYING   (cleanup minutes × churn rate)
     + accounts in QUARANTINE
     + headroom
```

Cleanup duration dominates, which is a direct argument for the MVP's service
restrictions: every slow-deleting service excluded (EKS, RDS beyond the single
controlled lab, NAT gateways) shortens the recycle and shrinks the pool.

---

## 4. Credential architecture

### 4.1 Absolute prohibitions

The browser, and any component reachable from it, **never** receives:

- JumpToTech management-account credentials of any kind;
- permanent IAM user access keys — none exist, in any account, by SCP (T5);
- AWS root credentials;
- any long-lived platform credential.

The control plane itself holds **no static AWS key**. It authenticates by
workload identity (instance profile / IRSA). There is deliberately **no
`AWS_ACCESS_KEY_ID` configuration key anywhere in the platform** (§8.5): a design
in which those variables have a home is a design that eventually leaks them.

### 4.2 The chain

```text
  control plane                              (workload identity, no static key)
      │ sts:AssumeRole  ── OrgLabAccess role, ExternalId
      ▼
  org lease principal                        (Infrastructure OU)
      │ sts:AssumeRole  ── JumpToTechLabRole in the LEASED account
      │   RoleSessionName   = <session id>        → CloudTrail attribution
      │   SourceIdentity    = <student id>        → immutable across chaining
      │   Tags              = lab-id, session-id  → aws:PrincipalTag
      │   PolicyArns        = lab profile managed policy ARNs   (see 4.3)
      │   DurationSeconds   = 900
      ▼
  student session credentials

  effective permissions =
      SCP (Sandbox OU)  ∩  permissions boundary (role)  ∩  session policy
```

**`SourceIdentity` is the attribution primitive**, and it is better than the
session name for this purpose: it persists across chained sessions and can be
made mandatory by the role's trust policy (§11 D2). A student cannot detach
their identity from their actions by chaining into another role.

### 4.3 Lab profiles must be managed policies, not inline JSON

A verified constraint that changes the v1 design: **inline and managed session
policies together cannot exceed 2,048 characters of plaintext**, with a further
packed-size limit shared with session tags (§11 D2). A per-lab inline policy
enumerating services, actions, instance types and tag conditions will not fit.

Therefore: **each lab profile is a managed policy created in the sandbox account
by the baseline StackSet, and passed at assume time by ARN** — up to 10 managed
policy ARNs are permitted. Consequences:

- Profiles are versioned and reviewed as part of the baseline, not assembled at
  runtime from lab metadata. A lab **selects** a profile; it cannot **author**
  permissions. This closes threat T9 (lab-author error) at the design level.
- Adding a profile is a baseline change with review, not a `lab.yaml` edit.
- A small inline session policy is still available for per-session narrowing
  (e.g. pinning the session tag), and must be kept well under the limit.

### 4.4 Delivery — nothing is written to disk

The sandbox's AWS config uses `credential_process` pointing at a helper that
calls the terminal service, which calls the internal API route, which mints.

- No `~/.aws/credentials` file to exfiltrate, screenshot, or paste.
- Refresh is automatic; the student never sees an expiry.
- **Revocation works**, because the next refresh can be refused.
- The helper is the natural audit point for credential issuance.
- It creates the exfiltration signal in T15: legitimate use has exactly one
  source IP.

### 4.5 Revocation, fastest first

1. **Stop refreshing.** Session ends → helper refuses → access gone within the
   900 s window.
2. **Revoke issued sessions.** Attach `AWSRevokeOlderSessions` (or an equivalent
   `aws:TokenIssueTime` deny) to the lab role. Denies all access to sessions
   issued before the timestamp, **plus ~30 s forward to cover propagation**
   (§11 D3). Note the documented caveat: this affects *all* users of the role —
   correct here, since one account has one student.
3. **Freeze the account.** Move to `Sandbox-Quarantine` (deny-all SCP). Nothing
   inside the account can prevent this.

### 4.6 CLI-only vs Console vs both

**Recommendation: (A) CLI-only for MVP.** Console is a v2 feature.

| | CLI-only | Console | Both |
|---|---|---|---|
| Credential exposure | in-sandbox only | browser holds a session | widest |
| Exfiltration detection | **strong** — one legitimate source IP | broken; browser IP is legitimate | weakened to CLI subset |
| Session length | 900 s, refreshed | bounded by credential lifetime | mixed |
| Grading | unaffected — verifier reads state | unaffected | unaffected |
| Teaching value | high; DevOps work is CLI/IaC | high for orientation | highest |
| Implementation cost | low | federation endpoint + URL handling + separate rules | both |

Three reasons CLI-only wins for MVP, one of them newly verified:

1. **It preserves the single strongest detection signal in the design.** Console
   access dissolves "any foreign source IP is exfiltration" (T15) into a rule
   that must carve out browser traffic — measurably weaker on day one, when
   operational experience is lowest.
2. **A verified constraint makes console federation awkward here.** The federation
   flow's `SessionDuration` parameter **must not be used with credentials obtained
   through role chaining — the operation fails** — and chained credentials are
   capped at **one hour** regardless (§11 D2). The documentation also states that
   using `DurationSeconds` with `AssumeRole*` for this flow requires calling as an
   **IAM user with long-term credentials** — which this design does not have and
   will not create (T5). Console federation is still achievable (omit
   `SessionDuration`, accept a console session bounded by the credential lifetime),
   but it is a narrower path than it appears, and it deserves its own verification
   pass rather than an MVP assumption.
3. **The MVP curriculum does not need it.** All 35 labs in §10 are completable
   from the CLI, and the verifier reads state, so console-built and CLI-built
   answers would grade identically anyway.

**v2 path, when console is added:** federated sign-in URL derived from the
session's own role (never an IAM user), `SessionDuration` omitted under chaining,
URL treated as a secret and delivered by redirect, valid **15 minutes** from
creation (§11 D2), and separate abuse rules for browser-origin traffic.

### 4.7 Binding

| Binding | Mechanism | Enforced by |
|---|---|---|
| Session | `RoleSessionName` = session id; lease row; account tag | pool manager + CloudTrail |
| Account | role exists only in the leased account; org role can assume only into `Sandbox/Leased` | trust policy + ExternalId |
| Lab | profile managed policy ARN selected from the lab definition | credential minter |
| Student | `SourceIdentity`, immutable across chaining | trust policy condition |
| Time | 900 s credential; lease deadline; idle timeout | minter + session manager |

---

## 5. Preventative cost controls

Classification: **P** preventative (stops the action) · **D** detective
(observes it) · **R** reactive (responds after).

### 5.1 Control matrix

| Control | Class | Latency | Strength | Notes |
|---|---|---|---|---|
| **SCP — service deny-list** | P | instant | **Very high** | Bounds the member root user too. Not applicable to management account or service-linked roles (§11 B1). 10,240 chars, 10 per target |
| **SCP — region restriction** | P | instant | High | Global-endpoint behaviour **unverified** (§11 F1) — test first |
| **SCP — deny quota increase / support cases** | P | instant | **High** | Replaces v1's "lower the quotas". The control that makes default quotas a real ceiling |
| **SCP — deny anti-cleanup primitives** | P | instant | High | Object Lock, deletion protection, termination protection |
| **Permissions boundary** | P | instant | High | Caps roles the student creates, not just the role they assume |
| **Session policy (managed ARNs)** | P | instant | High | Per-lab allow-list. ≤2,048 chars total → must be managed ARNs (§4.3) |
| **RCP** | P | instant | Medium-high | Constrains external principals reaching student resources; subset of services (§11 B2) |
| **Declarative EC2 policies** | P | instant | **High** | Allowed AMIs, VPC BPA, IMDSv2, AMI/snapshot public-access. **Governs service-linked roles** — the only org control that does (§11 B3) |
| **Instance family/size allow-list** | P | instant | **Very high** | Condition on `ec2:InstanceType`. The single most effective anti-mining control |
| **Disable unused regions** | P | instant | High | Account-level; removes the global-endpoint ambiguity for those regions |
| **Account concurrency limits (Lambda etc.)** | P | instant | Medium | Baseline-set, not student-adjustable |
| **Resource-count limits** | P | instant | Medium | Only where a condition key supports it; otherwise detective |
| **Inherited default service quotas** | P | instant | Medium | **Cannot be lowered self-service** (§11 C2). AWS chooses the number, not us |
| **Session TTL / lease TTL** | P/R | minutes | **High** | The multiplier on every cost exposure: loss ≈ permitted shapes × TTL |
| **Per-student concurrency + lifetime spend cap** | P | instant | **High** | Platform-side, before a lease is granted. Requires identity (§13) |
| **Resource tagging (`aws:RequestTag`)** | P/D | instant | Low-medium | Attribution and defence in depth. **Not** load-bearing for cleanup (T9) |
| **Config rules** | D | minutes | Medium | Inventory and drift; feeds cleanup verification |
| **CloudTrail deny-storm rules** | D | minutes | Medium | Boundary probing signal |
| **GuardDuty** | D | minutes | High | Mining, brute force, backdoor |
| **Cost Anomaly Detection** | D | hours | Medium | Backstop |
| **AWS Budgets alerts** | D | **8–12 h** | Low as a control | Updated ≤3×/day; AWS documents a delay between charge and notification (§11 C1) |
| **Budget actions (SCP / IAM deny / stop EC2, RDS)** | R | **8–12 h** | Medium | Real teeth, slow trigger. From the management account an SCP can be applied to another account, but EC2/RDS instances **cannot** be targeted cross-account (§11 C1) |
| **Freeze account** | R | seconds | High | `FROZEN` state; preserves evidence |
| **Quarantine account** | R | seconds | **Very high** | Deny-all SCP |
| **Janitor + verification** | R | minutes | **Very high** | The final cost control: nothing survives a lease |

### 5.2 Layering

```text
  Layer 0  Structural     one account, one session; nothing shared
  Layer 1  Organization   SCP · RCP · declarative policies   (IAM cannot override)
  Layer 2  Identity       permissions boundary                (caps created roles)
  Layer 3  Session        managed-ARN session policy          (per-lab allow-list)
  Layer 4  Shape          instance types, sizes, concurrency  (cost, not access)
  Layer 5  Time           credential TTL · lease TTL
  Layer 6  Platform       per-student concurrency + spend caps
  ────────────────── everything above is preventative ──────────────────
  Layer 7  Detection      GuardDuty · CloudTrail · Config · anomaly
  Layer 8  Reaction       freeze · quarantine · budget action
  Layer 9  Cleanup        discover · delete · verify · quarantine-on-fail
```

An attack must defeat layers 0–6 to cost money at all. Layers 7–9 assume it
sometimes will.

### 5.3 What replaced the failed control

v1's "reduce per-account service quotas" does not survive verification. Its
replacement is three-part and each part is verified or structural:

1. **Inherit low defaults.** New accounts start with low service quotas; those
   defaults are the ceiling.
2. **Deny raising them.** SCP denies `servicequotas:RequestServiceQuotaIncrease`
   and `support:CreateCase` (T12).
3. **Never recycle an account whose quotas were raised.** Quota state survives
   cleanup. Verification records applied quotas; a mismatch against the pool
   baseline routes the account to `EXIT`, not `READY`.

If a specific quota genuinely needs to be lower than AWS's default, that is an
AWS Support negotiation per quota, per account, done at vend time — and until it
is confirmed for a specific quota, **no design may depend on it**.

### 5.4 Bounding the loss

The honest formula, since budgets cannot bound it:

```
worst-case spend per session
  ≈ (most expensive permitted shape)
  × (max count permitted by quota and session policy)
  × (lease TTL)
```

Each MVP profile must have this computed and written into its definition before
the profile ships. That number — not the budget — is the exposure. The budget is
what catches the case where the calculation was wrong.

---

## 6. Cleanup architecture

Cleanup is a **security subsystem**, not a housekeeping task. Its correctness is
what makes every TTL in this document meaningful.

### 6.1 The governing principle

> **The platform must not clean up what it remembers creating. It must clean up
> what is actually there.**

Records are a hypothesis; the account is the fact. Any record-based cleaner is
defeated by T20 — and by ordinary bugs, restarts, and partial failures.

### 6.2 Flow

```text
  SESSION EXPIRES / ENDS / FROZEN→terminate
        │
        ▼
  1. REVOKE ACCESS
        · stop credential refresh
        · AWSRevokeOlderSessions on the lab role  (aws:TokenIssueTime)
        · move account to Sandbox/Cleanup OU
        · NOTHING ELSE HAPPENS UNTIL THIS COMPLETES
        ▼
  2. DISCOVER            (independent of platform records)
        · every enabled region, not only allowed regions
        · service-by-service enumeration + AWS Config inventory as a
          second, independent view
        · classify: BASELINE (allow-listed by ARN/path) vs STUDENT (all else)
        ▼
  3. DELETE              (dependency-ordered, idempotent, retry loop)
        ▼
  4. DISCOVER AGAIN      ← the loop: deletion creates resources
        │                  (snapshots, log groups, OnDelete custom resources)
        │                  and dependency failures resolve on later passes
        └──► if STUDENT resources remain and passes remain, go to 3
        ▼
  5. VERIFY              (independent read-only role, not the janitor)
        · asserts: only BASELINE remains, in every enabled region
        · asserts: no IAM users, no access keys, no non-baseline roles
        · asserts: applied service quotas match the pool baseline
        · asserts: account tags cleared
        ▼
     clean? ──yes──► RE-BASELINE (StackSet) ──► READY
        │
        no
        ▼
     QUARANTINE  (deny-all SCP · human · no auto-return)
```

**Why step 4 exists as its own phase** rather than being folded into deletion:
the published reference cleaner loops for exactly two documented reasons —
dependency failures that resolve once other resources go, and resources
*created during cleanup* (§11 A1). A single-pass cleaner is wrong by
construction.

**Why step 5 uses a different role than step 3.** A cleaner that grades its own
work will report success when its enumeration has a blind spot — and its blind
spot is precisely where T20 lives. The verifier uses a read-only role, an
independent enumeration path, and Config as a cross-check.

### 6.3 Deletion ordering

Order is derived from dependency, and from what re-creates what:

```
  1  Scaling and scheduling first — anything that RESURRECTS work
     ASG (set min/max/desired 0, then delete) · ECS services (desired 0)
     EventBridge rules and schedules · Lambda event source mappings
     Auto Scaling plans · Spot fleet requests
  2  CloudFormation stacks (so the service deletes its own graph)
     handle DELETE_FAILED with retained-resource continuation
  3  Compute
     EC2 instances · ECS tasks · Lambda functions · Batch
  4  Load balancing and network attachments
     ALB/NLB · target groups · NAT gateways · VPC endpoints
     ENIs  ← the classic blocker for everything below
  5  Data with protection semantics
     RDS (disable deletion protection, skip final snapshot) · clusters
     DynamoDB · ElastiCache
  6  Storage
     EBS volumes → snapshots → AMIs (deregister before snapshot delete)
     S3: all object versions AND delete markers, then bucket
     ECR: images then repositories
  7  Networking
     security groups (break circular references first) · NACLs
     route tables · subnets · IGW detach+delete · VPC
  8  Identity and secrets
     access keys · IAM users · non-baseline roles/policies/instance profiles
     Secrets Manager (force delete, no recovery window)
     KMS (schedule deletion — cannot be immediate)
  9  Observability
     log groups · alarms · dashboards · Config rules created by the student
```

### 6.4 Hard cases

| Case | Problem | Handling |
|---|---|---|
| **Dependencies** | Subnet won't delete while an ENI exists; SGs reference each other | Dependency-ordered passes + retry loop; break SG rules before deleting SGs |
| **Eventual consistency** | A resource "deleted" still appears; a new one doesn't yet | Re-discovery pass is the source of truth, not the delete call's return; bounded poll with backoff |
| **Deletion protection** | RDS deletion protection, EC2 termination protection | **Denied at SCP** (T10) so it should not exist; janitor still clears it defensively |
| **Delayed deletion** | KMS keys schedule (never immediate); some services take minutes | Scheduled-deletion state is an **accepted baseline-compatible state**, explicitly allow-listed in verification — otherwise every account with a KMS key quarantines forever |
| **ENIs** | Held by Lambda-in-VPC, endpoints, NAT, ALB; often orphaned | Delete owners first; explicit orphan-ENI sweep before subnets |
| **Security groups** | Circular references; the default SG cannot be deleted | Revoke all rules first; default SG is baseline |
| **EBS / snapshots / AMIs** | Deregistering an AMI leaves snapshots; snapshots block volume deletes | AMI deregister → snapshot delete → volume delete, in that order |
| **S3** | Versioning and delete markers; Object Lock makes deletion *impossible* | Object Lock **denied at SCP**; delete all versions and markers before bucket |
| **IAM artifacts** | Roles with attached policies, instance profiles, inline policies | Detach → delete inline → remove from instance profile → delete |
| **CloudFormation** | `DELETE_FAILED`, retained resources, nested stacks | Continue-rollback with retained resources; nested stacks bottom-up; delete leftovers directly afterward |
| **ECR** | Repository won't delete with images | Delete images (including untagged) then repository |
| **ECS** | Service recreates tasks; cluster won't delete with services | desired-count 0 → delete services → deregister task definitions → delete cluster |
| **EKS** | Nodegroups, addons, LB controller-created ALBs and ENIs outside the cluster | **Excluded from MVP.** Long-tail cleanup is a principal reason |
| **RDS** | Final snapshot requirement; automated backups outlive the instance | Skip final snapshot; delete automated backups and manual snapshots |
| **Lambda** | Event source mappings resurrect work; log groups persist | Mappings first, then functions, then log groups |
| **CloudWatch** | Log groups recreated by still-running producers | Delete after all producers are gone; second pass catches recreations |
| **Secrets Manager** | Default 7–30 day recovery window keeps the name reserved | Force delete without recovery |
| **KMS** | Cannot be deleted immediately | Schedule deletion; treat scheduled state as acceptable in verification |

### 6.5 Failure handling

- **Bounded retries.** A fixed pass budget, then quarantine. An unbounded loop
  is an account that never returns and never alarms.
- **Quarantine is terminal-until-human.** No automatic return path. The only
  route back to `READY` is a cleanup retry that *succeeds and verifies*.
- **Drift monitoring.** If an account's actual OU disagrees with its recorded
  state, quarantine immediately, bypassing cleanup — a pattern taken directly
  from the published reference design (§11 A1). Drift means the model is wrong,
  and running a destructive process against a wrong model is the worst option.
- **Cleanup is idempotent and re-entrant**, matching the existing reaper's
  contract: two sweeps produce the same end state as one.

---

## 7. Shared-platform contracts requested

**Not implemented. Not to be implemented on this branch.** Each item below is a
request for central coordination. All five are additive; none changes behaviour
for `kubernetes`, `linux`, `docker`, or `terraform`.

---

### 7.1 `sandboxGone` on `DestroyResult`

- **CURRENT BEHAVIOR** — `DestroyResult.namespaceGone: boolean`
  (`services/lab-orchestrator/src/types.ts`). Semantics: teardown is *verifiably*
  complete, so the reaper may stop re-entering. Every provider sets it, including
  container providers where no namespace exists.
- **PROBLEM** — The name asserts Kubernetes. For AWS it must mean "the account
  passed independent cleanup verification". A field named `namespaceGone`
  carrying that meaning will be misread by the next author, and the misreading is
  dangerous: returning `true` early returns a dirty account to the pool.
- **PROPOSED CONTRACT** — Add `sandboxGone: boolean` with the substrate-agnostic
  meaning. Keep `namespaceGone` as a deprecated alias that providers continue to
  set. New code reads `sandboxGone`; `namespaceGone` is removed only in a later,
  separate change.
- **FILES AFFECTED** — `services/lab-orchestrator/src/types.ts` (interface);
  `providers/kind-provider.ts`, `providers/container/sandbox-provider.ts`,
  `providers/docker-provider.ts`, `providers/aws-provider.ts` (set both);
  `session/manager.ts`, `session/reaper.ts` (read the new field);
  provider test fakes.
- **OTHER TRACKS AFFECTED** — All four, mechanically: one added field, same value.
- **BACKWARD COMPATIBILITY** — Full. Additive optional-then-required field with
  the alias retained.
- **SECURITY IMPACT** — **Positive.** Makes the "teardown verified" contract
  explicit at the type level, which is the contract the AWS pool depends on.

---

### 7.2 `account` isolation mode

- **CURRENT BEHAVIOR** — `ISOLATION_MODES = ['namespace','container','none']`;
  `PROVIDER_ISOLATION.aws = 'none'` (`providers/catalog.ts`).
- **PROBLEM** — `'none'` asserts an AWS lab is unisolated. It will be strongly
  isolated — by an AWS account, which is a stronger boundary than either existing
  mode. The lab loader validates `environment.isolation` against this table, so
  an AWS lab cannot currently declare the truth.
- **PROPOSED CONTRACT** — `ISOLATION_MODES` gains `'account'`;
  `PROVIDER_ISOLATION.aws = 'account'`;
  `SANDBOX_REFERENCE_LABEL['cloud-session'] = 'account'`.
- **FILES AFFECTED** — `providers/catalog.ts`; `lab-definition.ts` (validation
  message only); `apps/web/src/lib/types.ts` and the catalog UI label;
  catalog tests.
- **OTHER TRACKS AFFECTED** — **None.** No existing lab declares `account`, and
  the per-provider table is unchanged for the other four.
- **BACKWARD COMPATIBILITY** — Full; widening a closed union. Exhaustive
  `switch` statements over `IsolationMode` (if any) need a new arm — a compile
  error, not a runtime surprise.
- **SECURITY IMPACT** — Neutral to positive: the catalog stops under-reporting
  the isolation a track provides.

---

### 7.3 Leased sandbox handles

- **CURRENT BEHAVIOR** — `deriveSandboxRef({sessionId, secret, prefix})`
  (`session/identifiers.ts`) derives every sandbox handle by keyed HMAC from the
  session id. Non-invertible, collision-resistant, safe to display. The session
  record stores one `sandboxRef` and the store refuses to patch `provider`.
- **PROBLEM** — An AWS sandbox is **leased, not derived**. The account id is
  drawn from a pool and cannot be computed from a session id. The current model
  has nowhere to put it, and `sandboxRef` must not become the account id (it is
  displayed in the UI and appears in logs).
- **PROPOSED CONTRACT** — Two parts, both additive:
  1. `sandboxRef` stays derived for AWS (`jtt-aws-<hex>`) and is used as the
     session tag value, role session name and resource prefix. Requires only a
     new prefix constant and its validator, mirroring `CONTAINER_SANDBOX_PREFIX`.
  2. A new **provider-owned** durable lease record — `AwsAccountLease` — holding
     `{ leaseId, accountId, sessionId, state, leasedAt, expiresAt }`, reconciled
     against AWS account tags. It is **not** added to `LabSession`; the session
     layer stays substrate-agnostic and continues to see only `sandboxRef`.
- **FILES AFFECTED** — `session/identifiers.ts` (new prefix + validator);
  a new module under `providers/aws/`; **no change** to `session/types.ts`,
  `session/store.ts`, or `session/manager.ts`.
- **OTHER TRACKS AFFECTED** — **None.**
- **BACKWARD COMPATIBILITY** — Full.
- **SECURITY IMPACT** — **Positive.** Keeping the account id out of `sandboxRef`
  preserves the existing property that a leaked sandbox reference discloses
  nothing and cannot be inverted; the session→account mapping stays server-side.
- **DEPENDENCY** — Requires a durable store. The lease table cannot be in memory.

---

### 7.4 AWS requirement family

- **CURRENT BEHAVIOR** — `REQUIREMENT_FAMILIES` maps every requirement type to
  one of `kubernetes | filesystem | terraform | linux | docker`;
  `PROVIDER_REQUIREMENT_FAMILIES.aws = []` (`lab-definition.ts`). An AWS lab
  declaring any check fails to load.
- **PROBLEM** — Blocks every AWS lab, including the entirely simulated ones that
  need no account.
- **PROPOSED CONTRACT** — Add family `'aws'`; register AWS requirement types
  under it; `PROVIDER_REQUIREMENT_FAMILIES.aws = ['aws']`. Add
  `AwsVerifierHandler<T> = Handler<T, AwsVerifyReader>` alongside the existing
  per-family handler aliases so the registry's mapped types keep proving, at
  compile time, that every requirement type has a handler *of the right family*.
- **FILES AFFECTED** — `requirements.ts` (schemas + family map);
  `lab-definition.ts` (provider→family table); `services/verifier/src/contract.ts`
  (handler alias); `services/verifier/src/registry.ts` (dispatch);
  new `services/verifier/src/aws-reader.ts` and `handlers/aws-*.ts`.
- **OTHER TRACKS AFFECTED** — **None at runtime.** `RequirementType` is a union
  derived from the schema map, so adding members is additive; exhaustive mapped
  types will require the new handlers to exist, which is the intended compile-time
  gate.
- **BACKWARD COMPATIBILITY** — Full.
- **SECURITY IMPACT** — **Positive.** Extends the existing property that a
  handler cannot reach a substrate it has no business reading — an AWS handler
  will be unable to receive the Kubernetes or Docker reader.

---

### 7.5 Per-student session limits

- **CURRENT BEHAVIOR** — `SessionManager` enforces one global counter,
  `maxActiveSessions`, reserved synchronously before the first `await`
  (`session/manager.ts`). There is no per-student dimension, and
  `apps/api/src/identity.ts` resolves a **development identity from a request
  header — explicitly not authentication**.
- **PROBLEM** — AWS sessions cost real money attributable to a real person. A
  global cap cannot express "this student may hold 1 AWS session", "this student
  has spent their monthly allowance", or "this student is suspended from AWS but
  not from Kubernetes". Without it, one account can open sessions until the pool
  is empty.
- **PROPOSED CONTRACT** — Extend the capacity guard to a policy object rather
  than an integer:
  - `maxActiveSessionsPerStudent` (global and per-provider);
  - a pre-lease admission hook that a provider may fail with a typed reason
    (`STUDENT_LIMIT_REACHED`, `SPEND_CAP_REACHED`, `TRACK_SUSPENDED`);
  - reservation remains synchronous and transactional.
- **FILES AFFECTED** — `session/manager.ts`, `session/types.ts` (new
  `SessionErrorCode`s), `apps/api/src/config.ts`, `apps/api/src/routes/sessions.ts`.
- **OTHER TRACKS AFFECTED** — **All four**, if per-student limits are enabled
  globally. Mitigation: default the per-student limits to unlimited so existing
  tracks are unaffected until deliberately configured.
- **BACKWARD COMPATIBILITY** — Full with unlimited defaults; behavioural once
  configured (by intent).
- **SECURITY IMPACT** — **Large and positive, and it is a hard prerequisite.**
  It cannot be built meaningfully before real authentication exists (§13 Gate A):
  a per-student limit keyed on a spoofable header is not a limit.

---

### 7.6 Lab source and certification metadata

- **CURRENT BEHAVIOR** — `lab-definition.ts` already carries
  `certification: [{ certification, relevant, domains[] }]`, `references[]`
  (https-only, 1–10), an `OFFICIAL_DOC_HOSTS` allow-list requiring at least one
  official link for the lab's track, and a `DISALLOWED_DOC_HOSTS` ban list that
  already covers the third-party sources the Official-Source Curriculum Policy
  names.
- **PROBLEM** — The schema cannot record *which* current official objective a lab
  maps to, *which version* of the exam guide that objective came from, *when* it
  was last verified, or whether a lab is a certification objective at all rather
  than a production skill. Without those, "exam preparation" is a claim rather
  than a provable mapping.
- **PROPOSED CONTRACT** — Additive optional fields:
  `certification[].objective`, `certification[].objective_version`,
  `certification[].coverage`, `certification[].last_verified`,
  `references[].type`, and a lab-level
  `skill_class: CERTIFICATION_OBJECTIVE | PRODUCTION_SKILL | FOUNDATIONAL_SKILL`.
- **FILES AFFECTED** — `services/lab-orchestrator/src/lab-definition.ts`;
  catalog API payload; catalog UI; lab-definition tests.
- **OTHER TRACKS AFFECTED** — None until they opt in. Separately, the policy
  implies `OFFICIAL_DOC_HOSTS` additions for the Linux track (`systemd.io`,
  `freedesktop.org`, `openssh.com`), Kubernetes (`training.linuxfoundation.org`,
  `github.com/cncf`), and any future networking/CS track (`rfc-editor.org`,
  `iana.org`) — **other tracks' decisions, listed here only so they are not lost.**
- **BACKWARD COMPATIBILITY** — Full; all fields optional.
- **SECURITY IMPACT** — None. Metadata only.

---

## 8. Provider interface

**Design only.** No code is written.

### 8.1 What stays generic

| `LabProvider` concept | Fits AWS? | Why |
|---|---|---|
| `id` / `name` / `sandboxKind` | Yes | `aws` / `aws-pool` / `cloud-session` already exist |
| `availability()` | Yes, well | "pool configured, org reachable, `count(READY) > 0`" is exactly the *availability-as-data* the registry expects |
| `status(ctx)` | Yes | lease state + setup stack state |
| `execute(ctx, req)` | Yes | internal health check (`sts:GetCallerIdentity`); already not wired to any REST endpoint |
| `listManagedSandboxes()` | Yes | leases reconciled against **account tags** — the AWS analogue of namespace labels, preserving restart-safety |
| `destroySandbox(ref, sid)` | Yes | reclaim one lease; must re-read account tags before acting, exactly as container providers re-read labels |
| `getTerminalContext(ctx)` | Yes, additively | new closed-union variant; the union carries no command line, which is preserved |
| `ProvisionStep[]` reporting | Yes, well | "Leasing account… Applying lab baseline… Ready" renders in the existing UI unchanged |

### 8.2 What does not fit, and must not be forced

**`create()` is two operations, not one.** For every existing provider,
"create the sandbox" is a single idempotent act. For AWS it is
**`lease()` (acquire a scarce, shared, durable resource) + `prepare()` (apply the
lab's starting state)**, and they have different failure semantics: a failed
`prepare()` must **return the lease**, or the pool leaks an account on every
failed lab start. Collapsing them into `create()` hides the compensating action.

Proposed shape — `create()` remains the `LabProvider` entry point, implemented as
an orchestration of provider-owned operations:

```
create(ctx):
   lease   = await lease(ctx)                 // transactional; may fail CAPACITY
   try:    await prepare(ctx, lease)          // baseline stack for this lab
   catch:  await release(lease, reason)       // compensating return — mandatory
           rethrow
```

**`reset()` is not cheap.** Elsewhere reset re-applies a manifest in seconds.
Here it is a full nuke plus re-baseline — minutes. Two options, and the
recommendation is explicit: **implement `reset()` as "return this lease, take a
fresh `READY` account"**, which is faster, and — more importantly — gives the
student a *verified-clean* account rather than one the cleaner believes it
cleaned. Same guarantee as a new session, no special path.

**`destroy()` must not return early.** It reports complete only after
`VERIFYING` passes. That is why §7.1 requests `sandboxGone`.

**`credentials()` is not in `LabProvider`, and should not be.** No other
provider mints anything; adding it to the shared interface would push an
AWS-shaped concern onto four providers that have no use for it. It stays a
provider-specific method reached only through the internal route.

**`verifyCleanup()` must not be a `LabProvider` method either.** It is invoked by
the pool's own state machine between `CLEANING` and `READY`, not by the session
layer. Exposing it on the shared interface would invite a caller to treat
verification as optional or as something the session can trigger — it is neither.

### 8.3 Proposed operations

```
  LabProvider (generic, shared)          AwsLabProvider-only (provider-owned)
  ────────────────────────────           ──────────────────────────────────────
  availability()                         lease(ctx)            → AccountLease
  create(ctx)      = lease + prepare     prepare(ctx, lease)   → ProvisionStep[]
  status(ctx)                            release(lease, why)   → compensating
  reset(ctx)       = release + lease     credentials(ctx)      → short-lived STS
  destroy(ctx)     = release + verify    consoleSignInUrl(ctx) → v2 only
  execute(ctx,req)                       verifyCleanup(lease)  → CleanReport
  getTerminalContext(ctx)                (pool state machine, not session layer)
  listManagedSandboxes()
  destroySandbox(ref, sid)
```

`readSandboxPath` / `inspectSandbox` / `runSandboxScript` are **not implemented**:
there is no sandbox filesystem, and the platform must never run student code
inside a cloud account on the platform's behalf.

### 8.4 Terminal context variant

```ts
| {
    kind: 'aws-session';
    region: string;
    /** Display only. Never used to authorise anything. */
    accountAlias: string;
    /**
     * Handle the sandbox's credential_process helper presents to fetch
     * short-lived STS credentials. NOT a credential; inert after the
     * session ends.
     */
    mintHandle: string;
    sandboxRef: string;
    workspaceFiles?: Array<{ path: string; content: string }>;
    env?: Record<string, string>;
    expiresAt: string;
  }
```

No `consoleSignInUrl` in the MVP (§4.6). No credential triple — a terminal
context stays safe to hold.

### 8.5 Configuration

Two independent gates, mirroring the Docker precedent (registry `enabled` **and**
the provider's own probe), default off:

```
AWS_TRACK_ENABLED=false
AWS_TRACK_MODE=simulated          # simulated | real  — CI/dev default: simulated
AWS_ORG_LAB_ACCESS_ROLE_ARN=
AWS_ORG_EXTERNAL_ID=
AWS_SANDBOX_REGION=
AWS_POOL_MIN_READY=0
AWS_CREDENTIAL_TTL_SECONDS=900
AWS_MAX_LEASE_MINUTES=45
AWS_CONSOLE_ENABLED=false
```

**Deliberately absent: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.** There is
no configuration path for a static AWS credential, in any environment. In
`simulated` mode the provider cannot reach real AWS even if credentials were
present in the process environment.

---

## 9. Verifier design

### 9.1 Non-negotiable: `lab.yaml` describes state, never commands

`lab.yaml` is content, reviewed like content. It **may not** contain an AWS CLI
command, an API call name, an SDK expression, an ARN template with interpolation,
or a region. It declares **desired state** in a closed vocabulary. Trusted
verifier code — shipped with the platform, not with the lab — decides which API
to call and with what scoping.

This is the existing platform rule ("It never runs anything the lab author wrote.
Requirements select from a closed vocabulary of handlers that ship with the
platform") applied to a substrate where violating it would be catastrophic: an
arbitrary command in a lab file would execute against a real cloud account.

```yaml
# LEGAL — declarative desired state
verify:
  - type: aws_security_group_rule
    group_name: web-sg
    direction: ingress
    protocol: tcp
    port: 443
    source: 0.0.0.0/0
    label: HTTPS is open to the internet

# ILLEGAL — rejected at load time, and no schema admits it
verify:
  - type: aws_cli
    command: "aws ec2 describe-security-groups --filters ..."
```

### 9.2 Reader

- Assumes **`JumpToTechVerifierRole`** — read-only, trusted only by the verifier
  service, never assumable by the student's role.
- Bound to **one account and one region**, both resolved from the session's
  lease record. Never from the browser, never from `lab.yaml`.
- Grades **state**, never history. Console, CLI, CloudFormation and Terraform
  routes to the same state grade identically.
- Bounded poll-with-backoff for eventual consistency, distinguishing
  "not yet" from "not there" — AWS is not read-after-write like the Kubernetes
  API, and a verifier that fails correct students at random is the worst
  possible defect in a paid product.
- Per-run caching and adaptive backoff for API throttling.

### 9.3 Families

For each: the AWS API used, and the six safety properties requested.

---

**`aws_resource_exists` / `aws_resource_absent` / `aws_resource_tagged`**
- **API** — `resourcegroupstaggingapi:GetResources`, plus service `Describe*`
  where tagging is incomplete.
- **Account scoping** — reader credentials exist only for the leased account.
- **Region scoping** — reader is region-pinned from the lease.
- **Ownership** — resource must be in the leased account *and* carry the session
  tag; a resource matching by name but not by session fails as "not found".
- **Operands** — closed enum of resource types; identifiers validated by shape.
- **Injection** — no operand ever concatenates into a command; ARNs are
  constructed by the verifier from validated parts, never accepted whole.
- **Cross-session** — impossible: one account, one session, one lease.

**`aws_ec2_instance_state`**
- **API** — `ec2:DescribeInstances`.
- **Scoping** — leased account + pinned region; filtered by session tag.
- **Ownership** — instance must carry `jumptotech.io/session-id` = this session.
- **Operands** — state ∈ {pending, running, stopping, stopped, terminated};
  instance type from the profile's allow-list; tag key/value.
- **Injection** — filters built from validated enums, never string-interpolated.
- **Cross-session** — structurally impossible.

**`aws_security_group_rule`**
- **API** — `ec2:DescribeSecurityGroups`.
- **Operands** — direction enum; protocol enum; port integer 0–65535; source as
  a parsed CIDR or a security-group id matched by shape. **A CIDR is parsed and
  re-serialised**, never compared as a string.
- **Injection** — no free-text operand.
- Others as above.

**`aws_vpc_route` / `aws_subnet_attributes` / `aws_igw_attached` / `aws_nacl_rule`**
- **API** — `ec2:DescribeRouteTables`, `DescribeSubnets`, `DescribeInternetGateways`,
  `DescribeNetworkAcls`.
- **Operands** — CIDRs parsed; target kinds a closed enum (`igw`, `nat`,
  `endpoint`, `eni`, `local`); AZ validated against the region's real AZ list.
- Others as above.

**`aws_s3_bucket_setting`**
- **API** — `s3:GetBucketPolicyStatus`, `GetPublicAccessBlock`,
  `GetBucketEncryption`, `GetBucketVersioning`, `GetBucketLifecycleConfiguration`.
- **Ownership** — **the sharpest case.** S3 bucket names are globally unique, so
  a student could name a bucket after one in another account. The verifier
  therefore resolves buckets by **`s3:ListBuckets` in the leased account only**
  and refuses any bucket name not returned by that call. It never fetches a
  bucket by name from a lab file.
- **Operands** — setting enum; boolean/enum expected values.
- **Injection** — bucket names validated against S3 naming rules and matched
  against the owned set.
- **Cross-session** — closed by the ownership rule above, which is stricter than
  for any other family and deliberately so.

**`aws_iam_policy_condition` / `aws_iam_simulate`**
- **API** — `iam:GetRole`, `GetPolicyVersion`, `SimulatePrincipalPolicy`,
  `SimulateCustomPolicy`.
- **Why it matters** — the simulator "does not perform the API operations; it
  only checks the authorization" (§11 D1). It grades least-privilege work using
  AWS's own evaluation logic, free and read-only, and it makes the entire IAM
  module runnable with **no account at all**.
- **Verified caveats that shape the design:** the simulator evaluates
  identity-based policies and SCPs, and AWS states results "can differ from your
  live AWS environment"; simulation of resource-based policies **is not
  supported for IAM roles**; RCPs are not supported in policy exclusion (§11 D1).
  Therefore: simulator-graded labs must be authored so the expected verdict does
  not depend on resource-policy-for-role evaluation, and the lab text must not
  claim the simulator is identical to production.
- **Operands** — action names validated against a shipped service/action list;
  ARNs constructed by the verifier; expected decision ∈ {allowed, implicitDeny,
  explicitDeny}.
- **Injection** — policy documents supplied by the *student*, never by
  `lab.yaml`; parsed as JSON and size-bounded before submission.
- **Cross-session** — simulated principal must be in the leased account, or (for
  tier-SIMULATED labs) no account is involved at all.

**`aws_cloudwatch_alarm` / `aws_log_group` / `aws_log_query`**
- **API** — `cloudwatch:DescribeAlarms`, `logs:DescribeLogGroups`,
  `logs:FilterLogEvents`.
- **Operands** — alarm name shape; metric/namespace/statistic enums; comparison
  operator enum; threshold numeric. Log filter patterns come from a **closed set
  of platform-authored patterns**, never free text from `lab.yaml` — an arbitrary
  filter is a query-injection surface and an unbounded-cost surface.
- Others as above.

**`aws_sqs_queue` / `aws_sns_topic` / `aws_subscription` / `aws_lambda_function`**
- **API** — `sqs:GetQueueAttributes`, `sns:GetTopicAttributes`,
  `ListSubscriptionsByTopic`, `lambda:GetFunctionConfiguration`,
  `ListEventSourceMappings`.
- **Ownership** — queue/topic ARNs resolved by listing within the leased account;
  a name from `lab.yaml` is matched against that list, never used to build an ARN
  directly (same rule as S3, for the same reason).
- **Operands** — attribute enum; numeric bounds for timeouts and retention.
- **Note** — the verifier reads Lambda **configuration**. It does **not** invoke
  student functions: invocation is execution of student code by the platform,
  costs money, and can have side effects. If a lab must prove behaviour, the
  student invokes and the verifier reads the resulting state (a queue depth, a
  log event, an object).

**`aws_rds_instance` / `aws_ecr_repository` / `aws_ecs_service`**
- **API** — `rds:DescribeDBInstances`, `ecr:DescribeRepositories` +
  `DescribeImages`, `ecs:DescribeServices`.
- **Operands** — engine, class, boolean flags, desired/running counts — all
  enums or integers.
- Others as above.

**`aws_http_reachable`**
- **The only family that leaves AWS**, and the only one needing SSRF defence.
- **Rule** — the target is **never** a URL from `lab.yaml`. The verifier resolves
  the DNS name of the session's **own** ALB/API Gateway via the verifier role,
  confirms it belongs to the leased account, and only then issues the request.
- **Guards** — allow-list of AWS-owned DNS suffixes; resolved IP checked against
  private/link-local ranges; no redirects followed; short timeout; response body
  size-capped; only status code and a bounded matched substring are used.
- **Cross-session** — the target must be owned by the lease; anything else fails
  as "not found" rather than being fetched.

### 9.4 Tier-SIMULATED reader

Simulated labs use the same `Handler<T, R>` shape with a fixture-backed reader
(a student-authored policy document, a template, a captured CloudTrail excerpt).
No new machinery — the existing per-family reader typing already supports it,
and it is what lets the entire IAM module ship before any AWS account exists.

### 9.5 Universal rules

1. `lab.yaml` declares state; the platform decides the API call.
2. Every operand is enum, integer, parsed CIDR, or shape-validated identifier.
   No free-text passed to any AWS API.
3. Names from `lab.yaml` are **matched against the account's owned resources**,
   never used to construct an ARN directly.
4. Account and region come from the lease record only.
5. The verifier role is read-only and separate from the student's and the
   janitor's.
6. No student code is executed by the verifier.
7. Failure detail describes the observed state; it never contains the solution.

---

## 10. MVP curriculum — 35 labs

> **AMENDED by the Official-Source Curriculum Policy review —
> [`aws-curriculum-source-verification.md`](aws-curriculum-source-verification.md).**
>
> - **Certification alignment corrected.** This section originally implied
>   Solutions Architect Associate / DevOps Engineer Professional. The correct
>   primary alignment is **AWS Certified CloudOps Engineer – Associate
>   (SOA-C03)** — SAA-C03 secondary, DOP-C02 long-term. *AWS Certified SysOps
>   Administrator – Associate (SOA-C02) is retired; last exam day 2025-09-29.*
> - **Coverage gaps found:** no CloudFormation/CDK lab (Domain 3 = 22% of the
>   exam), no EventBridge, no flow logs, no Config/Trusted Advisor. Corrections
>   C1–C5 are proposed in that review and are **not applied here**.
> - **Every lab below must pass the per-lab source-verification gate** before
>   implementation.

The 122-lab roadmap in v1 remains the long-term curriculum. This is the first
production release.

**Classification** — `SIMULATED` (fixtures/policy simulation, no account) ·
`LOCAL EMULATION` (runs against a local emulator, no account) ·
`REAL AWS CHEAP` · `REAL AWS CONTROLLED` (real, but expensive shape or
long-lived resource: shorter TTL, dedicated profile) · `NOT SAFE FOR MVP`.

**Cost class** — `ZERO` · `VERY LOW` · `LOW` · `MEDIUM` · `AVOID`. These are
**relative bands, not dollar amounts.** No dollar figures appear in this document
because current AWS pricing was not verified (§11 F2); each `LOW`/`MEDIUM` band
must be replaced by a measured figure from the first pilot before pricing is set.

### Module A — IAM and identity (6)

| # | Lab | Class | Cost |
|---|---|---|---|
| A1 | ARNs, the account boundary, and `sts:GetCallerIdentity`; CLI profiles and credential resolution order | SIMULATED | ZERO |
| A2 | Author a least-privilege identity policy for a stated job | SIMULATED | ZERO |
| A3 | Explicit deny and policy evaluation order | SIMULATED | ZERO |
| A4 | Roles, trust policies, and cross-account access | SIMULATED | ZERO |
| A5 | `PassRole` and the privilege-escalation path it opens | SIMULATED | ZERO |
| A6 | Assume a role in a real account and prove your effective permissions | REAL AWS CHEAP | VERY LOW |

*A1–A5 are graded by `SimulatePrincipalPolicy` (§9.3). The highest-value block in
the MVP, and it needs no AWS account — this is what makes a Phase-0 release
possible.*

### Module B — VPC and networking (7)

| # | Lab | Class | Cost |
|---|---|---|---|
| B1 | Plan a VPC CIDR and subnet layout for stated requirements | SIMULATED | ZERO |
| B2 | Create a VPC with subnets across two AZs | REAL AWS CHEAP | VERY LOW |
| B3 | Internet gateway and route tables: make a subnet public | REAL AWS CHEAP | VERY LOW |
| B4 | Security groups: allow exactly what is needed | REAL AWS CHEAP | VERY LOW |
| B5 | NACLs vs security groups; stateless vs stateful | REAL AWS CHEAP | VERY LOW |
| B6 | Private egress: NAT gateway concepts, alternatives, and cost | SIMULATED | ZERO |
| B7 | Networking troubleshooting: the instance cannot reach the internet | REAL AWS CHEAP | VERY LOW |

*B6 is simulated deliberately: NAT gateways carry an hourly and per-GB charge and
are denied in the MVP profile (T19). Students learn the cost model rather than
paying it. B7 teaches the same material by diagnosis.*

### Module C — EC2, EBS, Systems Manager (4)

| # | Lab | Class | Cost |
|---|---|---|---|
| C1 | Launch an instance from an allowed AMI; tag on create | REAL AWS CONTROLLED | LOW |
| C2 | Instance profiles, IMDSv2, and user-data bootstrap | REAL AWS CONTROLLED | LOW |
| C3 | EBS: attach, resize, snapshot, restore | REAL AWS CONTROLLED | LOW |
| C4 | SSM Session Manager instead of SSH and a bastion | REAL AWS CONTROLLED | LOW |

*`CONTROLLED` because EC2 is the largest abuse surface (T17). Instance-type
allow-list, Allowed AMIs declarative policy, IMDSv2 enforced, shorter TTL.*

### Module D — S3, KMS, Secrets (3)

| # | Lab | Class | Cost |
|---|---|---|---|
| D1 | Buckets, storage classes, lifecycle rules, versioning | REAL AWS CHEAP | VERY LOW |
| D2 | Block Public Access and bucket-policy forensics: why is this public? | REAL AWS CHEAP | VERY LOW |
| D3 | SSE-KMS with a customer-managed key; Secrets Manager and SSM SecureString | REAL AWS CHEAP | LOW |

*D3 is `LOW` not `VERY LOW`: a customer-managed KMS key carries a monthly charge
and cannot be deleted immediately (§6.4). Verify current pricing before pricing
the track.*

### Module E — Load balancing, scaling, DNS (3)

| # | Lab | Class | Cost |
|---|---|---|---|
| E1 | ALB, target groups, health checks, path-based routing | REAL AWS CONTROLLED | MEDIUM |
| E2 | Launch templates, Auto Scaling groups, scaling policies | REAL AWS CONTROLLED | LOW |
| E3 | Route 53: private hosted zone and records | REAL AWS CONTROLLED | LOW |

*E1 is the most expensive MVP lab (ALB hourly charge) and needs the shortest TTL.
E3: hosted zones carry a monthly charge — verify current pricing and the
delete-soon-after-create grace before enabling.*

### Module F — Observability (3)

| # | Lab | Class | Cost |
|---|---|---|---|
| F1 | Metrics, an alarm, and an SNS notification | REAL AWS CHEAP | VERY LOW |
| F2 | CloudWatch Logs and a Logs Insights investigation | REAL AWS CHEAP | VERY LOW |
| F3 | Reconstruct an incident from CloudTrail | SIMULATED | ZERO |

*F3 uses a captured trail fixture: the diagnosis is the skill, and a fixture
gives every student the same rich, messy evidence a fresh account cannot.*

### Module G — Decoupling and serverless (3)

| # | Lab | Class | Cost |
|---|---|---|---|
| G1 | SQS: queues, visibility timeout, dead-letter queues | REAL AWS CHEAP | VERY LOW |
| G2 | SNS → SQS fan-out | REAL AWS CHEAP | VERY LOW |
| G3 | Lambda: execution role, packaging, SQS trigger | REAL AWS CHEAP | VERY LOW |

*Lambda concurrency and timeout are pinned by the profile and the account
concurrency limit (T16).*

### Module H — Data and containers (4)

| # | Lab | Class | Cost |
|---|---|---|---|
| H1 | RDS: create, backups, restore, Multi-AZ concepts | REAL AWS CONTROLLED | MEDIUM |
| H2 | ECR: build, push, scan an image | REAL AWS CHEAP | VERY LOW |
| H3 | ECS on Fargate: task definition and service | REAL AWS CONTROLLED | MEDIUM |
| H4 | EKS concepts, IRSA, and when EKS is the wrong answer | SIMULATED | ZERO |

*H4 is simulated because **real EKS is `NOT SAFE FOR MVP`**: an hourly
control-plane charge, plus slow create/delete that lengthens every account
recycle and therefore enlarges the whole pool (§3.6). H2 bridges naturally from
the existing Docker track.*

### Module I — Security, cost, capstone (2)

| # | Lab | Class | Cost |
|---|---|---|---|
| I1 | Security and cost review of a running environment: find the public exposure and the waste | REAL AWS CHEAP | VERY LOW |
| I2 | Capstone: the three-tier application will not serve traffic | REAL AWS CONTROLLED | MEDIUM |

### Summary

| Classification | Labs | Share |
|---|---:|---:|
| SIMULATED | 11 | 31% |
| LOCAL EMULATION | 0 | — |
| REAL AWS CHEAP | 14 | 40% |
| REAL AWS CONTROLLED | 10 | 29% |
| **Total** | **35** | |

| Cost class | Labs |
|---|---:|
| ZERO | 11 |
| VERY LOW | 14 |
| LOW | 6 |
| MEDIUM | 4 |
| AVOID | 0 |

**Explicitly `NOT SAFE FOR MVP`:** real EKS clusters; NAT gateways; anything
GPU/accelerated; Redshift, SageMaker, Bedrock, EMR; Transit Gateway, Direct
Connect, Global Accelerator; CodeBuild; SES, SNS SMS, Pinpoint; public
CloudFront distributions; Route 53 public hosted zones and domain registration;
Marketplace subscriptions.

**Release shape.** The 11 `SIMULATED` labs — the whole IAM module plus B1, B6,
F3, H4 — need **no AWS account, no organization, no pool, and none of §13's
Gates B–F**. They are a complete, sellable first release that depends only on
Gate A and the verifier work. Ship them first; every real-AWS lab lands after
the cleanup engine has been proved.

---

## 11. Verified AWS assumptions

Everything below was checked against current official AWS documentation during
this pass. Facts are marked **[V]** verified with source, or **[U]** unverified.
Architectural choices are marked **[P]** proposal.

### A — Sandbox account pools

**A1 [V] — AWS publishes a sandbox-account-pool solution with this exact shape.**
*Innovation Sandbox on AWS*: an Account Cleaner (Step Functions + CodeBuild
running AWS Nuke) cleans accounts on onboarding and after lease expiry, in a
retry loop "so that any deletion failures due to resource dependencies eventually
resolve themselves and that any resources that are created during clean-up
(db snapshots, logs, custom resources OnDelete) are deleted." On failure "the
account is moved to Quarantine. Accounts in Quarantine require manual remediation
from the administrator and can only return to the account pool by retrying
cleanup and succeeding." Lifecycle states: Entry → CleanUp → Available → Active →
(Frozen) → CleanUp; plus Quarantine and Exit; drift monitoring quarantines
directly.
→ *Validates the approved architecture and supplies §3 and §6.*

**A2 [V] — OU nesting supports the proposed hierarchy.** Five levels of OUs deep
under a root; 2,000 OUs per organization.

### B — Policy mechanisms

**B1 [V] — SCPs.** Never grant, only bound. Effective permissions are the
intersection of SCPs, RCPs, and identity/resource policies. **Do not affect the
management account.** **Do not affect service-linked roles.** Do bound the member
account's **root user**. Do not directly affect resource-based policies. Max size
**10,240 characters**; **10 attachable per root, per OU, per account**; inherited
policies do not count against those limits; minimum 1 when enabled.

**B2 [V] — RCPs exist and constrain resources.** Max **5,120 characters**, **5
per entity**. Apply to a defined service subset including **S3, STS, KMS, SQS,
Secrets Manager, ECR, DynamoDB, CloudWatch Logs, EventBridge, CodeBuild, WAF,
Sign-In, Support**. They "impact the effective permissions of principals trying
to access resources in a member account… **regardless of whether the principals
belong to the same organizations or not**", including root users. Do **not**
apply to the management account, service-linked roles, or AWS managed KMS keys.
→ *This is the layer that constrains public exposure and external access; it did
not appear in v1.*

**B3 [V] — Declarative policies exist and govern service-linked roles.**
Enforced "in the service's control plane… While authorization policies regulate
access to APIs, declarative policies are applied directly at the service level."
The comparison table states declarative policies **do** govern service-linked
roles, where SCPs and RCPs do not. Supported EC2 attributes: **VPC Block Public
Access, VPC Encryption Controls, Serial Console Access, Image Block Public
Access, Allowed Images Settings, Instance Metadata Defaults, EBS Snapshot Block
Public Access.** Max 10,000 characters; 10 per entity; detaching rolls the
attribute back to its previous state.

**B4 [V] — VPC Block Public Access.** "A centralized security feature that
authoritatively prevents public internet access to VPC resources across an entire
AWS account." Modes: **Bidirectional** and **Ingress-only**; per-VPC and
per-subnet **exclusions** with Bidirectional or Egress-only modes.

### C — Cost controls

**C1 [V] — Budgets are slow, and AWS says so.** "AWS Budgets information is
updated up to three times a day. Updates typically occur 8–12 hours after the
previous update." And: "There can be a delay between when you incur a charge and
when you receive a notification… You might incur additional costs or usage that
exceed your budget notification threshold before AWS Budgets can notify you."
Budget actions: apply an IAM policy or an SCP, or target EC2/RDS instances. "From
the management account, you can apply an SCP to another account. However, you
can't target Amazon EC2 or Amazon RDS instances in another account."
→ *Confirms budgets are a backstop, never a primary control.*

**C2 [V] — Service Quotas supports increases, not self-service decreases.**
The console procedure states: "For **Increase quota value**, enter the new value.
**The new value must be greater than the current value.**" The service overview
describes viewing quotas and requesting *increases* only.
**[U] partially** — some services document a decrease path via AWS Support
(AWS KMS: "To request a quota decrease… please visit AWS Support Center"), so
decreases are **service-dependent and go through Support**.
→ ***This falsifies v1's primary quota control.*** Replacement in §5.3.

### D — Credentials

**D1 [V] — `SimulatePrincipalPolicy` is read-only and evaluates real logic.**
"The simulation does not perform the API operations; it only checks the
authorization to determine if the simulated policies allow or deny the
operations." It "evaluates statements in identity-based policies, service control
policies (SCPs) including their condition keys and resource scoping, and the
inputs that you provide". Accepts `PermissionsBoundaryPolicyInputList` and one
`ResourcePolicy`.
**Caveats [V]:** "The policy simulator results can differ from your live AWS
environment"; "Simulation of resource-based policies isn't supported for IAM
roles"; RCPs are not supported in `PolicyExclusionList`.
→ *Underwrites the simulated IAM module — with the caveats written into lab text.*

**D2 [V] — STS session limits.** `AssumeRole` `DurationSeconds`: **900–43,200
seconds**, default **3,600**, capped by the role's `MaxSessionDuration` (settable
1–12 hours). **"Role chaining limits your AWS CLI or AWS API role session to a
maximum of one hour"** — a request over one hour under chaining **fails**.
Session policies: inline plus managed ARNs **cannot exceed 2,048 characters** of
plaintext, up to **10 managed policy ARNs**, with a separate packed-size limit
shared with session tags. Session tags: up to **50**, keys ≤128, values ≤256;
transitive tags persist across chaining. `SourceIdentity` "persists across chained
role sessions" and can be required via `sts:SourceIdentity` in a trust policy.
`ExternalId` supported.
**Console federation [V]:** the federation URL "is valid for 15 minutes after it
is created"; `SessionDuration` ranges 900–43,200 for `AssumeRole*`-derived
credentials; **"Do not use the `SessionDuration` HTTP parameter when you get
temporary credentials through role chaining. The operation will fail."**; and
using `DurationSeconds` with `AssumeRole*` for this flow requires calling "as an
IAM user with long-term credentials."
→ *Forces managed-ARN lab profiles (§4.3) and supports CLI-only for MVP (§4.6).*

**D3 [V] — Session revocation works and is fast.** `AWSRevokeOlderSessions`
inline policy denies all access to sessions issued before a timestamp, "as well
as approximately 30 seconds into the future… to deal with a new session that was
acquired or renewed before the updated policy is in effect". Equivalent manual
form uses `aws:TokenIssueTime`. Cannot revoke a service-linked role's session.
Applies to **all** users of the role.

### E — Organizations lifecycle

**E1 [V] — Closure quota, corrected.** "Number of accounts you can close within a
30-day period: **20% of member accounts in organizations or 250, whichever is
higher, with a maximum of 1,000. This quota is not adjustable.**" Only **3**
closures may be in progress at once.

**E2 [V] — Closure is slow and keeps counting.** A closed member account shows
`CLOSED` "for up to 90 days after the original closure date", then is permanently
closed; "it may take a few days for the account to be removed from the
organization after permanent closure." And: "When an account is closed it does
not stop counting against this quota until it is permanently closed."

**E3 [V] — Creation is rate-limited.** Default maximum accounts per organization:
**10**, adjustable "up to 50,000 accounts based on customer qualifications";
"Newly created accounts and organizations might experience a quota below the
default of 10." Only **5** account creations may be in progress at once;
`CreateAccount` throttles at **0.1 requests/second**. Minimum age before a created
account can be removed: **4 days**.
→ *Together E1–E3 kill the create-an-account-per-session model far more decisively
than v1's incorrect 10% figure did: it is the 90-day closure overhang against a
finite account quota, plus a 0.1/s creation rate, not the closure cap.*

### F — Unverified

**F1 [U] — `aws:RequestedRegion` behaviour for global service endpoints.** Two
documentation fetches failed to surface the specific description of this
condition key or any global-service caveat. **No region-restriction SCP may be
attached anywhere until this is verified and empirically tested in a throwaway
account** — a naive region deny can break IAM/STS and, through them, the
platform. Compensating control available today: disable unused regions at the
account level.

**F2 [U] — All current AWS pricing.** Deliberately not verified and deliberately
not used. Every cost figure in §10 is a **relative band**. No dollar amount
appears anywhere in this document.

**F3 [U] — Account-recycling limits.** No documented AWS limit on how many times
a member account may be cleaned and re-leased was found. The pool model does not
close accounts, so E1–E3 do not bind it — but this absence of evidence is not
evidence of absence, and it should be confirmed with AWS before pool sizing is
fixed.

**F4 [U] — GuardDuty finding-type identifiers.** Referenced generically in §2.
Exact finding-type strings must be verified before any automated response rule is
written against them.

**F5 [U] — Control Tower / Account Factory / AFT provisioning behaviour and
timing.** Not verified. Vending mechanism is a §13 Gate B decision.

### Architectural proposals (not AWS facts)

**[P]** The `Sandbox` parent-OU-with-nested-state-OUs structure (§1.2) ·
the three-role split (§1.3) · managed-ARN lab profiles (§4.3) ·
`credential_process` delivery (§4.4) · CLI-only MVP (§4.6) ·
the deletion ordering (§6.3) · the shared-platform contracts (§7) ·
the provider decomposition (§8) · the verifier vocabulary (§9) ·
the 35-lab MVP (§10).

---

## 12. Unresolved risks

| # | Risk | Why it is unresolved | Resolution path |
|---|---|---|---|
| R1 | **Region-restriction SCP may break IAM/STS** | §11 F1 unverified | Verify docs; empirically test in a throwaway account; disable unused regions as the compensating control |
| R2 | **Cleanup of an unknown resource type** | Unbounded by nature (T20) | Verification gate + quarantine. Accept that some accounts will be retired to `EXIT` |
| R3 | **Service-linked roles escape SCP and RCP** | Documented AWS behaviour | Declarative policies are the only lever; keep the baseline current; monitor AWS's supported-attribute list |
| R4 | **Default service quotas may be higher than we want** | Cannot lower self-service (§11 C2) | Per-quota Support negotiation at vend time; never depend on it until confirmed |
| R5 | **Raised quotas survive cleanup** | Account-level state | Verification records applied quotas; mismatch routes to `EXIT`, not `READY` |
| R6 | **Cost per lab is unknown** | Pricing deliberately unverified (§11 F2) | Measure in the internal pilot before pricing the track |
| R7 | **Cleanup duration is unknown** | No implementation to measure | Measure in the pilot; it determines pool size and therefore capital cost |
| R8 | **Pool exhaustion is a customer-visible failure** | Finite pool, unknown demand | Capacity message, queueing, and pool autoscaling policy — all undesigned |
| R9 | **Simulator results can differ from live AWS** | Documented (§11 D1) | Lab text must not claim equivalence; spot-check simulated labs against real accounts |
| R10 | **Eventual consistency may fail correct students** | AWS is not read-after-write | Bounded poll-with-backoff; "not yet" vs "not there"; measure false-failure rate in the pilot |
| R11 | **Account recycling limits unknown** | §11 F3 | Confirm with AWS before fixing pool sizing |
| R12 | **Identity does not exist yet** | Platform gap, not AWS | Gate A. Blocks per-student limits, spend caps, abuse response and billing |
| R13 | **Console access deferred** | §4.6 | v2, with its own verification pass. Accept reduced teaching surface in MVP |
| R14 | **Lab-author error remains possible** | Humans write labs | Profiles are managed policies under review, not lab-authored (§4.3); CI policy lint (Gate F) |
| R15 | **AWS may suspend the organization for abuse** | Outside our control | Fast automated response; low per-account ceilings; documented abuse contact path |

---

## 13. Prerequisites before any AWS implementation

Ordered. Each gate blocks the next. "Implementation" means writing provider code;
"real AWS lab" means a leased account reaching a paying student.

### Gate A — Platform prerequisites (not AWS work; blocks everything)

1. **Authentication.** `apps/api/src/identity.ts` resolves a *development
   identity from a request header* and documents that it "is not authentication".
   Session possession is currently the entire authorization model. Without real
   identity there is no billing, no per-student limit, no spend cap, no abuse
   attribution, and no ban.
2. **Durable persistence.** `InMemorySessionStore` is the only `SessionStore`.
   A forgotten lease is an account leaking money. Postgres-backed sessions **and**
   an account-lease table, with capacity reservation inside a transaction.
3. **Per-student limits** (§7.5), which are meaningless without (1).
4. **Billing integration** sufficient to gate a lease on payment status.

*Gates B–G are wasted effort until A is done. The 11 `SIMULATED` labs in §10 are
the exception — they need only A1 and the verifier work.*

### Gate B — Organization foundation

5. Organization with all features; OU structure per §1.2; management account
   locked down, MFA, break-glass procedure documented and tested.
6. **Verify §11 F1** (region conditions and global endpoints), then author SCPs,
   RCPs and declarative policies and test them **against a throwaway account
   before attaching anywhere near the pool**.
7. `Security` OU with the write-only, Object-Locked CloudTrail archive; org
   trail; GuardDuty and Config org-wide.
8. Account vending decision and pipeline (Control Tower Account Factory, AFT, or
   custom) — §11 F5 to be verified as part of this.
9. Baseline StackSet: three roles, permissions boundary, **lab-profile managed
   policies** (§4.3), budget + action, EventBridge forwarding, TTL sweeper.
10. Confirm §11 F3 (recycling limits) and F4 (GuardDuty finding identifiers).

### Gate C — Cleanup, proved before anything else

11. Janitor covering every service the first profile permits, in the §6.3 order,
    with the discover → delete → **re-discover** retry loop.
12. Independent verification gating return-to-pool, with the quarantine path.
13. **A destructive test suite**: seed an account with the worst mess the profile
    permits — ASG relaunching instances, versioned bucket with delete markers,
    RDS with deletion protection, stuck `DELETE_FAILED` stack, orphaned ENIs,
    unattached EIPs, scheduled-deletion KMS key — and prove the account returns
    to verified baseline, repeatedly, unattended.

*Cleanup is proved before the first student, not after. Every TTL in this document
assumes it works.*

### Gate D — Control plane

14. `AwsAccountPool` with durable leases, capacity reporting into the existing
    session capacity model, and tag-based reconciliation after restart.
15. `AwsCredentialMinter` implementing §4.2 — the only component holding a
    credential.
16. `AwsLabProvider` (§8) plus the §7 shared contracts, **coordinated centrally,
    not applied on this branch**.
17. `aws-session` terminal context, `credential_process` helper, sandbox image
    with the AWS CLI.
18. Two-gate enablement, default off, `AWS_TRACK_MODE=simulated` as the CI and
    developer default, **no static-key configuration path**.
19. `AwsAbuseResponder` able to freeze and quarantine with no human in the loop.

### Gate E — Verifier

20. `aws` requirement family + `PROVIDER_REQUIREMENT_FAMILIES.aws` (§7.4).
21. Fixture-backed simulated reader — **this alone unblocks the 11-lab Phase 0.**
22. `AwsVerifyReader` on the read-only role, with bounded retry and adaptive
    backoff.
23. Handlers for the first profile's requirement types, including the IAM
    simulator checks and the ownership rules of §9.3.

### Gate F — Content and operations

24. AWS lab authoring guide: profile selection, tier, expected cost band, TTL,
    setup stack.
25. **CI policy lint**: a lab selecting a profile it does not need, or a setup
    stack provisioning an undeclared expensive primitive, fails the build.
26. Runbooks: quarantined account, budget breach, GuardDuty finding, pool
    exhaustion, suspected exfiltration, AWS abuse notice.
27. Dashboards: pool state by lifecycle state, lease age, cleanup success rate
    and duration, cost per lab per session, abuse signals.
28. Support and refund policy for a reclaimed environment.

### Gate G — Prove it, then open the door

Run as game days, in order, before any paying student:

| Drill | Passing means |
|---|---|
| **Exfiltration** | Credential used from off-box is detected within minutes; session killed; account quarantined |
| **Mining** | Denied families and quota ceiling hold; attempts alerted; spend bounded by the §5.4 calculation |
| **Escalation** | Every known path from the lab role fails, or the account boundary contains it |
| **Cleanup failure** | Worst permitted mess is cleaned, or quarantined and paged — never silently returned |
| **Cost blowout** | Budget action fires; loss bounded to the per-account cap |
| **Control-plane restart** | Leases reconcile from account tags; no account orphaned |
| **Pool exhaustion** | Clear capacity message; never a half-provisioned account |
| **Region escape** | Attempts in non-allowed regions are denied; janitor still sweeps every enabled region |

Then enable **one** lab, for **internal users**, in **one** region, with the
**smallest** profile.

---

## Stop condition

This specification is complete. No provider code has been written. No AWS
account, organization, IAM role, SCP, RCP, declarative policy, or resource has
been created. No AWS credential has been configured or used. No Terraform has
been run. No commit, no push, no branch operation.

Next decision belongs to the reviewer: **approve Gate A sequencing and the
Phase 0 simulated release**, or revise this specification first.
