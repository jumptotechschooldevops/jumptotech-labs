/**
 * BETA-P0-009 — the per-student session limit, through the manager.
 *
 * The store contract proves the admission decision is atomic. This proves the
 * manager asks the right question with it: that a refused start never reaches
 * the provider, that the two refusals stay distinguishable all the way out, and
 * that a slot comes back exactly when the session stops holding a sandbox —
 * not when End is pressed, and not before a failed start has been recorded.
 *
 * It also pins how the limit composes with recovery (BETA-P0-007) and runtime
 * ownership (BETA-P0-008): a start that loses its session to End during
 * provisioning, a reset that fails or whose process dies, a stuck End the
 * reaper adopts, and a sandbox another runtime owner holds. None of those may
 * double-count a session, release its slot early, let a provisioning race push
 * a student past their limit, or leave the slot taken after legitimate cleanup.
 *
 * Written once and run twice, like the lifecycle races: here against one
 * in-memory store shared by two managers, and in
 * `session-store-integration.test.ts` against PostgreSQL, where the two
 * managers stand for two API instances with their own connection pools.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SESSION_POLICY,
  InMemorySessionStore,
  RUNTIME_OWNER_LABEL,
  SessionError,
  SessionManager,
  SessionReaper,
  type SessionStore,
  type StartSessionResult,
} from '../src/index.js';
import { FakeContainerRuntime } from './container-fakes.js';
import { GatedLinuxProvider } from './lifecycle-harness.js';
import { realCatalog } from './real-catalog.js';

const MINUTE = 60_000;
const OWNER = 'wt-per-student';
const FOREIGN_OWNER = 'wt-someone-else';
const LAB = 'LINUX-001';
const IMAGE = 'jumptotech/lab-linux:latest';

/** Two views of one shared session store: one per API instance. */
export interface TwoInstanceStores {
  a: SessionStore;
  b: SessionStore;
}

function codeOf(result: PromiseSettledResult<unknown>): string | undefined {
  if (result.status === 'fulfilled') return undefined;
  return result.reason instanceof SessionError ? result.reason.code : String(result.reason);
}

function admitted(results: PromiseSettledResult<StartSessionResult>[]): StartSessionResult[] {
  return results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
}

export function perStudentCapacity(
  name: string,
  makeStores: () => Promise<TwoInstanceStores> | TwoInstanceStores,
  owners: readonly string[],
): void {
  describe(`${name} — per-student session limit (BETA-P0-009)`, () => {
    const [ALICE, BOB, CAROL, DAVE] = owners as [string, string, string, string];

    async function world(limits: { maxActiveSessions: number; maxActiveSessionsPerStudent?: number }) {
      const stores = await makeStores();
      const registry = await realCatalog();
      const runtime = new FakeContainerRuntime();
      const provider = new GatedLinuxProvider({ runtime, runtimeOwner: OWNER });
      const clock = { now: Date.parse('2026-09-14T12:00:00.000Z') };
      const refusals = { capacity: 0, student: 0 };

      const instance = (store: SessionStore) =>
        new SessionManager({
          registry,
          provider,
          store,
          policy: DEFAULT_SESSION_POLICY,
          lifetimes: { maxSessionSeconds: 3_600, idleTimeoutSeconds: 1_200, warningSeconds: 300, ...limits },
          namespaceSecret: 'beta-p0-009-per-student',
          now: () => clock.now,
          metrics: {
            onCapacityRejected: () => {
              refusals.capacity += 1;
            },
            onStudentLimitRejected: () => {
              refusals.student += 1;
            },
          },
        });

      const a = instance(stores.a);
      const b = instance(stores.b);
      // The reaper runs in a third instance, with the production grace periods.
      const reaper = new SessionReaper({
        sessions: instance(stores.a),
        provider,
        intervalMs: MINUTE,
        resetRecoveryGraceMs: 10 * MINUTE,
        abandonedEndGraceMs: 5 * MINUTE,
        now: () => clock.now,
      });
      const heldBy = async (owner: string) =>
        (await stores.a.listOccupying()).filter((s) => s.ownerUserId === owner).length;
      const read = async (sessionId: string) => (await stores.a.get(sessionId))!;
      return { a, b, reaper, store: stores.a, runtime, provider, clock, refusals, heldBy, read };
    }

    // ------------------------------------------------------------ concurrency

    it('with a limit of one, admits exactly one of two simultaneous starts by the same student', async () => {
      const w = await world({ maxActiveSessions: 5, maxActiveSessionsPerStudent: 1 });

      const results = await Promise.allSettled([w.a.start(LAB, ALICE), w.b.start(LAB, ALICE)]);

      expect(admitted(results)).toHaveLength(1);
      expect(results.map(codeOf).filter(Boolean)).toEqual(['STUDENT_SESSION_LIMIT_REACHED']);
      expect(w.provider.creates.calls).toBe(1);
      expect(await w.heldBy(ALICE)).toBe(1);
      expect(w.refusals).toEqual({ capacity: 0, student: 1 });
    });

    it('admits exactly the limit when one student starts many labs at once across two instances', async () => {
      const w = await world({ maxActiveSessions: 20, maxActiveSessionsPerStudent: 2 });

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? w.a : w.b).start(LAB, ALICE)),
      );

      expect(admitted(results)).toHaveLength(2);
      expect(results.map(codeOf).filter(Boolean)).toEqual(
        Array.from({ length: 6 }, () => 'STUDENT_SESSION_LIMIT_REACHED'),
      );
      // No refused start reached the provider, so no sandbox was ever made for one.
      expect(w.provider.creates.calls).toBe(2);
      expect(await w.heldBy(ALICE)).toBe(2);
      expect(await w.a.activeCount()).toBe(2);
      expect(w.refusals).toEqual({ capacity: 0, student: 6 });
      for (const started of admitted(results)) {
        expect(started.session).toMatchObject({ status: 'ACTIVE', ownerUserId: ALICE });
      }
    });

    it('holds different students starting together to their own limits, all under the global ceiling', async () => {
      const w = await world({ maxActiveSessions: 8, maxActiveSessionsPerStudent: 2 });
      const students = [ALICE, BOB, CAROL, DAVE];

      // Interleaved, so every student's starts overlap every other student's.
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          (i % 2 === 0 ? w.a : w.b).start(LAB, students[i % students.length]!),
        ),
      );

      expect(admitted(results)).toHaveLength(8);
      for (const student of students) expect(await w.heldBy(student)).toBe(2);
      expect(w.refusals).toEqual({ capacity: 0, student: 4 });
      expect(w.provider.creates.calls).toBe(8);
    });

    it('lets the global ceiling bind when students under their own limits start together', async () => {
      const w = await world({ maxActiveSessions: 5, maxActiveSessionsPerStudent: 2 });
      const students = [ALICE, BOB, CAROL, DAVE];

      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          (i % 2 === 0 ? w.a : w.b).start(LAB, students[i % students.length]!),
        ),
      );

      expect(admitted(results)).toHaveLength(5);
      expect(await w.a.activeCount()).toBe(5);
      for (const student of students) expect(await w.heldBy(student)).toBeLessThanOrEqual(2);
      const codes = results.map(codeOf).filter(Boolean);
      expect(codes.filter((c) => c === 'LAB_CAPACITY_REACHED')).toHaveLength(w.refusals.capacity);
      expect(codes.filter((c) => c === 'STUDENT_SESSION_LIMIT_REACHED')).toHaveLength(w.refusals.student);
      expect(w.refusals.capacity + w.refusals.student).toBe(7);
      // At most two students can be full with five admitted, so at most two
      // refusals are theirs; the rest are the platform being full.
      expect(w.refusals.capacity).toBeGreaterThanOrEqual(5);
      expect(w.provider.creates.calls).toBe(5);
    });

    it('holds the private-beta policy: five students pressing Start twice at once fill the platform, one lab each', async () => {
      const w = await world({ maxActiveSessions: 5, maxActiveSessionsPerStudent: 1 });
      const students = owners.slice(0, 5);
      expect(new Set(students).size).toBe(5);

      // Every student presses Start twice, once on each instance, all at once.
      const results = await Promise.allSettled(
        students.flatMap((student) => [w.a.start(LAB, student), w.b.start(LAB, student)]),
      );

      // Exactly one each. The platform is full only once every student holds
      // their one, so every refusal is a student's own second press.
      expect(admitted(results)).toHaveLength(5);
      for (const student of students) expect(await w.heldBy(student)).toBe(1);
      expect(await w.a.activeCount()).toBe(5);
      expect(w.refusals).toEqual({ capacity: 0, student: 5 });
      expect(w.provider.creates.calls).toBe(5);
    });

    // -------------------------------------------------------------- boundaries

    it('refuses at the per-student boundary with a clear error carrying only that student’s numbers', async () => {
      const w = await world({ maxActiveSessions: 20, maxActiveSessionsPerStudent: 2 });
      await w.a.start(LAB, ALICE);
      await w.b.start(LAB, ALICE);

      const refusal = await w.a.start(LAB, ALICE).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(SessionError);
      expect(refusal).toMatchObject({
        code: 'STUDENT_SESSION_LIMIT_REACHED',
        message: 'You already have 2 practice environments running, the most one student can hold at once.',
      });
      expect((refusal as SessionError).details).toEqual({ activeSessions: 2, maxActiveSessionsPerStudent: 2 });
      expect(w.refusals).toEqual({ capacity: 0, student: 1 });

      // Another student is unaffected.
      expect((await w.b.start(LAB, BOB)).session.status).toBe('ACTIVE');
    });

    it('refuses at the global boundary as the platform being full, not as the student’s limit', async () => {
      const w = await world({ maxActiveSessions: 2, maxActiveSessionsPerStudent: 5 });
      await w.a.start(LAB, ALICE);
      await w.b.start(LAB, BOB);

      const refusal = await w.a.start(LAB, CAROL).catch((error: unknown) => error);
      expect(refusal).toMatchObject({
        code: 'LAB_CAPACITY_REACHED',
        details: { activeSessions: 2, maxActiveSessions: 2 },
      });
      expect(w.refusals).toEqual({ capacity: 1, student: 0 });
    });

    it('with no per-student limit given to the manager, one student may still fill the platform', async () => {
      // The library's own default; the API configures the beta policy of one.
      const w = await world({ maxActiveSessions: 3 });
      for (let i = 0; i < 3; i += 1) await (i % 2 === 0 ? w.a : w.b).start(LAB, ALICE);

      await expect(w.a.start(LAB, ALICE)).rejects.toMatchObject({ code: 'LAB_CAPACITY_REACHED' });
      expect(w.refusals).toEqual({ capacity: 1, student: 0 });
    });

    it('holds a start with no owner to the global ceiling only', async () => {
      const w = await world({ maxActiveSessions: 3, maxActiveSessionsPerStudent: 1 });
      for (let i = 0; i < 3; i += 1) await w.a.start(LAB);

      await expect(w.b.start(LAB)).rejects.toMatchObject({ code: 'LAB_CAPACITY_REACHED' });
    });

    // ---------------------------------------------------- releasing the slot

    it('gives the slot back when the student ends a session, seen from the other instance', async () => {
      const w = await world({ maxActiveSessions: 20, maxActiveSessionsPerStudent: 1 });
      const first = await w.a.start(LAB, ALICE);
      await expect(w.b.start(LAB, ALICE)).rejects.toMatchObject({ code: 'STUDENT_SESSION_LIMIT_REACHED' });

      expect((await w.b.end(first.session.sessionId)).session.status).toBe('ENDED');

      expect((await w.b.start(LAB, ALICE)).session.status).toBe('ACTIVE');
    });

    it('gives the slot back when the reaper expires a session', async () => {
      const w = await world({ maxActiveSessions: 20, maxActiveSessionsPerStudent: 1 });
      const first = await w.a.start(LAB, ALICE);

      w.clock.now += 21 * MINUTE;
      const sweep = await w.reaper.sweep();
      expect(sweep.reasons[first.session.sandboxRef]).toBe('idle');
      expect((await w.read(first.session.sessionId)).status).toBe('EXPIRED');

      expect((await w.a.start(LAB, ALICE)).session.status).toBe('ACTIVE');
    });

    it('does not let a failed start hold the student’s slot', async () => {
      const w = await world({ maxActiveSessions: 20, maxActiveSessionsPerStudent: 1 });
      vi.spyOn(w.provider, 'create').mockRejectedValueOnce(new Error('runtime refused the sandbox'));

      await expect(w.a.start(LAB, ALICE)).rejects.toMatchObject({ code: 'SESSION_PROVISION_FAILED' });
      const failed = (await w.store.list()).filter((s) => s.ownerUserId === ALICE);
      expect(failed.map((s) => s.status)).toEqual(['FAILED']);

      expect((await w.b.start(LAB, ALICE)).session.status).toBe('ACTIVE');
    });

    it('keeps the slot taken while a teardown still holds the sandbox', async () => {
      const w = await world({ maxActiveSessions: 20, maxActiveSessionsPerStudent: 1 });
      const first = await w.a.start(LAB, ALICE);

      const destroying = w.provider.holdDestroys();
      const ending = w.b.end(first.session.sessionId);
      await destroying.entered;
      expect((await w.read(first.session.sessionId)).status).toBe('ENDING');

      // The sandbox has not gone yet, so neither has the slot.
      await expect(w.a.start(LAB, ALICE)).rejects.toMatchObject({ code: 'STUDENT_SESSION_LIMIT_REACHED' });

      destroying.release();
      expect((await ending).session.status).toBe('ENDED');
      expect((await w.a.start(LAB, ALICE)).session.status).toBe('ACTIVE');
    });

    it('keeps the slot taken while a session is being reset', async () => {
      const w = await world({ maxActiveSessions: 20, maxActiveSessionsPerStudent: 1 });
      const first = await w.a.start(LAB, ALICE);

      const replacing = w.provider.holdResets();
      const resetting = w.a.reset(first.session.sessionId);
      await replacing.entered;
      expect((await w.read(first.session.sessionId)).status).toBe('RESETTING');

      await expect(w.b.start(LAB, ALICE)).rejects.toMatchObject({ code: 'STUDENT_SESSION_LIMIT_REACHED' });

      replacing.release();
      expect((await resetting).session.status).toBe('ACTIVE');
      // A finished reset is still the student's one session. (Not asserted via
      // `creates`: a container reset recreates its sandbox through `create`.)
      await expect(w.b.start(LAB, ALICE)).rejects.toMatchObject({ code: 'STUDENT_SESSION_LIMIT_REACHED' });
      expect((await w.store.list()).filter((s) => s.ownerUserId === ALICE)).toHaveLength(1);
    });

    // ------------------------------- recovery and lifecycle (BETA-P0-007)

    it('End during provisioning holds the slot until the build is discarded, so a lost start cannot push the student past it', async () => {
      const w = await world({ maxActiveSessions: 5, maxActiveSessionsPerStudent: 1 });

      const building = w.provider.holdNextCreate();
      const lost = w.a.start(LAB, ALICE);
      lost.catch(() => undefined);
      await building.entered;
      const [row] = (await w.store.list()).filter((s) => s.ownerUserId === ALICE);
      expect(row?.status).toBe('CREATING');

      // A reservation still being provisioned holds the slot.
      await expect(w.b.start(LAB, ALICE)).rejects.toMatchObject({ code: 'STUDENT_SESSION_LIMIT_REACHED' });

      // End claims it mid-provisioning, but its sandbox is still being built:
      // the session stays ENDING, and keeps the slot, until the build is over.
      // Recording ENDED here let a Start / End loop build any number at once.
      const ending = await w.b.end(row!.sessionId);
      expect(ending.session.status).toBe('ENDING');
      expect(ending.destroy.namespaceGone).toBe(false);
      await expect(w.b.start(LAB, ALICE)).rejects.toMatchObject({ code: 'STUDENT_SESSION_LIMIT_REACHED' });

      // The original provisioning now finishes. It must not become a second
      // ACTIVE session for Alice, and what it built must not survive.
      building.release();
      await expect(lost).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
      expect((await w.read(row!.sessionId)).status).toBe('ENDED');
      expect(w.runtime.containers.has(row!.sandboxRef)).toBe(false);
      expect(await w.heldBy(ALICE)).toBe(0);

      const replacement = await w.b.start(LAB, ALICE);
      expect(replacement.session.status).toBe('ACTIVE');
      expect(w.runtime.containers.has(replacement.session.sandboxRef)).toBe(true);
      expect(await w.heldBy(ALICE)).toBe(1);
      expect(await w.a.activeCount()).toBe(1);
      expect(w.refusals).toEqual({ capacity: 0, student: 2 });
    });

    it('End during provisioning does not hand its slot to another student while the build goes on', async () => {
      const w = await world({ maxActiveSessions: 1, maxActiveSessionsPerStudent: 1 });

      const building = w.provider.holdNextCreate();
      const lost = w.a.start(LAB, ALICE);
      lost.catch(() => undefined);
      await building.entered;
      const [row] = (await w.store.list()).filter((s) => s.ownerUserId === ALICE);
      await w.b.end(row!.sessionId);

      // Alice's sandbox is still being built: the platform's one slot is taken.
      await expect(w.b.start(LAB, BOB)).rejects.toMatchObject({ code: 'LAB_CAPACITY_REACHED' });

      building.release();
      await expect(lost).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
      expect(w.runtime.containers.has(row!.sandboxRef)).toBe(false);
      expect((await w.b.start(LAB, BOB)).session.status).toBe('ACTIVE');
      expect([...w.runtime.containers.keys()]).toHaveLength(1);
    });

    it('a provisioning failure after End claimed the session releases the slot exactly once', async () => {
      const w = await world({ maxActiveSessions: 5, maxActiveSessionsPerStudent: 1 });

      const building = w.provider.holdNextCreate();
      const lost = w.a.start(LAB, ALICE);
      lost.catch(() => undefined);
      await building.entered;
      const [row] = (await w.store.list()).filter((s) => s.ownerUserId === ALICE);
      await w.b.end(row!.sessionId);

      w.runtime.removeImage(IMAGE);
      building.release();
      await expect(lost).rejects.toMatchObject({ code: 'SESSION_PROVISION_FAILED' });
      // End's record stands; FAILED did not overwrite it.
      expect((await w.read(row!.sessionId)).status).toBe('ENDED');
      expect(await w.heldBy(ALICE)).toBe(0);

      w.runtime.addImage(IMAGE);
      expect((await w.b.start(LAB, ALICE)).session.status).toBe('ACTIVE');
      expect(await w.heldBy(ALICE)).toBe(1);
    });

    it('a failed reset leaves the session DEGRADED holding its one slot, until Reset or End resolves it', async () => {
      const w = await world({ maxActiveSessions: 2, maxActiveSessionsPerStudent: 1 });
      const { session } = await w.a.start(LAB, ALICE);

      w.runtime.removeImage(IMAGE);
      const failed = await w.a.reset(session.sessionId);
      expect(failed.session.status).toBe('DEGRADED');
      // The image is back: with it missing the provider is unavailable, and a
      // Start is refused for that before any limit is counted.
      w.runtime.addImage(IMAGE);

      // DEGRADED may still hold resources: it counts, once, against both limits.
      expect(await w.heldBy(ALICE)).toBe(1);
      expect(await w.a.activeCount()).toBe(1);
      await expect(w.b.start(LAB, ALICE)).rejects.toMatchObject({ code: 'STUDENT_SESSION_LIMIT_REACHED' });
      await w.b.start(LAB, BOB);
      await expect(w.a.start(LAB, CAROL)).rejects.toMatchObject({ code: 'LAB_CAPACITY_REACHED' });

      // Reset rebuilds it: still one session, still one slot.
      expect((await w.b.reset(session.sessionId)).session.status).toBe('ACTIVE');
      expect(await w.heldBy(ALICE)).toBe(1);
      await expect(w.a.start(LAB, ALICE)).rejects.toMatchObject({ code: 'STUDENT_SESSION_LIMIT_REACHED' });

      // End releases it.
      await w.a.end(session.sessionId);
      expect((await w.b.start(LAB, ALICE)).session.status).toBe('ACTIVE');
      expect(await w.heldBy(ALICE)).toBe(1);
    });

    it('an interrupted reset recovered by the reaper keeps exactly one slot across repeated sweeps', async () => {
      const w = await world({ maxActiveSessions: 2, maxActiveSessionsPerStudent: 1 });
      const { session } = await w.a.start(LAB, ALICE);
      const id = session.sessionId;

      // The reset's process "dies" after claiming RESETTING.
      const dead = w.provider.holdNextReset();
      const abandoned = w.a.reset(id);
      abandoned.catch(() => undefined);
      await dead.entered;

      w.clock.now += 11 * MINUTE;
      expect((await w.reaper.sweep()).recovered).toEqual([id]);
      expect((await w.read(id)).status).toBe('DEGRADED');

      for (let pass = 0; pass < 3; pass += 1) {
        const sweep = await w.reaper.sweep();
        expect(sweep).toMatchObject({ recovered: [], removed: [], errors: [] });
        expect(await w.heldBy(ALICE)).toBe(1);
        expect(await w.a.activeCount()).toBe(1);
      }

      // Recovery neither released the slot early nor counted it twice.
      await expect(w.b.start(LAB, ALICE)).rejects.toMatchObject({ code: 'STUDENT_SESSION_LIMIT_REACHED' });
      await w.b.start(LAB, BOB);
      await expect(w.a.start(LAB, CAROL)).rejects.toMatchObject({ code: 'LAB_CAPACITY_REACHED' });

      // End releases it, and the dead reset waking late cannot take it back.
      expect((await w.b.end(id)).session.status).toBe('ENDED');
      dead.release();
      await expect(abandoned).rejects.toMatchObject({ code: 'SESSION_NOT_ACTIVE' });
      expect((await w.read(id)).status).toBe('ENDED');
      expect(await w.heldBy(ALICE)).toBe(0);
      expect((await w.a.start(LAB, ALICE)).session.status).toBe('ACTIVE');
      expect(await w.heldBy(ALICE)).toBe(1);
    });

    it('a stuck End keeps the slot until the reaper adopts it, then releases it exactly once', async () => {
      const w = await world({ maxActiveSessions: 5, maxActiveSessionsPerStudent: 1 });
      const { session } = await w.a.start(LAB, ALICE);
      const id = session.sessionId;

      const dead = w.provider.holdNextDestroy();
      const abandoned = w.a.end(id);
      await dead.entered;
      expect((await w.read(id)).status).toBe('ENDING');

      // Inside the grace period nothing is adopted, and the slot stays taken.
      w.clock.now += 2 * MINUTE;
      expect((await w.reaper.sweep()).removed).toEqual([]);
      await expect(w.b.start(LAB, ALICE)).rejects.toMatchObject({ code: 'STUDENT_SESSION_LIMIT_REACHED' });

      // Past it, the reaper finishes the End: the sandbox is gone, so the slot is free.
      w.clock.now += 4 * MINUTE;
      expect((await w.reaper.sweep()).removed).toEqual([session.sandboxRef]);
      expect((await w.read(id)).status).toBe('ENDED');
      expect(await w.heldBy(ALICE)).toBe(0);

      const next = await w.b.start(LAB, ALICE);
      expect(next.session.status).toBe('ACTIVE');

      // Repeated sweeps and the late original End change nothing about it.
      for (let pass = 0; pass < 2; pass += 1) {
        expect(await w.reaper.sweep()).toMatchObject({ removed: [], errors: [] });
      }
      dead.release();
      expect((await abandoned).session.status).toBe('ENDED');
      expect(await w.heldBy(ALICE)).toBe(1);
      expect((await w.read(next.session.sessionId)).status).toBe('ACTIVE');
    });

    // ------------------------------------ runtime ownership (BETA-P0-008)

    it('never destroys another runtime owner’s sandbox to free a slot: the End stays in flight and keeps it', async () => {
      const w = await world({ maxActiveSessions: 5, maxActiveSessionsPerStudent: 1 });
      const { session } = await w.a.start(LAB, ALICE);
      w.runtime.containers.get(session.sandboxRef)!.info.labels[RUNTIME_OWNER_LABEL] = FOREIGN_OWNER;

      const end = await w.a.end(session.sessionId);
      expect(end.destroy.ok).toBe(false);

      w.clock.now += 6 * MINUTE;
      for (let pass = 0; pass < 2; pass += 1) {
        const sweep = await w.reaper.sweep();
        expect(sweep.removed).toEqual([]);
        expect((await w.read(session.sessionId)).status).toBe('ENDING');
        expect(w.runtime.containers.get(session.sandboxRef)?.info.labels[RUNTIME_OWNER_LABEL]).toBe(FOREIGN_OWNER);
        // Not verifiably gone, so still counted: capacity is never freed by
        // pretending a teardown finished.
        expect(await w.heldBy(ALICE)).toBe(1);
        await expect(w.b.start(LAB, ALICE)).rejects.toMatchObject({ code: 'STUDENT_SESSION_LIMIT_REACHED' });
      }

      // Other students are unaffected.
      expect((await w.b.start(LAB, BOB)).session.status).toBe('ACTIVE');
    });
  });
}

const store = new InMemorySessionStore();
perStudentCapacity(
  'InMemorySessionStore',
  // One process: both "instances" share the one store, which is the only
  // honest model of two managers without a database.
  async () => {
    for (const session of await store.list()) await store.delete(session.sessionId);
    return { a: store, b: store };
  },
  ['student-alice', 'student-bob', 'student-carol', 'student-dave', 'student-erin'],
);
