#!/usr/bin/env bash
#
# Provision the local Kubernetes substrate for JumpToTech Labs.
#
# Runs on the HOST (not inside a container) on purpose: creating a kind
# cluster requires the Docker socket, and we do not want a web-facing
# process to hold that capability. See README → Security limitations.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER_NAME="${LAB_CLUSTER_NAME:-jumptotech-labs}"
KIND_CONFIG="${REPO_ROOT}/infrastructure/kind/cluster.yaml"
GENERATED_DIR="${REPO_ROOT}/infrastructure/kind/generated"

INTERNAL_KUBECONFIG="${GENERATED_DIR}/kubeconfig-internal.yaml"
HOST_KUBECONFIG="${GENERATED_DIR}/kubeconfig-host.yaml"

log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

for bin in docker kind kubectl; do
  command -v "$bin" >/dev/null 2>&1 || fail "'$bin' is not installed or not on PATH."
done

docker info >/dev/null 2>&1 || fail "Docker daemon is not reachable. Start Docker Desktop and retry."

mkdir -p "${GENERATED_DIR}"

if kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; then
  ok "kind cluster '${CLUSTER_NAME}' already exists — reusing it."
else
  log "Creating kind cluster '${CLUSTER_NAME}' (this takes 1-3 minutes on first run)..."
  kind create cluster --name "${CLUSTER_NAME}" --config "${KIND_CONFIG}" --wait 180s
  ok "kind cluster '${CLUSTER_NAME}' created."
fi

# Kubeconfig used by the api/terminal containers. `--internal` rewrites the
# API server address to the control-plane container's DNS name on the shared
# `kind` Docker network, which is exactly how our containers reach it.
log "Exporting kubeconfigs..."
kind get kubeconfig --name "${CLUSTER_NAME}" --internal > "${INTERNAL_KUBECONFIG}"
kind get kubeconfig --name "${CLUSTER_NAME}"            > "${HOST_KUBECONFIG}"

# Readable by the non-root `node` user inside the containers. These are local
# development credentials for a throwaway cluster only.
chmod 644 "${INTERNAL_KUBECONFIG}" "${HOST_KUBECONFIG}"
ok "Wrote ${INTERNAL_KUBECONFIG#"${REPO_ROOT}/"}"
ok "Wrote ${HOST_KUBECONFIG#"${REPO_ROOT}/"}"

log "Verifying cluster health..."
KUBECONFIG="${HOST_KUBECONFIG}" kubectl wait --for=condition=Ready nodes --all --timeout=180s >/dev/null
KUBECONFIG="${HOST_KUBECONFIG}" kubectl get nodes
ok "Cluster '${CLUSTER_NAME}' is ready."

echo
echo "Next: docker compose up --build"
