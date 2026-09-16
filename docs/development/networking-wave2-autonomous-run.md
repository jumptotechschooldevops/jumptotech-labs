# Networking Wave 2 — autonomous run, 2026-09-16

Platform capabilities first, then the labs they unlock. Three capabilities
audited, two implemented, one lab shipped, and three labs stopped at a gap the
wave never named — with that gap specified rather than worked around.

**Starting commit** `cb7804a` (origin/main)
**Branch** `feat/networking-wave2-platform`
**Final commit** `2d89a7a`
**Merged** nothing. **Force-pushed** nothing. **Existing branches and worktrees** untouched.

---

## 1. Commits

| | Commit | What |
|---|---|---|
| 1 | `7956dd0` | **N8** — `jumptotech/lab-docker` sandbox image + catalog availability gate |
| 2 | `3f5c1c7` | **N9** — `docker_exec_probe`, a closed-vocabulary container probe |
| 3 | `b895fde` | `workspace_file_exists` non-disclosure (cherry-picked, see §7) |
| 4 | `0558e54` | **NET-021** — Network Namespaces lab |
| 5 | `7708fff` | **Security fix** — a probe's target must be a container in its own session |
| 6 | `2d89a7a` | Roadmap status, verifier-contract reconciliation, Wave 3 audit |

29 files, +2982 / −40.

---

## 2. Phase 1 — audit, before writing anything

The roadmap names N5, N8 and N9 as Wave 2's capabilities. Checked against the
code rather than taken on trust, and **one of the three was already done and one
was mis-sized**.

| | Roadmap says | Repository says |
|---|---|---|
| **N5** | XS, to do | **Already implemented**, 2026-08-25. Optional `address` on `port_listening`/`port_not_listening`, single or list, normalised in one place, 44 tests. No work needed. |
| **N8** | XS — "add the networking tooling image to those labs" | The mechanism exists; **the image does not**. Measured below. |
| **N9** | M — "allow-listed argv inside a named container" | Genuinely missing — and the sketch's shape is one the platform has explicitly refused. |

Two further findings from the audit, both of which changed what got built:

- **`execInContainer` is deliberately not brokered.** `BrokerSessionEngine`
  refuses it, with the comment "each is the shape of a capability worth not
  having. `execInContainer` is arbitrary execution." N9 as sketched — a lab
  supplying an argv — would have re-opened a closed decision. It was built
  differently because of this.
- **N6 (`http_request`) already exists** in the `linux` family, contrary to the
  roadmap's "No" for NET-007/NET-020. Recorded; not acted on.

### The N8 measurement

| | `docker:27-dind` (sandbox) | `alpine:3.20` (lab image) |
|---|---|---|
| `ip` | BusyBox applet — no `-d`, no `ip netns`, no `-j` | BusyBox applet |
| `iptables` | yes | no |
| `nsenter`, `nslookup`, `wget` | yes | `nslookup`, `wget` |
| `tcpdump`, `nft`, `dig`, `curl`, `dnsmasq` | **none** | **none** |

`scripts/sandbox-build.sh` built four images; there was no `lab-net`. The three
images a Docker lab may use are `alpine:3.20`, `nginx:1.27-alpine` and
`busybox:1.36` — `jumptotech/*` images are built *by students during labs*, not
shipped.

---

## 3. N5 — address-aware port verification · **IMPLEMENTED (pre-existing) · TESTED · not re-implemented**

Already present and correct. Verified rather than assumed:

- schema: optional `address`, a single value or a list of up to six, on both
  `port_listening` and `port_not_listening`; omitting it preserves the previous
  meaning exactly, so no shipped lab changed;
- normalisation lives in one function (`normaliseBindAddress`), applied to both
  the lab's value and the kernel's, so the two cannot drift — and `0.0.0.0` is
  deliberately **not** treated as the same binding as `::`;
- 44 tests in `services/verifier/test/bind-address.test.ts`, passing.

**No code was written for N5.** Writing it again would have been the wrong call.

---

## 4. N8 — networking diagnostics in the Docker sandbox · **IMPLEMENTED · TESTED · MANUALLY VERIFIED**

### The decision

Four options were considered. The deciding argument is that this repository has
already solved this exact problem once: `sandbox-terraform.Dockerfile` bakes a
filesystem provider mirror so `terraform init` needs no registry at lab time.

| Option | Rejected because |
|---|---|
| Pull a third-party tooling image (`netshoot`) | Supply chain the platform does not control, a registry fetch on every lab start, and explicitly a "giant general-purpose security image" |
| Build and publish our own image | No registry exists in this architecture; the four sandbox images are used by the *host* daemon, never pulled by session daemons |
| `apk add` at lab time | Needs egress from a student's container at lab start, and makes initial state depend on a network fetch |
| **Bake into the sandbox image** | **Chosen.** Same trade as the Terraform mirror, one layer up |

### What shipped

`infrastructure/docker/sandbox-docker.Dockerfile` → `jumptotech/lab-docker`,
built by `npm run sandbox:build` alongside the other four, base pinned via
`ARG DIND_IMAGE=docker:27-dind`.

Six packages, each named by a lab in the curriculum: `iproute2` (the real `ip`),
`tcpdump`, `bind-tools`, `curl`, `nftables`, `netcat-openbsd`. **18MB over the
base** (539MB vs 521MB). No scanner, no packet crafter, no exploit tooling — a
test asserts their absence so a later `apk add` line cannot quietly widen scope.

The Dockerfile smoke-tests itself: `command -v` per binary plus `ip -d link show`
and `ip -j link show`, which is what proves iproute2 shadowed the BusyBox applet.
A base bump that drops a tool fails the build, not a student's lab.

**Where the tools are, and are not.** In the *sandbox* — the Docker host from a
student's point of view. That is where a container's veth peer, the bridge it is
attached to, and a DHCP exchange on that bridge actually live. Tools *inside a
student container* are a different problem, unsolved, recorded as N18 (§8).

### Lifecycle and the honesty gate

Because the sandbox image is now locally built rather than an upstream tag the
host daemon pulls on demand, its absence is a misconfiguration. `availability()`
gained a third gate reporting it in the catalog with `npm run sandbox:build` as
the remediation — the same gate `ContainerLabProvider` already applies to the
Linux and Terraform images. Order matters: a deployment that has not enabled
Docker at all is told *that*, not told to build an image it has no use for.

Reset is unaffected (reset replaces containers, never the sandbox image).
Session isolation is unaffected (same sandbox container). No `USER`,
`ENTRYPOINT`, `CMD`, capability or credential changes — asserted by test.

### Manual validation

Started as production does (`--privileged`, `DOCKER_TLS_CERTDIR`, a volume at
`/var/lib/docker`) and confirmed against a real daemon:

- boots as a working DinD sandbox — `docker info` answered after 2 polls;
- a container's `eth0` iflink `15` resolved to the host-side
  `15: veth7ed9442@if14 … master br-6c30700f4cd1 … link-netnsid 1`;
- `ip -d link show type bridge` returned full bridge detail BusyBox cannot give;
- `tcpdump` on a user-defined bridge captured the ARP and ICMP of a real
  container-to-container exchange.

`--privileged` here is not a convenience: Docker-in-Docker cannot run without it
and the provider already sets it. This reproduced the approved production
configuration rather than relaxing anything.

---

## 5. N9 — `docker_exec_probe` · **IMPLEMENTED · TESTED · MANUALLY VERIFIED**

### The design constraint that shaped it

`execInContainer` is refused at the broker on purpose. So a probe **is not a
command**. A lab names one of four questions and supplies typed operands:

```yaml
- type: docker_exec_probe
  container: netns-none      # a container in this session's own daemon
  probe: interface_exists    # closed enum: dns_lookup | tcp_connect | http_get | interface_exists
  interface: eth0
  expect: failure            # success | failure
  timeout_seconds: 10        # 1..30
```

`services/lab-orchestrator/src/docker/probes.ts` is the single place an argv is
built. **Both** sides of the broker call it — `sandboxd` builds the command on
its own side from the probe it received — so the argv never travels as data and
`execInContainer` stays refused. This is the `VERIFIER_INTERNAL_COMMANDS`
arrangement the repository already uses for `ip`, applied to a container.

### Security properties, and where each is enforced

| Property | Where |
|---|---|
| No executable, flag or argv in the schema | `.strict()` refuses unknown keys; no field carries one |
| Exactly the operands a probe takes — no more, no fewer | `superRefine`; a stray `path` on a `tcp_connect` is refused at load |
| Operand grammars | host: no leading dash, slash, colon, at-sign or percent. path: no query, fragment, `..` or `//`. interface: ≤15 chars. port: 1–65535 |
| **Target ownership** | Must resolve to a container the session-scoped reader can see (§7) |
| No shell | argv → `docker exec` → `execve`; `--` terminates option parsing before the container name |
| Timeout | bounded 1–30s in schema, re-validated, exec budget = probe + 2s |
| Output cap | 64KiB, and only one probe reads output at all |
| Session isolation | reader holds one daemon and takes no daemon parameter; broker keyed on `sessionId` via `#ownedSandbox` |
| Re-validation across the process boundary | `assertContainerProbe` runs again in `sandboxd` — it is reached over HTTP |
| Non-disclosure | output never quoted back; details carry the question and verdict only |

### Failing closed

Missing container, stopped container, refused probe, unreachable daemon, and
timeout are all failures. Two rulings worth stating:

- **A timeout fails under *both* expectations.** A timeout is the absence of an
  answer, not evidence of one; `expect: failure` must not be satisfied by a
  probe that never returned, or a dropped packet and a broken environment become
  the same observation.
- **`interface_exists` fails when the listing could not be obtained.** `ip -o
  link show` exits 0 whether or not the interface is there, so the listing is
  parsed — but a non-zero exit means *no listing*, and an empty listing
  trivially lacks the interface. Reading that as "absent" would let an image
  with no `ip` prove a namespace is isolated. **This was a real hole in the
  first draft**, caught by the test written to look for it.

### Manual validation — 17 checks against a real daemon

Every probe kind positive and negative; wrong container; stopped container;
timeout; and five disallowed inputs refused before anything ran. The measurement
NET-011 will need came out as designed:

| | result | elapsed |
|---|---|---|
| open port | ok | 61ms |
| **closed port (refused)** | fail | **64ms** |
| **blackholed address (dropped)** | fail | **2051ms** |

Refused and dropped are distinguishable by timing, which is the whole lesson of
NET-011.

### Tests

94 total: 70 in `container-probes.test.ts` (vocabulary, ~40 hostile operands,
schema completeness, hostile-key rebuild), 24 in `docker-exec-probe.test.ts`
(verdicts, failure modes, ownership gate, non-disclosure, isolation).

---

## 6. NET-021 — Network Namespaces · **IMPLEMENTED · TESTED · MANUALLY VERIFIED**

The curriculum lab that replaces "containers are isolated" with something a new
engineer can run: one image on three network modes, then the host side of a
container's link. Consumes both new capabilities — N9 for the three modes, N8
for the veth half (BusyBox `ip` cannot name a peer or a master).

**A measurement changed the design.** A `--network none` container is **not**
"only `lo`". This kernel auto-creates nine tunnel devices (tunl0, gre0, gretap0,
erspan0, ip_vti0, ip6_vti0, sit0, ip6tnl0, ip6gre0) in every fresh namespace
because those modules are loaded. A lab grading an interface *count* would pass
here and fail on a host without them. **`eth0` is the portable signal**, and that
is what `interface_exists` grades.

The other measurement, which is the lesson: from a namespace with nothing
plumbed in, a connect to an unroutable address fails in **0.00s** — no route to
try. From a bridge namespace the identical command takes the full **3.00s**
timeout. Same command, same target, two different failures.

20 checks: the network, three containers' networks/state/images, five probes,
three worksheets. Every probed container has `docker_container_image` pinned
beside it, because a probe observes behaviour in a container the student
controls. The veth pair is **not** graded on a literal — its name and peer index
are per-run — so `veth.txt` is graded on the shape of real `ip -o link` output
(`veth`, `@if`, `master`), which a student who did not run the command lacks.

NET-005 is the only declared prerequisite; NET-010 is still unimplemented.
**NET-022's prerequisite was resolved**: it shipped with `prerequisites: []` and
a header saying that would change when NET-021 landed. It has.

### Manual validation — full lifecycle on a real DinD sandbox

| Phase | Result |
|---|---|
| seeded baseline | **LAB NOT COMPLETE, 1/20** |
| student repair path | three containers, network created, peer attached |
| solved | **LAB PASSED, 20/20** |
| reset (containers + networks removed, peer re-seeded, images kept) | **LAB NOT COMPLETE, 1/20** |

Re-run in full after the §7 security change: baseline 1/20, solved 20/20.

18 tests in `services/verifier/test/networking-net021.test.ts`, including the
two shortcuts that matter — deleting the container to satisfy "has no eth0", and
starting all three on one network.

---

## 7. Phase 9 — security review of the diff

Reviewed as an attacker. Three findings, all fixed.

### Finding 1 — a probe could be aimed at any host · **FIXED** (`7708fff`)

`docs/docker/VERIFIER-CONTRACTS.md` §3.1 states the invariant: *a lab may not
name a host, an IP address, or a URL*, because a syntactic check still accepts
`169.254.169.254`, `host.docker.internal`, the platform's own API and every
Internet host. My schema validated `host` syntactically and stopped.

Fixed with §3.3's own answer — an allowlist of one shape, not a blocklist: the
target must resolve to a container the session-scoped reader can see. The reader
holds one daemon and takes no daemon parameter, so those hosts are unnameable by
construction. It runs before any probe, and fails under `expect: failure` too —
otherwise "must not be reachable" could be satisfied by naming something that
was never there.

§3.3's gate 3 (*from and to must share a network*) was deliberately **not**
adopted: it short-circuits the negative case by inspecting the daemon's view,
and that case is exactly what NET-021 must *observe*. Pinned by a test.

NET-021's probe moved from the literal `10.255.255.1` to the peer container. The
student still uses the literal for their own timing — a student may type any
address in their own shell; this is about what a *lab definition* can make the
platform do. Timeout raised to 10s because with no resolver the in-container
lookup exhausts its retries first, measured at 5.00s.

### Finding 2 — `interface_exists` could be fooled in the dangerous direction · **FIXED**

See §5. Non-zero exit now fails under both expectations.

### Finding 3 — `workspace_file_exists` disclosed the values it graded · **FIXED** (`b895fde`)

It answered a failed check by listing the fragments it could not find, and that
detail is serialised to the browser. One Check Solution against a blank worksheet
handed over every answer on it. Same channel PLATFORM-SEC closed for
`terraform_output_equals`. **This fix was written earlier on
`feat/net-023-container-dns` and is cherry-picked here**, not rewritten, so the
two branches carry the identical commit and merge cleanly. NET-021 needs it: it
grades worksheet answers.

### Checked and clear

Shell injection (no shell anywhere; argv asserted free of metacharacters) ·
arbitrary `docker exec` (still refused at the broker; `docker.execs` asserted
empty in lab tests) · container escape and Docker socket (untouched) ·
cross-student and cross-session access (structural — one daemon per reader,
broker keyed on session id) · path traversal (`..`, `//` refused) · unbounded
output (64KiB) · unbounded timeout (1–30s, two layers) · resource exhaustion
(bounded exec budget) · egress expansion (probes use the container's existing
network; the N8 image changes no network configuration) · secret exposure (no
credential in the image, no `ARG *_TOKEN`, no fetch outside the base repos) ·
unsafe image tags (base pinned by `ARG`; our own `:latest` matches the four
existing sandbox images) · reset (unchanged) · verifier trusting student output
(documented bound; image pinned beside every probe).

One investigated and **not** a vulnerability: a `__proto__` key in a
JSON-parsed probe. `assertContainerProbe` *rebuilds* a fresh object with only
validated keys, so the hostile key never reaches `probeArgv` or the broker, and
nothing is polluted. Pinned by a regression test because the property is
non-obvious.

---

## 8. Labs still blocked — and exactly why

NET-010, NET-011 and NET-019 were **not** built. Verified, not assumed:

- `setup.docker` has **no** capability, sysctl or privileged field;
- the Docker provider **never runs seed scripts** — `setup.docker` is the only
  seeding mechanism a Docker lab has;
- the three lab-usable images carry BusyBox and nothing else.

| Lab | Needs |
|---|---|
| **NET-010** | `dnsmasq` + `tcpdump` in a lab container (**N18**) and `NET_ADMIN` on the DHCP client (**N19**) |
| **NET-011** | `nft`/`iptables` inside the seeded topology container (**N18**) |
| **NET-019** | a NAT box that can actually NAT — **N18** + **N19** — and its prerequisite NET-011 |

Both are recorded in `labs/networking/CURRICULUM.md`:

- **N18** — a lab-usable diagnostics image *inside the session daemon*,
  delivered offline. The architecture-consistent design is the Terraform
  mirror's: bake a `docker save` tarball into the sandbox image and load it.
  **Known hazard, found while designing it:** the provider mounts a fresh volume
  at `/var/lib/docker`, masking anything the image pre-populated there, so the
  load must happen after dockerd starts — and the readiness gate (`docker info`)
  can pass before it finishes. A naive entrypoint loader is racy. This is why it
  was not rushed into this run.
- **N19** — `cap_add` on a seeded container. It reaches `--cap-add` inside an
  already-privileged DinD sandbox, so the blast radius is one session, but it is
  a security decision and should be argued for on its own rather than arriving
  alongside a lab.

**NET-006** needed nothing: the partial shipped 2026-08-25 with N5. The wave list
was stale on that point.

Building any of the three without N18/N19 would mean a lab that cannot do what
its own task text asks.

---

## 9. Wave 3 audit

- **N12** — confirmed for the platform contract (BETA-P0-015): kindnetd enforces
  deny-all, pod/namespace selectors, ports and plain `ipBlock`, measured with
  negative controls and attested in CI. **The remainder for NET-026 is now
  precise:** `service_http` and `service_tcp` have **no negative form**, so
  "resolves but every connection times out" — the entire symptom NET-026 teaches
  — cannot be expressed. Recorded as **N20**.

  It is *not* a copy of N9's `expect: failure`. N9 rules that a timeout fails
  under both expectations; a deny test wants a timeout to be the **pass**. Both
  rules are right in their own place, and having both needs a **positive
  control** — a deny check paired with a connection that must still succeed, or
  "the cluster is broken" and "the policy works" are the same observation. That
  pairing is the design work, and it belongs before the lab.
- **N13** — **not started.** `infrastructure/kind/cluster.yaml` declares no
  ingress controller and no `extraPortMappings`, and nothing installs one. The
  substantive question is unanswered: one shared controller across per-student
  namespaces is a cross-session surface, and that should be settled first.

No Wave 3 code was written. Neither item is "clearly specified safe groundwork"
yet, and N20's rule conflict is exactly the kind of thing that should not be
resolved in the last hour of a run.

---

## 10. Test results

| Suite | Result |
|---|---|
| `services/lab-orchestrator` | **1342 passed**, 253 skipped, 0 failed (82 files) |
| `services/verifier` | **1602 passed**, 0 failed (71 files) |
| `services/sandboxd` | **138 passed**, 7 skipped, 0 failed |
| `services/progress` | **96 passed**, 1 skipped |
| `services/observability` | **696 passed**, 36 skipped |
| `services/terminal` | **127 passed** |
| `apps/web` | **195 passed** |
| `apps/api` | 253 passed, **23 files fail to collect** — pre-existing, §11 |

Typecheck: `lab-orchestrator`, `verifier`, `sandboxd`, `web` — **0 errors**.
`api` and `terminal` — 4 each, all in `apps/api/src/rate-limit.ts`, pre-existing.

**Skipped, precisely:** 253 in `lab-orchestrator` are the integration suites
(`RUN_INTEGRATION_TESTS=1` plus a kind cluster or Docker daemon); each prints
its own skip reason. 7 in `sandboxd`, 1 in `progress`, 36 in `observability` are
the same shape. Nothing was skipped to make this run green.

New tests added: 70 (`container-probes`), 24 (`docker-exec-probe`), 18
(`networking-net021`), 12 (`docker-sandbox-image`), 2 (`docker-requirements`
non-disclosure and provider-scope) — **126**.

---

## 11. The pre-existing `express-rate-limit` failure

`apps/api` fails to collect 23 of 39 test files. Cause: `express-rate-limit` is
declared in `apps/api/package.json` (`^8.7.0`) but **is not present in
`node_modules`**. Nothing in this run touches it.

**Proved, not asserted.** With my only `apps/api` change (3 lines in
`providers.ts`) temporarily reverted to the starting commit, the result is
identical — 23 failed files, 253 passed, 0 failed tests. `npm install` fixes it.

One earlier run of that suite reported 24 failed files and 3 failed tests. It did
not reproduce on repeat, and this machine is running 19 worktrees and several
compose/kind stacks; it is recorded here as an observed flake rather than
explained away.

---

## 12. Files changed

```
infrastructure/docker/sandbox-docker.Dockerfile              new   (N8)
scripts/sandbox-build.sh                                     ~25   (N8)
docker-compose.yml, docker-compose.runtime.yml, .env.example  ~     (N8)
services/lab-orchestrator/src/providers/docker-provider.ts   +71   (N8 gate)
services/lab-orchestrator/src/docker/probes.ts              new   (N9)
services/lab-orchestrator/src/docker/port.ts                 +23   (N9)
services/lab-orchestrator/src/docker/cli-client.ts           +35   (N9)
services/lab-orchestrator/src/docker/broker-engines.ts       +23   (N9)
services/lab-orchestrator/src/requirements.ts                +99   (N9)
services/sandboxd/src/docker-ops.ts                          +36   (N9)
services/verifier/src/handlers/docker-probe.ts              new   (N9)
services/verifier/src/docker-reader.ts, registry.ts           ~     (N9)
services/verifier/src/handlers/docker-workspace.ts           ~27   (disclosure)
labs/networking/net-021-network-namespaces/lab.yaml          new   (lab)
labs/networking/net-022-port-publishing/lab.yaml              ~     (prerequisite)
labs/learning-paths/devops-engineer.yaml                      +3    (path)
labs/networking/CURRICULUM.md                                 ~     (status)
docs/docker/VERIFIER-CONTRACTS.md                             ~     (N9 reconciliation)
+ 5 test files (4 new)
```

---

## 13. Known limitations

1. **A probe is not tamper-proof.** It runs in a container the student controls
   and chose the image for. It is strictly better than asking them to report a
   result, and is not proof against one who sets out to forge it. Every lab using
   one pins `docker_container_image` beside it. Documented in `probes.ts`.
2. **IPv6 targets are not supported** by the probe vocabulary — brackets in a
   URL and bare form elsewhere is two shapes for no lab that needs one yet.
3. **Probe targets must be container names**, so a lab cannot probe an address
   with a dot-and-TLD form even when it is internal. That is the §7 ownership
   gate working as intended, and the cost is worth naming.
4. **`jumptotech/lab-docker:latest`** is a floating tag for our own build, which
   matches the four existing sandbox images. The *base* is pinned by `ARG`.
5. **N8's tools are in the sandbox, not in lab containers** — §8.
6. **The N8 image was validated on Docker Engine 28.4.0** on this host; the
   image's own base is `docker:27-dind`. The Dockerfile's smoke test runs at
   build time on whatever base is pinned, which is the mitigation.

---

## 14. Next three recommended tasks

1. **Decide and build N18** — offline lab-image delivery into the session
   daemon. It is the single gate on NET-010, NET-011 and NET-019. The design is
   sketched in the roadmap; the `/var/lib/docker` masking race is the part that
   needs solving, and an explicit provider step before `#ensureImage` falls back
   to a pull is the likeliest answer.
2. **Review N19** — `cap_add` on a seeded container. Smaller than N18 and a
   security decision rather than a schema change; it should be argued on its own.
   NET-011 needs only N18, so it can ship before N19 lands.
3. **Design N20's positive control** before attempting NET-026 — a deny check
   paired with a connection that must still succeed. Without it, "the policy
   works" and "the cluster is broken" are indistinguishable, and that is a worse
   failure than not having the check.

Then: NET-011 (N18 only) → NET-010 → NET-019, in that order.
