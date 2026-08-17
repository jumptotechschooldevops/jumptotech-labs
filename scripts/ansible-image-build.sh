#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Build the Ansible sandbox node image used by the ANSIBLE-* labs.
#
# One image, both roles (control node and managed node). Run once; every
# student session then starts containers from it in about a second, which is
# what keeps the local cost model honest — no VM, no cluster, no database per
# student.
#
#   bash scripts/ansible-image-build.sh
# ---------------------------------------------------------------------------
set -euo pipefail

IMAGE="${ANSIBLE_LAB_IMAGE:-jumptotech/ansible-lab:local}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to build the Ansible sandbox image" >&2
  exit 1
fi

echo "building ${IMAGE} …"
docker build \
  -f "${ROOT}/infrastructure/docker/ansible-lab.Dockerfile" \
  -t "${IMAGE}" \
  "${ROOT}"

echo
docker run --rm --entrypoint /bin/sh "${IMAGE}" -c 'ansible --version | head -1; python3 --version; sshd -V 2>&1 | head -1' || true
echo
echo "done — ${IMAGE}"
