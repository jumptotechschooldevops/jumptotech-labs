# Production-host readiness — the first private-beta deployment

| | |
|---|---|
| **Branch** | `feat/production-host-readiness`, from `origin/main` at `cb7804a` |
| **Date** | 2026-09-16 |
| **Audience** | the operator who deploys JumpToTech Labs on its first real host, for about five trusted students |
| **Production host deployed?** | **No.** Nothing in this document ran on a production host. No host, DNS record, certificate, identity provider or backup destination exists yet. |

> **Read this first.** Every status below says where its evidence came from.
> `PROVEN LOCALLY` and `PROVEN IN CI` are software evidence from a laptop or a
> GitHub runner. They are **never** evidence that a production host works. Only
> a result recorded on the host itself, in the evidence checklist (§20), is
> `PROVEN ON HOST` — and today nothing is.

Status vocabulary used throughout:

| Status | Meaning |
|---|---|
| **PROVEN LOCALLY** | a command in this repository passed on a development machine (Docker Desktop, macOS) |
| **PROVEN IN CI** | a GitHub Actions job passed on an ephemeral `ubuntu-latest` runner |
| **REQUIRES PRODUCTION HOST** | can only be proven on the real host; the procedure is here, the evidence is not |
| **REQUIRES EXTERNAL DECISION** | blocked on a choice nobody has made (provider, destination, policy) |
| **NOT PROVEN** | no evidence of any kind |
| **PROVEN ON HOST** | recorded on the production host itself, in that deployment's evidence checklist (§20). **Nothing has this status today** |

---

## 1. Executive summary

The software release gate for the five-student private beta passed
([private-beta-release-gate.md](../releases/private-beta-release-gate.md),
BETA-P0-020). That gate ran on a laptop and on CI runners. **The platform has
never run on a production host**, and several things that decide whether it
works there cannot be seen from a laptop.

This pass made the first deployment controlled and measurable rather than
improvised:

- **A production-host defect, found and fixed.** `make observability-token`
  wrote the Prometheus scrape token `0600`, owned by the operator. Prometheus runs
  as uid 65534. On a Linux host every scrape would fail with `permission denied`
  and every target would be down; Docker Desktop's file sharing hid it on every
  laptop. Reproduced with the real `prom/prometheus:v2.54.1` image and Linux file
  ownership (target `down`, `lastError: ... permission denied`), fixed (`0644` in
  a `0711` directory; also proven `up`), and pinned by a regression test (§18, S1).
- **`npm run production:config-check`.** Resolves the five production compose
  files with the operator's `.env` and runs the **real** api, terminal and
  sandboxd configuration loaders against what Compose resolves for each service,
  plus a production-host contract (exposure, privilege, pinned gates, the 5/1
  capacity contract, durability). Its `--self-test` proves 20 fail-closed
  scenarios against the real files and loaders.
- **`scripts/production-preflight.sh`** (`make production-preflight`). About 80
  host checks, fail-closed, secrets reported as `NAME: present` only, and
  `MANUAL CHECK REQUIRED` for everything a script cannot prove.
- **`scripts/private-beta-smoke.sh`** (`make private-beta-smoke`). About 50
  non-destructive checks of the running stack. Writes an evidence file.
- **`scripts/host-capacity-sample.sh`**. Records CPU, memory, disk, containers
  and Pods while five students work. Host sizing is not proven, so this measures
  and does not judge.
- **An exact deployment procedure** (§15), recovery drills (§17), rollback
  (§21) and an evidence checklist (§20).

**Verdict for a production host: NOT READY TO INVITE STUDENTS until the
blockers in §22 are closed.** Several of those blockers are external decisions,
not software: who may sign in, the off-host backup destination, where alerts go,
and the host itself.

## 2. Current production architecture

One Linux host runs everything. From repository evidence
(`docker-compose*.yml`, [runtime-architecture.md](../runtime-architecture.md)):

```
Internet ─443─► web (nginx, TLS gate) ─┬─► api :4000 ──► postgres :5432   (internal "database" network)
         ─80──► redirect + ACME         │      │  └────► kind API server  (external "kind" network)
                                        │      └───────► sandboxd :4002   (Docker socket; the only holder)
                                        └─► terminal :4001 ─► sandboxd (attach), kind (per-session kubeconfig)
                                                             └► session sandboxes ("jumptotech-sandboxes" network)
127.0.0.1:3001 ─► Grafana (in Prometheus's netns) ◄── Prometheus :9090, Alertmanager :9093 (loopback in that netns)
kind node container ("jumptotech-labs-control-plane") — a whole Kubernetes node, privileged, on the same host
Per-session sandboxes — created by sandboxd; Docker-track sandboxes run --privileged (docker:27-dind)
```

The production command is the runbook's `prod` function:
[private-beta-operations.md §1](../runbooks/private-beta-operations.md) — five
compose files and `--profile observability`, in that order.

**Substrate.** The only Kubernetes substrate this repository implements and
proves is the kind cluster created on the same host by `npm run cluster:up`.
[kubernetes-network-security.md §8](../kubernetes-network-security.md) calls kind
"development infrastructure, not a production substrate", and the production
substrate is **DECISION REQUIRED** (P0-015 D1/D2). For a first host with five
trusted students, the practical choice is kind on the host — and that is itself a
decision to record (§19, D2), not a default to drift into.

## 3. What is already proven

| Claim | Status | Evidence |
|---|---|---|
| Five students, capacity 5/1 refusals, isolation, reset, soak, api restart, cleanup | PROVEN LOCALLY (at `c8eb2c6`) | `make beta-validate`, release gate §4. `main` is 16 commits past `c8eb2c6` and has not been re-run (the unmerged `feat/beta-overnight-hardening` report says the same) |
| Unit and contract suites | PROVEN IN CI (at `c8eb2c6`) | `npm test`, release gate §3 |
| Production composition publishes only 443/80 (+ loopback Grafana); postgres internal; secrets distributed per service | PROVEN IN CI | `node scripts/check-secret-distribution.mjs`, `compose-secret-distribution.test.ts` |
| TLS edge fails closed; redirect; WebSocket over TLS; renewal | PROVEN IN CI with test-only certificates | `make test-tls-edge`, CI `tls-edge-integration` |
| PostgreSQL backup → destroy → restore → identical fingerprint | PROVEN IN CI | `make db-restore-drill`, CI `postgres-integration` |
| NetworkPolicy enforcement on kind, with negative controls | PROVEN IN CI (kind, one node) | CI `kind-integration` |
| Rules, alerts, dashboards valid; label policy | PROVEN IN CI | `scripts/check-observability.sh`, `npm test` |
| Production config gates fail closed against the real compose files and real loaders (20 scenarios, including a malformed `.env` never echoing its value) | PROVEN LOCALLY (this branch) | `npm run production:config-check -- --self-test`; added to CI `gates`, which runs on pull requests — not yet run there |
| Preflight, smoke and sampler decisions; no secret printed; only read-only docker/kubectl verbs | PROVEN LOCALLY on macOS bash 3.2 **and** in a Linux container (bash 5.2, GNU coreutils 9.1) | `bash scripts/test-production-host-scripts.sh` (40 cases) |
| Scrape token readable by Prometheus under Linux file ownership | PROVEN LOCALLY with the real Prometheus image and Linux ownership semantics | §18 S1 |

## 4. What remains unproven

| Item | Status |
|---|---|
| Anything running on a production host | **REQUIRES PRODUCTION HOST** |
| `make beta-validate` on the current `main` (only `c8eb2c6` was gated) | NOT PROVEN |
| Host sizing (CPU, memory, disk) for five students | NOT PROVEN — measured on one laptop only; §13 |
| A public CA certificate, real DNS, renewal on a schedule | REQUIRES EXTERNAL DECISION, then PRODUCTION HOST |
| OIDC sign-in against a real identity provider over TLS | REQUIRES EXTERNAL DECISION, then PRODUCTION HOST |
| Admission restricted to the beta students | REQUIRES EXTERNAL DECISION (§8) |
| Off-host backup copy, encryption, and a restore from it | REQUIRES EXTERNAL DECISION, then PRODUCTION HOST |
| An alert reaching a person | REQUIRES EXTERNAL DECISION, then PRODUCTION HOST |
| External firewall / only 80 and 443 reachable from the internet | REQUIRES PRODUCTION HOST |
| Recovery after a Docker daemon restart or host reboot (no `restart:` policy on `main`; kind node behaviour) | NOT PROVEN |
| NetworkPolicy enforcement on the production substrate | REQUIRES PRODUCTION HOST (probe must PASS there) |
| The React UI driven in a real browser end to end | NOT PROVEN here (another branch is working on browser E2E) |
| The new CI gates on GitHub | NOT PROVEN until a pull request runs them |

## 5. Host prerequisites

Every row cites its evidence. Nothing here is invented: where the repository does
not justify a number, the row says so and §13 measures it.

### 5.1 Required

| Requirement | Value | Evidence |
|---|---|---|
| OS | Linux | Every image is a Linux image; kind and `--privileged` DinD sandboxes need a Linux kernel. `production-preflight.sh` fails on anything else |
| Architecture | `x86_64` (amd64) proven; `arm64` builds but is not proven in CI | `api.Dockerfile`/`sandboxd.Dockerfile` map only amd64/arm64; CI runs `ubuntu-latest` amd64 |
| Docker Engine | rootful, reachable by the operator, `OSType=linux`, socket at exactly `/var/run/docker.sock` | `docker-compose.runtime.yml` mounts that path into sandboxd; kind nodes and Docker-track sandboxes are privileged containers |
| Docker Compose | v2 plugin supporting `!reset` and `!override` | the production overlays use both. Proven functionally by `production:config-check` (it renders the stack); observed locally with v2.39.2 |
| `DOCKER_SOCKET_GID` | the gid owning `/var/run/docker.sock` | default `0` only works on Docker Desktop (`docker-compose.runtime.yml` comment); preflight compares |
| kind | v0.31.0, node image `kindest/node:v1.34.0` | CI `kind-integration` pins `KIND_VERSION: v0.31.0`; `infrastructure/kind/cluster.yaml` |
| kubectl | v1.34.2 | CI pin; `api.Dockerfile` `KUBECTL_VERSION` |
| Node.js | 22 (`.nvmrc`), plus `npm ci` in the checkout | operator tooling runs on the host: `make secrets-check`, `npm run tls:check`, `npm run verify:network-policy`, `npm run production:config-check`, `make beta-validate` |
| `git`, `openssl`, `curl`, `iproute2` (`ss`) | installed | clone/record commit; `make secrets` uses `openssl rand`; smoke uses `curl`; preflight uses `ss` |
| Outbound registry and download access at build/first start | Docker Hub (`node`, `nginx`, `postgres`, `prom/*`, `grafana/*`, `docker:27-dind`, `busybox`, lab images such as `nginx:1.27-alpine`, `nginx:stable`), `registry.npmjs.org`, `download.docker.com`, `dl.k8s.io`, `kind.sigs.k8s.io` | Dockerfiles download the Docker CLI and kubectl; `cluster-up.sh` may apply a manifest from GitHub; labs pull images on first start (five-student runbook §1 step 6) |
| Checkout readable by container users | files other-readable, directories other-executable (clone under `umask 022`) | api/sandboxd run as uid 1000, Prometheus/Alertmanager 65534, Grafana 472, nginx workers 101; all read bind mounts. Preflight `checkout.bind-mounts` |
| Clock | NTP-synchronized | OIDC token checks allow 5 s of skew (`authentication.md` §4.4); certificates and the attestation are time-bound |
| Free ports | host 80 and 443 | the production publication; preflight `exposure.port-80/443` |

### 5.2 Recommended

| Recommendation | Why |
|---|---|
| A dedicated host with **no other local accounts** besides operators | the kind admin kubeconfig and the scrape token must be other-readable for their containers (`cluster-up.sh` writes kubeconfigs `0644`); `docker` group membership is root-equivalent |
| Checkout directory mode `0750` (or `0700`), owned by the operator | keeps other local accounts away from the files above. Docker resolves bind mounts as root, so containers are unaffected. Preflight `checkout.mode` |
| `BACKUP_DIR` on a different filesystem (ideally a different disk) from Docker's data root | [postgres-backup-restore.md §5.5](../runbooks/postgres-backup-restore.md) |
| Pre-pull `docker:27-dind` | first Docker-track start otherwise depends on Docker Hub; preflight warns |

### 5.3 Unknown — must be measured or decided

| Item | Why it is unknown | How to close it |
|---|---|---|
| CPU count | never measured on a server | §13 |
| Memory | laptop: ~0.7 GiB idle platform + ~0.7 GiB kind node; DOCKER-001 may use up to `DOCKER_SANDBOX_MEMORY=2g`; one laptop run died of *host* memory pressure (release gate §8, five-student runbook §9) | §13 |
| Disk | Docker images, the kind node, per-session DinD image stores, Prometheus (15 d retention), PostgreSQL growth and on-host backups — none sized | §13; alert thresholds are 15 % / 8 % free |
| Kernel settings (`fs.inotify.max_user_watches`, `max_user_instances`) | kind runs a full node on the host kernel; the repository sets and proves no value | preflight records them as INFO; raise only if the kind node or Pods fail with "too many open files", and record what you set |
| cgroup version / driver | not constrained by the repository; the laptop ran cgroup v2 | preflight records it |
| IPv6 | `443:8443`/`80:8080` publish on every address family Docker is configured for ([runtime-architecture.md §11.7](../runtime-architecture.md)) | decide; add an AAAA record only if 443/80 really serve IPv6 |
| Rootless Docker | not proven; privileged containers are required | use rootful (preflight warns) |

### 5.4 Filesystem layout

The runbooks already use these paths; nothing here is new.

| Path | Owner / mode | Holds |
|---|---|---|
| `/srv/jumptotech-labs` | `jtt-ops`, `0750` | the checkout, `.env` (`0600`), TLS key (`0600`), scrape token (`0644` in `0711`), kind kubeconfigs |
| `/srv/jumptotech/backups/postgres` | `jtt-ops`, `0700` | `BACKUP_DIR`: archives (`0600`) and checksums |
| `/srv/jumptotech/backups/status` | `jtt-ops`, `0755` | `BACKUP_STATUS_DIR`: backup outcome files (`0644`), mounted read-only into the api. Must not overlap `BACKUP_DIR` |
| `/var/log/jumptotech` | `jtt-ops` | cron job logs |
| `/srv/jumptotech/evidence` | `jtt-ops`, `0700` | preflight reports, smoke evidence, capacity samples, the filled checklist (§20). Never a secret |
| `/var/lib/docker` (Docker data root) | root | named volumes `jumptotech-labs-postgres-data`, `-prometheus-data`, `-grafana-data`, `-alertmanager-data`; images; the kind node |

`jtt-ops` is the runbooks' name for the operator account. It is in the `docker`
group, which is root-equivalent: choose who has it accordingly.

## 6. Production configuration contract

`npm run production:config-check` is the executable form of this section
(`test-support/production-host-contract.ts`). What it requires of the merged
configuration:

| Check id | Contract |
|---|---|
| `compose.services` | exactly alertmanager, api, grafana, postgres, prometheus, sandboxd, terminal, web |
| `exposure.published-ports` | only `443→web:8443`, `80→web:8080`, `127.0.0.1:*→grafana:3000` |
| `exposure.database` | postgres publishes nothing; `database` network is `internal: true` with members api and postgres only |
| `exposure.observability` | Prometheus and Alertmanager on `127.0.0.1` in one namespace; no lifecycle API; Grafana anonymous and basic auth off |
| `privilege.docker-socket` | only sandboxd mounts `/var/run/docker.sock` |
| `privilege.containers` | no compose service privileged, on the host network, or given capabilities (except the terminal's SETUID/SETGID drop) |
| `runtime.docker-socket-gid` | sandboxd joins the socket's group |
| `gates.node-env` | api, terminal, sandboxd run `NODE_ENV=production` (pinned; `.env` cannot change it — self-test proves) |
| `gates.authentication` | `AUTH_MODE=oidc` pinned; `DEV_STUDENT_HEADER_ENABLED` not `true` |
| `gates.tls-edge` | `WEB_TLS=required` pinned; `PUBLIC_ORIGIN` a bare `https://` origin, the same for api and web; served-certificate health check |
| `gates.network-policy` | neither `NETWORK_POLICY_ENABLED` nor the attestation requirement is waived |
| `capacity.beta-contract` | `MAX_ACTIVE_SESSIONS=5`, `MAX_ACTIVE_SESSIONS_PER_STUDENT=1`. **The compose default is 20**; `.env` must set 5 |
| `durability.volumes` | postgres, prometheus, alertmanager, grafana data are named volumes |
| `durability.healthchecks` | postgres, api, terminal, web have health checks |
| `durability.restart-policy` | WARN on `main`: no service has a restart policy (§17) |
| `backup.status-dir` | the api mounts an absolute host status directory read-only; WARN when it is the in-checkout default |
| `loader.api`, `loader.terminal`, `loader.sandboxd` | the real loaders accept the resolved environment: secrets present, not placeholders, long enough, distinct; OIDC https; cookie Secure; CORS origins https and include `PUBLIC_ORIGIN`; broker and database transport rules; runtime owner |
| `attestation.expected-digest` | INFO: the NetworkPolicy contract digest the api will demand |

`.env` must set, in addition to what `make secrets` generates:
`PUBLIC_ORIGIN`, `ALLOWED_ORIGINS` (= `PUBLIC_ORIGIN`), `OIDC_ISSUER`,
`OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (from the identity provider, ≥ 16
characters), `OIDC_AUDIENCE`, `OIDC_REDIRECT_URI` (optional; must be
`PUBLIC_ORIGIN/auth/callback`), `RUNTIME_OWNER_ID`, `MAX_ACTIVE_SESSIONS=5`,
`MAX_ACTIVE_SESSIONS_PER_STUDENT=1`, `BACKUP_STATUS_DIR`, `DOCKER_SOCKET_GID`,
`JTT_COMMIT` and `JTT_VERSION`.

A variable exported in the operator's shell overrides `.env` for Compose. The
preflight warns about each one it finds.

## 7. Network exposure contract

| Surface | Contract | Proven by | Status |
|---|---|---|---|
| Docker publications | 443, 80, `127.0.0.1:3001` only | `check-secret-distribution.mjs`, `production:config-check`, smoke `exposure.published` | PROVEN IN CI (config); REQUIRES PRODUCTION HOST (running) |
| PostgreSQL | no host port; internal network | same; smoke `exposure.database-network` | PROVEN IN CI (config); REQUIRES PRODUCTION HOST |
| api, terminal, sandboxd, metrics | unpublished; `/internal`, `/metrics`, `/health`, `/readyz` not routed by nginx | `compose-secret-distribution.test.ts`; smoke `edge.internal-not-routed`, `edge.not-routed/*` | PROVEN IN CI (config); REQUIRES PRODUCTION HOST |
| Grafana | `127.0.0.1:3001` for an SSH tunnel; a login page to other containers on the default network (documented limitation) | `private-beta-operations.test.ts` | PROVEN IN CI (config) |
| kind API server | `127.0.0.1:16443` (`cluster.yaml`) | cluster config | PROVEN IN CI (kind) |
| Host firewall | only 80, 443 and operator SSH reachable from outside. **Docker-published ports bypass ufw/firewalld `INPUT` rules**: filter in the provider firewall or the `DOCKER-USER` chain | smoke `exposure.public-ip` (from the host) + a scan from outside | **REQUIRES PRODUCTION HOST** |
| Node-local destinations from Pods (kubelet `10250`, instance metadata) | not governed by NetworkPolicy; needs host firewall or CNI host policy | [kubernetes-network-security.md §9](../kubernetes-network-security.md) | REQUIRES EXTERNAL DECISION (P0-015 D3) |

## 8. Authentication contract

What holds (PROVEN IN CI, `production-oidc-config`, `oidc-flow-hardening`,
`token-storage` suites; [authentication.md §4](../authentication.md)):

- production pins `AUTH_MODE=oidc`; development auth and the development student
  header are refused at config load and at request time;
- https issuer, confidential client secret, exact callback on `PUBLIC_ORIGIN`,
  Secure cookie, CSRF origin guard, durable PostgreSQL sessions, PKCE/state/nonce;
- the self-test proves these refusals survive the real compose merge (§6).

What does **not** hold, and blocks a public host:

> **ADMISSION — BLOCKER, REQUIRES EXTERNAL DECISION.** The api admits **any**
> account the configured issuer authenticates, and provisions it as a student
> ([authentication.md §4.7](../authentication.md), "WHO MAY SIGN IN"). With a
> public identity provider, anyone on the internet could sign in and start a
> privileged Docker-in-Docker sandbox. Until the platform has its own admission
> rule, the identity provider **must** restrict the client to the beta students
> (application assignment, a dedicated tenant, an invite-only directory). The
> choice is provider-specific and was deliberately not guessed here. Proven only
> by the smoke's `auth.admission` manual check: a non-beta account is refused.

Also open (authentication.md §4.7): federated logout behaviour; idle timeout
(sessions have a 12 h absolute lifetime by default).

## 9. TLS contract

PROVEN IN CI with test-only certificates ([production-tls.md](../runbooks/production-tls.md)):
the web container refuses to start without a valid certificate and key for
`PUBLIC_ORIGIN`'s host, a key readable by group/others, an expired or mismatched
certificate, or a missing chain; TLS 1.2/1.3 AEAD only; HSTS; `421` on SNI/Host
mismatch; port 80 serves only the ACME route and a 301; renewal is hot and
keeps open WebSockets. There is no plaintext fallback: the self-test shows
`WEB_TLS=off` in `.env` cannot reach the edge.

REQUIRES EXTERNAL DECISION: the CA and ACME client, the hostname and DNS
provider, HSTS preload/CAA/IPv6, key custody (production-tls.md §10).
REQUIRES PRODUCTION HOST: issuance, DNS resolution, scheduled renewal, the
external `tls:check`.

## 10. Database contract

- PostgreSQL 16 (`postgres:16-alpine`) in a named volume; health-checked; only
  the api reaches it, on an internal network; plaintext only on that declared
  single-host bridge (`DATABASE_SAME_HOST_PLAINTEXT` is set in compose, once).
- Forward-only migrations run at api start (`DATABASE_AUTO_MIGRATE=true`). Take a
  `pre-migration` backup before starting a new api image that adds a migration
  ([postgres-backup-restore.md §5.2](../runbooks/postgres-backup-restore.md)).
- `POSTGRES_PASSWORD` must be generated (≥ 16 characters, not a placeholder).
  The shipped placeholder is refused in production (self-test).
- Managed PostgreSQL is not supported by these scripts (they `docker exec`).

Status: PROVEN IN CI (persistence suites, restore drill); REQUIRES PRODUCTION
HOST (the volume on the host's disk, growth).

## 11. Backup/restore contract

| Aspect | State | Status |
|---|---|---|
| Backup mechanism (`scripts/db-backup.sh`: custom-format archive, checksum, read-back, retention 14 d / min 7) | implemented | PROVEN IN CI |
| Restore (`db-restore.sh --verify-only / --into / --replace`), refusals | implemented | PROVEN IN CI |
| Scheduling | cron example in [private-beta-operations.md §1.2](../runbooks/private-beta-operations.md) | REQUIRES PRODUCTION HOST |
| Freshness and verification alerts (`BackupStale`, `BackupMissedTwice`, `BackupLastRunFailed`, `BackupVerifyFailed`) | implemented; the api reads `BACKUP_STATUS_DIR` | PROVEN IN CI (rules); REQUIRES PRODUCTION HOST |
| **Off-host destination** | `BACKUP_COPY_HOOK` seam only; no provider chosen | **REQUIRES EXTERNAL DECISION — BLOCKER** |
| **Encryption** | archives are not encrypted | **REQUIRES EXTERNAL DECISION — BLOCKER** |
| Off-host retention, access control, credentials | depends on the destination | REQUIRES EXTERNAL DECISION |
| Who may restore | Docker access = root-equivalent | REQUIRES EXTERNAL DECISION |
| A restore from the off-host copy onto a fresh host | never done | NOT PROVEN |
| `.env` and TLS key recovery (not in any database archive) | no location decided | REQUIRES EXTERNAL DECISION |
| RPO 24 h / RTO 4 h | targets, not measurements ([postgres-backup-restore.md §4](../runbooks/postgres-backup-restore.md)) | REQUIRES PRODUCTION HOST |

The smoke reports `backup.offhost` as **FAIL** until `jtt_backup_last_success_offhost`
reads 1: without an off-host copy, a lost host loses every student record.

## 12. Observability contract

| What | Status |
|---|---|
| Rules, alerts, dashboards valid; label policy; promtool unit tests | PROVEN IN CI |
| Monitoring private: loopback in one namespace, no socket, no student/cluster/database networks | PROVEN IN CI (config) |
| Scrape token readable by Prometheus on Linux | fixed on this branch; PROVEN LOCALLY (§18 S1); REQUIRES PRODUCTION HOST (`observability.targets`) |
| All targets `up` on the host; Grafana dashboard renders through the SSH tunnel | REQUIRES PRODUCTION HOST (smoke) |
| Host gauges reflect the right filesystems (`container_root` is Docker's storage) | REQUIRES PRODUCTION HOST ([private-beta-operations.md §9](../runbooks/private-beta-operations.md)) |
| **Alert destination** (webhook URL, chat, mail, paging) and on-call | **REQUIRES EXTERNAL DECISION — BLOCKER** |
| Delivery of an alert to a person | NOT PROVEN |
| External reachability monitoring | REQUIRES EXTERNAL DECISION |
| Metric/log retention beyond 15 days / container stdout | REQUIRES EXTERNAL DECISION |

Alertmanager has one receiver, `default`, a webhook read from
`infrastructure/observability/alertmanager/secrets/webhook-url`; every severity
routes to it. No destination is configured or invented here.

### 12.1 Alert delivery drill (once a destination is installed)

1. Install the destination (README in that directory; file `0644`, directory
   `0711`), then `prod kill -s HUP alertmanager`.
2. Prometheus is wired to Alertmanager:
   `prod exec -T prometheus wget -qO- http://127.0.0.1:9090/api/v1/alertmanagers`
   lists `127.0.0.1:9093` under `activeAlertmanagers`.
3. Send a clearly labelled drill alert that expires by itself (it changes no
   platform state; it exists only in Alertmanager until `--end`):
   ```bash
   end=$(date -u -d '+10 minutes' +%Y-%m-%dT%H:%M:%SZ)
   prod exec -T alertmanager amtool alert add alertname=JttAlertDeliveryDrill severity=warning service=drill \
     --annotation=summary="Delivery drill - no action required" --end="$end" \
     --alertmanager.url=http://127.0.0.1:9093
   ```
4. Within `group_wait` (30 s) plus the destination's own latency, a person
   confirms receipt. After `--end`, the resolved notification arrives
   (`send_resolved: true`).
5. `prod logs --since 15m alertmanager | grep -i notify` shows no delivery error.
6. Record in §20: destination type (not the URL), who received it, sent and
   received times.

This proves Alertmanager → destination → person. The Prometheus → Alertmanager
leg is step 2 plus CI's promtool rule tests.

## 13. Five-student capacity validation

**What exists.** `make beta-validate` proved five concurrent synthetic students
on a laptop (Docker Desktop, 10 CPUs, 7.65 GiB VM) at `c8eb2c6`. Its resource
figures are orders of magnitude from one machine
([five-student-beta-validation.md §9](../runbooks/five-student-beta-validation.md)).
**No host sizing is proven**, and no acceptance threshold (start latency,
Check latency, headroom) has been defined as a product requirement.

**What must be repeated on the host**, and why each:

| Measurement | Why it cannot be carried over | Source on the host |
|---|---|---|
| Peak CPU load and memory with five active | different CPU, memory, kernel, no VM | `host-capacity-sample.sh` (`host.csv`) |
| Peak per-container memory (DinD daemon, kind node, TF-001 burst) | the dominant costs were never measured on server hardware | `containers.csv` |
| Disk used by five sessions and after End | DinD image stores and first pulls | `host.csv` Docker disk; `docker system df` before/after |
| Container count and Pod count at five | sanity against leaks | `host.csv`; harness "nothing orphaned" |
| Session start latency per provider | image pull and host speed | harness report `concurrentStart[].ms`; `histogram_quantile(0.95, sum by (le, provider) (rate(jtt_lab_provision_duration_seconds_bucket[30m])))` |
| Check Solution latency | host speed | harness `solveTimings`; `histogram_quantile(0.95, sum by (le, provider) (rate(jtt_verification_duration_seconds_bucket[30m])))` |
| Terminal responsiveness | **not instrumented**: no metric measures keystroke echo latency | the five-person rehearsal (B) records it by hand; NOT MEASURED otherwise |
| Service restarts and errors during the run | host stability | `docker inspect -f '{{.RestartCount}}'`; `changes(process_start_time_seconds[1h])`; `sum by (outcome) (increase(jtt_lab_start_outcome_total[1h]))` |

**Operational alarms that exist** (not product SLOs): `ApiLatencyHigh`
(p95 > 1 s), `VerificationSlow` (Check p95 > 10 s), `ProvisioningSlow`
(start p95 > 60 s), `HostCpuSaturated` (load5/CPU > 2), `HostMemoryPressure`
(< 10 % available), `HostDiskSpaceLow` (< 15 % free). Record whether any fired
during the run. **Whether the measured values are acceptable for students is
DECISION REQUIRED** (§19, D8) — this procedure does not invent a pass mark.

### 13.1 A — synthetic gate on the host, before first production start

The harness drives only a loopback stack with development auth, so it cannot run
against the production stack (OIDC). It also must not share the `kind` network
with a running production stack: two stacks there resolve each other's `api`
and `terminal` names. So it runs **before** the production stack is first started.

1. Complete §15 steps 1–9 (host, checkout, cluster, images). Do not start `prod`.
2. Make a second checkout at the **same commit**: `git clone … /srv/jumptotech-validation && git -C /srv/jumptotech-validation checkout <commit>`, then `npm ci` there.
3. In that checkout, `make secrets`, then set in its `.env` (never in production's):
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
   and follow [five-student-beta-validation.md §1](../runbooks/five-student-beta-validation.md) steps 1–5 from that checkout (`npm run cluster:up` reuses the existing cluster and writes that checkout's kubeconfigs).
4. In a second shell, from the production checkout:
   `make host-capacity-sample ARGS="--out-dir /srv/jumptotech/evidence/capacity-synthetic --interval 15 --duration 2400 --kubeconfig infrastructure/kind/generated/kubeconfig-host-jumptotech-labs.yaml"`
5. From the validation checkout: `make beta-validate ARGS="--report-dir /srv/jumptotech/evidence/beta-validate"`. Record RESULT and the report path.
6. Stop the sampler (Ctrl-C prints the peaks) and keep both CSVs.
7. Tear the validation stack down **without** `-v`: from the validation checkout,
   `docker compose -f docker-compose.yml -f docker-compose.runtime.yml -f docker-compose.observability.yml -f docker-compose.production-observability.yml --profile observability down`.
   Then list what it left: `docker volume ls --filter name=jtt-hostval` and remove
   only those synthetic volumes, by exact name, after reading the list. Confirm no
   container carries the validation owner:
   `docker ps -a --filter label=jumptotech.io/managed=true`.
8. The validation run rewrote the cluster's NetworkPolicy attestation for its own
   environment. §15 step 12 writes the production one; preflight
   `k8s.attestation-digest` must PASS before `prod up`.

### 13.2 B — five-person rehearsal on the production stack, before students

After §15 is complete and the smoke passes, five operators or trusted testers
with beta accounts:

1. Start the sampler as in A step 4 (`--out-dir …/capacity-rehearsal`).
2. Note the time. Everyone presses Start within the same minute, one each on
   LINUX-001, DOCKER-001, K8S-001, ANSIBLE-001, TF-001 (the harness's lab mix).
3. Each types in the terminal for 10 minutes, including one heavy step (DOCKER-001
   `docker build`, TF-001 `terraform apply`, ANSIBLE-001 a playbook), and records
   whether echo ever felt delayed (seconds, by hand).
4. Each presses Check Solution, then Reset once, then End Lab.
5. Record, for the window: the two `histogram_quantile` queries above, the
   restart counts, `sum by (outcome) (increase(jtt_lab_start_outcome_total[1h]))`,
   the alerts that fired (`alerts`), and the sampler peaks.
6. After End: `q 'sum(jtt_sessions_active)'` is 0 and
   `docker ps --filter label=jumptotech.io/managed=true` lists nothing.

## 14. Preflight procedure

```bash
cd /srv/jumptotech-labs
make production-preflight ARGS="--backup-dir /srv/jumptotech/backups/postgres --report /srv/jumptotech/evidence/preflight-$(date -u +%Y%m%dT%H%M%SZ).txt"
```

- Exit `0` means no FAIL. Every `MANUAL CHECK REQUIRED` line still needs a person.
- Run it before the first start, after any change to `.env`, the certificate, the
  cluster, the host or the commit, and before every beta week.
- It checks: host OS/arch/memory/clock; tool versions against CI pins; Docker
  daemon, rootful, compose, socket and its group; disk against the alert
  thresholds; git commit and cleanliness; checkout and bind-mount permissions;
  `.env` mode, every required name (present/MISSING, never values), shell
  overrides; TLS files, key mode and `tls:check --offline`; scrape token
  readability and match (by hash); alert destination file; kind cluster,
  network, kubeconfigs, nodes, `seccompDefault`, admission policies; the
  NetworkPolicy attestation's verdict, cluster UID, age **and digest against what
  this `.env` will demand**; sandbox images; ports 80/443; other public
  listeners; backup directories, overlap, filesystem and schedule;
  `make secrets-check`; `npm run production:config-check`.
- It changes nothing and prints no secret (`scripts/test-production-host-scripts.sh`
  asserts both).

## 15. Deployment procedure

Each step says what proves it. Stop at the first FAIL. Placeholders:
`<host>` is the approved public host name, `<commit>` the approved release commit
or tag, `<public-ip>` the host's address.

**1. Provision host prerequisites** (§5.1). Install Docker Engine with the compose
plugin, Node 22, kind v0.31.0, kubectl v1.34.2, git, openssl, curl, iproute2.
Enable NTP. Create the operator account and add it to `docker`:
`sudo useradd -m jtt-ops && sudo usermod -aG docker jtt-ops`. Log in again as `jtt-ops`.

**2. Firewall.** Allow inbound 80 and 443, and SSH only from operator addresses,
in the provider firewall or `DOCKER-USER` (not only ufw). Everything else closed.

**3. Clone and choose the release.**
```bash
sudo install -d -m 0750 -o jtt-ops -g jtt-ops /srv/jumptotech-labs
umask 022
git clone https://github.com/jumptotechschooldevops/jumptotech-labs.git /srv/jumptotech-labs   # or the approved mirror
cd /srv/jumptotech-labs
git checkout <commit>
git rev-parse HEAD          # record in §20
npm ci
```

**4. Filesystem layout** (§5.4).
```bash
sudo install -d -m 0700 -o jtt-ops -g jtt-ops /srv/jumptotech/backups/postgres /srv/jumptotech/evidence
sudo install -d -m 0755 -o jtt-ops -g jtt-ops /srv/jumptotech/backups/status /var/log/jumptotech
```

**5. Environment and secrets.** `make secrets` creates `.env` from
`.env.example` (mode `0600`) and generates every platform secret; it never
prints a value. Then edit `.env` (with an editor, not `echo`, so values stay out
of shell history) to set the §6 list:
```
PUBLIC_ORIGIN=https://<host>
ALLOWED_ORIGINS=https://<host>
RUNTIME_OWNER_ID=jtt-production
MAX_ACTIVE_SESSIONS=5
MAX_ACTIVE_SESSIONS_PER_STUDENT=1
BACKUP_STATUS_DIR=/srv/jumptotech/backups/status
DOCKER_SOCKET_GID=<output of: stat -c %g /var/run/docker.sock>
JTT_COMMIT=<git rev-parse HEAD>
JTT_VERSION=<release tag>
```
Leave `AUTH_MODE` and `DEV_STUDENT_HEADER_ENABLED` alone: production pins the
first, and the second must stay `false`.

**6. OIDC** (REQUIRES EXTERNAL DECISION D1/D3). At the chosen provider, register a
confidential web client with redirect URI `https://<host>/auth/callback`, restrict
it to the beta students (§8), then set `OIDC_ISSUER` (exactly the discovery
`issuer`), `OIDC_CLIENT_ID`, `OIDC_AUDIENCE`, `OIDC_CLIENT_SECRET`.

**7. Kubernetes substrate.** `npm run cluster:up`. It must print
`Kubelet seccompDefault is on`; a warning instead means recreate the cluster.

**8. Images.** `make sandbox-build`, then `docker pull docker:27-dind`.

**9. TLS** (REQUIRES EXTERNAL DECISION D4/D5). DNS `A` record for `<host>` →
`<public-ip>`; confirm from outside with `dig +short <host>`. Obtain the first
certificate with the stack down ([production-tls.md §3](../runbooks/production-tls.md)),
then `make tls-install CERT=/path/fullchain.pem KEY=/path/privkey.pem`.

**10. Monitoring files.** `make observability-token`. If D6 is decided, install
the alert destination (§12.1 step 1).

**11. Backups.** Nothing to start yet; the first backup needs the database (step 16).

**12. NetworkPolicy attestation** — measured against exactly the contract this
`.env` produces:
```bash
npm run -s production:config-check -- --print-network-env > /srv/jumptotech/evidence/network-contract.env
KUBECONFIG=infrastructure/kind/generated/kubeconfig-host-jumptotech-labs.yaml \
  env $(cat /srv/jumptotech/evidence/network-contract.env) \
  npm run verify:network-policy -- --write-attestation --json /srv/jumptotech/evidence/network-probe.json
```
`VERDICT: PASS` is required. The file holds CIDRs and booleans only.

**13. Validate configuration.**
```bash
make secrets-check
make production-config-check        # 0 FAIL; the restart-policy WARN is expected on main
```

**14. Preflight** (§14). `RESULT: PASS`. Resolve every MANUAL line you can now
(DNS, firewall, admission); record the rest.

**15. Start and wait for health.**
```bash
prod up -d --build --wait --wait-timeout 900
prod ps
```
(`prod`, `q`, `ready` and `alerts` are defined in
[private-beta-operations.md §1](../runbooks/private-beta-operations.md).) If `web`
exits, `prod logs web | grep jtt-tls-preflight` names the refusal; if `api` exits,
`prod logs api | tail -30` names the variable.

**16. First backup and schedule.**
```bash
export BACKUP_DIR=/srv/jumptotech/backups/postgres BACKUP_STATUS_DIR=/srv/jumptotech/backups/status
scripts/db-backup.sh --label first-deploy                  # prints the archive path
scripts/db-restore.sh --verify-only <printed path>         # records the verification where the api reads it
```
Install `/etc/cron.d/jumptotech-db` from the runbook §1.2 (add
`BACKUP_COPY_HOOK=…` once D7 is decided). Then a restore beside production:
`scripts/db-restore.sh --into jumptotech_labs_check_<date> <archive>` and
[postgres-backup-restore.md §6.3](../runbooks/postgres-backup-restore.md) (it
creates a separate database; it does not touch production's).

**17. Verify public and private exposure.**
```bash
make private-beta-smoke ARGS="--public-ip <public-ip> --report-dir /srv/jumptotech/evidence"
```
Then from a machine **outside** the host's network:
```bash
nc -zv -w3 <public-ip> 80 443            # open
nc -zv -w3 <public-ip> 3001 4000 4001 4002 5432 9090 9093 9400 9401 9402 16443   # all refused/filtered
npm run tls:check -- --origin https://<host> --expect-acme                        # from a checkout there; exit 0
```

**18. Verify authentication.** Sign in with a beta account (succeeds). Sign in
with a non-beta account (refused by the provider). Sign out; the old cookie is
refused (`/auth/session` → `authenticated:false`).

**19. Test student session.** As a beta account: start LINUX-001, run `whoami`
and a file write in the terminal, Check Solution (incomplete, then solve and
PASS), Reset, End. Repeat quickly for K8S-001 and DOCKER-001. Afterwards
`q 'sum(jtt_sessions_active)'` is 0.

**20. Terminal/runtime.** `ready terminal 9401`, `ready sandboxd 9402`; smoke
`runtime.provider-*` all PASS (AWS is INFO by design).

**21. Verification.** Step 19's Check results; `VerificationSlow` not firing.

**22. Observability.** `ssh -L 3001:127.0.0.1:3001 jtt-ops@<host>`, sign in to
Grafana, open **JTT — Private Beta Operations**; smoke `observability.*` PASS.

**23. Alerts.** §12.1 drill (after D6). Until then this step is **blocked**.

**24. Backup verified.** Smoke `backup.recent` PASS; `backup.offhost` PASS
(after D7 — **blocked** until then).

**25. Restart and recovery.** §17 drills, before students.

**26. Record evidence.** Fill the checklist (§20) from the files in
`/srv/jumptotech/evidence`. The deployment is not "done" until every row has a
result.

## 16. Smoke test procedure

```bash
make private-beta-smoke ARGS="--public-ip <public-ip> --report-dir /srv/jumptotech/evidence"
# before DNS is live:  ARGS="--connect <public-ip> ..."
```

Run after every start, restart, upgrade and incident. It is read-only (it never
signs in, starts, stops or restarts anything) and reads only `PUBLIC_ORIGIN` from
`.env`.

| Group | Automated checks |
|---|---|
| stack | every service running; healthy where it has a health check; Docker restart count; restart policy |
| readiness | api, terminal, sandboxd `/readyz` |
| runtime | labs loaded; PostgreSQL progress store durable; `maxActive` 5; each provider available (AWS informational) |
| database | `pg_isready` |
| public edge | HTTPS 200 with a trusted chain; HSTS; `http://` → 301 same path; `tls:check --expect-acme` |
| authentication | `/auth/config` oidc + sign-in available; `/api/me`, `/api/labs`, `/api/sessions` → 401; `Authorization: Developer` and `x-dev-student-id` → 401; `/auth/login` → 302 to the provider |
| private paths | `/internal/…` not routed; `/metrics`, `/readyz`, `/health` not routed |
| exposure | only 443/80/loopback Grafana published; postgres on internal networks only; optional `--public-ip` probe of forbidden ports from the host |
| observability | all targets up; firing alerts named; Alertmanager and Grafana answer; deployed limits 5/1; attestation valid; certificate days left |
| backups | last backup ≤ 24 h; verification ≤ 8 d; off-host copy recorded |
| MANUAL CHECK REQUIRED | external port scan; restore beside production; student flow; admission refusal; alert delivery; Grafana through the tunnel |

## 17. Recovery procedure and drills

Behaviour on `main` today, from the runbooks. Run each drill **before students
are invited**, with no sessions active, and re-run the smoke afterwards. None
deletes data.

| Drill | Command | Expected | Evidence on main |
|---|---|---|---|
| api restart | `prod restart api` | sessions survive (durable in PostgreSQL); in-flight requests fail; reaper resumes | PROVEN LOCALLY (five-student gate phase "api-restart recovery") |
| terminal restart | `prod restart terminal` | every open shell drops; students reload; sessions intact | runbook [§6](../runbooks/private-beta-operations.md); NOT PROVEN on a host |
| sandboxd restart | `prod restart sandboxd` | every container-track shell drops; sandboxes remain; Kubernetes labs unaffected | [RB-01 §3](../runbooks/RB-01-service-down.md); NOT PROVEN on a host |
| web restart | `prod restart web` | site gone for seconds; certificate gate re-runs | runbook §6; NOT PROVEN on a host |
| postgres restart | `prod restart postgres` | api not ready until postgres healthy, then recovers | runbook §6; NOT PROVEN on a host |
| monitoring restart | `prod restart prometheus alertmanager grafana` | nothing student-visible | runbook §6 |
| interrupted Reset/End | restart api mid-Reset | reaper: ENDING resumed at 5 min; RESETTING → DEGRADED at 10 min | PROVEN IN CI (P0-007 suites); [RB-17](../runbooks/RB-17-session-lifecycle.md) |
| Docker daemon restart | `sudo systemctl restart docker` (maintenance window only) | **on `main`, no service has a restart policy: the platform stays down** until `prod up -d`. Record whether the kind node container came back (`docker inspect -f '{{.State.Status}} {{.HostConfig.RestartPolicy.Name}}' jumptotech-labs-control-plane`) and whether `kubectl get nodes` is Ready | NOT PROVEN |
| host reboot | `sudo reboot` (maintenance window only) | as above, plus: Docker starts at boot? kind node Ready? attestation still valid (same cluster UID)? | NOT PROVEN |
| backup verify | `make db-backup-verify FILE=<newest>` | checksum and read-back OK | PROVEN IN CI |
| restore beside production | `scripts/db-restore.sh --into <name> <archive>` | new database, validated; production untouched | PROVEN IN CI |
| restore over production | [postgres-backup-restore.md §6.4](../runbooks/postgres-backup-restore.md) (`--replace` renames, never drops) | **only in a real recovery or a dedicated rehearsal host** | PROVEN IN CI; never on a host |

Recovery after a daemon restart or reboot on `main`:
```bash
cd /srv/jumptotech-labs
kind get clusters && KUBECONFIG=infrastructure/kind/generated/kubeconfig-host-jumptotech-labs.yaml kubectl get nodes
docker start jumptotech-labs-control-plane     # only if the kind node is stopped
prod up -d --wait --wait-timeout 900
make private-beta-smoke ARGS="--report-dir /srv/jumptotech/evidence"
```
A restart policy for the production overlays is being added on another branch
(`feat/beta-overnight-hardening`); once merged, the preflight's
`durability.restart-policy` WARN becomes a PASS and the drills above must be
re-run to record the new behaviour.

**Never** `prod down -v` (it deletes the PostgreSQL volume). `prod down` keeps
volumes; take a backup first anyway.

## 18. Security findings

| # | Finding | Severity for a public host | Action |
|---|---|---|---|
| S1 | **Scrape token unreadable by Prometheus on Linux** (`make observability-token` wrote `0600`, operator-owned; Prometheus is uid 65534). Every target down on a real host; hidden by Docker Desktop | High (monitoring blind; every `ServiceDown` fires) | **Fixed**: `0644` file in a `0711` directory; `services/observability/test/production-host-contract.test.ts` pins it; preflight `observability.scrape-token-mode`; README corrected. Reproduced and fix verified with `prom/prometheus:v2.54.1` under Linux ownership |
| S2 | **OIDC admits any account the issuer authenticates** | **Blocker** with a public identity provider (anyone gets a privileged DinD sandbox) | Documented (§8); REQUIRES EXTERNAL DECISION; smoke/preflight MANUAL checks. Not implemented here: the mechanism is provider-specific and authentication.md §4.7 leaves it open |
| S3 | `MAX_ACTIVE_SESSIONS` defaults to **20** in compose; the proven contract is 5 | Medium (capacity never validated above 5) | `production:config-check` and smoke FAIL unless 5/1 |
| S4 | `DOCKER_SOCKET_GID` defaults to `0`; on a Linux host sandboxd cannot use the socket | Medium (six tracks unavailable) | preflight FAIL on mismatch |
| S5 | kind kubeconfigs are `0644` (cluster-admin) and the scrape token is `0644`, by necessity; the kind API server listens on `127.0.0.1:16443` | Medium on a multi-user host; low on a dedicated one | Recommend a dedicated operator-only host and checkout `0750`; preflight `checkout.mode` |
| S6 | A checkout made under `umask 077` makes every bind-mounted config unreadable (labs, Prometheus, Grafana, nginx) | Availability | preflight `checkout.bind-mounts` |
| S7 | Docker-published ports bypass host `INPUT` firewall rules | High if relied on | procedure §15 step 2; smoke external scan (MANUAL) |
| S8 | `.env` holds every secret | High if readable | preflight FAIL unless no group/other bits |
| S9 | Backups unencrypted and on the same host | High (data loss / exposure) | REQUIRES EXTERNAL DECISION; smoke FAIL until an off-host copy is recorded |
| S10 | No restart policy on `main` | Availability after reboot | WARN; fixed on another branch; drill §17 |
| S11 | Known, unchanged: shared uid 1001 lets one container/Kubernetes-track student read another's per-session credential; privileged DinD; plaintext on the internal database bridge; Grafana login page reachable from other containers; terminal not `read_only` | Accepted for trusted students only (release gate §6) | none here |
| S12 | Pod-to-node traffic (kubelet 10250, metadata) is not governed by NetworkPolicy on kind | Medium on a cloud host with an instance metadata service | host firewall / IMDS hardening, P0-015 D3 |

Reviewed and unchanged: only sandboxd holds the Docker socket; no compose service
is privileged or on the host network; production refuses development auth,
plaintext origins, insecure cookies, waived attestation, placeholder/short/shared
secrets and plaintext broker transport off-host (all proven by the self-test
against the real merge). No change in this branch broadens a privilege.

## 19. External decisions required

| # | Decision | Blocks |
|---|---|---|
| D1 | **Identity provider** and tenant | §15 step 6, sign-in |
| D2 | **Hosting provider, host, and Kubernetes substrate** (kind on the host, or another) + CNI | everything; P0-015 D1/D2 |
| D3 | **Who may sign in**, and how the provider enforces it | inviting anyone (S2) |
| D4 | **Public hostname and DNS provider** | TLS, OIDC redirect |
| D5 | **CA and ACME client**, renewal scheduler | TLS |
| D6 | **Alert destination and on-call** | alert delivery (§12.1) |
| D7 | **Off-host backup destination, encryption, retention, restore rights** | DR (§11) |
| D8 | **Acceptance thresholds** for start/Check latency and host headroom at five students | declaring capacity acceptable (§13) |
| D9 | Where `.env` and the TLS key are recoverable from | host replacement |
| D10 | Operator access path (SSH keys, bastion) and who holds `docker` | operations |
| D11 | Attestation re-probe cadence (7-day max age) | Kubernetes labs after a week |
| D12 | Metric/log retention; external uptime check; host exporter | operations |
| D13 | Federated logout and idle timeout | sign-out behaviour |
| D14 | IPv6, HSTS preload, CAA | DNS/TLS |

## 20. Production-host evidence checklist

Copy [production-host-evidence-template.md](../releases/production-host-evidence-template.md)
into `/srv/jumptotech/evidence/` for each deployment and fill every row with a
**result from that host** and the file that proves it. A row copied from this
document, from CI or from a laptop is not evidence.

## 21. Rollback procedure

| Situation | Rollback |
|---|---|
| Configuration change broke startup | restore the previous `.env` (keep `cp -p .env .env.previous` before editing; both `0600`), then `prod up -d --wait`; preflight |
| Certificate renewal refused | `tls-install.sh` changes nothing when it refuses and rolls back itself ([production-tls.md §4.3](../runbooks/production-tls.md)) |
| New release misbehaves, **no new migration** | `git checkout <previous commit>`, `npm ci`, `prod up -d --build --wait`; preflight and smoke |
| New release applied a migration | migrations are forward-only. Take `scripts/db-backup.sh --label pre-upgrade` **before** every upgrade; to roll back, check out the previous commit and restore that archive per [postgres-backup-restore.md §6.4](../runbooks/postgres-backup-restore.md) (renames, never drops; its own rollback is §6.6) |
| Security incident / stop everything | `prod stop web` takes the site down; running labs are reclaimed by idle expiry. [private-beta-operations.md §3](../runbooks/private-beta-operations.md) |
| Stop launches only | there is no switch; tell the cohort; `MAX_ACTIVE_SESSIONS=1` reduces launches (runbook §3) |

Never `prod down -v`, never `docker volume rm` a `jumptotech-labs-*` volume, and
never edit `lab_sessions` by hand.

## 22. Remaining blockers

Before students are invited to a production host, all of these must be closed and
recorded in §20:

1. **D3 — admission restricted to the beta students** (S2). Software blocker in
   the absence of a provider-side restriction.
2. **D2 — a host exists**, and preflight, smoke and the five-student host
   validation (§13 A and B) pass **on it**.
3. **D7 — off-host backup copy with encryption**, and one restore proven from it.
4. **D6 — alert destination**, and the §12.1 drill received by a person.
5. **D4/D5 — hostname, DNS and a real certificate**; external `tls:check` exit 0.
6. **D8 — capacity acceptance** from the §13 measurements.
7. `make beta-validate` re-run on the exact commit being deployed (release-gate
   evidence is from `c8eb2c6`).
8. Recovery after a Docker restart and a reboot drilled and recorded (§17), with
   or without the restart-policy change from the other branch.

Not blockers for five **trusted** students (release gate §6), and blockers for any
untrusted cohort: the shared-uid credential read; privileged DinD.
