/**
 * Session identifiers and the namespace names derived from them.
 *
 * Story tests 1–3: a start produces a unique session id, a second start
 * produces a different one, and each session gets its own namespace.
 */
import { describe, expect, it } from 'vitest';
import {
  DNS_1123_LABEL,
  InvalidNamespaceError,
  InvalidSessionIdError,
  PROTECTED_NAMESPACES,
  assertValidLabNamespace,
  assertValidSessionId,
  deriveNamespace,
  isLabNamespace,
  isProtectedNamespace,
  isValidSessionId,
  newSessionId,
  sessionIdsEqual,
} from '../src/index.js';

const SECRET = 'a-namespace-derivation-secret';

describe('session ids', () => {
  it('are unique across many mints (story test 1 and 2)', () => {
    const ids = new Set(Array.from({ length: 5_000 }, () => newSessionId()));
    expect(ids.size).toBe(5_000);
  });

  it('are not sequential or guessable from a neighbour', () => {
    const [a, b] = [newSessionId(), newSessionId()];
    expect(a).not.toBe(b);
    // A counter would differ by one character; 64 bits of entropy does not.
    const differing = [...a].filter((char, i) => char !== b[i]).length;
    expect(differing).toBeGreaterThan(3);
  });

  it('carry at least 64 bits of entropy by default', () => {
    // `sess-` + 16 hex chars = 64 bits.
    expect(newSessionId()).toMatch(/^sess-[0-9a-f]{16}$/);
  });

  it.each([
    ['empty', ''],
    ['not a string', 42],
    ['no prefix', 'a84fc21'],
    ['uppercase hex', 'sess-A84FC21'],
    ['non-hex', 'sess-zzzzzzz'],
    ['path traversal', 'sess-../../etc'],
    ['too long', `sess-${'a'.repeat(64)}`],
    ['sequential style', 'session-1'],
  ])('rejects a malformed session id (%s)', (_label, value) => {
    expect(() => assertValidSessionId(value)).toThrow(InvalidSessionIdError);
    expect(isValidSessionId(value)).toBe(false);
  });

  it('compares in constant time without throwing on length mismatch', () => {
    const id = newSessionId();
    expect(sessionIdsEqual(id, id)).toBe(true);
    expect(sessionIdsEqual(id, 'sess-short')).toBe(false);
  });
});

describe('namespace derivation (story test 3)', () => {
  it('gives different sessions different namespaces', () => {
    const namespaces = new Set(
      Array.from({ length: 1_000 }, () => deriveNamespace({ sessionId: newSessionId(), secret: SECRET })),
    );
    expect(namespaces.size).toBe(1_000);
  });

  it('is deterministic for one session', () => {
    const sessionId = newSessionId();
    expect(deriveNamespace({ sessionId, secret: SECRET })).toBe(
      deriveNamespace({ sessionId, secret: SECRET }),
    );
  });

  it('does not leak the session id', () => {
    // The namespace shows up in prompts, logs and screenshots. Since it is an
    // HMAC of the session id under a server-side secret, seeing it does not
    // hand anyone the capability that controls the session.
    const sessionId = 'sess-000000000000000a';
    const namespace = deriveNamespace({ sessionId, secret: SECRET });

    expect(namespace).not.toContain(sessionId.slice('sess-'.length));
    // A different secret maps the same session id somewhere else entirely.
    expect(deriveNamespace({ sessionId, secret: 'a-different-secret' })).not.toBe(namespace);
  });

  it('always produces a valid, prefixed DNS-1123 label', () => {
    for (let i = 0; i < 200; i += 1) {
      const namespace = deriveNamespace({ sessionId: newSessionId(), secret: SECRET });
      expect(namespace).toMatch(DNS_1123_LABEL);
      expect(namespace.startsWith('lab-')).toBe(true);
      expect(namespace.length).toBeLessThanOrEqual(63);
    }
  });

  it('refuses to derive from an invalid session id or a weak secret', () => {
    expect(() => deriveNamespace({ sessionId: 'session-1', secret: SECRET })).toThrow(
      InvalidSessionIdError,
    );
    expect(() => deriveNamespace({ sessionId: newSessionId(), secret: 'short' })).toThrow(
      /at least 8 characters/,
    );
  });
});

describe('namespace validation', () => {
  it.each(PROTECTED_NAMESPACES)('rejects the protected namespace %s', (name) => {
    expect(isProtectedNamespace(name)).toBe(true);
    expect(() => assertValidLabNamespace(name)).toThrow(InvalidNamespaceError);
    expect(isLabNamespace(name)).toBe(false);
  });

  it.each([
    ['no prefix', 'my-namespace'],
    ['prefix only', 'lab-'],
    ['uppercase', 'lab-ABC'],
    ['traversal', 'lab-../kube-system'],
    ['whitespace', 'lab- abc'],
    ['too long', `lab-${'a'.repeat(70)}`],
    ['empty', ''],
    ['not a string', null],
  ])('rejects %s', (_label, value) => {
    expect(() => assertValidLabNamespace(value)).toThrow(InvalidNamespaceError);
  });

  it('accepts a well-formed sandbox namespace', () => {
    expect(assertValidLabNamespace('lab-3f9c1a7b2d40')).toBe('lab-3f9c1a7b2d40');
    expect(isLabNamespace('lab-3f9c1a7b2d40')).toBe(true);
  });

  it('treats the whole kube-* space as reserved', () => {
    expect(isProtectedNamespace('kube-anything')).toBe(true);
    expect(isProtectedNamespace('kubernetes-dashboard')).toBe(true);
  });
});
