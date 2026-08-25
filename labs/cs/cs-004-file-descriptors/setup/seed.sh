#!/bin/bash
# ---------------------------------------------------------------------------
# CS-004 baseline — a scan-collector that is mid-leak, and the log of the
# crashes it has already had.
#
# --- What the fixture is ---------------------------------------------------
#
# `scan-collector` holds a listening socket and, for each batch it "processes",
# opens a loopback connection to itself and accepts it — then keeps both ends
# forever. Two descriptors per batch, never released. That is the whole bug,
# and it is the shape a real connection leak takes: the process looks healthy,
# its memory is flat, and its descriptor table quietly fills with sockets.
#
# --- Why it is safe --------------------------------------------------------
#
#   bounded      it stops opening at LEAK_BATCHES batches (2 fds each), well
#                under the soft limit it runs with, so it never actually dies
#                during the lab and never approaches a host-level ceiling;
#   contained    loopback only — the sandbox runs with `--network none`, so
#                there is no interface to reach anything else on;
#   per-session  one container per session, so one student's leak is invisible
#                to every other student;
#   disposable   it is a child of the container's init and dies with it, and
#                Reset replaces the container outright.
#
# --- Why it runs as `student` ----------------------------------------------
#
# /proc/<pid>/fd is readable only by the owner of the process (or root). The
# student is not root in this lab, so a fixture running as root would leave
# them unable to see the very thing they are asked to investigate. Running it
# as the account that owns it is also what a real service does.
#
# --- Why the soft limit is set here and not in the program -----------------
#
# `COLLECTOR_SOFT_LIMIT` is a graded finding, and the student is meant to read
# it out of /proc/<pid>/limits. Setting it here keeps it out of every file the
# student can read: this script runs from a root-only directory that the
# provider empties before the terminal opens, so the number exists only in the
# running process afterwards. Nothing under /usr/local/bin or /var/log
# contains it.
# ---------------------------------------------------------------------------
set -euo pipefail

SOFT_LIMIT=256
LEAK_BATCHES=60

install -d -o root -g root -m 0755 /var/log/kestrel

cat > /usr/local/bin/scan-collector <<'PY'
#!/usr/bin/env python3
"""Kestrel scan-collector — polls the depot scanners and forwards batches.

Deliberately faithful to the bug it models: every batch opens a connection and
nothing ever closes one. There is no counter of descriptors anywhere in here,
and no mention of any limit; both have to be observed from outside.
"""
import socket
import sys
import time

LOG = "/var/log/kestrel/scan-collector.log"
PORT = 9310
BURST = 40
TOTAL = 60


def log(message: str) -> None:
    with open(LOG, "a") as handle:
        handle.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} scan-collector: {message}\n")
        handle.flush()


def main() -> int:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", PORT))
    listener.listen(128)
    log("started; polling depot scanners")

    held = []
    # A couple of spool files, also never closed. Real leaks are rarely pure:
    # the table ends up mixed, and which kind *dominates* is the question.
    for name in ("depot-a", "depot-b"):
        held.append(open(f"/var/log/kestrel/{name}.spool", "a"))

    for batch in range(TOTAL):
        client = socket.create_connection(("127.0.0.1", PORT))
        served, _ = listener.accept()
        held.append((client, served))          # nothing ever closes these
        if batch % 10 == 0:
            log(f"forwarded batch {batch}")
        time.sleep(0.02 if batch < BURST else 3.0)

    log("scanner queue drained; idling until the next window")
    while True:
        time.sleep(5)
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY
chmod 0755 /usr/local/bin/scan-collector

# The crash history. Realistic: the error as Python actually reports it, and
# the two "fixes" that did not work. No graded value appears here.
cat > /var/log/kestrel/scan-collector.log.1 <<'TXT'
2026-08-21T02:14:07 scan-collector: forwarded batch 240
2026-08-21T02:14:41 scan-collector: Traceback (most recent call last):
2026-08-21T02:14:41 scan-collector:   File "/usr/local/bin/scan-collector", line 41, in main
2026-08-21T02:14:41 scan-collector:     client = socket.create_connection(("127.0.0.1", PORT))
2026-08-21T02:14:41 scan-collector: OSError: [Errno 24] Too many open files
2026-08-21T02:14:41 scan-collector: exiting
2026-08-22T01:58:02 ops: raised the limit and restarted. should hold now.
2026-08-23T03:22:19 scan-collector: OSError: [Errno 24] Too many open files
2026-08-23T03:22:19 scan-collector: exiting
2026-08-24T00:41:55 ops: raised the limit again. restarted.
TXT
chmod 0644 /var/log/kestrel/scan-collector.log.1
: > /var/log/kestrel/scan-collector.log
chown student:student /var/log/kestrel/scan-collector.log
chmod 0644 /var/log/kestrel/scan-collector.log
chown student:student /var/log/kestrel
chmod 0755 /var/log/kestrel

# Start it as the student, with its own soft descriptor limit, detached from
# this seed run so it survives as a child of the container's init.
su student -c "ulimit -Sn ${SOFT_LIMIT}; exec setsid nohup /usr/local/bin/scan-collector >/dev/null 2>&1 &" || true

# Give it a moment to bind, open its burst and appear in the process table
# before setup verification looks for it.
sleep 3
