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
err()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; }

LEASE_FILE="${GENERATED_DIR}/cluster-${CLUSTER_NAME}.lease"
RUNTIME_OWNER="${RUNTIME_OWNER_ID:-jumptotech}"

# Who else is using this cluster?
#
# Seven worktrees share one kind cluster, and deleting it takes out every lab
# session and every integration run on the machine. `cluster:up` appends a lease
# line per run; anything here from another owner is somebody actively testing.
#
# Advisory rather than a lock: it refuses by default and takes `--force` when
# the operator knows better. A stale lease from a crashed run is the expected
# failure, which is why the message names the owners rather than just refusing.
foreign_leases() {
  [[ -f "${LEASE_FILE}" ]] || return 0
  awk -v me="${RUNTIME_OWNER}" -F'\t' '$2 != me { print $2 }' "${LEASE_FILE}" | sort -u
}

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

if ! command -v kind >/dev/null 2>&1; then
  warn "'kind' is not installed; nothing to do."
  exit 0
fi

OTHERS="$(foreign_leases)"
if [[ -n "${OTHERS}" && "${FORCE}" -eq 0 ]]; then
  err "Refusing to delete kind cluster '${CLUSTER_NAME}'."
  err "It is leased by another runtime owner:"
  while IFS= read -r owner; do [[ -n "${owner}" ]] && err "  - ${owner}"; done <<< "${OTHERS}"
  err ""
  err "Deleting it would destroy every lab session and integration run using it."
  err "If those leases are stale, re-run with: npm run cluster:down -- --force"
  exit 1
fi

if kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; then
  kind delete cluster --name "${CLUSTER_NAME}"
  ok "Deleted kind cluster '${CLUSTER_NAME}'."
else
  warn "No kind cluster named '${CLUSTER_NAME}'."
fi

# Only this cluster's kubeconfigs, never another cluster's.
rm -f "${GENERATED_DIR}/kubeconfig-internal-${CLUSTER_NAME}.yaml" \
      "${GENERATED_DIR}/kubeconfig-host-${CLUSTER_NAME}.yaml" \
      "${LEASE_FILE}"
if [[ "${CLUSTER_NAME}" == "jumptotech-labs" ]]; then
  rm -f "${GENERATED_DIR}/kubeconfig-internal.yaml" "${GENERATED_DIR}/kubeconfig-host.yaml"
fi
ok "Removed generated kubeconfigs for '${CLUSTER_NAME}'."
