/** Test requirement 2 — Lab ID validation. */
import { describe, expect, it } from 'vitest';
import { InvalidLabIdError, assertValidLabId, isValidLabId } from '../src/index.js';

describe('assertValidLabId', () => {
  it('accepts canonical ids', () => {
    expect(assertValidLabId('K8S-001')).toBe('K8S-001');
    expect(assertValidLabId('LINUX-014')).toBe('LINUX-014');
  });

  it('canonicalises case', () => {
    expect(assertValidLabId('k8s-001')).toBe('K8S-001');
    expect(assertValidLabId('K8s-001')).toBe('K8S-001');
  });

  const rejected: Array<[string, unknown]> = [
    ['empty string', ''],
    ['a non-string', 42],
    ['null', null],
    ['undefined', undefined],
    ['path traversal', '../../etc/passwd'],
    ['dot segment', 'K8S-001/../K8S-002'],
    ['absolute path', '/etc/passwd'],
    ['backslash traversal', '..\\..\\windows'],
    ['null byte injection', 'K8S-001\u0000.yaml'],
    ['newline injection', 'K8S-001\nrm -rf /'],
    ['shell metacharacters', 'K8S-001; rm -rf /'],
    ['command substitution', 'K8S-001$(whoami)'],
    ['url encoding', 'K8S%2D001'],
    ['whitespace', 'K8S 001'],
    ['leading whitespace', ' K8S-001'],
    ['too few digits', 'K8S-01'],
    ['too many digits', 'K8S-0001'],
    ['missing separator', 'K8S001'],
    ['wildcard', 'K8S-*'],
    ['overlong input', 'K'.repeat(64) + '-001'],
  ];

  for (const [label, value] of rejected) {
    it(`rejects ${label}`, () => {
      expect(() => assertValidLabId(value)).toThrow(InvalidLabIdError);
      expect(isValidLabId(value)).toBe(false);
    });
  }

  it('reports the reason without echoing a null byte', () => {
    try {
      assertValidLabId('K8S-001\u0000');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as InvalidLabIdError).received).toBe('<null-byte>');
      expect((error as InvalidLabIdError).code).toBe('INVALID_LAB_ID');
    }
  });
});
