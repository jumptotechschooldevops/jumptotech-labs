# CS-001 — manual test procedure (browser terminal)

Run this against the real JumpToTech UI to confirm CS-001 behaves the way the
automated suites say it does. Every step below was first executed against a real
container with the real verifier; the expected results are what was actually
observed, not predictions.

**Nothing in this procedure needs a code change, a new provider, or a new
requirement type.**

---

## A. Isolated test environment — read this before running anything

CS-001 runs on the **existing** Linux sandbox image, unchanged. It adds no
package and needs no change to any shared file.

Two facts make the obvious route unsafe on this machine, both of which are worth
checking before every run:

1. **`jumptotech/lab-linux:latest` may not exist on a developer machine.** Other
   worktrees commonly build the same image under their own private tags, which
   do not satisfy the provider's default. Check with
   `docker image inspect jumptotech/lab-linux:latest`.
2. **A shared stack may be running and serving a different worktree.** Check
   with `docker inspect jumptotech-api --format '{{range .Mounts}}{{.Source}}{{end}}'`:
   if it bind-mounts another checkout's `labs/`, that instance has no `labs/cs`
   in it and cannot see CS-001 at all.

`npm run sandbox:build` is therefore **not** the command to use: it writes the
shared tags `jumptotech/lab-linux:latest` *and* `jumptotech/lab-terraform:latest`
(`scripts/sandbox-build.sh`), and other worktrees are actively using them.

Instead, run CS-001 against a **private image and a private API/terminal pair**,
leaving every shared tag and every running shared service untouched.

### A.1 Build the private sandbox image

```bash
cd ~/jumptotech-cs
docker build -f infrastructure/docker/sandbox-linux.Dockerfile \
  -t jumptotech/lab-linux:cs001-e2e .
```

No shared tag is written. This worktree's `sandbox-linux.Dockerfile` is
unmodified and identical to `ab7aa06`.

### A.2 Start a private API and terminal from this worktree

Ports 4000/4001/3000 belong to the running shared stack, so the private pair
uses 4100/4101/5174. `LABS_DIR` defaults to this worktree's `labs/`, which is
the point — it is the only copy that contains `labs/cs`.

```bash
# Generate a throwaway secret for this run; both services must share it.
export JTT_E2E_SECRET="$(openssl rand -hex 32)"

# Terminal 1 — private API
cd ~/jumptotech-cs
API_PORT=4100 \
LINUX_SANDBOX_IMAGE=jumptotech/lab-linux:cs001-e2e \
TERRAFORM_PROVIDER_ENABLED=false \
DOCKER_TRACK_ENABLED=false \
CLEANUP_INTERVAL_SECONDS=86400 \
MAX_SESSION_MINUTES=120 \
IDLE_TIMEOUT_MINUTES=90 \
ALLOWED_ORIGINS=http://localhost:5174,http://127.0.0.1:5174 \
DEV_STUDENT_HEADER_ENABLED=true \
INTERNAL_SERVICE_SECRET="$JTT_E2E_SECRET" \
npm run dev:api

# Terminal 2 — private terminal service
cd ~/jumptotech-cs
TERMINAL_PORT=4101 \
INTERNAL_SERVICE_SECRET="$JTT_E2E_SECRET" \
npm run dev:terminal

# Terminal 3 — private web UI, proxied at the private pair
cd ~/jumptotech-cs
VITE_DEV_API_PROXY=http://127.0.0.1:4100 \
VITE_DEV_TERMINAL_PROXY=http://127.0.0.1:4101 \
npm run dev:web -- --port 5174
```

Why each non-obvious setting is there:

| Setting | Reason |
|---|---|
| `CLEANUP_INTERVAL_SECONDS=86400` | **The important one.** The reaper's orphan sweep enumerates *every* managed container on the shared Docker daemon, so a second reaper could delete another worktree's expired sandboxes. `Reaper.start()` schedules with `setInterval` and performs **no sweep at startup**, so a 24-hour interval means this instance's reaper never fires during the test. |
| `MAX_SESSION_MINUTES=120` | The *shared* API's reaper (60 s interval) skips any sandbox whose `expires` label is still in the future, so a generous session lifetime keeps the CS-001 sandbox out of its reach for the whole run. |
| `TERRAFORM_PROVIDER_ENABLED=false`, `DOCKER_TRACK_ENABLED=false` | Nothing in CS-001 needs them; not registering them removes any chance of touching another track's substrate. |
| no `DATABASE_URL` | The API falls back to the in-memory progress store and says so on `/health`, so the shared `jumptotech-postgres` is never written to. **Consequence: step O tests progress recording, not persistence across a restart.** To test real persistence instead, point `DATABASE_URL` at a *separate database* on the shared instance — never at the shared one. |

### A.3 Do not run these while testing

- `npm run sandbox:build` — writes shared image tags.
- `npm run sandbox:clean` — `docker rm -f` on **every** container labelled
  `jumptotech.io/managed=true`, daemon-wide. It would destroy other worktrees'
  live sandboxes as well as this one. Coordinate before anyone runs it.

## B. Start the lab

1. Open <http://localhost:5174> (the private web UI from A.2 — **not** the shared
   stack on :3000).
2. The catalog should now show **five** tracks, with **Computer Science
   Fundamentals** first (it declares `order: 5`; Kubernetes is 10, Docker 20).
3. Open **CS-001 — What a Machine Actually Is** and click **Start Lab**.
4. Wait for the terminal to attach. Setup verification must pass before you are
   let in; if the capture failed to land you will be told the environment is
   broken rather than blamed for it.

---

## C. Inspect the initial state

In the browser terminal:

```bash
hostname                      # expect: jumptotech-lab
whoami                        # expect: student
ls -A ~                       # expect: only dotfiles — no ops/ directory
ls -l /srv/kestrel/scan-01    # expect: six root-owned, read-only files
cat /srv/kestrel/scan-01/README.txt
```

Expected: the capture is present and read-only (`-r--r--r-- root root`), and
your home directory is empty. **Creating the working directory is the student's
first act — the lab does not create it.**

---

## D. Check Solution before solving

Click **Check**.

**Expected: FAIL — 0 of 11 checks passing.** All eleven should report; none
should be skipped. Confirm no failure message tells you an answer.

---

## E. The student exercise

This is the solution, for your verification only — it is not shown to students,
and any method that produces the same findings passes.

```bash
mkdir -p ~/ops/live
cat /proc/meminfo > ~/ops/live/meminfo

# scan-01, from the capture
grep -c processor /srv/kestrel/scan-01/proc-cpuinfo.txt      # 8
awk '/^MemTotal:/ {print $2}' /srv/kestrel/scan-01/proc-meminfo.txt   # 16266528
expr 16266528 / 1024                                          # 15885  (MiB)
expr 16266528 \* 1024 / 1000000                               # 16656  (MB)
cut -d' ' -f1 /srv/kestrel/scan-01/proc-loadavg.txt           # 24.00
expr 24 / 8                                                   # 3      (per CPU)
awk '$5=="100%" {print $6}' /srv/kestrel/scan-01/df-h.txt     # /var

# this machine, for the host-vs-container question
grep '^MemTotal:' /proc/meminfo          # the HOST's RAM — many GB
cat /sys/fs/cgroup/memory.max            # 536870912 — this container's 512 MiB

cat > ~/ops/machine.txt <<'EOF'
HOSTNAME=jumptotech-lab
MEMINFO_SCOPE=host
SCAN01_CPUS=8
SCAN01_MEM_MIB=15885
SCAN01_MEM_MB=16656
SCAN01_LOAD_PER_CPU=3
SCAN01_FULL_MOUNT=/var
VERDICT=saturated
EOF
```

The contrast in the two live commands is the lesson: `/proc/meminfo` reports
several gigabytes while the cgroup ceiling is 512 MiB. The file is describing
the host, which is why `free -m` misleads inside every container.

---

## F. Inspect the resulting state

```bash
cat ~/ops/machine.txt
head -3 ~/ops/live/meminfo
grep -c '^MemAvailable:' ~/ops/live/meminfo    # expect: 1
```

---

## G. Check Solution

**Expected: PASS — 11 of 11.**

---

## H. Break it

```bash
rm -f ~/ops/live/meminfo
sed -i 's/SCAN01_MEM_MB=16656/SCAN01_MEM_MB=15885/' ~/ops/machine.txt
```

(The second edit is the classic error the lab exists to correct: giving the same
memory the same number in both unit systems.)

---

## I. Check Solution

**Expected: FAIL — 8 of 11**, failing exactly:

- This machine's memory information has been captured
- The captured file came from this machine's own kernel
- The report records the same memory in MB

---

## J. Repair

```bash
cat /proc/meminfo > ~/ops/live/meminfo
sed -i 's/SCAN01_MEM_MB=15885/SCAN01_MEM_MB=16656/' ~/ops/machine.txt
```

---

## K. Check Solution

**Expected: PASS — 11 of 11.**

---

## L. Reset Lab

Click **Reset**. The container is discarded and a fresh one is created from the
same image and re-seeded, so the terminal will reconnect — that is expected, not
a fault.

---

## M. Prove the initial state returned

```bash
ls -A ~                                        # ops/ is gone
ls /srv/kestrel/scan-01                        # all six files back
grep MemTotal /srv/kestrel/scan-01/proc-meminfo.txt   # 16266528 kB, as seeded
```

Reset restores the capture from the lab's own seed script, never from anything
the student left behind — so a student who edited or deleted the evidence gets a
clean copy back.

---

## N. Check Solution after reset

**Expected: FAIL — 0 of 11**, identical to step D.

---

## O. Shortcut and bypass attempts, through the real SandboxReader

Each of these passed automated rejection against an in-memory sandbox and against
a hand-driven container. This stage re-runs them through the **real** reader —
`LinuxLabProvider.read()` via `docker exec` as `student` — by typing them in the
browser terminal and clicking **Check** after each.

| # | Attempt (run in the browser terminal) | Expected |
|---|---|---|
| O1 | `rm -rf ~/ops; mkdir -p ~/ops/live; : > ~/ops/machine.txt; : > ~/ops/live/meminfo` | FAIL 2/11 |
| O2 | solve, then `cp /srv/kestrel/scan-01/proc-meminfo.txt ~/ops/live/meminfo` | FAIL 10/11 — only "came from this machine's own kernel" |
| O3 | `cat /srv/kestrel/scan-01/*.txt > ~/ops/machine.txt` | FAIL 3/11 |
| O4 | solve, then `sed -i 's/SCAN01_LOAD_PER_CPU=3/SCAN01_LOAD_PER_CPU=24.00/' ~/ops/machine.txt` | FAIL 10/11 |
| O5 | solve, then `sed -i 's/MEMINFO_SCOPE=host/MEMINFO_SCOPE=container/' ~/ops/machine.txt` | FAIL 10/11 |
| O6 | solve, then `rm -rf ~/ops/live` | FAIL 9/11 |
| O7 | `sudo sed -i 's/16266528/4194304/' /srv/kestrel/scan-01/proc-meminfo.txt`, then answer from the forged capture | FAIL — the expected values live in `lab.yaml`, outside the sandbox, so forging the evidence only destroys the student's own source of truth |

O7 is the one that matters most: it proves the answer key is not reachable from
inside the container even with `sudo`.

---

## P. Progress behaviour

1. Solve the lab and click **Check** so it passes.
2. `GET /api/progress` (or the UI's progress panel) must record **CS-001** as
   completed, and the CS track as **1/1**.
3. Confirm no other track's counts moved: Kubernetes stays `0/12`, Docker `0/10`,
   Linux `0/10`, Terraform `0/1`.
4. Click **Reset**, then **Check** (which now fails). Confirm the *recorded
   completion* is not corrupted or silently revoked by a reset — reset restores
   the sandbox, not the learning history.

> With no `DATABASE_URL` set (§A.2) this exercises the progress code path against
> the in-memory store. Persistence across an API restart is **not** proven by
> this run; see the note in §A.2 for the separate-database variant.

---

## Q. End Lab and cleanup

1. Note the sandbox container name (`docker ps --filter label=jumptotech.io/managed=true`).
2. Click **End Lab**.
3. Confirm the terminal closes in the browser.
4. `docker ps -a --filter name=<that container>` → **gone**, not merely stopped.
5. Re-issue a terminal WebSocket connection for the ended session (browser reload
   on the stale URL). It must be refused — a dead session must not hand back a
   shell.
6. Confirm **no other** managed container was removed: any sandbox belonging to
   another worktree that was running before step 2 must still be running.

---

## R. Fresh session isolation

1. Start CS-001 again.
2. Confirm a **new** container name (derived from the new session id), not the
   previous one.
3. `ls -A ~` → no `ops/` directory. No file, process or shell history from the
   previous session is present.
4. `ls /srv/kestrel/scan-01` → the capture is freshly seeded.
5. **Check** → FAIL 0/11, identical to §D.

---

## S. Security and isolation inspection

Run in the browser terminal. **Record only whether each is present or absent —
never print a value.**

| Check | Command | Expected |
|---|---|---|
| Host filesystem | `ls /Users 2>&1; ls /host 2>&1` | no such directory — no bind mount into the sandbox |
| Docker socket | `test -S /var/run/docker.sock && echo PRESENT \|\| echo ABSENT` | ABSENT |
| Docker client | `command -v docker \|\| echo "no client"` | no client |
| Network | `ping -c1 1.1.1.1` | network unreachable (`--network none`) |
| Other sessions | `ls /srv /home` | only this session's own content; no other student's files |
| Environment | `env \| cut -d= -f1 \| sort` | **names only.** No `INTERNAL_SERVICE_SECRET`, `DATABASE_URL`, `NAMESPACE_DERIVATION_SECRET` or kubeconfig path should appear |
| Kubeconfig | `ls ~/.kube 2>&1; test -f /etc/jumptotech/kubeconfig.yaml && echo PRESENT \|\| echo ABSENT` | ABSENT |
| Capabilities | `capsh --print 2>/dev/null \| head -2 \|\| grep CapEff /proc/self/status` | only the nine granted caps; no `SYS_ADMIN`, `NET_ADMIN`, `SYS_PTRACE` |

Also inspect from outside the sandbox:

- **Verifier failure details** (click Check on a wrong answer): must describe what
  was observed and must never contain an expected value — no `15885`, `16656`,
  `jumptotech-lab`, `saturated`.
- **API responses** (`GET /api/labs/CS-001`, `GET /api/sessions/<id>`): must not
  return requirement *expected values*, the seed script body, or any secret.
- **Terminal handshake**: the session token must be scoped to this session and
  must not be accepted for a different session id.

---

## Optional — confirm the security boundary by hand

```bash
ping -c1 1.1.1.1        # expect: network unreachable (--network none)
ls /var/run/docker.sock # expect: no such file
sudo id                 # expect: uid=0 — root inside this container only
mount | grep -c ' / '   # the overlay root; no host bind mounts exist
```

CS-001 itself needs none of `sudo`, the network, or any capability: it was
verified end to end under `--cap-drop ALL` with **no** capabilities added back
and `--security-opt no-new-privileges`, which is stricter than what the Linux
provider actually grants.
