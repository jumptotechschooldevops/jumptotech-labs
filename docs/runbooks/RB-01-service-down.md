# RB-01 — Service down / not ready

**Alerts:** `ServiceDown` (critical), `ServiceNotReady` (critical),
`ServiceRestartLoop` (warning)
**Typical cause:** crash loop, bad configuration after a deploy, OOM
**Blast radius:** `api` → everything. `terminal` → shells only; running
sandboxes survive. `sandboxd` → six tracks; Kubernetes labs keep working.

Commands use `prod`, `q` and `ready` from [private-beta-operations.md §1](private-beta-operations.md).
On the production host a bare `docker compose` finds no sandboxd and re-creates
services without the production overlays; `curl localhost:94xx` reaches nothing,
because production publishes only 443 and 80.

## 1. Confirm it is real

```promql
up{job=~"api|terminal|sandboxd"}
jtt_readyz_ok
```

`up == 0` means Prometheus cannot reach the service. `jtt_readyz_ok == 0` means
the service is answering and says it cannot serve — a very different problem,
and usually a dependency.

### 1.1 `ServiceRestartLoop`, and why `ServiceDown` can be silent

Production services carry `restart: unless-stopped`
([private-beta-operations.md §6.1](private-beta-operations.md)), so a crashed
service comes back on its own. That is what you want on an unattended host, and
it is also why `ServiceDown` — `up == 0` for two **continuous** minutes — can
stay quiet through a real outage: a container that dies, restarts, serves one
scrape and dies again never gives it two continuous minutes.

`ServiceRestartLoop` counts the transitions instead:

```promql
changes(up{job=~"api|terminal|sandboxd"}[15m])
```

Six or more is three full down-up cycles. Treat it as an outage even though it
is a warning: students are seeing intermittent failures while `up` reads 1
between scrapes. It does **not** fire for a service that is simply gone — that
produces one transition and is `ServiceDown`'s to report — nor for one
deliberate restart.

Go straight to §4. Restarting a service that is already restarting itself tells
you nothing; the exit reason does.

## 2. Scope it

```bash
prod ps                        # running? healthy? a low uptime against an old CREATED is a restart
ready api 9400                 # the status code and every readiness check, from inside the container
ready terminal 9401
ready sandboxd 9402
```

`ready` failing to run at all (`service "api" is not running`, or no answer)
means the process is down: §4. A 503 that names a failed check means the
process is fine and something it depends on is not. Go to that dependency's
runbook, not this one.

## 3. Immediate mitigation

```bash
prod restart <service>
```

For `api` and `terminal` a restart is cheap: sessions are durable in PostgreSQL
(PLATFORM-008) and sandboxes are reclaimed from their own labels, so nothing is
lost but in-flight requests and open shells. Students reconnect.

**Do not restart `sandboxd` reflexively.** It holds every live PTY; restarting
it drops every student's shell at once. It is the right move if the process is
wedged and the wrong move if you are merely impatient.

## 4. Diagnose

1. `prod logs --tail=200 <service>` — the last line before the exit is
   almost always the answer.
2. **Config refusals look like crashes.** Each service fails closed at startup
   on: a scrape token equal to another secret, `AUTH_MODE=development` with
   `NODE_ENV=production`, two equal `SANDBOXD_*` scope secrets, a secret whose
   shape the log redactor does not recognise, or a metric violating the label
   policy. All of these name the variable and exit 1.
3. Crash loop? `docker inspect -f '{{.RestartCount}}' <container>` is the
   number of restarts since the container was created (`prod ps` shows only
   the uptime; `ServiceRestartLoop` counts them for you). With `restart: unless-stopped` Docker backs off
   between attempts — 100ms doubling to a one-minute ceiling — so a service
   failing instantly settles at about one attempt a minute rather than spinning.
4. OOM? `docker inspect -f '{{.State.OOMKilled}} exit={{.State.ExitCode}}' <container>`.
5. `jtt_nodejs_heap_size_used_bytes` climbing without falling before the restart
   points at a leak rather than a spike.

## 5. Fix

Whatever step 4 named. A configuration refusal is fixed in `.env` and needs a
`prod up -d <service>` to take effect, not a restart: a restart keeps the old
environment.

## 6. Verify recovery

- `up == 1` for two consecutive scrapes (30s).
- `/readyz` returns 200 with every check `ok`.
- `jtt_process_start_time_seconds` shows one restart, not a rising count.
- `changes(up{job="<service>"}[15m])` falls back to 0 within fifteen minutes.
  Until it does, `ServiceRestartLoop` stays firing on history, not on a live
  fault — wait it out rather than restarting again.
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
