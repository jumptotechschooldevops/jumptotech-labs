# Overnight CI/CD and supply-chain audit — report

Branch `feat/overnight-cicd-supply-chain`, worktree `~/jtt-overnight-cicd-supply-chain`.
Base `d4e301b892f4f772e1a6eb7e20dd37b2d4fe9a0e` (= `origin/main` at start).
Not pushed, not merged.

The release-engineering pass (PR #43, merged as `74fe5fa`) had already done a
lot: strict runners, SHA-256-pinned downloads, least-privilege permissions,
`persist-credentials: false`, per-SHA concurrency on `main`, Dependabot, and
`ci-gate-wiring.test.ts`. So this pass looked for what that work missed and for
drift from the four PRs merged since (#42, #50, #51, #44). Everything below was
reproduced before it was fixed, and each fix has a test that fails against the
old code.

## 1. CI inventory

| Workflow | Trigger | Permissions | Jobs | Node | Install / cache | Artifacts | Secrets |
|---|---|---|---|---|---|---|---|
| `quality-gates.yml` | `pull_request` (any base), `push` to `main` | workflow `contents: read` | `gates` (hermetic, 20 min) → 9 runtime jobs: postgres, kind, sandbox, networking, docker, terminal, sandboxd, tls-edge, browser-e2e | `.nvmrc` (22) via `setup-node@v7` | `npm ci`, `cache: npm` (keyed on lockfile by setup-node; `~/.npm` only) | kind logs (on failure, 7 d), Playwright report/traces (on failure, 7 d) | none |
| `codeql.yml` | PR to `main`, push to `main`, weekly | `{}` at workflow level; job `security-events: write`, `packages/actions/contents: read` | `Analyze (javascript-typescript)`, `Analyze (actions)`, `build-mode: none` | — | — | SARIF upload (by the action) | none |

External actions: `actions/checkout@v7`, `actions/setup-node@v7`,
`actions/upload-artifact@v7`, `github/codeql-action/{init,analyze}@v4`. All are
first-party, pinned by major tag, one version each, as the documented policy
says. Dependabot tracks them weekly.

Nothing duplicates or contradicts anything else. The `gates` job runs the unit
suites that `test:security` names, so that script stays local-only by design.

## 2. Defects found and fixed

| # | Class | Defect | Evidence | Fix | Commit |
|---|---|---|---|---|---|
| 1 | False green | `postgres-integration` → `make test-db` → `npm run test:db` used bare `vitest run`. All four DB suites `describe.skip` themselves without `RUN_DB_TESTS`/`TEST_DATABASE_URL`, and vitest exits 0 when everything is skipped. The strictness rule and its wiring test only read the workflow's own lines. | Without a DB: old script **exit 0** (4 suites skipped); new script **exit 1**, and it names the suite. | `test:db` goes through `test-support/strict-vitest.ts`. The wiring test now expands every runtime job's Make/npm calls and refuses a bare `vitest run`. | `7e6a6f4`, `0e06910` |
| 1a | Found in my own fix | Running the whole `services/progress` workspace strictly failed a correct run: its host-execution-guard suite skips on purpose whenever an integration gate is set. | `TEST_DB_PORT=55461 make test-db` exit 2 | Name the one DB suite, `postgres-repository-integration`. Result: 24 + 179 + 20 tests against real PostgreSQL, 0 skipped, exit 0. | `0e06910` |
| 2 | False green (security gate) | The "Observability containers hold no container runtime" step never checked anything. The awk range `/^  prometheus:/,/^  [a-z]/` ends on the line that starts it, so it only read the three `  name:` lines. Separately, `grep -q` on a missing file exits 2, which `if` reads as "no match". No other check covers this: `secret-distribution.json` allowlists members only for `database`. | Mutation (Prometheus on `kind` + `sandboxes`) → **step exit 0**. Missing file → exit 0. | The step now runs under `set -euo pipefail`, requires all 5 compose files to exist, and reads each service's own block. New `observability-isolation.test.ts` enforces the same rule on every `npm test` and first proves its reader sees each service's body. Both fail on the mutation. | `5a1ecaf`, `e73c5fe` |
| 3 | False green (systemic) | GitHub's default `run:` shell is `bash -e {0}`, which has no `pipefail`. | Documented runner behaviour. I reviewed every piped command. | `defaults.run.shell: bash` (`-eo pipefail`) for the whole workflow. The wiring test pins it and refuses a step that opts back out. | `1941c43` |
| 4 | Build context | `.gitignore` ignores `*.dump*` anywhere (`BACKUP_DIR` can point anywhere), but `.dockerignore` only excluded the root `backups/`. The Dockerfiles copy whole service directories. | Real `docker build` with `COPY services/progress`: after the fix, planted `.dump`/`.dump.sha256` are absent and the control `.txt` is present. | `**/*.dump`, `**/*.dump.sha256` and `**/*.dump.partial` added. The test now holds `.gitignore` and `.dockerignore` to the same archive names. | `1e85eff` |
| 5 | Undeclared dependency | `services/observability/src/http-metrics.ts` imports types from `express`, but the workspace declares neither package. It only resolved because apps/api's copy is hoisted. | Import scan of every workspace's `src/` against its manifest (this was the only hit) | `@types/express` added as a devDependency. The lockfile gains one line, resolves nothing new, and a regeneration round-trip is byte-stable. Images unaffected (`--omit=dev`, and the import is type-only). | `d3526ea` |
| 6 | Developer docs | README told contributors to run `apps/web/test/multi-track-catalog.test.tsx`, which c9aa1b6 deleted. That filter alone makes vitest exit 1. | `git log --diff-filter=D` | Points to `catalog.test.tsx`. | `161932e` |

Regression guards added where nothing was broken yet (`ddd7058`, `61d6ee8`):
- kind/kubectl version and checksum must match across the two jobs that
  install them and the three Dockerfiles that carry kubectl;
- the browser-E2E URLs must match `e2e/stack.sh`'s default ports;
- every locked package must come from `registry.npmjs.org` with a sha512
  integrity, and the only links allowed are the ten workspaces.

Each guard was mutation-tested: one kind version changed, a stack port moved,
a `resolved` URL redirected. All three were caught.

## 3. Findings by area (no change needed, or not mine to change)

- **Permissions / untrusted PRs.** Only `pull_request`; no
  `pull_request_target`, `workflow_run` or `workflow_dispatch`. No secrets. The
  token is read-only and never persisted. No write permission at workflow
  level. No step interpolates PR-controlled values (`github.head_ref`, titles,
  bodies) into shell; the only expressions in `run:` are `github.run_id` and
  `github.job`.
- **Actions.** Consistent and first-party. actionlint 1.7.7 (with shellcheck)
  is clean on both workflows after `e73c5fe`.
- **Cache.** setup-node's npm cache only: keyed on the lockfile, holds no
  credentials or build output, and `npm ci` verifies integrity on restore.
- **Artifacts.** Only on failure, 7-day retention, explicit paths. kind logs
  come from a throwaway cluster. Playwright traces contain per-run test
  identities only; `e2e/.stack/` (per-run secrets) is outside the uploaded
  paths, and hidden files are excluded by default.
- **Docker.** Every `curl` in a Dockerfile or workflow is SHA-256-verified per
  arch (existing test). Base images use tags, not digests, by documented
  policy. No `ADD <url>`, no `npm install`, no unpinned `pip`. Runtime stages
  copy `node_modules` only from build stages.
- **Downloads in scripts.** None. promtool and amtool images are version-tagged
  and match compose.
- **Dependencies.** `npm audit --omit=dev`: **0**. `npm audit`: 2 moderate,
  `vitest`/`@vitest/mocker` GHSA-82fw-gwwq-j7x9. That is dev-only, the only fix
  is a major upgrade (vitest 3 → 4+/5), and it was already recorded. Not
  upgraded.
- **Lifecycle scripts.** Only `node-pty` (native build), `esbuild` (binary
  check) and `fsevents` (macOS, optional). No workspace lifecycle scripts, no
  `.npmrc`.
- **Clean install.** A fresh worktree with no `node_modules` ran `npm ci` in
  69 s, exit 0, with the tree unchanged. The lockfile is a fixed point of
  `npm install --package-lock-only` (both before and after `d3526ea`).
- **Triggers.** Quality gates have no path filters, so no blind spots. CodeQL
  runs on PRs to `main` only, which matches the target branch.
- **Concurrency.** PRs cancel superseded runs; `main` is grouped by SHA and
  never cancelled (already enforced).
- **Service lifecycle.** Every runtime job has `timeout-minutes`, diagnostics
  before teardown, and `if: always()` cleanup filtered by run-scoped labels.
  PostgreSQL readiness is a real query (`wait-for-postgres.mjs`, 90 s).
- **Node.** `.nvmrc` 22, every image `node:22-*`, CI reads `.nvmrc`. `engines`
  is `>=22 <25` while the README names 22 as the only supported line. That
  upper bound was a deliberate choice in `92bbf35`, and I have no evidence
  about 23/24 either way, so I left it (residual).
- **Release identity.** Services report `JTT_COMMIT` from `.env`, and
  `make production-preflight` warns when it differs from HEAD. Images carry no
  `org.opencontainers.image.revision` label, so a stale image run under an
  updated `.env` reports the wrong commit. This is already a recorded
  follow-up. It touches the compose/production files the production-ops work
  owns, so I did not change it here.

## 4. Commands and exact results

| Command | Result |
|---|---|
| `npm ci` (fresh worktree) | exit 0, 69 s; 2 moderate advisories (above) |
| `npm run typecheck` | exit 0 (before and after) |
| `npm run validate:labs` | 117 labs, 0 errors, 0 warnings |
| `npm run build` | exit 0 |
| `npm test` | **exit 1 both runs, load flakes only.** Run 1 (load ≈ 80): 4 failures in `apps/api/catalog-api` (3) and `lab-orchestrator/kubernetes-client-deadline`. Run 2 (load ≈ 70): 4 × `Test timed out in 5000ms` in `catalog-api`, `verifier/line-value` (2), `web/student-flow`. Every failing file passes when run alone (exit 0). None is touched by this branch, which changes no product code. |
| `npm run test:security` | exit 0 — 259 + 112 + 82 + 202 + 8 + 196 + 10 = 869 passed |
| `TEST_DB_PORT=55461 make test-db` | exit 0 — 24 + 179 + 20 passed, 0 skipped (the first attempt timed out in `initdb` at load 86) |
| `npm run test:db` without a database | exit 1 (strict), vs exit 0 before |
| `node scripts/check-secret-distribution.mjs` | pass |
| `bash scripts/test-db-backup-restore.sh` | 117 passed, 0 failed |
| `bash scripts/test-private-beta-diagnostics.sh` | all cases passed |
| `bash scripts/test-production-host-scripts.sh` | 52 cases, 0 failed |
| `npm run production:config-check -- --self-test` | PASS |
| `bash scripts/check-observability.sh` | valid |
| `actionlint 1.7.7` (docker, read-only mount) | clean |
| `git diff --check d4e301b HEAD` | clean |

## 5. Needs GitHub-hosted CI

Not claimed from local runs:
- the nine runtime jobs, especially `postgres-integration` under the new strict
  `test:db` and the rewritten isolation step on `ubuntu-latest`;
- `defaults.run.shell: bash` on every job;
- CodeQL `actions` analysis of the edited workflow.

## 6. Residual risks

- `main` has no branch protection and no required checks. CI is advisory until
  an operator changes that.
- `kindest/node:v1.34.0` is referenced by tag. kind recommends a digest that
  matches the kind release.
- Base images are referenced by tag (documented trade-off). `docker:27-dind`
  is stale; that needs a decision.
- vitest GHSA-82fw needs a major upgrade (dev only).
- Images carry no revision label (§3).
- `engines` allows Node 23/24, which no gate exercises.
- The unit suite's 5 s timeouts fail under host load above ~40. Real, but
  environmental.
- Operational note: during the build-context proof, a local command included
  `docker image prune -f`. I stopped it, but the stop came after the command
  had passed that point, so it may have removed **dangling (untagged,
  unreferenced)** images on the shared Docker daemon. No tagged image or
  container can be affected by that command.
