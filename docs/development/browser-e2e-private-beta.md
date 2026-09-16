# Browser E2E for the private beta

**Branch** `feat/browser-e2e-beta`, based on `main` at `cb7804a`. **Date** 2026-09-16.

## 1. Executive summary

A real Chromium browser now drives JumpToTech Labs through the student critical
path, against the real composed stack, and the run is reproducible with one
command:

```bash
npm run test:e2e
```

That command builds and starts the stack, waits for a readiness gate, runs six
Playwright tests, and always tears the stack down. On this branch it passed on
a clean cycle (images rebuilt, 6/6, 0 leaked sandboxes, 2 min 15 s) and on two
more back-to-back runs against one stack.

The browser exercises: OIDC sign-in through an identity provider's login page,
the HttpOnly session cookie, the dashboard, the learning path, the catalog,
launching LINUX-001 into a real sandbox container, the xterm terminal over the
nginx-proxied WebSocket, Verify against the real verifier (fail, then pass),
progress persisting across a full reload, End lab removing the container, and a
second student who cannot reach the first student's session.

The run has limits:

- **Tier B for one track only.** The sandbox is a real container, but only for
  the Linux provider.
- **Not proven:** Kubernetes, Docker, Terraform, Ansible and CI/CD labs; the
  production overlay; TLS; a real identity provider; any production host.

A negative control confirmed the suite is not vacuous: typing `cp` instead of
`mv` made the real verifier report "app.log was moved, not copied", and the test
failed at Verify.

## 2. Previous state

- There was **no browser automation** in the repository: no Playwright,
  Cypress, Puppeteer, WebDriver or Selenium dependency, config or test (searched
  at `cb7804a`). The only mention was prose in `docs/student-experience.md`.
- `apps/web/test/**` holds 19 Vitest files and 195 tests, all jsdom
  component and route tests with the API mocked (`api-mock.ts`). They
  are valuable, but they are not browser E2E.
- `make beta-validate` (BETA-P0-019) drives five synthetic students through
  the HTTP API and the terminal WebSocket protocol, using `AUTH_MODE=development`
  and the `Authorization: Developer` header. It never renders the React
  UI and never uses browser sign-in.
- The release gate (`docs/releases/private-beta-release-gate.md` §2) states
  **"No browser end-to-end."**
- Earlier real-Chrome smoke checks during the student-experience work were
  scratchpad scripts. They answered `/auth/session` in the test browser rather
  than signing in, and were not committed.
- `AUTH_MODE=development` **has no browser sign-in** (`/auth/session` reports
  signed-out). A browser test therefore cannot authenticate against the default
  development stack without either a real OIDC provider or a bypass.

## 3. Architecture discovered

| Concern | What the code does |
|---|---|
| Web | React 18 + Vite bundle, hash router (`apps/web/src/lib/router.ts`). In compose, nginx (`infrastructure/docker/nginx`) serves the build and proxies `/api/`, `/auth/` and `/terminal` on one origin. |
| Auth | The API is a confidential OIDC client (backend-for-frontend). `/auth/login` → provider → `/auth/callback` → opaque `jtt_session` HttpOnly cookie. The page never holds a token. Cookie first, then `Authorization` header (`apps/api/src/auth/middleware.ts`). Unsafe methods pass an Origin guard. |
| Session creation | `POST /api/labs/:id/start` → `SessionManager` → provider. The Linux provider asks `sandboxd` to create a labelled container. Global and per-student limits are enforced in PostgreSQL. |
| Terminal | `POST /api/sessions/:id/terminal` issues an HMAC token bound to the owner. The browser opens `ws(s)://<origin>/terminal` and sends it as the first frame. The terminal service re-proves ownership with the API, then attaches through `sandboxd`. |
| Verify | `POST /api/sessions/:id/check` → verifier reads the live sandbox (state-based, not command history) → attempt recorded. |
| Progress | PostgreSQL attempts/progress; `GET /api/me/progress`, `GET /api/me/learning-paths/:id`. |
| Cleanup | `DELETE /api/sessions/:id`; the reaper for expiry, idle and orphans; `scripts/sandbox-clean.sh` by runtime owner. |
| Hard external dependencies | Docker (sandboxd socket), a kind cluster for Kubernetes labs, a per-session Docker daemon for Docker labs, sandbox images, an OIDC provider for browser sign-in, and TLS/DNS for production. |

## 4. Browser framework decision

**Playwright (`@playwright/test` 1.63.0, pinned), Chromium only.**

- No existing browser framework existed to reuse.
- Earlier ad-hoc smoke work on this project already used Playwright.
- It has first-class network and **WebSocket routing** (`page.routeWebSocket`),
  which the terminal failure-path test needs.
- It handles multiple isolated browser contexts in one test, which the
  isolation test needs.
- It captures traces, screenshots and videos on failure, and installs browsers
  on GitHub runners with `--with-deps`.

It lives in a new `e2e` npm workspace, so it never enters `npm test` or any
image. There is no `test` script there, and no Dockerfile copies `e2e/`.

## 5. Test topology

```text
 Chromium (Playwright, host)
   │  http://127.0.0.1:33700  (one origin)
   ▼
 web  nginx + production Vite bundle ──/api,/auth──► api (AUTH_MODE=oidc, NODE_ENV=development)
   │                                  └─/terminal──► terminal ──► sandboxd ──► docker.sock
   │                                                                   └─► LINUX-001 container (jumptotech/lab-linux:e2e)
   │                                    api ──► postgres (durable sessions, users, progress)
   │                                    api ──server-side──► oidc:9500  (discovery, token, JWKS)
   └─ browser redirect ──► 127.0.0.1:39700  oidc login page (authorization + end-session endpoints)
```

- Files: `docker-compose.yml` + `docker-compose.runtime.yml` (unchanged) +
  `e2e/docker-compose.e2e.yml` (test-only overlay).
- Orchestration: `e2e/stack.sh` (`up`, `wait`, `status`, `logs`, `config`,
  `down`, `run`).
- Compose project and runtime owner `jtt-e2e` (CI: `jtt-e2e-<run id>`), with its
  own sandbox network and ports 33700/34700/34701/55700/39700. All are
  overridable, and every port is checked free before start.
- The api and terminal are kept **off the shared external `kind` network**, so
  service-name DNS cannot resolve into another stack on the same machine.
- The Kubernetes kubeconfig is replaced by one that points nowhere, so that
  provider reports itself unavailable. Terraform, Ansible, CI/CD and the Docker
  track are switched off.
- The sandbox image is tagged `jumptotech/lab-linux:e2e`, so the shared `:latest`
  other worktrees use is never overwritten.

**Readiness gate** (`stack.sh wait` and `e2e/global-setup.ts`, bounded, fail
closed). All of these must hold before any test runs:

- `/` answers 200;
- the provider's discovery issuer is `http://oidc:9500`;
- `/auth/config` says `mode=oidc` and `signInAvailable=true`;
- `/health` reports labs loaded and the `linux` provider available.

On its first run it did fail closed: a wrong field name made it report the
provider unavailable, and no test ran.

## 6. Tests implemented

| ID | Spec | Test |
|---|---|---|
| E2E-001…009 | `student-critical-path.spec.ts` | one test, one `test.step` per ID |
| E2E-010 | `student-isolation.spec.ts` | two browser contexts, two students |
| F-1 | `failure-paths.spec.ts` | **[injected]** API unreachable → message → Try again recovers |
| F-2 | `failure-paths.spec.ts` | anonymous 401s and sign-in gate; forged cookie is anonymous; sign-out revokes the cookie server-side |
| F-3 | `failure-paths.spec.ts` | second lab while one runs: UI explains the limit; server returns 429 `STUDENT_SESSION_LIMIT_REACHED` |
| F-4 | `failure-paths.spec.ts` | **[injected]** terminal WebSocket closed → "The terminal could not connect" → Try again connects for real |
| guard | `apps/api/test/browser-e2e-overlay.test.ts` (hermetic, in `npm test`) | the overlay's auth settings are refused under `NODE_ENV=production`; no shipped compose file, Dockerfile or the Makefile references `e2e/` |

The verifier-failure path is covered inside the critical path (E2E-007a).
Cross-student unauthorized access is covered by E2E-010.

## 7. What each test actually proves

- **E2E-001:** the nginx-served production bundle loads in Chromium, and an
  anonymous visitor gets the sign-in gate and nothing behind it.
- **E2E-002:** a browser completes the real authorization-code flow.
  - Sign-in goes app → `/auth/login` → the provider's own origin → form POST →
    `/auth/callback`.
  - The API runs its production verification path unmodified: discovery, PKCE
    S256, state, nonce, client secret, and RS256 over JWKS.
  - The result is a `jtt_session` cookie that is `HttpOnly` and `SameSite=Lax`,
    invisible to `document.cookie`, with nothing token-like in Web Storage.
  - The UI shows the provider's name claim.
- **E2E-003:** the dashboard greets the signed-in identity. The learning path
  renders its stages and a zero progress bar from live API data.
- **E2E-004:** catalog search filters to LINUX-001 (`Showing 1 of N`), and the
  lab page offers Launch.
- **E2E-005:** Launch creates a real session.
  - The UI reaches `Ready`.
  - `GET /api/sessions` with this browser's cookie lists exactly that one
    ACTIVE session.
  - Docker shows a container carrying this stack's runtime-owner label.
- **E2E-006:** the xterm terminal connects through nginx → terminal → sandboxd
  and executes commands in the sandbox (`whoami` = `student`,
  `pwd` = `/home/student`).
  - Output is matched with a shell-computed marker, so the echoed command line
    cannot satisfy the assertion.
- **E2E-007:** Verify grades the live sandbox, before and after the work.
  - Before any work: `1 of 5` passing, 4 failing, with the verifier's own
    detail text. `path_absent` is already true on an empty home.
  - After the student types the solution into the terminal: `Lab passed`,
    5 passing, "Saved to your progress", and a `Completed` badge.
- **E2E-008:** a full page reload keeps the running session, a fresh terminal
  grant reconnects to the **same** sandbox (the student's files are still
  there), `Completed` persists, and the Progress page shows `Overall: 1 of N`.
- **E2E-009:** End lab (confirm dialog) shows "Lab ended" with the completion
  kept. The API lists no session, and the owner's container is gone from
  Docker within 90 s.
- **E2E-010:** Student B, in a separate context signed in as a different user,
  gets nothing of Student A's.
  - B sees no running lab, and `LINUX-001 is not running` at A's workspace URL.
    B's page never contains A's session id.
  - With B's cookie, every session route on A's real id answers
    `404 SESSION_NOT_FOUND`: GET, terminal grant, check, activity, reset and
    DELETE. A stays ACTIVE.
  - B's own sandbox lacks A's private file, and A's lacks B's.
- **F-2:** the cookie is the only credential, and signing out destroys it
  server-side, not just in the browser. Re-adding the pre-sign-out cookie gets
  401.
- **F-3:** the one-lab limit is explained in the UI with a link back to the
  running lab, and the server enforces it independently of the page.
- **Negative control (manual, not committed):** the critical path fails when
  the typed solution copies instead of moves.

## 8. What each test does NOT prove

- **Other tracks:** no Kubernetes (kind, NetworkPolicy, Pod Security), Docker
  (per-session daemon), Terraform, Ansible, CI/CD or AWS lab is launched in a
  browser.
- **Production overlay:** `docker-compose.production.yml`, `NODE_ENV=production`,
  the TLS edge, `wss://`, `Secure` cookies and the 443/80 exposure are not used.
- **Real identity provider:** the provider is a test double that accepts any
  well-formed username. Nothing here proves a real IdP's discovery, key
  rotation, MFA, admission policy or federated logout.
- **Hosts:** nothing ran on a production host, a real domain or the internet.
- **Scale:** at most two concurrent students. The five-student contract remains
  `make beta-validate`'s evidence (API/WebSocket level).
- **Injected failures:** F-1 and F-4 inject the failure in the browser. They
  prove the UI's handling of a refused request or socket, not the real outage.
  A real api stop behaves differently; see §15.
- **Other browsers and devices:** no Firefox, WebKit/Safari or mobile viewport;
  no accessibility audit.
- **Long-running behavior:** no idle timeout, expiry, reset, API restart,
  tab takeover or reconnect after a sandbox reset.
- The `api*` helpers call HTTP with the browser context's cookie jar. Those
  assertions prove server behavior for that cookie, not UI behavior.

## 9. Authentication strategy

A **real OIDC authorization-code flow against a test-only identity provider**
(`e2e/oidc-provider/server.mjs`). There is no API bypass, no injected cookie, no
test route and no auth mode change beyond configuration the API already
supports.

- **Zero dependencies.** It uses only `node:http` and `node:crypto`, and runs
  from a stock `node:22-bookworm-slim` image with the directory mounted
  read-only. The container is read-only, runs as `node`, drops all
  capabilities and sets `no-new-privileges`.
- **Split endpoints.** The issuer is `http://oidc:9500`, which the api reaches
  server-side. The browser-facing endpoints (authorization and end-session) are
  on `127.0.0.1:39700`. Discovery endpoints need not share the issuer's host.
- **What it enforces:**
  - exact client id and redirect URI;
  - `response_type=code`, the `openid` scope, PKCE S256, state and nonce;
  - single-use 5-minute requests and single-use 60-second codes (burned before
    any other check);
  - a constant-time client-secret compare;
  - the PKCE verifier;
  - RS256 ID tokens with `iss`, `aud`, `iat`, `exp` and `nonce`;
  - end-session redirects only to the app origin.
- **Probed on this branch (hermetically):**
  - foreign `redirect_uri` → 400, no redirect;
  - `plain` PKCE → 400;
  - bad username → 400;
  - request replay → 400;
  - wrong secret → 401;
  - wrong verifier → 400, and the code is burned;
  - code replay → 400;
  - JWKS verification of a good token succeeds;
  - foreign post-logout URI → no redirect;
  - `NODE_ENV=production` → refuses to start (exit 2).
- **Per-run secrets.** `e2e/stack.sh` writes `e2e/.stack/stack.env` (mode
  600, git-ignored, deleted by `down`). It generates the client secret and every
  platform secret with `openssl rand -hex 32` and never prints a value. After a
  full suite, none of the generated values appeared in any service log.
- **Why this cannot reach production:**
  1. Under `NODE_ENV=production` the api refuses the overlay's loopback
     `PUBLIC_ORIGIN`. With an `https:` origin it still refuses the `http:`
     issuer. Both are pinned by `browser-e2e-overlay.test.ts`, which reads the
     values out of the overlay file.
  2. The provider refuses `NODE_ENV=production`.
  3. No shipped compose file, Dockerfile or the Makefile references `e2e/`
     (pinned by the same test).
  4. It publishes on loopback only.

## 10. Session/runtime strategy

- **Tier A** (real browser + web + API + PostgreSQL + auth) is fully covered.
- **Tier B** (real browser + real sandbox runtime) is covered for the **Linux
  provider** through sandboxd. The runtime path is real end to end: container
  creation, terminal attach and verifier reads. LINUX-001 was chosen because it
  is deterministic, needs no network, and starts in seconds.
- **Tier C** (production host) is **not executed**.
- **Students and limits.** Students are unique per test (`stu-<random>`), so a
  reused stack never carries progress between runs. The stack runs the beta
  contract: `MAX_ACTIVE_SESSIONS=5`, `MAX_ACTIVE_SESSIONS_PER_STUDENT=1`.
- **Cleanup at three levels:**
  1. every test ends its students' sessions in `finally`;
  2. E2E-009 asserts the container is gone;
  3. `stack.sh down` removes volumes, runs `scripts/sandbox-clean.sh` for the
     owner, and **fails** if any owner container survives.

## 11. CI strategy

A new `browser-e2e` job in `.github/workflows/quality-gates.yml` runs after
`gates`, on `ubuntu-latest` with a 45-minute timeout and a run-scoped
`E2E_PROJECT`. Its steps:

1. `npm ci`
2. `npx playwright install --with-deps chromium`
3. `bash e2e/stack.sh up` (build + readiness gate)
4. `npx playwright test --config e2e/playwright.config.ts` (`CI=true` →
   `forbidOnly`, no retries)
5. on failure: `stack.sh status`, `stack.sh logs`, and managed containers;
   upload the Playwright report and traces (7 days)
6. `if: always()` `stack.sh down`

It uses no repository or organisation secrets. Like every runtime job, sandboxd
holds the Docker socket exactly as the runtime overlay gives it; the workflow
header comment was updated to say so.

**Not yet observed on GitHub runners.** This branch was pushed without opening a
PR, and the workflow runs on `push` only for `main`. The job's first real
execution needs a PR or a push to `main`; until then, CI coverage is
*configured, not proven*.

## 12. Security considerations

- **No production auth weakened.** No API or web source file changed. The only
  platform-adjacent changes are root `package.json` and `package-lock.json`
  (the `e2e` workspace), plus one hermetic test. All four images were rebuilt
  from the new lockfile, and every `npm ci` layer re-executed successfully.
- **No universal backdoor.** The permissive part, "any username", exists only
  in the test provider, and §9 lists the four independent reasons it cannot
  reach production.
- **Cookies and tokens.** The suite asserts the session cookie is HttpOnly,
  SameSite=Lax and unreadable by script, and that no token-like key is in Web
  Storage. It also asserts a forged cookie is anonymous and a signed-out cookie
  is dead server-side.
- **Ownership.** Six cross-student session routes return 404 for a real id.
  A WebSocket with another student's token is not driven from the browser (B
  cannot obtain one); `terminal-ownership.test.ts` and `make beta-validate`
  cover that at protocol level.
- **CI.** No secrets are consumed. Diagnostics print compose logs, and a scan
  of those logs after a full suite found none of the run's generated secret
  values. Uploaded traces contain throwaway test users on a stack that is
  destroyed afterwards.
- **Debug and test routes.** None were added.
- **Pre-existing, unchanged, noted:** the dev overlay's `http:` cookie is
  non-`Secure` by design on loopback (`config.ts`), and production refuses it.

## 13. Test commands

```bash
npm ci
npx playwright install chromium          # once per machine

npm run test:e2e                         # up → tests → down (always)
E2E_KEEP_STACK=1 npm run test:e2e        # leave the stack running afterwards

npm run e2e:up                           # build + start + readiness
E2E_BASE_URL=http://127.0.0.1:33700 E2E_API_URL=http://127.0.0.1:34700 \
E2E_RUNTIME_OWNER_ID=jtt-e2e npm run test:e2e:running -- tests/student-isolation.spec.ts
npm run e2e:down

bash e2e/stack.sh config                 # resolve the merged compose model only
bash e2e/stack.sh logs                   # recent service logs
E2E_PROJECT=myrun E2E_WEB_PORT=33800 …   # a second, non-colliding stack
E2E_REBUILD_SANDBOX=1 npm run e2e:up     # rebuild jumptotech/lab-linux:e2e

npx vitest run test/browser-e2e-overlay.test.ts --root apps/api   # hermetic guard
```

## 14. Results (this branch, 2026-09-16, macOS, Docker Desktop 28.4.0, loaded laptop)

| Run | Result |
|---|---|
| Clean cycle `npm run test:e2e` (all 4 app images rebuilt from the new lockfile) | **6 passed**, 55 s of tests, 2 min 15 s total; teardown: 0 containers, 0 networks left |
| Same stack, back-to-back run 1 | **6 passed** (55.8 s), 0 leaked |
| Same stack, back-to-back run 2 (machine under load) | **6 passed** (2.3 min), 0 leaked |
| Negative control (`cp` instead of `mv`) | critical path **failed at E2E-007b** as intended ("4 of 5 … app.log was moved, not copied — Not passing yet"); 0 leaked |
| `run` with `up` failing (port in use) | exit 1, teardown ran |
| `npm run typecheck` (all workspaces incl. e2e) | pass |
| `npm test` (all workspaces) | pass: api 588 passed / 15 skipped (incl. 5 new), web 195 passed, others unchanged |
| `node scripts/check-secret-distribution.mjs` | pass |
| `git diff --check` | clean |

**Pre-existing failure, not caused by this branch:** in the baseline `npm test`
on unmodified `cb7804a`, `apps/api/test/operations-metrics.test.ts` "keeps the
last known expiry when the edge stops answering" failed once
(`asn1 encoding routines::illegal padding`, from test certificate generation).
It passed in the post-change full run, so it is an intermittent,
environment-dependent flake. No code was changed for it.

Failures found while building the suite were all wrong assumptions in the new
tests, not product defects:

- the ACTIVE label is "Ready";
- `path_absent` passes before any work;
- every Linux sandbox shares the hostname `jumptotech-lab`;
- the confirm dialog is an `alertdialog`.

## 15. Remaining blockers and findings

- **Finding: a real API outage shows "Checking your session…" for ~39 s**
  before "Cannot reach the labs API." (measured by stopping the E2E api
  container).
  - nginx resolved `api` at start, and the first proxied request to the stopped
    container waited 38.9 s for `Host is unreachable`. Later ones took ~3 s,
    then 502.
  - The session fetch in `apps/web/src/lib/auth.ts` has no client timeout.
  - Bounded, so not a hang, but a poor first impression during an incident.
  - Not fixed on this branch. Recommendation: an `AbortSignal.timeout` on the
    session query, and `proxy_connect_timeout` in `locations.conf`.
  - Related and not measured: nginx's static upstream resolution also means a
    *recreated* api container with a new IP stays 502 until web restarts.
- **CI job never executed** (see §11).
- **Tracks.** Kubernetes-track browser E2E needs kind in the job (the
  `kind-integration` job shows it is feasible, about 110 minutes).
- **Real identity provider.** Real-IdP sign-in needs a staging tenant and
  credentials (DECISION REQUIRED in `docs/authentication.md` §4.7).
- **Production overlay.** Browser E2E against it needs TLS certificates and a
  public origin.

## 16. Production-host validation still required

Not one item here is changed by this branch:

- `make beta-validate` on the chosen host;
- the production overlay with real TLS and DNS;
- a real OIDC provider (discovery, key rotation, logout, admission policy);
- a browser smoke on the real domain over `https`/`wss` with `Secure` cookies;
- a CNI with proven NetworkPolicy enforcement;
- off-host backup and restore;
- alert delivery to a human.

## 17. Recommended next steps

1. Open a PR from this branch to get the first real `browser-e2e` CI run, and
   fix whatever a clean Ubuntu runner reveals (socket GID, image pulls, timing).
2. Bound the session query in the web app and set nginx `proxy_connect_timeout`,
   then add a **real** (non-injected) api-down test that stops the api container
   and asserts the error appears within a few seconds.
3. Extend Tier B to one lab per provider that CI can host: a Kubernetes lab
   with kind, and a Terraform lab from the offline mirror.
4. Add browser coverage for reset, second-tab takeover and reload
   during `CREATING`, the student-visible lifecycle paths with past defects.
5. Run the same Playwright suite against a staging host with the production
   overlay and a real IdP test tenant (a `E2E_BASE_URL` pointed at it, with an
   IdP-specific sign-in helper), as the first Tier C evidence.
