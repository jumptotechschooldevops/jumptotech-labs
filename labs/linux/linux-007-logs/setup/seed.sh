#!/bin/bash
# ---------------------------------------------------------------------------
# LINUX-007 baseline — a payments log with a known number of errors, and an
# archived log holding the detail of the one that matters.
#
# The counts here are exact and deliberate: the current log contains precisely
# 17 lines carrying the word ERROR, and the rejected transaction id appears in
# exactly one archived file. Anything else in these logs is realistic noise.
# ---------------------------------------------------------------------------
set -euo pipefail

install -d -o root -g root -m 0755 /var/log/jumptotech
install -d -o root -g root -m 0755 /var/log/jumptotech/archive
install -d -o student -g student -m 0755 /home/student/analysis

log=/var/log/jumptotech/payments.log
: > "$log"

error_messages=(
  'ERROR settlement gateway returned 502 for batch B-0091'
  'ERROR settlement gateway returned 502 for batch B-0092'
  'ERROR clearing house handshake timed out after 30s'
  'ERROR could not acquire ledger lock, retrying'
  'ERROR settlement rejected — transaction detail is in the archived log'
)

# 17 error lines exactly, interleaved with ordinary traffic.
for i in $(seq 1 17); do
  printf '2026-08-14T0%d:%02d:11+00:00 payments INFO processed batch B-%04d\n' \
    "$(( i % 10 ))" "$(( (i * 7) % 60 ))" "$(( 100 + i ))" >> "$log"
  printf '2026-08-14T0%d:%02d:14+00:00 payments %s\n' \
    "$(( i % 10 ))" "$(( (i * 7) % 60 ))" "${error_messages[$(( (i - 1) % 5 ))]}" >> "$log"
  if [ "$(( i % 3 ))" -eq 0 ]; then
    printf '2026-08-14T0%d:%02d:19+00:00 payments WARN retry budget for B-%04d is nearly exhausted\n' \
      "$(( i % 10 ))" "$(( (i * 7) % 60 ))" "$(( 100 + i ))" >> "$log"
  fi
done

# Ordinary rotated logs, none of which mentions the rejected transaction.
for day in 17 18; do
  file="/var/log/jumptotech/archive/payments-2026-08-${day}.log"
  {
    printf '2026-08-%s T00:00:01+00:00 payments INFO rotation complete\n' "$day"
    printf '2026-08-%sT03:41:07+00:00 payments INFO settled 4181 transactions\n' "$day"
    printf '2026-08-%sT06:02:55+00:00 payments WARN clearing house latency above target\n' "$day"
  } > "$file"
done

# The one archived log that carries the detail.
cat > /var/log/jumptotech/archive/payments-2026-08-19.log <<'LOG'
2026-08-19T00:00:01+00:00 payments INFO rotation complete
2026-08-19T02:14:33+00:00 payments INFO settled 3902 transactions
2026-08-19T02:57:02+00:00 payments WARN account ACC-100419 below reserve threshold
2026-08-19T02:57:03+00:00 payments REJECTED TXN-4471 account ACC-100419 reason=insufficient_reserve
2026-08-19T02:57:04+00:00 payments INFO transaction returned to the originating bank
LOG

chmod 0644 /var/log/jumptotech/payments.log /var/log/jumptotech/archive/*.log
chmod 0755 /var/log/jumptotech /var/log/jumptotech/archive
