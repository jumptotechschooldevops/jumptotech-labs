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

# Kubeconfig paths are derived from the cluster name.
#
# They used to be fixed, so two worktrees creating differently-named clusters
# would overwrite each other's credentials and each would then be talking to the
# other's cluster. The legacy paths are still written for the default cluster,
# because tests and scripts fall back to them when KUBECONFIG is unset.
INTERNAL_KUBECONFIG="${GENERATED_DIR}/kubeconfig-internal-${CLUSTER_NAME}.yaml"
HOST_KUBECONFIG="${GENERATED_DIR}/kubeconfig-host-${CLUSTER_NAME}.yaml"
LEGACY_INTERNAL="${GENERATED_DIR}/kubeconfig-internal.yaml"
LEGACY_HOST="${GENERATED_DIR}/kubeconfig-host.yaml"

# A lease recording who is using this cluster, so `cluster:down` in one worktree
# cannot destroy a cluster another worktree is testing against.
LEASE_FILE="${GENERATED_DIR}/cluster-${CLUSTER_NAME}.lease"

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

# Keep the historical filenames working for the default cluster: every existing
# script and integration suite falls back to them when KUBECONFIG is unset.
if [[ "${CLUSTER_NAME}" == "jumptotech-labs" ]]; then
  cp "${INTERNAL_KUBECONFIG}" "${LEGACY_INTERNAL}"
  cp "${HOST_KUBECONFIG}" "${LEGACY_HOST}"
  chmod 644 "${LEGACY_INTERNAL}" "${LEGACY_HOST}"
fi

# Record this run's interest in the cluster. Append-only and advisory: it tells
# `cluster:down` who else is using it, and is never a lock on cluster *use*.
printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${RUNTIME_OWNER_ID:-jumptotech}" "$$" \
  >> "${LEASE_FILE}"
ok "Wrote ${INTERNAL_KUBECONFIG#"${REPO_ROOT}/"}"
ok "Wrote ${HOST_KUBECONFIG#"${REPO_ROOT}/"}"

log "Verifying cluster health..."
KUBECONFIG="${HOST_KUBECONFIG}" kubectl wait --for=condition=Ready nodes --all --timeout=180s >/dev/null
KUBECONFIG="${HOST_KUBECONFIG}" kubectl get nodes
ok "Cluster '${CLUSTER_NAME}' is ready."

ADMISSION_MANIFEST="${REPO_ROOT}/infrastructure/kind/admission/lab-rbac-policy.yaml"
if [[ -f "${ADMISSION_MANIFEST}" ]]; then
  log "Applying lab admission policies..."
  KUBECONFIG="${HOST_KUBECONFIG}" kubectl apply -f "${ADMISSION_MANIFEST}"
  ok "Admission policies applied."
fi

# A *default* StorageClass, whatever it is called.
#
# This asked for one named `local-path`, which kind never provides: kind ships
# `standard`, backed by the same rancher.io/local-path provisioner. The check
# therefore always missed and would install a second provisioner alongside the
# working one, leaving two storage classes and an ambiguous default.
DEFAULT_SC="$(KUBECONFIG="${HOST_KUBECONFIG}" kubectl get storageclass \
  -o jsonpath='{.items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")].metadata.name}' \
  2>/dev/null || true)"

if [[ -z "${DEFAULT_SC}" ]]; then
  log "Installing local-path-provisioner for PVC labs..."
  KUBECONFIG="${HOST_KUBECONFIG}" kubectl apply -f \
    "https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.30/deploy/local-path-storage.yaml"
  KUBECONFIG="${HOST_KUBECONFIG}" kubectl annotate storageclass local-path \
    storageclass.kubernetes.io/is-default-class=true --overwrite
  ok "StorageClass local-path installed and marked default."
else
  ok "Default StorageClass '${DEFAULT_SC}' already present — reusing it."
fi

echo
echo "Next: docker compose up --build"
