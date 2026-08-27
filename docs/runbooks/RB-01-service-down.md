# RB-01 — Service down / not ready

**Alerts:** `ServiceDown` (critical), `ServiceNotReady` (critical)
**Typical cause:** crash loop, bad configuration after a deploy, OOM
**Blast radius:** `api` → everything. `terminal` → shells only; running
sandboxes survive. `sandboxd` → six tracks; Kubernetes labs keep working.

## 1. Confirm it is real

```promql
up{job=~"api|terminal|sandboxd"}
jtt_readyz_ok
```

`up == 0` means Prometheus cannot reach the service. `jtt_readyz_ok == 0` means
the service is answering and says it cannot serve — a very different problem,
and usually a dependency.

## 2. Scope it

```bash
docker compose ps
curl -s localhost:9400/livez   # api      — is the process alive at all?
curl -s localhost:9401/livez   # terminal
curl -s localhost:9402/livez   # sandboxd
curl -s localhost:9400/readyz | jq .   # which dependency is refusing?
```

`/livez` answering while `/readyz` refuses tells you the process is fine and
something it depends on is not. Go to that dependency's runbook, not this one.

## 3. Immediate mitigation

```bash
docker compose restart <service>
```

For `api` and `terminal` a restart is cheap: sessions are durable in PostgreSQL
(PLATFORM-008) and sandboxes are reclaimed from their own labels, so nothing is
lost but in-flight requests and open shells. Students reconnect.

**Do not restart `sandboxd` reflexively.** It holds every live PTY; restarting
it drops every student's shell at once. It is the right move if the process is
wedged and the wrong move if you are merely impatient.

## 4. Diagnose

1. `docker compose logs --tail=200 <service>` — the last line before the exit is
   almost always the answer.
2. **Config refusals look like crashes.** Each service fails closed at startup
   on: a scrape token equal to another secret, `AUTH_MODE=development` with
   `NODE_ENV=production`, two equal `SANDBOXD_*` scope secrets, a secret whose
   shape the log redactor does not recognise, or a metric violating the label
   policy. All of these name the variable and exit 1.
3. Crash loop? `docker compose ps` shows the restart count.
4. OOM? `docker inspect <container> | jq '.[0].State'` — look for `OOMKilled`.
5. `jtt_nodejs_heap_size_used_bytes` climbing without falling before the restart
   points at a leak rather than a spike.

## 5. Fix

Whatever step 4 named. A configuration refusal is fixed in `.env` and needs a
`docker compose up -d` to take effect, not a restart.

## 6. Verify recovery

- `up == 1` for two consecutive scrapes (30s).
- `/readyz` returns 200 with every check `ok`.
- `jtt_process_start_time_seconds` shows one restart, not a rising count.
- Start one lab end to end.

## 7. What this does NOT mean

- **Not `ProgressStoreIsMemory`.** That is a running, healthy API with no
  database configured.
- **Not `SandboxdRuntimeDown`.** That is the broker answering while the Docker
  daemon under it does not.
- `ServiceNotReady` on the API with `jtt_db_up == 0` is RB-02, not this.

## 8. Escalate when

Two restarts in ten minutes with no configuration change, or `api` down for
more than fifteen minutes during a scheduled class.

## 9. Follow-up

Check for a sandbox leak: sessions created just before the crash may have live
containers with no session record. `jtt:sandbox_leak:count` should return to
zero within two reaper intervals; if it does not, RB-05.
