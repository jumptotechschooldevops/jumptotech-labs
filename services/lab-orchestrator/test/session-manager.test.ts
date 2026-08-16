/**
 * Session lifecycle: creation, isolation of state, activity, capacity, reset,
 * End Lab, and expiry.
 *
 * Story tests 1–3 (unique ids and namespaces), 17–20 (reset and End Lab affect
 * only the requesting session), and 27 (MAX_ACTIVE_SESSIONS enforced).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  SessionError,
  SessionManager,
  type LabProvider,
} from '../src/index.js';
import { FakeKubernetes } from './fakes.js';
import { LABS_DIR } from './helpers.js';

const SECRET = 'a-namespace-derivation-secret';

interface Harness {
  manager: SessionManager;
  k8s: FakeKubernetes;
  provider: LabProvider;
  clock: { now: number };
  terminated: string[];
}

async function harness(overrides: { maxActiveSessions?: number; maxSessionSeconds?: number; idleTimeoutSeconds?: number } = {}): Promise<Harness> {
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
    stdout: JSON.stringify({ clientVersion: { gitVersion: 'v1.34.2' } }),
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
      maxSessionSeconds: overrides.maxSessionSeconds ?? 3_600,
      idleTimeoutSeconds: overrides.idleTimeoutSeconds ?? 1_200,
      warningSeconds: 300,
      maxActiveSessions: overrides.maxActiveSessions ?? 20,
    },
    namespaceSecret: SECRET,
    terminal: {
      async terminate(sessionId) {
        terminated.push(sessionId);
      },
    },
    now: () => clock.now,
  });

  return { manager, k8s, provider, clock, terminated };
}

describe('starting a session (story tests 1–3)', () => {
  it('produces a unique id, a unique namespace, and an ACTIVE session', async () => {
    const { manager } = await harness();

    const a = await manager.start('K8S-001');
    const b = await manager.start('K8S-001');

    expect(a.session.sessionId).not.toBe(b.session.sessionId);
    expect(a.session.namespace).not.toBe(b.session.namespace);
    expect(a.session.status).toBe('ACTIVE');
    expect(b.session.status).toBe('ACTIVE');
    expect(a.session.namespace).toMatch(/^lab-[0-9a-f]{12}$/);
  });

  it('never places a student in default or a system namespace', async () => {
    const { manager } = await harness({ maxActiveSessions: 40 });

    for (let i = 0; i < 25; i += 1) {
      const { session } = await manager.start('K8S-001');
      expect(session.namespace).not.toBe('default');
      expect(session.namespace.startsWith('kube-')).toBe(false);
    }
  });

  it('creates each namespace in the cluster, labelled and separate', async () => {
    const { manager, k8s } = await harness();

    const a = await manager.start('K8S-001');
    const b = await manager.start('K8S-001');

    const nsA = await k8s.getNamespace(a.session.namespace);
    const nsB = await k8s.getNamespace(b.session.namespace);
    expect(nsA?.labels['jumptotech.io/session-id']).toBe(a.session.sessionId);
    expect(nsB?.labels['jumptotech.io/session-id']).toBe(b.session.sessionId);
  });

  it('sets an absolute deadline from configuration', async () => {
    const { manager, clock } = await harness({ maxSessionSeconds: 1_800 });

    const { session } = await manager.start('K8S-001');

    expect(Date.parse(session.expiresAt)).toBe(clock.now + 1_800_000);
  });

  it('rejects an unknown lab before reserving anything', async () => {
    const { manager } = await harness();

    await expect(manager.start('K8S-999')).rejects.toThrow(/not found/);
    expect(manager.activeCount).toBe(0);
  });
});

describe('capacity guard (story test 27)', () => {
  it('refuses to create another namespace once MAX_ACTIVE_SESSIONS is reached', async () => {
    const { manager, k8s } = await harness({ maxActiveSessions: 3 });

    await manager.start('K8S-001');
    await manager.start('K8S-001');
    await manager.start('K8S-001');
    const namespacesBefore = k8s.namespaces.size;

    await expect(manager.start('K8S-001')).rejects.toMatchObject({
      code: 'LAB_CAPACITY_REACHED',
    });
    // The important half: no fourth namespace was created.
    expect(k8s.namespaces.size).toBe(namespacesBefore);
    expect(manager.activeCount).toBe(3);
  });

  it('holds under simultaneous starts, not just sequential ones', async () => {
    const { manager, k8s } = await harness({ maxActiveSessions: 2 });

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => manager.start('K8S-001')),
    );

    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(2);
    expect(rejected).toHaveLength(4);
    expect(k8s.namespaces.size).toBe(2 + 2); // default + kube-system + two labs
  });

  it('frees a slot when a session ends', async () => {
    const { manager } = await harness({ maxActiveSessions: 1 });

    const first = await manager.start('K8S-001');
    await expect(manager.start('K8S-001')).rejects.toMatchObject({ code: 'LAB_CAPACITY_REACHED' });

    await manager.end(first.session.sessionId);

    const second = await manager.start('K8S-001');
    expect(second.session.status).toBe('ACTIVE');
  });

  it('carries the numbers a frontend needs to explain the refusal', async () => {
    const { manager } = await harness({ maxActiveSessions: 1 });
    await manager.start('K8S-001');

    await expect(manager.start('K8S-001')).rejects.toMatchObject({
      code: 'LAB_CAPACITY_REACHED',
      details: { activeSessions: 1, maxActiveSessions: 1 },
    });
  });
});

describe('session lookup', () => {
  it('rejects a malformed session id without touching the store', async () => {
    const { manager } = await harness();

    await expect(manager.require('../../etc/passwd')).rejects.toMatchObject({
      code: 'INVALID_SESSION_ID',
    });
    await expect(manager.require('session-1')).rejects.toMatchObject({
      code: 'INVALID_SESSION_ID',
    });
  });

  it('reports an unknown session as not found', async () => {
    const { manager } = await harness();

    await expect(manager.require('sess-00000000000000ff')).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
  });

  it('refuses actions on a session that is no longer active', async () => {
    const { manager } = await harness();
    const { session } = await manager.start('K8S-001');
    await manager.end(session.sessionId);

    await expect(manager.requireActive(session.sessionId)).rejects.toMatchObject({
      code: 'SESSION_NOT_ACTIVE',
    });
  });
});

describe('activity tracking', () => {
  it('moves the idle deadline but never the absolute one', async () => {
    const { manager, clock } = await harness();
    const { session } = await manager.start('K8S-001');
    const originalExpiry = session.expiresAt;

    clock.now += 10 * 60_000;
    const touched = await manager.touch(session.sessionId, 'terminal');

    expect(touched?.lastActivityAt).toBe(new Date(clock.now).toISOString());
    expect(touched?.expiresAt).toBe(originalExpiry);
  });

  it('ignores activity on a session that has already ended', async () => {
    const { manager } = await harness();
    const { session } = await manager.start('K8S-001');
    await manager.end(session.sessionId);

    const touched = await manager.touch(session.sessionId, 'continue');
    expect(touched?.status).toBe('ENDED');
  });

  it('surfaces the idle warning only inside the warning window', async () => {
    const { manager, clock } = await harness({ idleTimeoutSeconds: 600 });
    const { session } = await manager.start('K8S-001');

    expect(manager.view(session).idleWarning).toBe(false);

    clock.now += 400_000; // 200s of idle budget left, warning window is 300s
    const stale = (await manager.get(session.sessionId))!;
    const view = manager.view(stale);
    expect(view.idleWarning).toBe(true);
    expect(view.secondsUntilIdle).toBe(200);
  });
});

describe('reset isolation (story tests 17 and 18)', () => {
  it('resets only the requesting session', async () => {
    const { manager, k8s } = await harness();
    const a = await manager.start('K8S-001');
    const b = await manager.start('K8S-001');

    k8s.pods.set(a.session.namespace, [
      { name: 'nginx', namespace: a.session.namespace, phase: 'Running', labels: {}, containers: [], deleting: false, ready: true },
    ]);
    k8s.pods.set(b.session.namespace, [
      { name: 'nginx', namespace: b.session.namespace, phase: 'Running', labels: {}, containers: [], deleting: false, ready: true },
    ]);

    await manager.reset(a.session.sessionId);

    expect(await k8s.countPods(a.session.namespace)).toBe(0);
    // B is untouched.
    expect(await k8s.countPods(b.session.namespace)).toBe(1);
    expect(k8s.deleted.every((entry) => entry.startsWith(a.session.namespace))).toBe(true);
  });

  it('keeps the session and its namespace alive, and does not extend the deadline', async () => {
    const { manager, k8s } = await harness();
    const { session } = await manager.start('K8S-001');
    const originalExpiry = session.expiresAt;

    const { session: after } = await manager.reset(session.sessionId);

    expect(after.status).toBe('ACTIVE');
    expect(after.expiresAt).toBe(originalExpiry);
    expect(await k8s.getNamespace(session.namespace)).not.toBeNull();
  });

  it('refuses to reset a session that is not active', async () => {
    const { manager } = await harness();
    const { session } = await manager.start('K8S-001');
    await manager.end(session.sessionId);

    await expect(manager.reset(session.sessionId)).rejects.toMatchObject({
      code: 'SESSION_NOT_ACTIVE',
    });
  });
});

describe('End Lab (story tests 19 and 20)', () => {
  it('deletes the ending session’s namespace and nothing else', async () => {
    const { manager, k8s } = await harness();
    const a = await manager.start('K8S-001');
    const b = await manager.start('K8S-001');

    const result = await manager.end(a.session.sessionId);

    expect(result.session.status).toBe('ENDED');
    expect(result.destroy.namespaceGone).toBe(true);
    expect(await k8s.getNamespace(a.session.namespace)).toBeNull();
    // B keeps working.
    expect(await k8s.getNamespace(b.session.namespace)).not.toBeNull();
    expect((await manager.get(b.session.sessionId))?.status).toBe('ACTIVE');
  });

  it('closes the student’s terminal before deleting the namespace', async () => {
    const { manager, terminated } = await harness();
    const { session } = await manager.start('K8S-001');

    await manager.end(session.sessionId);

    expect(terminated).toEqual([session.sessionId]);
  });

  it('is idempotent', async () => {
    const { manager, k8s } = await harness();
    const { session } = await manager.start('K8S-001');

    const first = await manager.end(session.sessionId);
    const second = await manager.end(session.sessionId);

    expect(first.destroy.namespaceGone).toBe(true);
    expect(second.destroy.namespaceGone).toBe(true);
    expect(second.session.status).toBe('ENDED');
    expect(k8s.deletedNamespaces).toEqual([session.namespace]);
  });

  it('records an end time and a reason', async () => {
    const { manager, clock } = await harness();
    const { session } = await manager.start('K8S-001');

    const { session: ended } = await manager.end(session.sessionId);

    expect(ended.endedAt).toBe(new Date(clock.now).toISOString());
    expect(ended.statusReason).toBe('ended by student');
  });
});

describe('expiry', () => {
  it('drives the same teardown as End Lab, with EXPIRED as the end state', async () => {
    const { manager, k8s, terminated } = await harness();
    const { session } = await manager.start('K8S-001');

    const result = await manager.expire(session.sessionId, 'absolute session lifetime reached');

    expect(result.session.status).toBe('EXPIRED');
    expect(result.session.statusReason).toBe('absolute session lifetime reached');
    expect(terminated).toEqual([session.sessionId]);
    expect(await k8s.getNamespace(session.namespace)).toBeNull();
  });
});

describe('failed provisioning', () => {
  let failing: Harness;

  beforeEach(async () => {
    failing = await harness();
    failing.k8s.unreachable = 'connect ECONNREFUSED 172.18.0.2:6443';
  });

  it('marks the session FAILED, releases the slot, and does not leak a namespace', async () => {
    await expect(failing.manager.start('K8S-001')).rejects.toBeInstanceOf(SessionError);

    const sessions = await failing.manager.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe('FAILED');
    expect(failing.manager.activeCount).toBe(0);
  });
});
