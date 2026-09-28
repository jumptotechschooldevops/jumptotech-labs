# Overnight disaster-recovery audit

| | |
|---|---|
| **STARTING COMMIT** | `24e09f132d522b8de713e696bd0a682f3be74d93` (origin/main, merge of PR #54) |
| **BRANCH** | `feat/overnight-disaster-recovery` (350c9bd), never pushed; its eight commits were re-applied unchanged onto main 92c0aaf on 2026-09-27 as `fix/disaster-recovery-guards`. Findings below are as of 24e09f1; migration `006_access_entitlements` landed after the audit and is added to §5. |
| **AUDIT DATE** | 2026-09-21 / 22 (UTC) |
| **Question** | If JumpToTech Labs fails, can an operator recover it safely? |
| **Method** | Static reading of every backup, restore, migration, release, rollback and operations script and runbook; deterministic tests with fake `docker`/`psql`/`pg_dump`/`pg_restore`; unit tests with a scripted SQL session; `promtool test rules`; the migrator and one new SQL expression run against PostgreSQL 17 compiled to WASM (PGlite, in-process, scratch directory only). **No Docker container, kind cluster, compose stack, image, volume or shared port was started, changed or removed.** |

The new operator procedure is [docs/runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md);
the evidence template is [disaster-recovery-drill-evidence-template.md](disaster-recovery-drill-evidence-template.md).

---

## 1. Answers to the twenty questions

| # | Question | Answer, with evidence |
|---|---|---|
| 1 | What must survive a host failure? | The PostgreSQL application database (learning history, accounts, migration ledger; sign-ins and session rows are SHOULD), `.env`, the TLS key (or a reissue), and the backup archives — off the host. Inventory: disaster-recovery.md §1. |
| 2 | What may safely disappear? | Sandboxes and everything in them, terminal PTYs and per-session kubeconfigs, images, the kind cluster (rebuilt), monitoring history, backup status files. §1 there. |
| 3 | Can PostgreSQL be backed up correctly? | Yes, on the evidence available. `pg_dump --format=custom` inside the server's own container; read back in full (`pg_restore --file=/dev/null`, which catches truncation and corruption `--list` misses); checksummed on both sides of the copy; atomic rename; lock; 0700/0600. 167 stub cases (was 132); the drill passes on real PostgreSQL 16 in CI. Two defects fixed (D1, D5). |
| 4 | Can a backup actually be restored? | Yes against real PostgreSQL 16 in CI (`make db-restore-drill`: fingerprint of every table, schema, sequence and ledger identical after `--replace`). **Never on a real host, at production size, or from an off-host copy.** |
| 5 | Can corrupted, truncated or wrong backups be detected? | Truncated, corrupted-after-TOC, zero-byte/random (not `PGDMP`), non-custom-format, and non-application (no `schema_migrations` data) archives are refused before any change; a sidecar mismatch is refused before the server is contacted. A backup of the **wrong database state** — an empty database re-created after a volume loss — was not detected; now it is (D3, D5). |
| 6 | Can restoration accidentally overwrite a healthy database? | No path drops or overwrites: no default mode; `--into` only creates a new database; `--replace` requires the typed name, refuses while any session is connected, restores into staging, and swaps names in one transaction, keeping the old database. The one misleading outcome — a committed swap reported as "restore FAILED" — is fixed (D4). |
| 7 | Are backup failures visible? | Yes when the observability overlay runs and alerts are delivered: status files → `BackupStale`, `BackupMissedTwice`, `BackupLastRunFailed`, `BackupNeverSucceeded`, `BackupStatusUnreadable`, `BackupVerifyFailed`. Delivery is D6 (**OPERATOR DECISION REQUIRED**). A run refused before its trap is installed (argument errors) records nothing; freshness still catches it. |
| 8 | Are backups expected to leave the host? | Yes, and the runbooks say plainly that a local copy is not disaster recovery. `BACKUP_COPY_HOOK` is the provider-neutral seam; its failure fails the run; the status file records `offhost_copy=copied|not_configured`; the smoke's `backup.offhost` FAILs until one is proven. The destination itself is D7. |
| 9 | Is encryption responsibility clear? | Yes: archives are not encrypted by the repository; encryption before or during the off-host copy, with a key held off the host, is D7 (postgres-backup-restore.md §5.5). |
| 10 | Can operators determine what version they are restoring? | Partly. `db-restore.sh` logs the archive's database, creation time, row counts and its migration ledger against the checkout (applied / pending / modified / unknown). The archive records the **schema** version, not the code commit. disaster-recovery.md §3. |
| 11 | Can the application be upgraded safely? | Procedure ready and never run on a host (production-host-readiness.md §21.1): record commit and `.env`, backup + verify, config check, preflight, `up --wait`, smoke `release.commit`. |
| 12 | Can database migrations be applied safely? | Yes: one transaction per file, checksum ledger, advisory lock, forward-only, nothing in the runner drops. All five migrations are additive (§5 below). |
| 13 | Can application rollback occur after a migration? | Now only as a decision. Before, the previous release **started silently** on a schema a newer release had migrated (the migrator skipped unknown versions). Fixed (D2): production refuses; `DATABASE_ALLOW_NEWER_SCHEMA=true` is the explicit override; the other route is the `pre-upgrade` restore. |
| 14 | Can operators recover from a bad deployment? | Procedure ready (§21.2 table, now accurate for migrated databases). `prod up --wait` non-zero is the health signal; the previous commit is in `previous-commit`. Images are rebuilt from the checkout; they carry no revision label (residual R3). |
| 15 | Can operators recover after host reboot? | Platform services return (`unless-stopped`, proven by config checks). The kind node (`on-failure:1`) and the attestation after a reboot are **unmeasured** — REAL-HOST VALIDATION REQUIRED. disaster-recovery.md §4.1. |
| 16 | Can secrets and configuration be reconstructed? | Only from the operator's secret store (D9); nothing is recoverable from Git by design. The regeneration consequences of each secret are now documented, including the surviving-volume `POSTGRES_PASSWORD` trap (disaster-recovery.md §2). |
| 17 | Can students' progress survive recovery? | Up to the RPO, yes — it is all in the archive. After this audit, an api that comes back on an empty volume is loud about it (D3) and the nightly backup refuses to bury the good archives (D5). |
| 18 | What happens to active lab sessions after disaster? | Sandboxes are not restored. Restored session rows are expired by the reaper at their deadline; surviving sandboxes without a row are reclaimed after their own expiry label + 60 s (owner-labelled only); `ops end <id> --yes` frees a student at once. disaster-recovery.md §4.3–4.4. |
| 19 | Can a replacement host be reconstructed? | A deterministic 21-step procedure exists from repository evidence (disaster-recovery.md §5). It has never been executed. |
| 20 | What remains an external/operator decision? | D2 host, D6 alert delivery, D7 off-host destination / encryption / retention / access, D9 secret and configuration storage, D10 Docker access, RPO/RTO targets, restore-test cadence, managed PostgreSQL. §16 below. |

## 2. PERSISTENT DATA INVENTORY

| Data | Class | Recovery |
|---|---|---|
| `students`, `lab_attempts`, `lab_progress`, `hint_usage`, `users`, `user_roles`, `schema_migrations` | MUST RESTORE | archive |
| `auth_sessions`, `lab_sessions` | SHOULD RESTORE | archive (re-sign-in / reaper otherwise) |
| `.env` | MUST RESTORE | operator secret store — OPERATOR DECISION REQUIRED (D9) |
| TLS certificate and key | SHOULD RESTORE or reissue | D5/D9 |
| Backup archives + sidecars | MUST exist off host | OPERATOR DECISION REQUIRED (D7) |
| Evidence and logs | SHOULD copy off host | with the incident record |
| `RUNTIME_OWNER_ID` | MUST keep | `.env` |

## 3. EPHEMERAL DATA INVENTORY

Sandboxes (containers, namespaces, networks, files), terminal PTYs and
per-session kubeconfigs (tmpfs), Prometheus/Alertmanager/Grafana data, backup
status files (rewritten by the next run). RECONSTRUCT: images, sandbox images,
kind cluster and kubeconfigs, attestation, scrape token, cron schedule.

## 4. Backup and restore

### BACKUP IMPLEMENTATION

`scripts/db-backup.sh` + `scripts/db-lib.sh`. `set -Eeuo pipefail`, `set +x`,
`umask 077`; no credential read or passed (local socket in the server's
container); custom format, compression 6; staging inside the container outside
the data volume; full read-back; SHA-256 inside and outside the container; copy
to `.<name>.partial`, then `mv` in the same directory; lock directory with stale
detection; UTC second-resolution names that refuse to overwrite; destination
refused inside Docker's/PostgreSQL's storage or any mount of the database
container, **and now inside the checkout outside `backups/` (D1)**; retention
after success only; status record last. **New (D5):** refuses a database whose
history begins after the newest archive.

### BACKUP VALIDATION

What a successful exit proves: the archive was dumped without error, every data
block decompresses in the server's own `pg_restore`, it is custom format, it
carries `schema_migrations` data, and the bytes on the host equal the bytes
verified. It does **not** prove the data is the right data (a database
re-created empty passes all of that — D3/D5 address it), or that it restores at
production size.

### RESTORE IMPLEMENTATION

`scripts/db-restore.sh`: `--verify-only`, `--into NEW`, `--replace DB`; no
default. Sidecar check before the server is contacted; in-container checksum;
TOC and full read before any change; `--exit-on-error --single-transaction`;
post-restore check that every archived table is present and the ledger is
non-empty; `--replace` confirmation, session refusal (twice), same encoding and
collation, one-transaction swap, nothing dropped, undo command printed.

### RESTORE VALIDATION

Stub suite (no daemon) for every refusal; the drill against real PostgreSQL 16
for the whole path. **D4** fixed: after the swap commits, a failed follow-up step
no longer reports "restore FAILED".

### CORRUPTION HANDLING

| Input | Where refused | Proven by |
|---|---|---|
| missing file / not a regular file / unreadable | before the server | stub |
| empty or random file (no `PGDMP`) | `pg_restore --list` | stub |
| checksum mismatch | before the server | stub |
| no sidecar | refused unless `--allow-missing-checksum` (still read in full) | stub |
| truncated after the TOC | full read (`--file=/dev/null`) | stub + drill (real, last 64 bytes cut) |
| corrupted data with a matching sidecar | full read | drill (real) |
| not custom format | TOC `Format: CUSTOM` | stub |
| not the application database | no `schema_migrations` data | stub |
| altered on the way into the container | in-container checksum | stub |
| failed `pg_dump`, failed copy out, failed hook | non-zero, nothing kept | stub |
| relative / invalid destination, bad retention values, bad label | before the server | stub |

### RETENTION SAFETY

Only this database's regular files named exactly as the script names them;
never symlinks or other files; the newest `BACKUP_RETENTION_MIN_KEEP` always
kept; the archive just written always kept; age from the name, not mtime; runs
only after a verified, copied, hooked backup; `0` disables. A clock jump forward
cannot go below MIN_KEEP; a jump backward removes nothing. **The gap was which
archive counts as good** — a backup of a re-created, empty database counted
toward MIN_KEEP and pushed good archives out (D5, fixed).

### OFF-HOST BACKUP CONTRACT

Clear in the runbooks: local copy is not DR; the hook must copy both files,
confirm the remote checksum, exit non-zero on failure, and take credentials from
elsewhere; the destination needs its own retention and access control and must
not be writable by anything that can delete the originals. Destination,
provider, encryption key, retention period and credentials: **OPERATOR DECISION
REQUIRED (D7)**. Nothing invented here.

### BACKUP SECURITY

Archives `0600` in a `0700` directory; the password never in names, logs,
arguments or content (sentinel in the stub suite; real password in the drill);
status files carry only timestamp, size, off-host flag; the status directory can
never be, contain or sit inside the archive directory (it is mounted into the
api). Git ignores `/backups/` and `*.dump*` everywhere. **D1:** the Docker build
context ignored only the root `backups/`, and nothing stopped a `BACKUP_DIR`
elsewhere in the checkout — including `infrastructure/docker/nginx/acme-webroot/`,
served on port 80, and `labs/`, mounted into the api. Fixed in the script and in
`.dockerignore`.

## 5. Migrations, compatibility and rollback

### MIGRATION SAFETY

| Migration | What it does | Destructive? | Transaction | Rollback of code afterwards |
|---|---|---|---|---|
| 001_progress | creates learning-history tables | no | one per file | n/a (base) |
| 002_sessions | creates `lab_sessions` + indexes | no | yes | older code ignores the table |
| 003_users_and_ownership | creates `users`, `user_roles` (seeded), adds nullable `lab_sessions.owner_user_id` | no | yes | additive |
| 004_auth_sessions | creates `auth_sessions` | no | yes | additive |
| 005_session_recovery | adds `status_changed_at` (backfilled, NOT NULL with default), widens the status `CHECK` to include `DEGRADED` | no data removed; the CHECK is dropped and re-added in the same transaction | yes | pre-005 code inserts work (default); it may meet `DEGRADED` rows it does not know |
| 006_access_entitlements (after this audit) | creates `access_entitlements`, `access_events`, index `users_by_lower_email` | no | yes | additive; pre-006 code ignores the tables, and with D2 the production api refuses to start on it unless `DATABASE_ALLOW_NEWER_SCHEMA=true` |
| 007_session_shell_uid (SEC-ARCH-2, after this audit) | creates `lab_session_shell_uid_seq` (1900000000–1900999999, `NO CYCLE`) and adds `lab_sessions.shell_uid` (`NOT NULL`, `DEFAULT nextval`, range `CHECK`, `UNIQUE`); existing rows get distinct values | no | yes | pre-007 code inserts work (the default assigns the uid) and ignores the column; with D2 the production api refuses to start on it unless `DATABASE_ALLOW_NEWER_SCHEMA=true`. A terminal that runs shells per uid needs a post-007 api, so roll the terminal back with it |

Ordering by numeric prefix; names validated; immutability enforced by checksum;
concurrent starts serialised by an advisory lock; repeat execution is a no-op; a
failing file rolls back and the api refuses to start. No migration requires
downtime beyond the api restart that applies it.

### FORWARD/BACKWARD COMPATIBILITY

- **New application + old schema:** the new api applies the pending files at
  start (`DATABASE_AUTO_MIGRATE=true`), so they never coexist for long. With
  auto-migrate off, the new api starts on the old schema; `db:status` shows
  PENDING.
- **Old application + new schema:** was silently allowed. Now refused in
  production (D2) unless `DATABASE_ALLOW_NEWER_SCHEMA=true`. The rollback
  boundary is therefore exactly: *the first release that applied a migration the
  target release does not ship*. Crossing it means restoring the `pre-upgrade`
  archive (data written since is lost) or an explicit override after reading the
  migration. Compatibility is claimed for no pair of releases; every migration
  to date is additive, which makes the override plausible, not proven.

### RELEASE ROLLBACK

`version A → deploy B → B unhealthy`: detected by `prod up --wait` non-zero and
the smoke; the operator stops by not proceeding (compose has no staged rollout
— one host, one stack); returns to A via `git checkout $(cat previous-commit)`,
`npm ci`, `.env.previous`, `prod up -d --build --wait`; A is identified by the
recorded commit, `JTT_COMMIT` and `jtt_build_info`. The contradiction found — the
§21.2 table promised a code rollback "starts without complaint" after a
migration and relied on the operator to remember the restore — is now enforced
by the migrator and the table is rewritten.

### CONFIGURATION ROLLBACK

Compose, nginx, service configuration and scripts are in Git at the release
commit; TLS installs keep and restore the previous certificate
(`tls-install.sh`); `.env` rollback is `.env.previous`, kept by convention only,
and after a host loss only what the secret store holds (D9). No versioning of
`.env` per release exists: residual R4.

### SECRET RECOVERY MODEL

disaster-recovery.md §2: every secret restored from the store or regenerated;
sign-ins survive rotation (hashed random cookie ids, no signing key); terminal
tokens do not (reconnect mints a new one); a regenerated `POSTGRES_PASSWORD` on
a **surviving** volume breaks the api's connection until the role's password is
changed over the local socket; `RUNTIME_OWNER_ID` must be kept. Storage location:
**OPERATOR DECISION REQUIRED (D9)**.

## 6. Scenarios

### HOST-LOSS RECOVERY

disaster-recovery.md §5: 21 steps from identification to evidence, restoring the
database **before** the api first starts. Blocked in reality by D7 (no off-host
copy exists) and D9. Never executed: REAL-HOST VALIDATION REQUIRED.

### HOST-REBOOT RECOVERY

Automatic: every platform service. Unmeasured: the kind node and the attestation.
Must reconcile: nothing by hand for sessions (the reaper). §4.1 there.

### DATABASE-LOSS RECOVERY

Before this audit the api, restarted on an empty volume, initialised it and
served empty dashboards with every health signal green (RB-02 §6 even named the
migration version as proof it was not a fresh volume); the next backup archived
the empty database and retention began ageing the real ones out. Now: a startup
WARNING, `DatabaseRecreatedSinceLastBackup` (critical), and a backup that
refuses. Split brain after restore (writes in the gap, surviving sandboxes,
stale session rows) is documented in §4.3 there.

### RUNTIME-LOSS RECOVERY

Progress survives; session rows go stale and are expired at their deadline;
`ops end` frees a student immediately; new labs need the provider rebuilt.
Code-inspection evidence only (reaper orphan logic, `reaper.ts` grace and label
checks); no destructive Docker test was run.

## 7. OPERATOR ERROR GUARDRAILS

Kept and verified: `make clean` and `make db-up`/`up`/`rebuild` refuse on a
production checkout (`refuse-on-production.sh`); no `db-restore` make target;
`--replace` typed confirmation; system databases refused; identifiers validated
before interpolation; empty `--into ""` / `--replace ""` refused by the
identifier check; `make db-backup-verify` without `FILE` refused; relative paths
refused; the runbook contract tests forbid destructive commands in any runbook
code block and bare `docker compose` for production. Added: D1 (a mistyped or
"convenient" `BACKUP_DIR` inside the checkout), D2 (rollback onto a newer
schema needs a typed decision), D5 (`BACKUP_ACCEPT_NEW_DATABASE` must be exactly
`true`/`false`).

## 8. OBSERVABILITY

An operator can tell: last backup succeeded / failed / stale, verification
failed, status unreadable, never succeeded — and now, database re-created since
the last backup (`jtt_database_ledger_started_timestamp_seconds`). They cannot
tell from metrics whether a **restore drill** (`--into` on real data) was done
recently: only the weekly `--verify-only` is recorded. Residual R6.

## 9. RECOVERY EVIDENCE

[disaster-recovery-drill-evidence-template.md](disaster-recovery-drill-evidence-template.md):
date, operator, hosts, source/target SHA, backup identity, creation time,
validation, restore start/end/result, health, smoke, authentication, progress,
launch, terminal, Verify, End, cleanup, alerts, timings, failures. No secrets.

## 10. DEFECTS FOUND and DEFECTS FIXED

Six defects proven, five fixed in code (D3 has a code and a documentation part),
one residual accepted (R1, Low).

### D1 — Backups could be written into build contexts, service mounts and the public web root

| | |
|---|---|
| **SEVERITY** | Medium (student PII exposure on a plausible operator mistake) |
| **INVARIANT** | A backup archive is never written where an image build, a service mount or the public web root can reach it. |
| **EVIDENCE** | With `BACKUP_DIR=<checkout>/infrastructure/docker/nginx/acme-webroot/.well-known` (served on port 80), `<checkout>/labs/...` (mounted into the api), `<checkout>/apps/api/backups` and `<checkout>/services/progress` (copied by `COPY <workspace>`), `db-backup.sh` exited 0 and wrote the archive: 18 new stub assertions failed before the fix. `.dockerignore` excluded only the root `backups/`. |
| **ROOT CAUSE** | The destination checks covered only the database's own storage. |
| **FIX** | Refuse a `BACKUP_DIR` inside the checkout outside `backups/`, as given (before the server is contacted) and once resolved (`..`, symlinks). `.dockerignore`: `**/*.dump`, `**/*.dump.sha256`, `**/*.dump.partial`. |
| **REGRESSION TEST** | `scripts/test-db-backup-restore.sh` (20 cases, run against a temporary copy of the scripts so nothing is written into this checkout); `services/observability/test/build-context-secrets.test.ts` (negative control: fails without the `.dockerignore` lines). |
| **COMMIT** | `a39bf60` |

### D2 — A code rollback after a migration started silently on the newer schema

| | |
|---|---|
| **SEVERITY** | High (rollback safety; the documented procedure depended on the operator remembering a restore) |
| **INVARIANT** | Production code never starts against a schema a newer release migrated, unless the operator decided it. |
| **EVIDENCE** | `applyPending` looked up only shipped files in the ledger; a recorded `006_*` was never compared. The new unit test showed 002 applied on a database recording 003 from a newer release. The production-operations report (row 19) had found this and only corrected the docs. |
| **ROOT CAUSE** | The migrator checked modified migrations, not unknown ones. |
| **FIX** | Refuse unknown versions before applying anything, naming them and the two ways forward; `allowNewerSchema` option; api maps `DATABASE_ALLOW_NEWER_SCHEMA` (default false under `NODE_ENV=production`, true elsewhere with a warning); `db:migrate` refuses unless set; `db:status` lists UNKNOWN; compose passes the variable; `.env.example`, §21.2, restore runbook and `db-lib.sh` messages updated. |
| **REGRESSION TEST** | `services/progress/test/migration-rollback-boundary.test.ts` (4 cases); `apps/api/test/database-rollback-boundary.test.ts` (3). Also run against real PostgreSQL 17 (PGlite): refusal, override and all five shipped migrations. |
| **COMMIT** | `eea077f` |

### D3 — A re-created database was indistinguishable from a recovered one

| | |
|---|---|
| **SEVERITY** | High (silent loss of every student's visible history; split brain) |
| **INVARIANT** | An api that initialises an empty database after data existed is visible to the operator. |
| **EVIDENCE** | `buildProgressRuntime` auto-migrates an empty database and reports `latest=005_session_recovery` — the same as a restored one. RB-02 §6 told operators that value proved "this is not a fresh, empty volume"; incident exercise 1 said the same. No alert or log line distinguished the two. |
| **ROOT CAUSE** | The only schema signal was the version, which converges. |
| **FIX** | Migrator reports `initialized` and `ledgerStartedAt` (earliest `applied_at`: kept by a restore, new on re-creation); api logs a WARNING on initialisation and exports `jtt_database_ledger_started_timestamp_seconds`; new critical alert `DatabaseRecreatedSinceLastBackup`; RB-02 §4d procedure; RB-02 §6 and the incident exercise corrected. |
| **REGRESSION TEST** | migrator unit tests (2); `infrastructure/observability/prometheus/tests/database-recreated-alerts.test.yml` (5 cases: fires; quiet on first deploy, after a restore, with no backup, and when only a verification is newer); alert contract tests updated (cap 62 → 63, on purpose). |
| **COMMIT** | `e6f52f5` |

### D4 — A committed `--replace` could be reported as a failed restore

| | |
|---|---|
| **SEVERITY** | Medium (operator acts on a false "untouched") |
| **INVARIANT** | A restore that changed the live database never reports that it failed. |
| **EVIDENCE** | With the ledger read failing after the swap (a dropped connection), `db-restore.sh --replace` printed `restore FAILED (exit 1)` and no undo command: 4 new stub assertions failed. |
| **ROOT CAUSE** | The post-swap migration report ran under `set -e`, and the EXIT trap did not know the swap had committed. |
| **FIX** | Report in a subshell (failure is a warning); the trap, once swapped, says the swap committed and how to undo it. |
| **REGRESSION TEST** | `scripts/test-db-backup-restore.sh` (5 cases). |
| **COMMIT** | `62e47a0` |

### D5 — The nightly backup archived a re-created database and let retention age the good archives out

| | |
|---|---|
| **SEVERITY** | High (the last copies of students' history deleted by routine retention) |
| **INVARIANT** | Retention never counts an archive of a re-created database as a reason to delete archives of the real one. |
| **EVIDENCE** | `db-backup.sh` backed up any readable application database; the new archive sorts first and counts toward `BACKUP_RETENTION_MIN_KEEP` (default 7, window 14 days). 7 new stub assertions failed before the fix. The D3 alert would also have cleared at that first backup. |
| **ROOT CAUSE** | No notion of the database's continuity with its archives. |
| **FIX** | Before dumping, compare the ledger's first `applied_at` with the newest archive's UTC name stamp in SQL (session-time-zone independent; validated on PostgreSQL 17 in UTC, America/Chicago, Asia/Tokyo); refuse — a recorded failure — unless `BACKUP_ACCEPT_NEW_DATABASE=true` for one run. Retention shares the same listing. |
| **REGRESSION TEST** | `scripts/test-db-backup-restore.sh` (10 cases); `scripts/db-restore-drill.sh` step 12 on real PostgreSQL 16 (**added, not run tonight — needs Docker; runs in CI `postgres-integration`**). |
| **COMMIT** | `b60bdd6`, `f6a8be6` |

### R1 — Stale-lock replacement race (not fixed)

Two `db-backup.sh` runs that both find the same stale lock can each replace it,
so both proceed. Needs a manual run coinciding with a stale lock and the daily
cron; the same-second name check and the atomic rename still prevent a corrupt
archive. A proper fix needs `flock`, absent from macOS where restores are
rehearsed. **Low**, documented.

## 11. REGRESSION TESTS

| Suite | Before | After |
|---|---|---|
| `scripts/test-db-backup-restore.sh` | 132 | 167 |
| `services/progress` vitest | 96 + 1 skipped (DB) | 102 + 1 skipped |
| `apps/api/test/database-rollback-boundary.test.ts` | — | 3 |
| promtool rule tests | 9 files | 10 files (+5 cases) |
| `build-context-secrets.test.ts` | 4 (extended) | 4 |
| `db-restore-drill.sh` | 11 steps | 12 steps (not run here) |

## 12. COMMITS

| Commit | Subject |
|---|---|
| `a39bf60` | fix(backup): refuse a BACKUP_DIR inside the checkout outside backups/ |
| `eea077f` | fix(migrations): refuse a database a newer release migrated, in production |
| `e6f52f5` | fix(observability): tell a re-created database from a recovered one |
| `62e47a0` | fix(restore): never report a committed --replace as a failed restore |
| `b60bdd6` | fix(backup): refuse to back up a database re-created after the newest archive |
| `f6a8be6` | test(drill): prove the re-created-database backup refusal on real PostgreSQL |
| `2d0a579` | docs(dr): whole-host recovery runbook, drill plan and evidence template |
| (this file) | docs(dr): overnight disaster-recovery audit report |

## 13. SAFE VALIDATION RESULTS and EXACT TEST COUNTS

All on this branch's final code, Node v22.23.2, `npm ci` in this worktree only.

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `npm test` | exit 0 — **5,589 passed, 336 skipped, 0 failed**: api 696 (+15 skipped), web 265, lab-orchestrator 1,390 (+253), observability 948 (+38), progress 102 (+1), sandboxd 161 (+7), terminal 195 (+22), verifier 1,832. Skips are the env-gated integration suites (Docker, kind, PostgreSQL). |
| `npm run test:security` | exit 0 — **889 passed, 0 failed** (265 + 116 + 85 + 208 + 8 + 197 + 10) |
| `bash scripts/test-db-backup-restore.sh` | **167 passed, 0 failed** (132 at the start) |
| `bash scripts/test-production-host-scripts.sh` | 58 cases, 0 failed assertions |
| `bash scripts/test-private-beta-diagnostics.sh` | all cases passed |
| `promtool check rules alerts/*.yml rules/*.yml` | SUCCESS |
| `promtool test rules tests/*.test.yml` | SUCCESS (10 files) |
| `bash -n scripts/db-restore-drill.sh` | syntax OK (not executed) |
| PGlite (PostgreSQL 17, in-process, scratch dir) | the D5 SQL correct in 3 session time zones; the real migrator applies 001–005, reports `initialized`, keeps `ledgerStartedAt` on a rerun, refuses `006_from_a_newer_release`, allows it with the option |
| `git diff --check` | clean before every commit |

Every fix was proven failing first: D1 18 stub assertions, D2 4 unit tests, D3 2
unit tests and the promtool firing case, D4 4 stub assertions, D5 7 stub
assertions, and the `.dockerignore` rule by a negative control.

## 14. VALIDATION DEFERRED

- `make db-restore-drill` — POSTGRES INTEGRATION REQUIRED (starts PostgreSQL containers); runs in CI `postgres-integration`. Its new step 12 has never run.
- `make test-db` / `npm run test:db` — POSTGRES INTEGRATION REQUIRED; the migrator changes were instead run against PostgreSQL 17 (PGlite) in a scratch directory.
- `scripts/check-observability.sh` — stopped: it falls back to `docker run` for `amtool`. Its promtool parts were run directly (`check rules`, `test rules ./*.test.yml`: SUCCESS).
- E2E, `beta-validate`, TLS edge integration — shared Docker/kind infrastructure; not started.

## 15. REAL-HOST RECOVERY DRILL REQUIRED

disaster-recovery.md §9: A (on the host, non-destructive: backup, off-host copy,
verify), B (separate machine: retrieve from off-host, `--into`, compare, time),
C (disposable replacement host: full procedure, sign-in, existing progress, new
lab, terminal, Verify, End), D (destructive, disposable host only: `--replace`
and its rollback). Plus production-host-readiness.md §17 drills D-1…D-7 for
reboots. **None has been run. REAL-HOST RECOVERY PROVEN: NO.**

## 16. OPERATOR DECISIONS REQUIRED

- **D7** off-host destination, provider, encryption key/recipient, retention period, access control, retrieval procedure, verification cadence.
- **D9** where `.env`, the TLS key and per-release configuration copies are stored, and who can read them.
- **D6** alert delivery (without it every backup and re-creation alert reaches nobody).
- **D10** who holds Docker (root-equivalent) access.
- **D2** replacement host strategy (drives the RTO).
- RPO and RTO targets (24 h / 4 h are proposals; the 4 h is unmeasured).
- Real-data restore-test cadence (`--into` weekly is recommended).
- Managed PostgreSQL (the scripts would no longer apply).

## 17. KNOWN RESIDUAL RISKS

| Id | Risk | Severity |
|---|---|---|
| R1 | stale-lock replacement race between two simultaneous manual backups | Low |
| R2 | no off-host copy exists: today a host loss is total data loss | High until D7 |
| R3 | images carry no revision label; `JTT_COMMIT` is typed by the operator | Medium |
| R4 | `.env` is not versioned per release; `.env.previous` is a convention | Medium |
| R5 | kind node and attestation after a reboot unmeasured | Medium |
| R6 | no metric that a real-data `--into` restore drill ran recently | Low |
| R7 | a killed (SIGKILL) backup or restore can leave a full copy in the database container's `/tmp` (logged when cleanup cannot remove it) | Low |
| R8 | `DATABASE_ALLOW_NEWER_SCHEMA=true` left in `.env` after a rollback disables D2 for later rollbacks; the api logs a warning on each start while it matters | Low |
| R9 | restore time at production data size, and the RTO, never measured | Medium |
| R11 | a parallel branch on the same base (commercial entitlements) may add a migration; once merged, rolling back past it hits the D2 boundary by design — its rollout needs a `pre-upgrade` backup like any other | Info |
| R10 | a staging copy doubles disk use inside the database container during backup and verify; disk-full fails the run (safe) but on the same disk as the volume | Low |
