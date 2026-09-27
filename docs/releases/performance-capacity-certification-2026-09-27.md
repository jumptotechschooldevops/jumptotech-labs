# JumpToTech performance & capacity certification report, 2026-09-27

Bounded, measured investigation of whether the platform can carry its private
beta (about five concurrent students), what limits it at 10 / 25 / 50, and which
capacity defects could be fixed now. Every figure below is labelled
**MEASURED**, **EXTRAPOLATED** or **UNKNOWN**, and every test is **PASS**,
**FAIL**, **NOT RUN** or **INCONCLUSIVE**. Nothing extrapolated is reported as
tested.

**Headline.**
- The api/control plane is **not** the limit. MEASURED at 50 concurrent
  students: every request answered 200, a 50-student Start burst finished in
  104 ms of api time, and memory stayed flat.
- The limit is the sandbox runtime and the host under it. On the only host
  available (a shared development Mac whose Docker VM ran at load 160–640, CPU
  pressure ≈ 90 %), real five-student classroom runs failed 1–2 of 5 Starts and
  produced latencies that say more about the host than the platform.
- **Five-student status: CONDITIONAL.** No platform defect was found that
  blocks five students, and cleanup and accounting were correct in every run.
  Runtime capacity is not certified until `npm run capacity:classroom` passes
  on the beta host itself (§34).

---

## 1. Base commit

`92c0aaf` (security: remove shell from network probe tcp check, #61).

## 2. Final main commit

`f7c1054` at the time of writing, plus #97 and #98 and this report when they
merge; the PR record is in §23–24.

## 3. Environment tested

| | |
|---|---|
| Host | macOS, 10 cores, 16 GB, Node 22.23.2 |
| Docker | Docker Desktop VM, 10 vCPU / 7.65 GiB, shared with five kind clusters, seven privileged feasibility containers, BuildKit and other agents' lab stacks |
| Host pressure | VM load average 127–643; CPU PSI `some avg10` 76–94 %; 150 MB–3.4 GB free; swap 0.7 GB used. The VM's own `/init services` ran at 59 % CPU with 54 % system time and 2 % idle. Mac load 25–68. |
| Stack | `e2e/stack.sh` (docker-compose.yml + runtime + e2e overlay): nginx edge, api, terminal, sandboxd, PostgreSQL 16, test OIDC provider; `MAX_ACTIVE_SESSIONS=5`, `MAX_ACTIVE_SESSIONS_PER_STUDENT=1`; own compose project, runtime owner and ports |
| Runtimes enabled | linux container provider only (the E2E overlay disables Docker, Terraform, Ansible, CI/CD and points Kubernetes at an unavailable kubeconfig) |
| Labs | LINUX-001, LINUX-005, NET-006 (per-session network), CS-005, NET-007 (per-session network + peer container) |

A plain `docker rm -f` of an idle container took 1.8–23 s on this host
(MEASURED). **Every wall-clock latency from the live stack below is
INCONCLUSIVE for capacity**; what those runs do establish is correctness:
admission, refusal, cleanup, accounting, and bounded memory.

## 4. Architecture capacity map

```text
browser ─► nginx edge (gzip on static assets only, #74)
            /api/   proxy_read 330 s ─► api (one Node process)
            /terminal ws 86400 s      ─► terminal (one Node process)
api:  auth (cookie → auth_sessions → users) → session guard → SessionManager
      admission: count + insert under one transaction-scoped advisory lock
      providers: probe memo 30 s, now single-flight (#64)
      reaper 60 s single-flight · attempt sweeper · pg pool 10 (connect 5 s, statement 10 s)
      ─► sandboxd broker (HTTP, 120 s per op) ─► docker CLI, one process per op
terminal: per socket → credentials from api /internal (10 s) → sandboxd attach
      (one `docker exec -it` child per shell)
```

| Component | State | Per student | Shared / ceiling | Scales out? |
|---|---|---|---|---|
| nginx edge | stateless | 1 HTTP + 1 WS connection | host | yes |
| api | DB-backed sessions; in-process rate limiters, check single-flight, probe memo | ~0.5 ms CPU per poll (MEASURED) | `MAX_ACTIVE_SESSIONS` (20), pool 10 | only with shared rate-limit and single-flight state (not today) |
| PostgreSQL | durable | 1 session row, attempts | `max_connections` 100 (image default) | no (single instance) |
| terminal | PTY/broker sockets in memory; one shell per session, a new attach replaces the old | 1 socket | `TERMINAL_MAX_SESSIONS` 16, pids 256, 512 MiB | no, sockets are pinned to the process |
| sandboxd | docker exec children in memory | ~7 MiB + ~9 PIDs per attached shell (MEASURED, 4 shells) | `SANDBOXD_MAX_SESSIONS` 32, pids 512, 512 MiB | no, same host as the daemon |
| Docker daemon | host | 1 container (0.5 CPU, 512 MiB, 128 PIDs); NET labs +1 network, NET-007 +1 peer | host CPU/RAM | no |
| kind (K8s labs) | cluster | 1 namespace: quota 2 CPU / 2 Gi requested, 4 / 4 Gi limit, 15 pods | node allocatable | not measured |

There is no HPA: the platform is one Docker Compose host. Components that
cannot scale horizontally as built: terminal and sandboxd (live shells in
process memory), and the api's in-process limiters and single-flight gates
(two api instances would each enforce their own budgets).

## 5. One-student baseline — PASS (latencies INCONCLUSIVE)

LINUX-001 through the edge, warm images: Start 11.1 s, terminal ready 7.5 s
(grant 0.9 s), 10 commands p50 44 ms / p95 78 ms, Check 3.0 s, Reset 17.6 s,
reconnect after Reset 4.2 s, End 15.1 s, sandbox gone 15.4 s after End. No
container, network or volume left.

## 6. Five-student concurrent result — FAIL on this host (INCONCLUSIVE for the platform)

Two complete runs (5a, 5b) of a mixed class, plus a sixth student over the
ceiling.

| | Run 5a | Run 5b |
|---|---|---|
| Starts usable | 4 / 5 (CS-005: `SESSION_PROVISION_FAILED` at 90 s) | 3 / 5 (CS-005 at 89 s, NET-006 at 186 s, both `SESSION_PROVISION_FAILED`) |
| Start latency | 90–220 s | 36–186 s |
| First terminal attach | 0 / 4 (all `CREDENTIALS_UNAVAILABLE`; this harness version did not retry, the browser does) | 3 / 3 on the first try, ready in 9.9–10.3 s |
| Check burst | 4 / 4 HTTP 200, 22–32 s | 3 / 3 HTTP 200, 49–60 s |
| Reset burst | 4 / 4 ACTIVE, 46–170 s | 2 / 3 (one `PROVISION_FAILED`) |
| Reconnect after Reset | 4 / 4, 14–19 s | 2 / 2 first try, 9.5–9.7 s |
| End | 5 / 5 HTTP 200 | 4 / 4 HTTP 200 |
| Sandboxes gone after End | 55 s | 153 s |
| Left behind | nothing | one network, reclaimed by the reaper as an orphan ~2 min later (§19) |
| Sessions listed live after End | 0 | 0 |

Both failed Starts carried only `the runtime broker is unreachable: fetch
failed`, and sandboxd's own metrics recorded **no failed operation**. The
request died in transport, and the message dropped the reason. #91 now logs
the cause code. A keep-alive race was tested as the explanation and **not
supported**: 0 failures in 40 attempts across the whole idle window, including
injected event-loop lag. The cause remains **UNKNOWN** until a run on the new
build (§32 P1-1).

A third run on current main could not start: the rebuild's `npm ci` failed
with a registry network error, the old containers went unhealthy on the
starved VM, and one Start exceeded the harness's 300 s deadline. That is where
the harness's leak on a fatal error was found and fixed (§19).

## 7. Classroom start burst — see §6

Raw Docker on the same host, no platform involved: 1 `docker run` 4.7 s, 5
concurrent 8.0–9.7 s (MEASURED). The daemon does not serialise five creates,
and the admission lock covers only a count and an insert, so the 36 → 220 s
stagger comes from each Start's sequential chain of broker operations (create,
then several `docker exec` setup steps), each one slowed by the host.

## 8. Terminal concurrency — PASS for boundedness, latencies INCONCLUSIVE

- One shell per session; a second attach replaces the first, so a student's
  extra tabs never take a second slot (code-verified; exercised by reconnect).
- Noisy neighbour (5b): one student printed 1.49 MB in 12.6 s. The others'
  commands still completed (p50 352 ms, p95 4.3 s against quiet p50 280 ms,
  p95 405 ms). The terminal service stayed at ~35 MiB, and the noisy terminal
  answered 1.6 s later.
- sandboxd cost per attached shell: ~7 MiB and ~9 PIDs (4 shells: 59 → 86 MiB,
  36 → 71 PIDs, MEASURED).
- Terminal and sandboxd attach admission is now exact under concurrency (#63,
  launch-readiness agent).
- Attach retries: the browser retries `CREDENTIALS_UNAVAILABLE` 6 times over
  ~60 s without jitter. That is fine at 5–25; at 50, a terminal restart makes
  a synchronised reconnect herd (P2).

## 9. Verification burst — PASS (latency INCONCLUSIVE)

All Checks answered 200 in both runs (22–60 s under host pressure; 3.0 s for
one student). Control plane (fake runtime, MEASURED): 50 simultaneous Checks
p95 55 ms, 0.9 ms api CPU each. A Check is single-flight per session and now
rate-limited per student (40/min).

## 10. Reset burst — 6 / 7 PASS, one clean failure

A failed Reset answered 503 `PROVISION_FAILED`, and the session was left not
ACTIVE (`SESSION_NOT_ACTIVE` on the next grant). It did not wedge, and End
still worked.

## 11. Database — PASS (no Postgres load test)

Pool 10, connect 5 s, idle 30 s, statement 10 s, query 15 s (unchanged).
Admission holds the advisory lock only for one count and one insert, not across
provisioning (code-verified). Every authenticated request costs 2 SQL
statements and a session route 1 more. `GET /api/sessions` now reads one
student's rows through `lab_sessions_by_owner` instead of every student's
(#71: 12 rows → 1, MEASURED in the query-shape test; the Postgres shape is
exercised by CI's postgres-integration job). The live stack's PostgreSQL
peaked at 27 MiB. The api's DB health probe failed twice during 5a while the
host was starved. No pool-saturation experiment was run. At the browser's
cadence 50 students cost ~10 SQL/s (EXTRAPOLATED), far below a 10-connection
pool.

## 12. Docker runtime — PASS for cleanup, INCONCLUSIVE for latency

create 3.9–20 s, remove 1.2–18.8 s, exec ~8 s average, list 9.2 s average
(66 calls) on this host. Every sandbox, network and volume of every completed
run was removed (§17).

## 13. Kubernetes / kind — NOT RUN

The E2E stack has no Kubernetes runtime. A new kind cluster was deliberately
not created: the VM already hosted five clusters at load ~200, and a sixth
would have degraded every other session's work. The per-session quota (2 CPU /
2 Gi requested) is the capacity figure to plan with (§30).

## 14. Resource usage observed

| Process | Idle | Five-student peak |
|---|---|---|
| api | 44–114 MiB, 26 PIDs | 118 MiB, 33 PIDs |
| terminal | 27–126 MiB | 133 MiB |
| sandboxd | 30–59 MiB, 26–36 PIDs | 101 MiB, 71 PIDs |
| postgres | 14–20 MiB | 27 MiB |
| web (nginx) | 4–13 MiB | 13 MiB |
| a Linux sandbox | 1.4 MiB, 1 PID idle | — |

The control-plane api under 50 students: RSS 131–148 MiB, flat across sizes
(MEASURED).

## 15. Session creation latency

| Students | Control plane (api only, fake runtime) | Live stack (this host) |
|---|---|---|
| 1 | — | 11.1 s |
| 5 | max 41 ms | 36–220 s, 1–2 failures (INCONCLUSIVE) |
| 10 / 25 / 50 | max 36 / 61 / 104 ms | NOT RUN |

Cold start: building every image including the sandbox image, then stack
ready: 1 075 s (MEASURED, cold, image build time not hidden). Warm first
Start: 11.1 s.

## 16. Terminal attach latency

7.5 s (1 student), 9.9–10.3 s (3 students), reconnect 4.2–19 s. All
INCONCLUSIVE; the grant itself is 0.8–2.1 s here, and 0.45–0.58 ms of api CPU in
the control-plane probe.

## 17. Cleanup latency

End HTTP 15 s (1 student), 22–62 s (5). Sandboxes gone 15 s / 55 s / 153 s
after End. Nothing permanent was left: in 5b one network outlived End and was
reclaimed by the reaper as an orphan ~2 minutes later (§19).

## 18. Capacity accounting — PASS

- Over the ceiling: a sixth Start was admitted only when a slot was free
  (earlier Starts had failed); occupancy never exceeded 5.
- A failed provisioning released its reservation (both runs).
- End released capacity: 0 live sessions listed afterwards in every run.
- Per-student limit, concurrent attach admission and End-during-CREATING are
  covered by existing deterministic suites (student-session-limit,
  capacity-admission #63, five-student-reliability-simulation). They pass on
  main.
- Gap (P2): End marks a session ENDED once its **main** container is gone,
  while the NET-007 peer container and the lab network are removed best-effort.
  Under load they can outlive End (and its capacity slot) until the next reaper
  sweep. `#removePeer` also swallows an `inspect` error without recording a
  step.

## 19. Resource leaks found

| Leak | Status |
|---|---|
| NET-007 peer + network outliving End under load | bounded: reaper reclaims within one sweep (~2 min observed). P2, documented |
| The capacity harness left 4 sandboxes + 2 networks when it died on a fatal error | fixed in #98: the fatal path Ends every session each student holds, including a Start whose answer never arrived |
| Memory growth | none observed (api RSS flat 5→50 students; no multi-hour churn run, see §26) |

## 20. Concurrency bugs found

None new in platform code. The terminal and sandboxd check-then-act shell caps
(12 simultaneous attaches opened 12 shells against a cap of 4) were fixed on
main by #63 during this pass.

## 21. Bottlenecks found

1. **Host / Docker runtime.** Every live failure traced to it (§3, §6).
2. **`DockerCliRuntime.list` fan-out.** One `docker inspect` process per
   container, sequentially. It runs for every container provider on every
   reaper sweep and on every sandboxd metrics scrape, over every managed
   container. Measured 9.2 s per call here. Fixed in #97 (N processes → 1;
   the 12-container inspect phase took 4.3–7.3 s instead of 6.0–13.1 s).
3. **Provider probes not single-flighted.** A burst of catalog reads ran one
   probe set each (20 callers → 20 probes). Fixed in #64 (→ 1).
4. **`GET /api/sessions` read every student's sessions.** Fixed in #71.
5. **Hidden tabs kept polling.** Fixed in #66 (45 → 5 polls in the test window).
6. **Uncompressed bundle.** The terminal chunk is 329 KB → 85 KB gzipped,
   measured on real nginx. Fixed in #74.
7. **Reaper tears expired sessions down serially.** Harmless at 5; at 25+
   leaving together, teardown takes N × destroy time while those sessions
   still hold capacity (P2, EXTRAPOLATED).

## 22. Fixes implemented

| PR | Change | Evidence |
|---|---|---|
| #64 | single-flight provider availability probes | 20 concurrent callers: 20 probes → 1 |
| #66 | hidden workspace tab stops polling | 45 → 5 polls |
| #71 | per-owner session list via `lab_sessions_by_owner` | 12 rows → 1 |
| #74 | gzip static bundle at the edge, never proxied responses | 329 KB → 85 KB on nginx 1.30 |
| #91 | "broker unreachable" names the transport cause code, never the address | 3 tests fail on the base |
| #97 | `list` inspects all containers in one process | 30 → 1, 250 → 3 processes |
| #98 | `capacity:control-plane` and `capacity:classroom` probes + guide | §15, §6 |

#64, #66, #71 and #74 were ported from the unmerged
`feat/overnight-performance-capacity` branch. Its authz-label fix was already
on main (#58), and its terminal/sandboxd admission fixes were ported by the
launch-readiness agent (#63).

## 23. PRs created

#64, #66, #71, #74, #91, #97, #98, and this report.

## 24. PRs merged

#64, #66, #71, #74, #91 (squash). #97, #98 and the report: see their PR pages.

## 25. CI results

Every merged PR ran the full matrix: gates, CodeQL, browser-e2e,
docker-integration, kind-integration, networking-integration,
postgres-integration, sandbox-integration, sandboxd-integration,
terminal-integration and tls-edge-integration. All passed before merge.

## 26. Tests not run, and why

| Test | Why |
|---|---|
| Kubernetes sessions, Docker-track (dind), Terraform/Ansible/CI-CD labs | NOT RUN: the E2E stack disables them, and adding a kind cluster or privileged dind sandboxes to a VM at load ~200 would have harmed other sessions |
| 10 / 25 live students | NOT RUN: five already failed Starts on this host for host reasons, so larger bursts would have measured the host |
| Multi-hour churn / memory-leak soak | NOT RUN on the live stack (host). The control plane showed flat RSS across 5→50 |
| File-descriptor tracking over churn | NOT RUN (live stack down); the harness records api/terminal FDs per phase for the beta host |
| PostgreSQL pool saturation | NOT RUN; see §11 |
| Live rerun on current main with #91's cause logging | NOT RUN: rebuild failed on an npm registry network error and the VM stayed saturated |

## 27. Five-student beta capacity status — CONDITIONAL

- **Control plane:** PASS with a wide margin (MEASURED to 50).
- **Accounting, refusal, cleanup, bounded output:** PASS.
- **Runtime:** INCONCLUSIVE. On this host 1–2 of 5 Starts failed with a
  transport error whose cause is now logged.
- Beta may proceed only after `npm run capacity:classroom -- --students 5`
  passes on the beta host (§34).

## 28. Ten students — EXTRAPOLATED

Control plane MEASURED fine at 10. Runtime: roughly double the five-student
host load in a burst. Needs `MAX_ACTIVE_SESSIONS` ≥ 10 and a host that runs a
five-student burst with CPU PSI well under ~20 %. The likely limit is host CPU
during a synchronised Start or Reset burst.

## 29. Twenty-five students — EXTRAPOLATED, with known ceilings to raise

- `TERMINAL_MAX_SESSIONS` default 16 < 25: nine students would hold a lab they
  cannot open a terminal for. Raise it together with `MAX_ACTIVE_SESSIONS`;
  the production config check refuses a shell ceiling below capacity.
- sandboxd PID budget: 36 idle + 25 shells × ~9 + 25 in-flight Check execs × ~9
  ≈ 486 of `pids_limit: 512` in a synchronised Check burst (EXTRAPOLATED from
  ~9 PIDs per docker CLI child).
- Reaper list cost: fixed (#97).
- Likely limit: host CPU, then the sandboxd PID limit.

## 30. Fifty students — UNKNOWN (partly EXTRAPOLATED)

- Control plane MEASURED fine at 50.
- Runtime UNKNOWN: sandboxd PIDs ≈ 936 against 512; every ceiling (20 / 16 /
  32) must rise.
- Sign-in behind one NAT: 60 sign-ins/min per address (#82), so a class of 50
  signing in within one minute uses 83 % of it.
- Kubernetes labs: 50 × 2 CPU requested = 100 CPU of requests, not possible on
  one kind node.
- A single Compose host is very likely the limit before 50 on container labs.
  Terminal and sandboxd cannot scale out as built.

## 31. Remaining P0

None found in platform code. The one P0 **requirement** is §34 item 1.

## 32. Remaining P1

1. The cause of the `broker unreachable: fetch failed` Start failures is
   UNKNOWN. Reproduce on the beta host with #91 in the build and read the
   logged cause code.
2. Twenty-five-student ceilings: `TERMINAL_MAX_SESSIONS`, the sandboxd PID
   budget, and one host (§29), before any cohort above ~15.

## 33. Remaining P2

- End releases capacity before the NET-007 peer and network are gone;
  `#removePeer` swallows inspect errors (§18).
- The reaper tears down expired sessions serially (§21.7).
- A Start chain can outlive nginx's 330 s `/api/` timeout on a starved host:
  the browser sees 504 while the session continues (resume recovers it).
- The terminal credential exchange (10 s) is the first thing to fail under
  host starvation; the browser's retries recover it.
- Reconnect schedule has no jitter (herd at 50).
- The progress runtime's log lines (attempt started, attempts closed) carry
  `event: migration.applied`, which misleads an operator searching logs.
- `SANDBOX_TMPFS_SIZE` is still loaded and unused; sandbox disk is unbounded.
- api, postgres and web have no `mem_limit`.

## 34. Capacity requirements before private beta

1. Run `npm run capacity:control-plane` and then
   `npm run capacity:classroom -- --students 5 --extra-students 1` against a
   staging stack **on the beta host**, with the labs to be taught. PASS means:
   5 / 5 Starts, 5 / 5 terminals, the sixth refused, nothing left after End,
   and CPU PSI during the burst well below saturation. Record it in
   `production-host-evidence-template.md`.
2. Deploy with #91 so any Start failure logs its cause.
3. Keep `MAX_ACTIVE_SESSIONS=5`, `MAX_ACTIVE_SESSIONS_PER_STUDENT=1`. Do not
   co-host kind clusters or other stacks on the beta host.

## 35. Capacity requirements before public release

1. Measure 10 and 25 on production hardware with `capacity:classroom`,
   including Kubernetes and Docker-track labs.
2. Raise and re-measure the ceilings together: `MAX_ACTIVE_SESSIONS`,
   `TERMINAL_MAX_SESSIONS`, `SANDBOXD_MAX_SESSIONS`, sandboxd `pids_limit`.
3. Decide the scale-out model. Terminal and sandboxd need session affinity, and
   the api's limiters and single-flight gates need shared state, before running
   more than one of each.
4. Bound sandbox disk; set memory limits for api, postgres and web.
5. A long churn soak (create, attach, End, repeated for hours) with FD and RSS
   tracking.
