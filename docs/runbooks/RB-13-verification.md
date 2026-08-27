# RB-13 — Verification requests failing

**Alert:** `VerificationErrorRate` (warning, >5% of checks error)
**Blast radius:** students cannot get their work marked. Their environment and
their progress are intact.

## 1. Confirm it is real

```promql
jtt:verification_error:ratio10m
sum by (result) (rate(jtt_verification_total[10m]))
```

**`result` has three values and only one of them is an incident:**

| result | Meaning |
|---|---|
| `pass` | Solved |
| `fail` | **Not solved yet — the most normal event in the product** |
| `error` | The environment could not be read — an outage |

An alert on "not passed" would page somebody every time a class starts. This
alert is on `error` alone, and the API already returns 503 rather than telling
the student they failed.

## 2. Scope it

```promql
sum by (code) (increase(jtt_verification_errors_total[30m]))
topk(10, sum by (lab_id, result) (increase(jtt_verification_total{result="error"}[1h])))
```

One lab, one track, or everything? One lab is content or a requirement handler;
everything is the substrate.

## 3. Immediate mitigation

None. A student's work is safe and re-checking will succeed once the substrate
is readable — the check is a pure read.

## 4. Diagnose

1. The error codes are the substrate saying it is unreachable —
   `KubernetesUnreachable`, `DockerUnreachable` and friends. Follow to RB-09 or
   RB-06.
2. Per requirement *type*, which is the dimension that finds a broken handler:
   ```promql
   sum by (requirement_type, result) (increase(jtt_verification_requirement_total[1h]))
   ```
   One `requirement_type` failing across many unrelated labs is a platform
   regression, not a content problem. A per-lab view would show that as a
   scattering and hide the cause.
3. Follow a `requestId` from `"event":"verify.errored"` into the provider call.
4. Deploy annotations: a verifier change or a lab-content change just before it
   started?

## 5. Fix

Usually the substrate. If one requirement type regressed, that is a code fix and
the affected labs are unmarkable until it lands.

## 6. Verify recovery

- Error ratio under 1%.
- Run a real check on a solved lab and see `pass`.
- Run one on an unsolved lab and see `fail` — proof the verifier is
  discriminating rather than passing everything.
- `jtt_verification_duration_seconds` p95 back to normal.

## 7. What this does NOT mean

- **A rising `fail` rate is not an incident.** It is students working. If a
  *specific* lab flips from mostly-pass to all-fail after a content deploy, that
  is a content regression worth a ticket — but not this alert.

## 8. Escalate when

A requirement type is broken across many labs, or checks fail during an
assessment.

## 9. Follow-up

If a lab's requirements changed, students who passed before keep their
completion — it is recorded on the attempt, not recomputed.
