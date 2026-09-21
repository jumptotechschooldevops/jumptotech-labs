#!/usr/bin/env bash
#
# Refuse a development-only make target on a checkout that runs, or has run,
# the production stack.
#
#   scripts/refuse-on-production.sh TARGET WHAT-IT-DESTROYS
#   scripts/refuse-on-production.sh --recreates TARGET
#
# `--recreates` is for the targets that start or rebuild the stack from the
# development compose files (`make up`, `make rebuild`, `make up-kubernetes-only`,
# `make db-up`). They delete nothing, but on the production project they
# re-create each service without the production overlays: no pinned NODE_ENV or
# AUTH_MODE (the development default is AUTH_MODE=development), no restart
# policy, the edge off 443/80, PostgreSQL published on loopback. The site goes
# down and what comes back is the development configuration over the student
# database.
#
# `make clean` runs `docker compose down -v`, which deletes this project's
# PostgreSQL volume (every student's progress) and then the kind cluster;
# `make sandbox-clean` removes every sandbox of this runtime owner, running ones
# included, without ending their sessions. Both are ordinary on a laptop. On the
# production host they are in the incident runbook's "never do" table
# (private-beta-incident-response.md §1), and the project name they act on is
# the same `jumptotech-labs` the production stack uses — so nothing but that
# table stood between a habit and the student database.
#
# A checkout is treated as production when either is true:
#
#   · infrastructure/docker/nginx/tls/privkey.pem exists — only the production
#     edge's certificate is installed there (scripts/tls-install.sh); tests use
#     temporary directories. Survives `prod down`;
#   · a container of this compose project has restart policy `unless-stopped`,
#     which only the production overlays set (the development stack has none).
#
# Not `PUBLIC_ORIGIN`: .env.example ships an https tunnel URL there, so every
# development checkout has one.
#
# To proceed anyway — a host being decommissioned, after a backup — name the
# project: CONFIRM_DESTROY=<project> make TARGET. Nothing else is accepted.
#
# Exit: 0 not production, or confirmed · 1 refused · 2 usage.
set -euo pipefail

recreates=0
if [ "${1:-}" = --recreates ]; then
  recreates=1
  shift
  [ $# -eq 1 ] || { echo "usage: $0 --recreates TARGET" >&2; exit 2; }
  target=$1
  destroys=
else
  [ $# -eq 2 ] || { echo "usage: $0 TARGET WHAT-IT-DESTROYS" >&2; exit 2; }
  target=$1
  destroys=$2
fi

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=scripts/production-host-lib.sh
. "$repo/scripts/production-host-lib.sh"

# Compose's own precedence: the shell, then .env, then the file's default.
project=${COMPOSE_PROJECT_NAME:-$(jtt_env_value "$repo/.env" COMPOSE_PROJECT_NAME || true)}
project=${project:-jumptotech-labs}

reasons=()
if [ -e "$repo/infrastructure/docker/nginx/tls/privkey.pem" ]; then
  reasons+=('a production TLS key is installed in infrastructure/docker/nginx/tls/')
fi
if have docker; then
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=$project" 2>/dev/null || true)
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086 # one id per word
    policies=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' $ids 2>/dev/null || true)
    if jtt_contains "$policies" -x unless-stopped; then
      reasons+=("containers of compose project '$project' carry the production restart policy (unless-stopped)")
    fi
  fi
fi

[ ${#reasons[@]} -gt 0 ] || exit 0

if [ "${CONFIRM_DESTROY:-}" = "$project" ]; then
  echo "make $target: confirmed for production project '$project' (CONFIRM_DESTROY)." >&2
  exit 0
fi

if [ $recreates -eq 1 ]; then
  {
    echo "REFUSED: make $target on a production checkout."
    for reason in "${reasons[@]}"; do echo "  - $reason"; done
    echo "It would re-create compose project '$project' from the development files only:"
    echo "no production overlays (AUTH_MODE/NODE_ENV pins, restart policy, TLS edge on 443/80)."
    echo "Use the production command instead (docs/runbooks/private-beta-operations.md §1):"
    echo "  prod up -d --build --wait     # or: prod up -d <service>"
  } >&2
  exit 1
fi

{
  echo "REFUSED: make $target on a production checkout."
  for reason in "${reasons[@]}"; do echo "  - $reason"; done
  echo "It would destroy $destroys for compose project '$project'."
  echo "Use the production procedures instead: docs/runbooks/private-beta-operations.md"
  echo "(\`prod down\` keeps the database; \`ops end <id> --yes\` ends one lab)."
  echo "Only when this host is being decommissioned, after scripts/db-backup.sh:"
  echo "  CONFIRM_DESTROY=$project make $target"
} >&2
exit 1
