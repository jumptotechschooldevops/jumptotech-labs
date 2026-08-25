# AWS Verification Architecture — Design

**Branch:** `claude/aws` · **Base:** `ab7aa06` · **Status:** design only
**Date:** 2026-08-23

**Nothing here is implemented.** No AWS verifier, no requirement type, no lab, no
AWS account, credential, resource, or API call. No shared platform file modified.

---

## 1. How verification works today — the shared spine

All four existing tracks travel one code path. Understanding it is the whole
brief, because AWS must not be the track that breaks it.

```
  POST /api/sessions/:id/verify
        │
        ▼
  sessions.ts · verificationTargets(session)      ← built from the SESSION RECORD
        │   k8s      only when session.provider === 'kubernetes'
        │   sandbox  sessions.sandboxPort(session)
        │   docker   only when session.provider === 'docker' → engines.session(sandboxRef)
        ▼
  verifier/registry.ts · verifyRequirement(requirement, readers)
        │   dispatch by requirementFamily(requirement.type)
        │     'kubernetes' → VerifyReader
        │     'docker'     → DockerVerifyReader
        │     else         → SandboxReader   (filesystem | terraform | linux)
        ▼
  handler.run(requirement, reader)   → { ok, detail } → pass | fail
        missing reader                → skipped  (never fail — see §1.2)
```

### 1.1 The invariant that makes it safe

Every reader **fixes its scope at construction**, from the session record, and
**no handler is ever given the chance to name a target**:

| Reader | Scope fixed at construction | Source comment |
|---|---|---|
| `VerifyReader` | `namespace` | *"The namespace is fixed at construction. A handler cannot read outside the session's own namespace, because it is never given the chance to name one."* |
| `SandboxReader` | one container, as the unprivileged student user | *"The sandbox is fixed at construction… so it cannot read another student's sandbox."* |
| `DockerVerifyReader` | one daemon | *"A handler is never given the chance to name a daemon… the `DockerEnginePort` it holds can only reach one sandbox's daemon."* |

There is no request field, and no `lab.yaml` field, that can redirect a check at
another session. **That is the property AWS must reproduce, not weaken.**

### 1.2 Two more invariants

- **A missing reader is `skipped`, never `fail`.** A platform gap must not be
  reported to a student as their mistake.
- **Type-level family separation.** `Handler<T, R>` is parameterised by reader
  type, so a filesystem handler cannot be registered against the Kubernetes
  reader — it is a compile error, not a convention.

---

## 2. Q1 — How Kubernetes requirements are verified today

- **Mechanism:** `VerifyReader` wraps `KubernetesPort` (the in-process
  Kubernetes API client) and is constructed with the session's namespace.
- **Scoping:** namespace, from `session.namespace`, derived server-side by HMAC
  from the session id. Never client-supplied.
- **Credentials:** the API's own cluster credentials — **not** the student's
  ServiceAccount token. The student's namespace-scoped kubeconfig goes only to
  the terminal service.
- **Reads:** typed snapshots (`PodSnapshot`, `DeploymentSnapshot`, …), memoised
  once per run so one report cannot contradict itself mid-rollout.
- **Family:** `kubernetes` (~90 requirement types). Only the `kubernetes`
  provider may declare them.

## 3. Q2 — How Docker requirements are verified today

- **Mechanism:** `DockerVerifyReader` wraps a `DockerEnginePort` **bound to one
  sandbox's daemon**, plus an optional `WorkspacePort` carrying the session id.
- **Scoping:** the port itself can only reach the session's own `docker:dind`
  daemon. Each sandbox generates its own CA, so another session's daemon is not
  merely unauthorised — it is cryptographically unreachable.
- **Credentials:** per-sandbox mutual-TLS client certs, held by the backend for
  verification; the student's copy goes only to the terminal.
- **Family:** `docker` (17 types), including `workspace_file_exists` and
  `dockerfile_valid`, which read the authored workspace rather than the sandbox
  filesystem.

## 4. Q3 — How Linux requirements are verified today

- **Mechanism:** `SandboxReader` over a `SandboxPort` with three capabilities:
  `read` (always), `inspect?` (allow-listed read-only binaries), `runScript?`
  (student code).
- **Scoping:** one container, entered as the unprivileged `student` user. Paths
  are validated by the schema and **re-resolved against the sandbox home by the
  provider** before any read.
- **Command safety:** `inspect` runs only `VERIFIER_COMMANDS` — a closed enum of
  22 binaries (`test`, `stat`, `id`, `getent`, `ps`, `ss`, `ls`, `cat`, `grep`,
  `find`, `awk`, …) with an argv array. **No shell anywhere on the path.**
  `runScript` is a *separate* capability precisely because running student code
  is a different thing to grant than running platform binaries.
- **Families:** `filesystem` (9 types) + `linux` (10 types). A provider offering
  reads but not inspection makes `linux` checks `skipped`.

## 5. Q4 — How Terraform requirements are verified today

- **Mechanism:** the same `SandboxReader`. There is no Terraform API and no
  cloud call. The reader parses **artefacts Terraform left on disk** —
  `terraform.tfstate`, the lock file, the working directory.
- **Scoping:** identical to Linux — one container, path-resolved.
- **Families:** `filesystem` + `terraform` (3 types). The Terraform provider
  offers `read` but **not** `inspect`, so a Terraform lab declaring
  `port_listening` is rejected at load time rather than silently never passing.
- **Why it matters for AWS:** Terraform is the existing precedent for *grading a
  cloud-shaped skill with no cloud account* — TF-001 runs with an offline
  provider mirror, no network, no credential. Phase 0 AWS follows this pattern.

---

## 6. The current AWS blocker, precisely

`services/lab-orchestrator/src/lab-definition.ts:173-181`

```ts
export const PROVIDER_REQUIREMENT_FAMILIES: Record<LabProviderId, readonly string[]> = {
  kubernetes: ['kubernetes'],
  linux:      ['filesystem', 'linux'],
  terraform:  ['filesystem', 'terraform'],
  docker:     ['docker'],
  aws:        [],          // ← every AWS requirement is rejected at load time
};
```

`checkProviderCapabilities()` (line 592) rejects any requirement whose family is
not listed, with *"…which the 'aws' provider cannot verify (it supports: no
requirement families yet)"*.

### 6.1 Important correction to my earlier report

**This does not block Phase 0.** The gate is keyed on
`environment.provider`, **not** on `track`. A lab may declare `track: aws` with
`environment.provider: linux`; nothing in the loader or the API maps a track to
a provider. A Phase-0 AWS lab therefore:

- runs in the existing Linux container sandbox,
- is graded by the existing `filesystem` family,
- requires **no new requirement type and no shared platform change**,
- and never touches `AwsLabProvider`, which stays registered-and-disabled.

`aws: []` blocks **real-AWS labs only** — the 27 of 37 that sit behind Gate C
anyway. It is a Gate C problem, not a Phase 0 problem.

---

## 7. Q5 — Proposed AWS verification architecture

### 7.1 Mechanism: backend SDK, not CLI

| Option | Verdict |
|---|---|
| **AWS CLI, read-only, shelled out** | **Rejected.** It reintroduces a command line as the unit of work — the one thing this platform has designed out everywhere (`TerminalContext` carries no command line; no requirement schema carries a shell fragment). It requires credentials reachable by a subprocess, widening exposure. Output shape is CLI-version-dependent. Throttling and partial failure surface as exit codes rather than typed errors. |
| **AWS SDK from the backend verifier** | **Chosen.** Typed responses, typed errors, first-class timeout/retry/backoff, credentials held in process memory only, and the call is chosen by *compiled handler code* rather than assembled from data. |
| **Allow-listed operations** | **Adopted, as a property of the above.** Each requirement type maps to a fixed set of read-only API calls decided at compile time. |

The CLI remains the *student's* tool inside their own sandbox, with *their* STS
credentials. It is never the verification mechanism. Keeping those two apart is
what keeps student and verifier credentials from ever being confused.

### 7.2 Trust boundary

```
   browser        ── NEVER any AWS credential, of any kind
       │
   terminal svc   ── student STS creds only, via credential_process mint handle
       │              (900 s, account-scoped, revocable)
   ────────────────────────── backend trust boundary ──────────────────────────
   verifier svc   ── JumpToTechVerifierRole   READ-ONLY, allow-listed actions
   janitor        ── JumpToTechJanitorRole    mutate/delete only
   pool manager   ── OrgLabAccess role        lease/tag/move only
```

Four principals, disjoint permissions. The student's role has no
`sts:AssumeRole` for the verifier role, and the verifier role's trust policy
names only the verifier service principal. **Compromising a student session
cannot yield read access to anything, because the student already has more read
access to their own account than the verifier grants elsewhere — and the
verifier role is not reachable from the student's role at all.**

### 7.3 Scoping — the AWS analogue of "namespace fixed at construction"

```ts
// Illustrative only — not code to be written yet.
class AwsVerifyReader {
  constructor(
    private readonly clients: AllowListedReadOnlyClients,
    readonly accountId: string,   // from the LEASE record
    readonly region: string,      // from the SESSION POLICY
    readonly sessionTag: string,  // the session's ownership tag value
  ) {}
}
```

- **Account** comes from `AwsAccountLease`, resolved from the session record.
  Never from `lab.yaml`, never from the request.
- **Region** comes from the session policy (one region in MVP). Never from
  `lab.yaml`.
- **Session tag** is the derived `jtt-aws-<hex>` sandbox ref.

### 7.4 Ownership: three independent checks per read

A resource counts as the session's only if **all three** hold. Any failure is
reported as *not found*, never as another session's resource:

1. **Tag match** — carries `jumptotech.io/session-id` equal to this session.
2. **ARN account match** — the returned ARN's `account-id` component equals the
   leased account.
3. **Discovery, not construction** — the resource was returned by a
   *list/describe within the leased account*. A name from `lab.yaml` is
   **matched against that list**; an ARN is **never built from a lab-supplied
   name**.

Rule 3 is the important one and it is not theoretical. S3 bucket names are
globally unique, so `arn:aws:s3:::<name-from-lab>` could address a bucket in a
stranger's account. Construction-from-name is therefore forbidden for every
service, not just S3.

### 7.5 ARN validation

Parsed component-wise against the documented grammar (§9.1), never by string
prefix:

- exactly the `arn:` prefix and six colon-delimited fields;
- `partition` ∈ {`aws`, `aws-cn`, `aws-us-gov`} and must equal the platform's;
- `service` ∈ the allow-list for the requirement type;
- `region` equals the session region, or is empty **only** where the service
  legitimately omits it;
- `account-id` equals the leased account, or is empty only where the service
  legitimately omits it (e.g. S3 bucket ARNs);
- **wildcards (`*`, `?`) rejected outright** in any verification operand.

### 7.6 Preventing arbitrary API calls

Four independent layers:

1. **Schema.** Every AWS requirement is a `.strict()` Zod object whose operands
   are enums, integers, parsed CIDRs, or shape-validated identifiers. **No
   schema accepts a service name, an action name, an API name, a filter
   expression, or a JMESPath.**
2. **Dispatch.** The handler — compiled platform code — chooses the call. The
   requirement type *is* the call selector.
3. **Client surface.** The reader is constructed with a narrow façade exposing
   only the allow-listed operations; the raw SDK clients are not reachable from
   handler code.
4. **IAM.** `JumpToTechVerifierRole`'s policy lists exactly the allow-listed
   read-only actions. Even a code defect cannot exceed it, and an SCP on the
   Sandbox OU denies the role anything mutating.

### 7.7 Preventing cross-student verification

- **Structural:** one leased account per session. There is no second account for
  a check to reach.
- **Constructional:** account and region fixed at reader construction.
- **Post-condition:** any ARN whose account component is not the leased account
  fails the run as a **platform error**, not as a student failure — that
  combination means a wiring bug and must be loud.

### 7.8 Preventing verification outside the leased account

- The org-access role may assume `JumpToTechVerifierRole` only in accounts
  currently in the `Sandbox/Leased` OU.
- The pool state machine refuses verification for any account not in `LEASED`
  (so `CLEANING`, `VERIFYING`, `QUARANTINE` accounts are unreachable).
- A verification run may not outlive the lease; expiry cancels it.

### 7.9 Preventing verifier credentials reaching browser or terminal

- Verifier credentials are minted **in the verifier process** and never
  persisted, never logged, never serialised.
- `TerminalContext` is a **closed union**. Adding a verifier credential to it
  would be a visible type change in review — the type system is the control.
- The internal credential route mints **student** credentials only, from the
  session record; it has no verifier-credential code path.
- The verify endpoint returns `CheckResult[]` — `{id, label, status, detail}`.
  No ARN of a platform resource, no account id, no credential. Failure detail
  describes observed state only.

### 7.10 Timeouts, retries, eventual consistency

The hardest correctness problem, and the one most likely to hurt paying
students. AWS is **not** read-after-write consistent the way the Kubernetes API
is; a correct student action may be invisible for seconds.

- **Per-check budget** and a **per-run budget**; the run budget is the one the
  UI waits on.
- **Bounded poll-with-backoff inside the handler** for existence-style checks.
- **Negative checks (`*_absent`) are the dangerous inverse** — right after a
  delete, "absent" can be observed while the resource still exists, or vice
  versa. Absence checks must require *stable* absence across at least two
  observations separated by a minimum interval, or not ship at all.
- **Honest failure text:** *"not visible after 20 s"* rather than *"you did not
  create it"*.
- **A third outcome would be better.** `CheckStatus` is `pass | fail | skipped`.
  A `pending` status would let the UI say "still settling, retry" instead of
  failing a correct student. **That is a shared contract change and is listed in
  §12 for approval — not assumed.**

### 7.11 Throttling

- SDK **adaptive retry mode** with jittered exponential backoff.
- **Per-run memoisation**, exactly as the three existing readers do — one
  Describe per object per run is the single biggest lever.
- **Concurrency cap** across simultaneous verifications; per-account API limits
  mean the account-per-session model already isolates most contention.
- Throttling exhaustion is a **platform error**, not a student failure.

### 7.12 Cleanup interaction

- Verification is **read-only**, so it cannot corrupt a cleanup in progress.
- The lifecycle gate in §7.8 prevents verification during `CLEANING`/`VERIFYING`.
- `JumpToTechVerifierRole` is **baseline**: the janitor's discovery must classify
  it as baseline and never delete it, or the account returns to the pool
  unverifiable.
- Cleanup verification (pool) and lab verification (grading) are **different
  subsystems with different roles**, and must not share a code path — one proves
  emptiness for the platform, the other proves correctness for a student.

### 7.13 Cost

- `Describe*`/`List*` management API calls are not themselves billed; the risk
  is billable *supporting* services.
- **Do not grade from AWS Config or CloudTrail data events** — both cost money
  and both lag. Prefer direct service Describes.
- Memoisation caps calls per run; a per-session verification-rate limit caps
  abusive re-verification.

### 7.14 CloudTrail and auditability

- Verifier assumes with `RoleSessionName` = session id and `SourceIdentity` =
  student id, so every read is attributable.
- Because student, verifier, janitor and pool are **four distinct principals**,
  CloudTrail can always answer *"did the platform look, or did the student
  act?"* — which a shared role would make unanswerable.
- Verifier activity is read-only, so the trail stays legible.

---

## 8. Minimum requirement vocabulary

**Rule applied: a type is proposed only if it can be verified deterministically
and safely. Convenience is not a reason.**

### 8.1 Phase 0 / SIMULATED labs — **zero new requirement types**

All 10 Phase-0 labs are gradable with the **existing `filesystem` family** on the
existing Linux provider: `file_exists`, `directory_exists`, `file_content`
(`equals`/`contains`), `file_content_absent`, `file_mode`, `path_absent`.

Determinism comes from lab design, not new machinery: students record findings
as **canonical tokens discovered in the fixtures** (a partition name, a profile
name, a CIDR, a statement `Sid`) rather than free prose. Free-form JSON must not
be graded by substring matching — that punishes correct answers that differ in
whitespace or key order, and violates the platform's "two correct solutions both
pass" rule.

**Consequence: Phase 0 needs no shared platform change at all.**

### 8.2 First real-AWS wave — 7 types, and no more

Scoped to the cheapest real wave (module B networking, plus A6). Each is a fixed
read-only call, an exact-match comparison, and no free text:

| Type | API | Why deterministic and safe |
|---|---|---|
| `aws_caller_identity` | `sts:GetCallerIdentity` | Returns one document; compared to the expected assumed-role shape. No enumeration, no ambiguity. |
| `aws_vpc_exists` | `ec2:DescribeVpcs` | Tag-filtered within the leased account; CIDR is canonical. |
| `aws_subnet_exists` | `ec2:DescribeSubnets` | Asserts CIDR + AZ; both canonical strings. |
| `aws_route_exists` | `ec2:DescribeRouteTables` | Destination CIDR parsed; target kind from a closed enum (`igw`/`nat`/`endpoint`/`eni`/`local`). |
| `aws_internet_gateway_attached` | `ec2:DescribeInternetGateways` | Boolean attachment to a discovered VPC. |
| `aws_security_group_rule` | `ec2:DescribeSecurityGroups` | Direction/protocol enums, integer port, parsed CIDR or discovered SG id. |
| `aws_resource_absent` | the above, negatively | **Ships only with the stable-absence rule of §7.10.** Without it, drop this type. |

Family `aws`; `PROVIDER_REQUIREMENT_FAMILIES.aws = ['aws']`; new
`AwsVerifierHandler<T> = Handler<T, AwsVerifyReader>` alias so the registry's
mapped types keep proving family/reader correctness at compile time.

### 8.3 Deliberately rejected

| Rejected | Why |
|---|---|
| `aws_cli_command` / `aws_api_call` / any type taking an action name | Arbitrary API execution from content. Violates §7.6 at the schema layer. Never. |
| `aws_lambda_invoke_result` | Executes student code from the platform, mutates state, costs money. The student invokes; the verifier reads the *result state*. |
| `aws_cost_estimate` / budget-based checks | Cost data lags up to 8–12 h. Not deterministic at grading time. |
| `aws_config_rule_compliant` | Config evaluation is asynchronous and lagging; also billable. Fine as lab *subject matter*, unfit as a *grader*. |
| `aws_http_reachable` | Leaves AWS; SSRF surface; network-dependent. Deferred until the §7 guards exist and only for the session's own discovered DNS name. |
| Generic `aws_resource_tagged` over any type | The resource-groups tagging API has uneven service coverage; "not found" and "not taggable" would be indistinguishable. |
| `aws_iam_simulate_*` against a **real** account | Keep for SIMULATED labs over fixtures. Against a live account AWS states results "can differ from your live AWS environment", and resource-policy simulation is unsupported for roles — so a real-account pass/fail could be wrong. |

---

## 9. AWS-001 — official-source verification

Re-opened and read from official AWS documentation on **2026-08-23**. Not taken
from the previous curriculum document.

### 9.1 ARN grammar — verified

`docs.aws.amazon.com/general/latest/gr/aws-arns-and-namespaces.html`

```
arn:{partition}:{service}:{region}:{account-id}:{resource-id}
arn:{partition}:{service}:{region}:{account-id}:{resource-type}/{resource-id}
arn:{partition}:{service}:{region}:{account-id}:{resource-type}:{resource-id}
```

Verified facts: partitions are **`aws`, `aws-cn`, `aws-us-gov`**; *"the ARNs for
some resources omit the Region, the account ID, or both"*; account id is *"without
the hyphens"*; **wildcards cannot appear in the resource-type portion or the
partition**; an incomplete ARN in an identity-based policy is auto-completed with
`*` for missing fields, **but session policies reject incomplete ARNs with
`MalformedPolicyDocumentException`**.

One framing detail worth using: ARNs *"are not considered secret, sensitive, or
confidential information."*

### 9.2 CLI credential precedence — verified, and richer than assumed

`docs.aws.amazon.com/cli/latest/userguide/cli-chap-authentication.html`
— *"Configuration and credential precedence"*, **ten** entries in order:

1. Command line options · 2. Environment variables · 3. Assume role ·
4. Assume role with web identity · 5. AWS IAM Identity Center ·
6. Credentials file · 7. Custom process · 8. Configuration file ·
9. Container credentials · 10. EC2 instance profile credentials

**Correction to the earlier AWS-001 sketch:** it assumed a short chain. The real
chain has ten steps, and two non-obvious properties worth building the lab
around — the **credentials file outranks the config file**, and **a custom
process sits between them**. That is a genuine engineering trap, not trivia.

### 9.3 Objective classification

Per the mandated four categories. **AWS-001 claims no certification coverage.**

| # | Learning objective | Classification | Justification |
|---|---|---|---|
| 1 | Read an ARN and name each component | **FOUNDATIONAL SKILL** | No SOA-C03 task statement covers ARN anatomy. Verified against the full domain 1–5 task list. |
| 2 | Identify malformed ARNs (wrong partition, wildcard in resource type, omitted region/account) | **FOUNDATIONAL SKILL** | Same. Grounded in the AWS General Reference, not an exam objective. |
| 3 | Determine which credential source the CLI uses | **FOUNDATIONAL SKILL** | SOA-C03's *introduction* says the exam validates ability to *"Perform operations by using the AWS Management Console and the AWS CLI"* — that is a validated ability, **not a numbered task statement**. Claiming an objective from it would overstate coverage. |
| 4 | Repair a misconfigured profile so the intended credentials win | **PRODUCTION SKILL** | Real operational work; no current objective covers it. |
| 5 | Recognise that the environment is not an AWS account | **SIMULATED OBJECTIVE** | The lab is graded from fixtures; the student must be told so explicitly. |

**Nothing in AWS-001 is an OFFICIAL CERTIFICATION OBJECTIVE.** It stays in the
curriculum as the prerequisite for AWS-002…006, and the catalog must not imply
exam coverage for it.

---

## 10. Blockers requiring approval

| # | Item | Needs |
|---|---|---|
| **B1** | `PROVIDER_REQUIREMENT_FAMILIES.aws = []` → `['aws']`, plus the `aws` family, schemas, `AwsVerifierHandler` alias, and `AwsVerifyReader` | Shared platform change. **Gate C.** Not needed for Phase 0. |
| **B2** | `CheckStatus` gaining `pending` for eventual consistency (§7.10) | Shared contract change. Without it, correct students will occasionally be failed by AWS propagation delay. **Recommend approving before the first real-AWS lab, not before Phase 0.** |
| **B3** | Phase 0 labs run `track: aws` on `environment.provider: linux` | **No platform change.** Needs a product decision only: is an AWS-track lab on a Linux sandbox acceptable, given the lab states plainly that it is simulated? **Recommend yes** — it is the same pattern TF-001 already uses. |
| **B4** | AWS-001 claims zero certification coverage (§9.3) | Confirm that a FOUNDATIONAL-only first lab is acceptable as the track opener. |

---

## 11. Is AWS-001 safe to implement next?

**Yes, subject to B3 and B4 — and to one design change forced by §9.2.**

- No AWS account, credential, or API call.
- No new requirement type; existing `filesystem` family only.
- No shared platform change; the catalog blocker is resolved and a regression
  test now pins the property.
- The credential-precedence material must be rebuilt around the **verified
  ten-step chain**, not the shorter one previously sketched.
- Grading must use canonical discovered tokens, never substring-matched JSON.
