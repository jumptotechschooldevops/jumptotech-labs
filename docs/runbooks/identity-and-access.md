# Identity and access operations

The one procedure for adding, removing and protecting student accounts: who
may sign in, who may use labs, and how to end either. Commands use `ops` from
[private-beta-operations.md §1](private-beta-operations.md#1-the-production-command).
How grants work in detail is [commercial-access.md §6](../commercial-access.md#6-operator-runbook);
alert-driven sign-in failures are [RB-14](RB-14-auth.md). This page says which
to use, in what order, and what each leaves behind.

## 0. The model

| Layer | Decided by | Created / changed | Ends with |
|---|---|---|---|
| **May sign in** | The identity provider, only. The api admits every account the configured issuer authenticates | Provider admin console | Removing or disabling the user **at the provider** (stops *new* sign-ins only) |
| **Account** (`users`) | First successful sign-in: `(issuer, subject)`, role `STUDENT` | Automatically; email and name refreshed on each sign-in | Not deleted in operation (§2) |
| **Signed in** (`auth_sessions`) | A browser's cookie, 12 h absolute (`AUTH_SESSION_TTL_SECONDS`), no idle timeout | Each sign-in | Sign out, `ops sign-out`, expiry |
| **May use labs** | `ACCESS_POLICY=entitlement` (production default) + an ACTIVE grant | `ops access grant` | `ops access suspend` / `revoke`, or `--until` passing |
| **Terminal** | A token from Start or Reconnect, ≤ 1 h, bound to the lab session, its owner, and the sign-in that asked for it | Each Start / Reconnect | Its sign-in ending, access ending, the lab ending, or its hour |
| **Role** | `ops role set` only; never a provider claim | Operator | `ops role set <id> STUDENT` |

What each action ends, as of #173 and #175:

| Action | Browser sign-ins | New terminals | Open terminal | Running lab | Progress | Can sign in again |
|---|---|---|---|---|---|---|
| Student presses Sign out | that browser | that browser's tokens | that browser's: closed at next keystroke (≤ 30 s of typing) | keeps running | kept | yes |
| `ops sign-out` | **all** | all | all, at next keystroke | keeps running | kept | yes |
| `ops access suspend` / `revoke` | kept | refused (`ACCESS_NOT_ACTIVE`) | closed at next keystroke | keeps its slot until idle | kept | yes, but cannot use labs |
| … with `--end-sessions --yes` | kept | refused | closed now | **ended now** | kept (attempts stay) | yes, but cannot use labs |
| Disabled at the provider | **kept** until expiry (≤ 12 h) | allowed while signed in | open | running | kept | no |

The last row is why §2 and §9 always run `ops sign-out` as well: the api never
asks the provider again after sign-in.

## 1. Add a beta student

1. **At the provider:** add the person (assignment, group, or directory entry
   per [private-beta-deployment.md §2.3](private-beta-deployment.md)). Self-service
   sign-up stays off.
2. **The student signs in once.** That creates the account. They see "Your
   account does not have lab access yet".
3. **Find exactly their account:**

   ```bash
   ops access find --email <their-email>
   ```

   Check, before granting: exactly one account; `firstSignInAt` matches when
   they say they signed in; the issuer is this deployment's. Two accounts with
   one email, or one you did not expect, means someone else signed in with that
   address — stop and find out which is theirs (ask the student the time they
   signed in; check the provider's sign-in log). The api does not record whether
   the provider verified the email.
   **Never grant every `ops access list --state NONE` row**: that list is
   "everyone the provider let in", which is only the five when the provider is
   restricted.
4. **Grant:**

   ```bash
   ops access grant <user-id> --until 2026-12-31T23:59:59Z --kind beta --by <you> --reason "private beta cohort 1"
   ops access show <user-id>        # ACTIVE, kind BETA
   ```

   Effective on their next click; no sign-out needed.

## 2. Remove a beta student (keep their progress)

```bash
ops access show <user-id>                                  # note their running lab, if any
ops access revoke <user-id> --by <you> --reason "left the programme" --end-sessions --yes
ops sign-out <user-id> --by <you> --reason "left the programme"
```

Then remove them **at the provider** so they cannot sign in again.

- `revoke` refuses every lab use from the next request and closes an open
  terminal at its next keystroke; `--end-sessions --yes` tears the lab down now.
  Without it the lab idles out (it can no longer be kept alive).
- `sign-out` ends their browser sessions now; without it they stay signed in
  (catalog and their own history only) until the 12 h expiry.
- **Progress, attempts and the access history are kept.** Nothing here deletes
  them, and nothing should: `DELETE FROM users` is refused by the foreign keys
  from `lab_sessions` and `access_entitlements` and is not a supported path.
  Account deletion or anonymisation is an open decision
  ([commercial-access.md §12](../commercial-access.md#12-operator-decisions-required)).
- A temporary removal is `suspend` instead of `revoke`; `restore` undoes it.

## 3. "I can't sign in"

| They see | Meaning | Do |
|---|---|---|
| The provider's own error page, never back at the app | The provider refused them | Provider console: are they assigned / in the directory? A sixth person is *supposed* to be refused here |
| "Sign-in was cancelled" | They pressed Cancel | Nothing |
| "That sign-in did not finish" (`?signin=expired`) | Page left open > 10 min, Back button, or two tabs signing in at once | Close other tabs, sign in once. Repeated for one student: cookies blocked for the site |
| "Sign-in did not complete" (`?signin=failed`) | The code or ID token was refused | Which step: `jtt_auth_callback_total` by `outcome` ([RB-14 §2](RB-14-auth.md#2-scope-it--outcome-names-the-cause)). A provider refusal or outage is also logged (below); a refused ID token is counted only, never logged, so it cannot be tied to one student. Several students: RB-14 |
| "Sign-in is unavailable right now" | The provider could not be reached | §7 |
| Signed in, "Your account does not have lab access yet" | Signed in fine; no grant | §1 step 3–4 |

```bash
q 'sum by (outcome) (increase(jtt_auth_callback_total{outcome!="success"}[1h]))'
prod logs --since 1h api | grep '"event":"auth.login.unavailable"'   # provider refusals and outages
```

## 4. "It says I'm not allowed" / unauthorized

- **"Your lab access is …" (`ACCESS_NOT_ACTIVE · <STATE>`)**: `ops access show <user-id>`
  and act on `diagnosis` ([commercial-access.md §8](../commercial-access.md#8-diagnosing-an-access-problem)).
- **"This lab environment no longer exists"** on a lab they believe is theirs:
  it ended (idle, time limit, Reset/End) or it is not theirs. Ownership never
  changes; there is nothing to grant. They start a new one.
- **"Not available for your account"** on `#/classroom`: they are a
  `STUDENT`. Only `ops role set` changes that ([private-beta-operations.md §7.4](private-beta-operations.md#74-making-someone-an-instructor-or-an-administrator)).

## 5. "My session expired"

A browser sign-in lasts 12 h from sign-in, absolutely; there is no refresh
and no idle timeout. The page says "Your sign-in has expired" and keeps the
place they were. **The lab keeps running** and their progress is saved: they
sign in and carry on. If it happens much sooner than 12 h for one student, their
browser is discarding cookies (private window, cookie clearing on exit). For
everyone at once, check the api clock and `AUTH_SESSION_TTL_SECONDS`.

## 6. "My terminal lost its connection / access expired"

| Terminal bar | Meaning | Do |
|---|---|---|
| "The terminal's access expired." then it reconnects by itself | Its token reached its hour, or its sign-in ended while another tab signed in again | Nothing |
| … then the sign-in page | The browser signed out (another tab, `ops sign-out`, or 12 h) | Sign in; the lab is still there |
| "Your lab access is not active, so the terminal cannot open" | Access suspended, revoked or expired | §4 |
| Anything else | Not an authorization problem | [incident F/G](private-beta-incident-response.md#f-the-terminal-disconnected), [RB-12](RB-12-terminal.md) |

## 7. The identity provider is unavailable

Students already signed in are not affected (sessions live in PostgreSQL and
are never checked against the provider); only new sign-ins fail, with "Sign-in
is unavailable right now". **Tell the class not to sign out.** Diagnose with
[RB-14 §0](RB-14-auth.md#0-identityproviderunreachable--the-provider-is-down-not-us).
Nothing in the platform can substitute for the provider: there is no local
fallback login, deliberately.

## 8. Suspected stolen session (cookie, laptop, shared machine)

```bash
ops access find --email <their-email>
ops sign-out <user-id> --by <you> --reason "suspected stolen session: <ticket>"
```

Every browser signed in as them is refused from its next request, every
terminal token they were issued stops opening shells, and an open terminal
closes at its next keystroke. Their lab and progress are untouched and they
simply sign in again. If the attacker could sign in *at the provider* (password
taken), reset it there first, or they will just sign in again. Look for what
the session did: `ops access show <user-id>` (live labs), the classroom view's
recent events for them, and `authz.decision` log lines with their user id.

## 9. Emergency: revoke all access for one account, now

```bash
ops access suspend <user-id> --by <you> --reason "<why>" --end-sessions --yes
ops sign-out <user-id> --by <you> --reason "<why>"
```

Then disable them at the provider. Suspension (not revocation) keeps the
decision reversible with `restore`. Verify: `ops access show <user-id>` shows
`SUSPENDED` and no live sessions. **For everyone at once** (a leaked client
secret, a compromised provider): stop launches
([private-beta-operations.md §3](private-beta-operations.md#3-should-students-stop-launching-labs)),
rotate `OIDC_CLIENT_SECRET` at the provider and in `.env`, restart the api,
and end every sign-in. There is no bulk `sign-out`; this is the one sanctioned
SQL here, and it signs out every student and staff browser:

```bash
prod exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DELETE FROM auth_sessions"'
```

## 10. Never

- Grant from a list of accounts you did not check (§1 step 3).
- Delete `users` rows, or edit `role` / `access_entitlements` with SQL.
- Put a password, token, cookie or card number in `--reason`: it is stored and
  shown by `access show`.
- Assume removing someone at the provider signed them out: it did not (§0).
