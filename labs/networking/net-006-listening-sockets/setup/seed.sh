#!/bin/bash
# ---------------------------------------------------------------------------
# NET-006 baseline — four sockets, one of them bound where nobody can reach it.
#
# Everything is inside the session's own container on its own private segment.
# Nothing is published; there is no route off the bridge.
#
# The fault is one line of application configuration: payments-api is bound to
# 127.0.0.1, so it answers on the host itself and is invisible from the segment
# the host sits on. The other three sockets are healthy and exist to make the
# inventory a real inventory rather than a single obvious row.
# ---------------------------------------------------------------------------
set -euo pipefail

install -d -o root -g root -m 0755 /var/log/jumptotech /etc/payments

cat > /etc/payments/api.conf <<'CONF'
# payments-api
#
# The address the API binds to. Set during the migration, when the service ran
# behind a proxy on the same host and nothing else needed to reach it.
bind_address = 127.0.0.1
port = 9106
CONF
chmod 0644 /etc/payments/api.conf

# A tiny HTTP responder shared by the two TCP services.
cat > /usr/local/bin/jtt-api-response <<'SH'
#!/bin/bash
body="${JTT_SERVICE:-service} ok"
printf 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s\n' \
  "$(( ${#body} + 1 ))" "$body"
SH
chmod 0755 /usr/local/bin/jtt-api-response

# ledger-api — healthy, reachable from anywhere on the segment.
install -d -m 0755 /etc/sv/ledger-api
cat > /etc/sv/ledger-api/run <<'SH'
#!/bin/sh
exec 2>&1
export JTT_SERVICE=ledger-api
exec socat -T 10 TCP-LISTEN:9105,reuseaddr,fork SYSTEM:/usr/local/bin/jtt-api-response
SH

# payments-api — binds whatever its configuration says, which is the fault.
cat > /usr/local/bin/payments-api <<'SH'
#!/bin/bash
conf=/etc/payments/api.conf
bind=$(sed -n 's/^[[:space:]]*bind_address[[:space:]]*=[[:space:]]*//p' "$conf" | head -1)
port=$(sed -n 's/^[[:space:]]*port[[:space:]]*=[[:space:]]*//p' "$conf" | head -1)
bind=${bind:-127.0.0.1}
port=${port:-9106}
export JTT_SERVICE=payments-api

# Pick the address family from the address itself. socat's TCP-LISTEN is IPv4
# only, so an IPv6 bind address needs TCP6-LISTEN — and a student who binds the
# IPv6 wildcard has made the service just as reachable as one who binds the
# IPv4 wildcard. The service honours either rather than dying on one of them.
case "$bind" in
  *:*)
    stripped=${bind#[}
    stripped=${stripped%]}
    exec socat -T 10 "TCP6-LISTEN:${port},bind=[${stripped}],reuseaddr,fork" \
      SYSTEM:/usr/local/bin/jtt-api-response
    ;;
  *)
    exec socat -T 10 "TCP4-LISTEN:${port},bind=${bind},reuseaddr,fork" \
      SYSTEM:/usr/local/bin/jtt-api-response
    ;;
esac
SH
chmod 0755 /usr/local/bin/payments-api

install -d -m 0755 /etc/sv/payments-api
cat > /etc/sv/payments-api/run <<'SH'
#!/bin/sh
exec 2>&1
exec /usr/local/bin/payments-api
SH

# metrics — a UDP socket, so the inventory is not all one protocol.
install -d -m 0755 /etc/sv/metrics
cat > /etc/sv/metrics/run <<'SH'
#!/bin/sh
exec 2>&1
exec socat -T 30 UDP-RECVFROM:9107,fork /dev/null
SH

# A client holding one established connection to ledger-api, so the socket
# table contains a connection as well as a set of listeners.
cat > /usr/local/bin/ledger-client <<'SH'
#!/bin/bash
while true; do
  # Hold the connection open rather than reconnecting in a tight loop.
  socat -T 3600 - TCP:127.0.0.1:9105 >/dev/null 2>&1 || true
  sleep 5
done
SH
chmod 0755 /usr/local/bin/ledger-client

install -d -m 0755 /etc/sv/ledger-client
cat > /etc/sv/ledger-client/run <<'SH'
#!/bin/sh
exec 2>&1
exec /usr/local/bin/ledger-client
SH

chmod 0755 /etc/sv/ledger-api/run /etc/sv/payments-api/run /etc/sv/metrics/run /etc/sv/ledger-client/run
for service in ledger-api payments-api metrics ledger-client; do
  ln -sfn "/etc/sv/$service" "/etc/service/$service"
done

# Wait for the listeners, so setup verification observes services that are up.
for _ in $(seq 1 30); do
  if ss -H -l -t -n 2>/dev/null | grep -q ':9105' \
     && ss -H -l -t -n 2>/dev/null | grep -q ':9106' \
     && ss -H -l -u -n 2>/dev/null | grep -q ':9107'; then
    break
  fi
  sleep 1
done
