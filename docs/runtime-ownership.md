# Runtime ownership and concurrent isolation

**PLATFORM-006 / PLATFORM-007.** How the platform decides that a resource is
safe to delete, and what still needs human coordination.

## The problem this exists for

Seven curriculum worktrees develop in parallel against **one Docker daemon and
one kind cluster**. Their sandboxes are indistinguishable by inspection: same
image, same name shape, same labels, all genuinely JumpToTech-managed. Without
an ownership rule, one worktree's cleanup removes another's running lab — and
afterwards that looks like flakiness, not like a bug.

At the time of writing the daemon carried five foreign sandboxes from three
worktrees, two of them orphaned `Exited (255)` containers from a crashed run.
This is the normal state, not an unusual one.

## The ownership model

Four questions, asked in order, before anything is destroyed. **A name is never
one of them.**

| Question | Label | Answered by |
|---|---|---|
| Is it ours at all? | `jumptotech.io/managed=true` | the platform, at creation |
| Which substrate? | `jumptotech.io/provider` | the provider that created it |
| **Which running platform?** | `jumptotech.io/runtime-owner` | the deployment or test process |
| Which student? | `jumptotech.io/session-id` | the session manager |

Plus `jumptotech.io/lab-id` and `jumptotech.io/expires-at`, which describe the
resource rather than authorise action on it.

### Why `runtime-owner` is separate from `session-id`

Orphan reclamation calls `destroySandbox` with **no session** — an orphan is by
definition a sandbox the store has no record of, so there is no session to name.
That leaves `managed` and `provider` to authorise the delete, and two worktrees
running the same provider match on both. `runtime-owner` is the discriminator
that survives when the session is unknown.

Production is a single runtime and never sets `RUNTIME_OWNER_ID`; every resource
it creates and finds carries the same default, so the check is invisible there.

### Fail-closed, with one deliberate exception

A resource whose owner is **present and different** is always refused. A
resource with **no owner label** is treated as this runtime's — that is exactly
the behaviour before the label existed, and it keeps an upgrade from stranding
running sandboxes as undeletable. Malformed metadata is never guessed at: an
unparseable `expires-at` reads as `0`, which the reaper refuses to act on rather
than treating as "long expired".

### Ownership metadata is platform-controlled

Every label is stamped by the orchestrator at creation. A student never sets
one. In a Docker lab the student holds `DOCKER_HOST` for the **nested** daemon
inside their own sandbox, while every ownership decision is made against the
**host** daemon — so a student may label their containers anything at all and
remain invisible to the platform. Student-supplied values are never used to
select a resource for deletion.

## Cleanup boundaries

| Operation | Scope | Session named? |
|---|---|---|
| **Reset** | this session's sandbox; destroys and recreates it | yes |
| **End / destroy** | this session's sandbox | yes |
| **Reaper** | expired or orphaned sandboxes of this provider **and this runtime owner** | no — hence `runtime-owner` |

Global enumeration exists for diagnostics. Destructive operations are always
ownership-scoped. There is no prefix sweep anywhere in the platform: nothing
matches `jtt-*` and deletes it.

## Image-tag policy

`jumptotech/lab-linux:latest` and `jumptotech/lab-terraform:latest` are
**operator-controlled build artifacts**, produced only by `npm run
sandbox:build` from the canonical Dockerfiles. They are what a normal
deployment runs.

Tests and E2E must not overwrite them while sibling worktrees are active. Use a
private tag and override both variables — `scripts/sandbox-build.sh` always
builds both images, so setting only the Linux one silently rewrites
`lab-terraform:latest`:

```bash
LINUX_SANDBOX_IMAGE=jumptotech/lab-linux:<suffix>-e2e \
TERRAFORM_SANDBOX_IMAGE=jumptotech/lab-terraform:<suffix>-e2e \
npm run sandbox:build
```

## Test isolation

Unit tests reach no host process at all (PLATFORM-006's guard). Tests that need
real resources take their own runtime owner and run-scoped names:

```bash
RUNTIME_OWNER_ID=wt-docker RUN_INTEGRATION_TESTS=1 npm run test:integration
```

## What is verified, and how

| Property | Level |
|---|---|
| Ownership gate refuses unmanaged / lookalike / other provider / other owner / other session | **UNIT** |
| Reaper preserves active, unmanaged, foreign-owner, no-expiry, malformed-expiry | **UNIT** |
| Idempotent sweep; vanished-container recovery; discovery/delete race | **UNIT** |
| Two owners x two sessions coexist; no cross-owner mutation | **UNIT** |
| Students cannot forge ownership metadata | **UNIT** |
| Reset / destroy / discovery against a real Docker daemon | **INTEGRATION** |
| Cross-provider, cross-owner and unmanaged refusal on a real daemon | **INTEGRATION** |
| Two full worktree E2E runs concurrently, end to end | **NOT YET TESTED** |

## Known limitations

**One Docker daemon.** Ownership stops runs from *corrupting* each other. It
does not stop them competing for CPU, memory and image pulls — a saturated
daemon still makes suites slow and time out. That is scheduling, not ownership.

**One kind cluster - not solved.** `LAB_CLUSTER_NAME` parameterises the cluster
name, but `scripts/cluster-up.sh` writes to fixed kubeconfig paths, so two
clusters clobber each other's credentials. Per-session namespaces remain
isolated and no test deletes a namespace it does not own, but **cluster
lifecycle is uncoordinated**: `npm run cluster:down` in one worktree destroys
the cluster every other worktree is using. Creating a kind cluster per unit test
is not the answer - it costs minutes and gigabytes. This is deferred as
**PLATFORM-007b**, and it is a real gap, not a solved one.

**Compose stacks still collide.** `docker-compose.yml` fixes the project name,
four `container_name` values, the network and the volume, so two stacks cannot
run at once. Also PLATFORM-007b.
