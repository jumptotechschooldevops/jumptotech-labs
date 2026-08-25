# Computer Science Fundamentals — curriculum plan

**Track id:** `cs` · **Status:** design only — no labs implemented, nothing committed
**Branch:** `claude/cs-fundamentals` · **Scope:** `labs/cs/**` only
**Classification:** **FOUNDATIONAL SKILL** — not a certification track (see
[Official-source policy](#12-official-source-policy-compliance) and `SOURCES.md`)
**Plan date:** 2026-08-23

---

## 1. What this track is, and what it deliberately is not

This is the computer science a DevOps, Cloud, SRE or Platform engineer needs in
order to understand the systems they are paid to keep running — and nothing
else.

It **is**:

- the mental model behind `OOMKilled`, `too many open files`, `exit code 137`,
  `502 Bad Gateway`, `remaining connection slots are reserved`, and
  `context deadline exceeded`;
- enough Python to read an application, write a check script, and reason about
  what an application is doing to a machine;
- the vocabulary — process, thread, file descriptor, heap, index, idempotency —
  that lets an engineer read a stack trace, a postmortem, or an architecture
  document and follow it.

It is **not**:

- a four-year CS degree. There is no automata theory, no compiler construction,
  no proof of correctness, no assembly, no numerical methods.
- LeetCode training. Data structures appear because a hash map is why a label
  selector is fast and a queue is why a broker applies backpressure — not
  because an interviewer asks about them. **No lab in this track asks a student
  to invert a binary tree.**
- a replacement for the Linux track. The Linux track teaches a student to *drive*
  the machine (`chmod`, `useradd`, `sv`, `journalctl`). This track teaches them
  what is *underneath* — inodes, the page cache, the process table, the kernel
  boundary. Where the two touch, this track is deliberately the "why" and the
  Linux track is the "how". Duplication is called out per lab in §7.

### The organising question

Every lab answers one question explicitly, in its own `story` and `objectives`:

> **Why does a DevOps/SRE engineer need to know this?**

If a topic cannot answer that question with a specific production failure, it is
not in this plan. That rule removed: pointer arithmetic, sorting algorithm
implementations beyond one comparison, Big-Theta/Big-Omega notation, linked-list
implementation, object-orientation and design patterns, and regular-expression
theory.

### 1.1 Narrative

All 35 labs are set at **Kestrel Logistics**, an original fictional parcel-tracking
company with a public API, a Postgres-shaped database, a queue of scanning
events, and a small platform team the student has just joined. The scenario,
company, incidents, wording, starting states and hints are entirely
JumpToTech-original content (policy §12). Official documentation determines what
is *correct*; it never supplies the scenario.

---

## 2. Audience, entry point and placement in the catalog

**Assumed on day one:** the student can open a terminal, and can type `ls`, `cd`
and `cat`. Nothing else. No programming background is assumed.

**Placement.** The CS track is the *foundation* track. Proposed
`labs/cs/track.yaml`:

```yaml
title: Computer Science Fundamentals
tagline: What a computer actually does — and why every production incident traces back to it.
order: 5
```

`order: 5` puts it ahead of Kubernetes (`10`) and Docker (`20`) in the catalog,
which is the order a beginner should meet them in. The Linux track has no
`order` today and sorts last; that is a Linux-track decision and this plan does
not touch it.

**Cross-track prerequisites are deliberately not declared.** `lab-registry.ts`
resolves prerequisites globally and rejects unknown ids, so `prerequisites:
[LINUX-001]` on a CS lab *would* load — but it would couple two tracks' release
schedules and force a student into a second track before finishing the first.
Instead the CS track is self-contained, and the recommended pairing is stated in
prose here and in the track tagline:

```text
CS-001 … CS-010        (no other track needed)
CS-011 … CS-016        pairs naturally with LINUX-001 … LINUX-004
CS-022 … CS-024        pairs naturally with DOCKER-001 … DOCKER-004
CS-031 … CS-035        pairs naturally with K8S-001 … K8S-010
```

---

## 3. Platform findings — what this plan is constrained by

Everything in this section was verified against this repository and by running
the actual base image under the actual sandbox flags, not assumed.

### 3.1 No new provider is needed — the CS track runs on `linux`

`LAB_PROVIDERS` (`services/lab-orchestrator/src/providers/catalog.ts`) is a
closed list: `kubernetes`, `linux`, `docker`, `terraform`, `aws`. There is no
`cs` provider and **this plan does not ask for one.**

Every CS lab declares:

```yaml
environment:
  provider: linux
```

`PROVIDER_REQUIREMENT_FAMILIES.linux` is `['filesystem', 'linux']`
(`lab-definition.ts:89`), which is exactly the vocabulary this track needs (§4).
The CS track therefore adds **no provider, no isolation mode, no session code,
and no new requirement family.**

### 3.2 BLOCKER — Python is not in the sandbox image

`infrastructure/docker/sandbox-linux.Dockerfile` installs a justified,
line-by-line package set that contains **no `python3`**, and states explicitly:
"no compilers, no package indexes". **27 of the 35 labs in this plan cannot run
until a Python interpreter exists in the CS sandbox.**

This file is owned by the Linux/platform track, not by this branch. It is
therefore raised here as a decision, not changed:

| Option | Change | Cost | Consequence |
|---|---|---|---|
| **A — add `python3` to the shared Linux image** *(recommended)* | one package in `sandbox-linux.Dockerfile` | **+47 MB** (measured) | Linux track's image grows; CS labs need zero platform code |
| **B — new `cs` provider + `jumptotech/lab-cs` image** | `catalog.ts`, `PROVIDER_ISOLATION`, `PROVIDER_SANDBOX_KIND`, `PROVIDER_REQUIREMENT_FAMILIES`, a provider class, registry wiring, a Dockerfile `FROM jumptotech/lab-linux` | ~1 file of platform code + a second image to build and ship | Linux image untouched; a fifth container image in the build |

**Measured evidence for Option A** (`debian:bookworm-slim`,
`apt-get install --no-install-recommends python3`):

```text
image growth        +47 MB
interpreter         Python 3.11.2
stdlib modules      30 / 30 importable — including sqlite3 (3.40.1), json,
                    http.server, http.client, socket, threading, multiprocessing,
                    struct, hashlib, hmac, secrets, dis, py_compile, timeit,
                    bisect, heapq, queue, collections, statistics, resource,
                    tracemalloc, logging, venv, unicodedata, codecs
```

**No third-party package, no `pip`, and no network install is required by any
lab in this plan.** The entire track — including the database phase and the
HTTP phase — is built on the Python 3 standard library and coreutils. That is a
deliberate design constraint, not a limitation worked around.

**Recommendation: Option A.** It is one line, it keeps the CS track free of
platform code, and a Linux sandbox that can run `python3` is more useful to the
Linux track too (LINUX-009 shell scripting gains a comparison point). If the
Linux track owners decline the +47 MB, Option B is a clean fallback and this
plan works unchanged under it.

**Optional, not required:** `python3-venv` (~3 MB) — without it, `python3 -m venv`
fails on Debian (verified: `ensurepip` is unbundled) and only
`python3 -m venv --without-pip` works. CS-023 is written to work either way; see
that lab. `curl` is likewise *not* required — CS-025 deliberately uses `nc` and
raw Python sockets, which teach HTTP better.

### 3.3 Verified: everything else the track needs already works

Run against `--network none --cap-drop ALL --user 1000:1000`, the sandbox's
actual profile:

| Capability | Result | Used by |
|---|---|---|
| Loopback TCP under `--network none` | **works** — `http.server` on `127.0.0.1:8080` answered `HTTP 200` | CS-025…CS-027, CS-031…CS-033 |
| `/proc/self/syscall` | readable, no `SYS_PTRACE` needed | CS-012 |
| `/proc/self/status` (`voluntary_ctxt_switches`, `VmRSS`, `VmSize`, `Threads`) | readable | CS-013, CS-014 |
| `/proc/self/fd` | readable | CS-004 |
| `/proc/meminfo`, `/proc/cpuinfo` | readable — **and show the host, not the cgroup** | CS-001, CS-014 |
| `/sys/fs/cgroup/memory.max` | readable | CS-014, CS-035 |
| `sqlite3` via Python stdlib | 3.40.1 | CS-028…CS-030 |
| coreutils `od`, `numfmt`, `base64`, `sha256sum`, `timeout`, `seq`, `nl` | present in base image | CS-002, CS-003, CS-020 |

The "`/proc/meminfo` shows the host, not the container's limit" finding is not a
constraint — it is **taught deliberately** in CS-014, because it is precisely why
`free -m` misleads engineers inside containers and why a JVM or a Node process
sized from `/proc/meminfo` gets OOMKilled.

### 3.4 Constraints that shape the content

| Constraint | Source | How the plan responds |
|---|---|---|
| **No `strace`; `SYS_PTRACE` is not grantable** | `linux-provider.ts` — "`SYS_ADMIN`, `NET_ADMIN`, `SYS_PTRACE`… are not grantable at all" | CS-012 teaches system calls through `/proc/<pid>/syscall`, `/proc/<pid>/fd`, `/proc/<pid>/status` and observable effects. **Do not request `SYS_PTRACE`** — the host-kernel boundary is worth more than one lab's convenience. |
| **No compilers** | `sandbox-linux.Dockerfile` | CS-022 teaches compilation vs interpretation with `py_compile`, `__pycache__`, `dis`, and `file` on the ELF binaries already in the image — a real compiled/interpreted contrast with no toolchain. |
| **No network** (`--network none`) | `linux-provider.ts` | Every client/server, API, queue and replication lab runs over loopback in one sandbox. Nothing in the plan needs egress. |
| **`command_output` allow-list excludes `python3`** | `requirements.ts` `VERIFIER_COMMANDS` | Correct and deliberate — the allow-list is read-only inspection binaries. **This plan does not ask to extend it.** Python is graded through `script_runs`, which is the sanctioned path (§4). |
| **`setup.files` strips execute bits** | `lab-definition.ts` | Starter `.py` files ship non-executable; labs that use `script_runs` ask the student to add a shebang and `chmod +x`. That is on-curriculum (CS-022), not a workaround. |
| **The student has passwordless `sudo`** | `sandbox-linux.Dockerfile` | Any seeded checker is readable by the student. Checkers are therefore written as **specifications** (the test cases *are* the spec), never as answer keys. `/opt/jumptotech/seed` is wiped before the terminal opens; anything a seed script writes elsewhere persists and is readable — assume it will be read. |

---

## 4. Verification strategy

**No new requirement type is proposed.** The existing `filesystem` + `linux`
vocabulary grades all 35 labs. Five patterns cover everything:

| # | Pattern | Mechanism | Grades |
|---|---|---|---|
| **V1** | **Behaviour** | `script_runs` on the student's own script (`path`, `args`, `expected_exit_code`, `output_contains`) | What their code *does*. Two students with completely different code both pass. |
| **V2** | **Harness** | a `setup.seed_scripts` step installs `/usr/local/bin/jtt-cs-NNN-check`, graded with `script_runs` | Code whose *output format* shouldn't be the grade — the harness imports the student's module, feeds fixed inputs, prints `PASS:` tokens matched by `output_contains`. |
| **V3** | **Evidence** | `file_content` / `command_output` (`grep`, `awk`, `wc`) over a findings file the student writes | Investigation labs: the student had to *discover* a value. Only used for values that are **stable by construction** (a computed answer, a seeded fixture) — never a host-dependent number. |
| **V4** | **Live state** | `process_running`, `port_listening`, `file_exists`, `path_absent`, `script_executable`, `file_mode` | Something the student started, built, stopped or fixed. |
| **V5** | **Computed artifact** | `command_output` with `sha256sum` / `sort` / `uniq` / `wc` over a data file the student produced | A transformation with exactly one correct output, method-agnostic. |

**Anti-cheat posture.** V1/V2/V5 grade results, not transcripts, so there is no
command to memorise. V3 is the weakest — a student could guess — so V3 is never
the *only* check in a lab, and its expected values are computed, not looked up.

**A note on V3 and environment-dependent values.** A check like "your findings
file must contain `536870912`" is only sound if the sandbox's memory limit is
pinned by the provider. Where a lab needs the student to read a live value, the
grading targets a *derived* fact that is true regardless (e.g. "the file records
a limit smaller than `/proc/meminfo` MemTotal", expressed as a fixture the seed
script plants). Each affected lab says so in its verification note.

---

## 5. Exercise types

Every lab is tagged with one primary type. The mix is deliberate: a track that
is all Python becomes a programming course, and a track that is all `cat /proc`
becomes trivia.

| Type | What it looks like | Count |
|---|---|---|
| **EXPLAIN** — explanation / visual | Concept-first. Student reads, measures something small, and records findings. Heavy `story`/`objectives`, light task. | 3 |
| **TERM** — terminal-based | Shell work in the sandbox: redirection, `od`, `numfmt`, `/proc`. | 5 |
| **PY** — Python coding | Student writes Python graded on behaviour (V1/V2). | 17 |
| **INVEST** — Linux investigation | Read the live system, find the answer, record evidence. | 6 |
| **TROUBLE** — troubleshooting scenario | Something is broken/seeded wrong; diagnose and fix. | 4 |

---

## 6. Progression

```text
  PHASE 1  Computer Basics          CS-001 … CS-005    5 labs   beginner
     │     what a machine is, bits, encoding, files, the process contract
     ▼
  PHASE 2  Programming Foundations  CS-006 … CS-010    5 labs   beginner
     │     types, control flow, collections, strings, errors, JSON/YAML
     ▼
  PHASE 3  Operating System         CS-011 … CS-016    6 labs   beginner→intermediate
     │     processes, syscalls, threads, memory, filesystems, signals
     ▼
  PHASE 4  Data Structures          CS-017 … CS-019    3 labs   intermediate
     │     stacks/queues, hash maps/sets, trees/graphs — operationally framed
     ▼
  PHASE 5  Algorithmic Thinking     CS-020 … CS-021    2 labs   intermediate
     │     Big O measured, searching/sorting/recursion, time vs space
     ▼
  PHASE 6  Application Fundamentals CS-022 … CS-024    3 labs   intermediate
     │     compile vs interpret, dependencies, config/logs/exit codes
     ▼
  PHASE 7  Web / App Architecture   CS-025 … CS-027    3 labs   intermediate
     │     client/server, HTTP, REST/status codes, authn/authz, state
     ▼
  PHASE 8  Databases                CS-028 … CS-030    3 labs   intermediate
     │     tables/keys/SQL, indexes/transactions/ACID, pools/cache/NoSQL
     ▼
  PHASE 9  Distributed Systems      CS-031 … CS-033    3 labs   intermediate→advanced
     │     latency/throughput, scaling/replication/consistency, retries/idempotency
     ▼
  PHASE 10 SRE Troubleshooting      CS-034 … CS-035    2 labs   advanced (assessment)
           two capstones that require most of the track at once
```

**Total: 35 labs.** Estimated total student time: **≈ 21 hours**.

The count sits at the top of the requested 25–35 range because the topic list in
the brief is broad; §8 shows every requested topic mapped to a lab, and §11
lists what would be cut first if 35 proves too many.

---

## 7. The labs

Field key — every lab carries: **Concept · DevOps relevance · Type · Difficulty ·
Duration · Prerequisites · Scenario · Student task · Verification · Sources**.

`level:` is `practice` unless stated. All sources listed were fetched and
returned HTTP 200 on 2026-08-23 (see `SOURCES.md`).

---

### PHASE 1 — COMPUTER BASICS

---

#### CS-001 — What a machine actually is

- **Concept:** CPU, cores, RAM, storage, and load — the four numbers underneath every capacity decision.
- **DevOps relevance:** Every `resources.requests`, every instance-type choice, every "is the node too small?" argument is this lab. A student who cannot say what a core is cannot size a workload.
- **Type:** INVEST · **Difficulty:** beginner · **Duration:** 25 min · **Prereqs:** none

**Scenario.** Kestrel Logistics is moving its parcel-scan service onto new
hardware and the platform lead has asked for a one-page description of what the
current machine actually *is*. Nobody has written it down; the last person who
knew has left.

**Student task.** Read the machine from `/proc/cpuinfo`, `/proc/meminfo`,
`/proc/loadavg`, `/proc/uptime` and `df`. Write `/home/student/ops/machine.txt`
recording: the number of logical processors, total memory in **both** MiB and
MB, the filesystem holding `/home`, and the 1-minute load average. Then answer,
in the same file, one question in your own words: *why can load average be 4.0
on a machine that is not busy?*

**Verification.** V3 + V5. `file_exists`; `command_output` with `grep -c` to
confirm each required section is present; `command_output` with `awk` to confirm
the recorded processor count matches `grep -c processor /proc/cpuinfo`, so the
number is *read*, not guessed. The free-text answer is not machine-graded — it
exists so the hint ladder and the student's own notes have somewhere to go.

**Sources.** `proc(5)` <https://man7.org/linux/man-pages/man5/proc.5.html> ·
kernel proc filesystem <https://docs.kernel.org/filesystems/proc.html> ·
`df(1)` <https://man7.org/linux/man-pages/man1/df.1.html>

---

#### CS-002 — Bits, bytes, hex, and the units that page you

- **Concept:** bit, byte, binary, hexadecimal, and the KB/KiB · MB/MiB · GB/GiB distinction.
- **DevOps relevance:** `memory: 512Mi` is not `512MB`. A disk alert at "85% of 1 TB" and a `df` output in 1K-blocks are different numbers. Hex is how you read a UID, a colour, a checksum, an inode, and every byte dump in this track.
- **Type:** TERM + PY · **Difficulty:** beginner · **Duration:** 30 min · **Prereqs:** CS-001

**Scenario.** A Kestrel alert fired at 06:12: *"scan-api memory 640M of 512Mi
limit"*. Two engineers disagree in the incident channel about whether that is
even possible. Settle it with arithmetic.

**Student task.** (a) In the shell, use `od -An -tx1` and `printf` to show the
bytes of a short string and convert between decimal, binary and hex. (b) Use
`numfmt` to convert the same byte count into SI and IEC units and observe they
differ. (c) Write `/home/student/py/units.py` — a script taking a byte count as
`argv[1]` and printing three lines: `BYTES=<n>`, `SI=<n> MB`, `IEC=<n> MiB`,
rounded to two decimals.

**Verification.** V1 — `script_runs` on `units.py` with a fixed argument
(`536870912`) and `output_contains: ["BYTES=536870912", "SI=536.87 MB",
"IEC=512.00 MiB"]`. One fixed input, three exact answers, any implementation.

**Sources.** GNU coreutils block size
<https://www.gnu.org/software/coreutils/manual/html_node/Block-size.html> ·
`numfmt` <https://www.gnu.org/software/coreutils/manual/html_node/numfmt-invocation.html> ·
`od(1)` <https://man7.org/linux/man-pages/man1/od.1.html> ·
Python `int`/`format` <https://docs.python.org/3/library/stdtypes.html>

---

#### CS-003 — Text, encoded: ASCII, UTF-8 and Unicode

- **Concept:** characters vs bytes; ASCII; Unicode code points; UTF-8 as a variable-width encoding; why byte order exists.
- **DevOps relevance:** The config file that "looks fine" but won't parse. The log line that breaks a regex. `UnicodeDecodeError` in a pipeline. A name field that is 12 characters and 17 bytes — and the database column that is `VARCHAR(12)`.
- **Type:** TERM + PY · **Difficulty:** beginner · **Duration:** 30 min · **Prereqs:** CS-002

**Scenario.** Kestrel's address-import job has started failing on parcels bound
for Zürich and São Paulo. The file "has the right number of characters". The
importer disagrees.

**Student task.** Inspect a seeded `addresses.txt` with `od -An -tx1` and see
multi-byte sequences directly. Then write `/home/student/py/encoding.py` that,
for each line, prints `LINE=<n> CHARS=<c> BYTES=<b>` and finally
`TOTAL_BYTES=<n>`. Record in `/home/student/ops/encoding.txt` which line is
longest in characters and which is longest in bytes — they are not the same
line, and that is the lesson.

**Verification.** V1 (`script_runs` with `output_contains` on the exact
char/byte counts of the seeded fixture — deterministic because the fixture is
shipped by the lab) + V3 (`file_content contains` the two line numbers).

**Sources.** Unicode Standard <https://www.unicode.org/versions/latest/> ·
UTF-8 (RFC 3629) <https://www.rfc-editor.org/rfc/rfc3629> ·
ASCII (RFC 20) <https://www.rfc-editor.org/rfc/rfc20> ·
`utf-8(7)` <https://man7.org/linux/man-pages/man7/utf-8.7.html> ·
Python Unicode HOWTO <https://docs.python.org/3/howto/unicode.html>

---

#### CS-004 — Files, file descriptors, and "too many open files"

- **Concept:** what a file *is* to the kernel; the file-descriptor table; `RLIMIT_NOFILE`; descriptors as the currency of sockets, pipes and logs.
- **DevOps relevance:** `EMFILE: too many open files` is one of the most common production outages in existence, and it is almost never about files — it is about sockets. This lab is why an engineer knows to look in `/proc/<pid>/fd` instead of restarting the pod again.
- **Type:** INVEST + PY · **Difficulty:** beginner · **Duration:** 30 min · **Prereqs:** CS-001

**Scenario.** Kestrel's `scan-collector` dies every few hours with
`OSError: [Errno 24] Too many open files`. Restarting fixes it for a while. The
previous engineer raised the limit twice; it died again both times.

**Student task.** Read `ulimit -n` and `/proc/self/limits`. Start the seeded
leaky process, watch `/proc/<pid>/fd` grow, and count descriptors with `ls |
wc -l`. Write `/home/student/py/fdcount.py <pid>` that prints
`PID=<pid> FDS=<n>` and exits `0` under a threshold and `1` at or above it —
your first exit-code contract. Record the *root cause* in
`/home/student/ops/fd.txt`: a descriptor that is never closed, not a limit that
is too low.

**Verification.** V1 — `script_runs` on `fdcount.py` twice: once against a pid
with few descriptors (`expected_exit_code: 0`) and once against the seeded leaky
pid (`expected_exit_code: 1`). V4 — `process_running` for the leak process.
V3 — `file_content contains` on the diagnosis keyword.

**Sources.** `proc(5)` <https://man7.org/linux/man-pages/man5/proc.5.html> ·
`getrlimit(2)` <https://man7.org/linux/man-pages/man2/getrlimit.2.html> ·
`open(2)` <https://man7.org/linux/man-pages/man2/open.2.html> ·
`dup(2)` <https://man7.org/linux/man-pages/man2/dup.2.html>

---

#### CS-005 — The process contract: streams, exit codes, environment

- **Concept:** stdin/stdout/stderr as fds 0/1/2; redirection and pipes; exit status; the environment as a process's inherited configuration.
- **DevOps relevance:** This *is* the CI/CD interface. A pipeline step passes or fails on an exit code. A log ends up in the wrong stream and vanishes from the aggregator. A container gets its config from the environment and nothing else. Everything after this lab assumes it.
- **Type:** TERM · **Difficulty:** beginner · **Duration:** 30 min · **Prereqs:** CS-004

**Scenario.** A Kestrel deploy job "passed" last night and shipped a broken
build. The job's last command printed a stack trace — to stdout — and returned
`0`. The pipeline believed it.

**Student task.** Separate a seeded command's stdout and stderr into two files.
Show a pipeline's exit status is the *last* command's. Write
`/home/student/bin/deploy-check.sh` that reports on stdout, warns on stderr,
exits `0` on success and a specific non-zero code on failure, and reads its
threshold from an environment variable. Confirm the variable is visible in
`/proc/<pid>/environ` of a process it starts.

**Verification.** V4 (`script_executable`) + V1 (`script_runs` twice with
different `args`, asserting both exit codes and both `output_contains`). Whether
the warning genuinely went to stderr is graded by the redirection artifacts the
student produces (`file_content` on the captured `err.txt`, `file_content_absent`
on `out.txt`).

**Sources.** `stdin(3)` <https://man7.org/linux/man-pages/man3/stdin.3.html> ·
Bash redirections <https://www.gnu.org/software/bash/manual/html_node/Redirections.html> ·
Bash exit status <https://www.gnu.org/software/bash/manual/html_node/Exit-Status.html> ·
`environ(7)` <https://man7.org/linux/man-pages/man7/environ.7.html>

---

### PHASE 2 — PROGRAMMING FOUNDATIONS

---

#### CS-006 — Variables, types and control flow

- **Concept:** variables; `str`/`int`/`float`/`bool`/`None`; truthiness; comparison; `if`/`elif`/`else`; `for`/`while`; functions, parameters and return values.
- **DevOps relevance:** `"8" != 8` is a real outage: a replica count read from YAML as a string, a port compared against a string, a threshold that never triggers because `"0"` is truthy. Functions are how a check script stops being 200 lines of copy-paste.
- **Type:** PY · **Difficulty:** beginner · **Duration:** 40 min · **Prereqs:** CS-005

**Scenario.** Kestrel's autoscaler helper reads `MIN_REPLICAS` from the
environment and has never once scaled down. The value is `"2"`. The comparison is
`if replicas > min_replicas`.

**Student task.** Write `/home/student/py/scale.py` with a function
`decide(current, target, minimum)` returning `"scale-up"`, `"scale-down"` or
`"hold"`, correctly handling values that arrive as strings. Loop over a seeded
list of readings and print one decision per line. Make the script exit non-zero
if any input cannot be interpreted as a number.

**Verification.** V2 — a seeded harness imports `decide` and calls it with ~10
fixed argument sets covering the string/int trap, the equality boundary and the
bad-input case, printing `PASS:<case>` per case; `script_runs` requires all
tokens. Grading the *function*, not the print formatting, is what makes this fair.

**Sources.** Python tutorial: introduction <https://docs.python.org/3/tutorial/introduction.html> ·
control flow <https://docs.python.org/3/tutorial/controlflow.html> ·
built-in types <https://docs.python.org/3/library/stdtypes.html>

---

#### CS-007 — Lists and dictionaries: from lines to structure

- **Concept:** lists (ordered, indexable, mutable), dictionaries (key → value), iteration, nesting, and choosing between them.
- **DevOps relevance:** Every config, every API response, every `kubectl get -o json` is lists inside dicts inside lists. Reading YAML/JSON without this is guesswork. It is also the first honest answer to "should I loop over a list or look it up in a dict?" — which becomes CS-018.
- **Type:** PY · **Difficulty:** beginner · **Duration:** 35 min · **Prereqs:** CS-006

**Scenario.** Kestrel's scan events arrive as one line per scan. The ops team
wants counts per depot, and the current script prints them in a different order
every run.

**Student task.** Write `/home/student/py/depots.py` that reads a seeded event
file, builds a dict of depot → count, and prints `DEPOT=<name> COUNT=<n>` sorted
by count descending then name ascending. Also produce
`/home/student/ops/depots.csv` with the same data.

**Verification.** V1 (`script_runs`, `output_contains` the top three lines
exactly — determined by the shipped fixture) + V5 (`command_output` with
`sha256sum` on `depots.csv`, so the *content* is graded and the tie-break rule
is enforced without dictating the code).

**Sources.** Python data structures <https://docs.python.org/3/tutorial/datastructures.html> ·
`collections` <https://docs.python.org/3/library/collections.html>

---

#### CS-008 — Strings and text processing

- **Concept:** slicing, `split`, `strip`, `join`, f-strings, `in`, and why string parsing is fragile.
- **DevOps relevance:** Logs are strings. Almost all first-line diagnosis is string work, and almost all broken parsers are string work done badly — a timestamp assumed fixed-width, a message containing the delimiter.
- **Type:** PY · **Difficulty:** beginner · **Duration:** 35 min · **Prereqs:** CS-007

**Scenario.** Kestrel's log parser silently drops ~2% of lines. The dropped ones
are the interesting ones: the error messages contain a space and the parser
splits on space.

**Student task.** Write `/home/student/py/parselog.py` producing
`TOTAL=<n> ERRORS=<n> DROPPED=0` over a seeded log whose messages contain
delimiters, quotes and one non-ASCII line (callback to CS-003). Print the three
slowest requests by duration.

**Verification.** V1 with `output_contains` asserting `DROPPED=0` and the exact
totals for the shipped fixture — a naive splitter cannot produce them.

**Sources.** Text sequence type `str` <https://docs.python.org/3/library/stdtypes.html> ·
Python tutorial: introduction (strings) <https://docs.python.org/3/tutorial/introduction.html>

---

#### CS-009 — Errors, exceptions and failing usefully

- **Concept:** exceptions vs return codes; `try`/`except`/`else`/`finally`; the traceback; catching narrowly; re-raising; mapping failure to an exit code.
- **DevOps relevance:** A tool that swallows exceptions and exits `0` is worse than one that crashes: the pipeline goes green and the incident starts later. Reading a traceback bottom-up is the single most transferable debugging skill in this track.
- **Type:** PY · **Difficulty:** beginner · **Duration:** 35 min · **Prereqs:** CS-008

**Scenario.** The Kestrel nightly reconciliation wraps its whole body in
`try: ... except: pass`. It has "succeeded" every night for three weeks. The
ledger has not reconciled once.

**Student task.** Given a seeded script that hides failures, rewrite
`/home/student/py/reconcile.py` so that: a missing input file exits `2` with a
clear stderr message, a malformed record exits `3`, and success exits `0`.
Catch specific exceptions only. Record in `/home/student/ops/errors.txt` the
last line of the traceback you saw before fixing it — and why that line, not the
first, is the useful one.

**Verification.** V1 — three `script_runs` entries against three seeded inputs,
asserting exit codes `0`, `2`, `3` respectively plus `output_contains` on the
success path. V3 for the traceback note.

**Sources.** Errors and exceptions <https://docs.python.org/3/tutorial/errors.html> ·
built-in exceptions <https://docs.python.org/3/library/exceptions.html> ·
`sys.exit` <https://docs.python.org/3/library/sys.html>

---

#### CS-010 — JSON and YAML: the formats infrastructure speaks

- **Concept:** JSON's data model (RFC 8259); YAML 1.2 as a superset-ish alternative; parsing, serialising, and the traps — duplicate keys, `yes`/`no`, unquoted versions, tabs, indentation.
- **DevOps relevance:** Kubernetes manifests, CI configs, Terraform state, API payloads, structured logs. `version: 3.10` parsing as the float `3.1` has broken real deployments; so has an unquoted `no` becoming `false`.
- **Type:** PY · **Difficulty:** beginner · **Duration:** 40 min · **Prereqs:** CS-009

**Scenario.** A Kestrel config change set `enabled: no` for a depot and
disabled the wrong one; another set `version: 3.10` and deployed 3.1.

**Student task.** Write `/home/student/py/config.py` that loads a seeded JSON
config with `json`, validates required keys and types, prints
`CONFIG_OK` or a specific error, and writes a normalised JSON file with sorted
keys. Then, by hand, correct a seeded YAML file's four traps and record in
`/home/student/ops/yaml.txt` what each one was.

**Verification.** V1 on `config.py` (valid + invalid fixtures, distinct exit
codes) · V5 `sha256sum` on the normalised JSON (sorted keys make it exact) ·
V3 `file_content contains` for each of the four trap names.

> **Note.** The sandbox has no `PyYAML` and no network. The YAML half is
> deliberately *reading and correcting* YAML by hand — the skill an engineer
> actually needs — rather than parsing it in Python. If a YAML parser is ever
> wanted here, `python3-yaml` is a Debian package and would be a second, separate
> platform ask; **this plan does not request it.**

**Sources.** RFC 8259 (JSON) <https://www.rfc-editor.org/rfc/rfc8259> ·
Python `json` <https://docs.python.org/3/library/json.html> ·
YAML 1.2.2 specification <https://yaml.org/spec/1.2.2/>

---

### PHASE 3 — OPERATING SYSTEM CONCEPTS

---

#### CS-011 — Process lifecycle: fork, exec, PID, PPID, zombies and PID 1

- **Concept:** how a process is created (`fork` + `exec`), PID/PPID, the parent's duty to reap, zombies, orphans, and why PID 1 is special.
- **DevOps relevance:** Why a container ignores `docker stop`. Why zombie processes accumulate behind a shell-script entrypoint. Why `tini`/`--init` exists. Why "the process is `<defunct>`" is not fixed by killing it.
- **Type:** INVEST + PY · **Difficulty:** beginner · **Duration:** 35 min · **Prereqs:** CS-005 · *Complements LINUX-004 (which teaches `ps`/`kill` operationally); this lab teaches the lifecycle underneath.*

**Scenario.** Kestrel's scan worker container accumulates hundreds of `<defunct>`
entries over a day and eventually hits its pid limit. The entrypoint is a shell
script that starts the worker and sleeps.

**Student task.** Use `ps -ef` and `/proc/<pid>/status` to map the sandbox's
process tree, identifying PID 1 and each PPID. Write
`/home/student/py/spawn.py` that forks a child with `os.fork`, prints
`PARENT=<pid> CHILD=<pid>`, deliberately does *not* wait, and lets you observe
the zombie in `ps`. Then fix it with `os.waitpid` and observe the zombie is gone.
Record what changed in `/home/student/ops/zombies.txt`.

**Verification.** V1 on the fixed `spawn.py`: `script_runs` with
`output_contains: ["PARENT=", "CHILD=", "REAPED"]` and `expected_exit_code: 0`,
run with a short `timeout_seconds` so a version that never reaps fails on time.
V3 for the write-up.

**Sources.** `fork(2)` <https://man7.org/linux/man-pages/man2/fork.2.html> ·
`execve(2)` <https://man7.org/linux/man-pages/man2/execve.2.html> ·
`proc(5)` <https://man7.org/linux/man-pages/man5/proc.5.html> ·
Python `os` process management <https://docs.python.org/3/library/os.html>

---

#### CS-012 — User space, kernel space and system calls

- **Concept:** the privilege boundary; what a system call is; why a call into the kernel costs more than a function call; how to observe calls without a debugger.
- **DevOps relevance:** It reframes performance: "the app is slow" becomes "the app is making 40,000 `write` calls where it could make 40". It explains why a container is not a VM (one shared kernel), why seccomp exists, and why `sy` time in `top` is a real signal.
- **Type:** INVEST · **Difficulty:** intermediate · **Duration:** 35 min · **Prereqs:** CS-011

**Scenario.** Kestrel's label printer service burns 60% CPU in *system* time and
nobody can explain it. It writes each label line to the log unbuffered.

**Student task.** Read `/proc/<pid>/syscall` for a blocked process and decode
the syscall number against `syscalls(2)`. Compare `/proc/<pid>/status`
context-switch counters between a buffered and an unbuffered writer (both
seeded). Record in `/home/student/ops/syscalls.txt` the syscall the blocked
process is sitting in, and which of the two writers crossed the kernel boundary
more often — with the numbers.

**Verification.** V3 + V5 — `command_output` with `grep`/`awk` over the findings
file to confirm the recorded syscall name and that the recorded counter ordering
matches reality. The two writer processes are seeded, so the *relative* answer is
deterministic even though absolute counts are not. V4 `process_running` for the
blocked fixture.

> **Constraint acknowledged.** No `strace`, and `SYS_PTRACE` is not grantable in
> this sandbox by design. `/proc/<pid>/syscall` was verified readable under
> `--cap-drop ALL` as an unprivileged user, so this lab works as written. Do not
> propose relaxing the capability set for it.

**Sources.** `syscall(2)` <https://man7.org/linux/man-pages/man2/syscall.2.html> ·
`syscalls(2)` <https://man7.org/linux/man-pages/man2/syscalls.2.html> ·
`proc(5)` <https://man7.org/linux/man-pages/man5/proc.5.html> ·
kernel proc filesystem <https://docs.kernel.org/filesystems/proc.html>

---

#### CS-013 — Threads, scheduling and context switching

- **Concept:** process vs thread; shared memory and its hazards; the run queue; time slices; voluntary vs involuntary context switches; `nice`; CPU-bound vs I/O-bound.
- **DevOps relevance:** CPU limits and throttling. Why adding threads made it slower. Why a CPU-bound Python worker doesn't scale with threads (the GIL) but an I/O-bound one does — which is exactly the wrong-fix that shows up in Kubernetes HPA tuning.
- **Type:** PY + INVEST · **Difficulty:** intermediate · **Duration:** 40 min · **Prereqs:** CS-011

**Scenario.** Kestrel doubled the thread count on the scan-ingest worker to
"double throughput". Latency got worse. The worker computes checksums — it is
CPU-bound.

**Student task.** Write `/home/student/py/workers.py` that runs the same
workload three ways — serial, threaded, and multi-process — timing each and
printing `SERIAL=<s> THREADED=<s> PROCESSES=<s>`, then a verdict line
`FASTEST=<mode>`. Run it once with a CPU-bound task and once with an I/O-bound
task (`--io` flag) and observe the verdict flip. Read
`voluntary_ctxt_switches` / `nonvoluntary_ctxt_switches` from
`/proc/<pid>/status` during each run.

**Verification.** V1 — `script_runs` with `args: ["--io"]` and without, asserting
the printed `FASTEST=` verdict differs between the two modes and both exit `0`.
This grades the *observation*, which is robust: the CPU/IO contrast holds on any
host, whereas absolute timings do not.

**Sources.** `pthreads(7)` <https://man7.org/linux/man-pages/man7/pthreads.7.html> ·
`sched(7)` <https://man7.org/linux/man-pages/man7/sched.7.html> ·
kernel scheduler docs <https://docs.kernel.org/scheduler/index.html> ·
Python `threading` <https://docs.python.org/3/library/threading.html> ·
`multiprocessing` <https://docs.python.org/3/library/multiprocessing.html> ·
GIL (glossary) <https://docs.python.org/3/glossary.html>

---

#### CS-014 — Virtual memory: stack, heap, RSS vs VSZ, and the OOM killer

- **Concept:** virtual vs physical memory; pages; the stack (call frames, recursion depth) vs the heap (allocation, lifetime); RSS vs VSZ; page cache; overcommit; the OOM killer; cgroup limits.
- **DevOps relevance:** **`OOMKilled` and exit code 137.** Why a pod with a 512Mi limit dies at 512Mi RSS while `top` on the node shows free memory. Why `/proc/meminfo` misleads inside a container. Why "memory usage" is three different numbers.
- **Type:** PY + INVEST · **Difficulty:** intermediate · **Duration:** 40 min · **Prereqs:** CS-013

**Scenario.** Kestrel's report generator dies with exit code 137 on the 1st of
every month — the day the report is biggest. The container has a memory limit;
the node has plenty free.

**Student task.** Compare `/proc/meminfo` `MemTotal` with
`/sys/fs/cgroup/memory.max` and record that they disagree. Write
`/home/student/py/memgrow.py` that allocates in steps, printing
`STEP=<n> RSS_KB=<n> VSZ_KB=<n>` read from `/proc/self/status`, so the student
watches RSS climb while VSZ climbs faster. Add a `--recurse` mode that recurses
until Python raises `RecursionError` — the stack, not the heap — and prints
`STACK_LIMIT_HIT`. Record in `/home/student/ops/memory.txt` which number a memory
limit is actually enforced against, and what exit code the kernel's OOM kill
surfaces as.

**Verification.** V1 — `script_runs` twice: default mode requires
`output_contains: ["RSS_KB=", "VSZ_KB="]` and exit `0`; `--recurse` requires
`STACK_LIMIT_HIT` and exit `0` (the student must *catch* the `RecursionError`,
which is the CS-009 callback). V3 — `file_content contains "137"` and the RSS
keyword.

> **Note.** This lab deliberately does *not* attempt to trigger a real OOM kill:
> the sandbox's memory ceiling is the platform's, and a lab that pushes a session
> into the OOM killer would be graded on the provider's configuration rather than
> the student's work. The kill is *explained and evidenced* (cgroup limit, exit
> code 137); it is not induced.

**Sources.** kernel memory-management concepts <https://docs.kernel.org/admin-guide/mm/concepts.html> ·
overcommit accounting <https://docs.kernel.org/mm/overcommit-accounting.html> ·
cgroup v2 <https://docs.kernel.org/admin-guide/cgroup-v2.html> ·
`malloc(3)` <https://man7.org/linux/man-pages/man3/malloc.3.html> ·
`mmap(2)` <https://man7.org/linux/man-pages/man2/mmap.2.html> ·
Kubernetes resource management <https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/>

---

#### CS-015 — Filesystems from the inside: inodes, links, and space that isn't there

- **Concept:** inodes vs directory entries; hard links vs symlinks; how deletion actually works; why an open descriptor holds space; inode exhaustion vs block exhaustion.
- **DevOps relevance:** `df` says 100% full, `du` says half empty — because a deleted log is still open. Or: `df` says 40% and writes still fail — inodes are exhausted. Both are classic pager events with a five-minute fix, if you know this.
- **Type:** TROUBLE + INVEST · **Difficulty:** intermediate · **Duration:** 35 min · **Prereqs:** CS-004 · *Complements LINUX-008 (storage) — that lab is about mounts and archives; this one is about the data structure.*

**Scenario.** A Kestrel host is alerting on disk. `du -sh /var/log` shows 200 MB.
`df` shows the filesystem full. Someone already ran `rm` on the big file — that
is when the alert got worse.

**Student task.** Reproduce it: hold a file open from a seeded process, delete
it, and show `df` and `du` disagreeing while `/proc/<pid>/fd` still points at the
deleted inode. Then create the second failure — thousands of tiny files
exhausting inodes on a seeded small filesystem image — and show `df -i`.
Fix both. Record both root causes and both diagnostic commands in
`/home/student/ops/disk.txt`.

**Verification.** V4 — `process_not_running` for the holder once released,
`path_absent` for the cleaned-up files. V3 — `file_content contains` on both
diagnoses. V5 — `command_output` with `df -i`-derived evidence the student
captured.

> **Implementation note.** The inode-exhaustion half needs a small loopback
> filesystem, which requires `mknod`/`SYS_ADMIN` — **not grantable**. Fallback
> chosen for implementation: exhaust a *directory* with a seeded low-inode
> tmpfs if the provider supplies one, otherwise teach inode exhaustion through a
> seeded `df -i` capture plus the real open-descriptor half. Resolve at
> implementation time; the lab is written so the open-descriptor half alone
> carries it.

**Sources.** `inode(7)` <https://man7.org/linux/man-pages/man7/inode.7.html> ·
`ln(1)` <https://man7.org/linux/man-pages/man1/ln.1.html> ·
`statfs(2)` <https://man7.org/linux/man-pages/man2/statfs.2.html> ·
`df(1)` <https://man7.org/linux/man-pages/man1/df.1.html> ·
`du(1)` <https://man7.org/linux/man-pages/man1/du.1.html>

---

#### CS-016 — Signals and graceful shutdown

- **Concept:** signals as asynchronous notifications; SIGTERM vs SIGKILL vs SIGHUP vs SIGINT; default dispositions; handlers; what cannot be caught; exit codes 128+N.
- **DevOps relevance:** **This is the Kubernetes termination lifecycle.** SIGTERM, `terminationGracePeriodSeconds`, then SIGKILL. A service that ignores SIGTERM drops in-flight requests on every deploy. Exit code 143 vs 137 tells you which one got it.
- **Type:** PY + TROUBLE · **Difficulty:** intermediate · **Duration:** 35 min · **Prereqs:** CS-011 · *Complements LINUX-004; that lab sends signals, this one handles them.*

**Scenario.** Every Kestrel deploy drops about 40 in-flight parcel scans. The
worker exits instantly on SIGTERM, mid-batch.

**Student task.** Write `/home/student/py/worker.py` that loops processing a
seeded batch, installs a SIGTERM handler that sets a flag, finishes the current
item, writes `/home/student/ops/shutdown.log` with `GRACEFUL_EXIT items=<n>`,
and exits `0`. Prove SIGKILL cannot be handled. Record the exit codes seen for
both (`143` and `137`) in the log.

**Verification.** V1 — a seeded harness (V2) starts `worker.py`, sends SIGTERM,
waits, and asserts the process exited `0` and the log contains `GRACEFUL_EXIT`;
`script_runs` on that harness with `output_contains: ["PASS:graceful",
"PASS:sigkill-uncatchable"]`. V4 — `file_exists` on the shutdown log.

**Sources.** `signal(7)` <https://man7.org/linux/man-pages/man7/signal.7.html> ·
`kill(2)` <https://man7.org/linux/man-pages/man2/kill.2.html> ·
Python `signal` <https://docs.python.org/3/library/signal.html> ·
Kubernetes Pod lifecycle <https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/>

---

### PHASE 4 — DATA STRUCTURES

> **Framing rule for this phase.** Every lab states, in its `story`, the
> operational thing the structure explains. No lab asks the student to implement
> a structure the standard library already provides, except where implementing it
> *is* the explanation (CS-017's stack). There is no interview practice here.

---

#### CS-017 — Stacks and queues

- **Concept:** LIFO and FIFO; the call stack and how a traceback is a stack dump; work queues; bounded queues and backpressure; what "queue depth" means.
- **DevOps relevance:** Reading a traceback correctly (CS-009, now explained). Message-broker lag and consumer backpressure. Why an unbounded in-memory queue is a memory leak with a schedule. Why "requests are queuing" is a latency answer, not a CPU answer.
- **Type:** PY · **Difficulty:** intermediate · **Duration:** 35 min · **Prereqs:** CS-014

**Scenario.** Kestrel's scan ingester accepts events faster than it can write
them. Its in-memory buffer is a plain list with no ceiling. On the busiest hour
of the week it is OOMKilled — the CS-014 failure, caused by a data-structure
choice.

**Student task.** Write `/home/student/py/pipeline.py` implementing (a) a
bounded FIFO using `collections.deque(maxlen=…)` or `queue.Queue(maxsize=…)`
that *rejects* rather than grows, printing `ACCEPTED=<n> REJECTED=<n>`; and
(b) a small explicit stack that walks a nested structure without recursion.
Print `MAX_DEPTH=<n>`. Explain in `/home/student/ops/queues.txt` why rejecting is
better than growing.

**Verification.** V2 — harness feeds a fixed event burst larger than the bound
and asserts exact `ACCEPTED`/`REJECTED` counts and that peak memory did not track
input size; asserts `MAX_DEPTH` for the seeded structure. `output_contains`
`PASS:bounded`, `PASS:stack`.

**Sources.** `collections.deque` <https://docs.python.org/3/library/collections.html> ·
`queue` <https://docs.python.org/3/library/queue.html> ·
Python data structures <https://docs.python.org/3/tutorial/datastructures.html>

---

#### CS-018 — Hash maps and sets

- **Concept:** hashing; average O(1) lookup vs O(n) scan; collisions; sets for membership and de-duplication; why dict/set need hashable keys; iteration order.
- **DevOps relevance:** Why a label selector over 10,000 pods is instant. Why alert de-duplication is a set. Why an in-memory cache is a dict. Why "the lookup got slow" usually means somebody replaced a dict with a list — the exact bug measured in CS-020.
- **Type:** PY · **Difficulty:** intermediate · **Duration:** 35 min · **Prereqs:** CS-017

**Scenario.** Kestrel's alert router fires duplicate pages — the same alert
eight times in four minutes — and its lookup of depot → on-call engineer walks a
list of 4,000 entries on every event.

**Student task.** Write `/home/student/py/router.py` that (a) de-duplicates a
seeded alert stream with a set, printing `UNIQUE=<n> SUPPRESSED=<n>`, and (b)
replaces the list scan with a dict lookup, printing `LOOKUPS=<n>
NOT_FOUND=<n>`. Time both approaches and print `SPEEDUP=<x>` (an integer ratio,
rounded down).

**Verification.** V2 — harness asserts exact `UNIQUE`/`SUPPRESSED`/`NOT_FOUND`
for the shipped fixture, and asserts `SPEEDUP` ≥ a conservative threshold that a
genuine dict beats a genuine list scan by on any hardware. Exact timings are
never asserted.

**Sources.** Built-in types: `dict`, `set` <https://docs.python.org/3/library/stdtypes.html> ·
Python data structures <https://docs.python.org/3/tutorial/datastructures.html>

---

#### CS-019 — Trees and graphs

- **Concept:** trees (filesystem, DNS, JSON/YAML documents, owner references); parent/child; depth-first vs breadth-first traversal; graphs; dependency cycles; reachability.
- **DevOps relevance:** A namespace's owner-reference tree is why deleting a Deployment deletes its Pods. A Terraform dependency graph is why apply order is what it is. A cyclic import or a circular service dependency is why a deploy deadlocks. DNS is a tree; `kubectl get -o json` is a tree.
- **Type:** PY · **Difficulty:** intermediate · **Duration:** 40 min · **Prereqs:** CS-018

**Scenario.** A Kestrel service deploy hangs forever. Service A waits for B, B
waits for C, and C waits for A — nobody drew the picture.

**Student task.** Write `/home/student/py/deps.py` that loads a seeded
dependency map (JSON, CS-010 callback), prints a valid start order
(`ORDER=a,b,c,…`) when one exists, and when it does not, prints
`CYCLE=<a>-><b>-><c>-><a>` and exits `1`. Separately, walk the seeded directory
tree depth-first and print `FILES=<n> MAX_DEPTH=<n>`.

**Verification.** V2 — harness runs the student's module against three seeded
graphs: acyclic (asserts a topologically valid order, not one specific order),
cyclic (asserts exit `1` and that the reported cycle is genuinely a cycle in the
input), and single-node. `output_contains: ["PASS:order", "PASS:cycle",
"PASS:walk"]`.

> Validating *any* correct topological order rather than one hard-coded string is
> the difference between grading understanding and grading tie-break luck.

**Sources.** Python data structures <https://docs.python.org/3/tutorial/datastructures.html> ·
`os.walk` <https://docs.python.org/3/library/os.html> ·
`pathlib` <https://docs.python.org/3/library/pathlib.html> ·
`hier(7)` (the filesystem as a tree) <https://man7.org/linux/man-pages/man7/hier.7.html>

---

### PHASE 5 — ALGORITHMIC THINKING

---

#### CS-020 — Big O intuition, measured

- **Concept:** O(1), O(n), O(n log n), O(n²) as *shapes of growth*; how to recognise them by measuring; why constants matter at small n and stop mattering at large n; arrays/lists and the cost of the wrong container.
- **DevOps relevance:** "It worked in staging" is usually O(n²) meeting production data. It is the language for capacity conversations: doubling traffic doubles this and quadruples that. It also explains why an index is not optional (CS-029).
- **Type:** PY · **Difficulty:** intermediate · **Duration:** 40 min · **Prereqs:** CS-018

**Scenario.** Kestrel's nightly de-duplication took 4 minutes in July and 90
minutes in August. Volume grew 4×. Nobody changed the code — and that is the
clue.

**Student task.** Write `/home/student/py/growth.py` timing four operations —
dict lookup, list scan, sort, and a nested-loop pairwise comparison — at
n = 1 000, 2 000, 4 000, 8 000. Print one line per operation:
`OP=<name> SHAPE=<constant|linear|linearithmic|quadratic>`, classified from the
*measured ratio* as n doubles, not hard-coded. Record in
`/home/student/ops/bigo.txt` what happens to the 90-minute job when volume
doubles again.

**Verification.** V1 — `script_runs` with `output_contains` for all four
`OP=… SHAPE=…` lines. The classification is derived from timing ratios, which are
stable in *shape* across hardware even when absolute numbers are not; the
harness allows a wide ratio band so a slow or noisy sandbox still classifies
correctly.

**Sources.** `timeit` <https://docs.python.org/3/library/timeit.html> ·
`time` <https://docs.python.org/3/library/time.html> ·
built-in types (list/dict complexity in practice) <https://docs.python.org/3/library/stdtypes.html>

---

#### CS-021 — Searching, sorting, recursion, and the space you trade for time

- **Concept:** linear search vs binary search (O(n) vs O(log n)); sorting as an enabling cost; recursion and its base case; memoisation as the canonical time-for-space trade.
- **DevOps relevance:** Binary search is *why a database index exists* and why log files are searched by timestamp. Recursion is how every tree walk and every retry-with-backoff is expressed. Memoisation is caching, stated in one line — and cache invalidation is CS-030.
- **Type:** PY · **Difficulty:** intermediate · **Duration:** 40 min · **Prereqs:** CS-020

**Scenario.** Finding the first Kestrel log line after an incident timestamp
takes 12 seconds against a 2 GB sorted log. The file is sorted by time, and the
search reads it from the beginning.

**Student task.** Write `/home/student/py/search.py` with a binary search over a
seeded sorted record set returning the first record at or after a timestamp,
printing `FOUND=<record> COMPARISONS=<n>`, and a linear version printing its own
comparison count. Add a recursive function with an explicit base case, and a
memoised variant; print `CALLS_PLAIN=<n> CALLS_MEMOISED=<n>`.

**Verification.** V2 — harness asserts the binary search returns the correct
record for six probe timestamps including both boundaries and a miss; asserts
`COMPARISONS` for binary is ≤ ⌈log₂ n⌉ + 1 (a real correctness property, not a
timing); asserts the memoised call count is strictly lower. `output_contains:
["PASS:binary", "PASS:bounds", "PASS:memo"]`.

**Sources.** `bisect` <https://docs.python.org/3/library/bisect.html> ·
`functools.lru_cache` <https://docs.python.org/3/library/functools.html> ·
sorting (`sorted`, key functions) <https://docs.python.org/3/library/stdtypes.html>

---

### PHASE 6 — APPLICATION FUNDAMENTALS

---

#### CS-022 — Source, compilation, interpretation, runtime

- **Concept:** source code vs artifact vs running process; compiled (ELF) vs interpreted vs bytecode-compiled; the shebang; what "runtime" actually means; why the same source behaves differently on two machines.
- **DevOps relevance:** "It works on my machine" is a runtime statement. It explains why a container image exists at all, why a build step produces an artifact, why `__pycache__` appears in images, and why `exec format error` happens when an arm64 image lands on amd64.
- **Type:** TERM + PY · **Difficulty:** intermediate · **Duration:** 35 min · **Prereqs:** CS-010

**Scenario.** A Kestrel build passes CI and the container immediately exits with
`exec format error`. A second service ships `.pyc` files in its image and a third
ships none — and one of them starts measurably slower.

**Student task.** Use `file` on `/bin/ls` (ELF, compiled), on a shell script,
and on a `.pyc` to see three kinds of "program". Run `python3 -m py_compile` on
your own module, find the result in `__pycache__`, and use `python3 -m dis` to
see the bytecode. Make a Python file directly executable with a shebang and
`chmod +x` — the mechanism the rest of this track's grading uses. Record in
`/home/student/ops/artifacts.txt` which of the three is portable across CPU
architectures and why.

**Verification.** V4 — `script_executable` on the student's script,
`file_exists` on the `__pycache__` artifact. V1 — `script_runs` on the shebang'd
script asserting it runs without an explicit interpreter. V3 — the portability
answer.

**Sources.** `elf(5)` <https://man7.org/linux/man-pages/man5/elf.5.html> ·
`py_compile` <https://docs.python.org/3/library/py_compile.html> ·
`dis` <https://docs.python.org/3/library/dis.html> ·
Python command line <https://docs.python.org/3/using/cmdline.html>

---

#### CS-023 — Libraries, modules, dependencies and package managers

- **Concept:** modules and packages; import resolution and `sys.path`; the difference between a library and a dependency; version specifiers and pinning; lock files; transitive dependencies; environment isolation.
- **DevOps relevance:** Every supply-chain and reproducibility question. Why an unpinned dependency broke a build that changed nothing. Why lock files exist. Why virtual environments and container images solve the same problem at different layers.
- **Type:** PY · **Difficulty:** intermediate · **Duration:** 40 min · **Prereqs:** CS-022

**Scenario.** Kestrel's scan-api build failed on Tuesday. The commit changed a
README. A transitive dependency released a new minor version overnight, and
nothing was pinned.

**Student task.** Split a seeded single-file script into a package of modules
with `__init__.py` and import it — then break the import deliberately and read
`sys.path` to explain why. Given a seeded `requirements.txt` with three styles of
version specifier and a matching lock file, write
`/home/student/py/audit.py` that reports, per dependency,
`DEP=<name> PINNED=<yes|no> RESOLVED=<version>` and exits non-zero if any
production dependency is unpinned. Record the two-line answer to "what would a
lock file have prevented?" in `/home/student/ops/deps.txt`.

**Verification.** V1 — `script_runs` on `audit.py` twice: against the seeded
unpinned manifest (`expected_exit_code: 1`, `output_contains` the offending
name) and against a pinned one (`expected_exit_code: 0`). V4 — `file_exists` on
the package's `__init__.py`.

> **Sandbox reality, stated in the lab.** With `--network none` there is no
> installing from an index, so this lab **reasons about** dependency resolution
> using real manifests rather than pretending to `pip install`. That is a
> deliberate choice: the skill being taught is reading and controlling a
> dependency set, not typing `pip install`. If `python3-venv` is added to the
> image (~3 MB), an optional final step creates a real venv and shows
> `sys.path` change; without it, `python3 -m venv --without-pip` is used, which
> **was verified to work** on the stock Debian `python3` package.

**Sources.** Python modules <https://docs.python.org/3/tutorial/modules.html> ·
`sys.path` <https://docs.python.org/3/library/sys.html> ·
`venv` <https://docs.python.org/3/library/venv.html> ·
PEP 440 version specifiers <https://peps.python.org/pep-0440/> ·
pip dependency resolution <https://pip.pypa.io/en/stable/topics/dependency-resolution/> ·
PEP 668 (externally-managed environments — why Debian's Python behaves this way) <https://peps.python.org/pep-0668/>

---

#### CS-024 — Configuration, logs, and the exit-code contract

- **Concept:** configuration precedence (defaults → file → environment → flags); config vs secrets; log levels; structured vs unstructured logging; stdout as the log transport; exit codes as a machine interface.
- **DevOps relevance:** This is the lab CI/CD, Kubernetes and every log aggregator sit on top of. A container is configured by environment variables and logs to stdout because *something else* collects it. A pipeline step's only contract with the world is its exit code.
- **Type:** PY · **Difficulty:** intermediate · **Duration:** 40 min · **Prereqs:** CS-023

**Scenario.** Kestrel's importer reads its database host from three places and
nobody knows which wins. Its logs are prose, so the aggregator cannot filter
them. And its "fatal" path exits `0`.

**Student task.** Write `/home/student/py/importer.py` that resolves one setting
through the full precedence chain and prints `SOURCE=<default|file|env|flag>
VALUE=<v>`; emits JSON log lines (`{"level":…,"event":…}`) to stdout with a
level threshold from the environment; and exits `0` on success, `2` on
configuration error, `3` on data error. Record the precedence order in
`/home/student/ops/config.txt`.

**Verification.** V1 — four `script_runs` entries exercising each precedence
level (via `args` and a seeded config file) asserting the right `SOURCE=`, plus
two asserting exit codes `2` and `3`. V5 — `command_output` with `grep`+`wc`
over a captured log file confirming every line is a JSON object and that
below-threshold levels are absent.

**Sources.** `logging` <https://docs.python.org/3/library/logging.html> ·
`os.environ` <https://docs.python.org/3/library/os.html> ·
RFC 8259 (the log lines are JSON) <https://www.rfc-editor.org/rfc/rfc8259> ·
Bash exit status <https://www.gnu.org/software/bash/manual/html_node/Exit-Status.html>

---

### PHASE 7 — WEB / APPLICATION ARCHITECTURE

---

#### CS-025 — Client, server, and one HTTP request

- **Concept:** client/server; frontend vs backend; TCP sockets, ports and listening; the anatomy of an HTTP/1.1 request and response — request line, headers, blank line, body.
- **DevOps relevance:** Every ingress, load balancer, service mesh and `curl` debugging session. An engineer who has typed an HTTP request by hand into `nc` never again treats a 502 as magic — they know exactly which hop failed to answer.
- **Type:** PY + TERM · **Difficulty:** intermediate · **Duration:** 40 min · **Prereqs:** CS-024

**Scenario.** Kestrel's parcel-tracking page returns 502 from the load balancer.
The backend team says "the app is up". Both are true, and the difference is
whether anything is *listening* where the balancer is *connecting*.

**Student task.** Start a minimal server with `python3 -m http.server 8080
--bind 127.0.0.1`. Confirm it is listening with `ss -ltn`. Then speak HTTP by
hand: send a raw request through `nc 127.0.0.1 8080` and read the raw response.
Write `/home/student/py/probe.py` that opens a socket to a host/port and prints
`STATUS=<code> SERVER_UP=<yes|no>`, printing `SERVER_UP=no` — not crashing —
when the connection is refused. Run it against a port with nothing on it and
record in `/home/student/ops/http.txt` which failure a 502 corresponds to.

**Verification.** V4 — `port_listening: 8080` (the server the student started).
V1 — `script_runs` on `probe.py` twice: against `8080` (`output_contains:
["STATUS=200", "SERVER_UP=yes"]`) and against a dead port
(`output_contains: ["SERVER_UP=no"]`, `expected_exit_code: 1`). V3 for the 502
explanation.

> Loopback under `--network none` was verified end-to-end: `http.server` on
> `127.0.0.1:8080` answered `HTTP 200` inside `--network none --cap-drop ALL`.
> `curl` is not in the image and is **not requested** — `nc` and a raw socket
> teach this better.

**Sources.** RFC 9110 HTTP semantics <https://www.rfc-editor.org/rfc/rfc9110> ·
RFC 9112 HTTP/1.1 message syntax <https://www.rfc-editor.org/rfc/rfc9112> ·
RFC 9293 (TCP) <https://www.rfc-editor.org/rfc/rfc9293> ·
Python `socket` <https://docs.python.org/3/library/socket.html> ·
`http.server` <https://docs.python.org/3/library/http.server.html>

---

#### CS-026 — REST, JSON, and status codes that mean something

- **Concept:** resources and methods; safe and idempotent methods; JSON request/response bodies; the status-code classes and the ones that matter operationally — 200, 201, 301, 400, 401, 403, 404, 409, 429, 500, 502, 503, 504.
- **DevOps relevance:** The difference between 4xx and 5xx decides *whose* incident it is. 502 vs 503 vs 504 tells you whether the upstream is absent, refusing, or slow — the single most useful triage distinction in web operations. 429 is why a retry made it worse (CS-033).
- **Type:** PY · **Difficulty:** intermediate · **Duration:** 40 min · **Prereqs:** CS-025

**Scenario.** Kestrel's dashboard shows "API error rate 12%". The 12% is
entirely 404s from a client asking for parcels that do not exist, and the team
has been paging on it for a week — while a genuine 4-per-hour 500 goes unnoticed.

**Student task.** Extend a seeded `http.server` handler into
`/home/student/py/api.py` implementing `GET /parcels/<id>` returning `200` with
a JSON body, `404` with a JSON error for an unknown id, `400` for a malformed
id, and `500` for a seeded failing id. Then write a client that exercises all
four and prints `CODE=<n> CLASS=<2xx|4xx|5xx>` per call, plus
`CLIENT_ERRORS=<n> SERVER_ERRORS=<n>`. Record in `/home/student/ops/status.txt`
which of the two numbers should page someone.

**Verification.** V4 — `port_listening` for the running API. V1 — `script_runs`
on the client with `output_contains` for each of the four codes and the exact
`CLIENT_ERRORS`/`SERVER_ERRORS` split. This grades the server through its real
responses, so any correct implementation passes.

**Sources.** RFC 9110 (methods, status codes, idempotency) <https://www.rfc-editor.org/rfc/rfc9110> ·
IANA HTTP status code registry <https://www.iana.org/assignments/http-status-codes/http-status-codes.xhtml> ·
RFC 8259 (JSON) <https://www.rfc-editor.org/rfc/rfc8259> ·
RFC 3986 (URIs) <https://www.rfc-editor.org/rfc/rfc3986> ·
`http.server` <https://docs.python.org/3/library/http.server.html>

---

#### CS-027 — Authentication, authorization, and stateless vs stateful

- **Concept:** authn (who you are) vs authz (what you may do); credentials, tokens and bearer schemes; 401 vs 403; server-side session state vs stateless tokens; why state placement decides scalability.
- **DevOps relevance:** 401 vs 403 is a triage fork: bad credential, or right credential and wrong permission — which is exactly how RBAC failures present in Kubernetes and IAM. Stateless vs stateful is why sticky sessions break autoscaling and why a rolling deploy logs everybody out.
- **Type:** PY · **Difficulty:** intermediate · **Duration:** 40 min · **Prereqs:** CS-026

**Scenario.** Kestrel added a second API replica. Users now get logged out at
random — sessions live in one process's memory, and the load balancer does not
care which replica you reach.

**Student task.** Extend the API from CS-026: reject a missing/invalid token
with `401`, reject a valid token lacking the `depot:write` scope with `403`, and
accept otherwise. Implement the session two ways — an in-memory dict (stateful)
and a signed, self-describing token (stateless, using `hmac`/`hashlib` from the
stdlib) — and demonstrate that only the second survives being served by a second
process. Print `MODE=<stateful|stateless> SURVIVED_RESTART=<yes|no>`. Record in
`/home/student/ops/auth.txt` which failure mode 401 and 403 each represent.

**Verification.** V2 — harness drives the API through six cases (no token, bad
token, valid token wrong scope, valid token right scope, and both session modes
across a restart), asserting exact status codes and both `SURVIVED_RESTART`
values. `output_contains: ["PASS:401", "PASS:403", "PASS:stateless-survives",
"PASS:stateful-loses"]`.

> Content note: the lab uses a **signed** token to teach statelessness; it is
> explicitly *not* a lesson in writing your own auth, and the lab text says so
> and points at the standards below.

**Sources.** RFC 9110 §11 (authentication, 401 vs 403) <https://www.rfc-editor.org/rfc/rfc9110> ·
RFC 6750 (bearer tokens) <https://www.rfc-editor.org/rfc/rfc6750> ·
RFC 7519 (JWT — read, not implemented) <https://www.rfc-editor.org/rfc/rfc7519> ·
`hmac` <https://docs.python.org/3/library/hmac.html> ·
`secrets` <https://docs.python.org/3/library/secrets.html>

---

### PHASE 8 — DATABASE FUNDAMENTALS

> **Engine note.** These labs run on **SQLite via the Python standard library**
> (verified: 3.40.1, zero extra packages, no network). SQLite is what the student
> *touches*; PostgreSQL is what they will *meet in production*, so each lab cites
> both and states plainly which behaviours are engine-specific (isolation
> levels, MVCC, pooling) rather than universal. Nothing is claimed about
> PostgreSQL that is not in PostgreSQL's own documentation.

---

#### CS-028 — Tables, rows, keys and SQL

- **Concept:** the relational model — tables, rows, columns, types; primary keys; foreign keys; `SELECT`/`INSERT`/`UPDATE`/`DELETE`; `WHERE`, `ORDER BY`, `GROUP BY`, `JOIN`; NULL.
- **DevOps relevance:** An SRE reads the database during incidents: how many rows, since when, which ones are stuck. Knowing a primary key is why a duplicate insert fails, and a foreign key is why a delete does — both are common "the app is throwing 500s" root causes.
- **Type:** PY · **Difficulty:** intermediate · **Duration:** 40 min · **Prereqs:** CS-010

**Scenario.** Kestrel's parcel table has duplicate tracking numbers. The column
was never a primary key, and two importer instances now insert the same parcel
twice.

**Student task.** Write `/home/student/py/parcels.py` that creates a schema with
a primary key and a foreign key from scans → parcels, loads a seeded dataset,
and answers three questions in SQL: parcels per depot, the ten oldest undelivered
parcels, and scans with no matching parcel. Print
`DEPOTS=<n> OLDEST=<id> ORPHANS=<n>`. Demonstrate that inserting a duplicate
tracking number now raises, and handle it (CS-009 callback).

**Verification.** V1/V2 — harness runs the student's script against the shipped
dataset and asserts the three exact answers, then independently opens the
resulting database file and asserts the primary key and foreign key exist in the
schema. Grading the *database that was produced* means any correct SQL passes.

**Sources.** Python `sqlite3` <https://docs.python.org/3/library/sqlite3.html> ·
SQLite SQL syntax <https://www.sqlite.org/lang.html> ·
PostgreSQL tutorial: SQL <https://www.postgresql.org/docs/current/tutorial-sql.html> ·
PostgreSQL constraints <https://www.postgresql.org/docs/current/ddl-constraints.html>

---

#### CS-029 — Indexes, query plans, transactions and ACID

- **Concept:** what an index is (CS-021's binary search, on disk); the cost of an index on write; reading a query plan; transactions; commit and rollback; ACID as four separate promises; isolation.
- **DevOps relevance:** "The database is slow" is nearly always a missing index or a query that stopped using one — visible in a plan, not in CPU graphs. Transactions are why a half-finished migration does not corrupt data, and long-running transactions are a top cause of database incidents.
- **Type:** PY + INVEST · **Difficulty:** intermediate · **Duration:** 45 min · **Prereqs:** CS-028, CS-021

**Scenario.** Kestrel's tracking lookup took 8 ms in January and 900 ms now. The
query is unchanged; the table has grown 200×. And last week a failed bulk update
left half the parcels marked delivered.

**Student task.** Measure the lookup on the seeded large table, read the plan
with `EXPLAIN QUERY PLAN`, add the index, and measure again — printing
`BEFORE_SCAN=<yes|no> AFTER_INDEX=<yes|no> SPEEDUP=<x>`. Then write a bulk update
inside an explicit transaction that rolls back on error, and prove with a
`SELECT` that no partial change survives, printing `ROLLED_BACK=<n>
PARTIAL_ROWS=0`. Record in `/home/student/ops/db.txt` what an index costs on
write.

**Verification.** V2 — harness asserts the plan changed from a scan to an index
search (read from `EXPLAIN QUERY PLAN` output, not from timing), that the index
exists in the schema, and that after the failed bulk update `PARTIAL_ROWS=0`.
`output_contains: ["PASS:index-used", "PASS:atomic"]`.

**Sources.** SQLite query planner <https://www.sqlite.org/optoverview.html> ·
`EXPLAIN QUERY PLAN` <https://www.sqlite.org/eqp.html> ·
SQLite transactions <https://www.sqlite.org/lang_transaction.html> and atomic commit <https://www.sqlite.org/transactional.html> ·
SQLite isolation <https://www.sqlite.org/isolation.html> ·
PostgreSQL indexes <https://www.postgresql.org/docs/current/indexes.html> ·
PostgreSQL transactions <https://www.postgresql.org/docs/current/tutorial-transactions.html> ·
PostgreSQL MVCC <https://www.postgresql.org/docs/current/mvcc.html>

---

#### CS-030 — Connection pools, caching, and when not to use SQL

- **Concept:** why a connection is expensive; pool size and saturation; queueing for a connection vs queueing in the database; cache hit ratio; TTL and invalidation; key-value and document stores and what they trade away.
- **DevOps relevance:** **`FATAL: remaining connection slots are reserved`** — connection exhaustion is one of the most common database outages, and it is usually an application-side pool sized wrong times a replica count nobody multiplied. Caching is the first scaling lever, and cache invalidation is the first correctness bug.
- **Type:** PY + TROUBLE · **Difficulty:** intermediate · **Duration:** 40 min · **Prereqs:** CS-029

**Scenario.** Kestrel scaled the API from 4 to 20 replicas on Black Friday. Each
replica opens a pool of 10 connections. The database allows 100. The API went
down at the moment it scaled *up*.

**Student task.** Write `/home/student/py/pool.py` implementing a bounded
connection pool with a wait timeout over the seeded SQLite database, driven by
more concurrent workers than connections. Print
`POOL=<n> WORKERS=<n> SERVED=<n> TIMEOUTS=<n> MAX_WAIT_MS=<n>`. Compute
`20 × 10` against a 100-connection ceiling and record the arithmetic in
`/home/student/ops/pool.txt`. Add a TTL cache in front of the hottest query and
print `CACHE_HITS=<n> CACHE_MISSES=<n> HIT_RATIO=<pct>`, then demonstrate a stale
read after an update and state the fix.

**Verification.** V2 — harness asserts: with workers > pool size some requests
wait and none are lost; with a pool of 1 the timeout count is non-zero; the
cache hit ratio for the seeded access pattern is within a stated band; and the
stale read is demonstrated then eliminated. `output_contains: ["PASS:bounded",
"PASS:timeout", "PASS:cache", "PASS:invalidation"]`. V3 — the `200 > 100`
arithmetic in the findings file.

**Sources.** PostgreSQL connection settings (`max_connections`) <https://www.postgresql.org/docs/current/runtime-config-connection.html> ·
Python `sqlite3` <https://docs.python.org/3/library/sqlite3.html> ·
`queue` (the pool's waiting semantics) <https://docs.python.org/3/library/queue.html> ·
`functools.lru_cache` <https://docs.python.org/3/library/functools.html> ·
RFC 9111 (HTTP caching — the same TTL/invalidation ideas, standardised) <https://www.rfc-editor.org/rfc/rfc9111>

---

### PHASE 9 — DISTRIBUTED SYSTEM FUNDAMENTALS

---

#### CS-031 — Latency, throughput and percentiles

- **Concept:** latency vs throughput; they are not the same and improving one can worsen the other; the average is the wrong number; p50/p95/p99; tail latency; how queueing turns a small utilisation change into a large latency change.
- **DevOps relevance:** SLOs, dashboards and alert thresholds are all this. "Average response time is 120 ms" while p99 is 4 s means 1 in 100 users is having a bad time — and at 10 requests per second that is 6 unhappy users a minute.
- **Type:** PY · **Difficulty:** intermediate · **Duration:** 40 min · **Prereqs:** CS-026

**Scenario.** Kestrel's tracking API dashboard is green — mean latency 120 ms.
Support has 40 complaints today. Both are accurate.

**Student task.** Write `/home/student/py/latency.py` reading a seeded latency
sample and printing `COUNT=<n> MEAN=<ms> P50=<ms> P95=<ms> P99=<ms> MAX=<ms>`.
Then increase the offered load against the CS-026 API and show throughput rising
while p99 rises faster; print `RPS=<n> P99=<ms>` per step. Record in
`/home/student/ops/latency.txt` why the mean hid the problem, and which
percentile the SLO should use.

**Verification.** V1 — `script_runs` with `output_contains` for the exact
percentile values of the shipped sample (deterministic — the fixture is fixed),
which also forces a correct percentile definition rather than a hand-wave. The
load-step half is graded on the presence and monotonicity of the `RPS=`/`P99=`
lines, never on absolute timings.

**Sources.** `statistics` (`quantiles`) <https://docs.python.org/3/library/statistics.html> ·
`time.perf_counter` <https://docs.python.org/3/library/time.html> ·
Kubernetes autoscaling (where these numbers are consumed) <https://kubernetes.io/docs/concepts/workloads/autoscaling/>

---

#### CS-032 — Scaling, replication, consistency and the single point of failure

- **Concept:** vertical vs horizontal scaling; statelessness as the precondition for horizontal scaling; replication; strong vs eventual consistency; read-after-write; availability as a product of dependencies; the single point of failure.
- **DevOps relevance:** Why "just add replicas" fails for stateful services (CS-027). Why a user updates their address and sees the old one — a replica lag bug, not a UI bug. Why one shared component with 99% availability caps the whole system below every other component's SLA.
- **Type:** PY · **Difficulty:** advanced · **Duration:** 45 min · **Prereqs:** CS-027, CS-030

**Scenario.** Kestrel moved reads to a replica. Customers who update a delivery
address are shown the old one for a few seconds — and the support team is filing
it as data loss. Meanwhile every one of the twelve services depends on one
metadata service.

**Student task.** Write `/home/student/py/replicas.py` simulating a primary and
two replicas with a configurable propagation delay over loopback or in-process:
write to the primary, read from a replica, and print
`WRITE_AT=<t> READ_AT=<t> STALE=<yes|no> CONVERGED_AFTER_MS=<n>`. Show that
read-your-own-writes is restored by reading from the primary, printing
`RYOW=<yes|no>`. Then compute the availability of a seeded dependency chain and
print `CHAIN_AVAILABILITY=<pct> SPOF=<component>`.

**Verification.** V2 — harness asserts a stale read is observed with a
propagation delay, that convergence occurs, that `RYOW=yes` in primary-read mode,
and that the SPOF and chain availability match the seeded topology exactly (pure
arithmetic — fully deterministic). `output_contains: ["PASS:stale", "PASS:converged",
"PASS:ryow", "PASS:spof"]`.

**Sources.** Kubernetes Services (how replicas are addressed) <https://kubernetes.io/docs/concepts/services-networking/service/> ·
Kubernetes autoscaling <https://kubernetes.io/docs/concepts/workloads/autoscaling/> ·
PostgreSQL MVCC (what consistency means to one engine) <https://www.postgresql.org/docs/current/mvcc.html> ·
`threading` / `time` <https://docs.python.org/3/library/threading.html>

---

#### CS-033 — Timeouts, retries, idempotency, queues and race conditions

- **Concept:** why every remote call needs a timeout; retries and exponential backoff with jitter; the retry storm; idempotency and idempotency keys; queues for decoupling; race conditions and the lost update.
- **DevOps relevance:** The mechanics of a cascading failure: a slow dependency, no timeout, retries amplifying load, a thundering herd on recovery. Idempotency is why a retried payment does not charge twice. Race conditions are why "it only happens under load" — the hardest class of production bug.
- **Type:** PY · **Difficulty:** advanced · **Duration:** 45 min · **Prereqs:** CS-032, CS-017

**Scenario.** A Kestrel dependency slowed from 50 ms to 3 s. The client had no
timeout and retried three times immediately. Load on the struggling service
**quadrupled**, it fell over, and when it came back every client retried at the
same instant and knocked it down again. Some parcels were also marked delivered
twice.

**Student task.** Write `/home/student/py/resilient.py` calling a seeded flaky
endpoint with (a) no timeout and immediate retries — recording the amplification
factor; then (b) a timeout plus exponential backoff with jitter. Print
`ATTEMPTS=<n> AMPLIFICATION=<x> SUCCEEDED=<yes|no> TOTAL_MS=<n>` for both.
Then make the "mark delivered" operation idempotent with a key so a retry is
harmless, printing `DELIVERED_COUNT=1` after three identical submissions.
Finally, demonstrate a lost update from two concurrent readers-then-writers and
fix it, printing `LOST_UPDATE=<yes|no>` before and after.

**Verification.** V2 — harness asserts: amplification > 1 without backoff and
bounded with it; retry intervals are non-uniform (jitter present) and increasing
(exponential); `DELIVERED_COUNT=1` after three identical calls; and
`LOST_UPDATE=yes` before the fix, `no` after. `output_contains: ["PASS:backoff",
"PASS:jitter", "PASS:idempotent", "PASS:race-fixed"]`.

**Sources.** RFC 9110 (idempotent and safe methods — the normative definition) <https://www.rfc-editor.org/rfc/rfc9110> ·
RFC 9110 §15.5.29 429 Too Many Requests, and RFC 9111 for cached retries <https://www.rfc-editor.org/rfc/rfc9111> ·
Python `queue` <https://docs.python.org/3/library/queue.html> ·
`threading` (locks and the lost update) <https://docs.python.org/3/library/threading.html> ·
`secrets` (jitter, idempotency keys) <https://docs.python.org/3/library/secrets.html>

---

### PHASE 10 — SRE TROUBLESHOOTING CAPSTONES

> Both capstones are `level: assessment`. They ship **no starter code and no
> step-by-step task list** — only a symptom, exactly as a page arrives. Hints
> unlock the diagnostic ladder, never the answer.

---

#### CS-034 — Capstone: "the tracking API got slow at 09:14"

- **Concept:** the whole application path — HTTP, database, index, pool, cache, percentiles, data structures — under one symptom.
- **DevOps relevance:** This *is* the job. The skill being assessed is forming and discarding hypotheses in the right order, and reading evidence instead of guessing.
- **Type:** TROUBLE · **Difficulty:** advanced · **Duration:** 50 min · **Prereqs:** CS-031, CS-030, CS-029, CS-026 · **Level:** assessment

**Scenario.** At 09:14 the Kestrel tracking API's p99 went from 90 ms to 6 s.
CPU is flat. Memory is flat. No deploy went out. The service is "up" and the
health check is green. Three things were seeded to be wrong, and only one of
them matters.

**Student task.** Diagnose and fix. Produce `/home/student/ops/incident.md`
containing: the symptom, the measured evidence (with numbers), the root cause,
the fix applied, and one thing that would have detected it sooner. Leave the API
serving p99 under the stated target.

**Verification.** V4 — `port_listening` (the API is still up) and the schema
change or configuration fix is present in live state. V2 — a harness re-measures
p99 against the running service and asserts it is under target, and asserts the
seeded root cause is genuinely gone. V3 — `command_output` with `grep` over
`incident.md` confirming each required section exists and names the actual root
cause. **A student who restarts the service without fixing the cause fails the
re-measurement**, which is the point.

**Sources.** As CS-026, CS-029, CS-030, CS-031 — the capstone introduces no new
material and cites no new sources.

---

#### CS-035 — Capstone: "the worker is OOMKilled every afternoon"

- **Concept:** the whole systems path — memory, data structures, queues, file descriptors, signals, exit codes — under one symptom.
- **DevOps relevance:** The single most common "why is my pod restarting" investigation, requiring the student to distinguish a memory *leak* from a memory *limit* from an unbounded *queue*, and to read the exit code correctly.
- **Type:** TROUBLE · **Difficulty:** advanced · **Duration:** 50 min · **Prereqs:** CS-016, CS-017, CS-014, CS-004 · **Level:** assessment

**Scenario.** Kestrel's scan worker restarts every afternoon between 14:00 and
16:00 — the daily peak. The container's last state shows exit code 137. Someone
has already doubled the memory limit twice; it now dies later, but it still
dies. Separately, the graceful-shutdown log has been empty since March.

**Student task.** Find why memory grows without bound (it is a structure, not a
leak in the C sense), fix it, and prove the fix under the same load. Restore
graceful shutdown so a restart stops losing in-flight scans. Write
`/home/student/ops/postmortem.md` with the timeline, evidence, root cause, fix,
and the difference between exit codes 137 and 143.

**Verification.** V2 — harness runs the fixed worker under the seeded peak load
and asserts RSS stabilises rather than tracking input size, and that a SIGTERM
produces a graceful-exit record and exit `0`. V4 — `file_exists` on the
shutdown log. V3 — `grep` over `postmortem.md` for the required sections and both
exit codes.

**Sources.** As CS-014, CS-016, CS-017 — no new material.

---

## 8. Lab summary

| ID | Title | Type | Diff. | Min | Prereqs |
|---|---|---|---|---|---|
| CS-001 | What a machine actually is | INVEST | beginner | 25 | — |
| CS-002 | Bits, bytes, hex, and the units that page you | TERM+PY | beginner | 30 | CS-001 |
| CS-003 | Text, encoded: ASCII, UTF-8 and Unicode | TERM+PY | beginner | 30 | CS-002 |
| CS-004 | Files, file descriptors, and "too many open files" | INVEST+PY | beginner | 30 | CS-001 |
| CS-005 | The process contract: streams, exit codes, environment | TERM | beginner | 30 | CS-004 |
| CS-006 | Variables, types and control flow | PY | beginner | 40 | CS-005 |
| CS-007 | Lists and dictionaries: from lines to structure | PY | beginner | 35 | CS-006 |
| CS-008 | Strings and text processing | PY | beginner | 35 | CS-007 |
| CS-009 | Errors, exceptions and failing usefully | PY | beginner | 35 | CS-008 |
| CS-010 | JSON and YAML: the formats infrastructure speaks | PY | beginner | 40 | CS-009 |
| CS-011 | Process lifecycle: fork, exec, PID, zombies, PID 1 | INVEST+PY | beginner | 35 | CS-005 |
| CS-012 | User space, kernel space and system calls | INVEST | intermediate | 35 | CS-011 |
| CS-013 | Threads, scheduling and context switching | PY+INVEST | intermediate | 40 | CS-011 |
| CS-014 | Virtual memory: stack, heap, RSS vs VSZ, OOM killer | PY+INVEST | intermediate | 40 | CS-013 |
| CS-015 | Filesystems from the inside: inodes, links, phantom space | TROUBLE+INVEST | intermediate | 35 | CS-004 |
| CS-016 | Signals and graceful shutdown | PY+TROUBLE | intermediate | 35 | CS-011 |
| CS-017 | Stacks and queues | PY | intermediate | 35 | CS-014 |
| CS-018 | Hash maps and sets | PY | intermediate | 35 | CS-017 |
| CS-019 | Trees and graphs | PY | intermediate | 40 | CS-018 |
| CS-020 | Big O intuition, measured | PY | intermediate | 40 | CS-018 |
| CS-021 | Searching, sorting, recursion, time vs space | PY | intermediate | 40 | CS-020 |
| CS-022 | Source, compilation, interpretation, runtime | TERM+PY | intermediate | 35 | CS-010 |
| CS-023 | Libraries, modules, dependencies, package managers | PY | intermediate | 40 | CS-022 |
| CS-024 | Configuration, logs, and the exit-code contract | PY | intermediate | 40 | CS-023 |
| CS-025 | Client, server, and one HTTP request | PY+TERM | intermediate | 40 | CS-024 |
| CS-026 | REST, JSON, and status codes that mean something | PY | intermediate | 40 | CS-025 |
| CS-027 | Authentication, authorization, stateless vs stateful | PY | intermediate | 40 | CS-026 |
| CS-028 | Tables, rows, keys and SQL | PY | intermediate | 40 | CS-010 |
| CS-029 | Indexes, query plans, transactions and ACID | PY+INVEST | intermediate | 45 | CS-028, CS-021 |
| CS-030 | Connection pools, caching, and when not to use SQL | PY+TROUBLE | intermediate | 40 | CS-029 |
| CS-031 | Latency, throughput and percentiles | PY | intermediate | 40 | CS-026 |
| CS-032 | Scaling, replication, consistency and the SPOF | PY | advanced | 45 | CS-027, CS-030 |
| CS-033 | Timeouts, retries, idempotency, queues, race conditions | PY | advanced | 45 | CS-032, CS-017 |
| CS-034 | Capstone: "the tracking API got slow at 09:14" | TROUBLE | advanced | 50 | CS-026/029/030/031 |
| CS-035 | Capstone: "the worker is OOMKilled every afternoon" | TROUBLE | advanced | 50 | CS-004/014/016/017 |

**Totals:** 35 labs · ≈ 1 305 minutes (≈ 21 h 45 m) · 10 beginner, 21 intermediate, 4 advanced · 2 assessment-level.

---

## 9. Topic coverage — every topic in the brief, mapped

**COMPUTER FUNDAMENTALS**

| Topic | Lab(s) |
|---|---|
| CPU | CS-001, CS-013 |
| memory / RAM | CS-001, CS-014 |
| storage | CS-001, CS-015 |
| processes | CS-011 |
| threads | CS-013 |
| kernel | CS-012 |
| user space vs kernel space | CS-012 |
| system calls | CS-012 |
| files and file descriptors | CS-004 |
| stdin / stdout / stderr | CS-005 |
| environment variables | CS-005, CS-024 |

**DATA REPRESENTATION**

| Topic | Lab(s) |
|---|---|
| bits, bytes, binary | CS-002 |
| hexadecimal | CS-002 |
| text encoding, ASCII, Unicode | CS-003 |
| KB / MB / GB (and KiB / MiB / GiB) | CS-002 |
| network byte concepts | CS-003 (byte order, multi-byte sequences), CS-025 (bytes on the wire) |

**OPERATING SYSTEM CONCEPTS**

| Topic | Lab(s) |
|---|---|
| process lifecycle, PID, parent/child | CS-011 |
| threads | CS-013 |
| scheduling, context switching | CS-013 |
| virtual memory | CS-014 |
| stack vs heap, memory allocation | CS-014 |
| filesystems | CS-015 |
| permissions | CS-015 (mode as inode metadata), CS-022 (`chmod +x`) — **taught operationally by LINUX-002; not duplicated here** |
| signals | CS-016 |

**PROGRAMMING FUNDAMENTALS**

| Topic | Lab(s) |
|---|---|
| variables, data types | CS-006 |
| conditions, loops, functions | CS-006 |
| arrays / lists | CS-007, CS-020 |
| maps / dictionaries | CS-007, CS-018 |
| strings | CS-008 |
| errors / exceptions | CS-009 |
| modules / packages | CS-023 |
| JSON | CS-010, CS-026 |
| YAML | CS-010 |

**DATA STRUCTURES**

| Topic | Lab(s) |
|---|---|
| arrays, lists | CS-007, CS-020 |
| stacks, queues | CS-017 |
| hash maps, sets | CS-018 |
| trees, basic graphs | CS-019 |

**ALGORITHMIC THINKING**

| Topic | Lab(s) |
|---|---|
| Big O intuition, O(1), O(n) | CS-020 |
| O(log n) | CS-021 |
| searching | CS-021 |
| sorting | CS-020, CS-021 |
| recursion basics | CS-021 (also CS-019 traversal) |
| time vs space tradeoffs | CS-021, CS-030 |

**APPLICATION FUNDAMENTALS**

| Topic | Lab(s) |
|---|---|
| source code, compilation, interpretation, runtime | CS-022 |
| libraries, dependencies, package managers | CS-023 |
| environment variables, configuration | CS-024 |
| logs | CS-024 |
| exit codes | CS-005, CS-024 |

**WEB / APPLICATION ARCHITECTURE**

| Topic | Lab(s) |
|---|---|
| client/server, frontend/backend | CS-025 |
| API, REST | CS-026 |
| HTTP request/response | CS-025, CS-026 |
| JSON | CS-026 |
| status codes | CS-026 |
| authentication vs authorization | CS-027 |
| stateless vs stateful | CS-027, CS-032 |

**DATABASE FUNDAMENTALS**

| Topic | Lab(s) |
|---|---|
| relational databases, tables, rows, primary keys | CS-028 |
| SQL basics | CS-028 |
| indexes | CS-029 |
| transactions, ACID intuition | CS-029 |
| connection pools | CS-030 |
| NoSQL concepts | CS-030 |
| caching | CS-030, CS-033 |

**DISTRIBUTED SYSTEM FUNDAMENTALS**

| Topic | Lab(s) |
|---|---|
| latency, throughput | CS-031 |
| availability | CS-032 |
| scalability, horizontal vs vertical | CS-032 |
| replication | CS-032 |
| consistency, eventual consistency | CS-032 |
| queues | CS-017, CS-033 |
| retries, timeouts | CS-033 |
| idempotency | CS-033 |
| caching | CS-030, CS-033 |
| race conditions | CS-033 |
| single points of failure | CS-032 |

**THE DEVOPS CONNECTION — the brief's own examples**

| "Why do I need this?" | Answered by |
|---|---|
| processes → troubleshooting application crashes | CS-011, CS-016, CS-035 |
| memory → OOMKilled investigation | CS-014, CS-017, CS-035 |
| file descriptors → "too many open files" | CS-004 |
| exit codes → CI/CD pipeline failures | CS-005, CS-024 |
| HTTP → ALB / Kubernetes troubleshooting | CS-025, CS-026, CS-034 |
| data structures → understanding application behaviour | CS-017, CS-018, CS-019, CS-020 |
| databases → diagnosing connection exhaustion | CS-030, CS-034 |
| distributed systems → production reliability | CS-031, CS-032, CS-033 |

**Coverage: every topic listed in the brief maps to at least one lab.**

---

## 10. Dependencies and decisions needed before implementation

| # | Item | Owner | Blocking? |
|---|---|---|---|
| 1 | **Python 3 in the CS sandbox** — Option A (add `python3` to `sandbox-linux.Dockerfile`, +47 MB) or Option B (new `cs` provider + image). §3.2. | Linux / platform track | **Yes — blocks 27 of 35 labs** |
| 2 | `python3-venv` (~3 MB) — optional, improves CS-023 only. Lab works without it. | Linux / platform track | No |
| 3 | Confirm `labs/cs/track.yaml` `order: 5` is the intended catalog position | Curriculum owner | No |
| 4 | CS-015 inode-exhaustion half: needs a low-inode filesystem the sandbox cannot create (`SYS_ADMIN` not grantable). Fallback stated in the lab. | This branch, at implementation | No |
| 5 | Source-metadata schema extension (`sources[].type`, `last_verified`, certification objective/version) — see `SOURCES.md` §7 | Platform track | No — documented, not implemented |

**Nothing else is required.** No new provider, no new requirement type, no change
to `VERIFIER_COMMANDS`, no new capability, no network access, no third-party
Python package.

---

## 11. Implementation order, and what gets cut first

**Build order** — each block is independently shippable, and every block ends
somewhere a student can usefully stop:

1. **CS-001 … CS-005** — proves the track end to end on the platform, and is the
   only block that runs *without* Python (CS-002/003 have Python halves that can
   be deferred if item 1 above is still open). Ship this first.
2. **CS-006 … CS-010** — programming foundations; unblocks everything after.
3. **CS-011 … CS-016** — OS concepts; highest DevOps value per lab in the track.
4. **CS-017 … CS-021** — data structures and algorithms.
5. **CS-022 … CS-024** — application fundamentals.
6. **CS-025 … CS-027** — web architecture.
7. **CS-028 … CS-030** — databases.
8. **CS-031 … CS-033** — distributed systems.
9. **CS-034, CS-035** — capstones, last, because they assess everything above.

**If 35 proves too many,** cut in this order — each is a genuine loss, listed
least-damaging first:

1. **CS-008** (strings) — fold the parsing into CS-007. → 34
2. **CS-003** (encoding) — fold the essentials into CS-002. → 33 *(reluctantly:
   this is the cheapest lab to cut and the most annoying to have skipped when a
   student meets their first `UnicodeDecodeError`)*
3. **CS-019** (trees and graphs) — the least directly operational data-structure
   lab. → 32
4. **CS-012** (system calls) — conceptually valuable, least often *acted* on. → 31

Do **not** cut: CS-004, CS-005, CS-014, CS-016, CS-024, CS-026, CS-030, CS-033,
or either capstone. Each maps directly to a named production failure in the
brief.

---

## 11b. Authoring constraints carried forward

Recorded here because they bind labs that are planned but not yet written, and
a plan is where a constraint survives longest.

### CS-015 stays BLOCKED

Its inode-exhaustion half needs a filesystem whose inode table can be
exhausted, which needs `mknod`/`SYS_ADMIN`. **`SYS_ADMIN` is outside the
accepted student sandbox privilege boundary and must not be granted to make
this lab testable** — `linux-provider.ts` refuses it by construction, and that
refusal is worth more than one lab's second half.

**The documented fallback stands:** ship CS-015 with the open-descriptor half
only — a deleted-but-still-open file, where `df` and `du` disagree and
`/proc/<pid>/fd` explains why. That half needs no extra privilege, is the more
common production failure of the two, and carries the lab on its own. Inode
exhaustion is then taught from a seeded `df -i` capture rather than induced.

**Recommendation:** take the fallback. Revisit only if the platform ever gains
a privileged-fixture mechanism for reasons of its own; do not introduce one for
this.

### Timing-sensitive labs must not grade on wall-clock thresholds

**CS-018, CS-020, CS-031, CS-032 and CS-034** were each sketched with a timing
assertion. On a contended machine those fail for reasons that have nothing to
do with the student: this repository's own suite has been observed timing out
under load averages above 30 while every assertion in it was sound.

**None of these labs may grade "must complete within X milliseconds."** Grade
instead:

| Instead of | Assert |
|---|---|
| absolute duration | **ordering** — which finished first, which came after what |
| a speed multiple | **shape** — does the curve bend the way an O(n²) curve bends, over a wide tolerance band |
| elapsed wall clock | **causality** — the retry happened *because* the first attempt failed |
| a throughput number | **relative behaviour** — more concurrency produced more completed work than less did |
| a latency ceiling | **observable state** — the queue drained, the file appeared, the counter advanced |

CS-020's classification of O(1)/O(n)/O(n log n)/O(n²) is legitimate because it
compares ratios as *n* doubles rather than absolute times, and because its
tolerance band is wide enough that a slow host still classifies correctly.
CS-021 is the model to copy: it asserts a *comparison count* bounded by
⌈log₂ n⌉ + 1, which is a correctness property and cannot flake at all.

## 12. Official-source policy compliance

This plan was written against the JumpToTech official-source policy. In summary:

- **The CS track is classified `FOUNDATIONAL SKILL`, not a certification track**
  (policy §8). No lab claims a certification objective; every lab's
  `certification:` block will be empty.
- **Every source cited in §7 is official**: docs.python.org, man7.org Linux
  man-pages, docs.kernel.org, gnu.org, rfc-editor.org, iana.org, unicode.org,
  yaml.org, sqlite.org, postgresql.org, packaging.python.org, peps.python.org,
  kubernetes.io, docs.docker.com. **All 118 URLs were fetched and returned
  HTTP 200 on 2026-08-23.**
- **No third-party training content** informed this plan — no exam dumps, no
  KodeKloud/Udemy/A Cloud Guru, no blogs, Reddit, Medium or YouTube. The
  platform's own `DISALLOWED_DOC_HOSTS` list is respected by construction.
- **All scenarios are original**: Kestrel Logistics, its incidents, its seeded
  failures, the task wording, the hints and the verifier logic are
  JumpToTech-authored. Official documentation determines what is *correct*;
  students are linked to it rather than shown copies of it.
- One obsoleted RFC (**7235**) was identified during source verification and
  **removed** in favour of its current replacement, RFC 9110.

The full policy review — objectives confirmed, certification mapping, production
skills vs exam objectives, per-lab source list, gaps, corrections, and the
proposed coverage matrix — is in **[`SOURCES.md`](./SOURCES.md)**.
