/**
 * The sandbox image keeps its side of the manual-page bargain — INTEGRATION.
 *
 * The second of the two failure modes described in `sandbox-man-pages.ts`:
 * someone changes the image and the pages stop being installed. Only the real
 * image can answer that, so this suite starts a container and is gated on
 * RUN_INTEGRATION_TESTS under PLATFORM-006's INTEGRATION contract. The unit
 * half — lab prose and the Dockerfile — is in `linux-man-pages.test.ts`.
 *
 * Requires the sandbox image to have been built: `npm run sandbox:build`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { SANDBOX_IMAGE, SANDBOX_MAN_PAGES } from './sandbox-man-pages.js';

const run = promisify(execFile);

const enabled = process.env.RUN_INTEGRATION_TESTS === '1';
if (!enabled) {
  console.log(
    `[linux-man-pages-integration] skipped — set RUN_INTEGRATION_TESTS=1 and build ${SANDBOX_IMAGE}`,
  );
}

describe('the sandbox image ships the manual pages the curriculum cites', () => {
  it.runIf(enabled)(
    'answers `man -w` for every page in the manifest',
    async () => {
      /*
       * One container for the whole manifest, not one per page. Forty-odd
       * container starts took long enough to time the suite out on a loaded
       * machine, and the thing under test is the image's contents rather than
       * its start-up path — so the loop belongs inside.
       *
       * The page list is passed as argv rather than interpolated into the
       * script: these are compile-time constants, but building a shell string
       * out of a list is the habit that eventually meets a value that is not.
       */
      const script =
        'missing=""; for p in "$@"; do man -w -- "$p" >/dev/null 2>&1 || missing="$missing $p"; done;' +
        'if [ -n "$missing" ]; then echo "MISSING:$missing"; exit 1; fi; echo OK';

      const { stdout } = await run(
        'docker',
        [
          'run', '--rm', '--entrypoint', '/bin/sh',
          SANDBOX_IMAGE, '-c', script, 'man-check',
          ...SANDBOX_MAN_PAGES,
        ],
        { timeout: 240_000 },
      );

      expect(stdout.trim(), `image ${SANDBOX_IMAGE} is missing manual pages`).toBe('OK');
    },
    300_000,
  );
});
