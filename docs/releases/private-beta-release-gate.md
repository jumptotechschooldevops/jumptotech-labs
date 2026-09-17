# Private-beta release gate — BETA-P0-020

**Final engineering release gate before the first private beta.**

| | |
|---|---|
| **Base** | `origin/main` at `c8eb2c6` (P0-010…P0-019 integrated) |
| **Branch** | `fix/private-beta-release-gate` |
| **Date** | 2026-09-15 |
| **Intended audience** | approximately five **trusted** beta students |
| **Verdict** | **GO FOR 5-STUDENT PRIVATE BETA — conditional** on the deployment decisions in §7 |

This is a release gate, not an architecture phase. It audits the integrated
main branch, re-runs the release-critical software gates, and fixes only
demonstrated blockers for the five-student private beta. One defect was found
and fixed (§5); it was in the release harness, not the platform.

The verdict is **conditional**: the *software* release gate passes, but the
platform has never run on a production host, and the deployment-time decisions
in §7 must be made before students reach a hosted deployment.

> **`main` has moved since this gate ran.** Everything in §1–§9 is evidence
> against `c8eb2c6` and stays as written — a gate record that is edited later
> is not a record. §11 is a separate, dated re-validation against the current
> tree, and it says which of these gates have been re-run there and which have
> not. Read §11 before treating §10's verdict as current.

---

## 1. What is proven

Every item below is proven by a command in §3 against the integrated `c8eb2c6`
tree, either locally on the development machine or on isolated CI runners.

- **Five-student capacity contract.** Five distinct students hold five active
  sessions; the sixth is refused `503 LAB_CAPACITY_REACHED {5,5}`; a second
  session for a holder is refused `429 STUDENT_SESSION_LIMIT_REACHED {1,1}`;
  the same holds under simultaneous races; after End, capacity is released and
  no runtime is orphaned. Global and per-student limits are enforced atomically
  inside one PostgreSQL transaction under an advisory lock.
- **Student-to-student isolation** at the API, terminal, Kubernetes,
  Docker-daemon and sandbox-network layers (see §6 for the one documented
  exception).
- **Authentication fails closed in production.** Development auth and the
  development student header are refused at config load and at request time
  when `NODE_ENV=production`; production requires OIDC, a durable PostgreSQL
  session store, an https issuer, `OIDC_CLIENT_SECRET`, and an https
  `PUBLIC_ORIGIN`; JWKS/verification failures reject the token; session
  ownership is checked on every session route and every terminal attach.
- **Secret boundaries.** Production refuses placeholder/weak secrets for the
  api, terminal and sandboxd; `NAMESPACE_DERIVATION_SECRET` and
  `INTERNAL_SERVICE_SECRET` reach only the services that need them; the web
  bundle carries none; the student PTY environment is a fixed minimal allowlist.
- **Secure runtime transport.** Production refuses a plaintext broker URL to a
  remote host; plaintext is allowed only to loopback or a declared same-host
  compose bridge.
- **Public exposure contract.** In the production composition only `443→web:8443`
  and `80→web:8080` are published; port 80 serves only the ACME challenge and a
  301 redirect; 3000/4000/4001/4002/5432/9090/9093/9400-9402 are not published;
  Grafana is reachable only on `127.0.0.1` inside Prometheus's network namespace;
  PostgreSQL is alone with the api on an `internal: true` network.
- **Docker socket isolation.** Only `sandboxd` mounts `/var/run/docker.sock`;
  api, terminal, web and the observability containers never do; no
  `chmod 666`-style socket workaround exists.
- **Kubernetes NetworkPolicy** deny-by-default with DNS allowed, same-session
  traffic allowed, cross-session blocked, proven with negative controls; the
  attestation gate is required for Kubernetes admission in production.
- **Pod Security** baseline enforced on session namespaces, with a validating
  admission policy that refuses a managed namespace without it.
- **PostgreSQL TLS** fail-closed policy (verify-full or a declared same-host
  plaintext bridge; every URL `ssl*` parameter refused); backup/restore round
  trip proven against real servers; backup archives are never exposed through
  observability.
- **TLS edge** (BETA-P0-017): HTTPS, port-80 redirect, ACME route, terminal
  WebSocket over TLS and fail-closed preflight, proven with test-only
  certificates.
- **Observability** rules, alerts, dashboards and label bounds valid; no
  PII/secret/token in labels; Prometheus/Alertmanager/Grafana private.

## 2. What is NOT claimed

- **No browser end-to-end.** The five-student gate speaks the terminal
  WebSocket protocol and the API HTTP contract with the browser's `Origin`. The
  React UI is not driven. Runtime/protocol E2E only.
- **No production host.** Every production command in the runbooks is the
  command a host would run; none has run on one. Resource figures (§8) are one
  laptop's observations, not a capacity plan.
- **No real public CA / DNS certificate.** TLS is proven with test-only certs.
- **No off-host DR drill.** The repository backup/restore mechanism is proven;
  a real off-host production restore is an operational requirement (§7).
- **No proven alert delivery.** No alert is proven to reach a human until a
  notification route is configured (§7).
- **AWS labs are simulated** (local Linux sandbox, no credentials).

## 3. Release-gate commands and evidence

Run against `c8eb2c6`. Local runs used a dedicated kind cluster `jtt-p0-020`
and compose project `jtt-p0-020` (development + observability + production-
observability overlays), Node 22, Docker Desktop (10 CPU, 7.65 GiB VM).

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | **PASS** |
| Unit / contract suites (all workspaces) | `npm test` | **PASS** — 4,534 passed, 0 failed (incl. the P0-020 regression test) |
| Production composition wiring | `npm run test:composition` + prod `docker compose config` | **PASS** — publishes only 443/80; postgres internal |
| Secret / mount / port / network distribution | `node scripts/check-secret-distribution.mjs` | **PASS** |
| Backup & restore refusals | `bash scripts/test-db-backup-restore.sh` | **PASS** |
| Observability config (promtool, amtool, dashboards) | `bash scripts/check-observability.sh` | **PASS** — 10 rule files, 81 rules, 3 alert-test files |
| PostgreSQL persistence suites | `make test-db` | **PASS** — 310 passed |
| Backup/restore round trip | `make db-restore-drill` | **PASS** — destroyed and restored to an identical fingerprint |
| TLS edge (real web image) | `make test-tls-edge` | **PASS** — 36 passed |
| NetworkPolicy enforcement probe (+ negative controls) | `npm run verify:network-policy -- --write-attestation` | **PASS** — cross-session blocked, DNS allowed, controls reachable |
| **Five-student private-beta gate** | `make beta-validate` | **PASS** — see §4 |
| CI on `c8eb2c6` (isolated runners) | GitHub Actions "Quality gates" | **PASS** — gates + postgres, kind (pod-security, network-policy enforcement, labs, orchestrator), sandbox, docker, terminal, sandboxd, networking, tls-edge |

## 4. Five-student gate result

`make beta-validate` was run twice from `c8eb2c6`.

- **Run 1** (`f4bdc59e`) exercised every phase and **failed only** on one
  alert-excusal defect (§5) — 137 checks passed, the 4 FAIL lines were all the
  same `TlsCertificateExpiresWithin7Days` alert. No runtime, capacity,
  isolation, lifecycle, recovery or cleanup check failed.
- **Run 2**, after the fix, **PASS** — all 16 phases:
  concurrent start (5×200, unique ids, +5 metrics), five terminals with
  per-shell markers, verifier baseline, capacity refusals `{503,429}` including
  simultaneous, isolation (cross-student 404, forged terminal token 4401,
  Kubernetes/Docker/sandbox boundaries, P0-015 probe under load, P0-016
  baseline + default-deny NetworkPolicy present), isolated verification, reset
  with four active, observability (`jtt_sessions_active`=5, headroom 0),
  300 s soak, api-restart recovery (all five survive, reaper sweep 0/0/0/0),
  one-at-a-time End, after-End (active 0, nothing orphaned, sentinels intact),
  reuse, concurrent-start races ×3, final.

The gate was not weakened to pass: limits, isolation, Pod Security,
NetworkPolicy, authentication, observability and cleanup are unchanged.

## 5. Defect found and fixed

**One defect, in the release harness, not the platform.**

- **Symptom.** `make beta-validate` failed on `TlsCertificateExpiresWithin7Days`
  firing during the soak and at the end, reported as an unexpected alert.
- **Root cause.** The gate runs the development + observability stack, which has
  no TLS certificate, so the certificate-expiry gauge reads 0 ("expired") and
  the alert fires on its `for: 5m` timer. `unexpectedAlerts()` excused the TLS
  and backup "environment" alerts **only if they were already firing at the
  phase-0 snapshot**. On a freshly started stack that snapshot is empty and the
  alert ignites minutes later, so it was wrongly flagged. The runbook already
  documented these as "recorded and ignored"; the harness did not implement that
  for alerts whose `for:` outlasts the pre-run snapshot.
- **Fix (narrow).** Added `ENVIRONMENT_ALERTS` (the TLS-certificate and backup
  alerts) to `test-support/beta-validation-contract.ts` and excused them
  unconditionally in `unexpectedAlerts()`. None is in `FORBIDDEN_ALERT_PATTERN`,
  none can be provoked by student activity, and each has its own suite
  (P0-017/P0-013/P0-018). A lifecycle/isolation/runtime alert firing alongside
  is still reported.
- **Regression test.** `apps/api/test/five-student-beta-contract.test.ts`
  "excuses deployment-environment alerts even when they ignite after the pre-run
  snapshot" — pins the empty-baseline case, binds `ENVIRONMENT_ALERTS` to the
  real names in `prometheus/alerts/operations.yml`, and asserts the set can
  never mask a forbidden family.
- The runbook §3 wording was updated to match.

No platform security, capacity, isolation or runtime behaviour was changed.

## 6. Known non-blocking limitations (acceptable for trusted students)

- **Shared-uid credential read (the one to watch).** Every student shell on a
  terminal instance runs as uid 1001, and per-session kubeconfigs / Docker
  client keys live 0600 in a uid-1001 tmpfs (`/run/jumptotech`). One
  container/Kubernetes-track student **can read another's** per-session
  credential — proven live during the soak (both a kubeconfig and a Docker
  `key.pem` were readable as uid 1001). This is documented in
  `docs/secret-boundaries.md`. It is **acceptable only for trusted students**;
  it would be a blocker for an untrusted population. Mitigations in place:
  platform secrets are not exposed (the terminal drops to uid 1001 and the
  service runs elsewhere), session tokens are per-owner, and the API re-checks
  ownership on every credential fetch. **A real fix (per-student uid) is
  required before any untrusted cohort.**
- **No maintenance-mode / stop-launches switch.** `MAX_ACTIVE_SESSIONS` must be
  ≥ 1, so `=1` only *reduces* new launches; it does not disable them. Stopping
  launches today means telling the cohort and/or `prod stop web`. A launch gate
  is a documented post-P0-018 follow-up.
- **No API/edge rate limiting** beyond a 16 KB body cap, the per-socket
  terminal-activity throttle and Grafana brute-force protection. *(Update, V1
  EPIC-02: the learning-path routes `/api/learning-paths` and
  `/api/me/learning-paths` are now limited per client address — see
  `apps/api/src/rate-limit.ts`. Every other route is still unlimited.)*
- **Production DB traffic is plaintext** on the `internal: true` database
  network (postgres + api only); verified TLS is available and required off that
  bridge.
- **Grafana admin password** has only a presence check (third-party image).
- Privileged Docker-in-Docker remains an architectural risk: a student who
  breaks out of a container inside their **own** sandbox reaches that sandbox's
  privileged context. Brokering changes who can *create* such a container (only
  sandboxd), not what one is.

## 7. Deployment decisions required before students access a hosted deployment

None is a software defect; each is an operational choice the repository
deliberately leaves open.

- Hosting environment and **production host sizing** (CPU/RAM/disk/Docker/
  Kubernetes/storage growth/backup + monitoring storage) — re-run
  `make beta-validate` on the chosen host.
- Kubernetes substrate and a CNI with **proven NetworkPolicy enforcement**
  (the enforcement probe must PASS there).
- Production hostname, DNS provider, and CA / ACME client for certificate
  issuance and renewal.
- OIDC provider and the allowed user population.
- Operator private-access path (SSH tunnel to Grafana on `127.0.0.1:3001`).
- **Off-host backup destination**, encryption, and a real restore drill.
- **Alert notification destination** and on-call (the seam is
  `infrastructure/observability/alertmanager/secrets/webhook-url`).
- Attestation re-probe cadence; metric/log retention.
- **A per-student shell uid** if the cohort is ever untrusted (see §6).

## 8. Operator prerequisites and resource readiness

- Runbooks exist and are coherent for service-down, cannot-start-lab, capacity,
  stuck lifecycle, runtime/sandboxd unhealthy, reaper/cleanup, PostgreSQL,
  backup, TLS/certificate, network isolation and host pressure
  (`docs/runbooks/private-beta-operations.md` + RB-01…RB-19).
- **Resource observations (one laptop, orders of magnitude only, not sizing).**
  Idle platform ~0.7 GiB across 8 containers; five students active add roughly
  6 sandbox containers (~150 MiB each) plus the kind node; the Docker-track
  daemon and Terraform init/apply are the dominant bursts. A DOCKER-001 student
  may use up to `DOCKER_SANDBOX_MEMORY=2g`. Re-measure on the production host.

## 9. Release blockers

**None for the intended five trusted students.** The only gate failure was the
harness defect in §5, now fixed and regression-tested. The shared-uid
credential read (§6) is a blocker only for an **untrusted** cohort; for the
stated trusted-beta audience it is a documented, accepted limitation.

## 10. Final verdict

**GO FOR 5-STUDENT PRIVATE BETA** — conditional on completing the deployment
decisions in §7 before the platform is exposed to students, and on the audience
being the stated ~five trusted students (§6).

As of §11 this verdict carries one further condition: `make beta-validate` has
not been re-run since three feature merges landed on `main`, and must be, on
the tree that ships.

---

## 11. Post-gate re-validation — 2026-09-16

An overnight production-readiness pass on `feat/beta-overnight-hardening`,
branched from `cb7804a`. Its own report, with the reasoning and everything that
was looked at and left alone, is
[private-beta-overnight-report.md](../development/private-beta-overnight-report.md).

This section exists because §3's evidence is against `c8eb2c6` and `main` is
sixteen commits past it. Three feature merges landed after the gate and have
never been through one:

| Merge | What it added |
|---|---|
| `82e1ec1` | the student beta experience in the web app |
| `ad20ea8` | guided learning paths (V1 EPIC-02), `/api/learning-paths`, the first per-route rate limit |
| `4a4f949`, `33aa63b`, `cb7804a` | NET-022, NET-024, NET-025 — the catalog is 117 labs, not the 114 named throughout this document |

### 11.1 Re-run on the current tree, and passing

Everything here is **repository proven** or **local-runtime proven** on one
development machine, exactly as §3's local rows were. Nothing here is proven on
a production host.

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | **PASS** — 8 workspaces |
| Unit / contract suites | `npm test` | **PASS** — 4,687 passed, 0 failed, 347 skipped |
| Production composition wiring | `npm run test:composition` | **PASS** — 25 |
| Secret / mount / port / network distribution | `node scripts/check-secret-distribution.mjs` | **PASS** — production publishes 443 and 80 only; postgres internal; only sandboxd holds a socket |
| Observability config | `bash scripts/check-observability.sh` | **PASS** — 10 rule files, 82 rules, 4 alert-test files |
| Backup & restore refusals | `bash scripts/test-db-backup-restore.sh` | **PASS** — 117 |
| PostgreSQL persistence suites | `make test-db` | **PASS** — 173 + 20 + progress |
| Backup/restore round trip | `make db-restore-drill` | **PASS** — destroyed and restored to an identical fingerprint, migrations current, application read and write |
| TLS edge, real web image | `make test-tls-edge` | **PASS** — 36, test-only certificates |
| Production rendering | `docker compose -f … config` over the five production files | **PASS** — 443/80 public, Grafana on `127.0.0.1:3001` inside Prometheus's namespace, nothing else published |
| Build | `npm run build` | **PASS** |

So the three post-gate merges broke none of the software gates in §3 that can
be run without a live stack.

### 11.2 NOT re-run on the current tree

Each needs infrastructure this pass deliberately did not build: the development
machine was already carrying two compose stacks and four kind clusters
belonging to other work, and a fifth cluster or a third stack risked those
rather than proving anything about this one.

| Gate | Last proven | Why not tonight |
|---|---|---|
| **`make beta-validate`** — the five-student gate | `c8eb2c6` (§4) | Needs the running stack, kind and the observability profile. **This is the gap that matters**: the capacity, isolation, lifecycle, soak, restart-recovery and cleanup evidence in §4 is from before the three merges above |
| `npm run verify:network-policy` | `c8eb2c6` (§3) | Needs a dedicated kind cluster |
| kind, docker, sandboxd, terminal and networking integration jobs | `c8eb2c6` CI (§3) | CI builds each on its own runner; they are not a laptop gate |
| CI "Quality gates" on this branch | — | The branch is pushed, but the workflow triggers on `push` to `main` and on `pull_request`; no run exists until a pull request is opened |

### 11.3 Changed by this pass

Four defects and two gaps, each with a regression test that fails against the
previous code. None weakens a security control, and none changes the capacity,
isolation, authentication or exposure contracts in §1.

| Change | Class | Proven by |
|---|---|---|
| Session workspace reads and writes no longer follow a student-planted symlink | **security** | 5 cases in `services/terminal/test/workspace.test.ts`, plus the HTTP boundary in `workspace-endpoints.test.ts`. Probed against the shipped code first: the read returned the linked file and the seed overwrote its target |
| An unreadable workspace is `ENVIRONMENT_UNREACHABLE`, not a 500 | reliability | `services/verifier/test/docker-requirements.test.ts` |
| `restart: unless-stopped` on every production service | reliability | `docker compose config`; contract test in `services/observability/test/private-beta-operations.test.ts`. The shared-netns case was measured, not assumed |
| `ServiceRestartLoop`, because a restart policy can hide an outage from `ServiceDown` | observability | 3 promtool cases in `infrastructure/observability/prometheus/tests/service-restart-alerts.test.yml` |
| The internal workspace endpoints now have a suite | test coverage | 13 cases; they had none |
| The runbook's five-minute check reads the deployed capacity ceiling | operator | `MAX_ACTIVE_SESSIONS` defaults to 20; the beta contract is 5; nothing read it back |
| Three of four production dependency advisories closed by in-range patch bumps | dependencies | `npm audit --omit=dev`: 1 high + 3 moderate → 2 moderate. The high (`js-yaml`) is not reachable from student input; the two left are `express`'s own `qs` range |

### 11.4 What §6's limitations look like after this pass

- **Shared-uid credential read** — unchanged, and still the one to watch. The
  symlink fix is a *different* boundary: §6 is a student reading, as uid 1001,
  what uid 1001 owns; the fix stops a student directing the *service* to read
  and write on their behalf, which reached files uid 1001 cannot open. A
  per-student uid is still required before any untrusted cohort.
- **No maintenance-mode switch** — unchanged, still a follow-up.
- **No API/edge rate limiting** beyond the learning-path routes — unchanged.
- **No restart policy** — this one is closed, for production only.

### 11.5 Still not claimed, and still not proven

Unchanged from §2 and §7, and re-stated because nothing tonight touched any of
it: no browser end-to-end (none exists in the repository — the web suite is 195
component tests under jsdom, which is not the same claim); no production host;
no real CA or DNS certificate; no off-host DR drill; no alert proven to reach a
human; AWS labs simulated. §7's decisions are all still open.

**The next step before students**: bring up the production composition on the
chosen host and run `make beta-validate` there, on the tree that ships. Until
that run exists, the five-student evidence in §4 belongs to `c8eb2c6`.

---

## 12. Browser E2E evidence — 2026-09-16 (`feat/browser-e2e-beta`)

Added after §11, on `main` at `0f33b1f` (which includes §11's pass). §1–§11 are
left as dated records. This section does not change the verdict, and does not
re-run `make beta-validate` (§11.2's gap is still open). Details:
`docs/development/browser-e2e-private-beta.md`.

§2's and §11.5's "no browser end-to-end" is now partially superseded. A real
Chromium browser (Playwright, 7 tests: 6 browser, 1 guard) drove the composed
development stack:

- nginx web bundle;
- the api in OIDC mode against a **test-only** identity provider;
- PostgreSQL, terminal and sandboxd;
- a real Linux sandbox container.

On `0f33b1f` the final clean cycle passed 7/7, and an earlier one failed 2/7
under heavy host load. After rebasing onto `9a0e22e` (PR #35), a load-24 cycle
failed 1/7. Its trace showed the cause: the terminal service's 10 s auth grace
timer closed a socket that had already sent a valid token, because attaching
took longer than 10 s. Students saw "Connection to the terminal was lost."
That is fixed on the branch (`0553cf1`, with a regression test), and two
later clean cycles passed 7/7 at lower load. No run leaked a sandbox.

After main's security audit (PR #36, `fa6f109`) the branch was rebased without
conflicts; no PR #36 control changed. PR #37's first CI run (`9c86bb0`) failed
6/7: the web terminal could send `resize` before `auth`, and the terminal
service correctly closed that socket 4401 as unauthenticated, which left a
student re-opening a workspace on "Connection to the terminal was lost." The
trace's WebSocket frames showed the order. Fixed on the branch (`0689589`
web, `415b547` terminal; the pre-token refusal is unchanged). On `415b547`
locally: isolation 5/5 repeated, full suite 7/7 twice. The suite has not yet
passed on a CI runner.

| Tier | Status |
|---|---|
| A — real browser + web + API + deterministic dependencies | **PROVEN** (local) |
| B — real browser + actual sandbox runtime | **PARTIALLY PROVEN** — Linux provider only; stability under heavy load after the fix not yet measured |
| C — production-host smoke | **NOT PROVEN** |

| Area | Status | Evidence / limit |
|---|---|---|
| App loads in a real browser | **PROVEN** (local) | critical path E2E-001 |
| Browser sign-in (OIDC code flow → HttpOnly cookie) | **PARTIALLY PROVEN** | real API auth path; test-only IdP, `http:`, no real provider |
| Dashboard, learning path, catalog | **PROVEN** (local) | E2E-003/004 |
| Launch → real sandbox → real WebSocket terminal | **PARTIALLY PROVEN** | Linux only |
| Verify grades live sandbox, fail → pass | **PARTIALLY PROVEN** | LINUX-001 requirement types only; negative control fails |
| Progress persists across reload (PostgreSQL) | **PROVEN** (local) | not across API/DB restart |
| End lab removes the sandbox | **PROVEN** (local) | container absent in Docker |
| Two students: session routes, terminal WebSocket, filesystem, verification, progress | **PROVEN** (local, 2 students, Linux) | 6 routes 404; re-pointed token closed 4401; B's Verify 1/5 while A passed; B's progress 0 |
| Sign-out revokes server-side; forged cookie anonymous | **PROVEN** (local) | |
| Clear UI on API/terminal failure | **PARTIALLY PROVEN** | injected in the browser; a real api stop showed ~39 s before the error |
| Test IdP cannot reach production | **PROVEN** (repository) | `browser-e2e-overlay.test.ts` (api refuses under production) + `[guard]` spec |
| Browser E2E in CI | **NOT PROVEN** | ran once on PR #37: 6/7, handshake race since fixed; not yet passed |
| Kubernetes / Docker / Terraform / Ansible / CI/CD in a browser | **NOT PROVEN** | not exercised |
| Reset, second-tab takeover, reload during start | **NOT PROVEN** | not exercised |
| Production overlay, TLS, `wss://`, Secure cookies, real IdP, host | **NOT PROVEN** | unchanged; §2, §7, §11.5 still apply |

No new release blocker. Two defects fixed on the branch, and two non-blocking
resilience findings:

- **Fixed:** a slow attach (over 10 s) closed an authenticated terminal socket
  with a false "No session token received".
- **Fixed:** the web terminal could send `resize` before `auth`, so the socket
  was closed 4401 and the terminal stayed "lost" (the PR #37 CI failure).
- **Non-blocking:** a real API outage shows ~39 s of "Checking your
  session…" before the error.
- **Non-blocking:** an API slower than the terminal's 10 s credentials budget
  still fails the attach. The browser does not auto-retry
  `CREDENTIALS_UNAVAILABLE`; the student presses Try again.

---

## 13. Production-host readiness — 2026-09-16

Added by `feat/production-host-readiness`, rebased onto `main` at `c00ec48`
(after §11, PR #35's catalog validation, PR #36's security audit and PR #37's
browser E2E, §12). §1–§12 are left as recorded. The full procedure, audits and
evidence are in
[production-host-readiness.md](../development/production-host-readiness.md).

**No production host has been deployed.** Nothing in §1–§12 or here is evidence
about a host: every result is from a development machine or a CI runner. An item
becomes host evidence only when the deployment's own copy of
[production-host-evidence-template.md](production-host-evidence-template.md),
filled on that host, records it.

### 13.1 What this adds

| Addition | Status |
|---|---|
| `make observability-token` wrote the scrape token `0600`; Prometheus (uid 65534) cannot read that on a Linux host, so every target would be down. Fixed (`0644` in a `0711` directory) and regression-tested | Defect reproduced and fix verified with the real Prometheus image under Linux ownership: **PROVEN LOCALLY**. On a host: **REQUIRES PRODUCTION HOST** |
| `npm run production:config-check`: the five production files rendered with the operator's `.env`, checked against a host contract, and read by the real api/terminal/sandboxd config loaders; `--self-test` covers 20 fail-closed scenarios | **PROVEN LOCALLY**; passed in CI `gates` on PR #38 at `5d486ef` (base `fa6f109`); not yet re-run in CI on `c00ec48` |
| `make production-preflight`, `make private-beta-smoke`, `scripts/host-capacity-sample.sh`, and their fake-infrastructure test (`scripts/test-production-host-scripts.sh`) | **PROVEN LOCALLY** (macOS and a Linux container); **PROCEDURE READY** for a host |
| Deployment, five-student host validation, alert drill, recovery drills, rollback, evidence template | **PROCEDURE READY** |

### 13.2 Before five students receive access

Every row below is open. Each is also item-for-item in the readiness document's
"FIRST REAL HOST — REQUIRED BEFORE STUDENT ACCESS" checklist.

| Item | Status |
|---|---|
| A host exists; `make production-preflight` passes on it | **REQUIRES PRODUCTION HOST** |
| `make production-config-check` passes with the production `.env` | **REQUIRES PRODUCTION HOST** |
| `make private-beta-smoke` passes on the running stack | **REQUIRES PRODUCTION HOST** |
| Only 80 and 443 (and operator SSH) reachable from outside | **REQUIRES PRODUCTION HOST** — a scan from another network |
| Hostname, DNS and a certificate from a real CA | **REQUIRES EXTERNAL DECISION** |
| Sign-in through the real identity provider | **REQUIRES EXTERNAL DECISION** |
| **Only the beta students can sign in.** The api provisions any account the configured issuer authenticates (authentication.md §4.7); nothing in the application restricts it | **REQUIRES EXTERNAL DECISION** — not fixed by documentation |
| `make beta-validate` on the commit being deployed, on the host (§11.2's gap) | **NOT PROVEN** |
| Five-student capacity measured on the host and accepted against defined thresholds | **NOT PROVEN** (no thresholds are defined) |
| Off-host, encrypted backup, and one restore from it | **REQUIRES EXTERNAL DECISION** |
| An alert delivered to a person | **REQUIRES EXTERNAL DECISION** |
| Unattended recovery after a Docker restart and a host reboot, with the §11.3 restart policy | **NOT PROVEN** on a host |
