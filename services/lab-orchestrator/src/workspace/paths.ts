/**
 * Path safety for file-backed lab sandboxes.
 *
 * Every path that reaches the filesystem — a lab's seed file, a requirement's
 * `path:`, a student's artifact — passes through here first. Two rules:
 *
 *   1. A relative path is a *sequence of plain segments*. No absolute paths, no
 *      `..`, no backslashes, no null bytes, no characters outside a small
 *      allow-list. This is checked on the string, before it becomes a path.
 *   2. The resolved result must still be inside the root it was resolved
 *      against. This is checked again *after* `path.resolve`, so a segment that
 *      normalises unexpectedly cannot escape.
 *
 * Symlinks are handled separately, at read time, by refusing anything that is
 * not a regular file or a real directory — see `fs-workspace.ts`. Validating a
 * name can never prove where a symlink points, so containment is enforced where
 * the syscall happens rather than where the string is parsed.
 */

/** Longest relative path a lab or a requirement may name. */
export const MAX_RELATIVE_PATH_LENGTH = 255;

/** Longest single segment. Comfortably above any real filename in a lab. */
export const MAX_SEGMENT_LENGTH = 96;

/**
 * Characters allowed in a path segment.
 *
 * Deliberately narrow: CI/CD labs need letters, digits, dots, dashes and
 * underscores (`.github`, `ci.yml`, `build.mjs`, `Jenkinsfile`) and nothing
 * else. Spaces, quotes, and shell metacharacters are refused outright so a path
 * can never carry syntax, whatever later consumes it.
 */
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$|^\.[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class InvalidWorkspacePathError extends Error {
  readonly code = 'INVALID_WORKSPACE_PATH';
  constructor(
    readonly received: string,
    reason: string,
  ) {
    super(`Invalid workspace path '${received}': ${reason}`);
    this.name = 'InvalidWorkspacePathError';
  }
}

/**
 * Validate a workspace-relative path and return it in canonical form
 * (forward slashes, no leading or trailing separator, no `.` segments).
 */
export function assertSafeRelativePath(input: unknown): string {
  if (typeof input !== 'string') {
    throw new InvalidWorkspacePathError(String(input), 'expected a string');
  }
  if (input.length === 0) {
    throw new InvalidWorkspacePathError(input, 'must not be empty');
  }
  if (input.length > MAX_RELATIVE_PATH_LENGTH) {
    throw new InvalidWorkspacePathError(input, `must be at most ${MAX_RELATIVE_PATH_LENGTH} characters`);
  }
  if (input.includes('\0')) {
    throw new InvalidWorkspacePathError('<null-byte>', 'must not contain null bytes');
  }
  if (input.includes('\\')) {
    throw new InvalidWorkspacePathError(input, 'must use forward slashes');
  }
  if (input.startsWith('/')) {
    throw new InvalidWorkspacePathError(input, 'must be relative to the workspace root');
  }

  const segments = input.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0) {
    throw new InvalidWorkspacePathError(input, 'must name at least one path segment');
  }
  if (segments.length > 12) {
    throw new InvalidWorkspacePathError(input, 'is nested too deeply');
  }

  for (const segment of segments) {
    if (segment === '..') {
      throw new InvalidWorkspacePathError(input, 'must not traverse upwards');
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      throw new InvalidWorkspacePathError(input, `path segment '${segment}' is too long`);
    }
    if (!SEGMENT_PATTERN.test(segment)) {
      throw new InvalidWorkspacePathError(
        input,
        `path segment '${segment}' may only contain letters, digits, '.', '-' and '_'`,
      );
    }
  }

  return segments.join('/');
}

/** Non-throwing variant, for schema-level checks. */
export function isSafeRelativePath(input: unknown): boolean {
  try {
    assertSafeRelativePath(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is `candidate` inside `root`?
 *
 * Both are expected to be already-resolved absolute paths. The root itself
 * counts as inside, which is what lets `stat('.')`-style queries work.
 */
export function isInside(root: string, candidate: string, separator = '/'): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(separator) ? root : root + separator;
  return candidate.startsWith(prefix);
}
