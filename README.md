# JumpToTech Labs

Interactive DevOps practice environments in the browser.

**Story PLATFORM-001 — the lab engine MVP.** A student opens the site, launches a
disposable Kubernetes environment, runs real `kubectl` commands in a browser
terminal, and has their work verified against live cluster state.

Nothing in this repository simulates a terminal or hardcodes command output.
The terminal is a real PTY, the cluster is a real Kubernetes cluster, and the
verifier reads the real Kubernetes API.

---

## Contents

- [What is in scope](#what-is-in-scope)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Running locally](#running-locally)
- [Starting K8S-001](#starting-k8s-001)
- [Testing the terminal](#testing-the-terminal)
- [Testing the verifier](#testing-the-verifier)
- [Resetting the lab](#resetting-the-lab)
- [Lab definitions](#lab-definitions)
- [API reference](#api-reference)
- [Automated tests](#automated-tests)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Known limitations](#known-limitations)
- [Future AWS architecture](#future-aws-architecture)

---

## What is in scope

In scope for PLATFORM-001:

- One lab: **K8S-001 — Create Your First Pod**
- Real `kind` Kubernetes sandbox
- Browser terminal over WebSocket, backed by a real PTY
- State-based verification (`Check Solution`)
- Namespace reset (`Reset Lab`)
- Frontend-only 30-minute timer

Deliberately **not** in scope: authentication, payments, AI, AWS, PostgreSQL,
the JumpToBank application. The architecture is PostgreSQL-ready
(see [`apps/api/src/session-store.ts`](apps/api/src/session-store.ts)), but no
database runs.

---

## Architecture

```text
┌──────────────────────────────────────────────────────────────────────────┐
│  Browser                                                                 │
│  ┌────────────────────────────┐   ┌──────────────────────────────────┐   │
│  │ apps/web  (React + Vite)   │   │ xterm.js                         │   │
│  │  catalog · lab brief · UI  │   │  keystrokes ⇄ bytes              │   │
│  └────────────┬───────────────┘   └───────────────┬──────────────────┘   │
└───────────────│───────────────────────────────────│──────────────────────┘
                │ REST (JSON)                       │ WebSocket (JSON frames)
                │ :4000                             │ :4001
┌───────────────▼───────────────────┐   ┌───────────▼──────────────────────┐
│ apps/api                          │   │ services/terminal                │
│  · GET/POST /api/labs/…           │   │  · verifies session token        │
│  · validates lab ids              │   │  · spawns ONE real PTY (bash)    │
│  · mints terminal session tokens  │──▶│  · no REST, no lab logic         │
│  · NEVER executes student input   │HMAC└───────────┬──────────────────────┘
└───────┬───────────────┬───────────┘               │ kubectl
        │               │                           │
        │               │                           │
┌───────▼──────────┐ ┌──▼──────────────────┐        │
│ services/        │ │ services/verifier   │        │
│ lab-orchestrator │ │  reads live state,  │        │
│  LabProvider     │ │  not command history│        │
│  ├ create()      │ └──┬──────────────────┘        │
│  ├ status()      │    │                           │
│  ├ reset()       │    │                           │
│  ├ destroy()     │    │                           │
│  └ execute()     │    │                           │
└───────┬──────────┘    │                           │
        │               │                           │
        └───────────────┴───────────────────────────┘
                        │ Kubernetes API
                        ▼
        ┌───────────────────────────────────────────┐
        │ kind cluster  "jumptotech-labs"           │
        │  control-plane node · namespace: default  │
        └───────────────────────────────────────────┘
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
  create(ctx):  Promise<CreateResult>   // create or initialise the sandbox
  status(ctx):  Promise<EnvironmentInfo>
  reset(ctx):   Promise<ResetResult>
  destroy(ctx): Promise<{ ok, error? }>
  execute(ctx, req): Promise<ExecResult> // allow-listed binaries, internal only
}
```

**The kind cluster is the substrate, not the sandbox.** Creating a kind cluster
requires the Docker socket. Rather than hand that capability to a web-facing
process, the cluster is provisioned once on the host by `npm run cluster:up`,
and `create()` initialises the lab's *namespace* to a known baseline. That is
real work — it is idempotent, it clears leftovers from a previous attempt, and
it waits for terminating Pods to actually go away.

**Verification is state-based.** The verifier never inspects what the student
typed. It reads `spec` and `status` from the Kubernetes API. Solving the lab
with `kubectl run`, with `kubectl apply -f`, or with a manifest piped from
`heredoc` all pass identically — because all three produce the same desired
state.

**Terminal execution is separated from the API.** No REST endpoint runs a
shell. The terminal is a distinct service, on a distinct port, in a distinct
container, running as a distinct user, and it refuses to spawn a PTY without an
HMAC-signed session token minted by `POST /api/labs/:id/start`.

### Directory tree

```text
jumptotech-labs/
├── apps/
│   ├── api/                        REST API (Express + TypeScript)
│   │   ├── src/
│   │   │   ├── app.ts              express app assembly
│   │   │   ├── config.ts           env parsing + validation
│   │   │   ├── http.ts             structured JSON envelope
│   │   │   ├── index.ts            composition root
│   │   │   ├── routes/labs.ts      the lab endpoints
│   │   │   └── session-store.ts    LabSessionStore (PostgreSQL-ready)
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
│   │   │   ├── lab-definition.ts   lab.yaml schema + parser (zod)
│   │   │   ├── lab-registry.ts     lab discovery
│   │   │   ├── providers/
│   │   │   │   ├── factory.ts      provider selection
│   │   │   │   └── kind-provider.ts KindLabProvider implements LabProvider
│   │   │   ├── session-token.ts    HMAC terminal session tokens
│   │   │   ├── types.ts            LabProvider + result contracts
│   │   │   └── validation.ts       lab id allow-list
│   │   └── test/                   unit + live-cluster integration tests
│   ├── terminal/                   WebSocket → PTY gateway
│   │   ├── src/{config,index,protocol,server}.ts
│   │   └── test/protocol.test.ts
│   └── verifier/                   state-based verification
│       ├── src/index.ts
│       └── test/verifier.test.ts
│
├── labs/
│   └── kubernetes/
│       └── k8s-001-pods/
│           └── lab.yaml            single source of truth for the lab
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

---

## Testing the terminal

Click into the terminal pane and run real commands:

```bash
kubectl get nodes
kubectl get pods
kubectl get namespaces
kubectl run nginx --image=nginx:stable
kubectl describe pod nginx
kubectl delete pod nginx
```

`kubectl get nodes` returns the actual control-plane node of your kind cluster:

```text
NAME                            STATUS   ROLES           AGE   VERSION
jumptotech-labs-control-plane   Ready    control-plane   12m   v1.34.0
```

To prove it is not simulated, create something from the host and watch it appear
in the browser terminal:

```bash
KUBECONFIG=infrastructure/kind/generated/kubeconfig-host.yaml \
  kubectl run proof --image=nginx:stable
```

Then run `kubectl get pods` in the browser — `proof` is there.

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
✓ Namespace is correct
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
✓ Namespace is correct
✗ Incorrect image — found 'nginx:1.25', expected 'nginx:stable'
✓ Pod is Running
✓ Container is Ready

LAB NOT COMPLETE
```

Or delete the Pod entirely and every check fails with
`No Pod named 'nginx' found in namespace 'default'`.

The verifier reads the Kubernetes API directly. It does not look at your shell
history, so there is no way to "type the right command" past a broken
environment — and equally, any method that produces the correct state passes.

---

## Resetting the lab

Click **Reset Lab**. It:

1. Deletes the resources the student created in the lab namespace
   (Pods, Deployments, ReplicaSets, StatefulSets, DaemonSets, Jobs, CronJobs,
   Services, ConfigMaps), skipping the cluster-managed `default/kubernetes`
   Service and `kube-root-ca.crt` ConfigMap
2. Waits for Pods to finish terminating
3. Re-checks cluster health
4. Clears the terminal scrollback
5. Reports `Lab reset successfully.` plus exactly what was removed

The lab can then be attempted again from a clean namespace, as many times as you
like.

---

## Lab definitions

Lab content lives in YAML, never in React:

```text
labs/kubernetes/k8s-001-pods/lab.yaml
```

The API parses and validates it at startup
([`lab-definition.ts`](services/lab-orchestrator/src/lab-definition.ts)) and
serves it to the frontend. The task text, requirements list, hint,
documentation links, verification checks, and reset policy all come from that
file. Changing the image from `nginx:stable` to something else is a one-line
edit that updates the UI copy *and* the verifier together.

Adding a lab: create `labs/<track>/<slug>/lab.yaml` with a unique `id` matching
`TRACK-NNN`, where the directory name equals `slug`. It appears in the catalog on
the next API restart.

The Kubernetes content is written from the official documentation:

- <https://kubernetes.io/docs/concepts/workloads/pods/>
- <https://kubernetes.io/docs/reference/kubectl/>

No content is taken from third-party training platforms.

---

## API reference

All responses use a structured envelope:

```jsonc
{ "ok": true,  "data": { /* … */ } }
{ "ok": false, "error": { "code": "…", "message": "…", "remediation": "…" } }
```

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | service status, labs loaded |
| `GET` | `/api/labs` | list labs and tracks |
| `GET` | `/api/labs/:id` | full lab definition for the UI |
| `POST` | `/api/labs/:id/start` | create/initialise the sandbox; returns steps + terminal token |
| `GET` | `/api/labs/:id/status` | environment health and current session |
| `POST` | `/api/labs/:id/check` | run the verifier against live cluster state |
| `POST` | `/api/labs/:id/reset` | restore the lab baseline |
| `DELETE` | `/api/labs/:id/environment` | release the sandbox |

Notes:

- A failing lab is a *successful* check: `200` with `"passed": false`. `503` is
  reserved for "the cluster could not be read at all".
- `:id` is validated against `^[A-Z][A-Z0-9]{1,9}-\d{3}$` before it touches the
  filesystem or Kubernetes. Anything else returns `400 INVALID_LAB_ID`.
- **There is no endpoint that executes commands.** Shell access exists only
  through the terminal WebSocket, and only with a valid session token.

Try it:

```bash
curl -s localhost:4000/api/labs | jq
curl -s localhost:4000/api/labs/K8S-001 | jq '.data.target'
curl -s -X POST localhost:4000/api/labs/K8S-001/check | jq '.data.summary'
```

---

## Automated tests

```bash
npm test                 # unit tests, no cluster required
npm run typecheck        # tsc --noEmit across all workspaces
```

Integration tests against a real kind cluster:

```bash
npm run cluster:up
RUN_INTEGRATION_TESTS=1 \
KUBECONFIG="$PWD/infrastructure/kind/generated/kubeconfig-host.yaml" \
  npx vitest run test/integration.test.ts --root services/lab-orchestrator
```

Coverage of the seven required areas:

| # | Requirement | Where |
|---|---|---|
| 1 | Lab YAML loading | `services/lab-orchestrator/test/lab-definition.test.ts` |
| 2 | Lab ID validation | `services/lab-orchestrator/test/validation.test.ts` |
| 3 | Kubernetes environment health | `kind-provider.test.ts` + `integration.test.ts` |
| 4 | Verifier — Pod does not exist | `services/verifier/test/verifier.test.ts` |
| 5 | Verifier — wrong image | `services/verifier/test/verifier.test.ts` |
| 6 | Verifier — correct Pod | `verifier.test.ts` + `integration.test.ts` |
| 7 | Reset functionality | `kind-provider.test.ts` + `integration.test.ts` |

Plus: session-token forgery/expiry, terminal protocol fuzzing, API routing and
error shape, and a check that no command-execution endpoint exists.

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
The terminal container is not on the `kind` network, or the mounted kubeconfig
is stale. `docker compose up -d --force-recreate terminal`.

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

---

## Security

This will eventually run untrusted student commands, so the boundaries are
drawn from the start.

**What is enforced today**

- *No process runs as root.* The api image runs as `node`; the terminal image
  runs as a dedicated `student` user (uid 1001) that owns nothing in `/app`.
  Both containers set `no-new-privileges` and drop all Linux capabilities.
- *The Docker socket is never mounted.* Not into any container, and certainly
  not reachable from the browser. Cluster creation happens on the host in
  `scripts/cluster-up.sh`, outside every web-facing process.
- *No shell over REST.* No API endpoint executes student input. The provider's
  internal `execute()` accepts only allow-listed binaries (`kubectl`), takes an
  explicit `argv` array, and runs with `shell: false`, so argument content can
  never become shell syntax.
- *Terminal sessions are separated from the API* — different process, port,
  container, and user — and require an HMAC-SHA256 session token minted by
  `POST /api/labs/:id/start`. Tokens are short-lived, bound to a lab and
  namespace, verified with a constant-time comparison, and sent in the first
  WebSocket frame rather than in a URL (so they stay out of access logs).
- *Lab ids are allow-listed* against `^[A-Z][A-Z0-9]{1,9}-\d{3}$` before being
  used for any filesystem or Kubernetes operation. Traversal, separators, null
  bytes, and shell metacharacters are rejected with `400`.
- *No arbitrary host filesystem access.* The api container is `read_only` with a
  tmpfs `/tmp`. The only host paths mounted anywhere are the generated
  kubeconfig and the `labs/` directory, both read-only. The student's `$HOME` is
  a 64 MB tmpfs that vanishes with the container.
- *Resource bounds.* The terminal container is capped at 512 MB and 256 PIDs;
  the gateway caps concurrent PTYs, frame size, and input size, and kills
  sessions on idle and absolute timeouts.
- *WebSocket origin checking* and a CORS allow-list, both from
  `ALLOWED_ORIGINS`.
- *Errors do not leak internals.* The API returns structured codes; stack traces
  stay in the server log.

**MVP limitations — do not deploy this as-is**

1. **No authentication.** Anyone who can reach the ports can start a lab, open a
   terminal, and use the cluster. Out of scope for Story 1; the session-token
   plumbing is the hook a real auth story will build on.
2. **One shared cluster, one shared namespace.** Every visitor works in
   `default` on the same kind cluster. There is no per-student isolation, so
   concurrent students would see each other's Pods and reset each other's work.
   Real isolation (namespace-per-session with RBAC, then cluster-per-session)
   is the next boundary to add.
3. **The kubeconfig is cluster-admin.** The terminal has full control of the
   lab cluster. There is no RBAC scoping, no quota, and no `NetworkPolicy`, so a
   student could create workloads outside `default` or exhaust the node.
4. **The student shell is a normal shell.** It runs as an unprivileged user in a
   container with no host mounts, but it is not a sandbox: there is no seccomp
   profile beyond Docker's default, no gVisor/Firecracker layer, and outbound
   network access is unrestricted.
5. **Session state is in memory.** Restarting the API forgets active sessions.
6. **The timer is frontend-only** and trivially bypassed. It is a pacing aid,
   not an exam control.
7. **Development kubeconfigs are written to disk** at
   `infrastructure/kind/generated/` with mode 644 so the containers' non-root
   users can read them. They are git-ignored and belong to a throwaway local
   cluster; treat them as credentials anyway.
8. **The web container runs the Vite dev server**, which is not a production
   server.
9. **TLS is not configured.** Everything is plain HTTP/WS on localhost.

---

## Known limitations

Beyond the security items above:

- Only `LAB_PROVIDER=kind` is implemented. The factory rejects anything else.
- `destroy()` reverts the namespace rather than deleting the kind cluster,
  because deleting the substrate needs the Docker socket. Use
  `npm run cluster:down` for that.
- Lab definitions are read once at API startup; adding a lab needs a restart.
- The reset purge covers a fixed set of namespaced kinds (listed in `lab.yaml`).
  CRDs and cluster-scoped objects are not purged.
- No persistence: no PostgreSQL, no progress tracking, no attempt history.
- Verification supports the five check types K8S-001 needs
  (`pod_exists`, `pod_namespace`, `container_image`, `pod_phase`,
  `container_ready`). Richer labs will need more.
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

1. **Isolation first.** `EksLabProvider` creating a namespace per session with
   scoped RBAC, quotas, and NetworkPolicy. This is the change that makes
   multi-tenancy safe, and it touches exactly one file plus the factory.
2. **Persistence.** Implement `LabSessionStore` against RDS; add attempts and
   progress. Server-side timers become possible here.
3. **Identity.** Cognito or an OIDC provider in front of the API; the terminal
   session token becomes a claim exchange rather than a bare HMAC.
4. **Sandbox hardening.** gVisor or Firecracker runtime class, seccomp profiles,
   egress restrictions, per-session PID/memory limits.
5. **Operations.** OpenTelemetry traces through api → orchestrator → terminal,
   CloudWatch dashboards, a TTL reaper for abandoned sandboxes, and cost
   attribution per lab session.

The point of the `LabProvider` interface is that step 1 does not require
rewriting the API, the verifier, or the frontend.
