# Deployment-readiness pass — 2026-09-19

| | |
|---|---|
| **Branch** | `feat/deployment-readiness-overnight`, from `origin/main` `001bcf1` (PR #40 merged) |
| **Audience** | whoever reviews this branch, and the operator of the first private-beta host |
| **Production host deployed?** | **No.** Nothing here ran on a production host. No host, DNS record, certificate, identity provider, firewall, alert destination or backup destination was created or touched. |
| **Canonical procedure** | [production-host-readiness.md](production-host-readiness.md) — this file records what this pass changed and why |

## 1. Summary

The repository-side deployment tooling (config check, preflight, smoke,
runbooks) was already substantial. This pass attacked it with adversarial
synthetic configurations and three independent read-only audits (backup and
restore, observability and alerting, production OIDC), confirmed each finding
against the code, and fixed the ones that are repository-side. **13 defects
fixed, each with a regression test that fails without the fix.** The platform is
still **not ready for student access**: every external item in
[readiness §23](production-host-readiness.md) remains.

## 2. Deployment model (from the repository, provider-neutral)

| Aspect | Repository evidence |
|---|---|
| Host | one Linux host (amd64 proven in CI, arm64 builds), rootful Docker with the socket at `/var/run/docker.sock`, Compose v2, kind v0.31.0 / kubectl v1.34.2, Node 22 for the operator tooling |
| Size | **none proven**. Laptop idle ≈ 0.7 GiB platform + 0.7 GiB kind node; a Docker-track sandbox may use `DOCKER_SANDBOX_MEMORY=2g`. Sizing is decision D8 via the §13 measurements |
| Public | TCP 443 (web, TLS) and 80 (redirect + ACME) only |
| Loopback / private | Grafana `127.0.0.1:3001`; Prometheus and Alertmanager on loopback inside one namespace; kind API `127.0.0.1:16443`; postgres on an `internal` network with the api only; api, terminal, sandboxd and metrics listeners unpublished |
| Kubernetes | kind on the same host (decision D2 whether that is the substrate) |
| Persistence | named volumes `jumptotech-labs-{postgres,prometheus,alertmanager,grafana}-data`; backups in `BACKUP_DIR`, status in `BACKUP_STATUS_DIR` |
| Operator access | SSH; `prod`, `q`, `alerts`, `ops` functions (private-beta-operations.md §1) |

## 3. Defects fixed

| # | Finding | Severity | Commit | Regression test (fails without the fix) |
|---|---|---|---|---|
| DR-01 | Config check PASSed a `PUBLIC_ORIGIN` with an IP, a port or a single-label host; the web edge's gate refuses all three, so web would crash-loop and never serve 443 | High (outage at first start) | `19ecdc9` | contract test pins the gate's pattern to `tls-preflight.sh`; 3 self-test scenarios |
| DR-02 | `TERMINAL_MAX_SESSIONS`/`SANDBOXD_MAX_SESSIONS` below `MAX_ACTIVE_SESSIONS` passed: students past the ceiling get a lab with no shell. The shipped defaults already disagree (20 vs 16) | Medium | `19ecdc9` | `capacity.shell-ceilings` cases |
| DR-03 | Extra `ALLOWED_ORIGINS` entries (trusted for credentialed CORS, CSRF and terminal WebSockets), a parent-domain session cookie, and `LAB_LAUNCHES_PAUSED` at deploy time all passed silently | Medium | `19ecdc9`, `16fba32` | WARN cases; a credential-shaped origin is never printed |
| DR-04 | Preflight never checked that the kind node publishes its cluster-admin API on loopback | High if hit | `a96d61d` | harness: public, IPv6 wildcard, unreadable |
| DR-05 | An unwritable `BACKUP_STATUS_DIR` makes every backup "succeed" while `BackupStale` fires; preflight only checked readability | Medium | `a96d61d` | harness (skipped as root) |
| DR-06 | `make clean` (`docker compose down -v`) and `make sandbox-clean` would destroy the production database / running labs on the production checkout; only the runbook's never-do table stood in the way | High (data loss) | `a8e2258` | five guard cases; Makefile ordering test |
| DR-07 | The smoke checked only the stack's own containers; any other container on the daemon published beyond loopback passed | Medium | `1183b6e` | three harness cases |
| DR-08 | Restore runbook §6.4 (and §6.6, §7) and TLS runbook §3.3 used a three-file production command: the api came back without its backup-status mount, metrics settings and health check during a restore; manual backups went to the checkout; a cron example named a non-existent hook | Medium | `60e1485` | docs test: every production `docker compose` command has all five files |
| DR-09 | `AUTH_COOKIE_NAME=__Host-…` breaks every sign-in (transaction cookie is `Path=/auth`); `OIDC_AUDIENCE` equal to the client id makes ID tokens API bearer tokens; a non-literal redirect URI fails the IdP's exact match | Medium | `eeec586` | contract + self-test cases |
| DR-10 | `ScopeDenialDetected` (critical) could not fire on a single denial (series born at 1), and never saw a wrong attach credential on the WebSocket upgrade | High (security alert blind) | `c0057d8` | first-scrape zero test; real upgrade test; promtool |
| DR-11 | `SandboxLeakSuspected` fired on a healthy all-Ansible class (15 − 5) and Kubernetes sessions hid leaked sandboxes | Medium | `3b9a6f0` | promtool (2 cases fail on the old rule); unit tests |
| DR-12 | `TerminalPtyDrift` fired on four students in Kubernetes/Docker terminals (local PTYs) | Low–Medium | `9ae3929` | promtool |
| DR-13 | Prometheus did not scrape Alertmanager: undeliverable notifications were invisible | Medium | `07ada55` | promtool; metric shape measured on `prom/alertmanager:v0.27.0` |

Also: `22d8787` proves `EDGE_PROBE_ENABLED=false` in `.env` cannot reach the api
(compose does not pass it), and warns if a compose edit ever does. `24fdf5e`
adds the step-by-step rehearsal (§13.2) and recovery drills (§17.1–17.2).

**Correction.** The commit messages of `19ecdc9` and `eeec586` state 30 and 33
self-test scenarios; the counts were 27 and 30. The current self-test has 31.

## 4. Found, confirmed, not fixed here

| Finding | Why not here | Where recorded |
|---|---|---|
| The api's bearer path accepts any token whose `aud` includes `OIDC_AUDIENCE`, including tokens issued to other clients and client-credentials tokens (provisioned as STUDENT); no `azp` check | an auth design decision | readiness §8.1, D15 |
| Sign-out does not revoke a terminal token (≤ 1 h) or close an open terminal | low risk for trusted students; with D13 | readiness §8.1 |
| No alert when the weekly archive verification stops running | would grow the reviewed alert set again; smoke `backup.verified` warns | follow-up |
| A hard-killed backup leaves a `.partial` copy that retention never removes | `scripts/db-backup.sh` is being changed on an unmerged branch | follow-up |
| Other sparse counters have the same born-at-1 blind spot (`ReaperRefusingForeignOwner`, `JwksFetchFailing`, the verification error ratio) | smaller impact; same fix pattern as DR-10 | follow-up |
| `ServiceNotReady` can never fire for terminal or sandboxd (nothing requests their `/readyz`) | `SandboxdRuntimeDown` and `ServiceDown` cover the outages | follow-up |
| `TerminalPtyDrift` can be masked by as many local shells | the precise fix counts broker sockets in `services/terminal/src/server.ts`, whose same hunks an unmerged branch changes | follow-up |

## 5. Scope boundaries

- `feat/private-beta-launch-readiness` (`d767c54..888a6e2`, 16 commits, **not
  merged**) already implements log rotation, preflight memory arithmetic, the
  kind node restart-policy record, the Grafana password gate, the backup-hook
  timeout, the Watchdog heartbeat and `production-evidence-status`. None of it
  was copied or re-implemented. The two branches share 13 files, mostly in
  different hunks; whichever merges second must reconcile, and the Watchdog
  alert will need the alert-count gate raised from 62 to 63.
- `feat/security-redteam-overnight` (concurrent): no shared files.

## 6. Evidence (development machine, not a host)

At `16fba32`, macOS, Docker Desktop, shared with other stacks (load average ≈ 30):

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run validate:labs` | PASS — 117 labs, 0 errors, 0 warnings |
| `npm test` | PASS — 5,049 tests across 8 workspaces |
| `npm run build` | PASS |
| `npm run test:security` | PASS — 810 tests |
| `npm run production:config-check -- --self-test` | PASS — 31 scenarios |
| `bash scripts/test-production-host-scripts.sh` | PASS — 52 cases; macOS bash 3.2 ×2, Linux bash 5.2 (node:22-bookworm-slim, as root) ×3 |
| `bash scripts/check-observability.sh` | PASS — 85 rules, 8 promtool test files |
| `node scripts/check-secret-distribution.mjs` | PASS |

CI has not run on this branch (workflows run on pull requests and `main`).
