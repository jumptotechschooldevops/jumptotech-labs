# Private-beta launch-readiness pass — 2026-09-17

| | |
|---|---|
| **Branch** | `feat/private-beta-launch-readiness`, on `main` at `bf712a8` (PR #38 merged) |
| **Includes** | the unmerged `feat/private-beta-readiness` pass (`fb94cf5`), replayed without conflict — `main`'s tree was identical to that branch's base `fbe490d` — so its nine fixes and browser tests are part of this branch ([its report](private-beta-readiness-2026-09-17.md)) |
| **Production host deployed?** | **No.** Nothing here ran on a production host, a public DNS name, a real certificate, a real identity provider, an off-host backup destination or a real alert receiver. |
| **Verdict** | Software ready for a **real-host deployment test**. **Not ready for student access.** |

Evidence words are those of the earlier report: **PROVEN IN REPOSITORY**,
**PROVEN BY AUTOMATED TEST** (CI), **PROVEN LOCALLY ONLY**, **REQUIRES REAL
PRODUCTION HOST**, **REQUIRES EXTERNAL CONFIGURATION**, **PARTIALLY / NOT
IMPLEMENTED**, **BLOCKED BY HUMAN DECISION**. Nothing on this branch has run in
CI yet: quality gates run on pull requests.

## 1. What this pass found and changed

Every defect was reproduced — in the browser against the real stack, with the
real curl, or in a failing test — before it was changed, and every fix has a
test that fails without it.

| # | Defect | Who hits it | Fix | Evidence |
|---|---|---|---|---|
| 1 | **Keys typed while the terminal (re)connects were silently dropped.** After Reset the first command was lost or arrived truncated (`((6*7))`, `bash: syntax error`). The same gap existed on first connect, Reconnect and every automatic retry. | every student who types right after Reset, a reconnect or opening the workspace | `LabTerminal` takes keys from the start of each connection attempt, holds up to 4 KB, sends them in order once that attempt is `ready`, drops them with an attempt that never gets there, and sends input in frames under the service's 8 KB limit without splitting a surrogate pair (`b1b63cc`) | §2; four component tests fail on the previous component; browser Reset test (types once, no retry) **0/3 before, 5/5 after** |
| 2 | **A paste over 8 KB was refused (`FRAME_TOO_LARGE`) and lost** (earlier report §4) | students pasting a config file | falls out of #1's framing | component test (`cc3e864`) fails on the previous component |
| 3 | **A database blip could sign a student out for good.** A session-store failure (PostgreSQL restart, pool connect timeout) was a 401 `AUTH_INVALID_TOKEN` on the api; the web then re-checked `/auth/session`, which answered the same failure as "signed out" **and cleared the cookie** | every signed-in student during a database restart or under load (seen in the browser E2E: a valid cookie got 401 after 7.2 s) | an infrastructure failure is `503 AUTH_UNAVAILABLE` (`Retry-After: 5`) on the api and on `/auth/session`, the cookie is kept, the error is logged server-side; the web words it as a retry, not "sign in again" (`87d97b4`) | three api cases in `test:security` (two fail on the old code); web mapping test; new browser test with PostgreSQL **stopped**: fails on the old api (`/auth/session` 200, signed out), passes 2/2 after (`a7938c4`) |
| 4 | **During a Reset the terminal bar said "The shell exited." and offered Reconnect** for 7–25 s (measured), which reads as a failure | every student who resets a container lab | "Resetting your environment…" without Reconnect while the reset runs (`a7cb2fe`) | workspace test fails on the old page |
| 5 | **An unknown session status would throw in the app shell**, outside every error boundary, and blank the app (a tab open across a deployment that adds a status) | every student with a lab open during such a deploy | `sessionStatusText` falls back to "Updating" (`a7cb2fe`) | routed-app test fails on the old code |
| 6 | **The next lab's page told a student who had just pressed End that the lab "is still running … end it"**; for a slow teardown nothing on that page re-read the list | the learning-path loop: End, then the next lab | "is shutting down", Launch disabled, the list re-read every 3 s, Launch offered by itself (`5d26a70`) | measured in the browser (~3 s on Linux); component test fails on the old page |
| 7 | **The smoke's `--public-ip` probe reported open ports as closed.** It counted a port open only when `curl telnet://` exited 0; PostgreSQL, HTTP, TLS and SSH wait for the client, so an open port ends in curl's time limit (28) like a filtered one — a public 5432 printed PASS | the operator's exposure evidence | open = `time_connect > 0`; the harness fake now behaves like real curl (`e6c3a56`) | curl 8.7: silent listener exit 28, refused exit 7, time_connect 0.00033 vs 0; harness fails on the old script |
| 8 | **Operator checks reported PASS for what they could not prove**: smoke `edge.internal-not-routed` / `edge.not-routed/*` on a failed request, `observability.alerts` "no alert is firing" when Prometheus did not answer; preflight `backup.schedule` on a cron file with every job commented out; preflight stopped with no RESULT line and no report when the config check printed nothing (pipefail); `--report` omitted the FAIL lines its summary pointed at; systemd-resolved's `127.0.0.53%lo:53` reported as a public listener; config check exit 1 instead of 2 when docker cannot run (`e6c3a56`) | the operator deploying the first host | as listed | `test-production-host-scripts.sh` 44 cases, 0 failed on macOS bash 3.2 and Linux bash 5.2; 12 assertions fail against the previous scripts |
| 9 | **The first-host procedure could not be followed in order**: the synthetic five-student gate (§15 step 15) rewrites the NetworkPolicy attestation, and the procedure went straight to `prod up` (every Kubernetes lab refused); "stop at the first FAIL" could never pass step 17 while `backup.offhost` is FAIL by design until D7; the evidence template's step numbers were one behind from step 15 (`66bf2cf`) | the operator | repeat steps 12–14 after the gate; the one named exception; template renumbered with the missing rows; `--env-file` usage says `prod up` always reads the checkout's `.env`; compose calls get `/dev/null` stdin | documentation; harness still 44/0 |
| 10 | **A busy host failed Start as a broken sandbox image.** Five simultaneous starts on a loaded machine: container creation took 38 s, then the first `docker exec` (the identity probe) was killed at its 15 s limit and the start failed with "Rebuild the sandbox image". Underneath, the Docker runtime never recognised a timeout at all: Node reports a killed command as `killed: true, code: null`, and the runner looked only for `code === 'ETIMEDOUT'`, so every "did not finish in time" branch (seed scripts, verifier command and script checks) was unreachable | any student starting a lab while others do, on a busy host | `execFileOutcome` reads `killed` (as the Docker CLI client already did), for the container runtime and the kind provider; tooling probes get 60 s like other runtime operations; a probe timeout says the host is busy and to try again (`e93e2e9`) | found by the five-student browser test (start response in the trace); provider and helper tests fail on the old code |

Items 7–9 came from a read-only audit of the production-host tooling; its
backup/restore review found no defect (0600 archives, `pg_restore --list`
validity, checksums, `--replace` needs confirmation and refuses connected
sessions, staging database and rename, no connection string in logs).

## 2. The Reset "double attach" was not the cause

The earlier report (§4) attributed the lost first command to the terminal
service reattaching the socket *and* the page reconnecting it. A browser probe
recorded every WebSocket frame and the reset request, with timestamps, over six
resets on an isolated stack:

```text
   8878  POST …/reset
   9901  ws#1 << {"type":"exit","exitCode":137}     ← the container is removed; the shell dies
   9969  ws#1 CLOSED                                  ← the service closes the socket
  16513  HTTP 200 …/reset                             ← the api's reattach found no socket
  16542  ws#2 open → auth → 19669 ready               ← the page's reconnect, the only one
```

The old socket was closed 0.4–3 s into every reset, long before the api asked
for a reattach, so no reattach happened in any run. The loss was in the browser:
the confirm dialog closes when the reset answers, the student types at once,
and `LabTerminal` registered its keystroke listener only on `ready`. The probe
typed `echo EARLY1X…-$((6*7))` 0.8 s before `ready`; the wire shows only
`((6*7))\r` was sent.

The service's reattach path is left in place: it is a no-op when the socket is
already closed, and still useful if a runtime ever keeps an exec alive past the
container's removal. The page's reconnect is the one mechanism that runs.

## 3. Validation on this branch

On a development machine shared with other worktrees' stacks and kind clusters
(load average 7–19). **None of it is host evidence, and none of it has run in CI.**

| Command | Result |
|---|---|
| Baseline at `c937ef6`: `npm test` | 4,876 passed, 1 failed — `process-environ-api` "socket hang up", a known load flake; passed 5/5 alone |
| Baseline: `npm run typecheck` | failed: `@playwright/test` missing — this worktree's `node_modules` predated the e2e workspace (**local environment**); PASS after `npm ci` |
| Baseline: `validate:labs`, `build`, `test:security` | PASS (117/0/0; 797) |
| Final tree (`e93e2e9`): `npm test` | **PASS** — 4,896 passed, 0 failed (api 606, web 220, lab-orchestrator 1,337, terminal 767, sandboxd 96, verifier 138, progress 163, observability 1,569) |
| `npm run test:security` | **PASS** — 803 (797 + 3 auth store-outage cases + 3 exec-timeout cases) |
| `npm run typecheck`, `npm run build`, `npm run validate:labs` | **PASS** (117 labs, 0 errors, 0 warnings) |
| `bash scripts/test-production-host-scripts.sh` | **PASS** — 44 cases, 0 failed (macOS bash 3.2; Linux bash 5.2 in `node:22-bookworm-slim` at `66bf2cf`) |
| `npm run production:config-check -- --self-test` | **PASS** |
| `node scripts/check-secret-distribution.mjs`, `npm run test:composition` (25), `bash scripts/check-observability.sh` | **PASS** |
| `bash e2e/stack.sh run` (isolated project `jtt-e2e-launch`), first full run at `5d26a70` | 14/15 — five students: one start `SESSION_PROVISION_FAILED` on a busy host; root-caused and fixed (`e93e2e9`, §1 #10) |
| `bash e2e/stack.sh run`, final tree, clean stack | **PASS 15/15** in 6.4 min at load ~16; 0 containers left |
| Browser Reset test alone | 0/3 against the previous bundle; 5/5 with the fix |
| Browser database-down test | fails against the previous api; 2/2 with the fix, then in both full runs |
| Not run | `make beta-validate` (a sixth kind cluster on an 8 GiB VM already holding several would put other worktrees' clusters at risk); kind/sandbox/docker/terminal/sandboxd/tls-edge/postgres integration suites (unchanged areas, except the container runtime, whose change is covered by unit tests and the browser suite) |

## 4. Remaining student-journey findings (not fixed)

- Two attaches for the same session that are *both* in flight at the same
  moment can each register; the later one wins. Narrow, not reproduced (earlier
  report §4), unchanged.
- The service-side reattach after a container Reset never runs in practice (§2).
  Harmless; a candidate for removal once a host confirms the same timing.
- A session stuck in `ENDING` for longer than a teardown should take still
  blocks the student's next lab, now with "is shutting down" rather than a
  wrong instruction. `SessionTeardownStuck` alerts the operator after 20 min.

## 5. What still blocks student access

Unchanged by this pass, and none of it can be done in this repository:

1. **D3 — restrict sign-in to the beta students at the identity provider**, and
   prove a non-beta account is refused. The api still admits any account the
   issuer authenticates (authentication.md §4.7); this is a documented,
   deliberately open product decision, and no application allowlist was
   invented here.
2. **D2 — a host**, then production-host-readiness.md §15 end to end (config
   check, attestation, preflight, the synthetic gate on the host, start, smoke,
   external port scan).
3. **D4/D5 — DNS name and a real certificate** with renewal.
4. **D6/D12 — an alert receiver and a person**, the delivery drill, and an
   external watchdog for the monitoring stack and the host (no heartbeat alert
   exists; its shape depends on the service chosen).
5. **D7 — an off-host, encrypted backup** and one restore from it.
6. **D8 — capacity thresholds**, then the five-person rehearsal on the host.
7. **Reboot and Docker-restart drills** on the host, including the kind node.

## 6. Commits

| Commit | Change |
|---|---|
| `c937ef6` and the 29 before it | the replayed `feat/private-beta-readiness` pass |
| `b1b63cc` | fix(terminal): keep keys typed while the terminal connects |
| `0bcd64f` | test(e2e): type once, right after Reset, with no retry |
| `e6c3a56` | fix(production): operator checks no longer report PASS for what they could not prove |
| `66bf2cf` | docs(production): make the first-host procedure followable in order |
| `a7cb2fe` | fix(web): "Resetting" during a reset; survive an unknown session status |
| `87d97b4` | fix(auth): a session store that cannot answer no longer signs a student out |
| `a7938c4` | test(e2e): PostgreSQL down under a signed-in student keeps the sign-in |
| `cc3e864` | test(web): a paste over one input frame arrives whole |
| `5d26a70` | fix(web): the next lab's page says the ended lab is shutting down |
| `e93e2e9` | fix(runtime): a busy host no longer fails Start as a broken sandbox image |
