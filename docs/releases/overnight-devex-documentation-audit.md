# Overnight developer-experience and documentation audit

| | |
|---|---|
| **Starting commit** | `24e09f132d522b8de713e696bd0a682f3be74d93` (`origin/main`, merge of PR #54) |
| **Branch** | `feat/overnight-devex-docs` (local only: not pushed, not merged, no PR) |
| **Audit date** | 2026-09-21 |
| **Question** | Could a new engineer or operator understand, develop, test, release, troubleshoot and operate JumpToTech Labs from the repository alone? |

**Answer at the start: no, in several specific places.** Following the README
from a fresh clone produced a stack that `docker compose` refused to start. The
documented lab recipe produced a lab that CI rejects. Two integration suites
reported PASS having run nothing. There was no index of the ~70 documents and no
statement of which one was authoritative. **After this branch**, each of those
paths was re-checked against the repository and works. A contract test now
keeps links, anchors, commands and the documentation map honest. Residual risks
are listed at the end.

Method: static reading, plus commands that start no shared infrastructure and
bind no fixed ports. The commands were `git grep`, the hermetic unit suites,
`docker compose config` (it resolves files and does not contact the daemon),
and the operator scripts' self-tests against fakes. Four read-only research
passes ran in parallel:
- environment variables,
- test skip semantics,
- request flows,
- runbook consistency.

Every finding used below was re-verified by hand before anything changed. Nothing
started Docker containers, kind or compose stacks, and no image was built or
retagged.

---

## Documentation inventory

- 73 Markdown files under `docs/` after this branch (66 before, 7 new), plus
  `README.md` (4,600 lines), `test-support/README.md` and three
  `infrastructure/**/README.md`.
- `package.json` (35 root scripts), 10 workspace manifests, `Makefile`
  (46 targets), 32 entries in `scripts/`.
- 5 root compose files, `e2e/docker-compose.e2e.yml`, and 2 workflows
  (`quality-gates.yml` with `gates` plus 9 runtime jobs, and `codeql.yml`).

What existed and was good: `ci-and-release-gates.md` (already wiring-tested) and
the runbook set (RB-01…RB-21 and incidents A–U, already partly contract-tested).
The production-host procedure is thorough, and `test-support/README.md` is
strong.

What was missing:
- an index;
- a statement of authority;
- a concise architecture page;
- a local test matrix;
- a new-engineer path;
- an operator entry point that ties the runbooks together.

Other problems:
- **Duplicated sources.** The README repeats (and had drifted from) the Makefile,
  `runtime-architecture.md`, `authentication.md` and the CI doc.
- **Records that read like instructions.** Fifteen dated reports sit beside
  current guides and look the same.

## Source-of-truth map

[docs/README.md](../README.md) (new) classifies every file under `docs/` as one of:
- an **authority**, with its subject;
- a **design/curriculum specification**: the real-AWS design and its `AWS_*`
  variables, which nothing reads, and the Docker rebuild plan;
- a dated **record**.

It names one authority each for development, architecture, testing, labs,
production, the private beta, backup/restore, release and incident response.
The root README links to it from a new "Start here" table.
`documentation-contract.test.ts` fails if a new document is not classified.

## Root README findings

| # | Finding | Evidence | Fixed |
|---|---|---|---|
| R1 | Installation told the reader to `cp .env.example .env` and generate one secret. `docker compose` then refuses to start. | With a plain copy, `docker compose --env-file … config` fails: `required variable INTERNAL_SERVICE_SECRET is missing a value`. `NAMESPACE_DERIVATION_SECRET`, the three `SANDBOXD_*` secrets and `OBSERVABILITY_SCRAPE_TOKEN` are also empty in the example and `:?`-required. | Now `npm ci` + `make secrets`. Proven: an env from `ensure-dev-secrets.sh` resolves (exit 0). |
| R2 | "Running locally" started `docker compose up --build`, which runs the base file only (the Kubernetes track). It also said the container tracks need the services on the host. | `Makefile` `COMPOSE` and `make up` add `docker-compose.runtime.yml`, which adds sandboxd. | Now `make up`; the difference is stated. |
| R3 | "`sandbox:build` builds lab-linux and lab-terraform". | `scripts/sandbox-build.sh` builds four images and refuses a partial tag override. | Yes |
| R4 | "Adding a lab … this is the whole process" omitted the flagship learning path. | A copy of `labs/` plus one otherwise-valid lab gives `ERROR LEARNING_PATH_COVERAGE … 1 error` from `validate:labs` (`catalog-validation.ts`). | Step added in the README and in `contributing-labs.md`. |
| R5 | "`labsLoaded` becomes 11 / 21". | 117 labs (`validate:labs`). | Now "goes up by one". |
| R6 | Present-tense claims that authentication is "not in scope" and sandbox sessions are "in memory". | OIDC is in `apps/api/src/auth/` (PLATFORM-009/010, BETA-P0-014). Sessions are in `lab_sessions` (`002_sessions.sql`, `PostgresSessionStore`). The README's own Security section marks both as fixed. | Five places |
| R7 | Two anchors `#security-model` point at a heading renamed to "Security". | contract test | Yes |
| R8 | Named `apps/web/test/multi-track-catalog.test.tsx` twice (a run command and a coverage table), deleted in `c9aa1b6`. | `git log --diff-filter=D` | Now `catalog.test.tsx` |
| R9 | Integration commands used bare `npx vitest run`, and the text said a suite "skips itself" when Docker is missing. It actually reported PASS (see Skip semantics). | — | Strict runner, container targets, and an explicit PASS-vs-skip warning. |
| R10 | "114 labs" (README, Makefile comment). | 117 | Count-free wording |

**Not changed:** the README is still a 4,600-line history of how each story was
delivered. Rewriting it risks conflicts with six concurrent branches. The
"Start here" table now routes readers to the current authorities, and the
"Added by PLATFORM-…" lists are labelled as history (residual risk 9).

## Fresh-clone findings

Walking through as a new engineer with only the repository:

- **Required software.** It is listed (README → Requirements). The Node
  contract was ambiguous: `.nvmrc` = 22, but `engines` accepts `>=22 <25`
  without `engine-strict`. `getting-started.md` now says 22 is the only version
  exercised.
- **First successful command.** There was no statement of which commands need
  nothing. `getting-started.md §2` lists typecheck, validate, test and build,
  and says why they are safe.
- **Environment.** Nothing said that `.env` reaches a container only through
  compose interpolation (there is no `env_file:`). Nothing said that host-mode
  services (`tsx watch`) read no `.env` at all. Both are now documented.
- **Tribal assumptions found:**
  - the shared kind cluster and `:latest` images;
  - the `prod` shell function;
  - that `npm test` skips every integration suite;
  - that macOS cannot run the PTY suites;
  - that `make setup` writes `:latest`.
  All are now written down.

## Command drift

| Location | Drift | Fixed |
|---|---|---|
| `docs/incident-troubleshooting.md` (6 commands) | Bare `docker compose logs` reads only `docker-compose.yml`, so the page's own sandboxd trace could never appear. | `prod logs`; page added to the runbook-command contract (it failed that contract before the fix). |
| `docs/releases/production-host-evidence-template.md` | Recorded `prod up -d --wait` for a step that runs `prod up -d --build --wait --wait-timeout 900`. | Yes |
| readiness §21 vs backup runbook | The upgrade took a `pre-upgrade` backup. The backup runbook, script comment and self-test recover a bad migration from `pre-migration`. | Upgrade uses `pre-migration`. |
| `scripts/db-lib.sh` error text | Advised `docker compose up -d postgres`, which on production re-creates postgres without the overlays. | Names `make db-up` / `prod up -d postgres`. |
| `scripts/production-preflight.sh` message | Pointed at ops §1 for `cluster:up`; the command is in readiness §15. | Yes |
| `alerts/platform.yml` comment | Named a nonexistent `alerts-have-runbooks.test.ts`. | `alerts.test.ts` |
| `docker-compose.production-observability.yml` comment | Named a `$PROD` variable. It is the `prod` shell function. | Yes |
| `RB-18` | Truncated alert name `AttestationAging`. | Full name |
| `docs/runbooks/production-tls.md` | "Needs Node 20+", but `engines` requires ≥22. Its cron log path was outside the `/var/log/jumptotech` directory the host procedure creates. | Yes |
| `test-support/README.md` | "Both image variables are required together." It is all four (`sandbox-build.sh`). | Yes |
| `ci-and-release-gates.md` | "Runtime suites run strictly." `postgres-integration`'s `make test-db` is plain `vitest run`. | Stated, with the reason. |

The operator scripts' documented flags all match the flags they parse, and every
`make`/`npm run` in the runbooks exists (checked; the existing contract already
covered the runbooks directory).

## Environment documentation

Inventory from source, compose files and scripts. No `.env` was read; the only
generated env files were in the scratchpad, checked by variable name, and deleted.

| Finding | Fixed |
|---|---|
| 9 documented variables that nothing reads: `LINUX_MAX_SANDBOXES`, `LINUX_SHELL_USER`, `LINUX_WORKDIR`, `LINUX_SHELL_PATH`, `SANDBOX_EXEC_ALLOWLIST`, `SANDBOX_RUNNABLE_ROOTS`, `SANDBOX_EXEC_TIMEOUT_SECONDS`, `SANDBOX_EXEC_MAX_OUTPUT_KB`, `SANDBOX_ATTACH_IDLE_SECONDS`. Checked with `git grep -w`: 0 references. | Removed, with a note naming what controls each |
| `DOCKER_SOCKET_GID` undocumented, although `make production-preflight` FAILs `DOCKER_SOCKET_GID: MISSING` | Documented |
| `OIDC_JWKS_URI` documented as optional, but no compose file passes it to the api | Documented as ineffective under compose; implementation gap below |
| A comment said the container providers are "effectively off" in compose | Corrected |
| 13 variables assigned twice (same values; the later one silently overrides an edit to the first) | One assignment each |
| My own first correction (91ebc95) wrongly said compose does not read the `SANDBOX_*` values | Corrected in f772775: only the provider switches and `TERMINAL_CONTAINER_EXEC_ENABLED` are pinned |

Classification of the operator-facing variables (required, dev or prod, secret):
see `getting-started.md §3` and the per-variable comments in `.env.example`.
Unsafe development defaults (`AUTH_MODE=development`, placeholders,
`NETWORK_POLICY_ATTESTATION_REQUIRED=false`, `MAX_ACTIVE_SESSIONS=20`) are each
refused in production by the api or `production-config-check`, with one
exception (residual risk 2).

`PUBLIC_ORIGIN` ships as an uncommented `https://your-tunnel-url.example`.
`refuse-on-production.sh` documents this as deliberate. The browser builds the
terminal URL from `window.location` (`apps/web/src/lib/urls.ts`), so it does not
break local terminals. It was left unchanged.

## Architecture documentation

[docs/architecture.md](../architecture.md) (new) covers:
- the ten workspaces, what runs each, their responsibilities and what each talks to;
- the deliberate boundaries;
- where state lives (with and without `DATABASE_URL`);
- the six flows (sign-in, launch, terminal attach, Verify, End, cleanup), by file and function;
- the compose stacks;
- the conventions a new service must meet, each tied to the test that enforces it.

Every cited file and symbol was checked to exist.

## Test matrix

[docs/development/testing.md §2](../development/testing.md#2-the-matrix) (new) lists 11 hermetic commands and
14 infrastructure commands. For each it records:
- what it proves;
- whether it needs Docker, PostgreSQL or kind;
- which host ports it uses;
- whether it is strict;
- which CI job runs it.

## CI matrix

`ci-and-release-gates.md` remains the authority and was already accurate, with
one exception (the strictness claim, fixed). The quality gates are:
- `gates`;
- 9 runtime jobs: `postgres-integration`, `kind-integration`,
  `sandbox-integration`, `networking-integration`, `docker-integration`,
  `terminal-integration`, `sandboxd-integration`, `tls-edge-integration`,
  `browser-e2e`;
- CodeQL `Analyze (javascript-typescript)` and `Analyze (actions)`.

`main` has no branch protection (already documented).

## Skip semantics

**Defect, proven and fixed (f0682d3, c7c73d3).** `apps/api/test/sandbox-integration.test.ts`
(13 tests) and `services/sandboxd/test/sandboxd-integration.test.ts` (7) opened
every test with `if (!enabled) return;`. vitest counts a returned test as
passed.

The proof used no daemon: `DOCKER_HOST` pointed at a nonexistent socket, so the
shared daemon was never contacted.

```text
RUN_INTEGRATION_TESTS=1 npx tsx test-support/strict-vitest.ts test/sandbox-integration.test.ts --root apps/api
before:  Tests 13 passed (13)   exit 0
after:   Tests 13 skipped (13)  exit 1   ::error:: none of its 13 tests ran (skipped)
sandboxd after: Tests 7 skipped (7) exit 1
```

- **Regression protection.** `services/observability/test/suite-skip-semantics.test.ts`
  fails for any `*-integration` test whose first statement is a bare conditional
  `return`. It detects all 13 cases in the pre-fix file. The file was first
  named `integration-skip-semantics.test.ts`; the repo-wide
  `test-classification.test.ts` caught that name, and c7c73d3 renamed it.
- **Documentation.** `testing.md §1` defines PASS vs SKIPPED (infrastructure
  unavailable) vs NOT RUN. The README, `test-support/README.md` and the CI doc
  say that plain `vitest run` / `npm run test:integration*` / `make test-db`
  exit 0 when everything skipped.
- **Not fixed.** `test:db` is still non-strict (residual risk 1).

## Makefile findings

- **`make down` had no production guard.** `up`, `rebuild`, `up-kubernetes-only`,
  `db-up`, `clean` and `sandbox-clean` all have one. On the production checkout,
  `make down` removes every platform container using the development file list
  (site offline, monitoring orphaned). Now refused there (7c3bd89), and pinned
  in `production-host-contract.test.ts`.
- **`setup` help text** omitted that it builds `:latest` sandbox images. Fixed.
- **Recorded, not changed:**
  - `test-integration` uses the legacy `kubeconfig-host.yaml`, while
    `beta-validate` uses `kubeconfig-host-$LAB_CLUSTER_NAME.yaml`.
  - `logs` and `db-shell` use development files (harmless on production, but
    incomplete).
  - `test-integration`, `test-sandbox`, `test-tls-edge` and `test-db` are
    non-strict (documented).

No target was removed.

## Script discoverability

All 32 `scripts/` entries are classified in
[getting-started.md §6](../development/getting-started.md#6-scripts-and-make-targets-what-is-safe-where),
by purpose and by whether they change state. The dangerous ones are named with
their preconditions:
- `cluster-down.sh` (a shared cluster; its lease file sees only this checkout);
- `sandbox-build.sh` (writes `:latest`);
- `sandbox-clean.sh`;
- `db-restore.sh --replace`;
- `tls-install.sh`;
- `verify-network-policy.ts --write-attestation`;
- `make clean` and `docker compose down -v`.

No scripts were renamed.

## Runbook consistency

The checks agreed on:
- the `prod` definition, which is identical in ops §1, `jtt_prod`,
  `production-host-contract.ts` and `production-config-check.ts`;
- alert names against runbook files (61 rules, every `runbook_url` resolves);
- RB numbering (RB-20 does not exist and nothing references it);
- compose service names;
- health endpoints;
- the checkout path (`/srv/jumptotech-labs`; no script hard-codes it).

The contradictions fixed are listed under Command drift. Also fixed:
`observability.md` said the metrics listener binds 127.0.0.1. It binds
`OBSERVABILITY_HOST` (default `0.0.0.0`, because Prometheus scrapes over the
compose network). Loopback is the host publication in development; production
publishes nothing.

Recorded, not changed (the DR and other audits own these areas):
- the `BACKUP_DIR` defaults differ between preflight and `db-backup.sh`;
- `tls-install.sh` defaults to 3 compose files where `prod` uses 5;
- the release gate §8 says "RB-01…RB-19" (a dated section).

## Release documentation

The release path as it exists, now stated in one place
([operator-guide.md §3](../runbooks/operator-guide.md#3-releases-versions-and-rollback-as-they-exist)):
- merge to `main` and read the CI run by commit;
- check out on the host and `npm ci`;
- set `JTT_COMMIT` in `.env` by hand;
- `prod up -d --build`, which builds the images on the host (there is no registry);
- config check, preflight, smoke, evidence.

Every step is manual. No automation was invented.

## Rollback documentation

Readiness §21.2 is accurate. The operator guide now says:
- **What is rolled back:** code, `.env`, and images (by rebuilding).
- **What is not:** the database (forward-only migrations; restore the
  `pre-migration` archive, and writes after it are lost) and running sandboxes.
- **How health is revalidated:** preflight, and the smoke with `release.commit`.

## Troubleshooting

[operator-guide.md §4](../runbooks/operator-guide.md#4-symptom--where-to-go) maps 19 symptoms to an incident
letter (A–U) and to the runbooks that incident actually cites. The mapping was
extracted from the incident runbook, not assumed. §5 covers logs and metrics
through `prod logs`, `ready`, `q`, `alerts`, `ops`, the cron logs and the
diagnostics bundle. Grafana, Prometheus and Alertmanager stay tunnel/exec-only.
§6 is an 11-step incident checklist and §7 the on-call handoff facts.

## macOS vs Linux/CI

[testing.md §3](../development/testing.md#3-which-platform-can-run-what) covers:
- **PTY.** `pty.spawn` fails with `posix_spawnp failed` on macOS, so use the
  container targets. CI proof: `terminal-integration`, `sandboxd-integration`.
- **Bind mounts.** Docker Desktop hides bind-mount ownership. Proof needs a
  Linux host (readiness §18.1).
- **Docker socket group.** `DOCKER_SOCKET_GID=0` works only on Docker Desktop.
- **Architecture.** Local evidence is arm64; CI runs amd64.
- **Operator-socket path length.**
- **Where the proof lives.** `/proc`, capabilities and NetworkPolicy are proven
  only in `kind-integration`, `networking-integration` and `sandbox-integration`.

No suite branches on `process.platform`: every difference is a probe that turns
into a skip.

## Link integrity

Every relative link and every anchor into Markdown now resolves, in all
maintained documents and records (`labs/` excluded). Before this branch there
were two broken anchors, both in the README (R7), and the README named a deleted
test file in a command (R8). The dated records had no broken links. All of this
is checked on every `npm test`.

## Security documentation findings

A scan of tracked Markdown, YAML and `.env.example` for private keys, cloud and
GitHub tokens, JWTs and webhook URLs found only two AWS-access-key-shaped
strings. Both are in `labs/aws/aws-001-credentials-and-arns/lab.yaml` and both
carry AWS's documented `EXAMPLE` marker (lab content for a simulated track).
**No potential secret requires rotation.**

Otherwise:
- no `curl -k`;
- the `0.0.0.0` bindings appear only in "before" tables of fixed exposures;
- no public-exposure instructions; Grafana stays tunnel-only.

Values were never printed during the audit.

## Version traceability

An operator can trace `JTT_COMMIT`:
- the api, terminal and sandboxd start-up log line;
- the `jtt_build_info{commit}` metric;
- the smoke's `release.commit`;
- the checkout's `git rev-parse HEAD`;
- `gh run list --commit`.

Gaps (documented; implementation belongs to the release-identification work):
- `JTT_COMMIT` is operator-asserted in `.env`, not baked into the image;
- images carry no `org.opencontainers.image.revision` label;
- the web container reports no commit;
- there is no version endpoint.

`ci-and-release-gates.md §6` already said the images carry no label; that is
consistent.

## Tribal knowledge removed

Each item was verified against code or scripts and is now written down:
- `prod` is a shell function, and bare `docker compose` misses sandboxd;
- a production checkout is recognised by the TLS key or `unless-stopped`, not by
  its path;
- `.env` reaches containers only by compose interpolation; host-mode services
  read none;
- `npm test` skips every integration suite, and plain `vitest run` exits 0 on
  all-skipped;
- macOS cannot run the PTY suites;
- `make setup` / `sandbox:build` write `:latest` unless all four image variables
  are set;
- the kind cluster is shared, and its lease guard sees only this checkout;
- every lab must be placed in the flagship learning path;
- `JTT_COMMIT` must be updated by hand on every deploy;
- readiness ignores providers;
- the attestation must be re-proven after the five-student gate;
- the backup-directory defaults differ;
- `prod stop web` survives reboots.

---

## Defects found

1. The README's Installation path yields an env that `docker compose` refuses (R1).
2. The README ran the Kubernetes-only stack and said the container tracks need
   host mode (R2).
3. The README's lab recipe fails `validate:labs` (R4).
4. Two integration suites reported PASS without running (Skip semantics).
5. `make down` had no production-checkout guard.
6. `incident-troubleshooting.md` used bare `docker compose` and could not show sandboxd.
7. `observability.md` misstated the metrics listener's bind address.
8. The evidence template recorded the wrong start command.
9. The upgrade backup label disagreed with the recovery runbook.
10. The `db-lib.sh` error advice is unsafe on production.
11. Stale README claims: auth, in-memory sessions, 114 labs, image count,
    labsLoaded values (R3, R5, R6, R10).
12. Broken README anchors (×2) and a deleted test path (R7, R8).
13. `test-support/README.md`: "both" image variables (it is all four).
14. The CI doc's strictness claim.
15. 9 dead `.env.example` variables.
16. `DOCKER_SOCKET_GID` undocumented.
17. `OIDC_JWKS_URI` documented as settable under compose.
18. 13 duplicate `.env.example` assignments.
19. `production-tls.md`: Node 20+, and a cron log path outside the created directory.
20. Wrong pointers: the preflight message, the alert-rule comment, the compose
    `$PROD` comment, the RB-18 alert name.
21. Missing documentation index, architecture guide, test matrix, onboarding
    path, operator entry point and contributor guide.

There were also two defects in this branch's own work, both caught by
validation and fixed: the classifier-violating test name, and the wrong
`.env.example` compose note.

## Defects fixed

All of 1–21, in the commits below.

## Contract tests added

| Test | Pins |
|---|---|
| `services/observability/test/documentation-contract.test.ts` (new, 11 tests) | Relative links and anchors resolve. `docs/README.md` links every document under `docs/` exactly once. In the authorities, every `npm run` script, `make` target and `test/… --root <ws>` file named in code exists. On the pre-audit README it fails 3 ways (the anchors ×2 and the deleted test file). |
| `services/observability/test/suite-skip-semantics.test.ts` (new, 31 tests) | No integration test opens with a bare conditional `return`. |
| `beta-operations-contract.test.ts` (extended) | `incident-troubleshooting.md` is held to the runbook-command rules (no bare compose, real services and targets). |
| `production-host-contract.test.ts` (extended) | `make down` runs the production guard before `$(COMPOSE) down`. |

## Commits created

| Commit | Subject |
|---|---|
| `f0682d3` | test(integration): a suite with no runtime reports skipped, not passed |
| `7c3bd89` | fix(make): `make down` refuses on a production checkout, like `up` |
| `be5e2cd` | docs(ops): runbook commands and pointers match what exists |
| `b3f7ef6` | docs(dev): a fresh clone follows instructions that work, and a skip reads as a skip |
| `56bb4d4` | docs: one map of which document is authoritative, an operator guide, and a contract |
| `91ebc95` | docs(env): .env.example documents only variables something reads |
| `1aaaf94` | docs(dev): say exactly what the cluster lease and `make setup` do |
| `c7c73d3` | test: rename the skip-semantics contract out of the integration namespace |
| `f772775` | docs(env): one assignment per variable, and a correct note on what compose pins |
| this report | docs(releases): overnight developer-experience and documentation audit |

## Validation performed

Run on Node 22.23.2, npm 10.9.8, macOS, after `npm ci` in this worktree:

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0, 0 errors |
| `npm run build` | exit 0 |
| `npm run validate:labs` | 117 labs, 0 errors, 0 warnings |
| `npx vitest run --root services/observability` | 986 passed, 38 skipped (the gated TLS-edge integration file). Exit 0. |
| `test-classification.test.ts` (lab-orchestrator) | 6/6 (failed 5/6 before c7c73d3) |
| api: `runtime-owner`, `secret-boundaries`, `session-capacity-config` | 37/37 |
| api: `browser-e2e-overlay`, `five-student-beta-contract`, `operations-metrics` | 56/56 |
| terminal `secret-boundaries` | 26/26 |
| web `no-server-secrets` | 5/5 |
| progress `backup-restore-safety` | 30/30 |
| `sandbox-integration` / `sandboxd-integration`, ungated | 13 / 7 **skipped** (expected) |
| The same two suites, gated, with no daemon reachable, under `strict-vitest` | exit 1: all skipped (the intended failure) |
| `bash scripts/test-db-backup-restore.sh` | 132 passed, 0 failed |
| `bash scripts/test-production-host-scripts.sh` | 58 cases, 0 failed |
| `ensure-dev-secrets.sh` into a scratch file, then `docker compose config -q` (dev files) | exit 0. A plain copy of `.env.example` gives exit 1. |
| `git diff --check` | clean before every commit |

## Validation deferred

- **Full `npm test`.** DEFERRED DUE TO CONCURRENT OVERNIGHT AUDITS: load average
  45–63 on 10 cores. The workspaces and files this branch touches were run as
  listed above. The rest of `npm test` (all of api, lab-orchestrator, verifier,
  web, terminal, sandboxd and progress beyond the files named) was **not run**.
- **Every infrastructure suite.** NOT RUN, by instruction: kind, Docker
  integration, `make test-db`, the restore drill, the terminal/sandboxd
  container targets, TLS edge, browser E2E and `beta-validate`. The two edited
  integration suites have **not** been run with a real runtime. With Docker
  present their probe passes and the test bodies are unchanged; CI's
  `sandbox-integration` and `sandboxd-integration` jobs are the proof.
- **`make observability-check`, `make secrets-check`.** Not run: unaffected
  apart from comments, and CI's `gates` runs them.

## Known residual risks

1. **`postgres-integration` is not strict.** `npm run test:db` is plain
   `vitest run`, and the progress workspace's guard cases skip by design under
   `RUN_DB_TESTS`. A skip there would not fail CI.
2. **`TERMINAL_CONTAINER_EXEC_ENABLED` has no production refusal** (default
   `true` in `services/terminal/src/config.ts`; no check in the production
   contract). It is safe today only because `docker-compose.yml` pins it
   `"false"`. For the security/reliability owners.
3. **`OIDC_JWKS_URI`** and the broker/database TLS file variables are read by
   code but passed by no compose file. An identity provider without discovery
   cannot be used under compose.
4. **`BACKUP_DIR` defaults differ:** preflight uses `/srv/jumptotech/backups/postgres`,
   `db-backup.sh` uses `<checkout>/backups/postgres`. Documented; the DR audit
   owns the fix.
5. **`tls-install.sh`** defaults to 3 compose files while `prod` uses 5.
6. **Version traceability** relies on the operator setting `JTT_COMMIT`; no
   image label; the web container does not report a commit.
7. **`make test-integration`** uses the legacy `kubeconfig-host.yaml`, and
   `make logs` / `make db-shell` use development files.
8. **`main` has no branch protection** (repository setting).
9. **The README is still a 4,600-line history.** "Start here" routes around it,
   but its long sections are only as current as the contract test can check
   (links, commands, paths), not their prose.
10. **Concurrent branches.** Other overnight branches edit the same files
    (README, `.env.example`, runbooks). Merge conflicts are likely and textual;
    re-run `documentation-contract.test.ts` after each merge.

---

## New engineer checklist

- [ ] Node 22 (`nvm use`); `npm ci` leaves the lockfile unchanged.
- [ ] `npm run typecheck`, `npm run validate:labs`, `npm test`, `npm run build`.
- [ ] Read [architecture.md](../architecture.md), then [testing.md §1](../development/testing.md#1-pass-skipped-and-not-executed).
- [ ] `make setup && make up`; start, Verify and End one Linux lab at http://localhost:3000.
- [ ] Know which suites need Docker, PostgreSQL, kind or a PTY, and that macOS skips the PTY suites.
- [ ] Know the state-changing scripts ([getting-started.md §6](../development/getting-started.md#6-scripts-and-make-targets-what-is-safe-where)).
- [ ] First change: test in the same workspace, the hermetic set green, the relevant integration suite strict or declared not run, `git diff --check`.

Full version: [getting-started.md §7](../development/getting-started.md#7-new-engineer-checklist).

## New operator checklist

- [ ] Read [operator-guide.md](../runbooks/operator-guide.md), then [private-beta-operations.md](../runbooks/private-beta-operations.md) §1–§3.
- [ ] Define `prod`, `q`, `ready`, `alerts`, `ops`; never use bare `docker compose` on the host.
- [ ] Configuration: `make secrets-check`, `make production-config-check`. Preflight: `make production-preflight`.
- [ ] Start with readiness §15; health with ops §2; smoke with `make private-beta-smoke`; capacity from both gauges.
- [ ] Backups: the cron in ops §1.2; verify; restore `--into` before `--replace`.
- [ ] Release and rollback: readiness §21, and what a rollback does not undo.
- [ ] Incidents: A–U, the "never do" list, `make private-beta-diagnostics`, the evidence template.

Full version: [operator-guide.md §8](../runbooks/operator-guide.md#8-new-operator-checklist).
