/**
 * BETA-P0-019 — every binary the platform execs inside a sandbox exists in
 * every sandbox image it ships.
 *
 * The providers exec absolute paths (no shell, no `PATH` lookup) for their
 * reads and setup. `readSandboxPath` named `/usr/bin/stat`; the Debian images
 * have it, the Alpine/BusyBox images (ansible, cicd) keep `stat` at `/bin/stat`
 * only. So every file read on an Ansible or CI/CD sandbox returned "not found",
 * and no file check in either track could pass. Unit tests use a fake runtime
 * that answers any path it is written for, which is exactly how a wrong one
 * went unnoticed; only the real images can answer this.
 *
 * Tier: INTEGRATION. Gated on RUN_INTEGRATION_TESTS=1 and Docker; an image that
 * is not built is reported and skipped (a real vitest skip, which CI's strict
 * runner fails on), never pulled or built here. Creates
 * only `docker run --rm` containers with no network, which remove themselves.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ANSIBLE_SANDBOX_IMAGE,
  DEFAULT_CICD_SANDBOX_IMAGE,
  DEFAULT_LINUX_SANDBOX_IMAGE,
  DEFAULT_TERRAFORM_SANDBOX_IMAGE,
  INTERNAL_EXEC_ALLOWLIST,
} from '../src/index.js';

const run = promisify(execFile);
const ENABLED = process.env.RUN_INTEGRATION_TESTS === '1';

/** Absolute paths the Ansible provider execs on its control node, beyond the shared list. */
const ANSIBLE_PROVIDER_BINARIES = ['/usr/bin/ssh', '/usr/bin/tee', '/bin/mkdir', '/bin/chmod', '/bin/stat'];

const IMAGES: Array<[string, string, readonly string[]]> = [
  ['linux', process.env.LINUX_SANDBOX_IMAGE ?? DEFAULT_LINUX_SANDBOX_IMAGE, []],
  ['terraform', process.env.TERRAFORM_SANDBOX_IMAGE ?? DEFAULT_TERRAFORM_SANDBOX_IMAGE, []],
  ['ansible', process.env.ANSIBLE_SANDBOX_IMAGE ?? DEFAULT_ANSIBLE_SANDBOX_IMAGE, ANSIBLE_PROVIDER_BINARIES],
  ['cicd', process.env.CICD_SANDBOX_IMAGE ?? DEFAULT_CICD_SANDBOX_IMAGE, []],
];

async function imagePresent(image: string): Promise<boolean> {
  try {
    await run('docker', ['image', 'inspect', image], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

async function inImage(image: string, script: string): Promise<string> {
  const { stdout } = await run(
    'docker',
    ['run', '--rm', '--network', 'none', '--entrypoint', '/bin/sh', image, '-c', script],
    { timeout: 120_000 },
  );
  return stdout;
}

describe.runIf(ENABLED)('sandbox images carry every binary the providers exec', () => {
  // `it.for`, not `it.each`, for the test context: a missing image is reported
  // as a skip. It used to `return`, which vitest counts as a pass, so a CI job
  // whose images were built under another tag went green having checked nothing.
  it.for(IMAGES)('%s (%s)', { timeout: 180_000 }, async ([, image, extra], context) => {
    if (!(await imagePresent(image))) {
      console.log(`[sandbox-image-binaries] ${image} is not built — run: npm run sandbox:build`);
      context.skip();
      return;
    }
    const binaries = [...new Set([...INTERNAL_EXEC_ALLOWLIST, ...extra])];
    const missing = await inImage(image, `for b in ${binaries.join(' ')}; do [ -x "$b" ] || echo "$b"; done`);
    expect(missing.trim(), `${image} lacks binaries the platform execs by absolute path`).toBe('');

    // And `stat -c` speaks the format `readSandboxPath` parses (GNU and BusyBox agree).
    const stat = await inImage(image, `mkdir -p /tmp/d && printf x > /tmp/f && /bin/stat -c '%F|%a|%U|%G|%s' -- /tmp/f /tmp/d`);
    const [file, dir] = stat.trim().split('\n');
    // Owner and group are whoever the image runs as (root, or student on terraform).
    expect(file).toMatch(/^regular file\|\d{3,4}\|\w+\|\w+\|1$/);
    expect(dir).toMatch(/^directory\|\d{3,4}\|\w+\|\w+\|\d+$/);
  });
});
