/**
 * PLATFORM-010 — the primitives underneath browser authentication.
 *
 * The end-to-end suites prove the flow works. These prove the pieces cannot be
 * *made* to work in the wrong way: that the store keeps a hash and not a
 * cookie, that a cookie is written with the attributes that make it a boundary,
 * that a transaction cannot be forged, and that a `returnTo` cannot become an
 * open redirect.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryAuthSessionStore,
  hashAuthSessionId,
  looksLikeAuthSessionId,
  mintAuthSessionId,
} from '../src/auth/browser-session.js';
import {
  clearCookie,
  openTransaction,
  parseCookies,
  sealTransaction,
  serializeCookie,
  CookieError,
  type AuthTransaction,
} from '../src/auth/cookies.js';
import { codeChallengeFor, safeEquals } from '../src/auth/oidc-client.js';
import { BrowserSessionAuthenticator } from '../src/auth/browser-authenticator.js';
import { InMemoryUserRepository } from '../src/auth/users.js';
import { AuthError } from '../src/auth/identity.js';

const SECRET = 'transaction-signing-secret-value';

// ------------------------------------------------------------- the store

describe('the auth session store', () => {
  it('never stores the value it hands out', async () => {
    const store = new InMemoryAuthSessionStore();
    const created = await store.create('usr-00000001', 3600);

    // The record holds the hash. A database dump is not a set of usable
    // cookies, which is the entire argument for hashing a value that is
    // already random.
    expect(created.record.authSessionId).toBe(hashAuthSessionId(created.cookieValue));
    expect(created.record.authSessionId).not.toBe(created.cookieValue);
    expect(created.record.authSessionId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mints an unguessable, cookie-safe value every time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const { cookieValue } = mintAuthSessionId();
      expect(looksLikeAuthSessionId(cookieValue)).toBe(true);
      // base64url only, so it never needs escaping in a Set-Cookie header.
      expect(cookieValue).toMatch(/^[A-Za-z0-9_-]+$/);
      seen.add(cookieValue);
    }
    expect(seen.size).toBe(200);
  });

  it('resolves only the exact value, and only before it expires', async () => {
    const now = { value: Date.now() };
    const store = new InMemoryAuthSessionStore({ now: () => now.value });
    const created = await store.create('usr-00000001', 60);

    expect((await store.resolve(created.cookieValue))?.userId).toBe('usr-00000001');
    // A near miss is a miss.
    expect(await store.resolve(`${created.cookieValue}x`)).toBeNull();

    now.value += 61_000;
    expect(await store.resolve(created.cookieValue)).toBeNull();
  });

  it('rejects a value that is not even shaped like one, without a lookup', async () => {
    const store = new InMemoryAuthSessionStore();
    for (const value of ['', 'ab', 'has spaces', 'a'.repeat(200), '../../etc/passwd', '<script>']) {
      expect(looksLikeAuthSessionId(value), value).toBe(false);
      expect(await store.resolve(value), value).toBeNull();
    }
  });

  it('destroys idempotently, and destroying an unknown session is not an error', async () => {
    const store = new InMemoryAuthSessionStore();
    const created = await store.create('usr-00000001', 60);

    expect(await store.destroy(created.cookieValue)).toBe(true);
    expect(await store.destroy(created.cookieValue)).toBe(false);
    expect(await store.resolve(created.cookieValue)).toBeNull();
  });

  it('signs a user out everywhere without touching anyone else', async () => {
    const store = new InMemoryAuthSessionStore();
    const one = await store.create('usr-00000001', 60);
    const two = await store.create('usr-00000001', 60);
    const other = await store.create('usr-00000002', 60);

    expect(await store.destroyAllForUser('usr-00000001')).toBe(2);
    expect(await store.resolve(one.cookieValue)).toBeNull();
    expect(await store.resolve(two.cookieValue)).toBeNull();
    expect(await store.resolve(other.cookieValue)).not.toBeNull();
  });

  it('purges expired rows and leaves live ones', async () => {
    const now = { value: Date.now() };
    const store = new InMemoryAuthSessionStore({ now: () => now.value });
    const short = await store.create('usr-00000001', 10);
    const long = await store.create('usr-00000002', 10_000);

    now.value += 60_000;
    expect(await store.purgeExpired()).toBe(1);
    expect(await store.resolve(short.cookieValue)).toBeNull();
    expect(await store.resolve(long.cookieValue)).not.toBeNull();
  });
});

// ------------------------------------------------------------- the cookie

describe('cookie writing', () => {
  const attributes = { secure: true, sameSite: 'lax' as const, path: '/', domain: undefined };

  it('always writes HttpOnly and SameSite', () => {
    const header = serializeCookie('jtt_session', 'abc123', attributes);
    // Not conditional anywhere: a cookie this module writes is never readable
    // by script and is never sent on a cross-site request.
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/SameSite=Lax/);
    expect(header).toMatch(/Secure/);
    expect(header).toMatch(/Path=\//);
  });

  it('omits Domain unless one is configured, so the cookie is host-only', () => {
    expect(serializeCookie('jtt_session', 'abc', attributes)).not.toMatch(/Domain=/);
    expect(
      serializeCookie('jtt_session', 'abc', { ...attributes, domain: 'labs.example.com' }),
    ).toMatch(/Domain=labs\.example\.com/);
  });

  it('refuses a value that would need escaping rather than mangling it', () => {
    for (const hostile of ['a;b', 'a b', 'a\nb', 'a"b', 'a,b']) {
      expect(() => serializeCookie('jtt_session', hostile, attributes), hostile).toThrow(CookieError);
    }
  });

  it('refuses a malformed cookie name', () => {
    expect(() => serializeCookie('bad name', 'abc', attributes)).toThrow(CookieError);
  });

  it('clears with an immediate expiry, not just an empty value', () => {
    const header = clearCookie('jtt_session', attributes);
    expect(header).toMatch(/^jtt_session=;/);
    expect(header).toMatch(/Max-Age=0/);
    expect(header).toMatch(/HttpOnly/);
  });
});

describe('cookie parsing', () => {
  it('reads the cookies a browser actually sends', () => {
    expect(parseCookies('a=1; b=2;c=3')).toEqual({ a: '1', b: '2', c: '3' });
    // `=` inside a value is legal and common in base64url-adjacent values.
    expect(parseCookies('jtt_session=abc=def')).toEqual({ jtt_session: 'abc=def' });
  });

  it('ignores nonsense instead of throwing', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
    expect(parseCookies('novalue')).toEqual({});
    expect(parseCookies('=novalue')).toEqual({});
  });

  it('caps an absurd header rather than working through it', () => {
    expect(parseCookies(`a=${'x'.repeat(9000)}`)).toEqual({});
  });
});

// -------------------------------------------------------- the transaction

describe('the sign-in transaction cookie', () => {
  const transaction: AuthTransaction = {
    state: 'state-value',
    nonce: 'nonce-value',
    codeVerifier: 'verifier-value',
    returnTo: '/#/labs/K8S-001',
    exp: Math.floor(Date.now() / 1000) + 600,
  };

  it('round-trips what it was given', () => {
    expect(openTransaction(sealTransaction(transaction, SECRET), SECRET)).toEqual(transaction);
  });

  it('refuses a tampered payload', () => {
    const sealed = sealTransaction(transaction, SECRET);
    const [payload, signature] = sealed.split('.') as [string, string];
    const swapped = Buffer.from(
      JSON.stringify({ ...transaction, state: 'attacker-state' }),
    ).toString('base64url');

    expect(openTransaction(`${swapped}.${signature}`, SECRET)).toBeNull();

    /*
     * …and a tampered signature over the real payload.
     *
     * The replacement character is chosen against the one already there. Always
     * substituting 'A' looks like tampering but is a no-op roughly one time in
     * sixty-four, when the signature happens to end in 'A' — a flake that would
     * read as "the transaction guard failed" rather than as a test bug.
     */
    const lastChar = signature.slice(-1);
    const flipped = `${signature.slice(0, -1)}${lastChar === 'A' ? 'B' : 'A'}`;
    expect(flipped).not.toBe(signature);
    expect(openTransaction(`${payload}.${flipped}`, SECRET)).toBeNull();
  });

  it('refuses one signed with a different secret', () => {
    expect(openTransaction(sealTransaction(transaction, 'other-secret'), SECRET)).toBeNull();
  });

  it('refuses an expired transaction', () => {
    const stale = { ...transaction, exp: Math.floor(Date.now() / 1000) - 1 };
    expect(openTransaction(sealTransaction(stale, SECRET), SECRET)).toBeNull();
  });

  it('refuses garbage without distinguishing how it was garbage', () => {
    for (const value of [undefined, null, 42, '', 'x', 'a.b.c', 'a'.repeat(5000)]) {
      expect(openTransaction(value, SECRET), String(value)).toBeNull();
    }
  });
});

// ------------------------------------------------------------ PKCE + state

describe('PKCE and state comparison', () => {
  it('computes the S256 challenge from RFC 7636', () => {
    // The worked example from the RFC, so this is pinned to the standard rather
    // than to whatever the implementation happens to produce.
    expect(codeChallengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('compares opaque values without a length-leaking shortcut', () => {
    expect(safeEquals('abc', 'abc')).toBe(true);
    expect(safeEquals('abc', 'abd')).toBe(false);
    expect(safeEquals('abc', 'abcd')).toBe(false);
    expect(safeEquals(undefined, 'abc')).toBe(false);
    expect(safeEquals(['abc'], 'abc')).toBe(false);
  });
});

// ------------------------------------------------------ the authenticator

describe('the browser session authenticator', () => {
  async function harness() {
    const sessions = new InMemoryAuthSessionStore();
    const users = new InMemoryUserRepository('oidc');
    const user = await users.upsert({ issuer: 'https://issuer.test/', subject: 'auth0|alice' });
    const auth = new BrowserSessionAuthenticator({ sessions, users, cookieName: 'jtt_session' });
    return { sessions, users, user, auth };
  }

  it('resolves a live session to its user', async () => {
    const { sessions, user, auth } = await harness();
    const created = await sessions.create(user.userId, 3600);

    const resolved = await auth.authenticate(`jtt_session=${created.cookieValue}`);
    expect(resolved?.userId).toBe(user.userId);
    expect(resolved?.subject).toBe('auth0|alice');
  });

  it('returns null with no cookie, so the header path still runs', async () => {
    const { auth } = await harness();
    // This is what keeps service callers, the test suite and development mode
    // working unchanged.
    expect(await auth.authenticate(undefined)).toBeNull();
    expect(await auth.authenticate('other=value')).toBeNull();
  });

  it('refuses — rather than falling through — when a cookie names nothing', async () => {
    const { auth } = await harness();
    /*
     * The important half. Falling through here would let a stale cookie quietly
     * degrade into whatever the header resolver produces, which in development
     * mode is a valid identity: a security hole disguised as convenience.
     */
    await expect(auth.authenticate(`jtt_session=${mintAuthSessionId().cookieValue}`)).rejects.toThrow(
      AuthError,
    );
  });

  it('refuses a session whose user no longer exists', async () => {
    const { sessions, auth } = await harness();
    const orphan = await sessions.create('usr-not-a-real-user', 3600);

    await expect(auth.authenticate(`jtt_session=${orphan.cookieValue}`)).rejects.toThrow(AuthError);
  });

  it('reads only its own cookie out of a crowded header', async () => {
    const { sessions, user, auth } = await harness();
    const created = await sessions.create(user.userId, 3600);

    const resolved = await auth.authenticate(
      `theme=dark; jtt_session=${created.cookieValue}; other=1`,
    );
    expect(resolved?.userId).toBe(user.userId);
  });
});
