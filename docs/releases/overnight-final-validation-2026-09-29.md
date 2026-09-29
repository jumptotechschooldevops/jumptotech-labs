# Final overnight system validation — 2026-09-28/29

**Scope.** Integration, not another audit. Current `main` was rebuilt and run as one system: the complete CI matrix, a live isolated E2E stack, twenty bounded five-student classroom cycles, restart and recovery in real browsers, cross-student isolation, shell-uid isolation on a real kernel, leak accounting, and the production gates that run without a host.

**Commits validated.** `74ea285` → `33a767c` (#166–#170) → `f98e897` (#173/#175/#177), each as it landed. Every result below says which commit it came from.

**The host.** This Mac is **not** the beta host, and the environment was hostile. Other agents' stacks (`jtt-rge`, `jtt-obs`, `jtt-dr`) and five idle kind clusters shared the Docker VM (8 GiB, 10 vCPU). VM load was 60–292, CPU PSI `some` was 71–96 %, and swap was full (1 022 / 1 024 MiB). Latencies here are upper bounds. Only correctness, cleanup and accounting results are evidence; timings are not.

---

## 1. Verdict

| Tier | Verdict |
|---|---|
| 5 trusted students (private beta) | **GO in code**, conditional on #191 and #183 merging and on the real-host tasks in §10. No code blocker remains open after #191. |
| Paid JumpToTech cohort | **NOT YET.** Commercial and host blockers are unchanged (§9). |
| Public / untrusted users | **NO.** |

## 2. Defects found and fixed

| # | Severity | Defect | Cause (evidence) | Fix | PR |
|---|---|---|---|---|---|
| 1 | **P1 for a class** | Under load, Starts and Resets fail as `the runtime broker is unreachable: fetch failed (ECONNRESET \| UND_ERR_SOCKET) during 'exec' \| 'create'`, with no failed op on sandboxd. The cause had been open since 2026-09-27. | A packet capture in sandboxd's netns (§5) shows the api's pooled keep-alive sockets reused 6.5–8 s idle. sandboxd had already sent FIN at +6.2 s (Node 5 s `keepAliveTimeout` + 1 s buffer), or it destroyed the socket with the request unread. Either way sandboxd sent RST. The api idles for 4 s, but its event loop runs late on a loaded host. | `keepAliveTimeoutBuffer = 55 s` in sandboxd. The advertised `timeout=5` is unchanged, so the margin goes from 2 s to 56 s. Test with a negative control. | **#191** |
| 2 | P2 | A first PostgreSQL boot on a new volume (fresh host, DR restore) can flip `unhealthy` and stop the api from starting. | The TCP-ready time was measured twice, +63 s and +64.7 s, against an unhealthy verdict at 70 s (`start_period 10s + 12 × 5s`). | `start_period: 180s`, plus a new contract check `durability.database-first-boot` (TCP dial and ≥ 180 s window). A negative control fails the config-check self-test. | **#183** |

**#191 measured on the live stack** (same labs and burst, current main):

| sandboxd | cycles | PASS | stale-socket failures | sandboxd RSTs | VM load |
|---|---|---|---|---|---|
| main (unfixed), cycles 3–12 and 19–20 | 12 | 6 | 5 | 6 captured | 40–275 |
| #191, cycles 13–18 | 6 | **6** | **0** | **0** | 145–292 |

## 3. Full test matrix

**CI** is clean hardware and the authority. There were two complete 12-job runs on current main plus a fix: #183 (main `33a767c`) and #191 (main `f98e897`). Every job passed in both, and so did CodeQL.

| Job / suite | Passed | Failed | Skipped |
|---|---|---|---|
| gates: `npm test`, api | 939 | 0 | 99 |
| gates: web | 327 | 0 | 0 |
| gates: lab-orchestrator | 1 563 | 0 | 296 |
| gates: observability | 1 046 | 0 | 39 |
| gates: progress / sandboxd / terminal / verifier | 117 / 173 (177 on #191) / 253 / 2 038 | 0 | 2 / 7 / 35 / 0 |
| gates: backup/restore refusals | 174 | 0 | — |
| postgres-integration: persistence + restore drill | 27 + 222 + 43 | 0 | — |
| sandbox-integration | 13 + 1 + 13 + 9 + 4 | 0 | — |
| catalog-runtime (81 container labs) | 81 | 0 | — |
| docker-integration: core + per-lab + 15-lab sweep | 31 + 13 + 13 + 12 + 10 + 12 + 7 + 15 | 0 | — |
| kind-integration: orchestrator, pod security, k8s sweep, NetworkPolicy | 45 + 34 + 11 + 21 + 16 | 0 | — |
| networking-integration | 23 + 8 | 0 | — |
| terminal-integration, including shell uids on a real kernel | 22 + 13 | 0 | — |
| sandboxd-integration | 7 | 0 | — |
| tls-edge-integration | 38 | 0 | — |
| browser-e2e (stack) | 17 (18 after #175) | 0 | — |
| browser-ux | 59 | 0 | — |

**Local, on this Mac:**

| Suite | Result | Notes |
|---|---|---|
| `npm run typecheck` | PASS | |
| `npm run validate:labs` | 117 labs, 0 errors, 0 warnings | |
| `npm test` (all workspaces, `74ea285`, load 140) | 7 failed (4 files); every other test passed | All load flakes: 5 × 5 s timeouts in catalog tests, a socket hang-up, and a credential-deadline test whose 300 ms deadline fired before loopback headers. **All 4 files pass on rerun** (83/83). CI is green on the same code. |
| `npm run test:security` (`33a767c`) | **1 133 / 1 133** across 67 files | |
| `production:config-check --self-test` | PASS | |
| `test-production-host-scripts.sh` | 59 cases, 0 failed | |
| `test-private-beta-diagnostics.sh` | PASS | |
| `test-db-backup-restore.sh` | 174 / 0 | |
| `check-observability.sh` (pinned `prom/prometheus` promtool, not brew 3.x) | PASS | |
| `check-secret-distribution.mjs` | PASS | |
| Shell-uid isolation on a real kernel (`make test-terminal-isolation` command, private image tag, `f98e897`) | **13 / 13** | |
| Browser E2E against the live stack, `74ea285`, VM load ~250 | 6 / 17 | Every failure was a UI timeout (sign-in or Launch still loading). No assertion failed on a wrong answer. |
| Browser E2E against the live stack, `f98e897`, VM load 150–208 | **16 / 18** | Both failures were load-bound (§6). All restart/recovery, sign-out and isolation specs passed. |

## 4. Lab certification

**117 / 117 labs pass. 0 fail.** Every lab is started, confirmed unsolved, solved with its golden path, graded, reset and ended on real runtimes by the CI sweeps: 81 (catalog-runtime) + 15 (Docker sweep) + 21 (kind sweep). These ran on #183 (`33a767c`) and #191 (`f98e897`), which include every recent security change: SEC-ARCH-2 shell uids, admission, and the sign-out terminal authority. `validate:labs` reports 117/0. The live classroom additionally exercised LINUX-001/003/005/007/010/018, CS-001/005, AWS-001/005 and NET-006/007 through the web edge.

## 5. Five-student classroom (`scripts/capacity/classroom.ts`, 5 + 1)

The stack was `e2e/stack.sh` project `jtt-ofv` (owner `jtt-ofv`, OIDC sign-in, linux provider), kept off the shared `kind` network. There were 20 bounded cycles; cycle 2 never ran (the identity provider was unreachable at sign-in because the VM was starved). Per cycle, each student signs in, then Start, attach, 10 commands, a noisy neighbour (`seq`, 1.5 MB), Check, Reset, reconnect, and End.

| Contract | Result over 19 cycles |
|---|---|
| 5 students authenticate | 19 / 19 |
| Starts | **92 / 95.** 2 failed on Docker's address pool (cycle 1), 1 on a stale socket (#191) |
| Sixth student refused | **17 / 17** cycles with 5 live labs: `503 LAB_CAPACITY_REACHED`. The 2 cycles with fewer live labs correctly admitted the sixth |
| Terminals attach | **92 / 92, all on the first try** |
| Commands execute | every attached shell; quiet p50 27–280 ms |
| Check | **92 / 92 answered 200** (unsolved labs grade `passed: false`, as expected) |
| Reset | 85 / 92. 4 stale-socket failures (#191), 3 `UND_ERR_CONNECT_TIMEOUT` (VM starvation). Each failed Reset left the session `DEGRADED` and resettable, as designed |
| End | 93 / 94 answered 200. One `500` after a PostgreSQL connect timeout; the reaper finished it at +6 min as P0-007 specifies |
| Cleanup | **0 owned containers, networks or volumes after every cycle; 0 live sessions** |

Measured ranges are host-bound and are **not beta-host evidence**. Start p50 was 20–141 s (p95 24–148 s); attach 0.7–8 s; Check p95 4–20 s; Reset p95 29–226 s; End ≤ 21 s with the sandbox gone ≤ 21 s. At rest, sandboxd went from 90 PIDs with five shells back to 26, and from 142 MiB back to 40–68 MiB. The api stayed at 105–183 MiB.

The full per-cycle table is in the PR that adds this record.

## 6. Restart and recovery

| Scenario | Result |
|---|---|
| api stopped and re-created mid-lab (browser) | PASS (`f98e897`): the lab stays open and works again |
| terminal re-created mid-lab | PASS: reconnects to the same sandbox |
| PostgreSQL restarted mid-lab | PASS: the lab keeps running; sessions and progress work again |
| database down while signed in | PASS: the sign-in is kept and works again with the same cookie |
| refresh during CREATING; second tab takes over; Reconnect | PASS |
| sign-out ends terminal authority (#175) | PASS |
| End interrupted by a database timeout | Row stuck `ENDING`; the reaper completed it at +6 min 12 s; no residue |
| Start interrupted by a database timeout | `500`. The row stays `CREATING` and the page shows "Preparing" until the reaper's 10-minute abandoned-start grace, or until End. It converged, but see P3-2 |
| Failed Start, then retry | The next cycle started a new session for the same student; no stale slot |
| Repeated Start/End | 19 cycles; every session created ended, 0 leaked |

## 7. Cross-student isolation and security regression

- Browser: "a second student cannot reach the first student's session, terminal, sandbox, verification or progress" **PASSED** on the live stack (`f98e897`) and in CI.
- `test:security` 1 133 / 1 133. five-student-adversarial, role boundaries, terminal ownership, shell-uid binding, broker scopes, isolation, pod security and NetworkPolicy were all green in CI.
- **SEC-ARCH-2 per-session uids on a real kernel: 13 / 13.** B cannot read, write or list A's credentials or home; process bounds are per student; End kills a `setsid` escapee and nobody else's processes; five concurrent shells get five distinct identities.
- An integration review of every PR merged 2026-09-28 found **no P0–P2 interaction defects** (state machine, access and billing, migrations 008–010, log events, docs map). It found six P3 inconsistencies (§8).

## 8. Remaining known risks (not fixed tonight)

| # | Sev | Finding |
|---|---|---|
| P3-1 | P3 | `UND_ERR_CONNECT_TIMEOUT` on a new api→sandboxd connection when the host is starved (3 in 12 unfixed cycles). A host-capacity matter; measure on the beta host |
| P3-2 | P3 | A database outage in the middle of a Start leaves "Preparing" for up to 10 min (abandoned-start grace) |
| P3-3 | P3 | Database errors mid-request answer a generic `500 INTERNAL_ERROR`, not a 503 (End/Reset/Start). Sessions converge |
| P3-4 | P3 | The api exits at startup on a single PostgreSQL connect timeout after migrations. `restart: unless-stopped` recovers it in production, but it costs a cold start |
| P3-5 | P3 | The classroom view says "a Reset failed" for every `DEGRADED` session, including #159's container-stopped cause (`classroom/view.ts:107`); `LAB_NOT_IN_PLAN` and `ACCESS_PLAN_UNAVAILABLE` show only as "Start refused" |
| P3-6 | P3 | #159 does not cover Docker-track sessions (`docker-provider.ts` never reports `exited`), though the DR runbook says it does. #159 does act on a removed container whose network remains, though its comment and RB-05 say it never does |
| P3-7 | P3 | A database failure at `/auth/callback` is counted as `verification_failed` and pages `OidcSignInFailures`; RB-14 still describes a 503 that browsers no longer see (#144) |
| P3-8 | P3 | `private-beta-smoke.sh:192` and RB-02 still use socket `pg_isready` |
| env | — | Docker's default address pools run out at about 31 networks. Here, other stacks exhausted them and NET-006/007 Starts failed cleanly with 503. On the beta host this matters only if lab networks leak or other stacks share the daemon (§10) |
| test | — | `credentials-deadline.test.ts` asserts which message a 300 ms deadline produces; under load it fires before headers. The terminal is owned by another session (#171); left alone |

## 9. Blockers by tier

**Private beta (5 trusted):** merge #191 and #183, then complete §10 on the real host. There are no open code blockers. The open decisions and host rows in `docs/releases/release-checklist.md` (#165) still apply: off-host backup destination (D7), alert destination (D6), and the class-B host work.

**Paid cohort:** no real billing provider (#154 is a boundary plus test provider; #155/#156 open); privileged DinD for the Docker track; per-host capacity measured on the real host rather than a laptop; P3-1 measured there.

**Public launch:** everything above, plus untrusted-tenant isolation beyond one-trusted-class assumptions (shared kernel, privileged DinD, kind as substrate), abuse and rate limits at scale, multi-host capacity, and a security review of the paid surfaces.

## 10. Real beta host tasks (REQUIRES REAL BETA HOST)

Nothing below was executed; this Mac is not the host. Run them in order after merging #191 and #183, following `docs/runbooks/private-beta-deployment.md`:

1. `make production-config-check` against the host's `.env`. It must report `durability.database-first-boot` PASS (#183).
2. `prod up --wait`, then `make private-beta-smoke`. Record `release.commit` for every service.
3. Check that #191 is live: `docker exec <sandboxd> node -e 'fetch("http://127.0.0.1:4002/health").then(r=>console.log(r.headers.get("keep-alive")))'` must print `timeout=5`, and the image commit must include #191.
4. Address pools: `docker network ls | wc -l` must leave headroom well under 31. Preferably set `default-address-pools` in `/etc/docker/daemon.json` (for example `{"base":"10.200.0.0/16","size":24}`) before the first class.
5. First boot on a new volume: time `prod up` until postgres is healthy. It must stay under 180 s. Record the number.
6. The five-student gate on the host: `make beta-validate`, then the classroom probe through the real edge from a laptop with the real IdP (five students + 1). Record Start/attach/Check/Reset/End latencies, host load and PSI, and `docker network ls` before and after.
7. The restore drill onto a new volume: `make db-restore-drill` procedure against the host's backup (D7 destination).
8. Alerts: fire a test alert end to end to the D6 destination.
9. Leak check after the class: zero `jumptotech.io/runtime-owner=<owner>` containers, networks and volumes; `ops status` shows no live sessions.

## 11. Cleanup

Removed by this pass: the `jtt-ofv` stack and its volumes (`e2e/stack.sh down`), the tcpdump capture container, the `jumptotech/terminal-test:ofv` and `jtt-ofv-sandboxd:keepalive` images, and the fix worktrees. Other agents' stacks, the kind clusters, and every shared image and tag were left untouched.
