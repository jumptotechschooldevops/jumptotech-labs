# Private-beta engineering pass — 2026-09-18

| | |
|---|---|
| **Branch** | `feat/private-beta-launch-readiness`, continued after PR #39 merged (`origin/main` `aadce77`, whose tree is this branch's `d767c54`) |
| **Production host deployed?** | **No.** No host, DNS name, public certificate, identity provider, alert receiver, heartbeat service or off-host backup was created or exercised. |
| **Verdict** | Software ready for a **real-host deployment test**. **Not ready for student access.** |

Evidence words: **PROVEN BY AUTOMATED TEST** (a repository test that fails
without the change), **LOCAL SOFTWARE EVIDENCE** (a run on the development
machine), **REQUIRES REAL HOST**, **REQUIRES EXTERNAL CONFIGURATION**. Nothing
here has run in CI yet; nothing here is host evidence.

## 1. What changed

Every defect below was reproduced (a failing test, or the real stack) before it
was changed, and every fix has a test that fails without it.

| # | Area | Problem | Fix | Evidence |
|---|---|---|---|---|
| 1 | Terminal | **Two attaches for one session could both register a shell.** `startSession` closed the registered socket, then awaited the API and the broker; an attach still in flight was not registered, so nothing closed it. Two tabs opening together, or a reconnect overlapping an older attempt: the older socket got `ready` and then "The shell exited (code 0)" when the broker replaced its PTY; for a local-PTY session both shells lived. An attach in flight when the lab ended (`/internal/terminate`) **registered afterwards** and kept a live shell for an ended lab | `latestAttach` names the newest attach per session; `closeSession` clears it; an attach that is no longer newest when it finishes kills its shell, discards its credentials and closes `SESSION_ENDED` (4410) like a takeover. Credential files are named **per attach**: the attach that gave way used to remove the session-named kubeconfig / Docker certificates the surviving shell was reading (`4a865c6`) | real terminal + API + sandboxd, broker lookup gated so both attaches are provably in flight: 2 of 3 cases fail on the old server; 5/5 repeated runs pass |
| 2 | Terminal (web) | The Reset input fix (`b1b63cc`) had no test for sign-out, a replaced session, repeated Resets or keys typed while disconnected | four regression cases; one fails when the close handler stops disposing its listener (`b222fd8`) | component tests |
| 3 | Auth | **A sign-in that failed in the browser displayed a JSON error page.** `/auth/login` and `/auth/callback` are navigations; the provider refusing a non-invited account (how the beta is restricted, D3), Back after signing in, a stale sign-in, or a provider outage all ended on `{"ok":false,"error":…}` | a request preferring HTML is redirected to `<app>/?signin=refused\|expired\|unavailable\|failed`; the sign-in screen words it ("This beta is open only to invited students …") and removes the parameter. Provider text is never carried. API clients keep the JSON (`d3234a8`) | 5 API tests (4 fail on the old route); 6 web tests; **browser**: the test provider now refuses `not-invited-*` accounts and the new E2E test passed (`a1ea932`) |
| 4 | Production | **No log rotation anywhere.** Docker's default `json-file` keeps a container's output forever | every production service logs `json-file` max 5 × 20 MB; contract check `durability.log-rotation` FAILs without it; preflight `docker.log-rotation` WARNs when the daemon default (used by the kind node and sandboxes) does not rotate (`49ae78f`) | contract tests; config self-test renders the real overlays |
| 5 | Production | `GRAFANA_ADMIN_PASSWORD` reaches no loader: `admin`, or a copy of `POSTGRES_PASSWORD`, started production | `secrets.grafana-admin` with the platform's secret policy and a reuse check (`e572c67`) | two new self-test scenarios (22 total) |
| 6 | Backups | `BACKUP_COPY_HOOK` ran unbounded: a hook hung on a network destination held the lock and blocked every later backup. The lock's liveness used only `ps`, so on a host without procps a running backup's lock was replaced | `timeout` (`BACKUP_COPY_HOOK_TIMEOUT_SECONDS`, default 1800); liveness also by `kill -0` and `/proc` (`569cd29`) | backup harness 121/0 on Linux (the two live-lock cases failed there before); 118/0 on macOS (timeout case skipped: no coreutils `timeout`) |
| 7 | Observability | **Nothing noticed a dead host or monitoring stack** (the release gate's "watchdog NOT IMPLEMENTED") | always-firing `Watchdog`, routed first and alone to a `heartbeat` receiver reading `secrets/heartbeat-url`; smoke `observability.watchdog` proves rules evaluate; RB-20. The check-in service itself is external (`51ce05b`) | promtool unit test, amtool, routing test, smoke/preflight harness cases |
| 8 | Operator tooling | Nothing read the evidence directory back | `make production-evidence-status`: each automated evidence file PASS only if present, concluding PASS and at HEAD; absent = FAIL "NOT RUN"; person-only items quoted as MANUAL, never counted (`29c4333`) | 4 harness cases |
| 9 | Operator tooling | The five-student report named no commit, so it could not be matched to a deployment | records `git rev-parse HEAD` and clean state (`f6bb8bd`) | read by #8 |
| 10 | Operator tooling | Host sizing sanity; the kind node's restart policy recorded by hand | preflight `host.capacity-memory` WARN below seats × largest sandbox cap + 2 GiB (arithmetic on `.env`, labelled so); `host.swap`; `kind.node-restart-policy` (`49ae78f`, `87a9f43`) | harness cases |
| 11 | Five students | No HTTP-level test ran five signed-in students through repeated races | real API + real OIDC cookies, 3 cycles: 6 simultaneous Starts → 5 admitted, 1 `LAB_CAPACITY_REACHED`; second Start `STUDENT_SESSION_LIMIT_REACHED`; every cross-student probe 404 on 5 routes; simultaneous double Verify graded on each student's own sandbox; simultaneous Reset keeps completion; the waiting student admitted when one ends; nothing left (`ada76d0`) | **LOCAL SOFTWARE EVIDENCE**, fake runtime with jitter; fails when the session list stops filtering by owner. Not capacity evidence |

## 2. Reset / terminal status

- The original "first command after Reset is lost" race was root-caused and fixed
  on `2026-09-17` (`b1b63cc`: 0/3 before, 5/5 after in the browser). Its fix was
  re-read here and is correct: held input is scoped to one connection attempt,
  discarded with it, and never replayed. No retype loop and no probe remain.
- This pass closed the server-side counterpart (§1 #1), which the earlier
  report listed as "narrow, not reproduced": it is now reproduced and fixed.

## 3. Validation (development machine, not CI, not a host)

On a machine shared with other worktrees' stacks and five idle kind clusters
(load average 15–26 throughout). **None of it is host evidence.**

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run validate:labs` | PASS — 117 labs, 0 errors, 0 warnings |
| `npm test` | **PASS** — 4,938 passed, 0 failed, every workspace |
| `npm run build` | PASS |
| `npm run test:security` | **PASS** — 808 (803 + the five browser sign-in failure cases) |
| `npm run production:config-check -- --self-test` | PASS — 22 scenarios |
| `bash scripts/test-production-host-scripts.sh` | PASS — 52 cases, 0 failed, on macOS bash 3.2 and on Linux bash 5.2 (`node:22-bookworm-slim`) |
| `bash scripts/test-db-backup-restore.sh` | PASS — 121/0 on Linux (non-root); 118/0 on macOS (hook-timeout case skipped: no coreutils `timeout`) |
| `bash scripts/check-observability.sh` | PASS — 83 rules, 5 rule test files, `alertmanager.yml` valid |
| `node scripts/check-secret-distribution.mjs`, `npm run test:composition` | PASS (25) |
| `make test-terminal-container` (real PTY, real kind) | PASS — 20/20, including the per-attach kubeconfig and its deletion |
| `RUN_INTEGRATION_TESTS=1 vitest run test/sandbox-integration.test.ts --root apps/api` (real Docker) | PASS — 13/13 |
| `npm run test:integration:sandboxd` | 7 passed (PTY cases skip on this host, as before) |
| `concurrent-attach.test.ts` + `session-activity.test.ts` | 10/10, five runs in a row |
| `five-student-stress.test.ts` | 1/1, five runs in a row |
| `bash e2e/stack.sh run` (`jtt-e2e-p3`) | 5 passed (incl. the new refusal test), then starved at load 20–23 — §4 |
| `make beta-validate` | **not run** (§4) |

## 4. Still open

- Browser E2E on the final tree: the run in this pass passed its first five
  tests (including the new refusal test) and then starved (load 20–23: five
  other worktrees' kind control planes at ~410% of the Docker VM; the e2e api's
  `/health` took up to 17.8 s, and it went unhealthy after being re-created).
  **LOCAL ENVIRONMENT**; not re-run on a quiet machine.
- `make beta-validate` on the current tree: still not re-run (a sixth kind
  cluster on this VM would endanger other worktrees' clusters).
- Unchanged minor findings from the 2026-09-17 report §4 (Verify after cleanup
  wording, no idle warning for a DEGRADED lab).
- Everything in production-host-readiness.md §23: a host, D1–D14.
