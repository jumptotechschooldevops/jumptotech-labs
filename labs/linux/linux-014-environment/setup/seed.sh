#!/bin/bash
# ---------------------------------------------------------------------------
# LINUX-014 baseline — a supervised service that is running and not working.
#
# The whole point of this lab is the gap between "a process exists" and "the
# service is doing its job", so the baseline deliberately produces a host where
# `pgrep` is happy and the service is useless:
#
#   · `report-runner` is enabled and supervised, so it is genuinely in the
#     process table and stays there;
#   · it needs two things from its environment — `JTT_ENV`, and a `PATH` that
#     can resolve its formatter — and the run script supplies neither;
#   · the *student's interactive shell* is given both, by an append to
#     .bashrc, so running the runner by hand appears to work perfectly. That
#     is the "but it works when I run it" moment the lab is built around.
#
# Nothing here is faked. The runner is a real program with a real failure
# mode, the supervisor is real runit, and the status file it publishes is
# rewritten from live state every cycle — so a student who forges it has their
# forgery overwritten within five seconds.
#
# Paths are chosen so that everything the verifier reads is world-readable and
# needs no traversal through a root-only directory: verifier reads happen as
# the unprivileged `student`, exactly like the student's own `cat`.
#
# Content is written from the GNU Bash manual, the Linux man-pages project and
# Debian's runit documentation only.
# ---------------------------------------------------------------------------
set -euo pipefail

STATUS_FILE=/var/lib/jumptotech/report-runner.status

install -d -o root -g root -m 0755 /var/log/jumptotech
install -d -o root -g root -m 0755 /var/lib/jumptotech
install -d -o root -g root -m 0755 /usr/local/lib/jumptotech
install -d -o root -g root -m 0755 /usr/local/libexec/jumptotech
install -d -o student -g student -m 0755 /home/student/ops

# --- the formatter ----------------------------------------------------------
#
# Deliberately in /usr/local/libexec/jumptotech, which is on nobody's default
# PATH. /usr/local/bin would have been resolvable by every process on the host
# and there would be no lesson.
cat > /usr/local/libexec/jumptotech/jtt-format <<'SH'
#!/bin/sh
# Formats one rollup subject for the reporting pipeline.
printf 'formatted=OK subject=%s\n' "${1:-unknown}"
SH
chmod 0755 /usr/local/libexec/jumptotech/jtt-format

# --- the service program ----------------------------------------------------
#
# Publishes a machine-readable status file describing its *own* health, which
# is what makes "is the service healthy" a question the platform can ask with
# an ordinary file check rather than a shell command.
#
# Run outside the supervisor it performs a single dry run and exits, so a
# student checking it by hand never leaves a second writer fighting the
# supervised instance for the status file.
cat > /usr/local/lib/jumptotech/report-runner <<'SH'
#!/bin/sh
# report-runner — produces the bank's rollup lines.
#
# Needs two things from its environment:
#   JTT_ENV   which deployment this is; there is no safe default
#   PATH      must be able to resolve `jtt-format`, the formatter it shells to
umask 022

STATUS=/var/lib/jumptotech/report-runner.status
LOG=/var/log/jumptotech/report-runner.log

formatter=''
state=''
reason=''

assess() {
  formatter=$(command -v jtt-format 2>/dev/null || true)
  if [ -z "${JTT_ENV:-}" ]; then
    state='STATUS=DEGRADED'
    reason='REASON=JTT_ENV is not set, so this instance does not know which deployment it belongs to'
  elif [ -z "$formatter" ]; then
    state='STATUS=DEGRADED'
    reason='REASON=jtt-format could not be resolved on PATH'
  else
    state='STATUS=OK'
    reason="FORMATTER=$formatter"
  fi
}

report() {
  printf '%s\n%s\nJTT_ENV=%s\nPATH=%s\n' "$state" "$reason" "${JTT_ENV:-}" "$PATH"
}

# Not supervised: one dry run, then exit. Never touches the status file.
if [ "${JTT_SUPERVISED:-}" != "1" ]; then
  assess
  report
  exit 0
fi

while true; do
  assess
  report > "$STATUS.tmp"
  mv -f "$STATUS.tmp" "$STATUS"
  if [ "$state" = 'STATUS=OK' ]; then
    printf '%s report-runner: %s\n' "$(date -Is)" "$("$formatter" daily-balance)" >> "$LOG"
  else
    printf '%s report-runner: not producing rollups — %s\n' "$(date -Is)" "$reason" >> "$LOG"
  fi
  sleep 5
done
SH
chmod 0755 /usr/local/lib/jumptotech/report-runner

# --- the service definition, as the release shipped it ----------------------
#
# JTT_SUPERVISED marks the supervised instance and is platform plumbing rather
# than part of the puzzle; it is also the visible precedent showing a student
# where a supervised service's environment is set. What is missing is
# everything the program actually needs.
install -d -m 0755 /etc/sv/report-runner
cat > /etc/sv/report-runner/run <<'SH'
#!/bin/sh
exec 2>&1

# Marks this as the supervised instance. Leave this in place.
JTT_SUPERVISED=1
export JTT_SUPERVISED

exec /usr/local/lib/jumptotech/report-runner
SH
chmod 0755 /etc/sv/report-runner/run

# --- the student's interactive shell ---------------------------------------
#
# Both of the things the service is missing. This is what makes the by-hand
# run succeed and the supervised run fail, which is the entire lesson.
cat >> /home/student/.bashrc <<'SH'

# Reporting pipeline — set up for interactive work on this host.
export JTT_ENV=production
export PATH="$PATH:/usr/local/libexec/jumptotech"
SH
chown student:student /home/student/.bashrc

# Enable it. runsvdir rescans /etc/service every few seconds.
ln -sfn /etc/sv/report-runner /etc/service/report-runner

# Wait for the supervisor to start it and for the first status file to land,
# so setup verification observes a service that is genuinely up and genuinely
# degraded rather than one that has not written anything yet.
for _ in $(seq 1 30); do
  if [ -s "$STATUS_FILE" ] && grep -q 'STATUS=DEGRADED' "$STATUS_FILE" 2>/dev/null; then
    break
  fi
  sleep 1
done
