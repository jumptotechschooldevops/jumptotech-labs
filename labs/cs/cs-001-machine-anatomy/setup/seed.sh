#!/bin/bash
# ---------------------------------------------------------------------------
# CS-001 baseline — the diagnostic capture from `kestrel-scan-01`.
#
# The lab's premise is that the host being investigated is gone and all that
# survives is what its monitoring agent uploaded: a handful of files copied
# straight out of /proc, plus a `df` listing. This script plants exactly that.
#
# Everything here is original JumpToTech content in the *format* the Linux
# kernel uses, documented in proc(5). It is not a copy of any real machine's
# output, and it is not derived from any third-party training material.
#
# Three deliberate properties, each of which the lab's grading depends on:
#
#   1. **The numbers are chosen so every answer is exact.** MemTotal is
#      16266528 kB, which is 15885 MiB and 16656 MB when truncated to whole
#      units; the 1-minute load average is 24.00 across 8 processors, which is
#      exactly 3 per processor. A student can reach every graded value with
#      `expr`, which truncates — so there is no rounding convention to guess.
#
#   2. **`MemAvailable` is deliberately absent from the capture.** The lab also
#      asks the student to capture *this* machine's /proc/meminfo, and that
#      check requires `MemAvailable:` — a field every kernel since 3.14 emits.
#      Copying this file into the answer therefore cannot satisfy it. The
#      README below states the capture is partial, so this is a stated property
#      of the scenario rather than a trick.
#
#   3. **No file states a graded answer.** The processor count must be counted,
#      the memory converted, the load divided, the full filesystem read out of a
#      Use% column. Nothing here can be grepped for the answer.
#
# The capture is owned by root and world-readable: the student is investigating
# evidence, not editing it. Nothing in the lab asks them to write here, and
# nothing they could write here would help them pass.
# ---------------------------------------------------------------------------
set -euo pipefail

BUNDLE=/srv/kestrel/scan-01

install -d -o root -g root -m 0755 /srv/kestrel
install -d -o root -g root -m 0755 "$BUNDLE"

# --- what the capture is, in the agent's own words -------------------------
cat > "$BUNDLE/README.txt" <<'TXT'
kestrel-scan-01 — diagnostic capture
uploaded by the node agent at 03:11:44, 27 seconds before the host stopped
responding.

The agent copies a fixed set of kernel files and one storage summary. It is a
partial capture by design: it records the fields the on-call rota asked for and
nothing else, because the upload has to finish before the host goes away.

Contents:
  proc-cpuinfo.txt   verbatim copy of /proc/cpuinfo
  proc-meminfo.txt   selected fields from /proc/meminfo
  proc-loadavg.txt   verbatim copy of /proc/loadavg
  proc-uptime.txt    verbatim copy of /proc/uptime
  df-h.txt           output of `df -h`

This host is not reachable. This capture is the only evidence there is.
TXT

# --- /proc/cpuinfo: eight logical processors -------------------------------
# One block per logical CPU, in the layout proc(5) describes. No line in this
# file contains the word "processor" other than the field itself, so counting
# them is a straight `grep -c`.
: > "$BUNDLE/proc-cpuinfo.txt"
for cpu in 0 1 2 3 4 5 6 7; do
  cat >> "$BUNDLE/proc-cpuinfo.txt" <<TXT
processor	: ${cpu}
vendor_id	: GenuineIntel
cpu family	: 6
model		: 79
model name	: Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz
stepping	: 1
cpu MHz		: 2394.455
cache size	: 35840 KB
physical id	: 0
siblings	: 8
core id		: ${cpu}
cpu cores	: 8
fpu		: yes
cpuid level	: 20
wp		: yes
clflush size	: 64
cache_alignment	: 64
address sizes	: 46 bits physical, 48 bits virtual

TXT
done

# --- /proc/meminfo: partial, and in the units proc(5) documents ------------
# The `kB` suffix in this file is 1024 bytes, not 1000 — the convention that
# makes MiB and MB differ, which is the point of the conversion the lab asks
# for. MemAvailable is absent; see property 2 in the header.
cat > "$BUNDLE/proc-meminfo.txt" <<'TXT'
MemTotal:       16266528 kB
MemFree:          412884 kB
Buffers:          128440 kB
Cached:          3204112 kB
SwapTotal:       4194300 kB
SwapFree:              0 kB
Dirty:             12488 kB
Writeback:             0 kB
TXT

# --- /proc/loadavg: 24.00 over eight processors ---------------------------
# Fields, per proc(5): 1/5/15-minute load averages, then runnable/total
# scheduling entities, then the most recently created PID.
cat > "$BUNDLE/proc-loadavg.txt" <<'TXT'
24.00 21.35 18.92 9/1183 28471
TXT

cat > "$BUNDLE/proc-uptime.txt" <<'TXT'
1893421.55 14832910.22
TXT

# --- df -h: /var is out of space ------------------------------------------
# No mount point here is a prefix of another, so "the full one" has exactly one
# unambiguous spelling.
cat > "$BUNDLE/df-h.txt" <<'TXT'
Filesystem      Size  Used Avail Use% Mounted on
/dev/nvme0n1p2   40G   12G   26G  32% /
/dev/nvme0n1p1  511M   62M  450M  13% /boot
/dev/nvme0n1p3   50G   50G     0 100% /var
tmpfs           7.8G     0  7.8G   0% /dev/shm
TXT

# Evidence is read-only. The student owns their own home; they do not own this.
chown -R root:root "$BUNDLE"
chmod 0444 "$BUNDLE"/*.txt
chmod 0755 "$BUNDLE"

# `/home/student/ops` is deliberately NOT created here. Making the directory
# they are going to work in is the student's first act on the machine.
