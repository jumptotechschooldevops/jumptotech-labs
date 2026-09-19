# Five-student private-beta validation

**BETA-P0-019.** The release gate for the private beta. It proves that five
distinct students can use the platform at the same time, on the real runtime:
the api, PostgreSQL, sandboxd, the terminal, the verifier, kind and Prometheus.
It exercises the capacity contract, isolation, reset, recovery, cleanup and
observability together. Run it before every beta release, and after any change
to sessions, providers, the terminal or the runtime.

| | |
|---|---|
| **Command** | `make beta-validate` |
| **Contract** | `MAX_ACTIVE_SESSIONS=5`, `MAX_ACTIVE_SESSIONS_PER_STUDENT=1` |
| **Duration** | measured: 10 minutes with the default 300 s soak and 3 races; 18 minutes with `--soak-seconds 600` |
| **Exit** | `0` PASS · `1` FAIL · `2` refused, nothing started |
| **CI** | No. It needs a running stack, kind and Docker. `apps/api/test/five-student-beta-contract.test.ts` runs in `npm test` and pins the harness's decisions |
| **Harness** | `scripts/beta-validation/five-student.ts` (scenario), `terminal-client.ts`, `runtime.ts`; the pure contract is `test-support/beta-validation-contract.ts` (`@jumptotech/test-support/beta-contract`) |

---

## 1. Prerequisites

The harness drives a stack; it does not start one. On the machine that will run
it:

1. **A kind cluster** created from `infrastructure/kind/cluster.yaml`, with the
   admission policies applied: `npm run cluster:up` (or
   `LAB_CLUSTER_NAME=<name> npm run cluster:up` for a dedicated one). The
   host kubeconfig is `infrastructure/kind/generated/kubeconfig-host-<name>.yaml`.
   For a dedicated cluster, copy `kubeconfig-internal-<name>.yaml` over
   `kubeconfig-internal.yaml`, which is the path compose mounts.
2. **The sandbox images**: `make sandbox-build` (once). `docker:27-dind`
   must be pullable or present.
3. **A `.env`** from `make setup` / `make secrets`, with:
   ```bash
   MAX_ACTIVE_SESSIONS=5
   MAX_ACTIVE_SESSIONS_PER_STUDENT=1
   AUTH_MODE=development            # the default in .env.example
   DEV_STUDENT_HEADER_ENABLED=true  # synthetic students authenticate by handle
   NETWORK_POLICY_ATTESTATION_REQUIRED=true   # as in production
   RUNTIME_OWNER_ID=<an owner used by nothing else on this daemon>
   ```
4. **The P0-015 attestation** for that cluster, written with the same network
   settings the api uses:
   ```bash
   KUBECONFIG=infrastructure/kind/generated/kubeconfig-host-<name>.yaml \
     npm run verify:network-policy -- --write-attestation
   ```
5. **The stack, with the observability profile**, idle (no sessions):
   ```bash
   make observability-token
   docker compose -f docker-compose.yml -f docker-compose.runtime.yml \
     -f docker-compose.observability.yml -f docker-compose.production-observability.yml \
     --profile observability up -d --build
   ```
   The production-observability overlay keeps Prometheus and Alertmanager on
   127.0.0.1 inside their own network namespace, exactly as in production; the
   harness queries them with `docker exec`. Only Grafana is published, on host
   loopback.
6. **Registry access** from the Docker daemon and the kind node, for the first
   run: DOCKER-001 pulls `nginx:1.27-alpine` into its daemon and K8S-001 pulls
   `nginx:stable`.

### Why not the production overlay

`docker-compose.production.yml` pins `NODE_ENV=production` and `AUTH_MODE=oidc`.
Production refuses development authentication (P0-014), so a production stack
cannot authenticate five synthetic students without five real accounts at an
identity provider. It also requires a public TLS origin (P0-017). The gate
therefore runs the development runtime path with the production observability
overlay. It does not exercise OIDC sign-in, the TLS edge or the 443/80 exposure;
those are proven by their own stories (§7).

## 2. Run it

```bash
make beta-validate
```

This reads `API_PORT`, `TERMINAL_PORT`, `WEB_PORT`, `API_OBSERVABILITY_PORT`,
`TERMINAL_OBSERVABILITY_PORT`, `COMPOSE_PROJECT_NAME`, `RUNTIME_OWNER_ID` and
`LAB_CLUSTER_NAME` from `.env`. Extra flags go through `ARGS`:

```bash
make beta-validate ARGS="--soak-seconds 600 --race-iterations 5"
make beta-validate ARGS="--report-dir ./beta-reports"
```

| Flag | Default | |
|---|---|---|
| `--soak-seconds` | `300` | health polling with five students active |
| `--race-iterations` | `3` | repeats of the concurrent-start races (§3, phase 14) |
| `--skip-api-restart` | off | skip the api restart in the recovery phase |
| `--skip-network-probe` | off | skip re-running the P0-015 probe under load |
| `--report-dir` | `$TMPDIR/jtt-beta-validation` | where the JSON report goes |
| `--sentinel-image` | `jumptotech/lab-linux:latest` | image for the foreign-owner sentinel container |

Every line of output is `PASS`, `FAIL`, `SKIP` or `INFO`, followed by a summary and
`RESULT: PASS|FAIL|REFUSED`. The JSON report holds every finding and the
observations: start latencies, terminal identities, solve times, resource
samples and alerts. Tokens and the scrape token are redacted from both.

## 3. What it does, and the PASS criteria

Five synthetic students, `beta-student-1` … `beta-student-5`, plus
`beta-student-6`, who is only ever the student refused for capacity. Each is a
`users` row under the development issuer. None is a person.

| Student | Lab | Provider | Why this lab |
|---|---|---|---|
| beta-student-1 | LINUX-001 | linux | container via sandboxd; the shape of Linux, CS, Networking and simulated AWS (48 labs) |
| beta-student-2 | DOCKER-001 | docker | a per-session Docker daemon, the heaviest sandbox |
| beta-student-3 | K8S-001 | kubernetes | kind namespace under P0-015 NetworkPolicy and P0-016 Pod Security |
| beta-student-4 | ANSIBLE-001 | ansible | three containers on a per-session network |
| beta-student-5 | TF-001 | terraform | real `terraform init/apply` from the offline mirror |
| beta-student-1 (reuse) | AWS-006 | linux | simulated AWS: no account, no credentials |

The run passes only if every phase passes:

| # | Phase | PASS means |
|---|---|---|
| 0 | Preflight | The target is loopback, kind, development auth, 5/1, idle, with nothing carrying the runtime owner. Providers are available, the attestation is valid, Prometheus is reachable. Two foreign-owner sentinels are created |
| 1 | Concurrent start | All five `Start` requests are released in one tick. All 5 get 200, with unique session ids and runtime identifiers. Each PostgreSQL row is ACTIVE and owned by its student. Every sandbox resource carries its session label, nothing unattributed exists, and metrics show +5 successes |
| 2 | Terminals | Five WebSockets attach to their own sessions. `whoami`, `pwd` and a computed marker run in all five at once, each shell prints only its own marker, the workspace is writable, and the terminal service reports ≥5 open connections |
| 3 | Verifier baseline | All five checks run (200) and report incomplete |
| 4 | Capacity | Sixth student → **503 `LAB_CAPACITY_REACHED`** `{5,5}`. A second session for a holder → **429 `STUDENT_SESSION_LIMIT_REACHED`** `{1,1}`. The same codes come back when fired simultaneously. Nothing is created, active stays 5, and each refusal is counted on its own metric |
| 5 | Isolation | Every cross-student GET, check, activity, hint, reset and End → 404 `SESSION_NOT_FOUND`, and victims are unchanged. A terminal token re-pointed at another session → close 4401. The Kubernetes shell is Forbidden outside its namespace, which is PSA baseline with the default-deny set. The Docker shell sees only its own daemon. Linux and Terraform sandboxes have no route and `NetworkMode=none`. The Ansible node resolves no other sandbox. The P0-015 probe PASSes with five sessions live |
| 6 | Work + verifier | Each student types their solution in their own terminal. After student *n* solves, exactly students 1…*n* pass: no verifier sees a classmate's work |
| 7 | Reset | Student 1 resets with four active. Their sandbox is replaced and the same socket gets `reattached`. The other four are the same runtime objects and still pass. All five shells work, and student 1 solves again |
| 8 | Observability | `jtt_sessions_active`=5, headroom 0, utilisation 1, targets up, runtime up, starts and both refusal kinds recorded, attestation valid, ≥5 terminal connections, the sandboxd container gauge matches the daemon, no unexpected alert |
| 9 | Soak | Every 15 s: health shows 5, all sessions ACTIVE, every shell answers, no runtime object changes, nothing unattributed |
| 10 | Recovery | `docker restart` of the api with five sessions live. All survive ACTIVE, the runtimes are untouched, and open terminals keep working. The first reaper sweep of the new process succeeds with 0 errors, 0 reclaimed, 0 recoveries and 0 orphans, and the sessions are still ACTIVE after it |
| 11 | End | Students end one at a time. Each sandbox is removed, the others are untouched, the ended terminal is closed, and its token cannot reattach. With one slot free, a holder is still refused 429 while the sixth student is admitted (and ended) |
| 12 | After End | No container, namespace or lab network carries the owner. Active = 0 in health, PostgreSQL and Prometheus. Every row is ENDED, the foreign-owner sentinels are intact, and every End was recorded as success |
| 13 | Reuse | `beta-student-1` starts AWS-006, does the task in the terminal, the verifier sees it, and the session ends cleanly |
| 14 | Races ×N | Six distinct students at once → exactly 5 admitted, one 503, no 429, no duplicates, 5 sandboxes and 5 rows. Five simultaneous Ends → empty. One student twice at once → exactly one 200 and one 429 |
| 15 | Final | No unexpected alert, and no runtime resource left behind |

**Expected alerts.** The scenario is meant to trip some alerts. Each one is
excused under one of three rules:

- **By design.** `CapacityExhausted` fires because phase 4 refuses a student on
  purpose. `CapacityNearExhausted` fires if 5/5 is held for 10 minutes.
- **Provoked, and excused only by a guard.** Each of these is excused only
  while a PromQL guard over the run's window reads 0. The guard counts every
  cause of that alert except the one the scenario creates, so a real failure
  hiding behind it still fails the run (`PROVOKED_ALERT_GUARDS` in
  `test-support/beta-validation-contract.ts`):

  | Alert | Deliberate cause | Guard (must be 0) |
  |---|---|---|
  | `LabStartFailureRateElevated`, `LabStartsFailingHard` | capacity refusals: `capacity_reached` counts as a start failure | `provider_unavailable`, `provision_failed`, `unauthorized` starts |
  | `SecurityEventBurst`, `AuthzOwnershipDenialSpike` | 31 cross-student requests in phase 5 | any security event other than `unowned_session_access` or `dev_identity_in_use` |
  | `TerminalConnectionFailures` | forged tokens (`unauthorized`), ended sessions' tokens (`no_credentials`) | any other failed terminal connection; every real attach must also reach `ready` |

- **Deployment-environment alerts.** The TLS-certificate and backup alerts
  (`ENVIRONMENT_ALERTS` in `test-support/beta-validation-contract.ts`) describe
  whether a production certificate and backup job are installed, not the
  five-student runtime. The gate runs the development + observability stack (§1),
  which has neither, so they fire; they are recorded and ignored. They are
  excused whether or not they were already firing at the pre-run snapshot,
  because each has its own `for:` timer (5m–1h) and may ignite minutes into the
  run on a freshly started stack.

Any other alert that starts firing fails the run. A lifecycle, reaper,
isolation, scope-denial, leak, PTY-drift, runtime or provider alert fails it
even if it was already firing.

After a run these alerts keep firing until their windows pass, about 10 to 15
minutes. A second run started inside that time sees them as already firing.

**Reset and the terminal.** A container reset replaces the sandbox. Behind
sandboxd, the old `docker exec` stream usually ends before the terminal service
can reattach the same socket, so the socket closes (1000). The API answers
`reconnectTerminal: true`, and the browser (`WorkspacePage` → `LabTerminal`) reopens
the terminal with the same token. Phase 7 does exactly that, accepts a
same-socket `reattached` frame if one arrives, and records which happened.

## 4. What a FAIL means for a beta release

**Do not release.** A failure is a broken contract, and each phase maps to a
student-visible harm:

| Failing phase | Consequence for students |
|---|---|
| 1, 14 | Capacity races or duplicate sessions: more sandboxes than the host was sized for, or a student holding two |
| 4 | Students refused with the wrong message, or never refused |
| 5, 6 | One student can see or change another's work |
| 2, 9 | Terminals drop or hang under concurrent use |
| 7 | Reset breaks a classmate's lab |
| 10 | An api restart loses running labs |
| 11, 12 | Slots never come back: the beta fills up and stays full |
| 8 | Operators are blind during the class |

Find the **first** FAIL in the output: later failures often follow from it.
Fix only that, add a regression test for it, and rerun the whole gate. Never
make it pass by raising limits, disabling isolation, Pod Security,
NetworkPolicy, authentication, observability or cleanup, or by skipping a
phase. `--skip-api-restart` and `--skip-network-probe` exist for diagnosis, not
for a release run.

A **REFUSED** result started nothing. Fix the target, not the harness.

## 5. Watching it

Prometheus is not published; ask it from inside its container:

```bash
P=$(docker ps --filter label=com.docker.compose.project=$COMPOSE_PROJECT_NAME \
      --filter label=com.docker.compose.service=prometheus --format '{{.Names}}')
q() { docker exec "$P" promtool query instant http://127.0.0.1:9090 "$1"; }
q 'sum by (provider, status) (jtt_sessions_active)'
q 'jtt:sessions_headroom:count'
q 'sum by (outcome) (jtt_lab_start_outcome_total)'
q 'ALERTS{alertstate="firing"}'
```

Grafana is on `http://127.0.0.1:$GRAFANA_PORT` → **JTT — Private Beta
Operations**, rows 3–5 (sessions, starts, reaper). Runtime objects:

```bash
docker ps --filter label=jumptotech.io/runtime-owner=$RUNTIME_OWNER_ID
kubectl --kubeconfig infrastructure/kind/generated/kubeconfig-host-$LAB_CLUSTER_NAME.yaml \
  get ns -l jumptotech.io/runtime-owner=$RUNTIME_OWNER_ID
```

## 6. If it was interrupted

Ctrl-C once: the harness ends every session it started, removes its sentinels
and exits 130. Ctrl-C twice, a killed process or a crash leaves them. Then:

1. **End the sessions through the platform**, which keeps the fenced
   transitions (never edit `lab_sessions` by hand):
   ```bash
   docker exec <postgres> sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
     select s.session_id, u.subject from lab_sessions s join users u on u.user_id = s.owner_user_id
      where u.subject like '"'"'beta-student-%'"'"' and s.status not in ('"'"'ENDED'"'"','"'"'EXPIRED'"'"','"'"'FAILED'"'"')"'
   curl -X DELETE -H "Authorization: Developer <subject>" \
     -H "Origin: http://127.0.0.1:$WEB_PORT" http://127.0.0.1:$API_PORT/api/sessions/<session_id>
   ```
   Or wait: idle expiry (20 minutes) and the reaper reclaim them.
2. **Sentinels** are named by run id (printed on the first line):
   ```bash
   docker rm -f jtt-lab-<runid>5e17
   kubectl --kubeconfig … delete namespace jtt-p0019-sentinel-<runid>
   ```
3. **Anything still carrying the runtime owner** once no session is live:
   `RUNTIME_OWNER_ID=<owner> npm run sandbox:clean` (owner-scoped), and
   `kubectl delete ns -l jumptotech.io/runtime-owner=<owner>`.
4. `jtt-netprobe-b<runid>-*` namespaces, if the probe was interrupted:
   `kubectl delete ns -l jumptotech.io/test-run` for that run id.

The next run refuses to start while anything carries the owner (§3, phase 0).

## 7. Known exclusions

- **AWS.** All 11 AWS labs are simulated (`labs/aws/track.yaml`): a local Linux
  sandbox, no AWS account, no credentials, no API calls. The gate runs AWS-006
  that way. Real AWS accounts per student are a later AWS-lab milestone; the
  `aws` provider stays registered and unavailable.
- **Not every lab.** One lab per provider. The per-lab suites (`labs-integration`,
  `docker0NN-integration`, `net00N-integration`, …) cover the catalogue.
  CI/CD and `network: link` Networking labs are not in the five, and share the
  container broker path with LINUX-001 and ANSIBLE-001.
- **Production edge and sign-in.** OIDC (P0-014), the TLS edge (P0-017) and
  443/80 exposure (P0-012) are not exercised (§1). Their own suites prove them.
- **Browser.** The harness speaks the terminal's WebSocket protocol and the
  API's HTTP contract with the browser's Origin. The React UI is not driven.
- **Kubernetes cross-session traffic** is proven by the P0-015 probe run under
  load, which uses its own three namespaces. Only one of the five students is on
  Kubernetes, so there is no second student namespace to probe directly.
- **Faults.** Recovery is an api restart, which the operations runbook calls
  safe. Host crashes, sandboxd restarts and database failover are not injected;
  the P0-007 recovery suites cover interrupted resets and ends on PostgreSQL.
- **Sizing.** Resource figures in the report are one laptop's observations
  (§9), not a capacity plan.

## 8. What the first runs found

The gate was built to find defects that only a real, concurrent runtime
shows. Its first runs (2026-09-15) found four, all on `main` at `51f282c`,
all demonstrated on the running stack before they were fixed, and each now
pinned by a regression test:

| # | Defect | Student-visible effect | Fix | Regression test |
|---|---|---|---|---|
| D1 | The container provider seeded a lab only when it declared `setup.files` or `seed_scripts`. `workspace_dir`, added later and expanded by `loadSetupFiles`, was never part of that gate | **All 10 Ansible and all 10 CI/CD labs** started with no starter project: no `ansible.cfg`, inventory, playbooks, `package.json` or `build.mjs`. CICD-006's build check failed before the student did anything | The gate includes `workspace_dir` (`sandbox-provider.ts`) | `ansible-lab-config.test.ts` (fails with the gate reverted) |
| D2 | The Ansible provider wrote its own `ansible.cfg` unconditionally, without `inventory =`. It also satisfied the lab's "ansible.cfg is in place" check, which hid D1 | With D1 fixed alone, the lab's config would still be replaced, and `ansible all -m ping` would find no inventory | The platform file is written only when the lab ships none; `ssh` still gets the session identity from `~/.ssh/config` | `ansible-lab-config.test.ts` (fails with the write made unconditional) |
| D3 | `readSandboxPath` ran `/usr/bin/stat`. The Alpine/BusyBox images (ansible, cicd) have only `/bin/stat` | Every file check on an Ansible or CI/CD sandbox reported "No file found", even for a file the student had just written | `/bin/stat`, which every image has and which prints the same `-c` format | `sandbox-image-binaries-integration.test.ts` (real images) |
| D4 | `jtt:http_duration:p95_10m` counted Check Solution (p50 1.05 s, p95 2.2 s measured) and Reset | `ApiLatencyHigh` sat firing through a normal five-student class, so it could never report a genuinely slow API | Check and Reset are excluded like Start and End. The new `VerificationSlow` alert keeps Check latency watched on its own scale | `api-latency-alerts.test.yml` cases 3–4 (case 3 fails on the old rule) |

Also observed, and correct:

- **Reset reconnects instead of reattaching.** Behind sandboxd, a container
  reset closes the terminal socket before the terminal service can reattach
  it, so the browser's `reconnectTerminal` path reopens it (§3). The
  same-socket reattach is effectively unused behind the broker. A student sees
  "Reconnecting to your new environment…" and a fresh shell.
- **The leak panel read +1 at five students.** `jtt:sandbox_leak:count`
  compared containers with sessions. An Ansible session holds three
  containers and a Kubernetes session holds none, so five students read 1 even
  with no leak. That mix stayed under `SandboxLeakSuspected`'s threshold, but
  the rule was not correct in general: an all-Ansible class read 10 and fired,
  and Kubernetes sessions hid leaked sandboxes. Since 2026-09-19 it compares
  distinct sessions among sandboxd's containers with container-backed sessions
  (`sandbox-leak-alerts.test.yml`), and reads 0 for every mix.
- **An Ansible shell opens in `/home/student`**, while the project and `$HOME`
  are `/home/student/lab`. Not a blocker. The lab text names the project
  directory.

## 9. Resource observations

Measured on the development machine that first ran the gate: Docker Desktop,
10 CPUs, a 7.65 GiB VM, with three other kind clusters and unrelated containers
on the same daemon. Take them as orders of magnitude only.

Passing run `bd565d23` (2026-09-15), `docker stats` samples:

| | Idle | Five students active (soak) | After End |
|---|---|---|---|
| Platform stack: api, terminal, sandboxd, postgres, web, prometheus, alertmanager, grafana | 8 containers, ~670 MiB | ~750 MiB, 2–17 % CPU | ~695 MiB |
| Student sandboxes | 0 | 6 containers, 146–164 MiB | 0 |
| kind node (the K8S-001 namespace and its one Pod) | ~720 MiB | ~700–720 MiB, 14–33 % CPU | ~684 MiB |

Per container while five were active: api 211 MiB, terminal 174, sandboxd 158,
prometheus 90, grafana 77, postgres 31, alertmanager 16. Sandboxes: DOCKER-001's
daemon 73, TF-001 52, the ANSIBLE-001 control node 17 plus 2 per managed node,
LINUX-001 1. Host view from the api's gauges: Docker VM memory 29 % available,
load 1.0–1.5 per CPU (shared with other workloads), Docker root filesystem 89 %
free. Concurrent Start took 7.6–19.6 s (DOCKER-001 and ANSIBLE-001 slowest). A
solve-and-check took 1–4 s. The P0-015 probe under load took 55–63 s.

These are idle sandboxes: students typing short commands, not building images
or running playbooks against real services. A DOCKER-001 student may use up to
`DOCKER_SANDBOX_MEMORY=2g`. One earlier run on this laptop was killed at the soak
by *host* memory pressure (other applications holding ~8 GB), not by the
platform.

**Production-host sizing remains DECISION REQUIRED** and depends on the host
chosen. The dominant costs are the Docker-track daemon, the kind or Kubernetes
node, first-start image pulls, and Terraform's init/apply burst. Re-run this gate
on the production host itself before the beta.
