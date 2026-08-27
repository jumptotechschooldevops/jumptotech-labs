/**
 * PLATFORM-006 — the host-execution guard is installed for every suite here.
 *
 * `server.fs.allow` names the repository root explicitly because the guard
 * lives outside this workspace and vitest is routinely handed a *relative*
 * `--root`, which defeats vite's own inference. See the identical comment in
 * `services/progress/vitest.config.ts`.
 */
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  server: { fs: { allow: [repositoryRoot] } },
  test: {
    setupFiles: ['../../test-support/vitest.setup.ts'],
  },
});
