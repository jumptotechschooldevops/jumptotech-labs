#!/bin/sh
# ---------------------------------------------------------------------------
# Install the session's SSH private key on the control node.
#
# The key arrives on stdin rather than through an environment variable or a
# bind mount, so it never appears in `docker inspect`, in the image, or on the
# host filesystem. It is written 0600 and owned by the shell user, and it dies
# with the container when the session ends.
# ---------------------------------------------------------------------------
set -eu

DEST=/home/student/.ssh/id_lab

mkdir -p /home/student/.ssh
umask 077
cat >"$DEST"
chmod 0600 "$DEST"
chown student:student "$DEST"

cat >/home/student/.ssh/config <<'CFG'
Host *
  IdentityFile ~/.ssh/id_lab
  IdentitiesOnly yes
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
CFG
chmod 0600 /home/student/.ssh/config
chown student:student /home/student/.ssh/config
echo installed
