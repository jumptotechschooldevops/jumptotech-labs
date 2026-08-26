import { describe, expect, it } from 'vitest';
import { InvalidSessionTokenError, issueSessionToken, verifySessionToken } from '../src/index.js';

const SECRET = 'test-secret-that-is-long-enough';
const SESSION_ID = 'sess-000000000000000a';
const NAMESPACE = 'lab-0000000000aa';
const OWNER = 'usr-00000001';

function issue(overrides: Partial<Parameters<typeof issueSessionToken>[0]> = {}) {
  return issueSessionToken({
    sessionId: SESSION_ID,
    ownerUserId: OWNER,
    labId: 'K8S-001',
    namespace: NAMESPACE,
    secret: SECRET,
    ttlSeconds: 60,
    ...overrides,
  });
}

describe('terminal session tokens', () => {
  it('round-trips claims', () => {
    const { token, claims } = issue();

    const verified = verifySessionToken(token, SECRET);

    expect(verified.labId).toBe('K8S-001');
    expect(verified.namespace).toBe(NAMESPACE);
    expect(verified.sid).toBe(claims.sid);
  });

  it('binds the token to a real lab session (PLATFORM-002)', () => {
    // The terminal resolves credentials from `sid` alone, so a token that did
    // not carry a real session id could not be turned into a shell at all.
    const { claims } = issue();
    expect(claims.sid).toBe(SESSION_ID);

    expect(() =>
      issueSessionToken({
        sessionId: '',
        ownerUserId: OWNER,
        labId: 'K8S-001',
        namespace: NAMESPACE,
        secret: SECRET,
        ttlSeconds: 60,
      }),
    ).toThrow(/requires the lab session id/);
  });

  it('rejects a token signed with a different secret', () => {
    const { token } = issue();

    expect(() => verifySessionToken(token, 'a-completely-different-secret')).toThrow(
      InvalidSessionTokenError,
    );
  });

  it('rejects a tampered payload', () => {
    const { token } = issue();
    const [, signature] = token.split('.');
    // Re-pointing the token at kube-system is exactly the attack the signature
    // exists to stop.
    const forged = Buffer.from(
      JSON.stringify({ sid: 'x', labId: 'K8S-001', namespace: 'kube-system', iat: 0, exp: 9e9 }),
    ).toString('base64url');

    expect(() => verifySessionToken(`${forged}.${signature}`, SECRET)).toThrow(/signature mismatch/);
  });

  it('rejects a token re-pointed at another session', () => {
    const { token } = issue();
    const [payload] = token.split('.');
    const other = issue({ sessionId: 'sess-000000000000000b' });
    const [, otherSignature] = other.token.split('.');

    // Mixing one session's payload with another's signature fails.
    expect(() => verifySessionToken(`${payload}.${otherSignature}`, SECRET)).toThrow(
      /signature mismatch/,
    );
  });

  it('rejects an expired token', () => {
    const { token } = issue({ ttlSeconds: 1, now: () => 1_000_000 });

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
    expect(() => issue({ secret: 'short' })).toThrow(/at least 8 characters/);
  });
});
