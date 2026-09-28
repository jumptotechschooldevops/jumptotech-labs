# Security red-team, wave 2 — 2026-09-27

A second, independent red-team pass over current `origin/main`, after wave 1
(`redteam-audit-2026-09-27.md`) merged #86, #89 and #96. Its purpose was to look
for remaining *exploitable* boundaries, not to re-list the wave-1 fixes, and to
adversarially re-verify the isolation invariants against the code as it stands
after the intervening lab, capacity and authz PRs.

**Result: no new exploitable finding.** Every isolation invariant checked still
holds. The items that remain open are the ones wave 1 and the application-
security audit (`releases/app-security-multi-tenant-audit.md`) already recorded,
and each is either owned by another track or is public-launch-tier
defence-in-depth rather than a private-beta blocker.

Concurrency note: the Docker/Kubernetes isolation follow-ups (O2, O3, O4, O10,
O11 in `redteam-audit-2026-09-27.md`) and the per-session terminal uid (O1) are
being carried by other sessions. This pass deliberately did not touch those
files or duplicate that work.

## How this pass verified, given the environment

Live cluster reproduction was unreliable: the shared host ran at load average
20–85 for the pass, and throwaway kind clusters repeatedly crash-looped their
API server or timed out in `Preparing nodes`. Verification here is therefore at
the level of the code and its existing tests, with the live admission-gate
proofs left to CI `kind-integration` (`pod-security-integration.test.ts`), which
runs against a cluster built by the repository's own `cluster-up.sh`.

## Invariants re-verified on current main (all held)

| Boundary | What was checked | Verdict |
|---|---|---|
| Container escape | `runtime.create` argv: `--cap-drop ALL`, allow-list `GRANTABLE_CAPABILITIES` with `PROVIDER_RESTRICTED_CAPABILITIES` (NET_RAW→linux, SYS_CHROOT→ansible), no bind mounts, no Docker socket, `--user` non-root, `--pids-limit`/`--memory`/`--memory-swap`/`--cpus` with zero/unlimited refused, `no-new-privileges` on except the Linux sudo lab (still cap-drop ALL, so in-container root only) | safe |
| Network join | `assertSandboxNetwork` refuses `host` and `container:<name>` (the `:` is outside the name pattern); per-session bridges are `--internal`; names are `jtt-net-<hmac>` derived from the server-generated session id | safe |
| NetworkPolicy | default deny-all Ingress+Egress, same-namespace allow, DNS egress to the kube-dns pod (both selectors on one peer), API-server egress only to `/32`(+`/128`) CIDRs and named ports; no `except` blocks | safe |
| Command construction | every production exec uses `execFile`/argv with `shell:false`; `--` guards on file arguments; seed-script content travels on stdin and runs via `sh -c 'exec "$0"' <path>`; the only `sh -c` string in the k8s probe is built from constants | safe |
| Ref forgery / cross-tenant naming | session id `sess-[0-9a-f]{7,32}`; container/network/namespace refs are `HMAC(secret, "sandbox:<prefix>:<sessionId>")`; sandboxd re-checks managed+owner+session labels before exec/inspect/remove | safe |
| IDOR — session listing (#71 refactor) | `GET /api/sessions` now calls `listOccupyingForOwner(req.user.userId)`; Postgres `WHERE status = ANY($1) AND owner_user_id = $2`, in-memory filter excludes `ownerUserId === undefined`; an unowned session matches nobody | safe (refactor did not regress the boundary) |
| Per-student cap | `createWithinLimits` takes the global and per-owner counts in one statement under one `pg_advisory_xact_lock`, then inserts — two starts for one student cannot both count one-below-limit | safe |
| Secrets in new code | no `console`/`logger`/`res.json`/`res.send` line introduced since 92c0aaf carries a secret, token, kubeconfig, cert, credential or `DATABASE_URL` | safe |
| Dependencies | `npm audit --production`: 0 vulnerabilities. The two moderate advisories are `vitest`/`@vitest/mocker` (dev test tooling, path traversal via mock redirect), not production-reachable, already owned by Dependabot #6 | dev-only |

## Not fixed here (owned or deferred)

| Ref | Item | Why not fixed in this pass |
|---|---|---|
| O1 | Shared uid 1001 on the terminal host | Per-session uid is owned by the api-authz track |
| O2, O3, O4, O10, O11 | Sandbox disk limits; privileged DinD; pod ephemeral storage; dev kubeconfig context; dev-overlay Prometheus | Owned by the Docker/k8s isolation red-team track |
| P2-1 | `__Host-` cookie prefix / sibling-subdomain cookie tossing | The transaction cookie is deliberately `Path=/auth` (decision DR-09); adding `__Host-` reverses that and touches the auth flow, so it needs the auth owner, not a red-teamer's unilateral change |
| P2-2 | No idle timeout on browser sessions | Public-launch hardening |
| P2-3 | Terminal token survives sign-out (≤ 1 h) | Needs binding the token to the auth session; auth-owned, public-launch tier |

## Multi-tenant verdict (five-student private beta)

- **API isolation:** PASS — every `/api/sessions/:id` route is owner-checked; the #71 listing refactor stays owner-scoped; instructor/admin boundaries are tested (#85).
- **Terminal isolation:** CONDITIONAL — the token binding and shared-uid items are known; per-session uid (O1) is in progress. No cross-student attach path exists (token carries `sid`+`uid`, API re-checks owner/ACTIVE/entitlement).
- **Filesystem isolation:** CONDITIONAL — workspace reads are `realpath`+`O_NOFOLLOW` contained; the residual cross-read is the shared-uid one (O1), owned.
- **Network isolation:** PASS — per-session `--internal` bridges (containers) and default-deny NetworkPolicies (k8s); externalIPs closed (#89).
- **Runtime isolation:** CONDITIONAL — privileged DinD (O3) is accepted for a trusted beta and owned for follow-up.
- **Resource isolation:** PASS — per-student cap atomic; object-count quota (#86) and teardown bound (#96); Start/Check/terminal-token budgets (#63/#75/#79/#82).

## Private-beta security blockers

None newly discovered in this pass. The pre-existing gate items (merge status of
the per-session-uid work for an *untrusted* cohort) are tracked in
`app-security-multi-tenant-audit.md` §13; for the *trusted* five-student beta,
that audit records no blocker, and this pass adds none.

## Public-launch security blockers (carried forward)

1. Per-session uid for terminal shells (O1 / SEC-ARCH-2).
2. Sandbox and pod disk limits (O2, O4).
3. Reconsider privileged DinD before untrusted students (O3).
4. `__Host-` cookies if the host shares a registrable domain (P2-1).
5. Edge rate/connection limits and browser idle timeout (P2-6, P2-2).

## Final security result

**CONDITIONAL PASS for the five-student trusted private beta** — no new
exploitable vulnerability; the three control-plane DoS findings from wave 1 are
fixed and merged; the remaining risks are owned follow-ups or public-launch
hardening. This is not a claim that the platform is secure; it is the state of
the boundaries this pass could verify.
