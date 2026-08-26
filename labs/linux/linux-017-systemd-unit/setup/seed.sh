#!/bin/bash
# ---------------------------------------------------------------------------
# LINUX-017 baseline — a service that runs under runit today and has to be
# expressed as a systemd unit for the fleet it is moving to.
#
# WHAT THE STUDENT IS GIVEN, AND WHAT THEY ARE NOT
#
# They get the operational contract in prose — the migration runbook — and the
# runit definition that satisfies it today. They do not get a unit file to copy.
# Turning "restart it if it crashes, but leave it down when we stop it" into
# `Restart=on-failure` is the skill; transcribing a finished unit is not.
#
# They also get a draft someone started and abandoned. It is deliberately
# unusable in three different ways, each of which a real person produces:
#
#   [Unit                   an unterminated section header — systemd refuses
#                           the whole file, and so does this platform's parser,
#                           which reports the line rather than pretending the
#                           directives are merely missing
#   ExecStart=ledger-api    a relative path, which systemd rejects
#   Restart=always          a policy that contradicts the runbook: it would
#                           bring the service back after a deliberate stop
#
# The draft is short on purpose. A near-complete draft would make this a
# spot-the-difference exercise; three lines of wrongness makes it a starting
# point they have to justify replacing.
#
# Content is written from the systemd project's own manual pages as published
# by Debian, and from the Linux man-pages project.
# ---------------------------------------------------------------------------
set -euo pipefail

install -d -o root -g root -m 0755 /etc/systemd/system
install -d -o root -g root -m 0755 /etc/jumptotech
install -d -o root -g root -m 0755 /srv/jumptotech/runbooks
install -d -o root -g root -m 0755 /var/log/jumptotech

# --- the service account the unit has to name -------------------------------
if ! getent group ledger >/dev/null; then
  groupadd --system --gid 2017 ledger
fi
if ! getent passwd ledger >/dev/null; then
  useradd --system --gid ledger --home-dir /srv/jumptotech \
          --shell /usr/sbin/nologin --uid 2017 ledger
fi

# --- the application --------------------------------------------------------
cat > /usr/local/bin/ledger-api <<'SH'
#!/bin/bash
# The bank's ledger API. Runs in the foreground and does not fork.
: "${JTT_ENV:=unset}"
while true; do
  echo "$(date -Is) ledger-api: serving (env=${JTT_ENV})" >> /var/log/jumptotech/ledger-api.log
  sleep 5
done
SH
chmod 0755 /usr/local/bin/ledger-api

cat > /etc/jumptotech/ledger-api.env <<'ENV'
# Settings for the ledger API. Read by the service at start-up.
JTT_ENV=production
JTT_LEDGER_PORT=9105
ENV
chmod 0644 /etc/jumptotech/ledger-api.env

# --- how it runs today, under runit -----------------------------------------
#
# Left in place and running. It is the reference for what the unit has to
# reproduce, and it is also the honest picture of a migration: the old thing
# keeps serving while you write the new one.
install -d -m 0755 /etc/sv/ledger-api
cat > /etc/sv/ledger-api/run <<'SH'
#!/bin/sh
exec 2>&1
# Settings live in a file rather than in this script, so operations can change
# them without editing the service definition.
set -a
. /etc/jumptotech/ledger-api.env
set +a
cd /srv/jumptotech
# Drops to the service account: the API has no business running as root.
exec chpst -u ledger /usr/local/bin/ledger-api
SH
chmod 0755 /etc/sv/ledger-api/run
ln -sfn /etc/sv/ledger-api /etc/service/ledger-api

# --- the migration runbook: the contract, in prose --------------------------
cat > /srv/jumptotech/runbooks/ledger-api-migration.md <<'MD'
# ledger-api — migration to the systemd fleet

The ledger API is moving off the runit hosts onto the systemd fleet in
November. Platform has asked for the unit file ahead of the window so it can
go through review with everything else.

What the service needs, agreed with operations and unchanged by the move:

* It is `/usr/local/bin/ledger-api`. It takes no arguments. Whatever starts it
  must give it an absolute path — the fleet's service manager will not search
  for it.
* It runs in the foreground and never forks or daemonises. It is ready as soon
  as it is running; there is no readiness protocol to wait on.
* It runs as the `ledger` user and the `ledger` group. It has never needed root
  and must not be given it.
* It works from `/srv/jumptotech`.
* Its settings live in `/etc/jumptotech/ledger-api.env` and are read at start.
  Operations change that file without touching the service definition, so the
  unit must read it rather than carrying the values itself.
* If it crashes, bring it back. If an operator stops it deliberately, leave it
  stopped — a service that fights the on-call engineer is worse than one that
  is down. Wait five seconds between attempts so a crash loop does not spin.
* It talks to the clearing house, so it must not start until the network is
  actually configured and up — not merely until the network stack has been
  brought online. Ask for that, and order after it.
* It must come up on its own after a normal boot, at the point in start-up
  where ordinary multi-user services run.
* The description should name the service, so `ledger-api` appears in a status
  listing rather than "JumpToTech application".

Reviewer's note from the last migration: the unit file itself is configuration
and belongs to root, world-readable — 0644. Two people have now shipped units
nobody but root could read, and the fleet's service manager silently ignored
them.
MD
chmod 0644 /srv/jumptotech/runbooks/ledger-api-migration.md

# --- the abandoned draft -----------------------------------------------------
cat > /etc/systemd/system/ledger-api.service <<'UNIT'
# Started during the planning meeting, never finished.
# Do not assume any of this is right.
[Unit
Description=JumpToTech application

[Service]
ExecStart=ledger-api
Restart=always
UNIT
chmod 0644 /etc/systemd/system/ledger-api.service

# Wait for the supervisor to pick up the runit service, so the student sees the
# thing they are migrating actually running.
for _ in $(seq 1 25); do
  if pgrep -f /usr/local/bin/ledger-api >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
