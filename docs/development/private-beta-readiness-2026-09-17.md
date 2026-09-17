# Private-beta readiness pass — 2026-09-17

| | |
|---|---|
| **Branch** | `feat/private-beta-readiness`, on `feat/production-host-readiness` (PR #38) at `fbe490d`, which is on `main` at `c00ec48` (PR #37 merged) |
| **Date** | 2026-09-17, overnight |
| **Production host deployed?** | **No.** Nothing here ran on a production host, a public DNS name, a real certificate, a real identity provider, an off-host backup destination or a real alert receiver. |
| **Verdict** | **SOFTWARE READY for a real-host deployment test. NOT READY FOR STUDENT ACCESS.** |

Evidence words used below:

| Word | Meaning |
|---|---|
| **PROVEN IN REPOSITORY** | the configuration or code itself enforces it, and a hermetic test reads it |
| **PROVEN BY AUTOMATED TEST** | a repository test passed in CI (a GitHub runner) |
| **PROVEN LOCALLY ONLY** | a repository command passed on a development machine (macOS, Docker Desktop) and has not run in CI |
| **REQUIRES REAL PRODUCTION HOST** | can only be proven on the host |
| **REQUIRES EXTERNAL CONFIGURATION** | needs something outside the repository (provider, DNS, CA, receiver, storage) |
| **PARTIALLY IMPLEMENTED** / **NOT IMPLEMENTED** | as written |
| **BLOCKED BY HUMAN DECISION** | the repository deliberately leaves the choice open |

## 1. What this pass found and changed

The pass audited the student journey against the running stack and the code,
looking for what would stop a real student in a real deployment rather than in
the test harness. Every defect below was reproduced before it was fixed, and each fix has a
test that fails without it.

| # | Defect | Who hits it | Fix | Evidence |
|---|---|---|---|---|
| 1 | **nginx kept a re-created api/terminal container's old address: 502 on every request until web was restarted.** `proxy_pass http://api:4000;` is resolved once at load. The runbooks' own `prod up -d api` (changing capacity, RB-04/16/19), and any upgrade or rollback that rebuilds api/terminal, re-creates the container | every student, after routine operator actions | `resolver 127.0.0.11 valid=10s` + variable upstreams; `proxy_connect_timeout 5s` (`aaa46a2`) | reproduced with the real `locations.conf` (502 indefinitely); real-image `tls-edge-integration` test re-creates the upstream at a new address: passes with the fix, stays 502 for 30 s and fails without it |
| 2 | **Start Lab slower than 60 s answered 504** while the lab went on being built. Start is synchronous; Docker-in-Docker waits up to 180 s. The student saw "unexpected response", then a 429 for their own lab | Docker-track students, a cold image pull, a busy host | `proxy_read_timeout 330s` on `/api/`; the web re-reads sessions after any failed start and offers Continue (`98b0f20`) | nginx:1.27 with a 70 s upstream: old config **504 after 60.08 s**, new **200 after 70.20 s**; contract and component tests |
| 3 | **A failed session re-check unmounted a signed-in student's whole app**, closing the terminal socket. Triggered by switching back to the tab while the api restarts | every student with a lab open during an api restart | a signed-in browser stays mounted with a warning banner and Try again (`9f4c080`) | component tests (fail on old code); browser E2E below (fails on old code) |
| 4 | **The session query had no time limit**: "Checking your session…" for as long as the proxy allowed | first page load while the api hangs | 15 s bound (`7369727`) | component test fails without the signal |
| 5 | **Terminal auto-reconnect gave up after ~10 s and only for `CONNECTION_LOST`**; a restart surfaces `BROKER_UNREACHABLE`, `PTY_SPAWN_FAILED`, `CREDENTIALS_UNAVAILABLE`, which fell through to "lost" | students during a terminal/sandboxd restart, or an API slower than the 10 s credentials budget | bounded retry for transient codes over ~60 s; session-state refusals re-read the session; `SANDBOX_REF_MISMATCH` is never retried (`93c5cd1`) | component tests |
| 6 | **No stop-launches switch** (documented follow-up) | operators | `LAB_LAUNCHES_PAUSED=true` refuses Start Lab with 503 before anything is written; running labs untouched (`30756e5`) | `launch-pause.test.ts`, web mapping test, runbook §3 |
| 7 | **A refusal that left the terminal socket open became the reason for a later close**: after a paste over 8 KB (`FRAME_TOO_LARGE`), a real network drop was not auto-reconnected | any student who pastes a large block | advisory codes are shown but not recorded as the close reason (`a8c66af`) | component test fails on the old component |
| 8 | **A failed Reset was worded as a Verify problem** ("Try Verify again" while Verify is disabled) | a student whose reset cannot reach the sandbox | reset-specific wording (`f08c6a1`) | mapping test |

Browser E2E gained two tests that take real services away:
- api stopped and re-created mid-lab (`1490c72`): the student returns to the
  tab, the lab and terminal stay, the api is re-created with
  `--force-recreate`, and Verify grades the same sandbox through the edge.
  Fails against the previous auth gate.
- terminal service re-created mid-lab (`be52f4b`): the workspace reconnects
  without a click to the same sandbox. It **also passes against the previous
  reconnect code**, because here the terminal is back within ten seconds; it
  guards the student-visible behaviour, and fix 5's regression tests are the
  component tests.

`0c61729` repairs a BETA-P0-011 test that compared nginx targets literally; it
now follows the variable to its one value and is exactly as strict.

No security control was weakened. The nginx resolver answers only for
containers on web's own compose network (api, terminal, sandboxd, prometheus;
no student sandbox is on it), which are the names the literal form already
trusted. No port, route, header, capability or secret changed.

## 2. Validation on this branch

On a development machine shared with other worktrees' stacks and five kind
clusters (load average 12–46 during the runs). **None of it is host evidence,
and none of it has run in CI: quality gates run on pull requests, and no pull
request exists for this branch.**

| Command | Result |
|---|---|
| `npm test` (every workspace) | **PASS** — 4,872 passed, 0 failed, 333 skipped (environment-gated integration suites) |
| `npm run test:security` | **PASS** — 47 files, 797 tests |
| `npm run typecheck` | **PASS** |
| `npm run validate:labs` | **PASS** — 117 labs, 0 errors, 0 warnings |
| `npm run production:config-check -- --self-test` (PR #38) | **PASS** — the production gates fail closed |
| `bash scripts/test-production-host-scripts.sh` (PR #38) | **PASS** — 41 cases |
| `bash e2e/stack.sh run` (isolated project `jtt-e2e-bro`) | **PASS 8/8** in 1.6 min, then **9/9** in 2.6 min after the terminal test was added (on PR #38's base); teardown left 0 containers both times |
| New E2E test against the old auth gate (negative control) | **FAILS** as expected — no banner; the app is replaced by the full-screen error |
| `tls-edge-integration` (real web image), full suite with fix 1 | 36/37; the one failure ("refuses a private key inside fullchain.pem") hit its 60 s `docker run` budget at load ~40 and passed alone in 3.4 s, before nginx loads `locations.conf` |
| Same suite, selected tests including fixes 1 and 2 | **PASS** |

Flaky under load, not product defects, not changed: `redact.test.ts` "stays
linear on adversarial input #2" (a 50 ms wall-clock bound; failed once in a
parallel run at load ~35, passed 3/3 alone).

In the E2E run Docker gave the re-created api its previous addresses, so that
test proves the student experience across a real re-create; the address change
itself is proven by the real-image edge test.

## 3. Private-beta release gate audit

Every requirement in the release gate (§1, §7, §13.2) and the areas this pass
was asked to examine, classified against the current tree.

| Area | Classification | Evidence / what is missing |
|---|---|---|
| Production authentication fails closed (OIDC only, dev auth refused, https issuer, client secret, Secure cookie) | **PROVEN BY AUTOMATED TEST** | api security suites; PR #38 config self-test against the real compose merge |
| Sign-in through a real identity provider | **REQUIRES EXTERNAL CONFIGURATION** | test-only IdP in E2E; no provider chosen (D1) |
| **Only the beta students can sign in** | **BLOCKED BY HUMAN DECISION** / **NOT IMPLEMENTED** in the application | the api provisions any account the issuer authenticates (authentication.md §4.7); the provider must restrict it (D3). Top blocker for a public host |
| Authorization and session ownership (every session route, every terminal attach) | **PROVEN BY AUTOMATED TEST**; browser: **PROVEN LOCALLY ONLY** for two students | api/terminal ownership suites; E2E isolation spec (6 routes 404, forged token 4401) |
| Progress ownership | **PROVEN BY AUTOMATED TEST**; browser: **PROVEN LOCALLY ONLY** | progress suites; E2E B's progress 0 |
| Student isolation — API, Kubernetes, Docker daemon, sandbox network | **PROVEN BY AUTOMATED TEST** | CI kind, sandbox, docker, networking jobs (last on PR #37) |
| Terminal isolation — shared uid 1001 credential read | **PARTIALLY IMPLEMENTED** — accepted for trusted students only | release gate §6; a per-student uid is required before an untrusted cohort |
| Verifier isolation and exhaustion (redirects, body cap, linear parsers, single-flight) | **PROVEN BY AUTOMATED TEST** | security audit SEC-EXH-2…6 |
| Rate limits | **PARTIALLY IMPLEMENTED** | start/reset 20/min per student, learning paths 600/min per address, one Check per session; other routes unlimited. Keyed on `X-Forwarded-For` behind exactly one proxy: **a load balancer in front of nginx would make every student one address** |
| Runtime ownership | **PROVEN BY AUTOMATED TEST** | P0-008 suites |
| Docker socket isolation | **PROVEN IN REPOSITORY** + CI step | only sandboxd mounts it |
| Kubernetes NetworkPolicy | **PROVEN BY AUTOMATED TEST** on kind; on the host's substrate **REQUIRES REAL PRODUCTION HOST** | CNI/substrate is D2 |
| Pod Security | **PROVEN BY AUTOMATED TEST** | P0-016 |
| Production secrets | **PROVEN BY AUTOMATED TEST** (refusals, distribution); values **REQUIRE EXTERNAL CONFIGURATION** | `make secrets`, config check |
| HTTPS / TLS edge | **PROVEN BY AUTOMATED TEST** with test-only certificates; public certificate **REQUIRES EXTERNAL CONFIGURATION** (D4, D5) | tls-edge suite |
| Backup and restore | **PROVEN BY AUTOMATED TEST** (`make db-restore-drill` in CI); off-host, encrypted copy **REQUIRES EXTERNAL CONFIGURATION** (D7) | postgres-integration job |
| Alerting — rules | **PROVEN BY AUTOMATED TEST** | promtool tests |
| Alerting — delivery to a person | **REQUIRES EXTERNAL CONFIGURATION** (D6) | no receiver |
| Alerting — the monitoring stack or the host dying | **NOT IMPLEMENTED** | no watchdog / dead-man's-switch alert, and nothing outside the host watches it; needs an external service (D6, D12) |
| Observability on the host | **REQUIRES REAL PRODUCTION HOST** | PR #38 smoke `observability.*` |
| Restart: api re-created (`prod up -d api`) | **PROVEN LOCALLY ONLY** (new) | fix 1 + fix 3; E2E and real-image edge test |
| Restart: terminal / sandboxd | web reconnect **PROVEN LOCALLY ONLY** (component tests, fix 5); on a host **REQUIRES REAL PRODUCTION HOST** | |
| Restart policy `unless-stopped` | **PROVEN IN REPOSITORY** | PR #34 contract |
| Reboot / Docker daemon restart | **REQUIRES REAL PRODUCTION HOST** | the kind node container is `on-failure:1` (measured with kind v0.31.0), not `unless-stopped`; whether it returns is unmeasured |
| Capacity limits 5 / 1, atomic | **PROVEN BY AUTOMATED TEST** | unit + CI integration |
| Five-student gate (`make beta-validate`) on the current tree | **NOT RE-RUN** — last **PROVEN LOCALLY ONLY** at `c8eb2c6` | not run tonight: the Docker VM (8 GiB) already held five kind clusters and a full stack from other worktrees; a sixth cluster and a 30-minute soak would have put them at risk |
| Five students on the host, against thresholds | **REQUIRES REAL PRODUCTION HOST**; thresholds **BLOCKED BY HUMAN DECISION** (D8) | PR #38 §13 procedure |
| Stop launches without taking the site down | **PROVEN BY AUTOMATED TEST** locally (new, fix 6); not in CI yet | |
| Browser critical path, isolation, failure paths | **PROVEN BY AUTOMATED TEST** (browser-e2e passed in CI on PR #37, run `35182078014`) + **PROVEN LOCALLY ONLY** for tonight's new test | Linux provider only |

## 4. Remaining student-journey findings (not fixed)

From a read of the web app against the API and terminal codes. None stops a
student; each is recorded for a later pass.

- A paste over the 8 KB frame limit is refused and shown as a red line; the
  pasted text is lost (the reconnect side of this is fixed, #7).
- A session stuck in `ENDING` blocks every other lab behind a spinner with no
  explanation (`SessionTeardownStuck` alerts the operator after 20 min).
- An unknown session status string would throw in `AppShell`, outside the
  page error boundary. The web and orchestrator status lists match today.
- One terminal per session is enforced when an attach starts
  (`closeSession` before the credentials fetch), as documented in
  student-experience.md. Two attaches for the same session that are *both*
  in flight at the same moment can each register; the later one wins the
  session map. Narrow, not reproduced, not changed.

## 5. What still blocks student access

Nothing below can be done in this repository.

1. **D3 — restrict sign-in to the five students at the identity provider**, and
   prove a non-beta account is refused.
2. **D2 — a host**, then PR #38's §15 procedure end to end: config check,
   NetworkPolicy attestation, preflight, `make beta-validate` on the host,
   start, smoke, external port scan.
3. **D4/D5 — DNS name and a real certificate** with renewal.
4. **D6 — an alert receiver and a person**, the delivery drill, and an external
   watchdog for the monitoring stack and the host.
5. **D7 — an off-host, encrypted backup** and one restore from it.
6. **D8 — capacity thresholds**, then the five-person rehearsal.
7. **Reboot and Docker-restart drills** on the host, including the kind node.

## 6. Commits

| Commit | Change |
|---|---|
| `7369727` | fix(web): bound the session query |
| `aaa46a2` | fix(production): resolve api and terminal per request |
| `9f4c080` | fix(web): keep a signed-in student's lab open when a re-check fails |
| `98b0f20` | fix(production): let a slow lab start finish instead of 504 at 60 s |
| `93c5cd1` | fix(web): reconnect the terminal through a service restart |
| `1490c72` | test(e2e): stop and re-create the real api mid-lab |
| `0c61729` | test(api): follow nginx upstream variables in the no-route check |
| `30756e5` | feat(operations): stop-launches switch |
| `2cfd3e2` | docs(beta): this report; release gate §14; host and browser E2E docs |
| `ec1e301` | docs(security): audit addendum §29 |
| `be52f4b` | test(e2e): re-create the terminal service mid-lab |
| `a8c66af` | fix(web): advisory terminal refusals are not the close reason |
| `f08c6a1` | fix(web): reset-specific wording for an unreachable environment |
