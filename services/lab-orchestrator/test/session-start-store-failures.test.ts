/**
 * Start against a session store that fails part-way.
 *
 * The store is PostgreSQL in every real deployment, and a database blip can
 * land between any two statements of a start. What must hold at each point:
 *
 *   - admission fails  → the start is refused and nothing is built;
 *   - a read made only for a log line fails after the session is ACTIVE → the
 *     start still succeeds, because the lab is running and holds the student's
 *     slot, and refusing it would leave them locked out of their own lab.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  SessionManager,
  type CapacityLimits,
  type LabSession,
} from '../src/index.js';
import { FakeContainerRuntime } from './container-fakes.js';
import { GatedLinuxProvider, PausableStore } from './lifecycle-harness.js';
import { realCatalog } from './real-catalog.js';

const LAB = 'LINUX-001';

/** A store whose chosen operations fail, as a lost database connection does. */
class FailingStore extends PausableStore {
  failCount = false;
  failAdmission = false;

  override countOccupying() {
    if (this.failCount) return Promise.reject(new Error('connection terminated unexpectedly'));
    return super.countOccupying();
  }

  override createWithinLimits(session: LabSession, limits: CapacityLimits) {
    if (this.failAdmission) return Promise.reject(new Error('connection terminated unexpectedly'));
    return super.createWithinLimits(session, limits);
  }
}

async function world() {
  const registry = await realCatalog();
  const runtime = new FakeContainerRuntime();
  const provider = new GatedLinuxProvider({ runtime });
  const inner = new InMemorySessionStore();
  const store = new FailingStore(inner);
  const sessions = new SessionManager({
    registry,
    provider,
    store,
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: {
      maxSessionSeconds: 3_600,
      idleTimeoutSeconds: 1_200,
      warningSeconds: 300,
      maxActiveSessions: 5,
      maxActiveSessionsPerStudent: 1,
    },
    namespaceSecret: 'start-store-failures-test-secret',
  });
  return { sessions, provider, runtime, store, inner };
}

describe('Start when the session store fails part-way', () => {
  it('succeeds when only the log line’s occupancy read fails after the session is ACTIVE', async () => {
    const { sessions, store, inner } = await world();
    store.failCount = true;

    const started = await sessions.start(LAB, 'alice');

    expect(started.session.status).toBe('ACTIVE');
    expect((await inner.get(started.session.sessionId))?.status).toBe('ACTIVE');
  });

  it('refuses without building anything when admission itself fails', async () => {
    const { sessions, provider, store, inner } = await world();
    store.failAdmission = true;

    await expect(sessions.start(LAB, 'alice')).rejects.toThrow('connection terminated');

    expect(provider.creates.calls).toBe(0);
    expect(await inner.list()).toEqual([]);
  });
});
