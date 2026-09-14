/**
 * A real identity provider, in-process — PLATFORM-010.
 *
 * The OIDC-mode suites need tokens that are *actually verified*: signed with a
 * key the API fetches over JWKS, carrying a real issuer, audience, nonce and
 * expiry. A stubbed `TokenVerifier` would prove the routes call something, not
 * that the verification works — and verification is the security property.
 *
 * So this is a genuine, if tiny, provider:
 *
 * ```text
 *   GET  /.well-known/openid-configuration   discovery
 *   GET  /.well-known/jwks.json              the public key
 *   GET  /authorize                          hands back a code (no UI)
 *   POST /token                              code → signed ID token
 *   GET  /end-session                        published, so logout can use it
 * ```
 *
 * It runs on a real loopback HTTP server because `createRemoteJWKSet` fetches
 * over the network, and pointing it at a fake would replace the very code path
 * under test.
 *
 * It is a test double, so it is permissive where a real provider would not be —
 * `/authorize` authenticates nobody. What it is *not* permissive about is
 * anything the API relies on: PKCE verifiers are checked, codes are single-use,
 * the client secret is required, and the nonce is echoed into the token.
 */
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import type { AddressInfo } from 'node:net';

export interface FakeIdpUser {
  subject: string;
  email?: string;
  name?: string;
}

interface PendingCode {
  user: FakeIdpUser;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
}

/**
 * Tamper with the next ID token only — BETA-P0-014.
 *
 * A real provider never issues these; a compromised, misconfigured or
 * impersonated one might. Each field is one way an ID token can be wrong, so the
 * callback's refusal of each can be proven end to end.
 */
export interface IdTokenOverrides {
  /** `null` omits the claim. */
  nonce?: string | null;
  audience?: string | string[];
  azp?: string;
  issuer?: string;
  /** Epoch seconds; `null` omits `exp`. */
  expiresAt?: number | null;
  /** Epoch seconds; `null` omits `iat`. */
  issuedAt?: number | null;
  /** Sign with a key the provider never published. */
  foreignKey?: boolean;
}

export interface FakeIdentityProvider {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Who `/authorize` signs in next. Set before driving the flow. */
  signInAs(user: FakeIdpUser): void;
  /** Applies to the next token exchange only, then resets. */
  nextIdToken(overrides: IdTokenOverrides): void;
  /** Sign arbitrary claims with the provider's real, published key. No defaults added. */
  sign(claims: Record<string, unknown>): Promise<string>;
  /** Counts token exchanges, so a test can prove a code is single-use. */
  readonly tokenExchanges: number;
  close(): Promise<void>;
}

const CLIENT_ID = 'jumptotech-labs-test-client';
const CLIENT_SECRET = 'test-client-secret-never-in-the-browser';

/** RFC 7636 S256. */
function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export async function startFakeIdentityProvider(): Promise<FakeIdentityProvider> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = (await exportJWK(publicKey)) as JWK;
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  const codes = new Map<string, PendingCode>();
  let nextUser: FakeIdpUser = { subject: 'default-user' };
  let overrides: IdTokenOverrides = {};
  let exchanges = 0;
  let issuer = '';

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer || 'http://localhost');
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/.well-known/openid-configuration') {
      json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        end_session_endpoint: `${issuer}/end-session`,
        response_types_supported: ['code'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      });
      return;
    }

    if (url.pathname === '/.well-known/jwks.json') {
      json(200, { keys: [jwk] });
      return;
    }

    /*
     * `/authorize` — a browser would render a login form here.
     *
     * The test double skips straight to issuing a code for whoever
     * `signInAs` last named, but it still records the PKCE challenge and the
     * nonce, because the API's guarantees depend on both coming back.
     */
    if (url.pathname === '/authorize') {
      const state = url.searchParams.get('state') ?? '';
      const code = randomBytes(16).toString('base64url');
      codes.set(code, {
        user: nextUser,
        nonce: url.searchParams.get('nonce') ?? '',
        codeChallenge: url.searchParams.get('code_challenge') ?? '',
        redirectUri: url.searchParams.get('redirect_uri') ?? '',
      });
      const back = new URL(url.searchParams.get('redirect_uri') ?? '');
      back.searchParams.set('code', code);
      back.searchParams.set('state', state);
      res.writeHead(302, { location: back.href });
      res.end();
      return;
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        void (async () => {
          const form = new URLSearchParams(raw);

          // The confidential-client credential really is required.
          if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) {
            json(401, { error: 'invalid_client' });
            return;
          }

          const code = form.get('code') ?? '';
          const pending = codes.get(code);
          if (!pending) {
            json(400, { error: 'invalid_grant' });
            return;
          }
          // Single use, so a replayed code cannot mint a second session.
          codes.delete(code);

          const verifier = form.get('code_verifier') ?? '';
          if (pending.codeChallenge && s256(verifier) !== pending.codeChallenge) {
            json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
            return;
          }

          exchanges += 1;
          const o = overrides;
          overrides = {};
          const now = Math.floor(Date.now() / 1000);
          const nonce = o.nonce === undefined ? pending.nonce : o.nonce;
          const iat = o.issuedAt === undefined ? now : o.issuedAt;
          const exp = o.expiresAt === undefined ? now + 600 : o.expiresAt;

          const idToken = await new SignJWT({
            ...(pending.user.email ? { email: pending.user.email } : {}),
            ...(pending.user.name ? { name: pending.user.name } : {}),
            ...(nonce ? { nonce } : {}),
            ...(o.azp ? { azp: o.azp } : {}),
            ...(iat === null ? {} : { iat }),
            ...(exp === null ? {} : { exp }),
          })
            .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
            .setIssuer(o.issuer ?? issuer)
            // An ID token's audience is the *client id*, which is why the API
            // verifies it with a different verifier from the bearer path.
            .setAudience(o.audience ?? CLIENT_ID)
            .setSubject(pending.user.subject)
            .sign(o.foreignKey ? (await generateKeyPair('RS256')).privateKey : privateKey);

          json(200, { token_type: 'Bearer', expires_in: 600, id_token: idToken, access_token: 'test-access-token' });
        })();
      });
      return;
    }

    if (url.pathname === '/end-session') {
      res.writeHead(302, { location: url.searchParams.get('post_logout_redirect_uri') ?? '/' });
      res.end();
      return;
    }

    json(404, { error: 'not_found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    signInAs(user: FakeIdpUser) {
      nextUser = user;
    },
    nextIdToken(next: IdTokenOverrides) {
      overrides = next;
    },
    sign(claims: Record<string, unknown>) {
      return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(privateKey);
    },
    get tokenExchanges() {
      return exchanges;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Mint a token this API must reject.
 *
 * Signed by a key the issuer never published, so it is a *well-formed* token
 * from the wrong signer — the case a decode-instead-of-verify implementation
 * would happily accept.
 */
export async function foreignToken(issuer: string, audience: string, subject: string): Promise<string> {
  const { privateKey } = await generateKeyPair('RS256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}
