# CS track — official-source policy review

**Reviews:** [`CURRICULUM.md`](./CURRICULUM.md) — the 35-lab Computer Science Fundamentals plan
**Against:** JumpToTech official-source curriculum policy (§§1–13)
**Branch:** `claude/cs-fundamentals` · **Review date:** 2026-08-23
**Verification method:** every URL in this document and in `CURRICULUM.md` was
fetched over HTTPS on 2026-08-23; **118 / 118 returned HTTP 200**. Certification
domain lists were read from the certifying body's own page, not from memory.

---

## 1. Objectives confirmed from official sources

### 1.1 The CS track has no certification objectives — by design

Policy §8 states CS fundamentals are not a certification track by default. This
plan takes that literally:

> **The CS track is classified `FOUNDATIONAL SKILL`. No CS lab claims a
> certification objective, and every CS lab will ship with an empty
> `certification:` block.**

There is therefore **nothing to confirm** in the "current official exam
objectives" sense, and inventing a mapping would breach policy §1 ("do not
invent certification objectives"). What *was* confirmed instead is the technical
source of truth for every concept the track teaches (§5 below).

### 1.2 What was confirmed, and from where

| Authority | What it is the source of truth for | Confirmed |
|---|---|---|
| docs.python.org | Python language and standard library — 40 pages cited | 200 ✓ |
| man7.org Linux man-pages | syscalls, `proc(5)`, signals, inodes, limits — 28 pages | 200 ✓ |
| docs.kernel.org | memory management, cgroup v2, scheduler, procfs — 6 pages | 200 ✓ |
| gnu.org | Bash (redirection, exit status, environment), coreutils — 6 pages | 200 ✓ |
| rfc-editor.org | HTTP, JSON, URI, UTF-8, ASCII, TCP, bearer tokens — 9 RFCs | 200 ✓ |
| iana.org | HTTP status code registry, character sets | 200 ✓ |
| unicode.org | The Unicode Standard | 200 ✓ |
| yaml.org | YAML 1.2.2 specification | 200 ✓ |
| sqlite.org | The engine students actually run — SQL, planner, transactions | 200 ✓ |
| postgresql.org | The production engine — indexes, MVCC, `max_connections` | 200 ✓ |
| packaging.python.org / peps.python.org / pip.pypa.io | dependency specification and resolution | 200 ✓ |
| kubernetes.io | where these concepts are consumed (Pod lifecycle, resources) | 200 ✓ |
| docs.docker.com | container resource constraints | 200 ✓ |

### 1.3 Certification objectives confirmed *incidentally*

Because CS-011 – CS-016 sit close to Linux-track material, the **current official
LFCS domain list** was read from the Linux Foundation's own certification page in
order to decide whether any CS lab should claim LFCS coverage:

> **Current official LFCS domains** (training.linuxfoundation.org, read 2026-08-23):
> **Operations Deployment 25% · Networking 25% · Storage 20% · Essential Commands 20% · Users and Groups 10%**

**Decision: no CS lab claims LFCS.** The CS labs teach the concepts *underneath*
those domains (what a signal is, what an inode is), not the administrative tasks
the domains describe. Claiming coverage would be exactly the overreach policy §5
prohibits.

This reading also surfaced a conflict in existing Linux-track labs — see §7.1.

---

## 2. Labs directly mapped to current certification objectives

**None. Zero of 35.**

This is the correct and intended outcome, not a gap. Per policy §8, CS
fundamentals are marked `FOUNDATIONAL SKILL` rather than presented as exam
preparation. Any future claim that a CS lab covers a CKA/LFCS/DCA/Terraform
objective must first map to that certification's *current official* objective
list and record `objective`, `objective_version` and `last_verified`.

---

## 3. Labs that are production skills but not exam objectives

**All 35.** Every lab is justified by a named production failure mode, not by an
exam blueprint. The strongest examples:

| Lab | Production failure it exists for | Any exam objective? |
|---|---|---|
| CS-004 | `EMFILE: too many open files` — descriptor exhaustion | No |
| CS-005 | a CI step that exits 0 after failing | No |
| CS-014 | `OOMKilled`, exit code 137, RSS vs limit | No |
| CS-015 | `df` full while `du` is empty — deleted-but-open file | No |
| CS-016 | dropped in-flight requests on every deploy (SIGTERM ignored) | No |
| CS-024 | configuration precedence and unfilterable logs | No |
| CS-026 | paging on 404s while a real 500 goes unnoticed | No |
| CS-030 | `FATAL: remaining connection slots are reserved` | No |
| CS-033 | retry storm / cascading failure / double-charged operation | No |
| CS-034, CS-035 | the two most common real pages an SRE receives | No |

**Downstream support, explicitly *not* coverage.** Several CS labs make later
certification tracks easier. This is stated here only so nobody later mistakes
it for objective coverage:

| CS lab | Supports (does **not** cover) |
|---|---|
| CS-014, CS-016 | CKA *Troubleshooting*, *Workloads & Scheduling* — resource limits, Pod lifecycle |
| CS-011, CS-012, CS-015 | LFCS *Operations Deployment*, *Storage* |
| CS-025, CS-026 | CKA *Services & Networking* |
| CS-010, CS-023 | Terraform Associate *Read and write configuration* |

---

## 4. Unsupported or outdated topics found

| # | Finding | Status |
|---|---|---|
| 1 | **RFC 7235** (HTTP/1.1 Authentication) is obsoleted by **RFC 9110**. It was in the draft citation list for CS-027. | **Corrected before writing** — CS-027 cites RFC 9110 §11 and RFC 6750. RFC 7235 appears nowhere in the plan. |
| 2 | **`docs.kernel.org/scheduler/sched-design-CFS.html`** describes CFS, which is no longer the kernel's default scheduler on current kernels (EEVDF). Citing it as *the* scheduler would be outdated. | **Avoided** — CS-013 cites `docs.kernel.org/scheduler/index.html` and `sched(7)`, and teaches scheduler-independent evidence (context-switch counters), so the lab does not depend on which scheduler the host runs. |
| 3 | **`strace`-based syscall teaching** is unsupported in this sandbox — `SYS_PTRACE` is explicitly not grantable (`linux-provider.ts`). Any lab written around `strace` would be dead on arrival. | **Designed around** — CS-012 uses `/proc/<pid>/syscall`, verified readable under `--cap-drop ALL` as an unprivileged user. No capability change is requested. |
| 4 | **C-based compilation** cannot be taught — the sandbox image ships no compilers by deliberate design. | **Designed around** — CS-022 uses `py_compile`/`__pycache__`/`dis` plus `file` on existing ELF binaries. |
| 5 | **`pip install` from an index** is impossible under `--network none`. A dependency lab that pretends otherwise would teach a command that cannot run. | **Designed around** — CS-023 reasons about real manifests and lock files instead. `python3 -m venv --without-pip` was verified to work; plain `venv` was verified to fail on stock Debian (PEP 668 / unbundled `ensurepip`), and the lab says so. |
| 6 | **`docs.docker.com/certification/` returns 404.** Docker's own documentation no longer hosts certification material; the DCA authority is now `training.mirantis.com` (200). | **Reported only** — affects the Docker track's `certification: DCA` claims, not this branch. See §7.3. |

**No outdated topic survives into the plan.**

---

## 5. Official documentation for every proposed lab

Full per-lab citations are in `CURRICULUM.md` §7 (each lab ends with a
**Sources** line). Consolidated index:

| Lab | Primary official sources |
|---|---|
| CS-001 | `proc(5)`; docs.kernel.org procfs; `df(1)` |
| CS-002 | coreutils Block size + `numfmt`; `od(1)`; Python `stdtypes` |
| CS-003 | Unicode Standard; RFC 3629 (UTF-8); RFC 20 (ASCII); `utf-8(7)`; Python Unicode HOWTO |
| CS-004 | `proc(5)`; `getrlimit(2)`; `open(2)`; `dup(2)` |
| CS-005 | `stdin(3)`; Bash Redirections; Bash Exit Status; `environ(7)` |
| CS-006 | Python tutorial (introduction, control flow); `stdtypes` |
| CS-007 | Python data structures; `collections` |
| CS-008 | Python `str` (`stdtypes`); Python tutorial introduction |
| CS-009 | Python errors & exceptions; built-in exceptions; `sys` |
| CS-010 | **RFC 8259 (JSON)**; Python `json`; **YAML 1.2.2 spec** |
| CS-011 | `fork(2)`; `execve(2)`; `proc(5)`; Python `os` |
| CS-012 | `syscall(2)`; `syscalls(2)`; `proc(5)`; docs.kernel.org procfs |
| CS-013 | `pthreads(7)`; `sched(7)`; docs.kernel.org scheduler index; Python `threading`, `multiprocessing`, glossary (GIL) |
| CS-014 | kernel mm concepts; overcommit accounting; cgroup v2; `malloc(3)`; `mmap(2)`; kubernetes.io resource management |
| CS-015 | `inode(7)`; `ln(1)`; `statfs(2)`; `df(1)`; `du(1)` |
| CS-016 | `signal(7)`; `kill(2)`; Python `signal`; kubernetes.io Pod lifecycle |
| CS-017 | Python `collections.deque`; `queue`; data structures |
| CS-018 | Python `stdtypes` (dict, set); data structures |
| CS-019 | Python data structures; `os.walk`; `pathlib`; `hier(7)` |
| CS-020 | Python `timeit`; `time`; `stdtypes` |
| CS-021 | Python `bisect`; `functools.lru_cache`; `stdtypes` (sorting) |
| CS-022 | `elf(5)`; Python `py_compile`; `dis`; Python command line |
| CS-023 | Python modules; `sys.path`; `venv`; **PEP 440**; pip dependency resolution; **PEP 668** |
| CS-024 | Python `logging`; `os.environ`; RFC 8259; Bash Exit Status |
| CS-025 | **RFC 9110**; **RFC 9112**; **RFC 9293 (TCP)**; Python `socket`, `http.server` |
| CS-026 | **RFC 9110**; **IANA HTTP status code registry**; RFC 8259; **RFC 3986**; `http.server` |
| CS-027 | RFC 9110 §11; **RFC 6750**; **RFC 7519 (JWT — read, not implemented)**; Python `hmac`, `secrets` |
| CS-028 | Python `sqlite3`; sqlite.org SQL syntax; postgresql.org SQL tutorial + constraints |
| CS-029 | sqlite.org query planner, `EXPLAIN QUERY PLAN`, transactions, atomic commit, isolation; postgresql.org indexes, transactions, MVCC |
| CS-030 | postgresql.org `max_connections`; Python `sqlite3`, `queue`, `functools`; **RFC 9111 (caching)** |
| CS-031 | Python `statistics`, `time`; kubernetes.io autoscaling |
| CS-032 | kubernetes.io Services + autoscaling; postgresql.org MVCC; Python `threading` |
| CS-033 | **RFC 9110 (idempotent/safe methods)**; RFC 9111; Python `queue`, `threading`, `secrets` |
| CS-034 | none new — inherits CS-026/029/030/031 |
| CS-035 | none new — inherits CS-014/016/017 |

**Every source is a primary, official specification, vendor documentation set,
or upstream project manual.** No blog, no aggregator, no training vendor, no
video, no forum, no exam dump appears anywhere in the plan. The platform's own
`DISALLOWED_DOC_HOSTS` list is satisfied by construction.

---

## 6. Missing official objectives / gaps

### 6.1 Version control is a documented gap

Policy §8 lists **"Git → git-scm.com/docs"** as a CS-fundamentals example, and
the current official LFCS *Essential Commands* domain includes **"Basic Git
Operations"** (confirmed from the Linux Foundation page, §1.3). The task brief's
topic list does **not** mention version control, and this plan accordingly has no
Git lab.

**This is a real gap, and it is flagged rather than silently filled.** Options:

- **A** — add `CS-036 Version control fundamentals` (repository, commit, branch,
  merge, remote, `.gitignore`, why a lock file is committed). Source:
  <https://git-scm.com/docs> (200 ✓). Cost: +1 lab, ~40 min. **Requires `git` in
  the sandbox image — a second platform ask beyond §3.2 of the plan.**
- **B** — assign Git to a future CI/CD track, where branching and merge conflicts
  belong to pipeline work.

**Recommendation: B**, with a one-paragraph Git orientation folded into CS-023
(where lock files already appear). Git is worth a track's worth of practice, not
a single foundational lab — and Option B avoids a second image change.
**Decision needed from the curriculum owner.**

### 6.2 POSIX shell semantics are cited via GNU only

CS-005 cites the GNU Bash manual. The Open Group Base Specifications
(<https://pubs.opengroup.org/onlinepubs/9799919799/>, 200 ✓) are the portability
authority and are already on the platform's Linux allow-list. **Recommendation:**
add the POSIX shell citation alongside Bash in CS-005 at implementation time.
Minor; no plan change.

### 6.3 Not gaps

- **No CKA/DCA/Terraform objectives are missing from this track** — the track
  deliberately claims none (§2).
- **Every topic in the task brief is covered** — see `CURRICULUM.md` §9, which
  maps all 78 named topics to at least one lab.

---

## 7. Recommended curriculum corrections

### 7.1 CONFLICT — existing Linux labs cite an LFCS domain that no longer exists

Reported in the format policy §10 requires. **This is outside this branch's
ownership; it is reported, not changed.**

```text
EXISTING LAB:
  labs/linux/linux-004-processes/lab.yaml
  labs/linux/linux-005-services/lab.yaml
  labs/linux/linux-007-logs/lab.yaml
  labs/linux/linux-010-troubleshooting/lab.yaml

CURRENT BEHAVIOR:
  Each declares:
      certification:
        - certification: LFCS
          relevant: true
          domains:
            - operation-of-running-systems

OFFICIAL DOCUMENTATION:
  https://training.linuxfoundation.org/certification/linux-foundation-certified-sysadmin-lfcs/
  Read 2026-08-23. Current official LFCS domains and weights:
      Operations Deployment  25%
      Networking             25%
      Storage                20%
      Essential Commands     20%
      Users and Groups       10%

CONFLICT:
  "operation-of-running-systems" is NOT a current official LFCS domain. Four labs
  claim coverage of a domain that does not exist in the current exam. The nearest
  current domain is "Operations Deployment", whose published competencies include
  "Diagnose, identify, manage, and troubleshoot processes and services" — which is
  what LINUX-004 and LINUX-010 actually teach.

  Separately: labs/linux/linux-008-storage/lab.yaml declares "storage-management";
  the current official domain is named "Storage".

RECOMMENDED CORRECTION:
  1. Re-map the four labs' domain slug to "operations-deployment", after the Linux
     track owner re-reads the official page and confirms per-lab fit.
  2. Re-map linux-008's "storage-management" to "storage".
  3. Record last_verified on each, once the schema supports it (§7.4).
  4. Do NOT delete any lab. Per policy §13, a lab whose objective moved is
     re-classified, not removed — all four remain valid PRODUCTION SKILL content.

OWNER: the Linux track branch. This branch has made no change to labs/linux/**.
```

### 7.2 Recommended: re-verify the other tracks' domain slugs the same way

The same check should be run by each owning branch, against each certifying
body's current official page. **No claim is made here that they are wrong** —
only that they have not been verified by this review:

| Track | Slugs in use | Authority to check against |
|---|---|---|
| Kubernetes (22 labs, CKA) | `cluster-architecture`, `workloads-and-scheduling`, `services-and-networking`, `storage`, `troubleshooting` | training.linuxfoundation.org CKA page (200 ✓) + github.com/cncf/curriculum (200 ✓) |
| Docker (10 labs, DCA) | `image-creation-and-registry`, `orchestration`, `storage-and-volumes`, `networking`, `installation-and-configuration` | training.mirantis.com (200 ✓) — **note `docs.docker.com/certification/` now 404s (§4.6)** |
| Terraform (1 lab) | `use-the-terraform-cli`, `read-and-write-configuration` | developer.hashicorp.com Associate **004** review (200 ✓) — confirm 004, not 003 |

### 7.3 Corrections already applied to this plan

| # | Correction | Where |
|---|---|---|
| 1 | RFC 7235 → RFC 9110 (obsoleted standard removed) | CS-027 |
| 2 | CFS-specific scheduler doc → scheduler index + `sched(7)`; lab made scheduler-independent | CS-013 |
| 3 | SQLite vs PostgreSQL labelled explicitly; engine-specific behaviour (isolation, MVCC, pooling) never generalised | Phase 8 preamble, CS-028/029/030 |
| 4 | `strace` removed from the syscall lab's design; `/proc` used instead, and the capability boundary is stated as *not* to be relaxed | CS-012 |
| 5 | JWT cited as **read, not implemented**; CS-027 states it is not a lesson in writing your own auth | CS-027 |
| 6 | Permissions explicitly deferred to LINUX-002 instead of duplicated | CS-015, coverage matrix |

### 7.4 Recommended: source-metadata schema extension

Policy §9 asks for per-lab source metadata. **The current schema cannot express
it**, and this branch has not changed the schema (it is platform-owned).

Current `lab-definition.ts` supports:

```yaml
references:                      # title + https url only — no type, no date
  - title: ps(1) — Linux manual page
    url: https://man7.org/linux/man-pages/man1/ps.1.html

certification:                   # certification + relevant + free-form domains
  - certification: LFCS          # no objective text, no objective_version,
    relevant: true               # no last_verified
    domains: [essential-commands]
```

Proposed additive, backward-compatible extension:

```yaml
references:
  - title: RFC 9110 — HTTP Semantics
    url: https://www.rfc-editor.org/rfc/rfc9110
    type: specification          # NEW: official_documentation | specification |
                                 #      man_page | vendor_documentation |
                                 #      certification_objective
    last_verified: 2026-08-23    # NEW

certification:
  - certification: LFCS
    relevant: true
    domains: [operations-deployment]
    objective: "Diagnose, identify, manage, and troubleshoot processes and services"   # NEW
    objective_source: https://training.linuxfoundation.org/certification/...           # NEW
    objective_version: "2026-08"                                                       # NEW
    last_verified: 2026-08-23                                                          # NEW
```

**Why it is worth doing:** it turns §7.1 from a manual audit into a mechanical
one. A validator could then fail any lab whose `last_verified` is older than N
months, or whose `type` is missing — which is precisely the freshness guarantee
policy §13 asks for and which nothing currently enforces.

**Why it is not proposed for now:** every field is optional and additive, so it
can land at any time; and the CS track needs none of it (it claims no
objectives). **Owner: platform track. Blocking: no.**

### 7.5 No corrections needed to the CS plan itself

The plan was authored under this policy, so no retro-fit was required beyond
§7.3. Its structural compliance:

| Policy | CS plan |
|---|---|
| §1 official sources are truth | 118/118 URLs official and verified 200 |
| §8 CS marked FOUNDATIONAL SKILL | stated in the header, §12, and here |
| §9 source metadata documented | §5 above; schema extension proposed in §7.4 |
| §10 verify before implementing | §8 below defines the per-lab gate |
| §12 original content | Kestrel Logistics — original company, incidents, wording, seeds, verifiers, hints |
| §13 freshness | re-verify dates recorded; §8 requires re-check at implementation |

---

## 8. Proposed coverage matrix

### 8.1 Foundational competency coverage (the CS track's own matrix)

There is no exam blueprint to map against, so the matrix is keyed on
**foundational competency** with the same depth classification policy §11
defines: `NOT COVERED · INTRODUCED · PRACTICED · ADVANCED · ASSESSMENT`.

| Competency | Labs | Depth | Official source | Verified |
|---|---|---|---|---|
| Machine model (CPU, memory, storage) | CS-001 | PRACTICED | `proc(5)`, docs.kernel.org | 2026-08-23 |
| Data representation (bits, hex, units) | CS-002 | PRACTICED | coreutils manual, `od(1)` | 2026-08-23 |
| Character encoding | CS-003 | PRACTICED | unicode.org, RFC 3629, RFC 20 | 2026-08-23 |
| Files and file descriptors | CS-004, CS-015 | ADVANCED | `open(2)`, `getrlimit(2)`, `inode(7)` | 2026-08-23 |
| Process I/O contract & exit codes | CS-005, CS-024 | ADVANCED | `stdin(3)`, GNU Bash manual | 2026-08-23 |
| Programming fundamentals | CS-006 – CS-009 | PRACTICED | docs.python.org | 2026-08-23 |
| Configuration data formats | CS-010, CS-024 | PRACTICED | RFC 8259, YAML 1.2.2 | 2026-08-23 |
| Process lifecycle | CS-011, CS-016 | ADVANCED | `fork(2)`, `execve(2)`, `signal(7)` | 2026-08-23 |
| Kernel boundary & system calls | CS-012 | INTRODUCED | `syscall(2)`, `syscalls(2)` | 2026-08-23 |
| Concurrency & scheduling | CS-013, CS-033 | ADVANCED | `sched(7)`, `pthreads(7)`, Python `threading` | 2026-08-23 |
| Memory management | CS-014 | ADVANCED | docs.kernel.org mm, cgroup v2 | 2026-08-23 |
| Filesystem internals | CS-015 | PRACTICED | `inode(7)`, `statfs(2)` | 2026-08-23 |
| Data structures | CS-017 – CS-019 | PRACTICED | docs.python.org | 2026-08-23 |
| Algorithmic complexity | CS-020, CS-021 | PRACTICED | Python `timeit`, `bisect`, `functools` | 2026-08-23 |
| Build & runtime model | CS-022 | INTRODUCED | `elf(5)`, Python `py_compile`, `dis` | 2026-08-23 |
| Dependency management | CS-023 | PRACTICED | PEP 440, PEP 668, pip docs | 2026-08-23 |
| Observability (logs, exit codes) | CS-024 | PRACTICED | Python `logging`, GNU Bash manual | 2026-08-23 |
| HTTP & client/server | CS-025, CS-026 | ADVANCED | RFC 9110, RFC 9112, RFC 9293, IANA registry | 2026-08-23 |
| AuthN / AuthZ / state | CS-027 | PRACTICED | RFC 9110 §11, RFC 6750, RFC 7519 | 2026-08-23 |
| Relational databases | CS-028, CS-029 | ADVANCED | sqlite.org, postgresql.org | 2026-08-23 |
| Pooling, caching, NoSQL | CS-030 | PRACTICED | postgresql.org, RFC 9111 | 2026-08-23 |
| Performance & percentiles | CS-031 | PRACTICED | Python `statistics`, kubernetes.io | 2026-08-23 |
| Scaling, replication, consistency | CS-032 | ADVANCED | kubernetes.io, postgresql.org MVCC | 2026-08-23 |
| Resilience (timeouts, retries, idempotency) | CS-033 | ADVANCED | RFC 9110, RFC 9111 | 2026-08-23 |
| Incident diagnosis, end to end | CS-034, CS-035 | **ASSESSMENT** | inherited | 2026-08-23 |
| **Version control** | — | **NOT COVERED** | git-scm.com | see §6.1 |

**26 of 27 competencies covered; one (version control) NOT COVERED and flagged
for a decision.**

### 8.2 Certification coverage claimed by this track

| Certification | Objectives covered | Depth |
|---|---|---|
| CKA | none | NOT COVERED — by design |
| LFCS | none | NOT COVERED — by design |
| DCA | none | NOT COVERED — by design |
| Terraform Associate 004 | none | NOT COVERED — by design |

**The CS track claims no certification coverage.** Its value proposition is
stated as *foundational skill*, and this table exists so that claim is explicit
and auditable rather than merely absent.

---

## 9. Per-lab verification gate (policy §10)

Before **each** lab is implemented — not before the track — this branch will:

1. Re-open every official source cited for that lab and confirm it still
   resolves and still says what the lab claims;
2. Verify the commands, syscall names, `/proc` fields, status codes and SQL
   behaviour **inside the actual sandbox image**, not from memory — the way
   §3.2/§3.3 of the plan were verified;
3. Confirm the task actually teaches the stated concept, and that the
   verification grades the concept rather than a command transcript;
4. Record the sources in `references:` and the verification date in this file;
5. Report any contradiction in the policy §10 `EXISTING LAB / CURRENT BEHAVIOR /
   OFFICIAL DOCUMENTATION / CONFLICT / RECOMMENDED CORRECTION` format **before**
   writing the lab;
6. Only then implement.

**Re-verification cadence:** the whole citation set is re-checked before any
major curriculum release, and any source that moves is corrected rather than
silently followed (policy §13).

---

## 10. Per-lab source records

Added as each lab is implemented, per the verification gate in §9. Format is the
metadata the platform schema cannot yet express (see §7.4); it is recorded here
until one common contract lands for all tracks.

### CS-001 — What a Machine Actually Is

```text
LAB ID:              CS-001
TITLE:               What a Machine Actually Is
CLASSIFICATION:      FOUNDATIONAL SKILL  (also PRODUCTION SKILL)
CERTIFICATION:       none — claims no objective of any certification

LEARNING OBJECTIVE:
  Read a machine's processor count, memory total, load and disk usage out of
  the plain-text files the kernel exposes; express one memory figure in both
  MiB and MB; turn a load average into a per-processor figure and judge
  saturation; and distinguish the machine being investigated from the machine
  the shell is running on.

WHY A DEVOPS/SRE ENGINEER NEEDS THIS:
  Every sizing decision, every `resources.requests`, every instance-type
  argument and every "is the node too small?" thread is this lab. Two specific
  failures start here: `memory: 512Mi` being read as 512 MB, and `free -m`
  inside a container reporting the host's RAM — which is why a JVM or Node
  process sized from /proc/meminfo gets OOMKilled at a limit it never saw.
  Reading a diagnostic capture from a host you cannot log into is the ordinary
  shape of an out-of-hours incident.

OFFICIAL / PRIMARY SOURCES:
  proc(5)                     https://man7.org/linux/man-pages/man5/proc.5.html
  proc_meminfo(5)             https://man7.org/linux/man-pages/man5/proc_meminfo.5.html
  proc_loadavg(5)             https://man7.org/linux/man-pages/man5/proc_loadavg.5.html
  The /proc Filesystem        https://docs.kernel.org/filesystems/proc.html
  df(1)                       https://man7.org/linux/man-pages/man1/df.1.html
  expr(1)                     https://man7.org/linux/man-pages/man1/expr.1.html
  GNU coreutils — Block size  https://www.gnu.org/software/coreutils/manual/html_node/Block-size.html
  Control Group v2            https://docs.kernel.org/admin-guide/cgroup-v2.html
  K8s resource management     https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/

LAST VERIFIED:       2026-08-23   (all nine fetched, HTTP 200)
```

**Claims checked against the documentation rather than assumed:**

| Claim used by the lab | Where it was confirmed |
|---|---|
| `/proc/loadavg`'s first three fields are 1/5/15-minute averages of jobs in the run queue **or waiting for disk I/O** | `proc_loadavg(5)`, read in full. The lab's hint uses the man page's own framing rather than the common "CPU usage" misreading. |
| `MemTotal` is *total usable RAM* — physical RAM minus reserved regions and the kernel image — not "installed RAM" | `proc_meminfo(5)`. The lab says "total memory" and never claims it equals the DIMM capacity. |
| `MemAvailable` has existed since Linux 3.14, so every current kernel emits it | `proc_meminfo(5)` states the version. This is what makes the anti-copy check safe. |
| `/proc/meminfo`'s `kB` is **1024 bytes**, which is why MiB and MB differ | Not stated explicitly by either man page, so it was **measured**: on a running kernel, `MemTotal x 1024` equals glibc's `sysconf(_SC_PHYS_PAGES) x PAGESIZE` exactly, and `x 1000` does not. The lab states the convention in its own words and cites the coreutils Block size manual for the unit definitions. |
| `expr` truncates integer division | `expr(1)`, and confirmed by running it: `expr 16266528 / 1024` = 15885. This is why every graded conversion has exactly one spelling and no rounding rule to guess. |

**Originality (policy §12):** Kestrel Logistics, `kestrel-scan-01`, the 03:12
outage, the capture's README, every number in the fixture, the report format,
the task wording, the hint ladder and all eleven checks are original JumpToTech
content. The capture imitates the *format* documented in `proc(5)`; it
reproduces no real machine's output and no third-party lab.

### CS-002 — Bits, Bytes, Hex, and the Units That Page You

```text
LAB ID:              CS-002
TITLE:               Bits, Bytes, Hex, and the Units That Page You
CLASSIFICATION:      FOUNDATIONAL SKILL  (also PRODUCTION SKILL)
CERTIFICATION:       none — claims no objective of any certification

LEARNING OBJECTIVE:
  Read a hexadecimal number as another spelling of a value already countable;
  see that a character is a byte and that a byte has a two-digit hex spelling;
  convert one byte count into both SI and IEC units and watch the same quantity
  acquire two different sizes; and write a program that performs the conversion
  for any byte count rather than for one.

WHY A DEVOPS/SRE ENGINEER NEEDS THIS:
  `memory: 512Mi` is not 512 MB, and the gap is ~5% at the mebibyte and ~7% at
  the gibibyte. Alerts, dashboards and limits routinely mix the two systems in
  one line, and an engineer who cannot reduce both to bytes cannot say whether
  a workload is over its limit. Hex is how a UID, an inode, a checksum, a
  colour and every byte dump are read.

OFFICIAL / PRIMARY SOURCES:
  GNU coreutils — Block size   https://www.gnu.org/software/coreutils/manual/html_node/Block-size.html
  GNU coreutils — numfmt       https://www.gnu.org/software/coreutils/manual/html_node/numfmt-invocation.html
  GNU coreutils — printf       https://www.gnu.org/software/coreutils/manual/html_node/printf-invocation.html
  od(1)                        https://man7.org/linux/man-pages/man1/od.1.html
  Python — sys.argv            https://docs.python.org/3/library/sys.html
  Python — format spec         https://docs.python.org/3/library/string.html
  Python — built-in types      https://docs.python.org/3/library/stdtypes.html
  K8s resource management      https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/

LAST VERIFIED:       2026-08-24   (all eight fetched, HTTP 200)
```

**Values computed by running the real tools in this lab's own sandbox image,
never by hand:**

| Value | How it was obtained | Result |
|---|---|---|
| `LIMIT_BYTES` | `printf '%d\n' 0x20000000` | `536870912` |
| `SI` | `numfmt --to=si 536870912` | `537M` |
| `IEC` | `numfmt --to=iec 536870912` | `512M` |
| `TAG_HEX` | `od -An -tx1 tag.bin` on the two bytes `Mi` | `4d 69` → `4d69` |
| `VERDICT` | `numfmt --from=si 640M` = `640000000` vs `536870912` | `over` |
| program output | Python 3.11.2, `:.2f` on `n/10**6` and `n/1024**2` | `536.87 MB` / `512.00 MiB` |

The three graded byte counts were chosen so no conversion lands on a rounding
boundary, so `:.2f` has exactly one correct answer under any rounding mode.

**Runtime dependency:** Python 3.11 (standard library only — `sys` and string
formatting). Provided by the sandbox image; see the platform commit that added
it. No pip, no third-party package, no network.

**Grading note (policy §12, original content):** the lookup-table bypass — a
program that prints every answer set and ignores its argument — satisfies every
`output_contains` check, because that check is a substring test over the whole
of stdout. CS-002 therefore also requires the program's *source* to be free of
the expected output strings, and says so in the task. Both halves are needed;
neither is redundant.

### CS-003 — Text, Encoded: ASCII, UTF-8 and Unicode

```text
LAB ID:              CS-003
TITLE:               Text, Encoded: ASCII, UTF-8 and Unicode
CLASSIFICATION:      FOUNDATIONAL SKILL  (also PRODUCTION SKILL)
CERTIFICATION:       none — claims no objective of any certification

LEARNING OBJECTIVE:
  Tell characters and bytes apart and measure both for the same text; see that
  an ASCII character takes one byte while others take more; read a character's
  actual bytes with od and recognise a multi-byte UTF-8 sequence; connect a
  character to its Unicode code point and the code point to the bytes UTF-8
  stores it as; and write a program that reports both counts for any file.

WHY A DEVOPS/SRE ENGINEER NEEDS THIS:
  A byte-limited field rejecting a short-looking string is a recurring and
  badly-diagnosed failure: database columns, partner API fields, log pipelines
  and fixed-width exports all count bytes while humans count characters. The
  same confusion is behind UnicodeDecodeError in an importer and a regex that
  drops the interesting log lines.

OFFICIAL / PRIMARY SOURCES:
  The Unicode Standard      https://www.unicode.org/versions/latest/
  RFC 3629 (UTF-8)          https://www.rfc-editor.org/rfc/rfc3629
  RFC 20 (ASCII)            https://www.rfc-editor.org/rfc/rfc20
  utf-8(7)                  https://man7.org/linux/man-pages/man7/utf-8.7.html
  ascii(7)                  https://man7.org/linux/man-pages/man7/ascii.7.html
  od(1)                     https://man7.org/linux/man-pages/man1/od.1.html
  GNU coreutils — printf    https://www.gnu.org/software/coreutils/manual/html_node/printf-invocation.html
  Python — Unicode HOWTO    https://docs.python.org/3/howto/unicode.html
  Python — str and bytes    https://docs.python.org/3/library/stdtypes.html

LAST VERIFIED:       2026-08-24   (all nine fetched, HTTP 200)
```

**Every value measured by running the real tools against this lab's own seeded
batches, never reasoned about:**

| Batch | Per line (chars/bytes) | Totals | Longest chars / bytes |
|---|---|---|---|
| `batch-1.txt` | 18/18, 14/15, 16/17, **13/37** | 61 / 87 | line 1 / **line 4** |
| `batch-2.txt` | 13/13, 13/15 | 26 / 28 | line 1 / line 2 |

`printf 'A' \| od -An -tx1` → `41` · `printf 'ü'` → `c3 bc` · `printf '東'` →
`e6 9d b1` · `ord('ü')` → `U+00FC`.

**Why the batch is shaped this way:** line 4 is the *shortest* line by
characters (13) and the *only* line over the partner API's 20-byte field (37
bytes), while line 1 is the longest by characters and passes untouched. A
student cannot reach that from intuition — they have to measure both, which is
the lab.

**Runtime dependency:** Python 3.11 standard library only (`sys`, `str`,
`bytes`). No pip, no third-party package, no network.

**Grading note:** graded against two batches whose answers differ, so a program
hard-coded for one fails the other; plus two `file_content_absent` checks on the
source, because `output_contains` is a substring test over the whole of stdout
and a program printing both batches' answers would otherwise satisfy both
invocations. Same pairing as CS-002, and for the same reason.
