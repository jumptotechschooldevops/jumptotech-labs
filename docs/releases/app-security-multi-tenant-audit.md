# Application security and multi-tenant isolation audit — 2026-09-27

**Question.** Can student A read, modify, execute against, reset, delete,
attach to, verify or otherwise affect student B's session? And can an
unauthenticated, malformed, replayed, forged, high-volume or wrongly
authorized API or WebSocket request cross a security boundary?

**Answer.**
- **Through the application layer (HTTP API, terminal WebSocket, internal
  service APIs): no.** Every path was traced server-side, probed with two or
  more real identities, and pinned by tests.
- **Through the terminal host: yes, for Kubernetes- and Docker-track shells.**
  They all run as uid 1001, so one student can read another's per-session
  kubeconfig or Docker client key. This is the known SEC-ARCH-2 limitation,
  already proven live in the release gate. It is outside the application layer
  and is the one cross-tenant blocker.
- Three abuse paths let a single caller create unbounded expensive work. They
  were measured, fixed and regression-tested.

| | |
|---|---|
| Starting main | `92c0aaf` |
| Final main | `396f3e1` (after the four merges below; this report lands on top of it) |
| Scope | apps/api, services/terminal, services/sandboxd (trust only), services/progress, apps/web (auth/terminal client), nginx edge |
| Out of scope (owned by other audits) | container/runtime hardening, network policy, shell injection, capacity, DR |

## 1. Entry points audited

| Surface | Method + path | AuthN | AuthZ | Rate limit |
|---|---|---|---|---|
| API | `GET /health` | none (by design) | — | — |
| API | `GET /auth/config`, `GET /auth/session` | optional cookie | own session only | — |
| API | `GET /auth/login`, `GET /auth/callback` | none (sign-in) | signed tx cookie + state + PKCE + nonce | **new: 120/min/address** |
| API | `POST /auth/logout` | cookie | origin guard | — |
| API | `GET /api/labs[/:id]`, `/api/tracks…` | required | catalog (public to signed-in) | — |
| API | `GET /api/learning-paths[/:id]` | required | catalog | 600/min/address |
| API | `POST /api/labs/:id/start` | required | owner = caller; entitlement | 20/min/student (shared with reset) |
| API | `GET /api/sessions` | required | `owner_user_id = caller` in SQL | — |
| API | `GET /api/sessions/:id` | required | guard: owner, or INSTRUCTOR/ADMIN read | — |
| API | `POST /api/sessions/:id/terminal` | required | guard: owner only | — |
| API | `POST /api/sessions/:id/check` | required | guard: owner only; 1 in flight | **new: 40/min/student** |
| API | `POST /api/sessions/:id/reset` | required | guard: owner only | 20/min/student |
| API | `POST /api/sessions/:id/activity`, `/hints` | required | guard: owner only | — |
| API | `DELETE /api/sessions/:id` | required | guard: owner, or ADMIN | — |
| API | `GET /api/me`, `/progress`, `/attempts`, `/attempts/:id`, `/access`, `/learning-paths/:id` | required | `student_id = caller` in SQL | 600/min on learning-paths |
| API | `POST /internal/sessions/:id/credentials`, `/activity` | `x-internal-secret` (constant time) | token `uid` must equal live owner; entitlement | — |
| Terminal | `WS /terminal` | HMAC token in first frame; origin allow-list | `sid`+`uid` re-proved by API on every attach | **new: 30 burst, 30/min/student** |
| Terminal | `POST /internal/{terminate,reattach,workspace/*}` | `x-internal-secret` (constant time) | session id from API; workspace path confinement | — |
| sandboxd | attach WS / runtime routes | three scoped secrets | container derived from session id + labels | shell ceiling |
| Operator | Unix socket `/v1/*` | filesystem (0700, `docker exec`) | — | — |

Not reachable from the browser: `/internal` on both services (nginx proxies
only `/api/`, `/auth/`, `/terminal`, refuses raw targets outside the prefix;
the api also refuses dot segments), sandboxd, metrics ports, the operator
socket.

## 2. Authentication model

- **Identity sources, in order** (`auth/middleware.ts` `authenticate`):
  1. Session cookie `jtt_session`: 256-bit random, only its SHA-256 stored.
     It indexes a server-side row that names the user. A cookie that is
     present but unusable gets a 401 and never falls through to the header.
  2. `Authorization` header:
     - `oidc` mode: `Bearer` JWT, verified with jose `jwtVerify` against the
       discovered JWKS. Issuer and audience are checked, `exp` is required,
       only asymmetric algorithms are accepted, clock skew is 5 s, and `azp`
       is checked for ID tokens.
     - `development` mode: `Developer <name>`. It is refused at startup when
       `NODE_ENV=production`, and `AUTH_MODE` defaults to `oidc`.
- **Principal.** A user is `(issuer, subject)` upserted into `users`. The role
  column is never taken from claims; it changes only through
  `UserRepository.setRole`, which no route calls.
- **Failure shape.** Missing, empty, malformed, wrong-scheme or expired
  credentials all get a 401 with a coarse code. A credential store that cannot
  be reached gets a 503 `AUTH_UNAVAILABLE`. Neither case falls back to
  anonymous or default access in `oidc` mode.
  - Evidence: `authentication.test.ts`, `auth-security.test.ts`,
    `oidc-flow-hardening.test.ts`, `production-oidc-config.test.ts`, and the
    probe in §8.
- **Browser flow.**
  - state and nonce are 32 random bytes each; the PKCE S256 verifier is 48.
  - The transaction cookie is HMAC-signed with a key derived by HKDF from the
    client secret. It expires after 10 minutes and uses `Path=/auth`.
  - returnTo is confined to same-origin paths.
  - A new session id is minted on every sign-in, which prevents fixation.
  - Logout deletes the row. Expiry is absolute and enforced in SQL.

## 3. Authorization model (as implemented)

- Roles: `STUDENT`, `INSTRUCTOR`, `ADMIN` (`auth/identity.ts`). Every decision
  goes through `authorize()` in `auth/policy.ts`.
- Owned actions: read, check, reset, activity, end, hint, terminal. The owner
  may do all of them.
- Cross-user exceptions: INSTRUCTOR may `read`; ADMIN may `read` and `end`.
  `terminal`, `check`, `reset`, `activity` and `hint` are owner-only for every
  role.
- A session with no owner is reachable by nobody, not even an ADMIN.
- A non-owner gets a 404 that is identical to "does not exist". The audit log
  records `denied-not-owner` or `denied-unowned`.
- There are no HTTP admin endpoints. Administration (ending sessions, access
  grants) is the operator Unix socket.
- Lab access (entitlements) is checked after ownership, so a non-owner never
  learns the owner's access state.

## 4. Student identity and session ownership

- `ownerUserId` is set at Start from `req.user.userId` (`labs.ts`). No body or
  query field is read. The in-memory store ignores owner on update, and the
  Postgres store never updates `owner_user_id`, so ownership is immutable for
  the life of the row.
- Progress student id is `studentIdForUser(req.user.userId)` whenever a user
  is authenticated (always, behind `authenticate`). The development header is
  consulted only with no user, which cannot happen on these routers.
- The namespace, sandbox ref and container are always derived from the stored
  session. No route accepts one.
- Recovery and reaper adopt existing rows and keep their owner. Unlabelled
  orphans are never adopted (BETA-P0-007/008).

## 5. Results by question

| # | Question | Result | Evidence |
|---|---|---|---|
| 8 | HTTP authorization | **PASS** | guard on every `:sessionId` route; `authorization.test.ts`, `five-student-adversarial.test.ts`, new `role-boundaries.test.ts` |
| 9 | WebSocket authorization | **PASS** | HMAC token; `sid` and `uid` from the verified token only; re-auth refused; origin allow-list; `terminal-ownership.test.ts` ×2, `concurrent-attach.test.ts` |
| 10 | Terminal ownership | **PASS (app layer)**; host uid SEC-ARCH-2 **CLOSED** by #117/#123 (§14) | `internal.ts` re-checks `uid` against the live owner on every attach and reattach; release gate §6 |
| 11 | Session create | **PASS** | owner server-assigned; per-owner limit atomic under the capacity advisory lock (`postgres-store.ts createWithinLimits`); `student-session-limit.test.ts` |
| 12 | Session read | **PASS** | 404 for non-owner; list is owner-scoped in SQL (#71 reviewed) |
| 13 | Session delete | **PASS** | owner or ADMIN only; anonymous 401 |
| 14 | Session reset | **PASS** | owner only; atomic RESETTING claim; 20/min |
| 15 | Verification ownership | **PASS** | targets derived from the stored session; no request field names a sandbox; `verifyLab` scoped per session |
| 16 | Progress ownership | **PASS** | `getAttempt … WHERE attempt_id = $1 AND student_id = $2`; `listProgress`/`listAttempts` by student; attempt IDOR returns 404 |
| 17 | Recovery ownership | **PASS** | owner column immutable; recovery acts on existing rows only |
| 18 | IDOR/BOLA | **PASS** | §8 |
| 19 | Token replay | **PASS with residual** | the token is a reusable bearer up to `min(1 h, session remaining)`, bound to `sid`+`uid`, re-proved live; dead after End (409); **not** revoked by browser logout (P2-3) |
| 20 | Token expiry | **PASS** | `exp` enforced (`terminal-ownership.test.ts` "refuses an expired token"; new attach-budget test) |
| 21 | Rate limiting | **FIXED** (3 gaps) | §7 |
| 22 | Session-creation abuse | **PASS** | 8 concurrent starts by one student: 1 admitted (`five-student-adversarial`); per-owner count atomic; 20/min per student |
| 23 | Terminal-connection abuse | **FIXED** | one shell per session already enforced; attach *rate* was unbounded (61/s) → budget |
| 24 | Error disclosure | **PASS** | central handler; provider words stripped for students; `error-disclosure.test.ts` ×2; probe: no stack, path or SQL on malformed input |
| 25 | Secret logging | **PASS** | api logs route templates, not URLs; nginx logs `$uri` (no query, so no OAuth `code`); terminal auth failures log no token; `log-redaction.test.ts`, `terminal-content-logging.test.ts` |
| 26 | CORS/CSRF | **PASS with P2** | explicit allow-list, credentials, never `*`; origin guard on every non-GET under `/api` and `/auth`; SameSite=Lax; terminal WS authenticates by token, not cookie, so cross-site WebSocket hijacking gets nothing; see P2-1 |

## 6. IDOR / BOLA matrix (two or more real identities)

Probe: a composed API, fake runtime, four identities. Alice, Bob, an
INSTRUCTOR and an ADMIN each hold a live session.

| Caller → Alice's session | GET | terminal | check | reset | activity | hints | DELETE | internal creds (own uid) |
|---|---|---|---|---|---|---|---|---|
| Bob (STUDENT) | 404 | 404 | 404 | 404 | 404 | 404 | 404 | 403 |
| INSTRUCTOR | 200 | 404 | 404 | 404 | 404 | 404 | 404 | 403 |
| ADMIN | 200 | 404 | 404 | 404 | 404 | 404 | 200 | 403 |
| anonymous (oidc) | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 (no secret) |

Also probed:
- **Method confusion.** HEAD, PUT, PATCH, `POST /:id`, `GET …/check`,
  `DELETE …/reset`, trailing slash, `//`, upper-case path and `;x` suffix give
  404 or 400. OPTIONS is a CORS preflight only.
- **Prototype and mass assignment.**
  - A body of `{"__proto__":{"ownerUserId":…,"role":"ADMIN"}}` on Start: the
    session still belongs to the caller and `Object.prototype` is unpolluted.
  - `{"__proto__":{"level":1}}` on hints is refused 400.
  - The Start body `{ownerUserId, studentId, status, provider}` is ignored.
- **Malformed input.**
  - Hint `level` accepts only 1–50 after `parseInt`; `"1abc"` and `[1]`
    coerce to 1 (harmless laxness).
  - `?limit=` of -5, 1e12, NaN or an array is clamped by the service.
  - Attempt ids that are SQL-shaped or 5000 characters long return 404.
- **Role claims.** `?role=ADMIN`, an `X-Role` header, a body `role` field or a
  `Developer ADMIN` subject do not change the stored role.

## 7. Fixes

| PR | Finding | Severity | Measured before | After |
|---|---|---|---|---|
| #75 → `5bef804` | Terminal attach rate unbounded: each attach is a credentials exchange (k8s TokenRequest, or 3 `docker exec` cert reads) plus a shell | P1 | 183 attaches in 3 s (61/s) from one token | per-student token bucket (30 burst, 30/min) checked before any exchange; 4429 `ATTACH_RATE_LIMITED`; live shell untouched |
| #79 → `1620145` | Check rate unbounded (one in flight only) | P1 | ~100 checks/s, 5 sandbox execs each, one student | 40/min/student; refused check reads and records nothing |
| #82 → `d59cb06` | Anonymous replay of a signed transaction cookie drove unlimited IdP token-endpoint calls with the platform's client credentials | P2 | unbounded | 120/min/address on `/auth/login` + `/auth/callback`, before the router |
| #85 → `396f3e1` | No HTTP-level test of INSTRUCTOR/ADMIN boundaries | test gap | — | 6 tests, mutation-checked |

## 8. Findings

**P0 — none in the application layer.**

**P0 for an untrusted cohort / P1 for the trusted private beta — shared uid
1001 on the terminal host (SEC-ARCH-2, known). CLOSED 2026-09-28 by #117 and
#123; see §14.**
- Kubernetes- and Docker-track shells are spawned by the terminal service
  after it drops to uid 1001. Per-session credentials are 0600 files owned by
  uid 1001 in `/run/jumptotech`.
- Any student can list that directory, or read other shells'
  `/proc/<pid>/environ` (same uid) for `KUBECONFIG` and `DOCKER_CERT_PATH`,
  then act in another student's namespace or DinD daemon, or write to
  their workspace (`/proc/<pid>/cwd`).
- `docs/secret-boundaries.md` §5 says "if they can find its path". The path
  is trivially discoverable, and workspace tampering is not mentioned there.
- Proven live in the release gate (§6). Fix: a per-session uid, a runtime
  change owned by the runtime-hardening track.

**P1 — fixed:** #75, #79 (above).

**P2**

1. **Cookie tossing from a sibling subdomain.**
   - Neither `jtt_session` nor `jtt_session_tx` uses the `__Host-` prefix, and
     `parseCookies` keeps the last duplicate.
   - Anyone controlling a sibling of the app's host can plant their own
     session cookie (login CSRF / account swap), or plant a transaction
     cookie together with a callback code.
   - `__Host-` is deliberately refused today because the tx cookie is
     `Path=/auth` (DR-09). The fix is to move the tx cookie to `Path=/` and
     prefix both.
   - Only matters if the public host shares a registrable domain with
     hosts the operator does not control.
2. **No idle timeout on browser sessions.** Only the absolute TTL applies
   (12 h default, max 7 d).
3. **Terminal token survives sign-out** until its expiry (≤ 1 h).
   - The browser holds it in memory only, and sign-out unmounts the terminal
     (close 1000), so exploitation needs a token captured beforehand.
   - Binding the token to the auth session would close it.
4. **sandboxd attach credential is service-scoped, not session-scoped.** A
   compromised terminal can open a shell in any container-track session.
   Known design; not reachable by a student.
5. **Suspend/revoke of lab access leaves running labs running** unless
   `--end-sessions`. Documented operator choice. New attaches are refused by
   the internal entitlement check.
6. **No edge (nginx) connection or request limits.**
   - Unauthenticated WebSocket sockets are held up to 10 s each.
   - Every request carrying a cookie costs one indexed DB read.
   - Belongs to the network/capacity track.
7. **Hint `level` parsing is lax** (`parseInt`). No security effect.

## 9. Integration tests actually executed

| Suite | Where | Result |
|---|---|---|
| `npm run test:security` (58 files, 943 tests: api, terminal, sandboxd, lab-orchestrator, verifier, observability, web) | local, main `d59cb06` | **PASS** |
| `apps/api` full suite | local, each fix branch | **PASS** (762 passed, 16 skipped: DB/integration opt-ins) |
| `services/terminal` full suite | local, #75 rebased on `36ba7d6` | **PASS** (220 passed, 22 skipped) |
| `services/observability` (alert, runbook contracts) | local | **PASS** (954 passed) |
| Postgres: `auth-persistence`, `access-persistence`, `progress-persistence` (api) | local, throwaway `postgres:16-alpine` | **PASS** (26/26) |
| Postgres: `services/progress` repository | local | **FAIL** under host load average ~60 (hook/test timeouts at 10 s/5 s); **PASS** 25/25 rerun with 60 s timeouts |
| Postgres: `session-store-integration` (lab-orchestrator) | local | **FAIL** 2/193 (`session-per-student-capacity` reset tests: leftover-rejection assertion), reproduced with 60 s timeouts on main code this audit did not touch; the same suite **PASSES** in CI `postgres-integration` on every PR below. Not investigated further (capacity/reliability scope); reported, not claimed. |
| Scratch probes (IDOR matrix, method confusion, prototype keys, fuzz, auth fail-closed; attach and check loop rates) | local | results in §6–7; scratch files not committed |
| `browser-e2e`, `kind-integration`, `docker-integration`, `sandbox-integration`, `sandboxd-integration`, `terminal-integration`, `networking-integration`, `tls-edge-integration`, `postgres-integration` | CI on #75, #79, #82, #85 | **PASS** |

## 10. Tests not run, and why

- Live five-student stack (`make beta-validate`), and browser E2E against a
  live stack locally: other agents hold the kind clusters and ports on this
  host, and a second stack would collide (see
  `compose-kind-network-cross-stack-dns`). CI runs `browser-e2e`,
  `kind-integration`, `sandbox-integration`, `terminal-integration` and
  `sandboxd-integration` on every PR above; results are in §11.
- Shared-uid cross-read: not re-run here; it was proven live in the release
  gate soak. It is not claimed as PASS.

## 11. CI

| PR | Checks | Notes |
|---|---|---|
| #75 | 13/13 pass | `postgres-integration` first failed pulling `postgres:16-alpine` from Docker Hub (registry auth timeout); rerun passed |
| #79 | 13/13 pass | updated with main (merge, no force push) after #75 |
| #82 | 13/13 pass | updated with main after #79; both limiters kept |
| #85 | 13/13 pass | updated with main after #79 and #82 |

All four squash-merged when `MERGEABLE`/`CLEAN`.

## 12. Five-student tenant isolation

- **Application layer: PASS.** Five identities each hold another's live ids
  and every cross move fails without side effects (`five-student-adversarial`);
  roles are pinned (#85).
- **Host layer:** FAIL for untrusted students at the time of this audit
  (SEC-ARCH-2). **CLOSED** since by #117/#123: five concurrent students get
  five distinct shell uids, proven on a real kernel (§14).

## 13. Blockers

- **Private beta (trusted students):** none new. Merge #75 and #79 before
  opening to a cohort; they remove the two ways one student could keep shared
  runtime infrastructure busy.
- **Public release / untrusted cohort:**
  1. ~~per-session uid for terminal shells (SEC-ARCH-2)~~ — done, #117/#123 (§14);
  2. `__Host-` cookies (P2-1), if the host shares a registrable domain;
  3. edge rate and connection limits (P2-6);
  4. idle timeout on browser sessions (P2-2).

## 14. SEC-ARCH-2 — per-session shell identities (follow-up, 2026-09-28)

**Status: CLOSED** for Kubernetes- and Docker-track shells, merged in #117 (`fbc16f4`) and #123 (`bcaf902`). Container-track shells were never affected: each runs in its own sandbox container.

### The original finding

Kubernetes- and Docker-track shells are PTYs the terminal service spawns in its own container. Every one ran as uid 1001, the account the whole service had dropped to under BETA-P0-010. The release-gate soak proved the resulting cross-student read live (§6 there). From any such shell a student could:

- list `/run/jumptotech`, read another student's kubeconfig or Docker client key, and act in their namespace or daemon;
- read `/proc/<pid>/environ` of another student's shell to find those paths, and `/proc/<pid>/cwd` to find their workspace;
- write into another student's workspace, and so change the work Check grades;
- `kill` another student's processes, or the terminal service itself;
- leave a `setsid`/`nohup` process running past End, where it could read the next session's files (red-team O1);
- leave `.bash_history` and files in the one shared Kubernetes HOME for the next student (red-team I8).

### Threat model

- **Attacker:** a student with an ordinary shell in their own session, who knows or can guess other sessions' identifiers.
- **Boundary:** another session's files, processes and credentials, and the terminal service's own memory and secrets.
- **Out of scope here:** container escape, the host kernel, and the sandboxes themselves, which have their own isolation.
- **Requirements:**
  - stable for the life of a session;
  - distinct for concurrent sessions;
  - survives api restart and recovery;
  - no collision for five simultaneous students;
  - no inheritance after cleanup;
  - no weakening of non-root execution;
  - no privileged containers, no Docker socket, no host filesystem;
  - fail closed.

### Implementation

**Allocation (#117).**
- `lab_sessions.shell_uid` is `BIGINT NOT NULL DEFAULT nextval('lab_session_shell_uid_seq')`, with a range `CHECK` (1900000000–1900999999) and `UNIQUE` (migration 007). The sequence is `NO CYCLE`.
- PostgreSQL assigns the uid inside the INSERT, so:
  - it is distinct under concurrency;
  - it is stable across restarts, because it lives on the row;
  - it is never reused, and an exhausted range makes Start fail rather than wrap;
  - rows written by a pre-007 instance during a rollout still get one.
- The in-memory store uses a monotonic counter.
- Both stores discard a caller-supplied `shellUid`, and no patch or transition changes it.
- `SessionManager.getTerminalContext` puts the stored uid on `kubernetes` and `docker-daemon` bindings only, on the owner-checked credential exchange. A local-shell session without a valid uid gets `CREDENTIALS_UNAVAILABLE`.

**Terminal (#123).**
- The image launches the service with `setpriv` as `jtt-terminal` (1002). Its ambient capabilities are exactly SETUID, SETGID and CHOWN; compose adds `CHOWN`.
- Each shell runs as `prlimit --nproc` → `setpriv --reuid/--regid <session uid> --clear-groups --inh-caps=-all --ambient-caps=-all --no-new-privs` → `env -C <home>` → bash.
- Credentials are `0600`, and homes and workspaces `0700`, owned by the session uid, under service-owned `0711` roots.
- Kubernetes shells get a per-session home.
- Verifier reads and Reset restores reclaim the tree for their duration, so no path check can be raced.
- End (`/internal/terminate`) runs `kill -9 -1` *as* the session uid, proves via `/proc` that nothing of it survives, and reclaims and deletes its files.
- Production refuses to start in any of these cases:
  - the service is root;
  - it lacks one of the three capabilities;
  - it holds any other capability;
  - `no_new_privs` is not set;
  - its own uid is in the shell range.

**A hazard found and closed along the way.** A child that changes uid between two non-root uids *keeps* its ambient capabilities. So spawning shells with node-pty's or libuv's own `uid` option would have given every student `CAP_SETUID`. Every shell therefore goes through `setpriv` with the ambient and inheritable sets cleared. Removing that clearing (mutation check, real kernel) left the shell with `CapEff c1`, and `setpriv --reuid=0 true` **succeeded**.

### Evidence

| Requirement | Evidence | Result |
|---|---|---|
| A and B get distinct effective uids, with zero capabilities | `make test-terminal-isolation` (real kernel, production launch and rules) | PASS |
| A cannot read B's private files (kubeconfig, key, home, workspace) | same | PASS |
| A cannot write B's private files | same | PASS |
| A cannot list the credential or workspace roots | same | PASS |
| A cannot signal B's processes or read their `/proc/*/environ` | same | PASS |
| No shell can read the service's `environ` or `mem`, or signal it | same | PASS |
| No shell can reach uid 0 or another session's uid | same | PASS |
| Reconnect keeps the uid and home | same | PASS |
| A restarted api hands out the same uid | `shell-uid-binding.test.ts`; Postgres contract "same uid after a restart" | PASS |
| End kills everything of the uid (a `setsid` escapee included) and removes a `000`-locked home; others untouched | `make test-terminal-isolation` | PASS |
| Never reused after End | store contract, in-memory and PostgreSQL | PASS |
| Concurrent creation never collides | 12 concurrent admissions on real PostgreSQL | PASS |
| A client cannot choose its uid | Start body (`shell-uid-binding`); auth frame (`test-terminal-isolation`) | PASS |
| Invalid uids are refused | `isValidShellUid`; api fail-closed (mutation-checked); terminal refuses uid 1001 and spawns nothing | PASS |
| Five concurrent students: distinct, working, isolated | `test-terminal-isolation` | PASS |
| One student's fork bomb is bounded | `RLIMIT_NPROC` per uid, `test-terminal-isolation` | PASS |
| Lab tools work as the session uid | `kubectl` and its cache, `docker` CLI, umask `0022`; `test-terminal-isolation` | PASS |
| Existing rows get distinct uids on upgrade | `session-shell-uid-migration-integration.test.ts` | PASS |
| Shipped image starts in production, fails closed when misconfigured | manual: healthy as `1002:1002`; refuses without `CHOWN`; refuses without `no-new-privileges` | PASS |
| Full five-student rehearsal through the live stack with Kubernetes or Docker labs | not run here (see below) | NOT RUN |

**CI.** #117: 14/14 checks pass. #123: 14/14 pass. On #123, `terminal-integration` ran `make test-terminal-isolation` on the runner's kernel with 13/13 passing. The first `gates` run failed because the production config gate's capability allow-list did not yet name `CHOWN`; it was fixed in the PR.

### Residual risks

- **`/tmp` is shared** (`1777`). A file a student *deliberately* leaves there world-readable can be read by another student. Homes, workspaces and credentials are private.
- **The container `pids_limit` is shared.** Each shell uid's `RLIMIT_NPROC` (default 128) bounds one student, but a container-wide limit bounds everyone together.
- **The service holds SETUID, SETGID and CHOWN** as a non-root account. A compromise of the terminal service can impersonate any session's shell. It could already reach every session's credentials, since it fetches them.
- **Leftover processes if a terminate is lost.** The api calls `/internal/terminate` best-effort. If that call is lost, a session's escaped processes live until the terminal restarts. They can reach nothing of any other session, because uids are never reused, but they cost resources.
- **Uids overlap across unrelated deployments on one kernel.** Two stacks on one host can hand out the same uid. Their containers do not share files or pid namespaces, but per-uid kernel limits are shared.
- **Not run here.** The five-student live-stack rehearsal (`make beta-validate`) against Kubernetes or Docker labs was not run. Other agents hold the local kind clusters and ports. The catalog sweeps run solutions through the student kubeconfig and the runtime, not through the terminal.

### Result

**SEC-ARCH-2 is CLOSED** as a cross-student risk for the local-shell tracks. §8's "P0 for an untrusted cohort" item and §13's first public-release blocker are resolved by #117 and #123.
