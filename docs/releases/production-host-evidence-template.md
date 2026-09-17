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

## 2. Before first start

| Step (readiness §15) | Result | Evidence file / note |
|---|---|---|
| 2 Firewall admits only 80, 443, operator SSH | | |
| 3 Checkout at the release commit, mode 0750, `npm ci` | | |
| 5 `.env` mode 0600; 5/1 limits; `DOCKER_SOCKET_GID` from the socket | | |
| 6 OIDC client registered; redirect `https://<host>/auth/callback` | | |
| 7 kind cluster; `seccompDefault` on | | |
| 8 Sandbox images built; `docker:27-dind` pulled | | |
| 9 DNS resolves from outside; certificate installed | | |
| 12 NetworkPolicy probe `VERDICT: PASS` | | `network-probe.json` |
| 13 `make secrets-check`; `make production-config-check` 0 FAIL | | |
| 14 `make production-preflight` RESULT: PASS | | `preflight-*.txt` |
| §13 A `make beta-validate` on this host at this commit | | report path |
| §13 A capacity samples during the synthetic run | | `capacity-synthetic/` |

## 3. After start

| Step | Result | Evidence file / note |
|---|---|---|
| 15 `prod up -d --wait` succeeded; `prod ps` all running/healthy | | |
| 16 First backup + `--verify-only`; cron installed | | archive name |
| 16 Restore beside production (`--into`) validated | | database name |
| 17 `make private-beta-smoke` RESULT: PASS | | `private-beta-smoke-*.txt` |
| 17 External port scan: only 80/443 (+SSH) open | | command + output |
| 17 External `npm run tls:check -- --expect-acme` exit 0 | | |
| 18 Beta account signs in; sign-out invalidates the cookie | | |
| 18 **Non-beta account is refused** | | |
| 19 LINUX-001, K8S-001, DOCKER-001: start, terminal, check, reset, end | | times |
| 22 Grafana through the SSH tunnel; dashboard renders | | |
| 23 Alert delivery drill received by a person (readiness §12.1) | | who, sent/received times |
| 24 Off-host backup copy recorded (`backup.offhost` PASS) and one restore from it | | |

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
| Largest container memory (name, MiB) | | `containers.csv` |
| Service restarts during the run | | `docker inspect` |
| Alerts fired | | `alerts` |
| Sessions active after End = 0; no managed containers left | | |
| **Acceptable against D8?** | | decided by |

## 5. Recovery drills (readiness §17), no students active

| Drill | Result | Time to smoke PASS |
|---|---|---|
| `prod restart api` | | |
| `prod restart terminal` | | |
| `prod restart sandboxd` | | |
| `prod restart web` | | |
| `prod restart postgres` | | |
| Docker daemon restart (kind node state recorded) | | |
| Host reboot | | |

## 6. Sign-off

| | |
|---|---|
| Open items that remain (with owner) | |
| Students may be invited | YES / NO |
| Signed off by | |
