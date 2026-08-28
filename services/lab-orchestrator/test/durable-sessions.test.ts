/**
 * PLATFORM-008 — durable sessions through the session manager.
 *
 * The store contract is proved elsewhere, in-memory and against real
 * PostgreSQL. What is proved here is the layer students actually reach: that
 * two managers sharing one store behave as two API instances behind a load
 * balancer, that knowing a sandbox name grants nothing, and that competing
 * terminal operations settle on one lifecycle outcome.
 *
 * Two managers over one store is the honest model of a multi-instance
 * deployment: separate objects, separate in-process state, one durable truth.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  LabRegistry,
  LinuxLabProvider,
  SessionManager,
  type SessionStore,
} from '../src/index.js';
import { FakeContainerRuntime } from './container-fakes.js';
import { realCatalog } from './real-catalog.js';

const LIFETIMES = {
  maxSessionSeconds: 3_600,
  idleTimeoutSeconds: 1_200,
  warningSeconds: 300,
  maxActiveSessions: 20,
};

let registry: LabRegistry;
let store: SessionStore;
let runtime: FakeContainerRuntime;

/** A manager standing in for one API instance. */
function instance(): SessionManager {
  return new SessionManager({
    registry,
    provider: new LinuxLabProvider({ runtime }),
    store,
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: LIFETIMES,
    namespaceSecret: 'platform-008-tests',
  });
}

beforeEach(async () => {
  registry = await realCatalog();
  runtime = new FakeContainerRuntime();
  // One durable store, shared — the database in the real deployment.
  store = new InMemorySessionStore();
});

// ------------------------------------------------------- two API instances

describe('two API instances share one authoritative session', () => {
  it('lets B resolve, advance and end a session A started', async () => {
    const apiA = instance();
    const apiB = instance();

    const { session } = await apiA.start('LINUX-001');

    // B, which never saw the start, resolves it from durable state.
    expect((await apiB.get(session.sessionId))?.sandboxRef).toBe(session.sandboxRef);

    // B records activity; A observes it.
    await apiB.touch(session.sessionId, 'check');
    const seenByA = await apiA.get(session.sessionId);
    expect(seenByA?.lastActivityAt).toBeTruthy();

    // B ends it; A sees the terminal state. No process-local copy is
    // authoritative for either of them.
    await apiB.end(session.sessionId);
    expect((await apiA.get(session.sessionId))?.status).toBe('ENDED');
  });

  it('counts capacity across instances, not per process', async () => {
    const apiA = instance();
    const apiB = instance();

    await apiA.start('LINUX-001');
    await apiB.start('LINUX-001');

    // Each manager reports the deployment's total, not its own share.
    expect(await apiA.activeCount()).toBe(2);
    expect(await apiB.activeCount()).toBe(2);
  });
});

// --------------------------------------------------------- restart recovery

describe('a restarted instance recovers the session, and never replaces it', () => {
  it('resolves, checks, resets and ends the same sandbox after a restart', async () => {
    const before = instance();
    const { session } = await before.start('LINUX-001');
    const sandbox = session.sandboxRef;
    expect(runtime.containers.has(sandbox)).toBe(true);

    // The process dies and a new one starts against the same durable store.
    const after = instance();

    const recovered = await after.get(session.sessionId);
    expect(recovered?.sandboxRef).toBe(sandbox);
    expect(recovered?.status).toBe('ACTIVE');

    // Reset acts on the *existing* sandbox rather than provisioning a second
    // one — a recovery that quietly created a replacement would strand the
    // student's work and leak the original.
    await after.reset(session.sessionId);
    expect((await after.get(session.sessionId))?.sandboxRef).toBe(sandbox);
    expect(await store.list()).toHaveLength(1);

    await after.end(session.sessionId);
    expect((await after.get(session.sessionId))?.status).toBe('ENDED');
    expect(runtime.containers.has(sandbox)).toBe(false);
  });

  it('does not orphan the sandbox merely because the API restarted', async () => {
    const before = instance();
    const { session } = await before.start('LINUX-001');

    // A fresh instance can still find and reclaim it, which is precisely what
    // was impossible when the record lived in one process's memory.
    const after = instance();
    expect((await after.listOccupying()).map((s) => s.sessionId)).toEqual([session.sessionId]);
  });
});

// -------------------------------------------------- competing destruction

describe('competing lifecycle operations settle on one outcome', () => {
  it('End racing End leaves one terminal state and one teardown', async () => {
    const apiA = instance();
    const apiB = instance();
    const { session } = await apiA.start('LINUX-001');

    const [a, b] = await Promise.all([
      apiA.end(session.sessionId),
      apiB.end(session.sessionId),
    ]);

    expect((await apiA.get(session.sessionId))?.status).toBe('ENDED');
    // Both callers get a coherent answer; neither is told the sandbox survived.
    expect(a.destroy.namespaceGone || b.destroy.namespaceGone).toBe(true);
    expect(runtime.containers.has(session.sandboxRef)).toBe(false);
  });

  it('End racing expiry produces one label, not both', async () => {
    const apiA = instance();
    const apiB = instance();
    const { session } = await apiA.start('LINUX-001');

    await Promise.all([
      apiA.end(session.sessionId),
      apiB.expire(session.sessionId, 'reaper'),
    ]);

    const final = await apiA.get(session.sessionId);
    // Exactly one of the two terminal states, never a session recorded as both
    // ended by the student and expired by the reaper.
    expect(['ENDED', 'EXPIRED']).toContain(final?.status);
    expect(runtime.containers.has(session.sandboxRef)).toBe(false);
  });

  it('an activity ping cannot resurrect a finished session', async () => {
    const apiA = instance();
    const apiB = instance();
    const { session } = await apiA.start('LINUX-001');

    await apiA.end(session.sessionId);
    await apiB.touch(session.sessionId, 'check').catch(() => undefined);

    expect((await apiA.get(session.sessionId))?.status).toBe('ENDED');
  });

  it('ending an already-ended session is safe and repeatable', async () => {
    const api = instance();
    const { session } = await api.start('LINUX-001');

    await api.end(session.sessionId);
    const second = await api.end(session.sessionId);
    const third = await api.end(session.sessionId);

    expect(second.destroy.namespaceGone).toBe(true);
    expect(third.destroy.namespaceGone).toBe(true);
    expect((await api.get(session.sessionId))?.status).toBe('ENDED');
  });
});

// ------------------------------------------------------ cross-session safety

describe('knowing a sandbox name grants nothing', () => {
  it('does not let one session be reached through another’s identifiers', async () => {
    const api = instance();
    const a = (await api.start('LINUX-001')).session;
    const b = (await api.start('LINUX-001')).session;

    // The sandbox handle and the namespace are not credentials: there is no
    // route from either back to a session, only from a validated session id to
    // its sandbox.
    await expect(api.require(a.sandboxRef)).rejects.toThrow();
    await expect(api.require(a.namespace)).rejects.toThrow();
    expect(a.sandboxRef).not.toBe(b.sandboxRef);
  });

  it('rejects a malformed or unknown session id', async () => {
    const api = instance();
    for (const bad of ['', 'not-a-session', '../../etc/passwd', 'sess-0000000000000000']) {
      await expect(api.require(bad), bad).rejects.toThrow();
    }
  });

  it('ending one session leaves every other session untouched', async () => {
    const api = instance();
    const sessions = [];
    for (let i = 0; i < 3; i += 1) sessions.push((await api.start('LINUX-001')).session);

    await api.end(sessions[0]!.sessionId);

    expect(runtime.containers.has(sessions[0]!.sandboxRef)).toBe(false);
    expect(runtime.containers.has(sessions[1]!.sandboxRef)).toBe(true);
    expect(runtime.containers.has(sessions[2]!.sandboxRef)).toBe(true);
    expect((await api.get(sessions[1]!.sessionId))?.status).toBe('ACTIVE');
  });

  it('resetting one session leaves every other session untouched', async () => {
    const api = instance();
    const a = (await api.start('LINUX-001')).session;
    const b = (await api.start('LINUX-001')).session;

    await api.reset(a.sessionId);

    expect(runtime.containers.has(b.sandboxRef)).toBe(true);
    expect((await api.get(b.sessionId))?.status).toBe('ACTIVE');
    // Reset keeps the session; it does not create a second durable record.
    expect(await store.list()).toHaveLength(2);
  });
});

// ---------------------------------------------------- five-session regression

describe('five simultaneous sessions (PLATFORM-002 regression)', () => {
  it('gives each its own identity, row and sandbox, and survives a restart', async () => {
    const api = instance();
    const started = [];
    for (let i = 0; i < 5; i += 1) started.push((await api.start('LINUX-001')).session);

    const ids = started.map((s) => s.sessionId);
    const refs = started.map((s) => s.sandboxRef);
    expect(new Set(ids).size).toBe(5);
    expect(new Set(refs).size).toBe(5);
    expect(await store.list()).toHaveLength(5);
    expect(await api.activeCount()).toBe(5);

    // Restart mid-scenario: a new instance must still resolve all five.
    const after = instance();
    for (const session of started) {
      expect((await after.get(session.sessionId))?.sandboxRef).toBe(session.sandboxRef);
    }

    // Independent teardown: ending one leaves the other four.
    await after.end(ids[2]!);
    expect(await after.activeCount()).toBe(4);
    for (const [index, ref] of refs.entries()) {
      expect(runtime.containers.has(ref), ref).toBe(index !== 2);
    }
  });
});
