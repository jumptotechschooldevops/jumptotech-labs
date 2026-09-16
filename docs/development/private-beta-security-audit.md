# Private-beta security audit

**Branch** `feat/security-audit-post-beta`, worktree `~/jtt-security-audit`
**Audited commit** first pass against `origin/main` `0f33b1f` (merged PR #34);
branch rebased onto `origin/main` `9a0e22e` (merged PR #35, catalog quality
audit) and re-audited for what that merge added (§2)
**Date** 2026-09-16
**Audience** the deep security pass before a private beta of ~5 **trusted** students
**Verdict** the application-security and sandbox-isolation posture is sound for the
stated trusted cohort. Eleven defects were found and fixed, each reproduced first
and each with a regression test that fails against the previous code. None is a
break of an existing isolation, authentication or secret boundary; all eleven are
resource-exhaustion, input-handling or defence-in-depth gaps behind the controls
that do hold. The full register is §3. The private-beta gate in §28 is unchanged in its conclusion and its conditions:
deployment-time decisions (§25) and a per-student shell uid before any
**untrusted** cohort remain open, as the release gate already recorded.

This audit builds on, and does not repeat, the BETA-P0-010…P0-020 sequence, the
overnight hardening pass, and the production-host and browser-E2E passes. Where
a control was already proven, it is listed as verified, not rebuilt.

---

## 1. Scope

In scope, audited against `0f33b1f` and re-checked on `9a0e22e`:

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
catalog/curriculum validation (`feat/catalog-quality-audit`, merged to main as
PR #35 during this audit and reviewed here only for its security effect), student UX
(`feat/student-beta-experience`). `main` was not merged and no other branch was
modified.

Method: read the code; reproduce a suspected weakness with a probe or a failing
test before changing anything; fix narrowly; add a regression test; prove the
test fails against the previous code (a negative control or a mutation);
re-validate the touched suites. Three read-only sub-audits (verifier, Kubernetes,
CI/supply-chain) fanned out in parallel and their findings are folded in here.

## 2. Baseline and evidence levels

| | Commit |
|---|---|
| `origin/main` when the audit began | `0f33b1f` (merged PR #34) |
| `origin/main` at the re-check | `9a0e22e` (merged PR #35, catalog quality audit) |
| Merge-base of this branch | `9a0e22e` — the branch was rebased cleanly; the only shared files were `package.json` and `services/lab-orchestrator/src/index.ts`, both additive |

What PR #35 changed, for security: it added `validate:labs` to CI, which fails
the build on a symlink, a stray executable bit or an unreferenced file inside a
lab directory. Reading the loaders that rule protects found the one lab-content
gap in this audit (SEC-LAB-1, §14): the runtime did not enforce the same rule.

Every claim in this document carries one of these evidence levels:

| Level | Meaning |
|---|---|
| PROVEN BY CODE REVIEW | the implementation was read and traced; no test exercises it here |
| PROVEN BY TEST | a committed automated test exercises the boundary, and for every fix in this branch was shown to fail against the previous code |
| PROVEN LOCALLY | a probe or build on the audit machine (Docker Desktop, macOS) showed the behaviour |
| PROVEN IN CI | GitHub Actions ran it on this branch. **Nothing in this document is at this level yet:** workflows run on `pull_request` and on `main`, this branch has no PR, and no run exists for it |
| REQUIRES PRODUCTION DEPLOYMENT | only a real host can show it (firewall, DNS, certificates, alert delivery) |
| REQUIRES EXTERNAL CONFIGURATION | depends on an identity provider, CNI, or host setting outside the repository |
| NOT PROVEN | no evidence either way |

## 3. Findings register

Severity is for the attack as reachable today, with its stated preconditions,
not for the worst case in the abstract. Status vocabulary: FIXED, MITIGATED,
ACCEPTED ARCHITECTURAL RISK, EXTERNAL DEPLOYMENT REQUIREMENT, OPEN.

| ID | Title | Severity | Status | Actor | Evidence |
|---|---|---|---|---|---|
| SEC-EXH-1 | Unbounded shell-output buffering in terminal and sandboxd relays | HIGH | FIXED | B | TEST + LOCAL probe |
| SEC-ARCH-1 | Privileged Docker-in-Docker is not a hardened boundary | HIGH | ACCEPTED ARCHITECTURAL RISK (trusted beta only) | D/E | CODE |
| SEC-ARCH-2 | Shared shell uid 1001: a live shell can read another live session's credential | HIGH | ACCEPTED ARCHITECTURAL RISK (trusted beta only) | B/C | LOCAL (release gate) |
| SEC-EXH-2/3 | Quadratic line parsing of student-controlled text in the verifier | MEDIUM | FIXED | B/H | TEST + LOCAL |
| SEC-EXH-4 | Host networking and unbounded ceilings accepted at the container runtime boundary | MEDIUM | FIXED | E/J | TEST |
| SEC-EXH-5 | `service_http` followed redirects (SSRF from the api) and read unbounded bodies | MEDIUM | FIXED | B | TEST |
| SEC-EXH-6 | Unbounded concurrent verifications per session | MEDIUM | FIXED | B | TEST |
| SEC-EXH-7 | No request budget on Start/Reset | MEDIUM | FIXED | B | TEST |
| SEC-SEC-1 | Env files and credentials could enter Docker build contexts | MEDIUM | FIXED | J | TEST + LOCAL build |
| SEC-EXT-1 | Any account the OIDC issuer authenticates is admitted as STUDENT | MEDIUM | EXTERNAL DEPLOYMENT REQUIREMENT | F | CODE |
| SEC-EXT-2 | NetworkPolicy enforcement depends on the CNI; pod-to-node traffic is ungoverned | MEDIUM | EXTERNAL DEPLOYMENT REQUIREMENT | D | CODE/CONFIG; kind measurements in `docs/kubernetes-network-security.md` |
| SEC-K8S-1 | No PID / ephemeral-storage / object-count quota on the single K8s node | MEDIUM | OPEN (deferred to cluster owner) | B/D | CODE |
| SEC-CI-1 | No dependency or image scanning in CI; actions and images pinned by tag | MEDIUM | OPEN (deferred to CI owner) | I | CODE |
| SEC-LAB-1 | Lab asset loaders followed symlinks out of the lab directory | LOW | FIXED | H | TEST |
| SEC-API-1 | Refused request bodies answered 500, paged `ApiErrorRate`, and logged body text | LOW | FIXED | F | TEST + LOCAL probe |
| SEC-TEST-1 | Terminal content-logging privacy asserted only by a comment | LOW | FIXED | — | TEST |
| SEC-EXT-3 | Public edge (firewall, TLS, DNS) and human alert delivery unproven on a real host | LOW | EXTERNAL DEPLOYMENT REQUIREMENT | F | REQUIRES PRODUCTION DEPLOYMENT |
| SEC-K8S-2 | Student Role can write `endpoints`/`ingresses`; K8S-012 overlay subject binding | LOW | OPEN (inert today) | B | CODE |
| SEC-VER-1 | Verifier command allowlist admits dangerous flags; `as_user: root` allowed | LOW | OPEN (lab-author trust) | H | CODE |
| SEC-FS-1 | Credential tmpfs follows symlinks | LOW | OPEN (no demonstrated impact) | B | CODE |
| SEC-DB-1 | api connects as the database owner role | LOW | OPEN (deployment decision) | J | CODE |
| SEC-DEP-1 | Two moderate transitive `qs` advisories under express | LOW | OPEN (not reachable) | I | CODE + `npm audit` |
| SEC-HDR-1 | No CSP / X-Frame-Options on app HTML | INFO | OPEN | F | CODE |
| SEC-K8S-3 | Missing-CA cluster endpoint falls back to `insecureSkipTlsVerify` (kind-only path) | INFO | OPEN | J | CODE |
| SEC-AUTHZ-1 | `studentIdForUser` folding could merge provider-shaped ids | INFO | OPEN (unreachable today) | C | CODE |
| SEC-OPS-1 | `MAX_ACTIVE_SESSIONS` default 20 vs beta cohort 5 | INFO | OPEN (operator check) | J | CODE |
| SEC-LAB-2 | A Docker-lab setup container may use `network: host` — the session's own DinD namespace | INFO | ACCEPTED ARCHITECTURAL RISK (inside the sandbox) | H | CODE |

Totals: **CRITICAL 0 · HIGH 3 · MEDIUM 10 · LOW 9 · INFO 5.** Of the three HIGH,
one is fixed and two are the architectural risks the release gate already
accepted for a trusted cohort only.

## 4. Architecture reviewed

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

## 5. Threat model

Actors use the audit brief's lettering.

| Actor | Who | Realistic goal | Principal controls | Residual |
|---|---|---|---|---|
| A | normal authenticated student | do the lab | — | noisy-neighbour load (bounded, SEC-EXH-*) |
| B | malicious authenticated student | exhaust shared services; abuse the verifier | per-student session limit, Start/Reset budget, check single-flight, output backpressure, linear parsers, container ceilings | K8s node PIDs/storage (SEC-K8S-1) |
| C | student targeting another student | read/drive another session, workspace, progress | `sessionGuard` owner check + 404, token bound to `{sid, uid}` and re-checked, server-derived `studentId` | shared uid 1001 (SEC-ARCH-2) |
| D | compromised student sandbox | reach platform services or other sandboxes | `--network none` default, cap-drop ALL, no-new-privileges, non-root, default-deny NetworkPolicy, namespaced Role | CNI dependence, pod-to-node (SEC-EXT-2) |
| E | compromised DinD sandbox | escape to the host | the inner container boundary only | privileged DinD (SEC-ARCH-1) |
| F | unauthenticated public attacker | reach internal services; sign in | only 443/80 published; OIDC with sig/iss/aud/exp; production fail-closed; body refusals are 4xx (SEC-API-1) | who may sign in (SEC-EXT-1); edge unproven on a host (SEC-EXT-3) |
| G | stolen / replayed token | act as the victim | HttpOnly hashed session cookie; terminal token short-lived, HMAC, owner-bound; one auth frame per WS | replay within token lifetime by the thief (inherent to bearer tokens) |
| H | malicious or malformed lab definition | host paths, privilege, host reads, verifier abuse | strict closed schema, kind allowlist + PSA check on manifests, argv-only exec, realpath-confined assets (SEC-LAB-1), `validate:labs` in CI | lab-author trust (SEC-VER-1) |
| I | compromised dependency / supply chain | code execution in build or runtime | lockfile + `npm ci`, CodeQL, least-privilege workflow tokens, no `pull_request_target` | no scanning/pinning (SEC-CI-1) |
| J | operator mistake | weaken a boundary by configuration | production refuses dev auth, plaintext transports, weak/shared secrets, host network, zero ceilings; secrets excluded from images | DB owner role (SEC-DB-1); session cap default (SEC-OPS-1) |

**Assets.** Student identities and browser sessions; lab sessions and their
sandboxes; per-session credentials (kubeconfig, Docker client key); student
workspaces; progress history; platform secrets (`TERMINAL_SESSION_SECRET`,
`INTERNAL_SERVICE_SECRET`, sandboxd scope secrets, `OIDC_CLIENT_SECRET`,
database password, TLS key, metrics scrape token); the Docker socket; the kind
node; database backups.

**Privileged components.** sandboxd (Docker socket — host root equivalent);
the DinD sandbox containers (`--privileged`); the terminal process before it
drops to uid 1001; the kind node; the api's cluster credential.

**Persistent data.** PostgreSQL (users, auth sessions, lab sessions, progress),
its backups, Docker volumes per session, Prometheus/Loki data.

**Host-level resources.** Docker daemon capacity (containers, networks,
volumes), CPU/memory/PIDs, disk under Docker and the kind node, etcd.

**Attack surface map.**

| Surface | Reachable by | Authn | Authz |
|---|---|---|---|
| `web` 443 (static SPA, reverse proxy) | F | none | — |
| `/auth/*` (OIDC login/callback/logout) | F | state+nonce+PKCE | — |
| `/api/labs`, `/api/tracks`, catalog reads | A–C | cookie/bearer | none needed (public catalog) |
| `/api/labs/:id/start`, `/api/sessions/:id/*` | A–C | cookie/bearer + origin guard | owner check, 404 |
| `/api/me/*` (progress, learning paths) | A–C | cookie/bearer | server-derived student id |
| terminal WebSocket (via nginx) | A–C, G | one auth frame, terminal token | token `{sid, uid}` re-checked against live row |
| `/internal/*` on api | terminal only | `INTERNAL_SERVICE_SECRET` | ownership re-proven |
| sandboxd 4002 | terminal, api | per-scope secret | attach derives container from session id |
| student shell | B–E | inside the sandbox | container / namespace boundary |
| verifier input (sandbox output, student files, Service responses) | B, D | — | runs in api process: must be linear and bounded |
| lab definitions | H | repository review + CI | schema |
| CI workflows | I | GitHub | `contents: read` |

## 6. Trust boundaries

1. browser ↔ api — cookie/bearer, origin guard, CORS allow-list.
2. api ↔ terminal — `INTERNAL_SERVICE_SECRET`, constant-time, `/internal` off CORS.
3. terminal ↔ sandboxd — per-scope secret; attach derives the target itself.
4. sandboxd ↔ Docker socket — the one privileged hop; argv-only; ownership labels.
5. student shell ↔ everything — uid 1001 in a capability-dropped container.
6. api ↔ postgres — parameterized SQL, internal network, TLS gate off-bridge.
7. build host ↔ image — `.dockerignore` (widened here).

## 7. Authentication findings

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

No authentication defect found. The one open item is **who may sign in** (SEC-EXT-1) — any
account the issuer authenticates is provisioned STUDENT — which is a deployment
decision (§25), already recorded in `docs/authentication.md` §4.7.

## 8. Authorization findings

**Verified sound (no change):** every session route goes through `sessionGuard`,
which resolves the row and proves `ownerUserId === req.user.userId` in one step;
`GET /api/sessions` filters to the caller's own owner id and takes no parameter;
`/api/me/*` scopes every read to a server-derived `studentId` and the progress
repository filters every query by `student_id` (parameterized). `/internal`
credential and activity exchanges re-prove ownership against the live row even
with a valid HMAC. Cross-user reads/writes/resets/ends/attaches are denied and
answered 404, proven with two distinct users in `authorization.test.ts` and
`oidc-ownership-e2e.test.ts`. Namespaces and sandbox refs are never inputs.

SEC-AUTHZ-1 — INFORMATIONAL: `studentIdForUser` folds provider-shaped user ids to
`[a-z0-9._-]`, so two ids differing only in excluded characters could collapse
to one progress history. Not reachable today — ids are internal `usr-NNNNNNNN`
UUIDs — recorded for a future provider-shaped id.

No authorization defect found.

## 9. Terminal findings — SEC-EXH-1 (FIXED)

See the full finding block in §23. Summary: the PTY→WebSocket relay in the
terminal service, and the same relay in sandboxd, queued unread output in
process memory without bound; a client that stops reading while its shell runs
`yes` grows a shared service until it is OOM-killed, taking every other
student's shell with it. Fixed with output backpressure. Everything else in the
terminal path (WS auth, origin allow-list, one-auth-frame, argv-only spawn,
frame/input caps, idle/max timers, credential cleanup) was verified sound and is
unchanged.

## 10. Workspace / filesystem findings

**Verified sound (no change):** `resolveWorkspaceFile` rejects absolute paths,
`..`, backslashes; the overnight pass added `realpath` containment on read and
`O_NOFOLLOW` + resolved-parent on write, closing the student-planted-symlink
redirect (0881d19, confirmed present on `0f33b1f`). Per-session directories are
HMAC-named under a `0711` root. Verifier sandbox paths go through
`isSafeSandboxPath` (NUL/`..`/`~`/backslash refused, per-segment charset) and
argv is passed after `--`.

Lab *assets* (starter files, seed scripts, manifests) are a separate path —
platform content read by the api, not student files — and had their own
symlink gap, fixed as SEC-LAB-1 (§14).

SEC-FS-1 — DEFERRED (no demonstrated impact, listed by the overnight pass): the credential
tmpfs (`/run/jumptotech`) still follows symlinks; the target is uid-1001's own
credential, and redirecting another session needs an id nothing discloses.
`O_NOFOLLOW` there is cheap hardening, left as an operator decision.

## 11. Docker sandbox findings

**Verified sound:** only sandboxd mounts the socket; api/terminal/web/observability
never do; no `chmod 666` workaround. Sandbox containers run `--cap-drop ALL`
plus a closed grant-list (host-reaching caps absent), `no-new-privileges`,
non-root, no host mount, `--memory`/`--memory-swap`/`--cpus`/`--pids-limit`
ceilings, `--network none` by default. The runtime scope re-applies ownership
labels and scopes every list/inspect/remove to `runtimeOwner`.

FIXED (SEC-EXH-4, §23): `network`, `pidsLimit`, `memory`, `cpus` reached
`docker run` unvalidated; `--network host`, `--network container:<other>` and
`--pids-limit 0`/`--memory 0` (Docker reads 0 as unlimited) were expressible by
a runtime-scope holder or an operator typo. Now refused at the daemon boundary.

SEC-ARCH-1 — ACCEPTED FOR TRUSTED BETA: **privileged Docker-in-Docker is not a hardened
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

## 12. Kubernetes sandbox findings

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

- **SEC-K8S-1 — DEFERRED, MEDIUM (DoS):** no `podPidsLimit` on the single kind node; the
  quota bounds CPU/memory/PVC-count but not PIDs, ephemeral storage, or object
  counts (`count/secrets` etc.), so a fork bomb, an `emptyDir` fill, or ~1,400
  Secrets could pressure the shared node or etcd. Bounded blast radius on a
  single-node trusted beta; a real fix is kubelet + quota config on the cluster.
- **SEC-K8S-2 — DEFERRED, LOW:** the student Role can write `endpoints` and `ingresses`
  (CVE-2021-25740 shape) — inert with no ingress controller installed; and can
  bind its own Role to arbitrary `subjects` in the K8S-012 overlay (exposes only
  the student's own namespace).
- **SEC-EXT-2 — EXTERNAL DEPLOYMENT REQUIREMENT:** the NetworkPolicy objects are
  configuration; whether they are *enforced* depends on the CNI. Enforcement was
  measured on kind (`docs/kubernetes-network-security.md`), not on a production
  substrate, and pod-to-node traffic (kubelet :10250, cloud IMDS) is not governed
  by NetworkPolicy at all — decision D3, already open.
- **SEC-K8S-3 — INFO:** `restricted` is deliberately not enforced (K8S-001 `kubectl run`);
  a missing-CA cluster endpoint falls back to `insecureSkipTlsVerify`
  (`k8s/client.ts:1106,1120`) — kind-only path.

## 13. Verifier findings

The verifier runs on the API's event loop (no worker thread), so any CPU blow-up
in it stalls every student's API. All exec is `execFile`, `shell:false`, with
timeout and `maxBuffer`, gated by allowlists; no lab-supplied regex anywhere;
student YAML parsed with `yaml` (alias/merge-key bomb off); the only interpolated
`sh -c` is the operator-only network probe with a validated host. **Verified
sound.**

FIXED (SEC-EXH-2/3, §23): four parsers ended a line pattern with `(.+?)\s*$`,
quadratic on a long whitespace run the student controls (a 100 KiB `ps` line,
built from the student's own process arguments, took 15.5 s; CI/pipeline files
~5 s per 60 KiB). Replaced with linear parsers.

SEC-VER-1 — DEFERRED (lab-author trust, from the sub-audit; see also §14): the read-only verifier command
allowlist admits arguments like `find / -delete` or `awk -f <student script>`
(charset blocks metacharacters but not dangerous flags), and `as_user: root` is
allowed — a careless or malicious lab author, not a student, and confined to one
session container. Recommend a per-command flag policy; left to the catalog/lab
owner.

## 14. Lab-definition findings

**Trust model.** Lab definitions are **semi-trusted repository content**: they
arrive by pull request, are reviewed by a person, and `validate:labs` gates
them in CI (merged in PR #35). A lab author is not a student, but a lab must
not be able to do more than the schema says, so an accidentally dangerous or
malicious definition is refused rather than trusted.

**Verified sound (PROVEN BY CODE REVIEW + existing tests):**
- Every schema object is `.strict()`; unknown keys are errors
  (`services/lab-orchestrator/src/lab-definition.ts`).
- Privilege is not expressible: `environment.network` is the closed enum
  `none|link`; `capabilities` is the closed `LAB_CAPABILITIES` list (max 4);
  `sandbox_capabilities` is `['NET_RAW']` only, provider- and network-gated.
  No field names a host path, `privileged`, a device, host PID/IPC, or a
  seccomp/AppArmor profile.
- No command string anywhere: seed scripts are files in the lab directory with a
  `#!` line and a size cap, run inside the session's own container; verifier
  commands are argv drawn from an allowlist with a metacharacter-free charset.
- Kubernetes setup manifests: kind allowlist, namespace forced, PSA baseline
  violations (hostPath, hostNetwork/PID/IPC, privileged, added caps) refused at
  load (`session/manifests.ts`, `pod-security.ts`).
- Docker-track setup (`docker/setup.ts`) is structured: images match a
  reference pattern, volumes are *named* volumes only (the name regex has no
  `/`, so no bind mount), argv elements reject control characters, and it is
  applied through the session's **own inner daemon** (`docker exec <sandbox>
  docker …`). sandboxd forces `privileged: false` on every setup container
  whatever arrives (`services/sandboxd/src/docker-ops.ts`). Published ports bind
  inside that sandbox's network namespace, not the host's.
- Starter-file destinations: relative, no `..`, no `~`, execute bits stripped,
  64 KiB cap, 20 files (1 workspace directory expands under the same rules).
- Counts are bounded (≤20 requirements, ≤10 manifests/seed scripts,
  `verify_timeout_seconds` ≤600).

**FIXED — SEC-LAB-1 (LOW):** the asset loaders confined a declared path
*lexically* (`path.resolve` + `startsWith`) and then called `readFile`, which
follows symlinks. A symlink in a lab directory (`setup/notes.txt -> /…`), a
symlinked parent directory, or a symlinked `workspace_dir` passed the check, and
the api process's view of the target was seeded into a student's sandbox (or
applied as a manifest). The code comments claimed the re-check caught symlinks.
Precondition: a lab author commits a symlink and review misses it — CI now
refuses that since PR #35, which is why this is LOW and why the fix is defence
in depth. Full block in §23.

**INFO — SEC-LAB-2:** a Docker-lab setup container may declare `network: host`
(the name pattern admits it). On the inner daemon that is the DinD sandbox's
own namespace, already the student's; no host network is reachable. Accepted.

**OPEN — SEC-VER-1 (LOW):** the verifier command allowlist constrains the
program and charset but not flags (`find -delete`, `awk -f`), and `as_user: root`
is allowed. Confined to one session container; a per-command flag policy is left
to the catalog owner.

## 15. API findings

**Verified sound:** 16 KB JSON body cap; no `x-powered-by`; central error handler
never leaks a stack; `trust proxy` is exactly one hop; malformed ids are 400 not
500; unknown routes 404. FIXED here: per-session single-flight on `check`
(SEC-EXH-6) and a per-student Start/Reset budget (SEC-EXH-7). General per-route
rate limiting beyond these and the learning-path routes remains a documented
limitation, acceptable for a 5-student trusted beta behind authentication and
the origin guard.

FIXED here: **SEC-API-1 (LOW).** `express.json` runs before authentication, and
the bodies it refused (malformed JSON, over 16 KiB, unsupported encoding) fell
through to the central handler as **500 INTERNAL_ERROR**. Probed on the
composed app: the response was 500, the line was logged at `error` with the
parser's message — which quotes part of the body — and the request counted as a
5xx, the series `ApiErrorRate` (>2%) alerts on. An unauthenticated client could
page the operator and write chosen text into error logs; with a 5-student
cohort, a handful of requests is enough to cross 2%. Now 400 `INVALID_JSON` /
413 `PAYLOAD_TOO_LARGE` / 415 `UNSUPPORTED_BODY`, matched on body-parser's
`type`, with fixed messages. Only two routes read a body at all — the
`/internal` credential exchange (`ownerUserId`, re-proven against the live row)
and the hint route (`level`, checked by `assertValidHintIndex`) — both read as `unknown` and validated;
every other route ignores the body, so unexpected fields have no effect. CORS is
an allow-list; unknown routes are 404.

## 16. Database findings

**Verified sound:** every query is parameterized (`$1`…); the one place a
fragment is built (`session/postgres-store.ts` SET clause) draws column names
from a fixed map, never from input; TLS transport gate refuses plaintext to a
non-loopback host in production and refuses `ssl*` params in `DATABASE_URL`;
postgres is alone with the api on an `internal: true` network; backups are
excluded from images and observability. No SQL-injection or exposure defect.

SEC-DB-1 — INFORMATIONAL / DEFERRED: the api connects as the database owner role
(`POSTGRES_USER`), not a least-privilege application role. Acceptable for the
beta; a dedicated role with table-scoped grants is a hardening item and a
deployment/migration decision, not made here.

## 17. Secrets findings

**Verified sound:** no real credential is tracked (sub-audit swept `git ls-files`;
every hit is a test fixture, an AWS `…EXAMPLE` key, or a placeholder); every
credential directory carries a deny-all `.gitignore`; production refuses
placeholder/short/low-entropy/shared/cross-service secrets; the web bundle
carries none; the terminal drops uid so its `/proc` closes to shells.

FIXED (SEC-SEC-1, §23): `.dockerignore` excluded only the TLS dir, and every
image copies whole service directories — a `.env` dropped in `apps/api/` shipped
in the image (reproduced with a real build; blocked after the fix). `.dockerignore`
now excludes `.git`, `**/.env`, `**/.env.*`, the kubeconfig and observability
secret dirs, and `backups/`; `.gitignore` gains `.env.*` (keeping `.env.example`).

ACCEPTED (SEC-ARCH-2): shared uid-1001 lets one live shell read another live session's
per-session kubeconfig / Docker key from the tmpfs — trusted-beta only.

## 18. TLS findings

**Verified sound in code/config** (deployment proof belongs to the production-host
branch): nginx serves TLSv1.2+1.3 only, HSTS, `server_tokens off`, port-80 →
301 + ACME only, `ssl_reject_handshake` default server; the web TLS key is
excluded from git, every build context, every Dockerfile `COPY` and the bundle
(`tls-edge-contract.test.ts`, extended here); the terminal WS is proxied over
TLS with a fail-closed preflight. `X-Forwarded-Proto`/`Host` are not trusted for
redirects — callbacks are built from `PUBLIC_ORIGIN` only.

SEC-HDR-1 — INFORMATIONAL: no Content-Security-Policy / X-Frame-Options header is set on the
app HTML. Low value for a 5-student trusted beta on a single SPA origin; noted
as hardening.

## 19. CI/CD and supply-chain findings

From the sub-audit (`npm audit` was the only network call). No CRITICAL/HIGH.

- **SEC-CI-1 — DEFERRED, MEDIUM:** no Dependabot *update* configuration (`.github/dependabot.yml`
  is absent), no `npm audit` in CI, no image scanning;
  GitHub Actions pinned by tag not SHA (and codeql uses `checkout@v7` while the
  rest use `@v4`); base images and `docker:27-dind` are floating tags; CI/Dockerfile
  binary downloads (kubectl, docker CLI, compose, terraform) are version-pinned
  but not checksum-verified.
- **SEC-DEP-1 — LOW:** 2 moderate transitive `qs` advisories under `express@4.22.2` —
  vulnerable version present but **not reachable** (express calls `qs.parse`
  without `comma:true`, and the app mounts only `express.json`); a `qs` bump
  needs an express release that moves its `~6.15.1` range. vitest moderate is
  dev-only. GitHub's Dependabot *alerts* are on for the repository and agree:
  on 2026-09-16 they listed 13 open, all medium — `qs` ×2 (runtime), `vitest`
  ×10 and `@vitest/mocker` ×1 (development).
- **Verified sound:** top-level `permissions: contents: read` on quality-gates;
  codeql declares its own per-job permissions; no `pull_request_target`; no
  `${{ github.event.* }}` interpolation in `run:`; `npm ci` everywhere; the
  secret-distribution and no-committed-backup gates run in CI.

CI workflows were **not modified** — the improvements above are recommendations,
and the mission says to change workflows only for a clear, testable win; pinning
and scanning are best landed by the owner with Dependabot to maintain them.

## 20. Resource-exhaustion findings

The heart of this pass. Six exhaustion vectors found and fixed: SEC-EXH-1
(terminal/sandboxd output flood), SEC-EXH-2/3 (verifier quadratic parsers),
SEC-EXH-4 (unbounded container ceilings / host net), SEC-EXH-6 (check flooding),
SEC-EXH-7 (Start/Reset flooding). Full blocks in §23. The Kubernetes node-level
exhaustion gaps (PIDs, storage, object counts) are §12, deferred to the cluster
owner.

## 21. Logging / privacy findings

**Verified sound and now proven by test (SEC-TEST-1, §23):** terminal input and
output, refused frames and the session token appear in no log line of the api,
terminal or sandboxd — the property the terminal server's own comment claimed a
test enforced, which did not exist until now. Redaction covers Authorization,
cookies, JWTs, connection strings; errors are logged without stacks; the remote
address and attacker-chosen origin are kept out of log *fields*. No student
command logging was introduced. A refused request body no longer reaches an
error log line (SEC-API-1).

## 22. Security tests added

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
| SEC-LAB-1 | `services/lab-orchestrator/test/lab-asset-symlink.test.ts` (6) | file, parent-directory, `workspace_dir`, seed-script and manifest symlinks out of the lab are refused; regular files still load |
| SEC-API-1 | `apps/api/test/request-body-errors.test.ts` (4) | malformed / oversized / wrongly-encoded bodies are 400/413/415, no 5xx counted, no error line, no body text logged |

All are wired into `npm run test:security` (§27).

**The brief's suggested hostile-input tests, mapped to what exists.** None was
added as a duplicate of a test that already exercises the real boundary.

| Suggested | Implemented by | Level |
|---|---|---|
| SEC-001 cross-student session access denied | `apps/api/test/authorization.test.ts`, `oidc-ownership-e2e.test.ts` | TEST |
| SEC-002 cross-student terminal credential denied | `apps/api/test/terminal-ownership.test.ts` ("refuses Bob's own valid token pointed at Alice's session"), `services/terminal/test/terminal-ownership.test.ts` | TEST |
| SEC-003 cross-student verification denied | `authorization.test.ts` ("does not let a check by one student decide another's result"), `check-concurrency.test.ts` (404 before 409) | TEST |
| SEC-004 cross-student progress access denied | `apps/api/test/learning-paths-api.test.ts` ("never shows one student another's progress"), `progress-api.test.ts` | TEST |
| SEC-005 workspace traversal rejected | `services/terminal/test/workspace.test.ts`, `workspace-endpoints.test.ts` | TEST |
| SEC-006 symlink workspace escape rejected | `workspace-endpoints.test.ts` ("refuses to follow a symlink a student planted"); lab assets: `lab-asset-symlink.test.ts` (new) | TEST |
| SEC-007 malformed lab definition rejected | `services/lab-orchestrator/test/lab-definition.test.ts`, `docker-lab-definition.test.ts`, `catalog-validation.test.ts`, `pod-security.test.ts` | TEST |
| SEC-008 oversized / unbounded input rejected | `services/terminal/test/protocol.test.ts` (frame and input caps), `output-backpressure.test.ts`, `line-value.test.ts`, `request-body-errors.test.ts` (new) | TEST |
| SEC-009 production auth bypass unavailable | `apps/api/test/production-oidc-config.test.ts`, `authentication.test.ts` | TEST |
| SEC-010 sensitive values absent from error/log paths | `apps/api/test/log-redaction.test.ts`, `terminal-content-logging.test.ts`, `request-body-errors.test.ts` (new) | TEST |

## 23. Findings fixed

### SEC-EXH-1 — unbounded shell-output buffering in the terminal and sandboxd relays
- **SEVERITY** HIGH · **STATUS** FIXED · **COMPONENT** `services/terminal/src/server.ts`, `services/sandboxd/src/server.ts`, `services/lab-orchestrator/src/output-flow.ts`
- **ATTACK** (actor B) a student runs `yes` (or `cat /dev/zero`) and a client
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
- **ATTACK** (actor B, and H for the CI files) four parsers ended their line pattern with `(.+?)\s*$`,
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
- **ATTACK** (actor E/J) sandboxd forwards the runtime scope's `ContainerSpec`
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
- **ATTACK** (actor B) the check fetched the student's Service (whose Endpoints
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
- **ATTACK** (actor B) a Check runs a lab's whole requirement list against the
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

### SEC-LAB-1 — lab asset loaders followed symlinks out of the lab directory
- **SEVERITY** LOW · **STATUS** FIXED · **COMPONENT** `services/lab-orchestrator/src/lab-definition.ts` (`resolveLabAssetForRead`), `session/{setup-files,seed-scripts,manifests}.ts`
- **ATTACK** (actor H) a lab directory contains a symlink — a starter file, a
  seed script, a manifest, a parent directory, or `workspace_dir` itself —
  pointing outside the lab. The loaders confined the path with
  `path.resolve` + `startsWith` (lexical) and read it with `readFile` (follows
  links), so the api process's view of the target was seeded into the student's
  sandbox or applied into their namespace.
- **PRECONDITION** a lab author commits the symlink and review misses it. Since
  PR #35 `validate:labs` fails CI on any symlink in a lab directory, so the
  reachable path is an image built from a tree that did not pass CI.
- **EVIDENCE** five hermetic cases (file, parent directory, `workspace_dir`,
  seed script, manifest) load the outside file with the previous code; the
  existing comments claimed the re-check caught symlinks.
- **FIX** compare `realpath` of the asset with `realpath` of the lab directory
  before every read. The check-to-read window is not student-reachable: lab
  directories are image content.
- **TEST** `lab-asset-symlink.test.ts` (6); 5 fail against the previous loaders
  (negative control), the regular-file case passes on both.
- **RESIDUAL** none for students; lab authors remain semi-trusted (SEC-VER-1).

### SEC-API-1 — refused request bodies were answered 500 and logged at error level
- **SEVERITY** LOW · **STATUS** FIXED · **COMPONENT** `apps/api/src/app.ts`
- **ATTACK** (actor F, no credentials needed) POST malformed JSON, a >16 KiB
  body, or an unknown `Content-Encoding` to any API path.
- **EVIDENCE** probe on the composed app before the fix: HTTP 500
  `INTERNAL_ERROR`; one `level:error` `http.request.failed` line whose `err.message`
  quoted the body (`…"is not valid JSON"`); the request counted in
  `status_class="5xx"`, which `ApiErrorRate` pages on above 2%.
- **IMPACT** operator paging and alert fatigue that can mask a real incident;
  attacker-chosen text in error logs. No data exposure, no stack in the response.
- **FIX** map body-parser's documented error `type`s to 400 `INVALID_JSON`,
  413 `PAYLOAD_TOO_LARGE`, 415 `UNSUPPORTED_BODY`, 400 `INVALID_BODY`, with fixed
  messages; the request is still logged as a 4xx by the HTTP middleware.
- **TEST** `request-body-errors.test.ts` (4); 3 fail against the previous handler.
- **RESIDUAL** 4xx volume is not alerted on, by design; a flood is an edge
  rate-limit concern (SEC-EXT-3).

## 24. Deferred findings

Status OPEN, each with an owner; none is a demonstrated break of a boundary.

- **SEC-K8S-1** node exhaustion (§12): `podPidsLimit`, ephemeral-storage bounds,
  `count/*` quotas — owner: Kubernetes/cluster; bounded blast radius on a
  single-node trusted beta.
- **SEC-K8S-2** Role `endpoints`/`ingresses` write and K8S-012 subject binding
  (§12) — owner: Kubernetes; inert or self-scoped today.
- **SEC-VER-1** verifier command-allowlist flags and `as_user: root` (§13, §14) —
  owner: catalog/lab; lab-author trust.
- **SEC-FS-1** credential tmpfs `O_NOFOLLOW` (§10) — hardening, no demonstrated impact.
- **SEC-DB-1** least-privilege database role (§16) — deployment/migration decision.
- **SEC-HDR-1** CSP / security headers on app HTML (§18) — hardening.
- **SEC-CI-1** Dependabot, `npm audit`, image scanning, SHA-pinned actions/images,
  checksum-verified downloads (§19) — owner decision; not a testable in-repo
  win this pass should slip in.
- **SEC-DEP-1** `qs` moderate advisories (§19) — wait for an express release.
- **SEC-K8S-3**, **SEC-AUTHZ-1**, **SEC-OPS-1** — informational (§12, §8, §5).

## 25. External / deployment decisions

Unchanged from release-gate §7 and the production-host pass, and none is a
software defect: hosting and host sizing; Kubernetes substrate and a CNI with
proven NetworkPolicy enforcement; hostname/DNS/CA; **OIDC provider and the
allowed user population** (any authenticated account is admitted STUDENT today);
operator access path; off-host backup + a real restore drill; alert delivery;
attestation cadence and retention; **a per-student shell uid before any
untrusted cohort** (the shared-uid credential read, SEC-ARCH-2). Node-local traffic
(kubelet/IMDS) control is decision D3.

## 26. Residual risks accepted for the trusted 5-student beta

Acceptable **only** because the cohort is about five people the operator knows,
who have agreed to use the platform in good faith, on a single host the operator
controls. None of these is acceptable for anonymous or untrusted users.

1. **Shared uid 1001 (SEC-ARCH-2).** One live shell can read another live
   session's per-session credential. Confirmed live by the release gate.
2. **Privileged DinD (SEC-ARCH-1).** Student isolation, not a hardened boundary
   against a determined container escape to the host kernel.
3. **Operator trust.** The operator holds the Docker socket, every platform
   secret and the database; nothing in the repository constrains an operator.
4. **Who may sign in (SEC-EXT-1).** Any account the OIDC issuer authenticates is
   admitted as STUDENT; the issuer (or its application assignment) must be
   restricted to the cohort. The repository does not own an allowlist.
5. **Production edge not proven on a host (SEC-EXT-3).** Firewall, published
   ports, DNS, certificates and HTTP→HTTPS are proven in configuration and
   tests, not against a real deployment.
6. **Human alert delivery not proven (SEC-EXT-3).** Alert rules exist and are
   tested; that a person receives them is not shown.
7. **K8s node quotas (SEC-K8S-1)** and **CNI enforcement / pod-to-node
   (SEC-EXT-2).**
8. General API rate limiting covers only sandbox writes and learning paths.
9. No CI dependency/image scanning (SEC-CI-1).

**Blocks untrusted or public students** (in addition to everything above being
re-decided): a per-student shell uid (SEC-ARCH-2); a VM- or kernel-isolated
sandbox instead of privileged DinD (SEC-ARCH-1); an enforced sign-in allowlist
or registration policy (SEC-EXT-1); node-level PID/storage/object quotas
(SEC-K8S-1); a CNI with proven enforcement and node-traffic control (SEC-EXT-2);
edge rate limiting and abuse controls; supply-chain scanning and pinning
(SEC-CI-1); real-host evidence for the edge and alerting (SEC-EXT-3).

## 27. Evidence

All results below are **PROVEN LOCALLY** on the audit machine (macOS, Docker
Desktop, heavily loaded — load average 17–29). **None is PROVEN IN CI**: the
workflows run on `pull_request` and `main`, and this branch has no PR.

Final run, on the committed tree at `54b9713` (rebased on `9a0e22e`):

| Command | Result |
|---|---|
| `npm run validate:labs` | exit 0 — 117 labs from 117 `lab.yaml`, 0 errors, 0 warnings |
| `npm run typecheck` | exit 0, every workspace |
| `npm run build` | exit 0, every workspace |
| `npm run test:security` | exit 0 — **47 files, 794 tests, 0 failed** (api chunk `--no-file-parallelism`) |
| `npm test` | exit 0 — api 596 passed / 15 skipped; web 195; lab-orchestrator 1331 / 253 skipped; observability 707 / 36; progress 96 / 1; sandboxd 138 / 7; terminal 156 / 20; verifier 1569 |
| `npm run lint` | **does not exist** — no `lint` script in the root or any workspace; not invented |
| `git diff --check` | clean |

Skipped tests are the opt-in integration suites (`RUN_INTEGRATION_TESTS=1`,
live kind/Docker/sandboxd), unchanged by this branch. Not run here, needing
live infrastructure: `make beta-validate`, `verify:network-policy`, the
kind/docker/sandboxd/terminal integration jobs — CI runs them on a PR.

Negative controls (the new test fails against the previous code): SEC-EXH-1,
SEC-EXH-4, SEC-EXH-5, SEC-EXH-6, SEC-SEC-1, SEC-LAB-1 (5 of 6 fail), SEC-API-1
(3 of 4 fail). Mutations: SEC-EXH-5, SEC-TEST-1. Local probes: SEC-EXH-1
(127 MiB queued for 128 MiB emitted), SEC-EXH-2/3 (15.5 s parse in the real
`lab-linux` image), SEC-SEC-1 (real image build), SEC-API-1 (error line quoting
the body).

Earlier in the audit, under the same load, the api suite's supertest listeners
flaked `socket hang up` when files ran in parallel, and one observability
redactor timing test flaked; both passed in isolation and neither failed in the
final run. That is why the api chunk of `test:security` runs
`--no-file-parallelism`.

Secret scan (`git ls-files`, and the files PR #35 added): no tracked `.env`,
private key, kubeconfig or credential-shaped value; values were never printed.

## 28. Private-beta security conclusion

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
| Lab assets confined to the lab directory, symlinks included | PROVEN BY TEST (new) |
| Refused request bodies are 4xx, unlogged, not paged | PROVEN BY TEST (new) |
| Any of the above in CI | NOT PROVEN — branch has no PR; CI has not run it |
| Secret boundaries / distribution | PROVEN BY TEST + CONFIG |
| Kubernetes RBAC / PSA / NetworkPolicy contract | PROVEN BY CODE/CONFIG; enforcement REQUIRES EXTERNAL CONFIGURATION (CNI) |
| Docker socket isolation / privileged DIND classified | PROVEN BY CODE; blast radius ACCEPTED |
| K8s node-level DoS quotas (PID/storage/count) | NOT PROVEN — DEFERRED to cluster owner |
| TLS edge security properties | PROVEN BY CODE/CONFIG; deployment REQUIRES PRODUCTION DEPLOYMENT |
| Human alert delivery | REQUIRES PRODUCTION DEPLOYMENT |
| CI dependency/image scanning | NOT PRESENT — REQUIRES EXTERNAL DECISION |
| Who may sign in | REQUIRES EXTERNAL CONFIGURATION (IdP) |
| Per-student shell uid | NOT PRESENT — required before untrusted users |

**Application security** and **sandbox isolation** are in good shape for the
stated ~5 trusted students; this pass closed the resource-exhaustion,
build-context, lab-asset and body-refusal gaps that remained. **Production-deployment** and **external-
infrastructure** security are unchanged and unproven here — they belong to the
production-host work and the §25 decisions. Unit and integration tests passing
proves the properties those tests exercise and nothing more. The overall verdict
for the trusted private beta stays **GO (conditional)**: the conditions are the
§25 deployment decisions, and a per-student shell uid is required before any
untrusted cohort.
