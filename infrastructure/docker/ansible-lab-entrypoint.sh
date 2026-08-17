#!/bin/sh
# ---------------------------------------------------------------------------
# JumpToTech Labs — Ansible sandbox node entrypoint.
#
# Prepares one container for its role and then runs sshd in the foreground.
#
#   JTT_ROLE=control  the student's shell lands here over SSH as `student`;
#                     ansible-core runs from /home/student/lab
#   JTT_ROLE=node     a managed node; Ansible connects as root over SSH
#
# The only credential material this script touches is JTT_AUTHORIZED_KEY, the
# *public* half of the session keypair. The private half is never passed as an
# environment variable (it would be readable via `docker inspect`); the
# orchestrator streams it in over stdin afterwards — see jtt-install-key.
# ---------------------------------------------------------------------------
set -eu

ROLE="${JTT_ROLE:-node}"
AUTHORIZED_KEY="${JTT_AUTHORIZED_KEY:-}"

if [ -z "$AUTHORIZED_KEY" ]; then
  echo "jtt-entrypoint: JTT_AUTHORIZED_KEY is required" >&2
  exit 1
fi

# --- sshd host keys ---------------------------------------------------------
# Generated per container, so no key material is baked into the image and two
# sessions never share a host identity.
ssh-keygen -A >/dev/null 2>&1

mkdir -p /var/empty /run/sshd
cat >/etc/ssh/sshd_config <<'SSHD'
Port 22
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

install_authorized_key() {
  home="$1"
  owner="$2"
  mkdir -p "$home/.ssh"
  printf '%s\n' "$AUTHORIZED_KEY" >"$home/.ssh/authorized_keys"
  chmod 0700 "$home/.ssh"
  chmod 0600 "$home/.ssh/authorized_keys"
  chown -R "$owner" "$home/.ssh"
}

# Root is authorised on every node: Ansible connects to managed nodes as root,
# which is what lets the file/template/service modules work without a sudo
# dance that is not what these labs are teaching.
install_authorized_key /root root:root

if [ "$ROLE" = "node" ]; then
  # The bank's standard directory layout, present on every managed node before
  # anyone automates anything.
  #
  # This is not a convenience: `copy` and `template` refuse a destination whose
  # parent directory does not exist, so without it the *second* lab in the track
  # would fail on a step it never mentions — teaching a student about
  # `ansible.builtin.file` by ambush rather than by design. The labs that are
  # actually about creating directories still create their own.
  mkdir -p \
    /etc/jumptotech \
    /opt/jumptotech \
    /srv/jumptotech \
    /var/log/jumptotech \
    /tmp/jumptotech \
    /var/www
  chmod 0755 /etc/jumptotech /opt/jumptotech /srv/jumptotech /var/log/jumptotech /var/www
  chmod 1777 /tmp/jumptotech
fi

if [ "$ROLE" = "control" ]; then
  # The shell user. Deliberately not root: the student's terminal lands here.
  if ! id student >/dev/null 2>&1; then
    adduser -D -u 1001 -s /bin/bash student
  fi

  # `adduser -D` leaves the account *locked* (`!` in /etc/shadow), and sshd
  # built without PAM refuses a locked account before it ever looks at a key —
  # so key-only login would fail with a bare "Permission denied (publickey)".
  # `*` means "no password will ever match", which is what we want: the account
  # is reachable by key and by nothing else.
  usermod -p '*' student

  install_authorized_key /home/student student:student

  mkdir -p /home/student/lab
  chown -R student:student /home/student

  # Passwordless sudo so a lab can demonstrate `become:` without the student
  # having to invent a password that does not exist.
  echo 'student ALL=(ALL) NOPASSWD: ALL' >/etc/sudoers.d/student
  chmod 0440 /etc/sudoers.d/student

  cat >/home/student/.profile <<'PROFILE'
export PATH=/usr/local/bin:/usr/bin:/bin
export ANSIBLE_HOST_KEY_CHECKING=False
export ANSIBLE_RETRY_FILES_ENABLED=False
cd /home/student/lab 2>/dev/null || true
PROFILE
  cp /home/student/.profile /home/student/.bashrc
  chown student:student /home/student/.profile /home/student/.bashrc
fi

# `python3` is what Ansible actually needs on a managed node; make the classic
# interpreter path resolve so an inventory that pins it still works.
[ -e /usr/bin/python ] || ln -sf /usr/bin/python3 /usr/bin/python

exec /usr/sbin/sshd -D -e
