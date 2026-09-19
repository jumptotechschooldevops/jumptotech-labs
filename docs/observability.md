# Observability architecture

**PLATFORM-003.** How the platform is instrumented, what it exposes, who may
read it, and the rules a change has to obey.

Companion documents: [incident troubleshooting](incident-troubleshooting.md),
[runbooks](runbooks/README.md), [incident exercises](incident-exercises.md).

---

## 1. The shape

```text
┌───────────────────── student plane (unchanged) ─────────────────────┐
│  browser ── nginx :3000 ──┬─ /api,/auth → api :4000                 │
│                           └─ /terminal  → terminal :4001            │
└─────────────────────────────────────────────────────────────────────┘
     api :4000          terminal :4001         sandboxd :4002
        │                     │                      │
╔═══════╪═════════════════════╪══════════════════════╪═══════════════╗
║  SECOND LISTENER — separate port, never proxied by nginx            ║
║    :9400                :9401                  :9402                ║
║  /metrics (Bearer)   /livez (open)   /readyz (open)                 ║
╚═══════╪═════════════════════╪══════════════════════╪═══════════════╝
        └─────────────────────┴──────────────────────┘
                              │ scrape 15s, loopback only
                   ┌──────────▼──────────┐
                   │ Prometheus  :9090   │──► Alertmanager :9093
                   └──────────┬──────────┘
                   ┌──────────▼──────────┐
                   │ Grafana     :3001   │  9 dashboards, provisioned as code
                   └─────────────────────┘
```

### Why a second listener rather than three more routes

`/metrics` publishes capacity, failure rates and the shape of the catalogue. On
the API it would sit beside routes nginx proxies to the public internet, one
`location` block away from being served to anybody.

A separate port that nginx has no `proxy_pass` for makes that exposure
*structurally* impossible rather than a routing convention that holds until
somebody edits `web.conf`. It is the same argument that moved the container
runtime out of the API and into `sandboxd`: the strong version of "this service
cannot do that" is that it has no way to.

Two properties follow: the endpoint keeps answering while the main listener is
saturated — which is precisely when it is needed — and it is outside the CORS
surface entirely, so there is no preflight and no origin list to get wrong.

---

## 2. Exposure model

| Surface | Bind | Auth | Reachable from a browser? |
|---|---|---|---|
| `/metrics` | 127.0.0.1 | `Authorization: Bearer`, constant-time | **No** |
| `/livez`, `/readyz` | 127.0.0.1 | none | No |
| Prometheus :9090 | 127.0.0.1 | none | No |
| Alertmanager :9093 | 127.0.0.1 | none | No |
| Grafana :3001 | 127.0.0.1 | admin password; anonymous **off** | No |

Three independent gates on `/metrics`: a port nginx cannot route to, a loopback
bind, and a constant-time bearer check. Any one would do; all three is this
repository's established idiom.

`Bearer` rather than the `x-internal-secret` used elsewhere, because Prometheus
can supply it from `authorization.credentials_file` and cannot supply an
arbitrary custom header — so the token never appears in a scrape config, in
`docker compose config` output, or in git.

### Secret separation

Every service refuses to start if `OBSERVABILITY_SCRAPE_TOKEN` equals any other
secret it holds. `sandboxd` already made that argument about its three scope
secrets; the scrape credential is the most widely distributed of the four and is
held to the same rule.

### Preserved boundaries

- **Prometheus, Grafana and Alertmanager get no Docker socket** and join only
  the `default` network — never `sandboxes`, never `kind`.
- `sandboxd`'s `ENDPOINT_SCOPES` is unchanged; `/metrics` is on a *different
  listener*, so `scopeForEndpoint` never sees it.
- The terminal still holds only the `attach` scope. It gained one read-only
  scrape token and nothing else.
- `x-request-id` is correlation only: validated for shape, never an
  authorization input, never a store key.

---

## 3. Logging

Every line, from every service, is single-line JSON on stdout:

```jsonc
{
  "ts": "2026-08-27T17:31:18.780Z",
  "level": "info",
  "service": "api",
  "event": "lab.start.succeeded",
  "msg": "…",
  "requestId": "…",           // always present on a request path
  "sessionId": "…", "userId": "…", "labId": "K8S-001", "track": "kubernetes",
  "provider": "kubernetes", "outcome": "success", "durationMs": 8421
}
```

`event` is a closed union (`services/observability/src/events.ts`). Adding one
is a reviewed diff, which is where somebody can ask whether the thing should be
logged at all.

### Three gates against leaking a credential

1. **Typed schema, fail-closed.** `logger.info(event, fields)` copies from a
   fixed allow-list. A key the schema does not know is never emitted — not
   renamed, not nested, not stringified. This is why the logger is not `pino`:
   a library's redaction enumerates the paths to *hide* and passes everything
   else, which is fail-open and silent.
2. **Value scanner, independent of the schema.** Every emitted string is scanned
   for secret *shapes* — JWT, Bearer, PEM, DSN, cookie, AWS key, long hex, long
   base64, OAuth parameters, email — because a secret also arrives inside fields
   that are legitimately strings.
3. **Startup self-test.** Each service passes its own configured secrets through
   the scanner and refuses to start if one survives. A future secret generated
   in an unrecognised shape fails the boot instead of appearing in a log file.

The pair of independent gates is the same shape the verifier uses for sandbox
path safety, for the same reason: either alone is one oversight from being
bypassed.

### Hard prohibitions

- **No terminal content.** `services/terminal` and `sandboxd` never log, decode,
  sample or buffer PTY data. Only `data.length` reaches a counter. On the Linux
  track students routinely set passwords and generate keys; a byte count answers
  every operational question and reveals none of it.
- No kubeconfig, session token, cookie, or `Authorization` header.
- No SQL text and no bound parameters — only a bounded `operation` enum.
- No request bodies, query strings, or raw URLs — only the route *template*.
- No stack traces. A stack carries build-host paths and, routinely, the
  arguments of the frame that threw.

`apps/api/test/log-redaction.test.ts` drives the composed application with real
credentials through real channels and searches every captured line.

---

## 4. Metrics

~55 metrics; see `services/observability/src/metrics.ts`, which is the single
place they are constructed so that the whole set is reviewable at once.

### The label policy

**`userId` and `sessionId` are permitted in logs and forbidden in metrics.**
That is not an inconsistency. A Prometheus series is retained for weeks,
readable by everyone with Grafana access, and never collected when the thing it
names stops existing — so an identifying label is a privacy leak and a
cardinality leak at the same time. Logs are access-controlled and
retention-bounded.

`assertLabelPolicy` walks the live registry at startup, so a violating metric
refuses to boot rather than quietly growing a million series. Upstream's
`jtt_process_*` / `jtt_nodejs_*` are exempt by prefix — their labels were
audited once and are bounded, and adding them to the general allow-list would
have permitted `kind` or `major` on our own metrics.

### State is read, not counted

`jtt_sessions_active`, `jtt_sandboxd_containers_managed` and
`jtt_sandboxd_container_sessions` are read from the session store and the
container runtime at scrape time. A counter the application maintains drifts
whenever an increment is missed on an error path — and error paths are where
sessions go missing. That property is load-bearing: the leak alert *subtracts*
container-backed sessions (`provider!="kubernetes"`) from the distinct sessions
among sandboxd's containers, and two independently drifting counters would show
a permanent false difference until somebody silenced the alert. It compares
sessions, not containers: an Ansible session holds three containers and a
Kubernetes session none.

The database probe and pool statistics are the exception — they run on a timer,
not at scrape time. A collector that hangs hangs the scrape, and the scrape is
how an operator learns the database is hanging. The pool gauge additionally read
`waiting=1` on a completely idle platform when it was a collector, because
sibling collectors issue queries inside the same `registry.metrics()` call: it
was measuring its own observer.

### Two counters for lab starts

`jtt_lab_start_total` carries `lab_id` and is for **diagnosis**.
`jtt_lab_start_outcome_total` carries only `outcome`, is initialised to zero for
every value at startup, and is what the **alerts** read.

The reason is measured, not theoretical. With `lab_id`, each series appears once
at 1 on a platform that is not busy, and Prometheus cannot see the 0→1 step of a
series that did not previously exist — so `rate()` returned **0** over a window
in which eight starts genuinely failed. `LabStartsFailingHard` would silently
never have fired on a quiet cohort. See
[IE-3](incident-exercises.md#ie-3--lab-provisioning-failure-spike).

---

## 5. Health and readiness

```text
/livez   is this process alive?           → restart it if not.  Checks NOTHING.
/readyz  can this instance serve?         → route away from it if not.
```

`/livez` checks nothing on purpose. A liveness probe wired to a downstream check
restarts the whole fleet the moment that dependency blips, and the fleet returns
cold into an already-degraded dependency with its telemetry gone.

| Service | Ready when | Deliberately **not** gated on |
|---|---|---|
| api | catalogue loaded **and** (no DB configured **or** DB reachable) | any provider, sandboxd, the terminal, the OIDC issuer |
| terminal | listener bound | sandboxd — a student mid-lab must not lose a live shell over one probe |
| sandboxd | scope secrets distinct **and** runtime reachable | — here the runtime *is* the service |

The rule: readiness answers "will requests to me succeed", never "is the
platform fully functional". The second question is what dashboards are for.

---

## 6. Running it

```bash
make observability-up      # Prometheus, Alertmanager, Grafana
make observability-check   # promtool + amtool + dashboard/alert validation
make observability-down
```

| | |
|---|---|
| Grafana | `http://127.0.0.1:${GRAFANA_PORT:-3001}` — admin / `GRAFANA_ADMIN_PASSWORD` |
| Prometheus | `http://127.0.0.1:${PROMETHEUS_PORT:-9090}` |
| Alertmanager | `http://127.0.0.1:${ALERTMANAGER_PORT:-9093}` |

> On a machine where another project already binds 9090 or 3001, set
> `PROMETHEUS_PORT` / `GRAFANA_PORT` in `.env`.

Alertmanager's receiver is a **webhook stub**. Where alerts actually go is a
deployment decision; this story's job was to produce correct, actionable alerts,
not to choose whose phone rings.

---

## 7. Adding to it

### A metric

1. Construct it in `services/observability/src/metrics.ts` — nowhere else, or
   the label policy cannot see it.
2. `jtt_` prefix, `_total` on counters, base-unit suffix on histograms.
3. Labels must be bounded and non-identifying. `assertLabelPolicy` refuses
   otherwise, with the reasoning.
4. If an **alert** will read it, make sure the series exists from the first
   scrape — initialise it, or aggregate away the sparse dimension. See §4.
5. Add it to the required list in `metrics-labels.test.ts`.

### A log field

Add it to `LogFields` **and** to `ALLOWED_FIELDS` in `logger.ts`;
`logger.test.ts` asserts the two stay in step. Ask whether it can ever carry
something personal or secret.

### An alert

1. Rule file under `prometheus/alerts/`, with `severity`, `summary` and
   `runbook_url`.
2. Write the runbook. `alerts.test.ts` fails the build on a dead link.
3. Give it a `for:` unless it is a security event with no benign explanation.
4. `make observability-check`.

---

## 8. Known limitations

- **No per-sandbox resource metrics.** Would need a per-container agent;
  cAdvisor requires the Docker socket, which is the capability the runtime
  broker exists to remove. The right home is `sandboxd`, which already holds it.
- **No distributed tracing.** Explicitly out of scope for PLATFORM-003.
- **No log aggregation.** JSON to stdout; the deployment picks a collector.
- **No long-term metric storage**; 15-day local retention.
- **Single-instance assumptions.** The terminal keeps its session map in process
  and its workspaces on local disk (PLATFORM-006).
- ~~No database backup~~ — BETA-P0-013 added backup and restore scripts, and
  BETA-P0-018 their freshness metrics and alerts (§9).
- **`prom-client` is pinned to 14.2.0.** 15.x depends on `@opentelemetry/api`,
  and tracing is out of scope; 14.2.0's only dependency is `tdigest`.

---

## 9. Production and the private beta (BETA-P0-018)

Everything above was a development profile. BETA-P0-018 puts it on the
production host for the ~5-student private beta, and adds what the beta needs
to be run: whether HTTPS, backups, isolation and the host are healthy, and
whether sessions are moving. The operator's procedures are
[private-beta-operations.md](runbooks/private-beta-operations.md).

### 9.1 Deployment

```text
docker-compose.yml + runtime + observability + production + production-observability
                                                  (--profile observability)

Internet ──443/80──► web (nginx, TLS)            ── unchanged from P0-012/P0-017
operator ──ssh -L──► 127.0.0.1:3001 ─► Grafana   ── loopback only

┌──────────── one network namespace (network_mode: service:prometheus) ──────────┐
│ Prometheus 127.0.0.1:9090   Alertmanager 127.0.0.1:9093   Grafana :3000 (login) │
└───────────────────────────── joins `default` only ─────────────────────────────┘
     │ scrapes api:9400, terminal:9401, sandboxd:9402 (Bearer, credentials_file)
```

Alertmanager and Grafana share Prometheus's network namespace, so Prometheus
reaches Alertmanager, and Grafana reaches Prometheus, on localhost. In
production both listen on loopback **inside** that namespace, which is what
keeps them away from every other container on the default network — in
particular the terminal, where Kubernetes-track students have a shell. Before
this, on the dev profile, a shell there could reach Prometheus's lifecycle API
and create Alertmanager silences without a credential.

| Surface | Production |
|---|---|
| 443, 80 | web only, every interface — unchanged |
| Grafana | `127.0.0.1:${GRAFANA_PORT:-3001}` on the host; a login page to containers on `default` |
| Prometheus, Alertmanager | not published; unreachable from other containers |
| 3000, 4000, 4001, 4002, 5432, 9400–9402 | not published |

The contract is `infrastructure/secret-distribution.json` →
`stacks.production-observability` and `publishedPorts.operatorLoopback`,
enforced by `make secrets-check` and `compose-secret-distribution.test.ts`.

### 9.2 What the API measures about its deployment

`apps/api/src/operations.ts`, each on its own timer, never inside a scrape:

| Reading | Source | Metrics |
|---|---|---|
| TLS edge | BETA-P0-017's `probeHttpsEndpoint` / `probeHttpRedirect` against `web:8443` / `web:8080`, every 5 min, verified against the public roots | `jtt_tls_check_status{check}` (0/1/2 = the `tls:check` exit code), `jtt_tls_check_findings{check,status,code}`, `jtt_tls_certificate_not_after_timestamp_seconds`, `jtt_tls_check_last_run_timestamp_seconds`, `jtt_tls_probe_enabled` |
| Backups | `BACKUP_STATUS_DIR`, written by `db-backup.sh` and `db-restore.sh --verify-only`, mounted read-only | `jtt_backup_last_{success,failure}_timestamp_seconds{operation}`, `jtt_backup_last_success_size_bytes`, `jtt_backup_last_success_offhost`, `jtt_backup_status_readable` |
| Host | `/proc/meminfo`, `/proc/loadavg`, statfs of `/` (Docker's storage) and the status directory | `jtt_host_memory_{total,available}_bytes`, `jtt_host_load_average{window}`, `jtt_host_cpus`, `jtt_host_filesystem_{size,available}_bytes{filesystem}` |
| Network isolation | BETA-P0-015's `readNetworkEnforcementAttestation`, every 60 s, when required | `jtt_network_isolation_attestation_valid`, `…_verified_timestamp_seconds`, `…_max_age_seconds`, `…_checks_total{result}` |

And, in the product: `jtt_lab_reset_outcome_total{outcome}` and
`jtt_lab_end_outcome_total{outcome}` (`jtt_lab_reset_total` existed and was
never incremented), `jtt_sessions_oldest_status_age_seconds{status}`,
`jtt_sessions_per_student_limit`, `jtt_reaper_last_sweep_errors`,
`jtt_reaper_recoveries_total{reason}`, `jtt_reaper_teardown_incomplete_total{reason}`,
and `jtt_auth_callback_total{outcome}` (defined since PLATFORM-003, never
incremented until now). Every alerting counter is zero-initialised.

None of it has a label carrying a host name, path, fingerprint, finding message
or attestation reason; `private-beta-operations.test.ts` and
`operations-metrics.test.ts` hold that.

### 9.3 Alert thresholds

| Alert | Severity | Threshold | Why this number |
|---|---|---|---|
| `TlsCertificateRenewalDue` | warning | < 21 days, 1 h | P0-017 `DEFAULT_EXPIRY_THRESHOLDS.warnDays` (test-pinned) |
| `TlsCertificateExpiresWithin7Days` | critical | < 7 days, 5 m | `criticalDays` (test-pinned) |
| `TlsEdgeUnhealthy` | critical | served check = 2, 10 m | P0-017 CRITICAL |
| `TlsHttpRedirectBroken` | warning | redirect check = 2, 30 m | ACME HTTP-01 and http:// links |
| `TlsEdgeCheckNotRunning` | warning | no check for 20 m, 10 m | a silent check looks healthy |
| `BackupStale` / `BackupMissedTwice` | warning / critical | 26 h / 50 h | RPO 24 h: one late run, two missed |
| `BackupLastRunFailed`, `BackupVerifyFailed` | warning | newest run failed, 5 m | |
| `BackupNeverSucceeded`, `BackupStatusUnreadable` | warning | 1 h / 30 m | |
| `CapacityExhausted` | critical | any refusal in 10 m, 2 m | one student refused |
| `CapacityNearExhausted` | warning | > 85% for 10 m | at a cap of 5: only 5 of 5 |
| `LabStartsFailingHard` / `…Elevated` | critical / warning | ≥ 3 and > 30% / ≥ 2 and > 10% in 10 m | was 5 / 3, sized for a cap of 20 |
| `LabResetsFailing` | warning | ≥ 3 failed in 30 m | |
| `SessionStuckProvisioning` | warning | CREATING > 10 m | ready timeout 180 s + pull; the reaper tears down an abandoned start at 10 m |
| `SessionResetStuck` | warning | RESETTING > 15 m | the reaper recovers at 10 m |
| `SessionTeardownStuck` | warning | ENDING/EXPIRING > 20 m | resumed at 5 m, retried each sweep |
| `SessionDegradedNotReclaimed` | warning | DEGRADED > 40 m | idle expiry is 20 m |
| `ReaperSweepErrorsPersisting` | warning | errors in every sweep for 15 m | sweeps with errors still count as ok |
| `NetworkIsolationNotAttested` | critical | invalid for 2 m | Kubernetes labs are refused |
| `NetworkIsolationAttestationAging` | warning | > 75% of max age, 10 m | re-probe before admission stops |
| `AuthRejectionsAbnormal` | warning | ≥ 20 rejected credentials in 10 m | `AuthFailureSpike` needs > 1/s |
| `OidcSignInFailures` | warning | ≥ 5 failed callbacks in 15 m | |
| `HostMemoryPressure` / `…Critical` | warning / critical | < 10% / < 5% available | |
| `HostDiskSpaceLow` / `…Critical` | warning / critical | < 15% / < 8% free | |
| `HostCpuSaturated` | warning | load5 > 2 × CPUs, 15 m | |

Two defects were fixed on the way, both of the IE-3 kind (a counting window no
longer than its `for:`): `CapacityExhausted` never fired on a single refusal,
and `JwksFetchFailing` needed twenty straight minutes of failed fetches.
`private-beta-operations.test.ts` now refuses that shape in any alert.

### 9.4 The dashboard

**JTT — Private Beta Operations** (`00-private-beta-operations.json`), one
screen in eight rows: usable now · HTTPS edge · capacity · lifecycle · cleanup
and recovery · isolation, security and sign-in · backups · host.

### 9.5 Not measured

- **Reachability from the internet.** The edge check runs inside the host;
  DNS, a firewall and the public route are seen only by an outside check
  (`npm run tls:check` from another machine) — DECISION REQUIRED.
- **Per-container CPU and memory**, and host pressure beyond the kernel's
  memory, load and two filesystems. A node exporter needs the host's root
  filesystem mounted into a container — DECISION REQUIRED, not done.
- **Pod Security admission denials** (BETA-P0-016). They surface as failed
  provisioning steps; the API server's audit log is not collected.
- **PostgreSQL internals** (replication, bloat, slow queries). `jtt_db_up`,
  pool saturation and query errors come from the API's side.
- **Where alerts are sent** — DECISION REQUIRED; `alertmanager/secrets/webhook-url`
  is the seam.
