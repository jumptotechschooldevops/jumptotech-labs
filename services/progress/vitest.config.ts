/**
 * PLATFORM-006 — the host-execution guard is installed for every suite here.
 *
 * `setupFiles` is what makes fail-closed the default: a unit test cannot reach
 * the host's kubectl, docker or kind unless the run explicitly opts in. See
 * `test-support/README.md` for the UNIT / INTEGRATION / E2E contracts.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['../../test-support/vitest.setup.ts'],
  },
});
