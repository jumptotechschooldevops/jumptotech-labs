/**
 * PLATFORM-006 — the host-execution guard is installed for every suite here.
 *
 * `setupFiles` is what makes fail-closed the default: a unit test cannot reach
 * the host's kubectl, docker or kind unless the run explicitly opts in. See
 * `test-support/README.md` for the UNIT / INTEGRATION / E2E contracts.
 *
 * `server.fs.allow` has to name the repository root explicitly because the
 * guard lives outside this workspace. Vite normally infers that root, but when
 * vitest is handed a *relative* `--root` — which is how the Makefile targets
 * and the documented `npx vitest run … --root services/x` commands invoke it —
 * the inference fails, the root is left out of the allow list, and loading the
 * guard is refused. Vite reports that as "Does the file exist?", which sends
 * you looking for a missing file instead of a denied one, and the suite dies
 * before a single test runs rather than running unguarded.
 */
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  // Not a widening: this is the root vite already infers for itself whenever it
  // is able to. Naming it just stops the inference from being load-bearing.
  server: { fs: { allow: [repositoryRoot] } },
  test: {
    setupFiles: ['../../test-support/vitest.setup.ts'],
  },
});
