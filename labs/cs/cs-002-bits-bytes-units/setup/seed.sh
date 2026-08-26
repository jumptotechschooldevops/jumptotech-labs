#!/bin/bash
# ---------------------------------------------------------------------------
# CS-002 baseline — the 06:12 alert and the raw evidence behind it.
#
# Three files, each the smallest thing that makes one conversion real:
#
#   alert.txt   the alert as the on-call engineer saw it, mixing a decimal
#               megabyte figure with an IEC limit — the mismatch the lab exists
#               to settle;
#   limit.hex   the limit as the runtime recorded it, in hex. Converting it is
#               how the student learns that hex is just another spelling of a
#               number they already have;
#   tag.bin     exactly two bytes, `M` and `i`, with no trailing newline. Two
#               bytes is enough to see that a character is a byte and that a
#               byte has a hexadecimal spelling — and `Mi` is the suffix the
#               whole argument is about.
#
# Every graded answer is derived, never stated:
#   0x20000000 must be converted to 536870912;
#   536870912 must be run through numfmt twice to get 537M and 512M;
#   the two bytes must be dumped to get 4d69;
#   640 MB and 512 MiB must both be reduced to bytes before they can be
#   compared at all.
#
# Nothing here can be grepped for an answer, and the file the student writes
# their program into does not exist yet — `~/py` is theirs to create.
#
# The capture is root-owned and world-readable: the student is reading
# evidence, not editing it, and nothing they could write here would help them
# pass, because the expected values live in lab.yaml, outside the sandbox.
# ---------------------------------------------------------------------------
set -euo pipefail

BUNDLE=/srv/kestrel/scan-api

install -d -o root -g root -m 0755 /srv/kestrel
install -d -o root -g root -m 0755 "$BUNDLE"

cat > "$BUNDLE/README.txt" <<'TXT'
scan-api — memory alert evidence, 06:12

Three files, copied off the host by the on-call engineer before the argument
in the incident channel started:

  alert.txt    the alert text, exactly as it was posted
  limit.hex    the container memory limit as the runtime reported it
  tag.bin      two bytes taken from the limit's unit suffix

Nobody has converted anything yet. That is the job.
TXT

cat > "$BUNDLE/alert.txt" <<'TXT'
06:12:04  ALERT  scan-api  memory 640M of 512Mi limit  pod=scan-api-7d9c4
TXT

cat > "$BUNDLE/limit.hex" <<'TXT'
0x20000000
TXT

# Exactly two bytes: 0x4d 0x69. `printf` rather than `echo` so there is no
# trailing newline to explain away when the student dumps it.
printf 'Mi' > "$BUNDLE/tag.bin"

chown -R root:root "$BUNDLE"
chmod 0444 "$BUNDLE"/README.txt "$BUNDLE"/alert.txt "$BUNDLE"/limit.hex "$BUNDLE"/tag.bin
chmod 0755 "$BUNDLE"

# `/home/student/py` and `/home/student/ops` are deliberately NOT created. The
# student makes the directory their program lives in.
