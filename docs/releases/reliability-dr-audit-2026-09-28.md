# Reliability, disaster-recovery and incident-response audit — 2026-09-28

Question: can JumpToTech Labs survive realistic production failures without
losing student data, leaving unsafe runtime residue, or making the founder
reverse-engineer the system during an outage?

The durable operator reference this audit produced is
[../reliability-failure-model.md](../reliability-failure-model.md) (failure
domains, journeys, failure matrix, RPO/RTO, restart order, retention). This file
is the evidence.

## A. Baseline

- `origin/main` at start: **`bcaf902`** (SEC-ARCH-2 2/2, #123). Main moved during
  the audit (peers merged #122, #124, #125, #131, #134, #137, #140, #142, #150,
  #151, #152); every PR here was re-verified on the main it targeted.
- Environment: disposable compose stack `jtt-rel` (base + runtime + e2e
  overlay: real api, terminal, sandboxd, web/nginx, PostgreSQL 16, a loopback
  test identity provider; Linux track through sandboxd). Owner-labelled, own
  ports, own volume. No production data, credentials, DNS or paid
  infrastructure. Peers' stacks and kind clusters were not touched.
- **Host load.** A 10-CPU, 16 GB laptop running several other stacks at a load
  average of **35–63** for the whole audit. It shaped every timing: api cold
  start 290–650 s, PostgreSQL new-connection latency up to 9 s, `docker rm` 13–38 s,
  one reaper sweep 250–290 s. Numbers below are upper bounds.

Scope split agreed with the concurrent production-readiness session: it owns the
production compose overlays, config/preflight checks, TLS/nginx, image pinning,
the deployment runbook and the migrator; this audit sent it evidence instead of
editing those.

## B. Architecture and failure domains

See [reliability-failure-model.md §1–2](../reliability-failure-model.md). One
host; PostgreSQL is the only durable state; api, terminal and sandboxd hold
nothing that survives a restart except through PostgreSQL rows and container
labels; lab containers are disposable and run `--restart no`; the identity
provider is the one external runtime dependency; backups leave the host only
through `BACKUP_COPY_HOOK` (destination: decision D7).

## C. Failure tests performed

| # | Scenario | Expected | Actual | Result | Recovery time |
|---|---|---|---|---|---|
| 1 | api re-created (deploy) while a Start provisions — **old code** | student can start again soon | row stuck `CREATING`; every Start 429 "you already have a lab"; released by the 10-min abandoned-start grace | **FAIL** → #147 | 721 s lock-out |
| 1b | same, **with #147** | in-flight Start handed over at SIGTERM | row already `EXPIRING` when the new api listened; torn down at the first successful sweep, labelled `abandoned_start`; nothing leaked | PASS (bound fixed; wall clock masked by host load, see #147) | 759 s here, of which ~5 min api cold start and one sweep lost to DB timeouts |
| 2 | Identity provider stopped — **old code** | signed-in unaffected; new sign-in says "provider unavailable" | signed-in fine; api restarted during outage answered **503 `AUTH_MISCONFIGURED`**, no log, no metric, no alert possible | **FAIL** → #148 | provider back → sign-in in 8 s |
| 2b | same, **with #148** | | 503 `AUTH_PROVIDER_UNAVAILABLE`, `Retry-After: 60`, `jtt_auth_login_total{outcome="provider_unavailable"}`, logged | PASS | 7 s |
| 3 | PostgreSQL stopped 64 s, api running | fail safely, recover alone | every call 503 `AUTH_UNAVAILABLE` ("you are still signed in"); lab untouched | PASS | 12 s after DB back, no api restart |
| 4 | PostgreSQL stopped, api restarted meanwhile | fail fast, restart policy retries | api exits 1 at migration (code); in the drill its cold start outlasted the outage | PASS (by code; timing not isolated) | ≤ one api cold start after DB back |
| 5 | sandboxd stopped during Start | fail fast, no leak | 503 `SESSION_PROVISION_FAILED` in 20 s, FAILED, slot freed, retry `PROVIDER_UNAVAILABLE`; nothing left | PASS | start again 170 s after sandboxd returned (its own cold start) |
| 6 | sandboxd stopped during End | no leak, finishes later | 503 `DESTROY_FAILED`, ENDING holds slot; End again → ENDED; nothing left | PASS (5-min wait if the student does not press End again) | 114 s |
| 7 | sandboxd stopped during Reset | recoverable | 503 `RESET_FAILED`, DEGRADED; Reset again → ACTIVE | PASS | 143 s |
| 8 | terminal SIGTERM with a shell open | reattach, work survives | close 1006; 502 until back; old token reattaches; file and background job survive | PASS | 165 s |
| 9 | terminal SIGKILL | same | same; the pre-crash shell stays alive in the sandbox until session end (known residual) | PASS | 183 s |
| 10 | Bad release: api with `MAX_ACTIVE_SESSIONS=five` | deploy stops, old version keeps serving | `up --wait` fails after 210 s with the cause in the log; **old version already stopped** → 502 for students | PARTIAL (detected; no zero-downtime) | 424 s total outage incl. 213 s rollback |
| 11 | PostgreSQL disk full (relation extend) | fail clearly, no corruption | ERROR "could not extend file"; server up; `pg_dump` fails "No space left"; data intact after freeing | PASS | immediate after freeing |
| 12 | PostgreSQL disk full (WAL) | as 11 | PANIC; recovery also cannot write WAL; server exits | PARTIAL (no corruption observed; recovery after freeing not re-verified) | until an operator frees space |
| 13 | Database volume lost → restore by runbook §7.1 — **old code** | restore succeeds | `up --wait postgres` healthy while the image's initialiser ran; restore failed "database system is shutting down" (safely) | **FAIL** → #157 | — |
| 13b | same, **with #157** | | healthy only when really ready; verify, check-restore, `--replace`, api, validation all PASS; counts identical to archive; pre-backup sign-ins valid; surviving lab usable | PASS | **RTO 344 s** |
| 14 | Host restart with two running labs | platform returns; labs recoverable | platform back in 372 s; lab containers stay stopped under ACTIVE rows; Check `ENVIRONMENT_UNREACHABLE`; unreconciled until idle expiry | **FAIL** → #159 | Reset/End work at once |
| 14b | container stopped under an ACTIVE session, **with #159** | reconciled without deletion | DEGRADED after 81 s (two sweeps); Reset → ACTIVE, Check 200, End | PASS | 81 s |
| 15 | Restore drill (`make db-restore-drill`) | backup, destroy, restore, fingerprint | passed incl. truncated/corrupted refusal and re-created-DB refusal | PASS | 416 s total, `--replace` 30 s |
| 16 | Corrupt / truncated / non-application archive | refused before any change | refused (drill step 7, and the backup/restore harness: 174 cases with #157) | PASS | — |
| 17 | Postgres readiness race, isolated | | socket-ready +58.5 s (initialiser), gone +61.5 s, TCP-ready +64.7 s | evidence for #157 | — |

Not run, with reason: Docker daemon restart (shared by every peer session on
this host; the final beta audit covered daemon reconnect), memory/OOM injection
(host already at its limit; RB-19 and `HostMemory*` alerts reviewed), partial
deployment (compose builds and deploys every service from one checkout; the
realistic partial case — a failed rollout of one service — is test 10), CPU
saturation as an injected fault (the host was saturated for the whole audit;
its effects are the timings above).

## D. Reliability bugs found

| Severity | Bug | Evidence | Student impact |
|---|---|---|---|
| High | A deploy/restart during a Start locked the student out for ~10 min | test 1 | "Preparing…" then "you already have a lab" after any restart that met a Start |
| High | Restore onto a new volume raced the image's initialiser; the compose healthcheck lied during first init | tests 13, 17 | the DR procedure failed at the worst moment (safely, but confusingly); also first-boot api could migrate against a vanishing server |
| Medium | After a host restart every running lab stayed ACTIVE on a stopped container until idle expiry | test 14 | dead terminal, Check errors, slot held ~20 min unless the student pressed Reset/End |
| Medium | Identity-provider outage reported as `AUTH_MISCONFIGURED`, never logged or counted; no alert possible | test 2 | new students could not sign in with nothing telling the operator why |
| Medium | Terminal failures logged as `info` `terminal.connection.opened` | code, found during tests 8–9 | slower diagnosis of terminal incidents |
| Low | The auth router's logger was never wired (every line it writes was dropped) | test 2 | slower diagnosis |
| Low | No dashboard view of the indicators against their objectives | review | — |
| Info | No blue/green: a failed release is an outage until rollback; config errors surface only after the cold start | test 10 | 424 s outage in the drill; `production-config-check` before `up` prevents the config class (already in the deployment runbook) |
| Info | api cold start (tsx at boot) dominates every RTO | tests 1, 4, 10, 13, 14 | minutes of outage per restart on a loaded host |
| Info | End during a sandboxd outage waits 5 min for the reaper unless the student presses End again, while the web says not to | test 6 | a slot held up to 5 min |
| Info | Dev-image api healthcheck (3 s) flaps under host load while the api serves | tests 1, 10, 13 | spurious `up --wait` failures on a loaded host |

## E. Fixes

- **#147** — the stopping api refuses new Starts/Resets (as `LAB_LAUNCHES_PAUSED` / not ready, not counted as failures) and hands its in-flight Starts (→ EXPIRING, abandoned-start reason) and Resets (→ DEGRADED) to the reaper, each write fenced on the operation's own claim.
- **#148** — `AUTH_PROVIDER_UNAVAILABLE` (503, Retry-After) for provider outages; login and callback outcomes counted; auth router logger wired; alert `IdentityProviderUnreachable` → RB-14 §0.
- **#149** — incident management: severity, roles, lifecycle, status and classroom messages, postmortem template.
- **#157** — PostgreSQL healthcheck over TCP; `db-backup.sh`/`db-restore.sh` wait (bounded) for the real server.
- **#158** — dashboard row 0: indicators against objectives.
- **#159** — reaper marks ACTIVE sessions whose container the runtime reports stopped as DEGRADED (two sweeps, grace, fenced, never deletes); `sandbox_lost` recovery metric; RB-05 and DR §4.1 corrected from measurement.
- **#160** — terminal log lines carry their real event and level.
- Docs: [reliability-failure-model.md](../reliability-failure-model.md) and this report.

## F. PRs

| PR | Title | CI | Merge commit |
|---|---|---|---|
| #147 | fix(sessions): a stopping api hands its in-flight starts and resets to the reaper | green | `a936cb5` |
| #148 | fix(auth): report an identity-provider outage as one, and alert on it | green | `5355116` |
| #149 | docs(ops): incident management — severity, roles, messages, postmortem | green | `6ab32d9` |
| #157 | fix(db): wait for the real PostgreSQL server, not the image's initialiser | see PR | see PR |
| #158 | feat(observability): show the beta service indicators against their objectives | see PR | see PR |
| #159 | fix(reaper): an ACTIVE session whose container stopped becomes DEGRADED | see PR | see PR |
| #160 | fix(terminal): log failures as failures, under their own events | see PR | see PR |

(#149 was merged while GitHub showed its mergeability as UNKNOWN, seconds after
it had shown MERGEABLE/CLEAN and #147 landed; docs-only, no overlap.)

## G. Backup — **PASS** (with the D7 caveat)

`db-backup.sh`: custom-format dump inside the server's container, full read-back
(`pg_restore --file=/dev/null`), SHA-256 on both sides, atomic rename, lock,
retention after success, status file for monitoring, refusal to back up a
re-created database. Measured 15–24 s for a 35 KB database; a transaction
snapshot (`pg_dump`), no pause or volume snapshot needed. **Not yet a disaster
recovery strategy until the off-host copy exists** (decision D7): today the
archives sit on the same host.

## H. Restore — **PASS**

Runbook §7.1 end to end on the stack after #157; the restore drill; corrupt and
truncated archives refused. Measured: verify 9–11 s, `--into` 26–28 s,
`--replace` 21–48 s (35 KB); drill `--replace` 30 s. Production-size restore is
unmeasured.

## I. RPO / RTO evidence (measured only)

- RPO: the drill lost exactly what was written after its archive (one student's
  sign-in and attempt, 112 s of activity). Production RPO = time since the last
  successful, off-host archive: up to 24 h with the daily cron, unbounded if the
  job fails silently and nobody receives `BackupStale`.
- RTO: database lost **344 s**; bad release **424 s**; host restart **372 s**;
  end-to-end restore drill 416 s. All dominated by the api cold start on this host.
- Targets (24 h / 4 h proposed) remain an operator decision.

## J. Alerting — what wakes the operator

17 critical alerts, grouped by service, critical repeated hourly, with
inhibition so a database outage does not also page every downstream symptom.
The ones that mean students are blocked: `ServiceDown` (derived detection ≈ 3
min), `DatabaseDown` (≈ 2 min; measured firing at +75 s in IE-1),
`SandboxdRuntimeDown`, `LabStartsFailingHard`, `CapacityExhausted`,
`ReaperStalled`, `DatabaseRecreatedSinceLastBackup`, `BackupMissedTwice`,
`TlsCertificateExpiresWithin7Days`. New: `IdentityProviderUnreachable`
(warning). Every alert links a runbook (enforced by `alerts.test.ts`).

**Nothing wakes anyone until the Alertmanager webhook destination is configured**
(`alertmanager/secrets/webhook-url`; decision D6) — `AlertNotificationsFailing`
covers a broken destination, not a missing one.

Gaps: no signal for "time since the last restore test" (the weekly verification
is a read-back, not a restore); per-student fairness is not alerted.

## K. Incident response

[incident-management.md](../runbooks/incident-management.md) (new): SEV-1/2/3,
three roles one person may hold, the nine-step lifecycle mapped to existing
commands, status templates, classroom messages, postmortem template. Drills run
as the "new operator" (runbook only): database loss §7.1 (found #157; otherwise
followed without reading source), bad release rollback, host restart (DR §4.1
rows were unmeasured guesses; corrected in #159), sandboxd and terminal restarts
(incident-response §J/K). Existing diagnostics (`ops status`,
`make private-beta-diagnostics` with its redaction leak gate in CI) cover the
one-command snapshot and support bundle.

## L. Remaining risks

**Blocks the five-student private beta**
- Off-host backup destination and encryption (D7) — a host loss today loses every backup with it.
- An alert destination (D6) — the alerts exist, nobody receives them.
- One real-host run of the recovery drills (production-host readiness §17), because every timing here comes from an overloaded laptop.

**Can wait until public release**
- Zero-downtime deploys (a second api during rollout) and immutable, tagged release images for exact rollback.
- Precompiled api/terminal/sandboxd images (cold start dominates RTO).
- Restore-test age as a monitored signal; production-size restore timing.
- Request-id correlation across nginx → api → terminal → sandboxd (nginx does not log one; the terminal carries none).
- Browser-side timeouts on API calls and a WebSocket pong watchdog.
- A deadline for a whole reaper sweep (observed 250–290 s under load).
- End during a runtime outage: finish sooner than the 5-min abandoned-end grace.

**Future scale**
- HA or managed PostgreSQL with WAL archiving (point-in-time recovery).
- Multi-host failover; on-call rotation; long-term log and metric storage.

## M. Private beta verdict — **CONDITIONAL PASS**

Backup works, restore works (and is now reliable on a fresh volume), critical
failures are detected by alerts that link runbooks, every tested restart
recovered without manual repair of state, nothing leaked a sandbox or network in
any drill, and the failure modes are written down. Conditional on the three
blockers in L: an off-host backup copy, an alert destination, and one real-host
drill run.

## N. Public commercial verdict — **NOT READY**

Before selling to untrusted public customers: zero-downtime deployment and
immutable release artefacts; off-host, encrypted, access-controlled backups with
a tested, timed restore at production size and a monitored restore-test age; HA
or managed PostgreSQL with point-in-time recovery; an on-call rotation with
paging; end-to-end request correlation; long-term logs and metrics under a
decided retention policy; multi-host capacity so one host failure is not a full
outage.
