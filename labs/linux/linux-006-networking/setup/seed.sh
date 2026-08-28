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
# `-T 60`, not 10: socat's -T is a total *inactivity* timeout on the whole
# circuit, and the SYSTEM: handler is a shell script, so that budget is
# really being spent on fork + exec + first schedule. At 10s a loaded host
# spends it, socat tears the connection down, and a client talking to a
# perfectly healthy service records `000`. 60s cannot be reached by
# scheduling delay and still reaps a peer that connects and goes silent.
exec socat -T 60 TCP-LISTEN:9105,reuseaddr,fork SYSTEM:/usr/local/bin/jtt-edge-banner
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
