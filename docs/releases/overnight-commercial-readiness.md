# Overnight commercial readiness — product control plane audit

| | |
|---|---|
| **STARTING COMMIT** | `24e09f132d522b8de713e696bd0a682f3be74d93` (origin/main, merge of PR #54) |
| **BRANCH** | `feat/overnight-commercial-readiness` (local only; not pushed, no PR) |
| **AUDIT DATE** | 2026-09-21 |
| **Scope** | identity, authorization, entitlement, operator control, audit, onboarding/offboarding, data lifecycle, payment boundary. Not runtime, Docker, Kubernetes, terminal hardening, verifier or curriculum (other audits) |

The model, operator runbook and payment boundary are documented in
[docs/commercial-access.md](../commercial-access.md). This report records what
was found, what changed, and what was proven.

---

## 1. CURRENT PRODUCT MODEL (at 24e09f1)

| Concept | Existed? | Where | Notes |
|---|---|---|---|
| User / identity | **yes** | `users` (migration 003): `(issuer, subject)` unique; email, display name descriptive | Created on first sign-in (upsert). No deletion path |
| Authentication | **yes** | OIDC authorization-code + PKCE; `auth_sessions` stores SHA-256 of an opaque cookie; bearer tokens for services | Production refuses development auth, http issuers, insecure cookies |
| Role | **yes** | `users.role` STUDENT / INSTRUCTOR / ADMIN; `auth/policy.ts` central `authorize()` | Never taken from a token claim. No administration surface: `setRole` exists, nothing calls it |
| Authorization | **yes, ownership only** | `authorize(user, action, session)` — owner, or INSTRUCTOR read / ADMIN read+end across users | Answers "whose session is this", never "may this person use labs" |
| Student | partly | `students` (progress) keyed by internal user id | A learning-history row, not an enrollment |
| Session | **yes** | `lab_sessions` with `owner_user_id` | Per-student limit (`MAX_ACTIVE_SESSIONS_PER_STUDENT`, beta 1) inside the capacity lock |
| Progress | **yes** | `lab_attempts`, `lab_progress`, `hint_usage` | Kept forever |
| Lab / track / learning path | **yes** | file catalog (`labs/`) | No sale or access unit attached |
| Operator | **yes** | Unix-socket operator CLI (`ops status / sessions / session / end`) | Sessions only; nothing about people or access |
| Enrollment | **no** | — | |
| Entitlement | **no** | — | |
| Subscription / plan / payment | **no** | — | No payment code of any kind (none to repair) |
| Organization / cohort / course | **no** | — | |
| Instructor | role only | `INSTRUCTOR` may read another student's session | No instructor UI |
| Audit trail of admin changes | **no** | — | Per-request `authz.decision` lines existed for session access |

**Missing** (never built): enrollment, entitlement, expiry, suspension,
revocation, an access-management surface, an audit trail for access, a
student-facing "no access" state, account deletion.

**Broken** (built, but wrong for a commercial product): the coupling below.

## 2. CURRENT AUTH MODEL

Unchanged by this work, and sound: OIDC with signature/iss/aud/exp/alg checks,
PKCE, server-side opaque sessions, fail-closed production gates, 503 (not 401)
when the session store is unreachable. `docs/authentication.md`.

## 3. CURRENT ACCESS MODEL — the defect

**At 24e09f1, "has an account" == "has unlimited lab access".** Any identity
the configured issuer authenticated was provisioned as STUDENT on first sign-in
and could start, attach to, verify and reset labs indefinitely. Prior audits
recorded this as "who may sign in — requires external IdP configuration"
(SEC-EXT-1, release gate D3). That framed it as sign-in; the commercial problem
is that sign-in and lab use were the same thing, and nothing in the
application could separate them.

## 4. CURRENT ADMIN MODEL

At 24e09f1: the operator socket (host `docker exec` only) could read and end
sessions. Granting or withdrawing a person's access, listing who had access, or
changing a role required hand-written SQL against production.

---

## 5. DEFECTS FOUND

| # | Severity | Defect | Proof |
|---|---|---|---|
| C-1 | **HIGH** (commercial) | Authentication implied unlimited lab access; no entitlement, expiry, suspension or revocation existed | With the enforcement points disabled (= 24e09f1 behaviour), 5 of 14 `commercial-access.test.ts` tests fail: an account nobody granted starts a lab with 200 |
| C-2 | **MEDIUM** | The terminal's credential exchange (`/internal/sessions/:id/credentials`, every WS attach/reconnect) checked session ownership only, so a terminal token minted while somebody had access would keep opening shells after it ended | `refuses the terminal credential exchange for a token minted before access ended` — fails with enforcement disabled |
| C-3 | **HIGH** (operability) | No safe management path: access could only be changed with ad-hoc SQL on production | Missing capability (no code path existed) |
| C-4 | **MEDIUM** | No record of who granted/changed access, when or why | Missing capability |
| C-5 | LOW (found in this work, before commit) | Verify's fallback for unknown error codes says "this is a platform problem, not a mistake in your work" — an access refusal would have been described that way | `student-logic.test.tsx` asserts `kind: 'access'` and no "platform problem" in every context |
| C-6 | LOW (found in this work, before commit) | Access denials counted as lab-start failures would have paged on-call (`LabStartsFailingHard`) whenever unentitled students pressed Start | promtool case 10 fails without the `access_denied` exclusion (verified) |
| C-7 | LOW (self-introduced in `d6566e6`, fixed in `3b52772`) | The Start refusal's audit event copied the raw `x-request-id` header instead of the validated token | `commercial-access.test.ts` sends an unsafe and a safe id |

## 6. DEFECTS FIXED

All seven. C-1…C-4 by the entitlement foundation, enforcement and operator
surface; C-5…C-7 as described.

## 7. REGRESSION TESTS

| Suite | New tests | What it proves |
|---|---|---|
| `apps/api/test/access-entitlements.test.ts` | 24 | transition table, half-open window boundaries, instants require an offset, actor/reason/id validation, idempotence, serialised concurrent changes, open policy reads no store, store failure fails closed |
| `apps/api/test/commercial-access.test.ts` | 14 | every lab-use route refuses non-ACTIVE access (Start, terminal, credential exchange, Check, Reset, hints, Continue); reading/End/history stay; full lifecycle NONE→ACTIVE→EXPIRED→re-grant→SUSPENDED→restore→REVOKED over HTTP; SCHEDULED; no self-service route; no mass assignment via body or headers; non-owner still gets 404; per-student limit still applies; ACCESS_POLICY defaults (dev open, production entitlement) and refusal of unknown values; audit request id |
| `apps/api/test/operator-access.test.ts` | 12 | find/show/grant/list/suspend/restore/revoke over a real socket and the real CLI; history order and attribution; idempotent no-op; `--end-sessions` needs `--yes`; refusals (missing --by/--reason/expiry, ambiguous time, past window, unknown fields, non-JSON, oversize, email as id, unknown user, grant over suspension, restore after revoke); logs never carry reason/email/name; no credential-shaped field; **every documented `ops access` command parses** |
| `apps/api/test/access-persistence-integration.test.ts` | 6 (RUN_DB_TESTS) | migration 006 applies and is idempotent; lifecycle with events; two pools racing keep one row and a consistent event chain; restart; case-insensitive email lookup; schema CHECK/PK/FK refusals; non-UUID ids |
| `services/progress/test/migrations.test.ts` | assertions | 006 is additive (no ALTER/UPDATE/DELETE), PK (user_id, scope), window CHECK, no cascade, no credential column |
| `apps/web/test/dashboard.test.tsx` | 3 | the dashboard explains NONE/EXPIRED before Start; shows nothing when active, open, or unreadable |
| `apps/web/test/student-logic.test.tsx` | assertions | ACCESS_NOT_ACTIVE is `access` in every context, never "platform problem" |
| `services/terminal/test/error-disclosure.test.ts` | 1 | the terminal forwards the API's access sentence |
| `services/observability/test/production-host-contract.test.ts` | 2 | `access.policy` warns on production `open`, passes unset/entitlement |
| promtool `lab-start-alerts.test.yml` | 1 case | `access_denied` Start refusals page nobody |
| `production:config-check --self-test` | 2 cases | production `open` warns; unknown value refused by the api loader |

**62 new Vitest tests**, plus 1 promtool case and 2 config-check self-test cases.

---

## 8. ENTITLEMENT MODEL STATUS — **IMPLEMENTED**

`access_entitlements`: one row per (user, scope); scope `platform` (every lab);
status ACTIVE/SUSPENDED/REVOKED; window `[starts_at, expires_at)`;
`granted_via` = `operator`. Effective state (NONE, SCHEDULED, ACTIVE, EXPIRED,
SUSPENDED, REVOKED) is computed live. Answers WHO (user id), TO WHAT (scope),
FROM/UNTIL (window), WHY (reason in the event), STATUS, WHO GRANTED (`--by`).
Policy switch `ACCESS_POLICY=open|entitlement`, production default
`entitlement`.

## 9. EXPIRATION STATUS — **IMPLEMENTED**

Explicit `--until` or `--no-expiry` required on every grant; no default length.
Half-open window, evaluated per request against the server clock; no job.
Instants must carry an explicit offset and are stored in UTC. Scheduled starts
(`--from`) supported. Tested at ±1 ms of the boundary.

## 10. SUSPENSION STATUS — **IMPLEMENTED**

`suspend` / `restore` keep the window; a grant cannot lift a suspension.

## 11. REVOCATION STATUS — **IMPLEMENTED**

`revoke` keeps the account, sign-in, sessions history and progress; only a new
grant restores lab use. Running labs are refused on every use and end only with
`--end-sessions --yes` (OPERATOR DECISION).

## 12. ADMIN MANAGEMENT STATUS — **IMPLEMENTED (operator CLI)**

`ops access list | find | show | grant | suspend | restore | revoke` over the
existing operator socket. No HTTP admin endpoint was created. Mutations by
internal id only. No dashboard (deliberately).

## 13. AUDITABILITY STATUS — **IMPLEMENTED**

`access_events`, append-only, written in the same transaction as each change
under a user-row lock: action, actor (`--by`), reason, before/after status and
window, time. `ops access show` prints it; §6.8 of the doc gives a read-only
export query. Log `ops.operator.access_changed` (ids and states only) and
`jtt_operator_actions_total{action="access_*"}`. Every denied lab-use request:
`authz.decision` with `authorizationResult=denied-access` and `accessState`,
counted in `jtt_authz_decisions_total{result="denied-access"}`. `--by` is
attribution, not authentication ([commercial-access.md §7](../commercial-access.md#7-who-can-change-access-and-the-audit-trail)).

---

## 14. FIRST-TIME STUDENT EXPERIENCE

Traced: IdP sign-in → account created (STUDENT, no entitlement) → dashboard.

- Before: under a future access control, a first-time student would have met an
  unexplained 403 and Verify would have called it a platform fault.
- Now: the dashboard reads `GET /api/me/access` and shows "Your account does not
  have lab access yet … contact your instructor or JumpToTech support", with a
  quotable reference `ACCESS_NOT_ACTIVE · NONE`. The catalog, lab pages and
  learning paths stay browsable (not blank). Start/Verify/terminal show the
  same words. Operator: `ops access list --state NONE` shows who is waiting.
- Dead end remaining: the student must sign in once before they can be granted
  (no invitations — OPERATOR DECISION).

## 15. OFFBOARDING EXPERIENCE

- Expiry: automatic at `--until`; student sees "Your lab access has ended …
  Your progress and history are kept."
- Suspension / revocation: immediate on the next request; history kept; account
  still signs in and reads progress.
- Revocation and deletion are **separate**: revocation changes one row. Account
  deletion is **not supported** (no code path; FKs without cascade block it
  while sessions or access rows exist) — OPERATOR DECISION, not improvised.

## 16. SUPPORTABILITY

An operator can now distinguish, without reading raw tables:

| Cause | How |
|---|---|
| authentication failure | RB-14; `AUTH_*` codes |
| database/sign-in store unavailable | `AUTH_UNAVAILABLE` 503; RB-02 |
| no entitlement | `ops access show` → NONE, with the grant command |
| expired | → EXPIRED at <time> |
| scheduled | → SCHEDULED, opens at <time> |
| suspended / revoked | → state + who and why from history |
| second account (paid on another identity) | `ops access find --email` lists all matches |
| capacity / paused / provider | `ops show` says "access is not the problem — run `ops status`" |
| runtime failure | existing outcomes (`provision_failed`, `platform_error`) |

Runbook: [commercial-access.md §8](../commercial-access.md#8-diagnosing-an-access-problem);
[private-beta-operations.md §4](../runbooks/private-beta-operations.md#4-a-student-cannot-start-a-lab)
has the new `access_denied` outcome.

---

## 17. DATABASE CHANGES

Migration `006_access_entitlements.sql` (forward-only, checksum-verified):

- `access_entitlements` — PK `(user_id, scope)`; CHECKs on scope, status,
  granted_via and `expires_at > starts_at`; FK to `users` without cascade;
  index on status.
- `access_events` — identity PK; CHECKs on scope, action (past tense:
  `GRANTED`… so `backup-restore-safety.test.ts`'s privilege-word scan stays
  meaningful), actor length, reason length, statuses; FK to `users`; index
  `(user_id, occurred_at DESC)`.
- index `users_by_lower_email`.

Additive: no existing table altered, no row touched. Existing progress and
session data is unaffected. Proven on PostgreSQL 16 under `make test-db`.

## 18. API CHANGES

- `403 ACCESS_NOT_ACTIVE` `{details:{accessState}}` on Start, terminal grant,
  Check, Reset, hints, Continue and `/internal` credential/activity when access
  is not ACTIVE (policy `entitlement`).
- `GET /api/me/access` → `{policy, state, active, startsAt, expiresAt}` (own only).
- Operator socket: `GET /v1/access`, `GET /v1/access/find?email=`,
  `GET /v1/access/<id>`, `POST /v1/access/<id>/{grant,suspend,restore,revoke}`.
- Config: `ACCESS_POLICY`. Metrics: start outcome `access_denied`; authz result
  `denied-access`; seven `access_*` operator actions. Log event
  `ops.operator.access_changed`; log fields `accessState`, `accessPolicy`.
- Compose passes `ACCESS_POLICY`; production-host contract check `access.policy`.

## 19. WEB CHANGES

`errors.ts` access kind and per-state words; dashboard `AccessNotice`; terminal
overlay sentence; `api.getAccess`; types. No redesign.

---

## 20. SECURITY FINDINGS

Attacked (all by tests unless marked):

| Attack | Result |
|---|---|
| student grants/extends/unsuspends self | no browser route mutates access (404 on every plausible path); the only writer is the host-only socket |
| student reaches admin endpoint | none exists over HTTP; the ADMIN role grants nothing over access |
| student modifies another student | mutations take an internal id on the host-only socket only |
| expired student launches directly via API | 403 at the API, not just the UI |
| revoked student with stale browser state | every lab-use request re-checks live |
| revoked student with a stale terminal token | the credential exchange refuses on attach/reconnect (C-2) |
| identifier enumeration | `/api/me/access` is self-only; non-owners still get 404 before any access check |
| role spoofing | roles never come from claims (unchanged); roles don't bypass access |
| mass assignment | Start ignores the body; the operator socket refuses unknown fields |
| log/audit injection | `--by` restricted charset, reason single-line, request id validated (C-7) |
| store unavailable | fails closed (500), never grants |

Residual (not fixed; documented): an already-open terminal WebSocket survives
revocation until it disconnects or idles out; a Start racing a revocation can
succeed once; any IdP account can still sign in and create a `users` row and
read the catalog (content-is-paid decision); `--by` is self-declared.

---

## 21. SAFE VALIDATION RESULTS

| Check | Result |
|---|---|
| `npm run typecheck` (all workspaces + scripts) | **PASS** |
| `npm run build` | **PASS** |
| `git diff --check` | **PASS** (before every commit) |
| `npm test` | **PASS** — 0 failed |
| `npm run test:security` | **PASS** — 0 failed |
| `make test-db TEST_DB_PORT=55463` (throwaway `postgres:16-alpine`, unique name, image already present, removed after) | **PASS** |
| `promtool test rules infrastructure/observability/prometheus/tests/*.test.yml` | **PASS** |
| `npm run production:config-check -- --self-test` (`docker compose config` only; no daemon action) | **PASS** |

## 22. EXACT TEST COUNTS

`npm test` (final tree before the `test:security` commit; that commit changes
only the security script):

| Workspace | Passed | Skipped |
|---|---|---|
| api | 743 | 16 |
| web | 268 | 0 |
| lab-orchestrator | 1390 | 253 |
| observability | 946 | 38 |
| progress | 96 | 1 |
| sandboxd | 161 | 7 |
| terminal | 196 | 22 |
| verifier | 1832 | 0 |
| **total** | **5632** | **337** |

`npm run test:security`: 291 + 117 + 85 + 208 + 8 + 197 + 10 = **916 passed, 0 failed**.

`make test-db`: progress 117 passed / 3 skipped; lab-orchestrator session store
181 passed; api persistence 26 passed (incl. 6 access).

## 23. SKIPPED VALIDATION + REASON

- **Browser E2E (`npm run test:e2e`), five-student `beta-validate`, Docker/kind
  integration suites** — they start shared compose/kind infrastructure, which
  the shared-infrastructure rule forbids. E2E runs with `NODE_ENV=test`, so its
  stack stays `ACCESS_POLICY=open` and is unaffected; no E2E test exercises
  `entitlement` yet.
- **A real deployment** — none exists to test against; the PostgreSQL store is
  proven only under `make test-db`.
- The 337 skipped tests are the repository's env-gated integration suites
  (RUN_INTEGRATION_TESTS / RUN_DB_TESTS / Docker), skipped as designed.

---

## 24. OPERATOR DECISIONS REQUIRED

1. **Running labs when access ends** — auto-teardown, or idle out (current).
2. **Do staff roles need an entitlement?** — currently yes.
3. **Is lab content paid?** — catalog and instructions are readable by any
   signed-in account.
4. **Who may sign in** (IdP restriction) — still open; now affects browsing only.
5. **Invitations / pre-sign-in grants** — not supported; student signs in first.
6. **An authenticated admin identity** inside the app — host shell is the boundary.
7. **Trial length, cohort length, renewal, pricing** — none in code.
8. **Manual vs paid grant precedence** — for when payment exists.
9. **Account deletion / anonymisation and retention** of users, progress, access
   history, backups — everything kept indefinitely.
10. **Show the access end date to students** — API returns it; page shows state only.
11. **Sign out everywhere** for a compromised account — `destroyAllForUser` exists, unused.
12. **Deploy switch**: production becomes `entitlement` on deploy — grant current
    students first, or set `ACCESS_POLICY=open` until they are.

## 25. FUTURE PAYMENT INTEGRATION BOUNDARY

```text
payment provider → verified webhook (signature, dedupe by event id) →
AccessStore.mutate({userId, action, actor, reason, grant}) →
access_entitlements + access_events → AccessControl.decide() on every request
```

Payment changes entitlements; it never becomes authentication and never
bypasses `decide()`. Minimal interface: `AccessStore.mutate` (atomic,
serialised, idempotent, self-auditing). To add: customer↔account mapping via
the platform's internal user id as the checkout client reference (never email);
webhook verification and an event-dedupe table; a `granted_via` value and an
external reference column (new migration); precedence rules. Details:
[commercial-access.md §9](../commercial-access.md#9-the-future-payment-boundary).

## 26. WHAT MUST EXIST BEFORE CHARGING STUDENTS

- This branch reviewed and merged, and **every current student granted** before
  the deploy flips production to `entitlement` (or `open` set deliberately).
- Decisions 1, 3, 7 and 9 above (running-lab policy, paid content, terms/length,
  retention/deletion) — they are business and legal, not code.
- A documented manual process linking a payment to `ops access grant` (who runs
  it, with what `--reason` convention, how fast).
- An end-to-end proof on the real host (sign in → NONE → grant → lab → expire)
  and one E2E test under `ACCESS_POLICY=entitlement`.
- The existing release-gate items unrelated to access (IdP choice, host, TLS,
  backups off-host) from the private-beta release gate.

## 27. WHAT CAN WAIT UNTIL AFTER PRIVATE BETA

Payment provider integration and webhooks; self-service checkout; plans and
per-plan limits; track/cohort scopes; invitations; an admin UI; named admin
identities; account deletion tooling; showing the access end date in the UI.

## 28. KNOWN RESIDUAL RISKS

- Open terminal WebSocket survives revocation until disconnect/idle
  (`--end-sessions --yes` mitigates).
- Start vs revoke TOCTOU: one lab may start in the instant of revocation.
- `--by` is self-declared; host access control is the real boundary.
- Anyone the IdP admits can sign in, create an account row and read lab content.
- `access list` caps at 1000 rows.
- No account deletion path.
- Production flips to `entitlement` on deploy — an operator who misses §24
  item 12 locks every current student out until they are granted (loud,
  recoverable).

---

## Final summary

```
BRANCH:                        feat/overnight-commercial-readiness
STARTING MAIN SHA:             24e09f132d522b8de713e696bd0a682f3be74d93
COMMITS CREATED:               9 (8 before this report + the report)
PRODUCT/ACCESS DEFECTS PROVEN: 7 (C-1…C-7; 4 on main, 3 caught in this work)
PRODUCT/ACCESS DEFECTS FIXED:  7
ENTITLEMENT FOUNDATION:        IMPLEMENTED (platform scope, status + window, computed state)
ADMIN MANAGEMENT:              IMPLEMENTED (host-only operator CLI; no HTTP admin endpoint)
EXPIRATION:                    IMPLEMENTED
SUSPENSION:                    IMPLEMENTED
REVOCATION:                    IMPLEMENTED
AUDIT TRAIL:                   IMPLEMENTED (access_events + logs + metrics)
PAYMENT PROVIDER IMPLEMENTED:  NO
TESTS ADDED:                   62 Vitest + 1 promtool case + 2 config-check self-test cases
TYPECHECK:                     PASS
BUILD:                         PASS
SAFE FULL TEST:                PASS (5632 passed, 337 skipped, 0 failed)
SECURITY TEST:                 PASS (916 passed, 0 failed)
RUNTIME TESTS DEFERRED:        browser E2E, beta-validate, Docker/kind integration
OPERATOR DECISIONS REQUIRED:   12 (§24)
KNOWN RESIDUAL RISKS:          7 (§28)
REPORT:                        docs/releases/overnight-commercial-readiness.md
COMMERCIAL FOUNDATION READY FOR CODE REVIEW: YES
READY TO CHARGE PUBLIC SELF-SERVICE CUSTOMERS: NO
```
