# CI and release gates

What has to be green before a change merges, what each gate proves, how to
reproduce a failure on a laptop, and what a release needs beyond green CI.

Source of truth: [`.github/workflows/quality-gates.yml`](../../.github/workflows/quality-gates.yml),
[`.github/workflows/codeql.yml`](../../.github/workflows/codeql.yml),
[`package.json`](../../package.json) and the [`Makefile`](../../Makefile). If this
page and those files disagree, the files win and this page is the bug.
`services/observability/test/ci-gate-wiring.test.ts` checks the wiring this
page describes (which suites run where, strict runners, workflow policy), so
most drift fails `npm test` before it reaches a reader.

---

## 1. How the gates run

Two workflows run on every pull request (any target branch for Quality gates,
`main` for CodeQL) and on every push to `main`. CodeQL also runs weekly.

- **`gates`** is hermetic — no daemon, cluster or database — and every runtime
  job `needs:` it, so a branch that does not typecheck spends no runner time on
  image builds.
- **Nine runtime jobs** each get a fresh runner: their own Docker daemon, kind
  cluster and image store, torn down afterwards. Every object they create is
  named after a run-scoped `RUNTIME_OWNER_ID` / `JTT_TEST_RUN_ID`, and every
  cleanup filters on it.
- **Runtime suites run strictly.** They go through
  [`test-support/strict-vitest.ts`](../../test-support/strict-vitest.ts), not
  bare `vitest run`: an integration suite skips itself when its infrastructure is
  missing, and in the job that exists to provide that infrastructure a skip
  fails the step, as does a run in which no test ran. Unit runs (`npm test`) are
  not strict, because several suites skip there on purpose.
- **Concurrency.** A newer push to a pull request cancels the run in flight. A
  push to `main` never cancels anything: runs are grouped by commit SHA, so every
  commit on `main` has a complete run.

### Enforcement: not configured

`main` has **no branch protection and no required status checks** (checked
2026-09-19: `GET /repos/…/branches/main/protection` → 404). A red or missing run
does not stop a merge; only the reviewer does. That is a repository setting,
not something a commit can change. **Operator action:** protect `main` and require
the check names in §2 (`gates`, the nine runtime jobs, `Analyze
(javascript-typescript)`, `Analyze (actions)`).

---

## 2. PR gate matrix

"When" is *every PR and every push to main* unless stated. Every job installs
with `npm ci` on the Node version in `.nvmrc`.

### `gates` job — hermetic, ~6 min

| Gate (CI step) | Proves | Local command | External requirements | Typical failure |
|---|---|---|---|---|
| Typecheck | `tsc --noEmit` in every workspace **and** `scripts/` (not a workspace; tsx does not typecheck) | `npm run typecheck` | none | type error; a new workspace without a `typecheck` script (the wiring test fails) |
| Lab catalog validation | every `lab.yaml`, setup asset, prerequisite and learning path loads the way the API reads it | `npm run validate:labs` | none | lab schema error, one line per defect |
| Test | every workspace's unit suites, including the security and CI-wiring suites | `npm test` (one workspace: `npx vitest run --root <ws>`) | none — the host-execution guard fails any suite that reaches for a process, daemon or network | assertion; `HOST_EXECUTION_DENIED`; a 5 s timeout on a saturated laptop (re-run that file alone before blaming the change) |
| Production composition wiring | the api's production composition root is the one tested | `npm run test:composition` | none | composition refactor that dropped a wire |
| Observability configuration | Prometheus rules, Alertmanager config and dashboards are valid to promtool/amtool | `make observability-check` | Docker (runs promtool/amtool images) or the tools on PATH | rule syntax, a dashboard query naming a metric that does not exist |
| Observability containers hold no container runtime · sandboxd is the only service holding a Docker socket | the absence of a mount, read from the compose files | the `run:` block in the workflow | none | a new socket mount |
| Each service receives exactly its allowed secrets, mounts, ports and networks | `docker compose config` of every stack against `infrastructure/secret-distribution.json` | `make secrets-check` | Docker Compose v2 | a new env var or port not declared in the distribution file |
| Backup and restore scripts refuse unsafe states | the backup/restore scripts' refusals, against a fake daemon | `make test-db-backup` | none | a refusal path that no longer refuses |
| Production configuration gates fail closed · production-host scripts … | the production config loaders and host scripts refuse every unsafe variation; only read-only verbs | `make test-production-host` | none | a new unsafe default |
| Support bundle holds no secret or student data | planted sentinels never reach the bundle | `make test-private-beta-diagnostics` | none | a new collector that copies raw data |
| No database archive is committed | no `.dump`/`.backup`/`.bak` is tracked | the `run:` block | none | an archive under any name |
| Build | `npm run build` in every workspace that has a build (today the web bundle) | `npm run build` | none | Vite build error |

### Runtime jobs

| CI job | Proves | Local command | External requirements | Typical failure |
|---|---|---|---|---|
| `postgres-integration` | the three persistence suites against a real PostgreSQL; backup → destroy → restore → identical | `make test-db` (`TEST_DB_PORT=…` if 55432 is taken), `make db-restore-drill` | Docker | migration or SQL change; port already taken locally |
| `kind-integration` | orchestrator, PodSecurity admission, whole-catalog Kubernetes labs, NetworkPolicy **enforcement** with negative controls, the operator probe | `npm run cluster:up`, then the `KUBECONFIG=… npx tsx test-support/strict-vitest.ts …` lines in the job | Docker, kind 0.31, kubectl 1.34 | a lab that no longer solves; enforcement probe INCONCLUSIVE |
| `sandbox-integration` | Linux, Terraform, Ansible and CI/CD sandboxes against real images; every binary the providers exec exists in every image | `npm run sandbox:build` (use private tags — `README → Local development requirements`), then the job's lines | Docker | an image change; a provider exec path |
| `networking-integration` | NET-004…008 end to end; the NET_RAW capability is a closed set | the job's lines | Docker | network namespace timing, capability grant |
| `docker-integration` | per-session Docker-in-Docker, mTLS isolation, DOCKER-009…014 | `npm run test:integration:docker` (+ the per-lab suites) | Docker that allows privileged containers; pulls `docker:27-dind` | dind start-up time; a lab verifier |
| `terminal-integration` | the whole shell chain with a real PTY, in a container | `npm run cluster:up && make test-terminal-container` | Docker, kind | kubeconfig/cluster wiring |
| `sandboxd-integration` | the broker's refusals against a real daemon and real PTYs | `make test-sandboxd-container` | Docker (the only job that mounts the socket) | broker scope refusal |
| `tls-edge-integration` | the production TLS edge in the real web image: certificate gate, protocols, redirect, WebSocket, renewal | `make test-tls-edge` | Docker | nginx/openssl behaviour; test-only certificates |
| `browser-e2e` | Chromium through sign-in, a learning path, a real LINUX-001 sandbox, terminal, Verify, progress, End lab, cross-student isolation | `npm run test:e2e` | Docker; Playwright Chromium | stack readiness; a UI flow |

### CodeQL — `Analyze (javascript-typescript)`, `Analyze (actions)`

Default query suite, `build-mode: none`, on PRs to `main`, pushes to `main` and
weekly. `actions` analyses the workflows themselves (expression injection,
untrusted checkouts, over-broad permissions). Findings appear under Security →
Code scanning; whether a new alert blocks a merge is a repository setting (see
Enforcement above), not something the workflow decides.

### Local-only gates (not in CI)

| Gate | Why not CI | Command |
|---|---|---|
| `test:security` | a curated subset of the unit suites `npm test` already runs in `gates`; the wiring test proves every file it names exists and is a unit suite | `npm run test:security` |
| Five-student beta gate | needs the running stack, kind and the observability profile for ~30 min | `make beta-validate` |
| Production preflight, config check, smoke, TLS check | about a real host; see §5 | `make production-preflight` etc. |

---

## 3. Supply-chain policy

**GitHub Actions.** Only `actions/*` and `github/*`, referenced by major tag
(`@v7`). A third-party action is a review decision and would be pinned by commit
SHA. Every checkout sets `persist-credentials: false` (nothing pushes; a token in
`.git/config` would be readable by the dependency scripts `npm ci` runs). No
workflow grants a write permission at workflow level; CodeQL's job asks for
`security-events: write` alone. No workflow uses a repository secret.

**Downloaded binaries.** Every binary a Dockerfile or workflow fetches with
`curl` (kubectl, the docker CLI, the compose plugin, terraform, kind) is checked
against a SHA-256 pinned beside its version before it is installed, per
architecture. Bumping a version means bumping its checksums;
`dockerfile-downloads.test.ts` holds every Dockerfile to that and to one version
and checksum per tool across images.

**Base images** are referenced by tag (`node:22-bookworm-slim`,
`debian:bookworm-slim`, `alpine:3.21`, `nginx:1.30-alpine`, `postgres:16-alpine`,
`docker:27-dind`), not digest: rebuilds pick up the distribution's security
patches, at the cost of bit-for-bit reproducibility. Dependabot proposes base
image updates monthly.

**npm.** `package-lock.json` is authoritative; CI and every image install with
`npm ci`. Lifecycle scripts run in CI and in the images that compile `node-pty`;
the api and web images install with `--ignore-scripts`.

**Build contexts.** `.dockerignore` keeps secrets, host state and host build
output out of every context (`build-context-secrets.test.ts`).

### Dependencies

[`.github/dependabot.yml`](../../.github/dependabot.yml): npm and Actions weekly,
Docker base images monthly; minor/patch grouped, majors one at a time, nothing
auto-merged. Check the state with `npm audit` (all) and `npm audit --omit=dev`
(what ships). Never `npm audit fix --force`: it performs major upgrades. A
vulnerability fixed only by a major upgrade is a planned change with its own PR.

Open as of 2026-09-19: `vitest`/`@vitest/mocker` GHSA-82fw-gwwq-j7x9 (moderate,
development only: the test runner's mock redirect; nothing ships it) needs vitest
3 → 4. `npm audit --omit=dev` is clean.

### Stale pinned majors (decisions, not updates)

Measured 2026-09-19 from Docker Hub's `last_updated` for each tag:

| Reference | Last rebuilt | Why it is not simply bumped |
|---|---|---|
| `docker:27-dind` — every Docker-track session's **privileged** daemon (`DockerLabProvider` default, CI pre-pull) | 2025-02-15 | Docker 27 is out of support; moving the per-session daemon to 28+ changes what DOCKER-001…014 students see and must be re-proven by `docker-integration`. Highest-value follow-up here. |
| `DOCKER_CLI_VERSION=27.3.1` (api, sandboxd, terminal images) | — | client only; follows the dind decision |
| `nginx:1.27-alpine` in lab content (DOCKER-*, NET-022, K8S-013/015) | 2025-04-16 | it is what the labs teach and verify against; lab content, not platform |
| `alpine:3.21` sandbox bases | current (rebuilt 2026-09-18) | none needed yet |

The platform's own TLS edge moved from `nginx:1.27-alpine` (last rebuilt
2025-04-16) to the maintained `nginx:1.30-alpine` stable line.

---

## 4. Software merge readiness

A change is ready to merge when all of these hold. None of them needs a host.

- [ ] The branch is based on the current `origin/main` (or reconciled with it),
      and its CI run is on that head.
- [ ] Every Quality gates job is green on the PR run — `gates` and all nine
      runtime jobs. A skipped job is not a green one.
- [ ] Both CodeQL analyses completed; no new high/critical alert is unexplained.
- [ ] `npm ci` leaves `package-lock.json` unchanged; a lockfile diff is intended
      and named in the PR.
- [ ] `npm audit --omit=dev` has no finding the PR introduced.
- [ ] Locally, on Node 22: `npm run typecheck`, `npm run validate:labs`,
      `npm test`, `npm run build`, `npm run test:security`.
- [ ] Anything the change could affect that CI does not run (the five-student
      gate, a production script against a real host) was run, or the PR says it
      was not.

## 5. Real-host deployment readiness

Separate, and not provable by CI. It is owned by
[production-host-readiness.md](production-host-readiness.md) (its §15 is the
procedure) and recorded in
[releases/production-host-evidence-template.md](../releases/production-host-evidence-template.md);
the open deployment decisions are in
[releases/private-beta-release-gate.md](../releases/private-beta-release-gate.md) §7.
Green CI says nothing about a host's firewall, DNS, certificate, identity
provider, backups or capacity.

## 6. Traceability — answering "what is running?"

| Question | How to answer it today |
|---|---|
| Which commit is deployed? | the host's checkout: `git rev-parse HEAD`. The services report `JTT_COMMIT` from `.env` in their start-up log line and the `jtt_build_info{commit=…}` metric; `make production-preflight` warns when it differs from HEAD. |
| Which image corresponds to it? | images are built on the host from that checkout (`prod up --build`); there is no registry. `docker image inspect <image> --format '{{.Created}}'` against the checkout time. Images carry no revision label (follow-up below). |
| Which CI run validated it? | `gh run list --commit <sha> --workflow "Quality gates"`. Every push to `main` now has a complete run. |
| Which tests passed? | that run's job logs; each strict step fails if anything skipped, so a green step means every named test ran and passed. |
| Which configuration was expected? | `make production-config-check` (the real loaders against the resolved compose files) and the evidence file from §5. |

**Follow-ups, not done here:** build the images with `JTT_COMMIT` as a build
argument and an `org.opencontainers.image.revision` label, so an image names its
own commit instead of trusting `.env`; that touches the compose and production
files, which the deployment-readiness work owns.
