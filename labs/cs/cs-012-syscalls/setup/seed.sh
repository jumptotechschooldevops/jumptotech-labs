#!/bin/bash
# ---------------------------------------------------------------------------
# CS-012 baseline — the label printer that spends its life in the kernel.
#
# --- Why the student inspects their own child, not a seeded process --------
#
# The curriculum plan had the student read /proc/<pid>/syscall for a *seeded*
# blocked process. That does not work, and it was checked rather than assumed:
# reading /proc/<pid>/syscall needs PTRACE_MODE_ATTACH_FSCREDS, so an
# unprivileged student reading a root-owned process gets EPERM —
#
#     $ cat /proc/1/syscall
#     cat: /proc/1/syscall: Permission denied
#
# — while /proc/<pid>/status and /proc/<pid>/io are readable. A seeded process
# would have to run as the student to be inspectable, and even then a host with
# Yama ptrace_scope=1 would only allow a *descendant*. So the process the
# student inspects is one they fork themselves: same user, same session, and a
# descendant, which is the only combination that works everywhere.
#
# No strace (it is not in the image), no SYS_PTRACE (it is not grantable), no
# added capability of any kind. Verified under --cap-drop ALL plus the standard
# Linux sandbox set.
#
# --- Why the syscall table is derived rather than shipped ------------------
#
# Syscall numbers are per-architecture: `read` is 63 on aarch64 and 0 on
# x86_64. Shipping a table would mean shipping numbers for machines this was
# never run on. Instead the table is *observed* here, at seed time, by putting
# a child into each call and reading the number back — so it is correct by
# construction on whatever architecture the sandbox is running, and the seed
# fails loudly rather than teaching a wrong number.
# ---------------------------------------------------------------------------
set -euo pipefail

BUNDLE=/srv/kestrel/printer

install -d -o root -g root -m 0755 /srv/kestrel
install -d -o root -g root -m 0755 "$BUNDLE"

cat > "$BUNDLE/README.txt" <<'TXT'
kestrel label printer

  print-labels.py    the printer as it runs in production
  syscall-table.txt  syscall numbers on this machine, for decoding /proc

The printer service sits at about 60% CPU, and almost all of it is system
time rather than user time. It is not computing anything expensive. The
profiler shows nothing, because there is nothing in user space to see.

Syscall numbers are not portable. The table here was generated on this
machine; the same names have different numbers elsewhere.
TXT

# The printer as it runs in production: one write syscall per label line.
cat > "$BUNDLE/print-labels.py" <<'PY'
#!/usr/bin/env python3
"""Kestrel label printer — writes each label line straight through."""
import os
import sys


def main():
    count = int(sys.argv[1])
    fd = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    for number in range(count):
        os.write(fd, f"KL{8800 + number} leeds parcel-label\n".encode())
    os.close(fd)
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY
chmod 0555 "$BUNDLE/print-labels.py"

# --- the syscall table, observed on this machine ---------------------------
python3 - "$BUNDLE/syscall-table.txt" <<'PY'
"""Put a child into each blocking call and read its syscall number back."""
import os
import select
import sys
import threading
import time

def number_for(enter):
    kid = os.fork()
    if kid == 0:
        try:
            enter()
        finally:
            os._exit(0)
    found = None
    for _ in range(400):
        time.sleep(0.005)
        try:
            state = open(f"/proc/{kid}/stat").read().rsplit(")", 1)[1].split()[0]
            if state == "S":
                found = open(f"/proc/{kid}/syscall").read().split()[0]
                break
        except (FileNotFoundError, IndexError):
            break
    os.kill(kid, 9)
    os.waitpid(kid, 0)
    return found

read_fd, write_fd = os.pipe()

def waiting_parent():
    kid = os.fork()
    if kid == 0:
        time.sleep(30)
        os._exit(0)
    os.waitpid(kid, 0)

def blocked_thread():
    lock = threading.Lock()
    lock.acquire()
    lock.acquire()

table = {
    "read": number_for(lambda: os.read(read_fd, 1)),
    "clock_nanosleep": number_for(lambda: time.sleep(30)),
    "pselect6": number_for(lambda: select.select([read_fd], [], [], 30)),
    "wait4": number_for(waiting_parent),
    "futex": number_for(blocked_thread),
}

# The lab decodes a blocked reader, so `read` is the entry that must be right.
# Everything else is context; a missing one is still a seeding failure.
missing = sorted(name for name, value in table.items() if value is None)
if missing:
    sys.exit(f"seed: could not observe syscall numbers for: {', '.join(missing)}")

with open(sys.argv[1], "w", encoding="utf-8") as out:
    out.write(f"# syscall numbers as observed on this machine ({os.uname().machine})\n")
    out.write("# these numbers are per-architecture and are not portable\n")
    out.write("# number  name\n")
    for name, value in sorted(table.items(), key=lambda pair: int(pair[1])):
        out.write(f"{value}  {name}\n")
PY

chown root:root "$BUNDLE"/*
chmod 0444 "$BUNDLE"/README.txt "$BUNDLE"/syscall-table.txt
chmod 0555 "$BUNDLE"/print-labels.py
chmod 0755 "$BUNDLE"

# The table is the thing the lab is decoded against, so a seed that produced a
# table without `read` in it has not seeded the lab.
grep -qE '^[0-9]+  read$' "$BUNDLE/syscall-table.txt" || {
    echo "seed: the syscall table has no 'read' entry" >&2
    exit 1
}

# /home/student/py and /home/student/ops are the student's to create.
