#!/bin/bash
# ---------------------------------------------------------------------------
# CS-003 baseline — the two address batches the importer chokes on.
#
# `batch-1.txt` is the failing batch. It is built so that the line with the
# most *characters* and the line with the most *bytes* are different lines —
# which is the whole discovery, and cannot be seen without measuring both.
# `batch-2.txt` is a second, smaller batch: the lab grades the student's
# program against both, so a program that hard-codes one batch's answers fails
# on the other.
#
# The content is deliberately ordinary address data, in four scripts:
#   · pure ASCII (one byte per character)
#   · Latin-1 letters with diacritics (two bytes each in UTF-8)
#   · CJK (three bytes each in UTF-8)
#
# Nothing here states a graded answer. Character counts, byte counts, totals
# and the two "longest" line numbers all have to be measured, and the hex
# spellings the findings ask for come from bytes the student produces with
# `printf`, not from anything on disk.
#
# The files are root-owned and world-readable: evidence to read, not edit. The
# student cannot become root in this lab (`unprivileged_shell`), so they cannot
# rewrite them — and rewriting them would not help, because every expected
# value lives in lab.yaml, outside the sandbox entirely.
# ---------------------------------------------------------------------------
set -euo pipefail

BUNDLE=/srv/kestrel/import

install -d -o root -g root -m 0755 /srv/kestrel
install -d -o root -g root -m 0755 "$BUNDLE"

cat > "$BUNDLE/README.txt" <<'TXT'
scan-api address import — failing batches

Each address line is forwarded to the delivery partner's API, whose address
field accepts at most 20 bytes. The importer rejects anything the field will
not hold.

Overnight it rejected a line that is one of the *shortest* in the file, while
much longer-looking lines went through untouched.

  batch-1.txt   the overnight batch, including the rejected line
  batch-2.txt   the small batch the team re-runs to sanity-check the importer

Nobody has measured anything yet.
TXT

# The failing batch. Four scripts, on purpose.
cat > "$BUNDLE/batch-1.txt" <<'TXT'
Manchester England
Zürich Schweiz
São Paulo Brasil
東京都千代田区丸の内 日本
TXT

# The sanity-check batch: different data, so a hard-coded answer cannot pass.
cat > "$BUNDLE/batch-2.txt" <<'TXT'
Leeds England
Málaga España
TXT

chown -R root:root "$BUNDLE"
chmod 0444 "$BUNDLE"/README.txt "$BUNDLE"/batch-1.txt "$BUNDLE"/batch-2.txt
chmod 0755 "$BUNDLE"

# `/home/student/py` and `/home/student/ops` are the student's to create.
