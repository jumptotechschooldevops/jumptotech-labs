#!/bin/sh
# Run by the nginx image's /docker-entrypoint.sh before nginx starts (BETA-P0-017).
# The entrypoint runs under `set -e`, so a refusal here stops the container and
# nginx never listens. See /usr/local/bin/jtt-tls-preflight.
exec /usr/local/bin/jtt-tls-preflight startup
