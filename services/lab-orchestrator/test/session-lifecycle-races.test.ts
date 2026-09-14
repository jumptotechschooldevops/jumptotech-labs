/**
 * BETA-P0-006 — lifecycle operations racing on one session.
 *
 * The store contract proves that one conditional write has one winner. What it
 * cannot prove is that the *manager* uses one: a reset that reads ACTIVE and
 * later writes RESETTING, or a touch that reads ACTIVE and later stamps
 * activity, is a read-then-write no matter how good the store underneath is.
 *
 * Every race here is staged, not hoped for. A test parks one operation at the
 * exact point where another API instance could interleave — after a read, while
 * the provider is replacing the sandbox, while End is destroying it — runs the
 * competing operation to the point it needs, and only then lets the first one
 * go. No timers: each gate opens when the test says so.
 *
 * Written once and run twice, like the store contract: against the in-memory
 * store here, and against a real PostgreSQL in `session-store-integration.test.ts`,
 * where the two "instances" reach the row through separate pooled connections.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  SessionManager,
  type SessionClosedEvent,
  type SessionStore,
} from '../src/index.js';
import { FakeContainerRuntime } from './container-fakes.js';
import { GatedLinuxProvider, PausableStore } from './lifecycle-harness.js';
import { realCatalog } from './real-catalog.js';

const LIFETIMES = {
  maxSessionSeconds: 3_600,
  idleTimeoutSeconds: 1_200,
  warningSeconds: 300,
  maxActiveSessions: 20,
};

/** Settles to the rejection reason, and never settles for a fulfilment. */
const rejectionOf = (operation: Promise<unknown>): Promise<unknown> =>
  operation.then(
    () => new Promise<never>(() => undefined),
    (error: unknown) => error,
  );

export function sessionLifecycleRaces(
  name: string,
  makeStore: () => Promise<SessionStore> | SessionStore,
): void {
  describe(`${name} — lifecycle races (BETA-P0-006)`, () => {
    async function world() {
      const store = await makeStore();
      const registry = await realCatalog();
      const runtime = new FakeContainerRuntime();
      const provider = new GatedLinuxProvider({ runtime });
      const clock = { now: Date.parse('2026-09-13T12:00:00.000Z') };
      const reattached: string[] = [];
      const closed: SessionClosedEvent[] = [];
      const ended: string[] = [];

      /** A manager standing in for one API instance, over its own view of the store. */
      const instance = () => {
        const view = new PausableStore(store);
        const manager = new SessionManager({
          registry,
          provider,
          store: view,
          policy: DEFAULT_SESSION_POLICY,
          lifetimes: LIFETIMES,
          namespaceSecret: 'beta-p0-006-races',
          now: () => clock.now,
          terminal: {
            async terminate() {},
            async reattach(sessionId) {
              reattached.push(sessionId);
            },
          },
          listener: {
            onSessionClosed(event) {
              closed.push(event);
            },
          },
          metrics: {
            onSessionEnded(event) {
              ended.push(event.reason);
            },
          },
        });
        return { manager, view };
      };

      const a = instance();
      const b = instance();
      const { session } = await a.manager.start('LINUX-001');
      // Ten quiet minutes, so any activity written from here on is visible.
      clock.now += 10 * 60_000;
      const read = async () => (await store.get(session.sessionId))!;

      return { store, runtime, provider, clock, reattached, closed, ended, a, b, session, read };
    }

    // ------------------------------------------------------ reset + End

    it('End claiming a session mid-reset wins: no resurrection, no leaked sandbox, no false success', async () => {
      const { a, b, provider, runtime, session, read, reattached, closed } = await world();

      const replacing = provider.holdResets();
      const resetting = a.manager.reset(session.sessionId);
      resetting.catch(() => undefined);
      await replacing.entered;
      expect((await read()).status).toBe('RESETTING');

      // End arrives while the provider is replacing the sandbox, and finishes.
      const end = await b.manager.end(session.sessionId);
      expect(end.session.status).toBe('ENDED');
      const afterEnd = await read();

      // The reset's runtime work now completes against a session End owns.
      replacing.release();
      await expect(resetting).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });

      const final = await read();
      expect(final.status).toBe('ENDED');
      expect(final.endedAt).toBe(afterEnd.endedAt);
      expect(final.lastActivityAt).toBe(afterEnd.lastActivityAt);
      // The container the reset recreated after End destroyed the old one is gone too.
      expect(runtime.containers.has(session.sandboxRef)).toBe(false);
      expect(provider.resets.calls).toBe(1);
      expect(reattached).toEqual([]);
      expect(closed.map((e) => e.status)).toEqual(['ENDED']);
    });

    it('a reset that read ACTIVE before End claimed the session does no runtime work', async () => {
      const { a, b, provider, runtime, session, read } = await world();

      const staleRead = a.view.pauseNextGet();
      const resetting = a.manager.reset(session.sessionId);
      resetting.catch(() => undefined);
      await staleRead.entered;

      await b.manager.end(session.sessionId);
      const afterEnd = await read();
      staleRead.release();

      await expect(resetting).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
      expect(await read()).toEqual(afterEnd);
      expect(provider.resets.calls).toBe(0);
      expect(runtime.containers.has(session.sandboxRef)).toBe(false);
    });

    // ------------------------------------------------------ reset + reset

    it('two simultaneous resets replace the sandbox once; the other is refused', async () => {
      const { a, b, provider, runtime, session, read, reattached } = await world();
      const createdBefore = runtime.created.length;

      // Both instances have read ACTIVE before either acts.
      const readA = a.view.pauseNextGet();
      const readB = b.view.pauseNextGet();
      const first = a.manager.reset(session.sessionId);
      const second = b.manager.reset(session.sessionId);
      first.catch(() => undefined);
      second.catch(() => undefined);
      await Promise.all([readA.entered, readB.entered]);

      // Whoever reaches the runtime stays there until the other has been
      // decided, so the loser cannot simply run a second, sequential reset.
      const replacing = provider.holdResets();
      readA.release();
      readB.release();
      await Promise.race([
        rejectionOf(first),
        rejectionOf(second),
        provider.resets.reached(2),
      ]);
      replacing.release();

      const outcomes = await Promise.allSettled([first, second]);
      expect(provider.resets.calls).toBe(1);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const refused = outcomes.filter((o) => o.status === 'rejected');
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'SESSION_NOT_ACTIVE',
      });

      expect((await read()).status).toBe('ACTIVE');
      expect(runtime.created.length - createdBefore).toBe(1);
      expect(runtime.containers.has(session.sandboxRef)).toBe(true);
      expect(reattached).toEqual([session.sessionId]);
    });

    // -------------------------------------------------------- touch + End

    it('a Continue/Check touch cannot stamp activity onto a session End has claimed', async () => {
      const { a, b, session, read } = await world();

      const staleRead = a.view.pauseNextGet();
      const touching = a.manager.touch(session.sessionId, 'continue');
      // A touch that never reads first simply finishes here, before End.
      await Promise.race([staleRead.entered, touching]);

      await b.manager.end(session.sessionId);
      const afterEnd = await read();
      staleRead.release();
      const touched = await touching;

      expect(await read()).toEqual(afterEnd);
      // What the caller is shown is true: either the touch landed before End
      // (and End's row carries it), or it reports the session as it now is.
      expect(
        touched?.status === 'ENDED' || touched?.lastActivityAt === afterEnd.lastActivityAt,
      ).toBe(true);
    });

    // ------------------------------------------------ touchActivity + End

    it('terminal activity cannot mutate a session once End has claimed it', async () => {
      const { a, b, provider, session, read } = await world();

      const staleRead = a.view.pauseNextGet();
      const touching = a.manager.touchActivity(session.sessionId, 'terminal');
      await Promise.race([staleRead.entered, touching]);

      // End claims the session and parks mid-teardown: ENDING, sandbox not yet gone.
      const destroying = provider.holdDestroys();
      const ending = b.manager.end(session.sessionId);
      await destroying.entered;
      const claimed = await read();
      expect(claimed.status).toBe('ENDING');

      staleRead.release();
      const touched = await touching;
      expect(await read()).toEqual(claimed);
      expect(touched === null || touched.lastActivityAt === claimed.lastActivityAt).toBe(true);

      destroying.release();
      await ending;
      const final = await read();
      expect(final.status).toBe('ENDED');
      expect(final.lastActivityAt).toBe(claimed.lastActivityAt);
    });

    it('records no activity of any kind while a teardown is in flight', async () => {
      const { a, b, provider, clock, session, read } = await world();

      const destroying = provider.holdDestroys();
      const ending = b.manager.end(session.sessionId);
      await destroying.entered;
      const claimed = await read();

      clock.now += 60_000;
      expect(await a.manager.touchActivity(session.sessionId, 'terminal')).toBeNull();
      expect((await a.manager.touch(session.sessionId, 'check'))?.status).toBe('ENDING');
      expect(await read()).toEqual(claimed);

      destroying.release();
      await ending;
    });

    // ---------------------------------------------------------- End + End

    it('two Ends that both resume the teardown record the ending once', async () => {
      const { a, b, provider, runtime, session, read, closed, ended } = await world();

      const destroying = provider.holdDestroys();
      const first = a.manager.end(session.sessionId);
      const second = b.manager.end(session.sessionId);
      await provider.destroys.reached(2);
      destroying.release();

      const results = await Promise.all([first, second]);
      expect(results.every((r) => r.session.status === 'ENDED')).toBe(true);
      expect((await read()).status).toBe('ENDED');
      expect(runtime.containers.has(session.sandboxRef)).toBe(false);
      // One ENDED write, one closed attempt, one lifetime observation.
      expect(closed).toHaveLength(1);
      expect(ended).toEqual(['student']);
    });
  });
}

sessionLifecycleRaces('InMemorySessionStore', () => new InMemorySessionStore());
