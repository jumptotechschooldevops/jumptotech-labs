/**
 * The entitlement model — `access/entitlements.ts`, without HTTP.
 *
 * The transition table, the window's boundaries and clock handling, input
 * validation, idempotence, and serialisation of concurrent changes. The HTTP
 * enforcement is `commercial-access.test.ts`; the operator surface is
 * `operator-access.test.ts`; the PostgreSQL store is
 * `access-persistence-integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { InMemoryUserRepository } from '../src/auth/users.js';
import {
  AccessControl,
  AccessError,
  InMemoryAccessStore,
  assertActor,
  assertReason,
  assertUserId,
  evaluateAccess,
  parseInstant,
  planMutation,
  type Entitlement,
  type EntitlementStatus,
} from '../src/access/entitlements.js';

const NOW = '2026-10-01T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);

function row(status: EntitlementStatus, startsAt: string, expiresAt: string | null): Entitlement {
  return {
    userId: 'usr-00000001',
    scope: 'platform',
    status,
    startsAt,
    expiresAt,
    grantedVia: 'operator',
    createdAt: startsAt,
    updatedAt: startsAt,
  };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AccessError);
    return (error as AccessError).code;
  }
  throw new Error('expected an AccessError');
}

describe('evaluateAccess: the effective state is computed, never stored', () => {
  const start = '2026-10-01T00:00:00.000Z';
  const end = '2026-11-01T00:00:00.000Z';

  it('is NONE without a row', () => {
    expect(evaluateAccess(null, NOW_MS)).toEqual({ state: 'NONE', active: false });
  });

  it('has a half-open window: in at startsAt, out at expiresAt', () => {
    const e = row('ACTIVE', start, end);
    expect(evaluateAccess(e, Date.parse(start) - 1).state).toBe('SCHEDULED');
    expect(evaluateAccess(e, Date.parse(start))).toEqual({ state: 'ACTIVE', active: true });
    expect(evaluateAccess(e, Date.parse(end) - 1).state).toBe('ACTIVE');
    expect(evaluateAccess(e, Date.parse(end))).toEqual({ state: 'EXPIRED', active: false });
  });

  it('treats a null expiry as no end date', () => {
    expect(evaluateAccess(row('ACTIVE', start, null), Date.parse('2099-01-01T00:00:00Z')).state).toBe('ACTIVE');
  });

  it('lets an operator decision win over the window', () => {
    expect(evaluateAccess(row('SUSPENDED', start, end), NOW_MS).state).toBe('SUSPENDED');
    expect(evaluateAccess(row('REVOKED', start, end), Date.parse(end) + 1).state).toBe('REVOKED');
  });
});

describe('planMutation: the transition table', () => {
  const active = row('ACTIVE', '2026-09-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z');
  const suspended = { ...active, status: 'SUSPENDED' as const };
  const revoked = { ...active, status: 'REVOKED' as const };
  const until = '2027-01-01T00:00:00.000Z';

  it('grants from nothing, starting now unless told otherwise', () => {
    expect(planMutation(null, 'GRANT', NOW, { expiresAt: until })).toEqual({
      kind: 'write',
      action: 'GRANT',
      next: { status: 'ACTIVE', startsAt: NOW, expiresAt: until },
    });
  });

  it('extends an active grant keeping its start, and re-grants a revoked one from now', () => {
    const extended = planMutation(active, 'GRANT', NOW, { expiresAt: until });
    expect(extended).toMatchObject({ kind: 'write', next: { startsAt: active.startsAt, expiresAt: until } });
    const regranted = planMutation(revoked, 'GRANT', NOW, { expiresAt: until });
    expect(regranted).toMatchObject({ kind: 'write', next: { status: 'ACTIVE', startsAt: NOW } });
  });

  it('extends an expired grant, which is ACTIVE by status', () => {
    const lapsed = row('ACTIVE', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    expect(planMutation(lapsed, 'GRANT', NOW, { expiresAt: until })).toMatchObject({
      kind: 'write',
      next: { status: 'ACTIVE', startsAt: lapsed.startsAt, expiresAt: until },
    });
  });

  it('refuses to let a grant silently lift a suspension', () => {
    expect(code(() => planMutation(suspended, 'GRANT', NOW, { expiresAt: until }))).toBe('ENTITLEMENT_SUSPENDED');
  });

  it('suspends and restores with the window unchanged', () => {
    expect(planMutation(active, 'SUSPEND', NOW)).toEqual({
      kind: 'write',
      action: 'SUSPEND',
      next: { status: 'SUSPENDED', startsAt: active.startsAt, expiresAt: active.expiresAt },
    });
    expect(planMutation(suspended, 'RESTORE', NOW)).toEqual({
      kind: 'write',
      action: 'RESTORE',
      next: { status: 'ACTIVE', startsAt: active.startsAt, expiresAt: active.expiresAt },
    });
  });

  it('revokes from active or suspended, keeping the window for the record', () => {
    expect(planMutation(active, 'REVOKE', NOW)).toMatchObject({ kind: 'write', next: { status: 'REVOKED' } });
    expect(planMutation(suspended, 'REVOKE', NOW)).toMatchObject({ kind: 'write', next: { status: 'REVOKED' } });
  });

  it('treats a change already in effect as unchanged: a retried command writes nothing', () => {
    expect(planMutation(suspended, 'SUSPEND', NOW).kind).toBe('unchanged');
    expect(planMutation(active, 'RESTORE', NOW).kind).toBe('unchanged');
    expect(planMutation(revoked, 'REVOKE', NOW).kind).toBe('unchanged');
    expect(
      planMutation(active, 'GRANT', NOW, { startsAt: active.startsAt, expiresAt: active.expiresAt }).kind,
    ).toBe('unchanged');
  });

  it('refuses what has nothing to act on', () => {
    expect(code(() => planMutation(null, 'SUSPEND', NOW))).toBe('NO_ENTITLEMENT');
    expect(code(() => planMutation(null, 'RESTORE', NOW))).toBe('NO_ENTITLEMENT');
    expect(code(() => planMutation(null, 'REVOKE', NOW))).toBe('NO_ENTITLEMENT');
    expect(code(() => planMutation(revoked, 'SUSPEND', NOW))).toBe('ENTITLEMENT_REVOKED');
    expect(code(() => planMutation(revoked, 'RESTORE', NOW))).toBe('ENTITLEMENT_REVOKED');
  });

  it('never grants without an explicit expiry decision', () => {
    expect(code(() => planMutation(null, 'GRANT', NOW))).toBe('EXPIRY_REQUIRED');
  });

  it('refuses a window that ends before it starts, or is over before it is written', () => {
    expect(
      code(() => planMutation(null, 'GRANT', NOW, { startsAt: until, expiresAt: '2026-12-31T00:00:00.000Z' })),
    ).toBe('INVALID_WINDOW');
    expect(code(() => planMutation(null, 'GRANT', NOW, { startsAt: until, expiresAt: until }))).toBe('INVALID_WINDOW');
    expect(
      code(() =>
        planMutation(null, 'GRANT', NOW, { startsAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-02-01T00:00:00.000Z' }),
      ),
    ).toBe('INVALID_WINDOW');
  });
});

describe('input: instants, actors, reasons, ids', () => {
  it('accepts only an instant with an explicit offset, and normalises it to UTC', () => {
    expect(parseInstant('2026-12-31T23:59:59Z', '--until')).toBe('2026-12-31T23:59:59.000Z');
    expect(parseInstant('2027-01-01T01:00:00+02:00', '--until')).toBe('2026-12-31T23:00:00.000Z');
    expect(parseInstant('2026-12-31T23:59Z', '--until')).toBe('2026-12-31T23:59:00.000Z');
    // A date, or a local time, would mean a different moment on every host.
    for (const ambiguous of ['2026-12-31', '2026-12-31T23:59:59', '31/12/2026', 'tomorrow', '', '2026-13-01T00:00:00Z', 1_790_000_000_000]) {
      expect(code(() => parseInstant(ambiguous, '--until')), String(ambiguous)).toBe('INVALID_TIME');
    }
  });

  it('requires a short operator handle, without anything that could forge a log line', () => {
    expect(assertActor('aisalkyn')).toBe('aisalkyn');
    expect(assertActor('ops@jumptotech.example')).toBe('ops@jumptotech.example');
    for (const bad of ['', ' ', 'two words', 'x\nlevel=error', 'a'.repeat(65), '-leading', undefined, 42]) {
      expect(code(() => assertActor(bad)), JSON.stringify(bad)).toBe('INVALID_ACTOR');
    }
  });

  it('requires a one-line reason of bounded length', () => {
    expect(assertReason('  paid invoice 1042  ')).toBe('paid invoice 1042');
    for (const bad of ['', '   ', 'a'.repeat(501), 'line one\nline two', 'tab\there', undefined]) {
      expect(code(() => assertReason(bad)), JSON.stringify(bad)).toBe('INVALID_REASON');
    }
  });

  it('accepts internal user ids only — never an email', () => {
    expect(assertUserId('0F8FAD5B-D9CB-469F-A165-70867728950E')).toBe('0f8fad5b-d9cb-469f-a165-70867728950e');
    expect(assertUserId('usr-00000001')).toBe('usr-00000001');
    for (const bad of ['alice@example.com', '../etc', '', "1' OR '1'='1", 'usr-1']) {
      expect(code(() => assertUserId(bad)), bad).toBe('INVALID_USER_ID');
    }
  });
});

describe('InMemoryAccessStore: one row per user, one event per change', () => {
  async function setup() {
    const users = new InMemoryUserRepository();
    const user = await users.upsert({ issuer: 'urn:test', subject: 'student', email: 'Student@Example.com' });
    const store = new InMemoryAccessStore(users);
    const clock = { now: NOW_MS };
    const now = () => new Date(clock.now);
    return { users, user, store, clock, now };
  }

  it('refuses to grant an account that has never signed in', async () => {
    const { store, now } = await setup();
    await expect(
      store.mutate({ userId: 'usr-00000099', action: 'GRANT', actor: 'ops', reason: 'x', grant: { expiresAt: null } }, now),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('records the before and after of every change, and nothing for a no-op', async () => {
    const { store, user, now, clock } = await setup();
    const grant = { expiresAt: '2026-12-01T00:00:00.000Z' };
    const first = await store.mutate({ userId: user.userId, action: 'GRANT', actor: 'ops', reason: 'paid', grant }, now);
    expect(first.changed).toBe(true);
    expect(first.event).toMatchObject({ action: 'GRANT', actor: 'ops', reason: 'paid', before: null });

    clock.now += 1000;
    const again = await store.mutate({ userId: user.userId, action: 'GRANT', actor: 'ops', reason: 'retry', grant }, now);
    expect(again).toMatchObject({ changed: false, event: null });

    await store.mutate({ userId: user.userId, action: 'SUSPEND', actor: 'support', reason: 'chargeback' }, now);
    const history = await store.events(user.userId, 10);
    expect(history.map((event) => event.action)).toEqual(['SUSPEND', 'GRANT']);
    expect(history[0]).toMatchObject({
      before: { status: 'ACTIVE' },
      after: { status: 'SUSPENDED', expiresAt: grant.expiresAt },
    });
  });

  it('serialises concurrent changes: each event starts from the state the previous one left', async () => {
    const { store, user, now } = await setup();
    await store.mutate(
      { userId: user.userId, action: 'GRANT', actor: 'ops', reason: 'start', grant: { expiresAt: null } },
      now,
    );
    const actions = ['SUSPEND', 'RESTORE', 'SUSPEND', 'REVOKE', 'RESTORE', 'SUSPEND'] as const;
    const outcomes = await Promise.allSettled(
      actions.map((action) => store.mutate({ userId: user.userId, action, actor: 'ops', reason: action }, now)),
    );
    // Run in order: SUSPEND ✓, RESTORE ✓, SUSPEND ✓, REVOKE ✓, then RESTORE and SUSPEND refused (revoked).
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'rejected']);
    const history = (await store.events(user.userId, 50)).reverse();
    for (let i = 1; i < history.length; i += 1) {
      expect(history[i]!.before, `event ${i}`).toEqual(history[i - 1]!.after);
    }
    expect((await store.get(user.userId))?.status).toBe('REVOKED');
  });

  it('finds accounts by email case-insensitively, and lists them with their access', async () => {
    const { store, user, users } = await setup();
    await users.upsert({ issuer: 'urn:other', subject: 'same-email', email: 'student@example.com' });
    const found = await store.findAccounts({ email: 'STUDENT@example.com' });
    // Two accounts at two issuers share the address: both are shown, and the
    // operator chooses by id — an email never picks one silently.
    expect(found.map((account) => account.issuer).sort()).toEqual(['urn:other', 'urn:test']);
    expect((await store.findAccounts({ userId: user.userId }))[0]?.entitlement).toBeNull();
    expect(await store.accounts(10)).toHaveLength(2);
  });
});

describe('AccessControl', () => {
  it('reads no store under the open policy', async () => {
    const store = {
      get: async () => {
        throw new Error('must not be read');
      },
    } as unknown as InMemoryAccessStore;
    await expect(new AccessControl(store, 'open').decide('usr-00000001')).resolves.toEqual({
      allowed: true,
      via: 'open',
    });
  });

  it('fails closed when the store cannot be read under the entitlement policy', async () => {
    const store = {
      get: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    } as unknown as InMemoryAccessStore;
    await expect(new AccessControl(store, 'entitlement').decide('usr-00000001')).rejects.toThrow(/ECONNREFUSED/);
  });
});
