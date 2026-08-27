# JumpToTech Labs

Interactive DevOps practice environments in the browser.

A student opens the site, launches a disposable environment — a private
Kubernetes namespace or their own Linux container — runs real commands in a
browser terminal, and has their work verified against the live state they
actually left behind.

Nothing in this repository simulates a terminal or hardcodes command output.
The terminal is a real PTY, the cluster is a real Kubernetes cluster, the Linux
sandbox is a real container running a real Debian userland, and the verifier
reads the real Kubernetes API and the real filesystem.

**PLATFORM-001** built that loop. **PLATFORM-002** made it safe for more than
one student at a time: every lab session now gets its own namespace, its own
ServiceAccount, its own RBAC, its own quota, and its own network policy, and it
is cleaned up automatically when the student finishes or walks away.

**PLATFORM-003** turned one lab into a catalog. There are now ten Kubernetes
labs, and the application contains no code that knows about any of them:
adding a lab means adding a `lab.yaml`, and nothing else. See
[The lab catalog](#the-lab-catalog).

**PLATFORM-004** made the platform stop being about Kubernetes. A lab now
declares which *kind of sandbox* it needs — `kubernetes`, `linux`, `docker`,
`terraform`, `aws` — and a provider registry produces it. Kubernetes labs still
get a namespace; Linux and Terraform labs get their own throwaway container.
The catalog, the session lifecycle, the timer, the hints, Start / Check / Reset
/ End, the terminal and the cleanup service are the *same code* for all of
them. See [Multi-track architecture](#multi-track-architecture).

**PLATFORM-005** gave the platform a memory. Sandboxes are still disposable —
that is the product — but what a student *did* in one is now written to
PostgreSQL: their attempts, their per-lab progress, and the hints they used. A
student can complete K8S-001, close the tab, come back tomorrow to a cluster
that has long since deleted their namespace, and still see **Kubernetes 1/10
completed**. The dividing line is the whole design:

```text
   sandbox lifecycle  =  temporary   (namespace, container — deleted on End/expiry)
   learning progress  =  persistent  (students, attempts, progress, hints)
```

See [Persistent progress](#persistent-progress).

**The Linux track is the proof.** Ten Linux labs — files, permissions, users
and groups, processes, services, networking, logs, storage, shell scripting and
troubleshooting — run on that second substrate through the same catalog, the
same session lifecycle, the same terminal, and the same verifier. Adding them
added a provider, a requirement family and lab content; it added no second
state machine. See [The Linux track](#the-linux-track).

---

## Contents

- [What is in scope](#what-is-in-scope)
- [Architecture](#architecture)
- [Multi-track architecture](#multi-track-architecture)
  - [The provider contract](#the-provider-contract)
  - [The provider registry](#the-provider-registry)
  - [The Kubernetes provider](#the-kubernetes-provider)
  - [The Linux provider](#the-linux-provider)
  - [The Terraform provider](#the-terraform-provider)
  - [Docker sandbox strategy](#docker-sandbox-strategy)
  - [Session and provider binding](#session-and-provider-binding)
  - [The terminal binding](#the-terminal-binding)
  - [Generic verification](#generic-verification)
  - [Cleanup across providers](#cleanup-across-providers)
  - [Adding a provider](#adding-a-provider)
  - [Adding a lab to an existing provider](#adding-a-lab-to-an-existing-provider)
- [The lab catalog](#the-lab-catalog)
- [The Linux track](#the-linux-track)
- [The Docker track](#the-docker-track)
- [Persistent progress](#persistent-progress)
  - [Why progress is its own package](#why-progress-is-its-own-package)
  - [Database schema](#database-schema)
  - [Migrations](#migrations)
  - [The attempt lifecycle](#the-attempt-lifecycle)
  - [How progress is calculated](#how-progress-is-calculated)
  - [Hint tracking](#hint-tracking)
  - [Development student identity](#development-student-identity)
  - [When the database is unavailable](#when-the-database-is-unavailable)
  - [Running PostgreSQL locally](#running-postgresql-locally)
- [Multi-student architecture](#multi-student-architecture)
- [Session lifecycle](#session-lifecycle)
- [Cost model](#cost-model)
- [Local development requirements](#local-development-requirements)
- [Requirements](#requirements)
- [Installation](#installation)
- [Running locally](#running-locally)
- [Starting K8S-001](#starting-k8s-001)
- [Starting LINUX-001 and TF-001](#starting-linux-001-and-tf-001)
- [Testing the terminal](#testing-the-terminal)
- [Testing the verifier](#testing-the-verifier)
- [Resetting the lab](#resetting-the-lab)
- [Ending a lab](#ending-a-lab)
- [Automatic cleanup](#automatic-cleanup)
- [Lab definitions](#lab-definitions)
- [Adding a lab](#adding-a-lab)
- [API reference](#api-reference)
- [Automated tests](#automated-tests)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Known limitations](#known-limitations)
- [Future AWS architecture](#future-aws-architecture)
- [Future AWS provider architecture](#future-aws-provider-architecture)

---

## What is in scope

Delivered by PLATFORM-001:

- One lab: **K8S-001 — Create Your First Pod**
- Real `kind` Kubernetes sandbox
- Browser terminal over WebSocket, backed by a real PTY
- State-based verification (`Check Solution`)
- Reset (`Reset Lab`)

Added by PLATFORM-002:

- **A session per student.** Unique, cryptographically random session id;
  namespace derived from it; never `default`.
- **A ServiceAccount per session**, with namespace-scoped RBAC. The student
  terminal holds no cluster-admin credential of any kind.
- **ResourceQuota, LimitRange and NetworkPolicy** on every lab namespace.
- **Explicit session lifecycle** — `CREATING → ACTIVE → …→ ENDED/EXPIRED` —
  with idle expiry, an absolute deadline, and an idle warning.
- **`End Lab`**, distinct from `Reset Lab`.
- **A cleanup service** that reclaims expired, idle, and orphaned sandboxes
  without the student doing anything.
- **A capacity guard** (`MAX_ACTIVE_SESSIONS`).
- **Session-scoped verification and reset** — one student's work can neither
  satisfy nor disturb another's.

Added by PLATFORM-004:

- **Three live tracks.** Kubernetes (10 labs), Linux (1), Terraform (1), from
  one catalog, one lab page and one session API.
- **A generic sandbox provider contract**, and a registry that resolves a lab's
  declared provider to an implementation. There is no `switch (track)` anywhere
  above it.
- **A Linux provider** — one hardened, throwaway container per session: no
  network, no capabilities, no host mounts, no Docker socket, bounded CPU,
  memory and PIDs.
- **A Terraform provider** — the same sandbox plus the Terraform CLI and an
  offline provider mirror, so `terraform init` works with no network and no
  cloud credentials.
- **A generic terminal binding.** The terminal service attaches a PTY to
  whatever the session's sandbox is, resolved server-side; the browser never
  names a namespace, a container, or a command.
- **A generic verification engine** with three requirement families —
  Kubernetes API, sandbox filesystem, Terraform state — dispatched per
  requirement, with the lab loader refusing a lab whose provider cannot verify
  what it asks for.
- **Provider readiness in the catalog.** A track whose backend is missing says
  so, with the real reason; Docker and AWS ship as architecture only and are
  labelled *Coming soon* rather than offered.

Added by PLATFORM-003:

- **A real catalog.** Ten Kubernetes labs, discovered from `labs/` at startup,
  validated against a schema, and rejected with a precise developer error when
  malformed. Duplicate ids, duplicate slugs, dangling prerequisites, and
  prerequisite cycles are all refused.
- **A metadata-driven lab engine.** One React lab page, one API route, one
  verifier registry. There is no `if (labId === …)` anywhere in the codebase.
- **A generic setup engine** — a lab declares Kubernetes manifests, which are
  applied into that session's namespace and confirmed before the student is
  handed the environment. No lab can execute anything.
- **A generic verification engine** — 32 requirement types covering Pods,
  Deployments, Services, ConfigMaps, Secrets, Jobs, CronJobs, probes, resource
  requests/limits, and object absence.
- **Progressive hints** — revealed one at a time, never all at once.
- **Skill, prerequisite, and certification metadata** on every lab.
- **A troubleshooting lab** (K8S-010) that provisions a deliberately broken
  workload the student must investigate and repair.

Added by PLATFORM-005:

- **Learning history in PostgreSQL** — `students`, `lab_attempts`,
  `lab_progress`, `hint_usage` — behind a repository port, with no SQL anywhere
  above it.
- **A lab attempt per Start Lab**, with an explicit lifecycle
  (`IN_PROGRESS → PASSED | FAILED | ENDED | EXPIRED`), a check count, a reset
  count, and *two* independent timestamps: `completed_at` (learning) and
  `ended_at` (infrastructure).
- **Progress that outlives the sandbox.** Deleting a namespace or a container
  cannot touch a row: nothing in the persistence package knows what either is.
- **Transactional completion.** A passing check updates the attempt and the
  student's progress in one transaction, and a repeated PASS records the check
  without duplicating the completion.
- **Reset that costs nothing.** `reset_count` goes up; no attempt, check, or
  completion is withdrawn.
- **Hint usage**, recorded once per (attempt, hint) by a database constraint, so
  a replayed request cannot inflate it.
- **A student dashboard** — overall progress, completed/total per track, and
  recent attempts — plus completion state on the catalog cards.
- **`GET /api/me`, `/api/me/progress`, `/api/me/attempts`,
  `/api/me/attempts/:attemptId`**, none of which expose a database internal or a
  session id.
- **PostgreSQL in the compose stack** with a health check, a named volume, and
  forward-only, checksum-verified migrations that never drop anything.

Added by PLATFORM-LINUX-001:

- **A second track.** Ten Linux labs, from files and permissions through
  services, networking, logs, storage, shell scripting, and a troubleshooting
  lab that seeds a real fault. The catalog, the API, and the React pages gained
  no knowledge of either track's name.
- **A second substrate.** `LinuxLabProvider` gives each session its own
  container — resource-limited, capability-bounded, with no network and no host
  mounts — behind the same `LabProvider` interface the Kubernetes provider
  implements, and on top of the same `ContainerLabProvider` that backs
  Terraform.
- **A provider registry.** `ProviderRegistry` resolves each lab to the
  substrate its own `environment.provider` names, and routes cleanup back to
  the provider that created each sandbox by its ownership label.
- **A seeding mechanism for system state.** `setup.seed_scripts` runs
  platform-authored baseline scripts as the sandbox's root, then deletes them —
  the only way to stage a lab about accounts, services or `/var/log`.
- **State-based Linux verification.** 18 further requirement types covering
  files, modes, ownership, content, processes, listening ports, accounts and
  groups, and scripts — graded by behaviour, never by command history.
- **A shell in the student's own container.** The terminal gateway gained a
  second shell implementation and still holds no container-runtime access: a
  Linux shell is a PTY inside the session's container, reached through the
  broker.
- **Terminal reattach on reset.** A Linux reset replaces the container, so the
  shell inside it dies; the browser is reconnected to a fresh one on the same
  socket instead of being left with a dead terminal.

Deliberately **not** in scope: authentication, payments, subscriptions, AI,
certificates, AWS, an instructor portal, the JumpToBank application. Sandbox
session state is still in memory — it describes disposable environments and the
reaper reconciles it against reality — while *learning* state is in PostgreSQL.
Prerequisites and skills remain **metadata only**: nothing gates a lab, and the
API still says so explicitly (`prerequisitesEnforced: false`). Student identity
is a **development identity**, not a login — see
[Development student identity](#development-student-identity).

---

## Architecture

```text
┌──────────────────────────────────────────────────────────────────────────┐
│  Browser                                                                 │
│  ┌────────────────────────────┐   ┌──────────────────────────────────┐   │
│  │ apps/web  (React + Vite)   │   │ xterm.js                         │   │
│  │  catalog · brief · session │   │  keystrokes ⇄ bytes              │   │
│  └────────────┬───────────────┘   └───────────────┬──────────────────┘   │
│           holds a session_id — never a namespace, never a kubeconfig     │
└───────────────│───────────────────────────────────│──────────────────────┘
                │ REST (JSON)                       │ WebSocket (JSON frames)
                │ :4000                             │ :4001
┌───────────────▼───────────────────┐   ┌───────────▼──────────────────────┐
│ apps/api                          │   │ services/terminal                │
│  · GET  /api/labs/…               │   │  · verifies the session token    │
│  · POST /api/labs/:id/start       │   │  · asks the API for THIS         │
│  · /api/sessions/:sid/{check,     │◄──│    session's kubeconfig          │
│      reset,activity} · DELETE     │HMAC│  · spawns ONE real PTY (bash)   │
│  · POST /internal/…/credentials   │──▶│  · holds no cluster credential   │
│  · NEVER executes student input   │   └───────────┬──────────────────────┘
└───────┬───────────────┬───────────┘               │ kubectl, as the
        │               │                           │ session ServiceAccount
┌───────▼──────────┐ ┌──▼──────────────────┐        │
│ services/        │ │ services/verifier   │        │
│ lab-orchestrator │ │  reads live state   │        │
│  SessionManager  │ │  in ONE namespace   │        │
│  ├ start()       │ └──┬──────────────────┘        │
│  ├ reset()       │    │                           │
│  ├ end()         │    │                           │
│  ├ expire()      │    │                           │
│  └ credentials() │    │                           │
│  SessionReaper   │    │                           │
│  LabProvider     │    │                           │
└───────┬──────────┘    │                           │
        │               │                           │
        └───────────────┴───────────────────────────┘
                        │ Kubernetes API
                        ▼
        ┌───────────────────────────────────────────────────────┐
        │ kind cluster  "jumptotech-labs"   (ONE shared cluster) │
        │   lab-3f9c1a7b2d40   lab-8a02fd9579bf   lab-…          │
        │   ├ ServiceAccount   ├ ServiceAccount   …              │
        │   ├ Role/Binding     ├ Role/Binding                    │
        │   ├ ResourceQuota    ├ ResourceQuota                   │
        │   ├ LimitRange       ├ LimitRange                      │
        │   └ NetworkPolicy    └ NetworkPolicy                   │
        └───────────────────────────────────────────────────────┘
                        ▲
                        │ created on the HOST by scripts/cluster-up.sh
                        │ (never from a container — see Security)
```

Since PLATFORM-004 there is a second substrate under the same seam. The
right-hand half of the picture is new; nothing above `LabProvider` changed:

```text
        ┌──────────────────┐          ┌────────────────────────────┐
        │ lab-orchestrator │          │ services/terminal          │
        │ ProviderRegistry │          │  one SpawnPlan, two shapes │
        └───┬──────────┬───┘          └───────┬────────────┬───────┘
            │          │                      │            │
   environment.provider│               kubeconfig PTY      docker exec PTY
      kubernetes │     │ linux / terraform     │            │
                 ▼     ▼                       ▼            ▼
     ┌────────────────┐ ┌──────────────────────────────────────────┐
     │ KindLabProvider│ │ ContainerLabProvider                     │
     │ namespace per  │ │  LinuxLabProvider · TerraformLabProvider │
     │ session        │ │  container per session                   │
     └───────┬────────┘ └───────────────────┬──────────────────────┘
             │                              │ ContainerRuntimePort
             ▼ Kubernetes API               ▼ (DockerCliRuntime)
    lab-3f9c1a7b2d40 …            jtt-lab-3f9c1a7b2d40
                                  ├ 0.5 CPU / 512MB / 128 pids
                                  ├ --network none, no bind mounts
                                  └ caps dropped, then a narrow set added back
                                    (Linux only — see The Linux track)
                        ▲                              ▲
                        │ created on the HOST by       │ image built on the
                        │ scripts/cluster-up.sh        │ HOST by
                        │                              │ npm run sandbox:build
```

### Key design decisions

**`LabProvider` is the seam.** Everything above it — API routes, verifier,
React — is unaware of *how* a sandbox is produced. See
[Multi-track architecture](#multi-track-architecture) for the contract and the
registry that resolves it.

**The seam held.** The Linux track was added by implementing that interface a
second time, not by widening it. `SessionManager`, `SessionReaper`, every REST
route, and every React component work through `ProviderRegistry`, which resolves
each call to the provider named by the lab's own `environment.provider`. The two
operations that carry no lab are the interesting ones: listing sandboxes is a
union across providers, and deleting a bare handle is routed by its name shape
and then re-checked against the *live* ownership label before anything is
removed — which is why providers on different substrates must never share a
name prefix.

**The unit of isolation is a session, not a lab.** Two students on the same lab
get two sandboxes — two namespaces, or two containers. Nothing above the
provider ever names one: the API, the verifier, and the terminal all work from a
session id and look the sandbox up server-side. `EnvironmentInfo.sandboxRef`
carries whichever kind of handle this session has, because it plays the same
role in both, and `sandboxKind` says which kind it is so the UI can label it
honestly.

**Learning state is not sandbox state.** They have different lifetimes, so they
live in different places and in different packages. `services/lab-orchestrator`
owns sessions and sandboxes, in memory, reconciled against the cluster on every
sweep. `services/progress` owns students, attempts and progress, in PostgreSQL,
and imports nothing from the orchestrator — it has never heard of a namespace.
The one arrow between them points *outward*: the session manager emits "this
session closed", and the composition root wires that to the attempt. See
[Persistent progress](#persistent-progress).

**The kind cluster is the substrate, not the sandbox.** Creating a kind cluster
requires the Docker socket. Rather than hand that capability to a web-facing
process, the cluster is provisioned once on the host by `npm run cluster:up`,
and `create()` builds one namespace inside it — quota, limits, network policy,
ServiceAccount, RBAC, then the lab's initial state.

**The container runtime is a substrate too, and building its images happens on
the host.** Building a sandbox image needs the Docker socket, so it is done once
by `npm run sandbox:build` — the same placement, and for the same reason, as
`scripts/cluster-up.sh`. The orchestrator never builds an image; it only starts
containers from one that already exists, and reports the provider unavailable
with the exact command to fix it when the image is missing.

**The Docker socket never reaches the browser or the student's shell.** No
container in `docker-compose.yml` is given it, the sandbox image contains no
Docker client, and the terminal's container-exec path is switched off inside the
Compose stack for exactly that reason. Honest limitation, stated here and in
[Security model](#security-model): outside Compose the orchestrator process does
drive the host's daemon, which is a development arrangement — production would
put a rootless, per-tenant daemon behind a dedicated broker service.

**Verification is state-based.** The verifier never inspects what the student
typed. It reads `spec` and `status` from the Kubernetes API, or the filesystem,
process table and accounts inside the session's own container. Solving a lab
with `kubectl run` or `kubectl apply -f`, with `mkdir` or an editor or a script
the student wrote, all pass identically — because all of them produce the same
state.

**Verification is session-scoped.** The namespace the verifier reads comes from
the session record. A correct `nginx` Pod in someone else's namespace cannot
make your lab pass, and there is no request field anywhere that lets a caller
choose which namespace is checked.

**Terminal execution is separated from the API.** No REST endpoint runs a
shell. The terminal is a distinct service, on a distinct port, in a distinct
container, running as a distinct user, and it refuses to spawn a PTY without an
HMAC-signed session token minted by `POST /api/labs/:id/start`.

**The terminal holds no cluster credential.** It used to mount the
cluster-admin kubeconfig and hand it to every shell. Now it holds nothing: on
authentication it exchanges the session id inside the signed token for a
kubeconfig scoped to that one namespace, writes it `0600`, points that one
PTY's `KUBECONFIG` at it, and deletes it when the shell dies.

### Directory tree

```text
jumptotech-labs/
├── apps/
│   ├── api/                        REST API (Express + TypeScript)
│   │   ├── src/
│   │   │   ├── app.ts              express app assembly
│   │   │   ├── config.ts           env parsing + validation
│   │   │   ├── http.ts             structured JSON envelope
│   │   │   ├── index.ts            composition root (manager + reaper)
│   │   │   ├── routes/labs.ts      catalog + Start Lab
│   │   │   ├── routes/sessions.ts  session-scoped operations
│   │   │   ├── routes/internal.ts  credential issue (service-to-service)
│   │   │   ├── routes/me.ts        the student's progress and attempts
│   │   │   ├── identity.ts         reads the current student from a request
│   │   │   ├── progress.ts         persistence wiring + the attempt listener
│   │   │   └── terminal-control.ts closes a shell when its session ends
│   │   └── test/api.test.ts
│   └── web/                        React + Vite frontend
│       ├── index.html
│       ├── src/
│       │   ├── App.tsx             hash routing
│       │   ├── components/
│       │   │   ├── CheckPanel.tsx      verification results
│       │   │   ├── LabBrief.tsx        task panel (all content from lab.yaml)
│       │   │   ├── LabTerminal.tsx     xterm.js ⇄ WebSocket
│       │   │   ├── LabTimer.tsx        30-minute countdown
│       │   │   └── StartOverlay.tsx    Start Lab + provisioning progress
│       │   ├── lib/{api,types}.ts
│       │   ├── pages/{CatalogPage,LabPage,ProgressPage}.tsx
│       │   └── styles.css
│       └── vite.config.ts
│
├── services/
│   ├── lab-orchestrator/           lab lifecycle + sandbox providers
│   │   ├── src/
│   │   │   ├── k8s/client.ts       @kubernetes/client-node adapter
│   │   │   ├── k8s/port.ts         KubernetesPort interface (testable seam)
│   │   │   ├── k8s/labels.ts       ownership labels + the cleanup-safety gate
│   │   │   ├── k8s/student-kubeconfig.ts  namespace-scoped kubeconfig builder
│   │   │   ├── session/
│   │   │   │   ├── identifiers.ts  session ids + namespace/container derivation
│   │   │   │   ├── isolation.ts    quota / limits / netpol / RBAC manifests
│   │   │   │   ├── manager.ts      SessionManager — the state machine
│   │   │   │   ├── manifests.ts    setup-manifest loading + kind allow-list
│   │   │   │   ├── setup-files.ts  sandbox starter files + their constraints
│   │   │   │   ├── sandbox-paths.ts  the two path-traversal gates
│   │   │   │   ├── reaper.ts       SessionReaper — automatic cleanup
│   │   │   │   ├── store.ts        SessionStore (PostgreSQL-ready)
│   │   │   │   └── types.ts        session record, statuses, policy
│   │   │   ├── lab-definition.ts   lab.yaml schema + parser (zod)
│   │   │   ├── lab-registry.ts     lab discovery
│   │   │   ├── requirements.ts     closed vocabulary of checks + families
│   │   │   ├── providers/
│   │   │   │   ├── catalog.ts      the provider vocabulary (ids, sandbox kinds)
│   │   │   │   ├── registry.ts     ProviderRegistry — id → implementation
│   │   │   │   ├── factory.ts      Kubernetes substrate selection (kind, …)
│   │   │   │   ├── kind-provider.ts       Kubernetes: namespace per session
│   │   │   │   ├── linux-provider.ts      Linux: container per session
│   │   │   │   ├── terraform-provider.ts  Terraform: container + offline CLI
│   │   │   │   ├── docker-provider.ts     architecture only, disabled
│   │   │   │   ├── aws-provider.ts        architecture only, disabled
│   │   │   │   └── container/
│   │   │   │       ├── runtime.ts         ContainerRuntimePort + docker CLI
│   │   │   │       └── sandbox-provider.ts  the shared container lifecycle
│   │   │   ├── session/
│   │   │   │   ├── setup-files.ts  starter files, bounded and non-executable
│   │   │   │   ├── seed-scripts.ts lab baseline scripts, bounded + transient
│   │   │   │   └── sandbox-paths.ts  the two-gate path rule
│   │   │   ├── session-token.ts    HMAC terminal session tokens
│   │   │   ├── types.ts            LabProvider + result contracts
│   │   │   └── validation.ts       lab id allow-list
│   │   └── test/                   unit + live-cluster integration tests
│   ├── progress/                   persistent learning state (PLATFORM-005)
│   │   ├── migrations/
│   │   │   └── 001_progress.sql    forward-only schema, applied once
│   │   ├── bin/migrate.ts          npm run db:migrate
│   │   ├── src/
│   │   │   ├── types.ts            students, attempts, progress, hint usage
│   │   │   ├── identity.ts         the development identity (NOT auth)
│   │   │   ├── repository.ts       the persistence port — use cases, not CRUD
│   │   │   ├── memory-repository.ts  fallback + reference implementation
│   │   │   ├── service.ts          the use-case layer routes talk to
│   │   │   └── postgres/
│   │   │       ├── config.ts       env → connection settings, no defaults
│   │   │       ├── database.ts     the pool; the only file importing `pg`
│   │   │       ├── migrator.ts     forward-only, checksummed, lock-guarded
│   │   │       └── repository.ts   parameterised SQL + transactions
│   │   └── test/repository-contract.ts  one suite, both implementations
│   ├── terminal/                   WebSocket → PTY gateway
│   │   ├── src/
│   │   │   ├── credentials.ts      per-session terminal binding fetch
│   │   │   ├── spawn-plan.ts       the closed set of things it may spawn
│   │   │   └── {config,index,protocol,server}.ts
│   │   └── test/                   protocol, credentials, shells, live E2E
│   └── verifier/                   state-based verification
│       ├── src/
│       │   ├── handlers/           one handler per requirement type
│       │   │   ├── filesystem.ts   sandbox files, modes, owners, groups
│       │   │   ├── linux.ts        processes, ports, accounts, scripts
│       │   │   └── terraform.ts    state, resources, outputs
│       │   ├── sandbox-reader.ts   memoised reads + inspection, one sandbox
│       │   └── {index,registry,reader,contract,image,quantity}.ts
│       └── test/                   every requirement type, both families
│
├── labs/                           the catalog — data, not code
│   ├── linux/
│   │   ├── linux-001-files/lab.yaml
│   │   ├── linux-002-permissions/
│   │   │   ├── lab.yaml
│   │   │   └── setup/seed.sh               baseline, run as root, then deleted
│   │   ├── linux-003-users-groups/{lab.yaml,setup/}
│   │   ├── linux-004-processes/{lab.yaml,setup/}
│   │   ├── linux-005-services/{lab.yaml,setup/}
│   │   ├── linux-006-networking/{lab.yaml,setup/}
│   │   ├── linux-007-logs/{lab.yaml,setup/}
│   │   ├── linux-008-storage/{lab.yaml,setup/}
│   │   ├── linux-009-shell-scripting/{lab.yaml,setup/}
│   │   └── linux-010-troubleshooting/
│   │       ├── lab.yaml
│   │       └── setup/seed.sh               the injected fault
│   └── kubernetes/
│       ├── k8s-001-pods/lab.yaml           single source of truth per lab
│       ├── k8s-002-deployments/lab.yaml
│       ├── k8s-003-services/
│       │   ├── lab.yaml
│       │   └── setup/accounts-deployment.yaml    initial state
│       ├── k8s-004-configmaps/{lab.yaml,setup/}
│       ├── k8s-005-secrets/{lab.yaml,setup/}
│       ├── k8s-006-jobs/lab.yaml
│       ├── k8s-007-cronjobs/lab.yaml
│       ├── k8s-008-probes/{lab.yaml,setup/}
│       ├── k8s-009-resources/{lab.yaml,setup/}
│       └── k8s-010-troubleshooting/
│           ├── lab.yaml
│           └── setup/ledger-api.yaml         the injected fault
│   ├── linux/
│   │   └── linux-001-files-permissions/lab.yaml
│   └── terraform/
│       └── tf-001-init-plan-apply/
│           ├── lab.yaml
│           └── setup/versions.tf             the starter configuration
│
├── infrastructure/
│   ├── docker/
│   │   ├── api.Dockerfile
│   │   ├── terminal.Dockerfile
│   │   ├── web.Dockerfile
│   │   ├── sandbox-linux.Dockerfile      Debian + runit + the student account
│   │   └── sandbox-terraform.Dockerfile  + terraform CLI and provider mirror
│   └── kind/
│       ├── cluster.yaml
│       └── generated/              kubeconfigs (git-ignored)
│
├── scripts/
│   ├── cluster-up.sh
│   ├── cluster-down.sh
│   ├── cluster-status.sh
│   └── sandbox-build.sh            builds the sandbox images on the host
│
├── docker-compose.yml
├── Makefile                        convenience wrappers (make help)
├── .env.example
├── .gitignore
└── README.md
```

---

## Multi-track architecture

PLATFORM-003 ended with a catalog that could describe any lab and a platform
that could only run one kind of them. PLATFORM-004 closed that gap.

```text
                          JumpToTech Labs
                                 │
                            Lab Catalog                 labs/**/lab.yaml
                                 │
                             Lab Engine                 setup · verify · reset
                                 │                      hints · timer · session
                          Sandbox Provider              ← the only seam
                                 │
      ┌──────────────┬───────────┼────────────┬──────────────┐
      │              │           │            │              │
 Kubernetes        Linux      Docker      Terraform         AWS
   provider       provider    provider     provider       provider
      │              │           │            │              │
  namespace      container   (disabled)   container      (skeleton)
      │              │                        │
  kubectl,        bash,                   terraform,
  RBAC, quota     no network              offline mirror
```

The rule this section exists to state: **a track is data.** `environment.provider`
in a `lab.yaml` is the only place a technology is named as a *decision*. There
is no `if (track === 'linux')` in the API routes, the session manager, the
reaper, the verifier, or React: `grep -rn "'linux'" apps/ --include='*.tsx'`
finds nothing at all, and in `apps/api/src` it finds only configuration (which
image, is it enabled) and the registry composition. The UI's only concession is
two label maps — the noun for a sandbox reference, and the name of an
environment in the Start overlay — neither of which changes behaviour.

### The provider contract

One interface, in
[`services/lab-orchestrator/src/types.ts`](services/lab-orchestrator/src/types.ts):

```ts
interface LabProvider {
  readonly id: LabProviderId          // kubernetes | linux | docker | terraform | aws
  readonly name: string               // implementation: kind, docker-linux, …
  readonly sandboxKind: SandboxKind   // namespace | container | cloud-session | none

  availability(): Promise<ProviderAvailability>   // can this run here, and if not why

  create(ctx):  Promise<CreateResult>             // sandbox + guardrails + initial state
  status(ctx):  Promise<EnvironmentInfo>
  reset(ctx):   Promise<ResetResult>
  destroy(ctx): Promise<DestroyResult>            // and confirm the sandbox is gone

  getTerminalContext(ctx): Promise<TerminalContext>  // how to attach a shell
  execute(ctx, req): Promise<ExecResult>             // allow-listed binaries, internal only

  listManagedSandboxes(): Promise<ManagedSandbox[]>  // for the reaper
  destroySandbox(ref, sessionId?): Promise<DestroyResult>

  // Optional: only providers whose labs declare filesystem or Terraform
  // requirements implement this. Kubernetes labs read the Kubernetes API.
  readSandboxPath?(ctx, path, opts): Promise<SandboxPathRead | null>
}
```

Three things about it are worth saying out loud.

**`availability()` returns data, not an exception.** A laptop without Docker
still serves the Kubernetes catalog; the Linux and Terraform cards say plainly
that they cannot start here, and why. A provider that is architecture-only
(AWS) reports unavailable forever. This is what makes "do not fake labs as
runnable" enforceable rather than aspirational.

**There is no method that takes a command from a caller.** `execute()` is an
allow-list of binaries with an explicit argv array and `shell: false`, reachable
only from internal health checks and verifier reads. Student commands travel
through the terminal service, over an authenticated WebSocket, and nowhere else.

**`getTerminalContext()` replaced `issueCredentials()`.** A Kubernetes lab's
terminal binding is a kubeconfig; a Linux lab's is a container to `exec` into.
Both are the same shape to everything above the provider — see
[The terminal binding](#the-terminal-binding).

### The provider registry

[`providers/registry.ts`](services/lab-orchestrator/src/providers/registry.ts)
is the **only** place that maps a provider id to an implementation, and
[`apps/api/src/providers.ts`](apps/api/src/providers.ts) is the only place that
decides which ones this deployment offers.

| Provider | Implementation | Sandbox | State |
|---|---|---|---|
| `kubernetes` | `KindLabProvider` | namespace in a shared kind cluster | live |
| `linux` | `LinuxLabProvider` | container from `jumptotech/lab-linux` | live when Docker + the image are present |
| `terraform` | `TerraformLabProvider` | container from `jumptotech/lab-terraform` | live when Docker + the image are present |
| `docker` | `DockerLabProvider` | — | **disabled** — see [Docker sandbox strategy](#docker-sandbox-strategy) |
| `aws` | `AwsLabProvider` | — | **disabled** — see [Future AWS provider architecture](#future-aws-provider-architecture) |

`resolve()` refuses three structural cases with their own explanations: the
provider id is not in the vocabulary, nothing is registered for it, or it is
switched off. It deliberately does **not** probe the backend, because a cluster
that is down or a daemon that is not running is better reported against the
provisioning step that actually failed (`✗ Environment created — connect
ECONNREFUSED …`) than as a generic refusal. The catalog probes separately,
through `status()`, so a lab whose backend is down is marked unavailable
*before* it is clicked.

### The Kubernetes provider

Unchanged by PLATFORM-004, and deliberately so: everything in
[Multi-student architecture](#multi-student-architecture) — namespace per
session, scoped ServiceAccount and Role, ResourceQuota, LimitRange, four
NetworkPolicies, the four cleanup gates — still applies exactly as it did. The
only additions are `id`, `sandboxKind`, `availability()`, and generic aliases
for the cleanup methods.

### The Linux provider

```text
   Student session
        ↓
   LinuxLabProvider
        ↓
   docker run --network none --cap-drop ALL --security-opt no-new-privileges
              --user student --cpus 0.5 --memory 512m --pids-limit 128
        ↓
   jtt-lab-3f9c1a7b2d40         one container, one session, no host mounts
        ↓
   bash, attached by docker exec as the unprivileged student
        ↓
   verifier reads the real filesystem back through the same runtime
```

| Concern | Control |
|---|---|
| host filesystem | no bind mounts at all — `len .Mounts` is asserted to be `0` against a real daemon |
| the Docker socket | never passed in; `command -v docker` inside a sandbox fails |
| privilege | `--user student`, `--cap-drop ALL`, `--security-opt no-new-privileges`, never `--privileged` |
| network | `--network none` — a Linux lab needs none, so it gets none |
| CPU / memory | `--cpus`, `--memory`, `--memory-swap` (equal, so the ceiling is real) |
| fork bombs | `--pids-limit` |
| lifetime | the session's own deadlines, plus the reaper |

All of it comes from `SessionPolicy.sandbox`, which is read from the
environment (`SANDBOX_CPUS`, `SANDBOX_MEMORY`, `SANDBOX_PIDS_LIMIT`, …) — the
container equivalent of the ResourceQuota/LimitRange values, configurable in
the same place and for the same reason.

**Reset replaces the container.** A Kubernetes reset can purge objects and keep
the namespace, because the namespace is not where the student's state lives. A
container *is* where it lives — files, background processes, shell history,
anything they installed — so restoring a subset of it would leave the rest.
Reset therefore destroys the sandbox, creates a fresh one from the same image,
and re-seeds the lab's starter files. The cost is that the shell attached to the
old container dies; the reset response sets `reconnectTerminal: true` and the UI
reattaches to the new sandbox with the same session.

**The image is built on the host**, by `npm run sandbox:build`, and never by the
orchestrator: building an image needs the Docker socket, and the same rule that
keeps kind cluster creation out of the API applies here.

### The Terraform provider

The Linux sandbox plus the Terraform CLI and a **filesystem provider mirror**
baked into the image, with `TF_CLI_CONFIG_FILE` pointing at it and `direct`
installation excluded. Three things follow:

1. the sandbox runs with `--network none` like any other, so a Terraform lab
   has no egress;
2. `terraform init` is deterministic and offline — a registry outage cannot
   break a student's lab;
3. no cloud credential is ever needed, so none can leak.

Adding a provider to a lab means adding it to the mirror in
[`sandbox-terraform.Dockerfile`](infrastructure/docker/sandbox-terraform.Dockerfile).
That is deliberate: the set of things a student can reach is a decision, not a
default.

Provisioning refuses to hand over a Terraform sandbox whose image has no
working `terraform` in it, rather than presenting a Terraform lab with no
Terraform.

### Docker sandbox strategy

**The host Docker socket is never given to a student**, and no configuration
flag enables it. Mounting it into a sandbox is equivalent to giving the student
root on the host: they could start a privileged container, bind-mount `/`, and
read or replace anything — including every other student's sandbox and the
platform's own secrets.

Two designs would be safe enough, and neither fits in this story:

**Rootless Docker-in-Docker, one daemon per session.** Blast radius is one
session. Costs: user namespaces, a `fuse-overlayfs`/`vfs` storage driver, and
usually `--privileged` or a substantial capability set on the outer container —
exactly what this platform refuses to grant. Making it genuinely safe means a
real kernel boundary (gVisor / Kata / Firecracker) underneath, which is a
substrate change, not a code change.

**A brokered daemon.** The student's CLI talks to a platform-owned proxy that
allow-lists the operations a lab needs and stamps ownership labels on everything
created. Blast radius is whatever the allow-list permits — and the proxy is then
the entire security boundary, where one missed field in a run spec undoes it.

So PLATFORM-004 ships the *contract*: `DockerLabProvider` exists, is registered,
is covered by the provider-registry tests, and reports itself unavailable with
that reason. There is no Docker lab in `labs/`, and the catalog shows Docker
under **Coming soon**. Enabling it later is a construction argument plus a
sandbox image plus `labs/docker/…`; nothing above the provider changes.

**There is no Docker integration test, because there is nothing real to test.**

### Session and provider binding

```text
  session_id        sess-a84fc21ab3d90e12          64 bits of crypto.randomBytes
  lab_id            LINUX-001
  provider          linux                          from the lab definition
  sandbox_kind      container
  sandbox_ref       jtt-lab-3f9c1a7b2d40           HMAC(session_id), server-side
  namespace         lab-8a02fd9579bf               Kubernetes' view of the same idea
  status            ACTIVE
  created_at / last_activity_at / expires_at
```

Both bindings are decided server-side at Start Lab: the provider from the lab
definition, the sandbox reference from the session id through a keyed HMAC. The
two derivations use **different HMAC domains**, so a session's namespace name
and its container name are unrelated strings — learning one tells you nothing
about the other, and neither can be inverted back into the session id that
actually controls the session.

`SessionStore.update()` drops `provider`, `sandboxKind`, `sandboxRef` and
`namespace` from every patch. A live session therefore cannot be moved to
another sandbox or another provider by construction, rather than by every
caller remembering not to.

Teardown resolves the provider from the **stored** provider id, never from the
lab definition as it stands now — a lab edited to declare a different provider
must not make a running session tear down through the wrong backend.

What the browser sees is `provider`, `sandboxKind` and `sandboxRef`. The
reference is a developer detail shown in the terminal pane header; possessing it
grants nothing, because no endpoint anywhere accepts one as input. `namespace`
is served **only** for Kubernetes sessions: a Linux session has no namespace,
and echoing a container name under that key would be a lie the UI would repeat.

### The terminal binding

```text
  POST /api/labs/LINUX-001/start
        └─► HMAC token { sid, labId, … }  ──►  browser
                                                 │
                                    WebSocket auth frame (token only)
                                                 │
                                        services/terminal
                                                 │
                        POST /internal/sessions/:sid/credentials
                                                 │
                    ┌────────────────────────────┴───────────────────────────┐
                    │ kind: 'kubernetes'          │ kind: 'container-exec'    │
                    │ kubeconfig, namespace       │ containerRef, user, cwd   │
                    └────────────────────────────┬───────────────────────────┘
                                                 │
                    bash + KUBECONFIG      docker exec -u student <ref> bash
```

The response is a **closed, typed union that carries no command line**. The
terminal service builds its own argv from the variant, after re-validating
every field against the same patterns the orchestrator used to mint them:
the container reference must match `jtt-lab-<hex>`, the user must be a POSIX
user name, the working directory must be a plain absolute path, and environment
names and values must be ordinary single-line strings. A context that fails any
of these is rejected outright rather than sanitised.

That validation is duplicated on purpose. The API and the terminal service are
separate processes; this is the check that still holds if the other one is
wrong. Concretely: even a compromised API cannot talk the terminal service into
`exec`ing an arbitrary container or running an arbitrary command.

The browser contributes exactly one thing to this flow — the signed token — and
a second `auth` frame is still refused, so a live socket cannot move itself to
another session.

### Generic verification

```text
                       requirement
                            │
                    requirement family
        ┌───────────────────┼────────────────────┐
   kubernetes           filesystem            terraform
        │                   │                     │
  VerifyReader         SandboxReader         SandboxReader
        │                   │                     │
 Kubernetes API      the sandbox's real filesystem (docker exec, as the student)
        └───────────────────┴─────────────────────┘
                            │
                  PASS / FAIL + observed detail
```

Every requirement type declares its family in
[`requirements.ts`](services/lab-orchestrator/src/requirements.ts), and the
verifier keeps one handler map per family. Both maps are mapped types over the
requirement types of their family, so a requirement type with no handler fails
to compile — *and* a handler registered against the wrong reader fails to
compile too.

All 32 Kubernetes requirement types are unchanged. PLATFORM-004 adds nine:

| Family | Types |
|---|---|
| Filesystem | `file_exists`, `directory_exists`, `file_content`, `file_mode`, `file_owner`, `file_group` |
| Terraform | `terraform_initialized`, `terraform_resource_exists`, `terraform_output_equals` |

Design points worth stating:

**A symlink is not a file.** `stat` runs without `-L`, so a link reports as a
link. Without that, a student could satisfy a content check by pointing the
expected path at some other file, and a permissions lab would be teaching the
wrong thing.

**Reads run as the unprivileged student**, not as root — so a check sees exactly
what the student can see, and there is no privileged bypass of the permissions
the lab is teaching.

**There is no regular-expression requirement type.** A lab-supplied pattern is
untrusted input to a regex engine, and a catastrophic backtrack inside the
verifier would be a denial of service on the API for everyone. `file_content`
offers `equals` (trailing whitespace ignored) and `contains`.

**Terraform state is read, never executed.** The checks parse
`terraform.tfstate` rather than running `terraform show` in a directory whose
contents the student controls. `terraform apply` having been typed proves
nothing; a resource with no instance in state, or an output that is missing,
fails.

**Paths cannot escape the sandbox.** Two gates: the lab schema rejects anything
that is not a plain relative path, and the resolved absolute path is re-checked
against the sandbox home immediately before any read. The second is the one that
matters — a path can look safe segment by segment and still normalise somewhere
else.

The lab loader also refuses a lab whose provider cannot verify what it asks for:
a Linux lab declaring `pod_running`, or a Kubernetes lab declaring `file_mode`,
is rejected at startup with a precise message rather than failing at Check
Solution.

### Cleanup across providers

```text
   expired / idle session
            ↓
   SessionManager.expire()
            ↓
   provider recorded on the session       ← never guessed, never re-derived
            ↓
   provider.destroySandbox(ref, sessionId)
            ↓
   verify gone → mark EXPIRED
```

The orphan sweep asks **every** registered provider for the sandboxes it owns,
so a deployment running Kubernetes and container sandboxes side by side reclaims
both in one pass. A provider whose backend is unreachable records the error and
the sweep continues; one sick backend does not stop another's cleanup.

The container gates mirror the namespace ones exactly:

1. the name must parse as `jtt-lab-<hex>`;
2. the *live* container must carry `jumptotech.io/managed=true`;
3. when a session id is supplied, the container's session label must match it;
4. a container that is already gone counts as deleted, so teardown is
   re-entrant.

Gates 2 and 3 are re-read from the runtime immediately before every delete, so a
stale record cannot authorise one. A developer's own container called
`lab-something`, or a hand-labelled `my-postgres`, cannot be reached from this
path — gate 1 refuses it before anything else runs.

### Adding a provider

Adding, say, **Ansible** is three things and no rewrites:

1. add `'ansible'` to `LAB_PROVIDERS`, `PROVIDER_ISOLATION` and
   `PROVIDER_SANDBOX_KIND` in
   [`providers/catalog.ts`](services/lab-orchestrator/src/providers/catalog.ts),
   and to `PROVIDER_REQUIREMENT_FAMILIES` in `lab-definition.ts`;
2. implement `LabProvider` — for a container-backed track that is a subclass of
   `ContainerLabProvider` pinning an image, which is all
   [`linux-provider.ts`](services/lab-orchestrator/src/providers/linux-provider.ts)
   is;
3. register it in [`apps/api/src/providers.ts`](apps/api/src/providers.ts).

Then drop in `labs/ansible/ansible-001-…/lab.yaml` with
`environment: { provider: ansible }`. The catalog, the lab page, the timer, the
hints, the session lifecycle, the terminal, the verifier and the reaper all work
already, because none of them names a provider.

What would additionally require code is a genuinely new *kind of check* — say
`ansible_playbook_applied`. That is one entry in `requirements.ts` (with its
family) and one handler in the verifier; the compiler refuses the first without
the second.

### Adding a lab to an existing provider

Exactly as before — a directory and a `lab.yaml`. For a container-backed
provider the only differences are the requirement types you may use and the way
starter state is declared:

```yaml
environment:
  provider: linux          # isolation is filled in from the provider

setup:
  files:                   # instead of Kubernetes manifests
    - source: setup/versions.tf
      path: terraform/versions.tf
      mode: '644'
  verify:
    - type: file_exists
      path: terraform/versions.tf
      label: Starter configuration is in place

requirements:
  - type: file_mode
    path: deploy
    mode: '750'
    label: deploy permissions are rwxr-x---
```

Starter files are constrained the same way setup manifests are: `source` cannot
escape the lab directory, `path` cannot escape the sandbox home, each file is
size-capped, and the mode has its execute bits cleared — so lab content cannot
ship a script. Nothing in the platform executes a starter file in any case; that
is belt and braces.

---

## The lab catalog

```text
                          JumpToTech Labs
                                 │
                            Lab Catalog                  labs/**/lab.yaml
                                 │                       discovered at startup
                    ┌────────────┴────────────┬───────────────┬───────────────┐
                    │                         │               │               │
               Kubernetes                   Linux          Docker        Future tracks
                    │                         │               │
   ┌────────┬───── … ────────┐   ┌──────────┬─ … ─────────┐ ┌───────┬──── … ───┐
K8S-001  K8S-002          K8S-010 LINUX-001 LINUX-002  LINUX-010  DOCKER-001 … DOCKER-010
   └────────┴───── … ────────┘   └──────────┴─ … ─────────┘ └───────┴──── … ───┘
                    └────────────┬────────────┴───────────────┘
                                 │
                       Generic Lab Engine          no lab-specific code
                    setup · verify · reset · hints    no track-specific code
                                 │
                          Session Manager
                                 │
                        Provider registry            environment.provider
                    ┌────────────┴────────────┐
                    │                         │
            namespace per session      container / daemon per session
                    │                         │
             Kubernetes cluster    Linux · Terraform · Docker sandboxes
```

A lab names its substrate in `environment.provider`, and that one field selects
the `LabProvider` that builds its sandbox and the reader that grades it. Nothing
above the provider registry branches on a track name: the API has no
`/api/docker/*`, the frontend has no list of known tracks, and the session
manager, the reaper, and the catalog are all substrate-agnostic. Adding a
substrate means adding a `LabProvider` and its requirement handlers.

The rule this section exists to state: **adding a lab does not change the
application.** No React component, API route, orchestrator method, or verifier
handler names a lab. `grep -r 'K8S-0' apps/ services/ --include='*.ts*'` finds
only test fixtures, and the same is true of `LINUX-0`.

PLATFORM-LINUX-001 extended that rule one level up: **adding a track does not
change the application either.** No component switches on a track name. The
catalog renders track cards because the API reported more than one track, and a
third track would render the same way without a line of frontend work.

### The ten Kubernetes labs

| Lab | Title | Topic | Level | Prerequisites | Starts from |
|---|---|---|---|---|---|
| K8S-001 | Create Your First Pod | pods | beginner | — | empty namespace |
| K8S-002 | Run an Application with a Deployment | workloads | beginner | K8S-001 | empty namespace |
| K8S-003 | Expose a Workload with a Service | networking | beginner | K8S-002 | `accounts` Deployment |
| K8S-004 | Move Configuration into a ConfigMap | configuration | beginner | K8S-002 | `statements` Deployment |
| K8S-005 | Hold Sensitive Configuration in a Secret | configuration | beginner | K8S-004 | `payments` Deployment |
| K8S-006 | Run a One-Time Task with a Job | batch | beginner | K8S-002 | empty namespace |
| K8S-007 | Schedule Recurring Work with a CronJob | batch | beginner | K8S-006 | empty namespace |
| K8S-008 | Signal Readiness with a Probe | reliability | intermediate | K8S-003 | `notifications` + Service |
| K8S-009 | Declare Resource Requests and Limits | scheduling | intermediate | K8S-002 | `reporting` Deployment |
| K8S-010 | Repair a Broken Deployment | troubleshooting | intermediate | K8S-003, K8S-008 | **a broken workload** |

Every lab is an original JumpToTech scenario set on a fictional banking
platform, written from the official Kubernetes documentation. No wording,
task, or solution is taken from any third-party training platform, and the
loader rejects a definition that links to one.

### The ten Linux labs

| Lab | Title | Topic | Level | Prerequisites | Starts from |
|---|---|---|---|---|---|
| LINUX-001 | Files and Directories | linux-fundamentals | beginner | — | an empty home directory |
| LINUX-002 | File Permissions | linux-fundamentals | beginner | LINUX-001 | a reporting directory with the wrong modes |
| LINUX-003 | Users and Groups | linux-administration | beginner | LINUX-002 | a root-owned deploy area, no team group yet |
| LINUX-004 | Processes | linux-fundamentals | beginner | LINUX-003 | one runaway process, one job not started |
| LINUX-005 | Managing Services | linux-administration | intermediate | LINUX-004 | two runit services, both in the wrong state |
| LINUX-006 | Networking Basics | linux-networking | intermediate | LINUX-005 | an edge service bound to loopback only |
| LINUX-007 | Reading and Filtering Logs | linux-administration | intermediate | LINUX-006 | a payments log and an archived log |
| LINUX-008 | Filesystem Usage and Disk Space | linux-administration | intermediate | LINUX-007 | a log archive that has grown |
| LINUX-009 | Writing a Health-Check Script | shell-scripting | intermediate | LINUX-008 | status fixtures and an empty scripts dir |
| LINUX-010 | Linux Troubleshooting | troubleshooting | advanced | LINUX-009 | **three independent faults** |

Same rules, same schema, same file. The Linux labs are written from the GNU
Coreutils manual, the Linux man-pages project, and the Debian documentation;
the loader applies the same refusal to commercial training links.

The two families cannot be mixed. A Linux lab that asks for a Kubernetes check,
a Kubernetes lab that asks for a filesystem check, a Linux lab that declares
Kubernetes setup manifests, or a lab declaring an isolation model its provider
cannot deliver are all rejected at load time, with the reason named.

### Prerequisites are advice, not a gate

Prerequisites are declared, validated, resolved to titles, and shown in the UI.
They are **not enforced**. PLATFORM-005 added stored progress, so the data a
gate would need now exists — but there is still no authentication, so
"completed" is attributable only to a development identity, and gating a lab on
an unauthenticated claim would be theatre. Rather than leave that ambiguous,
`GET /api/labs` and `GET /api/labs/:id` both still return
`prerequisitesEnforced: false`, and the lab page prints "Nothing stops you
starting this lab now."

What *is* enforced today is structural integrity: a prerequisite naming a lab
that does not exist, or a cycle, unregisters the offending lab and records a
`LAB_DEFINITION_INVALID` error rather than shipping a catalog with a broken
path through it.

### The lab definition schema

One file, `labs/<track>/<slug>/lab.yaml`, is the single source of truth for a
lab: its catalog card, its brief, its starting state, its verification, its
reset policy, and its hints.

```yaml
id: K8S-002                     # unique; matches ^[A-Z][A-Z0-9]{1,9}-\d{3}$
slug: k8s-002-deployments       # unique; must equal the directory name
title: Run an Application with a Deployment
track: kubernetes               # groups the catalog
topic: workloads                # groups within a track
difficulty: beginner            # beginner | intermediate | advanced
level: practice                 # practice | challenge | assessment
duration_minutes: 30
order: 2                        # sort position within the track

environment:
  provider: kubernetes
  isolation: namespace          # the only value; keeps the seam visible

prerequisites: [K8S-001]        # advisory — see above
story: >                        # the realistic situation, rendered as "Scenario"
  The JumpToTech Bank customer frontend runs as a single Pod...
objectives:                     # what the student can do afterwards
  - Describe what a Deployment adds on top of a bare Pod

task:
  summary: Create a Deployment named frontend running 3 replicas.
  description: >
    Longer explanation, rendered as paragraphs.

requirements:                   # the student checklist AND the verifier input
  - type: deployment_replicas
    name: frontend
    replicas: 3
    label: Deployment requests 3 replicas    # required; the only text shown

setup:                          # optional; omit for a lab starting from empty
  manifests: [setup/app.yaml]
  verify:                       # must be non-empty when manifests is
    - type: deployment_exists
      name: app
  verify_timeout_seconds: 180

reset:                          # optional; sensible defaults
  purge_namespaced_resources: [pods, deployments, services, ...]
  protected_resources: []

hints:                          # progressive; level 1 upward, no gaps
  - level: 1
    text: Conceptual nudge.
  - level: 2
    text: Where to look.
  - level: 3
    text: Concrete guidance — never a copy-pasteable solution.

references:                     # at least one official kubernetes.io link
  - title: Deployments
    url: https://kubernetes.io/docs/concepts/workloads/controllers/deployment/

skills: [kubernetes.deployments.create]        # dotted lowercase
certification:
  - certification: CKA
    relevant: true
    domains: [workloads-and-scheduling]
```

Validation runs at startup and is deliberately strict:

- every object is `.strict()`, so an unknown key is an **error**, not ignored data;
- there is **no field anywhere that carries a command, script, or shell fragment**;
- there is **no `namespace:` field** — the namespace belongs to the session;
- `requirements[].label` is **required**, so the student-facing checklist can
  never fall back to printing an internal requirement type;
- hints must start at level 1 and ascend without duplicates;
- at least one reference must point at official documentation for the track,
  and links to commercial training platforms are refused outright;
- `setup.verify` must be non-empty whenever `setup.manifests` is, so a student
  is never handed a starting condition nobody checked.

An invalid lab is skipped, not fatal — the rest of the catalog still loads, and
the reason is reported on `GET /health` and at startup:

```text
LAB_DEFINITION_INVALID

K8S-004:
requirements[1].type is not supported ('pod_teleports'; supported types: …)
(labs/kubernetes/k8s-004-configmaps/lab.yaml)
```

### How setup manifests work

A lab that starts from an existing state declares plain Kubernetes YAML:

```yaml
setup:
  manifests:
    - setup/ledger-api.yaml
  verify:
    - type: deployment_exists
      name: ledger-api
```

At **Start Lab**, and again at **Reset Lab**, those files are read, validated,
and applied into *that session's* namespace, in declaration order. The
orchestrator then polls `setup.verify` until it passes or `verify_timeout_seconds`
elapses; a setup that never materialises fails provisioning with `SETUP_FAILED`
rather than handing over a broken lab.

Four rules bound what a lab author can do here, all enforced in code:

1. **Kinds are allow-listed** — Pod, Deployment, ReplicaSet, StatefulSet,
   DaemonSet, Job, CronJob, Service, ConfigMap, Secret, Ingress, PVC. A
   manifest declaring `Namespace`, `ClusterRole`, `ResourceQuota`, `LimitRange`,
   or `NetworkPolicy` is rejected — lab content cannot dismantle the guardrails
   the platform put around it.
2. **`metadata.namespace` is forbidden.** The namespace is imposed by the
   platform at apply time, so a lab cannot seed resources into another
   student's sandbox.
3. **Paths cannot escape the lab directory.** Absolute paths, `..`, backslashes
   and non-`.yaml` files are refused by the schema, and the resolved path is
   re-checked against the lab directory before any read.
4. **Nothing executes.** Setup is declarative data. There is no shell-script
   hook, and no schema field that could carry one.

`setup.verify` for a troubleshooting lab deliberately checks only that the
fixture landed — K8S-010's starting condition is a workload that *cannot*
become available, so asserting health there would fail every provision.

### How verification works

Verification is **state-based**. The verifier reads `spec` and `status` from the
Kubernetes API in the session's namespace and never looks at what the student
typed. `kubectl edit`, `kubectl patch`, `kubectl set`, `kubectl apply -f`, and a
heredoc all pass identically, because all of them produce the same state.

```text
lab.yaml requirements[]  →  requirement type  →  handler  →  Kubernetes API
                                                                  │
                                                       pass / fail + observed detail
```

The requirement vocabulary is closed and shared: `requirements.ts` defines it,
the lab schema validates against it, and the verifier registry implements one
handler per type. `HANDLERS` is a mapped type over every `RequirementType`, so a
requirement type with no handler **fails to compile**.

| Group | Types |
|---|---|
| Pods | `pod_exists`, `pod_image`, `pod_running`, `pod_phase`, `pod_ready`, `pod_label`, `pod_resources` |
| Deployments | `deployment_exists`, `deployment_image`, `deployment_replicas`, `deployment_available`, `deployment_rollout_complete`, `deployment_selector`, `deployment_resources`, `deployment_probe`, `deployment_uses_configmap`, `deployment_uses_secret` |
| Services | `service_exists`, `service_type`, `service_port`, `service_selector`, `service_endpoints` |
| Configuration | `configmap_exists`, `configmap_key`, `secret_exists`, `secret_key`, `secret_type` |
| Batch | `job_exists`, `job_completed`, `job_image`, `cronjob_exists`, `cronjob_schedule`, `cronjob_suspended` |
| Generic | `resource_absent` |

Three deliberate design points:

**Secret values are never read.** `secret_key` checks that a key *exists*; it
has no `value` field, unlike `configmap_key`. No lab can be written that would
require the platform to hold a credential.

**`deployment_resources` reads the Pod template, not a running Pod.** Every lab
namespace has a LimitRange that defaults container resources, so a Pod always
reports requests and limits whether or not the student declared any. Only the
Deployment's template shows what was actually written — which is why K8S-009
grades the template.

**Troubleshooting labs verify the final desired state.** K8S-010's requirements
say what "working" looks like; the `label` on each one is written so that
reading the checklist before starting does not reveal the injected fault.

Results are per-requirement and independent — one failure never short-circuits
the rest, because a student is owed the full picture:

```text
Checking your environment...

✓ Deployment ledger-api exists
✗ Deployment runs the correct application image
    Incorrect image — found 'nginx:stabel', expected 'nginx:stable'
✗ Both replicas are available
    Deployment is not fully available — 0 of 2 replicas available (MinimumReplicasUnavailable)
✓ Service ledger-api exists
✗ Service selects the ledger-api Pods
    selector 'app' is 'ledger', expected 'ledger-api'
✗ Service has two ready endpoints behind it
    The Service has no backend endpoints — no Pod in this namespace currently matches it

LAB NOT COMPLETE
```

Failure detail describes **what is wrong with the observed state**, never what
to type.

### How progressive hints work

A lab declares a ladder of hints at ascending levels. The UI reveals **one at a
time**: level 1 is a conceptual nudge, level 2 says where to look, level 3 names
the objects and the documentation. Revealing the whole ladder at once would make
the first hint pointless, because the last one would already be on screen.

```text
Hints                                    0 of 3
Stuck? Hints unlock one at a time.
[ Show a hint            3 left ]
```

Hint usage is reported through an `onReveal(hint, revealedCount)` callback so a
later story can persist it. **Nothing is stored today** — PLATFORM-003 has no
database, and the count resets with the page.

### Isolation applies to every lab

Every lab, without exception, runs inside the PLATFORM-002 architecture: a
unique session id, a derived namespace, a scoped ServiceAccount and Role,
a ResourceQuota, a LimitRange, four NetworkPolicies, an absolute deadline, an
idle deadline, and automatic cleanup. There is no shared lab namespace and no
per-lab exception anywhere in the session path — the lab definition is data
handed to the same session machinery every time.

Two students on K8S-010 get two broken workloads in two namespaces. One
student's Reset restores their own fault and leaves the other's repair alone;
that is asserted against a real cluster in
[`labs-integration.test.ts`](services/lab-orchestrator/test/labs-integration.test.ts).

The Linux track applies the same rule on its own substrate: a unique session id,
a derived container name, resource ceilings, a private network, an absolute
deadline, an idle deadline, and the same reaper. See
[The Linux track](#the-linux-track).

---

## The Linux track

A Linux lab is the same lab engine on a different substrate. Everything
PLATFORM-002 and PLATFORM-003 established — session ids, deadlines, cleanup,
the catalog, hints, state-based verification, "no lab-specific code" — holds
unchanged. What differs is where the state lives.

| | Kubernetes track | Linux track |
|---|---|---|
| Sandbox | a namespace in a shared cluster | a container on a shared Docker host |
| Handle | `lab-3f9c1a7b2d40` | `jtt-lab-3f9c1a7b2d40` |
| Created by | `KindLabProvider` → Kubernetes API | `LinuxLabProvider` → `ContainerRuntimePort` → Docker |
| Student credential | a namespace-scoped ServiceAccount kubeconfig | none — a PTY in their own container |
| Shell | a PTY in the terminal container, holding that kubeconfig | a PTY inside the session's container |
| Verified by reading | `spec`/`status` from the Kubernetes API | the filesystem, process table, sockets and accounts |
| Setup | Kubernetes manifests, applied into the namespace | starter files, plus seed scripts run as root and then deleted |
| Reset | purge the namespace's objects, keep the namespace | replace the container from the image |

The Linux provider is a thin subclass of `ContainerLabProvider`, the shared
container lifecycle that also backs Terraform. It pins the image, the
capability grant, the foreground process and the inspection vocabulary; the
create/status/reset/destroy/cleanup machinery is the same code for both.

### The ten labs

| Lab | Topic | What it teaches |
|---|---|---|
| LINUX-001 | files | navigating, creating, and *moving* rather than copying |
| LINUX-002 | permissions | modes, ownership, and what an executable actually needs |
| LINUX-003 | users & groups | `useradd`, `groupadd`, primary vs secondary membership |
| LINUX-004 | processes | reading the process table, stopping and starting work |
| LINUX-005 | services | enabling, starting and inspecting a supervised service |
| LINUX-006 | networking | listening sockets, and capturing what is bound where |
| LINUX-007 | logs | finding the signal in a log, and in a rotated archive |
| LINUX-008 | storage | usage, reclaiming space, and keeping an index honest |
| LINUX-009 | shell scripting | writing a script graded on behaviour, not on source |
| LINUX-010 | troubleshooting | a seeded fault, diagnosed and repaired |

### What a student's container is

One container per session, created from `jumptotech/lab-linux` and thrown away
with the session. It has:

- **no host filesystem** — no bind mounts, ever, and the Docker socket is never
  passed in. The image contains no Docker client either;
- **no network** — `--network none`. Nothing in the track needs egress;
- **hard ceilings** — `--cpus`, `--memory`, `--memory-swap` and `--pids-limit`
  from `SessionPolicy.sandbox`, so one student cannot exhaust the host and an
  abandoned shell cannot fork-bomb it;
- **a real Debian userland** — GNU coreutils, `procps`, `iproute2`, man pages,
  and `runit` as a genuine process supervisor;
- **a Python 3.11 runtime** — the Computer Science track grades a student's own
  program by running it, which needs a real interpreter rather than a mocked
  one. It is the standard library only: no pip, no virtualenv tooling, no
  third-party distribution, no compilers. It adds no capability, no socket and
  no privilege — the sandbox already ships `bash`, so this changes how
  expressively a student can write a program, not what they can reach.

### On root, and what the boundary actually is

A Terraform sandbox keeps the strictest possible profile: `--cap-drop ALL`,
`no-new-privileges`, and a foreground process that does nothing. The Linux
sandbox cannot, and pretending otherwise would make the track dishonest —
LINUX-003 is about `useradd`, LINUX-005 is about a supervised service,
LINUX-002 is about a file the student does not own. A stubbed `systemctl` or a
fake `useradd` would teach students to type commands that produce no effect.

So the Linux sandbox drops every capability and then adds back a narrow,
explicit list — `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `SETUID`,
`SETGID`, `SETPCAP`, `KILL` — and allows privilege escalation so `sudo` works.
That list is checked against `GRANTABLE_CAPABILITIES` in the runtime before
anything reaches Docker, and `SYS_ADMIN`, `NET_ADMIN`, `SYS_PTRACE`, `MKNOD`,
`SYS_MODULE` and `SYS_BOOT` are *not in it and cannot be added from
configuration*.

What that changes: the student is root inside their own container. What it does
not change: no host filesystem, no Docker socket, no network, the same resource
ceilings, the same one-container-per-session derivation, and the same reaper.
**The isolation boundary for a Linux lab is the container, not the account
inside it** — and a container is not a virtual machine, which is stated plainly
in [Security model](#security-model) as well.

### Why root in the sandbox is also a *grading* concern

Root inside the sandbox is safe for the host. It is not safe for the *grade*.
The verifier reads state back by running binaries inside that same container —
`/usr/bin/stat` and `/bin/cat` for every file check, an allow-listed inspection
command for the rest — so a student who can become root can replace those
binaries and make an untouched home directory report whatever the lab was
looking for. This was demonstrated end to end against CS-001: with nothing
solved, a replaced `cat` and `stat` turned `0/11` into `LAB PASSED`.

A lab therefore declares `unprivileged_shell` under
`environment.capabilities` when it does not teach system administration. The
provider removes the sudo drop-in once, as the sandbox's root, after tooling is
confirmed and before any seed script or student shell exists, and verifies the
grant is genuinely gone before the sandbox is handed over. Reset re-applies it,
because reset replaces the container. The student cannot undo it, because
undoing it needs the privilege it just removed.

The capability *narrows* rather than widens, which is deliberate: making sudo
opt-in would mean editing every Linux lab to ask for a privilege it has always
had. A lab that says nothing keeps exactly the environment it has today.

This is not the only protection, and it must not be treated as one. Nothing
authoritative lives in the sandbox in the first place: expected values live in
`lab.yaml` on the API host, where a student has no reach at all. Removing root
protects the *reading* of student state; keeping the answers outside protects
the *grading* of it. For the tracks that genuinely need root — Linux, and any
future administration track — the remaining hardening is to read the sandbox
through the container runtime's archive API instead of through binaries the
student could replace. `docker cp` answers from the daemon, not from the
container's userland, and returns the truth where a replaced `cat` lies.

### The shell

The terminal service attaches a PTY to the session's container. It learns
*which* container from the API, keyed by the session id inside a signed token —
never from the browser — and it builds the argv itself from a closed
`SpawnPlan`, after re-validating the container name shape. There is no field
anywhere in the terminal binding that can become "run this string", and no
credential is involved at all: the student's shell is not authenticated by a
token, it is a process inside a container that belongs to exactly one session.

A reset replaces the container, which kills the shell inside it. The API calls
the terminal service's `/internal/reattach`, and the same browser socket gets a
fresh shell in the fresh container — the session, the token and the scrollback
all survive.

### Setup, without executing lab content anywhere it does not belong

Two mechanisms, in a deliberate order:

1. **`setup.files`** — starter content written as the unprivileged student, so
   it carries exactly the ownership the student's own work would.
2. **`setup.seed_scripts`** — platform-authored scripts, shipped in the lab's
   own directory, run inside *that session's* container as its root.

The second exists because the first cannot stage a lab about accounts,
services or `/var/log`. It is fenced the same way `setup.manifests` is:
lab.yaml carries a *filename*, never a command; the path is confined to the
lab's directory and re-checked after resolution; the file must begin with `#!`
and is size-capped; and nothing student-supplied and nothing reachable from an
HTTP route can reach the loader.

Each script is written into a root-only directory, run once, and deleted — and
the directory is emptied again in a `finally`, so a script survives neither
success nor failure. That deletion is not tidiness: a troubleshooting lab's
seed script *describes the fault it injects*, and the student is root in there.

### Verification

The `linux` requirement family adds what a file read cannot answer: is this
process running, is anything listening on that port, does this account exist
and is it in that group, does the script the student wrote actually work.

Three of those types run something, and they are fenced:

- **`command_exit_code` / `command_output`** name a binary from
  `VERIFIER_COMMANDS`, a closed allow-list of read-only inspection binaries.
  A lab cannot name `rm`, `chmod` or `bash`, and the list cannot be extended
  from lab.yaml. Arguments are an argv array with no shell anywhere.
- **`script_runs`** runs the student's own file, by path, as the student,
  inside their own container — the one place that code can already run, because
  they have a shell in it. It reaches nothing on the host and nothing belonging
  to another student. It is a *separate* provider capability from inspection,
  because "run a fixed platform binary" and "run student code" are different
  things to reason about and should be different things to grant.

Process matching happens in the verifier, over a table it read itself; a lab's
pattern is never handed to `pgrep`, a shell, or a regular-expression engine, so
it can neither inject nor backtrack.

### Running the Linux track locally

```bash
npm run sandbox:build   # builds jumptotech/lab-linux (once, ~1 minute)
```

Then run the services on your host:

```bash
npm run dev:api
npm run dev:terminal
npm run dev:web
```

**The compose stack runs Linux labs through `sandboxd`**, the runtime broker.
It is the only process in the stack given a container runtime; the `api` and
`terminal` services have none, and the Docker socket is mounted into neither.
`make up` includes it:

```bash
docker compose -f docker-compose.yml -f docker-compose.runtime.yml up
```

Before the broker existed the container-backed tracks were switched off here,
because attaching a shell meant running `docker exec` *in the terminal service*
— the one process a student types into. That is the whole reason 81 of the 114
labs could not run in a deployed stack. See
[docs/runtime-architecture.md](docs/runtime-architecture.md).

The base file without that overlay still runs the Kubernetes track alone, with
no container runtime anywhere (`make up-kubernetes-only`); the container tracks
then stay in the catalog and their cards say plainly that they cannot be started
there.

Without the image built, nothing pretends to work either: the provider reports
itself unavailable with the exact command to fix it, and the catalog marks its
labs accordingly.

Every limit, image, user and network above is configuration, not code. See the
sandbox blocks in [`.env.example`](.env.example).

The Docker track gets the same treatment with a different boundary — one
isolated daemon per session instead of one namespace. See
[The Docker track](#the-docker-track).

---

## The Docker track

Docker is a **learning track and a provider capability**, not a replacement for
the lab engine. It sits beside Kubernetes under the same catalog, the same
session manager, the same reaper, and the same UI.

### The ten Docker labs

| Lab | Title | Topic | Level | Starts from |
|---|---|---|---|---|
| DOCKER-001 | Run Your First Container | containers | beginner | `nginx` image pre-loaded |
| DOCKER-002 | Manage the Container Lifecycle | lifecycle | beginner | two running containers |
| DOCKER-003 | Pull, Inspect, and Tag Images | images | beginner | empty image store |
| DOCKER-004 | Build an Image from a Dockerfile | dockerfile | intermediate | a seeded workspace |
| DOCKER-005 | Persist Data with Volumes | storage | intermediate | base image pre-loaded |
| DOCKER-006 | Connect Containers on a Custom Network | networking | intermediate | base images pre-loaded |
| DOCKER-007 | Configure a Container with Environment Variables | configuration | beginner | base image pre-loaded |
| DOCKER-008 | Run a Multi-Container Application | compose | intermediate | a seeded workspace |
| DOCKER-009 | Constrain a Container with Resource Limits | resources | intermediate | base image pre-loaded |
| DOCKER-010 | Repair a Broken Container | troubleshooting | intermediate | **a broken container** |

Every lab is an original JumpToTech scenario on the same fictional banking
platform, written from the official Docker documentation. The loader enforces
that per track: a Docker lab must cite `docs.docker.com`, exactly as a
Kubernetes lab must cite `kubernetes.io`, and a link to a commercial training
platform is rejected either way.

### The sandbox

One session gets **one container running its own complete Docker daemon**
(`docker:dind`), with its own image store, container list, volume set, and
networks.

```text
  browser terminal ──mTLS──► sandbox lab-a1b2  ──► daemon A ──► student containers A
  browser terminal ──mTLS──► sandbox lab-c3d4  ──► daemon B ──► student containers B
```

`docker ps` in session A cannot show session B's containers — not because a
filter hides them, but because they are registered with a different daemon
process entirely. Two students on DOCKER-010 get two broken containers in two
daemons; one student's Reset restores their own and leaves the other's repair
alone.

**How a student reaches their daemon.** The dind image generates a fresh
certificate authority per container at startup. The terminal service is handed
that sandbox's client certificate and sets `DOCKER_HOST=tcp://lab-…:2376`,
`DOCKER_TLS_VERIFY=1`, and `DOCKER_CERT_PATH`. Pointing that shell at another
session's sandbox fails TLS verification in **both** directions: that daemon
does not trust this session's CA, and this session's client does not trust that
daemon's. Network reachability is therefore not the security boundary; mutual
TLS is. That is asserted against a real Docker daemon — not a fake — in
[`docker-integration.test.ts`](services/lab-orchestrator/test/docker-integration.test.ts).

**How the platform reaches it.** Not over TLS at all. The orchestrator runs
`docker exec <sandbox> docker …` on the host daemon, so it never holds a
session's private key and cannot leak one.

### Docker sandbox security

The design has exactly one privileged component, and it is worth stating
plainly what it does and does not protect against.

| Component | Privilege | Why |
|---|---|---|
| `sandboxd` | host Docker socket | The only holder. Eleven verbs and one PTY endpoint, no passthrough. Not published to the host, no route through the web proxy, and refuses any request carrying an `Origin` header. |
| `api` | **none** | Creates and destroys every kind of sandbox through the broker, the Docker track included. |
| sandbox container | `--privileged` | Docker-in-Docker requires it: the inner daemon creates cgroups, mounts filesystems, and programs iptables. Created by the platform; no student process runs in it. |
| `terminal` | **none** | No socket, no `DOCKER_HOST`, no ambient credential. Each PTY gets one session's client certificate, or a broker socket bound to one session. |

> The Docker track goes through the broker too. Its `DockerEnginePort` is
> brokered as a closed list of named operations — `createSandbox` takes a
> session id, a lab id and an expiry, and `sandboxd` supplies the image, the
> `--privileged` flag and every resource ceiling from its own configuration — so
> the API needs no socket for it either. All 114 labs now run with no Docker
> socket in any browser-reachable service. See
> [docs/runtime-architecture.md](docs/runtime-architecture.md) § 3.3.

The point of the arrangement: the one process a student can type into cannot
reach the host daemon, and the one process that can reach the host daemon never
runs a student's command.

What this **does not** claim:

- **`--privileged` is not a security boundary.** A student who breaks out of a
  container *inside* their sandbox reaches that sandbox's privileged context,
  and from there the host kernel. Docker-in-Docker gives isolation between
  students, not a hardened boundary against a determined attacker. A production
  deployment should place each sandbox in a VM (Firecracker, Kata, or a
  per-tenant node) — the `LabProvider` seam exists so that is a provider swap,
  not a rewrite.
- **Mounting the host socket into `api` is real privilege.** It is equivalent to
  root on that host. It is acceptable for a local development stack and is a
  deployment constraint, not a solved problem. Set `DOCKER_TRACK_ENABLED=false`
  to run the Kubernetes track with no socket mounted anywhere.
- **Workspace separation in the terminal is by unguessability.** Every student
  shell runs as the same OS user, so the per-session workspace directory is
  named by an HMAC of the session id and the root is `0711` — traversable but
  not listable. That is containment by unguessability, not kernel enforcement.
  The isolation that matters for this track — containers, images, volumes,
  networks — is enforced by separate daemons, not by that directory.

### Docker resource controls

A session's sandbox is one container, and every container the student starts is
a child of that one process tree. Capping the sandbox therefore caps the whole
session: a student cannot escape their budget by launching more containers,
because those containers spend the same budget.

| Setting | Default | Enforced? |
|---|---|---|
| `DOCKER_SANDBOX_MEMORY` | `2g` | Yes — cgroup memory limit on the sandbox |
| `DOCKER_SANDBOX_CPUS` | `2` | Yes — cgroup CPU quota on the sandbox |
| `DOCKER_SANDBOX_PIDS_LIMIT` | `512` | Yes — hard ceiling on session processes |
| `DOCKER_SANDBOX_MAX_CONTAINERS` | `10` | **No** — advisory, and reported as such |

`MAX_CONTAINERS` is honest about itself: Docker has no per-daemon container cap,
so it is displayed in the provisioning step a student sees and is not an
enforcement point. Memory and pids are the limits that actually bind.

No limit is hardcoded in provider code; every value above is read from the
environment in [`apps/api/src/config.ts`](apps/api/src/config.ts), so production
values can be tuned after load testing without a code change.

Cost model, unchanged in spirit from the Kubernetes track: starting a Docker lab
creates one container, one volume, and (once, shared) one bridge network. It
never creates a VM, a cluster, a registry, or a public address. Browsing the
catalog creates nothing at all.

### Reset and cleanup

`Reset Lab` empties the session's own daemon of everything the student created
and re-applies the lab's declared starting condition. The sandbox container
survives, so the session, the terminal, and the credentials all survive with it.
What a reset removes is per lab (`reset.docker` in `lab.yaml`); images are kept
by default, because re-pulling base images would turn a two-second reset into a
two-minute one.

`End Lab` and the reaper remove the sandbox container and its data volume.
Nothing has to enumerate the student's containers, images, or volumes: they
lived in a daemon that no longer exists. Teardown applies the same four gates as
the Kubernetes provider — the name must parse as a `lab-…` sandbox, it must not
be protected, the **live** container must carry `jumptotech.io/managed=true`,
and when a session id is supplied it must match the container's label. A stale
store record cannot authorise a delete, and repeat calls are harmless, which is
what lets the reaper re-enter teardown until it succeeds.

The reaper sweeps every configured provider in one pass, because an orphaned
sandbox has no session record to resolve a substrate from. One unreachable
substrate does not stop the other being reclaimed.

### Verification

Same rule as the Kubernetes track: **verification is state-based, and never
inspects the student's commands.** Every Docker requirement is a read of
`docker inspect` output from the session's own daemon. A container created with
`docker run`, with `docker create` + `docker start`, or from a Compose file
produces identical state and passes identically.

Two requirement types read a file the student wrote — `file_exists` and
`dockerfile_valid` — and both are reads and only reads. Nothing executes,
sources, or evaluates a workspace file; `dockerfile_valid` parses instruction
keywords and stops. The student's own `docker build` is what proves their
Dockerfile works, and `docker_image_exists` / `docker_image_config` grade the
resulting image.

The Docker vocabulary is 17 requirement types, listed in
[`requirements.ts`](services/lab-orchestrator/src/requirements.ts). Every schema
is `.strict()`, no field carries a command or a shell fragment, and a lab that
mixes vocabularies — a Docker lab asking for `pod_running` — is rejected at load
time rather than failing confusingly at check time.

---

## Persistent progress

PLATFORM-005 answers one question: *what survives?*

```text
   Student identity          students            ← who (development identity)
        │
   Persistent learning       lab_progress        ← 1/10 completed, forever
        │
   Lab attempt               lab_attempts        ← one try: checks, resets,
        │                    hint_usage            passed, ended
   Temporary sandbox         session (in memory) ← deleted on End / expiry
        │
   Provider                  kubernetes | linux | terraform
```

Every arrow points downwards, and the layers below can be destroyed without
touching the layers above. Deleting a namespace, restarting the API, losing the
whole kind cluster: none of it can remove a row, because the package that owns
the rows cannot address any of those things.

### Why progress is its own package

`services/progress` has **no dependency on `services/lab-orchestrator`**, and a
grep is the proof: there is no import of it, no `namespace` field, no
`sandboxRef`, no provider id, and no Kubernetes vocabulary anywhere in the
package. A `track` is a string. A `session_id` is a string. That is the entire
extent of its knowledge of the sandbox layer.

The one connection runs the other way, through an interface the *orchestrator*
declares:

```ts
// services/lab-orchestrator/src/session/manager.ts
export interface SessionLifecycleListener {
  onSessionClosed?(event: SessionClosedEvent): Promise<void> | void;
}
```

The session manager emits that event once per session, after the sandbox is
verifiably gone — from End Lab and from the reaper alike. `apps/api/src/
progress.ts` supplies the implementation that closes the attempt. So:

- the orchestrator still knows nothing about attempts, students, or SQL;
- ending a lab and expiring a lab cannot record different things, because they
  travel the same path;
- a listener that throws is logged and ignored — bookkeeping is never allowed
  to stop a sandbox being reclaimed.

Inside the package, the layering is `route → ProgressService →
ProgressRepository → PostgreSQL`. The port is written as *use cases*
(`recordCheck`, `recordReset`, `finishAttempt`), not as CRUD setters, so the
writes that must happen together cannot be separated by a caller. **No SQL
exists above `postgres/repository.ts`**, and no route handler has ever seen a
query.

### Database schema

Four tables, plus the migration ledger.

```text
students                     lab_progress                     lab_attempts
─────────                    ────────────                     ────────────
student_id      PK  ◄──────  student_id      PK ┐   ┌───────  student_id   FK
display_name                 lab_id          PK ┘   │         attempt_id   PK
identity_source              track                  │         lab_id
created_at                   status                 │         track
last_seen_at                 attempt_count          │         session_id   (nullable,
                             completion_count       │                       no FK)
                             first_completed_at     │         status
                             last_completed_at      │         status_reason
                             last_attempt_id        │         started_at
                             first_attempt_at       │         completed_at
                             updated_at             │         ended_at
                                                    │         check_count
hint_usage                                          │         reset_count
──────────                                          │         updated_at
hint_usage_id   PK                                  │
student_id      FK ─────────────────────────────────┘
attempt_id      FK ──► lab_attempts
lab_id
hint_index         UNIQUE (attempt_id, hint_index)
revealed_at
```

The constraints carry the rules, so no code path can produce a half-truth:

| Constraint | What it makes impossible |
|---|---|
| `lab_progress` PK `(student_id, lab_id)` | a duplicate completion row for one lab |
| `hint_usage` UNIQUE `(attempt_id, hint_index)` | counting the same hint twice |
| `CHECK ((status = 'PASSED') = (completed_at IS NOT NULL))` | a passed attempt with no completion time, or the reverse |
| `CHECK ((status = 'COMPLETED') = (first_completed_at IS NOT NULL))` | a lab marked complete that was never completed |
| partial UNIQUE on `session_id` | two attempts claiming one sandbox |
| `status IN (…)` on both tables | a status nobody defined |

Two deliberate omissions:

- **`session_id` is not a foreign key**, and never will be. Sessions live in the
  orchestrator and are deleted on cleanup; a foreign key would make a namespace
  teardown capable of deleting a student's history, which is the exact failure
  this story exists to prevent. The column is a historical reference that stops
  resolving, and that is correct.
- **No `completed` boolean.** "Ended without passing" and "expired without
  passing" are different facts, and the dashboard shows the difference.

### Migrations

Forward-only, applied at most once per database, and **never destructive**.

```bash
npm run db:migrate      # apply anything pending
npm run db:status       # list applied / PENDING without changing anything
make db-migrate         # the same, reading credentials from .env
```

- Files are `migrations/NNN_name.sql`, applied in filename order.
- Each runs inside a transaction (PostgreSQL DDL is transactional), so a failing
  migration leaves nothing half-applied.
- The version *and a SHA-256 of the file* are recorded in `schema_migrations`.
  Editing an already-applied migration is reported as an error rather than
  silently ignored — migrations are immutable once applied; add `002_*.sql`.
- A `pg_advisory_lock` serialises the run, so two API instances starting
  together cannot apply the same migration twice.

`DATABASE_AUTO_MIGRATE=true` (the default) runs this at startup. It is not a
"drop and recreate the schema on boot" scheme: on a database that is already
current it takes a lock, runs one `SELECT`, and does nothing else. The API logs
which it did:

```text
[progress] progress database postgres:5432/jumptotech_labs
[progress] migration applied 001_progress
[progress] applied 1 migration(s)
… restart …
[progress] schema up to date
```

Deployments that prefer to migrate from a pipeline set
`DATABASE_AUTO_MIGRATE=false`; the API then only pings the database and tells
you to run `npm run db:migrate`.

### The attempt lifecycle

```text
  Start Lab
      │   attempt row created BEFORE any sandbox exists
      ▼
  IN_PROGRESS ──── check (fail) ────► IN_PROGRESS   check_count += 1
      │       ──── reset ──────────► IN_PROGRESS   reset_count += 1
      │       ──── check (PASS) ───► PASSED        completed_at set, progress updated
      │
      ├──── sandbox never came up ─► FAILED        ended_at set
      ├──── End Lab ───────────────► ENDED         ended_at set
      └──── idle / max lifetime ───► EXPIRED       ended_at set

  A PASSED attempt that is later ended or expired stays PASSED and gains an
  ended_at. The sandbox lifecycle does not get to overwrite a learning result.
```

There is one path no event can cover: the API restarting while a lab is open.
Sandbox sessions are in memory, so a restart forgets the session that would have
emitted `onSessionClosed`. A sweeper — the persistent-side counterpart of the
reaper — closes attempts that have been `IN_PROGRESS` for longer than the
absolute session lifetime plus a grace period. Past that deadline no sandbox can
still exist, so it cannot close an attempt anyone is still working on, and a
restart therefore costs a student their environment rather than leaving a lab
"in progress" on their dashboard forever.

The attempt is created **before** `sessions.start()`, which is the architecture
rule made executable: the attempt is the parent of the session. A start that
never gets an environment still leaves an honest `FAILED` record instead of a
row claiming the student is still working, and the sandbox that follows is bound
to the attempt by `session_id` afterwards.

Recording a check is one transaction with a row lock:

```sql
SELECT … FROM lab_attempts WHERE attempt_id = $1 FOR UPDATE;
UPDATE lab_attempts SET check_count = check_count + 1, …;
-- only when this check is the one that completed it:
INSERT INTO lab_progress … ON CONFLICT (student_id, lab_id) DO UPDATE …;
```

The lock is why two Check Solution requests racing on one attempt cannot both
observe `completed_at IS NULL` and record two completions. A repeated PASS
increments `check_count` — three checks really did happen — and changes nothing
else; the API returns `newlyCompleted: false` and the UI stays quiet.

A check that could not *run* (the cluster was unreachable, `503`) is not
recorded at all. An outage is not something the student did.

### How progress is calculated

The database stores completions. The **catalog** supplies the denominators, and
the API joins them per request:

```text
  lab_progress rows  ×  registry.tracks()  →  "Kubernetes 1/10 completed"
  (what you did)        (what exists now)
```

Nothing stores a total. Adding K8S-011 moves every student's denominator to
`1/11` with no migration and no backfill, and a lab removed from the catalog
stops being counted rather than leaving a completion floating against nothing.

Per-lab status is derived, not stored as a third value: a lab with no row is
`NOT_STARTED`, a row is `IN_PROGRESS` or `COMPLETED`. Practising a completed lab
again keeps it `COMPLETED` and increments `attempt_count` — a second pass is
practice, not new progress, so `completed` stays at `1/10` while
`completionCount` becomes 2.

### Hint tracking

Revealing a hint posts to `POST /api/sessions/:sessionId/hints` with a level.
The attempt is resolved from the session server-side; the browser never names an
attempt or a student.

Idempotence is a schema constraint, not a convention: `UNIQUE (attempt_id,
hint_index)`. A frontend that replays the request — a double click, a retry, two
tabs — conflicts instead of writing, and the response says which happened:

```jsonc
{ "recorded": true,  "revealedCount": 1, "hint": { "level": 1, "revealedAt": "…" } }
{ "recorded": false, "revealedCount": 1, "hint": { "level": 1, "revealedAt": "…" } }
```

`HintPanel` did not change to make this work. PLATFORM-003 left an `onReveal`
callback as "the seam a later story writes to a database through"; the lab page
forwards it to the API, and the component still owns only what is on screen.

Hints are recorded against an attempt, so a hint revealed before a lab is
started is not recorded — there is nothing to record it against, and inventing a
row would be worse than the gap.

### Development student identity

> **This is not authentication.** Nobody proves who they are.

There is no login yet, and history needs an owner, so every request is
attributed to a configured development student (`dev-student-001` by default).
Stated plainly:

- **Anyone who can reach the API is that student.** There is no password, no
  token, no session cookie, and no check of any kind.
- `DEV_STUDENT_HEADER_ENABLED=true` additionally lets an `x-dev-student-id`
  header select a *different* student. That exists so two browser tabs can act
  as two students on a laptop — and it means anyone can read anyone's progress.
  It is **off by default in code**, off in the compose stack, and must stay off
  anywhere holding real learner data.
- The API never hides this. Every `me` response carries
  `"authenticated": false` and an identity source, and the dashboard prints
  *"development identity — no sign-in yet"* rather than implying an account.

What is already true, and stays true when real authentication arrives:

- **No student id is ever taken from a query parameter or a request body.** The
  identity comes from a resolver, from a validated source, in one file
  (`apps/api/src/identity.ts` → `@jumptotech/progress`'s `DevStudentIdentity`).
  A test posts `{"studentId": "dev-student-999"}` to Start Lab every way a
  client could and asserts the attempt still belongs to the caller.
- **Reads are scoped to the owner in the query**, not by a check a caller might
  forget: `getAttempt(studentId, attemptId)`. Knowing another student's attempt
  id returns `404` — the same answer as a nonexistent one, so an id cannot be
  used to discover whose it is.
- **Session possession still authorises sandboxes**, exactly as PLATFORM-002
  described. A student id grants no access to any environment.
- Replacing this with a verified session cookie or a JWT subject is a change to
  one class. No repository, service, or route signature moves.

### When the database is unavailable

Bookkeeping must never take the classroom with it.

| Path | Behaviour |
|---|---|
| Start / Check / Reset / End / hint | **Succeeds.** The failure is logged; the response simply carries no `attempt`, and the student keeps working. |
| `GET /api/me/*` | **`503 PROGRESS_UNAVAILABLE`.** A read cannot be faked — an empty dashboard is indistinguishable from "you have done nothing". |
| Catalog | **Renders.** Progress badges are fetched separately and their absence costs badges, not the page. |
| `/health` | Reports `progress: { store, ok, durable }`. |

A *configured but unreachable* database is a startup failure, deliberately:
falling back to memory and telling students their progress is saved when it is
not would be worse than not starting. An *unconfigured* database is not a
failure — it is the documented laptop setup, and the API says so at startup, on
`/health`, and on the dashboard (`durable: false` → *"not saved to a
database"*).

### Running PostgreSQL locally

`docker compose up` starts it alongside the rest of the stack:

```bash
make setup          # generates POSTGRES_PASSWORD into .env
docker compose up   # postgres → healthy → api (migrations run at startup)
```

```bash
make db-up          # postgres only
make db-migrate     # apply pending migrations
make db-status      # applied / pending
make db-shell       # psql inside the container
```

- Only the `api` service holds a database credential. The web and terminal
  services have none, and PostgreSQL is not on the `kind` network, so no
  student sandbox can reach it.
- Data lives in the named volume `jumptotech-labs-postgres-data`.
  `docker compose down` keeps it; `docker compose down -v` and `make clean`
  delete it, and `make clean` says so before it does.
- There is **no default password anywhere in source**. `POSTGRES_PASSWORD` is
  required, and compose fails with that message if it is missing.

Running the services on your host instead (needed for the Linux and Terraform
tracks) means pointing `DATABASE_URL` at the published port:

```bash
make db-up
DATABASE_URL=postgresql://jumptotech:<password>@localhost:5432/jumptotech_labs \
  npm run dev:api
```

---

## Multi-student architecture

One shared cluster. One namespace per active session. Nothing else per student.

```text
                     SHARED KUBERNETES CLUSTER
                               │
              ┌────────────────┼────────────────┐
              │                │                │
          Session A        Session B        Session C
        sess-a84fc21…    sess-f192bd4…    sess-3c9e017…
              │                │                │
        Namespace A       Namespace B      Namespace C
       lab-3f9c1a7b…     lab-8a02fd95…    lab-c41b7e2d…
              │                │                │
      ServiceAccount    ServiceAccount   ServiceAccount
         "student"         "student"        "student"
              │                │                │
        Role + Binding   Role + Binding   Role + Binding
       (namespaced only) (namespaced only)(namespaced only)
              │                │                │
        ResourceQuota    ResourceQuota    ResourceQuota
        LimitRange       LimitRange       LimitRange
        NetworkPolicy    NetworkPolicy    NetworkPolicy
```

### Session ids and namespace names

A session id is 64 bits of `crypto.randomBytes`, rendered `sess-<hex>`. It is
never a counter and never derived from time.

The namespace is derived from it through a keyed HMAC:

```text
   sess-a84fc21ab3d90e12  ──HMAC-SHA256(NAMESPACE_DERIVATION_SECRET)──►  lab-3f9c1a7b2d40
```

That direction is cheap; the reverse is not. Namespace names show up in shell
prompts, logs and screenshots, so this means leaking one does not leak the
session capability that controls the session. Namespaces are also validated as
RFC 1123 labels and rejected outright if they collide with `default`,
`kube-system`, `kube-public`, `kube-node-lease`, or anything in the `kube-*`
reserved space.

### What the student may do

The Role is namespaced and grants only what beginner Kubernetes labs need:

| API group | Resources | Verbs |
|---|---|---|
| core | `pods`, `pods/log`, `pods/exec`, `pods/attach`, `pods/portforward`, `pods/status`, `services`, `configmaps`, `secrets`, `serviceaccounts`, `events`, `endpoints`, `persistentvolumeclaims`, `replicationcontrollers` | get, list, watch, create, update, patch, delete |
| core | `resourcequotas`, `limitranges` | get, list, watch |
| apps | `deployments` (+`/scale`, `/status`), `replicasets` (+`/scale`), `statefulsets` (+`/scale`), `daemonsets`, `controllerrevisions` | get, list, watch, create, update, patch, delete |
| batch | `jobs`, `cronjobs` | get, list, watch, create, update, patch, delete |
| autoscaling | `horizontalpodautoscalers` | get, list, watch, create, update, patch, delete |
| networking.k8s.io | `ingresses` | get, list, watch, create, update, patch, delete |
| networking.k8s.io | `networkpolicies` | get, list, watch |
| discovery.k8s.io | `endpointslices` | get, list, watch |
| metrics.k8s.io | `pods` | get, list, watch |
| events.k8s.io | `events` | get, list, watch |

Two deliberate read-only carve-outs: the quota/limit objects and the network
policies are *visible but not editable*, so a student can see their budget and
their isolation but cannot raise or remove either.

### What the student may not do

**No cluster-scoped object is created per session.** There is no ClusterRole
and no ClusterRoleBinding anywhere in the session path, so the student identity
has no cluster scope to reach. All of the following return `Forbidden`:

```text
kubectl get pods -n <another session's namespace>   Forbidden
kubectl get pods -n kube-system                     Forbidden
kubectl get secrets -n kube-system                  Forbidden
kubectl get nodes                                   Forbidden
kubectl get namespaces                              Forbidden
kubectl get persistentvolumes                       Forbidden
kubectl create namespace anything                   Forbidden
kubectl delete namespace <anything>                 Forbidden
kubectl label node <node> …                         Forbidden
kubectl create clusterrole|clusterrolebinding …     Forbidden
kubectl create rolebinding --clusterrole=…          Forbidden
kubectl delete role jumptotech-student              Forbidden
kubectl patch resourcequota … (raise own quota)     Forbidden
kubectl delete networkpolicy … (remove own fence)   Forbidden
```

Each line above is an assertion in
[`test/integration.test.ts`](services/lab-orchestrator/test/integration.test.ts),
executed with real student credentials against a real API server. None of them
is mocked — a mock returning "Forbidden" would prove nothing.

### `kubectl get nodes` is deliberately Forbidden

PLATFORM-001's README used `kubectl get nodes` to demonstrate that the cluster
was real. K8S-001 does not require it, so PLATFORM-002 does not grant it: doing
so would mean binding every student to a cluster-scoped role for the sake of a
demo command. The equivalent proof is now `kubectl get pods` in your own
namespace showing a Pod you created, or watching a host-side `kubectl` change
appear in the browser terminal.

If a future lab genuinely teaches node inspection, the smallest safe change is
a shared read-only ClusterRole covering `nodes` only, bound per session and
deleted with the session — not a broadening of the namespace Role.

### Student credentials

```text
POST /api/labs/K8S-001/start
        │
        ├─► session + namespace + guardrails
        └─► HMAC token  { sid, labId, namespace, exp }   ──► browser
                                                              │
                                              WebSocket auth frame
                                                              │
                                                    services/terminal
                                                              │
                            POST /internal/sessions/:sid/credentials
                                        (x-internal-secret)
                                                              │
                                    Kubernetes TokenRequest API
                                    → bound ServiceAccount token
                                                              │
                              kubeconfig: 1 cluster, 1 user, 1 context
                              context.namespace = lab-3f9c1a7b2d40
                                       written 0600, deleted on disconnect
```

The kubeconfig contains a short-lived bound ServiceAccount token — no client
certificate, no long-lived secret, and nothing belonging to the platform. Its
lifetime is the smaller of `STUDENT_CREDENTIAL_TTL_SECONDS` and the session's
own remaining time (floored at 10 minutes, which the Kubernetes TokenRequest
API enforces). Because the context sets the namespace, `kubectl get pods` is
already scoped correctly and the student never types `-n lab-…`.

It never reaches the browser. `/internal` is not under `/api`, is excluded from
CORS, and requires `INTERNAL_SERVICE_SECRET`.

### Network model

Each namespace gets four NetworkPolicies:

| Policy | Effect |
|---|---|
| `…-default-deny` | deny all ingress and egress |
| `…-allow-same-namespace` | re-allow traffic between this session's own Pods |
| `…-allow-dns` | re-allow egress to `kube-system` on TCP/UDP 53 |
| `…-allow-external-egress` | re-allow egress to `0.0.0.0/0` *except* the cluster Pod and Service CIDRs |

So a student's Pods can talk to each other, resolve DNS, and reach the
internet, but cannot open connections into another student's namespace. Image
pulls are unaffected — the kubelet performs those, not the Pod.

> **This is not tenant isolation.** NetworkPolicy is enforced by the CNI, and
> enforcement varies: a cluster whose CNI does not implement NetworkPolicy will
> accept these objects and ignore them. Verify enforcement on your own cluster
> before treating it as a control, and see
> [Security](#security) for what namespace isolation does and does not buy you.
> `NETWORK_POLICY_ENABLED=false` skips creating them where they would be
> decorative.

---

## Session lifecycle

```text
                       ┌──────────┐
      Start Lab ──────►│ CREATING │
                       └────┬─────┘
                            │ namespace + guardrails ready
                            ▼
   Reset Lab ┌─────────►┌────────┐◄──────────┐ Continue Lab
             └──────────│ ACTIVE │───────────┘ (activity)
                ┌───────└───┬────┘───────┐
     RESETTING ◄┘           │            └► (idle warning at WARNING_MINUTES)
                            │
        End Lab ────────────┼──────────── idle / absolute expiry
             │              │                        │
             ▼              │                        ▼
        ┌─────────┐         │                  ┌──────────┐
        │ ENDING  │         │                  │ EXPIRING │
        └────┬────┘         │                  └─────┬────┘
             │  terminate terminal → delete ns → verify gone
             ▼              │                        ▼
        ┌─────────┐         │                  ┌──────────┐
        │  ENDED  │         │                  │ EXPIRED  │
        └─────────┘         ▼                  └──────────┘
                       ┌────────┐
                       │ FAILED │  provisioning failed; namespace torn down
                       └────────┘
```

There is deliberately no `active: true` boolean anywhere. The UI has to tell
"still provisioning" from "being torn down" from "gone", and a boolean cannot.

### Two clocks

| | Absolute deadline | Idle deadline |
|---|---|---|
| Set from | `MAX_SESSION_MINUTES` | `IDLE_TIMEOUT_MINUTES` |
| Anchored to | `created_at` | `last_activity_at` |
| Moved by activity | **never** | yes |
| Student-visible | countdown in the top bar | "Continue Lab" warning banner |

`Continue Lab` records activity, which moves the idle deadline only. A student
who clicks it every minute still loses the environment at the absolute
deadline — that is the point of having two clocks.

### What counts as activity

Terminal input, `Check Solution`, `Reset Lab`, and `Continue Lab`. Status
polling deliberately does **not**: if it did, a browser tab left open on a
sleeping laptop would keep a sandbox alive forever.

---

## Cost model

JumpToTech does **not** create a cluster per student, a VM per student, or an
account per student. It creates the smallest disposable thing that teaches the
lab: a namespace, or a container.

| Per student, per lab | Kubernetes | Linux / Terraform |
|---|---|---|
| Cluster | none — shared | n/a |
| Node / VM | none | **none** — a container, not a VM |
| LoadBalancer or public IP | none — pinned to `0` in the quota | none — `--network none` |
| Database | none | none |
| What is actually created | ~9 small API objects | 1 container, bounded at 0.5 CPU / 512 MB / 128 PIDs |
| Image pulls | shared node cache | one image, built once, shared by every session |

Browsing the catalog creates nothing at all: no provider method runs until a
student clicks **Start Lab**. Provider *readiness* is a cheap local probe
(`docker version`, an API ping) memoised for 30 seconds, so a busy catalog does
not turn into a busy daemon.

Four things bound the spend, and they are the same four for every provider: a
**per-session resource bound** (ResourceQuota / LimitRange, or `--cpus`,
`--memory`, `--pids-limit`), **`MAX_ACTIVE_SESSIONS`**, the **session TTL**, and
the **cleanup service** that guarantees an abandoned environment is reclaimed
rather than paid for indefinitely.

Explicitly rejected, and rejected the same way at every layer:

| Rejected | Why | What is done instead |
|---|---|---|
| one VM per Linux lab | a VM costs orders of magnitude more than a container and teaches `chmod` no better | one container per session |
| one cluster per Kubernetes student | multiplies control-plane cost by the number of students for no pedagogical gain | one namespace per session |
| one AWS account per session | account provisioning is slow, expensive, and hard to reclaim | scoped role + tags + budget guard, when AWS arrives |
| long-lived cloud resources | anything outliving a session is paid for by nobody's lesson | session TTL, plus the reaper |
| manual cleanup | students never do it, and operators should not have to | the reaper, across every provider |

This is the same shape that will run on shared EKS later: the
[`LabProvider`](services/lab-orchestrator/src/types.ts) interface is what lets
an `EksLabProvider` slot in underneath without the API, the verifier, or the
frontend changing.

---

## Local development requirements

| Track | Needs | How to get it |
|---|---|---|
| Kubernetes | a kind cluster | `npm run cluster:up` |
| Linux | Docker + `jumptotech/lab-linux` | `npm run sandbox:build` |
| Terraform | Docker + `jumptotech/lab-terraform` | `npm run sandbox:build` |
| Docker | — | not enabled; see [Docker sandbox strategy](#docker-sandbox-strategy) |
| AWS | — | not enabled; see [Future AWS provider architecture](#future-aws-provider-architecture) |

Missing either substrate is not fatal: the catalog still loads, and the tracks
that cannot run say so with the real reason.

> **The container tracks run in compose, through the runtime broker.**
>
> The Linux, Networking, CS, AWS, Terraform, Ansible and CI/CD providers drive a
> container runtime, and a shell has to be attached to what they create. Both
> now go through `sandboxd`, which is the only service given a runtime — so
> `make up` runs those tracks and neither the `api` nor the `terminal` container
> holds a Docker socket. See
> [docs/runtime-architecture.md](docs/runtime-architecture.md).
>
> Running the services on your host still works and is what a laptop wants:
>
> To use them, run the services on your host, where they inherit your own
> Docker context:
>
> ```bash
> npm run cluster:up          # for the Kubernetes track
> npm run sandbox:build       # for the Linux and Terraform tracks
>
> export KUBECONFIG="$PWD/infrastructure/kind/generated/kubeconfig-host.yaml"
> export TERMINAL_SESSION_SECRET="$(openssl rand -hex 32)"
>
> npm run dev:api             # :4000
> npm run dev:terminal        # :4001  (needs Node 22 for node-pty)
> npm run dev:web             # :3000
> ```
>
> **This is a development arrangement, and it is honestly a compromise.** It
> means the orchestrator and the terminal service can reach the host's Docker
> daemon, which is a capability neither would hold in production. The production
> shape is a dedicated sandbox-broker service holding a rootless, per-tenant
> daemon, with the API talking to it over an authenticated API rather than to a
> socket. See [Security](#security) for what this does and does not buy you.

---

## Requirements

| Tool | Version tested | Why |
|---|---|---|
| Docker | 28.4 (Docker Desktop) | runs the services, the kind node, **and the Linux/Terraform sandboxes** |
| Docker Compose | v2.39 | orchestrates the local stack |
| [kind](https://kind.sigs.k8s.io/) | 0.31.0 | creates the local Kubernetes cluster |
| kubectl | 1.34 | host-side cluster checks |
| Node.js | 22 LTS or 24 | running tests / services outside Docker |
| Bash | 3.2+ | the `scripts/` helpers |
| Terraform | 1.9.8 | **inside the sandbox image only** — you do not install it |
| PostgreSQL | 16 (`postgres:16-alpine`) | **inside the compose stack only** — student progress; you do not install it |

Docker must be running with at least ~4 GB of memory available.

macOS install:

```bash
brew install kind kubectl node
```

Linux install: follow the official
[kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation) and
[kubectl](https://kubernetes.io/docs/tasks/tools/) instructions.

> **Node version note.** The container images pin Node 22 LTS. `node-pty` is a
> native addon and does not build against every Node release; if you run the
> terminal service directly on your host, use Node 22.

---

## Installation

```bash
git clone <repository-url>
cd jumptotech-labs

cp .env.example .env
```

Generate a real session secret (the example value is a placeholder and the
services refuse to start with a short one):

```bash
# macOS / Linux
sed -i.bak "s|^TERMINAL_SESSION_SECRET=.*|TERMINAL_SESSION_SECRET=$(openssl rand -hex 32)|" .env && rm -f .env.bak
```

---

## Running locally

Two commands for the Kubernetes track, plus two more if you want the Linux
track as well.

**1. Create the Kubernetes substrate** (once; takes 1–3 minutes the first time):

```bash
npm run cluster:up
```

This creates the `jumptotech-labs` kind cluster from
[`infrastructure/kind/cluster.yaml`](infrastructure/kind/cluster.yaml) and writes
two kubeconfigs into `infrastructure/kind/generated/`:

- `kubeconfig-host.yaml` — for you, pointing at `127.0.0.1:16443`
- `kubeconfig-internal.yaml` — for the containers, pointing at
  `jumptotech-labs-control-plane:6443` on the shared `kind` Docker network

**2. Build the sandbox images** (once; needed only for the Linux and Terraform
tracks):

```bash
npm run sandbox:build
```

This builds `jumptotech/lab-linux` and `jumptotech/lab-terraform` on your host.
Skipping it is fine — the Kubernetes track still works, and the other two are
marked unavailable in the catalog with a link to this command.

**3. Start the application:**

```bash
docker compose up --build
```

> **Rebuild after platform source changes.** The API, terminal, and web
> services are baked into Docker images at build time — there is no bind-mount
> of application source into the `api` container. After pulling or editing
> platform code (`apps/api`, `services/*`), rebuild before manual testing:
>
> ```bash
> make rebuild
> # or: docker compose up --build -d
> npm run verify:api-image   # optional: confirm the running API matches source
> ```
>
> Unit tests on the host exercise fresh source; a stale running container does
> not.

The stack now includes PostgreSQL, which holds student progress. It needs
`POSTGRES_PASSWORD` in `.env` — `make setup` generates one, and compose fails
with that message rather than starting with a default password. The `api` waits
for the database to report healthy and applies any pending migrations at
startup:

```text
[progress] progress database postgres:5432/jumptotech_labs
[progress] applied 1 migration(s)
[api] progress store=postgres durable=true student=dev-student-001 (development identity — not authentication)
```

`docker compose down` keeps the data; `docker compose down -v` deletes it. See
[Running PostgreSQL locally](#running-postgresql-locally).

> The compose stack serves the **Kubernetes track**. The Linux and Terraform
> tracks need the services running on your host, because no container in the
> stack is given access to a container runtime. See
> [Local development requirements](#local-development-requirements).

Then open:

### **http://localhost:3000**

| Service | URL | Purpose |
|---|---|---|
| web | http://localhost:3000 | the UI |
| api | http://localhost:4000/health | REST API |
| terminal | http://localhost:4001/health | WebSocket terminal gateway |
| sandboxd | http://127.0.0.1:4002/health | the runtime broker — the only process with a container runtime (`npm run dev:sandboxd`, or the `sandboxd` compose service) |

Check everything at once:

```bash
npm run cluster:status
```

A `Makefile` wraps the common commands — `make help` lists them, and
`make setup && make up` is equivalent to the two steps above.

### Running without Docker

```bash
npm install
npm run cluster:up

export KUBECONFIG="$PWD/infrastructure/kind/generated/kubeconfig-host.yaml"
export TERMINAL_SESSION_SECRET="$(openssl rand -hex 32)"

# Optional: persistent progress. Without DATABASE_URL the API runs on the
# in-memory store and says so at startup, on /health, and on the dashboard.
make db-up
export DATABASE_URL="postgresql://jumptotech:<password>@localhost:5432/jumptotech_labs"

npm run dev:api        # :4000
npm run dev:terminal   # :4001  (needs Node 22 for node-pty)
npm run dev:web        # :3000
npm run dev:sandboxd   # :4002  (the runtime broker; the only process needing the Docker socket)
```

### Shutting down

```bash
docker compose down          # stop the services, keep student progress
docker compose down -v       # …and delete the progress volume too
npm run cluster:down         # delete the kind cluster
```

Stop the broker with Ctrl-C. Any sandboxes still running are labelled with their
expiry and are collected by the reaper on the next start; to clear them by hand:

```bash
docker rm -f $(docker ps -aq --filter label=jumptotech.io/managed=true)
docker network prune -f --filter label=jumptotech.io/managed=true
```

---

## Starting K8S-001

1. Open http://localhost:3000
2. Under the **kubernetes** track, click **K8S-001 — Create Your First Pod**
3. Click **Start Lab**

You should see:

```text
Preparing Kubernetes environment...

✓ Environment created
✓ Kubernetes API available
✓ kubectl ready
✓ Terminal connected

Lab Ready
```

Each line reflects a check that actually ran. If any of them fails, the UI shows
the real error — the error code, the underlying message, and a remediation hint
— instead of claiming the lab is ready. For example, stopping the cluster and
clicking Start Lab produces `ENVIRONMENT_UNREACHABLE` with the genuine
`connect ECONNREFUSED …:6443` from the Kubernetes client.

The lab page then shows your session's live state:

```text
K8S-001
Create Your First Pod

Status: ACTIVE            Time Remaining: 42:18
Environment: Ready        namespace: lab-3f9c1a7b2d40

[Reset Lab]  [End Lab]                  [Check Solution]
```

`Status` is the explicit lifecycle state, and `Time Remaining` counts down to
the session's server-side absolute deadline — closing the tab does not stop it.
The namespace is shown as a developer detail; it is not something a student
needs, and possessing it grants nothing.

---

## Starting LINUX-001 and TF-001

The same three clicks, on a different kind of environment.

1. Open http://localhost:3000
2. Under **Linux**, click **LINUX-001 — Files, Directories & Permissions**
3. Click **Start Lab**

```text
Preparing Linux environment…

✓ Environment created      sandbox container jtt-lab-3f9c1a7b2d40 created
                           (cpus=0.5 memory=512m pids=128 network=none)
✓ Sandbox tooling ready    unprivileged user 'student'
✓ Terminal connected

Lab Ready
```

The terminal pane header reads `container: jtt-lab-3f9c1a7b2d40` instead of
`namespace: lab-…`, and that is the whole visible difference. Everything else —
the brief, the hints, the timer, Check Solution, Reset Lab, End Lab — is the
same page and the same API calls.

Solve it the way you would on a real host:

```bash
student@lab:~$ mkdir -p deploy/releases
student@lab:~$ printf 'service=ledger-api\nversion=4.2.0\n' > deploy/release.txt
student@lab:~$ chgrp deployers deploy
student@lab:~$ chmod 750 deploy
student@lab:~$ chmod 640 deploy/release.txt
student@lab:~$ stat -c '%F %a %U %G' deploy deploy/release.txt
directory 750 student deployers
regular file 640 student student
```

**Check Solution** reads that filesystem back — not your shell history:

```text
✓ Directory deploy exists
✓ Directory deploy/releases exists
✓ File deploy/release.txt exists
✓ deploy/release.txt records the service and version
✓ deploy is owned by your account
✓ deploy belongs to the deployers group
✓ deploy permissions are rwxr-x---
✓ deploy/release.txt permissions are rw-r-----

LAB PASSED
```

TF-001 works identically, on a sandbox that also has the Terraform CLI:

```bash
student@lab:~$ ls terraform
versions.tf
student@lab:~$ cd terraform
student@lab:~/terraform$ terraform init      # resolves offline, no credentials
student@lab:~/terraform$ terraform plan
student@lab:~/terraform$ terraform apply -auto-approve
student@lab:~/terraform$ terraform output
manifest_path = "build/manifest.txt"
```

**Reset Lab** on either track replaces the sandbox and reattaches your terminal;
your files are gone and the lab's starter state is back. **End Lab** removes the
container. Confirm it from the host:

```bash
docker ps --filter label=jumptotech.io/managed=true
```

---

## Testing the terminal

Click into the terminal pane and run real commands. Your shell already points at
your own lab namespace, so no `-n` flag is needed:

```bash
kubectl get pods
kubectl run nginx --image=nginx:stable
kubectl describe pod nginx
kubectl delete pod nginx
```

Confirm which identity you are:

```bash
kubectl auth whoami
```

```text
ATTRIBUTE   VALUE
Username    system:serviceaccount:lab-3f9c1a7b2d40:student
Groups      [system:serviceaccounts system:serviceaccounts:lab-3f9c1a7b2d40 system:authenticated]
```

That is the whole point of PLATFORM-002: a student shell is a namespaced
ServiceAccount, not `kubernetes-admin`. Confirm the fence:

```bash
kubectl get pods -n kube-system     # Error … Forbidden
kubectl get nodes                   # Error … Forbidden
kubectl auth can-i '*' '*' --all-namespaces   # no
```

To prove the cluster is not simulated, create something from the host, into your
namespace, and watch it appear in the browser terminal. The namespace is shown
in the terminal pane header:

```bash
KUBECONFIG=infrastructure/kind/generated/kubeconfig-host.yaml \
  kubectl run proof --image=nginx:stable -n lab-3f9c1a7b2d40
```

Then run `kubectl get pods` in the browser — `proof` is there.

### Proving isolation with two browsers

Open the lab in two different browser windows and click **Start Lab** in each.
Each gets its own namespace (visible in the terminal pane header).

In window A:

```bash
kubectl run nginx --image=nginx:stable
kubectl get pods            # nginx is here
```

In window B:

```bash
kubectl get pods            # empty — A's Pod is invisible
kubectl get pods -n <A's namespace>
# Error from server (Forbidden): pods is forbidden: User
# "system:serviceaccount:lab-…:student" cannot list resource "pods"
# in API group "" in the namespace "lab-…"
```

Then click **Check Solution** in both: A passes, B does not.

---

## Testing the verifier

**Passing run.** In the browser terminal:

```bash
kubectl run nginx --image=nginx:stable
kubectl get pod nginx -w        # wait for Running, then Ctrl-C
```

Click **Check Solution**:

```text
Checking your environment...

✓ Pod nginx exists
✓ Image nginx:stable is correct
✓ Pod is Running
✓ Container is Ready

LAB PASSED
```

**Failing run.** Break it deliberately:

```bash
kubectl delete pod nginx
kubectl run nginx --image=nginx:1.25    # wrong image
```

Click **Check Solution**:

```text
Checking your environment...

✓ Pod nginx exists
✗ Incorrect image — found 'nginx:1.25', expected 'nginx:stable'
✓ Pod is Running
✓ Container is Ready

LAB NOT COMPLETE
```

Or delete the Pod entirely and every check fails with
`No Pod named 'nginx' found in namespace 'lab-…'`.

The verifier reads the Kubernetes API directly, in *your session's namespace
only*. It does not look at your shell history, so there is no way to "type the
right command" past a broken environment — and equally, any method that
produces the correct state passes. Another student's correct Pod cannot make
your lab pass, because the verifier never reads their namespace.

---

## Resetting the lab

Click **Reset Lab**. It:

1. Deletes the resources you created in *your* lab namespace
   (Pods, Deployments, ReplicaSets, StatefulSets, DaemonSets, Jobs, CronJobs,
   Services, ConfigMaps, Secrets), skipping the cluster-managed `kubernetes`
   Service and `kube-root-ca.crt` ConfigMap
2. Waits for Pods to finish terminating
3. Re-applies the lab's initial state, for labs that declare one
4. Re-checks cluster health
5. Clears the terminal scrollback
6. Reports `Lab reset successfully.` plus exactly what was removed

Reset **keeps** your session, your namespace, your terminal, and your
guardrails. It does not extend your deadline. It affects nothing outside your
namespace — resetting your lab cannot touch another student's work.

The platform's own objects (quota, LimitRange, RBAC, network policies) are
protected unconditionally in code, so a reset can never leave a session running
without its isolation.

---

## Ending a lab

Click **End Lab**. This is different from Reset:

| | Reset Lab | End Lab |
|---|---|---|
| Your resources | removed | removed |
| Namespace | kept | **deleted** |
| Session | stays `ACTIVE` | becomes `ENDED` |
| Terminal | stays connected | closed |
| Capacity slot | still held | released |
| Reversible | yes — carry on working | no |

It asks first:

```text
End this lab?

Your temporary lab environment will be deleted.
This action cannot be undone.

[Cancel] [End Lab]
```

Ending a lab closes your terminal, deletes your namespace, waits until the
namespace is verifiably gone, and only then marks the session `ENDED`. Other
sessions are untouched.

---

## Automatic cleanup

**Students are never responsible for cleanup.** A background service sweeps
every `CLEANUP_INTERVAL_SECONDS` (default 60) and reclaims three kinds of
sandbox:

| Reason | Condition |
|---|---|
| `expired` | `now > expires_at` — the absolute deadline |
| `idle` | `now - last_activity_at > IDLE_TIMEOUT_MINUTES` |
| `orphaned` | the cluster has a managed sandbox the session store has no record of, and its `expires-at` label is past |

Each one goes through the same path as a student-initiated End Lab:

```text
mark EXPIRING → terminate terminal → delete namespace → verify gone → mark EXPIRED
```

The orphan rule is what makes an API restart survivable. Session state is in
memory today, so a restart loses it — but the sandbox *labels* survive, and each
one carries its own `jumptotech.io/expires-at`. The reaper reads expiry from the
substrate and reclaims accordingly. A one-minute grace period stops it
reclaiming a sandbox that is still being provisioned.

One reaper covers every track. It asks each registered provider for every managed
sandbox, which is a union across substrates, and routes each delete back by the
handle's prefix — `lab-` to Kubernetes, `jtt-lab-` to the container providers. A handle matching
no configured prefix is refused rather than guessed at, which is precisely why
the two prefixes must differ. A substrate that cannot be reached contributes
nothing to the sweep instead of hiding the other's sandboxes.

### Cleanup safety

Deleting a namespace is the only irreversible thing this platform does, so four
gates stand in front of every delete, re-read from the API server each time:

1. the name must parse as a `lab-…` sandbox name;
2. it must not be a protected cluster namespace;
3. the live object must carry `jumptotech.io/managed=true`;
4. when a session id is supplied, the namespace's session label must match it.

The Linux side applies the same rule with the same labels, enforced inside the
broker against the live container immediately before the delete: the name must
carry `jtt-lab-`, the container must be `jumptotech.io/managed=true`, and a
supplied session id must match its label. A sandbox that is already gone counts
as removed, which is what makes repeat sweeps harmless.

```yaml
metadata:
  labels:
    jumptotech.io/managed: "true"
    jumptotech.io/session-id: "sess-a84fc21ab3d90e12"
    jumptotech.io/lab-id: "K8S-001"
    jumptotech.io/expires-at: "1786000000000"
```

`default`, `kube-system`, `kube-public`, `kube-node-lease`, and anything else
outside the `lab-` prefix cannot be reached from this path — not by a bug, not
by a stale record, and not by an operator hand-labelling a system namespace,
because gate 1 would still refuse it. A managed namespace with no expiry label
is left alone for a human rather than guessed at.

Cleanup is idempotent: a session already in a terminal state short-circuits, a
namespace already gone counts as deleted, and running two sweeps back to back
produces the same result as one.

### Capacity

`MAX_ACTIVE_SESSIONS` (default 20) caps concurrent sessions. Past the limit,
`POST /api/labs/:id/start` returns `503 LAB_CAPACITY_REACHED` and **creates no
namespace**. The frontend shows:

```text
All practice environments are currently in use.
Please try again shortly.
```

The check and the reservation happen synchronously before the first `await`, so
simultaneous Start Lab requests cannot both slip past the limit. There is no
queue — that is a later story.

---

## Lab definitions

Lab content lives in YAML, never in React:

```text
labs/kubernetes/k8s-001-pods/lab.yaml
```

The API parses and validates it at startup
([`lab-definition.ts`](services/lab-orchestrator/src/lab-definition.ts)) and
serves it to the frontend. The task text, requirements, hints, references, and
reset policy all come from that file. The student-facing checklist and the
verifier read the *same* `requirements` array, so the UI and the checks cannot
drift apart — changing the image from `nginx:stable` to something else is a
one-line edit that updates both.

A lab definition deliberately **cannot name a namespace**. The schema has no
such field, and setup manifests that set `metadata.namespace` are rejected: the
namespace belongs to the session, and lab content that could name one could
reach another student's sandbox.

The full schema, the setup engine, the verification vocabulary, and the hint
model are documented in [The lab catalog](#the-lab-catalog).

The Kubernetes content is written from the official documentation only — see
the `references` block of each `lab.yaml`. No content is taken from
third-party training platforms, and the loader rejects a definition that links
to one.

---

## Adding a lab

### How to add K8S-011 without changing application code

This is the whole process. No TypeScript is edited, no component is added, no
route is registered, and no verifier handler is written.

**1. Create the directory and the definition.**

```bash
mkdir -p labs/kubernetes/k8s-011-rollouts/setup
```

`labs/kubernetes/k8s-011-rollouts/lab.yaml`:

```yaml
id: K8S-011
slug: k8s-011-rollouts            # must equal the directory name
title: Roll Back a Bad Release
track: kubernetes
topic: workloads
difficulty: intermediate
duration_minutes: 30
order: 11

environment:
  provider: kubernetes
  isolation: namespace

prerequisites: [K8S-002]

story: >
  A release of the JumpToTech Bank card service went out an hour ago and the
  error rate has not come back down. The previous version was healthy.

objectives:
  - Inspect the rollout history of a Deployment
  - Return a Deployment to a known-good revision

task:
  summary: Return the cards Deployment to the working image.
  description: >
    The cards Deployment is running a release that does not start. Restore it
    to the image that worked, and confirm both replicas are available again.

setup:
  manifests: [setup/cards.yaml]
  verify:
    - type: deployment_exists
      name: cards

requirements:
  - type: deployment_image
    name: cards
    image: nginx:stable
    label: Deployment runs the known-good image
  - type: deployment_available
    name: cards
    min_available: 2
    label: Both replicas are available

hints:
  - level: 1
    text: A Deployment keeps a history of the revisions it has rolled out.
  - level: 2
    text: Compare the current revision with the one before it.
  - level: 3
    text: >
      `kubectl rollout history deployment/cards` lists the revisions, and
      `kubectl describe deployment cards` shows why the current Pods are not
      starting.

references:
  - title: Deployments
    url: https://kubernetes.io/docs/concepts/workloads/controllers/deployment/

skills:
  - kubernetes.deployments.rollout
  - kubernetes.troubleshooting.pods

certification:
  - certification: CKA
    relevant: true
    domains: [workloads-and-scheduling]
```

**2. Add the starting state**, `setup/cards.yaml` — ordinary Kubernetes YAML,
with no `metadata.namespace`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cards
  labels: { app: cards }
spec:
  replicas: 2
  selector:
    matchLabels: { app: cards }
  template:
    metadata:
      labels: { app: cards }
    spec:
      containers:
        - name: cards
          image: nginx:does-not-exist     # the bad release
```

**3. Restart the API.**

```bash
docker compose restart api
curl -s localhost:4000/health | jq '.data | {labsLoaded, labLoadErrors}'
```

`labsLoaded` becomes 11 and `labLoadErrors` stays empty. If the definition is
invalid, the lab is skipped and the reason appears in `labLoadErrors`, naming
the exact field that failed.

That is all. K8S-011 now:

- appears on the catalog page, under Kubernetes, with its difficulty, duration,
  skills, prerequisites and CKA badge;
- renders on the same generic lab page, with its scenario, objectives, task,
  requirements, documentation links and three-step hint ladder;
- provisions its own isolated namespace with the full PLATFORM-002 guardrail set;
- seeds its broken Deployment into that namespace only;
- is graded by the shared verifier against live cluster state;
- restores its broken starting state on Reset;
- is torn down by End Lab and by the reaper.

**What would require code:** only a genuinely new *kind of check*. Adding, say,
`deployment_revision` means one entry in
[`requirements.ts`](services/lab-orchestrator/src/requirements.ts) and one
handler in [`services/verifier/src/handlers/`](services/verifier/src/handlers/).
The mapped type in the verifier registry makes the compiler refuse the first
without the second. Nothing else — no route, no component, no lab-specific
branch anywhere.

### Adding LINUX-011

Identical, on the other substrate. `labs/linux/linux-011-<topic>/lab.yaml`,
with:

```yaml
track: linux
environment:
  provider: linux                 # isolation: container is implied and checked

setup:                            # optional
  seed_scripts: [setup/seed.sh]   # NOT manifests — the loader refuses those here
  verify:
    - type: file_exists
      path: /srv/example/input.csv

requirements:                     # Linux types only; a Kubernetes type is refused
  - type: file_mode
    path: /srv/example/input.csv
    mode: "640"
    label: The input file is readable only by its owner and group

references:                       # official Linux documentation, as validated
  - title: chmod(1) — Linux manual page
    url: https://man7.org/linux/man-pages/man1/chmod.1.html
```

Restart the API; `labsLoaded` becomes 21. The lab appears under the Linux track,
provisions its own container, seeds its baseline root-only and then removes it,
is graded against the live filesystem, and is reset by replacing the container.
No application code is involved — the same rule, on the second track.

---

## API reference

All responses use a structured envelope:

```jsonc
{ "ok": true,  "data": { /* … */ } }
{ "ok": false, "error": { "code": "…", "message": "…", "remediation": "…" } }
```

### Catalog and Start Lab

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | service status, labs loaded, lab load errors, **provider readiness**, session capacity |
| `GET` | `/api/labs` | catalog: lab cards + tracks + **provider readiness** |
| `GET` | `/api/labs/:labId` | student-safe lab definition for the UI |
| `POST` | `/api/labs/:labId/start` | create a session sandbox; returns the session, provisioning steps, and a session-bound terminal token |
| `GET` | `/api/tracks` | list tracks with their topics and difficulties |
| `GET` | `/api/tracks/:trackId` | one track, with its labs |
| `GET` | `/api/tracks/:trackId/labs` | the labs in one track |

`GET /api/labs` and `GET /api/tracks/:trackId/labs` accept optional filters:
`?track=` `?topic=` `?difficulty=` `?level=` `?q=` (free text over id, title,
summary and topic). Unknown values match nothing rather than erroring. On the
track endpoints the path pins the track, so a contradicting `?track=` is
ignored rather than allowed to widen the result.

**Catalog responses are student-safe.** Neither endpoint serves the requirement
objects, the setup manifests, the setup files, or the reset policy — the
expected end state of a lab is the solution, and for K8S-010 the setup manifest
*is* the injected fault. `GET /api/labs/:labId` serves requirements as their
student-facing `label` strings only. Browsing the catalog also touches no
cluster and creates nothing.

**Catalog responses carry provider readiness** (PLATFORM-004). Each lab gets
`provider` and `availability`, each track gets `providers` and `availability`,
and the top level carries a `providers` array covering every provider in the
vocabulary — including the ones with no labs yet, which is how Docker and AWS
appear as *Coming soon* rather than as something startable:

```jsonc
{
  "labs": [
    { "id": "LINUX-001", "provider": "linux",
      "availability": { "provider": "linux", "available": true } }
  ],
  "tracks": [
    { "track": "linux", "labCount": 1, "providers": ["linux"],
      "availability": { "available": true } }
  ],
  "providers": [
    { "provider": "kubernetes", "available": true },
    { "provider": "docker", "available": false,
      "reason": "Docker labs need a per-session Docker daemon…" }
  ]
}
```

**There is deliberately no `/api/kubernetes/start`, `/api/linux/start` or
`/api/terraform/start`.** One `POST /api/labs/:labId/start` serves every track,
and a test asserts those routes return 404 so the split cannot creep back in.

### Session operations

Everything that acts on a *running* environment is addressed by session id, not
by lab id — two students on the same lab have two different sandboxes.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/sessions/:sessionId` | status, countdowns, idle warning |
| `POST` | `/api/sessions/:sessionId/check` | run the verifier against this session's own sandbox |
| `POST` | `/api/sessions/:sessionId/reset` | restore this session's baseline |
| `POST` | `/api/sessions/:sessionId/activity` | record activity ("Continue Lab") |
| `POST` | `/api/sessions/:sessionId/hints` | record that a hint was revealed (idempotent) |
| `DELETE` | `/api/sessions/:sessionId` | End Lab: delete the sandbox, release the slot |

The shape is identical on every track. What differs is what the session's
handle names: `sandboxKind` reports `namespace` or `container`, and a
container-backed reset additionally reconnects the student's terminal, because
replacing the container killed the shell inside it.

### Progress and attempts (PLATFORM-005)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/me` | who this request is attributed to, and whether that is durable |
| `GET` | `/api/me/progress` | completed / total per track, and per-lab status |
| `GET` | `/api/me/attempts` | recent attempts, newest first (`?limit=`, capped at 100) |
| `GET` | `/api/me/attempts/:attemptId` | one attempt, with the hints it used |

`me`, never `/api/students/:id`: there is no authentication yet, and a route that
took a student id in the path would invite exactly the mistake this story warns
about. The server decides who the caller is — see
[Development student identity](#development-student-identity).

```jsonc
// GET /api/me/progress
{
  "student": { "studentId": "dev-student-001", "authenticated": false,
               "identitySource": "development-default", "durable": true },
  "overall": { "total": 21, "completed": 1, "inProgress": 0,
               "notStarted": 20, "percent": 5 },
  "tracks": [
    { "track": "kubernetes", "title": "Kubernetes", "total": 10, "completed": 1,
      "inProgress": 0, "notStarted": 9, "percent": 10,
      "labs": [
        { "labId": "K8S-001", "title": "Create Your First Pod",
          "status": "COMPLETED", "attemptCount": 1, "completionCount": 1,
          "completedAt": "2026-08-17T19:47:15.418Z", "lastCompletedAt": "…" },
        { "labId": "K8S-002", "title": "…", "status": "NOT_STARTED", … }
      ] }
  ]
}

// GET /api/me/attempts
{ "attempts": [
    { "attemptId": "8d6cefa9-…", "labId": "K8S-001",
      "labTitle": "Create Your First Pod", "track": "kubernetes",
      "status": "PASSED", "startedAt": "…",
      "completedAt": "2026-08-17T19:47:15.418Z",   // learning
      "endedAt":     "2026-08-17T19:47:22.069Z",   // infrastructure
      "checkCount": 3, "resetCount": 1 } ] }
```

`POST /api/labs/:id/start`, `POST /api/sessions/:id/check`,
`POST /api/sessions/:id/reset` and `DELETE /api/sessions/:id` all now carry the
same `attempt` object in their response — absent, rather than faked, when
nothing could be recorded. `check` additionally returns `newlyCompleted`, true
only for the check that first completed the attempt.

Notes on these endpoints:

- **No database internals cross the boundary.** No row ids beyond the attempt's
  own UUID, no column names, no table names, no connection details.
- **No `sessionId`.** Possessing a session id is what authorises acting on a
  sandbox, so a history endpoint has no business handing them back — least of
  all in a list. A test asserts every `me` payload is free of them.
- **Another student's attempt is a `404`**, indistinguishable from one that does
  not exist.
- `PROGRESS_UNAVAILABLE` (`503`) means the store could not be read. Lab
  environments are unaffected, and the message says so.

### Internal (service-to-service, not reachable from a browser)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/internal/sessions/:sessionId/credentials` | what the terminal needs to open this session's shell |

In the other direction, on the **terminal service** (`:4001`), the API calls
`POST /internal/terminate` when a session ends and `POST /internal/reattach`
after a container-backed reset has replaced the container the shell lived in.
Both carry
the same shared secret, and both are best-effort: sandbox teardown is never
blocked by an unreachable terminal service.

The terminal binding is a closed, discriminated union, because the tracks
differ in kind: `{"kind":"kubernetes", "kubeconfig": …}` carries an actual
credential, while `{"kind":"container-exec", "containerRef": …, "user": …}`
carries none — it names a container, a user and a working directory, and the
terminal service builds the argv itself. Neither variant carries a command
line, so nothing here can become "run this string".

Notes:

- **The sandbox is never an input.** No endpoint accepts a namespace, a
  container reference, or a provider. All three are looked up from the session
  record on every request, so possessing or guessing one grants nothing at all.
- **Session payloads describe the sandbox honestly.** `provider`,
  `sandboxKind` and `sandboxRef` on every session; `namespace` only when the
  provider is `kubernetes`.
- **`POST /api/sessions/:id/reset` returns `reconnectTerminal`.** True for
  container-backed providers, whose reset replaces the sandbox and therefore
  ends the shell attached to the old one; false for Kubernetes, whose reset
  keeps the namespace and the shell.
- **Session possession is the MVP authorization mechanism, and it is NOT
  production authentication.** There are no user accounts yet, so holding a
  session id is what lets you act on that session. This is why session ids are
  64 bits of `crypto.randomBytes` rather than a counter — but it is a stopgap,
  and a later story replaces it with real identity. See
  [Security](#security).
- A failing lab is a *successful* check: `200` with `"passed": false`. `503` is
  reserved for "the cluster could not be read at all".
- `:labId` is validated against `^[A-Z][A-Z0-9]{1,9}-\d{3}$` and `:sessionId`
  against `^sess-[0-9a-f]{7,32}$` before either touches the filesystem or
  Kubernetes. Anything else returns `400`.
- **There is no endpoint that executes commands.** Shell access exists only
  through the terminal WebSocket, and only with a valid session token.

Error codes you may meet: `INVALID_LAB_ID`, `LAB_NOT_FOUND`, `INVALID_TRACK_ID`,
`TRACK_NOT_FOUND`, `INVALID_SESSION_ID`, `SESSION_NOT_FOUND`,
`SESSION_NOT_ACTIVE`, `LAB_CAPACITY_REACHED`, `SESSION_PROVISION_FAILED`,
`SETUP_FAILED`, `ENVIRONMENT_UNREACHABLE`, `INVALID_STUDENT_ID`,
`INVALID_HINT_INDEX`, `ATTEMPT_NOT_FOUND`, `PROGRESS_UNAVAILABLE`, and — when
a deployment does not run the substrate a lab asks for —
`UNKNOWN_ENVIRONMENT_PROVIDER` on start and `VERIFIER_NOT_CONFIGURED` on
check. Both are `503`, and both are raised before anything is created.

Try it:

```bash
curl -s localhost:4000/api/labs | jq '.data.labs[].id'
curl -s localhost:4000/api/tracks | jq '.data.tracks'
curl -s 'localhost:4000/api/tracks/kubernetes/labs?difficulty=intermediate' \
  | jq '[.data.labs[].id]'

SID=$(curl -s -X POST localhost:4000/api/labs/K8S-001/start | jq -r '.data.session.sessionId')
curl -s "localhost:4000/api/sessions/$SID" | jq '.data.session | {status, secondsRemaining}'
curl -s -X POST "localhost:4000/api/sessions/$SID/check" | jq '.data.summary'
curl -s -X POST "localhost:4000/api/sessions/$SID/hints" \
  -H 'content-type: application/json' -d '{"level":1}' | jq '.data'
curl -s -X DELETE "localhost:4000/api/sessions/$SID" | jq '.data.message'

# The same four calls, on the other substrate.
LID=$(curl -s -X POST localhost:4000/api/labs/LINUX-001/start | jq -r '.data.session.sessionId')
curl -s "localhost:4000/api/sessions/$LID" | jq '.data.environment | {provider, isolation, image}'
curl -s -X POST "localhost:4000/api/sessions/$LID/check" | jq '.data.summary'
curl -s -X DELETE "localhost:4000/api/sessions/$LID" | jq '.data.message'

# …and the part that outlives all of it
curl -s localhost:4000/api/me/progress | jq '.data.overall'
curl -s localhost:4000/api/me/attempts | jq '.data.attempts[] | {labId, status}'
```

---

## Automated tests

```bash
npm run typecheck        # tsc --noEmit across all workspaces
npm test                 # unit tests, no cluster required
npm run build            # frontend production build
```

Integration tests against a real kind cluster:

```bash
npm run cluster:up
RUN_INTEGRATION_TESTS=1 \
KUBECONFIG="$PWD/infrastructure/kind/generated/kubeconfig-host.yaml" \
  npx vitest run test/integration.test.ts --root services/lab-orchestrator
```

The PLATFORM-003 catalog suite runs every lab against the real cluster —
provisioning, solving, verifying, resetting and tearing down each one:

```bash
RUN_INTEGRATION_TESTS=1 \
KUBECONFIG="$PWD/infrastructure/kind/generated/kubeconfig-host.yaml" \
  npx vitest run test/labs-integration.test.ts --root services/lab-orchestrator
```

Integration tests against real Docker, for the Linux track. These need the
training image and a reachable Docker socket, and they are where every claim a
mock could only pretend to prove is settled — real commands against real state,
real isolation between five concurrent sandboxes, real teardown:

```bash
npm run sandbox:build
make test-sandbox
```

The end-to-end terminal suite additionally needs a working `node-pty`, which
means Node 22 (see [Requirements](#requirements)). On a host running a newer
Node it skips itself with a message rather than failing:

```bash
RUN_INTEGRATION_TESTS=1 \
KUBECONFIG="$PWD/infrastructure/kind/generated/kubeconfig-host.yaml" \
  npx vitest run test/terminal-integration.test.ts --root services/terminal
```

Integration tests against **real sandbox containers** — no cluster needed, but
Docker and the sandbox images are:

```bash
npm run sandbox:build
RUN_INTEGRATION_TESTS=1 \
  npx vitest run test/sandbox-integration.test.ts --root apps/api
# or: make test-sandbox
```

That suite creates real containers, runs real commands in them, solves
LINUX-001 and TF-001 the way a student would, and asserts the sandbox's actual
hardening by reading it back from the daemon:

```text
✓ creates a container with no network, no capabilities and bounded resources
✓ runs real Linux commands as an unprivileged user with no daemon access
✓ fails LINUX-001 before the work and passes it after, on real state
✓ restores the baseline on Reset and destroys the sandbox on End
✓ keeps two students in two sandboxes
✓ reclaims an expired sandbox without anyone asking
✓ refuses to delete a container it does not own
✓ ships a working terraform CLI and the lab starter files
✓ runs init, plan and apply offline, and passes TF-001 on real state
✓ restores the starter configuration on Reset and removes the sandbox on End
✓ runs a Linux and a Terraform sandbox side by side, isolated
```

It skips itself with an explanation when Docker or an image is missing, rather
than failing a developer who has not built them.

Integration tests against a real **Docker** daemon. No cluster is needed; the
host must permit privileged containers, and the first run pulls `docker:dind`:

```bash
npm run test:integration:docker
```

This suite exists because the Docker track's central claims are claims about
Docker, not about our code — whether two sandboxes genuinely have separate image
stores, whether one session's client certificate is actually rejected by another
session's daemon, whether `--memory` is actually applied. A fake that returned
"denied" would prove none of it, so nothing in that file is faked.

Persistence tests against a **real PostgreSQL** — no cluster and no sandbox
images needed, just Docker:

```bash
make test-db
TEST_DB_PORT=55440 make test-db   # if 55432 is already taken on your machine
```

That target starts a throwaway `postgres:16-alpine`, runs the migrations against
it, and executes two suites before removing it again:

```text
services/progress   the repository contract, run against PostgreSQL itself —
                    the constraints, the ON CONFLICT clauses, the transaction
                    boundaries, and the migration runner (idempotence, the
                    checksum guard)
apps/api            the headline claim end to end: complete a lab, destroy the
                    sandbox, throw the whole API process away, and read the
                    progress back from a brand-new one
```

The same contract suite runs against the in-memory store in `npm test`, which is
what stops the fallback quietly becoming a different product. To point the
suites at a database you already have:

```bash
RUN_DB_TESTS=1 \
TEST_DATABASE_URL=postgresql://user:password@localhost:5432/jumptotech_labs_test \
  npm run test:db
```

Without `RUN_DB_TESTS=1` they skip themselves with a message, exactly like the
cluster and sandbox suites.

### Running the catalog tests only

The catalog, schema, setup-engine and verification suites need no cluster:

```bash
npx vitest run test/lab-catalog.test.ts test/setup-engine.test.ts \
  --root services/lab-orchestrator          # catalog + schema + setup engine
npx vitest run --root services/verifier      # every requirement type
npx vitest run --root apps/api               # catalog + track + session APIs
npx vitest run --root apps/web               # catalog UI, lab page, hints
```

### Running the Docker track tests only

None of these need a Docker daemon — they run against `FakeDockerEngines`, which
models the two-level topology (host daemon → one isolated daemon per sandbox)
without simulating any kernel behaviour:

```bash
npx vitest run test/docker-provider.test.ts test/docker-lab-definition.test.ts \
  test/provider-registry.test.ts --root services/lab-orchestrator
npx vitest run test/docker-requirements.test.ts --root services/verifier
npx vitest run test/docker-credentials.test.ts test/workspace.test.ts \
  --root services/terminal
npx vitest run test/docker-api.test.ts --root apps/api
npx vitest run test/multi-track-catalog.test.ts --root apps/web
```

### PLATFORM-001 coverage

| # | Requirement | Where |
|---|---|---|
| 1 | Lab YAML loading | `lab-orchestrator/test/lab-definition.test.ts` |
| 2 | Lab ID validation | `lab-orchestrator/test/validation.test.ts` |
| 3 | Kubernetes environment health | `kind-provider.test.ts` + `integration.test.ts` |
| 4 | Verifier — Pod does not exist | `verifier/test/verifier.test.ts` + `integration.test.ts` |
| 5 | Verifier — wrong image | `verifier/test/verifier.test.ts` + `integration.test.ts` |
| 6 | Verifier — correct Pod | `verifier.test.ts` + `integration.test.ts` |
| 7 | Reset functionality | `kind-provider.test.ts` + `integration.test.ts` |

### PLATFORM-002 coverage

| # | Requirement | Where |
|---|---|---|
| 1–3 | Unique session ids and namespaces | `identifiers.test.ts`, `session-manager.test.ts`, `integration.test.ts` |
| 4–6 | Cross-session read/write isolation | `integration.test.ts` (real RBAC) |
| 7–9 | Student cannot create namespaces, read kube-system, or modify nodes | `integration.test.ts` (real RBAC) |
| 10 | Student can do K8S-001 in their own namespace | `integration.test.ts` |
| 11–13 | ResourceQuota / LimitRange / NetworkPolicy exist | `isolation.test.ts` + `integration.test.ts` |
| 14 | Excessive resource creation rejected | `integration.test.ts` (real quota admission) |
| 15–16 | Verifier isolation | `verifier.test.ts`, `api.test.ts`, `integration.test.ts` |
| 17–18 | Reset isolation | `session-manager.test.ts`, `api.test.ts`, `integration.test.ts` |
| 19–20 | End Lab isolation | `session-manager.test.ts`, `api.test.ts`, `integration.test.ts` |
| 21–24 | Expiry / idle / retention / idempotent cleanup | `reaper.test.ts` + `integration.test.ts` |
| 25 | Cleanup refuses unmanaged namespaces | `isolation.test.ts`, `kind-provider.test.ts`, `integration.test.ts` |
| 26 | Five simultaneous isolated sessions | `integration.test.ts` |
| 27 | `MAX_ACTIVE_SESSIONS` enforced | `session-manager.test.ts`, `api.test.ts`, `integration.test.ts` |

### PLATFORM-003 coverage

| # | Requirement | Where |
|---|---|---|
| 1–2 | Discover multiple labs, load valid definitions | `lab-catalog.test.ts` |
| 3–4 | Reject invalid definitions and duplicate ids/slugs | `lab-catalog.test.ts` |
| 5–6 | Filter by track; catalog-safe metadata | `lab-catalog.test.ts`, `catalog-api.test.ts` |
| 7–12 | Validate skills, prerequisites, hints, documentation, setup, requirements | `lab-catalog.test.ts` |
| 13 | Setup manifests apply only to the session namespace | `setup-engine.test.ts` + `labs-integration.test.ts` |
| 14 | Reset restores the lab's initial state | `setup-engine.test.ts` + `labs-integration.test.ts` |
| 15 | Setup cannot target protected namespaces or kinds | `setup-engine.test.ts` |
| 16–24 | Pod, Deployment, Service, ConfigMap, Secret, Job, CronJob, probe, resource checks | `verifier/test/requirements.test.ts` |
| 25–26 | K8S-010 fails while broken, passes after repair | `requirements.test.ts` + `labs-integration.test.ts` (real cluster) |
| 27 | K8S-002 session A cannot affect session B | `labs-integration.test.ts` (real RBAC) |
| 28 | K8S-010 Reset A does not modify B | `labs-integration.test.ts` (real cluster) |
| 29 | The verifier never passes on another session's resources | `requirements.test.ts`, `catalog-api.test.ts`, `labs-integration.test.ts` |
| 30–32 | `GET /api/labs`, `GET /api/labs/:id`, unknown-lab errors | `catalog-api.test.ts` |
| 33 | PLATFORM-002 session APIs still work | `catalog-api.test.ts`, `api.test.ts`, `integration.test.ts` |
| 34 | Catalog renders multiple labs | `CatalogPage.test.tsx`, `live-payloads.test.tsx` |
| 35 | One lab page renders different definitions | `LabBrief.test.tsx`, `live-payloads.test.tsx` |
| 36 | Progressive hints reveal one at a time | `HintPanel.test.tsx`, `live-payloads.test.tsx` |
| 37 | Start / Reset / End / Check still function | `catalog-api.test.ts`, `labs-integration.test.ts`, `StartOverlay.test.tsx`, `CheckPanel.test.tsx` |

### PLATFORM-004 coverage

| # | Requirement | Where |
|---|---|---|
| 1–3 | `kubernetes` / `linux` / `terraform` providers resolve | `provider-registry.test.ts` |
| 4 | Unknown provider rejected by name | `provider-registry.test.ts` |
| 5 | Disabled provider returns a clear unavailable state | `provider-registry.test.ts`, `multi-track-api.test.ts` |
| 6 | Session records its provider and sandbox kind | `multi-provider-session.test.ts` |
| 7 | Sandbox reference is bound server-side and is not patchable | `multi-provider-session.test.ts` |
| 8 | Session A cannot reach, reset or destroy session B's sandbox | `multi-provider-session.test.ts`, `container-provider.test.ts`, `sandbox-integration.test.ts` (**real**) |
| 9 | A Linux session creates an isolated sandbox | `container-provider.test.ts`, `sandbox-integration.test.ts` (**real**) |
| 10 | The terminal executes real Linux commands | `sandbox-integration.test.ts` (**real**) |
| 11 | LINUX-001 starts | `multi-track-api.test.ts`, `sandbox-integration.test.ts` (**real**) |
| 12–13 | LINUX-001 fails initially and passes on correct state | `sandbox-requirements.test.ts`, `sandbox-integration.test.ts` (**real**) |
| 14 | Reset restores the Linux baseline | `container-provider.test.ts`, `sandbox-integration.test.ts` (**real**) |
| 15 | End destroys the sandbox | `container-provider.test.ts`, `sandbox-integration.test.ts` (**real**) |
| 16 | Expiry destroys the sandbox | `multi-provider-session.test.ts`, `sandbox-integration.test.ts` (**real**) |
| 17–18 | Terraform sandbox starts and the CLI is present | `container-provider.test.ts`, `sandbox-integration.test.ts` (**real**) |
| 19–20 | TF-001 fails initially and passes on real state | `sandbox-requirements.test.ts`, `sandbox-integration.test.ts` (**real**) |
| 21 | Reset restores the Terraform starter configuration | `container-provider.test.ts`, `sandbox-integration.test.ts` (**real**) |
| 22 | End destroys the Terraform sandbox | `sandbox-integration.test.ts` (**real**) |
| 23–24 | K8S-001 and K8S-010 still work | `labs-integration.test.ts` (**real kind**) |
| 25 | Kubernetes isolation tests still pass | `integration.test.ts` (**real RBAC**) |
| 26 | Five simultaneous isolated sessions still pass | `integration.test.ts` (**real kind**) |
| 27 | Namespace cleanup still works | `integration.test.ts`, `reaper.test.ts` |
| 28 | Path traversal rejected, twice over | `sandbox-paths.test.ts`, `container-provider.test.ts` |
| 29 | The browser cannot choose another container | `multi-track-api.test.ts`, `container-provider.test.ts` |
| 30 | The browser cannot choose another provider context | `multi-provider-session.test.ts`, `multi-track-api.test.ts` |
| 31 | Cleanup refuses an unmanaged sandbox | `multi-provider-session.test.ts`, `container-provider.test.ts`, `sandbox-integration.test.ts` (**real**) |
| 32 | No public API returns credentials or sensitive references | `multi-track-api.test.ts` |
| 33 | Kubernetes / Linux / Terraform tracks appear | `multi-track-api.test.ts`, `catalog-api.test.ts` |
| 34 | Disabled providers are marked correctly | `multi-track-api.test.ts` |
| 35 | Labs filter correctly by track | `multi-track-api.test.ts`, `lab-catalog.test.ts` |

### PLATFORM-005 coverage

| # | Requirement | Where |
|---|---|---|
| 1 | Student progress survives sandbox deletion | `progress-api.test.ts`, `repository-contract.ts`, `progress-persistence.test.ts` (**real PostgreSQL**) |
| 2 | Starting a lab creates an attempt | `progress-api.test.ts`, `repository-contract.ts` |
| 3 | PASS persists completion | `progress-api.test.ts`, `repository-contract.ts` (**both stores**) |
| 4 | Repeated PASS does not duplicate the completion | `progress-api.test.ts`, `repository-contract.ts` (**both stores**) |
| 5 | Reset increments `reset_count` and erases nothing | `progress-api.test.ts`, `repository-contract.ts` |
| 6 | Ending a lab preserves attempt history | `progress-api.test.ts`, `repository-contract.ts` |
| 7 | Expiration preserves attempt history | `progress-api.test.ts` (**via the reaper**), `repository-contract.ts` |
| 8 | Hint usage persists | `progress-api.test.ts`, `repository-contract.ts`, `progress-persistence.test.ts` |
| 9 | A duplicate hint event is idempotent | `progress-api.test.ts`, `repository-contract.ts` (**a DB constraint**) |
| 10 | Different students have independent progress | `progress-api.test.ts`, `repository-contract.ts` |
| 11–13 | Kubernetes, Linux and Terraform progress | `progress-api.test.ts` (all three solved through the real verifier) |
| 14 | PLATFORM-001–004 tests still pass | the suites above, unchanged |
| — | Migrations are idempotent and non-destructive | `postgres-repository.test.ts` (**real PostgreSQL**) |
| — | An edited applied migration is refused | `postgres-repository.test.ts` (**real PostgreSQL**) |
| — | No student id from a query string or body | `progress-api.test.ts` |
| — | No session id or database internal in any `me` payload | `progress-api.test.ts` |
| — | A lab still works when the store is down | `progress-api.test.ts` (`BrokenProgressRepository`) |
| — | An attempt orphaned by an API restart is closed, and a live one is not | `service.test.ts`, `repository-contract.ts` (**both stores**) |
| — | Dashboard and catalog completion state | `ProgressPage.test.tsx`, `CatalogProgress.test.tsx` |

### Linux track coverage

The Linux track is verified through the same seams as everything else, so this
table is about *what is specific to Linux* rather than a second lifecycle.

| # | Requirement | Where |
|---|---|---|
| 1–2 | Ten Linux lab definitions load; the catalog carries every track | `linux-labs.test.ts`, `lab-catalog.test.ts`, `catalog-api.test.ts` |
| 3 | Starting a Linux lab creates an isolated container | `linux-provider.test.ts`, `linux-sessions.test.ts`, `sandbox-integration.test.ts` (**real**) |
| 4 | A unique container per session | `linux-sessions.test.ts`, `linux-api.test.ts` |
| 5 | The terminal attaches to the student's own container | `spawn-plan.test.ts`, `linux-api.test.ts`, `terminal-integration.test.ts` (**real PTY**) |
| 6 | Real Linux commands execute against real state | `sandbox-integration.test.ts` (**real**) |
| 7 | Student A cannot see or reach student B's environment | `linux-provider.test.ts`, `linux-api.test.ts`, `sandbox-integration.test.ts` (**real**) |
| 8 | Filesystem checks read real state | `sandbox-requirements.test.ts`, `linux-verifier.test.ts` |
| 9 | Permission, ownership and group checks | `sandbox-requirements.test.ts`, `linux-verifier.test.ts` |
| 10 | Process and listening-port checks | `linux-verifier.test.ts` |
| 11 | Script checks grade behaviour, not source | `linux-verifier.test.ts` |
| 12–13 | Every shipped Linux lab fails unsolved and passes solved | `linux-verifier.test.ts` |
| 14 | Reset replaces the container and reconnects the shell | `linux-provider.test.ts`, `linux-sessions.test.ts`, `linux-api.test.ts` |
| 15–17 | End Lab, expiry, and idempotent cleanup | `linux-sessions.test.ts`, `reaper.test.ts` |
| 18 | Five concurrent sessions stay isolated | `linux-sessions.test.ts`, `sandbox-integration.test.ts` (**real**) |
| 19 | The API routes start / terminal binding / check / reset / end per track | `linux-api.test.ts`, `multi-track-api.test.ts` |
| 20 | The catalog presents more than one track | `CatalogTracks.test.tsx`, `live-payloads.test.tsx` |
| 21 | Seed scripts stage the baseline as root, then vanish | `linux-provider.test.ts`, `linux-sessions.test.ts` |
| 22 | The capability grant is bounded, and never host-reaching | `linux-provider.test.ts`, `container-provider.test.ts` |
| 23 | Inspection commands are allow-listed; anything else is refused | `linux-provider.test.ts`, `linux-verifier.test.ts` |

Everything that depends on the container runtime genuinely *enforcing*
something — the capability drop, the pids limit, `--network none`, a real shell
running as `student` — is asserted against real Docker in
`apps/api/test/sandbox-integration.test.ts`, never against a fake. The fakes
pin what the platform *asks for*; only the integration suite can pin what the
kernel does about it.

The web suite additionally renders the components against **verbatim API
responses** captured in `apps/web/test/fixtures/` — including
`me-progress.json` and `me-attempts.json` — which is what catches a drift
between what the API sends and what the UI expects; hand-written fixtures
would hide exactly that. That capture is a three-track, twenty-one-lab
catalog, so the catalog page is exercised against the shape it actually
serves.

Anything that depends on the API server actually *enforcing* something — RBAC
decisions, quota admission, namespace deletion, an image that cannot be pulled,
a Service with no endpoints — is asserted against real kind, never against a
mock. A mock that returned "Forbidden" would prove nothing.

Plus: session-token forgery/expiry/rebinding, terminal protocol fuzzing,
credential file permissions and cleanup, API routing and error shape, and a
check that no command-execution endpoint exists.

### PLATFORM-DOCKER coverage

| Area | Where |
|---|---|
| Docker lab schema, vocabulary matching, `setup.docker` safety | `lab-orchestrator/test/docker-lab-definition.test.ts` |
| Per-track documentation rules, `track.yaml`, track discovery | `docker-lab-definition.test.ts`, `lab-catalog.test.ts` |
| Sandbox create / status / reset / destroy / credentials / cleanup | `lab-orchestrator/test/docker-provider.test.ts` |
| Resource controls reach the sandbox | `docker-provider.test.ts`, `docker-api.test.ts`, `docker-integration.test.ts` (real) |
| Provider routing, multi-track sessions, reaper across substrates | `lab-orchestrator/test/provider-registry.test.ts` |
| Every Docker requirement type; every shipped lab fails empty and passes solved | `verifier/test/docker-requirements.test.ts` |
| Workspace path safety, per-session directories, size cap | `terminal/test/workspace.test.ts` |
| Docker credential parsing, file modes, per-session material | `terminal/test/docker-credentials.test.ts` |
| Start / check / reset / end a Docker lab over HTTP; cross-session checks | `apps/api/test/docker-api.test.ts` |
| Multi-track catalog, track order and taglines, substrate wording | `apps/web/test/multi-track-catalog.test.tsx` |
| **Separate daemons, mutual-TLS rejection, real limits, real teardown** | `lab-orchestrator/test/docker-integration.test.ts` (real Docker) |

The same rule as the Kubernetes track applies to what a fake may be used for.
`FakeDockerEngines` models the topology so provider, session, reaper, and
verifier logic can be exercised without a daemon; it deliberately simulates no
kernel behaviour, so no test can "prove" an isolation property against a mock.
Everything that depends on Docker actually enforcing something is asserted
against a real daemon.

---

## Troubleshooting

**`network kind declared as external, but could not be found`**
The kind cluster does not exist yet. Run `npm run cluster:up` first.

**`required variable POSTGRES_PASSWORD is missing a value`**
The stack will not start with a default database password. `make setup` adds a
generated one to `.env` (including to an `.env` you already had), or set it
yourself:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" >> .env
```

**The API exits at startup with a database error**
A configured-but-unreachable database is a hard failure by design — the
alternative is telling students their progress is saved when it is not.

```bash
docker compose ps postgres          # is it healthy?
docker compose logs postgres
docker compose logs api | grep progress
curl -s localhost:4000/health | jq '.data.progress'
```

To run without a database on purpose, unset `DATABASE_URL`: the API starts on
the in-memory store and says so at startup, on `/health` (`"store": "memory"`)
and on the dashboard (*"not saved to a database"*).

**My progress disappeared**
`docker compose down -v` and `make clean` delete the `postgres-data` volume.
Plain `docker compose down` does not. Also check `/health` — if it reports
`"store": "memory"`, nothing was ever being saved.

**Start Lab fails with `ENVIRONMENT_UNREACHABLE`**
The API cannot reach the cluster. Check:

```bash
kind get clusters                       # is jumptotech-labs there?
docker network inspect kind | grep jumptotech-api   # is the api attached?
docker compose logs api
```

If you recreated the cluster, the kubeconfig changed — re-run
`npm run cluster:up` (it re-exports both kubeconfigs) and
`docker compose restart api terminal`.

**A Linux lab fails with `ENVIRONMENT_UNREACHABLE`**
The shipped Compose stack cannot run container-backed labs, deliberately: no
container in it is given a container runtime, and the Docker socket is never
mounted into any of them.

```bash
docker compose logs api | grep -i 'provider'
curl -s localhost:4000/api/labs/LINUX-001 | jq '.data.availability'
```

Run the services on your host instead — `npm run dev:api`, `npm run dev:terminal`,
`npm run dev:web`. See [The Linux track](#the-linux-track).

**A Linux lab is marked unavailable naming the sandbox image**
The image has not been built on this machine:

```bash
npm run sandbox:build
docker image inspect jumptotech/lab-linux:latest >/dev/null && echo present
```

**A Linux lab is marked unavailable naming the container runtime**
Nothing reachable is answering as a container daemon. Start Docker Desktop (or
your runtime) and reload the catalog; the Kubernetes track is unaffected either
way, and the Linux labs stay catalogued rather than disappearing.

**Start Lab fails with `TERMINAL_UNAVAILABLE`**

```bash
docker compose logs terminal
curl localhost:4001/health
```

A `UNAUTHORIZED` in the logs usually means the api and terminal containers have
different `TERMINAL_SESSION_SECRET` values — both read it from the same `.env`,
so run `docker compose up -d --force-recreate` after changing it.

**Terminal connects but `kubectl` says `connection refused`**
The terminal container is not on the `kind` network. Re-create it:
`docker compose up -d --force-recreate terminal`.

**Terminal closes immediately with `CREDENTIALS_UNAVAILABLE`**
The terminal could not exchange its session id for a kubeconfig. Check that the
api is up and that both services share `INTERNAL_SERVICE_SECRET`:

```bash
docker compose logs terminal | grep credential
curl -s localhost:4000/health | jq '.data.sessions'
```

**Terminal `kubectl` says `Unauthorized` rather than `Forbidden`**
`Forbidden` is correct and expected outside your own namespace. `Unauthorized`
means the ServiceAccount token itself was rejected — usually a clock skew
between host and cluster, or a token that outlived its session. Start the lab
again to get a fresh one.

**`Start Lab` returns `LAB_CAPACITY_REACHED`**
`MAX_ACTIVE_SESSIONS` is reached. Either wait for the reaper, raise the limit in
`.env`, or list and release stale sandboxes:

```bash
KUBECONFIG=infrastructure/kind/generated/kubeconfig-host.yaml \
  kubectl get ns -l jumptotech.io/managed=true \
  -L jumptotech.io/lab-id,jumptotech.io/expires-at
```

**A lab namespace is stuck `Terminating`**
Namespace deletion is asynchronous, and a session stays `EXPIRING`/`ENDING`
until the namespace is verifiably gone. The reaper re-enters that teardown on
every sweep, so this normally resolves itself within a minute or two. If it does
not, something in the namespace has a finaliser that is not completing —
`kubectl get ns <name> -o json | jq .spec.finalizers`.

**`Check Solution` says the image is wrong when it looks right**
Compare exactly: `nginx` normalises to `nginx:latest`, which is *not*
`nginx:stable`. The verifier does accept `docker.io/library/nginx:stable`.

**Port already in use**
Change `WEB_PORT` / `API_PORT` / `TERMINAL_PORT` in `.env`, and update
`VITE_API_URL`, `VITE_TERMINAL_WS_URL`, and `ALLOWED_ORIGINS` to match.

**Everything is confused; start over**

```bash
docker compose down
npm run cluster:down
npm run cluster:up
docker compose up --build
```

To clear only the lab sandboxes, without recreating the cluster:

```bash
KUBECONFIG=infrastructure/kind/generated/kubeconfig-host.yaml \
  kubectl delete ns -l jumptotech.io/managed=true
```

That selector is the same one the reaper uses, so it can only ever match
namespaces this platform created.

---

## Security

This runs untrusted student commands, so the boundaries are drawn explicitly.

**What is enforced today**

- *Every student gets their own namespace.* Never `default`. The namespace name
  is derived server-side from a 64-bit random session id through a keyed HMAC,
  is validated as an RFC 1123 label, and can never be supplied by a client.
- *The student terminal holds no cluster-admin credential.* The terminal service
  has no ambient `KUBECONFIG` at all. Per session it fetches a kubeconfig
  containing one short-lived bound ServiceAccount token scoped to one namespace,
  writes it `0600`, and deletes it when the shell dies.
- *RBAC stops at the namespace edge.* A Role and RoleBinding per session, and
  **no ClusterRole or ClusterRoleBinding anywhere in the session path**. Reading
  another namespace, `kube-system`, nodes, namespaces, or PVs is `Forbidden`, as
  is any RBAC write — so the ServiceAccount cannot grant itself anything more.
  All of this is asserted against a real API server.
- *ResourceQuota and LimitRange per namespace*, so one student cannot exhaust
  the shared node. LoadBalancer and NodePort Services are quota'd to zero.
- *NetworkPolicy per namespace*: deny-by-default, re-allowing only same-namespace
  traffic, DNS, and non-cluster egress. (Enforcement depends on the CNI — see
  the limitations below.)
- *Cleanup cannot delete what it does not own.* Four gates — sandbox name shape,
  protected-namespace list, live `jumptotech.io/managed` label, and session-label
  match — are re-read from the API server immediately before every delete.
- *Sessions expire on their own.* An absolute deadline that activity can never
  extend, plus an idle deadline, plus a reaper that reclaims orphans using the
  expiry recorded in the namespace's own labels.
- *No process runs as root.* The api image runs as `node`; the terminal image
  runs as a dedicated `student` user (uid 1001) that owns nothing in `/app`.
  Both containers set `no-new-privileges` and drop all Linux capabilities.
- *The Docker socket is never mounted into a web-facing process.* Cluster
  creation happens on the host in `scripts/cluster-up.sh`; sandbox creation
  happens in the sandbox broker, a host process outside the api, terminal and
  web containers. Neither the api nor the terminal can create a container.
- *The broker does not trust its callers.* Image, capabilities, limits, network,
  and the exec allow-list are decided in the broker, re-checked there, and
  clamped to configured ceilings — so a compromised API can ask for a sandbox
  but not for a privileged one. Every request needs the internal service secret,
  and the browser has no route to that service at all.
- *A Linux sandbox is a locked-down container.* Never privileged; all
  capabilities dropped and a minimal set added back (no `NET_RAW`, `NET_ADMIN`,
  `SYS_ADMIN`, `SYS_PTRACE`, `MKNOD`, `SYS_MODULE`); no bind mounts, volumes, or
  host paths of any kind; its own bridge network, `Internal` by default, so it
  can reach neither another student, nor the platform's own services, nor the
  internet; memory, swap, CPU, pids and file descriptors all capped.
- *A Linux session carries no credential at all.* The internal credentials
  endpoint returns the name of a container, not a secret. Possessing that name
  grants nothing without the broker's service secret.
- *Lab baselines never reach the student.* Seed scripts are lab content shipped
  in this repository, confined to the lab's own directory, size-capped, and
  required to be scripts. They are installed root-only inside one container, run
  before the student's terminal exists, and deleted afterwards whatever the
  outcome — so a troubleshooting lab's answer is never on disk to be read.
- *Nothing a Linux lab declares is executed as shell.* `command_*` checks name a
  binary from a closed list and pass an argv array; `script_runs` runs the
  student's own file, by path, as the student. The broker enforces the same
  allow-list a second time, so a bug above it cannot widen it.
- *No shell over REST.* No API endpoint executes student input. The provider's
  internal `execute()` accepts only allow-listed binaries (`kubectl`), takes an
  explicit `argv` array, and runs with `shell: false`.
- *Terminal sessions are bound to one lab session.* An HMAC-SHA256 token minted
  by `POST /api/labs/:id/start` carries the session id; the terminal resolves
  credentials from that claim alone. A second `auth` frame is refused, so a live
  socket cannot move itself to another session, and no client-supplied field
  anywhere names a session, a namespace, or a kubeconfig path.
- *Ids are allow-listed* — labs against `^[A-Z][A-Z0-9]{1,9}-\d{3}$`, sessions
  against `^sess-[0-9a-f]{7,32}$` — before being used for any filesystem or
  Kubernetes operation.
- *Lab definitions cannot name a namespace, or smuggle in a command.* Every
  schema object is `.strict()`, requirement types come from a closed vocabulary,
  and setup manifests are restricted to namespaced kinds and forced into the
  session namespace. Setup manifest paths cannot escape the lab directory, and
  the resolved path is re-checked before any read.
- *Lab content is data, and data does not execute.* There is no schema field
  that carries a command, script, or shell fragment, and no requirement type
  that runs anything — every check is a read of the Kubernetes API. A lab
  author's whole capability is "create these namespaced objects in my own
  session's namespace, and compare the result against this closed vocabulary".
- *Catalog responses never carry the answer.* `GET /api/labs` and
  `GET /api/tracks/…` omit requirements, setup manifests and reset policy
  entirely; `GET /api/labs/:id` serves requirements as student-facing labels
  only. For a troubleshooting lab the setup manifest *is* the injected fault, so
  serving it would end the exercise.
- *Secret values never enter the platform.* The Secret reader returns key names
  and the type, never `data`, and `secret_key` has no `value` field — so no lab
  can be authored that would require the verifier to hold a credential.
- *No arbitrary host filesystem access.* The api container is `read_only` with a
  tmpfs `/tmp`. The student's `$HOME` and the credential directory are small
  tmpfs mounts that vanish with the container.
- *Resource bounds.* The terminal container is capped at 512 MB and 256 PIDs;
  the gateway caps concurrent PTYs, frame size, and input size, and kills
  sessions on idle and absolute timeouts.
- *WebSocket origin checking* and a CORS allow-list, both from
  `ALLOWED_ORIGINS`. `/internal` is outside CORS and needs a shared secret.
- *Database credentials stay server-side.* Only the `api` service is given
  `DATABASE_URL`; the web and terminal services have none, PostgreSQL is not on
  the `kind` network, and no student sandbox can route to it. There is no
  default password in application source — an unset one fails loudly rather
  than connecting somewhere. Nothing logs a connection string: the log-safe
  form is host/port/database only.
- *Every database value is a bound parameter.* There is no string
  concatenation, no template literal, and no identifier taken from a request
  anywhere in `postgres/repository.ts`; the only channel for a value is the
  parameter array. Student ids are additionally allow-listed against
  `^[a-z0-9][a-z0-9._-]{2,63}$`, and attempt ids must be UUIDs before a query
  is issued.
- *Progress reads are scoped to the owner in the query itself*
  (`getAttempt(studentId, attemptId)`), so another student's attempt id returns
  `404` — the same answer as a nonexistent one.
- *No student id is ever read from a query string or a request body.* Identity
  comes from one resolver, from a validated source, and a test posts
  `studentId` every way a client could to prove it is ignored.
- *Errors do not leak internals.* Structured codes out, stack traces in the log.
  Kubeconfigs and tokens are never logged and never returned to the browser.

**Added by PLATFORM-004, for the container-backed tracks**

- *No host filesystem reaches a sandbox.* Sandbox containers are created with no
  bind mounts at all — asserted against a real daemon (`len .Mounts == 0`), not
  merely intended.
- *The Docker socket is never exposed to a student.* Not by the sandbox spec,
  not by the terminal binding, and not by any configuration flag. `command -v
  docker` inside a sandbox fails, and that is asserted too. The Docker *track*
  is disabled precisely because doing it properly needs a per-session daemon —
  see [Docker sandbox strategy](#docker-sandbox-strategy).
- *Sandboxes are unprivileged and capability-free.* `--user student`,
  `--cap-drop ALL`, `--security-opt no-new-privileges`, never `--privileged`. A
  student cannot `chown` a file to another user, because there is no CAP_CHOWN —
  which is real Linux behaviour the lab then teaches.
- *No network from a sandbox.* `--network none`. Terraform resolves its
  providers from a mirror inside the image, so even that needs no egress.
- *Resource bounds per sandbox.* `--cpus`, `--memory` (with `--memory-swap`
  equal, so the ceiling is real), and `--pids-limit`, all from configuration.
- *The browser cannot name a sandbox.* No endpoint accepts a container id, a
  namespace, a provider, or a kubeconfig path. Every operation resolves the
  sandbox from the session record — asserted by a test that sends another
  session's reference in the body and the query string and watches it be
  ignored.
- *A session cannot change provider or sandbox.* `SessionStore.update()` drops
  those fields from every patch, so it is true by construction rather than by
  convention.
- *The terminal service re-validates everything it is handed.* The API returns a
  closed union with no command line; the terminal builds its own argv after
  re-checking the container name, the user, the working directory and every
  environment name and value. Validating on both sides of a process boundary is
  the point: this check holds even if the API is wrong.
- *Verifier reads cannot leave the sandbox.* Two gates — a schema that rejects
  anything but a plain relative path, and a resolved-path re-check against the
  sandbox home — plus reads that run as the unprivileged student, so there is no
  privileged bypass of the permissions a lab is teaching. A symlink is reported
  as a symlink, so it cannot stand in for the file a check is about.
- *Cleanup still only removes what it owns.* The container gates mirror the
  namespace gates: name shape, live `jumptotech.io/managed` label, session label
  match, all re-read immediately before every delete.
- *Lab content still cannot execute anything.* Starter files are size-capped,
  confined to the sandbox home, and have their execute bits stripped; nothing in
  the platform runs one.

**Remaining limitations — do not deploy this as-is**

> **This list was written before PLATFORM-006 to PLATFORM-010 and several of its
> items had become false.** They are corrected in place below rather than
> deleted, because a security section that overstates a gap is a smaller problem
> than one that understates it — but an operator reading a stale claim makes bad
> decisions in both directions. Corrected during PLATFORM-003.

1. ~~**No authentication.**~~ **Fixed in PLATFORM-009 / PLATFORM-010.** The API
   verifies OIDC tokens against the provider's JWKS (issuer, audience,
   `exp`/`nbf`, real signature check), browser sign-in is an authorization-code
   flow with PKCE behind a server-side opaque session cookie, and every session
   operation is authorised against a stored `owner_user_id`. `AUTH_MODE`
   defaults to `oidc` and the API refuses to start with `AUTH_MODE=development`
   under `NODE_ENV=production`. See [docs/authentication.md](docs/authentication.md).
1b. ~~**Progress is attributed to a development identity.**~~ **Fixed in
   PLATFORM-010.** An authenticated caller's history is attributed to the user
   the server verified; the development header is consulted only when nobody has
   authenticated at all. What remains true: there is **no role administration
   surface**, so roles change by direct SQL only.
2. **Container isolation is not VM-grade tenant isolation, for any track.**
   Namespaces and containers alike share one kernel; a container-escape or
   kernel vulnerability crosses every boundary described above. This is stated
   plainly rather than hedged: the Linux and Terraform sandboxes are hardened
   containers, not virtual machines, and they should not be described to anyone
   as equivalent. Production needs gVisor, Kata or Firecracker underneath, plus
   seccomp profiles.
2b. ~~**The orchestrator and the terminal service reach the host's Docker
   daemon.**~~ **Fixed in PLATFORM-007.** `sandboxd` is the only process with a
   container runtime, and neither service a browser can reach holds one. Its
   three capabilities (`attach`, `runtime`, `docker`) have separate credentials
   and it refuses to start if two are equal. The original text follows for
   context:
    That is how the container tracks work today, and it
   is a capability neither process would hold in production: anything able to
   drive that daemon is effectively root on the host. The production shape is a
   dedicated sandbox-broker service owning a rootless, per-tenant daemon, with
   the API talking to it over an authenticated API rather than a socket. The
   shipped `docker compose` stack gives no container that access, which is why
   the container tracks report unavailable there — see
   [Local development requirements](#local-development-requirements).
3. **NetworkPolicy enforcement depends on the CNI.** The objects are always
   created; whether they are *enforced* is a property of the cluster. Do not
   claim tenant-level network isolation without verifying enforcement on the
   cluster you actually run. `kind` is development infrastructure and is not a
   supported production substrate.
4. **The student shell is a normal shell.** On the Kubernetes track it runs as
   an unprivileged user in a container with no host mounts, but there is no
   sandbox layer beyond Docker's defaults, and outbound network access from that
   shell is unrestricted.
5. **A Linux student is root inside their own container.** Passwordless `sudo`
   is deliberate — the track teaches administration — and it means
   `no-new-privileges` is *not* set on sandbox containers, unlike the platform's
   own. The isolation boundary is therefore the container alone: same shared
   kernel, so a container-escape or kernel vulnerability crosses it. Production
   needs gVisor, Firecracker, or per-session VMs, plus seccomp profiles. Do not
   run this on a host that matters.
6. **Anything that can reach the broker's port and holds the internal secret can
   create containers on that host.** It binds loopback by default and warns
   loudly when told to bind wider; the Docker Compose flow needs it wider, which
   makes that flow development-only.
7. ~~**Sandbox session state is in memory.**~~ **Fixed in PLATFORM-008.**
   Sessions are durable in PostgreSQL, capacity admission happens inside a
   transaction with an advisory lock, and state changes are conditional writes
   so two instances cannot both win. The original text follows for context:
   **(historical)** Restarting the API forgets *active sessions* — a student mid-lab loses their environment handle and starts
   again. Sandboxes are not leaked when that happens (the reaper reclaims
   namespaces and containers alike from their own labels), and since
   PLATFORM-005 their *history* is not lost either: attempts and progress are
   in PostgreSQL. An attempt whose session was forgotten is closed as
   `EXPIRED` by a sweep that only touches attempts older than the absolute
   session lifetime — so a restart costs the environment, not a lab stuck "in
   progress" forever. Moving the session store itself to PostgreSQL is still a
   later story; `SessionStore` remains the seam.
8. **The capacity guard is per-process.** `MAX_ACTIVE_SESSIONS` is enforced
   synchronously inside one API instance. Running several instances needs the
   same reservation inside a database transaction.
9. **`kubectl` is available in the terminal container**, and a student can reach
   the API server from it. That is the point of the lab; the RBAC above is what
   bounds it.
10. **Development kubeconfigs are written to disk** at
   `infrastructure/kind/generated/` with mode 644 so the containers' non-root
   users can read them. They are git-ignored and belong to a throwaway local
   cluster; treat them as credentials anyway.
11. ~~**The web container runs the Vite dev server.**~~ It serves a production
   Vite build from nginx — see `infrastructure/docker/web.Dockerfile`.
12. **TLS is not configured.** Still true. Everything is plain HTTP/WS on
    localhost, which also means the terminal token and the internal service
    secret travel in clear text on the local network. Termination is expected
    from a proxy in front (Cloudflare Tunnel, an ALB); the platform ships none.

13. **The platform is observable but not yet multi-instance.** Since
    PLATFORM-003 every service emits structured JSON logs with a correlation id
    that crosses process boundaries, exposes Prometheus metrics on a separate
    authenticated listener, and answers `/livez` and `/readyz`; Prometheus,
    Alertmanager and Grafana ship as a compose profile with eight dashboards,
    31 alerts and a runbook per alert. See
    [docs/observability.md](docs/observability.md). What is still missing is
    **per-sandbox resource metrics** (they need a collector inside `sandboxd`,
    because cAdvisor would need the Docker socket), **distributed tracing**, and
    **any database backup or restore procedure** — the last is stated plainly in
    [RB-02](docs/runbooks/RB-02-database.md) rather than implied.

---

## Known limitations

Beyond the security items above:

- `LAB_PROVIDER` selects the Kubernetes-track substrate and `kind` is the only
  one implemented; the factory rejects anything else. Every non-Kubernetes
  track, the Docker one included, is configured separately in the API's
  provider composition root.
- **The Docker track needs a host that permits a privileged container**, and is
  off unless `DOCKER_TRACK_ENABLED=true` — see
  [The Docker track](#the-docker-track) and
  [Docker sandbox strategy](#docker-sandbox-strategy). Where it cannot run, the
  ten Docker labs still appear in the catalog and say why they cannot start.
- **The AWS track is architecture only.** No credential, role, or resource is
  ever created — see
  [Future AWS provider architecture](#future-aws-provider-architecture). There
  is **no AWS integration test**, and a mocked one would only prove the mock
  returns what it was told to.
- **The container tracks need the services on your host**, because the compose
  stack gives no container access to a container runtime. See
  [Local development requirements](#local-development-requirements).
- **Container reset replaces the sandbox**, so a student's shell is
  disconnected and reattached. The UI does that automatically; it is still a
  visible blink, and it is a deliberate trade against leaving half a student's
  state behind.
- **The Terraform provider mirror is a fixed set** — `hashicorp/local` and
  `hashicorp/random`. A lab needing another provider needs it added to the
  image, which is deliberate but does mean a content change can require an
  image rebuild.
- **A sandbox container has no persistent storage.** Everything the student
  does lives in the container's writable layer and is gone when the session
  ends, is reset, or expires. That is the intent: what a student *did* is
  remembered — see [Persistent progress](#persistent-progress) — but the
  environment they did it in is not.
- **LINUX-005 teaches supervision with `runit`, not systemd.** A container does
  not run systemd and the image does not pretend otherwise — there is no fake
  `systemctl`. The concepts transfer; the exact commands do not, and the lab
  text says so rather than hiding it.
- **The Linux sandbox is deliberately less locked down than the Terraform
  one.** It adds back a narrow capability set and allows `sudo`, because a lab
  about `useradd` cannot be taught otherwise. The boundary is the container, not
  the account inside it — see
  [`linux-provider.ts`](services/lab-orchestrator/src/providers/linux-provider.ts)
  for exactly what is granted and what is not.
- **Sandbox capacity is bounded by one host.** `MAX_ACTIVE_SESSIONS` caps how
  many sessions exist at once; there is no scheduling across hosts and no queue
  past the cap.
- Sandbox session state is in memory. Learning history is not — see
  [Persistent progress](#persistent-progress) — but a restart still costs a
  student their running environment.
- **Progress is per development student, and there is no way to be a different
  one from the UI.** The dashboard shows whoever the server says you are.
  Multi-student testing needs `DEV_STUDENT_HEADER_ENABLED=true` and a header,
  which is a development affordance and not a feature.
- **Nothing acts on progress yet.** Prerequisites are still not gated,
  completion earns no certificate, and no instructor can see anyone's history —
  there is no instructor surface at all. `prerequisitesEnforced: false` is still
  served explicitly.
- **Attempts are never deleted or aged out.** There is no retention policy, no
  archival, and no `GET /api/me/attempts` pagination beyond a capped `limit`.
  For a laptop and a classroom that is fine; a real deployment needs a data
  retention decision, and it is a privacy question, not a storage one.
- **The attempt count includes starts that never produced an environment.** A
  provider outage or a full platform records a `FAILED` attempt, which is honest
  history but does mean "attempts" is not the same number as "labs worked on".
- **Hints revealed before a lab is started are not recorded**, because there is
  no attempt to record them against.
- The capacity guard has no queue. Past `MAX_ACTIVE_SESSIONS` a student is told
  to try again shortly.
- Lab definitions are read once at API startup; adding a lab needs a restart.
- The reset purge covers a fixed set of namespaced kinds (listed in `lab.yaml`).
  CRDs and cluster-scoped objects are not purged — though for End Lab this is
  moot, since deleting the namespace removes everything inside it.
- `kubectl get nodes` is Forbidden for students by design; see
  [Multi-student architecture](#multi-student-architecture).
- Verification supports the requirement types in
  [`requirements.ts`](services/lab-orchestrator/src/requirements.ts). Richer
  labs will need more.
- **Prerequisites, skills and certification metadata are not acted on.** They
  are declared, validated and displayed; nothing gates a lab, scores a skill,
  or computes exam readiness, because there are no user accounts and no stored
  progress yet. `prerequisitesEnforced: false` is served explicitly so no
  client mistakes display for enforcement.
- **Hint usage is recorded, but nothing uses it.** Since PLATFORM-005 each
  reveal is stored once per (attempt, hint); no scoring, difficulty adjustment
  or instructor view reads it yet.
- **Thirty-one labs are a foundation, not exam readiness.** The `certification`
  metadata records that a lab is *relevant* to CKA, LFCS, DCA, or the Terraform
  Associate exam, and which domain it touches. It does not claim, and must not
  be presented as claiming, that completing these labs prepares anyone for any
  of them.
- **Four tracks exist, and they are not the same size.** Kubernetes, Linux, and
  Docker are ten labs each; Terraform is one, and is a proof that the multi-track
  engine works end to end rather than a full curriculum. TF-001 does not make
  anyone competent at Terraform and must not be presented as doing so.
- The track machinery is generic — a new `labs/<track>/` directory with valid
  lab definitions appears in the catalog with no frontend work — but each track
  still needs a provider and, most likely, a requirement family.
- The Docker track is gated by `DOCKER_TRACK_ENABLED` and by whether the API can
  reach a host Docker daemon. When it cannot run, all ten Docker labs still
  appear in the catalog and report the real reason rather than disappearing.
- K8S-007 checks the CronJob's configured schedule rather than waiting for a
  firing, so that correct work is not left unmarked for five minutes.
- Lab images are pulled from Docker Hub. `nginx:stable` is pre-pulled into the
  kind node, so the shipped labs start quickly; a lab choosing another image
  needs working internet egress from the cluster.
- The end-to-end terminal integration suite needs a working `node-pty` and
  therefore Node 22; it skips itself with an explanatory message on newer Node.
- Single-architecture testing: developed and verified on macOS arm64 with
  Docker Desktop. The images build for amd64 and arm64 but only arm64 was run.
  The sandbox images select their architecture at build time from
  `dpkg --print-architecture`, so they are built per machine rather than pulled.

Docker track specifically:

- **`--privileged` on the sandbox is not a hardened boundary.** It isolates
  students from each other; it does not stop a determined attacker who escapes a
  container inside their own sandbox from reaching the host kernel. Production
  wants a VM per sandbox (Firecracker, Kata, or a per-tenant node) — a provider
  swap, not a rewrite. See
  [Docker sandbox security](#docker-sandbox-security).
- **The `api` service mounts the host Docker socket**, which is equivalent to
  root on that host. Acceptable for a development stack, a real constraint for
  deployment. `DOCKER_TRACK_ENABLED=false` removes the need for it entirely.
- **`DOCKER_SANDBOX_MAX_CONTAINERS` is advisory, not enforced.** Docker has no
  per-daemon container cap; memory and pids are what bind.
- **Terminal workspace separation is by unguessability**, not kernel
  enforcement: every student shell runs as the same OS user, and the per-session
  directory is named by an HMAC with the root left traversable but not listable.
- Docker labs pull their base images inside each sandbox, so a session's first
  start needs working egress unless `DOCKER_SANDBOX_REGISTRY_MIRROR` is set. The
  images are small (`nginx:1.27-alpine`, `alpine`, `busybox`) but they are not
  pre-seeded into sandbox volumes.
- A sandbox's data volume is created per session and destroyed with it. There is
  no image-layer sharing between sessions, so ten concurrent Docker sessions pull
  the same base image ten times. A registry mirror is the intended answer.
- `docker compose` runs client-side, so the Compose plugin is installed in the
  **terminal** image at a pinned version. DOCKER-008 depends on it; a deployment
  that swaps the terminal image has to keep it.
- The terminal image ships the Docker CLI without BuildKit/buildx, so
  `docker build` uses the classic builder. DOCKER-004 is written and verified
  against that; BuildKit-only Dockerfile syntax would not work.

---

## Future AWS architecture

Sketch for when this leaves the laptop. Nothing here is built yet.

```text
                        Route 53 + ACM
                              │
                     CloudFront (web SPA from S3)
                              │
                    ALB  ──────────────── WAF
                     │                     │
        ┌────────────┴─────────┐   ┌───────┴────────────┐
        │ api          (ECS)   │   │ terminal    (ECS)  │
        │ Fargate, autoscaled  │   │ sticky WS sessions │
        └──────────┬───────────┘   └─────────┬──────────┘
                   │                         │
        ┌──────────▼──────────┐              │
        │ RDS PostgreSQL      │              │
        │ users, attempts,    │              │
        │ sessions, timers    │              │
        └──────────┬──────────┘              │
                   │                         │
        ┌──────────▼─────────────────────────▼──────────┐
        │ lab-orchestrator                              │
        │   EksLabProvider implements LabProvider       │
        └──────────────────────┬────────────────────────┘
                               │
        ┌──────────────────────▼────────────────────────┐
        │ EKS — student sandboxes                       │
        │  · namespace per session + scoped RBAC        │
        │  · ResourceQuota, LimitRange, NetworkPolicy   │
        │  · Karpenter for burst capacity               │
        │  · gVisor / Firecracker runtime class         │
        │  · TTL controller reaps abandoned sandboxes   │
        └───────────────────────────────────────────────┘
```

Migration path, in order of what unblocks what:

1. ~~**Isolation first.**~~ Done in PLATFORM-002, locally: namespace per
   session, scoped RBAC, quota, LimitRange, NetworkPolicy, and a reaper. An
   `EksLabProvider` now means implementing one interface — the API, the
   verifier, the session manager, and the frontend do not change.
2. **Persistence.** Implement `SessionStore` against RDS; add attempts and
   progress, and move the capacity reservation into a transaction so it holds
   across API instances.
3. **Identity.** Cognito or an OIDC provider in front of the API. Session
   possession stops being the authorization mechanism; the terminal token
   becomes a claim exchange rather than a bare capability.
4. **Sandbox hardening.** gVisor or Firecracker runtime class, seccomp profiles,
   egress restrictions, per-session PID/memory limits — the layer namespace
   isolation cannot provide.
5. **Operations.** OpenTelemetry traces through api → orchestrator → terminal,
   dashboards for sessions-in-flight and reaper outcomes, and cost attribution
   per lab session.

The point of the `LabProvider` interface is that step 1 did not require
rewriting the API, the verifier, or the frontend — and step 2 will not either.

---

## Future AWS provider architecture

Distinct from the section above, which is about running *this platform* on AWS.
This one is about the **AWS track**: labs where the student uses AWS itself.

**Nothing here is built, and that is the point of writing it down now.**
`AwsLabProvider` exists, implements the same contract as every other provider,
refuses every lifecycle call with `PROVIDER_UNAVAILABLE`, and is registered
disabled. No student ever receives a credential, and no configuration flag
changes that.

```text
   Student
      ↓
   AWS lab session
      ↓
   sts:AssumeRole  →  temporary scoped credentials (minutes, not hours)
      ↓
   dedicated per-lab IAM role + permission boundary
      ↓
   allowed services only, allowed regions only
      ↓
   every created resource tagged with the session
      ↓
   budget / cost guard
      ↓
   automatic cleanup by tag
```

### Ownership tagging

Cleanup can only be exact if creation is. Every resource an AWS lab creates must
carry — and the permission boundary must *require* — these tags:

```text
   jumptotech.io/session-id     the session that owns the resource
   jumptotech.io/lab-id         which lab created it
   jumptotech.io/student-id     reserved; arrives with authentication
```

`aws:RequestTag` conditions in the boundary make an untagged create *fail*, and
`aws:ResourceTag` conditions scope every mutating action to the session's own
resources. That is the AWS analogue of the namespace label gate the Kubernetes
provider already enforces, and it buys the same property: cleanup can prove
ownership from the resource itself rather than from a record that might be
stale.

### The credential contract

```ts
interface AwsSessionCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
  expiresAt: string     // ISO-8601, never longer than the lab session
  region: string
  roleArn: string       // the assumed role, for auditing
}
```

Three rules, all of which the platform already keeps for Kubernetes:

1. credentials are minted per session and expire with it;
2. they never reach the browser — the terminal service fetches them over the
   internal, service-authenticated route, exactly as it does a kubeconfig today;
3. they are never logged and never returned by a public endpoint.

### Cost guard

A permission boundary that allows `ec2:RunInstances` allows a student to spend
money. So the boundary pins instance types, forbids anything with an hourly
floor a lab does not need (NAT gateways, provisioned IOPS, dedicated hosts), and
each account carries an AWS Budgets action that revokes the lab role when a
threshold is crossed. The reaper deletes by tag on the session's deadline; the
budget action is the backstop for whatever outlives it.

### What is deliberately not decided yet

Whether sessions share one account with tag-scoped roles or get accounts from an
Organizations pool. The first is cheaper and faster; the second is a real
blast-radius boundary. That choice needs the numbers a running platform
produces, and guessing it now would bake an assumption into the session model.
The provider contract does not depend on the answer.
