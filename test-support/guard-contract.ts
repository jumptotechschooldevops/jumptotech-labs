/**
 * The runtime proof that the host-execution guard is installed — PLATFORM-006.
 *
 * Why this is a shared function rather than a checklist item
 * ---------------------------------------------------------
 * `services/sandboxd` shipped for two months with no `vitest.config.ts`, so no
 * `setupFiles`, so no guard. Nothing failed, because nothing asked. The lesson
 * was not "remember to add the config" — it was that *presence* of a config
 * line is not the property worth asserting. A config can name the setup file in
 * a comment. A `setupFiles` entry can point at a path that no longer resolves.
 * Both read as correct and neither installs anything.
 *
 * So the property asserted here is the runtime one: **the bindings this process
 * imported from `node:child_process` and `node-pty` refuse to start a process**.
 * That can only be true if the setup file actually loaded and its mocks
 * actually took effect, which is the whole of what the guard is.
 *
 * Every workspace that runs vitest calls this from its own
 * `test/host-execution-guard.test.ts`, so the assertion runs inside that
 * workspace's real configuration rather than being inferred from outside it.
 * `test-classification.test.ts` fails the build for a workspace that has no
 * such file.
 *
 * Nothing here can touch the host, even when it fails. The probe binary does
 * not exist and the guard short-circuits before the name is ever resolved, so
 * proving the boundary never requires crossing it.
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
import { HostExecutionDenied, hostExecutionAllowed } from './host-execution.js';

/** Not on the PATH, and never will be. See the header. */
const PROBE = 'jtt-guard-probe-should-never-execute';

/**
 * Register the guard contract for the calling workspace.
 *
 * @param workspace Name used in the suite title, so a failure in a repository-wide
 *                  run says which workspace lost its guard.
 */
export function hostExecutionGuardContract(workspace: string): void {
  // An integration run legitimately restores the real modules, so the blocking
  // assertions only mean anything when nothing has opted in. Under `npm test` —
  // the CI gate, and the run this contract protects — this is always false.
  const optedIn = hostExecutionAllowed();

  describe(`the host-execution guard is installed for ${workspace}`, () => {
    it.runIf(!optedIn)('denies every child_process entry point', () => {
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

    it.runIf(!optedIn)('names the binary and argv it refused', () => {
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

    it.runIf(!optedIn)('is not merely opted out of', () => {
      // If a stray gate variable were exported into this run, the assertions
      // above would silently skip and this suite would report success while
      // proving nothing. Say so instead.
      expect(
        hostExecutionAllowed(),
        'a host-execution opt-in variable is set, so the guard is deliberately off — this suite proves nothing in that state',
      ).toBe(false);
    });
  });
}

/**
 * The same, for a workspace that also depends on `node-pty`.
 *
 * Separate because most workspaces do not have `node-pty` installed, and a
 * `vi.mock` factory for a module that cannot be resolved would fail the run for
 * a reason unrelated to the guard.
 */
export function nodePtyGuardContract(workspace: string): void {
  const optedIn = hostExecutionAllowed();

  describe(`node-pty is guarded for ${workspace}`, () => {
    it.runIf(!optedIn)('denies pty.spawn, which child_process mocking never covered', async () => {
      const pty = (await import('node-pty')) as unknown as Record<string, unknown>;

      expect(() =>
        (pty.spawn as (c: string, a: string[], o: object) => unknown)(PROBE, [], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
        }),
      ).toThrow(HostExecutionDenied);
    });
  });
}
