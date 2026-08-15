/**
 * Lab ID validation.
 *
 * Lab IDs arrive from the network as URL path segments and are used to look
 * up files on disk and to name Kubernetes objects. They are validated with a
 * strict allow-list before they are used for anything at all.
 */

/** Canonical lab id form: TRACK-NNN, e.g. `K8S-001`, `LINUX-014`. */
export const LAB_ID_PATTERN = /^[A-Z][A-Z0-9]{1,9}-\d{3}$/;

export const MAX_LAB_ID_LENGTH = 16;

export class InvalidLabIdError extends Error {
  readonly code = 'INVALID_LAB_ID';
  constructor(readonly received: string, reason: string) {
    super(`Invalid lab id: ${reason}`);
    this.name = 'InvalidLabIdError';
  }
}

/**
 * Returns the canonical (upper-cased) lab id, or throws.
 *
 * Rejects anything that could be used for path traversal, injection, or
 * resource-name abuse: separators, dots, whitespace, null bytes, and any
 * character outside `[A-Z0-9-]`.
 */
export function assertValidLabId(input: unknown): string {
  if (typeof input !== 'string') {
    throw new InvalidLabIdError(String(input), 'expected a string');
  }
  if (input.length === 0) {
    throw new InvalidLabIdError(input, 'must not be empty');
  }
  if (input.length > MAX_LAB_ID_LENGTH) {
    throw new InvalidLabIdError(input, `must be at most ${MAX_LAB_ID_LENGTH} characters`);
  }
  if (input.includes('\0')) {
    throw new InvalidLabIdError('<null-byte>', 'must not contain null bytes');
  }

  const canonical = input.toUpperCase();
  if (!LAB_ID_PATTERN.test(canonical)) {
    throw new InvalidLabIdError(input, 'must match TRACK-NNN (for example K8S-001)');
  }
  return canonical;
}

/** Non-throwing variant. */
export function isValidLabId(input: unknown): boolean {
  try {
    assertValidLabId(input);
    return true;
  } catch {
    return false;
  }
}
