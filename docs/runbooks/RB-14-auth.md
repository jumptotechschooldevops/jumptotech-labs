# RB-14 — Authentication failing

**Alerts:** `AuthFailureSpike` (warning), `JwksFetchFailing` (warning),
`AuthRejectionsAbnormal` (warning), `OidcSignInFailures` (warning)

Commands use `prod` and `q` from [private-beta-operations.md §1](private-beta-operations.md).

**At private-beta volume (BETA-P0-018)** `AuthFailureSpike` cannot fire: it needs
more than one failure a second. The two beta alerts count instead —
`AuthRejectionsAbnormal` at 20 presented-and-rejected credentials in 10 minutes
(`AUTH_REQUIRED`, a signed-out browser, excluded), and `OidcSignInFailures` at 5
failed `/auth/callback` requests in 15 minutes:

```promql
jtt:auth_rejected:increase10m
sum by (outcome) (increase(jtt_auth_callback_total{outcome!="success"}[15m]))
```

Callback outcomes: `verification_failed` (code exchange, ID-token signature,
audience, nonce), `state_mismatch` and `no_transaction` (the browser round trip,
often a cookie blocked or `OIDC_REDIRECT_URI` wrong), `provider_refused` (the
user cancelled, or the provider refused), `no_code`, `not_configured`.
`JwksFetchFailing` now counts 3 failed key retrievals in 30 minutes.
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

`jtt_auth_attempts_total{outcome}` carries the api's error code
(`apps/api/src/auth/identity.ts`):

| outcome | Meaning |
|---|---|
| `success` | Signed in |
| `AUTH_REQUIRED` | No credential at all. Normal for a signed-out browser, and for a cookie whose server-side session is gone |
| `AUTH_EXPIRED` | The session or token has expired: working as designed |
| `AUTH_INVALID_TOKEN` | A credential was presented and did not verify: a bad signature, a malformed header, or the provider refusing a code exchange |
| `AUTH_MISCONFIGURED` | The api cannot reach or use the identity provider (discovery, keys, token endpoint): §4 |
| `AUTH_UNAVAILABLE` | The platform, not the caller: the database behind sign-ins did not answer, and the request got 503. RB-02 |

`jtt_auth_callback_total{outcome}` for the sign-in round trip: `success`,
`not_configured`, `provider_refused`, `no_transaction`, `state_mismatch`,
`no_code`, `verification_failed`. A burst of `state_mismatch` or
`no_transaction` with no matching sign-in attempts is **security-relevant**, not
merely an error: RB-08.

## 3. Immediate mitigation

If `AUTH_REQUIRED` from browsers that were signed in dominates right after a deploy on a stack with no
`DATABASE_URL`, browser sessions were in memory and the restart signed everyone
out. Users signing in again is the whole fix — and `ProgressStoreIsMemory`
should also be firing, which is the more important alert. This can only happen
outside `NODE_ENV=production`: a production API with no database refuses to
start (BETA-P0-014).

## 4. Diagnose

1. `prod logs --since 30m api | grep '"authorizationResult":"unauthenticated"'`
   — every refused request, by route. `authn.failed` is logged only for
   `AUTH_UNAVAILABLE` (the database, not the caller).
2. **JWKS.** Verification fails closed, so a provider outage means nobody can
   sign in — and cached keys mask it until they expire, which is why this often
   appears long after the provider's problem started:
   ```promql
   sum by (outcome) (increase(jtt_oidc_jwks_fetch_total[30m]))
   ```
   One count per real retrieval, never per token. `http_error`: the key
   endpoint answered non-200 (or redirected). `network_error`: DNS, connection,
   TLS or timeout. `invalid_response`: 200 but not a JWK Set.
   `discovery_failed`: `jwks_uri` could not be learned — see step 6. A healthy
   API shows a few `success` per hour at most, since keys are cached.
3. **Clock skew.** `exp`/`nbf` are checked; a host minutes out of step rejects
   every valid token.
4. **Configuration.** `OIDC_ISSUER`, `OIDC_AUDIENCE` and `OIDC_CLIENT_ID` must
   match the provider. `jtt_config_info` shows the live `auth_mode`.
5. **Redirect URI.** A `callback` outcome of `state_mismatch` in volume usually
   means `OIDC_REDIRECT_URI` no longer matches what is registered.
6. **Discovery (BETA-P0-014).** A `503 AUTH_MISCONFIGURED` from `/auth/login` or
   the callback saying the published issuer does not match means `OIDC_ISSUER`
   differs from the discovery document's `issuer` — often only a trailing
   slash. Keys come from that document's `jwks_uri`.
7. **`403 ORIGIN_NOT_ALLOWED` on sign-out or lab start** with
   `jtt_security_events_total{service="api",event="origin_rejected"}` rising:
   the page is served from an origin missing from `ALLOWED_ORIGINS` /
   `PUBLIC_ORIGIN`, or a cross-site page is posting (RB-08).
8. **The API will not start at all** under `NODE_ENV=production`: the refusal
   lists every authentication rule that failed (docs/authentication.md §4.2).

## 5. Fix

Configuration or the provider. Nothing here is fixed by restarting the API.

## 6. Verify recovery

- Failure ratio back to baseline (a low non-zero rate is normal — every
  signed-out page load is an `AUTH_REQUIRED`).
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
