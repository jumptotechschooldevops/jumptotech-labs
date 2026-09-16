# Private-beta security audit

**Branch** `feat/security-audit-post-beta`, worktree `~/jtt-security-audit`
**Base** `origin/main` at `0f33b1f` (the merged beta-overnight-hardening PR #34)
**Date** 2026-09-16
**Audience** the deep security pass before a private beta of ~5 **trusted** students
**Verdict** the application-security and sandbox-isolation posture is sound for the
stated trusted cohort. Nine defects were found and fixed, each reproduced first
and each with a regression test that fails against the previous code. None is a
break of an existing isolation, authentication or secret boundary; all nine are
resource-exhaustion or defence-in-depth gaps behind the controls that do hold.
The private-beta gate in §25 is unchanged in its conclusion and its conditions:
deployment-time decisions (§22) and a per-student shell uid before any
**untrusted** cohort remain open, as the release gate already recorded.

This audit builds on, and does not repeat, the BETA-P0-010…P0-020 sequence, the
overnight hardening pass, and the production-host and browser-E2E passes. Where
a control was already proven, it is listed as verified, not rebuilt.

---

## 1. Scope

In scope, and audited against the code at `0f33b1f`:

- Authentication (OIDC, browser BFF, terminal token, dev/test bypasses).
- Authorization / IDOR across every identifier-bearing endpoint.
- The browser terminal path: WebSocket → API → terminal → sandboxd → sandbox.
- Workspace / filesystem containment.
- The Docker sandbox and the privileged Docker-in-Docker component.
- Kubernetes sandbox isolation (RBAC, PSA, NetworkPolicy, quotas).
- The verifier, treated as processing hostile input.
- Lab-definition trust.
- API behaviour, resource-exhaustion bounds, session caps.
- Database access and query construction.
- Secret management and hygiene.
- TLS / public-edge security properties in code and config.
- Container image / supply-chain and CI/CD security.
- Logging and privacy.

Out of scope (owned elsewhere, deliberately not duplicated): the networking
capability system and Wave-2 labs (`feat/networking-wave2-platform`), browser
E2E (`feat/browser-e2e-beta`), production-host deployment (`feat/production-host-readiness`),
catalog/curriculum validation (`feat/catalog-quality-audit`), student UX
(`feat/student-beta-experience`). `main` was not merged and no other branch was
modified.

Method: read the code; reproduce a suspected weakness with a probe or a failing
test before changing anything; fix narrowly; add a regression test; prove the
test fails against the previous code (a negative control or a mutation);
re-validate the touched suites. Three read-only sub-audits (verifier, Kubernetes,
CI/supply-chain) fanned out in parallel and their findings are folded in here.

## 2. Architecture reviewed

The trust gradient, from most to least exposed:

```
 browser ──443──► web (nginx) ──► api (4000)  ──► postgres (internal net)
                              └──► terminal (4001, WS) ──► sandboxd (4002)
                                                          │  holds /var/run/docker.sock
                                                          ├─► Docker/Linux/etc. sandbox containers
                                                          └─► kind node (Kubernetes namespaces)
```

- **api** holds every platform secret except the Docker socket, is the OIDC
  confidential client, and makes every authorization decision. No container
  runtime access.
- **terminal** runs a PTY per session; starts as root, drops to uid 1001
  in-process (BETA-P0-010), holds no runtime access, relays to sandboxd.
- **sandboxd** is the only holder of the Docker socket; a three-scope credential
  model (`attach`/`runtime`/`docker`), and its attach gate derives the container
  name from the session id and re-checks ownership labels.
- **postgres** shares an `internal: true` network with the api alone in
  production.

## 3. Threat model

Actors A–K per the mission. For each meaningful surface: ASSET / TRUST BOUNDARY
/ ATTACK / CURRENT CONTROL / EVIDENCE / RESIDUAL RISK.

**B/C — malicious student, cross-student access.**
ASSET another student's session, workspace, credentials, progress.
BOUNDARY the api's `authorize()` / `sessionGuard`.
ATTACK guess or replay an id to read/reset/end/attach.
CONTROL owner-checked server-side on every session route and every terminal
attach; 404-not-403; ids never accepted as authority; terminal token bound to
`{sid, uid}` and re-checked against the live row.
EVIDENCE `apps/api/test/{authorization,auth-security,terminal-ownership,oidc-ownership-e2e}.test.ts`;
`services/terminal/test/terminal-ownership.test.ts`. RESIDUAL shared uid-1001
credential read between live shells (§6, accepted for trusted beta).

**D — student controlling terminal input.**
ASSET the relay processes and the host.
BOUNDARY the WS protocol and the PTY.
ATTACK oversized/malformed frames; command injection; output flood.
CONTROL frame ≤64 KiB, input ≤8 KiB, one auth frame, argv-only spawn, no shell;
**now** output backpressure (finding SEC-EXH-1). EVIDENCE `protocol.test.ts`,
`spawn-plan.test.ts`, `output-backpressure.test.ts`. RESIDUAL a student can
still `kill` the shared-uid service (§6).

**E/F — compromised lab or Docker sandbox.**
ASSET the host kernel and other students.
BOUNDARY the container, and for the Docker track `--privileged` DinD.
ATTACK break out of a container inside one's own sandbox.
CONTROL cap-drop ALL + closed grant-list, no-new-privileges, non-root, no host
mount, resource ceilings; **now** host/`container:` network and unbounded
ceilings refused at the daemon boundary (SEC-EXH-4). EVIDENCE
`container-runtime-boundary.test.ts`, README → Docker sandbox security. RESIDUAL
`--privileged` DinD is not a hardened boundary — a determined escape reaches the
host kernel (§9, ACCEPTED, VM-per-sandbox is the production answer).

**G/H — attacker at the edge; stolen/replayed token.**
CONTROL OIDC verify (sig/iss/aud/exp/nbf/azp/alg-allowlist), opaque hashed
HttpOnly session cookie, origin guard on writes, production fail-closed.
EVIDENCE `oidc-flow-hardening.test.ts`, `production-oidc-config.test.ts`,
`auth-security.test.ts`. RESIDUAL any account the issuer authenticates is
admitted as STUDENT (§22, deployment decision).

**I — malicious lab definition.**
CONTROL kind allowlist, namespace forced, PSA violations rejected, capability
provider-gate, image-reference pattern; **now** verifier `service_http` does not
follow redirects (SEC-EXH-5). RESIDUAL lab authors are semi-trusted; a lab-YAML
`as_user: root` verifier command and setup ServiceAccount replacement are
lab-author-trust items (§8, deferred).

**J — operator mistake.**
CONTROL production secret/transport/TLS/network gates refuse to start on a bad
value; `SANDBOX_NETWORK`/ceiling typos now refused at create (SEC-EXH-4);
`.env.*` and credentials excluded from images (SEC-SEC-1). RESIDUAL
`MAX_ACTIVE_SESSIONS` default 20 vs beta 5 (documented, operator check).

**K — dependency / supply chain.**
CONTROL lockfile, `npm ci` everywhere, CodeQL, secret-distribution gate. RESIDUAL
no dependency/image scanning in CI; actions and base images pinned by tag not
digest; 2 moderate transitive `qs` advisories, not reachable (§16).

## 4. Trust boundaries

1. browser ↔ api — cookie/bearer, origin guard, CORS allow-list.
2. api ↔ terminal — `INTERNAL_SERVICE_SECRET`, constant-time, `/internal` off CORS.
3. terminal ↔ sandboxd — per-scope secret; attach derives the target itself.
4. sandboxd ↔ Docker socket — the one privileged hop; argv-only; ownership labels.
5. student shell ↔ everything — uid 1001 in a capability-dropped container.
6. api ↔ postgres — parameterized SQL, internal network, TLS gate off-bridge.
7. build host ↔ image — `.dockerignore` (widened here).

## 5. Authentication findings

**Verified sound (no change):**
- OIDC verification enforces signature (JWKS), `iss`, `aud`, `exp` (required),
  `nbf`, `azp`, and an RS/PS/ES/EdDSA algorithm allowlist — `alg:none` and HS*
  are refused (`apps/api/src/auth/oidc.ts`). No `decode`-then-trust path.
- Browser flow is a backend-for-frontend: PKCE S256, state+nonce constant-time,
  opaque 256-bit session cookie stored only as SHA-256, HttpOnly/SameSite=Lax,
  `Secure` mandatory in production; no OIDC token ever reaches the browser.
- Terminal token: HMAC-SHA256 over `{sid, uid, labId, namespace, iat, exp}`,
  `timingSafeEqual`, `exp` enforced, length-capped, a missing `uid` fails closed
  (`services/lab-orchestrator/src/session-token.ts`).
- `authenticate` reads only the cookie then the `Authorization` header — never a
  user id from body/query/header. A present-but-unusable cookie is a refusal,
  not a fall-through to the dev default.
- Production fail-closed: `AUTH_MODE=development` under `NODE_ENV=production`
  refuses to start; `AUTH_MODE` defaults to `oidc`; `DEV_STUDENT_HEADER_ENABLED=true`
  refused; missing client secret / http issuer / non-https public origin /
  in-memory stores all refused. `NODE_TLS_REJECT_UNAUTHORIZED` refused.
- Dev/test bypasses (`Authorization: Developer <name>`, `x-dev-student-id`) are
  fenced by `buildIdentityResolver`, which cannot return a dev resolver in
  production, and a real bearer offered to the dev resolver is refused, not
  ignored.

No authentication defect found. The one open item is **who may sign in** — any
account the issuer authenticates is provisioned STUDENT — which is a deployment
decision (§22), already recorded in `docs/authentication.md` §4.7.

## 6. Authorization findings

**Verified sound (no change):** every session route goes through `sessionGuard`,
which resolves the row and proves `ownerUserId === req.user.userId` in one step;
`GET /api/sessions` filters to the caller's own owner id and takes no parameter;
`/api/me/*` scopes every read to a server-derived `studentId` and the progress
repository filters every query by `student_id` (parameterized). `/internal`
credential and activity exchanges re-prove ownership against the live row even
with a valid HMAC. Cross-user reads/writes/resets/ends/attaches are denied and
answered 404, proven with two distinct users in `authorization.test.ts` and
`oidc-ownership-e2e.test.ts`. Namespaces and sandbox refs are never inputs.

INFORMATIONAL: `studentIdForUser` folds provider-shaped user ids to
`[a-z0-9._-]`, so two ids differing only in excluded characters could collapse
to one progress history. Not reachable today — ids are internal `usr-NNNNNNNN`
UUIDs — recorded for a future provider-shaped id.

No authorization defect found.

## 7. Terminal findings — SEC-EXH-1 (FIXED)

See the full finding block in §20. Summary: the PTY→WebSocket relay in the
terminal service, and the same relay in sandboxd, queued unread output in
process memory without bound; a client that stops reading while its shell runs
`yes` grows a shared service until it is OOM-killed, taking every other
student's shell with it. Fixed with output backpressure. Everything else in the
terminal path (WS auth, origin allow-list, one-auth-frame, argv-only spawn,
frame/input caps, idle/max timers, credential cleanup) was verified sound and is
unchanged.

## 8. Workspace / filesystem findings

**Verified sound (no change):** `resolveWorkspaceFile` rejects absolute paths,
`..`, backslashes; the overnight pass added `realpath` containment on read and
`O_NOFOLLOW` + resolved-parent on write, closing the student-planted-symlink
redirect (0881d19, confirmed present on `0f33b1f`). Per-session directories are
HMAC-named under a `0711` root. Verifier sandbox paths go through
`isSafeSandboxPath` (NUL/`..`/`~`/backslash refused, per-segment charset) and
argv is passed after `--`.

DEFERRED (no demonstrated impact, listed by the overnight pass): the credential
tmpfs (`/run/jumptotech`) still follows symlinks; the target is uid-1001's own
credential, and redirecting another session needs an id nothing discloses.
`O_NOFOLLOW` there is cheap hardening, left as an operator decision.

## 9. Docker sandbox findings

**Verified sound:** only sandboxd mounts the socket; api/terminal/web/observability
never do; no `chmod 666` workaround. Sandbox containers run `--cap-drop ALL`
plus a closed grant-list (host-reaching caps absent), `no-new-privileges`,
non-root, no host mount, `--memory`/`--memory-swap`/`--cpus`/`--pids-limit`
ceilings, `--network none` by default. The runtime scope re-applies ownership
labels and scopes every list/inspect/remove to `runtimeOwner`.

FIXED (SEC-EXH-4, §20): `network`, `pidsLimit`, `memory`, `cpus` reached
`docker run` unvalidated; `--network host`, `--network container:<other>` and
`--pids-limit 0`/`--memory 0` (Docker reads 0 as unlimited) were expressible by
a runtime-scope holder or an operator typo. Now refused at the daemon boundary.

ACCEPTED FOR TRUSTED BETA: **privileged Docker-in-Docker is not a hardened
boundary.** DIND requires `--privileged` for the inner daemon; a student who
escapes a container *inside their own sandbox* reaches that sandbox's privileged
context and from there the host kernel. This is isolation between students, not
against a determined attacker. Reproduction of the host-device-access blast
radius was attempted and correctly blocked by the environment's containment
guard; the property is documented and confirmed by the design, not exercised
here. The production answer is a VM per sandbox (Firecracker/Kata/per-tenant
node) via the `LabProvider` seam, and rootless DIND was tried on the
production-host branch and is not yet proven. **Required before any untrusted
cohort.**

## 10. Kubernetes sandbox findings

**Verified sound (enforced in code):** namespaced Role only, no ClusterRole; no
rights to namespaces, nodes, PersistentVolumes, StorageClasses, CRDs, admission
policies, `escalate`/`bind`, or `serviceaccounts/token`; PSA
`enforce=baseline,warn=baseline,audit=restricted` v1.34 stamped at creation and
re-merged every guardrail pass, `privileged` unconfigurable; TokenRequest
credential scoped to one namespace, short TTL, dies with the namespace;
automount off on `student` and `default`; default-deny NetworkPolicy with DNS
narrowed to kube-dns and API server `/32`, NodePort/LoadBalancer quota 0;
setup-manifest kind allowlist with namespace forced and host-access rejected;
reaper/destroy only touch labelled `lab-` namespaces of this runtime.

Open items (from the sub-audit; each documented in `docs/pod-security.md` /
`docs/kubernetes-network-security.md`, none a new break — recorded here, fixes
deferred to the Kubernetes owner because they touch the shared cluster contract):

- **DEFERRED, MEDIUM (DoS):** no `podPidsLimit` on the single kind node; the
  quota bounds CPU/memory/PVC-count but not PIDs, ephemeral storage, or object
  counts (`count/secrets` etc.), so a fork bomb, an `emptyDir` fill, or ~1,400
  Secrets could pressure the shared node or etcd. Bounded blast radius on a
  single-node trusted beta; a real fix is kubelet + quota config on the cluster.
- **DEFERRED, LOW:** the student Role can write `endpoints` and `ingresses`
  (CVE-2021-25740 shape) — inert with no ingress controller installed; and can
  bind its own Role to arbitrary `subjects` in the K8S-012 overlay (exposes only
  the student's own namespace).
- **ACCEPTED:** pod-to-node traffic (kubelet :10250, cloud IMDS) is not governed
  by NetworkPolicy — decision D3, already open.
- **INFO:** `restricted` is deliberately not enforced (K8S-001 `kubectl run`);
  a missing-CA cluster endpoint falls back to `insecureSkipTlsVerify`
  (`k8s/client.ts:1106,1120`) — kind-only path.

## 11. Verifier findings

The verifier runs on the API's event loop (no worker thread), so any CPU blow-up
in it stalls every student's API. All exec is `execFile`, `shell:false`, with
timeout and `maxBuffer`, gated by allowlists; no lab-supplied regex anywhere;
student YAML parsed with `yaml` (alias/merge-key bomb off); the only interpolated
`sh -c` is the operator-only network probe with a validated host. **Verified
sound.**

FIXED (SEC-EXH-2/3, §20): four parsers ended a line pattern with `(.+?)\s*$`,
quadratic on a long whitespace run the student controls (a 100 KiB `ps` line,
built from the student's own process arguments, took 15.5 s; CI/pipeline files
~5 s per 60 KiB). Replaced with linear parsers.

DEFERRED (lab-author trust, from the sub-audit): the read-only verifier command
allowlist admits arguments like `find / -delete` or `awk -f <student script>`
(charset blocks metacharacters but not dangerous flags), and `as_user: root` is
allowed — a careless or malicious lab author, not a student, and confined to one
session container. Recommend a per-command flag policy; left to the catalog/lab
owner.

## 12. API findings

**Verified sound:** 16 KB JSON body cap; no `x-powered-by`; central error handler
never leaks a stack; `trust proxy` is exactly one hop; malformed ids are 400 not
500; unknown routes 404. FIXED here: per-session single-flight on `check`
(SEC-EXH-6) and a per-student Start/Reset budget (SEC-EXH-7). General per-route
rate limiting beyond these and the learning-path routes remains a documented
limitation, acceptable for a 5-student trusted beta behind authentication and
the origin guard.

## 13. Database findings

**Verified sound:** every query is parameterized (`$1`…); the one place a
fragment is built (`session/postgres-store.ts` SET clause) draws column names
from a fixed map, never from input; TLS transport gate refuses plaintext to a
non-loopback host in production and refuses `ssl*` params in `DATABASE_URL`;
postgres is alone with the api on an `internal: true` network; backups are
excluded from images and observability. No SQL-injection or exposure defect.

INFORMATIONAL / DEFERRED: the api connects as the database owner role
(`POSTGRES_USER`), not a least-privilege application role. Acceptable for the
beta; a dedicated role with table-scoped grants is a hardening item and a
deployment/migration decision, not made here.

## 14. Secrets findings

**Verified sound:** no real credential is tracked (sub-audit swept `git ls-files`;
every hit is a test fixture, an AWS `…EXAMPLE` key, or a placeholder); every
credential directory carries a deny-all `.gitignore`; production refuses
placeholder/short/low-entropy/shared/cross-service secrets; the web bundle
carries none; the terminal drops uid so its `/proc` closes to shells.

FIXED (SEC-SEC-1, §20): `.dockerignore` excluded only the TLS dir, and every
image copies whole service directories — a `.env` dropped in `apps/api/` shipped
in the image (reproduced with a real build; blocked after the fix). `.dockerignore`
now excludes `.git`, `**/.env`, `**/.env.*`, the kubeconfig and observability
secret dirs, and `backups/`; `.gitignore` gains `.env.*` (keeping `.env.example`).

ACCEPTED (§6): shared uid-1001 lets one live shell read another live session's
per-session kubeconfig / Docker key from the tmpfs — trusted-beta only.

## 15. TLS findings

**Verified sound in code/config** (deployment proof belongs to the production-host
branch): nginx serves TLSv1.2+1.3 only, HSTS, `server_tokens off`, port-80 →
301 + ACME only, `ssl_reject_handshake` default server; the web TLS key is
excluded from git, every build context, every Dockerfile `COPY` and the bundle
(`tls-edge-contract.test.ts`, extended here); the terminal WS is proxied over
TLS with a fail-closed preflight. `X-Forwarded-Proto`/`Host` are not trusted for
redirects — callbacks are built from `PUBLIC_ORIGIN` only.

INFORMATIONAL: no Content-Security-Policy / X-Frame-Options header is set on the
app HTML. Low value for a 5-student trusted beta on a single SPA origin; noted
as hardening.

## 16. CI/CD and supply-chain findings

From the sub-audit (`npm audit` was the only network call). No CRITICAL/HIGH.

- **DEFERRED, MEDIUM:** no Dependabot, no `npm audit` in CI, no image scanning;
  GitHub Actions pinned by tag not SHA (and codeql uses `checkout@v7` while the
  rest use `@v4`); base images and `docker:27-dind` are floating tags; CI/Dockerfile
  binary downloads (kubectl, docker CLI, compose, terraform) are version-pinned
  but not checksum-verified.
- **LOW:** 2 moderate transitive `qs` advisories under `express@4.22.2` —
  vulnerable version present but **not reachable** (express calls `qs.parse`
  without `comma:true`, and the app mounts only `express.json`); a `qs` bump
  needs an express release that moves its `~6.15.1` range. vitest moderate is
  dev-only.
- **Verified sound:** top-level `permissions: contents: read` on quality-gates;
  codeql declares its own per-job permissions; no `pull_request_target`; no
  `${{ github.event.* }}` interpolation in `run:`; `npm ci` everywhere; the
  secret-distribution and no-committed-backup gates run in CI.

CI workflows were **not modified** — the improvements above are recommendations,
and the mission says to change workflows only for a clear, testable win; pinning
and scanning are best landed by the owner with Dependabot to maintain them.

## 17. Resource-exhaustion findings

The heart of this pass. Six exhaustion vectors found and fixed: SEC-EXH-1
(terminal/sandboxd output flood), SEC-EXH-2/3 (verifier quadratic parsers),
SEC-EXH-4 (unbounded container ceilings / host net), SEC-EXH-6 (check flooding),
SEC-EXH-7 (Start/Reset flooding). Full blocks in §20. The Kubernetes node-level
exhaustion gaps (PIDs, storage, object counts) are §10, deferred to the cluster
owner.

## 18. Logging / privacy findings

**Verified sound and now proven by test (SEC-TEST-1, §20):** terminal input and
output, refused frames and the session token appear in no log line of the api,
terminal or sandboxd — the property the terminal server's own comment claimed a
test enforced, which did not exist until now. Redaction covers Authorization,
cookies, JWTs, connection strings; errors are logged without stacks; the remote
address and attacker-chosen origin are kept out of log *fields*. No student
command logging was introduced.

## 19. Security tests added

| ID | Test | Proves |
|---|---|---|
| SEC-EXH-1 | `services/terminal/test/output-backpressure.test.ts` (3) | a stalled reader cannot grow the relay past the hard limit; a resumed reader gets every byte; an unpausable source loses only its own connection |
| | `services/lab-orchestrator/test/output-flow.test.ts` (8) | the flow-control state machine |
| SEC-EXH-2/3 | `services/verifier/test/line-value.test.ts` (8) | linear parsers agree with the old patterns over 100k lines; adversarial lines parse in <250 ms |
| SEC-EXH-4 | `services/lab-orchestrator/test/container-runtime-boundary.test.ts` (22) | host/`container:` network and unbounded ceilings refused before `docker run` |
| SEC-EXH-5 | `services/lab-orchestrator/test/service-http-probe.test.ts` (6) | `service_http` does not follow redirects and caps the body |
| SEC-EXH-6 | `apps/api/test/check-concurrency.test.ts` (4) | one verification per session; ownership 404 still first |
| SEC-EXH-7 | `apps/api/test/sandbox-write-rate-limit.test.ts` (5) | per-student Start/Reset budget; per-user not per-address |
| SEC-SEC-1 | `services/observability/test/build-context-secrets.test.ts` (3) | env files and credentials excluded from build contexts |
| SEC-TEST-1 | `services/terminal/test/terminal-content-logging.test.ts` (1) | typed input, shell output and tokens never logged |

All are wired into `npm run test:security` (§24).

## 20. Findings fixed

### SEC-EXH-1 — unbounded shell-output buffering in the terminal and sandboxd relays
- **SEVERITY** HIGH · **STATUS** FIXED · **COMPONENT** `services/terminal/src/server.ts`, `services/sandboxd/src/server.ts`, `services/lab-orchestrator/src/output-flow.ts`
- **ATTACK** (actor D) a student runs `yes` (or `cat /dev/zero`) and a client
  that stops reading its WebSocket. `term.onData → ws.send` queues every unread
  byte in the relaying process; `ws.send` never refuses.
- **EVIDENCE** a probe against the shipped terminal measured 127 MiB queued on
  one socket for 128 MiB emitted (63 MiB for 64 MiB). The production terminal
  container is capped at 512 MiB, so one student OOM-kills the service and drops
  every other student's shell. sandboxd relays the same stream one hop earlier
  with the same shape.
- **FIX** a shared `OutputFlow` pauses the source once the socket holds >1 MiB
  unread and resumes below 256 KiB; a local PTY pauses its master read, a broker
  shell pauses its socket (pushing backpressure to sandboxd). A queue past
  16 MiB closes that one connection, counted as security event `output_backlog`.
- **TEST** SEC-EXH-1 above; all three integration cases fail against the
  pre-fix servers (negative control run).
- **RESIDUAL** none for the mechanism; a source that genuinely cannot be paused
  is bounded by the hard-limit close rather than slowed.

### SEC-EXH-2 / SEC-EXH-3 — quadratic line parsing on student-controlled input in the verifier
- **SEVERITY** MEDIUM · **STATUS** FIXED · **COMPONENT** `services/verifier/src/{sandbox-reader,ci/secrets,ci/jenkinsfile,handlers/pipeline-config}.ts`, new `src/line-value.ts`
- **ATTACK** (actor D/I) four parsers ended their line pattern with `(.+?)\s*$`,
  which backtracks quadratically on a long whitespace run followed by a
  non-space. The `ps` parser reads `ps -eo pid=,user=,args=`, whose `args`
  column is the student's own process command line.
- **EVIDENCE** in the real `jumptotech/lab-linux` image, a student's
  `sh -c 'sleep 1e6' … "<100k spaces>x"` produces a 100,041-char `ps` line;
  parsing it took **15.5 s** on the API's event loop; output is capped at
  256 KiB (~90 s at the cap). CI/pipeline parsers: ~5 s per 60 KiB student file.
  9 labs use process checks.
- **FIX** `matchLineValue` / `valueAfterSeparator` compute the same capture
  without backtracking.
- **TEST** SEC-EXH-2/3; equivalence over 100,000 generated lines against the old
  patterns, plus adversarial lines under 250 ms.
- **RESIDUAL** one intended behaviour change: a whitespace-only value is now no
  value (the old lazy group could not use it anyway).

### SEC-EXH-4 — host networking and unbounded ceilings accepted at the runtime boundary
- **SEVERITY** MEDIUM · **STATUS** FIXED · **COMPONENT** `services/lab-orchestrator/src/providers/container/runtime.ts`
- **ATTACK** (actor F/J) sandboxd forwards the runtime scope's `ContainerSpec`
  to `DockerCliRuntime.create`, which validated name/image/caps/env but passed
  `network`, `pidsLimit`, `memory`, `cpus` to `docker run` verbatim —
  `--network host`, `--network container:<another sandbox>`, `--pids-limit 0`,
  `--memory 0` (Docker reads 0 as unlimited).
- **EVIDENCE** code path; 18 refusal cases fail against the pre-fix runtime.
- **FIX** `create()` accepts `none` or a bare network name only (never `host`,
  `container:`, `ns:`) and positive ceilings only, before any docker command.
- **TEST** SEC-EXH-4 (22).
- **RESIDUAL** none; this is the daemon boundary, and the check is defence in
  depth behind the schema check in the api process.

### SEC-EXH-5 — verifier `service_http` followed redirects and read unbounded bodies
- **SEVERITY** MEDIUM · **STATUS** FIXED · **COMPONENT** `services/lab-orchestrator/src/k8s/client.ts`
- **ATTACK** (actor I) the check fetched the student's Service (whose Endpoints
  and Pod the student controls) with `fetch` defaults: up to 20 redirects
  followed and `response.text()` of whatever the backend streamed. A backend
  answering `302 Location: http://sandboxd:4002/…` sends the next request from
  the API process, and the status leaks back in the failure message; a slow
  stream fills API memory.
- **EVIDENCE** code path; hermetic tests with a fake `fetch`; a mutation
  restoring the old behaviour fails 2 of 6.
- **FIX** `probeServiceHttp` uses `redirect: 'manual'` (a redirect is the
  Service's status, reported as such) and reads the body only when needed, up to
  64 KiB.
- **RESIDUAL** the probe still reveals reachable/refused for the student's own
  ClusterIP:port — the check's purpose; SSRF and the memory vector are closed.

### SEC-EXH-6 — unbounded concurrent verifications per session
- **SEVERITY** MEDIUM · **STATUS** FIXED · **COMPONENT** `apps/api/src/routes/sessions.ts`
- **ATTACK** (actor D) a Check runs a lab's whole requirement list against the
  sandbox in the API process; nothing stopped one student firing many at once
  for the same session (the browser disables Verify while one runs).
- **FIX** an in-process per-session single-flight; a concurrent second check is
  409 `CHECK_IN_PROGRESS`, released however the first ends; the ownership 404 is
  still returned first.
- **TEST** SEC-EXH-6 (4); the concurrency case fails against the pre-fix route.
- **RESIDUAL** in-process, matching the single-instance beta; a multi-instance
  deployment would need a shared lock.

### SEC-EXH-7 — no request budget on the sandbox-creating routes
- **SEVERITY** MEDIUM · **STATUS** FIXED · **COMPONENT** `apps/api/src/{rate-limit,app,routes/labs,routes/sessions}.ts`
- **ATTACK** (actor B) the per-student session limit refuses a second live lab
  atomically but not cheaply: every refused Start still opens/closes an attempt
  row and queues on the capacity advisory lock every other Start waits on; every
  Reset rebuilds a sandbox. Neither route had a budget.
- **FIX** Start and Reset share `SANDBOX_WRITE_RATE_LIMIT` (20/min) keyed on the
  authenticated user, so a classroom behind one NAT is not one bucket; refusals
  are 429 `RATE_LIMITED` + security event `rate_limited`.
- **TEST** SEC-EXH-7 (5); reads/check/End are unaffected.
- **RESIDUAL** per-process store, per the single-instance beta.

### SEC-SEC-1 — environment files and credentials could enter a Docker build context
- **SEVERITY** MEDIUM · **STATUS** FIXED · **COMPONENT** `.dockerignore`, `.gitignore`
- **ATTACK** (actor J) every image builds from the repo root and copies whole
  service directories; `.dockerignore` excluded only the TLS dir.
- **EVIDENCE** a throwaway build with `apps/api/.env` present showed the file in
  the image; excluded after the fix, with `package.json` still copied. Negative
  control on the original `.dockerignore` reproduced the leak.
- **FIX** exclude `.git`, `**/.env`, `**/.env.*`, kubeconfig and observability
  secret dirs, `backups/`; `.gitignore` gains `.env.*` (keeping the template).
- **TEST** SEC-SEC-1 (3).

### SEC-TEST-1 — terminal content-logging privacy was asserted only by a comment
- **SEVERITY** LOW · **STATUS** FIXED (test + stale comment) · **COMPONENT** `services/terminal/test/terminal-content-logging.test.ts`
- The server comment cited a test that did not exist. Added the test across the
  api/terminal/sandboxd log sinks; a mutation that logs typed input fails it.

## 21. Deferred findings

- **K8s node exhaustion** (§10): `podPidsLimit`, ephemeral-storage bounds,
  `count/*` quotas — owner: Kubernetes/cluster; bounded blast radius on a
  single-node trusted beta.
- **K8s Role `endpoints`/`ingresses` write and K8S-012 subject binding** (§10) —
  owner: Kubernetes; inert or self-scoped today.
- **Verifier command-allowlist flags and `as_user: root`** (§11) — owner:
  catalog/lab; lab-author trust.
- **Credential tmpfs `O_NOFOLLOW`** (§8) — hardening, no demonstrated impact.
- **Least-privilege database role** (§13) — deployment/migration decision.
- **CSP / security headers on app HTML** (§15) — hardening.
- **CI: Dependabot, `npm audit`, image scanning, SHA-pinned actions/images,
  checksum-verified downloads** (§16) — owner decision; not a testable in-repo
  win this pass should slip in.
- **`qs` moderate advisories** (§16) — wait for an express release.

## 22. External / deployment decisions

Unchanged from release-gate §7 and the production-host pass, and none is a
software defect: hosting and host sizing; Kubernetes substrate and a CNI with
proven NetworkPolicy enforcement; hostname/DNS/CA; **OIDC provider and the
allowed user population** (any authenticated account is admitted STUDENT today);
operator access path; off-host backup + a real restore drill; alert delivery;
attestation cadence and retention; **a per-student shell uid before any
untrusted cohort** (the shared-uid credential read, §6/§9). Node-local traffic
(kubelet/IMDS) control is decision D3.

## 23. Residual risks accepted for the trusted 5-student beta

1. Shared uid-1001: one live shell can read another live session's per-session
   credential.
2. Privileged DIND is student-isolation, not a hardened boundary against a
   determined escape.
3. K8s single node has no PID / ephemeral-storage / object-count quota.
4. General API rate limiting is limited to the sandbox-write and learning-path
   routes.
5. Any account the OIDC issuer authenticates is admitted — the issuer must be
   restricted to the beta cohort.

## 24. Evidence

- `npm run test:security` — **45 files, 784 tests, 0 failed** locally (the api
  chunk runs `--no-file-parallelism`; under machine load its supertest listeners
  otherwise flake `socket hang up`, which is not a platform defect —
  see [[local-postgres-ports-taken]]/[[parallel-sessions-same-worktree]] class).
- Per-workspace after the changes: api 592 passed / 15 skipped; terminal 155/20;
  sandboxd 138/7; lab-orchestrator 1296/253 (`--maxWorkers=2`); verifier
  1567/0; observability 703/36 (one pre-existing redactor timing test flakes
  under load, passes in isolation — not caused by this branch).
- `npm run typecheck` — PASS on every workspace touched.
- `git diff --check` — clean.
- Negative controls run for SEC-EXH-1/4/5/6 and SEC-SEC-1; mutation for
  SEC-EXH-5 and SEC-TEST-1.
- Docker build reproduction for SEC-SEC-1 (leak on old `.dockerignore`, excluded
  on new).

Classification of the broad suites: the only failures observed
(`database-transport`/`terminal-ownership` `socket hang up`, `redact` timing)
are **environmental** (a loaded laptop, load average ~21), reproduced as
transient and green in isolation and under `--no-file-parallelism`; none is
caused by this branch. Not run here (needs live infra, unchanged by this branch):
`make beta-validate`, `verify:network-policy`, the kind/docker/sandboxd/terminal
integration jobs — CI runs them on a PR.

## 25. Private-beta security conclusion

Per property:

| Property | Status |
|---|---|
| Authentication fails closed in production | PROVEN BY TEST |
| Cross-student isolation (api, terminal, sandbox) | PROVEN BY TEST |
| Terminal WS auth / ownership / message bounds | PROVEN BY TEST |
| Shell output cannot exhaust a shared relay | PROVEN BY TEST (new) |
| Verifier is linear on hostile input; no injection | PROVEN BY TEST (new) + CODE |
| Container daemon boundary (net, ceilings, caps) | PROVEN BY TEST (new) + CODE |
| `service_http` no SSRF / no unbounded read | PROVEN BY TEST (new) |
| Verification & sandbox-write flooding bounded | PROVEN BY TEST (new) |
| Secrets out of images and git | PROVEN BY TEST (new) + build repro |
| Terminal content never logged | PROVEN BY TEST (new) |
| Secret boundaries / distribution | PROVEN BY TEST + CONFIG |
| Kubernetes RBAC / PSA / NetworkPolicy contract | PROVEN BY CODE/CONFIG (runtime by CI/kind) |
| Docker socket isolation / privileged DIND classified | PROVEN BY CODE; blast radius ACCEPTED |
| K8s node-level DoS quotas (PID/storage/count) | NOT PROVEN — DEFERRED to cluster owner |
| TLS edge security properties | PROVEN BY CODE/CONFIG; deployment REQUIRES PRODUCTION HOST |
| CI dependency/image scanning | NOT PRESENT — REQUIRES EXTERNAL DECISION |
| Who may sign in / per-student uid | REQUIRES EXTERNAL DECISION |

**Application security** and **sandbox isolation** are in good shape for the
stated ~5 trusted students; this pass closed the resource-exhaustion and
build-context gaps that remained. **Production-deployment** and **external-
infrastructure** security are unchanged and unproven here — they belong to the
production-host work and the §22 decisions. Unit and integration tests passing
proves the properties those tests exercise and nothing more. The overall verdict
for the trusted private beta stays **GO (conditional)**: the conditions are the
§22 deployment decisions, and a per-student shell uid is required before any
untrusted cohort.
