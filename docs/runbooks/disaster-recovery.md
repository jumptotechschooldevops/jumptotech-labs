# Disaster recovery: host loss, reboot, database loss, runtime loss

**A procedure runbook, not an alert runbook.** It ties together the pieces that
already exist — [postgres-backup-restore.md](postgres-backup-restore.md) (backup
and restore mechanics), [production-host-readiness.md §15, §17, §21](../development/production-host-readiness.md)
(deployment, drills, upgrade and rollback), [private-beta-operations.md](private-beta-operations.md)
(the `prod`, `q`, `ready`, `ops` helpers) — into one path an operator can follow
during an incident. It was written by the disaster-recovery audit
([report](../releases/overnight-disaster-recovery-audit.md)).

| | |
|---|---|
| **Proven** | Backup refusals and failure paths (stub suite, 167 cases); restore end to end against real PostgreSQL 16 (`make db-restore-drill`, CI); the migration rollback boundary and the empty-database signal (unit tests; the migrator was also run against PostgreSQL 17 in-process). |
| **Not proven** | Any of this on a real host, at production size, from an off-host copy. A replacement host has never been built. The drill in §9 is the plan for proving it. |

Every value in angle brackets is a placeholder. Nothing here contains, prints or
copies a secret value.

---

## 1. What must survive, and what may disappear

| Component | Where it lives | Class | How it comes back |
|---|---|---|---|
| Learning history: `students`, `lab_attempts`, `lab_progress`, `hint_usage` | PostgreSQL volume `<project>-postgres-data` | **MUST RESTORE** | archive → `db-restore.sh` |
| Accounts: `users`, `user_roles` | PostgreSQL | **MUST RESTORE** | archive |
| Migration ledger: `schema_migrations` | PostgreSQL | **MUST RESTORE** | archive; its first `applied_at` is how a restored database is told from a re-created one (§4.3) |
| Browser sign-ins: `auth_sessions` (SHA-256 of the cookie id, no token) | PostgreSQL | SHOULD RESTORE | archive; if lost, students simply sign in again |
| Session records: `lab_sessions` | PostgreSQL | SHOULD RESTORE | archive; stale rows are expired by the reaper at their deadline (§4.4) |
| `.env` — every platform secret and setting | host checkout, `0600` | **MUST RESTORE** — from the operator's secret store | **OPERATOR DECISION REQUIRED** (D9): where it is kept off the host |
| TLS certificate and key | `infrastructure/docker/nginx/tls/` | SHOULD RESTORE, or RECONSTRUCT by reissuing | D5/D9 |
| Scrape token, alert destination | `infrastructure/observability/secrets/`, `…/alertmanager/secrets/` | RECONSTRUCT (`make observability-token`; reinstall the destination) | D6 |
| Backup archives | `BACKUP_DIR` (e.g. `/srv/jumptotech/backups/postgres`) | **MUST exist off the host** | **OPERATOR DECISION REQUIRED** (D7): off-host destination, encryption, retention, access |
| Backup status files | `BACKUP_STATUS_DIR` | RECONSTRUCT (the next backup and verification write them) | — |
| Release: the checked-out commit | `/srv/jumptotech-labs` | RECONSTRUCT from Git at the recorded commit (§3) | — |
| Service images | built on the host from the checkout | RECONSTRUCT (`prod up -d --build`) | — |
| Sandbox images | `make sandbox-build` | RECONSTRUCT | — |
| kind cluster, kubeconfigs, NetworkPolicy attestation | Docker + `infrastructure/kind/generated/` | RECONSTRUCT (`npm run cluster:up`, then the §15 step 12 attestation) | — |
| Running sandboxes (containers, namespaces, their files) | Docker / kind | **EPHEMERAL** | never restored; students start the lab again |
| Terminal PTYs, per-session kubeconfigs | tmpfs | **EPHEMERAL** | recreated per session |
| Prometheus, Alertmanager, Grafana data | named volumes | EPHEMERAL (history only; rules and dashboards are in Git) | — |
| Evidence (`/srv/jumptotech/evidence/`), logs (`/var/log/jumptotech/`) | host | SHOULD be copied off the host with the incident record | D7 |
| Cron schedule (`/etc/cron.d/jumptotech-db`) | host | RECONSTRUCT from [private-beta-operations.md §1.2](private-beta-operations.md) | — |

The database archive deliberately contains no secret: no password, no token, no
key (proven by the drill). A restore therefore needs `.env` from somewhere else.

## 2. The secret recovery model

No value is recoverable from this repository. Each one is either restored from
the operator's secret store (**D9 — OPERATOR DECISION REQUIRED**) or regenerated.

| Secret | If it is regenerated on a replacement host | Restore or rotate? |
|---|---|---|
| `POSTGRES_PASSWORD` | Harmless when the database is restored into a **fresh** server: the image creates the role with the new password at first start, and the scripts never need it (they use the container's local socket). **Trap:** a surviving volume keeps the *old* role password, and the api then fails to connect (`DatabaseDown`). Set the role's password to the new value from inside the container with psql's interactive `\password <role>` over the local socket — never on a command line. | either |
| `TERMINAL_SESSION_SECRET` | Every terminal token in flight is refused; the workspace mints a new one on reconnect. | rotate freely |
| `INTERNAL_SERVICE_SECRET`, `SANDBOXD_*` secrets | Must match across api, terminal and sandboxd — they are all set from the same `.env`, so `prod up -d` applies a new value everywhere at once. | rotate freely |
| `NAMESPACE_DERIVATION_SECRET` | New sessions derive new names; existing `lab_sessions` rows keep the names they stored. Sandboxes of sessions live at the time are orphaned (`.env.example`). After a host loss there are none. | rotate after a host loss |
| `OIDC_CLIENT_SECRET` | Held by the identity provider; re-issue there if the old one is lost (D1/D3). Browser sign-ins in `auth_sessions` do not depend on it. | external |
| `OBSERVABILITY_SCRAPE_TOKEN`, `GRAFANA_ADMIN_PASSWORD` | `make observability-token`; Grafana's password is re-read at start. | rotate freely |
| TLS key | Reissue a certificate (production-tls.md §3) if the key is not in the secret store. | either (D5) |
| `RUNTIME_OWNER_ID` (not secret) | **Keep it.** It is the label that says which sandboxes this deployment may reclaim; a different value leaves any surviving sandbox unadopted. | restore |

**Sign-ins survive a secret rotation.** The `jtt_session` cookie is a random id
whose SHA-256 is stored in `auth_sessions`; no signing key is involved. They do
**not** survive a restore from an archive older than the sign-in (§4.4).

## 3. Which release, which configuration

After an incident the operator must be able to answer three questions:

| Question | Where the answer is | Gap |
|---|---|---|
| What was running? | `previous-commit` and the evidence directory written by §21.1 step 1; the host checkout's `git rev-parse HEAD`; `jtt_build_info{commit=…}` and each service's start-up log line (from `JTT_COMMIT` in `.env`) | `JTT_COMMIT` is typed by the operator; images carry no revision label (ci-and-release-gates.md §6 follow-up). After a host loss only what was copied off it survives: **record the running commit in the incident record and the off-host evidence**. |
| What am I restoring? | the archive name (`jtt-pg-<db>-<UTC start>[-<label>].dump`); `db-restore.sh` logs the archive's database and creation time, the row count of every table, and the migration ledger against this checkout (applied / pending / modified / unknown) | The archive records the **schema** version (its ledger), not the code commit that wrote it. Match it to a release by its migrations and its time. |
| Which configuration belonged to that release? | `.env.previous` (§21.1) beside the checkout; the `.env.example` and compose files of that commit | `.env` is not versioned. Keep a dated copy per release in the secret store (D9). |

## 4. Scenarios

### 4.1 Host reboot (nothing lost)

| Component | After `sudo reboot` | Operator action |
|---|---|---|
| postgres, api, web, terminal, sandboxd, prometheus, alertmanager, grafana | return by themselves (`restart: unless-stopped`) unless an operator had stopped them; api waits for a healthy database | none; confirm with the operations §2 health check |
| kind node `jumptotech-labs-control-plane` | restart policy `on-failure:1`, **not measured** after a reboot | if absent: `docker start jumptotech-labs-control-plane`, then `prod up -d --wait --wait-timeout 900` (production-host-readiness.md §17) |
| NetworkPolicy attestation | not measured whether it still validates | smoke `k8s.attestation`; re-prove per RB-18 if not |
| Running sandboxes | stay **stopped** (`--restart no`); what the student wrote is in the stopped container until Reset or End removes it | none |
| Students' sessions | rows survive in PostgreSQL, still ACTIVE, over stopped containers: the terminal cannot attach and Check answers `ENVIRONMENT_UNREACHABLE`. The reaper marks each **DEGRADED** ("needs a reset") on its second sweep once the platform is back (`jtt_reaper_recoveries_total{reason="sandbox_lost"}`) | tell students to press **Reset** (rebuilds the lab) or **End**; both were measured to work (reliability audit 2026-09-28) |
| Cron | runs again at its next slot | none |

**REAL-HOST VALIDATION REQUIRED** (drill D-6/D-7 of production-host-readiness.md §17).

### 4.2 Bad release (A healthy → B unhealthy)

Follow production-host-readiness.md §21. What decides the route back:

- **B shipped no migration:** code rollback only (`git checkout $(cat previous-commit)`,
  restore `.env.previous`, `prod up -d --build --wait --wait-timeout 900`).
- **B applied a migration:** A now **refuses to start** on that database
  (`The database records migration(s) this release does not ship: …`; added by
  this audit). That refusal is the rollback boundary: restore the `pre-migration`
  archive, or run A on the newer schema as an explicit decision with
  `DATABASE_ALLOW_NEWER_SCHEMA=true` (§21.2).
- `prod up --wait` exiting non-zero **is** the health failure. The smoke's
  `release.commit` then confirms which commit each service reports.

Every migration to date (001–007) is additive — new tables, columns and indexes,
a backfill of one new column, a widened `CHECK`, and a sequence-defaulted
`shell_uid` column (007). None drops or rewrites data, so the data-loss risk of
a rollback is only what was written after the backup. Running pre-007 code on a
007 schema with `DATABASE_ALLOW_NEWER_SCHEMA=true` works (the column fills
itself), but that terminal runs every student's shell as one shared uid: the
per-session isolation of SEC-ARCH-2 is gone until the release matches again.

### 4.3 Database lost or corrupt; host intact

1. **Stop writes:** `prod stop api`. (The api is the only database client.)
2. **Corrupt, not lost:** preserve the volume first (postgres-backup-restore.md §7.3).
3. **Lost:** `prod up -d postgres` re-creates an empty database.
4. **Do not start the api yet.** If it has already started against the empty
   database, it logged `WARNING: initialised an EMPTY database`, exported a ledger
   start newer than the last backup, and `DatabaseRecreatedSinceLastBackup` fires
   ([RB-02 §4d](RB-02-database.md)). The nightly `db-backup.sh` now **refuses** to
   back that database up, so retention cannot age the good archives out.
5. Select, verify and inspect the newest archive; `--replace` (postgres-backup-restore.md §6, §7.1).
6. `prod up -d --wait`; validate (§6 below).

**Split brain.** Anything students wrote between the re-creation and the restore
lives only in the `jumptotech_labs_prerestore_<ts>` database `--replace` keeps.
Sandboxes that survived have no session row after a restore from an older
archive; the reaper leaves each until its own expiry label plus 60 s, then
removes it (only those labelled with this `RUNTIME_OWNER_ID`). Restored session
rows that describe sandboxes that no longer exist count toward capacity until
the reaper expires them at their deadline (at most `MAX_SESSION_MINUTES` after
creation) — postgres-backup-restore.md §8.

### 4.4 Runtime lost; database intact

Docker's data, the kind cluster or the sandbox containers are gone; PostgreSQL
is not.

- **Progress survives.** It is in PostgreSQL.
- **Session rows become stale.** A student's terminal fails to attach and Verify
  cannot reach the sandbox. The reaper expires each session at its idle or
  absolute deadline; attempts are closed as `EXPIRED` by the abandoned-attempt
  sweeper. To free a student at once: `ops sessions`, then `ops end <id> --yes`
  (private-beta-operations.md §7).
- **New labs** start once the provider is back: `make sandbox-build` for missing
  images, `npm run cluster:up` and the attestation (§15 steps 7–12) for Kubernetes.
- **Unlabelled leftovers** are never adopted; RB-05.

### 4.5 Host permanently lost

§5 below, from step 5.

## 5. Complete host recovery procedure

Record every step's output in the incident record (§7). Stop at the first
unexpected result and escalate (postgres-backup-restore.md §6.8).

**Identify and contain**

1. **Identify the incident.** Which of §4.1–4.5? Time it started; alerts firing
   (`alerts`); what students report. Open the incident record.
2. **Stop unsafe writes.** If the database may be wrong or empty: `prod stop api`.
   If only launches are the risk: `LAB_LAUNCHES_PAUSED=true`, `prod up -d api`
   (private-beta-operations.md §3). Tell the cohort.
3. **Determine the current release:** `git rev-parse HEAD` on the host (if it
   exists), `previous-commit`, the last evidence directory, the off-host incident
   notes. Write the commit down.
4. **Determine backup availability:** the newest archive and its `.sha256` on the
   host (`ls -1 "$BACKUP_DIR"/jtt-pg-*.dump | tail -5`) and in the off-host copy
   (D7). No off-host copy after a host loss means no backup: stop and escalate.
5. **Validate the backup** you intend to use — on any machine with Docker, before
   touching production: `scripts/db-restore.sh --verify-only <archive>`, then
   `--into jumptotech_labs_check_<date>` on a disposable server
   (`JTT_DB_CONTAINER=<a disposable postgres:16-alpine>`) and inspect it
   (postgres-backup-restore.md §6.3). Note its newest `lab_attempts.started_at`:
   that is the data loss.

**Prepare the host**

6. **Replacement or repaired host:** production-host-readiness.md §15 steps 1–4
   (packages, `jtt-ops`, firewall, directories `0700`/`0755`), and **check out the
   commit from step 3**, not `main`.
7. **Restore configuration:** `.env` from the secret store, `0600`, owned by
   `jtt-ops`. Keep `RUNTIME_OWNER_ID`. Set `JTT_COMMIT` to `git rev-parse HEAD`.
   Never paste a value into a terminal log or the incident record.
8. **Restore or reissue secrets:** TLS files (`make tls-install CERT=… KEY=…`),
   `make observability-token`, the alert destination (D6). `make secrets-check`.
9. **Rebuild the runtime:** `npm run cluster:up`, `make sandbox-build`, the
   NetworkPolicy attestation (§15 step 12), `make production-config-check`,
   `make production-preflight`.

**Restore the data**

10. **Start only the database:** `prod up -d postgres`. Not the whole stack: an api
    that starts now initialises an empty database.
11. **Restore:** copy the verified archive and sidecar into `BACKUP_DIR`, then
    `scripts/db-restore.sh --replace jumptotech_labs <archive>` and type the name.
    Read the migration report it prints: **unknown** means the archive is newer
    than this checkout — check out the matching release (§3) instead of setting
    `DATABASE_ALLOW_NEWER_SCHEMA`.

**Bring it back and prove it**

12. **Start services:** `prod up -d --build --wait --wait-timeout 900`; `prod ps`.
13. **Verify health:** operations §2; `ready api 9400`; the api log line
    `schema up to date` or `applied N migration(s)` — and **not**
    `initialised an EMPTY database`. `DatabaseRecreatedSinceLastBackup` quiet.
14. **Private-beta smoke:** `make private-beta-smoke ARGS="--report-dir /srv/jumptotech/evidence"`
    (every line PASS except `backup.offhost` until D7).
15. **Student access:** a beta account signs in; a non-beta account is refused at
    the provider.
16. **Progress:** that student's dashboard shows the history the archive holds
    (compare with step 5).
17. **New lab launch:** LINUX-001 and K8S-001 start; the terminal opens; Check
    runs; End returns active sessions to 0.
18. **Orphan and stale state:** `ops status`, `ops sessions`; `q 'jtt:sandbox_leak:count'`;
    RB-05 for anything the reaper does not reclaim.
19. **Re-establish backups:** install `/etc/cron.d/jumptotech-db`; run one
    `scripts/db-backup.sh --label post-recovery` by hand and confirm
    `db-backup.last-success`; confirm the off-host copy (D7).
20. **Observe** alerts and the dashboard for an hour, then point DNS or the
    tunnel at the host if it is new (D4).
21. **Record evidence** in [disaster-recovery-drill-evidence-template.md](../releases/disaster-recovery-drill-evidence-template.md)
    and close the incident only after step 19.

## 6. Recovery point and recovery time

The **targets** are an **OPERATOR DECISION REQUIRED**. postgres-backup-restore.md
§4 proposes 24 h / 4 h for the private beta; nothing has measured the 4 h.

| Controls the RPO (data that can be lost) | Controls the RTO (time to recover) |
|---|---|
| backup frequency (one cron line a day today) | whether a replacement host exists or must be provisioned (D2) |
| whether the newest archive left the host before it was lost (D7) | fetching the archive from off-host storage (D7) |
| whether backup failures reach a person (D6) — a silently failing job turns a 24 h RPO into weeks | image builds (`prod up --build`), `cluster:up`, sandbox images |
| a `pre-migration` / `pre-restore` archive before planned changes | restore time: 2 s for 27 KB in the drill; production size unmeasured |
| no WAL archiving or point-in-time recovery (not built) | the validation steps (§5 13–18) and a person available with Docker access and the secrets |

## 7. Recovery evidence

Use [disaster-recovery-drill-evidence-template.md](../releases/disaster-recovery-drill-evidence-template.md)
for both real incidents and drills. It records no secret values.

## 8. Operator decisions this procedure depends on

| Id | Decision | Blocks |
|---|---|---|
| D7 | Off-host backup destination, encryption (key or recipient held off the host), retention, access control, how an archive is retrieved, and how often a retrieved copy is restored | §4.5, §5 step 4; every host-loss recovery |
| D9 | Where `.env`, the TLS key and each release's configuration copy are kept off the host, and who can read them | §5 steps 7–8 |
| D10 | Who holds Docker access on the host (root-equivalent; both backup scripts need it) | every step |
| D6 | Where alerts go (backup failures, `DatabaseRecreatedSinceLastBackup`) | the RPO |
| D2 | Replacement host: pre-provisioned, or built on demand | the RTO |
| — | RPO and RTO targets; restore-test cadence on real data | §6 |
| — | Managed PostgreSQL: if the database leaves the host, these scripts no longer apply | postgres-backup-restore.md §10 |

## 9. Real-host recovery drill (plan; never run)

Run it before students are invited and after every change to the backup path,
with no students active. **Nothing here restores over production.** Record it in
the evidence template.

**A. Non-destructive — on the production host**

1. `scripts/db-backup.sh --label drill-<date>`; `db-backup.last-success` written.
2. The off-host copy: the `BACKUP_COPY_HOOK` ran (`offhost_copy=copied` in the
   status file) and the copy exists at the destination with a matching checksum (D7).
3. `scripts/db-restore.sh --verify-only <archive>` on the host.

**B. Non-destructive — on a separate machine (a disposable host or a laptop with Docker)**

4. Retrieve the archive **and** its `.sha256` from the off-host copy, not from the
   production host.
5. Start a disposable `postgres:16-alpine`, then `JTT_DB_CONTAINER=<it> scripts/db-restore.sh --into jumptotech_labs_drill <archive>`.
6. Compare with production: row counts per table, newest `lab_attempts.started_at`,
   `schema_migrations` versions.
7. Time steps 4–6: the measured restore component of the RTO.

**C. Full-stack recovery — on a disposable replacement host (never the production host)**

8. Follow §5 steps 6–13 with the retrieved archive and a test copy of `.env`
   pointing at a **test** hostname and a test identity-provider client.
9. A test student signs in; their existing progress is shown.
10. A new lab launches (LINUX-001); the terminal works; Verify runs; End returns
    active sessions to 0.
11. `DatabaseRecreatedSinceLastBackup` stays quiet; the api log does not say
    `initialised an EMPTY database`.
12. Record the total time: the full RTO.

**D. Destructive — only on the disposable host from C, never on production**

13. `prod stop api`; move the database aside with `db-restore.sh --replace` from the
    same archive (renames, never drops); start; validate as in 9–10.
14. Roll the swap back (postgres-backup-restore.md §6.6) and validate again.
15. Tear the disposable host down with the provider's tools once the evidence is
    saved; never with `prod down -v` on a host that holds anything else.
