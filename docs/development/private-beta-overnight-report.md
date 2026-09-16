# Private-beta overnight hardening — report

**Branch** `feat/beta-overnight-hardening`, branched from `cb7804a`
**Date** 2026-09-16
**Scope** production readiness, reliability, security, operations and
beta validation for a controlled private beta of about five trusted students.
**Companion** [private-beta-release-gate.md §11](../releases/private-beta-release-gate.md)
is the dated re-validation this pass produced. This file is the working record
behind it: what was looked at, what was found, what was deliberately left
alone, and what is still not proven.

---

## Executive summary

The platform was already in good shape. The BETA-P0-010…P0-020 sequence left a
repository where the interesting failure modes have been thought about, written
down and tested, and most of tonight was spent confirming that rather than
repairing it. Four defects and two gaps were found and fixed, each with a
regression test that fails against the previous code.

The single most important finding is not one of those fixes. It is that
**`main` has moved sixteen commits past the release gate's evidence, and the
five-student runtime gate has not been re-run since**. Three feature merges —
the student web experience, learning paths, and three networking labs — landed
after `c8eb2c6` and have never been through `make beta-validate`. Every gate
that can be run without a live stack was re-run tonight on the current tree and
passes; the one that exercises five concurrent students on the real runtime was
not, and that is the gap to close before students arrive.

The defects, in the order they matter:

1. **A student-planted symlink redirected the session workspace.** Reads
   followed it out of the session — including into files only the terminal
   *service* can open, which the uid drop exists to keep from student shells —
   and a lab reset wrote the baseline *through* it, outside the session, with
   the service's identity. Both probed against the shipped code before fixing.
2. **No compose file declared a `restart:` policy.** Nothing in the production
   stack came back on its own: a crashed api, an OOM-killed terminal, or a
   reboot left the platform down until an operator looked.
3. **A restarting service can hide from `ServiceDown`**, which is a consequence
   of fixing (2) and needed its own alert.
4. **An unreadable workspace answered a student with 500 INTERNAL_ERROR**
   instead of the designed `ENVIRONMENT_UNREACHABLE`, and moved none of the
   metrics the verification alert watches.

Nothing was weakened. No capacity, isolation, authentication or exposure
contract changed. The release-gate verdict stays **GO (conditional)**, with one
condition added: re-run the five-student gate on the tree that ships.

---

## Repository baseline

| | |
|---|---|
| Worktree | `~/jtt-beta-overnight`, branch `feat/beta-overnight-hardening` |
| Base | `cb7804a` (`main`) |
| Node | v22.23.2, npm 10.9.8 |
| Workspaces | `apps/api`, `apps/web`, `services/{lab-orchestrator,observability,progress,sandboxd,terminal,verifier}`, `test-support` |
| Catalog | 117 labs (ansible 10, aws 11, cicd 10, cs 13, docker 14, kubernetes 19, linux 17, networking 10, terraform 13) — the docs still say 114 in several places |
| Compose | 5 files: base, runtime, observability, production, production-observability |
| CI | `.github/workflows/quality-gates.yml` (8 jobs), `codeql.yml` |
| Alerts | 58 → 59; 10 rule files; 19 runbooks (RB-01…RB-19) plus 4 topic runbooks |

`grep` for `TODO`, `FIXME`, `HACK`, `XXX` across `apps`, `services`, `scripts`,
`infrastructure` and `test-support` returns nothing but `mktemp` templates. No
`.env`, key, certificate, kubeconfig or database archive is tracked; every
credential directory (`nginx/tls`, `alertmanager/secrets`,
`observability/secrets`) carries its own `.gitignore`.

### The gap between the gate and `main`

`docs/releases/private-beta-release-gate.md` §3 is evidence against `c8eb2c6`.
`HEAD` was `cb7804a`. In between:

| | |
|---|---|
| `82e1ec1` | student beta experience (web) |
| `ad20ea8` | guided learning paths, `/api/learning-paths`, the first per-route rate limit |
| `4a4f949` `33aa63b` `cb7804a` | NET-022, NET-024, NET-025 |

None of those went through the release gate. That framed the whole night: the
first job was to find out whether the gate still holds on the tree that would
actually ship.

---

## Tests run, and exact results

All on one development machine (Docker Desktop, 10 CPU, 7.65 GiB VM), which was
already carrying two compose stacks and four kind clusters belonging to other
work.

### Hermetic and static gates — all PASS on the final tree

| Command | Result |
|---|---|
| `npm run typecheck` | PASS, 8 workspaces |
| `npm test` | **PASS — 4,687 passed, 0 failed, 347 skipped**, exit 0 |
| `npm run test:composition` | PASS — 25 |
| `node scripts/check-secret-distribution.mjs` | PASS — all 5 stacks |
| `bash scripts/check-observability.sh` | PASS — 10 rule files, 82 rules, 4 alert-test files |
| `bash scripts/test-db-backup-restore.sh` | PASS — 117 |
| `npm run build` | PASS |

`npm test` by workspace: api 583, web 195, lab-orchestrator 1,260,
observability 704, progress 96, sandboxd 138, terminal 152, verifier 1,559.

### Local Docker gates — all PASS

| Command | Result |
|---|---|
| `TEST_DB_PORT=55450 make test-db` | PASS — session store 173, auth/progress persistence 20, progress suite |
| `JTT_TEST_RUN_ID=ovn1 bash scripts/db-restore-drill.sh` | PASS in 16s — backup, source destroyed, fresh server, restore, identical fingerprint, migrations current, application read **and** write |
| `make test-tls-edge` (real web image, test-only certs) | PASS — 36 |
| `docker compose … config` over the five production files | renders; 443/80 public, Grafana `127.0.0.1:3001` in Prometheus's namespace, nothing else published |

### Not run, and why

| | |
|---|---|
| `make beta-validate` | Needs the running stack + kind + the observability profile. The machine already held two stacks and four kind clusters; a third stack risked both them and a concurrent session's work, and `compose`/`kind` cross-stack DNS makes a third stack actively hazardous. **This is the meaningful gap.** |
| `npm run verify:network-policy` | Needs a dedicated kind cluster |
| kind / docker / sandboxd / terminal / networking integration jobs | CI builds each on its own runner |
| CI on this branch | Not pushed at the time of writing |

### Two load-sensitive flakes, reported rather than patched

Both pass in isolation and on repeat; neither is a platform defect.

- On the first `npm test` of the night, `apps/api/test/catalog-api.test.ts`
  "renders every shipped lab through the same projection" failed with
  `socket hang up`. It passed 3/3 alone and the api suite passed 2/2 straight
  after. That test opens one ephemeral supertest server per lab — 117 of them.
- Running all eight workspaces **concurrently** (not what `npm test` does — it
  runs them sequentially) produced four `Test timed out in 5000ms` failures in
  `catalog-api.test.ts` and `apps/web`'s `live-payloads` / `student-flow`.

Measured: the same tests take 139–215 ms on an idle machine, ~2.0–2.4 s inside
the full sequential api suite on this loaded laptop, and over 5 s under 8-way
concurrency. So the work is small and the margin is schedule contention. CI
runs on a clean runner and the gate reports PASS there.

Left alone deliberately: bumping a timeout to make a symptom go away is not a
fix, and the cause here is the machine, not the code. The real observation is
that these catalog-scale tests have **no explicit timeout** and their margin
shrinks as the catalog grows — see *Exact recommended next step*.

---

## Security findings

The audit covered authentication, authorization, session ownership, student and
terminal isolation, Docker access, Kubernetes namespace isolation, Pod Security,
NetworkPolicy, filesystem traversal, command injection, environment and secret
leakage, rate limiting, session caps, public ports, Grafana and PostgreSQL
exposure, TLS, CORS, security headers and WebSocket authorization.

Most of it is genuinely well done and is left untouched. Worth recording
because an audit that reports only what it changed is not an audit:

- **Every `child_process` use is `execFile`** — no shell anywhere in
  `apps/` or `services/`.
- **`sandboxd`'s scope model** (`services/sandboxd/src/scopes.ts`) is the right
  shape: one secret per capability, scope decided by *which secret matched*
  rather than by anything a caller asserts, unconfigured scope denies, equal
  secrets refused at startup, constant-time comparison, and endpoint matching
  that is exact rather than prefixed.
- **`/internal` re-proves ownership** against the live session row rather than
  trusting a valid token, so a token outlives neither its session's ownership
  nor the owner's account.
- **The terminal drops uid inside the process** so its `/proc` closes to the
  shells it hosts — which is exactly what made finding 1 below matter.
- **Production publishes 443 and 80 and nothing else**, on any interface;
  PostgreSQL is alone with the api on an `internal: true` network; Grafana is
  loopback-only inside Prometheus's namespace; only `sandboxd` mounts the
  Docker socket. Re-proven tonight from `docker compose config`.

### Finding 1 — a student-planted symlink redirected the session workspace (fixed)

**Where** `services/terminal/src/workspace.ts`.

A Docker-track student's authored files live in the terminal container, in a
per-session directory they own. `resolveWorkspaceFile` rejects absolute paths,
`..` and backslashes and re-checks the resolved string — but it is pure path
arithmetic and cannot see a symlink, and both callers acted on the string it
returned.

Probed against the shipped code before changing anything:

```
READ RESULT:     "TERMINAL_SESSION_SECRET=leaked\n"
SEED TARGET NOW: "written-through\n"
```

- **Read.** `Dockerfile -> /proc/self/environ` made the verifier's read return
  *this service's own environment* — `TERMINAL_SESSION_SECRET`,
  `INTERNAL_SERVICE_SECRET`, `SANDBOXD_ATTACH_SECRET`. The BETA-P0-010 uid drop
  closes that `/proc` entry to student shells; following the link handed it back
  through a file the student chose. A link into another session's workspace
  defeated the HMAC directory name the same way.
- **Write.** A lab reset wrote the declared baseline *through* a planted link,
  putting student-chosen content at a student-chosen path outside the session,
  with the service's identity.

**Why it is not just §6's shared-uid limitation.** That one is a student
reading, as uid 1001, what uid 1001 owns. This was a student directing the
*service* to read and write on their behalf, which reaches files uid 1001
cannot open.

**Exploitability, stated honestly.** The read channel is narrow: the lab
declares the path, and the handlers report a byte count, a Dockerfile-parse
verdict and the `FROM` token, not the contents. It is an oracle, not a dump.
The write side is the more serious half. Neither is a reason to leave a
boundary the module's own docstring claimed to enforce.

**Fix** (`0881d19`) — in the two operations, because only an operation can ask
the filesystem where a path really leads:

- `read` resolves through `realpath` and re-checks containment against the
  resolved workspace root. A link that stays inside the session still reads.
- `seed` opens with `O_NOFOLLOW`, so no race can make the write land outside,
  and checks the resolved parent directory separately because `O_NOFOLLOW`
  covers only the final component. A link in the way is unlinked and the
  baseline written in its place — refusing would let a student break their own
  reset, and `unlink` removes the link, never its target.

**Tests** — 5 new cases in `workspace.test.ts` (4 fail against the previous
code) plus the HTTP boundary in the new `workspace-endpoints.test.ts`.

### Finding 2 — the same class, in the credential tmpfs (not fixed; no demonstrated impact)

`writeSessionKubeconfig` and `writeSessionDockerCerts` write into
`/run/jumptotech`, a tmpfs owned by uid 1001 — the same account student shells
run as, so a student can plant a link at their own session's credential path.

Left alone, deliberately. What gets written is the student's *own* credential,
and the reachable targets are paths uid 1001 can already write. Redirecting it
at another session would need that session's server-generated id, which nothing
discloses across students. `O_NOFOLLOW` here would be cheap and consistent, and
is listed under *Operator decisions* as hardening rather than smuggled in as a
fix for a problem that was not demonstrated.

### Finding 3 — the internal workspace endpoints had no test (fixed)

`/internal/workspace/{read,seed,destroy}` in `services/terminal/src/server.ts`
are a trust boundary — the shared-secret gate, the body caps, and the mapping
from a path refusal to a 400 rather than a 500 — and nothing covered them. The
unit suite stopped at the class; the Docker integration suite uses its own
`TempDirWorkspace`. 13 cases added (`cae9f10`).

### Not a finding

- The `read_only: true` that `api` and `sandboxd` carry is **absent on
  `terminal`**. Adding it would need every writable path to be a tmpfs and can
  only be judged by running a real student shell against it. Listed as
  hardening, not changed blind.
- `MAX_ACTIVE_SESSIONS` defaults to 20 while the beta contract is 5. Not a
  vulnerability, and the fix is an operator check — see *Runbook changes*.

---

## Reliability findings

### Finding 4 — nothing in production restarted itself (fixed)

No compose file in the repository declared a `restart:` policy. Compose restarts
nothing on its own, so a crashed api, a terminal the kernel killed for memory, a
PostgreSQL that fell over, or a host reboot left the platform down until an
operator happened to look — and the runbook's health check is "five minutes
before every class", which is not a supervisor. For a beta running unattended
between sessions this was the largest single reliability gap left.

**Fix** (`fda7eeb`) — `restart: unless-stopped` on all eight production
services, in the two production overlays only.

- `unless-stopped`, not `always`: `prod stop web` is the runbook's only way to
  take the site down, and `always` would bring it back at the next daemon start.
- Development keeps **no** restart policy, and the contract test pins that too,
  so the two stacks cannot drift together. A container that died on a laptop
  should stay dead where it is read.
- The observability trio share Prometheus's network namespace, so restarting the
  leader had to be shown not to strand them. **Measured** with a two-container
  probe rather than assumed: a restart keeps the leader's `SandboxKey`
  (`/var/run/docker/netns/c0b53e067a83`, unchanged across the restart) and the
  follower still reached its loopback listener afterwards. Re-creating
  Prometheus is a different thing, and runbook §6 already covers it.

### Finding 5 — a restarting service can hide from `ServiceDown` (fixed)

Directly caused by fixing (4), and found by asking what the change did to
detection rather than by waiting for it to bite. `ServiceDown` is
`up == 0 for: 2m` — two *continuous* minutes. A container that dies, restarts,
serves one scrape and dies again never supplies them. Before the restart policy
a crashed service supplied them by staying dead.

**Fix** (`601eadd`) — `ServiceRestartLoop`:
`changes(up{job=~"api|terminal|sandboxd"}[15m]) >= 6`, `for: 2m`, warning.

- `changes()` rather than an average over `up`, so a service that is simply
  gone contributes no transitions and stays `ServiceDown`'s to report — and
  Alertmanager's existing ServiceDown inhibit rule suppresses this one
  underneath it.
- Six in fifteen minutes is three full down-up cycles: more than an operator
  restarting by hand, far fewer than a real loop, which Docker's one-minute
  backoff ceiling puts near fifteen.
- No `service` label, matching `ServiceDown`'s shape, so the existing inhibit
  rules keep applying unchanged.
- 3 promtool cases against the shipped rule file; the crash-loop case fails
  against the previous `platform.yml` (verified by restoring it).

### Finding 6 — an unreadable workspace answered a student with a 500 (fixed)

`verifyLab`'s unreachable-environment branch recognised only the Kubernetes and
Docker errors, so `WorkspaceUnavailableError` — thrown whenever the terminal
service is restarting — escaped. Three consequences, all in the wrong direction
for the one moment an operator needs the truth:

- `POST /api/sessions/:sessionId/check` answered 500 INTERNAL_ERROR, telling a
  student the platform broke rather than that the environment was unreadable;
- no check was reported `skipped`, so the response said nothing about what had
  not been graded;
- the route never reached its `result.error` branch, so
  `jtt_verification_errors_total` — the series RB-13's alert watches — did not
  move, and the outage was invisible.

**Fix** (`fcf33b8`) with its own substrate wording, and a regression test that
throws from a `WorkspacePort`.

### Looked at and found sound

- **The reaper** (`services/lab-orchestrator/src/session/reaper.ts`) — four
  reasons to delete, one recovery that deletes nothing, idempotent throughout,
  and a blast radius that cannot reach `default` or `kube-system` even with a
  hand-labelled namespace. The orphan sweep distinguishes a finished session's
  sandbox from an unknown one and routes each through the right destroy.
- **Session start** counts capacity and inserts in one durable step, and every
  status change is a fenced `#transition` — including the conditional
  `CREATING → ACTIVE` that stops a start from resurrecting a session a teardown
  already ended.
- **Health and readiness** (`services/observability/src/health.ts`) already draws
  the distinction Phase 5 asks for, with the reasoning written down: `/livez`
  checks nothing, `/readyz` checks only what stops *this instance* serving,
  readiness deliberately does not check providers or downstream services, and
  cached probes go stale rather than lying. The api's `/readyz` checks the lab
  registry and a cached database probe; the terminal's `checks: []` is
  deliberate and argued. Production's api healthcheck is `/readyz`, not
  `/health`.
- **Graceful shutdown** — all three services handle SIGINT/SIGTERM. One
  asymmetry: the terminal has an unref'd 3-second escape hatch after
  `server.close()`, the api has none, so an api holding a keep-alive connection
  waits for Docker's 10-second SIGKILL. Minor, untestable from a unit suite,
  and left alone; noted here because it is the kind of thing that looks like a
  new bug later.

---

## Five-student concurrency findings

No new defect found by reading, and none of this was re-proven at runtime
tonight — see *External items NOT proven*.

The mechanisms are in place and tested at unit level: global and per-student
limits enforced atomically in one PostgreSQL transaction under an advisory lock
(`make test-db`, 173 session-store cases); fenced transitions for every status
change; `DEGRADED` plus `status_changed_at` for interrupted resets; the reaper
adopting abandoned Ends at 5 minutes and interrupted resets at 10.

The one concurrency-adjacent risk found is configuration, not code:
`MAX_ACTIVE_SESSIONS` defaults to **20** in both `.env.example` and
`apps/api/src/config.ts`, and the beta contract is 5. A deployment whose `.env`
missed the line runs at four times the intended ceiling and looks perfectly
healthy — headroom reads 20, no alert fires, and the first symptom is a host
sized for five students carrying four times the sandboxes. The api already
exports `jtt_sessions_capacity_limit` and the dashboard shows it; it was simply
missing from the CLI check an operator actually runs. Fixed in the runbook
(`589d65f`).

---

## Production compose findings

Rendered with the repository's own command over all five files and inspected
service by service.

| Checked | Result |
|---|---|
| Published ports | `web` 443→8443 and 80→8080 only. `api`, `terminal`, `sandboxd`, `postgres`, `alertmanager`, `grafana` publish nothing. `prometheus` publishes `127.0.0.1:3001→3000`, which is Grafana inside the shared namespace |
| Internal networks | `postgres` on `database` only (`internal: true`), with `api`. No monitoring container on `sandboxes`, `kind` or `database` |
| Docker socket | `sandboxd` only, in every file |
| Healthchecks | `api` → `/readyz` 9400; `terminal` → `/livez` 9401; `web` → `jtt-tls-preflight served`; `postgres` → `pg_isready`; `sandboxd`, `prometheus`, `alertmanager`, `grafana` from their images |
| Dependency ordering | `api` → postgres + sandboxd healthy; `terminal` → api + sandboxd healthy; `web` → api healthy |
| **Restart policies** | **were absent everywhere — fixed, see Finding 4** |
| Resource limits | `terminal` 512m/256 pids, `sandboxd` 512m/512 pids. `api`, `postgres`, `web` and the monitoring containers have **none** |
| Secrets | `make secrets-check` PASS; every required variable is `${X:?...}` with no default |
| Volumes | `./labs` read-only into api; TLS directory and ACME webroot read-only into web; `BACKUP_STATUS_DIR` read-only into api |

**Left alone deliberately:** the missing memory limits on `api`, `postgres` and
`web`. A wrong limit on PostgreSQL is worse than none — it turns a slow query
into an OOM kill — and the gate's own §8 says the resource figures are one
laptop's observations, not a capacity plan. This is an operator decision on the
chosen host, not a number to invent here. It is listed below.

---

## Backup / restore findings

No production credentials were used; every server was disposable and
label-scoped.

- `bash scripts/test-db-backup-restore.sh` — **117 passed, 0 failed**. Covers
  the refusals and failure paths against a fake daemon: a failed dump leaves
  nothing that looks like a backup, retention touches only its own archives,
  `BACKUP_STATUS_DIR` equal to or containing `BACKUP_DIR` is refused so the
  api's mount can never carry archives, an unwritable status directory is
  reported without failing the backup, a corrupt archive is refused before the
  server is contacted, and the password sentinel appears in no output, log,
  Docker argument or file name.
- `scripts/db-restore-drill.sh` — **PASS in 16 s**: backed up, destroyed the
  source, started a fresh server, restored, compared fingerprints (9 tables,
  schema, sequences, ledger — identical), confirmed migrations current and both
  read and write through the real repository. The restore itself took 2 s.
- The drill is well isolated: a unique `$prefix` from `JTT_TEST_RUN_ID`, its own
  label, ephemeral loopback ports, a random password handed over a 0600 env
  file, and a cleanup trap on EXIT/INT/TERM. No leftovers after the run.
- `--replace` renames rather than drops; the replaced database is kept and the
  operator is told to remove it by hand.
- Operator documentation (`postgres-backup-restore.md`, RB-16, operations §1.2)
  is coherent and the cron schedule matches the scripts' variables.

**Not proven, and not claimed:** an off-host restore. `BACKUP_COPY_HOOK` exists
and its success path is tested, but no off-host destination exists, so
`jtt_backup_last_success_offhost` reads 0 and the dashboard correctly says NO.

---

## Observability findings

59 alerts across 10 rule files, 9 dashboards, `promtool`/`amtool`/dashboard
validation green. Against the detection questions this pass was asked to check:

| Must detect | Alert |
|---|---|
| API unavailable | `ServiceDown`, `ServiceNotReady`, `ApiErrorRateHigh`, and now `ServiceRestartLoop` |
| Terminal unavailable | `ServiceDown{job="terminal"}`, `TerminalConnectionFailures`, `TerminalPtyDrift` |
| Database unavailable | `DatabaseDown`, `DatabasePoolSaturated` |
| Session failures | `LabStartsFailingHard`, `LabResetsFailing`, `SessionStuckProvisioning`, `SessionResetStuck`, `SessionTeardownStuck`, `SessionDegradedNotReclaimed` |
| High session count | `CapacityNearExhausted`, `CapacityExhausted` |
| Verification failures | `VerificationErrorRate`, `VerificationSlow` |
| Resource exhaustion | `HostMemoryCritical/Pressure`, `HostDiskSpaceCritical/Low`, `HostCpuSaturated`, `EventLoopLagHigh` |

Alertmanager's inhibit rules are unusually careful — one root cause, one page —
and the notification destination is read from a git-ignored file rather than
committed, so the seam is real and empty rather than faked.

Gaps, both pre-existing and both correctly recorded as decisions: **no alert is
proven to reach a human** until a destination is configured, and **container
restarts are not counted** without a host exporter. Fixing (4) made the second
one matter more, which is why (5) exists — `ServiceRestartLoop` reads a signal
Prometheus already has rather than waiting for an exporter.

---

## Browser E2E status

**None exists in the repository.** No Playwright, Puppeteer, Selenium or
`e2e` directory; no CI job; nothing in `package.json`. The closest thing is
`apps/web`'s 195 component tests under jsdom with a mocked API — which prove the
components render the real API payloads, and are not the same claim as a browser
driving the product.

Not built tonight. The mission explicitly warned against spending the night on
a new browser-testing framework, and the repository architecture does not call
for one: the five-student gate already speaks the terminal WebSocket protocol
and the API HTTP contract with the browser's `Origin`, which is where the
protocol risk lives. A minimal smoke test — sign in, start a lab, see a prompt,
verify, end — would be worth having, and is a decision about scope rather than
a gap to be closed silently. The release gate's §2 "No browser end-to-end"
remains accurate and is restated in §11.5.

---

## CI changes

**None.** `.github/workflows/quality-gates.yml` was reviewed job by job against
what can be run locally, and every local gate is already represented:
typecheck, `npm test`, composition, observability, secret distribution, backup
refusals, the socket and monitoring greps, the committed-archive check, build,
`make test-db`, the restore drill, kind (pod security, NetworkPolicy
enforcement, labs, orchestrator), sandbox, docker, networking, terminal,
sandboxd and TLS edge. `make beta-validate` is deliberately not in CI and is
documented as such.

Everything added tonight lands in existing jobs: the compose restart contract
and the workspace/verifier tests run under `npm test`, and the new promtool
cases under `scripts/check-observability.sh`.

One optional gate was considered and rejected: refusing tracked key material by
path, as a sibling of the existing "No database archive is committed" step.
Every credential directory already has a `.gitignore`, nothing credential-shaped
is tracked, and a content-level grep false-positives on the legitimate PEM
fixtures that prove log redaction. Not worth a CI step on this evidence.

---

## Runbook changes

- **`private-beta-operations.md` §6.1 (new)** — what restarts by itself: that a
  service you `stop` stays stopped (which is what keeps `prod stop web` a real
  way to take the site down), that a container which cannot start restarts in a
  loop and the web tier's certificate gate is the expected case, and that coming
  back is not the same as being healthy. Plus the header table and §9, which now
  record that restart is per-host and that restarts are not counted.
- **`private-beta-operations.md` §2** — the five-minute check now reads
  `jtt_sessions_capacity_limit` and `jtt_sessions_per_student_limit`, with the
  reason: headroom alone cannot tell a correctly configured deployment from one
  running at the default ceiling of 20.
- **`RB-01-service-down.md` §1.1 (new)** — why `ServiceDown` can be silent once
  services restart themselves, what `ServiceRestartLoop` means, and that it
  should be treated as an outage despite being a warning. Docker's restart
  backoff added to the diagnosis step, and a recovery check that waits for
  `changes(up[15m])` to fall back to zero rather than restarting again on an
  alert that is firing on history.

Everything else in the runbook was checked against repository reality and found
correct: the `prod` function's five `-f` files render in that order; `q` and
`alerts` work because `promtool` and `amtool` ship in those images and both bind
loopback inside the shared namespace; `ready api 9400 / terminal 9401 /
sandboxd 9402` match `OBSERVABILITY_PORT` in the rendered production config;
`prod kill -s HUP prometheus` is right because `--web.enable-lifecycle` is off;
and the warning never to run `prod down -v` is correct and prominent.

---

## Commits created

Six, on `feat/beta-overnight-hardening`, each one concern:

| | |
|---|---|
| `0881d19` | `fix(security): resolve symlinks in the session workspace` |
| `fcf33b8` | `fix(verifier): an unreadable workspace is a broken environment, not a 500` |
| `fda7eeb` | `fix(production): restart production services unless an operator stopped them` |
| `cae9f10` | `test(terminal): cover the internal workspace endpoints` |
| `589d65f` | `docs(beta): check the deployed capacity ceiling before every class` |
| `601eadd` | `feat(observability): alert on a service that keeps restarting` |

## Files changed

12 files, +866 / −25, plus this report and the release-gate §11.

```
docker-compose.production-observability.yml
docker-compose.production.yml
docs/runbooks/RB-01-service-down.md
docs/runbooks/private-beta-operations.md
infrastructure/observability/prometheus/alerts/platform.yml
infrastructure/observability/prometheus/tests/service-restart-alerts.test.yml   (new)
services/observability/test/private-beta-operations.test.ts
services/terminal/src/workspace.ts
services/terminal/test/workspace-endpoints.test.ts                              (new)
services/terminal/test/workspace.test.ts
services/verifier/src/index.ts
services/verifier/test/docker-requirements.test.ts
```

No file under `labs/networking/` was touched; a concurrent session owns that
tree.

---

## Known limitations

- **Restart policies are repository-proven, not host-proven.** They render
  correctly and the shared-namespace behaviour was measured with a throwaway
  probe. No production host has rebooted with them in place.
- **The symlink fix changes one student-visible behaviour.** A student who
  plants a link at a graded path now gets `INVALID_WORKSPACE_PATH` rather than a
  graded answer, which surfaces as a failed check. That is the intended
  refusal; it is recorded here because it is a behaviour change, not only a
  hardening.
- **`ServiceRestartLoop` fires on history.** `changes(...[15m])` stays true for
  up to fifteen minutes after the last flap, so it keeps firing briefly after
  the fault is fixed. RB-01 §6 says so and tells the operator to wait rather
  than restart again.
- **Finding 2 is open** — the credential tmpfs follows symlinks, with no
  demonstrated impact.
- **`terminal` has no `read_only: true`** while `api` and `sandboxd` do.
- **The api's shutdown has no timeout escape hatch**, unlike the terminal's.
- **Catalog-scale tests have no explicit timeout** and their margin narrows as
  the catalog grows.
- **Docs still say 114 labs** in `docker-compose.yml`, the Makefile and the
  release gate. Not corrected: the count is changing tonight in a tree this
  session must not touch, and a number corrected into a moving target is worth
  less than one known to be stale.

---

## External items NOT proven

Stated plainly, because the difference between these categories is the whole
value of the report.

| Category | Status |
|---|---|
| **Repository proven** | Everything under *Tests run*: typecheck, 4,687 unit/contract tests, composition, secret distribution, observability config, backup refusals, build |
| **Local runtime proven** | `make test-db`, the restore drill against real disposable PostgreSQL servers, the TLS edge in the real web image with test-only certificates, production compose rendering, and the shared-netns restart probe — all on one development laptop |
| **Production-host proven** | **Nothing.** No production host exists. Every production command in the runbooks is still the command that host would run, and none has been run on one |
| **External infrastructure proven** | **Nothing.** No public CA or DNS certificate, no off-host backup destination, no restore from one, no alert delivered to a human, no external reachability check, no Kubernetes substrate with a CNI whose NetworkPolicy enforcement has been probed there |
| **Human / operator decision pending** | The whole of release-gate §7, plus the four below |

Specifically **not** proven tonight, and previously proven only at `c8eb2c6`:
`make beta-validate` (five concurrent students, capacity, isolation, reset,
soak, api-restart recovery, cleanup), `npm run verify:network-policy`, and the
kind / docker / sandboxd / terminal / networking integration jobs.

---

## Operator decisions still required

Release-gate §7 stands unchanged — hosting and host sizing, Kubernetes
substrate and CNI, hostname/DNS/CA, OIDC provider, operator access path,
off-host backup destination, alert destination, attestation cadence, retention,
and a per-student shell uid before any untrusted cohort. Added by this pass:

1. **Memory and pid limits for `api`, `postgres` and `web`** on the chosen host.
   Deliberately not guessed here; a wrong PostgreSQL limit turns a slow query
   into an OOM kill.
2. **Whether a minimal browser smoke test is in scope** for the beta. None
   exists; the protocol-level gate is what covers the risk today.
3. **Whether to apply `O_NOFOLLOW` to the credential tmpfs** (Finding 2) and
   **`read_only: true` to the terminal container** — both hardening, both
   needing a real student shell to validate.
4. **Whether the catalog-scale tests should carry explicit timeouts** as the
   catalog grows past 117 labs.

---

## Anything pushed

**Nothing.** All six commits are local on `feat/beta-overnight-hardening`. The
branch has not been pushed, nothing was merged to `main`, nothing was force
pushed, and no other branch was touched.

Temporary resources were cleaned up: the restore-drill containers (label-scoped,
removed by their own trap — confirmed empty afterwards), the TLS-edge test
containers and networks, and the two-container network-namespace probe and its
compose project. No developer container, volume, image or kind cluster
belonging to other work was removed or modified.

---

## Exact recommended next step

**Push the branch and open a pull request, so CI runs the integration jobs this
laptop could not.** That is the one action that converts tonight's
repository-proven work into evidence from clean, isolated runners — the kind,
docker, sandboxd, terminal, networking and TLS-edge jobs in particular.

Then, and before students:

1. Bring the production composition up on the chosen host and run
   `make beta-validate` **there, on the tree that ships**. The five-student
   evidence in release-gate §4 belongs to `c8eb2c6`, and three feature merges
   have landed since.
2. While that host is up, reboot it once. The restart policies added tonight
   are exactly the thing a reboot proves and a laptop cannot.
