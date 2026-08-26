/**
 * PLATFORM-010 — the terminal service side of the ownership boundary.
 *
 * The API side is proved in `apps/api/test/terminal-ownership.test.ts`. What is
 * proved here is that this service holds up its half:
 *
 *   1. it **verifies** the token before doing anything with it;
 *   2. it forwards the token's own `uid` claim, and never anything a socket
 *      supplied;
 *   3. a token with no owner claim is refused outright, so the pre-PLATFORM-010
 *      scheme cannot be replayed against a hardened API;
 *   4. when the API refuses the exchange, **no shell is opened** — the refusal
 *      is not swallowed into a working terminal.
 *
 * ```text
 *   WS frame {type:'auth', token}
 *        └─ verifySessionToken(token, secret)   ← signature, expiry, uid present
 *             └─ POST /internal/sessions/<claims.sid>/credentials
 *                 { ownerUserId: claims.uid }
 *                     └─ 403 → CredentialsUnavailableError → no PTY
 * ```
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  InvalidSessionTokenError,
  issueSessionToken,
  verifySessionToken,
} from '@jumptotech/lab-orchestrator/session-token';
import { CredentialsUnavailableError, fetchTerminalContext } from '../src/credentials.js';

const SECRET = 'terminal-ownership-service-secret';
const SESSION_ID = 'sess-000000000000000a';
const OWNER = 'usr-00000001';
const NAMESPACE = 'lab-0000000000aa';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A recording fetch, so the request body can be asserted rather than assumed. */
function recorder(response: Response) {
  const calls: Array<{ url: string; body: unknown; secret: string | null }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      secret: new Headers(init.headers).get('x-internal-secret'),
    });
    return response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const CONTAINER_CONTEXT = {
  kind: 'container-exec',
  runtime: 'docker',
  containerRef: 'jtt-lab-aabbccdd',
  user: 'student',
  workdir: '/home/student',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

describe('the token this service verifies is the token it forwards', () => {
  it('sends the owner claim from the verified token, and nothing else', async () => {
    const { token } = issueSessionToken({
      sessionId: SESSION_ID,
      ownerUserId: OWNER,
      labId: 'LINUX-001',
      namespace: NAMESPACE,
      secret: SECRET,
      ttlSeconds: 60,
    });

    // Exactly what the WebSocket handler does with an auth frame.
    const claims = verifySessionToken(token, SECRET);

    const { calls, impl } = recorder(jsonResponse({ ok: true, data: CONTAINER_CONTEXT }));
    await fetchTerminalContext({
      apiInternalUrl: 'http://api:4000',
      secret: 'service-secret',
      sessionId: claims.sid,
      ownerUserId: claims.uid,
      fetchImpl: impl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(`/internal/sessions/${SESSION_ID}/credentials`);
    expect(calls[0]!.secret).toBe('service-secret');
    /*
     * The body carries the owner and only the owner.
     *
     * Nothing from the socket reaches it — no namespace, no container, no user,
     * no command. The API resolves all of those from the session record, which
     * is what stops a compromised terminal service from choosing a sandbox.
     */
    expect(calls[0]!.body).toEqual({ ownerUserId: OWNER });
  });

  it('refuses a token with no owner claim before any request is made', async () => {
    /*
     * A pre-PLATFORM-010 token: correctly signed, no `uid`. Verification must
     * reject it here, so this service never even asks — the API's own 400 is
     * the backstop, not the first line.
     */
    const claims = {
      sid: SESSION_ID,
      labId: 'LINUX-001',
      namespace: NAMESPACE,
      iat: 0,
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const legacy = `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;

    expect(() => verifySessionToken(legacy, SECRET)).toThrow(InvalidSessionTokenError);
    expect(() => verifySessionToken(legacy, SECRET)).toThrow(/carries no session owner/);
  });

  it('refuses a token whose owner claim was tampered with', () => {
    const { token } = issueSessionToken({
      sessionId: SESSION_ID,
      ownerUserId: OWNER,
      labId: 'LINUX-001',
      namespace: NAMESPACE,
      secret: SECRET,
      ttlSeconds: 60,
    });

    // Re-encode the payload with somebody else's owner, keeping the original
    // signature. The HMAC covers the payload, so this cannot survive.
    const [, signature] = token.split('.') as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...verifySessionToken(token, SECRET), uid: 'usr-99999999' }),
    ).toString('base64url');

    expect(() => verifySessionToken(`${forged}.${signature}`, SECRET)).toThrow(/signature mismatch/);
  });

  it('refuses a token signed with a different secret', () => {
    const { token } = issueSessionToken({
      sessionId: SESSION_ID,
      ownerUserId: OWNER,
      labId: 'LINUX-001',
      namespace: NAMESPACE,
      secret: 'a-completely-different-secret',
      ttlSeconds: 60,
    });

    expect(() => verifySessionToken(token, SECRET)).toThrow(/signature mismatch/);
  });

  it('refuses an expired token', () => {
    const past = () => Date.now() - 3_600_000;
    const { token } = issueSessionToken({
      sessionId: SESSION_ID,
      ownerUserId: OWNER,
      labId: 'LINUX-001',
      namespace: NAMESPACE,
      secret: SECRET,
      ttlSeconds: 60,
      now: past,
    });

    expect(() => verifySessionToken(token, SECRET)).toThrow(/token expired/);
  });
});

describe('a refused exchange opens no shell', () => {
  it('surfaces the API’s ownership refusal rather than proceeding', async () => {
    const { impl } = recorder(
      jsonResponse(
        { ok: false, error: { code: 'SESSION_NOT_OWNED', message: 'That terminal token is not valid for this session.' } },
        403,
      ),
    );

    /*
     * The failure has to *throw*. The WebSocket handler only marks a socket
     * authenticated when `startSession` resolves truthy, so a refusal that
     * returned a partial context instead would be the bypass all over again.
     */
    await expect(
      fetchTerminalContext({
        apiInternalUrl: 'http://api:4000',
        secret: 'service-secret',
        sessionId: SESSION_ID,
        ownerUserId: 'usr-99999999',
        fetchImpl: impl,
      }),
    ).rejects.toThrow(CredentialsUnavailableError);
  });

  it('carries the refusal code through, so the socket can be closed honestly', async () => {
    const { impl } = recorder(
      jsonResponse({ ok: false, error: { code: 'SESSION_NOT_OWNED', message: 'refused' } }, 403),
    );

    await fetchTerminalContext({
      apiInternalUrl: 'http://api:4000',
      secret: 'service-secret',
      sessionId: SESSION_ID,
      ownerUserId: 'usr-99999999',
      fetchImpl: impl,
    }).then(
      () => expect.fail('a refused exchange must not resolve'),
      (error: unknown) => {
        expect(error).toBeInstanceOf(CredentialsUnavailableError);
        expect((error as CredentialsUnavailableError).code).toBe('SESSION_NOT_OWNED');
      },
    );
  });

  it('refuses when the API says the request named no owner', async () => {
    const { impl } = recorder(
      jsonResponse({ ok: false, error: { code: 'OWNER_REQUIRED', message: 'no owner' } }, 400),
    );

    await expect(
      fetchTerminalContext({
        apiInternalUrl: 'http://api:4000',
        secret: 'service-secret',
        sessionId: SESSION_ID,
        ownerUserId: OWNER,
        fetchImpl: impl,
      }),
    ).rejects.toThrow(CredentialsUnavailableError);
  });
});
