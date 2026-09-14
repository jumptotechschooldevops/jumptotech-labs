#!/usr/bin/env bash
#
# Generate the local stack's secrets into .env — BETA-P0-010.
#
#   make secrets            (also run by `make setup`)
#   bash scripts/ensure-dev-secrets.sh [path/to/.env]
#
# Every secret is generated separately, from `openssl rand`, and written only to
# the env file. No value is printed: the output names each variable it
# generated and nothing else.
#
# A variable is (re)generated when it is missing, empty, or still carries a
# placeholder from .env.example (`dev-only-…`, `…change-me`). Anything else is
# the operator's and is left alone — with one deliberate exception below.
#
# The rules this script exists to guarantee:
#
#   · it never leaves a placeholder in place silently. Every service refuses
#     placeholders under NODE_ENV=production, and this script either replaces
#     one or says loudly that it kept it;
#   · it never writes a value it did not check. An `openssl` that is missing or
#     prints the wrong length stops the script rather than writing `NAME=`;
#   · no two secrets share a value. Equal values collapse the boundaries between
#     them, so a duplicate is refused here as it is at service startup.
set -euo pipefail

ENV_FILE="${1:-.env}"
EXAMPLE_FILE="${ENV_EXAMPLE_FILE:-.env.example}"

# name:bytes. `-hex 16` is 32 characters, the production minimum.
SECRETS=(
  TERMINAL_SESSION_SECRET:32
  INTERNAL_SERVICE_SECRET:32
  NAMESPACE_DERIVATION_SECRET:32
  SANDBOXD_ATTACH_SECRET:24
  SANDBOXD_RUNTIME_SECRET:24
  SANDBOXD_DOCKER_SECRET:24
  POSTGRES_PASSWORD:16
  OBSERVABILITY_SCRAPE_TOKEN:32
  GRAFANA_ADMIN_PASSWORD:32
)

# Must stay in step with PLACEHOLDER_MARKERS in
# services/observability/src/secret-policy.ts (a test pins it).
PLACEHOLDER_PATTERN='change-me|changeme|change_me|dev-only|dev_only|insecure|placeholder|example|replace-me|replaceme|your-|not-a-secret|default'

if ! command -v openssl >/dev/null 2>&1; then
  echo "error: openssl is required to generate secrets; nothing was written" >&2
  exit 1
fi

created=0
if [ ! -f "$ENV_FILE" ]; then
  cp "$EXAMPLE_FILE" "$ENV_FILE"
  created=1
  echo "created $ENV_FILE from $EXAMPLE_FILE"
fi
chmod 600 "$ENV_FILE"

current_value() {
  # The last assignment wins, as it does for `docker compose` and `set -a; .`.
  grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

set_value() {
  local name="$1" value="$2" tmp
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  chmod 600 "$tmp"
  # The value travels through the environment, not argv, so it never appears
  # in a process listing.
  NEW_VALUE="$value" awk -v name="$name" '
    BEGIN { done = 0 }
    index($0, name "=") == 1 { if (!done) { print name "=" ENVIRON["NEW_VALUE"]; done = 1 } next }
    { print }
    END { if (!done) print name "=" ENVIRON["NEW_VALUE"] }
  ' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
}

for entry in "${SECRETS[@]}"; do
  name="${entry%%:*}"
  bytes="${entry##*:}"
  value="$(current_value "$name")"

  if [ -n "$value" ]; then
    if ! printf '%s' "$value" | grep -qiE "$PLACEHOLDER_PATTERN"; then
      continue
    fi
    # An existing database volume was initialised with whatever password .env
    # held at the time. Rotating it here would lock the api out of its own
    # data with no message, so on an .env this run did not create, a
    # placeholder database password is kept — and said so.
    if [ "$name" = "POSTGRES_PASSWORD" ] && [ "$created" -eq 0 ]; then
      echo "warning: POSTGRES_PASSWORD in $ENV_FILE is a development placeholder." >&2
      echo "         Kept, because an existing database volume may have been created with it." >&2
      echo "         Every service refuses it under NODE_ENV=production. To rotate it locally:" >&2
      echo "         delete the POSTGRES_PASSWORD line, run \`make secrets\`, then \`make clean\`." >&2
      continue
    fi
  fi

  generated="$(openssl rand -hex "$bytes")"
  if ! printf '%s' "$generated" | grep -qE "^[0-9a-f]{$((bytes * 2))}\$"; then
    echo "error: openssl did not produce a ${bytes}-byte secret for $name; $ENV_FILE was not changed for it" >&2
    exit 1
  fi
  set_value "$name" "$generated"
  echo "generated $name"
done

# Distinctness, checked over the final file.
duplicates="$(
  for entry in "${SECRETS[@]}"; do
    name="${entry%%:*}"
    value="$(current_value "$name")"
    [ -n "$value" ] && printf '%s %s\n' "$(printf '%s' "$value" | openssl dgst -sha256 -r | cut -d' ' -f1)" "$name"
  done | sort | awk '{ if ($1 == last) print prev " and " $2; last = $1; prev = $2 }'
)"
if [ -n "$duplicates" ]; then
  echo "error: these secrets in $ENV_FILE share a value: $duplicates" >&2
  echo "       Delete one of each pair and run \`make secrets\` again." >&2
  exit 1
fi
