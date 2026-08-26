#!/bin/sh
# ---------------------------------------------------------------------------
# JumpToTech Labs — Ansible managed-node entrypoint.
#
# Prepares one managed node and runs sshd in the foreground on JTT_SSH_PORT.
#
# The control node does NOT use this script. Its foreground process is the
# orchestrator's own keepalive and the student's shell arrives by `docker
# exec`, so the control node runs no sshd and needs no capability at all.
#
# The only credential material this script touches is JTT_AUTHORIZED_KEY, the
# *public* half of the session keypair. The private half is never passed as an
# environment variable — it would be readable through `docker inspect` — and is
# written to the control node over an exec stream after the topology is up.
# ---------------------------------------------------------------------------
set -eu

ROLE="${JTT_ROLE:-node}"
SSH_PORT="${JTT_SSH_PORT:-2222}"
AUTHORIZED_KEY="${JTT_AUTHORIZED_KEY:-}"

if [ "$ROLE" != "node" ]; then
  echo "jtt-entrypoint: only the 'node' role uses this entrypoint (got '$ROLE')" >&2
  exit 1
fi

if [ -z "$AUTHORIZED_KEY" ]; then
  echo "jtt-entrypoint: JTT_AUTHORIZED_KEY is required" >&2
  exit 1
fi

case "$SSH_PORT" in
  # Refuse a privileged port rather than silently depending on the runtime
  # having lowered ip_unprivileged_port_start. See the Dockerfile.
  ''|*[!0-9]*) echo "jtt-entrypoint: JTT_SSH_PORT must be numeric" >&2; exit 1 ;;
  *) [ "$SSH_PORT" -ge 1024 ] || { echo "jtt-entrypoint: JTT_SSH_PORT must be >= 1024" >&2; exit 1; } ;;
esac

# Host keys are generated per container, so no key material is baked into the
# image and two sessions never share a host identity.
ssh-keygen -A >/dev/null 2>&1

mkdir -p /var/empty /run/sshd

cat >/etc/ssh/sshd_config <<SSHD
Port ${SSH_PORT}
Protocol 2
PermitRootLogin prohibit-password
PasswordAuthentication no
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
X11Forwarding no
AllowTcpForwarding no
PermitTunnel no
PrintMotd no
AcceptEnv LANG LC_*
Subsystem sftp /usr/lib/ssh/sftp-server
SSHD

# Ansible connects to managed nodes as root, which is what lets the
# file/template/service modules work without a sudo dance that is not what
# these labs are teaching.
mkdir -p /root/.ssh
printf '%s\n' "$AUTHORIZED_KEY" >/root/.ssh/authorized_keys
chmod 0700 /root/.ssh
chmod 0600 /root/.ssh/authorized_keys

# The standard directory layout, present before anyone automates anything.
#
# Not a convenience: `copy` and `template` refuse a destination whose parent
# directory does not exist, so without it the second lab in the track would
# fail on a step it never mentions. Labs that are actually about creating
# directories still create their own.
mkdir -p \
  /etc/jumptotech \
  /opt/jumptotech \
  /srv/jumptotech \
  /var/log/jumptotech \
  /tmp/jumptotech \
  /var/www
chmod 0755 /etc/jumptotech /opt/jumptotech /srv/jumptotech /var/log/jumptotech /var/www
chmod 1777 /tmp/jumptotech

exec /usr/sbin/sshd -D -e
