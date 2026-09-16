#!/usr/bin/env bash
#
# Build the sandbox images the container-backed tracks run on.
#
# Run once, on the host, alongside `npm run cluster:up`:
#
#   npm run sandbox:build
#
# The orchestrator never builds these. Building an image needs the Docker
# socket, and a web-facing process must not hold that capability — the same
# reason the kind cluster is created here rather than by the API.
#
# Until these exist, the Linux and Terraform providers report themselves
# unavailable and their labs are marked as such in the catalog. Nothing pretends
# to be runnable.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINUX_IMAGE="${LINUX_SANDBOX_IMAGE:-jumptotech/lab-linux:latest}"
TERRAFORM_IMAGE="${TERRAFORM_SANDBOX_IMAGE:-jumptotech/lab-terraform:latest}"
ANSIBLE_IMAGE="${ANSIBLE_SANDBOX_IMAGE:-jumptotech/lab-ansible:latest}"
CICD_IMAGE="${CICD_SANDBOX_IMAGE:-jumptotech/lab-cicd:latest}"
DOCKER_IMAGE="${DOCKER_SANDBOX_IMAGE:-jumptotech/lab-docker:latest}"

# Every tag, or none of them.
#
# This script builds all five images, and the Terraform one is built FROM the
# Linux one. Setting only `LINUX_SANDBOX_IMAGE` — the natural thing to do when
# testing a Linux change — therefore built a private Linux tag and then quietly
# overwrote the shared `jumptotech/lab-terraform:latest` that every other
# worktree runs from. Refusing the half-configured case is the whole point:
# a shared tag must never be rewritten by accident.
#
# Counted rather than compared pairwise so that adding a fifth image cannot
# reintroduce the gap by being left out of the condition.
__set_count=0
for __var in "${LINUX_SANDBOX_IMAGE:-}" "${TERRAFORM_SANDBOX_IMAGE:-}" "${ANSIBLE_SANDBOX_IMAGE:-}" "${CICD_SANDBOX_IMAGE:-}" "${DOCKER_SANDBOX_IMAGE:-}"; do
  [[ -n "${__var}" ]] && __set_count=$((__set_count + 1))
done
if [[ "${__set_count}" -ne 0 ]] && [[ "${__set_count}" -ne 5 ]]; then
  echo "Refusing to build: only some sandbox image variables are set." >&2
  echo >&2
  echo "  LINUX_SANDBOX_IMAGE     = ${LINUX_SANDBOX_IMAGE:-<unset>}" >&2
  echo "  TERRAFORM_SANDBOX_IMAGE = ${TERRAFORM_SANDBOX_IMAGE:-<unset>}" >&2
  echo "  ANSIBLE_SANDBOX_IMAGE   = ${ANSIBLE_SANDBOX_IMAGE:-<unset>}" >&2
  echo "  CICD_SANDBOX_IMAGE      = ${CICD_SANDBOX_IMAGE:-<unset>}" >&2
  echo "  DOCKER_SANDBOX_IMAGE    = ${DOCKER_SANDBOX_IMAGE:-<unset>}" >&2
  echo >&2
  echo "This script builds all five, so an unset one would be written to its" >&2
  echo "shared ':latest' tag — the tag every other worktree runs from. Set all:" >&2
  echo >&2
  echo "  LINUX_SANDBOX_IMAGE=jumptotech/lab-linux:<suffix> \\" >&2
  echo "  TERRAFORM_SANDBOX_IMAGE=jumptotech/lab-terraform:<suffix> \\" >&2
  echo "  ANSIBLE_SANDBOX_IMAGE=jumptotech/lab-ansible:<suffix> \\" >&2
  echo "  CICD_SANDBOX_IMAGE=jumptotech/lab-cicd:<suffix> \\" >&2
  echo "  DOCKER_SANDBOX_IMAGE=jumptotech/lab-docker:<suffix> \\" >&2
  echo "  npm run sandbox:build" >&2
  echo >&2
  echo "Or set none, to rebuild the canonical operator images." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found on PATH. Install Docker Desktop (or another runtime) first." >&2
  exit 1
fi

if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  echo "The Docker daemon is not responding. Start Docker and try again." >&2
  exit 1
fi

echo "==> Building ${LINUX_IMAGE}"
docker build \
  --file "${REPO_ROOT}/infrastructure/docker/sandbox-linux.Dockerfile" \
  --tag "${LINUX_IMAGE}" \
  "${REPO_ROOT}"

echo "==> Building ${TERRAFORM_IMAGE}"
docker build \
  --file "${REPO_ROOT}/infrastructure/docker/sandbox-terraform.Dockerfile" \
  --build-arg "SANDBOX_LINUX_IMAGE=${LINUX_IMAGE}" \
  --tag "${TERRAFORM_IMAGE}" \
  "${REPO_ROOT}"

echo "==> Building ${ANSIBLE_IMAGE}"
docker build \
  --file "${REPO_ROOT}/infrastructure/docker/sandbox-ansible.Dockerfile" \
  --tag "${ANSIBLE_IMAGE}" \
  "${REPO_ROOT}"

echo "==> Building ${CICD_IMAGE}"
docker build \
  --file "${REPO_ROOT}/infrastructure/docker/sandbox-cicd.Dockerfile" \
  --tag "${CICD_IMAGE}" \
  "${REPO_ROOT}"

# The Docker sandbox: `docker:dind` plus the networking diagnostics the
# Networking track's container labs are written against (capability N8). Built
# last because it shares nothing with the other four — it is not FROM the Linux
# sandbox, it is FROM the upstream dind image.
# N18 — baked images.
#
# Each image in baked-images.txt is `docker save`d into a private temporary
# directory and handed to the build as a *named* build context, so the
# archives never land in the repository tree and cannot be committed by
# accident. The fetch happens here, on the operator's machine at build time —
# which is the point: it moves every Docker lab's image fetch off the path of a
# student clicking Start. See docs/development/n18-design.md.
BAKED_LIST="${REPO_ROOT}/infrastructure/docker/baked-images.txt"
BAKED_DIR="$(mktemp -d "${TMPDIR:-/tmp}/jtt-baked-images.XXXXXX")"
trap 'rm -rf "${BAKED_DIR}"' EXIT

echo "==> Saving baked images for ${DOCKER_IMAGE}"
while read -r reference filename; do
  case "${reference}" in ''|'#'*) continue ;; esac
  # A filename that is not a bare basename could write outside BAKED_DIR. The
  # same rule is asserted over the TypeScript map at module load.
  if [[ ! "${filename}" =~ ^[a-z0-9][a-z0-9.-]*\.tar$ ]]; then
    echo "Refusing to build: '${filename}' is not a safe archive name." >&2
    exit 1
  fi
  if ! docker image inspect "${reference}" >/dev/null 2>&1; then
    echo "    pulling ${reference}"
    docker pull --quiet "${reference}" >/dev/null
  fi
  docker save --output "${BAKED_DIR}/${filename}" "${reference}"
  echo "    ${reference} -> ${filename}"
done < "${BAKED_LIST}"

echo "==> Building ${DOCKER_IMAGE}"
docker build \
  --file "${REPO_ROOT}/infrastructure/docker/sandbox-docker.Dockerfile" \
  --build-context "baked-images=${BAKED_DIR}" \
  --tag "${DOCKER_IMAGE}" \
  "${REPO_ROOT}"

echo
echo "Sandbox images ready:"
for image in "${LINUX_IMAGE}" "${TERRAFORM_IMAGE}" "${ANSIBLE_IMAGE}" "${CICD_IMAGE}" "${DOCKER_IMAGE}"; do
  docker image ls --format '  {{.Repository}}:{{.Tag}}  {{.Size}}' "${image}"
done
echo
echo "Restart the API (or reload the catalog) to pick up the new availability."
