/**
 * PLATFORM-010 — authentication and ownership against a real PostgreSQL.
 *
 * The existing database suites cover progress (`postgres-repository-integration`)
 * and the session store's concurrency (`session-store-integration`). Neither
 * touches the two things PLATFORM-010 added: the browser session store, and
 * whether **ownership survives a restart**.
 *
 * That second one is the claim worth showing rather than arguing. In-memory
 * tests prove Alice cannot reach Bob's session inside one process. The
 * question a deployment actually asks is different:
 *
 *   1. Alice and Bob sign in, for real, through the authorization-code flow;
 *   2. Alice starts a lab;
 *   3. the API process is thrown away — new app, new session manager, new user
 *      repository, new auth session store, new connection pool — and only the
 *      database survives;
 *   4. Alice's cookie still works, she is still the same user, she still owns
 *      her session, and Bob still cannot touch it.
 *
 * A bug in how `owner_user_id` or the session-cookie hash round-trips through
 * SQL would leave every in-memory test green and every restarted deployment
 * wide open. This is the suite that would catch it.
 *
 * Named `*-integration` and gated on `RUN_DB_TESTS`, per `test-support/README.md`
 * and enforced by `test-classification.test.ts`.
 *
 *   docker run --rm -d --name jtt-test-pg -e POSTGRES_PASSWORD=test \
 *     -e POSTGRES_USER=test -e POSTGRES_DB=jumptotech_labs_test \
 *     -p 55432:5432 postgres:16-alpine
 *
 *   RUN_DB_TESTS=1 \
 *   TEST_DATABASE_URL=postgresql://test:test@localhost:55432/jumptotech_labs_test \
 *   npm run test:db
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';
import {
  DEFAULT_SESSION_POLICY,
  LabRegistry,
  LinuxLabProvider,
  PostgresSessionStore,
  ProviderRegistry,
  SessionManager,
  verifySessionToken,
} from '@jumptotech/lab-orchestrator';
import { FakeKubernetes } from '@jumptotech/lab-orchestrator/testing';
import { FakeContainerRuntime } from '@jumptotech/lab-orchestrator/testing/containers';
import {
  DevStudentIdentity,
  PostgresDatabase,
  PostgresProgressRepository,
  ProgressService,
  migrate,
} from '@jumptotech/progress';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AttemptClosingListener } from '../src/progress.js';
import { buildIdentityResolver } from '../src/auth/resolvers.js';
import { OidcTokenVerifier } from '../src/auth/oidc.js';
import { OidcBrowserClient } from '../src/auth/oidc-client.js';
import { PostgresUserRepository } from '../src/auth/users.js';
import { PostgresAuthSessionStore, hashAuthSessionId } from '../src/auth/browser-session.js';
import { startFakeIdentityProvider, type FakeIdentityProvider } from './oidc-identity.js';
import { realCatalog } from '@jumptotech/lab-orchestrator/testing/real-catalog';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SECRET = 'auth-persistence-terminal-session-secret';
const APP_URL = 'http://localhost:3000';
const API_AUDIENCE = 'jumptotech-labs-api';

const url = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === '1' && typeof url === 'string' && url.length > 0;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.log(
    '[auth-persistence] skipped — set RUN_DB_TESTS=1 and TEST_DATABASE_URL to run against a real database',
  );
  describe.skip('authentication against PostgreSQL', () => {
    it('needs RUN_DB_TESTS=1 and TEST_DATABASE_URL', () => undefined);
  });
} else {
  let idp: FakeIdentityProvider;
  let registry: LabRegistry;
  let db: PostgresDatabase;
  /** Every pool a simulated API process opened, closed at the end. */
  const pools: PostgresDatabase[] = [];

  function connect(): PostgresDatabase {
    return PostgresDatabase.fromConfig({
      url: url!,
      ssl: false,
      maxConnections: 4,
      connectionTimeoutMs: 5_000,
      idleTimeoutMs: 5_000,
      statementTimeoutMs: 10_000,
      applicationName: 'jumptotech-auth-persistence-tests',
    });
  }

  beforeAll(async () => {
    idp = await startFakeIdentityProvider();
    registry = await realCatalog();
    expect(registry.loadErrors).toEqual([]);
    db = connect();
    // Migration 004 is applied here, against the real server, before anything
    // below can run. A broken migration fails the whole suite at this line.
    await migrate(db);
  });

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.close().catch(() => undefined)));
    await db.close();
    await idp.close();
  });

  beforeEach(async () => {
    // CASCADE reaches auth_sessions and lab_sessions through their foreign
    // keys, which is itself part of what this suite is checking.
    await db.query('TRUNCATE users, lab_sessions, hint_usage, lab_attempts, lab_progress, students RESTART IDENTITY CASCADE');
  });

  /**
   * A complete API, composed the way `index.ts` composes a durable one.
   *
   * Every call builds a *new* one over the same database — new pool, new
   * repositories, new session manager, new container runtime. That is what
   * makes "the process was thrown away" a real claim rather than a comment.
   */
  function buildApp(
    shared: FakeContainerRuntime = new FakeContainerRuntime(),
  ): { app: Express; runtime: FakeContainerRuntime } {
    const config = loadConfig({
      TERMINAL_SESSION_SECRET: SECRET,
      INTERNAL_SERVICE_SECRET: SECRET,
      LABS_DIR: path.join(repoRoot, 'labs'),
      ALLOWED_ORIGINS: APP_URL,
      PUBLIC_ORIGIN: APP_URL,
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: idp.clientId,
      OIDC_CLIENT_SECRET: idp.clientSecret,
      OIDC_AUDIENCE: API_AUDIENCE,
    } as NodeJS.ProcessEnv);

    const pool = connect();
    pools.push(pool);
    const users = new PostgresUserRepository(pool, 'oidc');
    const authSessions = new PostgresAuthSessionStore(pool);
    /*
     * The sandbox runtime stands in for the Docker daemon, which outlives an
     * API restart. Passing the same one models "the process was thrown away";
     * a fresh one would model the host dying too, which is a different — and
     * for ownership, uninteresting — scenario.
     */
    const runtime = shared;
    const k8s = new FakeKubernetes();

    const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
    providers.register({ provider: new LinuxLabProvider({ runtime }) });

    // Durable learning history too, or attempts would quietly land in memory
    // and the history assertions below would prove nothing.
    const progress = new ProgressService({ repository: new PostgresProgressRepository(pool) });

    const sessions = new SessionManager({
      registry,
      providers,
      // The durable store, so ownership is written to and read from SQL.
      store: new PostgresSessionStore(pool),
      policy: DEFAULT_SESSION_POLICY,
      lifetimes: config.lifetimes,
      namespaceSecret: SECRET,
      listener: new AttemptClosingListener(progress),
    });

    const app = createApp({
      registry,
      sessions,
      k8s,
      config,
      identityResolver: buildIdentityResolver({
        config: { mode: 'oidc', nodeEnv: 'test' },
        users,
        verifier: new OidcTokenVerifier({ issuer: idp.issuer, audience: API_AUDIENCE }),
      }),
      progress: {
        progress,
        identity: new DevStudentIdentity({ studentId: config.progress.devStudentId }),
        store: 'postgres',
        durable: true,
      },
      browserAuth: {
        users,
        authSessions,
        client: new OidcBrowserClient({
          issuer: idp.issuer,
          clientId: idp.clientId,
          clientSecret: idp.clientSecret,
          redirectUri: config.auth.browserFlow!.redirectUri,
          scopes: config.auth.browserFlow!.scopes,
        }),
        idTokenVerifier: new OidcTokenVerifier({ issuer: idp.issuer, audience: idp.clientId }),
      },
    });

    return { app, runtime };
  }

  function cookieValue(setCookie: string[] | undefined, name: string): string | undefined {
    for (const header of setCookie ?? []) {
      const match = new RegExp(`^${name}=([^;]*)`).exec(header);
      if (match && match[1]) return match[1];
    }
    return undefined;
  }

  /** The complete browser sign-in, every hop real. */
  async function signIn(app: Express, subject: string, name: string): Promise<string> {
    idp.signInAs({ subject, email: `${name}@example.test`, name });

    const login = await request(app).get('/auth/login').query({ returnTo: '/' });
    expect(login.status, JSON.stringify(login.body)).toBe(302);
    const tx = (login.headers['set-cookie'] as unknown as string[])
      .map((c) => c.split(';')[0])
      .join('; ');

    const authorize = await fetch(login.headers.location as string, { redirect: 'manual' });
    const back = new URL(authorize.headers.get('location')!);

    const callback = await request(app)
      .get('/auth/callback')
      .query({ code: back.searchParams.get('code')!, state: back.searchParams.get('state')! })
      .set('Cookie', tx);

    expect(callback.status, JSON.stringify(callback.body)).toBe(302);
    const value = cookieValue(callback.headers['set-cookie'] as unknown as string[], 'jtt_session');
    expect(value, 'callback set no session cookie').toBeTruthy();
    return `jtt_session=${value!}`;
  }

  async function start(app: Express, cookie: string) {
    const res = await request(app).post('/api/labs/LINUX-001/start').set('Cookie', cookie);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data as {
      session: { sessionId: string; sandboxRef: string };
      terminal: { token: string };
    };
  }

  // ------------------------------------------------ the browser session store

  describe('PostgresAuthSessionStore against a real server', () => {
    /** A user row to hang sessions off; the foreign key is real. */
    async function aUser(subject = 'auth0|store-user'): Promise<string> {
      const users = new PostgresUserRepository(db, 'oidc');
      const user = await users.upsert({ issuer: idp.issuer, subject });
      return user.userId;
    }

    it('stores the hash and never the cookie value', async () => {
      const store = new PostgresAuthSessionStore(db);
      const created = await store.create(await aUser(), 3600);

      const { rows } = await db.query<{ auth_session_id: string }>(
        'SELECT auth_session_id FROM auth_sessions',
      );
      expect(rows).toHaveLength(1);
      // Read straight out of the table: what is stored is the digest, so a
      // database copy is not a set of usable cookies.
      expect(rows[0]!.auth_session_id).toBe(hashAuthSessionId(created.cookieValue));
      expect(rows[0]!.auth_session_id).not.toBe(created.cookieValue);
    });

    it('holds no credential column at all', async () => {
      const { rows } = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'auth_sessions'`,
      );
      const columns = rows.map((r) => r.column_name).sort();
      // The whole schema, asserted exactly. A token column added later fails here.
      expect(columns).toEqual(['auth_session_id', 'created_at', 'expires_at', 'user_id']);
    });

    it('round-trips a session through SQL', async () => {
      const store = new PostgresAuthSessionStore(db);
      const userId = await aUser();
      const created = await store.create(userId, 3600);

      const resolved = await store.resolve(created.cookieValue);
      expect(resolved?.userId).toBe(userId);
      expect(Date.parse(resolved!.expiresAt)).toBeGreaterThan(Date.now());
    });

    it('rejects an expired session in SQL, not in JavaScript', async () => {
      const store = new PostgresAuthSessionStore(db);
      const userId = await aUser();
      const created = await store.create(userId, 3600);

      /*
       * Age the row server-side. `created_at` moves with `expires_at` because
       * the CHECK constraint forbids an expiry that precedes creation — so an
       * expired session is one that was issued in the past, not one that was
       * retroactively invalidated.
       *
       * `resolve` filters on `expires_at > now()` inside the statement, so this
       * must fail even though the API process's own clock still believes the
       * session is live — the case that matters when an instance has drifted.
       */
      await db.query(
        `UPDATE auth_sessions
            SET created_at = now() - interval '2 hours',
                expires_at = now() - interval '1 second'`,
      );

      expect(await store.resolve(created.cookieValue)).toBeNull();
    });

    it('destroys a session, idempotently', async () => {
      const store = new PostgresAuthSessionStore(db);
      const created = await store.create(await aUser(), 3600);

      expect(await store.destroy(created.cookieValue)).toBe(true);
      expect(await store.destroy(created.cookieValue)).toBe(false);
      expect(await store.resolve(created.cookieValue)).toBeNull();
    });

    it('signs one user out everywhere without touching another', async () => {
      const store = new PostgresAuthSessionStore(db);
      const alice = await aUser('auth0|alice-store');
      const bob = await aUser('auth0|bob-store');

      const a1 = await store.create(alice, 3600);
      const a2 = await store.create(alice, 3600);
      const b1 = await store.create(bob, 3600);

      expect(await store.destroyAllForUser(alice)).toBe(2);
      expect(await store.resolve(a1.cookieValue)).toBeNull();
      expect(await store.resolve(a2.cookieValue)).toBeNull();
      expect(await store.resolve(b1.cookieValue)).not.toBeNull();
    });

    it('revokes every session when the user row is deleted', async () => {
      const store = new PostgresAuthSessionStore(db);
      const userId = await aUser('auth0|to-be-deleted');
      const created = await store.create(userId, 3600);

      // ON DELETE CASCADE is the revocation path: no application code, and no
      // window in which a removed account still holds a live cookie.
      await db.query('DELETE FROM users WHERE user_id = $1', [userId]);

      expect(await store.resolve(created.cookieValue)).toBeNull();
      const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM auth_sessions');
      expect(rows[0]!.n).toBe(0);
    });

    it('purges expired rows and leaves live ones', async () => {
      const store = new PostgresAuthSessionStore(db);
      const userId = await aUser();
      const live = await store.create(userId, 3600);
      await store.create(userId, 3600);
      await db.query(
        `UPDATE auth_sessions
            SET created_at = now() - interval '2 hours',
                expires_at = now() - interval '1 hour'
          WHERE auth_session_id <> $1`,
        [hashAuthSessionId(live.cookieValue)],
      );

      expect(await store.purgeExpired()).toBe(1);
      expect(await store.resolve(live.cookieValue)).not.toBeNull();
    });

    it('refuses a row whose expiry precedes its creation', async () => {
      const userId = await aUser();
      // The CHECK constraint is real, so a clock or caller bug is refused by
      // the database rather than debugged later through a failing lookup.
      await expect(
        db.query(
          `INSERT INTO auth_sessions (auth_session_id, user_id, expires_at)
                VALUES ($1, $2, now() - interval '1 hour')`,
          ['0'.repeat(64), userId],
        ),
      ).rejects.toThrow(/auth_sessions_expiry_after_creation/);
    });
  });

  // ----------------------------------------------- identity across restarts

  describe('an identity survives the process that created it', () => {
    it('recognises the same browser after the API is thrown away', async () => {
      const first = buildApp();
      const cookie = await signIn(first.app, 'auth0|alice', 'alice');

      const before = await request(first.app).get('/auth/session').set('Cookie', cookie);
      expect(before.body.data.identity.subject).toBe('auth0|alice');

      // Everything but the database and the daemon is discarded.
      const second = buildApp(first.runtime);

      const after = await request(second.app).get('/auth/session').set('Cookie', cookie);
      expect(after.status).toBe(200);
      expect(after.body.data.authenticated).toBe(true);
      expect(after.body.data.identity).toMatchObject({
        subject: 'auth0|alice',
        issuer: idp.issuer,
        email: 'alice@example.test',
        role: 'STUDENT',
        source: 'oidc',
      });
    });

    it('resolves one account for a subject that signs in twice', async () => {
      const first = buildApp();
      await signIn(first.app, 'auth0|alice', 'alice');
      const second = buildApp(first.runtime);
      await signIn(second.app, 'auth0|alice', 'alice');

      // Upsert on (issuer, subject): a second sign-in is the same person, not
      // a second account that would inherit none of their history.
      const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
      expect(rows[0]!.n).toBe(1);
      const sessions = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM auth_sessions');
      // Two browsers, though — signing in again does not invalidate the first.
      expect(sessions.rows[0]!.n).toBe(2);
    });

    it('stops honouring a cookie signed out on another instance', async () => {
      const first = buildApp();
      const cookie = await signIn(first.app, 'auth0|alice', 'alice');

      // Sign out here…
      expect((await request(first.app).post('/auth/logout').set('Cookie', cookie)).status).toBe(200);

      // …and the cookie is dead over there too, because the record is gone
      // rather than a local cache having been cleared.
      const second = buildApp(first.runtime);
      const after = await request(second.app).get('/auth/session').set('Cookie', cookie);
      expect(after.body.data.authenticated).toBe(false);
      expect((await request(second.app).post('/api/labs/LINUX-001/start').set('Cookie', cookie)).status).toBe(401);
    });
  });

  // -------------------------------------------- ownership across restarts

  describe('session ownership survives persistence and reload', () => {
    it('keeps a session with its owner, and keeps everyone else out', async () => {
      const first = buildApp();
      const alice = await signIn(first.app, 'auth0|alice', 'alice');
      const bob = await signIn(first.app, 'auth0|bob', 'bob');
      const owned = await start(first.app, alice);

      /*
       * The whole API is discarded — pool, repositories, session manager,
       * container runtime. Only the database survives, which is exactly what a
       * rolling deploy or a crash looks like from a student's browser. The
       * sandbox runtime is carried over because a daemon outlives an API
       * process; the session record and its owner come only from SQL.
       */
      const second = buildApp(first.runtime);

      // Alice still owns it.
      const mine = await request(second.app)
        .get(`/api/sessions/${owned.session.sessionId}`)
        .set('Cookie', alice);
      expect(mine.status).toBe(200);
      expect(mine.body.data.session.sessionId).toBe(owned.session.sessionId);

      // Bob still does not — on every operation the API offers.
      const denied: Array<[string, () => request.Test]> = [
        ['read', () => request(second.app).get(`/api/sessions/${owned.session.sessionId}`)],
        ['check', () => request(second.app).post(`/api/sessions/${owned.session.sessionId}/check`)],
        ['reset', () => request(second.app).post(`/api/sessions/${owned.session.sessionId}/reset`)],
        ['activity', () => request(second.app).post(`/api/sessions/${owned.session.sessionId}/activity`)],
        ['hint', () => request(second.app).post(`/api/sessions/${owned.session.sessionId}/hints`).send({ level: 1 })],
        ['end', () => request(second.app).delete(`/api/sessions/${owned.session.sessionId}`)],
      ];
      for (const [name, call] of denied) {
        const res = await call().set('Cookie', bob);
        expect(res.status, `${name} after reload`).toBe(404);
        expect(res.body.error.code, name).toBe('SESSION_NOT_FOUND');
      }

      // And it is still Alice's afterwards.
      expect(
        (await request(second.app).get(`/api/sessions/${owned.session.sessionId}`).set('Cookie', alice)).status,
      ).toBe(200);
    });

    it('stores the owner as the authenticated user, not as anything sent', async () => {
      const { app } = buildApp();
      const alice = await signIn(app, 'auth0|alice', 'alice');

      const started = await request(app)
        .post('/api/labs/LINUX-001/start')
        .set('Cookie', alice)
        .query({ ownerUserId: 'somebody-else' })
        .send({ ownerUserId: 'somebody-else' });
      expect(started.status).toBe(200);

      const { rows } = await db.query<{ owner_user_id: string; subject: string }>(
        `SELECT s.owner_user_id, u.subject
           FROM lab_sessions s JOIN users u ON u.user_id = s.owner_user_id
          WHERE s.session_id = $1`,
        [started.body.data.session.sessionId],
      );
      // Read from the row itself: the stored owner is the verified subject.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.subject).toBe('auth0|alice');
    });

    it('binds the terminal token to the persisted owner', async () => {
      const first = buildApp();
      const alice = await signIn(first.app, 'auth0|alice', 'alice');
      const owned = await start(first.app, alice);
      const claims = verifySessionToken(owned.terminal.token, SECRET);

      const { rows } = await db.query<{ owner_user_id: string }>(
        'SELECT owner_user_id FROM lab_sessions WHERE session_id = $1',
        [owned.session.sessionId],
      );
      // The claim the terminal service presents back is the stored owner, so
      // the credential exchange compares like with like across a restart.
      expect(claims.uid).toBe(rows[0]!.owner_user_id);

      const second = buildApp(first.runtime);
      const exchange = await request(second.app)
        .post(`/internal/sessions/${owned.session.sessionId}/credentials`)
        .set('x-internal-secret', SECRET)
        .send({ ownerUserId: claims.uid });
      expect(exchange.status).toBe(200);
      expect(exchange.body.data.containerRef).toBe(owned.session.sandboxRef);
    });

    it('refuses a terminal exchange for the wrong owner after reload', async () => {
      const first = buildApp();
      const alice = await signIn(first.app, 'auth0|alice', 'alice');
      const bob = await signIn(first.app, 'auth0|bob', 'bob');
      const aliceSession = await start(first.app, alice);
      const bobSession = await start(first.app, bob);
      const bobUid = verifySessionToken(bobSession.terminal.token, SECRET).uid;

      const second = buildApp(first.runtime);
      const res = await request(second.app)
        .post(`/internal/sessions/${aliceSession.session.sessionId}/credentials`)
        .set('x-internal-secret', SECRET)
        .send({ ownerUserId: bobUid });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('SESSION_NOT_OWNED');
      expect(JSON.stringify(res.body)).not.toMatch(/containerRef|kubeconfig/);
    });

    it('keeps learning history attached to the right account across a restart', async () => {
      const first = buildApp();
      const alice = await signIn(first.app, 'auth0|alice', 'alice');
      const bob = await signIn(first.app, 'auth0|bob', 'bob');
      await start(first.app, alice);

      const second = buildApp(first.runtime);
      const aliceHistory = await request(second.app).get('/api/me/attempts').set('Cookie', alice);
      const bobHistory = await request(second.app).get('/api/me/attempts').set('Cookie', bob);

      expect(aliceHistory.body.data.attempts).toHaveLength(1);
      expect(bobHistory.body.data.attempts).toEqual([]);
      expect(aliceHistory.body.data.student.authenticated).toBe(true);
      expect(aliceHistory.body.data.student.studentId).not.toBe(
        bobHistory.body.data.student.studentId,
      );
    });

    it('leaves an orphaned session reachable by nobody', async () => {
      const first = buildApp();
      const alice = await signIn(first.app, 'auth0|alice', 'alice');
      const bob = await signIn(first.app, 'auth0|bob', 'bob');
      const owned = await start(first.app, alice);

      /*
       * Clear the owner, as a session created before authentication existed
       * would have been. `policy.ts` says such a session belongs to nobody and
       * is reachable by no student; this proves the durable path agrees.
       */
      await db.query('UPDATE lab_sessions SET owner_user_id = NULL WHERE session_id = $1', [
        owned.session.sessionId,
      ]);

      const second = buildApp(first.runtime);
      for (const cookie of [alice, bob]) {
        const res = await request(second.app)
          .get(`/api/sessions/${owned.session.sessionId}`)
          .set('Cookie', cookie);
        expect(res.status).toBe(404);
      }
    });
  });
}
