# Disaster-recovery drill / incident evidence

Copy this file into the incident record or `/srv/jumptotech/evidence/dr-<date>/`
and fill it in on the host. The procedure is
[docs/runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md) (§5 for an
incident, §9 for a drill).

**Never write a secret here**: no password, token, key, connection string or
`.env` line. Record *that* a value was restored and from where, never the value.

## 1. The run

| Field | Value |
|---|---|
| Date (UTC) and start time | |
| Kind (drill A/B/C/D, or incident §4.1–4.5) | |
| Operator(s) | |
| Second person reviewing | |
| Source host | |
| Replacement / target host (or disposable server) | |
| Students active during the run? (must be no for a drill) | |

## 2. Releases

| Field | Value |
|---|---|
| Source release SHA (what was running; `previous-commit`, `jtt_build_info`) | |
| How the source SHA was established | |
| Target release SHA (`git rev-parse HEAD` on the target) | |
| `JTT_COMMIT` in the target `.env` equals the target SHA | yes / no |
| Configuration copy used (secret-store entry name and date, not its content) | |

## 3. The backup

| Field | Value |
|---|---|
| Archive name (`jtt-pg-<db>-<UTC>[-<label>].dump`) | |
| Archive creation time (from the name / `db-restore.sh` log) | |
| Retrieved from (host `BACKUP_DIR` / off-host destination) | |
| SHA-256 matched the sidecar | yes / no |
| `db-restore.sh --verify-only` result | PASS / FAIL |
| `--into` check database: tables and row counts noted | |
| Newest `lab_attempts.started_at` in the archive (the data loss boundary) | |
| Migration report: applied / pending / modified / unknown | |

## 4. The restore

| Field | Value |
|---|---|
| Restore command (mode and target only) | |
| Restore start (UTC) | |
| Restore end (UTC) | |
| Result | PASS / FAIL |
| Previous database kept as (`<db>_prerestore_<ts>`) | |
| api log: `schema up to date` / `applied N migration(s)` (and NOT `initialised an EMPTY database`) | |
| `DatabaseRecreatedSinceLastBackup` quiet | yes / no |

## 5. Service health

| Check | Result | Evidence file |
|---|---|---|
| `prod ps`: every service running and healthy | | |
| operations §2 health check | | |
| `ready api 9400`, `ready terminal 9401`, `ready sandboxd 9402` | | |
| `make private-beta-smoke` RESULT (and which lines were not PASS) | | |
| kind node Ready; attestation valid | | |

## 6. Students

| Check | Result | Notes |
|---|---|---|
| A beta account signs in | | |
| A non-beta account is refused at the provider | | |
| That student's existing progress is shown (matches §3) | | |
| New lab launch (LINUX-001; K8S-001 if the cluster was rebuilt) | | |
| Terminal opens and accepts input | | |
| Verify (Check) runs and reports | | |
| End returns active sessions to 0 | | |

## 7. Cleanup and follow-through

| Check | Result |
|---|---|
| `ops status` / `ops sessions`: no stale session blocks capacity | |
| `jtt:sandbox_leak:count` at baseline | |
| Check databases (`jumptotech_labs_check_*`) removed after acceptance | |
| `db-backup.sh --label post-recovery` succeeded; off-host copy confirmed | |
| Cron schedule installed / unchanged | |
| Disposable servers and hosts torn down (drill) | |

## 8. Alerts

| Alert | Fired? | Expected? | Resolved at |
|---|---|---|---|
| | | | |

## 9. Timings (the measured RTO)

| Phase | Start | End | Duration |
|---|---|---|---|
| Decision to recover → host ready | | | |
| Archive retrieved and verified | | | |
| Restore | | | |
| Stack up and healthy | | | |
| Students validated | | | |
| **Total** | | | |

## 10. Observations and failures

- What surprised you:
- What failed, with the exact output (secrets redacted):
- Runbook steps that were wrong or missing:
- Follow-up issues opened:
