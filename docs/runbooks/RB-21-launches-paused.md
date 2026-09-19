# RB-21 — New lab launches are paused

**Alert:** `LabLaunchesPaused` (warning)
**Source:** `jtt_lab_launches_paused`, set by the running api from `LAB_LAUNCHES_PAUSED`.
**Blast radius:** every student who presses Start Lab is refused. Labs that are
already running are not affected.

Commands use `prod`, `q` and `ops` from [private-beta-operations.md §1](private-beta-operations.md).

A pause is always an operator's decision ([private-beta-operations.md §3](private-beta-operations.md)).
Nothing in the platform turns it on by itself. This alert fires because a
refused start is deliberately **not** counted as a failed start: without it, a
pause that nobody lifted would look like a quiet platform while every student
was being turned away.

## 1. Confirm it is real

```bash
q 'jtt_lab_launches_paused'          # 1 = paused
ops status                           # "launches paused: YES"
grep -E '^LAB_LAUNCHES_PAUSED=' .env
```

## 2. Scope it

- **Paused on purpose, maintenance still running.** Say so in the incident
  channel and leave it. The alert keeps repeating until the pause is lifted.
- **Paused on purpose, maintenance finished.** Someone forgot to lift it. Go to §5.
- **`.env` says `false`, the gauge still says 1.** The api was not re-created
  after the edit. `.env` changes take effect only on `prod up -d api`.
- **`.env` says `true` and nobody knows why.** Treat it as an open incident.
  Find who set it (shell history on the host, the incident channel) before
  lifting it: it may have been set for a security or data problem (§3 of the
  operations runbook).

## 3. Immediate mitigation

None is needed for running labs. They keep their terminal, Verify, Reset and End.

## 4. Diagnose

```bash
prod logs --since 2h api | grep '"event":"lab.start.paused"' | wc -l    # students refused
prod logs --since 24h api | grep 'launches=PAUSED'                      # when the api started paused
```

## 5. Fix — lift the pause

1. Confirm the reason for the pause is resolved: [private-beta-operations.md §2](private-beta-operations.md).
   `ops status` should list only the pause as a reason for `new labs: NO`.
2. Set `LAB_LAUNCHES_PAUSED=false` in `.env`, or delete the line.
3. `prod up -d api`. This re-creates the api container. Running labs keep their
   workspace; open browser tabs show "Cannot reach the labs API" for a few seconds.
4. Tell the cohort.

## 6. Verify recovery

- `q 'jtt_lab_launches_paused'` is 0.
- `ops status` shows `launches paused: no` and `new labs: YES`.
- One test start succeeds and one `lab.start.succeeded` appears in the api log.

## 7. What this does NOT mean

- **Not `CapacityExhausted`.** A pause refuses with `LAB_LAUNCHES_PAUSED`
  (HTTP 503). Full capacity refuses with `LAB_CAPACITY_REACHED`.
- **Not an outage of running labs.** If students with running labs have
  problems too, you have a second incident: [private-beta-incident-response.md](private-beta-incident-response.md).

## 8. Escalate when

Nobody can say why the pause was set, or the reason it was set for is still
unresolved after the class period.

## 9. Follow-up

Write in the incident record when the pause started, when it ended, why, and
how many starts were refused (§4).
