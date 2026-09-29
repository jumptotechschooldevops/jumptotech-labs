# Observability and incident-response audit — 2026-09-28

**Question:** when JumpToTech Labs breaks during a real class, does the operator
detect it quickly, know what failed and who is affected, receive a useful
alert, have enough to diagnose it, recover safely, and prove recovery?

**Base:** origin/main `74ea285` at start, `f98e897` at the end.
**Where:** a disposable local stack (`jtt-obs`, the E2E overlay: OIDC sign-in,
capacity 5, per-student 1), scraped by the repository's own `prometheus.yml`,
rules and `alertmanager.yml`, with a local webhook sink as the receiver. A
laptop shared with other sessions: host load 20–40, and the Docker VM at up to
242 on 10 CPUs. **Every duration here is an upper bound from a starved machine,
not a production measurement.** Nothing here was run on the beta host.

Scope was observability, alerting, logging, correlation, health semantics and
self-healing. Security, isolation, capacity, lab content, DR and UX have their
own records and were not repeated.

---

## Verdicts

| | Verdict |
|---|---|
| **Observability** | **Good after the fixes below, not before.** The metric and alert design was already broad (64 alerts, SLI dashboard rows, readiness gauges, correlation ids). What the drills found was that the *reporting path itself* broke under load or a hung dependency: slow scrapes made working services page as down, and three silent log paths hid the cause of real failures. |
| **Incident response** | **Ready for five trusted students on a watched host**, conditional on the PRs below merging and on a real alert destination (still DECISION REQUIRED). The runbooks are thorough; they now carry what the drills measured. |

---

## Failure drills

Detection times are from injection to the notification reaching the webhook
sink, and include Alertmanager's 30 s `group_wait`.

| # | Injected | Detected by | Student effect | Recovery | Verified by |
|---|---|---|---|---|---|
| D1 | api stopped | `ServiceDown{api}` at 2 m 34 s | site loads; every `/api` and `/auth` call 502 | `docker start`: scraped and ready 4 m 35 s later | `up`, `jtt_readyz_ok`, `/api/labs` 401 (auth required, i.e. serving) |
| D2 | terminal stopped | `ServiceDown{terminal}` at 2 m 49 s | Start works; the terminal WebSocket 502s at once (nginx: *terminal could not be resolved*) | `docker start`: ready in 1 m 35 s | `ready terminal 9401` |
| D3 | sandboxd **paused** (hung), fixed build | `ServiceDown{sandboxd}` at 3 m; the api **stayed up**. On the unfixed build the api's own scrape waits on the broker (proven by #181's tests, which hang on main) | Start spins and fails at ~310 s (`SESSION_PROVISION_FAILED`: the broker's timeout is 120 s per call) | unpause: scraped, a clean sweep, leak 0 within 23 s | `jtt:reaper_seconds_since_success`, `jtt:sandbox_leak:count` |
| D4a | PostgreSQL stopped | `jtt_db_up` 0 in 15 s; `DatabaseDown` | sign-in and every signed-in request 503 `AUTH_UNAVAILABLE`; running terminals keep working | `docker start`: ready in 7 s, no api restart | `jtt_db_up`, `jtt_readyz_ok` |
| D4b | PostgreSQL **paused** (hung), fixed build | `DatabaseDown` at 2 m, `ServiceNotReady` suppressed under it; api scrapes stayed 3–5 s | sign-in fails in ~12 s, and the log now says why (*not an identity-provider error … connection timeout*) | unpause: ready in 20 s | as D4a |
| D5 | none needed — three natural start failures (Docker address pools exhausted on this laptop) | `LabStartsFailingHard` 3–4 min after the failures | `503 SESSION_PROVISION_FAILED` | networking labs cannot start until networks are freed | `lab.start.failed` → `session.transition` by `requestId`, two greps |
| D6 | api paused 60 s during a terminal attach | nothing fired — correctly | the terminal opened after 67 s instead of ~13 s | self-healed | attach succeeded, no failure counted |
| D7 | sandboxd paused while a student pressed End | `ServiceDown{sandboxd}` | End took 120 s, answered `DESTROY_FAILED`, *cleanup keeps retrying* | reaper finished the teardown 2 m 16 s after unpause | session `ENDED`, 0 containers, leak 0 |
| D8 | a sixth student at capacity 5 | `CapacityExhausted` at ~2 m 45 s | `503 LAB_CAPACITY_REACHED` | — | utilization 1.0 |
| D9 | host CPU (no injection needed: load 26× CPUs) | `HostCpuSaturated`, once scrapes were reliable | everything slow | — | `jtt:host_load5_per_cpu:ratio` |
| D10 | api, terminal and sandboxd restarted / re-created | `ServiceDown` per service while they start | as D1/D2 | 8–14 min cold start at load 20 | `up` |
| Final | five-student class; PostgreSQL stopped 150 s mid-class | **one** page, `DatabaseDown` at 1 m 37 s (the new inhibitions held) | Check, Reset, reconnect and End 503 `AUTH_UNAVAILABLE`, each logged with its cause | four sessions left ACTIVE by the refused Ends: `ops sessions` listed them, `ops end` freed them | a second class after: 5/5 started, 5/5 attached, 5/5 Checks answered, sixth refused, End left 0 containers; 4/5 Resets failed under load (below) |

Alert delivery (routing, the heartbeat route, inhibition, resolution) was
exercised end to end through the sink. Delivery to a **real** destination was
not: see "What still needs the beta host".

---

## Defects found and fixed

Every one reproduced on the drill stack or pinned by a test that fails on main.

| PR | Defect | How it showed |
|---|---|---|
| #181 | Scrape-time collectors awaited the broker (120 s), the database (15 s) and `docker ps` (30 s) against a 10 s scrape timeout | With **no fault**: api scrape 33 s, sandboxd 31 s; `up==0` on 9/40 and 26/40 samples; `ServiceDown{sandboxd}` fired for a working service. A hung broker would page the api and its inhibition would hide `ProviderUnavailable`; a hung database would make `jtt_db_up` vanish so `DatabaseDown` never fired. Fixed: every collector bounded at 3 s, keeping its last value. After: api failures 9/40 → 2/40 at load 240, terminal 0/40; D3 and D4b attributed correctly |
| #180 | `ServiceRestartLoop` counted `changes(up)` | "sandboxd keeps restarting" delivered for a container with RestartCount 0. Now counts `jtt_process_start_time_seconds` changes |
| #186 | Duplicate pages for one cause | Failed starts paged `LabStartsFailingHard` **and** `LabStartFailureRateElevated`; a hung broker paged `ServiceDown` **and** `ReaperStalled`; a database outage `DatabaseDown` **and** `ReaperStalled` and `ApiLatencyHigh`. Three inhibit rules |
| #179 | A failed OIDC callback logged nothing but the access line | Four students got 401 on sign-in; nothing said why. Now `auth.callback.failed` names the step, and says when the user store (PostgreSQL), not the identity provider, failed |
| #184 | sandboxd logged runtime refusals nowhere | Docker's *address pools fully subnetted* failed three starts; sandboxd, which received it, wrote nothing — only a `refused` count |
| #172 | Audit and failure lines lacked the ids operators search by | every browser `authz.decision` said `requestId: req-unknown`; thrown Reset/End failures logged a bare `code`; `lab.start.failed` lacked the Support ID |
| #174 | A Docker-track data volume that failed to delete was swallowed, never retried | nothing else ever removes it; each holds a daemon image store. Now logged and counted (`outcome="volume_leaked"`); RB-05 §4f |
| #182 | The api image health check read the live `/health` with a 3 s timeout | a serving api went `unhealthy`; `up --wait` failed and web and terminal were never created. terminal and sandboxd flipped the same way. Now `/readyz`, 10 s |
| #185 | No alert on file descriptors | `ProcessFileDescriptorsHigh`: > 1000 for 15 m. `nofile` is 1,048,576 (measured), so a ratio can never fire; ~30 idle and 56 at a class peak |
| #189 | nginx's **error log** wrote the OIDC authorization code | with the api down: `request: "GET /auth/callback?code=…&state=…"`. P0-017 had fixed the access log only. `/auth/` now logs at `crit`; verified live |

The runbooks changed in this PR: `private-beta-incident-response.md` (B, C, J,
Q, §3) and `first-class.md` (the operator's screen during class).

---

## Sensitive data in logs

- **Found and fixed (#189):** the OIDC authorization code and `state` in nginx's
  error log whenever the api was unreachable. Low severity: single-use, 60 s,
  PKCE- and client-secret-bound — still a credential in `docker logs web`.
- **Checked and clean:** the logger's key allow-list, shape redaction (JWT,
  bearer, DSN, cookie, OAuth parameters, long hex/base64) and the boot
  self-test; the access log (`$uri` only); terminal tokens (a WebSocket frame,
  never a URL); the internal-secret header; error serialisation (no stacks).
- **Residual, not fixed:** startup failures and `migrate` print `error.message`
  through `console.error`, outside the redactor; no service installs an
  `uncaughtException` handler, so Node's default printer is unredacted; the
  reaper truncates a problem to 300 characters *before* redaction, which can cut
  a DSN before the part the pattern needs. No leak was observed through any of
  them.

## Health and readiness

- Liveness (`/livez`) checks nothing and nothing restarts on `unhealthy`, so no
  health check can cause a restart loop. Readiness gates only on what makes the
  instance unable to serve (catalogue, database; sandboxd: its runtime).
- **The api stays ready while every container-track start would fail** (broker
  unreachable). Deliberate (IE-2), and `ProviderUnavailable` plus
  `ServiceDown{sandboxd}` cover it — now reliably, since #181.
- **The terminal's readiness is blind** to the api and sandboxd (`checks: []`).
  D6 showed it self-heals a short api stall; a long one surfaces only as
  `TerminalConnectionFailures` after 10 minutes.
- **No proactive identity-provider check:** `IdentityProviderUnreachable` fires
  only when someone tries to sign in.

## Self-healing, as measured

| After | Recovers by itself? |
|---|---|
| a service crash | only with `restart: unless-stopped` (production); none in development |
| a PostgreSQL outage | yes: 7 s (stop/start) and 20 s (pause) after it returns, no api restart |
| a broker outage | yes: the reaper resumes and finishes pending Ends within minutes |
| a terminal outage | open shells drop; students reconnect once it is back |
| a refused End | **no**: the session stays ACTIVE until idle expiry (20 min) unless the student presses End again or the operator runs `ops end` |

## Correlation

Following one failing Start took two greps: `lab.start.failed` (now carrying
the Support ID) → its `requestId` → the api's `session.transition` line with the
provider's reason → sandboxd's `sandbox.runtime.op` lines for the same request.
What still breaks the chain: nginx neither logs nor sets a request id; the
terminal service establishes no context, so its calls to the api and sandboxd
carry none; reaper teardowns reach sandboxd with a fresh id and no session; and
session-manager and reaper lines carry the session only in message text.

---

## What still requires the real beta host

- **A real alert destination** and a real heartbeat check-in (DECISION REQUIRED,
  operations §8). Routing, grouping, inhibition and resolution were proven
  against a local sink only.
- Cold-start, detection and recovery times on the host's own CPUs.
- The `unhealthy` health-check behaviour under the host's load (#182).
- Docker's address-pool headroom with the real lab mix.
- Log rotation and the diagnostics bundle on the host's filesystem.

## Top operational risks remaining

1. **An intermittent broker socket reset** (`UND_ERR_SOCKET` during `create` or
   `exec`): three occurrences in these drills, failing one start and two resets.
   Correlation proves it is the api↔sandboxd hop; sandboxd logs nothing for it.
   Root cause unproven (as in the performance pass).
2. **A hung broker makes a student wait ~5 minutes** for a failed Start and 2
   minutes for an End: there is no overall deadline, only the broker's 120 s per
   call.
3. **No alert destination yet**: every alert above reaches nobody until one is
   installed.
4. **Docker address-pool exhaustion** fails networking labs with nothing
   measuring the host's network count; leaked per-session networks lead there.
5. **Refused Ends leave sessions holding slots** for up to the idle limit during
   a database outage — at capacity 5, that is the class.
