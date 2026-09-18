# Lab quality pass — 2026-09-18

Branch `feat/lab-quality-overnight`, from `main` at `aadce77`. A follow-up to
[`catalog-quality-audit.md`](catalog-quality-audit.md), which made the catalog
*structurally* sound (it loads, it is placed, its files exist). This pass asked
the question that audit said it could not answer: **does each lab grade the
lesson it teaches?**

Every claim below was checked against the repository, and where it says
"measured" it was run: in a `jumptotech/lab-linux` container with the lab's
real seed scripts, with the lab image's Terraform, against Docker Engine on
this host (including a real two-node Ansible topology and a real DinD sandbox),
or through the real verifier with in-memory readers. The Kubernetes changes
were not run against a live cluster: the kind clusters on this host belong to
other stacks.

## 1. Summary

- **117 labs, 10 tracks, 1 learning path.** `npm run validate:labs`: 0 errors,
  0 warnings, before and after.
- Every lab was audited against the handler code of the checks it uses —
  what `service_port`, `file_content`, `environment_reference_exists` and the
  rest *actually* accept — not against their labels.
- **59 labs changed**, all to grade more precisely or to describe their
  starting state truthfully. No lab was added or removed; no lab's topic
  changed.
- **Five verifier capabilities added**, each because it closed a defect in
  several labs at once (§4).
- **Six platform defects fixed** that were not specific to one lab: the
  Ansible image had lost the callback every idempotency check reads (so
  ANSIBLE-006–010 could never pass), answer disclosure in two handlers, a
  comment- and `via`-blind pipeline fallback, Terraform checks reading
  subdirectories Terraform never loads, and named ports compared by spelling
  (§3.1).
- **Starter-state guard: 15 → 51 labs** proven, in `npm test`, to fail Verify
  on their untouched starting state (§5).
- **A catalog-wide label guard**: no check label may name the answer it grades
  (§3.4).

## 2. Method

1. Inventory from the registry (`realCatalog()`), not from older counts.
2. Four read-only audits, one per track group, each reading every `lab.yaml`,
   seed script and manifest in scope *and* the handler behind every
   requirement type used. The Linux/CS audit ran each lab's real seed scripts
   in a throwaway `lab-linux` container and verified bypasses there; the
   CI/CD and AWS audits ran shortcuts through the real verifier.
3. Every finding was re-verified before it was fixed. Several were adjusted:
   a proposed "worst case" reading of IAM conditions would have failed the
   standard `Deny … StringNotEquals` pattern (§4.2 does it properly instead);
   a proposed single-statement check for AWS-005 would have failed a student
   who wrote one statement per role.
4. Each fix ships with a test that fails without it. Where a test pinned the
   old, weaker behaviour, the test was changed to pin the stronger one and the
   commit says why.

Severity: **P0** a wrong or empty solution passes, or an answer is disclosed;
**P1** the lab teaches the wrong thing, its instructions contradict its
starting state, or path ordering is invalid; **P2** grading materially weaker
than the task claims; **P3** wording.

## 3. What was wrong, and what changed

### 3.1 Platform defects (verifier)

| Defect | Labs affected | Fix |
|---|---|---|
| The Ansible sandbox image had no `jtt_stats` callback: it shipped with the original Ansible branch (f6ffd7e) and was lost when the track was ported to main (5d2673b). Every `ansible_idempotent` run reported "did not complete". | ANSIBLE-006, -007, -008, -009, -010 (and -003 now) | 3609da1 — measured on a private image tag with a real topology; ANSIBLE-006 then passes 5/5 |
| `workspace_file_exists` failure listed the missing graded values — one Check on a blank worksheet printed DOCKER-009's `137`/`OOMKilled` and NET-022's answers. Fixed on an unmerged networking branch, never on `main`. | DOCKER-009, NET-022 | Cherry-picked `330a709` (c944748) |
| `environment_reference_exists` fell back to a text search that ignored comments and `via`: `sh 'echo $REGISTRY_PASSWORD \| docker login …'` passed "bound from the credential store"; a comment passed; a variable's own use passed "defined". `workflow_env` accepted a `with:` input. `jenkins_stage_exists` counted `// docker push`. | CICD-005, -008, -009, -010 | 0d2409c |
| Terraform configuration checks scanned `.tf` files four directories deep; Terraform loads only the root module. A decoy `terraform/x/decoy.tf` satisfied every configuration check. | TF-002, -005, -006, -011, -016, -017, -018, -025, -026 | 698e7f0 |
| A failed `file_mode` printed "expected 2770" — LINUX-011's whole lesson, on one Check. | LINUX-002, -003, -011, -017 | 1e0fe0a |
| A named port (`targetPort: http`, probe `port: http`) failed "expected 80", though every fixture names its port `http`. | K8S-003, K8S-008, NET-024 | 9eed55b |

### 3.2 Labs that passed an invalid solution (P0)

| Lab | Shortcut that passed | Now | Commit |
|---|---|---|---|
| CICD-004 | upload `path: nothing-here/` | path must collect `dist` (`with_contains`) | e5fbd3c |
| CICD-008 | password echoed in `sh`, nothing declared; or names in comments | declaration via the pinned mechanism | 0d2409c, e5fbd3c |
| CICD-010 | `path: build/` and undefined `APP_VERSION` left unfixed | both graded; test step required | e5fbd3c |
| CICD-005, -009 | `docker build .` untagged; deploy step `cat deploy/app.yml` | build/deploy steps must use `IMAGE_NAME`/`IMAGE_TAG` | e5fbd3c |
| DOCKER-004 | `docker run --name greeter alpine:3.20 true` | container must run the built image; RUN output must exist | 95fd5d5 |
| K8S-016 | any busybox init container, app mount dropped or probe swapped | app mount and HTTP readiness probe checked | 2fd16c8 |
| K8S-013, -015, -017 | delete and re-apply the Deployment | revision ≥ 2 proves in-place change | 2fd16c8 |
| LINUX-005 | `mkdir /etc/service/ledger-api` + `nohup` (4/4, measured) | symlink resolving to `/etc/sv/ledger-api` | 8b8a0ec |
| LINUX-007 | `seq 1 99`, `ls archive/*`, `cat archive/*` (3/3, measured) | count is the whole file; decoys refused | 8b8a0ec |
| LINUX-015 | policy granting the two commands **plus `/bin/bash`** (11/11, measured) | probe asks about shell, env, tee, su, find, less | 8b8a0ec |
| LINUX-004 | `tail -f` on the script; `echo ledger-sync` | `sh /usr/local/bin/ledger-sync` (measured) | 64570f7 |
| CS-001–004, -009–013 | every candidate value, one per line (CS-001 11/11, measured) | `file_key_value` | f38f089 |
| CS-010 | `depots.yaml` containing only `leeds:` | must parse and still describe both depots | f38f089 |
| AWS-001, -006, -012 | every candidate value listed | `file_key_value` | 014f8ba, 62b87d5 |
| AWS-002 | unconditional Allow beside the KMS-conditioned one | upload refused without KMS (`context`) | d5e723d |
| AWS-003 | Deny on the one sampled file; Deny only for non-TLS | Deny covers `customer-exports/*`; asked of a TLS request | d5e723d |
| AWS-004 | one statement trusting EC2 **and** the contractor | `exact_principals` | d5e723d |
| AWS-005 | condition parked elsewhere; never-firing Deny beside `role/*` | app roles not passable to other services; asked of an EC2 launch | d5e723d |
| ANSIBLE-003, -009 | state made ad hoc + empty/debug playbook | cleared baseline, playbook must create it (live: shortcut fails; real playbook 6/6 and 7/7) | 929bd10 |
| ANSIBLE-004 | empty vars files + literal playbook | vars files hold the values; playbook uses them (live: 10/10; literal playbook 6/10) | 929bd10 |
| NET-022 | recreated without the command (nginx back on 80) | nginx config from the container must carry the listener | b27ed51 |
| NET-002 | one line per value; two addresses and `prod` never graded | `file_key_value`, all graded | a29b4c3 |
| LINUX-009 | a script that dispatched on the file *name* | also graded on two status files it has not seen (measured 5/7 → 7/7) | df79a5c |
| K8S-004, -005 | reference added beside the original literal `env` values, which still win | literals must be gone (`deployment_env_literal_absent`) | da4e395, 54d1a69 |
| K8S-004 | one of the two settings moved | each key referenced | f85b2d0 |
| K8S-012 | Role also allowing ConfigMap update or Secret reads | both refused via SubjectAccessReview | f85b2d0 |
| DOCKER-011 | worker "configured to reach http://statements-api" on the default bridge, where the name never resolves | seeded on `statements-net`; both must stay on it (live DinD suite 12/12) | 5d6a889 |
| DOCKER-002, -014 | containers run from any image | image checked (live DinD: DOCKER-014 7/7) | 8f98587 |

### 3.3 Labs that taught or described the wrong thing (P1)

| Lab | Problem | Commit |
|---|---|---|
| CICD-010 | Starter used `${APP_VERSION}` in a `with:` input, which Actions never expands — the lab's intended repair produced an artifact literally named `statements-${APP_VERSION}`. | e5fbd3c |
| AWS-018 | Graded `Resource: !GetAtt ExportBucket.Arn` for `s3:GetObject` — the bucket ARN grants nothing on objects; the correct `${ExportBucket.Arn}/*` failed. Hint 3 taught the wrong one. | ede3384 |
| NET-003, -004, -008 | Promised "a line listing several values is graded wrong"; it was not. | 98cd4cd |
| NET-004 | Told students `ip route` shows the gateway; the segment has no default route (measured). | 98cd4cd |
| LINUX-003 | The image already has `deployers` with `student` in it: `groupadd` failed and two checks passed at start (measured). | 8b8a0ec |
| CS-013 | Graded case-sensitive `gil` for "the one-word Python reason", a word the lab never used. | f38f089 |
| K8S-019 | Story: a replica stuck at 1/2 because RWO "will not attach twice". RWO is per node; the platform cluster has one node, so both start. | 02a4fc9 |
| DOCKER-012 | "It never came up" — the provider starts and stops a `created` container, so the student sees Exited (0) and nginx logs. | 02a4fc9 |
| LINUX-017 | Draft described as four lines, two wrong (it has five, three wrong); `RestartSec=5s` rejected; runbook's root owner unchecked. | 14defab |
| ANSIBLE-008 | "The four tasks" — there are three. | 02a4fc9 |
| CS-010 | Two labels stated write-up answers ("…does not become false"). | 80fddad |
| NET-002 | Classify labels stated the answers. | a29b4c3 |
| Path | NET-024 and NET-025 create ConfigMaps before K8S-004 teaches them; NET-025 (EndpointSlices/readiness) before K8S-008. | fa39a2d |

### 3.4 New automated gates

| Gate | File | Proves |
|---|---|---|
| Kubernetes starter state | `services/verifier/test/catalog-starter-state-kubernetes.test.ts` | all 21 Kubernetes-provider labs fail Verify on their setup manifests, even with a runtime that succeeds at everything |
| Docker starter state | `services/verifier/test/catalog-starter-state-docker.test.ts` | all 15 Docker-provider labs fail a setup-decided check after the real `DockerLabProvider.create` |
| Label disclosure | `services/lab-orchestrator/test/catalog-label-disclosure.test.ts` | no label anywhere names a graded answer the task does not state |
| Per-lab shortcut suites | `cicd-labs`, `docker-labs`, `linux-labs-bypass`, `file-key-value`, `iam-condition` tests | each shortcut in §3.2 fails; a correct solution passes |

Both starter-state suites include a case where the model is given the correct
objects and must pass, so a guard cannot go green by failing everything.

## 4. Verifier capabilities added

Each was added only because it closed defects in several labs, has its own
tests, and changes no production architecture.

1. **`file_key_value`** (filesystem family). One `KEY = value` worksheet
   answer, given once, compared whole; comments and a blank placeholder
   ignored; the expected value never echoed. Closes answer-hedging in 19 labs.
2. **IAM `context`** on `iam_policy_allows` / `iam_policy_not_allows`. With a
   request context, a statement applies only when its `Condition` holds:
   String, Arn, Bool, Null, Numeric and IpAddress operators, `IfExists`,
   `ForAnyValue`/`ForAllValues`, and the documented missing-key rules.
   Anything else fails as "cannot evaluate". Without a context, unchanged.
3. **`exact_principals`** on `iam_policy_statement`.
4. **`with_contains`** on `github_workflow_step_exists`: an input's value must
   contain a fragment; the failure names the input, never the value.
5. **`deployment_env_literal_absent`**: no container sets a named variable to a
   literal. Snapshots record literal env *names* only — never values.

Also: `systemd_unit_directive` compares `…Sec` directives as systemd time
spans (`5`, `5s`, `5sec`, `5000ms`), so LINUX-017 accepts the documented
spelling.

## 5. Starter-state coverage

"Starter-state coverage" = labs for which `npm test` proves the untouched
starting state fails Verify, catalog-wide, without per-lab code.

| | Before | After |
|---|---|---|
| Sandbox-read labs (TF, LINUX-001, NET-002) | 15 | 15 |
| Kubernetes-provider labs | 0 | 21 |
| Docker-provider labs | 0 | 15 |
| **Total** | **15 / 117** | **51 / 117** |

The other 66 are labs with seed scripts (Linux, CS, AWS, networking), Ansible
and CI/CD. Most have per-lab suites with a "fails before the work" case (all
CS and AWS labs, NET-003–008, the CI/CD labs in `cicd-labs.test.ts`), but no
catalog-wide guard runs their seeds. LINUX-003/004/005/007/015 were measured
in a real container in this pass; that harness is not part of `npm test`.

## 6. What remains

### 6.1 Known weaknesses, not fixed

| Lab | Weakness | Why not fixed |
|---|---|---|
| K8S-014 | Revision ≥ 3 is reachable with two `kubectl rollout restart`s, without the broken release or a rollback. | No requirement type reads ReplicaSet history or the template's restart annotation. |
| K8S-012 | A binding to the group `system:serviceaccounts:<ns>` is invisible: the SubjectAccessReview carries no groups. | Handler change in the reader. |
| AWS-018 | `!Sub '${ExportBucket.Arn}'` without `/*` still passes. | No type reads the text around a Sub variable. |
| AWS-012 | `ServiceName` checked for presence only. | The idiom is a `!Sub`, which `equals` cannot compare. |
| AWS-008 | "Do not move deployed subnets" unchecked. | Lab is at the 20-requirement cap. |
| AWS-009 | A default route to the IGW on the private route table passes. | No absence check for CloudFormation properties. |
| ANSIBLE-009 | nginx started by hand passes. | A process cannot be reset between idempotency runs. |
| DOCKER-008 | Compose is never proven; containers started by hand pass. | No check reads Compose labels. |
| DOCKER-013 | 1.1 built with `docker commit` passes the layer check. | Would need image history inspection. |
| DOCKER-003 | Tag identity (from the previous audit). | Needs image-ID equality. |
| CICD-005 | A comment-only Dockerfile passes the substring check. | `dockerfile_valid` is Docker-family, not available to CI/CD labs. |
| TF-002 | Editing the defaults to the final values passes. | No type reads a variable's default value. |
| TF-004 | Rename-by-destroy is indistinguishable from `state mv`. | State cannot show history. |
| LINUX-006, -008, -016, -011 | Typeable evidence, partial sampling, a writer that can be edited with sudo. | Individually small; every lab grants passwordless sudo, so evidence files can always be forged by a determined student. |
| CS-005 | Stream separation is only checked via student-written files. | `script_runs` merges stdout and stderr. |
| NET-006/007 | Binding to the eth0 address is rejected; NET-007 largely repeats NET-006. | Networking owner's decision. |

### 6.2 Deferred to the networking owner

NET-022 sits in the Networking stage before Docker; the open Wave 2 branch adds
more Docker-provider labs to that stage, so its placement is a curriculum
decision, not a defect to fix here. NET-024/025 were moved within the
Kubernetes stage only (§3.3), which no open networking branch touches.

### 6.3 Curriculum gaps

- **Empty stages:** Git, Helm & GitOps, Production Engineering. Observability
  and DevSecOps hold one lab each.
- **Kubernetes:** no NetworkPolicy lab (student Role cannot write them), no
  Ingress or HPA lab (types exist, unused), no PDB type, NodePort and
  LoadBalancer blocked by the session quota.
- **Docker:** HEALTHCHECK, non-root `USER`, multi-stage and `.dockerignore`
  are gradable with existing types and have no lab.
- **Linux/SRE:** no DNS-tools, disk-pressure or SSH lab; `dig`, `lsof`,
  `strace`, `ssh` are absent from `lab-linux`.
- **Terraform:** no modules, import, workspaces or drift lab; modules would
  need the state parser to learn the `module` key.

## 7. Recommended next work

1. A catalog-wide seed-script starter-state guard in the gated sandbox
   integration suite, reusing this pass's container harness.
2. Group-aware SubjectAccessReviews for RBAC labs.
3. First labs for the empty Git and Helm/GitOps stages.
4. A Compose-label check (DOCKER-008) and image-history inspection
   (DOCKER-003, DOCKER-013).
5. Rebuild `jumptotech/lab-ansible` from this branch before the Ansible
   labs are used anywhere, and run the gated Kubernetes suites against it
   (not run here: the kind clusters on this host belong to other stacks).
