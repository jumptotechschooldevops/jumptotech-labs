# Getting started — a new engineer's first day

From a fresh clone to a first reviewed change, using only commands that exist.
Where a subject has its own authority this page links to it rather than
repeating it; the map of all documents is [docs/README.md](../README.md).

---

## 1. Toolchain

| Tool | Version | Evidence | Needed for |
|---|---|---|---|
| Node.js | **22** — the only version CI and the images exercise | `.nvmrc` = `22`; every `FROM node:22-bookworm-slim`; CI `setup-node` reads `.nvmrc` (`ci-gate-wiring.test.ts` pins all three) | everything |
| npm | the one that ships with Node 22 | `package-lock.json` is lockfile v3 | install |
| Docker + Compose v2 | Docker Desktop 28.4 / Compose v2.39 are what the README records | [README → Requirements](../../README.md#requirements) | the stack, kind, sandboxes, integration suites |
| kind, kubectl | 0.31 / 1.34 | CI installs these versions (`kind-integration`) | the Kubernetes track and its suites |
| bash, openssl | bash 3.2+; any openssl | `scripts/`; `make secrets` refuses without openssl | scripts, secret generation |

`package.json` declares `"engines": { "node": ">=22 <25" }`. There is no
`engine-strict`, so npm only warns outside that range, and Node 23 and 24 are
*accepted* but not *exercised*: `node-pty` is a native addon, and the terminal
and sandboxd suites are validated on 22 only. Use 22:

```bash
nvm use        # reads .nvmrc (nvm install first if needed)
node --version # v22.x
```

TypeScript, vitest, tsx and Vite are dev dependencies installed by `npm ci`;
nothing is installed globally. There is no lint script in any workspace — do
not document one.

---

## 2. Install and the first commands that need nothing

```bash
git clone <repository-url> && cd jumptotech-labs
nvm use
npm ci                    # the lockfile is authoritative; CI and every image use npm ci
npm run typecheck         # every workspace and scripts/
npm run validate:labs     # the lab catalog; prints "117 labs registered …" or one line per defect
npm test                  # unit suites only — hermetic, no Docker needed
npm run build             # the web bundle (the only workspace with a build)
```

None of these starts a container, binds a fixed port or reads `.env`. They are
the `gates` CI job, and are what "it builds" means here. Read
[testing.md §1](testing.md#1-pass-skipped-and-not-executed) before saying
anything about *integration* tests: `npm test` skips every one of them.

---

## 3. Running the platform locally

```bash
make setup     # make secrets, RUNTIME_OWNER_ID, the scrape token, the kind cluster, the sandbox images
make up        # base + runtime overlay: every track, http://localhost:3000
```

`make help` lists every target. The step-by-step version, and what each track
needs, is [README → Running locally](../../README.md#running-locally).

**Environment.** `.env` is read in exactly two ways, and only these:

1. **Compose interpolation.** A value reaches a container only if a compose
   file names it (`${NAME}`); there is no `env_file:`. Several variables are
   pinned in the compose files, so setting them in `.env` does nothing there
   (for example `LABS_DIR`, `KUBECONFIG`, the provider switches of the runtime
   overlay).
2. **Scripts and make targets that source it** (`make db-migrate`,
   `make beta-validate`, the production-host scripts).

The Node services started on the host (`npm run dev:api` and friends) run
`tsx watch src/index.ts` and **read no `.env` at all**: export what they need in
the shell ([README → Running the services on the host](../../README.md#running-the-services-on-the-host)).

`.env.example` documents every variable; `make secrets` creates `.env` from it
and generates every secret, printing names only. Never commit `.env`, and never
paste its values into an issue, a log or a document.

---

## 4. Where things are

Read [architecture.md](../architecture.md) first: the services, the boundaries
and the six request flows on one page. Then, as needed:

| To change… | Start in | Its tests |
|---|---|---|
| a lab | `labs/<track>/<lab>/lab.yaml` | `npm run validate:labs`, [contributing-labs.md](contributing-labs.md) |
| a verifier check | `services/lab-orchestrator/src/requirements.ts` + `services/verifier/src/handlers/` | `services/verifier/test/` |
| an API route | `apps/api/src/routes/` | `apps/api/test/` |
| the UI | `apps/web/src/` | `apps/web/test/` (jsdom + Testing Library) |
| terminal behaviour | `services/terminal/src/` | `services/terminal/test/`; real PTY only in `make test-terminal-container` |
| the runtime broker | `services/sandboxd/src/` | `services/sandboxd/test/`; real daemon in `make test-sandboxd-container` |
| progress / schema | `services/progress/src/`, `services/progress/migrations/` (forward-only) | `make test-db` |
| alerts, dashboards | `infrastructure/observability/` | `make observability-check`, `services/observability/test/alerts.test.ts` |
| compose, secrets, ports | `docker-compose*.yml`, `infrastructure/secret-distribution.json` | `make secrets-check` |

---

## 5. A first change

1. Branch from current `main`.
2. Make the change and its test in the same workspace. A unit test must not
   reach a process, daemon or network: the host-execution guard fails it with
   `HOST_EXECUTION_DENIED` ([test-support/README.md](../../test-support/README.md)).
3. Run the hermetic set from §2 on Node 22. For one workspace while iterating:
   `npx vitest run --root <workspace>`.
4. If the change touches something only an integration suite proves, run that
   suite from [testing.md §2](testing.md#2-the-matrix) through
   `test-support/strict-vitest.ts`, or say in the PR that it was not run.
5. `git diff --check`, then open the PR. Every job in
   [ci-and-release-gates.md §2](ci-and-release-gates.md#2-pr-gate-matrix) must
   be green on the PR's head; `main` has no branch protection, so that is the
   reviewer's check, not GitHub's.

---

## 6. Scripts and make targets: what is safe where

Every script under `scripts/`, by what it does. "Changes state" means it
creates, removes or rewrites something outside the checkout's working tree.

| Script (make target / npm script) | Purpose | Changes state? |
|---|---|---|
| `cluster-up.sh` (`npm run cluster:up`, `make cluster-up`) | create the kind cluster, write kubeconfigs | creates the shared kind cluster |
| `cluster-down.sh` (`npm run cluster:down`) | delete the kind cluster | **deletes the cluster** every checkout on the machine uses. Refuses when this checkout's lease file (`infrastructure/kind/generated/cluster-<name>.lease`) names another `RUNTIME_OWNER_ID` (`-- --force` overrides); it cannot see leases recorded in *other* checkouts |
| `cluster-status.sh` (`make status`) | health of cluster and services | no |
| `sandbox-build.sh` (`npm run sandbox:build`) | build the four sandbox images | **writes `:latest` tags** unless all four `*_SANDBOX_IMAGE` are set |
| `sandbox-clean.sh` (`make sandbox-clean`) | remove this `RUNTIME_OWNER_ID`'s sandboxes | **removes running sandboxes** without ending their sessions; refused on a production checkout |
| `ensure-dev-secrets.sh` (`make secrets`) | create `.env`, generate secrets | writes `.env` only |
| `wait-for-postgres.mjs` | readiness gate for `make test-db` | no |
| `verify-api-image-composition.sh` (`npm run verify:api-image`) | is the running api image current? | no |
| `validate-labs.ts` (`npm run validate:labs`) | lab catalog validation | no |
| `check-secret-distribution.mjs` (`make secrets-check`) | compose secrets/ports/mounts contract | no |
| `check-observability.sh` (`make observability-check`) | promtool/amtool/dashboards | no (may run tool containers) |
| `test-db-backup-restore.sh`, `test-production-host-scripts.sh`, `test-private-beta-diagnostics.sh` | self-tests of the operator scripts, against fakes | no |
| `db-restore-drill.sh` + `db-restore-drill/` (`make db-restore-drill`) | backup → destroy → restore → verify on **disposable** servers it creates | creates and removes its own containers only |
| `beta-validation/` (`make beta-validate`) | five synthetic students against the running stack | creates and ends sessions on the running stack |
| `db-backup.sh` (`make db-backup`) | archive + checksum into `BACKUP_DIR` | writes an archive; prunes by retention |
| `db-restore.sh --verify-only` (`make db-backup-verify`) | check an archive | no |
| `db-restore.sh --into NEW` | restore beside the live database | creates a database |
| `db-restore.sh --replace DB` | **production recovery**: swap a restored database in | **renames the live database** (never drops); needs `--confirm`; stop the api first — [postgres-backup-restore.md §6.4](../runbooks/postgres-backup-restore.md#64-production-recovery-procedure) |
| `db-lib.sh`, `production-host-lib.sh` | libraries sourced by the above | — |
| `production-preflight.sh`, `production-config-check.ts`, `private-beta-smoke.sh`, `host-capacity-sample.sh`, `private-beta-diagnostics.sh`, `diagnostics-sanitize-logs.ts`, `tls-check.ts` | read-only production-host checks and evidence | no — each prints PASS/FAIL and never a secret |
| `tls-install.sh` (`make tls-install`) | install a certificate into the edge and hot-reload nginx | **replaces the served certificate**; rolls itself back on refusal |
| `verify-network-policy.ts` (`npm run verify:network-policy`) | prove NetworkPolicy enforcement | creates and removes probe namespaces; with `--write-attestation` **rewrites the cluster's attestation**, which the api admits Kubernetes labs by |
| `refuse-on-production.sh` | guard used by `make up`, `rebuild`, `up-kubernetes-only`, `db-up`, `down`, `clean`, `sandbox-clean` | no |
| `tsconfig.json` | makes `scripts/` typecheck (`npm run typecheck:scripts`) | — |

Make targets that destroy data:

- `make clean` deletes the PostgreSQL volume (every student's progress) and the
  kind cluster. It needs `CONFIRM=delete-student-progress` and refuses on a
  production checkout.
- `docker compose down -v` does the same to the volume with **no** guard at all.
- On a production host, the production procedures apply instead:
  [runbooks/private-beta-operations.md](../runbooks/private-beta-operations.md).

---

## 7. New engineer checklist

- [ ] Node 22 via `.nvmrc`; `npm ci` leaves `package-lock.json` unchanged.
- [ ] `npm run typecheck`, `npm run validate:labs`, `npm test`, `npm run build` pass.
- [ ] Read [architecture.md](../architecture.md) and [testing.md](testing.md) §1.
- [ ] `make setup && make up`; open http://localhost:3000 — the development
      stack uses `AUTH_MODE=development`, so there is no sign-in page and every
      browser is the development student — and start, Verify and End one Linux lab.
- [ ] Know which suites need Docker, PostgreSQL, kind or a real PTY
      ([testing.md §2](testing.md#2-the-matrix)), and that macOS skips the PTY ones.
- [ ] Know the destructive commands (§6) and that `prod`, not `make`, drives a
      production host.
- [ ] First change: its test in the same workspace, the hermetic set green, the
      relevant integration suite strict or declared not run, `git diff --check`.
