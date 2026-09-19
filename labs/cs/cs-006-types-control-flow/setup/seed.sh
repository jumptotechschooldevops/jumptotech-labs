#!/bin/bash
# ---------------------------------------------------------------------------
# CS-006 baseline — the autoscaler that has never scaled down.
#
# The evidence is a decision log and a batch of readings. Both are inputs, not
# answers: the readings say what the scaler was asked about, and the log says
# what it decided. What the *right* decision was for each reading is nowhere on
# disk — that lives in lab.yaml, outside the sandbox entirely.
#
# --- No grading harness, deliberately --------------------------------------
#
# The curriculum plan sketched this lab with a seeded harness that imports the
# student's `decide` and prints PASS tokens. That design is unsound whatever
# its file permissions are: a harness that imports student code runs it in the
# same process, so the student's module can print the tokens itself at import
# time and exit. Making the harness root-owned and unwritable does not help,
# because the attack is not on the file — it is on the process.
#
# So there is no harness. The student's own program is run directly against
# argument sets chosen to separate a correct implementation from the specific
# mistakes this lab is about, which is the pattern CS-002 through CS-005 use.
#
# The readings below are ordinary; the discriminating cases live in lab.yaml.
# ---------------------------------------------------------------------------
set -euo pipefail

BUNDLE=/srv/kestrel/scaler

install -d -o root -g root -m 0755 /srv/kestrel
install -d -o root -g root -m 0755 "$BUNDLE"

cat > "$BUNDLE/README.txt" <<'TXT'
scan-api autoscaler — decision evidence

  readings.txt   one line per scaling window: current target minimum
  decisions.log  what the helper decided for each window, in order

The helper has scaled up plenty of times. Look at how many times it has
scaled down.
TXT

# current target minimum
cat > "$BUNDLE/readings.txt" <<'TXT'
2 5 1
12 11 2
7 7 3
4 2 4
15 10 3
3 8 1
6 4 6
TXT

# What the broken helper actually decided: the rule in the task, applied to
# the values as they arrive — as text. Every line below is what that produces
# (checked by applying it with string comparisons). Four windows are over
# target and all four are held. Two of the holds are right — the current is
# at its minimum — and two are the bug: "12" is not greater than "2", and
# "15" is not greater than "3", when compared character by character.
cat > "$BUNDLE/decisions.log" <<'TXT'
2026-08-24T01:00:00 window=1 current=2 target=5 minimum=1 decision=scale-up
2026-08-24T01:05:00 window=2 current=12 target=11 minimum=2 decision=hold
2026-08-24T01:10:00 window=3 current=7 target=7 minimum=3 decision=hold
2026-08-24T01:15:00 window=4 current=4 target=2 minimum=4 decision=hold
2026-08-24T01:20:00 window=5 current=15 target=10 minimum=3 decision=hold
2026-08-24T01:25:00 window=6 current=3 target=8 minimum=1 decision=scale-up
2026-08-24T01:30:00 window=7 current=6 target=4 minimum=6 decision=hold
2026-08-24T01:35:00 ops: four windows over target and it has never scaled down.
TXT

chown -R root:root "$BUNDLE"
chmod 0444 "$BUNDLE"/README.txt "$BUNDLE"/readings.txt "$BUNDLE"/decisions.log
chmod 0755 "$BUNDLE"

# /home/student/py is the student's to create.
