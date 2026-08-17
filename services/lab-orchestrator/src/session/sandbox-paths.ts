/**
 * Sandbox path handling.
 *
 * Filesystem and Terraform requirements name paths. Those paths come from a
 * lab definition, which is data the platform ships — but "trusted enough to
 * ship" is not "trusted enough to hand to a filesystem read", so every path is
 * checked twice:
 *
 *   1. the lab schema rejects anything that is not a well-formed sandbox path
 *      (`sandboxPath` in `requirements.ts` uses `isSafeSandboxPath`);
 *   2. the path is normalised and re-checked immediately before any read
 *      (`resolveSandboxPath`).
 *
 * Two forms are accepted, and the difference matters:
 *
 *   - **home-relative** (`deploy/release.txt`) — resolved under the session's
 *     sandbox home, and refused if normalisation takes it outside;
 *   - **container-absolute** (`/var/log/jumptotech/payments.log`) — taken as
 *     written *inside the container*. A Linux administration lab is about
 *     `/etc`, `/srv` and `/var/log`, and the whole container is the throwaway
 *     thing one session owns, so confining those labs to one home directory
 *     would have meant they could not be written at all.
 *
 * What is refused either way: `..`, `~`, backslashes, NUL bytes, empty
 * segments, and any character outside the narrow segment charset. A path that
 * only *looks* safe segment by segment still has to survive normalisation.
 *
 * There is no host filesystem access anywhere on this path: reads happen inside
 * the sandbox container, and `/etc` means the container's `/etc`.
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
  if (input.startsWith('~')) {
    throw new SandboxPathError(input, "must not start with '~' — name the path explicitly");
  }
  if (input === '/') throw new SandboxPathError(input, 'must name something inside the sandbox');

  // An absolute path is one inside the container; drop the leading slash so the
  // segment rules below are the same for both forms.
  const segments = (path.posix.isAbsolute(input) ? input.slice(1) : input).split('/');
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
 * Resolve a declared path to an absolute path inside the sandbox.
 *
 * The second gate. A home-relative path must still normalise to something under
 * `home`, which is what a traversal attempt actually collides with, whatever
 * produced the string. A container-absolute path is normalised and returned as
 * written — it is already inside the sandbox, because the sandbox is the whole
 * container.
 */
export function resolveSandboxPath(home: string, declared: string): string {
  if (!path.posix.isAbsolute(home)) {
    throw new SandboxPathError(home, 'sandbox home must be an absolute path');
  }
  assertSafeSandboxPath(declared);

  // Already absolute inside the container: normalise and use as written. The
  // segment rules above have already excluded `..`, so normalisation cannot
  // move it anywhere its literal text did not already point.
  if (path.posix.isAbsolute(declared)) {
    return path.posix.normalize(declared);
  }

  const root = path.posix.normalize(home).replace(/\/+$/, '');
  const resolved = path.posix.normalize(path.posix.join(root, declared));
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new SandboxPathError(declared, 'resolves outside the sandbox home directory');
  }
  return resolved;
}

/** The parent directory of a resolved sandbox path, for `mkdir -p`. */
export function sandboxParent(absolutePath: string): string {
  return path.posix.dirname(absolutePath);
}
