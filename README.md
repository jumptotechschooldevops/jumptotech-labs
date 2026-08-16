# JumpToTech Labs

Interactive DevOps practice environments in the browser.

A student opens the site, launches a disposable Kubernetes environment, runs
real `kubectl` commands in a browser terminal, and has their work verified
against live cluster state.

Nothing in this repository simulates a terminal or hardcodes command output.
The terminal is a real PTY, the cluster is a real Kubernetes cluster, and the
verifier reads the real Kubernetes API.

**PLATFORM-001** built that loop. **PLATFORM-002** made it safe for more than
one student at a time: every lab session now gets its own namespace, its own
ServiceAccount, its own RBAC, its own quota, and its own network policy, and it
is cleaned up automatically when the student finishes or walks away.

**PLATFORM-003** turned one lab into a catalog. There are now ten Kubernetes
labs, and the application contains no code that knows about any of them:
adding a lab means adding a `lab.yaml`, and nothing else. See
[The lab catalog](#the-lab-catalog).

---

## Contents

- [What is in scope](#what-is-in-scope)
- [Architecture](#architecture)
- [The lab catalog](#the-lab-catalog)
- [Multi-student architecture](#multi-student-architecture)
- [Session lifecycle](#session-lifecycle)
- [Cost model](#cost-model)
- [Requirements](#requirements)
- [Installation](#installation)
- [Running locally](#running-locally)
- [Starting K8S-001](#starting-k8s-001)
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

Deliberately **not** in scope: authentication, payments, AI, AWS, PostgreSQL,
the JumpToBank application. Session state is still in memory; the store is
behind an interface so a PostgreSQL implementation is a one-file change.
Prerequisites and skills are **metadata only** — there are no user accounts and
no stored progress, so nothing is enforced per student, and the API says so
explicitly (`prerequisitesEnforced: false`).

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

### Key design decisions

**`LabProvider` is the seam.** Everything above it — API routes, verifier,
React — is unaware that `kind` exists. Adding an EKS or Firecracker backend
means implementing one interface
([`services/lab-orchestrator/src/types.ts`](services/lab-orchestrator/src/types.ts))
and adding a case to the factory. No caller changes.

```ts
interface LabProvider {
  create(ctx):  Promise<CreateResult>       // namespace + guardrails + initial state
  status(ctx):  Promise<EnvironmentInfo>
  reset(ctx):   Promise<ResetResult>
  destroy(ctx): Promise<DestroyResult>      // and confirm the namespace is gone
  execute(ctx, req): Promise<ExecResult>    // allow-listed binaries, internal only
  issueCredentials(ctx): Promise<StudentCredentials>   // namespace-scoped only
  listManagedNamespaces(): Promise<ManagedNamespace[]> // for the reaper
  destroyNamespace(ns, sessionId?): Promise<DestroyResult>
}
```

**The unit of isolation is a session, not a lab.** Two students on the same lab
get two namespaces. Nothing above the provider ever names a namespace: the API,
the verifier, and the terminal all work from a session id and look the
namespace up server-side.

**The kind cluster is the substrate, not the sandbox.** Creating a kind cluster
requires the Docker socket. Rather than hand that capability to a web-facing
process, the cluster is provisioned once on the host by `npm run cluster:up`,
and `create()` builds one namespace inside it — quota, limits, network policy,
ServiceAccount, RBAC, then the lab's initial state.

**Verification is state-based.** The verifier never inspects what the student
typed. It reads `spec` and `status` from the Kubernetes API. Solving the lab
with `kubectl run`, with `kubectl apply -f`, or with a manifest piped from
`heredoc` all pass identically — because all three produce the same desired
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
│       │   ├── pages/{CatalogPage,LabPage}.tsx
│       │   └── styles.css
│       └── vite.config.ts
│
├── services/
│   ├── lab-orchestrator/           lab lifecycle + Kubernetes access
│   │   ├── src/
│   │   │   ├── k8s/client.ts       @kubernetes/client-node adapter
│   │   │   ├── k8s/port.ts         KubernetesPort interface (testable seam)
│   │   │   ├── k8s/labels.ts       ownership labels + the cleanup-safety gate
│   │   │   ├── k8s/student-kubeconfig.ts  namespace-scoped kubeconfig builder
│   │   │   ├── session/
│   │   │   │   ├── identifiers.ts  session ids + namespace derivation
│   │   │   │   ├── isolation.ts    quota / limits / netpol / RBAC manifests
│   │   │   │   ├── manager.ts      SessionManager — the state machine
│   │   │   │   ├── manifests.ts    setup-manifest loading + kind allow-list
│   │   │   │   ├── reaper.ts       SessionReaper — automatic cleanup
│   │   │   │   ├── store.ts        SessionStore (PostgreSQL-ready)
│   │   │   │   └── types.ts        session record, statuses, policy
│   │   │   ├── lab-definition.ts   lab.yaml schema + parser (zod)
│   │   │   ├── lab-registry.ts     lab discovery
│   │   │   ├── requirements.ts     closed vocabulary of check types
│   │   │   ├── providers/
│   │   │   │   ├── factory.ts      provider selection
│   │   │   │   └── kind-provider.ts KindLabProvider implements LabProvider
│   │   │   ├── session-token.ts    HMAC terminal session tokens
│   │   │   ├── types.ts            LabProvider + result contracts
│   │   │   └── validation.ts       lab id allow-list
│   │   └── test/                   unit + live-cluster integration tests
│   ├── terminal/                   WebSocket → PTY gateway
│   │   ├── src/
│   │   │   ├── credentials.ts      per-session kubeconfig fetch + storage
│   │   │   └── {config,index,protocol,server}.ts
│   │   └── test/                   protocol, credentials, live-cluster E2E
│   └── verifier/                   state-based verification
│       ├── src/
│       │   ├── handlers/           one handler per requirement type
│       │   └── {index,registry,reader,contract,image,quantity}.ts
│       └── test/verifier.test.ts
│
├── labs/                           the catalog — data, not code
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
│
├── infrastructure/
│   ├── docker/
│   │   ├── api.Dockerfile
│   │   ├── terminal.Dockerfile
│   │   └── web.Dockerfile
│   └── kind/
│       ├── cluster.yaml
│       └── generated/              kubeconfigs (git-ignored)
│
├── scripts/
│   ├── cluster-up.sh
│   ├── cluster-down.sh
│   └── cluster-status.sh
│
├── docker-compose.yml
├── Makefile                        convenience wrappers (make help)
├── .env.example
├── .gitignore
└── README.md
```

---

## The lab catalog

```text
                          JumpToTech Labs
                                 │
                            Lab Catalog                  labs/**/lab.yaml
                                 │                       discovered at startup
                    ┌────────────┴────────────┐
                    │                         │
               Kubernetes                Future tracks
                    │
   ┌────────┬───────┼───────┬────────┬─────── … ────────┐
K8S-001  K8S-002  K8S-003  K8S-004  K8S-005          K8S-010
   └────────┴───────┴───────┴────────┴─────── … ────────┘
                                 │
                       Generic Lab Engine          no lab-specific code
                    setup · verify · reset · hints
                                 │
                          Session Manager
                                 │
                     PLATFORM-002 isolation          namespace per session
                                 │
                        Kubernetes cluster
```

The rule this section exists to state: **adding a lab does not change the
application.** No React component, API route, orchestrator method, or verifier
handler names a lab. `grep -r 'K8S-0' apps/ services/ --include='*.ts*'` finds
only test fixtures.

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

### Prerequisites are advice, not a gate

Prerequisites are declared, validated, resolved to titles, and shown in the UI.
They are **not enforced**, because PLATFORM-003 has no authenticated users and
no stored progress — so there is nothing to enforce them against. Rather than
leave that ambiguous, `GET /api/labs` and `GET /api/labs/:id` both return
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

JumpToTech does **not** create a cluster per student. It creates a namespace.

| Per student, per lab | Cost |
|---|---|
| Kubernetes cluster | none — the cluster is shared |
| Node / VM | none |
| LoadBalancer or public IP | none — pinned to `0` in the quota, not configurable upward |
| NodePort | none — pinned to `0` |
| Database | none |
| Namespace + SA + Role + Binding + Quota + LimitRange + 4 NetworkPolicies | ~9 small API objects |

Browsing the catalog creates nothing at all: no provider method runs until a
student clicks **Start Lab**.

Three things bound the spend: a **ResourceQuota** caps what one session may
consume, **`MAX_ACTIVE_SESSIONS`** caps how many sessions exist at once, and the
**cleanup service** guarantees that an abandoned environment is reclaimed rather
than paid for indefinitely. Cluster-per-student would multiply the control-plane
cost by the number of students for no pedagogical gain — a namespace teaches
`kubectl` exactly as well.

This is the same shape that will run on shared EKS later: the
[`LabProvider`](services/lab-orchestrator/src/types.ts) interface is what lets
an `EksLabProvider` slot in underneath without the API, the verifier, or the
frontend changing.

---

## Requirements

| Tool | Version tested | Why |
|---|---|---|
| Docker | 28.4 (Docker Desktop) | runs the services and the kind node |
| Docker Compose | v2.39 | orchestrates the local stack |
| [kind](https://kind.sigs.k8s.io/) | 0.31.0 | creates the local Kubernetes cluster |
| kubectl | 1.34 | host-side cluster checks |
| Node.js | 22 LTS or 24 | only for running tests / services outside Docker |
| Bash | 3.2+ | the `scripts/` helpers |

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

Two commands, in this order.

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

**2. Start the application:**

```bash
docker compose up --build
```

Then open:

### **http://localhost:3000**

| Service | URL | Purpose |
|---|---|---|
| web | http://localhost:3000 | the UI |
| api | http://localhost:4000/health | REST API |
| terminal | http://localhost:4001/health | WebSocket terminal gateway |

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

npm run dev:api        # :4000
npm run dev:terminal   # :4001  (needs Node 22 for node-pty)
npm run dev:web        # :3000
```

### Shutting down

```bash
docker compose down          # stop the services
npm run cluster:down         # delete the kind cluster
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
memory today, so a restart loses it — but the namespace *labels* survive, and
each one carries its own `jumptotech.io/expires-at`. The reaper reads expiry
from the cluster and reclaims accordingly. A one-minute grace period stops it
reclaiming a namespace that is still being provisioned.

### Cleanup safety

Deleting a namespace is the only irreversible thing this platform does, so four
gates stand in front of every delete, re-read from the API server each time:

1. the name must parse as a `lab-…` sandbox name;
2. it must not be a protected cluster namespace;
3. the live object must carry `jumptotech.io/managed=true`;
4. when a session id is supplied, the namespace's session label must match it.

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
| `GET` | `/health` | service status, labs loaded, lab load errors, session capacity |
| `GET` | `/api/labs` | catalog: lab cards + tracks |
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
objects, the setup manifests, or the reset policy — the expected end state of a
lab is the solution, and for K8S-010 the setup manifest *is* the injected fault.
`GET /api/labs/:labId` serves requirements as their student-facing `label`
strings only. Browsing the catalog also touches no cluster and creates nothing.

### Session operations

Everything that acts on a *running* environment is addressed by session id, not
by lab id — two students on the same lab have two different sandboxes.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/sessions/:sessionId` | status, countdowns, idle warning |
| `POST` | `/api/sessions/:sessionId/check` | run the verifier against this session's namespace |
| `POST` | `/api/sessions/:sessionId/reset` | restore this session's baseline |
| `POST` | `/api/sessions/:sessionId/activity` | record activity ("Continue Lab") |
| `DELETE` | `/api/sessions/:sessionId` | End Lab: delete the namespace, release the slot |

### Internal (service-to-service, not reachable from a browser)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/internal/sessions/:sessionId/credentials` | mint this session's namespace-scoped kubeconfig for the terminal service |

Notes:

- **The namespace is never an input.** No endpoint accepts one. It is looked up
  from the session record on every request, so possessing or guessing a
  namespace name grants nothing at all.
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
`SETUP_FAILED`, `ENVIRONMENT_UNREACHABLE`.

Try it:

```bash
curl -s localhost:4000/api/labs | jq '.data.labs[].id'
curl -s localhost:4000/api/tracks | jq '.data.tracks'
curl -s 'localhost:4000/api/tracks/kubernetes/labs?difficulty=intermediate' \
  | jq '[.data.labs[].id]'

SID=$(curl -s -X POST localhost:4000/api/labs/K8S-001/start | jq -r '.data.session.sessionId')
curl -s "localhost:4000/api/sessions/$SID" | jq '.data.session | {status, secondsRemaining}'
curl -s -X POST "localhost:4000/api/sessions/$SID/check" | jq '.data.summary'
curl -s -X DELETE "localhost:4000/api/sessions/$SID" | jq '.data.message'
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

The end-to-end terminal suite additionally needs a working `node-pty`, which
means Node 22 (see [Requirements](#requirements)). On a host running a newer
Node it skips itself with a message rather than failing:

```bash
RUN_INTEGRATION_TESTS=1 \
KUBECONFIG="$PWD/infrastructure/kind/generated/kubeconfig-host.yaml" \
  npx vitest run test/terminal-integration.test.ts --root services/terminal
```

### Running the catalog tests only

The catalog, schema, setup-engine and verification suites need no cluster:

```bash
npx vitest run test/lab-catalog.test.ts test/setup-engine.test.ts \
  --root services/lab-orchestrator          # catalog + schema + setup engine
npx vitest run --root services/verifier      # every requirement type
npx vitest run --root apps/api               # catalog + track + session APIs
npx vitest run --root apps/web               # catalog UI, lab page, hints
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

The web suite additionally renders the components against **verbatim API
responses** captured in `apps/web/test/fixtures/`, which is what catches a drift
between what the API sends and what the UI expects — hand-written fixtures
would hide exactly that.

Anything that depends on the API server actually *enforcing* something — RBAC
decisions, quota admission, namespace deletion, an image that cannot be pulled,
a Service with no endpoints — is asserted against real kind, never against a
mock. A mock that returned "Forbidden" would prove nothing.

Plus: session-token forgery/expiry/rebinding, terminal protocol fuzzing,
credential file permissions and cleanup, API routing and error shape, and a
check that no command-execution endpoint exists.

---

## Troubleshooting

**`network kind declared as external, but could not be found`**
The kind cluster does not exist yet. Run `npm run cluster:up` first.

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
- *The Docker socket is never mounted.* Cluster creation happens on the host in
  `scripts/cluster-up.sh`, outside every web-facing process.
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
- *Errors do not leak internals.* Structured codes out, stack traces in the log.
  Kubeconfigs and tokens are never logged and never returned to the browser.

**Remaining limitations — do not deploy this as-is**

1. **No authentication.** Anyone who can reach the ports can start a lab.
   Session possession is the only authorization mechanism, and it is an MVP
   stopgap, **not production authentication**. A leaked or shoulder-surfed
   session id grants full control of that session. Real identity is a later
   story; the session id becomes a claim exchange rather than a bare capability.
2. **Namespace isolation is not VM isolation.** Everything shares one kernel and
   one control plane. A container-escape or kernel vulnerability crosses every
   boundary described above. Production needs gVisor or Firecracker, seccomp
   profiles, and per-session PID/memory limits at the runtime level.
3. **NetworkPolicy enforcement depends on the CNI.** The objects are always
   created; whether they are *enforced* is a property of the cluster. Do not
   claim tenant-level network isolation without verifying enforcement on the
   cluster you actually run. `kind` is development infrastructure and is not a
   supported production substrate.
4. **The student shell is a normal shell.** It runs as an unprivileged user in a
   container with no host mounts, but there is no sandbox layer beyond Docker's
   defaults, and outbound network access from the shell itself is unrestricted.
5. **Session state is in memory.** Restarting the API forgets active sessions.
   Namespaces are *not* leaked when that happens — the reaper reclaims them from
   their labels — but the student loses their session handle. PostgreSQL is a
   later story; `SessionStore` is the seam.
6. **The capacity guard is per-process.** `MAX_ACTIVE_SESSIONS` is enforced
   synchronously inside one API instance. Running several instances needs the
   same reservation inside a database transaction.
7. **`kubectl` is available in the terminal container**, and a student can reach
   the API server from it. That is the point of the lab; the RBAC above is what
   bounds it.
8. **Development kubeconfigs are written to disk** at
   `infrastructure/kind/generated/` with mode 644 so the containers' non-root
   users can read them. They are git-ignored and belong to a throwaway local
   cluster; treat them as credentials anyway.
9. **The web container runs the Vite dev server**, which is not a production
   server.
10. **TLS is not configured.** Everything is plain HTTP/WS on localhost, which
    also means the terminal token and the internal service secret travel in
    clear text on the local network.

---

## Known limitations

Beyond the security items above:

- Only `LAB_PROVIDER=kind` is implemented. The factory rejects anything else.
- Session state is in memory; there is no persistence, progress tracking, or
  attempt history.
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
- **Hint usage is not persisted.** `HintPanel` reports each reveal through a
  callback, but nothing stores it; the count resets with the page.
- **Ten labs are a foundation, not CKA readiness.** The `certification`
  metadata records that a lab is *relevant* to CKA and which domain it touches.
  It does not claim, and must not be presented as claiming, that completing
  these ten labs prepares anyone for the exam.
- Only one track (`kubernetes`) exists. The track machinery is generic, but
  nothing else has been written against it.
- K8S-007 checks the CronJob's configured schedule rather than waiting for a
  firing, so that correct work is not left unmarked for five minutes.
- Lab images are pulled from Docker Hub. `nginx:stable` is pre-pulled into the
  kind node, so the shipped labs start quickly; a lab choosing another image
  needs working internet egress from the cluster.
- The end-to-end terminal integration suite needs a working `node-pty` and
  therefore Node 22; it skips itself with an explanatory message on newer Node.
- Single-architecture testing: developed and verified on macOS arm64 with
  Docker Desktop. The images build for amd64 and arm64 but only arm64 was run.

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
