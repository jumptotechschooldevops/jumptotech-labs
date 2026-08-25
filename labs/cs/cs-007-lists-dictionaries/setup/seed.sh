#!/bin/bash
# ---------------------------------------------------------------------------
# CS-007 baseline — a night of scan events, and a second smaller batch.
#
# The main log is arranged so that the obvious-but-wrong implementation gets a
# visibly wrong answer:
#
#   · manchester and bristol finish on the same count, and manchester appears
#     first in the file. Sorting by count alone leaves them in insertion order,
#     so manchester comes out ahead — the tie-break by name is what puts
#     bristol first, and nothing except the ranking reveals whether it was
#     applied;
#   · three lines are unusable — one blank, one truncated mid-record, one from
#     a scanner that never reported a depot. A count that includes them is
#     wrong in a way no single depot's number shows.
#
# The second batch exists so a program cannot remember one answer: it has
# different depots, different counts and a different ranking.
#
# No expected value appears anywhere on disk. The counts have to be counted,
# the ranking has to be derived, and both live in lab.yaml on the API host.
# The student is not root and cannot reach it.
# ---------------------------------------------------------------------------
set -euo pipefail

BUNDLE=/srv/kestrel/scans

install -d -o root -g root -m 0755 /srv/kestrel
install -d -o root -g root -m 0755 "$BUNDLE"

cat > "$BUNDLE/README.txt" <<'TXT'
scan events — one line per parcel scan

  scan-events.log         last night's batch
  scan-events-small.log   the afternoon re-run, kept for comparison

A usable line names the depot that recorded the scan. Some lines are not
usable: the collector truncates on restart and one scanner has been shipping
records with no depot field since it was re-imaged.

Ops wants to know which depots are busiest, and they want the same answer
every time they ask.
TXT

cat > "$BUNDLE/scan-events.log" <<'TXT'
2026-08-24T22:03:11Z depot=leeds scanner=sc-04 parcel=KL8842 status=ok
2026-08-24T22:03:19Z depot=manchester scanner=sc-11 parcel=KL8843 status=ok
2026-08-24T22:03:24Z depot=leeds scanner=sc-04 parcel=KL8844 status=ok
2026-08-24T22:03:31Z scanner=sc-77 parcel=KL8845 status=ok
2026-08-24T22:03:38Z depot=bristol scanner=sc-02 parcel=KL8846 status=ok
2026-08-24T22:03:44Z depot=manchester scanner=sc-11 parcel=KL8847 status=ok
2026-08-24T22:03:51Z depot=leeds scanner=sc-05 parcel=KL8848 status=ok
2026-08-24T22:03:58Z depot=cardiff scanner=sc-09 parcel=KL8849 status=ok

2026-08-24T22:04:05Z depot=bristol scanner=sc-02 parcel=KL8850 status=ok
2026-08-24T22:04:11Z depot=manchester scanner=sc-12 parcel=KL8851 status=ok
2026-08-24T22:04:18Z depot=leeds scanner=sc-04 parcel=KL8852 status=ok
2026-08-24T22:04:24Z depot=bristol scanner=sc-03 parcel=KL8853 status=ok
2026-08-24T22:04:31Z depot=manchester scanner=sc-11 parcel=KL8854 status=ok
2026-08-24T22:04:37Z depot=leeds scanner=sc-05 parcel=KL8855 status=ok
2026-08-24T22:04:44Z depot=cardiff scanner=sc-09 parcel=KL8856 status=ok
2026-08-24T22:04:5
2026-08-24T22:04:58Z depot=bristol scanner=sc-02 parcel=KL8858 status=ok
2026-08-24T22:05:04Z depot=manchester scanner=sc-12 parcel=KL8859 status=ok
2026-08-24T22:05:11Z depot=leeds scanner=sc-04 parcel=KL8860 status=ok
2026-08-24T22:05:18Z depot=bristol scanner=sc-03 parcel=KL8861 status=ok
2026-08-24T22:05:24Z depot=leeds scanner=sc-05 parcel=KL8862 status=ok
2026-08-24T22:05:31Z depot=manchester scanner=sc-11 parcel=KL8863 status=ok
2026-08-24T22:05:38Z depot=cardiff scanner=sc-09 parcel=KL8864 status=ok
2026-08-24T22:05:44Z depot=leeds scanner=sc-04 parcel=KL8865 status=ok
2026-08-24T22:05:51Z depot=bristol scanner=sc-02 parcel=KL8866 status=ok
2026-08-24T22:05:58Z depot=manchester scanner=sc-12 parcel=KL8867 status=ok
2026-08-24T22:06:04Z depot=leeds scanner=sc-05 parcel=KL8868 status=ok
2026-08-24T22:06:11Z depot=bristol scanner=sc-03 parcel=KL8869 status=ok
TXT

cat > "$BUNDLE/scan-events-small.log" <<'TXT'
2026-08-25T14:00:02Z depot=cardiff scanner=sc-09 parcel=MR1101 status=ok
2026-08-25T14:00:09Z depot=york scanner=sc-21 parcel=MR1102 status=ok
2026-08-25T14:00:15Z scanner=sc-77 parcel=MR1103 status=ok
2026-08-25T14:00:22Z depot=york scanner=sc-21 parcel=MR1104 status=ok
2026-08-25T14:00:28Z depot=cardiff scanner=sc-09 parcel=MR1105 status=ok
2026-08-25T14:00:35Z depot=york scanner=sc-22 parcel=MR1106 status=ok
TXT

chown -R root:root "$BUNDLE"
chmod 0444 "$BUNDLE"/README.txt "$BUNDLE"/scan-events.log "$BUNDLE"/scan-events-small.log
chmod 0755 "$BUNDLE"

# /home/student/py and /home/student/ops are the student's to create.
