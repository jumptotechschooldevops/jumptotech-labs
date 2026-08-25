/**
 * Vitest setup shared by every workspace — PLATFORM-006.
 *
 * Loaded through `setupFiles` in each workspace's `vitest.config.ts`, which is
 * what makes the guard the *default* rather than something a test has to
 * remember to ask for. `vi.mock` here applies to every test file in the run,
 * including modules those files import transitively — which is the case that
 * matters, since the leak was inside `KindLabProvider`, not in a test.
 */
import { vi } from 'vitest';
import { guardChildProcess } from './host-execution.js';

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
