# shellcheck shell=bash
#
# Shared by scripts/production-preflight.sh, scripts/private-beta-smoke.sh and
# scripts/host-capacity-sample.sh. Sourced, never run.
#
# One vocabulary for every production-host result, so an operator's evidence
# file reads the same whichever script wrote it:
#
#   PASS                   checked, and satisfied
#   FAIL                   checked, and not satisfied
#   WARN                   checked; allowed, but not the proven configuration
#   INFO                   measured and recorded, never judged
#   MANUAL CHECK REQUIRED  cannot be proven by a script; a person must
#
# Nothing here reads or prints a secret value.

jtt_pass_count=0
jtt_fail_count=0
jtt_warn_count=0
jtt_manual_count=0
jtt_info_count=0
jtt_lines=()

jtt_record() {
  local status=$1 id=$2 detail=$3 label=$1 line
  case $status in
    PASS) jtt_pass_count=$((jtt_pass_count + 1)) ;;
    FAIL) jtt_fail_count=$((jtt_fail_count + 1)) ;;
    WARN) jtt_warn_count=$((jtt_warn_count + 1)) ;;
    MANUAL) jtt_manual_count=$((jtt_manual_count + 1)); label='MANUAL CHECK REQUIRED' ;;
    INFO) jtt_info_count=$((jtt_info_count + 1)) ;;
    *) echo "jtt_record: unknown status $status" >&2; return 2 ;;
  esac
  line=$(printf '%-5s  %s  %s' "$label" "$id" "$detail")
  printf '%s\n' "$line"
  jtt_lines+=("$line")
}
pass() { jtt_record PASS "$@"; }
fail() { jtt_record FAIL "$@"; }
warn() { jtt_record WARN "$@"; }
manual() { jtt_record MANUAL "$@"; }
info() { jtt_record INFO "$@"; }
section() { printf '\n== %s\n' "$1"; }

jtt_summary_line() {
  printf '%d PASS, %d FAIL, %d WARN, %d MANUAL CHECK REQUIRED, %d INFO' \
    "$jtt_pass_count" "$jtt_fail_count" "$jtt_warn_count" "$jtt_manual_count" "$jtt_info_count"
}

# An installed executable. `type -P`, not `command -v`: the wrappers below are
# functions, and a function must not make a missing binary look installed.
have() { type -P "$1" >/dev/null 2>&1; }

# Match against captured text, never `cmd | grep -q`. Under `set -o pipefail`
# grep -q exits at its first match, the writer can then die of SIGPIPE, and the
# pipeline reports failure for text that did match — an intermittent false
# result that a large `ss` or `configz` output on a real host would trigger.
# jtt_contains TEXT GREP-ARGS...
jtt_contains() {
  local text=$1
  shift
  grep -q "$@" <<<"$text"
}

# --- bounded external calls ---------------------------------------------------------
#
# A wedged Docker daemon or cluster API must produce a FAIL, not a script that
# never finishes. Every docker, kubectl and kind call runs under coreutils
# `timeout` (JTT_COMMAND_TIMEOUT seconds, default 60; npx gets
# JTT_TOOL_TIMEOUT, default 300, because it compiles TypeScript and renders
# compose). A timed-out call exits 124 and is reported like any other failure.
# Where `timeout` is absent (macOS, not a production host) calls are unbounded.
jtt_bounded() {
  local seconds=$1
  shift
  if type -P timeout >/dev/null 2>&1; then
    timeout -k 5 "$seconds" "$@"
  else
    command "$@"
  fi
}
docker() { jtt_bounded "${JTT_COMMAND_TIMEOUT:-60}" docker "$@"; }
kubectl() { jtt_bounded "${JTT_COMMAND_TIMEOUT:-60}" kubectl "$@"; }
kind() { jtt_bounded "${JTT_COMMAND_TIMEOUT:-60}" kind "$@"; }
npx() { jtt_bounded "${JTT_TOOL_TIMEOUT:-300}" npx "$@"; }

# --- portable file facts: GNU stat on a Linux host, BSD stat where tests may run ---

mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
gid_of() { stat -c '%g' "$1" 2>/dev/null || stat -f '%g' "$1"; }
uid_of() { stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1"; }
other_can_read() { local m; m=$(mode_of "$1") && (((8#$m & 4) != 0)); }
other_can_enter() { local m; m=$(mode_of "$1") && (((8#$m & 1) != 0)); }
group_or_other_bits() { local m; m=$(mode_of "$1") && (((8#$m & 8#077) != 0)); }
sha256() { if have sha256sum; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }

# --- .env, read as data: never sourced, never executed, never printed ---------------

# jtt_env_value FILE NAME — the last assignment wins, as in Compose; surrounding
# quotes are removed. Returns 1 when the name is not assigned.
jtt_env_value() {
  local file=$1 name=$2 line value= found=1
  [ -r "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      "$name="*)
        value=${line#"$name="}
        found=0
        ;;
    esac
  done <"$file"
  [ $found -eq 0 ] || return 1
  case $value in
    \"*\") value=${value#\"}; value=${value%\"} ;;
    \'*\') value=${value#\'}; value=${value%\'} ;;
  esac
  printf '%s' "$value"
}

# The production command, exactly as docs/runbooks/private-beta-operations.md §1
# defines `prod`. Run from the checkout so Compose reads its .env.
JTT_PRODUCTION_COMPOSE_FILES=(
  docker-compose.yml docker-compose.runtime.yml docker-compose.observability.yml
  docker-compose.production.yml docker-compose.production-observability.yml
)
jtt_prod() {
  local args=() file
  for file in "${JTT_PRODUCTION_COMPOSE_FILES[@]}"; do args+=(-f "$file"); done
  (cd "$jtt_repo" && docker compose "${args[@]}" --profile observability "$@")
}
