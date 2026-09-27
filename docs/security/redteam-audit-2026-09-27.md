# Security red-team audit — 2026-09-27

A long autonomous pass over the production security boundary, run after
PR #58 (code health), #60 (network probe port range) and #61 (no shell in the
NetworkPolicy TCP probe). The `runSandboxScript` / `script_runs` / symlink
TOCTOU investigation was owned by a concurrent session and is out of scope
here.

Method per candidate: trace the attacker-controlled input from source to sink,
name the trust boundary, prove exploitability (live where it mattered), then a
regression test and the smallest fix. Nothing here claims the platform is
secure; it records what was examined and what was found.

Live proofs used a dedicated throwaway kind v1.34 cluster
(`jtt-rt20h-quota`), never the shared `jumptotech-labs` cluster.

## Confirmed findings

| # | Severity | Finding | Boundary | Proof | Action |
|---|---|---|---|---|---|
| F1 | MEDIUM | Session ResourceQuota had no object counts; a Kubernetes student could create unlimited ~1 MiB ConfigMaps/Secrets and fill etcd for the whole cluster; Reset's purge lists them unpaginated | student namespace → shared control plane | main quota: 60 × 1 MiB ConfigMaps created as the student SA; fixed quota: 50th object is the last, then `exceeded quota` | PR #86 (merged): `SESSION_OBJECT_COUNT_QUOTA` for every kind the Role may create, carried through `loadSessionPolicy`; core `events` read-only (quota controller ignores events) |
| F2 | HIGH (availability) | Service `spec.externalIPs` not refused (CVE-2020-8554); a student Service with the control-plane node IP and port 6443 captured all API-server traffic | student namespace → control plane, every student, the platform | api-side probe 200 → refused; host `kubectl delete` → EOF; kubelet liveness restarted the apiserver; only a node shell could delete the Service | PR #89 (merged): VAP `jumptotech-deny-service-external-ips`, every caller in managed namespaces; preflight requires it |
| F3 | LOW–MEDIUM (capacity) | A student can keep their namespace Terminating indefinitely, holding a global and a per-student slot: a custom finalizer, or a Pod ignoring SIGTERM under a huge `terminationGracePeriodSeconds` | one student → every student's Start | both namespaces still Terminating after 12 min; grace-period Pod's deletion deadline 2029-11-28 | PR #96 (merged): VAP `jumptotech-bound-namespace-teardown`; deny and allow cases asserted live in `pod-security-integration.test.ts` on CI kind |

## Open findings (not fixed here; need a design or product decision)

| # | Severity | Finding | Why not fixed here |
|---|---|---|---|
| O1 | MEDIUM (HIGH for an untrusted cohort) | Docker- and Kubernetes-track shells are local PTYs in the shared terminal container as uid 1001; End signals only bash's pid, so a `setsid`/`nohup` process outlives the session and keeps SEC-ARCH-2's cross-session credential read, and can signal the terminal service | Needs the planned per-session uid, or a cgroup per shell. Killing every uid-1001 process on End would kill other students' shells |
| O2 | MEDIUM | Container sandboxes (linux/terraform/ansible/cicd) have no disk limit (`--storage-opt size=` absent); one student can fill the Docker data root | `--storage-opt` needs overlay2 on xfs+pquota; the host storage layout is an ops decision |
| O3 | HIGH (accepted as S12 / SEC-ARCH-1) | Docker-track DinD is `--privileged`; a student with the inner daemon's cert can `docker run --privileged -v /dev:/dev` and reach host root without any escape | Documented and accepted for a trusted beta only. `docs/pod-security.md` §10 understates it as requiring an escape; it does not |
| O4 | LOW | Kubernetes pods have no ephemeral-storage limits, and local-path PVCs do not enforce size, so a student can fill the kind node disk | Ephemeral limits via LimitRange are possible; PVC size is not enforceable on local-path |
| O5 | LOW | Logout does not end an issued terminal grant (≤ 1 h TTL); `destroyAllForUser` has no caller, so revoking access leaves browser sessions alive (entitlement is still checked per action) | Behavioural change to the session model |
| O6 | LOW | Revoking access does not close an already-attached shell until idle expiry | Documented in operator-access; fix is to close on `ACCESS_NOT_ACTIVE` activity reports |
| O7 | LOW | No rate limit on `/auth/*`, `POST /check`, terminal-token mint; nginx has no `limit_req`/`limit_conn`; unauthenticated terminal sockets are not counted against the cap | Check is serialized per session and one session per student; bounded |
| O8 | LOW | `/api/labs` returns every hint to any signed-in account regardless of entitlement; hint reveals are self-reported | Product decision: catalogue may be public by design |
| O9 | LOW | Bearer path accepts ID tokens when `OIDC_AUDIENCE == OIDC_CLIENT_ID`; no `azp`/`typ` binding | Same subject only; no impersonation |
| O10 | LOW (dev only) | Orchestrator falls back to the default kubeconfig context; with an EKS current-context `dev:api` would create lab namespaces on a real cluster | Dev-host hazard; the kind kubeconfig is mounted in compose |
| O11 | LOW (dev overlay only) | `docker-compose.observability.yml` Prometheus on `0.0.0.0:9090` with `--web.enable-lifecycle`, reachable from local-PTY shells | Production overlay binds 127.0.0.1 without lifecycle |
| O12 | LOW | Local-PTY shells reach `api:4000` directly and control `X-Forwarded-For` (`trust proxy 1`); only the per-IP learning-path read limit keys on `req.ip` | Limited impact |

## Areas audited and found safe

- **Authentication** (`apps/api/src/auth/*`, `routes/auth.ts`, `routes/internal.ts`): every `/api/*` router behind `authenticated` + origin guard; non-AuthError → 503, never pass-through; an invalid cookie is never downgraded to the header path; dev identity refused three ways in production; OIDC state/nonce/PKCE S256, asymmetric algorithms only, exact issuer match; session fixation handled; `returnTo` same-origin path only; `/internal` secret compared in constant time and distinct from the terminal secret in production; dot-segment `/internal` bypass refused at nginx and the API.
- **Authorization / IDOR**: `sessionGuard` on every `/api/sessions/:id` route with stored-owner comparison and 404 for non-owners; owner is not patchable; ids are `sess-[0-9a-f]{7,32}` compared with `=`; list endpoints filter on owner; progress queries bind `student_id`; verifier targets come from the stored session only; no string-built SQL with request data.
- **Terminal / sandboxd WebSocket**: first frame must be `auth`; HMAC token with `uid`, `sid`, `exp`, constant-time compare; API re-checks owner, ACTIVE and entitlement on every attach; containerRef never from the client and cross-checked with the broker's derivation; spawn argv/env/user/cwd from config only, root refused; resize clamped; 64 KiB `maxPayload`; binary frames refused; sandboxd scopes by exact URL match and per-scope secrets.
- **Docker / container isolation**: container-provider sandboxes have no bind mounts, `--cap-drop ALL` plus a per-provider allow-list, memory = memory-swap, pids and CPU limits, `none` or `--internal` networks; names HMAC-derived; removal re-derives from labels and checks the owner.
- **Kubernetes**: namespaced Role only; no namespaces/nodes/`serviceaccounts/token`; ClusterRole bindings refused; managed objects protected; `automountServiceAccountToken: false`; PSA baseline plus the namespace-label VAP.
- **Secrets**: terminal spawn env is an allow-list; Docker CLI children get only PATH/HOME/DOCKER_*; `DATABASE_URL`, OIDC secret and kubeconfig reach the api only; student kubeconfig is built fresh from server, CA and a TokenRequest token.
- **Command injection**: every exec path uses `execFile`/`spawn` with argv and no shell; the `sh -c` sites use positional `"$@"` or constants.
- **SSRF**: every outbound request targets a configured URL with a fixed path; no user-supplied host reaches `fetch`/`net`.
- **Error disclosure**: generic `INTERNAL_ERROR`; provider wording replaced with platform text.
- **Supply chain**: workflow `permissions` minimal, no `pull_request_target`, no untrusted `${{ }}` in `run:`, `persist-credentials: false`, downloads sha256-verified, `npm ci --ignore-scripts` where possible. Actions pinned by tag (first-party) and base images by tag, not digest — hygiene, Dependabot-managed.
- **Terminal workspace reads**: `realpath` containment plus `O_NOFOLLOW`/`O_NONBLOCK` on the final component; a parent-directory swap between check and open reaches nothing the student cannot already read, because the service runs as the same uid 1001 with no capabilities.
- **Kubernetes Ingress**: students may write Ingress objects, but no ingress controller is installed, so they are inert.
- **Web**: no `dangerouslySetInnerHTML`; `RichText` renders lab text as React nodes; external `href`s are lab-authored.

## Test notes

- Each production PR carried a regression test that fails without the fix. F1 and F3 were checked on a throwaway cluster; F2 and F3 are also asserted by CI `kind-integration` (`pod-security-integration.test.ts`: 34 passed on #96, including the new cases).
- The throwaway cluster became unusable under host load (load average 60–85, repeated apiserver restarts), and two later attempts to boot a fresh one timed out in `Preparing nodes`. CI's kind job is therefore the live proof for F3's deny cases.

- `five-student-reliability-simulation` failed once in a full `apps/api` run with `HTTP 400 {}` on a Start at host load average ~83, and passed alone 3/3 and in the next full run; it uses the Linux provider on a fake runtime and is unrelated to F1. Logged as a load flake.
- Integration suites needing Docker/kind (`test:integration*`) were not run locally; CI ran them on every PR.
