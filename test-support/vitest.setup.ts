/**
 * Vitest setup shared by every workspace — PLATFORM-006.
 *
 * Loaded through `setupFiles` in each workspace's `vitest.config.ts`, which is
 * what makes the guard the *default* rather than something a test has to
 * remember to ask for. `vi.mock` here applies to every test file in the run,
 * including modules those files import transitively — which is the case that
 * matters, since the leak was inside `KindLabProvider`, not in a test.
 */
import { createRequire } from 'node:module';
import { vi } from 'vitest';
import { guardChildProcess, guardNodePty, patchLoadedChildProcess } from './host-execution.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return guardChildProcess(actual);
});

// `child_process` and `node:child_process` are distinct specifiers to the
// module graph, so both are guarded: a dependency importing the bare form
// would otherwise walk straight past the mock.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return guardChildProcess(actual);
});

/*
 * `node-pty` is a native binding rather than a `child_process` wrapper, so it
 * was never covered by the two mocks above: `pty.spawn` started a real process
 * and the guard never saw it. `services/terminal/src/shell.ts` calls it
 * directly with no injection seam, so the hole was reachable.
 *
 * The factory only runs if something in the module graph actually imports
 * `node-pty`, so the workspaces that do not depend on it are unaffected by
 * this line.
 */
vi.mock('node-pty', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return guardNodePty(actual);
});

/*
 * The mocks above are not sufficient under `environment: 'jsdom'`.
 *
 * There, a *named* import — `import { execFile } from 'node:child_process'` —
 * binds to the real builtin and never sees the mock, while a namespace import
 * does. `apps/web` is the jsdom workspace, and its guard was therefore inert
 * for as long as it has existed: the config named the setup file, the setup
 * file ran, and a named import still reached the host. Running that same suite
 * with `--environment node` guards the identical import, which is what pins the
 * cause to the environment rather than to the config.
 *
 * Patching the loaded module object closes it, because that is the object a
 * named import reads under jsdom. Kept as a second layer rather than a
 * replacement — `vi.mock` stays the mechanism everywhere else.
 */
patchLoadedChildProcess(
  createRequire(import.meta.url)('node:child_process') as Record<string, unknown>,
);
