/**
 * Session identifiers and the Kubernetes names derived from them.
 *
 * Two rules drive this module:
 *
 * 1. **Session ids are capabilities.** PLATFORM-002 has no user
 *    authentication, so holding a session id is what lets you act on a
 *    session. They are therefore generated with `crypto.randomBytes`, never
 *    from a counter or a timestamp, and they are long enough that guessing is
 *    not a strategy. (The story's illustration, `sess-a84fc21`, is 28 bits;
 *    we default to 64 bits for exactly this reason.)
 *
 * 2. **Namespace names are not capabilities.** The namespace is derived from
 *    the session id through an HMAC, so it is stable and collision-resistant,
 *    but a student who learns `lab-3f9c1a7b2d40` cannot invert it back into
 *    the session id that controls the session.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_ID_PREFIX = 'sess-';
export const NAMESPACE_PREFIX = 'lab-';

/**
 * Prefix for container-backed sandboxes (Linux, Terraform, Docker).
 *
 * Deliberately distinct from the Kubernetes `lab-` prefix and deliberately
 * distinctive on a developer's machine: cleanup will only ever consider a
 * container whose *name* starts with this and whose *labels* say the platform
 * owns it, so a developer's own `lab-something` container cannot be reached.
 */
export const CONTAINER_SANDBOX_PREFIX = 'jtt-lab-';

/** Exactly what a container sandbox name may look like, on both sides of the wire. */
export const CONTAINER_SANDBOX_PATTERN = /^jtt-lab-[0-9a-f]{6,40}$/;

/** Hex characters of entropy in a session id. 16 → 64 bits. */
export const DEFAULT_SESSION_ID_ENTROPY_CHARS = 16;

/** Hex characters taken from the HMAC to form a namespace suffix. */
export const DEFAULT_NAMESPACE_SUFFIX_CHARS = 12;

/** `sess-` followed by lowercase hex. */
export const SESSION_ID_PATTERN = /^sess-[0-9a-f]{7,32}$/;

/** RFC 1123 label, as required for a Kubernetes namespace name. */
export const DNS_1123_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

export const MAX_NAMESPACE_LENGTH = 63;

/**
 * Namespaces the platform must never create, adopt, or delete — regardless of
 * labels, configuration, or what any caller asks for.
 */
export const PROTECTED_NAMESPACES: readonly string[] = [
  'default',
  'kube-system',
  'kube-public',
  'kube-node-lease',
  'local-path-storage',
];

export class InvalidSessionIdError extends Error {
  readonly code = 'INVALID_SESSION_ID';
  constructor(reason: string) {
    super(`Invalid session id: ${reason}`);
    this.name = 'InvalidSessionIdError';
  }
}

export class InvalidNamespaceError extends Error {
  readonly code = 'INVALID_NAMESPACE';
  constructor(
    readonly received: string,
    reason: string,
  ) {
    super(`Invalid lab namespace: ${reason}`);
    this.name = 'InvalidNamespaceError';
  }
}

/** Cryptographically strong, non-sequential session id. */
export function newSessionId(entropyChars = DEFAULT_SESSION_ID_ENTROPY_CHARS): string {
  if (entropyChars < 7 || entropyChars > 32 || entropyChars % 2 !== 0) {
    throw new Error('session id entropy must be an even number of hex chars between 8 and 32');
  }
  return SESSION_ID_PREFIX + randomBytes(entropyChars / 2).toString('hex');
}

/** Validate a session id arriving from the network. Returns it unchanged. */
export function assertValidSessionId(input: unknown): string {
  if (typeof input !== 'string') throw new InvalidSessionIdError('expected a string');
  if (input.length === 0) throw new InvalidSessionIdError('must not be empty');
  if (input.length > 64) throw new InvalidSessionIdError('too long');
  if (!SESSION_ID_PATTERN.test(input)) {
    throw new InvalidSessionIdError('must look like sess-<hex>');
  }
  return input;
}

export function isValidSessionId(input: unknown): boolean {
  try {
    assertValidSessionId(input);
    return true;
  } catch {
    return false;
  }
}

export interface DeriveNamespaceOptions {
  sessionId: string;
  /** Keyed so the mapping cannot be recomputed without server-side secrets. */
  secret: string;
  suffixChars?: number;
  prefix?: string;
}

/**
 * Deterministically derive the namespace for a session.
 *
 * One-way on purpose: `sessionId → namespace` is cheap, `namespace →
 * sessionId` is not, so leaking a namespace name in a log, a `kubectl` prompt,
 * or a screenshot does not leak the session capability.
 */
export function deriveNamespace(options: DeriveNamespaceOptions): string {
  const sessionId = assertValidSessionId(options.sessionId);
  if (!options.secret || options.secret.length < 8) {
    throw new Error('namespace derivation requires a secret of at least 8 characters');
  }
  const suffixChars = options.suffixChars ?? DEFAULT_NAMESPACE_SUFFIX_CHARS;
  if (suffixChars < 6 || suffixChars > 40) {
    throw new Error('namespace suffix must be between 6 and 40 hex characters');
  }
  const digest = createHmac('sha256', options.secret)
    .update(`namespace:${sessionId}`)
    .digest('hex')
    .slice(0, suffixChars);

  return assertValidLabNamespace(`${options.prefix ?? NAMESPACE_PREFIX}${digest}`);
}

/**
 * Validate a namespace the platform intends to create or delete.
 *
 * Anything that is not a well-formed `lab-…` label, or that collides with a
 * cluster namespace, is rejected before it can reach the Kubernetes API.
 */
export function assertValidLabNamespace(input: unknown, prefix = NAMESPACE_PREFIX): string {
  if (typeof input !== 'string') throw new InvalidNamespaceError(String(input), 'expected a string');
  if (input.length === 0) throw new InvalidNamespaceError(input, 'must not be empty');
  if (input.length > MAX_NAMESPACE_LENGTH) {
    throw new InvalidNamespaceError(input, `must be at most ${MAX_NAMESPACE_LENGTH} characters`);
  }
  if (!DNS_1123_LABEL.test(input)) {
    throw new InvalidNamespaceError(input, 'must be a lowercase RFC 1123 DNS label');
  }
  if (!input.startsWith(prefix)) {
    throw new InvalidNamespaceError(input, `must start with '${prefix}'`);
  }
  if (input.length <= prefix.length) {
    throw new InvalidNamespaceError(input, 'must have a suffix after the prefix');
  }
  if (isProtectedNamespace(input)) {
    throw new InvalidNamespaceError(input, 'is a protected cluster namespace');
  }
  return input;
}

export function isProtectedNamespace(name: string): boolean {
  if (PROTECTED_NAMESPACES.includes(name)) return true;
  // Anything in the kube-* / kubernetes-* reserved space is off limits too.
  return name.startsWith('kube-') || name === 'kube' || name.startsWith('kubernetes-');
}

/**
 * Is this namespace name shaped like a lab sandbox?
 *
 * Name-shape alone never authorises deletion — `assertDeletable` in
 * `k8s/labels.ts` additionally requires the live ownership labels. This is the
 * cheap first gate, applied before any name reaches the Kubernetes API.
 */
export function isLabNamespace(namespace: unknown, prefix = NAMESPACE_PREFIX): namespace is string {
  try {
    assertValidLabNamespace(namespace, prefix);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derive the sandbox handle for a session, for any provider.
 *
 * The Kubernetes case is `deriveNamespace` — same HMAC, same guarantee. A
 * container-backed provider gets its own prefix *and* its own HMAC domain, so
 * the same session's namespace and container names are unrelated strings:
 * learning one tells you nothing about the other, and neither can be inverted
 * back into the session id that actually controls the session.
 */
export function deriveSandboxRef(options: {
  sessionId: string;
  secret: string;
  prefix?: string;
  suffixChars?: number;
}): string {
  const prefix = options.prefix ?? NAMESPACE_PREFIX;
  if (prefix === NAMESPACE_PREFIX) {
    return deriveNamespace({
      sessionId: options.sessionId,
      secret: options.secret,
      ...(options.suffixChars !== undefined ? { suffixChars: options.suffixChars } : {}),
    });
  }

  const sessionId = assertValidSessionId(options.sessionId);
  if (!options.secret || options.secret.length < 8) {
    throw new Error('sandbox derivation requires a secret of at least 8 characters');
  }
  const suffixChars = options.suffixChars ?? DEFAULT_NAMESPACE_SUFFIX_CHARS;
  if (suffixChars < 6 || suffixChars > 40) {
    throw new Error('sandbox suffix must be between 6 and 40 hex characters');
  }
  const digest = createHmac('sha256', options.secret)
    .update(`sandbox:${prefix}:${sessionId}`)
    .digest('hex')
    .slice(0, suffixChars);

  return assertValidContainerSandboxRef(`${prefix}${digest}`);
}

export class InvalidSandboxRefError extends Error {
  readonly code = 'INVALID_SANDBOX_REF';
  constructor(
    readonly received: string,
    reason: string,
  ) {
    super(`Invalid sandbox reference: ${reason}`);
    this.name = 'InvalidSandboxRefError';
  }
}

/**
 * Validate a container sandbox name before it reaches a container runtime.
 *
 * The name-shape gate for containers, mirroring `assertValidLabNamespace` for
 * namespaces. Ownership labels are still re-read from the runtime immediately
 * before any destructive call — a name alone never authorises a delete.
 */
export function assertValidContainerSandboxRef(input: unknown): string {
  if (typeof input !== 'string') {
    throw new InvalidSandboxRefError(String(input), 'expected a string');
  }
  if (!CONTAINER_SANDBOX_PATTERN.test(input)) {
    throw new InvalidSandboxRefError(input, `must match ${CONTAINER_SANDBOX_PATTERN.source}`);
  }
  return input;
}

export function isContainerSandboxRef(input: unknown): input is string {
  return typeof input === 'string' && CONTAINER_SANDBOX_PATTERN.test(input);
}

/** Constant-time session id comparison, for anywhere ids are matched. */
export function sessionIdsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
