# Pod security for Kubernetes session workloads (BETA-P0-016)

What a Pod in a student's session namespace may ask of the node, how that is
enforced, what it deliberately does not cover, and what has to be proved again
on any cluster that is not the local kind cluster.

> **This is not VM-grade isolation.** Every Pod in every session namespace
> shares one Linux kernel with every other Pod on the node, and with the node
> itself. Pod Security Admission decides what a Pod may *request*; it does not
> contain a kernel or container-runtime vulnerability. The arrangement below is
> appropriate for a private beta of known students. It is not hostile
> multi-tenancy, and must not be described as such. Hostile multi-tenancy needs
> a sandboxed runtime (gVisor, Kata) or a VM per tenant underneath.

## 1. Threat boundary

**The actor.** A student with a valid session. On the Kubernetes track they hold
a namespace-scoped ServiceAccount token and may `create` Pods, Deployments,
ReplicaSets, StatefulSets, DaemonSets, Jobs and CronJobs in their own namespace
(`session/isolation.ts` → `studentRbacManifests`). They type arbitrary YAML.

**What must not follow from that.** A Pod that reaches the node: `privileged`
mode, the host's network/PID/IPC namespaces, a `hostPath` mount, a `hostPort`,
a capability beyond the runtime default, an unconfined seccomp or AppArmor
profile, unsafe sysctls. Any one of these turns "create a Pod in my namespace"
into "act on the node", and from the node, on every other student.

**What is out of scope here.** RBAC (namespace-scoped, unchanged), NetworkPolicy
(see README → Known limitations 3), the Docker track's outer sandbox (§8), and
kernel or runtime escapes by a Pod that is already admitted (not addressed by
admission control at all).

## 2. Current state before this change (audited at `488048b`, 2026-09-14)

Measured, not inferred — from the code at that commit and from the live local
cluster (`kindest/node:v1.34.0`).

| Control | State before | Evidence |
|---|---|---|
| PSA labels on session namespaces | **None** | `git grep pod-security.kubernetes.io` empty; 0 namespaces on the live cluster carried one; `KindLabProvider.create` stamped ownership labels only |
| Cluster PSA defaults | **None** | apiserver `--enable-admission-plugins=NodeRestriction`, no admission config — PodSecurity runs with `privileged` defaults |
| Privileged / host-access Pod | **Admitted** | a Pod with `privileged`, `hostPID`, `hostNetwork`, `hostPath: /` and `SYS_ADMIN` together passed a server-side dry run |
| Kubelet `seccompDefault` | **Off** | absent from `/var/lib/kubelet/config.yaml`; Pods naming no profile ran seccomp Unconfined |
| Admission policies | 2 VAPs | `jumptotech-deny-clusterrole-bindings`, `jumptotech-protect-managed-resources`; neither inspects a Pod spec |
| Student RBAC | namespace-scoped | create on pods and every workload kind; no `pods/ephemeralcontainers`, no namespaces, no PVs |
| `default` SA token automount | **On** (Kubernetes default) | no manifest touched `default` |
| `student` SA token automount | **On** (Kubernetes default) | `studentRbacManifests` set nothing |
| Lab setup manifests | kind allow-list only | Pod spec content unchecked |
| Platform services on Kubernetes | none | api, terminal, sandboxd, web and postgres are compose containers (`cap_drop`, `no-new-privileges`, `read_only` per service) |
| Docker track outer sandbox | `--privileged` DinD | documented in README → Docker sandbox security |

## 3. State after this change

| Control | State after | Where |
|---|---|---|
| PSA labels on session namespaces | `enforce=baseline`, `warn=baseline`, `audit=restricted`, all `v1.34` | `session/pod-security.ts`, stamped in `KindLabProvider.create`, reconciled before guardrails on create and reset |
| A managed namespace without them | **Refused**, for every caller including cluster-admin | VAP `jumptotech-require-pod-security` |
| Privileged / host-access Pod | **Refused**, from any creator | PodSecurity admission (`baseline:v1.34`) |
| Controller-created Pods | **Refused** (object accepted with a warning, Pods get `FailedCreate`) | same |
| Kubelet `seccompDefault` (kind) | **On** — Pods naming no profile get `RuntimeDefault` | `infrastructure/kind/cluster.yaml`; `cluster-up.sh` warns on a reused cluster without it |
| `default` SA token automount | **Off**, labelled managed so a student cannot restore it | `defaultServiceAccountManifest` |
| `student` SA token automount | **Off** | `studentRbacManifests` |
| Lab-defined ServiceAccounts (K8S-012) | unchanged — token mounted | not touched |
| Lab setup workloads | refused at load if they ask for host access or privilege | `podSecurityViolations`, called from `loadSetupManifests` |
| Configuration | `POD_SECURITY_*`; `privileged` refused; `latest` refused in production | `apps/api/src/config.ts` → `loadPodSecurityConfig` |

## 4. Pod Security Admission configuration

Every Kubernetes session namespace carries:

```text
pod-security.kubernetes.io/enforce=baseline
pod-security.kubernetes.io/enforce-version=v1.34
pod-security.kubernetes.io/warn=baseline
pod-security.kubernetes.io/warn-version=v1.34
pod-security.kubernetes.io/audit=restricted
pod-security.kubernetes.io/audit-version=v1.34
```

The labels are set in the same request that creates the namespace, so it never
exists unfenced. They are merged again before the guardrail objects on every
create and reset (`KubernetesPort.mergeNamespaceLabels`, a read-then-replace
with the read `resourceVersion`), which repairs a namespace whose create
returned 409, or one created by an older build.

### Levels

| Mode | Level | Why |
|---|---|---|
| `enforce` | `baseline` | the strongest level every Kubernetes lab passes (§6) |
| `warn` | `baseline` | prints only for something about to be refused — which matters for Deployments, because the object is accepted and only its Pods are rejected. A `restricted` warning would print on nearly every beginner command |
| `audit` | `restricted` | records every Pod that would fail `restricted`, where the API server has audit logging configured |

### Version policy

Pinned to the minor version of the kind node image (`v1.34`). `latest` would
let a cluster upgrade change which lab Pods are admitted with no change in this
repository. A unit test fails if the pin and `infrastructure/kind/cluster.yaml`'s
node image disagree, so raising one means raising the other on purpose.

A pin *newer* than the cluster is accepted by the API server (measured: `v1.40`
on a 1.34 cluster) and evaluated as the newest policy the server knows.

### Configuration

| Variable | Values | Default |
|---|---|---|
| `POD_SECURITY_ENFORCE` | `baseline` \| `restricted` | `baseline` |
| `POD_SECURITY_WARN` | `baseline` \| `restricted` | the enforce level |
| `POD_SECURITY_AUDIT` | `baseline` \| `restricted` | `restricted` |
| `POD_SECURITY_VERSION` | `v1.<minor>` \| `latest` | `v1.34` |

The API refuses to start if any level is `privileged` (or anything else not
listed), if `warn` or `audit` is weaker than `enforce`, if the version is
malformed, or if the version is `latest` under `NODE_ENV=production`.

## 5. Admission controls

| Control | Scope | Refuses |
|---|---|---|
| PodSecurity admission (built in) | every Pod in a labelled namespace, every creator | per `baseline:v1.34` — see §6 |
| VAP `jumptotech-require-pod-security` | Namespace CREATE/UPDATE where the new *or old* object is `jumptotech.io/managed=true`; every caller | a managed namespace whose `enforce` label is missing or not `baseline`/`restricted`; removing `managed` from a managed namespace |
| VAP `jumptotech-protect-managed-resources` (existing) | lab ServiceAccounts, managed namespaces | UPDATE/DELETE of any object labelled managed — now including the `default` ServiceAccount |
| VAP `jumptotech-deny-clusterrole-bindings` (existing) | lab ServiceAccounts, managed namespaces | a RoleBinding to a ClusterRole |
| Student RBAC (existing) | the student token | any write to `namespaces`; `pods/ephemeralcontainers` |
| Setup-manifest guard | lab YAML at load | workloads with host access or privilege (§7) |

The namespace policy's binding has no `namespaceSelector` on purpose: for a
Namespace object that selector reads the *new* labels, so an update removing
`jumptotech.io/managed` together with the enforce label would stop matching at
exactly the wrong moment. The policy's CEL condition checks `oldObject` too.

### Measured: `jumptotech-require-pod-security`

| Request (as cluster-admin) | Result |
|---|---|
| create managed namespace, no PSA label | denied |
| create managed namespace, `enforce=privileged` | denied |
| create managed namespace, `enforce=baseline` | allowed |
| remove `enforce` from a managed namespace | denied |
| set `enforce=privileged` on a managed namespace | denied |
| remove `managed` and `enforce` in one update | denied |
| raise `enforce` to `restricted` | allowed |
| change an unrelated label | allowed |
| label an unmanaged namespace `managed=true` only | denied |
| label it `managed=true` + `enforce=baseline` together | allowed |
| delete a managed namespace | allowed |
| create or modify an unmanaged namespace | allowed |

## 6. What `baseline:v1.34` refuses — measured

Server-side, in a namespace labelled as in §4, on `kindest/node:v1.34.0`:

| Pod asks for | Result |
|---|---|
| nothing (`nginx:stable`, as `kubectl run` creates it) | **admitted** |
| `privileged: true` | refused — `privileged` |
| `hostPath: /` | refused — `hostPath volumes` |
| `hostNetwork` / `hostPID` / `hostIPC` | refused — `host namespaces` |
| `capabilities.add: [SYS_ADMIN]` / `[NET_ADMIN]` / `[NET_RAW]` | refused — `non-default capabilities` |
| `capabilities.add: [CHOWN]` (in the default set) | admitted |
| `hostPort: 8080` | refused — `hostPort` |
| `seccompProfile: Unconfined` | refused — `seccompProfile` |
| sysctl `kernel.msgmax` | refused — `forbidden sysctls` |
| `procMount: Unmasked` | refused by API validation (needs `hostUsers: false`) |
| `allowPrivilegeEscalation: true` | **admitted** — see §9 |
| a Deployment whose template is privileged | Deployment accepted with `Warning: would violate PodSecurity "baseline:v1.34"`; ReplicaSet `FailedCreate`; no Pod exists |

**Why not `restricted`.** Measured in a namespace enforcing `restricted:v1.34`:

```text
$ kubectl run nginx --image=nginx:stable
Error from server (Forbidden): pods "nginx" is forbidden: violates PodSecurity "restricted:v1.34":
allowPrivilegeEscalation != false, unrestricted capabilities, runAsNonRoot != true, seccompProfile ...
```

That is K8S-001's first instruction. `restricted` requires fields no beginner
`kubectl run` sets, and `nginx:stable` — used across the track and checked by
verifiers by image name — runs its master process as root. Enforcing it would
break the track rather than harden it; auditing at it records the gap instead.

**Seccomp at runtime.** With kubelet `seccompDefault`, a plain `busybox` Pod
reports `Seccomp: 2` (filter mode) in `/proc/1/status`. The capability bounding
set is the containerd default `0xa80425fb` — no `CAP_SYS_ADMIN`, but it does
include `CAP_NET_RAW`.

## 7. Service accounts and platform-controlled workloads

**Token automounting.** Off for the namespace's `default` ServiceAccount and for
the `student` ServiceAccount. The student's own credential is minted through
TokenRequest and handed to the terminal; it is never read from a mount. A Pod
can still opt in with `automountServiceAccountToken: true` — that changes the
default, not what the student may request, and the token it would get is one
the student already holds or one with no RBAC at all.

**The exception that is not an exception.** K8S-012 teaches RBAC for a workload
that calls the API with its mounted token. Its `inventory-sync` ServiceAccount
is lab content, not a platform object, and keeps the Kubernetes default. The
integration suite asserts the token is mounted and that the workload reaches
the API server (HTTP 403, not 401).

**Setup workloads.** The workloads a lab ships in `setup.manifests` are the only
Pods the platform itself places in a session namespace. They are checked at
load by `podSecurityViolations`: everything above that `baseline` refuses, plus
two rules stricter than `baseline` because a platform fixture has no reason for
either — no added capabilities at all, and no explicit
`allowPrivilegeEscalation: true`. All shipped workloads pass.

They are *not* made `restricted`-compliant (`runAsNonRoot`,
`readOnlyRootFilesystem`, `capabilities.drop: [ALL]`). They are teaching
material the student reads and edits; they run `nginx:stable`, which needs root
and a writable cache directory; and several verifiers compare against their
images. Changing them would change the labs. `audit=restricted` records them.

**Platform services** (api, terminal, sandboxd, web, postgres) do not run on
Kubernetes in this repository. Their hardening lives in the compose files and is
covered by `make secrets-check` and BETA-P0-011/012.

## 8. Exceptions

**There are none, and there is no mechanism for one.** Every one of the 19
Kubernetes labs runs under `baseline`, and nothing in a lab definition can
select a weaker level: `environment` is a strict schema with no pod-security
field, `privileged` is not a value `PodSecurityConfig` can hold, and the
namespace policy refuses it at the API server regardless of what the code asks
for.

If a future lab genuinely needs host access (a real node agent, a CNI lesson),
it needs a design change and a review, not a line of YAML. The narrowest shape
would be a per-lab `restricted`-or-`baseline` choice that can only *raise* the
level, with host access served by a dedicated, non-shared node pool — never a
`privileged` namespace on the shared one.

K8S-018 (DaemonSets) is the lab most likely to be "fixed" into needing one: its
setup manifest says why its node agent is deliberately ordinary.

## 9. What this does not cover

- **Root inside the container.** `baseline` does not require `runAsNonRoot`.
- **`allowPrivilegeEscalation`.** Admitted explicitly and implicitly: Kubernetes
  only sets `no_new_privs` when the field is `false`. What bounds a setuid
  binary is the capability bounding set (no `CAP_SYS_ADMIN`) and seccomp. The
  integration suite asserts exactly that, rather than pretending the field is
  refused.
- **Default capabilities**, including `CAP_NET_RAW`. `baseline` refuses *adding*
  capabilities; it does not remove the runtime's defaults. `restricted` would.
- **The shared kernel**, the kubelet and containerd. An admitted Pod that
  exploits either crosses every boundary here.
- **Dynamically provisioned volumes.** A PVC in a session namespace is backed by
  kind's `local-path` provisioner, which creates a `hostPath`-backed PV. The
  student cannot choose the path and cannot create PVs, but the data does live
  on the node's filesystem.
- **Denial of service** beyond what ResourceQuota and LimitRange already bound
  (pids, disk, inodes are not quota'd).
- **Audit visibility.** `audit=restricted` annotates audit events; kind is not
  configured with an audit policy, so locally nothing records them.

## 10. The Docker track's privileged outer sandbox

Unchanged by this story, and a separate, larger risk. A Docker-track session is
a `docker:dind` container created by `sandboxd` with `--privileged`, because
the inner daemon must create cgroups, mount filesystems and program iptables. A
student who escapes a container *inside* their sandbox is in a privileged
container on the host, one step from the host kernel. The broker narrows who can
create such a container (only `sandboxd`, only from a session id); it does not
change what one is. See README → Docker sandbox security and
docs/runtime-architecture.md §7. The production answer is a VM or sandboxed
runtime per sandbox, not Pod Security.

## 11. Development limitations

- **kind is not production.** Single node, kindnetd, no audit policy, the API
  server's port on loopback.
- **`seccompDefault` needs a new cluster.** It is a kubelet setting applied at
  creation. `cluster-up.sh` reuses an existing cluster and prints a warning if
  the setting is missing; recreate with `npm run cluster:down && npm run cluster:up`.
  The integration suite fails on such a cluster rather than skipping.
- **Shared-cluster ordering.** Several worktrees share one kind cluster. Once
  `lab-rbac-policy.yaml` from this change is applied to it, a worktree running
  an *older* build cannot create session namespaces — it does not stamp the PSA
  labels, and the namespace policy refuses the create. Rebase first, or use a
  separate cluster (`LAB_CLUSTER_NAME` plus its own `apiServerPort`).
- **Upgrade ordering in any environment.** Deploy the orchestrator that stamps
  the labels *before* applying the admission manifest, for the same reason.
  Namespaces created before the change are labelled on their next reset and
  otherwise expire within the session lifetime; the policy permits the update
  that adds the labels.

## 12. Production validation required

None of the following is proved by the local suites. Each must be shown on the
production cluster, by someone with access to it, before claiming §3 there:

1. **PodSecurity admission is active** and not overridden: the plugin is enabled
   (default since 1.25), and no `AdmissionConfiguration` exempts `lab-*`
   namespaces, the orchestrator's username, or a runtime class.
2. **ValidatingAdmissionPolicy is available** (GA in 1.30) and all three
   policies and bindings from `infrastructure/kind/admission/lab-rbac-policy.yaml`
   are installed, with `status.typeChecking` free of warnings.
3. **Every node pool** that can schedule session Pods runs kubelet
   `seccompDefault: true` (or an equivalent runtime default), verified from
   `/api/v1/nodes/<node>/proxy/configz` or the node's config — not assumed from a
   provider's documentation.
4. **The orchestrator's credential** has `get` and `update` on `namespaces` in
   addition to what it already needed (create, list, delete): the label
   reconciliation is a replace.
5. **The cluster version** is at least the pinned `POD_SECURITY_VERSION`, or the
   pin is lowered deliberately to match it.
6. **`pod-security-integration.test.ts` passes** against that cluster with a
   run-scoped `RUNTIME_OWNER_ID` and `JTT_TEST_RUN_ID`.
7. **Audit logging** captures `pod-security.kubernetes.io/audit-violations`
   annotations, if `audit=restricted` is to mean anything.
8. **No mutating webhook** re-adds privilege after validation (PodSecurity
   evaluates the final object, but a webhook that injects a privileged sidecar
   would make every student Pod fail — or, if it targets a runtime class the
   cluster exempts, succeed).
9. **Session Pods do not share nodes with platform or cluster-critical
   workloads**, if the claim is to be anything more than "a student cannot ask
   for host access": admission does not stop a kernel escape.

## 13. What proves it

| Test | Kind | Proves |
|---|---|---|
| `services/lab-orchestrator/test/pod-security.test.ts` | unit | labels, config rules, version pin vs node image, SA automount, setup-manifest guard for 17 dangerous shapes and every workload kind, all shipped lab workloads pass, provider stamps and reconciles labels before applying anything, kind `seccompDefault` |
| `services/lab-orchestrator/test/admission-policy.test.ts` | unit | all three policies are structurally valid, fail closed, and the namespace policy cannot be escaped by dropping the managed label |
| `services/lab-orchestrator/test/setup-engine.test.ts` | unit | reset against a namespace that exists (the relabel step requires it) |
| `apps/api/test/pod-security-config.test.ts` | unit | `POD_SECURITY_*` parsing, `privileged` refused at startup, `latest` refused in production |
| `services/lab-orchestrator/test/pod-security-integration.test.ts` | kind | everything in §5–§7 against a real API server and kubelet, with real student credentials |

```text
npm run cluster:up
RUN_INTEGRATION_TESTS=1 \
KUBECONFIG="$PWD/infrastructure/kind/generated/kubeconfig-host.yaml" \
  npx vitest run test/pod-security-integration.test.ts --root services/lab-orchestrator
```
