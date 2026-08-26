# Authentication and session ownership

**PLATFORM-009 established server-side identity. PLATFORM-010 (this document)
closes the loop from the browser.**

This document has three parts:

1. **[The flow before this change](#1-the-flow-before-this-change)** — recorded
   from the code at `3a8211f`, before anything was modified.
2. **[What was missing](#2-what-was-missing)** — the audit result.
3. **[The flow now](#3-the-flow-now)** — what was built.

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
     └─ 302 → provider /authorize?...code_challenge=...&state=...
                 │
                 └─ user authenticates with the provider
                     │
  browser  GET /auth/callback?code=...&state=...
     │
     ├─ API: constant-time compare state with the transaction cookie
     ├─ API: POST provider /token   (client_id + client_secret + code_verifier)
     ├─ API: OidcTokenVerifier.verify(id_token)   signature, iss, aud, exp
     ├─ API: compare nonce
     ├─ API: users.upsert({issuer, subject, email, name})
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
| `OIDC_CLIENT_SECRET` | **Server-side only.** Required for the browser flow. |
| `OIDC_AUDIENCE` | Audience this API accepts. |
| `OIDC_SCOPES` | Default `openid profile email`. No `offline_access`. |
| `OIDC_REDIRECT_URI` | Absolute callback URL; derived from `PUBLIC_ORIGIN` when unset. |
| `AUTH_SESSION_TTL_SECONDS` | Browser session lifetime. Default 43200 (12h). |
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
- **No role administration surface.** Roles change in the database only.
- **Single logout is best-effort.** The API returns the provider's end-session
  URL; whether the provider honours it is the provider's business.
