# Release checklist: private beta, paid students, public

The one list of what stands between `main` and each of three releases. It is
maintained: when a row's status changes, change it here, with the evidence.
The procedures stay in their runbooks. This page says which step is done, which
is not, and who must do it.

| | |
|---|---|
| **Last verified against** | `origin/main` `74ea285` (Quality gates run `36419866411`: all 12 jobs green; CodeQL green), 2026-09-28 |
| **Open PRs that change a row** | #163 (rollback across migration 010; row A-14), #155 / #156 (account page, billing operations; tier B), #145 (classroom browser E2E; B-12) |
| **Detailed record behind it** | the final launch-readiness record (`docs/releases/final-launch-readiness-2026-09-28.md`, #164) and the reports in [../README.md](../README.md) → Records |

## Verdicts

| Tier | Who | Verdict |
|---|---|---|
| **A. Private beta** | 5 known, trusted students; `MAX_ACTIVE_SESSIONS=5`, `MAX_ACTIVE_SESSIONS_PER_STUDENT=1`; free | **GO in code. NOT GO to invite.** Nothing in the repository blocks it. Every remaining row is a host setting or a first run on the real Linux host, and no host exists yet. |
| **B. Paid JumpToTech students** | enrolled students of the school, known by name, paying | **NO-GO.** No real payment provider; capacity is proven and allowed only at 5; privileged Docker-in-Docker is acceptable only while every student is personally known. |
| **C. Public / untrusted** | anyone who can sign up | **NO-GO.** Needs sandbox isolation that does not trust the student, edge limits, account lifecycle and multi-host operations (§C). |

Statuses:

- **PASS**: proven by CI on the commit above, or by the repository itself.
- **PASS WITH BETA ACCEPTED RISK**: proven for five trusted students; the residual is written in the row.
- **REQUIRES PRODUCTION-HOST EVIDENCE**: nothing in the repository can prove it. A person must run the command on the beta host and keep the output in `/srv/jumptotech/evidence/`.
- **BLOCKER**: not built, or known wrong, for that tier.

Commands use the `prod`, `ops`, `ready`, `alerts` and `q` helpers of
[private-beta-operations.md §1](../runbooks/private-beta-operations.md).
Section numbers such as "deploy §5.9" point into
[private-beta-deployment.md](../runbooks/private-beta-deployment.md), the
authority for the host procedure.

---

## A. Private beta: five trusted students

Blocking = "yes" means students are not invited until it is PASS.

| # | Requirement | Status | Evidence | Command / procedure | Host? | Owner action | Blocking |
|---|---|---|---|---|---|---|---|
| A-1 | Authentication: OIDC fails closed | PASS | CI `gates` + `browser-e2e`: exact issuer and audience, asymmetric algorithms only, PKCE, state and nonce. Production refuses development auth and non-https origins ([authentication.md §4](../authentication.md)). | — | no | — | — |
| A-2 | Only the five can sign in | REQUIRES PRODUCTION-HOST EVIDENCE | The api admits **any** account the issuer authenticates (preflight `auth.admission` is MANUAL). Lab use is gated by entitlement (`ACCESS_POLICY` empty = `entitlement` in production), so a stranger can browse the catalog but start nothing. | Restrict the IdP client to the five and turn sign-up off (deploy §2.3). Then, from a non-beta account: sign-in is refused at the provider. | yes | Owner: IdP client, five accounts | yes |
| A-3 | Authorization / tenant isolation | PASS | CI: one policy function; a non-owner gets 404; the five-student adversarial suite (#85); `/internal` is not routed by nginx | Rehearsal R6–R8 (deploy §5.5) re-checks it on the host | no | — | — |
| A-4 | Student-to-student isolation, terminal | PASS | SEC-ARCH-2 (#117/#123): each shell runs as its own uid from a PostgreSQL sequence, with ambient capabilities cleared; `terminal-integration` 13/13 | — | no | — | — |
| A-5 | Terminal memory under a full home directory (N1) | REQUIRES PRODUCTION-HOST EVIDENCE | `docker-compose.yml`: `/home/student` 256m + `/tmp` 64m + `/run/jumptotech` 8m of tmpfs inside `mem_limit: 512m`. Tmpfs pages count against the cgroup, so one student can take the shared terminal toward an OOM kill. Never measured. | Deploy §5.9 fill test + `docker stats`; rehearsal R5 | yes | Operator; if it passes ~80 %, raise the terminal `mem_limit` in a production override | yes |
| A-6 | Sandbox isolation, container tracks | PASS | CI: `--cap-drop ALL`, non-root, no-new-privileges, memory = memory+swap, pids limit, 1 MB logs, `none`/`--internal` networks | — | no | — | — |
| A-7 | Sandbox isolation, Docker track | PASS WITH BETA ACCEPTED RISK | The DinD container runs `--privileged` and the student holds its client certificate, which amounts to host root. Its egress is an ordinary bridge. | Off switch: `DOCKER_TRACK_ENABLED=false` in `.env`, then `prod up -d api` | no | Owner accepts, or turns the track off | no (trusted only) |
| A-8 | Sandbox → host and metadata service | REQUIRES PRODUCTION-HOST EVIDENCE | No iptables rule ships. A host listener on `0.0.0.0` (sshd) and, on a cloud VM, `169.254.169.254` are reachable from a Docker-track shell. | Deploy §4 step 3 (sshd bind, `DOCKER-USER` drop); proven by the deploy §5.9 `nc` / `curl` | yes | Operator | yes |
| A-9 | Kubernetes isolation | PASS in CI; REQUIRES PRODUCTION-HOST EVIDENCE on the host kernel | `kind-integration`: NetworkPolicy enforcement with negative controls, 5 VAPs, PSA baseline, `seccompDefault`, ephemeral-storage quotas | A fresh `npm run cluster:up` prints `seccompDefault is on`; the deploy §4 step 13 attestation prints `VERDICT: PASS` | yes | Operator | yes |
| A-10 | Container log disk | REQUIRES PRODUCTION-HOST EVIDENCE | Sandboxes are bounded to 1 MB (#119). The DinD container and the kind node inherit the daemon default, which is unbounded; the DinD log is writable by the student. | Deploy §4 step 1: `/etc/docker/daemon.json` before any container exists | yes | Operator | yes |
| A-11 | Session cleanup and recovery | PASS WITH BETA ACCEPTED RISK | CI: the reaper handles orphans, abandoned CREATING/ENDING, RESETTING→DEGRADED and a stopped container→DEGRADED (#159), and takes in-flight work on SIGTERM (#147). Residual: NET-007's peer container and network are reclaimed about 2 min after End frees the slot. | `ops sessions`; `ops end <id> --yes` ([private-beta-operations.md §7.1](../runbooks/private-beta-operations.md)) | no | — | no |
| A-12 | Capacity: 5 total, 1 per student, the sixth refused | PASS in code; REQUIRES PRODUCTION-HOST EVIDENCE | `production-config-check` FAILs any value but 5 / 1 (`capacity.beta-contract`). On a saturated laptop the classroom run was INCONCLUSIVE (19/20 Starts). Kubernetes classroom never run. | `make beta-validate` (deploy §5.3) and `npm run capacity:classroom -- … --students 5 --extra-students 1` (deploy §5.4), with `make host-capacity-sample` running | yes | Operator | yes |
| A-13 | Database migrations | PASS | 001–010 forward-only, one transaction each, applied by the api at start; a newer database than the code is refused (#80, #126) | `prod logs api` at the first start | no | — | — |
| A-14 | Rollback | PASS in docs once #163 merges; REQUIRES PRODUCTION-HOST EVIDENCE | Before #163 the runbooks called every migration additive. Migration 010 re-keys `access_entitlements`, so `DATABASE_ALLOW_NEWER_SCHEMA=true` across it breaks every `ops access` change. Rollback has never run on a host. | Deploy §7.1 before every upgrade; §7.2 A or B | yes | Owner merges #163; operator rehearses one upgrade and rollback before students | yes (#163) |
| A-15 | TLS | PASS in CI; REQUIRES PRODUCTION-HOST EVIDENCE | `tls-edge-integration`: the certificate gate refuses IPs and bad chains; `tls-install.sh` validates and rolls back; expiry alerts | `make tls-install CERT=… KEY=…`; renewal timer with `scripts/tls-install.sh` as the deploy hook; `npm run tls:check -- --origin https://<host> --expect-acme` from another network | yes | Owner: domain and CA | yes |
| A-16 | DNS | REQUIRES PRODUCTION-HOST EVIDENCE | — | `dig +short <host>` from another network = `<public-ip>` (deploy §2.2) | yes | Owner | yes |
| A-17 | Firewall and exposed ports | PASS in code; REQUIRES PRODUCTION-HOST EVIDENCE | Development ports bind loopback; the production overlay publishes 80/443 only (#19). Docker-published ports bypass ufw. | Deploy §5.2: from another network, 80/443 open and `nc -zv -w3 <public-ip> 3001 4000 4001 4002 5432 9090 9093 9400 9401 9402 16443` all fail | yes | Owner: provider firewall | yes |
| A-18 | Secrets | PASS in code; REQUIRES PRODUCTION-HOST EVIDENCE | The secret gate and distribution checks run in CI; `.env` is `0600`; each service receives only its own secrets ([secret-boundaries.md](../secret-boundaries.md)) | `make secrets`, `make secrets-check`, `make production-config-check` with **0 FAIL and 0 WARN** | yes | Operator; D9 (where `.env` and the TLS key are recoverable from) | yes |
| A-19 | Backup | PASS in code; REQUIRES PRODUCTION-HOST EVIDENCE | backup, verify, `--into`, `--replace` (renames, never drops); a re-created database is refused; staleness alerts; `postgres-integration` drill | Deploy §6.1–§6.2: `scripts/db-backup.sh --label first-deploy`, `--verify-only`, the cron file, `BACKUP_COPY_HOOK` to an encrypted off-host store | yes | Owner: off-host destination and key custody (D7) | yes |
| A-20 | Restore | REQUIRES PRODUCTION-HOST EVIDENCE | Laptop RTO 344–416 s under load; never from an off-host copy | Deploy §6.3 steps 1–2; `make db-restore-drill` prints `RESTORE DRILL PASSED`; smoke `backup.offhost` PASS | yes | Operator | yes |
| A-21 | Monitoring and alert delivery | PASS in code; **BLOCKER until receivers exist** | 64 alert rules, each with a runbook; `Watchdog` → heartbeat (RB-20). No destination is configured, and the preflight reports that as MANUAL, so `RESULT: PASS` does not mean anyone will be told. | Write `infrastructure/observability/alertmanager/secrets/webhook-url` and `heartbeat-url`; the deploy §8.3 drill; a named person confirms receipt and the resolved notice | yes | Owner: destination and person (D6) | yes |
| A-22 | Disk, CPU and memory monitoring | PASS in code; REQUIRES PRODUCTION-HOST EVIDENCE | `HostDiskSpaceLow/Critical`, `HostMemoryPressure`, `HostMemoryCritical`, `HostCpuSaturated` (RB-19); sandbox and DinD disk are otherwise unbounded | `q 'jtt:host_filesystem_available:ratio'`, `q 'jtt:host_memory_available:ratio'`, `q 'jtt:host_load5_per_cpu:ratio'` return values on the host | yes | Operator | yes |
| A-23 | Branch protection on `main` | BLOCKER (repository setting) | `GET …/branches/main/protection` → 404 and `…/rulesets` → `[]` on 2026-09-28: a red or unreviewed commit can reach the host | The branch-protection command below the table | no | Owner (repository admin) | yes |
| A-24 | Incident response | PASS; drill timings REQUIRE PRODUCTION-HOST EVIDENCE | RB-01…RB-21, incident playbook A–U, incident management, diagnostics bundle with a redaction gate | Deploy §5.6: recovery drills D-1…D-7, including `sudo reboot` | yes | Operator | yes |
| A-25 | Production preflight | PASS in code; REQUIRES PRODUCTION-HOST EVIDENCE | Fails closed; its own test suite runs in `gates` | `make production-preflight ARGS="--backup-dir /srv/jumptotech/backups/postgres --report /srv/jumptotech/evidence/preflight-<ts>.txt"`: `RESULT: PASS` **and** every MANUAL line resolved by hand | yes | Operator | yes |
| A-26 | Beta validation | REQUIRES PRODUCTION-HOST EVIDENCE | Passed 139/0 on a laptop (P0-020), never on Linux | `make beta-validate` in a second checkout (deploy §5.3) | yes | Operator | yes |
| A-27 | Classroom capacity validation | REQUIRES PRODUCTION-HOST EVIDENCE | See A-12 | Deploy §5.4 with the five labs you will teach | yes | Operator | yes |
| A-28 | Lab catalog | PASS | All 117 labs are solved by some CI suite on `74ea285` ([lab-certification-2026-09-27.md](lab-certification-2026-09-27.md)) | Deploy §5.9: one browser flow per track, including DOCKER-004 | yes (the walk) | Operator | yes (the walk) |
| A-29 | Grants for the five | REQUIRES PRODUCTION-HOST EVIDENCE | `ACCESS_POLICY=entitlement` by default in production | After each first sign-in: `ops access find --email <e>`, `ops access grant <id> --until <end> --kind beta --by <you> --reason "private beta cohort 1"` (deploy §5.8) | yes | Operator | yes |
| A-30 | Five-person rehearsal | REQUIRES PRODUCTION-HOST EVIDENCE | — | [production-host-readiness.md §13.2](../development/production-host-readiness.md) R0–R14, with five trusted testers, on the production stack | yes | Owner + four helpers | yes |
| A-31 | Session security | PASS WITH BETA ACCEPTED RISK | 12 h absolute sign-in, no idle timeout; a terminal token outlives sign-out by up to 1 h; no `__Host-` prefix, deliberately (DR-09: the transaction cookie is `Path=/auth`) | `ops access revoke <id> --by <you> --reason … --end-sessions --yes` ends a student's labs at once | no | — | no |
| A-33 | Student journey: sign-in → catalog → Start → terminal → Check → Reset → End → progress → sign-out → return | PASS | CI `browser-ux` (the production bundle, every screen and error state) and `browser-e2e` (a real LINUX-001 through the stack); [student-experience-audit-2026-09-28.md](student-experience-audit-2026-09-28.md). A static pass on 2026-09-28 mapped every api error code to the web's words: each has student words. It found one wrong message, fixed by the PR that added this page: an End the provider could not finish answered with the provider's `ENVIRONMENT_UNREACHABLE`, which the web shows as "Verification could not run — Try Verify again". | Rehearsal R9–R11 on the host | no | — | no |
| A-32 | Edge rate limits | PASS WITH BETA ACCEPTED RISK | No nginx `limit_req` / `limit_conn`; the api has per-user sign-in, attach, Check and write budgets | — | no | — | no |

**Branch protection (A-23)**, by a repository admin. It requires the 12
Quality gates jobs and both CodeQL analyses, and forbids force-push and deletion:

```bash
gh api -X PUT repos/jumptotechschooldevops/jumptotech-labs/branches/main/protection --input - <<'JSON'
{"required_status_checks":{"strict":true,"contexts":["gates","postgres-integration","kind-integration","sandbox-integration","catalog-runtime","networking-integration","docker-integration","terminal-integration","sandboxd-integration","tls-edge-integration","browser-ux","browser-e2e","Analyze (javascript-typescript)","Analyze (actions)"]},
 "enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null,"allow_force_pushes":false,"allow_deletions":false}
JSON
gh api repos/jumptotechschooldevops/jumptotech-labs/branches/main/protection --jq '.required_status_checks.contexts | length'   # 14
```

Undo: `gh api -X DELETE repos/jumptotechschooldevops/jumptotech-labs/branches/main/protection`.

**The beta host, in order.** Deploy §4 steps 1–18 and §5–§6, then its §9
go-live checklist. Stop at any §10 stop condition. The shortest honest list of
commands a person must run there, and keep the output of:

```bash
# once, as root, before any container: deploy §4 step 1 (daemon.json), step 3 (sshd, DOCKER-USER)
npm run cluster:up                                   # "seccompDefault is on"
make sandbox-build && docker pull docker:27-dind
make tls-install CERT=/path/to/fullchain.pem KEY=/path/to/privkey.pem
make observability-token
# deploy §4 step 13: the attestation for this .env → VERDICT: PASS
make secrets-check && make production-config-check   # 0 FAIL, 0 WARN
make production-preflight ARGS="--backup-dir /srv/jumptotech/backups/postgres --report /srv/jumptotech/evidence/preflight-$(date -u +%Y%m%dT%H%M%SZ).txt"
make beta-validate ARGS="--report-dir /srv/jumptotech/evidence/beta-validate"    # second checkout, deploy §5.3
npm run capacity:classroom -- … --students 5 --extra-students 1                  # deploy §5.4
prod up -d --build --wait --wait-timeout 900 && ops status                       # 0 of 5 held, new labs YES
make private-beta-smoke ARGS="--public-ip <public-ip> --report-dir /srv/jumptotech/evidence"
scripts/db-backup.sh --label first-deploy            # then --verify-only, cron, off-host restore (deploy §6)
make db-restore-drill                                # RESTORE DRILL PASSED
```

Then the deploy §5.9 checks from a lab shell, the §8.3 alert drill, the §5.6
recovery drills, the rehearsal, and the evidence templates
([production-host-evidence-template.md](production-host-evidence-template.md),
[disaster-recovery-drill-evidence-template.md](disaster-recovery-drill-evidence-template.md)).

---

## B. Paid JumpToTech students

Everything in A, plus the rows below. These students are enrolled and known,
so the trusted-cohort risks in A-7 can stay accepted **only while every paying
student is personally known and has agreed to the acceptable-use terms**. The
day a stranger can pay, tier C applies.

| # | Requirement | Status | Evidence | Command / procedure | Host? | Owner action | Blocking |
|---|---|---|---|---|---|---|---|
| B-1 | A real payment provider | BLOCKER | Only the test provider exists, and production refuses it (#154). No checkout, renewal, failed-payment, cancel or refund has run against a real provider. | Implement a provider behind `BillingProvider`; run each flow in the provider's test mode ([billing.md](../billing.md)) | no | Owner: choose a provider; prices, currency, tax, receipts, refunds, dunning | yes |
| B-2 | Account page and billing operations | BLOCKER until merged | #155 (account page, test-mode checkout) and #156 (`ops billing`, reconciliation, billing alerts) are open. #156 has known residuals: the "already subscribed" guard, one unmapped price aborts a run, the 1000-subscription cap. | Merge #155, retarget #156 to `main`, fix the residuals | no | Owner merges; engineer fixes the residuals | yes |
| B-3 | Terms, privacy policy, refund policy | BLOCKER | #155 adds `LEGAL_*_URL`; the documents do not exist | — | no | Owner (legal text) | yes |
| B-4 | Selling without a manual grant per student | BLOCKER until B-1 | Today access is `ops access grant` by hand; plans and trials exist (#136) | With B-1: entitlement from a verified webhook ([commercial-access.md §9](../commercial-access.md)) | no | Engineer | yes |
| B-5 | Capacity above five | BLOCKER | The only proven and allowed contract is 5 / 1: `production-config-check` FAILs anything else. Broker `ECONNRESET` under saturation has no retry (G2). api, postgres and web have no `mem_limit`. | Measure 10 and then 25 on the real host (deploy §5.4 with `--students 10`), then change the contract in `test-support/production-host-contract.ts` to the measured value | yes | Engineer + operator | yes (for more than 5) |
| B-6 | Terminal memory for a paying class | BLOCKER until A-5 is measured | See A-5. At more than five students, the shared `/home/student` tmpfs (256m for every Docker/Kubernetes shell) is also a shared disk budget. | A per-session tmpfs or a separate memory budget | yes | Engineer | yes |
| B-7 | Deploy during a class | BLOCKER for paid, accepted for the beta | No drain: the terminal exits 3 s after SIGTERM and every shell drops; a Start in flight is handed to the reaper (#147). No `stop_grace_period` on api or terminal. | Until built: deploy with no students active (deploy §7.1) and announce it | no | Engineer | yes |
| B-8 | Support path | BLOCKER | A Support ID exists (#135); there is no support address, response target or status page | — | no | Owner | yes |
| B-9 | Account lifecycle | BLOCKER | No account delete or data export; sign-out does not end other devices (`destroyAllForUser` has no caller) | — | no | Engineer | yes |
| B-10 | Idle sign-out and token lifetime | BLOCKER for paid | See A-31. A paying student on a shared computer stays signed in for 12 h. | An idle timeout; sign-out that revokes terminal grants | no | Engineer | yes |
| B-11 | Restore objective | BLOCKER | No PITR, no second host; RPO is up to 24 h (daily backup) | Decide RPO/RTO; add WAL archiving or a more frequent backup; prove a restore onto a replacement host ([disaster-recovery.md](../runbooks/disaster-recovery.md)) | yes | Owner decides; engineer builds | yes |
| B-12 | Instructor workflow proven in a browser | BLOCKER until merged | #145 (instructor and admin run a class of five in real browsers) is open and not in required CI | Merge #145; make it a required check | no | Owner | yes |
| B-13 | Operator identity and audit | BLOCKER | `ops … --by <name>` is self-declared; role changes are logged, not stored as rows | — | no | Engineer | no for one operator, yes for staff |
| B-15 | Student words on the less common failures | Non-blocking polish | Found on 2026-09-28, not fixed: (1) a Reset that failed after the old environment was already replaced, while the daemon was unreachable, says "so it was not reset", though the files are gone and the lab is DEGRADED (`apps/web/src/lib/errors.ts`, the `reset` case of `ENVIRONMENT_UNREACHABLE`); (2) terminal close codes `CONTAINER_EXEC_DISABLED`, `SHELL_IDENTITY_UNSAFE`, `INVALID_WORKSPACE_PATH` and `OWNER_REQUIRED` fall back to "Connection to the terminal was lost." with no code to quote and no retry; (3) with plans, the catalog does not mark labs outside the student's plan (`LAB_NOT_IN_PLAN` appears only after Launch), a trial's end date is not shown, and `GET /api/sessions` reports the deployment's per-student limit, not the plan's | Reword (1); give (2) one "could not start a shell" text that shows the code; show plan coverage and expiry | no | Engineer | no (beta), yes before plans with differing coverage are sold |
| B-14 | Immutable releases | BLOCKER | Images are built on the host from the checkout; sandbox images are overwritten in place unless per-release tags are set | Minimum: per-release `*_SANDBOX_IMAGE` tags (deploy §7.1). Proper: tagged, published images with provenance | no | Engineer | yes |

---

## C. Public / untrusted multi-tenant release

Everything in B, plus the rows below. None of them blocks A.

| # | Requirement | Status (verified 2026-09-28 on `74ea285`) | Evidence | Owner action | Blocking |
|---|---|---|---|---|---|
| C-1 | No privileged Docker-in-Docker | BLOCKER | `services/sandboxd/src/docker-ops.ts` and `providers/docker-provider.ts` create it `--privileged` (`DOCKER_SANDBOX_PRIVILEGED` defaults to true); the student holds the inner daemon's client certificate | A VM or sandboxed runtime per Docker sandbox, or ship without the Docker track | yes |
| C-2 | Writable-layer and DinD disk quotas | BLOCKER | `storageOpts` is plumbed through `cli-client.ts` but no caller sets it | XFS `pquota` + `--storage-opt size=`; a bounded volume for the inner `/var/lib/docker` | yes |
| C-3 | DinD container log bound in code | BLOCKER | Host `daemon.json` only (A-10); `runContainer` cannot pass `--log-opt`, and the sandboxd wire spec has no field for it | Add a log field to the create spec in the orchestrator and sandboxd | yes |
| C-4 | Kubernetes PVC size | BLOCKER | Quota counts PVCs (5), not `requests.storage`; local-path ignores the size anyway. Ephemeral storage is bounded (#122). | `requests.storage` in the session quota plus a provisioner that enforces capacity | yes |
| C-5 | Sandbox → host and metadata, in code | BLOCKER | No shipped iptables / `DOCKER-USER` rule; host procedure only (A-8) | Ship and verify the rules, or run sandboxes on hosts with no other listeners | yes |
| C-6 | Docker-track egress | BLOCKER | `jumptotech-sandboxes` is an ordinary bridge: open internet egress (mining, scanning, abuse) | Egress policy per lab; default deny | yes |
| C-7 | Edge rate and connection limits | BLOCKER | No `limit_req`, `limit_conn` in `infrastructure/docker/nginx/` | nginx limits, plus a CDN or WAF in front | yes |
| C-8 | Sign-up policy | BLOCKER | Any IdP account creates a user row (`auth/users.ts`); no email or domain allow-list; entitlement is the only gate | Decide sign-up, email verification, and payment-before-lab | yes |
| C-9 | `__Host-` cookies, idle timeout, sign-out everywhere | BLOCKER | See A-31, B-9, B-10 | Revisit DR-09 (move the transaction cookie to `Path=/`), then `__Host-` | yes |
| C-10 | Session-scoped sandboxd attach credential | BLOCKER | The attach secret is service-wide | A per-session credential | yes |
| C-11 | Cohorts for instructors | BLOCKER | An instructor sees every student | Rosters / cohorts | yes |
| C-12 | Production Kubernetes substrate | BLOCKER | kind on one host; CNI / substrate decision open | Managed or multi-node cluster with an enforcing CNI; re-run the enforcement probe there | yes |
| C-13 | Failover and recovery objectives | BLOCKER | One host; no HA PostgreSQL | Stated RPO/RTO; multi-host or tested host replacement | yes |
| C-14 | Capacity at 25 and beyond | BLOCKER | Control plane measured to 50 on a laptop; no sandbox run above 5 on Linux | Measure; parallel reaper teardown; broker retry policy (G2) | yes |
| C-15 | Graceful deployment drain | BLOCKER | See B-7 | Readiness-off drain, `stop_grace_period`, terminal reconnect across deploys | yes |
| C-16 | Supply chain | BLOCKER | No SBOM, signing or published images; Dependabot PRs unreviewed. The 11 open Dependabot alerts on 2026-09-28 are one moderate advisory in `vitest` / `@vitest/mocker`, a development dependency no runtime image contains; Dependabot PR #6 bumps it | Release workflow with provenance | yes |
| C-17 | External penetration test | BLOCKER | Only internal red-team passes ([../security/redteam-wave2-2026-09-27.md](../security/redteam-wave2-2026-09-27.md)) | Commission one | yes |
| C-18 | Privacy | BLOCKER | No deletion or export; no data-retention statement for session history (008) | GDPR-style deletion, export, retention | yes |

---

## Operator questions during a class

Every answer is an existing procedure; none guesses ownership of a container.

| Question | Answer |
|---|---|
| How do I deploy? How do I know it succeeded? | Deploy §4; success is `prod up … --wait` exit 0, three `ready` 200s, and `make private-beta-smoke` all PASS including `release.commit` |
| Are all services healthy? | [private-beta-operations.md §2](../runbooks/private-beta-operations.md): `prod ps`, `alerts`, `ops status`, `ready …`, the dashboard rows 1–23 |
| Can five students enter, and is the sixth refused? | Before students: deploy §5.3–§5.4. On the day: `q 'jtt_sessions_capacity_limit'` = 5 and `q 'jtt_sessions_per_student_limit'` = 1; a sixth Start returns `LAB_CAPACITY_REACHED` |
| Which sessions are active? | `ops sessions` (`--recent` for ended ones); the Classroom page for an INSTRUCTOR or ADMIN |
| How do I end a broken session? | `ops end <session-id> --yes`, or End in the Classroom page as ADMIN ([private-beta-operations.md §7.1](../runbooks/private-beta-operations.md)). Never remove containers by name. |
| Disk, CPU or database trouble? | `HostDiskSpace*`, `HostMemoryPressure*`, load/PSI and database alerts → RB-19, RB-02; `q 'jtt:host_filesystem_available:ratio'`; `ready api 9400` reports the database |
| How do I restart safely? | [private-beta-operations.md §6](../runbooks/private-beta-operations.md): `prod restart <service>`, never `prod down -v` |
| How do I roll back? | Deploy §7 (and never `DATABASE_ALLOW_NEWER_SCHEMA=true` across 010) |
| How do I back up and restore? | Deploy §6; [postgres-backup-restore.md](../runbooks/postgres-backup-restore.md) |
| A student cannot Start | [private-beta-operations.md §4](../runbooks/private-beta-operations.md); their Support ID in the Classroom page; `ops access show <id>` for `ACCESS_NOT_ACTIVE` |
| The terminal fails | [RB-12](../runbooks/RB-12-terminal.md); [private-beta-incident-response.md](../runbooks/private-beta-incident-response.md) |
| Stop new labs now | `LAB_LAUNCHES_PAUSED=true` in `.env`, then `prod up -d api` (RB-21) |
| Shut down after class | `ops sessions` until no slot is held (End, or idle expiry after `IDLE_TIMEOUT_MINUTES`); `make private-beta-diagnostics` if anything went wrong. Leave the stack running for the nightly backup; to take the site down, `prod stop web`. |

---

## Changing this page

Change a row's status only with evidence: a CI run on the commit, a file and
line, or an output kept on the host. When a PR closes a row, update the row in
the same PR. Dated passes stay in their own records and link here.
