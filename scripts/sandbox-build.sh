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

# Both tags, or neither.
#
# This script always builds both images, and the Terraform one is built FROM the
# Linux one. Setting only `LINUX_SANDBOX_IMAGE` — the natural thing to do when
# testing a Linux change — therefore built a private Linux tag and then quietly
# overwrote the shared `jumptotech/lab-terraform:latest` that every other
# worktree runs from. Refusing the half-configured case is the whole point:
# a shared tag must never be rewritten by accident.
if { [[ -n "${LINUX_SANDBOX_IMAGE:-}" ]] && [[ -z "${TERRAFORM_SANDBOX_IMAGE:-}" ]]; } ||
   { [[ -z "${LINUX_SANDBOX_IMAGE:-}" ]] && [[ -n "${TERRAFORM_SANDBOX_IMAGE:-}" ]]; }; then
  echo "Refusing to build: only one sandbox image variable is set." >&2
  echo >&2
  echo "  LINUX_SANDBOX_IMAGE     = ${LINUX_SANDBOX_IMAGE:-<unset>}" >&2
  echo "  TERRAFORM_SANDBOX_IMAGE = ${TERRAFORM_SANDBOX_IMAGE:-<unset>}" >&2
  echo >&2
  echo "This script builds both images, so the unset one would be written to its" >&2
  echo "shared ':latest' tag — the tag every other worktree runs from. Set both:" >&2
  echo >&2
  echo "  LINUX_SANDBOX_IMAGE=jumptotech/lab-linux:<suffix> \\" >&2
  echo "  TERRAFORM_SANDBOX_IMAGE=jumptotech/lab-terraform:<suffix> \\" >&2
  echo "  npm run sandbox:build" >&2
  echo >&2
  echo "Or set neither, to rebuild the canonical operator images." >&2
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

echo
echo "Sandbox images ready:"
for image in "${LINUX_IMAGE}" "${TERRAFORM_IMAGE}"; do
  docker image ls --format '  {{.Repository}}:{{.Tag}}  {{.Size}}' "${image}"
done
echo
echo "Restart the API (or reload the catalog) to pick up the new availability."
