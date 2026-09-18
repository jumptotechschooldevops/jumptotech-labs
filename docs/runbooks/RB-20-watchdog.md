# RB-20 — Watchdog: the heartbeat stopped arriving

**Alert:** `Watchdog` (severity `none`). It fires **always**, on purpose. You
never act on it firing; you act when the external heartbeat service says it
**stopped arriving**.
**Source:** `infrastructure/observability/prometheus/alerts/watchdog.yml`,
routed by `alertmanager.yml` to the `heartbeat` receiver, which posts to the URL
in `infrastructure/observability/alertmanager/secrets/heartbeat-url` about every
five minutes.
**Blast radius:** unknown until you look. A silent heartbeat means one of: the
host is down, Docker is down, Prometheus or Alertmanager is down, or the host
cannot reach the heartbeat service. Every other alert travels the same path, so
**while the heartbeat is silent, no other alert can reach anyone either.**

The external service is **DECISION REQUIRED** (readiness doc §19, D6/D12): any
check-in ("dead man's switch") service that accepts an HTTP POST and notifies a
person when posts stop. Until `heartbeat-url` exists, nothing outside the host
notices it going quiet.

Commands use `prod`, `q` and `alerts` from [private-beta-operations.md §1](private-beta-operations.md).

## 1. Confirm it is real

From your own machine, not the host:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 https://<host>/   # 200: the edge is up
ssh <operator>@<host> true                                              # the host answers
```

On the host:

```bash
prod ps                               # prometheus and alertmanager running?
q 'ALERTS{alertname="Watchdog"}'      # 1: Prometheus is evaluating rules
alerts | grep -c Watchdog             # >0: Alertmanager holds it
prod logs --since 30m alertmanager | grep -i -E 'notify|heartbeat' | tail
```

## 2. Scope it

| What you found | Meaning | Section |
|---|---|---|
| No SSH, no HTTPS | the host or its network is down | 4a |
| SSH works, `prod ps` shows prometheus or alertmanager not running | the monitoring stack is down; students may be fine | 4b |
| Both running, `q` shows Watchdog, Alertmanager logs notify errors for `heartbeat` | the host cannot reach the heartbeat service (egress, DNS, a changed URL) | 4c |
| Everything healthy and the service still reports silence | the heartbeat service or its check is wrong | 4c |

## 3. Immediate mitigation

- **4a/4b:** assume no alert has been delivered since the heartbeat stopped.
  Run the five-minute health check (operations runbook §2) by hand before
  anything else, and look at the dashboard for what happened in the gap.
- Tell the cohort if the platform itself is down (§4a).

## 4. Fix

### 4a. Host or network down

Provider console: power, network, disk. After it returns, follow the reboot
recovery in [production-host-readiness.md §17](../development/production-host-readiness.md)
(the kind node, `prod up -d --wait`, the smoke).

### 4b. Monitoring stack down

```bash
prod up -d prometheus alertmanager grafana     # they share one network namespace: start them together
prod logs --since 1h prometheus alertmanager | tail -50
```

A full disk is the usual cause (RB-19). Prometheus refuses to start on a
corrupt WAL after a hard stop; its logs say so.

### 4c. Delivery failing

`prod exec -T alertmanager cat /etc/alertmanager/secrets/heartbeat-url` is a
secret: do not paste it anywhere. Check it is the URL the service shows, with no
trailing newline, and that the host's egress admits the service. After fixing
the file: `prod kill -s HUP alertmanager`.

## 5. Verify

The heartbeat service shows a check-in within ten minutes, and the smoke's
`observability.watchdog` is PASS.

## 6. Escalate when

The host or the monitoring stack will not come back within 30 minutes, or you
cannot tell whether any student-affecting alert fired during the silence.
