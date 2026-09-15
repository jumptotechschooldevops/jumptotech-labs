#!/usr/bin/env bash
#
# BETA-P0-013 — the refusals and failure paths of db-backup.sh and
# db-restore.sh, with no Docker daemon and no database.
#
#   bash scripts/test-db-backup-restore.sh     (make test-db-backup; CI `gates`)
#
# `docker` is a fake that runs the "container" command on this host, with fake
# pg_dump, pg_restore and psql first on PATH. Every docker call, psql statement
# and pg_dump/pg_restore invocation is logged per case, so a test can prove a
# refusal happened BEFORE anything that changes a database. A password sentinel
# sits in the environment throughout and must appear in no output, log,
# argument or file name.
#
# What this cannot prove — that a real archive restores into a real server —
# is scripts/db-restore-drill.sh.
set -Eeuo pipefail
set +x
umask 077

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
work=$(mktemp -d "${TMPDIR:-/tmp}/jtt-db-backup-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
fakebin="$work/bin"
mkdir -p "$fakebin"

# --- fakes ------------------------------------------------------------------------

cat >"$fakebin/docker" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
{ printf 'docker'; printf ' %s' "$@"; printf '\n'; } >>"$FAKE_LOG"
case $1 in
  ps)
    if [ -n "${FAKE_PS_IDS-}" ]; then printf '%s\n' $FAKE_PS_IDS; fi
    ;;
  inspect)
    case $3 in
      *State.Running*) echo "${FAKE_RUNNING:-true}" ;;
      *Mounts*) printf '%s\n' "${FAKE_MOUNT_SOURCE:-/var/lib/docker/volumes/fake-postgres-data/_data}" ;;
      *) exit 1 ;;
    esac
    ;;
  exec)
    shift
    while [ $# -gt 0 ]; do
      case $1 in
        -i) shift ;;
        -u) shift 2 ;;
        *) break ;;
      esac
    done
    shift
    export FAKE_IN_CONTAINER=1
    exec "$@"
    ;;
  *)
    echo "fake docker: unexpected command $1" >&2
    exit 1
    ;;
esac
FAKE

cat >"$fakebin/psql" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
database=
sql=
while [ $# -gt 0 ]; do
  case $1 in
    -d) database=$2; shift 2 ;;
    -c) printf 'psql %s: %s\n' "$database" "$2" >>"$FAKE_LOG"; sql="$sql$2;"; shift 2 ;;
    -U | -v | -F) shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "${FAKE_SERVER_DOWN-}" ]; then
  echo 'psql: error: connection to server on socket failed' >&2
  exit 2
fi
case $sql in
  'SELECT 1;') echo 1 ;;
  'SHOW server_version;') echo 16.0 ;;
  *pg_encoding_to_char*) echo 'UTF8|C|C|c' ;;
  *"FROM pg_database WHERE datname = '"*)
    name=${sql#*datname = \'}
    name=${name%%\'*}
    for existing in ${FAKE_DATABASES-}; do
      if [ "$existing" = "$name" ]; then echo 1; fi
    done
    ;;
  *pg_stat_activity*) echo "${FAKE_SESSIONS:-0}" ;;
  *'CREATE DATABASE'*) [ -z "${FAKE_CREATE_FAIL-}" ] || exit 3 ;;
  *'ALTER DATABASE'*) [ -z "${FAKE_SWAP_FAIL-}" ] || { echo 'ERROR: database is being accessed by other users' >&2; exit 3; } ;;
  *'count(*) FROM schema_migrations'*) echo 5 ;;
  *'SELECT version, checksum FROM schema_migrations'*)
    for file in "$FAKE_REPO"/services/progress/migrations/*.sql; do
      sum=$(sha256sum "$file")
      printf '%s %s\n' "$(basename "$file" .sql)" "${sum%% *}"
    done
    ;;
  *query_to_xml*) printf 'schema_migrations 5\nstudents 3\n' ;;
  *)
    echo "fake psql: unexpected statement: $sql" >&2
    exit 3
    ;;
esac
exit 0
FAKE

cat >"$fakebin/pg_dump" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
{ printf 'pg_dump'; printf ' %s' "$@"; printf '\n'; } >>"$FAKE_LOG"
out=
while [ $# -gt 0 ]; do
  case $1 in
    --file) out=$2; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$out" ]
if [ -n "${FAKE_PG_DUMP_FAIL-}" ]; then
  printf 'PGDMP half' >"$out"
  echo 'pg_dump: error: query failed' >&2
  exit 1
fi
if [ -n "${FAKE_PG_DUMP_GARBAGE-}" ]; then
  printf 'not an archive' >"$out"
  exit 0
fi
printf 'PGDMP fake archive %s\n' "$RANDOM$RANDOM" >"$out"
FAKE

cat >"$fakebin/pg_restore" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
{ printf 'pg_restore'; printf ' %s' "$@"; printf '\n'; } >>"$FAKE_LOG"
list=
archive=
while [ $# -gt 0 ]; do
  case $1 in
    --list) list=1; shift ;;
    -d | -U) shift 2 ;;
    -*) shift ;;
    *) archive=$1; shift ;;
  esac
done
if [ "$(head -c 5 "$archive")" != PGDMP ]; then
  echo 'pg_restore: error: input file does not appear to be a valid archive' >&2
  exit 1
fi
if [ -n "$list" ]; then
  printf ';\n; Archive created at 2026-09-14 03:17:00 UTC\n;     dbname: jumptotech_labs\n;     Format: CUSTOM\n;\n'
  [ -n "${FAKE_TOC_NO_MIGRATIONS-}" ] || printf '3001; 0 16400 TABLE DATA public schema_migrations jumptotech\n'
  printf '3002; 0 16401 TABLE DATA public students jumptotech\n'
  exit 0
fi
if [ -n "${FAKE_PG_RESTORE_FAIL-}" ]; then
  echo 'pg_restore: error: could not execute query' >&2
  exit 1
fi
FAKE

cat >"$fakebin/sha256sum" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
if [ "${FAKE_IN_CONTAINER-}" = 1 ] && [ -n "${FAKE_CONTAINER_SHA_WRONG-}" ]; then
  printf '%064d  %s\n' 0 "$1"
  exit 0
fi
if command -v shasum >/dev/null 2>&1; then exec shasum -a 256 "$@"; fi
exec /usr/bin/sha256sum "$@"
FAKE

chmod 700 "$fakebin"/*

# --- harness ------------------------------------------------------------------------

sentinel="p0013sentinel$RANDOM$RANDOM$RANDOM"
export PATH="$fakebin:$PATH"
export FAKE_REPO="$repo"
export POSTGRES_USER=jumptotech POSTGRES_DB=jumptotech_labs
export POSTGRES_PASSWORD="$sentinel" PGPASSWORD="$sentinel"
unset COMPOSE_PROJECT_NAME JTT_DB_NAME JTT_DB_USER

passes=0
failures=0
case_dir=
status=0

new_case() {
  case_dir=$(mktemp -d "$work/case.XXXXXX")
  mkdir -p "$case_dir/backups" "$case_dir/container"
  chmod 755 "$case_dir/backups"
  export FAKE_LOG="$case_dir/fake.log"
  : >"$FAKE_LOG"
  export BACKUP_DIR="$case_dir/backups" JTT_CONTAINER_TMPDIR="$case_dir/container"
  # BETA-P0-018: the monitoring status, kept out of the repository's backups/.
  export BACKUP_STATUS_DIR="$case_dir/status"
  export JTT_DB_CONTAINER=fake-postgres FAKE_DATABASES="postgres jumptotech_labs"
  unset FAKE_PS_IDS FAKE_RUNNING FAKE_MOUNT_SOURCE FAKE_SERVER_DOWN FAKE_SESSIONS \
    FAKE_CREATE_FAIL FAKE_SWAP_FAIL FAKE_PG_DUMP_FAIL FAKE_PG_DUMP_GARBAGE \
    FAKE_TOC_NO_MIGRATIONS FAKE_PG_RESTORE_FAIL FAKE_CONTAINER_SHA_WRONG \
    BACKUP_LABEL BACKUP_RETENTION_DAYS BACKUP_RETENTION_MIN_KEEP BACKUP_COPY_HOOK
}

run() {
  set +e
  "$@" >"$case_dir/out" 2>"$case_dir/err" </dev/null
  status=$?
  set -e
}
backup() { run "$repo/scripts/db-backup.sh" "$@"; }
restore() { run "$repo/scripts/db-restore.sh" "$@"; }

expect() {
  local description=$1
  shift
  if "$@"; then
    passes=$((passes + 1))
    printf 'ok    %s\n' "$description"
  else
    failures=$((failures + 1))
    printf 'FAIL  %s  (exit %s)\n' "$description" "$status"
    tail -n 6 "$case_dir/err" | sed 's/^/      | /'
  fi
}

succeeded() { [ "$status" -eq 0 ]; }
failed() { [ "$status" -ne 0 ]; }
says() { grep -q -- "$1" "$case_dir/err"; }
logged() { grep -q -- "$1" "$FAKE_LOG"; }
nothing_written() { [ -z "$(find "$BACKUP_DIR" -mindepth 1 | head -1)" ]; }
nothing_staged() { [ -z "$(find "$JTT_CONTAINER_TMPDIR" -mindepth 1 | head -1)" ]; }
server_untouched() { [ ! -s "$FAKE_LOG" ]; }
# No statement or restore that changes a database was issued.
no_change() { ! grep -E -q 'CREATE DATABASE|ALTER DATABASE|DROP|^pg_restore .* -d ' "$FAKE_LOG"; }
mode_of() { ls -ld "$1" | cut -c1-10; }

stamp_days_ago() {
  local epoch=$(($(date -u +%s) - $1 * 86400))
  date -u -d "@$epoch" +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -r "$epoch" +%Y%m%dT%H%M%SZ
}
fake_archive() {
  printf 'PGDMP old\n' >"$BACKUP_DIR/$1"
  printf '%s  %s\n' "$(printf '%064d' 0)" "$1" >"$BACKUP_DIR/$1.sha256"
}

# --- db-backup.sh -------------------------------------------------------------------

echo '# db-backup.sh'

new_case
backup
expect 'backup succeeds against a healthy server' succeeded
archive=$(cat "$case_dir/out")
name_ok() { [[ $(basename "$archive") =~ ^jtt-pg-jumptotech_labs-[0-9]{8}T[0-9]{6}Z\.dump$ ]] && [ -f "$archive" ]; }
expect 'prints the archive path, named jtt-pg-<database>-<UTC timestamp>.dump' name_ok
sidecar_ok() {
  local sum
  sum=$(sha256sum "$archive")
  [ "$(cat "$archive.sha256")" = "${sum%% *}  $(basename "$archive")" ]
}
expect 'writes a .sha256 sidecar that matches the archive' sidecar_ok
perms_ok() { [ "$(mode_of "$BACKUP_DIR")" = drwx------ ] && [ "$(mode_of "$archive")" = -rw------- ] && [ "$(mode_of "$archive.sha256")" = -rw------- ]; }
expect 'tightens BACKUP_DIR to 0700 and writes both files 0600' perms_ok
clean_ok() { [ -z "$(find "$BACKUP_DIR" -name '*.partial' -o -name '.db-backup.lock')" ] && nothing_staged; }
expect 'leaves no partial file, no lock, and nothing staged in the container' clean_ok
expect 'dumps in PostgreSQL custom format as the container postgres account' logged 'pg_dump --format=custom --compress=6 -U jumptotech -d jumptotech_labs'
expect 'reads the archive back with pg_restore --list before keeping it' logged '^pg_restore --list '

new_case
backup --label pre-migration
expect '--label becomes a suffix of the archive name' grep -qE -- '-[0-9]{8}T[0-9]{6}Z-pre-migration\.dump$' "$case_dir/out"

new_case
export FAKE_PG_DUMP_FAIL=1
backup
expect 'pg_dump failure: exits non-zero' failed
expect 'pg_dump failure: leaves nothing in BACKUP_DIR' nothing_written
expect 'pg_dump failure: removes the half-written dump inside the container' nothing_staged

new_case
export FAKE_PG_DUMP_GARBAGE=1
backup
expect 'unreadable archive: exits non-zero, names the cause' says 'pg_restore cannot read the archive'
expect 'unreadable archive: leaves nothing in BACKUP_DIR' nothing_written

new_case
export FAKE_TOC_NO_MIGRATIONS=1
backup
expect 'archive without schema_migrations: refused as not an application backup' says 'not a backup of the application database'
expect 'archive without schema_migrations: leaves nothing in BACKUP_DIR' nothing_written

new_case
export FAKE_CONTAINER_SHA_WRONG=1
backup
expect 'copy that does not match the verified archive: refused' says 'checksum mismatch'
expect 'copy that does not match the verified archive: leaves nothing in BACKUP_DIR' nothing_written

new_case
export FAKE_SERVER_DOWN=1
backup
expect 'unreachable server: refused' says 'cannot run a query'
expect 'unreachable server: leaves nothing in BACKUP_DIR' nothing_written

new_case
FAKE_MOUNT_SOURCE=$(cd "$case_dir" && pwd -P)
export FAKE_MOUNT_SOURCE
backup
expect 'BACKUP_DIR inside a mount of the database container: refused' says 'inside a mount of fake-postgres'
expect 'BACKUP_DIR inside a mount of the database container: nothing written' nothing_written

new_case
BACKUP_DIR=/var/lib/postgresql/data/backups backup
expect 'BACKUP_DIR under /var/lib/postgresql: refused before anything is created' says "PostgreSQL's own storage"

new_case
BACKUP_DIR=relative/backups backup
expect 'relative BACKUP_DIR: refused before the server is touched' failed
expect 'relative BACKUP_DIR: the server was not contacted' server_untouched
new_case
BACKUP_RETENTION_DAYS=two backup
expect 'non-numeric BACKUP_RETENTION_DAYS: refused before the server is touched' server_untouched
new_case
BACKUP_RETENTION_MIN_KEEP=0 backup
expect 'BACKUP_RETENTION_MIN_KEEP=0: refused' says 'BACKUP_RETENTION_MIN_KEEP'
new_case
backup --label 'Not A Label'
expect 'a label outside [a-z0-9-]: refused' says 'label may contain only'
new_case
backup --no-such-flag
expect 'an unknown argument: refused' says 'unknown argument'

new_case
mkdir "$BACKUP_DIR/.db-backup.lock"
printf '%s\n' "$$" >"$BACKUP_DIR/.db-backup.lock/pid"
backup
expect 'a live lock: refused as a concurrent run' says 'another backup'
expect 'a live lock: left in place for its holder' test -f "$BACKUP_DIR/.db-backup.lock/pid"
new_case
mkdir "$BACKUP_DIR/.db-backup.lock"
printf '99999999\n' >"$BACKUP_DIR/.db-backup.lock/pid"
backup
expect 'a stale lock: replaced, and the backup runs' succeeded

new_case
unset JTT_DB_CONTAINER
backup
expect 'no compose postgres container running: refused' says 'found 0'
new_case
unset JTT_DB_CONTAINER
export FAKE_PS_IDS='aaa111 bbb222'
backup
expect 'two compose postgres containers: refused rather than guessing' says 'found 2'
new_case
unset JTT_DB_CONTAINER
export FAKE_PS_IDS=abc123
backup
expect 'one compose postgres container: found by its compose labels and used' logged 'docker exec -u postgres abc123 pg_dump'
new_case
export FAKE_RUNNING=false
backup
expect 'a stopped container: refused' says 'is not running'

# Retention: this database's archives only, regular files only, the newest
# BACKUP_RETENTION_MIN_KEEP always kept.
new_case
export BACKUP_RETENTION_DAYS=14 BACKUP_RETENTION_MIN_KEEP=3
for day in 01 02 03 04 05 06 07 08 09 10; do fake_archive "jtt-pg-jumptotech_labs-202001${day}T031700Z.dump"; done
for days in 1 2 3 4; do fake_archive "jtt-pg-jumptotech_labs-$(stamp_days_ago "$days").dump"; done
fake_archive jtt-pg-otherdb-20200101T031700Z.dump
printf 'notes\n' >"$BACKUP_DIR/notes.txt"
printf 'PGDMP elsewhere\n' >"$case_dir/outside.dump"
ln -s "$case_dir/outside.dump" "$BACKUP_DIR/jtt-pg-jumptotech_labs-20190101T000000Z.dump"
backup
expect 'retention: the backup succeeds' succeeded
recent_kept() { [ "$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'jtt-pg-jumptotech_labs-*.dump' | wc -l | tr -d ' ')" -eq 5 ]; }
expect 'retention: keeps every archive inside the window, beyond MIN_KEEP (5 = new + 4 recent)' recent_kept
old_removed() { [ -z "$(ls "$BACKUP_DIR" | grep -E '^jtt-pg-jumptotech_labs-202001')" ]; }
expect 'retention: removes archives, and their sidecars, older than the window' old_removed
others_kept() { [ -f "$BACKUP_DIR/jtt-pg-otherdb-20200101T031700Z.dump" ] && [ -f "$BACKUP_DIR/notes.txt" ] && [ -L "$BACKUP_DIR/jtt-pg-jumptotech_labs-20190101T000000Z.dump" ] && [ -f "$case_dir/outside.dump" ]; }
expect "retention: never touches another database's archives, other files, or symlinks" others_kept

new_case
export BACKUP_RETENTION_DAYS=14 BACKUP_RETENTION_MIN_KEEP=3
for day in 01 02 03 04 05 06 07 08 09 10; do fake_archive "jtt-pg-jumptotech_labs-202001${day}T031700Z.dump"; done
backup
min_keep_ok() { [ -f "$BACKUP_DIR/jtt-pg-jumptotech_labs-20200110T031700Z.dump" ] && [ -f "$BACKUP_DIR/jtt-pg-jumptotech_labs-20200109T031700Z.dump" ] && [ ! -e "$BACKUP_DIR/jtt-pg-jumptotech_labs-20200108T031700Z.dump" ] && [ ! -e "$BACKUP_DIR/jtt-pg-jumptotech_labs-20200108T031700Z.dump.sha256" ]; }
expect 'retention: keeps the newest MIN_KEEP archives however old (new + 2 old)' min_keep_ok

new_case
export BACKUP_RETENTION_DAYS=0
for day in 01 02 03; do fake_archive "jtt-pg-jumptotech_labs-202001${day}T031700Z.dump"; done
backup
expect 'BACKUP_RETENTION_DAYS=0: deletes nothing' test "$(ls "$BACKUP_DIR" | grep -c '\.dump$')" -eq 4

new_case
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@" > "%s/hook.args"\n' "$case_dir" >"$case_dir/hook.sh"
chmod 700 "$case_dir/hook.sh"
BACKUP_COPY_HOOK="$case_dir/hook.sh" backup
hook_ok() { [ "$(cat "$case_dir/hook.args")" = "$(printf '%s\n%s' "$(cat "$case_dir/out")" "$(cat "$case_dir/out").sha256")" ]; }
expect 'BACKUP_COPY_HOOK: runs with the archive and its sidecar' hook_ok
new_case
printf '#!/usr/bin/env bash\nexit 7\n' >"$case_dir/hook.sh"
chmod 700 "$case_dir/hook.sh"
BACKUP_COPY_HOOK="$case_dir/hook.sh" backup
expect 'a failing BACKUP_COPY_HOOK fails the run' says 'NOT copied off-host'
expect 'a failing BACKUP_COPY_HOOK keeps the local archive' test -n "$(find "$BACKUP_DIR" -name '*.dump' -type f)"
new_case
printf '#!/usr/bin/env bash\nexit 0\n' >"$case_dir/hook.sh"
chmod 777 "$case_dir/hook.sh"
BACKUP_COPY_HOOK="$case_dir/hook.sh" backup
expect 'a world-writable BACKUP_COPY_HOOK: refused before the server is touched' server_untouched

# --- db-restore.sh -------------------------------------------------------------------

echo '# db-restore.sh'

# Built directly rather than by db-backup.sh, so a regression there cannot take
# the restore cases down with it.
fixture="$work/fixture.dump"
printf 'PGDMP restore fixture\n' >"$fixture"
sum=$(sha256sum "$fixture")
printf '%s  fixture.dump\n' "${sum%% *}" >"$fixture.sha256"

given_archive() {
  cp "$fixture" "$case_dir/a.dump"
  cp "$fixture.sha256" "$case_dir/a.dump.sha256"
}

new_case
given_archive
restore "$case_dir/a.dump"
expect 'no mode: refused, and the server is not contacted' server_untouched
expect 'no mode: says a mode is required' says 'no mode given'

new_case
restore --verify-only "$case_dir/missing.dump"
expect 'missing file: refused before the server is contacted' server_untouched
expect 'missing file: exits non-zero' failed

new_case
given_archive
restore --verify-only --into other_db "$case_dir/a.dump"
expect 'two modes: refused' says 'exactly one of'

new_case
given_archive
restore --into jtt_check --confirm jtt_check "$case_dir/a.dump"
expect '--confirm outside --replace: refused' says 'only applies to --replace'

new_case
given_archive
printf '%064d  a.dump\n' 0 >"$case_dir/a.dump.sha256"
restore --replace jumptotech_labs --confirm jumptotech_labs "$case_dir/a.dump"
expect 'checksum mismatch: refused before the server is contacted' server_untouched
expect 'checksum mismatch: says so' says 'does not match its .sha256 sidecar'

new_case
given_archive
rm "$case_dir/a.dump.sha256"
restore --verify-only "$case_dir/a.dump"
expect 'no sidecar: refused' says 'has no .sha256 sidecar'
new_case
given_archive
rm "$case_dir/a.dump.sha256"
restore --verify-only --allow-missing-checksum "$case_dir/a.dump"
expect 'no sidecar with --allow-missing-checksum: still verified, and accepted' succeeded

new_case
printf 'garbage\n' >"$case_dir/a.dump"
sum=$(sha256sum "$case_dir/a.dump")
printf '%s  a.dump\n' "${sum%% *}" >"$case_dir/a.dump.sha256"
restore --replace jumptotech_labs --confirm jumptotech_labs "$case_dir/a.dump"
expect 'unreadable archive: refused before any change' no_change
expect 'unreadable archive: says so' says 'cannot read the archive'
expect 'unreadable archive: nothing left staged in the container' nothing_staged

new_case
given_archive
export FAKE_CONTAINER_SHA_WRONG=1
restore --replace jumptotech_labs --confirm jumptotech_labs "$case_dir/a.dump"
expect 'archive altered on its way into the container: refused before any change' no_change
expect 'archive altered on its way into the container: says so' says 'changed on its way'

new_case
given_archive
restore --verify-only "$case_dir/a.dump"
expect '--verify-only: succeeds on a good archive' succeeded
expect '--verify-only: changes nothing' no_change

new_case
given_archive
restore --into jumptotech_labs "$case_dir/a.dump"
expect '--into an existing database: refused' says 'already exists'
expect '--into an existing database: changes nothing' no_change
new_case
given_archive
restore --into postgres "$case_dir/a.dump"
expect '--into a system database: refused before the server is contacted' server_untouched
new_case
given_archive
restore --into 'Bad-Name' "$case_dir/a.dump"
expect '--into a name that is not a plain identifier: refused before the server is contacted' server_untouched

new_case
given_archive
restore --into jtt_restore_check "$case_dir/a.dump"
expect '--into a new database: succeeds' succeeded
expect '--into: creates the database from template0' logged 'CREATE DATABASE jtt_restore_check TEMPLATE template0'
expect '--into: restores in one transaction, stopping at the first error' logged '^pg_restore --exit-on-error --single-transaction --no-owner --no-privileges -U jumptotech -d jtt_restore_check '
into_no_rename() { ! grep -E -q 'ALTER DATABASE|DROP' "$FAKE_LOG"; }
expect '--into: renames and drops nothing' into_no_rename

new_case
given_archive
restore --replace jumptotech_labs "$case_dir/a.dump"
expect '--replace with no terminal and no --confirm: refused' says 'needs confirmation'
expect '--replace with no terminal and no --confirm: changes nothing' no_change

new_case
given_archive
restore --replace jumptotech_labs --confirm jumptotech_lab "$case_dir/a.dump"
expect '--replace with a --confirm that does not match: refused' says 'does not name the database'
expect '--replace with a --confirm that does not match: changes nothing' no_change

new_case
given_archive
export FAKE_SESSIONS=2
restore --replace jumptotech_labs --confirm jumptotech_labs "$case_dir/a.dump"
expect '--replace while sessions are connected: refused' says 'session(s) are connected'
expect '--replace while sessions are connected: changes nothing' no_change

new_case
given_archive
restore --replace ghost_db --confirm ghost_db "$case_dir/a.dump"
expect '--replace a database that does not exist: refused' says 'does not exist'
expect '--replace a database that does not exist: changes nothing' no_change

new_case
given_archive
restore --replace a_database_name_that_is_far_too_long_x --confirm a_database_name_that_is_far_too_long_x "$case_dir/a.dump"
expect '--replace a name with no room for the retained suffix: refused before the server is contacted' server_untouched

new_case
given_archive
restore --replace jumptotech_labs --confirm jumptotech_labs "$case_dir/a.dump"
expect '--replace: succeeds' succeeded
replace_order() {
  local create restore_line begin swap_old swap_new commit
  create=$(grep -n 'CREATE DATABASE jumptotech_labs_restore_[0-9]\{14\} TEMPLATE template0 ENCODING' "$FAKE_LOG" | head -1 | cut -d: -f1)
  restore_line=$(grep -n '^pg_restore .* -d jumptotech_labs_restore_[0-9]\{14\} ' "$FAKE_LOG" | head -1 | cut -d: -f1)
  begin=$(grep -n '^psql postgres: BEGIN$' "$FAKE_LOG" | head -1 | cut -d: -f1)
  swap_old=$(grep -n '^psql postgres: ALTER DATABASE jumptotech_labs RENAME TO jumptotech_labs_prerestore_[0-9]\{14\}$' "$FAKE_LOG" | head -1 | cut -d: -f1)
  swap_new=$(grep -n '^psql postgres: ALTER DATABASE jumptotech_labs_restore_[0-9]\{14\} RENAME TO jumptotech_labs$' "$FAKE_LOG" | head -1 | cut -d: -f1)
  commit=$(grep -n '^psql postgres: COMMIT$' "$FAKE_LOG" | head -1 | cut -d: -f1)
  [ -n "$create" ] && [ -n "$restore_line" ] && [ -n "$begin" ] && [ -n "$swap_old" ] && [ -n "$swap_new" ] && [ -n "$commit" ] &&
    [ "$create" -lt "$restore_line" ] && [ "$restore_line" -lt "$begin" ] &&
    [ $((begin + 1)) -eq "$swap_old" ] && [ $((swap_old + 1)) -eq "$swap_new" ] && [ $((swap_new + 1)) -eq "$commit" ]
}
expect '--replace: stages, restores, then swaps both names inside one BEGIN/COMMIT' replace_order
expect '--replace: drops nothing' bash -c "! grep -q DROP '$FAKE_LOG'"
expect '--replace: explains how to undo the swap' says 'To undo the swap'

new_case
given_archive
export FAKE_PG_RESTORE_FAIL=1
restore --replace jumptotech_labs --confirm jumptotech_labs "$case_dir/a.dump"
expect '--replace when pg_restore fails: exits non-zero, target untouched' says 'jumptotech_labs is untouched'
expect '--replace when pg_restore fails: no rename is attempted' bash -c "! grep -q 'ALTER DATABASE' '$FAKE_LOG'"

new_case
given_archive
export FAKE_SWAP_FAIL=1
restore --replace jumptotech_labs --confirm jumptotech_labs "$case_dir/a.dump"
expect '--replace when the rename fails: reports the rollback' says 'rolled back'

# --- monitoring status (BETA-P0-018) ---------------------------------------------------
#
# What apps/api/src/operations.ts reads to export backup freshness. The format is
# pinned on both sides: parseBackupStatusRecord refuses anything else.

echo '# monitoring status'
status_file() { printf '%s/%s' "$BACKUP_STATUS_DIR" "$1"; }
only_status_keys() { ! grep -vqE '^(timestamp_seconds=[0-9]{9,11}|size_bytes=[0-9]+|offhost_copy=(copied|not_configured))$' "$(status_file "$1")"; }
recent_timestamp() {
  local stamp now
  stamp=$(sed -n 's/^timestamp_seconds=//p' "$(status_file "$1")")
  now=$(date -u +%s)
  [ -n "$stamp" ] && [ $((now - stamp)) -ge 0 ] && [ $((now - stamp)) -lt 120 ]
}

new_case
backup
archive=$(cat "$case_dir/out")
expect 'a successful backup records db-backup.last-success' test -f "$(status_file db-backup.last-success)"
expect 'the success record holds a current Unix timestamp' recent_timestamp db-backup.last-success
size_recorded() { grep -qx "size_bytes=$(wc -c <"$archive" | tr -d ' ')" "$(status_file db-backup.last-success)"; }
expect 'the success record holds the archive size' size_recorded
expect 'without BACKUP_COPY_HOOK the record says the archive was not copied off-host' grep -qx 'offhost_copy=not_configured' "$(status_file db-backup.last-success)"
expect 'the record holds only timestamp, size and off-host keys: no path, name or credential' only_status_keys db-backup.last-success
expect 'the record is world-readable (0644) for the api container user' test "$(mode_of "$(status_file db-backup.last-success)")" = -rw-r--r--
expect 'the status directory is 0755' test "$(mode_of "$BACKUP_STATUS_DIR")" = drwxr-xr-x
expect 'a successful backup records no failure' test ! -e "$(status_file db-backup.last-failure)"
expect 'no status file is written into BACKUP_DIR' bash -c "! ls -A '$BACKUP_DIR' | grep -q 'last-'"

new_case
printf '#!/usr/bin/env bash\nexit 0\n' >"$case_dir/hook.sh"
chmod 700 "$case_dir/hook.sh"
BACKUP_COPY_HOOK="$case_dir/hook.sh" backup
expect 'with a successful BACKUP_COPY_HOOK the record says the archive was copied off-host' grep -qx 'offhost_copy=copied' "$(status_file db-backup.last-success)"

new_case
export FAKE_PG_DUMP_FAIL=1
backup
expect 'a failed backup records db-backup.last-failure' recent_timestamp db-backup.last-failure
expect 'a failed backup records no success' test ! -e "$(status_file db-backup.last-success)"
expect 'a failed backup still leaves nothing in BACKUP_DIR' nothing_written
expect 'a failed backup keeps its own non-zero exit status' failed

new_case
export BACKUP_STATUS_DIR=relative/status
backup
expect 'a relative BACKUP_STATUS_DIR does not fail the backup' succeeded
expect 'a relative BACKUP_STATUS_DIR is reported, not written' says 'BACKUP_STATUS_DIR must be an absolute path'

new_case
export BACKUP_STATUS_DIR="$BACKUP_DIR"
backup
expect 'BACKUP_STATUS_DIR equal to BACKUP_DIR: the backup still succeeds' succeeded
expect 'BACKUP_STATUS_DIR equal to BACKUP_DIR: refused, so the api mount never carries archives' says 'BACKUP_STATUS_DIR is inside BACKUP_DIR'
expect 'BACKUP_STATUS_DIR equal to BACKUP_DIR: no status file written beside the archives' bash -c "! ls -A '$BACKUP_DIR' | grep -q 'last-'"

new_case
export BACKUP_STATUS_DIR="$case_dir"
backup
expect 'BACKUP_DIR inside BACKUP_STATUS_DIR: refused' says 'BACKUP_DIR is inside BACKUP_STATUS_DIR'
expect 'BACKUP_DIR inside BACKUP_STATUS_DIR: no status file written' test ! -e "$case_dir/db-backup.last-success"

new_case
mkdir -p "$BACKUP_STATUS_DIR"
chmod 555 "$BACKUP_STATUS_DIR"
backup
expect 'an unwritable status directory does not fail the backup' succeeded
expect 'an unwritable status directory is reported' says 'could not record this backup success'
chmod 755 "$BACKUP_STATUS_DIR"

new_case
given_archive
restore --verify-only "$case_dir/a.dump"
expect '--verify-only success records db-verify.last-success' recent_timestamp db-verify.last-success
expect '--verify-only success records no backup outcome' test ! -e "$(status_file db-backup.last-success)"

new_case
given_archive
printf '%064d  a.dump\n' 1 >"$case_dir/a.dump.sha256"
restore --verify-only "$case_dir/a.dump"
expect '--verify-only on a corrupt archive: refused' says 'does not match its .sha256 sidecar'
expect '--verify-only on a corrupt archive records db-verify.last-failure, before the server is touched' recent_timestamp db-verify.last-failure
expect '--verify-only on a corrupt archive: the server was not contacted' server_untouched

new_case
given_archive
restore --into restored_copy "$case_dir/a.dump"
expect 'a restore records no verification outcome' test ! -e "$(status_file db-verify.last-success)"

# --- secrets ---------------------------------------------------------------------------

echo '# secrets'
no_sentinel_in_content() { ! grep -rqF "$sentinel" "$work"; }
no_sentinel_in_names() { [ -z "$(find "$work" -name "*$sentinel*" | head -1)" ]; }
expect 'the password sentinel appears in no output, log, docker argument or file' no_sentinel_in_content
expect 'the password sentinel appears in no file name' no_sentinel_in_names

printf '\n%s passed, %s failed\n' "$passes" "$failures"
[ "$failures" -eq 0 ]
