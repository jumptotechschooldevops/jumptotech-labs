# RB-16 — Backup freshness and verification

**Alerts:** `BackupMissedTwice` (critical), `BackupStale` (warning),
`BackupLastRunFailed` (warning), `BackupNeverSucceeded` (warning),
`BackupStatusUnreadable` (warning), `BackupVerifyFailed` (warning)
**Source:** `scripts/db-backup.sh` and `scripts/db-restore.sh --verify-only`
record their last outcome in `BACKUP_STATUS_DIR` (`db-backup.last-success`,
`db-backup.last-failure`, `db-verify.last-*`); the API reads the directory
read-only and exports the timestamps.
**Blast radius:** none today. Until a backup succeeds, a database or host loss
loses everything since the last good archive. RPO is 24 hours.

Commands use `prod` and `q` from [private-beta-operations.md §1](private-beta-operations.md).
Backup and restore themselves: [postgres-backup-restore.md](postgres-backup-restore.md).

## 1. Confirm it is real

```bash
q 'jtt:backup_age:seconds / 3600'                           # hours, per operation
q 'jtt_backup_last_failure_timestamp_seconds'
q 'jtt_backup_status_readable'
ls -l /srv/jumptotech/backups/status/ && cat /srv/jumptotech/backups/status/db-backup.last-*
ls -lt /srv/jumptotech/backups/postgres | head
tail -50 /var/log/jumptotech/db-backup.log
```

Use the paths the cron job sets (`BACKUP_DIR`, `BACKUP_STATUS_DIR`). The status
files are `key=value` lines: `timestamp_seconds`, `size_bytes`, `offhost_copy`.

## 2. Scope it

| Alert | Meaning | Section |
|---|---|---|
| `BackupLastRunFailed` | The newest run failed; the previous archive is still the newest good one | 4a |
| `BackupStale` / `BackupMissedTwice` | No success for 26 / 50 hours: the job is not running, or failing | 4a, 4b |
| `BackupNeverSucceeded` | The directory is readable and no backup has ever succeeded | 4b |
| `BackupStatusUnreadable` | The API cannot read the directory: freshness is unknown | 4c |
| `BackupVerifyFailed` | An archive failed its checksum or could not be read back | 4d |

## 3. Immediate mitigation

Take a backup now, as the backup account, with the same variables the cron job
uses:

```bash
cd /srv/jumptotech-labs
BACKUP_DIR=/srv/jumptotech/backups/postgres BACKUP_STATUS_DIR=/srv/jumptotech/backups/status scripts/db-backup.sh
```

It prints the archive path on success and records `db-backup.last-success`.

## 4. Diagnose

- **4a A failing run.** The log's last `ERROR:` line names the step: the
  container not running or ambiguous, `pg_dump` failing, the read-back or
  checksum failing, `BACKUP_COPY_HOOK` failing, a lock held by another run. A
  failed run never leaves an archive. `prod ps postgres` first.
- **4b A job that does not run.** `grep jumptotech /etc/cron.d/*`, the cron
  service's own log, and whether the account can run `docker`.
- **4c An unreadable directory.**
  ```bash
  prod exec -T api ls -la /var/lib/jumptotech/backup-status
  ls -ld /srv/jumptotech/backups/status
  ```
  The api runs as a non-root user: the directory must be `0755` and the files
  `0644` (the script writes them so). A directory Docker created before the
  first backup is owned by root and the job cannot write it:
  `sudo chown jtt-ops /srv/jumptotech/backups/status`. A different
  `BACKUP_STATUS_DIR` in `.env` and in cron is another cause; then
  `prod up -d api`. A status directory that is, contains or sits inside
  `BACKUP_DIR` is refused on both sides — the script logs `BACKUP_STATUS_DIR is
  inside BACKUP_DIR` (or the reverse) and records nothing, and the api reports
  the directory unreadable if it holds archives — because the api must never
  mount the archives. Give it its own directory.
- **4d A failed verification.**
  `scripts/db-restore.sh --verify-only <archive>` names whether the checksum or
  the read-back failed. Do not delete the archive; check the one before it the
  same way.

## 5. Fix

Whatever section 4 named, then run §3 again. After a failed verification, take a
new backup and verify it.

## 6. Verify recovery

- `q 'jtt:backup_age:seconds{operation="backup"} / 3600'` is under 1 (within 30 s
  of the job finishing).
- `db-backup.last-success` is newer than `db-backup.last-failure`.
- The newest archive passes `scripts/db-restore.sh --verify-only`.

## 7. What this does NOT mean

- **Not `DatabaseDown`.** The database can be perfectly healthy with no backups.
- **`BackupStale` on a host where no job was ever scheduled** is really
  `BackupNeverSucceeded` plus a missing cron entry.
- **A success is not an off-host copy.** `jtt_backup_last_success_offhost = 0`
  means the archive exists on this host only — DECISION REQUIRED, not an alert.

## 8. Escalate when

`BackupMissedTwice` and a backup cannot be made by hand, or verification fails
on every recent archive.

## 9. Follow-up

Restore-test on real data ([postgres-backup-restore.md §5.6](postgres-backup-restore.md)),
and the off-host destination decision (§10 there).
