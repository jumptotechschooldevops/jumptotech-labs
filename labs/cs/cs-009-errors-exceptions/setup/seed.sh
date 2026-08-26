#!/bin/bash
# ---------------------------------------------------------------------------
# CS-009 baseline — the reconciliation that has succeeded every night for
# three weeks without reconciling anything.
#
# The seeded script wraps its whole body in `except: pass` and returns 0 on
# every path. It is read-only, in the repository directory, and the student
# writes their corrected version in their own home.
#
# --- How "catch narrowly" is graded without reading the source -------------
#
# Four ledger paths are handed to the student's program, and one of them is a
# *directory*. Opening it raises IsADirectoryError, which is not a missing file
# and not a malformed record — so a program that catches narrowly lets it
# escape and dies with a traceback and status 1, while a program that wrote
# `except Exception` reports one of its own error codes instead and is caught
# by the exit status.
#
# That makes over-broad catching a behavioural failure rather than a source
# pattern to grep for, which is the difference between grading understanding
# and grading typing.
#
# The directory is created here rather than being a checked-in file, because a
# directory cannot be committed as one.
# ---------------------------------------------------------------------------
set -euo pipefail

BUNDLE=/srv/kestrel/ledger

install -d -o root -g root -m 0755 /srv/kestrel
install -d -o root -g root -m 0755 "$BUNDLE"

cat > "$BUNDLE/README.txt" <<'TXT'
nightly ledger reconciliation

  reconcile.py        the job as it runs in production tonight
  ledger-2026-08-24   last night's ledger: parcel,depot,pence
  ledger-torn         the ledger from the night the collector restarted
  ledger-archive/     where completed ledgers are moved

The job has exited successfully every night for three weeks. The ledger has
not reconciled once. Nobody has seen an error message, because there has not
been one.
TXT

# The job as it runs in production: every failure swallowed, every exit zero.
cat > "$BUNDLE/reconcile.py" <<'PY'
#!/usr/bin/env python3
"""Nightly ledger reconciliation."""
import sys


def main():
    try:
        total = 0
        count = 0
        with open(sys.argv[1]) as handle:
            for line in handle:
                parcel, depot, pence = line.strip().split(",")
                total += int(pence)
                count += 1
        print(f"RECONCILED={count} TOTAL={total}")
    except:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY
chmod 0555 "$BUNDLE/reconcile.py"

# Last night's ledger: every record well formed.
cat > "$BUNDLE/ledger-2026-08-24" <<'TXT'
KL8842,leeds,1250
KL8843,manchester,899
KL8844,leeds,2400
KL8845,bristol,175
KL8846,cardiff,3120
KL8847,manchester,640
TXT

# The night the collector restarted: one record lost its amount.
cat > "$BUNDLE/ledger-torn" <<'TXT'
KL9001,leeds,1400
KL9002,bristol,275
KL9003,manchester,n/a
KL9004,cardiff,880
TXT

# A directory, not a ledger. Opening it is neither a missing file nor a bad
# record, and that is the point.
install -d -o root -g root -m 0755 "$BUNDLE/ledger-archive"

chown root:root "$BUNDLE"/README.txt "$BUNDLE"/ledger-2026-08-24 "$BUNDLE"/ledger-torn
chmod 0444 "$BUNDLE"/README.txt "$BUNDLE"/ledger-2026-08-24 "$BUNDLE"/ledger-torn
chmod 0755 "$BUNDLE"

# /home/student/py and /home/student/ops are the student's to create.
