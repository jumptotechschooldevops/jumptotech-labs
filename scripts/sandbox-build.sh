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

# Every tag, or none of them.
#
# This script builds all three images, and the Terraform one is built FROM the
# Linux one. Setting only `LINUX_SANDBOX_IMAGE` — the natural thing to do when
# testing a Linux change — therefore built a private Linux tag and then quietly
# overwrote the shared `jumptotech/lab-terraform:latest` that every other
# worktree runs from. Refusing the half-configured case is the whole point:
# a shared tag must never be rewritten by accident.
#
# Counted rather than compared pairwise so that adding a fourth image cannot
# reintroduce the gap by being left out of the condition.
__set_count=0
for __var in "${LINUX_SANDBOX_IMAGE:-}" "${TERRAFORM_SANDBOX_IMAGE:-}" "${ANSIBLE_SANDBOX_IMAGE:-}"; do
  [[ -n "${__var}" ]] && __set_count=$((__set_count + 1))
done
if [[ "${__set_count}" -ne 0 ]] && [[ "${__set_count}" -ne 3 ]]; then
  echo "Refusing to build: only some sandbox image variables are set." >&2
  echo >&2
  echo "  LINUX_SANDBOX_IMAGE     = ${LINUX_SANDBOX_IMAGE:-<unset>}" >&2
  echo "  TERRAFORM_SANDBOX_IMAGE = ${TERRAFORM_SANDBOX_IMAGE:-<unset>}" >&2
  echo "  ANSIBLE_SANDBOX_IMAGE   = ${ANSIBLE_SANDBOX_IMAGE:-<unset>}" >&2
  echo >&2
  echo "This script builds all three, so an unset one would be written to its" >&2
  echo "shared ':latest' tag — the tag every other worktree runs from. Set all:" >&2
  echo >&2
  echo "  LINUX_SANDBOX_IMAGE=jumptotech/lab-linux:<suffix> \\" >&2
  echo "  TERRAFORM_SANDBOX_IMAGE=jumptotech/lab-terraform:<suffix> \\" >&2
  echo "  ANSIBLE_SANDBOX_IMAGE=jumptotech/lab-ansible:<suffix> \\" >&2
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

echo
echo "Sandbox images ready:"
for image in "${LINUX_IMAGE}" "${TERRAFORM_IMAGE}" "${ANSIBLE_IMAGE}"; do
  docker image ls --format '  {{.Repository}}:{{.Tag}}  {{.Size}}' "${image}"
done
echo
echo "Restart the API (or reload the catalog) to pick up the new availability."
