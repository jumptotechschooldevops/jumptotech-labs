# Testing — what each command needs, and what a green run means

The authority for *local* test commands. What CI runs, and the merge checklist,
is [ci-and-release-gates.md](ci-and-release-gates.md); the tier rules (unit /
integration / E2E, the host-execution guard, run-scoped naming) are
[test-support/README.md](../../test-support/README.md). If this page and
`package.json`, the `Makefile` or `.github/workflows/quality-gates.yml`
disagree, those files win and this page is the bug —
`services/observability/test/documentation-contract.test.ts` checks that every
command and test file named here exists.

---

## 1. PASS, SKIPPED and NOT EXECUTED

Read this before reporting any result.

- **`npm test` is unit tests only.** It runs every workspace's `vitest run`.
  Integration suites are in the same directories and are *skipped* there on
  purpose: they are gated on `RUN_INTEGRATION_TESTS=1`,
  `RUN_DOCKER_INTEGRATION_TESTS=1` or `RUN_DB_TESTS=1`. "`npm test` passed" says
  nothing about Docker, Kubernetes, PostgreSQL, a PTY or a browser.
- **An integration suite also skips itself when its infrastructure is missing,**
  even with its gate set: no kubeconfig, no reachable daemon, an image not
  built, a `node-pty` that cannot spawn (macOS), no database URL. It prints
  `[<suite>] skipped — <reason>` once and every test reports **skipped**.
- **A plain `vitest run` exits 0 when everything skipped.** So does every
  `npm run test:integration*` script and `make test-integration`,
  `make test-sandbox`, `make test-tls-edge` and `make test-db`, which are plain
  `vitest run` underneath. Their exit code is not evidence. Their
  `Tests  N passed | M skipped` line is.
- **`npx tsx test-support/strict-vitest.ts <vitest args>` is the strict form.**
  It fails when any test did not pass (skipped, todo) and when no test ran at
  all. Every runtime CI job except `postgres-integration` uses it; so do
  `make test-terminal-container` and `make test-sandboxd-container`.
- **A suite that cannot run must report skipped, not passed.** vitest counts a
  test that `return`s early as passed, which no runner can detect; use
  `context.skip(reason)`. `services/observability/test/integration-skip-semantics.test.ts`
  fails the build for the early-`return` pattern.

When you write up a run, say which of these it was:

| Say | When |
|---|---|
| **PASS** | the command ran, and its `Tests` line shows every test passed — or it ran under `strict-vitest.ts` and exited 0 |
| **SKIPPED (infrastructure unavailable)** | the suite's `skipped — <reason>` line printed, or any test in it is counted as skipped |
| **NOT RUN** | you did not run it — say why (deferred, no Docker, shared machine) |

"All tests passed" is only true of the commands you ran, and only if nothing in
them skipped.

---

## 2. The matrix

"Shared machine" is the caution for a laptop where other worktrees share one
Docker daemon and one kind cluster (see [§4](#4-running-integration-suites-next-to-other-worktrees)).

### Hermetic — no daemon, cluster or database

| Command | Proves | Ports | CI job / step |
|---|---|---|---|
| `npm run typecheck` | `tsc --noEmit` in every workspace and `scripts/` | none | `gates` · Typecheck |
| `npm run validate:labs` | every `lab.yaml`, setup asset, prerequisite and learning path loads as the api loads it | none | `gates` · Lab catalog validation |
| `npm test` | every workspace's unit suites, including the repository contract tests in `services/observability/test/` | ephemeral `127.0.0.1:0` only | `gates` · Test |
| `npm run build` | the web bundle (`apps/web`, the only workspace with a `build`; the services run from TypeScript under tsx) | none | `gates` · Build |
| `npm run test:security` | a named subset of the unit suites (already inside `npm test`) | ephemeral only | not a separate CI step |
| `npm run test:composition` | the api's production composition root is the one tested | none | `gates` · Production composition wiring |
| `make test-db-backup` | backup/restore scripts refuse unsafe states (fake daemon) | none | `gates` |
| `make test-production-host` | production-host scripts and config gates fail closed (fakes) | none | `gates` |
| `make test-private-beta-diagnostics` | the support bundle holds no secret or student data (fakes) | none | `gates` |
| `make secrets-check` | each compose service gets exactly its secrets, mounts, ports, networks | none (`docker compose config` only) | `gates` |
| `make observability-check` | Prometheus rules, Alertmanager config, dashboards | none; runs promtool/amtool as containers if not on PATH | `gates` |

All of these are safe on a shared machine. On a loaded one a unit test can
still hit vitest's 5 s timeout: re-run that one file alone before blaming the
change.

One workspace: `npx vitest run --root services/verifier` (or one file:
`npx vitest run test/lab-catalog.test.ts --root services/lab-orchestrator`).

### Needs infrastructure

| Command | Needs | Docker | PostgreSQL | kind | Ports on the host | Strict? | CI job |
|---|---|---|---|---|---|---|---|
| `make test-db` | Docker | yes (`postgres:16-alpine`) | throwaway | no | `127.0.0.1:${TEST_DB_PORT:-55432}` | **no** — read the `skipped` counts | `postgres-integration` |
| `make db-restore-drill` | Docker | yes | disposable servers | no | ephemeral loopback | script, exits non-zero on failure | `postgres-integration` |
| `RUN_INTEGRATION_TESTS=1 KUBECONFIG=infrastructure/kind/generated/kubeconfig-host.yaml npx tsx test-support/strict-vitest.ts test/integration.test.ts --root services/lab-orchestrator` | `npm run cluster:up` | yes | no | **yes** | kind API `127.0.0.1:16443` | yes | `kind-integration` |
| same, `test/pod-security-integration.test.ts`, `test/labs-integration.test.ts`, `test/network-policy-enforcement-integration.test.ts` | kind | yes | no | yes | — | yes | `kind-integration` |
| `npm run verify:network-policy` | kind | yes | no | yes | — | exit 0 only on PASS | `kind-integration` |
| `RUN_INTEGRATION_TESTS=1 npx tsx test-support/strict-vitest.ts test/sandbox-integration.test.ts --root apps/api` | `npm run sandbox:build` | yes | no | no | none | yes | `sandbox-integration` |
| NET-004…008, NET_RAW: `test/net00{4..8}-integration.test.ts`, `test/net-raw-capability-integration.test.ts` (`--root services/lab-orchestrator`) | a Linux sandbox image (NET-004…006 read `jumptotech/lab-linux:net004-e2e`) | yes | no | no | none | yes | `networking-integration` |
| `RUN_DOCKER_INTEGRATION_TESTS=1 npx tsx test-support/strict-vitest.ts test/docker-integration.test.ts --root services/lab-orchestrator` (+ `docker009`…`docker014`) | a daemon that allows **privileged** containers; pulls `docker:27-dind` | yes | no | no | none | yes | `docker-integration` |
| `make test-terminal-container` | Docker and kind; builds `jumptotech/terminal-test` | yes | no | yes | none | yes | `terminal-integration` |
| `make test-sandboxd-container` | Docker; mounts the socket into the test container; builds `jumptotech/lab-linux:sandboxd-test` | yes | no | no | none | yes | `sandboxd-integration` |
| `make test-tls-edge` | Docker; builds the web image | yes | no | no | ephemeral loopback | **no** (the CI step runs it strictly) | `tls-edge-integration` |
| `npm run test:e2e` (`bash e2e/stack.sh run`) | Docker, Playwright Chromium (`npx playwright install chromium`) | yes | stack's own | no | 33700, 34700, 34701, 55700, 39700 (`E2E_*_PORT`) | Playwright | `browser-e2e` |
| `make beta-validate` | the running stack (`make up`), kind, the observability profile; ~30 min | yes | stack's | yes | uses the stack's | its own PASS/FAIL | **not in CI** |

The `npm run test:integration*` scripts in `package.json` run the same files as
the rows above with a plain `vitest run`: fine for iterating, not evidence.

---

## 3. Which platform can run what

Development happens on macOS with Docker Desktop; CI and production are Linux.

| Behaviour | macOS laptop | Trust only after |
|---|---|---|
| Unit suites, typecheck, build, lab validation | runs | — (same result) |
| A real PTY (`node-pty` spawning a shell) — terminal and sandboxd suites | `pty.spawn` fails with `posix_spawnp failed`; the suites skip. Use `make test-terminal-container` and `make test-sandboxd-container`, which run them in a Linux image | `terminal-integration`, `sandboxd-integration` |
| Bind-mount file ownership and modes (e.g. the scrape token read by uid 65534) | Docker Desktop's file sharing hides them: a `0600` file owned by you reads fine in a container here and not on Linux | a Linux host — [production-host-readiness.md §18.1](production-host-readiness.md#181-scrape-token-permissions-fixed-on-this-branch) |
| `DOCKER_SOCKET_GID` (sandboxd's access to the socket) | default `0` works on Docker Desktop | the production host's preflight (`make production-preflight`) |
| `/proc`, capabilities, seccomp, NetworkPolicy enforcement | inside Linux containers and the kind node either way | `kind-integration`, `networking-integration`, `sandbox-integration` |
| Image architecture | local evidence has been arm64 | CI (`ubuntu-latest`, amd64) |
| Unix socket path length (operator socket tests) | macOS `TMPDIR` is too long; the test uses `/tmp/jttop-…` | `gates` |

Nothing in the suites branches on `process.platform`: the difference is always
a probe (kubeconfig present, daemon reachable, image present, PTY spawns) that
turns into a skip.

---

## 4. Running integration suites next to other worktrees

One Docker daemon and one kind cluster (`jumptotech-labs`) are shared by every
checkout on a machine. The suites are written to coexist — every object they
create is named after `JTT_TEST_RUN_ID` and cleanup only touches this run's
objects — provided you:

- set your own `JTT_TEST_RUN_ID` and `RUNTIME_OWNER_ID`;
- never let `npm run sandbox:build` write `:latest` another checkout runs: set
  **all four** of `LINUX_`, `TERRAFORM_`, `ANSIBLE_` and `CICD_SANDBOX_IMAGE` to
  private tags, or the script refuses (it will not write some tags and not
  others);
- pick a free `TEST_DB_PORT` for `make test-db` (`docker ps` first);
- remember the kind cluster itself is shared: `npm run cluster:down` deletes it
  for everyone. Its lease check reads only this checkout's
  `infrastructure/kind/generated/` lease file, so it does not see another
  checkout's runs.

Never run `docker system prune`, `docker image prune` or a label-wide
`docker rm` on a shared machine: it removes other checkouts' sandboxes and
images.
