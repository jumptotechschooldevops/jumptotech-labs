# Launch-readiness pass — release-candidate report

| | |
|---|---|
| **Date** | 2026-09-27 |
| **Starting main** | `92c0aaf` |
| **Main when written** | `8912ed6` (after this pass's nine merged PRs; #92 below merges next) |
| **Scope** | production readiness, reliability, operations, backup/restore, DR, capacity, release engineering, CI gates, operator docs |
| **Not in scope** | security red-team, lab content and performance. Parallel sessions ran those in the same hours; their PRs (#62, #64–#68, #70, #71, #73–#79, #81, #82, #85, #86, #89, #91, #93) are theirs, not this report's evidence |
| **Recommendation** | **GO for the five-student private beta, conditional on the first-host items in §9.** Not ready for public commercial launch (§10) |

Only what was run or read in this session is stated as fact, and each item
names where it came from. "CI" means the `quality-gates.yml` jobs on the pull
request named. "Local" means this Mac: Node 22.23.2 and Docker Desktop, with
four to six other agents running. **No production host exists, so nothing here
was run on one.**

---

## 1. Pull requests

| PR | State | What it fixes | Class |
|---|---|---|---|
| #63 | merged `36ba7d6` | The terminal and broker shell caps (`TERMINAL_MAX_SESSIONS`, `SANDBOXD_MAX_SESSIONS`) counted only shells that already existed. A class attaching at once all measured an empty service and all got in. Attaches still in progress now count; a session replacing its own shell is still admitted. Two commits ported from the unmerged perf-capacity branch | P1 overload |
| #69 | merged `6aa8693` | The abandoned-attempt sweeper used age alone. Since P0-007, sessions persist with their original deadline, so after `MAX_SESSION_MINUTES` was lowered (or while the reaper was behind) a **running** lab's attempt was marked EXPIRED, and its End could not record ENDED. It now excludes sessions that hold a slot, and skips the sweep if it can't read them | P1 data |
| #72 | merged `0b094d3` | `statement_timeout` is enforced by the server, so a *silent* database (frozen host, partition) held every pool slot until the kernel gave up (~15 min). That meant 503 on every request long after the database was back. Adds a client `query_timeout` (`DATABASE_QUERY_TIMEOUT_MS`, default statement timeout + 5 s), TCP keepalive, and destroys a connection whose ROLLBACK fails | P1 dependency failure |
| #80 | merged `97c6297` | Port of the unmerged DR audit: in production the api **refuses** a schema a newer release migrated (`DATABASE_ALLOW_NEWER_SCHEMA` overrides); a re-created database is told apart from a recovered one (metric and alert); backup refuses to archive a re-created empty database; a committed `--replace` is no longer reported failed; `BACKUP_DIR` is refused in build contexts. Also adds the DR runbook. **CI found a timing bug in the ported code**: it refused the restored database when migration and dump fell in the same second. Fixed with `BACKUP_RECREATED_TOLERANCE_SECONDS` | P1 rollback and DR |
| #83 | merged `8664bda` | Port of the unmerged CI audit. Three gates passed while proving nothing: `postgres-integration` exited 0 with every DB suite skipped; the observability-isolation security step read nothing; no `pipefail`. Also keeps DB archives out of build contexts and adds lockfile, version and port drift guards | P1 release gates |
| #84 | merged `2c50315` | The reaper's teardown failures were counted, but the reasons were thrown away. RB-05 told operators to grep for `reaper.sweep.failed`, which nothing emitted. Now one bounded warn line names each sandbox and reason | P1 operability |
| #87 | merged `2bd5d66` | A web test raced the terminal mount and failed #80's CI. Test-only | CI health |
| #88 | merged `849da5f` | `docs/beta-slo-indicators.md`: ten indicators, each with query, objective, alert and runbook, plus the operator questions answered with real queries and commands | WS5/6/28 |
| #90 | merged `9047583` | A timer setting above 2,147,483 s made Node fire it after 1 ms (every shell closed on connect, or the reaper spinning). It is now refused at startup | P2 config |
| #92 | this PR (carries this report) | Port of the unmerged docs audit: one authoritative docs map enforced by a contract test, `operator-guide.md`, `testing.md`, `getting-started.md`, executable runbook commands, `make down` refused on production, and suites with no runtime reporting *skipped* rather than passed. Reconciled with today's main (strict `test:db`, the DR documents, one `pre-migration` backup label) | WS25/29 |

Three finished audits had never been opened as PRs: disaster recovery, CI/CD
supply chain, and docs. They were found by grepping main for each fix's content;
`git cherry` also flags squash-merged branches as unmatched, so it can't tell
them apart. Two other unmerged branches were left alone:
`feat/overnight-browser-quality` and `feat/overnight-lab-product-audit`. The
first was out of this pass's time budget; the second is lab content.

## 2. Status by area

| Area | Status | Evidence |
|---|---|---|
| **Deployment** | Procedure complete and ordered; never run on a host | `development/production-host-readiness.md` §14–§16, §21. Compose ordering: postgres healthcheck → api `service_healthy` → terminal/web; production `restart: unless-stopped`; postgres stop grace 60 s |
| **Configuration** | Fail-closed in production for auth, secrets, transport, TLS, owner and access policy (earlier passes); this pass adds the timer bound and the DB query timeout | #72, #90; `make production-config-check` |
| **Startup / shutdown** | Every service handles SIGTERM with a deadline under Docker's 10 s (api 9 s, sandboxd 5 s, terminal 3 s); shutdown never ends a student's session. **Gap:** a Start or Reset in flight is cut off and holds the student's slot until the reaper's 10-min recovery (P1-3) | read-only audit of `index.ts` in all three services |
| **Health / readiness** | `/readyz` names the failing dependency on a separate listener; the DB probe is off the scrape path | earlier passes; RB-01/RB-02 |
| **Timeouts** | Every external call is bounded (broker 120/180 s, k8s 30 s, OIDC 10 s, CLI 15–60 s, terminal credentials 10 s). The last unbounded one, a PostgreSQL reply, is fixed | read-only audit; #72 |
| **Retries** | No infinite retry and no automatic retry of a non-idempotent operation. Minor: terminal reconnect has no jitter; session polling doesn't back off during an API outage | read-only audit |
| **Database** | 6 migrations, all additive. Real PostgreSQL 16: `make test-db` exit 0 three times this pass (progress 123–126, orchestrator store 189, api persistence 26); strict since #83 | local runs, CI `postgres-integration` |
| **Backup / restore** | Drill passes on real PostgreSQL: backup, source destroyed, fresh server, `--replace` restore, identical fingerprint, migrations current, app read and write, re-created DB refused | local `make db-restore-drill` 100 s (before the tolerance fix); CI drill 19 s (after it). A second local run could not start its container under Docker load (environmental) |
| **Disaster recovery** | Runbook covers reboot, bad release, DB loss, runtime loss and host loss, with RPO/RTO and a drill plan. **Never executed on a host** | `runbooks/disaster-recovery.md` |
| **Rollback** | Code rollback documented; a rollback past a migration now refuses to start instead of running silently on a newer schema | #80, host-readiness §21.2 |
| **Observability** | 61 alert rules, each with a runbook; indicators and objectives written down; reaper failures now carry reasons | #84, #88; `promtool check rules` and `test rules` SUCCESS |
| **Capacity** | Five students fit the software limits (`MAX_ACTIVE_SESSIONS`, per-student 1). Per-session ceilings: k8s quota 2 CPU / 2 GiB requests; container 0.5 CPU / 512 MB; DinD 2 CPU / 2 GB. **Host sizing is operator decision D8** | api 55/55 five-student suites; terminal 6/6 (5 × 6 lifecycle churn, no leak); sandboxd 2/2; on main `6d38091` |
| **Overload** | Controlled rejection: 503 `LAB_CAPACITY_REACHED`, 429 per-student, terminal/broker `CAPACITY` with student-readable text; attach race closed | #63; capacity suites |
| **Browser journey** | CI `browser-e2e` passed on every PR this pass | CI |
| **Lab catalog** | 117 labs from 117 `lab.yaml`, 0 errors, 0 warnings. Container labs start, reset and end on a real runtime (#93, another session) | `npm run validate:labs` on `5bef804` |
| **Release gates** | 13 checks per PR (gates, 9 runtime jobs, CodeQL ×3). Three false greens closed | #83 |
| **Operator runbook** | RB-01…RB-21, incident response A–U, DR runbook, operator guide, `ops` CLI (status, sessions, session, end, access) | #92, earlier passes |
| **Commercial operability** | `ops session <id>` shows owner, lab, status reason, created and expires; `ops end <id> --yes`; `ops access` for entitlements | `apps/api/src/operator-cli.ts`, #88 §2 |

## 3. Blockers

**None in code** for five trusted students on one host.

The blockers left are external. No repository change can close them, and each
fails a specific way if skipped:

| Item | Failure mode if skipped |
|---|---|
| D1/D3 identity provider restricted to the five accounts | OIDC admits any account at the issuer: strangers can sign in (and use labs if `ACCESS_POLICY=open`) |
| D2 host provisioned, D8 sizing judged | Five k8s labs request up to 10 GiB; an undersized host OOMs sandboxes and then the platform |
| D4/D5 DNS and certificate | The web container refuses to start (TLS gate); no service |
| D6 alert destination | Every alert above fires into nothing; failures are seen only when students report them |
| D7 off-host, encrypted backup | Host loss loses every student's history (RPO = everything) |
| `make beta-validate` and the §13.2 rehearsal on the host | Capacity and isolation on the real substrate are unmeasured |

## 4. P1: open, required before public launch

1. **No restore from an off-host copy has ever been done**, and nothing has run at production size. The drill uses 27 KB.
2. **Single host, single api.** There is no failover. Host loss means an outage lasting the restore time.
3. **An in-flight Start or Reset during an api restart** holds the student's slot for up to 10 min (`abandonedStartGraceMs`). The upgrade procedure mitigates it by requiring no active students. Public launch needs a drain (stop admitting Starts on SIGTERM and wait for in-flight ones, with a longer `stop_grace_period`) or immediate recovery of rows this process owned.
4. **Images are built from the checkout on the host.** There's no registry, no immutable tag and no revision label. `JTT_COMMIT` is attested at runtime by the smoke test, but an image isn't provably the commit.
5. **No per-student rate limit on hints** (earlier reports). Check, sign-in and terminal opens gained budgets from other sessions today (#79, #82, #75).
6. **Branch protection is off on `main`.** Merges rely on each author checking CI.

## 5. P2: open

- The absolute session deadline is enforced only by the reaper (≤ 60 s late).
- Terminal reconnect has no jitter; session polling doesn't back off while the API is down.
- terminal and sandboxd close sockets with 1006 (not 1001/1012) on shutdown. The browser treats that as `CONNECTION_LOST` and reconnects.
- A second SIGTERM doesn't force exit; the operations collectors' `stop()` is discarded.
- CLI runners send only SIGTERM on timeout, with no SIGKILL follow-up.
- Local test flakes under machine load: `catalog-api` (5 s timeout) and the observability redactor-linearity test. Both pass alone.

## 6. Tests run in this pass

| Command | Result |
|---|---|
| `TEST_DB_PORT=5546x make test-db` (real PostgreSQL 16), three times on three branches | exit 0 each time |
| `env -u RUN_DB_TESTS npm run test:db` after #83 | exit 1, names the skipped suite (was exit 0) |
| `make db-restore-drill` | PASSED 100 s locally; CI PASSED 19 s after the tolerance fix |
| `bash scripts/test-db-backup-restore.sh` | 168 passed, 0 failed |
| `bash scripts/test-production-host-scripts.sh` | 58 cases, 0 failed |
| `promtool check rules` + `test rules` | SUCCESS |
| `npm run validate:labs` | 117 labs, 0 errors, 0 warnings |
| Workspace suites (vitest): orchestrator 1451, observability 1017, api 758, terminal 222, sandboxd 171, progress 112, web 274 | pass. Two load flakes named in §5 pass alone |
| Five-student and capacity suites on `6d38091` | api 55/55, terminal 6/6, sandboxd 2/2 |
| Every new test was run against main's source first | each failed there, and passes with the fix |
| CI on #63, #69, #72, #80, #83, #84, #87, #88, #90 | 13/13 green before each merge |

## 7. Tests not run

| What | Why |
|---|---|
| `make beta-validate` (five synthetic students on a running stack) | Needs the full stack, kind and observability. Four to six agents shared this Docker daemon, and two stacks up at once resolve `api` and `terminal` across stacks. The CI runtime jobs and the five-student suites stand in; the real run is a first-host item |
| Local browser E2E, kind, sandbox, networking, terminal-container suites | Ran in CI on every PR instead |
| Anything on a production host, off-host restore, reboot drill | No host exists |

## 8. CI status

All ten PRs ran the full `quality-gates.yml` (gates + nine runtime jobs) and
CodeQL. Failures seen, all resolved:
- #80: a web test race (fixed by #87); then the drill timing bug in the ported code (fixed in #80).
- #92: a CodeQL `js/incomplete-multi-character-sanitization` in a new test helper (fixed in #92).

The shared runner queue reached 20 runs and delayed merges by up to an hour.

## 9. Recommendation for the private beta

**GO, conditional.** The software is ready for five trusted students on one
host. Every launch-relevant failure this pass could reproduce is fixed and
tested. Two P1s fixed here were reachable by ordinary operation: a lowered
session lifetime corrupting live attempts, and a silent database outage
lasting fifteen minutes past recovery.

Before inviting anyone:
1. Close D1/D3, D2/D8, D4/D5, D6 and D7 (§3).
2. Run `development/production-host-readiness.md` §23 on the host, including `make beta-validate` and the five-person rehearsal.
3. Record the first backup, restore and DR drill in `releases/disaster-recovery-drill-evidence-template.md`.
4. Deploy with no students active, per the upgrade procedure (P1-3).

## 10. Remaining before a public commercial launch

§4 in full, plus:
- evidence from at least two beta cohort weeks, used to confirm or replace the objectives in `beta-slo-indicators.md`;
- a second host or a documented, measured RTO;
- immutable, registry-published images with a rollback by tag;
- branch protection and required checks on `main`;
- a recurring restore test from the off-host copy;
- a decision on multi-instance api, which the capacity lock already supports and the startup recovery does not assume.
