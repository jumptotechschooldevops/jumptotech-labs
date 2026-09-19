# Production-host readiness — the first private-beta deployment

| | |
|---|---|
| **Branch** | `feat/production-host-readiness`, rebased onto `origin/main` at `c00ec48` (PR #34, PR #35, PR #36 — the security audit — and PR #37 — browser E2E — merged); pull request #38 |
| **Date** | 2026-09-16 |
| **Audience** | the operator who deploys JumpToTech Labs on its first real host, for about five trusted students |
| **Production host deployed?** | **No.** Nothing in this document ran on a production host. No host, DNS record, public certificate, identity provider, firewall or backup destination exists. |

> **Read this first.** Every status says where its evidence came from.
> `PROVEN IN CI` and `PROVEN LOCALLY` are software evidence from a GitHub runner
> or a development machine. They are **never** evidence that a production host
> works. The checklist in §23 is what must be true on the host before any student
> gets access, and none of it is done.

| Status | Meaning |
|---|---|
| **PROVEN IN CI** | a GitHub Actions job passed on an ephemeral `ubuntu-latest` runner |
| **PROVEN LOCALLY** | a repository command passed on a development machine (macOS, Docker Desktop) or in a local Linux container |
| **PROCEDURE READY** | the command, script or step exists and is tested against fakes; it has not run where it matters |
| **REQUIRES PRODUCTION HOST** | can only be proven on the real host |
| **REQUIRES EXTERNAL DECISION** | blocked on a choice or configuration outside this repository |
| **NOT PROVEN** | no evidence of any kind |

---

## 1. Executive summary

The software release gate passed (BETA-P0-020), and PR #34 re-ran the gates it
could on the current tree and added unattended restart for production (release
gate §11). **The platform has never run on a production host.**

This branch makes the first deployment a procedure with evidence:

- **A Linux-host defect, fixed** (§18.1). `make observability-token` wrote the
  scrape token `0600`; Prometheus runs as uid 65534 and could not have read it on
  a Linux host. Docker Desktop hides this.
- **`make production-config-check`** renders the five production files with the
  operator's `.env`, checks them against a host contract (which also requires
  PR #34's `restart: unless-stopped`), and runs the **real** api, terminal and
  sandboxd configuration loaders on what Compose resolved.
- **`make production-preflight`** — host checks before the first start, fail-closed.
- **`make private-beta-smoke`** — read-only checks of the running stack, each
  labelled with the kind of proof it is.
- **`scripts/host-capacity-sample.sh`** — measures host usage; never judges it.
- The deployment, capacity, alert, recovery and rollback procedures, and the
  evidence template.

**Verdict: the tooling is ready for review; a production host is NOT ready for
students.** §23 lists what remains; most of it is external decisions and a real host.

## 2. Current production architecture

One Linux host runs everything (`docker-compose*.yml`,
[runtime-architecture.md](../runtime-architecture.md)):

```
Internet ─443─► web (nginx, TLS gate) ─┬─► api :4000 ──► postgres :5432   (internal "database" network)
         ─80──► redirect + ACME         │      │  └────► kind API server  (external "kind" network)
                                        │      └───────► sandboxd :4002   (holds the only Docker socket)
                                        └─► terminal :4001 ─► sandboxd (attach), kind (per-session kubeconfig)
                                                             └► session sandboxes ("jumptotech-sandboxes" network)
127.0.0.1:3001 ─► Grafana (in Prometheus's netns) ◄── Prometheus :9090, Alertmanager :9093 (loopback in that netns)
kind node container "jumptotech-labs-control-plane" — a whole Kubernetes node, privileged, on the same host
Per-session sandboxes — created by sandboxd; Docker-track sandboxes run --privileged (docker:27-dind)
```

Every production service is `restart: unless-stopped` (PR #34). The production
command is the runbook's `prod` function
([private-beta-operations.md §1](../runbooks/private-beta-operations.md)).

The only Kubernetes substrate the repository implements and proves is kind on the
same host. [kubernetes-network-security.md §8](../kubernetes-network-security.md)
calls kind development infrastructure; choosing it for the first host is decision
D2, not a default.

## 3. What is proven, and where

| Claim | Status | Evidence |
|---|---|---|
| Five students: capacity 5/1 refusals, isolation, reset, soak, api restart, cleanup | PROVEN LOCALLY at `c8eb2c6` only | `make beta-validate`, release gate §4; **not re-run since** (§11.2) |
| Unit/contract suites, typecheck, build | PROVEN IN CI at `c8eb2c6`, on PR #35 (base `0f33b1f`) and on PR #38 at `5d486ef` (base `fa6f109`); PROVEN LOCALLY on this branch at base `c00ec48` (§20) | `npm test`, `npm run typecheck`, `npm run build` |
| Lab catalog validation (PR #35) still passes with this branch's changes | PROVEN IN CI on PR #35 without them; PROVEN LOCALLY with them (§20) | `npm run validate:labs` |
| Production renders with 443/80 public, loopback Grafana, postgres internal, per-service secrets | PROVEN IN CI + PROVEN LOCALLY | `check-secret-distribution.mjs`, `compose-secret-distribution.test.ts` |
| `restart: unless-stopped` on every production service; `ServiceRestartLoop` | PROVEN IN CI (PR #35's `gates` job ran them on a tree containing PR #34) and PROVEN LOCALLY; on a host: REQUIRES PRODUCTION HOST | `private-beta-operations.test.ts`, `service-restart-alerts.test.yml` |
| TLS edge fails closed, redirect, WebSocket over TLS, renewal | PROVEN IN CI with test-only certificates | `make test-tls-edge` |
| Backup → destroy → restore → identical fingerprint | PROVEN IN CI | `make db-restore-drill` |
| NetworkPolicy enforcement, negative controls | PROVEN IN CI on kind, one node | `kind-integration` |
| Rules, alerts, Alertmanager config, dashboards | PROVEN IN CI | `scripts/check-observability.sh`, promtool tests |
| Production config gates fail closed against the real files and loaders (20 scenarios) | PROVEN IN CI (`gates` on PR #38 at `5d486ef`, base `fa6f109`) and PROVEN LOCALLY at base `c00ec48` | `npm run production:config-check -- --self-test` |
| Preflight, smoke and sampler decisions; no secret printed; only read-only docker/kubectl verbs; a hung daemon ends as a FAIL | PROVEN LOCALLY on macOS bash 3.2 and in a Linux container (bash 5.2, GNU coreutils) | `bash scripts/test-production-host-scripts.sh` |
| Scrape token readable by Prometheus under Linux ownership | PROVEN LOCALLY with the real image | §18.1 |

## 4. What is not proven

| Item | Status |
|---|---|
| Anything on a production host | REQUIRES PRODUCTION HOST |
| `make beta-validate` on the current tree | NOT PROVEN |
| Host sizing for five students | NOT PROVEN (§13) |
| Public DNS, a real CA certificate, scheduled renewal | REQUIRES EXTERNAL DECISION |
| Sign-in through a real identity provider | REQUIRES EXTERNAL DECISION |
| Admission restricted to the beta students | REQUIRES EXTERNAL DECISION (§8) |
| Off-host encrypted backup and a restore from it | REQUIRES EXTERNAL DECISION |
| An alert delivered to a person | REQUIRES EXTERNAL DECISION |
| Provider firewall admitting only 80/443/SSH | REQUIRES PRODUCTION HOST |
| Unattended recovery after a Docker restart or reboot | NOT PROVEN on a host (the policy exists; the kind node's behaviour is unmeasured) |
| NetworkPolicy enforcement on the host's substrate | REQUIRES PRODUCTION HOST (probe must PASS there) |
| The new CI steps on GitHub after the rebase onto `c00ec48` | NOT PROVEN until PR #38's CI runs again (they passed in `gates` at `5d486ef`, base `fa6f109`) |

## 5. Host prerequisites

### 5.1 Required (repository evidence cited)

| Requirement | Value | Evidence |
|---|---|---|
| OS | Linux | Linux images; kind and `--privileged` DinD need a Linux kernel |
| Architecture | amd64 proven in CI; arm64 builds, not CI-proven | `api.Dockerfile`/`sandboxd.Dockerfile` map amd64/arm64; CI is `ubuntu-latest` |
| Docker Engine | rootful; socket at exactly `/var/run/docker.sock` | `docker-compose.runtime.yml` mounts that path into sandboxd |
| `DOCKER_SOCKET_GID` | the socket's group id | default `0` works only on Docker Desktop (compose comment) |
| Docker Compose | v2 with `!reset`/`!override` | used by the production overlays; proven by rendering (`production-config-check`) |
| kind / kubectl | v0.31.0 / v1.34.2; node image `kindest/node:v1.34.0` | CI pins; `infrastructure/kind/cluster.yaml` |
| Node.js | 22 + `npm ci` | `.nvmrc`; host tooling is Node |
| Tools | git, openssl, curl, iproute2 (`ss`), coreutils `timeout` | `make secrets`, smoke, preflight |
| Registry and download access at build and first start | Docker Hub, `registry.npmjs.org`, `download.docker.com`, `dl.k8s.io` | Dockerfiles; lab images pulled on first start |
| Checkout readable by container users | files other-readable, directories other-executable | uids 1000 (api, sandboxd), 65534 (Prometheus, Alertmanager), 472 (Grafana), 101 (nginx) read bind mounts |
| Clock | NTP-synchronized | OIDC allows 5 s skew; certificates and the attestation are time-bound |
| Ports | 80 and 443 free | the production publication |

### 5.2 Recommended

| Recommendation | Why |
|---|---|
| A dedicated host with no local accounts but operators | kind kubeconfigs (cluster-admin) and the scrape token are `0644` by necessity; `docker` membership is root-equivalent |
| Checkout directory `0750`, owned by the operator | keeps other local accounts away from those files; containers are unaffected |
| `BACKUP_DIR` on a different disk from Docker's data | [postgres-backup-restore.md §5.5](../runbooks/postgres-backup-restore.md) |
| Pre-pull `docker:27-dind` | the first Docker-track start otherwise depends on Docker Hub |

### 5.3 UNKNOWN — MEASURE ON HOST

| Item | Known | How to close |
|---|---|---|
| CPU | nothing about a server | §13 |
| Memory | laptop only: ~0.7 GiB idle platform + ~0.7 GiB kind node; DOCKER-001 may use up to `DOCKER_SANDBOX_MEMORY=2g` | §13 |
| Disk | nothing sized: images, kind node, DinD stores, 15 d Prometheus, PostgreSQL, on-host backups | §13 |
| Kernel (`fs.inotify.*`) | no value set or proven | preflight records it as INFO |
| cgroup version, IPv6, rootless Docker | not constrained or not proven | preflight records/warns |

The preflight judges memory and disk **only** against the repository's alert
thresholds (memory < 10 % / 5 % available, disk < 15 % / 8 % free). Those are
pressure alarms, not sizing: a host that passes them may still be too small.

### 5.4 Filesystem layout

| Path | Owner / mode | Holds |
|---|---|---|
| `/srv/jumptotech-labs` | `jtt-ops`, `0750` | checkout, `.env` (`0600`), TLS key (`0600`), scrape token (`0644` in `0711`), kind kubeconfigs |
| `/srv/jumptotech/backups/postgres` | `jtt-ops`, `0700` | `BACKUP_DIR` |
| `/srv/jumptotech/backups/status` | `jtt-ops`, `0755` | `BACKUP_STATUS_DIR`, read-only in the api; must not overlap `BACKUP_DIR` |
| `/var/log/jumptotech` | `jtt-ops` | cron logs |
| `/srv/jumptotech/evidence` | `jtt-ops`, `0700` | preflight, smoke, capacity and probe outputs; the filled template. Never a secret |
| Docker data root | root | named volumes `jumptotech-labs-{postgres,prometheus,grafana,alertmanager}-data`, images, kind node |

## 6. Production configuration contract

`make production-config-check` is its executable form
(`test-support/production-host-contract.ts`).

| Check | Contract |
|---|---|
| `compose.services` | exactly alertmanager, api, grafana, postgres, prometheus, sandboxd, terminal, web |
| `exposure.published-ports` | only `443→web:8443`, `80→web:8080`, `127.0.0.1:*→grafana:3000` |
| `exposure.database` | postgres unpublished; `database` network internal, members api and postgres only |
| `exposure.observability` | Prometheus/Alertmanager on `127.0.0.1` in one namespace; no lifecycle API; Grafana anonymous and basic auth off |
| `privilege.docker-socket` | only sandboxd mounts the socket |
| `privilege.containers` | no compose service privileged, host-networked, or given capabilities (except the terminal's SETUID/SETGID drop) |
| `runtime.docker-socket-gid` | sandboxd joins the socket's group |
| `gates.node-env` | `NODE_ENV=production` pinned for api, terminal, sandboxd |
| `gates.authentication` | `AUTH_MODE=oidc` pinned; development student header off |
| `gates.tls-edge` | `WEB_TLS=required` pinned; `PUBLIC_ORIGIN` a bare https origin whose host the edge's certificate gate accepts (lower-case DNS name: no IP address, no port, not a single label such as `localhost` — the api accepts all three, the edge exits on them), identical for api and web; served-certificate health check |
| `gates.origins` | WARN when `ALLOWED_ORIGINS` trusts any origin besides `PUBLIC_ORIGIN` (each one can read signed-in responses, pass the CSRF guard and open terminal WebSockets), or when `AUTH_COOKIE_DOMAIN` widens the session cookie beyond this host |
| `gates.network-policy` | NetworkPolicy and its attestation not waived |
| `capacity.beta-contract` | `MAX_ACTIVE_SESSIONS=5`, `MAX_ACTIVE_SESSIONS_PER_STUDENT=1` (compose default is 20) |
| `capacity.shell-ceilings` | `TERMINAL_MAX_SESSIONS` and `SANDBOXD_MAX_SESSIONS` at least `MAX_ACTIVE_SESSIONS`: below it the api admits a lab whose shell is then refused. (The shipped defaults disagree — 20 labs, 16 terminal shells — which is one more reason the capacity default is refused) |
| `capacity.launches` | WARN when `LAB_LAUNCHES_PAUSED` is on: the stack would start refusing every Start Lab |
| `durability.volumes` | named volumes for postgres, prometheus, alertmanager, grafana |
| `durability.healthchecks` | postgres, api, terminal, web |
| `durability.restart-policy` | every service exactly `restart: unless-stopped` (PR #34); `always` is a FAIL because it would undo `prod stop web` |
| `backup.status-dir` | absolute host directory, read-only in the api; WARN on the in-checkout default |
| `loader.api/terminal/sandboxd` | the real loaders accept the resolved environment (secrets present, strong, distinct; https OIDC; Secure cookie; https CORS including the origin; broker/database transport; runtime owner) |
| `attestation.expected-digest` | INFO: the NetworkPolicy contract digest the api will demand |

`.env` must set, beyond `make secrets`: `PUBLIC_ORIGIN`, `ALLOWED_ORIGINS`,
`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_AUDIENCE`,
`RUNTIME_OWNER_ID`, `MAX_ACTIVE_SESSIONS=5`, `MAX_ACTIVE_SESSIONS_PER_STUDENT=1`,
`BACKUP_STATUS_DIR`, `DOCKER_SOCKET_GID`, `JTT_COMMIT`, `JTT_VERSION`. A shell
export overrides `.env` for Compose; the preflight warns about each one.

## 7. Network exposure contract

Repository configuration decides what Docker publishes. **It cannot prove what
the host's provider firewall or security group admits.**

### 7.1 Required host ingress

| Port | From | Purpose |
|---|---|---|
| TCP 443 | wherever students are | the application (TLS) |
| TCP 80 | anywhere (required by ACME HTTP-01, if chosen) | redirect to https; ACME challenge |
| TCP 22 (or the operator's SSH port) | operator addresses only | administration; Grafana through `ssh -L 3001:127.0.0.1:3001` |
| everything else | nowhere | — |

Egress: registries and downloads at build and first start (§5.1), the identity
provider (discovery, JWKS, token endpoint), NTP, the ACME CA if chosen, and the
backup and alert destinations once chosen.

### 7.2 Evidence by layer

| Layer | Contract | Status |
|---|---|---|
| Compose publications | 443, 80, `127.0.0.1:3001` only; postgres, api, terminal, sandboxd, metrics, Prometheus, Alertmanager unpublished | PROVEN IN CI (rendered config); smoke `exposure.published` REQUIRES PRODUCTION HOST |
| nginx routing | `/internal`, `/metrics`, `/health`, `/readyz` not routed | PROVEN IN CI (config); smoke REQUIRES PRODUCTION HOST |
| kind API server | `127.0.0.1:16443` | PROVEN IN CI (kind) |
| Host firewall | Docker-published ports bypass ufw/firewalld `INPUT`; filter in the provider firewall or `DOCKER-USER` | REQUIRES PRODUCTION HOST — scan from another network |
| Pod → node-local destinations (kubelet 10250, instance metadata) | not governed by NetworkPolicy | REQUIRES EXTERNAL DECISION (P0-015 D3) |

## 8. Authentication and identity contract

What holds (PROVEN IN CI; [authentication.md §4](../authentication.md)): production
pins OIDC; development auth and the development header are refused at config load
and per request; https issuer, confidential client, exact callback, Secure cookie,
CSRF origin guard, PKCE/state/nonce, durable sessions. The self-test shows these
refusals survive the real compose merge.

**Sign-in admission — REQUIRES EXTERNAL DECISION. Not fixed.**

- *What the code does:* after verifying the ID token, the api upserts the user and
  provisions them as `STUDENT`. There is no allowlist, group/role claim check,
  email-domain rule or invitation table.
- *Classification:* it is the **current, documented product policy**
  (authentication.md §4.7, "WHO MAY SIGN IN — DECISION REQUIRED"), which means
  **application-level admission is missing**. For the private beta, restricting
  sign-in is therefore an **operational requirement that today can only be met in
  the identity provider's configuration**.
- *Why it matters:* with a public identity provider, anyone who can authenticate
  there could start a lab, including a privileged Docker-in-Docker sandbox, and
  take one of the five slots.
- *What must be configured before inviting the students* (provider-specific; no
  provider is chosen here):
  1. a dedicated OIDC client for this deployment;
  2. the provider configured so that **only** the five beta accounts can obtain a
     token for that client (for example: user or application assignment required,
     a dedicated tenant or realm containing only those users, or an invite-only
     directory);
  3. self-service sign-up disabled for that tenant or client;
  4. proven by signing in with an account that is *not* a beta student and being
     refused **at the provider** (smoke `auth.admission`, MANUAL).
- A platform-side restriction is a separate product change; this branch does not
  invent one.

Also open: federated logout and idle timeout (authentication.md §4.7, D13).

## 9. TLS contract

| Claim | Status |
|---|---|
| Web container refuses to start without a valid certificate/key for `PUBLIC_ORIGIN`, with a group/other-readable key, an expired or mismatched certificate, or a missing chain; TLS 1.2/1.3 AEAD; HSTS; `421` on SNI/Host mismatch; port 80 only redirects and serves ACME; hot renewal keeps WebSockets | PROVEN BY REPOSITORY TEST (CI `tls-edge-integration`, test-only CA) |
| `WEB_TLS` cannot be turned off from `.env` | PROVEN LOCALLY (self-test) |
| Preflight: files present, key mode, `tls:check --offline` against `PUBLIC_ORIGIN` | PROCEDURE READY |
| The edge serves the installed certificate to a request for the public name made from the host | REQUIRES REAL HOST (smoke `edge.*`) |
| The name resolves publicly to the host; a public CA chain browsers trust; reachable from outside; renewal on a schedule | REQUIRES DNS/CA — REQUIRES EXTERNAL DECISION (D4, D5) |

No public certificate validity is claimed anywhere in this repository.

## 10. Database contract

| Claim | Status |
|---|---|
| PostgreSQL 16 in named volume `jumptotech-labs-postgres-data`, health-checked, internal network, `restart: unless-stopped` | PROVEN IN CI (rendered config); config-check `durability.*` |
| `prod down` keeps the volume; this branch never runs `down -v`, never removes a volume and never edits data | PROVEN LOCALLY (the script tests assert read-only verbs) |
| Forward-only migrations at api start; take a `pre-migration` backup before an image with a new migration | documented, [postgres-backup-restore.md §5.2](../runbooks/postgres-backup-restore.md) |
| A placeholder or short database password is refused | PROVEN LOCALLY (self-test) |
| The volume on the host's disk, and its growth | REQUIRES PRODUCTION HOST |

## 11. Backup and restore contract

| Aspect | Status |
|---|---|
| `scripts/db-backup.sh`: custom-format archive, checksum, read-back, retention 14 d / min 7 | PROVEN IN CI |
| `db-restore.sh --verify-only` / `--into` (beside production) / `--replace` (renames, never drops) and their refusals | PROVEN IN CI |
| No destructive default: no `db-restore` make target; a restore requires an explicit mode and confirmation | PROVEN IN CI (`test-db-backup-restore.sh`) |
| Schedule (cron in [private-beta-operations.md §1.2](../runbooks/private-beta-operations.md)) | PROCEDURE READY; REQUIRES PRODUCTION HOST |
| Freshness/verification alerts via `BACKUP_STATUS_DIR` | PROVEN IN CI (rules); REQUIRES PRODUCTION HOST |
| **Off-host destination** (`BACKUP_COPY_HOOK` is only a seam) | **REQUIRES EXTERNAL DECISION** |
| **Encryption** (archives are not encrypted) | **REQUIRES EXTERNAL DECISION** |
| Off-host retention, credentials, who may restore, `.env`/TLS-key recovery | REQUIRES EXTERNAL DECISION |
| A restore from an off-host copy onto a fresh host | NOT PROVEN |

No provider is chosen here. The smoke's `backup.offhost` is a FAIL until
`jtt_backup_last_success_offhost` reads 1.

## 12. Observability contract

| Layer | Status |
|---|---|
| **Prometheus config** — scrape jobs using `credentials_file`, loopback listener, no lifecycle API, 15 d retention | PROVEN IN CI (promtool check config; compose contract) |
| **Alert rules** — including PR #34's `ServiceRestartLoop` (`changes(up[15m]) >= 6`) and the BETA-P0-018 set | PROVEN IN CI (promtool unit tests, including `service-restart-alerts.test.yml`) |
| **Alertmanager config** — one `default` webhook receiver read from `secrets/webhook-url`; inhibit rules | PROVEN IN CI (amtool check-config) |
| Monitoring private (loopback, one namespace, no socket, no student/cluster/database network) | PROVEN IN CI (config) |
| Scrape token readable by Prometheus on Linux | PROVEN LOCALLY (§18.1); REQUIRES PRODUCTION HOST (smoke `observability.targets`) |
| Targets up; dashboard renders through the tunnel; host gauges on the right filesystems | REQUIRES PRODUCTION HOST |
| **Human delivery** — any destination configured, any alert received by a person | **NOT PROVEN / REQUIRES EXTERNAL DECISION** (D6) |

### 12.1 Alert delivery drill (after D6)

1. Install the destination (`infrastructure/observability/alertmanager/secrets/README.md`;
   file `0644`, directory `0711`), then `prod kill -s HUP alertmanager`.
2. `prod exec -T prometheus wget -qO- http://127.0.0.1:9090/api/v1/alertmanagers`
   lists `127.0.0.1:9093` as active.
3. Send a labelled drill alert that expires by itself (it exists only in Alertmanager):
   ```bash
   end=$(date -u -d '+10 minutes' +%Y-%m-%dT%H:%M:%SZ)
   prod exec -T alertmanager amtool alert add alertname=JttAlertDeliveryDrill severity=warning service=drill \
     --annotation=summary="Delivery drill - no action required" --end="$end" \
     --alertmanager.url=http://127.0.0.1:9093
   ```
4. A person confirms receipt (after `group_wait`, 30 s), and then the resolved notice.
5. `prod logs --since 15m alertmanager | grep -i notify` shows no delivery error.
6. Record the destination type (never the URL), the recipient, and sent/received times.

## 13. Five-student capacity validation

| | Status |
|---|---|
| Five concurrent synthetic students (harness) | PROVEN LOCALLY at `c8eb2c6` (laptop) |
| Measurement procedure and sampler | PROCEDURE READY |
| Measured on a production host | **NOT PROVEN** |
| Acceptance thresholds | **REQUIRES EXTERNAL DECISION** (D8) |

**Nothing here claims a host supports five students.** What to collect, and from where:

| Evidence | Source on the host |
|---|---|
| Five concurrent sessions admitted; 6th refused; per-student refusal | `make beta-validate` phases 1 and 4 (§13.1) |
| Session creation and sandbox startup latency per provider | harness `concurrentStart[].ms`; `histogram_quantile(0.95, sum by (le, provider) (rate(jtt_lab_provision_duration_seconds_bucket[30m])))` |
| Verification latency and results | harness `solveTimings`; `histogram_quantile(0.95, sum by (le, provider) (rate(jtt_verification_duration_seconds_bucket[30m])))` |
| Terminal connectivity | harness phase 2 (five PTYs, per-shell markers); echo latency is **not instrumented** — testers record it in §13.2 |
| CPU, memory, swap, disk | `host-capacity-sample.sh` → `host.csv` |
| Container, sandbox and Pod counts; per-container memory | `host.csv`, `containers.csv` |
| Session cleanup | harness after-End phase (active 0, nothing orphaned); `docker ps --filter label=jumptotech.io/managed=true` empty |
| Failure rate | `sum by (outcome) (increase(jtt_lab_start_outcome_total[1h]))`; alerts that fired |
| Service restarts | smoke `stack.*-restarts`; `ServiceRestartLoop` |

Existing alarms (operational, not SLOs) to note if they fire: `ApiLatencyHigh`
(p95 > 1 s), `VerificationSlow` (> 10 s), `ProvisioningSlow` (> 60 s),
`HostCpuSaturated`, `HostMemoryPressure`, `HostDiskSpaceLow`, `ServiceRestartLoop`.

### 13.1 A — synthetic gate on the host, before the first production start

The harness drives a loopback stack with development auth, so it cannot target the
production stack. It also must not run while the production stack is on the same
`kind` network, because the two stacks resolve each other's `api`/`terminal`.

1. Complete §15 steps 1–9. Do not start `prod`.
2. Make a second checkout at the **same commit** in `/srv/jumptotech-validation` and run `npm ci` there.
3. There, run `make secrets`, then set in **its** `.env`:
   ```
   COMPOSE_PROJECT_NAME=jtt-hostval
   RUNTIME_OWNER_ID=jtt-hostval
   DOCKER_SANDBOX_NETWORK=jtt-hostval-sandboxes
   LAB_CLUSTER_NAME=jumptotech-labs
   MAX_ACTIVE_SESSIONS=5
   MAX_ACTIVE_SESSIONS_PER_STUDENT=1
   AUTH_MODE=development
   DEV_STUDENT_HEADER_ENABLED=true
   NETWORK_POLICY_ATTESTATION_REQUIRED=true
   ```
   and follow [five-student-beta-validation.md §1](../runbooks/five-student-beta-validation.md) steps 1–5 there.
4. From the production checkout, in a second shell:
   `make host-capacity-sample ARGS="--out-dir /srv/jumptotech/evidence/capacity-synthetic --interval 15 --duration 2400 --kubeconfig infrastructure/kind/generated/kubeconfig-host-jumptotech-labs.yaml"`
5. From the validation checkout: `make beta-validate ARGS="--report-dir /srv/jumptotech/evidence/beta-validate"`.
6. Stop the sampler with Ctrl-C; keep both CSVs and the report.
7. Stop the validation stack **without** removing volumes: from its checkout,
   `docker compose -f docker-compose.yml -f docker-compose.runtime.yml -f docker-compose.observability.yml -f docker-compose.production-observability.yml --profile observability down`.
   List `docker volume ls --filter name=jtt-hostval`; remove only those synthetic
   volumes, by exact name, after reading the list.
8. The run rewrote the cluster attestation for its own environment. §15 step 12
   must write the production one, and preflight `k8s.attestation-digest` must PASS.

### 13.2 B — five-person rehearsal on the production stack

After §15 and a passing smoke, five operators or trusted testers with beta accounts:
start the sampler (`capacity-rehearsal`); press Start within one minute on
LINUX-001, DOCKER-001, K8S-001, ANSIBLE-001 and TF-001; work for 10 minutes,
including one heavy step each (`docker build`, `terraform apply`, a playbook),
noting any echo delay; Check Solution, Reset once, End Lab. Then record the PromQL
above, restart counts, alerts fired and the sampler peaks, and confirm active
sessions and managed containers return to zero.

## 14. Preflight procedure

```bash
cd /srv/jumptotech-labs
make production-preflight ARGS="--backup-dir /srv/jumptotech/backups/postgres --report /srv/jumptotech/evidence/preflight-$(date -u +%Y%m%dT%H%M%SZ).txt"
```

- Exit `0` means no FAIL; every `MANUAL CHECK REQUIRED` still needs a person. WARN
  means "allowed, but not the proven configuration"; FAIL means "do not start".
- Non-destructive and repeatable: it only reads (the test harness fails on any
  docker or kubectl verb that is not read-only); the only file it writes is `--report`.
- Bounded: docker/kubectl/kind calls time out after `JTT_COMMAND_TIMEOUT` (60 s)
  and `npx` after `JTT_TOOL_TIMEOUT` (300 s); a timeout is a FAIL.
- Secret-safe: `.env` is parsed as data, never sourced; secrets print as
  `NAME: present`/`MISSING`; the scrape token is compared by hash; the config check
  redacts loader and compose messages.
- Checks: OS/arch; memory and disk against alert thresholds (sizes INFO only);
  clock; tool versions against CI pins; Docker daemon, rootful, Compose, socket,
  group; git commit; checkout and bind-mount readability; `.env` mode, required
  names, shell overrides; TLS files, key mode, `tls:check --offline`; scrape token
  mode and match; alert destination file; kind cluster, network, kubeconfigs,
  the cluster-admin API server published on loopback only (FAIL on any other
  address), nodes, `seccompDefault`, admission policies; the attestation's
  verdict, cluster, age and digest against this `.env`; sandbox images; ports
  80/443; other public listeners; backup directories, overlap, filesystem,
  whether this account can write the status directory (a backup that cannot
  record its outcome still exits 0, and `BackupStale` fires), schedule;
  `make secrets-check`; `make production-config-check` (rendering, exposure,
  persistence, restart policy, capacity, OIDC/TLS gates, observability).

## 15. Deployment procedure

Stop at the first FAIL, with one named exception: the smoke's `backup.offhost`
stays FAIL (and so its `RESULT: FAIL`) until D7 is decided and step 23 proves an
off-host copy. Steps 18–22 continue past that one line; every other smoke line
must PASS, and no student is invited while it stands. Placeholders: `<host>`,
`<commit>`, `<public-ip>`.

1. **Host prerequisites** (§5.1). `sudo useradd -m jtt-ops && sudo usermod -aG docker jtt-ops`; log in as `jtt-ops`.
2. **Firewall** (§7.1), in the provider firewall or `DOCKER-USER`.
3. **Clone the release.**
   ```bash
   sudo install -d -m 0750 -o jtt-ops -g jtt-ops /srv/jumptotech-labs
   umask 022
   git clone https://github.com/jumptotechschooldevops/jumptotech-labs.git /srv/jumptotech-labs
   cd /srv/jumptotech-labs && git checkout <commit> && git rev-parse HEAD && npm ci
   ```
4. **Layout.**
   ```bash
   sudo install -d -m 0700 -o jtt-ops -g jtt-ops /srv/jumptotech/backups/postgres /srv/jumptotech/evidence
   sudo install -d -m 0755 -o jtt-ops -g jtt-ops /srv/jumptotech/backups/status /var/log/jumptotech
   ```
5. **Environment.** Run `make secrets`: it creates `.env` with mode `0600`, generates
   the platform secrets and prints none of them. Edit `.env` in an editor to set the
   §6 list, including `DOCKER_SOCKET_GID` = the output of `stat -c %g /var/run/docker.sock`.
   Keep a `0600` copy as `.env.previous` before later edits.
6. **Identity provider** (D1, D3). Register the client with redirect
   `https://<host>/auth/callback`, **restrict it to the beta accounts** (§8), and set the
   `OIDC_*` values.
7. **Kubernetes.** `npm run cluster:up`; it must report `seccompDefault is on`.
8. **Images.** `make sandbox-build`; `docker pull docker:27-dind`.
9. **TLS** (D4, D5). Create the DNS `A` record; confirm from outside with `dig +short <host>`;
   obtain the first certificate ([production-tls.md §3](../runbooks/production-tls.md));
   `make tls-install CERT=… KEY=…`.
10. **Monitoring files.** `make observability-token`; install the alert destination if D6 is decided.
11. **Backups.** The directories exist (step 4); the first backup is step 16.
12. **NetworkPolicy attestation**, for exactly this `.env`:
    ```bash
    npm run -s production:config-check -- --print-network-env > /srv/jumptotech/evidence/network-contract.env
    KUBECONFIG=infrastructure/kind/generated/kubeconfig-host-jumptotech-labs.yaml \
      env $(cat /srv/jumptotech/evidence/network-contract.env) \
      npm run verify:network-policy -- --write-attestation --json /srv/jumptotech/evidence/network-probe.json
    ```
    `VERDICT: PASS` is required.
13. **Configuration.** `make secrets-check`; `make production-config-check` (0 FAIL).
14. **Preflight** (§14): `RESULT: PASS`.
15. **Five-student synthetic gate** (§13.1), before the production stack starts.
    It rewrites the cluster's NetworkPolicy attestation for the validation `.env`
    (§13.1 step 8), so **repeat steps 12–14** afterwards: without that the
    production api refuses every Kubernetes lab and the smoke fails `k8s.attestation`.
16. **Start.** `prod up -d --build --wait --wait-timeout 900`; `prod ps`. Then:
    ```bash
    export BACKUP_DIR=/srv/jumptotech/backups/postgres BACKUP_STATUS_DIR=/srv/jumptotech/backups/status
    scripts/db-backup.sh --label first-deploy
    scripts/db-restore.sh --verify-only <printed path>
    ```
    Install `/etc/cron.d/jumptotech-db` (runbook §1.2). Restore beside production:
    `scripts/db-restore.sh --into jumptotech_labs_check_<date> <archive>`, and validate it
    ([postgres-backup-restore.md §6.3](../runbooks/postgres-backup-restore.md)).
17. **Smoke** (§16): `make private-beta-smoke ARGS="--public-ip <public-ip> --report-dir /srv/jumptotech/evidence"`.
    Every line PASS except `backup.offhost` until D7 (see the exception above).
18. **External checks, from another network:**
    ```bash
    nc -zv -w3 <public-ip> 80 443
    nc -zv -w3 <public-ip> 3001 4000 4001 4002 5432 9090 9093 9400 9401 9402 16443   # must all fail
    npm run tls:check -- --origin https://<host> --expect-acme                        # exit 0
    ```
19. **Identity.** A beta account signs in; a non-beta account is refused at the
    provider; sign-out invalidates the cookie.
20. **Student session.** LINUX-001, K8S-001 and DOCKER-001: start, terminal, Check,
    Reset, End; active sessions return to 0.
21. **Observability.** Grafana through the tunnel; smoke `observability.*` PASS.
22. **Alerts.** The §12.1 drill — blocked until D6.
23. **Off-host backup.** Smoke `backup.offhost` PASS and one restore from the copy — blocked until D7.
24. **Rehearsal** (§13.2) and capacity acceptance — blocked until D8.
25. **Recovery drills** (§17), with no students active.
26. **Evidence.** Fill [production-host-evidence-template.md](../releases/production-host-evidence-template.md) on the host.

## 16. Smoke test procedure

```bash
make private-beta-smoke ARGS="--public-ip <public-ip> --report-dir /srv/jumptotech/evidence"
# before DNS is live: ARGS="--connect <public-ip> ..."
```

The smoke is read-only: it never signs in, starts, stops or restarts anything, and
makes one unauthenticated POST to an unrouted path. It reads only `PUBLIC_ORIGIN`.
curl is bounded by `--max-time 15`; docker and npx are bounded as in §14. Each
section header names its proof class:

| Proof class | Checks |
|---|---|
| **LOCAL ENDPOINT PROOF** (127.0.0.1 inside containers) | `/readyz` of api, terminal, sandboxd; api `/health`: labs loaded, durable PostgreSQL progress store, `maxActive` 5, providers available (AWS informational); `pg_isready`; Prometheus targets up; firing alerts; Alertmanager and Grafana answer; deployed 5/1 gauges; attestation valid; certificate days left; backup age, verification age, off-host copy |
| **HOST-LOCAL PROOF** (Docker on this host) | every service running and healthy; Docker restart counts (WARN); restart policy exactly `unless-stopped` (FAIL otherwise); only 443/80/loopback Grafana published; postgres only on internal networks; optional `--public-ip` probe of forbidden ports **from the host** |
| **PUBLIC-ENDPOINT PROOF, from this host** | HTTPS 200 with a trusted chain; HSTS; `http://` → 301 to the same path; `tls:check --expect-acme`; `/auth/config` reports oidc with sign-in; `/api/me`, `/api/labs`, `/api/sessions` → 401; `Authorization: Developer` and `x-dev-student-id` → 401; `/auth/login` → 302 to the provider; `/internal`, `/metrics`, `/readyz`, `/health` not routed. **These requests may never leave the host; they do not prove internet reachability.** |
| **EXTERNAL-INFRASTRUCTURE / PERSON** (always MANUAL CHECK REQUIRED) | scan from another network; restore beside production; a real student flow; a non-beta account refused; an alert received by a person; Grafana through the tunnel |

Authentication-protected endpoints are probed only unauthenticated, where 401 is
the correct answer; the smoke never holds a session.

## 17. Recovery procedures and drills

Run the drills before students, with no sessions active, then re-run the smoke.
None of them deletes data.

| Scenario | Action | Expected on current main | Status |
|---|---|---|---|
| Service crash | none (Docker restarts it: `unless-stopped`) | returns by itself; `ServiceRestartLoop` fires if it keeps dying; RB-01 | policy PROVEN LOCALLY (PR #34); REQUIRES PRODUCTION HOST |
| api restart | `prod restart api` | sessions survive; in-flight requests fail; reaper resumes | PROVEN LOCALLY at `c8eb2c6` (harness) |
| api re-created | `prod up -d api` (a `.env` change, an upgrade, a rollback) | open workspaces and terminals stay, with a "Cannot reach the labs API right now" banner; the edge routes to the new container by itself (no `prod restart web`) | PROVEN LOCALLY (browser E2E, real-image edge test; [readiness pass](private-beta-readiness-2026-09-17.md)); REQUIRES PRODUCTION HOST |
| terminal restart | `prod restart terminal` | open shells drop; the workspace reconnects by itself for about a minute, then offers Reconnect | web behaviour PROVEN LOCALLY (component tests); REQUIRES PRODUCTION HOST |
| sandboxd restart | `prod restart sandboxd` | container-track shells drop; sandboxes remain | REQUIRES PRODUCTION HOST |
| database restart | `prod restart postgres` | api not ready until postgres is healthy, then recovers | REQUIRES PRODUCTION HOST |
| interrupted Reset/End | restart the api mid-operation | ENDING resumed at 5 min; RESETTING → DEGRADED at 10 min ([RB-17](../runbooks/RB-17-session-lifecycle.md)) | PROVEN IN CI |
| Docker daemon restart / host reboot (maintenance window) | `sudo systemctl restart docker` / `sudo reboot` | platform containers return (`unless-stopped`) unless an operator had stopped them. **Unmeasured:** whether the kind node container returns and becomes Ready, and whether the attestation still validates. Record `docker inspect -f '{{.State.Status}} {{.HostConfig.RestartPolicy.Name}}' jumptotech-labs-control-plane` | NOT PROVEN |
| Certificate failure | [RB-15](../runbooks/RB-15-tls-edge.md), [production-tls.md §7](../runbooks/production-tls.md); `tls-install.sh` refuses bad renewals and rolls back | web restarts in a loop until a valid certificate is installed (runbook §6.1) | PROVEN IN CI (edge suite) |
| Failed deployment | §21 | — | PROCEDURE READY |
| Backup restore | `--verify-only`, `--into`; `--replace` only in a real recovery ([§6.4](../runbooks/postgres-backup-restore.md)) | — | PROVEN IN CI; never on a host |
| Disk pressure | [RB-19](../runbooks/RB-19-host-pressure.md); stop launches (runbook §3) | `HostDiskSpaceLow/Critical` fire | rules PROVEN IN CI; REQUIRES PRODUCTION HOST |

If the kind node does not return after a reboot:
```bash
docker start jumptotech-labs-control-plane
KUBECONFIG=infrastructure/kind/generated/kubeconfig-host-jumptotech-labs.yaml kubectl get nodes
prod up -d --wait --wait-timeout 900
make private-beta-smoke ARGS="--report-dir /srv/jumptotech/evidence"
```

**Never** `prod down -v`: it deletes the PostgreSQL volume.

## 18. Security findings and audits

### 18.1 Scrape-token permissions (fixed on this branch)

- **Original problem.** `make observability-token` wrote
  `infrastructure/observability/secrets/scrape-token` as `0600`, owned by the
  operator. Prometheus runs as uid 65534 and reads it through a bind mount, which
  keeps host ownership on Linux.
- **Impact.** Operational, not a leak: on a Linux host every scrape fails
  (`unable to read authorization credentials … permission denied`), every target
  is down, `ServiceDown` fires for api/terminal/sandboxd, and the dashboard is
  blind. Docker Desktop's file sharing hides it, and no CI job runs Prometheus with the token.
- **Reproduction.** `prom/prometheus:v2.54.1` as uid 65534, against a volume holding
  the token with Linux ownership (uid 1000): `0600` → `down`, permission denied;
  `0644` → `up`. A `0700` directory also fails; `0711` and `0755` work.
- **Fix.** The token is written under `umask 077` and then set to `0644`; the
  directory is set to `0711` (traversable, not listable). The README says the same.
- **Why it is safe.** The token authorizes only `GET /metrics` on three internal
  listeners that are never published and not routed by nginx, and metrics carry no
  secret or personal labels (label-policy tests). `0644` exposes it only to local
  accounts that can traverse the checkout, which the `0750` checkout mode prevents
  (§5.2, preflight `checkout.mode`). The alertmanager `webhook-url` already follows
  the same rule.
- **Tests.** `production-host-contract.test.ts` asserts the target writes `0644` in
  a `0711` directory, never `0600`, for the uid Prometheus runs as, and that the
  README agrees (confirmed failing on the old mode). The preflight's
  `observability.scrape-token-mode` and `-match` checks have harness cases for a
  `0600` file, a `0700` directory and a stale value.
- **Where the value can appear:**
  - *Logs:* the services' log redactor recognises the generated hex shape, and each
    service refuses to start with a secret it could not redact
    (`assertSecretsAreRedactable`). Prometheus reads it from a file and does not log it.
  - *Rendered Compose:* **yes — as `OBSERVABILITY_SCRAPE_TOKEN` in the api, terminal
    and sandboxd environment**, like every environment secret. `docker compose config`
    and `docker inspect` output therefore contain secrets and must not be pasted
    anywhere. `check-secret-distribution.mjs` and the config check keep that output
    in memory and never print it.
  - *Process arguments:* no. It travels as an environment variable and a file;
    `make observability-token` moves it through a pipe, not an argument; the
    preflight compares hashes.
  - *Prometheus, Grafana, API:* Prometheus's config page shows only the
    `credentials_file` path; Grafana never holds the token; the api does not expose
    its environment.
- **Rotation.** Put a new value in `.env`, run `make observability-token`, then
  `prod up -d api terminal sandboxd` (their environment changes, so they are
  re-created). Prometheus reads the credentials file on each scrape; expect scrape
  failures only between the two steps.
- **Overlap with main.** None: PR #34 did not touch the Makefile or the token.

### 18.2 Findings

| # | Finding | Severity (public host) | State |
|---|---|---|---|
| S1 | Scrape token unreadable on Linux | High (monitoring blind) | **Fixed**, §18.1 |
| S2 | Any account the identity provider authenticates is admitted | **Blocker** with a public provider | **REQUIRES EXTERNAL DECISION**, §8 — not fixed |
| S3 | `MAX_ACTIVE_SESSIONS` compose default is 20 | Medium | config-check and smoke FAIL; PR #34's runbook §2 reads the gauge |
| S4 | `DOCKER_SOCKET_GID` default 0 | Medium (six tracks unavailable) | preflight FAIL on mismatch |
| S5 | kind kubeconfigs and scrape token are `0644`; kind API on `127.0.0.1:16443` | Medium on a shared host | dedicated host, checkout `0750`; preflight WARN |
| S6 | A checkout made under `umask 077` breaks bind-mounted configs | Availability | preflight FAIL |
| S7 | Docker-published ports bypass host `INPUT` rules | High if relied upon | §7; external scan MANUAL |
| S8 | `.env` holds every secret | High if readable | preflight FAIL unless no group/other bits |
| S9 | Backups unencrypted and on-host only | High | REQUIRES EXTERNAL DECISION; smoke FAIL |
| S10 | `docker compose config` / `docker inspect` output contains secrets | Medium (operator habit) | documented in §18.1; the tooling never prints it |
| S11 | Compose quotes `.env` values back in its parse errors | Medium | the config check redacts them (self-test scenario) |
| S13 | `cmd \| grep -q` under `set -o pipefail` can report a miss for text that matched (the writer dies of SIGPIPE when grep exits early); seen once in six Linux runs of the harness, and present in the preflight's `ss`, `configz` and admission-policy checks and several smoke checks | Medium (spurious FAIL on a host with large output; one case could hide a FAIL) | **Fixed** before merge: `jtt_contains` matches captured text; harness assertions use here-strings; 5/5 clean Linux runs afterwards |
| S12 | Known and unchanged: shared uid 1001 credential read, privileged DinD, plaintext on the internal database bridge, Grafana login page reachable from other containers, terminal not `read_only` | trusted students only (release gate §6, §11.4) | none here |

This branch does not broaden any privilege, publish any port, add a socket mount,
weaken OIDC or TLS, enable development authentication, generate default
credentials, or delete or overwrite data.

## 19. External decisions required

| # | Decision | Blocks |
|---|---|---|
| D1 | Identity provider and tenant | sign-in |
| D2 | Hosting provider, host, Kubernetes substrate (kind on the host, or other) and CNI | everything |
| D3 | **Who may sign in, and how the provider enforces it** | inviting anyone |
| D4 | Public hostname and DNS provider | TLS, OIDC redirect |
| D5 | CA and ACME client; renewal schedule | TLS |
| D6 | Alert destination and on-call | human alert delivery |
| D7 | Off-host backup destination, encryption, retention, restore rights | disaster recovery |
| D8 | Capacity acceptance thresholds at five students | declaring capacity acceptable |
| D9 | Where `.env` and the TLS key are recoverable from | host replacement |
| D10 | Operator access (SSH keys, bastion) and who holds `docker` | operations |
| D11 | Attestation re-probe cadence (7-day maximum age) | Kubernetes labs after a week |
| D12 | Metric/log retention; external uptime check; host exporter | operations |
| D13 | Federated logout; idle timeout | sign-out behaviour |
| D14 | IPv6, HSTS preload, CAA | DNS/TLS |

## 20. Evidence for this branch

Run on this branch after rebasing onto `c00ec48` (PR #37: browser E2E, merged
after PR #36's post-beta security audit), on a development machine shared with
other stacks (load average 20–37 on 10 cores). **None of it is host evidence.**

The rebase had one conflict, in `docs/releases/private-beta-release-gate.md`:
PR #37 and this branch had each appended a §12. PR #37's browser E2E section
keeps §12; this branch's production-host section is now §13. Two other files are
shared and merged without conflict: `package.json` (separate script hunks) and
`.github/workflows/quality-gates.yml` (this branch's two `gates` steps; PR #37's
browser-e2e job). This branch's earlier cherry-pick of the web page-title race fix
was dropped as already applied: the identical change is on `main` from PR #37, so
the branch no longer touches `apps/web`. The test CA's DER serial fix (§20.1) is
now on `main` as well. This branch still changes no file under `apps/` or
`services/*/src`, and no verifier, sandbox, terminal or Kubernetes code.

| Command | Result |
|---|---|
| `npm run validate:labs` | PASS — 117 labs, 0 errors, 0 warnings |
| `npm run typecheck` | PASS (after `npm ci`, which installed PR #37's new `e2e` workspace dependencies) |
| `npm test` | PASS, every workspace, on the second run. The first run failed three `apps/api` `catalog-api.test.ts` tests on the 5 s test timeout and one `services/observability` `redact.test.ts` linear-time bound (129 ms against 50 ms) at load 36; both files pass alone and are unchanged by this branch and by PR #37 |
| `npm run test:security` | PASS |
| `npm run build` | PASS |
| `node scripts/check-secret-distribution.mjs` | PASS |
| `bash scripts/check-observability.sh` | PASS |
| `npm run production:config-check -- --self-test` | PASS, 20 scenarios |
| `bash scripts/test-production-host-scripts.sh` | PASS, 41 cases |
| `production-host-contract.test.ts` | PASS, 52 tests |
| `make test-tls-edge` (`tls-edge-integration.test.ts`, with the §20.1 fix) | PASS, 36/36 |
| `bash e2e/stack.sh run` (PR #37's browser suite, own compose project and ports) | PASS, 7/7; stack and sandboxes removed |

### 20.1 The `tls-edge-integration` failure on PR #38

PR #38's first CI run (at `bc74c29`, base `9a0e22e`) passed every job except
`tls-edge-integration`: 35 of 36 tests passed, and "notices a certificate
installed without a reload" received exit 1 from the health check it expected to
pass after `nginx -s reload`.

**Cause: a timing race in the test, not in the edge or this branch.** The test
reloaded nginx, slept a fixed 1500 ms, and ran the health check once.
`nginx -s reload` only signals the master and returns; the old workers keep
accepting connections, with the old certificate, until the master has re-read the
configuration, started new workers and retired the old ones. Measured inside the
container, from the reload returning to the served certificate changing: 170–700
ms on an unconstrained edge, and up to 1970 ms with the edge limited to one CPU.
The same unchanged test passed on `main` at `fa6f109` in CI. The product path was
already right: `scripts/tls-install.sh` polls the health check for up to ten
seconds after a reload, and the compose health check retries.

It is **not** the test CA's DER serial defect (fixed on PR #37, on `main` as `ad3e1fc`). The
assertions before the reload passed: OpenSSL 3 in the web image read the drift
certificate, and Node read both certificates, which a non-minimal serial would
have made impossible. That fix reached this branch only with the rebase onto `c00ec48`.

**Fix.** The test now polls the same health check after the reload, bounded at
20 s, reports the check's own message when it fails, and then also proves that
the Node client sees the new certificate and that `scripts/tls-check.ts` no
longer reports `served_differs_from_installed`. Negative control: with the reload
removed, the test fails with `the served certificate is not the installed one`.
Drift detection, the health check and the TLS validation are unchanged.

Local runs of the whole suite with the fix, on a Docker Desktop VM shared with
other stacks (load average above 20 on 10 cores): the drift test passed in every
run. One run failed a different test, "refuses TLS 1.1 and a CBC suite …", by
hitting its 180 s timeout. That test takes about 3 s in CI and about 50 s on this
machine when it passes, so the timeout is local Docker contention, not this change.
With the fix, `tls-edge-integration` passed in PR #38's CI at `5d486ef` (base
`fa6f109`); on `c00ec48` it has passed locally (§20) and awaits PR #38's CI.

## 21. Rollback procedure

| Situation | Rollback |
|---|---|
| A configuration change broke startup | restore `.env.previous` (`0600`), `prod up -d --wait`, preflight |
| Certificate renewal refused | `tls-install.sh` changes nothing when it refuses, and rolls back itself |
| New release misbehaves, no new migration | `git checkout <previous commit>`, `npm ci`, `prod up -d --build --wait`, preflight, smoke |
| New release applied a migration | migrations are forward-only: always take `scripts/db-backup.sh --label pre-upgrade` first; roll back by checking out the previous commit and restoring that archive per [postgres-backup-restore.md §6.4](../runbooks/postgres-backup-restore.md) (renames, never drops; its own rollback is §6.6) |
| Security incident | `prod stop web` (stays stopped across reboots with `unless-stopped`); running labs are reclaimed by idle expiry |
| Stop launches only | tell the cohort; `LAB_LAUNCHES_PAUSED=true` and `prod up -d api` refuses every Start Lab and keeps running labs (runbook §3) |

Never `prod down -v`, never remove a `jumptotech-labs-*` volume, and never edit
`lab_sessions` by hand.

## 22. Remaining blockers

For the pull request: review, and a fresh CI run on the rebased branch.

For student access: every unchecked line of §23.

## 23. FIRST REAL HOST — REQUIRED BEFORE STUDENT ACCESS

Record every line in the deployment's copy of
[production-host-evidence-template.md](../releases/production-host-evidence-template.md).
Nothing below is done.

### 23.1 External decisions and actions (a person must do these; no script can)

- [ ] **D2** Host provisioned; substrate chosen and recorded.
- [ ] **D1/D3** Identity provider client created **and restricted to the five beta accounts**; self-service sign-up off.
- [ ] **D3 proof** A non-beta account is refused at the provider.
- [ ] **D4** Hostname chosen; the DNS `A` record resolves to the host from another network.
- [ ] **D5** Certificate issued by the chosen CA; renewal scheduled.
- [ ] **Firewall** Provider firewall / `DOCKER-USER` admits only 80, 443 and operator SSH; a scan from another network confirms it.
- [ ] **D6** Alert destination installed; the §12.1 drill received by a named person.
- [ ] **D7** Off-host, encrypted backup copy configured; one restore from that copy validated.
- [ ] **D8** Capacity thresholds decided; the §13 measurements judged against them.
- [ ] **D9/D10** Secret and key recovery location, and operator access, recorded.
- [ ] Five-person rehearsal (§13.2) completed.
- [ ] Docker restart and host reboot drills (§17) completed; kind node behaviour recorded.

### 23.2 Automatically verifiable on the host (the command's own result is the evidence)

- [ ] `make production-config-check` — 0 FAIL.
- [ ] `npm run verify:network-policy -- --write-attestation` with the printed network environment — `VERDICT: PASS`.
- [ ] `make production-preflight` — `RESULT: PASS`.
- [ ] `make beta-validate` on the deployed commit, on this host (§13.1) — `RESULT: PASS`.
- [ ] `host-capacity-sample.sh` CSVs from the synthetic run and the rehearsal saved.
- [ ] `prod up -d --build --wait` succeeded.
- [ ] `scripts/db-backup.sh` and `db-restore.sh --verify-only` succeeded; the `--into` restore validated.
- [ ] `make private-beta-smoke` — `RESULT: PASS` (which requires `backup.offhost`, i.e. D7).
- [ ] External `npm run tls:check -- --origin https://<host> --expect-acme` from another network — exit 0.
