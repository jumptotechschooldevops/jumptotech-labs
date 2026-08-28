#!/usr/bin/env bash
#
# Quick health report for the local lab substrate and services.
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER_NAME="${LAB_CLUSTER_NAME:-jumptotech-labs}"
HOST_KUBECONFIG="${REPO_ROOT}/infrastructure/kind/generated/kubeconfig-host.yaml"
# Ports come from `.env`, because that is where compose read them from when it
# published them. Without this the report probes the defaults: on a stack whose
# .env moves WEB_PORT, `make status` called the web container down — or worse,
# found an unrelated container on :3000 and called it healthy.
#
# The shell environment still wins over `.env`, which is compose's own
# precedence, so `WEB_PORT=33000 make status` keeps meaning what it says.
env_default() {
  local name="$1" line
  [[ -n "${!name:-}" ]] && return 0
  line="$(grep -E "^${name}=" "${REPO_ROOT}/.env" 2>/dev/null | tail -1)" || true
  [[ -n "${line}" ]] && export "${name}=${line#*=}"
  return 0
}
env_default API_PORT
env_default TERMINAL_PORT
env_default WEB_PORT

API_PORT="${API_PORT:-4000}"
TERMINAL_PORT="${TERMINAL_PORT:-4001}"
WEB_PORT="${WEB_PORT:-3000}"

ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '\033[31m✗\033[0m %s\n' "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

head_ "Kubernetes substrate"
if kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; then
  ok "kind cluster '${CLUSTER_NAME}' exists"
  if [ -f "${HOST_KUBECONFIG}" ]; then
    if KUBECONFIG="${HOST_KUBECONFIG}" kubectl get nodes 2>/dev/null; then
      :
    else
      bad "cluster exists but the API server is not responding"
    fi
  else
    bad "missing ${HOST_KUBECONFIG} — run: npm run cluster:up"
  fi
else
  bad "no kind cluster named '${CLUSTER_NAME}' — run: npm run cluster:up"
fi

head_ "Services"
for entry in "api:${API_PORT}" "terminal:${TERMINAL_PORT}"; do
  name="${entry%%:*}"; port="${entry##*:}"
  if curl -fsS --max-time 3 "http://localhost:${port}/health" >/dev/null 2>&1; then
    ok "${name} healthy on :${port}"
  else
    bad "${name} not responding on :${port}"
  fi
done

if curl -fsS --max-time 3 "http://localhost:${WEB_PORT}" >/dev/null 2>&1; then
  ok "web serving on :${WEB_PORT}"
else
  bad "web not responding on :${WEB_PORT}"
fi

head_ "Lab namespace (default)"
if [ -f "${HOST_KUBECONFIG}" ]; then
  KUBECONFIG="${HOST_KUBECONFIG}" kubectl get pods -n default 2>/dev/null || true
fi

echo
