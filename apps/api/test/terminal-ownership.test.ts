/**
 * PLATFORM-010 — the terminal path proves as much as the HTTP path.
 *
 * ## The gap this closes
 *
 * Before this story, `POST /internal/sessions/:id/credentials` released a
 * session's terminal binding on the strength of the shared service secret and a
 * signed terminal token. Every REST route proved ownership against the stored
 * `ownerUserId`; this path did not. The two reach the same sandbox, so the
 * WebSocket was the weaker of two doors to one room:
 *
 * ```text
 *   HTTP   token/cookie ─► req.user ─► authorize(user, action, session) ─► sandbox
 *   WS     terminal token ─────────────────────────────────────────────► sandbox
 *                          ▲ no ownership check lived here
 * ```
 *
 * The token was only ever handed to the owner, so this was defence in depth
 * rather than a live hole — but "the only issuer is careful" is not a boundary,
 * and a token that leaks, or a session that changes hands, had no second gate.
 *
 * Now the token carries `uid`, the terminal service forwards it, and the API
 * re-checks it against the live session record before releasing anything.
 *
 * These tests drive the *API side* of that exchange directly, standing in for
 * the terminal service. `services/terminal/test/terminal-ownership.test.ts`
 * covers the service side.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
  issueSessionToken,
  verifySessionToken,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes, fakeExec } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { DevelopmentIdentityResolver } from '../src/auth/resolvers.js';
import { InMemoryUserRepository } from '../src/auth/users.js';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'terminal-ownership-secret-value';
const ALICE = 'Developer alice';
const BOB = 'Developer bob';

let registry: LabRegistry;
beforeAll(async () => {
  registry = await realCatalog();
});

let app: Express;
let users: InMemoryUserRepository;

beforeEach(async () => {
  const config = loadConfig({
    TERMINAL_SESSION_SECRET: SECRET,
    INTERNAL_SERVICE_SECRET: SECRET,
    LABS_DIR: path.join(repoRoot, 'labs'),
    ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_MODE: 'development',
  } as NodeJS.ProcessEnv);

  users = new InMemoryUserRepository();
  const k8s = new FakeKubernetes();
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({
    provider: new KindLabProvider({ k8s, clusterName: 'jumptotech-labs', exec: fakeExec() }),
  });
  providers.register({ provider: new LinuxLabProvider({ runtime: new FakeContainerRuntime() }) });

  app = createApp({
    registry,
    sessions: new SessionManager({
      registry,
      providers,
      store: new InMemorySessionStore(),
      policy: DEFAULT_SESSION_POLICY,
      lifetimes: config.lifetimes,
      namespaceSecret: SECRET,
    }),
    k8s,
    config,
    identityResolver: new DevelopmentIdentityResolver(users),
    browserAuth: { users },
  });
});

async function start(who: string, labId = 'LINUX-001') {
  const res = await request(app).post(`/api/labs/${labId}/start`).set('Authorization', who);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as {
    session: { sessionId: string; sandboxRef: string; namespace: string };
    terminal: { token: string };
  };
}

/** Exactly what the terminal service sends after verifying a token. */
function credentials(sessionId: string, body?: Record<string, unknown>) {
  const call = request(app)
    .post(`/internal/sessions/${sessionId}/credentials`)
    .set('x-internal-secret', SECRET);
  return body ? call.send(body) : call.send({});
}

describe('the terminal token is bound to the session owner', () => {
  it('carries the owner the server decided on, not one the browser named', async () => {
    const started = await start(ALICE);
    const claims = verifySessionToken(started.terminal.token, SECRET);

    expect(claims.sid).toBe(started.session.sessionId);
    expect(claims.uid).toMatch(/^usr-/);

    // Two students, two owners. If `uid` came from anything the client sent,
    // these could be made to agree.
    const other = await start(BOB);
    expect(verifySessionToken(other.terminal.token, SECRET).uid).not.toBe(claims.uid);
  });

  it('refuses to mint a token with no owner', () => {
    // Guarded at the source, so the gap cannot be reintroduced by a caller that
    // simply omits the field.
    expect(() =>
      issueSessionToken({
        sessionId: 'sess-000000000000000a',
        ownerUserId: '',
        labId: 'LINUX-001',
        namespace: 'lab-0000000000aa',
        secret: SECRET,
        ttlSeconds: 60,
      }),
    ).toThrow(/requires the owning user id/);
  });

  it('refuses to verify a token minted before ownership binding existed', () => {
    /*
     * A token from the old scheme: correctly signed with the real secret, and
     * carrying no `uid`. It must fail closed — treating "no owner claim" as
     * "unowned, allow" is precisely the behaviour being removed.
     */
    const claims = { sid: 'sess-000000000000000a', labId: 'LINUX-001', namespace: 'lab-0000000000aa', iat: 0, exp: Math.floor(Date.now() / 1000) + 60 };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const legacy = `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;

    expect(() => verifySessionToken(legacy, SECRET)).toThrow(/carries no session owner/);
  });
});

describe('the internal credential exchange re-proves ownership', () => {
  it('releases a binding to the owner named in the token', async () => {
    const started = await start(ALICE);
    const { uid } = verifySessionToken(started.terminal.token, SECRET);

    const res = await credentials(started.session.sessionId, { ownerUserId: uid });

    expect(res.status).toBe(200);
    expect(res.body.data.kind).toBe('container-exec');
    expect(res.body.data.containerRef).toBe(started.session.sandboxRef);
  });

  it('refuses a request that names no owner', async () => {
    const started = await start(ALICE);

    const res = await credentials(started.session.sessionId);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OWNER_REQUIRED');
    // Nothing leaked in the refusal.
    expect(JSON.stringify(res.body)).not.toMatch(/containerRef|kubeconfig|clientKey/);
  });

  it('refuses when the named owner is not the session’s owner', async () => {
    const alice = await start(ALICE);
    const bob = await start(BOB);
    const bobUid = verifySessionToken(bob.terminal.token, SECRET).uid;

    // Bob's owner id, Alice's session. This is the WebSocket-side equivalent of
    // Bob calling GET /api/sessions/<alice's id>, and it must fail the same way.
    const res = await credentials(alice.session.sessionId, { ownerUserId: bobUid });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SESSION_NOT_OWNED');
    expect(JSON.stringify(res.body)).not.toMatch(/containerRef|kubeconfig|clientKey/);
  });

  it('refuses Bob’s own valid token pointed at Alice’s session', async () => {
    const alice = await start(ALICE);
    const bob = await start(BOB);

    /*
     * The whole attack, end to end: Bob holds a genuine terminal token — his
     * own — and Alice's session id, which travels in URLs, logs and
     * screenshots. Before this change the pair was enough, because nothing
     * compared them. Now they must agree with one stored row.
     */
    const bobClaims = verifySessionToken(bob.terminal.token, SECRET);
    const res = await credentials(alice.session.sessionId, { ownerUserId: bobClaims.uid });

    expect(res.status).toBe(403);

    // And Alice's own attach still works, so the check is discriminating rather
    // than simply refusing everything.
    const aliceClaims = verifySessionToken(alice.terminal.token, SECRET);
    expect((await credentials(alice.session.sessionId, { ownerUserId: aliceClaims.uid })).status).toBe(200);
  });

  it('refuses an owner id that was never a user', async () => {
    const started = await start(ALICE);

    for (const forged of ['usr-00000000', 'alice', '*', "' OR '1'='1", 'undefined']) {
      const res = await credentials(started.session.sessionId, { ownerUserId: forged });
      expect(res.status, forged).toBe(403);
    }
  });

  it('refuses a non-string owner id rather than coercing it', async () => {
    const started = await start(ALICE);

    for (const forged of [null, 42, true, { toString: () => 'usr-00000001' }, ['usr-00000001']]) {
      const res = await credentials(started.session.sessionId, { ownerUserId: forged });
      expect(res.status, JSON.stringify(forged)).toBe(400);
    }
  });

  it('is still unreachable without the internal service secret', async () => {
    const started = await start(ALICE);
    const { uid } = verifySessionToken(started.terminal.token, SECRET);

    // The owner check is an addition, not a replacement: a caller that is not
    // the terminal service gets nowhere regardless of what it names.
    const res = await request(app)
      .post(`/internal/sessions/${started.session.sessionId}/credentials`)
      .send({ ownerUserId: uid });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('stops working once the session has ended', async () => {
    const started = await start(ALICE);
    const { uid } = verifySessionToken(started.terminal.token, SECRET);

    expect((await credentials(started.session.sessionId, { ownerUserId: uid })).status).toBe(200);

    await request(app).delete(`/api/sessions/${started.session.sessionId}`).set('Authorization', ALICE);

    /*
     * The token is still inside its TTL and still verifies. The session is not
     * active, so no binding is released — a terminal token cannot outlive the
     * thing it names.
     */
    const after = await credentials(started.session.sessionId, { ownerUserId: uid });
    expect(after.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(after.body)).not.toMatch(/containerRef|kubeconfig/);
  });
});

describe('the browser is given no way to obtain a token it should not have', () => {
  it('mints a terminal token only at start, and only for the caller', async () => {
    const alice = await start(ALICE);

    /*
     * There is no "reconnect" or "resume" route that returns a terminal token
     * for an existing session — the only issuer is Start Lab, which creates the
     * session it issues for. Reading Alice's session as Alice therefore returns
     * no token at all, and reading it as Bob returns nothing whatsoever.
     */
    const own = await request(app)
      .get(`/api/sessions/${alice.session.sessionId}`)
      .set('Authorization', ALICE);
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).not.toMatch(/"token"/);

    const stolen = await request(app)
      .get(`/api/sessions/${alice.session.sessionId}`)
      .set('Authorization', BOB);
    expect(stolen.status).toBe(404);
    expect(JSON.stringify(stolen.body)).not.toMatch(/"token"/);
  });

  it('refuses to start a lab for an unauthenticated caller, so no token is minted', async () => {
    const res = await request(app)
      .post('/api/labs/LINUX-001/start')
      .set('Authorization', 'Bearer forged.token.value');

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/"token"/);
  });
});
