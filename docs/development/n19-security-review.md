# N19 — security review: `NET_ADMIN` on a seeded Docker container

**Status:** REVIEWED → IMPLEMENTED, tightly scoped (see §7). This review was
written before the code and is the record of why the grant is acceptable.

**One-line verdict.** Granting `NET_ADMIN` to a container declared in
`setup.docker.containers` is safe **because `NET_ADMIN` is network-namespaced**:
a container holds it over its own netns only, and a seeded container never
shares the sandbox's netns. The grant is confined to one sandbox, which is the
same blast radius a student already has. It is allowed only on the `docker`
provider, only as `NET_ADMIN`, and only on a container that is **not**
host-networked.

---

## 1. What NET-011 and NET-019 actually need

- **NET-011** seeds a container whose nftables rules `DROP` traffic to a port,
  so a student can diagnose "refused vs dropped". Installing an nft rule needs
  `NET_ADMIN`.
- **NET-019** seeds a NAT box that rewrites source addresses with
  `iptables -t nat`, and enables IP forwarding. Both need `NET_ADMIN`.

`setup.docker.containers` cannot express a capability, and the Docker provider
runs no seed scripts, so there is no way to put privileged network state into a
Docker lab's initial state today. That is the gap N19 fills.

NET-010 did **not** need this: the student runs the DHCP containers themselves,
and `--cap-add=NET_ADMIN` on a student-run container is the existing DinD
boundary, not a platform grant.

## 2. Threat model

| Actor | Capability today |
|---|---|
| Student, in their own inner daemon | Full control. Can `docker run --privileged`, `--cap-add=ANY`, `--network host`. The sandbox is `--privileged` DinD and its inner daemon is the student's. |
| Student, reaching other sessions | The sandboxes share one non-internal bridge (`jumptotech-sandboxes`) so the terminal can reach each daemon's TLS port. A student in `--network host` is on that bridge and can reach neighbour sandbox IPs. **This is pre-existing** and independent of N19 — see §5. |
| A **seeded** container (what N19 adds) | Today: none beyond a normal container. N19: `NET_ADMIN` over its own netns. |

The question N19 raises is narrow: **does giving a *seeded* container
`NET_ADMIN` let it affect anything outside its own network namespace** — another
container, the sandbox, the host, or another session?

## 3. Why the answer is no — `NET_ADMIN` is namespaced

`NET_ADMIN` authorises administration of the **network namespace the process is
in**: its interfaces, its routes, its firewall tables, its neighbour table. It
confers nothing over another namespace. A seeded `setup.docker` container is a
container of the student's *inner* daemon, in its own netns, attached to an
*inner* bridge. It is never in the sandbox's netns (that is what `--network
host` would do, and §6 forbids it for a capped container).

### Measured, on real sandboxes, 2026-09-16

Two sandboxes, `A` (10.199.0.10) and `B` (10.199.0.20), on one shared
non-internal bridge — the `jumptotech-sandboxes` model.

| Test | Result |
|---|---|
| `NET_ADMIN` container on an **inner** user network: its addresses | `172.18.0.2/16` — an inner-daemon address, not the shared bridge |
| …can it route to the shared bridge `10.199.0.0/24`? | **no route** |
| …can it reach neighbour sandbox B? | **unreachable** |
| …can it reach its own sandbox's shared-bridge IP? | **unreachable** |
| `NET_ADMIN` container: `ip link add … type dummy` (netlink write) | allowed — but only over **its own** netns |
| same container **without** `NET_ADMIN` | denied |

The capability works (so it enables the labs) and is confined (so it is safe).
The confinement is structural, not a firewall rule that could be misconfigured:
the inner container's netns simply does not contain the shared bridge.

## 4. Why a seeded capped container cannot be turned into a host-networked one

A student controls their inner daemon, so could they take the seeded
`NET_ADMIN` container and move it onto the sandbox's netns? No:

- You cannot `docker network connect` a container to the `host` network; host
  networking is fixed at creation.
- The student can *create their own* `--network host --cap-add=NET_ADMIN`
  container regardless of N19 (§5). N19 changes nothing there.

So the only host-networked capped container that could exist is one the **lab
definition** asks for, which §6 refuses.

## 5. The pre-existing shared-bridge exposure (not introduced by N19)

Measured while reviewing N19, and recorded because it deserves to be: a student
container run `--network host --cap-add=NET_ADMIN` in its own inner daemon sits
in the sandbox's netns, which is on the shared `jumptotech-sandboxes` bridge. It
can reach neighbour sandbox IPs (ping succeeded, <1ms) and can add a neighbour's
IP to the sandbox interface. Sustained ARP spoofing between sandboxes is
therefore possible.

This is a property of **the shared bridge plus privileged DinD**, both of which
predate this work, and it is within what the README already states DinD does not
protect against: *"Docker-in-Docker gives isolation between students, not a
hardened boundary against a determined attacker… a production deployment should
place each sandbox in a VM."* N19 neither creates nor widens it — a seeded capped
container is confined (§3), and a student's own host-networked container needs no
lab to grant anything.

It is worth a hardening follow-up independent of N19: making
`jumptotech-sandboxes` an `--internal` bridge would remove the sandboxes' route
off the host but **not** their reachability of each other, so the real fix is
per-session segmentation or per-tenant nodes/VMs, exactly as the README says.
Recorded as a finding in the run report; not a blocker for N19.

## 6. The implemented constraints — least privilege

| Constraint | Enforced where |
|---|---|
| Vocabulary is `NET_ADMIN` only | `SETUP_GRANTABLE_CAPABILITIES = ['NET_ADMIN']`; a `z.enum` in the setup schema. No `SYS_ADMIN`, `NET_RAW`, `SYS_PTRACE`, etc. |
| At most one cap, on at most a few containers | array `.max(1)` per container |
| Only the `docker` provider | `setup.docker` exists only for Docker labs; the linux/k8s sandbox-capability path (`SANDBOX_CAPABILITIES`, gated on `network: link`) is untouched and unrelated |
| A capped container may **not** be host-networked | schema refinement: `cap_add` present ⇒ `network !== 'host'` |
| `--privileged` still forced off | unchanged in `sessionRunContainer` |
| sandboxd re-validates, does not trust the spread | `sessionRunContainer` now picks `capAdd` explicitly and checks it against the allowlist and the no-host rule, instead of spreading the spec blindly |
| Does not persist past reset | reset re-creates containers from the same plan; a student cannot add a cap to a container the plan does not grant one to |

### The one change that also hardens existing code

`sessionRunContainer` previously spread the whole wire spec
(`...(spec as RunContainerSpec)`) and overrode only `name`, `image` and
`privileged`. Any future field on `RunContainerSpec` would have flowed through
unvalidated. N19 stops relying on that: the handler now constructs the spec
field by field, so `capAdd`, `network` and the rest are each validated or
dropped explicitly. This is a net improvement over the status quo even setting
the capability aside.

## 7. Residual risk, accepted

- A lab author could grant `NET_ADMIN` to a container that does not need it.
  That container can still only administer its own netns, so the cost is nil;
  and lab definitions are reviewed.
- The pre-existing shared-bridge exposure (§5) remains. It is out of scope for
  N19, is documented, and its fix is architectural (per-tenant isolation).

## 8. Decision

**Implement, tightly scoped**, per §6. The evidence in §3 shows the grant is
confined to one sandbox by the kernel's own namespacing, which is the same
boundary a student already sits inside. NET-011 and NET-019 become buildable.
