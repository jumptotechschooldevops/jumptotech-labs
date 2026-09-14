# shellcheck shell=bash
#
# BETA-P0-013 — shared by scripts/db-backup.sh and scripts/db-restore.sh.
# Sourced, never executed. Callers set `set -Eeuo pipefail`, `set +x` and
# `umask 077` before sourcing this file.
#
# ## How PostgreSQL is reached
#
# Every command runs INSIDE the PostgreSQL container, as its `postgres` OS
# account, over the server's own Unix socket:
#
#   docker exec -u postgres <container> pg_dump -U <role> -d <database> …
#
# That choice keeps the credential out of this workflow entirely:
#
#   · the official image trusts local-socket connections, so no password is
#     read, passed, exported or written — not in an argument, the environment,
#     a file name, a log line or the archive;
#   · the client tools are the server's own, so pg_dump is never older than the
#     server it dumps;
#   · no port is needed. In production PostgreSQL publishes nothing and sits on
#     an `internal` network (BETA-P0-012); this path works there unchanged, so
#     that boundary is not widened. There is no network hop, so there is no TLS
#     setting here to get wrong.
#
# The cost: whoever runs these scripts can run `docker exec`, which is
# root-equivalent on the host. That is the operator (or the host's scheduler),
# never a service — nothing here runs inside the stack or mounts the Docker
# socket anywhere.
#
# Bash 3.2 compatible (the macOS system shell), because an operator's laptop is
# one of the places a restore gets rehearsed.

JTT_REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)

# Plain, unquoted PostgreSQL identifiers only. Every database and role name is
# checked against this before it is used, which is what makes interpolating one
# into SQL below safe.
JTT_IDENTIFIER_RE='^[a-z_][a-z0-9_]*$'
JTT_CONTAINER_RE='^[A-Za-z0-9][A-Za-z0-9_.-]*$'
JTT_SHA256_RE='^[0-9a-f]{64}$'

JTT_CONTAINER=
JTT_ROLE=
JTT_STAGE=
JTT_SERVER_VERSION=

jtt_log() {
  printf '%s %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${JTT_LOG_TAG:-db}" "$*" >&2
}

jtt_die() {
  jtt_log "ERROR: $*"
  exit 1
}

jtt_require_command() {
  command -v "$1" >/dev/null 2>&1 || jtt_die "$1 is required but is not on PATH"
}

# The value is never echoed: a malformed name is exactly the input that might
# be something else pasted into the wrong place.
jtt_check_identifier() {
  local what=$1 value=$2
  if [[ ! $value =~ $JTT_IDENTIFIER_RE ]] || [ "${#value}" -gt 63 ]; then
    jtt_die "the $what is not a plain PostgreSQL identifier (a-z, 0-9 and _, starting with a letter or _, at most 63 characters)"
  fi
}

# A command inside the database container, as its `postgres` account.
jtt_pg() {
  docker exec -u postgres "$JTT_CONTAINER" "$@" </dev/null
}

# The same, with this script's stdin attached.
jtt_pg_stdin() {
  docker exec -i -u postgres "$JTT_CONTAINER" "$@"
}

# psql against one database: unaligned, tuples only, stop at the first error.
jtt_psql() {
  local database=$1
  shift
  jtt_pg psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$JTT_ROLE" -d "$database" "$@"
}

# The database container: JTT_DB_CONTAINER, or the one running `postgres`
# service of the compose project.
jtt_resolve_container() {
  if [ -n "${JTT_DB_CONTAINER-}" ]; then
    JTT_CONTAINER=$JTT_DB_CONTAINER
  else
    local project=${COMPOSE_PROJECT_NAME:-jumptotech-labs} ids count
    ids=$(docker ps -q \
      --filter "label=com.docker.compose.project=$project" \
      --filter "label=com.docker.compose.service=postgres") \
      || jtt_die "docker ps failed; is the Docker daemon reachable?"
    count=$(printf '%s' "$ids" | grep -c . || true)
    if [ "$count" != 1 ]; then
      jtt_die "expected one running postgres container for compose project '$project', found $count. Start it (docker compose up -d postgres) or name one with JTT_DB_CONTAINER."
    fi
    JTT_CONTAINER=$ids
  fi
  [[ $JTT_CONTAINER =~ $JTT_CONTAINER_RE ]] || jtt_die "JTT_DB_CONTAINER is not a container name or id"
  local running
  running=$(docker inspect --format '{{.State.Running}}' "$JTT_CONTAINER" 2>/dev/null || true)
  [ "$running" = true ] || jtt_die "container $JTT_CONTAINER is not running"
}

# Non-secret settings from the container's own environment. An allowlist, so
# this helper can never be pointed at the password.
jtt_container_setting() {
  case $1 in
    POSTGRES_USER | POSTGRES_DB) ;;
    *) jtt_die "refusing to read $1 from the container" ;;
  esac
  jtt_pg printenv "$1" 2>/dev/null || true
}

jtt_resolve_role() {
  JTT_ROLE=${JTT_DB_USER:-$(jtt_container_setting POSTGRES_USER)}
  JTT_ROLE=${JTT_ROLE:-postgres}
  jtt_check_identifier "database role" "$JTT_ROLE"
}

jtt_check_server() {
  local answer
  answer=$(jtt_psql postgres -c 'SELECT 1') || true
  if [ "$answer" != 1 ]; then
    jtt_die "cannot run a query in $JTT_CONTAINER as role $JTT_ROLE over the local socket; is PostgreSQL up and initialised?"
  fi
  JTT_SERVER_VERSION=$(jtt_psql postgres -c 'SHOW server_version') \
    || jtt_die "cannot read the server version from $JTT_CONTAINER"
}

# $1 must already have passed jtt_check_identifier.
jtt_database_exists() {
  local answer
  answer=$(jtt_psql postgres -c "SELECT 1 FROM pg_database WHERE datname = '$1'") \
    || jtt_die "cannot list the databases in $JTT_CONTAINER"
  [ "$answer" = 1 ]
}

# A private working directory inside the container, outside the data volume.
# pg_dump writes there, and pg_restore reads from there, because a seekable
# file lets pg_dump record data offsets that a pipe cannot.
jtt_container_stage() {
  local base=${JTT_CONTAINER_TMPDIR:-/tmp}
  JTT_STAGE=$(jtt_pg mktemp -d "$base/jtt-db.XXXXXXXX") \
    || jtt_die "cannot create a working directory inside $JTT_CONTAINER"
  case $JTT_STAGE in
    "$base"/jtt-db.*) ;;
    *) jtt_die "unexpected working directory from mktemp inside $JTT_CONTAINER" ;;
  esac
  case $JTT_STAGE in
    *..* | *[!A-Za-z0-9/._-]*) jtt_die "unexpected working directory from mktemp inside $JTT_CONTAINER" ;;
  esac
}

jtt_container_unstage() {
  if [ -n "$JTT_STAGE" ]; then
    jtt_pg rm -rf "$JTT_STAGE" >/dev/null 2>&1 \
      || jtt_log "WARNING: could not remove $JTT_STAGE inside $JTT_CONTAINER; it holds a copy of the database"
    JTT_STAGE=
  fi
}

jtt_sha256_file() {
  local out
  if command -v sha256sum >/dev/null 2>&1; then
    out=$(sha256sum "$1")
  else
    out=$(shasum -a 256 "$1")
  fi
  out=${out%% *}
  [[ $out =~ $JTT_SHA256_RE ]] || jtt_die "could not compute a SHA-256 checksum"
  printf '%s\n' "$out"
}

jtt_sha256_in_container() {
  local out
  out=$(jtt_pg sha256sum "$1") || jtt_die "could not compute a SHA-256 checksum inside $JTT_CONTAINER"
  out=${out%% *}
  [[ $out =~ $JTT_SHA256_RE ]] || jtt_die "could not compute a SHA-256 checksum inside $JTT_CONTAINER"
  printf '%s\n' "$out"
}

# The archive's table of contents, if it is a readable custom-format archive
# of the application database — one that carries the migration ledger. A dump
# of an empty or unrelated database is readable too; it is not a backup of this
# application, and restoring it would look like success.
jtt_archive_toc() {
  local toc
  toc=$(jtt_pg pg_restore --list "$1") \
    || jtt_die "pg_restore cannot read the archive; it is not a usable backup"
  if ! printf '%s\n' "$toc" | grep -q '^; *Format: CUSTOM'; then
    jtt_die "the archive is not in PostgreSQL custom format"
  fi
  if ! printf '%s\n' "$toc" | grep -q ' TABLE DATA public schema_migrations '; then
    jtt_die "the archive has no schema_migrations data; it is not a backup of the application database"
  fi
  printf '%s\n' "$toc"
}

# Tables whose data the archive carries, one name per line.
jtt_archive_tables() {
  printf '%s\n' "$1" | sed -n 's/^[0-9]*; [0-9]* [0-9]* TABLE DATA public \([a-z_][a-z0-9_]*\) .*$/\1/p' | sort
}

# Exact row counts per table in the public schema, for the log.
jtt_table_counts() {
  jtt_psql "$1" -F ' ' -c "
    SELECT c.relname,
           (xpath('/row/n/text()',
                  query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname"
}

# Compare a database's migration ledger with the migration files in this
# checkout. Pending files are normal for an older backup: the api applies them
# at startup (DATABASE_AUTO_MIGRATE=true) or `npm run db:migrate` does. A file
# whose checksum differs, or a version this checkout does not know, means the
# code and the data disagree and the api will refuse to start.
jtt_report_migrations() {
  local database=$1 applied file version line recorded pending=0 modified=0 unknown=0
  applied=$(jtt_psql "$database" -F ' ' -c 'SELECT version, checksum FROM schema_migrations ORDER BY version') \
    || jtt_die "cannot read schema_migrations in $database"
  for file in "$JTT_REPO_ROOT"/services/progress/migrations/*.sql; do
    [ -f "$file" ] || continue
    version=$(basename "$file" .sql)
    line=$(printf '%s\n' "$applied" | grep "^$version " || true)
    if [ -z "$line" ]; then
      pending=$((pending + 1))
      jtt_log "migration $version: PENDING (applied by the api at startup, or npm run db:migrate)"
    else
      recorded=${line#* }
      if [ "$recorded" != "$(jtt_sha256_file "$file")" ]; then
        modified=$((modified + 1))
        jtt_log "migration $version: CHECKSUM DIFFERS from this checkout; the api will refuse to start"
      fi
    fi
  done
  while IFS=' ' read -r version recorded; do
    [ -n "$version" ] || continue
    if [ ! -f "$JTT_REPO_ROOT/services/progress/migrations/$version.sql" ]; then
      unknown=$((unknown + 1))
      jtt_log "migration $version: recorded in the database but not in this checkout (the backup is newer than this code)"
    fi
  done <<EOF
$applied
EOF
  jtt_log "migration state of $database: $(printf '%s\n' "$applied" | grep -c . || true) applied, $pending pending, $modified modified, $unknown unknown"
  JTT_MIGRATIONS_PENDING=$pending
  JTT_MIGRATIONS_MODIFIED=$modified
  JTT_MIGRATIONS_UNKNOWN=$unknown
}

# BETA-P0-018 — record the outcome of a backup or a verification for monitoring.
#
#   jtt_record_status backup|verify success|failure [SIZE_BYTES] [copied|not_configured]
#
# Writes BACKUP_STATUS_DIR/db-<operation>.last-<outcome> (default
# <repo>/backups/status, git-ignored): key=value lines holding a Unix timestamp
# and, for a backup, the archive's size and whether BACKUP_COPY_HOOK copied it
# off the host. No path, database name, host or credential. The api reads the
# directory read-only and exports jtt_backup_last_{success,failure}_timestamp_seconds,
# which the backup freshness alerts read (docs/runbooks/RB-16-backups.md).
#
# World-readable on purpose — a 0755 directory and 0644 files — because the api
# container runs as a different user and nothing here is secret. Best effort: a
# status that cannot be written is logged and never changes the script's own
# exit status. Monitoring then sees a backup that did not happen, which is the
# safe way round.
jtt_record_status() {
  local operation=$1 outcome=$2 size=${3-} offhost=${4-} dir file tmp
  case "$operation:$outcome" in
    backup:success | backup:failure | verify:success | verify:failure) ;;
    *) return 0 ;;
  esac
  dir=${BACKUP_STATUS_DIR:-$JTT_REPO_ROOT/backups/status}
  case $dir in
    /*) ;;
    *)
      jtt_log "WARNING: BACKUP_STATUS_DIR must be an absolute path; this $operation $outcome was not recorded for monitoring"
      return 0
      ;;
  esac
  # The status directory is mounted into the api. It must never be, contain or
  # sit inside the archive directory, or that mount would carry the archives.
  local archives resolved_dir resolved_archives
  archives=${BACKUP_DIR:-$JTT_REPO_ROOT/backups/postgres}
  resolved_dir=$( (cd "$dir" 2>/dev/null && pwd -P) || printf '%s' "${dir%/}")
  resolved_archives=$( (cd "$archives" 2>/dev/null && pwd -P) || printf '%s' "${archives%/}")
  case "$resolved_dir/" in
    "$resolved_archives/"*)
      jtt_log "WARNING: BACKUP_STATUS_DIR is inside BACKUP_DIR; this $operation $outcome was not recorded for monitoring (the api mounts BACKUP_STATUS_DIR, and must never see the archives)"
      return 0
      ;;
  esac
  case "$resolved_archives/" in
    "$resolved_dir/"*)
      jtt_log "WARNING: BACKUP_DIR is inside BACKUP_STATUS_DIR; this $operation $outcome was not recorded for monitoring (the api mounts BACKUP_STATUS_DIR, and must never see the archives)"
      return 0
      ;;
  esac
  file="$dir/db-$operation.last-$outcome"
  tmp="$dir/.db-$operation.last-$outcome.$$"
  if ! (
    umask 022
    mkdir -p "$dir" &&
      {
        printf 'timestamp_seconds=%s\n' "$(date -u +%s)"
        if [ -n "$size" ]; then printf 'size_bytes=%s\n' "$size"; fi
        if [ -n "$offhost" ]; then printf 'offhost_copy=%s\n' "$offhost"; fi
      } >"$tmp" &&
      chmod 644 "$tmp" &&
      mv -f "$tmp" "$file"
  ) 2>/dev/null; then
    jtt_log "WARNING: could not record this $operation $outcome in $dir for monitoring; check that the directory is writable by this user"
  fi
  return 0
}

# An EXIT trap body: record a failed OPERATION when the script is exiting non-zero.
jtt_record_failure_on_exit() {
  local status=$?
  if [ "$status" -ne 0 ]; then jtt_record_status "$1" failure; fi
  exit "$status"
}
