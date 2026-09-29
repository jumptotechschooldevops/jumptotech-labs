# Final integration and launch-readiness pass — 2026-09-28

| | |
|---|---|
| **Base** | `origin/main` at `74ea285` (#154, the last merge before this pass) |
| **Date** | 2026-09-28 |
| **Audience** | five **trusted** private-beta students, then paying customers |
| **5-student beta verdict** | **GO in code — NOT YET GO to invite students.** No class-A code defect was found. What remains is the class-B work in §5.B, all of it host configuration or a first run on the real Linux host, which nothing in this repository can prove. |
| **Paid-launch verdict** | **NO-GO.** No real billing provider exists. The class-D items in §5.D are open. |

This pass reconciles every earlier launch, security, reliability, capacity,
student-experience and lab-certification report against the code on
`74ea285`. It does not trust their verdicts. A claim a report makes that the
code no longer supports is called **stale** below. A claim that can only be
proven on the beta host is called **UNVERIFIED** and stays that way until the
host exists.

Classes used throughout:

- **A**: must fix before the 5-student private beta.
- **B**: must configure or prove on the real beta host.
- **C**: acceptable for a trusted 5-student beta.
- **D**: must fix before taking public paying customers.
- **E**: nice to have.

---

## 1. What is on `origin/main` (`74ea285`)

Since the last dated gate (§16 of [private-beta-release-gate.md](private-beta-release-gate.md)),
main has taken #62–#162. By area:

| Area | Merged |
|---|---|
| Per-session shell uids (SEC-ARCH-2) | #117, #123, #125. Migration 007. |
| Docker/Kubernetes isolation | #86, #89, #96, #115, #116, #119, #121, #122, #124 |
| App-layer authorization and rate limits | #75, #79, #82, #85 |
| Session lifecycle, recovery and the reaper | #63, #69, #129 (session events, migration 008), #147 (in-flight handed to the reaper on SIGTERM), #159 (stopped container → DEGRADED) |
| Database, backup and restore | #72, #80, #126, #157 |
| Observability | #84, #88, #130 (Watchdog → heartbeat), #148, #158 |
| Instructor and admin | #134 (classroom API), #135 (classroom UI and Support ID), #137 (`ops role`), #146 (instructor guide) |
| Student experience | #138–#144, #150, #153 |
| Labs | #65–#81, #93–#111 (catalog sweeps), #143 |
| Commercial | #136 (plans, trials and kinds; migration 009), #154 (billing provider boundary, test provider only; migration 010) |
| Production deployment | #127, #131, #133, #151, #152 |
| Reports | #100, #106, #112, #161, #162 |

CI on `74ea285` (Quality gates run 36419866411): all 12 jobs passed. The jobs
are gates, terminal-integration, docker-integration, networking-integration,
tls-edge-integration, sandbox-integration, catalog-runtime, kind-integration,
browser-ux, browser-e2e, sandboxd-integration and postgres-integration. CodeQL
also passed.

## 2. Open product PRs

| PR | What | State found | Done in this pass | State at the end of the pass |
|---|---|---|---|---|
| #145 | Instructor and admin run a class of five in real browsers (test only, +244) | CLEAN, green, but tested against an older main (`af2f47b`) | Merged current main into it; CI re-ran | Merge it: test only, and the only browser proof of the classroom workflow |
| #155 | Account page: access, plan, subscription, test-mode checkout | CLEAN, 15/15 green on `74ea285` | Reviewed. No defect for the beta. The billing routes take the account from the session only, keep the same CSRF/origin guard, allow no open redirect, and are inert while `BILLING_PROVIDER` is unset. `test` is refused in production. | Ready. **Merge was blocked for the agent** (auto-mode classifier); the owner merges |
| #156 | `ops billing list/show/reconcile`, billing alerts, RB-22 | `gates` red. Based on an old #155 head, and 15 files conflicted with main. | (1) Fixed the red check: the promtool expectation differed between Prometheus 2.54 (production/CI: 15) and 3.x (16); it is now evaluated where both agree. (2) Merged #155's head, so it retargets to main cleanly after #155. (3) Fixed two defects, each with a regression test: `reconcile --apply` discarded `--by`/`--reason`, so the history recorded the provider as the actor; and it stamped snapshots with the apply time, which let a stale snapshot override a later real cancellation webhook. (4) Updated billing.md. | Mergeable into #155 once CI is green; after #155 merges, retarget to `main` |
| #163 | **New**: the rollback guidance said migrations 001–007 are additive; 010 is not safe for older code (§5.A) | — | Opened, with a regression test | Merge it |

Dependabot PRs (#5–#7, #46–#49, #59) were not touched, as instructed.

The four new billing alerts evaluate to an empty vector while the billing
series do not exist. With billing off, which is how the beta runs, they never
fire, so #156 is safe to deploy to the beta host.

## 3. Tests executed in this pass

On this Mac, on `74ea285`, as the `gates` CI job runs them. No runtime stress
suite was started; host load was 11–17 on 10 CPUs.

| Command | Result |
|---|---|
| `npm ci` | ok |
| `npm run typecheck` | PASS |
| `npm run validate:labs` | PASS (117 labs) |
| `npm run production:config-check -- --self-test` | PASS |
| `node scripts/check-secret-distribution.mjs` | PASS |
| `bash scripts/test-production-host-scripts.sh` | PASS |
| `bash scripts/test-private-beta-diagnostics.sh` | PASS |
| `bash scripts/test-db-backup-restore.sh` | PASS |
| `bash scripts/check-observability.sh` | PASS |
| `npm test` | 3 failed of ~8,600: `apps/api/test/catalog-api.test.ts`, each `Test timed out in 5000ms` while the Mac's load average was 65–77. Run alone twice: **33/33 both times**. CI passed the same file on `74ea285`. Recorded as load, not a defect (earlier passes saw the same file time out under load). |
| `npm run build` | PASS |
| Every alert test file under promtool 3.9.1 **and** `prom/prometheus:v2.54.1` (on #156) | 13/13 files pass on both |
| `apps/api` billing suites (on #156) | 56/56 |
| `services/progress` (on #163) | 121 passed, 2 skipped (database-only); mutation check: reverting the 010 sentence fails the new test |

Runtime evidence comes from CI: `74ea285` passed every runtime job listed in
§1. No runtime result from this Mac is used as evidence, because this machine
is shared with five kind clusters from other worktrees.

## 4. Launch-readiness matrix

"Proven where" separates evidence from GitHub's CI runners, from this Mac, and
from the beta host. The beta host has proven nothing yet, because it does not
exist.

| # | Area | State on `74ea285` | Proven where | Open residuals (class) |
|---|---|---|---|---|
| 1 | Authentication / OIDC | Fail-closed OIDC: exact issuer, audience, asymmetric algorithms, PKCE. Production refuses dev auth and non-https origins. | CI (unit, E2E with a loopback IdP) | **No sign-in allow-list**: the IdP decides who signs in (B: restrict the client to the five). Set `OIDC_AUDIENCE` ≠ client id (B). No `__Host-` cookies (C/D). No idle timeout; 12 h absolute (C/D). Terminal token outlives sign-out by ≤ 1 h (C). |
| 2 | Authorization, tenant isolation | One policy function. A non-owner gets 404, not 403. INSTRUCTOR is read-only; ADMIN can read and end. `/internal` is not routed by nginx, and dot segments are refused. | CI (#85 adversarial suite) | No hint rate limit (C). A revoked shell stays open until idle expiry (C). The sandboxd attach secret is service-wide (C/D). |
| 3 | Per-session terminal uid | Each shell runs under its own uid from a PostgreSQL sequence, with ambient capabilities cleared. Production refuses to start if the setup is misconfigured. | CI (`terminal-integration`, 13/13) | **N1**: 328 MB of tmpfs is charged to the terminal's 512 MB cgroup, so one student filling their home can OOM every shell (C; **B**: measure; D: fix). `/tmp` is shared 1777 (C). A shared pid limit of 256 (C/D). |
| 4 | Sandbox security | Drop ALL capabilities, non-root, no-new-privileges, memory = memory+swap, pids limit, 1 MB logs, `none`/`--internal` networks, default seccomp. sandboxd alone holds the socket. | CI | Docker-track DinD is `--privileged` and the student holds its client certificate, which amounts to host root (C, trusted students only; **D**). Sandbox disk is unbounded (B: disk + alerts; D). **N2**: DinD container logs are unbounded (B: `daemon.json`). |
| 5 | Docker/Kubernetes isolation | NetworkPolicy + attestation (required in production), 5 VAPs, PSA baseline, `seccompDefault`, object and ephemeral quotas | CI (`kind-integration`) | Probe must PASS on the host kernel (B). Sandbox → host listeners such as sshd (B). IMDS reachable if the host is a cloud VM (B). PVC size not enforced (C/D). Production CNI/substrate decision (D). |
| 6 | Session cleanup / recovery | Reaper: orphans, abandoned CREATING/ENDING, RESETTING→DEGRADED, stopped container→DEGRADED (#159), in-flight handoff (#147) | CI | NET-007: End frees the slot before the peer container and network are confirmed gone; the reaper collects them in about 2 min (C). A lone peer container is never swept (D). |
| 7 | 117-lab certification | All 117 present (linux 17, kubernetes 19, docker 14, cs 13, terraform 13, aws 11, ansible 10, cicd 10, networking 10). Every lab is solved by some suite. | CI on `74ea285`: catalog-runtime 81/81, docker sweep 15/15, k8s sweep 21/21, networking 23 tests | Still applicable (§6). Workspace-graded Docker labs run through the real terminal as a per-session uid only in the terminal isolation suite (B: walk DOCKER-004 on the host). |
| 8 | Browser E2E | Two Playwright suites, both blocking on every PR and on main | CI | No production overlay, real IdP or non-Linux track in a browser (B, via the rehearsal). Classroom E2E is in #145 (E beta, D paid). |
| 9 | Instructor classroom | Classroom API and UI, Support ID, session history (008), instructor guide | CI (unit; E2E in #145) | No cohort model: an instructor sees every student (C/D). An instructor cannot end a stuck lab (C, by design). |
| 10 | Admin workflow | `ops role`, `ops access`, admin End in the browser | CI | Anyone with host `docker` is effectively admin (B: D10). Role changes are only logged, not stored as DB audit rows (C/D). No account delete, and no sign-out everywhere (D). |
| 11 | Student workflow | Sign in, catalog, start/resume, 1 lab each, Check/Reset/End, `ACCESS_NOT_ACTIVE` before a slot is used | CI; this Mac (UX suite, earlier passes) | G1 host capacity (B). G2 broker ECONNRESET under saturation has no retry (B observe, D fix). G4–G6 (E/D). |
| 12 | Billing | Test provider only; production refuses it; off unless `BILLING_PROVIDER` is set | CI | **No real provider** (D). #156 residuals: the "already subscribed" guard, one unmapped price aborts a run, the 1000-subscription cap (D). |
| 13 | Plans / trials / entitlements | `ACCESS_POLICY=entitlement` by default in production; `ops access grant/trial/suspend/restore/revoke`; plans | CI | The five must sign in once and then be granted access (B). Expiry does not end a running lab (C/D). |
| 14 | Account / billing UI | Not on main; #155 | CI on #155 | C for a free beta; D for paid |
| 15 | Observability / alerts | 64+ rules, each with a runbook; Watchdog → heartbeat; SLO indicators | CI (promtool, amtool) | **No receiver is configured**. `webhook-url` and `heartbeat-url` are absent, and preflight reports them as MANUAL rather than FAIL (**B**, beta blocker). |
| 16 | Backups / restore | backup, verify, `--into`, `--replace` (renames); refuses a re-created database; staleness alerts; CI drill | CI (27 KB drill), this Mac (RTO 344–416 s under load) | **No cron and no off-host copy until configured** (**B**, blocker). No real-host drill (**B**). No PITR or HA (D). |
| 17 | Production configuration | `production-config-check` contract; secret gate; production pins; #151 `.env.example` fix | CI + this Mac (self-test) | `.env` hand-filled (B). Treat the WARNs as FAILs: `ACCESS_POLICY=open`, edge probe off, audience = client id, extra origins (B). |
| 18 | TLS / DNS | nginx TLS gate refuses IPs and bad certificates; `tls-install.sh` validates and rolls back; expiry alerts | CI (`tls-edge-integration`, test CA) | Real DNS name, public CA, renewal timer with the deploy hook (**B**). No nginx `limit_req` (C/D). |
| 19 | Capacity (5 concurrent) | Contract 5 total / 1 per student is enforced (preflight FAILs anything else). Control plane measured fine to 50. | This Mac only, saturated: INCONCLUSIVE (19/20 Starts). Kubernetes NOT RUN. | `capacity:classroom --students 5 --extra-students 1` and `beta-validate` on the host (**B**). Size memory for the tracks you teach: five Docker-track labs = 10 GiB (B). No `mem_limit` on api/postgres/web (C/D). |
| 20 | Deployment / rollback | Build from source on the host; rollback = checkout + rebuild; the schema boundary refuses a newer database | Documented; never run on a host | First real upgrade and rollback (**B**). **Rollback guidance across 010 was wrong: fixed in #163 (A, doc)**. No immutable images (C/D). |
| 21 | Incident recovery | RB-01…RB-22, incident management, A–U playbook, diagnostics bundle with a redaction gate | CI (contract tests) | Drill timings only from the laptop (B). No test ties runbook `ops` verbs to the parser (E). |
| 22 | Release process | quality-gates (12 jobs) + CodeQL on every PR and push | GitHub | **`main` is unprotected**: the protection API returns 404 and there are no rulesets. Direct pushes and red merges are possible (**B**, do it now; D). No release artefact, SBOM or signing (D). |

## 5. Findings

### A. MUST FIX before the 5-student private beta

| # | Finding | Status |
|---|---|---|
| A1 | `private-beta-deployment.md` §7.3, `production-host-readiness.md` §21.2 and `disaster-recovery.md` §4.2 said "every migration to date, 001–007, is additive" to justify rolling back with `DATABASE_ALLOW_NEWER_SCHEMA=true`. 010 re-keys `access_entitlements` to `(user_id, scope, granted_via)`. Every pre-010 access change is `ON CONFLICT (user_id, scope)`, so after that rollback every `ops access` change fails, including granting the beta students. | **Fixed in #163** (docs, plus a test that forces every future migration to be classified). Merge it. |

No class-A **code** defect was found on `74ea285`.

### B. MUST CONFIGURE / PROVE on the real beta host

Each of these is a stop condition for inviting students. The exact steps are in §7.

1. Host sized for the tracks you will teach (D2, D8), with nothing else on it.
2. Provider firewall: only 80, 443 and SSH from operator addresses (L5).
3. sshd key-only and bound to the public address, or dropped from Docker bridges; prove it from a sandbox (L6). On a cloud VM, block IMDS `169.254.169.254` from containers.
4. `/etc/docker/daemon.json` log rotation before any container starts (**N2**: DinD sandbox logs are otherwise unbounded).
5. DNS `A` record (D4); public-CA certificate with a scheduled renewal and `tls-install.sh` as the deploy hook (D5).
6. OIDC client restricted to exactly the five accounts, sign-up off (D1/D3); `OIDC_AUDIENCE` distinct from the client id.
7. Alert receivers `webhook-url` and `heartbeat-url` installed, and a named person who receives them (D6). The preflight only says MANUAL: treat it as FAIL.
8. Backup cron, `BACKUP_COPY_HOOK` to an encrypted off-host destination (D7), and one restore from that copy.
9. `.env`: `MAX_ACTIVE_SESSIONS=5`, `MAX_ACTIVE_SESSIONS_PER_STUDENT=1`, `ACCESS_POLICY` empty, no `BILLING_*`, `DATABASE_ALLOW_NEWER_SCHEMA` unset; every config-check WARN resolved.
10. A fresh kind cluster from `infrastructure/kind/cluster.yaml` (`seccompDefault`), and a NetworkPolicy attestation with `VERDICT: PASS` for this `.env`.
11. `make beta-validate` and `capacity:classroom --students 5 --extra-students 1` PASS on the host, with PSI well under ~20 %.
12. **N1 measured**: the terminal's memory peak during the rehearsal, plus the fill test in §7 step 25.
13. Recovery drills D-1…D-7, including a reboot.
14. The five students signed in once and granted `--kind beta`.
15. **Branch protection on `main`** with the 12 quality-gates checks and CodeQL required (§7 step 0). A GitHub setting, but it guards what gets deployed.

### C. ACCEPTABLE for a trusted 5-student beta

- Privileged DinD on the Docker track, which amounts to host root for a hostile student. Trusted cohort only. `DOCKER_TRACK_ENABLED=false` is the off switch.
- Anyone the IdP admits can browse the catalog and hints. Labs are gated by entitlement.
- A revoked student's open shell lives until idle expiry (`ops access revoke … --end-sessions --yes` ends it now).
- `/tmp` in the terminal is shared 1777; the terminal container has one shared pid limit.
- NET-007: the slot is freed about 2 min before the peer and network are reclaimed.
- Instructor is read-only and sees every student (no cohorts).
- Sign-out leaves the terminal token valid for up to 1 h; no idle timeout.
- Single host, no failover. Deploy with no students active: a bad release costs about 7 min.
- No nginx rate limits. The per-user budgets exist in the api.
- Images built on the host from the checked-out commit.

### D. MUST FIX before public paying customers

1. **A real billing provider** (Stripe or other). The prices, tax, receipts and dunning decisions, and one end-to-end run against the provider's sandbox. Today only the test simulator exists.
2. The #156 residuals: count every non-ended subscription in the "already subscribed" guard, and open checkouts too; make reconcile continue past one unmapped price; check accounts that have subscriptions but no billing row; page past 1000.
3. Merge #155 and #156, and put the classroom E2E (#145) into required CI.
4. **Sandbox isolation for untrusted users**: no privileged DinD (a VM or sandboxed runtime per sandbox, or keep the Docker track off). Disk quotas (XFS pquota, a capacity-enforcing provisioner). Terminal tmpfs per session, or its own memory budget (N1). A session-scoped sandboxd attach credential.
5. Sign-up policy for strangers: an allow-list or payment before lab use (entitlement already gates use). `__Host-` cookies. An idle timeout. Sign-out that revokes terminal tokens (`destroyAllForUser` has no caller).
6. Privacy and accounts: account deletion or anonymisation, data export, a DB audit row for role changes, operator identity that is not self-declared, cohorts/rosters for instructors, terms and privacy URLs (#155's `LEGAL_*_URL`).
7. Operations: point-in-time recovery or HA PostgreSQL; a restore-test-age signal; zero-downtime deploys; immutable tagged images with provenance and an SBOM; request-id correlation; an on-call rotation beyond one webhook.
8. Capacity beyond five: a retry or connection policy for broker `ECONNRESET` (G2); `mem_limit` on api/postgres/web; parallel reaper teardown; a real production Kubernetes substrate and CNI decision in place of kind.
9. Abuse controls: nginx `limit_req`/`limit_conn`; a hint rate limit; blocking the Docker-track bridge's egress to the host and internet unless a lab needs it.
10. Branch protection kept on, with required reviews.

### E. NICE TO HAVE

- Preflight should FAIL, not report MANUAL, on missing alert receivers in production.
- `check-observability.sh` should run the pinned promtool 2.54.1 rather than any local promtool. A local promtool 3 passed a test that CI's 2.54 failed. That is how #156 went red.
- Pass `--log-opt` for the DinD container in `cli-client.ts`, as #119 does for sandboxes.
- A lone `jtt-peer-*` container sweep; record `#removePeer` inspect errors as a failed step.
- A test tying runbook `ops` verbs to `parseArgs`.
- Stale documentation (none of it changes behaviour):
  - `observability.md` still says "webhook stub", with no Watchdog or RB-20;
  - `ci-and-release-gates.md` says "nine runtime jobs" (there are 11 runtime/browser jobs + gates);
  - `browser-e2e-private-beta.md` says "not yet run in CI";
  - `student-experience.md` has no `ACCESS_NOT_ACTIVE` or Support ID;
  - `.env.example` says `docker compose up -d api` where the runbooks use `prod up -d api`;
  - `policy.ts` links the missing `docs/authorization.md`;
  - billing.md §2 and `test-provider.ts` describe #155 routes not yet on main;
  - the lab-certification and reliability reports say End removes every peer and network (not quite; see C).

## 6. Lab certification: still applicable

The certification ([lab-certification-2026-09-27.md](lab-certification-2026-09-27.md))
was made on `eed2805`. It still applies on `74ea285` without a re-run:

- **Count.** 117 labs, no duplicate ids. By provider: linux 48, kubernetes 21, docker 15, terraform 13, ansible 10, cicd 10.
- **Every lab is solved by some CI suite.** catalog-runtime solves 76 of its 81 labs, and NET-004…008 are solved in their own networking suites. DOCKER-001 is solved in `docker-integration`, DOCKER-009…014 in their own suites, and the rest in the docker sweep. The k8s sweep solves all 21 of its labs.
- **The 49 commits since `eed2805`:**
  - #143 changed wording only: parsed-YAML comparison shows no setup, seed, workspace or check change.
  - The verifier source, the four sandbox Dockerfiles and the sweeps are unchanged, except a one-line kube-context change.
  - SEC-ARCH-2 moved Docker/Kubernetes-track shells to per-session uids 1,900,000,000+. The 81 container-track labs still run as `student` (1001) in their own sandbox.
- **Every sweep job passed on `74ea285` itself** (run 36419866411). The runner fails on skipped tests, so these are real passes.
- **Caveats, carried into §7:**
  1. The Docker/Kubernetes sweeps apply solutions directly, not through the real terminal as the per-session uid. That path is proven generically by the terminal isolation suite. Walk DOCKER-004 (workspace-graded) and K8S-001 in the browser on the host.
  2. #132 (DinD swap) is not exercised by a sweep.
  3. Production must use sandbox images rebuilt from the deployed commit (`make sandbox-build`).

## 7. REAL BETA HOST deployment checklist

This is the ordered condensation of
[private-beta-deployment.md](../runbooks/private-beta-deployment.md) (the
authority; section numbers below are its). It adds the steps this pass found
missing. Run as `jtt-ops` unless `sudo` is shown, and stop at the first
unexpected result. Placeholders: `<host>`, `<public-ip>`, `<commit>`. `<commit>`
is main after #163 (and #145/#155/#156 if merged) with a green Quality gates
run on that exact SHA.

**0. Before the host: the repository** (owner, on GitHub)

```bash
# Protect main: required checks = the 12 quality-gates jobs + CodeQL; no force-push; no deletion.
gh api -X PUT repos/jumptotechschooldevops/jumptotech-labs/branches/main/protection --input - <<'JSON'
{"required_status_checks":{"strict":true,"contexts":["gates","terminal-integration","docker-integration","networking-integration","tls-edge-integration","sandbox-integration","catalog-runtime","kind-integration","browser-ux","browser-e2e","sandboxd-integration","postgres-integration","Analyze (javascript-typescript)","Analyze (actions)"]},
 "enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null,"allow_force_pushes":false,"allow_deletions":false}
JSON
gh run list --branch main --limit 1 --json headSha,conclusion   # conclusion "success" for <commit>
```

Expected: the PUT returns the protection object; the latest main run is `success` on `<commit>`.
Rollback: `gh api -X DELETE repos/jumptotechschooldevops/jumptotech-labs/branches/main/protection`.

**A. Host (EXTERNAL, then commands)**

| # | Step | Command | Expected |
|---|---|---|---|
| 1 | Provision Ubuntu 24.04 amd64, **16 vCPU / 32 GiB / 200 GB SSD** recommended (§1.2); nothing else runs on it | provider console | SSH works with a key |
| 2 | Provider firewall: TCP 443 and 80 from anywhere, 22 from operator IPs only, everything else denied | provider console | — |
| 3 | Packages, Docker, Node 22, kind v0.31.0, kubectl v1.34.2 | runbook §4 step 1, verbatim | `docker version`, `node -v` (v22), `kind version` (v0.31.0), `kubectl version --client` (v1.34.2) |
| 4 | **Container log rotation (N2)**, before any container exists | `echo '{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}' \| sudo tee /etc/docker/daemon.json && sudo systemctl restart docker && docker info --format '{{.LoggingDriver}}'` | `json-file`. Rollback: remove the file and restart Docker. Containers created before this keep their old setting. |
| 5 | sshd hardening (L6) | set `PasswordAuthentication no` and `ListenAddress <public-ip>` in `/etc/ssh/sshd_config`, then `sudo sshd -t && sudo systemctl reload ssh` | `sshd -t` silent; `ss -Hltn \| grep ':22 '` shows only `<public-ip>:22`. Keep a second SSH session open while you change it. |
| 6 | NTP | `timedatectl show -p NTPSynchronized` | `NTPSynchronized=yes` |
| 7 | Operator account and layout | runbook §4 steps 2, 4, 5 (`useradd jtt-ops`, clone `<commit>`, `npm ci`, `/srv/jumptotech/...`) | `git rev-parse HEAD` = `<commit>`; `npm ci` exit 0 (needs `build-essential python3`) |

**B. External services** (§2)

| # | Step | Expected |
|---|---|---|
| 8 | DNS `A <host> → <public-ip>` | `dig +short <host>` from another network = `<public-ip>` |
| 9 | OIDC client per §2.3. **Only the five accounts assigned; sign-up off.** `OIDC_AUDIENCE` is a dedicated identifier, not the client id. | Proven in step 27 |
| 10 | Alert webhook + heartbeat check-in service (D6); a named person | the two URLs in hand |
| 11 | Off-host backup destination + encryption key held **off** the host; write `BACKUP_COPY_HOOK` (§2.6) | the hook exits non-zero when the copy fails |

**C. Configuration and runtime** (§3, §4 C–G)

| # | Step | Command | Expected |
|---|---|---|---|
| 12 | Secrets + `.env` | `make secrets`, then edit the §3.2 values: `PUBLIC_ORIGIN=ALLOWED_ORIGINS=https://<host>`, the `OIDC_*` values, `RUNTIME_OWNER_ID=jtt-beta`, `MAX_ACTIVE_SESSIONS=5`, `MAX_ACTIVE_SESSIONS_PER_STUDENT=1`, `BACKUP_STATUS_DIR`, `DOCKER_SOCKET_GID=$(stat -c %g /var/run/docker.sock)`, `JTT_COMMIT=$(git rev-parse HEAD)`, `JTT_VERSION`. **Leave empty:** `ACCESS_POLICY`, every `BILLING_*`, `DATABASE_ALLOW_NEWER_SCHEMA`. Then `cp -p .env .env.previous` | `stat -c %a .env` = `600` |
| 13 | Alert receivers | write the two URLs to `infrastructure/observability/alertmanager/secrets/webhook-url` and `heartbeat-url` (see the README there for the mode) | both files exist |
| 14 | kind cluster, **fresh** | `npm run cluster:up` | prints `seccompDefault is on` |
| 15 | Sandbox images from this commit | `make sandbox-build && docker pull docker:27-dind` | exit 0 |
| 16 | Certificate + install | `make tls-install CERT=… KEY=…`; schedule renewal with `scripts/tls-install.sh` as the deploy hook (production-tls.md §4) | `tls-install` proves the served certificate; `systemctl list-timers` shows the renewal |
| 17 | Scrape token | `make observability-token` | exit 0 |
| 18 | Attestation for this `.env` | runbook §4 step 13, verbatim | `VERDICT: PASS` |
| 19 | Gates | `make secrets-check && make production-config-check && make production-preflight ARGS="--backup-dir /srv/jumptotech/backups/postgres --report /srv/jumptotech/evidence/preflight-$(date -u +%Y%m%dT%H%M%SZ).txt"` | "every service receives exactly…"; **0 FAIL and 0 WARN** in the config check; `RESULT: PASS`. Every `MANUAL` line (alert receivers, cron) must be done by hand. |

**D. Prove the host before production starts** (§5.3, §5.4)

| # | Step | Expected |
|---|---|---|
| 20 | Synthetic five-student gate in a second checkout (§5.3), with `make host-capacity-sample` running | `RESULT: PASS`; no OOM in `host.csv`. Then bring that stack down (**without `-v`**) and remove only its `jtt-hostval` volumes by exact name. |
| 21 | `capacity:classroom --students 5 --extra-students 1` with **the five labs you will teach** (§5.4) | `verdict: PASS`; `host.psi` some ≪ 20 %; sixth refused `LAB_CAPACITY_REACHED`; nothing left after End |
| 22 | Repeat steps 18–19 (the gate rewrote the attestation for its own `.env`) | `VERDICT: PASS`; `RESULT: PASS` |

**E. Production start** (§4 I)

| # | Step | Command | Expected |
|---|---|---|---|
| 23 | Start | define `prod`, `q`, `ready`, `alerts`, `ops` (§4); `prod up -d --build --wait --wait-timeout 900 && prod ps` | exit 0; every service healthy |
| 24 | Readiness | `ready api 9400 && ready terminal 9401 && ready sandboxd 9402 && ops status` | three `200`s; `slots: 0 of 5 held`, `new labs: YES` |
| 25 | **N1 terminal memory, no students.** Open one LINUX-001 and one DOCKER-001 lab yourself. In the DOCKER-001 shell: `dd if=/dev/zero of=$HOME/fill bs=1M count=200; ls -l $HOME/fill`; on the host: `docker stats --no-stream $(prod ps -q terminal)`; then `rm $HOME/fill` | The other shell stays connected; MEM USAGE stays under ~80 % of 512 MiB. If the terminal restarts or passes 80 %: **STOP**. Raise the terminal `mem_limit` in a production override (for example `1g`), redeploy, repeat. |
| 26 | Smoke | `make private-beta-smoke ARGS="--public-ip <public-ip> --report-dir /srv/jumptotech/evidence"` | every line PASS, including `backup.offhost` (after step 28) and `release.commit` |
| 27 | From another network | `nc -zv -w3 <public-ip> 80 443` open; `nc -zv -w3 <public-ip> 3001 4000 4001 4002 5432 9090 9093 9400 9401 9402 16443` **all fail**; `npm run tls:check -- --origin https://<host> --expect-acme` exit 0; a **non-beta** account is refused **at the IdP** | as stated |
| 28 | Backup | §6.1 (`db-backup.sh --label first-deploy`, `--verify-only`), install the §6.2 cron **with `BACKUP_COPY_HOOK=`**, then the §6.3 drill including step 2 (restore from the off-host copy) | `RESTORE DRILL PASSED`; the `--into` check database shows the expected rows and is dropped; smoke `backup.offhost` PASS |
| 29 | Alert drill | §8.3 | the named person confirms receipt **and** the resolved notice; the heartbeat service shows check-ins |
| 30 | L6 from a sandbox | in a DOCKER-001 shell: `nc -zv -w3 "$(ip route \| awk '/default/ {print $3}')" 22` | fails (sshd bound to the public address) |
| 31 | IMDS (cloud VM only) | in a DOCKER-001 shell: `curl -m3 -s http://169.254.169.254/` | fails. If it answers: `sudo iptables -I DOCKER-USER -d 169.254.169.254 -j DROP`, persist it, and re-test. |
| 32 | Recovery drills D-1…D-7 (production-host-readiness §17.2), including `sudo reboot` | after each, the smoke is unchanged; after the reboot, `kubectl get nodes` is `Ready` and `ops status` is `0 of 5` |
| 33 | One flow per track you teach, in a browser: Start, terminal, Check, Reset, End. **Include DOCKER-004** (workspace-graded as the per-session uid) and K8S-001. | each passes; afterwards `ops status` = `0 of 5`, and the §5 cleanup row commands print nothing |
| 34 | Evidence | fill [production-host-evidence-template.md](production-host-evidence-template.md) and [disaster-recovery-drill-evidence-template.md](disaster-recovery-drill-evidence-template.md) | every row filled |

**Rollback** (§7). Before every upgrade, and with no students active, run §7.1:

```bash
git rev-parse HEAD > previous-commit
cp -p .env .env.previous
scripts/db-backup.sh --label pre-migration
```

Then:

- **No migration in `git diff --name-only HEAD <new> -- services/progress/migrations`:** §7.2 A.

  ```bash
  git checkout "$(cat previous-commit)" && npm ci
  cp -p .env.previous .env
  prod up -d --build --wait --wait-timeout 900
  ```

  Then the smoke (`release.commit` PASS on the previous commit).
- **A migration was applied:** §7.2 B. Restore the `pre-migration` archive with `scripts/db-restore.sh --replace` (it renames, and never drops). **Never** `DATABASE_ALLOW_NEWER_SCHEMA=true` across 010 (#163).
- **Sandbox images** are overwritten in place by `make sandbox-build`. Either set per-release `*_SANDBOX_IMAGE` tags (§7.1), or re-run `make sandbox-build` from the previous checkout.
- **Emergencies:**
  - stop new labs: `LAB_LAUNCHES_PAUSED=true` in `.env`, then `prod up -d api`;
  - security incident: `prod stop web`;
  - never `prod down -v`.

## 8. FIRST FIVE STUDENTS rehearsal checklist

Run this with **five trusted testers** (not the students) on the production
stack, after §7 is complete. It is production-host-readiness §13.2 (R0–R14)
plus this pass's additions. Record everything in `/srv/jumptotech/evidence/rehearsal/`.

| # | Who | Do | Expected |
|---|---|---|---|
| P1 | operator | Each tester signs in once, then `ops access find --email <e>`; `ops access grant <id> --until <ISO end of beta> --kind beta --by <you> --reason "rehearsal"`; `ops access list --state ACTIVE` | five ACTIVE BETA rows. Before the grant, the tester sees "does not have lab access yet". |
| P2 | operator | Give yourself INSTRUCTOR or ADMIN: `ops role set <your-id> ADMIN --by <you> --reason "beta operator"`; reload | the Classroom link appears; `#/classroom` shows `0 / 5` |
| R0 | operator | `ops status`; start `make host-capacity-sample … --duration 3600` | `0 of 5 held` |
| R1–R2 | five testers, within one minute | Sign in; Start the **five labs you will teach in week 1** (the default set is LINUX-001, DOCKER-001, K8S-001, ANSIBLE-001, TF-001) | five labs open; Classroom shows `5 / 5`, one per student, each with its Support ID |
| R3 | one tester | Open a second lab | `STUDENT_SESSION_LIMIT_REACHED` |
| R5 | all | `echo ready`, then one heavy step per track | output appears. Operator watches `docker stats $(prod ps -q terminal)`: **peak < 80 % of the limit (N1)**. |
| R6–R8 | pairs | Share lab URLs; `kubectl get ns`; `ps aux`; `docker ps` | only their own resources; the other's URL is refused |
| R9 | all | Check | verdict ≤ 10 s |
| R10 | all | Reset | fresh environment; the terminal reconnects |
| R11 | all | Reload mid-lab; close and reopen the tab | same lab resumes |
| P3 | operator (as ADMIN) | Find a tester by the Support ID they read out; End their lab from the Classroom page | confirmation names the student, lab and Support ID; result *Ended by staff*, cleanup confirmed |
| P4 | operator | `ops access suspend <id> --by <you> --reason "rehearsal" --end-sessions --yes`, then `ops access restore <id> --by <you> --reason "rehearsal"` | the tester is refused `ACCESS_NOT_ACTIVE`, then can start again |
| R12–R13 | all, then operator | End; the cleanup commands | `0 of 5 held`; `docker ps` and `kubectl get ns` filtered by the managed label are empty. A NET-007 network may take about 2 min (class C). |
| P5 | operator | `prod restart api` while one tester is in a lab | the terminal reconnects or the lab resumes after reload; `ops status` is consistent within one reaper sweep |
| R14 | operator | Stop the sampler; `alerts`; smoke | no stop-launches alert; smoke unchanged; sampler shows no OOM kill and PSI ≪ 20 % |
| P6 | operator | Grant the **real** five students (P1) only after every row passes, with `--until` = the end of the beta and `--reason "private beta cohort 1"` | five ACTIVE BETA rows for the students; revoke the testers (`ops access revoke`) unless they stay |

**Day-one stop conditions** are runbook §10, 1–12. Add these two:

- N1: the terminal's memory passed 80 % or it restarted in R5.
- A test (P3–P5) left a slot held with no student active.

## 9. Commercialization gap: what remains before paying customers

The platform is built for a **trusted** cohort on **one** host. The gap
before selling to the public is four kinds of work.

1. **Money (none of it exists as a live system).**
   - The provider boundary, webhook verification and idempotency, entitlement-from-billing and reconciliation are built and tested against a simulator only.
   - To do: integrate a real provider behind `BillingProvider`, then run checkout, renewal, failed payment, cancel and refund end to end in the provider's test mode.
   - Decisions to make: prices, currency, tax and VAT (who collects it), invoices and receipts, refunds and dunning.
   - Fix the #156 residuals (§5.D.2), and merge #155 and #156.
   - Terms, privacy policy and legal URLs.
   - **Estimated as the largest item.**
2. **Isolation for strangers.**
   - A paying stranger is not a trusted student. Privileged DinD gives the Docker track host root, so give each Docker sandbox its own VM or sandboxed runtime, or sell without the Docker track.
   - Disk quotas; a per-session terminal memory budget (N1); session-scoped sandboxd credentials; egress policy for the Docker-track bridge; nginx rate and connection limits.
   - A pentest by someone outside the team.
3. **Accounts and privacy.**
   - Self-service sign-up with a policy: who may create an account, and whether email verification is required.
   - Account deletion and export; idle timeout; sign-out everywhere; `__Host-` cookies.
   - DB-audited operator and role changes with authenticated operator identity.
   - Cohorts, so an instructor sees only their students.
4. **Operating it for money.**
   - More than one host, or at least tested restore to a new host within a stated RTO/RPO. PITR for PostgreSQL.
   - Zero-downtime deploys from immutable, tagged images with provenance.
   - Capacity beyond five: fix G2, add `mem_limit`s, parallel reaper teardown, and a real Kubernetes substrate.
   - An on-call rotation, a public status page, and support email with a response target.
   - Branch protection with reviews.

None of these blocks the free 5-student beta. Items 1 and 2 block taking money
from anyone the founder does not personally trust.

## 10. Next actions for the owner, in order

1. Merge **#163**. It is a doc fix plus a test; CI must be green.
2. Merge **#145**; it is test only.
3. Merge **#155**, then retarget **#156** to `main` (`gh pr edit 156 --base main`), wait for green, and merge it. Billing stays off: do not set `BILLING_PROVIDER` on the beta host.
4. Turn on branch protection (§7 step 0).
5. Make the external decisions: host (D2/D8), DNS name (D4), CA (D5), IdP and the five accounts (D1/D3), alert destination and person (D6), off-host backup (D7), where `.env` and the TLS key live (D9), who holds SSH and `docker` (D10).
6. Run §7 on the host, steps 1–34. Stop at any unexpected result.
7. Run §8 with five trusted testers.
8. Invite the five students; grant them after their first sign-in (§8 P6).
9. During the beta: a weekly `--verify-only` backup check (cron), a monthly restore drill, and the attestation re-run before 7 days (`NetworkIsolationAttestationAging`).
10. Before charging anyone: §9, items 1 and 2 first.
