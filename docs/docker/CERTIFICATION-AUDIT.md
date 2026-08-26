# Docker Track — Certification Metadata Audit and Source Status

**Status:** audit only. No lab was modified except DOCKER-009, which was
corrected in the previous pass and re-labelled here.
**Verified:** 2026-08-23.

---

## 1. DCA source status — ACTIVE, but the objectives are LEGACY

The policy asks for one of three classifications. The honest answer needs two
axes, because the certification and its objectives are in different states.

| Axis | Classification | Evidence |
|---|---|---|
| **The exam as a product** | **ACTIVE** | Purchasable from the certification owner at $199, no retirement notice |
| **The published objectives** | **LEGACY — last revised October 2020** | Document metadata, below |
| **Docker Inc.'s own position** | **UNACKNOWLEDGED** | Docker's training page does not mention DCA at all |

### 1.1 Who owns it

Mirantis, which acquired Docker Enterprise in 2019, administers the exam. That
makes Mirantis — not Docker Inc. — the certification owner and the authoritative
source for objectives.

- Certification page: https://training.mirantis.com/certification/dca-certification-exam/
- Store listing: https://store.mirantis.com/product/docker-certified-associate-dca/ — *"Starting at $199.00 per exam"*, no out-of-stock or retirement notice.

### 1.2 The objectives have not been revised in ~5 years

The official study guide is presented as **"Study Guide, Version 1.5, Docker
Certified Associate (DCA) — January 2025"** and served from Mirantis's CDN:
`https://a.storyblok.com/f/146871/x/2001ce939c/docker-study-guide_v1-5-jan-2025.pdf`

Its embedded document metadata tells a different story:

| Field | Value |
|---|---|
| XMP `CreateDate` | **2020-08-12** |
| XMP `ModifyDate` | **2020-10-28** |
| XMP `MetadataDate` | **2020-10-28** |
| PDF `ModDate` | 2024-12-17 *(a re-save; XMP content date unchanged)* |
| Producer | Acrobat PDFMaker 20 for Word |

An **earlier copy of the same version number** is still hosted on Mirantis's own
site at
`https://training.mirantis.com/wp-content/uploads/2020/10/Docker-Study-Guide_v1.5-October.pdf`.

**Both files are "v1.5". The content was authored in August 2020, last modified
in October 2020, and re-stamped with a January 2025 cover date in December
2024.** The objectives themselves have not changed.

### 1.3 The objectives describe products that no longer exist under those names

The guide's objectives repeatedly name **UCP** (Universal Control Plane) and
**DTR** (Docker Trusted Registry) — for example *"Describe and demonstrate the
steps to deploy the Docker engine, UCP, and DTR on AWS and on-premises in an HA
configuration"*, *"Describe and demonstrate how to configure backups for UCP and
DTR"*, *"Describe and demonstrate how to create UCP client bundles"*. Mirantis
has since renamed these product lines (Mirantis Kubernetes Engine, Mirantis
Secure Registry). The exam objectives were not updated to match.

### 1.4 Docker Inc. does not reference DCA

https://www.docker.com/trainings/ names exactly one credential — a **LinkedIn
Learning "Docker Foundations Professional Certificate"** — and does not mention
the Docker Certified Associate anywhere.

### 1.5 Conclusion and required marketing position

> **JumpToTech must NOT market the Docker track as current DCA exam
> preparation.**

The exam is purchasable, so it is not "retired". But its objectives are five
years stale, describe discontinued product names, and are not acknowledged by the
vendor of the Docker product itself. Any certification claim we make would age
badly and would mislead students about what the exam actually tests.

**Permitted position:** *"Partial mapping to the Docker Certified Associate
objectives as published by Mirantis (Study Guide v1.5, content dated October
2020). Historical mapping only — not exam preparation."*

Anything stronger is unsupportable.

### 1.6 Track classification

Primary classification, per the approved list:

> **PRODUCTION CONTAINER ENGINEERING** — Docker for DevOps / SRE, with
> **container troubleshooting** and **container security** as the two advanced
> strands.

**Recommended (not applied):** `labs/docker/track.yaml` currently reads
*"Containers, images, volumes, and the daemon underneath them."* Suggest
*"Production container engineering — building, running, securing and debugging
containers the way a platform team does."* Track metadata is a shared
presentation file; not changed without approval.

---

## 2. DOCKER-001 … DOCKER-010 certification metadata audit

Every lab currently declares `certification: DCA, relevant: true` except
DOCKER-009, corrected in the previous pass. All domain values are **invented
kebab-case slugs**; none matches an official domain name.

Official domain names, verbatim from the guide: *Orchestration* (25%),
*Image Creation, Management, and Registry* (20%), *Installation and
Configuration* (15%), *Networking* (15%), *Security* (15%), *Storage and
Volumes* (10%).

Official source for every row: **DCA Study Guide v1.5 (content dated October
2020), Mirantis** — plus https://docs.docker.com/ for the technical claims.

| Lab | Current claim | Current domain(s) | Official objective found? | Correct classification | Action | Reason |
|---|---|---|---|---|---|---|
| **DOCKER-001** Run Your First Container | DCA `relevant: true` | `image-creation-and-registry`, **`orchestration`** | **NO — both wrong** | PRODUCTION SKILL (foundations) | **CORRECT → `relevant: false`** | Domain 1 *Orchestration* is entirely swarm and Kubernetes — `docker service`, `docker stack deploy`, quorum, replicated/global services, node labels. A single `docker run --name` lab is not in it. Domain 2 is Dockerfiles, image CLI management and registries — also not this. **The most inaccurate metadata in the track.** The nearest real objective, *"Describe the difference between running a container and running a service"*, is about swarm services, which the lab never mentions. |
| **DOCKER-002** Container Lifecycle | DCA `relevant: true` | `image-creation-and-registry` | **NO** | PRODUCTION SKILL (foundations) | **CORRECT → `relevant: false`** | Start/stop/rm/exit codes appear in no domain. Domain 2 is about *images*, not container lifecycle. Slug is also not an official domain name. |
| **DOCKER-003** Pull, Inspect, Tag Images | DCA `relevant: true` | `image-creation-and-registry` | **YES — partial** | PARTIAL CERTIFICATION OBJECTIVE + production skill | **KEEP, correct the slug** | Genuinely maps to Domain 2: *"Describe and demonstrate how to tag an image"* and *"…inspect images and report specific attributes using filter and format"*. Rename slug to `Image Creation, Management, and Registry`. |
| **DOCKER-004** Build from a Dockerfile | DCA `relevant: true` | `image-creation-and-registry` | **YES** | PARTIAL CERTIFICATION OBJECTIVE | **KEEP, correct the slug** | Maps to *"Describe the use of Dockerfile"* and *"Identify and display the main parts of a Dockerfile"*. The strongest genuine mapping in the track. |
| **DOCKER-005** Persist Data with Volumes | DCA `relevant: true` | `storage-and-volumes` | **YES** | PARTIAL CERTIFICATION OBJECTIVE | **KEEP, correct the slug** | Maps to Domain 6: *"Describe the use of volumes are used with Docker for persistent storage"* (sic). Slug is close but not the official name. |
| **DOCKER-006** Custom Network | DCA `relevant: true` | `networking` | **YES** | PARTIAL CERTIFICATION OBJECTIVE | **KEEP, correct the slug** | Maps to Domain 4: *"…create a Docker bridge network for developers to use for their containers"* and *"Describe the different types and use cases for the built-in network drivers"*. |
| **DOCKER-007** Environment Variables | DCA `relevant: true` | `image-creation-and-registry` | **NO** | PRODUCTION SKILL | **CORRECT → `relevant: false`** | `-e` / `--env-file` appear in no domain. Domain 2 mentions `ENV` only inside *"Describe options, such as add, copy, volumes, expose, entrypoint"* — a Dockerfile instruction list that does not include runtime env injection, and which DOCKER-014 will cover properly. |
| **DOCKER-008** Multi-Container / Compose | DCA `relevant: true` | **`orchestration`**, `networking` | **PARTIAL — and the orchestration claim is wrong** | PRODUCTION SKILL + partial Domain 4 | **CORRECT → drop `orchestration`** | Domain 1's only Compose objective is *"Convert an application deployment into a stack file using a YAML compose file with `docker stack deploy`"* — that is **swarm stack deployment**, not `docker compose up`. The lab does the latter. The `networking` half is defensible. |
| **DOCKER-009** Resource Limits | DCA `relevant: **false**` | *(none)* | **NO** | **PRODUCTION SKILL — DevOps/SRE, container reliability & resource management** | **ALREADY CORRECTED** | `--memory`, `--cpus`, `--pids-limit` appear in no domain. Domain 3, previously claimed, covers repo setup, storage drivers, logging drivers, swarm, users/teams, daemon-on-boot, cert auth, namespaces/cgroups description, and UCP/DTR. Setting a cgroup limit is not among them. |
| **DOCKER-010** Repair a Broken Container | DCA `relevant: true` | `installation-and-configuration`, `networking` | **PARTIAL — one of two wrong** | PRODUCTION SKILL + partial Domain 4 | **CORRECT → drop `installation-and-configuration`** | Domain 3 is installation, not container repair — the claim is unsupported for the same reason as DOCKER-009's was. The `networking` half is supported by *"…troubleshoot container and engine logs to resolve connectivity issues between containers"*. |

### 2.1 How much existing metadata is inaccurate

| Verdict | Count | Labs |
|---|---|---|
| Claim is **wholly unsupported** — should become `relevant: false` | **4** | 001, 002, 007, *(009 — already fixed)* |
| Claim is **partly unsupported** — one domain must be dropped | **2** | 008, 010 |
| Claim is **supported**, slug wrong only | **4** | 003, 004, 005, 006 |
| **Domain slug is invented / not an official name** | **10 of 10** | all |

**So: 6 of the 10 labs carry a certification claim that the official objectives
do not support, in whole or in part, and 10 of 10 use domain names that do not
exist in the official guide.**

The two claims to fix first are **DOCKER-001's `orchestration`** (a
single-container lab claiming the swarm domain) and **DOCKER-008's
`orchestration`** (`docker compose up` claiming `docker stack deploy`).

### 2.2 Recommended sequencing — not applied

1. One change correcting `relevant:` on 001, 002, 007 and dropping the bad
   domain from 008 and 010.
2. One change replacing all invented slugs with official domain names — best
   done together with the shared source-metadata contract (§4), so the domain
   list and its provenance land in the same edit.

---

## 3. Docker security coverage matrix

Classification rules: **CERTIFICATION OBJECTIVE** only where a verified current
official objective supports it. Everything else is **PRODUCTION SKILL** or
**DEVSECOPS SKILL**. Source for the certification column: DCA Study Guide v1.5,
Domain 5 *Security* (15%) and Domain 2.

Domain 5's complete objective list is: security administration and tasks; the
process of signing an image; default engine security; swarm default security;
MTLS; identity roles; UCP workers vs managers; external certificates with UCP and
DTR; an image passes a security scan; enable Docker Content Trust; configure
RBAC with UCP; integrate UCP with LDAP/AD; create UCP client bundles.

**Nine of those thirteen are UCP/DTR or swarm.** The domain contains nothing
about how a single container is hardened.

| Topic | Classification | Official objective? | Plan coverage | Gap |
|---|---|---|---|---|
| Non-root containers | **DEVSECOPS SKILL** | **No** — absent from Domain 5 | DOCKER-020 | — |
| Read-only root filesystem | **DEVSECOPS SKILL** | **No** | DOCKER-020 | — |
| Linux capabilities | **DEVSECOPS SKILL** | **No** | DOCKER-020 | — |
| `no-new-privileges` | **DEVSECOPS SKILL** | **No** | DOCKER-020 | — |
| Minimal / distroless images | **PRODUCTION SKILL** | Partial — *"create an efficient image via a Dockerfile"* (Domain 2) is about size, not attack surface | DOCKER-017, 018 | — |
| Resource limits (memory, CPU) | **PRODUCTION SKILL** | **No** | DOCKER-009, 025 | — |
| PID limits | **PRODUCTION SKILL** | **No** | DOCKER-009 | — |
| Network isolation / segmentation | **PRODUCTION SKILL** | Partial — Domain 4 covers network drivers, not segmentation as a control | DOCKER-016, 023 | — |
| Secrets exposure via env vars | **DEVSECOPS SKILL** | **No** | **none** | **GAP — recommend a lab** |
| Secrets exposure via image layers / build args | **DEVSECOPS SKILL** | **No** | **none** | **GAP — recommend a lab** |
| Image provenance / signing / Content Trust | **CERTIFICATION OBJECTIVE** | **Yes** — *"Describe the process of signing an image"*, *"…enable Docker Content Trust"* | **none** | **GAP — the only security objective we could legitimately claim, and we do not cover it** |
| Image vulnerability scanning | **CERTIFICATION OBJECTIVE** (weak) | **Yes** — *"Describe and demonstrate that an image passes a security scan"* | **none** | **GAP** |
| Volume / mount permissions and ownership | **PRODUCTION SKILL** | **No** | DOCKER-015 *(partial)*, 024 | thin |
| **Docker socket exposure** (`-v /var/run/docker.sock`) | **DEVSECOPS SKILL** | **No** | **none** | **GAP — highest-value missing security topic** |
| Privileged containers | **DEVSECOPS SKILL** | **No** | DOCKER-027 *(as a regression to fix)* | thin |
| Host mounts / host filesystem exposure | **DEVSECOPS SKILL** | **No** | DOCKER-015 *(partial)* | thin |
| Supply-chain risk (base image pinning, digests, `.dockerignore` leakage) | **DEVSECOPS SKILL** | Partial — digests touch Domain 2 | DOCKER-003, 017, 021 *(scattered)* | **no dedicated lab** |
| Default engine security / MTLS / identity roles | CERTIFICATION OBJECTIVE | **Yes** | **none** | not labbable on CE without UCP |

### 3.1 Security gaps worth adding to the 25-lab plan

Three topics are missing entirely and all three are things a DevSecOps engineer
is actually asked about:

1. **Docker socket exposure.** Mounting `/var/run/docker.sock` into a container
   is root-equivalent on the host. It is the single most common real-world
   container escape, and the plan does not teach it. **Recommend a dedicated
   advanced lab.**
2. **Secrets in environment variables and image layers.** `docker inspect` and
   `docker history` both leak them; a secret in a `RUN` layer survives deletion
   in a later layer. **Recommend a dedicated advanced lab.**
3. **Image provenance and signing.** This is the *only* Domain 5 objective we
   could honestly claim, and it also matters in production. **Recommend folding
   into DOCKER-021 (registry workflows) rather than a separate lab.**

Adding 1 and 2 would take the plan from 25 to 27 labs. Recommend they replace
nothing — the security strand is currently one lab (DOCKER-020) carrying six
distinct concepts, which is too thin for a track that lists container security as
a headline strand.

**Not implemented.** Flagged for the next planning decision.

---

## 4. Deferred: shared source-metadata contract

Per instruction, `lab-definition.ts` is **not** modified. The proposed fields are
recorded in `CURRICULUM-PLAN.md` §6.8 and repeated here for the central
implementation:

```yaml
certification:
  - certification: DCA
    relevant: false
    domains: []
    objective_version: "Study Guide v1.5 (content dated 2020-10-28)"
    objective_source: https://training.mirantis.com/certification/dca-certification-exam/
    objective_status: legacy          # active | legacy | unverified
    last_verified: 2026-08-23
```

`objective_status` is an addition to the earlier proposal, prompted by this
audit: a boolean `relevant` cannot express "the objective exists but is five
years stale", which is exactly the DCA situation and would otherwise have to be
carried in a comment. One shared contract, implemented centrally, after the
remaining track audits finish.
