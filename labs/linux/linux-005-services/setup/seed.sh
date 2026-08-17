#!/bin/bash
# ---------------------------------------------------------------------------
# LINUX-005 baseline — two runit services: one defined but not enabled, one
# enabled and running that should not be.
#
# runit is the container's real process supervisor (see the training image's
# Dockerfile for why this track does not fake systemd). A service is a
# directory under /etc/sv holding an executable `run` script; it is enabled by
# symlinking that directory into /etc/service, where `runsvdir` picks it up.
# ---------------------------------------------------------------------------
set -euo pipefail

install -d -o root -g root -m 0755 /var/log/jumptotech

cat > /usr/local/bin/ledger-api <<'SH'
#!/bin/bash
# The ledger API. Supervised: if it dies, runit restarts it.
while true; do
  echo "$(date -Is) ledger-api: serving" >> /var/log/jumptotech/ledger-api.log
  sleep 5
done
SH

cat > /usr/local/bin/debug-tracer <<'SH'
#!/bin/bash
# Left enabled after an incident. Writes a trace line every second, forever.
while true; do
  echo "$(date -Is) debug-tracer: trace" >> /var/log/jumptotech/debug-tracer.log
  sleep 1
done
SH

chmod 0755 /usr/local/bin/ledger-api /usr/local/bin/debug-tracer

# --- service definitions ----------------------------------------------------
install -d -m 0755 /etc/sv/ledger-api
cat > /etc/sv/ledger-api/run <<'SH'
#!/bin/sh
exec 2>&1
exec /usr/local/bin/ledger-api
SH
chmod 0755 /etc/sv/ledger-api/run

install -d -m 0755 /etc/sv/debug-tracer
cat > /etc/sv/debug-tracer/run <<'SH'
#!/bin/sh
exec 2>&1
exec /usr/local/bin/debug-tracer
SH
chmod 0755 /etc/sv/debug-tracer/run

# ledger-api is defined but NOT enabled — no symlink into /etc/service.
# debug-tracer is enabled, so runsvdir starts it within a few seconds.
ln -sfn /etc/sv/debug-tracer /etc/service/debug-tracer

# Wait for the supervisor to notice the new service before setup verification
# looks for it. runsvdir rescans /etc/service every five seconds.
for _ in $(seq 1 20); do
  if pgrep -f /usr/local/bin/debug-tracer >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
