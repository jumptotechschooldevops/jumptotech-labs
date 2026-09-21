# Overnight final hardening — 2026-09-20/21

| | |
|---|---|
| **Branch** | `feat/overnight-final-hardening` — not merged, not pushed |
| **Base** | `d4e301b892f4f772e1a6eb7e20dd37b2d4fe9a0e` (`main` after PR #44). CI run 35561074717 passed all 10 jobs on it |
| **Final commit** | the commit that adds this report; the last fix before it is `35b8151` |
| **Scope** | this repository only: code, tests, scripts, configuration and documentation. No production host was used. No cloud resource, shared image or `:latest` tag was touched. No other worktree was modified. |
| **Changed** | 59 files, +2094 / −125, in 22 fix and test commits plus this report |

This pass took the integrated `main` and looked for defects that would hurt a
five-student private beta:

- one student's action affecting another student;
- a lifecycle transition that leaves the wrong state behind;
- the verifier grading wrong work as correct, or correct work as wrong;
- one student's input holding the shared api process;
- operator tooling that reports success it has not proven.

Every fix was reproduced first. Every new regression test was run against the
code *before* its fix and seen to fail. The one exception is the linear-time
tests: against the old code they do not fail, they hang, which is the defect
itself. For those, the old timings come from the audit repros.

## 1. Phases

| Phase | Result |
|---|---|
| 0 Baseline | Branch, HEAD, `origin/main` and merge-base are all `d4e301b`. Clean tree. Other sessions were running on this host (load average 30–75 all night). |
| 1 Quality gates | typecheck, build and lab validation passed. `test:security` passed 870/870. `npm test` had 9 failures, all 5 s timeouts or one socket hang-up under load. Each passes when run alone, and none recurred once the load dropped (§5). |
| 2 Five-student concurrency | 3 defects fixed: web late answers and Launch again (D-4); reaper stale snapshot (D-17); reattach race (D-12) |
| 3 Lifecycle failure injection | 3 defects fixed (D-17, D-18, D-21). Residuals are in §8 |
| 4 Student critical path | 5 defects fixed (D-1, D-4 to D-7) |
| 5 Verifier and lab quality | 9 defects fixed (D-8 to D-11, D-13 to D-16) |
| 6 Sandbox and terminal | 4 defects fixed (D-3, D-12, D-19, D-20) |
| 7 API security | 2 disclosure defects fixed (D-1, D-2) |
| 8 Network / TLS / production boundaries | Reviewed. No repository defect. Edge connection limits are a residual (§8) |
| 9 Database / backup | `make test-db` and `make db-restore-drill` passed against real PostgreSQL 16. 1 latent defect fixed (D-22) |
| 10 Observability | 1 defect fixed (D-21). Redaction gaps with no emitting path are listed in §8 |
| 11 Resource safety | 3 defects fixed (D-10/D-13 regex time, D-19 input, D-18 body deadline) |
| 12 Production-host tooling | 3 defects fixed (D-23, D-24, D-25) |
| 13 Release-gate consistency | 1 docs commit (D-26) |
| 14 Integration seams | D-1 and D-2 sit at the security × student-safe-errors seam. D-3 sits at the student UX × reconnect seam. |
| 15 Second adversarial pass | Done with two further audits. D-17, D-18, D-2 and D-21 came from it |
| 16 Final validation | §5 |

## 2. Defects found and fixed

| # | Area | Defect | Root cause | Commit |
|---|---|---|---|---|
| D-1 | api | The status poll (`GET /api/sessions/:id`), which the web makes every few seconds, returned the provider's raw `environment.message`: the API server URL and the broker's address during an outage. A failed Start's remediation was an operator command (`npm run sandbox:build`), and a failed step inside a successful operation kept its runtime `detail`. | SEC-RT-4 sanitised the error paths only | `a430b3b` |
| D-2 | api | `GET /api/labs`, `/api/labs/:id` and `/api/tracks` sent every student the availability probe's `reason` (for example `connect ECONNREFUSED 172.18.0.5:2376 (DOCKER_HOST=…)`) and `remediation` while a backend was down. | The catalog ignored the `reason`/`studentReason` split in `catalog.ts`. Two tests pinned the leak and now assert the safe payload. | `b45ceb3` |
| D-3 | terminal | Every Docker-track attach wrote the lab's baseline files over the student's work: a page reload, a second tab, an automatic reconnect, or the reattach after Reset. Check then graded the baseline. A read-only file, or a directory at a baseline path, failed Reset permanently (DEGRADED until End). | Attach used Reset's `O_TRUNC` restore. The service runs as the student's uid without `CAP_DAC_OVERRIDE`. | `70f1813` |
| D-4 | web | Verify, then End, then Launch again: when the slow check of the ended lab answered, its refresh replaced the running lab with the "Lab ended" summary (no terminal, and Launch refused), and the stuck Verify ref ignored Verify on the new lab. | `updateSession` and `refreshSession` accepted a copy of another session, and the in-flight marker was never released | `9752169` |
| D-5 | web | "Your lab is still shutting down … do not press End again" stayed on screen over the Lab ended summary. | The action error was rendered regardless of `final` | `9752169` |
| D-6 | web | Hints revealed while Launch again was preparing were recorded on the ended attempt, then vanished from the panel. | Hints were live while `relaunching` | `9752169` |
| D-7 | web | A lab the platform removed while the student browsed kept "You already have a lab running", with no Launch button, on every other lab page. | The running-lab list was never re-read on navigation | `a316347` |
| D-8 | verifier | `file_content equals` held the api event loop for about 22 s per Check on a 64 KiB file of spaces. Every student stalls. | `/\s+$/` backtracks quadratically | `4fb42eb` |
| D-9 | verifier | `# node build.mjs\rtrue` (or with U+2028) counted as running the build and the tests. Also about 7 s per 40 KB. CICD-003/004/005/009/010 affected. | The regex's `.` stops at `\r`, U+2028 and U+2029; the shell does not | `4fb42eb` |
| D-10 | verifier | CICD-008 passed with the password still hard-coded: a trailing `// credentials('id')`, a `/* … */` block, a string containing `credentials(`, or `passwordVariable:` inside a shell string. | Line-start comment test; unanchored match; the fallback read strings | `2acf2f8` |
| D-11 | verifier | Quadratic scans: Jinja2 (ANSIBLE-007, about 10 s), CloudFormation `${…}` (about 3 s), Jenkins stage header (about 2 s per parse) | Backtracking patterns over student text | `a0d209d`, `df0a772` |
| D-12 | terminal | Two overlapping reattaches (Reset pressed again after the api's 20 s give-up) left an unkilled shell. Through the broker, sandboxd then closed one under the student. | Reattach bypassed `attachInTurn` | `7ea580a` |
| D-13 | verifier | A comment inside a multi-line Terraform expression hid every reference after it, so correct TF-002 work failed. Its words also counted as code, so a TF-025 condition that validates nothing passed. | The expression value was sliced from source that still contained its comments | `913542f` |
| D-14 | verifier | `docker build -t 'img:$IMAGE_TAG'` and `\$IMAGE_TAG` passed CICD-009's "tagged from IMAGE_TAG" check. | `$NAME` was matched inside single quotes and after `\` | `c58a9b2` |
| D-15/16 | verifier | (Same commits as D-9 and D-11) The `ansible_managed` trailing-whitespace helper and pipeline-config `codeLines` used the same quadratic patterns | — | `4fb42eb` |
| D-17 | session | Stay active answered 200, and the reaper expired the lab anyway from its sweep-start snapshot. A Reset or Check pressed near the idle deadline could also be expired mid-run. | The idle-expiry claim matched status only. Reset and Check stamped activity only when they finished. | `eb1eafb` |
| D-18 | api | A terminal service or identity provider that stalled after sending headers held the Check (and, through `checksInFlight`, every later Check of that session) or `/auth/callback` forever. | The timer was cleared when `fetch` resolved on headers | `35b8151` |
| D-19 | terminal | Shell input was unbounded. Flooding `input` frames into a PTY that was not reading queued about 150 MiB in the terminal service or sandboxd (limit 512 MiB). Losing sandboxd drops every container-track student. | Only output had a bound | `bd4172d` |
| D-20 | sandboxd | During a Docker daemon blip every container-track student was told "This session has no sandbox" (never retried), and each attach was counted as an ownership security event. | Any `docker inspect` failure was read as "no such container" | `fde3d5f` |
| D-21 | observability | Any signed-in student could mint unbounded `route` label values (about 245k series) by changing the case of the URL. | `req.baseUrl` keeps the request's casing | `ccc0a4f` |
| D-22 | backup | Latent: once the table of contents outgrows a pipe buffer, every backup would be refused as "not custom format". | `printf | grep -q` under `pipefail` | `0dc7eb5` |
| D-23 | operations | The preflight passed `docker.rootless`, `exposure.port-80/443`, `exposure.other-listeners` and `git.clean` when their own command failed. The smoke skipped the restart-policy check silently. | Command output was tested, not command status | `5f40f18` |
| D-24 | operations | `make observability-token` "wrote" an empty token when there was no `.env`, kept the quotes, and took the first of two assignments. The preflight then sent the operator back to the same target. | A `grep | head | cut` pipeline under `/bin/sh` | `5f40f18` |
| D-25 | operations | The diagnostics bundle always failed with "a secret was found" whenever the env file was missing. | Node 22 takes `--env-file` as its own flag even after the script name | `8deb355` |
| D-26 | docs | The backup runbook said the CI drill had never run (it runs and passed). Its development recovery command failed in zsh. The stub-case count was stale, and "gates is daemon-free" was untrue. | Drift | `5e1d339` |

The input budget has a new log event, `terminal.input.rate_exceeded`,
documented in RB-12.

## 3. Regression tests added

- `apps/api/test/error-disclosure.test.ts`: 4 new cases (status poll, Start remediation, success-path steps, catalog routes)
- `apps/api/test/internal-fetch-deadline.test.ts`
- `apps/web/test/workspace.test.tsx`: 3 cases
- `apps/web/test/relaunch-and-navigation.test.tsx`
- `services/terminal/test/workspace.test.ts`: 3 cases
- `services/terminal/test/workspace-reconnect.test.ts`
- `services/terminal/test/input-budget.test.ts`
- `services/terminal/test/reattach-serialization.test.ts`
- `services/sandboxd/test/inspector.test.ts`
- `services/sandboxd/test/server.test.ts`: 1 case
- `services/verifier/test/student-text-linear.test.ts`
- `services/verifier/test/cicd-labs.test.ts`: 13 cases
- `services/verifier/test/tf-002-verification.test.ts`: 1 case
- `services/lab-orchestrator/test/terraform-hcl.test.ts`: 2 cases
- `services/lab-orchestrator/test/reaper-activity-fence.test.ts`
- `services/lab-orchestrator/test/session-store-contract.test.ts`: 1 case, run against both the in-memory store and PostgreSQL
- `services/observability/test/http-route-label.test.ts`
- `scripts/test-production-host-scripts.sh`: 3 scenarios, 9 assertions
- `scripts/test-private-beta-diagnostics.sh`: 2 cases
- `scripts/test-db-backup-restore.sh`: 1 case

## 4. Commands executed (final state, HEAD `35b8151` + this report)

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `npm run validate:labs` | 117 labs, 0 errors, 0 warnings |
| `npm test` | **5,514 passed, 334 skipped, 0 failed**: api 673/15, web 264/0, lab-orchestrator 1379/253, observability 926/38, progress 96/1, sandboxd 155/7, terminal 189/20, verifier 1832/0 |
| `npm run test:security` | **876 passed**, 0 failed, 53 files (baseline: 870) |
| `TEST_DB_PORT=55450 make test-db` (real PostgreSQL 16, throwaway container) | 316 passed, 3 skipped (after D-17: 318 passed) |
| `make db-restore-drill` (run-scoped id) | RESTORE DRILL PASSED in 36 s |
| `bash scripts/test-production-host-scripts.sh` | 55 cases, 0 failed assertions |
| `bash scripts/test-db-backup-restore.sh` | 118 passed, 0 failed |
| `bash scripts/test-private-beta-diagnostics.sh` | all cases passed |
| `npm run production:config-check -- --self-test` | RESULT: PASS |
| `node scripts/check-secret-distribution.mjs` | every service receives exactly its allowed secrets |
| `git diff --check d4e301b HEAD` | clean |

## 5. Skipped or unavailable here, and why

- **Suites needing kind, the full stack or a sandbox image build:** the kind integration, pod security, NetworkPolicy enforcement, terminal-in-container, sandboxd-in-container, Linux/Terraform/Ansible/CI/CD sandbox, networking, Docker, TLS-edge and browser E2E suites were **not run**. They need a cluster, image builds or a composed stack. This host is shared with other worktrees' clusters and stacks, and building would contend with (or overwrite) shared `:latest` images. CI runs every one of them; all passed on the base commit (run 35561074717). They have not run on this branch, because it is not pushed.
- **Tests skipped by their own gates:** the 334 skipped `npm test` tests need `RUN_INTEGRATION_TESTS`, `RUN_DB_TESTS` or `RUN_DOCKER_INTEGRATION_TESTS`. The DB ones ran through `make test-db`.
- **`make beta-validate`:** not run. It needs the running stack, kind and the observability profile.
- **Load:** the baseline `npm test` failures were 5 s timeouts, plus one socket hang-up in `five-student-reliability-simulation`. They happened at load averages of 33–75 caused by other sessions. Each file passed when run alone, and the final full run had 0 failures. This is classified as an environment limitation, not a product defect.

## 6. Repository blockers

None. Nothing found in the repository stops real-host validation.

## 7. External decisions (unchanged; not decided here)

D1 identity provider; D2 host, provider, size and substrate; D3 sign-in
restriction; D4 hostname and DNS; D5 CA, ACME and renewal; D6 alert destination
and on-call; D7 off-host backup, encryption and retention; D8 capacity
thresholds; D9 secret and key recovery; D10 operator access; D11 attestation
cadence; D12 retention and uptime check; D13 logout and idle timeout; D14 IPv6,
HSTS preload and CAA; D15 OIDC bearer tokens on `/api/*`
(production-host-readiness.md §19).

## 8. Known residual risks (repository)

- **Edge connection limits:** nginx has no per-client connection or request limits. Unauthenticated `/terminal` sockets are held for up to 10 s each. Values depend on D2.
- **Check after End (reliability doc §5):** a Check whose fence passed could still write PASSED onto an attempt that End closed in the same instant. It is practically unreachable because pg-pool is ordered. End never overwrites PASSED.
- **Lost attempt close:** if the close-attempt write is lost (a DB blip, or a crash between ENDED and the listener), the attempt stays IN_PROGRESS for up to about 65 min and is then relabelled EXPIRED. This is bookkeeping only.
- **Hints on a finished session:** `POST /hints` accepts a finished session (for about 15 min, until retention) and levels 1–50. This affects only the student's own `hintsUsed`.
- **Per-student rate limits:** Check, hints and terminal-token issuance have none (already known; Check is one at a time per session).
- **Terminal capacity:** `TERMINAL_MAX_SESSIONS` ignores attaches still in flight. With a per-student limit of 1 and 5 students, the overshoot is bounded well under 16.
- **Verifier:**
  - CICD-009 accepts a literal tag containing `github.sha` (`latest-github.sha`). Tightening the lab would reject `${{ format(…, github.sha) }}`.
  - `if: ${{ false }}` steps count.
  - NetworkPolicy named ports and `matchExpressions` are not modelled (no lab uses them).
- **Redaction gaps with no emitting path found:**
  - a session cookie under a custom `AUTH_COOKIE_NAME`;
  - bare cookie values containing `-` or `_`;
  - double-encoded JSON credentials;
  - `postgres://:pass@host`;
  - error `name`/`code`;
  - PEM keys larger than about 4 KB.
- **Docker engine caches:** per-session caches are never evicted (about one object per Docker session).
- **Deployment evidence:** the release-gate evidence documents describe earlier commits. This branch's changes need CI and the real-host checks below.

## 9. Real-host evidence still required

On the chosen host (none exists yet), each of these is still needed:

- the production preflight;
- five simultaneous students;
- CPU, memory and disk capacity samples;
- firewall exposure;
- DNS;
- certificate issuance and renewal;
- external HTTPS;
- an encrypted off-host backup, and a restore from it;
- an alert received by a human;
- a reboot and recovery drill;
- verification of the deployed commit.

None of this can be produced from this repository, and none is claimed here.

## 10. Conclusions

**SOFTWARE READY FOR REAL-HOST VALIDATION: YES.** Every hermetic gate, the
security suite, the PostgreSQL suites and the restore drill pass on this
branch. It still needs its own CI run (kind, sandbox, E2E) before merge.

**READY TO ENABLE STUDENT ACCESS: NO.** The real-host evidence in §9 and the
external decisions in §7 are not done.
