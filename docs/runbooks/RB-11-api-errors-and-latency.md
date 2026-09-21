# RB-11 — API errors, latency, event-loop lag

**Alerts:** `ApiErrorRateHigh` (warning, >2% 5xx), `ApiLatencyHigh` (warning,
p95 > 1s), `EventLoopLagHigh` (warning, p99 > 200ms)
**Blast radius:** everything the API serves.

Commands use `prod` and `q` from [private-beta-operations.md §1](private-beta-operations.md).

## 1. Confirm it is real

```promql
jtt:http_error:ratio10m{service="api"}
jtt:http_duration:p95_10m{service="api"}
jtt_nodejs_eventloop_lag_p99_seconds{service="api"}
```

Four routes are **excluded** from the latency expression, because each is bounded
by the lab runtime, not by the API, and including them would make correct
behaviour look like an incident:

| Route | Bounded by | Its own alert |
|---|---|---|
| `POST /api/labs/:id/start` | sandbox provisioning | `ProvisioningSlow` (RB-10) |
| `DELETE /api/sessions/:sessionId` | teardown | the reaper alerts (RB-05) |
| `POST /api/sessions/:sessionId/check` | reading live state in the sandbox | `VerificationSlow`, `VerificationErrorRate` (RB-13) |
| `POST /api/sessions/:sessionId/reset` | rebuilding the sandbox | `LabResetsFailing`, `SessionResetStuck` (RB-17) |

Check and Reset were added by BETA-P0-019. With five concurrent students a check
took 1.05s at p50 and 2.2s at p95. Students checking their work every few minutes
kept `ApiLatencyHigh` firing for a whole class.

## 2. Scope it

```promql
topk(10, sum by (route) (increase(jtt_http_requests_total{service="api",status_class="5xx"}[1h])))
```

One route or all of them?

- **One route** → that handler or its dependency.
- **All routes, high event-loop lag** → the process is CPU-bound; everything is
  slow including `/livez`.
- **All routes, normal lag** → a shared dependency, usually the database
  (RB-02 — `DatabaseDown` inhibits `ApiErrorRateHigh` for exactly that reason;
  `ApiLatencyHigh` and `EventLoopLagHigh` still fire beside it).

## 3. Immediate mitigation

```bash
prod restart api
```

Safe: sessions and sign-ins are durable, sandboxes survive. It buys time; it is
not a diagnosis, and a leak will come back.

## 4. Diagnose

1. Find the errors — they are never sampled:
   ```bash
   prod logs --no-log-prefix api | grep '"event":"http.request.failed"' | jq -s 'group_by(.route) | map({route: .[0].route, n: length})'
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
- **Not a database outage** unless `jtt_db_up == 0`, in which case
  `DatabaseDown` fired first and inhibited `ApiErrorRateHigh` (not the latency
  alerts: read those as symptoms of it).
- A 4xx spike is not this alert. 401s on `/auth/session` from unauthenticated
  browsers are entirely normal.

## 8. Escalate when

Repeated restarts, or an error rate that survives one.

## 9. Follow-up

The API is single-instance in the shipped compose stack. Horizontal scale is
PLATFORM-006 scope; note the load numbers if capacity was a factor.
