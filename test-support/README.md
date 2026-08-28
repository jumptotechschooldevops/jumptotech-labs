# Test tiers — UNIT, INTEGRATION, E2E

**PLATFORM-006.** Seven curriculum worktrees share one laptop, one Docker
daemon and one kind cluster. This directory is what stops them corrupting each
other's test results.

## The defect this replaced

`KindLabProvider.create()` runs a real `kubectl version` as a readiness step.
Three suites constructed it with a `FakeKubernetes`, looked hermetic, and fell
through to the host's real kubectl. They passed on a quiet laptop and failed
whenever another worktree ran its own E2E — eight failures during the
PLATFORM-006 audit, with six foreign `jtt-lab-*` sandboxes alive and a load
average of 42.

A test that did not ask for infrastructure must not be able to reach it. Not by
convention — by construction.

---

## UNIT — the default

`<name>.test.ts`

- **No host process.** `node:child_process` **and `node-pty`** are replaced by
  [`host-execution.ts`](./host-execution.ts); `execFile`, `exec`, `spawn`,
  `fork`, their sync forms, and `pty.spawn` all throw `HostExecutionDenied`
  naming the binary and argv. Fail closed: a new escape hatch added tomorrow is
  caught by this. `node-pty` is covered separately because it is a native
  binding rather than a `child_process` wrapper, so it was invisible to the
  original guard.
- **No real Docker, kind, kubectl, or outbound network.** Binding a listener on
  `127.0.0.1` port `0` is permitted and several suites do it: an ephemeral
  loopback port is self-contained, reaches nothing outside the process, and
  cannot collide with another worktree. What is prohibited is depending on
  something this process did not itself create — a fixed port, a remote host, a
  daemon socket.
- **Deterministic and parallel-safe**: nothing shared, nothing ordered.
- **Expensive fixture work happens in `beforeAll`, never inside an `it`.**
  vitest's default `testTimeout` is 5s and it is a budget for the *assertion*,
  not for building what the assertion runs against. A one-time load billed to
  whichever test touched it first is fine on an idle laptop and fails on a busy
  one — which is precisely the flake this rule was written after. Build it in a
  hook, give that hook a hook-sized timeout, and leave `testTimeout` alone: a
  test that is genuinely slow should still fail.
- **Expensive fixtures are shared, and shared fixtures are immutable.** The
  shipped catalog is the one every suite needs and the one nothing may change:
  take it from `realCatalog()`
  (`@jumptotech/lab-orchestrator/testing/real-catalog`), which loads `labs/`
  once per worker process, deep-freezes every definition it hands out, and
  refuses to be reloaded. Never construct `new LabRegistry(LABS_DIR)` in a test.
  A test that needs a catalog it can *change* builds its own temporary copy with
  `labsDirPlus()`, which removes it when that test finishes — so no fixture is
  reachable from any test that did not create it. The shipped disk scan
  (`scanLabsDirectory()`) follows the same rule and is warmed in the same way.
- **Proven per workspace, not assumed.** Every workspace that runs vitest owns a
  `test/host-execution-guard.test.ts` calling
  [`guard-contract.ts`](./guard-contract.ts), so the assertion runs inside that
  workspace's real configuration. `test-classification.test.ts` fails the build
  for a workspace that has no such file, no vitest config, or a config that
  names the setup file only in a comment.

Need a provider that shells out? Inject a fake runner — the seam already exists
on every one of them:

| Provider | Option | Fake |
|---|---|---|
| `KindLabProvider` | `exec` | `fakeExec()` — `test/fakes.ts` |
| `DockerCliClient` | `run` | `FakeDockerEngines` |
| `ContainerRuntime` | `run` | `FakeContainerRuntime` |

```ts
new KindLabProvider({ k8s: new FakeKubernetes(), clusterName: 'x', exec: fakeExec() })
```

## INTEGRATION — real infrastructure, explicitly

`<name>-integration.test.ts`

- **Gated** on `RUN_INTEGRATION_TESTS=1`, `RUN_DOCKER_INTEGRATION_TESTS=1` or
  `RUN_DB_TESTS=1`. `npm test` stays hermetic; an ungated suite is a bug, and
  `test-classification.test.ts` fails the build for it.
- Setting the gate also restores the real `node:child_process`, so an
  integration run behaves exactly as production does.
- **Run-scoped names.** Everything created carries `testRunId()` via
  [`test-run-id.ts`](./test-run-id.ts):
  ```ts
  const name = scopedName('lab', 'foreign');   // jtt-lab-t12345abc-foreign
  await mkdtemp(path.join(tmpdir(), scopedTmpPrefix('it')));
  ```
- **Owned-only cleanup.** Filter by `ownershipFilters()` or check
  `ownedByThisRun()` before deleting. A run must not be *able* to name another
  run's resources, which is what makes concurrent runs safe.

## E2E — mutates infrastructure it cannot isolate

An integration suite that drives the whole stack. Same gate and same run-scoped
naming, plus:

- **Document what it mutates** in the file header.
- **Never delete what it did not create.** The platform already refuses:
  `destroySandbox` checks the `jumptotech.io/managed=true` label, the canonical
  name shape, and the protected-namespace list before removing anything.
- Where isolation is genuinely impossible (one shared kind cluster), say so in
  the header and keep the blast radius to labelled, run-scoped objects.

---

## Running them

```bash
npm test                                   # unit only — hermetic, no daemon needed
RUN_INTEGRATION_TESTS=1 npm run test:integration
RUN_DOCKER_INTEGRATION_TESTS=1 npm run test:integration:docker
RUN_DB_TESTS=1 TEST_DATABASE_URL=... npm run test:db
```

Two worktrees running integration at once is safe **provided** each pins its
own id and its own images:

```bash
JTT_TEST_RUN_ID=cs001 \
LINUX_SANDBOX_IMAGE=jumptotech/lab-linux:cs001-e2e \
TERRAFORM_SANDBOX_IMAGE=jumptotech/lab-terraform:cs001-e2e \
RUN_INTEGRATION_TESTS=1 npm run test:integration
```

Both image variables are required together: `scripts/sandbox-build.sh` always
builds both, so setting only the Linux one overwrites the shared
`jumptotech/lab-terraform:latest`.

## Known limitation

Unit tests are isolated from *infrastructure*, not from *CPU*. A machine
saturated by another worktree's E2E can still push a slow suite past its
timeout, and the guard cannot fix that — which is why it reports a precise
`HOST_EXECUTION_DENIED` instead of an ambiguous timeout.

What that limitation is **not** an explanation for is a suite that was already
spending seconds per test on work it did not need to repeat. This used to read
as "a scheduling problem"; investigating an intermittent timeout in
`lab-catalog.test.ts` and `runtime-owner.test.ts` showed it was mostly ours:
`lab-orchestrator` performed 137 full validations of the shipped catalog per
run, and the requirement schema was a 192-member flat union that made each one
cost 1.3s. Both are fixed — 21 loads at ~0.1s each — and the contention headroom
came with it. Before blaming the machine, measure what the suite is doing.

Reducing the *number* of loads was only half of it. The remaining load per file
was still charged to a test, so it still failed under enough contention; moving
it into a hook is what closed it. The measure of whether this workspace is
healthy is the slowest individual test, and it is now 110ms — the whole suite
survives four simultaneous copies of itself on a ten-core machine with no
timeout. If a new test pushes that number back into the seconds, it is doing
fixture work in the wrong place.
