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

### CS-004 — Files, File Descriptors, and "Too Many Open Files"

```text
LAB ID:              CS-004
TITLE:               Files, File Descriptors, and "Too Many Open Files"
CLASSIFICATION:      FOUNDATIONAL SKILL  (also PRODUCTION SKILL)
CERTIFICATION:       none — claims no objective of any certification

LEARNING OBJECTIVE:
  Describe what a file descriptor is and why 0, 1 and 2 are always spoken for;
  read a running process's descriptor table out of /proc; tell a leaked socket
  from an ordinary open file and work out which dominates; find the soft and
  hard limits a process is actually running under; reproduce the descriptor
  ceiling deliberately and see that it counts every descriptor a process holds;
  and say why raising the limit postpones a leak rather than fixing it.

WHY A DEVOPS/SRE ENGINEER NEEDS THIS:
  "Too many open files" is among the most common production failures there is,
  and it is almost never about files — it is leaked sockets or connections. The
  reflex fix (raise the limit, restart) postpones the crash and hides the leak,
  which is exactly the loop this lab's fictional on-call engineer is stuck in.

OFFICIAL / PRIMARY SOURCES:
  proc(5)                   https://man7.org/linux/man-pages/man5/proc.5.html
  proc_pid_fd(5)            https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html
  proc_pid_limits(5)        https://man7.org/linux/man-pages/man5/proc_pid_limits.5.html
  getrlimit(2)              https://man7.org/linux/man-pages/man2/getrlimit.2.html
  open(2)                   https://man7.org/linux/man-pages/man2/open.2.html
  socket(2)                 https://man7.org/linux/man-pages/man2/socket.2.html
  errno(3)                  https://man7.org/linux/man-pages/man3/errno.3.html
  GNU Bash — ulimit         https://www.gnu.org/software/bash/manual/html_node/Bourne-Shell-Builtins.html
  Python — resource         https://docs.python.org/3/library/resource.html
  Python — errno            https://docs.python.org/3/library/errno.html

LAST VERIFIED:       2026-08-25   (all ten fetched, HTTP 200)
```

**Fixture design — a bounded, per-session connection leak**

| Property | How it is achieved |
|---|---|
| realistic | holds a listener and leaks both ends of a loopback connection per batch, plus two spool files — the mixed table a real leak produces |
| bounded | stops at 60 batches (~126 descriptors) against its own soft limit of 256, so it never dies mid-lab and never approaches a host ceiling |
| student-owned | started with `su student`, because `/proc/<pid>/fd` is readable only by the process owner — a root fixture would hide the very thing being investigated |
| isolated | one container per session; verified two concurrent sessions each have their own collector and descriptor table, and ending one leaves the other running |
| disposable | a child of the container's init; End Lab reclaims it, Reset restarts it fresh |

**Answer non-disclosure.** `COLLECTOR_SOFT_LIMIT` is set by the seed script,
which the provider deletes from a root-only directory before the terminal
opens — afterwards the number exists only in the running process, and appears
in no file the student can read. `LEAK_KIND` cannot be inferred from the
service's source because the service leaks *both* sockets and files; only
counting `/proc/<pid>/fd` answers which dominates. Verified that no expected
value appears in the lab payload, the failure details, the hints or any
student-visible text.

**Why `OPENED` is deterministic and worth grading:** `script_runs` execs the
program with exactly three descriptors open, so a program that lowers its own
soft limit to N and opens until the kernel refuses always manages **N − 3** —
64 → 61, 128 → 125, measured stable over five consecutive runs and confirmed
identical for a socket-based implementation. That difference of three *is* the
lesson: the ceiling counts stdin, stdout and stderr too.

**Runtime dependency:** Python 3.11 standard library only (`os`, `sys`,
`errno`, `resource`, `socket`). No pip, no third-party package, no network.

### CS-005 — The Process Contract: Streams, Exit Codes and Environment

```text
LAB ID:              CS-005
TITLE:               The Process Contract: Streams, Exit Codes and Environment
CLASSIFICATION:      FOUNDATIONAL SKILL  (also PRODUCTION SKILL)
CERTIFICATION:       none — claims no objective of any certification

LEARNING OBJECTIVE:
  Name what a process is handed and hands back — arguments, environment, three
  streams, an exit status; separate stdout from stderr with redirection and see
  they are different channels; explain why automation reads the status rather
  than the words; give a program an exit-code interface that distinguishes a
  real failure from a misconfiguration; and show that a shell variable is not
  part of a child's environment until it is exported.

WHY A DEVOPS/SRE ENGINEER NEEDS THIS:
  It is the contract every CI/CD system is built on. A step that prints its
  failure to stdout gets piped onward as data; a step that always exits 0 turns
  a broken deploy green; a launcher that assigns instead of exporting silently
  strips a program's configuration. All three appear together here because they
  appear together in real pipelines.

OFFICIAL / PRIMARY SOURCES:
  Bash — Redirections      https://www.gnu.org/software/bash/manual/html_node/Redirections.html
  Bash — Exit Status       https://www.gnu.org/software/bash/manual/html_node/Exit-Status.html
  Bash — Environment       https://www.gnu.org/software/bash/manual/html_node/Environment.html
  Bash — Bourne builtins   https://www.gnu.org/software/bash/manual/html_node/Bourne-Shell-Builtins.html
  environ(7)               https://man7.org/linux/man-pages/man7/environ.7.html
  stdin(3)                 https://man7.org/linux/man-pages/man3/stdin.3.html
  execve(2)                https://man7.org/linux/man-pages/man2/execve.2.html
  exit(3)                  https://man7.org/linux/man-pages/man3/exit.3.html
  Python — sys             https://docs.python.org/3/library/sys.html
  Python — os.environ      https://docs.python.org/3/library/os.html

LAST VERIFIED:       2026-08-25   (all ten fetched, HTTP 200)
```

**Two platform facts this lab was designed around, both verified in source:**

| Fact | Consequence for grading |
|---|---|
| `script_runs` compares `output_contains` against **stdout and stderr concatenated** (`services/verifier/src/handlers/linux.ts`) | It can prove the exit-code contract but cannot tell the streams apart. Separation is therefore graded from the student's own `>` / `2>` captures: the diagnostic must be **present** in `err.txt` and **absent** from `out.txt`. |
| `script_runs` cannot set environment variables | Turned into the lesson. The check is run **bare** and must report a misconfiguration rather than inventing a default; the success and failure paths run through the student's own launcher, which has to place the value in the child's environment. Inheritance is demonstrated, not asserted. |

**`process_environ` does not exist in the requirement vocabulary and was not
created.** No new shared-platform primitive was introduced.

**A bug found in this lab during adversarial testing, and how it was fixed.**
The first draft asserted `limit=5` in the passing run's output. Substring
matching accepts `limit=5` inside `limit=50`, so a launcher exporting the wrong
limit passed. The assertion was replaced with a **boundary run** — six failed
probes must exit 3 — which pins the limit behaviourally and cannot be satisfied
by a wrong one. The regression is covered by a named test.

**Disclosure note.** The lab payload does contain `DEPLOY_CHECK=ok|failed|
misconfigured`, because that is the **interface the task specifies** — the
student is told what to implement. What must be discovered is the three
contract violations and the limit in `pipeline.yml`, and none of those appears
in any student-visible text. This is a different case from CS-004, where an
objective named a value the student was supposed to find.

**Runtime dependency:** Python 3.11 standard library only (`os`, `sys`).

### CS-006 — Variables, Types and Control Flow

```text
LAB ID:              CS-006
TITLE:               Variables, Types and Control Flow
CLASSIFICATION:      FOUNDATIONAL SKILL  (also PRODUCTION SKILL)
CERTIFICATION:       none — claims no objective of any certification

LEARNING OBJECTIVE:
  Tell a value's type from where it came and know that arguments, files and
  environment all hand a program text; see that comparing numbers as text gives
  a different answer silently; convert, and handle text that is not a number;
  express a rule with strict boundaries in if/elif/else; loop over readings; and
  put the rule in a function so it can be tested by calling it.

WHY A DEVOPS/SRE ENGINEER NEEDS THIS:
  A replica count read as a string and compared against a number is a real
  outage, and it fails silently: "12" > "9" is False, so a scaler that looks
  correct never scales down. The same shape appears wherever config crosses a
  boundary — YAML, environment, JSON, command arguments.

OFFICIAL / PRIMARY SOURCES:
  Python tutorial — introduction   https://docs.python.org/3/tutorial/introduction.html
  Python tutorial — control flow   https://docs.python.org/3/tutorial/controlflow.html
  Python — built-in types          https://docs.python.org/3/library/stdtypes.html
  Python — built-in functions      https://docs.python.org/3/library/functions.html
  Python — sys.argv                https://docs.python.org/3/library/sys.html
  Python — built-in exceptions     https://docs.python.org/3/library/exceptions.html

LAST VERIFIED:       2026-08-25   (all six fetched, HTTP 200)
```

**No seeded grading harness — and this is the lab where that was decided.**

The curriculum plan sketched CS-006 with a harness that imports the student's
`decide` and prints `PASS:` tokens. That design is unsound **at any file
permission**: a harness that imports student code runs it in the same process,
so the student's module can print the tokens itself at import time and exit
before a single case runs. Root ownership and an unwritable file do not help,
because the attack is on the process, not the file. Hiding the filename would
be obscurity, not security.

So the student's own program is run directly, and each argument set is chosen
to separate a correct implementation from one specific mistake:

| arguments | catches |
|---|---|
| `10 9 2` | comparing as text — `"10" > "9"` is False, the seeded helper's actual bug |
| `8 8 2` | the target boundary, which is strict |
| `3 1 3` | the minimum boundary, which is also strict |
| `1 0 0` | truthiness — `if minimum and …` breaks only when the minimum is genuinely zero |
| `abc 1 1` | text that is not a number |
| `--file readings.txt` | the loop, over the five windows the helper got wrong |

Each is a named regression test, so a later edit cannot quietly drop the case
that catches a particular bug. Verified on the real platform: the text-compare
bug fails exactly two checks, the truthiness bug fails exactly one — the zero
case — and a blanket program printing every expected line fails only on the two
`file_content_absent` source checks, which is why they are not redundant.

**Runtime dependency:** Python 3.11 standard library only (`sys`).

### CS-007 — Lists and Dictionaries: From Lines to Structure

```text
LAB ID:              CS-007
TITLE:               Lists and Dictionaries: From Lines to Structure
CLASSIFICATION:      FOUNDATIONAL SKILL  (also PRODUCTION SKILL)
CERTIFICATION:       none — claims no objective of any certification

LEARNING OBJECTIVE:
  Turn line-oriented text into records and discard the lines that are not
  records; choose between a list and a dictionary by what the data is for;
  count by key; rank by more than one criterion so equal values still come out
  in a defined order; and produce the same answer every time from the same
  input.

WHY A DEVOPS/SRE ENGINEER NEEDS THIS:
  Every config file, API response and `kubectl get -o json` is lists inside
  dictionaries inside lists, and every log pipeline starts by turning lines
  into records. A report whose ranking moves between runs is a report two
  people can disagree about, and an unstable tie-break is the usual cause.

OFFICIAL / PRIMARY SOURCES:
  Python tutorial — data structures   https://docs.python.org/3/tutorial/datastructures.html
  Python — collections (Counter)      https://docs.python.org/3/library/collections.html
  Python — built-in functions         https://docs.python.org/3/library/functions.html
  Python — built-in types             https://docs.python.org/3/library/stdtypes.html
  Python — sorting HOWTO              https://docs.python.org/3/howto/sorting.html
  Python — reading and writing files  https://docs.python.org/3/tutorial/inputoutput.html

LAST VERIFIED:       2026-08-25   (all six fetched, HTTP 200)
```

**Values computed from the shipped fixture, never by hand:**

| log | result |
|---|---|
| `scan-events.log` | leeds 9, bristol 7, manchester 7, cardiff 3 · `ORDER=leeds,bristol,manchester,cardiff` · `TOTAL=26` |
| `scan-events-small.log` | york 3, cardiff 2 · `ORDER=york,cardiff` · `TOTAL=5` |

Three lines in the main log are unusable — one blank, one truncated mid-record,
one from a scanner shipping no depot field — so a total that includes them is
wrong in a way no single depot's number reveals.

**Two grading decisions worth keeping.**

*The ranking is one line, not a file hash.* `output_contains` checks each
expected string independently and cannot assert ordering. The plan proposed
`sha256sum` on the CSV; that was rejected because `csv.writer` emits CRLF by
default, so a student using the csv module correctly would fail a byte hash —
that grades line endings, not understanding. A single `ORDER=` line is
order-exact and indifferent to whitespace.

*The tie is the whole test.* manchester and bristol both finish on 7 and
manchester appears first in the log, so sorting by count alone leaves them in
insertion order **while every `DEPOT=` line stays correct**. Only the ranking
shows whether the tie-break was applied. Confirmed on the real platform: that
bug fails exactly one check, and only on the batch containing the tie.

**Forged evidence cannot pass.** The CSV is student-written, so it is gradeable
only because the program is independently graded by running it: a hand-written
perfect CSV behind a program that does nothing scores 7/9 and never passes.

**Runtime dependency:** Python 3.11 standard library only.

### CS-008 — Strings and Text Processing

```text
LAB ID:              CS-008
TITLE:               Strings and Text Processing
CLASSIFICATION:      FOUNDATIONAL SKILL  (also PRODUCTION SKILL)
CERTIFICATION:       none — claims no objective of any certification

LEARNING OBJECTIVE:
  Take a record apart on the structure it has rather than on whitespace;
  recognise that the last field can contain the delimiter and the separator;
  count what could not be parsed and treat a non-zero count as a finding; keep
  a text field intact including punctuation and non-ASCII; and rank and
  summarise records deterministically once parsed.

WHY A DEVOPS/SRE ENGINEER NEEDS THIS:
  Logs are strings, first-line diagnosis is string work, and a parser that
  splits on the wrong thing does not crash — it answers a smaller question
  confidently. Here it loses the slowest request of the night and three of the
  four errors, which is exactly the 2% nobody investigates.

OFFICIAL / PRIMARY SOURCES:
  Python — str and its methods       https://docs.python.org/3/library/stdtypes.html
  Python tutorial — strings          https://docs.python.org/3/tutorial/introduction.html
  Python — string services           https://docs.python.org/3/library/string.html
  Python — re                        https://docs.python.org/3/library/re.html
  Python — built-in functions        https://docs.python.org/3/library/functions.html
  Python — reading and writing files https://docs.python.org/3/tutorial/inputoutput.html

LAST VERIFIED:       2026-08-25   (all six fetched, HTTP 200)
```

| log | expected |
|---|---|
| `requests.log` | `TOTAL=16 ERRORS=4 DROPPED=0` · `SLOWEST=R-1007,R-1003,R-1010` · `LONGEST_MSG=R-1012` · `ERROR_PATHS=/api/depots,/api/track` |
| `requests-quiet.log` | `TOTAL=5 ERRORS=1 DROPPED=0` · `SLOWEST=Q-2002,Q-2005,Q-2004` · `LONGEST_MSG=Q-2002` · `ERROR_PATHS=/api/track` |

**Every trap was verified against the fixture, and one assumption was wrong.**

| trap | what it actually does |
|---|---|
| whitespace split | accepts **10 of 16** lines, losing the slowest request and **all four** errors |
| `fallback=disabled` in a message | a dict-from-all-pairs parser invents a `fallback` field — real, but it surfaces as a dropped or truncated line rather than as a distinct failure |
| `dur_ms=99999` in a message | **does *not* affect a first-match search**, because the real field comes first. It bites a parser taking the *last* or *largest* match, which reads 99999 instead of 1180 and reorders the ranking |
| truncated message | breaks `LONGEST_MSG` only — the totals and ranking stay correct, which is why that check exists |

The `dur_ms` decoy was originally described as defeating any whole-line search.
It does not, and the lab text, the hint and the test now say what it really
catches. `DROPPED` is graded at zero so that answering a smaller question
counts as a failure rather than as a rounding error.

**Runtime dependency:** Python 3.11 standard library only.

### CS-009 — Errors, Exceptions and Failing Usefully

```text
LAB ID:              CS-009
TITLE:               Errors, Exceptions and Failing Usefully
CLASSIFICATION:      FOUNDATIONAL SKILL  (also PRODUCTION SKILL)
CERTIFICATION:       none — claims no objective of any certification

LEARNING OBJECTIVE:
  Say what an exception is and what an unhandled one does to a process; read a
  traceback and know which end of it names the failure; catch the failures you
  can describe and let the ones you cannot describe reach the caller; map
  distinguishable failures to distinct exit statuses; and explain why a job
  that swallows exceptions and exits zero is worse than one that crashes.

WHY A DEVOPS/SRE ENGINEER NEEDS THIS:
  A tool that swallows exceptions and exits 0 turns every failure into a green
  pipeline and a later incident. The seeded job has "succeeded" for three weeks
  without reconciling anything, which is the failure mode exactly. Reading a
  traceback bottom-up is the most transferable debugging skill in the track.

OFFICIAL / PRIMARY SOURCES:
  Python tutorial — errors and exceptions  https://docs.python.org/3/tutorial/errors.html
  Python — built-in exceptions             https://docs.python.org/3/library/exceptions.html
  Python — sys.exit and sys.stderr         https://docs.python.org/3/library/sys.html
  Python — os and file-operation errors    https://docs.python.org/3/library/os.html
  GNU Bash manual — exit status            https://www.gnu.org/software/bash/manual/html_node/Exit-Status.html
  errno(3) — error numbers and names       https://man7.org/linux/man-pages/man3/errno.3.html

LAST VERIFIED:       2026-08-25   (all six fetched, HTTP 200)
```

| ledger path | expected |
|---|---|
| `ledger-2026-08-24` | `RECONCILED=6 TOTAL=8484` on stdout, exit `0` |
| `ledger-2026-08-25` | absent — `RECONCILE_ERROR=missing-input` on stderr, exit `2` |
| `ledger-torn` | `RECONCILE_ERROR=malformed-record line=3` on stderr, exit `3` |
| `ledger-archive/` | uncaught `IsADirectoryError`, traceback on stderr, exit `1` |

**How "catch narrowly" is graded without reading the source.** Grepping the
student's file for `except Exception` would grade what they typed, and would
fail a correct solution that mentions the phrase in a comment. Instead the
fourth ledger path is a *directory*, and where the resulting error ends up is a
behaviour the verifier can see:

| the student wrote | what happens to IsADirectoryError | archive exit |
|---|---|---|
| `except FileNotFoundError` | escapes — traceback printed by Python | `1` ✓ |
| `except OSError` | swallowed, reported as a missing input | `2` ✗ |
| `except Exception` | swallowed, reported as whatever it reports | `2` ✗ |

Confirmed on Python 3.11.2 in the real sandbox image, not assumed:
`IsADirectoryError` is a subclass of `OSError` but **not** of
`FileNotFoundError` (errno 21, `EISDIR`). So a handler narrow enough to be
correct cannot catch it by accident, and one wide enough to be wrong cannot
avoid catching it. Over-broad catching becomes a wrong exit status rather than
a source pattern to match on.

**Forged evidence and typed-out answers cannot pass.** Four paths with four
fixed outcomes is a table a shell script could type out, and one does pass every
`script_runs` check — verified against real Docker before the guards existed.
Three `file_content_absent` checks bar `RECONCILED=6`, `TOTAL=8484` and `line=3`
from the program, and a correct solution contains none of them because it prints
`RECONCILED={count} TOTAL={total}` and `line={number}`. The write-up in
`errors.txt` is student-written and so is only safe to grade because the program
is graded independently by being run: a perfect write-up behind a program that
does nothing reaches 7 of 11 — it clears the three checks that bar the answers
from the source, vacuously, because it contains no source worth barring — and
fails all four of the checks that run it. Measured on the real platform, not
estimated.

**Runtime dependency:** Python 3.11 standard library only.

**Known limitation, accepted deliberately.** A student who catches
`IsADirectoryError` *by name* and prints a traceback themselves reaches exit 1
with both tokens on stderr, and passes. Verified against real Docker. This is
not defended against, because writing it requires knowing which exception
escapes, that it is `IsADirectoryError`, that an uncaught exception exits 1,
and what a traceback looks like — which is the objective in full. It cannot be
discovered without running the program and reading the traceback, so it is a
longer way round rather than a shortcut. Closing it would mean grading source
shape, which is the thing this lab is built to avoid.

### CS-010 — JSON and YAML: The Formats Infrastructure Speaks

```text
LAB ID:              CS-010
TITLE:               JSON and YAML: The Formats Infrastructure Speaks
CLASSIFICATION:      FOUNDATIONAL SKILL  (also PRODUCTION SKILL)
CERTIFICATION:       none — claims no objective of any certification

LEARNING OBJECTIVE:
  Load JSON with the standard library and tell a parse failure apart from a
  config that parsed but is wrong; validate required keys and types and report
  which key is at fault; normalise a document to a canonical form so that equal
  configs produce identical bytes; explain why sorting keys is not sorting data;
  and name the YAML traps that turn a valid file into the wrong config.

WHY A DEVOPS/SRE ENGINEER NEEDS THIS:
  Kubernetes manifests, CI configs, Terraform state, API payloads and structured
  logs are all this. `version: 3.10` deploying 3.1 and an unquoted `no` becoming
  false are both real outages. Canonical form is what makes two configs
  comparable, and what makes a diff mean something.

OFFICIAL / PRIMARY SOURCES:
  RFC 8259 — the JSON data interchange format  https://www.rfc-editor.org/rfc/rfc8259
  Python — the json module                     https://docs.python.org/3/library/json.html
  Python — json.JSONDecodeError                https://docs.python.org/3/library/json.html#json.JSONDecodeError
  YAML 1.2.2 specification                     https://yaml.org/spec/1.2.2/
  YAML 1.1 type repository — bool resolution   https://yaml.org/type/bool.html
  sha256sum(1), GNU coreutils                  https://www.gnu.org/software/coreutils/manual/html_node/sha2-utilities.html

LAST VERIFIED:       2026-08-25   (all five distinct URLs fetched, HTTP 200;
                                  the JSONDecodeError reference is an anchor on
                                  the json module page)
```

**The canonical form, and why a hash is safe here.** CS-007 rejected a byte
hash because `csv.writer` emits CRLF and the hash would have graded line
endings. This one was *measured before it was written down*, in the real
sandbox image:

| dimension varied | variants |
|---|---|
| serialising | `json.dumps`+`"\n"`, `json.dump`+`write("\n")`, `print(...)` |
| loading | `json.load`, `json.loads` of text, `json.loads` of bytes |
| spelled-out defaults | `separators=(",", ": ")`, `ensure_ascii` True and False |
| idempotence | normalise, re-parse, normalise again |
| inputs | `depot-a.json` and `depot-b.json` — the same config, different key order |
| interpreter | `PYTHONHASHSEED` unset, 0, 1, 12345 |

**Every combination produced one digest:**
`d8cd267fcd4ffad806d82ef8601ea3209b72be782ff0847cb4badf779e02269c`.

It is reproducible because the contract is complete and the fixture avoids what
is not: **no floats** (`version` is the string `"3.10"`), **no non-ASCII** (so
`ensure_ascii` cannot matter), and `sort_keys` removing any dependence on dict
ordering. The task text states all four terms — sorted keys, two-space indent,
one trailing newline, list order untouched — because a canonical form that is
not fully specified is not canonical. Measured the other way too: dropping the
trailing newline, using indent 4, using no indent, leaving keys unsorted, and
sorting the `scanners` list all change the digest, and all five are rejected.

**Semantically equivalent input, identical canonical output.** `depot-a.json`
(compact, keys in one order) and `depot-b.json` (pretty-printed, keys in
another) are the same document. Both are graded against the *same* digest, so
the lab passes only when the student's normalisation actually collapses the
difference — which is the thing normalisation is for.

**Grading the YAML half on real bytes.** Each trap was verified against a real
YAML parser (Ruby Psych 3.1.0) rather than asserted:

| trap | what a parser actually does |
|---|---|
| `country: no` | resolves to boolean `false`, not the country code |
| `version: 3.10` | resolves to the float `3.1`, and `3.10 == 3.1` is true |
| duplicate `leeds:` | the second block silently wins |
| a tab | `Psych::SyntaxError` — the file does not parse at all |

The absent-checks name the **broken** spelling, so `"no"` and `'no'` both pass —
verified: both spellings parse to the identical document. The repaired file is
graded on its own bytes (`grep -c leeds:` for the duplicate, three
`file_content_absent` checks for the rest); the write-up is graded separately
and is never the only evidence.

**Whole-line matching, not substring.** The write-up checks use
`command_output` with `grep -x` rather than `file_content contains`, because
`contains` is a substring test and the wrong answer here is a *superstring* of
the right one: `VERSION_BECAME=3.10` — the version the file says, which is
exactly the misreading the lab is about — contains `VERSION_BECAME=3.1`. The
same trap sits under `DUPLICATE_KEY=leeds` and `leeds-old`. This was caught by
the lab's own test suite before the lab shipped, and confirmed against real
`grep` in the sandbox.

**Forged evidence and typed-out answers cannot pass.** A shell script matching
on the filename that emits correct exit codes on all five configs *and* types
out byte-perfect canonical JSON was built and run against real Docker: it
reaches 17 of 20 and fails all three `file_content_absent` checks. `key=region`
and `key=enabled` force the key name to be computed; `leeds` is barred because a
validator has no reason to name a depot, but embedded canonical output cannot
avoid it.

**Known limitation, stated plainly.** The two normalised files are graded where
they lie, so a student who solves the lab and then breaks the loader still has
two files that hash correctly. Those two checks are not the defence — the five
that run the loader are, and a stale artifact behind a broken loader reaches 15
of 20. Verified on the real platform. Closing it would need a verifier primitive
that can clear a path before grading, which does not exist and is not worth
adding for this.

**New platform capability required:** none. `command_output` is pre-existing
vocabulary — added by 558a5f7 with the Linux track, present in the tree at
5930406^, the commit before CS-001. CS-010 is the first CS lab to use it, so the
hand-maintained allow-list in `cs-labs.test.ts` gained an entry and a note
recording that evidence.

**Runtime dependency:** Python 3.11 standard library only. **No PyYAML**, and
none requested — the YAML half is reading and repairing YAML by hand, which is
the skill, and is why the seeded file is graded as text.

### CS-011 — Process Lifecycle: Fork, Exec, Zombies and PID 1

```text
LAB ID:              CS-011
TITLE:               Process Lifecycle: Fork, Exec, Zombies and PID 1
CLASSIFICATION:      FOUNDATIONAL SKILL  (also PRODUCTION SKILL)
CERTIFICATION:       none — claims no objective of any certification

LEARNING OBJECTIVE:
  Describe how a process is created and what fork returns to each of the two
  processes that come back from it; explain what a zombie is, why SIGKILL does
  not remove one, and what does; read a process's state and parent from /proc;
  decode a wait status and say why it is not the exit code; and explain what
  PID 1 inherits and why an entrypoint that never waits runs out of processes.

WHY A DEVOPS/SRE ENGINEER NEEDS THIS:
  Why a container ignores `docker stop`, why zombies accumulate behind a
  shell-script entrypoint, why `tini` and `--init` exist, and why
  "the process is <defunct>" is not fixed by killing it. It is also where
  128+signal comes from.

OFFICIAL / PRIMARY SOURCES:
  fork(2)                                  https://man7.org/linux/man-pages/man2/fork.2.html
  execve(2)                                https://man7.org/linux/man-pages/man2/execve.2.html
  wait(2) — the status macros              https://man7.org/linux/man-pages/man2/wait.2.html
  proc(5) — /proc/[pid]/stat and states    https://man7.org/linux/man-pages/man5/proc.5.html
  signal(7)                                https://man7.org/linux/man-pages/man7/signal.7.html
  Python — os process management           https://docs.python.org/3/library/os.html

LAST VERIFIED:       2026-08-25   (all six fetched, HTTP 200)
```

**No wall-clock grading — a deliberate departure from the plan.** The
curriculum plan proposed catching "never reaps" with a short `timeout_seconds`,
so a program that does not wait fails by hanging. That grades the machine as
much as the student, and this repository has already seen container reads go
slow under contention. It was replaced with an outcome grade:

| reported | what it proves | how it is obtained |
|---|---|---|
| `CHILD_STATE=Z` | the child was dead and uncollected when they looked | field 3 of `/proc/<child>/stat` |
| `RAW=<n>` | `waitpid` was actually called | the raw status it returned |
| `CHILD_GONE=yes` | collecting it removed the entry | `/proc/<child>` is gone |

Confirmed on the real platform: a program that forks and walks away **exits 0
promptly** and fails on the three lines it cannot print. No timer is involved
in the verdict; the 30-second ceiling is a runaway guard, and a test asserts
that no requirement distinguishes a fast run from a slow one.

**The raw wait status is the discriminator.** The exit code is handed to the
program at run time and the raw status is that code shifted left by eight.
Measured in the real image rather than assumed:

| exit code | raw wait status | `code << 8` |
|---|---|---|
| 7 | 1792 | 1792 |
| 3 | 768 | 768 |
| 0 | 0 | 0 |

Three runs with three codes means a fixed answer fails two of them, and four
`file_content_absent` checks bar `RAW=1792`, `RAW=768`, `STATUS=7` and
`CHILD_STATE=Z` from the source. A correct program contains none of them — it
prints `RAW={status}`, `STATUS={code}` and `CHILD_STATE={seen}`. A shell script
that types out the whole table behaves perfectly on all three runs and reaches
8 of 12; verified against real Docker.

It is also the lesson: a wait status is not an exit code, which is why
`os.waitstatus_to_exitcode` exists and why a killed process shows up as
128 plus its signal number.

**Invariants, verified live, and one thing deliberately not graded.** All three
write-up values were confirmed inside the real session container:

| recorded | observed |
|---|---|
| `ZOMBIE_STATE=Z` | a dead, uncollected child reads `Z` |
| `ORPHAN_PARENT=1` | an orphan reparents to PID 1 of the container's PID namespace |
| `STATE_AFTER_SIGKILL=Z` | `SIGKILL` on a zombie changes nothing — the team's stuck point |

**Not graded: the identity of PID 1.** It is `/usr/bin/runsvdir -P /etc/service`
in a real session container and `sleep` in a throwaway one — a provider detail,
not a property of the lesson. Grading it would couple the lab to something that
may change. A test asserts no expectation mentions it.

**New platform capability required:** none. `script_runs`, `file_content_absent`
and `command_output` are all already in use by the CS track; `fork`, `waitpid`
and `/proc` all work for the unprivileged student with no added privilege — no
`SYS_ADMIN`, no privileged container, no Docker socket, no host filesystem. The
`unprivileged_shell` capability is the existing one.

**Runtime dependency:** Python 3.11 standard library only, plus `ps` from the
base image.
