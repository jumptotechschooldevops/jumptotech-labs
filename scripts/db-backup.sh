#!/usr/bin/env bash
#
# BETA-P0-013 — back up the application database.
#
#   scripts/db-backup.sh [--label NAME]
#   make db-backup
#
# Writes one PostgreSQL custom-format archive (pg_dump --format=custom) of the
# application database, and a SHA-256 sidecar, into BACKUP_DIR:
#
#   jtt-pg-<database>-<UTC yyyymmddThhmmssZ>[-<label>].dump
#   jtt-pg-<database>-<UTC yyyymmddThhmmssZ>[-<label>].dump.sha256
#
# Built to be called by cron or any external scheduler. It takes a lock, exits
# non-zero on every failure, and leaves nothing that looks like a backup unless
# the archive was dumped, read back by pg_restore, and checksummed on both sides
# of the copy out of the container. Then it applies retention.
#
# Configuration, from the environment only (this script never reads .env):
#
#   BACKUP_DIR                 Where archives go. Default <repo>/backups/postgres
#                              (git-ignored). Refused if it is inside any mount
#                              of the database container. On a real host this
#                              directory must be copied OFF the host.
#   BACKUP_RETENTION_DAYS      Delete this database's archives older than this.
#                              0 keeps everything. Default 14.
#   BACKUP_RETENTION_MIN_KEEP  Never delete below this many newest archives,
#                              however old. Default 7.
#   BACKUP_LABEL               Optional suffix, e.g. pre-migration ([a-z0-9-],
#                              at most 32). --label overrides it.
#   BACKUP_COPY_HOOK           Optional absolute path of an executable, run with
#                              the archive and its sidecar as arguments, to copy
#                              them off-host. Its failure fails the run. Where it
#                              copies to is a DECISION REQUIRED item.
#   JTT_DB_CONTAINER           The PostgreSQL container. Default: the running
#                              `postgres` service of COMPOSE_PROJECT_NAME
#                              (default jumptotech-labs).
#   JTT_DB_NAME, JTT_DB_USER   Default: the container's POSTGRES_DB and
#                              POSTGRES_USER.
#
# Prints the archive's path on stdout; everything else goes to stderr.
# No password is read, passed or written — see scripts/db-lib.sh.
# Runbook: docs/runbooks/postgres-backup-restore.md
set -Eeuo pipefail
set +x
umask 077

# shellcheck source=scripts/db-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/db-lib.sh"
JTT_LOG_TAG=db-backup

usage() {
  awk 'NR > 2 && /^#/ { sub(/^# ?/, ""); print; next } NR > 2 { exit }' "${BASH_SOURCE[0]}"
}

label=${BACKUP_LABEL-}
while [ $# -gt 0 ]; do
  case $1 in
    --label)
      [ $# -ge 2 ] || jtt_die "--label needs a value"
      label=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) jtt_die "unknown argument; see --help" ;;
  esac
done

backup_dir=${BACKUP_DIR:-$JTT_REPO_ROOT/backups/postgres}
retention_days=${BACKUP_RETENTION_DAYS:-14}
min_keep=${BACKUP_RETENTION_MIN_KEEP:-7}
copy_hook=${BACKUP_COPY_HOOK-}

case $backup_dir in
  /*) ;;
  *) jtt_die "BACKUP_DIR must be an absolute path" ;;
esac
[[ $retention_days =~ ^[0-9]+$ ]] || jtt_die "BACKUP_RETENTION_DAYS must be a whole number of days (0 disables retention)"
[[ $min_keep =~ ^[1-9][0-9]*$ ]] || jtt_die "BACKUP_RETENTION_MIN_KEEP must be a positive whole number"
if [ -n "$label" ] && [[ ! $label =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]; then
  jtt_die "the label may contain only a-z, 0-9 and -, at most 32 characters"
fi
if [ -n "$copy_hook" ]; then
  case $copy_hook in
    /*) ;;
    *) jtt_die "BACKUP_COPY_HOOK must be an absolute path" ;;
  esac
  [ -f "$copy_hook" ] && [ -x "$copy_hook" ] || jtt_die "BACKUP_COPY_HOOK is not an executable file"
  if [ -n "$(find "$copy_hook" -maxdepth 0 -perm -002 2>/dev/null)" ]; then
    jtt_die "BACKUP_COPY_HOOK is world-writable; refusing to run it"
  fi
fi

jtt_require_command docker

partial=
sidecar=
lock_dir=
cleanup() {
  local status=$?
  jtt_container_unstage
  if [ -n "$partial" ]; then rm -f "$partial"; fi
  if [ -n "$sidecar" ]; then rm -f "$sidecar"; fi
  if [ -n "$lock_dir" ]; then rm -rf "$lock_dir"; fi
  if [ "$status" -ne 0 ]; then jtt_log "backup FAILED (exit $status)"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

jtt_resolve_container
jtt_resolve_role
database=${JTT_DB_NAME:-$(jtt_container_setting POSTGRES_DB)}
database=${database:-$JTT_ROLE}
jtt_check_identifier "database name" "$database"
jtt_check_server
jtt_database_exists "$database" || jtt_die "database $database does not exist in $JTT_CONTAINER"

# --- the destination ---------------------------------------------------------

# A backup that shares the database's storage is lost with it. Checked on the
# path as given, before anything is created, and again once it is resolved.
refuse_database_storage() {
  case "$1/" in
    /var/lib/docker/* | */var/lib/postgresql/*)
      jtt_die "BACKUP_DIR is inside Docker's or PostgreSQL's own storage; a backup must not share the database's storage"
      ;;
  esac
}
refuse_database_storage "$backup_dir"
mkdir -p "$backup_dir"
[ -O "$backup_dir" ] || jtt_die "BACKUP_DIR is not owned by the user running the backup"
chmod 700 "$backup_dir"
backup_dir=$(cd "$backup_dir" && pwd -P)
refuse_database_storage "$backup_dir"

mounts=$(docker inspect --format '{{range .Mounts}}{{println .Source}}{{end}}' "$JTT_CONTAINER") \
  || jtt_die "cannot inspect the mounts of $JTT_CONTAINER"
while IFS= read -r source; do
  [ -n "$source" ] || continue
  case "$backup_dir/" in
    "${source%/}/"*)
      jtt_die "BACKUP_DIR is inside a mount of $JTT_CONTAINER; a backup must not share the database's storage"
      ;;
  esac
done <<EOF
$mounts
EOF

# One run at a time. A lock whose holder is gone is stale and is replaced.
take_lock() {
  local dir="$backup_dir/.db-backup.lock" holder
  if ! mkdir "$dir" 2>/dev/null; then
    holder=$(cat "$dir/pid" 2>/dev/null || true)
    if [[ $holder =~ ^[0-9]+$ ]] && ps -p "$holder" >/dev/null 2>&1; then
      jtt_die "another backup (pid $holder) is running against $backup_dir"
    fi
    jtt_log "replacing a stale lock left by pid ${holder:-unknown}"
    rm -rf "$dir"
    mkdir "$dir" || jtt_die "could not take the backup lock"
  fi
  lock_dir=$dir
  printf '%s\n' "$$" >"$dir/pid"
}
take_lock

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
name="jtt-pg-$database-$timestamp${label:+-$label}.dump"
final="$backup_dir/$name"
[ ! -e "$final" ] && [ ! -e "$final.sha256" ] || jtt_die "$name already exists; not overwriting it"

# --- dump, verify, copy out ----------------------------------------------------

jtt_container_stage
jtt_log "dumping $database from $JTT_CONTAINER (PostgreSQL $JTT_SERVER_VERSION) as role $JTT_ROLE"
if ! jtt_pg pg_dump --format=custom --compress=6 -U "$JTT_ROLE" -d "$database" --file "$JTT_STAGE/archive.dump"; then
  jtt_die "pg_dump failed; no backup was written"
fi

toc=$(jtt_archive_toc "$JTT_STAGE/archive.dump")
tables=$(jtt_archive_tables "$toc" | grep -c . || true)
jtt_log "pg_restore read the archive back: $tables table(s) with data"

container_sum=$(jtt_sha256_in_container "$JTT_STAGE/archive.dump")
partial="$backup_dir/.$name.partial"
jtt_pg cat "$JTT_STAGE/archive.dump" >"$partial" || jtt_die "copying the archive out of $JTT_CONTAINER failed; no backup was written"
host_sum=$(jtt_sha256_file "$partial")
if [ "$host_sum" != "$container_sum" ]; then
  jtt_die "the copied archive does not match the one pg_restore verified (checksum mismatch); no backup was written"
fi
jtt_container_unstage

sidecar="$final.sha256"
printf '%s  %s\n' "$host_sum" "$name" >"$sidecar"
chmod 600 "$partial" "$sidecar"
# A rename within one directory: the archive appears complete or not at all.
mv -f "$partial" "$final"
partial=
sidecar=

size=$(wc -c <"$final" | tr -d ' ')
jtt_log "wrote $final ($size bytes, sha256 $host_sum)"

# --- off-host copy -------------------------------------------------------------

if [ -n "$copy_hook" ]; then
  jtt_log "running BACKUP_COPY_HOOK"
  "$copy_hook" "$final" "$final.sha256" \
    || jtt_die "BACKUP_COPY_HOOK failed: $name is kept in $backup_dir but was NOT copied off-host"
else
  jtt_log "no BACKUP_COPY_HOOK: this archive exists on this host only"
fi

# --- retention -----------------------------------------------------------------

apply_retention() {
  if [ "$retention_days" -eq 0 ]; then
    jtt_log "retention disabled (BACKUP_RETENTION_DAYS=0)"
    return 0
  fi
  local cutoff_epoch cutoff names entry stamp rank=0 removed=0
  cutoff_epoch=$(($(date -u +%s) - retention_days * 86400))
  cutoff=$(date -u -d "@$cutoff_epoch" +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -r "$cutoff_epoch" +%Y%m%dT%H%M%SZ)

  # Only this database's archives, named exactly as this script names them, and
  # only regular files: never a symlink, a directory or anything else in there.
  names=$(
    for entry in "$backup_dir"/jtt-pg-"$database"-*.dump; do
      if [ -f "$entry" ] && [ ! -L "$entry" ]; then basename "$entry"; fi
    done | grep -E "^jtt-pg-$database-[0-9]{8}T[0-9]{6}Z(-[a-z0-9][a-z0-9-]*)?\.dump$" | sort -r || true
  )
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    rank=$((rank + 1))
    if [ "$rank" -le "$min_keep" ] || [ "$entry" = "$name" ]; then continue; fi
    stamp=${entry#"jtt-pg-$database-"}
    stamp=${stamp:0:16}
    if [[ $stamp < $cutoff ]]; then
      rm -f "$backup_dir/$entry" "$backup_dir/$entry.sha256"
      removed=$((removed + 1))
      jtt_log "retention: removed $entry"
    fi
  done <<EOF
$names
EOF
  jtt_log "retention: kept archives newer than $retention_days day(s) and at least the newest $min_keep; removed $removed"
}
apply_retention

printf '%s\n' "$final"
