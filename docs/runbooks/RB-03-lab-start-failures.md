# RB-03 — Lab start failures

**Alerts:** `LabStartsFailingHard` (critical — ≥5 failures in 10m **and** >30% of attempts),
`LabStartFailureRateElevated` (warning — ≥3 in 10m **and** >10%)
**Typical cause:** a missing sandbox image, a resource ceiling, a full disk, a
provider outage
**Blast radius:** whichever labs share the failing dimension — read section 2
before assuming it is everything.

This is the hardest alert in the set, because **everything else is usually
green**. `up`, `readyz`, `jtt_db_up` and `jtt_sandboxd_runtime_up` can all be
healthy while no student can start a lab. That juxtaposition on the Platform
Overview — one red tile in a row of green — *is* the diagnosis.

## 1. Confirm it is real

```promql
jtt:lab_start_failures:increase10m     # how many failed in the last 10 minutes
jtt:lab_start_failure:ratio10m         # what proportion of attempts that was
sum by (outcome) (increase(jtt_lab_start_outcome_total[10m]))
```

Both halves matter, and the alert requires both. A count alone would page during
a busy class in which five starts failed out of four hundred; a ratio alone is
scale-blind, and one failed start on a quiet evening is a 100% failure ratio.

Use `increase(...)` rather than `rate(...)` when investigating a **burst**. A
five-minute rate forgets a short burst almost as fast as it happened, which is
the defect incident exercise 3 found in this very alert.

`outcome` is a closed enum and it decides which runbook you are actually in:

| outcome | Meaning | Go to |
|---|---|---|
| `capacity_reached` | The platform is full | RB-04 |
| `provider_unavailable` | The substrate is down | RB-09 / RB-06 |
| `provision_failed` | The substrate is up and creation failed | **stay here** |
| `unauthorized` | Callers are not authenticated | RB-14 |

## 2. Scope it — before touching anything

```promql
topk(20, sum by (lab_id, track, provider, outcome) (increase(jtt_lab_start_total[1h])))
```

Four different incidents:

- **one `lab_id`** → lab content or a missing image for that lab
- **one `track`** → that track's provider or its sandbox image
- **one `provider`** → the substrate — RB-09
- **everything** → a shared dependency: the broker, the database, the disk

## 3. Immediate mitigation

There is no generic mitigation, and guessing costs more than the two minutes
step 4 takes. If a single track is failing and a class is in progress, that
track's labs can be made honest by disabling its provider
(`LINUX_PROVIDER_ENABLED=false`) — the catalogue then says "unavailable" rather
than offering a lab that dies on Start.

## 4. Diagnose

1. **Read the step breakdown.** This is the panel this alert exists for:
   ```promql
   histogram_quantile(0.95, sum by (le, step) (rate(jtt_lab_provision_step_duration_seconds_bucket[10m])))
   sum by (step, outcome) (increase(jtt_lab_provision_step_duration_seconds_count[10m]))
   ```
   The failing step names the subsystem — image pull, container create,
   guardrail apply, initial-state wait — which p95 alone never does.

2. **Follow one request across the boundary.** Take a `requestId` from a failed
   start and read the whole chain:
   ```bash
   docker compose logs --no-log-prefix \
     | grep '"event":"lab.start.failed"' | tail -1 | jq -r .requestId
   docker compose logs --no-log-prefix | grep '"requestId":"<that id>"' | jq -s 'sort_by(.ts)'
   ```
   The API line says the start failed; the `sandboxd` line says why. That join
   is the core skill this runbook is teaching.

3. **Images.** `docker images | grep jumptotech`. A missing or wrong-tagged
   sandbox image is the single commonest cause. `make sandbox-build` rebuilds.

4. **Disk.** `docker system df`. A full runtime host fails container creation
   with errors that read like permissions problems.

5. **Resource ceilings.** A `SANDBOX_MEMORY` or `SANDBOX_CPUS` the host cannot
   satisfy fails every create on that provider.

6. **What changed?** The deploy annotations on every dashboard, plus:
   ```promql
   jtt_build_info
   jtt_config_info
   ```
   A recent restart with different `jtt_config_info` labels is your answer more
   often than not.

7. **Read the provider gauge as a hint, not an answer.**

   Measured during incident exercise 3: removing the Linux sandbox image *did*
   flip `jtt_provider_available{provider="linux"}` to 0, because that provider's
   readiness probe checks the image exists. So the gauge is not blind.

   It is also not sufficient. The probe is far cheaper than a real create, so a
   full disk, a resource ceiling the host cannot satisfy, or a registry the
   sandbox cannot reach all produce **green provider, failing starts**. Read the
   two together:

   | provider gauge | starts | Reading |
   |---|---|---|
   | 0 | failing | The substrate is out — RB-09 / RB-06 |
   | 1 | failing | Creation-time only: disk, ceilings, egress. Stay here. |

## 5. Fix

Per section 4: rebuild images, reclaim disk, correct the ceiling, revert the
configuration.

## 6. Verify recovery

- Start success ratio > 0.95 over ten minutes.
- Start one lab **per affected provider**, not just one lab.
- `jtt_lab_provision_duration_seconds` p95 back to its previous band.
- `jtt_session_state_transitions_total{to="FAILED"}` rate back to ~0.
- **Leak check:** a create that failed after the container existed leaves a
  sandbox the store never recorded. `jtt:sandbox_leak:count` must return to
  baseline; `jtt_reaper_reclaimed_total{reason="orphaned"}` should account for
  the difference and then stop climbing.
- One full student loop: start → attach → check → end.

## 7. What this does NOT mean

- **Not capacity.** `jtt_session_capacity_rejections_total` flat means the
  platform is not full — that is RB-04 and a different alert.
- **Not a verification problem.** A student who cannot *pass* a lab is
  `jtt_verification_total{result="fail"}` and is not an incident.

## 8. Escalate when

Failures span every provider and steps 1–6 find nothing, or a class is starting
within the hour.

## 9. Follow-up

If a missing image caused it, ask why the image was missing at deploy time —
that is a pipeline gap, not an operations one.
