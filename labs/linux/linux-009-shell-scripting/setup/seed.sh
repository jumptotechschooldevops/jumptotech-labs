#!/bin/bash
# ---------------------------------------------------------------------------
# LINUX-009 baseline — the two status fixtures the student's script will be
# graded against, plus an empty scripts directory they own.
#
# Note what is deliberately NOT here: no reference implementation, no skeleton,
# no template. The verifier runs the student's own script against these
# fixtures and grades its behaviour, so any correct solution passes and no
# solution is on disk to copy.
# ---------------------------------------------------------------------------
set -euo pipefail

install -d -o root -g root -m 0755 /srv/jumptotech
install -d -o root -g root -m 0755 /srv/jumptotech/app
install -d -o student -g student -m 0755 /home/student/scripts

cat > /srv/jumptotech/app/healthy.status <<'TXT'
service: ledger-api
state: healthy
checked: 2026-08-16T06:00:00+00:00
TXT

cat > /srv/jumptotech/app/degraded.status <<'TXT'
service: ledger-api
state: degraded
checked: 2026-08-16T06:00:00+00:00
TXT

chmod 0644 /srv/jumptotech/app/healthy.status /srv/jumptotech/app/degraded.status

# /srv/jumptotech/app/missing.status is deliberately absent — the third case
# the script has to handle is a status file that is not there at all.
rm -f /srv/jumptotech/app/missing.status
