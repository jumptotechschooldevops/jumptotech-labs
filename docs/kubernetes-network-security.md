# Kubernetes network security (BETA-P0-015)

How a Kubernetes-track session is fenced on the network, what has been proven,
how production must prove it, and what is still undecided.

> **Status.** Development runs on **kind**. The production Kubernetes substrate
> is **DECISION REQUIRED**. The production CNI is **DECISION REQUIRED**. Nothing
> in this document selects either, and nothing here claims VM-grade isolation:
> sessions are namespaces on shared nodes and a shared kernel.

---

## 1. The rule this story exists for

**A NetworkPolicy object is not evidence of isolation.** The API server stores
NetworkPolicies whether or not anything in the cluster enforces them. A CNI with
no policy support accepts every object and drops nothing. So the platform never
reports a network boundary from YAML. It reports one only when:

1. a connection that the policy forbids **fails**; and
2. **the same connection, without the policy, succeeds** (the negative control).

If the control fails, the result is INCONCLUSIVE, not PASS.

---

## 2. What existed before

Audited on `main` at `488048b`.

| Control | Generated | Applied | Enforcement-tested |
|---|---|---|---|
| `…-default-deny` (ingress + egress) | yes | yes, on every session namespace | **no**; `integration.test.ts` only listed the objects by name |
| `…-allow-same-namespace` | yes | yes | no |
| `…-allow-dns`: port 53 to **every Pod in kube-system** | yes | yes | no |
| `…-allow-external-egress`: `0.0.0.0/0 except <pod CIDR>, <service CIDR>`, **on by default** (`ALLOW_EXTERNAL_EGRESS=true`) | yes | yes | no |
| Student cannot delete or edit their own policies (RBAC read-only) | yes | yes | **yes**, a real `Forbidden` in `integration.test.ts` |
| Lab setup manifests cannot contain a NetworkPolicy | yes | n/a | unit-tested |
| Production refuses `NETWORK_POLICY_ENABLED=false` | **no** | n/a | n/a |
| Any enforcement check before students are admitted | **no** | n/a | n/a |

CI (`kind-integration`) ran `integration.test.ts` and the whole-catalog suite.
Neither made a single connection attempt between Pods.

---

## 3. What was measured on kind

The measurements used a dedicated cluster, not the shared development cluster:
- kind v0.31.0 with `kindest/node:v1.34.0` and kindnetd `v20250512-df8de77b`;
- Docker Desktop on arm64, kernel 6.10.14-linuxkit;
- busybox 1.36 client and server Pods in three namespaces: `pa` and `pb` with policies, `pc` without.

| Connection | No policies | Main's policies applied |
|---|---|---|
| pa → own Pod / own Service by DNS name | reachable | reachable |
| pa → pb Pod, pa → pb Service | reachable | **blocked** |
| pb → pa, pc → pa | reachable | **blocked** |
| pa → pc Pod (pc has no ingress fence) | reachable | **blocked** |
| DNS lookup from pa | reachable | reachable |
| pa → CoreDNS Pod `:8181` (non-DNS port) | reachable | blocked |
| pa → API server (Service) | reachable | reachable |
| pa → node `:10250` (kubelet) | reachable | **reachable** (see §8) |
| pa → `1.1.1.1:443`, `8.8.8.8:53` | reachable | reachable (external egress was on) |
| **pa → dev api container `172.19.0.3:4000` on the kind Docker network** | reachable | **reachable: defect** |
| **pa → another cluster's API server `172.19.0.2:6443`** | reachable | **reachable: defect** |

What these show:

- **kindnetd enforces NetworkPolicy** on this version: deny-all, pod selectors,
  namespace selectors, ports and plain `ipBlock.cidr`.
- **Defect 1, external egress reached private infrastructure.** Excluding only
  the Pod and Service CIDRs left all other private space open: the kind Docker
  network, and in any real deployment the node network, VPC and application tier.
  It was also on for every lab.
- **Defect 2, the DNS rule was wider than DNS.** It allowed port 53 to any Pod in
  kube-system.
- Cross-session Pod traffic was already refused, by **both** fences: the
  destination's ingress deny and the source's egress deny.
- `ipBlock.except` was **honored** in this measurement (`0.0.0.0/0 except
  1.1.1.1/32` blocked 1.1.1.1 and allowed 8.8.8.8). An earlier internal note
  recorded the opposite on a nominally identical kindnetd. The contract does not
  depend on either result: it never emits `except` (§4).
- A plain `ipBlock` covering the Pod CIDR **does** match Pod IPs on kindnetd.
  That is why external egress must exclude the cluster ranges explicitly, and
  does.

---

## 4. The contract

`services/lab-orchestrator/src/session/network-policy.ts`. Every session
namespace:

| Policy | Effect |
|---|---|
| `…-default-deny` | all Pods, ingress and egress, no rules |
| `…-allow-same-namespace` | ingress from and egress to this namespace's Pods |
| `…-allow-dns` | egress to Pods matching `CLUSTER_DNS_POD_SELECTOR` (default `k8s-app=kube-dns`) **in** `CLUSTER_DNS_NAMESPACE`: one peer with both selectors, UDP and TCP 53 only |
| `…-allow-kube-apiserver` | egress to each ready endpoint of `default/kubernetes` as a `/32` (`/128`), on that endpoint's port only; resolved from the cluster at apply time |
| `…-allow-external-egress` | **only** when `ALLOW_EXTERNAL_EGRESS=true` **and** the lab declares `environment.capabilities: [external_egress]`: public IPv4 space as plain CIDR blocks |

Properties that are pinned by tests:

- **No `0.0.0.0/0`, and no `except`, in any generated policy.** External egress is
  the computed complement (`k8s/cidr.ts`) of:
  - non-public IPv4: RFC 1918, 100.64/10, 127/8, 169.254/16 (instance
    metadata), 0/8, multicast, reserved and documentation ranges;
  - the Pod and Service CIDRs;
  - `CLUSTER_EGRESS_DENY_CIDRS`.
- **External egress is off by default** and per lab. A lab declaring
  `external_egress` on a platform that does not permit it **fails to start**
  (`NetworkPolicyContractError`); it is not started without the access it
  declared. Only the `kubernetes` provider may declare it.
- **Every policy survives reset** (`protectedResources`), and reset re-applies
  them.
- Configuration is validated at load. A malformed CIDR, host bits set, an empty
  DNS selector or a non-positive attestation age refuses to start.
- IPv6: no IPv6 egress is allowed except an IPv6 API server endpoint. On a
  dual-stack cluster that means IPv6 stays denied.

### External egress audit

None of the 19 Kubernetes labs needs Pod-originated internet access:

- Images are pulled by the kubelet, not by the Pod, so NetworkPolicy does not
  apply to pulls.
- The only lab whose Pod makes a network call is **K8S-012**. Its
  `inventory-sync` Deployment calls `https://kubernetes.default.svc`. That is the
  API server, covered by `allow-kube-apiserver`, not external egress.
- The other 95 labs are container or simulated tracks. NetworkPolicy does not
  apply to them.

No lab declares `external_egress`, and a unit test fails if one starts to
without anyone noticing.

---

## 5. How enforcement is proven

### 5.1 The probe

`services/lab-orchestrator/src/k8s/network-enforcement-probe.ts` creates three
namespaces, each with a server Pod and Service and a client Pod.

1. **Without policy (negative controls).** A→B Pod, A→B Service, B→A, C→A, A→C
   and A→public target must all connect. So must A→private target, when one is
   given. A failed control makes the run **INCONCLUSIVE**.
2. **With policy.** A and B get exactly `networkPolicyManifests()`, the builder
   the provider uses, and C stays unfenced. The probe waits for the first denial
   (enforcement is programmed asynchronously), then checks:
   - **allowed:** A → own Pod, own Service by DNS name, cluster DNS lookup,
     API server endpoint; B → own Pod;
   - **blocked:** A→B Pod, A→B Service, B→A, C→A, A→C, A→public, A→private,
     A→DNS Pod non-DNS port (judged only where its control showed a listener);
   - **if external egress is permitted:** B (declaring) → public is reachable,
     B → C and B → private stay blocked;
   - **controls:** C → own Pod and C → public still work after the policies
     land, so the denials are policy and not an outage;
   - **informational, not judged:** A → node `:10250`.

Verdict:
- any forbidden connection that succeeds → **FAIL**;
- else any failed control → **INCONCLUSIVE**;
- else any allowance that does not work → **FAIL**;
- else **PASS**.

### 5.2 The attestation and the admission gate

```bash
KUBECONFIG=<cluster-admin kubeconfig> <the deployment's network env vars> \
  npm run verify:network-policy -- --write-attestation [--private-target <infra host:port>]
```

The command writes `kube-system/jumptotech-network-policy-enforcement` with:
- the verdict;
- the kube-system namespace **UID** (cluster identity);
- the **contract digest** (a hash of every setting that changes what the policies say, plus the contract version);
- the timestamp;
- every check line;
- the node-local observation.

It records FAIL and INCONCLUSIVE too, so re-probing a cluster that stopped
enforcing revokes admission.

With `NETWORK_POLICY_ATTESTATION_REQUIRED` on, the Kubernetes provider refuses
to admit students unless the attestation:
- says **PASS**;
- matches this cluster's UID;
- matches this deployment's contract digest;
- is not older than `NETWORK_POLICY_ATTESTATION_MAX_AGE_SECONDS` (default 7 days) and not in the future.

The refusal shows up in two places:
- **Catalog:** the Kubernetes track reports unavailable, with the reason and the command to run.
- **Start Lab:** `create()` fails at step `network-isolation-verified` with `PROVIDER_UNAVAILABLE` before any namespace exists.

Under `NODE_ENV=production` the attestation is required by default, and
`NETWORK_POLICY_ATTESTATION_REQUIRED=false` refuses to start. So does
`NETWORK_POLICY_ENABLED=false`. Both gates run after the owner, secret and
transport gates from earlier P0 stories, which keep precedence.

What the attestation does not protect against: anyone who can write ConfigMaps
in kube-system can forge one. That is cluster-admin, which can remove the
policies anyway. It is also a point-in-time measurement, which is why it expires.

---

## 6. DNS

- Allowed: UDP and TCP 53 to the DNS Pods, selected by namespace **and** Pod
  labels. Measured: lookups work under deny-by-default.
- Not allowed: other ports on those Pods. The probe judges this with a negative
  control on CoreDNS `:8181` wherever that port listens.
- Not allowed: port 53 to anything else, including external resolvers.
- **NodeLocal DNSCache** (a link-local address on the node) or any DNS service
  outside the selected Pods needs `CLUSTER_DNS_*` and possibly the contract to
  change. It would then need re-probing, and the digest forces that.

---

## 7. Cross-session isolation

Proven on kind by
`services/lab-orchestrator/test/network-policy-enforcement-integration.test.ts`,
through the real `SessionManager` and `KindLabProvider`:

- Sessions A and B (K8S-001, default policy) each reach their own Pod, their
  own Service by name, and cluster DNS.
- A → B Pod, A → B Service and B → A all fail, while B still reaches itself.
- **Negative control:** sessions X and Y get the same Pods but are created with
  NetworkPolicy disabled. X → Y Pod, X → Y Service and Y → X all succeed.

The probe proves the same property with its own namespaces, and additionally
proves the external-egress variant.

---

## 8. Development: kind

- `scripts/cluster-up.sh` builds a single-node kind cluster with the default
  kindnetd CNI. It enforces NetworkPolicy, as §3 shows. No Calico or Cilium is
  installed, and none is needed for development.
- `NETWORK_POLICY_ATTESTATION_REQUIRED` is off by default for local development.
  To exercise the production gate locally, set it to `true` and run
  `npm run verify:network-policy -- --write-attestation`.
- **Limitations on kind, all measured or structural:**
  - **Pod-to-node traffic is not governed.** A session Pod reached its node's
    kubelet (`:10250`) under deny-all. The API server stays reachable the same
    way, and so would instance metadata on a cloud node. This is cross-CNI:
    packets to the node's own addresses land in the host's INPUT path, not the
    policy chain. NetworkPolicy must never be relied on for these destinations.
  - **One node.** Every "cross-session" packet stays on one bridge. Multi-node
    paths (encapsulation, remote-node identity) are not exercised.
  - **The kind Docker network is shared.** The api, terminal and every kind
    cluster on the laptop sit on it. External egress now excludes it (it is RFC
    1918), but a Pod's node is on it by construction.
  - **`hostNetwork` Pods bypass NetworkPolicy entirely.** Preventing students from
    creating them is Pod Security admission: BETA-P0-016 enforces `baseline` on
    every session namespace, which refuses them (docs/pod-security.md).
  - kind is development infrastructure, not a production substrate.

---

## 9. Production acceptance

**No student is admitted until the cluster proves enforcement.** Before opening
a production Kubernetes cluster to students:

1. **Choose the substrate and the CNI.** DECISION REQUIRED (§11).
2. **Configure the contract.** Set `CLUSTER_POD_CIDR`, `CLUSTER_SERVICE_CIDR`,
   `CLUSTER_DNS_NAMESPACE` and `CLUSTER_DNS_POD_SELECTOR` to the cluster's real
   values. Set `CLUSTER_EGRESS_DENY_CIDRS` to any **public** range that is still
   infrastructure (a public node or load-balancer range). Private ranges are
   already excluded.
3. **Run the probe** with those same variables, against that cluster, with
   `--write-attestation`. Give it a `--private-target` that is real
   infrastructure: a node-network or application-tier address that session
   Pods must not reach.
4. **Require PASS.** FAIL means the CNI does not enforce the contract.
   INCONCLUSIVE means a control failed (for example, the control namespace has
   no route to the public target). Neither admits students, and neither may be
   waived.
5. **Re-probe** at least every `NETWORK_POLICY_ATTESTATION_MAX_AGE_SECONDS`, and
   after any change to the CNI, node image, network configuration or these
   variables. A changed digest refuses admission until then.

What production infrastructure must prove, beyond the probe:

- **Node-local destinations are closed**, by a host firewall, cloud security
  groups, or CNI host policy:
  - kubelet `10250`;
  - node ports;
  - instance metadata `169.254.169.254`. On AWS, IMDSv2 with hop limit 1.

  NetworkPolicy does not cover these, and the probe reports that path without
  judging it.
- **Pods cannot use `hostNetwork`, `hostPort` or privileged mode** (Pod Security
  admission).
- **Multi-node paths enforce the same way**, so run the probe with the test
  namespaces on different nodes. The current probe does not force placement;
  see §11.
- **The api's cluster credential can read what the gate reads.** Admission
  needs:
  - `get namespaces/kube-system`, for the cluster UID;
  - `get configmaps` in `kube-system`, for the attestation;
  - `list endpointslices` in `default`, for the API server allowance.

  A credential lacking any of these fails closed: the track reports
  unavailable, or provisioning fails. The api's production credential is itself
  undecided (§11, D5).
- **The verifier still reaches what it must.** Today no shipped lab uses
  `service_http`/`service_tcp`, which dial a ClusterIP from the api process.
  Traffic from outside the pod network into a session is denied by
  default-deny, so any future lab that needs it needs an explicit, reviewed
  ingress allowance.

---

## 10. What GitHub CI must prove

The `kind-integration` job, on a fresh runner with a fresh cluster from
`scripts/cluster-up.sh`, runs:

1. `network-policy-enforcement-integration.test.ts`:
   - the probe PASSes with every denial paired to a reachable negative control;
   - the external-egress variant PASSes;
   - real sessions cannot reach each other while sessions without policy can;
   - the admission gate refuses without a PASS and admits with one.
2. `npm run verify:network-policy`, the operator command itself, exiting 0.
3. The existing `integration.test.ts` and `labs-integration.test.ts`, under
   the tightened contract. They start K8S-001, 002, 006, 009, 010, 011, 012 and
   013 on a real cluster, **not all 19 labs**.
   - K8S-012 is the one lab whose Pod calls the API server. Its session starts,
     but no suite asserts that its Pod's API calls succeed: the setup check is
     `deployment_available`, and the curl loop stays up either way.
   - What covers the path: the probe asserts that a fenced Pod reaches the API
     server endpoint.
   - A manual measurement, not in CI: `curlimages/curl:8.5.0` under exactly the
     generated policies got HTTP 403 from `https://kubernetes.default.svc/api`,
     while its control, `https://1.1.1.1`, was blocked.
   - On kind that path is node-local, so it would work even without the
     allowance. On a CNI that governs it, only a probe PASS shows the allowance
     is sufficient.

`gates` (hermetic) runs the unit tests:
- CIDR complement properties;
- policy shape, including that no `except` or `0.0.0.0/0` is ever generated;
- the attestation rules;
- probe verdict rules;
- the provider gate;
- production config refusals.

CI proves enforcement **on kind**. It proves nothing about the production CNI,
which is the job of §9.

---

## 11. DECISION REQUIRED

| # | Decision | Why it is open |
|---|---|---|
| D1 | **Production Kubernetes substrate** (managed service, self-hosted, or other) | Not selected. Nothing here assumes one. |
| D2 | **Production CNI** and its NetworkPolicy implementation | Enforcement, `ipBlock` semantics, host-traffic handling and multi-node behavior all differ by CNI. Only a probe PASS on the chosen one counts. |
| D3 | **Node-local traffic control** (host firewall, security groups, CNI host policy, IMDS hardening) | NetworkPolicy cannot do it (§8). |
| D4 | **Pod Security admission level** for session namespaces (at least forbidding `hostNetwork`, `hostPort`, privileged) | Settled by BETA-P0-016 for the platform: `enforce=baseline`, `audit=restricted`, required by admission policy (docs/pod-security.md). It must still be proved on the production cluster (docs/pod-security.md §12). |
| D5 | **Who may run the probe and write the attestation**, and how often it re-runs (CronJob, deployment pipeline, manual) | Needs cluster-admin-equivalent rights; the cadence is an operational decision. |
| D6 | **Multi-node probe placement** (anti-affinity or explicit nodes for A, B and C) | Single-node kind cannot exercise it. |
| D7 | **Whether any lab should get external egress**, and through what (direct, egress proxy, allow-listed FQDNs) | None needs it today. FQDN policy is CNI-specific. |
| D8 | **Verifier ingress** for future `service_http`/`service_tcp` labs | Default-deny refuses traffic from outside the pod network. |

---

## 12. Configuration

| Variable | Default | Notes |
|---|---|---|
| `NETWORK_POLICY_ENABLED` | `true` | `false` refused in production |
| `CLUSTER_DNS_NAMESPACE` | `kube-system` | |
| `CLUSTER_DNS_POD_SELECTOR` | `k8s-app=kube-dns` | `k=v[,k=v]`; empty refused |
| `CLUSTER_POD_CIDR` / `CLUSTER_SERVICE_CIDR` | `10.244.0.0/16` / `10.96.0.0/16` | validated; host bits refused |
| `ALLOW_EXTERNAL_EGRESS` | `false` | permits, never grants: the lab must also declare `external_egress` |
| `CLUSTER_EGRESS_DENY_CIDRS` | empty | extra ranges external egress never reaches |
| `NETWORK_POLICY_ATTESTATION_REQUIRED` | `true` in production, else `false` | `false` refused in production |
| `NETWORK_POLICY_ATTESTATION_MAX_AGE_SECONDS` | `604800` | |

Changing any variable in the digest (everything above except `ENABLED` and the
two attestation settings) invalidates the current attestation.
