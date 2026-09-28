/**
 * Lab access against a real PostgreSQL — migration 006 and `PostgresAccessStore`.
 *
 * The in-memory store proves the rules; this proves the SQL keeps them: the
 * migration applies on top of 001–005, one entitlement row per user holds under
 * two pools racing, every change has its event and the events chain, the
 * window survives the round trip to the millisecond, and a new process sees
 * exactly what the old one wrote.
 *
 * Migration 009 (kind and plan) is proven the same way, including over a
 * database that already holds 006-era rows, which must read as what they
 * meant: STANDARD, no plan.
 *
 * Named `*-integration` and gated on `RUN_DB_TESTS`, per `test-support/README.md`.
 *
 *   make test-db TEST_DB_PORT=55463
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MIGRATIONS_DIR, PostgresDatabase, migrate } from '@jumptotech/progress';

import { PostgresUserRepository } from '../src/auth/users.js';
import { PostgresAccessStore } from '../src/access/postgres-store.js';
import { AccessControl, type AccessAction } from '../src/access/entitlements.js';

const url = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === '1' && typeof url === 'string' && url.length > 0;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.log('[access-persistence] skipped — set RUN_DB_TESTS=1 and TEST_DATABASE_URL to run against a real database');
  describe.skip('lab access against PostgreSQL', () => {
    it('needs RUN_DB_TESTS=1 and TEST_DATABASE_URL', () => undefined);
  });
} else {
  const pools: PostgresDatabase[] = [];
  function connect(): PostgresDatabase {
    const pool = PostgresDatabase.fromConfig({
      url: url!,
      ssl: false,
      maxConnections: 4,
      connectionTimeoutMs: 5_000,
      idleTimeoutMs: 5_000,
      statementTimeoutMs: 10_000,
      applicationName: 'jumptotech-access-persistence-tests',
    });
    pools.push(pool);
    return pool;
  }

  let db: PostgresDatabase;
  beforeAll(async () => {
    db = connect();
    await migrate(db);
    // Forward-only and idempotent: a second run applies nothing.
    const again = await migrate(db);
    expect(again.applied).toEqual([]);
  });

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.close().catch(() => undefined)));
  });

  beforeEach(async () => {
    await db.query('TRUNCATE users, lab_sessions, hint_usage, lab_attempts, lab_progress, students RESTART IDENTITY CASCADE');
  });

  const NOW = new Date('2026-10-01T12:00:00.123Z');
  const now = () => NOW;

  async function student(subject: string, email = `${subject}@example.com`) {
    return new PostgresUserRepository(db).upsert({ issuer: 'https://issuer.example.com/', subject, email });
  }

  describe('lab access against PostgreSQL', () => {
    it('grants, extends, suspends, restores and revokes, with one event per change', async () => {
      const store = new PostgresAccessStore(db);
      const { userId } = await student('alice');
      const until = '2026-12-31T23:59:59.999Z';

      const granted = await store.mutate(
        { userId, action: 'GRANT', actor: 'ops', reason: 'paid', grant: { expiresAt: until } },
        now,
      );
      expect(granted.after).toMatchObject({ status: 'ACTIVE', startsAt: NOW.toISOString(), expiresAt: until, grantedVia: 'operator' });

      // Millisecond round trip: what was written is what is read.
      expect(await store.get(userId)).toEqual(granted.after);

      const retried = await store.mutate(
        { userId, action: 'GRANT', actor: 'ops', reason: 'retry', grant: { expiresAt: until } },
        now,
      );
      expect(retried.changed).toBe(false);

      for (const action of ['SUSPEND', 'RESTORE', 'REVOKE'] as AccessAction[]) {
        await store.mutate({ userId, action, actor: 'support', reason: action.toLowerCase() }, now);
      }
      const history = await store.events(userId, 10);
      expect(history.map((event) => event.action)).toEqual(['REVOKE', 'RESTORE', 'SUSPEND', 'GRANT']);
      expect(history[3]).toMatchObject({ before: null, actor: 'ops', reason: 'paid' });
      expect(history[0]).toMatchObject({ before: { status: 'ACTIVE' }, after: { status: 'REVOKED', expiresAt: until } });

      const { rows } = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM access_entitlements');
      expect(rows[0]!.n).toBe('1');
    });

    it('serialises two processes racing on one student: the events chain and one row remains', async () => {
      const { userId } = await student('bob');
      const a = new PostgresAccessStore(connect());
      const b = new PostgresAccessStore(connect());
      await a.mutate({ userId, action: 'GRANT', actor: 'ops', reason: 'start', grant: { expiresAt: null } }, now);

      const actions: AccessAction[] = ['SUSPEND', 'RESTORE', 'SUSPEND', 'RESTORE', 'REVOKE', 'SUSPEND', 'RESTORE', 'SUSPEND'];
      await Promise.allSettled(
        actions.map((action, i) => (i % 2 ? a : b).mutate({ userId, action, actor: 'ops', reason: `race ${i}` }, now)),
      );

      const history = (await a.events(userId, 50)).reverse();
      for (let i = 1; i < history.length; i += 1) {
        expect(history[i]!.before, `event ${i}`).toEqual(history[i - 1]!.after);
      }
      expect((await b.get(userId))!.status).toBe(history.at(-1)!.after.status);
      const { rows } = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM access_entitlements WHERE user_id = $1', [userId]);
      expect(rows[0]!.n).toBe('1');
    });

    it('keeps its decisions across a restart, and enforces them from the new process', async () => {
      const { userId } = await student('carol');
      await new PostgresAccessStore(connect()).mutate(
        { userId, action: 'GRANT', actor: 'ops', reason: 'paid', grant: { expiresAt: '2026-10-02T00:00:00.000Z' } },
        now,
      );
      const fresh = new AccessControl(new PostgresAccessStore(connect()), 'entitlement', now);
      expect(await fresh.decide(userId)).toMatchObject({ allowed: true, via: 'entitlement' });
      const later = new AccessControl(new PostgresAccessStore(connect()), 'entitlement', () => new Date('2026-10-02T00:00:00.000Z'));
      expect(await later.decide(userId)).toEqual({ allowed: false, state: 'EXPIRED' });
    });

    it('finds accounts by email case-insensitively and lists every account with its access', async () => {
      const store = new PostgresAccessStore(db);
      const dave = await student('dave', 'Dave@Example.com');
      await student('erin');
      await store.mutate({ userId: dave.userId, action: 'GRANT', actor: 'ops', reason: 'x', grant: { expiresAt: null } }, now);

      const found = await store.findAccounts({ email: 'dave@EXAMPLE.com' });
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ userId: dave.userId, email: 'Dave@Example.com', entitlement: { status: 'ACTIVE', expiresAt: null } });

      const all = await store.accounts(100);
      expect(all.map((account) => account.entitlement?.status ?? 'NONE').sort()).toEqual(['ACTIVE', 'NONE']);
      expect(await store.findAccounts({ userId: 'not-a-uuid' })).toEqual([]);
    });

    it('refuses what the schema forbids even if the application were bypassed', async () => {
      const { userId } = await student('frank');
      const insert = (status: string, starts: string, expires: string | null, via = 'operator') =>
        db.query(
          `INSERT INTO access_entitlements (user_id, scope, status, starts_at, expires_at, granted_via)
                VALUES ($1, 'platform', $2, $3, $4, $5)`,
          [userId, status, starts, expires, via],
        );
      await expect(insert('ACTIVE', '2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z')).rejects.toThrow(/access_entitlements_window/);
      await expect(insert('EXPIRED', '2026-10-01T00:00:00Z', null)).rejects.toThrow(/check constraint/);
      await expect(insert('ACTIVE', '2026-10-01T00:00:00Z', null, 'stripe')).rejects.toThrow(/check constraint/);
      await insert('ACTIVE', '2026-10-01T00:00:00Z', null);
      // One row per (user, scope): a second active grant is not storable.
      await expect(insert('ACTIVE', '2026-10-01T00:00:00Z', null)).rejects.toThrow(/duplicate key/);
      // Access is not a side effect: deleting the user is refused while it exists.
      await expect(db.query('DELETE FROM users WHERE user_id = $1', [userId])).rejects.toThrow(/foreign key/);
    });

    it('stores kind and plan, keeps them on extension, and starts a trial once even with two processes racing', async () => {
      const a = new PostgresAccessStore(connect());
      const b = new PostgresAccessStore(connect());
      const { userId } = await student('gina');
      await a.mutate(
        { userId, action: 'GRANT', actor: 'ops', reason: 'beta', grant: { expiresAt: null, kind: 'BETA', planId: 'fixture-linux' } },
        now,
      );
      await b.mutate({ userId, action: 'GRANT', actor: 'ops', reason: 'extend', grant: { expiresAt: '2027-01-01T00:00:00.000Z' } }, now);
      expect(await a.get(userId)).toMatchObject({ kind: 'BETA', planId: 'fixture-linux', expiresAt: '2027-01-01T00:00:00.000Z' });
      const history = await b.events(userId, 10);
      expect(history.map((e) => [e.action, e.before?.kind ?? null, e.after.kind, e.after.planId])).toEqual([
        ['GRANT', 'BETA', 'BETA', 'fixture-linux'],
        ['GRANT', null, 'BETA', 'fixture-linux'],
      ]);

      const { userId: fresh } = await student('hugo');
      const trial = { durationDays: 7, planId: null };
      const results = await Promise.allSettled([
        a.mutate({ userId: fresh, action: 'TRIAL', actor: 'ops', reason: 'one', trial }, now),
        b.mutate({ userId: fresh, action: 'TRIAL', actor: 'ops', reason: 'two', trial }, now),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(['TRIAL_ALREADY_USED', 'ALREADY_ACTIVE']).toContain(lost.reason.code);
      expect(await a.get(fresh)).toMatchObject({ kind: 'TRIAL', expiresAt: '2026-10-08T12:00:00.123Z' });
      // Still once per account after it is revoked: the history remembers.
      await a.mutate({ userId: fresh, action: 'REVOKE', actor: 'ops', reason: 'x' }, now);
      await expect(a.mutate({ userId: fresh, action: 'TRIAL', actor: 'ops', reason: 'three', trial }, now)).rejects.toMatchObject({
        code: 'TRIAL_ALREADY_USED',
      });
    });

    it('refuses a kind or plan id the schema does not allow', async () => {
      const { userId } = await student('ines');
      const insert = (kind: string, plan: string | null) =>
        db.query(
          `INSERT INTO access_entitlements (user_id, scope, status, starts_at, expires_at, granted_via, kind, plan_id)
                VALUES ($1, 'platform', 'ACTIVE', now(), NULL, 'operator', $2, $3)`,
          [userId, kind, plan],
        );
      await expect(insert('VIP', null)).rejects.toThrow(/access_entitlements_kind/);
      await expect(insert('STANDARD', 'Gold Plan')).rejects.toThrow(/access_entitlements_plan_id/);
      await insert('STANDARD', 'fixture-linux');
    });

    it('refuses an unknown account without a cast error', async () => {
      const store = new PostgresAccessStore(db);
      await expect(
        store.mutate({ userId: '00000000-0000-4000-8000-000000000000', action: 'GRANT', actor: 'o', reason: 'x', grant: { expiresAt: null } }, now),
      ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
      await expect(
        store.mutate({ userId: 'usr-00000001', action: 'GRANT', actor: 'o', reason: 'x', grant: { expiresAt: null } }, now),
      ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
      expect(await store.get('usr-00000001')).toBeNull();
    });
  });

  describe('migration 009 over an existing 006-era database', () => {
    it('reads existing rows as STANDARD with no plan, and a second run applies nothing', { timeout: 300_000 }, async () => {
      const name = `jtt_upgrade_${process.pid}_${Date.now()}`;
      // CREATE/DROP DATABASE copy a template: slow on a busy host, so not under
      // the 10 s statement timeout the suite's pool uses.
      const admin = PostgresDatabase.fromConfig({
        url: url!,
        ssl: false,
        maxConnections: 1,
        connectionTimeoutMs: 30_000,
        idleTimeoutMs: 5_000,
        statementTimeoutMs: 120_000,
        applicationName: 'jumptotech-access-upgrade-admin',
      });
      pools.push(admin);
      await admin.query(`CREATE DATABASE ${name}`);
      const target = new URL(url!);
      target.pathname = `/${name}`;
      const old = PostgresDatabase.fromConfig({
        url: target.toString(),
        ssl: false,
        maxConnections: 2,
        connectionTimeoutMs: 5_000,
        idleTimeoutMs: 5_000,
        statementTimeoutMs: 120_000,
        applicationName: 'jumptotech-access-upgrade-test',
      });
      try {
        // The release before 009: every migration up to it, and rows it wrote.
        const before = await mkdtemp(path.join(tmpdir(), 'jtt-mig-before-009-'));
        for (const file of await readdir(MIGRATIONS_DIR)) {
          if (file.endsWith('.sql') && file < '009') await cp(path.join(MIGRATIONS_DIR, file), path.join(before, file));
        }
        await migrate(old, { dir: before });
        const user = await new PostgresUserRepository(old).upsert({ issuer: 'https://issuer.example.com/', subject: 'legacy' });
        await old.query(
          `INSERT INTO access_entitlements (user_id, scope, status, starts_at, expires_at, granted_via)
                VALUES ($1, 'platform', 'ACTIVE', '2026-09-01T00:00:00Z', NULL, 'operator')`,
          [user.userId],
        );
        await old.query(
          `INSERT INTO access_events (user_id, scope, action, actor, reason, after_status, after_starts_at)
                VALUES ($1, 'platform', 'GRANTED', 'ops', 'before 009', 'ACTIVE', '2026-09-01T00:00:00Z')`,
          [user.userId],
        );

        const report = await migrate(old);
        expect(report.applied).toEqual(['009_access_plans_and_kinds']);
        expect((await migrate(old)).applied).toEqual([]);

        const store = new PostgresAccessStore(old);
        expect(await store.get(user.userId)).toMatchObject({ status: 'ACTIVE', kind: 'STANDARD', planId: null, expiresAt: null });
        const [event] = await store.events(user.userId, 1);
        expect(event).toMatchObject({ action: 'GRANT', reason: 'before 009', after: { kind: 'STANDARD', planId: null } });
        // And the access it grants is exactly what it was: every track.
        const decision = await new AccessControl(store, 'entitlement', now).decide(user.userId, { track: 'kubernetes' });
        expect(decision).toMatchObject({ allowed: true, plan: null });

        // A release that predates 009 still inserts: its INSERT names neither column.
        const other = await new PostgresUserRepository(old).upsert({ issuer: 'https://issuer.example.com/', subject: 'rolling' });
        await old.query(
          `INSERT INTO access_entitlements (user_id, scope, status, starts_at, expires_at, granted_via)
                VALUES ($1, 'platform', 'ACTIVE', now(), NULL, 'operator')`,
          [other.userId],
        );
        expect(await store.get(other.userId)).toMatchObject({ kind: 'STANDARD', planId: null });
      } finally {
        await old.close().catch(() => undefined);
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }
    });
  });
}
