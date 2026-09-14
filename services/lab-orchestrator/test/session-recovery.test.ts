/**
 * BETA-P0-007 — recovering lifecycle operations that were interrupted or lost.
 *
 * BETA-P0-006 made every status change a conditional write. What it left open
 * is what happens when an operation's *owner* is gone or loses its session:
 *
 *   - a start whose session End claimed while the sandbox was being built used
 *     to write ACTIVE over ENDED;
 *   - a process that died mid-reset left RESETTING until idle expiry;
 *   - a reset that failed left the session ACTIVE, possibly with no sandbox;
 *   - an End whose destroy failed, or whose process died, waited for the
 *     absolute deadline;
 *   - a sandbox rebuilt by a lost start or reset was never reclaimed while its
 *     finished row was retained.
 *
 * Staged with the same gates as the race suite: a process "dies" by parking at a
 * gate that is never released, or released only after recovery has happened.
 * Written once and run twice — in-memory here, and against PostgreSQL in
 * `session-store-integration.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  RUNTIME_OWNER_LABEL,
  SessionManager,
  SessionReaper,
  type SessionClosedEvent,
  type SessionStore,
} from '../src/index.js';
import { FakeContainerRuntime } from './container-fakes.js';
import { GatedLinuxProvider, PausableStore } from './lifecycle-harness.js';
import { realCatalog } from './real-catalog.js';

const MINUTE = 60_000;
const OWNER = 'wt-recovery';
const FOREIGN_OWNER = 'wt-someone-else';

const LIFETIMES = {
  maxSessionSeconds: 3_600,
  idleTimeoutSeconds: 1_200,
  warningSeconds: 300,
  maxActiveSessions: 20,
};

export function sessionRecovery(
  name: string,
  makeStore: () => Promise<SessionStore> | SessionStore,
): void {
  describe(`${name} — lifecycle recovery (BETA-P0-007)`, () => {
    async function world() {
      const store = await makeStore();
      const registry = await realCatalog();
      const runtime = new FakeContainerRuntime();
      const provider = new GatedLinuxProvider({ runtime, runtimeOwner: OWNER });
      const clock = { now: Date.parse('2026-09-14T12:00:00.000Z') };
      const closed: SessionClosedEvent[] = [];
      const ended: string[] = [];
      const transitions: string[] = [];
      const reattached: string[] = [];

      /** One API instance, over its own view of the shared store. */
      const instance = () => {
        const view = new PausableStore(store);
        const manager = new SessionManager({
          registry,
          provider,
          store: view,
          policy: DEFAULT_SESSION_POLICY,
          lifetimes: LIFETIMES,
          namespaceSecret: 'beta-p0-007-recovery',
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
            onTransition(from, to) {
              transitions.push(`${from}->${to}`);
            },
          },
        });
        return { manager, view };
      };

      const a = instance();
      const b = instance();
      // The reaper runs in yet another instance, with the production defaults
      // stated explicitly so the tests read against known numbers.
      const reaper = new SessionReaper({
        sessions: instance().manager,
        provider,
        intervalMs: MINUTE,
        resetRecoveryGraceMs: 10 * MINUTE,
        abandonedEndGraceMs: 5 * MINUTE,
        now: () => clock.now,
      });
      const read = async (sessionId: string) => (await store.get(sessionId))!;
      const onlySession = async () => {
        const rows = await store.list();
        expect(rows).toHaveLength(1);
        return rows[0]!;
      };

      return {
        store, runtime, provider, clock, closed, ended, transitions, reattached,
        a, b, reaper, read, onlySession,
      };
    }

    // ------------------------------------------------- 1. start + End

    it('End during provisioning wins: the start is refused, nothing is resurrected, nothing leaks', async () => {
      const w = await world();

      const building = w.provider.holdNextCreate();
      const starting = w.a.manager.start('LINUX-001');
      starting.catch(() => undefined);
      await building.entered;
      const row = await w.onlySession();
      expect(row.status).toBe('CREATING');

      // End arrives while the provider is still building, and finishes: its
      // destroy finds nothing yet to remove.
      const end = await w.b.manager.end(row.sessionId);
      expect(end.session.status).toBe('ENDED');
      const afterEnd = await w.read(row.sessionId);

      // Provisioning now completes and creates the container regardless.
      building.release();
      await expect(starting).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });

      expect(await w.read(row.sessionId)).toEqual(afterEnd);
      expect(w.runtime.containers.has(row.sandboxRef)).toBe(false);
      expect(w.transitions).not.toContain('CREATING->ACTIVE');
      expect(w.closed.map((e) => e.status)).toEqual(['ENDED']);
      expect(await w.a.manager.activeCount()).toBe(0);
    });

    it('a provisioning failure after End claimed the session does not overwrite ENDED with FAILED', async () => {
      const w = await world();
      const image = 'jumptotech/lab-linux:latest';

      const building = w.provider.holdNextCreate();
      const starting = w.a.manager.start('LINUX-001');
      starting.catch(() => undefined);
      await building.entered;
      const row = await w.onlySession();

      await w.b.manager.end(row.sessionId);
      const afterEnd = await w.read(row.sessionId);

      w.runtime.removeImage(image);
      building.release();
      await expect(starting).rejects.toMatchObject({ code: 'SESSION_PROVISION_FAILED' });

      expect(await w.read(row.sessionId)).toEqual(afterEnd);
      expect(w.transitions).not.toContain('CREATING->FAILED');
      expect(w.ended).toEqual(['student']);
    });

    // --------------------------------------------- 3. failed reset

    it('a reset whose replacement provisioning fails is DEGRADED, never a healthy ACTIVE', async () => {
      const w = await world();
      const { session } = await w.a.manager.start('LINUX-001');
      const image = w.runtime.created.at(-1)!.image;

      // The container is destroyed, then cannot be recreated.
      w.runtime.removeImage(image);
      const { session: after, result } = await w.a.manager.reset(session.sessionId);

      expect(result.ok).toBe(false);
      expect(after.status).toBe('DEGRADED');
      expect(after.statusReason).toMatch(/did not finish/);
      expect(await w.read(session.sessionId)).toEqual(after);
      expect(w.runtime.containers.has(session.sandboxRef)).toBe(false);

      // Nothing treats it as usable…
      await expect(w.b.manager.requireActive(session.sessionId)).rejects.toMatchObject({
        code: 'SESSION_NOT_ACTIVE',
        details: { status: 'DEGRADED' },
        remediation: expect.stringMatching(/Reset the lab/),
      });
      await expect(w.b.manager.getTerminalContext(session.sessionId)).rejects.toMatchObject({
        code: 'SESSION_NOT_ACTIVE',
      });
      expect(await w.b.manager.touchActivity(session.sessionId, 'terminal')).toBeNull();
      expect(w.reattached).toEqual([]);
      // …it still holds its slot, because it may still hold resources…
      expect(await w.b.manager.activeCount()).toBe(1);

      // …and it is recoverable: once the runtime is healthy, Reset rebuilds it.
      w.runtime.addImage(image);
      const again = await w.b.manager.reset(session.sessionId);
      expect(again.result.ok).toBe(true);
      expect(again.session.status).toBe('ACTIVE');
      expect(w.runtime.containers.has(session.sandboxRef)).toBe(true);
      expect(w.reattached).toEqual([session.sessionId]);
    });

    it('a reset whose provider throws is DEGRADED and reports SESSION_RESET_FAILED', async () => {
      const w = await world();
      const { session } = await w.a.manager.start('LINUX-001');
      vi.spyOn(w.provider, 'reset').mockRejectedValueOnce(new Error('runtime unreachable'));

      await expect(w.a.manager.reset(session.sessionId)).rejects.toMatchObject({
        code: 'SESSION_RESET_FAILED',
        details: { status: 'DEGRADED' },
      });
      expect((await w.read(session.sessionId)).status).toBe('DEGRADED');

      // End releases a DEGRADED session like any other.
      const end = await w.b.manager.end(session.sessionId);
      expect(end.session.status).toBe('ENDED');
      expect(w.runtime.containers.has(session.sandboxRef)).toBe(false);
    });

    it('an abandoned DEGRADED session is still reclaimed by idle expiry', async () => {
      const w = await world();
      const { session } = await w.a.manager.start('LINUX-001');
      w.runtime.removeImage(w.runtime.created.at(-1)!.image);
      await w.a.manager.reset(session.sessionId);

      w.clock.now += 21 * MINUTE;
      const sweep = await w.reaper.sweep();

      expect(sweep.reasons[session.sandboxRef]).toBe('idle');
      expect((await w.read(session.sessionId)).status).toBe('EXPIRED');
      expect(await w.a.manager.activeCount()).toBe(0);
    });

    // --------------------------------- 2. process death during RESETTING

    it('recovers a reset whose process died, and the dead reset cannot clobber the student’s next one', async () => {
      const w = await world();
      const { session } = await w.a.manager.start('LINUX-001');
      const id = session.sessionId;

      // Instance A claims RESETTING and never comes back.
      const dead = w.provider.holdNextReset();
      const abandoned = w.a.manager.reset(id);
      abandoned.catch(() => undefined);
      await dead.entered;
      const claimedByA = await w.read(id);

      // Inside the grace period a slow reset is left alone.
      w.clock.now += 5 * MINUTE;
      expect((await w.reaper.sweep()).recovered).toEqual([]);
      expect((await w.read(id)).status).toBe('RESETTING');

      // Past it, the session is recovered — to DEGRADED, not ACTIVE.
      w.clock.now += 6 * MINUTE;
      const sweep = await w.reaper.sweep();
      expect(sweep.recovered).toEqual([id]);
      expect(sweep.errors).toEqual([]);
      const recovered = await w.read(id);
      expect(recovered).toMatchObject({ status: 'DEGRADED', statusReason: expect.stringMatching(/interrupted/) });
      expect(w.transitions).toContain('RESETTING->DEGRADED');

      // Repeated sweeps change nothing.
      const again = await w.reaper.sweep();
      expect(again).toMatchObject({ recovered: [], removed: [], errors: [] });
      expect(await w.read(id)).toEqual(recovered);

      // The student resets again, on another instance. B now holds RESETTING —
      // the same status A claimed — and is mid-way through its own rebuild.
      const second = w.provider.holdNextReset();
      const rebuilding = w.b.manager.reset(id);
      await second.entered;
      const claimedByB = await w.read(id);
      expect(claimedByB.status).toBe('RESETTING');
      // Same status as A's claim; only the fence tells them apart.
      expect(claimedByB.statusChangedAt).not.toBe(claimedByA.statusChangedAt);

      // A was never dead, only stuck, and wakes up while B holds the session.
      // Its release is fenced on its own claim, which B's has replaced: it is
      // refused, it does not report success, and it does not release B's claim
      // or destroy the sandbox B is rebuilding.
      const destroysBefore = w.provider.destroys.calls;
      dead.release();
      await expect(abandoned).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
      expect(await w.read(id)).toEqual(claimedByB);
      // Checked before B runs, so B's own rebuild cannot paper over a discard.
      expect(w.provider.destroys.calls).toBe(destroysBefore);
      expect(w.runtime.containers.has(session.sandboxRef)).toBe(true);

      // B finishes and is the one that makes the session ACTIVE.
      second.release();
      const rebuilt = await rebuilding;
      expect(rebuilt.result.ok).toBe(true);
      const final = await w.read(id);
      expect(final.status).toBe('ACTIVE');
      expect(final.statusChangedAt).toBe(rebuilt.session.statusChangedAt);
      expect(w.runtime.containers.has(session.sandboxRef)).toBe(true);
    });

    it('does not recover a reset that finished between the reaper reading it and acting', async () => {
      const w = await world();
      const { session } = await w.a.manager.start('LINUX-001');

      const replacing = w.provider.holdNextReset();
      const resetting = w.a.manager.reset(session.sessionId);
      await replacing.entered;
      const observed = await w.read(session.sessionId);

      replacing.release();
      await resetting;

      expect(await w.b.manager.recoverInterruptedReset(observed)).toBeNull();
      expect((await w.read(session.sessionId)).status).toBe('ACTIVE');
    });

    // ------------------------------------ 4. teardown failure, then recovery

    it('an End whose destroy failed is finished by the reaper after the grace period, as an End', async () => {
      const w = await world();
      const { session } = await w.a.manager.start('LINUX-001');
      const id = session.sessionId;

      const remove = w.runtime.remove.bind(w.runtime);
      w.runtime.remove = async () => {
        throw new Error('simulated: daemon busy');
      };
      const first = await w.a.manager.end(id);
      expect(first.destroy.namespaceGone).toBe(false);
      expect(first.session.status).toBe('ENDING');
      expect(w.runtime.containers.has(session.sandboxRef)).toBe(true);

      // Within the grace period the reaper does not double a teardown that may
      // still be running; it reports it as pending.
      w.clock.now += MINUTE;
      const early = await w.reaper.sweep();
      expect(early.removed).toEqual([]);
      expect(early.pending).toContain(session.sandboxRef);

      // The runtime recovers. Past the grace period — long before the absolute
      // deadline — the End is finished.
      w.runtime.remove = remove;
      w.clock.now += 5 * MINUTE;
      const late = await w.reaper.sweep();
      expect(late.removed).toEqual([session.sandboxRef]);
      expect(late.reasons[session.sandboxRef]).toBe('abandoned');
      expect(Date.parse(session.expiresAt)).toBeGreaterThan(w.clock.now);

      expect(await w.read(id)).toMatchObject({ status: 'ENDED', statusReason: 'ended by student' });
      expect(w.runtime.containers.has(session.sandboxRef)).toBe(false);
      expect(w.closed.map((e) => e.status)).toEqual(['ENDED']);
      expect(w.ended).toEqual(['student']);
      expect(await w.a.manager.activeCount()).toBe(0);

      // Idempotent.
      const again = await w.reaper.sweep();
      expect(again).toMatchObject({ removed: [], errors: [], pending: [] });
      expect(w.closed).toHaveLength(1);
    });

    it('a destroy that throws leaves the End in flight instead of escaping', async () => {
      const w = await world();
      const { session } = await w.a.manager.start('LINUX-001');
      vi.spyOn(w.provider, 'destroy').mockRejectedValueOnce(new Error('simulated: provider crashed'));

      const result = await w.a.manager.end(session.sessionId);

      expect(result.destroy).toMatchObject({ ok: false, namespaceGone: false });
      expect(result.destroy.error?.message).toMatch(/provider crashed/);
      expect((await w.read(session.sessionId)).status).toBe('ENDING');
    });

    it('a sandbox rebuilt by a lost reset whose discard failed is reclaimed once its session is finished', async () => {
      const w = await world();
      const { session } = await w.a.manager.start('LINUX-001');
      const id = session.sessionId;

      const replacing = w.provider.holdNextReset();
      const resetting = w.a.manager.reset(id);
      resetting.catch(() => undefined);
      await replacing.entered;
      await w.b.manager.end(id);
      const afterEnd = await w.read(id);

      // The reset recreates the container after End destroyed it, then fails to
      // discard it.
      vi.spyOn(w.provider, 'destroy').mockRejectedValueOnce(new Error('simulated: daemon busy'));
      replacing.release();
      await expect(resetting).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
      expect(w.runtime.containers.has(session.sandboxRef)).toBe(true);

      // Retained finished rows used to shield it. No expiry grace applies: the
      // session is over, so nothing can still be building it for a student.
      const sweep = await w.reaper.sweep();
      expect(sweep.removed).toEqual([session.sandboxRef]);
      expect(sweep.reasons[session.sandboxRef]).toBe('orphaned');
      expect(w.runtime.containers.has(session.sandboxRef)).toBe(false);
      expect(await w.read(id)).toEqual(afterEnd);
      expect(w.closed).toHaveLength(1);

      const again = await w.reaper.sweep();
      expect(again).toMatchObject({ removed: [], errors: [] });
    });

    // ------------------------------------------- 5. stuck ENDING adoption

    it('adopts an End whose process died before destroying, and the late original records nothing twice', async () => {
      const w = await world();
      const { session } = await w.a.manager.start('LINUX-001');
      const id = session.sessionId;

      const dead = w.provider.holdNextDestroy();
      const abandoned = w.a.manager.end(id);
      await dead.entered;
      expect((await w.read(id)).status).toBe('ENDING');

      w.clock.now += 2 * MINUTE;
      expect((await w.reaper.sweep()).removed).toEqual([]);
      expect((await w.read(id)).status).toBe('ENDING');
      expect(w.runtime.containers.has(session.sandboxRef)).toBe(true);

      w.clock.now += 4 * MINUTE;
      const sweep = await w.reaper.sweep();
      expect(sweep.removed).toEqual([session.sandboxRef]);
      expect(await w.read(id)).toMatchObject({ status: 'ENDED', statusReason: 'ended by student' });
      expect(await w.b.manager.activeCount()).toBe(0);

      // The original End wakes up: destroy is idempotent, and the ending was
      // already recorded.
      dead.release();
      expect((await abandoned).session.status).toBe('ENDED');
      expect(w.closed.map((e) => e.status)).toEqual(['ENDED']);
      expect(w.ended).toEqual(['student']);
    });

    // --------------------------------------------- 7. ownership boundaries

    it('never reclaims a finished session’s sandbox that another runtime owner holds', async () => {
      const w = await world();
      const { session } = await w.a.manager.start('LINUX-001');
      const labels = { ...w.runtime.containers.get(session.sandboxRef)!.info.labels };
      await w.a.manager.end(session.sessionId);

      // Another deployment's container carrying the same handle and session.
      w.runtime.addForeignContainer(session.sandboxRef, {
        ...labels,
        [RUNTIME_OWNER_LABEL]: FOREIGN_OWNER,
      });

      const sweep = await w.reaper.sweep();
      expect(sweep.removed).toEqual([]);
      expect(w.runtime.containers.has(session.sandboxRef)).toBe(true);

      // Named directly, the delete is refused at the live-label check too.
      const direct = await w.b.manager.reclaimFinishedSandbox(session.sessionId);
      expect(direct.ok).toBe(false);
      expect(w.runtime.containers.has(session.sandboxRef)).toBe(true);

      expect((await w.reaper.sweep()).removed).toEqual([]);
    });

    it('an adopted End refuses to destroy a sandbox another runtime owner holds, on every pass', async () => {
      const w = await world();
      const { session } = await w.a.manager.start('LINUX-001');
      w.runtime.containers.get(session.sandboxRef)!.info.labels[RUNTIME_OWNER_LABEL] = FOREIGN_OWNER;

      const end = await w.a.manager.end(session.sessionId);
      expect(end.destroy.ok).toBe(false);

      w.clock.now += 6 * MINUTE;
      for (let pass = 0; pass < 2; pass += 1) {
        const sweep = await w.reaper.sweep();
        expect(sweep.removed).toEqual([]);
        expect(sweep.errors.join('\n')).toMatch(/owner/i);
        expect((await w.read(session.sessionId)).status).toBe('ENDING');
        expect(w.runtime.containers.has(session.sandboxRef)).toBe(true);
      }
    });

    // ------------------- 8. recovery combined with runtime ownership (P0-008)
    //
    // BETA-P0-008 made discovery an exact owner match and let an unlabelled
    // resource be deleted only by a teardown that names its session. These pin
    // how that composes with P0-007's adoption and recovery paths.

    it('adopts a stuck End on a sandbox from before the owner label existed, because its own session vouches for it', async () => {
      const w = await world();
      const { session } = await w.a.manager.start('LINUX-001');
      const id = session.sessionId;
      // A sandbox created by a build that did not stamp runtime owners.
      delete w.runtime.containers.get(session.sandboxRef)!.info.labels[RUNTIME_OWNER_LABEL];

      const remove = w.runtime.remove.bind(w.runtime);
      w.runtime.remove = async () => {
        throw new Error('simulated: daemon busy');
      };
      expect((await w.a.manager.end(id)).session.status).toBe('ENDING');
      w.runtime.remove = remove;

      w.clock.now += 6 * MINUTE;
      const sweep = await w.reaper.sweep();
      expect(sweep.removed).toEqual([session.sandboxRef]);
      expect(sweep.reasons[session.sandboxRef]).toBe('abandoned');
      expect(await w.read(id)).toMatchObject({ status: 'ENDED', statusReason: 'ended by student' });
      expect(w.runtime.containers.has(session.sandboxRef)).toBe(false);

      const again = await w.reaper.sweep();
      expect(again).toMatchObject({ removed: [], errors: [], pending: [] });
      expect(w.closed).toHaveLength(1);
    });

    it('recovers an interrupted reset without destroying anything, and never destroys a foreign owner’s sandbox under it', async () => {
      const w = await world();
      const { session } = await w.a.manager.start('LINUX-001');
      const id = session.sessionId;
      const ownerOf = () => w.runtime.containers.get(session.sandboxRef)?.info.labels[RUNTIME_OWNER_LABEL];
      w.runtime.containers.get(session.sandboxRef)!.info.labels[RUNTIME_OWNER_LABEL] = FOREIGN_OWNER;

      // The reset's process "dies" after claiming RESETTING.
      const dead = w.provider.holdNextReset();
      const resetting = w.a.manager.reset(id);
      resetting.catch(() => undefined);
      await dead.entered;
      const destroysBefore = w.provider.destroys.calls;

      w.clock.now += 11 * MINUTE;
      const sweep = await w.reaper.sweep();
      expect(sweep.recovered).toEqual([id]);
      expect(sweep.removed).toEqual([]);
      expect((await w.read(id)).status).toBe('DEGRADED');
      // Recovery is a status change only: no teardown was attempted.
      expect(w.provider.destroys.calls).toBe(destroysBefore);
      expect(ownerOf()).toBe(FOREIGN_OWNER);

      const again = await w.reaper.sweep();
      expect(again).toMatchObject({ removed: [], recovered: [], errors: [] });
      expect((await w.read(id)).status).toBe('DEGRADED');

      // Ending the DEGRADED session goes through the provider's owner gate.
      const end = await w.b.manager.end(id);
      expect(end.destroy.ok).toBe(false);
      expect(ownerOf()).toBe(FOREIGN_OWNER);

      // And the dead reset waking late cannot remove it either.
      dead.release();
      await resetting.catch(() => undefined);
      expect(ownerOf()).toBe(FOREIGN_OWNER);
    });

    it('leaves a finished session’s unowned sandbox to an operator, while a reclaim naming that session still works', async () => {
      const w = await world();
      const { session } = await w.a.manager.start('LINUX-001');
      const unowned = { ...w.runtime.containers.get(session.sandboxRef)!.info.labels };
      delete unowned[RUNTIME_OWNER_LABEL];
      await w.a.manager.end(session.sessionId);
      w.runtime.addForeignContainer(session.sandboxRef, unowned);

      // Discovery is owner-exact, so the orphan sweep cannot adopt it — on
      // every pass.
      for (let pass = 0; pass < 2; pass += 1) {
        const sweep = await w.reaper.sweep();
        expect(sweep).toMatchObject({ removed: [], errors: [] });
        expect(w.runtime.containers.has(session.sandboxRef)).toBe(true);
      }

      // A delete that names the session its label carries is the one exception.
      const named = await w.b.manager.reclaimFinishedSandbox(session.sessionId);
      expect(named.ok).toBe(true);
      expect(w.runtime.containers.has(session.sandboxRef)).toBe(false);
    });

    it('refuses to reclaim anything for a session that is not finished', async () => {
      const w = await world();
      const { session } = await w.a.manager.start('LINUX-001');

      const result = await w.b.manager.reclaimFinishedSandbox(session.sessionId);

      expect(result.ok).toBe(false);
      expect(w.runtime.containers.has(session.sandboxRef)).toBe(true);
    });
  });
}

sessionRecovery('InMemorySessionStore', () => new InMemorySessionStore());
