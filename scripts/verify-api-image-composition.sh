#!/usr/bin/env bash
#
# Verify the running API container includes the current composition wiring.
#
# Catches the failure mode where source and unit tests pass but Docker Compose
# is still serving a stale image built before a composition change.
#
# Usage:
#   npm run verify:api-image          # after docker compose up --build
#   ./scripts/verify-api-image-composition.sh
#
set -euo pipefail

# Compose names containers `<project>-<service>-<index>`, and no service sets a
# `container_name`, so the running API container is `jumptotech-labs-api-1` on a
# default `make up`. Ask compose rather than hardcoding it, so a stack started
# with a custom COMPOSE_PROJECT_NAME still resolves.
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.runtime.yml)
CONTAINER="${JTT_API_CONTAINER:-}"
if [[ -z "$CONTAINER" ]]; then
  CONTAINER="$(docker compose "${COMPOSE_FILES[@]}" ps -q api 2>/dev/null | head -1 || true)"
fi
CONTAINER="${CONTAINER:-jumptotech-labs-api-1}"
MARKER='requirementsNeedDocker(input.requirements)'

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "error: container '$CONTAINER' is not running" >&2
  echo "hint: docker compose up --build -d" >&2
  exit 1
fi

if docker exec "$CONTAINER" grep -q "buildSandboxComposition" /app/apps/api/src/index.ts \
  && docker exec "$CONTAINER" grep -q "buildRequirementWaiter" /app/apps/api/src/composition.ts \
  && docker exec "$CONTAINER" grep -q "$MARKER" /app/apps/api/src/composition.ts; then
  echo "ok: API container includes current composition wiring"
  exit 0
fi

echo "error: API container is missing current composition wiring" >&2
echo "hint: rebuild with  docker compose up --build -d" >&2
exit 1
