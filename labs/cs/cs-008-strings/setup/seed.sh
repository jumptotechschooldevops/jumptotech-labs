#!/bin/bash
# ---------------------------------------------------------------------------
# CS-008 baseline — a request log whose messages fight the parser.
#
# The log is ordinary until you try to split it. Every line is
#
#   <timestamp> level=<level> req=<id> dur_ms=<n> path=<path> msg="<free text>"
#
# and the trouble is entirely in the last field:
#
#   · messages contain spaces, so splitting the line on whitespace scatters
#     one field across several;
#   · one message contains `fallback=disabled`, so building a dict from
#     `key=value` pairs invents a field that was never logged;
#   · one message contains `dur_ms=99999`, so a parser that searches the whole
#     line for a duration finds the wrong one — and it is on a line whose real
#     duration matters to the answer;
#   · one message is not ASCII, which is CS-003 arriving in a log file;
#   · one message contains an apostrophe and a comma, because real messages do.
#
# A naive parser does not crash on these. It silently produces a smaller,
# wrong answer — which is why the lab asks for a count of what was dropped and
# insists it be zero.
#
# The second log has different content and different totals, so one remembered
# answer cannot satisfy both. No expected value appears on disk: totals have to
# be counted and the ranking derived, and both live in lab.yaml on the API
# host, out of a non-root student's reach.
# ---------------------------------------------------------------------------
set -euo pipefail

BUNDLE=/srv/kestrel/requests

install -d -o root -g root -m 0755 /srv/kestrel
install -d -o root -g root -m 0755 "$BUNDLE"

cat > "$BUNDLE/README.txt" <<'TXT'
scan-api request log

Every line has the same six fields, the last of which is a quoted free-text
message written by whichever component logged it:

  <timestamp> level=<level> req=<id> dur_ms=<n> path=<path> msg="<text>"

The current parser reports roughly two per cent fewer lines than the file
contains, and the ones it loses are never the boring ones.
TXT

cat > "$BUNDLE/requests.log" <<'TXT'
2026-08-25T09:14:01Z level=info req=R-1001 dur_ms=42 path=/api/parcels msg="ok"
2026-08-25T09:14:02Z level=info req=R-1002 dur_ms=88 path=/api/parcels msg="ok"
2026-08-25T09:14:03Z level=error req=R-1003 dur_ms=1840 path=/api/track msg="upstream timeout after 3 retries"
2026-08-25T09:14:04Z level=info req=R-1004 dur_ms=61 path=/api/depots msg="ok"
2026-08-25T09:14:05Z level=warn req=R-1005 dur_ms=940 path=/api/track msg="slow upstream, fallback=disabled"
2026-08-25T09:14:06Z level=info req=R-1006 dur_ms=37 path=/api/parcels msg="ok"
2026-08-25T09:14:07Z level=error req=R-1007 dur_ms=2210 path=/api/track msg="scanner sc-04 didn't respond, giving up"
2026-08-25T09:14:08Z level=info req=R-1008 dur_ms=55 path=/api/depots msg="ok"
2026-08-25T09:14:09Z level=info req=R-1009 dur_ms=73 path=/api/parcels msg="ok"
2026-08-25T09:14:10Z level=error req=R-1010 dur_ms=1495 path=/api/depots msg="depot Zürich unreachable"
2026-08-25T09:14:11Z level=info req=R-1011 dur_ms=64 path=/api/parcels msg="ok"
2026-08-25T09:14:12Z level=warn req=R-1012 dur_ms=1180 path=/api/track msg="retry scheduled, upstream reported dur_ms=99999 which is nonsense"
2026-08-25T09:14:13Z level=info req=R-1013 dur_ms=48 path=/api/depots msg="ok"
2026-08-25T09:14:14Z level=info req=R-1014 dur_ms=92 path=/api/parcels msg="ok"
2026-08-25T09:14:15Z level=error req=R-1015 dur_ms=760 path=/api/track msg="upstream returned 503"
2026-08-25T09:14:16Z level=info req=R-1016 dur_ms=39 path=/api/parcels msg="ok"
TXT

cat > "$BUNDLE/requests-quiet.log" <<'TXT'
2026-08-25T15:00:01Z level=info req=Q-2001 dur_ms=31 path=/api/parcels msg="ok"
2026-08-25T15:00:02Z level=error req=Q-2002 dur_ms=610 path=/api/track msg="upstream timeout, retry=1"
2026-08-25T15:00:03Z level=info req=Q-2003 dur_ms=44 path=/api/depots msg="ok"
2026-08-25T15:00:04Z level=info req=Q-2004 dur_ms=57 path=/api/parcels msg="ok"
2026-08-25T15:00:05Z level=warn req=Q-2005 dur_ms=305 path=/api/track msg="slow, but within budget"
TXT

chown -R root:root "$BUNDLE"
chmod 0444 "$BUNDLE"/README.txt "$BUNDLE"/requests.log "$BUNDLE"/requests-quiet.log
chmod 0755 "$BUNDLE"

# /home/student/py is the student's to create.
