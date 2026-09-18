# Browser E2E for the private beta

**Branch** `feat/browser-e2e-beta` (PR #37), rebased onto `origin/main` at
`fa6f109` (PR #36, post-beta security audit; previously on `9a0e22e`, PR #35,
and `0f33b1f`, PR #34).
**Date** 2026-09-16. Results on this base: §14.3.

## 1. Executive summary

A real Chromium browser drives JumpToTech Labs through the student critical
path against the composed stack. The run is reproducible with one command:

```bash
npm run test:e2e
```

That command builds and starts the stack, waits for a bounded readiness gate,
runs **7 Playwright tests**, and always tears the stack down. The tests are 6
browser tests plus 1 guard test that starts no browser.

**What this is:**

- **Tier A** (real browser + web + API + deterministic dependencies): **PROVEN locally.**
- **Tier B** (real browser + actual sandbox runtime): **PARTIALLY PROVEN.**
  The runtime is real, but only for the Linux provider.
- **Tier C** (production host): **NOT PROVEN.** Nothing here ran on a host,
  domain, TLS edge or real identity provider.
- **CI:** the `browser-e2e` job is configured, but has **never executed**.

The branch is test and CI work plus **one product fix** found by the suite:
the terminal service told a client that had sent its token on time "No
session token received" whenever attaching took more than 10 s (§14.2). The
fix is in `services/terminal/src/server.ts` and has a regression test in
`services/terminal/test/broker-attach.test.ts`.

It is not "full E2E" for the platform. The Kubernetes, Docker, Terraform,
Ansible and CI/CD runtimes are not exercised, the identity provider is a
test-only stand-in, and there is no TLS.

## 2. Previous state

At `cb7804a`, before this branch:

- There was no browser automation (no Playwright, Cypress, Puppeteer, WebDriver
  or Selenium).
- `apps/web/test/**` holds 195 jsdom component tests with the API mocked.
- `make beta-validate` drives the HTTP API and terminal WebSocket protocol with
  `AUTH_MODE=development` and never renders the UI.
- `AUTH_MODE=development` has no browser sign-in.
- The release gate (§2, and again §11.5 after PR #34) said
  "no browser end-to-end".

## 3. Architecture discovered

| Concern | What the code does |
|---|---|
| Web | React 18 + Vite bundle, hash router. In compose, nginx serves the build and proxies `/api/`, `/auth/`, `/terminal` on one origin. |
| Auth | The API is the confidential OIDC client: `/auth/login` → provider → `/auth/callback` → opaque HttpOnly `jtt_session` cookie. A cookie is tried first, then the `Authorization` header. Unsafe methods pass an Origin guard. |
| Session | `POST /api/labs/:id/start` → `SessionManager` → provider → for Linux, `sandboxd` creates a labelled container. Limits are enforced in PostgreSQL. |
| Terminal | `POST /api/sessions/:id/terminal` issues an HMAC token (`sid`, `uid`, …). The browser opens `/terminal` and sends `{type:'auth', token}`. The terminal verifies the HMAC, fetches credentials from the API (which re-checks the owner, 10 s budget), and attaches through `sandboxd` (15 s connect budget). A socket that sends no valid token within 10 s is dropped (`AUTH_TIMEOUT`). |
| Verify | `POST /api/sessions/:id/check` → verifier reads the live sandbox (state, not command history) → attempt recorded. |
| Progress | PostgreSQL attempts/progress (`DATABASE_URL` set by `docker-compose.yml`; the API refuses to start if a configured database is unreachable). |
| Cleanup | `DELETE /api/sessions/:id`; the reaper; `scripts/sandbox-clean.sh` by runtime owner. |

**Changes on main since the branch started (PR #34) and their effect here:**

| Change on main | Affects E2E? |
|---|---|
| Workspace symlink resolution (`services/terminal/src/workspace.ts`) | Not exercised. Those internal workspace endpoints serve Docker-track labs; the Linux lab is read through `sandboxd` exec. Nothing in `e2e/` calls or bypasses them. |
| Unreadable workspace → `ENVIRONMENT_UNREACHABLE` (verifier) | Not exercised (same reason). Unchanged by this branch. |
| `restart: unless-stopped` on production services, `ServiceRestartLoop` | The E2E overlay layers on the **development** files and sets no `restart:`. That matches main's contract ("development deliberately keeps none"), so a crashed service in a test stays down and fails the run instead of looping. |
| Dependency patches (`body-parser` 1.20.8, `qs` 6.16.0, `js-yaml` 4.3.2) | Kept. After the rebase, `package-lock.json` differs from main only by the `e2e` workspace and Playwright entries. |
| Runbooks, observability alerts, release gate §11 | Kept. Release gate §11 is untouched; browser evidence is §12. |

**Changes on main from PR #35 (`9a0e22e`) and their effect here:**

| Change on main | Affects E2E? |
|---|---|
| `npm run validate:labs` and the `Lab catalog validation` step in the `gates` job | Kept. `browser-e2e` `needs: gates`, so it runs only after catalog validation passes. The rebase merged the workflow without conflict: PR #35 edits `gates`, this branch appends a job and edits the header comment. |
| Catalog now 117 labs; NET-022, NET-024, NET-025 placed in the DevOps Engineer path | No assertion depends on the count (the tests match `Overall: N of \d+`). The readiness probe reported 117 labs. |
| `catalog-starter-state.test.ts` (no lab passes Verify on untouched starter files) | Consistent with E2E: LINUX-001's live Verify starts at 1 of 5. |
| TF-026 starter file mode | Not exercised (Terraform disabled in the E2E stack). |
| `package.json` `validate:labs` script | Merged beside this branch's `e2e` workspace and `test:e2e` scripts; no conflict. |

**Changes on main from PR #36 (`fa6f109`, security audit) and their effect here:**

The rebase had no conflicts. Only three files were changed by both, in
separate hunks: `.gitignore`, `package.json` (`test:security` beside
`test:e2e`) and `services/terminal/src/server.ts` (output flow control on
shell start and close, beside this branch's auth-timer and attach changes).
No PR #36 control was changed.

| Change on main | Affects E2E? |
|---|---|
| Terminal output backpressure (`output-flow.ts`) | Exercised on every terminal in the suite; none of its limits is reached by LINUX-001 commands. Unchanged. |
| `SANDBOX_WRITE_RATE_LIMIT` (20 start/reset per minute per user) | Not reached: each test student starts at most one lab. Unchanged, not raised for E2E. |
| Check single-flight (409 `CHECK_IN_PROGRESS`) | Not reached: the suite clicks Verify once and waits. Unchanged. |
| Request-body errors as 400/413/415 | Not exercised by the browser. Unchanged. |
| Lab-asset symlink refusal, verifier linear parsers, container ceilings, `service_http` redirects | Not reached by LINUX-001 in a browser; covered by `npm run test:security`. Unchanged. |
| `.dockerignore` secret exclusions | Extended by this branch with `e2e/.stack/`, where `stack.sh` writes each run's generated secrets before it builds images. No Dockerfile copies `e2e/`, so no image held them, but they were sent to the builder. `build-context-secrets.test.ts` now asserts the rule. |

## 4. Browser framework decision

**Playwright `@playwright/test` 1.63.0 (pinned), Chromium only.**

- There was no existing framework to reuse.
- It has first-class WebSocket routing, for the injected terminal failure.
- It runs multiple isolated browser contexts per test, for isolation.
- It records traces, screenshots and video on failure.
- `--with-deps` installs work on GitHub runners.

It lives in a separate `e2e` npm workspace with no `test` script, so it is
never part of `npm test` and no Dockerfile copies it.

## 5. Test topology

```text
 Chromium (Playwright, host)
   │  http://127.0.0.1:33700  (one origin)
   ▼
 web  nginx + production Vite bundle ──/api,/auth──► api (AUTH_MODE=oidc, NODE_ENV=development)
   │                                  └─/terminal──► terminal ──► sandboxd ──► docker.sock
   │                                                                   └─► LINUX-001 container (jumptotech/lab-linux:e2e)
   │                                    api ──► postgres (sessions, users, auth sessions, progress)
   │                                    api ──server-side──► oidc:9500  (discovery, token, JWKS)
   └─ browser redirect ──► 127.0.0.1:39700  test IdP login page
```

**Files:**

- `docker-compose.yml` + `docker-compose.runtime.yml` (unchanged, from main);
- `e2e/docker-compose.e2e.yml` (test-only overlay);
- `e2e/stack.sh` for orchestration.

**Stack identity:**

- Compose project and runtime owner `jtt-e2e` (CI: `jtt-e2e-<run id>`).
- Its own sandbox network.
- Ports 33700/34700/34701/55700/39700, overridable and checked free before
  start.
- api and terminal are kept off the shared `kind` network.
- The kubeconfig points nowhere.
- Terraform, Ansible, CI/CD and the Docker track are switched off.
- The sandbox image tag is `:e2e`, so the shared `:latest` is never overwritten.

**Readiness gate** (`stack.sh wait` and `e2e/global-setup.ts`, bounded, fail
closed). All of these must hold before any test runs:

- the web root answers 200;
- the discovery issuer is `http://oidc:9500`;
- `/auth/config` reports `mode=oidc` and `signInAvailable=true`;
- `/health` reports labs loaded and the `linux` provider available.

## 6. Component classification — what "real stack" means

| Component | Classification | Notes |
|---|---|---|
| Browser | **REAL** | Playwright Chromium (headless shell), real DOM, cookies, WebSocket |
| Web frontend | **REAL** | production `vite build` bundle from `infrastructure/docker/web.Dockerfile` |
| nginx | **REAL** | the shipped development listener (`web.conf` + `locations.conf`); not the TLS listener |
| API | **REAL WITH TEST CONFIGURATION** | shipped image. `AUTH_MODE=oidc`, `NODE_ENV=development`, loopback `PUBLIC_ORIGIN`, beta limits 5/1, non-Linux providers disabled |
| Authentication (API side) | **REAL WITH TEST CONFIGURATION** | production OIDC code path unmodified: discovery, PKCE, state, nonce, client secret, RS256/JWKS, HttpOnly cookie, Origin guard. Differences from production: `http:` issuer, non-`Secure` cookie on loopback |
| OIDC/IdP | **STUBBED** | `e2e/oidc-provider/server.mjs`, a test-only provider that speaks real OIDC but authenticates anyone who types a well-formed username |
| Database | **REAL** | `postgres:16-alpine`, migrations applied, durable stores; volume deleted at teardown |
| Terminal service | **REAL** | shipped image, broker mode through sandboxd |
| WebSocket | **REAL** | browser WebSocket → nginx upgrade → terminal service. Two tests deliberately alter it: F-4 closes it in the browser (**MOCKED** for that test), and E2E-010 sends a forged token over the real socket |
| Session manager | **REAL** | inside the API, PostgreSQL-backed |
| sandboxd | **REAL** | shipped image, holds the Docker socket as in the runtime overlay |
| Docker runtime (Linux sandbox containers) | **REAL** | per-session container from `sandbox-linux.Dockerfile` |
| Docker track (per-session Docker daemon) | **NOT EXERCISED** | `DOCKER_TRACK_ENABLED=false` |
| Kubernetes runtime | **NOT EXERCISED** | kubeconfig points at an unreachable address; the provider reports unavailable. Nothing is faked |
| Terraform runtime | **NOT EXERCISED** | `TERRAFORM_PROVIDER_ENABLED=false` |
| Ansible / CI/CD runtime | **NOT EXERCISED** | disabled |
| Verifier | **REAL** | Linux requirement types only (§10) |
| Terminal workspace endpoints (PR #34) | **NOT EXERCISED** | Docker-track only |
| TLS | **NOT EXERCISED** | plain `http`/`ws` on loopback; no production overlay |
| Production host | **NOT EXERCISED** | local Docker Desktop only |

## 7. Tests implemented — per-test review

There are 7 tests: 6 browser tests and 1 non-browser guard.

### 7.1 `student-critical-path.spec.ts` — "a student signs in, completes LINUX-001 in the browser terminal, and the result persists"

- **Student flow:** anonymous visit → Sign in → IdP login form → dashboard →
  Learning Path → Labs search → LINUX-001 → Launch → terminal commands →
  Verify (fail) → type solution → Verify (pass) → full reload → Progress →
  End lab.
- **Backend components:** nginx, web bundle, API (auth, labs, sessions, me,
  learning paths), PostgreSQL, test IdP, terminal, sandboxd, Docker, verifier.
- **Security boundaries crossed:**
  - the OIDC code flow;
  - HttpOnly + SameSite=Lax cookie, not readable by `document.cookie`, and no
    token-like Web Storage key;
  - the Origin guard on unsafe methods (the browser's real requests);
  - terminal token issue + verify + owner credentials fetch (happy path).
- **What it proves:**
  - One student can do the whole beta loop in a real browser.
  - Verify grades the live sandbox (1 of 5 before, 5 of 5 after).
  - A reload reattaches to the same sandbox with the files still present.
  - Completion is shown on the Progress page (`Overall: 1 of N`).
  - End lab removes the container (checked in Docker).
  - No uncaught page errors.
- **What it does NOT prove:** other tracks, reset, idle and expiry, a real IdP,
  TLS, survival of an API restart or database restart, or mobile layout.

### 7.2 `student-isolation.spec.ts` — "a second student cannot reach the first student's session, terminal, sandbox, verification or progress"

- **Student flow:**
  1. Student A (context A) launches LINUX-001, writes a private file and
     passes Verify.
  2. Student B (context B, different IdP username) signs in, visits A's
     workspace URL and the Progress page, then launches their own LINUX-001
     and presses Verify.
  3. B's page opens raw terminal WebSockets.
- **Backend components:** as 7.1, with two users, two sandboxes and two
  attempts.
- **Security boundaries crossed:**
  - per-browser cookie identity;
  - session ownership on six routes;
  - per-session sandbox;
  - verifier scoping to the caller's own session;
  - progress scoping by user;
  - the terminal token HMAC at the real WebSocket.
- **What it proves:**
  - B's UI shows no running lab, `LINUX-001 is not running` at A's URL, and
    never contains A's session id.
  - With B's cookie, GET, terminal grant, check, activity, reset and DELETE on
    A's real id all return `404 SESSION_NOT_FOUND`, and A stays ACTIVE.
  - Filesystems are separate in both directions.
  - B's Verify reports `1 of 5` while A has passed.
  - B's Progress shows 0 completed while A's shows 1.
  - From B's browser, B's own grant attaches and runs a command (positive
    control). The same token with `sid` re-pointed at A's session is closed
    **4401 UNAUTHORIZED** with none of A's output. A's terminal keeps working.
- **What it does NOT prove:**
  - That the terminal refuses a *validly signed* token naming A's session
    with B's uid. The forged token here fails the HMAC check; a signed
    cross-owner token cannot be minted from a browser. The owner re-check at
    the credentials fetch is covered by
    `services/terminal/test/broker-attach.test.ts` ("opens no shell at all
    when the API refuses the ownership check", stub API) and the API's own
    ownership suites, not by this browser test.
  - A token *stolen* from A's browser used by B. The token is a bearer
    credential bound to A's session and A's uid; possession would work for
    that session until expiry. That is by design, and not covered.
  - Isolation for Kubernetes, Docker-daemon or Ansible sandboxes, or the
    Docker-track workspace endpoints.
  - More than two students.
  - Anything about the shared shell uid limitation in release gate §6.

### 7.3 `failure-paths.spec.ts` — "[injected] API unreachable: the app says so and recovers on retry"

- **Student flow:** open the app while `/auth/session` is refused → error →
  Try again.
- **Backend components:** web bundle and nginx. The failing request is
  **MOCKED** by `page.route`.
- **Security boundaries crossed:** none.
- **What it proves:** the UI renders "Cannot reach the labs API." with a
  working retry.
- **What it does NOT prove:** real outage behavior. Measured separately: a
  stopped API container gave ~39 s of "Checking your session…" before the
  error (§15).

### 7.4 `failure-paths.spec.ts` — "anonymous and forged sessions get nothing; sign-out revokes the cookie server-side"

- **Student flow:** an anonymous browser; a browser holding a forged
  `jtt_session`; sign in → Sign out → re-add the old cookie.
- **Backend components:** API auth, the PostgreSQL auth-session store, IdP,
  web.
- **Security boundaries crossed:** authentication middleware (cookie path),
  server-side session revocation.
- **What it proves:**
  - Without a cookie, `/api/sessions` and lab start return 401, and the UI
    shows the sign-in gate.
  - A forged cookie is anonymous.
  - After Sign out the old cookie value returns 401: revocation is server-side.
- **What it does NOT prove:** expiry after `AUTH_SESSION_TTL_SECONDS`,
  federated logout at a real IdP, or CSRF from a real cross-site page.

### 7.5 `failure-paths.spec.ts` — "a second lab while one is running is refused clearly (one lab per student)"

- **Student flow:** launch LINUX-001 → open LINUX-002.
- **Backend components:** API sessions, the PostgreSQL limit enforcement,
  sandboxd, Docker.
- **Security boundaries crossed:** the per-student session limit (server) and
  the UI pre-check.
- **What it proves:** the UI says "You already have a lab running" and links to
  Continue LINUX-001 with no Launch button. The server independently returns
  `429 STUDENT_SESSION_LIMIT_REACHED`.
- **What it does NOT prove:** the global capacity of 5
  (`make beta-validate` covers that at API level), or concurrent races.

### 7.6 `failure-paths.spec.ts` — "[injected] terminal WebSocket refused: the workspace says it could not connect, and Try again recovers"

- **Student flow:** launch while the browser's `/terminal` socket is closed
  (1011) → error overlay → Try again with the socket passed through.
- **Backend components:** real session and sandbox; the terminal socket is
  **MOCKED** until retry, then REAL.
- **Security boundaries crossed:** the real terminal auth on retry.
- **What it proves:** the workspace reaches "The terminal could not connect"
  (bounded, no spinner), and Try again connects for real.
- **What it does NOT prove:** real terminal-service outages, or a slow
  attach. §14.2 records the slow-attach defect that load exposed, which this
  injected test could not have caught.

### 7.7 `test-identity-provider-guard.spec.ts` — "[guard] the test identity provider refuses production and non-loopback configurations"

- **Student flow:** none. No browser; the provider is spawned as a process.
- **Backend components:** `e2e/oidc-provider/server.mjs` only.
- **Security boundaries crossed:** the provider's own start-up refusals.
- **What it proves:** it exits 2 before listening for:
  - `NODE_ENV=production`;
  - an `https`/public issuer;
  - a public browser base;
  - a public redirect URI;
  - a client secret under 32 characters.

  It never prints the secret.
- **What it does NOT prove:** anything about the API. The API side is pinned by
  `apps/api/test/browser-e2e-overlay.test.ts` (§9).

## 8. Summary of what the suite does NOT prove

- **Other runtimes:** Kubernetes, Docker-daemon, Terraform, Ansible, CI/CD and
  AWS labs in a browser.
- **Session lifecycle paths:** reset, second-tab terminal takeover, reload
  during CREATING, idle warning, and expiry.
- **Production configuration:** the production overlay, TLS, `wss://`, and
  `Secure` cookies.
- **Real IdP behavior:** discovery, key rotation, MFA, admission policy and
  federated logout.
- **Hosts and scale:** any production host, more than two students, and real
  API or terminal outages. Those two tests inject the failure; see §15.
- **Other clients:** Firefox, WebKit and mobile viewports; no accessibility
  audit.
- **Restarts:** progress persistence across an API or PostgreSQL restart. The
  store is PostgreSQL, but no restart is exercised.

## 9. Authentication strategy and safety review

**Mechanism.** The real OIDC authorization-code flow runs against a test-only
identity provider. The E2E branch adds to the API:

- no route;
- no header;
- no environment flag;
- no token format;
- no bypass.

`git diff origin/main...HEAD -- apps/api/src apps/web/src services` is empty.
The only API-adjacent file is a test.

**Checked:**

| Concern | Finding |
|---|---|
| `NODE_ENV` / production | Under `NODE_ENV=production` the API refuses the overlay's loopback `PUBLIC_ORIGIN`, and with an `https` origin it still refuses the `http:` issuer. Pinned by `apps/api/test/browser-e2e-overlay.test.ts`, which reads the values from the overlay file (5 cases, in `npm test`). `docker-compose.production.yml` pins `NODE_ENV=production` and `AUTH_MODE=oidc`, so layering the E2E overlay on it cannot start an API against the test IdP. |
| Test-only routes | None added. The IdP's routes exist only in its own container. |
| Test headers | None. `DEV_STUDENT_HEADER_ENABLED` is explicitly `"false"` in the overlay. The `api*` helpers send only the `Origin` header a same-origin browser fetch sends. |
| Test tokens | None minted by tests. ID tokens come from the IdP's per-process RSA key and are verified by the API over JWKS. The one forged terminal token is used only to prove refusal. |
| Mock users | None seeded. Users are created by the API's normal upsert on first sign-in, as role `STUDENT`, with unique random usernames per test. |
| OIDC bypass | None. The IdP enforces an exact redirect URI, PKCE S256, single-use requests and codes, a constant-time client secret and nonce (hermetic probe on this branch). |
| Environment flags | The IdP refuses `NODE_ENV=production`, non-loopback hosts and short secrets (test 7.7). Per-run secrets from `openssl rand -hex 32` sit in a git-ignored mode-600 file deleted at teardown, and none appeared in service logs after a full run. |
| Shipped artefacts | No root compose file, Dockerfile or the Makefile references `e2e/`, `oidc-provider` or `E2E_OIDC` (pinned by the same API test). |

**Conclusion:** the test authentication mechanism cannot become a production
bypass without someone editing shipped compose files **and** removing two
startup refusals in the API **and** the provider's own refusal. The API
tests for those refusals would fail first.

## 10. Session, terminal, verifier and progress

- **Tier B scope:** real for the Linux provider only (sandboxd → Docker
  container).
- **Terminal / WebSocket: REAL.** All four properties are asserted in the
  browser:
  - **Browser connects:** the status reads `Terminal: Connected`.
  - **Command reaches the student's sandbox:** `whoami` = `student`,
    `pwd` = `/home/student`, and files persist across reconnects.
  - **Output returns:** assertions use a shell-computed marker, so the echoed
    command line cannot match.
  - **Ownership boundary:** the token is issued only for the cookie's owner
    (6-route 404 test). A re-pointed token is refused 4401 at the real
    WebSocket, with a positive control on the same code path.
- **Verify: REAL.** The browser's Verify button calls
  `POST /api/sessions/:id/check`. The real verifier grades the live container
  with requirement types `directory_exists`, `file_exists` and `path_absent`.
  - The check is not mocked: a manual negative control typed `cp` instead of
    `mv` and got "4 of 5 … app.log was moved, not copied", and the test failed.
- **Progress: REAL (PostgreSQL).**
  - Verify pass → attempt recorded → `Completed` badge after a full page reload
    → Progress page `Overall: 1 of N`.
  - The E2E API has `DATABASE_URL` pointing at the stack's PostgreSQL (from
    `docker-compose.yml`, unchanged).
  - Per-user scoping is proven by E2E-010 (B: 0, A: 1).
  - Survival across an API or database restart is not exercised.

## 11. CI strategy and review

The `browser-e2e` job in `.github/workflows/quality-gates.yml`:

| Check | Finding |
|---|---|
| Deterministic startup | `npm ci` from the lockfile; Playwright pinned 1.63.0; `npx playwright install --with-deps chromium`; images built from the checkout; Linux sandbox image built under its own tag |
| Readiness, not sleeps | `stack.sh up` = `compose up --wait` + an explicit readiness probe (bounded 300 s), repeated in Playwright global setup (60 s). The only sleeps are poll intervals inside bounded loops |
| Bounded timeout | job `timeout-minutes: 45`; per-test 240 s, expect 20 s, action 20 s, navigation 30 s |
| Teardown after failure | `Tear down` step `if: always()` runs `stack.sh down`, which fails if an owner container survives |
| Artifacts | on failure: Playwright HTML report + `test-results` (traces, screenshots, videos), 7 days; `stack.sh status` and `logs`, and managed containers |
| No secrets printed | secrets generated per run, never echoed; a log scan after a full local run found none of the values |
| Least privilege | workflow-level `permissions: contents: read`; the job adds none |
| No production credentials | uses no `secrets.*`; no registry login; no cloud credentials |
| No conflict with other jobs | own runner (fresh daemon), `needs: gates`, run-scoped project and owner, unique job name; shares the workflow's concurrency group like every other job |
| Coexists with the catalog gate (PR #35) | `gates` now runs `npm run validate:labs`; `browser-e2e` depends on `gates`, so a catalog defect stops it before the stack starts. No gate was removed, relaxed or made optional, and `browser-e2e` does not use `continue-on-error` |

**Observed on a runner once (PR #37, run `35161066075`, commit `9c86bb0`).**
The stack built and became healthy on `ubuntu-latest` (socket GID, registry
pulls and image builds all worked; the job took 4 min 36 s), and the suite
ran **6 passed, 1 failed**. The failure was a product race in the web terminal
handshake, diagnosed and fixed in §14.3. The job has not yet passed in CI.

## 12. Cleanup and concurrency

**Cleanup:**

| Resource | How it is cleaned | Evidence |
|---|---|---|
| Browser contexts | fixture contexts closed by Playwright; explicit contexts closed in `finally` | test code |
| Sessions | every test ends its students' sessions in `finally` (`DELETE /api/sessions/:id`) | E2E-009 asserts none remain |
| Containers | End lab; `stack.sh down` runs `sandbox-clean.sh` for the owner and **fails** if any survive | every run: "Removed 0 container(s)… 0 leaked", including the runs where tests failed |
| Networks | `compose down --remove-orphans`; `sandbox-clean.sh` removes owner networks | down log |
| Workspaces | the Linux sandbox home lives in the container (removed); the terminal container's tmpfs is removed with it | — |
| Database test state | `compose down --volumes` deletes the PostgreSQL volume. On a kept stack users accumulate, but names are random per test, so no test depends on a prior one | — |
| Temporary files | `e2e/.stack/stack.env` deleted by `down`; `e2e/test-results` and `e2e/playwright-report` are git-ignored and overwritten per run | — |

A process killed with SIGKILL skips the shell `trap`. The CI `if: always()`
step still runs, and locally `bash e2e/stack.sh down` is idempotent.

**Concurrency: intentionally serial** (`workers: 1`, `fullyParallel: false`).
This is required for correctness, not only safety:

- students are limited to one lab each and the stack to five;
- E2E-009 asserts the owner has **zero** containers, which a parallel test's
  sandbox would falsify;
- a loaded host already stretches API latency.

Parallelism would need per-test runtime owners or a larger capacity, so it was
not enabled.

## 13. Test commands

```bash
npm ci
npx playwright install chromium          # once per machine

npm run test:e2e                         # up → 7 tests → down (always)
E2E_KEEP_STACK=1 npm run test:e2e        # leave the stack running

npm run e2e:up
E2E_BASE_URL=http://127.0.0.1:33700 E2E_API_URL=http://127.0.0.1:34700 \
E2E_RUNTIME_OWNER_ID=jtt-e2e npm run test:e2e:running -- tests/student-isolation.spec.ts
npm run e2e:down

bash e2e/stack.sh config | status | logs | wait
npx vitest run test/browser-e2e-overlay.test.ts --root apps/api
```

## 14. Results on the rebased tree (`0f33b1f` + this branch)

Environment: macOS, Docker Desktop 28.4.0, 10 CPUs.

**The machine was heavily loaded by other worktrees' stacks:** five kind
control planes at 30–58 % CPU each, and a load average of 18–24.

| Run | Result |
|---|---|
| Clean cycle `npm run test:e2e`, first after rebase (7 tests; images rebuilt with main's terminal and verifier code) | **5 passed, 2 failed** (7.7 min); teardown removed everything, 0 leaked |
| Targeted rerun of the 2 failures on a kept stack | **2 passed** |
| `--repeat-each=3` of the same 2 tests, logs captured | **5 passed, 1 failed** (isolation, terminal "Connection to the terminal was lost") |
| Full suite on the kept stack | **7 passed** (2.5 min), 0 leaked |
| Final clean cycle `npm run test:e2e` on the committed tree (`2d8dd1f`), load average 23–27 | **7 passed** (3.7 min of tests, 8 min 1 s total incl. image rebuild); teardown: 0 containers, 0 networks left |
| `npm run typecheck` | pass |
| `npm test` | pass: api 588, web 195, terminal 152 (includes PR #34 suites), all workspaces 0 failed |
| `npm run build` | pass |
| `node scripts/check-secret-distribution.mjs` | pass |
| `git diff --check` | clean |

**Diagnosis of the intermittent failures.** This comes from the logs of the
failing repeat, not assumed:

- API request latency under this load reached 10–17 s. Examples:
  `GET /api/sessions/:id` 13.5 s, `POST /api/labs/:id/start` 10.1 s.
- The terminal service's internal credential fetch has a **10 s** budget.
  The API answered `/internal/sessions/:id/credentials` in 10.5 s, and the
  terminal logged `CREDENTIALS_UNAVAILABLE: … This operation was aborted`.
- The browser showed "Connection to the terminal was lost."
- The earlier failure where Verify stayed at "Checking your environment…" for
  60 s is consistent with the same starvation. It was not captured with logs.
- Main's PR #34 did not change the attach or credentials path.
- On the pre-rebase tree at lower load, the suite (then 6 tests) passed 3 of 3 full runs once its own assertions were corrected.

**Classification:** machine/resource contention, plus a real resilience
characteristic: a 10 s credential budget with no automatic retry turns a
slow API into a lost terminal. The student can press Reconnect. The tests were
not loosened and no retry was added to hide it.

### 14.1 How to read these numbers (on `0f33b1f`)

Two clean-cycle runs on the rebased tree have been recorded: one failed 2 of 7
under load, and the final one passed 7 of 7. That is evidence the suite
**works**, and that it is **sensitive to host CPU starvation**. It is not
evidence of stability on a quiet machine or a CI runner, which has not been
measured on this tree. Across every run, failures included, no sandbox
container or network was left behind.

### 14.2 Results after rebasing onto `9a0e22e` (PR #35)

Same machine. Other worktrees' kind clusters and stacks were still running.

| Run | Tree | Load average | Result |
|---|---|---|---|
| Clean cycle `npm run test:e2e` (images rebuilt) | rebased branch, before the terminal fix | 7 → 24 | **6 passed, 1 failed** (isolation, "Connection to the terminal was lost."); teardown 0 containers, 0 networks left |
| Clean cycle | `0553cf1` (with the fix) | 9–17 | **7 passed** (1.2 min of tests) |
| Clean cycle | `0553cf1` | 16–17 | **7 passed** (1.1 min of tests, 2 min 15 s total); 0 containers, 0 networks left |
| `npm run validate:labs` | rebased | — | 117 labs, 0 errors, 0 warnings |
| `npm run typecheck`, `npm run build` | rebased and `0553cf1` | — | pass |
| `apps/api` `browser-e2e-overlay` + `learning-paths-api` | rebased | — | 24 passed |
| orchestrator `catalog-validation`, `learning-paths`, `learning-progress` | rebased | — | 73 passed |
| verifier `catalog-starter-state` | rebased | — | 2 passed |
| terminal workspace (`npm test`) | `0553cf1` | — | 154 passed, 20 skipped (integration, env-gated) |
| `git diff --check` | — | — | clean |

**Root cause of the isolation failure.** It was diagnosed from the failed
run's trace, not assumed:

- The failing step was student A reopening the workspace
  (`student-isolation.spec.ts:105`). The API was answering in 7–17 s
  (`GET /api/sessions/:id` 16.8 s, `POST …/check` 13.3 s).
- A's new WebSocket closed after 10.46 s. The terminal output in A's page
  snapshot read **"No session token received."** That is the terminal
  service's `AUTH_TIMEOUT` frame (close 4401).
- A had sent its token on open. The service's 10 s grace timer started when
  the socket opened and was cleared only after the shell attached. So an
  attach that took more than 10 s (credentials fetch plus broker attach, each
  within its own budget) closed a correctly authenticated socket.
- The web app has no text for `AUTH_TIMEOUT` and does not retry it. It showed
  "Connection to the terminal was lost." and stayed there.

This corrects §14's explanation. The credentials fetch's own 10 s abort
(`CREDENTIALS_UNAVAILABLE`, close 4403) would show "The terminal could not
attach to your environment." The message students actually saw belongs to
the grace timer, which fires first because it starts earlier. That is
consistent with the `CREDENTIALS_UNAVAILABLE … aborted` line §14 found in
the terminal log for the same failure.

**Classification:** a deterministic product defect whose trigger is latency.
It reproduces whenever socket-open-to-attach exceeds 10 s. Host load only
determines whether a run gets there.

**Fix (`0553cf1`):** the grace timer is cleared once a signed token is
accepted, so it bounds the wait for a token and nothing else. The attach
stays bounded by its own budgets: credentials 10 s, broker connect 15 s.
Regression test in `broker-attach.test.ts`:

- a stub API (6 s) and broker inspect (6 s) give a ready shell after more
  than 10 s; this **fails without the fix** with the `AUTH_TIMEOUT` error;
- a socket that never sends a token is still dropped with `AUTH_TIMEOUT`/4401.

No assertion, timeout, retry or sleep in the browser suite was changed.

**What this does not settle:**

- The two passing cycles after the fix ran at lower load than the failing
  one. They are not by themselves proof that the suite is stable under load.
  The unit regression test is the evidence for the fix.
- An API slower than 10 s on the credentials fetch still fails the attach
  (`CREDENTIALS_UNAVAILABLE`, "could not attach"). The browser does not
  auto-retry that code; the student presses Try again or Reconnect. See §15.
- CI has still never run the suite.

### 14.3 Results after rebasing onto `fa6f109` (PR #36), with the handshake race fixed

**The CI failure.** PR #37's first CI run (`35161066075`, `9c86bb0`) failed
`student-isolation.spec.ts:105`: student A re-opened the workspace of a lab
that was still running, and the terminal stayed "Connection to the terminal
was lost." for the full 120 s. Student B's terminal attached and worked;
every B-to-A request in the same run was refused as intended.

**Root cause, from the trace's WebSocket frames** (`trace.zip`, frames of the
failing socket, in order):

```
send     {"type":"resize","cols":102,"rows":23}
send     {"type":"auth","token":"…","cols":102,"rows":23}      +0.46 ms
receive  {"type":"error","code":"UNAUTHENTICATED","message":"First message must be an auth frame."}
```

- `LabTerminal`'s `onopen` called `fit()` before sending `auth`. When the
  layout had not settled (a re-open with a cached grant opens the socket
  quickly), `fit()` changed the size and xterm fired `onResize`
  synchronously. The resize handler wrote to `socketRef`, which already held
  the open socket, so `resize` went out first.
- The terminal service correctly refuses any first frame that is not `auth`
  and closed 4401. It then verified the `auth` that followed, logged
  "attaching", found the socket closed and returned without a log line.
- The web app has no text or retry for `UNAUTHENTICATED`, so the state was
  permanent.

**Classification:** product bug — a client-side ordering race in the web
terminal handshake. Not a test bug and not the CI environment: the runner
only made the timing likely. On this laptop the unfixed isolation spec passed
3/3 (the timing did not occur), so the deterministic reproductions are the
CI frames, a component test, and a raw-socket probe against the real stack.

**Fix (two commits):**

| Commit | Change | Fails without it |
|---|---|---|
| `0689589` fix(web) | `socketRef` is set only on `ready`, so `auth` is always the first frame; a re-fit held back meanwhile is sent as one `resize` after `ready` | `apps/web/test/LabTerminal.test.tsx`: frames `[resize, auth]` instead of `[auth]` |
| `415b547` fix(terminal) | After a token is **verified** and while its attach is in flight, a `resize` is kept (applied when the shell opens) and anything else is dropped instead of closing the socket; a socket that closed during the broker attach no longer leaves a shell and a capacity slot behind | 4 of 5 new `broker-attach.test.ts` cases |

The server change is defence in depth for frames after a verified token. It
does not accept any frame before one: "still refuses a socket whose first
frame is not auth" passes with and without the change, and a resize after a
token the API rejects is still refused. Resize sizes are clamped by the
protocol parser before they are kept. Input sent before the shell exists is
never delivered.

Raw-socket probe on the real stack (3 sockets each; run by the session that
investigated the failure, load 16–31):

| Frames | Before (`e176273`) | After (`415b547`) |
|---|---|---|
| `resize` → `auth` | 4401 `UNAUTHENTICATED` | 4401 `UNAUTHENTICATED` (unchanged, by design) |
| `auth` → `resize` at once | 4401 `UNAUTHENTICATED` | `ready`, shell sized 132×40 |

**Runs on `415b547`** (`fa6f109` + this branch), same laptop, other worktrees'
clusters still running:

| Run | Load average | Result |
|---|---|---|
| Fresh stack, `student-isolation.spec.ts --repeat-each=5` | 21–25 | **5 passed, 0 failed** (8.5 min) |
| Full suite, same stack | 19–22 | **7 passed** (3.2 min) |
| Full suite, same stack | 18–21 | **7 passed** (3.0 min) |
| Teardown | — | 0 `jtt-e2e` containers, 0 networks |
| `npm test` | 10–29 | all workspaces pass, 0 failed (api 601, web 198, terminal 163, orchestrator 1331, observability 1569, others) |
| `npm run test:security` | 29 | pass, 0 failed |
| `npm run validate:labs` | — | 117 labs, 0 errors, 0 warnings |
| `npm run typecheck`, `npm run build`, `git diff --check` | — | pass / pass / clean |

Isolation assertions are unchanged by the fix: no assertion, timeout, retry
or sleep in `e2e/` was modified. Every run proved again that B gets 404
`SESSION_NOT_FOUND` on all six of A's session routes, B's own-token probe
attaches while B's token re-pointed at A's session closes 4401 `UNAUTHORIZED`,
B's sandbox has none of A's files, B's Verify reports 1 of 5 while A passed,
B's progress is 0, and B's own terminal and sandbox work.

**What this does not settle:**

- The suite has not yet passed in CI; the next PR #37 run is the evidence.
- The other session's gate run on the same commit once saw an api
  `process-environ-api` "socket hang up" under file-parallel load; it passed
  alone and did not recur in the run above. Recorded, not fixed.

### 14.4 CI, and a real api outage (2026-09-17, `feat/private-beta-readiness`)

- **CI:** `browser-e2e` passed on PR #37 (run `35182078014`, head `591fc9e`)
  before it merged. §14.3's "has not yet passed in CI" is superseded.
- **New test** `failure-paths.spec.ts` "api stopped and re-created mid-lab":
  the real api container is stopped while a student works, the tab becomes
  visible again, the workspace and terminal stay (banner "Cannot reach the
  labs API right now"), the api is re-created with `--force-recreate` through
  `e2e/stack.sh service recreate api`, Try again clears the banner, and Verify
  grades the same sandbox through nginx.
- Full suite on the branch, isolated project `jtt-e2e-bro`: **8 passed**
  (1.6 min), 0 containers left. The new test **fails** against the previous
  auth gate. Docker gave the re-created api its previous addresses in that
  run, so the address change is proven by the real-image edge test instead.
- `five-students.spec.ts`: five browser contexts launch LINUX-001 together,
  work in five terminals, verify together (three pass, two see 1 of 5), a
  sixth is refused with `LAB_CAPACITY_REACHED`, and after the five end the
  sixth's Try again gets a Ready lab. `e2e/stack.sh` now writes
  `MAX_ACTIVE_SESSIONS=5` and `MAX_ACTIVE_SESSIONS_PER_STUDENT=1`.
- "terminal service re-created mid-lab" (it also passes on the previous
  reconnect code, so it is a guard, not a regression test) and "database
  restarted mid-lab" (the api's pool recovers; a passing Verify is saved).
- "Reset gives a student a fresh environment…": same session, files gone,
  terminal usable, Completed kept. The first line typed after Reset is often
  lost (reattach plus reconnect; open, see the readiness report §4), so the
  test presses Ctrl-C and retypes.
- "reloading while the lab is still being created…": found a defect (the
  workspace said "not running" while the lab was being built), fixed in
  `681891d`.
- "opening the lab in a second tab…": the documented one-terminal-per-session
  takeover, and Reconnect taking it back.
- Not yet run in CI (no pull request for the branch). On a 2-core runner six
  Linux sandboxes at once are unmeasured.

## 15. Findings

- **Fixed (2026-09-17): a real API outage showed "Checking your session…"
  for ~39 s.** nginx now resolves the api per request with a 5 s connect
  timeout, so a stopped api is an immediate error, and the session query has
  a 15 s bound ([readiness pass](private-beta-readiness-2026-09-17.md)).
- **Fixed: a slow attach closed an authenticated terminal socket** with a
  false "No session token received" (§14.2, `0553cf1`, now `041f415`).
- **Fixed: the web terminal could send `resize` before `auth`**, and the
  service closed the socket 4401 for good (§14.3, `0689589`). The CI failure
  on PR #37.
- **Fixed: a browser leaving during the broker attach left an orphan shell**
  holding a sandbox PTY and a capacity slot (§14.3, `415b547`).
- **Open, outside this branch: `sandboxd.Dockerfile` is not hermetic.** It
  copies `services/observability` with whatever `node_modules` the host has
  and runs `npm ci` only for sandboxd, so a checkout without a root `npm ci`
  builds an image that fails with `ERR_MODULE_NOT_FOUND` (`prom-client`).
  CI runs `npm ci` first, so the job is not affected.
- **Minor: the web app has no text for `UNAUTHENTICATED`** either; after the
  fix the web app no longer triggers it.
- **Partly addressed (2026-09-17): the credentials fetch has a fixed 10 s
  budget.** The browser now retries `CREDENTIALS_UNAVAILABLE` (and the other
  restart-time codes) automatically for about a minute before offering
  Reconnect. The 10 s budget itself is unchanged.
- **Minor: the web app has no text for `AUTH_TIMEOUT`** and shows the generic
  "Connection to the terminal was lost." After the fix, only a client that
  never sends a token reaches it, and the web app always sends one.
- **Fixed (2026-09-17): nginx static upstream resolution.** A re-created api
  container at a new address was 502 until web restarted; reproduced, and
  fixed with per-request resolution.

## 16. Tier status

| Tier | Definition | Status | Evidence |
|---|---|---|---|
| **A** | real browser + web + API + deterministic dependencies (PostgreSQL, test IdP) | **PROVEN** (locally) | sign-in, cookie properties, dashboard, learning path, catalog, progress page, sign-out revocation, forged cookie, UI failure handling |
| **B** | real browser + actual sandbox/runtime | **PARTIALLY PROVEN** | Linux provider only: launch, real WebSocket terminal, real verifier, End lab, container removal, two-student isolation incl. WebSocket refusal. Heavy host load exposed a terminal defect, now fixed (§14.2); stability under that load after the fix is not yet measured. Kubernetes, Docker-daemon, Terraform, Ansible, CI/CD: not exercised |
| **C** | production-host smoke | **NOT PROVEN** | nothing ran on a host, domain, TLS edge, production overlay or real IdP. Local Docker Compose is not Tier C |

**CI:** passed on PR #37 (run `35182078014`) after the §14.3 fix. §14.4's new api-outage test has not run in CI yet.

## 17. Remaining gaps and next steps

| Gap | Status |
|---|---|
| Kubernetes real-runtime browser E2E | **OPEN** |
| Terraform browser E2E | **OPEN** |
| Reset flow | **Covered locally** (§14.4, Linux) |
| Second-tab terminal takeover | **Covered locally** (§14.4) |
| Reload during session startup (CREATING) | **Covered locally** (§14.4); found and fixed a defect |
| Production overlay | **OPEN** |
| Real external OIDC/IdP | **OPEN** |
| Production TLS / public host | **OPEN** |
| Browser E2E passing in CI | **DONE** on PR #37 (run `35182078014`) |
| Real (non-injected) API/terminal/database outage tests | **Covered locally** (§14.4) |
| More than two concurrent browser students | **Five: covered locally** (§14.4) |
| Progress across API/DB restart | **Covered locally** (§14.4: api re-create, database restart) |

Recommended next steps:

1. Run §14.4's api-outage test in CI (it needs a pull request).
2. Separate retryable from permanent `CREDENTIALS_UNAVAILABLE` on the server,
   so the browser's bounded retry (§15) never retries a permanent refusal.
3. Remove the double terminal attach after Reset (readiness report §4), then drop the E2E retype loop.
4. Extend Tier B with a Kubernetes lab (kind in the job) and a Terraform lab.
5. Point the suite at a staging host with the production overlay and a real IdP
   test tenant as the first Tier C evidence.

## 18. Launch-readiness pass — 2026-09-17

On `feat/private-beta-launch-readiness`
([report](private-beta-launch-readiness-2026-09-17.md)). §1–§17 are left as
recorded.

| Change | Why |
|---|---|
| **Reset test types once, with no retry**, as soon as the confirm dialog closes | §17 step 3. The first line after Reset was lost because the browser dropped keys typed before the new socket's `ready`, not because of a double attach. Against the previous bundle 0/3 (a truncated command, then nothing); with the fix 5/5 |
| **New: PostgreSQL stopped under a signed-in student** (`failure-paths.spec.ts`) | With the database down, `/auth/session` and `/api` answer 503 `AUTH_UNAVAILABLE`, the cookie is not cleared, a tab re-check keeps the app signed in, and the same cookie works when PostgreSQL returns. Fails on the previous api (signed out) |
| `stack.sh service stop|start postgres` | for the test above; the volume is kept |

**Found by the suite:** the five-student test failed once on a loaded machine
with `SESSION_PROVISION_FAILED` — a sandbox's first `docker exec` hit a 15 s
limit after a 38 s container create, reported as a broken image. Fixed in the
runtime (report §1 #10). The start response was read from the Playwright trace
(`resources/*.json`), since `stack.sh run` discards service logs at teardown.

§17 updated: "Remove the double terminal attach after Reset, then drop the E2E
retype loop" — **done** (there was no double attach; the loop is gone).

Results on this branch (isolated project `jtt-e2e-launch`, development machine, load 14–16):
first full run 14/15 (the five-student failure above); after the fix, **15/15**
in 6.4 min on a clean stack, 0 containers left. After later web-only commits,
13/15 and then 0/2 (five-students, isolation) at load 18–20, with the kept
stack's logs showing PostgreSQL connection timeouts (`db.down`) caused by the
shared Docker VM, not the change (report §3). Not yet in CI.
