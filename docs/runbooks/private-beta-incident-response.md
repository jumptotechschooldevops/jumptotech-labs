# Private beta incident response

What to do when something goes wrong during the private beta (about five
trusted students). Organised by **what you see**. The alert runbooks (RB-01…RB-21)
are organised by **which alert fired**, and every incident below links to the
right one.

Commands use `prod`, `q`, `ready`, `alerts` and `ops`, defined in
[private-beta-operations.md §1](private-beta-operations.md). Run everything on
the host, from the checkout the stack was started from.

**Not proven on a real host.** Every procedure here was written against the
code. The ones marked *(exercised locally)* were run against a local stack
(§3). None has run on a production host yet.

---

## 1. The first five minutes, for any incident

1. **Note the time.** Every log query below needs it.
2. **One student, or everyone?** If you are not sure, ask a second student to
   open the site. One student affected is §2.T. Everyone affected is §2.U.
3. **Read the platform's own view:**
   ```bash
   prod ps          # every service Up; web and postgres (healthy)
   alerts           # what is firing
   ops status       # can a new lab start, and if not, why
   ```
4. **Collect evidence before you change anything.** Restarts erase in-memory
   state, and log context gets harder to find:
   ```bash
   make private-beta-diagnostics ARGS="--since 1h"
   ```
   This writes one sanitized archive to `~/jtt-diagnostics/` and prints its
   path. It holds no secrets and no student data (§4). It is safe to send to
   engineering.
5. **Tell the cohort** what they will see and whether to wait. Say it early,
   even if you do not know the cause yet.

### Things you must never do

| Never | Why |
|---|---|
| `prod down -v`, `docker compose down -v`, `make clean` | `-v` deletes the PostgreSQL volume, which holds every student's progress |
| `docker volume prune`, `docker system prune --volumes` | the same, for every volume on the host |
| Edit `lab_sessions` rows with SQL | every status change is a fenced transition; a hand edit can send a sandbox to the wrong teardown. Use `ops end <id> --yes` |
| `DROP`, `TRUNCATE` or `DELETE` in PostgreSQL during an incident | preserve first: [postgres-backup-restore.md](postgres-backup-restore.md) |
| `docker rm -f` a `jtt-lab-*` container, or `kubectl delete ns lab-…`, by hand while its session is live | the session row still says ACTIVE and holds its slot; `ops end` does both in the right order |
| `make sandbox-clean` on a host where students have running labs | it removes **every** sandbox of this runtime owner, running ones included, without ending their sessions |
| Restart `sandboxd` as a first response | every container-track shell drops at once (RB-01 §3) |
| Paste `.env`, `docker inspect`, `docker compose config` or raw `docker logs` into a ticket or chat | they contain secrets, or can. Send the diagnostics archive instead |
| Raise `MAX_ACTIVE_SESSIONS` to make a capacity problem go away | the host was sized for five; RB-04 and RB-19 first |

---

## 2. Incidents

Each incident has the same eight parts: **Symptom**, **Check**, **Commands**,
**Likely component**, **Recovery**, **Stop when**, **Evidence** and **Follow-up**.
**Stop when** lists the conditions that mean you should stop and escalate
instead of trying the next step.

### A. The website is unavailable

- **Symptom.** The browser cannot load the site, shows a certificate error, or
  shows a 502 or 504 error from nginx.
- **Check.** Is the web container up? Is the certificate valid? Is only the api
  behind it down?
- **Commands.**
  ```bash
  prod ps web api
  prod logs --tail 50 web
  q 'jtt_tls_check_status'            # 0 ok, 1 warning, 2 critical, per check
  ready api 9400
  ```
- **Likely component.** web (nginx and its certificate gate), or the api behind it.
- **Recovery.** web restarting in a loop means the certificate gate failed. Fix
  the certificate as in [production-tls.md](production-tls.md) and RB-15. A 502
  on `/api/` means the api is down: see J and RB-01. A plain `prod restart web`
  helps only if nginx is up and misbehaving.
- **Stop when.** The certificate has expired or its key is suspected
  compromised (production-tls.md §key compromise), or the host itself is
  unreachable over SSH.
- **Evidence.** The diagnostics archive, `prod logs --tail 200 web` (it has no
  query strings), and a screenshot of the browser error.
- **Follow-up.** RB-15. An external reachability check is DECISION REQUIRED
  (operations §8).

### B. Sign-in does not work

- **Symptom.** "Sign in" loops back, fails at the identity provider, or returns
  an error. Students who were already signed in keep working.
- **Check.** Is it the identity provider, the api's OIDC configuration, or the
  database that stores browser sessions?
- **Commands.**
  ```bash
  prod logs --since 30m api | grep -E '"event":"auth\.(callback|login)' | tail -20
  q 'sum by (outcome) (increase(jtt_auth_callback_total[30m]))'
  q 'jtt_db_up'
  ```
- **Likely component.** The identity provider, OIDC settings in `.env`, JWKS
  fetch, or PostgreSQL.
- **Recovery.** Follow RB-14 using the callback `outcome`. If the database is
  down, go to N. Browser sessions are durable, so an api restart does not sign
  anyone out.
- **Stop when.** `outcome` values show a token that should have been refused
  being accepted, or sign-ins from accounts that are not in the cohort
  (operations §8: the provider must admit only beta students). Treat it as a
  security incident: RB-08.
- **Evidence.** The diagnostics archive and the callback outcome counts. Never
  record a browser URL from the callback: it contains a live authorization code.
- **Follow-up.** RB-14.

### C. A student cannot start a lab

- **Symptom.** Start Lab shows an error, or the start spinner stops with a
  message.
- **Check.** Which refusal code did the student get? The UI shows it.
- **Commands.**
  ```bash
  ops status
  prod logs --since 30m api | grep '"event":"lab.start.failed"' | tail -20
  q 'sum by (outcome) (increase(jtt_lab_start_outcome_total[30m]))'
  ```
- **Likely component.** Go by `outcome`:

  | outcome | Meaning | Go to |
  |---|---|---|
  | `student_limit_reached` | The student already holds a lab, possibly in another tab | They open it and End it, or see T |
  | `capacity_reached` | Every slot is taken | D |
  | `provider_unavailable` | That track's substrate is down. `ops status` names the provider and why. The student is told the kind of lab is unavailable and other tracks may work | RB-09; container tracks RB-06; Kubernetes RB-18 first |
  | `provision_failed` | The substrate is up but creation failed | RB-03, E |
  | `platform_error` | The start failed before the substrate was asked, usually the database | N, then RB-11. The log line's `code` names it |
  | *(503 `LAB_LAUNCHES_PAUSED`)* | An operator paused launches (not counted as a failure) | RB-21 |
  | `unauthorized` | Not signed in | B |

- **Recovery.** Follow the row that matches.
- **Stop when.** Starts fail for every track at once. That is not a lab
  problem: go to U.
- **Evidence.** The `lab.start.failed` lines (they carry `labId`, `outcome`,
  `code`), and the time.
- **Follow-up.** If one lab fails repeatedly while the other labs on the same
  track start, file it as a content or image defect for that lab.

### D. Capacity is full

- **Symptom.** Students get "all lab environments are in use"
  (`LAB_CAPACITY_REACHED`). `CapacityExhausted` fires.
- **Check.** Are the slots held by students who are working, or by sessions that
  are stuck, ending, or abandoned?
- **Commands.**
  ```bash
  ops status                  # slots held, by status
  ops sessions                # who holds each slot, in which status, idle for how long
  ```
- **Likely component.** Usually nobody: five students are working. Otherwise,
  the reaper or a teardown (RB-05, RB-17).
- **Recovery.**
  - All slots are `ACTIVE` with low `IDLE`: the platform is full by design. There
    is no queue. Ask a student who has finished to press **End Lab**.
  - A slot is `ACTIVE` with `IDLE` near 20 minutes: idle expiry will reclaim it
    soon. If the owner confirms they are done, end it now: `ops end <session> --yes` (G).
  - A slot is `ENDING`, `EXPIRING` or `DEGRADED` for a long time: RB-17. A
    `DEGRADED` session whose student has left can be ended with `ops end`.
  - `ops status` says the reaper is STALLED: RB-05 §3.
- **Stop when.** Slots do not come back after `ops end` (the session stays
  `EXPIRING` over several sweeps). The runtime is refusing deletes: RB-05 §4c.
- **Evidence.** `ops sessions` output (it has session ids, labs, statuses and
  times, and no names), and `q 'sum by (status) (jtt_sessions_active)'`.
- **Follow-up.** RB-04. Raise `MAX_ACTIVE_SESSIONS` only by an agreed change,
  after checking host headroom (RB-19).

### E. A lab is stuck starting

- **Symptom.** The student sees "Preparing your lab" for more than about three
  minutes.
- **Check.** Is the session `CREATING`, and for how long? Is the provider
  healthy?
- **Commands.**
  ```bash
  ops sessions                 # STATUS CREATING, IN STATUS …
  ready sandboxd 9402          # container tracks
  q 'jtt_provider_available'
  prod logs --since 15m api | grep '"sessionId":"<session>"'
  ```
- **Likely component.** The provider: the image pull, Docker, or the cluster
  (RB-10 has the step breakdown).
- **Recovery.** A start is bounded by the provider's ready timeout (180 s plus
  the image pull). It either succeeds or records FAILED on its own. An api
  restart during a start leaves the row `CREATING`; idle expiry reclaims it
  after 20 minutes, or end it now with `ops end <session> --yes`, which
  deletes whatever the start built.
- **Stop when.** Every start is stuck: the provider is down (RB-06, RB-09).
- **Evidence.** The session's log lines by `sessionId`, and
  `jtt_lab_provision_step_duration_seconds` for the slow step.
- **Follow-up.** RB-10 if provisioning is slow in general.

### F. The terminal disconnected

- **Symptom.** The terminal pane shows "Disconnected" with a reason, or stops
  responding. The rest of the lab page still works.
- **Check.** Did the session end or expire (a normal disconnect), or did the
  terminal service or its connection fail?
- **Commands.**
  ```bash
  ops session <session>                     # still ACTIVE?
  ready terminal 9401
  prod logs --since 15m terminal | grep '"event":"terminal.connection.rejected"' | tail
  q 'sum by (outcome) (increase(jtt_terminal_connections_total[15m]))'
  ```
- **Likely component.** The session's end (normal), the terminal service, or
  sandboxd for container tracks.
- **Recovery.** If the session is `ACTIVE`, the student reloads the page. The
  workspace and the sandbox survive a reconnect. If the terminal is not ready,
  go to K. For `shell_start_failed`, or if every container-track shell ended
  at once, sandboxd is the cause: RB-06. *(exercised locally: stopping
  sandboxd ended the open shell cleanly, `ops status` then read "no enabled
  sandbox provider is available", Start answered `PROVIDER_UNAVAILABLE`, and
  once sandboxd was healthy again the same session's terminal reconnected and
  its sandbox was intact)*
- **Stop when.** Every student's terminal drops at the same moment. That is K,
  or sandboxd (RB-06).
- **Evidence.** The rejection `outcome` counts. Terminal content is never
  logged, so do not ask the student to paste their screen into a ticket.
- **Follow-up.** RB-12.

### G. The terminal keeps reconnecting

- **Symptom.** The terminal connects, drops and reconnects repeatedly.
- **Check.** Is the terminal token being refused (`unauthorized`,
  `no_credentials`), or is the service restarting?
- **Commands.**
  ```bash
  prod ps terminal                          # a low "Up" time means restarts
  prod logs --since 15m terminal | grep '"event":"terminal.connection.rejected"' | tail
  ops session <session>
  ```
- **Likely component.** Terminal service restarts (memory limit 512m), a secret
  mismatch after a partial redeploy (`unauthorized`), or a session that is no
  longer ACTIVE (`no_credentials`).
- **Recovery.** `unauthorized` after a redeploy means `TERMINAL_SESSION_SECRET`
  differs between the api and the terminal: `prod up -d api terminal` from one
  `.env`. `no_credentials` for a session that is `DEGRADED` or `RESETTING`: the
  student presses Reset or End. If the student cannot use the lab at all,
  `ops end <session> --yes` frees the slot so they can start again. Their saved
  progress is kept.
- **Stop when.** The terminal container is being OOM-killed (the diagnostics
  archive shows `oom_killed=true`). Escalate: the limit is a platform decision.
- **Evidence.** The diagnostics archive (restarts, OOM kills, rejection outcomes).
- **Follow-up.** RB-12.

### H. Verify does not work

- **Symptom.** The student presses Verify and gets an error, not a pass or fail
  result.
- **Check.** Is Verify *failing* (the student's work is not done yet, which is
  normal) or *erroring* (the platform could not run the check)?
- **Commands.**
  ```bash
  q 'sum by (result) (increase(jtt_verification_total[30m]))'
  q 'sum by (code) (increase(jtt_verification_errors_total[30m]))'
  prod logs --since 30m api | grep '"event":"verify.errored"' | tail
  ```
- **Likely component.** The provider (the check reads the sandbox), or one lab's
  verifier definition.
- **Recovery.** A failed check is the student's to fix. For errors on one lab
  only, file it as a content defect. For errors on every lab of a track, the
  provider is down (RB-06, RB-09).
- **Stop when.** Verify reports a pass for work that was not done. That is a
  verifier correctness defect: stop using that lab and escalate.
- **Evidence.** Lab id, time, and the `verify.errored` lines.
- **Follow-up.** RB-13.

### I. Reset fails

- **Symptom.** Reset Lab reports a failure, and the lab shows "needs a reset"
  (`DEGRADED`).
- **Check.** Is it one lab or every reset?
- **Commands.**
  ```bash
  prod logs --since 1h api | grep '"event":"lab.reset.failed"' | tail
  q 'sum by (outcome) (increase(jtt_lab_reset_outcome_total[30m]))'
  ops sessions
  ```
- **Likely component.** The provider rebuilding the sandbox (image, runtime).
- **Recovery.** The student can press Reset again, or End Lab and start fresh.
  Saved progress is kept either way. If they cannot do either, use
  `ops end <session> --yes`. A reset interrupted by a restart moves to
  `DEGRADED` by itself after 10 minutes.
- **Stop when.** Three or more resets fail in 30 minutes (`LabResetsFailing`):
  the runtime cannot rebuild sandboxes. See RB-06.
- **Evidence.** The `lab.reset.failed` lines with their `code`.
- **Follow-up.** RB-17.

### J. The api needs a restart

- **Symptom.** The api is unready, hung, or you changed `.env` (for example,
  `LAB_LAUNCHES_PAUSED`, `MAX_ACTIVE_SESSIONS`).
- **Check.** Is a restart the fix? Read `ready api 9400` first: `database` not
  ok means N, not the api.
- **Commands.**
  ```bash
  prod restart api            # same container: for a hung process
  prod up -d api              # re-created: to apply a changed .env
  ready api 9400              # 200 when it is back
  ops status
  ```
- **Likely component.** The api.
- **Recovery.** Sessions are durable, and running sandboxes and terminals are
  not in the api process. Students see "Cannot reach the labs API" until it
  listens again. The reaper and the operator socket start again with the new
  process. Requests in flight fail. A Start in flight leaves its session
  `CREATING`: see E. *(exercised locally: two live labs and their sandboxes
  survived a re-create)*
- **Stop when.** The api has not become ready within 5 minutes, or its status
  turns `unhealthy`. On a busy host the api can take minutes to transpile and
  listen, which is `health: starting` and is not a failure (operations §2.1).
  Read `prod logs --tail 100 api` for the `config.loaded` or startup error. A
  configuration refusal names the variable. Do not restart it again while it
  is still starting: each restart starts the wait over.
- **Evidence.** `prod logs --tail 200 api` from before the restart, or the
  diagnostics archive taken before it.
- **Follow-up.** RB-01 and RB-11.

### K. The terminal service needs a restart

- **Symptom.** `ready terminal 9401` fails, or every terminal fails to connect.
- **Check.** Is it the terminal service, or sandboxd behind it (container tracks)?
- **Commands.**
  ```bash
  prod restart terminal
  ready terminal 9401
  ```
- **Likely component.** The terminal service.
- **Recovery.** Every open shell closes (the browser sees the WebSocket drop).
  Students reload the page, and the sandbox and workspace are still there.
  *(exercised locally: a live shell closed with 1006, and a new connection to
  the same session worked as soon as the service was healthy)*
- **Stop when.** It crash-loops. Read `prod logs --tail 100 terminal`, then RB-01.
  A `Error: kill EPERM … relaySignalToChild` stack trace at the moment it
  stops is expected and harmless: the service drops to the student account
  and its launcher cannot signal it, so it is stopped by Docker instead of
  shutting down itself. It is not the cause of anything.
- **Evidence.** The diagnostics archive before the restart.
- **Follow-up.** RB-12.

### L. Verify needs a "restart"

Verification is not a separate service. It runs inside the api (checks read the
sandbox through the provider), so there is nothing called a verifier to
restart. For H, the component to restart is the api (J), or the provider
(sandboxd, RB-06).

### M. The orchestrator is failing

Like verification, orchestration is not a separate service. The session manager
and the reaper run inside the api, and the substrates are sandboxd (container
tracks) and the kind cluster (Kubernetes track).

- **Symptom.** Sessions stop moving between statuses. `ReaperStalled`,
  `SessionTeardownStuck` or `SessionStuckProvisioning` fire.
- **Commands.**
  ```bash
  ops status                  # "reaper: last sweep … ago — STALLED"
  prod logs --since 30m api | grep -E '"event":"reaper' | tail -20
  q 'jtt:reaper_seconds_since_success'
  ```
- **Recovery.** A stalled reaper is restarted with the api (J). A sweep that
  runs but keeps failing is a provider or the database: RB-05 §4e.
- **Stop when.** Sweeps complete but the leak count keeps rising
  (`SandboxLeakSuspected`), or you see `foreign_owner` refusals, which are a
  security question: RB-08.
- **Evidence.** The reaper lines, `jtt_reaper_last_sweep_errors`.
- **Follow-up.** RB-05, RB-17.

### N. PostgreSQL is unavailable

- **Symptom.** Almost every request from a signed-in student fails with 503
  "Your sign-in could not be checked right now" (`AUTH_UNAVAILABLE`), because
  sign-ins are stored in the database. A start that got past sign-in fails as
  `platform_error`. Progress is not saved. `DatabaseDown` fires. Running
  sandboxes and open terminals keep working. *(exercised locally)*
- **Check.** Is the container down, unhealthy, out of disk, or refusing
  connections?
- **Commands.**
  ```bash
  prod ps postgres
  prod logs --tail 100 postgres
  ready api 9400              # database: failed
  ops status                  # database: NOT READABLE; new labs: NO
  df -h /                     # a full disk stops PostgreSQL
  ```
- **Likely component.** PostgreSQL or the host's disk.
- **Recovery.** Pause launches first (§3 of operations) so students are not
  refused one by one. If the container stopped, run `prod up -d postgres`. If
  the disk is full, see O first, because restarting a database on a full disk
  fails again. When `prod ps postgres` shows healthy, the api reconnects by
  itself. `ready api 9400` goes back to 200 without an api restart.
  *(exercised locally)*
- **Stop when.** The logs show corruption, a failed recovery, or `PANIC`, or
  the volume is missing. Do **not** restart repeatedly. Preserve the volume and
  follow [postgres-backup-restore.md](postgres-backup-restore.md) §7.
- **Evidence.** `prod logs --tail 200 postgres`. The diagnostics archive keeps
  the error and lifecycle lines and drops SQL text and row values.
- **Follow-up.** RB-02. Confirm the last backup is fresh: `q 'jtt:backup_age:seconds / 3600'`.

### O. The disk is nearly full

- **Symptom.** `HostDiskSpaceLow` or `HostDiskSpaceCritical` fires. Starts slow
  down or fail, and PostgreSQL may stop.
- **Check.** What is using the space: images, build cache, container logs,
  volumes, or backups?
- **Commands.**
  ```bash
  q 'jtt:host_filesystem_available:ratio'
  df -h / "$(docker info --format '{{.DockerRootDir}}')"
  docker system df
  du -sh /srv/jumptotech/backups/* 2>/dev/null
  ```
- **Likely component.** Docker images and build cache from repeated
  `prod up --build`, container logs, or backups.
- **Recovery.** Pause launches if it is critical. Then reclaim only what is
  safe: `docker builder prune` (build cache) and `docker image prune` (dangling
  images). Neither touches volumes or running containers. Move old backups off
  the host according to the retention policy.
- **Stop when.** The space is in the PostgreSQL volume itself. Do not delete
  anything there. Escalate.
- **Evidence.** `docker system df`, `df -h`, and the dashboard's disk row.
- **Follow-up.** RB-19. Never `docker volume prune` or `docker system prune --volumes`.

### P. Memory pressure

- **Symptom.** `HostMemoryPressure` or `HostMemoryCritical` fires. Services are
  OOM-killed (restarts), and shells are slow.
- **Commands.**
  ```bash
  q 'jtt:host_memory_available:ratio'
  docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}'
  ops status
  ```
- **Likely component.** Student sandboxes (each has limits), or a platform
  service.
- **Recovery.** Pause launches. The slot count, not the students, is what
  bounds memory. If one sandbox is at its limit, that is contained by design.
  If a platform service is growing, restart it (J or K) after collecting
  diagnostics.
- **Stop when.** PostgreSQL is OOM-killed. Escalate with the diagnostics archive.
- **Evidence.** `docker stats` output and the diagnostics archive (OOM flags).
- **Follow-up.** RB-19. Host sizing is not proven (operations §8).

### Q. The Docker daemon is failing

- **Symptom.** `docker` commands hang or error. `SandboxdRuntimeDown` fires, and
  container-track starts fail with `provider_unavailable`.
- **Commands.**
  ```bash
  timeout 10 docker info >/dev/null && echo ok
  systemctl status docker --no-pager | head -20
  journalctl -u docker --since '-30 min' --no-pager | tail -40
  ```
- **Likely component.** The Docker daemon, or the host (disk, memory).
- **Recovery.** Pause launches. A daemon restart (`systemctl restart docker`)
  restarts **every** container. The platform comes back by itself
  (`restart: unless-stopped`), but every student's shell drops and running
  sandboxes restart from their image. Announce it first. After the restart,
  run the whole operations §2 health check.
- **Stop when.** The daemon does not come back, or it comes back and a volume is
  missing.
- **Evidence.** `journalctl -u docker` excerpt and the diagnostics archive
  collected afterwards.
- **Follow-up.** RB-06.

### R. kind or Kubernetes is failing

- **Symptom.** Kubernetes labs fail with `provider_unavailable`, or
  `NetworkIsolationNotAttested` fires. Other tracks are fine.
- **Commands.**
  ```bash
  q 'jtt_provider_available{provider="kubernetes"}'
  KUBECONFIG=infrastructure/kind/generated/kubeconfig-host-jumptotech-labs.yaml kubectl get nodes
  KUBECONFIG=infrastructure/kind/generated/kubeconfig-host-jumptotech-labs.yaml kubectl get ns -l jumptotech.io/managed=true
  q 'jtt_network_isolation_attestation_valid'
  ```
- **Likely component.** The kind node container, or the NetworkPolicy attestation.
- **Recovery.** A stopped node container, `jumptotech-labs-control-plane`, is
  started with `docker start jumptotech-labs-control-plane`. Kubernetes labs
  refuse by design while isolation is not attested: RB-18. Tell the cohort to
  use other tracks.
- **Stop when.** A lab namespace is stuck `Terminating`. That is a finalizer
  problem (RB-05 §4d). Do not force-delete namespaces.
- **Evidence.** `kubectl get nodes`, namespace list, and attestation gauge.
- **Follow-up.** RB-09, RB-18.

### S. TLS or certificate problem

- **Symptom.** Browsers warn about the certificate, or the site will not load
  over HTTPS. `TlsCertificateRenewalDue`, `TlsCertificateExpiresWithin7Days` or
  `TlsEdgeUnhealthy` fires.
- **Commands.**
  ```bash
  q 'jtt:tls_certificate_expiry:seconds / 86400'
  q 'jtt_tls_check_status'
  make tls-check ARGS="--origin https://<host> --cert-dir infrastructure/docker/nginx/tls"
  ```
- **Recovery.** [production-tls.md](production-tls.md): renew, then
  `make tls-install` (hot reload, no restart).
- **Stop when.** The key may be compromised: production-tls.md, key compromise.
- **Evidence.** The `tls:check` output (it prints no key material).
- **Follow-up.** RB-15.

### T. One student is affected

- **Symptom.** One student reports a problem. Everyone else is fine.
- **Check.** Find their session. Students do not see session ids. Ask which
  lab, and roughly when they started it.
  ```bash
  ops sessions                # LAB and AGE usually identify it among five
  ops session <session>
  prod logs --since 1h api | grep '"sessionId":"<session>"' | tail -30
  ```
  If two students run the same lab, use the owner. `OWNER` is the internal user
  id. Map a student's email to it only when you need to:
  ```bash
  prod exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT user_id FROM users WHERE email = '"'"'<email>'"'"'"'
  ```
- **Recovery.** Try these in order:
  1. The student reloads the page. This reconnects the terminal.
  2. The student presses **Reset Lab**.
  3. The student presses **End Lab**, then starts again. Saved progress is kept.
  4. If the student cannot do any of these, end the session for them:
     ```bash
     ops end <session> --yes
     ```
     This uses the platform's own teardown and frees the slot. The student's
     page says their lab environment expired. It is recorded as "ended by
     operator". *(exercised locally)*
- **Stop when.** The same fault happens to a second student. Treat it as
  platform-wide (U).
- **Evidence.** The session id, lab id, time, and the session's log lines.
- **Follow-up.** If it was one lab, file it against that lab.

### U. All students are affected

- **Symptom.** Several students report the same problem, or none can start,
  connect or sign in.
- **Check.** Work through operations §2 top to bottom. The first red item is
  usually the cause:
  ```bash
  prod ps; alerts; ops status
  ready api 9400; ready terminal 9401; ready sandboxd 9402
  ```
- **Recovery.**
  1. Tell the cohort.
  2. Collect diagnostics (§1).
  3. Stop new launches if starting labs makes things worse (operations §3).
  4. Fix the first failing component: A, N, Q, R or S.
  5. Restore normal operation (operations §3, "Restoring normal operation").
- **Stop when.** You cannot find the first failing component within 15 minutes.
  Escalate with the diagnostics archive and do not keep restarting services.
- **Evidence.** The diagnostics archive, the time line of what you saw and did,
  and the alert list.
- **Follow-up.** Write a short incident record (§5).

---

## 3. What was exercised locally

On 2026-09-18, against an isolated local stack (`docker-compose.yml` +
`docker-compose.runtime.yml`, development identity, Linux track, capacity 2):
capacity and per-student refusals, `ops status`/`sessions`/`end`, an api
re-create with two live labs, a PostgreSQL stop and start, a terminal restart
under a live shell, a sandboxd stop, idle expiry, the stop-launches switch and
lifting it, `docker stop` of each service, and the diagnostics bundle. Results
and the defects they found are in
[beta-operations-2026-09-18.md](../development/beta-operations-2026-09-18.md).
This proves the procedures work against the code. It does **not** prove
anything about a production host's capacity, network or identity provider.

## 4. Collecting diagnostics safely

`make private-beta-diagnostics` (scripts/private-beta-diagnostics.sh) is the
only way evidence should leave the host.

- **It contains:** versions and commit, host capacity, service states and
  restarts, readiness, the operator socket's status and sessions (ids, labs,
  statuses and times, without owner ids), runtime inventory as counts, firing
  alerts, and warning and error log lines. Log lines are passed through an
  allow-list, re-redacted, and stripped of query strings, SQL and user ids.
- **It never contains:** `.env`, environment values, secrets, tokens, cookies,
  keys, terminal input or output, workspace files, names a student chose, email
  addresses, or internal user ids.
- **It checks itself.** Before packaging, every file is searched for this
  deployment's own secret values. If one is found, the bundle is deleted and
  the command exits 1. Report that as a bug. Do not work around it by
  collecting logs by hand.
- `--since 2h` widens the log window, and `--no-logs` skips logs.
- Send the archive through a private channel. It still identifies the host and
  holds session ids and timestamps.

## 5. Escalation and the incident record

Escalate to engineering, with the diagnostics archive, when any **Stop when**
condition above is met, when a security alert fires (RB-08), or when data may be
lost. Who is on call is DECISION REQUIRED (operations §8). Until that is
decided, escalate to whoever deployed the stack.

After every incident that affected students, write down:

- when it started, when it was noticed, and when it was resolved;
- what students saw, and how many were affected;
- what you did, in order, with times;
- the diagnostics archive's file name and sha256;
- the cause, if known, and the follow-up.
