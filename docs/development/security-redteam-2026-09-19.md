# Security red-team pass — 2026-09-19

**Branch** `feat/security-redteam-overnight`, worktree `~/jtt-security-redteam-overnight`
**Base** `origin/main` `001bcf1` (merged PR #40, beta operations)
**Audience** the operator deciding whether five trusted students may use the platform
**Scope** this repository and a local test environment only: no external system,
real identity provider, public address, cloud metadata endpoint or real student
data was touched. Synthetic identities, secrets and payloads throughout.

**Verdict.** No student can read, drive, reset, end, verify or attach to another
student's lab through the API, the terminal or the broker, and no authorization,
authentication or session-limit bypass was found. Seven defects were fixed, each
reproduced first and each with a regression test that fails against the previous
code (or a local probe where a unit test cannot reach the mechanism). Two of them
were cross-student **availability** gaps in the shared terminal service; one put
the api's service-to-service router behind a single secret on the public edge.
The architectural risks the release gate accepted for a trusted cohort — shared
shell uid 1001 and privileged Docker-in-Docker — are unchanged, still accepted
for five trusted students only, and still block any untrusted cohort.

This builds on [private-beta-security-audit.md](private-beta-security-audit.md)
(the threat model, trust boundaries and register there still hold; §31 of that
document points here) and does not repeat it.

## 1. Method

Read the code at each trust boundary; reproduce a suspected weakness with a
failing test or a local probe before changing anything; fix narrowly; prove the
regression test fails against the previous code (negative control) or that a
mutation of the control it protects fails it; re-run the surrounding suites.
Three read-only sub-reviews (web/nginx/XSS, operator tooling and log redaction,
verifier and Kubernetes) ran in parallel; every finding of theirs acted on here
was re-verified first.

Evidence levels as in the audit (§2): **TEST** (committed test, negative
control shown), **LOCAL** (probe on this machine — macOS, Docker Desktop, load
average 40–55 from parallel sessions), **CODE** (read and traced), **REQUIRES
PRODUCTION DEPLOYMENT / EXTERNAL CONFIGURATION**. Nothing here is proven in CI
yet: the branch has no PR.

## 2. Trust boundaries (what changed)

The map in the audit (§4–§6) is current. Two boundaries were weaker than it said:

| Boundary | Claimed | Found | Now |
|---|---|---|---|
| public edge ↔ api `/internal` | not reachable from the browser (off CORS, not under `/api`, secret) | reachable through nginx by a dot-segment path; secret the only barrier (SEC-RT-3) | refused at the edge and in the api |
| one student's terminal ↔ the shared terminal service | one shell per session; bounded reads | many shells per session by racing one token; unbounded/blocking workspace reads (SEC-RT-1, SEC-RT-2) | one attach in flight per session; bounded, regular-file reads |

## 3. Findings register

| ID | Title | Severity | Status | Evidence |
|---|---|---|---|---|
| SEC-RT-1 | Concurrent terminal attaches with one token each got a shell (K8s / Docker-daemon tracks): one student could fill the terminal's shared slots | MEDIUM | FIXED | TEST (2 of 3 fail before) |
| SEC-RT-2 | Terminal workspace read: whole-file read before the cap, FIFO blocked a worker for good | MEDIUM | FIXED | TEST (sparse 600 MiB) + LOCAL (FIFO, RSS) |
| SEC-RT-3 | api `/internal` router reachable from the internet via `/internal/../api/…` (nginx normalises, forwards raw) | LOW | FIXED | LOCAL (nginx:alpine + shipped `locations.conf`) + TEST (10 of 11 fail before) + contract |
| SEC-RT-4 | Provider/internal error text (daemon paths, API server URL, internal addresses) in student responses, `statusReason`, attempt history and terminal error frames | LOW | FIXED | TEST (api 3/3, terminal 2/3 fail before) |
| SEC-RT-5 | Log redactor missed lower-case auth schemes, `KEY=value` / JSON credential assignments, credential-named fields, and kept a fragment at the 8 KiB cut; bundle gate likewise | LOW | FIXED | TEST (12 fail before) |
| SEC-DEP-1 | `qs` advisories under express | LOW | FIXED (express 4.22.3 → qs 6.16.0) | `npm audit`, api suite |
| SEC-HDR-1 | No frame / sniffing / referrer / permissions headers | INFO | MITIGATED (headers added; full CSP is a follow-up) | LOCAL (nginx:1.27-alpine) + contract |
| SEC-RT-6 | Student Role may create `kubernetes.io/service-account-token` Secrets: a namespace credential that outlives the short TTL (dies with the namespace) | LOW | OPEN (Kubernetes owner) | CODE |
| SEC-RT-7 | `service_http`/`service_tcp` dial a Service whose Endpoints the student chooses; harmless while the api has no route to the service CIDR (none is configured in compose; reasoned from configuration, not measured), SSRF-shaped if it ever runs in-cluster. `docs/kubernetes-network-security.md` says no lab uses these checks; NET-024/025 do | LOW (conditional) | OPEN | CODE |
| SEC-RT-8 | No per-session budget on terminal attaches; each Kubernetes attach mints a TokenRequest (now at most one in flight per session) | LOW | OPEN | CODE |
| SEC-RT-9 | Verifier and setup call bare-name binaries (`head`, `stat`, `cat`, inner `docker`) inside containers where the student is root: a student can falsify only their own grading | LOW | OPEN (lab/verifier owner) | CODE |
| SEC-RT-10 | Diagnostics bundle: `/tmp/jtt-diagnostics` default when `HOME` is unset, archive written through a pre-planted symlink, non-log sections packaged unscanned when `tsx` is missing | LOW | OPEN (operator host only) | CODE |
| SEC-RT-11 | Logout does not revoke unexpired terminal tokens (≤ 1 h, still bound to the live session and its owner) or close open terminals | INFO | ACCEPTED | CODE |
| SEC-RT-12 | `protect-managed-resources` admission policy covers UPDATE/DELETE, not CREATE (a student can create objects labelled managed: self-DoS of their own reset only) | INFO | OPEN | CODE |
| SEC-RT-13 | Host files `webhook-url` and `scrape-token` are 0644 by design (container uids must read them) | INFO | ACCEPTED while the host has no untrusted accounts | CODE |
| SEC-RT-14 | Development-only: `web.conf` shows the nginx version; the terminal URL follows the client `Host` when `PUBLIC_ORIGIN` is unset (affects the requester only) | INFO | OPEN | CODE |

Totals for this pass: **CRITICAL 0 · HIGH 0 · MEDIUM 2 · LOW 9 · INFO 5** (SEC-DEP-1
and SEC-HDR-1 were already in the audit's register; their status changes here).

## 4. Fixed

### SEC-RT-1 — one token, many shells (MEDIUM)
- **Component** `services/terminal/src/server.ts`
- **Attack** Kubernetes- or Docker-track student opens N WebSockets and sends
  the same valid `auth` frame on each at once. `startSession` closed the
  session's registered shell *before* its awaited credential fetch, so all N
  found nothing to close and all N registered. The terminal spawns those shells
  itself (sandboxd deduplicates only container-track broker attaches), so the
  student held N shells and N of `TERMINAL_MAX_SESSIONS` (16); End Lab reached
  only the last.
- **Evidence** with 2 slots, a student racing 3 sockets left a second student
  `CAPACITY`; 4 racers → 4 live shells.
- **Fix** attaches for one session id run in turn (`attachInTurn`); each
  replaces the previous, the newest wins, a socket that left while waiting
  attaches nothing. Different sessions never wait on each other.
- **Test** `services/terminal/test/concurrent-attach.test.ts`.

### SEC-RT-2 — workspace reads (MEDIUM)
- **Component** `services/terminal/src/workspace.ts`
- **Attack** the Docker track's student shell writes its workspace; Check reads a
  lab-named file there through the shared terminal service. A whole-file
  `readFile` then a 256 KiB cut: a 64 MiB file left the probe at 227 MiB RSS
  against 132 MiB bounded, so a few hundred MiB made by accident (`docker save`
  into the workspace) OOMs the 512 MiB container. A FIFO at the path blocked a
  libuv worker indefinitely (probe: still blocked after 3 s; `process.exit`
  could not end the process); four stall every file operation, credential
  writes for every student included.
- **Note** a deliberate DoS was already possible — a shell shares uid 1001 with
  the service and can `kill` it (accepted, `docs/secret-boundaries.md` §5). This
  closes the accidental path and the thread-pool wedge.
- **Fix** one `open` with `O_NONBLOCK | O_NOFOLLOW`, regular files only, at most
  the cap read from that handle.
- **Test** `workspace.test.ts` (600 MiB sparse file; fails before). The FIFO case
  needs `mkfifo`, which the host-execution guard rightly forbids in a unit test:
  LOCAL probe only.

### SEC-RT-3 — `/internal` from the edge (LOW)
- **Component** `infrastructure/docker/nginx/locations.conf`, `apps/api/src/app.ts`
- **Attack** `GET /internal/../api/labs`: nginx matches `location /api/` on the
  normalised path and, with a variable `proxy_pass`, forwards the raw target;
  Express does not resolve dot segments and routes it to `app.use('/internal')`.
  `%2F`-encoded forms (`/internal/sessions/x%2F..%2F..%2F..%2Fapi/credentials`)
  too. `INTERNAL_SERVICE_SECRET` held; it was the only barrier left.
- **Fix** the api refuses any path with a `.`/`..` segment (raw, encoded, or
  behind an encoded separator), a backslash, or an undecodable escape: 400
  `INVALID_PATH`. Each proxied location refuses a raw `$request_uri` outside its
  prefix: 400.
- **Evidence** nginx:alpine with the shipped `locations.conf`: every confusion
  form reached the upstream raw before, is 400 after; `/api`, `/auth`,
  `/terminal` still proxy.
- **Test** `apps/api/test/request-target.test.ts`; `tls-edge-contract.test.ts`.

### SEC-RT-4 — the provider's words (LOW)
- **Component** `apps/api/src/routes/{sessions,labs,internal}.ts`, `services/terminal/src/server.ts`
- **What leaked** `docker run` stderr (daemon paths, container names), the
  Kubernetes API URL and internal addresses, Node's socket error with the
  broker's address — as the error message, every failed step's `detail`, the
  FAILED / DEGRADED `statusReason`, the student's permanent attempt history, and
  the terminal's error frame (which the web client prints into the terminal).
- **Fix** students get the code and a sentence of ours; steps keep id, label,
  status, timing. The operator keeps the originals: the session manager's log,
  the session row (`ops sessions`), `verify.errored`, the terminal's log. The
  `/internal` exchange stays raw for the terminal, which logs it. Platform-worded
  refusals (capacity, the student's limit, ownership, the isolation gate's
  reason, sandboxd's attach gate) are unchanged.
- **Test** `apps/api/test/error-disclosure.test.ts`, `services/terminal/test/error-disclosure.test.ts`.

### SEC-RT-5 — redaction gaps (LOW)
- **Component** `services/observability/src/{redact,support-bundle}.ts`
- **Fix** case-insensitive `authorization: bearer|basic …`; values assigned to
  a credential-named key (`GRAFANA_ADMIN_PASSWORD=`, `PGPASSWORD=`,
  `x-internal-secret:`, `?token=`, `api_key=`, `"clientSecret":"…"`) with bounded,
  linear patterns; fields named exactly as a credential redacted whatever their
  value (`authorizationResult`, `tokenTtlSeconds` survive); the token cut by the
  8 KiB bound dropped. The bundle's last gate learns the header and assignment
  shapes. The scanner fails when a named env file cannot be read.
- **Test** `redact.test.ts` (+3 adversarial complexity inputs), `support-bundle.test.ts`.

### SEC-DEP-1 and SEC-HDR-1
- express 4.22.3 depends on `qs ~6.16.0`: both runtime advisories closed by a
  patch release. `npm audit`: 2 moderate left, both the dev-only vitest advisory
  whose fix is vitest 4 (a major upgrade, not taken).
- `security-headers.conf`, server level in both web servers: CSP
  `frame-ancestors 'none'; object-src 'none'; base-uri 'none'`, `X-Frame-Options:
  DENY`, `nosniff`, `Referrer-Policy: same-origin`, a Permissions-Policy. No
  script/style/connect policy (follow-up).

## 5. Verified sound this pass (no change)

- **Authentication.** Cookie → hashed server-side record, never a client-named
  id; forged/expired cookie is a refusal, not a fall-through; production refuses
  development auth; OIDC verifies signature, `iss`, `aud`, `exp`, `azp`; logout
  destroys the record before clearing the cookie; redirects built from
  configuration only (`safeReturnTo` refuses `//`, `/\`, control characters).
- **Authorization / IDOR.** Every session route through `sessionGuard` (404 for
  foreign and absent alike); `GET /api/sessions` filters by the caller; attempts
  by server-derived student id; `/internal` re-proves the token's owner against
  the live row. Start/check bodies naming an owner, status, provider or a
  "passed" verdict are ignored. Replayed live by
  `five-student-adversarial.test.ts` (A→B read, B→C reset, C→D check, D→E end,
  E→A terminal via API and `/internal`, F past capacity ×8, A's own limit ×6,
  stale and malformed ids); letting STUDENT act on any session fails 7 of its 10.
- **Terminal / WebSocket.** Origin allow-list; one auth frame; HMAC token bound to
  `{sid, uid}`, `exp` enforced; ownership re-proved on every attach and reattach;
  frame 64 KiB / input 8 KiB caps; output backpressure; broker ref cross-check.
- **sandboxd.** Scope-per-secret; attach derives the container from the session
  id and requires managed/owner/session labels; shell user never root; argv only.
  Each DinD mints its own CA, so one session's client certificate opens no other
  daemon.
- **Filesystem.** Workspace paths lexical + realpath; baseline writes
  `O_NOFOLLOW`; lab assets realpath-confined; the tar reader reads one regular
  entry and never writes.
- **Database.** Every query parameterized; the only interpolations are constant
  column lists and placeholder indices.
- **Static sweep.** No `eval`, `new Function`, `shell: true`,
  `dangerouslySetInnerHTML`/`innerHTML`, TLS verification disabled, or
  `Math.random` for an identifier; the one `sh -c` is the operator-only network
  probe with a validated host.
- **XSS.** All student-, lab- and sandbox-derived text is rendered as React text;
  reference links are https-only with `rel="noreferrer noopener"`; xterm's link
  handlers accept http(s) only.
- **Metrics / operator surfaces.** Metrics listeners require the scrape token;
  the operator socket is a 0700 directory on the api's own tmpfs, not shared.
- **SSRF.** Outbound requests go to configured targets only (OIDC discovery/JWKS,
  internal services); `service_http` is redirect-free and bounded (SEC-RT-7 is
  the remaining shape).

## 6. Accepted for the five-student trusted beta (unchanged)

1. **Shared shell uid 1001 (SEC-ARCH-2).** A Kubernetes/Docker-track shell can
   read another live shell's `/proc/<pid>/environ` and so its kubeconfig or Docker
   client key, and can signal (kill) the terminal service, ending every shell on
   it.
2. **Privileged Docker-in-Docker (SEC-ARCH-1).** Isolation between students, not a
   hardened boundary against a container escape to the host kernel.
3. **Who may sign in (SEC-EXT-1)** — any account the issuer authenticates.
4. SEC-RT-11 and SEC-RT-13 above.

## 7. Must be fixed before untrusted or public users

Per-student shell uid (removes the credential read *and* the signal DoS);
VM/kernel-isolated sandboxes instead of privileged DinD; a sign-in allowlist or
registration policy; node PID/storage/object quotas (SEC-K8S-1); a CNI with proven
enforcement and node-traffic control (SEC-EXT-2); edge rate limiting and abuse
controls, including a per-session terminal attach budget (SEC-RT-8); a full
script/style/connect CSP proven in a real browser; SEC-RT-6 (token Secrets) and
SEC-RT-7 (Endpoint-chosen probes) closed; supply-chain scanning and pinning
(SEC-CI-1).

## 8. Real-host security tests still required

None of the following can be proven from this machine: the public edge (only
443/80 published, firewall, TLS certificate, HSTS and the new headers served by
the real web image through the real hostname, the `/internal/../` refusal through
that edge); NetworkPolicy enforcement and pod-to-node traffic on the production
CNI; the five-student gate (`make beta-validate`) on the production host with real
sign-in through the chosen identity provider; alert delivery to a person; backup
restore off-host. The kind/Docker/sandboxd/terminal integration suites were **not
run** tonight: other sessions were using the shared Docker daemon and kind
clusters (load average 40–55), and `sandbox:build` overwrites a shared `:latest`
image. CI runs them on a PR.

## 9. Follow-ups (non-blocking for the trusted beta)

- Full CSP (script/style/connect) after a real-browser run of sign-in, Start,
  terminal and Check (`style-src 'unsafe-inline'` is needed by xterm.js).
- SEC-RT-6..10, SEC-RT-12, SEC-RT-14 as owned in §3.
- Correct `docs/kubernetes-network-security.md`: NET-024/025 use `service_http`/`service_tcp`.
- Web `token-storage.test.tsx` fails under Node 25 (its global `localStorage`
  shadows jsdom's); CI pins Node 22 via `.nvmrc`, where it passes. Run the
  gates under Node 22 locally.
- Possible overlap to reconcile: earlier notes record terminal attach-race work
  on `feat/private-beta-launch-readiness`, which is not on `main` and was not
  inspected here. SEC-RT-1's fix was written against `main` only; whoever merges
  second should check the two together.

## 10. Evidence

See §4 for the per-fix negative controls. Final gates, run locally (not CI) at
`c423b40` under Node 22.23 (the `.nvmrc` version), load average ~31:

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run validate:labs` | exit 0 |
| `npm run build` | exit 0 |
| `npm run test:security` | exit 0 — 52 files, 856 tests, 0 failed (baseline at `001bcf1`: 47 files, 784) |
| `npm test` | exit 0 — api 653/15 skipped; web 233; lab-orchestrator 1344/253; observability 846/37; progress 96/1; sandboxd 138/7; terminal 170/20; verifier 1569 |
| `bash scripts/test-private-beta-diagnostics.sh` | all cases passed |
| `git diff --check` | clean |

Skipped tests are the opt-in integration suites (live kind/Docker/sandboxd), not
run here (§8). Under this load one terminal timing test
(`session-activity.test.ts`, 5 s timeout) failed once in a parallel run and
passed alone twice; it did not fail in the final run.
