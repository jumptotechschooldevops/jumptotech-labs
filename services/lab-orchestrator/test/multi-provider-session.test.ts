/**
 * PLATFORM-004 — sessions across providers (story test requirements 6–8, 31).
 *
 * The session is the unit of isolation, and PLATFORM-004 makes it the unit of
 * *provider binding* too. These tests pin the four properties that follow from
 * that:
 *
 *   · a session records which provider created it, and which sandbox it owns;
 *   · the binding is derived server-side and cannot be patched afterwards;
 *   · one session cannot reach, reset or destroy another's sandbox — including
 *     across providers;
 *   · cleanup dispatches through the provider that created each sandbox, so a
 *     Kubernetes namespace and a Linux container both get reclaimed by the same
 *     sweep.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionError,
  SessionManager,
  SessionReaper,
  TerraformLabProvider,
} from '../src/index.js';
import { FakeKubernetes, fakeExec } from './fakes.js';
import { FakeContainerRuntime } from './container-fakes.js';
import { LABS_DIR } from './helpers.js';

const SECRET = 'a-test-namespace-derivation-secret';

async function harness(options: { now?: () => number } = {}) {
  const registry = new LabRegistry(LABS_DIR);
  await registry.load();

  const k8s = new FakeKubernetes();
  const runtime = new FakeContainerRuntime();
  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({
    provider: new KindLabProvider({
      k8s,
      clusterName: 'jumptotech-labs',
      exec: fakeExec(),
      destroyTimeoutMs: 500,
      sleep: async () => undefined,
      waitForRequirements: async () => ({ ok: true, checks: [] }),
    }),
  });
  providers.register({ provider: new LinuxLabProvider({ runtime }) });
  providers.register({ provider: new TerraformLabProvider({ runtime }) });

  const store = new InMemorySessionStore();
  const manager = new SessionManager({
    registry,
    providers,
    store,
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: {
      maxSessionSeconds: 3600,
      idleTimeoutSeconds: 1200,
      warningSeconds: 300,
      maxActiveSessions: 20,
    },
    namespaceSecret: SECRET,
    ...(options.now ? { now: options.now } : {}),
  });

  return { manager, providers, store, k8s, runtime, registry };
}

describe('a session records its provider and its sandbox (test requirements 6–7)', () => {
  it('binds a Kubernetes lab to a namespace', async () => {
    const { manager, k8s } = await harness();
    const { session } = await manager.start('K8S-001');

    expect(session.provider).toBe('kubernetes');
    expect(session.sandboxKind).toBe('namespace');
    expect(session.sandboxRef).toMatch(/^lab-[0-9a-f]{12}$/);
    expect(session.sandboxRef).toBe(session.namespace);
    expect(await k8s.getNamespace(session.namespace)).not.toBeNull();
  }, 30_000);

  it('binds a Linux lab to a container, with its own name space of names', async () => {
    const { manager, runtime } = await harness();
    const { session } = await manager.start('LINUX-001');

    expect(session.provider).toBe('linux');
    expect(session.sandboxKind).toBe('container');
    expect(session.sandboxRef).toMatch(/^jtt-lab-[0-9a-f]{12}$/);
    expect(runtime.containers.has(session.sandboxRef)).toBe(true);
    // The container name and the namespace name are derived through different
    // HMAC domains: learning one tells you nothing about the other.
    expect(session.sandboxRef).not.toContain(session.namespace.replace('lab-', ''));
  });

  it('binds a Terraform lab to a container from the Terraform image', async () => {
    const { manager, runtime } = await harness();
    const { session } = await manager.start('TF-001');

    expect(session.provider).toBe('terraform');
    const container = runtime.containers.get(session.sandboxRef);
    expect(container?.info.image).toBe('jumptotech/lab-terraform:latest');
  });

  it('derives the sandbox from the session id — nothing is client-supplied', async () => {
    const { manager } = await harness();
    const a = await manager.start('LINUX-001');
    const b = await manager.start('LINUX-001');

    expect(a.session.sandboxRef).not.toBe(b.session.sandboxRef);
    // Deterministic from the session id and the server-side secret only.
    expect(a.session.sandboxRef).toMatch(/^jtt-lab-[0-9a-f]{12}$/);
    expect(b.session.sandboxRef).toMatch(/^jtt-lab-[0-9a-f]{12}$/);
  });

  it('refuses to let a stored session be moved to another provider or sandbox', async () => {
    const { manager, store } = await harness();
    const { session } = await manager.start('LINUX-001');

    const patched = await store.update(session.sessionId, {
      provider: 'kubernetes',
      sandboxKind: 'namespace',
      sandboxRef: 'jtt-lab-ffffffffffff',
      namespace: 'kube-system',
      statusReason: 'attempted takeover',
    });

    // The status reason went through; the identity fields did not.
    expect(patched?.statusReason).toBe('attempted takeover');
    expect(patched?.provider).toBe('linux');
    expect(patched?.sandboxRef).toBe(session.sandboxRef);
    expect(patched?.namespace).toBe(session.namespace);
  });
});

describe('one session cannot reach another (test requirement 8)', () => {
  it('keeps two Linux sessions in two containers, and resets only one', async () => {
    const { manager, runtime } = await harness();
    const a = await manager.start('LINUX-001');
    const b = await manager.start('LINUX-001');

    runtime.put(a.session.sandboxRef, '/home/student/deploy', { type: 'directory', mode: '750' });
    runtime.put(b.session.sandboxRef, '/home/student/deploy', { type: 'directory', mode: '750' });

    await manager.reset(a.session.sessionId);

    expect(runtime.entry(a.session.sandboxRef, '/home/student/deploy')).toBeUndefined();
    expect(runtime.entry(b.session.sandboxRef, '/home/student/deploy')).toBeDefined();
  });

  it('ends only the session that asked, leaving the other sandbox alone', async () => {
    const { manager, runtime } = await harness();
    const a = await manager.start('LINUX-001');
    const b = await manager.start('LINUX-001');

    await manager.end(a.session.sessionId);

    expect(runtime.containers.has(a.session.sandboxRef)).toBe(false);
    expect(runtime.containers.has(b.session.sandboxRef)).toBe(true);
  });

  // Starting a Kubernetes session shells out to a real `kubectl version` as
  // part of provisioning, which is worth a second or two on its own; these two
  // tests start two providers each and get a longer budget accordingly.
  it('keeps a Kubernetes session and a Linux session isolated from each other', async () => {
    const { manager, k8s, runtime } = await harness();
    const k8sSession = await manager.start('K8S-001');
    const linuxSession = await manager.start('LINUX-001');

    expect(k8sSession.session.provider).toBe('kubernetes');
    expect(linuxSession.session.provider).toBe('linux');

    await manager.end(k8sSession.session.sessionId);

    // The Kubernetes namespace is gone; the Linux container is untouched.
    expect(await k8s.getNamespace(k8sSession.session.namespace)).toBeNull();
    expect(runtime.containers.has(linuxSession.session.sandboxRef)).toBe(true);

    const still = await manager.get(linuxSession.session.sessionId);
    expect(still?.status).toBe('ACTIVE');
  }, 30_000);

  it('refuses a lab whose provider is not registered, without creating a session', async () => {
    const registry = new LabRegistry(LABS_DIR);
    await registry.load();
    const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
    providers.register({
      provider: new KindLabProvider({
        k8s: new FakeKubernetes(),
        clusterName: 'jumptotech-labs',
        exec: fakeExec(),
      }),
    });
    const manager = new SessionManager({
      registry,
      providers,
      store: new InMemorySessionStore(),
      policy: DEFAULT_SESSION_POLICY,
      lifetimes: {
        maxSessionSeconds: 3600,
        idleTimeoutSeconds: 1200,
        warningSeconds: 300,
        maxActiveSessions: 20,
      },
      namespaceSecret: SECRET,
    });

    await expect(manager.start('LINUX-001')).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    await expect(manager.start('LINUX-001')).rejects.toBeInstanceOf(SessionError);
    // No slot consumed and no record left behind.
    expect(await manager.activeCount()).toBe(0);
    expect(await manager.list()).toHaveLength(0);
  });
});

describe('cleanup dispatches through the owning provider (test requirements 16, 22, 31)', () => {
  it('destroys both provider types in one sweep when they expire', async () => {
    let now = 1_000_000;
    const { manager, providers, k8s, runtime } = await harness({ now: () => now });

    const kubernetesSession = await manager.start('K8S-001');
    const linuxSession = await manager.start('LINUX-001');

    const reaper = new SessionReaper({
      sessions: manager,
      providers,
      intervalMs: 60_000,
      now: () => now,
      log: () => undefined,
    });

    // Nothing to do while both are inside their deadlines.
    expect((await reaper.sweep()).removed).toEqual([]);

    now += 3600 * 1000 + 1000;
    const sweep = await reaper.sweep();

    expect(sweep.removed.sort()).toEqual(
      [kubernetesSession.session.sandboxRef, linuxSession.session.sandboxRef].sort(),
    );
    expect(await k8s.getNamespace(kubernetesSession.session.namespace)).toBeNull();
    expect(runtime.containers.has(linuxSession.session.sandboxRef)).toBe(false);

    for (const id of [kubernetesSession.session.sessionId, linuxSession.session.sessionId]) {
      expect((await manager.get(id))?.status).toBe('EXPIRED');
    }
  }, 30_000);

  it('reclaims an orphaned container the store has no record of', async () => {
    let now = 1_000_000;
    const { manager, providers, runtime } = await harness({ now: () => now });

    // A sandbox the platform created and then forgot — an API restart.
    const orphan = 'jtt-lab-aaaaaaaaaaaa';
    runtime.addForeignContainer(orphan, {
      'jumptotech.io/managed': 'true',
      'jumptotech.io/session-id': 'sess-00000000deadbeef',
      'jumptotech.io/lab-id': 'LINUX-001',
      'jumptotech.io/provider': 'linux',
      'jumptotech.io/expires-at': String(now - 10_000),
    });

    const reaper = new SessionReaper({
      sessions: manager,
      providers,
      intervalMs: 60_000,
      orphanGraceMs: 1_000,
      now: () => now,
      log: () => undefined,
    });

    const sweep = await reaper.sweep();

    expect(sweep.removed).toEqual([orphan]);
    expect(sweep.reasons[orphan]).toBe('orphaned');
    expect(runtime.containers.has(orphan)).toBe(false);
  });

  it('refuses to reclaim a container this platform does not own (test requirement 31)', async () => {
    let now = 1_000_000;
    const { manager, providers, runtime } = await harness({ now: () => now });

    // Someone else's container, with a name that could pass and an expiry that
    // has passed — but no managed label.
    runtime.addForeignContainer('jtt-lab-bbbbbbbbbbbb', {
      'jumptotech.io/expires-at': String(now - 10_000),
    });
    // And a managed-looking container whose name is not a sandbox name at all.
    runtime.addForeignContainer('my-postgres', {
      'jumptotech.io/managed': 'true',
      'jumptotech.io/expires-at': String(now - 10_000),
    });

    const reaper = new SessionReaper({
      sessions: manager,
      providers,
      intervalMs: 60_000,
      orphanGraceMs: 1_000,
      now: () => now,
      log: () => undefined,
    });

    const sweep = await reaper.sweep();

    expect(sweep.removed).toEqual([]);
    expect(runtime.containers.has('jtt-lab-bbbbbbbbbbbb')).toBe(true);
    expect(runtime.containers.has('my-postgres')).toBe(true);
  });

  it('leaves a managed sandbox with no expiry label for a human', async () => {
    let now = 1_000_000;
    const { manager, providers, runtime } = await harness({ now: () => now });
    const undated = 'jtt-lab-cccccccccccc';
    runtime.addForeignContainer(undated, {
      'jumptotech.io/managed': 'true',
      'jumptotech.io/provider': 'linux',
    });

    const reaper = new SessionReaper({
      sessions: manager,
      providers,
      intervalMs: 60_000,
      now: () => now,
      log: () => undefined,
    });

    expect((await reaper.sweep()).removed).toEqual([]);
    expect(runtime.containers.has(undated)).toBe(true);
  });

  it('is idempotent: two sweeps in a row produce the same end state', async () => {
    let now = 1_000_000;
    const { manager, providers, runtime } = await harness({ now: () => now });
    const linuxSession = await manager.start('LINUX-001');

    const reaper = new SessionReaper({
      sessions: manager,
      providers,
      intervalMs: 60_000,
      now: () => now,
      log: () => undefined,
    });

    now += 3600 * 1000 + 1000;
    const first = await reaper.sweep();
    const second = await reaper.sweep();

    expect(first.removed).toEqual([linuxSession.session.sandboxRef]);
    expect(second.removed).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(runtime.containers.size).toBe(0);
  });
});
