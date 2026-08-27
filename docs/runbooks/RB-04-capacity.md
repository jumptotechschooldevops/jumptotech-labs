# RB-04 — Capacity exhausted

**Alerts:** `CapacityExhausted` (critical), `CapacityNearExhausted` (warning, >85%)
**Typical cause:** more students than `MAX_ACTIVE_SESSIONS`, or sessions that
are not being reclaimed
**Blast radius:** every student trying to start a lab is refused.

## 1. Confirm it is real

```promql
jtt:sessions_utilization:ratio
increase(jtt_session_capacity_rejections_total[5m])
```

The alert is on **refusals**, not utilisation. 100% utilisation with nobody
being turned away is a full platform working exactly as designed; a refusal is
a student who was told no. There is no queue past the cap.

## 2. Scope it

```promql
sum by (provider, status) (jtt_sessions_active)
max(jtt_sessions_capacity_limit)
jtt:sandbox_leak:count
```

**Is the platform genuinely full, or is it holding sessions nobody is using?**

- Sessions active ≈ students actually working → real demand, section 5a.
- Sessions active ≫ plausible student count → they are not being reclaimed,
  section 5b, and RB-05.

## 3. Immediate mitigation

Raise the cap only if the host can carry it:

```bash
# .env
MAX_ACTIVE_SESSIONS=40
docker compose up -d api
```

Each session is a real container or namespace with real CPU and memory. Raising
the cap past what the host can serve converts "some students are refused" into
"every student's lab is slow", which is worse and harder to diagnose.

## 4. Diagnose

1. Session ages: a healthy population turns over on `IDLE_TIMEOUT_MINUTES` (20)
   and `MAX_SESSION_MINUTES` (60).
   ```promql
   histogram_quantile(0.95, sum by (le) (rate(jtt_session_lifetime_seconds_bucket[1h])))
   ```
2. End reasons — are sessions ending at all?
   ```promql
   sum by (reason) (rate(jtt_lab_end_total[30m]))
   ```
   All `student` and no `idle`/`expired` means the reaper is not running: RB-05.
3. `jtt:reaper_seconds_since_success` — anything above 300 is RB-05 first.
4. **Abandoned tabs are the usual answer.** A student who closed their laptop
   holds a session until the idle timeout. Polling session status deliberately
   does not count as activity, precisely so this self-corrects.

## 5a. Fix — real demand

Raise `MAX_ACTIVE_SESSIONS` within host capacity, or lower
`IDLE_TIMEOUT_MINUTES` so abandoned sessions return sooner. Both take effect on
`docker compose up -d api` and neither disturbs a running session.

## 5b. Fix — not being reclaimed

RB-05. Capacity is a symptom.

## 6. Verify recovery

- `increase(jtt_session_capacity_rejections_total[5m]) == 0`.
- `jtt:sessions_utilization:ratio` below 0.85.
- A lab starts.
- `jtt_lab_end_total{reason="idle"}` is non-zero over the next half hour —
  proof that reclamation is happening, not just that the number went down.

## 7. What this does NOT mean

- **Not `ProvisioningSlow`.** Full and slow are different.
- **Not a leak** unless `jtt:sandbox_leak:count` says so. A leak is containers
  with *no* session; this is sessions that are real and idle.

## 8. Escalate when

Capacity is exhausted with a class in progress and the host cannot take a
higher cap. There is no scheduling across hosts — that is a known limitation,
not a misconfiguration.

## 9. Follow-up

Per-user session limits do not exist yet: one student can hold many sessions and
there is no rate limit on Start Lab. That is PLATFORM-004 scope and this
incident is evidence for it — record the numbers.
