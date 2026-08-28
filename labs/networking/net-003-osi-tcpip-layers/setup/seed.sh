#!/bin/bash
# ---------------------------------------------------------------------------
# NET-003 baseline — four failures a student can reproduce for real.
#
# Everything here happens inside the session's own container. The sandbox runs
# with `--network none`, so nothing is published, nothing is reachable from
# another sandbox, and no external address is contacted. Three of the four
# failures this lab teaches are properties of that isolation rather than
# something injected:
#
#   · TCP to 9110  -> ECONNREFUSED, because nothing is bound there
#   · TCP to 10.99.99.99 -> ENETUNREACH, because there is no route anywhere
#   · a DNS name   -> EAI_AGAIN, because the resolver below cannot be reached
#
# The fourth is a real service that answers and then refuses at the application
# layer, which is the distinction the whole lab exists to teach.
# ---------------------------------------------------------------------------
set -euo pipefail

install -d -o root -g root -m 0755 /var/log/jumptotech

# Pin the resolver.
#
# Without this the container inherits whatever nameserver the host's Docker
# daemon writes, and the failure a student observes would depend on the machine
# the lab happens to run on — EAI_NONAME on one host, EAI_AGAIN on another.
# Pointing at an address that has no route makes the outcome the same
# everywhere: the resolver is unreachable, so resolution fails temporarily.
printf 'nameserver 10.99.99.99\noptions timeout:1 attempts:1\n' > /etc/resolv.conf

# The ledger API: a service that is genuinely up, and genuinely refuses.
#
# Every connection is recorded before the response is written, so the verifier
# can observe that the student actually contacted the service rather than
# transcribing a plausible-looking response into a file.
: > /var/log/jumptotech/ledger-access.log
chown root:root /var/log/jumptotech/ledger-access.log
chmod 0640 /var/log/jumptotech/ledger-access.log

cat > /usr/local/bin/jtt-ledger-response <<'SH'
#!/bin/bash
printf '%s ledger-api connection\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >> /var/log/jumptotech/ledger-access.log
body='ledger-api unavailable: JTT-LEDGER-503-7F2A'
printf 'HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s\n' \
  "$(( ${#body} + 1 ))" "$body"
SH
chmod 0755 /usr/local/bin/jtt-ledger-response

cat > /usr/local/bin/ledger-api <<'SH'
#!/bin/bash
# The bank's ledger API. Answers HTTP on TCP 9109, and has no healthy upstream.
# `-T 60`, not 10: socat's -T is a total *inactivity* timeout on the whole
# circuit, and the SYSTEM: handler is a shell script, so that budget is
# really being spent on fork + exec + first schedule. At 10s a loaded host
# spends it, socat tears the connection down, and a client talking to a
# perfectly healthy service records `000`. 60s cannot be reached by
# scheduling delay and still reaps a peer that connects and goes silent.
exec socat -T 60 TCP-LISTEN:9109,reuseaddr,fork SYSTEM:/usr/local/bin/jtt-ledger-response
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

# Wait for the supervisor to bind the socket, so setup verification observes a
# service that is genuinely listening rather than one that is still starting.
for _ in $(seq 1 25); do
  if ss -H -l -t -n 2>/dev/null | grep -q ':9109'; then
    break
  fi
  sleep 1
done
