# Lab quality and student experience certification — 2026-09-27

A pass over the lab product students learn from: provisioning, starting state,
verification, reset, golden paths and curriculum order. It ran in parallel with
the security, launch-readiness, capacity and DR passes, and did not repeat
their work.

The strongest evidence here comes from CI runners, not this host. This host's
Docker daemon was shared with several other agents' stacks (load average
20–77), so its runtime timings are INCONCLUSIVE. It also produced false
environment failures:
- 60 s network-create timeouts and 30 s setup timeouts;
- image checks that timed out and read as "not built";
- dind certificate reads that failed.

Every runtime claim below cites a clean CI runner unless it says otherwise.

## 1. Commits

| | |
|---|---|
| Base | `92c0aaf` (origin/main at the start of the pass) |
| Final main | `eed2805` when this was written (the last lab PR, #107), plus the merge of the PR that adds this file |

## 2. Inventory

117 labs, all registered, all placed exactly once in the `devops-engineer`
path. `npm run validate:labs` reports 117 labs, 0 errors and 0 warnings, both
before and after this pass. Difficulty: 41 beginner, 67 intermediate, 9
advanced.

| Track | Labs | Provider(s) |
|---|---|---|
| Foundations (CS) | 13 | linux |
| Linux | 17 | linux |
| Networking | 10 | linux 7, kubernetes 2, docker 1 |
| Docker | 14 | docker (per-session docker:27-dind) |
| CI/CD | 10 | cicd |
| AWS (simulated, no cloud, no credentials) | 11 | linux |
| Terraform | 13 | terraform (offline provider mirror) |
| Kubernetes | 19 | kubernetes (kind) |
| Ansible | 10 | ansible (control node + 2 managed nodes) |

By provider: linux 48, kubernetes 21, docker 15, terraform 13, ansible 10,
cicd 10. There is no Git, SRE or other track; the path's later stages reuse
these labs or show "Coming soon".

## 3. What was built: every lab, certified on a real runtime

Before this pass, real-runtime coverage was thin:
- LINUX-001, LINUX-003 and TF-001 in `sandbox-integration`;
- NET-004 to NET-008 in their `net00N` suites;
- DOCKER-009 to DOCKER-014 plus the core Docker suite;
- about eight Kubernetes labs.

No Ansible or CI/CD lab was ever started as a lab, and roughly 90 labs had only
ever been graded against fakes.

Three catalog sweeps now run in CI on every PR. Each takes every lab of its
providers from disk, so a new lab joins automatically. Each lab goes through:

1. **Start** succeeds. Seeds, workspace files and fixtures land, and setup
   verification holds.
2. **Check** before any work does **not** pass. Kubernetes and Docker grades
   are read once they have settled.
3. For labs with a known solution: **solve** the lab as the student, and
   **every** check passes.
4. **Reset**, then the grades equal the starting grades, label for label,
   whether or not the lab was solved.
5. **End Lab** removes every container, peer, managed node, network, volume or
   namespace that belonged to the session.

| Sweep | File | CI job | Labs | Solved to PASS in the sweep |
|---|---|---|---|---|
| Linux, Terraform, Ansible, CI/CD | `apps/api/test/catalog-runtime-integration.test.ts` | `catalog-runtime` (new, #93) | 81 | 76 (NET-004–008 are solved in their `net00N` suites) |
| Docker | `services/lab-orchestrator/test/docker-catalog-sweep-integration.test.ts` | `docker-integration` (#99) | 15 | 8: DOCKER-002–008, NET-022 (#109, #111); 001 and 009–014 in their own suites |
| Kubernetes | `services/lab-orchestrator/test/k8s-catalog-sweep-integration.test.ts` | `kind-integration` (#95) | 21 | 21 (#107) |

How each sweep runs:
- **Container sweep:** assembles the api from the production
  `buildSandboxComposition`. Five labs run at once, each as a different
  student, under the beta's capacity policy (5 live sessions, 1 per student).
- **Linux-family solutions:** run through `bash --norc --noprofile` as the
  student, the shell the browser terminal gives.
- **Kubernetes solutions:** run with the session's own namespace-scoped
  kubeconfig.
- **Docker solutions:** run through the sandbox's own daemon.

All solutions live in test code only; nothing is served to students.

**Result: all 117 labs** start, begin unsolved, reset to their exact starting
grades and clean up on a clean runtime, and **all 117** are solved end to end
on their real runtime by some suite.

## 4. Test coverage and results

**CI, clean runners:**

| Run | Result |
|---|---|
| `catalog-runtime`, #93 first run | 81/81: started, unsolved at start, reset to identical grades, ended; 183 s total |
| `catalog-runtime`, #93 with the widened End check | 81/81: no peer, managed node or network left behind |
| `catalog-runtime`, #104 (head 1dbe476) | 81/81, 71 solved to every check green, then reset |
| `catalog-runtime`, #103 | AWS-001 solved after its fix |
| `catalog-runtime`, #108 | LINUX-001/002/003 and TF-001 solved |
| `docker-integration`, #99 | Docker sweep 15/15; per-lab suites 009–014 pass |
| `docker-integration`, #109 | DOCKER-002/003/005/007 and NET-022 solved; DOCKER-003's Reset removes both image names on a real daemon |
| `kind-integration`, #95 | Kubernetes sweep 21/21, plus the existing kind suites |
| `kind-integration`, #107, before #110 | 18/21 solved. K8S-003, NET-024 and NET-025 failed only their `service_http` checks, which led to #110 |
| `kind-integration`, #107 with #110 | **21/21 Kubernetes labs solved to every check green**, then reset, on real kind |
| `docker-integration`, #111 | DOCKER-004/006/008 solved (workspace build, user-defined network, Compose stack) |

Every merged PR had all 14 checks green: gates, CodeQL (2), postgres, kind,
sandbox, catalog-runtime, networking, docker, terminal, sandboxd, tls-edge,
browser-e2e.

**Local, this host (hermetic):**
- `npm run validate:labs`: 117/0/0.
- Verifier: 1953 → 2037 tests, all passing.
- Lab-orchestrator: 1443 → 1485 passed, 295 integration-gated skips.
- Api: 783 passed, 97 skipped. Web: 274.
- Observability contracts: 1020.
- Two runs each had one unrelated flake under load, and were green on rerun.

**Local runtime:**
- DOCKER-012 real dind: 10/10.
- DOCKER-009 and DOCKER-010: 13/13 each. DOCKER-014: 7/7.
- LINUX-004 golden path on real `lab-linux`.
- ANSIBLE-001 provider `create`: all 8 steps OK.
- ClusterIP reachability from the `kind` network (see §5).
- DOCKER-013 local: environment failures only; CI passes.

**Not run:**
- No real AWS: by design, the track is simulated.
- No kind on this host: its default kubeconfig holds real EKS contexts, and its
  kind clusters are unreliable. CI kind is the evidence.
- Browser session-restart flows are owned by the browser-E2E suites, which
  pass in CI; this pass drove no browser.

## 5. Defects found and fixed

Found by this pass on a real runtime:

| Lab | Sev. | Defect | Evidence | PR |
|---|---|---|---|---|
| **LINUX-004** | **P1** (beginner) | Uncompletable as written. The seed started the job as root, so the student's `kill` got "Operation not permitted", and nothing in the task mentions sudo. | Real `lab-linux`: main exit 1 "Operation not permitted"; fixed exit 0, reaped by runsvdir in about 4 s; golden path passes in CI | #81 |
| **AWS-001** | **P1** (track entry) | A complete findings sheet failed "Every finding has been filled in", because the seeded header comment `# Replace every FILL_ME below` matched. The unit fixture had dropped the comment. | Found by solving on the real image; the new test fails on main | #103 |
| **K8S-003, NET-024, NET-025** | **P1** | `service_http` dials the Service's ClusterIP from the api, which has no route to the Service CIDR. So "The Service answers requests on its stable cluster address" and both NET labs' HTTP checks could never pass on the platform. | kind golden paths: every other check green; from a container on the `kind` network, `10.96.0.1:443` times out while the node's `:6443` answers | #110 |
| DOCKER-012 integration | test | The count was pinned at 6 checks after #73 added a 7th. CI's per-lab loop stops at the first failure, so later suites never ran on that PR. | CI | #73 |

Ported from the lab product audit (2026-09-21/22, branch
`feat/overnight-lab-product-audit`), which never reached main. It landed as one
PR per track on current main, and every PR merged with full CI:

| Lab(s) | Sev. | Defect | PR |
|---|---|---|---|
| NET-006/007 | P1 | A bind to the host's own segment address, reachable and narrower, was rejected | #65 |
| NET-025 | P1 | Moving the app to the broken targetPort passed | #65 |
| AWS-002/003/005 | P1 | IAM checks with no request context ignored Conditions: valid TLS-Deny policies failed, and never-firing Denies "protected" Allows | #68 |
| K8S-012/005/018/011 | P1/P2 | RBAC over-grant, secret in the sidecar and 1/3-ready DaemonSet all passed; `/data/` was rejected | #70 |
| DOCKER-003 | P1 | Reset left a student's second image tag, so the retry started half solved | #73 |
| DOCKER-008/013/006/012 | P1 | Compose never proven; the build-cache lab passable with `FROM` 1.0; `sleep` keep-alives passed | #73 |
| DOCKER-009 | P2 | Failure detail printed the worksheet exit code | #73 |
| TF-003 | P1 (disclosure) | Failure detail could print the deploy token | #76 |
| TF-025 | P2 | `condition = true` passed | #76 |
| ANSIBLE-004/005 | P1 | Values only in comments passed; hard-coding node1 via `in [...]` passed | #77 |
| CICD-003/007/008/009/010 | P1 | `if: false` jobs and steps counted; the password moved elsewhere passed; `branches: [main, '**']` passed | #78 |
| LINUX-017, CS-002 | P1 | Valid unit Descriptions and a trailing-slash WorkingDirectory were rejected; `--to=iec-i` refused without the task saying so | #81 |
| AWS-007/012, AWS-012, K8S-019 | P2 | Track page listed labs before their prerequisite; missing prerequisites. New `LAB_TRACK_ORDER` rule | #67 |
| NET-004, NET-003, NET-008, CS/networking docs | P2 | Instruction contradictions; a graded key used as the format example; unnamed answer sheet; stale "not implemented" text | #67, #94 |

**New catalog guards:**
- `LAB_TRACK_ORDER` (#67).
- `UNROUTABLE_SERVICE_PROBE` (#110): no lab may grade by dialing a ClusterIP
  from the api.

## 6. Track status (clean CI runtime)

| Track | Start | Unsolved at start | Golden path | Reset | Cleanup | Verdict |
|---|---|---|---|---|---|---|
| CS (13) | PASS | PASS | PASS 13/13 | PASS | PASS | certified |
| Linux (17) | PASS | PASS | PASS 17/17 | PASS | PASS | certified |
| AWS (11) | PASS | PASS | PASS 11/11 | PASS | PASS | certified (simulated) |
| Networking (10) | PASS | PASS | NET-002/003 sweep; 004–008 `net00N`; 022 #109; 024/025 #107 | PASS | PASS | certified |
| Terraform (13) | PASS | PASS | PASS 13/13 | PASS | PASS | certified |
| Ansible (10) | PASS | PASS | PASS 10/10 | PASS | PASS | certified |
| CI/CD (10) | PASS | PASS | PASS 10/10 | PASS | PASS | certified |
| Docker (14) | PASS | PASS | 001 core suite; 002/003/005/007 #109; 004/006/008 #111; 009–014 own suites | PASS | PASS | certified |
| Kubernetes (19) | PASS | PASS | 19/19 (#107, with #110) | PASS | PASS | certified |

## 7. Verifier, provisioning, reset, terminal

- **Verifier.** A task-following solution passes on the real runtime for every
  lab. Solving on real runtimes found three false negatives: AWS-001, and the
  `service_http` trio. The audit ports fix the false positives and false
  negatives listed in §5. No failure message found in this pass reveals a
  hidden answer: images, types, replicas and ports echoed in details are all
  stated in the tasks.
- **Provisioning.** Every lab of every provider starts on a clean runner.
  - **Kubernetes timing:** K8S-015 accepts its fixture at 3 of 4 replicas, and
    K8S-019 accepts its Deployment before its Pods are Ready. So a student's
    very first Check can show a readiness line failing that turns green
    seconds later. This is harmless, since the lab isn't passed either way.
  - **Host load:** on this overloaded host, Start could fail at 30 s (initial
    state) or 60 s (network create). That is a host-capacity finding for the
    capacity pass, not a lab defect.
- **Reset.** Every lab resets to its exact starting grades, including after a
  full solve. DOCKER-003's image-tag leak is fixed (#73), and #109 proves it on
  a real daemon.
- **Terminal and binaries.**
  - Every command named in a task or hint exists in its image as the student,
    or the lab says explicitly that it does not: `jq` (AWS-006), `strace`
    (CS-012) and `systemctl` (LINUX-005/017) are deliberately absent and stated
    as such. `ifconfig` is mentioned only as deprecated.
  - The student shell is `bash --norc --noprofile` as uid 1001. An explicit
    `source ~/.bashrc` works in the interactive terminal; the image's
    `.bashrc` returns early only in non-interactive shells.

## 8. Learning paths

`validateCatalog` and `learning-paths.test.ts` enforce:
- every lab placed once;
- prerequisite ids valid;
- labs after their prerequisites in the path;
- since #67, a track page never lists a lab before a same-track prerequisite.

No dead ends, cycles or unreachable labs were found. Subjective suggestions,
not defects:
- CS-001 hints use shell tools before LINUX-001 teaches them.
- Core CS labs need Python before the optional programming labs.
- NET-022 (Docker) sits in the Networking stage before any Docker lab.
- AWS-006 requires AWS-005 but uses nothing from it.

## 9. Five-student functional status

The container sweep runs five students at once on five different labs, under
`MAX_ACTIVE_SESSIONS=5` and one session per student. Each session:
- starts, checks, is solved, resets and ends independently;
- is graded from its own sandbox;
- gets its slot back on End, since the next Start would otherwise be refused.

This held for 81 labs on every run. The Kubernetes and Docker sweeps run
sequentially. Adversarial isolation belongs to the security pass.

## 10. Remaining items

**P0:** none found.

**P1:** none known.

**P2 / known:**
- NET-004 "The off-segment destination never reached the neighbour stage"
  passes at start and cannot fail. It is corroboration only; the lab fails
  until real work is done.
- K8S-013/015/016/017 prove "a new revision", not that the object was never
  replaced (their labels say so since #70).
- K8S-003/NET-024/NET-025 no longer send a real request through the Service.
  They grade what makes one work: selector, port mapping, ready endpoints and a
  cluster IP. A real request needs an in-namespace probe; see §11.
- LINUX-010 refuses `PORT=9105  # comment`. The task never invites a comment.
- Under host starvation, End can leave NET-007's peer and network for the
  reaper to collect about 2 minutes later: a teardown inspect error returns
  silently (perf pass). On a clean runner End removes everything; #93 checks it.
- Docker and Ansible Reset keep student-authored files the lab did not seed
  (terminal-service contract). No grade depends on them.

## 11. Before public release

- If the curriculum wants "the Service answers a request" graded directly:
  build an in-namespace HTTP probe (a short-lived Pod in the student's
  namespace), reviewed by security. Two alternatives are ruled out:
  - an api route into the Service CIDR (SEC-RT-7);
  - the API-server Service proxy: students can write core `endpoints`, so a
    selectorless Service could aim it anywhere.
- An object-identity check for the "updated, not replaced" Kubernetes labs, if
  that claim matters.
- End-Lab teardown should not return silently on a failed peer inspect
  (reliability owner).
- The curriculum-order suggestions in §8 are product decisions.

## 12. PRs

| PR | What | State |
|---|---|---|
| #65 | networking grading (NET-006/007/025) | merged |
| #67 | curriculum order, prerequisites, `LAB_TRACK_ORDER` | merged |
| #68 | AWS IAM grading | merged |
| #70 | Kubernetes grading | merged |
| #73 | Docker grading and reset | merged |
| #76 | Terraform grading, TF-003 disclosure | merged |
| #77 | Ansible grading | merged |
| #78 | CI/CD grading | merged |
| #81 | LINUX-004 blocker, LINUX-017, CS-002 | merged |
| #93 | container catalog runtime sweep + `catalog-runtime` job | merged |
| #94 | NET-003/NET-008 worksheet text | merged |
| #95 | Kubernetes catalog sweep | merged |
| #99 | Docker catalog sweep | merged |
| #103 | AWS-001 FILL_ME blocker | merged |
| #104 | 68 golden paths | merged |
| #108 | LINUX-001/002/003, TF-001 golden paths | merged |
| #109 | Docker golden paths (002/003/005/007, NET-022) | merged |
| #110 | K8S-003/NET-024/NET-025 unroutable `service_http` | merged |
| #107 | Kubernetes golden paths (21) | merged |
| #111 | Docker golden paths (004/006/008) | merged |

## 13. Private-beta student experience

**GO for the lab product**, conditional on the operator steps below.

Every lab of every provider starts, begins unsolved, resets to its start and
cleans up on a clean runtime. Every lab is solved end to end on its real
runtime by some suite. The blockers found (LINUX-004, AWS-001 and the
`service_http` trio) are fixed.

Operator steps:
1. Rebuild the sandbox images on the beta host (`npm run sandbox:build`) so
   they match main.
2. Restart the api so the catalog reloads.
3. Size the host so provisioning stays inside its 30 s and 60 s deadlines.
   This pass saw them missed only on a starved host; see the capacity
   certification.
