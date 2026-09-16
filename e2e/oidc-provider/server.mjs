/**
 * A test-only OpenID Connect provider for the browser E2E stack.
 *
 * WHY THIS EXISTS
 *
 * The API authenticates browsers with the OIDC authorization-code flow and an
 * HttpOnly session cookie (docs/authentication.md §3). Development mode has no
 * browser sign-in at all, so a real browser test needs a real provider. This is
 * one, on purpose small, so the API runs its *production* auth code path
 * unmodified: discovery, PKCE S256, state, nonce, the confidential-client token
 * exchange, RS256 signature verification over JWKS, the callback and the cookie.
 * No API code is bypassed, stubbed or switched into a test mode.
 *
 * It is the browser-facing sibling of apps/api/test/oidc-identity.ts. That one
 * signs in whoever the test last named, with no page; this one renders a login
 * form, so each browser context chooses its own student by typing a username.
 *
 * WHAT IT IS NOT
 *
 * It authenticates nobody: any well-formed username is accepted. That is only
 * acceptable because it is never part of a shipped stack — it lives under e2e/,
 * is started only by e2e/docker-compose.e2e.yml, publishes on loopback only,
 * and refuses to start with NODE_ENV=production. The API independently refuses
 * a plain-http issuer under NODE_ENV=production (P0-014), so even a stack
 * wrongly pointed at this provider could not run in production.
 *
 * It is strict about everything the API relies on: the client secret, the
 * exact redirect URI, PKCE S256, single-use short-lived codes and requests,
 * and the nonce echoed into the ID token.
 *
 * No dependencies — node:http and node:crypto only — so it runs from a stock
 * node image with this directory mounted read-only.
 */
import { createServer } from 'node:http';
import { createHash, createSign, generateKeyPairSync, randomBytes, timingSafeEqual } from 'node:crypto';

const env = process.env;

function required(name, { minLength = 1 } = {}) {
  const value = (env[name] ?? '').trim();
  if (value.length < minLength) {
    // Names the variable, never a value.
    console.error(`[e2e-oidc] refusing to start: ${name} must be set (min ${minLength} chars)`);
    process.exit(2);
  }
  return value;
}

if ((env.NODE_ENV ?? '').trim() === 'production') {
  console.error('[e2e-oidc] refusing to start: this is a test identity provider and NODE_ENV=production');
  process.exit(2);
}

const PORT = Number(env.E2E_OIDC_PORT ?? 9500);
/** The issuer the API is configured with and fetches server-side, e.g. http://oidc:9500. */
const ISSUER = required('E2E_OIDC_ISSUER');
/** Where the *browser* reaches this provider, e.g. http://127.0.0.1:39700. */
const BROWSER_BASE = required('E2E_OIDC_BROWSER_BASE').replace(/\/$/, '');
const CLIENT_ID = required('E2E_OIDC_CLIENT_ID');
const CLIENT_SECRET = required('E2E_OIDC_CLIENT_SECRET', { minLength: 32 });
/** The only redirect URI this client may use — exact match, as a real provider does. */
const REDIRECT_URI = required('E2E_OIDC_REDIRECT_URI');
const REDIRECT_ORIGIN = new URL(REDIRECT_URI).origin;

for (const [name, value] of [['E2E_OIDC_ISSUER', ISSUER], ['E2E_OIDC_BROWSER_BASE', BROWSER_BASE], ['E2E_OIDC_REDIRECT_URI', REDIRECT_URI]]) {
  const url = new URL(value);
  const host = url.hostname;
  // Loopback or a compose service name only: never a routable public host.
  if (url.protocol !== 'http:' || !(host === '127.0.0.1' || host === 'localhost' || /^[a-z][a-z0-9-]*$/.test(host))) {
    console.error(`[e2e-oidc] refusing to start: ${name} must be http on loopback or a compose service name`);
    process.exit(2);
  }
}

const CODE_TTL_MS = 60_000;
const REQUEST_TTL_MS = 5 * 60_000;
const ID_TOKEN_TTL_S = 300;
const USERNAME = /^[a-z0-9][a-z0-9-]{1,31}$/;

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = randomBytes(8).toString('hex');
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

/** Pending /authorize requests, keyed by an opaque id the login form posts back. */
const requests = new Map();
/** Issued authorization codes. */
const codes = new Map();

const b64url = (input) => Buffer.from(input).toString('base64url');
const s256 = (verifier) => createHash('sha256').update(verifier, 'ascii').digest('base64url');

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function signJwt(claims) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }));
  const payload = b64url(JSON.stringify(claims));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`;
}

function sweep() {
  const now = Date.now();
  for (const [key, value] of requests) if (value.expiresAt < now) requests.delete(key);
  for (const [key, value] of codes) if (value.expiresAt < now) codes.delete(key);
}

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** An error page. Never a redirect: an unvalidated redirect_uri must not be followed. */
function sendError(res, status, message) {
  res.writeHead(status, HTML_HEADERS);
  res.end(`<!doctype html><title>Sign-in error</title><h1>Sign-in error</h1><p role="alert">${message}</p>`);
}

function readForm(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(new URLSearchParams(raw)));
    req.on('error', reject);
  });
}

function loginPage(requestId) {
  // requestId is server-generated base64url; nothing client-supplied is reflected.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>E2E test identity provider</title>
<style>body{font:16px system-ui;margin:3rem auto;max-width:28rem}label,input,button{display:block;margin:.5rem 0}</style>
</head><body>
<main>
<h1>E2E test identity provider</h1>
<p>Test-only. Any username is accepted.</p>
<form method="post" action="${BROWSER_BASE}/login">
<input type="hidden" name="request" value="${requestId}">
<label for="username">Username</label>
<input id="username" name="username" autocomplete="off" required pattern="[a-z0-9][a-z0-9-]{1,31}">
<button type="submit">Sign in</button>
</form>
</main>
</body></html>`;
}

const server = createServer(async (req, res) => {
  sweep();
  const url = new URL(req.url ?? '/', 'http://provider.invalid');

  try {
    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      sendJson(res, 200, {
        issuer: ISSUER,
        // Browser-facing endpoints on the published loopback port; server-side
        // ones on the compose network. Both are valid OIDC: an endpoint need
        // not share the issuer's host.
        authorization_endpoint: `${BROWSER_BASE}/authorize`,
        end_session_endpoint: `${BROWSER_BASE}/end-session`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        scopes_supported: ['openid', 'profile', 'email'],
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/jwks') {
      sendJson(res, 200, { keys: [JWK] });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/authorize') {
      const p = url.searchParams;
      if (p.get('client_id') !== CLIENT_ID) return sendError(res, 400, 'Unknown client.');
      if (p.get('redirect_uri') !== REDIRECT_URI) return sendError(res, 400, 'redirect_uri is not registered for this client.');
      if (p.get('response_type') !== 'code') return sendError(res, 400, 'Only response_type=code is supported.');
      if (!(p.get('scope') ?? '').split(' ').includes('openid')) return sendError(res, 400, 'scope must include openid.');
      if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) return sendError(res, 400, 'PKCE S256 is required.');
      if (!p.get('state') || !p.get('nonce')) return sendError(res, 400, 'state and nonce are required.');

      const requestId = randomBytes(24).toString('base64url');
      requests.set(requestId, {
        state: p.get('state'),
        nonce: p.get('nonce'),
        codeChallenge: p.get('code_challenge'),
        expiresAt: Date.now() + REQUEST_TTL_MS,
      });
      res.writeHead(200, HTML_HEADERS);
      res.end(loginPage(requestId));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/login') {
      const form = await readForm(req);
      const requestId = form.get('request') ?? '';
      const pending = requests.get(requestId);
      if (!pending) return sendError(res, 400, 'This sign-in request expired or was already used.');
      requests.delete(requestId);

      const username = (form.get('username') ?? '').trim();
      if (!USERNAME.test(username)) return sendError(res, 400, 'Invalid username.');

      const code = randomBytes(32).toString('base64url');
      codes.set(code, { ...pending, username, expiresAt: Date.now() + CODE_TTL_MS });
      const back = new URL(REDIRECT_URI);
      back.searchParams.set('code', code);
      back.searchParams.set('state', pending.state);
      res.writeHead(302, { location: back.href, 'cache-control': 'no-store' });
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/token') {
      const form = await readForm(req);
      let clientId = form.get('client_id');
      let clientSecret = form.get('client_secret');
      const basic = /^Basic (.+)$/i.exec(req.headers.authorization ?? '');
      if (basic) {
        const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        clientId = decodeURIComponent(decoded.slice(0, colon));
        clientSecret = decodeURIComponent(decoded.slice(colon + 1));
      }
      if (clientId !== CLIENT_ID || !safeEqual(clientSecret ?? '', CLIENT_SECRET)) {
        return sendJson(res, 401, { error: 'invalid_client' });
      }
      if (form.get('grant_type') !== 'authorization_code') return sendJson(res, 400, { error: 'unsupported_grant_type' });

      const code = form.get('code') ?? '';
      const grant = codes.get(code);
      // Single use: deleted before any further check, so a replay never succeeds.
      codes.delete(code);
      if (!grant || grant.expiresAt < Date.now()) return sendJson(res, 400, { error: 'invalid_grant' });
      if (form.get('redirect_uri') !== REDIRECT_URI) return sendJson(res, 400, { error: 'invalid_grant' });
      if (!safeEqual(s256(form.get('code_verifier') ?? ''), grant.codeChallenge)) {
        return sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }

      const now = Math.floor(Date.now() / 1000);
      const idToken = signJwt({
        iss: ISSUER,
        sub: grant.username,
        aud: CLIENT_ID,
        iat: now,
        exp: now + ID_TOKEN_TTL_S,
        nonce: grant.nonce,
        email: `${grant.username}@e2e.jumptotech.test`,
        name: `E2E ${grant.username}`,
      });
      // The access token is opaque and unused: the API discards it at the callback.
      sendJson(res, 200, {
        token_type: 'Bearer',
        expires_in: ID_TOKEN_TTL_S,
        id_token: idToken,
        access_token: randomBytes(24).toString('base64url'),
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/end-session') {
      const target = url.searchParams.get('post_logout_redirect_uri');
      // Only back to the registered application origin — never an open redirect.
      if (target && new URL(target, REDIRECT_ORIGIN).origin === REDIRECT_ORIGIN) {
        res.writeHead(302, { location: new URL(target, REDIRECT_ORIGIN).href, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      res.writeHead(200, HTML_HEADERS);
      res.end('<!doctype html><title>Signed out</title><h1>Signed out of the E2E test identity provider</h1>');
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  } catch {
    sendJson(res, 400, { error: 'invalid_request' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[e2e-oidc] test identity provider listening on :${PORT} (issuer ${ISSUER})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
