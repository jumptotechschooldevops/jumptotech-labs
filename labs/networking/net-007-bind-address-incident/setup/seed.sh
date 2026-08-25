#!/bin/bash
# ---------------------------------------------------------------------------
# NET-007 baseline — a service that works perfectly, from exactly one machine.
#
# `ledger-api` is healthy, supervised, and answering. It is bound to 127.0.0.1,
# so `curl` on this host succeeds and every other machine on the segment gets
# connection refused. Both observations are correct, which is the whole reason
# the incident it models takes so long to resolve.
#
# The peer that proves it is a container the platform owns, on this session's
# own segment. The student has no shell in it and cannot alter what it reports.
# ---------------------------------------------------------------------------
set -euo pipefail

install -d -o root -g root -m 0755 /etc/ledger /home/student/incident/evidence
chown -R student:student /home/student/incident

cat > /etc/ledger/api.conf <<'CONF'
# ledger-api
#
# The address the API binds to. Set while the service was being tested on a
# single box, before anything else needed to reach it.
bind_address = 127.0.0.1
port = 8080
CONF
chmod 0644 /etc/ledger/api.conf

cat > /usr/local/bin/jtt-ledger-health <<'SH'
#!/bin/bash
body='ledger-api ok'
printf 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s\n' \
  "$(( ${#body} + 1 ))" "$body"
SH
chmod 0755 /usr/local/bin/jtt-ledger-health

# Binds whatever its configuration says, choosing the address family from the
# address itself so a student who moves it to either wildcard is honoured.
cat > /usr/local/bin/ledger-api <<'SH'
#!/bin/bash
conf=/etc/ledger/api.conf
bind=$(sed -n 's/^[[:space:]]*bind_address[[:space:]]*=[[:space:]]*//p' "$conf" | head -1)
port=$(sed -n 's/^[[:space:]]*port[[:space:]]*=[[:space:]]*//p' "$conf" | head -1)
bind=${bind:-127.0.0.1}
port=${port:-8080}
case "$bind" in
  *:*)
    stripped=${bind#[}; stripped=${stripped%]}
    exec socat -T 10 "TCP6-LISTEN:${port},bind=[${stripped}],reuseaddr,fork" \
      SYSTEM:/usr/local/bin/jtt-ledger-health
    ;;
  *)
    exec socat -T 10 "TCP4-LISTEN:${port},bind=${bind},reuseaddr,fork" \
      SYSTEM:/usr/local/bin/jtt-ledger-health
    ;;
esac
SH
chmod 0755 /usr/local/bin/ledger-api

install -d -m 0755 /etc/sv/ledger-api
cat > /etc/sv/ledger-api/run <<'SH'
#!/bin/sh
exec 2>&1
exec /usr/local/bin/ledger-api
SH
chmod 0755 /etc/sv/ledger-api/run
ln -sfn /etc/sv/ledger-api /etc/service/ledger-api

for _ in $(seq 1 30); do
  if ss -H -l -t -n 2>/dev/null | grep -q ':8080'; then break; fi
  sleep 1
done
