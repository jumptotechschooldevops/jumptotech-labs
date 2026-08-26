#!/bin/bash
# ---------------------------------------------------------------------------
# CS-011 baseline — the entrypoint that starts a worker and never reaps it.
#
# The fixture is read-only text. It is deliberately NOT a running zombie
# factory: the student produces the zombies themselves, with their own program,
# so what is graded is a lifecycle they caused and observed rather than a
# process the seed happened to leave lying about.
#
# --- Why nothing here is graded on wall-clock time -------------------------
#
# The obvious way to grade "did not reap" is a short timeout on a program that
# hangs. That grades the machine as much as the student, and this repository
# has already seen container reads go slow under load. So the lab grades the
# child's *state* and the *wait status*, both of which are values, not delays:
#
#   zombie              /proc/<pid>/stat field 3 reads Z
#   reaped              /proc/<pid> is gone afterwards
#   wait status         exit code 7 arrives as 1792, because it is 7 << 8
#
# The last one is the discriminator. A program that never calls waitpid cannot
# report the raw status for an exit code it is handed at run time, and the two
# numbers are barred from the source.
#
# Verified in the real image before any of it was written down: 7 -> 1792,
# 3 -> 768, 0 -> 0; an orphan reparents to PID 1 inside the container's PID
# namespace; and SIGKILL on a zombie leaves it in state Z.
# ---------------------------------------------------------------------------
set -euo pipefail

BUNDLE=/srv/kestrel/worker

install -d -o root -g root -m 0755 /srv/kestrel
install -d -o root -g root -m 0755 "$BUNDLE"

cat > "$BUNDLE/README.txt" <<'TXT'
kestrel scan worker

  entrypoint.sh   what the container runs as PID 1
  scan-once.sh    one scan pass, started by the entrypoint

The worker container ends the day with several hundred processes marked
<defunct> and then stops being able to start new ones. Restarting the
container clears it for a while.

Nobody has been able to kill the defunct entries. `kill -9` reports success
and changes nothing.
TXT

# The entrypoint as it runs in production: it starts children in a loop and
# never waits for any of them. As PID 1 it also inherits every orphan in the
# container, and reaps none of those either.
cat > "$BUNDLE/entrypoint.sh" <<'SH'
#!/bin/sh
# kestrel scan worker entrypoint — runs as PID 1 in the container
while true; do
    /srv/kestrel/worker/scan-once.sh &
    sleep 30
done
SH

cat > "$BUNDLE/scan-once.sh" <<'SH'
#!/bin/sh
# one scan pass; exits with the number of scanners that failed
exit 0
SH

chown root:root "$BUNDLE"/*
chmod 0444 "$BUNDLE"/README.txt
chmod 0555 "$BUNDLE"/entrypoint.sh "$BUNDLE"/scan-once.sh
chmod 0755 "$BUNDLE"

# /home/student/py and /home/student/ops are the student's to create.
