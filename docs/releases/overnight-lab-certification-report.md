# Overnight lab certification — 2026-09-20/21

Branch `feat/overnight-lab-certification`, worktree `~/jtt-overnight-lab-certification`.

| | |
|---|---|
| Base commit | `d4e301b892f4f772e1a6eb7e20dd37b2d4fe9a0e` (Merge PR #44) |
| Final commit | see `git log -1` on the branch (the commit that adds this report) |
| Commits | 34 (32 fixes/tests/docs + fixture update + this report) |
| Files changed | 117 (2 920 insertions, 210 deletions) |
| Pushed / merged | No / no |

Scope: labs, verifiers, curriculum and student exercises only. Broad platform
hardening was out of scope (another agent's). Nothing here changes a shared
`:latest` image, a cloud account, or another worktree.

## 1. What was inspected

**117 labs** discovered, all registered, all placed exactly once in the
`devops-engineer` learning path (`npm run validate:labs`: 0 errors, 0 warnings
before and after).

| Track | Labs | Provider(s) |
|---|---|---|
| Foundations (CS) | 13 | linux |
| Linux | 17 | linux |
| Networking | 10 | linux (7), docker (1), kubernetes (2) |
| Docker | 14 | docker |
| CI/CD | 10 | cicd |
| AWS (simulated) | 11 | linux |
| Terraform | 13 | terraform (offline provider mirror) |
| Kubernetes | 19 | kubernetes |
| Ansible | 10 | ansible |

Method. Every lab was read in full — story, task, objectives, hints,
requirements and every setup/workspace asset — and compared against the
handler code for each requirement it uses. The catalog was split into seven
slices audited in parallel (k8s + NET-024/025; docker + NET-022; AWS;
Terraform; Ansible + CI/CD; Linux + CS; networking NET-002–008). Every finding
had to be **proven**: by a probe test grading the real lab from the real
catalog through the real `verifyLab`, and for most high/medium findings also by
a measurement in the real lab image (`jumptotech/lab-linux`, `lab-terraform`
with Terraform 1.9.8, `ansible-playbook`). The two earlier lab-quality reports
(2026-09-18, 2026-09-19) were read first and their fixed items not re-audited.
Each fix was then made here with a regression test, and a second pass searched
the catalog for repeats of every defect pattern (§6).

## 2. Certification status by category

| Category | Status | Evidence |
|---|---|---|
| Foundations (CS) | **repository validated** | all 13 read; lab-level tests; 4 instruction/grading fixes |
| Linux | **repository validated**, partially runtime-validated | all 17 read; LINUX-010 / 014 / 015 fixes measured in the lab-linux image |
| Networking (NET-002–008) | **repository validated**, partially runtime-validated | sudo / ping / tcpdump findings measured as uid 1001 in the image (rebuilt tonight as a private `:labcert` tag) |
| Networking (NET-022/024/025) | repository validated | NET-022 fixed; NET-025 targetPort item still open (networking-owned, §7) |
| Docker | repository validated; **requires runtime evidence** for the new DOCKER-010 check | docker010 integration test updated, not run tonight (docker-in-docker not exercised) |
| CI/CD | **repository validated** | fake-project lab tests; builds/tests run by the real project checks in the unit harness |
| AWS (simulated, no cloud) | **repository validated** | policy/template evaluation tests; no AWS account involved or needed |
| Terraform | **repository validated**, runtime-validated for the reported shortcuts | each shortcut reproduced with a real `terraform apply` in the lab image before the fix |
| Kubernetes | repository validated; **requires runtime evidence** for K8S-014's new history check and K8S-003's reachability check on a live cluster | every local kind cluster's controller manager was crash-looping tonight (host load), so no live rollout was measurable |
| Ansible | repository validated; **blocked for live use until the shared image is rebuilt** | `jumptotech/lab-ansible:latest` has no `jtt_stats` callback (verified tonight); ANSIBLE-003–010 idempotency checks cannot pass on it |

## 3. Defects found and fixed

Counts: **53 defects fixed** — **32 false positives**, **8 false negatives**,
**10 instruction defects** (the student could not succeed as told, or was
misled) and **3 stale or wrong docs/comments**. **54 lab directories** changed;
more labs benefit from the shared fixes without a lab.yaml change (DOCKER-014,
TF-011/016/026 and every lab using the HCL, Jenkinsfile and workflow readers).
A defect spanning several labs with one cause is counted once. Findings
deliberately not fixed are in §7.

### 3.1 Shared verifier / parser fixes (affect many labs)

| Component | Defect | Kind |
|---|---|---|
| HCL reader (`terraform/hcl.ts`) | A `#`/`//` comment inside a multi-line expression swallowed everything after it: a comment in `depends_on` or `jsonencode({…})` hid the student's references (TF-002/005/016 proven; 006/011/017/018/026 same path), and comment text counted as condition/type content (TF-025, TF-017). Value now built from tokens. | FN + FP |
| Jenkinsfile parser | `// stage('Lint') {` or a `/* */`-kept stage was read as a real stage and hid the next one; `# node --test` inside `sh '''…'''` counted as running the tests (CICD-006/007/008/010). | FN + FP |
| Workflow / Jenkins step matching | `echo node build.mjs`, `sh 'echo TODO node --test'` passed as running the command (CICD-003/005/006/007/009/010). New `as_command` / `steps_as_command`: the fragment must start a command. | FP |
| GitHub `min_steps` | A step with neither `run` nor `uses` (rejected by GitHub) counted (CICD-002/003/004). | FP |
| Docker entrypoint compare | `ENTRYPOINT ["./batch.sh"]` under `WORKDIR /app` rejected although it runs `/app/batch.sh` (DOCKER-014). | FN |
| IAM statement match | New `unconditional` (AWS-003). | capability |
| `file_content_absent` | New `ignore_comment_lines` (NET-005/006/007). | capability |
| `workload_volume_mount` | Now accepts `kind: statefulset` (K8S-019). | capability |
| `terraform_resource_literal_absent` | New `through_locals`, `case_sensitive` (TF-002/006/017/018). | capability |
| New `deployment_revision_history` | Reads the Deployment's own ReplicaSets (K8S-014). `KubernetesPort.listDeploymentReplicaSets`. | capability |
| New `terraform_output_references` | An output's value reaches a source, with prefixes for renamable objects (TF-003). | capability |
| `environment_reference_exists` | New `via: workflow_env_global` (CICD-005/009). | capability |

### 3.2 Per-lab fixes

| Lab | Defect | Kind |
|---|---|---|
| K8S-003 | Headless Service (`--clusterip=None`, the `--help` example) passed a lab about a stable address → `service_http` | FP |
| K8S-004/005/011 | "Still running after the change" satisfied by the old ReplicaSet while the new template crash-looped → `deployment_rollout_complete` | FP |
| K8S-014 | Two `rollout restart`s passed the rollback lab → `deployment_revision_history` | FP |
| K8S-017 | Native sidecar required but only hinted; the lab's own reference shows the ordinary form → task states it | instruction/FN |
| K8S-019 | Claim template never mounted passed → mount check; task states the path | FP |
| NET-002 | Part 1 answers swappable between fields/blocks → per-block worksheet keys + `file_key_value` | FP |
| NET-003 | Hint sent students to `ping`, which cannot run without NET_RAW (exit 126) → `nc -v` | instruction |
| NET-004 | `ip route` output satisfied "neighbour table captured" → `lladdr` | FP |
| NET-005 | Append-only log kept an old good line → latest cycle only | FP |
| NET-005/006/007 | Old value kept as a comment failed "no longer configured" | FN |
| NET-005/006/007 | Config files and `sv` are root's; text never said sudo (measured: access denied) | instruction |
| NET-007 | Diagnosis words case-sensitive although "any sentences" | FN |
| NET-008 | `tcpdump` needs sudo (student has no effective caps; measured) | instruction |
| NET-022 | Diagnosis worksheet substring-graded; swapped/half answers passed | FP |
| DOCKER-010 | nginx containers left running `sleep` passed → command check | FP |
| DOCKER-014 | Relative exec-form entrypoint rejected | FN |
| AWS-002 | `NotResource` Allow (every bucket but payroll) passed | FP |
| AWS-003 | Deny with a never-firing Condition passed | FP |
| AWS-004 | Edited "do not alter" permissions policy passed | FP |
| AWS-008 | A7 outputs of AZ/CIDR/Join passed | FP |
| AWS-012 | DynamoDB endpoint's ServiceName unchecked (both endpoints to S3 passed) | FP |
| AWS-012 | `NAT_SHARE_REMOVED=88%` refused; sheet now says number only | instruction |
| TF-002 | `type = any` passed | FP |
| TF-003 | Five literal outputs passed; text contradicted itself | FP/instruction |
| TF-005 | `${path.module}/…` filename failed exact output; task now says how to write it | instruction |
| TF-006/018 | Value typed into a local got past the literal check | FP |
| TF-017 | `optional(bool)` + editing the forbidden tfvars passed | FP |
| TF-018 | Printed answers typed into locals (`scaled_replicas = 12`) passed | FP |
| TF-025 | Postcondition asserting nothing about region passed | FP |
| ANSIBLE-006 | group_vars value ungraded (typed into site.yml instead) | FP |
| ANSIBLE-008 | Empty role `templates/` passed via Ansible's search-path fallback | FP |
| CICD-005/009 | Job-level env passed "workflow-level" (deploy job got an empty tag) | FP |
| CICD (all 10) | `npm run build` / `npm test` refused silently → workspace README states the graded commands | instruction |
| CICD-005 | Task cited a README lab list that does not exist | stale text |
| LINUX-003 | Root-owned home (`useradd` without -m + `sudo mkdir`) passed | FP |
| LINUX-004 | `./ledger-sync` from its directory failed; task now says "full path" | FN/instruction |
| LINUX-008 | Wiped archive + `touch index.txt` passed | FP |
| LINUX-010 | `kill -9` orphaned the squatter's listener; lab passed intermittently (measured 22/40, 14/40) → seed `exec -a` | FP |
| LINUX-014 | Terminal is `bash --norc`; the lab's premise (.bashrc read) was false → task has student source it | instruction (HIGH) |
| LINUX-014 | PATH entry with trailing slash failed a healthy service | FN |
| LINUX-015 | Sudo rule `* ledger-api` permitted `restart payments-api ledger-api` (measured) → probe asks it | FP |
| LINUX-017 | `Group=` omitted (= primary group ledger) refused → systemd default | FN |
| CS-003 | Placeholder invited the line's text; only its number accepted | instruction |
| CS-009/010/011/012/013 | Source checked for pasted answers without the task saying so | instruction |
| CS-010 | `country: NO` passed the unquoted-code check | FP |
| DOCKER-004 | Reset comment claimed the student's Dockerfile is removed | doc |

## 4. Tests added

New files: `services/verifier/test/{kubernetes,terraform,ansible,linux,networking}-lab-certification.test.ts`,
`services/lab-orchestrator/test/catalog-student-shell.test.ts`.
Extended: `statefulset-requirements`, `rollback-requirements`, `requirements`,
`docker-labs`, `docker-command`, `aws-002/003/004/008/012-verification`,
`cicd-labs`, `linux-014-environment`, `networking-net005`,
`networking-requirements`, `terraform-labs-literals`,
`terraform-hcl-references`, `linux-labs`, `terraform-labs`,
`docker010-integration` (Docker-gated), `apps/api catalog-api`.
The test `FakeSandbox` now answers `tail -n` and `grep` from the files it holds.

Each regression test states the shortcut that used to pass ("Before: …") and
the valid alternatives that must keep passing.

Catalog-level guards added (Phase 17), each checked against the base commit's
text to confirm it would have caught the original defect:

- container labs: `sv …` and packet captures must say sudo; `ping` only in a
  lab granting NET_RAW; a seed that writes `~/.bashrc`/`~/.profile` needs a task
  that has the student source it;
- a worksheet key graded by `file_key_value`/`key_values` appears once in the
  template the lab seeds (34 graded keys covered; seed-script worksheets not).

## 5. Commands and results

All on node 22.23.2, final tree unless noted.

| Command | Result |
|---|---|
| `npm run validate:labs` | 117 labs, 0 errors, 0 warnings |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `npm run test:security` | 868 passed, 0 failed (api 259, terminal 112, sandboxd 82, lab-orchestrator 202, verifier 8, observability 195, web 10) |
| `npm test` (first run, before the last fixture commit) | 2 real failures found and fixed (K8S-003 label list in `catalog-api`; NET-002 fixture in `networking-requirements`); 3 `catalog-api` 5 s timeouts under full-suite load |
| `npm test` (final tree) | **5 568 passed, 0 failed**, 335 skipped (integration-gated): api 668, web 259, lab-orchestrator 1 381, observability 924, progress 96, sandboxd 148, terminal 180, verifier 1 912 — the catalog-api timeouts did not recur |
| `vitest run test/catalog-api.test.ts --root apps/api --no-file-parallelism` (alone, default timeout) | 33/33 passed — the three timeouts are load-only, as recorded before tonight |

Baseline before any change (same machine, under heavy load from seven
parallel audits and an image build): verifier 1808/1810, lab-orchestrator
1370/1372 — all four failures were 5 s timeouts in CPU-heavy tests
(`line-value`, `catalog-validation`), not assertions.

Runtime measurements made tonight (private image tags only, containers removed):
`LINUX_/TERRAFORM_/ANSIBLE_/CICD_SANDBOX_IMAGE=jumptotech/lab-*:labcert npm run sandbox:build`
(shared `:latest` untouched); student-shell capability/sudo/ping/tcpdump in
`lab-linux:labcert`; the LINUX-010 `exec -a` listener under SIGKILL; the
sudoers wildcard behaviour for LINUX-015; `sudoedit`'s editor; the audit
agents' Terraform 1.9.8 applies and `ansible-playbook` runs.

### Skipped, and why

- Integration suites gated by `RUN_INTEGRATION_TESTS` / `RUN_DOCKER_INTEGRATION_TESTS`
  (kind, docker-in-docker, sandboxd, TLS edge, network policy): not run. The
  kind clusters were unhealthy (below) and a docker-in-docker run would have
  added load; the DOCKER-010 integration test was updated but not executed.
- Live Kubernetes: every local kind cluster (`jumptotech-labs`, `jtt-p0-019`,
  `jtt-p0-020`) had its `kube-controller-manager` in CrashLoopBackOff (leader
  election timeouts; ~170–185 restarts). A throwaway namespace confirmed the
  Deployment controller was not creating ReplicaSets, so the K8S-014 rollout
  history could not be measured. The namespaces were deleted.
- `e2e` (Playwright) and `test:db`: out of lab scope, not run.

## 6. Second pass — patterns searched catalog-wide

| Pattern | Searched | Result |
|---|---|---|
| availability without rollout after a change | all K8s labs | K8S-004/005/011 fixed; K8S-010/012 correct as is |
| comment/answer in source rejects correct program | all CS labs | warnings added to CS-009–013; CS-005's check is on output |
| absence check on a config where a comment is a valid retirement | all `file_content_absent` | NET-005/006/007 fixed; LINUX-016 is a mass retarget (not applicable) |
| append-only log graded by substring | all `/var/log` checks | NET-005 fixed; LINUX-014/018 also check live status/freshness |
| repeated worksheet keys / swappable substrings | all multi-substring checks | NET-002, NET-022 fixed; others are `key=value` literals or cross-checked by rendered state |
| container running a keep-alive instead of the service | Docker labs | DOCKER-010 fixed; DOCKER-012's seed has no keep-alive path |
| sudo / capability assumptions | all container labs | fixed + guarded by a catalog test |
| workflow-level env | CI/CD labs | CICD-005/009 fixed; CICD-010 left (below) |

## 7. Not fixed — remaining lab risks

| Item | Why not fixed |
|---|---|
| **Ansible shared image** `jumptotech/lab-ansible:latest` lacks the `jtt_stats` callback (verified tonight) | Operator action: rebuild with `npm run sandbox:build` after merge. Until then ANSIBLE-003–010 cannot pass. |
| Docker/Ansible workspace **reset keeps student-authored files** (terminal `seed` overwrites declared files, removes nothing; the in-memory fake wipes everything) | A terminal-service contract decision (its port doc says reset must equal a fresh start). No wrong grade: images/containers are purged. |
| DOCKER-011 command check | An exact 458-char argv match would fail students who retype the command; the only bypass is deliberate forgery of the health file. |
| DOCKER-004 `CMD echo /app/banner.txt`; DOCKER-009 cpu-quota message; `FROM ${ARG}` / `@digest` | Low; need new capabilities. |
| ANS-F3 duplicate YAML keys | Rejecting them is defensible (YAML 1.2; Ansible warns). |
| LINUX-018 exec-bit check vs `/bin/sh tool` | The missing execute bit is one of the lab's deliberate faults. |
| LINUX-009 hard-coded HOST; LINUX-008 single candidate dir | Low; needs a capability. |
| NET-025 app moved instead of targetPort | Networking-owned; design in the k8s findings (`service_port target_port: 3000`). |
| NET-022 placed in the Networking stage before Docker | Deliberate: the networking branch adds more Docker-based labs there. |
| AWS-005 NotResource denylist; AWS-018 index-pinned statement; AWS-007/008 AZ names unchecked; CFN `!GetAtt X.VpcId`-style ids refused where `Ref` is graded; unknown CFN short tags dropped | Low / needs a capability or is a style of answer the hints steer away from. |
| CICD-010 APP_VERSION scope; CICD-004 `dist-release/`; CICD-001 pipeline.sh graded as text | Known from earlier passes; the task text is honest about them. |
| K8S-016 no-op init container; K8S-017 `sleep` sidecar | Known; need log/command capabilities. |

## 8. Operator follow-up after merge

1. Rebuild the sandbox images on each host: `npm run sandbox:build` (ANSIBLE
   callback; also picks up nothing else from this branch — lab content ships
   in `labs/`, not the images).
2. Restart the API so the catalog reloads (new requirement types:
   `deployment_revision_history`, `terraform_output_references`; new options on
   six existing types). Schema changes are additive.
3. On a healthy cluster, run K8S-003 and K8S-014 end to end once (undo,
   `undo --to-revision`, two restarts) to confirm the live behaviour this
   branch relies on; and DOCKER-010's integration test
   (`npm run test:integration:docker` or the docker010 file).
4. The local kind clusters' controller managers are crash-looping; recreate
   them before any Kubernetes lab validation on this host.
5. Students mid-session on NET-002 keep their old worksheet (new keys arrive on
   Start/Reset); tell anyone on NET-002 to Reset.

## 9. Verdicts

- **Ready for code review: YES.** Every change is small, lab-scoped or an
  additive verifier option, has a regression test, and typecheck, build,
  `test:security` and the lab suites are green.
- **Lab repository ready for five-student real-host validation: YES, with
  conditions** — the Ansible image must be rebuilt first (else ANSIBLE-003–010
  fail for everyone), the host needs healthy kind clusters, and K8S-014 /
  K8S-003's new checks should be exercised once live before students rely on
  them.
