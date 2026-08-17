/**
 * The Linux track inside the existing session lifecycle.
 *
 * Covers what a Linux *session* has to do — start, run alongside others, reset,
 * end, expire, and be cleaned up — at the level the platform actually operates:
 * through `SessionManager` and `SessionReaper`, with `ProviderRegistry`
 * deciding which substrate each lab lands on.
 *
 * The point of running these through the shared machinery rather than the
 * provider alone is that PLATFORM-002's lifecycle is supposed to be
 * substrate-agnostic. If adding a track had required a second state machine,
 * these are the tests that could not have been written.
 *
 * `multi-provider-session.test.ts` covers the generic cross-provider binding
 * and cleanup rules; this file covers what is specific to Linux — ten labs
 * seeded by real scripts, containers that a reset genuinely replaces, and the
 * terminal reconnection that replacement forces.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  KindLabProvider,
  LabRegistry,
  LinuxLabProvider,
  ProviderRegistry,
  SessionManager,
  SessionReaper,
  type TerminalTerminator,
} from '../src/index.js';
import { FakeKubernetes } from './fakes.js';
import { FakeContainerRuntime } from './container-fakes.js';
import { LABS_DIR } from './helpers.js';

const SECRET = 'a-test-namespace-derivation-secret';

interface HarnessOptions {
  now?: () => number;
  maxActiveSessions?: number;
}

async function harness(options: HarnessOptions = {}) {
  const registry = new LabRegistry(LABS_DIR);
  await registry.load();
  expect(registry.loadErrors).toEqual([]);

  const k8s = new FakeKubernetes();
  const runtime = new FakeContainerRuntime();

  const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
  providers.register({
    provider: new KindLabProvider({
      k8s,
      clusterName: 'jumptotech-labs',
      destroyTimeoutMs: 500,
      sleep: async () => undefined,
      waitForRequirements: async () => ({ ok: true, checks: [] }),
    }),
  });
  providers.register({ provider: new LinuxLabProvider({ runtime }) });

  const terminated: string[] = [];
  const reattached: string[] = [];
  const terminal: TerminalTerminator = {
    async terminate(sessionId) {
      terminated.push(sessionId);
    },
    async reattach(sessionId) {
      reattached.push(sessionId);
    },
  };

  const store = new InMemorySessionStore();
  const sessions = new SessionManager({
    registry,
    providers,
    store,
    terminal,
    policy: DEFAULT_SESSION_POLICY,
    lifetimes: {
      maxSessionSeconds: 3600,
      idleTimeoutSeconds: 1200,
      warningSeconds: 300,
      maxActiveSessions: options.maxActiveSessions ?? 20,
    },
    namespaceSecret: SECRET,
    ...(options.now ? { now: options.now } : {}),
  });

  return { registry, providers, store, sessions, k8s, runtime, terminated, reattached };
}

/** Container names the fake daemon currently holds. */
function liveContainers(runtime: FakeContainerRuntime): string[] {
  return [...runtime.containers.keys()].sort();
}

// --------------------------------------------------------------- starting

describe('starting Linux sessions', () => {
  it('gives each session its own container, named from its own session id', async () => {
    const { sessions, runtime } = await harness();

    const a = await sessions.start('LINUX-001');
    const b = await sessions.start('LINUX-001');

    expect(a.session.provider).toBe('linux');
    expect(a.session.sandboxKind).toBe('container');
    expect(a.session.sandboxRef).toMatch(/^jtt-lab-[0-9a-f]{12}$/);
    expect(b.session.sandboxRef).not.toBe(a.session.sandboxRef);
    expect(liveContainers(runtime)).toEqual(
      [a.session.sandboxRef, b.session.sandboxRef].sort(),
    );
  });

  it('names Kubernetes and Linux sandboxes so cleanup can never confuse them', async () => {
    const { sessions } = await harness();

    const kubernetes = await sessions.start('K8S-001');
    const linux = await sessions.start('LINUX-001');

    // Different prefixes, so a bare handle always routes back to the provider
    // that created it — the reaper is handed handles, not provider ids.
    expect(kubernetes.session.sandboxRef.startsWith('lab-')).toBe(true);
    expect(linux.session.sandboxRef.startsWith('jtt-lab-')).toBe(true);
    expect(kubernetes.session.sandboxRef).not.toBe(linux.session.sandboxRef);
  });

  it('hands the terminal a container to attach to, and no credential at all', async () => {
    const { sessions, providers, store } = await harness();
    const { session } = await sessions.start('LINUX-001');

    const stored = await store.get(session.sessionId);
    const provider = providers.peek('linux')!;
    const context = sessions.contextFor(stored!);
    const terminal = await provider.getTerminalContext(context);

    expect(terminal.kind).toBe('container-exec');
    if (terminal.kind !== 'container-exec') throw new Error('expected a container binding');
    expect(terminal.containerRef).toBe(session.sandboxRef);
    expect(terminal.user).toBe(DEFAULT_SESSION_POLICY.sandbox.user);
    // Nothing in this payload is a secret, and nothing in it is a command line.
    expect(JSON.stringify(terminal)).not.toMatch(/kubeconfig|token|password/i);
  });

  it('runs a lab’s seed scripts inside the session’s own container, then removes them', async () => {
    const { sessions, runtime } = await harness();

    // LINUX-003 stages accounts and directories a student could not create
    // themselves, which is exactly what `setup.files` cannot express.
    const { session } = await sessions.start('LINUX-003');

    expect(runtime.seedScriptsRun).toEqual(['seed.sh']);

    const seedExecs = runtime.execs.filter((e) =>
      JSON.stringify(e.request.argv).includes('/opt/jumptotech/seed'),
    );
    // Every one of them ran in this session's container, as its root, and the
    // seed directory was cleared afterwards.
    expect(seedExecs.every((e) => e.container === session.sandboxRef)).toBe(true);
    expect(seedExecs.every((e) => e.request.user === 'root')).toBe(true);
    expect(
      seedExecs.some((e) => e.request.argv[0] === '/bin/rm' && e.request.argv.includes('-rf')),
    ).toBe(true);
  });

  it('refuses to hand over an environment whose baseline failed', async () => {
    // A seed script that cannot establish the lab's starting condition — the
    // realistic failure for an accounts lab on a sandbox missing a capability.
    const runtime = new FakeContainerRuntime({
      failingSeedScripts: { 'seed.sh': { exitCode: 3, stderr: 'groupadd: permission denied' } },
    });
    const providers = new ProviderRegistry({ availabilityTtlMs: 0 });
    providers.register({ provider: new LinuxLabProvider({ runtime }) });

    const registry = new LabRegistry(LABS_DIR);
    await registry.load();
    const sessions = new SessionManager({
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

    await expect(sessions.start('LINUX-003')).rejects.toThrow(
      /seed script|permission denied|SETUP_FAILED/i,
    );
    // The half-built sandbox is not left behind for a student to land in.
    expect(liveContainers(runtime)).toEqual([]);
  });
});

// ------------------------------------------------------------- concurrency

describe('concurrent Linux sessions', () => {
  it('runs five at once, each in its own container', async () => {
    const { sessions, runtime } = await harness();

    const started = [];
    for (let i = 0; i < 5; i += 1) started.push(await sessions.start('LINUX-001'));

    const refs = started.map((s) => s.session.sandboxRef);
    expect(new Set(refs).size).toBe(5);
    expect(liveContainers(runtime)).toEqual([...refs].sort());
  });

  it('ending one leaves the other four untouched', async () => {
    const { sessions, runtime } = await harness();

    const started = [];
    for (let i = 0; i < 5; i += 1) started.push(await sessions.start('LINUX-001'));
    const victim = started[2]!.session;

    await sessions.end(victim.sessionId);

    expect(liveContainers(runtime)).toEqual(
      started
        .filter((s) => s.session.sessionId !== victim.sessionId)
        .map((s) => s.session.sandboxRef)
        .sort(),
    );
  });

  it('resetting one replaces only its own container', async () => {
    const { sessions, runtime } = await harness();

    const a = await sessions.start('LINUX-001');
    const b = await sessions.start('LINUX-001');

    // Something the student left behind, in each sandbox.
    runtime.put(a.session.sandboxRef, '/home/student/scratch.txt', { content: 'a' });
    runtime.put(b.session.sandboxRef, '/home/student/scratch.txt', { content: 'b' });

    const { result } = await sessions.reset(a.session.sessionId);
    expect(result.ok).toBe(true);

    // A container reset is a genuinely fresh container, so A's file is gone…
    expect(runtime.entry(a.session.sandboxRef, '/home/student/scratch.txt')).toBeUndefined();
    // …and B's session was not touched at all.
    expect(runtime.entry(b.session.sandboxRef, '/home/student/scratch.txt')?.content).toBe('b');
    expect(liveContainers(runtime)).toEqual([a.session.sandboxRef, b.session.sandboxRef].sort());
  });

  it('reconnects the terminal after a reset, because the shell died with the container', async () => {
    const { sessions, reattached } = await harness();
    const { session } = await sessions.start('LINUX-001');

    await sessions.reset(session.sessionId);

    expect(reattached).toEqual([session.sessionId]);
  });

  it('a Kubernetes reset does not reconnect a terminal, because it keeps the sandbox', async () => {
    const { sessions, reattached } = await harness();
    const { session } = await sessions.start('K8S-001');

    await sessions.reset(session.sessionId);

    expect(reattached).toEqual([]);
  });
});

// -------------------------------------------------------- expiry & cleanup

describe('expiry and cleanup', () => {
  function reaperFor(
    h: Awaited<ReturnType<typeof harness>>,
    now: () => number,
  ): SessionReaper {
    return new SessionReaper({
      sessions: h.sessions,
      providers: h.providers,
      intervalMs: 60_000,
      now,
    });
  }

  it('removes an expired Linux container', async () => {
    let clock = 1_000_000;
    const h = await harness({ now: () => clock });
    const { session } = await h.sessions.start('LINUX-001');
    expect(liveContainers(h.runtime)).toEqual([session.sandboxRef]);

    clock += 3601 * 1000;
    const result = await reaperFor(h, () => clock).sweep();

    // `reasons` is keyed by sandbox reference, which is what the reaper sees.
    expect(result.reasons[session.sandboxRef]).toBe('expired');
    expect(result.removed).toContain(session.sandboxRef);
    expect(liveContainers(h.runtime)).toEqual([]);
  });

  it('sweeping twice removes once and leaves the same end state', async () => {
    let clock = 1_000_000;
    const h = await harness({ now: () => clock });
    const { session } = await h.sessions.start('LINUX-001');

    clock += 3601 * 1000;
    const reaper = reaperFor(h, () => clock);
    await reaper.sweep();
    const removedAfterFirst = [...h.runtime.removed];

    await reaper.sweep();

    expect(h.runtime.removed).toEqual(removedAfterFirst);
    expect(liveContainers(h.runtime)).toEqual([]);
    expect((await h.store.get(session.sessionId))?.status).toBe('EXPIRED');
  });

  it('collects a Linux container the store has no record of', async () => {
    let clock = 1_000_000;
    const h = await harness({ now: () => clock });
    const { session } = await h.sessions.start('LINUX-001');

    // The session record vanishes — a restart with an in-memory store — but
    // the container is still there, labelled with the session that owned it.
    await h.store.delete(session.sessionId);
    // Past the expiry *and* the orphan grace period, so a sandbox that is only
    // mid-creation is never swept.
    clock += (3600 + 60 + 1) * 1000;

    const result = await reaperFor(h, () => clock).sweep();

    expect(result.reasons[session.sandboxRef]).toBe('orphaned');
    expect(liveContainers(h.runtime)).toEqual([]);
  });

  it('leaves live sessions of both tracks completely alone', async () => {
    let clock = 1_000_000;
    const h = await harness({ now: () => clock });
    const linux = await h.sessions.start('LINUX-001');
    const kubernetes = await h.sessions.start('K8S-001');

    clock += 60 * 1000;
    await reaperFor(h, () => clock).sweep();

    expect(liveContainers(h.runtime)).toEqual([linux.session.sandboxRef]);
    expect((await h.store.get(kubernetes.session.sessionId))?.status).toBe('ACTIVE');
    expect((await h.store.get(linux.session.sessionId))?.status).toBe('ACTIVE');
  });

  it('never touches a container this platform did not create', async () => {
    let clock = 1_000_000;
    const h = await harness({ now: () => clock });
    const { session } = await h.sessions.start('LINUX-001');
    h.runtime.addForeignContainer('jtt-lab-deadbeefcafe');

    clock += 3601 * 1000;
    await reaperFor(h, () => clock).sweep();

    // The session's own container went; the unlabelled look-alike did not.
    expect(h.runtime.removed).toContain(session.sandboxRef);
    expect(h.runtime.removed).not.toContain('jtt-lab-deadbeefcafe');
    expect(liveContainers(h.runtime)).toEqual(['jtt-lab-deadbeefcafe']);
  });
});
