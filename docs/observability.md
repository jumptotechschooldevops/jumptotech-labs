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
                   │ Grafana     :3001   │  8 dashboards, provisioned as code
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

`jtt_sessions_active` and `jtt_sandboxd_containers_managed` are read from the
session store and the container runtime at scrape time. A counter the
application maintains drifts whenever an increment is missed on an error path —
and error paths are where sessions go missing. That property is load-bearing:
the leak alert *subtracts* the two, and two independently drifting counters
would show a permanent false difference until somebody silenced the alert.

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
- **No database backup**, and therefore no restore procedure. RB-02 says so
  rather than implying one.
- **`prom-client` is pinned to 14.2.0.** 15.x depends on `@opentelemetry/api`,
  and tracing is out of scope; 14.2.0's only dependency is `tdigest`.
