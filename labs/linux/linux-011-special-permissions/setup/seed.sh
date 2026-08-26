#!/bin/bash
# ---------------------------------------------------------------------------
# LINUX-011 baseline — three special-permission defects on a shared deploy
# host, plus the writer service whose output is the evidence for two of them.
#
# WHY A PERMISSIONS LAB SEEDS A SERVICE
#
# A umask is not a property of the filesystem. Once a file exists, a mode that
# came from a umask and a mode that came from `chmod` are the same bytes, so no
# amount of reading a directory afterwards proves that anyone configured
# anything. What *can* be observed is what a fresh login shell for this account
# produces right now — so the handoff writer starts one every three seconds, as
# the deploy account, and creates the two artefacts the checks read.
#
# Nothing in this file, and nothing in the writer, ever sets a mode on those
# artefacts. There is deliberately no chmod in jtt-handoff-once: the mode is
# the thing being demonstrated, and a writer that set one would be answering
# its own question.
# ---------------------------------------------------------------------------
set -euo pipefail

install -d -o root -g root -m 0755 /srv/jumptotech /srv/jumptotech/runbooks

# --- defect 1: the drop is group-owned, and that is only half a policy ------
#
# `deployers` owns it and can write to it, which looks correct at a glance.
# Files created inside it still land in the creator's own primary group, so the
# group the directory exists to serve gets no group access to what appears
# there — and the default umask leaves those files readable by everyone else.
install -d -o root -g deployers -m 0770 /srv/jumptotech/drop

# --- defect 2: world-writable scratch with no sticky bit --------------------
#
# Two files, two different owners, so the consequence is something the student
# can try rather than something they have to take on trust: with 0777 and no
# sticky bit, either account can remove the other's file.
install -d -o root -g root -m 0777 /srv/jumptotech/scratch
printf 'on-call rota notes for the settlement window — do not delete\n' \
  > /srv/jumptotech/scratch/rota-notes.txt
chown root:root /srv/jumptotech/scratch/rota-notes.txt
chmod 0644 /srv/jumptotech/scratch/rota-notes.txt
printf 'working set for batch b-4471\n' > /srv/jumptotech/scratch/b-4471.tmp
chown student:student /srv/jumptotech/scratch/b-4471.tmp
chmod 0644 /srv/jumptotech/scratch/b-4471.tmp

# --- defect 3: a setuid-root helper on the deploy path ----------------------
#
# A real ELF binary rather than a script. Linux ignores the setuid bit on
# interpreted files, so a setuid shell script would have been a prop that
# taught the wrong lesson — it would look dangerous and do nothing. This is a
# copy of `du`: exactly the kind of "it only reports things" tool that acquires
# a setuid bit during an incident, and which, running as root, will happily
# report on directories the account running it cannot otherwise read.
install -o root -g root -m 4755 /usr/bin/du /usr/local/bin/report-helper

# --- the standard the three defects are measured against --------------------
cat > /srv/jumptotech/runbooks/shared-areas.md <<'DOC'
# Shared areas on a deploy host — the standard

## /srv/jumptotech/drop — the deployers' handoff area

The nightly handoff writer leaves its output here for whoever picks up the
next shift. Two properties are required of everything that appears in it:

  * it belongs to the `deployers` group, without anyone having to remember to
    set that — the directory itself must make new entries inherit the group;
  * it is readable by that group and by nobody outside it. Handoff data
    carries account numbers. Group read, no world access.

The directory stays group-writable at 0770 for `deployers`. Do not widen it.

## /srv/jumptotech/scratch — shared working space

Deliberately writable by everybody: any account on the box may drop a working
set here. What is not acceptable is the current behaviour, where any account
may also *remove* another account's files. Removal is for the owner of the
file. Keep the area writable by all; change only who may delete.

## Setuid on the deploy path

No binary under /usr/local/bin carries a setuid or setgid bit. The report
helper was given one during the March incident and it was never taken back
off. Ordinary permissions are correct for it: owner-writable, readable and
executable by all.
DOC
chmod 0644 /srv/jumptotech/runbooks/shared-areas.md

# --- the handoff writer -----------------------------------------------------
#
# One cycle. `su -` rather than `su`: a login shell reads the account's login
# profile, which is where a umask has to live if it is to apply to anything
# other than the shell that typed it. That is the whole mechanism this lab is
# about, and it is why running the writer by hand from an interactive shell
# would prove nothing.
#
# Both artefacts are built under a temporary name and renamed into place, so
# the paths the checks read are never momentarily absent. rename(2) does not
# touch a mode or a group, so what lands is exactly what creation produced.
cat > /usr/local/bin/jtt-handoff-once <<'SH'
#!/bin/sh
[ -d /srv/jumptotech/drop ] || exit 0
su - student -c '
  set -e
  cd /srv/jumptotech/drop
  rm -rf handoff.csv.new handoff.d.new
  printf "batch,account,amount\nb-4471,8837-2,120.00\n" > handoff.csv.new
  mkdir handoff.d.new
  mkdir -p handoff.d
  find handoff.d -mindepth 1 -delete 2>/dev/null || true
  mv    handoff.csv.new handoff.csv
  mv -T handoff.d.new   handoff.d
' >/dev/null 2>&1 || true
SH
chmod 0755 /usr/local/bin/jtt-handoff-once

cat > /usr/local/bin/jtt-handoff <<'SH'
#!/bin/sh
# The handoff writer, supervised by runit. One cycle every three seconds, so a
# change to the account's login profile shows up in the drop within a few
# seconds rather than at some invisible nightly hour.
while true; do
  /usr/local/bin/jtt-handoff-once
  sleep 3
done
SH
chmod 0755 /usr/local/bin/jtt-handoff

install -d -m 0755 /etc/sv/handoff
cat > /etc/sv/handoff/run <<'SH'
#!/bin/sh
exec 2>&1
exec /usr/local/bin/jtt-handoff
SH
chmod 0755 /etc/sv/handoff/run
ln -sfn /etc/sv/handoff /etc/service/handoff

# One cycle now, synchronously, so setup verification observes the baseline
# artefacts rather than racing the supervisor's first tick.
/usr/local/bin/jtt-handoff-once

# Wait for runit to pick the service up, so "the writer is running" is already
# true by the time the student's terminal exists.
for _ in $(seq 1 25); do
  if pgrep -f /usr/local/bin/jtt-handoff >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
