# Runbooks

**PLATFORM-003.** One file per alert. Every Prometheus rule carries a
`runbook_url` pointing here, and `alerts.test.ts` fails the build if one points
at a file that does not exist — a dead runbook link costs an operator two
minutes at the worst possible moment.

## The shape

Every runbook has the same nine sections, in the same order, because someone
reading one at 2am should not have to learn a new document structure first:

1. **Confirm it is real** — the one query or panel that proves it
2. **Scope it** — which service, provider, lab, instance
3. **Immediate mitigation** — restore service; may not be the fix
4. **Diagnose** — numbered steps, exact commands
5. **Fix**
6. **Verify recovery** — explicit and measurable
7. **What this does NOT mean** — the near-miss alerts it is confused with
8. **Escalate when**
9. **Follow-up** — leak checks, backfill, postmortem trigger

Section 7 earns its place. Most wasted incident time goes on a plausible wrong
diagnosis, and the alerts that look alike are known in advance.

## Severity

| | |
|---|---|
| **critical** | Students are affected now, or a safety mechanism has stopped. Pages. |
| **warning** | Degraded, or heading somewhere bad. Ticket. |

## Index

| Runbook | Alerts |
|---|---|
| [RB-01 Service down](RB-01-service-down.md) | `ServiceDown`, `ServiceNotReady` |
| [RB-02 Database](RB-02-database.md) | `DatabaseDown`, `DatabasePoolSaturated`, `ProgressStoreIsMemory` |
| [RB-03 Lab start failures](RB-03-lab-start-failures.md) | `LabStartsFailingHard`, `LabStartFailureRateElevated` |
| [RB-04 Capacity](RB-04-capacity.md) | `CapacityExhausted`, `CapacityNearExhausted` |
| [RB-05 Cleanup and leaks](RB-05-cleanup-and-leaks.md) | `ReaperStalled`, `SandboxLeakSuspected`, `OrphansPersisting`, `ReaperDeleteFailures` |
| [RB-06 sandboxd](RB-06-sandboxd.md) | `SandboxdRuntimeDown` |
| [RB-07 No labs loaded](RB-07-no-labs-loaded.md) | `NoLabsLoaded`, `LabDefinitionErrors` |
| [RB-08 Security events](RB-08-security-events.md) | `ScopeDenialDetected`, `AuthzOwnershipDenialSpike`, `SecurityEventBurst`, `MetricsScrapeDenied`, `ReaperRefusingForeignOwner` |
| [RB-09 Provider unavailable](RB-09-provider-unavailable.md) | `ProviderUnavailable` |
| [RB-10 Provisioning slow](RB-10-provisioning-slow.md) | `ProvisioningSlow` |
| [RB-11 API errors and latency](RB-11-api-errors-and-latency.md) | `ApiErrorRateHigh`, `ApiLatencyHigh`, `EventLoopLagHigh` |
| [RB-12 Terminal](RB-12-terminal.md) | `TerminalConnectionFailures`, `TerminalPtyDrift` |
| [RB-13 Verification](RB-13-verification.md) | `VerificationErrorRate` |
| [RB-14 Auth](RB-14-auth.md) | `AuthFailureSpike`, `JwksFetchFailing` |

## Before any of them

Two commands worth knowing by heart:

```bash
# Follow one request across every service it touched.
docker compose logs --no-log-prefix | grep '"requestId":"<id>"' | jq -s 'sort_by(.ts)'

# What is this instance's own opinion of its health?
curl -s localhost:9400/readyz | jq .
```

Correlation is the thing PLATFORM-003 added that changes how debugging feels:
before it, "the API logged an error" and "sandboxd logged an error" were two
observations. Now they are one story.

## Related

- [Incident troubleshooting](../incident-troubleshooting.md) — the eleven
  questions and where each is answered
- [Incident exercises](../incident-exercises.md) — three rehearsed failures
- [Observability architecture](../observability.md) — metrics, logs, exposure
