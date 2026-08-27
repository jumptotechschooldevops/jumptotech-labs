# Incident troubleshooting

**PLATFORM-003.** The eleven questions an operator actually asks, and exactly
where each is answered.

Before PLATFORM-003 the honest answer to most of these was "read the container
logs and guess". This page exists so that during an incident nobody has to
remember which metric is which.

---

## The eleven questions

| Question | Where | Signal |
|---|---|---|
| **Is the platform healthy?** | Overview, top row | `up`, `jtt_readyz_ok`, and the five dependency tiles |
| **Are students able to start labs?** | Overview tile | `jtt:lab_start_success:ratio5m` |
| **Which provider is failing?** | Providers, availability matrix | `jtt_provider_available` × `jtt_provider_labs_total` |
| **Are sandboxes leaking?** | Sandbox/Runtime, leak panel | `jtt:sandbox_leak:count` |
| **Is capacity exhausted?** | Overview + Lab Sessions | `jtt_session_capacity_rejections_total` |
| **Is PostgreSQL unhealthy?** | Database | `jtt_db_up`, pool `waiting` |
| **Are terminals failing?** | Terminal | `jtt_terminal_connections_total{outcome}` |
| **Are verification requests failing?** | API, verification panel | `jtt_verification_total{result="error"}` |
| **Is authentication failing unusually?** | Auth/Security | `jtt:auth_failure:ratio5m`, `denied-not-owner` rate |
| **Are cleanup jobs working?** | Overview tile | `jtt:reaper_seconds_since_success` |
| **What changed before this?** | Every dashboard | Deploy annotations, `jtt_build_info`, `jtt_config_info` |

---

## Three distinctions that decide which runbook you are in

Most wasted incident time is spent on a plausible wrong diagnosis. These three
pairs present almost identically and have completely different fixes.

### 1. Database dead vs application starved

```promql
jtt_db_up                                  # 0 = the database is unreachable
jtt_db_pool_connections{state="waiting"}   # >0 with db_up=1 = the app is starved
```

Both look like "everything is slow" to a student. The first is
[RB-02 §4a](runbooks/RB-02-database.md), the second is §4b.

### 2. Broker gone vs runtime gone

```promql
up{job="sandboxd"}          # 0 = the broker process
jtt_sandboxd_runtime_up     # 0 with up=1 = the Docker daemon under it
```

The two metrics exist separately for exactly this. [RB-06](runbooks/RB-06-sandboxd.md).

### 3. Verification failing vs students not finishing

```promql
jtt_verification_total{result="error"}   # the environment is unreadable — an outage
jtt_verification_total{result="fail"}    # a student has not solved it yet — normal
```

Collapsing these into "not passed" would page somebody every time a class
starts. Only `error` alerts. [RB-13](runbooks/RB-13-verification.md).

---

## Following one request across three services

The thing PLATFORM-003 changed most about debugging. Before it, "the API logged
an error" and "sandboxd logged an error" were two observations; now they are one
story.

```bash
# From a student's report — the id is returned in the x-request-id response header
docker compose logs --no-log-prefix | grep '"requestId":"<id>"' | jq -s 'sort_by(.ts)'

# From a symptom: find a recent failure, then follow its id
RID=$(docker compose logs --no-log-prefix \
      | grep '"event":"lab.start.failed"' | tail -1 | jq -r .requestId)
docker compose logs --no-log-prefix | grep "\"requestId\":\"$RID\"" | jq -s 'sort_by(.ts)'
```

A real trace looks like this:

```
[api]      session.transition
[api]      lab.start.succeeded    outcome=success labId=LINUX-002
[api]      http.request.completed status=200
[sandboxd] sandbox.runtime.op     op=remove outcome=success
[sandboxd] sandbox.runtime.op     op=create outcome=success
```

**`requestId` is correlation only.** It is validated for shape and never used
for authentication, authorization, routing, or as a key into any store. A client
supplying its own can pollute its own correlation and nothing else.

### Useful log filters

```bash
# Everything security-relevant
docker compose logs --no-log-prefix | grep '"event":"security.event"' | jq .

# Authorization denials, grouped by user
docker compose logs --no-log-prefix | grep '"authorizationResult":"denied-not-owner"' \
  | jq -r '[.userId, .action] | @tsv' | sort | uniq -c | sort -rn

# Every error, any service
docker compose logs --no-log-prefix | jq -c 'select(.level=="error")'
```

---

## Health endpoints

| Endpoint | Port | Auth | Use it for |
|---|---|---|---|
| `/livez` | 9400/9401/9402 | none | "Should this process be restarted?" — checks **nothing** |
| `/readyz` | 9400/9401/9402 | none | "Can this instance serve?" — names the failing dependency |
| `/metrics` | 9400/9401/9402 | Bearer | Scraping |
| `/health` | 4000 | none | The rich operator view: providers, labs, capacity, store |

**Use `/readyz` during an incident, not `/health`.** `/health` reads more
dependencies, so it degrades alongside them — it now reports `active: -1` rather
than failing outright, but `/readyz` names the failing check directly and is on
a listener that shares nothing with the student-facing one.

### What readiness deliberately ignores

`/readyz` on the API stays **200** when every provider is unavailable. It gates
only on what makes *this instance* unable to serve: the lab catalogue, and the
database when one is configured.

Measured in [IE-2](incident-exercises.md#ie-2--containersandbox-provider-unavailable):
81 labs across five tracks were unstartable and the API stayed ready, because it
was still serving the catalogue, progress, authentication and 19 Kubernetes
labs. Failing readiness there would have turned a partial outage into a total
one — and removed the instance from the load balancer, which is where its
metrics were being read from.

---

## When the dashboards are all green and something is still wrong

This is [IE-3](incident-exercises.md#ie-3--lab-provisioning-failure-spike), and
it is the case worth rehearsing.

1. **"Students can start labs" is the tile that matters.** It can be red while
   every other tile is green. That juxtaposition is the diagnosis.
2. **Scope before touching anything.** `topk` over `lab_id`, `track`, `provider`
   — one lab, one track, one provider and everything are four incidents.
3. **Read the provisioning step breakdown.** p95 says provisioning is slow; the
   step says which subsystem, which is the difference between a diagnosis and
   an afternoon.
4. **Follow one requestId across the boundary.** The API line says a start
   failed; the sandboxd line says why.
5. **Check what changed.** Deploy annotations are on every dashboard, and
   `jtt_config_info` carries the switches that alter behaviour.

---

## What this platform still cannot tell you

Stated plainly, because a monitoring document that implies more coverage than
exists is worse than one that admits the gap.

- **No per-sandbox CPU or memory.** That needs a per-container agent, and the
  only sane way to collect it is through `sandboxd`, which already holds the
  runtime. cAdvisor would need the Docker socket, which is the exact capability
  the runtime broker exists to remove.
- **No distributed tracing.** Correlation ids join log lines across services;
  they do not give you a span waterfall. Out of scope for PLATFORM-003.
- **No browser-side telemetry.** Everything here is server-side.
- **No long-term metric storage.** Local Prometheus, 15-day retention.
- **No per-user or per-cohort view.** `userId` is deliberately absent from every
  metric label; it exists in logs only.
- **No database backup, and therefore no restore procedure.** RB-02 says so
  explicitly rather than implying one exists.
