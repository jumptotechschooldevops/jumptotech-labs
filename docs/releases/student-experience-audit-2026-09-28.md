# Student experience audit — 2026-09-28

**Question.** If five students get accounts tomorrow, can each of them do all of this without an instructor fixing the platform?

- sign in
- find a lab and understand it
- start it and use the terminal
- do the task and check their work
- reset after mistakes
- end the lab and start another

**Scope.** Student experience, browser E2E and product quality. This audit does not take over any of these, each of which has its own workstream:

- security red-team
- Docker/Kubernetes isolation
- per-session uids
- capacity
- production hosts
- catalog certification

Issues that belong to those are listed in G with their owner, not fixed here.

## A. Baseline

| | |
|---|---|
| Audited from | origin/main `bcaf902` |
| Ended at | origin/main `baacb2d`, with all fixes below merged |
| How changes landed | Squash-merged, one PR per defect, each with required CI green |

## B. Journeys tested

| Journey | Where |
|---|---|
| Full journey for one lab: sign in → dashboard → catalog search → lab page → Launch → terminal → Verify (empty, partial, pass) → hint → Reset → Verify → End → next lab | Real stack¹, real Chromium |
| Sign-in: success; Cancel at the provider; a spent or foreign sign-in page; identity provider unreachable; sign-in expiring mid-lab; sign-out followed by a different student; reload after sign-in | Real stack and UX suite² |
| Start: double click; reload while starting; leave and come back; capacity full; refused launch; provider unavailable | Real stack and UX suite |
| Terminal: typing, Enter, Backspace, Ctrl+C on `sleep`, history, `clear`, 2 MB of output, multiline paste, a 200 KB paste, Ctrl+D/`exit` then Reconnect, second tab, refused and dropped sockets | Real stack and UX suite |
| Check: right after Start, empty, partial, pass, repeated, after Reset, during End, platform failure | Real stack and UX suite |
| Reset: normal, during a running command, after a failed Check, double click, a reset that fails (DEGRADED) | Real stack and UX suite |
| End: normal, during Verify, double click, reload during End, a destroy that fails (DESTROY_FAILED) | Real stack and UX suite |
| Labs in sequence (LINUX-001→LINUX-002, NET-002→LINUX-001, LINUX-004→LINUX-005, …) | Real stack |
| Five students side by side on different labs | Real stack, UX suite, CI stack suite |
| Refresh, Back, duplicate tab; API/terminal/database failures; six window sizes; keyboard only; semantic accessibility audit | UX suite and stack suite |
| Lab instructions read as a student would: 18 labs across all 9 tracks, plus a catalog-wide sweep | Reading plus scripts, cross-checked against each lab's checks |

¹ `e2e/stack.sh`: nginx and the production web bundle, the api in OIDC mode against the test identity provider, PostgreSQL, the terminal service, sandboxd and real Linux sandboxes. Only the Linux provider runs there (48 labs across Linux, Networking and CS). The Docker, Kubernetes, Terraform, Ansible and CI/CD runtimes are covered by the certification workstream's CI sweeps.

² `npm run test:e2e:ux`: the production bundle in Chromium against an in-test fake platform. See section 19 of `docs/development/browser-e2e-private-beta.md`.

## C. Browser E2E

| Suite | Result |
|---|---|
| Stack suite `browser-e2e` (CI, dedicated runner), including five students at once and a sixth refused | **17 passed, 0 failed, 0 flaky** on every PR run of this pass (1.7–2.0 min) |
| Stack suite locally, at host load 60–76 | First 5 tests: 2 passed, 3 timed out on server slowness (a start took 174 s and failed; attach took >120 s). Stopped there, because it was measuring the host. |
| UX suite `browser-ux`, new, on main `bcaf902` | 55 tests: **45 passed, 10 failed — 10 real defects** (D2–D5) |
| UX suite on final main | **57 passed, 0 skipped, 0 flaky**, three consecutive runs (34–58 s) |

A green `browser-e2e` was not evidence of a complete student experience. It drives one lab and never reads the instructions, and all 10 UX defects and the instruction-rendering defect were present while it was green.

## D. Defects found and fixed

| # | Severity | Student impact | Reproduction | PR → main |
|---|---|---|---|---|
| D1 | **High** | Lab instructions were unreadable or misleading. 71 of 117 task descriptions rendered as one paragraph (TF-003: 16 paragraphs in one block). Answer formats collapsed onto one line: CS-012's three `KEY=value` lines, which the verifier reads line by line, so a student copying the format fails Check (also CS-009/010/013 and ANSIBLE-007). Lists, tables and a Jenkinsfile skeleton ran into prose; 53 labs showed literal `**`; 227 hints showed raw backticks. | Every lab page on main. A UX test fails on main's renderer. Real-stack screenshot of LINUX-001. | #142 → `cf7dcd5` |
| D2 | **High** | Cancelling at the identity provider, a stale or foreign sign-in page, or an identity-provider hiccup left the student on a page of raw JSON at `/auth/callback`, with no way back. | Seen live on the real stack: `{"ok":false,"error":{"code":"AUTH_MISCONFIGURED",…}}`. API and UX tests. Re-checked on final main's real stack: Cancel returns to `#/labs/LINUX-001` with "Sign-in was cancelled", and Back plus resubmit lands on the dashboard. | #144 → `baacb2d` |
| D3 | Medium | A sign-in that expired mid-lab showed the first-visit welcome, with no reason. Sign-out kept the previous student's page in the URL, so the next student on a shared computer landed on it. "Cannot reach the labs API" said nothing about what to do. | 4 UX tests failed on main | #138 → `b7b8137` |
| D4 | Medium | Double-clicking End lab or Reset opened the confirmation and closed it at once, so the button seemed dead. | UX test failed on main | #139 → `54b6d88` |
| D5 | Medium | Accessibility: an automatic terminal reconnect stole focus out of an open dialog; focus fell to the page top after End; revealing the last hint dropped focus; the preparing card announced its seconds counter every second. | 4 UX tests failed on main | #140 → `7908e95` |
| D6 | Medium | A completed lab reached again (reload after End, Back) said only "not running", as if the work was lost. | UX test failed on main | #141 → `34a316a` |
| D7 | Medium | Typing `exit` or Ctrl+D showed only "The shell exited." in red, which reads as a broken lab. It is not: Reconnect gives a new shell in the same sandbox, and files are kept (verified on the real stack). | Real stack; UX test fails on main | #153 → `badfb86` |
| D8 | Low | A provider probe that failed during a load spike left "This lab cannot be started right now" with no way to ask again except reloading the browser. | Real stack (LINUX-001 during load) | #150 → `2113382` |
| D9 | Low | Lab content: 7 bulleted lists folded onto one line (TF-002/003/005/006, CICD-002/005/007); NET-002's checklist out of order; a stray fragment in TF-026 hint 3; TF-025 not stating what its check requires. | Reading each lab against its checks | #143 → `25d1e8f` |

Test infrastructure: the browser UX suite and its `browser-ux` CI job, #128 → `373a6af`. It was written on `feat/overnight-browser-quality` (2026-09-21) and never merged. Five of the fixes above (D3–D6) also came from that branch and are cherry-picked with `-x`.

## E. UX improvements merged

These are D1–D9 above. In short:
- instructions that read as written
- a sign-in that never ends on JSON
- plain words for expiry, cancel and outage
- dialogs that survive a double click
- focus that stays with the student
- a completed lab that stays completed after a reload
- a closed shell that says the lab is still there
- an unavailable lab that can be checked again

## F. Areas tested with no defect found

- **Start:** a double click sent exactly one start request. A reload during start found the lab again. Capacity full, and a second lab for the same student, are both explained, with Continue offered.
- **Terminal:** Ctrl+C interrupts; 2 MB of output renders; history works; multiline paste runs line by line. A 200 KB paste stayed connected. A second tab takes the terminal over and Reconnect takes it back.
- **Check:** feedback names what the verifier saw (e.g. *'/home/student/project/app.log' is still present*). It leaks no JSON, stack traces or internal paths beyond the lab's own files, and a platform failure is never presented as a failed task.
- **Reset:** gives a fresh environment, clears the old verdict and reconnects the terminal. A failed reset says so and keeps Reset/End available.
- **End:** a failed destroy says cleanup continues. A reload during End shows what the server holds; no phantom running lab.
- **Isolation in the UI:** no student ever saw another's lab, name, terminal, verdict or progress, in 2 real-stack five-student runs and the UX suite. A second lab never showed state from the first.
- **Catalog:** search by id, title or topic ("LINUX-001" → 1 of 117); track, difficulty and status filters; an empty result has Clear filters. No duplicate or unclear titles.
- **Performance:** initial bundle 76 KB gzip JS and 7.5 KB CSS; the workspace (xterm) loads lazily at 85 KB. Polling is 15 s while steady and 3 s in transitions, and pauses in hidden tabs.
- **Errors:** capacity, student limit, session store unavailable, verify/reset/end failures and terminal failures each have a title, a next step and a reference code.
- **Supportability:** the operator CLI lists sessions by student, lab and status. API logs carry a request id, lab, session and outcome for start, reset, end and check. Students see a reference code to quote.

## G. Remaining student-experience risks

1. **Host capacity dominates the real experience.** On this shared laptop at load 25–76, starts took 22–174 s, Reset 57–133 s and End up to 38 s. PostgreSQL pool timeouts surfaced as "The platform is busy for a moment" (`AUTH_UNAVAILABLE`), and Docker kill failures left a reset DEGRADED or an end pending. The UI stayed truthful and recoverable every time, but a class on an undersized host will be slow and confusing. *Owner: performance/capacity (beta-host run).*
2. **Runtime broker `ECONNRESET` under load** made a Verify right after Reset answer "could not read your environment". *Owner: performance (#120; cause still open).*
3. **An End whose destroy fails stayed ENDING for more than 7 minutes** on the E2E stack, until another End. The reaper did not adopt it; on this stack its sweep also fails on the absent Kubernetes context. *Owner: reliability/session lifecycle.*
4. **Checks that pass on an untouched environment.** LINUX-001's "app.log was moved, not copied" shows ✓ before the student has done anything (it is `path_absent`). That is misleading to a beginner. The verifier has no "depends on" link between checks. *Owner: catalog certification.*
5. **A reload in the first second after End can cancel the request** before it reaches the API. The lab then shows as still running, which is truthful, and End works again.
6. Most pages have no client-side timeout. A lab page on a stalled API shows "Loading…" until nginx gives up after 60 s, and then an error with Try again.

## H. Instructor intervention still required

- An End that stays "Shutting down" for many minutes (G3). The operator can end it with the operator CLI's `end <id> --yes` (docs/runbooks/RB-17-session-lifecycle.md); the student can simply press End again.
- A lab that keeps failing to start, reset or end on an overloaded host (G1): lower the load or raise capacity.
- Access and entitlement problems (the page says so and gives a reference to quote).
- Nothing else found here needs an instructor. Sign-in failures, expiry, capacity, reset failures, a closed shell, a lost terminal and a stale "unavailable" are all now self-service.

## I. Five-student acceptance

| Run | Student 1 | Student 2 | Student 3 | Student 4 | Student 5 |
|---|---|---|---|---|---|
| CI `browser-e2e` five-students spec (dedicated runner), on #144, #150 and #153 | PASS | PASS | PASS | PASS | PASS |
| Real stack, this laptop, main `3a4fcfb`, full journey including a second lab, load ~25–35 | FAIL (sign-in page >60 s) | FAIL (lab page >30 s) | **PASS** | FAIL (DB timeout after End) | FAIL (catalog >30 s) |
| Real stack, main `bcaf902`, load ~50 | **PASS** | FAIL (reset failed: Docker kill) | FAIL (reset failed) | FAIL (destroy pending) | **PASS** |

Every real-stack failure was server slowness or a Docker daemon error on a host shared with about ten other stacks and five kind clusters. Every time, the UI showed a true, recoverable state, and no step leaked another student's data. The CI runner, which has no such contention, passes all five, every run.

## J. Private-beta verdict

**STUDENT EXPERIENCE READY FOR 5-STUDENT PRIVATE BETA**, on this condition, which belongs to the capacity workstream and not to the product:

- The five-student journey must pass on the actual beta host (or a host of the same size) before students arrive.

The product side has no known blocker. The two High defects (D1 unreadable instructions, D2 raw-JSON sign-in) are fixed and merged.

## Process notes

- #144 was rebased once and updated with `git push --force-with-lease` on its own feature branch, before I switched to merging main into branches. That departs from this pass's no-force-push rule; main itself was never force-pushed.
- #139 and #140 were merged seconds after #143, while GitHub was still re-computing their merge state (`UNKNOWN`). All their checks were green, and both merged cleanly. After that, each merge waited for a fresh `MERGEABLE`/`CLEAN`.

## K. Public-product gaps (not beta blockers)

- A "depends on" link between checks, so a check cannot show ✓ before its premise holds (G4).
- Client-side timeouts and progress wording for slow page loads (G6).
- Mobile: laptop and tablet layouts pass; phones are not designed for.
- Terminal accessibility beyond xterm's defaults (screen-reader mode).
- An onboarding tour, in-product help search and self-service support tickets.
- Billing and analytics are separate workstreams.
