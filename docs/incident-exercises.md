# Incident exercises

**PLATFORM-003.** Three rehearsed failures, each with an injection method, the
signals it should produce, and the recovery checklist that proves it is over.

Everything below was **executed against a running stack**, and the timings are
what was observed rather than what was expected. Where the two differed, the
difference is recorded — three of the four defects PLATFORM-003 fixed were found
here and nowhere else.

Run them:

```bash
make observability-up
# then follow one exercise at a time; do not run two at once
```

> Each exercise deliberately breaks the platform. Run them on a development
> stack. `docker compose stop` is used rather than `down` throughout, so no
> volume is destroyed.

---

## What these exercises are for

Not to prove the alerts fire — `alerts.test.ts` does that more cheaply. They
exist to rehearse the **reading**: which panel is looked at first, which two
signals distinguish two incidents that present identically, and which runbook is
the right one. That skill has to be practised before it is needed, and it is not
transferable from a document.

---

## IE-1 — PostgreSQL unavailable

**Runbook:** [RB-02](runbooks/RB-02-database.md) · **Severity:** critical

### Injection

```bash
docker stop jumptotech-labs-postgres-1
```

Use `docker stop` on the container, **not** `docker compose stop postgres`
followed by a compose action on the API — `api` declares
`depends_on: postgres: condition: service_healthy`, so any `compose up` restarts
the database and ends the outage. That mistake was made the first time this was
run and cost the exercise.

### Observed

| t | `jtt_db_up` | `/livez` | `/readyz` | Alerts |
|---|---|---|---|---|
| +15s | 0 | **200** | 503 | none |
| +30s | 0 | **200** | 503 | `DatabaseDown` pending |
| +45s | 0 | **200** | 503 | + `ServiceNotReady` pending |
| +75s | 0 | **200** | 503 | **`DatabaseDown` firing** |

`/livez` stayed 200 throughout. That is the single most important line in this
table: liveness checks nothing, so a database outage never becomes a restart
storm that takes the telemetry down with it.

`/readyz` returned a bounded reason and nothing more:

```json
{"name": "database", "ok": false, "reason": "unreachable"}
```

No DSN, no host, no exception text — the endpoint is unauthenticated, so
everything it returns is public.

### Blast radius, as measured

**Larger than expected, and the runbook was corrected because of it.** Every
`/api/*` route returned **401**, including the catalogue, because `authenticate`
resolves the caller through the Postgres-backed user store. RB-02 originally
claimed the catalogue kept serving; it does not.

That matters operationally: a database outage presents as *universal 401*, which
looks like an authentication incident. `jtt_db_up` is what tells them apart.

### A defect this found

`GET /health` returned **500** during the outage — it reads the session count,
which queries the database. The rich operator endpoint went dark exactly when it
was needed. Every dependency read in `/health` is now individually guarded and
reports `active: -1` (deliberately not 0, which would be a reassuring lie).

### Logs

```json
{"level":"error","event":"http.request.failed","err":{"name":"Error","message":"getaddrinfo ENOTFOUND postgres","code":"ENOTFOUND"}}
{"level":"warn","event":"http.request.completed","route":"/health","status":500}
```

`grep -ciE "postgres://|password=" ` over the whole outage log: **0 matches**.

### Recovery — verified

```bash
docker start jumptotech-labs-postgres-1
```

| Check | Observed |
|---|---|
| `jtt_db_up` | 1 within 15s |
| `/readyz` database check | `{"name":"database","ok":true}` |
| Schema intact | `jtt_migration_version_info{version="004_auth_sessions"} 1` |
| Pool waiting | 0 |
| Start a lab | HTTP 200 |
| Alertmanager | `DatabaseDown` active → resolved |

The schema check is not ceremony: a database that returns on an **empty volume**
is healthy by every other measure — it accepts connections, the pool is fine,
`jtt_db_up` is 1 — and a cohort's history is gone. `jtt_migration_version_info`
was declared but never populated until this exercise asked for it.

---

## IE-2 — Container/sandbox provider unavailable

**Runbook:** [RB-06](runbooks/RB-06-sandboxd.md), [RB-09](runbooks/RB-09-provider-unavailable.md) · **Severity:** critical

### Injection

```bash
docker stop jumptotech-labs-sandboxd-1
```

The exercise has two halves, and telling them apart is the point:

| `up{job="sandboxd"}` | `jtt_sandboxd_runtime_up` | Meaning |
|---|---|---|
| 0 | (no data) | The **broker** is gone — this injection |
| 1 | 0 | The **Docker daemon** under it is gone |

### Observed

Baseline: `runtime_up=1`, 6 providers available, blast radius per provider —

```
  linux 48   docker 14   terraform 13   ansible 10   cicd 10   kubernetes 19
```

| t | providers up | api `/readyz` | Alerts |
|---|---|---|---|
| +15s | **1** (kubernetes only) | **200** | 5 × `ProviderUnavailable` pending, `ServiceDown` pending |
| +135s | 1 | **200** | **`ServiceDown` firing** |

**`/readyz` on the API stayed 200 for the entire outage.** Five of nine tracks —
81 labs — were unstartable, and the API remained ready, because it could still
serve the catalogue, progress, authentication and all 19 Kubernetes labs. Going
unready would have converted a partial outage into a total one and pulled the
instance out of the load balancer, which is where its metrics were being scraped
from.

### A defect this found

Six notifications for one root cause. `ServiceDown` carries `service="sandboxd"`
(the service that is down) while `ProviderUnavailable` carries `service="api"`
(the service that *reports* it), so the `equal: ['service']` inhibition never
matched.

Fixed with two rules keyed on `sandbox_kind="container"` — chosen so that a
genuine **Kubernetes** provider outage is never suppressed by a broker problem.
After the fix:

```
  ProviderUnavailable  terraform  suppressed
  ProviderUnavailable  docker     suppressed
  ProviderUnavailable  linux      suppressed
  ProviderUnavailable  cicd       suppressed
  ProviderUnavailable  ansible    suppressed
  ServiceDown                     active
```

### Recovery — verified

```bash
docker start jumptotech-labs-sandboxd-1
```

| Check | Observed |
|---|---|
| Providers available | 1 → **6 within 45s**, with **no API restart** |
| Start a Linux lab | HTTP 200 |
| `jtt_sandboxd_scope_denials_total` | 0 — the restart did not scramble credentials |
| Alerts | all resolved |

The 45s recovery matters: the registry's 30-second availability memo expires on
its own. RB-06 says explicitly not to restart the API to "clear" provider
status, and this is the measurement behind that instruction.

---

## IE-3 — Lab provisioning failure spike

**Runbook:** [RB-03](runbooks/RB-03-lab-start-failures.md) · **Severity:** critical

The hardest of the three, because **everything else stays green**.

### Injection

```bash
docker rmi -f jumptotech/lab-linux:latest
for i in 1 2 3 4 5 6 7 8; do
  curl -s -o /dev/null -X POST http://127.0.0.1:4000/api/labs/LINUX-00$i/start
done
```

### Observed — the diagnostic juxtaposition

```
  runtime_up   = 1
  db_up        = 1
  api readyz   = 200
  every start  -> HTTP 503 SESSION_PROVISION_FAILED
```

That row *is* the diagnosis. On the Platform Overview it appears as one red tile
— "students can start labs" — in a row of green ones.

**Scope**, from the labels alone:

```
jtt_lab_start_total{track="linux",lab_id="LINUX-002",provider="linux",outcome="provision_failed"} 1
… 8 series, every one provider="linux"
```

One track, not everything.

**Which step**, which is what the step histogram exists for:

```
jtt_lab_provision_step_duration_seconds_count{provider="linux",step="environment-created",outcome="failed"} 8
```

**The broker's view** — `create` refused while `ping` succeeds, which is the
discriminator RB-03 §4 describes:

```
jtt_sandboxd_runtime_ops_total{op="ping",outcome="success"}   12
jtt_sandboxd_runtime_ops_total{op="create",outcome="refused"}  8
```

### Two defects this found

**1. The headline alert could not fire.** `sum(rate(jtt_lab_start_total[5m]))`
returned **0** while the counter itself read 8. `jtt_lab_start_total` carries
`lab_id`, so each series appeared once, already at 1 — and Prometheus cannot see
the 0→1 step of a series that did not previously exist. `LabStartsFailingHard`,
the platform's headline student-facing alert, would silently never have fired on
a cohort that was not busy.

Fixed with `jtt_lab_start_outcome_total`, carrying only `outcome` and
initialised to zero for every value at startup, so each series exists from the
first scrape. After the fix, the same injection gave
`jtt:lab_start_failure:ratio5m = 1`.

**2. A runbook claim was too strong.** RB-03 said "a green provider tile does not
mean labs can start". Measured: removing the image *did* flip
`jtt_provider_available{provider="linux"}` to 0, because that provider's probe
checks the image exists. The claim is true in general — a full disk or a
resource ceiling would not be caught — but it was overstated, and RB-03 now
carries a two-signal table instead.

### Escalation order, under sustained failure

A single burst is not enough: `LabStartsFailingHard` reached `pending` and then
resolved as the 5-minute window rolled past the burst. Under **sustained**
failures (one start every 3s, which is what a class retrying looks like):

| t | fail ratio | Alerts |
|---|---|---|
| +25s | 1.0 | `ProviderUnavailable` firing |
| +200s | 1.0 | + `LabStartFailureRateElevated`, `ApiErrorRateHigh` firing |
| +350s | 1.0 | + **`LabStartsFailingHard` firing** |

That a one-shot burst does not page anybody is correct behaviour, and worth
knowing before an incident rather than during one.

### Recovery — verified

```bash
make sandbox-build
```

| Check | Observed |
|---|---|
| `jtt_provider_available{provider="linux"}` | 1 within 20s |
| Start one lab **per affected provider** | LINUX-001 200, TF-001 200, K8S-001 200 |
| Step outcomes | `outcome="ok"` across kubernetes, terraform, linux |

Starting one lab per provider, not one lab, is the point of that step: a single
success proves one path.

---

## Summary

| Exercise | Alert fired | Time to fire | Defect found |
|---|---|---|---|
| IE-1 PostgreSQL | `DatabaseDown` | 75s | `/health` 500s during a DB outage; schema-version metric never populated; RB-02 blast radius wrong |
| IE-2 Broker | `ServiceDown` | 135s | Inhibition never matched — 6 pages for 1 cause |
| IE-3 Provisioning | `LabStartsFailingHard` | 350s (sustained) | `rate()` blind to sparse per-lab series — headline alert could not fire |

Every one of those was invisible to the unit tests, to `promtool`, and to
reading the code. They were found by breaking a running platform and looking at
what an operator would actually see.
