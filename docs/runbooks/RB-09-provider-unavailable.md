# RB-09 — A provider cannot run labs

**Alert:** `ProviderUnavailable` (warning)
**Blast radius:** exactly `jtt_provider_labs_total` for that provider — the
Providers dashboard turns "docker is down" into "fourteen labs cannot start".

## 1. Confirm it is real

```promql
jtt_provider_available == 0 and on(provider) jtt_provider_labs_total > 0
```

The `labs_total > 0` clause matters: the **AWS provider reports unavailable
forever by design**. It provisions nothing, has no configuration flag that turns
it on, and its labs are simulated. It must never page anybody, and it does not.

## 2. Scope it

One provider, or several at once?

- **Five container providers together** (linux, terraform, ansible, cicd,
  docker) → they share `sandboxd`. This is RB-06.
- **`kubernetes` alone** → the cluster.
- **`docker` alone** → the Docker track needs a host that permits its sandbox;
  check `DOCKER_TRACK_ENABLED`.

## 3. Immediate mitigation

The catalogue already handles this honestly: an unavailable provider's labs
appear with the real reason rather than disappearing or failing on click. No
student is misled while you work.

## 4. Diagnose

1. The reason is in the log, not the metric — free text cannot be a label:
   ```bash
   docker compose logs api | grep '"event":"provider.availability.changed"'
   ```
2. `curl -s localhost:4000/health | jq '.data.providers'` gives every provider's
   current status and reason in one place.
3. Kubernetes: `kubectl get nodes`, and confirm the API can reach the API server
   (`jtt_config_info` shows the configured substrate).
4. Container providers: RB-06.
5. Probe duration climbing before it flipped suggests the backend was already
   struggling:
   ```promql
   histogram_quantile(0.95, sum by (le, provider) (rate(jtt_provider_availability_probe_duration_seconds_bucket[30m])))
   ```

## 5. Fix

Whatever the reason names. Availability is re-probed every 30 seconds, so a
recovered backend flips the gauge back **without an API restart** — do not
restart to "refresh" it.

## 6. Verify recovery

- `jtt_provider_available == 1` within 30 seconds of the backend recovering.
- Start one lab on that provider.
- `jtt_lab_start_total{provider="…",outcome="success"}` increments.

## 7. What this does NOT mean

- **A green provider does not mean labs can start.** The probe is a cheap
  readiness ping; it does not exercise container creation. Creation failing
  while the probe passes is RB-03.
- Not a capacity problem, and not a database problem.

## 8. Escalate when

A provider is unavailable for more than an hour with a class scheduled, or the
Kubernetes substrate is down (kind is development infrastructure and has no
failover).

## 9. Follow-up

If this was the Kubernetes provider, note that `LAB_PROVIDER` supports only
`kind` and kind is explicitly not a production substrate. An EKS provider is
PLATFORM-007 scope.
