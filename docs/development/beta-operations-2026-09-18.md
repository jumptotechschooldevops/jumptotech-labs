# Private-beta operations pass — 2026-09-18

| | |
|---|---|
| **Branch** | `feat/beta-operations-overnight`, on `main` at `aadce77` (PR #39 merged) |
| **Scope** | Beta operations: operator status and support, diagnostics, incident response, safe operator tooling |
| **Production host deployed?** | **No.** Nothing here ran on a production host, a public DNS name, a real certificate, a real identity provider or a real alert receiver. |
| **Verdict** | Operator tooling ready for integration review. **Not ready for student access** (the open decisions in [private-beta-operations.md §8](../runbooks/private-beta-operations.md) still stand). |

Evidence words: **PROVEN BY AUTOMATED TEST** (a test in this repository, run
locally; CI runs on pull requests), **PROVEN LOCALLY ONLY** (run against a
local stack by hand), **REQUIRES REAL HOST**.

## 1. What an operator could not do before

Audit of the platform as merged (`aadce77`), against the questions an
instructor running five students has to answer:

| Question | Before | After |
|---|---|---|
| Who has a lab, which lab, since when, is it healthy? | Hand-written SQL against `lab_sessions` (RB-17) | `ops sessions` / `ops session <id>` |
| How many slots are used; can a new lab start? | Three PromQL queries; no single verdict | `ops status`: slots by status, and YES / DEGRADED / NO with every reason |
| Recover one broken student's lab | "The student presses End, or wait 20 minutes"; editing the row forbidden | `ops end <id> --yes`: the reaper's fenced teardown, recorded "ended by operator" |
| Stop new launches without killing labs | `LAB_LAUNCHES_PAUSED` existed; nothing reported a pause that was never lifted | plus `jtt_lab_launches_paused` and `LabLaunchesPaused` (RB-21) |
| Collect evidence without leaking secrets | Nothing; `docker logs` and `.env` were the evidence | `make private-beta-diagnostics`: one sanitized, self-checked archive |
| What to do, by symptom | Runbooks by alert (RB-01…RB-19) and an operations guide | plus [private-beta-incident-response.md](../runbooks/private-beta-incident-response.md), incidents A–U |

## 2. Defects found and fixed

Every defect was reproduced — against the real local stack, or in a failing
test — before it was changed.

| # | Defect | Found by | Fix | Evidence |
|---|---|---|---|---|
| 1 | **A start that died on the database was counted `provision_failed`**, so `LabStartsFailingHard` sent the operator to RB-03 (the sandbox substrate) for a PostgreSQL outage | reading the route | non-`SessionError` failures are `platform_error`; the log keeps the driver's code | api test fails on the old route |
| 2 | **A pause nobody lifted was a silent outage**: refused starts are deliberately not failures, so nothing fired | audit of the stop-launches switch | `jtt_lab_launches_paused`, `LabLaunchesPaused` (30 min), RB-21 | promtool: 20-min pause quiet, 31-min fires; api test reads the gauge |
| 3 | **The OIDC authorization code was written to the edge access log** on every sign-in (`$request` and `$http_referer` in nginx's stock format) | logging audit | `jtt_edge` log format: path without query, no referrer; every server block | `nginx -t` for both files in nginx:1.27-alpine; runtime: a `?code=` request logs as `GET /index.html`; contract test |
| 4 | **Tracks switched off by configuration made the operator verdict permanently DEGRADED** (AWS is off everywhere) | `ops status` on the real stack | the registry marks `enabled: false` as `disabled`; only enabled providers count | provider-registry and operator tests |
| 5 | **A slow api start was declared unhealthy**: 225 s to listen at load 20 against a 65 s (image) / 135 s (overlay) budget; `up --wait` failed and web/terminal, which wait for api health, were left uncreated | api re-create on the real stack | start period 300 s in both; a healthy start is reported as soon as before | the same re-create then passed `up --wait`; contract test |
| 6 | **A stopped api was killed, never shut down**: `npx` received SIGTERM and exited without passing it on; the reaper, listeners and database pool were never closed | `docker stop` on the real stack: exit 143, 4 s, no `process.stopping` | `node …/tsx` as the entrypoint, as sandboxd does | after: exit 0 in 1 s with `process.stopping`; contract test |
| 7 | **A Start while the substrate was down was a "failed provision"** that told the student to run `npm run sandbox:build`; the Kubernetes attestation refusal took the same path | stopping sandboxd on the real stack | `start()` consults the memoised availability probe first: `PROVIDER_UNAVAILABLE`, no row, no slot; the reason goes to the log | orchestrator and api tests |
| 8 | **The README's cleanup commands deleted every worktree's (or every student's) sandboxes**: `kubectl delete ns -l …managed=true` and `docker rm -f $(… managed=true)` without the runtime owner | command-safety audit | owner selector / `npm run sandbox:clean`; the owner test now reads the README and runbooks | test found the second command |

### 2.1 From an independent review of this branch

A second reader reviewed the branch without being told what it did; every
finding was reproduced before it was fixed.

| # | Defect in this branch | Fix |
|---|---|---|
| R1 | **A mistyped request on the operator socket could crash the api**: `new URL` threw on targets like `http://[` outside the handler's `try`, an unhandled rejection that exits Node 22 | parse inside the `try` (400), final catch on the handler; raw-socket test |
| R2 | **An end the operator did not do was logged as theirs**, and an idle expiry in flight was relabelled "ended by operator" | finished session: 409; teardown in flight keeps its reason and is reported as `existing_teardown` |
| R3 | **The query-string stripper was quadratic** (1.2 s at 32k) and ran before any length cap | last-segment prefix (linear); 8192-character cap first |
| R4 | **PostgreSQL's double-quoted values passed through** (`invalid input syntax …: "value"`) | only object names after their keyword are kept |
| R5 | **A container re-created mid-collection aborted the bundle** under `pipefail` | noted as gone |
| R6 | **`--out-dir` with `..` below a missing directory could land in the checkout** | refused |
| R7 | **The pre-start availability probe had no deadline, and a cached "down" outlived recovery** | 5 s bound (go ahead without it); a negative answer is re-probed before refusing |
| — | A malformed `%` escape in a session id was a 500 | 400 (found in self-review) |

## 3. Failure injection on a local stack — PROVEN LOCALLY ONLY

An isolated stack (`docker-compose.yml` + `docker-compose.runtime.yml` and a
scratch override: project `jtt-ops`, own ports, off the shared `kind` network,
development identity, Linux track, `MAX_ACTIVE_SESSIONS=2`), on a laptop whose
load average was 8–22 throughout because other stacks were running.

| Scenario | Result |
|---|---|
| Operator socket in the real container | `/tmp/jtt-operator` 0700 `node`, socket 0600; `ops status`/`sessions` work through `docker exec` |
| Capacity full / per-student limit | third student `LAB_CAPACITY_REACHED` (503); second lab for one student `STUDENT_SESSION_LIMIT_REACHED` |
| api re-created with two live labs | both sessions and both sandboxes survived; the socket came back with the new process |
| `ops end` on a live lab | container removed, row `EXPIRED` "ended by operator", the student's own view says so, the next student started in the freed slot; `end` without `--yes` refused |
| PostgreSQL stopped | `ops status`: database NOT READABLE, new labs NO; `/readyz` 503; students get 503 `AUTH_UNAVAILABLE` (sign-ins live in the database); the running sandbox kept running |
| PostgreSQL started again | `/readyz` 200 with **no** api restart; the next start succeeded |
| Terminal restarted under a live shell | the shell closed (1006) in 2 s; a new connection to the same session worked once healthy; the sandbox was untouched; the typed marker appeared in no service log |
| sandboxd stopped | the open shell ended cleanly (exit frame, 1000); `ops status` NO, "no enabled sandbox provider"; before fix 7 every Start was `SESSION_PROVISION_FAILED` with "npm run sandbox:build"; after it (re-verified on the final code) the first Start inside the probe's 30 s window still fails as a provision, and the next is `PROVIDER_UNAVAILABLE` "This lab's environment cannot be created right now"; after restart the session's terminal reconnected |
| Idle student | reclaimed at 20 minutes: `EXPIRED` "idle for more than 1200s", container gone, slot free |
| Stop-launches switch | Start 503 `LAB_LAUNCHES_PAUSED`; Reset and the live terminal kept working; gauge 1; no start outcome counted; lifted with `up -d api` |
| `docker stop` per service | sandboxd: exit 0, `process.stopping`. api: exit 143, no shutdown (fix 6), then exit 0. terminal: exit 1 with `kill EPERM` (§4) |
| Diagnostics bundle | 1m46s, 0600 archive, passed its own secret scan; sessions without owner ids; logs reduced to warnings/errors/lifecycle |
| Leaks after all of the above | sandbox containers = occupying sessions at every check; no lab network left behind |

## 4. Found and not changed

- **The terminal cannot shut itself down.** Its child process drops to the
  student uid; the tsx launcher (root, no `CAP_KILL`) cannot relay SIGTERM
  (`kill EPERM`), so Docker kills it. Shells are closed either way. Fixing it
  means granting `CAP_KILL` or changing how the service is launched under its
  privilege model, which is a security decision. The runbook calls the stack
  trace harmless.
- **The api transpiles TypeScript at every start.** It is why a start takes
  minutes on a busy host. Shipping compiled JavaScript would fix it and is an
  image-architecture change.
- **An api restart during a Start leaves the row `CREATING`** until idle
  expiry (20 min) or `ops end`. Bounded and now recoverable by hand.
- **A container create failure still shows the student a developer
  remediation** ("npm run sandbox:build") when the substrate was up. Student
  copy; left to the student-experience workstream.
- **The ADMIN role can already `DELETE /api/sessions/:id` for any session**
  through the public API, and it is recorded as "ended by student". No UI and
  no role assignment path exist; recorded for the authorization owner.

## 5. What this does not prove

Anything about a production host: its capacity, restart timing, TLS, DNS,
identity provider, alert delivery or backups. The operator tooling has run on
one laptop against a development-identity stack.
