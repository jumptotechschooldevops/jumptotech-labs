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
