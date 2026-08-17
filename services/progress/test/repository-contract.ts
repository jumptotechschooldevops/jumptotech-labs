/**
 * The persistence contract, run against every implementation.
 *
 * The in-memory store and PostgreSQL are held to the *same* suite. That matters
 * more than it might look: the whole point of the port is that the composition
 * root can choose a store, and a fallback that quietly behaves differently from
 * the real database would turn every test written against it into fiction.
 *
 * These tests own the story requirements that are really about storage —
 * attempts, repeated passes, reset counting, teardown, hint idempotence, and
 * per-student isolation. The service- and API-level suites build on them rather
 * than repeating them.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProgressRepository } from '../src/repository.js';
import { ProgressError } from '../src/types.js';

export interface RepositoryHarness {
  repository: ProgressRepository;
  /** Empty every table between tests. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** A fixed clock, so every assertion is about behaviour and never about timing. */
const T = (minute: number): string =>
  new Date(Date.UTC(2026, 7, 17, 10, minute, 0)).toISOString();

export function describeProgressRepository(
  name: string,
  create: () => Promise<RepositoryHarness>,
): void {
  describe(name, () => {
    let harness: RepositoryHarness;
    let repository: ProgressRepository;

    beforeAll(async () => {
      harness = await create();
      repository = harness.repository;
    });

    afterAll(async () => {
      await harness?.close();
    });

    beforeEach(async () => {
      await harness.reset();
      // Re-read: a harness may reset by replacing the instance (the in-memory
      // one does) or by truncating tables (PostgreSQL). Both are supported.
      repository = harness.repository;
    });

    /** Create a student + an attempt in one step. */
    async function startAttempt(options: {
      studentId?: string;
      labId?: string;
      track?: string;
      sessionId?: string | null;
      at?: string;
    } = {}) {
      const studentId = options.studentId ?? 'dev-student-001';
      const at = options.at ?? T(0);
      await repository.ensureStudent({ studentId, identitySource: 'development-default', at });
      const attempt = await repository.createAttempt({
        attemptId: randomUUID(),
        studentId,
        labId: options.labId ?? 'K8S-001',
        track: options.track ?? 'kubernetes',
        startedAt: at,
      });
      if (options.sessionId !== null) {
        return (await repository.bindSession(
          attempt.attemptId,
          options.sessionId ?? `sess-${attempt.attemptId.slice(0, 12)}`,
          at,
        ))!;
      }
      return attempt;
    }

    // --- students -----------------------------------------------------------

    it('creates a student on first sight and is idempotent afterwards', async () => {
      const first = await repository.ensureStudent({
        studentId: 'dev-student-001',
        identitySource: 'development-default',
        at: T(0),
      });
      const second = await repository.ensureStudent({
        studentId: 'dev-student-001',
        identitySource: 'development-default',
        at: T(5),
      });

      expect(first.createdAt).toBe(T(0));
      expect(second.createdAt).toBe(T(0));
      expect(second.lastSeenAt).toBe(T(5));
      // Recorded honestly: these rows were never authenticated.
      expect(second.identitySource).toBe('development-default');
    });

    // --- starting a lab creates an attempt (test requirement 2) -------------

    it('records an attempt when a lab is started', async () => {
      const attempt = await startAttempt({ labId: 'K8S-004', at: T(1) });

      expect(attempt.attemptId).toMatch(/^[0-9a-f-]{36}$/);
      expect(attempt.labId).toBe('K8S-004');
      expect(attempt.track).toBe('kubernetes');
      expect(attempt.status).toBe('IN_PROGRESS');
      expect(attempt.startedAt).toBe(T(1));
      expect(attempt.completedAt).toBeNull();
      expect(attempt.endedAt).toBeNull();
      expect(attempt.checkCount).toBe(0);
      expect(attempt.resetCount).toBe(0);

      // …and the lab shows as in progress straight away.
      const [progress] = await repository.listProgress('dev-student-001');
      expect(progress?.labId).toBe('K8S-004');
      expect(progress?.status).toBe('IN_PROGRESS');
      expect(progress?.attemptCount).toBe(1);
      expect(progress?.completionCount).toBe(0);
    });

    it('finds the attempt that owns a sandbox session', async () => {
      const attempt = await startAttempt({ sessionId: 'sess-abcdef012345' });
      const found = await repository.findAttemptBySession('sess-abcdef012345');
      expect(found?.attemptId).toBe(attempt.attemptId);
      expect(await repository.findAttemptBySession('sess-000000000000')).toBeNull();
    });

    // --- PASS persists completion (test requirement 3) ----------------------

    it('persists completion when a check passes', async () => {
      const attempt = await startAttempt({ at: T(0) });

      const failed = await repository.recordCheck({
        attemptId: attempt.attemptId,
        passed: false,
        at: T(3),
      });
      expect(failed.attempt.status).toBe('IN_PROGRESS');
      expect(failed.attempt.checkCount).toBe(1);
      expect(failed.newlyCompleted).toBe(false);
      expect(failed.progress.status).toBe('IN_PROGRESS');

      const passed = await repository.recordCheck({
        attemptId: attempt.attemptId,
        passed: true,
        at: T(7),
      });
      expect(passed.attempt.status).toBe('PASSED');
      expect(passed.attempt.completedAt).toBe(T(7));
      expect(passed.attempt.checkCount).toBe(2);
      expect(passed.newlyCompleted).toBe(true);
      expect(passed.progress.status).toBe('COMPLETED');
      expect(passed.progress.completionCount).toBe(1);
      expect(passed.progress.firstCompletedAt).toBe(T(7));
    });

    // --- repeated PASS does not duplicate (test requirement 4) --------------

    it('does not duplicate a completion when PASS is repeated', async () => {
      const attempt = await startAttempt();
      await repository.recordCheck({ attemptId: attempt.attemptId, passed: true, at: T(5) });
      const again = await repository.recordCheck({
        attemptId: attempt.attemptId,
        passed: true,
        at: T(9),
      });

      expect(again.newlyCompleted).toBe(false);
      // The check genuinely happened, so it is counted…
      expect(again.attempt.checkCount).toBe(2);
      // …but the completion is the same completion.
      expect(again.attempt.completedAt).toBe(T(5));
      expect(again.progress.completionCount).toBe(1);

      const progress = await repository.listProgress(attempt.studentId);
      expect(progress).toHaveLength(1);
      expect(progress[0]?.completionCount).toBe(1);
    });

    it('counts a genuinely separate attempt at the same lab as a second completion', async () => {
      const first = await startAttempt({ at: T(0), sessionId: 'sess-first0000000' });
      await repository.recordCheck({ attemptId: first.attemptId, passed: true, at: T(4) });

      const second = await startAttempt({ at: T(20), sessionId: 'sess-second000000' });
      const outcome = await repository.recordCheck({
        attemptId: second.attemptId,
        passed: true,
        at: T(25),
      });

      expect(outcome.newlyCompleted).toBe(true);
      expect(outcome.progress.completionCount).toBe(2);
      expect(outcome.progress.attemptCount).toBe(2);
      // The first completion timestamp is never rewritten.
      expect(outcome.progress.firstCompletedAt).toBe(T(4));
      expect(outcome.progress.lastCompletedAt).toBe(T(25));
    });

    // --- reset (test requirement 5) -----------------------------------------

    it('increments reset_count without erasing history', async () => {
      const attempt = await startAttempt();
      await repository.recordCheck({ attemptId: attempt.attemptId, passed: true, at: T(4) });

      const afterFirst = await repository.recordReset(attempt.attemptId, T(6));
      const afterSecond = await repository.recordReset(attempt.attemptId, T(8));

      expect(afterFirst?.resetCount).toBe(1);
      expect(afterSecond?.resetCount).toBe(2);
      // The reset wiped a namespace, not a record.
      expect(afterSecond?.status).toBe('PASSED');
      expect(afterSecond?.completedAt).toBe(T(4));
      expect(afterSecond?.checkCount).toBe(1);

      const progress = await repository.listProgress(attempt.studentId);
      expect(progress[0]?.status).toBe('COMPLETED');
    });

    // --- end / expiry preserve history (test requirements 6–7) --------------

    it('preserves attempt history when a lab is ended', async () => {
      const attempt = await startAttempt();
      const ended = await repository.finishAttempt({
        attemptId: attempt.attemptId,
        outcome: 'ENDED',
        reason: 'ended by student',
        at: T(30),
      });

      expect(ended?.status).toBe('ENDED');
      expect(ended?.endedAt).toBe(T(30));
      expect(ended?.completedAt).toBeNull();
      expect(ended?.statusReason).toBe('ended by student');

      // The row is still there, and still the student's history.
      const attempts = await repository.listAttempts(attempt.studentId, 10);
      expect(attempts.map((a) => a.attemptId)).toEqual([attempt.attemptId]);
    });

    it('preserves attempt history when a lab expires', async () => {
      const attempt = await startAttempt();
      const expired = await repository.finishAttempt({
        attemptId: attempt.attemptId,
        outcome: 'EXPIRED',
        reason: 'absolute session lifetime reached',
        at: T(60),
      });

      expect(expired?.status).toBe('EXPIRED');
      expect(expired?.endedAt).toBe(T(60));
      expect(await repository.listAttempts(attempt.studentId, 10)).toHaveLength(1);
      // The lab is still shown as attempted, just not completed.
      const progress = await repository.listProgress(attempt.studentId);
      expect(progress[0]?.status).toBe('IN_PROGRESS');
      expect(progress[0]?.attemptCount).toBe(1);
    });

    it('keeps a PASSED attempt passed when its sandbox is later torn down', async () => {
      const attempt = await startAttempt();
      await repository.recordCheck({ attemptId: attempt.attemptId, passed: true, at: T(10) });

      const expired = await repository.finishAttempt({
        attemptId: attempt.attemptId,
        outcome: 'EXPIRED',
        reason: 'idle',
        at: T(45),
      });

      // Two independent facts: when it was passed, and when the sandbox died.
      expect(expired?.status).toBe('PASSED');
      expect(expired?.completedAt).toBe(T(10));
      expect(expired?.endedAt).toBe(T(45));

      const progress = await repository.listProgress(attempt.studentId);
      expect(progress[0]?.status).toBe('COMPLETED');
      expect(progress[0]?.completionCount).toBe(1);
    });

    it('stamps ended_at once, however many teardown passes run', async () => {
      const attempt = await startAttempt();
      await repository.finishAttempt({ attemptId: attempt.attemptId, outcome: 'EXPIRED', at: T(30) });
      const second = await repository.finishAttempt({
        attemptId: attempt.attemptId,
        outcome: 'EXPIRED',
        at: T(31),
      });
      expect(second?.endedAt).toBe(T(30));
    });

    it('closes attempts whose sandbox cannot exist any more', async () => {
      // Two students, three attempts: one old and open, one old and already
      // passed, one recent. Only the first is abandoned.
      const stale = await startAttempt({ at: T(0), sessionId: 'sess-stale0000000' });
      const passed = await startAttempt({
        at: T(1),
        labId: 'K8S-002',
        sessionId: 'sess-passed000000',
      });
      await repository.recordCheck({ attemptId: passed.attemptId, passed: true, at: T(2) });
      const recent = await startAttempt({
        at: T(50),
        labId: 'K8S-003',
        sessionId: 'sess-recent000000',
      });

      const closed = await repository.expireStaleAttempts({
        startedBefore: T(30),
        reason: 'the lab environment is no longer running',
        at: T(60),
      });

      expect(closed).toBe(1);
      const after = await repository.findAttempt(stale.attemptId);
      expect(after?.status).toBe('EXPIRED');
      expect(after?.endedAt).toBe(T(60));
      expect(after?.statusReason).toBe('the lab environment is no longer running');

      // A passed attempt is not touched, and neither is a live one.
      expect((await repository.findAttempt(passed.attemptId))?.status).toBe('PASSED');
      expect((await repository.findAttempt(recent.attemptId))?.status).toBe('IN_PROGRESS');

      // And running it again closes nothing further.
      expect(
        await repository.expireStaleAttempts({
          startedBefore: T(30),
          reason: 'the lab environment is no longer running',
          at: T(61),
        }),
      ).toBe(0);
    });

    it('records a FAILED attempt when the sandbox never came up', async () => {
      const attempt = await startAttempt({ sessionId: null });
      const failed = await repository.finishAttempt({
        attemptId: attempt.attemptId,
        outcome: 'FAILED',
        reason: 'PROVIDER_UNAVAILABLE',
        at: T(1),
      });

      expect(failed?.status).toBe('FAILED');
      expect(failed?.sessionId).toBeNull();
      expect(failed?.statusReason).toBe('PROVIDER_UNAVAILABLE');
    });

    // --- progress survives the sandbox (test requirement 1) -----------------

    it('keeps progress after every trace of the sandbox is gone', async () => {
      const attempt = await startAttempt({ sessionId: 'sess-doomed000000' });
      await repository.recordCheck({ attemptId: attempt.attemptId, passed: true, at: T(9) });
      await repository.finishAttempt({
        attemptId: attempt.attemptId,
        outcome: 'ENDED',
        reason: 'ended by student',
        at: T(10),
      });

      // Nothing here knows what a namespace is; the sandbox is simply gone and
      // the only trace left is a session id that no longer resolves anywhere.
      const progress = await repository.listProgress('dev-student-001');
      expect(progress[0]?.status).toBe('COMPLETED');
      const history = await repository.listAttempts('dev-student-001', 10);
      expect(history[0]?.sessionId).toBe('sess-doomed000000');
      expect(history[0]?.completedAt).toBe(T(9));
    });

    // --- hints (test requirements 8–9) --------------------------------------

    it('persists hint usage', async () => {
      const attempt = await startAttempt();
      const first = await repository.recordHint({
        hintUsageId: randomUUID(),
        attemptId: attempt.attemptId,
        hintIndex: 1,
        at: T(3),
      });
      const second = await repository.recordHint({
        hintUsageId: randomUUID(),
        attemptId: attempt.attemptId,
        hintIndex: 2,
        at: T(6),
      });

      expect(first.recorded).toBe(true);
      expect(first.usage.studentId).toBe('dev-student-001');
      expect(first.usage.labId).toBe('K8S-001');
      expect(first.usage.revealedAt).toBe(T(3));
      expect(second.revealedCount).toBe(2);

      const usage = await repository.listHintUsage(attempt.attemptId);
      expect(usage.map((u) => u.hintIndex)).toEqual([1, 2]);
    });

    it('ignores a replayed hint event', async () => {
      const attempt = await startAttempt();
      const first = await repository.recordHint({
        hintUsageId: randomUUID(),
        attemptId: attempt.attemptId,
        hintIndex: 1,
        at: T(3),
      });
      const replay = await repository.recordHint({
        hintUsageId: randomUUID(),
        attemptId: attempt.attemptId,
        hintIndex: 1,
        at: T(4),
      });

      expect(replay.recorded).toBe(false);
      // The original record wins: the second reveal never happened.
      expect(replay.usage.hintUsageId).toBe(first.usage.hintUsageId);
      expect(replay.usage.revealedAt).toBe(T(3));
      expect(replay.revealedCount).toBe(1);
      expect(await repository.listHintUsage(attempt.attemptId)).toHaveLength(1);
    });

    it('refuses to record a hint or a check for an unknown attempt', async () => {
      const missing = randomUUID();
      await expect(
        repository.recordHint({
          hintUsageId: randomUUID(),
          attemptId: missing,
          hintIndex: 1,
          at: T(1),
        }),
      ).rejects.toBeInstanceOf(ProgressError);
      await expect(
        repository.recordCheck({ attemptId: missing, passed: true, at: T(1) }),
      ).rejects.toBeInstanceOf(ProgressError);
    });

    // --- students are independent (test requirement 10) ---------------------

    it("keeps two students' progress completely separate", async () => {
      const alice = await startAttempt({
        studentId: 'dev-student-001',
        labId: 'K8S-001',
        sessionId: 'sess-alice0000000',
      });
      const bob = await startAttempt({
        studentId: 'dev-student-002',
        labId: 'K8S-001',
        sessionId: 'sess-bob000000000',
      });

      await repository.recordCheck({ attemptId: alice.attemptId, passed: true, at: T(5) });
      await repository.recordHint({
        hintUsageId: randomUUID(),
        attemptId: alice.attemptId,
        hintIndex: 1,
        at: T(4),
      });

      const aliceProgress = await repository.listProgress('dev-student-001');
      const bobProgress = await repository.listProgress('dev-student-002');
      expect(aliceProgress[0]?.status).toBe('COMPLETED');
      expect(bobProgress[0]?.status).toBe('IN_PROGRESS');

      expect(await repository.listAttempts('dev-student-002', 10)).toHaveLength(1);
      // And one student cannot read the other's attempt, even knowing its id.
      expect(await repository.getAttempt('dev-student-002', alice.attemptId)).toBeNull();
      expect(await repository.getAttempt('dev-student-001', alice.attemptId)).not.toBeNull();
      expect(await repository.getAttempt('dev-student-002', bob.attemptId)).not.toBeNull();
    });

    // --- every track (test requirements 11–13) -------------------------------

    it('records progress for Kubernetes, Linux and Terraform alike', async () => {
      const tracks: Array<[string, string]> = [
        ['K8S-002', 'kubernetes'],
        ['LINUX-001', 'linux'],
        ['TF-001', 'terraform'],
      ];

      for (const [labId, track] of tracks) {
        const attempt = await startAttempt({
          labId,
          track,
          sessionId: `sess-${labId.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
        });
        await repository.recordCheck({ attemptId: attempt.attemptId, passed: true, at: T(5) });
      }

      const progress = await repository.listProgress('dev-student-001');
      expect(progress.map((row) => [row.labId, row.track, row.status])).toEqual([
        ['K8S-002', 'kubernetes', 'COMPLETED'],
        ['LINUX-001', 'linux', 'COMPLETED'],
        ['TF-001', 'terraform', 'COMPLETED'],
      ]);
    });

    // --- listing ------------------------------------------------------------

    it('lists attempts newest first and honours the limit', async () => {
      for (const [index, labId] of ['K8S-001', 'K8S-002', 'LINUX-001'].entries()) {
        await startAttempt({ labId, at: T(index), sessionId: `sess-list${index}00000000` });
      }

      const all = await repository.listAttempts('dev-student-001', 10);
      expect(all.map((a) => a.labId)).toEqual(['LINUX-001', 'K8S-002', 'K8S-001']);

      const limited = await repository.listAttempts('dev-student-001', 2);
      expect(limited.map((a) => a.labId)).toEqual(['LINUX-001', 'K8S-002']);
    });

    it('reports its own health', async () => {
      const health = await repository.health();
      expect(health.ok).toBe(true);
      expect(health.store).toMatch(/^(memory|postgres)$/);
    });
  });
}
