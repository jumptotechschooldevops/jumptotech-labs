/**
 * PLATFORM-009 — token verification, roles, and the production gate.
 *
 * The gate is the most important test in this file. Development authentication
 * accepts whoever the caller says they are; shipping it by accident is not a
 * weak login but *no* login, with every student able to become every other. It
 * is also the easiest mistake to make — a stale line in an environment file —
 * and the hardest to notice, because everything keeps working.
 */
import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { createServer, type Server } from 'node:http';
import { AuthError } from '../src/auth/identity.js';
import { OidcTokenVerifier, bearerToken } from '../src/auth/oidc.js';
import {
  DevelopmentIdentityResolver,
  assertAuthModeAllowed,
  buildIdentityResolver,
} from '../src/auth/resolvers.js';
import { InMemoryUserRepository } from '../src/auth/users.js';
import { authorize } from '../src/auth/policy.js';
import type { AuthenticatedUser } from '../src/auth/identity.js';

// ------------------------------------------------------ production gate

describe('development authentication cannot reach production', () => {
  it('refuses to start when NODE_ENV=production and AUTH_MODE=development', () => {
    expect(() =>
      assertAuthModeAllowed({ mode: 'development', nodeEnv: 'production' }),
    ).toThrow(AuthError);

    try {
      assertAuthModeAllowed({ mode: 'development', nodeEnv: 'production' });
    } catch (error) {
      const failure = error as AuthError;
      expect(failure.code).toBe('AUTH_MISCONFIGURED');
      // The message has to say *why*, or an operator will simply flip it back.
      expect(failure.message).toMatch(/accepts any identity/i);
      expect(failure.remediation).toMatch(/AUTH_MODE=oidc/);
    }
  });

  it('refuses through the builder too, so no resolver is ever constructed', () => {
    expect(() =>
      buildIdentityResolver({
        config: { mode: 'development', nodeEnv: 'production' },
        users: new InMemoryUserRepository(),
      }),
    ).toThrow(/cannot be used when NODE_ENV=production/);
  });

  it('allows development authentication outside production', () => {
    for (const nodeEnv of ['development', 'test', undefined]) {
      const resolver = buildIdentityResolver({
        config: { mode: 'development', nodeEnv },
        users: new InMemoryUserRepository(),
      });
      expect(resolver.mode, String(nodeEnv)).toBe('development');
    }
  });

  it('refuses oidc mode with no verifier rather than falling back', () => {
    // The dangerous failure would be "OIDC is misconfigured, so let everyone
    // in". It fails closed instead.
    expect(() =>
      buildIdentityResolver({
        config: { mode: 'oidc', nodeEnv: 'production' },
        users: new InMemoryUserRepository(),
      }),
    ).toThrow(/requires OIDC_ISSUER/);
  });
});

// ---------------------------------------------------------- token parsing

describe('the Authorization header', () => {
  it('accepts only a well-formed bearer credential', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('Bearer   abc')).toBe('abc');
    for (const bad of [undefined, '', 'abc.def', 'Basic abc', 'Bearer', 'Bearer a b']) {
      expect(() => bearerToken(bad as string | undefined), String(bad)).toThrow(AuthError);
    }
  });

  it('says "authentication required" for a missing header, not "invalid"', () => {
    // A client with no credential needs to know to sign in; one with a bad
    // credential must not learn anything about why it failed.
    try {
      bearerToken(undefined);
    } catch (error) {
      expect((error as AuthError).code).toBe('AUTH_REQUIRED');
    }
  });
});

// ------------------------------------------------- real signature checking

describe('OIDC verification is verification, not decoding', () => {
  const ISSUER_PORT = 45_931;
  const ISSUER = `http://127.0.0.1:${ISSUER_PORT}/`;
  const AUDIENCE = 'jumptotech-api';

  /** A throwaway issuer serving one JWKS, so the signature is really checked. */
  async function withIssuer<T>(jwk: JWK, run: () => Promise<T>): Promise<T> {
    const server: Server = createServer((req, res) => {
      if (req.url?.includes('jwks')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(ISSUER_PORT, '127.0.0.1', resolve));
    try {
      return await run();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('accepts a correctly signed token and rejects every way it can be wrong', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'test-key' };

    const sign = (claims: Record<string, unknown>, overrides: { iss?: string; aud?: string; exp?: string } = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(overrides.iss ?? ISSUER)
        .setAudience(overrides.aud ?? AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(overrides.exp ?? '5m')
        .sign(privateKey);

    await withIssuer(jwk, async () => {
      const verifier = new OidcTokenVerifier({
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUri: `${ISSUER}.well-known/jwks.json`,
      });

      // The happy path: subject and profile claims come through.
      const good = await verifier.verify(
        await sign({ sub: 'auth0|abc123', email: 'a@example.com', name: 'Alice' }),
      );
      expect(good).toEqual({
        issuer: ISSUER,
        subject: 'auth0|abc123',
        email: 'a@example.com',
        displayName: 'Alice',
      });

      // Wrong issuer — a valid signature from somewhere else is still not ours.
      await expect(
        verifier.verify(await sign({ sub: 'x' }, { iss: 'https://evil.example/' })),
      ).rejects.toThrow(AuthError);

      // Wrong audience — a token minted for another API.
      await expect(
        verifier.verify(await sign({ sub: 'x' }, { aud: 'some-other-api' })),
      ).rejects.toThrow(AuthError);

      // Expired.
      await expect(verifier.verify(await sign({ sub: 'x' }, { exp: '-1m' }))).rejects.toThrow(
        /expired/i,
      );

      // Signed by a key the issuer does not publish: this is the one a
      // decode-only implementation would wave straight through.
      const attacker = await generateKeyPair('RS256');
      const forged = await new SignJWT({ sub: 'attacker' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(attacker.privateKey);
      await expect(verifier.verify(forged)).rejects.toThrow(AuthError);

      // Structurally broken.
      for (const junk of ['', 'not.a.jwt', 'a.b.c']) {
        await expect(verifier.verify(junk), junk).rejects.toThrow(AuthError);
      }
    });
  }, 60_000);

  it('does not tell an unauthenticated caller which check failed', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'k' };

    await withIssuer(jwk, async () => {
      const verifier = new OidcTokenVerifier({
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUri: `${ISSUER}.well-known/jwks.json`,
      });
      const wrongAudience = await new SignJWT({ sub: 'x' })
        .setProtectedHeader({ alg: 'RS256', kid: 'k' })
        .setIssuer(ISSUER)
        .setAudience('elsewhere')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);

      try {
        await verifier.verify(wrongAudience);
        expect.unreachable('should have been refused');
      } catch (error) {
        const failure = error as AuthError;
        // Distinguishing "wrong audience" from "bad signature" would be an
        // oracle for someone probing. Expiry is the deliberate exception.
        expect(failure.message).toBe('The credentials supplied are not valid.');
        expect(failure.message).not.toMatch(/audience|issuer|signature/i);
      }
    });
  }, 60_000);
});

// ------------------------------------------------------------ role policy

describe('roles are least privilege, and a claim cannot grant one', () => {
  const user = (role: AuthenticatedUser['role'], userId = 'usr-1'): AuthenticatedUser => ({
    userId,
    issuer: 'urn:test',
    subject: userId,
    role,
    source: 'development',
  });

  it('lets a student act only on their own session', () => {
    const alice = user('STUDENT', 'usr-alice');
    const mine = { sessionId: 's1', ownerUserId: 'usr-alice' };
    const theirs = { sessionId: 's2', ownerUserId: 'usr-bob' };

    for (const action of ['session:read', 'session:check', 'session:reset', 'session:end'] as const) {
      expect(authorize(alice, action, mine).allowed, action).toBe(true);
      expect(authorize(alice, action, theirs).allowed, action).toBe(false);
    }
  });

  it('gives an instructor visibility, and deliberately not control', () => {
    const instructor = user('INSTRUCTOR', 'usr-teacher');
    const student = { sessionId: 's1', ownerUserId: 'usr-alice' };

    expect(authorize(instructor, 'session:read', student).allowed).toBe(true);
    // Taking over someone's lab needs a consent and audit design this story
    // does not have — so it is refused rather than quietly permitted.
    for (const action of ['session:terminal', 'session:reset', 'session:end', 'session:check'] as const) {
      expect(authorize(instructor, action, student).allowed, action).toBe(false);
    }
  });

  it('does not make an instructor an administrator', () => {
    expect(authorize(user('INSTRUCTOR'), 'admin:users').allowed).toBe(false);
    expect(authorize(user('ADMIN'), 'admin:users').allowed).toBe(true);
    expect(authorize(user('STUDENT'), 'admin:users').allowed).toBe(false);
  });

  it('lets nobody at all touch a session with no owner', () => {
    const orphan = { sessionId: 's1', ownerUserId: undefined };
    for (const role of ['STUDENT', 'INSTRUCTOR', 'ADMIN'] as const) {
      expect(authorize(user(role), 'session:read', orphan).allowed, role).toBe(false);
      expect(authorize(user(role), 'session:end', orphan).reason, role).toBe('unowned');
    }
  });

  it('never takes a role from a token claim', async () => {
    const users = new InMemoryUserRepository();
    const created = await users.upsert({
      issuer: 'urn:test',
      subject: 'sneaky',
      // A provider that asserts a role, or a forged profile claim.
      ...({ role: 'ADMIN' } as Record<string, unknown>),
    });

    // Everyone starts as a student; promotion happens in the database.
    expect(created.role).toBe('STUDENT');
  });
});

// -------------------------------------------------------- development mode

describe('the development resolver', () => {
  it('gives each named identity its own stable account', async () => {
    const users = new InMemoryUserRepository();
    const resolver = new DevelopmentIdentityResolver(users);

    const alice = await resolver.resolve('Developer alice');
    const again = await resolver.resolve('Developer alice');
    const bob = await resolver.resolve('Developer bob');

    expect(alice.userId).toBe(again.userId);
    expect(alice.userId).not.toBe(bob.userId);
    expect(alice.role).toBe('STUDENT');
  });

  it('refuses a bearer token rather than ignoring it', async () => {
    const resolver = new DevelopmentIdentityResolver(new InMemoryUserRepository());
    // A real token arriving here means the deployment is misconfigured; saying
    // so is better than silently authenticating somebody as the default user.
    await expect(resolver.resolve('Bearer real.looking.token')).rejects.toThrow(AuthError);
  });

  it('refuses a malformed development identity', async () => {
    const resolver = new DevelopmentIdentityResolver(new InMemoryUserRepository());
    for (const bad of ['Developer ', 'Developer ../etc', 'Developer a b']) {
      await expect(resolver.resolve(bad), bad).rejects.toThrow(AuthError);
    }
  });
});
