# Private beta operations

**BETA-P0-018.** How to run JumpToTech Labs for the private beta, about five
concurrent students, and how to tell when it is unhealthy. Start here. The
alert runbooks (RB-01…RB-19) go deeper on one alert each.

| | |
|---|---|
| **Capacity contract** | `MAX_ACTIVE_SESSIONS=5`, `MAX_ACTIVE_SESSIONS_PER_STUDENT=1` |
| **Public exposure** | 443 (HTTPS) and 80 (redirect, ACME) only — BETA-P0-012/017 |
| **Operator access** | SSH to the host; Grafana through a tunnel to `127.0.0.1:3001` |
| **Alert delivery** | **DECISION REQUIRED** (§8). Until decided, alerts are seen only in Grafana and `amtool` |
| **Proven** | Rules, alerts, dashboard queries and exposure are tested in CI (`npm test`, `scripts/check-observability.sh`, `make secrets-check`). The production overlay renders with `docker compose config`. Five concurrent students on the real runtime pass the release gate `make beta-validate` ([five-student-beta-validation.md](five-student-beta-validation.md), BETA-P0-019) |
| **Not proven** | A production host. None exists yet. Every command below is the command that host runs, and none has been run on one. |

---

## 1. The production command

Run everything from the checkout the stack was started from, as a user that can
run `docker` (root-equivalent — choose the account accordingly). Define these
once per shell; they work in bash and zsh:

```bash
cd /srv/jumptotech-labs

prod() {
  docker compose \
    -f docker-compose.yml -f docker-compose.runtime.yml \
    -f docker-compose.observability.yml \
    -f docker-compose.production.yml -f docker-compose.production-observability.yml \
    --profile observability "$@"
}

# One PromQL expression, answered by Prometheus from inside its own container.
q() { prod exec -T prometheus promtool query instant http://127.0.0.1:9090 "$1"; }

# A service's readiness, asked from inside its container: ready api 9400,
# ready terminal 9401, ready sandboxd 9402.
ready() {
  prod exec -T "$1" node -e \
    "fetch('http://127.0.0.1:$2/readyz').then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1) })"
}

# Alerts Alertmanager currently holds.
alerts() { prod exec -T alertmanager amtool alert query --alertmanager.url=http://127.0.0.1:9093; }
```

The order of the `-f` files matters (the production overlay's port resets must
follow the observability overlay). Prometheus and Alertmanager are unreachable
from outside their own containers in production, which is why `q` and `alerts`
use `exec` rather than a URL.

### 1.1 First start

1. `.env` holds the production values: `PUBLIC_ORIGIN`, the OIDC settings,
   every secret (`make secrets` generates missing ones, including
   `OBSERVABILITY_SCRAPE_TOKEN` and `GRAFANA_ADMIN_PASSWORD`), `RUNTIME_OWNER_ID`,
   `MAX_ACTIVE_SESSIONS=5`, `MAX_ACTIVE_SESSIONS_PER_STUDENT=1`, and
   `BACKUP_STATUS_DIR` (§1.2).
2. The TLS certificate is installed: [production-tls.md](production-tls.md).
3. `make observability-token` — writes the scrape token where Prometheus reads it.
4. The backup status directory exists, owned by the account the backup job runs
   as, **before** the stack starts (otherwise Docker creates it owned by root and
   the job cannot write it):
   ```bash
   sudo install -d -m 0755 -o jtt-ops /srv/jumptotech/backups/status
   ```
5. `make secrets-check` — every service receives exactly its secrets and ports.
6. `prod up -d --build`, then §2.
7. Optional until §8 is decided: install the alert destination,
   [alertmanager/secrets/README.md](../../infrastructure/observability/alertmanager/secrets/README.md).

### 1.2 Scheduled jobs on the host

The backup schedule from
[postgres-backup-restore.md §5.3](postgres-backup-restore.md), with the status
directory added, and a weekly verification of the newest archive:

```cron
# /etc/cron.d/jumptotech-db — backups daily 03:17 UTC, verification Sundays 05:17
17 3 * * *  jtt-ops  cd /srv/jumptotech-labs && BACKUP_DIR=/srv/jumptotech/backups/postgres BACKUP_STATUS_DIR=/srv/jumptotech/backups/status scripts/db-backup.sh >>/var/log/jumptotech/db-backup.log 2>&1
17 5 * * 0  jtt-ops  cd /srv/jumptotech-labs && BACKUP_DIR=/srv/jumptotech/backups/postgres BACKUP_STATUS_DIR=/srv/jumptotech/backups/status scripts/db-restore.sh --verify-only "$(ls -1t /srv/jumptotech/backups/postgres/*.dump | head -1)" >>/var/log/jumptotech/db-verify.log 2>&1
```

`BACKUP_STATUS_DIR` must be the same path in `.env` (the api mounts it) and in
both jobs. The NetworkPolicy attestation must also be re-proven before it ages
out (RB-18); its cadence is DECISION REQUIRED (§8).

### 1.3 Grafana

```bash
ssh -L 3001:127.0.0.1:3001 <operator>@<host>
```

Then `http://127.0.0.1:3001` → **JTT — Private Beta Operations**. The user is
`GRAFANA_ADMIN_USER` (default `admin`) and the password is `GRAFANA_ADMIN_PASSWORD`
from `.env`.

---

## 2. Platform health check

Five minutes, before every class and after any change.

```bash
prod ps                        # every service Up; web and postgres (healthy)
alerts                         # nothing critical
ready api 9400                 # 200, database and lab_registry ok
ready terminal 9401
ready sandboxd 9402            # 200, runtime ok
q 'jtt:sessions_headroom:count'
q 'jtt:tls_certificate_expiry:seconds / 86400'
q 'jtt:backup_age:seconds / 3600'
q 'jtt_network_isolation_attestation_valid'
```

Then open the dashboard and read it top to bottom. Every row is one of these
questions:

| # | Question | Where | Signal |
|---|---|---|---|
| 1 | Is the public application reachable? | Row 2, "HTTPS check" | `jtt_tls_check_status{check="served"}` — from inside the host (see §9) |
| 2 | Is HTTPS/TLS healthy? | Row 2 | `jtt_tls_check_status`, `jtt_tls_check_findings` |
| 3 | Is the certificate close to expiry? | Row 2 | `jtt:tls_certificate_expiry:seconds` |
| 4 | Is the API healthy? | Row 1 | `up{job="api"}`, `jtt_readyz_ok{service="api"}` |
| 5 | Is the terminal service healthy? | Row 1 | `up{job="terminal"}` |
| 6 | Is sandboxd / the runtime healthy? | Row 1 | `up{job="sandboxd"}`, `jtt_sandboxd_runtime_up` |
| 7 | Is PostgreSQL healthy? | Row 1 | `jtt_db_up`; `prod ps postgres` |
| 8 | Is Kubernetes reachable? | Providers dashboard | `jtt_provider_available{provider="kubernetes"}` |
| 9 | How many sessions are active? | Row 3 | `jtt_sessions_active` |
| 10 | How close to the limits? | Row 3 | `jtt:sessions_headroom:count`, `jtt_sessions_per_student_limit` |
| 11 | Are starts failing? | Row 4 | `jtt_lab_start_outcome_total` |
| 12 | Are resets failing? | Row 4 | `jtt_lab_reset_outcome_total{outcome="failed"}` |
| 13 | Are ends / cleanup failing? | Rows 4, 5 | `jtt_lab_end_outcome_total{outcome="pending"}`, `jtt_reaper_last_sweep_errors` |
| 14 | Are sessions stuck? | Row 3 | `jtt_sessions_oldest_status_age_seconds` |
| 15 | Is the reaper failing? | Row 5 | `jtt:reaper_seconds_since_success`, `jtt_reaper_teardown_incomplete_total` |
| 16 | Are sandbox creations failing more? | Row 4; Providers | `outcome="provision_failed"`, `jtt_sandboxd_runtime_ops_total` |
| 17 | Are isolation checks failing? | Row 6 | `jtt_network_isolation_attestation_valid`, `jtt_sandboxd_scope_denials_total` |
| 18 | Are auth/OIDC failures abnormal? | Row 6 | `jtt:auth_rejected:increase10m`, `jtt_auth_callback_total` |
| 19 | TLS / JWKS / runtime dependency failures? | Rows 1, 2, 6 | `jtt_tls_check_status`, `jtt_oidc_jwks_fetch_total`, `jtt_sandboxd_runtime_up` |
| 20 | Is disk dangerous? | Row 8 | `jtt:host_filesystem_available:ratio` |
| 21 | Is memory/CPU dangerous? | Row 8 | `jtt:host_memory_available:ratio`, `jtt:host_load5_per_cpu:ratio` |
| 22 | Is the backup recent enough? | Row 7 | `jtt:backup_age:seconds{operation="backup"}` |
| 23 | Has a backup/restore check failed? | Row 7 | `jtt_backup_last_failure_timestamp_seconds`, `BackupVerifyFailed` |

---

## 3. Should students stop launching labs?

Tell the cohort to stop launching labs, and reduce new launches as far as the
platform allows (below), when any of these is true:

| Condition | Why | Runbook |
|---|---|---|
| `DatabaseDown` | Nothing a student does is recorded | RB-02 |
| `ScopeDenialDetected`, or `ReaperRefusingForeignOwner` you cannot explain | A boundary is being tested | RB-08 |
| `NetworkIsolationNotAttested` | Kubernetes labs already refuse — say so; other tracks may continue | RB-18 |
| `TlsEdgeUnhealthy` or the certificate has expired | Browsers refuse the site anyway | RB-15 |
| `HostDiskSpaceCritical` or `HostMemoryCritical` | New sandboxes make it worse and can take PostgreSQL down | RB-19 |
| `ReaperStalled` with no free slots | Slots will not come back on their own | RB-05 |
| `LabStartsFailingHard` for more than 15 minutes | Students are being turned away anyway | RB-03 |

Keep going, and fix it today, for: `BackupStale`, `BackupLastRunFailed`,
`TlsCertificateRenewalDue`, the stuck-session warnings, `HostDiskSpaceLow`.

### Reducing new launches — there is no stop-launches switch

**The platform has no maintenance mode.** Nothing refuses every Start Lab while
leaving running labs alone. A real maintenance-mode launch gate is a
**post-P0-018 follow-up** (§8). What exists today only reduces launches:

1. **Tell the cohort.** Always first, and today the only way to stop launches
   without taking the site down.
2. **Reduce new launch capacity to one:** set `MAX_ACTIVE_SESSIONS=1` in `.env`
   and `prod up -d api`. This **reduces** new launch capacity; it **does not
   disable** new launches. Running labs and their shells continue (sessions are
   durable). While at least one session is live, a Start is refused with
   `LAB_CAPACITY_REACHED`; as soon as none is live, the next Start succeeds —
   and that student then holds the only slot. (`MAX_ACTIVE_SESSIONS=0` is
   refused at startup: it must be a positive integer.) Restore `5` and
   `prod up -d api` afterwards.
3. **Docker track only:** `DOCKER_TRACK_ENABLED=false` in `.env`, then
   `prod up -d api`. The other tracks still launch.
4. **Take the site down:** `prod stop web`. This is not a launch gate: every
   student loses the site, running labs included (they are reclaimed later by
   idle expiry). Use it only for §3's security rows.

---

## 4. A student cannot start a lab

1. Which refusal did they get? The UI shows the error code; the log has it:
   ```bash
   prod logs --since 30m api | grep '"event":"lab.start.failed"' | tail -20
   q 'sum by (outcome) (increase(jtt_lab_start_outcome_total[30m]))'
   ```
2. By `outcome`:
   - `student_limit_reached` (`STUDENT_SESSION_LIMIT_REACHED`) — the student
     already holds a lab, often in another tab or browser. They open it and press
     **End Lab**, or wait for idle expiry (20 minutes). Not a platform fault.
   - `capacity_reached` — the platform is full: §5.
   - `provider_unavailable` — the substrate for that track is down: RB-09, RB-06;
     for Kubernetes check RB-18 first.
   - `provision_failed` — the substrate is up and creation failed: RB-03.
   - `unauthorized` — sign-in: RB-14.
3. If the log shows nothing, the request never reached the API: `prod ps web`,
   RB-15, then RB-01.

## 5. Session capacity reached

```bash
q 'sum by (status) (jtt_sessions_active)'
q 'max by (status) (jtt_sessions_oldest_status_age_seconds) / 60'
```

- Five `ACTIVE` sessions and five students working: the platform is full by
  design. There is no queue. Someone must end a lab.
- A slot held by `ENDING`, `EXPIRING`, `RESETTING` or `DEGRADED` for a long time:
  [RB-17](RB-17-session-lifecycle.md). That slot comes back when the session is
  unstuck, not by raising the cap.
- Raise `MAX_ACTIVE_SESSIONS` only if the host has room ([RB-19](RB-19-host-pressure.md))
  and the change is agreed for the beta: [RB-04](RB-04-capacity.md).

## 6. Restarting platform components safely

Look at §2 first, and restart one component at a time.

| Component | What students lose | Command | Check afterwards |
|---|---|---|---|
| api | In-flight requests. Sessions are durable; the reaper and the operations checks restart with it | `prod restart api` | `ready api 9400` |
| terminal | Every open shell; students reload the page | `prod restart terminal` | `ready terminal 9401` |
| sandboxd | Every container-track shell at once. **Not reflexively** — RB-01 §3 | `prod restart sandboxd` | `ready sandboxd 9402` |
| web | The site, for a few seconds; the certificate gate re-runs | `prod restart web` | `prod ps web` healthy; `q 'jtt_tls_check_status'` after 5 min |
| postgres | Everything, until it is healthy | `prod restart postgres` | `prod ps postgres` healthy; `ready api 9400` |
| prometheus, alertmanager, grafana | Nothing. Restart all three together: they share Prometheus's network namespace | `prod restart prometheus alertmanager grafana` | `alerts`; Grafana loads |
| Prometheus rules only | Nothing | `prod kill -s HUP prometheus` | `q 'up'` |
| Everything | Everything | `prod up -d` | §2 |

**Never** run `prod down -v`: `-v` deletes the PostgreSQL volume. To take the stack
down, `prod down` — and take a backup first
([postgres-backup-restore.md](postgres-backup-restore.md)).

## 7. Stuck sessions, cleanup, and the rest

| Symptom | Runbook |
|---|---|
| Sessions stuck in a status, resets failing | [RB-17](RB-17-session-lifecycle.md) |
| Cleanup stalled or erroring, leaks | [RB-05](RB-05-cleanup-and-leaks.md) |
| Sandbox runtime unhealthy | [RB-06](RB-06-sandboxd.md) |
| Database unhealthy | [RB-02](RB-02-database.md) |
| Certificate warning or failure | [RB-15](RB-15-tls-edge.md), [production-tls.md](production-tls.md) |
| Backup freshness or verification | [RB-16](RB-16-backups.md), [postgres-backup-restore.md](postgres-backup-restore.md) |
| Network isolation alarm | [RB-18](RB-18-network-isolation.md) |
| Host memory, disk, CPU | [RB-19](RB-19-host-pressure.md) |

Do not edit `lab_sessions` rows by hand. Every status change is a fenced
transition (BETA-P0-006/007); a hand edit can hand a sandbox to the wrong
teardown. The reaper recovers interrupted resets and ends; if it does not,
that is the incident.

## 8. DECISION REQUIRED

| Decision | Until it is made |
|---|---|
| **Where alerts are delivered** (a webhook, chat, paging, mail) and who is on call during the beta | Alerts are visible in Grafana and `amtool` only. The seam: `infrastructure/observability/alertmanager/secrets/webhook-url` |
| **An external reachability check** from outside the host (DNS, firewall, public route) | Only the in-host edge check runs. P0-017's `npm run tls:check` from another machine is the ready-made probe |
| **Host-level exporter** (node_exporter or similar) for per-disk, per-process and network detail | The API's `/proc` and statfs gauges cover memory, load, Docker's filesystem and the backup filesystem only. A node exporter needs the host root filesystem mounted into a container, which this story deliberately did not do |
| **A maintenance-mode launch gate** that refuses every Start Lab but keeps running labs — **post-P0-018 follow-up**, not built | None. §3's `MAX_ACTIVE_SESSIONS=1` only reduces new launches to one slot; it does not disable them |
| **Attestation re-probe cadence** and who runs it (P0-015 D5) | Manual, before `NetworkIsolationAttestationAging` |
| **Off-host backup destination and encryption** (P0-013) | `jtt_backup_last_success_offhost` reads 0 and the dashboard says NO |
| **CA / ACME client** (P0-017) | Manual renewal before `TlsCertificateRenewalDue` |
| **Long-term metric and log retention** | 15 days of Prometheus data; logs are container stdout |

## 9. Limitations

- The TLS edge check connects to the web container across the compose network.
  It proves nginx serves a valid certificate for `PUBLIC_ORIGIN`; it cannot see
  DNS, a firewall, or the public route (§8).
- Grafana answers a login page to the other containers on the default network
  (api, terminal, sandboxd, web). Anonymous access, sign-up and basic-auth API
  access are off and brute-force protection is on; Prometheus and Alertmanager
  are not reachable from them at all.
- Host metrics are read by the API container: `container_root` is Docker's
  storage. A host whose Docker data root or PostgreSQL volume is on a different
  filesystem from `/` inside containers reports only what Docker's root sees.
- Per-container CPU and memory are not measured (docs/observability.md §8).
- Pod Security admission denials (P0-016) show only as failed provisioning steps.
- No alert is proven to reach a person (§8).
- One host, one instance of each service: no failover.
