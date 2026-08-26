# Docker Verifier — Requirement Contracts and Security Design

**Status:** design. Nothing in this document is implemented **except** the
`State.OOMKilled` snapshot field and `docker_container_oom_killed` from §4.2,
which shipped with DOCKER-009 after the Phase-2 evidence confirmed the signal.
**Implemented:** nothing. See §5. Sections 6–7 are the formal security
design and the shared-architecture recommendation.

---

## 0. The invariant these contracts must not break

The Docker requirement vocabulary is `.strict()`, closed, and — unlike the
`linux` family, which has `command_exit_code` and `command_output` — contains
**no field that carries a command**. `services/lab-orchestrator/src/requirements.ts`
states the rule directly: *"no field carries a command, a script, or a shell
fragment, and every handler is a read of the session's own Docker daemon."*

Both contracts below are written to keep that true. The rule they follow:

> **The verifier owns the executable and the argv shape. lab.yaml owns
> operands only, and every operand is regex-validated to a closed character
> class before it is allowed near an argv array.**

Concretely, for every proposed check:

- there is **no** `command`, `argv`, `script`, `exec`, `shell`, `url`, `host`,
  `image`, or `source_path` field;
- the handler builds a fixed argv array of string literals with validated
  operands slotted into fixed positions;
- the argv array reaches `execve` through `DockerEnginePort.execInContainer`,
  already documented as *"There is no shell: argv is passed straight to execve,
  so argument content can never become syntax"*;
- there is no `sh -c`, no `bash -c`, no string concatenation into a command
  line, and no command substitution anywhere on the path.

Throughout this document `CTRL` denotes the character class `\u0000-\u001f`, and
"no control characters" means the value is validated against
`/^[^\u0000-\u001f]*$/` — the same rule `requirements.ts` already applies to
`envValue` and to setup `argvElement`.

---

## 1. A finding that removes exec from one of the two contracts

`docker_container_file_content` **does not need exec at all.**

The Docker Engine exposes `GET /containers/{id}/archive?path=…`, surfaced by the
CLI as `docker cp <container>:<path> -`, which streams the file as a tar. Reading
a file that way is strictly better than `docker exec cat`:

| | `docker exec cat` | `docker cp` archive read |
|---|---|---|
| Runs code inside the student's container | **yes** | **no** |
| Works on a stopped container | no | **yes** |
| Works on `scratch` / distroless | no | **yes** |
| Depends on the student's userland | yes (`cat` must exist) | **no** |
| Executable invoked | whatever is in the image | the platform's own docker CLI |

The "works on a stopped container" row is not a nicety. The persistence proof in
the DOCKER-005 revision ("destroy the container, recreate it, the record is still
there") and the data-recovery lab DOCKER-024 both want to read a path in a
container that may not be running. Exec cannot do that; the archive read can.

**Recommendation: implement `docker_container_file_content` as an archive read.**
It is a read, it executes nothing in student-controlled space, and it belongs to
the "verification is entirely reads" property rather than eroding it.

That leaves `docker_http_reachable` as the only proposed check that genuinely
needs to execute inside a student container — because the thing being measured
*is* the network position of that container. Exec stays the exception.

---

## 2. `docker_container_file_content`

### 2.1 Schema

```yaml
- type: docker_container_file_content
  container: ledger-db          # required
  path: /var/lib/ledger/txn.log # required, absolute
  # exactly one of the three below:
  expected: "posted"            # exact match after trimming a trailing newline
  contains: ["posted", "eur"]   # every entry must be a substring
  absent: true                  # the path must not exist / not be readable
  label: "The ledger record survived the rebuild"
```

```ts
docker_container_file_content: z
  .object({
    type: z.literal('docker_container_file_content'),
    container: dockerObjectName,            // reused, unchanged
    path: containerAbsolutePath,            // new, defined below
    expected: z.string().max(1024).regex(NO_CONTROL_CHARS).optional(),
    contains: z.array(z.string().min(1).max(256).regex(NO_CONTROL_CHARS)).max(5).optional(),
    absent: z.literal(true).optional(),
    ...common,
  })
  .strict()
  .refine(exactlyOneOf('expected', 'contains', 'absent'), {
    message: 'must assert exactly one of expected, contains, or absent',
  }),
```

where `NO_CONTROL_CHARS` is `/^[^\u0000-\u001f]*$/`.

### 2.2 Allowed operands, validation, maximum lengths

| Operand | Type | Validation | Max |
|---|---|---|---|
| `container` | string | **existing** `dockerObjectName`: `/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/` | 128 |
| `path` | string | `containerAbsolutePath`, below | 255 |
| `expected` | string | no control characters | 1024 |
| `contains[]` | string[] | same, non-empty entries | 5 entries × 256 |
| `absent` | literal `true` | — | — |

`containerAbsolutePath` — a new, deliberately narrow path type:

```ts
const containerAbsolutePath = z
  .string()
  .min(2)
  .max(255)
  .regex(/^\/[A-Za-z0-9._/-]*$/, 'must be an absolute path inside the container')
  .refine((p) => !p.split('/').includes('..'), { message: 'must not traverse upwards' })
  .refine((p) => !p.includes('//'),            { message: 'must not contain empty segments' })
  .refine((p) => !p.endsWith('/'),             { message: 'must name a file, not a directory' })
  .refine((p) => !p.split('/').some((s) => s.startsWith('-')),
                                               { message: 'no path segment may begin with -' });
```

### 2.3 Path restrictions, and why each one is there

- **Absolute only.** A relative path resolves against the container's working
  directory, which the student controls — the check would mean something
  different per student.
- **Closed character class.** No spaces, quotes, `$`, backtick, `;`, `|`, `&`,
  `\`, or newline. Even though no shell ever sees this value, the class is narrow
  so a future refactor that *did* introduce a shell could not be exploited
  through already-shipped lab content.
- **No `..` segment, no `//`, no trailing `/`.**
- **No segment may begin with `-`.** Belt and braces: combined with the `--`
  end-of-options separator in the argv (§2.5), a path can never be read as a flag.
- The path is *inside the container*, so there is no host path to restrict. No
  field in this schema names a host path.

### 2.4 Container-name validation and scoping

`container` reuses the existing `dockerObjectName` regex, which forbids `/`, `:`,
`@`, and whitespace. That matters for three reasons:

1. It cannot express `other-sandbox/container`.
2. It cannot express a registry-style reference.
3. It is passed to `DockerVerifyReader.container(name)` **first**. If that returns
   `null`, the check fails with "no container named X" *before anything is
   executed*. A name that does not exist in this session's daemon never reaches
   an argv.

### 2.5 Exact internal execution model

**Shell: none.** Not `sh -c`, not `bash -c`, not a string command line.

```
handler
  → reader.container(container)            // must exist, else fail early
  → reader.readContainerFile(container, path)
      → DockerEnginePort.copyFromContainer(name, path)
          → argv: ['docker', 'cp', '--', name + ':' + path, '-']
            spawned execFile-style (argv array to execve, no shell),
            through the session-scoped CLI client
          → tar stream on stdout, parsed in process, first regular file entry
```

The only executable invoked is the platform's own `docker` CLI. The one composed
string, `name + ':' + path`, is built from two values that have each passed a
closed-class regex; neither can contain a `:`, a space, or a metacharacter, so
the composition is unambiguous. It sits after `--`, so it can never be parsed as
an option.

Nothing runs inside the student's container. The container need not be running.

### 2.6 Timeout behaviour

- Hard timeout **5 seconds**, set by the handler, **not settable from lab.yaml**.
- On timeout the child is killed and the check returns **fail** with
  `"could not read /path within 5s"` — never a hang, never a pass.
- Reported as failed rather than skipped, because an unreadable container is
  usually a real property of the student's state (one stuck in `restarting`, say).

### 2.7 Output-size limits

- The tar stream is read to **64 KiB**, then the child is killed.
- A file whose tar header declares **> 1 MiB** is rejected before reading:
  `"file is larger than the verifier will read"`. No partial-match guessing.
- `expected` compares against full content only when it fit inside 64 KiB. If it
  did not, the check **fails** with an explicit over-limit message rather than
  silently comparing a prefix.
- `contains` matches within the first 64 KiB, and the detail says so.

### 2.8 Failure-message behaviour

The house rule is *"failure detail describes what was observed, never what to
type."* Additionally, **the file's content is never echoed back** — a lab may
seed a file whose content is the answer to a later step, and printing it leaks it.

| Situation | Detail |
|---|---|
| No such container | `No container named 'ledger-db' in sandbox 'lab-…'` |
| Path missing | `Container 'ledger-db' has no file at /var/lib/ledger/txn.log` |
| Mismatch (`expected`) | `File /var/lib/ledger/txn.log in 'ledger-db' does not match what the lab expects (read 214 bytes)` |
| Mismatch (`contains`) | `File … does not mention 'posted'` — the needle is already public lab content, so naming it is safe; the file is not quoted |
| `absent: true` but present | `Container 'ledger-db' still has a file at /tmp/scratch` |
| Too large | `File … is larger than the 1 MiB the verifier will read` |
| Timeout | `Could not read /… from 'ledger-db' within 5s` |

### 2.9 How command injection is prevented

1. No field carries a command. There is no `command`/`argv`/`script` key, and the
   schema is `.strict()`, so an unknown key is a load-time error rather than an
   ignored one.
2. The argv array is a literal in shipped code; operands occupy fixed positions.
3. Both operands pass closed-class regexes containing no shell metacharacter and
   no whitespace.
4. `--` terminates option parsing before any operand.
5. The spawn is `execFile`-style — an argv array to `execve` — with no shell.
6. `.strict()` plus the existing `expectIssue` schema tests mean a lab that adds
   a field fails to load rather than being silently accepted.

### 2.10 How host access is prevented

- No operand names a host path, host port, socket, or daemon.
- The one composed value is `container:path`; the container half is resolved by
  the daemon in its own container namespace.
- The `docker cp` runs through the **session-scoped** CLI client, which reaches
  the session's dind daemon over mutual TLS. It has no handle on the host daemon.
  The host daemon is a *different* `DockerEnginePort` instance the verifier is
  never given.

### 2.11 How cross-session / cross-container access is prevented

- `DockerVerifyReader` is constructed with **one** `DockerEnginePort` and one
  sandbox name, both `private readonly`. No handler parameter can change either.
  A new `readContainerFile` method must take a container name and nothing else.
- A student can only be graded against the daemon their session owns, because
  that is the only daemon the reader was built with. This is the property already
  asserted by *"never passes using another session's Docker state"* in
  `services/verifier/test/docker-requirements.test.ts`; a new check joins that
  loop automatically.
- Within a session, reading another of *the student's own* containers is fine —
  it is their environment.

---

## 3. `docker_http_reachable`

### 3.1 The core decision: there is no URL

**A lab may not name a host, an IP address, or a URL. It names two containers.**

```yaml
- type: docker_http_reachable
  from: web                 # the client container — session-owned
  to: api                   # the target container — session-owned, NOT a hostname
  port: 80
  path: /healthz            # optional, default "/"
  scheme: http              # optional enum, default http
  expect_status: 200        # optional, default 200
  label: "web can reach api"
```

```ts
docker_http_reachable: z
  .object({
    type: z.literal('docker_http_reachable'),
    from: dockerObjectName,
    to: dockerObjectName,
    port: z.number().int().min(1).max(65535),
    path: httpRequestPath.default('/'),
    scheme: z.enum(['http', 'https']).default('http'),
    expect_status: z.number().int().min(100).max(599).default(200),
    expect_reachable: z.boolean().default(true),   // false = must NOT be reachable
    ...common,
  })
  .strict()
  .refine((v) => v.from !== v.to, { message: 'from and to must be different containers' }),
```

`expect_reachable: false` is the negative form the segmentation labs need
("`web` must not reach `db`"), and it is far safer than letting a lab name an
off-network host to prove isolation.

### 3.2 Allowed operands, validation, maximum lengths

| Operand | Type | Validation | Max |
|---|---|---|---|
| `from`, `to` | string | **existing** `dockerObjectName` — forbids `/`, `:`, `@`, whitespace | 128 |
| `port` | int | 1–65535, a **number** in the schema, re-stringified by the handler | — |
| `path` | string | `httpRequestPath`, below | 128 |
| `scheme` | enum | `http` \| `https` — two constants | — |
| `expect_status` | int | 100–599 | — |
| `expect_reachable` | bool | — | — |

```ts
const httpRequestPath = z
  .string()
  .min(1)
  .max(128)
  .regex(/^\/[A-Za-z0-9._~/-]*$/, 'must be an absolute request path')
  .refine((p) => !p.includes('//'), { message: 'must not contain empty segments' })
  .refine((p) => !p.split('/').includes('..'), { message: 'must not traverse upwards' });
```

The class deliberately excludes `@`, `:`, `?`, `#`, `%`, `\`, and whitespace.
`@` and `:` because in a URL they can move the authority; `%` because
percent-encoding could smuggle any of the above past a naive reader; `?` and `#`
because no lab needs them and they widen the surface for nothing.

### 3.3 URL / host restrictions — and how ownership is proven

**There is no host field, so there is nothing to restrict.** The handler
assembles the URL:

```ts
const url = `${scheme}://${to}:${port}${path}`;
```

`to` has passed `dockerObjectName`, which cannot contain `/`, `:`, or `@`;
`path` cannot begin the authority. The result is structurally guaranteed to
address a container name on the session daemon's own embedded DNS.

Ownership is proven by **four gates**, all before any argv is built:

1. **`to` must exist in this session's daemon.** `reader.container(to)` is a read
   against the session-scoped `DockerEnginePort`. There is no daemon parameter,
   so a container in another session is not merely forbidden — it is
   unaddressable. `null` → fail with "no container named 'api'".
2. **`from` must exist in this session's daemon.** Same read, same guarantee.
3. **`from` and `to` must share at least one network.** The handler intersects
   `from.networks` with `to.networks`. Empty intersection → the check returns its
   verdict **without executing anything**: `fail` when `expect_reachable: true`
   ("they share no network"), `pass` when `expect_reachable: false`. This is both
   a correctness gate and a cost gate — the common negative case never execs.
4. **The name is resolved by the session daemon's embedded DNS**, which serves
   only that daemon's user-defined networks. A container name has no
   dots-and-TLD form that would escape to an upstream resolver, and gate 3 bounds
   it regardless.

What this makes **unnameable by construction rather than by blocklist**:
`127.0.0.1`, `localhost`, `0.0.0.0`, `169.254.169.254` and every other cloud
metadata endpoint, `host.docker.internal`, the platform's own API, another
session's sandbox, and every Internet host. None of them is a container name in
this session's daemon, and a container name is the only thing the schema accepts.

> A blocklist of dangerous hosts would be the wrong design. This is an allowlist
> of exactly one shape — "a container in the daemon I was constructed with" —
> which is why no metadata-endpoint special case is needed.

### 3.4 Whether a shell is involved

**No.** The argv is a literal array with operands in fixed positions:

```ts
const argv = ['wget', '--spider', '-S', '-q', '-T', String(TIMEOUT_SECONDS), '--', url];
```

No `sh -c`. No `&&`, redirection, pipe, or substitution. `String(port)` and
`String(TIMEOUT_SECONDS)` come from schema-validated numbers and a shipped
constant, so they are digits by construction.

### 3.5 Exact internal execution model

Unlike §2, this check must run **from inside `from`** — the property under test
*is* that container's network position. Two models were considered:

| Model | Creates state? | Depends on student's image | Verdict |
|---|---|---|---|
| **A. Exec inside `from`** | no | yes (needs `wget`/`curl`) | **recommended** |
| B. Platform-owned probe container on the same network | **yes** — one container from the session's 10-container budget | no | rejected |

Model B is rejected because *"verification is entirely reads, and the only writes
are the ones the platform itself makes to build, seed, reset and destroy a
sandbox"* is worth more than the convenience. A verifier that creates containers
can no longer be described as read-only, and the failure modes — budget
exhaustion mid-verification, a leaked probe after a crash — are ugly.

Model A in full:

```
handler
  → reader.container(from)   // gate 2
  → reader.container(to)     // gate 1
  → network intersection     // gate 3 — may return a verdict with no exec at all
  → reader.probeHttp(from, url)
      → DockerEnginePort.execInContainer(from, argv, { timeoutMs: 7000 })
          → docker exec with an explicit argv array → execve, no shell
      → { exitCode, stdout, stderr, timedOut }
  → verdict from exitCode, and from the status line in stderr when present
```

`probeHttp` is a method on `DockerVerifyReader` taking a container name and a
pre-assembled URL. **It is not a general exec.** It accepts no argv, no binary
name, and no options; the argv is a literal inside the reader. That is the point:
`execInContainer` stays private to the reader, and no handler — present or future
— can reach it with a caller-supplied command.

**The lab-authoring dependency is explicit:** `from` must be an image with an HTTP
client. When the exec returns 126/127 ("not executable" / "not found"), the check
must report a **lab-authoring problem, not a student failure** — *"the client
container has no HTTP client available"* — in the same spirit as the existing
`workspaceUnavailable()` message, which is careful not to imply the student erred.

### 3.6 Timeout behaviour

- The timeout is **fixed by the handler at 5s** and is **not settable from
  lab.yaml**. A lab-settable timeout is a lab-settable resource cost and buys
  nothing.
- Enforced twice: `-T 5` inside `wget`, and `timeoutMs: 7000` on
  `execInContainer` as the outer backstop, so a wedged client cannot hang a run.
- `DockerExecResult.timedOut` distinguishes "timed out" from "refused", and the
  detail says which.
- Timeout with `expect_reachable: true` → **fail**. Timeout with
  `expect_reachable: false` → **pass**, detail "no response within 5s", because
  unreachability is what was asserted.

### 3.7 Output-size limits

- stdout and stderr are each captured to **64 KiB**, then truncated and the exec
  killed.
- Only the HTTP status line is parsed out of stderr. **The response body is never
  read into the verdict and never appears in a message.**
- `--spider` downloads no body in the normal path, so the 64 KiB cap is a
  backstop rather than the primary control.

### 3.8 Failure-message behaviour

| Situation | Detail |
|---|---|
| `to` missing | `No container named 'api' in sandbox 'lab-…'` |
| `from` missing | `No container named 'web' in sandbox 'lab-…'` |
| No shared network | `Containers 'web' and 'api' share no network` |
| Wrong status | `'web' reached 'api' on port 80 and got HTTP 503, expected 200` |
| Refused | `'web' could not connect to 'api' on port 80` |
| Timed out | `'web' got no response from 'api' on port 80 within 5s` |
| Reachable but must not be | `'web' can still reach 'api' on port 80` |
| No client in image | `The 'web' container has no HTTP client available — this lab cannot be checked as written` |

Never included: the response body, headers other than the status code, or
resolved IP addresses — they are noise, and they leak the daemon's subnet layout.

### 3.9 How command injection is prevented

Identical to §2.9, plus:

7. `port` and the timeout are schema-validated **numbers**; they become strings
   only via `String()` in shipped code, so they are digits and nothing else.
8. `scheme` is a two-value enum — not a string — so it cannot become `file:`,
   `gopher:`, or `ftp:`.
9. The URL is assembled from four already-validated parts inside the handler.
   **lab.yaml never supplies a URL, so there is no URL to inject into.**
10. `probeHttp` accepts no binary name and no argv, so a future handler cannot
    widen this into a general exec without changing the reader itself — a
    reviewable single-file change rather than a lab-content change.

### 3.10 How host access is prevented

- Structurally: the only addressable target is a container name in the session's
  own daemon (§3.3, gates 1–4).
- The request originates inside a student container in the session's network
  namespace, which has no route to the platform host's Docker socket.
- `scheme` cannot be `file:`; `path` cannot contain `..`; `to` cannot be an IP.
- The platform's *host* `DockerEnginePort` is never handed to the verifier — the
  reader holds only the session port.

### 3.11 How cross-session / cross-container access is prevented

- Same structural argument as §2.11: one reader, one daemon, fixed at
  construction, `private readonly`, no handler-settable daemon.
- Both `from` and `to` are resolved through that one reader before any exec.
- The existing isolation test — which runs **every shipped lab** against a
  session that did the work and one that did not — covers any lab adopting this
  check for free.

### 3.12 Residual risks, stated plainly

1. **Exec is exec.** Even a narrow one runs a process in a student container. A
   student who controls the image controls what `wget` *is*, and can therefore
   make their own check pass. That is self-cheating with no cross-session
   consequence, and it is the same trust level the platform already extends by
   grading state the student produced. Worth a comment in the handler.
2. **`--spider` still opens a connection** from `from`. Gate 3 bounds where.
3. **`execInContainer` must remain private to the reader.** If it is ever exposed
   on the reader's public surface, the invariant in §0 is gone. Recommend a test
   asserting `DockerVerifyReader` has no public `exec` member.

---

## 4. Cheap capabilities — precise implementation plan

Ordered cheapest-first. **Everything in §4.1 is already fetched by
`cli-client.ts` and thrown away**; only a requirement type and a handler are
missing.

### 4.0 A constraint that governs all of these

`services/verifier/test/docker-requirements.test.ts` ends with:

```ts
it('exercises every Docker requirement type across the shipped labs', () => {
  expect([...DOCKER_REQUIREMENT_TYPES].filter((type) => !used.has(type))).toEqual([]);
});
```

**A new requirement type that no shipped lab uses fails the suite.** That is a
good rule and should stay. It means every item below must land *together with*
the lab that consumes it — schema, handler, `solve()` case, and lab content in
one change — and that these cannot be batched ahead of the curriculum work.

### 4.1 Already collected; needs only a type + handler

| Capability | Snapshot field (exists today) | Proposed requirement type |
|---|---|---|
| restart policy | `DockerContainerSnapshot.restartPolicy` — `cli-client.ts:747` | `docker_container_restart_policy` |
| command | `.command` (`Path` + `Args`) | `docker_container_command` |
| entrypoint | `.entrypoint` (`Config.Entrypoint`) | `docker_container_entrypoint` |
| labels | `.labels` (`Config.Labels`) | `docker_container_label` |
| network internal | `DockerNetworkSnapshot.internal` | `docker_network_internal` |
| image size | `DockerImageSnapshot.sizeBytes` (`RawImage.Size`) | `docker_image_size` |

Proposed schemas:

```ts
docker_container_restart_policy: { name, expected: z.enum(['no','always','unless-stopped','on-failure']) }
docker_container_command:        { name, contains: z.array(argToken).min(1).max(10) }  // ordered subsequence of argv
docker_container_entrypoint:     { name, contains: z.array(argToken).min(1).max(10) }
docker_container_label:          { name, key: labelKey, value: z.string().max(256).optional() }
docker_network_internal:         { name, expected: z.boolean().default(true) }
docker_image_size:               { image, max: dockerMemoryValue }  // reuse the byte parser
```

`argToken` is a new closed class: `z.string().min(1).max(255).regex(/^[^\u0000-\u001f]+$/)`.
It is **compared, never executed** — an assertion *about* argv, not a source of one.

**Files touched, per capability (identical shape each time):**

1. `services/lab-orchestrator/src/requirements.ts` — add the schema to
   `dockerRequirementSchemas`, add the type to the family map.
2. `services/verifier/src/handlers/docker-containers.ts` (or `docker-resources.ts`
   for image/network) — one exported handler.
3. `services/verifier/src/registry.ts` — one entry in `DOCKER_HANDLERS`, one
   import. *The mapped type makes this non-optional: omit it and the build fails.*
4. `services/verifier/test/docker-requirements.test.ts` — one `solve()` case plus
   positive and negative tests.
5. The lab that uses it (see §4.0).

`docker_image_size` additionally reuses `parseDockerMemory` from
`services/verifier/src/docker-quantity.ts`, so `max: "30m"` and `max: "31457280"`
mean the same thing — consistent with how memory limits already behave.

### 4.2 New snapshot fields — one parser line each

| Field | Raw inspect source | Snapshot addition |
|---|---|---|
| `State.Health` | `RawContainer.State.Health.{Status,FailingStreak}` | `health?: { status: 'none' \| 'starting' \| 'healthy' \| 'unhealthy'; failingStreak: number }` |
| `State.OOMKilled` | `RawContainer.State.OOMKilled` | `oomKilled: boolean` — **IMPLEMENTED** |
| `Config.User` | `RawContainer.Config.User` | `user: string` (`''` means root/unset) |
| `HostConfig.ReadonlyRootfs` | `RawContainer.HostConfig.ReadonlyRootfs` | `readOnlyRootfs: boolean` |

**Files touched — the same four for all of them, so do them as one change:**

1. `services/lab-orchestrator/src/docker/port.ts` — extend
   `DockerContainerSnapshot`. Every field optional-tolerant: the file's own
   comment already requires *"a snapshot must survive a daemon that omits a
   field"*.
2. `services/lab-orchestrator/src/docker/cli-client.ts` — extend `RawContainer`
   (~line 609) and the snapshot builder (~line 737): four lines, each defaulted.
   `State.Health` is **absent entirely** on a container with no `HEALTHCHECK`,
   which must map to `status: 'none'` and **not** to `undefined` behaving as
   unhealthy.
3. `services/lab-orchestrator/test/docker-fakes.ts` — extend the fake's snapshot
   builder (~line 556) and its `RunContainerSpec` handling so tests can seed them.
4. Then §4.1's five-file shape for each requirement built on them:
   `docker_container_health`, `docker_container_oom_killed`,
   `docker_container_user`, `docker_container_read_only`.

Proposed schemas:

```ts
docker_container_health:      { name, expected: z.enum(['healthy','unhealthy','starting','none']) }
docker_container_oom_killed:  { name, expected: z.boolean().default(true) }
docker_container_user:        { name, expected: z.string().max(64).optional(), non_root: z.boolean().optional() }
docker_container_read_only:   { name, expected: z.boolean().default(true) }
```

`docker_container_user` needs care: `Config.User` may be `""`, `"1000"`,
`"appuser"`, or `"1000:1000"`. `non_root: true` should pass for any non-empty
value that is not `root`, `0`, or `0:0` — and the handler must report what it saw.

### 4.3 Why these come before any exec work

- `docker_container_oom_killed` is **one boolean**, and it is the difference
  between "exit code 137" — which `docker kill` also produces — and a provable
  OOM.
- `docker_container_health` unblocks three labs and needs no exec.
- `docker_container_read_only` and `_user` unblock the security lab, no exec.
- None of them touches `execInContainer`, the workspace mount, or the network.

**Ranking, most value per unit of risk:**
`oom_killed` → `health` → `read_only` + `user` → `restart_policy` →
`command` / `entrypoint` → `label` → `network_internal` → `image_size`.

---

## 5. What was implemented in this pass

**Nothing from §2, §3, §4, §6, or §7.** The implemented change is lab content only,
using requirement types and handler code that already ship. See the session
report and `labs/docker/docker-009-resource-limits/lab.yaml`.

---

# 6. Formal security design — narrow execution primitives

**Status: DESIGN ONLY. Not implemented. Approval required before any code.**

Supersedes the sketches in §2–§3 with the full per-verifier contract the policy
asks for, adds the third verifier (`docker_container_exec_exit`), and adds the
threat table.

## 6.0 The invariant, stated as a pipeline

```
   lab.yaml data
        |   strict zod schema, closed character classes, bounded lengths
   validated operands
        |   trusted verifier code selects the executable and builds argv
   fixed executable + fixed argv shape
        |   execFile-style spawn — argv array to execve
   NO SHELL
        |   timeout, output cap, exit-code interpretation
   bounded execution -> PASS / FAIL + observed detail
```

Forbidden, permanently:

```
   lab.yaml -> command string -> sh -c
```

There is no field in any contract below that carries a command, an executable
name, an argv array, a URL, a host, or a host path.

---

## 6.1 `docker_container_exec_exit`

**PURPOSE** — Assert that a specific, lab-declared *condition* holds inside a
running container, expressed as a check the verifier knows how to perform, and
graded on the exit status of that check. Intended for conditions no `inspect`
field can answer: "is this path writable", "is this process running", "does this
user exist inside the image".

> **Recommendation: do not build this one.** See §6.5. It is documented here
> because it was asked for, and because writing out its contract is what shows
> why the other two are safe and this one is not.

**TRUST BOUNDARY** — the student's own container image. The binary that runs is
whatever the image provides. Everything inside that boundary is
student-controlled.

**EXECUTABLE** — not lab-selectable. The verifier picks it from a closed map
keyed by an enum:

```ts
check: z.enum(['path_writable', 'path_executable', 'process_running', 'user_exists'])
```

**FIXED ARGV OWNED BY VERIFIER**

| `check` | argv (literal in shipped code) |
|---|---|
| `path_writable` | `['test', '-w', '--', path]` |
| `path_executable` | `['test', '-x', '--', path]` |
| `process_running` | `['pgrep', '-x', '--', name]` |
| `user_exists` | `['id', '--', name]` |

**OPERANDS ALLOWED FROM LAB.YAML** — `container` (Docker object name), `check`
(enum), and exactly one of `path` or `name` as the enum requires. Nothing else.

**OPERAND VALIDATION / MAX LENGTH / ALLOWED CHARACTERS**

| Operand | Max | Allowed | Notes |
|---|---|---|---|
| `container` | 128 | `/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/` | existing `dockerObjectName` |
| `check` | — | 4-value enum | not a string |
| `path` | 255 | `/^\/[A-Za-z0-9._\/-]*$/` | `containerAbsolutePath`, §2.2 |
| `name` | 32 | `/^[a-z_][a-z0-9_-]*$/` | POSIX-ish user / process name |

**OPTION-INJECTION PROTECTION** — `--` before every operand; no path segment or
name may begin with `-`; the character class excludes `-` in first position.

**PATH VALIDATION** — absolute, no `..` segment, no `//`, no trailing `/`, no
segment starting `-`.

**TIMEOUT** — 5s, handler-fixed, plus `timeoutMs: 7000` outer backstop.

**OUTPUT SIZE LIMIT** — 4 KiB stdout/stderr; the result is the exit code, so
output is diagnostic only and is never echoed to the student.

**EXIT-CODE HANDLING** — `0` -> pass. `1` -> fail (the condition does not hold).
`126` (not executable) and `127` (not found) -> **report as a lab-authoring
problem, not a student failure**. Any other non-zero -> fail with the code named.

**ERROR HANDLING** — container missing -> fail before exec. Container not running
-> fail with "container is not running, so it cannot be inspected from inside".
Timeout -> fail; never hang, never pass.

---

## 6.2 `docker_container_file_content`

**PURPOSE** — Prove a file's content inside a container: that a volume actually
persisted data, that a config landed, that a write to a read-only path did not.

**TRUST BOUNDARY** — the Docker daemon only. **Nothing runs inside the student's
container.** See §1: this is an archive read, not an exec.

**EXECUTABLE** — the platform's own `docker` CLI, through the session-scoped
client. Never a binary from the student's image.

**FIXED ARGV OWNED BY VERIFIER** — `['docker', 'cp', '--', container + ':' + path, '-']`

**OPERANDS ALLOWED FROM LAB.YAML** — `container`, `path`, and exactly one of
`expected` / `contains[]` / `absent: true`.

**OPERAND VALIDATION / MAX LENGTH / ALLOWED CHARACTERS** — §2.2. `container`
<= 128 `dockerObjectName`; `path` <= 255 `containerAbsolutePath`; `expected`
<= 1024, no control characters; `contains` <= 5 entries x 256, no control
characters.

**OPTION-INJECTION PROTECTION** — `--` before the operand; no path segment may
begin with `-`; neither operand can contain `:` or whitespace, so the single
composed string `container:path` is unambiguous.

**PATH VALIDATION** — as §2.3. Absolute; no `..`; no `//`; no trailing `/`.

**TIMEOUT** — 5s, handler-fixed. Kill on expiry, report fail.

**OUTPUT SIZE LIMIT** — tar stream read to 64 KiB then killed; a header
declaring more than 1 MiB is rejected before reading. An `expected` comparison
against a file over the limit fails explicitly rather than comparing a prefix.

**EXIT-CODE HANDLING** — `0` with a tar entry -> compare. Non-zero with "No such
container:path" -> the path is absent: **fail** normally, **pass** when
`absent: true`. Other non-zero -> fail with the daemon's reason, not its raw
stderr.

**ERROR HANDLING** — container missing -> fail before exec. **Works on a stopped
container**, which is the point. Content is never echoed (§2.8).

---

## 6.3 `docker_http_reachable`

**PURPOSE** — Prove one container's *network position*: that it can, or cannot,
reach another container's service. The only assertion here that no `inspect`
field can answer, because reachability is a property of the network rather than
of a config object.

**TRUST BOUNDARY** — the `from` container's image, which is student-controlled.
This is the one genuine exec, and §3.12 states the residual risk.

**EXECUTABLE** — `wget` from the `from` image. Not lab-selectable.

**FIXED ARGV OWNED BY VERIFIER** —
`['wget', '--spider', '-S', '-q', '-T', '5', '--', url]`
where `url` is assembled **by the handler** as
`scheme + '://' + to + ':' + port + path`.

**OPERANDS ALLOWED FROM LAB.YAML** — `from`, `to`, `port`, `path`, `scheme`,
`expect_status`, `expect_reachable`. **No host. No IP. No URL.**

**OPERAND VALIDATION / MAX LENGTH / ALLOWED CHARACTERS** — §3.2. `from` / `to`
<= 128 `dockerObjectName`; `port` int 1–65535; `path` <= 128
`/^\/[A-Za-z0-9._~\/-]*$/`; `scheme` 2-value enum; `expect_status` int 100–599.

**OPTION-INJECTION PROTECTION** — `--` before the URL. `dockerObjectName`
forbids a leading `-`, and `path` must start with `/`, so the assembled URL can
never begin with `-`. `scheme` is an enum, so `file:` is unreachable.

**PATH VALIDATION** — must start `/`; no `..`; no `//`; the class excludes
`@`, `:`, `?`, `#`, `%`, backslash and whitespace, so `path` can never move the
URL authority.

**TIMEOUT** — 5s inside `wget` (`-T 5`) **and** `timeoutMs: 7000` on the exec.
Timeout with `expect_reachable: true` -> fail; with `false` -> pass.

**OUTPUT SIZE LIMIT** — 64 KiB per stream. Only the status line is parsed. The
response body is never read into the verdict and never shown.

**EXIT-CODE HANDLING** — `0` -> reachable, compare `expect_status`. `1` / `4`
(network failure) -> unreachable. `8` (server error response) -> reachable,
status compared. `127` -> no HTTP client in the image: **lab-authoring problem,
not a student failure**.

**ERROR HANDLING** — four ownership gates run *before* any exec (§3.3); an empty
network intersection returns a verdict with no execution at all.

---

## 6.4 Threat table

Every input below is rejected at **schema validation**, before any handler runs,
unless noted. `container` / `from` / `to` use `dockerObjectName`; `path` uses
`containerAbsolutePath` or `httpRequestPath`.

| Input | Field | Outcome | Why |
|---|---|---|---|
| `; rm -rf /` | any | **REJECTED** at schema | `;` and space are outside every class |
| `&& curl evil` | any | **REJECTED** | `&` and space outside class |
| `\|\| true` | any | **REJECTED** | pipe outside class |
| `\| tee /etc/passwd` | any | **REJECTED** | pipe and space outside class |
| `$(whoami)` | any | **REJECTED** | `$`, `(`, `)` outside class |
| backtick `whoami` backtick | any | **REJECTED** | backtick outside class |
| newline (LF, 0x0A) | container / path | **REJECTED** | outside class; `expected` / `contains` additionally reject all control characters |
| carriage return (CR, 0x0D) | any | **REJECTED** | same |
| `../../etc/shadow` | path | **REJECTED** | `..` segment refinement |
| `/var/lib/../../etc/shadow` | path | **REJECTED** | `..` segment refinement |
| `/etc/shadow` | path | **ACCEPTED — and harmless** | absolute paths are the *required* form; the read is scoped to a container in the student's own session, whose `/etc/shadow` is their own |
| `--help` | container / name | **REJECTED** | class requires `[a-zA-Z0-9]` as the first character |
| `--help` | path | **REJECTED** | must start with `/`; no segment may begin with `-` |
| `--privileged` | any | **REJECTED** | leading `-`; and no operand is ever placed before `--` |
| `--mount type=bind,src=/` | any | **REJECTED** | `=`, `,`, space outside class; leading `-` |
| `--network host` | any | **REJECTED** | leading `-`, space |
| `-v /:/host` | any | **REJECTED** | leading `-`, space, `:` |
| `*`, `?`, `[a-z]` | any | **REJECTED** | outside class — **and irrelevant: no shell means no glob expansion** |
| single and double quotes | any | **REJECTED** | outside class — and irrelevant, since argv elements are never quoted |
| backslash | any | **REJECTED** | outside class |
| `cafe` with combining accent, dotted capital I, RTL marks, homoglyphs | any | **REJECTED** | classes are ASCII-only |
| NUL (0x00) | any | **REJECTED** | control-character class |
| zero-width joiner, BOM | any | **REJECTED** | ASCII-only classes |
| 100 000-character string | any | **REJECTED** | every field has an explicit `.max()`: 128 container, 255 path, 1024 expected, 256 x 5 contains, 128 http path |
| `localhost`, `127.0.0.1`, `0.0.0.0` | `to` | **REJECTED as a target** | `to` must resolve to a container **in this session's daemon**; a literal IP is not a container name. Digits alone would pass the regex but fail gate 1 |
| `169.254.169.254` (cloud metadata) | `to` | **REJECTED** | same — gate 1. There is no host field to put it in |
| `host.docker.internal` | `to` | **REJECTED** | gate 1: not a container in this session |
| `//evil.example/x` | `path` | **REJECTED** | `//` refinement — this is the URL-authority-confusion case |
| `/x@evil.example` | `path` | **REJECTED** | `@` outside class |
| `/x%2f%2fevil` | `path` | **REJECTED** | `%` outside class |
| `file` | `scheme` | **REJECTED** | 2-value enum |
| `0`, `70000`, `-1` | `port` | **REJECTED** | int 1–65535 |
| another session's container name | any | **REJECTED at runtime** | the reader holds one daemon, fixed at construction; the name simply does not resolve |
| unknown extra field | any | **REJECTED at load** | every schema is `.strict()` |

**Two structural notes.** First, the glob and quote rows are rejected by the
character class, but they would be inert anyway — with `execve` and no shell
there is no globbing and no quote removal. Belt and braces is deliberate: it
means a future refactor that *did* introduce a shell would not silently become
exploitable through already-shipped lab content. Second, none of these is
defended by a blocklist. Every row is a *positive* character class plus a
resolve-in-my-own-daemon gate, so an attack not on this list fails for the same
reason the listed ones do.

---

## 6.5 Recommendation on the three verifiers

| Verifier | Recommendation |
|---|---|
| `docker_container_file_content` | **Build.** No exec, works on stopped containers, unlocks the persistence and data-recovery labs. Lowest risk, highest value. |
| `docker_http_reachable` | **Build, second.** The only way to assert a network position. Accept the documented residual risk (§3.12). |
| `docker_container_exec_exit` | **Do not build.** Every condition it would check is either answerable from `inspect` (user, read-only rootfs, capabilities — all §4.2 snapshot fields) or better answered by `file_content`. It buys a general-purpose exec surface for cases the cheaper primitives already cover. If a future lab genuinely needs it, add it *then*, with the one `check` enum value that lab needs — never speculatively. |

That ordering also means **the exec-based reader method is not needed at all for
the first delivery**: `file_content` is an archive read.

---

# 7. Shared verifier architecture — A / B / C

## 7.1 The options

- **Option A — Docker-specific requirement types.** Two or three handlers in
  `handlers/docker-*.ts`; each builds its own argv and calls
  `DockerEnginePort.execInContainer` / `copyFromContainer` directly.
- **Option B — a shared execution abstraction** (e.g. `BoundedExecutor`) in a
  common package, used internally by the Docker, Linux, Kubernetes and Terraform
  verifiers. Owns spawn, timeout, output cap and exit-code normalisation; exposes
  no caller-supplied executable.
- **Option C — no abstraction; each verifier implements its own strict
  operation**, duplicating spawn / timeout / cap logic per check.

## 7.2 Comparison

| Criterion | A (Docker-specific) | B (shared abstraction) | C (per-check) |
|---|---|---|---|
| **Security** | Good — small surface, but each handler re-implements the bounds | **Best** — bounds enforced in one audited place; a handler *cannot* forget a timeout or a cap | Worst — every check is a fresh chance to omit a bound |
| **Maintainability** | Fair — 2–3 handlers is manageable; grows badly | **Best** — one place to fix a spawn bug | Worst — N copies |
| **Auditability** | Fair — a reviewer reads 3 handlers | **Best** — a reviewer reads one executor, then only checks that each caller passes an enum rather than a string | Worst — a reviewer must read every check, forever |
| **Testability** | Good — the fake daemon already exists | **Best** — the executor is unit-testable in isolation, including timeout and truncation, with no daemon at all | Poor |
| **Command-injection risk** | Low | **Lowest** — the signature can *forbid* a caller-supplied command by taking `(recipe: RecipeId, operands: ValidatedOperands)` rather than `(argv: string[])` | Low, but repeated |
| **Risk of future misuse** | **Moderate** — nothing stops handler #4 from calling `execInContainer` with a caller-supplied argv | **Low if the signature forbids it; High if it takes `argv: string[]`** — then it is the generic exec the policy forbids, with a friendly name | Moderate |
| **Cross-track usefulness** | None | **High** — the `linux` family already has `command_exit_code` / `command_output` taking arbitrary commands; B is the natural place to bring those under the same discipline | None |

## 7.3 Recommendation: Option B, with one hard constraint

Build a shared `BoundedExecutor` that owns spawn, timeout, output truncation and
exit-code normalisation — **but its public signature must not accept an argv
array or an executable name.** It must take a *recipe identifier* from a closed
registry plus already-validated operands:

```ts
// GOOD — the executor owns the argv; callers name a recipe.
exec(recipe: 'container.read_file' | 'container.http_probe', operands: Validated): Promise<BoundedResult>

// FORBIDDEN — this is the generic exec with a nicer name.
exec(argv: string[], opts): Promise<BoundedResult>
```

The recipe registry then becomes the single audit surface: reviewing
container-execution safety is "read one file that lists every argv the platform
can produce", instead of grepping for spawn calls across four verifier families.

**Why not A:** it works for two Docker checks and then stops working. The moment
a Linux or Kubernetes lab wants the same guarantee, A has no answer, and the
`linux` family's existing `command_exit_code` — which *does* take a command
string — stays outside the discipline indefinitely. B offers a migration path
for it.

**Why not C:** it makes every future check a fresh security review.

**The trap to avoid:** B done carelessly is *worse* than A. An executor taking
`argv: string[]` centralises the timeout logic and simultaneously hands every
future handler a general-purpose exec. The constraint above is not a style
preference; it is the entire security value of the option.

**Sequencing.** Build `docker_container_file_content` first as Option A — it
needs no exec at all, so it does not depend on the executor. Build the executor
only when `docker_http_reachable` is approved, and design its recipe registry
then, with both callers in hand.

**Not implemented. Awaiting approval.**
