# RB-14 — Authentication failing

**Alerts:** `AuthFailureSpike` (warning), `JwksFetchFailing` (warning)
**Blast radius:** nobody can sign in. Existing browser sessions keep working
until they expire (`AUTH_SESSION_TTL_SECONDS`, default 12h), so this often
starts quietly.

## 1. Confirm it is real

```promql
jtt:auth_failure:ratio5m
sum by (outcome) (rate(jtt_auth_attempts_total[10m]))
sum by (outcome) (increase(jtt_auth_callback_total[30m]))
```

`AuthFailureSpike` requires **both** a ratio above 30% and more than one failure
per second. A ratio alone fires on a quiet night with two failures; a rate alone
fires on a busy morning that is working fine.

## 2. Scope it — `outcome` names the cause

| outcome | Meaning |
|---|---|
| `no_credential` | Unauthenticated requests. Normal on `/auth/session`. |
| `invalid_token` / `expired` | Token verification failed |
| `unknown_session` | A cookie whose server-side record is gone |
| `session_expired` | Working as designed |

On the callback: `state_mismatch`, `open_redirect_blocked` and
`replayed_transaction` are **security-relevant**, not merely errors. See RB-08.

## 3. Immediate mitigation

If `unknown_session` dominates right after a deploy on a stack with no
`DATABASE_URL`, browser sessions were in memory and the restart signed everyone
out. Users signing in again is the whole fix — and `ProgressStoreIsMemory`
should also be firing, which is the more important alert.

## 4. Diagnose

1. `docker compose logs api | grep '"event":"authn.failed"'`.
2. **JWKS.** Verification fails closed, so a provider outage means nobody can
   sign in — and cached keys mask it until they expire, which is why this often
   appears long after the provider's problem started:
   ```promql
   sum by (outcome) (increase(jtt_oidc_jwks_fetch_total[30m]))
   ```
3. **Clock skew.** `exp`/`nbf` are checked; a host minutes out of step rejects
   every valid token.
4. **Configuration.** `OIDC_ISSUER`, `OIDC_AUDIENCE` and `OIDC_CLIENT_ID` must
   match the provider. `jtt_config_info` shows the live `auth_mode`.
5. **Redirect URI.** A `callback` outcome of `state_mismatch` in volume usually
   means `OIDC_REDIRECT_URI` no longer matches what is registered.

## 5. Fix

Configuration or the provider. Nothing here is fixed by restarting the API.

## 6. Verify recovery

- Failure ratio back to baseline (a low non-zero rate is normal — every
  unauthenticated page load is a `no_credential`).
- Complete a real sign-in end to end.
- `jtt_auth_sessions_active` increases.
- `jtt_oidc_jwks_fetch_total{outcome="success"}` increments.
- The signed-in user can start a lab — proving authorization works, not just
  authentication.

## 7. What this does NOT mean

- **Not `AuthzOwnershipDenialSpike`.** That is authenticated people reaching for
  sessions that are not theirs (RB-08). This is people failing to sign in.
- A steady low failure rate is normal and is not this alert.

## 8. Escalate when

The identity provider is down (outside this platform), or `AUTH_MODE` is
`development` on a deployment that should be `oidc` — the API refuses that
combination under `NODE_ENV=production`, so it can only happen where
`NODE_ENV` is also wrong.

## 9. Follow-up

There is **no role administration surface**: roles change by direct SQL only.
If this incident involved a permissions question, that gap is PLATFORM-005
scope.
