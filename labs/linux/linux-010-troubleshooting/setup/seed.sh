#!/bin/bash
# ---------------------------------------------------------------------------
# LINUX-010 baseline — three independent faults, and the evidence needed to
# find each of them.
#
#   1. /etc/sv/ledger-api/run has no execute bit, so the supervisor cannot
#      start the service at all.
#   2. /etc/jumptotech/ledger-api.conf points the service at the wrong port.
#   3. an unsupervised legacy-exporter process is squatting on the port the
#      service is supposed to use, so fixing 1 and 2 alone still fails.
#
# The chain matters: each fix reveals the next symptom, which is what a real
# incident feels like. Evidence for all three is in the logs and the runbook.
#
# This script is deleted by the broker the moment it finishes, so the student
# cannot read the fault list from inside their own container.
# ---------------------------------------------------------------------------
set -euo pipefail

install -d -o root -g root -m 0755 /var/log/jumptotech
install -d -o root -g root -m 0755 /etc/jumptotech
install -d -o root -g root -m 0755 /srv/jumptotech
install -d -o root -g root -m 0755 /srv/jumptotech/runbooks

# --- the HTTP responder both services use -----------------------------------
cat > /usr/local/bin/jtt-edge-banner <<'SH'
#!/bin/bash
body='JTT-LEDGER-OK'
printf 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s\n' \
  "$(( ${#body} + 1 ))" "$body"
SH
chmod 0755 /usr/local/bin/jtt-edge-banner

# --- the service under investigation ----------------------------------------
cat > /usr/local/bin/ledger-api <<'SH'
#!/bin/bash
# The ledger API. Reads its listening port from the packaged configuration.
#
# The listener runs as a child rather than replacing this process, so the
# service stays identifiable by its own name in the process table — `ps` and
# `pgrep` show `ledger-api`, not an anonymous socat. The trap forwards the
# supervisor's stop signal to the child, so `sv stop` still works cleanly.
set -u
PORT=9105
conf=/etc/jumptotech/ledger-api.conf
if [ -r "$conf" ]; then
  # shellcheck disable=SC1090
  . "$conf"
fi
echo "$(date -Is) ledger-api: starting on port ${PORT}" >> /var/log/jumptotech/ledger-api.log
# `-T 60`, not 10: socat's -T is a total *inactivity* timeout on the whole
# circuit, and the SYSTEM: handler is a shell script, so that budget is
# really being spent on fork + exec + first schedule. At 10s a loaded host
# spends it, socat tears the connection down, and a client talking to a
# perfectly healthy service records `000`. 60s cannot be reached by
# scheduling delay and still reaps a peer that connects and goes silent.
socat -T 60 "TCP-LISTEN:${PORT},reuseaddr,fork" SYSTEM:/usr/local/bin/jtt-edge-banner &
child=$!
trap 'kill "$child" 2>/dev/null' TERM INT
wait "$child"
SH
chmod 0755 /usr/local/bin/ledger-api

install -d -m 0755 /etc/sv/ledger-api
cat > /etc/sv/ledger-api/run <<'SH'
#!/bin/sh
exec 2>&1
exec /usr/local/bin/ledger-api
SH

# FAULT 1 — the run script is not executable.
chmod 0644 /etc/sv/ledger-api/run
ln -sfn /etc/sv/ledger-api /etc/service/ledger-api

# FAULT 2 — the packaged configuration names the wrong port.
cat > /etc/jumptotech/ledger-api.conf <<'CONF'
# JumpToTech Bank — ledger API configuration
# Managed by the platform team. Changed during the 2026-08-12 migration.
PORT=9999
LOG_LEVEL=info
CONF
chmod 0644 /etc/jumptotech/ledger-api.conf

# FAULT 3 — a legacy exporter holding the port the service needs.
cat > /usr/local/bin/legacy-exporter <<'SH'
#!/bin/bash
# Decommissioned in the 2026-08-12 migration. Still running on this host, and
# still holding the port the ledger API needs.
socat -T 60 TCP-LISTEN:9105,reuseaddr,fork SYSTEM:/usr/local/bin/jtt-edge-banner &
child=$!
trap 'kill "$child" 2>/dev/null' TERM INT
wait "$child"
SH
chmod 0755 /usr/local/bin/legacy-exporter
setsid nohup /usr/local/bin/legacy-exporter >/dev/null 2>&1 &
disown || true

# --- the evidence -----------------------------------------------------------
cat > /var/log/jumptotech/ledger-api.log <<'LOG'
2026-08-12T09:02:11+00:00 platform: migration window opened
2026-08-12T09:04:47+00:00 ledger-api: starting on port 9105
2026-08-12T09:41:02+00:00 platform: packaged configuration replaced by migration tooling
2026-08-12T09:41:05+00:00 runsv ledger-api: unable to start ./run: permission denied
2026-08-12T09:41:35+00:00 runsv ledger-api: unable to start ./run: permission denied
2026-08-12T10:15:00+00:00 monitoring: 0 successful probes against ledger-api on 9105 in the last hour
2026-08-12T10:15:00+00:00 monitoring: something is accepting connections on 9105 but is not the ledger API
LOG
chmod 0644 /var/log/jumptotech/ledger-api.log

cat > /srv/jumptotech/runbooks/ledger-api.md <<'MD'
# Runbook — ledger-api

## Service contract

The ledger API is a supervised runit service. When healthy:

  * the service directory is enabled at /etc/service/ledger-api
  * /usr/local/bin/ledger-api is running under its supervisor
  * it accepts HTTP on TCP port 9105 and answers with JTT-LEDGER-OK
  * nothing else on the host listens on 9105

## Configuration

/etc/jumptotech/ledger-api.conf sets PORT. The assigned port for this host has
been 9105 since the service was introduced and did not change in the 2026-08-12
migration, whatever the migration tooling wrote into the file.

## Decommissioned components

legacy-exporter was retired in the 2026-08-12 migration. It is not supervised,
it is not restarted if it stops, and it must not be running on this host.

## Checking

  sudo sv status ledger-api
  ss -ltn
  curl -s http://127.0.0.1:9105
MD
chmod 0644 /srv/jumptotech/runbooks/ledger-api.md

install -d -o student -g student -m 0755 /home/student/ops

# Let the supervisor try (and fail) to start the service at least once, so the
# broken state is genuinely observable when the student arrives.
sleep 6
