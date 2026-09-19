# Platform reliability pass — 2026-09-19

| | |
|---|---|
| **Branch** | `feat/reliability-overnight`, on `main` at `001bcf1` (PR #40 merged) |
| **Scope** | Session lifecycle concurrency, failure recovery, cleanup and resource leaks, timeouts, terminal and broker reliability |
| **Production host deployed?** | **No.** Nothing here ran against a production host, the shared kind cluster, or a real identity provider. |
| **Verdict** | Ready for review. **Not ready for student access** (the open decisions in [private-beta-operations.md §8](../runbooks/private-beta-operations.md) still stand). |

Evidence words, as in the earlier passes: **PROVEN BY AUTOMATED TEST** (a test in
this repository that fails on `001bcf1` and passes here, unless it says
otherwise), **PROVEN LOCALLY ONLY**, **REQUIRES REAL HOST**.

## 1. The lifecycle as it stands

Read from the code at `001bcf1`, not from older documents.

```text
browser ─► api: authenticate ─► session guard (lookup + ownership, one step)
              │
              ├─ Start  ─► provider probe (≤5 s) ─► admission (one transaction, advisory lock:
              │            global + per-student count, insert CREATING) ─► onAdmitted: attempt
              │            opened and bound ─► provider.create ─► CREATING→ACTIVE (conditional)
              ├─ Check  ─► requireActive ─► verifier reads (no claim) ─► fence ─► record
              ├─ Reset  ─► claim ACTIVE|DEGRADED→RESETTING ─► provider.reset ─► fenced release
              │            to ACTIVE (container: terminal reattach) or DEGRADED
              └─ End    ─► claim →ENDING ─► terminal terminate ─► destroy ─► ENDING→ENDED
                                                                            └─► attempt closed
reaper (every sweep, one at a time): expired/idle → EXPIRING→EXPIRED; ENDING > 5 min → finished
  as End; RESETTING > 10 min → DEGRADED; CREATING > 10 min → EXPIRED (new); orphans reclaimed.
terminal: token → API credentials (ownership re-checked) → PTY (local or via sandboxd)
```

- **Durable** (PostgreSQL): `lab_sessions` (status, `status_changed_at` fence,
  owner), attempts and progress, users, browser sessions.
- **Per process, ephemeral**: the api's `checksInFlight`; the terminal's
  socket↔session maps and (new) attach claims; sandboxd's shell maps;
  provider availability memo (30 s); engine caches.
- **Concurrency primitives**: every status change is one conditional write
  (`transition`, optionally fenced on `status_changed_at`); admission is one
  transaction under `pg_advisory_xact_lock`; attempt check/complete is
  `SELECT … FOR UPDATE`; activity writes only ACTIVE/RESETTING.

## 2. Defects found and fixed

Every defect was reproduced in a failing test before it was changed.

| # | Defect | Fix | Evidence |
|---|---|---|---|
| 1 | **A refused Start opened a FAILED attempt**, added to `attempt_count` and marked a lab the student never got into as in progress: a double-clicked Start, a retry, a second tab, trying a second lab at the per-student limit of 1, a full platform, a substrate down | `SessionManager.start` takes an `onAdmitted` hook, called only after admission; the route opens and binds the attempt there | `start-refusal-attempts.test.ts` (5 of 6 fail before), `session-admission-hook.test.ts`, the simulation below |
| 2 | **A database blip on a log line's occupancy read failed a Start that had succeeded**: 500 for a running lab holding the student's only slot | the read is best-effort | `session-start-store-failures.test.ts` |
| 3 | `SessionManager` kept a **never-read, never-cleared set** of every finished session id | removed | behaviour-neutral; orchestrator session suites |
| 4 | **Terminal: an attach in flight was invisible.** Two sockets attaching together both got a shell (one unreachable by End); a Terminate during an attach closed nothing and a shell opened anyway — each PTY lived 30 min | per-session attach claims revoked by `closeSession`; the newest attach wins; abandoned attaches count as `outcome="superseded"`, excluded from the failure-ratio alert | `broker-attach.test.ts` (5 fail before); promtool `terminal-alerts.test.yml` |
| 5 | **A Check overtaken by Reset or End recorded its verdict.** LINUX-001, check parked on its last read: after a Reset → PASSED with a completion for a freshly reset sandbox; after an End → the ENDED attempt rewritten to PASSED. (A removed container reads every path as absent.) | the route re-reads the row after verifying and records nothing unless it is still ACTIVE with the `status_changed_at` the check started from; 409 `SESSION_NOT_ACTIVE`, `verify.discarded` | `check-lifecycle-race.test.ts` (2 fail before) |
| 6 | **A start whose process died stayed CREATING** until idle expiry (20 min): a slot and the student's own held behind "Preparing…" with no action. Also a database blip on the CREATING→ACTIVE write | the reaper tears down a start still CREATING after 10 min (`abandoned_start`), recorded EXPIRED "the lab did not finish starting"; a slow live start discards its work | `session-recovery.test.ts` (shared, also run on PostgreSQL) |
| 7 | **The session guard answered any lookup failure as 404 and audited it `denied-not-owner`**: a DB blip told students their lab was gone (non-retryable in the UI) and fed `AuthzOwnershipDenialSpike` | only `SESSION_NOT_FOUND` is a 404; other failures reach the central handler (500, retryable) | `session-guard-store-failure.test.ts` |
| 8 | **sandboxd spawned `docker exec` for a caller that had left during the inspect** (terminal gives up at 15 s; inspect may take 15 s): a PTY and a broker slot for 30 min | re-check the socket after the inspect; `deny_reason="caller_gone"` | `server.test.ts` |
| 9 | **A reset's reattach wired the new shell to a closed socket** (tab closed or End during Reset) — a broker PTY for 30 min; and **after a failed reattach the socket stayed open around a dead shell**, so the workspace's automatic reconnect never ran | re-check after each wait; close 1011 after `SANDBOX_UNAVAILABLE` | `broker-attach.test.ts` |
| 11 | **An attach that lost deleted the winner's credentials**: kubeconfigs and Docker certificates were named by session id alone, so a second tab's losing attach removed the file the live shell used | per-attach file names | `credentials.test.ts`, `docker-credentials.test.ts`; found by an independent review of this branch |
| 10 | **Kubernetes API requests had no deadline.** A hung API server hung Start/Reset, pinned a session's Check lock forever, and stalled the reaper — for every provider | a per-request 30 s `AbortSignal` via the KubeConfig auth hook; surfaces as `ENVIRONMENT_UNREACHABLE` | `kubernetes-client-deadline.test.ts` (all hang before) |

Also: attach tests that asserted after fixed 50–120 ms sleeps across two
WebSocket hops now poll with a deadline, and one timing-positioned test uses a
gate.

**Five-student simulation** (`five-student-reliability-simulation.test.ts`):
six concurrent students, seeded action choice across every lifecycle operation
and cross-student probes, invariants checked after every step. Passes on three
seeds; fails on every seed with defect 1 restored. **PROVEN BY AUTOMATED TEST**
(in-process, fake runtime).

## 3. Failure-injection matrix

| Failure | Platform behaviour | Student sees | Cleanup | Operator signal | Automated | Real host needed |
|---|---|---|---|---|---|---|
| DB unavailable at Start admission | refused before anything is built | 500, retry | nothing to clean | `lab.start.failed` `platform_error`, `ApiErrorRate` | YES | YES |
| DB lost on CREATING→ACTIVE | start errors; row stays CREATING | 500, then "Preparing…" | reaper tears down at 10 min, sandbox removed | `abandoned_start` recovery, `SessionStuckProvisioning` if not | YES | YES |
| DB blip during a session request | 500, not "gone"; not audited as cross-student | retryable error | none | `http.request.failed` | YES | — |
| DB unavailable mid-Reset / mid-End | row left RESETTING / ENDING | error, lab busy | reaper: DEGRADED at 10 min / End finished at 5 min | recoveries, `SessionResetStuck`, `SessionTeardownStuck` | YES | YES |
| API restart mid-Start | row CREATING | "Preparing…" up to ~11 min | reaper, as above | `abandoned_start` | YES (simulated) | YES |
| API restart mid-Reset / mid-End | RESETTING / ENDING | busy overlay | reaper | recoveries | YES (simulated) | YES |
| Provider unavailable before Start | refused, no slot, no attempt | 503 "cannot be created right now" | none | `provider_unavailable`, RB-09 | YES | YES |
| Provider fails during provision | FAILED, best-effort destroy | 503 with remediation | reaper reclaims leftovers of finished sessions | `provision_failed`, RB-03 | YES | YES |
| Kubernetes API hangs | each request aborted at 30 s | Start/Check/Reset error after ≤30 s per call | reaper continues | `ENVIRONMENT_UNREACHABLE`, sweep errors | YES | YES |
| Verifier read fails | `error` verdict, nothing recorded | 503 "environment could not be read" | none | `verify.errored` | YES | — |
| Check overtaken by Reset/End | verdict discarded | 409 "try again" | none | `verify.discarded` | YES | — |
| Terminal service down | Start/Check/Reset/End unaffected; terminate best-effort | terminal disconnected, auto-reconnect | shells die with the service | `ServiceDown`, `TerminalConnectionFailures` | partly | YES |
| Terminal disconnect / tab closed | shell closed; attach or reattach in flight cancelled | reconnect on return | PTY closed, credentials removed | `jtt_terminal_connections_open` | YES | — |
| Second tab / reconnect race | newest attach wins | older tab "disconnected" | older PTY never opened or closed | `superseded` | YES | — |
| sandboxd slow / caller gives up | no PTY for a gone caller | reconnect | nothing held | `caller_gone` | YES | YES |
| Reattach fails after Reset | socket closed 1011 | auto-reconnect | old shell already gone | reattach log | YES | YES |
| Failed or partial cleanup | ENDING/EXPIRING keeps its slot until confirmed gone | "shutting down" | reaper retries every sweep | `SessionTeardownStuck`, `jtt_reaper_teardown_incomplete_total` | YES | YES |
| Capacity race / last slot | one transaction under an advisory lock | one admitted, others 503/429 | none | `capacity_reached`, `student_limit_reached` | YES (PostgreSQL too) | YES |
| Reset race (Reset+Reset, Reset+End) | one claim wins; loser discards or is refused | 409 for the loser | lost work discarded | log | YES | — |
| Stop race (End+End, End during Start) | one teardown records the end | 200 for both | idempotent destroy | `lab.end.*` | YES | — |
| Network-isolation gate fails | Start refused before admission; never ACTIVE | 503 naming the isolation check | none | attestation metrics, RB-18 | YES (PR #40) | YES |

## 4. Audited, no change needed

- Ownership: every session route goes through the guard; terminal credentials
  and activity re-prove the owner against the live row; cross-student access is
  an indistinguishable 404 (also exercised by the simulation).
- Start concurrency and capacity: admission atomic in memory and in
  PostgreSQL; refusals build nothing (`session-per-student-capacity`, the
  simulation, `test:db`).
- Reset/End/Start races, End idempotence, fenced reset releases: covered by
  `session-lifecycle-races` and `session-recovery`, both also on PostgreSQL.
- Timeouts elsewhere: broker HTTP and WebSocket calls, terminal→API fetches,
  container execs and the pre-Start probe are all bounded.
- API errors never carry a stack or driver text (central handler); malformed
  ids, lab ids and bodies are refused as 4xx (`request-body-errors`, guard).
- Existing concurrency tests (`check-concurrency`, lifecycle races) are
  gate-driven rather than timed.

## 5. Not fixed — follow-ups

| Item | Why not now |
|---|---|
| `DockerEngineFactory.forget()` is never called, so the Docker track's per-session engine caches grow for the life of the api (a few hundred bytes per session; names are HMAC-derived, so no reuse hazard) | negligible at beta scale; wiring it touches the ownership-gated destroy path |
| Provider availability probes are memoised but not single-flighted, and the catalog's probe is not time-bounded (now at most 30 s per Kubernetes call) | UX, not correctness |
| A container that is not running reads every path as absent (`readSandboxPath` treats a failed `stat` as absence). No lab today has only absence requirements, so no full false pass; 36 labs can show a misleading ✓ on a dead sandbox | verifier semantics; needs a runtime-state check on the absence path |
| The workspace offers no End on a CREATING session | web change; the reaper now bounds it at ~11 min, `ops end` is immediate |
| api SIGTERM waits for in-flight requests with no bound (Docker's 10 s SIGKILL ends it); a killed Start is recovered by defect 6's fix | behaviour already safe |
| A check's fence runs just before `recordCheck`, not in the same transaction: an End landing in those milliseconds can still mark a just-closed attempt PASSED (`recordCheck` sets PASSED unconditionally) | window reduced from seconds to milliseconds; closing it changes progress-service semantics |
| Another overnight branch (security red-team, off `001bcf1`) also changed the terminal attach path | not inspected, per the isolation rule; expect a conflict in `services/terminal/src/server.ts` at reconciliation |
| A resumed abandoned-start teardown that needed a second sweep is labelled `idle` rather than `abandoned` in teardown metrics | cosmetic |

## 6. Real-host reliability tests still required

- `make beta-validate` on the release host after merge (five students, soak,
  api restart, cleanup).
- Restart the api container during a Start on the real stack; confirm the
  student's lab shows EXPIRED "the lab did not finish starting" within ~11
  minutes and `abandoned_start` increments.
- `docker pause` the kind control plane during a Check and a sweep; confirm
  `ENVIRONMENT_UNREACHABLE` within 30 s and that container-track cleanup
  continues.
- Two browser tabs on one lab, and End pressed while the terminal is still
  connecting; confirm one PTY in `jtt_sandboxd_shells_open`.
- A container-track Reset with the tab closed mid-way; confirm no extra PTY.
