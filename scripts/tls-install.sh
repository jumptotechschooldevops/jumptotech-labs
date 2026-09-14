#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Install a certificate on the production TLS edge, reload nginx, and prove
# nginx is serving it — BETA-P0-017.
#
#   scripts/tls-install.sh --cert /path/to/fullchain.pem --key /path/to/privkey.pem
#   make tls-install CERT=/path/to/fullchain.pem KEY=/path/to/privkey.pem
#
# The same command does initial provisioning, renewal and rotation. It is meant
# to be an ACME client's deploy hook, and just as usable by hand with a
# certificate from any CA. docs/runbooks/production-tls.md.
#
# Steps, in order. Nothing live changes until the new pair has passed:
#
#   1. stage  copy both files into infrastructure/docker/nginx/tls/ as *.next
#             (the key 600)
#   2. check  run the web image's certificate gate on the staged pair
#             (jtt-tls-preflight check): the same rules nginx's startup
#             enforces. A refusal leaves the live pair untouched
#   3. swap   keep the live pair as *.previous, rename *.next into place
#   4. reload `nginx -t`, then `nginx -s reload`. Graceful: open terminal
#             WebSockets stay on the old workers until they close
#   5. prove  jtt-tls-preflight served: the certificate on :8443 is the new one
#
# If 4 or 5 fails, the previous pair is restored and nginx reloaded again, and
# the script exits non-zero. When the web container is not running (first
# provisioning), step 2 runs in a one-off container, and 4 and 5 are left to
# `docker compose up`, whose startup gate enforces the same rules.
#
# Output names files, the host, the expiry date and the SHA-256 fingerprint.
# It never prints, logs or copies the private key anywhere but the tls directory.
#
# Environment:
#   WEB_CONTAINER   drive this container with `docker exec` instead of the
#                   production compose stack (tests, or a non-compose host)
#   TLS_DIR         the host directory mounted at /etc/nginx/tls
#                   (default: infrastructure/docker/nginx/tls)
#   COMPOSE_FILES   space-separated compose files (default: the production stack)
# ---------------------------------------------------------------------------
set -euo pipefail

usage() {
  sed -n '6,8p' "$0" | sed 's/^# \{0,1\}//'
}

cert=
key=
while [ $# -gt 0 ]; do
  case "$1" in
    --cert) cert=${2:-}; shift 2 ;;
    --key) key=${2:-}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "tls-install: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done
if [ -z "$cert" ] || [ -z "$key" ]; then
  usage >&2
  exit 2
fi

repo_root=$(cd "$(dirname "$0")/.." && pwd)
tls_dir=${TLS_DIR:-$repo_root/infrastructure/docker/nginx/tls}
in_container=/etc/nginx/tls

fail() {
  echo "tls-install: $*" >&2
  exit 1
}

for file in "$cert" "$key"; do
  [ -f "$file" ] && [ -r "$file" ] || fail "$file is not a readable file."
done
[ -d "$tls_dir" ] || fail "$tls_dir does not exist."
case "$(cd "$(dirname "$cert")" && pwd)/$(basename "$cert") $(cd "$(dirname "$key")" && pwd)/$(basename "$key")" in
  *"$tls_dir/fullchain.pem"*|*"$tls_dir/privkey.pem"*)
    fail "install from a copy outside $tls_dir, not from the live files themselves." ;;
esac

# Every container command reads /dev/null: an ACME client's deploy hook, or a
# shell script calling this one, must not have its own stdin consumed.
if [ -n "${WEB_CONTAINER:-}" ]; then
  web_exec() { docker exec "$WEB_CONTAINER" "$@" </dev/null; }
  web_running() { [ "$(docker inspect -f '{{.State.Running}}' "$WEB_CONTAINER" 2>/dev/null </dev/null)" = "true" ]; }
  web_oneoff() { fail "$WEB_CONTAINER is not running."; }
else
  read -r -a files <<< "${COMPOSE_FILES:-docker-compose.yml docker-compose.runtime.yml docker-compose.production.yml}"
  compose=(docker compose --project-directory "$repo_root")
  for file in "${files[@]}"; do compose+=(-f "$repo_root/$file"); done
  web_exec() { "${compose[@]}" exec -T web "$@" </dev/null; }
  web_running() { [ -n "$("${compose[@]}" ps --status running -q web 2>/dev/null </dev/null)" ]; }
  web_oneoff() { "${compose[@]}" run --rm --no-deps -T --entrypoint "$1" web "${@:2}" </dev/null; }
fi

staged_cert=$tls_dir/fullchain.pem.next
staged_key=$tls_dir/privkey.pem.next
cleanup() { rm -f "$staged_cert" "$staged_key"; }
trap cleanup EXIT

echo "==> staging the new certificate and key in $tls_dir"
umask 077
cp "$cert" "$staged_cert"
chmod 644 "$staged_cert"
cp "$key" "$staged_key"
chmod 600 "$staged_key"

running=false
if web_running; then running=true; fi

echo "==> checking the staged pair with the web image's certificate gate"
check=(jtt-tls-preflight check --cert "$in_container/fullchain.pem.next" --key "$in_container/privkey.pem.next")
if $running; then
  web_exec "${check[@]}" || fail "the new certificate was refused; nothing was changed."
else
  web_oneoff "${check[@]}" || fail "the new certificate was refused; nothing was changed."
fi

had_previous=false
if [ -e "$tls_dir/fullchain.pem" ] && [ -e "$tls_dir/privkey.pem" ]; then
  echo "==> keeping the current pair as *.previous"
  cp -p "$tls_dir/fullchain.pem" "$tls_dir/fullchain.pem.previous"
  cp -p "$tls_dir/privkey.pem" "$tls_dir/privkey.pem.previous"
  had_previous=true
fi
mv -f "$staged_cert" "$tls_dir/fullchain.pem"
mv -f "$staged_key" "$tls_dir/privkey.pem"

if ! $running; then
  echo "==> installed. The web container is not running; \`docker compose ... up -d\` starts it, and its startup gate checks this pair again."
  exit 0
fi

reload_and_prove() {
  web_exec nginx -t -q || return 1
  web_exec nginx -s reload || return 1
  # The master re-reads the files, then starts new workers; give it a moment.
  for _ in $(seq 1 20); do
    if web_exec jtt-tls-preflight served 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  web_exec jtt-tls-preflight served
}

echo "==> reloading nginx"
if reload_and_prove; then
  echo "==> nginx is serving the new certificate"
  exit 0
fi

echo "tls-install: nginx did not start serving the new certificate; restoring the previous pair" >&2
if $had_previous; then
  cp -p "$tls_dir/fullchain.pem.previous" "$tls_dir/fullchain.pem"
  cp -p "$tls_dir/privkey.pem.previous" "$tls_dir/privkey.pem"
  web_exec nginx -s reload || true
  sleep 1
  if web_exec jtt-tls-preflight served; then
    echo "tls-install: the previous certificate is being served again" >&2
  else
    echo "tls-install: the previous certificate is NOT being served either: follow docs/runbooks/production-tls.md §7" >&2
  fi
fi
exit 1
