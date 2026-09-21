# Production-host deployment evidence — TEMPLATE

> **This file is a blank form.** Copy it to `/srv/jumptotech/evidence/` on the
> host for each deployment and fill it there. A copy in the repository with
> results in it would be a claim about a host the repository cannot see.
>
> Every result must come from **this host, this deployment**, with the evidence
> file that shows it. A laptop run, a CI run, or a line copied from
> `docs/development/production-host-readiness.md` is not evidence. Leave a row
> `NOT DONE` rather than guess. Never paste a secret, a webhook URL, or a
> certificate private key into this file.

| | |
|---|---|
| Deployment date (UTC) | |
| Operator(s) | |
| Host (provider, region, instance type — not credentials) | |
| CPU / memory / disk (from preflight INFO lines) | |
| OS, kernel, Docker, Compose, kind, kubectl, Node versions | |
| Public host name | |
| Release commit (`git rev-parse HEAD`) and tag | |
| `JTT_COMMIT` in `.env` matches | |
| Smoke `release.commit`: every running service reports that commit | |

Result values: `PASS`, `FAIL`, `NOT DONE`, `BLOCKED (decision D#)`.

## 1. Decisions (readiness doc §19)

| # | Decision | Chosen (name only) | Decided by | Date |
|---|---|---|---|---|
| D1 | Identity provider | | | |
| D2 | Host / Kubernetes substrate | | | |
| D3 | Who may sign in, and how it is enforced | | | |
| D4 | Host name / DNS provider | | | |
| D5 | CA / ACME client / renewal schedule | | | |
| D6 | Alert destination type and on-call | | | |
| D7 | Off-host backup destination, encryption, retention | | | |
| D8 | Capacity acceptance thresholds | | | |
| D9 | Where `.env` and the TLS key are recoverable from | | | |
| D10 | Operator access (SSH keys, bastion) and who holds `docker` | | | |
| D11 | Attestation re-probe cadence | | | |
| D12 | Metric/log retention; external uptime check; host exporter | | | |
| D13 | Federated logout; idle timeout | | | |
| D14 | IPv6, HSTS preload, CAA | | | |
| D15 | Bearer tokens on `/api/*` in production (readiness §8.1) | | | |

## 2. Before first start

| Step (readiness §15) | Result | Evidence file / note |
|---|---|---|
| 2 Firewall admits only 80, 443, operator SSH | | |
| 3 Checkout at the release commit, mode 0750, `npm ci` | | |
| 4 Backup, evidence and log directories with the §15 modes | | |
| 5 `.env` mode 0600; 5/1 limits; `DOCKER_SOCKET_GID` from the socket | | |
| 6 OIDC client registered per readiness §8.1 (`client_secret_post`, asymmetric ID-token signing, exact issuer and callback, dedicated `OIDC_AUDIENCE`); restricted to the beta accounts | | |
| 7 kind cluster; `seccompDefault` on | | |
| 8 Sandbox images built; `docker:27-dind` pulled | | |
| 9 DNS resolves from outside; certificate installed | | |
| 10 Scrape token written; alert destination installed (or BLOCKED D6) | | |
| 12 NetworkPolicy probe `VERDICT: PASS` | | `network-probe.json` |
| 13 `make secrets-check`; `make production-config-check` 0 FAIL | | |
| 13 Every config-check WARN listed, each with why it is accepted (none expected: `gates.origins`, `gates.oidc-client`, `capacity.launches`, `observability.edge-probe` all PASS on the proven configuration) | | |
| 14 `make production-preflight` RESULT: PASS | | `preflight-*.txt` |
| 15 (§13 A) `make beta-validate` on this host at this commit | | report path |
| 15 (§13 A) capacity samples during the synthetic run | | `capacity-synthetic/` |
| 15 Steps 12–14 repeated after the synthetic run; `k8s.attestation-digest` PASS | | `network-probe.json`, `preflight-*.txt` |

## 3. After start

| Step (readiness §15) | Result | Evidence file / note |
|---|---|---|
| 16 `prod up -d --wait` succeeded; `prod ps` all running/healthy | | |
| 16 First backup + `--verify-only`; cron installed | | archive name |
| 16 Restore beside production (`--into`) validated | | database name |
| 17 `make private-beta-smoke`: every line PASS except `backup.offhost` until D7; `exposure.host-containers` PASS | | `private-beta-smoke-*.txt` |
| 18 External port scan: only 80/443 (+SSH) open | | command + output |
| 18 External `npm run tls:check -- --expect-acme` exit 0 | | |
| 19 Beta account signs in; sign-out invalidates the cookie | | |
| 19 **Non-beta account is refused** | | |
| 20 LINUX-001, K8S-001, DOCKER-001: start, terminal, check, reset, end | | times |
| 21 Grafana through the SSH tunnel; smoke `observability.*` PASS | | |
| 22 Alert delivery drill received by a person (readiness §12.1); `AlertNotificationsFailing` no longer firing 15 min after the destination is installed | | who, sent/received times |
| 23 Off-host backup copy recorded (`backup.offhost` PASS, smoke RESULT: PASS) and one restore from it | | |

## 4. Five-person rehearsal (readiness §13.2)

| Measurement | Value | Source |
|---|---|---|
| Start p95 by provider | | PromQL |
| Check Solution p95 by provider | | PromQL |
| Terminal echo delay reported by testers | | hand-recorded |
| Peak load1 / CPUs | | `host.csv` |
| Lowest memory available | | `host.csv` |
| Lowest Docker disk available | | `host.csv` |
| Peak containers / sandboxes / Pods | | `host.csv` |
| Peak CPU iowait / steal %, peak memory pressure (PSI), OOM kills during the run | | `host.csv` (empty columns: the kernel lacks the source) |
| Largest container memory (name, MiB) | | `containers.csv` |
| Service restarts during the run | | `docker inspect` |
| Alerts fired | | `alerts` |
| R3 second lab for one student refused (`student_limit_reached`) | | PromQL |
| R4 sixth start refused (`capacity_reached`), or SKIPPED with reason | | PromQL |
| R6 another student's lab URL refused | | `denied-not-owner` |
| R7/R8 no cross-student visibility (`kubectl`, `ps`, `docker ps`) | | terminal output |
| R11 reload and reopen resume the same lab | | per tester |
| Sessions active after End = 0; no managed containers or namespaces left (R13) | | |
| **Acceptable against D8?** | | decided by |

## 5. Recovery drills (readiness §17), no students active

Procedure and pass conditions: readiness §17.2. Row counts are `users` and
`lab_attempts` before and after.

| Drill | Result | Time to smoke PASS | Row counts unchanged | kind node after (state, `restarts=`, Ready) |
|---|---|---|---|---|
| D-1 `prod restart api` | | | | — |
| D-2 `prod restart terminal` | | | | — |
| D-3 `prod restart sandboxd` | | | | — |
| D-4 `prod restart web` | | | | — |
| D-5 `prod restart postgres` | | | | — |
| D-6 Docker daemon restart | | | | |
| D-7 Host reboot | | | | |

## 6. Sign-off

| | |
|---|---|
| Open items that remain (with owner) | |
| Students may be invited | YES / NO |
| Signed off by | |
