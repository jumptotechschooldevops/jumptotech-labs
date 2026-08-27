# RB-05 — Cleanup stalled, or sandboxes leaking

**Alerts:** `ReaperStalled` (critical), `SandboxLeakSuspected` (warning),
`OrphansPersisting` (warning), `ReaperDeleteFailures` (warning)
**Blast radius:** grows quietly. Capacity fills, then the host's disk fills.

Cleanup is the one subsystem that is completely invisible when it works. It is
also the one whose failure nobody notices until the platform is already full,
which is why `jtt_reaper_last_success_timestamp_seconds` is a **timestamp** and
not a counter: a counter that stops rising looks exactly like a quiet period.

## 1. Confirm it is real

```promql
jtt:reaper_seconds_since_success     # > 300 is five missed sweeps
jtt:sandbox_leak:count               # containers held − sessions known
sum(jtt_reaper_orphans_found)
```

## 2. Scope it

| Signal | Meaning |
|---|---|
| `seconds_since_success` rising | The sweep is not completing. Section 4a. |
| Sweeps fine, leak count high | Sweeps run and refuse to delete. Section 4b. |
| `delete_failures` climbing | The runtime is rejecting deletes. Section 4c. |
| **Leak count NEGATIVE** | Sessions the store holds whose container is already gone. Section 4d. |

### A negative leak count

`jtt:sandbox_leak:count` below zero is not a leak — it is the mirror image of
one, and it is deliberately not clamped away.

Briefly negative is normal: a session in `ENDING` or `EXPIRING` still counts as
occupying capacity until its delete is *confirmed*, which is what makes teardown
re-entrant, so for a few seconds the session exists and the container does not.

**Persistently** negative means teardown removed the container and never
finished the state transition — a stuck `ENDING`. Those sessions hold capacity
forever and no sweep will reclaim the slot, because from the reaper's point of
view the teardown is still in progress. Section 4d.

## 3. Immediate mitigation

A stalled reaper does not self-resolve. Restarting the API restarts it:

```bash
docker compose restart api
```

If the host is close to full, reclaim by hand — but **only what the platform
owns**, using the same label the reaper uses:

```bash
docker ps -a --filter label=jumptotech.io/managed=true \
             --filter label=jumptotech.io/runtime-owner=$RUNTIME_OWNER_ID
# inspect before deleting; this removes live student work
```

## 4a. Diagnose — the sweep is not completing

1. `docker compose logs api | grep '"event":"reaper'` — a sweep that throws
   logs `reaper.sweep.failed`.
2. A sweep that hangs on one unreachable provider blocks the pass. Check
   `jtt_provider_available` and `jtt_sandboxd_runtime_up`.
3. Confirm the API is up at all — a stalled reaper with a down API is RB-01.

## 4b. Diagnose — sweeps run, nothing is reclaimed

```promql
sum by (reason) (increase(jtt_reaper_skipped_total[30m]))
```

Every refusal is the reaper being **careful**, and the reason says which rule
stopped it:

| reason | Meaning |
|---|---|
| `within_grace_period` | Normal. A sandbox created moments ago is not an orphan. |
| `no_expiry_label` | A managed sandbox with no expiry. The platform will not guess a deadline; delete by hand after inspecting. |
| `foreign_owner` | **Security signal.** Something wearing this platform's labels that this deployment does not own. RB-08. |
| `name_shape` | A container whose name is not `jtt-lab-*` / `lab-*`. Never deleted, by design. |

## 4c. Diagnose — deletes are failing

```promql
sum by (provider, reason) (increase(jtt_reaper_delete_failures_total[30m]))
```

Usually the runtime: a daemon under pressure, or a container stuck in
`Removing`. `docker ps -a --filter status=dead`.

## 4d. Diagnose — stuck teardowns (negative leak count)

```promql
sum by (provider, status) (jtt_sessions_active)
```

`status="ENDING"` or `"EXPIRING"` that does not clear across several sweeps is
the signature. The reaper re-enters those teardowns every pass — that is the
idempotence guarantee — so a session stuck there means the provider keeps
reporting the sandbox as not-yet-gone.

1. Confirm the container really is gone:
   ```bash
   docker ps -a --filter label=jumptotech.io/managed=true
   ```
2. `docker compose logs api | grep '"event":"reaper' | tail -40` — the teardown
   line says what the provider reported.
3. For a Kubernetes session, a namespace stuck `Terminating` on a finalizer
   produces exactly this and is a cluster problem, not a platform one.

## 5. Fix

Per section 4. A leak caused by an API restart mid-provision resolves on its
own once the reaper runs — the orphan sweep exists for exactly that case, and
it works from the sandbox's own labels rather than from any record the restart
destroyed.

## 6. Verify recovery

- `jtt:reaper_seconds_since_success` below 120 and staying there.
- `jtt_reaper_sweeps_total{outcome="ok"}` rising once per
  `CLEANUP_INTERVAL_SECONDS`.
- `jtt:sandbox_leak:count` at or near zero.
- `jtt_reaper_orphans_found` at zero after two sweeps.
- `docker system df` shows reclaimed space.

## 7. What this does NOT mean

- **Not `CapacityNearExhausted`.** Full of *real* sessions is RB-04. A leak is
  containers with no session at all.
- **A brief non-zero leak count is normal** while a start is in flight: the
  container exists moments before the session record does.
- `skipped{reason="within_grace_period"}` is the design working, not a fault.

## 8. Escalate when

The leak count keeps climbing after a successful sweep, or `foreign_owner`
refusals appear — the second is a security question (RB-08) before it is a
capacity one.

## 9. Follow-up

If an API restart caused the leak, note that sandboxes outlive the process by
design and the orphan sweep is what reconciles them. If the leak survived two
sweeps, the ownership labels are wrong somewhere and that is a bug worth
filing, not an operational fix.
