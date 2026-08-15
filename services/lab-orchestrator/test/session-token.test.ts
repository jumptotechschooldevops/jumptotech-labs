import { describe, expect, it } from 'vitest';
import { InvalidSessionTokenError, issueSessionToken, verifySessionToken } from '../src/index.js';

const SECRET = 'test-secret-that-is-long-enough';

describe('terminal session tokens', () => {
  it('round-trips claims', () => {
    const { token, claims } = issueSessionToken({
      labId: 'K8S-001',
      namespace: 'default',
      secret: SECRET,
      ttlSeconds: 60,
    });

    const verified = verifySessionToken(token, SECRET);

    expect(verified.labId).toBe('K8S-001');
    expect(verified.namespace).toBe('default');
    expect(verified.sid).toBe(claims.sid);
  });

  it('rejects a token signed with a different secret', () => {
    const { token } = issueSessionToken({
      labId: 'K8S-001',
      namespace: 'default',
      secret: SECRET,
      ttlSeconds: 60,
    });

    expect(() => verifySessionToken(token, 'a-completely-different-secret')).toThrow(
      InvalidSessionTokenError,
    );
  });

  it('rejects a tampered payload', () => {
    const { token } = issueSessionToken({
      labId: 'K8S-001',
      namespace: 'default',
      secret: SECRET,
      ttlSeconds: 60,
    });
    const [, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ sid: 'x', labId: 'K8S-001', namespace: 'kube-system', iat: 0, exp: 9e9 }),
    ).toString('base64url');

    expect(() => verifySessionToken(`${forged}.${signature}`, SECRET)).toThrow(/signature mismatch/);
  });

  it('rejects an expired token', () => {
    const { token } = issueSessionToken({
      labId: 'K8S-001',
      namespace: 'default',
      secret: SECRET,
      ttlSeconds: 1,
      now: () => 1_000_000,
    });

    expect(() => verifySessionToken(token, SECRET, () => 1_000_000 + 5_000)).toThrow(/expired/);
  });

  it.each([
    ['empty', ''],
    ['not a string', 42],
    ['no signature', 'abc'],
    ['too many parts', 'a.b.c'],
    ['absurdly long', 'a'.repeat(5000) + '.b'],
  ])('rejects a malformed token (%s)', (_label, value) => {
    expect(() => verifySessionToken(value, SECRET)).toThrow(InvalidSessionTokenError);
  });

  it('refuses to issue with a weak secret', () => {
    expect(() =>
      issueSessionToken({ labId: 'K8S-001', namespace: 'default', secret: 'short', ttlSeconds: 60 }),
    ).toThrow(/at least 8 characters/);
  });
});
