#!/bin/bash
# ---------------------------------------------------------------------------
# LINUX-003 baseline — a deployment area owned by root, with no team group yet.
#
# The directory is deliberately root-owned: creating the group structure under
# it is the point of the lab, and doing so requires elevated privileges, which
# the student has through sudo inside their own container.
# ---------------------------------------------------------------------------
set -euo pipefail

install -d -o root -g root -m 0755 /srv/jumptotech

cat > /srv/jumptotech/README.txt <<'TXT'
JumpToTech Bank — deployment host

Release artefacts are staged under /srv/jumptotech/deploy. Everyone in the
`deployers` group needs full access to that directory; nobody outside it should
have any.
TXT
chown root:root /srv/jumptotech/README.txt
chmod 0644 /srv/jumptotech/README.txt
