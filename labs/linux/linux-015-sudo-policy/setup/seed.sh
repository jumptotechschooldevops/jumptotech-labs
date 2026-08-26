#!/bin/bash
# ---------------------------------------------------------------------------
# LINUX-015 baseline — an on-call account with far too much authority, and a
# probe that continuously reports what the policy *actually* enforces.
#
# HOW THIS LAB IS GRADED, AND WHY THERE IS A PROBE
#
# A sudo policy is not a file; it is what sudo does. A drop-in can be present,
# correctly owned, correctly moded, contain exactly the right-looking text —
# and grant nothing, because one token is misspelled and sudo refused to parse
# the file. Grading the text alone would pass that host.
#
# So the baseline installs `sudo-probe`: a supervised service running *as the
# oncall account* which every few seconds asks sudo four questions and writes
# the answers to a status file:
#
#   may oncall check the ledger service?      must end up permitted
#   may oncall restart the ledger service?    must end up permitted
#   may oncall read /etc/shadow?              must end up denied
#   may oncall restart a *different* service? must end up denied
#
# The last one is the whole lesson. A rule that names the control binary
# without constraining its arguments passes the first three and fails that one,
# which is exactly the mistake this lab exists to teach.
#
# The probe asks with `sudo -n -l <command>`, which resolves the policy and
# reports whether the invocation *would* be permitted. It never executes
# anything, so the probe has no side effects at all — it cannot restart a
# service, and a student watching it cannot be surprised by it.
#
# The probe drops to `oncall` with runit's own `chpst`. It has to run as that
# account: sudo's answer depends on who is asking, and a probe running as root
# would answer every question "yes" and teach nothing.
#
# Content is written from the sudo project's own manual pages and Debian
# documentation only.
# ---------------------------------------------------------------------------
set -euo pipefail

PROBE_DIR=/var/lib/jumptotech/probe
STATUS_FILE="${PROBE_DIR}/sudo-probe.status"

install -d -o root -g root -m 0755 /var/log/jumptotech
install -d -o root -g root -m 0755 /var/lib/jumptotech
install -d -o root -g root -m 0755 /usr/local/lib/jumptotech

# --- the on-call account ----------------------------------------------------
#
# A real login account rather than a system account: the rotation is staffed by
# people, and `sudo` resolves its policy against a real passwd entry.
if ! getent group oncall >/dev/null; then
  groupadd --gid 2015 oncall
fi
if ! getent passwd oncall >/dev/null; then
  useradd --create-home --home-dir /home/oncall --shell /bin/bash \
          --uid 2015 --gid oncall oncall
fi

# The probe writes here as `oncall`, so the directory is theirs. World-readable
# because the platform reads it back as the unprivileged student, exactly as
# the student's own `cat` would.
install -d -o oncall -g oncall -m 0755 "${PROBE_DIR}"

# --- the thing the rotation is supposed to be able to do --------------------
cat > /usr/local/sbin/jtt-service-control <<'SH'
#!/bin/sh
# The bank's service-control wrapper. Root-only by design: it drives the
# supervisor, which is why the on-call rotation needs sudo to reach it at all.
case "${1:-}" in
  status)  exec sv status "${2:?service name required}" ;;
  restart) exec sv restart "${2:?service name required}" ;;
  *)
    echo "usage: jtt-service-control {status|restart} <service>" >&2
    exit 2
    ;;
esac
SH
chmod 0755 /usr/local/sbin/jtt-service-control

# --- two services, so the control tool has something real to drive ----------
for svc in ledger-api payments-api; do
  cat > "/usr/local/bin/${svc}" <<SH
#!/bin/bash
while true; do
  echo "\$(date -Is) ${svc}: serving" >> /var/log/jumptotech/${svc}.log
  sleep 2
done
SH
  chmod 0755 "/usr/local/bin/${svc}"
  install -d -m 0755 "/etc/sv/${svc}"
  cat > "/etc/sv/${svc}/run" <<SH
#!/bin/sh
exec 2>&1
exec /usr/local/bin/${svc}
SH
  chmod 0755 "/etc/sv/${svc}/run"
  ln -sfn "/etc/sv/${svc}" "/etc/service/${svc}"
done

# --- the audit finding ------------------------------------------------------
#
# What the last engineer shipped when the rotation said "we cannot restart the
# ledger service". It works, and it is the reason security rejected it.
cat > /etc/sudoers.d/020-oncall <<'SH'
# On-call rotation.
#
# Raised 2026-08-18 so the rotation could restart the ledger service without
# waiting for a platform engineer. Flagged at the next access review: this
# grants the whole host, not the one thing that was asked for.
oncall ALL=(ALL) NOPASSWD: ALL
SH
chmod 0440 /etc/sudoers.d/020-oncall
chown root:root /etc/sudoers.d/020-oncall

# --- the policy probe -------------------------------------------------------
cat > /usr/local/lib/jumptotech/sudo-probe <<'SH'
#!/bin/sh
# sudo-probe — reports what the sudo policy actually enforces for this account.
#
# Runs as `oncall`. Asks with `sudo -n -l <command>`, which resolves the policy
# and reports whether the invocation would be permitted without executing it,
# so this probe never changes anything on the host.
umask 022

STATUS=/var/lib/jumptotech/probe/sudo-probe.status
CTL=/usr/local/sbin/jtt-service-control

ask() {
  # 0 when sudo would permit the invocation, non-zero when it would not.
  if sudo -n -l -- "$@" >/dev/null 2>&1; then
    echo permitted
  else
    echo denied
  fi
}

while true; do
  status_ledger=$(ask "$CTL" status ledger-api)
  restart_ledger=$(ask "$CTL" restart ledger-api)
  read_shadow=$(ask /bin/cat /etc/shadow)
  restart_other=$(ask "$CTL" restart payments-api)

  [ "$status_ledger" = permitted ]  && p_status=ok      || p_status=denied
  [ "$restart_ledger" = permitted ] && p_restart=ok     || p_restart=denied
  [ "$read_shadow" = permitted ]    && f_cmd=allowed    || f_cmd=denied
  [ "$restart_other" = permitted ]  && f_arg=allowed    || f_arg=denied

  printf 'PERMITTED_STATUS=%s\nPERMITTED_RESTART=%s\nFORBIDDEN_CMD=%s\nFORBIDDEN_ARG=%s\nPROBED_AS=%s\n' \
    "$p_status" "$p_restart" "$f_cmd" "$f_arg" "$(id -un)" > "$STATUS.tmp"
  mv -f "$STATUS.tmp" "$STATUS"

  sleep 5
done
SH
chmod 0755 /usr/local/lib/jumptotech/sudo-probe

install -d -m 0755 /etc/sv/sudo-probe
cat > /etc/sv/sudo-probe/run <<'SH'
#!/bin/sh
exec 2>&1
# Drops to the on-call account before probing: sudo's answer depends on who is
# asking, and a probe running as root would answer "yes" to everything.
exec chpst -u oncall /usr/local/lib/jumptotech/sudo-probe
SH
chmod 0755 /etc/sv/sudo-probe/run
ln -sfn /etc/sv/sudo-probe /etc/service/sudo-probe

# Wait for the supervisor to start the probe and for it to publish its first
# reading, so setup verification observes a real baseline rather than a host
# that has not answered yet. The baseline is deliberately "the rotation can do
# everything", which is the finding the student has to correct.
# Waits for a *complete* baseline reading rather than merely a file: sudo's
# first invocation in a fresh container is the slowest one, and handing the lab
# over mid-cycle would show a student a partial answer on their first Check.
for _ in $(seq 1 40); do
  if [ -s "${STATUS_FILE}" ] \
     && grep -q 'PERMITTED_STATUS=ok'    "${STATUS_FILE}" 2>/dev/null \
     && grep -q 'PERMITTED_RESTART=ok'   "${STATUS_FILE}" 2>/dev/null \
     && grep -q 'FORBIDDEN_CMD=allowed'  "${STATUS_FILE}" 2>/dev/null \
     && grep -q 'FORBIDDEN_ARG=allowed'  "${STATUS_FILE}" 2>/dev/null; then
    break
  fi
  sleep 1
done
