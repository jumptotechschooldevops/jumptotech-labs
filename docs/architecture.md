# Architecture — the short version

What each part of the repository is responsible for, where the boundaries are,
and how the six requests that matter travel through it. This page is a map: each
section links to the document that owns the detail. Every file and symbol named
here exists at the commit this page was last checked against; the
[documentation contract test](../services/observability/test/documentation-contract.test.ts)
fails when a linked file disappears.

Deeper references:

- compose stacks, the runtime broker and ports: [runtime-architecture.md](runtime-architecture.md)
- ownership labels, `RUNTIME_OWNER_ID`, image tags: [runtime-ownership.md](runtime-ownership.md)
- sign-in and identity: [authentication.md](authentication.md)
- which service holds which secret: [secret-boundaries.md](secret-boundaries.md)
- metrics, logs, health: [observability.md](observability.md)
- Kubernetes isolation: [kubernetes-network-security.md](kubernetes-network-security.md), [pod-security.md](pod-security.md)
- providers, catalog, verifier and progress in depth: the [README](../README.md#multi-track-architecture)

---

## 1. The pieces

```text
 browser ──► web (nginx + React bundle) ──┬─ /api, /auth ──► api ──────────┬──► PostgreSQL
                                          │                  │ (library:   │    (progress, sessions,
                                          │                  │  orchestrator│     users, sign-ins)
                                          │                  │  verifier    │
                                          │                  │  progress)   ├──► Kubernetes API (kind)
                                          │                  │              │
                                          │                  └── /internal ─┼──► sandboxd ──► Docker
                                          └─ /terminal ─────► terminal ─────┘      (the only
                                                              (PTY gateway)          socket holder)
```

| Workspace | Package | Runs as | Responsibility | Talks to |
|---|---|---|---|---|
| `apps/web` | `@jumptotech/web` | compose `web` (nginx serving the Vite build) | the student UI; in production also the TLS edge on 443/80 | api and terminal, same origin, through nginx (`infrastructure/docker/nginx/locations.conf`) |
| `apps/api` | `@jumptotech/api` | compose `api`, port 4000 | HTTP API: sign-in, catalog, sessions, Verify, progress, the `/internal` routes the terminal calls, the reaper, the operator socket | PostgreSQL; Kubernetes API; sandboxd over HTTP (`SANDBOX_BROKER_URL`) |
| `services/lab-orchestrator` | `@jumptotech/lab-orchestrator` | library inside the api | lab catalog and schema, provider registry, providers, `SessionManager`, session stores, reaper | — (through the api's process) |
| `services/verifier` | `@jumptotech/verifier` | library inside the api | requirement handlers by family; `verifyLab` | read-only readers scoped to one session |
| `services/progress` | `@jumptotech/progress` | library inside the api, plus `npm run db:migrate` | learning history: students, attempts, progress, hints; migrations | PostgreSQL (`pg`) |
| `services/terminal` | `@jumptotech/terminal` | compose `terminal`, port 4001 | WebSocket PTY gateway at `/terminal` | api `/internal/*`; sandboxd `/v1/attach`; a local `node-pty` shell for Kubernetes labs |
| `services/sandboxd` | `@jumptotech/sandboxd` | compose `sandboxd` (runtime overlay), port 4002, no host port | runtime broker: `/v1/runtime`, `/v1/docker`, `/v1/attach`; the **only** process given the Docker socket | Docker |
| `services/observability` | `@jumptotech/observability` | library in every service | logging, redaction, metrics, the second listener (`/livez`, `/readyz`, `/metrics` on 9400/9401/9402); also most repository-wide contract tests | — |
| `test-support` | `@jumptotech/test-support` | tests only | host-execution guard, strict runner, run-scoped naming | — |
| `e2e` | `@jumptotech/e2e` | tests only | Playwright suite and its own compose stack (`e2e/stack.sh`) | a throwaway stack |

Also in the repository:

- `labs/<track>/<lab>/lab.yaml` — lab content, loaded and validated at api start
  (bind-mounted read-only into the api container). `labs/learning-paths/` holds
  the learning paths. See [development/contributing-labs.md](development/contributing-labs.md).
- `infrastructure/` — Dockerfiles (`infrastructure/docker/`), the kind cluster
  (`infrastructure/kind/`), Prometheus/Alertmanager/Grafana configuration
  (`infrastructure/observability/`), and `infrastructure/secret-distribution.json`,
  which says which service may receive which secret, port and mount.
- `scripts/` — cluster, sandbox-image, database, production-host and validation
  scripts. Which are safe where: [development/getting-started.md §6](development/getting-started.md#6-scripts-and-make-targets-what-is-safe-where).

### Boundaries that are deliberate

- **No browser-reachable service holds a container runtime.** Only `sandboxd`
  mounts the Docker socket, and it is on no published port. The api and the
  terminal reach containers through it by name of operation, never by container
  name ([runtime-architecture.md](runtime-architecture.md)).
- **The terminal holds no cluster credential.** Per session it fetches a
  kubeconfig scoped to one namespace from the api's `/internal` routes, which
  re-check ownership on every fetch.
- **Learning state is not sandbox state.** `services/progress` imports nothing
  from the orchestrator. The session manager emits "this session closed", and
  the api's composition root wires that to the attempt.
- **Lab content cannot execute anything outside its sandbox.** A requirement
  names a type from a closed vocabulary; the handler is platform code given a
  read-only reader for one session.

---

## 2. Where state lives

| State | Where | Without `DATABASE_URL` |
|---|---|---|
| Students, attempts, progress, hint usage | PostgreSQL, `services/progress/migrations/001_progress.sql` | in memory, and the api says so at startup and on `/health` |
| Sessions (the handle to a sandbox) | PostgreSQL `lab_sessions` (`002_sessions.sql`, `005_session_recovery.sql`), `PostgresSessionStore` | in memory (`InMemorySessionStore`), lost on restart |
| Users and ownership; browser sign-ins | `003_users_and_ownership.sql`, `004_auth_sessions.sql` | — |
| Sandboxes themselves | Kubernetes namespaces or containers, labelled with `RUNTIME_OWNER_ID` | same |

Migrations are forward-only and run at api start (`apps/api/src/progress.ts`),
or explicitly with `npm run db:migrate` / `npm run db:status`. Compose and
production always set `DATABASE_URL`.

---

## 3. Request flows

Stable shapes, not line-by-line behaviour. Names are files and functions you can
open.

### 3.1 Student sign-in

- `AUTH_MODE` selects `oidc` (the default, and the only mode production accepts)
  or `development` (`apps/api/src/config.ts`; refused under `NODE_ENV=production`).
- OIDC: `GET /auth/login` → identity provider → `GET /auth/callback`
  (`apps/api/src/routes/auth.ts`). The api is the confidential client; the
  browser holds only a server-side opaque session cookie, stored in
  `auth_sessions`. `buildIdentityResolver` (`apps/api/src/auth/resolvers.ts`)
  turns every request into a user.
- Development: an `Authorization: Developer <name>` header or the configured
  development student. Detail and the production gates:
  [authentication.md](authentication.md).

### 3.2 Launch a lab

1. `POST /api/labs/:id/start` (`apps/api/src/routes/labs.ts`) — refused with 503
   while `LAB_LAUNCHES_PAUSED` is set.
2. `SessionManager.start` (`services/lab-orchestrator/src/session/manager.ts`)
   resolves the lab's provider through the `ProviderRegistry`, then admits the
   session with `createWithinLimits` against `MAX_ACTIVE_SESSIONS` and
   `MAX_ACTIVE_SESSIONS_PER_STUDENT`. In PostgreSQL that check runs under an
   advisory lock (`postgres-store.ts`), so two api instances cannot both admit.
3. The provider creates the sandbox: a namespace with its ServiceAccount, RBAC,
   quota and NetworkPolicy (`kind-provider.ts`), or a container through
   sandboxd (`providers/container/`, `docker-provider.ts`). Setup manifests,
   starter files and seed scripts are applied and confirmed before the session
   is ACTIVE.
4. An attempt is opened in `services/progress` when the session is admitted.

Refusals a student sees and what an operator does about them:
[runbooks/private-beta-incident-response.md](runbooks/private-beta-incident-response.md) C–E.

### 3.3 Terminal attach

1. The browser asks `POST /api/sessions/:id/terminal`
   (`apps/api/src/routes/sessions.ts`, `issueTerminalGrant`) for a short-lived
   HMAC token (`issueSessionToken`, `services/lab-orchestrator/src/session-token.ts`).
   The WebSocket URL is built from the page's own origin (`apps/web/src/lib/urls.ts`).
2. It opens `/terminal` on the terminal service and presents the token.
3. The terminal calls `fetchTerminalContext` (`services/terminal/src/credentials.ts`)
   → `POST /internal/sessions/:sid/credentials` on the api with the internal
   secret; the api re-checks that the session belongs to that user.
4. Kubernetes session: `kubernetesSpawnPlan` (`spawn-plan.ts`) starts a local
   bash under `node-pty` with a namespace-scoped kubeconfig. Container session:
   `containerSpawnPlan` → `brokerShell` (`shell.ts`) → sandboxd `/v1/attach`.
5. Typing is reported to `POST /internal/sessions/:sid/activity` so idle expiry
   knows the student is there (`services/terminal/src/activity.ts`).

### 3.4 Verify (Check)

`POST /api/sessions/:id/check` → `verifyLab` (`services/verifier/src/index.ts`),
which dispatches each requirement to its family's handler with a reader scoped
to that session → the result is recorded with `recordCheck`
(`services/progress/src/service.ts`). A PASS completes the attempt and the
progress row in one transaction. State is read, never command history.

### 3.5 End Lab

`DELETE /api/sessions/:id` → `SessionManager.end` tears the sandbox down →
the session-closed event reaches `AttemptClosingListener`
(`apps/api/src/progress.ts`), which closes the attempt as `ENDED`. Expiry by the
reaper takes the same path and closes it as `EXPIRED`.

### 3.6 Cleanup

`SessionReaper` (`services/lab-orchestrator/src/session/reaper.ts`) sweeps on
an interval: expired, idle, abandoned and orphaned sandboxes, each provider
listing only objects labelled with this runtime owner. It never deletes what it
cannot prove it owns ([runtime-ownership.md](runtime-ownership.md)).

---

## 4. Compose stacks

| Command | Files | What runs |
|---|---|---|
| `make up` (development) | `docker-compose.yml` + `docker-compose.runtime.yml` | web, api, terminal, postgres, sandboxd — every track |
| `make up-kubernetes-only` | `docker-compose.yml` | the Kubernetes track only; no container runtime anywhere |
| `make observability-up` | + `docker-compose.observability.yml`, profile `observability` | + Prometheus, Alertmanager, Grafana |
| `prod …` (production host) | all five files, profile `observability` | the production stack; only 443 and 80 published |
| `bash e2e/stack.sh up` | base + runtime + `e2e/docker-compose.e2e.yml` | a throwaway stack with a test identity provider |

`prod` is a shell function, defined once in
[runbooks/private-beta-operations.md §1](runbooks/private-beta-operations.md#1-the-production-command).
A bare `docker compose` reads only `docker-compose.yml`: no sandboxd, no
production overlays.

---

## 5. Adding a service

There is no generator. What the repository's own tests require of a new
workspace, found in the tests that enforce it:

- a `typecheck` script (`npm run typecheck` walks every workspace;
  `ci-gate-wiring.test.ts` fails a workspace without one);
- a `vitest.config.ts` naming `../../test-support/vitest.setup.ts` in
  `setupFiles` and a `test/host-execution-guard.test.ts`
  (`services/lab-orchestrator/test/test-classification.test.ts` fails the build
  otherwise — see [test-support/README.md](../test-support/README.md));
- integration suites named `*-integration.test.ts` and gated on
  `RUN_INTEGRATION_TESTS`, `RUN_DOCKER_INTEGRATION_TESTS` or `RUN_DB_TESTS`,
  skipping with `context.skip(reason)`;
- every environment variable, secret, port and mount a compose service receives
  declared in `infrastructure/secret-distribution.json` (`make secrets-check`);
- every binary a Dockerfile downloads pinned by SHA-256
  (`dockerfile-downloads.test.ts`);
- a runtime image that copies nested workspace `node_modules`
  (`runtime-image-dependencies.test.ts`).
