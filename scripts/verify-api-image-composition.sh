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

CONTAINER="${JTT_API_CONTAINER:-jumptotech-api}"
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
