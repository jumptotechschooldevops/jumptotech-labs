# Commercial access — who may use labs

How JumpToTech Labs decides whether a signed-in person may use labs, how an
operator grants and withdraws that, and where a payment system would later
connect. Implemented in `apps/api/src/access/`, migration
`services/progress/migrations/006_access_entitlements.sql`, and the operator
socket (`apps/api/src/operator.ts`).

- [1. The model](#1-the-model)
- [2. What changed](#2-what-changed)
- [3. ACCESS_POLICY](#3-access_policy)
- [4. States and transitions](#4-states-and-transitions)
- [5. What access controls](#5-what-access-controls)
- [6. Operator runbook](#6-operator-runbook)
- [7. Who can change access, and the audit trail](#7-who-can-change-access-and-the-audit-trail)
- [8. Diagnosing an access problem](#8-diagnosing-an-access-problem)
- [9. The future payment boundary](#9-the-future-payment-boundary)
- [10. Plans, trials and limits](#10-plans-trials-and-limits)
- [11. Data lifecycle](#11-data-lifecycle)
- [12. Operator decisions required](#12-operator-decisions-required)
- [13. Known limits](#13-known-limits)

## 1. The model

Six separate concepts, each stored separately. None implies another.

| Concept | Question it answers | Where it lives | Changed by |
|---|---|---|---|
| **Identity** | Who is this person, permanently? | `users` — `(issuer, subject)` is the identity; email and name are descriptive | First sign-in (created); every sign-in (email and name refreshed) |
| **Authentication** | Did they prove it just now? | `auth_sessions` (a hash of the browser cookie), or a verified bearer token | Sign-in, sign-out, cookie expiry |
| **Role** | What staff powers do they hold? | `users.role` — STUDENT, INSTRUCTOR, ADMIN | Database only; never a token claim |
| **Entitlement** | May they *use labs*, and until when? | `access_entitlements` (one row per user and scope) | The operator socket only (§6) |
| **Lab session** | What are they running right now? | `lab_sessions` | Start, End, the reaper |
| **Progress** | What have they done? | `students`, `lab_attempts`, `lab_progress`, `hint_usage` | Start, Check, hints |

Not modelled, because nothing in the product needs them yet: organisations,
cohorts, courses, per-track or per-lab sales, invitations, plans, prices,
subscriptions, payments. §9 and §10 say where each would attach.

## 2. What changed

Before this change, **an account was lab access**. Any identity the configured
OIDC issuer authenticated was provisioned as STUDENT on first sign-in and could
start, attach to, verify and reset labs indefinitely
([authentication.md §4.7](authentication.md)). There was no way to:

- admit only paying or enrolled students — the only lever was the identity
  provider's own configuration;
- let access lapse at the end of a paid period;
- pause one student's access, or withdraw it, without deleting their account
  (and deleting was not supported either);
- see who had access, or why.

A terminal token minted while somebody had access also kept opening shells
after that stopped being true, because the terminal's credential exchange
checked only session ownership.

## 3. `ACCESS_POLICY`

| Value | Meaning | Default |
|---|---|---|
| `entitlement` | Only an account whose entitlement is ACTIVE may use labs | under `NODE_ENV=production` |
| `open` | Every signed-in account may use labs — the behaviour before this change | everywhere else (development, tests, the local stack) |

Any other value refuses to start the api. Set it in `.env` (passed through
`docker-compose.yml`) and apply with `prod up -d api`. `npm run
production:config-check` warns (`access.policy`) when production would run
`open`. Under `open`, entitlements can still be granted and are recorded, but
are not enforced.

**Deploying this to an existing production host switches it to `entitlement`
unless `ACCESS_POLICY=open` is set.** Grant every current student before the
deploy (§6.2), or set `open` and grant at leisure.

## 4. States and transitions

An operator stores a **status**: `ACTIVE`, `SUSPENDED` or `REVOKED`, and a
**window** `[startsAt, expiresAt)`. The **state** a student is in is computed
from both and the clock — so access expires on time with no job running:

| State | Meaning | May use labs |
|---|---|---|
| `NONE` | Signed in at least once; never granted | no |
| `SCHEDULED` | Granted; the window has not opened yet | no |
| `ACTIVE` | Granted, and now is inside the window | **yes** |
| `EXPIRED` | Granted; the window has closed | no |
| `SUSPENDED` | Paused by an operator; restorable with the same window | no |
| `REVOKED` | Withdrawn by an operator; only a new grant restores it | no |

The window is half-open: access begins *at* `startsAt` and has ended *at*
`expiresAt`. `expiresAt` empty means no end date, and is only ever set by
`--no-expiry`: a grant without `--until` or `--no-expiry` is refused.

| Action | From | To | Refused from |
|---|---|---|---|
| `grant` | NONE, ACTIVE (incl. expired or scheduled), REVOKED | ACTIVE with the given window. On an ACTIVE row the start is kept unless `--from` is given | SUSPENDED — a grant must not silently undo somebody's suspension; `restore` it, or `revoke` then `grant` |
| `suspend` | ACTIVE | SUSPENDED, window kept | NONE, REVOKED |
| `restore` | SUSPENDED | ACTIVE, window kept (if the window has closed meanwhile, the state is EXPIRED) | NONE, REVOKED |
| `revoke` | ACTIVE, SUSPENDED | REVOKED, window kept for the record | NONE |

Repeating a change already in effect writes nothing and says so. A retried
command is harmless.

Changes are serialised per student (a row lock on the user), and each change is
written in the same transaction as its audit event.

## 5. What access controls

Checked live on every request, so expiry, suspension and revocation take
effect on the next request — no sign-out, no job, no restart.

| Operation | Needs ACTIVE access | Route |
|---|---|---|
| Start a lab | **yes** — refused before an attempt is opened or a slot counted | `POST /api/labs/:id/start` |
| Open or reopen the terminal | **yes** | `POST /api/sessions/:id/terminal` |
| Terminal credential exchange (every WebSocket attach and reconnect) | **yes** — a token minted before access ended opens no new shell | `POST /internal/sessions/:id/credentials` |
| Verify | **yes** | `POST /api/sessions/:id/check` |
| Reset | **yes** | `POST /api/sessions/:id/reset` |
| Reveal a hint | **yes** | `POST /api/sessions/:id/hints` |
| Continue (keep a lab from idling out) | **yes** | `POST /api/sessions/:id/activity` and the terminal's typing report |
| Browse the catalog, tracks, learning paths, lab pages | no | `GET /api/labs…`, `/api/tracks…`, `/api/learning-paths…` |
| See their own running lab | no | `GET /api/sessions`, `GET /api/sessions/:id` |
| End their own lab | no — so a student without access can still free their slot | `DELETE /api/sessions/:id` |
| Read their own progress and history | no | `GET /api/me…` |
| Read their own access | no | `GET /api/me/access` |
| Sign in and out | no | `/auth/…` |

The refusal is `403 ACCESS_NOT_ACTIVE` with `details.accessState` (NONE,
SCHEDULED, EXPIRED, SUSPENDED or REVOKED). It never carries who changed the
access, when, or the operator's reason. For somebody else's session the answer
is still `404 SESSION_NOT_FOUND`, exactly as before — the access check runs
after ownership.

The dashboard reads `GET /api/me/access` and tells a student without access
what their state means before they press Start. Start, Verify and the terminal
use the same words (`apps/web/src/lib/errors.ts`).

Under `open`, `GET /api/me/access` says `policy: open, active: true`.

**A lab already running when access ends is not torn down automatically**
(OPERATOR DECISION, §12). Everything that uses it is refused from the next
request; it keeps its slot until it idles out (it can no longer be kept alive)
or its absolute lifetime ends, or an operator ends it (`--end-sessions`, §6.5).
A terminal WebSocket that is already open stays open until it disconnects or
idles out; no new one can be opened.

## 6. Operator runbook

Every command runs through `ops`, defined in
[runbooks/private-beta-operations.md §1](runbooks/private-beta-operations.md#1-the-production-command)
(`prod exec -T api … operator-cli.ts`). Add `--json` to any command for the
raw answer. Instants are ISO 8601 **with an offset**: `2026-12-31T23:59:59Z`
or `2027-01-01T00:59:59+01:00`. A bare date or local time is refused, because
it would mean a different moment on every host.

Every change needs `--by <you>` (who, 1–64 of letters, digits, `.`, `-`, `_`,
`+`, `@`) and `--reason <text>` (why, one line, up to 500 characters). Do not
put payment card data, passwords or anything secret in a reason: it is stored,
and shown in `access show`.

### 6.1 Find a student

A student must have **signed in once** before they can be granted: that is
what creates their account. There is no invitation by email (§12).

```bash
ops access find --email student@example.com
```

Prints every account with that email — there can be more than one if two
identity providers were used — with its internal id, state and window.
Changes always name the internal id, never an email.

```bash
ops access list                      # every account
ops access list --state NONE         # signed in, waiting for access
ops access list --state ACTIVE
```

### 6.2 Authorize a student

```bash
ops access grant <user-id> --until 2026-12-31T23:59:59Z --by aisalkyn --reason "cohort 1, invoice 1042"
ops access grant <user-id> --no-expiry --by aisalkyn --reason "staff account"
ops access grant <user-id> --from 2026-11-01T09:00:00Z --until 2027-01-31T23:59:59Z --by aisalkyn --reason "cohort 2 starts 1 Nov"
```

The student can start a lab on their next request — no sign-out needed.

### 6.3 Verify access and inspect status

```bash
ops access show <user-id>
```

Shows the account, the policy, the state and whether they may use labs, the
window, **why** (in operator terms, with the next command to run), their
running labs, and the last 20 changes with who, when, why, before and after.

### 6.4 Extend or shorten access; let it expire

Grant again with the new end. On an ACTIVE entitlement the start is kept:

```bash
ops access grant <user-id> --until 2027-03-31T23:59:59Z --by aisalkyn --reason "renewed"
```

Access expires by itself at `--until`; nothing needs to run. To end it early,
grant with an earlier `--until` (it must be in the future) or `revoke`.

### 6.5 Suspend and restore

```bash
ops access suspend <user-id> --by support --reason "payment disputed"
ops access restore <user-id> --by support --reason "dispute resolved"
```

`suspend` lists the student's running labs and leaves them running. To end them
in the same step (their unsaved work in the sandbox is lost; progress is not):

```bash
ops access suspend <user-id> --by support --reason "…" --end-sessions --yes
```

### 6.6 Revoke

```bash
ops access revoke <user-id> --by aisalkyn --reason "left the programme"
ops access revoke <user-id> --by aisalkyn --reason "…" --end-sessions --yes
```

Revocation deletes nothing: the account still signs in, and the student still
sees their progress and history. A later `grant` restores lab use.

### 6.7 Mistakes

| Mistake | Fix | What the history shows |
|---|---|---|
| Granted the wrong account | `revoke` it, `grant` the right one | both, with reasons |
| Wrong `--until` | `grant` again with the right one | both grants |
| Suspended or revoked by mistake | `restore` (suspension) / `grant` (revocation) | the mistake and the correction |
| Ended somebody's lab by mistake (`--end-sessions`) | Cannot be undone; they start a new lab. Progress is kept | the change, and `ops.operator.session_ended` in the api log |

Nothing is ever edited or deleted in the history. Never correct access with SQL.

### 6.8 Audit administrative changes

`ops access show <user-id>` prints a student's recent history. For all changes,
a read-only query against the database (via `make db-shell` on the host,
[postgres-backup-restore.md](runbooks/postgres-backup-restore.md)):

```sql
SELECT e.occurred_at, e.action, e.actor, e.reason, e.before_status, e.after_status,
       e.after_expires_at, u.email
  FROM access_events e JOIN users u USING (user_id)
 ORDER BY e.occurred_at DESC LIMIT 100;
```

Each change is also logged as `ops.operator.access_changed` (user id, action,
outcome, resulting state — not the reason, email or name) and counted in
`jtt_operator_actions_total{action="access_grant"|…}`.

## 7. Who can change access, and the audit trail

**Only someone who can `docker exec` into the api container.** The operator
socket is a Unix socket in a 0700 directory inside the container; it is on no
network and needs no credential, because whoever can reach it already holds the
database password in that container's environment (the argument in
`apps/api/src/operator.ts`). No HTTP route — browser or `/internal` — can grant,
change, list or read anyone's access but the caller's own `GET /api/me/access`.
A student has no path to it whatever their role, and the ADMIN role grants
nothing over access.

`--by` therefore **attributes** a change; it does not **authenticate** it. The
host's own access control (who has a shell and can run `docker`) is the
authentication, and its logs are the second record of who ran `ops`. A named,
authenticated admin identity inside the application needs a decision about the
identity provider (§12) and was deliberately not improvised.

What the audit trail records, per change: the internal user id, action, `--by`,
`--reason`, status and window before and after, and the time. It never records
a token, cookie, secret, or anything a student typed. Every denied lab-use
request is one `authz.decision` log line with `authorizationResult:
denied-access` and `accessState`, counted in
`jtt_authz_decisions_total{result="denied-access"}`.

## 8. Diagnosing an access problem

| The student says | Look at | It means |
|---|---|---|
| "I can't sign in" / sees the sign-in page again | RB-14 | Authentication, not access |
| "Your sign-in could not be checked" (`AUTH_UNAVAILABLE`) | RB-02 | The database is unreachable |
| "Your account does not have lab access yet" (`ACCESS_NOT_ACTIVE · NONE`) | `ops access find --email …` | Signed in, never granted — `grant` (§6.2). If they paid, the grant was missed |
| "Your lab access has ended" (`… EXPIRED`) | `ops access show <id>` | The window closed at the time shown; `grant` with a later `--until` |
| "Your lab access has not started yet" (`… SCHEDULED`) | `ops access show <id>` | `--from` is in the future |
| "Your lab access is paused" (`… SUSPENDED`) | `ops access show <id>` → history | Who suspended and why; `restore` when resolved |
| "This account no longer has lab access" (`… REVOKED`) | `ops access show <id>` → history | Who revoked and why |
| "I paid but it still says no access" and `show` says ACTIVE | `ops access find --email …` | Probably a **second account** (another identity provider or address): the grant is on the other one |
| Has access, cannot start a lab | `ops status`, then [private-beta-operations.md §4](runbooks/private-beta-operations.md#4-a-student-cannot-start-a-lab) | Not access: capacity, a paused platform, a provider, or their own running lab |
| Terminal says "Your lab access is not active" | `ops access show <id>` | Access ended while the lab was running (§5) |

`ops access show` states whether the problem is access at all, and under
`ACCESS_POLICY=open` says that access cannot be the reason. To see a student's
recent denials:

```bash
prod logs --since 1h api | grep '"authorizationResult":"denied-access"' | grep '<user-id>'
```

## 9. The future payment boundary

**A payment provider changes entitlements. It never becomes authentication,
and never bypasses authorization.**

```text
  payment provider ──webhook──► verify signature, dedupe the event id
                                        │  (a new, separate component)
                                        ▼
                      the same mutation the operator socket calls:
                      AccessStore.mutate({ userId, action: GRANT|SUSPEND|REVOKE,
                                           actor, reason, grant: { startsAt?, expiresAt } })
                                        │
                                        ▼
                         access_entitlements  +  access_events
                                        │
                                        ▼
            AccessControl.decide(userId)  — unchanged, on every lab-use request
```

What already exists for it:

- **One write path.** `AccessStore.mutate` (`apps/api/src/access/entitlements.ts`)
  is atomic, serialised per user, idempotent for a repeated change, and writes
  its own audit event. A webhook handler calls it; it does not write SQL.
- **`granted_via`** says how a row came to exist; only `operator` exists today.
  A payment integration adds its value (e.g. `payment`) in a new migration, so
  support can always tell a manual grant from a paid one.
- **Explicit windows.** A subscription period, a fixed-length cohort and a
  trial are all a `[startsAt, expiresAt)`; nothing assumes a length.
- **Identity untouched.** Sign-in, `users`, `auth_sessions` and roles do not
  change when payment does.

What a payment integration must add (not built here):

1. **Customer ↔ account mapping.** A provider knows a customer and an email;
   the platform knows `(issuer, subject)`. Mapping by email is unsafe (§6.1).
   The robust shape is: the signed-in student starts checkout, and the platform
   passes its own internal user id as the provider's client reference, so the
   verified webhook names the account directly.
2. **Webhook verification** (signature, timestamp) and **event deduplication**
   (a processed-event table keyed by the provider's event id).
3. **An external reference** on the entitlement or event (subscription id) and
   a `granted_via` value — a new migration.
4. **Precedence rules** between manual and paid grants (§12).

## 10. Plans, trials and limits

- **Free trial** — a grant with `--until` a fixed interval from now. No trial
  length exists in the code; choose it (§12).
- **Paid fixed-duration cohort** — a grant with `--from`/`--until`.
- **Monthly subscription** — a grant renewed each period; lapses on its own if
  a renewal is missed.
- **Scholarship / manual access** — a grant with a reason saying so.
- **Staff / instructor** — a grant (`--no-expiry` if appropriate). Roles do not
  bypass access (§12).

**Resource limits are unchanged and still apply to everyone with access:**
`MAX_ACTIVE_SESSIONS_PER_STUDENT` (beta: 1) and `MAX_ACTIVE_SESSIONS` are
enforced inside the session manager's capacity lock, after the access check, so
an entitlement cannot raise either. A per-plan limit (e.g. two concurrent labs
for one tier) would be a column on the entitlement read at that same point; it
does not exist.

Scope is `platform` only: every lab. Selling a track, course or cohort
separately is a new scope value and a check in `AccessControl.decide` that
takes the lab — a migration and one function, not a redesign.

## 11. Data lifecycle

What the platform stores about a person. Retention is **not** decided by the
code except where stated.

| Data | Table | Personal data | Lifetime today | Backed up |
|---|---|---|---|---|
| Identity: issuer, subject, email, display name, role | `users` | email, name; subject may be email-shaped | Forever. No deletion path exists | yes (`make db-backup` dumps the whole database) |
| Browser sign-ins (hash of cookie, expiry) | `auth_sessions` | no | Until expiry; expired rows purged by a sweep; deleted with the user (cascade) | yes |
| Entitlement: status, window | `access_entitlements` | no | Forever | yes |
| Access history: who, why, before/after | `access_events` | the operator's reason is free text | Forever, append-only | yes |
| Lab sessions (ids, lab, status, times, owner) | `lab_sessions` | no | Finished rows deleted after `SESSION_RETENTION_MINUTES` | yes |
| Progress: attempts, completions, hints | `students`, `lab_attempts`, `lab_progress`, `hint_usage` | keyed by internal user id | Forever | yes |
| Sandbox contents (files, shell history in the lab) | the container / namespace | whatever the student typed | Destroyed with the session | no |
| Logs | container stdout | user ids; never email, reasons or tokens | Docker log rotation | no |

**Revocation and deletion are separate.** Revoking access changes one row and
deletes nothing. Deleting an account is not supported: `users` has no deletion
path, `lab_sessions.owner_user_id` and both access tables reference it without
cascade (so a delete fails while any exist), and progress is keyed by the
internal id. A deletion or anonymisation procedure — which tables, what to keep
for accounting, and how it interacts with backups — is an operator decision
(§12), not something to improvise with SQL.

## 12. Operator decisions required

| Decision | Until decided |
|---|---|
| **Running labs when access ends**: tear down automatically, or let them idle out | They idle out; `--end-sessions --yes` ends them on demand (§5) |
| **Does INSTRUCTOR/ADMIN need an entitlement to use labs?** | Yes — roles do not bypass access; grant staff accounts |
| **Is lab content itself paid?** The catalog and lab pages (instructions) are readable by any signed-in account, entitled or not | Readable. Restricting them is one more route in §5 |
| **Who may sign in at all** ([authentication.md §4.7](authentication.md)) | Anyone the issuer authenticates can sign in, see the catalog and their (empty) history; only entitled accounts can use labs |
| **Invitations**: grant before first sign-in (by email) | Not supported: the student signs in first, then is granted. Granting by email would make an address an identity |
| **An authenticated admin identity** inside the application (named operators, per-person permissions) | Host shell access is the admin boundary; `--by` is attribution (§7) |
| **Trial length, cohort length, renewal rules, prices** | None exist in code |
| **Manual vs paid grant precedence** once payment exists | Only manual grants exist |
| **Account deletion / anonymisation, and retention** of users, progress, access history and backups | Everything is kept indefinitely; backups follow `BACKUP_RETENTION_DAYS` |
| **Showing the access window to students** (e.g. "access until 31 Dec") | `GET /api/me/access` returns it; the page shows the state only |
| **Sign out everywhere** when an account is compromised (`destroyAllForUser` exists, nothing calls it) | Not available to operators |

## 13. Known limits

- A student already inside a lab when access ends keeps an open terminal until
  it disconnects or idles out (§5). Use `--end-sessions --yes` when that matters.
- A Start that passed the access check a moment before a revocation completes
  still starts (one lab, then refused on every use). The check and the start are
  not one transaction.
- `--by` is self-declared (§7).
- `access list` returns at most 1000 accounts; `find` at most 20 per email.
- The PostgreSQL store is proven by `access-persistence-integration.test.ts`
  under `make test-db`; no real deployment has run it yet.

## Tests

| Suite | Proves |
|---|---|
| `apps/api/test/access-entitlements.test.ts` | the transition table, window boundaries, instants and offsets, input rules, idempotence, serialised concurrent changes, fail-closed store |
| `apps/api/test/commercial-access.test.ts` | enforcement on every route in §5, the full lifecycle over HTTP, the credential exchange, no self-service path, no mass assignment, no enumeration, the per-student limit, the policy default and refusal |
| `apps/api/test/operator-access.test.ts` | every operator command over a real socket and the real CLI, attribution, refusals, idempotence, `--end-sessions --yes`, what is logged and what never is |
| `apps/api/test/access-persistence-integration.test.ts` | migration 006 on real PostgreSQL, two processes racing, restart, schema constraints (`make test-db`) |
| `services/progress/test/migrations.test.ts` | migration 006 is additive, one row per user, no cascade, no credential column |
| `apps/web/test/dashboard.test.tsx`, `student-logic.test.tsx` | the student-facing words, and never "a platform problem" |
| `services/observability/test/production-host-contract.test.ts`, `production:config-check --self-test` | the production `access.policy` warning |
| `infrastructure/observability/prometheus/tests/lab-start-alerts.test.yml` case 10 | an `access_denied` Start pages nobody |
