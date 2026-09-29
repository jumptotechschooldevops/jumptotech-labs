# Operator guide — the map

For someone who has been handed this repository and a beta host, or who is on
call because the usual operator is not. It is a map: every row points at the
section that owns the procedure, and nothing here replaces one. If a row and its
target disagree, the target wins and this page is the bug.

Nothing in this repository has yet been run on a production host
([production-host-readiness.md §4](../development/production-host-readiness.md#4-what-is-not-proven)).
Every production command below is the command that host is meant to run.

| Subject | Authority |
|---|---|
| Bringing up a new host, upgrade, rollback | [production-host-readiness.md](../development/production-host-readiness.md) (§14 preflight, §15 deployment, §16 smoke, §21 upgrade and rollback) |
| Running the beta day to day; the `prod`, `q`, `ready`, `alerts`, `ops` helpers | [private-beta-operations.md](private-beta-operations.md) |
| Student accounts: add, remove, sign out, a stolen session, emergency revoke | [identity-and-access.md](identity-and-access.md) |
| Something is wrong | [private-beta-incident-response.md](private-beta-incident-response.md) (incidents A–U) |
| One alert | [README.md](README.md) → RB-01…RB-21 |
| Backups, restore, disaster recovery | [postgres-backup-restore.md](postgres-backup-restore.md) |
| Certificates | [production-tls.md](production-tls.md) |
| The release decision and its open conditions | [../releases/private-beta-release-gate.md](../releases/private-beta-release-gate.md) |
| What to record | [../releases/production-host-evidence-template.md](../releases/production-host-evidence-template.md) |

---

## 1. Ground rules

- **Drive the host with `prod`, never bare `docker compose` or `make up`.** `prod`
  is a shell function over all five compose files with the observability
  profile ([private-beta-operations.md §1](private-beta-operations.md#1-the-production-command));
  define it, and `q`, `ready`, `alerts` and `ops`, in every shell. A bare
  `docker compose` reads only `docker-compose.yml`: no sandboxd, and `up`
  re-creates services without the production overlays. `make up`, `rebuild`,
  `up-kubernetes-only`, `db-up`, `down`, `clean` and `sandbox-clean` refuse on a
  production checkout for that reason.
- **The checkout is `/srv/jumptotech-labs`; data lives under `/srv/jumptotech/`**
  (`backups/postgres`, `backups/status`, `evidence`), cron logs under
  `/var/log/jumptotech/` ([production-host-readiness.md §5.4](../development/production-host-readiness.md#54-filesystem-layout)).
  No script hard-codes the checkout path; they locate the repository from their
  own path. Two defaults do not follow that layout: `scripts/db-backup.sh`
  writes to `<checkout>/backups/postgres` unless `BACKUP_DIR` is exported, while
  `make production-preflight` checks `/srv/jumptotech/backups/postgres` by
  default. Export `BACKUP_DIR` and `BACKUP_STATUS_DIR` for every manual backup.
- **Never** `prod down -v`, remove a `jumptotech-labs-*` volume, edit
  `lab_sessions` by hand, or run `make clean` / `docker compose down -v` on the
  host: the volume is every student's progress. The full list is
  [private-beta-incident-response.md §1](private-beta-incident-response.md#things-you-must-never-do).
- **Grafana, Prometheus and Alertmanager are never exposed.** Grafana through an
  SSH tunnel to `127.0.0.1:3001`; Prometheus and Alertmanager only through
  `q` and `alerts` (`prod exec`). Only 443 and 80 are published.
- Never paste `.env` values into a ticket, chat or evidence file. Every script
  here prints names and PASS/FAIL, never values.

---

## 2. The operator journey

| Step | Command | Authority |
|---|---|---|
| Configuration is complete and safe | `make secrets-check`; `make production-config-check` (0 FAIL) | readiness §6, §15 step 13 |
| The host can run the stack | `make production-preflight` → `RESULT: PASS` | readiness §14 |
| Start | `prod up -d --build --wait --wait-timeout 900`; `prod ps` | readiness §15 step 16 |
| Readiness of each service | `ready api 9400`, `ready terminal 9401`, `ready sandboxd 9402` | ops §1, §2 |
| Smoke | `make private-beta-smoke` (evidence file) | readiness §16 |
| Daily health | the checklist, including both capacity gauges | ops §2, §2.1 |
| Capacity | `q` on the capacity gauges; `make host-capacity-sample` while students work | ops §2, §5; RB-04, RB-19 |
| Alerts | `alerts`; Grafana → *JTT — Private Beta Operations* | ops §1.3, §8 (delivery is DECISION REQUIRED) |
| Backups | the cron in ops §1.2; `make db-backup-verify FILE=…` | backup runbook §5 |
| Restore | `--verify-only`, then `--into`, then `--replace` | backup runbook §6 |
| Stop new launches, keep running labs | `LAB_LAUNCHES_PAUSED=true`, `prod up -d api` | ops §3 |
| Take the site down | `prod stop web` (stays stopped across reboots) | ops §3, §6.1 |
| Stop the stack | `prod down` — keeps the database; back up first | ops §6 |
| End one student's lab | `ops end <id> --yes` | ops §7.1 |
| Sign a student out everywhere | `ops sign-out <user-id> --by <you> --reason <why>` | ops §7.5; identity-and-access §8 |
| Evidence after an incident | `make private-beta-diagnostics` (sanitized bundle) | ops §7.3; incident response §4 |
| Upgrade | readiness §21.1, eight steps | readiness §21.1 |
| Roll back | readiness §21.2 | readiness §21.2 |

---

## 3. Releases, versions and rollback, as they exist

**Release path.** There is no release artifact and no image registry:

1. A change merges to `main`; the *Quality gates* run on that commit
   (`gh run list --commit <sha> --workflow "Quality gates"`). `main` has no
   branch protection, so a red run does not block a merge — check it.
2. On the host, the operator checks out the commit, runs `npm ci`, and sets
   `JTT_COMMIT` in `.env` to `git rev-parse HEAD` (readiness §21.1 step 4).
3. `prod up -d --build …` builds every image on the host from that checkout.
   Sandbox images are rebuilt only if their Dockerfiles changed
   (`make sandbox-build`).
4. Config check, preflight, smoke, evidence (readiness §21.1 steps 5–8).

Every step is manual; nothing deploys on merge.

**What is running?**

| Question | Answer | Limit |
|---|---|---|
| which commit | `git rev-parse HEAD` in the checkout; api, terminal and sandboxd report `JTT_COMMIT` in their start-up log line and the `jtt_build_info{commit=…}` metric; the smoke's `release.commit` fails when a service reports another commit | `JTT_COMMIT` is whatever the operator wrote in `.env`, not read from the image. The web container does not report one. |
| which image | built on the host from that checkout; `docker image inspect <image> --format '{{.Created}}'` | images carry no `org.opencontainers.image.revision` label |
| which CI run | `gh run list --commit <sha>` | — |

**Rollback** ([readiness §21.2](../development/production-host-readiness.md#212-rollback)):

- *Rolled back:* the code (`git checkout $(cat previous-commit)`, `npm ci`), the
  configuration (`.env.previous`), and — by rebuilding — the api, terminal,
  sandboxd and web images. The sandbox images only if `make sandbox-build` is
  run again, or each release has its own tags
  ([private-beta-deployment.md §7.1](private-beta-deployment.md)).
- *Not rolled back by that:* the database. Migrations are forward-only, and in
  production the previous api **refuses to start** on a schema a newer release
  migrated, naming the versions it does not ship. If the release
  applied a migration, restore the `pre-migration` archive taken in §21.1 step 3
  ([postgres-backup-restore.md §6.4](postgres-backup-restore.md#64-production-recovery-procedure));
  anything students wrote after it is lost. Running sandboxes are not restored
  either ([postgres-backup-restore.md §8](postgres-backup-restore.md#8-students-and-sessions-after-a-restore)).
- *Revalidate:* preflight, smoke with `release.commit` PASS on the previous
  commit, `alerts`, one LINUX-001 and one K8S-001 start-to-End.

---

## 4. Symptom → where to go

| What you see | Incident | Runbooks it uses |
|---|---|---|
| Site does not load | [A](private-beta-incident-response.md#a-the-website-is-unavailable) | RB-01, RB-15 |
| Sign-in fails | [B](private-beta-incident-response.md#b-sign-in-does-not-work) | RB-14, RB-08 |
| A student cannot start a lab | [C](private-beta-incident-response.md#c-a-student-cannot-start-a-lab) | RB-03, RB-09, RB-06, RB-18, RB-11, RB-21 |
| "Capacity is full" | [D](private-beta-incident-response.md#d-capacity-is-full) | RB-04, RB-05, RB-17, RB-19 |
| A lab stays "starting" | [E](private-beta-incident-response.md#e-a-lab-is-stuck-starting) | RB-10, RB-06, RB-09 |
| Terminal disconnected / keeps reconnecting | [F](private-beta-incident-response.md#f-the-terminal-disconnected), [G](private-beta-incident-response.md#g-the-terminal-keeps-reconnecting) | RB-12, RB-06 |
| Verify errors or never answers | [H](private-beta-incident-response.md#h-verify-does-not-work) | RB-13, RB-06, RB-09 |
| Reset fails | [I](private-beta-incident-response.md#i-reset-fails) | RB-17, RB-06 |
| Database down | [N](private-beta-incident-response.md#n-postgresql-is-unavailable) | RB-02 |
| Disk or memory pressure | [O](private-beta-incident-response.md#o-the-disk-is-nearly-full), [P](private-beta-incident-response.md#p-memory-pressure) | RB-19 |
| Docker daemon failing | [Q](private-beta-incident-response.md#q-the-docker-daemon-is-failing) | RB-06 |
| kind / Kubernetes failing | [R](private-beta-incident-response.md#r-kind-or-kubernetes-is-failing) | RB-18, RB-05, RB-09 |
| Certificate or TLS problem | [S](private-beta-incident-response.md#s-tls-or-certificate-problem) | RB-15, [production-tls.md](production-tls.md) |
| One student / everyone | [T](private-beta-incident-response.md#t-one-student-is-affected), [U](private-beta-incident-response.md#u-all-students-are-affected) | RB-08 |
| Backup alert | — | RB-16 |
| Leaked or orphaned sandboxes | — | RB-05 |
| No labs in the catalog | — | RB-07 |
| Security event alert | — | RB-08 |

Instructors work from the classroom view (`#/classroom`) and
[instructor-guide.md](instructor-guide.md), and escalate with a lab's **Support
ID** — its session id. `ops session <support-id>` reads the same lab; the
classroom's lab page (as an ADMIN) shows its sandbox, namespace and raw
status reason.

Student-facing errors carry a stable code and an `x-request-id`; ask the student
for the id and follow it across services
([../incident-troubleshooting.md](../incident-troubleshooting.md#following-one-request-across-three-services)).
Students are never shown internal detail; the detail is in the logs.

---

## 5. Logs and metrics

| What | Where |
|---|---|
| Service logs (JSON, one event per line, `requestId` on each) | `prod logs --no-log-prefix <service>`; filters in [../incident-troubleshooting.md](../incident-troubleshooting.md#useful-log-filters) |
| Readiness, per instance | `ready <service> <port>` (9400 api, 9401 terminal, 9402 sandboxd) — [../incident-troubleshooting.md → Health endpoints](../incident-troubleshooting.md#health-endpoints) |
| Metrics | `q '<PromQL>'`; the Grafana dashboard through the tunnel |
| Active alerts | `alerts` |
| Sessions | `ops status`, `ops sessions [--recent]`, `ops session <id>` |
| Backup and verify jobs | `/var/log/jumptotech/db-backup.log`, `db-verify.log`; the status files in `BACKUP_STATUS_DIR` |
| Everything, sanitized, for someone else | `make private-beta-diagnostics` |

The metric and label design, and what the platform cannot tell you:
[../observability.md](../observability.md).

---

## 6. Incident checklist

1. **Symptom** — what the student or alert says; note the time and any `x-request-id`.
2. **Host** — `df -h`, `free -m`, `uptime`; is Docker up (`prod ps`)?
3. **Services** — `prod ps`; `ready api 9400`, `ready terminal 9401`, `ready sandboxd 9402`.
4. **Database** — `ready api 9400` names it when it fails; incident N / RB-02.
5. **Runtime** — sandboxd readiness; `prod exec -T sandboxd docker version`; kind
   (incident R).
6. **Capacity** — the two capacity gauges (ops §2); incident D.
7. **Recent release** — `git log -1`, `JTT_COMMIT` in `.env`, the last evidence
   directory under `/srv/jumptotech/evidence/`.
8. **Logs and metrics** — §5 above.
9. **Decide** — recover in place (the incident's recovery step), stop launches
   (ops §3), or roll back (readiness §21.2). Take a backup before anything that
   touches the database.
10. **Validate** — the incident's "verify recovery" step, then
    `make private-beta-smoke`.
11. **Record** — incident response §5; attach `make private-beta-diagnostics`.

---

## 7. On-call handoff: what is not obvious

- `prod` is a shell function, not a script. It exists only in the shell that
  defined it; `jtt_prod` in `scripts/production-host-lib.sh` is the same list,
  used by the scripts.
- The production checkout is recognised by an installed TLS key or containers
  with `restart: unless-stopped` (`scripts/refuse-on-production.sh`), not by its
  path.
- `restart: unless-stopped` means a service you `prod stop` stays stopped
  across reboots — which is how `prod stop web` takes the site down on purpose.
- Readiness ignores providers: the api stays ready with every sandbox provider
  down, because it can still serve the catalogue and progress
  ([../incident-troubleshooting.md → What readiness deliberately ignores](../incident-troubleshooting.md#what-readiness-deliberately-ignores)).
- The Kubernetes track needs a current NetworkPolicy attestation for *this*
  `.env`; the five-student gate rewrites it, so re-run preflight steps
  afterwards (readiness §15 step 15, RB-18).
- `JTT_COMMIT` must be updated by hand on every deploy, or the smoke fails
  `release.commit`.
- Alert delivery, off-host backup copies, the certificate authority and the
  attestation cadence are still DECISION REQUIRED (ops §8, readiness §19).

---

## 8. New operator checklist

- [ ] Read this page, then [private-beta-operations.md](private-beta-operations.md) §1–§3.
- [ ] Can define and use `prod`, `q`, `ready`, `alerts`, `ops` on the host.
- [ ] Know where `.env`, backups, status files, evidence and cron logs live (§1).
- [ ] Ran `make production-config-check` and `make production-preflight` and can read their output.
- [ ] Know the start command, the smoke, and how to read both capacity gauges.
- [ ] Have opened Grafana through the tunnel and seen `alerts` output.
- [ ] Know the backup schedule, how to verify an archive, and that restore is `--into` before `--replace`.
- [ ] Know the upgrade steps and what a rollback does *not* undo (§3).
- [ ] Know the "never do" list and where incidents A–U are.
- [ ] Know how to collect a diagnostics bundle and fill the evidence template.
