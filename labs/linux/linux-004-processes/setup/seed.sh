#!/bin/bash
# ---------------------------------------------------------------------------
# LINUX-004 baseline — one runaway process already running, one job that has
# not been started yet.
#
# The runaway is started with `setsid` so it is reparented to the container's
# init and survives this seed run, exactly as a real orphaned background job on
# a host would. It is deliberately NOT supervised: this lab is about finding
# and signalling a process, not about service management (that is LINUX-005),
# so a `kill` here must actually stick.
# ---------------------------------------------------------------------------
set -euo pipefail

install -d -o root -g root -m 0755 /var/log/jumptotech

cat > /usr/local/bin/stale-batch-job <<'SH'
#!/bin/bash
# Left over from a release that was rolled back three weeks ago. Still spinning.
while true; do
  echo "$(date -Is) stale-batch-job: reprocessing queue segment" >> /var/log/jumptotech/stale-batch-job.log
  sleep 5
done
SH

cat > /usr/local/bin/ledger-sync <<'SH'
#!/bin/bash
# Reconciles the ledger with the clearing house. Safe to run in the background.
while true; do
  echo "$(date -Is) ledger-sync: reconciled batch" >> /var/log/jumptotech/ledger-sync.log
  sleep 5
done
SH

chmod 0755 /usr/local/bin/stale-batch-job /usr/local/bin/ledger-sync

install -d -o student -g student -m 0755 /home/student/ops

# The log ledger-sync appends to, provisioned the way config management would
# leave it: the directory stays root-owned and traversable, and the file itself
# belongs to the account that writes to it.
#
# This was previously `chmod 0666` on the *directory*, which drops the search
# bit — so `student` could not traverse into /var/log/jumptotech at all, and the
# service they were asked to start failed on every write, silently, once every
# five seconds. This lab teaches finding and signalling a process; an unhinted
# permission fault layered on top of that is noise, not difficulty.
install -o student -g student -m 0644 /dev/null /var/log/jumptotech/ledger-sync.log

# Start the runaway and detach it from this seed session.
setsid nohup /usr/local/bin/stale-batch-job >/dev/null 2>&1 &
disown || true

# Give it a moment to appear in the process table before setup verification
# looks for it.
sleep 1
