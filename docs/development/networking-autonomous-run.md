# Networking track — autonomous run, 2026-09-16

An unattended session continuing the Networking curriculum. Two labs shipped,
one platform disclosure hole closed, and Wave 2 stopped at a documented
capability gap rather than being guessed around.

Everything below is on a feature branch. **Nothing was merged**, and nothing was
force-pushed.

---

## 1. What shipped

| | Lab | Substrate | Branch | Commit |
|---|---|---|---|---|
| ✅ | **NET-028** VPC Architecture: Subnets, Route Tables, IGW and NAT Gateway | `terraform` (offline design) | `feat/net-028-vpc-architecture` | `a3808d3`, `47d17b8` |
| ✅ | **NET-023** Container DNS: The Name That Only Resolves on Some Networks | `docker` | `feat/net-023-container-dns` | `e94ec6a`, `639cc41` |
| ✅ | Platform fix — `workspace_file_exists` non-disclosure | — | `feat/net-023-container-dns` | `330a709` |

Both labs load through the real registry, resolve their prerequisites, grade
deterministically, and appear exactly once in the DevOps Engineer path.

### NET-028 — the VPC design review

Offline design lab on the Terraform sandbox, which is the curriculum's `tf`
substrate: the Linux sandbox plus the Terraform CLI and an offline provider
mirror, started `--network none`. It creates no AWS resources, calls no AWS API,
holds no credentials and runs no Terraform — the AWS provider is a stub on this
branch (C5/N14), so a lab that "provisioned a VPC" would provision nothing while
telling the student otherwise.

Grading is deterministic literal text, 19 checks:

- four exact `/20` allocations inside `10.30.0.0/16`, each graded as a
  `label = value` pairing so a correct CIDR on the wrong line does not pass;
- four route-table entries — both local routes and both default routes;
- five answers to the review questions, each drawn from a printed allowed-value
  list;
- two forbidding checks: the overlaps a wrong allocation actually produces, and
  the two default routes that belong to the other tier — including
  `private_default = 0.0.0.0/0 -> Internet Gateway`, the one that quietly turns
  the private tier public.

**Seeded files contain the answer vocabulary but never a graded pairing**, which
is NET-003's established pattern: there is nothing to copy and the student still
has to choose. Verified mechanically, not by inspection — see §3.

Prerequisites are `NET-002` only. The curriculum names NET-019 as well; it is not
implemented and the registry refuses a prerequisite that does not resolve, so it
joins when it lands. This is the policy NET-002 already follows for NET-001.

### NET-023 — container DNS

`ledger-worker` cannot reach `ledger-api` by name; both are running, and the
engineer who checked by hand used the IP and closed the ticket. They are on the
default bridge, where the daemon's embedded DNS does not serve container names.

The plan for this lab graded the resolver from workspace evidence and flagged
that as forgeable pending **N9** (`docker_exec_probe`). It did not need N9: the
existing `docker_container_file_content` reads `/etc/resolv.conf` out of each
container through the daemon's **archive endpoint**, so the platform observes the
embedded DNS server itself with nothing executing in the student's container.
What N9 would still add is running the *lookup* — proving resolution rather than
proving the resolver. It did not need **N8** either: `alpine:3.20` and
`nginx:1.27-alpine` are already shipped, and `nslookup` is in BusyBox.

**The behaviour the lab rests on was re-measured, not assumed** — on Docker
Engine 28.4.0, 2026-09-16:

| | `/etc/resolv.conf` | container name |
|---|---|---|
| default bridge | daemon host's nameserver | `NXDOMAIN` |
| user-defined bridge | `nameserver 127.0.0.11`, `options ndots:0` | resolves |

`docker network connect` rewrites a *running* container's `resolv.conf`, and one
name resolves per network — the same name on another network is a different
answer, and from a third network it is none.

One design change from the plan, recorded in the curriculum block:
`setup.docker.containers` has no `aliases` field, so "the same name resolves to a
different container" is not expressible in seeded state. The third container
teaches scope by *absence* instead — running, healthy, on its own network, and
its name does not resolve from the student's. Same documented lesson, and
observable.

---

## 2. Platform work

### `workspace_file_exists` was a disclosure channel — fixed

Found while writing the NET-023 leak test, not by looking for it.

The handler answered a failed check by listing the fragments it could not find:

```
'diagnosis.txt' does not mention 'port: 8080', 'resolver: 127.0.0.11'
```

A `CheckResult`'s `detail` is serialised into the API response the browser reads,
and a worksheet check's `contains` is regularly the thing the student had to work
out. **Pressing Check Solution once against a blank worksheet handed over every
answer on it** — including NET-022's, which has shipped.

This is the same channel `PLATFORM-SEC` closed for `terraform_output_equals`, and
the same rule `docker_container_file_content` already holds for a file read out
of a container. `workspace_file_exists` was the remaining hole of that shape. It
now reports *how many* of the required values are absent and never which, so a
partial answer still gets an actionable count.

No lab changed. `dockerfile_valid` was deliberately left alone: the instruction
keywords it names are stated in the task, not worked out from the system.

### Docker fake — multi-network attachment

`FakeDockerDaemon` modelled only the single `--network` a container is created
with. `docker network connect` attaches a *running* container to another network
and `docker inspect` then reports both; NET-023 is the first lab whose solved
state is exactly that. Added `attachNetwork(container, network)`, which refuses a
network that does not exist — for the same reason the daemon does.

---

## 3. Verification

### Focused suites

| Suite | Result |
|---|---|
| `services/verifier` (full) | **1599 passed**, 0 failed (71 files) on the NET-028 branch |
| `services/lab-orchestrator` (full) | **1260 passed**, 253 skipped, 0 failed (80 files) |
| `networking-labs.test.ts` | 39 passed |
| `terraform-labs.test.ts` | 77 passed |
| `lab-catalog.test.ts` | 65 passed |
| `learning-paths.test.ts` / `learning-progress.test.ts` | 25 / 19 passed |
| `docker-requirements.test.ts` | passed, +1 new non-disclosure test |
| `typecheck` — `lab-orchestrator`, `verifier` | clean |

The 253 skipped tests are the integration suites; they need `RUN_INTEGRATION_TESTS=1`
plus a kind cluster or a Docker daemon and skip themselves with a printed reason.

### New verifier suites

Both labs are graded end to end against the real handlers through the shared
fakes, not inspected by hand.

**`services/verifier/test/networking-net028.test.ts` — 25 tests.** The seeded
templates, a correct design, seven wrong designs and the hedge cases. It reads
the seeded files *from the lab's own setup directory* rather than restating them,
so a template whose labels drift from the checks fails the suite. It asserts
directly that no seeded file contains a graded pairing, and that no check leaks
one into a label or detail.

**`services/verifier/test/networking-net023.test.ts` — 15 tests.** The seeded
incident, the repair, and seven partial or forged repairs — including the one the
design exists to defeat: a worksheet claiming the embedded resolver while the
containers still hold the host's. That test is what proves the resolver is
observed rather than reported.

### Independent validation pass

A throwaway script drove the real `LabRegistry` over NET-028 and checked, beyond
what the suites cover: prerequisite resolution, that nothing in the lab executes,
that all 24 graded paths sit under `/home/student/vpc` with no shell
metacharacter and no traversal, that none of the 13 graded pairings appears in a
seeded file, that no graded value appears in the story, task, objectives, hints or
labels, and that all 9 references are HTTPS on official hosts. All passed; the
script was removed.

### Known grading boundary, stated rather than assumed

NET-028's forbidding checks name `label = wrong value`, so they catch the hedge
the file format invites — the label repeated with a second value — but **not** one
written as free prose on one line ("A or B"). The only check that would is a bare
`file_content_absent` on the wrong value alone, and every wrong value is printed
in the allowed-value list the student is handed, so that check would fail on the
seeded file before the student had touched it. Failing a correct student to catch
a hedge is the worse error, so the trade is made the way NET-003 makes it.

This is recorded in the lab header **and pinned by a test that asserts the hedge
passes**, so it cannot quietly become a surprise. Closing it needs a requirement
type that counts matches or grades a single line — proposed below as N17.

### Pre-existing failure, unrelated

`apps/api` and `services/terminal` do not build or test in this working copy:

```
Error: Cannot find package 'express-rate-limit' imported from apps/api/src/rate-limit.ts
src/rate-limit.ts(13,73): error TS2307: Cannot find module 'express-rate-limit'
```

23 of 39 `apps/api` test files fail to collect for this reason. **Confirmed
pre-existing**: reproduced with this run's changes stashed, on an otherwise clean
tree. It is a missing dependency in `node_modules`, not a code change — nothing in
this run touches `apps/api` or `services/terminal`. Not worked around, not
suppressed. A separate `npm install` fixes it.

---

## 4. Where Wave 2 stops, and why

Wave 2 is NET-006 (partial), NET-010, NET-011, NET-019, NET-021, NET-023.

- **NET-006 partial and N5 are already done** — the curriculum block records them
  as shipped on 2026-08-25. The mission's wave list was stale on this point.
- **NET-023 shipped this run.**
- **NET-010, NET-011, NET-019 and NET-021 are all blocked on N8**, and N8 is a
  bigger decision than "add an image to a list".

### The N8 gap, measured

N8 is described as **XS** — "`setup.docker.images` already exists; add the
networking tooling image to those labs". The mechanism does exist. **The image
does not.** Measured on 2026-09-16:

| | `docker:27-dind` (the sandbox) | `alpine:3.20` (the lab image) |
|---|---|---|
| `ip` | BusyBox applet — no `-d`, no `ip netns` | BusyBox applet |
| `iptables` | ✅ | ✗ |
| `nsenter`, `nslookup`, `wget` | ✅ | `nslookup`, `wget` |
| `tcpdump`, `nft`, `bridge`, `dig`, `curl`, `dnsmasq` | ✗ | ✗ |

`scripts/sandbox-build.sh` builds four sandbox images — `lab-linux`,
`lab-terraform`, `lab-ansible`, `lab-cicd`. There is no `lab-net`, and the Docker
provider uses stock `docker:27-dind`. The three images labs may use are
`alpine:3.20`, `nginx:1.27-alpine` and `busybox:1.36`; the `jumptotech/*` images
are built *by students during labs*, not shipped.

Consequences per lab:

- **NET-021** asks for `ip -d link show`, `brctl` and `ip netns` to find the host
  side of a veth pair. BusyBox `ip` has none of them. The obvious workaround —
  read the interfaces out of the container with `docker_container_file_content`
  on `/proc/net/dev` — **does not work**: the archive endpoint cannot read procfs
  (`docker cp <container>:/proc/net/dev` → "Could not find the file"). Measured.
- **NET-010** needs a DHCP server (`dnsmasq`) and `tcpdump`.
- **NET-011** needs `nft`/`iptables` *inside a student container*.
- **NET-019** needs `iptables -t nat` inside a container, and its prerequisite
  NET-011 does not exist either.

Closing N8 means either building a `jumptotech/lab-net` tooling image and
shipping it to Docker sandboxes, or adding a third-party image such as
`nicolaka/netshoot` to a pre-pull list. **Both are supply-chain and egress
decisions for the platform owner**, and the curriculum already lists egress as an
open question in Part 3. Installing packages at lab time with `apk add` is not an
alternative: it needs egress from the student's container at lab start and makes
the lab's initial state depend on a network fetch.

So Wave 2 stopped here rather than shipping a lab whose tools are not in the box.

---

## 5. Proposed capability, from this run

**N17 — a requirement type that grades one line, or counts matches.**
Small, general, and it closes a boundary two shipped labs now document. Today a
lab that grades a written answer can only ask "does this string occur anywhere in
this file", so a student who lists every allowed value on one line satisfies every
positive check. The forbidding checks catch the label-repeating form and not the
free-prose form, and no arrangement of the existing vocabulary catches both
without failing correct students. NET-003, NET-028 and any future reasoning lab
want the same thing. Sized S, in the shape of the existing `file_contains`.

---

## 6. Security

Nothing in this run touched a sandbox or private-beta security boundary. Positively:

- **One boundary was strengthened** — `workspace_file_exists` no longer discloses
  the values it grades (§2).
- Both labs execute **nothing**: no seed scripts, no `command_output`, no
  `script_runs`, no student-authored script. NET-028 has no argv anywhere for an
  operand to leak into.
- NET-028 runs `--network none` with no credentials of any kind. Every graded path
  is under `/home/student/vpc`, checked for metacharacters and traversal.
- No capability was granted. No `NET_ADMIN`, no `NET_RAW`, no privileged
  container, no Docker socket exposure, no Pod Security change.
- NET-023's container read uses the **archive endpoint** — nothing executes inside
  a student container.
- No credential, token, certificate, `.env` or kubeconfig was created, committed
  or printed.

**One action was blocked and not worked around.** Starting a throwaway
`docker:27-dind` container with `--privileged`, to measure DinD behaviour, was
denied by the sandbox policy. Correct call — `--privileged` is exactly what that
policy is for. The measurements were taken instead with ordinary unprivileged
containers on the host daemon, which answered every question that mattered. The
one thing this leaves unverified is whether Docker 27 inside DinD behaves
identically to the Docker 28.4.0 measured here; the two differ by a major
version, and the NET-023 header records the version the measurements came from.

**Temporary state was cleaned up.** Eight probe containers and two probe networks
were created during measurement and removed; `docker ps -a` and `docker network
ls` were checked and are clear. The validation script was deleted. No namespaces,
no generated secrets, no stray files.

---

## 7. Unresolved questions for the platform owner

1. **N8 — which networking tooling image, and where from?** Build
   `jumptotech/lab-net` or pre-pull a third-party one? This is the single gate on
   four Wave-2 labs (§4).
2. **N17 — is a line-scoped or match-counting requirement type wanted?** (§5)
3. **`setup.docker` has no `aliases` field.** Adding one would let a lab seed "the
   same name resolves to a different container" directly. It crosses the broker
   protocol, so it is not the XS change it looks like. NET-023 works without it.
4. **NET-019 as a prerequisite of NET-028.** The curriculum names it; it is not
   implemented. When it lands, NET-028's `prerequisites` should gain it.

---

## 8. Exact next recommended task

**Decide N8 (§4, question 1).** Nothing else in Wave 2 can proceed honestly until
it is settled, and once it is, NET-021 → NET-010 → NET-011 → NET-019 is the
dependency order — NET-021 first because it is NET-022's missing prerequisite, and
NET-022 has already shipped with an empty `prerequisites` list because of it.

If N8 is not going to be decided soon, the next unblocked work is **NET-029**
(Security Groups vs NACLs). Its design half is deterministic answers on the
existing sandbox, the same form NET-028 just proved out, and its prerequisites are
NET-028 (now implemented) and NET-011 (not). Its part two needs `nft` and is
therefore N8-blocked as well, so it would ship as the design half only — which is
a content decision, not a platform one.

---

## 9. Branches and pushes

All three branches are pushed. **No PR was opened and nothing was merged** — the
GitHub CLI returned a `pull/new/...` URL for each, which is the create-a-PR link,
not a PR.

| Branch | Base | Commits | Pushed |
|---|---|---|---|
| `feat/net-028-vpc-architecture` | `main` @ `cb7804a` | `a3808d3`, `47d17b8` | yes |
| `feat/net-023-container-dns` | `main` @ `cb7804a` | `330a709`, `e94ec6a`, `639cc41` | yes |
| `docs/networking-autonomous-run` | `main` @ `cb7804a` | this document | yes |

The two lab branches are **independent** — NET-023 does not build on NET-028, so
it was branched from `main` and the branches can be reviewed and merged in either
order. Each touches `labs/learning-paths/devops-engineer.yaml` in a different
stage and `labs/networking/CURRICULUM.md` in a different block.

### Files changed

**`feat/net-028-vpc-architecture`**

```
labs/networking/net-028-vpc-architecture/lab.yaml            new
labs/networking/net-028-vpc-architecture/setup/requirements.txt  new
labs/networking/net-028-vpc-architecture/setup/design.txt        new
labs/networking/net-028-vpc-architecture/setup/routes.txt        new
labs/networking/net-028-vpc-architecture/setup/answers.txt       new
services/verifier/test/networking-net028.test.ts             new
labs/learning-paths/devops-engineer.yaml                     +3
labs/networking/CURRICULUM.md                                +26
```

The four `setup/*.txt` files were seeded before this run and were kept and
completed, not discarded. They were edited for one concrete reason: the labels
repeated across sections (`public = `, `local = ` under two different headings),
so a correct value written under the wrong heading would have graded as correct.
Every answer line now carries a unique label.

**`feat/net-023-container-dns`**

```
services/verifier/src/handlers/docker-workspace.ts           ~27
services/verifier/test/docker-requirements.test.ts           +40
labs/networking/net-023-container-dns/lab.yaml               new
services/verifier/test/networking-net023.test.ts             new
services/lab-orchestrator/test/docker-fakes.ts               ~20
labs/learning-paths/devops-engineer.yaml                     +3
labs/networking/CURRICULUM.md                                +28
```

`git diff --check` is clean on both. The trailing spaces `git diff --check`
reports on NET-028's `setup/*.txt` templates are **intentional and load-bearing**:
every answer line ends `= ` so the student types the value after the space, which
is the format the task text states and the format the checks match. NET-002's own
templates were committed with 29 identical warnings.
