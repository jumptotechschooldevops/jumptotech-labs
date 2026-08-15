#!/usr/bin/env bash
#
# Tear down the local Kubernetes substrate.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER_NAME="${LAB_CLUSTER_NAME:-jumptotech-labs}"
GENERATED_DIR="${REPO_ROOT}/infrastructure/kind/generated"

ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }

if ! command -v kind >/dev/null 2>&1; then
  warn "'kind' is not installed; nothing to do."
  exit 0
fi

if kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; then
  kind delete cluster --name "${CLUSTER_NAME}"
  ok "Deleted kind cluster '${CLUSTER_NAME}'."
else
  warn "No kind cluster named '${CLUSTER_NAME}'."
fi

rm -f "${GENERATED_DIR}/kubeconfig-internal.yaml" "${GENERATED_DIR}/kubeconfig-host.yaml"
ok "Removed generated kubeconfigs."
