#!/bin/bash
# ---------------------------------------------------------------------------
# CS-013 baseline — the scan-ingest worker that got slower when it was given
# more threads.
#
# --- Why this lab grades counters and not a stopwatch ----------------------
#
# The curriculum plan graded a `FASTEST=<mode>` verdict from a three-way race
# between serial, threaded and multi-process runs. That was measured here
# before it was written, and it does not survive a busy machine:
#
#   load  0.5-CPU sandbox, serial/threaded ratio, CPU-bound : 1.79 0.61 0.84 0.71
#   load  0.5-CPU sandbox, serial/threaded ratio, I/O-bound : 10.6 2.48 4.00 5.45
#
# Those two bands nearly touch, so any threshold between them fails honest work
# on a contended host. The sandbox is also capped at 0.5 CPU, which makes the
# plan's expected answer wrong in a second way: extra processes cannot run in
# parallel at all here, so `serial` won every CPU-bound race.
#
# The counters, measured at load 37, were exact every single time:
#
#   n sleeps            -> exactly n voluntary context switches (5, 12, 37)
#   pure computation    -> exactly 0 voluntary context switches
#   n live threads      -> /proc/self/status Threads: is exactly n+1
#   cgroup cpu.max      -> 0.5, while os.cpu_count() reports the host's 10
#
# So the lab grades the mechanism rather than the race: blocking is what
# produces a voluntary switch, threads are what the kernel counts, and the CPU
# a container may use is not the CPU count its runtime reports. That last gap
# is the actual production bug in the story.
# ---------------------------------------------------------------------------
set -euo pipefail

BUNDLE=/srv/kestrel/ingest

install -d -o root -g root -m 0755 /srv/kestrel
install -d -o root -g root -m 0755 "$BUNDLE"

cat > "$BUNDLE/README.txt" <<'TXT'
kestrel scan-ingest worker

  scan-ingest.py   the worker as it runs in production

The worker computes a checksum for every scan block it receives. Throughput
was short, so the pool size was doubled. Latency got worse, and doubling it
again made it worse still.

The pool is sized from the number of CPUs the runtime reports. Nobody checked
what the container is actually allowed to use.
TXT

# The worker as it runs in production. The pool is sized from os.cpu_count(),
# which reports the machine's CPUs and knows nothing about the cgroup this
# process is confined to.
cat > "$BUNDLE/scan-ingest.py" <<'PY'
#!/usr/bin/env python3
"""Kestrel scan-ingest worker — checksums every block it is handed."""
import hashlib
import os
import sys
from concurrent.futures import ThreadPoolExecutor

# "Use all the CPUs." The container is not allowed all of them.
POOL_SIZE = (os.cpu_count() or 1) * 2


def checksum(block):
    digest = hashlib.sha256()
    for _ in range(50_000):
        digest.update(block)
    return digest.hexdigest()


def main():
    blocks = [f"scan-block-{n}".encode() for n in range(int(sys.argv[1]))]
    with ThreadPoolExecutor(max_workers=POOL_SIZE) as pool:
        for _ in pool.map(checksum, blocks):
            pass
    print(f"INGESTED={len(blocks)} POOL={POOL_SIZE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY
chmod 0555 "$BUNDLE/scan-ingest.py"

chown root:root "$BUNDLE"/*
chmod 0444 "$BUNDLE"/README.txt
chmod 0555 "$BUNDLE"/scan-ingest.py
chmod 0755 "$BUNDLE"

# /home/student/py and /home/student/ops are the student's to create.
