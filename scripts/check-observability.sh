#!/usr/bin/env bash
#
# Validate the observability configuration — PLATFORM-003.
#
# Three things a unit test cannot check, because they are about files that are
# consumed by other programs:
#
#   1. Prometheus rule and config syntax                (promtool)
#   2. Alertmanager config syntax                       (amtool)
#   3. Grafana dashboard JSON, and that every PromQL
#      expression in it names a metric this platform
#      actually exposes                                 (dashboard-queries.test.ts)
#
# (3) is the one that matters most. A dashboard referencing a metric that was
# renamed shows an empty panel, and an empty panel during an incident reads as
# "the thing is at zero" rather than "this query is wrong" — which is how a
# dashboard actively misleads instead of merely failing.
#
# `promtool` and `amtool` are run from their container images when they are not
# on the host, so this works on a laptop with neither installed.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD

PROM_IMAGE="prom/prometheus:v2.54.1"
ALERT_IMAGE="prom/alertmanager:v0.27.0"
failures=0

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; failures=$((failures + 1)); }

# The container fallback mounts the whole repository and starts in the caller's
# directory inside it. Mounting only `$PWD` hid everything above it: the rule
# tests run from `prometheus/tests` and name `../rules/*.yml`, so wherever
# promtool is not installed — CI — none of those files existed in the container,
# promtool only warned, and every expectation ran against rules never loaded.
run_promtool() {
  if command -v promtool >/dev/null 2>&1; then
    promtool "$@"
  elif docker info >/dev/null 2>&1; then
    docker run --rm -v "$ROOT:/w" -w "/w${PWD#"$ROOT"}" --entrypoint promtool "$PROM_IMAGE" "$@"
  else
    return 127
  fi
}

run_amtool() {
  if command -v amtool >/dev/null 2>&1; then
    amtool "$@"
  elif docker info >/dev/null 2>&1; then
    docker run --rm -v "$ROOT:/w" -w "/w${PWD#"$ROOT"}" --entrypoint amtool "$ALERT_IMAGE" "$@"
  else
    return 127
  fi
}

# Print every `rule_files` entry in $1 that matches no file, resolved against $2
# after stripping the container prefix $3 when there is one.
#
# promtool does not refuse this on its own: `test rules` only warns about a
# pattern that matches nothing, and `check config` accepts a glob that matches
# nothing — so a missing rule file was skipped while the check reported success.
# A file with no readable entries is reported too, so a list this cannot parse
# never passes as an empty one.
unresolved_rule_files() {
  local file=$1 base=$2 prefix=${3:-} entries entry pattern match found
  entries=$(awk '
    /^rule_files:/ { in_list = 1; next }
    in_list && /^[[:space:]]*-[[:space:]]/ {
      sub(/^[[:space:]]*-[[:space:]]*/, ""); gsub(/["\047]/, ""); print; next
    }
    in_list && /^[^[:space:]#]/ { in_list = 0 }
  ' "$file")
  if [ -z "$entries" ]; then
    printf '  %s declares no rule_files\n' "$file"
    return 0
  fi
  while IFS= read -r entry; do
    found=0
    pattern=${entry#"$prefix"}
    case "$pattern" in /*) ;; *) pattern="$base/$pattern" ;; esac
    for match in $pattern; do
      if [ -e "$match" ]; then found=1; fi
    done
    if [ "$found" -eq 0 ]; then
      printf '  %s: rule_files entry %s matches no file\n' "$file" "$entry"
    fi
  done <<<"$entries"
}

say "Prometheus rules"
if out=$(run_promtool check rules \
      infrastructure/observability/prometheus/rules/recording.yml \
      infrastructure/observability/prometheus/alerts/*.yml 2>&1); then
  ok "$(printf '%s' "$out" | grep -c 'SUCCESS') rule files valid, $(printf '%s' "$out" | awk '/rules found/ {n+=$2} END {print n}') rules"
elif [ $? -eq 127 ]; then
  bad "neither promtool nor a Docker daemon is available — rules NOT validated"
else
  printf '%s\n' "$out"
  bad "promtool check rules failed"
fi

say "Prometheus config"
#
# `rule_files` in prometheus.yml are container-absolute (/etc/prometheus/...),
# because that is where the compose file mounts them. Validating the config
# therefore has to happen with the same layout, or promtool correctly reports
# that the rule files do not exist — a false failure about a correct config.
#
# The layout is assembled in a temp directory and mounted as ONE volume:
# mounting `secrets/` separately inside a read-only `/etc/prometheus` fails,
# because Docker cannot create the nested mountpoint in a read-only layer.
#
# The scrape token is a runtime bind mount and git-ignored, so a fresh clone has
# none; the copy gets a placeholder, and the real one is never read here.
if ! docker info >/dev/null 2>&1; then
  bad "no Docker daemon — prometheus.yml NOT validated (its rule paths are container-absolute)"
else
  staging=$(mktemp -d)
  trap 'rm -rf "$staging"' EXIT
  cp -R infrastructure/observability/prometheus/. "$staging/"
  mkdir -p "$staging/secrets"
  printf 'placeholder-for-config-validation-only' > "$staging/secrets/scrape-token"

  # `mktemp -d` is 0700 and owned by whoever runs this, but the image runs
  # promtool as `nobody`. On Linux that is `permission denied` before a line is
  # read — how CI failed — while Docker Desktop's file sharing ignores the mode,
  # which is how it passed on a Mac. Nothing here is secret (a copy of committed
  # config and a placeholder token), so it is made world-readable.
  chmod -R a+rX "$staging"

  unresolved=$(unresolved_rule_files "$staging/prometheus.yml" "$staging" /etc/prometheus/)
  if [ -n "$unresolved" ]; then
    printf '%s\n' "$unresolved"
    bad "prometheus.yml names a rule file that does not exist"
  elif out=$(docker run --rm -v "$staging:/etc/prometheus:ro" \
        --entrypoint promtool "$PROM_IMAGE" \
        check config /etc/prometheus/prometheus.yml 2>&1); then
    ok "prometheus.yml valid, and every rule_files path resolves"
  else
    printf '%s\n' "$out"
    bad "promtool check config failed"
  fi
fi

say "Alert rule behaviour"
#
# `promtool test rules` evaluates the REAL recording and alert rules against
# synthetic series, so these are tests of the shipped PromQL rather than of a
# copy of it. They exist because IE-3 produced eight genuinely failed lab starts
# and the alert never fired — a defect that `check rules` passes cleanly, since
# the expression was perfectly valid and simply could not become true for long
# enough.
#
# Every rule file a test names must exist, and promtool must actually have read
# it. A pattern it cannot match is only a warning, after which the expectations
# run against rules that were never loaded — silently passing any test that does
# not depend on them.
tests_dir=infrastructure/observability/prometheus/tests
unresolved=$(for test_file in "$tests_dir"/*.test.yml; do
  unresolved_rule_files "$test_file" "$tests_dir"
done)
if [ -n "$unresolved" ]; then
  printf '%s\n' "$unresolved"
  bad "a rule test names a rule file that does not exist — rule behaviour NOT tested"
else
  status=0
  out=$(cd "$tests_dir" && run_promtool test rules ./*.test.yml 2>&1) || status=$?
  if [ "$status" -eq 127 ]; then
    bad "neither promtool nor a Docker daemon is available — rule behaviour NOT tested"
  elif grep -q 'no file match pattern' <<<"$out"; then
    printf '%s\n' "$out"
    bad "promtool could not read a rule file a test names — rule behaviour NOT tested"
  elif [ "$status" -ne 0 ]; then
    printf '%s\n' "$out"
    bad "promtool test rules failed — an alert does not behave as specified"
  else
    ok "$(printf '%s' "$out" | grep -c 'SUCCESS') rule test file(s) pass"
  fi
fi

say "Alertmanager config"
if out=$(run_amtool check-config infrastructure/observability/alertmanager/alertmanager.yml 2>&1); then
  ok "alertmanager.yml valid"
elif [ $? -eq 127 ]; then
  bad "neither amtool nor a Docker daemon is available — config NOT validated"
else
  printf '%s\n' "$out"
  bad "amtool check-config failed"
fi

say "Dashboards and runbook links"
if npx vitest run test/dashboards.test.ts test/alerts.test.ts \
     --root services/observability >/dev/null 2>&1; then
  ok "every dashboard query names a real metric; every alert has a runbook"
else
  npx vitest run test/dashboards.test.ts test/alerts.test.ts --root services/observability || true
  bad "dashboard / alert validation failed"
fi

echo
if [ "$failures" -eq 0 ]; then
  printf '\033[32mobservability configuration is valid\033[0m\n'
else
  printf '\033[31m%d check(s) failed\033[0m\n' "$failures"
  exit 1
fi
