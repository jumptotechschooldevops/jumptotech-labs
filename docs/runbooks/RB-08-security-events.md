# RB-08 — Security events

**Alerts:** `ScopeDenialDetected` (critical), `AuthzOwnershipDenialSpike`
(warning), `SecurityEventBurst` (warning), `MetricsScrapeDenied` (warning),
`ReaperRefusingForeignOwner` (warning)

Every alert here fires on a boundary that **held**. The platform refused
something. The question is never "did it get through" — it did not — but "who
is pushing, and why".

## 1. Confirm it is real

```promql
increase(jtt_sandboxd_scope_denials_total[1h])
sum by (result) (increase(jtt_authz_decisions_total[1h]))
sum by (service, event) (increase(jtt_security_events_total[1h]))
```

## 2. Scope it — by event, because they mean very different things

### `scope_denied` — always an incident

Each service holds only the scope secrets it needs: the terminal has `attach`
and physically cannot authenticate to `/v1/docker`. A denial therefore means
either a **misconfiguration** (a service given the wrong secret after a deploy)
or **something presenting a credential it should not have**. There is no benign
explanation, which is why the alert has no threshold above zero.

1. `docker compose logs sandboxd | grep '"securityEvent":"scope_denied"'` — the
   line names the scope and the endpoint.
2. Compare the deployed values: `SANDBOXD_ATTACH_SECRET` in `terminal`,
   `SANDBOXD_RUNTIME_SECRET` and `SANDBOXD_DOCKER_SECRET` in `api`, all three in
   `sandboxd`. A recent deploy that rotated one and not the others is the
   commonest cause.
3. If configuration is correct, treat it as an intrusion attempt: `sandboxd`
   binds loopback by default and warns when told to bind wider, so ask what can
   reach that port.

### `denied-not-owner` — session-id probing

A browser only ever holds its own session id, so a student never legitimately
asks for someone else's. A sustained rate is somebody trying ids.

The platform's answer is already correct: a 404 identical to the one for a
session that does not exist, so this is not an enumeration oracle. Nothing was
disclosed.

```bash
docker compose logs api | grep '"authorizationResult":"denied-not-owner"' \
  | jq -r '[.userId, .action] | @tsv' | sort | uniq -c | sort -rn
```

One `userId` dominating is one account to look at. Spread evenly across many is
more likely a broken client retrying a stale id.

### `origin_rejected` in bulk — usually a deploy, not an attack

`ALLOWED_ORIGINS` not matching the origin students actually use. Check it
against `PUBLIC_ORIGIN` and the tunnel hostname before reaching for anything
more exciting.

### `foreign_owner` from the reaper

Something wearing `jumptotech.io/managed=true` that this deployment does not
own. Two deployments sharing a runtime with different `RUNTIME_OWNER_ID` is the
benign explanation and the common one — see `docs/runtime-ownership.md`. If
there is only one deployment on that host, it is not benign.

### `scrape_unauthorized`

Something is probing `/metrics` without a valid token. The endpoint is bound to
loopback and requires a bearer token, so a burst from outside means the port is
more reachable than intended. Check the compose port binding.

## 3. Immediate mitigation

For a credential mismatch: correct `.env` and `docker compose up -d`. For
suspected probing, nothing needs to be shut off — the boundary is holding — but
it is worth knowing what can reach the port before deciding that.

## 4. Diagnose

Every one of these is logged with a `requestId`. Follow it across services:

```bash
docker compose logs --no-log-prefix | grep '"requestId":"<id>"' | jq -s 'sort_by(.ts)'
```

## 5. Fix

Configuration, or a decision about network exposure. There is no code fix here
— the refusals are the code working.

## 6. Verify recovery

- `jtt_sandboxd_scope_denials_total` stops increasing and stays flat.
- `denied-not-owner` rate returns to baseline.
- The legitimate path still works: start a lab, attach a terminal, run a check.
  **Confirm this explicitly** — the most likely mistake while fixing a
  credential mismatch is breaking the credential that was correct.

## 7. What this does NOT mean

- **Nothing was breached.** These count refusals. A successful cross-tenant
  access would not appear here, and no such path is known.
- **Not `AuthFailureSpike`.** That is people failing to sign in; this is
  authenticated callers reaching for things that are not theirs.

## 8. Escalate when

`scope_denied` is non-zero with configuration verified correct, or ownership
denials come from one account in volume. Both are security decisions, not
operational ones.

## 9. Follow-up

There is **no rate limiting on any endpoint** — a caller can probe as fast as
they like and only these counters will show it. That is PLATFORM-004 scope, and
an incident here is the evidence for prioritising it.
