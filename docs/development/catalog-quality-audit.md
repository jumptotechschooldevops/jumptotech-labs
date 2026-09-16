# Lab catalog quality audit

Audit of the lab catalog and the learning-path system at `cb7804a` (main after
PR #33, NET-025), on branch `feat/catalog-quality-audit`, 2026-09-16.

Re-checked the same day after rebasing onto `0f33b1f` (main after PR #34,
beta overnight hardening). PR #34 changed no file under `labs/`, no
learning-path file and nothing in `services/lab-orchestrator`, so the catalog
numbers below are unchanged. Where it changed a conclusion, the section says so
(§9, §13, §14, §18).

Every number here was derived from repository files by loading them through
the same registry and loaders the API uses, not from older summaries. Scripts
were run against the real `labs/` directory; where a claim depends on a
heuristic, the heuristic is stated.

**Static validation passing does not mean the labs teach well.** It means they
are structurally sound: they load, reference files that exist, sit in a
consistent order, and are placed in the path. Sections 9 and 13 list where
verification is weaker than it could be.

## 1. Executive summary

- **117 labs** load with **0 registry errors**. The flagship DevOps Engineer
  path places **all 117 exactly once**, with **0 path validation errors**.
- The catalog was already guarded well. Schema, provider contract, duplicate
  ids and slugs, unknown prerequisites, cycles, self-prerequisites, and path
  ordering were all enforced at load time and by tests. **No broken
  prerequisites, cycles, unknown skills, duplicate ids, invalid providers,
  invalid requirement types or missing setup files exist today.**
- The gaps were checks about the *repository*, not one document:
  - a missing seed script, starter file or workspace directory was found only
    when a student pressed Start Lab. The loaders run then, not at startup;
  - a lab directory whose definition was misnamed (`lab.yml`) was skipped with
    no error at all;
  - nothing checked directory/slug/id agreement, symlinks, stray files, or
    seeding collisions between `workspace_dir` and `setup.files`;
  - no single command validated everything, so CI caught catalog defects only
    as a failing test diff.
- **Added:** `validateCatalog` and `npm run validate:labs`, a static validator
  that runs in about 5 seconds and needs no Docker, cluster or database. It
  runs as a step in the `gates` CI job. It has 29 focused tests with
  one-defect fixtures, and each new rule was mutation-checked: disabling it
  makes a named test fail.
- **Added:** a verifier guard that no lab graded by reading the sandbox passes
  Verify on its untouched starter files (15 labs modelled; none pass).
- **Fixed:** one stray execute bit (`TF-026 setup/inventory.txt`), and stale
  numbers in `docs/learning-paths.md` (114 → 117 labs; NET-022/024/025 were
  missing from the stage table and totals).
- **Not fixed, documented:** one bypassable count check (LINUX-007), one
  partial image check (DOCKER-003), and two ordering concerns from yesterday's
  networking merges (NET-022 before the Docker stage; NET-025 marked advanced
  and placed ahead of beginner Kubernetes labs). The networking items are
  deferred to the networking branch.

## 2. Catalog architecture

How a lab reaches a student, as the code does it today:

```text
labs/<track>/<slug>/lab.yaml
  │  lab-definition.ts  parseLabDefinition
  │    zod schema (.strict everywhere), closed requirement vocabulary,
  │    provider ↔ requirement-family contract, provider ↔ setup contract,
  │    official-doc references, hint ladder, labels, duplicate skills,
  │    self/duplicate prerequisites, setup.verify required with setup
  ▼
lab-registry.ts  LabRegistry.load
  │    recursive discovery of files named exactly lab.yaml (sorted),
  │    duplicate id / slug refused, unknown prerequisite and cycles refused
  │    (fixed-point: a refusal can cascade), refusals kept in loadErrors
  ▼
catalog  GET /api/labs (toSummary: no requirements, setup or reset)
  ▼
learning-paths.ts  LearningPathCatalog.load(labs/learning-paths)
  │    skills.yaml + <path>.yaml; schema; validateLearningPath against the
  │    registry: unknown/duplicate lab, skills known and owned once, stage
  │    prerequisites earlier and acyclic, lab.yaml prerequisites placed
  │    earlier, core never depends on optional; refused paths → /health
  ▼
learning-progress.ts  computeLearningPathProgress (pure)
  │    stored verified progress + provider readiness + caller's sessions
  │    → stage status, skill status, next-lab recommendation
  ▼
session start  providers/*  (prerequisites advisory; prerequisitesEnforced=false)
  │    loadSetupManifests / loadSeedScripts / loadSetupFiles run HERE —
  │    the first point a missing or malformed asset was detected
  ▼
verifier  verifyLab → registry.ts → per-family readers (kubernetes, sandbox,
  │    docker, ansible, cicd); a closed handler per requirement type
  ▼
progress  services/progress lab_progress.status = COMPLETED only on a pass
```

## 3. Total labs

**117** `lab.yaml` files, **117** registered, 0 refused.

| Difficulty | Labs |
|---|---|
| beginner | 41 |
| intermediate | 67 |
| advanced | 9 |

| Level | Labs |
|---|---|
| practice | 102 |
| challenge | 15 |

Network mode: `none` 112, `link` 5.

## 4. Labs by provider

| Provider | Labs |
|---|---|
| linux | 48 |
| kubernetes | 21 |
| docker | 15 |
| terraform | 13 |
| ansible | 10 |
| cicd | 10 |
| aws | 0 |

| Track | Labs | Providers |
|---|---|---|
| linux | 17 | linux |
| kubernetes | 19 | kubernetes |
| docker | 14 | docker |
| terraform | 13 | terraform |
| cs | 13 | linux |
| aws | 11 | linux (simulated; the `aws` provider supports no requirement family) |
| ansible | 10 | ansible |
| cicd | 10 | cicd |
| networking | 10 | linux 7, kubernetes 2 (NET-024, NET-025), docker 1 (NET-022) |

## 5. Learning paths

One path, `devops-engineer`, the flagship (`FLAGSHIP_PATH_ID` in apps/web).

- Policy, from `docs/learning-paths.md` and `learning-paths.test.ts`: every
  catalog lab appears in the flagship path exactly once. Other paths may be
  partial. The validator enforces this for the flagship only
  (`LEARNING_PATH_COVERAGE`).
- 14 stages, 3 with no labs (Git, Helm & GitOps, Production Engineering).
- 117 labs placed, 94 core, 23 extra practice. **0 missing, 0 duplicates,
  0 invalid ids.**
- 113 skills in `skills.yaml`, all declared by exactly one stage. 84 are
  practised by at least one lab; 29 are curriculum gaps shown as Coming soon.
- Estimated minutes: core 3445, all 4355.

Structural observations. None of these breaks a rule; they are listed for
curriculum owners.

| Observation | Evidence |
|---|---|
| **NET-022 is a Docker-provider lab placed in Networking (stage 3), two stages before Containers & Docker (stage 5).** A student is asked to rerun a container with `docker run -p` before DOCKER-001. | `devops-engineer.yaml` networking stage; NET-022 `environment.provider: docker`; `prerequisites: []`. The curriculum names NET-021 as its prerequisite (`labs/networking/CURRICULUM.md`), and NET-021 is not built. |
| **NET-025 (advanced) comes fifth in Kubernetes, ahead of beginner K8S-004 and K8S-005.** | Difficulty from `lab.yaml`. The only lab prerequisite is NET-024, which is satisfied. |
| NET-024 has `prerequisites: []`; the curriculum names NET-023, which is not built. | `CURRICULUM.md` NET-024 entry. |
| Core difficulty is not monotonic in Docker (DOCKER-004 intermediate → DOCKER-007 beginner), CI/CD (CICD-004 → CICD-006) and AWS (AWS-005 advanced → six intermediates). | These follow each track's own prerequisite chains, for example AWS-018 requires AWS-004, so no change is justified by the docs. |
| Cross-track placements: K8S-017 → observability, LINUX-015 → devsecops (both documented), NET-024/NET-025 → kubernetes (now documented). | `docs/learning-paths.md` § The DevOps Engineer path. |

## 6. Prerequisite graph findings

Measured, not assumed:

| Check | Result |
|---|---|
| Unknown prerequisite | 0 |
| Self-referencing prerequisite | 0 |
| Duplicate prerequisite in one lab | 0 |
| Prerequisite cycle | 0 |
| Lab placed before its prerequisite in the path | 0 |
| Core lab depending on an optional lab | 0 |

All of these were already enforced before this audit: at parse time
(self/duplicate), at registry load (unknown, cycle, cascading refusal) and in
`validateLearningPath` (ordering, core/optional). The path message already
names both labs and the stage (`lab X is placed before its prerequisite Y — move
it after Y in stage '…'`). The validator surfaces all of them as `LAB_LOAD` and
`LEARNING_PATH` errors rather than reimplementing them. There is one graph
implementation, not two.

Labs with no prerequisites: ANSIBLE-001, AWS-001, CICD-001, CS-001, DOCKER-001,
K8S-001, LINUX-001, NET-002, TF-001 (track entry points), plus **NET-022 and
NET-024**, whose curriculum prerequisites do not exist yet (§14).

## 7. Skill taxonomy findings

There are two taxonomies, by design (`docs/learning-paths.md` § Skill model).

**Path skills (`labs/learning-paths/skills.yaml`): authoritative and enforced.**
113 skills, 0 duplicates, 0 unknown references, 0 defined-but-undeclared. Each
is owned by one stage and each domain maps to one stage (for example
`kubernetes.*` → kubernetes). The new `SKILL_UNDECLARED` warning catches a
skill added to `skills.yaml` but never given to a stage.

**Lab skills (`lab.yaml skills:`): free-form dotted ids, shown on lab pages.**
369 distinct ids. The schema enforces shape and no duplicates within one lab;
nothing defines a catalog of them. Findings:

| Finding | Detail |
|---|---|
| Domain prefix differs from track | `linux` track: 6 × `permissions.*` (LINUX-011; already listed under Known limitations in `docs/learning-paths.md`). `networking` track: `net.*` 37, `k8s.*` 8, `linux.*` 3, `container.*` 2, `devops.*` 1. |
| Same concept, two prefixes | Networking labs tag Kubernetes skills as `k8s.*`; the Kubernetes track uses `kubernetes.*`. |
| Near-duplicate ids (edit distance ≤ 2) | 4 pairs, all genuinely distinct concepts (`cs.os.exit-status`/`cs.os.wait-status`, `permissions.setuid`/`setgid`, `terraform.state.move`/`remove`, `kubernetes.jobs.create`/`pods.create`). No typos found. |

Not changed: lab skill ids are student-visible, and nothing in the repository
chooses between `k8s.` and `kubernetes.`. A rename is a taxonomy decision, not
a defect fix.

## 8. Setup-file findings

| Check | Result |
|---|---|
| Declared setup assets that fail to load through the provider loaders (manifests, seed scripts, `setup.files`, `workspace_dir`) | 0 across 117 labs |
| Path traversal / absolute setup paths | 0. The schema refuses `..`, absolute paths and backslashes, and the loaders re-check resolved paths. |
| Symlinks anywhere under `labs/` | 0 |
| `workspace_dir` ↔ `setup.files` destination collisions | 0 |
| Duplicate `setup.files` destinations | 0 (already a schema rule) |
| Files in a lab directory that `lab.yaml` never references | 0 |
| Directories under a track with no `lab.yaml` | 0 |
| Executable files other than seed scripts | **1: `labs/terraform/tf-026-local-backend/setup/inventory.txt` (git mode 100755). Fixed.** The bit was harmless, because starter files are written with execute bits cleared, but it was wrong. |
| Seeded files named like a solution (`solution`, `answer-key`, `teacher`, `instructor`, `walkthrough`) | 0 |
| Seeded `answers.txt` (NET-004, NET-008) | Reviewed by hand: blank worksheets (`label = `), not answers. Not flagged, by design. |
| CICD-010 seeds `.github/workflow/ci.yml` (singular) | Intentional: that is the injected fault; requirements check the plural path. |

**Starter state vs. verification.** Using the real verifier and an in-memory
sandbox holding exactly the seeded files, no statically modelled lab passes
Verify before the student does anything. The model covers labs with no seed
scripts and no manifests whose requirements only read the sandbox: TF-001–006,
-011, -012, -016–018, -025, -026, LINUX-001 and NET-002. Checks that pass at
start pass because the task is removing or leaving something alone (for
example TF-012 "report file is gone"), which is correct. Seed-script labs
cannot be modelled without running the script; their per-lab verifier suites
cover them. This is now a regression test
(`services/verifier/test/catalog-starter-state.test.ts`).

What the test proves, and for which labs. "No lab passes Verify on its
untouched starter files" is proven for **15 of 117 labs**: a lab is modelled
only if it has no seed scripts, no manifests, and every requirement belongs to
the `filesystem`, `terraform`, `iam` or `cloudformation` family. The other 102
are **not** covered by this test:

| Provider | Modelled | Excluded, and why |
|---|---|---|
| terraform | 13 (all) | none |
| linux | 2 (LINUX-001, NET-002) | 46: 45 have seed scripts (all 11 AWS, all 13 CS, LINUX-002–011 and LINUX-014–019, NET-003 and NET-005–008); NET-004 has no seed script but uses `linux`-family checks |
| docker | 0 | 15 (DOCKER-001–014, NET-022): `docker` family |
| kubernetes | 0 | 21 (K8S-001–019, NET-024, NET-025): `kubernetes` family, and 17 of them apply manifests |
| ansible | 0 | 10: `ansible` family |
| cicd | 0 | 10: `cicd` family |

So the `iam` and `cloudformation` families are allowed by the model but
exercise no lab today: every AWS lab has a seed script. The test's own coverage
guard pins only the Terraform labs; if LINUX-001 or NET-002 dropped out of the
model, nothing would fail.

### 8a. Security review of lab content

| Concern | Finding |
|---|---|
| Path traversal through setup paths | None. The schema refuses `..`, absolute paths and backslashes for manifests, seed scripts and `setup.files` sources/destinations; `workspace_dir` is one segment; the loaders re-check the *resolved* path against the lab directory; destinations are re-checked by `assertSafeSandboxPath`. |
| Symlinks | None under `labs/`. **Hardening added:** the loaders' resolved-path check is lexical (`path.resolve`), and `readFile` follows symlinks, so a symlink committed inside a lab directory could have pointed a starter file or manifest outside it. `expandWorkspaceDir` already skipped symlinks; `setup.files`, manifests and seed scripts did not. The validator now fails CI on any symlink in a lab directory (`LAB_SYMLINK`, regression-tested with a link to `/etc/passwd`). Lab content is repository-controlled, so this was never reachable by a student. |
| Solution or answer leakage | None found. No seeded file is named like a solution. The two seeded `answers.txt` files are blank worksheets. No statically modelled lab passes Verify on its starter files. The catalog projection still excludes requirements, setup and reset (existing test). |
| Unexpected executable content | 14 seed scripts carry git mode 100755; the other seed scripts are 100644 and are run by the provider regardless. Every seed script loads, with a `#!` line and under the size cap. One non-script file was executable (TF-026, fixed). Starter files are always written with execute bits cleared. |
| Secret-like material | No private keys, certificates or live-looking tokens. AWS-001 seeds credentials in AWS's documented example format (every key ends in `EXAMPLE` / `EXAMPLEKEY`) because the lab is about credential hygiene. CICD-008's `REGISTRY_PASSWORD = 'placeholder-do-not-ship-this'` is the lab's injected fault. K8S-005's `secret: payments-api` is an object name. |
| Unsafe absolute paths in requirements | Absolute sandbox paths are allowed on purpose (a Linux lab is about `/etc`, `/var/log`); `isSafeSandboxPath` refuses `~`, `..`, backslashes and shell metacharacters, and the runtime resolves the path inside the session's own container. Docker workspace paths must be relative. Nothing found outside these rules. |
| Verifier paths escaping the workspace | Not possible through the vocabulary: there is no regex, no command string and no path outside the sandbox rules above. Nothing new found. |

## 9. Verification findings

Categories use concrete criteria based on the requirement *types* a lab uses
(what the handler reads), not on judgement:

- **A. Behaviour**: at least one check that exercises the result (HTTP/TCP
  request, Service endpoints, `auth can-i`, running the student's script or an
  allow-listed command, build/test run, Ansible idempotency re-run, Job
  completion, container exit code / OOM / file read, neighbour table).
- **B. Live state**: no behaviour check, but at least one reads live state
  (Kubernetes objects, Docker containers/images/networks, processes, ports,
  accounts, Terraform state, managed-node files, file mode/owner).
- **C. Structured configuration**: only parses documents the student writes
  (IAM, CloudFormation, workflow and Jenkinsfile structure, YAML validity).
- **D. Filesystem content**: only file existence, absence and substring checks.

| Category | Labs | Ids |
|---|---|---|
| A. Behaviour | 53 | ANSIBLE-001, -002, -006–010; CICD-001, -003, -004, -006–010; CS-002–013; DOCKER-002, -004, -009, -011, -013, -014; K8S-003, -006, -008, -010, -012, -019; LINUX-005, -009, -010, -014, -015, -018, -019; NET-003, -004, -005, -007, -008, -024, -025 |
| B. Live state | 45 | ANSIBLE-003–005; DOCKER-001, -003, -005–008, -010, -012; K8S-001, -002, -004, -005, -007, -009, -011, -013–018; LINUX-002–004, -006, -011, -017; NET-006, NET-022; all 13 TF |
| C. Structured configuration | 11 | AWS-002–005, -007–009, -012, -018; CICD-002, CICD-005 |
| D. Filesystem content | 8 | AWS-001, AWS-006, CS-001, LINUX-001, LINUX-007, LINUX-008, LINUX-016, NET-002 |
| Unsupported / broken | 0 | The schema refuses unsupported types and provider-family mismatches at load. |

Notes on reading this table:

- D is not automatically weak. LINUX-001, -008 and -016 are file-operation
  labs, where the filesystem *is* the state being taught. AWS-001, AWS-006,
  CS-001 and NET-002 record findings in files; the first three have dedicated
  verifier suites with bypass tests (`aws-001-verification.test.ts`,
  `aws-006-verification.test.ts`, `cs-001-verification.test.ts`), and NET-002
  has `networking-requirements.test.ts`, including before-the-work and
  one-wrong-value tests. (The first version of this audit said NET-002 had no
  suite. That was wrong at `cb7804a` too.)
- C is expected for the AWS track: it is simulated (no credentials), and it
  grades IAM and CloudFormation documents semantically, not by substring.

**Specific weaknesses found (not changed; curriculum decisions):**

| Lab | Weakness | Why it was not changed |
|---|---|---|
| **LINUX-007** | `error-count.txt` is graded with `file_content contains: "17"`, so writing `1` through `99` (or `117`) passes the count check without counting. The task explicitly allows "extra surrounding text", and no hedging guard exists (compare NET-003/NET-008's "answered once, not hedged" `file_content_absent` checks). The other two answers (TXN id, archive path) still require finding the evidence. | Tightening it (`equals`, or absence guards) changes the lab's stated contract. No LINUX-007 verifier suite exists to anchor the change. |
| **DOCKER-003** | Two `docker_image_exists` checks confirm both names exist, not that `jumptotech/toolbox:1.0` points at the *same* image as `busybox:1.36`, which is the lesson. Tagging any other image with that name passes. | Needs a new requirement capability (image-id equality); that is a verifier/platform change, not catalog metadata. |
| K8S-006 | Any Job named `ledger-migration` that completes passes. | Intentional and stated in the task ("You choose the image and the command"). |

**Per-lab verification test coverage (heuristic).** 44 labs are not named, by
id or directory, in any `services/verifier/test` file: ANSIBLE-001–010,
CICD-001–009, DOCKER-002, -003, -005–008, -010, -011, K8S-011, K8S-012, NET-006,
NET-022, NET-024, NET-025, and all Terraform labs except TF-001 and TF-005.
Re-measured on `0f33b1f`: PR #34 added a DOCKER-004 case to
`docker-requirements.test.ts` (an unreadable workspace is reported as
`ENVIRONMENT_UNREACHABLE`), and NET-002 was listed here by mistake (46 → 44). Many of them
are exercised elsewhere: requirement-type suites with inline definitions,
`terraform-labs.test.ts`, `ansible-lab-config.test.ts`, and the gated runtime
integration suites. The heuristic finds missing *named* coverage, not
untested handlers.

## 10. Provider compatibility findings

Source of truth: `PROVIDER_REQUIREMENT_FAMILIES` and `checkProviderCapabilities`
in `lab-definition.ts`, applied to every lab at parse time.

| Provider | Families it can verify | Setup it can apply |
|---|---|---|
| kubernetes | kubernetes | manifests; `external_egress` capability |
| linux | filesystem, linux, iam, cloudformation | files, seed scripts, `workspace_dir`, `network: link`, `sandbox_capabilities`, `peer` |
| terraform | filesystem, terraform | files, seed scripts, `workspace_dir` |
| docker | docker | `setup.docker` |
| ansible | filesystem, ansible | files, seed scripts, `workspace_dir` |
| cicd | filesystem, cicd | files, seed scripts, `workspace_dir` |
| aws | none | none (no lab uses it; AWS labs run on `linux`) |

**Violations: 0.** Every requirement and `setup.verify` entry of all 117 labs
belongs to a family its provider verifies. Requirement families in use:
filesystem 360, kubernetes 129, linux 128, cloudformation 85, docker 84,
terraform 77, cicd 67, ansible 54, iam 38 (student-facing `requirements` only).

No new provider rule was needed; the existing one is complete for the current
vocabulary and is already tested in `lab-definition.test.ts` and
`lab-catalog.test.ts`.

## 11. Objective metadata findings

| Check | Result |
|---|---|
| Missing/empty title, task summary, task description | 0 (schema) |
| Duration missing, zero or negative | 0 (schema: positive integer ≤ 600) |
| Invalid difficulty or level | 0 (schema enums) |
| Missing skills | 0 (schema: 1–12) |
| Missing story | 0. Optional in the schema; every lab has one. Now a warning (`LAB_METADATA_INCOMPLETE`). |
| No objectives | 0. Every lab has 3–6. Now a warning. |
| No hints | 0. Every lab has 3 or 4. Now a warning. |
| Directory ≠ slug, slug not prefixed by id, track dir ≠ track | 0. Now an error (`LAB_LAYOUT`). |
| Mixed id prefixes within a track | 0. Now an error (`LAB_ID_PREFIX`). |

No duration or difficulty value was changed: none is objectively invalid.

## 12. Defects fixed

1. **TF-026 `setup/inventory.txt` was committed executable** (100644 now).
2. **`docs/learning-paths.md` was stale after NET-022/024/025 merged**: "114
   labs", Networking listed as NET-002–008, Kubernetes without NET-024/025, API
   example totals 114/91 and minutes 3330/4240. It now reads 117 / 94 /
   3445 / 4355, the stage table lists the new placements, and the cross-track
   list names them.
3. **Structural gaps closed by the validator and CI** (these are prevention,
   not repairs of current data): setup assets are checked at build time rather
   than at Start Lab; misnamed or missing lab definitions; directory/slug/id
   drift; symlinks; seeding collisions.

## 13. Defects intentionally not fixed

| Item | Reason |
|---|---|
| LINUX-007 count check bypassable by enumeration | Changes the lab's stated grading contract; needs an owner decision and a LINUX-007 verifier suite. |
| DOCKER-003 does not prove both tags name one image | Needs a new requirement type (platform change). |
| Lab-level skill prefix inconsistency (`permissions.*`, `k8s.*`, `net.*`) | Student-visible taxonomy; no repository evidence for a canonical form. |
| Non-monotonic difficulty inside Docker, CI/CD and AWS stages | Follows each track's prerequisite chain; docs say the path follows teaching order. |
| 44 labs without a named verifier suite | Test-authoring work, not a catalog defect. Listed in §9. |

## 14. Networking items deferred to the networking branch

Other agents are actively building networking capabilities and labs, so these
are recorded, not changed.

Re-checked on `0f33b1f`: main still has exactly ten networking labs (NET-002–008,
NET-022, NET-024, NET-025). NET-021, NET-023 and NET-028 are not on main; NET-023
and NET-028 exist only on unmerged branches. PR #34 touched no networking lab,
learning path or networking platform file. Every item below still applies as
written.

1. **NET-022 placement.** A Docker-provider lab sits in the Networking stage,
   before Containers & Docker (required prerequisite: Linux). Its curriculum
   prerequisite NET-021 is unbuilt. Options for the owner: move it into the
   Docker stage after DOCKER-012 (*Publish Ports*, same subject), or give
   Networking a recommended Docker prerequisite.
2. **NET-025 difficulty vs position.** Advanced, placed before beginner
   K8S-004/K8S-005.
3. **Missing curriculum prerequisites.** NET-022 → NET-021 and NET-024 →
   NET-023 are `[]` in `lab.yaml` because those labs do not exist. When they
   land, the prerequisites should be added, and the validator will then
   require their path placement to precede.
4. **Networking lab skill ids** mix `net.`, `k8s.`, `container.`, `devops.`,
   `linux.`.
5. NET-024 and NET-025 have no verifier suite named for them (NET-003–008 do).

## 15. Validator architecture

```text
scripts/validate-labs.ts                  CLI: --labs-dir, --json, --strict; exit 0/1/2
        │
        ▼
services/lab-orchestrator/src/catalog-validation.ts
  validateCatalog({ labsDir, registry, flagshipPathId? }) → CatalogValidationReport
        │  takes an already-loaded LabRegistry (so tests reuse the shared,
        │  frozen real-catalog fixture and never re-load labs/)
        ├─ LAB_LOAD                         registry.loadErrors (schema, provider
        │                                   contract, duplicate id/slug, unknown
        │                                   prerequisite, cycle) — reused, not reimplemented
        ├─ LAB_LAYOUT / LAB_ID_PREFIX /
        │  LAB_DIRECTORY_WITHOUT_DEFINITION  one lstat walk of labs/
        ├─ SETUP_ASSET /
        │  SETUP_DESTINATION_COLLISION      loadSetupManifests, loadSeedScripts,
        │                                   loadSetupFiles — the providers' own loaders
        ├─ LAB_SYMLINK (error), LAB_EXECUTABLE_FILE, LAB_UNREFERENCED_FILE,
        │  SETUP_SOLUTION_NAME, LAB_METADATA_INCOMPLETE (warnings)
        └─ LEARNING_PATH / LEARNING_PATH_COVERAGE (errors), SKILL_UNDECLARED (warning)
                                            LearningPathCatalog.load + validateLearningPath
```

Design rules:

- **Errors fail, warnings inform.** Only structural corruption is an error.
  Nothing subjective (difficulty order, skill naming, verification strength)
  is in the validator.
- **Deterministic.** Findings are sorted by severity, code, subject and message
  in code-point order; the machine's labs path is replaced with `labs`. Tests
  assert two runs are identical and that no absolute path appears.
- **No repair.** The validator reports and never rewrites.
- **Static.** No Docker, Kubernetes, network or database.

## 16. CI integration

`.github/workflows/quality-gates.yml`, job `gates`: a new step, **Lab catalog
validation** (`npm run validate:labs`), after Typecheck and before Test. No new
workflow or runner. It fails the job on any error and prints one line per
finding. `npm test` also asserts zero errors through `catalog-validation.test.ts`,
so the rule holds even where the step is skipped.

## 17. Commands

```sh
npm run validate:labs                     # human report; exit 1 on errors
npm run validate:labs -- --json           # structured report
npm run validate:labs -- --strict         # warnings fail too (local use)

npx vitest run test/catalog-validation.test.ts --root services/lab-orchestrator
npx vitest run test/catalog-starter-state.test.ts --root services/verifier
npx vitest run test/learning-paths.test.ts test/learning-progress.test.ts test/lab-catalog.test.ts --root services/lab-orchestrator
npm run typecheck
npm test
```

## 18. Test results

Recorded on this branch: macOS, Node 22.23.2, no Docker/cluster/database
(integration suites gated off, as in `npm test`). "Before" is the untouched
branch at `cb7804a`.

| Run | Before | After |
|---|---|---|
| `services/lab-orchestrator` vitest | 59 files passed, 21 skipped; 1260 tests passed, 253 skipped | 60 files passed, 21 skipped; 1289 tests passed, 253 skipped (+29 new) |
| `services/verifier` vitest | not run separately | 70 files; 1560 tests passed (includes the 2 new starter-state tests) |
| `npm run typecheck` (all workspaces) | — | pass |
| `scripts/validate-labs.ts` under `tsc --noEmit` (base config; no workspace config includes `scripts/`) | — | pass |
| `npm run validate:labs` | did not exist | 117 labs, 0 errors, 0 warnings (1 warning before the TF-026 fix) |
| `npm run test:composition` | — | 25 passed |
| `npm test` (all workspaces) | — | web 195, lab-orchestrator 1289, observability 696, progress 96, sandboxd 138, terminal 134, verifier 1560 passed; **api: 1 failed, 582 passed** |
| `apps/api` rerun alone | — | 36 files, 583 passed, 0 failed |

The one `npm test` failure was
`apps/api/test/oidc-ownership-e2e.test.ts › binds the terminal token to the
owner the server decided on`, with `Error: socket hang up`. It passed 3 of 3
runs in isolation and in a clean rerun of the whole `apps/api` suite.
**Classification: ENVIRONMENT.** It is a load-dependent HTTP flake while every
workspace suite runs at once on one laptop, in code this branch does not touch.
No change was made for it.

**Re-run after rebasing onto `0f33b1f`** (same machine, `npm ci` against the
updated lockfile, Node 22.23.2):

| Run | Result |
|---|---|
| `npm run validate:labs` | 117 labs, 0 errors, 0 warnings; `--json` output identical to `--json --strict`, no absolute paths; exit 0 |
| `npm run typecheck` (all workspaces) | pass |
| `npm test` (all workspaces) | api 583, web 195, lab-orchestrator 1289, observability 704, progress 96, sandboxd 138, terminal 152, verifier 1561 passed; **0 failed**, exit 0 |
| `npm run test:composition` | 25 passed |
| focused: `catalog-validation`, `learning-paths`, `learning-progress` (lab-orchestrator) | 73 passed |
| focused: `catalog-starter-state` (verifier) | 2 passed |
| focused: `learning-paths-api`, `progress-api`, `catalog-api` (api) | 80 passed |

The observability, terminal and verifier counts grew because of PR #34's own
tests, not this branch. The `oidc-ownership-e2e` flake did not happen on this run.

Skipped suites are the gated runtime integration suites
(`RUN_INTEGRATION_TESTS`, `RUN_DOCKER_INTEGRATION_TESTS`, `RUN_DB_TESTS`),
unchanged by this work.

## 19. Remaining risks

- **Verification strength is not validated.** A lab can be structurally
  perfect and still pass on a guess (LINUX-007). The starter-state guard covers
  only 15 statically modelled labs.
- **Seed-script effects are unmodelled.** A seed script that pre-creates the
  answer would not be caught statically.
- **Solution-leak detection is name-based.** A starter file containing a
  finished configuration under an innocent name is caught only when its lab is
  in the starter-state model.
- **Lab-level skills have no catalog.** A typo there is invisible to every
  check.
- **Ordering quality is not enforced** beyond prerequisites (NET-022, NET-025).
- **Executable-bit check depends on the checkout honouring file modes**
  (`core.fileMode`). It is a warning for that reason.

## 20. Recommended next work

1. **Networking owner:** decide NET-022's stage and NET-025's position, and add
   NET-021/NET-023 prerequisites when those labs land (§14).
2. **LINUX-007:** add a verifier suite with bypass tests, then tighten the
   count check (`equals`, or "answered once" absence guards as in NET-008).
3. **Image identity requirement** (for example `docker_image_same_as`) so
   DOCKER-003 grades the lesson it teaches.
4. **Extend the starter-state guard** to Ansible and CI/CD labs using their
   fake readers, and to seed-script labs by running seeds in the sandbox
   integration suite.
5. **Lab-skill taxonomy decision:** choose canonical domain prefixes (`k8s.` vs
   `kubernetes.`, `net.`, `permissions.`) and add a warning-level validator
   rule once decided.
