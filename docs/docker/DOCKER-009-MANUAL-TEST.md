# DOCKER-009 — Manual Verification Procedure

Exercises the lab end to end against a **real Docker daemon** in a real session
sandbox. Every check reads live `docker inspect` state; nothing grades shell
history, so any route to the same state passes identically.

**Prerequisites**

```bash
export DOCKER_TRACK_ENABLED=true      # the Docker provider is off by default
```
A host Docker daemon that permits a privileged sandbox container, and the
`docker:27-dind` image available. Do **not** run `docker compose down` or remove
shared containers as part of this procedure.

Throughout, `<SESSION>` is the session id the API returns at step 1, and
`<SANDBOX>` is the sandbox container name from the same response. All `docker`
commands in the student's terminal already point at the session's own daemon via
`DOCKER_HOST`; they never touch the host daemon.

---

## 1. START LAB

**Browser:** open the catalog, choose the **Docker** track, open
**Constrain a Container with Resource Limits**, click **Start Lab**, and wait for
the terminal to attach.

**Expected:** the session provisions, the terminal opens in the workspace
directory, and the lab panel shows eight unchecked requirements.

---

## 2. INITIAL INSPECTION

In the lab terminal:

```bash
docker version --format '{{.Server.Version}}'
docker images
docker ps -a
ls -la
cat answers.txt
```

**Expected**

- the server version is the sandbox daemon's, not the host's;
- `alpine:3.20` is present (seeded);
- **no containers at all** — this lab seeds none;
- `answers.txt` is in the workspace, containing two `____` placeholders and no
  occurrence of `137` or `OOMKilled`.

Confirm the seeded worksheet cannot pre-satisfy its own check:

```bash
grep -c -e 137 -e OOMKilled answers.txt      # expected: 0
```

---

## 3. CHECK SOLUTION — BEFORE ANY WORK

**Browser:** click **Check Solution**.

**Expected result: LAB NOT COMPLETE — all eight checks FAIL.**

| # | Check | Expected detail |
|---|---|---|
| 1 | Container reporting is running | no container named 'reporting' in sandbox … |
| 2 | reporting limited to 256m / 0.5 CPU / 64 processes | no container named 'reporting' … |
| 3 | Container memory-probe exists | no container named 'memory-probe' … |
| 4 | memory-probe was given a 16m memory limit | no container named 'memory-probe' … |
| 5 | memory-probe has stopped | no container named 'memory-probe' … |
| 6 | memory-probe was killed rather than exiting cleanly | no container named 'memory-probe' … |
| 7 | The kernel stopped memory-probe for exceeding its memory limit | no container named 'memory-probe' … |
| 8 | answers.txt records the exit code and the inspect field | does not mention '137', 'OOMKilled' |

---

## 4. STUDENT SOLUTION

```bash
# Part one — the budget.
docker run -d --name reporting \
  --memory 256m --cpus 0.5 --pids-limit 64 \
  alpine:3.20 sleep 3600

# Part two — drive a container past its memory limit.
docker run --name memory-probe --memory 16m alpine:3.20 \
  sh -c 'dd if=/dev/zero of=/dev/shm/fill bs=1M count=64'
```

The second command is expected to fail — that is the exercise. It prints a
`dd`/`Killed` message and returns non-zero.

```bash
# Part three — record what was observed.
cat > answers.txt <<'EOF'
exit_code: 137
inspect_field: OOMKilled
EOF
```

---

## 5. INSPECT REAL DOCKER STATE

```bash
docker inspect reporting --format \
  '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}}'
# expected: 268435456 500000000 64

docker inspect memory-probe --format \
  '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}} {{.HostConfig.Memory}}'
# expected: exited 137 true 16777216

docker ps -a --format '{{.Names}}\t{{.Status}}'
docker stats --no-stream          # reporting shows usage against a 256MiB limit
```

The `true` in the third field is the kernel confirming it was a memory kill.

---

## 6. CHECK SOLUTION — AFTER THE FIX

**Browser:** click **Check Solution**.

**Expected result: LAB PASSED — all eight checks pass.**

---

## 7. BREAK ONE REQUIREMENT

Remove only the process limit, leaving memory and CPU correct:

```bash
docker rm -f reporting
docker run -d --name reporting --memory 256m --cpus 0.5 alpine:3.20 sleep 3600

docker inspect reporting --format '{{.HostConfig.PidsLimit}}'   # expected: 0
```

## 8. CHECK SOLUTION — EXPECT FAIL

**Expected result: LAB NOT COMPLETE.**

- Check 2 **FAILS** with detail containing **`process count is unlimited`**.
- Checks 1, 3, 4, 5, 6, 7, 8 still **PASS** — the failure is scoped to the one
  control that changed, which is what tells the student where to look.

---

## 9. REPAIR

```bash
docker rm -f reporting
docker run -d --name reporting \
  --memory 256m --cpus 0.5 --pids-limit 64 \
  alpine:3.20 sleep 3600

docker inspect reporting --format '{{.HostConfig.PidsLimit}}'   # expected: 64
```

## 10. CHECK SOLUTION — EXPECT PASS

**Expected result: LAB PASSED — all eight checks pass again.**

Note what this proves: the container was **destroyed and recreated**, not
repaired in place. The verifier reads current state, so a rebuilt container with
the right configuration is indistinguishable from one that was never wrong —
correct behaviour for a state-based grader.

---

## 11. RESET

**Browser:** click **Reset Lab**.

**Expected:** the reset completes in seconds; the session, its sandbox, and the
terminal all survive. Per `reset.docker`, containers, volumes and networks are
removed and the workspace is re-seeded; images are kept.

---

## 12. VERIFY ORIGINAL STATE

```bash
docker ps -a          # expected: empty — both containers gone
docker images         # expected: alpine:3.20 still present (images: false)
docker volume ls      # expected: empty
docker network ls     # expected: only bridge, host, none
cat answers.txt       # expected: the seeded template, both ____ restored
grep -c -e 137 -e OOMKilled answers.txt    # expected: 0
```

The `answers.txt` line is the one worth watching: if the workspace were not
re-seeded, the student's old answers would survive the reset and check 8 would
pass on a freshly reset lab.

## 13. CHECK SOLUTION — EXPECT THE INITIAL RESULT

**Expected result: identical to step 3 — LAB NOT COMPLETE, all eight checks
FAIL** with the same details. Reset returns the lab to its starting condition.

---

## 14. Multi-student isolation (optional but recommended)

Start DOCKER-009 in a second browser profile as a different student, then in
**session A's** terminal:

```bash
docker ps -a          # shows only session A's containers
```

Solve the lab in **session A only**, then click **Check Solution** in both.

**Expected:** session A passes; **session B still fails all eight checks.** Each
session has its own daemon — session B's `docker ps` cannot see session A's
containers at all, and the verifier is constructed with one daemon it cannot
change.

---

## 15. The `docker kill` bypass — now closed, verify it stays closed

This shortcut used to pass the lab. It must now fail:

```bash
docker rm -f memory-probe
docker run -d --name memory-probe --memory 16m alpine:3.20 sleep 300
docker kill memory-probe          # SIGKILL -> exit 137, but no OOM

docker inspect memory-probe --format '{{.State.ExitCode}} {{.State.OOMKilled}}'
# expected: 137 false
```

**Check Solution — expected: LAB NOT COMPLETE.** Exactly one check fails:

> The kernel stopped memory-probe for exceeding its memory limit —
> *Container 'memory-probe' stopped with exit code 137, but the daemon does not
> report it as killed for exceeding its memory limit*

Checks 5 and 6 still pass, because the container really did stop and really did
exit 137. That is the point: **exit code 137 alone never proved an OOM.**
Measured on a real daemon (Docker 28.4.0, cgroup v2), four different causes all
produce exit code 137 and only the first sets the flag:

| How it stopped | ExitCode | OOMKilled |
|---|---|---|
| kernel OOM killer | 137 | **true** |
| `docker kill` | 137 | false |
| `docker stop`, SIGTERM ignored, escalated to SIGKILL | 137 | false |
| application called `exit(137)` itself | 137 | false |

Two further cases worth spot-checking:

```bash
# A genuine OOM at the wrong limit must still fail — the lab asks for 16m.
docker rm -f memory-probe
docker run --name memory-probe --memory 6m alpine:3.20 \
  sh -c 'dd if=/dev/zero of=/dev/shm/fill bs=1M count=64'
# expected: check 4 fails (memory is 6MiB, expected 16MiB)

# The flag is per-run: an OOM does not linger across a restart.
docker rm -f memory-probe
docker run --name memory-probe --memory 16m alpine:3.20 \
  sh -c '[ -f /marker ] && exit 0; touch /marker; dd if=/dev/zero of=/dev/shm/fill bs=1M count=64'
docker inspect memory-probe --format '{{.State.OOMKilled}}'   # true
docker start -a memory-probe
docker inspect memory-probe --format '{{.State.OOMKilled}}'   # false — resets
```

The second is why a student cannot OOM once and then reuse the container.
