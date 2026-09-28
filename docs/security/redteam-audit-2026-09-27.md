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
| O2 | MEDIUM — **partly fixed** (see I2, I3) | Container sandboxes: unbounded container log **fixed** (PR #119); writable layer and the DinD image volume still unbounded. `--storage-opt size=` is accepted but **not enforced** by Docker Desktop's containerd snapshotter (measured), so it was not added | Production host must run overlay2 on XFS with `pquota` (or equivalent) before a per-sandbox disk quota is real; until then, host-disk alerts and session lifetime are the control |
| O3 | HIGH (accepted for the private beta only) | Docker-track DinD is `--privileged`; the student holds the inner daemon's client certificate, so reaching host-level privilege needs no escape | `docs/pod-security.md` §10 corrected in this pass. PRIVATE BETA ACCEPTABLE RISK; PUBLIC MULTI-TENANT BLOCKER (Docker track off, or a VM/sandboxed runtime per sandbox). Not probed live |
| O4 | MEDIUM — **fixed except PVCs** (see I4, I5) | Kubernetes pods had no ephemeral-storage bound; local-path PVCs do not enforce size | ephemeral-storage LimitRange + quota (PR #122, needs #121). PVC capacity needs a provisioner that enforces it: infrastructure action |
| O5 | LOW | Logout does not end an issued terminal grant (≤ 1 h TTL); `destroyAllForUser` has no caller, so revoking access leaves browser sessions alive (entitlement is still checked per action) | Behavioural change to the session model |
| O6 | LOW | Revoking access does not close an already-attached shell until idle expiry | Documented in operator-access; fix is to close on `ACCESS_NOT_ACTIVE` activity reports |
| O7 | LOW | No rate limit on `/auth/*`, `POST /check`, terminal-token mint; nginx has no `limit_req`/`limit_conn`; unauthenticated terminal sockets are not counted against the cap | Check is serialized per session and one session per student; bounded |
| O8 | LOW | `/api/labs` returns every hint to any signed-in account regardless of entitlement; hint reveals are self-reported | Product decision: catalogue may be public by design |
| O9 | LOW | Bearer path accepts ID tokens when `OIDC_AUDIENCE == OIDC_CLIENT_ID`; no `azp`/`typ` binding | Same subject only; no impersonation |
| O10 | HIGH on a developer machine — **fixed** (PR #115, merged) | Orchestrator fell back to the kubeconfig's current-context | See I1 |
| O11 | LOW (dev overlay only) — **fixed** (PR #116, merged) | Dev Prometheus lifecycle API reachable from peer containers | See I6. Dev read API and Alertmanager silences remain reachable from peers in development only |
| O12 | LOW | Local-PTY shells reach `api:4000` directly and control `X-Forwarded-For` (`trust proxy 1`); only the per-IP learning-path read limit keys on `req.ip` | Limited impact |

## Docker/Kubernetes isolation pass (wave 3, 2026-09-27)

Baseline `ac1b775`. Every Kubernetes probe used a session started through
`KindLabProvider` on the shared `jumptotech-labs` kind cluster and the
student's **own** ServiceAccount kubeconfig, with owner label
`runtime-owner=redteam-o4`; all such namespaces were ended through the provider
and verified gone. Docker probes used disposable containers and networks
labelled `jtt.redteam.probe`, removed after each run. No external cluster was
contacted. Live privileged-DinD escape probing was not performed (O3 is
recorded from the design).

| # | Severity | Finding | Threat model / boundary | Reproduction and evidence | Fix and tests | Remaining risk | Beta / public impact |
|---|---|---|---|---|---|---|---|
| I1 (O10) | HIGH on a developer machine | `KubernetesClient` used `loadFromDefault()` and the kubeconfig's current-context; nothing compared it with `LAB_CLUSTER_NAME` | developer runs `npm run dev:api` with a real cluster current → lab namespaces, Roles and a student token created there, handed to a student shell | fake kubeconfig with current-context `prod` plus a kind context: the composed client's endpoint (the one student kubeconfigs are built from) was the prod server. The machine this ran on has 9 EKS contexts | PR #115 (merged): one context everywhere (`LAB_KUBE_CONTEXT`, else `kind-<LAB_CLUSTER_NAME>`); a missing context refuses every request before any network; `kubectl` calls pass `--context`. Tests fail on the old composition and client | none known | beta: fixed. public: fixed |
| I2 (O2) | MEDIUM (host availability) | Container sandboxes used the daemon's `json-file` log with no `max-size`; PID 1's stdout is writable by the student and nothing reads that log | student → host Docker data root, shared by every session and the platform | `> /proc/1/fd/1` wrote 4,997,120 bytes into the host log from one command | PR #119: `--log-driver json-file --log-opt max-size=1m --log-opt max-file=1`; re-measured: 20 MB written, log holds 999,424 bytes; boundary test fails on the old runtime | writable layer (I3) | beta: fixed. public: fixed |
| I3 (O2) | MEDIUM | Writable layer and the DinD `/var/lib/docker` volume are unbounded | as I2 | 50 MB `/tmp` + 2,000 files freely; a container created with `--storage-opt size=64m` took **100 MB** (accepted, stored, not enforced by the containerd snapshotter) | not fixed: a cosmetic quota was deliberately not added | one student can fill the Docker disk within a session | beta: accepted with disk alerts, one session per student and End removing the layer. public: **blocker** until the host enforces per-container quotas |
| I4 (O4) | MEDIUM (host availability) | Kubernetes sessions had no ephemeral-storage requests, limits or quota | student → kind node disk = the same host disk | as the student: 200 MB each into the writable layer, a disk-backed emptyDir and a `10Mi` PVC all succeeded. Kubelet enforcement proven first: 64Mi limit and emptyDir `sizeLimit` both Evicted | PR #122: LimitRange 64Mi/256Mi/1Gi and quota 2Gi/4Gi, env-overridable; re-measured: unqualified 400 MB writer and an emptyDir without sizeLimit Evicted at 256Mi, `50Gi` refused by `max`, student cannot patch the LimitRange, 6 replicas still fit | PVCs (I5) | beta: fixed. public: fixed |
| I5 (O4) | MEDIUM | local-path stores a PVC as a plain node directory and ignores its size | as I4 | `/var/local-path-provisioner/pvc-…_tiny` held **201M** for a `10Mi` claim | not fixed: two certified labs need PVCs; a `requests.storage` quota would bound only the requested number | up to 5 PVCs per session, unbounded in size | beta: accepted (5 known students, disk alerts). public: **blocker**: a provisioner that enforces capacity (XFS project quotas, TopoLVM, cloud block CSI) |
| I6 (O11) | LOW (dev only) | Dev Prometheus ran `--web.enable-lifecycle` on `0.0.0.0` in a namespace reachable from the compose default network (the terminal container) | peer container → monitoring | disposable network, dev flags: peer `POST /-/quit` → 200 and Prometheus exited 0; `/api/v1/status/flags` readable | PR #116 (merged): lifecycle off in dev; contract test fails on the old compose file | dev read API, Alertmanager silences | beta: none (production overlay already safe) |
| I7 (new) | MEDIUM (defence in depth) | Session guardrails were **stored wrong**: `@kubernetes/client-node` models rename `NetworkPolicyIngressRule.from` → `_from` and `LimitRangeItem.default` → `_default`; plain manifests lost both fields. Every session's `allow-same-namespace` policy was stored as `ingress: [{}]` (allow from everywhere), and the LimitRange default collapsed to its max | any cluster workload without an egress policy → every student pod. Student A → student B stayed blocked by A's own default-deny egress | live `ingress: [{}]`; from a pod in a separate namespace, `wget` to an old-session pod **REACHED**, to a fixed-session pod **blocked**. The enforcement attestation did not see it: the probe applies its own policies with `kubectl` | PR #121: manifests go through the public `loadYaml` (wire → model) before create/replace. Stand-in API test and a live `labs-integration` case read back with the student kubeconfig; both fail on the old client. Kubelet HTTP probes still pass | none known | beta: fixed. public: fixed |
| I8 (new; fixed by PR #123, per-session uid owner) | MEDIUM | Kubernetes-track shells share `HOME=/home/student` (one tmpfs in the terminal container) across sessions; bash writes `~/.bash_history` there on exit and files persist after End | student A (ended) → the next Kubernetes-track student | terminal image, the terminal's exact flags: A's typed `export SECRET_MARKER_A=…` and `notes-from-A.txt` readable from the next shell | PR #123 (per-session uid, stacked on merged #117): each Kubernetes shell gets its own 0700 home, where bash's default HISTFILE lands, and End kills the session uid's processes and removes it | until #123 merges, as O1 | beta: fixed once #123 is on main. public: same |
| I9 (confirmed from a peer report) | LOW–MEDIUM (production Linux) | `--internal` sandbox networks can reach the host's own stack at the bridge gateway | container sandbox → host services bound to `0.0.0.0` | disposable internal network: every gateway port answered with refused (the host stack responds; nothing listens in the Docker Desktop VM). Loopback-only binding is not a boundary for `NET_RAW` labs on Docker Desktop (peer report) | not fixed: host firewall | a Linux host's `0.0.0.0` services (sshd) are reachable from sandboxes | beta: **infrastructure action**: INPUT drop from `jtt-net-*`/sandbox bridges to the host. public: blocker until measured on the production kernel |

### Cross-student isolation (proved, not inferred)

- **Kubernetes, with real student credentials (A against B):** namespaces,
  pods (list, logs, exec, attach, port-forward), services, the service proxy,
  secrets, configmaps, PVCs, creating pods in B, a token for B's or A's own
  ServiceAccount, nodes, the node proxy, PVs, clusterroles, RoleBinding
  creation (including binding `cluster-admin`), impersonation and
  `kube-system` secrets were all **Forbidden**. Pod network A → B timed out
  (A's default-deny egress). From a student pod only the API service
  (anonymous 403) and cluster DNS answer. Other kind-network hosts, the Docker
  gateway, the internet and `169.254.169.254` are filtered. A selector-less
  Service with hand-written Endpoints (CVE-2021-25740 class) pointing at
  another student's pod, or at a filtered kind-network host, was **blocked**
  both by ClusterIP and by name: egress policy sees the post-DNAT
  destination. On the node:
  kubelet 401, etcd requires a client certificate, apiserver 403, kube-proxy
  healthz on 10256 is the only readable endpoint (non-sensitive).
- **Docker, proved in CI on every PR:** `docker-integration.test.ts`
  (separate container lists and image stores, another session's client
  certificate rejected, reset and teardown isolation, nothing left on the host),
  `sandboxd-integration.test.ts` (no attach to another session's sandbox),
  `sandbox-integration.test.ts` (Linux and Terraform side by side).
  **Bounded by O1**: every Docker-track student shell is uid 1001 in the one
  terminal container, so student A can read student B's TLS client key and
  drive B's daemon; the mutual-TLS boundary holds only once per-session uids
  land. B's published inner ports are also reachable over the shared
  `sandboxes` bridge (lab services only; weaker than O1).

### Cleanup and residue

Kubernetes End (provider teardown), measured: namespace gone in 53 s, the PV
deleted, the local-path directory with 201 MB removed, no containers left; an
empty 8 KiB `/var/log/pods` directory was collected by the kubelet within 60 s.
Students cannot reach node paths (PSA baseline forbids `hostPath`). Docker
teardown is asserted in CI (`leaves nothing of a destroyed session behind on
the host`). The residue found is I8 (terminal HOME).

### Beta and public-launch position after this pass

- **Private 5-student beta blockers:** none new from this pass, provided #119,
  #121 and #122 are on main and the host firewall action (I9) is applied.
- **Public multi-tenant blockers:** O1 and I8 until #117/#123 are proven in production; O3 (Docker track off or a VM
  per sandbox); I3 and I5 (enforced per-container and per-PVC disk quotas on
  the host); I9 measured and firewalled on the production kernel.
- **Infrastructure actions:** XFS `pquota` (or equivalent) for the Docker data
  root; a capacity-enforcing storage provisioner for the cluster; host INPUT
  drop from sandbox bridges; keep `HostDiskSpace*` alerts wired.

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
