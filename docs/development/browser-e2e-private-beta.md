# Browser E2E for the private beta

**Branch** `feat/browser-e2e-beta`, rebased onto `origin/main` at `0f33b1f`
(PR #34, the overnight hardening pass). **Date** 2026-09-16.

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
| Terminal | `POST /api/sessions/:id/terminal` issues an HMAC token (`sid`, `uid`, …). The browser opens `/terminal` and sends `{type:'auth', token}`. The terminal verifies the HMAC, fetches credentials from the API (which re-checks the owner, 10 s budget), and attaches through `sandboxd`. |
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
- **What it does NOT prove:** real terminal-service outages, or credential
  fetch timeouts (see §14, where one occurred under load and produced a
  different message).

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

**Not observed on a runner yet.** The workflow triggers on `pull_request` and
on `push` to `main`, and no PR exists. Linux-runner-specific risks remain
unproven:

- the Docker socket GID (taken from `stat` on the socket);
- registry pulls of `node:22-bookworm-slim` and `postgres:16-alpine`;
- build time within 45 minutes.

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

### 14.1 How to read these numbers

Two clean-cycle runs on the rebased tree have been recorded: one failed 2 of 7
under load, and the final one passed 7 of 7. That is evidence the suite
**works**, and that it is **sensitive to host CPU starvation**. It is not
evidence of stability on a quiet machine or a CI runner, which has not been
measured on this tree. Across every run, failures included, no sandbox
container or network was left behind.

## 15. Findings

- **A real API outage shows "Checking your session…" for ~39 s** before
  "Cannot reach the labs API."
  - nginx resolved `api` at start. The first proxied request to a stopped
    container waited 38.9 s; later ones ~3 s.
  - The session fetch has no client timeout.
  - Not fixed here.
- **Terminal attach is fragile under API latency.** The 10 s credentials
  budget is exceeded when the API is CPU-starved, and the UI then shows
  "Connection to the terminal was lost." (§14). Recovery is manual (Reconnect).
- **nginx static upstream resolution** also means a *recreated* API container
  with a new IP would stay 502 until web restarts (not measured; follows from
  the same resolution behaviour). Relevant to main's `restart: unless-stopped`:
  a *restart* keeps the container and normally its IP; a *re-create* does not.

## 16. Tier status

| Tier | Definition | Status | Evidence |
|---|---|---|---|
| **A** | real browser + web + API + deterministic dependencies (PostgreSQL, test IdP) | **PROVEN** (locally) | sign-in, cookie properties, dashboard, learning path, catalog, progress page, sign-out revocation, forged cookie, UI failure handling |
| **B** | real browser + actual sandbox/runtime | **PARTIALLY PROVEN** | Linux provider only: launch, real WebSocket terminal, real verifier, End lab, container removal, two-student isolation incl. WebSocket refusal. Intermittent under heavy host load (§14). Kubernetes, Docker-daemon, Terraform, Ansible, CI/CD: not exercised |
| **C** | production-host smoke | **NOT PROVEN** | nothing ran on a host, domain, TLS edge, production overlay or real IdP. Local Docker Compose is not Tier C |

**CI:** not proven (never executed).

## 17. Remaining gaps and next steps

| Gap | Status |
|---|---|
| Kubernetes real-runtime browser E2E | **OPEN** |
| Terraform browser E2E | **OPEN** |
| Reset flow | **OPEN** |
| Second-tab terminal takeover | **OPEN** |
| Reload during session startup (CREATING) | **OPEN** |
| Production overlay | **OPEN** |
| Real external OIDC/IdP | **OPEN** |
| Production TLS / public host | **OPEN** |
| Browser E2E observed in CI | **OPEN** |
| Real (non-injected) API/terminal outage tests | **OPEN** |
| More than two concurrent browser students | **OPEN** (API-level five-student gate exists) |
| Progress across API/DB restart | **OPEN** |

Recommended next steps:

1. Open the PR to get the first `browser-e2e` CI run on a clean runner (lower
   contention than this laptop), and fix what it reveals.
2. Decide on terminal attach resilience under API latency: retry the
   credentials fetch, or a larger budget with a bound.
3. Bound the web app's session query and nginx `proxy_connect_timeout`, then
   add a real api-stop browser test.
4. Browser coverage for reset, second-tab takeover and reload during CREATING.
5. Extend Tier B with a Kubernetes lab (kind in the job) and a Terraform lab.
6. Point the suite at a staging host with the production overlay and a real IdP
   test tenant as the first Tier C evidence.
