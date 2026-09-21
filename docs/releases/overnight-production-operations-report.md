# Overnight production-operations pass — 2026-09-20/21

| | |
|---|---|
| **Branch** | `feat/overnight-production-ops` (not pushed, not merged) |
| **Base** | `d4e301b892f4f772e1a6eb7e20dd37b2d4fe9a0e` (= `origin/main` at the start) |
| **Final commit** | the commit that adds this file; `git log d4e301b..` lists every commit |
| **Scope** | production configuration, secrets, compose, startup/shutdown, backup, restore, disaster recovery, release, rollback, deployed-commit attestation, smoke, preflight, capacity evidence, observability, alerting, runbooks |
| **Machine** | a macOS development machine with Docker Desktop 28.4.0, shared with three other overnight jobs (load average 27–62 on 10 cores for most of the night) |
| **Production host?** | **None exists.** Nothing here ran on a production host. Every result below is repository evidence. |

Other agents covered broad hardening, lab/verifier certification, and
performance/concurrency the same night. This pass stayed on operations. Where a
finding touched their area (shutdown), it fixed only the operational
consequence: a process that is killed instead of stopping.

## 1. Conclusions

| Question | Answer |
|---|---|
| **REPOSITORY OPERATIONS READY FOR REAL-HOST VALIDATION** | **YES** — the procedures, scripts and gates are consistent with the code and tested against fakes and local Docker; the remaining work needs the host and the external decisions (§12, §13) |
| **BACKUP/RESTORE REPOSITORY WORKFLOW VALIDATED** | **YES**, locally: the script suite (131 cases) and the real-PostgreSQL restore drill (§7, §11). Off-host copy and restore: not done, D7 |
| **READY TO ENABLE STUDENT ACCESS** | **NO** — no host, DNS, certificate, identity-provider restriction, firewall scan, alert receipt, off-host backup, reboot drill or capacity measurement exists (§13) |

## 2. Production architecture (as the repository defines it)

One Linux host runs the five compose files through the runbook's `prod`
function ([private-beta-operations.md §1](../runbooks/private-beta-operations.md)).

| Component | Reachability | State | Starts after | Health |
|---|---|---|---|---|
| web (nginx, TLS gate) | **public** 443, 80 (redirect, ACME) | stateless; certificate in a bind mount | api healthy | `jtt-tls-preflight served`; refuses to start without a valid certificate |
| api | private (default network, `kind`, `database`) | stateless; sessions and progress in PostgreSQL | postgres healthy, sandboxd healthy | `/readyz` 9400 (database, lab registry) |
| terminal | private | open shells lost on restart (clients reconnect) | api healthy | `/livez` 9401; `/readyz` via the scrape |
| sandboxd | private; the only Docker socket | shells lost on restart; sandboxes survive | — | image `/health`; `/readyz` 9402 includes the runtime |
| postgres | private, `internal` network with api only | **persistent**: named volume `jumptotech-labs-postgres-data` | — | `pg_isready` |
| prometheus, alertmanager, grafana | loopback only, one network namespace; Grafana `127.0.0.1:3001` through SSH | persistent named volumes (15 d metrics) | — | smoke `observability.*` |
| kind node | cluster-admin API on `127.0.0.1:16443` | persistent container (not compose-managed; `on-failure:1`) | — | preflight `kind.*` |
| backups | `BACKUP_DIR` on the host (0700), status in `BACKUP_STATUS_DIR` (read-only in the api) | on-host only until D7 | cron | `jtt:backup_age:seconds`, alerts |
| secrets | `.env` (0600), scrape token (0644 in 0711), TLS key (0600) | on-host only; recovery is D9 | — | preflight, config check |

Must persist: the PostgreSQL volume, `.env`, the TLS key and certificate, the
backups, and the kind node (or the ability to recreate it and re-attest).
Everything else can be rebuilt from the commit.

## 3. Defects found and fixed

Each was reproduced or read end to end before it was fixed. Where a
negative control ran (the test fails on the old code), that is stated.

| # | Area | Defect | Consequence | Fix (commit) |
|---|---|---|---|---|
| 1 | secrets | `NAMESPACE_DERIVATION_SECRET` trimmed by the api, not by sandboxd; `SANDBOXD_ATTACH_SECRET` untrimmed in the terminal, trimmed in sandboxd. A quoted `.env` value keeps its whitespace | every container-backed lab fails at attach, looking like an ownership refusal; passed every loader and the full config check | production policy refuses padded secrets (raw variable judged); consistent trimming (`e49df45`) |
| 2 | backup | `--verify-only` and the backup read-back used `pg_restore --list`, which reads only the table of contents | **measured on postgres:16**: an archive cut to half and one with 8 flipped bytes both listed with exit 0; the weekly verification would have recorded a corrupt archive as good | full read with `pg_restore --file=/dev/null` in both; script cases and a real-PostgreSQL drill step (`939a3b4`) |
| 3 | secrets | no check that secrets held by *different* services differ; Grafana admin password only checked for presence | `SANDBOXD_ATTACH_SECRET = OIDC_CLIENT_SECRET` passed (24 PASS / 0 FAIL), putting the api's credential in the terminal | `secrets.distinct`, `secrets.grafana-admin` in the config check (`c55c547`) |
| 4 | backup | configuration refusals (non-executable copy hook, relative `BACKUP_DIR`) happened before the failure trap | a broken cron job failed nightly with no `BackupLastRunFailed`; only `BackupStale` a day later | trap installed after argument parsing (`872cfeb`) |
| 5 | observability | `jtt_readyz_ok` changed only when someone requested `/readyz` | `ServiceNotReady` blind for terminal and sandboxd, and a smoke/diagnostics probe during a blip latched a critical page | readiness evaluated at every scrape, bounded 2 s (`9d360df`) |
| 6 | alerts | a capacity refusal counted as a lab-start failure; no inhibition of `ServiceNotReady` by its dependency's alert | a full five-seat platform paged twice (RB-03 and RB-04); a database outage paged twice | recording rule excludes `capacity_reached`; two inhibit rules; promtool case (`148938f`) |
| 7 | alerts | prom-client exports an unset label-less gauge as 0; rules read it as a measurement | false critical `TlsCertificateExpiresWithin7Days`, `HostMemoryCritical`, `HostDiskSpaceCritical`, `NetworkIsolationNotAttested` on any stack not measuring them; in production an edge that never answered paged as "expired in 1970" and **inhibited `TlsEdgeUnhealthy`** | `> 0` guards and a max-age join; promtool cases — **negative control: all six false alerts fire on the old rules** (`14b7a55`) |
| 8 | alerts | `ReaperRefusingForeignOwner` watched a reason no code emits | a "security signal" the runbooks relied on could never fire | removed; runbooks point at the manual listing (`823181c`, `447261a`) |
| 9 | operations | `make up`/`rebuild`/`up-kubernetes-only`/`db-up` on a production checkout | re-creates services from the development files: AUTH_MODE development default, no restart policy, edge off 443/80, PostgreSQL on loopback | `refuse-on-production.sh --recreates` (`66f99d4`) |
| 10 | runbooks | alert runbooks used bare `docker compose` and `curl localhost:94xx` | commands fail in production (no sandboxd; ports unpublished) or re-create the api without its overlays | all rewritten to `prod`/`ready`/`q`; contract test (`447261a`) |
| 11 | runbooks | 20+ objectively wrong statements (auth outcome values, 401 vs 503, pool variable, log events, lab count, section links, `EDGE_PROBE_ENABLED`, restart alerting contradiction, stuck-CREATING timing, a cleanup label that matched every run, zsh `$COMPOSE`, expired-certificate procedure, unexported variables) | an operator following them at 2 am does the wrong thing or nothing | corrected against the code (`447261a`) |
| 12 | config | `boolFromEnv` read any unknown word as false | `LAB_LAUNCHES_PAUSED=ture` — the stop-launches switch — left Start Lab open, and the config check reported it off | strict true/false words; refused otherwise (`89b0751`) |
| 13 | redaction | a malformed `PUBLIC_ORIGIN`/`ALLOWED_ORIGINS` entry was echoed in the refusal | a credential pasted into an origin reached the container log and the config-check output | refusal names the variable and position only (`56b6027`) |
| 14 | shutdown | every image ran `node …/.bin/tsx <entry>`; the tsx CLI ended its child before the child's SIGTERM handler ran | **measured in the api image under tini**: `docker stop` → exit 137, no handler output; no service ever shut down cleanly (pool, reaper, shells). With `node --import tsx`: handler ran, exit 0 | single-process CMD in all three images; each service started and stopped cleanly locally (`0626d77`) |
| 15 | shutdown | once reachable, sandboxd's handler waited forever for shell WebSockets; the api's for Start Lab requests (up to 180 s) | SIGKILL at Docker's 10 s grace, pool open | bounded exits (5 s / 7 s); measured with a held connection: exit 0 in 6 s and 7 s (`0b2cc15`) |
| 16 | startup | terminal and sandboxd health-check start period 10 s/30 s; they compile TypeScript at start like the api (225 s measured at load 20) | `prod up --wait` failed a slow start, and the api (waiting on sandboxd) never started | 300 s, as the api (`6645678`) |
| 17 | disk | no container log rotation anywhere | logs grow on the PostgreSQL filesystem until full | json-file 10 MB × 5 on every production service; `durability.log-rotation` (`f99daef`) |
| 18 | database | PostgreSQL stopped with Docker's default 10 s | final checkpoint cut short on a slow disk → crash recovery | `stop_grace_period: 60s`; `durability.database-shutdown` (`f99daef`) |
| 19 | restore | docs claimed an api refuses to start on a database with a migration it does not know | the migrator ignores unknown versions: older code starts on a newer schema silently; a rollback plan built on the claim would run it | docs corrected (`bd3a68b`, and the rollback table below) |
| 20 | release | no upgrade procedure; rollback never updated `JTT_COMMIT`; the smoke never compared the running commit with the checkout | a service not re-created, or a stale `JTT_COMMIT`, passed every check | readiness doc §21.1 upgrade procedure, §21.2 rollback; smoke `release.commit` (final commits) |
| 21 | smoke | `backup.recent` failed at 24 h while `BackupStale` allows 26 h | a smoke run just before the nightly backup failed a working schedule | 26 h (final commits) |
| 22 | capacity evidence | the sampler recorded load only | CPU steal (a noisy VM neighbour), iowait, memory pressure and OOM kills unrecorded | `host.csv` gains CPU busy/iowait/steal %, PSI some avg60 (cpu, memory, io), OOM-kill count; refuses to append to an older-format file (final commits) |
| 23 | preflight | `jq` is used throughout the runbooks and was neither listed nor checked | runbook commands fail on a minimal host | preflight WARN; readiness §5.1 (final commits) |

## 4. Findings recorded, not fixed

| Finding | Why not fixed here | Risk |
|---|---|---|
| No dead-man's switch (Watchdog) on `main`; a dead host or monitoring stack is silence | exists on the unmerged `feat/private-beta-launch-readiness`; duplicating it would conflict | high until merged and D6 decided |
| `AuthzOwnershipDenialSpike`, `SecurityEventBurst`, `MetricsScrapeDenied`, `ReaperDeleteFailures` read counters that are not zero-initialised, and the first uses `rate[5m]` with `for: 5m`: a short burst fires nothing (promtool-measured by the audit) | security alert design; the other hardening job's area | medium |
| `VerificationErrorRate` misses the first error per lab (lazily created series) | metric change in the api | low–medium at five students |
| sandboxd's compose health check is liveness only; moving it to `/readyz` would stop the api from starting whenever the runtime is down | a design trade-off, not a defect | covered by `SandboxdRuntimeDown` and preflight |
| `DATABASE_POOL_MAX` is not passed through compose | a tuning knob, not needed at five students | low |
| The api logs nothing at the moment a pool client errors (`onPoolError` unset); no client-side query timeout | observability of a blip; readiness probe catches it within 10 s | low |
| Integer settings accept trailing junk (`5 students` → 5) and ports are not range-checked | the config check compares the capacity values exactly; ports fail at `listen` | low |
| Prometheus retention is by time (15 d) with no size cap | D12 | low at this scale |
| `make observability-token` copies a quoted `.env` value with its quotes | the preflight's `scrape-token-match` fails it by hash | low |
| Unset label-less gauges still export 0 (the rules now ignore it); `BackupStatusUnreadable` still fires on a stack with no status directory | development-only false warning | low |

## 5. Production configuration

The config check (`npm run production:config-check -- --self-test`) now has 34
scenarios (31 at the base), all passing: the new ones are a secret shared
across services, the default Grafana password and a padded secret. Service
loaders newly refuse padded secrets, unknown switch words and — without echoing
them — malformed origins. The contract gained `secrets.distinct`,
`secrets.grafana-admin`, `durability.log-rotation` and
`durability.database-shutdown`.

## 6. Startup and shutdown

- Every service now runs as the process tini signals (§3 #14); shutdown is
  bounded below Docker's 10 s (§3 #15); PostgreSQL gets 60 s (§3 #18).
- Health-check start periods match the measured slow start (§3 #16).
- Startup refusals exit 1 with the variable named (confirmed by the audit:
  missing secrets stop compose at interpolation; loader refusals exit 1; an
  occupied port exits 1; the web tier fails closed before nginx starts).
- Not measured: the full images built from this branch under a real `prod up`
  and `prod down` (the machine could not build all images in the night's
  load); the single-process start was proven in an existing api image and by
  starting each service locally.

## 7. Backup and restore

| Check | Result |
|---|---|
| `bash scripts/test-db-backup-restore.sh` | PASS, 131 cases (§11) |
| Real PostgreSQL 16 restore drill (`make db-restore-drill`): backup → destroy → fresh server → verify → **refuse a truncated and a corrupted copy** → `--into` → refusals → `--replace` → identical fingerprint → migrator and application check | PASS in 305 s (§11) |
| Truncation and corruption escape `pg_restore --list` | **proven**: exit 0 for both on postgres:16-alpine; `--file=/dev/null` fails both |
| Failure paths: missing, empty, garbage, checksum mismatch, altered in transit, truncated/corrupt, no sidecar, database unreachable, container stopped, two containers, a live lock, overlap with the status directory | script suite |
| Wrong permissions | `BACKUP_DIR` not owned by the runner is refused; tightened to 0700; files 0600 |
| Off-host copy, encryption, retention off the host | **not done — D7**; `BACKUP_COPY_HOOK` is only a seam, and the smoke's `backup.offhost` stays FAIL |

## 8. Disaster-recovery matrix

| Scenario | Recoverable from the repository | Also needs | Proven |
|---|---|---|---|
| service container lost/crashed | yes: `restart: unless-stopped`, or `prod up -d <svc>` | — | policy rendered and checked; real crash: host |
| bad deployment | yes: §21.2 of the readiness doc (previous commit, `.env.previous`, `prod up --build --wait`) | the pre-upgrade archive if a migration ran | procedure only |
| database lost or corrupt | yes: `db-restore.sh --replace` from an archive (renames, never drops) | an archive: on-host today, off-host after D7 | locally (drill) |
| host lost | partly: the commit rebuilds everything that is code | **the database archive off the host (D7), `.env` secrets and the TLS key (D9), DNS (D4), a host (D2), the identity-provider client (D1)** | not proven |
| certificate expired or broken | yes: production-tls.md §7.3 (renew, `tls-install.sh`, `.previous` pair) | the CA (D5), DNS | edge behaviour in CI with test certificates |
| runtime (Docker) unavailable | yes: RB-06 | host access | not on a host |
| disk full | yes, safely: RB-19 (prune images, build cache, stopped sandboxes; never volumes); logs are now bounded | a bigger disk if the data outgrew it (D8) | alerts in promtool |
| backup unavailable | no — nothing replaces a missing archive | D7 | — |
| configuration corrupted | yes: `.env.previous`, preflight, config check | the secrets themselves if `.env` is lost (D9) | self-test |
| host rebooted | services return (`unless-stopped`); the kind node has `on-failure:1`, unmeasured | a reboot drill | **not proven** |

No RTO or RPO is invented here. The only recovery-point objective the
repository encodes is the daily backup schedule with `BackupStale` at 26 h.

## 9. Release, rollback, attestation, smoke, preflight, observability

- **Release:** the readiness doc gains §21.1, derived from the scripts: record
  the running commit and smoke; inspect the diff for migrations and compose/env
  changes; back up and verify; check out, `npm ci`, set `JTT_COMMIT`; config
  check and preflight; `prod up -d --build --wait`; smoke; observe. A non-zero
  `--wait` is a failed deployment.
- **Rollback:** §21.2 now restores `.env.previous` (with the previous
  `JTT_COMMIT`), and says plainly that an older api starts on a newer schema,
  so a release that migrated needs the pre-upgrade archive.
- **Attestation:** the smoke's `release.commit` compares `jtt_build_info`
  from api, terminal and sandboxd with the checkout's HEAD — FAIL on another
  commit, WARN on `unknown`. The image itself still carries no commit
  (building it with the commit as a label is the follow-up already recorded in
  `ci-and-release-gates.md`).
- **Smoke:** read-only, bounded, labelled by proof class, tested against fakes
  (54 cases, §11). Changes: `release.commit`, the 26 h backup threshold.
- **Preflight:** read-only, bounded, secret-safe; its `set -e` paths were
  audited. Change: `jq`.
- **Observability/alerting:** §3 #5–#8. `check-observability.sh` passes (10 rule
  files, 9 promtool test files, amtool, dashboards). Human receipt of any alert:
  **not done — D6**.

## 10. TLS, network exposure, operator access

No change to the edge. Runbook corrections: the expired-certificate procedure
(stop the looping web container before a standalone renewal; key copies in a
private directory), section links, the health-check wording. Exposure: the
contract and smoke checks were read and are consistent. RB-08 no longer
claims the metrics listeners bind loopback: they bind every interface inside
their containers and are unpublished. Operator access remains SSH plus
`ssh -L` for Grafana; no runbook requires a public admin port. The technology
and key holders are D10.

## 11. Validation

Run on this branch on the machine above (Node 22.23.2). **None of it is host
evidence.**

| Command | Result |
|---|---|
| `npm run typecheck` | PASS (every workspace and `scripts/`, 0 errors) |
| `npm run build` | PASS |
| `npm test` | 5,490 passed, 334 skipped, **1 failed**: `apps/api` `catalog-api.test.ts` "serves an additional valid track…" at 5,147 ms against its 5 s timeout, at load average 30–40. The file alone: **33/33 PASS**. The same file timed out under load at the base (readiness doc §20); this branch does not touch it. Per workspace: api 684/15 skipped, web 259, lab-orchestrator 1,372/253, observability 938/38, progress 96/1, sandboxd 150/7, terminal 181/20, verifier 1,810 |
| `npm run test:security` | PASS — 875 tests in 53 files, 0 failed |
| `bash scripts/test-production-host-scripts.sh` | PASS — 54 cases, 0 failed assertions (41 at the base per §20 of the readiness doc; the hung-daemon case is skipped on macOS, which has no coreutils `timeout`) |
| `bash scripts/test-db-backup-restore.sh` | PASS — 131 passed, 0 failed (new: data that does not read, a refused configuration recorded as a failure, a usage error not recorded) |
| `JTT_TEST_RUN_ID=… bash scripts/db-restore-drill.sh` (real postgres:16-alpine) | PASS in 305 s, including the new refusals of a tail-truncated copy and a corrupted copy with a matching sidecar. Two earlier attempts timed out at the first server's readiness (a bare postgres container took over 80 s to run `initdb` at load 55–62) and one exposed a flaw in the new drill step itself (fixed, `69b4148`) |
| `npx tsx scripts/production-config-check.ts --self-test` | PASS — 34 scenarios (real `docker compose config` of the five files, real loaders) |
| `bash scripts/check-observability.sh` | PASS — 10 rule files, 84 rules (85 at the base; the dead alert removed), prometheus.yml, 9 promtool test files, amtool, dashboards and runbook links |
| `node scripts/check-secret-distribution.mjs` | PASS |
| Signal handling, real api image under `--init` | tsx CLI: exit 137, no handler; `node --import tsx`: handler ran, exit 0 |
| api, terminal, sandboxd started locally under `node --import tsx`, then SIGTERM | each logged `process.stopping` and exited 0; with a half-open connection held, sandboxd exited 0 after 6 s and the api after 7 s (`shutdown_deadline`) |
| Negative controls | new promtool cases against the base rules: 6 false alerts and the misleading expiry page fire; `pg_restore --list` on damaged archives: exit 0 |
| `git diff --check` | clean before every commit |

Not run: `make test-tls-edge` and the kind/Kubernetes integration suites (this
pass changed nothing in the edge or the cluster code, and the machine could
not carry them alongside the other jobs); `make beta-validate` (needs a full
stack with kind); `make test-db`; the browser E2E; a build of the three images
from this branch. None is claimed.

## 12. External decisions (not made here)

D1 identity provider · D2 host/provider/size/substrate · D3 who may sign in and
how the provider enforces it · D4 hostname/DNS · D5 CA/ACME/renewal · D6 alert
destination and on-call · D7 off-host backup, encryption, retention, restore
rights · D8 capacity thresholds · D9 where `.env` and the TLS key are
recoverable from · D10 operator access · D11 attestation re-probe cadence · D12
metric/log retention, external uptime check, host exporter · D13 federated
logout and idle timeout · D14 IPv6, HSTS preload, CAA · D15 OIDC bearer tokens
on `/api/*`.

## 13. Real-host evidence still required

None of these has happened: production preflight on the host; firewall scan
from another network; public DNS; external HTTPS; certificate issuance and
renewal; five-student capacity on the host (the sampler now records the
saturation signals); an encrypted off-host backup and a restore from it; an
alert received by a person; a host reboot and a Docker restart drill (kind
node `on-failure:1` behaviour); deployed-commit verification (`release.commit`
on the host); a real `prod stop`/`prod up` of images built from this branch.

## 14. Operator follow-up

1. Review and merge this branch after the other overnight branches it may
   touch (runbooks, `apps/api/src/config.ts`, the Dockerfiles, compose
   overlays); re-run CI there.
2. Rebuild the api, terminal and sandboxd images (`prod up -d --build --wait`)
   and confirm `docker stop` of each ends with exit 0 and a `process.stopping`
   line.
3. Add `jq` to the host image; keep `JTT_COMMIT` current on every upgrade (§21.1).
4. Merge the Watchdog/heartbeat work and decide D6 before students.
5. Close D7 before students: until then the host is the only copy of every
   student record.

## 15. Residual risks

- Everything in §13; above all, no off-host backup (D7) and no alert reaches
  a person (D6).
- Images built from this branch were not exercised end to end on this machine.
- Security-alert burst detection gaps (§4).
- One host, one instance of each service; `unless-stopped` recovers
  processes, not the host.
