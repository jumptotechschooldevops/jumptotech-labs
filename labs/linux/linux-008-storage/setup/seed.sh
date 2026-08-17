#!/bin/bash
# ---------------------------------------------------------------------------
# LINUX-008 baseline — a log archive that has grown, and a small data tree that
# has not.
#
# Everything is a plain file in the container's own writable layer. Nothing is
# mounted, no block device is touched, and no privileged operation is involved
# anywhere in this lab.
# ---------------------------------------------------------------------------
set -euo pipefail

install -d -o root -g root -m 0755 /var/log/jumptotech
install -d -o student -g student -m 0755 /var/log/jumptotech/archive
install -d -o student -g student -m 0755 /home/student/capacity

# Two bulky dumps left behind by an export that was supposed to clean up.
dd if=/dev/zero of=/var/log/jumptotech/archive/bulk-2026-06.dump bs=1M count=6 status=none
dd if=/dev/zero of=/var/log/jumptotech/archive/bulk-2026-07.dump bs=1M count=6 status=none

# The index the archive is actually indexed by. Small, and must survive.
cat > /var/log/jumptotech/archive/index.txt <<'TXT'
JumpToTech Bank — payments archive index

bulk-2026-06.dump   raw export, superseded, safe to delete
bulk-2026-07.dump   raw export, superseded, safe to delete
index.txt           this file — required by the archival tooling, keep
TXT

# A small application data tree, for comparison when sizing directories.
install -d -o student -g student -m 0755 /srv/jumptotech
install -d -o student -g student -m 0755 /srv/jumptotech/data
for name in accounts customers ledger; do
  printf 'id,name\n1,%s\n' "$name" > "/srv/jumptotech/data/${name}.csv"
done

chown -R student:student /var/log/jumptotech/archive /srv/jumptotech/data
chmod 0644 /var/log/jumptotech/archive/* /srv/jumptotech/data/*
