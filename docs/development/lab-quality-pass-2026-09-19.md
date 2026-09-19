# Lab quality pass #2 — 2026-09-19

Second overnight pass on `feat/lab-quality-overnight`, started at `cae6d4b`
(rebased on `origin/main` `001bcf1`, after PR #40). The first pass is recorded
in `lab-quality-pass-2026-09-18.md`; this one re-audited the whole catalog
from scratch rather than trusting it.

## 1. Method

- **Five parallel read-only audits**, one per track group (Linux + CS, Docker +
  CI/CD, Kubernetes + networking, Terraform + AWS, Ansible + the generic
  handlers). Each finding had to cite file:line and a concrete scenario, and
  was marked PROVEN (run through the real `verifyLab`) or TRACED.
- **Every finding was re-verified here before it was fixed.** Several were
  measured live:
  - Linux/CS in real `jumptotech/lab-linux` containers: the seed, the
    student's actions, then the real verifier.
  - Ansible on a real two-node topology. The image was a private
    `jumptotech/lab-ansible:labquality` build from this branch's Dockerfile.
    It was never published, and the shared `:latest` tag was not touched.
- **A live starter-state sweep** ran all 45 Linux-provider labs with seed
  scripts (Linux, CS, AWS, NET) in real containers. None passes untouched.
- Each fix has the smallest regression test that fails against the old lab or
  handler. Where practical this was checked by swapping the old file back in.

## 2. Results

About 75 candidate findings came back from the audits. The table lists what
was fixed. Commit hashes are on the branch.

### 2.1 An incorrect solution passed (P0)

| Lab | Shortcut that passed | Fix |
|---|---|---|
| CICD-003/004/010 | steps in any order; upload before the build | `after` on `github_workflow_step_exists` |
| CICD-003/005/009/010 | `# node build.mjs` in a `run: \|` block | `run_contains` strips shell comments |
| CICD-005/009 | image/deploy job with no checkout | checkout required, and stated in the task |
| CICD-005/008/009 | `-t IMAGE_NAME`, `echo REGISTRY_URL` (name, not value) | `run_expands` / `steps_expand` |
| CICD-009 | `IMAGE_TAG: latest` (objective: tag from the commit) | `value_contains: github.sha` |
| CICD-006/007/008/010 | `agent any` only inside a stage | agent/environment read at the pipeline's top level |
| CICD-008 | `REGISTRY_URL` in another stage's environment | `jenkins_environment` = pipeline level |
| DOCKER-013 | `docker build --label` (new ID, same layers) | `must_differ` needs a changed layer |
| DOCKER-009 | answers swapped, hedged or pasted | `workspace_file_exists key_values` |
| DOCKER-004 | `CMD ["true"]` | `cmd_contains /app/banner.txt` (word-level) |
| K8S-004/005 | unmounted ConfigMap/Secret volume; `envFrom` for K8S-005 | only mounted volumes count; `env: PAYMENTS_API_TOKEN` |
| LINUX-005 | link to the run *file* plus `nohup` (measured) | runsv's `supervise/stat` |
| LINUX-015 | restart rule without NOPASSWD (measured: probe said ok, real `sudo -n` asked for a password) | `Defaults:oncall listpw=all` drop-in |
| AWS-002 | ListBucket on every bucket; payroll uploads | payroll list/upload refused; AES256 refused |
| AWS-004 | `sts:*`, `sts:Assume*` | `exact_actions` |
| AWS-005 | EC2 statement cut down; PutRolePolicy added | Describe/CreateTags allowed; PutRolePolicy refused; ECS asked too |
| AWS-018 | outputs giving the name for the ARN (and vice versa); new `Env` parameter | `cfn_output_exists resolves_to`; `cfn_property_resolves_to contains` |
| TF-002 | answers under their own keys, variables in extra keys | whole-document `equals` |
| TF-006/017/018 | typed-in values beside one real reference; written-out slug | `terraform_resource_literal_absent`; `terraform_locals_declared references` |
| TF-005 and every reference check | `"$${local_file.x.id}"` escape counted as a reference | scanner skips `$${` |
| TF-016 | the redundant `depends_on` the task forbids | `terraform_resource_depends_on absent` |
| TF-025 | `length(var.environment) > 0` (rejects nothing) | condition must name staging and production |
| ANSIBLE-004/005/006/007/008/010 | state written by hand; do-nothing or hollow playbooks (all measured live) | clearing idempotency check first; guard test |
| ANSIBLE-005 | `when: inventory_hostname == "node1"` (forbidden by the task) | `site.yml` must read `node_role` |
| ANSIBLE-008 | old tasks kept beside `roles: [web]` | `site.yml` declares no tasks; role defaults graded |

### 2.2 A normal correct solution was rejected (P1)

| Lab | Rejected | Fix |
|---|---|---|
| CICD-003 | `node-version-file` (a regression this branch introduced) | `with_any_key` |
| K8S-015 | the API default, at 3 replicas already `surge 1 / unavailable 0`; `25%` forms | bounds graded by Pods resolved; checkout-api at 4 replicas makes the story true |
| K8S-004 | a `projected` volume | projected sources count |
| K8S-017 | a shared volume not named `audit-logs` (hint-only) | name stated in the task |
| LINUX-010 | `chmod u+x`; the old port left as a comment (measured) | `script_executable`; `file_key_value PORT` |
| LINUX-017 | `Type=exec` / omitted; `Description=… (ledger-api)`; `EnvironmentFile=-…` | `one_of` + `default`; punctuation-aware words; prefix stripped |
| LINUX-003 | setgid `2770` | `file_mode special_bits: ignore` |
| AWS-002/005 | the documented Deny idiom; `StringLike` | statement-shape checks replaced by behaviour |
| AWS-006 | `OUTCOME=succeeded` (vocabulary never stated) | worksheet names the two words; `ignore_case` |
| TF-017 | a type written across lines | whitespace-insensitive `type_contains` |
| DOCKER-014 | script at another path (hint-only) | path stated in the task |
| ANSIBLE-005/007 | a task written with `with_items` (module read as `with_items`) | `with_*` keys are directives |
| ANSIBLE-007 | playbook named other than `site.yml` (never stated) | name stated in the task |

### 2.3 Answer leaks in failure details or labels (P3)

- `file_contains` printed the missing fragment. LINUX-007 gave away two of its
  three answers on one Check. It now reports counts.
- `service_selector` / `deployment_selector` printed the expected value
  (K8S-010, NET-025).
- `deployment_strategy` printed `expected 'Recreate'` (K8S-015).
- `docker_container_env` printed the region DOCKER-011 hides.
- `docker_container_port` printed the port NET-022 asks the student to
  diagnose.
- `configmap_key` printed its value; it also now refuses an empty value for a
  key that records a finding.
- Labels: AWS-006 (`… having succeeded`), AWS-012 (`… through the NAT
  gateway`).

### 2.4 Instructions that contradicted the environment (P2)

- **LINUX-014:** the task said the supervisor restarts after an edit. It
  does not, because report-runner loops forever. It now says `sv restart`.
- **LINUX-005:** misstated what `sv stop` survives.
- **CS-006:** the seeded evidence contradicted the bug. The log now shows
  what the text comparison produces, and a test checks every line against
  the rule.
- **CS-010:** the worksheet question had two defensible answers because of
  the duplicate key.
- **AWS-007:** hint 4 misstated the default. R8 now says the setting must be
  declared.
- **K8S-012:** hint 3 needs `impersonate`, which students do not have, and
  the task did not say RBAC is create-only.
- **CICD-009:** the task overstated what the branch filter prevents.
- **K8S-005 / LINUX-015 / CS-010:** stale wording and comments.

### 2.5 Verifier corrections with no current lab impact

- ForAnyValue on a missing key is now false, as the IAM documentation says.
- `with:` inputs with no value no longer count as set.

## 3. Historical findings from the first pass

| Finding | Outcome |
|---|---|
| CICD-003 node-version-file | fixed (§2.2) |
| ForAnyValue missing key | fixed (§2.5) |
| stale K8S-005 / LINUX-015 / CS-010 text | fixed |
| NET-024 "NET-023 not built yet" comment | not a defect: still true on main |
| TF-002 locals ternary | not fixed: contrived; plain literals are caught |
| workflow_secret regex | not fixed: no lab uses `via: workflow_secret` |
| LINUX-015 python3/perl… grants | not fixed: only a deliberate extra grant |
| DOCKER-011 network name | not fixed: the network is seeded, and inspect shows it |
| CS-013 placeholders | not fixed: multiple choice is fairer than the old free text |
| ANSIBLE-004 template form | not fixed: the task pins `site.yml`; tonight ANSIBLE-004 also teaches `changed_when: false`, since it gained an idempotency check |

## 4. Ansible image

The run-summary callback fix is commit `06133be` after the rebase (it was
`3609da1`). Nothing tonight changed the image. The repository builds it with
`npm run sandbox:build` / `make sandbox-build` (`scripts/sandbox-build.sh`,
tag `jumptotech/lab-ansible:latest`, or `ANSIBLE_SANDBOX_IMAGE`).

- **Why a rebuild is required:** main's image has no callback, so every
  `ansible_idempotent` check reports the run "did not complete".
- **Labs affected:** ANSIBLE-003 to -010. Tonight ANSIBLE-004 and -005 also
  gained idempotency checks, so every Ansible lab except 001 and 002 depends
  on the callback.
- **Order:** merge, then rebuild on each host, then run one Ansible lab's
  Check live, then give students access.
- **Guard:** `services/lab-orchestrator/test/ansible-image-callback.test.ts`
  now fails if the Dockerfile, the callback's name and output shape, and the
  sandbox wiring disagree.

## 5. PR #40 integration

This branch's changes are verifier/lab/schema; PR #40 changed session,
availability, ops and logging. No shared behaviour. The one shared file
(`services/lab-orchestrator/src/index.ts`) only gains exports on each side.

## 6. What remains (not fixed tonight)

| Lab / area | Weakness | Why not fixed |
|---|---|---|
| NET-002 Part 1 | still substring-graded; fields can be swapped | the keys repeat per block, and grading all 20 values plus the rest exceeds the 20-requirement cap; networking-owned |
| NET-005/006/007 | commenting out the old value fails `file_content_absent` | networking-owned labs; deferred to that branch |
| NET-025 | the app can be moved instead of the Service's targetPort | networking-owned |
| K8S-016 | a no-op init container, with the app writing the page itself | needs "command unset" and lifecycle in the snapshot |
| K8S-017 | a sidecar that ships nothing (`sleep`); api command ungraded | needs a Pod-log check; the command is a folded scalar |
| DOCKER-002/012 | a container deleted and recreated instead of kept | no container-identity check |
| DOCKER-005/006/007/009 | container images unchecked | low value; DOCKER-006 is the one worth doing |
| DOCKER-011 | statements-api recreated as `sleep` with a forged status file | needs a command check against the seeded argv |
| CICD-004 | `path: dist-release/` matches `dist` | substring by design; needs a path-aware check |
| CICD-009 | deploy step need not write the manifest | not executable here |
| CICD-010 | APP_VERSION in another step's env | needs scope on `workflow_env` |
| AWS-005 | NotResource denylist | the finding does not forbid it |
| AWS-018 | an extra statement before Statement 0; Ref-built ARN | index-pinned; the lesson is the Arn attribute |
| AWS-003 | three Deny statements | one statement required |
| LINUX-018 | `*/1` and tabs | the command allow-list cannot parse a crontab |
| LINUX-008 | only one candidate directory | low impact |
| CS-010 | a comment mentioning `leeds:` | `grep` arguments cannot anchor |
| TF-017 | replicas typed as a number | only string literals are recorded |
| api `catalog-api` tests | 5 s timeouts under full-suite load | pass alone; pre-existing; not this branch's code |
