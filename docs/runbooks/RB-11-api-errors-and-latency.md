# RB-11 — API errors, latency, event-loop lag

**Alerts:** `ApiErrorRateHigh` (warning, >2% 5xx), `ApiLatencyHigh` (warning,
p95 > 1s), `EventLoopLagHigh` (warning, p99 > 200ms)
**Blast radius:** everything the API serves.

## 1. Confirm it is real

```promql
jtt:http_error:ratio10m{service="api"}
jtt:http_duration:p95_10m{service="api"}
jtt_nodejs_eventloop_lag_p99_seconds{service="api"}
```

`POST /api/labs/:id/start` is **excluded** from the latency expression. It is
bounded by sandbox provisioning, not by the API, and including it would make
correct behaviour look like an incident. It has its own panel and its own alert
(RB-10).

## 2. Scope it

```promql
topk(10, sum by (route) (increase(jtt_http_requests_total{service="api",status_class="5xx"}[1h])))
```

One route or all of them?

- **One route** → that handler or its dependency.
- **All routes, high event-loop lag** → the process is CPU-bound; everything is
  slow including `/livez`.
- **All routes, normal lag** → a shared dependency, usually the database
  (RB-02 — and `DatabaseDown` inhibits this alert for exactly that reason).

## 3. Immediate mitigation

```bash
docker compose restart api
```

Safe: sessions and sign-ins are durable, sandboxes survive. It buys time; it is
not a diagnosis, and a leak will come back.

## 4. Diagnose

1. Find the errors — they are never sampled:
   ```bash
   docker compose logs api | grep '"event":"http.request.failed"' | jq -s 'group_by(.route) | map({route: .[0].route, n: length})'
   ```
2. Pick a `requestId` and follow it across services.
3. **Memory:** `jtt_nodejs_heap_size_used_bytes` climbing without falling back
   after GC is a leak. `jtt_nodejs_gc_duration_seconds` rising alongside
   confirms it.
4. **Event-loop lag** with normal heap points at synchronous work — a large
   JSON parse, a big synchronous read.
5. **In-flight requests** climbing while throughput does not means requests are
   piling up behind something:
   ```promql
   jtt_http_requests_in_flight{service="api"}
   ```
6. Deploy annotations: did this start at a restart?

## 5. Fix

Per section 4.

## 6. Verify recovery

- 5xx ratio under 0.5%.
- p95 back in its normal band.
- Event-loop p99 under 50ms.
- Heap stable across two GC cycles.
- One full student loop.

## 7. What this does NOT mean

- **Not `ProvisioningSlow`.** Start Lab is excluded here.
- **Not a database outage** unless `jtt_db_up == 0`, in which case that alert
  fired first and inhibited this one.
- A 4xx spike is not this alert. 401s on `/auth/session` from unauthenticated
  browsers are entirely normal.

## 8. Escalate when

Repeated restarts, or an error rate that survives one.

## 9. Follow-up

The API is single-instance in the shipped compose stack. Horizontal scale is
PLATFORM-006 scope; note the load numbers if capacity was a factor.
