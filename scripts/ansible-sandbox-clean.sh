#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Remove Ansible lab sandboxes left behind by a crashed API or an interrupted
# test run.
#
# Cleanup is normally automatic — the reaper reclaims expired, idle, and
# orphaned sandboxes. This is the manual equivalent for the case where the
# process that owned them is gone entirely.
#
# It is deliberately narrow. It only ever removes objects that carry
# `jumptotech.io/managed=true` AND whose name matches the sandbox naming rule,
# which is the same pair of gates the provider applies before any delete. It
# cannot reach `bridge`, `host`, `kind`, or anything else on your machine.
# ---------------------------------------------------------------------------
set -euo pipefail

LABEL="jumptotech.io/managed=true"
SANDBOX_NAME='^lab-[a-z0-9]+-(net|control|node[1-9])$'
DRY_RUN="${DRY_RUN:-0}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed; nothing to clean" >&2
  exit 0
fi

removed=0

echo "scanning for JumpToTech Ansible sandboxes…"

while read -r name; do
  [ -n "$name" ] || continue
  if ! [[ "$name" =~ $SANDBOX_NAME ]]; then
    echo "  skipping container '$name' (not a sandbox name)"
    continue
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "  would remove container $name"
  else
    docker rm --force --volumes "$name" >/dev/null && echo "  removed container $name"
  fi
  removed=$((removed + 1))
done < <(docker ps --all --filter "label=${LABEL}" --format '{{.Names}}')

while read -r name; do
  [ -n "$name" ] || continue
  if ! [[ "$name" =~ $SANDBOX_NAME ]]; then
    echo "  skipping network '$name' (not a sandbox name)"
    continue
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "  would remove network $name"
  else
    docker network rm "$name" >/dev/null 2>&1 && echo "  removed network $name" || true
  fi
  removed=$((removed + 1))
done < <(docker network ls --filter "label=${LABEL}" --format '{{.Name}}')

if [ "$removed" -eq 0 ]; then
  echo "nothing to clean"
else
  echo "done — ${removed} object(s)"
fi
