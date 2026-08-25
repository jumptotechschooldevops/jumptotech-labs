#!/bin/bash
# ---------------------------------------------------------------------------
# LINUX-006 baseline — an edge service listening on the host's own loopback.
#
# Everything in this lab happens inside the session's own container, which runs
# with no network attachment at all: `lo` is the only interface that is up or
# addressed, and there are no routes. Nothing is published to the host, nothing
# is reachable from another sandbox, and no external address is contacted.
# ---------------------------------------------------------------------------
set -euo pipefail

install -d -o root -g root -m 0755 /var/log/jumptotech

# A minimal HTTP responder, so `curl` against the port returns something real.
cat > /usr/local/bin/jtt-edge-banner <<'SH'
#!/bin/bash
body='JTT-EDGE-OK'
printf 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s\n' \
  "$(( ${#body} + 1 ))" "$body"
SH
chmod 0755 /usr/local/bin/jtt-edge-banner

cat > /usr/local/bin/edge-proxy <<'SH'
#!/bin/bash
# The bank's edge proxy. Answers HTTP on TCP 9105.
exec socat -T 10 TCP-LISTEN:9105,reuseaddr,fork SYSTEM:/usr/local/bin/jtt-edge-banner
SH
chmod 0755 /usr/local/bin/edge-proxy

install -d -m 0755 /etc/sv/edge-proxy
cat > /etc/sv/edge-proxy/run <<'SH'
#!/bin/sh
exec 2>&1
exec /usr/local/bin/edge-proxy
SH
chmod 0755 /etc/sv/edge-proxy/run
ln -sfn /etc/sv/edge-proxy /etc/service/edge-proxy

install -d -o student -g student -m 0755 /home/student/net

# Wait for the supervisor to start it and for the socket to be bound, so setup
# verification observes a service that is genuinely up.
for _ in $(seq 1 25); do
  if ss -H -l -t -n 2>/dev/null | grep -q ':9105'; then
    break
  fi
  sleep 1
done
