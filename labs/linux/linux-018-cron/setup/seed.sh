#!/bin/bash
# ---------------------------------------------------------------------------
# LINUX-018 baseline — a scheduled job that has never once run, and no error
# anywhere to say why.
#
# WHY THE STUDENT CANNOT SEE THE PROBLEM AT FIRST
#
# cron sends a job's output to mail. There is no MTA on this host and no
# syslog, so when the entry fails there is nothing in any log, nothing on any
# terminal, and a crontab that reads perfectly plausibly. That silence is the
# actual production lesson, and it is why the first useful thing a student can
# do is capture the job's output — after which the remaining faults announce
# themselves.
#
# THREE FAULTS, LAYERED
#
#   0 3 * * *      runs daily at three in the morning; the rollup is supposed
#                  to run every minute during the incident window
#   jtt-rollup     a bare command name. cron gives a user crontab
#                  PATH=/usr/bin:/bin, and the tool is not in either.
#   mode 0644      the tool is not executable, so even a correct path fails
#
# Fixing the schedule alone changes nothing visible. Adding the redirect is
# what turns an invisible failure into a readable one, and only then do the
# other two become findable.
#
# HOW EXECUTION IS PROVEN, AND WHY IT CANNOT BE HAND-WAVED
#
# The rollup tool records how it was invoked, by walking its own process
# ancestry through /proc until it reaches pid 1 and reporting whether `cron`
# was among its ancestors. Run from a shell it records RUNBY=shell; run by the
# scheduler it records RUNBY=cron. That is kernel-observed and is what the
# lab grades, so producing the output file by running the tool by hand does
# not satisfy the check — which is the whole point of a lab about scheduling.
#
# Content is written from the Debian cron package's own manual pages and the
# Linux man-pages project.
# ---------------------------------------------------------------------------
set -euo pipefail

LIB=/usr/local/lib/jumptotech
ROLLUP_DIR=/var/lib/jumptotech/rollup
LOGS=/var/log/jumptotech

install -d -o root -g root -m 0755 "${LIB}" "${LOGS}"
install -d -o root -g root -m 0755 /var/lib/jumptotech
# The job runs as `student`, so its output directory is theirs. World-readable
# because the platform reads it back as that same unprivileged account.
install -d -o student -g student -m 0755 "${ROLLUP_DIR}"

# The log the runbook tells the student to redirect into, provisioned empty and
# owned by the account the job runs as — the way config management would leave
# it. /var/log/jumptotech itself stays root-owned, so without this the redirect
# the runbook asks for would fail with a permission error the runbook gives no
# guidance about. This lab already teaches the execute bit; a second, unhinted
# permission fault would be noise rather than a lesson.
install -o student -g student -m 0644 /dev/null "${LOGS}/rollup-cron.log"
install -d -o student -g student -m 0755 /srv/jumptotech/runbooks

# --- the operational data the rollup processes ------------------------------
#
# Deterministic: a fixed number of events so the rollup's record count is a
# fact the lab can assert rather than a number that drifts between runs.
awk 'BEGIN { for (i = 1; i <= 1440; i++) printf "2026-08-25T%02d:%02d:00 event id=%d kind=settlement\n", i % 24, i % 60, 40000 + i }' \
  > "${LOGS}/app-events.log"
chmod 0644 "${LOGS}/app-events.log"

# --- the rollup tool --------------------------------------------------------
#
# Deliberately NOT executable. Left root-owned, because it is platform
# software rather than something the student wrote.
cat > "${LIB}/jtt-rollup" <<'SH'
#!/bin/sh
# jtt-rollup — condenses the event log into an hourly rollup.
#
# Records how it was invoked. A scheduled run has `cron` somewhere in its
# process ancestry; a run from a terminal does not. Walking /proc is how that
# is established, because it is the one thing about an invocation that cannot
# be asserted by whoever started it.
umask 022

EVENTS=/var/log/jumptotech/app-events.log
STATUS=/var/lib/jumptotech/rollup/status.txt

runby=shell
pid=$PPID
while [ "$pid" -gt 1 ] 2>/dev/null; do
  comm=$(cat "/proc/$pid/comm" 2>/dev/null) || break
  case "$comm" in
    cron|CRON) runby=cron; break ;;
  esac
  pid=$(awk '{ print $4 }' "/proc/$pid/stat" 2>/dev/null) || break
done

records=$(wc -l < "$EVENTS" 2>/dev/null || echo 0)

tmp="$STATUS.tmp"
{
  printf 'ROLLUP=OK\n'
  printf 'RUNBY=%s\n' "$runby"
  printf 'RECORDS=%s\n' "$records"
  printf 'AT=%s\n' "$(date -Is)"
} > "$tmp"
mv -f "$tmp" "$STATUS"

# One line on standard output. cron mails this somewhere that does not exist
# on this host, so it is only ever seen if the crontab entry redirects it.
printf 'rollup complete: %s records\n' "$records"
SH
chmod 0644 "${LIB}/jtt-rollup"
chown root:root "${LIB}/jtt-rollup"

# --- the runbook: the contract, in prose ------------------------------------
cat > /srv/jumptotech/runbooks/rollup-schedule.md <<'MD'
# Event rollup — scheduling

The rollup condenses `/var/log/jumptotech/app-events.log` into
`/var/lib/jumptotech/rollup/status.txt`. Ops read that file; nothing else reads
it.

During an incident window the rollup runs **every minute**, so the dashboard is
never more than sixty seconds behind. Outside a window it drops back to hourly,
but we are in a window now and it has not produced anything since it was set up.

The tool is `/usr/local/lib/jumptotech/jtt-rollup`. It takes no arguments.

Standards for scheduled jobs on this estate, from the last post-incident
review — both of these exist because of outages, not because of taste:

* **Name the program by its absolute path.** The scheduler does not run with
  your login environment and its search path is far shorter than yours. Two
  incidents have now been caused by an entry that worked when typed by hand.
* **Send the job's output somewhere a person can read.** By default a job's
  output is mailed, and there is no mail on these hosts, so a failing job fails
  in complete silence. Append both standard output and standard error to
  `/var/log/jumptotech/rollup-cron.log`.

The entry belongs in the `student` account's own crontab, not in a system-wide
file — the rollup runs as that account and reads and writes only its files.
MD
chmod 0644 /srv/jumptotech/runbooks/rollup-schedule.md

# --- the entry the previous engineer left behind ----------------------------
#
# Installed through crontab(1) rather than written into the spool by hand, so
# the file has the ownership and mode cron expects.
cat > /tmp/jtt-seed-crontab <<'CRON'
# Event rollup. Set up during the migration; ops say it has never produced
# anything, but the entry looks right to me.
0 3 * * * jtt-rollup
CRON
crontab -u student /tmp/jtt-seed-crontab
rm -f /tmp/jtt-seed-crontab

# --- cron itself, supervised like every other service on this host ----------
install -d -m 0755 /etc/sv/cron
cat > /etc/sv/cron/run <<'SH'
#!/bin/sh
exec 2>&1
# Foreground, so runit supervises the daemon itself rather than a launcher.
exec /usr/sbin/cron -f
SH
chmod 0755 /etc/sv/cron/run
ln -sfn /etc/sv/cron /etc/service/cron

# Wait for the supervisor to start cron, so the student is handed a host where
# the scheduler is genuinely running and the fault is somewhere else.
for _ in $(seq 1 30); do
  if pgrep -x cron >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
