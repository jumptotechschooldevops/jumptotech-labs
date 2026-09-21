# Overnight scale, resilience and resource-lifecycle pass

| | |
|---|---|
| **Branch** | `feat/overnight-scale-resilience` |
| **Base** | `d4e301b892f4f772e1a6eb7e20dd37b2d4fe9a0e` (= `origin/main` at start, confirmed) |
| **Final commit** | see `git log` — the last commit on the branch is this report |
| **Scope** | Performance, capacity, resilience, resource lifecycle, failure injection, concurrency, long-run stability. Not lab curriculum; not broad beta readiness. |
| **Machine** | One shared macOS laptop, 10 CPUs, running several other overnight worktrees at once: load average 30–72 throughout. |
| **Verdict** | Repository: ready for code review, ready for real-host five-student load validation. **Nothing here proves real-host capacity.** Do not enable students on this branch alone. |

Evidence words: **PROVEN BY TEST** — a test in this branch that fails on the base and
passes here (run both ways unless the row says otherwise); **MEASURED LOCALLY** — observed on this laptop,
not asserted by a test; **REVIEWED** — read, no defect found; **REAL HOST** — cannot
be proven here.

---

## 1. Repository resilience vs real-host capacity

This report is about **repository resilience**: whether the code bounds, cancels,
cleans up and recovers correctly under concurrency and failure. It says nothing
about **real-host capacity**: CPU, memory, disk, network, container density and
latency of the chosen beta host. Section 12 lists what the host must still prove.

## 2. Architecture and resource map (as read at the base)

```text
browser ─► nginx ─► api (Express) ── auth/authz (session guard) ── SessionManager
                     │                                   │
                     │  PostgreSQL (pg pool: 10 conns, 5 s connect, 10 s statement_timeout)
                     │                                   │
                     │                     provider: kind (k8s API, 30 s/request deadline)
                     │                               container/docker/ansible/cicd
                     │                               ─► BrokerRuntime / BrokerDockerEngines ─► sandboxd ─► docker CLI
                     ├─ verifier (in-process) ─► sandbox reads / execs / k8s reads / terminal workspace
                     ├─ reaper (single-flight sweep) · attempt sweeper · auth-session sweeper
                     └─ terminal control (terminate/reattach, HTTP, 5 s/20 s)
browser ─ws─► terminal ─► api /internal credentials (10 s) ─► PTY local (node-pty) or ─ws─► sandboxd PTY (docker exec -it)
```

Resources whose lifetime belongs to a student session, and who releases them:

| Resource | Where | Released by |
|---|---|---|
| Session row / capacity slot | PostgreSQL `lab_sessions` | status leaving the occupying set (End, reaper, failed start) |
| Sandbox (namespace / container / volumes / networks) | provider | End / reaper teardown, retried until verifiably gone; orphan sweep |
| Terminal shell + credentials files | terminal `sessions`, `bySessionId`, `attachClaims`, `attachQueues`, output/input flows | socket close, supersede, `closeSession` (End), idle/max timers |
| Broker PTY | sandboxd `shells`, `bySessionId` | socket close, replacement, idle/max timers |
| Check slot | api `checksInFlight` | `finally` of the check |
| Docker engine caches | `DockerEngineFactory` | **nothing, before this pass** (fixed, §4 D9) |
| Timers | terminal auth grace 10 s, idle 30 min, max 2 h; sandboxd handshake 10 s, idle, max; flow-control polls | cleared in each `end*` path |

## 3. Existing coverage found (not duplicated)

Strong prior coverage from the reliability (#51) and red-team (#50) passes:
`five-student-reliability-simulation`, `five-student-adversarial`, `check-concurrency`,
`check-lifecycle-race`, `session-lifecycle-races`, `session-recovery` (also on
PostgreSQL), `start-refusal-attempts`, `session-guard-store-failure`,
`broker-attach`, `concurrent-attach`, `output-backpressure`, `output-flow`,
`kubernetes-client-deadline`, `server.test` (sandboxd `caller_gone`),
`workspace` (bounded reads), `request-body-errors`, `sandbox-write-rate-limit`.
Gaps this pass targeted: input direction of the terminal stream, body-read
deadlines, exec timeout classification, output-cap boundaries, browser stale
responses, repeated-lifecycle retention, capacity-sampler evidence.

## 4. Defects found and fixed

| # | Defect | Class | Fix | Evidence |
|---|---|---|---|---|
| D1 | **Student input had no backpressure.** node-pty queues every write a non-reading shell has not taken; the terminal and sandboxd wrote each `input` frame straight in. Probed: node-pty 1.1.0 behind `sleep 30`, 60 000 frames → 469 MiB retained, nothing refused. One client could grow the shared relays (terminal container is capped at 512 MiB) and take every student's shell down. | resource leak / backpressure | Existing flow control reused with roles swapped: pending shell input pauses the source socket, hop by hop to the browser; hard limit closes only that connection (`input_backlog` security event). | PROVEN BY TEST `input-backpressure.test.ts` (64 MiB queued before, bounded after); `pty-input-queue-integration.test.ts` pins node-pty's queue against a real PTY (MEASURED LOCALLY on macOS and Linux; wired into `make test-terminal-container` for CI) |
| D2 | **Runtime-broker calls had no deadline on the body.** Both broker clients cleared the timer at the response headers; over the plaintext same-host transport (`fetch` resolves at headers) a broker stalling mid-reply hung Start/Check/Reset or a reaper sweep — and a hung sweep stalls every later one. | timeout | Deadline armed until the body is read; "did not answer in time". | PROVEN BY TEST `broker-call-deadline.test.ts` (3 hang before) |
| D3 | **Same shape in four more clients.** Terminal credential exchange (a hang blocks that session's attach queue: the student can never reconnect until the terminal restarts); api workspace read inside a Check (holds `checksInFlight`: every later Check → 409 `CHECK_IN_PROGRESS` until api restart); OIDC discovery and token exchange (hang a sign-in). | timeout | Same fix. | PROVEN BY TEST `credentials-deadline.test.ts`, `internal-fetch-deadline.test.ts` (4 hang before) |
| D4 | **A Verify outliving its lab blocked and overwrote the next one (browser).** A boolean in-flight flag silently ignored every Verify on the relaunched lab until the old check answered; the old check's late 409 refreshed the *old* session, whose ENDED copy replaced the running lab on the page permanently. | stale response / generation | In-flight marker is the session id; late check answers and refreshes apply only while the page shows their session. | PROVEN BY TEST `workspace.test.tsx` "a Verify still running from the ended lab…" |
| D5 | **A `docker exec` stopped at its time limit read as exit 0.** MEASURED LOCALLY: Docker CLI 28.4.0 catches SIGTERM and exits 0, so `execFile` reports no error. Every runner read only the error: a hung `script_runs` / `command_exit_code` expecting 0 **passed**; sandboxd read a runtime that did not answer as "no such sandbox". | timeout / false result | `execFileOutcome(error, child)` treats a Node-killed child as timed out (exit 124), except the output-cap kill. Wired into container runtime, kind, docker CLI and sandboxd inspector. | PROVEN BY TEST `container-runtime-boundary.test.ts` (unit, on the outcome function); runner wiring REVIEWED |
| D6 | *Not a defect:* repeated lifecycles left no retained state — see §6. | — | churn test added | test passes on this branch (not run on the base) |
| D7 | **The capacity sampler could not see a run that did not fit.** It recorded load, available memory and peaks, but not container OOM kills, pressure stall or inode headroom. | capacity tooling | Adds PSI (cpu/memory/io), Docker-root free inodes, cumulative OOM kills (`docker events --until`, read-only) and `oom.csv`; summary prints them; still no thresholds. | `scripts/test-production-host-scripts.sh` (53 cases, 0 failed; 2 new scenarios, not run against the old script — the columns did not exist) |
| D8 | **A sandbox file over the 64 KiB read cap came back with no content.** `cat` stopped at `maxBuffer` looked like a failed `cat`; the designed truncated read was unreachable: a large `terraform.tfstate` read as "no state". | I/O boundary | Runner reports `outputTruncated`; the read returns the first 64 KiB marked truncated. Fake runtime now models the cap as execFile applies it. | PROVEN BY TEST `container-provider.test.ts` |
| D9 | **Docker engine caches grew for the life of the api** (`forget()` existed, never called). | collection growth | Called once the sandbox is verifiably gone. | PROVEN BY TEST `docker-provider.test.ts` |

## 5. Findings by area

**Timeouts** — every outbound HTTP call now has a deadline covering the body
(broker ×2, terminal credentials and activity, api workspace and terminal control,
OIDC ×2; `terminal-control` never reads a body; `activity` was already correct;
the TLS broker transport buffers before resolving). Kubernetes: 30 s per request
(prior pass). PostgreSQL: 5 s connect, 10 s server-side `statement_timeout`;
**no client-side `query_timeout` or TCP keepalive** — a network partition mid-query
would hang the request (residual; same-host deployment makes it unlikely).
Execs: bounded, and now classified correctly (D5).

**Cancellation** — a disconnected browser does not cancel an in-flight Check
or Start on the server (no `AbortSignal` from the request); the Check fence and
start/reset claims make the late result harmless (prior pass), and every step is
time-bounded. A timed-out exec's **process keeps running inside the student's
container** (MEASURED LOCALLY: `sleep 500` alive after the client ended); it is
bounded by that sandbox's own `--pids-limit 512`/memory, and each Check with a
hung script adds one. Not fixed: killing it needs an in-container `timeout`
wrapper whose availability varies per sandbox image (lab/verifier owner).

**Retries** — reviewed web, terminal, api. No automatic retry of a
state-changing POST. The workspace's automatic terminal reconnect resets its
backoff on every successful connect, so a terminal that connects and then drops
with a transient code every time would be retried at ~1 Hz while the tab is open.
No realistic trigger was found (a shell that exits is `SHELL_EXITED`, never
retried); residual, low.

**Stale responses** — server: Check fence, fenced start/reset releases (prior).
Browser: D4 fixed; remaining low-likelihood races documented by the web audit
(an in-session `refreshSession` answering out of order for up to one poll; a
session-list refresh racing a launch, self-correcting).

**Terminal** — one shell per session (claims + per-session queue), supersede,
End during attach, reset reattach: covered by prior suites and re-exercised by
the churn test. Output and now input are flow-controlled. Trade-off of D1: while
a socket is paused (only after >1 MiB of unread input), the server does not
notice the client leaving until the shell writes or the 30-minute idle timer.
Pre-auth sockets are unbounded in number except by the 10 s auth grace and
nginx `worker_connections` (edge rate limiting is a deployment decision).

**Database concurrency** — `make test-db` on a private PostgreSQL 16 container
(port 55467): progress 117 passed / 3 skipped; session store 179 passed; api
persistence 20 passed with `--testTimeout=60000` (3 tests exceed the default 5 s
at load 70 and pass alone with more time). The known millisecond window between
the Check fence and `recordCheck` (prior report) is unchanged.

**Verifier resources** — reads 64 KiB, inspect 256 KiB, lists 200 entries /
depth 6, no symlink following, FIFOs refused before read (prior). Jenkinsfile
parsing on adversarial 64 KiB inputs: worst 258 ms at load ~70 (MEASURED
LOCALLY) — not a defect. `listSandboxFiles` buffers up to 4 MiB before the entry
cap and the Ansible exec port applies no output cap (4 MiB default) — bounded,
residual. No per-Check overall deadline; every step is bounded, the worst case is
the sum (minutes for Ansible). No global cap on concurrent Checks across sessions
(one per session).

**sandboxd** — `caller_gone` (prior), input flow (D1), inspector timeouts (D5).
Its shutdown never completes while shells are open (`server.close` waits on
upgraded sockets) so it always runs out Docker's stop timeout; shells die with
the process. Residual, low.

**Orchestrator** — partial-success cleanup: failed start destroys best-effort and
the reaper reclaims leftovers of finished sessions (prior); broker hangs now
bounded (D2).

**Health / readiness** — `/health` guards each dependency individually and
reports rather than failing; provider probes memoised 30 s, not single-flighted
(prior residual). No change.

**Restart recovery** — durable: session rows, attempts, progress. Ephemeral:
terminal and broker shells, check slots, engine caches. Reaper recovers
CREATING (10 min), ENDING (5 min), RESETTING (10 min) (prior). api SIGTERM waits
on in-flight requests without a bound; Docker's SIGKILL ends it and the reaper
recovers an interrupted Start. Terminal exits within 3 s.

**Memory / collections** — terminal maps, sandboxd maps: exercised by churn
(§6). api: `checksInFlight` (finally), rate limiter (MemoryStore resets per
window), browser-session store (swept), engine caches (D9). Reaper single-flight.

**Logging under load** — terminal logs per attach/close, never content
(`terminal-content-logging`); activity failures at most once per 30 s per socket;
runtime `inspect/list/ping` unlogged; new `input_backlog` event is per closed
connection. No change needed.

## 6. Stress, churn and long-run exercise

`services/terminal/test/lifecycle-churn.test.ts` — real api, terminal and sandboxd
in-process, fake runtime and PTYs. Five concurrent students each repeat: Start →
attach → second tab takes over → network drop → reconnect → (every third cycle)
Reset with shell reattach → End. Isolation is asserted every cycle (a student's
input reaches only their own PTY). After the run: terminal open shells 0,
sandboxd shells 0, every PTY killed, occupied slots 0, PTYs spawned = attaches +
reattaches.

| Run | Lifecycles | Attaches | Takeovers | Drops | Resets | PTYs | Result | Time |
|---|---|---|---|---|---|---|---|---|
| default (CI) | 30 | 90 | 30 | 30 | 10 | 100 | clean | ~2.5 s |
| `JTT_CHURN_CYCLES=40` | 200 | 600 | 200 | 200 | 67 | 667 | clean | ~14 s |

Laptop numbers; they detect leaks and retained state, not capacity.

Other stress runs: input flood 64 MiB per client (D1); output flood (existing
suite, still green).

## 7. Failure-injection matrix (additions to the prior matrix)

| Failure | Before | Now | Automated |
|---|---|---|---|
| Broker stalls after headers (Start/Check/Reset/sweep) | hangs forever | fails at the call deadline, `did not answer in time` | YES |
| api stalls after headers on credentials (attach) | attach queue for the session blocked until terminal restart | attach fails, student can reconnect | YES |
| terminal stalls after headers on workspace read (Check) | session's Check slot held forever | Check errors, slot released | YES |
| IdP stalls after headers (sign-in) | request hangs | sign-in fails at deadline | YES |
| Script / command hangs past its limit | exit 0 → can PASS | timed out → fails | YES (unit) |
| Runtime does not answer an attach inspect | "no such sandbox" | error | REVIEWED |
| Client floods input at a non-reading shell | relay memory grows unbounded | socket paused; hard limit closes that connection only | YES |
| Verify outlives End + relaunch (browser) | new lab's Verify ignored; page reverts to ended lab | isolated | YES |
| File larger than the read cap | read as no content | truncated prefix | YES |
| Container OOM-killed during a host rehearsal | invisible in sampler output | counted in `host.csv`, named in `oom.csv` | YES (script tests) |

## 8. Tests added

`services/terminal/test/input-backpressure.test.ts`,
`services/terminal/test/pty-input-queue-integration.test.ts` (gated),
`services/terminal/test/credentials-deadline.test.ts`,
`services/terminal/test/lifecycle-churn.test.ts`,
`services/lab-orchestrator/test/broker-call-deadline.test.ts`,
`apps/api/test/internal-fetch-deadline.test.ts`; new cases in
`output-flow.test.ts`, `container-runtime-boundary.test.ts`,
`container-provider.test.ts`, `docker-provider.test.ts`, `apps/web/test/workspace.test.tsx`,
`scripts/test-production-host-scripts.sh`.

## 9. Validation executed

See §13.

## 10. Skipped / not run, and why

- Kubernetes (kind) integration, network-policy enforcement, docker/sandbox
  integration suites and Playwright E2E: need the shared kind cluster / sandbox
  images / a full stack; the machine was saturated by other worktrees (Docker
  `image ls` took >2 min). Not run; not claimed.
- `make test-terminal-container` / `test-sandboxd-container`: need kind. The new
  real-PTY test was run on macOS and on Linux (the terminal test image, built
  under a private tag and removed afterwards, strict runner: 2 passed).
- `make beta-validate` (five-student harness): needs a full stack; REAL HOST item.

## 11. Residual risks

1. Timed-out exec processes stay alive inside the student's container (bounded by
   its pids/memory limits).
2. No client-side PostgreSQL query timeout / keepalive.
3. No per-Check overall deadline; no global concurrent-Check cap.
4. Pre-auth terminal sockets bounded only by the auth grace period and nginx.
5. Terminal auto-reconnect resets its backoff on each successful connect.
6. sandboxd shutdown waits out Docker's stop timeout.
7. A paused (input-flooded) socket's disconnect is noticed only at the next
   output or the 30-minute idle timeout.
8. Fence → `recordCheck` millisecond window (prior report).
9. Provider probes not single-flighted (prior report).

## 12. Real-host evidence still required (not fabricated here)

- CPU, memory, swap, disk and inode use with five concurrent students on the
  chosen host (`make host-capacity-sample`, now including OOM kills and PSI).
- Real container density, sandbox start latency per provider, Check latency,
  terminal echo latency, api p95 under five students.
- `make beta-validate` on the host (five students, soak, api restart, cleanup).
- Behaviour of the production Docker CLI version on exec timeout (D5 was
  measured on 28.4.0; the fix is correct either way).
- Network partition behaviour between api, sandboxd and PostgreSQL; real DNS/TLS.
- Any cloud-provider behaviour.

## 13. Validation results

Final run, on the branch head before this report (load average 30–70):

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `npm test` | exit 0 — api 671 passed / 15 skipped; web 260 passed; lab-orchestrator 1383 passed / 253 skipped; observability 924 / 38 skipped; progress 96 / 1 skipped; sandboxd 148 / 7 skipped; terminal 185 / 22 skipped; verifier 1810 passed. **5477 passed, 0 failed**; skips are integration suites gated on infrastructure |
| `npm run test:security` | exit 0 — 259 + 112 + 82 + 208 + 8 + 195 + 10 = **874 passed**, 0 failed |
| `make test-db` (private PostgreSQL 16, port 55467) | progress 117 passed / 3 skipped; session store 179 passed; api persistence 20 passed with `--testTimeout=60000` (default 5 s run: 1–3 load timeouts, pass alone) |
| `bash scripts/test-production-host-scripts.sh` | 53 cases, 0 failed assertions |
| real-PTY `pty-input-queue-integration` | macOS 2 passed; Linux (test image, strict) 2 passed |
| `lifecycle-churn` with `JTT_CHURN_CYCLES=40` | 200 lifecycles clean |
| `git diff --check` | clean |

During the run, individual suites (`catalog-validation`, `line-value`) timed out at
vitest's 5 s default when the machine was at load ~72 and passed when re-run alone;
they are unrelated to these changes and passed in the final full run.
