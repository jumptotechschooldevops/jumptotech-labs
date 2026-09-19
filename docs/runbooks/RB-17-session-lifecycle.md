# RB-17 — Stuck sessions and failing resets

**Alerts:** `LabResetsFailing`, `SessionStuckProvisioning`, `SessionResetStuck`,
`SessionTeardownStuck`, `SessionDegradedNotReclaimed` (all warning)
**Source:** `jtt_sessions_oldest_status_age_seconds{status}` (from
`lab_sessions.status_changed_at`) and `jtt_lab_reset_outcome_total`.
**Blast radius:** each stuck session holds one of the beta's five slots.

Commands use `prod` and `q` from [private-beta-operations.md §1](private-beta-operations.md).

## 1. Confirm it is real

```bash
q 'max by (status) (jtt_sessions_oldest_status_age_seconds) / 60'   # minutes
q 'sum by (outcome) (increase(jtt_lab_reset_outcome_total[30m]))'
prod exec -T postgres psql -U jumptotech -d jumptotech_labs -c \
  "SELECT session_id, lab_id, provider, status, now() - status_changed_at AS in_status, status_reason
     FROM lab_sessions
    WHERE status IN ('CREATING','RESETTING','DEGRADED','ENDING','EXPIRING')
    ORDER BY status_changed_at"
```

(`-U` and `-d` are `POSTGRES_USER` and `POSTGRES_DB` from `.env`; these are the
defaults.)

## 2. Scope it

Every status has a timer that should already have moved it:

| Status | Should move by | Alert at | What moves it |
|---|---|---|---|
| CREATING | ~3 min (ready timeout 180 s + pull) | 10 min | provisioning succeeds or fails; the reaper tears down an abandoned start at 10 min |
| RESETTING | 10 min | 15 min | the reset, or the reaper recovering it to DEGRADED |
| ENDING / EXPIRING | seconds; resumed at 5 min, retried every sweep | 20 min | the provider confirming the sandbox is gone |
| DEGRADED | the student's Reset or End; idle expiry at 20 min | 40 min | the student, or the reaper |

One session, one provider, or every session? `provider` in the query above.

## 3. Immediate mitigation

- If the reaper is stalled or erroring (`q 'jtt:reaper_seconds_since_success'`,
  `q 'jtt_reaper_last_sweep_errors'`): [RB-05](RB-05-cleanup-and-leaks.md) first.
  `prod restart api` restarts the reaper; sessions are durable.
- A DEGRADED session's student can press **Reset Lab** again, or **End Lab**.
- **Do not edit `lab_sessions` by hand.** Status changes are fenced transitions;
  a hand edit can hand a sandbox to the wrong teardown or report a broken one
  as ACTIVE.

## 4. Diagnose

1. The session's own log lines:
   ```bash
   prod logs --since 2h api | grep '"sessionId":"<session_id>"' | tail -40
   ```
2. **CREATING.** A provider hanging: `ready sandboxd 9402` and
   `q 'jtt_sandboxd_runtime_up'` (RB-06), `q 'jtt_provider_available'` (RB-09),
   the provisioning step breakdown (RB-10). An API restart mid-create, or a
   database blip on its final write, leaves the row CREATING; after 10 minutes
   the reaper tears it down (`EXPIRED`, reason `the lab did not finish
   starting`, `jtt_reaper_recoveries_total{reason="abandoned_start"}`) and the
   student can start again. The alert firing means that did not happen: the
   reaper (RB-05) or the database (RB-02).
3. **RESETTING past 15 minutes.** The reaper is not recovering it: sweep errors
   (RB-05), or the database (RB-02).
4. **ENDING / EXPIRING.** The provider keeps reporting the sandbox as present:
   ```bash
   docker ps -a --filter label=jumptotech.io/managed=true --filter "label=jumptotech.io/runtime-owner=$RUNTIME_OWNER_ID"
   kubectl get ns -l jumptotech.io/managed=true
   ```
   A namespace stuck `Terminating` on a finalizer is a cluster problem.
   [RB-05 §4d](RB-05-cleanup-and-leaks.md).
5. **LabResetsFailing.**
   ```bash
   prod logs --since 1h api | grep '"event":"lab.reset.failed"' | tail -20
   ```
   The `code` names the provider's error. Container resets rebuild the sandbox,
   so a missing image or a sick runtime fails every reset: RB-06.

## 5. Fix

Whatever section 4 named. Once the cause is gone the reaper finishes the
teardowns and recoveries on its next sweeps without intervention.

## 6. Verify recovery

- `q 'max by (status) (jtt_sessions_oldest_status_age_seconds) / 60'` back under
  the thresholds within two sweeps.
- `q 'jtt:sessions_headroom:count'` has the slot back.
- A reset of a test lab succeeds: `outcome="success"` increments.

## 7. What this does NOT mean

- **A long ACTIVE session is not stuck.** It is bounded by `MAX_SESSION_MINUTES`.
- **An End returning "still shutting down" is not a failure.** `pending` End
  outcomes are normal for a namespace that takes seconds to terminate.
- **Not `SandboxLeakSuspected`.** A leak is a container with no session; this is
  a session whose container will not go.

## 8. Escalate when

A teardown stays stuck after the provider's problem is fixed, or DEGRADED
sessions accumulate across providers.

## 9. Follow-up

Note the lab and provider. A lab whose reset fails repeatedly is a content or
image problem worth filing.
