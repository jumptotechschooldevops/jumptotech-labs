#!/bin/bash
# ---------------------------------------------------------------------------
# LINUX-002 baseline — a reporting directory whose permissions are wrong.
#
# Runs once as root inside the session's own container, before the student's
# terminal opens, and is deleted immediately afterwards.
# ---------------------------------------------------------------------------
set -euo pipefail

install -d -o student -g student -m 0755 /srv/jumptotech
install -d -o student -g student -m 0755 /srv/jumptotech/reports

# A finance export that was created world-writable by a careless deploy script.
cat > /srv/jumptotech/reports/daily-balance.csv <<'CSV'
account_id,currency,closing_balance
ACC-100418,GBP,18422.55
ACC-100419,GBP,2039.10
ACC-100420,EUR,74310.00
CSV

# The collector that produces it — shipped without its execute bit.
cat > /srv/jumptotech/reports/collect-balances.sh <<'SH'
#!/bin/bash
# Nightly balance collector. Writes daily-balance.csv.
echo "collecting balances at $(date -Is)"
SH

chown student:student /srv/jumptotech/reports/daily-balance.csv \
                      /srv/jumptotech/reports/collect-balances.sh
chmod 0666 /srv/jumptotech/reports/daily-balance.csv
chmod 0644 /srv/jumptotech/reports/collect-balances.sh
