# JumpToTech Labs — AWS Track Architecture & Curriculum Analysis

> **SUPERSEDED IN PART — see [`aws-production-security-spec.md`](aws-production-security-spec.md).**
>
> That document is the approved production security specification. It corrects two
> factual errors in this file, both now checked against current AWS documentation:
>
> 1. **Account-closure quota.** This file says AWS caps closures at "10% of accounts
>    in a rolling window". The published quota is **20% of member accounts or 250,
>    whichever is higher, capped at 1,000, per 30-day period — not adjustable**.
> 2. **Reduced service quotas as a primary cost control.** This file treats
>    per-account quota *reduction* as a primary preventative control. The documented
>    Service Quotas flow supports **increases only** ("the new value must be greater
>    than the current value"). See the spec, §5 and §11.
>
> Retained as the architectural analysis it was. Do not implement from this file.

**Status:** analysis only. Nothing in this document is implemented, and nothing
in this branch creates an AWS resource, stores an AWS credential, or enables the
AWS provider. It is the design that must be argued about *before* anyone is in a
position to hand out a key.

**Scope:** the AWS **track** — labs where the student uses AWS itself. Distinct
from "run this platform on AWS", which is covered by README → *Future AWS
architecture* and is not discussed here except where the two collide (§14).

**Method:** audited the live provider/session/verifier layer on `claude/aws`
(commit `93876a4`) and designed against the seams it already has, rather than
against a hypothetical platform.

---

## Table of contents

1. [Current AWS capability audit](#1-current-aws-capability-audit)
2. [Threat model](#2-threat-model)
3. [Recommended production AWS sandbox architecture](#3-recommended-production-aws-sandbox-architecture)
4. [Credential model](#4-credential-model)
5. [Isolation model](#5-isolation-model)
6. [Cleanup model](#6-cleanup-model)
7. [Cost-control model](#7-cost-control-model)
8. [Abuse-prevention model](#8-abuse-prevention-model)
9. [Auditing model](#9-auditing-model)
10. [Provider interface proposal](#10-provider-interface-proposal)
11. [Verifier architecture proposal](#11-verifier-architecture-proposal)
12. [AWS curriculum roadmap](#12-aws-curriculum-roadmap)
13. [Approximate number of labs](#13-approximate-number-of-labs)
14. [What must be built before the first real AWS lab](#14-what-must-be-built-before-the-first-real-aws-lab)

---

## 1. Current AWS capability audit

### 1.1 What exists

| Thing | Where | State |
|---|---|---|
| `aws` in the provider vocabulary | `services/lab-orchestrator/src/providers/catalog.ts` | `LAB_PROVIDERS` includes it; `PROVIDER_SANDBOX_KIND.aws = 'cloud-session'`; `PROVIDER_ISOLATION.aws = 'none'` |
| `AwsLabProvider` | `services/lab-orchestrator/src/providers/aws-provider.ts` | Implements `LabProvider`; every lifecycle method refuses with `PROVIDER_UNAVAILABLE`; `availability()` is unconditionally unavailable |
| Registration | `apps/api/src/providers.ts` | `registry.register({ provider: new AwsLabProvider(), enabled: false, … })` — hard-coded `false`, no config flag reaches it |
| Ownership tag constants | `aws-provider.ts` | `jumptotech.io/session-id`, `/lab-id`, `/student-id` — declared, never written anywhere |
| Credential shape | `AwsSessionCredentials` | Interface only. `credentials()` throws |
| Docs allow-list | `lab-definition.ts` → `DOC_HOSTS` | `docs.aws.amazon.com`, `aws.amazon.com` already permitted in lab references |
| Written architecture | `README.md` → *Future AWS provider architecture* | STS + boundary + tags + budget sketch; explicitly defers the account-model choice |

### 1.2 What does not exist

- **No AWS SDK anywhere.** `grep -r '@aws-sdk' package.json apps/*/package.json services/*/package.json` → zero hits. There is no client, no signer, no region config.
- **No AWS credentials.** `.env.example` contains no AWS key of any kind, and states plainly that the provider "cannot be switched on from here".
- **No AWS labs.** `labs/` holds `kubernetes` (12), `linux` (10), `docker` (10), `terraform` (1). No `labs/aws/`.
- **No AWS requirement family.** `PROVIDER_REQUIREMENT_FAMILIES.aws = []` in `lab-definition.ts` — an AWS lab that declared *any* check would fail to load. The verifier physically cannot grade an AWS lab today.
- **No account, org, or budget infrastructure.** Nothing under `infrastructure/` touches AWS.

### 1.3 Seams that already fit an AWS provider

The architecture is genuinely ready in the places that matter, and this is worth
being precise about because it determines how much of §10 is new work:

- `LabProvider` is substrate-agnostic and already carries the whole lifecycle an
  AWS lease needs — `create` / `status` / `reset` / `destroy` / `listManagedSandboxes` /
  `destroySandbox`.
- `ProviderRegistry` treats **availability as data, not an exception**. An AWS
  provider that reports "no pool configured" shows the track as *Coming soon*
  with a real reason, and `resolve()` refuses to create a session against it.
- `SessionReaper` already sweeps three ways — expired, idle, **orphaned** — and
  discovers orphans by asking the *substrate*, not the store. That is exactly the
  restart-safety property an account pool needs.
- `TerminalContext` is a closed union that carries no command line; the terminal
  service builds argv itself. Adding an `aws-session` variant is additive.
- The internal credential route (`apps/api/src/routes/internal.ts`) already has
  the three properties an AWS credential mint needs: unreachable from the
  browser, accepts only a session id, response never logged.
- The verifier's handler/reader typing already makes it a *compile error* for a
  handler to reach a substrate it has no business reading.

### 1.4 Seams that do **not** fit, and will need changes

These are the honest gaps. Each is additive — none requires touching a working
provider.

| Gap | Why it blocks AWS |
|---|---|
| `PROVIDER_ISOLATION.aws = 'none'` and `ISOLATION_MODES = ['namespace','container','none']` | An AWS session's isolation boundary is an **account**. The closed list needs an `account` member, or the lab schema will keep asserting AWS labs are unisolated. |
| `deriveSandboxRef()` derives a name from the session id | An account is **leased from a pool**, not derived. The sandbox handle for AWS is a lease, and the account id comes out of a table — a fundamentally different acquisition model from every current provider. |
| `DestroyResult.namespaceGone` | Kubernetes-flavoured field carrying a substrate-agnostic meaning ("teardown is *verifiably* complete"). AWS needs the same semantics under a name that is not a lie. |
| `InMemorySessionStore` is the only `SessionStore` | An account lease that is forgotten on restart is an account that leaks money. Durable state is a hard prerequisite, not a nicety. |
| `resolveStudent()` is a dev header, not authentication | See §14. This is the single biggest blocker and it is not an AWS problem. |
| `MAX_ACTIVE_SESSIONS` is one global counter | AWS needs *per-student* concurrency and *per-student lifetime spend* caps, not just a global ceiling. |
| `SessionPolicy` has `quota` / `limitRange` / `network` / `sandbox` / `docker` blocks | Needs an `aws` block: region, budget, TTL, service profile, instance allow-list. |

### 1.5 Verdict

**Current AWS capability: zero, deliberately and correctly.** The skeleton is
not decoration — it forced the session model, the reaper, the registry and the
terminal binding to be generic before the pressure of a real integration
arrived. The remaining work is real but it is *additive*, and the riskiest
prerequisites (identity, durable persistence) are platform work the Kubernetes
track already needs.

---

## 2. Threat model

### 2.1 What we are protecting

| Asset | Loss looks like |
|---|---|
| **The AWS bill** | A single mining incident on unbounded compute is four to five figures overnight. This is the asset most likely to be attacked and the one that ends the business. |
| **Other students' work** | Cross-tenant read/write/delete. A paying student losing their lab progress to another student is a refund and a reputation loss. |
| **The platform's own AWS control plane** | Escalation from a student sandbox into the org, the management account, or the platform's production account. |
| **AWS account standing** | Abuse complaints, GuardDuty escalation, and ultimately AWS suspending the organisation — which takes *every* student offline at once. |
| **IP reputation / third parties** | Outbound scanning, brute force, spam, DDoS launched from our address space at victims who did not sign up for anything. |
| **Student data & audit integrity** | Who did what, provably, after the fact. |

### 2.2 Actors

| Actor | Capability | Motive |
|---|---|---|
| **Ordinary student** | Full use of whatever the lab role permits, from a shell and (if granted) the console | Learning; occasional honest mistake with an expensive resource |
| **Curious student** | Same, plus deliberate probing of the boundary | Sport, blog post, bug bounty fantasy |
| **Monetising abuser** | Signs up with a stolen or burner card, wants compute | Crypto mining, hash cracking, free CI, model training |
| **Infrastructure abuser** | Wants an IP address with a good reputation | Spam, phishing hosting, scanning, DDoS reflection, C2 |
| **Credential exfiltrator** | Pipes the session's STS credentials off-box and uses them elsewhere, possibly resold | Resale, or bulk automation across many stolen sessions |
| **Compromised student account** | Same as ordinary student, without the student's knowledge | Whatever the attacker wants |
| **Lab author (insider, low privilege)** | Writes `lab.yaml`, setup templates, requirements | Mistake far more likely than malice — an over-broad setup policy, a lab that provisions a NAT gateway "just for realism" |
| **Platform operator (insider, high privilege)** | Org admin | Mistake; also the actor audit logs must be able to describe |

### 2.3 Threats, ranked by expected loss

**T1 — Cryptomining / compute theft.** The default outcome of any leaked or
over-permissive credential. Detection is minutes to hours; a single large
instance family in a permissive region is meaningful money per hour, and an
abuser will start dozens. *Controls:* instance-type allow-list, per-account vCPU
service quota reduced to a hard floor, region restriction, deny of expensive
families and of Spot fleet/ASG mass-launch, short lease TTL, GuardDuty
`CryptoCurrency:EC2/*` → auto-quarantine, budget action.

**T2 — Privilege escalation out of the lab role.** The classic AWS paths:
`iam:CreateRole` + `iam:AttachRolePolicy`; `iam:PassRole` into Lambda/EC2/ECS
with a fatter role; `cloudformation` deploying with a service role; `ssm`
Run Command onto an instance with a better profile; `lambda:UpdateFunctionCode`
on an existing privileged function; modifying the lab role's own trust policy or
detaching its permission boundary. *Controls:* permission boundary that is
itself protected (deny `iam:DeleteRolePermissionsBoundary`, deny writes to any
principal under the platform's IAM path), SCP that denies IAM principal creation
entirely in sandbox accounts, and — crucially — the **account boundary**, so
that a successful escalation still lands the attacker inside a disposable
account with an SCP over it that IAM cannot override.

**T3 — Credential exfiltration.** Student pastes `~/.aws/credentials`, or a
script POSTs the STS triple to a collector. Because the credential is
*correctly* scoped, this is mostly a T1 amplifier rather than a distinct breach —
but it turns one paid session into many concurrent abusers. *Controls:* never
write static credentials to disk (`credential_process`, §4), 15-minute TTL with
re-mint, and the detection this architecture makes unusually cheap: **the
credential is only ever supposed to be used from the sandbox's egress IP**, so
CloudTrail events with a foreign `sourceIPAddress` are near-proof of exfiltration
rather than a heuristic (§8).

**T4 — Cross-tenant access.** Reading, altering, or deleting another student's
resources. In a shared-account design this is the dominant risk and the hardest
to fully close; in an account-per-session design it is structurally impossible
for anything other than a control-plane bug. This threat alone is most of the
argument in §3.

**T5 — Persistence beyond the session.** Anything that keeps running or keeps
costing after the shell closes: an IAM user with an access key, an EventBridge
schedule, a Lambda on a cron, an ASG that relaunches whatever the janitor
terminated, an S3 bucket with Object Lock that *cannot be deleted*, an RDS
instance with deletion protection, a KMS key with a 30-day pending-deletion
window. *Controls:* SCP denies the durable-persistence primitives outright;
cleanup is scorched-earth rather than surgical; an account does not re-enter the
pool until proven empty (§6).

**T6 — Denial of service against other students.** Only exists in shared-account
designs, and it needs no malice: AWS service quotas are **per account per
region**. Default VPCs per region, Elastic IPs, NAT gateways, security groups per
VPC, EIPs — one enthusiastic student exhausts a quota and every other student's
lab silently fails to provision. This is the quiet killer of the shared-account
model and it is not fixable with IAM.

**T7 — Outbound abuse.** Port scanning, SSH brute force, DDoS participation,
phishing pages, spam. Costs us AWS's goodwill and possibly the organisation.
*Controls:* deny SES/SNS-SMS/Pinpoint entirely, egress restrictions where the
lab does not need the internet, GuardDuty `Backdoor:*` / `UnauthorizedAccess:*`
→ quarantine, and a low per-account spend ceiling that caps the volume any single
account can generate.

**T8 — Data-transfer and "cheap resource, expensive usage" cost bombs.** A t-class
instance is pennies; the 40 TB it egresses is not. Likewise NAT gateway data
processing, cross-AZ chatter, S3 request floods, CloudWatch custom metrics and
Logs ingestion, and any managed service with a per-hour floor left running.
*Controls:* the allow-list is by *service and shape*, not just service name; and
the per-account budget catches what the allow-list did not anticipate.

**T9 — Lab-author error.** An over-broad setup template, a lab that leaves a NAT
gateway in the baseline, a requirement that grants `iam:*` "so the check works".
*Controls:* setup runs under a *different, reviewed* role than the student's;
the permission boundary applies to lab-created roles too; lab definitions are
reviewed and CI-linted against a policy budget (§14).

**T10 — Control-plane compromise.** Our own orchestrator credential is the org
crown jewel: it can assume into every sandbox account. *Controls:* no static
keys (instance/pod identity only), a narrowly scoped org-access role with an
external id, session-name/tag attribution on every assume, and separation
between the *lease* role, the *janitor* role and the *verifier* role so no single
credential can both provision and destroy and read across accounts.

### 2.4 Explicit non-assumptions

- **Shared credentials are not acceptable.** No credential is ever used by more
  than one session, and none outlives its session.
- **IAM alone is not a boundary.** Every IAM control is assumed defeatable by a
  sufficiently clever escalation; the account + SCP layer above it is what makes
  that survivable.
- **Detection is not prevention.** Budgets and Cost Explorer lag by hours. Any
  control whose feedback loop is hours long is a *backstop*, never the primary.
- **Students will paste credentials into things.** Design for it.

---

## 3. Recommended production AWS sandbox architecture

### 3.1 The four candidate models

#### Option A — one shared AWS account, tag-scoped roles (ABAC)

Every session assumes a role in one big account; `aws:RequestTag` forces the
session tag on create, `aws:ResourceTag` scopes every mutation to the session's
own resources.

*For:* cheapest, simplest, instant start, one CloudTrail, one budget.

*Against, and it is decisive:*
- **ABAC coverage is incomplete.** Tag-on-create and tag-based authorisation are
  per-service, per-action features. A meaningful share of the curriculum surface
  (parts of IAM, Route 53, CloudFront, some S3 operations, several console-only
  flows) cannot be constrained this way at all — so those labs either become
  unsafe or become impossible.
- **Quota exhaustion is a cross-tenant DoS** (T6) with no IAM remedy.
- **One escalation compromises every student**, and the blast radius of a
  cleanup bug is the whole tenancy.
- **Cleanup is surgical and therefore fragile** — it can only delete what it can
  prove it owns, so anything untagged or untaggable accretes forever.
- Namespace collisions on globally-unique names (S3 buckets, ECR repos) push
  every lab into per-session prefixes, which leaks the isolation mechanism into
  the curriculum.

**Verdict: not acceptable for a paid multi-tenant product.** Acceptable only for
a single-tenant internal demo.

#### Option B — a freshly created account per session

Vend a new member account at Start Lab; close it at End Lab.

*For:* the strongest possible isolation; cleanup by closure.

*Against:*
- **Latency.** Account creation is minutes, sometimes far longer, and can stall
  on verification. A student who paid to practise will not wait.
- **Closure is rate-limited.** AWS caps how many member accounts an organisation
  may close in a rolling window, and closed accounts linger in a suspended state
  before disappearing. At any real session volume the model hits a wall that
  cannot be engineered around. *(Verify the current published quota before
  committing to any design that depends on it.)*
- Every account needs a unique email address, so identity plumbing (plus-address
  or catch-all domain) becomes load-bearing.
- Per-account baseline (CloudTrail, GuardDuty, budget, roles) must be applied on
  the critical path of every single lab start.

**Verdict: correct instinct, wrong lifecycle.** Right answer for the *boundary*,
wrong answer for *when to create it*.

#### Option C — a pool of pre-vended sandbox accounts, leased per session ✅

A fixed, elastic pool of member accounts lives in a dedicated Sandbox OU,
pre-baselined and idle. Start Lab **leases** one; End Lab **returns** it; a
janitor nukes it back to baseline and only then does it re-enter the pool.

*For:*
- Account-level blast radius **without** account-creation latency — leasing is a
  database transaction.
- Per-account service quotas ⇒ **T6 disappears**: one student cannot exhaust
  another's quota.
- Per-account budget, per-account CloudTrail, per-account GuardDuty ⇒ cost and
  abuse attribution are structural, not inferred.
- Cleanup can be **scorched-earth** rather than surgical, which is the only kind
  of cleanup that is actually reliable.
- Idle accounts cost approximately nothing, so the pool is cheap insurance.
- It maps onto the platform's existing capacity model: `MAX_ACTIVE_SESSIONS`
  already reserves a slot synchronously before provisioning; a lease is the same
  shape of reservation with a real resource behind it.

*Against, and each is manageable:*
- Pool sizing must cover *sessions in flight* **plus** *accounts in cleaning*.
  Cleaning is slow (minutes), so the pool is larger than peak concurrency.
- Recycling must be provably complete, or contamination leaks between students —
  which is why "clean" is a *verified* state, not an assumed one (§6).
- Requires Organizations, SCPs, StackSets and a vending pipeline up front.

**Verdict: recommended.**

#### Option D — layer a simulated tier under the real pool ✅ (as a complement)

Not an alternative to C so much as the thing that makes C affordable. A large
fraction of what a DevOps engineer must learn about AWS can be graded **without
touching AWS**:

- IAM policy authoring, graded by policy *semantics* rather than by effect.
- VPC/CIDR design, route table and NACL reasoning, graded against a declared model.
- CloudFormation / Terraform authoring, graded on `validate` + `plan` + template
  structure — a pattern this repo has already shipped: `TF-001` runs with an
  offline provider mirror, no network, no credential.
- Cost estimation and architecture-choice reasoning.
- Troubleshooting from captured artefacts — real CloudTrail excerpts, real
  CloudWatch logs, a broken template — where the *diagnosis* is the skill.

*For:* zero cost, zero abuse surface, infinite concurrency, instant start,
deterministic grading, works offline in local dev and CI.

*Against:* an emulator is not AWS. Anything where the learning is in the real
API's actual behaviour (eventual consistency, IAM evaluation in anger, ALB
health-check semantics, real failure modes) must be tier R or it teaches a
comfortable fiction.

**Verdict: adopt as the default tier; escalate to a real account only when the
lab's learning objective genuinely requires it.**

### 3.2 Recommended architecture

```text
                       ┌────────────────────────────────────────┐
                       │ Management account (Organizations root) │
                       │  no workloads · no daily humans · MFA   │
                       │  break-glass only                       │
                       └───────────────┬────────────────────────┘
                                       │  SCPs
        ┌──────────────┬───────────────┼────────────────┬──────────────────┐
        ▼              ▼               ▼                ▼                  ▼
  ┌───────────┐  ┌───────────┐  ┌────────────────┐  ┌────────────┐  ┌────────────┐
  │ Platform  │  │ LogArchive│  │  SandboxPool   │  │ Quarantine │  │ Suspended  │
  │ OU        │  │ OU        │  │  OU            │  │ OU         │  │ OU         │
  │ api/db/   │  │ CloudTrail│  │ ┌────────────┐ │  │ SCP: deny  │  │ SCP: deny  │
  │ terminal/ │  │ S3 +      │  │ │ sandbox-01 │ │  │ everything │  │ everything │
  │ orchestr. │  │ ObjectLock│  │ │ sandbox-02 │ │  │ pending    │  │ awaiting   │
  │           │  │ write-only│  │ │ …          │ │  │ human      │  │ closure    │
  └─────┬─────┘  └───────────┘  │ │ sandbox-NN │ │  │ review     │  │            │
        │                       │ └────────────┘ │  └────────────┘  └────────────┘
        │                       └────────┬───────┘
        │  sts:AssumeRole (org access)   │
        └────────────────────────────────┘
```

**Control plane (Platform OU)** — the existing `api` / `lab-orchestrator` /
`terminal` services, plus three new pieces:

- **Account pool manager** — vends, baselines, leases, reclaims, and retires
  sandbox accounts. Owns the lease table (durable — Postgres).
- **Janitor** — per-account scorched-earth cleanup + verification.
- **Abuse responder** — consumes the central EventBridge bus (GuardDuty,
  budgets, CloudTrail anomalies) and can kill a session and quarantine an
  account without a human in the loop.

**Sandbox account baseline** — applied at vend, re-applied at every recycle, via
CloudFormation StackSets from the management account (so the student's account
never holds the template that defines its own guardrails):

| Baseline component | Purpose |
|---|---|
| `JumpToTechLabRole` + permission boundary | What the student assumes. The only student-reachable principal. |
| `JumpToTechJanitorRole` | Cleanup. Trusted only by the control plane. Not reachable from the lab role. |
| `JumpToTechVerifierRole` | **Read-only.** Trusted only by the verifier service. |
| CloudTrail → central S3 | Cannot be disabled (SCP). Org trail plus per-account. |
| GuardDuty member | Findings → central EventBridge bus. |
| AWS Config recorder | Resource history; feeds cleanup verification. |
| AWS Budgets + budget action | Per-account hard ceiling; action attaches a deny policy. |
| EventBridge rule → central bus | Abuse and lifecycle signals leave the account immediately. |
| Account tags | `jumptotech.io/pool-state`, `/lease-session-id`, `/lease-expires-at` — the substrate-side record that survives a control-plane restart. |

**SCPs on the Sandbox OU** — the layer IAM cannot argue with:

- Deny outside allowed regions via `aws:RequestedRegion`, **with an explicit
  exception list for global endpoints** (IAM, STS, Organizations, Route 53,
  CloudFront, Support) or IAM itself breaks.
- Deny the expensive-service set outright (the long tail of managed services no
  lab needs).
- Deny IAM user creation and access-key creation — no long-lived credential can
  exist inside a sandbox account, by construction.
- Deny detaching/deleting permission boundaries and deny any write to principals
  under the platform's IAM path.
- Deny disabling CloudTrail, GuardDuty, Config.
- Deny leaving the organisation, changing the account's contact details, changing
  the support plan, and Marketplace subscriptions.
- Deny the anti-cleanup primitives: S3 Object Lock configuration, RDS deletion
  protection, KMS deletion-window games, EC2 termination protection.
- Deny SES / SNS SMS / Pinpoint.

Note a practical constraint: **SCPs have a size limit and a per-target attach
limit**, so an allow-list SCP enumerating permitted services is impractical.
The workable split is **deny-list at the SCP layer** (broad, structural,
IAM-proof) and **allow-list at the permission-boundary layer** (precise,
per-lab-profile, editable without touching the org).

### 3.3 Session start, end to end

```text
 1. student clicks Start Lab
 2. SessionManager reserves a capacity slot            (exists today)
 3. AwsLabProvider.create():
      a. lease an account from the pool                (DB transaction, ~ms)
      b. tag the account with session id + deadline    (survives restart)
      c. apply the lab's setup stack via the janitor/setup role
      d. mint nothing yet
 4. session is ACTIVE; terminal opens
 5. terminal asks the internal route for a credential
      → control plane assumes OrgLabAccess → assumes JumpToTechLabRole
        in the leased account, with:
          · session policy narrowing to the lab's profile
          · role session name = session id      (CloudTrail attribution)
          · session tags: student id, lab id    (aws:PrincipalTag)
          · TTL = 15 min, re-minted on demand
 6. student works; every mutating call is bounded by
      SCP ∩ permission boundary ∩ session policy
 7. End Lab / idle / deadline / abuse signal
 8. AwsLabProvider.destroy():
      a. revoke outstanding sessions
      b. janitor nukes the account
      c. verification pass proves it is empty
      d. re-baseline, untag, return to pool
      e. only now does destroy() report complete
```

Latency at step 3 is what determines whether this feels like the other tracks.
Leasing is milliseconds; the lab's setup stack is the variable. Labs whose
starting state is heavy should pre-warm it into the pooled account's baseline
rather than build it at start.

### 3.4 Console access

An AWS curriculum without the console teaches half the job. The answer is
**not** IAM users, and not IAM Identity Center for v1:

- **Recommended:** generate a federated console sign-in URL from the session's
  STS credentials via the AWS federation endpoint. No password, no persistent
  identity, expires with the session, same role and therefore the same boundary
  as the CLI, and every console action lands in CloudTrail under the same
  session name. *(Verify current federation-endpoint semantics and session
  duration limits before implementing.)*
- **IAM Identity Center** is the better answer *later*, if the platform wants a
  persistent per-student AWS identity across sessions — but it adds directory
  provisioning, permission-set quotas, and assignment latency to the critical
  path of every lab start, for no v1 benefit.
- One caveat to carry into §8: console traffic originates from the *student's
  browser IP*, not the sandbox's egress IP, so the exfiltration signal must be
  scoped to CLI/API principals only.

---

## 4. Credential model

### 4.1 Rules

1. **No long-lived AWS credential exists anywhere in the system** — not for the
   platform, not for a student, not in `.env`, not in a secret store. The control
   plane authenticates with workload identity (instance profile / IRSA); students
   get STS only.
2. **One credential, one session.** Never shared, never reused, never outlives
   its session.
3. **Short TTL, re-minted.** 15 minutes (the STS floor) rather than a long
   session, so that revocation has teeth and an exfiltrated credential is worth
   little.
4. **Never in the browser.** The terminal service fetches over the internal,
   service-authenticated route — exactly as it does a kubeconfig today.
5. **Never on disk.** See §4.3.
6. **Never logged.** Same rule the internal route already enforces.
7. **Always attributable.** Role session name and session tags carry session,
   student and lab into every CloudTrail record.

### 4.2 The chain

```text
  control plane (workload identity, no static key)
        │  sts:AssumeRole  — OrgLabAccess role, external id
        ▼
  org-level lease principal
        │  sts:AssumeRole  — JumpToTechLabRole in the leased account
        │    · RoleSessionName = sess-<hex>
        │    · Tags = { student-id, lab-id, session-id }   (sts:TagSession)
        │    · Policy       = the lab's session policy (narrowing)
        │    · DurationSeconds = 900
        ▼
  student session credentials  ── effective permissions ──►
        SCP (OU)  ∩  permission boundary (role)  ∩  session policy (assume)
```

Three independently authored layers, each able to say no:

| Layer | Authored by | Changes | Defeats |
|---|---|---|---|
| SCP | org admin, reviewed | rarely | escalation inside the account |
| Permission boundary | platform, per service profile | per release | over-broad role policies, including ones the student creates |
| Session policy | orchestrator, per lab | per lab | a lab-specific over-grant |

The **session policy is what makes labs differ**: a `lab-profile-networking`
grants EC2/VPC read+write and nothing else; `lab-profile-serverless` grants
Lambda/SQS/SNS/API Gateway; neither can exceed the boundary, so a lab author
cannot widen the blast radius by editing a lab.

### 4.3 Delivery to the shell

Do **not** write `~/.aws/credentials`. Instead the sandbox's AWS config uses a
`credential_process` helper that calls the terminal service, which calls the
internal route, which mints. Consequences worth the extra moving part:

- No static file to exfiltrate, screenshot, or accidentally commit.
- Refresh is automatic and invisible; the student never sees an expiry.
- **Revocation actually works** — killing a session makes the next refresh fail
  within minutes rather than at the end of a long token life.
- The helper is the natural place to record credential-issue events for audit.

### 4.4 Revocation

Three levels, fastest first:

1. **Stop refreshing.** Session ends ⇒ the helper refuses ⇒ effective loss of
   access within the TTL window.
2. **Revoke outstanding sessions.** Attach the `aws:TokenIssueTime` deny policy
   to the lab role (the AWS "revoke sessions" pattern), which kills already-issued
   credentials immediately.
3. **Quarantine the account.** Move it to the Quarantine OU, where the SCP denies
   everything. Nothing inside the account can prevent this.

### 4.5 What the terminal context carries

Deliberately *not* the credential triple. The proposed `aws-session` variant of
`TerminalContext` carries a **mint handle** — the region, the account alias, the
expiry, and a token the helper presents to fetch credentials. This keeps the
existing invariant that a terminal context is safe to hold, and it means an
attacker who obtains a stale context gets nothing after the session ends.

---

## 5. Isolation model

### 5.1 The boundary, per layer

| Layer | Mechanism | Stops |
|---|---|---|
| **Account** | one leased AWS account per session | cross-tenant access, quota DoS, escalation blast radius, cleanup collateral |
| **Organisation** | SCP on the Sandbox OU | anything IAM inside the account could otherwise be talked into |
| **Role** | `JumpToTechLabRole` + permission boundary | over-broad grants, including roles the student creates |
| **Assume-time** | session policy per lab profile | one lab reaching services another lab needs |
| **Region** | `aws:RequestedRegion` in SCP and boundary | region-hopping to evade quotas, monitoring and cost caps |
| **Network** | separate account ⇒ separate VPCs by construction | student-to-student network reachability, with nothing to configure |
| **Tagging** | required session/lab/student tags on create | defence in depth + cleanup verification + cost attribution |
| **Time** | lease TTL, credential TTL, TTL tags | everything, eventually |

The account is the primary boundary; the rest are depth. That inversion — depth
*inside* a disposable boundary, rather than depth *instead of* a boundary — is
the whole argument against Option A.

### 5.2 Mapping onto the existing session model

This is where AWS genuinely differs from every current provider, and the
difference should be made explicit in the design rather than smoothed over:

| Concept | Kubernetes / Linux / Docker | AWS |
|---|---|---|
| Sandbox acquisition | **derived** — `deriveSandboxRef(sessionId, secret)` | **leased** — taken from a pool |
| Sandbox handle | `lab-<hex>` / `jtt-lab-<hex>`, HMAC of the session id | a lease id; the account id lives in the lease record |
| Restart recovery | labels on the namespace/container | tags on the AWS account |
| Teardown | delete the namespace/container | nuke + verify + re-baseline + return |
| Capacity | `MAX_ACTIVE_SESSIONS` counter | pool size (and the counter still applies) |

**Recommendation:** keep `sandboxRef` derived and non-invertible for AWS too —
`jtt-aws-<hex>` — and use it as the tag value, the role session name, and the
per-session resource prefix. Store the **account id** in the lease table, not in
the sandbox ref. Two reasons: the derived ref stays safe to display in the UI and
in logs exactly as the other providers' refs are; and the session→account
mapping stays server-side, which keeps a leaked ref from telling anyone which
account to go looking for. (The student will of course see their own account id
in the console — it is not a secret, but the *mapping* need not be public.)

### 5.3 Per-session resource prefixes

Even inside a dedicated account, every lab-created resource carries the session
prefix and the three tags. Not for isolation — the account already provides that
— but because:

- Cleanup verification can distinguish *baseline* from *student* resources.
- Cost attribution per session works from the Cost and Usage Report.
- A future decision to run cheap labs several-to-an-account (see §5.4) does not
  require rewriting every lab's curriculum text.
- It teaches a real habit: tagging what you create.

### 5.4 The one place a shared account is defensible

Tier-S labs that touch **no** AWS API need no account at all. And a narrow class
of genuinely read-only labs ("here is a pre-built environment, diagnose it")
could safely share one account with a read-only role, since there is nothing to
isolate. Both are worth keeping in the design because they cost nothing and
scale infinitely — but neither is the model for labs where the student *creates*
anything.

---

## 6. Cleanup model

Cleanup is the control that everything else leans on: a short TTL is worthless
if teardown is unreliable. The design principle is **an account is not clean
until something has proved it is clean.**

### 6.1 Four independent mechanisms

**1. Lease expiry (primary).** The session's absolute deadline and idle timeout
already exist and already run through `SessionManager.expire()` and
`SessionReaper`. AWS adds no new trigger — it reuses the state machine, so a
reaped AWS session goes through the same `EXPIRING → … → EXPIRED` path a
student-initiated End Lab does.

**2. Janitor nuke (the actual deletion).** `JumpToTechJanitorRole` enumerates and
deletes **everything that is not baseline**, in dependency order, across all
allowed regions. Not "delete by tag" — scorched earth, because the resources most
likely to cost money are exactly the ones most likely to have escaped tagging.
Known-hard cases the janitor must handle explicitly:

- ASGs before instances, or the ASG relaunches what was terminated.
- ENIs, NAT gateways, endpoints and dependencies before subnets/VPCs.
- Unattached EBS volumes, snapshots, AMIs and Elastic IPs — all cost money while
  looking idle.
- S3 versioned buckets: delete markers and all noncurrent versions.
- RDS with deletion protection and final-snapshot requirements.
- KMS keys, which schedule rather than delete.
- CloudFormation stacks in `DELETE_FAILED`, which need retained-resource handling.

Several of these are why the SCP denies the anti-cleanup primitives in the first
place: the cheapest way to make cleanup reliable is to forbid the states that
make it impossible.

**3. Cleanup verification (the gate).** After the nuke, an independent read-only
pass — driven from AWS Config plus service-level list calls in every allowed
region — asserts that the account contains *only* baseline resources. Outcomes:

- **Clean** ⇒ re-baseline, untag, return to pool.
- **Dirty, retryable** ⇒ retry with backoff, up to a bound.
- **Dirty, stuck** ⇒ move the account to the **Quarantine OU**, page a human,
  and *never* return it to the pool.

This mirrors `DestroyResult.namespaceGone`: teardown is not "we called delete",
it is "we looked, and it is gone." `destroy()` must not report complete before
this gate passes, or the reaper's idempotent re-entry loses its meaning.

**4. In-account backstops.** For the window between "something went wrong" and
"the control plane noticed":

- **TTL tags.** Every resource carries `jumptotech.io/expires-at`; a scheduled
  Lambda in the account's own baseline deletes expired resources even if the
  control plane is down.
- **Budget action.** At 100% of the per-account budget, attach a deny-all policy
  — the account stops spending regardless of what is running.
- **Org-level reconciliation.** A daily sweep over account tags finds leases
  whose `lease-expires-at` has passed with no matching live session. This is the
  AWS analogue of the reaper's orphan sweep, and it is what makes a control-plane
  restart survivable.

### 6.2 Pool arithmetic

```
  pool size ≥ peak concurrent AWS sessions
            + accounts in cleaning     (cleanup minutes × session churn rate)
            + accounts in quarantine
            + headroom
```

Cleaning time is the parameter that dominates. Reducing it — by making the
baseline small, restricting to one region, and forbidding slow-deleting services
— is worth real engineering effort, because it converts directly into a smaller
pool.

### 6.3 What is never asked of the student

Nothing. Cleanup is never homework, and a lab must never *depend* on a student
having cleaned up. (Labs may *teach* cleanup, and may verify that a student
deleted something — but the platform's own cleanup does not trust it.)

---

## 7. Cost-control model

### 7.1 The ordering principle

Controls are ranked by **feedback latency**, because a control that reacts in
hours cannot stop an attack that completes in minutes.

| Control | Latency | Role |
|---|---|---|
| Service allow-list (session policy ∩ boundary) | instant | primary |
| Instance-type / size allow-list | instant | primary |
| Region restriction | instant | primary |
| **Service quotas, reduced per account** | instant | primary — the hard ceiling |
| Lease TTL | minutes | primary |
| TTL-tag sweeper | minutes | secondary |
| GuardDuty → auto-quarantine | minutes | secondary |
| Cost Anomaly Detection | hours | backstop |
| AWS Budgets + budget action | **hours** | backstop |
| Human review of the bill | days | last resort |

**Budgets are a backstop, not a control.** Cost data lags; by the time a budget
action fires, the money is spent. The controls that actually bound the loss are
the allow-list and the *service quota*, because a quota is a technical ceiling
that no IAM misconfiguration can exceed.

### 7.2 Reduced service quotas

Under-appreciated and, in an account-per-session model, unusually powerful: the
per-account quota becomes a **per-student** quota. Reduce, at vend time, at least:

- Running On-Demand vCPUs (per family) to the minimum any lab needs.
- Elastic IPs, NAT gateways, VPCs, internet gateways.
- RDS instances, EBS volume total storage, snapshot count.
- Lambda concurrency.

Two caveats to verify before relying on this: not every quota is adjustable, not
every adjustable quota can be adjusted *downward* without a support case, and
quota changes can be slow to apply — so this must happen at vend time, not lease
time.

### 7.3 Allow-lists are by shape, not by name

"EC2 is allowed" is not a cost control. The boundary pins:

- instance **types** (a short list of small, current-generation types);
- storage **type and size** (no provisioned IOPS, capped GB);
- absence of per-hour-floor resources unless a specific lab profile needs them —
  NAT gateways, dedicated hosts, Global Accelerator, managed EKS control planes,
  and anything with a minimum billing commitment.

Where a lab genuinely needs an expensive primitive (a NAT gateway lab, an EKS
integration lab), it gets its own profile, its own shorter TTL, and its own price
in the curriculum's cost model.

### 7.4 Cost attribution and the feedback loop

Session/lab/student tags flow into the Cost and Usage Report, giving
**cost per lab per session**. That number is a product input, not just an ops
metric:

- A lab whose median session costs more than its share of the subscription is a
  **curriculum bug** — either it is too long, too generous, or it belongs in
  tier S.
- Pricing and session-length policy can be set from measurements rather than
  guesses.
- Anomalies at the *lab* level surface abuse patterns that per-account budgets
  are too coarse to see.

### 7.5 The structural advantage

An idle pooled account costs essentially nothing. Unlike always-on lab
infrastructure, the AWS track's cost floor is near zero and its cost scales with
actual use — which is what makes a per-student spend cap (§8) a coherent product
control rather than an arbitrary limit.

---

## 8. Abuse-prevention model

### 8.1 Before the session — friction at the door

Compute-theft economics are the target: make an account cost more to obtain than
the compute it can steal.

- Verified payment method, verified email; the first paid interval is the entry
  price.
- Rate limits on signups per card, per IP block, per email domain.
- New accounts start with a **lower** concurrency cap, a **shorter** lease TTL and
  a **smaller** service profile; these relax with account age and completed labs.
  A brand-new account is the highest-risk actor, and progressive trust costs
  legitimate students nothing.
- Lifetime and rolling-window spend caps **per student**, enforced in the control
  plane before a lease is granted.

### 8.2 During the session — detection

**The strong signal.** In this architecture the session credential is only ever
used by the sandbox, so its egress IP is known. **Any CloudTrail event for a
session principal from a different source IP is exfiltration** — not a heuristic,
close to proof. Very few platforms can make that statement; it falls out of
never writing credentials to disk and never sending them to the browser. Scope it
to CLI/API principals: federated console traffic legitimately comes from the
student's own browser IP and needs a separate rule.

**Other signals, all cheap:**

| Signal | Source | Response |
|---|---|---|
| `CryptoCurrency:EC2/BitcoinTool.B*` and related | GuardDuty | kill session, quarantine account, flag student |
| `UnauthorizedAccess:EC2/SSHBruteForce`, `Backdoor:*` | GuardDuty | same |
| Denied-by-SCP call storm | CloudTrail | boundary-probing; raise risk score, alert |
| Launch attempts of denied instance families | CloudTrail | mining intent; raise risk score |
| Session start rate per student | control plane | throttle |
| Spend velocity per student | CUR + control plane | throttle, then suspend |
| Multiple concurrent sessions from distant IPs | control plane | account-sharing or resale |

All of these arrive on one central EventBridge bus, and the abuse responder can
act **without a human**: end the session, revoke credentials, quarantine the
account. Automatic response matters because the attack window is minutes.

### 8.3 Structurally denied, so never detected

Cheaper than detection: SES, SNS SMS and Pinpoint denied outright (spam);
IAM users and access keys denied (persistence); Marketplace subscriptions denied
(a creative way to spend money); support plan changes denied; leaving the
organisation denied. Outbound port 25 is already blocked by AWS on EC2 by
default.

### 8.4 After — response ladder

```
  risk score ↑ → shorter TTL, smaller profile, fewer concurrent sessions
             → manual review queue
             → AWS track suspended, other tracks unaffected
             → account suspended, refund policy applied
             → account quarantined and retired; never returned to the pool
```

Note the third rung: because tracks are independent providers, suspending a
student's AWS access does not have to remove the Kubernetes, Linux, Docker or
Terraform product they also paid for.

---

## 9. Auditing model

### 9.1 Requirements

Answer, months later and defensibly: *who* did *what*, in *which account*, during
*which session*, on *which lab*, and *what did it cost*.

### 9.2 AWS-side

- **Organisation CloudTrail**, all accounts, all regions, delivered to a
  write-only S3 bucket in a dedicated **LogArchive** account with Object Lock.
  No principal in any sandbox account — and no ordinary org admin — can delete
  it. SCP forbids disabling the trail.
- **Attribution by construction.** `RoleSessionName = sess-<hex>` puts the
  session on every event, and `sts:TagSession` puts student and lab into
  `aws:PrincipalTag`, so filtering CloudTrail by student is a query rather than a
  join through a table that may have been rewritten.
- **AWS Config** for resource configuration history — what existed, when, and in
  what state. Doubles as the cleanup-verification data source.
- **GuardDuty** findings retained centrally.
- **Cost and Usage Report** tagged by session/lab/student.
- **Role separation in the audit trail.** Student actions (`JumpToTechLabRole`),
  cleanup (`JumpToTechJanitorRole`), verification (`JumpToTechVerifierRole`) and
  provisioning are distinct principals, so "the platform deleted it" and "the
  student deleted it" are never ambiguous.

### 9.3 Platform-side

The control plane keeps its own durable log, because some events have no AWS
representation:

- lease granted / returned / quarantined, with account id and session id;
- **every credential mint** — session, lab, requester, TTL — which is the record
  that makes §8's exfiltration analysis meaningful;
- session lifecycle transitions (already modelled);
- verification runs and outcomes;
- abuse decisions and who or what made them.

### 9.4 Handling and hygiene

- **Student ids in AWS tags, never emails.** Tags are widely readable, appear in
  billing exports, and are hard to redact retroactively. Keep the mapping in the
  platform's own database.
- Credentials, tokens and sign-in URLs are never logged — the rule the internal
  route already enforces, extended to the mint path.
- Retention and access policy defined up front: audit data is read by a small
  number of principals, and reads are themselves logged.

---

## 10. Provider interface proposal

**Additive only.** Nothing here requires a change to `KindLabProvider`,
`LinuxLabProvider`, `DockerLabProvider` or `TerraformLabProvider`.

### 10.1 Vocabulary changes (`providers/catalog.ts`)

```ts
// ISOLATION_MODES gains 'account' — an AWS session's boundary is an account,
// and the current PROVIDER_ISOLATION.aws = 'none' asserts something false.
export const ISOLATION_MODES = ['namespace', 'container', 'account', 'none'] as const;

PROVIDER_ISOLATION.aws   = 'account';
PROVIDER_SANDBOX_KIND.aws = 'cloud-session';        // unchanged
SANDBOX_REFERENCE_LABEL['cloud-session'] = 'account'; // was 'session scope'
```

### 10.2 `LabProvider` — what maps and what strains

| Method | AWS meaning | Fit |
|---|---|---|
| `availability()` | pool configured, org reachable, free accounts exist | clean |
| `create(ctx)` | lease account → tag → apply lab setup stack | clean; `ProvisionStep[]` reports each phase, which the UI already renders |
| `status(ctx)` | lease state + stack state | clean |
| `reset(ctx)` | nuke + re-apply setup **in the same account** | works, but slow (minutes). Consider "return lease, take a fresh pre-warmed one" as the fast path |
| `destroy(ctx)` | revoke → nuke → **verify** → re-baseline → return | clean, but see `namespaceGone` below |
| `execute(ctx, req)` | internal health check (`sts:GetCallerIdentity`) | clean |
| `getTerminalContext(ctx)` | new `aws-session` variant | additive union member |
| `listManagedSandboxes()` | leases reconciled against **account tags** | clean — account tags are the AWS analogue of namespace labels, and preserve restart-safety |
| `destroySandbox(ref, sid)` | reclaim one leased account by ref | clean; must re-read account tags before acting, exactly as the container providers re-read labels |

**The one strained field:** `DestroyResult.namespaceGone`. Its *meaning* —
"teardown is verifiably complete, so the reaper may stop re-entering" — is
exactly right for AWS; its *name* is Kubernetes-specific. Proposal: add
`sandboxGone: boolean` to `DestroyResult` and have existing providers set both,
with `namespaceGone` kept as a deprecated alias. Purely additive; no working
provider changes behaviour.

### 10.3 New terminal context variant

```ts
| {
    kind: 'aws-session';
    /** Region the session is pinned to. */
    region: string;
    /** Display-only account alias. Never used to authorise anything. */
    accountAlias: string;
    /**
     * Handle the sandbox's credential_process helper presents to fetch
     * short-lived STS credentials. NOT a credential. Useless after the
     * session ends, which is the point.
     */
    mintHandle: string;
    /** Optional, when the lab includes console work. Short-lived. */
    consoleSignInUrl?: string;
    sandboxRef: string;
    workspaceFiles?: Array<{ path: string; content: string }>;
    env?: Record<string, string>;
    expiresAt: string;
  }
```

Carrying a mint handle rather than the credential triple preserves the existing
property that a terminal context is safe to hold, and it is what makes
mid-session revocation effective.

### 10.4 Session policy block

`SessionPolicy` gains an `aws` block, populated from configuration exactly as
`docker` is — never from literals in provider code:

```ts
export interface AwsSessionPolicy {
  /** Regions the session may touch. One, in v1. */
  regions: string[];
  /** Session-policy profile name, e.g. 'networking' | 'serverless'. */
  profile: string;
  /** STS credential lifetime in seconds. 900 = the STS floor. */
  credentialTtlSeconds: number;
  /** Hard ceiling for this session, in cents. Drives the budget action. */
  budgetCents: number;
  /** Maximum lease minutes, independent of the session idle timeout. */
  maxLeaseMinutes: number;
  /** Whether this lab grants a federated console URL. */
  consoleEnabled: boolean;
}
```

### 10.5 New components (not part of `LabProvider`)

```text
  AwsAccountPool          lease() / return() / quarantine() / capacity()
                          durable store — Postgres, not memory
  AwsOrgClient            Organizations + StackSets + account tagging
  AwsCredentialMinter     the assume-role chain of §4.2; the only code that
                          ever holds a credential
  AwsJanitor              nuke + verify (§6)
  AwsAbuseResponder       EventBridge consumer (§8)
```

`AwsLabProvider` composes these; the platform above it still sees one
`LabProvider`.

### 10.6 Configuration and the two-gate pattern

Mirror the Docker precedent exactly — registry-level `enabled` **and** the
provider's own probe, deliberately redundant:

```
AWS_TRACK_ENABLED=false            # default false, always
AWS_ORG_LAB_ACCESS_ROLE_ARN=
AWS_ORG_EXTERNAL_ID=
AWS_SANDBOX_REGION=eu-central-1
AWS_POOL_MIN_ACCOUNTS=0
AWS_POOL_MAX_ACCOUNTS=0
AWS_SESSION_BUDGET_CENTS=200
AWS_CREDENTIAL_TTL_SECONDS=900
AWS_MAX_LEASE_MINUTES=45
AWS_CONSOLE_ENABLED=false
```

Note what is *absent*: there is no `AWS_ACCESS_KEY_ID` and no
`AWS_SECRET_ACCESS_KEY`, in any environment, ever. The control plane uses
workload identity. A design where those keys have a home is a design that will
eventually leak them.

### 10.7 Local development and CI

There must be a first-class **`AWS_TRACK_MODE=simulated`** in which the provider
runs against an emulator or fixtures and cannot reach real AWS even if
credentials were somehow present. Two reasons: tier-S labs need it in production
anyway (§3.1 D), and a mocked AWS in tests proves only that the mock returns what
it was told to — so the tests that matter run against the emulator, and the real
path is proven by a small number of deliberately-run integration tests plus game
days (§14).

---

## 11. Verifier architecture proposal

### 11.1 A new requirement family

```ts
// requirements.ts
REQUIREMENT_FAMILIES: { aws_vpc_exists: 'aws', … }

// lab-definition.ts
PROVIDER_REQUIREMENT_FAMILIES.aws = ['aws'];   // currently []
```

The existing family machinery does the rest: an AWS lab declaring `pod_running`
or `file_mode` fails at **load time** with a precise authoring error, and the
mapped types in the verifier registry make it a **compile error** to register an
AWS handler against the Kubernetes reader.

### 11.2 `AwsVerifyReader` — read-only, separate principal

The verifier assumes `JumpToTechVerifierRole`, **not** the student's role. This
matters more than it looks:

- The verifier can see things the student's profile does not permit, so grading
  is never limited by the student's own grants.
- The verifier physically cannot mutate the account, so a buggy handler cannot
  destroy a student's work mid-lab.
- Verifier activity is separable in CloudTrail from student activity.

The reader is bound to **one session's account**, resolved from the session
record — never from the browser, exactly as `namespace` is today.

### 11.3 Three properties AWS breaks that the current readers do not

1. **Eventual consistency.** Kubernetes reads are read-after-write; AWS often is
   not. A check that runs immediately after a student's `create` may legitimately
   see nothing. The reader needs bounded poll-with-backoff and a clear "not yet"
   versus "not there" distinction — otherwise the verifier fails correct students
   at random, which is the worst possible bug in a paid product.
2. **Throttling.** List/Describe calls are rate-limited per account per region.
   With many concurrent verifications the reader needs adaptive backoff and
   per-call caching within a single verification run.
3. **Cost.** API reads are free, but the supporting services are not
   (Config recording, CloudTrail data events, CloudWatch queries). Verification
   design should prefer direct Describe calls over billable query services.

### 11.4 Requirement vocabulary sketch

Grouped as the curriculum needs them. All read **state**, never how the student
got there — two different correct solutions must both pass, which is the existing
platform philosophy and matters more on AWS, where console, CLI, CloudFormation
and Terraform are all legitimate routes to the same state.

| Group | Types (sketch) |
|---|---|
| Identity | `aws_iam_role_exists`, `aws_iam_role_trust_allows`, `aws_iam_policy_attached`, **`aws_iam_simulate_allows` / `aws_iam_simulate_denies`** |
| Networking | `aws_vpc_exists`, `aws_subnet_attributes`, `aws_route_exists`, `aws_igw_attached`, `aws_nat_gateway_exists`, `aws_security_group_rule`, `aws_nacl_rule`, `aws_vpc_endpoint_exists`, `aws_peering_active` |
| Compute | `aws_instance_exists`, `aws_instance_state`, `aws_instance_type`, `aws_instance_profile`, `aws_ebs_volume_attached`, `aws_ami_exists` |
| Storage | `aws_s3_bucket_exists`, `aws_s3_public_access_block`, `aws_s3_encryption`, `aws_s3_versioning`, `aws_s3_policy_denies`, `aws_s3_object_exists` |
| Scaling & LB | `aws_target_group_health`, `aws_alb_listener_rule`, `aws_asg_capacity`, `aws_asg_policy`, `aws_launch_template_config` |
| DNS | `aws_route53_record`, `aws_route53_health_check` |
| Observability | `aws_log_group_exists`, `aws_log_event_matches`, `aws_metric_alarm`, `aws_dashboard_exists`, `aws_cloudtrail_enabled` |
| Messaging & serverless | `aws_sns_topic`, `aws_sqs_queue`, `aws_sqs_redrive`, `aws_subscription_exists`, `aws_lambda_function`, `aws_lambda_invoke_result`, `aws_apigw_route`, `aws_eventbridge_rule` |
| Data | `aws_rds_instance`, `aws_rds_multi_az`, `aws_rds_backup_retention`, `aws_dynamodb_table`, `aws_dynamodb_index` |
| Containers | `aws_ecr_repository`, `aws_ecr_image_exists`, `aws_ecs_service_stable`, `aws_task_definition_config`, `aws_eks_nodegroup_ready` |
| Security | `aws_kms_key_rotation`, `aws_secret_exists`, `aws_ssm_parameter`, `aws_guardduty_enabled`, `aws_sg_not_open_to_world` |
| Generic | `aws_resource_tagged`, `aws_resource_absent`, `aws_http_reachable` |

**The standout is `aws_iam_simulate_allows` / `_denies`.** IAM's own policy
simulator answers "can this principal do X on Y" using AWS's real evaluation
logic — free, read-only, and *exactly* the question an IAM lab is asking. It
grades least-privilege work objectively without provisioning anything, and it
makes a large block of high-value IAM labs runnable in **tier S**. This is the
single highest-leverage verifier capability in the proposal.

`aws_http_reachable` (for ALB/API Gateway labs) is the one check that reaches the
public internet. It must resolve the target from the session's **own** resources
via the verifier role — never from a URL in the lab file or from student input —
with the usual SSRF guards.

### 11.5 Fixture-based verification for tier S

Tier-S labs need a reader that answers from a declared model rather than from
AWS: a student's CloudFormation/Terraform artefact, a policy document, or a
network design. Handlers are the same shape; the reader differs — which the
existing `Handler<T, R>` typing already supports without any new machinery.

---

## 12. AWS curriculum roadmap

### 12.1 Design principles

- **DevOps/cloud engineer, not exam cram.** The measure is "could this person be
  handed an AWS account on their first week", not "can they recall a service
  limit". Certification alignment (Solutions Architect Associate, DevOps
  Engineer Professional) falls out of coverage rather than driving it.
- **Story-driven, like the existing tracks.** The JumpToTech Bank narrative that
  runs through the Kubernetes, Linux and Docker labs carries over: the same
  fictional platform team, now on AWS.
- **State-verified.** Console, CLI, CloudFormation and Terraform are all valid
  routes; the checks read the result.
- **Tier the labs by what they actually require:**
  - **S** — simulated / offline. No AWS account. Instant, free, infinitely concurrent.
  - **R** — real leased account, cheap resources.
  - **R$** — real leased account, expensive primitive (NAT, EKS, RDS, ALB-hours).
    Shorter TTL, dedicated profile, explicit cost budget.
- **Every module ends in a troubleshooting lab**, because diagnosing someone
  else's broken environment is the actual job.

### 12.2 Modules

**M0 — Account model, identity, and the CLI** *(6 labs · S/R)*
Regions and AZs; the account as a boundary; CLI configuration, profiles and
credential resolution order; STS and temporary credentials; reading an ARN;
finding your own effective permissions. *Establishes the vocabulary every later
module leans on.*

**M1 — IAM in depth** *(9 labs · mostly S)*
Policy documents; identity vs resource policies; evaluation logic and explicit
deny; roles and trust policies; `PassRole`; permission boundaries; conditions and
ABAC; least-privilege from a CloudTrail excerpt; cross-account access. *Graded
largely by policy simulation (§11.4) — highest-value, lowest-cost block in the
curriculum.*

**M2 — Networking** *(12 labs · R, one R$)*
VPC and CIDR planning; subnets and AZ placement; route tables; internet gateway;
NAT (R$); security groups vs NACLs; public/private topology end to end; VPC
endpoints; peering; DNS in a VPC; flow logs; **networking troubleshooting**.
*The module that most separates people who can use AWS from people who cannot.*

**M3 — Compute and block storage** *(9 labs · R)*
Launching EC2; instance metadata and IMDSv2; user data; instance profiles; EBS
volumes, resize and snapshots; AMIs; Systems Manager Session Manager (and why
it beats a bastion); patching basics; **compute troubleshooting**.

**M4 — S3 and object storage** *(7 labs · R/S)*
Buckets and object operations; storage classes and lifecycle; versioning;
encryption; Block Public Access and bucket policies; presigned URLs; static site
hosting; **"why is this bucket public" forensics**.

**M5 — Load balancing, scaling, and DNS** *(8 labs · R$)*
Target groups and health checks; ALB listener rules and path routing; NLB vs ALB;
launch templates; Auto Scaling groups and scaling policies; instance refresh;
Route 53 records and routing policies; **"the health check is failing" troubleshooting**.

**M6 — Observability** *(8 labs · R/S)*
CloudWatch metrics and custom metrics; the CloudWatch agent; Logs, log groups and
retention; Logs Insights queries; alarms and composite alarms; dashboards;
CloudTrail as an investigation tool; **incident reconstruction from logs and trail**.

**M7 — Decoupling and serverless** *(10 labs · R)*
SNS topics and subscriptions; SQS queues, visibility timeout, dead-letter queues;
fan-out; EventBridge rules and schedules; Lambda basics, packaging, environment,
and execution role; Lambda + SQS; API Gateway to Lambda; Step Functions; **"the
messages are stuck" troubleshooting**.

**M8 — Data stores** *(8 labs · R$/R)*
RDS provisioning; Multi-AZ and failover; parameter and option groups; backups,
snapshots and point-in-time restore; DynamoDB tables, keys and access patterns;
secondary indexes; capacity modes; **"the database is slow / unreachable"
troubleshooting**.

**M9 — Containers on AWS** *(8 labs · R/R$)*
ECR repositories, push/pull, lifecycle policies and scanning; task definitions;
ECS on Fargate; ECS services behind an ALB; service autoscaling; EKS *from the
AWS side* — IRSA, the AWS Load Balancer Controller, node groups (R$);
**container troubleshooting**. *Deliberately narrow: Kubernetes itself is the
existing K8s track's job; this module is the AWS integration surface.*

**M10 — Security, secrets, and crypto** *(8 labs · R/S)*
KMS keys, policies and rotation; envelope encryption in practice; Secrets Manager
and rotation; SSM Parameter Store and SecureString; GuardDuty findings triage;
Security Hub and Config rules; WAF basics; **security incident triage**.

**M11 — Automation and infrastructure as code** *(8 labs · S/R)*
CloudFormation templates, parameters, outputs and change sets; drift detection;
nested stacks; Terraform against real AWS (bridging the existing Terraform
track); remote state on S3 with locking; SSM Automation and Run Command;
CodeBuild/CodePipeline basics; **"the stack is stuck in ROLLBACK" troubleshooting**.

**M12 — High availability and disaster recovery** *(6 labs · R$/S)*
Multi-AZ design and failure injection; backup and restore drills; RTO/RPO
reasoning; cross-region replication; graceful degradation; **failover exercise**.

**M13 — Cost engineering** *(5 labs · S)*
Reading a bill; Cost Explorer and tagging strategy; right-sizing from CloudWatch
data; storage and data-transfer cost traps; purchase options. *Almost entirely
simulated — real bills are the wrong teaching instrument and the wrong risk.*

**M14 — Capstone troubleshooting scenarios** *(10 labs · R/R$)*
Multi-service broken environments seeded by the lab's setup stack: a three-tier
app that will not serve traffic, an IAM change that broke a pipeline, a
cost spike to diagnose, a security finding to close. *These are the labs
employers actually care about, and the ones the platform's state-based
verification is best at grading.*

### 12.3 Sequencing

```text
  M0 ─► M1 ─► M2 ─► M3 ─► M4
              │      │     │
              └──────┴─────┴─► M5 ─► M6
                                │     │
                                ├─────┴─► M7 ─► M8
                                │              │
                                └─► M9 ◄───────┘
                                     │
              M10 ◄──────────────────┤
              M11 ◄──────────────────┤
              M12 ◄──────────────────┤
              M13 ◄──────────────────┤
              M14 ◄──────────────────┘  (requires most of the above)
```

M0–M2 are the hard prerequisite spine. M13 can be taken at any point. M14 is
terminal.

---

## 13. Approximate number of labs

### 13.1 Full track

| Module | Labs | Tier mix |
|---|---:|---|
| M0 Account, identity, CLI | 6 | 3 S · 3 R |
| M1 IAM | 9 | 7 S · 2 R |
| M2 Networking | 12 | 3 S · 8 R · 1 R$ |
| M3 Compute & EBS | 9 | 1 S · 8 R |
| M4 S3 | 7 | 2 S · 5 R |
| M5 LB, scaling, DNS | 8 | 1 S · 3 R · 4 R$ |
| M6 Observability | 8 | 3 S · 5 R |
| M7 Decoupling & serverless | 10 | 2 S · 8 R |
| M8 Data stores | 8 | 2 S · 3 R · 3 R$ |
| M9 Containers | 8 | 1 S · 4 R · 3 R$ |
| M10 Security & crypto | 8 | 3 S · 5 R |
| M11 Automation & IaC | 8 | 4 S · 4 R |
| M12 HA & DR | 6 | 2 S · 1 R · 3 R$ |
| M13 Cost engineering | 5 | 5 S |
| M14 Capstone troubleshooting | 10 | 1 S · 6 R · 3 R$ |
| **Total** | **122** | **40 S · 65 R · 17 R$** |

**≈ 120 labs for a complete track** — comparable in ambition to the Kubernetes
track's current 12 scaled to AWS's surface area, and enough that "practised AWS
here" means something to an employer.

**About a third (40 labs, 33%) need no AWS account at all.** That is the number
that makes the economics work: the whole IAM module, the cost module, most of
IaC, and every design-reasoning lab run at zero marginal cost and zero abuse
surface.

### 13.2 Phasing

| Phase | Labs | Content | Requires |
|---|---:|---|---|
| **Phase 0 — simulated pilot** | 10 | M1 IAM (7 S) + M13 cost (3 S) | **No AWS account, no org, no pool.** Only the verifier's simulated reader and the `aws` requirement family. Ships the track, proves the curriculum, earns revenue, risks nothing. |
| **Phase 1 — MVP real** | +12 (22) | M0 + M2 core networking | Full org, pool, janitor, budgets, identity, durable persistence — everything in §14 |
| **Phase 2 — core track** | +26 (48) | M3, M4, M5, M6 | Expensive-primitive profiles; cost model validated by real numbers |
| **Phase 3 — depth** | +34 (82) | M7, M8, M9, M10 | Mature cleanup for slow-deleting services |
| **Phase 4 — complete** | +40 (122) | M11, M12, M14 | Multi-service setup stacks; longer leases |

**Phase 0 is the recommended first move** and deserves emphasis: it delivers a
real, sellable AWS track — IAM is the single most valuable and most commonly
weak AWS skill — while creating **no account, no credential, and no cost**. It
also builds the `aws` requirement family and handler layer that Phase 1 needs, so
none of it is throwaway.

---

## 14. What must be built before the first real AWS lab

Ordered. Each gate blocks the next. "Real" means an actual AWS account is leased
to an actual student.

### Gate A — platform prerequisites (not AWS work, and the real blocker)

1. **Authentication.** `apps/api/src/identity.ts` resolves a *development
   identity from a request header* and says so. Session possession is currently
   the entire authorisation model. You cannot bill, rate-limit, cap spend,
   attribute abuse, or ban anyone without real identity. **This is the single
   largest blocker and it is not an AWS problem** — it is item 3 on the README's
   own migration path.
2. **Durable session and lease persistence.** `InMemorySessionStore` is the only
   implementation. A lease that is forgotten on restart is an account that leaks
   money indefinitely. Postgres-backed `SessionStore` plus an account-lease table,
   with the capacity reservation moved into a transaction so it holds across API
   instances.
3. **Per-student limits.** `MAX_ACTIVE_SESSIONS` is one global counter. AWS needs
   per-student concurrency, per-student rolling spend, and per-student lifetime
   spend caps.
4. **Billing integration**, sufficient to know a student is paid up before a
   lease is granted, and to apply the abuse ladder of §8.4.

### Gate B — AWS organisation foundation

5. Organisation, OU structure (Platform / LogArchive / SandboxPool / Quarantine /
   Suspended), management account locked down with MFA and break-glass procedure.
6. SCPs authored, reviewed, and **tested against a real account** — including
   the global-endpoint exception, without which IAM and STS break.
7. LogArchive account with the write-only, Object-Locked CloudTrail bucket; org
   trail enabled; GuardDuty and Config enabled org-wide.
8. Account vending pipeline (Control Tower Account Factory, AFT, or a custom
   Organizations + StackSets pipeline), producing a fully baselined account
   without manual steps.
9. Baseline StackSet: the three roles, the permission boundary, budget + budget
   action, EventBridge forwarding, TTL sweeper, reduced service quotas.
10. Permission boundary and the first session-policy profile, reviewed by someone
    who has personally attempted an escalation out of them.

### Gate C — cleanup, proved before anything else

11. **Janitor** covering every service the first lab profile permits, in
    dependency order.
12. **Cleanup verification** that gates return-to-pool, with the Quarantine path
    for accounts that fail.
13. **A destructive test suite**: seed an account with the worst mess the profile
    allows — ASG relaunching instances, versioned bucket, RDS with deletion
    protection, stuck CloudFormation stack, unattached EIPs — and prove the
    janitor returns it to baseline, repeatedly, unattended.

*Cleanup must be proven before the first student, not after. Everything else in
this design assumes it works.*

### Gate D — control plane

14. `AwsAccountPool` with durable leases, capacity reporting into the existing
    session capacity model, and reconciliation from account tags after restart.
15. `AwsCredentialMinter` implementing §4.2 — the only component that ever holds
    a credential.
16. `AwsLabProvider` implementing `LabProvider`, plus the additive vocabulary
    changes of §10.1 and the `sandboxGone` field of §10.2.
17. `aws-session` terminal context, the `credential_process` helper, and the
    sandbox image that ships the AWS CLI.
18. Two-gate enablement (`AWS_TRACK_ENABLED` **and** the provider's own probe),
    default off, with `AWS_TRACK_MODE=simulated` as the developer/CI default and
    **no static-key configuration path anywhere**.
19. `AwsAbuseResponder` consuming the central bus, able to end a session and
    quarantine an account with no human in the loop.

### Gate E — verifier

20. `aws` requirement family + `PROVIDER_REQUIREMENT_FAMILIES.aws`.
21. `AwsVerifyReader` on the read-only verifier role, with bounded retry for
    eventual consistency and adaptive backoff for throttling.
22. Handlers for the first lab profile's types, including the IAM simulator
    checks.

### Gate F — content and operations

23. Lab authoring guide for AWS: which profile, which tier, expected cost, TTL,
    and the setup stack.
24. **CI policy lint**: a lab whose profile exceeds its declared services, or
    whose setup stack provisions an expensive primitive without declaring it,
    fails the build.
25. Runbooks: quarantined account, budget breach, GuardDuty finding, pool
    exhaustion, suspected exfiltration, AWS abuse notice.
26. Dashboards: pool state, lease age distribution, cleanup success rate,
    cost per lab per session, abuse signals.
27. Support and refund policy for "my lab environment was reclaimed".

### Gate G — prove it, then open the door

Before the first paying student, run these as **game days**, in this order:

| Drill | Passing means |
|---|---|
| **Exfiltration** | Take a session credential off-box and use it from elsewhere. Detected within minutes; session killed; account quarantined. |
| **Mining** | Attempt to launch maximum permitted compute and denied families. Blocked by quota and allow-list; attempts alerted; spend bounded. |
| **Escalation** | Attempt every known escalation path from inside the lab role. All fail, or the account boundary contains the ones that do not. |
| **Cleanup failure** | Create the worst permitted mess and abandon it. Janitor cleans it, or quarantines the account and pages — never silently returns it to the pool. |
| **Cost blowout** | Spend against the budget deliberately. Budget action fires; loss is bounded to the per-account cap. |
| **Control-plane restart** | Kill the API mid-session. Leases reconcile from account tags; no account is orphaned. |
| **Pool exhaustion** | Request more sessions than the pool holds. Students get a clear capacity message, never a half-provisioned account. |

Then, and only then, enable **one** lab, for **internal users**, in **one**
region, with the **smallest** profile.

---

## Appendix — summary of recommendations

| # | Question | Recommendation |
|---|---|---|
| 1 | Current capability | Zero by design; skeleton correct; six additive gaps (§1.4) |
| 2 | Dominant threat | Compute theft, then escalation, then cross-tenant access |
| 3 | Account model | **Pool of pre-vended, leased, recycled sandbox accounts**, with a simulated tier underneath |
| 4 | Credentials | STS only, 15-min TTL, `credential_process`, never on disk, never in the browser, no static key anywhere |
| 5 | Isolation | Account is the boundary; SCP ∩ boundary ∩ session policy is the depth; `sandboxRef` stays derived, account id stays in the lease table |
| 6 | Cleanup | Scorched earth + **verification gate** + quarantine; TTL tags and budget actions as in-account backstops |
| 7 | Cost | Allow-list and **reduced service quotas** are the controls; budgets are the backstop; measure cost per lab per session |
| 8 | Abuse | Progressive trust, structural denial, and the exfiltration signal that falls out of never writing credentials to disk |
| 9 | Audit | Org CloudTrail to an Object-Locked archive; attribution via role session name and session tags; separate roles for student/janitor/verifier |
| 10 | Provider | Additive: `account` isolation mode, `sandboxGone`, `aws-session` context, `AwsSessionPolicy`, two-gate enablement |
| 11 | Verifier | New `aws` family on a read-only role; bounded retry for eventual consistency; **IAM policy simulation** as the highest-leverage check |
| 12 | Curriculum | 15 modules, story-driven, tiered S / R / R$, every module ends in troubleshooting |
| 13 | Size | ≈122 labs full; 33% need no AWS account; **start with a 10-lab simulated Phase 0** |
| 14 | Prerequisites | **Authentication and durable persistence first** — they are platform work, they block everything, and they are not AWS problems |
