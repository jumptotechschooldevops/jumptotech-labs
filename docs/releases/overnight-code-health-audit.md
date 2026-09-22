# Overnight code-health audit

| | |
|---|---|
| STARTING COMMIT | `24e09f132d522b8de713e696bd0a682f3be74d93` (origin/main) |
| BRANCH | `feat/overnight-code-health` (local only: not pushed, not merged, no PR) |
| AUDIT DATE | 2026-09-21 → 2026-09-22 |
| SCOPE | Type safety, boundaries, error contracts, async and resource ownership, dead code, duplication, state machines, database contracts, tests and mocks, packages, environment, logging and filesystem. This audit did not repeat the reliability, curriculum or commercial work the other agents own. |

Every fix below has a regression test that failed for the intended reason before the fix. Where a test could not be made to fail by construction, it was mutation-checked instead: the code was broken on purpose and the test failed. Findings I could not prove, or that belong to another agent's scope, are recorded but not changed.

---

## Architecture map

```
                      apps/web  (React; no workspace imports: its own copy of the HTTP + WS contract)
                         │  HTTP /api/*  ·  WS /terminal
            ┌────────────┴─────────────┐
       apps/api (express)       services/terminal (ws + node-pty or broker client)
   │ │ │ │                         │  │   POST /internal/sessions/:id/credentials → api
   │ │ │ └─ @jumptotech/verifier ──┤  └── HTTPS → services/sandboxd (runtime + docker + attach broker)
   │ │ └─── @jumptotech/progress (pg; leaf)
   │ └───── @jumptotech/lab-orchestrator ◄── verifier, terminal, sandboxd
   └─────── @jumptotech/observability (leaf: logger, metrics, env/secret policy)
                         ◄── api, orchestrator, terminal, sandboxd
test-support (host-execution guard, strict-vitest): devDependency only; production code never imports it.
scripts/ (tsx operational tools): typechecked by `tsc -p scripts`
```

Dependencies point one way: `observability` and `progress` are leaves, `lab-orchestrator` depends on `observability`, and every service depends on the orchestrator. `web` is standalone.

**Contracts that cross a service boundary**

| Contract | Producer → consumer | How it is kept in step |
|---|---|---|
| REST envelope, `SessionStatus`, error codes | api → web | Hand-copied types in `web/src/lib/types.ts`. Checked by the contracts agent: no drift found in status, error-code or type unions. |
| Terminal WS frames and close codes | terminal → web | Hand-copied. They match. |
| Terminal context (kubeconfig, container-exec, docker-daemon) | api `/internal` → terminal | Checked field by field in `credentials.ts`. |
| Runtime and Docker broker ops | orchestrator `BrokerRuntime` / `BrokerEngines` → sandboxd | Envelope `{ok,data,error{code}}`, cast rather than validated. See the residual risks. |
| Session rows | orchestrator stores ↔ `progress` migrations (same PostgreSQL) | CHECK constraint, `SESSION_STATUSES` and the web union all list the same 9 statuses. |

**The same concept implemented more than once (divergence found and fixed):**
- **Environment parsing:** 5 copies of `intFromEnv` and 4 of `boolFromEnv`.
- **`NODE_ENV=production` detection:** 8 sites, some comparing trimmed values and some exact.
- **The "absent vs. could not ask" rule for `docker inspect` and `stat`:** 4 implementations; 2 were correct, 2 were not.

---

## Fixed defects

### 1. The reaper tore down a lab that had just finished starting (HIGH, state machine)
- **Invariant:** the reaper only claims the state it judged.
- **Evidence:** a sweep reads CREATING at over 10 minutes old, spends minutes on earlier teardowns, and meanwhile the start reaches ACTIVE. `expire()` claims any live status, so the working lab was torn down and recorded EXPIRED "did not finish starting". The idle path was already fenced; this path was not.
- **Root cause:** the claim at `reaper.ts` "abandoned start" had no `TransitionGuard`.
- **Regression test:** `session-recovery.test.ts` › "a start that finishes while the sweep is busy elsewhere…". It runs in-memory, and against PostgreSQL through `session-store-integration`.
- **Fix:** fence the claim on the `statusChangedAt` the sweep read.
- **Commit:** `af3f6a3`

### 2. An unreadable container sandbox made Check answer 500 (HIGH, error contract)
- **Invariant:** an environment that cannot be read is reported as `ENVIRONMENT_UNREACHABLE` with its checks skipped. It is never a 500 and never a failed check.
- **Evidence:** `verifyLab` recognised only the Kubernetes, Docker-track and workspace errors. The verifier's own `SandboxUnreachableError` (when `ps`, `ss` or `ip neigh` could not run), `ContainerRuntimeError` (broker) and the Ansible unreachable error all escaped, so the route answered 500 `INTERNAL_ERROR`, reported no skipped checks, and `jtt_verification_errors_total` did not move.
- **Regression test:** `verifier/test/sandbox-unreachable.test.ts`. Two existing tests pinned the escaping throw while stating the intent "reported as an environment fault"; they now assert that reported form.
- **Commit:** `5f8bca6`

### 3. A failed `docker inspect` read as "container does not exist" (HIGH, error contract)
- **Invariant:** `null` from `inspect` means absent; failing to ask is an error.
- **Evidence:** with the daemon down or an inspect timed out, `destroySandbox` returned `ok, namespaceGone, "already absent"`. End freed the slot while the container kept running. `status()` said `not_created`, and sandboxd answered 404 SANDBOX_NOT_FOUND. The fake runtime threw, so every unit test assumed the correct behaviour (a mock-fidelity gap).
- **Regression test:** `container-runtime-inspect.test.ts` (9 tests, including teardown during an outage).
- **Fix:** only the daemon's "No such …" means absent. A timeout or any other failure throws `ContainerRuntimeError`. This is the rule sandboxd's inspector and the CLI client already followed.
- **Commit:** `c1da591`

### 4. `path_absent` passed without anything being deleted (HIGH, error contract, student-triggerable)
- **Invariant:** only `stat`'s own ENOENT or ENOTDIR means absent.
- **Evidence:** `readSandboxPath` returned `null` for any failed `stat`, so an unsearchable parent directory (`chmod 000`), a stopped container or a 10 s timeout all passed `path_absent`. Ten labs use that check. Separately, `listSandboxFiles` returned `[]` for any failed `find`, throwing away every file found when one subdirectory was unreadable.
- **Regression test:** `container-provider.test.ts` › "a stat or find that could not answer" (7 tests).
- **Fix:** anything else throws `ContainerRuntimeError`, which fix 2 reports as `ENVIRONMENT_UNREACHABLE`. A `find` whose only failures are its own diagnostics keeps what it found.
- **Commit:** `08ba5b0`

### 5. The same false "absent" in the Ansible sandbox (MEDIUM, error contract)
- **Evidence:** `managed_file_exists state: absent` passed on a stopped managed node or a `stat` that timed out.
- **Regression test:** `ansible-sandbox-stat.test.ts`
- **Commit:** `bc65eb7`

### 6. Unbounded metric label from anonymous traffic (HIGH, resource and observability)
- **Invariant:** metric labels come from closed sets.
- **Evidence:** `jtt_authz_decisions_total{action}` used the request line (`GET /api/sessions/<anything>`) for every refused credential. Each distinct path created a permanent series in the api's heap and in Prometheus.
- **Regression test:** `authz-metric-labels.test.ts`
- **Fix:** the label is `authenticate` for unauthenticated requests, and the closed `Action` otherwise. The log line keeps the request line. No alert or dashboard reads `action`.
- **Commit:** `db443e8`

### 7. Integer environment variables accepted units (MEDIUM, environment contract)
- **Invariant:** "must be a positive integer" means only digits are accepted.
- **Evidence:** `parseInt` read `MAX_SESSION_MINUTES=2h` as 2, `TERMINAL_MAX_SESSION_SECONDS=2h` as a 2-second shell, `MAX_ACTIVE_SESSIONS=1e3` as 1, and `DATABASE_STATEMENT_TIMEOUT_MS=10s` as 10 ms. The same bug existed in all 5 copies.
- **Regression test:** `config-integers.test.ts` in api, terminal, sandboxd, observability and progress.
- **Fix:** all 5 copies accept digits only. No shipped compose or env file used a suffixed value.
- **Commit:** `12628f8`

### 8. Lenient booleans in 3 services (MEDIUM, security-adjacent, environment contract)
- **Evidence:**
  - `TERMINAL_SANDBOX_BROKER_ENABLED=ture` silently fell back to local `docker exec`, the privilege the broker exists to remove.
  - `TERMINAL_CONTAINER_EXEC_ENABLED=flase` left that local path on.
  - `DOCKER_SANDBOX_PRIVILEGED=ture` broke every Docker-track start.
- **Regression test:** `config-booleans.test.ts` in terminal, sandboxd and observability. The existing api test still passes.
- **Fix:** one strict `boolFromEnv`, exported from `@jumptotech/observability`, replaces the 4 copies. Every shipped value is a recognised word.
- **Commit:** `6e37851`

### 9. A failed Docker-track create leaked the DinD data volume (MEDIUM, resource ownership)
- **Evidence:** `createSandbox` creates `<ref>-data`, then runs the container. If the run failed, nothing could remove the volume: the destroy finds no container, `removeSandbox` returns before its volume step, and the broker's `removeVolume` is a no-op. Each leaked volume holds a whole inner daemon's image store.
- **Regression test:** `docker-ops.test.ts` › "a create whose daemon container cannot be started"
- **Fix:** the create removes the volume it made, then reports the failure.
- **Commit:** `dd1389f`

### 10. Two tests that could not fail (MEDIUM, test quality)
- **`log-redaction` "never emits a stack trace":** its request answered 404 and logged no `err`, so the conditional expect never ran. It now drives a real 500 and requires an `err` line. A mutation check confirmed it fails when the serializer emits a stack.
- **`authentication` "AUTH_REQUIRED for a missing header":** its only assertion was inside a `catch`, so it passed even if nothing threw. It now asserts the throw directly.
- **Commit:** `7bf89f5`

### 11. `TASK_BINARY_ALLOWLIST` was documented as a gate but enforced nowhere (MEDIUM, defence in depth)
- **Evidence:** nothing read the allow-list. The CI/CD provider's inspection allow-list is derived from the task table itself, so a careless table edit naming a shell would have been allowed there too.
- **Regression test:** `cicd-provider.test.ts`
- **Fix:** the table is checked against the allow-list when the module loads.
- **Commit:** `1f84320`

### 12. The container fake never produced `regular empty file` (MEDIUM, mock fidelity)
- **Evidence:** GNU `stat %F` spells empty files as `regular empty file`, but the fake always printed `regular file`. Deleting the provider's mapping for the empty spelling (which would make every empty file read as `other` in production) left every test green.
- **Regression test:** a provider test, mutation-checked.
- **Commit:** `0fc2baf`

### 13. The PTY flow-control contract could drift silently (MEDIUM, mock fidelity)
- **Evidence:** `BrokerPty.pause`, `resume` and `pendingInputBytes` were optional "so a test double need not implement them". Removing them from `defaultSpawn`, the only real PTY, would drop both backlog bounds on the production terminal path and still compile and pass.
- **Fix:** the three methods are required. The compiler then listed 7 test doubles that were missing them, and all 7 now implement them.
- **Commit:** `d23f3fc`

### 14. A stale session-list read undid a launch or an End (MEDIUM, async, web)
- **Evidence:** `refresh()` was guarded only against newer refreshes. A read that was in flight when a launch finished landed afterwards:
  - the new lab disappeared from other pages, which then offered Launch and were refused;
  - its terminal grant was deleted;
  - an End could be undone the same way.
- **Regression test:** `active-session-races.test.tsx`. It fails without the fix.
- **Fix:** a read that crossed a change is read again, not applied.
- **Commit:** `ce64770`

### 15. A session re-check answered before sign-out could undo it (LOW, async, web)
- **Regression test:** `auth.test.tsx` › "is not undone by a session check that was answered before it"
- **Commit:** `7821afa`

### 16. Package hygiene (LOW, package boundary)
- `@jumptotech/observability` exported `./testing` pointing at a file that has never existed.
- The `start` scripts used the tsx CLI, which the images avoid because it swallows SIGTERM. They now run `node --import tsx`, as the images do.
- No lockfile change.
- **Commit:** `0abfd8e`

### 17. `NODE_ENV=production` meant different things to different gates (LOW-MEDIUM, environment contract)
- **Evidence:** under `NODE_ENV="production "` (trailing space), the secret and TLS gates treated the deployment as production, while:
  - the runtime owner fell back to the development default instead of refusing to start;
  - a localhost public origin was accepted;
  - `AUTH_MODE=development` was allowed;
  - the development student header defaulted to on.
- **Regression test:** `node-env-production.test.ts` in the orchestrator and in api.
- **Commit:** `902ee11`

### 18. The operator socket could crash the api (MEDIUM, async and resource)
- **Evidence:** only a one-shot `'error'` listener was installed, for the listen. A running server's second error (for example `accept` EMFILE) was an unhandled `'error'` event that ended the api.
- **Regression test:** `operator-socket.test.ts`
- **Commit:** `087bc9a`

### 19. A half-written Docker credential directory was left on disk (LOW, filesystem)
- **Evidence:** the writer threw before returning the directory path, so the caller's cleanup could not find it. CA, client certificate and possibly part of the key stayed behind.
- **Regression test:** `credentials-partial-write.test.ts`
- **Commit:** `e2f4354`

---

## Findings by area

Items marked **(fixed n)** refer to the list above. Everything else was proven or read but deliberately not changed; the reason is given.

**Type safety.** `as any`, `@ts-ignore` and blind JSON casts in production code are nearly all harmless: signed payloads are shape-checked after verification, and pg int8 has a type parser. The type bypasses that did matter were the broker envelopes (see the residual risks).

**Boundary validation.** Fixed 2, 3, 4, 5. Also open:
- `broker-runtime.ts` and `broker-engines.ts` cast `response.json()` to an envelope. A JSON `null` body throws a raw TypeError, and `ok:true` with a missing field reads as "image missing" or "not found".
- `terminal/shell.ts` reports an `exit` frame with a non-numeric code as exit 0.

**Error contracts.** Fixed 2, 3, 4, 5. Still open:
- A broker `DOCKER_OPERATION_FAILED` or `SANDBOX_NOT_FOUND` becomes a plain `Error`. `docker_file` checks then show a student failure containing the broker's text, where a 503 would be correct. The right class for "operation failed" is a judgement call.
- A lost broker socket is reported to the browser as "shell exited (code 0)", with no automatic reconnect. This is the reliability agent's area.
- A `/check` with no bound attempt and a store failure look the same to the web.

**Async.** Fixed 14, 15, 18. Floating `void` chains in the terminal and sandboxd have no reachable rejection today. No service installs an `unhandledRejection` handler, so the first one to appear would crash the process.

**Resource ownership.** Fixed 9, 18, 19. Still open:
- A local-PTY End sends SIGHUP to the shell leader only, so `nohup` and `setsid` children survive.
- An exec timeout kills the docker CLI, not the process inside the container.
- Shutdown discards the stop handles of the runtime collectors.

**Dead code.** Documented, not removed:
- `requireAction` and `canStartLabs` (api policy).
- `isSandboxObjectName`, whose doc wrongly claims it is "the first gate before any delete".
- `isSandboxId`, `resolveManifestPath`, `trackTagline`, `requirementSubject`, `isLinuxRequirementType`, `isDockerTerminalContext`, `isClosedAttempt`, `isDockerRequirement`, `formatCountdown` and `SESSION_ID_HEADER`.
- `listExpirable` and `createWithinCapacity` in both session stores.
- Unused subpath exports: `@jumptotech/progress/postgres`, and sandboxd's `.` (its entrypoint, which starts listeners on import), `./inspector`, `./protocol` and `./docker-ops`.

Each has zero references, but removing them is churn without a defect. The sandboxd `.` export is the one worth removing next.

**Duplicated contracts.** Fixed 7, 8, 17, 3/4 (rules converged). Still duplicated: the same `SESSION_ID` shape in `operator.ts`. That is harmless, because the id is re-validated.

**State machines.** Fixed 1. The 9 statuses match across the DB CHECK constraint, the orchestrator and the web, and every status write goes through `transition`. Still open:
- The absolute deadline is enforced only by the serial reaper, so a backlog keeps expired labs usable.
- The web cannot End a CREATING or RESETTING lab, although the API can.
- DEGRADED sessions get no idle warning.
- A resumed EXPIRING teardown is labelled `idle` in the metrics.

**Database contracts.** Proven but not changed: `AbandonedAttemptSweeper` closes attempts older than the *current* `MAX_SESSION_MINUTES` plus 5 minutes. Its comment still assumes sessions live in memory, but since P0-007 they persist in PostgreSQL. After a config reduction, or a reaper backlog longer than 5 minutes, it marks live attempts EXPIRED; a later pass flips them to PASSED, and End cannot record ENDED.

I did not "fix" this by refusing PASSED on non-IN_PROGRESS attempts, because that would throw away real completions. The right fix is for the sweeper to skip attempts whose session still occupies a slot.

The in-memory and PostgreSQL stores differ in small ways: `findBySandboxRef` also matches the namespace in memory, and memory `update` can patch `labId` and `createdAt`. No live caller depends on either.

**Test quality.** Fixed 10. Two conditional `if` expects (`sandbox-privilege`, `container-provider`) are true for today's data. `line-value.test.ts` › "first separator on an unanchored line" once exceeded 5 s under the parallel load of the full run; it passes in isolation and on the baseline, so it is a load flake.

**Mock fidelity.** Fixed 3 (the fake was the correct spec; the real code was wrong), 12, 13. Still open:
- The Docker fake models a missing sandbox as unreachable, which neither real factory does.
- The Docker fake's remove operations always succeed, while the real ones swallow "in use".
- `FakeKubernetes.getEndpoints` ignores selectors.
- `FakeSandbox.read` ignores `maxBytes`, which hides the provider's 64 KiB clamp against the verifier's 256 KiB config read. `#scanConfig` does not check `truncated`; that belongs to the verifier agent.
- The web `apiMock` is untyped. Typing it shows payload drift in test fixtures only (`displayName` does not exist, and `student` is missing).

**Test isolation.** No cross-file leaks: vitest isolates each file, and every `useFakeTimers` is paired with a restore. Within a file:
- `urls.test.ts` never unstubs its env and globals.
- Two tests leave a `Storage.prototype` spy in place.
- `progress/migrations.test.ts` leaves three `mkdtemp` directories behind.

**Package boundaries.** Fixed 16. Still open:
- 16 orchestrator test files import `@jumptotech/verifier` and one imports `@jumptotech/progress`, none declared. That is a hidden test-time cycle, since verifier depends on the orchestrator.
- `observability` type-imports express without declaring `@types/express`.
- `@jumptotech/test-support` is undeclared in 6 workspaces.

All of these resolve through hoisting. They were left alone because fixing them changes the lockfile.

**Dependencies.** Runtime imports are all declared in `dependencies`, and the images install with `--omit=dev`. `@jumptotech/verifier` is an unused devDependency of the terminal. No version changes were made.

**Environment contracts.** Fixed 7, 8, 17. Still open:
- `*_SECONDS × 1000` values of 2,147,484 or more overflow `setTimeout` (the timer fires after about 1 ms).
- `API_INTERNAL_URL` and `TERMINAL_CONTROL_URL` have no production transport gate.
- `TERMINAL_MAX_SESSIONS=16` against `MAX_ACTIVE_SESSIONS=20` in the default compose: already known as DR-02, and caught only by `production:config-check`.

**Logging.** Error serialization is centralized, stack-free and redacted (now actually proven: fix 10). No secrets, commands or student output were found in log calls. Fix 6 addressed unbounded label cardinality.

**Filesystem.** Fixed 4, 19. Workspace writes use `O_NOFOLLOW` handles (from earlier work). Nothing sweeps the terminal credentials directory at startup.

**Time correctness.** Expiry comparisons use `<=` consistently, PostgreSQL timestamps are normalized to millisecond ISO strings, and token `exp` is in seconds on both sides. No unit mismatches were found apart from the overflow noted above.

---

## Safe validation performed

Node v22.23.2. Run on this Mac with other agents active. No Docker, kind, cluster, database or fixed port was started.

| Check | Result |
|---|---|
| `npm ci` | 355 packages from the lockfile (lockfile unchanged) |
| `npm run typecheck` (every workspace plus `tsc -p scripts`) | exit 0 |
| `npm run build` | exit 0 (vite; `apps/web/dist` is gitignored) |
| `npm test`, baseline at `24e09f1` | **5,576 passed, 336 skipped, 0 failed** |
| `npm test`, final at HEAD | **5,648 passed, 336 skipped, 0 failed** (+72 tests) |
| `npm run test:security`, final | **889 passed, 0 failed**: api 265, terminal 116, sandboxd 85, orchestrator 208, verifier 8, observability 197, web 10 |
| `git diff --check` | clean before every commit |

Final `npm test` by workspace (passed / skipped):

| Workspace | Passed | Skipped |
|---|---|---|
| api | 707 | 15 |
| web | 268 | 0 |
| lab-orchestrator | 1,418 | 253 |
| observability | 949 | 38 |
| progress | 100 | 1 |
| sandboxd | 167 | 7 |
| terminal | 204 | 22 |
| verifier | 1,835 | 0 |

The 336 skips are the environment-gated integration suites and are the same as the baseline.

One flake appeared during development: `verifier/test/line-value.test.ts` timed out at 5.8 s once while the machine was under load. It passed alone and in both full runs.

**Not run**, deliberately: every `RUN_INTEGRATION_TESTS`, `RUN_DOCKER_INTEGRATION_TESTS` and `RUN_DB_TESTS` suite, including `test:db`, the kind/k8s suites, `e2e` and `beta:validate`. These need shared Docker, kind or PostgreSQL, which the concurrency rules forbid. The default `npm test` skips them by construction, because the host-execution guard fails any unit test that starts a host process. The session-recovery regression (fix 1) is shared with the PostgreSQL suite and should be run there with `make test-db` before merge.

## Known residual risks

1. The capacity checks in sandboxd (`server.ts:572`) and the terminal (`server.ts:721`) run before an `await` and are registered after it, so concurrent attaches exceed `maxSessions`. This was proven by the async agent, but it is concurrency work and was left to the reliability agent.
2. Broker envelope casts and the mapping of broker error codes (see "Error contracts").
3. The attempt sweeper's cutoff (see "Database contracts").
4. The absolute session deadline is enforced only by the serial reaper.
5. `setTimeout` overflow from very large `*_SECONDS` values.
6. The main servers have no runtime `'error'` listener, so an EMFILE on accept ends the process. That may be the intended fail-fast behaviour under a restart policy; decide explicitly.

## Recommendations not implemented

- Make `AbandonedAttemptSweeper` skip attempts whose session still occupies a slot, and delete its stale "sessions are in memory" premise.
- Reject requests past `expiresAt` in `requireActive` and `getTerminalContext`, so the reaper is not the only enforcement.
- Validate the broker envelopes (`ok`, then the expected field) and map broker 404 and 5xx codes to the provider's error classes.
- Have the terminal report a lost broker socket as a transport error (1011), not as `exit 0`.
- Add an upper bound to `intFromEnv`, or bound each timer at the point of use.
- Declare the hoisted devDependencies in one lockfile-touching change, and remove sandboxd's `.` export.
- Enable `unstubEnvs`, `unstubGlobals` and `restoreMocks` in the vitest configs.
- Add a startup cross-check that `TERMINAL_MAX_SESSIONS` is at least `MAX_ACTIVE_SESSIONS`.
