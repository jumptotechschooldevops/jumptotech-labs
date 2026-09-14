/**
 * BETA-P0-014 — `jtt_oidc_jwks_fetch_total` counts what RB-14 says it counts.
 *
 * The counter was declared, alerted on (`JwksFetchFailing`) and named as a
 * recovery check in RB-14, but nothing incremented it: a provider outage would
 * have shown as a flat zero. These cases run the real `OidcTokenVerifier`
 * against a real loopback JWKS endpoint, so what is counted is what `jose`
 * actually fetched — not a stub's idea of it.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createAuthMetrics, createRegistry } from '@jumptotech/observability';
import { OidcTokenVerifier, type JwksFetchOutcome } from '../src/auth/oidc.js';
import { buildBrowserSignIn } from '../src/auth/browser-sign-in.js';
import { AuthError } from '../src/auth/identity.js';
import { loadConfig } from '../src/config.js';
import { jwksFetchMetricHook } from '../src/observability.js';

type KeysMode = 'ok' | 'server-error' | 'redirect' | 'not-json' | 'not-a-key-set';
type DiscoveryMode = 'ok' | 'server-error' | 'foreign-issuer';

let server: Server;
let issuer = '';
let keysMode: KeysMode = 'ok';
let discoveryMode: DiscoveryMode = 'ok';
let keyRequests = 0;
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' };
  server = createServer((req, res) => {
    if (req.url === '/.well-known/openid-configuration') {
      if (discoveryMode === 'server-error') return void res.writeHead(500).end();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: discoveryMode === 'foreign-issuer' ? 'https://evil.example' : issuer,
          jwks_uri: `${issuer}/keys`,
        }),
      );
      return;
    }
    if (req.url === '/keys') {
      keyRequests += 1;
      if (keysMode === 'server-error') return void res.writeHead(503).end();
      if (keysMode === 'redirect') return void res.writeHead(302, { location: `${issuer}/elsewhere` }).end();
      res.writeHead(200, { 'content-type': 'application/json' });
      if (keysMode === 'not-json') return void res.end('<html>maintenance</html>');
      if (keysMode === 'not-a-key-set') return void res.end(JSON.stringify({ issuer }));
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  keysMode = 'ok';
  discoveryMode = 'ok';
  keyRequests = 0;
});

const token = (audience = 'aud') =>
  new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject('p0014|jwks-metric')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);

function recorder(): { outcomes: JwksFetchOutcome[]; onJwksFetch: (outcome: JwksFetchOutcome) => void } {
  const outcomes: JwksFetchOutcome[] = [];
  return { outcomes, onJwksFetch: (outcome) => outcomes.push(outcome) };
}

describe('the verifier reports every JWKS retrieval', () => {
  it('counts one success per fetch, not one per token verified', async () => {
    const { outcomes, onJwksFetch } = recorder();
    const verifier = new OidcTokenVerifier({ issuer, audience: 'aud', onJwksFetch });
    for (let i = 0; i < 3; i += 1) {
      await expect(verifier.verify(await token())).resolves.toMatchObject({ subject: 'p0014|jwks-metric' });
    }
    expect(keyRequests).toBe(1);
    expect(outcomes).toEqual(['success']);
  });

  it('counts an explicit OIDC_JWKS_URI the same way', async () => {
    const { outcomes, onJwksFetch } = recorder();
    const verifier = new OidcTokenVerifier({ issuer, audience: 'aud', jwksUri: `${issuer}/keys`, onJwksFetch });
    await verifier.verify(await token());
    expect(outcomes).toEqual(['success']);
  });

  it.each([
    ['server-error', 'http_error'],
    ['redirect', 'http_error'],
    ['not-json', 'invalid_response'],
    ['not-a-key-set', 'invalid_response'],
  ] as const)('a %s JWKS response is %s, and the token is still refused', async (mode, outcome) => {
    keysMode = mode;
    const { outcomes, onJwksFetch } = recorder();
    const verifier = new OidcTokenVerifier({ issuer, audience: 'aud', onJwksFetch });
    const error = await verifier.verify(await token()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect(keyRequests).toBe(1);
    expect(outcomes).toEqual([outcome]);
  });

  it('counts an unreachable JWKS endpoint as network_error', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const { outcomes, onJwksFetch } = recorder();
    const verifier = new OidcTokenVerifier({
      issuer,
      audience: 'aud',
      jwksUri: `http://127.0.0.1:${port}/keys`,
      onJwksFetch,
    });
    await expect(verifier.verify(await token())).rejects.toBeDefined();
    expect(outcomes).toEqual(['network_error']);
  });

  it.each(['server-error', 'foreign-issuer'] as const)(
    'counts discovery that yields no jwks_uri (%s) as discovery_failed, and retries it',
    async (mode) => {
      discoveryMode = mode;
      const { outcomes, onJwksFetch } = recorder();
      const verifier = new OidcTokenVerifier({ issuer, audience: 'aud', onJwksFetch });
      await expect(verifier.verify(await token())).rejects.toBeInstanceOf(AuthError);
      // Wait for the rejection handler that clears the cached failure.
      await new Promise((resolve) => setImmediate(resolve));
      expect(keyRequests).toBe(0);
      expect(outcomes).toEqual(['discovery_failed']);

      discoveryMode = 'ok';
      await verifier.verify(await token());
      expect(outcomes).toEqual(['discovery_failed', 'success']);
    },
  );

  it('recovers the next fetch after a failure, and counts both', async () => {
    const { outcomes, onJwksFetch } = recorder();
    const verifier = new OidcTokenVerifier({
      issuer,
      audience: 'aud',
      jwksUri: `${issuer}/keys`,
      onJwksFetch,
    });
    keysMode = 'server-error';
    await expect(verifier.verify(await token())).rejects.toBeInstanceOf(AuthError);
    keysMode = 'ok';
    await verifier.verify(await token());
    expect(outcomes).toEqual(['http_error', 'success']);
  });

  it('never lets a failing hook decide whether a token verifies', async () => {
    const verifier = new OidcTokenVerifier({
      issuer,
      audience: 'aud',
      onJwksFetch: () => {
        throw new Error('metrics backend exploded');
      },
    });
    await expect(verifier.verify(await token())).resolves.toMatchObject({ subject: 'p0014|jwks-metric' });
  });
});

describe('jtt_oidc_jwks_fetch_total', () => {
  it('is incremented through the hook the API wires, with only a bounded outcome label', async () => {
    const registry = createRegistry({ service: 'api', defaultMetrics: false });
    const auth = createAuthMetrics(registry);
    const onJwksFetch = jwksFetchMetricHook(auth);

    await new OidcTokenVerifier({ issuer, audience: 'aud', onJwksFetch }).verify(await token());
    keysMode = 'server-error';
    await new OidcTokenVerifier({ issuer, audience: 'aud', onJwksFetch }).verify(await token()).catch(() => undefined);

    const text = await registry.getSingleMetricAsString('jtt_oidc_jwks_fetch_total');
    const series = text.split('\n').filter((line) => line.startsWith('jtt_oidc_jwks_fetch_total'));
    expect(series).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^jtt_oidc_jwks_fetch_total\{outcome="success"[^}]*\} 1$/),
        expect.stringMatching(/^jtt_oidc_jwks_fetch_total\{outcome="http_error"[^}]*\} 1$/),
      ]),
    );
    const port = new URL(issuer).port;
    for (const line of series) {
      expect(line).not.toContain(port);
      expect(line).not.toMatch(/127\.0\.0\.1|keys|kid|issuer=/);
      const labels = [...line.matchAll(/(\w+)="/g)].map((match) => match[1]);
      expect(labels.filter((label) => label !== 'service')).toEqual(['outcome']);
    }
  });

  it('is fed by the browser ID-token verifier that buildBrowserSignIn constructs', async () => {
    const config = loadConfig({
      TERMINAL_SESSION_SECRET: 'jwks-metric-terminal-session-secret',
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: 'client',
      OIDC_AUDIENCE: 'api',
      OIDC_CLIENT_SECRET: 'jwks-metric-client-secret-0123456789',
      LOG_LEVEL: 'error',
    } as NodeJS.ProcessEnv);
    const { outcomes, onJwksFetch } = recorder();
    const { idTokenVerifier } = buildBrowserSignIn(config.auth, { onJwksFetch });
    await idTokenVerifier!.verify(await token('client'));
    expect(outcomes).toEqual(['success']);
  });
});
