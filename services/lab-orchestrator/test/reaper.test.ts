/**
 * Automatic cleanup.
 *
 * Story tests 21–25: an expired session is removed automatically, an idle
 * session is removed automatically, an active session is left alone, cleanup is
 * idempotent, and cleanup refuses unmanaged namespaces.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  MANAGED_LABEL,
  SESSION_LABEL,
  SessionManager,
  SessionReaper,
} from '../src/index.js';
import { FakeKubernetes } from './fakes.js';
import { LABS_DIR } from './helpers.js';

const SECRET = 'a-namespace-derivation-secret';
const MINUTE = 60_000;

async function harness(lifetimes: { maxSessionSeconds?: number; idleTimeoutSeconds?: number } = {}) {
  const registry = new LabRegistry(LABS_DIR);
  await registry.load();

  const k8s = new FakeKubernetes();
  const clock = { now: 1_700_000_000_000 };
  const provider = new KindLabProvider({
    k8s,
    clusterName: 'jumptotech-labs',
    now: () => clock.now,
    sleep: async () => undefined,
  });
  vi.spyOn(provider, 'execute').mockResolvedValue({
    exitCode: 0,
    stdout: '{}',
    stderr: '',
    timedOut: false,
  });

  const terminated: string[] = [];
  const manager = new SessionManager({
    registry,
    provider,
    store: new InMemorySessionStore(),
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: {
      maxSessionSeconds: lifetimes.maxSessionSeconds ?? 3_600,
      idleTimeoutSeconds: lifetimes.idleTimeoutSeconds ?? 1_200,
      warningSeconds: 300,
      maxActiveSessions: 20,
    },
    namespaceSecret: SECRET,
    terminal: {
      async terminate(sessionId) {
        terminated.push(sessionId);
      },
    },
    now: () => clock.now,
  });

  const reaper = new SessionReaper({
    sessions: manager,
    provider,
    intervalMs: 60_000,
    orphanGraceMs: 60_000,
    retentionMs: 15 * MINUTE,
    now: () => clock.now,
    log: () => undefined,
  });

  return { manager, provider, k8s, clock, reaper, terminated };
}

describe('expired sessions (story test 21)', () => {
  it('are removed automatically', async () => {
    const { manager, k8s, clock, reaper } = await harness({ maxSessionSeconds: 600 });
    const { session } = await manager.start('K8S-001');

    clock.now += 11 * MINUTE;
    const result = await reaper.sweep();

    expect(result.removed).toEqual([session.namespace]);
    expect(result.reasons[session.namespace]).toBe('expired');
    expect(await k8s.getNamespace(session.namespace)).toBeNull();
    expect((await manager.get(session.sessionId))?.status).toBe('EXPIRED');
  });

  it('expire even when the student keeps signalling activity', async () => {
    // The absolute deadline is the outer bound: "Continue Lab" forever must not
    // keep a lab alive forever.
    const { manager, clock, reaper } = await harness({ maxSessionSeconds: 600, idleTimeoutSeconds: 120 });
    const { session } = await manager.start('K8S-001');

    for (let minute = 0; minute < 11; minute += 1) {
      clock.now += MINUTE;
      await manager.touch(session.sessionId, 'continue');
    }

    const result = await reaper.sweep();
    expect(result.removed).toEqual([session.namespace]);
    expect(result.reasons[session.namespace]).toBe('expired');
  });
});

describe('idle sessions (story test 22)', () => {
  it('are removed automatically', async () => {
    const { manager, k8s, clock, reaper } = await harness({ idleTimeoutSeconds: 600 });
    const { session } = await manager.start('K8S-001');

    clock.now += 11 * MINUTE;
    const result = await reaper.sweep();

    expect(result.removed).toEqual([session.namespace]);
    expect(result.reasons[session.namespace]).toBe('idle');
    expect(await k8s.getNamespace(session.namespace)).toBeNull();
  });

  it('are kept alive by real activity', async () => {
    const { manager, clock, reaper } = await harness({ idleTimeoutSeconds: 600 });
    const { session } = await manager.start('K8S-001');

    clock.now += 9 * MINUTE;
    await manager.touch(session.sessionId, 'terminal');
    clock.now += 9 * MINUTE;

    const result = await reaper.sweep();
    expect(result.removed).toEqual([]);
    expect(result.retained).toBe(1);
    expect((await manager.get(session.sessionId))?.status).toBe('ACTIVE');
  });

  it('close the terminal before the namespace goes', async () => {
    const { manager, clock, reaper, terminated } = await harness({ idleTimeoutSeconds: 60 });
    const { session } = await manager.start('K8S-001');

    clock.now += 5 * MINUTE;
    await reaper.sweep();

    expect(terminated).toEqual([session.sessionId]);
  });
});

describe('active sessions (story test 23)', () => {
  it('are left completely alone', async () => {
    const { manager, k8s, clock, reaper } = await harness();
    const a = await manager.start('K8S-001');
    const b = await manager.start('K8S-001');

    clock.now += 5 * MINUTE;
    const result = await reaper.sweep();

    expect(result.removed).toEqual([]);
    expect(result.retained).toBe(2);
    expect(await k8s.getNamespace(a.session.namespace)).not.toBeNull();
    expect(await k8s.getNamespace(b.session.namespace)).not.toBeNull();
  });

  it('survive while a neighbour is reaped', async () => {
    const { manager, k8s, clock, reaper } = await harness({ idleTimeoutSeconds: 600 });
    const stale = await manager.start('K8S-001');
    clock.now += 11 * MINUTE;
    const fresh = await manager.start('K8S-001');

    const result = await reaper.sweep();

    expect(result.removed).toEqual([stale.session.namespace]);
    expect(await k8s.getNamespace(fresh.session.namespace)).not.toBeNull();
    expect((await manager.get(fresh.session.sessionId))?.status).toBe('ACTIVE');
  });
});

describe('idempotence (story test 24)', () => {
  it('running cleanup twice removes once and does not corrupt state', async () => {
    const { manager, k8s, clock, reaper } = await harness({ maxSessionSeconds: 600 });
    const { session } = await manager.start('K8S-001');
    clock.now += 11 * MINUTE;

    const first = await reaper.sweep();
    const second = await reaper.sweep();

    expect(first.removed).toEqual([session.namespace]);
    expect(second.removed).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(k8s.deletedNamespaces).toEqual([session.namespace]);
    expect((await manager.get(session.sessionId))?.status).toBe('EXPIRED');
  });

  it('a sweep with nothing to do reports nothing and fails nothing', async () => {
    const { reaper } = await harness();

    const result = await reaper.sweep();

    expect(result).toMatchObject({ removed: [], errors: [], retained: 0, forgotten: [] });
  });
});

describe('cleanup safety (story test 25)', () => {
  it('refuses namespaces that are not labelled as managed', async () => {
    const { k8s, provider, reaper } = await harness();
    // A lab-shaped namespace that the platform did not create.
    await k8s.createNamespace('lab-deadbeef0001', {});

    await reaper.sweep();

    expect(k8s.deletedNamespaces).toEqual([]);
    const outcome = await provider.destroyNamespace('lab-deadbeef0001');
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.message).toMatch(/not labelled/);
  });

  it.each(['default', 'kube-system', 'kube-public', 'kube-node-lease'])(
    'never deletes %s, even hand-labelled as managed and expired',
    async (name) => {
      const { k8s, clock, reaper } = await harness();
      k8s.namespaces.set(name, {
        name,
        phase: 'Active',
        labels: {
          [MANAGED_LABEL]: 'true',
          [SESSION_LABEL]: 'sess-000000000000000a',
          'jumptotech.io/expires-at': String(clock.now - 10 * MINUTE),
        },
      });

      const result = await reaper.sweep();

      expect(result.removed).toEqual([]);
      expect(k8s.deletedNamespaces).toEqual([]);
      expect(await k8s.getNamespace(name)).not.toBeNull();
    },
  );

  it('leaves a managed namespace with no expiry label for an operator', async () => {
    const { k8s, reaper } = await harness();
    await k8s.createNamespace('lab-deadbeef0002', {
      [MANAGED_LABEL]: 'true',
      [SESSION_LABEL]: 'sess-000000000000000a',
    });

    const result = await reaper.sweep();

    expect(result.removed).toEqual([]);
    expect(await k8s.getNamespace('lab-deadbeef0002')).not.toBeNull();
  });
});

describe('orphan reclamation', () => {
  it('removes a managed, expired namespace the store has no record of', async () => {
    // This is what makes an API restart survivable: the in-memory store is
    // gone, but the namespace labels still carry the deadline.
    const { k8s, clock, reaper } = await harness();
    await k8s.createNamespace('lab-deadbeef0003', {
      [MANAGED_LABEL]: 'true',
      [SESSION_LABEL]: 'sess-00000000000000ab',
      'jumptotech.io/lab-id': 'K8S-001',
      'jumptotech.io/expires-at': String(clock.now - 10 * MINUTE),
    });

    const result = await reaper.sweep();

    expect(result.removed).toEqual(['lab-deadbeef0003']);
    expect(result.reasons['lab-deadbeef0003']).toBe('orphaned');
  });

  it('respects the grace period so an in-flight start is not reclaimed', async () => {
    const { k8s, clock, reaper } = await harness();
    await k8s.createNamespace('lab-deadbeef0004', {
      [MANAGED_LABEL]: 'true',
      'jumptotech.io/expires-at': String(clock.now - 30_000),
    });

    expect((await reaper.sweep()).removed).toEqual([]);

    clock.now += 2 * MINUTE;
    expect((await reaper.sweep()).removed).toEqual(['lab-deadbeef0004']);
  });
});

describe('retention', () => {
  it('eventually forgets finished session records', async () => {
    const { manager, clock, reaper } = await harness();
    const { session } = await manager.start('K8S-001');
    await manager.end(session.sessionId);

    expect((await reaper.sweep()).forgotten).toEqual([]);

    clock.now += 16 * MINUTE;
    const result = await reaper.sweep();

    expect(result.forgotten).toEqual([session.sessionId]);
    expect(await manager.get(session.sessionId)).toBeNull();
  });
});
