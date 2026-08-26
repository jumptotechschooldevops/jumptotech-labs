# Docker Track — Curriculum Audit and Advanced Rebuild Plan

**Status:** analysis only. Nothing in this document is implemented.
**Scope:** `labs/docker/**` and the Docker verifier/setup surface only.
**Branch:** `claude/docker`

---

## 1. What exists today

Ten labs, `DOCKER-001` … `DOCKER-010`, all state-verified against the session's
private `docker:27-dind` daemon.

| ID | Title | Diff. | Level | Prereq | Requirement types used |
|---|---|---|---|---|---|
| 001 | Run Your First Container | beginner | practice | — | `container_exists`, `container_image`, `container_running` |
| 002 | Manage the Container Lifecycle | beginner | practice | 001 | `container_running`, `resource_absent`, `container_exists`, `container_state`, `container_exit_code` |
| 003 | Pull, Inspect, and Tag Images | beginner | practice | 001 | `image_exists` ×2 |
| 004 | Build an Image from a Dockerfile | intermediate | practice | 001, 003 | `workspace_file_exists`, `dockerfile_valid`, `image_exists`, `image_config`, `container_exists`, `container_exit_code` |
| 005 | Persist Data with Volumes | intermediate | practice | 002 | `volume_exists`, `container_exists`, `container_running`, `container_mount` |
| 006 | Connect Containers on a Custom Network | intermediate | practice | 001 | `network_exists`, `container_running` ×2, `container_network` ×2 |
| 007 | Configure with Environment Variables | beginner | practice | 001 | `container_running`, `container_env` ×3 |
| 008 | Run a Multi-Container Application | intermediate | challenge | 006, 007 | `workspace_file_exists`, `network_exists`, `container_running` ×2, `container_network` ×2, `container_env` |
| 009 | Constrain a Container with Resource Limits | intermediate | practice | 001 | `container_running`, `container_resource_limit` |
| 010 | Repair a Broken Container | intermediate | challenge | 002, 007 | `container_exists`, `container_image`, `container_running`, `container_port`, `container_env` |

### Verdict on each

- **001, 002, 007** — sound. Correctly scoped, well-verified, keep as written.
- **003** — thin. Two `image_exists` checks. Never touches digests, `docker history`,
  the difference between a tag and an image ID, or `docker image inspect`. It is a
  five-minute lab wearing a 35-minute label.
- **004** — good bones, but grades only that five instruction keywords appear and
  that `WORKDIR` is `/app`. Nothing about layer ordering, cache, `.dockerignore`,
  `EXPOSE`, `LABEL`, or `ENTRYPOINT`.
- **005** — proves a volume is *mounted*. Never proves data **survives** container
  removal, which is the entire reason volumes exist. A student can pass without
  writing a byte.
- **006** — proves two containers are attached to one network. Never proves they
  can **resolve or reach each other**, which is the point of a user-defined bridge.
- **008** — labelled "compose" but the only Compose-specific check is a substring
  match for `ledger-worker` in `compose.yaml`. A student who hand-runs two
  `docker run` commands and edits the file passes. No `depends_on`, no
  `healthcheck`, no build, no volumes, no project labels.
- **009** — correct but shallow. Sets limits; never observes one being *enforced*.
  No `pids_limit`, no OOM, no CPU throttling.
- **010** — the only troubleshooting lab, and it is a two-fault repair
  (wrong host port, wrong env value). Fine as a first troubleshooting lab;
  nowhere near a production-debugging exercise.

### Systemic gaps

1. **No `advanced` lab exists.** Every lab is `beginner` or `intermediate`. The
   `difficulty` enum supports `advanced`; the Docker track never uses it. The track
   tops out far below what a DevOps engineer is hired to do.
2. **No `assessment` level lab.** The enum supports it; there is no capstone.
3. **Entire required topics are absent:** layers, build cache, multi-stage builds,
   `CMD` vs `ENTRYPOINT`, bind mounts, DNS, health checks, logging drivers,
   `stats`, image optimization, security (non-root, read-only rootfs,
   capabilities), registry workflows, tagging strategy, production debugging.
4. **One troubleshooting lab, not a band.** The requested progression needs a
   troubleshooting *stage*, with a distinct failure class per lab.
5. **Verification stops at "is it configured".** Almost nothing verifies
   "does it work" — no reachability, no persistence-across-removal, no
   in-container observation. This is the single biggest quality ceiling on the track.

---

## 2. Platform capability baseline

Everything proposed below is measured against what the platform can do **today**.

### Verifier — Docker family (17 requirement types)

`docker_container_exists` · `docker_container_running` · `docker_container_state` ·
`docker_container_image` · `docker_container_exit_code` · `docker_container_env` ·
`docker_container_port` · `docker_container_network` · `docker_container_mount` ·
`docker_container_resource_limit` · `docker_image_exists` · `docker_image_config` ·
`docker_volume_exists` · `docker_network_exists` · `workspace_file_exists` ·
`dockerfile_valid` · `docker_resource_absent`

Backed by `DockerVerifyReader`, which exposes exactly four reads —
`container()`, `image()`, `volume()`, `network()` — plus `file()` against the
session workspace. All memoised, all scoped to one sandbox.

### What the snapshots already carry but no requirement type reads

`DockerContainerSnapshot` has `restartPolicy`, `command`, `entrypoint`,
`workingDir`, `labels`, `errorMessage`, `imageId`, `startedAt`/`finishedAt`, and
`limits.memoryReservationBytes` / `limits.cpuShares`.
`DockerImageSnapshot` has `sizeBytes`, `digests`, `architecture`, `os`.
`DockerNetworkSnapshot` has `internal`, `containers`, `subnets`.
**Several proposed labs are cheap because the data is already in the snapshot —
they need a requirement type and a handler, not a new read.**

### Setup surface (`setup.docker`)

`images` ≤10 · `networks` ≤5 (bridge, `internal` flag) · `volumes` ≤5 ·
`files` ≤10 (16 KB each) · `containers` ≤8 (name, image, command/entrypoint argv,
env, workdir, network, state `running|exited|created`, ports, named volumes,
labels, memory, cpus, restart policy).

### Runtime limits

Sandbox: `docker:27-dind`, **2 GB memory, 2 CPUs, 512 PIDs, 10-container budget**.
Egress to Docker Hub works (DOCKER-003 has the student pull).
Reset wipes containers/volumes/networks, keeps images.

### Two architectural facts that constrain lab design

**(a) The student's shell is not inside the daemon.** `dockerSpawnPlan` runs the
PTY in the *terminal service* container with `DOCKER_HOST` pointed at the dind
sandbox over mutual TLS, `cwd` = the session workspace.
Consequence: `docker build .` works (the context is streamed to the daemon), but
`docker run -v "$PWD":/app` **does not do what the student expects** — the source
path resolves on the *daemon's* filesystem inside dind, which has none of the
student's files. Any bind-mount lab is blocked until this is addressed
(see NC-16).

**(b) The Docker requirement vocabulary deliberately contains no execution.**
Unlike the `linux` family (`command_exit_code`, `command_output`), no Docker
requirement carries a command. `port.ts` has `execInContainer` and
`containerLogs`, but neither is exposed on `DockerVerifyReader`, and
`containerLogs` is commented *"Never shown to students."* Several high-value labs
(DNS, persistence, reachability, logging) need observation from inside a
container. **Recommendation: do not add a generic `docker_exec` requirement.**
Add narrow, purpose-built checks where the *handler* owns the argv and lab.yaml
supplies only operands (a hostname, a path, a port). That preserves the
"nothing in lab.yaml becomes a command" invariant while unlocking the labs.

---

## 3. New capabilities required

Referenced as **NC-n** by the lab table in §4.

### Snapshot field additions (cheap — one field, one parser change)

| # | Capability | Source |
|---|---|---|
| NC-01 | `container.health` — `{ status, failingStreak, lastExitCode }` | `State.Health` |
| NC-02 | `container.user` | `Config.User` |
| NC-03 | `container.readOnlyRootfs` | `HostConfig.ReadonlyRootfs` |
| NC-04 | `container.capAdd` / `capDrop` / `securityOpts` | `HostConfig.*` |
| NC-05 | `container.logConfig` — `{ driver, options }` | `HostConfig.LogConfig` |
| NC-06 | `container.restartCount`, `container.oomKilled` | `RestartCount`, `State.OOMKilled` — **`oomKilled` IMPLEMENTED** for DOCKER-009; `restartCount` still outstanding |
| NC-07 | `container.networkAliases` — per-network alias list | `NetworkSettings.Networks[*].Aliases` |
| NC-08 | `image.rootfsLayers` (layer count/IDs), `image.user`, `image.healthcheck` | `RootFS.Layers`, `Config.*` |

### New requirement types (need a handler; most need no new read)

| # | Requirement type | Reads | Notes |
|---|---|---|---|
| NC-09 | `docker_container_restart_policy` | existing snapshot | field already present, unused |
| NC-10 | `docker_container_command` / `_entrypoint` | existing snapshot | argv assertion; already present, unused |
| NC-11 | `docker_container_label` | existing snapshot | how a lab proves Compose actually created it (`com.docker.compose.project`) |
| NC-12 | `docker_network_internal`, `docker_network_containers` | existing snapshot | fields already present, unused |
| NC-13 | `docker_image_size` (`max: "80m"`), `docker_image_layers` (`max_layers: N`) | NC-08 + existing `sizeBytes` | |
| NC-14 | `docker_image_same_id` — two references resolve to one image ID | existing `id` | the honest way to grade a retag / promotion |
| NC-15 | `docker_container_health`, `_user`, `_read_only`, `_capabilities`, `_log_driver`, `_oom_killed`, `_restart_count`, `_network_alias` | NC-01…NC-07 | one handler each |
| NC-16 | `docker_container_bind_mount` (`source`, `destination`, `read_only`) and `docker_container_tmpfs` | existing `mounts[]` (`type: bind`) | current `docker_container_mount` **rejects** non-volume mounts by design |

### New reader capability (the significant ones)

| # | Capability | Why |
|---|---|---|
| NC-17 | **`DockerVerifyReader.exec()`** — a *private* wrapper over `execInContainer`, never reachable from lab.yaml. Backs the narrow checks below. | Everything in §2(b) |
| NC-18 | `docker_container_file_exists` / `docker_container_file_content` — handler builds `["test","-f",path]` / `["cat",path]` | Proves a volume actually persisted data; proves a read-only rootfs blocked a write |
| NC-19 | `docker_dns_resolves` — `from: <container>`, `hostname: <name>`; handler builds `["getent","hosts",name]` | The DNS lab; the network-failure troubleshooting lab |
| NC-20 | `docker_http_reachable` — `from`, `host`, `port`, `path`, `expect_status`; handler builds the argv | Multi-container, Compose, production challenge |
| NC-21 | `docker_container_logs_contain` — `pattern` (literal substring), `tail` | Logging lab, health-check lab, every troubleshooting lab. Requires revisiting the "logs are never shown to students" rule: a *boolean* over logs is not the same as surfacing them |
| NC-22 | `compose_file_valid` — structural parse of `compose.yaml` (services, `depends_on`, `healthcheck`, `volumes`, `networks`, `build`). Read-only, no execution, exact analogue of `dockerfile_valid` | Compose labs that currently degrade to substring matching |
| NC-23 | `docker_registry_has_image` — HTTP GET a `registry:2` container's `/v2/<name>/tags/list` | Registry workflow lab |
| NC-24 | **Session workspace mounted into the dind sandbox** at a stable path (e.g. `/workspace`), so `-v /workspace/site:/usr/share/nginx/html` behaves as a student expects | Blocks the bind-mount lab entirely; see §2(a) |

### Setup schema additions

| # | Capability |
|---|---|
| NC-25 | `containers[].healthcheck` — `{ test: argv[], interval, timeout, retries, start_period }`. Needed to *seed a broken health check* |
| NC-26 | `containers[].user`, `.read_only`, `.cap_drop`, `.cap_add`, `.security_opt`, `.tmpfs`, `.pids_limit` |
| NC-27 | `containers[].log_driver` + `log_options` |
| NC-28 | `containers[].bind` mounts sourced from the seeded workspace (depends on NC-24) |

### Explicitly *not* recommended

- **A generic `docker_exec_command` requirement.** It would let lab.yaml carry an
  argv into an execution context, which is exactly the property the Docker
  vocabulary was built to avoid. The narrow NC-18…NC-20 checks give the same
  teaching value with none of the blast radius.
- **A lab whose pass condition is "you ran `docker stats`".** Unverifiable
  state-based, and gradeable only by inspecting shell history, which the platform
  correctly refuses to do. `stats` belongs in the *narrative* of the resource and
  OOM labs, graded via `oomKilled` and the enforced limits.

---

## 4. Proposed curriculum — 25 labs

**IDs are frozen.** `labId` is the progress-record key
(`services/progress/src/service.ts:47`), so `DOCKER-001` … `DOCKER-010` keep
their IDs and their existing student history. Sequencing is done entirely with
the `order:` field, which is presentation-only
(`services/lab-orchestrator/src/lab-registry.ts:474`). New labs take
`DOCKER-011` … `DOCKER-027` regardless of where they sit in the sequence.

Legend: **[keep]** ships as-is · **[revise]** existing lab, content/verification
deepened · **[new]** does not exist.

---

### Band A — Foundations (beginner) · orders 1–5

---

#### DOCKER-001 · Run Your First Container · **[keep]**
- **Order:** 1 · **Difficulty:** beginner · **Prereq:** —
- **Skills:** `docker.containers.run`, `docker.containers.inspect`
- **Scenario:** First day on the JumpToTech Bank platform team; prove you can start a container.
- **Task:** Run `nginx:1.27-alpine` as a container named `web`, detached, and leave it running.
- **Starting state:** `nginx:1.27-alpine` preloaded. No containers.
- **Verifier approach:** `docker_container_exists` + `_image` + `_running`.
- **Current capability:** ✅ complete.
- **New capability:** none.

#### DOCKER-002 · Manage the Container Lifecycle · **[keep]**
- **Order:** 2 · **Difficulty:** beginner · **Prereq:** DOCKER-001
- **Skills:** `docker.containers.lifecycle`, `docker.containers.remove`, `docker.containers.inspect`
- **Scenario:** Morning triage: one service is down, one is decommissioned, one job needs to run once.
- **Task:** Restart `ledger-api`, remove `stale-worker`, create `audit-log` that runs and exits 0.
- **Starting state:** `alpine:3.20`; `ledger-api` exited; `stale-worker` running.
- **Verifier approach:** `docker_container_running`, `docker_resource_absent`, `docker_container_state: exited`, `docker_container_exit_code: 0`.
- **Current capability:** ✅ complete.
- **New capability:** none.

#### DOCKER-011 · Inspect, Exec, and Read Logs · **[new]**
- **Order:** 3 · **Difficulty:** beginner · **Prereq:** DOCKER-002
- **Skills:** `docker.containers.inspect`, `docker.containers.exec`, `docker.troubleshooting.logs`
- **Scenario:** Before you can fix a container you have to be able to interrogate one. Three containers are running and you have been given no documentation about any of them.
- **Task:** Using `docker inspect`, `docker exec`, and `docker logs`, determine each container's working directory, the value of an env var it was started with, and which one is writing an error to its log. Record your findings by creating a container named `findings` whose environment carries the three answers (`WORKDIR_ANSWER`, `ENV_ANSWER`, `FAILING_ANSWER`) and which exits 0. Additionally, create the file `/data/report.txt` inside the running `probe` container containing the failing service's name.
- **Starting state:** three seeded containers with differing `workdir`, `env`, and commands — one writing a distinctive error line to stderr on a loop; plus a `probe` container with a volume at `/data`.
- **Verifier approach:** `docker_container_env` ×3 on `findings` + `docker_container_exit_code` (the answers are graded, so the student must actually have inspected) + `docker_container_file_content` on `probe:/data/report.txt`.
- **Current capability:** ⚠️ partial — env and exit-code checks exist.
- **New capability:** **NC-17, NC-18** (read a file inside a container). Without NC-18 the lab still works using only the `findings` env answers — a reasonable v1.

#### DOCKER-003 · Pull, Inspect, and Tag Images · **[revise]**
- **Order:** 4 · **Difficulty:** beginner · **Prereq:** DOCKER-001
- **Skills:** `docker.images.pull`, `docker.images.tag`, `docker.images.inspect`, `docker.images.digest`
- **Scenario:** The bank mirrors upstream images under an internal name before anything runs in production. You are doing that promotion by hand today.
- **Task (extended):** Pull `busybox:1.36`. Promote it as `jumptotech/toolbox:1.0`, **and** as `jumptotech/toolbox:latest` — both pointing at the same image ID, not two builds. Report the image's declared entrypoint by creating `answers.txt` in your workspace containing the digest.
- **Starting state:** no images preloaded (the pull is the exercise). Unchanged.
- **Verifier approach:** existing `docker_image_exists` ×3, plus `docker_image_same_id` proving `jumptotech/toolbox:1.0` and `:latest` resolve to the same ID, plus `workspace_file_exists` with `contains: ["sha256:"]`.
- **Current capability:** ⚠️ partial — `image_exists` and `workspace_file_exists` exist.
- **New capability:** **NC-14** (`docker_image_same_id`).

#### DOCKER-007 · Configure a Container with Environment Variables · **[keep]**
- **Order:** 5 · **Difficulty:** beginner · **Prereq:** DOCKER-001
- **Skills:** `docker.config.environment`, `docker.containers.run`, `docker.containers.inspect`
- **Scenario:** The statements service is configured entirely by environment.
- **Task:** Run `statements` with two inline vars and one from `statements.env`.
- **Starting state:** `alpine:3.20`, `statements.env` seeded in the workspace.
- **Verifier approach:** `docker_container_running` + `docker_container_env` ×3.
- **Current capability:** ✅ complete.
- **New capability:** none.

---

### Band B — Core mechanics (intermediate) · orders 6–13

---

#### DOCKER-012 · Publish Ports and Reach a Container · **[new]**
- **Order:** 6 · **Difficulty:** intermediate · **Prereq:** DOCKER-001
- **Skills:** `docker.networks.ports`, `docker.containers.run`, `docker.containers.inspect`
- **Scenario:** The ledger API has to be reachable from outside its container. Two copies must run side by side without colliding.
- **Task:** Run `ledger-api` publishing container port 80 on host port 8080, and `ledger-api-canary` publishing the same container port on 8081. Confirm that a container on the same daemon can actually fetch a page from `ledger-api`. Explain (in `answers.txt`) the difference between `EXPOSE` and `-p`.
- **Starting state:** `nginx:1.27-alpine`, `curlimages/curl` (or a busybox `wget`) preloaded.
- **Verifier approach:** `docker_container_port` ×2 (with `host_port`), `docker_container_running` ×2, `docker_http_reachable` from a client container to `ledger-api:80` expecting 200, `workspace_file_exists`.
- **Current capability:** ⚠️ partial — `docker_container_port` fully supports this today; the *reachability* half does not exist.
- **New capability:** **NC-17, NC-20** (`docker_http_reachable`). Ships without it as a config-only lab; the reachability check is what makes it worth doing.

#### DOCKER-004 · Build an Image from a Dockerfile · **[revise]**
- **Order:** 7 · **Difficulty:** intermediate · **Prereq:** DOCKER-003, DOCKER-011
- **Skills:** `docker.dockerfile.author`, `docker.images.build`, `docker.images.tag`, `docker.containers.run`
- **Scenario:** Ship the greeter service as an image instead of a pile of files.
- **Task (extended):** Same build, plus the image must declare `EXPOSE 8080`, carry `LABEL org.opencontainers.image.source`, and set an `ENV` the container inherits.
- **Starting state:** `alpine:3.20`, `message.txt` seeded.
- **Verifier approach:** existing set, plus `docker_image_config` with `exposed_port`, `labels`, and `env` — **all three already supported by the existing handler and schema.**
- **Current capability:** ✅ complete. This revision costs content edits only, no code.
- **New capability:** none.

#### DOCKER-013 · Layers and the Build Cache · **[new]**
- **Order:** 8 · **Difficulty:** intermediate · **Prereq:** DOCKER-004
- **Skills:** `docker.images.layers`, `docker.images.cache`, `docker.dockerfile.author`
- **Scenario:** The greeter image rebuilds from scratch on every commit because the Dockerfile installs dependencies *after* copying source. CI takes four minutes for a one-line change.
- **Task:** Rewrite the Dockerfile so the dependency step is cached across source changes — dependency manifest copied and installed before application source — and build it as `jumptotech/greeter:2.0`. The rebuilt image must have **no more than 8 layers** and must still run correctly.
- **Starting state:** a deliberately cache-hostile Dockerfile seeded in the workspace, plus `requirements.txt`-style manifest and a `src/` file.
- **Verifier approach:** `dockerfile_valid` (instruction presence), `docker_image_exists`, `docker_image_layers` with `max_layers: 8`, `docker_container_exit_code: 0` from a run of the new image. Cache *behaviour* is not directly gradeable state-based; the layer count plus the instruction ordering is the honest proxy, and the lab says so.
- **Current capability:** ⚠️ partial — everything except layer counting.
- **New capability:** **NC-08, NC-13** (`docker_image_layers`).

#### DOCKER-014 · CMD, ENTRYPOINT, and the Container Command · **[new]**
- **Order:** 9 · **Difficulty:** intermediate · **Prereq:** DOCKER-004
- **Skills:** `docker.dockerfile.author`, `docker.containers.run`, `docker.images.inspect`
- **Scenario:** The batch tool must behave like a real CLI: `docker run jumptotech/batch --dry-run` should pass `--dry-run` to the program, not replace the program.
- **Task:** Build `jumptotech/batch:1.0` with an `ENTRYPOINT` in exec form and a default `CMD` supplying default arguments. Then run two containers: `batch-default` (no args, takes the default) and `batch-override` (arguments supplied at run time, entrypoint unchanged). Both must exit 0.
- **Starting state:** `alpine:3.20`, a small script seeded in the workspace.
- **Verifier approach:** `dockerfile_valid` requiring `ENTRYPOINT` and `CMD`; `docker_image_config` with `cmd_contains`; `docker_container_entrypoint` on both containers proving the entrypoint survived; `docker_container_command` proving `batch-override`'s argv differs; `docker_container_exit_code: 0` ×2.
- **Current capability:** ⚠️ partial — `entrypoint` and `command` are **already in `DockerContainerSnapshot` and unread**.
- **New capability:** **NC-10** (`docker_container_command` / `_entrypoint`). Low cost, high value.

#### DOCKER-005 · Persist Data with Volumes · **[revise]**
- **Order:** 10 · **Difficulty:** intermediate · **Prereq:** DOCKER-002
- **Skills:** `docker.volumes.create`, `docker.volumes.mount`, `docker.volumes.lifecycle`
- **Scenario:** The ledger database lost a day of transactions when someone recreated the container. Prove that cannot happen again.
- **Task (extended):** Create volume `ledger-data`, run `ledger-db` with it at `/var/lib/ledger`, **write a record into it, destroy the container, and recreate it** — the record must still be there. Then create a second container `ledger-reader` that mounts the same volume read-only.
- **Starting state:** `alpine:3.20`.
- **Verifier approach:** existing `docker_volume_exists` / `_container_mount` / `_container_running`, plus `docker_container_file_content` reading `/var/lib/ledger/txn.log` inside the *recreated* container (this is what proves persistence, and it is unfakeable), plus a read-only mount assertion on `ledger-reader`.
- **Current capability:** ⚠️ partial — mounting is verified; persistence is not, and `docker_container_mount` has no `read_only` field.
- **New capability:** **NC-17, NC-18**, plus `read_only` added to `docker_container_mount`.

#### DOCKER-015 · Bind Mounts and the Development Loop · **[new]**
- **Order:** 11 · **Difficulty:** intermediate · **Prereq:** DOCKER-005
- **Skills:** `docker.storage.bindmounts`, `docker.containers.run`, `docker.troubleshooting.storage`
- **Scenario:** A developer wants to edit the site's HTML on their machine and see it served immediately, with no rebuild. Then explain why the same trick is a bad idea in production.
- **Task:** Bind-mount the workspace `site/` directory into `web` at `/usr/share/nginx/html` read-only, and confirm the served content matches the file you edited. Also demonstrate mount shadowing: mount over a path that already has content in the image, and record what happened to the original files.
- **Starting state:** `nginx:1.27-alpine`; `site/index.html` seeded in the workspace.
- **Verifier approach:** `docker_container_bind_mount` (source, destination, `read_only: true`), `docker_container_file_content` reading the served file through the mount, `workspace_file_exists` for the shadowing write-up.
- **Current capability:** ❌ **blocked.** `docker_container_mount` explicitly rejects bind mounts by design, *and* §2(a) means the student's `$PWD` is not visible to the daemon at all.
- **New capability:** **NC-24 (blocking — workspace mounted into the dind sandbox), NC-16, NC-17, NC-18, NC-28.** This is the single most expensive lab in the plan. If NC-24 is not funded, **drop this lab** and fold a short bind-mount discussion into DOCKER-005's narrative — do not ship a bind-mount lab that cannot bind-mount the student's own files.

#### DOCKER-006 · Connect Containers on a Custom Network · **[revise]**
- **Order:** 12 · **Difficulty:** intermediate · **Prereq:** DOCKER-012
- **Skills:** `docker.networks.create`, `docker.networks.attach`, `docker.networks.dns`
- **Scenario:** The API and the worker must talk to each other by name, not by IP.
- **Task (extended):** Same network and two containers, **plus** the worker must be able to resolve `ledger-api` by name, and you must show that a third container on the default bridge *cannot*.
- **Starting state:** `nginx:1.27-alpine`, `alpine:3.20`.
- **Verifier approach:** existing checks, plus `docker_dns_resolves` from `ledger-worker` to `ledger-api` (pass) and from an off-network container (must fail to resolve — asserted as the negative).
- **Current capability:** ⚠️ partial — attachment is verified; name resolution, the actual lesson, is not.
- **New capability:** **NC-17, NC-19** (`docker_dns_resolves`, with a negative form).

#### DOCKER-009 · Constrain a Container with Resource Limits · **[revise]**
- **Order:** 13 · **Difficulty:** intermediate · **Prereq:** DOCKER-001
- **Skills:** `docker.resources.limits`, `docker.observability.stats`, `docker.containers.inspect`
- **Scenario:** A runaway report job took a node down. Every batch container now ships with limits.
- **Task (extended):** Run `reporting` limited to 256m memory, 0.5 CPU, **and 64 processes**; set a memory *reservation* below the limit and explain the difference. Observe live consumption with `docker stats` and record the steady-state memory in `answers.txt`.
- **Starting state:** `alpine:3.20`.
- **Verifier approach:** existing `docker_container_resource_limit` — `memory`, `cpus`, **and `pids_limit`, all three already supported by the schema and handler** — plus `workspace_file_exists`. Memory reservation needs a new field on the same requirement (`limits.memoryReservationBytes` is already in the snapshot).
- **Current capability:** ✅ mostly complete — `pids_limit` is already implemented and simply unused by the current lab.
- **New capability:** `memory_reservation` field on `docker_container_resource_limit` (snapshot data already present). Optional.

---

### Band C — Advanced · orders 14–19

---

#### DOCKER-016 · Service Discovery, DNS, and Network Isolation · **[new]**
- **Order:** 14 · **Difficulty:** advanced · **Prereq:** DOCKER-006
- **Skills:** `docker.networks.dns`, `docker.networks.segmentation`, `docker.networks.aliases`
- **Scenario:** The bank's ledger tier must reach the database; the public web tier must not. The database must be reachable under a stable alias so the connection string never changes when the container is replaced.
- **Task:** Build a two-network topology — `ledger-front` (public) and `ledger-back` (`internal: true`). Put `api` on both, `db` on `ledger-back` only with the network alias `ledger-db`, and `web` on `ledger-front` only. Prove `api` resolves `ledger-db`, and prove `web` cannot resolve or reach `db` at all.
- **Starting state:** `nginx:1.27-alpine`, `alpine:3.20`. No networks seeded — building the topology is the exercise.
- **Verifier approach:** `docker_network_exists` ×2, `docker_network_internal` on `ledger-back`, `docker_container_network` ×4, `docker_container_network_alias` on `db`, `docker_dns_resolves` positive from `api`, `docker_dns_resolves` negative from `web`.
- **Current capability:** ⚠️ partial — networks and attachment yes; `internal` is **in the snapshot and unread**; aliases and DNS are absent.
- **New capability:** **NC-07, NC-12, NC-17, NC-19.**

#### DOCKER-017 · Multi-Stage Builds and Image Size · **[new]**
- **Order:** 15 · **Difficulty:** advanced · **Prereq:** DOCKER-013, DOCKER-014
- **Skills:** `docker.images.multistage`, `docker.images.optimize`, `docker.dockerfile.author`
- **Scenario:** The greeter image is 480 MB because it ships the compiler, the package cache, and the source tree into production. Security has flagged it.
- **Task:** Convert the build to multi-stage — a named build stage that compiles, and a minimal runtime stage that copies only the artifact. Tag it `jumptotech/greeter:3.0`. It must be **under 30 MB**, have **at most 6 layers**, run correctly, and the Dockerfile must show at least two `FROM` instructions with a `COPY --from`. Also add a `.dockerignore` that keeps the build context small.
- **Starting state:** the single-stage Dockerfile from DOCKER-013 seeded, plus source and a `node_modules`-style directory of junk the context should exclude.
- **Verifier approach:** `dockerfile_valid` (multi-`FROM` — the parser already collects `baseImages[]`, so a `min_stages: 2` field is a small extension), `docker_image_exists`, `docker_image_size` `max: "30m"`, `docker_image_layers` `max_layers: 6`, `docker_container_exit_code: 0`, `workspace_file_exists` for `.dockerignore`.
- **Current capability:** ⚠️ partial — the Dockerfile parser already handles `FROM … AS stage` correctly, and `sizeBytes` is already in the snapshot.
- **New capability:** **NC-08, NC-13**, plus `min_stages` on `dockerfile_valid`.

#### DOCKER-019 · Health Checks and Restart Policies · **[new]**
- **Order:** 16 · **Difficulty:** advanced · **Prereq:** DOCKER-012, DOCKER-004
- **Skills:** `docker.health.checks`, `docker.containers.restart`, `docker.dockerfile.author`
- **Scenario:** `ledger-api` answers TCP but returns 500 to every request. The orchestrator thinks it is fine because "the process is running" is the only signal it has.
- **Task:** Add a `HEALTHCHECK` to the image that tests the application's `/healthz` endpoint (not merely that the port is open), with a sane interval, timeout, retries, and start period. Build it, run it as `ledger-api` with `--restart unless-stopped`, and get it to report `healthy`. Then run a second container `ledger-api-broken` whose health check correctly reports `unhealthy`, and explain why Docker does not restart it.
- **Starting state:** `nginx:1.27-alpine` plus a seeded config that serves `/healthz`; a Dockerfile skeleton.
- **Verifier approach:** `dockerfile_valid` requiring `HEALTHCHECK`, `docker_image_healthcheck`, `docker_container_health: healthy` on one and `unhealthy` on the other, `docker_container_restart_policy: unless-stopped`.
- **Current capability:** ❌ **absent.** `HEALTHCHECK` is a recognised Dockerfile keyword and a legal `dockerfile_valid` requirement, but nothing reads health state; `restartPolicy` is in the snapshot and unread.
- **New capability:** **NC-01, NC-08, NC-09, NC-15.** The verifier must also tolerate `starting` — health has a settling window, so this lab needs a re-check or a generous `start_period`.

#### DOCKER-020 · Harden a Container: Non-Root, Read-Only, Capabilities · **[new]**
- **Order:** 17 · **Difficulty:** advanced · **Prereq:** DOCKER-017
- **Skills:** `docker.security.nonroot`, `docker.security.readonly`, `docker.security.capabilities`
- **Scenario:** The bank's container baseline says: no process runs as UID 0, the root filesystem is read-only, all capabilities are dropped except what the process provably needs, and privilege escalation is off.
- **Task:** Rebuild the greeter image so it declares a non-root `USER`, then run it as `greeter-hardened` with `--read-only`, a `tmpfs` for the one path that must be writable, `--cap-drop ALL` (adding back only what is needed), and `--security-opt no-new-privileges`. Prove the read-only filesystem is real by showing a write to a non-tmpfs path fails.
- **Starting state:** the multi-stage Dockerfile from DOCKER-017, running as root.
- **Verifier approach:** `dockerfile_valid` requiring `USER`; `docker_image_user` non-root; `docker_container_user` non-root; `docker_container_read_only: true`; `docker_container_tmpfs` at the writable path; `docker_container_capabilities` with `dropped: [ALL]`; `docker_container_security_opt` containing `no-new-privileges`; `docker_container_running`; and `docker_container_file_exists` proving the write to the read-only path did **not** land.
- **Current capability:** ❌ **absent.** None of `User`, `ReadonlyRootfs`, `CapDrop`, or `SecurityOpt` is in the snapshot. `USER` is a legal `dockerfile_valid` requirement — that is the only piece that exists.
- **New capability:** **NC-02, NC-03, NC-04, NC-08, NC-15, NC-16 (tmpfs), NC-17, NC-18.**

#### DOCKER-022 · Logging Drivers and Log Rotation · **[new]**
- **Order:** 18 · **Difficulty:** advanced · **Prereq:** DOCKER-011
- **Skills:** `docker.logging.drivers`, `docker.logging.rotation`, `docker.troubleshooting.logs`
- **Scenario:** A chatty container filled the host disk with a 40 GB JSON log file and took three unrelated services down with it. Every container now ships with a bounded log configuration.
- **Task:** Run `chatty` with the `json-file` driver capped at `max-size=10m` and `max-file=3`, and confirm the application's startup line reaches the log. Then run `quiet` with the `none` driver and explain in `answers.txt` what you gave up and why you would only do that when logs are shipped another way.
- **Starting state:** `alpine:3.20`, a container command that emits a distinctive banner then loops.
- **Verifier approach:** `docker_container_log_driver` with driver and options on both containers; `docker_container_logs_contain` asserting the banner is present for `chatty`; `workspace_file_exists`.
- **Current capability:** ❌ **absent.** `HostConfig.LogConfig` is not in the snapshot, and `containerLogs` exists on the port but is not exposed to the verifier.
- **New capability:** **NC-05, NC-15, NC-21.** NC-21 needs a deliberate decision: `containerLogs` is currently documented "never shown to students". A boolean *"does this pattern appear"* is not the same as surfacing log text, and the failure detail can say "the expected startup line was not found" without echoing the log.

#### DOCKER-021 · Registry Workflows and Tagging Strategy · **[new]**
- **Order:** 19 · **Difficulty:** advanced · **Prereq:** DOCKER-003, DOCKER-017
- **Skills:** `docker.registry.push`, `docker.registry.pull`, `docker.images.tag`, `docker.images.digest`
- **Scenario:** The bank runs its own registry. An image is promoted dev → staging by *retagging and pushing the same bytes*, never by rebuilding — the digest must be identical on both sides.
- **Task:** A private `registry:2` is running at `registry:5000` on the lab network. Tag the greeter image for that registry as `registry:5000/jumptotech/greeter:1.4.2`, push it, then also publish the moving tags `1.4` and `stable` pointing at the same image, and push those. Finally, delete the local copies and pull it back by **digest**, proving you got the same image.
- **Starting state:** a `registry:2` container seeded on a lab network with `--name registry`, plus a prebuilt greeter image. Expressible with the setup schema today (image + name + network + port).
- **Verifier approach:** `docker_registry_has_image` querying the registry's `/v2/jumptotech/greeter/tags/list` for all three tags; `docker_image_same_id` across the three local references; `docker_image_exists` for the digest-pulled reference.
- **Current capability:** ❌ **absent** for the registry side. Seeding the registry container needs no new setup capability.
- **New capability:** **NC-14, NC-23.** NC-23 is an HTTP GET from the verifier's side of the daemon; simplest implementation is NC-17 exec (`wget -qO-`) from a client container, which avoids giving the verifier its own network path into the sandbox.

---

### Band D — Compose and multi-container · order 20

---

#### DOCKER-008 · Multi-Container Applications with Compose · **[revise — substantially]**
- **Order:** 20 · **Difficulty:** advanced (was intermediate) · **Level:** challenge · **Prereq:** DOCKER-016, DOCKER-019
- **Skills:** `docker.compose.author`, `docker.compose.lifecycle`, `docker.compose.healthgating`, `docker.networks.attach`, `docker.volumes.mount`
- **Scenario:** The ledger stack is four services: a web front end, an API, a worker, and a database. The API must not start until the database is *healthy*, not merely started. The database's data must survive `compose down`.
- **Task:** Complete `compose.yaml` so that: all four services run on the right networks (front-facing and internal); `db` has a health check and a named volume; `api` declares `depends_on: db: condition: service_healthy`; `worker` is configured from an env file; and the whole stack comes up with one command. Then prove `web` can reach `api` and cannot reach `db`.
- **Starting state:** a partial `compose.yaml` with two services and deliberate omissions; an env file; preloaded images.
- **Verifier approach:** `compose_file_valid` asserting service names, `depends_on` with the health condition, a `healthcheck` block, a named volume, and two networks — **replacing today's substring match, which is the weakest check in the whole track**; `docker_container_label` on `com.docker.compose.project` proving the stack was genuinely brought up by Compose rather than by four `docker run` commands; `docker_container_running` ×4; `docker_container_health: healthy` on `db`; `docker_volume_exists`; `docker_http_reachable` positive `web`→`api`; `docker_dns_resolves` negative `web`→`db`.
- **Current capability:** ❌ largely absent. Today the Compose-ness of this lab is unverified.
- **New capability:** **NC-01, NC-11, NC-15, NC-17, NC-19, NC-20, NC-22.** NC-22 (`compose_file_valid`) is the keystone: without it, no Compose lab can be graded on anything but state that hand-run containers could also produce.
- **Container budget note:** four services + a verifier client container = 5, well inside the 10-container policy.

---

### Band E — Troubleshooting · orders 21–25

Every lab in this band follows one shape: **a broken starting state seeded by
`setup.docker`, no instructions on what is wrong, and requirements that describe
only the healthy end state.** The diagnosis is the lab; the repair is the proof.

---

#### DOCKER-010 · Container Startup Failure · **[revise — retitle and deepen]**
- **Order:** 21 · **Difficulty:** intermediate · **Level:** challenge · **Prereq:** DOCKER-011, DOCKER-014
- **Skills:** `docker.troubleshooting.containers`, `docker.troubleshooting.logs`, `docker.containers.inspect`, `docker.config.environment`
- **Scenario:** Three containers were deployed last night. None of them is serving. Each failed for a different reason.
- **Task (extended from today's two-fault repair):** Restore all three. Fault classes: (1) a bad entrypoint/command — the process exits immediately with a non-zero code; (2) a misconfigured env value plus a wrong published port — today's lab; (3) an image tag that does not exist locally and cannot be pulled.
- **Starting state:** three seeded containers, all `exited`, with distinguishable exit codes and log output. Seeding fault (1) needs only `command:` in the existing schema; (3) needs a container created against a nonexistent tag — check whether the provider's seeding tolerates that, or seed the fault as a `docker run` the student must correct from a `create`d container.
- **Verifier approach:** existing types cover all three end states — `docker_container_running`, `_image`, `_port`, `_env`, `_exit_code`. Add `docker_container_command` to prove the entrypoint was actually fixed rather than the container replaced with something else.
- **Current capability:** ✅ mostly complete.
- **New capability:** **NC-10** only. Content work, not platform work — the cheapest large improvement in the plan.

#### DOCKER-023 · Network Failure Between Two Services · **[new]**
- **Order:** 22 · **Difficulty:** advanced · **Level:** challenge · **Prereq:** DOCKER-016
- **Skills:** `docker.troubleshooting.network`, `docker.networks.dns`, `docker.networks.segmentation`
- **Scenario:** `ledger-api` reports "could not resolve host: ledger-db" in its logs. Yesterday it worked.
- **Task:** Diagnose and fix. Three plausible faults are present, and the student must find which apply: the two containers are on *different* user-defined networks; the database was renamed so the alias the API dials no longer resolves; and the network the API is on is marked `internal` when it needs egress. End state: `api` resolves and reaches `db` by its expected name, and `web` still cannot.
- **Starting state:** seeded two-network topology with the faults baked in via `setup.docker` (`networks[].internal` and per-container `network` already exist in the schema).
- **Verifier approach:** `docker_dns_resolves` positive and negative, `docker_container_network`, `docker_network_internal`, `docker_container_network_alias`, `docker_http_reachable`.
- **Current capability:** ⚠️ partial — the *seeding* is fully expressible today; the *verification* is not.
- **New capability:** **NC-07, NC-12, NC-17, NC-19, NC-20.**

#### DOCKER-024 · Volume and Data-Loss Failure · **[new]**
- **Order:** 23 · **Difficulty:** advanced · **Level:** challenge · **Prereq:** DOCKER-005
- **Skills:** `docker.troubleshooting.storage`, `docker.volumes.mount`, `docker.volumes.lifecycle`
- **Scenario:** Every restart of `ledger-db` comes up with an empty database. Someone insists "it has a volume".
- **Task:** Find why the data is not persisting and fix it without losing what is currently in the orphaned volume. Faults: the volume is mounted at the wrong path (the application writes elsewhere), a second container holds the *correct* data in a differently-named volume, and one mount is read-only so writes are silently failing.
- **Starting state:** two seeded volumes (one holding data written by a seeded container, one empty and mounted at the wrong path), a container with a `read_only: true` mount — **all three expressible with today's setup schema.**
- **Verifier approach:** `docker_volume_exists`, `docker_container_mount` with the correct destination and `read_only: false`, and `docker_container_file_content` proving the recovered record is readable inside the running container. The last check is what makes this a data-recovery lab rather than a config-diff lab.
- **Current capability:** ⚠️ partial — seeding yes, and mount/destination checks yes; the persistence proof and the `read_only` assertion are missing.
- **New capability:** **NC-17, NC-18**, plus `read_only` on `docker_container_mount`.

#### DOCKER-025 · OOM Kill and CPU Starvation · **[new]**
- **Order:** 24 · **Difficulty:** advanced · **Level:** challenge · **Prereq:** DOCKER-009
- **Skills:** `docker.troubleshooting.resources`, `docker.resources.limits`, `docker.observability.stats`
- **Scenario:** The nightly reporting job dies every night at 02:14 with exit code 137 and no application error. A second job runs but takes twenty times longer than it should.
- **Task:** Diagnose both. The first is being OOM-killed by a memory limit set far below what the workload needs. The second is CPU-throttled by a `--cpus 0.05` limit nobody remembers setting. Fix both to sane values, restart them, and record in `answers.txt` what exit code 137 means and how you distinguished an OOM kill from an application crash.
- **Starting state:** `reporting` seeded exited with `memory: 16m` and a command that allocates; `nightly-batch` seeded running with `cpus: "0.05"`. Both fully expressible today.
- **Verifier approach:** `docker_container_oom_killed: false` on the repaired container (this is the diagnostic signal, and it is the only unambiguous one), `docker_container_resource_limit` with corrected memory and cpus, `docker_container_running`, `docker_container_exit_code` where relevant, `workspace_file_exists`.
- **Current capability:** ⚠️ partial — limits are fully checkable today; `State.OOMKilled` is not in the snapshot, so the lab currently could not distinguish an OOM kill from any other exit 137.
- **New capability:** **NC-06, NC-15.** One snapshot field. Very cheap for the value.

#### DOCKER-026 · Bad Health Check and Restart Loop · **[new]**
- **Order:** 25 · **Difficulty:** advanced · **Level:** challenge · **Prereq:** DOCKER-019
- **Skills:** `docker.troubleshooting.health`, `docker.health.checks`, `docker.containers.restart`
- **Scenario:** `ledger-api` has restarted 400 times since midnight. It is healthy for about eight seconds each time. The application team says nothing changed.
- **Task:** Diagnose a health check that is wrong rather than an application that is broken: the check has a `start_period` shorter than the application's startup time, a timeout shorter than the endpoint's response time, and it tests the wrong path. Fix the check so the container reaches `healthy` and stops restarting. Separately, a second container's health check is *passing* while the service is actually broken (it tests that the port is open, not that the app works) — fix that one too.
- **Starting state:** two seeded containers with health checks configured to fail in those specific ways, plus `restart: always` so the loop is visible.
- **Verifier approach:** `docker_container_health: healthy`, `docker_container_restart_count` with `max` (proving the loop stopped — a count that keeps climbing is the failure), `docker_container_running`, `docker_container_restart_policy`.
- **Current capability:** ❌ **absent on both sides.** The setup schema cannot seed a health check at all, and nothing reads health state or restart count.
- **New capability:** **NC-01, NC-06, NC-15, NC-25.** NC-25 (seedable `healthcheck`) is required — without it this lab cannot exist.

---

### Band F — Production challenge · order 26

---

#### DOCKER-027 · Production Incident: The Ledger Stack Is Down · **[new]**
- **Order:** 26 · **Difficulty:** advanced · **Level:** **assessment** · **Prereq:** DOCKER-008, DOCKER-020, DOCKER-023, DOCKER-025, DOCKER-026
- **Duration:** 90 minutes
- **Skills:** `docker.troubleshooting.production`, `docker.compose.lifecycle`, `docker.networks.dns`, `docker.health.checks`, `docker.resources.limits`, `docker.security.nonroot`, `docker.observability.stats`
- **Scenario:** 03:40. You are on call. The JumpToTech Bank ledger stack — `web`, `api`, `worker`, `db` — is not serving. The pager says nothing useful. There are no instructions and no hint about which layer is broken. You have the stack, the Compose file, and a terminal.
- **Task:** Restore the stack to a healthy, *production-compliant* state. Four independent faults are present, one per layer:
  1. **Network** — `api` and `db` are on different networks; `api` cannot resolve `db`.
  2. **Health** — `db`'s health check tests the wrong path, so `api`'s `depends_on: service_healthy` gate never opens.
  3. **Resources** — `worker` is OOM-killed within a minute of starting (exit 137, memory limit far too low).
  4. **Security regression** — `web` was "fixed" last week by someone who removed `--read-only`, dropped the non-root `USER`, and gave it `--privileged`. It runs, and it must be brought back into compliance without breaking it.
  The stack must come up under Compose, `db` must report `healthy`, `web` must reach `api`, `web` must **not** reach `db`, `worker` must run without being killed, and `web` must run as non-root on a read-only root filesystem with capabilities dropped. Write a short incident note in `postmortem.md` naming each fault, the signal that revealed it, and the fix.
- **Starting state:** a four-service Compose stack seeded broken — `compose.yaml` plus an env file in the workspace, four containers seeded in their failed states. Within the 8-container / 10-container budgets.
- **Verifier approach:** the union of the band's checks, all state-based: `compose_file_valid`; `docker_container_label` (`com.docker.compose.project`) ×4 proving Compose brought it up; `docker_container_running` ×4; `docker_container_health: healthy` on `db`; `docker_dns_resolves` positive `api`→`db` and negative `web`→`db`; `docker_http_reachable` `web`→`api` expecting 200; `docker_container_oom_killed: false` and corrected `docker_container_resource_limit` on `worker`; `docker_container_user` non-root, `docker_container_read_only: true`, `docker_container_capabilities` dropped, and *absence* of `privileged` on `web`; `workspace_file_exists` for `postmortem.md` with `contains` on the four fault keywords.
- **Current capability:** ❌ absent — this lab is the sum of everything above and cannot ship before the bands it depends on.
- **New capability:** everything from **NC-01 … NC-07, NC-11, NC-15, NC-17, NC-19, NC-20, NC-22, NC-25, NC-26**, plus a `privileged` field on the container snapshot.

---

## 5. Summary

**25 labs: 5 beginner · 8 intermediate · 11 advanced · 1 assessment.**
Of these, **10 exist** (5 keep as-is, 5 revised) and **15 are new**.

| Band | Orders | Labs | New |
|---|---|---|---|
| A — Foundations (beginner) | 1–5 | 5 | 1 |
| B — Core mechanics (intermediate) | 6–13 | 8 | 4 |
| C — Advanced | 14–19 | 6 | 6 |
| D — Compose / multi-container | 20 | 1 | 0 (major revision) |
| E — Troubleshooting | 21–25 | 5 | 4 |
| F — Production challenge | 26 | 1 | 1 |

### Topic coverage against the brief

| Requested | Covered by |
|---|---|
| containers | 001, 002, 011 |
| images | 003, 021 |
| Dockerfile | 004, 014 |
| layers | 013, 017 |
| build cache | 013 |
| multi-stage builds | 017 |
| CMD vs ENTRYPOINT | 014 |
| environment variables | 007, 008, 010 |
| volumes | 005, 024 |
| bind mounts | 015 *(blocked on NC-24)* |
| networks | 006, 016, 023 |
| DNS | 006, 016, 023, 027 |
| ports | 012, 010 |
| resource limits | 009, 025, 027 |
| health checks | 019, 026, 027, 008 |
| logging | 011, 022 |
| exec | 011, and the verifier's own NC-17 checks |
| inspect | 011, 003, and throughout |
| stats | 009, 025 *(narrative — deliberately not a pass condition)* |
| image optimization | 017, 013 |
| security | 020, 027 |
| non-root containers | 020, 027 |
| read-only filesystems | 020, 027 |
| capabilities | 020, 027 |
| Compose | 008, 027 |
| multi-container applications | 008, 016, 027 |
| registry workflows | 021 |
| image tagging | 003, 021 |
| troubleshooting | 010, 023, 024, 025, 026 |
| container startup failures | 010, 027 |
| network failures | 023, 027 |
| volume problems | 024 |
| OOM / resource issues | 025, 027 |
| bad health checks | 026, 027 |
| production debugging | 027 |

### Build order recommendation

Platform work gates most of this. Suggested sequencing:

1. **Snapshot fields first (NC-01…NC-08)** — one parser change each, and they
   unblock nine labs. Highest value per unit of work in the entire plan.
2. **Requirement types over data already in the snapshot (NC-09…NC-16)** — no new
   reads at all; `restartPolicy`, `command`, `entrypoint`, `labels`, `internal`,
   `sizeBytes` are already being fetched and thrown away.
3. **`DockerVerifyReader.exec()` (NC-17) and the four narrow checks built on it
   (NC-18…NC-21)** — the architectural decision in this plan. Needs sign-off on
   the closed-vocabulary approach before implementation.
4. **`compose_file_valid` (NC-22)** — without it every Compose lab is graded by
   substring match.
5. **Setup additions (NC-25…NC-27)** — health checks are the blocking one; 026
   cannot exist without seedable health checks.
6. **Workspace-into-sandbox mount (NC-24)** — the only genuinely large piece of
   infrastructure work, and it gates exactly one lab (015). Defer it, and defer
   015 with it.

### Content-only wins available immediately

**DOCKER-004** and **DOCKER-009** can be deepened today with zero platform work —
`docker_image_config` already supports `exposed_port`, `labels`, and `env`, and
`docker_container_resource_limit` already supports `pids_limit`. **DOCKER-010**
needs only NC-10. Those three are the fastest path to a visibly better track.

---

# 6. Official-source audit (policy review)

Added after the official-source curriculum policy. Sources consulted:

- **Docker Certified Associate Study Guide v1.5, January 2025** — the official
  guide, linked from Mirantis's own certification page and hosted on Mirantis's
  CDN: `https://a.storyblok.com/f/146871/x/2001ce939c/docker-study-guide_v1-5-jan-2025.pdf`
- **Mirantis DCA certification page** — https://training.mirantis.com/certification/dca-certification-exam/
- **Docker official documentation** — https://docs.docker.com/

No third-party source was used. Verified: 2026-08-23.

## 6.1 DCA status and scope

The exam is **active**, administered by Mirantis, with no retirement notice on
the official page. But the official page states its scope plainly:

> "While the Docker Certified Associate certification is designed for enterprise
> practitioners leveraging the Docker Enterprise Edition (EE) platform in
> production you will find that many of the topics covered in this foundational
> certification are also applicable to the freely available Docker Community
> Edition (CE)…"

Official domains and weightings, verbatim from the guide:

| Domain | Weight |
|---|---|
| 1. Orchestration | **25%** |
| 2. Image Creation, Management, and Registry | 20% |
| 3. Installation and Configuration | 15% |
| 4. Networking | 15% |
| 5. Security | 15% |
| 6. Storage and Volumes | 10% |

**Domain 1 (the largest, 25%) is Swarm and Kubernetes.** Its objectives are
`docker service`, `docker stack deploy`, swarm quorum, replicated vs global
services, node labels, and deploying Kubernetes pods/deployments/ConfigMaps.
Our Docker track teaches none of it.

Large parts of Domains 3 and 5 are **UCP and DTR** — proprietary Docker
Enterprise components we do not run and cannot lab on Community Edition:
"deploy the Docker engine, UCP, and DTR on AWS and on-premises in an HA
configuration", "configure backups for UCP and DTR", "configure RBAC with UCP",
"integrate UCP with LDAP/AD", "create UCP client bundles".

## 6.2 Conflicts with existing labs — policy §10 report

**CONFLICT 1 — DOCKER-009's claimed domain does not exist in the objectives**

- **EXISTING LAB:** DOCKER-009, Constrain a Container with Resource Limits
- **CURRENT BEHAVIOR:** declared `certification: DCA, relevant: true, domains: [installation-and-configuration]`
- **OFFICIAL DOCUMENTATION:** DCA Study Guide v1.5, Domain 3 "Installation and
  Configuration" covers: sizing requirements; repo setup, storage-driver
  selection and engine installation; logging drivers; swarm setup, managers,
  nodes, backup schedule; user and team management; daemon start-on-boot;
  certificate-based client-server authentication; a description of namespaces,
  cgroups and certificate configuration; troubleshooting installation errors;
  UCP/DTR deployment and backup.
- **CONFLICT:** `--memory`, `--cpus`, and `--pids-limit` appear in **no DCA
  domain at all**. The lab claimed exam relevance it does not have.
- **RECOMMENDED CORRECTION:** reclassify as a production skill —
  `relevant: false`. **Applied in this pass.**

**CONFLICT 2 — DOCKER-001 claims two domains, neither of which fits**

- **EXISTING LAB:** DOCKER-001, Run Your First Container
- **CURRENT BEHAVIOR:** `domains: [image-creation-and-registry, orchestration]`
- **OFFICIAL DOCUMENTATION:** Domain 1 "Orchestration" is entirely swarm and
  Kubernetes. Domain 2 is Dockerfiles, image CLI management, and registries.
- **CONFLICT:** `docker run --name` is neither. Claiming `orchestration` for a
  single-container lab is the most misleading mapping in the track.
- **RECOMMENDED CORRECTION:** `relevant: false`, or map narrowly to Domain 1's
  "Describe the difference between running a container and running a service" —
  which this lab only half touches. **Not applied — outside this pass's one-lab
  scope.**

**CONFLICT 3 — the domain slugs are invented**

- **CURRENT BEHAVIOR:** all ten labs use kebab-case slugs such as
  `image-creation-and-registry`, `orchestration`, `installation-and-configuration`.
- **OFFICIAL DOCUMENTATION:** the official names are "Image Creation, Management,
  and Registry", "Orchestration", "Installation and Configuration", "Networking",
  "Security", "Storage and Volumes".
- **CONFLICT:** the slugs are close enough to look authoritative and are not.
  The schema comment already says domains are "deliberately free-form strings",
  so nothing breaks — but nothing verifies them either.
- **RECOMMENDED CORRECTION:** adopt the official domain names verbatim, plus an
  `objective_version` field (see §6.7). **Not applied — shared schema change.**

**No conflict found in the technical content of any lab.** Every Docker
behaviour the labs assert was checked against docs.docker.com and holds.

## 6.3 Objectives confirmed from official sources

Confirmed verbatim from the study guide and used for the mapping below: all six
domain names, their weightings, and their full sub-objective lists. Confirmed
from docs.docker.com for the lab implemented in this pass:

- `--memory` accepts `b`/`k`/`m`/`g`; **"the minimum allowed value is `6m`"** —
  which is why DOCKER-009 uses `16m` and not a smaller figure.
- **"By default, if an out-of-memory (OOM) error occurs, the kernel kills
  processes in a container."**
- `--pids-limit`: "Tune container pids limit (set -1 for unlimited)" — documented
  on the `docker run` reference, **not** on the resource-constraints page; the
  lab's hint says so.

## 6.4 Labs that DO map to current DCA objectives

| Lab | Domain | Official objective (verbatim) |
|---|---|---|
| DOCKER-003 | 2 | "Describe and demonstrate how to tag an image"; "…inspect images and report specific attributes using filter and format" |
| DOCKER-004 | 2 | "Describe the use of Dockerfile"; "Identify and display the main parts of a Dockerfile" |
| DOCKER-013 | 2, 6 | "…create an efficient image via a Dockerfile"; "…display layers of a Docker image" |
| DOCKER-014 | 2 | "Describe options, such as add, copy, volumes, expose, entrypoint" |
| DOCKER-017 | 2 | "…create an efficient image via a Dockerfile"; "…modify an image to a single layer" |
| DOCKER-021 | 2 | "Describe and demonstrate registry functions. Deploy a registry. Log into a registry. Utilize search in a registry. Push an image to a registry. Pull and delete images from a registry." |
| DOCKER-012 | 4 | "…publish a port so that an application is accessible externally"; "Identify which IP and port a container is externally accessible on" |
| DOCKER-006 | 4 | "…create a Docker bridge network for developers to use for their containers"; "Describe the different types and use cases for the built-in network drivers" |
| DOCKER-023 | 4 | "…troubleshoot container and engine logs to resolve connectivity issues between containers" |
| DOCKER-022 | 3 | "Describe and demonstrate configuration of logging drivers (splunk, journald, etc.)" |
| DOCKER-005 | 6 | "Describe the use of volumes are used with Docker for persistent storage" |
| DOCKER-024 | 6 | same, plus "Identify the steps to take to clean up unused images on a filesystem" |
| DOCKER-011 | 1 | "Interpret the output of `docker inspect` commands" |

## 6.5 Labs that are production skills but NOT exam objectives

Valuable, and honestly labelled as production skills rather than exam coverage:

DOCKER-001, DOCKER-002, DOCKER-007 (environment variables), **DOCKER-009
(resource limits)**, DOCKER-010, DOCKER-015 (bind mounts), DOCKER-016 (DNS and
segmentation — DCA's only DNS objective is "configure Docker to use external
DNS", which is daemon-level and different), DOCKER-019 (health checks),
**DOCKER-020 (non-root, read-only, capabilities — none of which appears in
Domain 5)**, DOCKER-025, DOCKER-026, DOCKER-027, and **DOCKER-008 / Compose**
(DCA references Compose only as input to `docker stack deploy` under swarm).

That DCA's Security domain contains **no objective about running as non-root, a
read-only root filesystem, or dropping capabilities** — while covering UCP client
bundles and LDAP integration — is itself the argument for keeping DOCKER-020 and
labelling it accurately. The exam is a 2019-era enterprise-product exam; the
production skill is current.

## 6.6 Missing official objectives — the real coverage gaps

| Gap | Domain | Weight at stake |
|---|---|---|
| **Swarm entirely** — services, stacks, quorum, replicated/global, node labels, templates | 1 | **25%** |
| Kubernetes-in-DCA (pods, ConfigMaps, ClusterIP/NodePort, PV, CSI) | 1, 4, 6 | part of 25/15/10% |
| Image signing / Docker Content Trust / security scanning | 2, 5 | part of 20/15% |
| `docker image prune` / `rmi` / `--filter` / `--format` | 2 | part of 20% |
| Storage drivers, graph drivers, devicemapper, layer location on disk | 3, 6 | part of 15/10% |
| Daemon configuration, start-on-boot, TLS client-server auth, namespaces/cgroups | 3 | part of 15% |
| host vs ingress publishing modes; overlay networks; L7 load balancing | 4 | part of 15% |
| UCP / DTR (all) | 1, 3, 5 | **not labbable on CE** |

**Honest conclusion: the Docker track cannot claim DCA exam preparation.** With
the full 25-lab plan built, roughly half of Domains 2, 4 and 6 would be covered
and Domains 1, 3 and 5 would be largely untouched.

## 6.7 Recommended curriculum corrections

1. **Reposition the track** as *"Production Container Engineering"* — a DevOps
   skills track with a documented partial DCA mapping — instead of implying exam
   coverage. Nothing in the 25-lab plan changes; only the claim does.
2. **Correct the `certification:` block on all ten existing labs** (only
   DOCKER-009 corrected in this pass). DOCKER-001's `orchestration` claim is the
   most urgent.
3. **Use the official domain names verbatim** instead of invented slugs.
4. **If DCA coverage is genuinely wanted**, it needs a Swarm mini-track
   (services, stacks, overlay, quorum, node labels) plus Content Trust and
   daemon/storage-driver labs — roughly 8–10 further labs, on top of the 25.
   That is a product decision, not a curriculum one.
5. **Keep the freshness rule:** the guide is v1.5 / January 2025 and targets
   Docker EE. Re-check before any release that claims certification alignment.

## 6.8 Schema extension — is it useful?

**Yes, and it is a small, additive, shared change.** Today `certification:` is
`{ certification, relevant, domains[] }` with free-form domain strings and no
provenance. The policy's metadata needs three more fields:

```yaml
certification:
  - certification: DCA
    relevant: false
    domains: []
    objective_version: "Study Guide v1.5, January 2025"   # NEW
    objective_source: https://training.mirantis.com/...   # NEW
    last_verified: 2026-08-23                             # NEW
```

Plus a top-level `sources:` list with a `type: official_documentation` tag,
which `references:` already approximates.

**Not implemented** — it touches `lab-definition.ts`, which is shared, and would
require re-authoring all 40+ labs across five tracks to populate it. Recommended
as its own change, owned by whoever owns the schema.

**Worth noting: the platform already enforces the policy's hardest rule in
code.** `DISALLOWED_DOC_HOSTS` in `services/lab-orchestrator/src/lab-definition.ts`
rejects `kodekloud.com`, `udemy.com`, `acloudguru.com`, `pluralsight.com`,
`linuxacademy.com`, `whizlabs.com`, and `examtopics.com` at lab-load time, and
`OFFICIAL_DOC_HOSTS` requires at least one official link per track. The policy
is already partly executable rather than merely documented.

## 6.9 Proposed certification coverage matrix

Coverage: NOT COVERED · INTRODUCED · PRACTICED · ADVANCED · ASSESSMENT.
Source for every row: DCA Study Guide v1.5 (Jan 2025). Verified 2026-08-23.

| Official objective | Domain | Labs | Difficulty | Coverage |
|---|---|---|---|---|
| Describe the use of Dockerfile | 2 (20%) | 004, 014 | int | **PRACTICED** |
| Create an efficient image via a Dockerfile | 2 | 013, 017 | int→adv | **ADVANCED** |
| Display layers of a Docker image | 2, 6 | 013, 017 | int→adv | **PRACTICED** |
| Modify an image to a single layer | 2 | 017 | adv | INTRODUCED |
| CLI image management (list, delete, prune, rmi) | 2 | — | — | **NOT COVERED** |
| Inspect images with filter and format | 2 | 003 | beg | INTRODUCED |
| Tag an image | 2 | 003, 021 | beg→adv | **PRACTICED** |
| Registry functions (deploy, login, search, push, pull, delete) | 2 | 021 | adv | **PRACTICED** |
| Sign an image in a registry / Content Trust | 2, 5 | — | — | **NOT COVERED** |
| Interpret `docker inspect` output | 1 | 011, and throughout | beg | **PRACTICED** |
| Swarm cluster setup, services, stacks, quorum, placement | 1 (25%) | — | — | **NOT COVERED** |
| Kubernetes pods / deployments / ConfigMaps from Docker | 1 | *(k8s track)* | — | NOT COVERED *(this track)* |
| Built-in network drivers and their use cases | 4 (15%) | 006, 016 | int→adv | **PRACTICED** |
| Create a bridge network for developers | 4 | 006 | int | **PRACTICED** |
| Publish a port for external access | 4 | 012, 010 | int | **PRACTICED** |
| Identify which IP and port a container is reachable on | 4 | 012 | int | INTRODUCED |
| host vs ingress publishing modes | 4 | — | — | **NOT COVERED** |
| Configure Docker to use external DNS | 4 | — | — | **NOT COVERED** |
| Overlay networks / L7 load balancing (EE) | 4 | — | — | **NOT COVERED** |
| Troubleshoot container/engine logs for connectivity | 4 | 023, 027 | adv | **ASSESSMENT** |
| Container Network Model and IPAM drivers | 4 | 016 | adv | INTRODUCED |
| Configure logging drivers | 3 (15%) | 022 | adv | **PRACTICED** |
| Storage-driver selection / engine install / repo setup | 3 | — | — | **NOT COVERED** |
| Daemon start-on-boot, TLS client-server auth | 3 | — | — | **NOT COVERED** |
| Namespaces, cgroups, certificate configuration | 3 | 009, 020 *(partial, cgroups only)* | int→adv | INTRODUCED |
| UCP / DTR install, HA, backups, RBAC, LDAP, client bundles | 1, 3, 5 | — | — | **NOT COVERED** (not labbable on CE) |
| Default engine security; MTLS; identity roles | 5 (15%) | — | — | **NOT COVERED** |
| Image passes a security scan | 5 | — | — | **NOT COVERED** |
| Volumes for persistent storage | 6 (10%) | 005, 024 | int→adv | **ADVANCED** |
| Application composed of layers, where layers reside | 6 | 013 | int | INTRODUCED |
| Clean up unused images on a filesystem | 6 | 024 *(partial)* | adv | INTRODUCED |
| Object vs block storage; graph drivers; devicemapper | 6 | — | — | **NOT COVERED** |
| Storage across cluster nodes; Kubernetes PV / CSI | 6 | *(k8s track)* | — | NOT COVERED *(this track)* |

**Rollup by domain, with the full 25-lab plan built:**
Domain 1 (25%) ≈ 5% covered · Domain 2 (20%) ≈ 70% · Domain 3 (15%) ≈ 20% ·
Domain 4 (15%) ≈ 55% · Domain 5 (15%) ≈ 0% · Domain 6 (10%) ≈ 45%.
**Weighted total ≈ 35% of the current DCA exam.**
