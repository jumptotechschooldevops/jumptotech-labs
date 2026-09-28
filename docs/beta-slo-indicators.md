# Private-beta service indicators and objectives

What an operator watches to know the private beta is working for students, the
query that answers it, the objective we hold it to, and what pages when it is
missed. Everything named here exists in the repository: the recording rules in
`infrastructure/observability/prometheus/rules/recording.yml`, the alerts in
`infrastructure/observability/prometheus/alerts/*.yml` (each carries the
runbook it links), and the metrics in `services/observability/src/metrics.ts`.

**No objective below is a measurement.** There is no production history yet.
The objectives are the thresholds the alerts already enforce, written down as
targets so that the first cohort's data can confirm or correct them. With five
students the sample sizes are tiny: one failed start in a quiet hour is a 100 %
failure ratio. That is why every alert pairs its ratio with a minimum count or a
`for:` window, and why this beta runs on alerts, not on an error budget. Revisit
the objectives after the first two cohort weeks, from `jtt_*` data, before any
public launch.

## 1. Indicators

| # | Indicator (what a student feels) | Query | Beta objective | Alert (severity, window) | Runbook |
|---|---|---|---|---|---|
| 1 | **Lab start success.** "I pressed Start Lab and got a lab." | `jtt:lab_start_failure:ratio10m`, from `jtt_lab_start_outcome_total`. Refusals that are not platform failures (`student_limit_reached`, `capacity_reached`, `access_denied`) are excluded. | ≤ 10 % of starts fail, per 10 min, with ≥ 2 failures before it counts | `LabStartFailureRateElevated` (warning, 5m); `LabStartsFailingHard` (critical: ≥ 3 and > 30 %, 2m) | RB-03 |
| 2 | **Provisioning latency.** "…in reasonable time." | `jtt:lab_provision_duration:p95_15m` by `provider` | p95 ≤ 60 s per provider | `ProvisioningSlow` (warning, 15m) | RB-10 |
| 3 | **Capacity.** "…and was not turned away." | `jtt:sessions_headroom:count`, `jtt:sessions_utilization:ratio`; refusals `jtt_lab_start_outcome_total{outcome="capacity_reached"}` | zero `capacity_reached` refusals while the cohort is ≤ `MAX_ACTIVE_SESSIONS` | `CapacityNearExhausted` (warning, > 85 %, 10m); `CapacityExhausted` (critical, any refusal in 10m) | RB-04 |
| 4 | **Terminal attach.** "My terminal connected." | `jtt:terminal_connection_failure:ratio10m`, from `jtt_terminal_connections_total{outcome}` (`established` and `superseded` count as success) | ≤ 20 % of attach attempts fail, per 10 min | `TerminalConnectionFailures` (warning, 10m); `TerminalPtyDrift` (warning) for shells without a browser | RB-12 |
| 5 | **Verification.** "Check Solution gave me a verdict." | `jtt:verification_error:ratio10m` (`result="error"` is the platform's failure; `pass` and `fail` are both successes); p95 of `jtt_verification_duration_seconds` | ≤ 5 % errors; p95 ≤ 10 s | `VerificationErrorRate`, `VerificationSlow` (warning, 10m) | RB-13 |
| 6 | **API availability.** "The site answered." | `1 - jtt:http_error:ratio10m{service="api"}`; `jtt:http_duration:p95_10m{service="api"}` (Start, Check, Reset and End are excluded from latency; they have their own indicators) | ≥ 98 % non-5xx per 10 min; p95 ≤ 1 s | `ApiErrorRateHigh`, `ApiLatencyHigh` (warning, 10m); `ServiceDown` / `ServiceNotReady` (critical) | RB-11, RB-01 |
| 7 | **Runtime health.** "The machinery behind my lab is up." | `jtt_sandboxd_runtime_up`; `jtt_provider_available{provider}` (only providers with labs); `jtt_db_up` | all 1 | `SandboxdRuntimeDown` (critical, 2m); `ProviderUnavailable` (warning, 5m); `DatabaseDown` (critical, 1m) | RB-06, RB-09, RB-02 |
| 8 | **Cleanup.** "Finished labs are really gone." | `jtt:reaper_seconds_since_success`; `jtt_reaper_last_sweep_errors`; `jtt:sandbox_leak:count`; `jtt_reaper_orphans_found` | a successful sweep every ≤ 300 s; no sweep errors lasting 15 min; ≤ 5 leaked or orphaned sandboxes | `ReaperStalled` (critical); `ReaperSweepErrorsPersisting`, `SandboxLeakSuspected`, `OrphansPersisting`, `ReaperDeleteFailures` (warning) | RB-05 |
| 9 | **Session lifecycle.** "Nothing hangs half-done." | `jtt_sessions_oldest_status_age_seconds{status}` | CREATING ≤ 600 s, RESETTING ≤ 900 s, ENDING/EXPIRING ≤ 1200 s, DEGRADED ≤ 2400 s | `SessionStuckProvisioning`, `SessionResetStuck`, `SessionTeardownStuck`, `SessionDegradedNotReclaimed` (warning) | RB-17 |
| 10 | **Recoverability.** "Their work survives a disaster." | `jtt:backup_age:seconds{operation="backup"}`; `jtt_backup_last_success_offhost` | a verified backup ≤ 26 h old, copied off the host | `BackupStale` (warning), `BackupMissedTwice` (critical), `BackupLastRunFailed`, `BackupVerifyFailed` | RB-16 |

Row 0 of the operator dashboard (Grafana, *JTT — Private Beta Operations*)
shows indicators 1, 2, 4, 5 and 6 as current values coloured against these
objectives, so "are we inside the objective right now" is one look rather than
a query. The alerts above remain what pages.

Two alerts protect the signal itself rather than a student: `AlertNotificationsFailing`
and `AlertmanagerUnreachable` (private-beta-operations.md). If either fires,
every row above is unobserved until it is fixed.

## 2. The operator's questions, answered

| Question | Where the answer is |
|---|---|
| Are students able to start labs? | Indicator 1, and `ops status` ("new labs: YES/NO" with the reason) |
| How many sessions are active? | `sum by (status, provider) (jtt_sessions_active)`; `ops sessions` lists each slot |
| How many failed, and why? | `sum by (outcome) (increase(jtt_lab_start_outcome_total[1h]))`. Each failure also logs `lab.start.failed` with `outcome` and `code`; `ops sessions --recent` shows finished sessions with their status reason |
| How long does provisioning take? | Indicator 2; per step: `jtt_lab_provision_step_duration_seconds` |
| How many containers or Pods exist? | Containers: `jtt_sandboxd_containers_managed{provider}`. Kubernetes labs: one namespace per session, `jtt_sessions_active{provider="kubernetes"}`. There is no Pod-count metric. `kubectl get ns -l jumptotech.io/managed=true` lists the lab namespaces (all named `lab-…`); `kubectl get pods -A --no-headers | grep -c '^lab-'` counts their Pods |
| Are verifications succeeding? | Indicator 5; by lab: `sum by (lab_id, result) (increase(jtt_verification_total[1h]))` |
| Are the runtime brokers healthy? | Indicator 7; `ops status` lists providers |
| Are terminals connecting? | Indicator 4; `sum by (outcome) (increase(jtt_terminal_connections_total[1h]))` names each failure kind |
| Are sessions being cleaned up? | Indicator 8. For a failing teardown, `reaper.sweep.failed` log lines name the sandbox and the reason (RB-05 §4a) |
| Who owns a session, which lab, when did it start and expire, why did it fail? | `ops session <id>`: owner (internal user id; `ops access show <user-id>` for who that is), lab, status and reason, created, expires |
| How do we end it? | `ops end <id> --yes` (the platform's own teardown; recorded EXPIRED, "ended by operator") |

## 3. What is not covered

- **Student-perceived end-to-end success** (signed in → started → typed →
  verified) is not one metric. The browser E2E suite (`npm run test:e2e`, CI
  job `browser-e2e`) proves the path per commit; production has only the
  per-step indicators above.
- **Per-student fairness** (one student repeatedly failing while the ratio
  stays low) is not alerted. `lab.start.failed` log lines carry the session and
  lab; look there when a student reports trouble.
- **Pod-level resource use** inside Kubernetes labs is not exported. Host
  pressure is (`HostMemoryPressure`, `HostDiskSpaceLow`, `HostCpuSaturated`,
  RB-19).
