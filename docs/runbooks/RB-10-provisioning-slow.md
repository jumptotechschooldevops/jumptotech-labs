# RB-10 — Provisioning is slow

**Alert:** `ProvisioningSlow` (warning, p95 > 60s for 15m)
**Blast radius:** students wait, then some time out. Not an outage yet, and
often the first sign of one.

## 1. Confirm it is real

```promql
jtt:lab_provision_duration:p95_15m
```

Sixty seconds is generous on purpose — a Docker-track sandbox legitimately takes
up to `DOCKER_SANDBOX_READY_TIMEOUT_SECONDS` (180s) plus an image pull. Sustained
p95 above 60s across providers is not normal.

## 2. Scope it — the step breakdown, first

```promql
histogram_quantile(0.95, sum by (le, step) (rate(jtt_lab_provision_step_duration_seconds_bucket[15m])))
```

This is the panel this alert exists for. p95 says provisioning is slow; the step
says *which part*, which is the difference between a diagnosis and an
afternoon.

## 3. Immediate mitigation

If one track is unusable and a class is running, disabling that provider makes
the catalogue honest rather than leaving students on a spinner.

## 4. Diagnose

1. **Image pull slow** → egress or no registry mirror. Docker labs pull base
   images *inside* each sandbox, so ten concurrent sessions pull the same image
   ten times. `DOCKER_SANDBOX_REGISTRY_MIRROR` is the intended answer.
2. **Container create slow** → the host. `docker system df`, disk IO, and
   whether the daemon is also serving something else.
3. **Guardrail apply slow (Kubernetes)** → API server latency, or an admission
   webhook.
4. **Initial-state wait slow** → the lab's declared starting state is taking
   time to materialise; scheduling pressure or image pulls in the cluster.
5. Correlate with load:
   ```promql
   sum(jtt_sessions_active)
   sum(rate(jtt_lab_start_total[5m]))
   ```
   Slow only at peak is capacity; slow always is infrastructure.

## 5. Fix

Per section 4: a registry mirror, host resources, or reduced concurrency.

## 6. Verify recovery

- `jtt:lab_provision_duration:p95_15m` back under 30s per provider.
- The previously slow step back in its normal band.
- Start success ratio unchanged or better — a fix that speeds provisioning by
  failing faster is not a fix.

## 7. What this does NOT mean

- **Not `ApiLatencyHigh`.** Start Lab is deliberately excluded from the API
  latency alert precisely so slow provisioning does not double-report.
- Not necessarily a failure: slow and failing are different, and
  `jtt_lab_start_total{outcome="provision_failed"}` says which.

## 8. Escalate when

p95 exceeds the client timeout so students see failures rather than waits, or
every provider is slow (a host problem, not a platform one).

## 9. Follow-up

Sandbox images are not pre-seeded and there is no image-layer sharing between
sessions. If pulls dominated, a registry mirror is a configuration change worth
making permanently.
