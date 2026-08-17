/**
 * Sandbox path handling.
 *
 * Filesystem and Terraform requirements name paths. Those paths come from a
 * lab definition, which is data the platform ships — but "trusted enough to
 * ship" is not "trusted enough to hand to a filesystem read", so every path is
 * checked twice:
 *
 *   1. the lab schema rejects anything that is not a plain relative path
 *      (`sandboxPathSchema` in `requirements.ts` uses `isSafeSandboxPath`);
 *   2. the resolved absolute path is re-checked against the sandbox root
 *      immediately before any read (`resolveSandboxPath`).
 *
 * The result is that a verifier can only ever read inside one session's own
 * sandbox home. `..`, absolute paths, `~`, backslashes, NUL bytes and empty
 * segments are all refused, and the resolved path must still start with the
 * sandbox root after normalisation — so a path that only *looks* safe segment
 * by segment cannot escape either.
 *
 * There is no host filesystem access anywhere on this path: reads happen inside
 * the sandbox container, as the unprivileged student user.
 */
import path from 'node:path';

export class SandboxPathError extends Error {
  readonly code = 'INVALID_SANDBOX_PATH';
  constructor(
    readonly received: string,
    reason: string,
  ) {
    super(`Invalid sandbox path '${received}': ${reason}`);
    this.name = 'SandboxPathError';
  }
}

export const MAX_SANDBOX_PATH_LENGTH = 255;

/**
 * Characters a sandbox path segment may contain.
 *
 * Deliberately narrow. Lab content has no reason to name a file with a shell
 * metacharacter, and narrowing here means the runtime never has to reason about
 * quoting — which it could not anyway, because every exec is an argv array with
 * `shell: false`.
 *
 * A single leading dot is allowed, because the state a lab has to grade is
 * often in one: `.terraform/`, `.terraform.lock.hcl`, `.bashrc`, `.ssh/config`.
 * It must still be followed by a letter or a digit, so `.` and `..` cannot
 * match — and they are refused explicitly below in any case.
 */
const SEGMENT_PATTERN = /^\.?[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertSafeSandboxPath(input: unknown): string {
  if (typeof input !== 'string') throw new SandboxPathError(String(input), 'expected a string');
  if (input.length === 0) throw new SandboxPathError(input, 'must not be empty');
  if (input.length > MAX_SANDBOX_PATH_LENGTH) {
    throw new SandboxPathError(input, `must be at most ${MAX_SANDBOX_PATH_LENGTH} characters`);
  }
  if (input.includes('\0')) throw new SandboxPathError(input, 'must not contain a NUL byte');
  if (input.includes('\\')) throw new SandboxPathError(input, 'must use forward slashes');
  if (path.posix.isAbsolute(input) || input.startsWith('~')) {
    throw new SandboxPathError(input, 'must be relative to the sandbox home directory');
  }

  const segments = input.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new SandboxPathError(input, 'must not contain an empty path segment');
    }
    if (segment === '.' || segment === '..') {
      throw new SandboxPathError(input, "must not contain '.' or '..' segments");
    }
    if (!SEGMENT_PATTERN.test(segment)) {
      throw new SandboxPathError(
        input,
        `segment '${segment}' must be letters, digits, '.', '_' or '-' and start with a letter or digit`,
      );
    }
  }
  return input;
}

export function isSafeSandboxPath(input: unknown): input is string {
  try {
    assertSafeSandboxPath(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a declared path to an absolute path inside the sandbox home.
 *
 * The second gate. Even for a path the schema already accepted, the normalised
 * result must still live under `home` — so this is what a traversal attempt
 * actually collides with, whatever produced the string.
 */
export function resolveSandboxPath(home: string, relative: string): string {
  if (!path.posix.isAbsolute(home)) {
    throw new SandboxPathError(home, 'sandbox home must be an absolute path');
  }
  assertSafeSandboxPath(relative);

  const root = path.posix.normalize(home).replace(/\/+$/, '');
  const resolved = path.posix.normalize(path.posix.join(root, relative));
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new SandboxPathError(relative, 'resolves outside the sandbox home directory');
  }
  return resolved;
}

/** The parent directory of a resolved sandbox path, for `mkdir -p`. */
export function sandboxParent(absolutePath: string): string {
  return path.posix.dirname(absolutePath);
}
