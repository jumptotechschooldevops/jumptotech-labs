# Authentication, account lifecycle and access audit — 2026-09-28

**Base:** origin/main `74ea285`. **Scope:** the identity lifecycle from sign-in
to sign-out and expiry, authorization, terminal-token authority, cookies,
CSRF, admission, account removal, quotas, rate limits and auth secrets. Not
repeated: the sandbox/Kubernetes isolation, capacity, DR, observability, lab
and UX audits of the same week.

**Evidence levels.** *PROVEN LOCALLY*: a test or probe run in this pass
against the in-repo loopback OIDC provider (real discovery, JWKS, RS256, PKCE,
code exchange; `apps/api/test/oidc-identity.ts`, `e2e/oidc-provider`).
*PROVEN BY CI*: GitHub Actions on the PR. *CODE READ*: established from source
with file references. Nothing here is proven against a real identity
provider, a real domain, or a real browser on the internet (§14).

## 1. Verdicts

| Area | Verdict |
|---|---|
| **Authentication** | **Sound for five trusted students.** Standards-correct confidential-client code flow with PKCE, state and nonce; the ID token is verified (asymmetric alg allowlist, `iss`, `aud`, `azp`, `exp`, `iat`, `nonce`); `(issuer, subject)` is the identity; production refuses to start on each misconfiguration in [authentication.md §4.2](../authentication.md#42-production-fail-closed-rules). The one gap is **admission**: the api admits every account the issuer authenticates (§9) — acceptable only because the beta restricts the provider to the five. |
| **Authorization** | **Sound.** Server-side, one `authorize()` policy, owner-or-role, 404-for-not-yours, role only from the database. No endpoint relies on frontend hiding; no route reads an identity from the client. |
| **Session security** | **Sound with two fixes in this pass.** Opaque 256-bit cookie, only its hash stored, HttpOnly/Secure/SameSite=Lax/host-only, destroyed server-side on sign-out, rotated on every sign-in. Fixed: operators could not end a student's sign-ins (#173). Open by decision: 12 h absolute lifetime, no idle timeout, persistent cookie (§6). |
| **Terminal token** | **Was the weakest link; fixed in #175.** A token outlived sign-out by up to 1 h and an open terminal outlived sign-out, expiry and access revocation. Now bound to the sign-in; open sockets close on their next activity report. |

## 2. Architecture and trust boundaries

```text
 browser ──(1) GET /auth/login──► nginx ──► api ──(2) discovery, 302──► IdP /authorize
    ▲                                        │   tx cookie: state, nonce, PKCE verifier (HMAC, Path=/auth, 10 min)
    │                                        │
    └──(3) GET /auth/callback?code&state────►api ──(4) POST /token (client secret, verifier)──► IdP
                                             │   (5) verify ID token against discovered JWKS
                                             │   (6) users.upsert(issuer, subject) — role never from claims
                                             │   (7) destroy any presented session; create auth_sessions row (sha256)
         Set-Cookie: jtt_session (opaque) ◄──┘
 browser ──cookie──► /api/* ── authenticate: cookie → auth_sessions → users → req.user (+ authSessionId)
                              └─ sessionGuard: owner-or-role (policy.ts), then entitlement (ACCESS_POLICY)
 Start / Reconnect ──► terminal token HMAC{sid, uid, asid, labId, ns, exp≤1h}
 browser ──WSS first frame {auth, token}──► terminal ── verify HMAC ──► POST /internal/.../credentials
                                            {ownerUserId, authSession} + x-internal-secret
                                            api: owner == session.owner? sign-in live? access ACTIVE?
```

| Boundary | What crosses | Trusted because |
|---|---|---|
| Browser → api | the cookie, nothing else that names a user | cookie is an index into a server row; body/query/header identities ignored (`auth-security.test.ts` "ignores a user id named in …") |
| api → IdP | client secret, code, verifier | TLS (Node defaults), discovery `issuer` must equal `OIDC_ISSUER`, token POST `redirect: 'error'` |
| IdP → api | ID token | signature against the issuer's published keys; claims checked (§3) |
| api → browser | opaque cookie, identity block without `userId`, terminal token | nothing secret in the page besides the ≤ 1 h terminal token |
| browser → terminal | terminal token | HMAC with `TERMINAL_SESSION_SECRET` (api + terminal only) |
| terminal → api `/internal` | verified claims only | `INTERNAL_SERVICE_SECRET`, constant-time; api re-proves owner, sign-in and access against live rows |
| operator → api | `ops` over a Unix socket | only reachable by `docker exec` into the api container |

## 3. Who is the student

- **Who authenticates:** the configured OIDC issuer, only. There is no local
  password, no fallback login, no development identity in production
  (`AUTH_MODE=development` refused under `NODE_ENV=production`).
- **What identifies a student:** `(issuer, subject)` → an internal `user_id`
  (UUID). Email and name are descriptive, refreshed each sign-in, and decide
  nothing. Progress is keyed by a student id derived from `user_id`.
- **Claims trusted:** `iss`, `sub`, `aud`/`azp`, `exp`/`iat`/`nbf`, `nonce`
  for the decision; `email`, `name` for display. `email_verified`, groups and
  roles are **not read**.
- **Missing claims:** no `sub` → refused, no session (PROVEN LOCALLY); no
  `email` → accepted, account created with no email (PROVEN LOCALLY — the
  operator's `access find --email` cannot find it); no `nonce`/`exp`/`iat` →
  refused (tests).
- **Roles:** `STUDENT` on creation; `upsert` never touches `role`;
  `ops role set` is the only writer. A client cannot choose a role: none is
  read from a token claim, body, query or header (`authentication.test.ts`,
  `role-boundaries.test.ts`).

## 4. Login matrix (local test identity provider only)

| Case | Result | Evidence |
|---|---|---|
| Valid login | 302 to app, `jtt_session` set, `/auth/session` authenticated | PROVEN LOCALLY (`oidc-ownership-e2e`) |
| Unknown user | Provider refuses at its own page; api never sees them. Any user the provider accepts **is admitted** (§9) | CODE READ; e2e IdP |
| Missing subject | 401 `AUTH_INVALID_TOKEN`, no cookie | PROVEN LOCALLY (probe) |
| Missing email | Accepted | PROVEN LOCALLY (probe) |
| Malformed callback (no code, oversized code) | 400 `AUTH_NO_CODE` / `?signin=failed` | `auth-security`, `oidc-flow-hardening` |
| Missing state / no tx cookie | 400 `AUTH_NO_TRANSACTION` / `?signin=expired` | `auth-security` |
| Incorrect state | 400 `AUTH_STATE_MISMATCH` | `oidc-flow-hardening` |
| Tampered / terminal-secret-signed tx cookie | refused | `auth-security`, `oidc-flow-hardening` |
| Replayed callback | code single-use at the provider; the tx cookie is not consumed server-side, so a replay costs one token-endpoint POST — bounded by `SIGN_IN_RATE_LIMIT` 120/min/address | `auth-security` "will not reuse", `sign-in-rate-limit` |
| Code from another sign-in | refused (PKCE) | `oidc-flow-hardening` |
| Expired ID token / no `exp` / no `iat` | 401, no session | `oidc-flow-hardening` |
| Wrong issuer / discovery naming another issuer | 401 / refused | `oidc-flow-hardening` |
| Wrong audience / several audiences without `azp` / foreign `azp` | 401 | `oidc-flow-hardening` |
| Invalid signature (unpublished key) / HS256 | 401 | `oidc-flow-hardening` |
| Wrong nonce / no nonce | 401 | `oidc-flow-hardening` |
| Duplicate identity (same `sub` twice) | one account; second sign-in reaches the first's lab | PROVEN LOCALLY (probe), `auth-persistence-integration` |
| Same email, different `sub` | **two accounts** | PROVEN LOCALLY (probe) — §9 |
| Provider down | `?signin=unavailable`, 503 + `Retry-After`; signed-in students unaffected | `identity-provider-outage` |

Baseline before any change: 19 auth/authz files, **299/299 passed**.

## 5. Authorization matrix

Roles that exist: `STUDENT`, `INSTRUCTOR`, `ADMIN` (`auth/identity.ts`).
"Owner" = the session's stored `ownerUserId`. Anonymous = 401 everywhere
below except `/health` and `/auth/*`.

| Operation | Route | Owner | Other STUDENT | INSTRUCTOR | ADMIN | Entitlement | Limiter |
|---|---|---|---|---|---|---|---|
| View labs / tracks | `GET /api/labs`, `/api/tracks` | any signed-in | — | yes | yes | no (decision) | none |
| Start lab | `POST /api/labs/:id/start` | self only | — | self only | self only | yes (+plan) | SANDBOX_WRITE 20/min/user |
| Read session | `GET /api/sessions/:id` | yes | 404 | yes | yes | no | none |
| Terminal token | `POST /api/sessions/:id/terminal` | yes | 404 | 404 | 404 | yes | none (attach budget at the terminal) |
| Check | `POST …/check` | yes | 404 | 404 | 404 | yes | CHECK 40/min/user + single-flight |
| Reset | `POST …/reset` | yes | 404 | 404 | 404 | yes | SANDBOX_WRITE |
| Activity / hints | `POST …/activity`, `…/hints` | yes | 404 | 404 | 404 | yes | none |
| End | `DELETE /api/sessions/:id` | yes | 404 | 404 | yes | no | none |
| View own progress | `GET /api/me/*` | self | — | self | self | no | none |
| Modify progress | — no route; written only by Check/Start | — | — | — | — | — | — |
| Classroom (all sessions, students) | `GET /api/admin/*` | 403 | 403 | yes | yes (+detail) | no | none |
| End a student's lab | `POST /api/admin/sessions/:id/end` | 403 | 403 | 403 | yes (+`confirmSessionId`) | no | SANDBOX_WRITE |
| Operator actions (access, roles, sign-out, end) | `ops` Unix socket | — | — | — | — | — | host access only |

No endpoint relies on frontend hiding: `/api/admin` is gated by
`requireAction('classroom:read')` server-side. Observation (not a defect):
`GET /api/admin/sessions/:id` lets an INSTRUCTOR read metadata of an unowned
session, which `policy.ts` otherwise makes unreachable to everyone.

## 6. Cross-student results

A cannot reach B's session, terminal, progress, lab state, runtime ids, Check,
Reset or End: every route answers 404 identically for "not yours" and "does
not exist"; B's valid terminal token pointed at A's session is refused
`SESSION_NOT_OWNED`; a token naming B's sign-in for A's session is refused
(new, #175). PROVEN LOCALLY by `oidc-ownership-e2e` (12),
`five-student-adversarial` (9), `authorization` (10), `terminal-ownership`,
`role-boundaries` (6) — all green — and in real browsers by
`e2e/tests/student-isolation.spec.ts` (CI). No new cross-student path found.

## 7. Session lifecycle

| Event | Behaviour | Evidence |
|---|---|---|
| Sign in | new 256-bit id; any presented session destroyed first (fixation) | PROVEN LOCALLY |
| Refresh / multiple tabs | same cookie; each tab re-checks on focus and every 15 s on the workspace | CODE READ (web) |
| Sign out | server row deleted, cookie cleared, provider end-session followed | PROVEN LOCALLY + e2e |
| Sign in again in the same browser | the previous cookie is dead | PROVEN LOCALLY (probe) |
| Another browser of the same student | unaffected by this browser's sign-out | PROVEN LOCALLY (probe) |
| Expiry | 12 h absolute (`AUTH_SESSION_TTL_SECONDS` 300 s–7 d), enforced in SQL; no refresh, **no idle timeout** | tests |
| Browser restart | cookie has `Max-Age`, so it **survives** closing the browser until the 12 h expiry (shared-computer consideration) | CODE READ |
| API restart | sessions are rows in PostgreSQL; survive restart and are shared across instances | `auth-persistence-integration` |
| Stale / invalid / modified cookie | 401 on the api; `/auth/session` answers signed-out and clears it; expired and forged answered identically | `auth-security` |
| Session store unreachable | 503 `AUTH_UNAVAILABLE`, cookie kept (not signed out) | `oidc-flow-hardening` |

**What sign-out invalidates:** the server-side row (authority, not just the
cookie); since #175 also every terminal token requested under it and any open
terminal at its next keystroke. It does not end the lab or other devices'
sign-ins, and it does not sign the student out of the provider unless the
provider honours end-session (`id_token_hint` is not sent — open decision).

## 8. Terminal token lifecycle

| Property | Before (74ea285, measured) | After #175 |
|---|---|---|
| Lifetime | `min(TERMINAL_SESSION_TTL_SECONDS=3600, lab remaining)`, ≥ 60 s | same |
| Scope | one lab session (sid, lab, namespace) | same |
| Student binding | `uid`, re-checked against the live session owner | same |
| Access binding | entitlement re-checked at attach and activity | same, and now closes an open socket |
| Sign-in binding | **none** | `asid` = stored sign-in id; refused once the sign-in ends |
| Reuse | any number of attaches until `exp` (attach budget 30/min/student) | same, while the sign-in lives |
| After sign-out | credentials **200**, activity **200** for up to 3600 s | **401 `AUTH_SESSION_ENDED`** |
| Open terminal after sign-out / access revoked | kept open while typed into | closed on the next activity report (≤ 30 s of typing) |
| Another student's use | refused (owner check) | refused (owner + sign-in) |

Verdict: the previously documented "survives sign-out" risk (SEC-RT-11, O5,
P2-3) was real and is fixed rather than accepted, because it was also the gap
that made emergency revocation incomplete (§10).

## 9. Cookies

| Cookie | Attributes in production | Notes |
|---|---|---|
| `jtt_session` | `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`, host-only | `Secure` mandatory (refused otherwise); `AUTH_COOKIE_DOMAIN` must domain-match the public host |
| `jtt_session_tx` | `HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=600`, HMAC (HKDF of the client secret) | signed, not encrypted: holds state, nonce, verifier of this browser's own sign-in |

**`__Host-` (P2-1, DR-09).** Neither cookie is prefixed, and
`AUTH_COOKIE_NAME=__Host-…` is refused by preflight because the tx cookie is
`Path=/auth`, which `__Host-` forbids. The risk the prefix addresses is
**cookie tossing from a sibling subdomain**: a host under the same registrable
domain (e.g. a marketing site at `www.example.com` next to
`labs.example.com`) can set `jtt_session`/`jtt_session_tx` with
`Domain=.example.com`, planting its own session (login CSRF — the victim works
in the attacker's account) or a tx cookie with a matching callback code.
`__Secure-` does not stop that; only `__Host-` does, and it requires both
cookies at `Path=/`.
**Decision required, not changed here:** the production host name is not
chosen (`.env.example` placeholders). If `PUBLIC_ORIGIN`'s registrable domain
has any host the operator does not fully control, move the tx cookie to
`Path=/` and prefix both with `__Host-` before students use it; if the labs run
on a dedicated registrable domain, the prefix adds nothing and the current
design stands. Record the host in the deployment evidence.

## 10. CSRF / cross-origin

Unsafe methods on `/auth` and `/api/*` pass the origin guard only with an
allowed `Origin`, or `Sec-Fetch-Site: same-origin|none`, or neither header (a
non-browser, which has no victim cookie). `SameSite=Lax` keeps the cookie off
cross-site POSTs; CORS is an exact allow-list with credentials; the terminal
WebSocket has its own Origin allow-list. Start, Check, Reset, End, activity,
hints, terminal token and logout are all POST/DELETE and all guarded; logout is
POST-only. A same-site sibling POST with the victim's cookie is refused (403
`ORIGIN_NOT_ALLOWED`). `/internal` and the billing webhook are not browser
surfaces. PROVEN LOCALLY (`oidc-flow-hardening` "CSRF" block, 6 tests). A
real-browser cross-site form POST is not in the e2e suite (P0-014 §4.9).

## 11. Admission (the five-student allowlist)

- **Can a valid provider account outside the five enter?** Yes: it signs in,
  gets an account, and can browse the catalog and lab instructions and read
  its own empty history. It **cannot use labs**: `ACCESS_POLICY=entitlement`
  (production default) refuses Start, terminal, Check, Reset, hints and
  activity without an ACTIVE grant.
- **The beta runbook relies on the provider** for sign-in restriction
  (private-beta-deployment.md §2.3 "REQUIRED, and only possible at the
  provider"; STOP condition 2), plus the grants as the second layer. That is
  intentional and adequate for five trusted students.
- **Weak point found:** the grant step. `ops access find --email` can return
  two accounts for one address (proven: same email, different `sub`), the api
  does not record `email_verified`, and the first-class runbook's "list
  `--state NONE`, grant each" is only safe while the provider is restricted.
  The new [identity-and-access.md §1](../runbooks/identity-and-access.md)
  requires checking the account before granting.
- **Smallest safe application-level allowlist for a paid/public deployment**
  (designed, not built): an *admission* table of pre-authorised identities
  keyed on `(issuer, subject)` **or** a provider-verified email
  (`email_verified=true` required, stored at upsert), checked in the callback
  after ID-token verification and before `users.upsert`, refusing with
  `?signin=not_invited` and creating no account. Seeded by `ops admit
  --email|--subject … --by --reason`; off unless `AUTH_ADMISSION=invited`.
  About 1 migration, one callback check, one CLI verb. It also closes
  account-sprawl (anyone creating rows) that entitlements do not.

## 12. Disabled or removed student

| Question | Answer (after #173/#175) |
|---|---|
| Existing browser sessions | live until `ops sign-out` or 12 h; revoke/suspend alone does **not** sign out |
| Terminal tokens | refused after `ops sign-out` (sign-in gone) **and** after suspend/revoke (access) |
| Running labs | keep their slot until idle unless `--end-sessions --yes` |
| Saved progress | kept; no operation deletes it; `DELETE FROM users` is blocked by foreign keys |
| Can log in again | yes, unless removed at the provider; signed in, they still cannot use labs |
| Provider-side disable | stops new sign-ins only; existing sessions are never re-checked with the provider |

Procedure: [identity-and-access.md §2 and §9](../runbooks/identity-and-access.md).

## 13. Quotas, rate limits and abuse

**Quotas (bounded probe, cookies from real sign-ins, `MAX_ACTIVE_SESSIONS=3`,
`MAX_ACTIVE_SESSIONS_PER_STUDENT=1`):** 10 concurrent Starts by one student →
1× 200, 9× 429 `STUDENT_SESSION_LIMIT_REACHED`; a second lab while one runs →
429 with "You already have a practice environment running"; 4 distinct
students at once with 1 slot held → 2× 200, 2× 503 `LAB_CAPACITY_REACHED`. The
per-student count is inside the global capacity lock. Correct.

| Surface | Protection | Gap |
|---|---|---|
| `/auth/login`, `/auth/callback` | 120/min per client address | per process, in memory; one NAT'd class shares it (sized for that) |
| Start, Reset, admin End | 20/min per user (shared budget) | — |
| Check | 40/min per user + one in flight per session | — |
| Terminal attach | 30 burst, 30/min per student (terminal) | — |
| Terminal-token mint `POST …/terminal` | none (HMAC, cheap) | attach is the costly step and is budgeted |
| End, logout, activity, hints, reads | none | cheap; authenticated |
| Edge (nginx) | **none** (`limit_req` absent) | required before public release |
| Limits configurable | **no env vars**; constants in `rate-limit.ts` | tuning needs a code change |

Before public/untrusted release: an edge rate limit per address on `/auth/*`
and `/api/*`, limits shared across instances (the in-memory store is per
process), a limit on account creation (sign-ups create rows), and admission
(§11).

## 14. Secrets

No committed real secret found (only placeholders in `.env.example`,
generated values in `e2e/stack.sh` and `scripts/ensure-dev-secrets.sh`,
obviously fake fixtures). Distribution is an exact per-service allow-list
(`infrastructure/secret-distribution.json`): the web gets nothing, the terminal
never gets `OIDC_CLIENT_SECRET` or the database password, and tests enforce it.
Logs: no header/cookie/token logging found; the redactor covers cookies,
`Authorization`, `x-internal-secret`, OAuth parameters, long hex/base64 and
configured secret values. The terminal token travels in the first WebSocket
frame, never a URL. Minor gap: `BILLING_WEBHOOK_SECRET` is not in
`secret-distribution.json` (not yet in compose either) — add it as api-only
before billing ships through compose.

## 15. Auth failure UX

| Situation | What the student sees | Assessment |
|---|---|---|
| Sign-in cancelled / expired / failed / unavailable | plain title, one action, no internals (`AuthGate.tsx`) | good; only `cancelled` has a web test |
| Session expired mid-use | "Your sign-in has expired … your lab keeps running", returns to the same page | good |
| No lab access | state-specific sentence + "contact your instructor … quote the reference" | good |
| `/auth/session` 503 on first load (store down) | "Cannot reach the labs API." | **LOW:** misleading (the API answered); the action (Try again) is right |
| Terminal token refused / sign-in ended | "The terminal's access expired." → auto re-mint → sign-in page if signed out | good (unchanged web, #175) |
| Terminal `ACCESS_*` | bar text correct; xterm line generic | LOW; wording in open PR #167 |
| Role 403 in an action | "Something went wrong on the platform" | LOW; students never reach a role-gated action |
| No provider configured | env var names shown | LOW; production refuses to start in that state |

No fix made here: the wording belongs to the student-experience PRs (#167)
and none is misleading enough to strand a student.

## 16. Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| AUTH-1 | **Medium** | Terminal token outlived sign-out (≤ 1 h); open terminal outlived sign-out, sign-in expiry and access revocation | **Fixed #175** |
| AUTH-2 | **Medium** (ops) | No operator path to end a student's sign-ins (`destroyAllForUser` uncalled); emergency revoke and stolen-session response impossible without SQL | **Fixed #173** |
| AUTH-3 | Medium (paid/public) | Admission = anyone the issuer authenticates; no app-level allowlist | Decision; design §11 |
| AUTH-4 | Medium (conditional) | Cookie tossing from a sibling subdomain (`__Host-` absent) | Decision; depends on domain §9 |
| AUTH-5 | Low | `email_verified` not recorded; same email → several accounts; grant-by-email step can pick the wrong one | Runbook check added; store it for public |
| AUTH-6 | Low | No idle timeout; persistent 12 h cookie survives browser close (shared machines) | Decision (P0-014 §4.7) |
| AUTH-7 | Low | Provider-side disable does not end existing sessions | Runbook: always `ops sign-out` |
| AUTH-8 | Low | A refused ID token (`verification_failed`) is counted, never logged: cannot be tied to a student | Open |
| AUTH-9 | Low | No edge rate limits; app limits per-process, not configurable | Public tier |
| AUTH-10 | Low | `BILLING_WEBHOOK_SECRET` absent from the secret-distribution contract | Open |
| AUTH-11 | Low | Auth UX wording gaps (§15) | Recorded; #167 overlaps |
| AUTH-12 | Info | INSTRUCTOR can read metadata of an unowned session via `/api/admin/sessions/:id` | Recorded |

## 17. Pull requests

| PR | Change | Tests |
|---|---|---|
| #173 | `ops sign-out <user-id> --by --reason` | `operator-sign-out.test.ts` 4 (2 fail on main) |
| #175 | terminal token `asid` binding; `/internal` refuses ended sign-ins; open sockets closed on authority refusal; e2e | api 7 (5 fail on main), terminal 7 (4 fail on main), token unit, Postgres `findLive`, 1 Playwright |
| this | runbook `identity-and-access.md`; this report | docs contract |

Merge order: #173, #175, then this (it documents both). Local runs at the
fix commits: api 942, terminal 260, lab-orchestrator 1565, observability 1042,
all passed; auth + access Postgres suites 30/30.

## 18. Remaining requirements by tier

**Five trusted students (beta)**
- Provider restricted to the five, sign-up off, a sixth account refused at the provider (runbook STOP 2).
- `ACCESS_POLICY=entitlement` (default); grant each student after checking the account (identity-and-access §1).
- #173 and #175 merged and deployed (else: stolen-session response needs SQL, and sign-out leaves terminals).
- Decide the host name; if it shares a registrable domain with anything uncontrolled, do the `__Host-` change first.
- Students told to sign out on shared computers (persistent 12 h cookie).

**Paying JumpToTech cohort**
- All of the above, plus: admission check in the callback (§11) or a provider tenant per cohort; store `email_verified`.
- Idle timeout or shorter absolute lifetime decided; federated logout decided (`id_token_hint`).
- Per-account audit of sign-ins (a log line per callback outcome with the user id), AUTH-8.
- Account deletion/anonymisation and retention decided.
- Real provider staging evidence (§19).

**Public / untrusted product**
- Admission or self-service sign-up with abuse controls (account-creation limits, one person many identities).
- Edge rate limiting per address on `/auth/*` and `/api/*`; limits shared across instances and configurable.
- `__Host-` cookies (or proven dedicated registrable domain).
- Role administration with authenticated admins (today: host shell + `--by`).
- Session list/revoke for the student themselves ("sign out other devices"); idle timeout.
- Bulk revoke tooling (today one SQL statement, §9 of the runbook).
- Real-browser CSRF/cross-site proof; CSP (red-team SEC-RT-5).

## 19. Needs real production identity-provider / domain evidence

- Discovery, JWKS and code exchange over real TLS; key rotation (a new `kid`)
  mid-beta; the provider's clock skew.
- The provider **refusing** a sixth account and self-service sign-up being off.
- Exact redirect-URI match; `post_logout_redirect_uri` registration and
  whether end-session works without `id_token_hint`.
- Whether the provider's `sub` is stable per user (pairwise vs public subject)
  and whether emails are verified.
- The public host name, its registrable domain, and every sibling host on it
  (cookie tossing, §9); HSTS and certificate on that name.
- A real browser's cookie behaviour on that domain (Secure, SameSite, third
  party cookie settings in school browsers).
- Provider outage behaviour with real timeouts.

## 20. Top five remaining identity/access risks

1. **Admission rests entirely on provider configuration.** One misconfigured
   assignment rule admits anyone; entitlements limit lab use but not account
   creation or catalog access (AUTH-3).
2. **Granting the wrong account** — email is unverified and non-unique
   (AUTH-5); the check is procedural.
3. **Cookie tossing** if the chosen domain has uncontrolled siblings (AUTH-4).
4. **Long-lived sessions on shared machines** — 12 h persistent cookie, no idle
   timeout, provider-side disable not propagated (AUTH-6/7).
5. **No edge or shared rate limiting** for anything beyond a trusted cohort
   (AUTH-9).

Nothing in this report is production-proven: every "PROVEN" above used the
loopback test provider.
