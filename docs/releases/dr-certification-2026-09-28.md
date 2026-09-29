# Backup, restore, migration and rollback certification — 2026-09-28

**A record.** It describes the repository at `origin/main` 74ea285 (#154) and
the PRs it opened. It is not maintained afterwards. The authorities are
[disaster-recovery.md](../runbooks/disaster-recovery.md) (procedure) and
[postgres-backup-restore.md](../runbooks/postgres-backup-restore.md)
(mechanics).

**Scope:** backup, restore, migrations, newer-schema protection, deployment
order, rollback, recovery objectives. It does not repeat the restart and
failure drills of the same day's
[reliability/DR audit](reliability-dr-audit-2026-09-28.md), which it cites.

**Where it ran:** a shared macOS laptop (10 CPUs, load average 20–126 during the
runs) with Docker Desktop. Every destructive step ran against disposable
PostgreSQL 16.15 containers created for it (`jtt-dr-pg`, `jtt-dr-pg2`, the
drill's own). Nothing here was measured on a production host or off-host. Every
time below is therefore an **upper bound from one loaded laptop**, not an
objective.

## 1. Verdicts

| Area | Verdict | Why |
|---|---|---|
| Backup | **PASS** (local) · CONDITIONAL for production | Complete, verified, atomic, and failures are loud. The conditions: no off-host copy (D7) and no alert destination (D6) exist yet, and no job is scheduled on a host |
| Restore | **PASS** (local) | Byte-identical fingerprint of all 16 tables, and the application reads and writes. One defect fixed (§4, #176) |
| Migrations | **PASS** | Fresh install, every older level with data, and eight concurrent starts |
| Newer-schema protection | **PASS**, with a gap in how far back it reaches | §6 |
| Rollback | **CONDITIONAL** | Rolling back from any 010 release is a database restore (§7). The override is now barred for future restore-required migrations (#178) |
| Restart recovery | **PASS** (cited, not re-run) | reliability audit §C rows 1–14 |
| Host-loss recovery | **NOT PROVEN** | The procedure exists; no separate host was ever used |
| RPO / RTO | **NOT YET MEASURED** on a host | §9 |

## 2. What persists: the data durability map

Verified from `services/progress/migrations/001–010`, not assumed. Only
PostgreSQL holds student data, and the api is its only client.

| Table (migration) | Holds | Class |
|---|---|---|
| `students`, `lab_attempts`, `lab_progress`, `hint_usage` (001) | learning history: every attempt, each check and reset count, completions, hints | **MUST RESTORE** |
| `users`, `user_roles` (003) | accounts: issuer, subject, email, role | **MUST RESTORE** |
| `access_entitlements`, `access_events` (006, 009, 010) | who may use labs, on which plan, and every change to that | **MUST RESTORE** |
| `billing_customers`, `billing_checkouts`, `billing_subscriptions`, `billing_events` (010) | provider references and subscription state; no payment data | **MUST RESTORE** (the provider holds the truth; §8) |
| `schema_migrations` | the migration ledger. Its first `applied_at` tells a restored database from a re-created one; from #178 it also records each migration's rollback class | **MUST RESTORE** |
| `lab_sessions` (002, 003, 005, 007) | session rows, their status, owner, and the per-session `shell_uid` | SHOULD RESTORE (stale rows expire) |
| `auth_sessions` (004) | SHA-256 of browser sign-in ids, not tokens | SHOULD RESTORE (else everyone signs in again) |
| `session_events` (008) | what happened to each lab, for instructors | SHOULD RESTORE |
| sandboxes, terminal PTYs and tmpfs, kubeconfigs | runtime | EPHEMERAL, never restored |

Everything else — `.env`, TLS, images, the kind cluster, cron — is in
[disaster-recovery.md §1](../runbooks/disaster-recovery.md), which this audit
checked and did not need to change.

## 3. Backup

Run with `scripts/db-backup.sh` against a database holding every table from 001
to 010. The data: six accounts, 60 attempts, 60 progress rows, 60 hints, 12
sessions, 7 entitlements (one account with both an operator row and a billing
row), 9 access events, 37 session events, and one row in each billing table.

| Check | Result |
|---|---|
| Completes; non-empty | exit 0; 51,626-byte archive and `.sha256`; 16 tables with data, read back in full by `pg_restore` before it is kept |
| Permissions | directory `0700`, archive and sidecar `0600` (`umask 077`) |
| Secrets | no password or connection string in the output. The drill also greps the archive rendered as SQL for the database password |
| Metadata | name `jtt-pg-<db>-<UTC start>[-label].dump`. The log gives the size, SHA-256, PostgreSQL version and table count. Status file: `timestamp_seconds`, `size_bytes`, `offhost_copy=not_configured` |
| Missing database; missing container; relative `BACKUP_DIR`; the `postgres` database | each exits 1, writes `db-backup.last-failure`, and leaves no archive, `.partial` or lock |
| **Database stops answering mid-dump** (`docker pause`) | **no timeout**: the job waited through the whole 296 s pause. The next run failed cleanly ("not accepting TCP connections after 120s") and recorded a failure. After unpause the first run finished with a valid archive. A backup that hangs therefore surfaces as the *next* night's failure (BackupLastRunFailed), up to 24 h later (F5) |

## 4. Restore

| Check | Result |
|---|---|
| `--verify-only` | reads the archive's database name, creation time and 16 tables; changes nothing |
| `--into` a new database | exit 0 in 47 s. Fingerprint (every table's rows hashed, schema, sequence positions, ledger) **byte-identical** to the source |
| Source destroyed and re-created empty, then `--replace` | refused without a terminal and without `--confirm`. With confirmation: exit 0 in 47 s, identical fingerprint, and the empty database kept as `<db>_prerestore_<ts>` (nothing dropped) |
| The current release on the restored database | `verifySchema` sees 10 present and 0 unknown. `migrate` applies nothing and does not report an empty database. The progress repository reads 7/10 completed for the known student and writes attempt 61. Access decisions keep 010 semantics: SUSPENDED+billing refused, paying student allowed, REVOKED refused |
| CI drill (`make db-restore-drill`) | passes with the new step 13, and now fingerprints the 006–010 tables too (#176) |

**Defect F1 — a restore handed shell uids out twice (fixed, #176).** Every
session's shell runs as its own uid, from a sequence that is never supposed to
repeat (SEC-ARCH-2). The archive holds that sequence as it was at the backup,
so `--replace` over a live database rewound it:

1. Sessions started after the backup held 1900000012–14.
2. After `--replace`, a different student's new session got 1900000012.
3. The shell that first held that uid could still be running in the terminal.

That is the default rollback route (restore the `pre-migration` archive) and
any restore over a live database. `--replace` now carries the sequence past
the replaced database's before the swap. When it cannot (a lost volume), the
runbooks restart the terminal, whose state is tmpfs.

## 5. Bad backups and failed restores

Every case exited non-zero, changed nothing, and never claimed success:

- a missing archive;
- a truncated archive with a matching (re-made) sidecar: no database created;
- a corrupted archive, with the original sidecar and with a re-made one;
- a text file named `.dump`;
- `--into` an existing database;
- a wrong role;
- an absent server container.

The stub harness (`make test-db-backup`) covers 186 cases, 6 of them new in
#176.

## 6. Migrations and newer-schema protection

All run against real PostgreSQL 16 (`services/progress/src/postgres/migrator.ts`
unchanged).

| Test | Result |
|---|---|
| Fresh database → 001–010, twice | applies 10, reports `initialized`. A second run applies nothing. The two schemas are **byte-identical** (`pg_dump --schema-only`) |
| Each older level 001…009, with data written at that level → current | applies exactly the rest. Every pre-existing row and column hashes the same after the upgrade. 007 gave the 12 existing sessions distinct uids from 1900000000. 009 reads old entitlements as STANDARD with no plan. 010 keeps them as operator rows. The final schema is byte-identical to a fresh install at every level |
| 8 api processes start on an empty database at once | all succeed; exactly one applied 10 and reported `initialized`, the other 7 applied 0; the ledger has 10 rows; the schema is byte-identical to a fresh install |
| A start while another is mid-migration (a slow 999) | waits on the advisory lock (19.9 s) and finds it applied. It never runs half a schema |
| A failing migration | nothing applied, nothing recorded, and the database is unchanged |
| A database a newer release migrated | refused by `migrate` and by `verifySchema` (`DATABASE_AUTO_MIGRATE=false`), naming the version. `allowNewerSchema` runs with a WARNING and applies nothing unknown |

**How far back the refusal reaches.** The refusal was added in 97c6297 (#80,
2026-09-27), and for `DATABASE_AUTO_MIGRATE=false` in 1a38c29 (#126). A
release older than that starts on any schema without a word. Measured: a5fcef2
(before 006) started on the 010 database with no refusal. There are no release
tags; releases are commits.

**`DATABASE_ALLOW_NEWER_SCHEMA`** is fully described in
[private-beta-deployment.md §7.3](../runbooks/private-beta-deployment.md):

- When it is needed: never by default. Only when the pre-migration restore is
  impossible or worse, after someone has read the unknown migrations.
- Why it is dangerous: older code runs on a schema it was never tested on.
- When not to use it: when the restore route exists, or when the refusal was
  unexpected.

This audit adds one case where it must not be used: across 010 (§7). After
#178, a future migration marked `restore-required` cannot be overridden at all.

## 7. Rollback

The four releases before 010 (95d60aa, a7507c2, 9a47543 and 4b94369) were each
run against a database at 010 holding current data. The release before 006,
a5fcef2, was run the same way. Each started first as it would in production,
and then, with the override, under its own persistence suites. Each of the
releases before 007–009 was also run against a database only one migration
ahead of it. Session-store concurrency tests and a few statement timeouts
failed while the host's load average was above 30; each passed when run again
on its own, and they are counted as passed above.

| Rolling back across | Class | Measured |
|---|---|---|
| code only (no migration) | ROLLBACK SAFE | schema unchanged |
| 006 | NOT A ROLLBACK TARGET | a5fcef2 starts silently (pre-refusal). Its suites pass (progress 24/24, sessions 187/187, auth 20/20), but it has no entitlement model, so every signed-in account gets labs |
| 007 | APPLICATION ROLLBACK REQUIRES OVERRIDE | 95d60aa refused; with the override progress 25/25, sessions 193/193, progress+auth+access 26/26. Every terminal shell returns to one shared uid |
| 008 | APPLICATION ROLLBACK REQUIRES OVERRIDE | a7507c2 refused; with the override sessions 210/210, auth+access 24/24, progress 25/26 (the one is its own test expecting no unknown version) |
| 009 | APPLICATION ROLLBACK REQUIRES OVERRIDE | 9a47543 refused; with the override sessions 222/222, progress+auth+access+session-events 33/33. It ignores `plan_id`, so trials are not limited to their tracks |
| **010** | **DATABASE RESTORE REQUIRED** | refused. With the override, **every access change fails** (`there is no unique or exclusion constraint matching the ON CONFLICT specification`). **Reads decide wrongly**: pre-010 `get()` takes `rows[0]` of an account's rows with no ORDER BY. A student with an operator row SUSPENDED and a billing row ACTIVE got **lab access** on an index scan (the billing row sorts first), and was refused on a bitmap scan, so the outcome depends on the planner |

**What rollback means today:** from any release that ships 010, the only way
back to an earlier release is to restore the `pre-migration` archive. Anything
students did since that archive is lost (§8). #163 corrected the runbooks' "all
additive" claim for writes; this audit adds the read path. It also adds #178,
which records each migration's class in the ledger, so that the next
`restore-required` migration is refused even with the override. It cannot
protect a rollback to a release older than itself.

**Deployment order** (production-host-readiness.md §21.1), checked against the
compose files:

1. `prod up -d --build` builds every image first.
2. It then recreates changed services in dependency order: postgres (healthy)
   → sandboxd (healthy) → api (healthy only after its migrations) → terminal →
   web.

The old api container stops before the new one starts, so two api versions
never run against one database and migrations never race an old api.

Two windows exist:

- For seconds, a new api serves an old terminal and web. Harmless with no
  students on, which the procedure requires.
- The `pre-migration` backup is taken before the image build. Anything written
  during the build (the reaper, or a student) is lost if that archive is later
  restored.

A refused api (newer schema) makes `up --wait` fail, and the procedure treats
that as the failed deployment. No mixed-version *database* state is possible.

## 8. Data-loss windows

Backups run once a day (03:17, [private-beta-operations.md §1.2](../runbooks/private-beta-operations.md)).
No WAL archiving and no point-in-time recovery exist. **No schedule is installed
anywhere yet, and no off-host copy exists (D7)**: until both are, losing the
host loses everything since the platform started.

| The host is lost… | Lost from the database |
|---|---|
| right after a backup that reached off-host storage | only sessions in progress (their sandboxes are ephemeral anyway) |
| 1 hour after | 1 hour of attempts, checks, completions, hints, new accounts, sign-ins, access changes, and billing state synced from the provider |
| 23 hours after (just before the next) | up to 24 hours of the same: the RPO target |
| after a backup that failed, or never left the host | everything since the last good off-host copy. That is **unbounded** until failures reach a person (D6) |

What a restore *undoes* as well
([postgres-backup-restore.md §8](../runbooks/postgres-backup-restore.md)):

- suspensions and revocations made after the archive (such a student can use
  labs again);
- sign-outs (the row returns, valid until its expiry);
- subscriptions and processed webhooks (the provider will not resend them);
- shell uids handed out since (now carried forward, F1).

## 9. RPO and RTO

| | Target (postgres-backup-restore.md §4) | Measured | Status |
|---|---|---|---|
| RPO | 24 h | — | **NOT YET MEASURED**: needs a scheduled job and an off-host copy on the host |
| RTO | 4 h | laptop only: volume lost → restored and validated, 344 s (reliability audit §C 13b). This audit, `db-backup.sh` / `--verify-only` / `--into`: 51 KB seed 33 s / — / 47 s; 500 students (44 MB database, 25,000 attempts, 100,000 hints, 7 MB archive) 31 s / 17 s / 145 s; 5,000 students (360 MB, 250,000 attempts, 1,000,000 hints, 56 MB archive) 111 s / 23 s / 187 s, at load 26–40 | **NOT YET MEASURED** on a host |

**The experiment that would establish them:**
[disaster-recovery.md §9](../runbooks/disaster-recovery.md) drill B and C, on
a separate disposable host:

1. Fetch the newest archive from the off-host copy.
2. Restore it.
3. Bring the stack up.
4. Sign in, show progress, Start, Check and End.
5. Time the whole run.

Run it before invitations, and again after each change to the backup path.

## 10. Backup security

| | State |
|---|---|
| Encryption | **none**. The archive is plain `pg_dump` custom format (D7) |
| Off-host storage | **none**. `BACKUP_COPY_HOOK` exists and its failure fails the run, but no destination is chosen (D7) |
| Access control | `BACKUP_DIR` `0700`, owned by the user running the job; archives `0600`. Refused inside the checkout (except `backups/`), inside Docker's or PostgreSQL's storage, or inside any mount of the database container. Both scripts need Docker access, which is root-equivalent (D10) |
| Retention | 14 days, and never below the newest 7 archives. A database re-created after the newest archive is refused, so retention cannot age the good archives out |
| Secret leakage | no password is read or passed (`docker exec` over the local socket). The archive holds no secret; `auth_sessions` holds hashes |
| Temporary files | the dump is staged in a private directory inside the container and removed on exit; the host copy is a hidden `.partial`, renamed only after its checksum matches, and removed on failure |
| Status files | `BACKUP_STATUS_DIR` never shares `BACKUP_DIR` (the api mounts it) |

The production host still needs:

- an encrypted off-host destination, with the key held off the host;
- a person who receives backup alerts;
- the cron file;
- a periodic restore of a fetched copy.

## 11. Findings

| Id | Severity | Finding | Outcome |
|---|---|---|---|
| F1 | High | `--replace` rewound the shell uid sequence, so a live shell's uid could go to another student | **fixed** #176 |
| F2 | High | Rolling back across 010 with the override lets suspended paying students use labs, and fails every access change. Only a runbook said not to | runbooks corrected (#163 and this PR); **mechanical barrier for future migrations** #178 |
| F3 | Medium | The restore drill did not seed the 006–010 tables, so their restore was never fingerprinted | **fixed** #176 |
| F4 | Medium | A restore silently undoes access changes, sign-outs and billing state made after the archive | documented (postgres-backup-restore.md §8) |
| F5 | Low | `db-backup.sh` has no overall timeout. A hung database holds the job until the next night's run fails | documented; alerting covers it within 24 h |
| F6 | Low | Releases before #80 have no newer-schema refusal | documented (§6) |
| F7 | Low | No operator command on `main` ends one account's sign-ins, which a restore can revive | documented; `ops sign-out` is proposed in #173 (auth audit) |

## 12. PRs

| PR | What | Merge order |
|---|---|---|
| #176 | F1 fix, drill step 13, drill seed for 006–010 | any |
| #178 | rollback class in the ledger; the override cannot skip `restore-required` | after or with this PR (its comment cites this report) |
| this PR (stacked on #163) | measured rollback matrix, 010 read path, restore consequences, this report | after #163; then retarget to `main` |

## 13. What only a real beta host can prove

- the cron job running, its failures alerting a person, and the copy reaching
  off-host storage;
- the restore time at production size from a fetched copy (drill B);
- a whole replacement host (drill C), and so the RTO;
- a reboot with the kind node (`on-failure:1`, unmeasured);
- the RPO in practice: how old the newest off-host archive is on an average day.
