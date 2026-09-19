/**
 * `start`'s admission hook: called for an admitted start, never for a refusal.
 *
 * The API opens a student's attempt from this hook. Anything a refusal did to
 * learning history would be a record of a lab that never ran, so the contract
 * is exact: no call for any refusal, one call per admitted session, made before
 * the provider builds anything, and a hook that throws never costs the student
 * their lab.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  SessionError,
  SessionManager,
  type LabSession,
} from '../src/index.js';
import { FakeContainerRuntime } from './container-fakes.js';
import { GatedLinuxProvider } from './lifecycle-harness.js';
import { realCatalog } from './real-catalog.js';

const LAB = 'LINUX-001';

async function world(limits: { maxActiveSessions: number; maxActiveSessionsPerStudent?: number }) {
  const registry = await realCatalog();
  const runtime = new FakeContainerRuntime();
  const provider = new GatedLinuxProvider({ runtime });
  const logs: string[] = [];
  const sessions = new SessionManager({
    registry,
    provider,
    store: new InMemorySessionStore(),
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: { maxSessionSeconds: 3_600, idleTimeoutSeconds: 1_200, warningSeconds: 300, ...limits },
    namespaceSecret: 'admission-hook-test-secret',
    logger: (line) => logs.push(line),
  });
  return { sessions, provider, runtime, logs };
}

async function refusalCode(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(SessionError);
  return (error as SessionError).code;
}

describe('the admission hook', () => {
  it('is called once, with the CREATING session, before the provider builds anything', async () => {
    const { sessions, provider } = await world({ maxActiveSessions: 5 });
    const seen: Array<{ session: LabSession; createsSoFar: number }> = [];

    const started = await sessions.start(LAB, 'alice', {
      onAdmitted: (session) => {
        seen.push({ session, createsSoFar: provider.creates.calls });
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.session).toMatchObject({
      sessionId: started.session.sessionId,
      status: 'CREATING',
      ownerUserId: 'alice',
    });
    expect(seen[0]!.createsSoFar).toBe(0);
  });

  it('is never called for a start refused by the per-student limit or by capacity', async () => {
    const { sessions } = await world({ maxActiveSessions: 2, maxActiveSessionsPerStudent: 1 });
    let calls = 0;
    const hooks = { onAdmitted: () => void (calls += 1) };

    await sessions.start(LAB, 'alice', hooks);
    expect(await refusalCode(sessions.start(LAB, 'alice', hooks))).toBe('STUDENT_SESSION_LIMIT_REACHED');
    await sessions.start(LAB, 'bob', hooks);
    expect(await refusalCode(sessions.start(LAB, 'carol', hooks))).toBe('LAB_CAPACITY_REACHED');

    expect(calls).toBe(2);
  });

  it('is called for exactly one of two simultaneous starts by one student', async () => {
    const { sessions } = await world({ maxActiveSessions: 5, maxActiveSessionsPerStudent: 1 });
    const admittedIds: string[] = [];
    const hooks = { onAdmitted: (s: LabSession) => void admittedIds.push(s.sessionId) };

    const results = await Promise.allSettled([
      sessions.start(LAB, 'alice', hooks),
      sessions.start(LAB, 'alice', hooks),
    ]);

    const won = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    expect(won).toHaveLength(1);
    expect(admittedIds).toEqual([won[0]!.session.sessionId]);
  });

  it('a hook that throws is logged and the lab still starts', async () => {
    const { sessions, logs } = await world({ maxActiveSessions: 5 });

    const started = await sessions.start(LAB, 'alice', {
      onAdmitted: () => {
        throw new Error('progress store unavailable');
      },
    });

    expect(started.session.status).toBe('ACTIVE');
    expect(logs.some((line) => line.includes('admission hook failed') && line.includes('progress store unavailable'))).toBe(true);
  });
});
