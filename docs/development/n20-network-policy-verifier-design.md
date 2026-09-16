# N20 — a lab-level behavioural NetworkPolicy verifier

**Status:** DESIGNED, not implemented. This is the design the run report points
to for NET-026. No executor is written here — the prompt's constraint ("do not
implement a dangerous executor just to reach NET-026") is taken seriously, and
the executor is the part that needs its own review and a cluster to test on.

---

## 1. The problem, stated precisely

NET-026 teaches "it resolves but it will not connect": a Pod resolves a Service
and every connection to it times out, because a default-deny NetworkPolicy has
no rule permitting the traffic. The student writes a policy that allows it and
proves the connection now works.

Grading that behaviourally needs a probe that answers **"can source workload A
reach destination B"**, and the current vocabulary cannot express it. Two gaps,
both measured in the code on 2026-09-16:

1. **`service_http` / `service_tcp` probe from the verifier, not from a Pod.**
   `KubernetesClient.checkServiceHttp` does `fetch(http://<clusterIP>:<port>)`
   from the verifier process. That traffic originates from the verifier's
   network identity, not from a Pod matching the policy's `from` selector. A
   NetworkPolicy that allows or denies *by source Pod or namespace* — which is
   every interesting policy — is invisible to it.

2. **There is no negative form.** Both checks assert *reachable*. NET-026's
   whole symptom is a connection that must be **unreachable** until the student
   fixes it, and a segmentation lab's point is a connection that must **stay**
   unreachable. Neither is expressible.

## 2. Why this is not "just invert N9"

N9's `docker_exec_probe` rules that a **timeout is a failure under both
expectations** — a timeout is the absence of an answer, not evidence of one. A
deny test wants the opposite: a timeout is the *expected* outcome, the pass.

Inverting N9 would make "the connection was denied" and "the cluster is broken /
the CNI is down / the Pod never started" the same observation. That is the exact
mistake this design exists to prevent, and it is prevented not by cleverer
timeout handling but by a **positive control**.

## 3. The core idea: every deny is paired with an allow

A NetworkPolicy assertion is only meaningful as a pair:

| Role | Probe | Must observe |
|---|---|---|
| **positive control** | a connection the policy *allows* | reachable |
| **assertion (negative)** | the connection the policy *denies* | blocked |

If the positive control fails, the run is **inconclusive, not a pass and not a
fail** — the cluster or the workloads are broken, and the deny result carries no
information. Only when the allowed connection succeeds does a blocked connection
mean "the policy denied it".

This is not invented here. The platform's own NetworkPolicy attestation
(`network-enforcement-probe.ts`, BETA-P0-015) already uses exactly this shape —
`ProbeCheckRole` is `'control' | 'assertion' | 'informational'`, and a run whose
control does not hold is discarded. N20 brings that discipline to a *lab's* own
grading. The lab-level verifier should reuse that probe's `kubectl`-driven
runner rather than growing a second executor.

## 4. The proposed requirement — `network_reachable`

```yaml
- type: network_reachable
  from:                       # the source workload — a Pod selector
    pod_selector: { app: client }
  to:                         # the destination
    service: ledger-api       # a Service in this namespace
    port: 80
  protocol: tcp               # tcp | udp, default tcp
  expect: allowed             # allowed | denied
  timeout_seconds: 5          # 1..15
  label: "..."
```

- `from` names a **Pod selector in the lab's own namespace**. The probe runs
  from a Pod the selector matches — the traffic genuinely originates where the
  policy reasons about it. If nothing matches, the check fails "no source Pod",
  never passes.
- `to` names a Service (resolved to its ClusterIP in the namespace) and a port.
- `expect: denied` is the negative form NET-026 needs. A denied probe passes
  when the connection does **not** establish within the timeout; a timeout is
  the pass here, deliberately and unlike N9, and safe **only** because §5
  requires a positive control in the same lab.

### The paired-control rule, enforced at load time

A lab that uses `network_reachable` with `expect: denied` **must** also declare
at least one `network_reachable` with `expect: allowed` sharing the same `from`
selector. This is a schema-level `superRefine` over the requirement list — the
same style the probe schema uses to require exactly one operand set. Without it,
a lab could ship a deny-only assertion, which is the indistinguishable-from-
broken case. The refinement makes the positive control unforgeable: it is not a
convention, it is a load error to omit it.

## 5. Execution model (designed, not built)

Reuse `network-enforcement-probe.ts`'s runner:

1. The verifier finds a Pod matching `from.pod_selector` in the namespace (must
   exist and be Ready, or the check fails "no ready source Pod").
2. It runs a bounded probe **from that Pod** — `kubectl exec <pod> -- <fixed
   argv>` against the destination ClusterIP and port, exactly like the platform
   probe, with a closed argv (no shell, no lab-supplied command) and the same
   timeout and output caps.
3. `allowed` passes on a successful connect; `denied` passes on a clean
   connect-refused-or-timeout. Any error that is neither — the Pod missing,
   `kubectl` failing, the namespace unreachable — is inconclusive, never a pass.

The executor is the part that needs review: `kubectl exec` into a session Pod is
a real capability, and it must be as tightly bounded as N9's probe (fixed argv,
no student input, session-scoped namespace, bounded time and output). It is
**not** written here.

## 6. Security envelope (for whoever implements §5)

| Concern | Requirement |
|---|---|
| Arbitrary exec | fixed argv built in trusted code, as N9's `probeArgv`; a lab names a selector and a target, never a command |
| Namespace isolation | the probe runs in the lab's own namespace only; the runner is constructed with it and takes no namespace argument |
| Source selection | `from.pod_selector` selects within that namespace; a selector matching nothing fails, never passes |
| Bounded execution | 1–15s, one probe per check, output capped |
| Timeout semantics | timeout = pass only for `expect: denied`, and only valid alongside a passing positive control |
| Non-disclosure | structural detail only, never response bodies |

## 7. What ships when

- **This document** — now.
- **The schema + the paired-control refinement + validation tests** — a small,
  safe, executor-free step that can land next and pins the contract. It is the
  natural first commit and needs no cluster.
- **The executor** — after a review of the `kubectl exec` boundary, on a branch
  with a kind cluster to test against, reusing the BETA-P0-015 runner.
- **NET-026** — once the executor exists and is validated with negative controls
  on kindnetd (whose enforcement N12 already confirmed).

## 8. Relationship to N12

N12 confirmed the *platform's* NetworkPolicy contract: kindnetd enforces
deny-all, selectors and ports, measured with negative controls in CI. N20 is the
*lab's* verifier, which assumes that enforcement and grades a student's own
policy against connections. N20 does not re-measure N12; it depends on it.
