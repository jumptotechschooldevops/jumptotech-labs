# Authentication and session ownership

**PLATFORM-009 established server-side identity. PLATFORM-010 closed the loop
from the browser. BETA-P0-014 made it fail closed in production.**

This document has four parts:

1. **[The flow before this change](#1-the-flow-before-this-change)** — recorded
   from the code at `3a8211f`, before anything was modified.
2. **[What was missing](#2-what-was-missing)** — the audit result.
3. **[The flow now](#3-the-flow-now)** — what was built.
4. **[Production readiness](#4-production-readiness--beta-p0-014)** — the
   BETA-P0-014 audit, the startup refusals, and the decisions still open.

---

## 1. The flow before this change

### 1.1 What existed, and what it was worth

| Piece | File | State at `3a8211f` |
|---|---|---|
| Canonical identity type | `apps/api/src/auth/identity.ts` | **Production-capable.** `(issuer, subject)` is the permanent identity; email and display name are descriptive and never consulted by a decision. |
| OIDC token verification | `apps/api/src/auth/oidc.ts` | **Production-capable.** Real JWKS signature check plus issuer, audience, `exp`/`nbf`, via `jose`. Verifies — does not decode. |
| Development resolver | `apps/api/src/auth/resolvers.ts` | **Development-only, and correctly fenced.** `Authorization: Developer <name>`. |
| Production safety gate | `apps/api/src/auth/resolvers.ts` | **Production-capable.** `AUTH_MODE=development` with `NODE_ENV=production` refuses to start. `AUTH_MODE` defaults to `oidc`, so a missing value fails closed. |
| Request authentication | `apps/api/src/auth/middleware.ts` | **Production-capable.** Reads the `Authorization` header and nothing else — no body, query, or cookie — so a client cannot name the user it wishes to be. |
| Authorization policy | `apps/api/src/auth/policy.ts` | **Production-capable.** One `authorize()` entry point; owner-or-role; 404-not-403 so an id cannot be enumerated; an unowned session is reachable by nobody. |
| Session guard | `apps/api/src/auth/middleware.ts` | **Production-capable.** Resolves the session *and* proves ownership in one step, so a handler cannot hold a record it was not authorised for. |
| User store | `apps/api/src/auth/users.ts` | **Production-capable.** Upsert on `(issuer, subject)`; `role` deliberately untouched on conflict, so no provider claim can promote anyone. |
| Session ownership column | `services/progress/migrations/003_users_and_ownership.sql` | **Production-capable.** `lab_sessions.owner_user_id` → `users.user_id`. |
| Terminal session token | `services/lab-orchestrator/src/session-token.ts` | **Production-capable as a binding.** HMAC-SHA256 over `{sid, labId, namespace, iat, exp}`, verified with `timingSafeEqual`. |
| Browser authentication | `apps/web/**` | **MISSING ENTIRELY.** |

### 1.2 The request path as it actually ran

```text
  browser ──fetch(no credential)──► API
                                     │
                                     ├─ authenticate(resolver)
                                     │    AUTH_MODE=development → "no header" = `dev-student`
                                     │    AUTH_MODE=oidc        → 401 AUTH_REQUIRED
                                     │
                                     └─ sessionGuard → authorize(user, action, session)
```

Because `apps/web/src/lib/api.ts` sent no `Authorization` header, and
`apps/api/src/app.ts` applied `authenticate` to `/api/labs`, `/api/tracks`,
`/api/sessions` and `/api/me`, the **only** configuration in which the product
worked end to end was `AUTH_MODE=development` — where every browser is the same
`dev-student`. Turning on the production mode the platform defaults to produced
a 401 on every route.

### 1.3 Progress attribution ran on a separate, unauthenticated identity

`apps/api/src/identity.ts` resolved the *student* for learning history through
`StudentIdentityResolver` (`services/progress/src/identity.ts`) — a fixed
`dev-student-001`, optionally overridden by the client-supplied
`x-dev-student-id` header. This was independent of `req.user`. Two consequences:

- with real authentication on, every student's attempts would still be written
  to one shared history;
- where `DEV_STUDENT_HEADER_ENABLED=true`, **a browser-supplied header selected
  whose progress was read and written** — a client-named user id.

The class documented itself as the seam to replace:

> *"Replacing this class with one that reads a verified session cookie or a JWT
> subject is the whole migration; no repository, service, or route signature
> changes."*

### 1.4 The terminal path

```text
  POST /api/labs/:id/start   (authenticated, owner = req.user.userId)
        └─► issueSessionToken({sid, labId, namespace})   HMAC, TTL-bounded
              └─► browser opens WSS /terminal, first frame = {type:'auth', token}
                    └─► terminal service: verifySessionToken(token, secret)
                          └─► POST /internal/sessions/:sid/credentials
                                (x-internal-secret)
                                └─► API returns the terminal binding for :sid
```

Properties that already held: the token is minted **only** at start and **only**
for the session just created for the authenticated caller; there is no route
that returns a terminal token for an existing session; the session id comes from
the signed token and is read exactly once, so no later frame can move a socket
to another session; a second `auth` frame is rejected; the WebSocket enforces an
`Origin` allow-list and a 10-second auth grace.

---

## 2. What was missing

Ordered by severity, as found by the audit.

1. **No browser authentication flow at all.** No sign-in, no credential on any
   request, no auth state, no sign-out, no expiry handling. The platform could
   not run in its own default `AUTH_MODE=oidc`.
2. **Progress identity was not the authenticated identity** (§1.3), and in
   development could be selected by a browser-supplied header.
3. **The terminal token was never re-checked against session ownership.** It
   carried no user identity, so `POST /internal/sessions/:sid/credentials`
   released a session's terminal binding on the strength of the HMAC alone. The
   HTTP layer proved ownership on every REST call; the WebSocket path did not
   re-prove it at attach time.
4. **`jose` was an undeclared dependency** — imported by `apps/api/src/auth/oidc.ts`
   but present only as a hoisted transitive package.
5. **No OIDC-mode ownership test.** `apps/api/test/authorization.test.ts` proved
   cross-user isolation thoroughly, but only under `AUTH_MODE=development`.
6. **CORS was `credentials: false`**, so no cookie-based browser session was
   possible without changing it.
7. The terminal service compared the internal shared secret with `!==` rather
   than a constant-time comparison, unlike the API side.

---

## 3. The flow now

### 3.1 Why a backend-for-frontend, not a browser OIDC client

Two constraints decided this:

- an OIDC **client secret must never reach frontend code**;
- **access and ID tokens must not sit in `localStorage`/`sessionStorage`**,
  where any script on the page can read them.

So the API is the confidential OIDC client. It performs the authorization-code
exchange server-side and hands the browser an **opaque, HttpOnly session
cookie**. The browser never holds an OIDC token of any kind, and there is
nothing in the page for a script to steal.

This *extends* the existing architecture rather than replacing it: the
`IdentityResolver` contract is untouched and still reads only the `Authorization`
header, `OidcTokenVerifier` is reused verbatim to verify the ID token, and
`UserRepository.upsert` remains the single place an account is created.

### 3.2 Sign-in

```text
  browser  GET /auth/login?returnTo=#/labs/K8S-001
     │
     ├─ API: discover the issuer (.well-known/openid-configuration, cached)
     ├─ API: generate state + nonce + PKCE verifier (S256)
     ├─ API: store them in a signed, HttpOnly, 10-minute transaction cookie
     │        (Path=/auth; key HKDF-derived from OIDC_CLIENT_SECRET — §4.4)
     └─ 302 → provider /authorize?...code_challenge=...&state=...
                 │
                 └─ user authenticates with the provider
                     │
  browser  GET /auth/callback?code=...&state=...
     │
     ├─ API: constant-time compare state with the transaction cookie
     ├─ API: POST provider /token   (client_id + client_secret + code_verifier)
     ├─ API: OidcTokenVerifier.verify(id_token)   signature (asymmetric alg,
     │        keys from discovery jwks_uri), iss, aud, azp, exp, iat
     ├─ API: compare nonce
     ├─ API: users.upsert({issuer, subject, email, name})
     ├─ API: destroy any session the browser already presented (§4.3)
     ├─ API: authSessions.create(userId)  →  opaque 256-bit id
     └─ 302 → app, Set-Cookie: jtt_session=<id>; HttpOnly; SameSite=Lax; Path=/
```

The cookie value is random and opaque. **Only its SHA-256 hash is stored**, so a
database read does not yield usable cookies. `Secure` is set whenever the
deployment is not plain-HTTP localhost.

### 3.3 Every subsequent request

```text
  browser ──fetch(credentials:'include')──► API
                                             │
                                             ├─ authenticate():
                                             │    1. cookie present?  → authSessions.resolve(hash)
                                             │                          → users.findById(userId)
                                             │    2. otherwise        → IdentityResolver(Authorization)
                                             │
                                             ├─ req.user  (server-side only)
                                             └─ sessionGuard → authorize(...)
```

Order matters and is documented in code: the cookie path is tried first because
it is the browser's path; the header path is retained unchanged for service
callers, the test suite, and development mode. **Neither path reads a user
identifier from the request.** The cookie is an opaque index into a server-side
record; the header is a signed token. There is no third path.

### 3.4 Progress attribution now follows the authenticated user

`resolveStudent()` prefers `req.user`, deriving a stable student id from the
internal `userId`. The `x-dev-student-id` override is only consulted when there
is no authenticated user *and* the deployment enabled it — so a browser-supplied
identifier can never select an authenticated student's history.

### 3.5 Terminal ownership is re-proven at attach time

The gap in §2.3 is closed by binding the token to the owner and re-checking it
against the live session record:

```text
  issueSessionToken({sid, labId, namespace, uid: owner.userId})
        └─► terminal service verifies HMAC, reads claims.uid
              └─► POST /internal/sessions/:sid/credentials
                    { ownerUserId: claims.uid }
                    └─► API: session = require(sid)
                             session.ownerUserId === ownerUserId ?
                               yes → terminal binding
                               no  → 403 SESSION_NOT_OWNED, nothing released
```

Three properties this adds:

1. **A terminal token is not a standalone capability.** Even a perfectly valid
   HMAC is refused if the session it names is not still owned by the user the
   token names, so possession of a leaked token does not survive the session
   changing hands or the owner record being removed.
2. **The check is server-side, against the session record** — the same source of
   truth `authorize()` uses for REST. The WebSocket path can no longer reach a
   sandbox the HTTP path would refuse.
3. **It fails closed.** A token minted before this change carries no `uid`; the
   API refuses it rather than falling back to the old behaviour.

### 3.6 Sign-out

`POST /auth/logout` deletes the server-side auth session, clears the cookie with
an immediate expiry, and returns the provider's `end_session_endpoint` when the
issuer publishes one, so the UI can complete a full single-logout. Deleting the
record server-side is what makes the cookie worthless immediately — clearing it
in the browser alone would leave a valid session id in anyone's proxy log.

### 3.7 What the browser holds

| Item | Where | Readable by page scripts |
|---|---|---|
| Session cookie | HttpOnly cookie | **No** |
| OIDC access token | API process only, never sent to the browser | **No** |
| OIDC ID token | verified and discarded; only claims are persisted | **No** |
| OIDC refresh token | not requested (`scope` has no `offline_access`) | **No** |
| Client secret | API environment only | **No** |
| Terminal session token | JavaScript memory, for the WebSocket handshake | Yes — unchanged, and now owner-bound (§3.5) |
| Display name / email | JavaScript memory, for rendering | Yes — descriptive only |

Nothing is written to `localStorage` or `sessionStorage` by the auth layer.

### 3.8 Configuration

| Variable | Meaning |
|---|---|
| `AUTH_MODE` | `oidc` (default) or `development`. |
| `OIDC_ISSUER` | Issuer URL, e.g. `https://example.eu.auth0.com/`. |
| `OIDC_CLIENT_ID` | The API's client id. |
| `OIDC_CLIENT_SECRET` | **Server-side only.** Required for the browser flow, and required at startup under `NODE_ENV=production`. |
| `OIDC_JWKS_URI` | Optional. Unset means the discovery document's `jwks_uri` (since BETA-P0-014). |
| `OIDC_AUDIENCE` | Audience this API accepts. |
| `OIDC_SCOPES` | Default `openid profile email`. No `offline_access`. |
| `OIDC_REDIRECT_URI` | Absolute callback URL; derived from `PUBLIC_ORIGIN` when unset. In production it must be exactly `PUBLIC_ORIGIN` + `/auth/callback`. |
| `AUTH_SESSION_TTL_SECONDS` | Browser session lifetime. Default 43200 (12h); 300–604800 accepted. |
| `AUTH_COOKIE_NAME` | Default `jtt_session`. |
| `AUTH_COOKIE_SECURE` | Default: on unless the public origin is plain-HTTP localhost. |
| `AUTH_COOKIE_DOMAIN` | Optional; unset means host-only, which is the safer default. |

### 3.9 Known limitations

- **No refresh.** A browser session lives `AUTH_SESSION_TTL_SECONDS` and then
  requires signing in again. `offline_access` is deliberately not requested;
  holding refresh tokens is a separate security decision.
- **Auth sessions are per-deployment.** With `DATABASE_URL` set they are durable
  and shared across API instances; without it they are in memory and are lost on
  restart, exactly like lab sessions, and the API logs which one it is using.
  Under `NODE_ENV=production` there is no "without it": the API refuses to start
  (§4.2).
- **No role administration surface.** Roles change in the database only.
- **Single logout is best-effort.** The API returns the provider's end-session
  URL; whether the provider honours it is the provider's business. See §4.7,
  *FEDERATED LOGOUT — DECISION REQUIRED*.

---

## 4. Production readiness — BETA-P0-014

Audited from the code at `488048b` before anything was changed. The architecture
in §3 was sound; what was missing was the part that stops a *misconfigured*
production deployment from starting, plus a handful of standards checks the
token and session layers skipped.

### 4.1 Implemented before, and missing

| Area | Before `488048b` | Gap closed by P0-014 |
|---|---|---|
| Code flow + PKCE S256, state, nonce | Implemented, constant-time compares | — |
| Signed transaction cookie | HMAC with `TERMINAL_SESSION_SECRET`, `Path=/` | Key shared with the terminal service; cookie sent on every API request |
| ID token signature/iss/aud/exp | `jose` via JWKS | **`exp` not required** — a signed token without one never expired. No `alg` allowlist, no `iat`, no `azp` |
| JWKS location | `<issuer>/.well-known/jwks.json` | One provider's convention, not the standard `jwks_uri` |
| Discovery | Endpoints scheme-checked (http or https) | Published `issuer` not compared (Discovery §4.3); `https` issuer could publish `http` endpoints; token POST followed redirects with the secret in the body |
| Opaque, hashed, durable sessions | Implemented (`auth_sessions`, SHA-256) | — |
| Cookie `HttpOnly`/`SameSite=Lax`/`Path=/`/`Max-Age` | Implemented | Lifetime unbounded; name unchecked until first use |
| `Secure` | Derived (off only on http localhost) | `AUTH_COOKIE_SECURE=false` accepted in production |
| Session fixation | New id on every sign-in | Previously presented session **not destroyed** |
| `returnTo` | Sanitised at `/auth/login` | Trusted at the callback once it came back out of the cookie |
| Logout | POST, server-side destroy, cookie cleared | — (federated logout: §4.7) |
| CSRF | `SameSite=Lax` + CORS allow-list | Nothing stopped a **same-site sibling origin** from *sending* a POST/DELETE with the cookie |
| Caching | — | `/auth/*` responses (identity, `Set-Cookie`) had no `Cache-Control` |
| `AUTH_MODE=development` in production | Refused | — |
| Localhost public origin in production | Refused | — |
| Missing `OIDC_CLIENT_SECRET` in production | **Started**, bearer-only, nobody could sign in | |
| `http:` issuer / `http:` or derived `PUBLIC_ORIGIN` / foreign `OIDC_REDIRECT_URI` in production | **Started** | |
| `DEV_STUDENT_HEADER_ENABLED=true` in production | **Started** | |
| Browser storage of tokens | None (documented) | Not proven by a test |

### 4.2 Production fail-closed rules

Under `NODE_ENV=production`, `loadConfig` refuses to start — listing every
problem in one message, naming variables and never the client secret — when any
of these holds (`apps/api/src/auth/production-auth.ts`):

| Rule | Refused |
|---|---|
| Mode | `AUTH_MODE` other than `oidc` (default stays `oidc`) |
| Provider | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_AUDIENCE` blank; `OIDC_CLIENT_SECRET` blank (via the P0-010 secret gate, which also refuses placeholders and short values) |
| Issuer | not an absolute `https:` URL; carries credentials, a query or a fragment |
| JWKS override | `OIDC_JWKS_URI` not `https:` |
| Public origin | `PUBLIC_ORIGIN` unset (no longer derived from `ALLOWED_ORIGINS`), not `https:`, or not a canonical bare origin |
| Callback | `OIDC_REDIRECT_URI` not `https:`, not on `PUBLIC_ORIGIN`, path not `/auth/callback`, or with query/fragment/credentials |
| CORS | an `ALLOWED_ORIGINS` entry not a bare `https:` origin (`*`, `null`, paths); `PUBLIC_ORIGIN` not among them |
| Cookie | `AUTH_COOKIE_SECURE=false`; `AUTH_COOKIE_DOMAIN` that does not domain-match the public host |
| Scopes | no `openid`; `offline_access` (refused wherever browser sign-in is configured) |
| Dev identity | `DEV_STUDENT_HEADER_ENABLED=true` |
| Durable sessions | neither `DATABASE_URL` nor `POSTGRES_HOST` set — browser sessions, users, lab sessions and progress would all be in memory. The database connection still has to pass the BETA-P0-012 transport gate (verified TLS, loopback, a Unix socket, or the declared single-host bridge) |
| TLS | `NODE_TLS_REJECT_UNAUTHORIZED` set (existing, BETA-P0-011) |

Ordering is preserved: runtime owner (P0-008), then secrets (P0-010), then TLS
(P0-011), then authentication, then the database transport (P0-012) — so a weak
secret is still reported as itself. `buildIdentityResolver` keeps its own
refusal of development mode as a second line, and `index.ts` calls
`assertDurableStoresInProduction` before choosing any store, so no other path to
an `ApiConfig` can hand production the in-memory fallbacks. Outside production
an unset `DATABASE_URL` still means in-memory stores, with a startup warning.

### 4.3 Cookie and session security

- **Session cookie** `jtt_session`: 256-bit random, base64url, only its SHA-256
  stored; `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=<ttl>`, host-only.
  `Secure` is mandatory in production. Lifetime 300 s – 7 days (default 12 h),
  absolute; there is no refresh.
- **Transaction cookie** `jtt_session_tx`: `HttpOnly; Secure; SameSite=Lax;
  Path=/auth; Max-Age=600`, HMAC-signed. It is signed, not encrypted: the browser
  that holds it can read its own state, nonce and PKCE verifier, which grants
  nothing a holder of that browser's cookies does not already have.
- **Fixation**: after the ID token is verified, any session id the browser
  presented is destroyed before the new one is created. A failed callback
  destroys nothing, so it cannot be used to sign somebody out.
- **Logout**: `POST /auth/logout` deletes the row, then clears the cookie; the
  old value is refused on every route afterwards.
- `/auth/*` responses are `Cache-Control: no-store`.
- No provider token reaches the browser: the ID token is verified and
  discarded, the access token is dropped in the callback, no refresh token is
  requested. `apps/web/test/token-storage.test.tsx` parses the web sources
  (no Web Storage, IndexedDB, `document.cookie`, or token-named identifiers) and
  runs sign-in/sign-out with storage writes spied on.

### 4.4 PKCE, state, nonce and token validation

- Authorization code flow, `code_challenge_method=S256`, verifier 48 random
  bytes; `state` and `nonce` 32 random bytes, compared in constant time.
- The transaction key is `HKDF-SHA256(OIDC_CLIENT_SECRET, "jumptotech-labs",
  "auth-transaction-cookie/v1")`. The terminal holds `TERMINAL_SESSION_SECRET`
  and so could previously mint transactions; it is refused `OIDC_CLIENT_SECRET`.
- `returnTo` is sanitised at `/auth/login` **and** at the callback.
- Discovery (`apps/api/src/auth/discovery.ts`): published `issuer` must equal
  `OIDC_ISSUER` exactly; endpoints must parse, carry no credentials, and may not
  be `http:` under an `https:` issuer. The token-endpoint POST uses
  `redirect: 'error'`.
- ID token (`buildBrowserSignIn` → `OidcTokenVerifier`): signature against the
  discovered `jwks_uri` (or `OIDC_JWKS_URI`), algorithms `RS*/PS*/ES*/EdDSA`
  only, `iss` exact, `aud` includes the client id, `azp` required when several
  audiences and must equal the client id when present, `exp` and `iat` required,
  `nbf` honoured, 5 s clock tolerance, `nonce` equal to the transaction's.
- Bearer access tokens on `/api/*`: same verifier class with `OIDC_AUDIENCE`;
  `exp` now required, same algorithm allowlist.
- TLS: Node defaults everywhere; no agent, dispatcher or `rejectUnauthorized`
  in the auth layer (asserted by test).

### 4.5 CSRF and origin

The existing mechanism is the `ALLOWED_ORIGINS` allow-list plus `SameSite=Lax`.
P0-014 enforces that same list server-side for unsafe methods on `/auth` and
`/api/*` (`apps/api/src/auth/origin-guard.ts`): an `Origin` must be allowed (or
be `PUBLIC_ORIGIN`); without `Origin`, `Sec-Fetch-Site` must be `same-origin` or
`none`; a request with neither header is not a browser and passes. Refusals are
`403 ORIGIN_NOT_ALLOWED`, counted as `jtt_security_events_total{event="origin_rejected"}`
— the event the terminal WebSocket already uses for its origin check. `/internal`
is untouched. The OIDC callback and logout redirect are built only from
configuration (`PUBLIC_ORIGIN`), never from `Host` or `X-Forwarded-*`.

### 4.6 The development exception

`AUTH_MODE=development` still works when `NODE_ENV` is not `production`, and the
local compose stack still defaults to it. A test or laptop may use an `http:`
loopback provider and plain-HTTP localhost cookies. Nothing in that path is
reachable once `NODE_ENV=production`.

### 4.7 Decisions required

- **FEDERATED LOGOUT — DECISION REQUIRED.** Logout returns the provider's
  `end_session_endpoint` with `client_id` and `post_logout_redirect_uri` only.
  The ID token is discarded at the callback, so no `id_token_hint` is sent; some
  providers require it, and all require the post-logout URI to be registered.
  Keeping the ID token server-side for the hint, or choosing local-only logout,
  is a provider-dependent decision.
- **WHO MAY SIGN IN — DECISION REQUIRED.** Any account the configured issuer
  authenticates is admitted and provisioned as `STUDENT`. For a private beta,
  restricting admission (a group/role claim, an email-domain rule, or an
  invitation table) has to be chosen; it is not provider-neutral to guess.
  **Who may use labs is now separate:** under `ACCESS_POLICY=entitlement` (the
  production default) signing in grants no lab access; an operator grants it
  per account ([commercial-access.md](commercial-access.md)). An admitted but
  ungranted account can sign in, browse the catalog and read its own (empty)
  history, and nothing else.
- **Durable sessions in production — resolved.** Production OIDC requires a
  PostgreSQL database and refuses to start without one (§4.2); there is no
  in-memory fallback for a private beta, where a restart would sign every
  student out and a second instance could not see the first one's sessions.
- **IDLE TIMEOUT / REFRESH — DECISION REQUIRED.** Sessions have an absolute
  lifetime only. An idle timeout, or refresh tokens, each change what is stored.

### 4.8 Key retrieval is observable

`jtt_oidc_jwks_fetch_total{outcome}` counts each real JWKS retrieval made by
either verifier (bearer access tokens and browser ID tokens) — never a cached
key lookup — plus each failed attempt to learn `jwks_uri` from discovery.
`outcome` is a closed set: `success`, `http_error` (non-200, redirects
included), `network_error` (DNS, connection, TLS, timeout), `invalid_response`
(200 but not a JSON JWK Set), `discovery_failed`. No URL, issuer or `kid` is a
label. `JwksFetchFailing` alerts on the non-success outcomes; RB-14 uses the
success series as a recovery check. Proven in `apps/api/test/jwks-fetch-metric.test.ts`.

### 4.9 What CI must still prove

- The suites in §4.3–4.5 run in `npm test` (api: `production-oidc-config`,
  `oidc-flow-hardening`; web: `token-storage`), alongside the P0-010 secret and
  compose-distribution checks.
- `npm run test:db` for `auth-persistence-integration` against real Postgres.
- Against a **real** staging identity provider over TLS: discovery, the code
  exchange, key rotation (a new `kid`), a rejected expired token, logout. The
  in-process provider is loopback `http:`; nothing here proves a real TLS chain.
- A production-shaped `docker compose config` with the production variables set,
  and a container start that refuses each rule in §4.2.
- A browser check that the built bundle holds no token, and that a real
  cross-site form POST is refused.
