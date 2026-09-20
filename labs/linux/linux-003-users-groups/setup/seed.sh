#!/bin/bash
# ---------------------------------------------------------------------------
# LINUX-003 baseline — a deployment area owned by root, with no team group yet.
#
# The directory is deliberately root-owned: creating the group structure under
# it is the point of the lab, and doing so requires elevated privileges, which
# the student has through sudo inside their own container.
# ---------------------------------------------------------------------------
set -euo pipefail

# The sandbox image creates a `deployers` group with `student` in it, for the
# permission labs that need a second group to chgrp to. This lab is about
# creating that group, so it must start without it: otherwise `groupadd
# deployers` fails with "already exists" and two checks pass before the
# student has done anything. Only this session's container is changed.
if getent group deployers >/dev/null; then
  gpasswd -d student deployers >/dev/null 2>&1 || true
  groupdel deployers
fi

install -d -o root -g root -m 0755 /srv/jumptotech

cat > /srv/jumptotech/README.txt <<'TXT'
JumpToTech Bank — deployment host

Release artefacts are staged under /srv/jumptotech/deploy. Everyone in the
`deployers` group needs full access to that directory; nobody outside it should
have any.
TXT
chown root:root /srv/jumptotech/README.txt
chmod 0644 /srv/jumptotech/README.txt
