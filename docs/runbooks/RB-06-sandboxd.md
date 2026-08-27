# RB-06 — The runtime broker or its container runtime

**Alerts:** `SandboxdRuntimeDown` (critical), and `ServiceDown{job="sandboxd"}` via RB-01
**Blast radius:** six of nine tracks — Linux, Terraform, Ansible, CI/CD, Docker,
and the container-backed AWS/CS/Networking labs. **Kubernetes labs are
unaffected**, and so are the catalogue, progress and sign-in.

## 1. Confirm it is real — and which of the two this is

```promql
up{job="sandboxd"}          # is the broker answering Prometheus?
jtt_sandboxd_runtime_up     # is the Docker daemon under it usable?
```

| `up` | `runtime_up` | Meaning |
|---|---|---|
| 0 | — | The broker process is gone. RB-01, then here. |
| 1 | 0 | The broker is fine; the **container runtime** is not. Section 4b. |
| 1 | 1 | Recovered. |

This distinction is the whole reason the two metrics exist separately, and it
is the first question incident exercise 2 asks.

## 2. Scope it

```bash
docker compose ps sandboxd
curl -s localhost:9402/readyz | jq .
```

`/readyz` here **does** gate on the runtime, unlike the API's — for this service
the runtime *is* the service, so a broker that cannot reach a daemon genuinely
cannot serve any request it exists to serve.

## 3. Immediate mitigation

Recover the runtime first, then the broker. Restarting the broker against a dead
daemon achieves nothing and drops every live shell.

## 4a. Diagnose — the broker is down

1. `docker compose logs --tail=100 sandboxd`.
2. **Startup refusals.** `sandboxd` fails closed on: two equal `SANDBOXD_*`
   scope secrets, a missing `NAMESPACE_DERIVATION_SECRET`, a scrape token equal
   to one of its secrets. Each names the variable and exits 1.
3. `NAMESPACE_DERIVATION_SECRET` must match the API's **exactly**. A mismatch
   does not fail at startup — it fails every attach, because the broker derives
   a different container name than the one that exists.

## 4b. Diagnose — the runtime is unreachable

1. `docker info` on the runtime host.
2. `docker compose exec sandboxd docker version` if the socket is mounted.
3. Disk: `docker system df`. A full daemon refuses creates while still
   answering pings, which shows as healthy `runtime_up` and failing `create`
   ops — that is RB-03, not this.
4. `DOCKER_SOCKET_GID` wrong after a host change makes every runtime call fail
   with a permissions error.

## 5. Fix

Restore the daemon, then `docker compose restart sandboxd`.

## 6. Verify recovery

- `up{job="sandboxd"} == 1` and `jtt_sandboxd_runtime_up == 1`.
- `jtt_provider_available == 1` for all five container providers **within 30
  seconds** — the registry's TTL recovers on its own, which also confirms you
  did not need to restart the API.
- Start one Linux lab and one Terraform lab.
- Attach a terminal: `jtt_sandboxd_attach_total{outcome="opened"}` increments
  and `jtt_sandboxd_shells_open` is 1.
- `jtt_sandboxd_scope_denials_total` unchanged at 0 — the restart did not
  scramble credentials.
- Leak check: `jtt:sandbox_leak:count` returns to ~0 within two reaper
  intervals.

## 7. What this does NOT mean

- **Do not restart the API to "clear" provider status.** The 30-second
  availability TTL recovers by itself, and an API restart drops in-flight
  sessions for no benefit.
- If Kubernetes labs are *also* failing, this is not the only incident.

## 8. Escalate when

The daemon will not start, or the host is out of disk with nothing safe to
reclaim.

## 9. Follow-up

`sandboxd` is a single point of failure for six tracks and there is no second
instance. That is a known architectural limitation (PLATFORM-006 scope), not a
misconfiguration — record the outage duration as evidence.
