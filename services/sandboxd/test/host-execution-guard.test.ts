/**
 * PLATFORM-006 — the host-execution guard, installed for sandboxd.
 *
 * Why this suite exists at all
 * ---------------------------
 * Every other workspace loaded the guard through its `vitest.config.ts`.
 * `services/sandboxd` had no config file, so it had no `setupFiles`, so its
 * suite ran with the real `node:child_process` — for two months, silently. The
 * only visible symptom was `setup 0ms` in the run summary where every other
 * workspace reported 14–126ms, which is not something anybody reads.
 *
 * That gap mattered more here than it would anywhere else. sandboxd is the one
 * process in the platform holding the Docker socket, and
 * `DockerSandboxInspector.#run()` in `src/inspector.ts` really does
 * `execFile('docker', …)`. A unit test that constructed the real inspector
 * instead of a fake port would have driven the developer's own daemon, and
 * passed or failed according to which containers happened to be alive.
 *
 * What is actually asserted
 * -------------------------
 * That the guard is **installed in this process**, not that it exists. Calling
 * `guardChildProcess()` directly proves only that a pure function works — it
 * would pass just as happily with no `vitest.config.ts` at all, which is the
 * exact state this suite was written to make impossible. So these tests call
 * the bindings imported from `node:child_process` and require them to throw.
 *
 * Delete `services/sandboxd/vitest.config.ts` and this file fails. That is the
 * point: the guard can no longer disappear quietly.
 *
 * The probe binary does not exist, deliberately. The guard is supposed to
 * intercept the call before anything is spawned, so the name is never resolved
 * — and if the guard is ever missing, the assertions fail without having
 * touched the daemon, the filesystem or the network. Proving the boundary must
 * not require crossing it.
 */
import { describe, expect, it } from 'vitest';
import {
  exec,
  execFile,
  execFileSync,
  execSync,
  fork,
  spawn,
  spawnSync,
} from 'node:child_process';
import {
  HostExecutionDenied,
  guardChildProcess,
  hostExecutionAllowed,
} from '@jumptotech/test-support/host-execution';

/**
 * A name that is not on the PATH and never will be. See the header: the guard
 * short-circuits before resolution, so this is inert either way.
 */
const PROBE = 'jtt-guard-probe-should-never-execute';

/**
 * An integration run legitimately restores the real module, so the blocking
 * assertions only make sense when nothing has opted in. Under `npm test` — the
 * CI gate, and the run this suite is protecting — this is always false, so the
 * assertions below always execute there.
 *
 * `test:integration:sandboxd` targets `sandboxd-integration.test.ts` by name
 * and never collects this file, so in practice the opt-in path is only reached
 * by someone running the whole workspace with a gate variable exported.
 */
const optedIn = hostExecutionAllowed();

describe('the host-execution guard is installed for the sandboxd suite', () => {
  it.runIf(!optedIn)('denies a real host process, naming the binary and argv', () => {
    expect(() =>
      (execFile as unknown as (c: string, a: string[]) => void)(PROBE, ['version']),
    ).toThrow(HostExecutionDenied);

    try {
      (execFile as unknown as (c: string, a: string[]) => void)(PROBE, ['version']);
      expect.unreachable('execFile resolved instead of being denied');
    } catch (error) {
      const denied = error as HostExecutionDenied;
      expect(denied.code).toBe('HOST_EXECUTION_DENIED');
      expect(denied.command).toBe(PROBE);
      expect(denied.args).toEqual(['version']);
    }
  });

  it.runIf(!optedIn)('denies every process-starting entry point, not just execFile', () => {
    // Fail closed across the whole module surface. sandboxd reaches the daemon
    // through `execFile` today, but the next escape hatch has to be caught by
    // this rather than by someone noticing a suite got slower.
    const entryPoints: Array<[string, (...a: never[]) => unknown]> = [
      ['execFile', execFile],
      ['exec', exec],
      ['spawn', spawn],
      ['fork', fork],
      ['execFileSync', execFileSync],
      ['execSync', execSync],
      ['spawnSync', spawnSync],
    ];

    for (const [name, fn] of entryPoints) {
      expect(() => (fn as (c: string) => unknown)(PROBE), name).toThrow(HostExecutionDenied);
    }
  });

  it.runIf(!optedIn)('blocks the shape of call sandboxd itself makes', () => {
    // `DockerSandboxInspector.#run()` is `execFile(binary, argv, { shell: false })`.
    // A unit test that built the real inspector would land exactly here, and
    // the daemon it would have reached is the host's.
    expect(() =>
      (execFile as unknown as (c: string, a: string[], o: object) => void)(
        PROBE,
        ['inspect', '--format', '{{.State.Status}}', 'jtt-lab-deadbeef'],
        { shell: false },
      ),
    ).toThrow(HostExecutionDenied);
  });
});

describe('the opt-in that an integration run uses', () => {
  // Pure-function checks: safe to run either way, and they pin the contract
  // this suite's `runIf` conditions depend on.
  it('denies by default and unlocks only on an exact "1"', () => {
    expect(hostExecutionAllowed({})).toBe(false);
    expect(hostExecutionAllowed({ RUN_INTEGRATION_TESTS: '1' })).toBe(true);
    expect(hostExecutionAllowed({ JTT_ALLOW_HOST_EXECUTION: '1' })).toBe(true);
    // A stray `RUN_INTEGRATION_TESTS=false` must not unlock the host.
    expect(hostExecutionAllowed({ RUN_INTEGRATION_TESTS: 'false' })).toBe(false);
  });

  it('hands back the real module untouched when allowed', () => {
    const actual = { execFile: () => 'real', spawn: () => 'real' };
    expect(guardChildProcess(actual, { RUN_INTEGRATION_TESTS: '1' })).toBe(actual);
  });
});
