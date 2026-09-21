#!/usr/bin/env bash
#
# BETA-P0-013 — the restore drill.
#
#   make db-restore-drill                 (CI: postgres-integration)
#
# REQUIRES DOCKER, and `npm ci` (Node runs the real migrator and the application
# check). Proves a backup is recoverable end to end, against real PostgreSQL
# servers this script creates and removes itself. It never touches the
# development database or any container it did not create: every container is
# named and labelled with this run's id, and cleanup filters on that label.
#
#    1. start a disposable source server and apply the real migrations
#    2. write representative data (scripts/db-restore-drill/seed.sql)
#    3. fingerprint it: row counts and content hashes for every table, schema,
#       sequence positions, migration ledger (fingerprint.sql)
#    4. back it up with scripts/db-backup.sh
#    5. DESTROY the source server; the backup is now the only copy
#    6. start a fresh, empty server, as `docker compose up` does after the
#       volume is lost
#    7. db-restore.sh --verify-only; a truncated and a corrupted copy refused;
#       then --into a scratch database, compared
#    8. prove --replace refuses while a session is connected and when it is not
#       confirmed, and that the refusals change nothing
#    9. db-restore.sh --replace the application database
#   10. compare fingerprints; confirm the previous database was kept, not dropped
#   11. the real migrator finds nothing to apply; the repository the api uses
#       reads the restored history and writes a new attempt
#
# Environment: JTT_TEST_RUN_ID (run-scoped names), DRILL_POSTGRES_IMAGE
# (default postgres:16-alpine, the image docker-compose.yml runs).
set -Eeuo pipefail
set +x
umask 077

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
run_id=$(printf '%s' "${JTT_TEST_RUN_ID:-drill$$}" | tr 'A-Z' 'a-z')
image=${DRILL_POSTGRES_IMAGE:-postgres:16-alpine}
role=jumptotech
database=jumptotech_labs
started_at=$(date +%s)

say() { printf '\n==> %s\n' "$*"; }
indent() { sed 's/^/    /' "$1"; }
fail() {
  printf '\nRESTORE DRILL FAILED: %s\n' "$*" >&2
  exit 1
}

[[ $run_id =~ ^[a-z0-9]+$ ]] || fail "JTT_TEST_RUN_ID must be letters and digits"
prefix="jtt-dbdrill-$run_id"
label="jumptotech.io/restore-drill=$run_id"

command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v node >/dev/null 2>&1 || fail "node is required"
[ -x "$repo/node_modules/.bin/tsx" ] || fail "run npm ci first"

work=$(mktemp -d "${TMPDIR:-/tmp}/jtt-db-restore-drill.XXXXXX")
cleanup() {
  local status=$? id
  for id in $(docker ps -aq --filter "label=$label" 2>/dev/null); do
    docker rm -f "$id" >/dev/null 2>&1 || true
  done
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A random password for disposable servers, handed to Docker in a 0600 file
# rather than on a command line, and to Node in its environment.
password=$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')
[ "${#password}" -eq 48 ] || fail "could not generate a password"
printf 'POSTGRES_USER=%s\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=%s\nPOSTGRES_INITDB_ARGS=--encoding=UTF8 --locale=C\n' \
  "$role" "$password" "$database" >"$work/postgres.env"

start_server() {
  docker run -d --name "$prefix-$1" --label "$label" \
    --security-opt no-new-privileges:true \
    --env-file "$work/postgres.env" \
    -p 127.0.0.1::5432 "$image" >/dev/null
}

server_url() {
  local mapping
  mapping=$(docker port "$prefix-$1" 5432/tcp | head -1)
  printf 'postgresql://%s:%s@127.0.0.1:%s/%s' "$role" "$password" "${mapping##*:}" "$database"
}

# Readiness over TCP from this host, not pg_isready inside the container: the
# image's temporary initdb server answers on the socket — see
# scripts/wait-for-postgres.mjs.
wait_ready() {
  local url attempt
  url=$(server_url "$1")
  for attempt in 1 2; do
    if TEST_DATABASE_URL=$url node "$repo/scripts/wait-for-postgres.mjs"; then return 0; fi
  done
  fail "the $1 server did not become ready"
}

psql_in() {
  local server=$1 db=$2
  shift 2
  docker exec -i -u postgres "$prefix-$server" psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$role" -d "$db" "$@"
}

fingerprint() {
  psql_in "$1" "$2" -f - <"$repo/scripts/db-restore-drill/fingerprint.sql"
}

# Node with only this database configured: nothing from the operator's shell
# can change the transport.
with_database() {
  local url=$1
  shift
  (
    unset DATABASE_SSL DATABASE_SSL_CA_FILE DATABASE_SAME_HOST_PLAINTEXT POSTGRES_HOST \
      PGSSLMODE PGSSLROOTCERT NODE_TLS_REJECT_UNAUTHORIZED
    export DATABASE_URL="$url" NODE_ENV=test
    cd "$repo"
    exec "$@"
  )
}

sessions_on() {
  psql_in target postgres -c "SELECT count(*) FROM pg_stat_activity WHERE datname = '$1' AND pid <> pg_backend_pid()"
}

backup_as_operator() { JTT_DB_CONTAINER="$prefix-source" BACKUP_DIR="$work/backups" "$repo/scripts/db-backup.sh" "$@"; }
restore_as_operator() { JTT_DB_CONTAINER="$prefix-target" "$repo/scripts/db-restore.sh" "$@" </dev/null; }

migration_count=$(find "$repo/services/progress/migrations" -name '*.sql' | wc -l | tr -d ' ')

# --- 1-3 ---------------------------------------------------------------------------

say "1. a disposable source server ($image, run $run_id), with the real migrations"
start_server source
wait_ready source
with_database "$(server_url source)" npm run --silent db:migrate >"$work/migrate-source.log" 2>&1 \
  || { indent "$work/migrate-source.log"; fail "the migrations did not apply to the source server"; }
indent "$work/migrate-source.log"

say "2. representative data"
psql_in source "$database" -f - <"$repo/scripts/db-restore-drill/seed.sql"

say "3. fingerprint the source"
fingerprint source "$database" >"$work/source.fingerprint"
indent "$work/source.fingerprint"
for expected in \
  "^table users 6 " "^table students 6 " "^table lab_attempts 60 " "^table lab_progress 60 " \
  "^table hint_usage 60 " "^table lab_sessions 12 " "^table auth_sessions 6 " "^table user_roles 3 " \
  "^table schema_migrations $migration_count " "^sequence lab_attempts_seq_seq 60$" \
  "^known drill-student-003 Drill Student 3 7/10$"; do
  grep -q "$expected" "$work/source.fingerprint" || fail "the seeded source does not match /$expected/"
done
[ "$(grep -c '^migration ' "$work/source.fingerprint")" -eq "$migration_count" ] || fail "the source migration ledger is incomplete"

# --- 4-6 ---------------------------------------------------------------------------

say "4. back up with scripts/db-backup.sh"
archive=$(backup_as_operator --label drill 2>"$work/backup.log") || { indent "$work/backup.log"; fail "db-backup.sh failed"; }
indent "$work/backup.log"
[ -f "$archive" ] && [ -f "$archive.sha256" ] || fail "db-backup.sh did not leave an archive and its sidecar"
[ "$(ls -l "$archive" | cut -c1-10)" = -rw------- ] || fail "the archive is not 0600"
[ "$(ls -ld "$work/backups" | cut -c1-10)" = drwx------ ] || fail "the backup directory is not 0700"
case $archive in *"$password"*) fail "the password is in the archive name" ;; esac
if grep -qF "$password" "$work/backup.log"; then fail "the password is in the backup log"; fi
# The archive, rendered as SQL by the server's own pg_restore: it carries the
# data, and not the database password.
docker exec -i -u postgres "$prefix-source" pg_restore --file - <"$archive" >"$work/archive.sql" \
  || fail "the archive could not be rendered as SQL"
grep -q '^COPY public.lab_attempts ' "$work/archive.sql" || fail "the archive does not carry lab_attempts data"
if grep -qF "$password" "$work/archive.sql"; then fail "the password is inside the archive"; fi
rm -f "$work/archive.sql"
echo "    archive $(basename "$archive"): 0600, sidecar present, no password in name, log or content"

say "5. destroy the source server: the backup is now the only copy"
docker rm -f "$prefix-source" >/dev/null
[ -z "$(docker ps -aq --filter "name=^$prefix-source$")" ] || fail "the source server still exists"

say "6. a fresh, empty server"
start_server target
wait_ready target
tables=$(psql_in target "$database" -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
[ "$tables" = 0 ] || fail "the fresh server is not empty ($tables tables)"
echo "    $database exists and has no tables, as after a lost volume"

# --- 7-8 ---------------------------------------------------------------------------

say "7. --verify-only, then --into a scratch database"
restore_as_operator --verify-only "$archive" 2>"$work/verify.log" || { indent "$work/verify.log"; fail "--verify-only failed"; }
indent "$work/verify.log"
# A copy cut short, fetched back without its sidecar, and a copy corrupted
# after its table of contents, whose sidecar was made from the corrupt bytes.
# The table of contents is at the front, so both still list with
# pg_restore --list (a cut into the table of contents itself is refused by
# that earlier check), and both must be refused.
size=$(wc -c <"$archive" | tr -d ' ')
head -c $((size - 64)) "$archive" >"$work/truncated.dump"
if restore_as_operator --verify-only --allow-missing-checksum "$work/truncated.dump" 2>"$work/truncated.log"; then
  indent "$work/truncated.log"
  fail "--verify-only accepted an archive missing its last 64 bytes"
fi
grep -q 'truncated or corrupt' "$work/truncated.log" || { indent "$work/truncated.log"; fail "--verify-only did not name a truncated archive"; }
cp "$archive" "$work/corrupt.dump"
printf '\377\377\377\377\377\377\377\377' | dd of="$work/corrupt.dump" bs=1 seek=$((size - 64)) conv=notrunc 2>/dev/null
(cd "$work" && { sha256sum corrupt.dump 2>/dev/null || shasum -a 256 corrupt.dump; } >corrupt.dump.sha256)
if restore_as_operator --into jumptotech_labs_drill_corrupt "$work/corrupt.dump" 2>"$work/corrupt.log"; then
  indent "$work/corrupt.log"
  fail "--into accepted an archive whose data does not decompress"
fi
grep -q 'truncated or corrupt' "$work/corrupt.log" || { indent "$work/corrupt.log"; fail "--into did not name a corrupt archive"; }
[ "$(psql_in target postgres -c "SELECT count(*) FROM pg_database WHERE datname = 'jumptotech_labs_drill_corrupt'")" = 0 ] \
  || fail "a refused --into created its database"
echo "    refused: a copy missing its last 64 bytes (--verify-only) and a corrupted copy with a matching sidecar (--into); nothing created"
restore_as_operator --into jumptotech_labs_drill_check "$archive" 2>"$work/into.log" || { indent "$work/into.log"; fail "--into failed"; }
indent "$work/into.log"
fingerprint target jumptotech_labs_drill_check >"$work/into.fingerprint"
diff -u "$work/source.fingerprint" "$work/into.fingerprint" || fail "the --into restore differs from the source"
echo "    --into: fingerprint identical to the source"

say "8. --replace refuses while connected, and when unconfirmed"
docker exec -d -u postgres "$prefix-target" psql -X -U "$role" -d "$database" -c 'SELECT pg_sleep(300)'
for _ in $(seq 1 40); do
  [ "$(sessions_on "$database")" = 0 ] || break
  sleep 0.25
done
[ "$(sessions_on "$database")" != 0 ] || fail "could not hold a session open on $database"
if restore_as_operator --replace "$database" --confirm "$database" "$archive" 2>"$work/refused-connected.log"; then
  fail "--replace ran while a session was connected"
fi
grep -q 'session(s) are connected' "$work/refused-connected.log" || { indent "$work/refused-connected.log"; fail "--replace did not refuse for the connected session"; }
echo "    refused: $(grep -o '[0-9]* session(s) are connected to [a-z_]*' "$work/refused-connected.log")"
psql_in target postgres -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = '$database' AND pid <> pg_backend_pid()" >/dev/null
for _ in $(seq 1 40); do
  [ "$(sessions_on "$database")" != 0 ] || break
  sleep 0.25
done
if restore_as_operator --replace "$database" "$archive" 2>"$work/refused-unconfirmed.log"; then
  fail "--replace ran without confirmation"
fi
grep -q 'needs confirmation' "$work/refused-unconfirmed.log" || { indent "$work/refused-unconfirmed.log"; fail "--replace did not ask for confirmation"; }
echo "    refused: --replace with no terminal and no --confirm"
leftovers=$(psql_in target postgres -c "SELECT count(*) FROM pg_database WHERE datname ~ '^${database}_(restore|prerestore)_'")
[ "$leftovers" = 0 ] || fail "a refused --replace created a database"
tables=$(psql_in target "$database" -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
[ "$tables" = 0 ] || fail "a refused --replace changed $database"
echo "    both refusals changed nothing"

# --- 9-11 ---------------------------------------------------------------------------

say "9. --replace $database"
restore_started=$(date +%s)
restore_as_operator --replace "$database" --confirm "$database" "$archive" 2>"$work/replace.log" \
  || { indent "$work/replace.log"; fail "--replace failed"; }
restore_seconds=$(($(date +%s) - restore_started))
indent "$work/replace.log"

say "10. compare, and confirm nothing was dropped"
fingerprint target "$database" >"$work/replaced.fingerprint"
diff -u "$work/source.fingerprint" "$work/replaced.fingerprint" || fail "the restored $database differs from the source"
echo "    $database: fingerprint identical to the source ($(grep -c '^table ' "$work/replaced.fingerprint") tables, schema, sequences, ledger)"
retained=$(psql_in target postgres -c "SELECT datname FROM pg_database WHERE datname ~ '^${database}_prerestore_[0-9]{14}$'")
[ "$(printf '%s\n' "$retained" | grep -c .)" = 1 ] || fail "the previous database was not kept"
retained_tables=$(psql_in target "$retained" -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
[ "$retained_tables" = 0 ] || fail "the kept database is not the one that was replaced"
echo "    the replaced (empty) database is kept as $retained"

say "11. the application: migrator and repository"
target_url=$(server_url target)
with_database "$target_url" npm run --silent db:migrate >"$work/migrate-target.log" 2>&1 \
  || { indent "$work/migrate-target.log"; fail "the migrator failed against the restored database"; }
indent "$work/migrate-target.log"
grep -q "database is up to date ($migration_count migration(s) already applied)" "$work/migrate-target.log" \
  || fail "the migrator did not find the restored ledger complete and unmodified"
with_database "$target_url" npm run --silent db:status >"$work/status-target.log" 2>&1 \
  || { indent "$work/status-target.log"; fail "db:status failed against the restored database"; }
indent "$work/status-target.log"
if grep -q PENDING "$work/status-target.log"; then fail "db:status reports a pending migration"; fi
with_database "$target_url" "$repo/node_modules/.bin/tsx" services/progress/bin/restore-drill-check.ts \
  || fail "the application check failed against the restored database"

printf '\nRESTORE DRILL PASSED in %ss (the --replace restore itself took %ss): backup, source destroyed, fresh server, restore, identical fingerprint, migrations current, application read and write.\n' \
  "$(($(date +%s) - started_at))" "$restore_seconds"
