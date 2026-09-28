# Private-beta deployment runbook: one host, five students

The ordered, copy-paste procedure for putting JumpToTech Labs in front of five
beta students on one Linux host. It collects what is spread across
[production-host-readiness.md](../development/production-host-readiness.md) (the
authority for each step's detail), [private-beta-operations.md](private-beta-operations.md),
[production-tls.md](production-tls.md), [postgres-backup-restore.md](postgres-backup-restore.md),
[disaster-recovery.md](disaster-recovery.md), [five-student-beta-validation.md](five-student-beta-validation.md)
and [capacity-probes.md](../development/capacity-probes.md). Every command
here exists in the repository at the commit this page was written against
(`ac1b775`); where a value is a decision the repository cannot make, it says
**EXTERNAL** and names the decision (D1–D15, production-host-readiness §19).

Placeholders: `<host>` the public host name, `<public-ip>` its address,
`<commit>` the release commit, `<owner>` the runtime owner id.

**Nothing on this page has been run on a production host.** No host exists yet.
The deployment tooling's own self-tests pass at `ac1b775`:
`production:config-check --self-test`, `make secrets-check`,
`scripts/test-production-host-scripts.sh` (58 cases), `scripts/test-db-backup-restore.sh`
(168), `scripts/test-private-beta-diagnostics.sh`.

---

## 0. READY IN CODE vs MUST BE CONFIGURED EXTERNALLY

| READY IN CODE (the repository enforces or provides it) | MUST BE CONFIGURED EXTERNALLY (a person, a provider or a purchase) |
|---|---|
| Production fails closed: OIDC only, no development auth or student header, https origin, Secure cookie, strong distinct secrets, TLS edge refuses to start without a valid certificate (`production:config-check --self-test` PASS) | **D2** the host itself: purchase, OS install, SSH access |
| Exactly 443 and 80 published; postgres, api, terminal, sandboxd, metrics unpublished; monitoring on loopback (`make secrets-check`, config check `exposure.*`) | **Firewall** in front of the host: only 80, 443 and operator SSH (Docker-published ports bypass ufw/firewalld `INPUT`) |
| Capacity contract 5 / 1 refused otherwise (`capacity.beta-contract`); attach race closed | **D1/D3** identity provider, client registration, **restriction to the five accounts**, sign-up off |
| Ownership labels, owner-scoped reaper, orphan cleanup, NetworkPolicy + attestation gate, PodSecurity | **D4** host name and DNS `A` record; **D5** certificate authority, ACME client, renewal schedule |
| Backup, verify, restore (`--verify-only`, `--into`, `--replace`), drill; refuses a re-created empty database; production refuses a newer schema (#80) | **D6** alert destination (webhook) and the person who receives it |
| 61 alert rules with runbooks; indicators and objectives ([beta-slo-indicators.md](../beta-slo-indicators.md)) | **D7** off-host backup destination, encryption key held off the host, retention, who may restore |
| Preflight, config check, smoke, diagnostics, beta-validate, capacity probes, recovery drills | **D8** accepting the host's capacity measurements; **D9** where `.env` and the TLS key are recoverable from; **D10** who holds SSH and `docker` |
| Lab access entitlements (`ACCESS_POLICY=entitlement` by default in production) and `ops access` | Granting the five students access after they first sign in (an operator action, §3.3) |

---

## 1. Host specification

### 1.1 Required (enforced or proven by the repository)

| Item | Requirement | Source |
|---|---|---|
| OS | Linux, amd64. CI proves `ubuntu-latest` (Ubuntu 24.04 LTS); arm64 builds but is not CI-proven | production-host-readiness §5.1 |
| Docker | Docker Engine, **rootful**, socket at exactly `/var/run/docker.sock`, enabled at boot (`systemctl is-enabled docker`) | §5.1; drill D-7 |
| Compose | Docker Compose v2 with `!reset` / `!override` support (v2.24.4 or later); `make production-config-check` renders the files and fails on an older one | §5.1 |
| kind / kubectl | kind **v0.31.0**, kubectl **v1.34.2**, node image `kindest/node:v1.34.0` (preflight WARNs on others) | `production-preflight.sh`, `infrastructure/kind/cluster.yaml` |
| Node.js | 22 (`.nvmrc`), then `npm ci` | preflight `tools.node` |
| Tools | git, openssl, curl, jq, iproute2 (`ss`), coreutils `timeout`, `dig`, `nc` | §5.1, §15 step 18 |
| Clock | NTP-synchronized (OIDC tolerates 5 s of skew) | §8.1 |
| Ports | 80 and 443 free on the host | preflight |
| Egress | Docker Hub, `registry.npmjs.org`, `download.docker.com`, `dl.k8s.io`; the identity provider; the ACME CA; the backup and alert destinations | §7.1 |
| Accounts | a dedicated operator account `jtt-ops` in the `docker` group (root-equivalent); no other local accounts | §5.2, §15 step 1 |

### 1.2 Recommended sizing: an ESTIMATE, gated by measurement

The repository has **no** measured server sizing (production-host-readiness §5.3:
"UNKNOWN — MEASURE ON HOST"); deciding it is **D8**. The numbers below are
derived from the enforced per-session ceilings and the laptop measurements, not
from a server:

| Per student, at the lab's ceiling | CPU | Memory |
|---|---|---|
| Linux / networking / Terraform container | 0.5 | 512 MB |
| Ansible (control node + 2 managed nodes) | 1.5 | 1.5 GB |
| Docker track (DinD, `DOCKER_SANDBOX_CPUS/MEMORY`) | 2 | 2 GB |
| Kubernetes namespace quota | requests 2, limits 4 | requests 2 GiB, limits 4 GiB |
| Platform idle (api, terminal, sandboxd, web, postgres, monitoring) + kind node | — | ~0.7 GiB + ~0.7 GiB (laptop) |

| | vCPU | RAM | Disk | Swap |
|---|---|---|---|---|
| **Recommended** | **16** | **32 GiB** | **200 GB SSD** (Docker data root, kind node, DinD stores, 15 d Prometheus, PostgreSQL, 14 d local backups) | 4 GiB, `vm.swappiness=10`, as an OOM cushion only |
| Floor (only if §5.4 passes on it with the labs you will teach) | 8 | 16 GiB | 100 GB SSD | same |

Five Kubernetes labs at quota request 10 CPU / 10 GiB, which the recommended
host schedules with room for the platform; the floor does not if all five are
Kubernetes labs at once. The repository configures no swap and has not proven
kind's behaviour with it: drill D-7 (reboot) must show the node `Ready`. Sandbox
disk is **unbounded** (capacity report §33), so watch `HostDiskSpaceLow`.

**Expected capacity for five concurrent students:** the control plane is
measured fine to 50 students; on a saturated development VM 19 of 20 Starts
succeeded (the failure was a connection reset a student retries). The
acceptance test is §5.4 on this host: **PASS with CPU pressure (`psi.some`)
well under ~20 % during the Start burst** ([performance-capacity-certification-2026-09-27.md](../releases/performance-capacity-certification-2026-09-27.md) §27, §34).
Keep `MAX_ACTIVE_SESSIONS=5`, `MAX_ACTIVE_SESSIONS_PER_STUDENT=1`, and co-host
nothing else on the beta host.

### 1.3 Filesystem

| Path | Owner / mode | Holds |
|---|---|---|
| `/srv/jumptotech-labs` | `jtt-ops`, `0750` | checkout, `.env` (`0600`), TLS key (`0600`), kind kubeconfigs |
| `/srv/jumptotech/backups/postgres` | `jtt-ops`, `0700` | `BACKUP_DIR`; ideally a different disk from Docker's data root |
| `/srv/jumptotech/backups/status` | `jtt-ops`, `0755` | `BACKUP_STATUS_DIR`; created **before** the stack starts |
| `/srv/jumptotech/evidence` | `jtt-ops`, `0700` | preflight, smoke, capacity, drill outputs; never a secret |
| `/var/log/jumptotech` | `jtt-ops` | cron logs |

---

## 2. External services and configuration

### 2.1 Network

| Port | From | Purpose |
|---|---|---|
| TCP 443 | wherever students are | the whole application: `/` web, `/api/` and `/auth/` api, `/terminal` WebSocket (upgraded over the same TLS; no separate host) |
| TCP 80 | anywhere, if ACME HTTP-01 is chosen | 301 to https; ACME challenge only |
| TCP 22 | operator addresses only | administration; Grafana via `ssh -L 3001:127.0.0.1:3001` |
| everything else | nowhere | filter in the provider firewall or `DOCKER-USER` |

### 2.2 DNS (D4)

One record: `<host>  A  <public-ip>` (`AAAA` only if the host really serves IPv6
on 80 and 443). Optional `CAA` naming the chosen CA. There is no separate API or
terminal host name. Confirm from another network: `dig +short <host>`.

### 2.3 Identity provider (D1, D3)

Register **one dedicated confidential client** for this deployment:

| Setting | Value |
|---|---|
| Grant | authorization code with PKCE `S256`; implicit and hybrid off |
| Token endpoint auth | `client_secret_post` |
| Redirect URI | exactly `https://<host>/auth/callback` (lower case, no port, no trailing slash) |
| Post-logout redirect | `https://<host>` |
| Scopes | `openid profile email` (no `offline_access`) |
| ID token signing | asymmetric (RS/PS/ES 256–512 or EdDSA), never HS256 |
| Issuer | `OIDC_ISSUER` must equal the discovery document's `issuer` byte for byte |
| API audience | a **dedicated** identifier for `OIDC_AUDIENCE`, not the client id; only this client may obtain tokens for it (D15) |

**Restriction to exactly five accounts: REQUIRED, and only possible at the
provider.** The api provisions every account the provider authenticates as a
`STUDENT`; it has no allowlist. Configure one of: user/application assignment
required with only the five users assigned; a dedicated tenant or realm with
only those users; an invite-only directory. Disable self-service sign-up.
Prove it (§5.7): a sixth, non-beta account is refused **at the provider**.

**Roles:** none to configure. Every student is `STUDENT`; roles change only in
the database and nothing in the beta needs another. Operators use the `ops`
socket, which needs `docker exec`, not a role.

### 2.4 TLS (D5)

A certificate for `<host>` from a public CA, chain included; key generated on
the host, mode `0600`. ACME HTTP-01 (standalone for the first issuance, webroot
afterwards) or an operator-supplied certificate: [production-tls.md §3](production-tls.md).
Renewal must run on a schedule with `scripts/tls-install.sh` as the deploy hook
(§4 there). Open terminal WebSockets survive a renewal (graceful reload).

### 2.5 Alerts (D6)

A webhook destination for Alertmanager and a named person who receives it:
`infrastructure/observability/alertmanager/secrets/README.md`. And an external
check-in (heartbeat) service for the always-firing `Watchdog`: its URL goes in
`alertmanager/secrets/heartbeat-url`, and it must tell that person when the
check-ins stop, because a dead host, Docker daemon, Prometheus or Alertmanager
sends no alert of its own ([RB-20](RB-20-watchdog.md)).

### 2.6 Off-host encrypted backup (D7)

A destination, an encryption key or recipient held **off the host**, retention,
and the people who may restore. The repository provides the seam:
`BACKUP_COPY_HOOK` = the absolute path of an executable you write that copies
**both** files, verifies the remote checksum, exits non-zero on failure, and
takes credentials from somewhere other than the backup directory. Encrypt
before or during the copy (e.g. `age`/GPG to an off-host recipient, or
storage-side encryption with managed keys).

---

## 3. Secrets and configuration

### 3.1 Secrets: never committed, never in a shell history, `.env` is `0600`

| Name | Source | Receives it |
|---|---|---|
| `TERMINAL_SESSION_SECRET` | `make secrets` (32+ random) | api, terminal |
| `INTERNAL_SERVICE_SECRET` | `make secrets` | api, terminal |
| `NAMESPACE_DERIVATION_SECRET` | `make secrets`. **Changing it orphans every running sandbox**; keep it for the life of the deployment | api, sandboxd |
| `SANDBOXD_ATTACH_SECRET` | `make secrets` | terminal, sandboxd |
| `SANDBOXD_RUNTIME_SECRET` | `make secrets` | api, sandboxd |
| `SANDBOXD_DOCKER_SECRET` | `make secrets` | api, sandboxd |
| `POSTGRES_PASSWORD` | `make secrets`. Set only at the database's first start; changing it later needs a manual role change | postgres, api |
| `OBSERVABILITY_SCRAPE_TOKEN` | `make secrets`; then `make observability-token` writes Prometheus's copy | api, terminal, sandboxd, prometheus |
| `GRAFANA_ADMIN_PASSWORD` | `make secrets` | grafana |
| `OIDC_CLIENT_SECRET` | **EXTERNAL**: the identity provider (§2.3) | api |
| TLS private key | **EXTERNAL**: generated on the host (§2.4); `infrastructure/docker/nginx/tls/privkey.pem`, `0600` | web |
| Alert webhook URL | **EXTERNAL** (D6); `infrastructure/observability/alertmanager/secrets/webhook-url` | alertmanager |
| Heartbeat check-in URL | **EXTERNAL** (D6); `infrastructure/observability/alertmanager/secrets/heartbeat-url` | alertmanager |
| Backup hook credentials, encryption key | **EXTERNAL** (D7); never beside the archives or on the hook's command line | the backup job only |

Which service receives which secret is fixed by `infrastructure/secret-distribution.json`
and proven by `make secrets-check`. Keep a copy of `.env` and the TLS key where
D9 decides; nothing is recoverable from Git by design. What rotating or
regenerating each one does: [disaster-recovery.md §2](disaster-recovery.md).

### 3.2 Settings that `make secrets` does not write

| Name | Value for the beta | Notes |
|---|---|---|
| `PUBLIC_ORIGIN` | `https://<host>` | lower case, no port, no path; not an IP, not `localhost` |
| `ALLOWED_ORIGINS` | `https://<host>` | anything else is trusted with signed-in responses (config check WARN) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_AUDIENCE` | from §2.3 | `OIDC_REDIRECT_URI` optional; if set, exactly `https://<host>/auth/callback` |
| `RUNTIME_OWNER_ID` | a short id used by nothing else on this Docker daemon, e.g. `jtt-beta` | labels every sandbox; the reaper only touches its own. Keep it for the life of the deployment |
| `MAX_ACTIVE_SESSIONS` | `5` | the compose default 20 is refused |
| `MAX_ACTIVE_SESSIONS_PER_STUDENT` | `1` | |
| `BACKUP_STATUS_DIR` | `/srv/jumptotech/backups/status` | same path in `.env` and the cron jobs |
| `DOCKER_SOCKET_GID` | output of `stat -c %g /var/run/docker.sock` | |
| `JTT_COMMIT` | `git rev-parse HEAD` | the smoke's `release.commit` compares it |
| `JTT_VERSION` | the release label | |
| `ACCESS_POLICY` | leave empty (production default: `entitlement`) | `open` lets every provider account start labs |
| `DATABASE_ALLOW_NEWER_SCHEMA` | **leave unset** | §7.3 |
| `LAB_LAUNCHES_PAUSED` | `false` | the stop-launches switch (§8) |

Never set: `AUTH_MODE=development`, `DEV_STUDENT_HEADER_ENABLED=true`, an
`AUTH_COOKIE_NAME` starting `__Host-`, `ALLOWED_ORIGINS` with anything but
`PUBLIC_ORIGIN`. The production overlay pins `NODE_ENV=production`,
`AUTH_MODE=oidc` and `WEB_TLS=required`; `.env` cannot undo them.

### 3.3 Proving nothing is missing

```bash
cd /srv/jumptotech-labs
make secrets-check                 # each service gets exactly its secrets and ports
make production-config-check       # 0 FAIL: loaders accept the environment; gates on
make production-preflight ARGS="--backup-dir /srv/jumptotech/backups/postgres --report /srv/jumptotech/evidence/preflight-$(date -u +%Y%m%dT%H%M%SZ).txt"
```

The preflight parses `.env` as data and prints each secret as `NAME: present` or
`MISSING` (never a value). It FAILs on any missing name in the §3.1/§3.2 lists,
a `.env` not `0600`, a shell export shadowing `.env`, or a `DOCKER_SOCKET_GID`
that does not match the socket.

---

## 4. Exact deployment sequence

Stop at the first FAIL. Run as `jtt-ops` unless `sudo` is shown. Define the
helpers first in every shell ([private-beta-operations.md §1](private-beta-operations.md)):

```bash
cd /srv/jumptotech-labs
prod() { docker compose -f docker-compose.yml -f docker-compose.runtime.yml -f docker-compose.observability.yml -f docker-compose.production.yml -f docker-compose.production-observability.yml --profile observability "$@"; }
q() { prod exec -T prometheus promtool query instant http://127.0.0.1:9090 "$1"; }
ready() { prod exec -T "$1" node -e "fetch('http://127.0.0.1:$2/readyz').then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1) })"; }
alerts() { prod exec -T alertmanager amtool alert query --alertmanager.url=http://127.0.0.1:9093; }
ops() { prod exec -T api node /app/node_modules/.bin/tsx apps/api/src/operator-cli.ts "$@"; }
```

**A. Fresh host → dependencies**

1. Install Docker Engine (rootful) with the Compose plugin, Node 22, kind v0.31.0, kubectl v1.34.2 and the §1.1 tools; `sudo systemctl enable --now docker`; enable NTP.
2. `sudo useradd -m jtt-ops && sudo usermod -aG docker jtt-ops`; log in again as `jtt-ops`.
3. Firewall (§2.1) at the provider or in `DOCKER-USER`. **EXTERNAL.**

**B. Repository**

4. Clone the release and install:
   ```bash
   sudo install -d -m 0750 -o jtt-ops -g jtt-ops /srv/jumptotech-labs
   umask 022
   git clone https://github.com/jumptotechschooldevops/jumptotech-labs.git /srv/jumptotech-labs
   cd /srv/jumptotech-labs && git checkout <commit> && git rev-parse HEAD && npm ci
   ```
5. Layout:
   ```bash
   sudo install -d -m 0700 -o jtt-ops -g jtt-ops /srv/jumptotech/backups/postgres /srv/jumptotech/evidence
   sudo install -d -m 0755 -o jtt-ops -g jtt-ops /srv/jumptotech/backups/status /var/log/jumptotech
   ```

**C. Configuration**

6. `make secrets` (creates `.env` `0600`; prints no secret). Edit `.env` for §3.2, with `DOCKER_SOCKET_GID=$(stat -c %g /var/run/docker.sock)` and `JTT_COMMIT=$(git rev-parse HEAD)`. `cp -p .env .env.previous`.
7. Identity provider client (§2.3) and the `OIDC_*` values. **EXTERNAL.**

**D. Runtime**

8. `npm run cluster:up`: must report `seccompDefault is on`.
9. `make sandbox-build && docker pull docker:27-dind`.

**E. TLS**

10. DNS `A` record (§2.2), then `dig +short <host>` from another network. **EXTERNAL.**
11. First certificate ([production-tls.md §3.1 or §3.2](production-tls.md)), then:
    ```bash
    make tls-install CERT=/path/to/fullchain.pem KEY=/path/to/privkey.pem
    ```
12. `make observability-token`; install the alert destination if D6 is decided.

**F. NetworkPolicy attestation for exactly this `.env`**

13. ```bash
    npm run -s production:config-check -- --print-network-env > /srv/jumptotech/evidence/network-contract.env
    KUBECONFIG=infrastructure/kind/generated/kubeconfig-host-jumptotech-labs.yaml \
      env $(cat /srv/jumptotech/evidence/network-contract.env) \
      npm run verify:network-policy -- --write-attestation --json /srv/jumptotech/evidence/network-probe.json
    ```
    `VERDICT: PASS` required.

**G. Preflight**

14. §3.3: `make secrets-check`, `make production-config-check` (0 FAIL), `make production-preflight …` (`RESULT: PASS`).

**H. Synthetic five-student gate: before the production stack ever starts**

15. §5.3 (a second checkout and stack, then removed). Afterwards **repeat steps 13–14**: the gate rewrote the cluster's attestation for its own `.env`.

**I. Application and database**

16. Start; migrations run inside the api at start (forward-only, one transaction each):
    ```bash
    prod up -d --build --wait --wait-timeout 900
    prod ps
    ready api 9400 && ready terminal 9401 && ready sandboxd 9402
    ops status          # slots: 0 of 5 held, new labs: YES
    ```
17. First backup, verification, schedule (§6.1–§6.2).

**J. Beta validation on the production stack**

18. Smoke (§5.1), external checks (§5.2), identity (§5.7), access grants (§5.8), one student flow per track (§5.9), alert drill (§8.3), off-host copy and restore (§6.3), recovery drills (§5.6), rehearsal (§5.5), evidence template.

---

## 5. Exact validation commands

| Purpose | Authoritative command | Pass |
|---|---|---|
| Configuration gates | `make production-config-check` | 0 FAIL |
| Secret distribution | `make secrets-check` | "every service receives exactly…" |
| Host preflight | `make production-preflight ARGS="--backup-dir /srv/jumptotech/backups/postgres --report /srv/jumptotech/evidence/preflight-<ts>.txt"` | `RESULT: PASS` |
| NetworkPolicy enforcement (security) | `npm run verify:network-policy -- --write-attestation …` (step 13) | `VERDICT: PASS` |
| Production smoke | `make private-beta-smoke ARGS="--public-ip <public-ip> --report-dir /srv/jumptotech/evidence"` | every line PASS; `backup.offhost` may FAIL only until D7 |
| Five-student synthetic gate | `make beta-validate ARGS="--report-dir /srv/jumptotech/evidence/beta-validate"` (validation checkout, §5.3) | `RESULT: PASS` |
| Classroom capacity | `npm run capacity:control-plane` then `npm run capacity:classroom -- … --students 5 --extra-students 1` (§5.4) | `verdict: PASS`, PSI well under ~20 % |
| Host sampling | `make host-capacity-sample ARGS="--out-dir … --interval 15 --duration … --kubeconfig infrastructure/kind/generated/kubeconfig-host-jumptotech-labs.yaml"` | no OOM kill; peaks recorded |
| Five-person rehearsal | production-host-readiness §13.2, rows R0–R14 | every row as expected |
| TLS | `npm run tls:check -- --origin https://<host> --cert-dir infrastructure/docker/nginx/tls --expect-acme` | exit 0 |
| Cleanup | after End: `ops status` → `0 of 5 held`; `docker ps --filter label=jumptotech.io/managed=true --filter label=jumptotech.io/runtime-owner=<owner>` and `KUBECONFIG=infrastructure/kind/generated/kubeconfig-host-jumptotech-labs.yaml kubectl get ns -l jumptotech.io/managed=true` empty; `q 'jtt:reaper_seconds_since_success'` < 300 | all empty |
| Security unit gates (CI already runs them; optional on the host) | `npm run test:security` | 0 failed |
| Diagnostics bundle (for an incident) | `make private-beta-diagnostics` | — |

### 5.1 Smoke

```bash
make private-beta-smoke ARGS="--public-ip <public-ip> --report-dir /srv/jumptotech/evidence"
# before DNS is live: ARGS="--connect <public-ip> --report-dir /srv/jumptotech/evidence"
```

Read-only. Checks readiness, durable PostgreSQL, `maxActive` 5, providers,
Prometheus targets, attestation, certificate days, backup age and off-host
copy, `release.commit`, exposure (only 443/80/loopback Grafana; no other
container publishing), HTTPS/HSTS/redirect, `/auth/login` → provider, protected
routes 401, internal routes unrouted.

### 5.2 From another network

```bash
nc -zv -w3 <public-ip> 80 443                                                   # open
nc -zv -w3 <public-ip> 3001 4000 4001 4002 5432 9090 9093 9400 9401 9402 16443  # every one must fail
npm run tls:check -- --origin https://<host> --expect-acme                      # exit 0
```

### 5.3 Synthetic five-student gate (production-host-readiness §13.1)

Before `prod up`. A second checkout at the same commit:

```bash
git clone https://github.com/jumptotechschooldevops/jumptotech-labs.git /srv/jumptotech-validation
cd /srv/jumptotech-validation && git checkout <commit> && npm ci && make secrets
```

In **its** `.env`:

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

Then [five-student-beta-validation.md §1](five-student-beta-validation.md) steps 1–5
there (attestation for that `.env`, `make observability-token`, the validation
stack up), and:

```bash
# production checkout, second shell:
make host-capacity-sample ARGS="--out-dir /srv/jumptotech/evidence/capacity-synthetic --interval 15 --duration 2400 --kubeconfig infrastructure/kind/generated/kubeconfig-host-jumptotech-labs.yaml"
# validation checkout:
make beta-validate ARGS="--report-dir /srv/jumptotech/evidence/beta-validate"
# stop the sampler (Ctrl-C); then, from the validation checkout, without -v:
docker compose -f docker-compose.yml -f docker-compose.runtime.yml -f docker-compose.observability.yml -f docker-compose.production-observability.yml --profile observability down
docker volume ls --filter name=jtt-hostval      # remove only these, by exact name, after reading the list
```

Never run it while the production stack is up: both stacks join the `kind`
network and resolve each other's `api` and `terminal`.

### 5.4 Classroom capacity ([capacity-probes.md §2–§3](../development/capacity-probes.md))

Also before the production stack starts, or with no students:

```bash
npm run capacity:control-plane
E2E_PROJECT=jtt-cap E2E_WEB_PORT=33720 E2E_API_PORT=34720 E2E_TERMINAL_PORT=34721 \
E2E_POSTGRES_PORT=55720 E2E_OIDC_PORT=39720 bash e2e/stack.sh up
npm run capacity:classroom -- --web http://127.0.0.1:33720 --oidc http://127.0.0.1:39720 \
  --owner jtt-cap --project jtt-cap --students 5 --extra-students 1 \
  --labs <the five labs you will teach, e.g. LINUX-001,LINUX-005,NET-006,CS-005,NET-007> \
  > /srv/jumptotech/evidence/classroom.json
E2E_PROJECT=jtt-cap E2E_WEB_PORT=33720 E2E_API_PORT=34720 E2E_TERMINAL_PORT=34721 \
E2E_POSTGRES_PORT=55720 E2E_OIDC_PORT=39720 bash e2e/stack.sh down
```

PASS: 5 / 5 Starts, 5 / 5 terminals, the sixth refused cleanly, nothing left
after End, `host.psi` during the burst well under ~20 %.

### 5.5 Five-person rehearsal

production-host-readiness §13.2, rows R0–R14, on the production stack, five
trusted testers with their own beta accounts, one lab each (LINUX-001,
DOCKER-001, K8S-001, ANSIBLE-001, TF-001), while
`make host-capacity-sample ARGS="--out-dir /srv/jumptotech/evidence/capacity-rehearsal --interval 15 --duration 3600 --kubeconfig infrastructure/kind/generated/kubeconfig-host-jumptotech-labs.yaml"` runs.

### 5.6 Recovery drills (no students)

production-host-readiness §17.2, D-1…D-7 (`prod restart api|terminal|sandboxd|web|postgres`,
`sudo systemctl restart docker`, `sudo reboot`), capturing before/after state;
the smoke must be unchanged after each.

### 5.7 Identity

A beta account signs in and lands on the catalogue; a **non-beta account is
refused at the provider**; sign-out invalidates the cookie.

### 5.8 Grant the five students lab access

Each student signs in once (they see "Your account does not have lab access
yet"). Then, per student ([commercial-access.md §6](../commercial-access.md)):

```bash
ops access find --email <student-email>
ops access grant <user-id> --until <ISO-8601 with offset, e.g. 2026-12-31T23:59:59Z> --kind beta --by <operator> --reason "private beta cohort 1"
ops access show <user-id>          # ACTIVE, kind BETA
ops access list --state ACTIVE     # the five, each BETA
```

`--kind beta` labels them as beta participants in `ops access list` and in the
history; it changes nothing they may do. Nothing about who is in the beta lives
in source code or configuration: the grants are the list, and `ops access
revoke` removes one.
```

### 5.9 One real flow per track

LINUX-001, K8S-001, DOCKER-001: Start, terminal, Check, Reset, End; then
`ops status` returns to `0 of 5 held`.

---

## 6. Backup and restore drill

### 6.1 First backup and verification (step 17)

```bash
export BACKUP_DIR=/srv/jumptotech/backups/postgres BACKUP_STATUS_DIR=/srv/jumptotech/backups/status
scripts/db-backup.sh --label first-deploy            # prints the archive path
scripts/db-restore.sh --verify-only <archive>        # full read-back, changes nothing
```

### 6.2 Schedule

`/etc/cron.d/jumptotech-db`, in the host's time zone ([private-beta-operations.md §1.2](private-beta-operations.md)):

```cron
17 3 * * *  jtt-ops  cd /srv/jumptotech-labs && BACKUP_DIR=/srv/jumptotech/backups/postgres BACKUP_STATUS_DIR=/srv/jumptotech/backups/status scripts/db-backup.sh >>/var/log/jumptotech/db-backup.log 2>&1
17 5 * * 0  jtt-ops  cd /srv/jumptotech-labs && BACKUP_DIR=/srv/jumptotech/backups/postgres BACKUP_STATUS_DIR=/srv/jumptotech/backups/status scripts/db-restore.sh --verify-only "$(ls -1t /srv/jumptotech/backups/postgres/*.dump | head -1)" >>/var/log/jumptotech/db-verify.log 2>&1
```

Add `BACKUP_COPY_HOOK=/path/to/your-hook` to the backup line once D7 is
decided; its failure fails the run and `BackupLastRunFailed` fires.

### 6.3 The drill, before students and monthly during the beta

1. **Restore beside production** (creates a new database; changes nothing):
   ```bash
   scripts/db-restore.sh --into jumptotech_labs_check_$(date -u +%Y%m%d) <archive>
   prod exec postgres sh -c 'psql -U "$POSTGRES_USER" -d jumptotech_labs_check_<date>'
   ```
   ```sql
   SELECT max(started_at) FROM lab_attempts;   -- newest history: your real data loss
   SELECT count(*) FROM users; SELECT version FROM schema_migrations ORDER BY version;
   ```
   Then drop only that check database:
   `prod exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE jumptotech_labs_check_<date>"'`.
2. **From the off-host copy** (after D7): fetch and decrypt the archive and its
   `.sha256` onto the host, `scripts/db-restore.sh --verify-only`, then step 1
   with it. Smoke `backup.offhost` must PASS.
3. **Whole code path on disposable servers** (Docker only; touches nothing of
   production): `make db-restore-drill`. It must print `RESTORE DRILL PASSED`.
4. Record timings in [disaster-recovery-drill-evidence-template.md](../releases/disaster-recovery-drill-evidence-template.md).

A real production recovery (`--replace`, which renames and never drops) is
[postgres-backup-restore.md §6.4](postgres-backup-restore.md): stop the api,
back up first, `scripts/db-restore.sh --replace jumptotech_labs <archive>`, start
the api, validate (§6.5 there); the swap's own rollback is §6.6.

---

## 7. Rollback procedure

### 7.1 Before every upgrade (production-host-readiness §21.1)

No students active.

```bash
git rev-parse HEAD > previous-commit
cp -p .env .env.previous
make private-beta-smoke ARGS="--report-dir /srv/jumptotech/evidence/upgrade-<new>/before"
git fetch origin
git diff --name-only HEAD <new> -- services/progress/migrations .env.example 'docker-compose*.yml' infrastructure/docker
export BACKUP_DIR=/srv/jumptotech/backups/postgres BACKUP_STATUS_DIR=/srv/jumptotech/backups/status
scripts/db-backup.sh --label pre-migration        # always, migration or not
scripts/db-restore.sh --verify-only <printed archive>
git checkout <new> && npm ci
# set JTT_COMMIT=$(git rev-parse HEAD) in .env; make sandbox-build if a sandbox Dockerfile changed
make production-config-check && make production-preflight ARGS="…"
prod up -d --build --wait --wait-timeout 900      # non-zero exit = failed deployment → §7.2
make private-beta-smoke ARGS="--report-dir /srv/jumptotech/evidence/upgrade-<new>/after"
```

A migration file in the `git diff` output means the database changes shape at
the next api start, and the only way back is §7.2 B.

### 7.2 Roll back

**A. The new release shipped no migration:**

```bash
git checkout "$(cat previous-commit)" && npm ci
cp -p .env.previous .env                          # restores the previous JTT_COMMIT
prod up -d --build --wait --wait-timeout 900
make production-preflight ARGS="…"
make private-beta-smoke ARGS="--report-dir /srv/jumptotech/evidence/rollback"   # release.commit PASS on the previous commit
```

**B. The new release applied a migration: restore, do not bypass.**
The previous api **refuses to start** on the migrated database and names the
versions it does not ship (`prod logs api`); with `restart: unless-stopped` it
keeps retrying. That refusal (#80) is the rollback boundary. The rollback is:

1. Announce maintenance: work written since the `pre-migration` backup is lost.
2. `git checkout "$(cat previous-commit)" && npm ci`; `cp -p .env.previous .env`.
3. `prod stop api`.
4. `scripts/db-backup.sh --label pre-restore` (keeps the newer data too).
5. `scripts/db-restore.sh --verify-only <pre-migration archive>`, then
   `scripts/db-restore.sh --replace jumptotech_labs <pre-migration archive>` (type the name to confirm).
6. `prod up -d --build --wait --wait-timeout 900`; the previous api starts on
   its own schema. Validate ([postgres-backup-restore.md §6.5](postgres-backup-restore.md)), then the smoke.
7. If the restore itself must be undone: the command `--replace` printed (§6.6 there).

**C. Other cases:** a configuration change that broke startup: restore
`.env.previous`, `prod up -d --wait`, preflight. A refused certificate
renewal: `tls-install.sh` changed nothing and rolled itself back. A security
incident: `prod stop web`. Stop launches only: `LAB_LAUNCHES_PAUSED=true` in
`.env`, `prod up -d api`.

### 7.3 `DATABASE_ALLOW_NEWER_SCHEMA`

What it does: under `NODE_ENV=production` the api refuses a database whose
migration ledger records a version this release does not ship; setting it to
`true` makes the api start anyway (with a warning), running older code against
a schema that code was never tested with. `npm run db:migrate` refuses the same
unless it is `true`.

**It is not a rollback strategy. Leave it unset.** Use it only when **all** of these hold:

- the §7.2 B restore is impossible or unacceptable (no usable `pre-migration`
  archive, or losing the data written since would be worse);
- someone has read every migration the older code does not ship and judged the
  older code safe on it (every migration to date, 001–006, is additive: new
  tables, columns, indexes, one backfill, a widened `CHECK`, and no drop);
- it is recorded as an incident decision, with who decided and why.

Then remove it the moment code and schema match again. **Never** use it when:
the restore route is available; the unknown migration drops, renames or
rewrites anything; the refusal was unexpected (a wrong checkout, a wrong
database, or a restored archive from another deployment are what it catches);
or to get a failed upgrade to "just start".

---

## 8. Monitoring and alerts

Prometheus scrapes every service over the private scrape token; Alertmanager
routes to the D6 webhook; Grafana at `http://127.0.0.1:3001` through
`ssh -L 3001:127.0.0.1:3001 jtt-ops@<host>` (dashboard *JTT — Private Beta
Operations*). Container logs are JSON, rotated 10 MB × 5 per service, read with
`prod logs --since 30m <service>`. The indicators and their objectives:
[beta-slo-indicators.md](../beta-slo-indicators.md). Every alert links its
runbook ([runbooks/README.md](README.md)).

### 8.1 The alerts the beta depends on

| Concern | Alert (severity) | Threshold | Runbook |
|---|---|---|---|
| Disk | `HostDiskSpaceLow` (warning) / `HostDiskSpaceCritical` (critical) | < 15 % / < 8 % free | RB-19 |
| Memory | `HostMemoryPressure` (warning) / `HostMemoryCritical` (critical) | < 10 % / < 5 % available | RB-19 |
| CPU | `HostCpuSaturated` (warning) | load5 per CPU > 2 for 15 m | RB-19 |
| Lab starts | `LabStartFailureRateElevated` (warning) / `LabStartsFailingHard` (critical) | ≥ 2 and > 10 % / ≥ 3 and > 30 % per 10 m | RB-03 |
| Capacity | `CapacityNearExhausted` (warning) / `CapacityExhausted` (critical) | > 85 % / any refusal | RB-04 |
| Cleanup | `ReaperStalled` (critical), `ReaperSweepErrorsPersisting`, `ReaperDeleteFailures`, `SandboxLeakSuspected`, `OrphansPersisting` (warning) | no successful sweep in 300 s; errors for 15 m | RB-05 (reasons in `reaper.sweep.failed` log lines) |
| Stuck sessions | `SessionStuckProvisioning`, `SessionResetStuck`, `SessionTeardownStuck`, `SessionDegradedNotReclaimed` | 10 / 15 / 20 / 40 min | RB-17 |
| Database | `DatabaseDown` (critical), `DatabasePoolSaturated` (warning), `ProgressStoreIsMemory` (critical) | `jtt_db_up == 0` for 1 m | RB-02 |
| TLS | `TlsCertificateRenewalDue` (warning), `TlsCertificateExpiresWithin7Days` (critical), `TlsEdgeUnhealthy` (critical) | < 21 d / < 7 d | RB-15 |
| Backups | `BackupStale`, `BackupMissedTwice` (critical), `BackupLastRunFailed`, `BackupVerifyFailed`, `BackupNeverSucceeded` | > 26 h / > 50 h | RB-16 |
| Services | `ServiceDown`, `ServiceNotReady` (critical), `ServiceRestartLoop` | 2–3 m | RB-01 |
| Runtime | `SandboxdRuntimeDown` (critical), `ProviderUnavailable` | 2 m / 5 m | RB-06, RB-09 |
| Isolation | `NetworkIsolationNotAttested` (critical), `NetworkIsolationAttestationAging` | attestation invalid / 75 % of 7 d | RB-18 |
| The alerting itself | `AlertNotificationsFailing`, `AlertmanagerUnreachable` | 5 m | private-beta-operations.md |

### 8.2 Also on a schedule

- TLS from outside the host, every 6 h ([production-tls.md §5.1](production-tls.md)):
  `npm run --silent tls:check -- --origin https://<host> --cert-dir infrastructure/docker/nginx/tls`.
- The NetworkPolicy attestation expires after 7 days: re-run step 13 before
  then (cadence D11; `NetworkIsolationAttestationAging` warns at 75 %).

### 8.3 Alert delivery drill (after D6)

```bash
prod kill -s HUP alertmanager
prod exec -T prometheus wget -qO- http://127.0.0.1:9090/api/v1/alertmanagers    # 127.0.0.1:9093 active
end=$(date -u -d '+10 minutes' +%Y-%m-%dT%H:%M:%SZ)
prod exec -T alertmanager amtool alert add alertname=JttAlertDeliveryDrill severity=warning service=drill \
  --annotation=summary="Delivery drill - no action required" --end="$end" --alertmanager.url=http://127.0.0.1:9093
```

A named person confirms receipt and the resolved notice.

---

## 9. Five-student go-live checklist

Tick every line on the day, in order, with the evidence in `/srv/jumptotech/evidence/`.

**External**
- [ ] Host sized per §1.2 and D8 recorded; nothing else runs on it (no other stack, kind cluster or debug container).
- [ ] Firewall admits only 80, 443 and operator SSH; the §5.2 scan from another network shows every other port closed.
- [ ] `dig +short <host>` from another network returns `<public-ip>`.
- [ ] Certificate from a public CA installed; renewal scheduled with the `tls-install.sh` hook; external `tls:check --expect-acme` exits 0.
- [ ] OIDC client registered per §2.3; **exactly the five beta accounts** can sign in; self-sign-up off; a non-beta account refused at the provider.
- [ ] Alert destination installed; §8.3 drill received by a named person.
- [ ] Off-host, encrypted backup copy configured (`BACKUP_COPY_HOOK`); one archive restored from that copy (§6.3 step 2).
- [ ] `.env`, `.env.previous` and the TLS key stored where D9 decides; operator access recorded (D10).

**On the host**
- [ ] `make production-config-check`: 0 FAIL.
- [ ] `make production-preflight …`: `RESULT: PASS`.
- [ ] Attestation `VERDICT: PASS` for this `.env`, written **after** any synthetic run.
- [ ] `make beta-validate` (§5.3): `RESULT: PASS`, and the validation stack removed.
- [ ] `capacity:classroom --students 5 --extra-students 1` (§5.4): PASS, PSI during the burst well under ~20 %, no OOM kill in `host.csv`.
- [ ] `prod up -d --build --wait` exit 0; all services healthy; `ops status` 0 of 5, new labs YES.
- [ ] `make private-beta-smoke`: every line PASS, including `backup.offhost` and `release.commit`.
- [ ] First backup, `--verify-only`, `--into` check database validated and dropped; cron installed.
- [ ] Recovery drills D-1…D-7: smoke unchanged after each; kind node Ready after the reboot.
- [ ] Rehearsal R0–R14 complete; `alerts` shows nothing firing.
- [ ] One LINUX-001, K8S-001 and DOCKER-001 flow: Start, terminal, Check, Reset, End; cleanup empty (§5 cleanup row).
- [ ] The five students have signed in once and been granted access (§5.8); `ops access show` ACTIVE for each.
- [ ] `LAB_LAUNCHES_PAUSED=false`; `MAX_ACTIVE_SESSIONS=5`; `MAX_ACTIVE_SESSIONS_PER_STUDENT=1`; `DATABASE_ALLOW_NEWER_SCHEMA` unset.
- [ ] Evidence template filled ([production-host-evidence-template.md](../releases/production-host-evidence-template.md)).

## 10. STOP conditions: do not invite students if any is true

1. Any FAIL in `make production-config-check`, `make production-preflight` or `make private-beta-smoke` (the one exception, `backup.offhost`, is itself stop condition 5).
2. A non-beta account can obtain a session: the provider does not restrict sign-in to the five, or `ACCESS_POLICY=open` is set.
3. Any port other than 80/443 (and SSH from operator addresses) is reachable from another network, or the smoke reports another container publishing beyond loopback.
4. The attestation is not `VERDICT: PASS` for the running `.env`, or `NetworkIsolationNotAttested` is firing.
5. No verified backup exists off the host, or a restore from that copy has not been done once.
6. No person has received the §8.3 drill alert.
7. `make beta-validate` or `capacity:classroom` failed on this host, OOM kills appear in the sampler, or CPU pressure during a five-student burst is near saturation.
8. The certificate is not from a publicly trusted CA, or expires in under 21 days with no renewal scheduled.
9. `DATABASE_ALLOW_NEWER_SCHEMA=true` is set, or the api reports a schema it does not ship.
10. A recovery drill left the platform degraded (a service not healthy, the kind node not Ready, row counts changed).
11. Any critical alert is firing (`alerts`), or `ops status` shows a slot held with no student active.
12. The deployed commit is not the one the evidence was gathered on (`release.commit` not PASS).

## 11. Remaining manual actions for the owner

1. Buy and provision the host (§1.2); install the OS; set the provider firewall (§2.1).
2. Choose `<host>`; create the DNS `A` record (§2.2).
3. Choose the CA and ACME client; issue the first certificate; schedule renewal (§2.4).
4. Choose the identity provider; register the client; restrict it to the five accounts; turn off sign-up; give `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_AUDIENCE` to the operator (§2.3).
5. Choose the alert destination and the on-call person (§2.5).
6. Choose the off-host backup destination, encryption key custody, retention and restore rights; write `BACKUP_COPY_HOOK` (§2.6).
7. Decide where `.env` and the TLS key are recoverable from, and who holds SSH and `docker` (D9, D10).
8. Accept or reject the host's capacity measurements (D8).
9. Collect the five students' email addresses; after each first sign-in, run the §5.8 grant.

Known limits the beta runs with (not stop conditions): one host and no
failover; a Start or Reset in flight during an api restart holds that student's
slot for up to 10 minutes (deploy with no students active); the terminal token
outlives sign-out for up to an hour; the shared terminal uid is being changed
by another workstream.
