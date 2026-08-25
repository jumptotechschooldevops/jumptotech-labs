/**
 * The host-execution guard — PLATFORM-006, acceptance criterion 5.
 *
 * The defect this exists to make impossible
 * -----------------------------------------
 * `KindLabProvider.create()` runs a real `kubectl version` as one of its
 * readiness steps. Three suites — `multi-provider-session`, `linux-sessions`
 * and `setup-engine` — construct that provider with a `FakeKubernetes`, and so
 * *looked* like unit tests, but the readiness step fell through to the host's
 * real kubectl against whatever cluster the developer happened to have.
 *
 * That is worse than slow. It means a "unit" test:
 *
 *   · passes or fails according to infrastructure it never asked for,
 *   · fails when a *different worktree* is running its own E2E, which is
 *     exactly what happened during the PLATFORM-006 audit (eight failures,
 *     five foreign `jtt-lab-*` sandboxes alive at the time), and
 *   · could, with a hostile fixture, reach a real cluster or daemon.
 *
 * The guard
 * ---------
 * `node:child_process` is replaced for every test file that loads this setup.
 * Any attempt to start a host process throws `HostExecutionDenied` with a
 * diagnostic naming the binary and the argv. A test that genuinely needs host
 * infrastructure opts in explicitly (see `hostExecutionAllowed`), and only then
 * does the real module come back.
 *
 * **Fail closed is the whole point.** The default is denial: a new escape hatch
 * added tomorrow is caught by this, not by someone noticing a slow suite. It
 * covers every entry point the module offers, not just the one we found —
 * `execFile`, `exec`, `spawn`, `fork`, and their sync forms.
 *
 * This is a test-infrastructure boundary, not production behaviour: nothing
 * here is imported by `src/`.
 */

/** Environment variables that mark a run as legitimately touching the host. */
const OPT_IN_VARS = [
  /** Set by this repo's own integration scripts. */
  'RUN_INTEGRATION_TESTS',
  'RUN_DOCKER_INTEGRATION_TESTS',
  'RUN_DB_TESTS',
  /** Explicit escape hatch, for a suite that opts in without the above. */
  'JTT_ALLOW_HOST_EXECUTION',
] as const;

/**
 * Whether this process may start host processes.
 *
 * Read at call time rather than cached, so a suite can set the flag in a
 * `beforeAll` and a sibling suite in the same run is unaffected.
 */
export function hostExecutionAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return OPT_IN_VARS.some((name) => env[name] === '1');
}

/** Thrown when a test tries to start a host process without opting in. */
export class HostExecutionDenied extends Error {
  readonly code = 'HOST_EXECUTION_DENIED';

  constructor(
    readonly api: string,
    readonly command: string,
    readonly args: readonly string[],
  ) {
    super(
      [
        `Blocked a real host process from a unit test: ${api}(${command}${
          args.length > 0 ? ` ${args.join(' ')}` : ''
        })`,
        '',
        'A unit test must not execute kubectl, docker, kind, or any other host',
        'binary: the result would depend on infrastructure the test never asked',
        'for, and would break whenever another worktree is running its own E2E.',
        '',
        'Fix it one of these ways:',
        '  · inject a fake — most providers take a runner (KindProviderOptions.exec,',
        '    DockerCliOptions.run, ContainerRuntimeOptions.run). `fakeExec()` in',
        '    services/lab-orchestrator/test/fakes.ts is the ready-made one.',
        '  · if this genuinely is an integration test, gate it on',
        '    RUN_INTEGRATION_TESTS=1 and name it *.integration.test.ts, so it is',
        '    skipped by default and isolated when it does run.',
        '',
        'See test-support/README.md for the UNIT / INTEGRATION / E2E contracts.',
      ].join('\n'),
    );
    this.name = 'HostExecutionDenied';
  }
}

/** Normalise the many child_process signatures down to (command, args). */
function describeCall(api: string, callArgs: unknown[]): HostExecutionDenied {
  const command = typeof callArgs[0] === 'string' ? callArgs[0] : String(callArgs[0]);
  const args = Array.isArray(callArgs[1]) ? (callArgs[1] as unknown[]).map(String) : [];
  return new HostExecutionDenied(api, command, args);
}

/**
 * Build the replacement `node:child_process` namespace.
 *
 * When execution is allowed the real module is handed back untouched, so an
 * integration run behaves exactly as it does in production.
 */
export function guardChildProcess<T extends Record<string, unknown>>(
  actual: T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  if (hostExecutionAllowed(env)) return actual;

  const denied = ['execFile', 'exec', 'spawn', 'fork', 'execFileSync', 'execSync', 'spawnSync'];
  const patched: Record<string, unknown> = { ...actual };
  for (const api of denied) {
    if (!(api in actual)) continue;
    patched[api] = (...callArgs: unknown[]) => {
      throw describeCall(api, callArgs);
    };
  }
  return patched as T;
}
