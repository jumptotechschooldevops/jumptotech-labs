# PostgreSQL backup, restore and disaster recovery

**BETA-P0-013.** This is a procedure runbook, not an alert runbook. RB-02 links
here from its "Fix" section.

| | |
|---|---|
| **Proven** | `make db-restore-drill` passes against real PostgreSQL 16 servers. It backs up a seeded server, destroys it, restores into a fresh server, and checks the result: identical rows, schema, sequences and migration ledger. The real migrator and the api's repository then read and write the restored database. |
| **Not proven** | A restore on a production host, at production data size, from an off-host copy, on a schedule. No production host exists yet. The CI job that runs the drill has not yet run on a GitHub runner. |

Read §4 (targets) and §10 (open decisions) before relying on any of this.

---

## 1. What is durable, and what is not

**In every backup:** the application database (`POSTGRES_DB`, default
`jumptotech_labs`), meaning every table in its `public` schema.

| Tables | What they hold |
|---|---|
| `students`, `lab_attempts`, `lab_progress`, `hint_usage` | learning history: attempts, completions, hints |
| `users`, `user_roles` | accounts (issuer + subject, email, display name, role) |
| `auth_sessions` | browser sign-ins, as SHA-256 hashes of the cookie id; no token |
| `lab_sessions` | the session records the api and reaper work from |
| `schema_migrations` | which migrations were applied, with their checksums |

**In no backup.** The following must be recreated or kept somewhere else:

| Not backed up | Why, and what recovers it |
|---|---|
| Sandboxes: kind namespaces; Linux, Terraform, Ansible, CI/CD and Docker sandbox containers; their networks and files | Disposable by design. A student starts the lab again. Work inside a sandbox is not recoverable. |
| Terminal PTYs, per-session kubeconfigs and client certificates | They live on tmpfs and are recreated per session. |
| `.env`: `POSTGRES_PASSWORD`, `TERMINAL_SESSION_SECRET`, `INTERNAL_SERVICE_SECRET`, `NAMESPACE_DERIVATION_SECRET`, the `SANDBOXD_*` secrets, `OIDC_CLIENT_SECRET`, `OBSERVABILITY_SCRAPE_TOKEN`, `GRAFANA_ADMIN_PASSWORD` | A restore needs none of them (§3.2), but the stack does not start without them. They must live in the operator's secret store (§10). |
| TLS certificate and key (`infrastructure/docker/nginx/tls/`) | Same: operator-held, reissued if lost. |
| kind kubeconfigs, sandbox images, service images | Regenerated: `make cluster-up`, `make sandbox-build`, `docker compose build`. |
| Prometheus, Alertmanager and Grafana data | Monitoring history only. Dashboards and rules are in the repository. |
| PostgreSQL roles and server settings | The image recreates the one role from `POSTGRES_USER`/`POSTGRES_PASSWORD` at first start (§3.3). |

## 2. Before BETA-P0-013

- The database lived in one named volume, `<project>-postgres-data`.
  `docker compose down` kept it. `docker compose down -v` and `make clean`
  deleted it.
- Nothing in the repository ran `pg_dump`, `pg_restore` or `psql` for recovery.
  RB-02 said so directly: *"treat the `postgres-data` volume as the only copy
  that exists."*
- Migrations are forward-only, checksum-verified and applied one transaction per
  file at api startup. That protects against a *half-applied* migration. It does
  not protect against a migration that succeeds and is wrong, a lost volume, a
  lost host, or a mistaken manual statement. Each of those meant permanent loss of
  every student's history.

## 3. How it works

### 3.1 The pieces

| | |
|---|---|
| `scripts/db-backup.sh` (`make db-backup`) | One custom-format archive plus a `.sha256` sidecar, verified before it is kept; then retention; optionally an off-host copy hook. |
| `scripts/db-restore.sh` | `--verify-only`, `--into NEW_DATABASE`, or `--replace DATABASE`. There is no default mode and no Makefile shortcut. |
| `scripts/db-lib.sh` | Shared by both. |
| `scripts/db-restore-drill.sh` (`make db-restore-drill`) | The end-to-end rehearsal (§9). Needs Docker. |
| `scripts/test-db-backup-restore.sh` (`make test-db-backup`) | Refusals and failure paths against a fake daemon (§9). |

### 3.2 How the scripts reach PostgreSQL

Every client command runs inside the PostgreSQL container, as its `postgres`
account, over the server's Unix socket:

```text
docker exec -u postgres <postgres container> pg_dump -U <role> -d <database> --format=custom …
```

- **No password is involved.** The official image trusts local-socket
  connections, so nothing reads, passes, exports, logs or writes the database
  password. The drill checks that the password is absent from the archive's name,
  the backup log and the archive's SQL.
- **No port, and so no TLS decision.** In production PostgreSQL publishes nothing
  and sits on the `internal` `database` network (BETA-P0-012). This path works
  unchanged there. `DATABASE_SSL`, the transport gates and
  `secret-distribution.json` are untouched.
- **Matching tools.** `pg_dump` and `pg_restore` are the server's own binaries,
  so they are never older than the server.
- **Who can run it.** Whoever can run `docker exec` on the host, which is
  root-equivalent. That is the operator or the host's scheduler. No service gains
  anything.
- **No backup container.** A container would need either the Docker socket, which
  only `sandboxd` may hold, or a database credential plus membership of the
  `database` network, which is pinned to `api` and `postgres`. A host-side script
  needs neither.

The container is `JTT_DB_CONTAINER`, or else the one running `postgres` service
of `COMPOSE_PROJECT_NAME` (default `jumptotech-labs`), found by its compose
labels. The script refuses if it finds zero or more than one. The role and
database default to that container's `POSTGRES_USER` and `POSTGRES_DB`. Those
are the only two variables the scripts will read from it.

### 3.3 Why there is no `pg_dumpall --globals-only`

Globals are not needed to recover this schema:

- The only role is `POSTGRES_USER`, created by the image at first start.
- The migrations create no roles, grants, ownership changes or extensions.
  `services/progress/test/backup-restore-safety.test.ts` fails the build if one
  ever does.
- A restore runs `pg_restore --no-owner --no-privileges`, so the restoring role
  owns every object. In this architecture that is the application's role.

A globals dump would add a file holding the role's password verifier, and buy no
recovery. Revisit this if a second role is added, for example a read-only
reporting user.

### 3.4 What a backup is, exactly

```text
jtt-pg-<database>-<UTC yyyymmddThhmmssZ>[-<label>].dump          pg_dump --format=custom --compress=6
jtt-pg-<database>-<UTC yyyymmddThhmmssZ>[-<label>].dump.sha256   "<sha256>  <archive name>"
```

A file with that name exists only after all of these steps pass:

1. `pg_dump` exited 0. It wrote to a file inside the container, so data offsets
   are recorded.
2. `pg_restore --list` read that file back as a custom-format archive, and it
   carries `schema_migrations` data. A dump of an empty or unrelated database
   does not pass.
3. The SHA-256 of the copy on the host equals the SHA-256 computed inside the
   container.
4. The copy was written as `.<name>.partial`, then renamed within one directory.

Any failure removes the partial file and the in-container copy, leaves the
directory as it was, and exits non-zero. A lock (`.db-backup.lock`) prevents
concurrent runs. A stale lock, whose process is gone, is replaced.

## 4. PRIVATE-BETA TARGETS

No RPO or RTO was defined for the platform before this story. The only earlier
mention of RPO/RTO is AWS curriculum content, which is lab material, not a
platform target. So there is no conflict to report.

| | PRIVATE-BETA TARGET (about 5 concurrent students) |
|---|---|
| **RPO** | **24 hours maximum**, with one scheduled backup a day |
| **RTO** | **4 hours**, from the decision to restore to students signing in again |

**These are operational targets, not guarantees.** They hold only while all of
these are true:

- a daily backup is scheduled, and its failures reach a person;
- the latest archive has been copied off the host;
- an operator with Docker access, the secrets and the runbook is available;
- the drill (or a real `--into` restore) has passed recently.

**Measured** (laptop, 2026-09-14, drill seed data: 9 tables, about 300 rows,
27 KB archive):

- the whole drill took 12 s;
- `--replace` itself took 2 s.

Production data will be larger, but the RTO is dominated by other steps that
nobody has timed yet:

- provisioning or repairing the host;
- fetching the off-host copy;
- starting the stack;
- validating.

Taking a `pre-migration` or manual backup shortens the RPO for planned changes.
Nothing shortens it for an unplanned loss short of WAL archiving or point-in-time
recovery (§10).

## 5. Backup

### 5.1 Manual backup

On a laptop, for the compose stack in this checkout:

```bash
make db-backup
# → backups/postgres/jtt-pg-jumptotech_labs-20260914T031700Z.dump (+ .sha256)
```

On a host:

```bash
cd /srv/jumptotech-labs
BACKUP_DIR=/srv/jumptotech/backups/postgres scripts/db-backup.sh
```

The archive path is printed on stdout. Progress lines go to stderr, and none of
them carries a secret. Settings come from the environment only; the script never
reads `.env`.

| Variable | Default | |
|---|---|---|
| `BACKUP_DIR` | `<repo>/backups/postgres` (git-ignored) | Must be absolute. Created `0700`. Refused if it is inside any mount of the database container, or under `/var/lib/docker` or `/var/lib/postgresql`. |
| `BACKUP_RETENTION_DAYS` | `14` | `0` keeps everything. |
| `BACKUP_RETENTION_MIN_KEEP` | `7` | The newest N archives are never deleted, however old. |
| `BACKUP_LABEL` / `--label` | none | `[a-z0-9-]`, up to 32 characters, e.g. `pre-migration`. |
| `BACKUP_COPY_HOOK` | none | Absolute path of an executable, run with the archive and its sidecar. A non-zero exit fails the run. World-writable hooks are refused. |
| `BACKUP_COPY_HOOK_TIMEOUT_SECONDS` | 1800 | How long the hook may run before it is stopped (`timeout`, then a kill 30 s later) and the run fails with "did not finish within". A hook hung on a network destination would otherwise hold the backup lock, and every later scheduled backup would refuse to start behind it. Needs coreutils `timeout`; without it the run logs that the hook is unbounded. |
| `JTT_DB_CONTAINER`, `COMPOSE_PROJECT_NAME`, `JTT_DB_NAME`, `JTT_DB_USER` | see §3.2 | |

### 5.2 Before a risky or manual migration

The api applies pending migrations when it starts. So take this backup **before
starting a new api image** that adds a file under `services/progress/migrations/`.
Take one too before running `npm run db:migrate` by hand, and before any manual
SQL:

```bash
scripts/db-backup.sh --label pre-migration
make db-backup-verify FILE=<the path it printed>
```

### 5.3 Scheduling

The script is idempotent and safe to call from any scheduler. It exits non-zero
on every failure. It is a command, not a daemon, and nothing runs permanently.
Cron example:

```cron
# /etc/cron.d/jumptotech-db-backup — daily, 03:17 UTC
17 3 * * *  jtt-ops  cd /srv/jumptotech-labs && BACKUP_DIR=/srv/jumptotech/backups/postgres BACKUP_STATUS_DIR=/srv/jumptotech/backups/status BACKUP_COPY_HOOK=/usr/local/sbin/jtt-copy-backup-offhost scripts/db-backup.sh >>/var/log/jumptotech/db-backup.log 2>&1
```

- `jtt-ops` must be able to run `docker`. That is root-equivalent, so choose the
  account accordingly.
- **Make failures visible.** Use `MAILTO`, a systemd `OnFailure=`, or the
  scheduler's own alerting. With the production observability overlay the
  platform alerts too (BETA-P0-018): each run records its outcome in
  `BACKUP_STATUS_DIR` (default `backups/status`; set the same path in `.env`),
  and `BackupStale`, `BackupMissedTwice`, `BackupLastRunFailed` and
  `BackupVerifyFailed` read it — [RB-16](RB-16-backups.md). A run refused before
  it starts (an invalid `BACKUP_DIR`, say) records nothing; freshness still catches it.

### 5.4 Retention

After each successful backup, the script deletes archives of **the same
database** that are older than `BACKUP_RETENTION_DAYS`. It deletes an archive's
sidecar with it. It always keeps the newest `BACKUP_RETENTION_MIN_KEEP`. Age comes
from the UTC timestamp in the name, not from the file's mtime.

Retention never touches:

- the archive just written;
- another database's archives;
- symlinks;
- files named any other way.

The defaults (14 days, at least 7 archives) keep two weeks of daily backups on the
host. Retention in the off-host copy is the off-host destination's job (§10).

### 5.5 Where backups live

- The default is `backups/postgres` in the checkout. It is ignored by git, as are
  `*.dump`, `*.dump.sha256` and `*.dump.partial` everywhere, and CI fails if an
  archive is ever committed. The directory is `0700` and the files are `0600`.
- On a host, use a dedicated directory. Ideally put it on a different filesystem
  from Docker's data root.
- **A copy on the database host is not a disaster-recovery backup.** It survives a
  dropped table or a bad migration. It does not survive losing the host or its
  disk.

> **OFF-HOST BACKUP DESTINATION — DECISION REQUIRED.** No destination is chosen,
> and no provider is selected by this story. `BACKUP_COPY_HOOK` is the
> provider-neutral seam. Whatever is chosen, the hook must:
>
> - copy **both** files;
> - confirm the remote checksum;
> - exit non-zero on any failure;
> - take its credentials from somewhere other than the backup directory and its
>   command line.
>
> The destination needs its own retention and access control, and must not be
> writable by anything that could also delete the originals.

> **BACKUP ENCRYPTION / EXTERNAL STORAGE — DECISION REQUIRED.** Archives are
> **not encrypted** by this story. They are sensitive: every account's email and
> display name, all learning history, session history, and sign-in hashes. On the
> host they are protected only by `0700`/`0600` and whatever disk encryption the
> host has. Encrypt before or during the off-host copy. Use a key or recipient
> held outside the host (a KMS, an `age`/GPG recipient), or storage-side
> encryption with managed keys. Never use a key committed here or stored beside
> the archives.

### 5.6 Verification

Every backup is already read back by `pg_restore` and checksummed across the
copy (§3.4). That proves the archive is **readable**. It does not prove it is
**recoverable**. So:

```bash
# Any time, on any archive — changes nothing:
make db-backup-verify FILE=backups/postgres/jtt-pg-jumptotech_labs-20260914T031700Z.dump

# Recommended weekly, with the newest real archive: a real restore beside production.
scripts/db-restore.sh --into jumptotech_labs_check_20260914 <archive>     # then §6.3

# Every CI run, with synthetic data: the whole code path, end to end.
make db-restore-drill
```

## 6. Restore

### 6.1 Select the backup

```bash
ls -l "$BACKUP_DIR"          # newest first by name: the timestamp is the dump's UTC start
```

- Recovering from a bad migration: use the `-pre-migration` archive taken before
  the deploy.
- Recovering from host or disk loss: fetch the newest archive **and its
  `.sha256`** from the off-host copy.
- `--allow-missing-checksum` exists for a copy that lost its sidecar. The archive
  is still read back before anything changes, but prefer finding the sidecar.

### 6.2 Verify it

```bash
scripts/db-restore.sh --verify-only <archive>
```

This checks the sidecar checksum, copies the archive into the target server's
container, checks the checksum again there, and lets that server's `pg_restore`
read it. It changes nothing.

### 6.3 Restore to a disposable database first

```bash
scripts/db-restore.sh --into jumptotech_labs_check_20260914 <archive>
```

This creates a **new** database and changes nothing that exists. The script
refuses if the name exists, or if it is `postgres`, `template0` or `template1`.
It logs the row count of every table and the migration state against this
checkout: *applied / pending / modified / unknown*.

Inspect it:

```bash
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d jumptotech_labs_check_20260914'
```

```sql
SELECT max(started_at) FROM lab_attempts;      -- the newest history in the archive: your actual data loss
SELECT count(*) FROM students; SELECT count(*) FROM users;
SELECT version FROM schema_migrations ORDER BY version;
```

This runs on the live server and uses its disk and CPU. For a large archive, use
a separate server (`JTT_DB_CONTAINER=<a disposable postgres:16-alpine>`). Remove
the check database when finished:

```bash
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE jumptotech_labs_check_20260914"'
```

### 6.4 Production recovery procedure

Use the same compose files the deployment runs. Production:
`docker compose -f docker-compose.yml -f docker-compose.runtime.yml -f docker-compose.production.yml`,
written `$COMPOSE` below.

1. **Announce maintenance.** Students will lose work written after the archive
   (§8).
2. **Stop the only database client:** `$COMPOSE stop api`. `--replace` refuses
   while any session is connected. PostgreSQL itself refuses to rename a database
   with a session open, so a missed client cannot slip through.
3. **If the current database is still readable, back it up first:**
   `scripts/db-backup.sh --label pre-restore`. `--replace` keeps the old database
   on this server anyway. An archive also survives the host.
4. **Verify and inspect** the chosen archive (§6.2, §6.3).
5. **Replace:**

   ```bash
   scripts/db-restore.sh --replace jumptotech_labs <archive>
   # Type the database name to continue: jumptotech_labs
   ```

   Without a terminal, `--confirm jumptotech_labs` is required. What happens:
   - A new staging database is created with the same encoding and collation as
     `jumptotech_labs`.
   - The archive is restored into staging in **one transaction**, stopping at the
     first error.
   - Staging is checked: every table in the archive is present, and the migration
     ledger is non-empty.
   - The script checks again that nothing is connected.
   - In **one transaction**: `jumptotech_labs → jumptotech_labs_prerestore_<ts>`,
     then `staging → jumptotech_labs`.

   **Nothing is dropped.** A failure at any step leaves `jumptotech_labs` exactly
   as it was.
6. **Start the api:** `$COMPOSE up -d api`. With `DATABASE_AUTO_MIGRATE=true`
   (the default) it applies any migration newer than the archive. The restore
   printed which ones are pending.
   - **CHECKSUM DIFFERS** or **unknown** in that report means the code and the
     data disagree. Deploy the release that matches the archive; do not edit
     migrations.
7. **Validate** (§6.5).

### 6.5 Validate

- Everything in [RB-02 §6](RB-02-database.md#6-verify-recovery): `jtt_db_up`,
  `/readyz`, the migration version, the pool.
- The api log shows the migrator applied the pending migrations, or found the
  database up to date.
- The data matches what you inspected in §6.3: counts, and the newest
  `lab_attempts.started_at`.
- One known student's dashboard shows their history. One sign-in works. One lab
  starts, checks and ends.

### 6.6 Roll back the swap

`--replace` prints the exact command. It has this form:

```bash
$COMPOSE stop api
docker exec -u postgres <container> psql -X -v ON_ERROR_STOP=1 -U <role> -d postgres \
  -c 'BEGIN' \
  -c 'ALTER DATABASE jumptotech_labs RENAME TO jumptotech_labs_failed_<ts>' \
  -c 'ALTER DATABASE jumptotech_labs_prerestore_<ts> RENAME TO jumptotech_labs' \
  -c 'COMMIT'
$COMPOSE up -d api
```

### 6.7 Clean up

Only after the restore is accepted, **and** after a fresh `scripts/db-backup.sh`
of the restored state:

```bash
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE jumptotech_labs_prerestore_<ts>"'
```

No script does this for you, by design.

### 6.8 Escalate when

Stop and escalate to the platform owner in any of these cases:

- every copy of an archive fails its checksum or `pg_restore`;
- `pg_restore` errors on the archive you need;
- the migration report shows **CHECKSUM DIFFERS** or **unknown**, and the matching
  release is not obvious;
- the swap fails twice;
- data written after the archive must be reconstructed.

Do not run `DROP`, `TRUNCATE` or `DELETE` to "tidy up" before the incident is
understood. The kept databases are the evidence.

## 7. Disaster recovery

### 7.1 Database volume lost; host intact

The drill rehearses exactly this.

1. `$COMPOSE stop api`
2. `$COMPOSE up -d postgres`. A fresh volume runs `initdb`, which creates an empty
   `POSTGRES_DB` owned by `POSTGRES_USER`, with the password from `.env`.
3. Select, verify and inspect the newest archive (§6.1 to §6.3).
4. `scripts/db-restore.sh --replace jumptotech_labs <archive>`. The empty database
   is the one replaced and kept.
5. `$COMPOSE up -d`, then validate (§6.5).

### 7.2 Database host lost or replaced

1. Provision a host with Docker and the compose plugin, and check out **the
   release that was running**.
2. Restore `.env` and the TLS certificate from the secret store (§1, §10).
3. Recreate the runtime prerequisites the deployment uses (`make cluster-up`,
   `make sandbox-build`), then `$COMPOSE up -d postgres`.
4. Fetch the newest archive and its `.sha256` from the off-host copy (§5.5). If
   there is no off-host copy, there is no backup, and this procedure ends here.
5. Verify, inspect and `--replace` (§6.2 to §6.4). Start the stack, validate, then
   point DNS or the tunnel at the new host.
6. Re-create the backup schedule (§5.3) on the new host before calling the
   incident closed.

### 7.3 Corrupted database or container

If PostgreSQL will not start, or reports data corruption:

1. `$COMPOSE stop api postgres`. **Do not** run `down -v` or `make clean`: the
   volume is evidence, and it may still be partly readable.
2. Preserve the volume before replacing it:

   ```bash
   docker run --rm -v jumptotech-labs-postgres-data:/from:ro -v /srv/jumptotech/incident-<ts>:/to \
     postgres:16-alpine sh -c 'cp -a /from/. /to/'
   ```

3. Only after that copy exists, remove the volume
   (`docker volume rm jumptotech-labs-postgres-data`) and follow §7.1.

### 7.4 Failed migration

- **The migration failed.** Each file runs in a transaction, so the database is
  unchanged and the api refuses to start with the error. No restore is needed. Fix
  forward with a new migration in a new release.
- **The migration succeeded but damaged data.** Deploy the previous release,
  `--replace` from the `pre-migration` archive (§5.2), and validate. The restore's
  migration report should then show nothing unknown.

### 7.5 Operator mistake: bad manual SQL or deleted rows

The rest of the database is newer than any backup, and `--replace` loses
everything written since the archive. So prefer this:

1. `--into` a check database (§6.3), and find the affected rows there.
2. Copy exactly those rows back, reviewed by a second person.
3. Use `--replace` only when the damage is too broad to repair by hand.

## 8. Students and sessions after a restore

- **Data written after the archive is gone**: progress, attempts, hints, and
  accounts first seen after it. That is up to the RPO. Check
  `max(started_at)` (§6.3) and tell the affected students.
- **Browser sign-ins** created after the archive no longer exist. Those students
  get `401` and sign in again. A student whose account was created after the
  archive gets a new account row on that sign-in.
- **No sandbox is restored**, and nothing inside one is recoverable.
- **Restored `lab_sessions` rows** describe sandboxes that may no longer exist.
  - The reaper expires each one when it passes its absolute deadline
    (`expires_at`, at most `MAX_SESSION_MINUTES`, default 60, after creation), on
    its sweep (`CLEANUP_INTERVAL_SECONDS`, default 60). Any archive older than an
    hour holds only past-deadline rows.
  - Until a row is expired it counts toward capacity, including the one-lab-per-
    student limit. [RB-04](RB-04-capacity.md) and
    [RB-05](RB-05-cleanup-and-leaks.md) cover a negative leak count and blocked
    capacity.
- **In-progress attempts** in the archive are closed as `EXPIRED` by the sweeper
  once they are older than the absolute session lifetime
  ([RB-02 §9](RB-02-database.md#9-follow-up)).
- **Sandboxes still running on a surviving runtime**, but created after the
  archive, have no session row. The reaper treats them as orphans after its grace
  period.
  - It deletes only those labelled with this deployment's `RUNTIME_OWNER_ID`.
  - Unlabelled ones are left for an operator
    ([docs/runtime-ownership.md](../runtime-ownership.md), RB-05).
  - After a host loss the runtime is gone too, and students simply start labs
    again.

## 9. What proves it

| Check | Runs | Proves |
|---|---|---|
| `scripts/test-db-backup-restore.sh` (`make test-db-backup`, CI `gates`) | fake `docker`, `psql`, `pg_dump` and `pg_restore`, no daemon | See the list below this table. |
| `services/progress/test/backup-restore-safety.test.ts` (`npm test`) | text of the scripts, compose files, `.gitignore`, CI and this runbook | See the list below this table. |
| `scripts/db-restore-drill.sh` (`make db-restore-drill`, CI `postgres-integration`) | two real `postgres:16-alpine` servers it creates and removes, labelled with the run id | See the list below this table. |
| CI `gates` → "No database archive is committed" | `git ls-files` | no `.dump` / `.backup` / `.bak` file is tracked |

**The stub suite** proves, for 88 cases:
- A failed dump, an unreadable archive, a non-application archive, a corrupted
  copy, an unreachable server, or a destination inside the database's storage
  each leaves nothing that looks like a backup.
- Retention deletes only this database's regular files, and keeps the minimum.
- The lock and the copy hook behave.
- A restore refuses each of these *before any database change*: no mode, a bad
  or missing checksum, an unreadable or altered archive, an existing or system
  target, missing or wrong confirmation, a connected session.
- `--replace` stages, restores, then swaps inside one `BEGIN`/`COMMIT` and drops
  nothing.
- A password sentinel never appears in output, arguments or files.

**The static test** proves:
- the scripts start with strict mode, no tracing and `umask 077`;
- they contain no password, connection string, host or port flag, or sslmode;
- the restore contains no `DROP`, `TRUNCATE` or `DELETE`;
- the backup steps run in order: dump, read back, compare checksums, rename;
- archives are ignored by git;
- no compose file gains a backup service or mount;
- the migrations create no role or grant.

**The drill** proves:
- migrations and seed data go in, then a backup is taken, then the source server
  is destroyed;
- `--verify-only` and `--into` work on a fresh server, and the `--into` result is
  identical to the source;
- `--replace` refuses while a session is connected and when unconfirmed, and both
  refusals change nothing;
- after `--replace`, the fingerprint (every table's count and content hash,
  schema, sequences, migration ledger) is identical to the source, and the old
  database is kept;
- `db:migrate` and `db:status` report the database current;
- the api's repository reads the restored history and writes a new attempt
  through the restored sequence;
- the password is absent from the archive's name, the backup log and the SQL.

**Not proven by any of it:**
- a restore on the production host, at production size, or from an off-host copy;
- the scheduler, and anyone noticing its failures;
- the off-host copy and encryption, which are not built;
- the RTO;
- a restore after the stack moves to managed PostgreSQL.

## 10. DECISION REQUIRED

- **OFF-HOST BACKUP DESTINATION — DECISION REQUIRED** (§5.5). Until it is made,
  a lost host means lost data, whatever the schedule.
- **BACKUP ENCRYPTION / EXTERNAL STORAGE — DECISION REQUIRED** (§5.5).
- **Secrets and certificate recovery.** Where `.env` and the TLS key are kept so
  that a replacement host can start. The database archive deliberately contains
  neither.
- ~~**Backup monitoring.**~~ Done in BETA-P0-018: freshness and verification
  metrics and alerts ([RB-16](RB-16-backups.md)). Where those alerts are
  delivered is still DECISION REQUIRED
  ([private-beta-operations.md §8](private-beta-operations.md)).
- **Who may restore.** Docker access on the host is root-equivalent, and it is what
  both scripts need.
- **Restore-test cadence on real data.** This runbook recommends a weekly `--into`
  restore (§5.6).
- **An RPO below 24 hours.** More frequent runs of the same script, or WAL
  archiving with point-in-time recovery, which this story does not build.
- **Managed PostgreSQL.** If the database leaves this host
  ([runtime-architecture §11.7](../runtime-architecture.md)), these scripts no
  longer apply, because they `docker exec` into the server's container. The
  provider's backups and PITR, or `pg_dump` over verified TLS, would replace them.
