#!/usr/bin/env bash
#
# Remove this runtime owner's sandbox containers and lab networks — and only
# those.
#
# This used to remove every container labelled jumptotech.io/managed=true on
# the daemon, which on a shared laptop is every worktree's running labs at once:
# exactly the prefix-style sweep docs/runtime-ownership.md says the platform
# never does. It now filters on the owner as well, and refuses to guess one.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

err() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }

# The environment wins; otherwise read the one line from .env. Deliberately not
# `source .env`: nothing else in that file needs to reach this shell.
OWNER="${RUNTIME_OWNER_ID:-}"
if [[ -z "${OWNER}" && -f "${REPO_ROOT}/.env" ]]; then
  OWNER="$(grep -E '^RUNTIME_OWNER_ID=' "${REPO_ROOT}/.env" | tail -n 1 | cut -d= -f2-)"
fi

if [[ -z "${OWNER}" ]]; then
  err "RUNTIME_OWNER_ID is not set (in the environment or .env)."
  err "Refusing to guess whose sandboxes to delete. Run: RUNTIME_OWNER_ID=<owner> npm run sandbox:clean"
  exit 1
fi
if [[ ! "${OWNER}" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$ ]]; then
  err "RUNTIME_OWNER_ID is not a valid runtime owner (${#OWNER} characters)."
  exit 1
fi

FILTERS=(--filter "label=jumptotech.io/managed=true" --filter "label=jumptotech.io/runtime-owner=${OWNER}")

containers="$(docker ps -aq "${FILTERS[@]}")"
container_count=0
if [[ -n "${containers}" ]]; then
  container_count="$(printf '%s\n' "${containers}" | wc -l | tr -d ' ')"
  # shellcheck disable=SC2086 # one id per word, by construction
  docker rm -f ${containers} >/dev/null
fi

networks="$(docker network ls -q "${FILTERS[@]}")"
network_count=0
if [[ -n "${networks}" ]]; then
  network_count="$(printf '%s\n' "${networks}" | wc -l | tr -d ' ')"
  # shellcheck disable=SC2086
  docker network rm ${networks} >/dev/null
fi

ok "Removed ${container_count} container(s) and ${network_count} network(s) owned by '${OWNER}'."
