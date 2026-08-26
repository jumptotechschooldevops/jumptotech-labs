#!/bin/bash
# ---------------------------------------------------------------------------
# NET-005 baseline — a settlement poller pointed at the wrong network.
#
# Everything is inside the session's own container, on its own private segment.
# Nothing is published and there is no route off the bridge.
#
# The fault is one line of application configuration: `settlement_endpoint`
# names an address on 10.80.4.0/24, which no route on this host covers. The
# poller therefore fails at the routing decision, before a frame is ever built.
#
# That ordering is what makes the lab gradeable. A destination with no route
# never reaches address resolution, so the baseline — and every restart of it,
# and every reset back to it — leaves the neighbour table empty. The fixture
# cannot produce the state the lab grades; only a student who repoints the
# poller at something on this segment can.
# ---------------------------------------------------------------------------
set -euo pipefail

install -d -o root -g root -m 0755 /var/log/jumptotech /etc/ledger

# The misconfiguration. 10.80.4.10 is a real address on a real network — just
# not one this host has any way to reach.
cat > /etc/ledger/settlement.conf <<'CONF'
# ledger-api — settlement poller
#
# The address of the settlement endpoint this service reconciles against.
# Written during the migration; nobody has looked at it since.
settlement_endpoint = 10.80.4.10:9200
poll_interval_seconds = 5
CONF
chmod 0644 /etc/ledger/settlement.conf

: > /var/log/jumptotech/settlement.log
chown root:root /var/log/jumptotech/settlement.log
chmod 0644 /var/log/jumptotech/settlement.log

# The poller.
#
# Re-reads its configuration every cycle, so a corrected endpoint takes effect
# on its own — the lab grades the resulting state, not whether a student
# happened to restart a service.
#
# It records two facts per cycle. `status` distinguishes a destination the
# routing table can deliver to from one it cannot. `neighbour` records whether
# reaching it required resolving a hardware address and succeeded, which is
# what separates a real host elsewhere on the segment from this host's own
# address — traffic to yourself is delivered locally and resolves nothing.
cat > /usr/local/bin/settlement-poll <<'SH'
#!/bin/bash
conf=/etc/ledger/settlement.conf
log=/var/log/jumptotech/settlement.log

while true; do
  endpoint=$(sed -n 's/^[[:space:]]*settlement_endpoint[[:space:]]*=[[:space:]]*//p' "$conf" | head -1)
  interval=$(sed -n 's/^[[:space:]]*poll_interval_seconds[[:space:]]*=[[:space:]]*//p' "$conf" | head -1)
  host=${endpoint%%:*}
  port=${endpoint##*:}

  if [ -z "$host" ] || [ -z "$port" ]; then
    printf '%s settlement_endpoint=%s status=unconfigured neighbour=none\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${endpoint:-<empty>}" >> "$log"
  else
    probe=$(nc -w 2 -v "$host" "$port" 2>&1 </dev/null || true)
    if printf '%s' "$probe" | grep -qi 'unreachable'; then
      status=unreachable
    else
      status=routable
    fi

    if ip neigh show "$host" 2>/dev/null | grep -q 'lladdr'; then
      neighbour=resolved
    else
      neighbour=none
    fi

    printf '%s settlement_endpoint=%s status=%s neighbour=%s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$endpoint" "$status" "$neighbour" >> "$log"
  fi

  sleep "${interval:-5}"
done
SH
chmod 0755 /usr/local/bin/settlement-poll

# The API itself: healthy throughout, so a student cannot mistake this for an
# application that has fallen over.
cat > /usr/local/bin/ledger-health <<'SH'
#!/bin/bash
printf 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 12\r\nConnection: close\r\n\r\nledger-api\n'
SH
chmod 0755 /usr/local/bin/ledger-health

install -d -m 0755 /etc/sv/ledger-api /etc/sv/settlement-poller
cat > /etc/sv/ledger-api/run <<'SH'
#!/bin/sh
exec 2>&1
exec socat -T 10 TCP-LISTEN:9120,reuseaddr,fork SYSTEM:/usr/local/bin/ledger-health
SH
cat > /etc/sv/settlement-poller/run <<'SH'
#!/bin/sh
exec 2>&1
exec /usr/local/bin/settlement-poll
SH
chmod 0755 /etc/sv/ledger-api/run /etc/sv/settlement-poller/run
ln -sfn /etc/sv/ledger-api /etc/service/ledger-api
ln -sfn /etc/sv/settlement-poller /etc/service/settlement-poller

# Wait for the health port, so setup verification observes a service that is up.
for _ in $(seq 1 25); do
  if ss -H -l -t -n 2>/dev/null | grep -q ':9120'; then
    break
  fi
  sleep 1
done
