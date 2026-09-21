/**
 * The reaper expires what it judged idle, and nothing that has been active
 * since.
 *
 * A sweep reads every session once, then tears the idle ones down one after
 * another; a Kubernetes destroy can take a minute and a half. A student who
 * pressed Stay active (the api answered 200) or started a Reset while the
 * sweep was busy with somebody else was still expired from the old read.
 * Both reproduced against the manager before the claim was fenced on the
 * activity stamp the sweep saw, and before Reset counted as activity.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  SessionManager,
  SessionReaper,
  type SessionClosedEvent,
} from '../src/index.js';
import { FakeContainerRuntime } from './container-fakes.js';
import { GatedLinuxProvider } from './lifecycle-harness.js';
import { realCatalog } from './real-catalog.js';

const MIN = 60_000;

async function world() {
  const registry = await realCatalog();
  const store = new InMemorySessionStore();
  const provider = new GatedLinuxProvider({ runtime: new FakeContainerRuntime(), runtimeOwner: 'wt-fence' });
  const clock = { now: Date.parse('2026-09-21T12:00:00.000Z') };
  const closed: SessionClosedEvent[] = [];
  const manager = new SessionManager({
    registry,
    provider,
    store,
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: {
      maxSessionSeconds: 3600,
      idleTimeoutSeconds: 1200,
      warningSeconds: 300,
      maxActiveSessions: 20,
      maxActiveSessionsPerStudent: 1,
    },
    namespaceSecret: 'fence-secret',
    now: () => clock.now,
    terminal: { async terminate() {}, async reattach() {} },
    listener: {
      onSessionClosed(event) {
        closed.push(event);
      },
    },
  });
  const reaper = new SessionReaper({ sessions: manager, provider, intervalMs: MIN, now: () => clock.now });
  return { store, provider, clock, closed, manager, reaper };
}

describe('an idle expiry', () => {
  it('does not take a lab whose student pressed Stay active while the sweep was busy', async () => {
    const w = await world();
    const a = await w.manager.start('LINUX-001', 'student-a');
    w.clock.now += 1000;
    const b = await w.manager.start('LINUX-001', 'student-b');
    w.clock.now += 20 * MIN + 1000;

    const slow = w.provider.holdNextDestroy();
    const sweep = w.reaper.sweep();
    await slow.entered;
    const touched = await w.manager.touch(b.session.sessionId, 'continue');
    expect(touched?.status).toBe('ACTIVE');
    slow.release();
    const result = await sweep;

    expect((await w.store.get(a.session.sessionId))?.status).toBe('EXPIRED');
    expect((await w.store.get(b.session.sessionId))?.status).toBe('ACTIVE');
    expect(w.closed.map((event) => event.sessionId)).toEqual([a.session.sessionId]);
    expect(result.pending).toEqual([]);
  });

  it('still takes a lab that stayed idle', async () => {
    const w = await world();
    const a = await w.manager.start('LINUX-001', 'student-a');
    w.clock.now += 20 * MIN + 1000;
    await w.reaper.sweep();
    expect((await w.store.get(a.session.sessionId))?.status).toBe('EXPIRED');
  });

  it('does not take a lab in the middle of the Reset its student just pressed', async () => {
    const w = await world();
    const a = await w.manager.start('LINUX-001', 'student-a');
    w.clock.now += 19 * MIN + 30_000;
    const gate = w.provider.holdNextReset();
    const resetting = w.manager.reset(a.session.sessionId);
    await gate.entered;
    w.clock.now += 45_000;
    await w.reaper.sweep();
    gate.release();

    expect((await resetting).session.status).toBe('ACTIVE');
    expect(w.closed).toEqual([]);
  });
});
