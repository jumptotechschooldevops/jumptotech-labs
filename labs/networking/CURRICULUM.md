# JumpToTech Labs — Networking Track

**Status: design proposal. Nothing in this document is implemented.**

Scope: a 33-lab track taking a student from "what is a network" to diagnosing a
production 502 at 3am, across Linux, Docker, Kubernetes and AWS.

This document has three parts:

1. **Platform reality** — what the current sandbox can and cannot do, read out of
   the code, not assumed.
2. **The curriculum** — 33 labs in 7 phases, each with the full lab spec.
3. **Capability roadmap** — the sandbox and verifier work the track needs, in
   dependency order, with what ships without any platform change at all.

---

## Part 0 — Design principles

The brief asks for students who *troubleshoot* rather than *recall*. Four rules
follow from that, and every lab below obeys them.

**1. Grade the state, not the command.** Already the platform's rule
(`requirements.ts`: a lab names a type from a closed vocabulary; a student passes
by leaving the right state behind). A networking track strains it, because most
networking work leaves no file behind — so every lab here has an explicit
answer to "what artefact proves this student understood it".

**2. Findings files are the primary evidence for understanding.** A lab that asks
for a *value the student could only have obtained by looking* — the MAC of
`eth0`, the TTL the authoritative server returned, which of three backends the
proxy skipped — is gradeable with `file_content` today, and cannot be passed by
pattern-matching a command from a cheat sheet. Every diagnostic lab requires a
short diagnosis note naming **the layer, the evidence, and the mechanism**.

**3. Fault-injection labs must verify the fault is *gone*, not just that the
service is up.** Otherwise "delete the app and reinstall it" passes. Pattern:
`file_content_absent` on the injected fault line + a positive reachability check.
The Linux track already uses this shape; the networking track uses it everywhere.

**4. Symptoms are the vocabulary.** `connection refused` vs `connection timed
out` vs `no route to host` vs `NXDOMAIN` vs `502` vs `504` are each a *different
mechanism*, and the track teaches the mapping from symptom → layer → cause. This
is the single highest-value thing the track can transfer, and it is what
distinguishes it from a command tutorial.

---

## Part 1 — Platform reality

Read from the code on `claude/networking` at `93876a4`.

### What exists

| Component | State |
|---|---|
| Providers | `kubernetes`, `linux`, `docker`, `terraform`, `aws` (`providers/catalog.ts`) |
| Linux sandbox | Debian bookworm container, `runit`, `sudo`, per-session, `providers/linux-provider.ts` |
| Docker sandbox | per-session **privileged** `docker:27-dind`, own daemon over mTLS, on `jumptotech-sandboxes` bridge |
| Kubernetes sandbox | namespace in a shared `kind` cluster, `kindest/node:v1.34.0`, single control-plane |
| Terraform sandbox | Linux image + CLI + **offline** provider mirror (`local`, `random` only) |
| AWS provider | **stub** — every lifecycle method refuses with `PROVIDER_UNAVAILABLE`, unconditionally |
| Verifier vocabulary | 4 families: `kubernetes`, `filesystem`, `linux`, `docker` (`requirements.ts`) |
| Student shell (docker/k8s labs) | the **terminal service container**, with `kubectl`, `docker`, `docker compose`, `jq` |

### The five constraints that shape this track

**C1 — The Linux sandbox has no network at all.**
`SANDBOX_NETWORK=none` (`.env.example:70`, `session/types.ts:326`). The container
gets `lo` and nothing else: no `eth0`, no gateway, no route table worth reading,
no peer to talk to. Correct for a filesystem-and-processes track; fatal for
roughly half of a networking one. It is one config value, but changing it needs a
deliberate design (below), not a flag flip.

**C2 — `NET_ADMIN` and `NET_RAW` are not grantable.**
`GRANTABLE_CAPABILITIES` (`providers/container/runtime.ts:441`) is a 9-entry set
— `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `SETGID`, `SETUID`, `SETPCAP`,
`KILL`, `AUDIT_WRITE`. `--cap-drop ALL` is unconditional and a provider may only
re-add from that set. So in a Linux-family sandbox a student cannot `ip route
add`, cannot write nftables rules, cannot `tcpdump`, cannot create a netns.
**The Docker sandbox is the escape hatch**: it is already `--privileged`, so
inside their own nested daemon a student can `docker run --cap-add=NET_ADMIN`
freely, and that grants nothing on the host that the DinD sandbox did not already
grant. Several labs below are placed on the Docker provider for exactly this
reason.

**C3 — No networking tools are installed anywhere a student has a shell.**
The Linux image (`sandbox-linux.Dockerfile`) ships `iproute2`, `iputils-ping`,
`netcat-openbsd`, `socat` — and **no `curl`, no `dig`/`nslookup`, no
`traceroute`, no `tcpdump`, no `openssl` CLI**. The terminal image installs
`curl` during build and then **purges it** (`terminal.Dockerfile:74`).
*Existing-content note, reported not fixed (Linux track is out of scope for this
branch): `LINUX-006` instructs students to use `curl` and cites `man curl`, and
neither exists in the image it runs on.*

**C4 — The verifier cannot see a bind address, and cannot speak HTTP outside
Kubernetes.**
- `port_listening` takes `port` + `protocol` only (`requirements.ts:1210`) — so
  the platform **cannot currently tell `127.0.0.1:8080` from `0.0.0.0:8080`**,
  which is the single most common real-world networking bug. Good news: the
  reader already runs `ss -H -lntu` and `parseListeningSockets` already keeps
  `address` (`sandbox-reader.ts:302`). The data is there; only the schema and
  handler are missing.
- `service_http` / `service_tcp` are **`kubernetes`-family only**, and work by
  `fetch()`-ing the Service ClusterIP directly from the verifier process
  (`k8s/client.ts:743`). No equivalent exists for Linux or Docker sandboxes.
- `VERIFIER_COMMANDS` (the allow-list for `command_output`) has `ss`, `getent`,
  `hostname`, `cat`, `grep`, `awk` — but **not `ip`, not `dig`, not `curl`**.
  `getent` is genuinely useful: `getent hosts <name>` grades DNS resolution today.

**C5 — AWS is not runnable, and Terraform is offline.**
The AWS provider is a documented stub with no enabling flag. The Terraform image
mirrors only `hashicorp/local` and `hashicorp/random`, deliberately, so the
sandbox can run `--network none`. Real AWS networking labs need either LocalStack
(egress + an AWS provider mirror + a service container) or nothing. The two AWS
labs below are therefore designed as **design-and-reasoning labs with literal,
deterministic answers** — which are gradeable today and are, for VPC routing and
SG-vs-NACL semantics, arguably the better pedagogy anyway.

### What this means for substrate choice

| Substrate | Notation below | Good for |
|---|---|---|
| Linux sandbox, unchanged | `linux` | pure reasoning/calculation labs, socket + service inspection on loopback |
| **Proposed** networking sandbox | `net` | interfaces, routes, ARP, DNS, TLS, proxies — anything needing a real link and a peer |
| Docker sandbox (privileged DinD) | `docker` | namespaces, veth, NAT, firewalls, multi-host topologies, anything needing `NET_ADMIN` |
| kind namespace | `k8s` | Pod/Service/DNS/NetworkPolicy/Ingress |
| Terraform sandbox | `tf` | cloud-as-code modelling, offline |

---

## Part 2 — The curriculum

33 labs, 7 phases. `ID · title · substrate · difficulty · duration`.
(NET-033 was added by the official-source review — see Part 4.)

Progression: **Fundamentals → Linux Networking → DNS & Application Protocols →
DevOps Networking → Container & Kubernetes Networking → Cloud → Production
Incidents.** Difficulty rises with phase; every phase ends on a fault the student
must find rather than a task they must perform.

---

### Phase 1 — Networking Fundamentals (NET-001 … NET-005)

---

#### NET-001 · What a Network Is: Hosts, Addresses and Names
- **Substrate** `net` · **Difficulty** beginner · **Duration** 25 min
- **Skills** `net.model.host-identity`, `net.addressing.read`, `net.tools.ip`, `net.model.lan`
- **Prerequisites** none
- **Scenario** — You have a shell on a JumpToTech Bank host that someone has
  called "unreachable". Before anyone escalates, establish what this machine
  *is* on the network: what it is called, what interfaces it has, what addresses
  those carry, and which of those addresses another machine could ever use.
- **Initial state** — Sandbox on its own internal bridge with a deterministic
  address (`10.90.0.10/24`, gateway `10.90.0.1`), a peer host `bank-peer`
  (`10.90.0.20`) on the same segment, and an empty `/home/student/findings`.
- **Student task** — Write four one-line files into `findings/`: `interface.txt`
  (the non-loopback interface name), `address.txt` (its IPv4 address with
  prefix), `mac.txt` (its hardware address), and `reachable.txt` containing
  either `10.90.0.10` or `127.0.0.1` — whichever address the peer could actually
  use to reach this host — plus one sentence saying why the other one cannot work.
- **Tools** `ip addr`, `ip link`, `hostname`, `ping`, `/sys/class/net`
- **Verification** — `file_content` against the deterministic seeded values
  (`10.90.0.10/24`, the seeded MAC); `file_content` on `reachable.txt` requires
  both the correct address **and** the words `loopback`/`this host` in the
  justification, so the 50/50 guess does not pass.
- **Supported today?** No — needs `net` sandbox (C1, C3).
- **New capability** N1 (net sandbox image), N2 (internal bridge + deterministic
  addressing), N3 (peer host in the topology).

---

#### NET-002 · IPv4, CIDR and Subnet Masks: Who Is On My Network
- **Substrate** `linux` (unchanged) · **Difficulty** beginner · **Duration** 30 min
- **Skills** `net.cidr.calculate`, `net.subnet.mask`, `net.addressing.private-vs-public`, `net.subnet.plan`
- **Prerequisites** NET-001
- **Scenario** — The bank is splitting a flat `10.20.0.0/16` into per-environment
  subnets before a cloud migration. Networking has asked platform engineering to
  produce the addressing plan and to say, for each of six addresses, whether it
  is routable on the public internet.
- **Initial state** — `/home/student/subnets/worksheet.txt` with six CIDR blocks
  and six addresses; `plan.txt` and `answers.txt` to be written.
- **Student task** — For each CIDR: network address, broadcast address, first and
  last usable host, usable host count. For each address: `private`, `public`, or
  `loopback`. Then propose three non-overlapping `/20`s inside `10.20.0.0/16` for
  prod / staging / dev and state, in one line, why overlapping ranges are a
  problem that only appears later.
- **Tools** arithmetic, `man 7 ip`, the worksheet. Deliberately no calculator
  binary — the point is that a subnet mask is a boundary, not a lookup.
- **Verification** — `file_content` against exact literal answers. Fully
  deterministic; no dynamic values.
- **Supported today?** **Yes, entirely.** No new capability.
- **New capability** none.

---

#### NET-003 · OSI and TCP/IP: Which Layer Is This Failure In?
- **Substrate** `linux` (unchanged) · **Difficulty** beginner · **Duration** 25 min
- **Skills** `net.model.osi`, `net.model.tcpip`, `net.troubleshoot.layer-triage`, `net.model.encapsulation`
- **Prerequisites** NET-002
- **Scenario** — An incident review found that the team spent forty minutes
  restarting an application whose problem was a cable. Your lead wants a
  one-page triage guide: given a symptom, which layer do you look at first.
- **Initial state** — `/home/student/layers/symptoms.txt` with ten real symptom
  lines (`NXDOMAIN`, `connection refused`, `TLS certificate expired`, `link
  down`, `no route to host`, `502 Bad Gateway`, `connection timed out`,
  `ARP entry incomplete`, `port already in use`, `MTU exceeded, fragmentation
  needed`).
- **Student task** — Write `triage.txt`: one line per symptom, `<n>: L<layer>
  <one-word cause class>`. Then `encapsulation.txt`: order the terms *frame,
  packet, segment, bytes on the wire, HTTP request* from application down to
  physical, and name what each layer adds.
- **Tools** reasoning; `man 7 tcp`, `man 7 ip`
- **Verification** — `file_content` per line against literal answers.
- **Supported today?** **Yes, entirely.**
- **New capability** none.
- **Implemented 2026-08-24.** Shipped with a stronger design than this entry
  described: rather than classifying symptoms on paper, the student reproduces
  four *real* failures on the box — `ECONNREFUSED` on a closed port,
  `ENETUNREACH` to an address with no route, `EAI_AGAIN` against a resolver the
  seed pins out of reach, and a seeded service that accepts the connection and
  answers `503`. The seed pins `/etc/resolv.conf` so the resolver failure is
  identical on every host. Verification adds one behavioural check
  (`command_exit_code` on `test -s` against the service's access log), so a
  student who transcribes a plausible HTTP response without ever contacting the
  service fails. Five `file_content_absent` checks make a hedged answer fail.
  Still zero new platform capability.

---

#### NET-004 · Frames, MAC Addresses and ARP: How a Packet Finds a Neighbour
- **Substrate** `net` (fallback: `docker`) · **Difficulty** intermediate · **Duration** 35 min
- **Skills** `net.l2.arp`, `net.l2.mac`, `net.tools.tcpdump`, `net.model.encapsulation`
- **Prerequisites** NET-003
- **Scenario** — Two hosts on the same segment. One of them is a bank payment
  gateway. You have been asked to explain, with evidence, what actually happens
  on the wire the first time it talks to its neighbour — because the team's
  mental model stops at "it has an IP".
- **Initial state** — `net` sandbox + peer `10.90.0.20`; ARP cache flushed at
  seed time; `/home/student/l2/` empty.
- **Student task** — Capture the exchange (`tcpdump -n -e -i eth0 arp`) while
  pinging the peer for the first time. Save the capture text to `arp.pcap.txt`.
  Record the peer's MAC into `peer-mac.txt` from `ip neigh`. In `explain.txt`,
  answer: why is ARP needed at all when we already know the IP; and what changes
  if the destination is *not* on the same subnet (the frame goes to the
  gateway's MAC, the IP header is unchanged).
- **Tools** `tcpdump`, `ip neigh`, `ping`, `ip link`
- **Verification** — `file_content` on `arp.pcap.txt` for `ARP` + `Request who-has
  10.90.0.20`; `file_content` on `peer-mac.txt` against the seeded peer MAC;
  `file_content` on `explain.txt` requiring `gateway` and `MAC` in the
  off-subnet answer.
- **Supported today?** No — needs a peer and `NET_RAW` (C2, C3).
- **New capability** N1, N2, N3, **N4 (`NET_RAW`/`NET_ADMIN` grantable for the
  net provider only)**. Docker-substrate fallback works today with a pre-pulled
  tooling image and weaker verification.
- **Implemented 2026-08-24, and the capability estimate above was wrong twice
  over.** `NET_RAW` (N4) turned out to be unnecessary: `ip neigh` reads the
  kernel's neighbour table with no capability at all, and grading that table is
  *stronger* than grading a packet capture because a student cannot write to it
  — `ip neigh add` needs `CAP_NET_ADMIN`, which no sandbox grants. A peer
  container (N3) was unnecessary too: a session's own bridge gateway is a real
  neighbour, and a same-prefix address with nothing behind it produces a real
  `FAILED` entry, so one container yields all three outcomes. What was needed
  was an opt-in `environment.network: link` giving each session a private
  `--internal` bridge, plus the `neighbour_state` primitive. The lab grades
  three kernel-observed outcomes — resolved, unanswered, and no entry at all
  for a destination with no route — and never a literal address, because the
  segment is allocated at start time.

---

#### NET-005 · The Default Gateway and the Routing Table
- **Substrate** `net` · **Difficulty** intermediate · **Duration** 35 min
- **Skills** `net.l3.routing`, `net.l3.default-gateway`, `net.l3.longest-prefix`, `net.tools.ip-route`
- **Prerequisites** NET-004
- **Scenario** — A host can reach one internal network and not another, and the
  application team is convinced it is a firewall. Before anyone opens a firewall
  ticket, read the routing table and say where each packet would actually go.
- **Initial state** — `net` sandbox with three routes seeded: the connected
  `10.90.0.0/24`, a static `10.99.5.0/24` via `10.90.0.1`, and a default via
  `10.90.0.1`. No route to `192.168.50.0/24`.
- **Student task** — Save `ip route` to `routes.txt`. In `decisions.txt`, one
  line per destination (`10.90.0.20`, `10.99.5.7`, `8.8.8.8`,
  `192.168.50.4`) naming which route matches and what the next hop is. In
  `why.txt`, state the rule that picks between two matching routes (longest
  prefix wins, not order) and what error the fourth destination produces and why
  (`no route to host` — the kernel refuses before a packet is ever sent, so no
  firewall is involved).
- **Tools** `ip route`, `ip route get`, `ping`, `man ip-route`
- **Verification** — `file_content` on `routes.txt` for the seeded prefixes;
  literal per-destination answers in `decisions.txt`; `why.txt` must contain
  `longest` and `no route to host`.
- **Supported today?** No (C1). Verification of `routes.txt` works via
  `file_content` today; grading `ip route` directly would need capability **N7**.
- **New capability** N1, N2.
- **Implemented 2026-08-25, deliberately re-scoped.** The design above assumed
  the student could repair a route. They cannot, and this is not a gap to close
  casually: `CAP_NET_ADMIN` is absent from the sandbox's *bounding set*, so
  `ip route add` fails even under `sudo` (`sudo` itself works — the student is
  genuinely root). Rather than grant the capability, NET-005 ships as
  **Routing and Reachability Troubleshooting**: a settlement poller is
  configured with an endpoint on a network no route covers, and the student
  diagnoses via routing state and repairs at the layer the fault was introduced
  — the application's configuration. Routing is diagnosed, never modified, and
  telling those apart is one of the objectives. Graded on
  `neighbour_state` + `file_content_absent` + `file_content` + `port_listening`;
  no `route_exists` primitive was needed or added. The fixture provably cannot
  self-pass: its own endpoint has no route, so it never reaches address
  resolution and never leaves a resolved neighbour behind.

---

### Phase 2 — Linux Networking (NET-006 … NET-011)

---

#### NET-006 · Sockets and Listening Ports: `ss` Is the First Question
- **Substrate** `net` (degraded version possible on `linux`) · **Difficulty** intermediate · **Duration** 30 min
- **Skills** `linux.net.sockets`, `linux.net.listening`, `net.l4.ports`, `net.l4.socket-identity`
- **Prerequisites** NET-005
- **Scenario** — Four services are running on a bank host and nobody can say
  which is which. You have been handed the box and asked for an inventory: what
  is listening, on what, bound to which address, and which of them a remote host
  could ever reach.
- **Initial state** — Four seeded services: `9105` on `0.0.0.0`, `9106` on
  `127.0.0.1`, `9107` UDP, and one established outbound connection to the peer.
- **Student task** — `inventory.txt`: for each listening socket, `proto port
  bind-address`. `remote.txt`: only the ports a remote host can reach, and one
  sentence on what makes the difference. `established.txt`: the four-tuple of the
  one established connection, and one line on why a socket is identified by four
  values and not by a port.
- **Tools** `ss -ltnup`, `ss -tanp`, `man ss`
- **Verification** — `port_listening` for 9105/9106/9107; **`port_listening` with
  `address:`** (capability N5) to assert `9106` is loopback-bound;
  `file_content` on `remote.txt` requiring `9105` present and `9106` absent
  (`file_content_absent`).
- **Supported today?** Partially — the service inventory grades today on `linux`;
  the bind-address distinction needs **N5**, the established connection needs a
  peer (N2/N3).
- **New capability** N5 (`address` on `port_listening`), N1–N3.

---

#### NET-007 · The Bind Address Incident: `curl localhost` Works, the Browser Does Not
- **Substrate** `net` · **Difficulty** intermediate · **Duration** 35 min
- **Skills** `net.troubleshoot.bind-address`, `linux.net.sockets`, `net.l4.loopback`, `net.troubleshoot.evidence`
- **Prerequisites** NET-006
- **Scenario** — The `ledger-api` deploy is "done". The engineer who deployed it
  proved it works: `curl http://localhost:8080/health` returns `200` on the box.
  Every other machine gets connection refused, and the load balancer has marked
  it down. **Covers requested incident: "works with curl localhost but browser
  cannot reach it" / "service listens on 127.0.0.1 instead of 0.0.0.0".**
- **Initial state** — `ledger-api` supervised under runit, config
  `/etc/ledger/api.conf` containing `bind_address = 127.0.0.1`, listening on
  `127.0.0.1:8080`. Peer host present and failing to connect.
- **Student task** — Reproduce both results (from the host, and from the peer)
  and save them to `evidence/local.txt` and `evidence/remote.txt`. Diagnose from
  `ss`, not from the config. Change the bind address so the service listens on
  all interfaces, restart it through the supervisor, and prove the peer now
  succeeds. Write `diagnosis.txt` naming the layer, the evidence line that gave
  it away, and why the symptom was `connection refused` rather than a timeout.
- **Tools** `ss -ltn`, `curl`, `sv restart`, `nano`, the peer shell
- **Verification** — `port_listening` port 8080 **`address: 0.0.0.0`** (N5);
  `file_content_absent` on `/etc/ledger/api.conf` for `127.0.0.1` (the fault is
  gone, not worked around); `http_request` from the peer expecting `200` (N6);
  `file_content` on `diagnosis.txt` requiring `refused` and `bind`.
- **Supported today?** No. This lab is the strongest single argument for N5+N6.
- **New capability** N1, N2, N3, N5, N6 (`http_request` sandbox requirement).

---

#### NET-008 · TCP and UDP: Handshake, State and Connection Lifecycle
- **Substrate** `net` · **Difficulty** intermediate · **Duration** 40 min
- **Skills** `net.l4.tcp-handshake`, `net.l4.tcp-states`, `net.l4.udp`, `net.tools.tcpdump`
- **Prerequisites** NET-007
- **Scenario** — A team has been told to "just retry on failure" and has started
  hammering a service that is refusing connections. To explain why retries make
  it worse, you need to show what a connection actually is.
- **Initial state** — TCP echo service on `9200`, UDP echo on `9201`, one port
  (`9202`) with nothing listening.
- **Student task** — Capture and save the three-way handshake against `9200`
  (`handshake.txt` — must show `Flags [S]`, `[S.]`, `[.]`). Capture what happens
  against `9202` (`refused.txt` — `Flags [R.]`, an immediate reset, no timeout).
  Send a datagram to `9201` and capture it (`udp.txt`) — no handshake, no state.
  Observe socket states during and after a connection (`states.txt` must show
  `ESTAB` and, after close, `TIME-WAIT`). In `explain.txt`: why `TIME-WAIT`
  exists, and why a UDP "connection" is a fiction of the socket API.
- **Tools** `tcpdump`, `nc`, `socat`, `ss -tan`, `ss -uan`
- **Verification** — `file_content` for the flag sequences and socket states;
  `port_listening` for 9200/tcp and 9201/udp; `port_not_listening` for 9202.
- **Supported today?** No — `tcpdump` + `NET_RAW` (C2, C3).
- **New capability** N1, N4.

---

#### NET-009 · ICMP, Ping and Traceroute: Reachable Is Not Available
- **Substrate** `net` · **Difficulty** intermediate · **Duration** 30 min
- **Skills** `net.l3.icmp`, `net.tools.ping`, `net.tools.traceroute`, `net.troubleshoot.reachability`
- **Prerequisites** NET-008
- **Scenario** — Monitoring says the payments host is "up" because it answers
  ping. The payments team says it is down. Both are right, and you have to write
  the sentence that ends the argument.
- **Initial state** — Peer answering ICMP with its application stopped; a second
  peer that drops ICMP entirely while serving HTTP normally; a multi-hop path to
  a third address.
- **Student task** — Produce `results.txt` covering both peers: ICMP result, TCP
  result, and the conclusion for each. Save a traceroute to `path.txt` and say
  what each line represents (a TTL expiry, not a hop that "answered your
  request"). In `explain.txt`: what ping proves and what it does not, and why
  "host does not respond to ping" is not evidence that a host is down.
- **Tools** `ping`, `traceroute`, `nc -z`, `curl`
- **Verification** — `file_content` on `results.txt` for the four required
  outcomes; `path.txt` must contain the seeded intermediate hop address;
  `explain.txt` must mention `ICMP` and `filtered`/`dropped`.
- **Supported today?** No.
- **New capability** N1, N2, N3.

---

#### NET-010 · How an Interface Gets an Address: DHCP, and What Containers Do Instead
- **Substrate** `docker` · **Difficulty** advanced · **Duration** 35 min
- **Skills** `net.l3.dhcp`, `net.addressing.assignment`, `net.container.ipam`, `net.tools.tcpdump`
- **Prerequisites** NET-009
- **Scenario** — A new engineer asks why the container they just started already
  had an IP address when nobody configured one, and whether that was DHCP. The
  answer is no, and being able to show the difference is worth more than the
  answer.
- **Initial state** — Docker sandbox with `dnsmasq` and a busybox client image
  pre-pulled, and an empty user-defined network.
- **Student task** — Part one: run a DHCP server container and a client with
  `--cap-add=NET_ADMIN` on an isolated network, capture the DISCOVER / OFFER /
  REQUEST / ACK exchange, and save it to `workspace/dhcp.txt`. Part two: start
  an ordinary container on a bridge network, show it has an address with no DHCP
  traffic at all, and write `workspace/ipam.txt` explaining who assigned it
  (the daemon's IPAM driver, at container create time) and where the lease
  concept went.
- **Tools** `docker network create`, `docker run --cap-add=NET_ADMIN`,
  `docker exec`, `tcpdump` inside the tooling container
- **Verification** — `docker_network_exists`; `docker_container_running`;
  `workspace_file_exists` with `contains` for `DHCPDISCOVER`/`DHCPACK` and for
  `IPAM`. Honest weakness: workspace evidence is student-written and forgeable —
  **N9 (`docker_exec_probe`)** would let the platform observe the client's
  address itself.
- **Supported today?** Mostly yes — the privileged DinD sandbox already permits
  all of it; needs the images added to a pre-pull list (C5 egress caveat).
- **New capability** N8 (tooling image pre-pull), N9 (preferred, not required).

---

#### NET-011 · Firewalls: Refused, Dropped, and Reading the Rules
- **Substrate** `docker` · **Difficulty** advanced · **Duration** 40 min
- **Skills** `net.firewall.rules`, `net.firewall.stateful`, `net.troubleshoot.refused-vs-timeout`, `net.l4.filtering`
- **Prerequisites** NET-010
- **Scenario** — Two services on one host: one returns `connection refused`
  instantly, the other hangs for thirty seconds and then times out. One of them
  is a firewall problem and one of them is not. **Covers requested incident:
  "firewall blocks traffic".**
- **Initial state** — Inside the student's own daemon: a topology container with
  nftables rules that `DROP` traffic to `8081`, nothing listening on `8082`, and
  a working service on `8080`.
- **Student task** — Measure and record all three behaviours with timings
  (`workspace/symptoms.txt`). Read the rule set and identify the rule
  responsible (`workspace/rule.txt`). Fix it so `8081` is reachable *without*
  flushing the entire ruleset — the default-deny stays. Then write
  `workspace/mechanism.txt`: why `DROP` produces a timeout and a closed port
  produces an instant reset, and what a stateful rule (`ct state established`)
  is doing that a stateless one cannot.
- **Tools** `nft`/`iptables` inside the container, `nc -zv`, `curl --max-time`,
  `time`
- **Verification** — `workspace_file_exists` with `contains` on all three files;
  `docker_container_running`. **N9** would allow the platform to probe `8081`
  itself and grade the fix rather than the report.
- **Supported today?** Yes, mechanically (privileged DinD). Verification is
  evidence-based until N9.
- **New capability** N8, N9 (strongly recommended here).

---

### Phase 3 — DNS and Application Protocols (NET-012 … NET-016)

---

#### NET-012 · The Resolution Path: Stub Resolver, Recursive, Authoritative
- **Substrate** `net` · **Difficulty** intermediate · **Duration** 35 min
- **Skills** `dns.resolution.recursive`, `dns.resolution.authoritative`, `dns.resolver.stub`, `dns.tools.dig`
- **Prerequisites** NET-006
- **Scenario** — "DNS is broken" is the most common wrong diagnosis in the
  bank's incident log. To be able to disprove it, you have to know which of the
  three machines involved in a lookup actually answered.
- **Initial state** — A recursive resolver at `10.90.0.30` and an authoritative
  server at `10.90.0.31` holding zone `bank.internal` with seeded records;
  `/etc/resolv.conf` points at the resolver.
- **Student task** — Resolve `ledger.bank.internal` three ways and save each:
  through the stub resolver (`getent`), through the recursive resolver
  explicitly (`dig @10.90.0.30`), and from the authoritative server directly
  (`dig @10.90.0.31 +norecurse`). Note which answers are marked authoritative
  (`aa` flag) and which are not. In `path.txt`, describe the four steps a query
  takes and which of `/etc/resolv.conf`, `/etc/hosts`, and `/etc/nsswitch.conf`
  is consulted first — then prove the `/etc/hosts` precedence by adding an entry
  and showing `getent` and `dig` now disagree.
- **Tools** `dig`, `getent hosts`, `cat /etc/resolv.conf`, `/etc/nsswitch.conf`
- **Verification** — `command_output` with `getent hosts ledger.bank.internal`
  containing the seeded IP (**works today**, `getent` is allow-listed);
  `file_content` on the three saved answers for `flags:` / `aa`;
  `file_content` on `path.txt` for `nsswitch` and `hosts`.
- **Supported today?** Verification largely yes; the DNS servers and `dig` are
  not (C1, C3).
- **New capability** N1, N2, N3 (DNS servers in the topology).

---

#### NET-013 · Record Types and TTL: A, AAAA, CNAME, MX, TXT
- **Substrate** `net` · **Difficulty** intermediate · **Duration** 30 min
- **Skills** `dns.records.types`, `dns.records.cname`, `dns.ttl`, `dns.tools.dig`
- **Prerequisites** NET-012
- **Scenario** — A migration plan says "we will just point the CNAME at the load
  balancer". Before you approve it you need to check what the zone actually
  contains, because two of the names in it cannot legally be CNAMEs.
- **Initial state** — Seeded zone with an `A`, an `AAAA`, a two-step `CNAME`
  chain, an `MX`, a `TXT` (SPF-shaped), and deliberately mixed TTLs (`60` and
  `86400`).
- **Student task** — `records.txt`: for each name, the record type and the value
  `dig` returned. `chain.txt`: follow the CNAME chain to its final A record and
  show each step. `ttl.txt`: both TTL values, and how long a wrong answer for
  each would persist in caches worldwide. `rules.txt`: why a zone apex cannot be
  a CNAME, and what an `MX` value's priority number is for.
- **Tools** `dig <name> <type>`, `dig +short`, `dig +noall +answer`
- **Verification** — `file_content` per record against seeded literal values;
  `ttl.txt` must contain both `60` and `86400`; `rules.txt` must contain `apex`
  and `priority`.
- **Supported today?** No (needs the zone + `dig`).
- **New capability** N1, N2, N3.

---

#### NET-014 · DNS Caching: Why the Old Address Kept Answering
- **Substrate** `net` · **Difficulty** advanced · **Duration** 35 min
- **Skills** `dns.caching`, `dns.ttl.propagation`, `dns.troubleshoot.stale`, `dns.tools.dig`
- **Prerequisites** NET-013
- **Scenario** — The `ledger` cutover happened an hour ago. Half the fleet is on
  the new host and half is still hitting the old one, which is being
  decommissioned tonight. Someone wants to "flush DNS globally". **Covers
  requested incident: "DNS resolves incorrectly".**
- **Initial state** — Zone updated at the authoritative server (new IP);
  recursive resolver still holding the pre-change answer with a long remaining
  TTL; the record's TTL was `86400` at the time of the change.
- **Student task** — Prove the divergence: `dig @authoritative` and
  `dig @resolver` for the same name, saved side by side into `divergence.txt`,
  with the remaining TTL from the cached answer captured in `remaining-ttl.txt`
  (it counts down between queries — record two observations and show the delta).
  Write `plan.txt`: what actually makes the fleet converge, what a local flush
  does and does not achieve, and the one change that should have been made
  *before* the cutover (lower the TTL ahead of time). Then apply that lesson: set
  the new record's TTL to `60` at the authoritative server.
- **Tools** `dig`, `dig +ttlunits`, zone file edit, resolver reload
- **Verification** — `file_content` on `divergence.txt` for both the old and new
  IPs; two decreasing TTL observations required in `remaining-ttl.txt`
  (**N10, `file_content_matches` with a pattern**, or literal seeded values);
  the authoritative zone file must now contain TTL `60` (`file_content`);
  `plan.txt` must contain `TTL` and `before`.
- **Supported today?** No.
- **New capability** N1, N2, N3; N10 desirable (regex file matching).

---

#### NET-015 · HTTP by Hand: Requests, Responses, Headers, Status Codes
- **Substrate** `net` · **Difficulty** intermediate · **Duration** 30 min
- **Skills** `http.request-response`, `http.headers`, `http.status-codes`, `http.host-routing`
- **Prerequisites** NET-012
- **Scenario** — Two sites are served from one address, one of them returns 404
  for everything, and the team is convinced the server is broken. It is
  answering exactly as configured — the requests are wrong.
- **Initial state** — nginx with two name-based virtual hosts
  (`ledger.bank.internal`, `cards.bank.internal`) on the same IP; a path that
  returns `301`, one that returns `404`, one that returns `500`.
- **Student task** — Speak HTTP with no client library: `nc` to port 80 and type
  a `GET / HTTP/1.1` with a `Host:` header, twice, once per vhost, saving both
  transcripts. Show that omitting `Host` gets you the default server. Then with
  `curl -v`, capture and classify the `301`, `404` and `500` responses into
  `codes.txt` — for each, one line on whether the *client* or the *server* has
  the problem, and what the next diagnostic step would be.
- **Tools** `nc`, `curl -v`, `curl -I`, `curl -H 'Host: ...'`
- **Verification** — `file_content` on each transcript for the vhost-specific
  body marker; `codes.txt` graded per line for `client`/`server` classification;
  `http_request` (N6) confirming the vhosts respond.
- **Supported today?** No (`curl`, C3).
- **New capability** N1, N6.

---

#### NET-016 · TLS: Handshake, Certificates, SNI, and the Four Ways It Fails
- **Substrate** `net` · **Difficulty** advanced · **Duration** 40 min
- **Skills** `tls.handshake`, `tls.certificates`, `tls.sni`, `tls.troubleshoot`
- **Prerequisites** NET-015
- **Scenario** — Four HTTPS endpoints, four different certificate errors, and a
  team whose entire remediation vocabulary is `-k`. **Covers requested incident:
  "TLS certificate problem".**
- **Initial state** — Four seeded endpoints: valid cert from a seeded private CA;
  expired cert; cert whose CN/SAN does not match the name; self-signed cert not
  in the trust store. The private CA is in `/usr/local/share/ca-certificates`
  but not yet trusted.
- **Student task** — For each endpoint, capture the failure with `openssl
  s_client` and with `curl`, and write `failures.txt`: the endpoint, the exact
  error string, **which party is wrong**, and the correct fix (renew / reissue
  with the right SAN / add the CA to the trust store / nothing — this one is
  fine). Then make the valid endpoint verify cleanly by trusting the CA properly
  (`update-ca-certificates`), and prove it with a `curl` that has no `-k`.
  In `sni.txt`, show with `openssl s_client -servername` that two certificates
  are served from one IP, and explain what the client sends in the ClientHello
  to make that possible.
- **Tools** `openssl s_client`, `openssl x509 -noout -dates -subject -ext
  subjectAltName`, `curl`, `update-ca-certificates`
- **Verification** — `file_content` on `failures.txt` for each of the four error
  classes (`certificate has expired`, `subject alternative name`, `self-signed`,
  `OK`); `file_exists` on the trusted CA in `/etc/ssl/certs`; **N11
  (`tls_certificate`)** to assert the endpoint now validates and the served
  cert's SAN matches; `sni.txt` must contain `ClientHello`/`server_name`.
- **Supported today?** No.
- **New capability** N1, N6, N11 (`tls_certificate` requirement type).

---

### Phase 4 — DevOps Networking (NET-017 … NET-020)

---

#### NET-017 · Reverse Proxies: What the Backend Actually Sees
- **Substrate** `net` · **Difficulty** intermediate · **Duration** 40 min
- **Skills** `devops.reverse-proxy`, `devops.proxy-headers`, `http.host-routing`, `net.tools.curl`
- **Prerequisites** NET-015
- **Scenario** — After putting nginx in front of the ledger API, every request in
  the backend's logs appears to come from one IP, and the app's rate limiter is
  now banning the whole company.
- **Initial state** — Backend on `127.0.0.1:8080` logging remote address and
  `Host`; nginx on `:80` with a minimal `proxy_pass` and no forwarding headers.
- **Student task** — Show the problem from the backend's log
  (`before.txt`). Configure the proxy to pass the original host and client
  address (`proxy_set_header Host`, `X-Forwarded-For`, `X-Forwarded-Proto`),
  reload, and show the log now carries the real client (`after.txt`). Write
  `explain.txt`: why the backend sees the proxy's address by default (the TCP
  connection genuinely comes from the proxy), and why `X-Forwarded-For` must be
  treated as untrusted input at the edge.
- **Tools** `nginx -t`, `nginx -s reload`, `curl -H`, log files
- **Verification** — `file_content` on the nginx config for the three headers;
  `file_content` on `after.txt` for the client address; `http_request` (N6)
  through the proxy expecting `200` and the backend marker; `explain.txt` must
  contain `untrusted`/`spoof`.
- **Supported today?** No (C1, C3).
- **New capability** N1, N6.

---

#### NET-018 · Layer 4 vs Layer 7, and the Health Check That Lied
- **Substrate** `net` · **Difficulty** advanced · **Duration** 45 min
- **Skills** `devops.load-balancing`, `devops.l4-vs-l7`, `devops.health-checks`, `net.troubleshoot.lb`
- **Prerequisites** NET-017
- **Scenario** — A load balancer in front of three backends is sending traffic to
  a backend that returns errors, and is *refusing* to send traffic to a backend
  that is perfectly healthy. Both problems are the health check. **Covers
  requested incident: "load balancer health check fails".**
- **Initial state** — Three backends: one healthy, one accepting TCP but
  returning `500` on every request, one healthy but serving its health endpoint
  at `/healthz` while the LB is configured to check `/health` on the wrong port.
  LB configured with a **TCP-only** check.
- **Student task** — Establish which backend is which (`backends.txt`). Explain
  in `checks.txt` why a Layer 4 check marks the `500`-returning backend healthy —
  a TCP handshake says nothing about the application. Reconfigure to an
  application-level check on the correct path and port. Prove the broken backend
  is now removed from rotation and the healthy one is back in, by hitting the LB
  repeatedly and recording the distribution (`distribution.txt`). Write
  `tradeoff.txt`: one thing L4 gives you that L7 does not (it does not need to
  parse or terminate anything, so it works for any protocol and preserves the
  connection), and one thing L7 gives you that L4 cannot (routing and health by
  content).
- **Tools** nginx/haproxy config, `curl` in a loop, backend logs
- **Verification** — `file_content` on the LB config for the corrected path,
  port and check type; `distribution.txt` must show the healthy backends'
  markers and **must not** contain the broken one (`file_content_absent`);
  `http_request` (N6) against the LB expecting `200` ten times.
- **Supported today?** No.
- **New capability** N1, N6.

---

#### NET-019 · NAT, Ingress and Egress: Why the Private Host Has No Inbound Path
- **Substrate** `docker` · **Difficulty** advanced · **Duration** 40 min
- **Skills** `devops.nat`, `devops.ingress-egress`, `net.l3.address-translation`, `net.topology.private-subnet`
- **Prerequisites** NET-011
- **Scenario** — A private host can reach an external service, but the external
  service cannot start a connection back to it, and someone has filed this as a
  firewall bug. It is not a firewall — it is the absence of an address.
- **Initial state** — Inside the student's daemon: an internal network with no
  gateway, a NAT box attached to both networks, an "external" service on the
  outer network that logs the source address of every connection.
- **Student task** — From the private host, reach the external service; read the
  external service's log and record what source address it saw
  (`workspace/observed-source.txt` — the NAT box, not the private host). Then
  attempt the reverse connection and record the failure. Write
  `workspace/explain.txt`: what the NAT box rewrites and what it must remember to
  send replies back (the translation table keyed by the four-tuple), why inbound
  is fundamentally different from outbound, and what a *published port* is in
  those terms — a static, pre-configured inbound translation. Finally, create one
  by publishing the private service through the NAT box and prove it works.
- **Tools** `docker network create --internal`, `nft`/`iptables -t nat`,
  `docker exec`, `curl`
- **Verification** — `docker_network_exists` for both networks;
  `docker_container_network` proving the NAT box is on both;
  `workspace_file_exists` with `contains` on the three files; N9 would let the
  platform verify the published path itself.
- **Supported today?** Yes, mechanically. Evidence-based verification until N9.
- **New capability** N8, N9.

---

#### NET-020 · 502, 503, 504: Reading Proxy Errors as Evidence
- **Substrate** `net` · **Difficulty** advanced · **Duration** 45 min
- **Skills** `devops.proxy-errors`, `net.troubleshoot.502-503-504`, `devops.timeouts`, `net.troubleshoot.evidence`
- **Prerequisites** NET-018
- **Scenario** — One proxy, three URLs, three different five-hundreds. The team's
  runbook says "restart the proxy" for all three. **Covers requested incidents:
  "application returns 502 / 503 / 504", "connection timeout", "connection
  refused".**
- **Initial state** — `/a` → backend process stopped (nothing listening → `502`);
  `/b` → upstream group with every member marked unhealthy, which is the
  *proxy implementation's* documented reason for `503` — RFC 9110 §15.6.4
  defines `503` as temporary overload or scheduled maintenance, so the lab text
  attributes "no healthy upstreams" to the proxy, not to the RFC; `/c` →
  backend that sleeps `30s` behind a `5s` `proxy_read_timeout` (`504`).
- **Student task** — Reproduce each and record the status, the elapsed time, and
  the corresponding proxy error-log line into `evidence/`. Write `triage.txt`:
  for each code, what the proxy is telling you about **its own** connection to
  the backend, and — critically — which of the three is *not* a network problem
  at all. Then fix exactly one: bring `/a`'s backend back and prove `200`,
  without touching `/b` or `/c`. In `timeouts.txt`, state what a `504` becomes if
  you only raise the proxy timeout (a slower `504`, or a client timeout instead)
  and why that is not a fix.
- **Tools** `curl -w '%{http_code} %{time_total}'`, proxy error log, `ss`, `sv`
- **Verification** — `http_request` (N6) on `/a` expecting `200`, on `/b`
  expecting `503`, on `/c` expecting `504` — the untouched faults must still be
  present, so "fix everything" fails; `file_content` on `triage.txt` requiring
  `502`+`refused`, `503`+`upstream`, `504`+`timeout`.
- **Supported today?** No — and this lab is the clearest case for `http_request`
  with an **expected non-2xx status**.
- **New capability** N1, N6.

---

### Phase 5 — Container and Kubernetes Networking (NET-021 … NET-027)

---

#### NET-021 · Network Namespaces: What Container Isolation Actually Is
- **Substrate** `docker` · **Difficulty** advanced · **Duration** 40 min
- **Skills** `container.netns`, `container.veth`, `container.bridge`, `net.model.isolation`
- **Prerequisites** NET-005, NET-010
- **Scenario** — "Containers are isolated" is repeated constantly and rarely
  explained. You are writing the section of the onboarding doc that explains what
  the isolation *is*, with commands anyone can run.
- **Initial state** — Docker sandbox, tooling image pre-pulled, no user networks.
- **Student task** — Start the same image three ways: `--network none`,
  `--network bridge`, and attached to a user-defined network. For each, record
  the interfaces the container sees and whether it can reach a peer
  (`workspace/three-modes.txt`). Then find the *host* side of one container's
  link: the veth peer on the bridge (`ip link`, `brctl`/`ip -d link show`), and
  record the pair (`workspace/veth.txt`). In `workspace/explain.txt`: what a
  network namespace contains (its own interfaces, routes, ARP table, socket
  table, iptables rules), and why two containers can both bind `:8080` with no
  conflict.
- **Tools** `docker run --network`, `docker exec`, `ip link`, `ip netns`,
  `nsenter`
- **Verification** — `docker_network_exists`; `docker_container_network`;
  `workspace_file_exists` with `contains` for `veth`, `8080`, and `namespace`.
- **Supported today?** Yes (privileged DinD), with N8 for images.
- **New capability** N8.

---

#### NET-022 · Port Publishing: The Path from Host to Container
- **Substrate** `docker` · **Difficulty** intermediate · **Duration** 35 min
- **Skills** `container.port-publishing`, `net.troubleshoot.wrong-port`, `container.bridge`, `devops.nat`
- **Prerequisites** NET-021
- **Scenario** — A container is running, the app inside it is healthy, and
  nothing on the host can reach it. The `docker run` line has a port mapping in
  it, which is why nobody has looked at the port mapping. **Covers requested
  incident: "wrong port".**
- **Initial state** — Container running an app that listens on `8080`, started
  with `-p 3000:80` — a published mapping to a port nothing serves.
- **Student task** — Diagnose without guessing: what the app listens on inside
  the container, what the mapping claims, and where the mismatch is
  (`workspace/diagnosis.txt`). Re-run the container with a correct mapping
  (`-p 3000:8080`), keeping the same host port. Prove it end to end. Then write
  `workspace/model.txt`: which of `host-port`, `container-port` is which side of
  the colon, and what mechanism actually moves the packet (a DNAT rule the daemon
  installs, not a proxy in the general case).
- **Tools** `docker run -p`, `docker port`, `docker exec ... ss -ltn`, `curl`
- **Verification** — **`docker_container_port` with `container_port: 8080,
  host_port: 3000` — supported today**; `docker_container_running`;
  `workspace_file_exists` with `contains` for `DNAT`/`8080`.
- **Supported today?** **Yes, including verification.** Only the pre-pulled image
  is needed.
- **New capability** N8.

---

#### NET-023 · Container DNS and Service-to-Service Communication
- **Substrate** `docker` · **Difficulty** intermediate · **Duration** 40 min
- **Skills** `container.dns`, `container.service-discovery`, `container.networks`, `net.troubleshoot.name-resolution`
- **Prerequisites** NET-022, NET-012
- **Scenario** — The ledger worker cannot reach the ledger API by name. Both
  containers are running, both are on "the network", and `ping` by IP works.
  **Covers requested incident: "containers cannot communicate".**
- **Initial state** — Two containers on the **default** bridge (no embedded DNS
  for names), plus a third container on a separate user-defined network with the
  same name as the API — so the second half of the lab is a name that resolves to
  the wrong place.
- **Student task** — Show the failure (`workspace/before.txt` — name lookup
  fails, IP works). Move both onto a user-defined network and show the name now
  resolves, capturing the resolver the container is using
  (`/etc/resolv.conf` → `127.0.0.11`, the daemon's embedded DNS)
  in `workspace/resolver.txt`. Then the twist: from the third network, the same
  name resolves to a different container — record it and explain in
  `workspace/scope.txt` that container DNS is **scoped to the network**, not
  global, and what a network alias changes.
- **Tools** `docker network create/connect`, `docker exec ... nslookup`,
  `docker exec ... cat /etc/resolv.conf`, `docker network inspect`
- **Verification** — `docker_network_exists`, `docker_container_network` for both
  containers (**today**); `workspace_file_exists` with `contains` for
  `127.0.0.11` and `alias`. N9 would let the platform run the lookup itself.
- **Supported today?** Yes, with evidence-based verification.
- **New capability** N8, N9 (preferred).

---

#### NET-024 · Pod Networking and ClusterIP: Why Pod IPs Are Not an Interface
- **Substrate** `k8s` · **Difficulty** intermediate · **Duration** 40 min
- **Skills** `k8s.pod-networking`, `k8s.service.clusterip`, `k8s.endpoints`, `k8s.cni-model`
- **Prerequisites** NET-023
- **Scenario** — A team has hard-coded a Pod IP into a config map. It worked for
  four days. You have to show them what happened on day five, and what they
  should have used instead.
- **Initial state** — `ledger-api` Deployment with 2 replicas, no Service.
- **Student task** — Record both Pod IPs. Delete one Pod, wait for the
  replacement, and record the new IP — same workload, different address
  (`ip-churn.txt` via a ConfigMap or a file in the sandbox). Create a ClusterIP
  Service selecting the Deployment's labels on the correct `targetPort`. Show
  that the Service's ClusterIP is stable across a Pod deletion, and that its
  **EndpointSlice** changed. Write the model down: every Pod gets a real, routable,
  cluster-unique IP (the flat-network assumption every CNI must satisfy), and a
  Service is a stable virtual address in front of a changing set of them.
- **Tools** `kubectl get pods -o wide`, `kubectl expose`/manifest,
  `kubectl get endpointslices -l kubernetes.io/service-name=<svc>`,
  `kubectl describe svc`
  *(Source-policy correction, 2026-08-23: the Endpoints API is deprecated as of
  Kubernetes v1.33 and the API server warns on read/write; labs teach
  EndpointSlice. The platform verifier already reads EndpointSlices —
  `k8s/client.ts:475`.)*
- **Verification** — `service_exists`, `service_selector`, `service_port`,
  `service_endpoints` (min 2), `service_http` expecting `200` — **all supported
  today**.
- **Supported today?** **Yes, entirely.**
- **New capability** none.

---

#### NET-025 · The Service With No Backend Endpoints
- **Substrate** `k8s` · **Difficulty** advanced · **Duration** 40 min
- **Skills** `k8s.service.selectors`, `k8s.endpoints`, `k8s.troubleshoot.service`, `k8s.service.targetport`
- **Prerequisites** NET-024
- **Scenario** — The Service exists, the Pods are `Running` and `Ready`, and
  every request to the Service hangs. The Service has no EndpointSlice
  addresses at all, which is the whole answer if you know how to read it. **Covers requested
  incident: "Kubernetes Service has no endpoints".**
- **Initial state** — Two seeded faults: a Service whose selector is
  `app: ledger` while the Pods carry `app: ledger-api`; and a second Service
  whose selector is correct but whose `targetPort` is `8080` while the container
  serves `3000`.
- **Student task** — Diagnose each without editing anything first: compare the
  Service selector to the Pod labels, and the `targetPort` to the container's
  `containerPort`. Record the two root causes. Fix both. Then answer, in a
  ConfigMap named `diagnosis`: why an empty endpoint list is a *selector*
  problem and a populated endpoint list with failing requests is a *port or
  application* problem — the one distinction that makes this class of incident
  a two-minute job.
- **Tools** `kubectl get endpointslices`, `kubectl describe svc`,
  `kubectl get pods --show-labels`, `kubectl get svc -o yaml`
- **Verification** — `service_selector`, `service_endpoints` (min 1) and
  `service_http` expecting `200` for **both** Services; `configmap_key` on
  `diagnosis` containing `selector` and `targetPort` — **all supported today**.
- **Supported today?** **Yes, entirely.**
- **New capability** none.

---

#### NET-026 · CoreDNS and NetworkPolicy: It Resolves, But It Will Not Connect
- **Substrate** `k8s` · **Difficulty** advanced · **Duration** 45 min
- **Skills** `k8s.coredns`, `k8s.networkpolicy`, `k8s.dns.search-domains`, `k8s.troubleshoot.connectivity`
- **Prerequisites** NET-025, NET-012
- **Scenario** — A Pod resolves `ledger-api` perfectly and every connection to it
  times out. Both facts are true at once, and together they name the cause.
  **Covers requested incident: "Pod can resolve DNS but cannot connect".**
- **Initial state** — A default-deny `NetworkPolicy` on the namespace whose only
  egress allowance is UDP/53 to `kube-system`. Client Pod, `ledger-api` Service
  and Pods all healthy.
- **Student task** — Establish both halves of the symptom from inside the client
  Pod: `nslookup ledger-api` succeeds, `wget`/`nc` to it times out. Explain in a
  ConfigMap why DNS working *proves* the CNI and CoreDNS are fine and points
  directly at policy. Read the existing policy and write an additional one
  allowing egress from the client to the `ledger-api` Pods on their port, and
  matching ingress on the server side. Prove the connection now succeeds.
  Also record the fully-qualified name CoreDNS answered
  (`ledger-api.<ns>.svc.cluster.local`) and what `search` domains in the Pod's
  `/etc/resolv.conf` made the short name work.
- **Tools** `kubectl exec`, `nslookup`, `kubectl get networkpolicy -o yaml`,
  `kubectl describe netpol`
- **Verification** — `networkpolicy_exists`, `networkpolicy_pod_selector`,
  `networkpolicy_egress_rule`, `networkpolicy_ingress_rule`,
  `networkpolicy_allows_dns` (**declarative, all supported today**) +
  `service_http` expecting `200`. **Caveat:** the behavioural half is only real
  if the cluster's CNI enforces NetworkPolicy — `kindnet`'s enforcement must be
  verified on `kindest/node:v1.34.0`, or Calico installed (**N12**).
- **Supported today?** Declaratively yes; behaviourally **unverified** — N12.
- **New capability** N12 (confirm or install a policy-enforcing CNI).

---

#### NET-027 · NodePort and Ingress: Getting Traffic Into the Cluster
- **Substrate** `k8s` · **Difficulty** advanced · **Duration** 45 min
- **Skills** `k8s.service.nodeport`, `k8s.ingress`, `k8s.ingress.rules`, `devops.l7-routing`
- **Prerequisites** NET-026
- **Scenario** — Two teams need their apps reachable from outside the cluster.
  One asks for a NodePort per service; you have to explain why that does not
  scale past a handful, and build the alternative.
- **Initial state** — Two Deployments and two ClusterIP Services
  (`ledger-api`, `cards-api`); no NodePort, no Ingress.
- **Student task** — Expose one via NodePort, record the allocated port and the
  range it came from (`30000–32767`), and state in a ConfigMap the two reasons
  NodePort does not scale (one port per service, cluster-wide; and the client
  must know a node address). Then write an Ingress routing
  `ledger.bank.internal` → `ledger-api` and `cards.bank.internal` → `cards-api`,
  plus a path-based rule, and explain what component actually implements it (an
  ingress controller — the Ingress object alone does nothing).
- **Tools** `kubectl expose --type=NodePort`, Ingress manifest,
  `kubectl describe ingress`
- **Verification** — `service_type` `NodePort`, `service_port`; `ingress_exists`,
  `ingress_class`, `ingress_rule` ×3 (**declarative, supported today**).
  End-to-end proof that a request through the Ingress reaches the backend needs
  an ingress controller in the kind cluster (**N13**).
- **Supported today?** Declaratively yes; end-to-end no.
- **New capability** N13 (ingress-nginx + `extraPortMappings` in `cluster.yaml`).

---

---

#### NET-033 · Gateway API: The Successor to Ingress
- **Substrate** `k8s` · **Difficulty** advanced · **Duration** 45 min
- **Skills** `k8s.gateway-api`, `k8s.gateway.httproute`, `k8s.gateway.gatewayclass`, `devops.l7-routing`
- **Prerequisites** NET-027
- **Added by the source-policy review (2026-08-23).** The current CKA curriculum
  (v1.35) lists **"Use the Gateway API to manage Ingress traffic"** as an
  explicit Services & Networking competency. A networking track that stopped at
  Ingress would miss a named objective.
- **Scenario** — The bank's platform team owns the shared entry point; two
  application teams own their own routes. With Ingress, every routing change is
  a pull request against one object that the platform team owns. You are asked
  to model the same traffic with Gateway API and explain what changed
  organisationally, not just syntactically.
- **Initial state** — The Ingress from NET-027 in place; Gateway API CRDs and an
  implementation installed in the cluster (**N15**); two Services.
- **Student task** — Convert the Ingress to a `Gateway` (owned by the platform
  role, with an HTTP listener and `allowedRoutes`) plus two `HTTPRoute` objects
  (owned by the app teams) that attach to it via `parentRefs`. Add one thing
  Ingress could not express without annotations — a header-based match or a
  weighted split. Then write, in a ConfigMap, which of `GatewayClass`,
  `Gateway`, `HTTPRoute` maps to which of the three roles the API models
  (infrastructure provider, cluster operator, application developer), and why
  the conversion from Ingress is a one-time migration rather than an upgrade
  (Gateway API does not include the Ingress kind).
- **Tools** `kubectl get gatewayclass,gateway,httproute`,
  `kubectl describe gateway`, manifests
- **Verification** — needs new declarative requirement types for Gateway API
  (**N16**: `gateway_exists`, `gateway_listener`, `httproute_exists`,
  `httproute_rule`, `httproute_parent`), mirroring the existing `ingress_*`
  family; plus `service_http` on the backends and `configmap_key` on the
  role-mapping answer.
- **Supported today?** No — the CRDs are not installed and the verifier has no
  Gateway vocabulary.
- **New capability** N15 (Gateway API CRDs + implementation in `kind`), N16
  (Gateway requirement family), N13 (shared-controller isolation applies here too).


### Phase 6 — Cloud Networking (NET-028 … NET-029)

Both labs are deliberately **design-and-reasoning with deterministic answers**,
because the AWS provider is a stub (C5) and a lab that pretends otherwise would
teach console clicking from memory. Both become hands-on labs unchanged in
*content* once N14 lands.

---

#### NET-028 · VPC Architecture: Subnets, Route Tables, IGW and NAT Gateway
- **Substrate** `tf` (offline) · **Difficulty** advanced · **Duration** 50 min
- **Skills** `aws.vpc`, `aws.subnets`, `aws.route-tables`, `aws.igw-vs-natgw`, `net.topology.public-private`
- **Prerequisites** NET-019, NET-002
- **Scenario** — The bank is moving the ledger to AWS. You have been given the
  requirements — a public tier that terminates traffic from the internet and a
  private tier that must reach the internet for package updates but must never be
  reachable *from* it — and asked to produce the network design before anyone
  opens the console.
- **Initial state** — `/home/student/vpc/requirements.txt` and a skeleton
  `design.txt`, `routes.txt`, `answers.txt`.
- **Student task** — Allocate `10.30.0.0/16` into two public and two private
  `/20`s across two AZs, with no overlap (`design.txt`, exact CIDRs). Write the
  two route tables (`routes.txt`): the public one with `0.0.0.0/0 → igw-…`, the
  private one with `0.0.0.0/0 → nat-…`, both with the implicit local route for
  the VPC CIDR. Then `answers.txt`: what makes a subnet "public" (a route table
  entry to an Internet Gateway — not a name, not a flag); why the NAT Gateway
  lives in a *public* subnet; why an instance in a public subnet with no public
  IP still cannot be reached; and what breaks if both AZs share one NAT Gateway.
- **Tools** the requirements file, `man 7 ip`, NET-002's arithmetic
- **Verification** — `file_content` on the exact CIDRs and route-table entries;
  `answers.txt` graded per question against literal key phrases (`Internet
  Gateway`, `public subnet`, `public IP`, `availability zone`).
- **Supported today?** **Yes, as designed** (deterministic literal answers on the
  existing sandbox).
- **New capability** none for this form; N14 for the LocalStack/Terraform form.

---

#### NET-029 · Security Groups vs NACLs: Stateful and Stateless, Proved Locally
- **Substrate** `net` (design half runs on `linux` today) · **Difficulty** advanced · **Duration** 45 min
- **Skills** `aws.security-groups`, `aws.nacls`, `net.firewall.stateful`, `net.troubleshoot.asymmetric`
- **Prerequisites** NET-028, NET-011
- **Scenario** — A team added an inbound rule for port 443 and their instance
  still cannot be reached. Someone else added a NACL rule and broke every
  *outbound* connection on the subnet. Both are the same misunderstanding.
  **Covers requested incident: "Security Group blocks traffic".**
- **Initial state** — `/home/student/filters/scenario.txt`: a flow table (six
  flows, direction, port, source) and two rule sets — a Security Group and a
  NACL, the NACL missing its ephemeral-port return rule.
- **Student task** — Part one (paper, deterministic): for each of the six flows,
  `allow` or `deny`, and *which* control decided it (`verdicts.txt`). Identify
  the missing NACL rule and write it correctly, including an ephemeral port
  range that is *justified by the client type* (`fix.txt`) — AWS documents
  different ranges per client (Linux kernels `32768-61000`, Windows Server 2008+
  `49152-65535`, ELB / NAT gateway / Lambda `1024-65535`) and says that in
  practice `1024-65535` covers mixed clients. The lab grades the justification,
  not one memorised number. In `why.txt`: what "stateful" buys you (the return packet is
  allowed because the outbound one was seen), and why a stateless list needs an
  explicit rule in each direction. Part two (mechanism, on the `net` sandbox):
  reproduce both behaviours locally with nftables — one rule set using `ct state
  established,related accept` and one without — and show that removing the
  conntrack rule breaks return traffic exactly as the NACL did
  (`proof.txt`).
- **Tools** the scenario file; `nft`, `curl`, `ss` for part two
- **Verification** — `file_content` per flow verdict; `fix.txt` must name a
  documented range **and** the client type it belongs to (any of the five AWS
  ranges accepted, each paired with its client — this needs **N10**, regex
  matching, to grade fairly); `why.txt` must contain `stateful` and `both
  directions`; `proof.txt` must show the two nftables outcomes.
- **Supported today?** Part one **yes**; part two needs N1 + N4.
- **New capability** N1, N4 (part two only).

---

### Phase 7 — Production Incidents (NET-030 … NET-032)

Timed, multi-fault, minimal instruction. The student gets a page from monitoring
and a shell. Each requires a written incident note before the fix is accepted —
that note is what distinguishes a diagnosis from a lucky restart.

---

#### NET-030 · Incident: "It Works On The Box"
- **Substrate** `net` · **Difficulty** expert · **Duration** 50 min
- **Skills** `net.troubleshoot.systematic`, `net.troubleshoot.bind-address`, `net.firewall.rules`, `net.l3.routing`, `net.incident.writeup`
- **Prerequisites** NET-011, NET-007, NET-005
- **Scenario** — 09:14. The ledger API was deployed last night. The deploying
  engineer's `curl localhost` succeeds. The load balancer has it out of rotation,
  the mobile team is escalating, and you have the box. **Covers requested
  incidents: bind address, firewall block, missing route.**
- **Initial state** — Three independent faults, only one of which is the cause of
  the page: the service is bound to `127.0.0.1`; a firewall rule drops the
  health-check port; and a stale static route for the monitoring subnet points at
  a dead next hop. The student is told **nothing** about how many faults exist.
- **Student task** — Work down the layers, recording each observation with its
  evidence in `incident/timeline.txt` (a real timeline: time, what you checked,
  what you saw, what it ruled out). Fix what is broken. Produce
  `incident/report.txt` with: the symptom as reported, the actual root cause of
  the page, the two other faults found on the way and whether they were
  contributing or incidental, and one prevention item that is not "be more
  careful".
- **Tools** everything from Phases 2–4
- **Verification** — `port_listening` `0.0.0.0:8080` (N5); firewall port
  reachable via `http_request` (N6); `ip route` no longer contains the dead next
  hop (`file_content_absent` on a saved capture, or N7); `timeline.txt` must
  contain at least three distinct checks; `report.txt` must name `bind`,
  `firewall` and `route`.
- **Supported today?** No.
- **New capability** N1–N6.

---

#### NET-031 · Incident: The DNS Change That Would Not Take
- **Substrate** `net` · **Difficulty** expert · **Duration** 50 min
- **Skills** `dns.troubleshoot.stale`, `dns.ttl.propagation`, `dns.records.cname`, `net.incident.writeup`
- **Prerequisites** NET-014, NET-013
- **Scenario** — 22:40, during a cutover window. Half the fleet reaches the new
  ledger host, half reaches the old one, and one service reaches nothing at all
  with `NXDOMAIN`. The change ticket says the record was updated an hour ago.
  **Covers requested incident: "DNS resolves incorrectly".**
- **Initial state** — Three overlapping faults: the `A` record was updated but a
  `CNAME` in front of it still points at the old name; the resolver holds a
  cached answer with a long remaining TTL; and one host has a stale
  `/etc/hosts` entry that beats DNS entirely.
- **Student task** — Determine, per symptom, *which* of the three explains it —
  by querying the authoritative server, the recursive resolver and the stub
  resolver separately and comparing (`incident/queries.txt`). Fix the record
  chain at the authoritative server, and fix the `/etc/hosts` override. Do
  **not** try to fix the cache — instead state in `incident/report.txt` what will
  make it converge, when, and what should have been done before the window
  (lower the TTL 24h ahead).
- **Tools** `dig @<server>`, `dig +norecurse`, `getent hosts`, `/etc/hosts`,
  zone file
- **Verification** — `command_output` `getent hosts ledger.bank.internal`
  containing the **new** IP (works today); zone file `file_content` for the
  corrected target and `file_content_absent` for the old one;
  `/etc/hosts` no longer contains the override (`file_content_absent`);
  `report.txt` must contain `TTL` and `cache`.
- **Supported today?** No (DNS servers, `dig`).
- **New capability** N1, N2, N3.

---

#### NET-032 · Incident: The Load Balancer Returns 502 At 03:00 — Capstone
- **Substrate** `k8s` · **Difficulty** expert · **Duration** 60 min
- **Skills** `net.troubleshoot.end-to-end`, `k8s.endpoints`, `devops.health-checks`, `net.troubleshoot.502-503-504`, `net.incident.writeup`
- **Prerequisites** NET-025, NET-026, NET-020, NET-018
- **Scenario** — 03:02. The public endpoint is returning `502` for about a third
  of requests. Nothing was deployed. The on-call runbook says "restart the
  deployment", which will make the evidence disappear. **Covers requested
  incidents: 502, health check failure, Service endpoints, Pod connectivity.**
- **Initial state** — A three-replica Deployment behind a Service behind an
  Ingress. One replica is `Running` but failing its readiness probe *and* the
  Service's `targetPort` was recently changed so that the probe passes on a port
  the Service does not use; a NetworkPolicy blocks one path. Roughly one in
  three requests fails — the intermittency is the clue.
- **Student task** — Work from the outside in and record every step in
  `incident/timeline` (a ConfigMap): the Ingress, the Service, the
  EndpointSlices, the Pods, the probes, the policy. Identify why the failure is *intermittent* (a
  subset of endpoints is bad — a total failure and a partial failure have
  different causes and this distinction is the lab). Fix the cause. Write the
  incident report as a ConfigMap: symptom, root cause, why a restart would have
  "fixed" it while destroying the evidence and leaving the real fault in place,
  and the detection gap that let a bad endpoint stay in rotation.
- **Tools** `kubectl get/describe endpointslices,svc,ingress,netpol`,
  `kubectl exec`, `kubectl logs`, probe definitions
- **Verification** — `service_endpoints` (min 3), `deployment_probe`,
  `service_port`, `service_http` expecting `200` **repeatedly** (the
  intermittency must be gone), `networkpolicy_*`, `configmap_key` on the report
  containing `endpoint`, `readiness` and `intermittent` — **almost all supported
  today**; N13 for a genuine through-the-Ingress request.
- **Supported today?** **Largely yes** — this capstone is buildable on the
  current Kubernetes provider, with the Ingress hop verified declaratively until
  N13.
- **New capability** N13 (optional), N12 (for the policy half to be behavioural).

---

## Part 2b — Coverage matrices

### Requested topics → labs

| Topic | Labs |
|---|---|
| what is a network, LAN/WAN, client/server | NET-001, NET-003 |
| OSI model, TCP/IP model | NET-003 |
| packets and frames, MAC addresses | NET-004, NET-003 |
| IP addresses, IPv4, public vs private | NET-001, NET-002 |
| localhost / loopback | NET-001, NET-006, NET-007 |
| CIDR, subnet masks, subnetting | NET-002, NET-028 |
| default gateway, routing | NET-005, NET-019, NET-028 |
| TCP, UDP, connection lifecycle, handshake | NET-008 |
| ports, sockets | NET-006, NET-008 |
| ICMP | NET-009 |
| ARP | NET-004 |
| DHCP | NET-010 |
| DNS (recursive, authoritative, records, TTL, caching, dig/nslookup) | NET-012, NET-013, NET-014, NET-031 |
| DNS troubleshooting | NET-014, NET-023, NET-031 |
| HTTP | NET-015, NET-017 |
| HTTPS, TLS | NET-016 |
| `ip`, `ss`, `ping`, `curl`, `traceroute`, `dig`, `ip route` | NET-001, NET-005, NET-006, NET-009, NET-012, NET-015 |
| interfaces, listening ports, established connections | NET-001, NET-006 |
| localhost vs 0.0.0.0 | NET-007 |
| firewall concepts | NET-011, NET-029 |
| reverse proxies | NET-017 |
| load balancers, L4 vs L7, health checks | NET-018 |
| NAT, proxies, ingress/egress | NET-019 |
| connection timeout / refused / DNS failure / TLS failure | NET-009, NET-011, NET-016, NET-020 |
| 502 / 503 / 504 troubleshooting | NET-020, NET-032 |
| container networking, bridge, port publishing | NET-021, NET-022 |
| container DNS, service-to-service | NET-023 |
| network namespaces | NET-021 |
| Pod networking, Service, ClusterIP | NET-024 |
| NodePort, Ingress | NET-027 |
| Gateway API (current CKA objective) | NET-033 |
| CoreDNS | NET-026 |
| NetworkPolicy, CNI concepts | NET-026, NET-024 |
| VPC, subnet, route table, IGW, NAT GW | NET-028 |
| Security Groups, NACLs | NET-029 |
| ALB/NLB, Route 53, public/private architecture | NET-018 (L4/L7 model), NET-013 (record types), NET-028 |
| public/private architecture | NET-019, NET-028 |

Two topics are covered by **transfer rather than by the vendor product**, and
this is deliberate: `ALB/NLB` is taught as L4-vs-L7 load balancing with real
health checks (NET-018), and `Route 53` as authoritative DNS with real record
types and TTLs (NET-013/NET-014). A student who has done those can use the AWS
console; a student who has only clicked the console cannot debug either. Once
N14 lands, an AWS-specific lab can be appended to Phase 6 without disturbing the
progression.

### Requested production incidents → labs

| Incident | Lab |
|---|---|
| works with `curl localhost`, browser cannot reach it | NET-007, NET-030 |
| service listens on 127.0.0.1 instead of 0.0.0.0 | NET-007, NET-030 |
| DNS resolves incorrectly | NET-014, NET-031 |
| wrong port | NET-022, NET-025 |
| firewall blocks traffic | NET-011, NET-030 |
| missing route | NET-005, NET-030 |
| TLS certificate problem | NET-016 |
| load balancer health check fails | NET-018, NET-032 |
| application returns 502 | NET-020, NET-032 |
| application returns 503 | NET-020 |
| application returns 504 | NET-020 |
| containers cannot communicate | NET-023 |
| Kubernetes Service has no endpoints | NET-025, NET-032 |
| Pod can resolve DNS but cannot connect | NET-026 |
| Security Group blocks traffic | NET-029 |

---

## Part 3 — Capability roadmap

### What ships with **zero** platform changes

Six labs are fully buildable and fully verifiable today:

| Lab | Substrate | Why it works now |
|---|---|---|
| NET-002 CIDR & subnetting | `linux` | pure calculation, literal answers |
| NET-003 OSI/TCP-IP triage | `linux` | classification, literal answers |
| NET-022 Port publishing | `docker` | `docker_container_port` grades the mapping directly |
| NET-024 Pod networking & ClusterIP | `k8s` | `service_*` + `service_http` |
| NET-025 Service with no endpoints | `k8s` | `service_selector` + `service_endpoints` + `service_http` |
| NET-028 VPC design | `tf`/`linux` | deterministic design answers |

Three more are buildable today with **evidence-based** verification (student-
written workspace files) and become properly verifiable with N9: NET-010,
NET-019, NET-021, NET-023. NET-032, the capstone, is ~90% buildable today.

**Recommended first wave: NET-002, NET-003, NET-024, NET-025, NET-022, NET-028.**
That is a coherent 6-lab release proving the track's pedagogy — reasoning +
Kubernetes service debugging — before any sandbox work starts.

### New capabilities, in dependency order

| ID | Capability | What it unblocks | Size |
|---|---|---|---|
| **N5** | `address` field on `port_listening` / `port_not_listening` | NET-006, NET-007, NET-030 | **XS** — the parser already keeps `address` (`sandbox-reader.ts:302`); schema field + handler comparison, ~20 lines, plus normalising `*`/`0.0.0.0`/`[::]` |
| **N1** | `jumptotech/lab-net` sandbox image | all `net` labs | **S** — Linux image + `curl`, `dnsutils`, `traceroute`, `tcpdump`, `openssl`, `nginx`, `jq`, `nftables`. Also fixes the LINUX-006 `curl` discrepancy if `curl` is added to the Linux image |
| **N2** | Per-session **internal** bridge + deterministic addressing | all `net` labs | **M** — a `networking` provider setting `network:` to a per-session `--internal` bridge, fixed subnet `10.90.0.0/24`, fixed sandbox IP. Must stay egress-free: an internal bridge gives a real link with no route off the host |
| **N3** | Multi-container topology per session (peers, DNS servers, proxies) | NET-001, 004, 006, 007, 009, 012–018, 020, 030, 031 | **L** — the largest item. The session model owns one sandbox ref today; a topology needs N containers with one shell attachment, plus lifecycle/reaper/quota changes. Alternative: express topologies as `setup.docker` on the Docker provider and accept `docker exec` as the student's entry point |
| **N6** | `http_request` requirement (sandbox family) | NET-007, 015, 017, 018, 020, 030 | **S/M** — a platform-performed HTTP request from inside the session's sandbox (or from a topology peer) with `expected_status`, `body_contains`, `timeout_seconds`. Modelled on `service_http`, which is `kubernetes`-only. **Must support non-2xx expectations** (NET-020 grades a `503` that must still be there) |
| **N4** | `NET_ADMIN` / `NET_RAW` grantable — for the networking provider only | NET-004, 008, 011, 029 pt2 | **S code / L review** — one entry each in `GRANTABLE_CAPABILITIES`. This is a genuine security decision, not a config tweak: `NET_ADMIN` in a container lets it manipulate its own netns and, combined with a shared bridge, observe neighbours. Mitigation: per-session `--internal` bridge (N2) so the blast radius is one session's own segment, and grant only to the `networking` provider. **If this review does not pass, route these four labs to the Docker provider instead** — the privileged DinD sandbox already permits all of it with no policy change |
| **N8** | Tooling-image pre-pull for Docker labs | NET-010, 011, 019, 021, 022, 023 | **XS** — `setup.docker.images` already exists; add the networking tooling image to those labs |
| **N9** | `docker_exec_probe` — allow-listed argv inside a named container, read-only | honest verification for NET-010, 011, 019, 021, 023 | **M** — mirrors the existing `command_output` fence (closed command allow-list, argv array, no shell) but targets a student container via their own daemon. Turns "the student wrote it in a file" into "the platform observed it" |
| **N7** | `ip` (read-only subcommands) added to `VERIFIER_COMMANDS` | NET-005, 030 | **S** — `ip` is not read-only as a binary; needs an argv-shape allow-list (`ip route show`, `ip -j addr show`, `ip neigh show`) rather than a bare command entry, or a dedicated `route_exists` requirement type |
| **N10** | `file_content_matches` (anchored regex, bounded) | NET-014, and richer grading everywhere | **S** — today only literal `contains` exists, which forces every gradeable value to be seeded |
| **N11** | `tls_certificate` requirement | NET-016 | **M** — assert subject/SAN/issuer/expiry and whether the endpoint validates against the sandbox trust store |
| **N12** | Confirm or install a NetworkPolicy-enforcing CNI in `kind` | NET-026, NET-032 | **S/M** — verify `kindnet` enforcement on `kindest/node:v1.34.0`; if it does not enforce, install Calico in `cluster-up.sh`. **Until this is settled, NET-026 teaches a policy that is written but not enforced — which is worse than not teaching it**, so this must be resolved before NET-026 ships |
| **N13** | ingress-nginx + `extraPortMappings` in `infrastructure/kind/cluster.yaml` | NET-027, NET-032 end-to-end | **M** — plus a per-namespace ingress class or host-based isolation so sessions do not collide on one shared controller |
| **N14** | AWS-real path: LocalStack service + AWS provider in the Terraform mirror | hands-on Phase 6 | **L** — needs egress or a vendored mirror, a LocalStack container per session, and cost/isolation review. The AWS provider stub stays untouched |

### Suggested build order

1. **Wave 1 — no platform work.** NET-002, NET-003, NET-022, NET-024, NET-025,
   NET-028. Ships the track's identity: reasoning and service debugging.
2. **Wave 2 — N5 + N8 + N9.** NET-006 (partial), NET-010, NET-011, NET-019,
   NET-021, NET-023. All on the existing Docker provider. Cheap, and it front-
   loads container networking, which is what the audience needs first.
3. **Wave 3 — N12, N13.** NET-026, NET-027, NET-032. Completes Kubernetes.
4. **Wave 4 — N1, N2, N6 (+N3, N4).** The whole `net` substrate: Phases 1–4 and
   the DNS/TLS/proxy labs. This is the big investment and the biggest payoff —
   19 of the 33 labs sit on it.
5. **Wave 5 — N14 or leave Phase 6 as design labs.** Judgement call; the design
   labs are defensible on their own.

### Open questions for the platform owner

1. **N3 vs Docker-as-topology.** Multi-container topologies are the single
   largest cost in this plan. Expressing them as `setup.docker` on the existing
   Docker provider avoids all session-model work but makes `docker exec` the
   student's entry point for labs that are conceptually about a Linux host.
   Which trade is preferred?
2. **N4 security review.** Does `NET_ADMIN` on a per-session `--internal` bridge
   pass? If not, four labs move to the Docker provider and Phase 2 loses some
   directness.
3. **Egress.** Several designs assume **no** egress from any sandbox, which is
   the current posture. Confirmed as a hard constraint?
4. **N12 before NET-026.** Does `kindnet` on `kindest/node:v1.34.0` enforce
   NetworkPolicy in this cluster? This needs an empirical answer before the
   NetworkPolicy lab is written.
5. **Shared-cluster Ingress.** One controller for all sessions needs a per-
   session isolation story (host-based or class-based) before NET-027.

---

## Part 4 — Official-source compliance review

Performed **2026-08-23** against the JumpToTech official-source curriculum
policy. Every statement below was read from the official source cited, not from
recall. Third-party training material was not consulted.

### 4.1 Objectives confirmed from official sources

| Certification / standard | Confirmed | Source | Verified |
|---|---|---|---|
| **CKA** — domains and weights: Cluster Architecture, Installation & Configuration **25%**; Workloads & Scheduling **15%**; Storage **10%**; Services & Networking **20%**; **Troubleshooting 30%**. Exam tracks **Kubernetes v1.35**, aligned to the latest minor within ~4–8 weeks | yes | training.linuxfoundation.org CKA page; `cncf/curriculum` holds `CKA_Curriculum_v1.35.pdf` | 2026-08-23 |
| **CKA Services & Networking** competencies, verbatim: *Understand connectivity between Pods*; *Define and enforce Network Policies*; *Use ClusterIP, NodePort, LoadBalancer service types and endpoints*; *Use the Gateway API to manage Ingress traffic*; *Know how to use Ingress controllers and Ingress resources*; *Understand and use CoreDNS* | yes | as above | 2026-08-23 |
| **CKA Troubleshooting** competencies, verbatim: *Troubleshoot clusters and nodes*; *Troubleshoot cluster components*; *Monitor cluster and application resource usage*; *Manage and evaluate container output streams*; *Troubleshoot services and networking* | yes | as above | 2026-08-23 |
| **LFCS** — domains: Operations Deployment 25%; **Networking 25%**; Storage 20%; Essential Commands 20%; Users and Groups 10% | yes | training.linuxfoundation.org LFCS page | 2026-08-23 |
| **LFCS Networking** competencies, verbatim: *Configure IPv4 and IPv6 networking and hostname resolution*; *Set and synchronize system time using time servers*; *Monitor and troubleshoot networking*; *Configure the OpenSSH server and client*; *Configure packet filtering, port redirection, and NAT*; *Configure static routing*; *Configure bridge and bonding devices*; *Implement reverse proxies and load balancers* | yes | as above | 2026-08-23 |
| **DCA (Docker Certified Associate)** | **NOT confirmed** — availability is contradictory across sources; Mirantis administers it, and no authoritative current status page was obtained | — | 2026-08-23 |
| **AWS** | No AWS certification is claimed by this track. AWS labs are grounded in AWS technical documentation only | docs.aws.amazon.com | 2026-08-23 |

**Neither the CKA nor the LFCS page publishes per-objective version stamps**, so
`objective_version` is recorded as the curriculum file version (`CKA v1.35`) and
the page-read date, which is the strongest honest claim available.

### 4.2 Labs mapped to current certification objectives

**CKA v1.35 — Services & Networking (20%) and Troubleshooting (30%)**

| Official objective (verbatim) | Labs | Depth |
|---|---|---|
| Understand connectivity between Pods | NET-024, NET-026 | PRACTICED |
| Define and enforce Network Policies | NET-026 | PRACTICED (enforcement pending N12) |
| Use ClusterIP, NodePort, LoadBalancer service types and endpoints | NET-024, NET-025, NET-027 | PRACTICED — **LoadBalancer NOT COVERED** (no cloud provider in `kind`) |
| Use the Gateway API to manage Ingress traffic | **NET-033** (added by this review) | INTRODUCED (pending N15/N16) |
| Know how to use Ingress controllers and Ingress resources | NET-027 | PRACTICED (end-to-end pending N13) |
| Understand and use CoreDNS | NET-026 | PRACTICED |
| Troubleshoot services and networking | NET-025, NET-026, NET-032 | ASSESSMENT |

**LFCS — Networking (25%)**

| Official objective (verbatim) | Labs | Depth |
|---|---|---|
| Configure IPv4 and IPv6 networking and hostname resolution | NET-001, NET-002, NET-012 | PRACTICED for IPv4; **IPv6 barely INTRODUCED** — see 4.6 |
| Monitor and troubleshoot networking | NET-006, NET-009, NET-030 | ASSESSMENT |
| Configure packet filtering, port redirection, and NAT | NET-011, NET-019, NET-022 | PRACTICED |
| Configure static routing | NET-005, NET-030 | PRACTICED |
| Implement reverse proxies and load balancers | NET-017, NET-018 | PRACTICED |
| Set and synchronize system time using time servers | — | **NOT COVERED** |
| Configure the OpenSSH server and client | — | **NOT COVERED** |
| Configure bridge and bonding devices | NET-021 (bridges, container context only) | **INTRODUCED / bonding NOT COVERED** |

### 4.3 Labs that are production skills, not exam objectives

Marked **FOUNDATIONAL / PRODUCTION SKILL**, never as certification objectives:

NET-001, NET-002, NET-003, NET-004, NET-006, NET-007, NET-008, NET-009,
NET-010, NET-013, NET-014, NET-015, NET-016, NET-020, NET-023, NET-028,
NET-029, NET-030, NET-031.

Notes: NET-002/003 are protocol-standards fundamentals (IETF), not any exam's
objective. NET-021/022/023 are grounded in Docker documentation but are **not**
claimed as DCA objectives (4.1). NET-028/029 are AWS **production** skills — the
track claims no AWS certification, and per policy §4 the distinction is stated in
each lab. NET-016 (TLS) is an IETF-standards lab, not an exam objective.

### 4.4 Unsupported or outdated topics found

Three, all now corrected in the plan above.

**CONFLICT 1 — Kubernetes Endpoints API**
- **EXISTING LAB:** proposed NET-024, NET-025, NET-032 (this plan, pre-review).
- **CURRENT BEHAVIOR:** taught `kubectl get endpoints` as the diagnostic command,
  and NET-025 was titled "The Service With No Endpoints".
- **OFFICIAL DOCUMENTATION:** the Endpoints API is **deprecated as of Kubernetes
  v1.33**; the API server returns warnings to users who read or write Endpoints
  rather than EndpointSlices (kubernetes.io blog, 2025-04-24, "Continuing the
  transition from Endpoints to EndpointSlices"; and the Service concept page,
  which carries an "Endpoints (deprecated)" section). EndpointSlice has been
  stable since v1.21.
- **CONFLICT:** the track would teach a deprecated API on a v1.34 cluster, and
  students would hit deprecation warnings the labs never explain.
- **RECOMMENDED CORRECTION:** **applied.** Labs teach EndpointSlice
  (`kubectl get endpointslices -l kubernetes.io/service-name=…`); NET-025 renamed.
  **The platform is already correct** — `k8s/client.ts:475` reads EndpointSlices
  and its comment says so, so the `service_endpoints` requirement type needs no
  change. *Out-of-scope observation for the Kubernetes track owner: K8S-003 and
  any other lab text that instructs `kubectl get endpoints` needs the same
  correction. Not changed on this branch.*

**CONFLICT 2 — AWS ephemeral port range**
- **EXISTING LAB:** proposed NET-029 (pre-review).
- **CURRENT BEHAVIOR:** graded a single literal answer, `1024-65535`, as *the*
  ephemeral range for a NACL return rule.
- **OFFICIAL DOCUMENTATION:** AWS VPC User Guide, *Ephemeral ports*: "Many Linux
  kernels (including the Amazon Linux kernel) use ports 32768-61000"; ELB
  `1024-65535`; Windows through Server 2003 `1025-5000`; Windows Server 2008 and
  later `49152-65535`; NAT gateway `1024-65535`; Lambda `1024-65535`. The
  example NACL in that guide uses `32768-65535`, and AWS says only that "in
  practice … you can open ephemeral ports 1024-65535" to cover mixed clients.
- **CONFLICT:** the lab would have marked a correct, documented answer wrong,
  and would have taught a number instead of the rule that the range depends on
  the initiating client.
- **RECOMMENDED CORRECTION:** **applied.** The lab now grades a documented range
  *paired with its client type*, and the fair-grading requirement raises the
  priority of **N10** (regex matching).

**CONFLICT 3 — CKA objective coverage gap (Gateway API)**
- **EXISTING LAB:** none — that was the problem.
- **CURRENT BEHAVIOR:** the plan covered cluster ingress with Ingress only.
- **OFFICIAL DOCUMENTATION:** CKA v1.35 lists "Use the Gateway API to manage
  Ingress traffic"; kubernetes.io states Gateway API "is the successor to the
  Ingress API", is an **add-on** shipped as CRDs, and that migration from Ingress
  is a one-time conversion because Gateway API does not include the Ingress kind.
- **CONFLICT:** a named current objective was absent.
- **RECOMMENDED CORRECTION:** **applied** — NET-033 added, with capabilities
  N15/N16.

**Not a conflict, but recorded:** NET-020's `503` case. RFC 9110 §15.6.4 defines
`503` as "The server is currently unable to handle the request due to a temporary
overload or scheduled maintenance." "No healthy upstreams" is proxy-implementation
behaviour, not an RFC definition, and the lab text now attributes it that way.
§15.6.3 (`502`) and §15.6.5 (`504`) are quoted directly.

### 4.5 Official documentation per lab

| Lab | Official sources (type: official documentation / standard, unless noted) |
|---|---|
| NET-001 | RFC 1122 (host requirements, loopback); man `ip(8)`, `hostname(1)` (iproute2 / upstream) |
| NET-002 | RFC 4632 (CIDR); RFC 1918 (private address space); RFC 6890 (special-purpose registry); IANA IPv4 Special-Purpose Address Registry |
| NET-003 | RFC 1122 / RFC 1123 (Internet host requirements); ISO/IEC 7498-1 (OSI reference model — cited, not reproduced) |
| NET-004 | RFC 826 (ARP); man `tcpdump(8)`, `ip-neighbour(8)` |
| NET-005 | RFC 1812 (router requirements, longest-prefix match); man `ip-route(8)`; docs.kernel.org networking |
| NET-006 | man `ss(8)`; RFC 9293 §3.1 (connection identified by a four-tuple) |
| NET-007 | RFC 1122 §3.2.1.3 (loopback / wildcard address); man `ss(8)`, `bind(2)` |
| NET-008 | **RFC 9293** (TCP, STD 7 — obsoletes RFC 793); RFC 768 (UDP); man `tcpdump(8)` |
| NET-009 | RFC 792 (ICMP); RFC 1122 §3.2.2; man `ping(8)`, `traceroute(8)` |
| NET-010 | RFC 2131 (DHCP); docs.docker.com — networking / IPAM |
| NET-011 | netfilter/nftables project documentation; man `nft(8)`; docs.kernel.org — netfilter sysctl and bridge-netfilter behaviour (peripheral; the nftables project docs are the primary source) |
| NET-012 | RFC 1034, RFC 1035 (DNS); **RFC 9499** (DNS Terminology, BCP 219 — obsoletes 8499); man `nsswitch.conf(5)`, `resolv.conf(5)` |
| NET-013 | RFC 1035 (A, CNAME, MX, TXT, TTL); RFC 3596 (AAAA); RFC 2181 §10.1 (CNAME restrictions incl. apex); RFC 7208 (SPF in TXT) |
| NET-014 | RFC 1034 §3.6, RFC 2308 (negative caching / TTL); RFC 9499 (cache, TTL definitions) |
| NET-015 | **RFC 9110** (HTTP Semantics, STD 97); RFC 9112 (HTTP/1.1); §7.2 Host header |
| NET-016 | **RFC 8446** (TLS 1.3); RFC 6066 §3 (SNI); RFC 5280 (X.509); RFC 9110 §4.2.2 (https URI scheme); OpenSSL documentation |
| NET-017 | RFC 9110 §7.6.3 (intermediaries); RFC 7239 (Forwarded); nginx official documentation |
| NET-018 | RFC 9110 (semantics); nginx / HAProxy official documentation for health checks |
| NET-019 | RFC 2663 (NAT terminology), RFC 3022 (traditional NAT), RFC 6888 (CGN requirements); docs.docker.com networking |
| NET-020 | **RFC 9110 §15.6.3 (502), §15.6.4 (503), §15.6.5 (504)**; nginx official documentation for proxy timeouts |
| NET-021 | man `network_namespaces(7)` and `ip-netns(8)` (man7.org) — **source-policy re-check 2026-08-23: network namespaces are documented in the man pages, not on docs.kernel.org**, whose networking index covers protocol and driver subsystems; docs.kernel.org — networking subsystem behaviour; docs.docker.com — network drivers |
| NET-022 | docs.docker.com — publishing ports, bridge driver |
| NET-023 | docs.docker.com — embedded DNS server at `127.0.0.11`, user-defined vs default bridge name resolution, `--alias` |
| NET-024 | kubernetes.io — Service, EndpointSlices, Cluster Networking (CNI model) |
| NET-025 | kubernetes.io — Service (selectors, targetPort), EndpointSlices, Debug Services |
| NET-026 | kubernetes.io — Network Policies, DNS for Services and Pods, CoreDNS |
| NET-027 | kubernetes.io — Service (NodePort, port range), Ingress, Ingress Controllers |
| NET-028 | AWS VPC User Guide — VPCs and subnets, route tables, internet gateways, NAT gateways; AWS Well-Architected (architecture only) |
| NET-029 | AWS VPC User Guide — *Compare security groups and network ACLs* ("Return traffic: Automatically allowed (stateful)" vs "Must be explicitly allowed (stateless)"), *Ephemeral ports*; netfilter conntrack documentation for the local proof |
| NET-030 | composite: RFC 1122, man `ss(8)`, `ip-route(8)`, nftables documentation |
| NET-031 | RFC 1034/1035, RFC 2308, RFC 9499; man `resolv.conf(5)`, `hosts(5)` |
| NET-032 | kubernetes.io — Debug Services, EndpointSlices, Configure Liveness/Readiness/Startup Probes, Network Policies, Ingress |
| NET-033 | kubernetes.io — Gateway API (GatewayClass / Gateway / HTTPRoute, successor to Ingress, add-on CRDs); gateway-api.sigs.k8s.io |

Every lab's `references:` block will carry the URLs for its row. Per policy §12,
scenarios, fictional companies (JumpToTech Bank), incidents, task wording,
starting states, hints and verifier logic are original; documentation is linked,
never reproduced at length.

### 4.6 Missing official objectives

| Gap | Objective | Recommendation |
|---|---|---|
| **IPv6** | LFCS: "Configure IPv4 **and IPv6** networking and hostname resolution"; Kubernetes dual-stack is EndpointSlice-only | The plan is IPv4-first with only AAAA in NET-013. **Recommend:** extend NET-002 with an IPv6 addressing section (RFC 4291) and add IPv6 to NET-001's findings. A dedicated IPv6 lab is a candidate for a later wave. Flagged, not silently added. |
| **LoadBalancer Service type** | CKA: "Use ClusterIP, NodePort, LoadBalancer service types and endpoints" | `kind` has no cloud provider, so a real LoadBalancer needs MetalLB or `cloud-provider-kind` (**N17**). Until then NET-027 covers it conceptually and the matrix records it as NOT COVERED rather than claiming it. |
| **Gateway API** | CKA: "Use the Gateway API to manage Ingress traffic" | Closed by NET-033 (N15/N16). |
| **OpenSSH server and client** | LFCS Networking | Out of scope for a networking track by topic, arguably in scope by objective. **Recommend:** assign to the Linux track owner rather than duplicating here. |
| **Time synchronisation** | LFCS Networking | Same — Linux track. |
| **Bridge and bonding devices** | LFCS Networking | Bonding is not demonstrable in a container sandbox (no multiple physical links, no `NET_ADMIN` by default). **Recommend:** record as NOT COVERED with the technical reason, rather than simulating it. |
| **AWS certification mapping** | none claimed | If an AWS certification is ever targeted, re-derive NET-028/029 against that exam's **current official exam guide** and split CERTIFICATION OBJECTIVE from PRODUCTION DEVOPS SKILL per policy §4. |

### 4.7 Recommended curriculum corrections

1. **Applied** — EndpointSlice replaces Endpoints in NET-024/025/032.
2. **Applied** — NET-029 grades ephemeral ranges per documented client type.
3. **Applied** — NET-033 (Gateway API) added; track is now 33 labs.
4. **Applied** — NET-020 attributes `503`-on-no-healthy-upstreams to the proxy,
   with RFC 9110 §15.6.4 quoted for the status code itself.
5. **Open, for the Kubernetes track owner** — existing K8S labs that instruct
   `kubectl get endpoints` carry Conflict 1. Not touched on this branch.
6. **Open, for the Docker track owner** — existing Docker labs declare
   `certification: DCA`. DCA's current status could not be confirmed from an
   authoritative source. Per policy §13, if it is retired those labs should be
   reclassified as **PRODUCTION SKILL** rather than deleted. Not touched here.
7. **Open, for the Linux track owner** — `LINUX-006` instructs `curl` and cites
   `man curl`; neither is in `sandbox-linux.Dockerfile`. Reported in Part 1 (C3).
8. **Track-wide** — no networking lab may claim a certification objective unless
   it appears in this document's 4.2 tables with a verified date.

### 4.8 Proposed certification coverage matrix

Maintained per policy §11; classification: NOT COVERED / INTRODUCED / PRACTICED /
ADVANCED / ASSESSMENT.

| Certification | Objective (verbatim) | Labs | Difficulty | Coverage | Official source | Verified |
|---|---|---|---|---|---|---|
| CKA v1.35 | Understand connectivity between Pods | NET-024, NET-026 | intermediate–advanced | PRACTICED | LF CKA page; kubernetes.io Cluster Networking | 2026-08-23 |
| CKA v1.35 | Define and enforce Network Policies | NET-026 | advanced | PRACTICED* | kubernetes.io Network Policies | 2026-08-23 |
| CKA v1.35 | Use ClusterIP, NodePort, LoadBalancer service types and endpoints | NET-024, NET-025, NET-027 | intermediate–advanced | PRACTICED (LoadBalancer: NOT COVERED) | kubernetes.io Service | 2026-08-23 |
| CKA v1.35 | Use the Gateway API to manage Ingress traffic | NET-033 | advanced | INTRODUCED | kubernetes.io Gateway API | 2026-08-23 |
| CKA v1.35 | Know how to use Ingress controllers and Ingress resources | NET-027 | advanced | PRACTICED* | kubernetes.io Ingress / Ingress Controllers | 2026-08-23 |
| CKA v1.35 | Understand and use CoreDNS | NET-026 | advanced | PRACTICED | kubernetes.io DNS for Services and Pods | 2026-08-23 |
| CKA v1.35 | Troubleshoot services and networking | NET-025, NET-026, NET-032 | advanced–expert | ASSESSMENT | LF CKA page; kubernetes.io Debug Services | 2026-08-23 |
| LFCS | Configure IPv4 and IPv6 networking and hostname resolution | NET-001, NET-002, NET-012 | beginner–intermediate | PRACTICED (IPv6: INTRODUCED) | LF LFCS page | 2026-08-23 |
| LFCS | Monitor and troubleshoot networking | NET-006, NET-009, NET-030 | intermediate–expert | ASSESSMENT | LF LFCS page | 2026-08-23 |
| LFCS | Configure packet filtering, port redirection, and NAT | NET-011, NET-019, NET-022 | intermediate–advanced | PRACTICED | LF LFCS page | 2026-08-23 |
| LFCS | Configure static routing | NET-005, NET-030 | intermediate–expert | PRACTICED | LF LFCS page | 2026-08-23 |
| LFCS | Implement reverse proxies and load balancers | NET-017, NET-018 | intermediate–advanced | PRACTICED | LF LFCS page | 2026-08-23 |
| LFCS | Set and synchronize system time using time servers | — | — | NOT COVERED | LF LFCS page | 2026-08-23 |
| LFCS | Configure the OpenSSH server and client | — | — | NOT COVERED | LF LFCS page | 2026-08-23 |
| LFCS | Configure bridge and bonding devices | NET-021 | advanced | INTRODUCED (bonding NOT COVERED) | LF LFCS page | 2026-08-23 |

`*` behavioural coverage depends on N12 (policy-enforcing CNI) and N13 (ingress
controller). Until those land, coverage is **declarative only** and the matrix
must say so — a written-but-unenforced NetworkPolicy is worse than no lab.

### 4.9 Source metadata — schema recommendation

Policy §9 asks for per-lab source metadata. The current schema
(`lab-definition.ts`) is `.strict()` and provides:

- `references: [{ title, url }]` — min 1, max 10. Carries official documentation
  links but has **no `type` discriminator**, so "official documentation" and
  "background reading" are indistinguishable.
- `certification: [{ certification, relevant, domains[] }]` — `domains` is
  deliberately free-form, and the code comment states percentages are
  intentionally absent because objectives and weights change.
- **No** `objective` text, `objective_version`, or `last_verified` field
  anywhere.

Because the schema is strict, a lab.yaml **cannot** carry `sources:` or
`last_verified:` today; adding them is a shared platform change and is therefore
out of scope for this branch, exactly as policy §9 anticipates.

**Recommendation (deferred, for the platform owner):** a backward-compatible
extension — `references[].type` (`official_documentation` | `standard` |
`man_page`), `certification[].objective` (string),
`certification[].objective_version` (string), and a top-level `last_verified`
(date). Optional fields keep every existing lab valid. Until it lands, this
document is the system of record for source metadata, and section 4.5 is the
per-lab source list.

### 4.10 Pre-implementation checklist (policy §10)

Before **each** lab is implemented, in this order:

1. Confirm the objective in 4.2 is still listed on the current official page.
2. Re-read the official technical documentation in 4.5 for that lab.
3. Verify every command, API field and default behaviour in the lab text against
   current docs — especially anything version-sensitive (`kubectl` output shapes,
   Docker network driver behaviour, nginx directive names).
4. Confirm the sandbox capability the lab depends on actually exists.
5. Record sources and `last_verified` (here until 4.9 lands in the schema).
6. If documentation contradicts the plan, **stop** and file it in 4.4 using the
   EXISTING LAB / CURRENT BEHAVIOR / OFFICIAL DOCUMENTATION / CONFLICT /
   RECOMMENDED CORRECTION form. Do not silently preserve incorrect material.
7. Only then write `lab.yaml`.
