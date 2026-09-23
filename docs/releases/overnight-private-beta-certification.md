# Overnight private-beta certification — 2026-09-21

| | |
|---|---|
| **Branch** | `feat/overnight-beta-certification` — committed locally, not pushed, not merged, no PR |
| **Starting commit** | `24e09f132d522b8de713e696bd0a682f3be74d93` (`origin/main`, PR #54). Verified before any edit: clean tree; `HEAD`, `origin/main` and `merge-base` all equal this SHA |
| **Final commit** | the commit that adds this report. The last change before it is `81c3d5f` |
| **Audit date** | 2026-09-21 (one overnight session) |
| **Changed** | 32 files, +1123 / −68, in 11 fix/test commits, plus this report |
| **Machine** | one macOS laptop (10 CPUs). The Docker VM (8 GiB) also ran five kind clusters and seven DinD probes belonging to other worktrees (§12). Load average reached 98–107. |

**Evidence words used below.**

- **FIXED + PROVEN**: a regression test in this branch fails against the code before the fix, for the stated reason, and passes after it. Every such run was done during this session.
- **PROVEN**: observed during this session by a test, a measurement or a command whose output is quoted.
- **REVIEWED**: code was read and no defect was found. This is not proof.
- **CI REQUIRED**, **REAL-HOST REQUIRED**, **OPERATOR DECISION REQUIRED**: this session cannot produce the evidence.

---

## 1. Scope and method

Everything in the brief's phases 1–15 was covered, weighted toward what a real five-student beta would hit. Four read-only investigators audited separate areas in parallel:

1. terminal and sandboxd;
2. api lifecycle and isolation;
3. verifier and runtime;
4. CI, production configuration and scripts.

Each candidate they reported was reproduced again here before anything was changed. A candidate that could not be reproduced was not fixed; it is listed as suspected. Earlier reports' known residuals were not re-reported unless the evidence showed them to be worse than stated:

- `overnight-scale-resilience-report.md` §11;
- `overnight-final-hardening-report.md` §8.

Classification: **CODE DEFECT**, **TEST COVERAGE GAP**, **DOCUMENTATION/RUNBOOK GAP**, **REAL-HOST VALIDATION REQUIRED**, **EXTERNAL OPERATOR/INFRASTRUCTURE DECISION**.

## 2. Baseline (before any change)

| Item | Result |
|---|---|
| node / npm | v22.23.2 / 10.9.8 (`engines` `>=22 <25`, `.nvmrc` 22) |
| git | clean; `HEAD` = `origin/main` = merge-base = `24e09f1` |
| `npm ci` | exit 0, lockfile unchanged |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `npm test` | exit 0: **5576 passed, 336 skipped, 0 failed** (api 693/15, web 265/0, orchestrator 1390/253, observability 944/38, progress 96/1, sandboxd 161/7, terminal 195/22, verifier 1832/0). The skipped tests are integration suites gated on infrastructure. |
| `make test-db` (private PostgreSQL 16, port 55481) | exit 0: progress 117 passed / 3 skipped (the host-execution-guard self-tests), session store 181, api persistence 20 |
| Docker | the daemon was **not running** at the start. Started for the Docker-backed suites (§12). |

## 3. Defects found and fixed

Every row is **FIXED + PROVEN**. The regression test in each row failed before its fix, for the stated reason, and passes after it. In several rows the test also checks that ordinary behaviour did not change (for example, a genuinely missing file still reads as absent).

| # | Severity | Class | Defect | Commit |
|---|---|---|---|---|
| D1 | **High** | CODE DEFECT, capacity | Pressing End while a lab was still being created released its capacity slot while the build carried on | `222a22a` |
| D2 | Medium-High | CODE DEFECT, capacity/leak | Docker daemon down or timing out was read as "sandbox already gone", so End released the slot with the container still running | `cb5e734` |
| D3 | Medium | CODE DEFECT, capacity/leak | A session whose lab left the catalog could never be torn down | `4f6c42b` |
| D4 | Medium | CODE DEFECT, resource | A terminal socket paused by input pressure never noticed its client leaving | `d57c9c0` |
| D5 | Medium | CODE DEFECT, resource | The per-session terminal attach queue was unbounded and had no timer | `2bfd03e` |
| D6 | Medium | CODE DEFECT, grading | An unreadable container sandbox produced "absent" verdicts (false passes) or HTTP 500 | `467c4ae` |
| D7 | Medium | CODE DEFECT, grading | An unreachable Ansible managed node read as "absent" or "stopped" (false passes) | `0d5d36a` |
| D8 | Low-Medium | CODE DEFECT, UX/recovery | A sandboxd restart was reported to students as their shell exiting, and nothing reconnected | `efa7777` |
| D9 | Low-Medium | CODE DEFECT, availability | A student's workflow YAML with an alias bomb made every Check of that lab return 500 | `a1b7a01` |
| D10 | Low-Medium | CODE DEFECT, grading integrity | A Terraform file padded past the 64 KiB read cap passed a "must not contain" check | `e17ffd9` |
| D11 | Medium | TEST COVERAGE GAP | The strict CI runner ignored a named test file that did not exist | `81c3d5f` |

### D1: End during CREATING released the slot while the sandbox kept being built

- **Invariant.** The number of sandboxes never exceeds `MAX_ACTIVE_SESSIONS`, and one student holds at most `MAX_ACTIVE_SESSIONS_PER_STUDENT`.
- **Evidence (investigator repro, through the real Express app).**
  - Setup: per-student limit 1, global limit 5.
  - One student looped Start (not awaited) → `GET /api/sessions` → End.
  - Result: 12 provisions were in flight for that one student, with 0 occupying rows; peak 12 sandboxes at once.
  - With a global limit of 1, a second student was admitted while the first student's sandbox was still being built.
- **Root cause.** A teardown could claim a `CREATING` row. Its destroy found nothing yet to remove, so it recorded `ENDED`, which is not an occupying status. `provider.create` kept running; the start discarded its sandbox only once the build had finished.
- **Fix.** Student End and operator End now only *mark* a `CREATING` session (`ENDING`/`EXPIRING`), and the row keeps occupying its slot.
  - The start that owns the build discards it, then finishes that teardown with the teardown's own reason. This happens on both the success path and the failed-provision path.
  - If the starting process died, the reaper's existing abandoned-End recovery (5 min) finishes it.
  - The reaper's own expiry of an abandoned `CREATING` row does not defer, because it acts only once that start is presumed dead.
- **Tests.** `session-per-student-capacity.test.ts` and `session-recovery.test.ts`:
  - two old tests pinned "End during provisioning frees the slot"; they now pin the corrected invariant and fail on the base (`expected 'ENDED' to be 'ENDING'`);
  - new cases cover the global ceiling and an End that waited on a start whose process then died;
  - both files also run on PostgreSQL through `session-store-integration` (187 passed, §9).
- **Visible change.** An End during CREATING now answers the existing 503 "Your lab is still shutting down… cleanup keeps retrying" instead of 200, until the build is discarded.

### D2: a Docker daemon that did not answer read as a sandbox already gone

- **Invariant.** A failed read is not evidence that the sandbox is absent.
- **Evidence (measured on the Docker 28.4.0 CLI).** `docker inspect` of a missing container and `docker inspect` with the daemon unreachable **both exit 1**; only the stderr text differs. A timed-out inspect exits 124.
- **Root cause.** `DockerCliRuntime.inspect` returned `null` ("absent") for every non-zero exit. During an outage:
  - End's destroy recorded "already absent", went `ENDED` and released the slot;
  - the container, its peer and its network kept running until the orphan sweep;
  - Reset's purge skipped the removal;
  - `status` read `not_created`.

  sandboxd's runtime routes use the same method, so production (through the broker) was affected too. The sandboxd attach inspector had already been fixed this way (D-20 of an earlier pass); this runtime had not.
- **Fix.** `inspect` returns `null` only for "No such container/object". Every other failure throws `ContainerRuntimeError`, which every caller already treats as a failure: teardown stays `ENDING`/`EXPIRING` for the reaper. The verification step after `docker rm` no longer counts an unconfirmed inspect as "gone".
- **Test.** `container-runtime-boundary.test.ts`, "absent is not unreachable": the daemon-down and timeout cases resolved `null` on the base.

### D3: a session whose lab left the catalog could not be torn down

- **Invariant.** Every occupying row is eventually released.
- **Evidence (investigator repro).**
  - Three reaper sweeps, an operator End and a student End all failed with `Lab LINUX-001 not found`.
  - The row stayed `EXPIRING`, and the sandbox stayed.
  - The student's next Start was refused with `STUDENT_SESSION_LIMIT_REACHED`.
- **Root cause.** Teardown built its provider context through the registry. Session rows are durable; a deploy that removes or renames a lab, or ships its `lab.yaml` invalid (load errors are only warnings at boot), left every running session of it permanently undestroyable.
- **Fix.** `destroy` now takes `SessionTeardownContext`, which is the provider context without `lab`, and the compiler holds all four providers and the test harness to that contract. The manager builds the teardown context from the stored row alone, for End, expiry and reclaim.
- **Test.** `session-recovery.test.ts`, "ends, expires and reclaims a session whose lab left the catalog". On the base it stayed `ENDING`. It also runs on PostgreSQL.
- **Residual.** While the lab is missing, `GET /api/sessions/:id`, Check, Reset and the terminal credential fetch still answer 500 for that session. It can now be ended and reaped, which releases its slot.

### D4: a paused terminal socket never noticed its client leaving

This was the brief's specific Phase-3 question.

- **Invariant.** Resources for a client that has gone are released within seconds, not when an idle timer fires.
- **Root cause.** Input flow control pauses the socket that input arrives on while the shell is not reading. A paused socket is not read at all, and a peer's close is only learned by reading it. So a browser that closed mid-flood went unnoticed:
  - by the terminal (session, capacity slot, broker socket);
  - one hop on, by sandboxd (PTY, `docker exec`);

  until the next output, a replacing attach, or the **30-minute** idle timer.
- **Fix. The flow control itself is unchanged.**
  - `pausableSocket()`, used by both relays for input: while the socket is paused, it pings the peer every 2 s. A write to a peer that has gone fails, and closes the socket through its ordinary close path. A peer that is still there just queues pongs; nothing it sent is consumed.
  - The broker client's close timeout is 2 s instead of ws's 30 s default, so sandboxd's own probe sees the close.
- **Test.** `input-backpressure.test.ts`, "releases the shell at both hops…", on the real three-hop stack:
  - on the base, the terminal still held the shell after 10 s;
  - without the close timeout, the PTY assertion failed at 24 s;
  - measured after the fix: terminal ≈ 3.5 s, broker PTY ≈ 9.5 s.
  - Unit cases for the probe's lifecycle are in `output-flow.test.ts`.

### D5: the per-session attach queue was unbounded and had no timer

- **Invariant.** One student's sockets cannot drive unbounded backend work, or hold connections without a bound.
- **Evidence (investigator repro).**
  - 60 sockets opened with one valid token produced 60 credential mints (Kubernetes TokenRequest or Docker certificate reads) and 60 PTY spawns, one after another.
  - 31 sockets were still open at 12 s, against `maxSessions` 2.
  - A Reset's reattach queued behind them answered after 12.4 s; the api allows 20 s.
- **Root cause.** The auth grace timer is cleared once a token verifies. Capacity counts only registered shells. Every queued socket that was still open at its turn ran a full attach, only to be replaced by the next one.
- **Fix.** The newest attach always wins, so an attach still waiting when a newer one arrives is closed at once with `4410 SESSION_ENDED`, as a superseded attach already was, and skipped at its turn. A session now has at most one attach running and one waiting.
- **Test.** `broker-attach.test.ts`, "keeps only the newest attach waiting…". On the base the 20 replaced sockets stayed open and the test timed out. Now they close before the running attach moves, with 2 credential calls and 2 PTYs in total.

### D6: an unreadable container sandbox gave false verdicts or HTTP 500

- **Invariant.** A read that failed is not evidence of absence, and an environment fault is reported as one.
- **Evidence (measured on Docker 28.4.0).** Each of these exits 1: `stat` of a missing file; `docker exec` into a stopped container; `docker exec` into a removed container.
- **Root causes.**
  1. The provider's `stat`/`cat`/`find` reads treated every non-zero exit as "not there". During an outage, `path_absent` (used by 12 labs) **passed**, `file_exists` blamed the student, and the Check was recorded as an ordinary verdict.
  2. The process, socket and neighbour reads already threw `SandboxUnreachableError`, but `verifyLab` did not classify that error. It surfaced as **HTTP 500**, and the verification-error metric never moved.
- **Fix.**
  - `execDidNotRun()` recognises the daemon's refusal (the whole of the CLI's stderr) or a timeout.
  - Those reads now throw, `SandboxReader` maps the error to `SandboxUnreachableError`, and `verifyLab` reports `ENVIRONMENT_UNREACHABLE` with every check skipped.
- **Test.** `sandbox-unreadable.test.ts`: 8 of 9 cases fail on the base; the genuinely-missing-file control passes on both. `bind-address` and `neighbour-state` had pinned the throw (the 500); they now pin the reported error.

### D7: an unreachable Ansible node read as "absent" or "stopped"

- **Evidence.** With both managed nodes removed:
  - `managed_file_exists state: absent` (ANSIBLE-005 `scheduler.lock`) **passed**;
  - `managed_service_state expected: stopped` **passed** "on node1, node2";
  - the present-file check blamed the student.
- **Fix.** The platform's own node reads (`stat`, `head`, `pgrep`, `ls`) throw `AnsibleSandboxUnreachableError` when the exec never ran. A student playbook that runs out of time is still the student's result. `verifyLab` now also reports this error, and a raw `ContainerRuntimeError` from the broker, as `ENVIRONMENT_UNREACHABLE` instead of 500.
- **Test.** `ansible-node-unreadable.test.ts`: 3 of 4 cases fail on the base; the control passes on both.

### D8: a sandboxd restart was reported as the student's shell exiting

- **Root cause.** A broker socket that closed after the attach (sandboxd restarted, crashed or was OOM-killed) became `onExit({exitCode: 0})`.
  - The student read "The shell exited (code 0)".
  - The workspace correctly never auto-reconnects `SHELL_EXITED`, although its bounded auto-reconnect was written to ride out exactly this restart.
- **Fix.** The broker client reports why a shell ended when no exit was seen (`endedBy`):
  - the broker's own `IDLE_TIMEOUT`/`SESSION_EXPIRED` map to the terminal's 4408 closes;
  - a lost broker maps to `SANDBOX_UNAVAILABLE`/1011, which the workspace already treats as transient;
  - a real exit is unchanged.
- **Test.** `broker-attach.test.ts`, "a broker shell that ends": the broker-lost case received close 1000 on the base; a genuine exit is pinned too.

### D9: a workflow YAML alias bomb made the lab's Check return 500

- **Evidence.** A 444-byte `.github/workflows/ci.yml` made `yaml` 2.x throw `ReferenceError: Excessive alias count` from `document.toJS()`, outside the parser's `try`. Every Check of that CI/CD lab then answered 500, and fed the api error-rate alert, for as long as the file existed.
- **Fix.** `toJS()` is now inside the same "YAML errors are returned, never thrown" contract. The CloudFormation, Ansible and `yaml_valid` parsers already honoured it.
- **Test.** `cicd-requirements.test.ts` threw on the base.

### D10: a Terraform file padded past the read cap passed a "must not contain" check

- **Evidence.**
  - The configuration scan asks for 256 KiB per file, but sandbox reads return at most 64 KiB, and `truncated` was ignored.
  - A `main.tf` padded with comments past 64 KiB, with `content = "production"` after the cap, **passed** TF-002's `terraform_resource_literal_absent`.
- **Fix.** A truncated configuration file fails every configuration check with "…too large for the checker to read in full — keep .tf files under 64 KiB". Judging the prefix that was read is how the padding worked, so the check fails closed.
- **Test.** `terraform-config-truncation.test.ts`: the padded file passed on the base; an ordinary-size file is still judged on its whole content.

### D11: a named test file that did not exist was silently dropped

- **Evidence (vitest 3.2.7).** `vitest run a.test.ts missing.test.ts` exits 0 having run only `a`. The strict runner accepted that too. Measured: the base runner exited 0 for `strict-vitest.test.ts does-not-exist.test.ts --root services/observability`.
- **Where this matters.** CI's NET-004…NET-008 step names five suites, and `make test-terminal-container` names two. A renamed suite would have left the step green. Every file named today exists, so nothing is dropped at present.
- **Fix.** `namedFilesNotRun()` resolves each named file against `--root` (either form, skipping option values) and fails the run if it is missing from vitest's report.
- **Proof.** The new runner exits 1, naming the file; the existing file alone still exits 0. Unit cases are in `strict-vitest.test.ts`.

## 4. Phase-by-phase results

| Phase | Result |
|---|---|
| 1 Baseline and map | §2. The CI workflow, Makefile, compose files, production scripts and release documents were read, directly or by the CI/config investigator (§6). |
| 2 Five-student lifecycle | D1, D3 fixed. **REVIEWED and correct** (investigator, with code references): owner-only guards on every `/api/sessions/:id/*` route; a 404 for another student's session; `/internal` re-checks `ownerUserId` against the live row; global and per-student admission under one advisory lock; a duplicate Start → 429 and a sixth student → 503; ENDING counts as occupying; idempotent End; Reset claims before runtime work; single-flight Check with a `statusChangedAt` fence; completion under `FOR UPDATE` that never downgrades PASSED; a fenced idle reaper. The existing five-student churn and adversarial suites pass. |
| 3 Terminal abuse | D4, D5, D8 fixed. **REVIEWED and correct:** frame caps; resize clamping; no frame before `auth`; a second `auth` refused; constant-time HMAC; token `exp` enforced; ownership re-proved on every credential and activity call; workspace path containment with O_NOFOLLOW and capped reads; per-attach credential nonces. Residuals: §7 R1, R2. |
| 4 Check/Verify | D6, D7, D9, D10 fixed. **Global Check bound (analysis):** each session has one Check at a time, and occupying sessions ≤ `MAX_ACTIVE_SESSIONS`, so concurrent Checks ≤ the global capacity. D1 makes that ceiling hold even under an End/Start loop. There is no overall Check deadline, but every step has its own, and the slot is held until they finish. That is deliberate: releasing the slot at an overall deadline would let hung Checks pile up in the background. The one path past nginx's 330 s is an `ansible_idempotent` Check whose *second* playbook run hangs (2 × 180 s); the student then sees the existing "check still running / try again" state. No change. |
| 5 Failure injection | D2, D8 fixed. The broker and exec deadlines from the earlier pass were re-checked: every exec path uses `execFileOutcome`. |
| 6 Isolation | No cross-student path was found. Covered by the Phase-2 review and by `test:security` (895 passed). |
| 7 Database | `make test-db` passed before and after (§9). D1 and D3 run on PostgreSQL. |
| 8 Browser | Reviewed: error mapping for 502/504/unreachable/`CHECK_IN_PROGRESS`, reconnect policy, and when `connected` fires. No new defect. D8 fixes what the browser was *told* after a sandboxd restart. |
| 9 Lab sampling | `validate:labs`: 117 labs, 0 errors, 0 warnings. Sampled TF-002/012, LINUX-001/008/016, ANSIBLE-005/009, CICD-002, AWS-012: no mismatch between requirement and handler. The systemic issues found (D6, D7, D10) were fixed in the verifier for every lab that uses those requirement types, not lab by lab. |
| 10 CI/supply chain | D11 fixed. Rest in §6. |
| 11 Production config | §6. No fail-open configuration found. Operator items in §10. |
| 12 Restart/recovery | D8 (sandboxd restart). Reasoned, unchanged: api (durable rows; the reaper resumes CREATING/ENDING/RESETTING), terminal (shells lost; the browser auto-reconnects), PostgreSQL (restore drill). |
| 13 Security | `test:security` 895/895. D5 and D9 are student-triggerable resource and availability issues. No injection, traversal or disclosure path was found (verifier investigator: every argv is an array; scripts get the path as `$0`). |
| 14 Resource exhaustion | D4, D5, and R1 (§7). |
| 15 Validation | §9 |

## 5. Tests added or changed

New test files:

- `services/verifier/test/sandbox-unreadable.test.ts`
- `services/verifier/test/ansible-node-unreadable.test.ts`
- `services/verifier/test/terraform-config-truncation.test.ts`

New cases in existing files:

- terminal: `input-backpressure.test.ts`, `broker-attach.test.ts`
- lab-orchestrator: `output-flow.test.ts`, `container-runtime-boundary.test.ts`, `session-recovery.test.ts`, `session-per-student-capacity.test.ts`
- verifier: `cicd-requirements.test.ts`
- observability: `strict-vitest.test.ts`

Changed to pin corrected behaviour:

- lab-orchestrator: 3 cases in `session-recovery.test.ts` and `session-per-student-capacity.test.ts`
- verifier: 1 case each in `bind-address.test.ts` and `neighbour-state.test.ts`

No test was deleted, skipped or weakened.

## 6. CI, production configuration and supply chain (investigator 4, re-checked)

| Finding | Class | Status |
|---|---|---|
| Strict runner ignores a missing named file | TEST COVERAGE GAP | **FIXED + PROVEN** (D11) |
| CI step "Observability containers hold no container runtime" (`quality-gates.yml` ≈ L220) is vacuous: the awk range ends on its own start line | CODE DEFECT (CI) | PROVEN (the awk prints only the three service-name lines). **Not duplicated:** fixed on the unmerged `feat/overnight-cicd-supply-chain` (`dc88f27`); merge that. |
| `web` (the public TLS edge) keeps Docker's default capabilities and is not `read_only`, unlike every other first-party service | hardening | **REAL-HOST REQUIRED.** nginx needs some of those capabilities to drop to its worker user. Changing this without a host run risks the edge. |
| Only `terminal` and `sandboxd` have memory/pids limits; postgres, api, web, prometheus, alertmanager and grafana have none | OPERATOR DECISION | Host sizing (RB-19) |
| Secrets reach containers as environment variables, so `docker inspect` shows them to anyone with Docker access | OPERATOR DECISION | Documented; the channel is unchanged |
| No rotation procedure for `POSTGRES_PASSWORD`, `INTERNAL_SERVICE_SECRET`, `SANDBOXD_*`, `NAMESPACE_DERIVATION_SECRET`, Grafana admin. The role password is set only at first start. | DOCUMENTATION/RUNBOOK GAP | Open |
| `main` has no branch protection or rulesets (read-only `gh api`) | OPERATOR DECISION | Open |
| 20 of 61 alert rules have no promtool unit test (all rules pass `check rules`/`test rules`) | TEST COVERAGE GAP | Open, low |
| prometheus, alertmanager and grafana have no healthcheck | low | Open |
| Actions pinned by tag, base images by floating tag | policy | Report only |
| **REVIEWED and correct** | | `npm ci` everywhere; Node from `.nvmrc`; `permissions: contents: read`; no `pull_request_target` or path filters; `persist-credentials: false`; kind/kubectl SHA-verified; `.dockerignore` excludes `.env*`, TLS, secrets and backups; every production service has a restart policy and bounded json-file logs; only 443/80 (plus loopback Grafana) published; every alert metric is emitted by code; every runbook link and referenced make target exists |

## 7. Known residual risks (repository)

| # | Risk | Evidence | Class |
|---|---|---|---|
| R1 | **Orphaned shells inside the student's own container.** Killing a `docker exec -it` client (as sandboxd does on every reconnect, takeover or idle close) does not end the shell in the container. | **PROVEN** on Docker 28.4.0: `sh` survived SIGHUP then SIGKILL of its client, and so did `sleep 1000`. | CODE DEFECT, not fixed. It is contained by the sandbox's own pids/memory limits and cleared by End or Reset (the container is recreated), so no other student is affected. A fix changes sandboxd's attach argv (for example, record the shell PID so `endShell` can signal it). Do that as its own reviewed change, proven with `make test-sandboxd-container`. |
| R2 | Unauthenticated `/terminal` sockets are bounded only by the 10 s auth grace and nginx; nginx has no `limit_conn`/`limit_req`. The terminal investigator flagged one further pre-auth amplification lead. It **stopped that line of work after a safety check and gave no details or repro**. | UNVERIFIED | OPERATOR DECISION: edge connection and rate limits. Re-scope the lead as its own task. |
| R3 | End during CREATING (D1): if a build is still running 5 min after End, the reaper's abandoned-End recovery records ENDED before the build finishes. The start then discards its sandbox. | By design; bounded by the provisioning deadlines (≈300 s) | residual, low |
| R4 | A session of a lab missing from the catalog still answers 500 on read/Check/Reset/terminal (it can now be ended) | D3 | low |
| R5 | `docker cp` of a file over ≈66.5 KiB fails instead of returning a truncated read (Docker track) | investigator repro; no current lab reads such a file | low |
| R6 | Ansible managed-node reads stop at 64 KiB with no truncation signal (`managed_file_content not_contains`, ANSIBLE-006/010) | SUSPECTED | low |
| R7 | Still open from earlier passes: no client-side PostgreSQL query timeout or keepalive; no per-Check overall deadline (§4, deliberate); workspace auto-reconnect backoff resets on connect; sandboxd shutdown waits out Docker's stop timeout; fence → `recordCheck` window; provider probes not single-flighted; hints on finished sessions; no per-student rate limit on Check, hints or token issuance | earlier reports | as documented there |
| R8 | A `bindSession` failure after `startAttempt` (a DB blip) leaves an unbound attempt, whose checks are not recorded until the sweeper expires it | code reading | low |
| R9 | A partial credential file is left behind if its write fails midway (ENOSPC). The terminal's SIGTERM path skips `endSession`. Both land on tmpfs. | code reading | low |
| R10 | Grafana applies `GF_SECURITY_ADMIN_PASSWORD` only when its volume is first created, so a later `.env` change can PASS the config check while the real login differs | SUSPECTED | DOCUMENTATION GAP |

## 8. Real-host validation still required

None of the following was run or claimed. There is no beta host:

- production preflight;
- five simultaneous real students, including `make beta-validate`;
- `make host-capacity-sample` (CPU, memory, PSI, OOM, disk, inodes);
- firewall exposure;
- DNS;
- certificate issuance and renewal;
- external HTTPS;
- an encrypted off-host backup, and a restore from it;
- an alert received by a human;
- a reboot and recovery drill;
- verification of the deployed commit;
- the production Docker CLI's exec/inspect wording, which D2, D6 and D7 read. They were measured on 28.4.0; an older or newer CLI must be checked;
- the `web` edge hardening (§6);
- behaviour under a network partition between api, sandboxd and PostgreSQL.

## 9. Validation performed (final code, this branch)

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `git diff --check` | clean before every commit |
| `npm test` | exit 0: **5611 passed, 336 skipped, 0 failed**. api 693/15, web 265/0, orchestrator 1402/253, observability 947/38, progress 96/1, sandboxd 161/7, terminal 199/22, verifier 1848/0. The 336 skipped tests are the infrastructure-gated integration suites, the same set as the baseline. |
| `npm run test:security` | exit 0: **895 passed, 0 failed** (265 + 116 + 85 + 214 + 8 + 197 + 10) |
| `make test-db` (private PostgreSQL 16, port 55482) | exit 0: progress 117 passed / 3 skipped (host-execution-guard self-tests); session store **187** passed (was 181; the new D1/D3 cases on PostgreSQL); api persistence 20 passed |
| `make db-restore-drill` | exit 0: "RESTORE DRILL PASSED in 24s" |
| `make test-production-host` | exit 0: 58 cases, 0 failed assertions; config gates self-test PASS |
| `make test-db-backup` | exit 0: 132 passed, 0 failed |
| `make test-private-beta-diagnostics` | exit 0 |
| `npm run validate:labs` | exit 0: 117 labs, 0 errors, 0 warnings |
| `make test-tls-edge` (real web image, private per-run tag, removed afterwards) | exit 0: **38 passed** |
| kind/Kubernetes: `test/integration.test.ts` via `strict-vitest`, shared `jumptotech-labs` cluster, kind-only kubeconfig | exit 0: **45 passed**, 0 skipped |
| Terminal integration against kind (via `strict-vitest`, on the host) | **NOT RUN, strict run failed as designed:** node-pty cannot spawn a PTY on this macOS host, so all 20 tests skipped and the strict runner exited 1. The supported path is `make test-terminal-container`, which rebuilds the shared `jumptotech/terminal-test` tag. **CI REQUIRED** |
| Browser E2E (Playwright, `bash e2e/stack.sh run`, isolated project `jtt-cert-e2e`, own sandbox tag and ports) | exit 0: **17 passed** (4.2 min), 0 failed, 0 skipped. The stack was torn down by the script and its 5 images removed. |
| `npm run test:integration:docker`, `npm run test:integration:sandbox`, `make test-sandboxd-container`, networking NET-004…008, pod-security and network-policy enforcement | **NOT RUN.** They either use the operator-controlled `jumptotech/lab-linux:latest` or rebuild a shared test tag, and need DinD. **CI REQUIRED** (the `quality-gates.yml` runtime jobs) |

During the session, individual api suites (the catalog tests) hit vitest's 5 s timeout at load average ~98. They passed when re-run alone (33/33) and in the final full run.

## 10. External and operator decisions still required

These are carried from the release gate and still open. None was decided here:

- identity provider;
- beta user allowlist or sign-in restriction (OIDC admits any issuer account);
- host and provider sizing, and per-service memory limits (§6);
- DNS;
- TLS/ACME;
- alert destination and on-call;
- off-host encrypted backup destination and retention;
- capacity thresholds;
- operator access;
- secret recovery and rotation (§6);
- attestation cadence;
- retention and uptime policy;
- logout and idle policy;
- IPv6, HSTS and CAA;
- edge connection and rate limits (R2);
- CNI and substrate for the Kubernetes egress model;
- branch protection on `main`.

## 11. Post-merge operational steps

- **Rebuild and redeploy** the api, terminal and sandboxd images. D1–D8 change code in all three. No image was built, tagged or pushed by this session.
- Merge `feat/overnight-cicd-supply-chain` (`dc88f27`) for the vacuous CI awk step (§6), or port that fix.
- After deploy, check that the production Docker CLI prints `Error response from daemon:` / `Cannot connect to the Docker daemon` for exec/inspect failures, as 28.4.0 does. D2, D6 and D7 rely on that wording.
- Students ending a lab during CREATING now see "still shutting down" until the build is discarded (D1). Support staff should expect this.
- Another session was working in parallel on a separate branch from the same base (commercial access/entitlements, `259af06`, unmerged). Expect possible overlap in the session manager when merging.

## 12. Environment notes (this session)

- The Docker daemon was off at the start. This session started Docker Desktop for the DB, restore-drill, TLS and integration suites.
- Starting the daemon brought back, through their restart policies, containers that belong to **other worktrees**:
  - kind clusters `jtt-p0-015`, `jtt-p0-016`, `jtt-p0-019`, `jtt-p0-020` and `jumptotech-labs`;
  - seven `jtt-feas-*` DinD probes.
- An attempt to `docker stop` the four `jtt-p0-*` clusters and the probes, to return them to their earlier stopped state, was **denied by the session's permission policy**. They are still running. Stop them with `docker stop` if you don't want them.
- This session created only uniquely named private containers (`jumptotech-labs-test-db-55481/55482`, `jtt-cert-probe-*`, `jtt-cert-exec*-*`). The test-db containers were removed by the make target, and the probe containers explicitly. No shared image was built, retagged or removed, and no prune was run.
- A kind kubeconfig was exported to the gitignored `infrastructure/kind/generated/kubeconfig-host.yaml`. It holds only the `kind-jumptotech-labs` context, at 127.0.0.1:16443.

## 13. Verdict

**Software ready for real-host five-student validation: YES.**

- Eleven defects were fixed and each is proven by a test that fails on the base. Three of them (D1, D2, D3) could have leaked or over-committed capacity: exactly the resource a five-student host is sized around.
- Every hermetic gate, the security suite, the PostgreSQL suites and the restore drill pass on this branch.
- The kind integration (45) and browser E2E (17) suites also pass here.
- It still needs its own CI run, above all the terminal-container, sandbox, docker and networking jobs that could not run here (§9).

**Enable five students now: NO.** The software is ready to be *validated* on a host, not ready to be *used* by students:

- none of the real-host evidence in §8 exists yet;
- the operator decisions in §10 are still open (identity provider, allowlist, backups, alerting, DNS/TLS, sizing);
- R1 and R2 should be decided before real students arrive.
