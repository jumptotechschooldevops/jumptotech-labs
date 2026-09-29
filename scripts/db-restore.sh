#!/usr/bin/env bash
#
# BETA-P0-013 — restore the application database from a db-backup.sh archive.
#
#   scripts/db-restore.sh --verify-only                           FILE
#   scripts/db-restore.sh --into    NEW_DATABASE                  FILE
#   scripts/db-restore.sh --replace DATABASE [--confirm DATABASE] FILE
#
# There is no default mode: a file on its own does nothing.
#
#   --verify-only  Checks the checksum sidecar, and that the target server's
#                  pg_restore can read the whole archive, every data block
#                  included. Changes nothing.
#
#   --into         Restores into a database that does not exist yet, beside
#                  whatever is running. Changes nothing that already exists.
#                  Do this first, to inspect a backup before trusting it.
#
#   --replace      Recovery of a live database name. Refuses while any session
#                  is connected to DATABASE, so stop the api first. Restores
#                  into a new staging database, checks it, then renames both in
#                  one transaction:
#                      DATABASE  ->  DATABASE_prerestore_<timestamp>   (kept)
#                      staging   ->  DATABASE
#                  Nothing is dropped. The previous database stays until an
#                  operator removes it by hand, so the swap can be reversed.
#                  The one value not taken from the archive: the session shell
#                  uid sequence carries on after the last uid DATABASE handed
#                  out, so no uid goes to a second session (SEC-ARCH-2).
#                  Confirm by typing DATABASE at the prompt, or pass
#                  --confirm DATABASE when there is no terminal.
#
#   --allow-missing-checksum
#                  Accept an archive with no .sha256 sidecar, such as a copy
#                  fetched from off-host storage without one. It is still read
#                  back in full with pg_restore before anything changes.
#
# The target server is chosen as in db-backup.sh: JTT_DB_CONTAINER, or the
# running `postgres` service of COMPOSE_PROJECT_NAME; JTT_DB_USER defaults to
# the container's POSTGRES_USER. No password is read, passed or written — see
# scripts/db-lib.sh.
#
# Runbook: docs/runbooks/postgres-backup-restore.md
set -Eeuo pipefail
set +x
umask 077

# shellcheck source=scripts/db-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/db-lib.sh"
JTT_LOG_TAG=db-restore

usage() {
  awk 'NR > 2 && /^#/ { sub(/^# ?/, ""); print; next } NR > 2 { exit }' "${BASH_SOURCE[0]}"
}

mode=
target=
confirm=
file=
allow_missing_checksum=false

set_mode() {
  [ -z "$mode" ] || jtt_die "choose exactly one of --verify-only, --into and --replace"
  mode=$1
}

while [ $# -gt 0 ]; do
  case $1 in
    --verify-only)
      set_mode verify
      shift
      ;;
    --into | --replace)
      set_mode "${1#--}"
      [ $# -ge 2 ] || jtt_die "$1 needs a database name"
      target=$2
      shift 2
      ;;
    --confirm)
      [ $# -ge 2 ] || jtt_die "--confirm needs the database name"
      confirm=$2
      shift 2
      ;;
    --allow-missing-checksum)
      allow_missing_checksum=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) jtt_die "unknown option; see --help" ;;
    *)
      [ -z "$file" ] || jtt_die "exactly one backup file, please"
      file=$1
      shift
      ;;
  esac
done

[ -n "$mode" ] || jtt_die "no mode given: choose --verify-only, --into NEW_DATABASE or --replace DATABASE (see --help). Nothing was changed."

# BETA-P0-018. A verification's outcome is recorded for monitoring whichever
# check refuses the archive; the checksum checks below run before `cleanup` is
# installed, so this trap covers them until it is.
if [ "$mode" = verify ]; then trap 'jtt_record_failure_on_exit verify' EXIT; fi
[ -n "$file" ] || jtt_die "no backup file given"
if [ -n "$confirm" ] && [ "$mode" != replace ]; then
  jtt_die "--confirm only applies to --replace"
fi

# --- the archive, before anything touches a server ------------------------------

[ -f "$file" ] || jtt_die "the backup file does not exist or is not a regular file"
[ -r "$file" ] || jtt_die "the backup file is not readable by this user"
file_name=$(basename "$file")

if [ -f "$file.sha256" ]; then
  expected=$(awk 'NR == 1 { print $1 }' "$file.sha256")
  [[ $expected =~ $JTT_SHA256_RE ]] || jtt_die "$file_name.sha256 does not hold a SHA-256 checksum"
  actual=$(jtt_sha256_file "$file")
  [ "$actual" = "$expected" ] || jtt_die "$file_name does not match its .sha256 sidecar; it is corrupt or not the file that was backed up. Nothing was changed."
  jtt_log "checksum matches the sidecar ($actual)"
elif [ "$allow_missing_checksum" = true ]; then
  actual=$(jtt_sha256_file "$file")
  jtt_log "WARNING: no .sha256 sidecar; continuing because --allow-missing-checksum was given (sha256 $actual)"
else
  jtt_die "$file_name has no .sha256 sidecar. Fetch it with the archive, or pass --allow-missing-checksum. Nothing was changed."
fi

case $mode in
  into)
    jtt_check_identifier "database name" "$target"
    case $target in
      postgres | template0 | template1) jtt_die "refusing to restore into the system database $target" ;;
    esac
    ;;
  replace)
    jtt_check_identifier "database name" "$target"
    case $target in
      postgres | template0 | template1) jtt_die "refusing to replace the system database $target" ;;
    esac
    # Room for the _prerestore_<14-digit timestamp> suffix within 63 characters.
    [ "${#target}" -le 37 ] || jtt_die "--replace supports database names of at most 37 characters"
    ;;
esac

# --- the server --------------------------------------------------------------------

jtt_require_command docker

swapped=
cleanup() {
  local status=$?
  jtt_container_unstage
  if [ "$status" -ne 0 ] && [ -n "$swapped" ]; then
    # Past the point of no return: never report this as a failed restore.
    jtt_log "WARNING: a step after the swap failed (exit $status), but the swap itself COMMITTED: $swapped"
  elif [ "$status" -ne 0 ]; then
    jtt_log "restore FAILED (exit $status)"
  fi
  if [ "$status" -ne 0 ] && [ "$mode" = verify ]; then jtt_record_status verify failure; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

jtt_resolve_container
jtt_resolve_role
jtt_check_server
jtt_log "target server: $JTT_CONTAINER (PostgreSQL $JTT_SERVER_VERSION), role $JTT_ROLE"

jtt_container_stage
jtt_pg_stdin sh -c 'umask 077 && cat > "$1"' sh "$JTT_STAGE/archive.dump" <"$file" \
  || jtt_die "copying the archive into $JTT_CONTAINER failed. Nothing was changed."
[ "$(jtt_sha256_in_container "$JTT_STAGE/archive.dump")" = "$actual" ] \
  || jtt_die "the archive changed on its way into $JTT_CONTAINER. Nothing was changed."

toc=$(jtt_archive_toc "$JTT_STAGE/archive.dump")
jtt_archive_read_all "$JTT_STAGE/archive.dump"
archive_tables=$(jtt_archive_tables "$toc")
created=$(printf '%s\n' "$toc" | sed -n 's/^; *Archive created at //p' | head -1)
source_db=$(printf '%s\n' "$toc" | sed -n 's/^; *dbname: //p' | head -1)
jtt_log "archive is readable: database '${source_db:-?}', created ${created:-?}, $(printf '%s\n' "$archive_tables" | grep -c . || true) table(s) with data"

if [ "$mode" = verify ]; then
  jtt_log "verify-only: nothing was changed"
  jtt_record_status verify success
  exit 0
fi

# Restore the staged archive into an existing, empty database. One transaction,
# stopping at the first error, so a failure leaves that database empty. Objects
# are owned by the restoring role, which is the application's role.
restore_into() {
  jtt_log "restoring into $1"
  jtt_pg pg_restore --exit-on-error --single-transaction --no-owner --no-privileges \
    -U "$JTT_ROLE" -d "$1" "$JTT_STAGE/archive.dump"
}

# The restored database carries the migration ledger and every table the
# archive had data for.
check_restored() {
  local database=$1 count table
  count=$(jtt_psql "$database" -c 'SELECT count(*) FROM schema_migrations') \
    || jtt_die "the restored database $database has no readable schema_migrations table"
  [[ $count =~ ^[1-9][0-9]*$ ]] || jtt_die "the restored database $database records no applied migrations"
  local present
  present=$(jtt_table_counts "$database") || jtt_die "cannot count rows in $database"
  while IFS= read -r table; do
    [ -n "$table" ] || continue
    grep -q "^$table " <<<"$present" || jtt_die "table $table is in the archive but not in the restored database"
  done <<EOF
$archive_tables
EOF
  local rows
  while IFS=' ' read -r table rows; do
    [ -n "$table" ] || continue
    jtt_log "  $table: $rows row(s)"
  done <<EOF
$present
EOF
}

sessions_on() {
  jtt_psql postgres -c "SELECT count(*) FROM pg_stat_activity WHERE datname = '$1' AND pid <> pg_backend_pid()"
}

# --- --into -------------------------------------------------------------------------

if [ "$mode" = into ]; then
  if jtt_database_exists "$target"; then
    jtt_die "database $target already exists; --into only creates a new database. Nothing was changed."
  fi
  jtt_psql postgres -c "CREATE DATABASE $target TEMPLATE template0" \
    || jtt_die "could not create database $target"
  if ! restore_into "$target"; then
    jtt_die "pg_restore failed; database $target was created by this run and is left empty for inspection"
  fi
  check_restored "$target"
  jtt_report_migrations "$target"
  jtt_log "restored into $target. Inspect it, then remove it when finished (see the runbook). Nothing else was changed."
  exit 0
fi

# --- --replace ---------------------------------------------------------------------

jtt_database_exists "$target" \
  || jtt_die "database $target does not exist. On a server without it, use --into $target."

if [ -n "$confirm" ]; then
  [ "$confirm" = "$target" ] || jtt_die "--confirm does not name the database being replaced. Nothing was changed."
elif [ -t 0 ]; then
  printf '\nThis replaces database %s in %s with the archive %s.\n' "$target" "$JTT_CONTAINER" "$file_name" >&2
  printf 'The current database is kept, renamed, and nothing is dropped.\n' >&2
  printf 'Type the database name to continue: ' >&2
  read -r answer || answer=
  [ "$answer" = "$target" ] || jtt_die "confirmation did not match. Nothing was changed."
else
  jtt_die "--replace needs confirmation: run it from a terminal, or pass --confirm $target. Nothing was changed."
fi

connected=$(sessions_on "$target") || jtt_die "cannot list sessions on $target"
if [ "$connected" != 0 ]; then
  jtt_die "$connected session(s) are connected to $target. Stop the api first (docker compose stop api), then run this again. Nothing was changed."
fi

properties=$(jtt_psql postgres -F '|' -c "SELECT pg_encoding_to_char(encoding), datcollate, datctype, datlocprovider FROM pg_database WHERE datname = '$target'") \
  || jtt_die "cannot read the properties of $target"
encoding=$(printf '%s' "$properties" | cut -d'|' -f1)
collate=$(printf '%s' "$properties" | cut -d'|' -f2)
ctype=$(printf '%s' "$properties" | cut -d'|' -f3)
provider=$(printf '%s' "$properties" | cut -d'|' -f4)
for value in "$encoding" "$collate" "$ctype"; do
  [[ $value =~ ^[A-Za-z0-9_.@-]+$ ]] || jtt_die "unexpected encoding or locale on $target"
done
[ "$provider" = c ] || jtt_die "$target uses a non-libc locale provider, which this script does not recreate"

stamp=$(date -u +%Y%m%d%H%M%S)
staging="${target}_restore_$stamp"
retained="${target}_prerestore_$stamp"
if jtt_database_exists "$staging" || jtt_database_exists "$retained"; then
  jtt_die "a database named $staging or $retained already exists. Nothing was changed."
fi

jtt_psql postgres -c "CREATE DATABASE $staging TEMPLATE template0 ENCODING '$encoding' LC_COLLATE '$collate' LC_CTYPE '$ctype'" \
  || jtt_die "could not create the staging database $staging. Nothing was changed."
if ! restore_into "$staging"; then
  jtt_die "pg_restore failed. $target is untouched; the staging database $staging is left empty for inspection."
fi
check_restored "$staging"

# SEC-ARCH-2 (migration 007): a session's shell uid is handed out once, ever,
# so nothing a shell left in the terminal container — a file, a process that
# escaped its teardown — passes to another student. The archive holds the uid
# sequence where it stood at the backup; the database being replaced has
# handed out every uid since. Restored as archived, those uids would go to new
# sessions again, while the shells that held them may still be running. So the
# restored sequence carries on after the higher of the two. Nothing is lost:
# a uid is a number, not data.
#   empty   — no such sequence (a database from before migration 007)
#   unused  — the sequence exists and has handed out nothing
#   N       — the last uid handed out
shell_uid_position() {
  local value
  value=$(jtt_psql "$1" -c "SELECT coalesce(last_value::text, 'unused') FROM pg_sequences WHERE schemaname = 'public' AND sequencename = 'lab_session_shell_uid_seq'") \
    || return 1
  [[ $value =~ ^([0-9]+|unused)?$ ]] || return 1
  printf '%s' "$value"
}
live_uid=$(shell_uid_position "$target") \
  || jtt_die "cannot read the shell uid sequence of $target. $target is untouched; the restored copy is in $staging."
restored_uid=$(shell_uid_position "$staging") \
  || jtt_die "cannot read the shell uid sequence of $staging. $target is untouched; the restored copy is in $staging."
[ "$live_uid" != unused ] || live_uid=
if [ -n "$live_uid" ] && [ -z "$restored_uid" ]; then
  jtt_log "WARNING: $target has handed out shell uids up to $live_uid, and the archive predates migration 007, which records them. Restart the terminal (it clears every shell and file of an earlier session) before students start labs."
elif [ -n "$live_uid" ] && { [ "$restored_uid" = unused ] || [ "$live_uid" -gt "$restored_uid" ]; }; then
  jtt_psql "$staging" -c "SELECT setval('lab_session_shell_uid_seq', $live_uid, true)" >/dev/null \
    || jtt_die "could not carry the shell uid sequence into $staging. $target is untouched; the restored copy is in $staging."
  jtt_log "shell uids: the archive stood at ${restored_uid/unused/none handed out}; $target had handed out up to ${live_uid}. The restored database continues after $live_uid, so no uid is given twice."
fi

connected=$(sessions_on "$target") || jtt_die "cannot list sessions on $target"
if [ "$connected" != 0 ]; then
  jtt_die "a session connected to $target during the restore. $target is untouched; the restored copy is in $staging."
fi

# One transaction: both renames happen, or neither does. PostgreSQL itself
# refuses to rename a database anything is connected to.
if ! jtt_psql postgres \
  -c 'BEGIN' \
  -c "ALTER DATABASE $target RENAME TO $retained" \
  -c "ALTER DATABASE $staging RENAME TO $target" \
  -c 'COMMIT'; then
  jtt_die "the swap failed and was rolled back. $target is unchanged; the restored copy is in $staging."
fi

swapped="$target is now the restored archive; the previous database is kept as $retained. Do not run --replace again; to undo, rename them back (the runbook, §6.6)."
jtt_log "replaced $target with the archive; the previous database is kept as $retained"
# The swap has committed, so nothing after it may turn this into a reported
# failure: an operator told "restore FAILED" would believe $target untouched.
if ! (jtt_report_migrations "$target"); then
  jtt_log "WARNING: the migration report could not be read; $target was replaced all the same. Run npm run db:status (or start the api and read its migration log line) before letting students in."
fi
cat >&2 <<EOF

Next:
  1. If the terminal kept running, restart it (docker compose restart
     terminal): that drops every shell and file of sessions the archive does
     not know about.
  2. Start the api. With DATABASE_AUTO_MIGRATE=true it applies any pending
     migration at startup; otherwise run npm run db:migrate.
  3. Validate the application (docs/runbooks/postgres-backup-restore.md, "Validate").
  4. To undo the swap, stop the api and run:
       docker exec -u postgres $JTT_CONTAINER psql -X -v ON_ERROR_STOP=1 -U $JTT_ROLE -d postgres \\
         -c 'BEGIN' \\
         -c 'ALTER DATABASE $target RENAME TO ${target}_failed_$stamp' \\
         -c 'ALTER DATABASE $retained RENAME TO $target' \\
         -c 'COMMIT'
  5. Once the restore is accepted, remove $retained by hand (see the runbook).

EOF
