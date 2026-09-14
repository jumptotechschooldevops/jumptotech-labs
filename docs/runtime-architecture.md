# The runtime architecture

**Why 81 of 114 labs could not run in the shipped stack, and what now runs them.**

---

## 1. The gap

The catalogue is 114 labs across nine tracks. Every one of them was implemented,
tested and reachable from the API. Thirty-three could actually be started from a
deployed stack. The other 81 were switched off in `docker-compose.yml`, with a
comment explaining that they had to be.

The counts line up exactly, which is the first clue that this was one problem
rather than several:

| Provider | Tracks it backs | Labs | Deployable before |
|---|---|---:|:--|
| `kubernetes` | Kubernetes | 19 | yes |
| `docker` | Docker | 14 | yes, but only with the host socket in the API |
| `linux` | Linux (17), CS (13), AWS (11), Networking (7) | 48 | **no** |
| `terraform` | Terraform | 13 | **no** |
| `ansible` | Ansible | 10 | **no** |
| `cicd` | CI/CD | 10 | **no** |
| | | **114** | **33** |

48 + 13 + 10 + 10 = 81. Every non-deployable lab was on a **container-backed
provider**, and every container-backed provider was off for the same single
reason.

## 2. The root cause

A container-backed lab needs a container runtime **twice**:

```text
  1. create the sandbox      docker run  --network none --cap-drop ALL …
  2. attach a shell to it    docker exec -it <sandbox> bash
```

Step 1 was fine: the API had the host Docker socket. Step 2 was not, and could
not be made fine, because of *where* it ran. `containerSpawnPlan` builds a
`docker exec` argv and `services/terminal` spawns it — so attaching a shell
required giving a container runtime to **the one process a student types into**.

The deployment refused to do that, correctly. The consequence was recorded in
the compose file itself:

```text
  TERMINAL_CONTAINER_EXEC_ENABLED=false → "CONTAINER_EXEC_DISABLED"
  TERMINAL_CONTAINER_EXEC_ENABLED=true  → "Cannot connect to the Docker daemon
                                           at /var/run/docker.sock"
```

Neither value works, so the four providers were pinned off — because a provider
that is *available* advertises its labs in the catalogue, and a student who
clicked one got a sandbox and then a dead terminal. Turning them on without
fixing the shell would have been worse than leaving them off.

There was a second problem sitting underneath it. The socket the API held is
root-equivalent on the host, and the API is the service behind `/api` — it is
reachable from a browser through the web proxy. The compose file said as much:
*"acceptable for a local development stack"*. So even the 33 labs that did work
worked on an arrangement that was documented as not being a deployment.

Both problems are the same question — **which process holds a container
runtime** — and they have the same answer.

## 3. What was built

`services/sandboxd`: a runtime broker. It is the only process in the deployment
with a container runtime, and neither of the two services a browser can reach
has one at all.

```text
                    ┌──────────── web (nginx) :3000 ────────────┐
   browser ─────────┤  /api → api   /auth → api   /terminal → terminal
                    └───────────────────────────────────────────┘
                            │                        │
                            ▼                        ▼
                    ┌───────────────┐        ┌───────────────┐
                    │      api      │        │   terminal    │
                    │ no runtime    │        │ no runtime    │
                    │ no socket     │        │ no socket     │
                    └───────┬───────┘        └───────┬───────┘
                            │                        │
              POST /v1/runtime          ws /v1/attach
              (runtime/docker scope)    (attach scope)
              https across hosts — §8   wss across hosts — §8
                            │                        │
                            └───────────┬────────────┘
                                        ▼
                              ┌───────────────────┐
                              │     sandboxd      │  ← the only socket
                              │  11 verbs + 1 PTY │
                              └─────────┬─────────┘
                                        ▼
                          jtt-lab-<hex>  one container, one session
```

### 3.1 The attach path

This is the part that unblocks the 81 labs.

```text
  terminal ──{ sessionId }──► sandboxd
                                 │ 1. shape-check the session id
                                 │ 2. DERIVE the container name (HMAC)
                                 │ 3. inspect it
                                 │ 4. require managed=true
                                 │            runtime-owner = mine
                                 │            session-id    = the one asked for
                                 │            state         = running
                                 ▼
                           docker exec -it <derived> $SHELL
```

Note what is **not** in the request: no container name, no image, no user, no
working directory, no command, no path, no namespace. The caller sends a session
id and a terminal size. The container name is *computed* from the session id and
this service's own copy of `NAMESPACE_DERIVATION_SECRET` — so a caller cannot
name a container even if it wanted to.

Step 4 is not redundant with step 2. Deriving the name proves the caller knew a
session id; the labels prove the container on the daemon right now genuinely
belongs to that session and to this deployment. A container someone else created
under a colliding name carries neither label and is refused — the same rule the
reaper applies before it removes anything.

The user and working directory come from the container's own configuration, read
back through `docker inspect`. There is no argv position a caller can reach.

### 3.2 The control path

Two of them, because the platform has two container abstractions.

`POST /v1/runtime` exposes `ContainerRuntimePort` — the eleven-verb interface
the container-backed providers already spoke — and nothing else. It is not a
Docker proxy:

- **A closed operation list.** Dispatched by a `switch`. No passthrough, no raw
  argv, no image build, no bind-mount parameter, and no way to express one.
- **The same validation, on the privileged side.** Every call runs through the
  `DockerCliRuntime` inside the broker, so the name patterns, the image pattern,
  the capability allow-list and the env-name pattern execute in the process that
  actually holds the runtime — not only in a caller that could be wrong.
- **Ownership enforced, not trusted.** Nothing is created without this broker's
  own runtime-owner label; nothing is inspected, exec'd into or removed unless
  the live object already carries it; and `list` is filtered before it returns,
  so a reaper driving this service cannot even *see* another deployment's
  sandboxes.

### 3.3 The Docker control path

`POST /v1/docker` is the same idea for the one track that speaks
`DockerEnginePort` instead. That interface has 23 methods; this is **not** a
proxy for them. It is a closed list of named operations, split by where the
privilege lives:

| Scope | What it reaches | Shape |
|---|---|---|
| host | the machine's own daemon | parameterless, or a session id and nothing else |
| session | the daemon *inside* one student's sandbox | a session id, plus typed arguments |

The host scope is narrow because it creates `--privileged` containers. Its most
important property is that **`createSandbox` does not take a spec**: it takes a
session id, a lab id and an expiry, and `sandboxd` supplies the image, the
privilege flag, the memory, the CPU, the pids limit, the network and the volume
from its own `DOCKER_SANDBOX_*` configuration. There is no argument a
compromised API could set to run a different image, add a mount, or ask for
privilege on something that is not a sandbox.

The session scope is wider — it can run, stop, remove, pull and list — because
the platform genuinely writes there: seeding a lab's declared starting state is
how DOCKER-010, DOCKER-011 and DOCKER-012 hand a student pre-broken containers
to diagnose, and `reset` is how they get a clean one back. That costs nothing:
the daemon lives inside the student's own sandbox and they already hold a client
certificate and a shell for it. The security property is not "the platform only
reads" — it never did — it is that **every operation is routed through a sandbox
derived from a session id**.

Two things are absent even there: `execInContainer`, because nothing needs it
and it is the one shape that is arbitrary execution; and `privileged`, which
`sessionRunContainer` forces off whatever it is sent.

Two host operations look like exec and are not. `readCertificate` takes a
session id and one of **three** file names and builds `cat /certs/client/<f>`
itself; `sandboxCliVersion` takes a session id and builds
`docker version --format {{.Client.Version}}`. No argv crosses the wire, and the
client refuses any other shape rather than forwarding it.

### 3.4 Not browser-reachable

Three independent things, because one is a configuration mistake away from being
none:

1. the internal service secret is required on both endpoints;
2. **any request carrying an `Origin` header is refused** — every browser
   WebSocket and `fetch` sends one and no server-side client does, so a page
   cannot reach this service even if the secret leaked into one;
3. no `ports:` stanza and no route in the web proxy.

## 4. The seam this reuses

None of this is a new abstraction. `ContainerRuntimePort` was written as a seam
so provider logic could be exercised against a fake while production talked to a
daemon. A second real implementation is exactly what it was shaped for:

```text
  LinuxLabProvider ─► ContainerRuntimePort ─┬─► DockerCliRuntime    (a laptop)
                                            └─► BrokerRuntime ───► sandboxd

  DockerLabProvider ─► DockerEngineFactory ─┬─► DockerCliFactory    (a laptop)
                                            └─► BrokerDockerEngines ─► sandboxd
```

So one broker serves **every track**, with no per-track infrastructure, because
each family already had exactly one seam. Choosing between the implementations
is two functions — `buildContainerRuntime` and `buildDockerEngines` — each
called once.

The nine `DockerEnginePort` methods nothing calls are still implemented on the
brokered factory, and every one of them **rejects**. That is deliberate:
`pullImage`, `listImages`, `removeNetwork` and the rest are not reachable from
the API in a brokered deployment, and a future caller that starts using one gets
a loud failure rather than a quiet widening of the broker's surface.

## 5. Deployment shapes

Each privilege is opted into by naming a file, so the cost is visible in the
command rather than buried in a default.

| Command | What runs | Where the socket is |
|---|---|---|
| `make up-kubernetes-only` | Kubernetes. 19 labs. | nowhere |
| `make up` | every track. **114 labs.** | `sandboxd` only |

Both publish every port on `127.0.0.1` only. Adding
`-f docker-compose.production.yml` to either changes exposure and nothing else:
HTTPS on 443, a redirect on 80, no other published port (§11). The track and
lab count do not change.

There is no third arrangement any more. The Docker track used to need one — an
overlay that put the host socket back into the browser-reachable `api` service —
because its `DockerEnginePort` was not brokered. It is now, so that overlay is
gone rather than merely discouraged.

## 6. What turning the providers on uncovered

Four defects, all of them invisible while the providers were switched off,
because nothing in a deployed stack could reach the code paths that held them.
They are recorded here because "the track was disabled" is why they survived,
and re-disabling anything would hide them again.

| Defect | Symptom | Fix |
|---|---|---|
| `wireShell` called itself | infinite recursion; the terminal service would blow its stack on any container-track **Reset Lab** | it now wires output and exit, which is what its own comment said it did |
| the broker attached as `Config.User` | **every Linux, CS, Networking and AWS student got a root shell**, silently — the container's init user is deliberately `root` because it runs a service supervisor | the shell user comes from `SANDBOX_USER`, and `assertShellUser` refuses `root` outright |
| `ssh --version` | the Ansible provider refused **every** session: OpenSSH has no long options, so the tooling probe exited non-zero against an `ssh` that works | a per-binary version flag table; `ssh -V`, read from stderr |
| the Ansible session keypair was never generated | managed nodes exited 1 on start (`JTT_AUTHORIZED_KEY is required`); the topology reported itself created with no machines in it | `generateSessionKeyPair` is called, the public half goes to the nodes, the private half is streamed into the control node, and provisioning now waits until the nodes actually answer SSH |

Brokering the Docker track turned up three more of the same kind:

| Defect | Symptom | Fix |
|---|---|---|
| the sandbox's named data volume was never removed | `docker rm -v` removes a container's *anonymous* volumes; `/var/lib/docker` is a named one, so **every ended Docker session left a whole daemon's image store on disk** | `removeSandbox` removes the volume too, derived from the same session |
| `DockerFileRead.content` is a `Buffer` | `JSON.stringify` turns it into `{type:'Buffer',data:[…]}`, so the verifier's binary check `content.includes(0)` threw and DOCKER-011 failed grading with an internal error | bytes travel base64-encoded and are rebuilt into a `Buffer` on arrival |
| the component label was written twice | `docker-provider.ts` says `docker-sandbox`; a second copy in the broker said `sandbox`, so a destroy that should have succeeded was refused as somebody else's container | one exported constant, imported by both |

Two smaller ones fell out of the earlier Ansible work: an Ansible session's private bridge was
gated on the *lab* declaring `network: link`, which no Ansible lab does and none
should have to — the topology needs it, so `requiresLabNetwork` is a provider
property now; and the SSH identity was written under the provider's `homeDir`
(`/home/student/lab`) rather than the account's home, so `ssh` never found it
and fell back to port 22.

## 7. Honest limitations

- **A container is not a VM.** Everything shares one kernel; a kernel or runtime
  escape crosses every boundary here. This is single-tenant-teaching isolation,
  not hostile multi-tenancy.
- **On one host, `sandboxd` and the web tier share that kernel.** What the
  broker buys on a single-host compose stack is a much smaller and much
  better-audited attack surface, not a hard partition. A real deployment puts
  `sandboxd` on a runtime node that is not the machine serving the web tier.
  That takes more than a new `SANDBOX_BROKER_URL`: the URL must be `https://`
  and sandboxd must hold a certificate, and production refuses to start
  otherwise. See §8.
- **`sandboxd` holds real privilege over its runtime.** That is the point: the
  privilege is concentrated in one internal service with two endpoints and no
  student input path, instead of spread across the services a browser can reach.
- **`--privileged` is still `--privileged`.** A Docker lab's sandbox has to run
  privileged for the inner daemon to create cgroups and program iptables. A
  student who breaks *out* of a container inside their own sandbox reaches that
  sandbox's privileged context and from there the host kernel. Brokering changes
  who can *create* such a container — only `sandboxd`, only from a session id —
  not what one is.

## 8. The application tier and the runtime tier (BETA-P0-011)

### 8.1 The request path before this change

Audited from the code and compose files on `main` at `07c21e6`:

| Hop | Transport | Credential on the wire |
|---|---|---|
| browser → web (nginx) `:3000` | whatever fronts it (a tunnel, a TLS terminator) | browser session cookie |
| web → api `:4000` (`/api`, `/auth`), web → terminal `:4001` (`/terminal`) | `http://`, `ws://` on the compose bridge | cookie, terminal token |
| terminal → api `:4000/internal`, api → terminal `:4001/internal` | `http://` on the compose bridge | `INTERNAL_SERVICE_SECRET` |
| api → sandboxd `:4002/v1/runtime`, `/v1/docker` | `http://sandboxd:4002` | `SANDBOXD_RUNTIME_SECRET`, `SANDBOXD_DOCKER_SECRET` in `x-internal-secret` |
| terminal → sandboxd `:4002/v1/attach` | `ws://sandboxd:4002` | `SANDBOXD_ATTACH_SECRET` in `x-internal-secret` |
| Docker health check → sandboxd `:4002/health` | `http://127.0.0.1` inside the container | none; shell count and two booleans |
| Prometheus → `:9400` / `:9401` / `:9402` `/metrics` | `http://` on the compose bridge | `OBSERVABILITY_SCRAPE_TOKEN` as a bearer token |

Every hop was plaintext, which was acceptable only because every hop stayed on
one host's Docker bridge. Nothing enforced that. Pointing `SANDBOX_BROKER_URL`
at `http://runtime-host:4002` was accepted silently and would have put all three
capability secrets on the network in cleartext.

### 8.2 The arrangement this supports

```text
  APPLICATION TIER                                   RUNTIME TIER
  ┌──────────────────────────────────┐              ┌───────────────────────────────┐
  │ web (nginx) :3000   public entry │              │ sandboxd :4002  capabilities  │
  │ api       :4000   127.0.0.1 only │  https /     │          :9402  metrics       │
  │ terminal  :4001   127.0.0.1 only ├──wss, TLS ──►│ Docker socket  (sandboxd only)│
  │ postgres                         │  verified    │ sandbox containers            │
  │ metrics :9400 :9401  (bearer)    │  x-internal- │                               │
  └──────────────────────────────────┘  secret      └───────────────────────────────┘
```

sandboxd is the only component that controls the container runtime, on either
arrangement. The capability model is unchanged: TLS protects the secrets in
transit, and the scope secrets still authorize each endpoint.

**Decision: native TLS in sandboxd, not a TLS proxy.** It is the smaller of the
two. There is no second process to deploy, monitor and keep in step, and one
listener serves `/health`, both control planes and the attach upgrade. The
certificate and key are loaded, and checked to match, before the process
starts. A proxy remains possible: bind sandboxd to loopback and put the proxy in
front of it.

### 8.3 Production rules (`NODE_ENV=production`)

Callers are the api when `SANDBOX_BROKER_URL` is set, and the terminal when
`TERMINAL_SANDBOX_BROKER_ENABLED=true`. Each refuses to start unless its broker
URL is one of these:

| URL | Accepted as | Why |
|---|---|---|
| `https://<host>:<port>` | `tls` | certificate chain and hostname verified, TLS ≥ 1.2 |
| `http://127.x.x.x:<port>`, `http://[::1]:<port>` | `loopback-plaintext` | never leaves the network namespace; also how a local TLS proxy is fronted |
| `http://<one-label-name>:<port>` **and** `SANDBOX_BROKER_SAME_HOST_PLAINTEXT=true` | `same-host-plaintext` | the compose runtime overlay: one host, one private bridge |
| anything else, e.g. `http://sandboxd.runtime.example:4002`, `http://10.0.0.5:4002`, or an undeclared `http://sandboxd:4002` / `http://localhost:4002` | **refused** | a name is never trusted to be local |

sandboxd refuses to start unless it holds `SANDBOXD_TLS_CERT_FILE` and
`SANDBOXD_TLS_KEY_FILE`, binds a loopback address, or carries the same
declaration.

Always refused, in production:

- `SANDBOX_BROKER_SAME_HOST_PLAINTEXT=true` beside `https://` or a certificate,
  or with any value other than `true`;
- `NODE_TLS_REJECT_UNAUTHORIZED` set to anything but `1`, in the api, the
  terminal and sandboxd, with or without a broker.

The declaration is an operator's statement about the host, not something the
code can observe. The single-label check only stops it from covering an FQDN or
an IP. It is set in `docker-compose.runtime.yml` and nowhere else, and a test
fails if it appears in another compose file.

Refused in every environment:

- a broker URL carrying userinfo, a query, a fragment or a path, or a scheme
  other than `http`/`https`. Refusals never repeat the URL's credentials;
- `SANDBOX_BROKER_CA_FILE` beside an `http://` URL (TLS was intended);
- a CA bundle that cannot be read, contains no certificate, fails to parse, or
  contains a private key;
- only one of `SANDBOXD_TLS_CERT_FILE` and `SANDBOXD_TLS_KEY_FILE`, or a pair
  that does not match.

The gates run in a fixed order: the P0-008 owner gate first, then the P0-010
secret gate, then this one. A missing owner or secret is still reported as
such.

### 8.4 Local development only

Outside `NODE_ENV=production`, plaintext to any host is accepted and reported as
`development-plaintext`. `npm run dev:*` against `http://127.0.0.1:4002` works
as before. The terminal still defaults to that URL when `SANDBOX_BROKER_URL` is
empty. The compose runtime overlay runs its services with
`NODE_ENV=production`, so it relies on the declaration rather than on this
exception.

Nothing, in any environment, disables certificate verification. The clients pass
`rejectUnauthorized: true` on every TLS connection, so even a stray
`NODE_TLS_REJECT_UNAUTHORIZED=0` in development does not weaken the broker path.

### 8.5 Certificate and CA requirements

- **sandboxd's certificate** must name, in its subjectAltName, exactly the DNS
  name or IP address the api and terminal dial. Its key is a file readable only
  by the sandboxd process (the image runs as `node`), mounted read-only, never
  baked into an image and never committed.
- **`SANDBOX_BROKER_CA_FILE`** on the api and the terminal holds public
  certificates only. It is trusted for broker connections and nothing else: it
  is not added to the process-wide store, so it cannot vouch for the identity
  provider or any other host. Unset, the system trust store is used.
- **Rotation.** All three files are read once at startup, so a new certificate
  takes a sandboxd restart and a new CA takes an api and terminal restart. To
  rotate a CA, first ship a bundle containing both the old and new CA
  certificates.
- **Health check.** With TLS on, the image health check tests that the listener
  accepts a TCP connection. It does not perform a handshake, so it never needs to
  skip verification.

### 8.6 Ports

| Port | Service | Contract |
|---|---|---|
| 4002 | sandboxd capabilities | never published by any compose file; on a runtime host, reachable from the application tier only |
| 9402 | sandboxd metrics | published on 127.0.0.1 only; bearer token; plaintext HTTP |
| 4000, 4001 | api, terminal | 127.0.0.1 only |
| 9400, 9401 | api, terminal metrics | 127.0.0.1 only; bearer token |

BETA-P0-012 widened this to every port in every stack, and added the production
stack, which publishes none of the ports above. See §11.

These rules live in `publishedPorts` in `infrastructure/secret-distribution.json`,
next to the rule that only sandboxd may mount the Docker socket. They are
enforced by `compose-secret-distribution.test.ts` (`npm test`) and
`scripts/check-secret-distribution.mjs` (`make secrets-check`, CI `gates`).

### 8.7 DECISION REQUIRED

This story makes a split deployment safe to configure. It does not deploy one.
No runtime host, certificate, CA or private network exists yet, and the shipped
compose stack is still single-host with declared plaintext.

- **DECISION REQUIRED: certificate issuance.** Who operates the CA, how the key
  reaches the runtime host, how rotation happens, and what alerts before a
  certificate expires. Nothing monitors expiry today.
- **DECISION REQUIRED: network placement.** The private network between the
  tiers, and the firewall rule that limits 4002 to the application tier's
  addresses. TLS protects the secrets; it does not stop the capability port from
  being reachable.
- **DECISION REQUIRED: metrics across tiers.** `:9402` serves plaintext HTTP
  with a bearer token. Scraping it from another host needs Prometheus on the
  runtime tier, a TLS proxy in front of it, or TLS on the observability
  listener. Until then it must be scraped from the runtime host only.
- **DECISION REQUIRED: mutual TLS.** Client certificates would add a second
  factor alongside the capability secrets. Not required for the private beta and
  not implemented.
- **DECISION REQUIRED: the Docker track across hosts.** The terminal joins the
  `sandboxes` network to reach each session's own daemon at
  `tcp://lab-<hash>:2376` (mutual TLS). On a separate runtime host that network
  is not reachable from the application tier, so Docker-track shells need a
  routing decision before that track can run split.
- **DECISION REQUIRED: the Kubernetes track across hosts.** The api and the
  terminal reach the cluster API server on the local `kind` network.
- **Same-tier assumption.** The api ⇄ terminal `/internal` calls stay plaintext.
  Both services must remain on one application host or private bridge.

## 9. Configuration

| Variable | Service | Meaning |
|---|---|---|
| `SANDBOX_BROKER_URL` | api, terminal | The broker's base URL: an origin only, `https://` across hosts (§8). Empty ⇒ the api drives a local daemon; the terminal uses `http://127.0.0.1:4002`. |
| `SANDBOX_BROKER_CA_FILE` | api, terminal | PEM CA bundle trusted for broker connections only. Refused beside `http://` or when it contains a private key. |
| `SANDBOX_BROKER_SAME_HOST_PLAINTEXT` | api, terminal, sandboxd | `true` declares the single-host arrangement that production plaintext to a service name or a non-loopback bind requires. Set in `docker-compose.runtime.yml` only. |
| `SANDBOXD_TLS_CERT_FILE` / `SANDBOXD_TLS_KEY_FILE` | sandboxd | Serve every endpoint on the port over TLS (≥ 1.2). Both or neither; checked to match at startup. |
| `TERMINAL_SANDBOX_BROKER_ENABLED` | terminal | Attach shells through the broker rather than locally. |
| `TERMINAL_CONTAINER_EXEC_ENABLED` | terminal | The local `docker exec` path. Must be `false` in any deployment. |
| `NAMESPACE_DERIVATION_SECRET` | api, sandboxd | **Must be identical.** Sandbox references are HMACs of the session id. A mismatch fails closed. |
| `INTERNAL_SERVICE_SECRET` | api, terminal | API ⇄ terminal calls only. sandboxd never receives it: each broker endpoint takes its own `SANDBOXD_*_SECRET`. Must differ from `TERMINAL_SESSION_SECRET` in production. See [secret-boundaries.md](secret-boundaries.md). |
| `SANDBOXD_ATTACH_SECRET` / `_RUNTIME_SECRET` / `_DOCKER_SECRET` | terminal / api / api — and sandboxd | One capability each. The api is refused `attach`; the terminal is refused the other two. |
| `RUNTIME_OWNER_ID` | api, sandboxd | **Must be identical.** The deployment's one runtime owner: stamped on every namespace and sandbox, required on everything cleanup touches. Required under `NODE_ENV=production`; a mismatch leaks brokered sandboxes. See [runtime-ownership.md](runtime-ownership.md). |
| `SANDBOX_RUNTIME_HOST` | api | A dedicated runtime node over TLS, when there is no broker. The broker wins if both are set. |
| `DATABASE_SSL` | api, `db:migrate` | `true` = verified TLS to PostgreSQL (chain + host name, TLS ≥ 1.2). Strictly `true`/`false`. There is no unverified mode (§11.5). |
| `DATABASE_SSL_CA_FILE` | api, `db:migrate` | PEM CA bundle trusted for the database connection only. Refused without `DATABASE_SSL=true` or when it holds a private key. |
| `DATABASE_SAME_HOST_PLAINTEXT` | api | `true` declares the one-host private bridge that production plaintext to a service name requires. Pinned in `docker-compose.yml` for the api only. |

## 10. What proves it

| Suite | Runs against | Proves |
|---|---|---|
| `services/sandboxd/test/attach.test.ts` | fakes | every way an attach can be refused |
| `services/sandboxd/test/runtime-routes.test.ts` | fakes | the closed verb list, and that nothing foreign can be touched |
| `services/sandboxd/test/server.test.ts` | real WebSockets | the front door, the wire, one-shell-per-session |
| `services/sandboxd/test/broker-runtime.test.ts` | real HTTP | the client and the server agree |
| `services/terminal/test/broker-attach.test.ts` | real WebSockets | browser → terminal → broker, and cross-user refusal, with no runtime in the terminal |
| `services/sandboxd/test/sandboxd-integration.test.ts` | **real Docker, real PTYs** | a real shell in a real sandbox; two sessions cannot see each other's files; a foreign container survives a removal attempt |
| `services/sandboxd/test/docker-ops.test.ts` | fakes | the Docker gate: the closed operation list, the spec built from configuration, the session-label loop-closer, and the file-read wire encoding |
| `services/sandboxd/test/broker-docker.test.ts` | real HTTP | the brokered `DockerEngineFactory`: it cannot name a container, cannot express an un-brokered operation, and fails closed when the broker is down |
| `services/lab-orchestrator/test/docker-integration.test.ts` | **a real Docker daemon** | the Docker provider end to end — build, Compose, grade, reset, destroy — 31 tests |
| `services/lab-orchestrator/test/broker-transport.test.ts` | real TLS handshakes, an in-memory CA | the §8 rules; no credential in a URL or a refusal; no verification bypass on the path; an untrusted CA or wrong host is refused before a request byte is sent |
| `services/sandboxd/test/transport.test.ts` | a real TLS listener | `loadSandboxdConfig` rules and gate order; the runtime plane, `/health` and the attach upgrade over TLS; no plaintext on the port; the image health check |
| `services/terminal/test/broker-transport.test.ts` | real `wss` to a real sandboxd | terminal rules; `brokerShell` attaches only to a broker whose certificate it trusts |
| `apps/api/test/runtime-transport.test.ts` | a real TLS broker | api rules and gate order; both broker clients carry the validated CA; the compose declaration; no web-proxy route, browser reference or API route to the broker |
| `services/observability/test/compose-secret-distribution.test.ts`, `scripts/check-secret-distribution.mjs` | compose text; `docker compose config` | 4002 never published; 4000, 4001, 9400–9402 on loopback only; the Docker socket mounted into sandboxd only. Since BETA-P0-012 also the §11 port and network policy |

The last one needs both a container runtime and a working `node-pty`, and macOS
hosts do not have the second. `make test-sandboxd-container` runs it inside the
test image, which does.


## 11. Network exposure and PostgreSQL (BETA-P0-012)

This section is the port policy. Like §8, it makes a deployment *safe to
configure* and deploys nothing: no firewall, security group, private subnet,
certificate or DNS record exists because of it, and none is assumed.

### 11.1 Before

Resolved with `docker compose config` on `main` at `488048b`:

| Container port | base | runtime | observability | Reachable from, inside compose |
|---|---|---|---|---|
| postgres 5432 | **0.0.0.0:5432** | **0.0.0.0:5432** | **0.0.0.0:5432** | `default` network: api, **terminal, web** |
| web 3000 | **0.0.0.0:3000** | **0.0.0.0:3000** | **0.0.0.0:3000** | `default` |
| api 4000 | 127.0.0.1 | 127.0.0.1 | 127.0.0.1 | `default`, `kind` |
| terminal 4001 | 127.0.0.1 | 127.0.0.1 | 127.0.0.1 | `default`, `kind`, `sandboxes` |
| sandboxd 4002 | — | not published | not published | `default` |
| 9400 / 9401 / 9402 | — | — | 127.0.0.1 | `default` |
| prometheus 9090, alertmanager 9093, grafana 3001→3000 | — | — | 127.0.0.1 | `default` |

There was no production arrangement: the only way to serve students was to put
something in front of `0.0.0.0:3000`. PostgreSQL was published on every host
interface, and it shared the `default` network with the terminal container, where
student shells run. The shells had no password, but they did have a route.

The pool was built with `ssl: { rejectUnauthorized: false }` whenever
`DATABASE_SSL` was truthy. That encrypted the password to whoever answered, and
any unrecognised `DATABASE_SSL` value, such as `verify`, meant plaintext.

### 11.2 The boundary

```text
            Internet
               │
      443 ─────┼───── 80 (redirect only)
               ▼
  ┌──────────────────────── one host ─────────────────────────┐
  │ web (nginx)  :8443 TLS · :8080 → https                    │
  │   │ default network                                       │
  │   ├─► api       :4000 ──── database network (internal) ──► postgres :5432
  │   └─► terminal  :4001                                     │
  │         api, terminal ──► sandboxd :4002  (§8, declared bridge)
  │ metrics :9400 :9401 :9402 — compose network only          │
  └───────────────────────────────────────────────────────────┘
```

| | Ports | Rule |
|---|---|---|
| **Public** | 443 | HTTPS, terminated by nginx (`infrastructure/docker/nginx/web-tls.conf`) on container port 8443. |
| **Conditionally public** | 80 | Container port 8080. A `301` to `https://` and nothing else: no `proxy_pass`, no files. |
| **Never public** | 3000, 4000, 4001, 4002, 5432, 9400, 9401, 9402 | Not published by the production stack on any interface, loopback included. Reached across compose networks by the services that need them. |

The contract counts `ports:` only. `EXPOSE` in a Dockerfile and `expose:` in
compose are metadata and publish nothing. The web image declares
`EXPOSE 3000 8080 8443`, and none of those ports is public by that fact.

### 11.3 After

| Container port | base / runtime / observability (development) | production (`base + runtime + production`) |
|---|---|---|
| web 8443 | — | **0.0.0.0:443** |
| web 8080 | — | **0.0.0.0:80** (redirect) |
| web 3000 | 127.0.0.1:3000 | not published |
| postgres 5432 | 127.0.0.1:5432 | not published; `database` network is `internal` |
| api 4000 / terminal 4001 | 127.0.0.1 | not published |
| sandboxd 4002 | not published | not published |
| 9400 / 9401 / 9402 | 127.0.0.1 (observability only) | not published |
| 9090 / 9093 / grafana 3001→3000 | 127.0.0.1 (observability only) | not part of the production contract (§11.7) |

`infrastructure/secret-distribution.json` holds the policy:

- `publishedPorts.loopbackOnly` lists every container port a development stack
  may publish. Each one must bind `127.0.0.1`, and an unlisted port fails.
- `publishedPorts.production` is the exact list for a stack marked
  `exposure: production`. `443:3000`, which would serve plaintext on the HTTPS
  port, fails.
- `privateNetworks.database` fixes the members as exactly `api` and `postgres`,
  and requires the network to be `internal` in production.

### 11.4 PostgreSQL connectivity

- PostgreSQL joins only the `database` network. The api is the only other member,
  and reaches it as `postgres:5432`. The web and terminal containers, and so
  student shells, have no route to it.
- In development the network is an ordinary bridge. That is what lets the
  loopback port work for `make db-migrate`, `make db-status` and host-run
  services. `make db-shell` uses `docker compose exec` and needs no port.
- In production the port is removed and the network is `internal: true`, so the
  database container has no route off the host at all.
- `make test-db`'s throwaway database binds `127.0.0.1` as well.

### 11.5 PostgreSQL TLS

`services/progress/src/postgres/tls.ts`, used by the pool, the api and `db:migrate`:

| Configuration | Accepted as | Production |
|---|---|---|
| `DATABASE_SSL=true` (+ optional `DATABASE_SSL_CA_FILE`) | `tls` — chain and host name verified, TLS ≥ 1.2 | ✓ any host |
| Unix socket (`POSTGRES_HOST=/run/postgresql`, `?host=/…`) | `local-socket` | ✓ |
| `127.x.x.x`, `[::1]` | `loopback-plaintext` | ✓ |
| single-label host + `DATABASE_SAME_HOST_PLAINTEXT=true` | `same-host-plaintext` | ✓ — `docker-compose.yml` |
| anything else in plaintext: `db.internal`, `10.0.0.5`, undeclared `postgres` or `localhost` | refused | ✗ |
| any plaintext | `development-plaintext` | outside production only |

Always refused, in every environment:

- a TLS parameter in `DATABASE_URL` (`sslmode`, `ssl`, `sslrootcert`, `sslcert`,
  `sslkey`, `uselibpqcompat`, or anything else starting `ssl`). `pg` merges URL
  parameters over the `ssl` option it is given, so `?sslmode=no-verify` would
  otherwise replace verified TLS with unverified TLS. The refusal names the
  parameters and never the URL.
- `DATABASE_SSL` values other than true/false spellings;
- `DATABASE_SSL_CA_FILE` without `DATABASE_SSL=true`, unreadable, holding no
  certificate, or holding a private key.

Refused in production:

- `PGSSLMODE`. `pg` reads it only when `ssl` is undefined, and the pool always
  passes `ssl` explicitly, as `false` or verified options. Setting it would be a
  TLS setting that does nothing.
- `DATABASE_SAME_HOST_PLAINTEXT=true` beside `DATABASE_SSL=true`;
- `NODE_TLS_REJECT_UNAUTHORIZED` (already, §8.3). The database connection passes
  `rejectUnauthorized: true` explicitly, so the variable could not weaken it.
  A real-handshake test proves that.

There is no downgrade path: verified TLS fails closed and never retries in
plaintext or unverified. The CA is used for the database connection only and is
never added to the process-wide store. Gate order in the api: owner (P0-008),
secrets (P0-010), broker transport (P0-011), database transport. Malformed TLS
settings are refused earlier, while the configuration is parsed.

The compose stack keeps plaintext on one private bridge, declared. That is the
same trade as §8's broker declaration, and it rests on the same fact: api and
PostgreSQL share a kernel, not a wire. A database on another host must use
`DATABASE_SSL=true`.

### 11.6 Development exceptions

- Every development port stays published, on `127.0.0.1`. `localhost:3000`, psql
  on `localhost:5432`, and a tunnel running on the same host all work as before.
  Reaching the stack from another machine on the LAN no longer does, on purpose.
- Plaintext to PostgreSQL anywhere, outside `NODE_ENV=production`
  (`development-plaintext`).
- `npm run dev:web` (Vite) still listens on `0.0.0.0` on the developer's
  machine. It is not part of any compose stack or of this contract.

### 11.7 Production requirements, and what is still open

To run the production stack:

- `infrastructure/docker/nginx/tls/fullchain.pem` and `privkey.pem`, for the host
  in `PUBLIC_ORIGIN`. The directory is mounted read-only into `web` only, and its
  contents are git-ignored. nginx refuses to start without them.
- `PUBLIC_ORIGIN`, `ALLOWED_ORIGINS` and the OIDC settings. The overlay pins
  `NODE_ENV=production` and `AUTH_MODE=oidc` for the api, so every production
  gate runs.

**DECISION REQUIRED:**

- **Certificate issuance and renewal.** No ACME client is configured, and port 80
  carries a redirect, not `/.well-known/acme-challenge/`. HTTP-01 would need
  that route added; DNS-01 or an operator-supplied certificate would not.
  Nothing monitors expiry.
- **Host firewall / security groups.** The overlay limits what Docker publishes.
  It does not stop another process on the host from listening publicly, or
  replace a firewall that allows only 443/80 inbound. Docker inserts its own
  iptables rules for published ports, which a host `ufw` policy does not
  filter by default, so the rule belongs in front of the host or in the
  `DOCKER-USER` chain.
- **Operator access** to the api, terminal, Grafana and Prometheus in production.
  None is published. Today that means `docker compose exec`, or an SSH tunnel to
  a port an operator publishes deliberately. The observability overlay is not
  part of the production contract.
- **Managed PostgreSQL.** When the database leaves this host, its provider's CA
  goes in `DATABASE_SSL_CA_FILE`, and the `postgres` service and the declaration
  are dropped. That is not a compose overlay this story ships.
- **IPv6.** `443:8443` and `80:8080` publish on every address family Docker is
  configured for.
- Unchanged from §8.7: api ⇄ terminal `/internal` calls, Prometheus scrapes and
  broker calls are plaintext on the compose bridge.

### 11.8 What proves it

| Suite | Runs against | Proves |
|---|---|---|
| `services/progress/test/database-tls.test.ts` | config; a real TLS handshake with a PostgreSQL-speaking listener and an in-memory CA | strict `DATABASE_SSL`; URL TLS parameters and bad CA files refused without echoing the password; the §11.5 modes; a trusted certificate connects; an untrusted CA or wrong host name is refused before the startup message; `NODE_TLS_REJECT_UNAUTHORIZED=0` and `PGSSLMODE=no-verify` change neither |
| `apps/api/test/database-transport.test.ts` | `loadConfig`, compose text | api production rules and gate order; runtime owner, beta capacity and broker transport intact; the declaration made once, for the api; the overlay pins `NODE_ENV=production`; no other service holds a `DATABASE_*`/`PG*` setting |
| `services/observability/test/compose-secret-distribution.test.ts` | compose text, merged per stack (`!reset`, `!override`) | loopback-only development publication; production publishes exactly 443→8443 and 80→8080; nothing from postgres, api, terminal or sandboxd; `expose:` is not publication; 443 reaches the TLS server and 80 only redirects; `database` membership and `internal`; no TLS-verification bypass in compose, `.env.example`, Makefile, Dockerfiles, nginx, workflows, scripts or any `src`/`bin` |
| `scripts/check-secret-distribution.mjs` (`make secrets-check`, CI `gates`) | `docker compose config` for base, runtime, observability and production | the same policy on the resolved configuration |
