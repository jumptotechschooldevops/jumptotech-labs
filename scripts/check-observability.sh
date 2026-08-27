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

PROM_IMAGE="prom/prometheus:v2.54.1"
ALERT_IMAGE="prom/alertmanager:v0.27.0"
failures=0

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; failures=$((failures + 1)); }

run_promtool() {
  if command -v promtool >/dev/null 2>&1; then
    promtool "$@"
  elif docker info >/dev/null 2>&1; then
    docker run --rm -v "$PWD:/w" -w /w --entrypoint promtool "$PROM_IMAGE" "$@"
  else
    return 127
  fi
}

run_amtool() {
  if command -v amtool >/dev/null 2>&1; then
    amtool "$@"
  elif docker info >/dev/null 2>&1; then
    docker run --rm -v "$PWD:/w" -w /w --entrypoint amtool "$ALERT_IMAGE" "$@"
  else
    return 127
  fi
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

  if out=$(docker run --rm -v "$staging:/etc/prometheus:ro" \
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
if out=$(cd infrastructure/observability/prometheus/tests \
      && run_promtool test rules ./*.test.yml 2>&1); then
  ok "$(printf '%s' "$out" | grep -c 'SUCCESS') rule test file(s) pass"
elif [ $? -eq 127 ]; then
  bad "neither promtool nor a Docker daemon is available — rule behaviour NOT tested"
else
  printf '%s\n' "$out"
  bad "promtool test rules failed — an alert does not behave as specified"
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
