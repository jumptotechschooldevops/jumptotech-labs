#!/bin/bash
# ---------------------------------------------------------------------------
# NET-008 baseline — two services that answer, and one port that does not.
#
# Everything is inside the session's own container on its own private segment.
# Nothing is published and there is no route off the bridge.
#
# The three cases the lab observes are properties of this arrangement rather
# than injected faults: a TCP service completes a handshake, a UDP service
# takes a datagram and holds no state, and a port with nothing behind it is
# refused immediately rather than timing out.
#
# Each service records what actually reached it. That record is what separates
# a student who ran the exchange from one who typed a plausible capture into a
# file: a connection log only grows when a connection really completed.
# ---------------------------------------------------------------------------
set -euo pipefail

install -d -o root -g root -m 0755 /var/log/jumptotech
: > /var/log/jumptotech/tcp-echo.log
: > /var/log/jumptotech/udp-echo.log
chmod 0644 /var/log/jumptotech/tcp-echo.log /var/log/jumptotech/udp-echo.log

# The TCP echo service. Logs each accepted connection, then echoes.
cat > /usr/local/bin/jtt-tcp-echo <<'SH'
#!/bin/bash
printf '%s tcp connection accepted\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >> /var/log/jumptotech/tcp-echo.log
exec cat
SH
chmod 0755 /usr/local/bin/jtt-tcp-echo

# The UDP echo service. Logs each datagram. No connection, no state.
cat > /usr/local/bin/jtt-udp-echo <<'SH'
#!/bin/bash
printf '%s udp datagram received\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >> /var/log/jumptotech/udp-echo.log
exec cat
SH
chmod 0755 /usr/local/bin/jtt-udp-echo

install -d -m 0755 /etc/sv/ledger-echo /etc/sv/ledger-metrics
cat > /etc/sv/ledger-echo/run <<'SH'
#!/bin/sh
exec 2>&1
# `-T 60`, not 10: socat's -T is a total *inactivity* timeout on the whole
# circuit, and the SYSTEM: handler is a shell script, so that budget is
# really being spent on fork + exec + first schedule. At 10s a loaded host
# spends it, socat tears the connection down, and a client talking to a
# perfectly healthy service records `000`. 60s cannot be reached by
# scheduling delay and still reaps a peer that connects and goes silent.
exec socat -T 60 TCP4-LISTEN:9200,reuseaddr,fork SYSTEM:/usr/local/bin/jtt-tcp-echo
SH
cat > /etc/sv/ledger-metrics/run <<'SH'
#!/bin/sh
exec 2>&1
exec socat -T 60 UDP4-RECVFROM:9201,fork SYSTEM:/usr/local/bin/jtt-udp-echo
SH
chmod 0755 /etc/sv/ledger-echo/run /etc/sv/ledger-metrics/run
ln -sfn /etc/sv/ledger-echo /etc/service/ledger-echo
ln -sfn /etc/sv/ledger-metrics /etc/service/ledger-metrics

# 9202 is deliberately left empty: a port with nothing behind it is the third
# case, and it must stay that way for the lab to have anything to show.

for _ in $(seq 1 30); do
  if ss -H -l -t -n 2>/dev/null | grep -q ':9200' \
     && ss -H -l -u -n 2>/dev/null | grep -q ':9201'; then
    break
  fi
  sleep 1
done
